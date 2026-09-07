import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { derived, writable } from 'svelte/store'
import type { PromptItem } from '../process/prompt'
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import { beginClientSession, resetClientSessionForTests } from '../clientSession'

const projectionState = vi.hoisted(() => ({
  fetchResource: vi.fn(),
  canUse: true,
}))

vi.mock('./hydrationReads', () => ({
  fetchServerPromptPresetTemplate: projectionState.fetchResource,
}))

vi.mock('../process/modules', async (importActual) => {
  const actual = await importActual<typeof import('../process/modules')>()
  return { ...actual, moduleUpdate: vi.fn() }
})

import { mergeServerResourceFields } from '../storage/database.svelte'
import {
  clearCachedServerCommandRevision,
  peekCachedServerCommandRevision,
  setCachedServerCommandRevision,
} from './commands'
import { collectionsResourceState } from './resourceState.svelte'
import {
  capturePromptTemplateOwnerProjectionEpoch,
  clonePromptTemplateSelectedFallback,
  ensurePromptTemplateHydrated,
  hasPromptTemplateOwnerProjectionEpochChanged,
  invalidatePromptTemplateHydration,
  isPromptTemplateHydrated,
  isPromptTemplateOwnerAcknowledgementTainted,
  markPromptTemplateOwnerAcknowledgementTainted,
  markPromptTemplateHydrationStale,
  markPromptTemplateProjectionApplied,
  peekPromptTemplateOwnerRevision,
  promptTemplateHydrationStateStore,
  promptTemplateOwnerUsesSelectedFallback,
  resetPromptTemplateHydration,
} from './promptTemplateHydration'
function item(id: string, text: string): PromptItem {
  return { id, type: 'plain', type2: 'normal', role: 'system', text } as PromptItem
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

beforeEach(() => {
  resetClientSessionForTests()
  ;(testDatabaseState as { db: unknown }).db = { characters: [], modules: [], enabledModules: [] }
  clearCachedServerCommandRevision()
  resetPromptTemplateHydration()
  projectionState.canUse = true
  projectionState.fetchResource.mockReset()
})

afterEach(() => {
  resetClientSessionForTests()
  const database = JSON.parse(JSON.stringify(testDatabaseState.db))
  testDatabaseState.db = database
})

describe('promptTemplate hydration', () => {
  it('rejects late owner and joined compatibility applies from an obsolete client session', async () => {
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
      promptTemplate: [item('resident', 'resident')],
    }
    setCachedServerCommandRevision(7)
    const held = deferred<any>()
    projectionState.fetchResource.mockReturnValueOnce(held.promise)
    const owner = ensurePromptTemplateHydrated({ promptPresetId: 'preset-a', force: true })
    const joined = ensurePromptTemplateHydrated({ promptPresetId: 'preset-a' })
    beginClientSession('new-reader')
    held.resolve({ status: 'ok', revision: 7, promptPresetId: 'preset-a', promptTemplate: [item('stale', 'stale')] })
    expect(await owner).toBe(false)
    expect(await joined).toBe(false)
    expect(testDatabaseState.db.promptTemplate).toEqual([item('resident', 'resident')])
    expect(isPromptTemplateHydrated('preset-a')).toBe(false)
  })

  it('reactively publishes hydration when a second owner becomes ready', async () => {
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [
        { id: 'preset-a', name: 'Preset A' },
        { id: 'preset-b', name: 'Preset B' },
      ],
    }
    setCachedServerCommandRevision(7)
    projectionState.fetchResource.mockImplementation(async (promptPresetId: string) => ({
      status: 'ok',
      revision: 7,
      promptPresetId,
      promptTemplate: [item(`${promptPresetId}-row`, promptPresetId)],
    }))

    const selectedOwner = writable<string | null>('preset-a')
    const selectedOwnerHydrated = derived([promptTemplateHydrationStateStore, selectedOwner], ([state, ownerId]) =>
      state.hydratedOwnerIds.has(ownerId),
    )
    const readiness: boolean[] = []
    const unsubscribe = selectedOwnerHydrated.subscribe((hydrated) => readiness.push(hydrated))

    try {
      await expect(ensurePromptTemplateHydrated({ promptPresetId: 'preset-a' })).resolves.toBe(true)
      testDatabaseState.db.promptPresetsId = 1
      selectedOwner.set('preset-b')
      await expect(ensurePromptTemplateHydrated({ promptPresetId: 'preset-b' })).resolves.toBe(true)
    } finally {
      unsubscribe()
    }

    expect(readiness).toEqual([false, true, false, true])
  })

  it('uses the top-level prompt template already loaded with settings', async () => {
    testDatabaseState.db.promptTemplate = [item('p-1', 'settings template')]
    setCachedServerCommandRevision(7)

    await expect(ensurePromptTemplateHydrated()).resolves.toBe(true)

    expect(projectionState.fetchResource).not.toHaveBeenCalled()
    expect(testDatabaseState.db.promptTemplate).toEqual([item('p-1', 'settings template')])
    expect(isPromptTemplateHydrated()).toBe(true)
    expect(peekCachedServerCommandRevision()).toBe(7)
  })

  it('advances an acknowledged owner revision without advancing its projection epoch', async () => {
    testDatabaseState.db.promptTemplate = [item('p-1', 'optimistic')]

    await expect(ensurePromptTemplateHydrated({ minimumRevision: 3 })).resolves.toBe(true)
    const ownerEpoch = capturePromptTemplateOwnerProjectionEpoch(null)
    markPromptTemplateProjectionApplied(null, 4, { advanceProjectionEpoch: false })

    expect(peekPromptTemplateOwnerRevision(null)).toBe(4)
    expect(hasPromptTemplateOwnerProjectionEpochChanged(null, ownerEpoch)).toBe(false)
    expect(testDatabaseState.db.promptTemplate).toEqual([item('p-1', 'optimistic')])
  })

  it('keeps rollback taint through local acknowledgements and clears it on an authoritative projection', async () => {
    testDatabaseState.db.promptTemplate = [item('p-1', 'optimistic')]
    await expect(ensurePromptTemplateHydrated({ minimumRevision: 3 })).resolves.toBe(true)

    markPromptTemplateOwnerAcknowledgementTainted(null)
    markPromptTemplateProjectionApplied(null, 4, { advanceProjectionEpoch: false })
    expect(isPromptTemplateOwnerAcknowledgementTainted(null)).toBe(true)

    markPromptTemplateProjectionApplied(null, 5)
    expect(isPromptTemplateOwnerAcknowledgementTainted(null)).toBe(false)
  })

  it('does not invent a top-level template when settings omit it', async () => {
    setCachedServerCommandRevision(0)

    await expect(ensurePromptTemplateHydrated()).resolves.toBe(false)

    expect(projectionState.fetchResource).not.toHaveBeenCalled()
    expect(testDatabaseState.db.promptTemplate).toBeUndefined()
    expect(isPromptTemplateHydrated()).toBe(false)
  })

  it('coalesces concurrent hydration requests', async () => {
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    setCachedServerCommandRevision(1)
    const response = deferred<{
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: PromptItem[]
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const first = ensurePromptTemplateHydrated()
    const second = ensurePromptTemplateHydrated()
    response.resolve({
      status: 'ok',
      revision: 1,
      promptPresetId: 'preset-a',
      promptTemplate: [item('p-1', 'once')],
    })

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    expect(projectionState.fetchResource).toHaveBeenCalledTimes(1)
    expect(testDatabaseState.db).not.toHaveProperty('promptTemplate')
  })

  it('keeps the aggregate compatibility projection unchanged when a visible caller joins a background request', async () => {
    ;(testDatabaseState as { db: unknown }).db = {
      promptTemplate: [],
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    setCachedServerCommandRevision(1)
    const response = deferred<{
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: PromptItem[]
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const background = ensurePromptTemplateHydrated({ applyProjection: false, promptPresetId: 'preset-a' })
    const visible = ensurePromptTemplateHydrated({ promptPresetId: 'preset-a' })
    response.resolve({
      status: 'ok',
      revision: 1,
      promptPresetId: 'preset-a',
      promptTemplate: [item('p-1', 'visible')],
    })

    await expect(Promise.all([background, visible])).resolves.toEqual([true, true])
    expect(projectionState.fetchResource).toHaveBeenCalledTimes(1)
    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([item('p-1', 'visible')])
    expect(testDatabaseState.db.promptTemplate).toEqual([])
  })

  it('accepts a hydration response after an unrelated projection advances the known revision', async () => {
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    setCachedServerCommandRevision(5)
    const response = deferred<{
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: PromptItem[]
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = ensurePromptTemplateHydrated()
    setCachedServerCommandRevision(6)
    mergeServerResourceFields({ language: 'ko' } as any)
    response.resolve({
      status: 'ok',
      revision: 5,
      promptPresetId: 'preset-a',
      promptTemplate: [item('p-current', 'current template')],
    })

    await expect(pending).resolves.toBe(true)

    expect(testDatabaseState.db).not.toHaveProperty('promptTemplate')
    expect(testDatabaseState.db.language).toBe('ko')
    expect(isPromptTemplateHydrated()).toBe(true)
    expect(peekCachedServerCommandRevision()).toBe(6)
  })

  it('accepts a modern owner response when the aggregate compatibility projection changes independently', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptTemplate: [item('stale-root', 'stale aggregate body')],
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    const response = deferred<{
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: PromptItem[]
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = ensurePromptTemplateHydrated()
    testDatabaseState.db.promptTemplate = [item('legacy-live', 'new aggregate body')]
    response.resolve({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-a',
      promptTemplate: [item('preset-row', 'canonical owner body')],
    })

    await expect(pending).resolves.toBe(true)
    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([item('preset-row', 'canonical owner body')])
    expect(testDatabaseState.db.promptTemplate).toEqual([item('legacy-live', 'new aggregate body')])
  })

  it('rejects a hydration response after the same prompt owner changes', async () => {
    setCachedServerCommandRevision(5)
    ;(testDatabaseState as { db: unknown }).db = {
      characters: [],
      modules: [],
      enabledModules: [],
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    const response = deferred<{
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: PromptItem[]
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = ensurePromptTemplateHydrated()
    setCachedServerCommandRevision(6)
    mergeServerResourceFields({
      promptPresets: [
        {
          id: 'preset-a',
          name: 'Preset A',
          promptTemplate: [item('p-newer', 'newer owner template')],
        },
      ],
    } as any)
    response.resolve({
      status: 'ok',
      revision: 5,
      promptPresetId: 'preset-a',
      promptTemplate: [item('p-stale', 'stale owner template')],
    })

    await expect(pending).resolves.toBe(false)

    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([item('p-newer', 'newer owner template')])
    expect(testDatabaseState.db).not.toHaveProperty('promptTemplate')
  })

  it('rejects a hydration response older than the request-start revision', async () => {
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    setCachedServerCommandRevision(6)
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 5,
      promptPresetId: 'preset-a',
      promptTemplate: [item('p-old', 'older than request')],
    })

    await expect(ensurePromptTemplateHydrated()).resolves.toBe(false)

    expect(testDatabaseState.db).not.toHaveProperty('promptTemplate')
    expect(isPromptTemplateHydrated()).toBe(false)
  })

  it('fetches promptItem for the selected prompt preset owner', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-a',
      promptTemplate: [item('preset-row', 'preset body')],
    })

    await expect(ensurePromptTemplateHydrated()).resolves.toBe(true)

    expect(projectionState.fetchResource).toHaveBeenCalledWith('preset-a')
    expect(testDatabaseState.db).not.toHaveProperty('promptTemplate')
    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([item('preset-row', 'preset body')])
    expect(peekPromptTemplateOwnerRevision('preset-a')).toBe(7)
  })

  it('normalizes role2 aliases while hydrating a prompt preset template', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-a',
      promptTemplate: [{ id: 'role-row', type: 'memory', role2: 'assistant' }],
    })

    await expect(ensurePromptTemplateHydrated()).resolves.toBe(true)

    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([
      { id: 'role-row', type: 'memory', role2: 'bot' },
    ])
    expect(testDatabaseState.db).not.toHaveProperty('promptTemplate')
  })

  it('rejects hydration when the local preset owner id is duplicated', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 1,
      promptPresets: [
        { id: 'preset-a', name: 'Duplicate A' },
        { id: 'preset-a', name: 'Selected A' },
      ],
    }
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-a',
      promptTemplate: [item('preset-row', 'ambiguous')],
    })

    await expect(ensurePromptTemplateHydrated()).resolves.toBe(false)

    expect(testDatabaseState.db.promptPresets[0]).not.toHaveProperty('promptTemplate')
    expect(testDatabaseState.db.promptPresets[1]).not.toHaveProperty('promptTemplate')
    expect(testDatabaseState.db).not.toHaveProperty('promptTemplate')
    expect(isPromptTemplateHydrated('preset-a')).toBe(false)
  })

  it('refreshes an already hydrated owner when a newer minimum revision is required', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    projectionState.fetchResource
      .mockResolvedValueOnce({
        status: 'ok',
        revision: 7,
        promptPresetId: 'preset-a',
        promptTemplate: [item('preset-row', 'revision seven')],
      })
      .mockResolvedValueOnce({
        status: 'ok',
        revision: 8,
        promptPresetId: 'preset-a',
        promptTemplate: [item('preset-row', 'revision eight')],
      })

    await expect(ensurePromptTemplateHydrated()).resolves.toBe(true)
    await expect(ensurePromptTemplateHydrated({ minimumRevision: 8 })).resolves.toBe(true)

    expect(projectionState.fetchResource).toHaveBeenCalledTimes(2)
    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([item('preset-row', 'revision eight')])
    expect(peekPromptTemplateOwnerRevision('preset-a')).toBe(8)
  })

  it('refetches when an overlapping caller requires a newer revision than the shared request', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    const revisionEight = deferred<{
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: PromptItem[]
    }>()
    projectionState.fetchResource.mockReturnValueOnce(revisionEight.promise).mockResolvedValueOnce({
      status: 'ok',
      revision: 9,
      promptPresetId: 'preset-a',
      promptTemplate: [item('preset-row', 'revision nine')],
    })

    const first = ensurePromptTemplateHydrated({ minimumRevision: 8 })
    const second = ensurePromptTemplateHydrated({ minimumRevision: 9 })
    revisionEight.resolve({
      status: 'ok',
      revision: 8,
      promptPresetId: 'preset-a',
      promptTemplate: [item('preset-row', 'revision eight')],
    })

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(projectionState.fetchResource).toHaveBeenCalledTimes(2)
    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([item('preset-row', 'revision nine')])
    expect(peekPromptTemplateOwnerRevision('preset-a')).toBe(9)
  })

  it('invalidates one owner epoch and rejects its older in-flight hydration', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    const response = deferred<{
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: PromptItem[]
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)
    const epoch = capturePromptTemplateOwnerProjectionEpoch('preset-a')

    const pending = ensurePromptTemplateHydrated()
    invalidatePromptTemplateHydration('preset-a')
    response.resolve({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-a',
      promptTemplate: [item('stale', 'stale')],
    })

    await expect(pending).resolves.toBe(false)
    expect(hasPromptTemplateOwnerProjectionEpochChanged('preset-a', epoch)).toBe(true)
    expect(testDatabaseState.db.promptPresets[0]).not.toHaveProperty('promptTemplate')
  })

  it('keeps a resident owner available while fencing a forced refresh', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A', promptTemplate: [item('resident-row', 'resident body')] }],
    }
    markPromptTemplateProjectionApplied('preset-a', 7)
    const epoch = capturePromptTemplateOwnerProjectionEpoch('preset-a')

    markPromptTemplateHydrationStale('preset-a')

    expect(hasPromptTemplateOwnerProjectionEpochChanged('preset-a', epoch)).toBe(true)
    expect(isPromptTemplateHydrated('preset-a')).toBe(true)
    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([item('resident-row', 'resident body')])
  })

  it('hydrates an explicit non-current prompt preset owner without overwriting the visible projection', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptTemplate: [item('global-row', 'global visible body')],
      promptPresetsId: 0,
      promptPresets: [
        { id: 'preset-global', name: 'Global Preset', promptTemplate: [item('global-row', 'global visible body')] },
        { id: 'preset-chat', name: 'Chat Preset' },
      ],
    }
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-chat',
      promptTemplate: [item('chat-row', 'chat body')],
    })

    await expect(ensurePromptTemplateHydrated({ promptPresetId: 'preset-chat', applyProjection: false })).resolves.toBe(
      true,
    )

    expect(projectionState.fetchResource).toHaveBeenCalledWith('preset-chat')
    expect(testDatabaseState.db.promptPresets[1].promptTemplate).toEqual([item('chat-row', 'chat body')])
    expect(testDatabaseState.db.promptTemplate).toEqual([item('global-row', 'global visible body')])
    expect(isPromptTemplateHydrated('preset-chat')).toBe(true)
    expect(isPromptTemplateHydrated('preset-global')).toBe(false)
  })

  it('can hydrate the selected owner for a background consumer without changing its compatibility projection', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptTemplate: [],
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-a',
      promptTemplate: [item('preset-row', 'export body')],
    })

    await expect(ensurePromptTemplateHydrated({ promptPresetId: 'preset-a', applyProjection: false })).resolves.toBe(
      true,
    )

    expect(testDatabaseState.db.promptPresets[0].promptTemplate).toEqual([item('preset-row', 'export body')])
    expect(testDatabaseState.db.promptTemplate).toEqual([])

    const ownerEpoch = capturePromptTemplateOwnerProjectionEpoch('preset-a')
    await expect(ensurePromptTemplateHydrated({ promptPresetId: 'preset-a' })).resolves.toBe(true)
    expect(testDatabaseState.db.promptTemplate).toEqual([])
    expect(hasPromptTemplateOwnerProjectionEpochChanged('preset-a', ownerEpoch)).toBe(false)
    expect(projectionState.fetchResource).toHaveBeenCalledTimes(1)
  })

  it('ignores a selected-owner hydration response after the selection changes', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptPresetsId: 0,
      promptPresets: [
        { id: 'preset-a', name: 'Preset A' },
        { id: 'preset-b', name: 'Preset B' },
      ],
    }
    const response = deferred<{
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: PromptItem[]
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = ensurePromptTemplateHydrated()
    testDatabaseState.db.promptPresetsId = 1
    response.resolve({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-a',
      promptTemplate: [item('preset-a-row', 'stale owner')],
    })

    await expect(pending).resolves.toBe(false)
    expect(testDatabaseState.db).not.toHaveProperty('promptTemplate')
  })

  it('keeps the selected default-scaffold fallback separate from the preset-owned body', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptTemplate: [item('stale-root', 'stale root')],
      promptPresetsId: 0,
      promptPresets: [{ id: 'default-prompt-preset', name: 'Default Prompt' }],
    }
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 7,
      promptPresetId: 'default-prompt-preset',
      promptTemplate: null,
      selectedFallbackPromptTemplate: [item('root-row', 'fresh root fallback')],
    })

    await expect(ensurePromptTemplateHydrated({ force: true })).resolves.toBe(true)

    expect(testDatabaseState.db.promptPresets[0]).not.toHaveProperty('promptTemplate')
    expect(testDatabaseState.db.promptTemplate).toEqual([item('root-row', 'fresh root fallback')])
    expect(promptTemplateOwnerUsesSelectedFallback('default-prompt-preset')).toBe(true)
    expect(clonePromptTemplateSelectedFallback('default-prompt-preset')).toEqual([
      item('root-row', 'fresh root fallback'),
    ])

    delete collectionsResourceState.values.promptTemplate
    await expect(ensurePromptTemplateHydrated()).resolves.toBe(true)

    expect(testDatabaseState.db.promptTemplate).toEqual([item('root-row', 'fresh root fallback')])
    expect(projectionState.fetchResource).toHaveBeenCalledTimes(1)
  })

  it('defers a selected fallback fetched by a background consumer until a visible projection is requested', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      promptTemplate: [item('visible-root', 'visible root')],
      promptPresetsId: 0,
      promptPresets: [{ id: 'default-prompt-preset', name: 'Default Prompt' }],
    }
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 7,
      promptPresetId: 'default-prompt-preset',
      promptTemplate: null,
      selectedFallbackPromptTemplate: [item('fresh-root', 'fresh root fallback')],
    })

    await expect(
      ensurePromptTemplateHydrated({ promptPresetId: 'default-prompt-preset', applyProjection: false }),
    ).resolves.toBe(true)
    expect(testDatabaseState.db.promptPresets[0]).not.toHaveProperty('promptTemplate')
    expect(testDatabaseState.db.promptTemplate).toEqual([item('visible-root', 'visible root')])

    await expect(ensurePromptTemplateHydrated()).resolves.toBe(true)
    expect(testDatabaseState.db.promptTemplate).toEqual([item('fresh-root', 'fresh root fallback')])
    expect(projectionState.fetchResource).toHaveBeenCalledTimes(1)
  })

  it('leaves a stale compatibility promptTemplate untouched when the selected preset has no promptTemplate', async () => {
    setCachedServerCommandRevision(7)
    ;(testDatabaseState as { db: unknown }).db = {
      characters: [],
      promptTemplate: [item('stale', 'stale compatibility body')],
      promptPresetsId: 0,
      promptPresets: [{ id: 'preset-a', name: 'Preset A' }],
    }
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 7,
      promptPresetId: 'preset-a',
      promptTemplate: null,
    })
    await expect(ensurePromptTemplateHydrated({ force: true })).resolves.toBe(true)

    expect(testDatabaseState.db.promptTemplate).toEqual([item('stale', 'stale compatibility body')])
    expect(testDatabaseState.db.promptPresets[0]).not.toHaveProperty('promptTemplate')
    expect(isPromptTemplateHydrated()).toBe(true)
  })
})
