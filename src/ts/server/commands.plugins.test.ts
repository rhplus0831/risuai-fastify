import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  bulkPluginStorageCommand,
  createPluginCommand,
  deletePluginCommand,
  deletePluginStorageCommand,
  enablePluginCommand,
  putPluginStorageCommand,
  reorderPluginsCommand,
  selectPluginProviderCommand,
  updatePluginCommand,
  setServerCommandSuccessReconciler,
} from './commands'

describe('plugin and storage command adapters', () => {
  it('dispatches plugin record and configuration commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.includes('/plugins')) {
        return {
          revision: 10,
          event: {
            type: 'plugin.updated',
            revision: 10,
            resource: 'plugin',
          },
          pluginId: 'plugin-a',
          provider: 'provider-a',
          enabled: true,
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createPluginCommand({
      baseRevision: 1,
      plugin: {
        name: 'plugin-a',
        script: 'Risuai.log("hello")',
        arguments: { token: 'string' },
        realArg: { token: '' },
        customLink: [],
        argMeta: {},
        version: '3.0',
        enabled: true,
      },
    })
    await updatePluginCommand({
      baseRevision: 2,
      pluginId: 'plugin-a',
      patch: { realArg: { token: 'abc' } },
    })
    await deletePluginCommand({ baseRevision: 3, pluginId: 'plugin-a' })
    await enablePluginCommand({ baseRevision: 4, pluginId: 'plugin-a', enabled: true })
    await selectPluginProviderCommand({ baseRevision: 5, provider: 'provider-a' })
    await reorderPluginsCommand({ baseRevision: 6, pluginIds: ['plugin-b', 'plugin-a'] })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/plugins',
        method: 'POST',
        body: {
          baseRevision: 1,
          plugin: {
            name: 'plugin-a',
            script: 'Risuai.log("hello")',
            arguments: { token: 'string' },
            realArg: { token: '' },
            customLink: [],
            argMeta: {},
            version: '3.0',
            enabled: true,
          },
        },
      },
      {
        url: '/api/v1/commands/plugins/plugin-a',
        method: 'PATCH',
        body: { baseRevision: 2, patch: { realArg: { token: 'abc' } } },
      },
      {
        url: '/api/v1/commands/plugins/plugin-a',
        method: 'DELETE',
        body: { baseRevision: 3 },
      },
      {
        url: '/api/v1/commands/plugins/plugin-a/enable',
        method: 'POST',
        body: { baseRevision: 4, enabled: true },
      },
      {
        url: '/api/v1/commands/plugins/provider',
        method: 'POST',
        body: { baseRevision: 5, provider: 'provider-a' },
      },
      {
        url: '/api/v1/commands/plugins/reorder',
        method: 'POST',
        body: { baseRevision: 6, pluginIds: ['plugin-b', 'plugin-a'] },
      },
    ])
  })

  it('exposes matching plugin mutations as compact response-confirmed local effects', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url, init) => {
      const method = init.method ?? 'GET'
      if (url.endsWith('/plugins/provider')) {
        return {
          revision: 10,
          event: {
            type: 'plugin.provider.selected',
            revision: 10,
            resource: 'pluginProvider',
            id: 'provider-a',
          },
          provider: 'provider-a',
        }
      }
      if (url.endsWith('/plugins/reorder')) {
        return {
          revision: 10,
          event: { type: 'plugin.reordered', revision: 10, resource: 'pluginCollection' },
        }
      }

      const operation =
        method === 'DELETE' ? 'delete' : url.endsWith('/enable') ? 'enable' : method === 'POST' ? 'create' : 'update'
      return {
        revision: 10,
        event: {
          type: `plugin.${operation === 'enable' ? 'enabled' : `${operation}d`}`,
          revision: 10,
          resource: 'pluginCollection',
          id: 'plugin-a',
        },
        pluginId: 'plugin-a',
        ...(operation === 'enable' ? { enabled: true } : {}),
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createPluginCommand({ baseRevision: 1, plugin: { name: 'plugin-a' } })
    await updatePluginCommand({ baseRevision: 2, pluginId: 'plugin-a', patch: { displayName: 'A' } })
    await deletePluginCommand({ baseRevision: 3, pluginId: 'plugin-a' })
    await enablePluginCommand({ baseRevision: 4, pluginId: 'plugin-a', enabled: true })
    await selectPluginProviderCommand({ baseRevision: 5, provider: 'provider-a' })
    await reorderPluginsCommand({ baseRevision: 6, pluginIds: ['plugin-b', 'plugin-a'] })

    expect(observedEffects).toEqual([
      { kind: 'pluginCollectionMutation', operation: 'create', pluginId: 'plugin-a' },
      { kind: 'pluginCollectionMutation', operation: 'update', pluginId: 'plugin-a' },
      { kind: 'pluginCollectionMutation', operation: 'delete', pluginId: 'plugin-a' },
      { kind: 'pluginCollectionMutation', operation: 'enable', pluginId: 'plugin-a' },
      { kind: 'pluginProvider', provider: 'provider-a' },
      {
        kind: 'pluginCollectionMutation',
        operation: 'reorder',
        pluginIds: ['plugin-b', 'plugin-a'],
      },
    ])
  })

  it('keeps cross-resource plugin deletion on authoritative reconciliation', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 10,
      event: {
        type: 'plugin.deleted',
        revision: 10,
        resource: 'pluginCollectionWithProvider',
        id: 'plugin-a',
      },
      pluginId: 'plugin-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await deletePluginCommand({ baseRevision: 9, pluginId: 'plugin-a' })

    expect(observedEffects).toEqual([])
  })

  it('dispatches plugin-storage commands through typed helpers', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url, init) => {
      if (url.includes('/plugin-storage')) {
        const operation = url.endsWith('/bulk') ? 'bulk' : init.method === 'DELETE' ? 'delete' : 'put'
        return {
          revision: 10,
          event: {
            type:
              operation === 'put'
                ? 'pluginStorage.updated'
                : operation === 'delete'
                  ? 'pluginStorage.deleted'
                  : 'pluginStorage.bulkUpdated',
            revision: 10,
            resource: 'pluginStorage',
            ...(operation === 'bulk' ? {} : { id: 'theme' }),
          },
          ...(operation === 'bulk' ? {} : { key: 'theme' }),
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await putPluginStorageCommand({ baseRevision: 1, key: 'theme', value: { mode: 'dark' } })
    await deletePluginStorageCommand({ baseRevision: 2, key: 'theme' })
    await bulkPluginStorageCommand({
      baseRevision: 3,
      values: { score: 42 },
      deleteKeys: ['old'],
      clear: false,
    })

    expect(observedEffects).toEqual([
      { kind: 'pluginStorage', operation: 'put', key: 'theme' },
      { kind: 'pluginStorage', operation: 'delete', key: 'theme' },
      { kind: 'pluginStorage', operation: 'bulk' },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/plugin-storage/theme',
        method: 'PUT',
        body: { baseRevision: 1, value: { mode: 'dark' } },
      },
      {
        url: '/api/v1/commands/plugin-storage/theme',
        method: 'DELETE',
        body: { baseRevision: 2 },
      },
      {
        url: '/api/v1/commands/plugin-storage/bulk',
        method: 'POST',
        body: { baseRevision: 3, values: { score: 42 }, deleteKeys: ['old'], clear: false },
      },
    ])
  })
})
