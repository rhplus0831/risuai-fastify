import { jsonResponse, makeCommandFetch, sha256Hex } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { serializeChatGenerationSettingsDigestInput } from '../chatGenerationSettings'
import {
  createChatGenerationSettingsCommandDurableBody,
  saveChatGenerationSettingsCommand,
  setServerCommandSuccessReconciler,
  sha256HexUtf8Sync,
} from './commands'

describe('chat generation settings command adapters', () => {
  it('dispatches chat generation settings through the dedicated typed helper', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const attemptedGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      agentPresetId: 'agent-preset-a',
      togglePresetId: 'toggle-preset-a',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: '0',
        notes: '',
      },
    }
    const canonicalGenerationSettings = {
      ...attemptedGenerationSettings,
      sidebarToggles: { mode: '0' },
    }
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/chats/chat-a/generation-settings')) {
        return {
          revision: 8,
          event: {
            type: 'chat.updated',
            revision: 8,
            resource: 'characterRow',
            id: 'chat-a',
            parentId: 'char-a',
          },
          chatId: 'chat-a',
          characterId: 'char-a',
          generationSettings: canonicalGenerationSettings,
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      saveChatGenerationSettingsCommand({
        baseRevision: 7,
        chatId: 'chat-a',
        generationSettings: attemptedGenerationSettings,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 8,
      chatId: 'chat-a',
      characterId: 'char-a',
      generationSettings: canonicalGenerationSettings,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'chatGenerationSettings',
        chatId: 'chat-a',
        characterId: 'char-a',
        attemptedGenerationSettings,
        generationSettings: canonicalGenerationSettings,
      },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        method: 'PUT',
        body: {
          baseRevision: 7,
          generationSettings: {
            configured: true,
            personaId: 'persona-a',
            modelPresetId: 'model-preset-a',
            promptPresetId: 'preset-a',
            agentPresetId: 'agent-preset-a',
            togglePresetId: 'toggle-preset-a',
            jailbreakToggle: false,
            sidebarToggles: {
              mode: '0',
              notes: '',
            },
          },
        },
      },
    ])
  })

  it('matches the synchronous generation-settings digest to WebCrypto SHA-256', async () => {
    const baseGenerationSettings = {
      configured: true,
      personaId: 'persona-한글',
      jailbreakToggle: false,
      sidebarToggles: { notes: 'line one\nline two' },
    }
    const serialized = serializeChatGenerationSettingsDigestInput(baseGenerationSettings)
    expect(sha256HexUtf8Sync(serialized)).toBe(await sha256Hex(serialized))

    const body = createChatGenerationSettingsCommandDurableBody({
      chatId: 'chat-a',
      generationSettings: { ...baseGenerationSettings, personaId: 'persona-next' },
      sparseUpdate: { patch: { personaId: 'persona-next' } },
      sparseBaseGenerationSettings: baseGenerationSettings,
    })
    expect(body.baseGenerationSettingsDigest).toBe(await sha256Hex(serialized))
  })

  it('sends a sparse generation-settings update and reconstructs its value-free acknowledgement', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const attemptedGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-b',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: 'cold',
        stale: '1',
      },
    }
    const sparseUpdate = {
      patch: {
        promptPresetId: 'preset-b',
        sidebarToggles: { mode: 'cold' },
      },
      deleteKeys: ['agentPresetId'] as const,
      sidebarToggleDeleteKeys: ['notes'],
    }
    const event = {
      type: 'chat.updated',
      revision: 8,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 8,
      event,
      chatId: 'chat-a',
      characterId: 'char-a',
      certificate: 'chat-generation-settings-sparse-v1',
      patchedKeys: ['promptPresetId', 'sidebarToggles'],
      deletedKeys: ['agentPresetId'],
      sidebarTogglePatchedKeys: ['mode'],
      sidebarToggleDeletedKeys: ['notes'],
      prunedSidebarToggleKeys: ['stale'],
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await saveChatGenerationSettingsCommand({
      baseRevision: 7,
      chatId: 'chat-a',
      generationSettings: attemptedGenerationSettings,
      sparseUpdate: {
        patch: sparseUpdate.patch,
        deleteKeys: [...sparseUpdate.deleteKeys],
        sidebarToggleDeleteKeys: sparseUpdate.sidebarToggleDeleteKeys,
      },
      sparseBaseGenerationSettings: null,
      expectedCharacterId: 'char-a',
      optimisticCharacterRowEpoch: 7,
    })

    expect(result).toMatchObject({
      status: 'ok',
      acknowledgedGenerationSettings: {
        ...attemptedGenerationSettings,
        sidebarToggles: { mode: 'cold' },
      },
    })
    expect(observedEffects).toEqual([
      {
        kind: 'chatGenerationSettings',
        chatId: 'chat-a',
        characterId: 'char-a',
        attemptedGenerationSettings,
        generationSettings: {
          ...attemptedGenerationSettings,
          sidebarToggles: { mode: 'cold' },
        },
        characterRowProjectionEpoch: 7,
      },
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      {
        baseRevision: 7,
        baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        patch: sparseUpdate.patch,
        deleteKeys: ['agentPresetId'],
        sidebarToggleDeleteKeys: ['notes'],
      },
    ])
  })

  it('withholds sparse generation-settings effects for inexact acknowledgements', async () => {
    const attemptedGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      promptPresetId: 'preset-b',
      jailbreakToggle: false,
      sidebarToggles: { mode: 'cold', stale: '1' },
    }
    const sparseUpdate = {
      patch: {
        promptPresetId: 'preset-b',
        sidebarToggles: { mode: 'cold' },
      },
      deleteKeys: ['agentPresetId' as const],
      sidebarToggleDeleteKeys: ['notes'],
    }
    const validBody = {
      revision: 8,
      event: {
        type: 'chat.updated',
        revision: 8,
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
      characterId: 'char-a',
      certificate: 'chat-generation-settings-sparse-v1',
      patchedKeys: ['promptPresetId', 'sidebarToggles'],
      deletedKeys: ['agentPresetId'],
      sidebarTogglePatchedKeys: ['mode'],
      sidebarToggleDeletedKeys: ['notes'],
      prunedSidebarToggleKeys: ['stale'],
    }
    const malformedBodies = [
      { ...validBody, patchedKeys: ['promptPresetId'] },
      { ...validBody, deletedKeys: ['agentPresetId', 'agentPresetId'] },
      { ...validBody, prunedSidebarToggleKeys: ['missing'] },
      { ...validBody, certificate: 'chat-generation-settings-sparse-v2' },
      {
        ...validBody,
        event: { ...validBody.event, parentId: 'char-b' },
      },
      {
        ...validBody,
        characterId: 'char-b',
        event: { ...validBody.event, parentId: 'char-b' },
      },
      {
        ...validBody,
        patchedKeys: ['unexpected'],
        acknowledgedGenerationSettings: { jailbreakToggle: true },
      },
    ]

    for (const body of malformedBodies) {
      const observedEffects: unknown[] = []
      setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
        observedEffects.push(...localEffects.values())
      })
      const commandFetch = makeCommandFetch(() => body)
      vi.stubGlobal('fetch', commandFetch.fetch)

      const result = await saveChatGenerationSettingsCommand({
        baseRevision: 7,
        chatId: 'chat-a',
        generationSettings: attemptedGenerationSettings,
        sparseUpdate,
        sparseBaseGenerationSettings: null,
        expectedCharacterId: 'char-a',
        optimisticCharacterRowEpoch: 7,
      })

      expect(result.status).toBe('ok')
      expect(result).toHaveProperty('acknowledgedGenerationSettings', undefined)
      expect(observedEffects).toEqual([])
    }
  })
})
