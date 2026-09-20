import { bootstrapMocks } from './bootstrap.testSupport'
import { describe, expect, it } from 'vitest'
import { loadWebInitialDatabase } from './bootstrap'
import { peekAppliedServerResourceRevision, subscribeServerCommandLocalEffectApplied } from './server/commands'
import {
  applySettingsGroupResource,
  captureSettingsGroupProjectionEpoch,
  hasSettingsGroupProjectionEpochChanged,
  isSettingsGroupAcknowledgementTainted,
  markSettingsAcknowledgementTainted,
  markSettingsGroupAcknowledgementTainted,
  settingsResourceState,
} from './server/resourceState.svelte'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const { resourceApi, commandApi } = bootstrapMocks

describe('API-backed client bootstrap', () => {
  it('applies contiguous generation-settings command effects without a resource read and preserves a newer edit', async () => {
    await loadWebInitialDatabase()
    const attemptedA = {
      configured: true,
      jailbreakToggle: false,
      sidebarToggles: { mode: '0', stale: '1' },
    }
    const canonicalA = {
      configured: true,
      jailbreakToggle: false,
      sidebarToggles: { mode: '0' },
    }
    const attemptedB = {
      configured: true,
      jailbreakToggle: true,
      sidebarToggles: { mode: '1', stale: '1' },
    }
    const canonicalB = {
      configured: true,
      jailbreakToggle: true,
      sidebarToggles: { mode: '1' },
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = attemptedB
    })

    const eventA = {
      type: 'chat.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }
    await commandApi.reconciler?.(
      eventA,
      [eventA],
      new Map([
        [
          6,
          {
            kind: 'chatGenerationSettings',
            chatId: 'chat-a',
            characterId: 'char-a',
            attemptedGenerationSettings: attemptedA,
            generationSettings: canonicalA,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(attemptedB)
    expect(peekAppliedServerResourceRevision()).toBe(6)

    const eventB = { ...eventA, revision: 7 }
    await commandApi.reconciler?.(
      eventB,
      [eventB],
      new Map([
        [
          7,
          {
            kind: 'chatGenerationSettings',
            chatId: 'chat-a',
            characterId: 'char-a',
            attemptedGenerationSettings: attemptedB,
            generationSettings: canonicalB,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(canonicalB)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('acknowledges a contiguous settings patch without re-reading its group', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().theme = 'LIGHT'
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('display')
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'display',
            attemptedPatch: { theme: 'LIGHT' },
            settings: { theme: 'light' },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().theme).toBe('light')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('falls back when an authoritative settings apply supersedes an optimistic intent', async () => {
    await loadWebInitialDatabase()
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('display')
    withTestDatabaseWrite(() => {
      getDatabase().theme = 'optimistic'
    })
    applySettingsGroupResource(
      {
        revision: 5,
        group: 'display',
        settings: { theme: 'authoritative-before-command' },
      },
      ['theme'],
    )
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'display',
            attemptedPatch: { theme: 'optimistic' },
            settings: { theme: 'canonical' },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(getDatabase().theme).toBe('authoritative-before-command')
  })

  it('falls back when a models read supersedes an optimistic provider-owned model profile intent', async () => {
    await loadWebInitialDatabase()
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('providers')
    withTestDatabaseWrite(() => {
      getDatabase().modelProfiles = [{ id: 'profile-optimistic', name: 'Optimistic Profile' }] as never
    })
    applySettingsGroupResource(
      {
        revision: 5,
        group: 'models',
        settings: {
          modelProfiles: [{ id: 'profile-authoritative', name: 'Authoritative Profile' }],
        },
      },
      ['modelProfiles'],
    )
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'providers',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'providers',
            attemptedPatch: {
              modelProfiles: [{ id: 'profile-optimistic', name: 'Optimistic Profile' }],
            },
            settings: {
              modelProfiles: [{ id: 'profile-optimistic', name: 'Optimistic Profile' }],
            },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(getDatabase().modelProfiles).toEqual([{ id: 'profile-authoritative', name: 'Authoritative Profile' }])
  })

  it('authoritatively reconciles an accepted settings patch without an optimistic effect', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().theme = 'old-local-value'
    })
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    }
    resourceApi.refreshInvalidated.mockImplementationOnce(async () => {
      applySettingsGroupResource(
        {
          revision: 6,
          group: 'display',
          settings: { theme: 'light' },
        },
        ['theme'],
      )
      return { status: 'ok', revision: 6, scope: 'targeted' }
    })

    await commandApi.reconciler?.(event, [event], new Map())

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(getDatabase().theme).toBe('light')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges an exact prompt settings patch only against its unchanged untainted projection', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().mainPrompt = 'optimistic'
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('prompt')
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'prompt',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'prompt',
            attemptedPatch: { mainPrompt: 'optimistic' },
            settings: { mainPrompt: 'canonical' },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().mainPrompt).toBe('canonical')
    expect(hasSettingsGroupProjectionEpochChanged('prompt', settingsProjectionEpoch)).toBe(false)
    expect(isSettingsGroupAcknowledgementTainted('prompt')).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it.each([
    ['wrong event type', { type: 'prompt.settings.updated' }],
    ['wrong event resource', { resource: 'prompt' }],
    ['wrong event group', { id: 'runtime' }],
    ['parent-scoped event', { parentId: 'unexpected' }],
  ])('falls back when a prompt settings acknowledgement has a %s', async (_label, eventOverride) => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().mainPrompt = 'optimistic'
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('prompt')
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'prompt',
      ...eventOverride,
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'prompt',
            attemptedPatch: { mainPrompt: 'optimistic' },
            settings: { mainPrompt: 'canonical' },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it.each(['missing epoch', 'changed epoch', 'tainted projection'])(
    '%s forces a prompt settings group fallback',
    async (failure) => {
      await loadWebInitialDatabase()
      const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('prompt')
      if (failure === 'changed epoch') {
        applySettingsGroupResource(
          {
            revision: 5,
            group: 'prompt',
            settings: { mainPrompt: 'authoritative' },
          },
          ['mainPrompt'],
        )
      } else if (failure === 'tainted projection') {
        markSettingsGroupAcknowledgementTainted('prompt')
      }
      withTestDatabaseWrite(() => {
        getDatabase().mainPrompt = 'optimistic'
      })
      const event = {
        type: 'settings.updated',
        revision: 6,
        resource: 'settings',
        id: 'prompt',
      }
      const localEffect = {
        kind: 'settingsPatch',
        group: 'prompt',
        attemptedPatch: { mainPrompt: 'optimistic' },
        settings: { mainPrompt: 'canonical' },
        ...(failure === 'missing epoch' ? {} : { settingsProjectionEpoch }),
      }

      await commandApi.reconciler?.(event, [event], new Map([[6, localEffect]]))

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
    },
  )

  it('acknowledges Agent Preset fields locally and notifies settlement only after the effect applies', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets = [
        {
          id: 'ap_a',
          name: '  Attempted Name  ',
          description: null as never,
          enabled: true,
          version: 1,
          steps: [],
        },
      ]
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('agents')
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets[0].name = 'newer local name'
    })
    const event = {
      type: 'agentPreset.updated',
      revision: 6,
      resource: 'agentPreset',
      id: 'ap_a',
    }
    const appliedEffects: unknown[] = []
    const unsubscribe = subscribeServerCommandLocalEffectApplied((_event, localEffect) => {
      appliedEffects.push(localEffect)
    })
    const localEffect = {
      kind: 'agentPresetPatch' as const,
      presetId: 'ap_a',
      settingsProjectionEpoch,
      fields: {
        name: {
          attempted: { present: true as const, value: '  Attempted Name  ' },
          canonical: { present: true as const, value: 'Attempted Name' },
        },
        description: {
          attempted: { present: true as const, value: null },
          canonical: { present: false as const },
        },
      },
      updatedAt: 600,
    }

    await commandApi.reconciler?.(event, [event], new Map([[6, localEffect]]))
    unsubscribe()

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().agentPresets[0]).toMatchObject({ name: 'newer local name', updatedAt: 600 })
    expect(getDatabase().agentPresets[0]).not.toHaveProperty('description')
    expect(settingsResourceState.groupRevisions.agents).toBe(6)
    expect(hasSettingsGroupProjectionEpochChanged('agents', settingsProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(6)
    expect(appliedEffects).toEqual([localEffect])
  })

  it.each(['agents epoch', 'agents taint', 'global settings taint', 'agents unready'])(
    '%s forces an Agent Preset PATCH authoritative fallback without settling its local effect',
    async (failure) => {
      await loadWebInitialDatabase()
      withTestDatabaseWrite(() => {
        getDatabase().agentPresets = [{ id: 'ap_a', name: 'Attempted', enabled: true, version: 1, steps: [] }]
      })
      const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('agents')
      if (failure === 'agents epoch') {
        applySettingsGroupResource(
          {
            revision: 5,
            group: 'agents',
            settings: {
              agentPresets: [{ id: 'ap_a', name: 'Attempted', enabled: true, version: 1, steps: [] }],
            },
          },
          ['agents', 'agentPresets', 'agentPresetDefaultId'],
        )
      } else if (failure === 'agents taint') {
        markSettingsGroupAcknowledgementTainted('agents')
      } else if (failure === 'global settings taint') {
        markSettingsAcknowledgementTainted()
      } else {
        settingsResourceState.status = 'idle'
      }
      const event = {
        type: 'agentPreset.updated',
        revision: 6,
        resource: 'agentPreset',
        id: 'ap_a',
      }
      const appliedEffects: unknown[] = []
      const unsubscribe = subscribeServerCommandLocalEffectApplied((_event, localEffect) => {
        appliedEffects.push(localEffect)
      })

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'agentPresetPatch',
              presetId: 'ap_a',
              settingsProjectionEpoch,
              fields: {
                name: {
                  attempted: { present: true, value: 'Attempted' },
                  canonical: { present: true, value: 'Attempted' },
                },
              },
              updatedAt: 600,
            },
          ],
        ]),
      )
      unsubscribe()

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
      expect(appliedEffects).toEqual([])
    },
  )

  it('fences contiguous optimistic Agent Preset reorder/default writes without an agents read', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets = [
        { id: 'ap_a', name: 'Preset A', enabled: true, version: 1, steps: [] },
        { id: 'ap_b', name: 'Preset B', enabled: true, version: 1, steps: [] },
      ]
      getDatabase().agentPresetDefaultId = 'ap_a'
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('agents')
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets = [getDatabase().agentPresets[1], getDatabase().agentPresets[0]]
    })
    const reorderEvent = {
      type: 'agentPreset.reordered',
      revision: 6,
      resource: 'agentPreset',
    }
    const reorderEffect = {
      kind: 'agentPresetCollectionMutation' as const,
      operation: 'reorder' as const,
      settingsProjectionEpoch,
      presetIds: ['ap_b', 'ap_a'],
      agentPresetDefaultId: 'ap_a',
    }

    await commandApi.reconciler?.(reorderEvent, [reorderEvent], new Map([[6, reorderEffect]]))

    withTestDatabaseWrite(() => {
      getDatabase().agentPresetDefaultId = 'ap_b'
    })
    const defaultEvent = {
      type: 'agentPreset.default.updated',
      revision: 7,
      resource: 'agentPreset',
      id: 'ap_b',
    }
    const defaultEffect = {
      kind: 'agentPresetCollectionMutation' as const,
      operation: 'default' as const,
      settingsProjectionEpoch,
      presetIds: ['ap_b', 'ap_a'],
      agentPresetDefaultId: 'ap_b',
    }

    await commandApi.reconciler?.(defaultEvent, [defaultEvent], new Map([[7, defaultEffect]]))

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().agentPresets.map((preset) => preset.id)).toEqual(['ap_b', 'ap_a'])
    expect(getDatabase().agentPresetDefaultId).toBe('ap_b')
    expect(settingsResourceState.groupRevisions.agents).toBe(7)
    expect(hasSettingsGroupProjectionEpochChanged('agents', settingsProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it.each(['agents epoch', 'agents taint', 'live identities'])(
    '%s forces Agent Preset reorder acknowledgement through authoritative reconciliation',
    async (failure) => {
      await loadWebInitialDatabase()
      withTestDatabaseWrite(() => {
        getDatabase().agentPresets = [
          { id: 'ap_b', name: 'Preset B', enabled: true, version: 1, steps: [] },
          { id: 'ap_a', name: 'Preset A', enabled: true, version: 1, steps: [] },
        ]
        getDatabase().agentPresetDefaultId = 'ap_a'
      })
      const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('agents')
      if (failure === 'agents epoch') {
        applySettingsGroupResource(
          {
            revision: 5,
            group: 'agents',
            settings: {
              agentPresets: [
                { id: 'ap_b', name: 'Preset B', enabled: true, version: 1, steps: [] },
                { id: 'ap_a', name: 'Preset A', enabled: true, version: 1, steps: [] },
              ],
              agentPresetDefaultId: 'ap_a',
            },
          },
          ['agents', 'agentPresets', 'agentPresetDefaultId'],
        )
      } else if (failure === 'agents taint') {
        markSettingsGroupAcknowledgementTainted('agents')
      } else {
        withTestDatabaseWrite(() => {
          getDatabase().agentPresets = [getDatabase().agentPresets[1], getDatabase().agentPresets[0]]
        })
      }
      const event = {
        type: 'agentPreset.reordered',
        revision: 6,
        resource: 'agentPreset',
      }

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'agentPresetCollectionMutation',
              operation: 'reorder',
              settingsProjectionEpoch,
              presetIds: ['ap_b', 'ap_a'],
              agentPresetDefaultId: 'ap_a',
            },
          ],
        ]),
      )

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
    },
  )
})
