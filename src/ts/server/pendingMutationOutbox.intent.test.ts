import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPendingMutationOutbox,
  discardPendingMutation,
  listPendingMutations,
  MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
  pendingMutationProjectionTargets,
  pendingMutationSettingsFieldProjectionTarget,
  preparePendingMutationOutbox,
  replaceStagedPendingMutationIntent,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
  type DurableMutationIntent,
} from './pendingMutationOutbox'
import { resetPersistenceActivityForTests } from './persistenceActivity.svelte'
import { settingsIntent } from './pendingMutationOutbox.testSupport'

beforeEach(async () => {
  // This suite owns one isolated database; cross-tab locking has its own suite.
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  resetPersistenceActivityForTests()
  await preparePendingMutationOutbox({
    writerSessionId: 'writer-a',
    writerEpoch: 1,
    databaseLineage: 'database-a',
    requestedWriterWasActive: true,
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  resetPersistenceActivityForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pending mutation outbox intent normalization', () => {
  it.each([
    { name: 'non-object body', body: [] },
    { name: 'injected base revision', body: { baseRevision: 9 } },
  ])('validates the owned JSON snapshot before staging a $name', ({ body }) => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { toJSON: () => body } }],
    }
    expect(() => stagePendingMutation('invalid-canonical-body', intent)).toThrow(TypeError)
    expect(() => pendingMutationProjectionTargets(intent)).toThrow(TypeError)
  })

  it('captures request headers and membership before a body JSON conversion changes its caller', async () => {
    const intent = settingsIntent('external')
    const request = intent.requests[0]!
    request.body = {
      toJSON: () => {
        request.path = '/unsafe-side-effect'
        intent.requests.length = 0
        return { patch: { openAIKey: 'owned' } }
      },
    }
    await expect(stagePendingMutation('owned-headers', intent).ready).resolves.toBe('persisted')
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([settingsIntent('owned')])
    expect(() => stagePendingMutation('sparse', { version: 1, requests: new Array(1) })).toThrow(
      'request must be an object',
    )
  })

  it('continues validating public projection helpers and request bounds', () => {
    const intent = settingsIntent('external')
    expect(pendingMutationProjectionTargets(intent)).toEqual([
      pendingMutationSettingsFieldProjectionTarget('openAIKey'),
    ])
    intent.requests[0]!.path = '/unsafe-side-effect'
    expect(() => pendingMutationProjectionTargets(intent)).toThrow('not allowlisted')
    for (const requestCount of [0, 101]) {
      expect(() =>
        stagePendingMutation('request-limit', {
          version: 1,
          requests: Array.from({ length: requestCount }, () => settingsIntent('value').requests[0]!),
        }),
      ).toThrow('request count is invalid')
    }
    expect(() =>
      stagePendingMutation('generation-limit', {
        version: 1,
        kind: 'generation-operation-submit',
        requests: [
          { method: 'POST', path: '/generation-operations', body: {} },
          { method: 'POST', path: '/generation-operations', body: {} },
        ],
      }),
    ).toThrow('exactly one request')
  })

  it('normalizes frozen non-JSON numbers and rejects frozen cycles or bigint instead of trusting them', async () => {
    const input: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/settings/runtime',
          body: Object.freeze({ patch: Object.freeze({ temperature: NaN, topP: -0, username: undefined }) }),
        },
      ],
    }
    await expect(stagePendingMutation('canonical-values', input).ready).resolves.toBe('persisted')
    expect((await listPendingMutations())[0]!.intent.requests[0]!.body).toEqual({
      patch: { temperature: null, topP: 0 },
    })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const patch of [Object.freeze(cycle), Object.freeze({ value: 1n })]) {
      expect(() =>
        stagePendingMutation('unsupported', {
          version: 1,
          requests: [{ method: 'PATCH', path: '/settings/runtime', body: Object.freeze({ patch }) }],
        }),
      ).toThrow(TypeError)
    }
    expect(await listPendingMutations()).toHaveLength(1)
  })

  it('keeps oversized staging and replacement unavailable without destroying the durable predecessor', async () => {
    const placeholder = stagePendingMutation('settings:runtime', settingsIntent('keep predecessor'))
    await placeholder.ready
    const oversized = settingsIntent('x'.repeat(MAX_DURABLE_MUTATION_PAYLOAD_BYTES))
    await expect(stagePendingMutation('oversized', oversized).ready).resolves.toBe('unavailable')
    await expect(replaceStagedPendingMutationIntent(placeholder, oversized)).resolves.toEqual({ status: 'unavailable' })
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([settingsIntent('keep predecessor')])
    expect(placeholder.phase).toBe('staged')
  })

  it('normalizes bounded dependency keys and rejects near-malformed dependency metadata', async () => {
    const normalized = stagePendingMutation('settings:runtime', {
      ...settingsIntent('normalized'),
      dependencyKeys: [' settings:bridge ', 'settings:bridge', 'settings:runtime'],
    })
    await normalized.ready
    expect((await listPendingMutations())[0]?.intent.dependencyKeys).toEqual(['settings:bridge', 'settings:runtime'])

    expect(() =>
      stagePendingMutation('settings:runtime', {
        ...settingsIntent('not-an-array'),
        dependencyKeys: 'settings:bridge',
      } as unknown as DurableMutationIntent),
    ).toThrow('Pending mutation dependency keys must be an array')
    expect(() =>
      stagePendingMutation('settings:runtime', {
        ...settingsIntent('too-many'),
        dependencyKeys: Array.from({ length: 33 }, (_, index) => `dependency:${index}`),
      }),
    ).toThrow('Pending mutation dependency key count is invalid')
    expect(() =>
      stagePendingMutation('settings:runtime', {
        ...settingsIntent('too-long'),
        dependencyKeys: ['x'.repeat(2_049)],
      }),
    ).toThrow('Pending mutation key is invalid')
  })
})

describe('pending mutation outbox durable route policy', () => {
  it('rejects persisted base revisions and command paths outside the autosave allowlist', () => {
    expect(() =>
      stagePendingMutation('settings:runtime', {
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/settings/runtime',
            body: { baseRevision: 4, patch: { maxContext: 8_000 } },
          },
        ],
      }),
    ).toThrow('must not persist a base revision')

    expect(() =>
      stagePendingMutation('unsafe', {
        version: 1,
        requests: [{ method: 'POST', path: '/messages/translate', body: { text: 'side effect' } }],
      }),
    ).toThrow('not allowlisted')
  })

  it.each([
    // Model presets and profiles
    ['POST', '/model-presets'],
    ['PATCH', '/model-presets/model-a'],
    ['DELETE', '/model-presets/model-a'],
    ['POST', '/model-presets/select'],
    ['POST', '/model-profiles'],
    ['PATCH', '/model-profiles/profile-a'],
    ['DELETE', '/model-profiles/profile-a'],
    ['POST', '/model-profiles/profile-a/duplicate'],
    ['POST', '/model-profiles/convert-legacy'],
    ['POST', '/model-profiles/reorder'],
    ['PUT', '/model-role-profiles'],
    ['PUT', '/model-runtime-defaults'],
    // Agents and Agent Presets
    ['POST', '/agents'],
    ['PATCH', '/agents/agent-a'],
    ['DELETE', '/agents/agent-a'],
    ['POST', '/agents/agent-a/duplicate'],
    ['POST', '/agents/reorder'],
    ['POST', '/agent-presets'],
    ['PATCH', '/agent-presets/preset-a'],
    ['DELETE', '/agent-presets/preset-a'],
    ['POST', '/agent-presets/preset-a/duplicate'],
    ['POST', '/agent-presets/reorder'],
    ['POST', '/agent-presets/default'],
    ['POST', '/agent-presets/preset-a/uses'],
    ['PATCH', '/agent-presets/preset-a/uses/use-a'],
    ['DELETE', '/agent-presets/preset-a/uses/use-a'],
    ['POST', '/agent-presets/preset-a/uses/reorder'],
    ['POST', '/agent-presets/preset-a/steps'],
    ['PATCH', '/agent-presets/preset-a/steps/step-a'],
    ['DELETE', '/agent-presets/preset-a/steps/step-a'],
    ['POST', '/agent-presets/preset-a/steps/step-a/duplicate'],
    ['POST', '/agent-presets/preset-a/steps/reorder'],
    // Prompt and legacy presets
    ['POST', '/prompt-presets'],
    ['PATCH', '/prompt-presets/prompt-a'],
    ['DELETE', '/prompt-presets/prompt-a'],
    ['POST', '/prompt-presets/select'],
    ['POST', '/prompt-presets/reorder'],
    ['POST', '/presets'],
    ['PATCH', '/presets/preset-a'],
    ['DELETE', '/presets/preset-a'],
    ['POST', '/presets/preset-a/copy'],
    ['POST', '/presets/select'],
    ['POST', '/presets/reorder'],
    ['POST', '/model-presets/reorder'],
    ['POST', '/legacy-bot-presets/preset-a/extract'],
    ['POST', '/prompt-items'],
    ['POST', '/prompt-items/reorder'],
    ['DELETE', '/prompt-items/item-a'],
    ['POST', '/prompt-items/enable'],
    // Personas and translators
    ['DELETE', '/personas/persona-a'],
    ['POST', '/personas'],
    ['POST', '/personas/select'],
    ['POST', '/personas/reorder'],
    ['POST', '/translator-presets'],
    ['PATCH', '/translator-presets/translator-a'],
    ['DELETE', '/translator-presets/translator-a'],
    ['POST', '/translator-presets/select'],
    // Characters, chats, and messages
    ['POST', '/characters'],
    ['POST', '/characters/create-and-select'],
    ['PATCH', '/characters/character-a/alternate-greetings'],
    ['DELETE', '/characters/character-a'],
    ['POST', '/characters/select'],
    ['POST', '/characters/character-a/chats'],
    ['PUT', '/characters/character-a/chats'],
    ['POST', '/characters/character-a/chats/reorder'],
    ['POST', '/characters/character-a/chat-folders'],
    ['POST', '/characters/character-a/chat-folders/reorder'],
    ['POST', '/characters/character-a/modules/reorder'],
    ['PATCH', '/chats/chat-a'],
    ['PATCH', '/chats/chat-a/scriptstate'],
    ['POST', '/chats/chat-a/fork'],
    ['POST', '/chats/chat-a/messages'],
    ['POST', '/chats/chat-a/messages/truncate'],
    ['POST', '/chats/chat-a/messages/tail'],
    ['PUT', '/chats/chat-a/messages'],
    ['PATCH', '/messages/message-a'],
    ['DELETE', '/messages/message-a'],
    ['DELETE', '/chat-folders/folder-a'],
    // Modules and folders
    ['POST', '/modules'],
    ['PATCH', '/modules/module-a'],
    ['DELETE', '/modules/module-a'],
    ['POST', '/modules/enable'],
    ['POST', '/modules/reorder'],
    ['POST', '/module-folders'],
    ['PATCH', '/module-folders/folder-a'],
    ['DELETE', '/module-folders/folder-a'],
    ['POST', '/module-folders/reorder'],
    // Plugins and storage
    ['POST', '/plugins'],
    ['PATCH', '/plugins/plugin-a'],
    ['DELETE', '/plugins/plugin-a'],
    ['POST', '/plugins/plugin-a/enable'],
    ['POST', '/plugins/provider'],
    ['POST', '/plugins/reorder'],
    ['PUT', '/plugin-storage/key-a'],
    ['DELETE', '/plugin-storage/key-a'],
    ['POST', '/plugin-storage/bulk'],
    // Loadouts and generation settings
    ['POST', '/loadouts'],
    ['DELETE', '/loadouts/loadout-a'],
    ['POST', '/loadouts/loadout-a/favorite'],
    ['POST', '/loadouts/loadout-a/touch'],
    ['PUT', '/chats/chat-a/generation-settings'],
    ['DELETE', '/chats/chat-a'],
    // Scripts and triggers
    ['PATCH', '/settings/advanced/global-scripts'],
    ['PUT', '/characters/character-a/scripts'],
    ['PATCH', '/characters/character-a/triggers'],
    ['PUT', '/modules/module-a/scripts'],
    ['PATCH', '/modules/module-a/triggers'],
    // Lorebooks
    ['POST', '/lorebooks'],
    ['POST', '/lorebooks/reorder'],
    ['PATCH', '/lorebooks/lorebook-a'],
    ['DELETE', '/lorebooks/lorebook-a'],
    ['POST', '/lorebooks/lorebook-a/select'],
    ['PUT', '/lorebooks/lorebook-a/entries'],
    ['PUT', '/lorebooks/lorebook-a/entries/entry-a'],
    ['DELETE', '/lorebooks/lorebook-a/entries/entry-a'],
    ['POST', '/lorebooks/lorebook-a/entries/reorder'],
    ['PUT', '/characters/character-a/lorebooks'],
    ['PUT', '/chats/chat-a/lorebooks/entries/entry-a'],
    ['DELETE', '/modules/module-a/lorebooks/entries/entry-a'],
    ['POST', '/chats/chat-a/lorebooks/entries/reorder'],
    // BardWiki
    ['PATCH', '/bardwiki/chats/chat-a/settings'],
    ['POST', '/bardwiki/chats/chat-a/documents'],
    ['PATCH', '/bardwiki/chats/chat-a/documents/document-a'],
    ['DELETE', '/bardwiki/chats/chat-a/documents/document-a'],
    ['POST', '/bardwiki/chats/chat-a/confirmations'],
  ] as const)('allowlists the durable bridge route %s %s', async (method, path) => {
    const handle = stagePendingMutation(`allowlist:${method}:${path}`, {
      version: 1,
      requests: [{ method, path, body: { patch: { value: true } } }],
    })

    await expect(handle.ready).resolves.toBe('persisted')
    await expect(discardPendingMutation(handle)).resolves.toBe('deleted')
  })

  it.each(['full', 'missing'] as const)('persists and restores a confirmed %s BardWiki rebuild', async (policy) => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/bardwiki/chats/chat-a/rebuilds',
          body: { preview: false, confirm: true, policy, expectedSourceCount: 4 },
        },
      ],
    }

    const handle = stagePendingMutation('bardwiki-rebuild:chat-a', intent)

    await expect(handle.ready).resolves.toBe('persisted')
    expect((await listPendingMutations())[0]?.intent).toEqual(intent)
    await expect(discardPendingMutation(handle)).resolves.toBe('deleted')
  })

  it('keeps similar nested resource routes outside the durable allowlist', () => {
    expect(() =>
      stagePendingMutation('unsafe-nested-route', {
        version: 1,
        requests: [
          {
            method: 'POST',
            path: '/characters/character-a/scripts/reorder',
            body: { scriptIds: ['script-a'] },
          },
        ],
      }),
    ).toThrow('not allowlisted')
  })

  it.each([
    ['POST', '/prompt-items/item-a'],
    ['POST', '/prompt-items/enable/extra'],
    ['POST', '/prompt-items/reorder/extra'],
    ['POST', '/presets/select/extra'],
    ['POST', '/presets/reorder/extra'],
    ['POST', '/presets/preset-a/copy/extra'],
    ['PATCH', '/presets/preset-a/extra'],
    ['POST', '/model-presets/select/extra'],
    ['POST', '/model-presets/reorder/extra'],
    ['POST', '/model-profiles/profile-a'],
    ['PUT', '/model-profiles/profile-a'],
    ['POST', '/model-profiles/convert-legacy/extra'],
    ['PUT', '/model-role-profiles/extra'],
    ['PUT', '/model-runtime-defaults/extra'],
    ['PUT', '/agents'],
    ['POST', '/agents/agent-a'],
    ['PATCH', '/agents/reorder'],
    ['POST', '/agents/reorder/extra'],
    ['PATCH', '/agents/agent-a/duplicate'],
    ['PUT', '/agent-presets/preset-a/uses'],
    ['PATCH', '/agent-presets/preset-a/uses'],
    ['POST', '/agent-presets/preset-a/uses/use-a'],
    ['DELETE', '/agent-presets/preset-a/uses/reorder'],
    ['PUT', '/agent-presets'],
    ['POST', '/agent-presets/preset-a'],
    ['PATCH', '/agent-presets/preset-a/duplicate'],
    ['POST', '/agent-presets/default/extra'],
    ['POST', '/agent-presets/preset-a/steps/reorder/extra'],
    ['PATCH', '/agent-presets/preset-a/steps'],
    ['POST', '/prompt-presets/select/extra'],
    ['POST', '/prompt-presets/reorder/extra'],
    ['POST', '/legacy-bot-presets/preset-a/extract/extra'],
    ['DELETE', '/presets/preset-a/extra'],
    ['POST', '/modules/module-a'],
    ['PATCH', '/modules'],
    ['POST', '/modules/enable/extra'],
    ['POST', '/module-folders/folder-a'],
    ['PATCH', '/module-folders'],
    ['POST', '/module-folders/reorder/extra'],
    ['PATCH', '/loadouts/loadout-a'],
    ['DELETE', '/loadouts'],
    ['POST', '/loadouts/loadout-a'],
    ['POST', '/loadouts/loadout-a/favorite/extra'],
    ['POST', '/loadouts/loadout-a/touch/extra'],
    ['POST', '/personas/select/extra'],
    ['POST', '/translator-presets/select/extra'],
    ['POST', '/characters/create-and-select/extra'],
    ['PATCH', '/characters/character-a/alternate-greetings/extra'],
    ['POST', '/characters/character-a'],
    ['POST', '/characters/character-a/chats/extra'],
    ['POST', '/characters/character-a/chats/reorder/extra'],
    ['POST', '/characters/character-a/chat-folders/extra'],
    ['POST', '/characters/character-a/chat-folders/reorder/extra'],
    ['POST', '/characters/character-a/modules/reorder/extra'],
    ['PATCH', '/chats/chat-a/scriptstate/extra'],
    ['POST', '/chats/chat-a/fork/extra'],
    ['POST', '/chats/chat-a/messages/extra'],
    ['POST', '/chats/chat-a/messages/truncate/extra'],
    ['POST', '/chats/chat-a/messages/tail/extra'],
    ['PUT', '/chats/chat-a/messages/extra'],
    ['POST', '/messages/message-a/translate'],
    ['POST', '/chats/chat-a/generation-result'],
    ['POST', '/lorebooks/lorebook-a'],
    ['POST', '/lorebooks/reorder/extra'],
    ['PATCH', '/lorebooks'],
    ['POST', '/lorebooks/lorebook-a/select/extra'],
    ['DELETE', '/personas/persona-a/extra'],
    ['DELETE', '/lorebooks/lorebook-a/entries'],
  ] as const)('rejects the near-miss durable route %s %s', (method, path) => {
    expect(() =>
      stagePendingMutation(`near-miss:${method}:${path}`, {
        version: 1,
        requests: [{ method, path, body: { value: true } }],
      }),
    ).toThrow('not allowlisted')
  })
})
