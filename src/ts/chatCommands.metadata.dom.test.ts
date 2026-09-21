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
  writerAccessMocks,
} from './chatCommands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { type ChatFolderSnapshot, type ChatSnapshot } from './server/commands'
import { selectedCharID } from './stores.svelte'
import {
  applyCharacterResource,
  applyChatMetadataOwnerPatch,
  applyChatFolderMetadataOwnerPatch,
  applyCharactersResource,
  replaceResourceDatabase as setDatabaseLite,
} from './server/resourceState.svelte'
// Import the heavy database module AFTER stores.svelte: importing it first
// triggers a circular-import TDZ when the reactive moduleUpdate $effect runs
// mid-init.
import { setCurrentChat, type Chat } from './storage/database.svelte'
import {
  changedChatMetadata,
  captureChatMetadataPatch,
  captureChatFolderMetadataPatch,
  dispatchChatMetadataPatchWithOutcome,
  dispatchChatFolderMetadataPatchWithOutcome,
  CHAT_PATCH_ALLOWED_KEYS,
  currentChatScopedSnapshot,
  currentChatStateSnapshot,
  dispatchUpdateChat,
  dispatchUpdateChatAsync,
  dispatchUpdateChatFolder,
  dispatchUpdateChatFolderWithOutcome,
  dispatchUpdateChatFolderRow,
  dispatchUpdateChatRow,
  dispatchUpdateChatScoped,
  dispatchUpdateChatScopedWithOutcome,
  restoreChatFolderRowMetadata,
  restoreChatRowMetadata,
  sanitizeChatPatch,
  setCurrentChatPinnedWithOutcome,
  setCurrentChatGreetingIndex,
  setCurrentChatSelectedDraftHookId,
  setCurrentChatTranslationSettingWithOutcome,
} from './chatCommands'
import { assertRollbackRestoresOnly, seedCloneCostDb, withCloneInstrumentation } from './__tests__/cloneCostHarness'
import { listPendingMutations, stagePendingMutation } from './server/pendingMutationOutbox'
import { replayPendingMutations } from './server/pendingMutationReplay'
import { dispatchDurableMutation } from './server/durableMutationDispatch'
import { language } from '../lang'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

setupChatCommandTests()

function chatMetadataFixture(values: Record<string, unknown>): Chat {
  return {
    id: 'chat-m9',
    message: [{ role: 'user', data: 'ignored transcript', chatId: 'msg-m9' }],
    localLore: [{ id: 'ignored-lore', key: 'x', content: 'ignored' }],
    hypaV3Data: { ignored: true },
    ...values,
  } as unknown as Chat
}

describe('chat command projection helpers', () => {
  it('rolls back and fails loudly when a latched translation setting write is attempted', async () => {
    writerAccessMocks.lost = true

    const persistence = setCurrentChatTranslationSettingWithOutcome('autoTranslate', true)

    await expect(persistence).resolves.toEqual({
      status: 'failed',
      result: { status: 'error', error: language.writerAccessLostMutation },
    })
    expect(getDatabase().characters[0].chats[0].autoTranslate).toBeUndefined()
    expect(writerAccessMocks.report).toHaveBeenCalledOnce()
  })

  it('patches the selected draft hook through the chat-scoped command path', async () => {
    const calls = stubCommandFetch()
    expect(setCurrentChatSelectedDraftHookId('draft-hook-a')).toBe(true)
    expect(getDatabase().characters[0].chats[0].selectedDraftHookId).toBe('draft-hook-a')

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: { selectedDraftHookId: 'draft-hook-a' },
        select: false,
      },
    })
  })

  it('keeps an unrelated sibling chat byte-identical across greeting rollback', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
    })
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].fmIndex = 4
      getDatabase().characters[0].chats[1] = {
        id: 'chat-b',
        name: 'Sibling with legacy metadata',
        folderId: 'folder-a',
        opaqueField: { keep: 'exactly-as-written' },
        generationSettings: { legacyShape: ['preserve', 7] },
        message: [],
      } as any
    })
    const sibling = getDatabase().characters[0].chats[1]
    const siblingBytes = JSON.stringify(sibling)

    expect(setCurrentChatGreetingIndex(7)).toBe(true)
    expect(getDatabase().characters[0].chats[0].fmIndex).toBe(7)
    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].fmIndex).toBe(4)
    })

    expect(getDatabase().characters[0].chats[1]).toBe(sibling)
    expect(JSON.stringify(getDatabase().characters[0].chats[1])).toBe(siblingBytes)
  })

  it('fails closed when a folder owner is not unique in the captured character rows', () => {
    const calls = stubCommandFetch()
    const previous = currentChatStateSnapshot()
    previous.characters[0].chatFolders.push({ id: 'folder-a', name: 'Duplicate folder', folded: false } as any)

    expect(dispatchUpdateChatFolderWithOutcome('folder-a', { name: 'Should not dispatch' }, previous)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('clears the selected draft hook with a nullable chat patch', async () => {
    setCurrentChatSelectedDraftHookId('draft-hook-a', { dispatch: false })
    const calls = stubCommandFetch()
    expect(setCurrentChatSelectedDraftHookId(null)).toBe(true)
    expect(getDatabase().characters[0].chats[0]).not.toHaveProperty('selectedDraftHookId')

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: { selectedDraftHookId: null },
        select: false,
      },
    })
  })

  it('patches sparse per-chat translation settings through the guarded chat-scoped path', async () => {
    const calls = stubCommandFetch()
    const persistence = setCurrentChatTranslationSettingWithOutcome('autoTranslate', true)
    expect(getDatabase().characters[0].chats[0].autoTranslate).toBe(true)
    await expect(persistence).resolves.toMatchObject({ status: 'accepted' })

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: { autoTranslate: true },
        select: false,
      },
    })
    expect(
      sanitizeChatPatch({
        translatorPresetId: 'translator-preset-a',
        autoTranslate: false,
        autoTranslateBotOnly: true,
        bilingualDisplay: true,
        bilingualEmphasis: 'translation',
      }),
    ).toEqual({
      translatorPresetId: 'translator-preset-a',
      autoTranslate: false,
      autoTranslateBotOnly: true,
      bilingualDisplay: true,
      bilingualEmphasis: 'translation',
    })
  })

  it('sets and clears a stable chat translator preset binding', async () => {
    const calls = stubCommandFetch()
    const selected = setCurrentChatTranslationSettingWithOutcome('translatorPresetId', 'translator-preset-a')
    expect(getDatabase().characters[0].chats[0].translatorPresetId).toBe('translator-preset-a')
    await expect(selected).resolves.toMatchObject({ status: 'accepted' })
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: { translatorPresetId: 'translator-preset-a' },
        select: false,
      },
    })

    const cleared = setCurrentChatTranslationSettingWithOutcome('translatorPresetId', null)
    expect(getDatabase().characters[0].chats[0]).not.toHaveProperty('translatorPresetId')
    await expect(cleared).resolves.toMatchObject({ status: 'accepted' })
    await waitForCallCount(calls, 3)
    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        baseRevision: expect.any(Number),
        patch: { translatorPresetId: null },
        select: false,
      },
    })
  })

  it('persists the selected chat pin through the guarded chat-scoped path', async () => {
    const calls = stubCommandFetch()
    const persistence = setCurrentChatPinnedWithOutcome(true)
    expect(getDatabase().characters[0].chats[0].pinned).toBe(true)
    await expect(persistence).resolves.toMatchObject({ status: 'accepted' })

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: { pinned: true },
        select: false,
      },
    })
  })

  it('patches the string-valued bilingual emphasis through the guarded chat-scoped path', async () => {
    const calls = stubCommandFetch()
    const persistence = setCurrentChatTranslationSettingWithOutcome('bilingualEmphasis', 'translation')
    expect(getDatabase().characters[0].chats[0].bilingualEmphasis).toBe('translation')
    await expect(persistence).resolves.toMatchObject({ status: 'accepted' })

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: { bilingualEmphasis: 'translation' },
        select: false,
      },
    })
  })
})

describe('chat-selection snapshot', () => {
  it('dispatchUpdateChat sends chat rename patches through the chat update command', async () => {
    const calls = stubCommandFetch()
    const previous = currentChatStateSnapshot()

    dispatchUpdateChat('chat-a', { name: 'Renamed Chat A' }, previous)
    await waitForCallCount(calls, 2)

    expect(calls[1]).toEqual({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      authHeader: 'chat-command-token',
      body: {
        baseRevision: 10,
        patch: { name: 'Renamed Chat A' },
        select: false,
      },
    })
  })

  it('dispatchUpdateChatAsync resolves a failure only after metadata rollback', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
    })
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].bindedPersona = 'persona-old'
    })

    const previous = currentChatStateSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].bindedPersona = ''
    })

    const resultPromise = dispatchUpdateChatAsync('chat-a', { bindedPersona: '' }, previous)
    expect(resultPromise).toBeTruthy()
    expect(getDatabase().characters[0].chats[0].bindedPersona).toBe('')

    const result = await resultPromise

    expect(calls).toHaveLength(2)
    expect(result?.status).toBe('error')
    expect(getDatabase().characters[0].chats[0].bindedPersona).toBe('persona-old')
  })
})

describe('chat metadata dispatch rollback', () => {
  it.each(['chat', 'folder'] as const)(
    'rebases overlapping narrow %s failures without losing newer names or background message identities',
    async (kind) => {
      const firstRequest = createDeferred<Response>()
      const secondRequest = createDeferred<Response>()
      const requests: Record<string, unknown>[] = []
      const path = kind === 'chat' ? '/api/v1/commands/chats/chat-a' : '/api/v1/commands/chat-folders/folder-a'
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          if (String(input) === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
          if (String(input) === path) {
            requests.push(JSON.parse(init.body as string))
            return requests.length === 1 ? firstRequest.promise : secondRequest.promise
          }
          return jsonResponse({ error: `unexpected ${String(input)}` }, 404)
        }),
      )
      const owner = getDatabase().characters[0]
      const sibling = owner.chats[1]
      sibling.message.push({ role: 'char', data: 'generating', chatId: 'background-message' })
      const messages = sibling.message
      const message = messages[0]
      const row = kind === 'chat' ? owner.chats[0] : owner.chatFolders[0]
      const originalName = row.name
      const rename = (name: string) => {
        if (kind === 'chat') {
          const snapshot = captureChatMetadataPatch('chat-a', { name }, 'char-a')!
          expect(applyChatMetadataOwnerPatch('char-a', 'chat-a', { name })).toBe(true)
          return dispatchChatMetadataPatchWithOutcome(snapshot)
        }
        const snapshot = captureChatFolderMetadataPatch('folder-a', { name }, 'char-a')!
        expect(applyChatFolderMetadataOwnerPatch('char-a', 'folder-a', { name })).toBe(true)
        return dispatchChatFolderMetadataPatchWithOutcome(snapshot)
      }
      const first = rename('Older optimistic name')
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      const second = rename('Newer optimistic name')
      message.data = 'background generation continued'
      firstRequest.resolve(jsonResponse({ error: 'older rename rejected' }, 400))
      // Command promises wait for the shared reconciliation batch, so observe
      // the second request to know the older command already rolled back.
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      expect(row.name).toBe('Newer optimistic name')
      expect(requests.map((request) => request.patch)).toEqual([
        { name: 'Older optimistic name' },
        { name: 'Newer optimistic name' },
      ])
      secondRequest.resolve(jsonResponse({ error: 'newer rename rejected' }, 400))
      await expect(first).resolves.toMatchObject({ status: 'failed' })
      await expect(second).resolves.toMatchObject({ status: 'failed' })
      expect(row.name).toBe(originalName)
      expect(getDatabase().characters[0]).toBe(owner)
      expect(owner.chats[1]).toBe(sibling)
      expect(sibling.message).toBe(messages)
      expect(messages[0]).toBe(message)
      expect(message.data).toBe('background generation continued')
    },
  )

  it.each(['chat', 'folder'] as const)(
    'rolls back a narrow %s patch if writer access is lost after capture',
    async (kind) => {
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      const owner = getDatabase().characters[0]
      const row = kind === 'chat' ? owner.chats[0] : owner.chatFolders[0]
      const originalName = row.name
      let mutation: ReturnType<typeof dispatchChatMetadataPatchWithOutcome>
      if (kind === 'chat') {
        const snapshot = captureChatMetadataPatch('chat-a', { name: 'Attempted name' }, 'char-a')!
        applyChatMetadataOwnerPatch('char-a', 'chat-a', snapshot.attempted)
        writerAccessMocks.lost = true
        mutation = dispatchChatMetadataPatchWithOutcome(snapshot)
      } else {
        const snapshot = captureChatFolderMetadataPatch('folder-a', { name: 'Attempted name' }, 'char-a')!
        applyChatFolderMetadataOwnerPatch('char-a', 'folder-a', snapshot.attempted)
        writerAccessMocks.lost = true
        mutation = dispatchChatFolderMetadataPatchWithOutcome(snapshot)
      }
      await expect(mutation).resolves.toMatchObject({ status: 'failed' })
      expect(row.name).toBe(originalName)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('captures only requested allowed fields and refuses missing, ambiguous, or mismatched metadata owners', () => {
    const patch = { name: 'Captured name', message: [{ data: 'must not be captured' }] }
    const snapshot = captureChatMetadataPatch('chat-a', patch, 'char-a')!
    patch.name = 'Caller edited the patch'
    expect(snapshot).toEqual({
      selectedCharID: 0,
      characterId: 'char-a',
      chatId: 'chat-a',
      metadata: { name: 'Chat A' },
      attempted: { name: 'Captured name' },
    })
    expect(captureChatMetadataPatch('chat-a', { name: 'name' }, 'other-owner')).toBeNull()
    expect(captureChatFolderMetadataPatch('folder-a', { name: 'name' }, 'other-owner')).toBeNull()
    expect(captureChatMetadataPatch('missing', { name: 'name' })).toBeNull()
    expect(captureChatFolderMetadataPatch('missing', { name: 'name' })).toBeNull()
    getDatabase().characters[0].chats.push({ id: 'chat-a', name: 'Duplicate', message: [] } as Chat)
    getDatabase().characters[0].chatFolders.push({ id: 'folder-a', name: 'Duplicate', folded: false })
    expect(captureChatMetadataPatch('chat-a', { name: 'name' })).toBeNull()
    expect(captureChatFolderMetadataPatch('folder-a', { name: 'name' })).toBeNull()
  })

  it('restores the original folder name when overlapping broad folder updates both fail', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chat-folders/folder-a' && init.method === 'PATCH',
    })
    const firstPrevious = currentChatStateSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatFolders[0].name = 'First folder rename'
    })
    dispatchUpdateChatFolder('folder-a', { name: 'First folder rename' }, firstPrevious)

    const secondPrevious = currentChatStateSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatFolders[0].name = 'Second folder rename'
    })
    dispatchUpdateChatFolder('folder-a', { name: 'Second folder rename' }, secondPrevious)

    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chatFolders[0].name).toBe('Folder')
    })
  })

  it('restores the original folder color when overlapping row folder updates both fail', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chat-folders/folder-a' && init.method === 'PATCH',
    })
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatFolders[0].color = 'blue'
    })
    dispatchUpdateChatFolderRow(
      'folder-a',
      { color: 'blue' },
      {
        selectedCharID: 0,
        characterId: 'char-a',
        folderId: 'folder-a',
        metadata: {},
      },
    )

    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatFolders[0].color = 'red'
    })
    dispatchUpdateChatFolderRow(
      'folder-a',
      { color: 'red' },
      {
        selectedCharID: 0,
        characterId: 'char-a',
        folderId: 'folder-a',
        metadata: { color: 'blue' },
      },
    )

    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chatFolders[0].color).toBeUndefined()
    })
  })

  it('restores the original chat name when overlapping broad updates both fail', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
    })
    const firstPrevious = currentChatStateSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].name = 'First rename'
    })
    dispatchUpdateChat('chat-a', { name: 'First rename' }, firstPrevious)

    const secondPrevious = currentChatStateSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].name = 'Second rename'
    })
    dispatchUpdateChat('chat-a', { name: 'Second rename' }, secondPrevious)

    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].name).toBe('Chat A')
    })
  })

  it('restores the original suggestions when overlapping row updates both fail', async () => {
    getDatabase().characters[0].chats[0].suggestMessages = ['Old suggestion']
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
    })
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].suggestMessages = []
    })
    dispatchUpdateChatRow(
      'chat-a',
      { suggestMessages: [] },
      {
        selectedCharID: 0,
        characterId: 'char-a',
        chatId: 'chat-a',
        metadata: { suggestMessages: ['Old suggestion'] },
      },
    )

    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].suggestMessages = ['New suggestion']
    })
    dispatchUpdateChatRow(
      'chat-a',
      { suggestMessages: ['New suggestion'] },
      {
        selectedCharID: 0,
        characterId: 'char-a',
        chatId: 'chat-a',
        metadata: { suggestMessages: [] },
      },
    )

    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].suggestMessages).toEqual(['Old suggestion'])
    })
  })

  it('restores the original bookmark state when overlapping scoped updates both fail', async () => {
    getDatabase().characters[0].chats[0].bookmarks = []
    getDatabase().characters[0].chats[0].bookmarkNames = {}
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
    })
    const firstPrevious = currentChatScopedSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].bookmarks = ['msg-one']
      getDatabase().characters[0].chats[0].bookmarkNames = { 'msg-one': 'One' }
    })
    dispatchUpdateChatScoped('chat-a', { bookmarks: ['msg-one'], bookmarkNames: { 'msg-one': 'One' } }, firstPrevious)

    const secondPrevious = currentChatScopedSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].bookmarks = ['msg-one', 'msg-two']
      getDatabase().characters[0].chats[0].bookmarkNames = { 'msg-one': 'One', 'msg-two': 'Two' }
    })
    dispatchUpdateChatScoped(
      'chat-a',
      {
        bookmarks: ['msg-one', 'msg-two'],
        bookmarkNames: { 'msg-one': 'One', 'msg-two': 'Two' },
      },
      secondPrevious,
    )

    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].bookmarks).toEqual([])
      expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({})
    })
  })

  it('failed scoped metadata updates roll back only attempted fields that have not changed again', async () => {
    getDatabase().characters[0].chats[0].bookmarks = ['msg-old']
    getDatabase().characters[0].chats[0].bookmarkNames = { 'msg-old': 'Old bookmark' }
    getDatabase().characters[0].chats[0].note = 'old note'
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
      onCommand: () => {
        withTestDatabaseWrite(() => {
          const chat = getDatabase().characters[0].chats[0]
          chat.bookmarkNames = { 'msg-newer': 'Newer bookmark' }
          chat.note = 'newer note'
          chat.message.push({ role: 'user', data: 'newer message', chatId: 'msg-newer' })
          getDatabase().characters[0].chats[1].name = 'newer sibling name'
        })
      },
    })
    const previous = currentChatScopedSnapshot()
    const attemptedBookmarks = ['msg-attempted']
    const attemptedBookmarkNames = { 'msg-attempted': 'Attempted bookmark' }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].bookmarks = jsonClone(attemptedBookmarks)
      getDatabase().characters[0].chats[0].bookmarkNames = jsonClone(attemptedBookmarkNames)
    })

    const mutation = dispatchUpdateChatScopedWithOutcome(
      'chat-a',
      { bookmarks: attemptedBookmarks, bookmarkNames: attemptedBookmarkNames },
      previous,
    )

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['msg-old'])
    })
    await expect(mutation).resolves.toMatchObject({ status: 'failed' })
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'msg-newer': 'Newer bookmark' })
    expect(getDatabase().characters[0].chats[0].note).toBe('newer note')
    expect(getDatabase().characters[0].chats[0].message).toEqual([
      { role: 'user', data: 'newer message', chatId: 'msg-newer' },
    ])
    expect(getDatabase().characters[0].chats[1].name).toBe('newer sibling name')
  })

  it('failed chat rename restores only attempted name and preserves sibling edits, folders, and selection', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
      onCommand: () => {
        withTestDatabaseWrite(() => {
          getDatabase().characters[0].chats[1].name = 'Newer sibling name'
          getDatabase().characters[0].chatFolders[0].name = 'Newer folder name'
          getDatabase().characters[0].chatPage = 1
        })
      },
    })
    const previous = currentChatStateSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].name = 'Attempted rename'
    })

    dispatchUpdateChat('chat-a', { name: 'Attempted rename' }, previous)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].name).toBe('Chat A')
    })
    expect(getDatabase().characters[0].chats[1].name).toBe('Newer sibling name')
    expect(getDatabase().characters[0].chatFolders[0].name).toBe('Newer folder name')
    expect(getDatabase().characters[0].chatPage).toBe(1)
  })

  it('failed chat rename skips rollback when the live name changed after dispatch', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
      onCommand: () => {
        withTestDatabaseWrite(() => {
          getDatabase().characters[0].chats[0].name = 'Newer live rename'
        })
      },
    })
    const previous = currentChatStateSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].name = 'Attempted rename'
    })

    dispatchUpdateChat('chat-a', { name: 'Attempted rename' }, previous)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].name).toBe('Newer live rename')
    })
  })

  it('failed multi-key metadata patch rolls back only keys still matching the attempted values', async () => {
    getDatabase().characters[0].chats[0].bookmarks = ['msg-old']
    getDatabase().characters[0].chats[0].bookmarkNames = { 'msg-old': 'Old bookmark' }

    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
      onCommand: () => {
        withTestDatabaseWrite(() => {
          getDatabase().characters[0].chats[0].bookmarkNames = { 'msg-newer': 'Newer bookmark' }
        })
      },
    })
    const previous = currentChatStateSnapshot()
    const attemptedBookmarks = ['msg-new']
    const attemptedBookmarkNames: Record<string, string> = { 'msg-new': 'New bookmark' }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].bookmarks = jsonClone(attemptedBookmarks)
      getDatabase().characters[0].chats[0].bookmarkNames = jsonClone(attemptedBookmarkNames)
    })

    dispatchUpdateChat(
      'chat-a',
      {
        bookmarks: attemptedBookmarks,
        bookmarkNames: attemptedBookmarkNames,
      },
      previous,
    )
    attemptedBookmarks.push('msg-mutated')
    attemptedBookmarkNames['msg-new'] = 'Mutated later'

    await waitForCallCount(calls, 2)
    expect(calls[1].body).toMatchObject({
      patch: {
        bookmarks: ['msg-new'],
        bookmarkNames: { 'msg-new': 'New bookmark' },
      },
    })
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['msg-old'])
    })
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'msg-newer': 'Newer bookmark' })
  })

  it('failed empty-patch select dispatch does not restore chat metadata or selection', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
      onCommand: () => {
        withTestDatabaseWrite(() => {
          getDatabase().characters[0].chats[1].name = 'Newer sibling name'
          getDatabase().characters[0].chatPage = 1
        })
      },
    })
    const previous = currentChatStateSnapshot()
    dispatchUpdateChat('chat-a', {}, previous, true)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chatPage).toBe(1)
    })
    expect(getDatabase().characters[0].chats[1].name).toBe('Newer sibling name')
  })
})

describe('chat-metadata-row rollback', () => {
  function scalarMetadata(chatIndex: number): ChatSnapshot {
    const chat = getDatabase().characters[0].chats[chatIndex] as unknown as Record<string, unknown>
    const metadata: Record<string, unknown> = {}
    // mirror the watcher's allowed scalar metadata keys for the seeded fields
    for (const key of ['name', 'note', 'folderId', 'bindedPersona'] as const) {
      if (chat[key] !== undefined) metadata[key] = chat[key]
    }
    return metadata as ChatSnapshot
  }

  it('restores only the one chat row, preserving message history and unrelated chats', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)

    assertRollbackRestoresOnly({
      capture: () => ({
        selectedCharID: 0,
        characterId: 'char-0',
        chatId: 'chat-0',
        metadata: scalarMetadata(0),
      }),
      mutate: () => {
        // optimistic metadata change the failing command must undo
        getDatabase().characters[0].chats[0].name = 'Optimistic Name'
        // unrelated concurrent edits a whole-array restore would have clobbered
        getDatabase().characters[0].chats[0].message.push({
          role: 'char',
          data: 'concurrent',
          chatId: 'msg-concurrent',
        })
        getDatabase().characters[1].chats[0].note = 'sibling concurrent note'
      },
      expectMutated: () => {
        expect(getDatabase().characters[0].chats[0].name).toBe('Optimistic Name')
      },
      restore: (snapshot) => restoreChatRowMetadata(snapshot),
      expectRestored: () => {
        expect(getDatabase().characters[0].chats[0].name).toBe('Chat 0')
      },
      expectUntouched: () => {
        expect(getDatabase().characters[0].chats[0].message).toHaveLength(41)
        expect(getDatabase().characters[1].chats[0].note).toBe('sibling concurrent note')
      },
    })
  })

  it('drops an allowed key the optimistic change added but the baseline lacked', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)
    // baseline has no bindedPersona
    const snapshot = {
      selectedCharID: 0,
      characterId: 'char-0',
      chatId: 'chat-0',
      metadata: scalarMetadata(0),
    }
    expect(snapshot.metadata).not.toHaveProperty('bindedPersona')

    getDatabase().characters[0].chats[0].bindedPersona = 'persona-x'
    restoreChatRowMetadata(snapshot)

    expect(getDatabase().characters[0].chats[0].bindedPersona).toBeUndefined()
  })

  it('does not restore attempted chat metadata after a newer same-row edit', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)
    const snapshot = {
      selectedCharID: 0,
      characterId: 'char-0',
      chatId: 'chat-0',
      metadata: scalarMetadata(0),
      attempted: { name: 'Optimistic Name' },
    }

    getDatabase().characters[0].chats[0].name = 'Newer local name'
    restoreChatRowMetadata(snapshot)

    expect(getDatabase().characters[0].chats[0].name).toBe('Newer local name')
  })

  it('drops attempted metadata missing from the baseline without clobbering newer fields', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)
    const snapshot = {
      selectedCharID: 0,
      characterId: 'char-0',
      chatId: 'chat-0',
      metadata: scalarMetadata(0),
      attempted: { name: 'Optimistic Name', bindedPersona: 'persona-x' },
    }
    expect(snapshot.metadata).not.toHaveProperty('bindedPersona')

    getDatabase().characters[0].chats[0].name = 'Newer local name'
    getDatabase().characters[0].chats[0].bindedPersona = 'persona-x'
    restoreChatRowMetadata(snapshot)

    expect(getDatabase().characters[0].chats[0].name).toBe('Newer local name')
    expect(getDatabase().characters[0].chats[0].bindedPersona).toBeUndefined()
  })

  it('restores only the one folder row by stable id', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    getDatabase().characters[0].chatFolders = [{ id: 'folder-0', name: 'Folder Zero', color: '#111', folded: false }]
    getDatabase().characters[1].chatFolders = [{ id: 'folder-1', name: 'Folder One', color: '#222', folded: false }]
    selectedCharID.set(0)

    assertRollbackRestoresOnly({
      capture: () => ({
        selectedCharID: 0,
        characterId: 'char-0',
        folderId: 'folder-0',
        metadata: { name: 'Folder Zero', color: '#111', folded: false } as ChatFolderSnapshot,
      }),
      mutate: () => {
        getDatabase().characters[0].chatFolders[0].folded = true
        getDatabase().characters[0].chatFolders[0].name = 'Optimistic Folder'
        getDatabase().characters[1].chatFolders[0].name = 'Sibling Folder Edit'
      },
      expectMutated: () => {
        expect(getDatabase().characters[0].chatFolders[0].folded).toBe(true)
      },
      restore: (snapshot) => restoreChatFolderRowMetadata(snapshot),
      expectRestored: () => {
        expect(getDatabase().characters[0].chatFolders[0]).toMatchObject({
          name: 'Folder Zero',
          color: '#111',
          folded: false,
        })
      },
      expectUntouched: () => {
        expect(getDatabase().characters[1].chatFolders[0].name).toBe('Sibling Folder Edit')
      },
    })
  })
})

describe('chat metadata allowed-key diff', () => {
  it('persists sdData metadata through the chat command without sending transcript fields', async () => {
    const calls = stubCommandFetch()
    const snapshot = captureChatMetadataPatch(
      'chat-a',
      { sdData: 'saved image data', message: [{ role: 'user', data: 'must stay local' }] },
      'char-a',
    )!

    expect(snapshot?.attempted).toEqual({ sdData: 'saved image data' })
    expect(applyChatMetadataOwnerPatch('char-a', 'chat-a', snapshot.attempted)).toBe(true)
    await expect(dispatchChatMetadataPatchWithOutcome(snapshot)).resolves.toMatchObject({ status: 'accepted' })

    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: { patch: { sdData: 'saved image data' }, select: false },
    })
    expect((calls[1].body as { patch: unknown }).patch).toEqual({ sdData: 'saved image data' })
    expect(getDatabase().characters[0].chats[0].sdData).toBe('saved image data')
  })

  it('keeps generationSettings out of generic chat metadata patching', () => {
    const previous = chatMetadataFixture({
      name: 'Same chat',
    })
    const current = chatMetadataFixture({
      name: 'Same chat',
    })
    previous.generationSettings = {
      configured: true,
      personaId: 'persona-old',
      modelPresetId: 'model-preset-old',
      promptPresetId: 'preset-old',
      jailbreakToggle: false,
    }
    current.generationSettings = {
      configured: true,
      personaId: 'persona-new',
      modelPresetId: 'model-preset-new',
      promptPresetId: 'preset-new',
      jailbreakToggle: true,
      sidebarToggles: { mode: '1' },
    }

    expect(CHAT_PATCH_ALLOWED_KEYS.has('generationSettings')).toBe(false)
    expect(sanitizeChatPatch(current as unknown as ChatSnapshot)).not.toHaveProperty('generationSettings')
    expect(changedChatMetadata(previous, current)).toEqual({})
  })

  it('emits the expected allowed metadata patch and preserves serialized key order', () => {
    const previous = chatMetadataFixture({
      name: 'Old chat',
      note: 'same note',
      lastMemory: 'same memory',
      suggestMessages: ['old suggestion'],
      bindedPersona: 'persona-old',
      fmIndex: 1,
      folderId: 'folder-old',
      bookmarks: ['msg-old'],
      bookmarkNames: { 'msg-old': 'Old bookmark' },
      modules: ['module-a'],
      pinned: false,
    })
    const current = chatMetadataFixture({
      name: 'New chat',
      note: 'same note',
      sdData: 'new sd payload',
      lastMemory: 'same memory',
      suggestMessages: ['new suggestion'],
      fmIndex: 2,
      folderId: null,
      bookmarks: ['msg-new'],
      bookmarkNames: { 'msg-new': 'New bookmark' },
      modules: ['module-a', 'module-b'],
      pinned: true,
    })
    current.message = [{ role: 'char', data: 'ignored transcript change', chatId: 'msg-new' }]
    current.localLore = [{ id: 'ignored-lore-new', key: 'y', content: 'ignored changed lore' }] as any
    ;(current as any).hypaV3Data = { ignored: 'changed memory payload' }

    const patch = changedChatMetadata(previous, current)
    const expectedPatch = {
      name: 'New chat',
      suggestMessages: ['new suggestion'],
      bindedPersona: undefined,
      fmIndex: 2,
      folderId: null,
      bookmarks: ['msg-new'],
      bookmarkNames: { 'msg-new': 'New bookmark' },
      modules: ['module-a', 'module-b'],
      pinned: true,
      sdData: 'new sd payload',
    }

    expect(patch).toStrictEqual(expectedPatch)
    expect(Object.keys(patch)).toEqual(Object.keys(expectedPatch))
    expect(JSON.stringify(patch)).toBe(JSON.stringify(expectedPatch))
    const { bindedPersona: _deletedPersona, ...expectedWirePatch } = expectedPatch
    expect(sanitizeChatPatch(patch)).toEqual(expectedWirePatch)
    expect(patch).toHaveProperty('bindedPersona', undefined)
    expect(sanitizeChatPatch(patch)).not.toHaveProperty('bindedPersona')
    expect(patch).not.toHaveProperty('message')
    expect(patch).not.toHaveProperty('localLore')
    expect(patch).not.toHaveProperty('hypaV3Data')
  })

  it('message-only changes produce an empty patch without serializing message arrays', () => {
    const body = 'x'.repeat(1200)
    const previous = chatMetadataFixture({ name: 'Same chat', note: 'same note' })
    previous.message = Array.from({ length: 120 }, (_unused, index) => ({
      role: index % 2 === 0 ? 'user' : 'char',
      data: `${body}-${index}`,
      chatId: `msg-long-${index}`,
    }))
    previous.localLore = [{ id: 'lore-old', key: 'old', content: body.repeat(10) }] as any
    ;(previous as any).hypaV3Data = { ignored: body.repeat(10) }

    const current = {
      ...previous,
      message: previous.message.map((message, index) => ({
        ...message,
        data: `${message.data}-changed-${index}`,
      })),
      localLore: [{ id: 'lore-new', key: 'new', content: body.repeat(10) }],
      hypaV3Data: { ignored: `${body}-changed` },
    } as unknown as Chat
    const messageSize = JSON.stringify(current.message).length

    const instrumented = withCloneInstrumentation(() => changedChatMetadata(previous, current))

    expect(instrumented.result).toEqual({})
    expect(instrumented.maxClonedSize).toBeLessThan(messageSize)
  })

  it('changed object metadata is detached from the current chat record', () => {
    const previous = chatMetadataFixture({
      name: 'Same chat',
      bookmarks: ['msg-old'],
      bookmarkNames: { 'msg-old': 'Old bookmark' },
      modules: ['module-a'],
      suggestMessages: ['old suggestion'],
    })
    const bookmarks = ['msg-new']
    const bookmarkNames = { 'msg-new': 'New bookmark' }
    const modules = ['module-a', 'module-b']
    const suggestMessages = ['new suggestion']
    const current = chatMetadataFixture({
      name: 'Same chat',
      bookmarks,
      bookmarkNames,
      modules,
      suggestMessages,
    })

    const patch = changedChatMetadata(previous, current)

    expect(patch.bookmarks).toEqual(['msg-new'])
    expect(patch.bookmarkNames).toEqual({ 'msg-new': 'New bookmark' })
    expect(patch.modules).toEqual(['module-a', 'module-b'])
    expect(patch.suggestMessages).toEqual(['new suggestion'])
    expect(patch.bookmarks).not.toBe(bookmarks)
    expect(patch.bookmarkNames).not.toBe(bookmarkNames)
    expect(patch.modules).not.toBe(modules)
    expect(patch.suggestMessages).not.toBe(suggestMessages)

    bookmarks.push('msg-late')
    bookmarkNames['msg-new'] = 'Mutated later'
    modules.push('module-late')
    suggestMessages.push('late suggestion')

    expect(patch.bookmarks).toEqual(['msg-new'])
    expect(patch.bookmarkNames).toEqual({ 'msg-new': 'New bookmark' })
    expect(patch.modules).toEqual(['module-a', 'module-b'])
    expect(patch.suggestMessages).toEqual(['new suggestion'])
  })
})

describe('setCurrentChat scoped snapshot', () => {
  it('replacing the active chat captures a chat-scoped baseline, never the whole characters array', async () => {
    setDatabaseLite(seedCloneCostDb() as any) // char-0 large (40 messages), siblings small
    selectedCharID.set(1)
    const charactersSize = JSON.stringify(getDatabase().characters).length
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ revision: 10 })) as unknown as typeof fetch)

    const nextChat = JSON.parse(JSON.stringify(getDatabase().characters[1].chats[0]))
    nextChat.name = 'Renamed chat'

    // The scoped capture + the compatible-update diff stay bounded to the one
    // active chat; the large sibling (char-0) transcript is never serialized.
    const instrumented = withCloneInstrumentation(() => {
      setCurrentChat(nextChat as any)
    })
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)
    expect(getDatabase().characters[1].chats[0].name).toBe('Renamed chat')

    // drain the async dispatch so it does not leak into the next test
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('a failed update rolls back only the active chat row, preserving sibling edits', async () => {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        return jsonResponse({ error: 'nope' }, 500)
      }) as unknown as typeof fetch,
    )

    const nextChat = JSON.parse(JSON.stringify(getDatabase().characters[0].chats[0]))
    nextChat.name = 'Optimistic rename'

    setCurrentChat(nextChat as any)
    // a concurrent, unrelated edit to ANOTHER chat row a whole-array restore would wipe
    getDatabase().characters[0].chats[1].name = 'Concurrent sibling edit'

    await waitForCallCount(calls, 2)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getDatabase().characters[0].chats[0].name).toBe('Chat A')
    expect(getDatabase().characters[0].chats[1].name).toBe('Concurrent sibling edit')
  })
})

describe('durable chat and folder structure dispatch', () => {
  it('classifies a retained scoped bookmark update as queued while preserving its projection', async () => {
    await prepareDurableOutbox('bookmark-outcome')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH') {
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const previous = currentChatScopedSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].bookmarks = ['message-a']
        getDatabase().characters[0].chats[0].bookmarkNames = { 'message-a': 'Queued bookmark' }
      })
      const mutation = dispatchUpdateChatScopedWithOutcome(
        'chat-a',
        { bookmarks: ['message-a'], bookmarkNames: { 'message-a': 'Queued bookmark' } },
        previous,
      )

      await expect(mutation).resolves.toMatchObject({ status: 'queued' })
      expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['message-a'])
      expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'message-a': 'Queued bookmark' })
      expect(await listPendingMutations()).toHaveLength(1)
    } finally {
      await clearDurableOutbox()
    }
  })

  it('retains an optimistic chat patch with the exact frozen live body on the character owner', async () => {
    await prepareDurableOutbox('chat-patch')
    let liveBody: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH') {
          liveBody = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const previous = captureChatMetadataPatch('chat-a', { name: 'Durable rename' }, 'char-a')!
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].name = 'Durable rename'
      })
      const mutation = dispatchChatMetadataPatchWithOutcome(previous)

      await vi.waitFor(() => expect(liveBody).toBeDefined())
      await expect(mutation).resolves.toMatchObject({ status: 'queued' })
      expect(getDatabase().characters[0].chats[0].name).toBe('Durable rename')
      const pending = await listPendingMutations()
      expect(pending).toMatchObject([
        {
          handle: { key: 'character-owner:char-a' },
          intent: {
            version: 1,
            requests: [
              {
                method: 'PATCH',
                path: '/chats/chat-a',
                body: { patch: { name: 'Durable rename' }, select: false },
              },
            ],
          },
        },
      ])
      const { baseRevision: _baseRevision, ...sentBody } = liveBody ?? {}
      expect(sentBody).toEqual(pending[0].intent.requests[0].body)

      const authoritativeCharacter = jsonClone(getDatabase().characters[0])
      authoritativeCharacter.chats[0].name = 'Chat A'
      expect(applyCharacterResource({ revision: 11, character: authoritativeCharacter })).toBe(true)
      expect(getDatabase().characters[0].chats[0].name).toBe('Durable rename')

      expect(
        applyCharactersResource({
          version: 1,
          revision: 12,
          characters: [authoritativeCharacter],
          characterOrder: ['char-a'],
          currentChar: 0,
        }),
      ).toBe(true)
      expect(getDatabase().characters[0].chats[0].name).toBe('Durable rename')
    } finally {
      await clearDurableOutbox()
    }
  })

  it('rolls a retained chat projection back when replay finally rejects it', async () => {
    await prepareDurableOutbox('chat-patch-discard')
    let rejectReplay = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH') {
          return rejectReplay
            ? jsonResponse({ error: 'invalid retained rename' }, 400)
            : jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const previous = currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].name = 'Rejected rename'
      })
      const result = dispatchUpdateChatAsync('chat-a', { name: 'Rejected rename' }, previous)
      await expect(result).resolves.toMatchObject({ status: 'error' })
      expect(getDatabase().characters[0].chats[0].name).toBe('Rejected rename')

      rejectReplay = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1, retained: 0 })

      expect(getDatabase().characters[0].chats[0].name).toBe('Chat A')
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearDurableOutbox()
    }
  })

  it.each(['accepted', 'failed'] as const)(
    'settles a retained narrow folder patch as %s after authoritative refresh',
    async (finalStatus) => {
      await prepareDurableOutbox(`narrow-folder-${finalStatus}`)
      let replay = false
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url === '/api/v1/commands/chat-folders/folder-a' && init.method === 'PATCH') {
            if (!replay) return jsonResponse({ error: 'temporarily unavailable' }, 503)
            return finalStatus === 'failed'
              ? jsonResponse({ error: 'folder rename rejected' }, 400)
              : jsonResponse({
                  revision: 12,
                  event: {
                    type: 'chatFolder.updated',
                    revision: 12,
                    resource: 'chatFolder',
                    id: 'folder-a',
                    parentId: 'char-a',
                  },
                })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }),
      )
      try {
        const snapshot = captureChatFolderMetadataPatch('folder-a', { name: 'Queued folder' }, 'char-a')!
        applyChatFolderMetadataOwnerPatch('char-a', 'folder-a', snapshot.attempted)
        const mutation = await dispatchChatFolderMetadataPatchWithOutcome(snapshot)
        expect(mutation).toMatchObject({ status: 'queued' })
        if (mutation?.status !== 'queued') throw new Error('Expected a queued folder patch')
        getDatabase().characters[0].chats[1].message.push({
          role: 'char',
          data: 'background generation',
          chatId: 'background',
        })
        const authoritativeCharacter = jsonClone(getDatabase().characters[0])
        authoritativeCharacter.chatFolders[0].name = 'Folder'
        authoritativeCharacter.chatFolders[0].color = 'blue'
        expect(applyCharacterResource({ revision: 11, character: authoritativeCharacter })).toBe(true)
        const owner = getDatabase().characters[0]
        const sibling = owner.chats[1]
        const message = sibling.message[0]
        expect(owner.chatFolders[0].name).toBe('Queued folder')
        expect(owner.chatFolders[0].color).toBe('blue')
        replay = true
        await replayPendingMutations()
        await expect(mutation.settlement).resolves.toMatchObject({ status: finalStatus })
        expect(owner.chatFolders[0].name).toBe(finalStatus === 'accepted' ? 'Queued folder' : 'Folder')
        expect(owner.chatFolders[0].color).toBe('blue')
        expect(getDatabase().characters[0]).toBe(owner)
        expect(owner.chats[1]).toBe(sibling)
        expect(sibling.message[0]).toBe(message)
        expect(message.data).toBe('background generation')
      } finally {
        await clearDurableOutbox()
      }
    },
  )

  it('does not nest a chat-row mutation that already carries durable transport', async () => {
    await prepareDurableOutbox('existing-transport')
    const intent = {
      version: 1 as const,
      requests: [
        {
          method: 'PATCH' as const,
          path: '/chats/chat-a',
          body: { patch: { suggestMessages: ['durable suggestion'] }, select: false },
        },
      ],
    }
    const outer = stagePendingMutation('character-owner:char-a', intent)
    const commandMutationIds: Array<string | null> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH') {
          const headers = init.headers as Record<string, string> | undefined
          commandMutationIds.push(headers?.['risu-mutation-id'] ?? null)
          return jsonResponse({
            revision: 11,
            event: {
              type: 'chat.updated',
              revision: 11,
              resource: 'characterRow',
              id: 'chat-a',
              parentId: 'char-a',
            },
            chatId: 'chat-a',
            selectedChatId: 'chat-a',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].suggestMessages = ['durable suggestion']
      })
      const rollback = {
        selectedCharID: 0,
        characterId: 'char-a',
        chatId: 'chat-a',
        metadata: {},
      }
      await expect(
        dispatchDurableMutation(outer, intent, (transport) => {
          return (
            dispatchUpdateChatRow('chat-a', { suggestMessages: ['durable suggestion'] }, rollback, transport) ??
            Promise.resolve({ status: 'unavailable' as const })
          )
        }),
      ).resolves.toMatchObject({ status: 'ok' })

      expect(commandMutationIds).toEqual([outer.mutationId])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearDurableOutbox()
    }
  })
})
