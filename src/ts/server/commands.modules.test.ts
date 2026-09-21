import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createModuleCommand,
  createModuleFolderCommand,
  deleteModuleCommand,
  deleteModuleFolderCommand,
  enableModuleCommand,
  reorderCharacterModulesCommand,
  reorderModulesCommand,
  reorderModuleFoldersCommand,
  replaceModuleLorebooksCommand,
  replaceModuleScriptsCommand,
  replaceModuleTriggersCommand,
  updateModuleFolderCommand,
  updateModuleCommand,
  setServerCommandSuccessReconciler,
} from './commands'

describe('module command adapters', () => {
  it('dispatches module record and enablement commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (
        url.includes('/modules') ||
        url.includes('/module-folders') ||
        url.includes('/characters/char-a/modules/reorder')
      ) {
        return {
          revision: 9,
          event: {
            type: 'module.updated',
            revision: 9,
            resource: 'module',
          },
          moduleId: 'mod-a',
          characterId: 'char-a',
          enabled: true,
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createModuleCommand({
      baseRevision: 1,
      module: { id: 'mod-a', name: 'A', description: 'Module' },
    })
    await updateModuleCommand({
      baseRevision: 2,
      moduleId: 'mod-a',
      patch: { name: 'Renamed', assets: [['asset.png', 'b'.repeat(64), 'png']] },
    })
    await deleteModuleCommand({ baseRevision: 3, moduleId: 'mod-a' })
    await enableModuleCommand({ baseRevision: 4, moduleId: 'mod-a', enabled: true })
    await reorderModulesCommand({
      baseRevision: 5,
      moduleIds: ['mod-b', 'mod-a'],
      folderByModuleId: { 'mod-a': null, 'mod-b': 'folder-a' },
    })
    await reorderCharacterModulesCommand({
      baseRevision: 6,
      characterId: 'char-a',
      moduleIds: ['mod-a'],
    })
    await createModuleFolderCommand({ baseRevision: 7, folder: { id: 'folder-a', name: 'Folder A' } })
    await updateModuleFolderCommand({ baseRevision: 8, folderId: 'folder-a', patch: { name: 'Renamed' } })
    await reorderModuleFoldersCommand({ baseRevision: 9, folderIds: ['folder-b', 'folder-a'] })
    await deleteModuleFolderCommand({ baseRevision: 10, folderId: 'folder-a' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/modules',
        method: 'POST',
        body: {
          baseRevision: 1,
          module: { id: 'mod-a', name: 'A', description: 'Module' },
        },
      },
      {
        url: '/api/v1/commands/modules/mod-a',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { name: 'Renamed', assets: [['asset.png', 'b'.repeat(64), 'png']] },
        },
      },
      {
        url: '/api/v1/commands/modules/mod-a',
        method: 'DELETE',
        body: { baseRevision: 3 },
      },
      {
        url: '/api/v1/commands/modules/enable',
        method: 'POST',
        body: { baseRevision: 4, moduleId: 'mod-a', enabled: true },
      },
      {
        url: '/api/v1/commands/modules/reorder',
        method: 'POST',
        body: {
          baseRevision: 5,
          moduleIds: ['mod-b', 'mod-a'],
          folderByModuleId: { 'mod-a': null, 'mod-b': 'folder-a' },
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/modules/reorder',
        method: 'POST',
        body: { baseRevision: 6, moduleIds: ['mod-a'] },
      },
      {
        url: '/api/v1/commands/module-folders',
        method: 'POST',
        body: { baseRevision: 7, folder: { id: 'folder-a', name: 'Folder A' } },
      },
      {
        url: '/api/v1/commands/module-folders/folder-a',
        method: 'PATCH',
        body: { baseRevision: 8, patch: { name: 'Renamed' } },
      },
      {
        url: '/api/v1/commands/module-folders/reorder',
        method: 'POST',
        body: { baseRevision: 9, folderIds: ['folder-b', 'folder-a'] },
      },
      {
        url: '/api/v1/commands/module-folders/folder-a',
        method: 'DELETE',
        body: { baseRevision: 10 },
      },
    ])
  })

  it('exposes only matching optimistic module mutations as compact local effects', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/characters/char-a/modules/reorder')) {
        return {
          revision: 10,
          event: {
            type: 'character.modules.reordered',
            revision: 10,
            resource: 'characterRow',
            id: 'char-a',
          },
          characterId: 'char-a',
        }
      }
      if (url.endsWith('/modules/reorder')) {
        return {
          revision: 10,
          event: { type: 'module.reordered', revision: 10, resource: 'moduleReordered' },
        }
      }
      if (url.endsWith('/modules/enable')) {
        return {
          revision: 10,
          event: { type: 'module.enabled', revision: 10, resource: 'moduleEnabled', id: 'mod-a' },
          moduleId: 'mod-a',
          enabled: true,
        }
      }
      if (url.endsWith('/modules/mod-a/lorebooks')) {
        return {
          revision: 10,
          event: { type: 'lorebook.entries.replaced', revision: 10, resource: 'moduleUpdated', id: 'mod-a' },
          moduleId: 'mod-a',
        }
      }
      if (url.endsWith('/modules/mod-a/scripts')) {
        return {
          revision: 10,
          event: {
            type: 'scriptDefinitions.replaced',
            revision: 10,
            resource: 'moduleScriptDefinition',
            id: 'mod-a',
          },
          moduleId: 'mod-a',
        }
      }
      if (url.endsWith('/modules/mod-a/triggers')) {
        return {
          revision: 10,
          event: {
            type: 'triggerDefinitions.replaced',
            revision: 10,
            resource: 'moduleTriggerDefinition',
            id: 'mod-a',
          },
          moduleId: 'mod-a',
        }
      }
      const created = url.endsWith('/modules')
      return {
        revision: 10,
        event: {
          type: created ? 'module.created' : 'module.updated',
          revision: 10,
          resource: created ? 'moduleCreated' : 'moduleUpdated',
          id: 'mod-a',
        },
        moduleId: 'mod-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const entry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'body',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    await createModuleCommand({ baseRevision: 1, module: { id: 'mod-a', name: 'A', description: '' } }, undefined, true)
    await updateModuleCommand({ baseRevision: 2, moduleId: 'mod-a', patch: { name: 'Renamed' } }, undefined, true)
    await enableModuleCommand({ baseRevision: 3, moduleId: 'mod-a', enabled: true }, undefined, true)
    await reorderModulesCommand({ baseRevision: 4, moduleIds: ['mod-b', 'mod-a'] }, undefined, true)
    await replaceModuleLorebooksCommand(
      { baseRevision: 5, moduleId: 'mod-a', entries: [entry] },
      undefined,
      false,
      true,
    )
    await replaceModuleScriptsCommand(
      {
        baseRevision: 6,
        moduleId: 'mod-a',
        scripts: [{ id: 'script-a' }],
        optimisticCollectionEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await replaceModuleTriggersCommand(
      {
        baseRevision: 7,
        moduleId: 'mod-a',
        triggers: [{ id: 'trigger-a' }],
        optimisticCollectionEpoch: 4,
      },
      undefined,
      false,
      true,
    )
    await reorderCharacterModulesCommand(
      { baseRevision: 8, characterId: 'char-a', moduleIds: ['mod-a'] },
      undefined,
      true,
    )

    expect(observedEffects).toEqual([
      { kind: 'moduleCollectionMutation', operation: 'create', moduleId: 'mod-a' },
      { kind: 'moduleCollectionMutation', operation: 'update', moduleId: 'mod-a' },
      { kind: 'moduleEnabled', moduleId: 'mod-a', enabled: true },
      { kind: 'moduleCollectionMutation', operation: 'reorder', moduleIds: ['mod-b', 'mod-a'] },
      { kind: 'moduleCollectionMutation', operation: 'lorebooks', moduleId: 'mod-a' },
      {
        kind: 'moduleCollectionMutation',
        operation: 'scripts',
        moduleId: 'mod-a',
        collectionProjectionEpoch: 4,
      },
      {
        kind: 'moduleCollectionMutation',
        operation: 'triggers',
        moduleId: 'mod-a',
        collectionProjectionEpoch: 4,
      },
      { kind: 'characterPatch', characterId: 'char-a', patch: { modules: ['mod-a'] } },
    ])
  })

  it('keeps module definition acknowledgements authoritative without a valid collection epoch', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      const scripts = url.endsWith('/scripts')
      return {
        revision: 10,
        event: {
          type: scripts ? 'scriptDefinitions.replaced' : 'triggerDefinitions.replaced',
          revision: 10,
          resource: scripts ? 'moduleScriptDefinition' : 'moduleTriggerDefinition',
          id: 'mod-a',
        },
        moduleId: 'mod-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await replaceModuleScriptsCommand(
      { baseRevision: 1, moduleId: 'mod-a', scripts: [{ id: 'script-a' }] },
      undefined,
      false,
      true,
    )
    await replaceModuleTriggersCommand(
      {
        baseRevision: 2,
        moduleId: 'mod-a',
        triggers: [{ id: 'trigger-a' }],
        optimisticCollectionEpoch: -1,
      },
      undefined,
      false,
      true,
    )
    await replaceModuleScriptsCommand(
      {
        baseRevision: 3,
        moduleId: 'mod-a',
        scripts: [{ id: 'script-b' }],
        optimisticCollectionEpoch: 1.5,
      },
      undefined,
      false,
      true,
    )

    expect(observedEffects).toEqual([])
  })

  it('keeps module deletion, non-optimistic calls, and mismatched responses authoritative', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url, init) => {
      if (url.endsWith('/characters/char-a/modules/reorder')) {
        return {
          revision: 10,
          event: {
            type: 'character.modules.reordered',
            revision: 10,
            resource: 'characterRow',
            id: 'char-a',
            parentId: 'chat-a',
          },
          characterId: 'char-a',
        }
      }
      return {
        revision: 10,
        event: {
          type: init.method === 'DELETE' ? 'module.deleted' : 'module.updated',
          revision: 10,
          resource: init.method === 'DELETE' ? 'module' : 'moduleUpdated',
          id: 'mod-a',
        },
        moduleId: url.endsWith('/mod-mismatch') ? 'different-module' : 'mod-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await deleteModuleCommand({ baseRevision: 1, moduleId: 'mod-a' })
    await updateModuleCommand({ baseRevision: 2, moduleId: 'mod-a', patch: { name: 'Not projected' } })
    await updateModuleCommand(
      { baseRevision: 3, moduleId: 'mod-mismatch', patch: { name: 'Projected' } },
      undefined,
      true,
    )
    await reorderCharacterModulesCommand(
      { baseRevision: 4, characterId: 'char-a', moduleIds: ['mod-a'] },
      undefined,
      true,
    )

    expect(observedEffects).toEqual([])
  })
})
