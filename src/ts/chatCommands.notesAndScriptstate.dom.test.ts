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
import { setCachedServerCommandRevision } from './server/commands'
import { setChatVar } from './parser/chatVar.svelte'
import { selectedCharID } from './stores.svelte'
import { replaceResourceDatabase as setDatabaseLite } from './server/resourceState.svelte'
// Import the heavy database module AFTER stores.svelte: importing it first
// triggers a circular-import TDZ when the reactive moduleUpdate $effect runs
// mid-init.
import { type Chat } from './storage/database.svelte'
import {
  applyOptimisticDeletedChat,
  applyChatNoteValueLocally,
  captureChatDeleteSnapshot,
  currentChatScriptstateSnapshot,
  currentChatStateSnapshot,
  dispatchDeleteChat,
  dispatchDeleteChatWithOutcome,
  dispatchPatchChatScriptstateScoped,
  dispatchStagedChatNoteMutation,
  dispatchUpdateChatNoteScoped,
  restoreChatScriptstate,
  setChatNoteValue,
  setChatScriptstateValue,
  stageChatNoteMutation,
} from './chatCommands'
import { assertRollbackRestoresOnly, assertSnapshotIsScalar, seedCloneCostDb } from './__tests__/cloneCostHarness'
import {
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from './server/pendingMutationOutbox'
import { replayPendingMutations } from './server/pendingMutationReplay'
import { registerPendingOwnerMutationFlusher } from './server/pendingOwnerMutationRegistry'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

setupChatCommandTests()

describe('chat command projection helpers', () => {
  it('sets DevTool-style scriptstate values through the chat scriptstate command helper', async () => {
    const calls = stubCommandFetch()
    expect(setChatScriptstateValue('chat-a', '$score', '9')).toBe(true)
    expect(getDatabase().characters[0].chats[0].scriptstate).toMatchObject({ $score: '9' })

    await waitForCallCount(calls, 2)
    expect(calls).toEqual([
      {
        url: '/api/v1/bootstrap',
        method: 'GET',
        authHeader: 'chat-command-token',
        body: null,
      },
      {
        url: '/api/v1/commands/chats/chat-a/scriptstate',
        method: 'PATCH',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: 10,
          patch: { $score: '9' },
          deleteKeys: [],
        },
      },
    ])
    expect(getDatabase().characters[0].chats[0].scriptstate).toMatchObject({ $score: '9' })
  })

  it('sets parser chat variables through the chat owner for Lua edit-display hooks', async () => {
    const calls = stubCommandFetch()
    setChatVar('outfit', 'date_a')
    expect(getDatabase().characters[0].chats[0].scriptstate).toMatchObject({ $outfit: 'date_a' })

    await waitForCallCount(calls, 2)
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      method: 'PATCH',
      authHeader: 'chat-command-token',
      body: {
        baseRevision: 10,
        patch: { $outfit: 'date_a' },
        deleteKeys: [],
      },
    })
  })

  it('creates scriptstate when setting a value on a chat without one', async () => {
    const calls = stubCommandFetch()
    expect(getDatabase().characters[0].chats[1]).not.toHaveProperty('scriptstate')

    expect(setChatScriptstateValue('chat-b', '$enabled', true)).toBe(true)

    expect(getDatabase().characters[0].chats[1].scriptstate).toEqual({ $enabled: true })
    await waitForCallCount(calls, 2)
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/chats/chat-b/scriptstate',
      method: 'PATCH',
      authHeader: 'chat-command-token',
      body: {
        baseRevision: 10,
        patch: { $enabled: true },
        deleteKeys: [],
      },
    })
  })

  it('rejects missing or invalid DevTool-style scriptstate targets without mutating or dispatching', () => {
    const calls = stubCommandFetch()
    const before = jsonClone(getDatabase().characters[0].chats[0].scriptstate)

    expect(setChatScriptstateValue(undefined, '$score', '2')).toBe(false)
    expect(setChatScriptstateValue('', '$score', '2')).toBe(false)
    expect(setChatScriptstateValue('missing-chat', '$score', '2')).toBe(false)
    expect(setChatScriptstateValue('chat-a', '', '2')).toBe(false)
    expect(setChatScriptstateValue('chat-a', '$object', { nested: true })).toBe(false)
    expect(setChatScriptstateValue('chat-a', '$nan', Number.NaN)).toBe(false)

    expect(getDatabase().characters[0].chats[0].scriptstate).toEqual(before)
    expect(calls).toEqual([])
  })

  it('rolls back helper scriptstate edits without touching concurrent message edits', async () => {
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
        if (url === '/api/v1/commands/chats/chat-a/scriptstate') {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[0].message.push({
              role: 'char',
              data: 'concurrent same-chat message',
              chatId: 'msg-concurrent',
            })
            getDatabase().characters[0].chats[1].name = 'Concurrent sibling edit'
          })
          return jsonResponse({ error: 'nope' }, 500)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    expect(setChatScriptstateValue('chat-a', '$score', 'failed')).toBe(true)
    expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({ $score: 'failed', $old: 'gone' })

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({ $score: '1', $old: 'gone' })
    })
    expect(getDatabase().characters[0].chats[0].message).toEqual([
      {
        role: 'char',
        data: 'concurrent same-chat message',
        chatId: 'msg-concurrent',
      },
    ])
    expect(getDatabase().characters[0].chats[1].name).toBe('Concurrent sibling edit')
  })
})

describe('chat-scriptstate snapshot kit', () => {
  it('captures only the scriptstate map and an optional note, never a chat or the collection', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)

    const snapshot = currentChatScriptstateSnapshot()
    expect(snapshot.chatId).toBe('chat-0')
    expect(snapshot.scriptstate).toEqual({ $score: '0', $old: 'gone' })
    expect(snapshot.note).toBeUndefined()
    assertSnapshotIsScalar(snapshot)

    const withNote = currentChatScriptstateSnapshot(true)
    expect(withNote.note).toBe('note-0')
    assertSnapshotIsScalar(withNote)

    // The scriptstate map is shallow-cloned: mutating the live map after the
    // snapshot must not bleed into the captured copy.
    getDatabase().characters[0].chats[0].scriptstate.$score = '99'
    expect(snapshot.scriptstate?.$score).toBe('0')
  })

  it('restores scriptstate and note only, preserving concurrent message edits on the same chat', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)

    assertRollbackRestoresOnly({
      capture: () => currentChatScriptstateSnapshot(true),
      mutate: () => {
        getDatabase().characters[0].chats[0].scriptstate = { $score: 'optimistic' }
        getDatabase().characters[0].chats[0].note = 'optimistic note'
        // a concurrent, unrelated edit to the same chat's message history
        getDatabase().characters[0].chats[0].message.push({
          role: 'char',
          data: 'concurrent',
          chatId: 'msg-concurrent',
        })
      },
      expectMutated: () => {
        expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({ $score: 'optimistic' })
      },
      restore: (snapshot) => restoreChatScriptstate(snapshot),
      expectRestored: () => {
        expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({
          $score: '0',
          $old: 'gone',
        })
        expect(getDatabase().characters[0].chats[0].note).toBe('note-0')
      },
      expectUntouched: () => {
        // a whole-chat restore would have wiped this concurrent message
        expect(getDatabase().characters[0].chats[0].message).toHaveLength(41)
      },
    })
  })
})

describe('scriptstate-scoped var dispatch', () => {
  it('dispatchPatchChatScriptstateScoped restores only the chat scriptstate on failure', async () => {
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
        if (url === '/api/v1/commands/chats/chat-a/scriptstate') {
          return jsonResponse({ error: 'nope' }, 500)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    const previous = currentChatScriptstateSnapshot(true)
    // optimistic scriptstate edit plus an unrelated concurrent message edit on
    // the same chat (a whole-chat restore would have wiped it)
    getDatabase().characters[0].chats[0].scriptstate!.$score = 'optimistic'
    getDatabase().characters[0].chats[0].message.push({ role: 'user', data: 'keep', chatId: 'm-keep' })

    dispatchPatchChatScriptstateScoped('chat-a', { $score: 'optimistic' }, [], previous)
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({ $score: '1', $old: 'gone' })
    expect(getDatabase().characters[0].chats[0].message).toHaveLength(1)
  })

  it('dispatchPatchChatScriptstateScoped preserves newer values for attempted patch and delete keys', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a/scriptstate' && init.method === 'PATCH',
      onCommand: () => {
        getDatabase().characters[0].chats[0].scriptstate = {
          $score: 'newer score',
          $old: 'newer recreated value',
        }
      },
    })
    const previous = currentChatScriptstateSnapshot()
    getDatabase().characters[0].chats[0].scriptstate = { $score: 'optimistic score' }

    dispatchPatchChatScriptstateScoped('chat-a', { $score: 'optimistic score' }, ['$old'], previous)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({
        $score: 'newer score',
        $old: 'newer recreated value',
      })
    })
  })

  it('dispatchUpdateChatNoteScoped restores only the chat note on failure', async () => {
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
        if (url === '/api/v1/commands/chats/chat-a') return jsonResponse({ error: 'nope' }, 500)
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    getDatabase().characters[0].chats[0].note = 'original note'

    const previous = currentChatScriptstateSnapshot(true)
    expect(previous.note).toBe('original note')

    getDatabase().characters[0].chats[0].note = 'optimistic note'
    getDatabase().characters[0].chats[0].scriptstate!.$score = 'keep'

    dispatchUpdateChatNoteScoped('chat-a', 'optimistic note', previous)
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].note).toBe('original note')
    expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({ $score: 'keep', $old: 'gone' })
  })

  it('dispatchUpdateChatNoteScoped preserves a newer note and sibling scriptstate edit', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH',
      onCommand: () => {
        getDatabase().characters[0].chats[0].note = 'newer note'
        getDatabase().characters[0].chats[0].scriptstate!.$score = 'newer score'
      },
    })
    getDatabase().characters[0].chats[0].note = 'original note'
    const previous = currentChatScriptstateSnapshot(true)
    getDatabase().characters[0].chats[0].note = 'optimistic note'

    dispatchUpdateChatNoteScoped('chat-a', 'optimistic note', previous)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].note).toBe('newer note')
    })
    expect(getDatabase().characters[0].chats[0].scriptstate!.$score).toBe('newer score')
  })

  it('setChatNoteValue applies the author note through its owner and rolls back on failure', async () => {
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
        if (url === '/api/v1/commands/chats/chat-a') return jsonResponse({ error: 'nope' }, 500)
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    delete (getDatabase().characters[0].chats[0] as { note?: string }).note
    expect(setChatNoteValue('chat-a', 'draft note')).toBe(true)
    expect(getDatabase().characters[0].chats[0].note).toBe('draft note')

    await waitForCallCount(calls, 2)

    expect(calls[1]).toEqual({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      authHeader: null,
      body: {
        baseRevision: 10,
        patch: { note: 'draft note' },
        select: false,
      },
    })
    expect(getDatabase().characters[0].chats[0].note).toBe('')
  })

  it('sends lifecycle author-note saves with keepalive', async () => {
    setCachedServerCommandRevision(10)
    let commandInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/chats/chat-a') {
          commandInit = init
          return jsonResponse({
            revision: 11,
            event: { type: 'chat.updated', revision: 11, resource: 'chat', id: 'chat-a' },
            chatId: 'chat-a',
            selectedChatId: 'chat-a',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    expect(setChatNoteValue('chat-a', 'draft before pagehide', { keepalive: true })).toBe(true)
    await vi.waitFor(() => expect(commandInit).toBeDefined())

    expect(commandInit).toMatchObject({ keepalive: true })
    expect(JSON.parse(String(commandInit?.body))).toMatchObject({ patch: { note: 'draft before pagehide' } })
  })

  it('persists and immediately dispatches an absolute note correction after a remote marker wins', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-author-note-revert',
      writerEpoch: 3,
      databaseLineage: 'lineage-author-note-revert',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].note = 'initial note'
    })

    try {
      const first = stageChatNoteMutation({
        chatId: 'chat-a',
        characterId: 'char-a',
        note: 'draft note',
      })
      await expect(first.outbox.ready).resolves.toBe('persisted')
      const remoteHandle = (await listPendingMutations())[0]!.handle
      await expect(beginPendingMutationDispatch(remoteHandle)).resolves.toBe('persisted')

      const correction = stageChatNoteMutation({
        chatId: 'chat-a',
        characterId: 'char-a',
        note: 'initial note',
        previous: first.outbox,
      })
      await expect(correction.outbox.ready).resolves.toBe('persisted')
      expect(
        (await listPendingMutations()).map((entry) => ({ key: entry.handle.key, body: entry.intent.requests[0].body })),
      ).toEqual([
        {
          key: 'character-owner:char-a',
          body: { patch: { note: 'draft note' }, select: false },
        },
        {
          key: 'character-owner:char-a',
          body: { patch: { note: 'initial note' }, select: false },
        },
      ])

      let revision = 10
      const commandBodies: Array<Record<string, unknown>> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH') {
            commandBodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : {})
            revision += 1
            return jsonResponse({
              revision,
              event: { type: 'chat.updated', revision, resource: 'chat', id: 'chat-a' },
              chatId: 'chat-a',
              selectedChatId: 'chat-a',
            })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }) as unknown as typeof fetch,
      )

      const rollback = currentChatScriptstateSnapshot(true)
      await expect(dispatchStagedChatNoteMutation(correction, rollback)).resolves.toMatchObject({ status: 'ok' })

      expect(commandBodies.map((body) => body.patch)).toEqual([{ note: 'draft note' }, { note: 'initial note' }])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('holds chat DELETE behind a transient note PATCH, then replays both without a late note request', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-delete',
      writerEpoch: 4,
      databaseLineage: 'lineage-chat-delete',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(20)

    try {
      const noteRollback = applyChatNoteValueLocally('chat-a', 'latest optimistic note')
      expect(noteRollback).toMatchObject({ note: '' })
      const noteMutation = stageChatNoteMutation({
        chatId: 'chat-a',
        characterId: 'char-a',
        note: 'latest optimistic note',
      })
      const previous = currentChatStateSnapshot()
      expect(applyOptimisticDeletedChat('char-a', 'chat-a', previous)).toMatchObject({ applied: true })

      let recover = false
      let revision = 20
      const commands: Array<{ method: string; body: Record<string, unknown> }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url === '/api/v1/commands/chats/chat-a') {
            const method = init.method ?? 'GET'
            const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
            commands.push({ method, body })
            if (!recover && method === 'PATCH') return jsonResponse({ error: 'note temporarily unavailable' }, 500)
            if (!recover) throw new Error('DELETE overtook its note predecessor')
            revision += 1
            if (method === 'PATCH') {
              return jsonResponse({
                revision,
                event: { type: 'chat.updated', revision, resource: 'chat', id: 'chat-a' },
                chatId: 'chat-a',
                selectedChatId: 'chat-b',
              })
            }
            return jsonResponse({
              revision,
              event: { type: 'chat.deleted', revision, resource: 'chat', id: 'chat-a' },
              chatId: 'chat-a',
              selectedChatId: 'chat-b',
            })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }) as unknown as typeof fetch,
      )

      dispatchDeleteChat('chat-a', previous)
      await vi.waitFor(() => expect(commands).toEqual([expect.objectContaining({ method: 'PATCH' })]))
      expect(
        (await listPendingMutations()).map((entry) => ({
          key: entry.handle.key,
          method: entry.intent.requests[0].method,
        })),
      ).toEqual([
        { key: 'character-owner:char-a', method: 'PATCH' },
        { key: 'character-owner:char-a', method: 'DELETE' },
      ])

      recover = true
      const recoveryStart = commands.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(commands.slice(recoveryStart).map((command) => command.method)).toEqual(['PATCH', 'DELETE'])
      expect(await listPendingMutations()).toEqual([])

      const commandCount = commands.length
      await expect(dispatchStagedChatNoteMutation(noteMutation, noteRollback!)).resolves.toEqual({
        status: 'unavailable',
      })
      expect(commands).toHaveLength(commandCount)
      // The blocked DELETE remained durable, so its optimistic projection
      // stayed visible while replay later committed the same deletion.
      expect(getDatabase().characters[0].chats.some((chat) => chat.id === 'chat-a')).toBe(false)
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it.each(['helper', 'direct'] as const)(
    'preserves a newer selection made during the held note flush before a failed scoped delete (%s projection)',
    async (projection) => {
      resetPendingMutationOutboxForTests()
      setCachedServerCommandRevision(30)
      const owner = getDatabase().characters[0]
      owner.chats.push({ id: 'chat-c', name: 'Chat C', message: [], note: '', localLore: [] } as Chat)
      expect(applyChatNoteValueLocally('chat-a', 'pending author note')).not.toBeNull()
      stageChatNoteMutation({ chatId: 'chat-a', characterId: 'char-a', note: 'pending author note' })
      const previous = captureChatDeleteSnapshot('chat-a', 'char-a')!
      if (projection === 'helper') {
        expect(applyOptimisticDeletedChat('char-a', 'chat-a', previous)).toMatchObject({
          applied: true,
          selectedChatId: 'chat-b',
        })
      } else {
        owner.chats.splice(0, 1)
        owner.chatPage = 0
      }
      const noteStarted = createDeferred<void>()
      const noteResponse = createDeferred<Response>()
      const methods: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          if (String(input) !== '/api/v1/commands/chats/chat-a') {
            return jsonResponse({ error: `unexpected ${String(input)}` }, 404)
          }
          methods.push(init.method ?? 'GET')
          if (init.method === 'PATCH') {
            noteStarted.resolve()
            return noteResponse.promise
          }
          return jsonResponse({ error: 'delete rejected' }, 500)
        }),
      )
      const mutation = dispatchDeleteChatWithOutcome('chat-a', previous)
      try {
        await noteStarted.promise
        expect(methods).toEqual(['PATCH'])
        owner.chatPage = owner.chats.findIndex((chat) => chat.id === 'chat-c')
        noteResponse.resolve(
          jsonResponse({
            revision: 31,
            event: { type: 'chat.updated', revision: 31, resource: 'chat', id: 'chat-a' },
          }),
        )
        await expect(mutation).resolves.toMatchObject({ status: 'failed' })
        expect(methods).toEqual(['PATCH', 'DELETE'])
        expect(owner.chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-c'])
        expect(owner.chats[owner.chatPage].id).toBe('chat-c')
      } finally {
        noteResponse.resolve(jsonResponse({ error: 'cleanup' }, 500))
        await mutation
        await clearPendingMutationOutbox()
        resetPendingMutationOutboxForTests()
      }
    },
  )

  it('flushes an owned note PATCH before DELETE without walking unrelated flushers', async () => {
    resetPendingMutationOutboxForTests()
    setCachedServerCommandRevision(30)
    const noteRollback = applyChatNoteValueLocally('chat-a', 'fallback note')
    expect(noteRollback).not.toBeNull()
    const noteMutation = stageChatNoteMutation({
      chatId: 'chat-a',
      characterId: 'char-a',
      note: 'fallback note',
    })
    let pendingNote = true
    const unregisterNoteFlusher = registerPendingOwnerMutationFlusher('test-author-note-fallback', (options) => {
      if (!pendingNote) return
      pendingNote = false
      void dispatchStagedChatNoteMutation(noteMutation, noteRollback!, options)
    })

    try {
      const previous = currentChatStateSnapshot()
      expect(applyOptimisticDeletedChat('char-a', 'chat-a', previous)).toMatchObject({ applied: true })

      let revision = 30
      const commands: Array<{ method: string; patch?: Record<string, unknown> }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url !== '/api/v1/commands/chats/chat-a') {
            return jsonResponse({ error: `unexpected ${url}` }, 404)
          }
          const method = init.method ?? 'GET'
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          commands.push({ method, patch: body.patch })
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: method === 'DELETE' ? 'chat.deleted' : 'chat.updated',
              revision,
              resource: 'chat',
              id: 'chat-a',
            },
            chatId: 'chat-a',
            selectedChatId: 'chat-b',
          })
        }) as unknown as typeof fetch,
      )

      dispatchDeleteChat('chat-a', previous)
      await vi.waitFor(() => expect(commands).toHaveLength(2))

      expect(commands).toEqual([
        { method: 'PATCH', patch: { note: 'fallback note' } },
        { method: 'DELETE', patch: undefined },
      ])
      expect(pendingNote).toBe(true)
    } finally {
      unregisterNoteFlusher()
      resetPendingMutationOutboxForTests()
    }
  })
})

describe('durable chat and folder structure dispatch', () => {
  it('retains direct scriptstate and author-note projections with explicit character ownership', async () => {
    await prepareDurableOutbox('scriptstate')
    let liveBody: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/chats/chat-a/scriptstate' && init.method === 'PATCH') {
          liveBody = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const previous = currentChatScriptstateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].scriptstate = { $score: 'durable' }
      })
      dispatchPatchChatScriptstateScoped('chat-a', { $score: 'durable' }, ['$old'], previous)
      await vi.waitFor(() => expect(liveBody).toBeDefined())

      expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({ $score: 'durable' })
      const pending = await listPendingMutations()
      expect(pending).toMatchObject([
        {
          handle: { key: 'character-owner:char-a' },
          intent: {
            requests: [
              {
                method: 'PATCH',
                path: '/chats/chat-a/scriptstate',
                body: { patch: { $score: 'durable' }, deleteKeys: ['$old'] },
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

    await prepareDurableOutbox('direct-note')
    liveBody = undefined
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
      const previous = currentChatScriptstateSnapshot(true)
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].note = 'Durable trigger note'
      })
      const result = dispatchUpdateChatNoteScoped('chat-a', 'Durable trigger note', previous)
      await expect(result).resolves.toMatchObject({ status: expect.any(String) })

      expect(getDatabase().characters[0].chats[0].note).toBe('Durable trigger note')
      const pending = await listPendingMutations()
      expect(pending).toMatchObject([
        {
          handle: { key: 'character-owner:char-a' },
          intent: {
            requests: [
              {
                method: 'PATCH',
                path: '/chats/chat-a',
                body: { patch: { note: 'Durable trigger note' }, select: false },
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
})
