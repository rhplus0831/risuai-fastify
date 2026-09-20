import { setupBootstrapTests, bootstrapMocks } from './bootstrap.testSupport'
import { describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { loadWebInitialDatabase } from './bootstrap'
import { peekAppliedServerResourceRevision } from './server/commands'
import {
  applyCharacterResource,
  captureChatBodyProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  markChatBodyProjectionApplied,
} from './server/resourceState.svelte'
import { captureDestructiveRefreshEpoch, createDestructiveRefreshToken } from './server/staleStateGuards'
import { selectedCharID } from './stores.svelte'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const { resourceApi, commandApi, hydrationApi, occupancyApi } = bootstrapMocks

setupBootstrapTests()

describe('API-backed client bootstrap', () => {
  it('acknowledges contiguous optimistic character definitions without reading the row', async () => {
    await loadWebInitialDatabase()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].customscript = [{ id: 'script-newer', out: 'newer' }] as never
      getDatabase().characters[0].triggerscript = [{ id: 'trigger-newer', comment: 'newer' }] as never
    })
    const scriptsEvent = {
      type: 'scriptDefinitions.replaced',
      revision: 6,
      resource: 'characterRow',
      id: 'char-a',
    }
    const triggersEvent = {
      type: 'triggerDefinitions.replaced',
      revision: 7,
      resource: 'characterRow',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      triggersEvent,
      [scriptsEvent, triggersEvent],
      new Map([
        [
          6,
          {
            kind: 'characterDefinitionMutation',
            operation: 'scripts',
            characterId: 'char-a',
            optimisticRowEpoch,
          },
        ],
        [
          7,
          {
            kind: 'characterDefinitionMutation',
            operation: 'triggers',
            characterId: 'char-a',
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].customscript).toEqual([{ id: 'script-newer', out: 'newer' }])
    expect(getDatabase().characters[0].triggerscript).toEqual([{ id: 'trigger-newer', comment: 'newer' }])
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('falls back when a character row changes before a definition acknowledgement', async () => {
    await loadWebInitialDatabase()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    const authoritativeCharacter = JSON.parse(JSON.stringify(getDatabase().characters[0]))
    authoritativeCharacter.customscript = [{ id: 'script-authoritative', out: 'server' }]
    applyCharacterResource({ revision: 6, character: authoritativeCharacter })
    const event = {
      type: 'scriptDefinitions.replaced',
      revision: 6,
      resource: 'characterRow',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterDefinitionMutation',
            operation: 'scripts',
            characterId: 'char-a',
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('applies a contiguous canonical message translation without fetching the transcript', async () => {
    await loadWebInitialDatabase()
    occupancyApi.recover.mockClear()
    const translation = {
      source: 'raw',
      text: 'translated',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const event = {
      type: 'message.updated',
      revision: 6,
      resource: 'message',
      id: 'message-a',
      parentId: 'chat-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'messageTranslation',
            chatId: 'chat-a',
            messageId: 'message-a',
            translation,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(hydrationApi.applyMessageTranslationLocalEffect).toHaveBeenCalledWith('chat-a', 'message-a', translation)
    expect(peekAppliedServerResourceRevision()).toBe(6)
    expect(occupancyApi.recover).toHaveBeenCalledExactlyOnceWith({ refresh: true })
  })

  it('acknowledges a contiguous optimistic message append without fetching the transcript', async () => {
    await loadWebInitialDatabase()
    const chatBodyProjectionEpoch = captureChatBodyProjectionEpoch('chat-a')
    const event = {
      type: 'message.appended',
      revision: 6,
      resource: 'message',
      id: 'message-a',
      parentId: 'chat-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'messageMutation',
            operation: 'append',
            chatId: 'chat-a',
            messageId: 'message-a',
            chatBodyProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(hydrationApi.acknowledgeMessageMutationLocalEffect).toHaveBeenCalledWith('chat-a')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('authoritatively rereads a message mutation after a deferred stale chat read replaces its optimism', async () => {
    await loadWebInitialDatabase()
    const chatBodyProjectionEpoch = captureChatBodyProjectionEpoch('chat-a')
    const event = {
      type: 'message.updated',
      revision: 6,
      resource: 'message',
      id: 'message-a',
      parentId: 'chat-a',
    }

    // Model a chat read that began after the optimistic edit and applied its
    // pre-command response before the accepted command is acknowledged.
    markChatBodyProjectionApplied('chat-a')

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'messageMutation',
            operation: 'update',
            chatId: 'chat-a',
            messageId: 'message-a',
            chatBodyProjectionEpoch,
          },
        ],
      ]),
    )

    expect(hydrationApi.acknowledgeMessageMutationLocalEffect).not.toHaveBeenCalled()
    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges contiguous optimistic chat structure mutations without row or transcript reads', async () => {
    await loadWebInitialDatabase()
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats.unshift(
        { id: 'chat-created', message: [{ role: 'user', data: 'created', chatId: 'message-created' }] } as never,
        { id: 'chat-forked', message: [] } as never,
      )
    })
    const effects = [
      {
        event: {
          type: 'chat.created',
          revision: 6,
          resource: 'chatTranscript',
          id: 'chat-created',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'create',
          characterId: 'char-a',
          targetId: 'chat-created',
          optimisticEpoch,
          optimisticRowEpoch,
          attemptedGenerationSettings: null,
          generationSettings: null,
        },
      },
      {
        event: {
          type: 'chat.forked',
          revision: 7,
          resource: 'chatTranscript',
          id: 'chat-forked',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'fork',
          characterId: 'char-a',
          targetId: 'chat-forked',
          optimisticEpoch,
          optimisticRowEpoch,
          attemptedGenerationSettings: null,
          generationSettings: { configured: true, jailbreakToggle: false },
        },
      },
      {
        event: { type: 'chat.reordered', revision: 8, resource: 'characterRow', parentId: 'char-a' },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'reorder',
          characterId: 'char-a',
          attemptedIds: ['chat-forked', 'chat-created', 'chat-a'],
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
      {
        event: {
          type: 'chatFolder.created',
          revision: 9,
          resource: 'characterRow',
          id: 'folder-a',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'folderCreate',
          characterId: 'char-a',
          targetId: 'folder-a',
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
      {
        event: {
          type: 'chatFolder.deleted',
          revision: 10,
          resource: 'characterRow',
          id: 'folder-a',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'folderDelete',
          characterId: 'char-a',
          targetId: 'folder-a',
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
      {
        event: { type: 'chatFolder.reordered', revision: 11, resource: 'characterRow', parentId: 'char-a' },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'folderReorder',
          characterId: 'char-a',
          attemptedIds: [],
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
      {
        event: {
          type: 'chat.deleted',
          revision: 12,
          resource: 'characterRow',
          id: 'chat-deleted',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'delete',
          characterId: 'char-a',
          targetId: 'chat-deleted',
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
    ] as const

    await commandApi.reconciler?.(
      effects.at(-1)!.event,
      effects.map(({ event }) => event),
      new Map(effects.map(({ event, effect }) => [event.revision, effect])),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(hydrationApi.acknowledgeCreatedChatTranscriptLocalEffect).toHaveBeenCalledTimes(2)
    expect(hydrationApi.acknowledgeCreatedChatTranscriptLocalEffect).toHaveBeenNthCalledWith(1, 'chat-created')
    expect(hydrationApi.acknowledgeCreatedChatTranscriptLocalEffect).toHaveBeenNthCalledWith(2, 'chat-forked')
    expect(hydrationApi.invalidateChatHydration).toHaveBeenCalledWith('chat-deleted')
    expect(getDatabase().characters[0].chats.find((chat) => chat.id === 'chat-forked')?.generationSettings).toEqual({
      configured: true,
      jailbreakToggle: false,
    })
    expect(peekAppliedServerResourceRevision()).toBe(12)
  })

  it('keeps malformed chat structure effects on authoritative reconciliation', async () => {
    await loadWebInitialDatabase()
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    const event = {
      type: 'chat.reordered',
      revision: 6,
      resource: 'characterRow',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'chatStructureMutation',
            operation: 'reorder',
            characterId: 'char-a',
            attemptedIds: ['chat-a', 'chat-a'],
            optimisticEpoch,
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('does not fence a structural effect after a full projection refresh', async () => {
    await loadWebInitialDatabase()
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    createDestructiveRefreshToken('chat-structure-bootstrap-test-refresh')
    const event = {
      type: 'chat.reordered',
      revision: 6,
      resource: 'characterRow',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'chatStructureMutation',
            operation: 'reorder',
            characterId: 'char-a',
            attemptedIds: ['chat-a'],
            optimisticEpoch,
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('rereads an accepted character patch erased by an in-flight full refresh', async () => {
    await loadWebInitialDatabase()
    const destructiveRefreshEpoch = captureDestructiveRefreshEpoch()
    createDestructiveRefreshToken('character-patch-bootstrap-test-refresh')
    const event = {
      type: 'character.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterPatch',
            characterId: 'char-a',
            patch: { name: 'accepted optimistic name' },
            destructiveRefreshEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('does not fence a structural effect after a targeted character refresh', async () => {
    await loadWebInitialDatabase()
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    expect(
      applyCharacterResource({
        revision: 5,
        character: JSON.parse(JSON.stringify(getDatabase().characters[0])),
      }),
    ).toBe(true)
    const event = {
      type: 'chat.reordered',
      revision: 6,
      resource: 'characterRow',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'chatStructureMutation',
            operation: 'reorder',
            characterId: 'char-a',
            attemptedIds: ['chat-a'],
            optimisticEpoch,
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges a contiguous character patch without a resource read and preserves a newer edit', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].name = 'Newer queued edit'
    })
    const event = {
      type: 'character.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterPatch',
            characterId: 'char-a',
            patch: { name: 'Accepted edit' },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].name).toBe('Newer queued edit')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges contiguous optimistic character collection mutations without a collection read', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters.push({ chaId: 'char-c', name: 'Cora', chats: [] } as never)
      getDatabase().characters.push({ chaId: 'char-d', name: 'Dara', chats: [] } as never)
      getDatabase().characters.splice(1, 1)
      getDatabase().characterOrder = ['char-d', 'char-c', 'char-a']
      ;(getDatabase() as unknown as { currentChar: number }).currentChar = 0
    })
    selectedCharID.set(0)
    const created = {
      type: 'character.created',
      revision: 6,
      resource: 'character',
      id: 'char-c',
    }
    const createdAndSelected = {
      type: 'character.createdAndSelected',
      revision: 7,
      resource: 'character',
      id: 'char-d',
    }
    const deleted = {
      type: 'character.deleted',
      revision: 8,
      resource: 'character',
      id: 'char-b',
    }

    await commandApi.reconciler?.(
      deleted,
      [created, createdAndSelected, deleted],
      new Map([
        [
          6,
          {
            kind: 'characterCollectionMutation',
            operation: 'create',
            characterId: 'char-c',
            selectedCharacterId: 'char-b',
          },
        ],
        [
          7,
          {
            kind: 'characterCollectionMutation',
            operation: 'createAndSelect',
            characterId: 'char-d',
            selectedCharacterId: 'char-d',
          },
        ],
        [
          8,
          {
            kind: 'characterCollectionMutation',
            operation: 'delete',
            characterId: 'char-b',
            selectedCharacterId: 'char-d',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters.map((candidate) => candidate.chaId)).toEqual(['char-a', 'char-c', 'char-d'])
    expect(getDatabase().characterOrder).toEqual(['char-d', 'char-c', 'char-a'])
    expect((getDatabase() as unknown as { currentChar: number }).currentChar).toBe(0)
    expect(get(selectedCharID)).toBe(0)
    expect(peekAppliedServerResourceRevision()).toBe(8)
  })

  it('keeps unsafe character collection effects on authoritative reconciliation', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters.push({ chaId: 'char-c', name: 'Cora', chats: [] } as never)
    })
    const event = {
      type: 'character.created',
      revision: 6,
      resource: 'character',
      id: 'char-c',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterCollectionMutation',
            operation: 'create',
            characterId: 'char-c',
            selectedCharacterId: 'char-b',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('keeps foreign character collection events on authoritative reconciliation', async () => {
    await loadWebInitialDatabase()
    const event = {
      type: 'character.created',
      revision: 6,
      resource: 'character',
      id: 'char-foreign',
    }

    await commandApi.reconciler?.(event, [event], new Map())

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('does not apply a character collection effect across a revision gap', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters.push({ chaId: 'char-c', name: 'Cora', chats: [] } as never)
      getDatabase().characterOrder = ['char-a', 'char-b', 'char-c']
    })
    const event = {
      type: 'character.created',
      revision: 7,
      resource: 'character',
      id: 'char-c',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          7,
          {
            kind: 'characterCollectionMutation',
            operation: 'create',
            characterId: 'char-c',
            selectedCharacterId: 'char-b',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('fences contiguous nested character and order writes without resource reads', async () => {
    await loadWebInitialDatabase()
    const rowEvent = {
      type: 'chat.scriptstate.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }
    const orderEvent = {
      type: 'character.reordered',
      revision: 7,
      resource: 'characterOrder',
    }

    await commandApi.reconciler?.(
      orderEvent,
      [rowEvent, orderEvent],
      new Map([
        [
          6,
          {
            kind: 'characterRowMutation',
            operation: 'chatScriptstate',
            characterId: 'char-a',
            targetId: 'chat-a',
          },
        ],
        [7, { kind: 'characterOrder', attemptedOrder: ['char-a', 'char-b'] }],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('acknowledges a contiguous character selection without replacing a newer selection', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].lastInteraction = 200
    })
    const event = {
      type: 'character.selected',
      revision: 6,
      resource: 'characterSelection',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterSelection',
            characterId: 'char-a',
            lastInteraction: 100,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect((getDatabase() as unknown as { currentChar: number }).currentChar).toBe(1)
    expect(getDatabase().characters[0].lastInteraction).toBe(200)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges a contiguous chat selection without replacing a newer selection', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats.push({ id: 'chat-newer', message: [] } as never)
      getDatabase().characters[0].chatPage = 1
    })
    const event = {
      type: 'chat.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'chatPatch',
            characterId: 'char-a',
            chatId: 'chat-a',
            patch: {},
            select: true,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].chatPage).toBe(1)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })
})
