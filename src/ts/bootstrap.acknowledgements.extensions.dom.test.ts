import { setupBootstrapTests, bootstrapMocks } from './bootstrap.testSupport'
import { describe, expect, it } from 'vitest'
import { loadWebInitialDatabase } from './bootstrap'
import { peekAppliedServerResourceRevision } from './server/commands'
import {
  applyCollectionsResource,
  captureCollectionProjectionEpoch,
  hasCollectionProjectionEpochChanged,
} from './server/resourceState.svelte'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const { resourceApi, commandApi } = bootstrapMocks

setupBootstrapTests()

describe('API-backed client bootstrap', () => {
  it('acknowledges contiguous optimistic plugin storage without fetching the full map', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().pluginCustomStorage = { local: { nested: true } }
    })
    const event = {
      type: 'pluginStorage.updated',
      revision: 6,
      resource: 'pluginStorage',
      id: 'local',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([[6, { kind: 'pluginStorage', operation: 'put', key: 'local' }]]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().pluginCustomStorage).toEqual({ local: { nested: true } })
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges contiguous plugin mutations without fetching scripts or provider settings', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().plugins = [
        { name: 'plugin-b', script: 'newer-b' },
        { name: 'plugin-a', script: 'newer-a' },
      ] as never
      getDatabase().currentPluginProvider = 'newer-provider'
    })
    const collectionEvent = {
      type: 'plugin.reordered',
      revision: 6,
      resource: 'pluginCollection',
    }
    const providerEvent = {
      type: 'plugin.provider.selected',
      revision: 7,
      resource: 'pluginProvider',
      id: 'accepted-provider',
    }

    await commandApi.reconciler?.(
      providerEvent,
      [collectionEvent, providerEvent],
      new Map([
        [
          6,
          {
            kind: 'pluginCollectionMutation',
            operation: 'reorder',
            pluginIds: ['plugin-a', 'plugin-b'],
          },
        ],
        [7, { kind: 'pluginProvider', provider: 'accepted-provider' }],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().plugins).toEqual([
      { name: 'plugin-b', script: 'newer-b' },
      { name: 'plugin-a', script: 'newer-a' },
    ])
    expect(getDatabase().currentPluginProvider).toBe('newer-provider')
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('acknowledges contiguous optimistic module definitions and enablement without resource reads', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().modules = [
        { id: 'mod-b', name: 'Newer B', description: '', cjs: 'newer-b' },
        { id: 'mod-a', name: 'Newer A', description: '', cjs: 'newer-a' },
      ]
      getDatabase().enabledModules = ['mod-b']
    })
    const collectionEvent = {
      type: 'module.reordered',
      revision: 6,
      resource: 'moduleReordered',
    }
    const enabledEvent = {
      type: 'module.enabled',
      revision: 7,
      resource: 'moduleEnabled',
      id: 'mod-a',
    }

    await commandApi.reconciler?.(
      enabledEvent,
      [collectionEvent, enabledEvent],
      new Map([
        [
          6,
          {
            kind: 'moduleCollectionMutation',
            operation: 'reorder',
            moduleIds: ['mod-a', 'mod-b'],
          },
        ],
        [7, { kind: 'moduleEnabled', moduleId: 'mod-a', enabled: true }],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().modules.map((module) => [module.id, module.cjs])).toEqual([
      ['mod-b', 'newer-b'],
      ['mod-a', 'newer-a'],
    ])
    expect(getDatabase().enabledModules).toEqual(['mod-b'])
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('acknowledges exact module definition writes while their collection projection is current', async () => {
    await loadWebInitialDatabase()
    const optimisticCollectionEpoch = captureCollectionProjectionEpoch('modules')
    withTestDatabaseWrite(() => {
      getDatabase().modules = [
        {
          id: 'mod-a',
          name: 'A',
          description: '',
          regex: [{ id: 'script-newer', out: 'newer' }],
          trigger: [{ id: 'trigger-newer', comment: 'newer' }],
        },
      ] as never
    })
    const scriptsEvent = {
      type: 'scriptDefinitions.replaced',
      revision: 6,
      resource: 'moduleScriptDefinition',
      id: 'mod-a',
    }
    const triggersEvent = {
      type: 'triggerDefinitions.replaced',
      revision: 7,
      resource: 'moduleTriggerDefinition',
      id: 'mod-a',
    }

    await commandApi.reconciler?.(
      triggersEvent,
      [scriptsEvent, triggersEvent],
      new Map([
        [
          6,
          {
            kind: 'moduleCollectionMutation',
            operation: 'scripts',
            moduleId: 'mod-a',
            collectionProjectionEpoch: optimisticCollectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'moduleCollectionMutation',
            operation: 'triggers',
            moduleId: 'mod-a',
            collectionProjectionEpoch: optimisticCollectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().modules[0].regex).toEqual([{ id: 'script-newer', out: 'newer' }])
    expect(getDatabase().modules[0].trigger).toEqual([{ id: 'trigger-newer', comment: 'newer' }])
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it.each([
    ['missing', undefined],
    ['negative', -1],
    ['fractional', 1.5],
  ])('falls back for a %s module definition projection epoch', async (_label, collectionProjectionEpoch) => {
    await loadWebInitialDatabase()
    const event = {
      type: 'scriptDefinitions.replaced',
      revision: 6,
      resource: 'moduleScriptDefinition',
      id: 'mod-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'moduleCollectionMutation',
            operation: 'scripts',
            moduleId: 'mod-a',
            collectionProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('falls back when the module collection advances before a definition acknowledgement', async () => {
    await loadWebInitialDatabase()
    const optimisticCollectionEpoch = captureCollectionProjectionEpoch('modules')
    applyCollectionsResource(
      {
        revision: 6,
        collections: {
          modules: [{ id: 'mod-a', name: 'Authoritative', description: '', regex: [], trigger: [] }],
        },
      },
      'modules',
    )
    const event = {
      type: 'triggerDefinitions.replaced',
      revision: 7,
      resource: 'moduleTriggerDefinition',
      id: 'mod-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          7,
          {
            kind: 'moduleCollectionMutation',
            operation: 'triggers',
            moduleId: 'mod-a',
            collectionProjectionEpoch: optimisticCollectionEpoch,
          },
        ],
      ]),
    )

    expect(hasCollectionProjectionEpochChanged('modules', optimisticCollectionEpoch)).toBe(true)
    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('keeps mismatched module acknowledgements on authoritative reconciliation', async () => {
    await loadWebInitialDatabase()
    const event = {
      type: 'module.updated',
      revision: 6,
      resource: 'moduleUpdated',
      id: 'mod-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'moduleCollectionMutation',
            operation: 'scripts',
            moduleId: 'mod-a',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })
})
