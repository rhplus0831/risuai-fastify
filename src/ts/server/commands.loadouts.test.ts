import { makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createLoadoutCommand,
  deleteLoadoutCommand,
  favoriteLoadoutCommand,
  touchLoadoutCommand,
  updateLoadoutCommand,
  setServerCommandSuccessReconciler,
} from './commands'

function canonicalLoadoutSnapshot(id = 'loadout-a') {
  return {
    id,
    name: 'A',
    lastUsed: 100,
    favorite: false,
    characterIds: ['char-a'],
    modules: ['module-a'],
    globalVariables: { mood: 'bright' },
    presetName: 'Preset A',
    modelPresetId: '',
    modelPresetName: '',
    promptPresetId: '',
    promptPresetName: '',
    personaId: 'persona-a',
  }
}

describe('loadout command adapters', () => {
  it('dispatches loadout commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/loadouts/loadout-a/touch')) {
        return {
          revision: 6,
          event: { type: 'loadout.touched', revision: 6, resource: 'loadout', id: 'loadout-a' },
          loadoutId: 'loadout-a',
        }
      }
      if (url.endsWith('/loadouts/loadout-a/favorite')) {
        return {
          revision: 5,
          event: { type: 'loadout.favorited', revision: 5, resource: 'loadout', id: 'loadout-a' },
          loadoutId: 'loadout-a',
        }
      }
      if (url.endsWith('/loadouts/loadout-b')) {
        return {
          revision: 4,
          event: { type: 'loadout.deleted', revision: 4, resource: 'loadout', id: 'loadout-b' },
          loadoutId: 'loadout-b',
        }
      }
      if (url.endsWith('/loadouts/loadout-a')) {
        return {
          revision: 3,
          event: { type: 'loadout.updated', revision: 3, resource: 'loadout', id: 'loadout-a' },
          loadoutId: 'loadout-a',
        }
      }
      return {
        revision: 2,
        event: { type: 'loadout.created', revision: 2, resource: 'loadout', id: 'loadout-a' },
        loadoutId: 'loadout-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createLoadoutCommand({
        baseRevision: 1,
        loadout: canonicalLoadoutSnapshot(),
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, loadoutId: 'loadout-a' })

    await expect(
      updateLoadoutCommand({
        baseRevision: 2,
        loadoutId: 'loadout-a',
        patch: { name: 'A updated' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, loadoutId: 'loadout-a' })

    await expect(
      deleteLoadoutCommand({
        baseRevision: 3,
        loadoutId: 'loadout-b',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, loadoutId: 'loadout-b' })

    await expect(
      favoriteLoadoutCommand({
        baseRevision: 4,
        loadoutId: 'loadout-a',
        favorite: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, loadoutId: 'loadout-a' })

    await expect(
      touchLoadoutCommand({
        baseRevision: 5,
        loadoutId: 'loadout-a',
        lastUsed: 1234,
        characterId: 'char-b',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6, loadoutId: 'loadout-a' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/loadouts',
        method: 'POST',
        body: {
          baseRevision: 1,
          loadout: canonicalLoadoutSnapshot(),
        },
      },
      {
        url: '/api/v1/commands/loadouts/loadout-a',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { name: 'A updated' },
        },
      },
      {
        url: '/api/v1/commands/loadouts/loadout-b',
        method: 'DELETE',
        body: {
          baseRevision: 3,
        },
      },
      {
        url: '/api/v1/commands/loadouts/loadout-a/favorite',
        method: 'POST',
        body: {
          baseRevision: 4,
          favorite: true,
        },
      },
      {
        url: '/api/v1/commands/loadouts/loadout-a/touch',
        method: 'POST',
        body: {
          baseRevision: 5,
          lastUsed: 1234,
          characterId: 'char-b',
        },
      },
    ])
  })

  it('exposes only opted-in matching loadout acknowledgements as scoped local effects', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let touchCount = 0
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/favorite')) {
        return {
          revision: 5,
          event: { type: 'loadout.favorited', revision: 5, resource: 'loadout', id: 'loadout-a' },
          loadoutId: 'loadout-a',
        }
      }
      touchCount += 1
      return {
        revision: 6 + touchCount,
        event: {
          type: 'loadout.touched',
          revision: 6 + touchCount,
          resource: 'loadout',
          id: touchCount === 1 ? 'loadout-a' : 'mismatched-loadout',
        },
        loadoutId: 'loadout-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await favoriteLoadoutCommand({
      baseRevision: 4,
      loadoutId: 'loadout-a',
      favorite: true,
    })
    await favoriteLoadoutCommand({
      baseRevision: 5,
      loadoutId: 'loadout-a',
      favorite: true,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 11,
    })
    await touchLoadoutCommand({
      baseRevision: 6,
      loadoutId: 'loadout-a',
      lastUsed: 1234,
      characterId: 'char-b',
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 11,
      settingsProjectionEpoch: 17,
      loadedName: 'Loadout A',
    })
    await touchLoadoutCommand({
      baseRevision: 7,
      loadoutId: 'loadout-a',
      lastUsed: 1235,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 11,
      settingsProjectionEpoch: 17,
      loadedName: 'Loadout A',
    })

    expect(observedEffects).toEqual([
      {
        kind: 'loadoutMutation',
        operation: 'favorite',
        loadoutId: 'loadout-a',
        loadoutsProjectionEpoch: 11,
      },
      {
        kind: 'loadoutMutation',
        operation: 'touch',
        loadoutId: 'loadout-a',
        loadoutsProjectionEpoch: 11,
        settingsProjectionEpoch: 17,
        loadedName: 'Loadout A',
      },
    ])
  })

  it('strictly validates optimistic loadout create/delete acknowledgements without transmitting metadata', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 20
    let createCount = 0
    let deleteCount = 0
    const commandFetch = makeCommandFetch((url) => {
      revision += 1
      if (url === '/api/v1/commands/loadouts') {
        createCount += 1
        return {
          revision,
          event: { type: 'loadout.created', revision, resource: 'loadout', id: 'loadout-a' },
          loadoutId: createCount === 5 ? 'mismatched-loadout' : 'loadout-a',
        }
      }
      deleteCount += 1
      return {
        revision,
        event: {
          type: 'loadout.deleted',
          revision,
          resource: 'loadout',
          id: deleteCount === 2 ? 'mismatched-loadout' : 'loadout-b',
        },
        loadoutId: 'loadout-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const canonicalLoadout = canonicalLoadoutSnapshot()
    const missingPromptName = { ...canonicalLoadout }
    Reflect.deleteProperty(missingPromptName, 'promptPresetName')

    await createLoadoutCommand({
      baseRevision: 1,
      loadout: canonicalLoadout,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 11,
    })
    await deleteLoadoutCommand({
      baseRevision: 2,
      loadoutId: 'loadout-b',
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 12,
    })
    await createLoadoutCommand({
      baseRevision: 3,
      loadout: { ...canonicalLoadout, legacyMetadata: true },
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 13,
    })
    await createLoadoutCommand({
      baseRevision: 4,
      loadout: missingPromptName,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 14,
    })
    await createLoadoutCommand({
      baseRevision: 5,
      loadout: canonicalLoadout,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: -1,
    })
    await createLoadoutCommand({
      baseRevision: 6,
      loadout: canonicalLoadout,
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 15,
    })
    await deleteLoadoutCommand({
      baseRevision: 7,
      loadoutId: 'loadout-b',
      acknowledgeOptimistic: true,
      loadoutsProjectionEpoch: 16,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'loadoutMutation',
        operation: 'create',
        loadoutId: 'loadout-a',
        loadoutsProjectionEpoch: 11,
      },
      {
        kind: 'loadoutMutation',
        operation: 'delete',
        loadoutId: 'loadout-b',
        loadoutsProjectionEpoch: 12,
      },
    ])
    expect(commandFetch.calls[0].body).toEqual({ baseRevision: 1, loadout: canonicalLoadout })
    expect(commandFetch.calls[1].body).toEqual({ baseRevision: 2 })
  })
})
