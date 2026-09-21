import { makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createAndSelectCharacterCommand,
  createCharacterCommand,
  deleteCharacterCommand,
  reorderCharactersCommand,
  selectCharacterCommand,
  updateCharacterCommand,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
} from './commands'
import { captureDestructiveRefreshEpoch, createDestructiveRefreshToken } from './staleStateGuards'

describe('character command adapters', () => {
  it('strips embedded chats from character create command payloads without mutating input', async () => {
    const commandFetch = makeCommandFetch((url) => ({
      revision: url.endsWith('/create-and-select') ? 3 : 2,
      event: {
        type: url.endsWith('/create-and-select') ? 'character.createdAndSelected' : 'character.created',
        revision: url.endsWith('/create-and-select') ? 3 : 2,
        resource: 'character',
        id: url.endsWith('/create-and-select') ? 'char-selected' : 'char-created',
      },
      characterId: url.endsWith('/create-and-select') ? 'char-selected' : 'char-created',
      selectedCharacterId: url.endsWith('/create-and-select') ? 'char-selected' : null,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const createChat = {
      id: 'chat-created',
      name: 'Starter',
      message: [{ role: 'user', data: 'hello' }],
    }
    const createCharacter = {
      chaId: 'char-created',
      name: 'Created',
      chatPage: 0,
      chats: [createChat],
    }
    const selectChat = {
      id: 'chat-selected',
      name: 'Starter',
      message: [{ role: 'char', data: 'hi' }],
    }
    const selectCharacter = {
      chaId: 'char-selected',
      name: 'Selected',
      chatPage: 0,
      chats: [selectChat],
    }
    const initialChat = {
      id: 'chat-initial',
      name: 'Chat 1',
      note: '',
      message: [],
      localLore: [],
    }

    await expect(
      createCharacterCommand({
        baseRevision: 1,
        character: createCharacter,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, characterId: 'char-created' })

    await expect(
      createAndSelectCharacterCommand({
        baseRevision: 2,
        character: selectCharacter,
        lastInteraction: 1234,
        initialChat,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, characterId: 'char-selected' })

    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      {
        baseRevision: 1,
        character: {
          chaId: 'char-created',
          name: 'Created',
          chatPage: 0,
        },
      },
      {
        baseRevision: 2,
        character: {
          chaId: 'char-selected',
          name: 'Selected',
          chatPage: 0,
        },
        lastInteraction: 1234,
        initialChat,
      },
    ])
    expect(createCharacter.chats).toEqual([createChat])
    expect(selectCharacter.chats).toEqual([selectChat])
  })

  it('exposes exact character collection acknowledgements as compact local effects', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url, init) => {
      if (url.endsWith('/create-and-select')) {
        return {
          revision: 3,
          event: {
            type: 'character.createdAndSelected',
            revision: 3,
            resource: 'character',
            id: 'char-selected',
          },
          characterId: 'char-selected',
          selectedCharacterId: 'char-selected',
        }
      }
      if (init.method === 'DELETE') {
        return {
          revision: 4,
          event: { type: 'character.deleted', revision: 4, resource: 'character', id: 'char-deleted' },
          characterId: 'char-deleted',
          selectedCharacterId: 'char-created',
        }
      }
      const characterId = (JSON.parse(String(init.body)) as { character: { chaId: string } }).character.chaId
      return {
        revision: characterId === 'char-mismatched' ? 5 : 2,
        event: {
          type: 'character.created',
          revision: characterId === 'char-mismatched' ? 5 : 2,
          resource: 'character',
          id: characterId,
          ...(characterId === 'char-mismatched' ? { parentId: 'unexpected-parent' } : {}),
        },
        characterId,
        selectedCharacterId: null,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createCharacterCommand({ baseRevision: 1, character: { chaId: 'char-created' } })
    await createAndSelectCharacterCommand({
      baseRevision: 2,
      character: { chaId: 'char-selected' },
      lastInteraction: 100,
    })
    await deleteCharacterCommand({ baseRevision: 3, characterId: 'char-deleted' })
    await createCharacterCommand({ baseRevision: 4, character: { chaId: 'char-mismatched' } })

    expect(observedEffects).toEqual([
      {
        kind: 'characterCollectionMutation',
        operation: 'create',
        characterId: 'char-created',
        selectedCharacterId: null,
      },
      {
        kind: 'characterCollectionMutation',
        operation: 'createAndSelect',
        characterId: 'char-selected',
        selectedCharacterId: 'char-selected',
      },
      {
        kind: 'characterCollectionMutation',
        operation: 'delete',
        characterId: 'char-deleted',
        selectedCharacterId: 'char-created',
      },
    ])
  })

  it('dispatches character commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/characters/reorder')) {
        return {
          revision: 6,
          event: { type: 'character.reordered', revision: 6, resource: 'character' },
          selectedCharacterId: 'char-a',
        }
      }
      if (url.endsWith('/characters/select')) {
        return {
          revision: 5,
          event: {
            type: 'character.selected',
            revision: 5,
            resource: 'characterSelection',
            id: 'char-a',
          },
          characterId: 'char-a',
        }
      }
      if (url.endsWith('/characters/create-and-select')) {
        return {
          revision: 7,
          event: {
            type: 'character.createdAndSelected',
            revision: 7,
            resource: 'character',
            id: 'char-c',
          },
          characterId: 'char-c',
          selectedCharacterId: 'char-c',
        }
      }
      if (url.endsWith('/characters/char-b')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'DELETE'
          ? {
              revision: 4,
              event: {
                type: 'character.deleted',
                revision: 4,
                resource: 'character',
                id: 'char-b',
              },
              characterId: 'char-b',
              selectedCharacterId: 'char-a',
            }
          : {
              revision: 3,
              event: {
                type: 'character.updated',
                revision: 3,
                resource: 'character',
                id: 'char-b',
              },
              characterId: 'char-b',
            }
      }
      return {
        revision: 2,
        event: { type: 'character.created', revision: 2, resource: 'character', id: 'char-b' },
        characterId: 'char-b',
        selectedCharacterId: 'char-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createCharacterCommand({
        baseRevision: 1,
        character: { chaId: 'char-b', name: 'B' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, characterId: 'char-b' })

    await expect(
      updateCharacterCommand({
        baseRevision: 2,
        characterId: 'char-b',
        patch: {
          name: 'B renamed',
          image: 'a'.repeat(64),
          systemPrompt: 'new system prompt',
          ttsMode: 'openai',
          oaiTTSConfig: { enabled: true, voice: 'alloy', model: 'tts-1', format: 'mp3' },
          depth_prompt: { depth: 2, prompt: 'stay close' },
        },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, characterId: 'char-b' })

    await expect(
      deleteCharacterCommand({
        baseRevision: 3,
        characterId: 'char-b',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 4,
      characterId: 'char-b',
      selectedCharacterId: 'char-a',
    })

    await expect(
      selectCharacterCommand({
        baseRevision: 4,
        characterId: 'char-a',
        lastInteraction: 1234,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, characterId: 'char-a' })

    await expect(
      reorderCharactersCommand({
        baseRevision: 5,
        characterOrder: [{ id: 'folder-a', name: 'Folder', color: '', data: ['char-a'] }],
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 6,
      selectedCharacterId: 'char-a',
    })

    await expect(
      createAndSelectCharacterCommand({
        baseRevision: 6,
        character: { chaId: 'char-c', name: 'C' },
        lastInteraction: 5678,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, characterId: 'char-c' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters',
        method: 'POST',
        body: {
          baseRevision: 1,
          character: { chaId: 'char-b', name: 'B' },
        },
      },
      {
        url: '/api/v1/commands/characters/char-b',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: {
            name: 'B renamed',
            image: 'a'.repeat(64),
            systemPrompt: 'new system prompt',
            ttsMode: 'openai',
            oaiTTSConfig: { enabled: true, voice: 'alloy', model: 'tts-1', format: 'mp3' },
            depth_prompt: { depth: 2, prompt: 'stay close' },
          },
        },
      },
      {
        url: '/api/v1/commands/characters/char-b',
        method: 'DELETE',
        body: {
          baseRevision: 3,
        },
      },
      {
        url: '/api/v1/commands/characters/select',
        method: 'POST',
        body: {
          baseRevision: 4,
          characterId: 'char-a',
          lastInteraction: 1234,
        },
      },
      {
        url: '/api/v1/commands/characters/reorder',
        method: 'POST',
        body: {
          baseRevision: 5,
          characterOrder: [{ id: 'folder-a', name: 'Folder', color: '', data: ['char-a'] }],
        },
      },
      {
        url: '/api/v1/commands/characters/create-and-select',
        method: 'POST',
        body: {
          baseRevision: 6,
          character: { chaId: 'char-c', name: 'C' },
          lastInteraction: 5678,
        },
      },
    ])
  })

  it('exposes an exact character reorder as a local revision fence', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const event = { type: 'character.reordered', revision: 6, resource: 'characterOrder' }
    const commandFetch = makeCommandFetch(() => ({ revision: 6, event, selectedCharacterId: 'char-a' }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const attemptedOrder = [{ id: 'folder-a', name: 'Folder', color: '', data: ['char-a'] }]

    await reorderCharactersCommand({ baseRevision: 5, characterOrder: attemptedOrder })

    expect(observedEffects).toEqual([{ kind: 'characterOrder', attemptedOrder }])
  })

  it('reports an accepted character-row patch as a local command effect', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'character.updated',
        revision: 3,
        resource: 'characterRow',
        id: 'char-b',
      },
      characterId: 'char-b',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      updateCharacterCommand({
        baseRevision: 2,
        characterId: 'char-b',
        patch: { name: 'B renamed' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, characterId: 'char-b' })

    expect(observedEffects).toEqual([
      {
        kind: 'characterPatch',
        characterId: 'char-b',
        patch: { name: 'B renamed' },
      },
    ])
  })

  it('captures the destructive-refresh epoch before a local-effect command request', async () => {
    const requestEpoch = captureDestructiveRefreshEpoch()
    let observedEffect: ServerCommandLocalEffect | undefined
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffect = [...localEffects.values()][0]
    })
    const commandFetch = makeCommandFetch(() => {
      createDestructiveRefreshToken('character-patch-in-flight-refresh')
      return {
        revision: 3,
        event: {
          type: 'character.updated',
          revision: 3,
          resource: 'characterRow',
          id: 'char-b',
        },
        characterId: 'char-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await updateCharacterCommand({
      baseRevision: 2,
      characterId: 'char-b',
      patch: { name: 'B renamed' },
    })

    expect(observedEffect?.destructiveRefreshEpoch).toBe(requestEpoch)
    expect(Object.keys(observedEffect ?? {})).not.toContain('destructiveRefreshEpoch')
  })

  it('reports an accepted character selection as a local command effect', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 4,
      event: {
        type: 'character.selected',
        revision: 4,
        resource: 'characterSelection',
        id: 'char-b',
      },
      characterId: 'char-b',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      selectCharacterCommand({
        baseRevision: 3,
        characterId: 'char-b',
        lastInteraction: 1234,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, characterId: 'char-b' })

    expect(observedEffects).toEqual([
      {
        kind: 'characterSelection',
        characterId: 'char-b',
        lastInteraction: 1234,
      },
    ])
  })
})
