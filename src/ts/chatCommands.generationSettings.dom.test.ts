import {
  setupChatCommandTests,
  type CapturedFetch,
  jsonResponse,
  type Deferred,
  createDeferred,
  stubCommandFetch,
  waitForCallCount,
  jsonClone,
  writerAccessMocks,
} from './chatCommands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
} from './server/commands'
import { applyCharacterResource, replaceResourceDatabase as setDatabaseLite } from './server/resourceState.svelte'
// Import the heavy database module AFTER stores.svelte: importing it first
// triggers a circular-import TDZ when the reactive moduleUpdate $effect runs
// mid-init.
import { mergeServerResourceCharacterRow } from './storage/database.svelte'
import {
  currentChatStateSnapshot,
  dispatchSaveChatGenerationSettings,
  dispatchSaveChatGenerationSettingsWithOutcome,
  dispatchUpdateChat,
  waitForPendingChatGenerationSettingsSave,
} from './chatCommands'
import {
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
} from './server/pendingMutationOutbox'
import { replayPendingMutations } from './server/pendingMutationReplay'
import { PERSONA_SELECTION_MUTATION_KEY } from './server/personaMutationKeys'
import { language } from '../lang'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

setupChatCommandTests()

function stubControlledChatGenerationSettingsFetch(): {
  calls: CapturedFetch[]
  firstResponse: Deferred<Response>
  secondResponse: Deferred<Response>
} {
  const calls: CapturedFetch[] = []
  const firstResponse = createDeferred<Response>()
  const secondResponse = createDeferred<Response>()
  let generationSettingsCallCount = 0
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
      if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
        generationSettingsCallCount += 1
        if (generationSettingsCallCount === 1) return firstResponse.promise
        if (generationSettingsCallCount === 2) return secondResponse.promise
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return { calls, firstResponse, secondResponse }
}

function successfulChatGenerationSettingsResponse(
  revision: number,
  generationSettings: Record<string, unknown>,
): Response {
  return jsonResponse({
    revision,
    event: {
      type: 'chat.updated',
      revision,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    },
    chatId: 'chat-a',
    characterId: 'char-a',
    generationSettings,
  })
}

describe('chat command projection helpers', () => {
  it('does not apply chat generation settings locally after writer access is lost', async () => {
    writerAccessMocks.lost = true

    const operation = dispatchSaveChatGenerationSettingsWithOutcome('chat-a', {
      configured: true,
      jailbreakToggle: false,
      sidebarToggles: {},
    })

    await expect(operation?.settlement).resolves.toEqual({
      status: 'failed',
      error: language.writerAccessLostMutation,
    })
    expect(getDatabase().characters[0].chats[0].generationSettings).toBeUndefined()
    expect(writerAccessMocks.report).toHaveBeenCalledOnce()
  })

  it('saves chat generation settings through the dedicated command helper', async () => {
    const calls = stubCommandFetch()
    const generationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: '0',
        notes: '',
      },
    }

    const operation = dispatchSaveChatGenerationSettingsWithOutcome('chat-a', generationSettings)
    expect(operation).not.toBeNull()
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettings)

    await waitForCallCount(calls, 2)
    expect(calls).toEqual([
      {
        url: '/api/v1/bootstrap',
        method: 'GET',
        authHeader: 'chat-command-token',
        body: null,
      },
      {
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        method: 'PUT',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: 10,
          baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          patch: generationSettings,
        },
      },
    ])
    await expect(operation!.settlement).resolves.toEqual({ status: 'accepted' })
  })

  it('reserves a generation-settings save before a synchronously dispatched structural command', async () => {
    const settingsResponse = createDeferred<Response>()
    const commandUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        commandUrls.push(url)
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') return settingsResponse.promise
        if (url === '/api/v1/commands/chats/chat-a' && init.method === 'PATCH') {
          return jsonResponse({
            revision: 12,
            event: {
              type: 'chat.updated',
              revision: 12,
              resource: 'characterRow',
              id: 'chat-a',
              parentId: 'char-a',
            },
            chatId: 'chat-a',
            characterId: 'char-a',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const generationSettings = {
      configured: true,
      personaId: 'persona-a',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'queued first' },
    }

    expect(dispatchSaveChatGenerationSettings('chat-a', generationSettings)).toBe(true)
    dispatchUpdateChat('chat-a', { name: 'Later rename' }, currentChatStateSnapshot())

    await vi.waitFor(() => expect(commandUrls).toEqual(['/api/v1/commands/chats/chat-a/generation-settings']))
    settingsResponse.resolve(successfulChatGenerationSettingsResponse(11, generationSettings))
    await vi.waitFor(() =>
      expect(commandUrls).toEqual([
        '/api/v1/commands/chats/chat-a/generation-settings',
        '/api/v1/commands/chats/chat-a',
      ]),
    )
    await waitForPendingChatGenerationSettingsSave('chat-a')
  })

  it('persists the exact live chat generation-settings request before sending it', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-generation',
      writerEpoch: 7,
      databaseLineage: 'lineage-chat-generation',
      requestedWriterWasActive: true,
    })
    const initial = {
      configured: true,
      personaId: 'persona-a',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'before' },
    }
    const attempted = {
      ...initial,
      sidebarToggles: { notes: 'durable' },
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })
    const response = createDeferred<Response>()
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
        calls.push({ url, body, headers: init.headers as Record<string, string> })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') return response.promise
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      expect(dispatchSaveChatGenerationSettings('chat-a', attempted)).toBe(true)
      await vi.waitFor(() =>
        expect(calls.some((call) => call.url === '/api/v1/commands/chats/chat-a/generation-settings')).toBe(true),
      )
      const command = calls.find((call) => call.url === '/api/v1/commands/chats/chat-a/generation-settings')!
      const { baseRevision: _baseRevision, ...durableBody } = command.body
      expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([
        {
          version: 1,
          dependencyKeys: ['persona:selection', 'settings:bridge', 'persona-profile:persona-a'],
          requests: [
            {
              method: 'PUT',
              path: '/chats/chat-a/generation-settings',
              body: durableBody,
            },
          ],
        },
      ])
      expect(command.headers['risu-mutation-id']).toMatch(/^[a-zA-Z0-9._:-]+$/)
      expect(command.headers['risu-database-lineage']).toBe('lineage-chat-generation')

      const patch = command.body.patch as Record<string, unknown>
      response.resolve(
        jsonResponse({
          revision: 11,
          event: {
            type: 'chat.updated',
            revision: 11,
            resource: 'characterRow',
            id: 'chat-a',
            parentId: 'char-a',
          },
          chatId: 'chat-a',
          characterId: 'char-a',
          certificate: 'chat-generation-settings-sparse-v1',
          patchedKeys: Object.keys(patch).sort(),
          deletedKeys: [],
          sidebarTogglePatchedKeys: Object.keys((patch.sidebarToggles as Record<string, unknown>) ?? {}).sort(),
          sidebarToggleDeletedKeys: [],
          prunedSidebarToggleKeys: [],
        }),
      )
      await waitForPendingChatGenerationSettingsSave('chat-a')
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('persists a queued generation-settings edit while the earlier save is still in flight', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-generation-queue',
      writerEpoch: 8,
      databaseLineage: 'lineage-chat-generation-queue',
      requestedWriterWasActive: true,
    })
    const initial = {
      configured: true,
      personaId: 'persona-initial',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'before' },
    }
    const firstTarget = { ...initial, personaId: 'persona-first' }
    const secondTarget = {
      ...firstTarget,
      sidebarToggles: { notes: 'queued' },
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })
    const firstResponse = createDeferred<Response>()
    const secondResponse = createDeferred<Response>()
    const commandCalls: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
          commandCalls.push(typeof init.body === 'string' ? JSON.parse(init.body) : {})
          return commandCalls.length === 1 ? firstResponse.promise : secondResponse.promise
        }
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      expect(dispatchSaveChatGenerationSettings('chat-a', firstTarget)).toBe(true)
      await vi.waitFor(() => expect(commandCalls).toHaveLength(1))
      expect(dispatchSaveChatGenerationSettings('chat-a', secondTarget)).toBe(true)

      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(2))
      const pending = await listPendingMutations()
      expect(pending.map((entry) => entry.handle.key)).toEqual(['character-owner:char-a', 'character-owner:char-a'])
      expect(pending[0].handle.mutationId).not.toBe(pending[1].handle.mutationId)
      expect(pending[1].intent).toEqual({
        version: 1,
        dependencyKeys: ['persona:selection', 'settings:bridge', 'persona-profile:persona-first'],
        requests: [
          {
            method: 'PUT',
            path: '/chats/chat-a/generation-settings',
            body: { generationSettings: secondTarget },
          },
        ],
      })
      expect(commandCalls).toHaveLength(1)

      firstResponse.resolve(successfulChatGenerationSettingsResponse(11, firstTarget))
      await vi.waitFor(() => expect(commandCalls).toHaveLength(2))
      secondResponse.resolve(successfulChatGenerationSettingsResponse(12, secondTarget))
      await waitForPendingChatGenerationSettingsSave('chat-a')
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('settles a retained persona delete before saving a chat reference to that persona', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-generation-persona-delete',
      writerEpoch: 12,
      databaseLineage: 'lineage-chat-generation-persona-delete',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    const initial = {
      configured: true,
      personaId: 'persona-survivor',
      modelPresetId: 'model-survivor',
      promptPresetId: 'prompt-survivor',
      jailbreakToggle: false,
      sidebarToggles: {},
    }
    const doomedSelection = {
      ...initial,
      personaId: 'persona-doomed',
      modelPresetId: 'model-doomed',
      promptPresetId: 'prompt-doomed',
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })

    const deleteRecovery = createDeferred<Response>()
    const commands: Array<{ method: string; url: string }> = []
    let deleteCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const method = init.method ?? 'GET'
        commands.push({ method, url })
        if (url === '/api/v1/commands/personas/persona-doomed' && method === 'DELETE') {
          deleteCalls += 1
          if (deleteCalls === 1) return jsonResponse({ error: 'persona delete temporarily unavailable' }, 500)
          return deleteRecovery.promise
        }
        if (url === '/api/v1/commands/chats/chat-a/generation-settings' && method === 'PUT') {
          return successfulChatGenerationSettingsResponse(12, doomedSelection)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const deleteIntent = {
        version: 1 as const,
        dependencyKeys: ['persona-profile:persona-doomed'],
        requests: [
          {
            method: 'DELETE' as const,
            path: '/personas/persona-doomed',
            body: {
              selectPersonaId: 'persona-survivor',
              mirrorLegacyProfile: true,
              saveCurrent: true,
            },
          },
        ],
      }
      const retainedDelete = stagePendingMutation(PERSONA_SELECTION_MUTATION_KEY, deleteIntent)
      await expect(retainedDelete.ready).resolves.toBe('persisted')
      await expect(replayPendingMutations()).resolves.toMatchObject({ retained: 1, succeeded: 0 })

      expect(dispatchSaveChatGenerationSettings('chat-a', doomedSelection)).toBe(true)
      await vi.waitFor(() => expect(deleteCalls).toBe(2))
      expect(commands.filter((command) => command.url.includes('/generation-settings'))).toEqual([])

      const pending = await listPendingMutations()
      const chatSave = pending.find((entry) => entry.handle.key === 'character-owner:char-a')
      expect(chatSave?.intent.dependencyKeys).toEqual([
        'persona:selection',
        'settings:bridge',
        'persona-profile:persona-doomed',
        'split-preset:model:model-doomed',
        'prompt-template-owner:prompt-doomed',
      ])

      deleteRecovery.resolve(
        jsonResponse({
          revision: 11,
          event: { type: 'persona.deleted', revision: 11, resource: 'persona', id: 'persona-doomed' },
          personaId: 'persona-doomed',
          selectedPersonaId: 'persona-survivor',
          cascadedChatCount: 1,
          cascadedLoadoutCount: 0,
        }),
      )
      await waitForPendingChatGenerationSettingsSave('chat-a')

      expect(commands.filter((command) => command.url !== '/api/v1/commands/mutation-receipts/ack')).toEqual([
        { method: 'DELETE', url: '/api/v1/commands/personas/persona-doomed' },
        { method: 'DELETE', url: '/api/v1/commands/personas/persona-doomed' },
        { method: 'PUT', url: '/api/v1/commands/chats/chat-a/generation-settings' },
      ])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('replays a retained generation-settings predecessor before a full corrective successor', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-generation-predecessor',
      writerEpoch: 9,
      databaseLineage: 'lineage-chat-generation-predecessor',
      requestedWriterWasActive: true,
    })
    const initial = {
      configured: true,
      personaId: 'persona-initial',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'before' },
    }
    const firstTarget = { ...initial, personaId: 'persona-first' }
    const correctiveTarget = { ...initial, sidebarToggles: { notes: 'corrective' } }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })
    const olderCharacter = jsonClone(getDatabase().characters[0])
    const generationCalls: Array<{
      body: Record<string, unknown>
      mutationId: string | null
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
          const headers = init.headers as Record<string, string>
          generationCalls.push({
            body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
            mutationId: headers['risu-mutation-id'] ?? null,
          })
          if (generationCalls.length === 1) return jsonResponse({ error: 'offline' }, 500)
          if (generationCalls.length === 2) {
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
              characterId: 'char-a',
            })
          }
          return successfulChatGenerationSettingsResponse(12, correctiveTarget)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const retainedOperation = dispatchSaveChatGenerationSettingsWithOutcome('chat-a', firstTarget)
      expect(retainedOperation).not.toBeNull()
      await waitForPendingChatGenerationSettingsSave('chat-a')
      await expect(retainedOperation!.settlement).resolves.toEqual({ status: 'queued' })
      expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(firstTarget)
      expect(applyCharacterResource({ revision: 11, character: jsonClone(olderCharacter) })).toBe(true)
      expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(firstTarget)
      const retained = await listPendingMutations()
      expect(retained).toHaveLength(1)
      expect(retained[0].handle.key).toBe('character-owner:char-a')

      expect(dispatchSaveChatGenerationSettings('chat-a', correctiveTarget)).toBe(true)
      await waitForPendingChatGenerationSettingsSave('chat-a')

      expect(generationCalls).toHaveLength(3)
      expect(generationCalls[1].mutationId).toBe(retained[0].handle.mutationId)
      expect(generationCalls[2].mutationId).not.toBe(retained[0].handle.mutationId)
      expect(generationCalls[2].body).toEqual({
        baseRevision: 11,
        generationSettings: correctiveTarget,
      })
      expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(correctiveTarget)
      expect(await listPendingMutations()).toEqual([])

      expect(applyCharacterResource({ revision: 13, character: jsonClone(olderCharacter) })).toBe(true)
      expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(initial)
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('uses a later chat slot to service an unsent retained head before its own edit', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-generation-retained-head',
      writerEpoch: 11,
      databaseLineage: 'lineage-chat-generation-retained-head',
      requestedWriterWasActive: true,
    })
    const initial = {
      configured: true,
      personaId: 'persona-initial',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'before' },
    }
    const firstTarget = { ...initial, personaId: 'persona-first' }
    const secondTarget = { ...firstTarget, sidebarToggles: { notes: 'second' } }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })
    const predecessor = stagePendingMutation('character-owner:char-a', {
      version: 1,
      requests: [
        {
          method: 'PUT',
          path: '/chats/chat-a/generation-settings',
          body: { generationSettings: initial },
        },
      ],
    })
    await predecessor.ready
    const generationCalls: Array<{ body: Record<string, unknown>; mutationId: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
          const headers = init.headers as Record<string, string>
          generationCalls.push({
            body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
            mutationId: headers['risu-mutation-id'] ?? null,
          })
          if (generationCalls.length === 1) return jsonResponse({ error: 'still offline' }, 500)
          if (generationCalls.length === 2) {
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
              characterId: 'char-a',
            })
          }
          if (generationCalls.length === 3) {
            return successfulChatGenerationSettingsResponse(12, firstTarget)
          }
          return successfulChatGenerationSettingsResponse(13, secondTarget)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      expect(dispatchSaveChatGenerationSettings('chat-a', firstTarget)).toBe(true)
      await waitForPendingChatGenerationSettingsSave('chat-a')
      expect(generationCalls).toHaveLength(1)
      expect(generationCalls[0].mutationId).toBe(predecessor.mutationId)
      // Both the retained predecessor and this unsent durable head remain
      // queued, so their visible optimistic projection must remain as well.
      expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(firstTarget)
      expect(await listPendingMutations()).toHaveLength(2)

      expect(dispatchSaveChatGenerationSettings('chat-a', secondTarget)).toBe(true)
      await waitForPendingChatGenerationSettingsSave('chat-a')

      expect(generationCalls).toHaveLength(4)
      expect(generationCalls[1].mutationId).toBe(predecessor.mutationId)
      expect(generationCalls[2].body).toEqual({
        baseRevision: 11,
        generationSettings: firstTarget,
      })
      expect(generationCalls[3].body).toMatchObject({ baseRevision: 12 })
      expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(secondTarget)
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('sends a full idempotent correction when a queued edit rebases to a no-op', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledChatGenerationSettingsFetch()
    const initial = {
      configured: true,
      personaId: 'persona-initial',
      jailbreakToggle: false,
      sidebarToggles: {},
    }
    const attempted = { ...initial, personaId: 'persona-attempted' }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })

    expect(dispatchSaveChatGenerationSettings('chat-a', attempted)).toBe(true)
    await waitForCallCount(calls, 2)
    expect(dispatchSaveChatGenerationSettings('chat-a', initial)).toBe(true)
    firstResponse.resolve(jsonResponse({ error: 'offline' }, 500))
    await waitForCallCount(calls, 3)

    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      body: { baseRevision: 10, generationSettings: initial },
    })
    secondResponse.resolve(successfulChatGenerationSettingsResponse(11, initial))
    await waitForPendingChatGenerationSettingsSave('chat-a')
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(initial)
  })

  it('keeps a marked placeholder immutable and sends a full correction under a fresh receipt id', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-generation-marker',
      writerEpoch: 10,
      databaseLineage: 'lineage-chat-generation-marker',
      requestedWriterWasActive: true,
    })
    const initial = {
      configured: true,
      personaId: 'persona-initial',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'before' },
    }
    const firstTarget = {
      ...initial,
      personaId: 'persona-first',
      sidebarToggles: { notes: 'before', temporary: '' },
    }
    const canonicalFirst = {
      ...firstTarget,
      sidebarToggles: { notes: 'before' },
    }
    const queuedTarget = {
      ...firstTarget,
      sidebarToggles: { notes: 'queued', temporary: '' },
    }
    const correctedTarget = {
      ...canonicalFirst,
      sidebarToggles: { notes: 'queued' },
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })
    const firstResponse = createDeferred<Response>()
    const generationCalls: Array<{
      body: Record<string, unknown>
      mutationId: string | null
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
          const headers = init.headers as Record<string, string>
          generationCalls.push({
            body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
            mutationId: headers['risu-mutation-id'] ?? null,
          })
          if (generationCalls.length === 1) return firstResponse.promise
          if (generationCalls.length === 2) {
            return jsonResponse({
              revision: 12,
              event: {
                type: 'chat.updated',
                revision: 12,
                resource: 'characterRow',
                id: 'chat-a',
                parentId: 'char-a',
              },
              chatId: 'chat-a',
              characterId: 'char-a',
            })
          }
          return successfulChatGenerationSettingsResponse(13, correctedTarget)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      expect(dispatchSaveChatGenerationSettings('chat-a', firstTarget)).toBe(true)
      await vi.waitFor(() => expect(generationCalls).toHaveLength(1))
      expect(dispatchSaveChatGenerationSettings('chat-a', queuedTarget)).toBe(true)
      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(2))
      const before = await listPendingMutations()
      const markedPlaceholder = before[1]
      expect(markedPlaceholder.intent.requests[0].body).toEqual({ generationSettings: queuedTarget })
      await expect(beginPendingMutationDispatch(markedPlaceholder.handle)).resolves.toBe('persisted')

      firstResponse.resolve(successfulChatGenerationSettingsResponse(11, canonicalFirst))
      await waitForPendingChatGenerationSettingsSave('chat-a')

      expect(generationCalls).toHaveLength(3)
      expect(generationCalls[1]).toMatchObject({
        mutationId: markedPlaceholder.handle.mutationId,
        body: { generationSettings: queuedTarget },
      })
      expect(generationCalls[2].mutationId).not.toBe(markedPlaceholder.handle.mutationId)
      expect(generationCalls[2].body).toEqual({
        baseRevision: 12,
        generationSettings: correctedTarget,
      })
      expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(correctedTarget)
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('rolls back a failed generation settings save without touching sibling rows', async () => {
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
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
          return jsonResponse({ error: 'nope' }, 500)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const nextGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mode: '1',
      },
    }

    expect(getDatabase().characters[0].chats[0]).not.toHaveProperty('generationSettings')
    const operation = dispatchSaveChatGenerationSettingsWithOutcome('chat-a', nextGenerationSettings)
    expect(operation).not.toBeNull()
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(nextGenerationSettings)

    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].message.push({
        role: 'char',
        data: 'concurrent same-chat message',
        chatId: 'msg-concurrent',
      })
      getDatabase().characters[0].chats[1].name = 'Concurrent sibling edit'
    })

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0]).not.toHaveProperty('generationSettings')
    })
    expect(getDatabase().characters[0].chats[0].message).toEqual([
      {
        role: 'char',
        data: 'concurrent same-chat message',
        chatId: 'msg-concurrent',
      },
    ])
    expect(getDatabase().characters[0].chats[1].name).toBe('Concurrent sibling edit')
    await expect(operation!.settlement).resolves.toEqual({ status: 'failed', error: 'nope' })
  })

  it('does not overwrite a destructive refresh after a pending save fails', async () => {
    const calls: CapturedFetch[] = []
    const commandResponse = createDeferred<Response>()
    const refreshedSettings = {
      configured: true,
      personaId: 'persona-from-refresh',
      jailbreakToggle: false,
      sidebarToggles: { refreshed: '1' },
    }
    const refreshedCharacter = {
      chaId: 'char-a',
      name: 'Refreshed Character',
      chatPage: 0,
      chats: [
        {
          id: 'chat-a',
          name: 'Chat A',
          folderId: null,
          message: [],
          generationSettings: refreshedSettings,
        },
      ],
      chatFolders: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        const headers = init.headers as Record<string, string> | undefined
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') return commandResponse.promise
        if (url === '/api/v1/characters/char-a') {
          return jsonResponse({ revision: 10, character: refreshedCharacter })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    expect(
      dispatchSaveChatGenerationSettings('chat-a', {
        configured: true,
        personaId: 'persona-attempted',
        jailbreakToggle: true,
        sidebarToggles: {},
      }),
    ).toBe(true)
    await waitForCallCount(calls, 2)
    setDatabaseLite({ characters: [refreshedCharacter] } as any)
    commandResponse.resolve(jsonResponse({ error: 'nope' }, 500))
    await waitForPendingChatGenerationSettingsSave('chat-a')

    expect(calls.some((call) => call.url === '/api/v1/characters/char-a')).toBe(true)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(refreshedSettings)
  })

  it('keeps newer generation settings through an older successful character-row projection', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledChatGenerationSettingsFetch()
    const generationSettingsA = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: false,
      sidebarToggles: {
        notes: 'a',
      },
    }
    const generationSettingsB = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: false,
      sidebarToggles: {
        notes: 'ab',
      },
    }
    setServerCommandSuccessReconciler((event) => {
      const projectedGenerationSettings = event.revision === 11 ? generationSettingsA : generationSettingsB
      mergeServerResourceCharacterRow({
        chaId: 'char-a',
        name: 'Character',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            name: 'Chat A',
            folderId: null,
            message: [],
            generationSettings: projectedGenerationSettings,
          },
          { id: 'chat-b', name: 'Chat B', folderId: 'folder-a', message: [] },
        ],
        chatFolders: [{ id: 'folder-a', name: 'Folder', folded: false }],
      })
    })

    expect(dispatchSaveChatGenerationSettings('chat-a', generationSettingsA)).toBe(true)
    await waitForCallCount(calls, 2)
    expect(dispatchSaveChatGenerationSettings('chat-a', generationSettingsB)).toBe(true)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsB)

    firstResponse.resolve(successfulChatGenerationSettingsResponse(11, generationSettingsA))
    await waitForCallCount(calls, 3)

    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsB)
    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      body: {
        baseRevision: 11,
        patch: {
          sidebarToggles: { notes: 'ab' },
        },
      },
    })

    secondResponse.resolve(successfulChatGenerationSettingsResponse(12, generationSettingsB))
    await waitForPendingChatGenerationSettingsSave('chat-a')
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsB)
  })

  it('does not project a sparse acknowledgement overtaken by a newer full write', async () => {
    const calls: CapturedFetch[] = []
    const sparseResponse = createDeferred<Response>()
    const sparseTarget = {
      configured: true,
      personaId: 'persona-a',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'sparse' },
    }
    const newerFullTarget = {
      ...sparseTarget,
      agentPresetId: 'agent-from-newer-full-write',
      sidebarToggles: { notes: 'sparse', moduleDefault: '1' },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        const headers = init.headers as Record<string, string> | undefined
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') return sparseResponse.promise
        if (url === '/api/v1/characters/char-a') {
          return jsonResponse({
            revision: 12,
            character: {
              chaId: 'char-a',
              name: 'Character',
              chatPage: 0,
              chats: [
                {
                  id: 'chat-a',
                  name: 'Chat A',
                  folderId: null,
                  message: [],
                  generationSettings: newerFullTarget,
                },
                { id: 'chat-b', name: 'Chat B', folderId: 'folder-a', message: [] },
              ],
              chatFolders: [{ id: 'folder-a', name: 'Folder', folded: false }],
            },
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    setServerCommandSuccessReconciler(() => {
      // Simulate a later full generation-settings command that joined the
      // active global batch before the sparse command promise resumed.
      setAppliedServerResourceRevision(12)
    })
    expect(dispatchSaveChatGenerationSettings('chat-a', sparseTarget)).toBe(true)
    await waitForCallCount(calls, 2)
    sparseResponse.resolve(successfulChatGenerationSettingsResponse(11, sparseTarget))
    await waitForPendingChatGenerationSettingsSave('chat-a')

    expect(calls.some((call) => call.url === '/api/v1/characters/char-a')).toBe(true)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(newerFullTarget)
  })

  it('does not project a stale rollback when a failed sparse save is overtaken by a full write', async () => {
    const calls: CapturedFetch[] = []
    const sparseResponse = createDeferred<Response>()
    const newerFullTarget = {
      configured: true,
      personaId: 'persona-from-newer-full-write',
      jailbreakToggle: false,
      sidebarToggles: { moduleDefault: '1' },
    }
    const newerCharacter = {
      chaId: 'char-a',
      name: 'Character',
      chatPage: 0,
      chats: [
        {
          id: 'chat-a',
          name: 'Chat A',
          folderId: null,
          message: [],
          generationSettings: newerFullTarget,
        },
      ],
      chatFolders: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(requestInput)
        const headers = init.headers as Record<string, string> | undefined
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/chats/chat-a/generation-settings') return sparseResponse.promise
        if (url === '/api/v1/characters/char-a') {
          return jsonResponse({ revision: 12, character: newerCharacter })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    expect(
      dispatchSaveChatGenerationSettings('chat-a', {
        configured: true,
        personaId: 'persona-attempted',
        jailbreakToggle: true,
        sidebarToggles: {},
      }),
    ).toBe(true)
    await waitForCallCount(calls, 2)
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(newerFullTarget)
    })
    setAppliedServerResourceRevision(12)
    sparseResponse.resolve(jsonResponse({ error: 'nope' }, 500))
    await waitForPendingChatGenerationSettingsSave('chat-a')

    expect(calls.some((call) => call.url === '/api/v1/characters/char-a')).toBe(true)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(newerFullTarget)
  })

  it('preserves a newer generation settings save when an older save fails from no initial settings', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledChatGenerationSettingsFetch()
    const generationSettingsA = {
      configured: false,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: 'a',
      },
    }
    const generationSettingsB = {
      configured: true,
      personaId: 'persona-b',
      modelPresetId: 'model-preset-b',
      promptPresetId: 'preset-b',
      jailbreakToggle: true,
      sidebarToggles: {
        mode: 'b',
      },
    }

    expect(getDatabase().characters[0].chats[0]).not.toHaveProperty('generationSettings')
    expect(dispatchSaveChatGenerationSettings('chat-a', generationSettingsA)).toBe(true)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsA)
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      body: {
        baseRevision: 10,
        patch: generationSettingsA,
      },
    })

    expect(dispatchSaveChatGenerationSettings('chat-a', generationSettingsB)).toBe(true)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsB)
    expect(calls).toHaveLength(2)

    firstResponse.resolve(jsonResponse({ error: 'nope' }, 500))
    await waitForCallCount(calls, 3)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsB)
    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      body: {
        baseRevision: 10,
        patch: generationSettingsB,
      },
    })

    secondResponse.resolve(successfulChatGenerationSettingsResponse(11, generationSettingsB))
    await waitForPendingChatGenerationSettingsSave('chat-a')
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsB)
  })

  it('preserves a newer generation settings save when an older save fails from configured settings', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledChatGenerationSettingsFetch()
    const initialGenerationSettings = {
      configured: true,
      personaId: 'persona-initial',
      modelPresetId: 'model-preset-initial',
      promptPresetId: 'preset-initial',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: 'initial',
      },
    }
    const generationSettingsA = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mode: 'a',
      },
    }
    const generationSettingsB = {
      configured: true,
      personaId: 'persona-b',
      modelPresetId: 'model-preset-b',
      promptPresetId: 'preset-b',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: 'b',
      },
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initialGenerationSettings)
    })

    expect(dispatchSaveChatGenerationSettings('chat-a', generationSettingsA)).toBe(true)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsA)
    await waitForCallCount(calls, 2)
    expect(dispatchSaveChatGenerationSettings('chat-a', generationSettingsB)).toBe(true)
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsB)
    expect(calls).toHaveLength(2)

    firstResponse.resolve(jsonResponse({ error: 'nope' }, 500))
    await waitForCallCount(calls, 3)
    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      body: {
        baseRevision: 10,
        patch: {
          personaId: 'persona-b',
          modelPresetId: 'model-preset-b',
          promptPresetId: 'preset-b',
          sidebarToggles: { mode: 'b' },
        },
      },
    })
    secondResponse.resolve(successfulChatGenerationSettingsResponse(11, generationSettingsB))
    await waitForPendingChatGenerationSettingsSave('chat-a')

    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(generationSettingsB)
    expect(getDatabase().characters[0].chats[0].generationSettings).not.toEqual(initialGenerationSettings)
  })

  it('drops only a failed older field intent before sending a disjoint queued edit', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledChatGenerationSettingsFetch()
    const initial = {
      configured: true,
      personaId: 'persona-initial',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'initial' },
    }
    const firstTarget = { ...initial, personaId: 'persona-a' }
    const secondTarget = {
      ...firstTarget,
      sidebarToggles: { notes: 'queued' },
    }
    const canonicalSecond = {
      ...initial,
      sidebarToggles: { notes: 'queued' },
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })

    expect(dispatchSaveChatGenerationSettings('chat-a', firstTarget)).toBe(true)
    await waitForCallCount(calls, 2)
    expect(dispatchSaveChatGenerationSettings('chat-a', secondTarget)).toBe(true)

    firstResponse.resolve(jsonResponse({ error: 'nope' }, 500))
    await waitForCallCount(calls, 3)
    expect(calls[2]).toMatchObject({
      body: {
        baseRevision: 10,
        patch: { sidebarToggles: { notes: 'queued' } },
      },
    })
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(canonicalSecond)

    secondResponse.resolve(successfulChatGenerationSettingsResponse(11, canonicalSecond))
    await waitForPendingChatGenerationSettingsSave('chat-a')
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(canonicalSecond)
  })

  it('keeps an accepted value when a newer queued edit to the same field fails', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledChatGenerationSettingsFetch()
    const initial = {
      configured: true,
      personaId: 'persona-initial',
      jailbreakToggle: false,
      sidebarToggles: {},
    }
    const firstTarget = { ...initial, personaId: 'persona-a' }
    const secondTarget = { ...initial, personaId: 'persona-b' }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })

    expect(dispatchSaveChatGenerationSettings('chat-a', firstTarget)).toBe(true)
    await waitForCallCount(calls, 2)
    expect(dispatchSaveChatGenerationSettings('chat-a', secondTarget)).toBe(true)
    firstResponse.resolve(successfulChatGenerationSettingsResponse(11, firstTarget))
    await waitForCallCount(calls, 3)

    secondResponse.resolve(jsonResponse({ error: 'nope' }, 500))
    await waitForPendingChatGenerationSettingsSave('chat-a')
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(firstTarget)
  })

  it('restores the original value when overlapping queued edits both fail', async () => {
    const { calls, firstResponse, secondResponse } = stubControlledChatGenerationSettingsFetch()
    const initial = {
      configured: true,
      personaId: 'persona-initial',
      jailbreakToggle: false,
      sidebarToggles: {},
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = jsonClone(initial)
    })

    expect(dispatchSaveChatGenerationSettings('chat-a', { ...initial, personaId: 'persona-a' })).toBe(true)
    await waitForCallCount(calls, 2)
    expect(dispatchSaveChatGenerationSettings('chat-a', { ...initial, personaId: 'persona-b' })).toBe(true)
    firstResponse.resolve(jsonResponse({ error: 'nope' }, 500))
    await waitForCallCount(calls, 3)
    secondResponse.resolve(jsonResponse({ error: 'still nope' }, 500))

    await waitForPendingChatGenerationSettingsSave('chat-a')
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(initial)
  })
})
