import { makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { PROMPT_SETTINGS_KEYS } from '@risuai/shared-core/prompt-settings'
import {
  createPromptItemCommand,
  deletePromptItemCommand,
  enablePromptItemsCommand,
  patchPromptSettingsCommand,
  reorderPromptItemsCommand,
  settingsGroupForKey,
  setServerCommandSuccessReconciler,
  type PromptItemSnapshot,
  type ServerCommandLocalEffect,
  updatePromptItemCommand,
} from './commands'
import { SERVER_SETTINGS_KEYS_BY_GROUP } from './settingsGroups'

describe('prompt command adapters', () => {
  it('owns the exact prompt settings projection, including the four moved fields', () => {
    expect(PROMPT_SETTINGS_KEYS).toHaveLength(21)
    expect(new Set(PROMPT_SETTINGS_KEYS)).toHaveProperty('size', 21)
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.prompt).toEqual([...PROMPT_SETTINGS_KEYS])
    expect(PROMPT_SETTINGS_KEYS.every((key) => settingsGroupForKey(key) === 'prompt')).toBe(true)

    expect(SERVER_SETTINGS_KEYS_BY_GROUP.media).not.toContain('outputImageModal')
    for (const key of ['fallbackModels', 'fallbackWhenBlankResponse', 'doNotChangeFallbackModels']) {
      expect(SERVER_SETTINGS_KEYS_BY_GROUP.runtime).not.toContain(key)
    }
  })

  it('dispatches prompt settings and prompt item commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/settings/prompt')) {
        return {
          revision: 2,
          event: { type: 'settings.updated', revision: 2, resource: 'settings', id: 'prompt' },
          acknowledgedKeys: [
            'mainPrompt',
            'jailbreak',
            'globalNote',
            'formatingOrder',
            'promptPreprocess',
            'presetRegex',
            'promptSettings',
          ],
          settings: {},
        }
      }
      if (url.endsWith('/prompt-items/reorder')) {
        return {
          revision: 6,
          event: { type: 'prompt.item.reordered', revision: 6, resource: 'promptItem' },
        }
      }
      if (url.endsWith('/prompt-items/enable')) {
        return {
          revision: 7,
          event: { type: 'prompt.item.enabled', revision: 7, resource: 'promptItem' },
          enabled: true,
        }
      }
      if (url.endsWith('/prompt-items/item-a')) {
        return {
          revision: 5,
          event: { type: 'prompt.item.deleted', revision: 5, resource: 'promptItem', id: 'item-a' },
          itemId: 'item-a',
        }
      }
      if (url.endsWith('/prompt-items/item-b')) {
        return {
          revision: 4,
          event: { type: 'prompt.item.updated', revision: 4, resource: 'promptItem', id: 'item-b' },
          itemId: 'item-b',
        }
      }
      return {
        revision: 3,
        event: { type: 'prompt.item.created', revision: 3, resource: 'promptItem', id: 'item-b' },
        itemId: 'item-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      patchPromptSettingsCommand({
        baseRevision: 1,
        patch: {
          mainPrompt: 'MAIN',
          jailbreak: 'JB',
          globalNote: 'GN',
          formatingOrder: ['main', 'jailbreak'],
          promptPreprocess: true,
          presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
          promptSettings: { sendName: true },
        },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2 })

    await expect(
      createPromptItemCommand({
        baseRevision: 2,
        promptPresetId: 'prompt-preset-a',
        promptItem: { id: 'item-b', type: 'memory', role2: 'assistant' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, itemId: 'item-b' })

    await expect(
      updatePromptItemCommand({
        baseRevision: 3,
        promptPresetId: 'prompt-preset-a',
        itemId: 'item-b',
        patch: { type: 'description', role2: 'char' },
        deleteKeys: ['text'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, itemId: 'item-b' })

    await expect(
      deletePromptItemCommand({
        baseRevision: 4,
        promptPresetId: 'prompt-preset-a',
        itemId: 'item-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, itemId: 'item-a' })

    await expect(
      reorderPromptItemsCommand({
        baseRevision: 5,
        promptPresetId: 'prompt-preset-a',
        itemIds: ['item-b'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6 })

    await expect(
      enablePromptItemsCommand({
        baseRevision: 6,
        promptPresetId: 'prompt-preset-a',
        enabled: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, enabled: true })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/settings/prompt',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          patch: {
            mainPrompt: 'MAIN',
            jailbreak: 'JB',
            globalNote: 'GN',
            formatingOrder: ['main', 'jailbreak'],
            promptPreprocess: true,
            presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
            promptSettings: { sendName: true },
          },
        },
      },
      {
        url: '/api/v1/commands/prompt-items',
        method: 'POST',
        body: {
          baseRevision: 2,
          promptPresetId: 'prompt-preset-a',
          promptItem: { id: 'item-b', type: 'memory', role2: 'bot' },
        },
      },
      {
        url: '/api/v1/commands/prompt-items/item-b',
        method: 'PATCH',
        body: {
          baseRevision: 3,
          promptPresetId: 'prompt-preset-a',
          patch: { type: 'description', role2: 'bot' },
          deleteKeys: ['text'],
        },
      },
      {
        url: '/api/v1/commands/prompt-items/item-a',
        method: 'DELETE',
        body: { baseRevision: 4, promptPresetId: 'prompt-preset-a' },
      },
      {
        url: '/api/v1/commands/prompt-items/reorder',
        method: 'POST',
        body: { baseRevision: 5, promptPresetId: 'prompt-preset-a', itemIds: ['item-b'] },
      },
      {
        url: '/api/v1/commands/prompt-items/enable',
        method: 'POST',
        body: { baseRevision: 6, promptPresetId: 'prompt-preset-a', enabled: true },
      },
    ])
  })

  it('emits an exact prompt-settings acknowledgement without serializing client projection metadata', async () => {
    const event = {
      type: 'settings.updated',
      revision: 2,
      resource: 'settings',
      id: 'prompt',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 2,
      event,
      acknowledgedKeys: ['mainPrompt', 'fallbackModels'],
      settings: { mainPrompt: 'canonical' },
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchPromptSettingsCommand({
      baseRevision: 1,
      patch: { mainPrompt: 'optimistic', fallbackModels: ['model-a'] },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: 17,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'prompt',
        attemptedPatch: { mainPrompt: 'optimistic', fallbackModels: ['model-a'] },
        settings: { mainPrompt: 'canonical', fallbackModels: ['model-a'] },
        settingsProjectionEpoch: 17,
      },
    ])
    expect(commandFetch.calls).toEqual([
      expect.objectContaining({
        url: '/api/v1/commands/settings/prompt',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          patch: { mainPrompt: 'optimistic', fallbackModels: ['model-a'] },
        },
      }),
    ])
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('acknowledgeOptimistic')
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticProjectionEpoch')
  })

  it('keeps untrusted prompt-settings acknowledgements on authoritative reconciliation', async () => {
    const exactEvent = {
      type: 'settings.updated',
      revision: 2,
      resource: 'settings',
      id: 'prompt',
    }
    const cases: Array<{
      label: string
      body: Record<string, unknown>
      epoch?: number
    }> = [
      {
        label: 'missing projection epoch',
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt'], settings: {} },
      },
      {
        label: 'negative projection epoch',
        epoch: -1,
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt'], settings: {} },
      },
      {
        label: 'fractional projection epoch',
        epoch: 1.5,
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt'], settings: {} },
      },
      {
        label: 'non-finite projection epoch',
        epoch: Number.NaN,
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt'], settings: {} },
      },
      {
        label: 'wrong event type',
        epoch: 4,
        body: {
          revision: 2,
          event: { ...exactEvent, type: 'prompt.settings.updated' },
          acknowledgedKeys: ['mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'wrong event resource',
        epoch: 4,
        body: {
          revision: 2,
          event: { ...exactEvent, resource: 'prompt' },
          acknowledgedKeys: ['mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'wrong event group',
        epoch: 4,
        body: {
          revision: 2,
          event: { ...exactEvent, id: 'runtime' },
          acknowledgedKeys: ['mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'parent-scoped event',
        epoch: 4,
        body: {
          revision: 2,
          event: { ...exactEvent, parentId: 'unexpected' },
          acknowledgedKeys: ['mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'inexact acknowledgement keys',
        epoch: 4,
        body: { revision: 2, event: exactEvent, acknowledgedKeys: ['mainPrompt', 'jailbreak'], settings: {} },
      },
      {
        label: 'duplicate acknowledgement keys',
        epoch: 4,
        body: {
          revision: 2,
          event: exactEvent,
          acknowledgedKeys: ['mainPrompt', 'mainPrompt'],
          settings: {},
        },
      },
      {
        label: 'foreign canonical override',
        epoch: 4,
        body: {
          revision: 2,
          event: exactEvent,
          acknowledgedKeys: ['mainPrompt'],
          settings: { jailbreak: 'foreign' },
        },
      },
      {
        label: 'non-JSON canonical override',
        epoch: 4,
        body: {
          revision: 2,
          event: exactEvent,
          acknowledgedKeys: ['mainPrompt'],
          settings: { mainPrompt: Number.NaN },
        },
      },
    ]
    let responseIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = cases[responseIndex++].body
        return { status: 200, ok: true, json: async () => body } as Response
      }) as unknown as typeof fetch,
    )
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const testCase of cases) {
      await patchPromptSettingsCommand({
        baseRevision: 1,
        patch: { mainPrompt: 'optimistic' },
        acknowledgeOptimistic: true,
        optimisticProjectionEpoch: testCase.epoch as number,
      })
    }

    expect(observedEffectCounts, cases.map(({ label }) => label).join(', ')).toEqual(cases.map(() => 0))
  })

  it('emits exact prompt-item optimistic acknowledgements without serializing their snapshots or epochs', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const responses = [
      {
        revision: 1,
        event: {
          type: 'prompt.item.created',
          revision: 1,
          resource: 'promptItem',
          id: 'item-b',
          parentId: 'prompt-preset-a',
        },
        itemId: 'item-b',
      },
      {
        revision: 2,
        event: {
          type: 'prompt.item.updated',
          revision: 2,
          resource: 'promptItem',
          id: 'item-b',
          parentId: 'prompt-preset-a',
        },
        itemId: 'item-b',
      },
      {
        revision: 3,
        event: {
          type: 'prompt.item.deleted',
          revision: 3,
          resource: 'promptItem',
          id: 'item-a',
          parentId: 'prompt-preset-a',
        },
        itemId: 'item-a',
      },
      {
        revision: 4,
        event: {
          type: 'prompt.item.reordered',
          revision: 4,
          resource: 'promptItem',
          parentId: 'prompt-preset-a',
        },
      },
      {
        revision: 5,
        event: {
          type: 'prompt.item.enabled',
          revision: 5,
          resource: 'promptItem',
          parentId: 'prompt-preset-a',
        },
        enabled: false,
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const itemA = { id: 'item-a', type: 'plain', text: 'A' }
    const itemB = { id: 'item-b', type: 'memory', text: 'B' }
    const acknowledgement = (ownerState: { enabled: true; items: PromptItemSnapshot[] } | { enabled: false }) => ({
      collectionProjectionEpoch: 11,
      ownerProjectionEpoch: 12,
      ownerState,
    })

    await createPromptItemCommand({
      baseRevision: 0,
      promptPresetId: 'prompt-preset-a',
      promptItem: itemB,
      optimisticAcknowledgement: acknowledgement({ enabled: true, items: [itemA, itemB] }),
    })
    await updatePromptItemCommand({
      baseRevision: 1,
      promptPresetId: 'prompt-preset-a',
      itemId: 'item-b',
      patch: { type: 'description' },
      deleteKeys: ['text'],
      optimisticAcknowledgement: acknowledgement({
        enabled: true,
        items: [itemA, { id: 'item-b', type: 'description' }],
      }),
    })
    await deletePromptItemCommand({
      baseRevision: 2,
      promptPresetId: 'prompt-preset-a',
      itemId: 'item-a',
      optimisticAcknowledgement: acknowledgement({ enabled: true, items: [{ id: 'item-b', type: 'description' }] }),
    })
    await reorderPromptItemsCommand({
      baseRevision: 3,
      promptPresetId: 'prompt-preset-a',
      itemIds: ['item-b', 'item-a'],
      optimisticAcknowledgement: acknowledgement({ enabled: true, items: [itemB, itemA] }),
    })
    await enablePromptItemsCommand({
      baseRevision: 4,
      promptPresetId: 'prompt-preset-a',
      enabled: false,
      optimisticAcknowledgement: acknowledgement({ enabled: false }),
    })

    expect(observedEffects).toEqual([
      {
        kind: 'promptItemMutation',
        operation: 'create',
        itemId: 'item-b',
        promptPresetId: 'prompt-preset-a',
        collectionProjectionEpoch: 11,
        ownerProjectionEpoch: 12,
        ownerState: {
          enabled: true,
          items: [
            { id: 'item-a', type: 'plain', text: 'A' },
            { id: 'item-b', type: 'memory', text: 'B' },
          ],
        },
      },
      {
        kind: 'promptItemMutation',
        operation: 'update',
        itemId: 'item-b',
        promptPresetId: 'prompt-preset-a',
        collectionProjectionEpoch: 11,
        ownerProjectionEpoch: 12,
        ownerState: {
          enabled: true,
          items: [
            { id: 'item-a', type: 'plain', text: 'A' },
            { id: 'item-b', type: 'description' },
          ],
        },
      },
      {
        kind: 'promptItemMutation',
        operation: 'delete',
        itemId: 'item-a',
        promptPresetId: 'prompt-preset-a',
        collectionProjectionEpoch: 11,
        ownerProjectionEpoch: 12,
        ownerState: { enabled: true, items: [{ id: 'item-b', type: 'description' }] },
      },
      {
        kind: 'promptItemMutation',
        operation: 'reorder',
        itemIds: ['item-b', 'item-a'],
        promptPresetId: 'prompt-preset-a',
        collectionProjectionEpoch: 11,
        ownerProjectionEpoch: 12,
        ownerState: {
          enabled: true,
          items: [
            { id: 'item-b', type: 'memory', text: 'B' },
            { id: 'item-a', type: 'plain', text: 'A' },
          ],
        },
      },
      {
        kind: 'promptItemMutation',
        operation: 'enable',
        enabled: false,
        promptPresetId: 'prompt-preset-a',
        collectionProjectionEpoch: 11,
        ownerProjectionEpoch: 12,
        ownerState: { enabled: false },
      },
    ])
    expect(
      commandFetch.calls.every(
        (call) => !Object.prototype.hasOwnProperty.call(call.body ?? {}, 'optimisticAcknowledgement'),
      ),
    ).toBe(true)
  })

  it('keeps malformed prompt-item acknowledgements on authoritative reconciliation', async () => {
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })
    const responses = [
      {
        revision: 1,
        event: { type: 'prompt.item.updated', revision: 1, resource: 'promptItem', id: 'wrong-item' },
        itemId: 'item-a',
      },
      {
        revision: 2,
        event: {
          type: 'prompt.item.updated',
          revision: 2,
          resource: 'promptItem',
          id: 'item-a',
          parentId: 'foreign-owner',
        },
        itemId: 'item-a',
      },
      {
        revision: 3,
        event: { type: 'prompt.item.reordered', revision: 3, resource: 'promptItem' },
      },
      {
        revision: 4,
        event: { type: 'prompt.item.enabled', revision: 4, resource: 'promptItem' },
        enabled: true,
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const baseAcknowledgement = {
      collectionProjectionEpoch: 1,
      ownerProjectionEpoch: 2,
      ownerState: { enabled: true as const, items: [{ id: 'item-a', type: 'description' }] },
    }

    await updatePromptItemCommand({
      baseRevision: 0,
      itemId: 'item-a',
      patch: { type: 'description' },
      optimisticAcknowledgement: baseAcknowledgement,
    })
    await updatePromptItemCommand({
      baseRevision: 1,
      itemId: 'item-a',
      patch: { type: 'description' },
      optimisticAcknowledgement: baseAcknowledgement,
    })
    await reorderPromptItemsCommand({
      baseRevision: 2,
      itemIds: ['item-a'],
      optimisticAcknowledgement: {
        ...baseAcknowledgement,
        ownerState: {
          enabled: true,
          items: [
            { id: 'item-a', type: 'plain' },
            { id: 'item-a', type: 'memory' },
          ],
        },
      },
    })
    await enablePromptItemsCommand({
      baseRevision: 3,
      enabled: false,
      optimisticAcknowledgement: { ...baseAcknowledgement, ownerState: { enabled: false } },
    })

    expect(observedEffectCounts).toEqual([0, 0, 0, 0])
  })
})
