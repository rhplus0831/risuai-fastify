import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { serializeScriptDefinitionCollectionDigestInput } from './scriptDefinitionMutations'
import {
  mutateCharacterScriptsCommand,
  mutateGlobalScriptsCommand,
  mutateCharacterTriggersCommand,
  mutateModuleScriptsCommand,
  mutateModuleTriggersCommand,
  replaceCharacterScriptsCommand,
  replaceCharacterTriggersCommand,
  replaceModuleScriptsCommand,
  replaceModuleTriggersCommand,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
} from './commands'

describe('script and trigger definition command adapters', () => {
  it('dispatches script and trigger definition commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.includes('/scripts')) {
        return {
          revision: 9,
          event: {
            type: 'scriptDefinitions.replaced',
            revision: 9,
            resource: 'scriptDefinition',
          },
          characterId: 'char-a',
          moduleId: 'mod-a',
        }
      }
      if (url.includes('/triggers')) {
        return {
          revision: 10,
          event: {
            type: 'triggerDefinitions.replaced',
            revision: 10,
            resource: 'triggerDefinition',
          },
          characterId: 'char-a',
          moduleId: 'mod-a',
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const script = {
      id: 'script-a',
      comment: 'Regex',
      in: 'a',
      out: 'b',
      type: 'editinput',
    }
    const trigger = {
      id: 'trigger-a',
      comment: 'Start',
      type: 'start',
      conditions: [],
      effect: [],
    }

    await replaceCharacterScriptsCommand({
      baseRevision: 1,
      characterId: 'char-a',
      scripts: [script],
    })
    await replaceCharacterTriggersCommand({
      baseRevision: 2,
      characterId: 'char-a',
      triggers: [trigger],
    })
    await replaceModuleScriptsCommand({
      baseRevision: 3,
      moduleId: 'mod-a',
      scripts: [script],
      optimisticCollectionEpoch: 9,
    })
    await replaceModuleTriggersCommand({
      baseRevision: 4,
      moduleId: 'mod-a',
      triggers: [trigger],
      optimisticCollectionEpoch: 9,
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters/char-a/scripts',
        method: 'PUT',
        body: { baseRevision: 1, scripts: [script] },
      },
      {
        url: '/api/v1/commands/characters/char-a/triggers',
        method: 'PUT',
        body: { baseRevision: 2, triggers: [trigger] },
      },
      {
        url: '/api/v1/commands/modules/mod-a/scripts',
        method: 'PUT',
        body: { baseRevision: 3, scripts: [script] },
      },
      {
        url: '/api/v1/commands/modules/mod-a/triggers',
        method: 'PUT',
        body: { baseRevision: 4, triggers: [trigger] },
      },
    ])
  })

  it('keeps the final global-script array client-only for a compact mutation', async () => {
    const expectedScripts = [
      { id: 'script-a', comment: 'Edited', in: 'small', out: 'x'.repeat(64 * 1024), type: 'editinput' },
    ]
    const expectedDigest = createHash('sha256')
      .update(serializeScriptDefinitionCollectionDigestInput(expectedScripts), 'utf8')
      .digest('hex')
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 12,
      event: {
        type: 'settings.updated',
        revision: 12,
        resource: 'settings',
        id: 'advanced',
      },
      group: 'advanced',
      key: 'globalscript',
      certificate: 'global-script-mutation-v1',
      operation: 'update',
      globalScriptsDigest: expectedDigest,
      acknowledgedKeys: ['globalscript'],
      settings: {},
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await mutateGlobalScriptsCommand({
      baseRevision: 11,
      mutation: { op: 'update', id: 'script-a', patch: { comment: 'Edited' }, deleteKeys: [] },
      expectedScripts,
      optimisticProjectionEpoch: 7,
    })

    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/settings/advanced/global-scripts',
        method: 'PATCH',
        authHeader: 'test-auth-token',
        writerSessionHeader: 'command-test-writer',
        contentType: 'application/json',
        body: {
          baseRevision: 11,
          mutation: { op: 'update', id: 'script-a', patch: { comment: 'Edited' }, deleteKeys: [] },
        },
      },
    ])
    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'advanced',
        attemptedPatch: { globalscript: expectedScripts },
        settings: { globalscript: expectedScripts },
        settingsProjectionEpoch: 7,
      },
    ])
  })

  it('sends compact definition mutations while keeping final arrays client-only', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 30
    const commandFetch = makeCommandFetch((url) => {
      revision += 1
      const scripts = url.endsWith('/scripts')
      const module = url.includes('/modules/')
      return {
        revision,
        event: {
          type: scripts ? 'scriptDefinitions.replaced' : 'triggerDefinitions.replaced',
          revision,
          resource: module ? (scripts ? 'moduleScriptDefinition' : 'moduleTriggerDefinition') : 'characterRow',
          id: module ? 'mod-a' : 'char-a',
        },
        ...(module ? { moduleId: 'mod-a' } : { characterId: 'char-a' }),
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const largeClientOnlyBody = 'x'.repeat(64 * 1024)
    await mutateCharacterScriptsCommand(
      {
        baseRevision: 1,
        characterId: 'char-a',
        mutation: { op: 'update', id: 'script-a', patch: { comment: 'small' }, deleteKeys: [] },
        expectedScripts: [{ id: 'script-a', body: largeClientOnlyBody }],
        optimisticRowEpoch: 4,
      },
      undefined,
      true,
      true,
    )
    await mutateCharacterTriggersCommand(
      {
        baseRevision: 2,
        characterId: 'char-a',
        mutation: { op: 'delete', id: 'trigger-a' },
        expectedTriggers: [{ id: 'trigger-b', body: largeClientOnlyBody }],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await mutateModuleScriptsCommand(
      {
        baseRevision: 3,
        moduleId: 'mod-a',
        mutation: { op: 'create', row: { id: 'script-b', comment: 'small' }, index: 1 },
        expectedScripts: [
          { id: 'script-a', body: largeClientOnlyBody },
          { id: 'script-b', comment: 'small' },
        ],
        optimisticCollectionEpoch: 7,
      },
      undefined,
      false,
      true,
    )
    await mutateModuleTriggersCommand(
      {
        baseRevision: 4,
        moduleId: 'mod-a',
        mutation: { op: 'reorder', ids: ['trigger-b', 'trigger-a'] },
        expectedTriggers: [{ id: 'trigger-b', body: largeClientOnlyBody }, { id: 'trigger-a' }],
        optimisticCollectionEpoch: 7,
      },
      undefined,
      false,
      true,
    )

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters/char-a/scripts',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          mutation: { op: 'update', id: 'script-a', patch: { comment: 'small' }, deleteKeys: [] },
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/triggers',
        method: 'PATCH',
        body: { baseRevision: 2, mutation: { op: 'delete', id: 'trigger-a' } },
      },
      {
        url: '/api/v1/commands/modules/mod-a/scripts',
        method: 'PATCH',
        body: {
          baseRevision: 3,
          mutation: { op: 'create', row: { id: 'script-b', comment: 'small' }, index: 1 },
        },
      },
      {
        url: '/api/v1/commands/modules/mod-a/triggers',
        method: 'PATCH',
        body: { baseRevision: 4, mutation: { op: 'reorder', ids: ['trigger-b', 'trigger-a'] } },
      },
    ])
    expect(vi.mocked(commandFetch.fetch).mock.calls[0]?.[1]).toMatchObject({ keepalive: true })
    expect(JSON.stringify(commandFetch.calls)).not.toContain(largeClientOnlyBody)
    expect(observedEffects).toEqual([
      {
        kind: 'characterDefinitionMutation',
        operation: 'scripts',
        characterId: 'char-a',
        optimisticRowEpoch: 4,
        definitions: [{ id: 'script-a', body: largeClientOnlyBody }],
      },
      {
        kind: 'characterDefinitionMutation',
        operation: 'triggers',
        characterId: 'char-a',
        optimisticRowEpoch: 4,
        definitions: [{ id: 'trigger-b', body: largeClientOnlyBody }],
      },
      {
        kind: 'moduleCollectionMutation',
        operation: 'scripts',
        moduleId: 'mod-a',
        collectionProjectionEpoch: 7,
      },
      {
        kind: 'moduleCollectionMutation',
        operation: 'triggers',
        moduleId: 'mod-a',
        collectionProjectionEpoch: 7,
      },
    ])
  })

  it('keeps mismatched definition response revisions authoritative', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 12,
      event: {
        type: 'scriptDefinitions.replaced',
        revision: 11,
        resource: 'characterRow',
        id: 'char-a',
      },
      characterId: 'char-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await mutateCharacterScriptsCommand(
      {
        baseRevision: 1,
        characterId: 'char-a',
        mutation: { op: 'delete', id: 'script-a' },
        expectedScripts: [],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )

    expect(observedEffects).toEqual([])
  })

  it('emits opt-in character definition effects only for canonical matching commands', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 20
    const commandFetch = makeCommandFetch((url) => {
      const scripts = url.endsWith('/scripts')
      revision += 1
      return {
        revision,
        event: {
          type: scripts ? 'scriptDefinitions.replaced' : 'triggerDefinitions.replaced',
          revision,
          resource: 'characterRow',
          id: 'char-a',
        },
        characterId: 'char-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await replaceCharacterScriptsCommand(
      {
        baseRevision: 1,
        characterId: 'char-a',
        scripts: [{ id: 'script-a' }],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await replaceCharacterTriggersCommand(
      {
        baseRevision: 2,
        characterId: 'char-a',
        triggers: [{ id: 'trigger-a' }],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await replaceCharacterScriptsCommand(
      {
        baseRevision: 3,
        characterId: 'char-a',
        scripts: [{ id: 'duplicate' }, { id: 'duplicate' }],
        optimisticRowEpoch: 4,
      },
      undefined,
      false,
      true,
    )

    expect(observedEffects).toEqual([
      {
        kind: 'characterDefinitionMutation',
        operation: 'scripts',
        characterId: 'char-a',
        optimisticRowEpoch: 4,
        definitions: [{ id: 'script-a' }],
      },
      {
        kind: 'characterDefinitionMutation',
        operation: 'triggers',
        characterId: 'char-a',
        optimisticRowEpoch: 4,
        definitions: [{ id: 'trigger-a' }],
      },
    ])
  })
})
