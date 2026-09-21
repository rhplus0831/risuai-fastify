import {
  setupChatCommandTests,
  type CapturedFetch,
  jsonResponse,
  type Deferred,
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
import { SERVER_UNLOADED_CHAT_MESSAGE_MARKER } from './server/chatMessagePlaceholders'
import { demoteClientSession } from './clientSession'
import { enterClientWriter, repromoteClientWriter } from './__tests__/clientSession'
import { selectedCharID } from './stores.svelte'
import { replaceResourceDatabase as setDatabaseLite } from './server/resourceState.svelte'
// Import the heavy database module AFTER stores.svelte: importing it first
// triggers a circular-import TDZ when the reactive moduleUpdate $effect runs
// mid-init.
import { type Chat, type Message } from './storage/database.svelte'
import {
  appendCurrentChatEmptyCharMessage,
  appendCurrentChatUserMessageForSend,
  captureActiveChatTarget,
  currentChatScopedSnapshot,
  dispatchCompatibleChatUpdateScoped,
  dispatchDeleteMessageScoped,
  dispatchReplaceTailMessagesScoped,
  dispatchReplaceMessagesScoped,
  dispatchTruncateMessagesScoped,
  dispatchUpdateMessageScoped,
  isActiveChatTargetFresh,
  prepareCompatibleChatUpdateScoped,
  restoreChatScopedState,
} from './chatCommands'
import {
  assertRollbackRestoresOnly,
  assertSnapshotOmitsCollections,
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
import { reapplyRetainedChatBodyProjections } from './server/chatRetainedProjection'
import { acknowledgeCreatedChatTranscriptLocalEffect } from './server/chatMessageHydration.svelte'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

setupChatCommandTests()

function stubControlledMessagePatchFetch(): {
  calls: CapturedFetch[]
  firstResponse: Deferred<Response>
  secondResponse: Deferred<Response>
} {
  const calls: CapturedFetch[] = []
  const firstResponse = createDeferred<Response>()
  const secondResponse = createDeferred<Response>()
  let messagePatchCallCount = 0
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
      if (url === '/api/v1/commands/messages/m-1' && init.method === 'PATCH') {
        messagePatchCallCount += 1
        if (messagePatchCallCount === 1) return firstResponse.promise
        if (messagePatchCallCount === 2) return secondResponse.promise
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return { calls, firstResponse, secondResponse }
}

function successfulMessagePatchResponse(revision: number): Response {
  return jsonResponse({
    revision,
    event: {
      type: 'message.updated',
      revision,
      resource: 'message',
      id: 'm-1',
      parentId: 'chat-a',
    },
    chatId: 'chat-a',
    messageId: 'm-1',
  })
}

function stubMessagePersistenceFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(requestInput)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/chats/chat-a/messages' && init.method === 'POST') {
        return jsonResponse({
          revision: 11,
          event: {
            type: 'message.appended',
            revision: 11,
            resource: 'message',
            id: body?.message?.chatId,
            parentId: 'chat-a',
          },
          chatId: 'chat-a',
          messageId: body?.message?.chatId,
        })
      }
      if (url === '/api/v1/commands/chats/chat-a/messages/tail' && init.method === 'POST') {
        return jsonResponse({
          revision: 11,
          event: {
            type: 'messages.tailReplaced',
            revision: 11,
            resource: 'message',
            parentId: 'chat-a',
          },
          chatId: 'chat-a',
          afterMessageId: body?.afterMessageId ?? null,
          messageIds: Array.isArray(body?.messages) ? body.messages.map((message: Message) => message.chatId) : [],
          replacedCount: Array.isArray(body?.messages) ? body.messages.length : 0,
        })
      }
      if (url === '/api/v1/commands/chats/chat-a/messages/truncate' && init.method === 'POST') {
        return jsonResponse({
          revision: 11,
          event: {
            type: 'message.truncated',
            revision: 11,
            resource: 'message',
            parentId: 'chat-a',
          },
          chatId: 'chat-a',
          afterMessageId: body?.afterMessageId ?? null,
          removedCount: 1,
        })
      }
      if (url.startsWith('/api/v1/commands/messages/') && init.method === 'PATCH') {
        const messageId = decodeURIComponent(url.split('/').at(-1) ?? '')
        return jsonResponse({
          revision: 11,
          event: {
            type: 'message.updated',
            revision: 11,
            resource: 'message',
            id: messageId,
            parentId: 'chat-a',
          },
          chatId: 'chat-a',
          messageId,
        })
      }
      if (url.startsWith('/api/v1/commands/messages/') && init.method === 'DELETE') {
        const messageId = decodeURIComponent(url.split('/').at(-1) ?? '')
        return jsonResponse({
          revision: 11,
          event: {
            type: 'message.deleted',
            revision: 11,
            resource: 'message',
            id: messageId,
            parentId: 'chat-a',
          },
          chatId: 'chat-a',
          messageId,
        })
      }
      if (url === '/api/v1/commands/chats/chat-a/messages' && init.method === 'PUT') {
        return jsonResponse({
          revision: 11,
          event: { type: 'messages.replaced', revision: 11, resource: 'message', parentId: 'chat-a' },
          chatId: 'chat-a',
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function serverMessagePlaceholder(): Message {
  return {
    role: 'char',
    data: '',
    isComment: true,
    disabled: true,
    [SERVER_UNLOADED_CHAT_MESSAGE_MARKER]: true,
  } as Message
}

function seedReadyActiveChatGenerationSettings(): void {
  withTestDatabaseWrite(() => {
    getDatabase().personas = [
      {
        id: 'persona-a',
        name: 'Persona A',
        personaPrompt: '',
        icon: '',
        note: '',
        largePortrait: false,
      },
    ] as any
    getDatabase().modelPresets = [{ id: 'model-preset-a', name: 'Model Preset A' }] as any
    getDatabase().promptPresets = [{ id: 'preset-a', name: 'Preset A' }] as any
    getDatabase().characters[0].chats[0].generationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: false,
      sidebarToggles: {},
    }
  })
}

describe('chat command projection helpers', () => {
  it('appends DevTool Autopilot user messages through an awaited message command', async () => {
    const calls = stubCommandFetch()
    seedReadyActiveChatGenerationSettings()
    const result = await appendCurrentChatUserMessageForSend('autopilot row')

    expect(result.status).toBe('ok')
    await waitForCallCount(calls, 2)
    const message = getDatabase().characters[0].chats[0].message[0]
    expect(message).toMatchObject({
      role: 'user',
      data: 'autopilot row',
      chatId: expect.any(String),
      time: expect.any(Number),
    })
    expect(calls).toEqual([
      {
        url: '/api/v1/bootstrap',
        method: 'GET',
        authHeader: 'chat-command-token',
        body: null,
      },
      {
        url: '/api/v1/commands/chats/chat-a/messages',
        method: 'POST',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: 10,
          message: {
            role: 'user',
            data: 'autopilot row',
            chatId: message.chatId,
            time: message.time,
          },
        },
      },
    ])
  })

  it('rejects a captured active-chat target after chatPage changes without mutating or dispatching', async () => {
    const calls = stubCommandFetch()
    seedReadyActiveChatGenerationSettings()
    const target = captureActiveChatTarget()

    expect(target).toMatchObject({ characterId: 'char-a', chatId: 'chat-a' })
    expect(isActiveChatTargetFresh(target)).toBe(true)

    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatPage = 1
    })

    expect(isActiveChatTargetFresh(target)).toBe(false)
    const result = await appendCurrentChatUserMessageForSend('stale autopilot row', {
      expectedTarget: target,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'The active chat changed before the message could be appended.',
    })
    expect(calls).toEqual([])
    expect(getDatabase().characters[0].chats[0].message).toEqual([])
    expect(getDatabase().characters[0].chats[1].message).toEqual([])
  })

  it('rejects a captured active-chat target after selectedCharID changes without mutating or dispatching', async () => {
    const calls = stubCommandFetch()
    withTestDatabaseWrite(() => {
      getDatabase().characters.push({
        chaId: 'char-b',
        name: 'Character B',
        chatPage: 0,
        chats: [{ id: 'chat-c', name: 'Chat C', message: [] }],
      } as any)
    })
    const target = captureActiveChatTarget()

    expect(target).toMatchObject({ characterId: 'char-a', chatId: 'chat-a' })
    selectedCharID.set(1)

    expect(isActiveChatTargetFresh(target)).toBe(false)
    const result = await appendCurrentChatUserMessageForSend('stale character row', {
      expectedTarget: target,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'The active chat changed before the message could be appended.',
    })
    expect(calls).toEqual([])
    expect(getDatabase().characters[0].chats[0].message).toEqual([])
    expect(getDatabase().characters[1].chats[0].message).toEqual([])
  })

  it('blocks direct send appends when active-chat generation settings are incomplete', async () => {
    const calls = stubCommandFetch()
    const result = await appendCurrentChatUserMessageForSend('autopilot row')

    expect(result).toEqual({
      status: 'error',
      error:
        'Chat generation settings are incomplete. Missing: Generation settings, Configuration confirmation, Persona, Model preset, Prompt preset, Jailbreak toggle.',
    })
    expect(calls).toEqual([])
    expect(getDatabase().characters[0].chats[0].message).toEqual([])
  })

  it('appends prepared plain-send user messages through one-message POST bodies', async () => {
    const calls = stubCommandFetch()
    seedReadyActiveChatGenerationSettings()
    const prepared: Message = {
      role: 'user',
      data: 'prepared plain send',
      time: 123456,
      name: null,
    }

    const result = await appendCurrentChatUserMessageForSend(prepared)

    expect(result.status).toBe('ok')
    await waitForCallCount(calls, 2)
    const message = getDatabase().characters[0].chats[0].message[0]
    expect(message).toMatchObject({
      role: 'user',
      data: 'prepared plain send',
      chatId: expect.any(String),
      time: 123456,
      name: null,
    })
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/chats/chat-a/messages',
      method: 'POST',
      authHeader: 'chat-command-token',
      body: {
        baseRevision: 10,
        message: {
          role: 'user',
          data: 'prepared plain send',
          chatId: message.chatId,
          time: 123456,
          name: null,
        },
      },
    })
    expect(calls[1].body).not.toHaveProperty('messages')
  })

  it('reports a retryable durable user append as queued and keeps its exact optimistic row', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-user-append',
      writerEpoch: 31,
      databaseLineage: 'lineage-chat-user-append',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    seedReadyActiveChatGenerationSettings()
    let liveBody: Record<string, unknown> | undefined

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/chats/chat-a/messages') {
          liveBody = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const result = await appendCurrentChatUserMessageForSend({
        role: 'user',
        data: 'keep this queued message',
        time: 444,
        name: null,
      })

      expect(result).toMatchObject({
        status: 'queued',
        messageId: expect.any(String),
        settlement: expect.any(Promise),
      })
      const projectedMessage = getDatabase().characters[0].chats[0].message.at(-1)
      expect(projectedMessage).toEqual({
        role: 'user',
        data: 'keep this queued message',
        time: 444,
        name: null,
        chatId: result.status === 'queued' ? result.messageId : undefined,
      })

      const pending = await listPendingMutations()
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        handle: { key: 'character-owner:char-a' },
        intent: {
          version: 1,
          requests: [
            {
              method: 'POST',
              path: '/chats/chat-a/messages',
              body: { message: projectedMessage },
            },
          ],
        },
      })
      const { baseRevision: _baseRevision, ...exactLiveBody } = liveBody ?? {}
      expect(exactLiveBody).toEqual(pending[0].intent.requests[0].body)
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('rolls back failed send appends by appended message id only', async () => {
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
        if (url === '/api/v1/commands/chats/chat-a/messages') {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[0].message.push({
              role: 'char',
              data: 'later projection message',
              chatId: 'm-later',
            })
          })
          return jsonResponse({ error: 'nope' }, 500)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    seedReadyActiveChatGenerationSettings()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].message.push({
        role: 'char',
        data: 'pre-existing',
        chatId: 'm-existing',
      })
    })

    const result = await appendCurrentChatUserMessageForSend({
      role: 'user',
      data: 'failed plain send row',
      time: 222,
      name: null,
    })

    expect(result).toEqual({ status: 'error', error: 'nope' })
    await waitForCallCount(calls, 2)
    expect(getDatabase().characters[0].chats[0].message).toEqual([
      { role: 'char', data: 'pre-existing', chatId: 'm-existing' },
      { role: 'char', data: 'later projection message', chatId: 'm-later' },
    ])
  })

  it('does not roll back into the active chat when the original chat id disappears', async () => {
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
        if (url === '/api/v1/commands/chats/chat-a/messages') {
          withTestDatabaseWrite(() => {
            const character = getDatabase().characters[0]
            const siblingChat = character.chats.find((chat: Chat) => chat.id === 'chat-b')
            if (!siblingChat) throw new Error('missing sibling chat')
            character.chats = [siblingChat]
            character.chatPage = 0
          })
          return jsonResponse({ error: 'nope' }, 500)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    seedReadyActiveChatGenerationSettings()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[1].message.push({
        role: 'char',
        data: 'same id on active sibling',
        chatId: 'm-shared',
      })
    })

    const result = await appendCurrentChatUserMessageForSend({
      role: 'user',
      data: 'failed vanished-chat send',
      chatId: 'm-shared',
      time: 333,
      name: null,
    })

    expect(result).toEqual({ status: 'error', error: 'nope' })
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages',
      method: 'POST',
      body: {
        message: {
          chatId: 'm-shared',
        },
      },
    })
    expect(getDatabase().characters[0].chats).toHaveLength(1)
    expect(getDatabase().characters[0].chats[0]).toMatchObject({
      id: 'chat-b',
      message: [{ role: 'char', data: 'same id on active sibling', chatId: 'm-shared' }],
    })
  })
})

describe('chat-scoped snapshot kit', () => {
  it('captures only the active chat, never the whole characters array', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)

    const snapshot = currentChatScopedSnapshot()

    expect(snapshot.characterId).toBe('char-0')
    expect(snapshot.chatId).toBe('chat-0')
    expect(snapshot.selectedCharID).toBe(0)
    expect(snapshot.chat?.message).toHaveLength(40)
    expect(snapshot).not.toHaveProperty('characters')
    assertSnapshotOmitsCollections(snapshot)

    const charactersSize = JSON.stringify(getDatabase().characters).length
    const instrumented = withCloneInstrumentation(() => currentChatScopedSnapshot())
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)
  })

  it('fails closed when a ready character id is ambiguous', () => {
    const database = seedCloneCostDb() as any
    database.characters.push({ ...database.characters[0] })
    setDatabaseLite(database)
    selectedCharID.set(0)

    const snapshot = currentChatScopedSnapshot()

    expect(snapshot.characterId).toBe('char-0')
    expect(snapshot.chatId).toBe('chat-0')
    expect(snapshot.chat).toBeUndefined()
  })

  it('fails closed when a stable chat id has multiple global owners', () => {
    const database = seedCloneCostDb() as any
    database.characters[1].chats[0].id = database.characters[0].chats[0].id
    setDatabaseLite(database)
    selectedCharID.set(0)

    const snapshot = currentChatScopedSnapshot()

    expect(snapshot.characterId).toBe('char-0')
    expect(snapshot.chatId).toBe('chat-0')
    expect(snapshot.chat).toBeUndefined()
    expect(captureActiveChatTarget()).toBeNull()
  })

  it('restores only the active chat, preserving concurrent edits to other chats', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)

    assertRollbackRestoresOnly({
      capture: () => currentChatScopedSnapshot(),
      mutate: () => {
        getDatabase().characters[0].chats[0].message.push({
          role: 'char',
          data: 'optimistic',
          chatId: 'msg-extra',
        })
        // an unrelated, concurrent edit to a different character's chat
        getDatabase().characters[1].chats[0].note = 'sibling concurrent note'
      },
      expectMutated: () => {
        expect(getDatabase().characters[0].chats[0].message).toHaveLength(41)
      },
      restore: (snapshot) => restoreChatScopedState(snapshot),
      expectRestored: () => {
        expect(getDatabase().characters[0].chats[0].message).toHaveLength(40)
      },
      expectUntouched: () => {
        expect(getDatabase().characters[1].chats[0].note).toBe('sibling concurrent note')
      },
    })
  })

  it('restores the chat by stable id even when its character index has shifted', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)
    const snapshot = currentChatScopedSnapshot()

    getDatabase().characters[0].chats[0].message.push({
      role: 'char',
      data: 'optimistic',
      chatId: 'msg-extra',
    })
    getDatabase().characters.unshift({ chaId: 'char-new', name: 'Inserted', chats: [] } as any)

    restoreChatScopedState(snapshot)

    const restored = getDatabase().characters.find((c: any) => c.chaId === 'char-0')
    expect(restored.chats[0].message).toHaveLength(40)
  })
})

describe('chat-scoped message dispatch', () => {
  it('dispatchReplaceMessagesScoped rolls back only the active chat on failure', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a/messages' && init.method === 'PUT',
    })
    // a sibling character to prove the scoped rollback never touches it
    getDatabase().characters.push({
      chaId: 'char-b',
      name: 'Other',
      chatPage: 0,
      chats: [{ id: 'chat-c', name: 'C', message: [{ role: 'user', data: 'sib', chatId: 'm-sib' }] }],
      chatFolders: [],
    } as any)

    const scoped = currentChatScopedSnapshot()
    expect(scoped.chatId).toBe('chat-a')

    const attemptedMessages: Message[] = [
      {
        role: 'user',
        data: 'x',
        chatId: 'm-x',
      },
    ]
    // optimistic local edits: the active message array plus unrelated same-row
    // and sibling edits a whole-chat restore would wipe.
    getDatabase().characters[0].chats[0].message = jsonClone(attemptedMessages)
    getDatabase().characters[0].chats[0].note = 'same chat concurrent note'
    getDatabase().characters[0].chats[0].localLore = [
      {
        id: 'lore-live',
        key: 'live',
        content: 'keep me',
      },
    ] as any
    getDatabase().characters[0].chats[0].scriptstate = {
      $score: 'newer',
    }
    getDatabase().characters[0].chats[1].message.push({
      role: 'char',
      data: 'same character sibling',
      chatId: 'm-sibling',
    })
    getDatabase().characters[1].chats[0].note = 'sibling concurrent'

    dispatchReplaceMessagesScoped('chat-a', attemptedMessages, scoped)
    await waitForCallCount(calls, 2)

    // only the active chat's message array is restored
    expect(getDatabase().characters[0].chats[0].message).toEqual([])
    expect(getDatabase().characters[0].chats[0].note).toBe('same chat concurrent note')
    expect(getDatabase().characters[0].chats[0].localLore).toEqual([
      {
        id: 'lore-live',
        key: 'live',
        content: 'keep me',
      },
    ])
    expect(getDatabase().characters[0].chats[0].scriptstate).toEqual({ $score: 'newer' })
    expect(getDatabase().characters[0].chats[1].message).toEqual([
      {
        role: 'char',
        data: 'same character sibling',
        chatId: 'm-sibling',
      },
    ])
    expect(getDatabase().characters[1].chats[0].note).toBe('sibling concurrent')
  })

  it('persists a fully hydrated user append with appendMessageCommand', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat: Chat = {
      ...jsonClone(getDatabase().characters[0].chats[0]),
      message: [{ role: 'user', data: 'before', chatId: 'm-before' }],
    }
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    const previous = currentChatScopedSnapshot()
    const nextChat = jsonClone(previousChat)
    nextChat.message.push({ role: 'char', data: 'new reply', time: 123 })
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)
    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages',
      method: 'POST',
      body: {
        baseRevision: 10,
        message: {
          role: 'char',
          data: 'new reply',
          time: 123,
          chatId: expect.any(String),
        },
      },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('rejects a two-message full replacement from an unhydrated bootstrap shell without emitting a PUT', () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat = jsonClone(getDatabase().characters[0].chats[0])
    const previous = currentChatScopedSnapshot()
    const nextChat: Chat = {
      ...jsonClone(previousChat),
      message: [
        { role: 'user', data: 'plugin one', chatId: 'message-plugin-1' },
        { role: 'char', data: 'plugin two', chatId: 'message-plugin-2' },
      ],
    }
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)

    expect(prepared.commandCount).toBe(0)
    prepared.dispatch()
    expect(getDatabase().characters[0].chats[0].message).toEqual([])
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('keeps an unhydrated empty-shell single append on the non-destructive POST path', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat = jsonClone(getDatabase().characters[0].chats[0])
    const previous = currentChatScopedSnapshot()
    const nextChat: Chat = {
      ...jsonClone(previousChat),
      message: [{ role: 'user', data: 'safe append', chatId: 'message-appended' }],
    }
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)

    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages',
      method: 'POST',
      body: { message: { data: 'safe append', chatId: 'message-appended' } },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('allows a full replacement from a known-complete empty created transcript', async () => {
    const calls = stubMessagePersistenceFetch()
    expect(acknowledgeCreatedChatTranscriptLocalEffect('chat-a')).toBe(true)
    const previousChat = jsonClone(getDatabase().characters[0].chats[0])
    const previous = currentChatScopedSnapshot()
    const nextChat: Chat = {
      ...jsonClone(previousChat),
      message: [
        { role: 'user', data: 'created one', chatId: 'message-created-1' },
        { role: 'char', data: 'created two', chatId: 'message-created-2' },
      ],
    }
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)

    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages',
      method: 'PUT',
    })
  })

  it('persists a fully hydrated single message edit with updateMessageCommand', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat: Chat = {
      ...jsonClone(getDatabase().characters[0].chats[0]),
      message: [
        { role: 'user', data: 'before', chatId: 'm-before', time: 1 },
        { role: 'char', data: 'unchanged', chatId: 'm-unchanged', time: 2 },
      ],
    }
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    const previous = currentChatScopedSnapshot()
    const nextChat = jsonClone(previousChat)
    nextChat.message[0].data = 'after'
    nextChat.message[0].translation = { display: 'translated' } as any
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)
    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/messages/m-before',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: {
          data: 'after',
          translation: { display: 'translated' },
        },
      },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('persists a fully hydrated middle delete with deleteMessageCommand', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat: Chat = {
      ...jsonClone(getDatabase().characters[0].chats[0]),
      message: [
        { role: 'user', data: 'one', chatId: 'm-1' },
        { role: 'char', data: 'two', chatId: 'm-2' },
        { role: 'user', data: 'three', chatId: 'm-3' },
      ],
    }
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    const previous = currentChatScopedSnapshot()
    const nextChat = {
      ...jsonClone(previousChat),
      message: [jsonClone(previousChat.message[0]), jsonClone(previousChat.message[2])],
    }
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)
    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/messages/m-2',
      method: 'DELETE',
      body: {
        baseRevision: 10,
      },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('persists a fully hydrated suffix delete with truncateMessagesCommand', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat: Chat = {
      ...jsonClone(getDatabase().characters[0].chats[0]),
      message: [
        { role: 'user', data: 'one', chatId: 'm-1' },
        { role: 'char', data: 'two', chatId: 'm-2' },
        { role: 'user', data: 'three', chatId: 'm-3' },
      ],
    }
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    const previous = currentChatScopedSnapshot()
    const nextChat = {
      ...jsonClone(previousChat),
      message: [jsonClone(previousChat.message[0])],
    }
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)
    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      method: 'POST',
      body: {
        baseRevision: 10,
        afterMessageId: 'm-1',
      },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('persists a fully hydrated tail rewrite with replaceTailMessagesCommand', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat: Chat = {
      ...jsonClone(getDatabase().characters[0].chats[0]),
      message: [
        { role: 'user', data: 'anchor', chatId: 'm-anchor' },
        { role: 'char', data: 'old one', chatId: 'm-old-1' },
        { role: 'user', data: 'old two', chatId: 'm-old-2' },
      ],
    }
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    const previous = currentChatScopedSnapshot()
    const nextChat: Chat = {
      ...jsonClone(previousChat),
      message: [
        { role: 'user', data: 'anchor', chatId: 'm-anchor' },
        { role: 'char', data: 'replacement' },
      ],
    }
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)
    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages/tail',
      method: 'POST',
      body: {
        baseRevision: 10,
        afterMessageId: 'm-anchor',
        messages: [
          {
            role: 'char',
            data: 'replacement',
            chatId: expect.any(String),
          },
        ],
      },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('persists a placeholder-prefix AOS-style user append with appendMessageCommand', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat: Chat = {
      ...jsonClone(getDatabase().characters[0].chats[0]),
      message: [
        serverMessagePlaceholder(),
        serverMessagePlaceholder(),
        { role: 'user', data: 'known user tail', chatId: 'm-tail-user' },
        { role: 'char', data: 'known char tail', chatId: 'm-tail-char' },
      ],
    }
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    const previous = currentChatScopedSnapshot()
    const nextChat = jsonClone(previousChat)
    nextChat.message.push({
      role: 'user',
      data: 'Selected AOS choice',
      time: 123,
    })
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)
    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages',
      method: 'POST',
      body: {
        baseRevision: 10,
        message: {
          role: 'user',
          data: 'Selected AOS choice',
          time: 123,
          chatId: expect.any(String),
        },
      },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('persists a placeholder-prefix tail suffix replacement after a known message anchor', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousChat: Chat = {
      ...jsonClone(getDatabase().characters[0].chats[0]),
      message: [
        serverMessagePlaceholder(),
        serverMessagePlaceholder(),
        { role: 'user', data: 'known anchor', chatId: 'm-anchor' },
        { role: 'char', data: 'old tail', chatId: 'm-old-tail' },
      ],
    }
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    const previous = currentChatScopedSnapshot()
    const nextChat: Chat = {
      ...jsonClone(previousChat),
      message: [
        serverMessagePlaceholder(),
        serverMessagePlaceholder(),
        { role: 'user', data: 'known anchor', chatId: 'm-anchor' },
        { role: 'char', data: 'replacement tail' },
      ],
    }
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)
    expect(prepared.commandCount).toBe(1)
    prepared.dispatch()

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages/tail',
      method: 'POST',
      body: {
        baseRevision: 10,
        afterMessageId: 'm-anchor',
        messages: [
          {
            role: 'char',
            data: 'replacement tail',
            chatId: expect.any(String),
          },
        ],
      },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/messages' && call.method === 'PUT')).toBe(
      false,
    )
  })

  it('rolls back unsafe placeholder-containing message edits instead of leaving an unpersisted projection', () => {
    const previousChat: Chat = {
      ...jsonClone(getDatabase().characters[0].chats[0]),
      message: [
        serverMessagePlaceholder(),
        { role: 'user', data: 'known anchor', chatId: 'm-anchor' },
        { role: 'char', data: 'known tail', chatId: 'm-tail' },
      ],
    }
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    const previous = currentChatScopedSnapshot()
    const nextChat = jsonClone(previousChat)
    nextChat.message[0] = {
      ...serverMessagePlaceholder(),
      data: 'unsafe local placeholder edit',
    }
    getDatabase().characters[0].chats[0] = nextChat

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)

    expect(prepared.commandCount).toBe(0)
    prepared.dispatch()
    expect(getDatabase().characters[0].chats[0].message).toEqual(previousChat.message)
  })

  it('scoped compatible chat preparation preserves accepted metadata when message persistence fails', async () => {
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
        if (url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH') {
          return jsonResponse({
            revision: 11,
            event: { type: 'chat.updated', revision: 11, resource: 'chat', id: 'chat-a' },
            selectedChatId: 'chat-a',
          })
        }
        if (url === '/api/v1/commands/chats/chat-a/messages' && init.method === 'PUT') {
          return jsonResponse({ error: 'message replace failed' }, 500)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    const previousChat = jsonClone(getDatabase().characters[0].chats[0])
    previousChat.message = [{ role: 'user', data: 'before', chatId: 'm-before' }]
    getDatabase().characters[0].chats[0] = jsonClone(previousChat)
    expect(acknowledgeCreatedChatTranscriptLocalEffect('chat-a')).toBe(true)
    const previous = currentChatScopedSnapshot()
    const nextChat: Chat = {
      ...jsonClone(previousChat),
      name: 'Accepted name',
      message: [{ role: 'char', data: 'attempted', chatId: 'm-attempted' }],
    }

    getDatabase().characters[0].chats[0] = jsonClone(nextChat)

    const prepared = prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous)
    prepared.dispatch()
    await waitForCallCount(calls, 3)

    expect(getDatabase().characters[0].chats[0].name).toBe('Accepted name')
    expect(getDatabase().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'before', chatId: 'm-before' }])
  })
})

describe('chat-scoped message attempt rollback', () => {
  function seedActiveMessages(messages: Message[]): void {
    getDatabase().characters[0].chats[0].message = jsonClone(messages)
  }

  it('restores the original message field when overlapping scoped updates both fail', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/messages/m-1' && init.method === 'PATCH',
    })
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const firstPrevious = currentChatScopedSnapshot()
    dispatchUpdateMessageScoped('m-1', { data: 'first edit' }, firstPrevious)
    const secondPrevious = currentChatScopedSnapshot()
    dispatchUpdateMessageScoped('m-1', { data: 'second edit' }, secondPrevious)

    expect(getDatabase().characters[0].chats[0].message[0].data).toBe('second edit')
    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].message[0].data).toBe('before')
    })
  })

  it('keeps a duplicate stale-snapshot patch when the first request succeeds and the second fails', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledMessagePatchFetch()
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const stalePrevious = currentChatScopedSnapshot()
    const firstMutation = dispatchUpdateMessageScoped('m-1', { data: 'same' }, stalePrevious)
    const secondMutation = dispatchUpdateMessageScoped('m-1', { data: 'same' }, stalePrevious)

    try {
      expect(getDatabase().characters[0].chats[0].message[0].data).toBe('same')
      await waitForCallCount(calls, 2)
      firstResponse.resolve(successfulMessagePatchResponse(11))
      await waitForCallCount(calls, 3)
      secondResponse.resolve(jsonResponse({ error: 'second patch failed' }, 500))

      await expect(firstMutation).resolves.toMatchObject({ status: 'accepted' })
      await expect(secondMutation).resolves.toMatchObject({ status: 'failed' })
      expect(getDatabase().characters[0].chats[0].message[0].data).toBe('same')
      expect(calls.slice(1).map((call) => call.body)).toEqual([
        expect.objectContaining({ patch: { data: 'same' } }),
        expect.objectContaining({ patch: { data: 'same' } }),
      ])
    } finally {
      firstResponse.resolve(jsonResponse({ error: 'cleanup' }, 500))
      secondResponse.resolve(jsonResponse({ error: 'cleanup' }, 500))
      await Promise.allSettled([firstMutation, secondMutation])
    }
  })

  it('repaints a duplicate stale-snapshot patch when the first request fails and the second succeeds', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledMessagePatchFetch()
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const stalePrevious = currentChatScopedSnapshot()
    const firstMutation = dispatchUpdateMessageScoped('m-1', { data: 'same' }, stalePrevious)
    const secondMutation = dispatchUpdateMessageScoped('m-1', { data: 'same' }, stalePrevious)

    try {
      await waitForCallCount(calls, 2)
      firstResponse.resolve(jsonResponse({ error: 'first patch failed' }, 500))
      await waitForCallCount(calls, 3)
      expect(getDatabase().characters[0].chats[0].message[0].data).toBe('same')
      secondResponse.resolve(successfulMessagePatchResponse(11))

      await expect(firstMutation).resolves.toMatchObject({ status: 'failed' })
      await expect(secondMutation).resolves.toMatchObject({ status: 'accepted' })
      expect(getDatabase().characters[0].chats[0].message[0].data).toBe('same')
    } finally {
      firstResponse.resolve(jsonResponse({ error: 'cleanup' }, 500))
      secondResponse.resolve(jsonResponse({ error: 'cleanup' }, 500))
      await Promise.allSettled([firstMutation, secondMutation])
    }
  })

  it('retains an optimistic edit while its transport is still queued', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledMessagePatchFetch()
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    dispatchUpdateMessageScoped('m-1', { data: 'first edit' }, currentChatScopedSnapshot())
    await waitForCallCount(calls, 2)
    dispatchUpdateMessageScoped('m-1', { data: 'queued edit' }, currentChatScopedSnapshot())

    expect(calls).toHaveLength(2)
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].message = [{ role: 'char', data: 'before', chatId: 'm-1' }]
    })
    reapplyRetainedChatBodyProjections('chat-a')

    expect(getDatabase().characters[0].chats[0].message[0].data).toBe('queued edit')

    firstResponse.resolve(successfulMessagePatchResponse(11))
    await waitForCallCount(calls, 3)
    secondResponse.resolve(successfulMessagePatchResponse(12))
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].message[0].data).toBe('queued edit')
    })
  })

  it('rolls back a caller-owned pre-applied scoped message patch', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/messages/m-1' && init.method === 'PATCH',
    })
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const previous = currentChatScopedSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].message[0].data = 'pre-applied'
    })

    dispatchUpdateMessageScoped('m-1', { data: 'pre-applied' }, previous, {
      optimisticPatchAlreadyApplied: true,
    })

    await waitForCallCount(calls, 2)
    expect(getDatabase().characters[0].chats[0].message[0].data).toBe('before')
  })

  it('restores the original transcript when overlapping scoped deletes both fail', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url.startsWith('/api/v1/commands/messages/') && init.method === 'DELETE',
    })
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
      { role: 'user', data: 'three', chatId: 'm-3' },
    ]
    seedActiveMessages(previousMessages)
    const firstPrevious = currentChatScopedSnapshot()
    dispatchDeleteMessageScoped('m-1', firstPrevious)
    const secondPrevious = currentChatScopedSnapshot()
    dispatchDeleteMessageScoped('m-2', secondPrevious)

    expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[2]])
    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].message).toEqual(previousMessages)
    })
  })

  it('restores a patched message when a later scoped delete also fails', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) =>
        url === '/api/v1/commands/messages/m-1' && (init.method === 'PATCH' || init.method === 'DELETE'),
    })
    const previousMessages: Message[] = [{ role: 'char', data: 'before', chatId: 'm-1' }]
    seedActiveMessages(previousMessages)
    dispatchUpdateMessageScoped('m-1', { data: 'after' }, currentChatScopedSnapshot())
    dispatchDeleteMessageScoped('m-1', currentChatScopedSnapshot())

    expect(getDatabase().characters[0].chats[0].message).toEqual([])
    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].message).toEqual(previousMessages)
    })
  })

  it('restores a deleted message when a later scoped patch also fails', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) =>
        url.startsWith('/api/v1/commands/messages/') && (init.method === 'PATCH' || init.method === 'DELETE'),
    })
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
    ]
    seedActiveMessages(previousMessages)
    dispatchDeleteMessageScoped('m-1', currentChatScopedSnapshot())
    dispatchUpdateMessageScoped('m-2', { data: 'changed' }, currentChatScopedSnapshot())

    expect(getDatabase().characters[0].chats[0].message).toEqual([{ role: 'char', data: 'changed', chatId: 'm-2' }])
    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].message).toEqual(previousMessages)
    })
  })

  it('preserves a newer unpatched field when a safe patch and later delete both fail', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) =>
        url.startsWith('/api/v1/commands/messages/') && (init.method === 'PATCH' || init.method === 'DELETE'),
    })
    const initialMessages: Message[] = [
      { role: 'user', data: 'before', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
    ]
    seedActiveMessages(initialMessages)
    const stalePatchSnapshot = currentChatScopedSnapshot()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].message[0].data = 'newer'
    })
    dispatchUpdateMessageScoped('m-1', { disabled: true }, stalePatchSnapshot)
    dispatchDeleteMessageScoped('m-2', currentChatScopedSnapshot())

    await waitForCallCount(calls, 3)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].message).toEqual([
        { role: 'user', data: 'newer', chatId: 'm-1' },
        initialMessages[1],
      ])
    })
  })

  it('keeps an accepted scoped delete optimistically applied in its owner', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
    ]
    seedActiveMessages(previousMessages)
    getDatabase().characters[0].chats[0].bookmarks = ['m-1', 'm-2']
    getDatabase().characters[0].chats[0].bookmarkNames = { 'm-1': 'One', 'm-2': 'Two' }
    const previous = currentChatScopedSnapshot()
    const deletion = dispatchDeleteMessageScoped('m-1', previous)

    expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[1]])
    expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['m-2'])
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'm-2': 'Two' })
    await waitForCallCount(calls, 2)
    await expect(deletion).resolves.toEqual({ status: 'accepted' })
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[1]])
    })
    expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['m-2'])
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'm-2': 'Two' })
  })

  it('treats an exact missing-message delete as accepted without restoring a ghost row', async () => {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/messages/m-1' && init.method === 'DELETE') {
          return jsonResponse({ error: 'Message not found: m-1' }, 404)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const previousMessages: Message[] = [
      { role: 'user', data: 'translated', chatId: 'm-1' },
      { role: 'char', data: 'reply', chatId: 'm-2' },
    ]
    seedActiveMessages(previousMessages)
    const deletion = dispatchDeleteMessageScoped('m-1', currentChatScopedSnapshot())
    expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[1]])

    await expect(deletion).resolves.toEqual({ status: 'accepted' })
    await waitForCallCount(calls, 2)
    expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[1]])
  })

  it('keeps a retained scoped delete projected and accepts a later not-found replay idempotently', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-retained-message-delete',
      writerEpoch: 4,
      databaseLineage: 'lineage-retained-message-delete',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    let replaying = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/messages/m-1' && init.method === 'DELETE') {
          return replaying
            ? jsonResponse({ error: 'Message not found: m-1' }, 404)
            : jsonResponse({ error: 'temporarily unavailable' }, 500)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const previousMessages: Message[] = [
      { role: 'user', data: 'translated', chatId: 'm-1' },
      { role: 'char', data: 'reply', chatId: 'm-2' },
    ]
    seedActiveMessages(previousMessages)
    try {
      const queued = await dispatchDeleteMessageScoped('m-1', currentChatScopedSnapshot())
      expect(queued).toMatchObject({ status: 'queued', mutationId: expect.any(String) })
      expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[1]])
      const pending = await listPendingMutations()
      expect(pending).toHaveLength(1)
      expect(queued.status === 'queued' ? queued.mutationId : '').toBe(pending[0].handle.mutationId)

      replaying = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1 })
      if (queued.status !== 'queued') throw new Error('Expected a queued delete')
      await expect(queued.settlement).resolves.toEqual({ status: 'accepted' })
      expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[1]])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('rolls back a retained scoped delete when replay is terminally discarded', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-discarded-message-delete',
      writerEpoch: 5,
      databaseLineage: 'lineage-discarded-message-delete',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    let replaying = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        if (url === '/api/v1/commands/messages/m-1' && init.method === 'DELETE') {
          return replaying
            ? jsonResponse({ error: 'Writer session is stale', reason: 'stale-writer' }, 423)
            : jsonResponse({ error: 'temporarily unavailable' }, 500)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const previousMessages: Message[] = [
      { role: 'user', data: 'translated', chatId: 'm-1' },
      { role: 'char', data: 'reply', chatId: 'm-2' },
    ]
    seedActiveMessages(previousMessages)
    try {
      const queued = await dispatchDeleteMessageScoped('m-1', currentChatScopedSnapshot())
      expect(queued.status).toBe('queued')
      expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[1]])

      replaying = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1 })
      if (queued.status !== 'queued') throw new Error('Expected a queued delete')
      await expect(queued.settlement).resolves.toEqual({ status: 'failed', error: 'Writer session is stale' })
      expect(getDatabase().characters[0].chats[0].message).toEqual(previousMessages)
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('keeps an accepted scoped message update optimistically applied in its owner', async () => {
    const calls = stubMessagePersistenceFetch()
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const previous = currentChatScopedSnapshot()
    dispatchUpdateMessageScoped('m-1', { role: 'user', data: 'after', disabled: true }, previous)

    expect(getDatabase().characters[0].chats[0].message).toEqual([
      { role: 'user', data: 'after', disabled: true, chatId: 'm-1' },
    ])
    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].message).toEqual([
        { role: 'user', data: 'after', disabled: true, chatId: 'm-1' },
      ])
    })
  })

  it('failed empty char append command rolls back the appended message by id', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a/messages' && init.method === 'POST',
    })
    const previousMessages: Message[] = [{ role: 'user', data: 'before', chatId: 'm-1' }]
    seedActiveMessages(previousMessages)

    appendCurrentChatEmptyCharMessage()
    await waitForCallCount(calls, 2)

    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/messages',
      method: 'POST',
      body: {
        baseRevision: 10,
        message: { role: 'char', data: '', chatId: expect.any(String) },
      },
    })
    expect(getDatabase().characters[0].chats[0].message).toEqual(previousMessages)
  })

  it('failed scoped message update restores attempted fields and preserves newer same-chat metadata', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/messages/m-1' && init.method === 'PATCH',
    })
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const previous = currentChatScopedSnapshot()

    getDatabase().characters[0].chats[0].name = 'newer metadata'

    dispatchUpdateMessageScoped('m-1', { data: 'attempted' }, previous)
    expect(getDatabase().characters[0].chats[0].message[0].data).toBe('attempted')
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual([{ role: 'char', data: 'before', chatId: 'm-1' }])
    expect(getDatabase().characters[0].chats[0].name).toBe('newer metadata')
  })

  it('failed scoped message update skips rollback when the message changed again after the attempt', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/messages/m-1' && init.method === 'PATCH',
      onCommand: () => {
        getDatabase().characters[0].chats[0].message[0].data = 'newer edit'
      },
    })
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const previous = currentChatScopedSnapshot()

    dispatchUpdateMessageScoped('m-1', { data: 'attempted' }, previous)
    expect(getDatabase().characters[0].chats[0].message[0].data).toBe('attempted')
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual([{ role: 'char', data: 'newer edit', chatId: 'm-1' }])
  })

  it('scoped message update does not overwrite a field that diverged after its snapshot', async () => {
    const calls = stubMessagePersistenceFetch()
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const previous = currentChatScopedSnapshot()
    getDatabase().characters[0].chats[0].message[0].data = 'newer edit'

    dispatchUpdateMessageScoped('m-1', { data: 'attempted' }, previous)

    expect(getDatabase().characters[0].chats[0].message[0].data).toBe('newer edit')
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([])
    expect(getDatabase().characters[0].chats[0].message[0].data).toBe('newer edit')
  })

  it('scoped message update sends only fields that are still safe to apply', async () => {
    const calls = stubMessagePersistenceFetch()
    seedActiveMessages([{ role: 'char', data: 'before', chatId: 'm-1' }])
    const previous = currentChatScopedSnapshot()
    getDatabase().characters[0].chats[0].message[0].data = 'newer edit'

    dispatchUpdateMessageScoped('m-1', { data: 'attempted', disabled: true }, previous)

    expect(getDatabase().characters[0].chats[0].message[0]).toEqual({
      role: 'char',
      data: 'newer edit',
      disabled: true,
      chatId: 'm-1',
    })
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/messages/m-1',
      method: 'PATCH',
      body: {
        patch: { disabled: true },
      },
    })
  })

  it('failed scoped delete restores the prior message list only when live messages equal the attempted deletion', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/messages/m-1' && init.method === 'DELETE',
    })
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
    ]
    seedActiveMessages(previousMessages)
    getDatabase().characters[0].chats[0].bookmarks = ['m-1', 'm-2']
    getDatabase().characters[0].chats[0].bookmarkNames = { 'm-1': 'One', 'm-2': 'Two' }
    const previous = currentChatScopedSnapshot()

    const deletion = dispatchDeleteMessageScoped('m-1', previous)
    expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[1]])
    expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['m-2'])
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'm-2': 'Two' })
    await waitForCallCount(calls, 2)
    await expect(deletion).resolves.toEqual({ status: 'failed', error: 'nope' })

    expect(getDatabase().characters[0].chats[0].message).toEqual(previousMessages)
    expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['m-1', 'm-2'])
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'm-1': 'One', 'm-2': 'Two' })
  })

  it('failed scoped delete preserves a newer live message list when it changes again before rollback', async () => {
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
    ]
    const newerMessages: Message[] = [
      { role: 'char', data: 'two', chatId: 'm-2' },
      { role: 'user', data: 'newer after delete', chatId: 'm-newer' },
    ]
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/messages/m-1' && init.method === 'DELETE',
      onCommand: () => {
        getDatabase().characters[0].chats[0].message = jsonClone(newerMessages)
      },
    })
    seedActiveMessages(previousMessages)
    const previous = currentChatScopedSnapshot()

    getDatabase().characters[0].chats[0].message = [jsonClone(previousMessages[1])]

    dispatchDeleteMessageScoped('m-1', previous)
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual(newerMessages)
  })

  it('failed scoped truncate restores the prior message list when live messages equal the attempted truncation', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a/messages/truncate' && init.method === 'POST',
    })
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
      { role: 'user', data: 'three', chatId: 'm-3' },
    ]
    seedActiveMessages(previousMessages)
    getDatabase().characters[0].chats[0].bookmarks = ['m-1', 'm-2', 'm-3']
    getDatabase().characters[0].chats[0].bookmarkNames = { 'm-1': 'One', 'm-2': 'Two', 'm-3': 'Three' }
    const previous = currentChatScopedSnapshot()

    const command = dispatchTruncateMessagesScoped('chat-a', 'm-1', previous)
    expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[0]])
    expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['m-1'])
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'm-1': 'One' })
    await command
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual(previousMessages)
    expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['m-1', 'm-2', 'm-3'])
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({
      'm-1': 'One',
      'm-2': 'Two',
      'm-3': 'Three',
    })
  })

  it('keeps only retained bookmarks after an accepted scoped truncation', async () => {
    const calls = stubMessagePersistenceFetch()
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
      { role: 'user', data: 'three', chatId: 'm-3' },
    ]
    seedActiveMessages(previousMessages)
    getDatabase().characters[0].chats[0].bookmarks = ['m-1', 'm-2', 'm-3']
    getDatabase().characters[0].chats[0].bookmarkNames = { 'm-1': 'One', 'm-2': 'Two', 'm-3': 'Three' }

    await dispatchTruncateMessagesScoped('chat-a', 'm-1', currentChatScopedSnapshot())
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual([previousMessages[0]])
    expect(getDatabase().characters[0].chats[0].bookmarks).toEqual(['m-1'])
    expect(getDatabase().characters[0].chats[0].bookmarkNames).toEqual({ 'm-1': 'One' })
  })

  it('failed scoped truncate skips rollback when live messages diverge from the attempted truncation', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a/messages/truncate' && init.method === 'POST',
    })
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
      { role: 'user', data: 'three', chatId: 'm-3' },
    ]
    seedActiveMessages(previousMessages)
    const previous = currentChatScopedSnapshot()

    getDatabase().characters[0].chats[0].message = [
      jsonClone(previousMessages[0]),
      { role: 'char', data: 'newer after truncate', chatId: 'm-newer' },
    ]

    await dispatchTruncateMessagesScoped('chat-a', 'm-1', previous)
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual([
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'newer after truncate', chatId: 'm-newer' },
    ])
  })

  it('failed scoped replace-tail restores messages while preserving newer same-chat metadata', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a/messages/tail' && init.method === 'POST',
    })
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
      { role: 'user', data: 'three', chatId: 'm-3' },
    ]
    const replacementTail: Message[] = [{ role: 'char', data: 'replacement', chatId: 'm-r' }]
    seedActiveMessages(previousMessages)
    const previous = currentChatScopedSnapshot()

    getDatabase().characters[0].chats[0].message = [jsonClone(previousMessages[0]), jsonClone(replacementTail[0])]
    getDatabase().characters[0].chats[0].name = 'newer metadata'

    dispatchReplaceTailMessagesScoped('chat-a', 'm-1', replacementTail, previous)
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual(previousMessages)
    expect(getDatabase().characters[0].chats[0].name).toBe('newer metadata')
  })

  it('failed scoped replace-tail preserves newer live messages and same-chat metadata after divergence', async () => {
    const previousMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
      { role: 'user', data: 'three', chatId: 'm-3' },
    ]
    const replacementTail: Message[] = [{ role: 'char', data: 'replacement', chatId: 'm-r' }]
    const newerMessages: Message[] = [
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'replacement', chatId: 'm-r' },
      { role: 'user', data: 'newer after replace-tail', chatId: 'm-newer' },
    ]
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a/messages/tail' && init.method === 'POST',
      onCommand: () => {
        getDatabase().characters[0].chats[0].message = jsonClone(newerMessages)
        getDatabase().characters[0].chats[0].name = 'newer metadata'
      },
    })
    seedActiveMessages(previousMessages)
    const previous = currentChatScopedSnapshot()

    getDatabase().characters[0].chats[0].message = [jsonClone(previousMessages[0]), jsonClone(replacementTail[0])]

    dispatchReplaceTailMessagesScoped('chat-a', 'm-1', replacementTail, previous)
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual(newerMessages)
    expect(getDatabase().characters[0].chats[0].name).toBe('newer metadata')
  })

  it('failed scoped replace-all skips rollback when live messages diverge from the attempted replacement', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-a/messages' && init.method === 'PUT',
    })
    seedActiveMessages([{ role: 'user', data: 'before', chatId: 'm-1' }])
    const previous = currentChatScopedSnapshot()
    const replacementMessages: Message[] = [{ role: 'char', data: 'replacement', chatId: 'm-r' }]

    getDatabase().characters[0].chats[0].message = [
      jsonClone(replacementMessages[0]),
      { role: 'user', data: 'newer follow-up', chatId: 'm-newer' },
    ]
    getDatabase().characters[0].chats[0].name = 'newer metadata'

    dispatchReplaceMessagesScoped('chat-a', replacementMessages, previous)
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats[0].message).toEqual([
      { role: 'char', data: 'replacement', chatId: 'm-r' },
      { role: 'user', data: 'newer follow-up', chatId: 'm-newer' },
    ])
    expect(getDatabase().characters[0].chats[0].name).toBe('newer metadata')
  })
})

describe('durable chat and folder structure dispatch', () => {
  it('does not rebase a newer transcript attempt when an old generation is discarded', async () => {
    await prepareDurableOutbox('role-cycle-transcript-rebase', true)
    enterClientWriter()
    let discard: 'none' | 'older' | 'both' = 'none'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
        const terminal = discard === 'both' || (discard === 'older' && body.patch?.data === 'Old intent')
        return jsonResponse({ error: terminal ? 'invalid edit' : 'temporarily unavailable' }, terminal ? 400 : 503)
      }),
    )
    const chat = () => getDatabase().characters[0].chats[0]
    withTestDatabaseWrite(() => {
      chat().message = [{ role: 'char', data: 'persisted', chatId: 'message-a' }]
    })
    try {
      const older = await dispatchUpdateMessageScoped('message-a', { data: 'Old intent' }, currentChatScopedSnapshot())
      expect(older?.status).toBe('queued')
      if (older?.status !== 'queued') throw new Error('Expected an older queued mutation')
      demoteClientSession()
      repromoteClientWriter()
      // The authoritative value may happen to equal the old optimistic text.
      withTestDatabaseWrite(() => {
        chat().message = [{ role: 'char', data: 'Old intent', chatId: 'message-a' }]
      })
      const newer = await dispatchUpdateMessageScoped(
        'message-a',
        { name: 'Current writer message name' },
        currentChatScopedSnapshot(),
      )
      expect(newer?.status).toBe('queued')
      if (newer?.status !== 'queued') throw new Error('Expected a newer queued mutation')
      const pending = await listPendingMutations()
      const newerHandle = pending.find(({ handle }) => newer.mutationIds.includes(handle.mutationId))!.handle
      discard = 'older'
      await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1, retained: 1 })
      await expect(older.settlement).resolves.toMatchObject({ status: 'failed' })
      expect(chat().message[0]).toMatchObject({ data: 'Old intent', name: 'Current writer message name' })
      expect((await listPendingMutations()).map(({ handle }) => handle.mutationId)).toEqual([newerHandle.mutationId])
      discard = 'both'
      await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1, retained: 0 })
      await expect(newer.settlement).resolves.toMatchObject({ status: 'failed' })
      expect(chat().message[0].data).toBe('Old intent')
      expect(chat().message[0].name).toBeUndefined()
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearDurableOutbox()
    }
  })

  it('reapplies retained message edits in owner order after transcript hydration', async () => {
    await prepareDurableOutbox('message-patch-refresh')
    let commandCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/messages/message-a' && init.method === 'PATCH') {
          commandCalls += 1
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].message = [
          { role: 'char', data: 'persisted', chatId: 'message-a' } as Message,
        ]
      })
      dispatchUpdateMessageScoped('message-a', { data: 'first retained edit' }, currentChatScopedSnapshot())
      await vi.waitFor(() => expect(commandCalls).toBe(1))
      dispatchUpdateMessageScoped('message-a', { data: 'newest retained edit' }, currentChatScopedSnapshot())
      await vi.waitFor(() => expect(commandCalls).toBe(2))

      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].message = [
          { role: 'char', data: 'persisted', chatId: 'message-a' } as Message,
        ]
      })
      reapplyRetainedChatBodyProjections('chat-a')

      expect(getDatabase().characters[0].chats[0].message[0].data).toBe('newest retained edit')
      expect(await listPendingMutations()).toHaveLength(2)
    } finally {
      await clearDurableOutbox()
    }
  })

  it('retains every compatibility sub-write after the first retryable failure', async () => {
    await prepareDurableOutbox('compatibility')
    const previous = currentChatScopedSnapshot()
    const previousChat = jsonClone(previous.chat!)
    const nextChat = jsonClone(previousChat)
    nextChat.name = 'Compatible durable rename'
    nextChat.message = [{ role: 'user', data: 'compatible append', chatId: 'message-compatible' }]
    nextChat.scriptstate = { $score: 'compatible', $old: 'gone' }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0] = jsonClone(nextChat)
    })

    const commandPaths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const path = url.replace('/api/v1/commands', '')
        commandPaths.push(path)
        return jsonResponse({ error: 'temporarily unavailable' }, 503)
      }) as unknown as typeof fetch,
    )

    try {
      dispatchCompatibleChatUpdateScoped(previousChat, nextChat, previous)
      await vi.waitFor(() => expect(commandPaths).toEqual(['/chats/chat-a']))

      expect(getDatabase().characters[0].chats[0]).toMatchObject({
        name: 'Compatible durable rename',
        message: [{ role: 'user', data: 'compatible append', chatId: 'message-compatible' }],
        scriptstate: { $score: 'compatible', $old: 'gone' },
      })
      const pending = await listPendingMutations()
      expect(pending.map((entry) => entry.handle.key)).toEqual([
        'character-owner:char-a',
        'character-owner:char-a',
        'character-owner:char-a',
      ])
      expect(pending.map((entry) => entry.intent.requests[0])).toEqual([
        {
          method: 'PATCH',
          path: '/chats/chat-a',
          body: { patch: { name: 'Compatible durable rename' }, select: false },
        },
        {
          method: 'POST',
          path: '/chats/chat-a/messages',
          body: {
            message: { role: 'user', data: 'compatible append', chatId: 'message-compatible' },
          },
        },
        {
          method: 'PATCH',
          path: '/chats/chat-a/scriptstate',
          body: { patch: { $score: 'compatible' }, deleteKeys: [] },
        },
      ])
    } finally {
      await clearDurableOutbox()
    }
  })

  it('keeps an accepted compatibility prefix and rolls back only unaccepted sub-writes', async () => {
    await prepareDurableOutbox('compatibility-terminal')
    const previous = currentChatScopedSnapshot()
    const previousChat = jsonClone(previous.chat!)
    const nextChat = jsonClone(previousChat)
    nextChat.name = 'Accepted compatible rename'
    nextChat.message = [{ role: 'user', data: 'rejected append', chatId: 'message-rejected' }]
    nextChat.scriptstate = { $score: 'unaccepted scriptstate', $old: 'gone' }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0] = jsonClone(nextChat)
    })

    const commandPaths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const path = url.replace('/api/v1/commands', '')
        if (path === '/chats/chat-a') {
          commandPaths.push(path)
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
        if (path === '/chats/chat-a/messages') {
          commandPaths.push(path)
          return jsonResponse({ error: 'invalid message append' }, 400)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      dispatchCompatibleChatUpdateScoped(previousChat, nextChat, previous)
      await vi.waitFor(() => expect(commandPaths).toEqual(['/chats/chat-a', '/chats/chat-a/messages']))
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))

      expect(getDatabase().characters[0].chats[0]).toMatchObject({
        name: 'Accepted compatible rename',
        message: [],
        scriptstate: { $score: '1', $old: 'gone' },
      })
    } finally {
      await clearDurableOutbox()
    }
  })
})
