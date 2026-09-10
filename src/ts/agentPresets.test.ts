import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'test-auth-token',
}))
vi.mock('./process/modules', () => ({
  applyModule: vi.fn(),
  exportModule: vi.fn(),
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  importModule: vi.fn(),
  moduleUpdate: vi.fn(),
  readModule: vi.fn(),
  refreshModules: vi.fn(),
}))

import {
  createAgentPreset,
  createAgentPresetStep,
  currentPendingAgentPresetGeneratedProjectionLatch,
  deleteAgentPreset,
  deleteAgentPresetStep,
  duplicateAgentPreset,
  duplicateAgentPresetStep,
  getAgentPresetById,
  getAgentPresetDefaultId,
  getAgentPresets,
  isAgentPresetGeneratedProjectionResolved,
  mergePendingAgentPresetCharactersResource,
  mergePendingAgentPresetLoadoutsResource,
  mergePendingAgentPresetSettingsResource,
  reorderAgentPresets,
  reorderAgentPresetSteps,
  resetPendingAgentPresetMutationsForTests,
  setAgentPresetDefault,
  updateAgentPreset,
  updateAgentPresetStep,
} from './agentPresets'
import type { AgentPresetRecord, AgentPresetStepRecord } from './agentPresetRecords'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
} from './server/commands'
import {
  applyCharacterResource,
  applyCollectionsResource,
  charactersResourceState,
  collectionsResourceState,
  isSettingsGroupAcknowledgementTainted,
  resetServerResourceState,
  settingsResourceState,
} from './server/resourceState.svelte'
import {
  MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from './server/pendingMutationOutbox'
import { replayPendingMutations } from './server/pendingMutationReplay'
import { setDatabaseLite } from './storage/database.svelte'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function agentPresetProjectionSnapshot(): {
  agentPresets: AgentPresetRecord[]
  defaultId: string | undefined
} {
  return {
    agentPresets: clonePlain(getAgentPresets()),
    defaultId: getAgentPresetDefaultId(),
  }
}

async function prepareDurableAgentPresetOutbox(suffix: string): Promise<void> {
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  await preparePendingMutationOutbox({
    writerSessionId: `writer-agent-preset-${suffix}`,
    writerEpoch: 1,
    databaseLineage: `lineage-agent-preset-${suffix}`,
    requestedWriterWasActive: true,
  })
}

function step(overrides: Partial<AgentPresetStepRecord> = {}): AgentPresetStepRecord {
  return {
    id: 'aps_a',
    name: 'Step A',
    enabled: true,
    phase: 'beforeMain',
    dependencies: [],
    instruction: 'Original instruction',
    model: { mode: 'inheritMain' },
    runtime: {},
    inputScopes: [],
    outputKey: 'step_a',
    outputFormat: 'text',
    destination: 'promptOutput',
    failurePolicy: { mode: 'required' },
    ...overrides,
  }
}

function preset(overrides: Partial<AgentPresetRecord> = {}): AgentPresetRecord {
  return {
    id: 'ap_a',
    name: 'Preset A',
    enabled: true,
    version: 1,
    steps: [step()],
    ...overrides,
  }
}

function seedAgentPresetDeleteReferences(): void {
  setDatabaseLite(
    {
      agentPresets: [preset(), preset({ id: 'ap_b', name: 'Preset B', steps: [] })],
      agentPresetDefaultId: 'ap_a',
      characters: [
        {
          chaId: 'char_a',
          name: 'Character A',
          chats: [
            {
              id: 'chat_a',
              name: 'Chat A',
              message: [],
              note: '',
              localLore: [],
              generationSettings: { agentPresetId: 'ap_a', configured: false },
            },
          ],
        },
      ],
      loadouts: [
        {
          id: 'loadout_a',
          name: 'Loadout A',
          lastUsed: 100,
          favorite: false,
          characterIds: ['char_a'],
          modules: [],
          globalVariables: { mood: 'initial' },
          presetName: '',
          agentPresetId: 'ap_a',
          agentPresetName: 'Preset A',
          personaId: '',
        },
      ],
    } as never,
    1,
  )
}

beforeEach(() => {
  resetPendingMutationOutboxForTests()
  resetPendingAgentPresetMutationsForTests()
  resetServerResourceState()
  setDatabaseLite({ agentPresets: [preset()], characters: [] } as never, 1)
  clearCachedServerCommandRevision()
  clearAppliedServerResourceRevision()
  setCachedServerCommandRevision(1)
  setServerCommandSuccessReconciler(null)
})

afterEach(() => {
  resetPendingMutationOutboxForTests()
  resetPendingAgentPresetMutationsForTests()
  setServerCommandSuccessReconciler(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Agent Preset resource owners', () => {
  it('fails closed on duplicate ready owner ids without falling back to the compatibility projection', async () => {
    resetServerResourceState()
    setDatabaseLite(
      {
        agentPresets: [preset(), preset({ id: 'ap_b', name: 'Preset B', steps: [] })],
        agentPresetDefaultId: 'ap_a',
        characters: [],
      } as never,
      1,
    )
    ;(settingsResourceState.value as Record<string, unknown>).agentPresets = [
      preset(),
      preset({ id: 'ap_a', name: 'Duplicate Preset A', steps: [] }),
    ]
    const fetchMock = vi.fn(async () => response({ error: 'rejected' }, 400))
    vi.stubGlobal('fetch', fetchMock)

    expect(getAgentPresets()).toEqual([])
    expect(getAgentPresetById('ap_a')).toBeUndefined()
    expect(getAgentPresetDefaultId()).toBeUndefined()
    await expect(updateAgentPreset('ap_a', { name: 'Must not write' })).resolves.toMatchObject({ status: 'failed' })
    expect((settingsResourceState.value as Record<string, any>).agentPresets[0].name).toBe('Preset A')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('fails closed on settings owner errors without falling back to the compatibility projection', async () => {
    settingsResourceState.groupStatuses.agents = 'error'
    settingsResourceState.groupErrors.agents = 'owner unavailable'
    const fetchMock = vi.fn(async () => response({ error: 'rejected' }, 400))
    vi.stubGlobal('fetch', fetchMock)

    expect(getAgentPresets()).toEqual([])
    expect(getAgentPresetById('ap_a')).toBeUndefined()
    expect(getAgentPresetDefaultId()).toBeUndefined()
    await expect(updateAgentPreset('ap_a', { name: 'Must not write' })).resolves.toMatchObject({ status: 'failed' })
    expect((settingsResourceState.value as Record<string, any>).agentPresets[0].name).toBe('Preset A')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not clear references when ready character or loadout owners lose stable-id uniqueness', async () => {
    seedAgentPresetDeleteReferences()
    charactersResourceState.characters = [
      ...charactersResourceState.characters,
      clonePlain(charactersResourceState.characters[0]),
    ]
    collectionsResourceState.values.loadouts = [
      ...(collectionsResourceState.values.loadouts ?? []),
      clonePlain(collectionsResourceState.values.loadouts?.[0]),
    ] as never
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'rejected' }, 400)),
    )

    await expect(deleteAgentPreset('ap_a')).resolves.toMatchObject({ status: 'failed' })
    expect(charactersResourceState.characters[0].chats[0].generationSettings?.agentPresetId).toBe('ap_a')
    expect(collectionsResourceState.values.loadouts?.[0]).toMatchObject({
      agentPresetId: 'ap_a',
      agentPresetName: 'Preset A',
    })
  })

  it('does not clear references when character or loadout owners report errors', async () => {
    seedAgentPresetDeleteReferences()
    charactersResourceState.status = 'error'
    collectionsResourceState.statuses.loadouts = 'error'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'rejected' }, 400)),
    )

    await expect(deleteAgentPreset('ap_a')).resolves.toMatchObject({ status: 'failed' })
    expect(charactersResourceState.characters[0].chats[0].generationSettings?.agentPresetId).toBe('ap_a')
    expect(collectionsResourceState.values.loadouts?.[0]).toMatchObject({
      agentPresetId: 'ap_a',
      agentPresetName: 'Preset A',
    })
  })

  it('does not mutate compatibility references before owners are ready', async () => {
    seedAgentPresetDeleteReferences()
    settingsResourceState.groupStatuses.agents = 'loading'
    collectionsResourceState.statuses.loadouts = 'loading'
    charactersResourceState.status = 'loading'
    const pendingResponse = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pendingResponse.promise),
    )

    const resultPromise = deleteAgentPreset('ap_a')
    expect(getDatabase().characters[0].chats[0].generationSettings?.agentPresetId).toBe('ap_a')
    expect(getDatabase().loadouts[0]).toMatchObject({ agentPresetId: 'ap_a', agentPresetName: 'Preset A' })
    pendingResponse.resolve(response({ error: 'rejected' }, 400))

    await expect(resultPromise).resolves.toMatchObject({ status: 'failed' })
    expect(getDatabase().characters[0].chats[0].generationSettings?.agentPresetId).toBe('ap_a')
    expect(getDatabase().loadouts[0]).toMatchObject({ agentPresetId: 'ap_a', agentPresetName: 'Preset A' })
  })
})

describe('Agent Preset optimistic field rollback', () => {
  it('does not emit projection-epoch effects for response-confirmed reorder/default writes', async () => {
    resetServerResourceState()
    setDatabaseLite(
      {
        agentPresets: [preset(), preset({ id: 'ap_b', name: 'Preset B', steps: [] })],
        agentPresetDefaultId: 'ap_a',
        characters: [],
      } as never,
      1,
    )
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      if (url.endsWith('/agent-presets/reorder')) {
        return response(
          {
            revision: 2,
            event: { type: 'agentPreset.reordered', revision: 2, resource: 'agentPreset' },
            agentPresetDefaultId: 'ap_a',
            certificate: 'agent-preset-collection-v1',
            agentPresetIds: ['ap_b', 'ap_a'],
          },
          200,
        )
      }
      if (url.endsWith('/agent-presets/default')) {
        return response(
          {
            revision: 3,
            event: {
              type: 'agentPreset.default.updated',
              revision: 3,
              resource: 'agentPreset',
              id: 'ap_b',
            },
            agentPresetDefaultId: 'ap_b',
            certificate: 'agent-preset-collection-v1',
            agentPresetIds: ['ap_b', 'ap_a'],
          },
          200,
        )
      }
      throw new Error(`Unexpected command URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await reorderAgentPresets(['ap_b', 'ap_a'])
    await setAgentPresetDefault('ap_b')

    expect(observedEffects).toEqual([])
    expect(getDatabase().agentPresets.map((candidate) => candidate.id)).toEqual(['ap_b', 'ap_a'])
    expect(getDatabase().agentPresetDefaultId).toBe('ap_b')
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([
      { baseRevision: 1, presetIds: ['ap_b', 'ap_a'] },
      { baseRevision: 2, agentPresetId: 'ap_b' },
    ])
  })

  it('withholds local effects for missing or contradictory collection receipts', async () => {
    resetServerResourceState()
    setDatabaseLite(
      {
        agentPresets: [preset(), preset({ id: 'ap_b', name: 'Preset B', steps: [] })],
        agentPresetDefaultId: 'ap_a',
        characters: [],
      } as never,
      1,
    )
    let responseIndex = 0
    const bodies = [
      {
        revision: 2,
        event: { type: 'agentPreset.reordered', revision: 2, resource: 'agentPreset' },
        agentPresetDefaultId: 'ap_a',
        agentPresetIds: ['ap_b', 'ap_a'],
      },
      {
        revision: 3,
        event: {
          type: 'agentPreset.default.updated',
          revision: 3,
          resource: 'agentPreset',
          id: 'ap_b',
        },
        agentPresetDefaultId: 'ap_b',
        certificate: 'agent-preset-collection-v1',
        agentPresetIds: ['ap_a', 'ap_b'],
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(bodies[responseIndex++], 200)),
    )
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    await reorderAgentPresets(['ap_b', 'ap_a'])
    await setAgentPresetDefault('ap_b')

    expect(observedEffectCounts).toEqual([0, 0])
  })

  it('restores failed delete references by stable id while preserving concurrent chat and loadout edits', async () => {
    seedAgentPresetDeleteReferences()
    const pendingResponse = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pendingResponse.promise),
    )

    const resultPromise = deleteAgentPreset('ap_a')
    expect(getDatabase().agentPresets.map((candidate) => candidate.id)).toEqual(['ap_b'])
    expect(getDatabase()).not.toHaveProperty('agentPresetDefaultId')
    expect(getDatabase().characters[0].chats[0].generationSettings?.agentPresetId).toBeUndefined()
    expect(getDatabase().loadouts[0].agentPresetId).toBeUndefined()
    expect(getDatabase().loadouts[0].agentPresetName).toBeUndefined()

    withTestDatabaseWrite(() => {
      const chat = getDatabase().characters[0].chats[0]
      chat.name = 'Edited Chat A'
      chat.generationSettings!.configured = true
      const loadout = getDatabase().loadouts[0]
      loadout.name = 'Edited Loadout A'
      loadout.globalVariables.mood = 'edited'
    })
    pendingResponse.resolve(response({ error: 'rejected' }, 400))

    await expect(resultPromise).resolves.toEqual({
      status: 'failed',
      result: { status: 'error', error: 'rejected', reason: 'invalid-request' },
    })
    expect(getDatabase().agentPresets.map((candidate) => candidate.id)).toEqual(['ap_a', 'ap_b'])
    expect(getDatabase().agentPresetDefaultId).toBe('ap_a')
    expect(getDatabase().characters[0].chats[0]).toMatchObject({
      name: 'Edited Chat A',
      generationSettings: { agentPresetId: 'ap_a', configured: true },
    })
    expect(getDatabase().loadouts[0]).toMatchObject({
      name: 'Edited Loadout A',
      globalVariables: { mood: 'edited' },
      agentPresetId: 'ap_a',
      agentPresetName: 'Preset A',
    })
    expect(isSettingsGroupAcknowledgementTainted('agents')).toBe(false)
  })

  it('re-reads delete references whose owner identity changes before rollback', async () => {
    seedAgentPresetDeleteReferences()
    const authoritativeCharacter = clonePlain(getDatabase().characters[0])
    const authoritativeLoadout = clonePlain(getDatabase().loadouts[0])
    const pendingResponse = deferred<Response>()
    const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      if (url.endsWith('/agent-presets/ap_a') && init.method === 'DELETE') return pendingResponse.promise
      if (url === '/api/v1/characters/char_a') {
        return Promise.resolve(response({ revision: 3, character: authoritativeCharacter }, 200))
      }
      if (url === '/api/v1/collections/loadouts') {
        return Promise.resolve(
          response(
            {
              revision: 3,
              collections: { loadouts: [authoritativeLoadout] },
            },
            200,
          ),
        )
      }
      throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = deleteAgentPreset('ap_a')
    const refreshedCharacter = clonePlain(getDatabase().characters[0])
    refreshedCharacter.name = 'Character refreshed during delete'
    expect(applyCharacterResource({ revision: 2, character: refreshedCharacter })).toBe(true)
    expect(
      applyCollectionsResource(
        {
          revision: 2,
          collections: { loadouts: clonePlain(getDatabase().loadouts) },
        },
        'loadouts',
      ),
    ).toBe(true)
    pendingResponse.resolve(response({ error: 'rejected' }, 400))

    await expect(resultPromise).resolves.toMatchObject({ status: 'failed' })
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chats[0].generationSettings?.agentPresetId).toBe('ap_a')
      expect(getDatabase().loadouts[0]).toMatchObject({
        agentPresetId: 'ap_a',
        agentPresetName: 'Preset A',
      })
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/characters/char_a', expect.any(Object))
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/collections/loadouts', expect.any(Object))
  })

  it('preserves newer chat and loadout Agent Preset selections when a delete fails', async () => {
    seedAgentPresetDeleteReferences()
    const pendingResponse = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pendingResponse.promise),
    )

    const resultPromise = deleteAgentPreset('ap_a')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings!.agentPresetId = 'ap_b'
      getDatabase().loadouts[0].agentPresetId = 'ap_b'
      getDatabase().loadouts[0].agentPresetName = 'Preset B'
    })
    pendingResponse.resolve(response({ error: 'revision_conflict', currentRevision: 2 }, 409))

    await expect(resultPromise).resolves.toEqual({
      status: 'failed',
      result: { status: 'conflict', currentRevision: 2 },
    })
    expect(getDatabase().characters[0].chats[0].generationSettings?.agentPresetId).toBe('ap_b')
    expect(getDatabase().loadouts[0]).toMatchObject({
      agentPresetId: 'ap_b',
      agentPresetName: 'Preset B',
    })
    expect(isSettingsGroupAcknowledgementTainted('agents')).toBe(false)
  })

  it('does not recreate or mutate delete-reference targets superseded by structural edits', async () => {
    seedAgentPresetDeleteReferences()
    const pendingResponse = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pendingResponse.promise),
    )

    const resultPromise = deleteAgentPreset('ap_a')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats = []
      getDatabase().loadouts = []
    })
    pendingResponse.resolve(response({ error: 'rejected' }, 400))

    await expect(resultPromise).resolves.toEqual({
      status: 'failed',
      result: { status: 'error', error: 'rejected', reason: 'invalid-request' },
    })
    expect(getDatabase().characters[0].chats).toEqual([])
    expect(getDatabase().loadouts).toEqual([])
    expect(isSettingsGroupAcknowledgementTainted('agents')).toBe(false)
  })

  it('rolls back failed metadata fields while preserving a later edit', async () => {
    const pendingResponse = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pendingResponse.promise),
    )

    const resultPromise = updateAgentPreset('ap_a', { name: 'Failed name', enabled: false })
    expect(getDatabase().agentPresets[0]).toMatchObject({ name: 'Failed name', enabled: false })
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets[0].name = 'Newer local name'
    })
    pendingResponse.resolve(response({ error: 'revision_conflict', currentRevision: 2 }, 409))

    await expect(resultPromise).resolves.toEqual({
      status: 'failed',
      result: { status: 'conflict', currentRevision: 2 },
    })
    expect(getDatabase().agentPresets[0]).toMatchObject({
      name: 'Newer local name',
      enabled: true,
    })
    expect(isSettingsGroupAcknowledgementTainted('agents')).toBe(false)
  })

  it('rolls back only matching failed step fields while retaining a later step edit', async () => {
    const pendingResponse = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pendingResponse.promise),
    )

    const resultPromise = updateAgentPresetStep('ap_a', 'aps_a', {
      outputKey: 'failed_key',
      instruction: 'Failed instruction',
    })
    expect(getDatabase().agentPresets[0].steps[0]).toMatchObject({
      outputKey: 'failed_key',
      instruction: 'Failed instruction',
    })
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets[0].steps[0].instruction = 'Newer local instruction'
    })
    pendingResponse.resolve(response({ error: 'rejected' }, 400))

    await expect(resultPromise).resolves.toEqual({
      status: 'failed',
      result: { status: 'error', error: 'rejected', reason: 'invalid-request' },
    })
    expect(getDatabase().agentPresets[0].steps[0]).toMatchObject({
      outputKey: 'step_a',
      instruction: 'Newer local instruction',
    })
    expect(isSettingsGroupAcknowledgementTainted('agents')).toBe(false)
  })

  it.each([
    ['preset delete', () => deleteAgentPreset('ap_a')],
    ['preset reorder', () => reorderAgentPresets(['ap_b', 'ap_a'])],
    ['default selection', () => setAgentPresetDefault('ap_b')],
    ['step delete', () => deleteAgentPresetStep('ap_a', 'aps_a')],
    ['step reorder', () => reorderAgentPresetSteps('ap_a', ['aps_b', 'aps_a'])],
  ])('rolls back a failed optimistic %s without tainting the owner', async (_label, runCommand) => {
    resetServerResourceState()
    setDatabaseLite(
      {
        agentPresets: [
          preset({ steps: [step(), step({ id: 'aps_b', name: 'Step B', outputKey: 'step_b' })] }),
          preset({ id: 'ap_b', name: 'Preset B', steps: [] }),
        ],
        characters: [],
      } as never,
      1,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'rejected' }, 400)),
    )
    const before = agentPresetProjectionSnapshot()

    await expect(runCommand()).resolves.toEqual({
      status: 'failed',
      result: { status: 'error', error: 'rejected', reason: 'invalid-request' },
    })

    expect(agentPresetProjectionSnapshot()).toEqual(before)
    expect(isSettingsGroupAcknowledgementTainted('agents')).toBe(false)
  })

  it('preserves a later accepted field patch without tainting a failed step reorder', async () => {
    resetServerResourceState()
    setDatabaseLite(
      {
        agentPresets: [preset({ steps: [step(), step({ id: 'aps_b', name: 'Step B', outputKey: 'step_b' })] })],
        characters: [],
      } as never,
      1,
    )
    const pendingReorder = deferred<Response>()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/agent-presets/ap_a/steps/reorder')) return pendingReorder.promise
      if (url.endsWith('/agent-presets/ap_a/steps/aps_b')) {
        return Promise.resolve(
          response(
            {
              revision: 3,
              event: {
                type: 'agentPreset.step.updated',
                revision: 3,
                resource: 'agentPreset',
                id: 'aps_b',
                parentId: 'ap_a',
              },
              presetId: 'ap_a',
              stepId: 'aps_b',
              acknowledgedKeys: ['instruction'],
              canonicalValues: { instruction: 'Accepted instruction' },
              canonicalDeletedKeys: [],
              updatedAt: 300,
            },
            200,
          ),
        )
      }
      throw new Error(`Unexpected command URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const authoritativeAgentsRead = vi.fn()
    const localRevisionFence = vi.fn()
    setServerCommandSuccessReconciler((_event, events, localEffects) => {
      const localEffect = [...localEffects.values()][0]
      if (localEffect?.kind === 'agentPresetStepPatch' && isSettingsGroupAcknowledgementTainted('agents')) {
        authoritativeAgentsRead(events)
        return
      }
      localRevisionFence()
    })

    const reorderResult = reorderAgentPresetSteps('ap_a', ['aps_b', 'aps_a'])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const updateResult = updateAgentPresetStep('ap_a', 'aps_b', { instruction: 'Accepted instruction' })
    expect(getDatabase().agentPresets[0].steps.map((candidate) => candidate.id)).toEqual(['aps_b', 'aps_a'])
    expect(getDatabase().agentPresets[0].steps[0].instruction).toBe('Accepted instruction')

    pendingReorder.resolve(response({ error: 'revision_conflict', currentRevision: 2 }, 409))

    await expect(Promise.all([reorderResult, updateResult])).resolves.toEqual([
      { status: 'failed', result: { status: 'conflict', currentRevision: 2 } },
      { status: 'accepted', result: expect.objectContaining({ status: 'ok', revision: 3 }) },
    ])
    expect(getDatabase().agentPresets[0].steps.map((candidate) => candidate.id)).toEqual(['aps_b', 'aps_a'])
    expect(getDatabase().agentPresets[0].steps[0].instruction).toBe('Accepted instruction')
    expect(isSettingsGroupAcknowledgementTainted('agents')).toBe(false)
    expect(authoritativeAgentsRead).not.toHaveBeenCalled()
    expect(localRevisionFence).toHaveBeenCalledOnce()
  })
})

describe('Agent Preset ordered mutation durability', () => {
  it('rebases two terminal preset field attempts back to the authoritative baseline', async () => {
    const pending = [deferred<Response>(), deferred<Response>()]
    let requestIndex = 0
    const fetchMock = vi.fn(() => pending[requestIndex++].promise)
    vi.stubGlobal('fetch', fetchMock)

    const first = updateAgentPreset('ap_a', { name: 'Attempt A' })
    const second = updateAgentPreset('ap_a', { name: 'Attempt B' })
    expect(getDatabase().agentPresets[0].name).toBe('Attempt B')

    pending[0].resolve(response({ error: 'first rejected' }, 400))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(getDatabase().agentPresets[0].name).toBe('Attempt B')

    pending[1].resolve(response({ error: 'second rejected' }, 400))
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ status: 'failed' }, { status: 'failed' }])
    expect(getDatabase().agentPresets[0].name).toBe('Preset A')
  })

  it('rebases two terminal step field attempts back to the authoritative baseline', async () => {
    const pending = [deferred<Response>(), deferred<Response>()]
    let requestIndex = 0
    const fetchMock = vi.fn(() => pending[requestIndex++].promise)
    vi.stubGlobal('fetch', fetchMock)

    const first = updateAgentPresetStep('ap_a', 'aps_a', { instruction: 'Attempt A' })
    const second = updateAgentPresetStep('ap_a', 'aps_a', { instruction: 'Attempt B' })
    expect(getDatabase().agentPresets[0].steps[0].instruction).toBe('Attempt B')

    pending[0].resolve(response({ error: 'first rejected' }, 400))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(getDatabase().agentPresets[0].steps[0].instruction).toBe('Attempt B')

    pending[1].resolve(response({ error: 'second rejected' }, 400))
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ status: 'failed' }, { status: 'failed' }])
    expect(getDatabase().agentPresets[0].steps[0].instruction).toBe('Original instruction')
  })

  it('rebases terminal preset reorders and default selections independently', async () => {
    setDatabaseLite(
      {
        agentPresets: [
          preset(),
          preset({ id: 'ap_b', name: 'Preset B', steps: [] }),
          preset({ id: 'ap_c', name: 'Preset C', steps: [] }),
        ],
        agentPresetDefaultId: 'ap_a',
        characters: [],
      } as never,
      1,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'rejected' }, 400)),
    )

    const reorderA = reorderAgentPresets(['ap_b', 'ap_a', 'ap_c'])
    const reorderB = reorderAgentPresets(['ap_c', 'ap_b', 'ap_a'])
    await expect(Promise.all([reorderA, reorderB])).resolves.toMatchObject([{ status: 'failed' }, { status: 'failed' }])
    expect(getDatabase().agentPresets.map((candidate) => candidate.id)).toEqual(['ap_a', 'ap_b', 'ap_c'])

    const defaultB = setAgentPresetDefault('ap_b')
    const defaultC = setAgentPresetDefault('ap_c')
    await expect(Promise.all([defaultB, defaultC])).resolves.toMatchObject([{ status: 'failed' }, { status: 'failed' }])
    expect(getDatabase().agentPresetDefaultId).toBe('ap_a')
  })

  it('rebases a failed delete through a failed structural successor', async () => {
    setDatabaseLite(
      {
        agentPresets: [
          preset(),
          preset({ id: 'ap_b', name: 'Preset B', steps: [] }),
          preset({ id: 'ap_c', name: 'Preset C', steps: [] }),
        ],
        agentPresetDefaultId: 'ap_a',
        characters: [],
      } as never,
      1,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'rejected' }, 400)),
    )

    const deleting = deleteAgentPreset('ap_a')
    const reordering = reorderAgentPresets(['ap_c', 'ap_b'])
    expect(getDatabase().agentPresets.map((candidate) => candidate.id)).toEqual(['ap_c', 'ap_b'])

    await expect(Promise.all([deleting, reordering])).resolves.toMatchObject([
      { status: 'failed' },
      { status: 'failed' },
    ])
    expect(getDatabase().agentPresets.map((candidate) => candidate.id)).toEqual(['ap_a', 'ap_b', 'ap_c'])
    expect(getDatabase().agentPresetDefaultId).toBe('ap_a')
  })

  it('retains an exact sparse patch and overlays it on authoritative refreshes', async () => {
    await prepareDurableAgentPresetOutbox('sparse-patch')
    const pendingResponse = deferred<Response>()
    const fetchMock = vi.fn(() => pendingResponse.promise)
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = updateAgentPreset('ap_a', { name: 'Queued name' })
    expect(getDatabase().agentPresets[0].name).toBe('Queued name')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    pendingResponse.resolve(response({ error: 'temporary failure' }, 500))

    await expect(resultPromise).resolves.toMatchObject({ status: 'queued' })
    const pendingMutations = await listPendingMutations()
    expect(pendingMutations).toHaveLength(1)
    expect(pendingMutations[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/agent-presets/ap_a',
          body: { patch: { name: 'Queued name' } },
        },
      ],
    })

    const merged = mergePendingAgentPresetSettingsResource({
      agentPresets: [preset({ name: 'Authoritative name', description: 'Server description', enabled: false })],
      agentPresetDefaultId: 'ap_a',
    })
    expect(merged.agentPresets[0]).toMatchObject({
      name: 'Queued name',
      description: 'Server description',
      enabled: false,
    })
  })

  it('retires a retained patch overlay after an in-session replay accepts it', async () => {
    await prepareDurableAgentPresetOutbox('retained-patch-reconnect')
    let updateAttempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/mutation-receipts/ack')) return response({ acknowledged: 1, requested: 1 }, 200)
        if (!url.endsWith('/agent-presets/ap_a')) throw new Error(`Unexpected URL: ${url}`)
        updateAttempts += 1
        if (updateAttempts === 1) return response({ error: 'temporary failure' }, 500)
        return response(
          {
            revision: 2,
            event: { type: 'agentPreset.updated', revision: 2, resource: 'agentPreset', id: 'ap_a' },
            presetId: 'ap_a',
          },
          200,
        )
      }),
    )

    await expect(updateAgentPreset('ap_a', { name: 'Queued name' })).resolves.toMatchObject({ status: 'queued' })
    expect(
      mergePendingAgentPresetSettingsResource({ agentPresets: [preset({ name: 'Authoritative name' })] })
        .agentPresets[0].name,
    ).toBe('Queued name')

    await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1, retained: 0 })

    expect(
      mergePendingAgentPresetSettingsResource({ agentPresets: [preset({ name: 'Authoritative name' })] })
        .agentPresets[0].name,
    ).toBe('Authoritative name')
  })

  it('drops terminal intents, removes their overlays, and restores the projection', async () => {
    await prepareDurableAgentPresetOutbox('terminal')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'invalid patch' }, 400)),
    )

    await expect(updateAgentPreset('ap_a', { name: 'Rejected name' })).resolves.toMatchObject({
      status: 'failed',
      result: { status: 'error', reason: 'invalid-request' },
    })
    expect(getDatabase().agentPresets[0].name).toBe('Preset A')
    expect(await listPendingMutations()).toEqual([])
    expect(
      mergePendingAgentPresetSettingsResource({ agentPresets: [preset({ name: 'Authoritative name' })] })
        .agentPresets[0].name,
    ).toBe('Authoritative name')
  })

  it('retires an accepted overlay before authoritative event reconciliation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(
          {
            revision: 2,
            event: { type: 'agentPreset.updated', revision: 2, resource: 'agentPreset', id: 'ap_a' },
            presetId: 'ap_a',
          },
          200,
        ),
      ),
    )
    let reconciledName = ''
    setServerCommandSuccessReconciler(() => {
      reconciledName = mergePendingAgentPresetSettingsResource({
        agentPresets: [preset({ name: 'Server canonical name' })],
      }).agentPresets[0].name
    })

    await expect(updateAgentPreset('ap_a', { name: 'Attempted name' })).resolves.toMatchObject({
      status: 'accepted',
    })
    expect(reconciledName).toBe('Server canonical name')
  })

  it('drains a retained predecessor before accepting a later writer', async () => {
    await prepareDurableAgentPresetOutbox('successor')
    let commandCount = 0
    const commandBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url.endsWith('/mutation-receipts/ack')) return response({ acknowledged: true }, 200)
        if (!url.endsWith('/agent-presets/ap_a')) throw new Error(`Unexpected URL: ${url}`)
        commandCount += 1
        commandBodies.push(JSON.parse(String(init.body)))
        if (commandCount === 1) return response({ error: 'temporary failure' }, 500)
        const revision = commandCount
        return response(
          {
            revision,
            event: { type: 'agentPreset.updated', revision, resource: 'agentPreset', id: 'ap_a' },
            presetId: 'ap_a',
          },
          200,
        )
      }),
    )

    await expect(updateAgentPreset('ap_a', { name: 'Queued predecessor' })).resolves.toMatchObject({
      status: 'queued',
    })
    await expect(updateAgentPreset('ap_a', { name: 'Accepted successor' })).resolves.toMatchObject({
      status: 'accepted',
    })

    expect(commandBodies).toEqual([
      { baseRevision: 1, patch: { name: 'Queued predecessor' } },
      { baseRevision: 1, patch: { name: 'Queued predecessor' } },
      { baseRevision: 2, patch: { name: 'Accepted successor' } },
    ])
    expect(getDatabase().agentPresets[0].name).toBe('Accepted successor')
    expect(await listPendingMutations()).toEqual([])
  })

  it('retires a drained predecessor overlay while retaining a queued successor overlay', async () => {
    await prepareDurableAgentPresetOutbox('retained-successor-compaction')
    let commandCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/mutation-receipts/ack')) return response({ acknowledged: true }, 200)
        if (!url.endsWith('/agent-presets/ap_a')) throw new Error(`Unexpected URL: ${url}`)
        commandCount += 1
        if (commandCount === 2) {
          return response(
            {
              revision: 2,
              event: { type: 'agentPreset.updated', revision: 2, resource: 'agentPreset', id: 'ap_a' },
              presetId: 'ap_a',
            },
            200,
          )
        }
        return response({ error: 'temporary failure' }, 500)
      }),
    )

    await expect(updateAgentPreset('ap_a', { name: 'Accepted predecessor' })).resolves.toMatchObject({
      status: 'queued',
    })
    await expect(updateAgentPreset('ap_a', { enabled: false })).resolves.toMatchObject({
      status: 'queued',
    })

    const merged = mergePendingAgentPresetSettingsResource({
      agentPresets: [preset({ name: 'Remote canonical name', enabled: true })],
      agentPresetDefaultId: 'ap_a',
    })
    expect(merged.agentPresets[0]).toMatchObject({
      name: 'Remote canonical name',
      enabled: false,
    })
    const pendingMutations = await listPendingMutations()
    expect(pendingMutations).toHaveLength(1)
    expect(pendingMutations[0].intent.requests[0]).toMatchObject({
      method: 'PATCH',
      path: '/agent-presets/ap_a',
      body: { patch: { enabled: false } },
    })
  })

  it('keeps retained delete cascades projected across settings, loadout, and character refreshes', async () => {
    await prepareDurableAgentPresetOutbox('delete-overlay')
    seedAgentPresetDeleteReferences()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'temporary failure' }, 500)),
    )

    await expect(deleteAgentPreset('ap_a')).resolves.toMatchObject({ status: 'queued' })
    const mergedSettings = mergePendingAgentPresetSettingsResource({
      agentPresets: [preset(), preset({ id: 'ap_b', name: 'Preset B', steps: [] })],
      agentPresetDefaultId: 'ap_a',
    })
    expect(mergedSettings.agentPresets.map((candidate) => candidate.id)).toEqual(['ap_b'])
    expect(mergedSettings).not.toHaveProperty('agentPresetDefaultId')

    const mergedLoadouts = mergePendingAgentPresetLoadoutsResource([
      { id: 'loadout_a', agentPresetId: 'ap_a', agentPresetName: 'Preset A' },
    ])
    expect(mergedLoadouts).toEqual([{ id: 'loadout_a' }])
    const mergedCharacters = mergePendingAgentPresetCharactersResource([
      { chaId: 'char_a', chats: [{ id: 'chat_a', generationSettings: { agentPresetId: 'ap_a', other: true } }] },
    ])
    expect(mergedCharacters[0].chats[0].generationSettings).toEqual({ other: true })
  })

  it('fails oversized optimistic payload staging without leaving a projection', async () => {
    await prepareDurableAgentPresetOutbox('oversized')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const oversized = 'x'.repeat(MAX_DURABLE_MUTATION_PAYLOAD_BYTES + 1)

    await expect(updateAgentPreset('ap_a', { description: oversized })).resolves.toEqual({
      status: 'failed',
      result: { status: 'error', error: 'Pending Agent Preset mutation payload is too large' },
    })
    expect(getDatabase().agentPresets[0].description).toBeUndefined()
    expect(await listPendingMutations()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears a generated latch when staging cannot serialize its request', async () => {
    await prepareDurableAgentPresetOutbox('generated-stage-error')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(createAgentPreset({ name: 'Unserializable', unsupported: 1n })).resolves.toMatchObject({
      status: 'failed',
      result: { status: 'error' },
    })
    expect(currentPendingAgentPresetGeneratedProjectionLatch()).toBeNull()
    expect(await listPendingMutations()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Agent Preset generated-id projection latches', () => {
  it('survives remount-style reads, suppresses duplicate submission, and ignores a same-name different row', async () => {
    await prepareDurableAgentPresetOutbox('generated-preset')
    const fetchMock = vi.fn(async () => response({ error: 'temporary failure' }, 500))
    vi.stubGlobal('fetch', fetchMock)

    const attempted = { name: 'Same name', description: 'Expected description', enabled: false }
    const outcome = await createAgentPreset(attempted)
    expect(outcome).toMatchObject({ status: 'queued', projectionLatch: { kind: 'preset' } })
    if (outcome.status !== 'queued' || !outcome.projectionLatch) throw new Error('Expected a queued latch')
    const latch = outcome.projectionLatch
    expect(currentPendingAgentPresetGeneratedProjectionLatch()).toEqual(latch)

    await expect(createAgentPreset({ name: 'Second click', enabled: true })).resolves.toMatchObject({
      status: 'blocked',
      projectionLatch: latch,
    })
    await expect(updateAgentPreset('ap_a', { name: 'Dropped edit' })).resolves.toMatchObject({
      status: 'blocked',
      projectionLatch: latch,
    })
    expect(getDatabase().agentPresets[0].name).toBe('Preset A')
    expect(await listPendingMutations()).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledOnce()

    withTestDatabaseWrite(() => {
      getDatabase().agentPresets.push(
        preset({ id: 'ap_unrelated', name: 'Same name', description: 'Different description', enabled: false }),
      )
    })
    expect(isAgentPresetGeneratedProjectionResolved(latch)).toBe(false)
    expect(currentPendingAgentPresetGeneratedProjectionLatch()).toEqual(latch)

    withTestDatabaseWrite(() => {
      getDatabase().agentPresets.push(
        preset({ id: 'ap_created', name: 'Same name', description: 'Expected description', enabled: false, steps: [] }),
      )
    })
    expect(isAgentPresetGeneratedProjectionResolved(latch)).toBe(true)
    expect(currentPendingAgentPresetGeneratedProjectionLatch()).toBeNull()
  })

  it('replays an offline generated create in-session and releases its projection latch', async () => {
    await prepareDurableAgentPresetOutbox('generated-preset-reconnect')
    let createAttempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/mutation-receipts/ack')) {
          return response({ acknowledged: 1, requested: 1 }, 200)
        }
        if (!url.endsWith('/agent-presets')) throw new Error(`Unexpected URL: ${url}`)
        createAttempts += 1
        if (createAttempts === 1) return response({ error: 'temporary failure' }, 500)
        return response(
          {
            revision: 2,
            event: { type: 'agentPreset.created', revision: 2, resource: 'agentPreset', id: 'ap_created' },
            presetId: 'ap_created',
          },
          200,
        )
      }),
    )
    setServerCommandSuccessReconciler((event) => {
      if (event.type !== 'agentPreset.created') return
      withTestDatabaseWrite(() => {
        getDatabase().agentPresets.push(
          preset({
            id: 'ap_created',
            name: 'Offline create',
            description: 'Queued description',
            enabled: false,
            steps: [],
          }),
        )
      })
    })

    const outcome = await createAgentPreset({
      name: 'Offline create',
      description: 'Queued description',
      enabled: false,
    })
    expect(outcome).toMatchObject({ status: 'queued', projectionLatch: { kind: 'preset' } })
    expect(currentPendingAgentPresetGeneratedProjectionLatch()).not.toBeNull()

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 1,
      discarded: 0,
      retained: 0,
      succeeded: 1,
    })

    expect(createAttempts).toBe(2)
    expect(getDatabase().agentPresets).toContainEqual(expect.objectContaining({ id: 'ap_created' }))
    expect(currentPendingAgentPresetGeneratedProjectionLatch()).toBeNull()
    expect(await listPendingMutations()).toEqual([])
  })

  it('matches duplicated preset dependencies semantically after every step id is regenerated', async () => {
    await prepareDurableAgentPresetOutbox('duplicate-preset')
    const sourceSteps = [
      step({ id: 'aps_source_a', outputKey: 'source_a' }),
      step({ id: 'aps_source_b', name: 'Step B', outputKey: 'source_b', dependencies: ['aps_source_a'] }),
    ]
    setDatabaseLite({ agentPresets: [preset({ steps: sourceSteps })], characters: [] } as never, 1)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'temporary failure' }, 500)),
    )

    const outcome = await duplicateAgentPreset('ap_a', { name: 'Same duplicate' })
    if (outcome.status !== 'queued' || !outcome.projectionLatch) throw new Error('Expected a queued latch')
    const latch = outcome.projectionLatch

    withTestDatabaseWrite(() => {
      getDatabase().agentPresets.push(
        preset({
          id: 'ap_unrelated',
          name: 'Same duplicate',
          steps: [
            step({ id: 'aps_unrelated_a', outputKey: 'source_a' }),
            step({
              id: 'aps_unrelated_b',
              name: 'Step B',
              outputKey: 'source_b',
              dependencies: ['aps_source_a'],
            }),
          ],
        }),
      )
    })
    expect(isAgentPresetGeneratedProjectionResolved(latch)).toBe(false)

    withTestDatabaseWrite(() => {
      getDatabase().agentPresets.push(
        preset({
          id: 'ap_duplicate',
          name: 'Same duplicate',
          steps: [
            step({ id: 'aps_duplicate_a', outputKey: 'source_a' }),
            step({
              id: 'aps_duplicate_b',
              name: 'Step B',
              outputKey: 'source_b',
              dependencies: ['aps_duplicate_a'],
            }),
          ],
        }),
      )
    })
    expect(isAgentPresetGeneratedProjectionResolved(latch)).toBe(true)
  })

  it('keeps a queued step create latched until the full semantic step appears', async () => {
    await prepareDurableAgentPresetOutbox('generated-step')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'temporary failure' }, 500)),
    )
    const attempted = {
      name: 'Same step',
      enabled: true,
      phase: 'beforeMain' as const,
      dependencies: [],
      instruction: 'Expected instruction',
      model: { mode: 'inheritMain' as const },
      runtime: {},
      inputScopes: [],
      outputKey: 'same_step',
      outputFormat: 'text' as const,
      destination: 'promptOutput' as const,
      failurePolicy: { mode: 'required' as const },
    }
    const outcome = await createAgentPresetStep('ap_a', attempted)
    if (outcome.status !== 'queued' || !outcome.projectionLatch) throw new Error('Expected a queued latch')
    const latch = outcome.projectionLatch

    withTestDatabaseWrite(() => {
      getDatabase().agentPresets[0].steps.push(
        step({ id: 'aps_unrelated', name: 'Same step', outputKey: 'same_step', instruction: 'Different instruction' }),
      )
    })
    expect(isAgentPresetGeneratedProjectionResolved(latch)).toBe(false)
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets[0].steps.push(step({ id: 'aps_created', ...attempted }))
    })
    expect(isAgentPresetGeneratedProjectionResolved(latch)).toBe(true)
  })

  it('matches a duplicated step when the server mints a different unique output key', async () => {
    await prepareDurableAgentPresetOutbox('duplicate-step')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'temporary failure' }, 500)),
    )
    const outcome = await duplicateAgentPresetStep('ap_a', 'aps_a', { name: 'Same step copy' })
    if (outcome.status !== 'queued' || !outcome.projectionLatch) throw new Error('Expected a queued latch')
    const latch = outcome.projectionLatch

    withTestDatabaseWrite(() => {
      getDatabase().agentPresets[0].steps.push(
        step({ id: 'aps_duplicate', name: 'Same step copy', outputKey: 'server_minted_copy' }),
      )
    })
    expect(isAgentPresetGeneratedProjectionResolved(latch)).toBe(true)
  })
})
