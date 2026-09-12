import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const refreshApi = vi.hoisted(() => ({
  refreshAll: vi.fn(),
  refreshInvalidated: vi.fn(),
}))
const bootstrapApi = vi.hoisted(() => ({ fetchReadOnly: vi.fn() }))
const sideEffects = vi.hoisted(() => ({
  discardReaderProjection: vi.fn(async () => undefined),
  hydrateActiveChat: vi.fn(async () => undefined),
  hydrateSelectedCharacter: vi.fn(async () => true),
  resetChatHydration: vi.fn(),
  recordLorebooks: vi.fn(),
  resetLorebooks: vi.fn(),
  applyGenerationBootstrap: vi.fn(() => true),
  triggerReattach: vi.fn(),
  setTranslations: vi.fn(),
  setGreetingTranslations: vi.fn(),
  clearGreetingTranslations: vi.fn(),
  refreshGreetingTranslations: vi.fn(async () => ({ status: 'ok' })),
  recordRefresh: vi.fn(),
  hydratePromptTemplate: vi.fn(async () => true),
}))

vi.mock('../process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))
vi.mock('../model/modellist', () => ({ getModelInfo: vi.fn(() => ({ type: 'chat' })) }))

vi.mock('./resourceInvalidation', () => ({
  refreshAllServerResources: refreshApi.refreshAll,
  refreshInvalidatedServerResources: refreshApi.refreshInvalidated,
}))
vi.mock('../readerProjectionLifecycle', () => ({
  discardReaderProjectionState: sideEffects.discardReaderProjection,
}))
vi.mock('./bootstrap', () => ({ fetchServerBootstrapReadOnly: bootstrapApi.fetchReadOnly }))
vi.mock('./chatMessageHydration.svelte', () => ({
  applyServerChatMessagesResource: vi.fn(() => true),
  hydrateActiveChat: sideEffects.hydrateActiveChat,
  resetChatHydration: sideEffects.resetChatHydration,
}))
vi.mock('./characterShellHydration.svelte', () => ({
  hydrateSelectedCharacterShell: sideEffects.hydrateSelectedCharacter,
}))
vi.mock('./lorebookOwner.svelte', () => ({
  applyServerCharacterLorebookResource: vi.fn(() => true),
  markCharacterLorebookHydrated: vi.fn(),
  recordCanonicalCharacterLorebookScopes: vi.fn(),
  recordCanonicalLorebookCollections: vi.fn(),
  recordHydratedCharacterLorebooks: sideEffects.recordLorebooks,
  resetLorebookHydration: sideEffects.resetLorebooks,
}))
vi.mock('../pluginCommands', () => ({
  mergePendingPluginCollectionResource: vi.fn((value) => value),
  mergePendingPluginProviderResource: vi.fn((value) => value),
  mergePendingPluginStorageResource: vi.fn((value) => value),
}))
vi.mock('../agentPresets', () => ({
  mergePendingAgentPresetSettingsResource: vi.fn((value) => value),
  mergePendingAgentPresetLoadoutsResource: vi.fn((value) => value),
  mergePendingAgentPresetCharactersResource: vi.fn((value) => value),
}))
vi.mock('../process/reattach', () => ({
  triggerOpenChatGenerationReattach: sideEffects.triggerReattach,
}))
vi.mock('./generationOperations', () => ({
  applyGenerationOperationBootstrap: sideEffects.applyGenerationBootstrap,
}))
vi.mock('./messageTranslationJobs', () => ({
  clearActiveMessageTranslation: vi.fn(),
  setActiveMessageTranslations: sideEffects.setTranslations,
}))
vi.mock('./greetingTranslations.svelte', () => ({
  clearGreetingTranslationProjection: sideEffects.clearGreetingTranslations,
  refreshGreetingTranslationProjection: sideEffects.refreshGreetingTranslations,
  setActiveGreetingTranslations: sideEffects.setGreetingTranslations,
}))
vi.mock('./protocolDiagnostics', () => ({ recordFullResourceRefresh: sideEffects.recordRefresh }))
vi.mock('./promptTemplateHydration', () => ({
  ensurePromptTemplateHydrated: sideEffects.hydratePromptTemplate,
}))

import {
  forceServerDatabaseReplacementRefresh,
  forceServerResourceRefresh,
  refreshServerRealmImportResources,
  serverResourceInvalidationHooks,
} from './resourceRefresh'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  peekAppliedServerResourceRevision,
  peekCachedServerCommandRevision,
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
} from './commands'
import { charactersResourceState, replaceResourceDatabase, resetServerResourceState } from './resourceState.svelte'

import { selectedCharID } from '../stores.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'
import { enterClientWriter } from '../__tests__/clientSession'
import { demoteClientSession, resetClientSessionForTests } from '../clientSession'

function database(characters: Array<{ chaId: string; name: string }>, currentChar = 0) {
  return {
    characters: characters.map((character) => ({
      ...character,
      type: 'character',
      chatPage: 0,
      chats: [{ id: `chat-${character.chaId}`, message: [] }],
    })),
    characterOrder: characters.map((character) => character.chaId),
    currentChar,
    modules: [],
    personas: [],
    botPresets: [],
  } as never
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.clearAllMocks()
  resetServerResourceState()
  replaceResourceDatabase(
    database(
      [
        { chaId: 'char-a', name: 'Ada' },
        { chaId: 'char-b', name: 'Bea' },
      ],
      0,
    ),
    4,
  )
  selectedCharID.set(1)
  clearCachedServerCommandRevision()
  clearAppliedServerResourceRevision()
  refreshApi.refreshAll.mockResolvedValue({ status: 'ok', revision: 5, scope: 'full' })
  refreshApi.refreshInvalidated.mockResolvedValue({ status: 'ok', revision: 5, scope: 'targeted' })
  bootstrapApi.fetchReadOnly.mockResolvedValue({
    status: 'ok',
    bootstrap: {
      initialized: true,
      revision: 5,
      activeGenerationJobs: [{ chatId: 'chat-b', jobId: 'job-b' }],
      activeMessageTranslations: [
        { chatId: 'chat-b', messageId: 'message-b', jobId: 'translation-b', status: 'running' },
      ],
    },
  })
})

it('does not complete a held writer refresh over a newer reader projection', async () => {
  enterClientWriter()
  let release!: (value: { status: 'ok'; revision: number; scope: 'full' }) => void
  refreshApi.refreshAll.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = forceServerResourceRefresh('held-writer-refresh')
  await vi.waitFor(() => expect(refreshApi.refreshAll).toHaveBeenCalledOnce())
  demoteClientSession()
  selectedCharID.set(-1)
  setCachedServerCommandRevision(12)
  setAppliedServerResourceRevision(12)
  release({ status: 'ok', revision: 5, scope: 'full' })
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  expect(get(selectedCharID)).toBe(-1)
  expect(peekAppliedServerResourceRevision()).toBe(12)
  expect(sideEffects.resetChatHydration).not.toHaveBeenCalled()
  expect(sideEffects.hydratePromptTemplate).not.toHaveBeenCalled()
  expect(bootstrapApi.fetchReadOnly).not.toHaveBeenCalled()
  expect(sideEffects.triggerReattach).not.toHaveBeenCalled()
})

it('ignores late runtime bootstrap after writer loss during full refresh completion', async () => {
  enterClientWriter()
  let release!: (value: unknown) => void
  bootstrapApi.fetchReadOnly.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = forceServerResourceRefresh('held-runtime-refresh')
  await vi.waitFor(() => expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledOnce())
  demoteClientSession()
  release({ status: 'ok', bootstrap: { activeGenerationJobs: [{ jobId: 'old-job', chatId: 'chat-a' }] } })
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  expect(sideEffects.applyGenerationBootstrap).not.toHaveBeenCalled()
  expect(sideEffects.setTranslations).not.toHaveBeenCalled()
  expect(sideEffects.triggerReattach).not.toHaveBeenCalled()
})

it.each(['idle', 'loading', 'error'] as const)(
  'does not refresh greeting translations through retained characters while the owner is %s',
  async (status) => {
    charactersResourceState.status = status

    await expect(serverResourceInvalidationHooks.refreshGreetingTranslations!('char-a', 5)).resolves.toBe(true)

    expect(sideEffects.refreshGreetingTranslations).not.toHaveBeenCalled()
  },
)

describe('Realm import resource refresh', () => {
  it('applies a contiguous character-created event without destructive refresh side effects', async () => {
    const event = {
      type: 'character.created',
      resource: 'character',
      revision: 21,
      id: 'char-imported',
    }
    setCachedServerCommandRevision(20)
    setAppliedServerResourceRevision(20)
    refreshApi.refreshInvalidated.mockImplementationOnce(async () => {
      replaceResourceDatabase(
        database([
          { chaId: 'char-a', name: 'Ada' },
          { chaId: 'char-b', name: 'Bea' },
          { chaId: 'char-imported', name: 'Imported' },
        ]),
        21,
      )
      return { status: 'ok', revision: 21, scope: 'targeted' }
    })

    await expect(
      refreshServerRealmImportResources({
        revision: 21,
        event,
        characterId: 'char-imported',
      }),
    ).resolves.toEqual({ status: 'ok', revision: 21 })

    expect(refreshApi.refreshInvalidated).toHaveBeenCalledWith(event, {
      appliedRevision: 20,
      hooks: expect.any(Object),
    })
    expect(refreshApi.refreshAll).not.toHaveBeenCalled()
    expect(sideEffects.recordRefresh).not.toHaveBeenCalled()
    expect(bootstrapApi.fetchReadOnly).not.toHaveBeenCalled()
    expect(sideEffects.resetChatHydration).not.toHaveBeenCalled()
    expect(sideEffects.resetLorebooks).not.toHaveBeenCalled()
    expect(sideEffects.hydrateActiveChat).not.toHaveBeenCalled()
    expect(sideEffects.hydrateSelectedCharacter).toHaveBeenCalledWith({ supersede: true })
    expect(sideEffects.triggerReattach).not.toHaveBeenCalled()
    expect(sideEffects.recordLorebooks).toHaveBeenCalledTimes(1)
    expect(peekCachedServerCommandRevision()).toBe(21)
    expect(peekAppliedServerResourceRevision()).toBe(21)
  })

  it('retains a complete refresh when the returned event crosses a revision gap', async () => {
    setCachedServerCommandRevision(22)
    setAppliedServerResourceRevision(20)
    refreshApi.refreshAll.mockResolvedValueOnce({ status: 'ok', revision: 22, scope: 'full' })

    await expect(
      refreshServerRealmImportResources({
        revision: 22,
        event: {
          type: 'character.created',
          resource: 'character',
          revision: 22,
          id: 'char-imported',
        },
        characterId: 'char-imported',
      }),
    ).resolves.toEqual({ status: 'ok', revision: 22 })

    expect(refreshApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(refreshApi.refreshAll).toHaveBeenCalledTimes(1)
    expect(sideEffects.recordRefresh).toHaveBeenCalledWith('realm-import', 'character')
  })
})

describe('complete server resource refresh', () => {
  it('advances cursors only after success and refreshes transient runtime state', async () => {
    await expect(forceServerResourceRefresh('backup-restore')).resolves.toEqual({ status: 'ok', revision: 5 })

    expect(peekCachedServerCommandRevision()).toBe(5)
    expect(peekAppliedServerResourceRevision()).toBe(5)
    expect(get(selectedCharID)).toBe(1)
    expect(sideEffects.resetChatHydration).toHaveBeenCalledTimes(1)
    expect(sideEffects.hydrateActiveChat).toHaveBeenCalledWith({ force: true })
    expect(sideEffects.hydrateSelectedCharacter).toHaveBeenCalledWith({ supersede: true })
    expect(sideEffects.hydratePromptTemplate).toHaveBeenCalledWith({ force: true, minimumRevision: 5 })
    expect(sideEffects.applyGenerationBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ activeGenerationJobs: [{ chatId: 'chat-b', jobId: 'job-b' }] }),
      'full_resource_refresh',
    )
    expect(sideEffects.setTranslations).toHaveBeenCalledWith([
      { chatId: 'chat-b', messageId: 'message-b', jobId: 'translation-b', status: 'running' },
    ])
    expect(sideEffects.applyGenerationBootstrap.mock.invocationCallOrder[0]).toBeLessThan(
      sideEffects.triggerReattach.mock.invocationCallOrder[0],
    )
    expect(sideEffects.recordRefresh).toHaveBeenCalledWith('backup-restore', undefined)
  })

  it('rewinds revision fences when a replacement database has an older revision', async () => {
    setCachedServerCommandRevision(12)
    setAppliedServerResourceRevision(12)
    refreshApi.refreshAll.mockResolvedValueOnce({ status: 'ok', revision: 3, scope: 'full' })

    await expect(forceServerDatabaseReplacementRefresh('database-replacement-event')).resolves.toEqual({
      status: 'ok',
      revision: 3,
    })

    expect(peekCachedServerCommandRevision()).toBe(3)
    expect(peekAppliedServerResourceRevision()).toBe(3)
    expect(sideEffects.discardReaderProjection).toHaveBeenCalledOnce()
    expect(sideEffects.discardReaderProjection).toHaveBeenCalledWith('database-replacement')
  })

  it('resets replacement fences after an older in-flight full refresh drains', async () => {
    let finishOldRead!: () => void
    const oldReadFinished = new Promise<void>((resolve) => {
      finishOldRead = resolve
    })
    refreshApi.refreshAll
      .mockImplementationOnce(async () => {
        await oldReadFinished
        replaceResourceDatabase(database([{ chaId: 'char-old', name: 'Old database' }]), 12)
        return { status: 'ok', revision: 12, scope: 'full' }
      })
      .mockImplementationOnce(async () => {
        replaceResourceDatabase(database([{ chaId: 'char-restored', name: 'Restored database' }]), 3)
        return { status: 'ok', revision: 3, scope: 'full' }
      })

    const oldRefresh = forceServerResourceRefresh('old-database-refresh', { minimumRevision: 12 })
    await vi.waitFor(() => expect(refreshApi.refreshAll).toHaveBeenCalledTimes(1))
    const replacementRefresh = forceServerDatabaseReplacementRefresh('backup-restore')
    finishOldRead()

    await expect(Promise.all([oldRefresh, replacementRefresh])).resolves.toEqual([
      { status: 'ok', revision: 3 },
      { status: 'ok', revision: 3 },
    ])
    expect(refreshApi.refreshAll).toHaveBeenCalledTimes(2)
    expect(refreshApi.refreshAll).toHaveBeenNthCalledWith(2, expect.objectContaining({ minimumRevision: 0 }))
    expect(getResourceDatabase().characters[0]?.chaId).toBe('char-restored')
    expect(peekCachedServerCommandRevision()).toBe(3)
    expect(peekAppliedServerResourceRevision()).toBe(3)
  })

  it('preserves the selected character identity when a refresh reorders rows', async () => {
    refreshApi.refreshAll.mockImplementationOnce(async () => {
      replaceResourceDatabase(
        database(
          [
            { chaId: 'char-b', name: 'Bea refreshed' },
            { chaId: 'char-a', name: 'Ada refreshed' },
          ],
          1,
        ),
        6,
      )
      return { status: 'ok', revision: 6, scope: 'full' }
    })

    await forceServerResourceRefresh('realm-import')
    expect(get(selectedCharID)).toBe(0)
  })

  it('preserves a newer selection by character id when a pending refresh reorders rows', async () => {
    let finishRead!: () => void
    const readFinished = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    refreshApi.refreshAll.mockImplementationOnce(async () => {
      await readFinished
      replaceResourceDatabase(
        database(
          [
            { chaId: 'char-b', name: 'Bea refreshed' },
            { chaId: 'char-a', name: 'Ada refreshed' },
          ],
          0,
        ),
        6,
      )
      return { status: 'ok', revision: 6, scope: 'full' }
    })

    const refresh = forceServerResourceRefresh('backup-restore')
    await vi.waitFor(() => expect(refreshApi.refreshAll).toHaveBeenCalledTimes(1))
    selectedCharID.set(0)
    finishRead()
    await refresh

    expect(get(selectedCharID)).toBe(1)
    expect(getResourceDatabase().characters[get(selectedCharID)]?.chaId).toBe('char-a')
  })

  it('does not advance cursors or run hydration side effects after a failed read', async () => {
    refreshApi.refreshAll.mockResolvedValueOnce({ status: 'error', error: 'settings failed' })

    await expect(forceServerResourceRefresh('backup-restore')).resolves.toEqual({
      status: 'error',
      error: 'settings failed',
    })
    expect(peekCachedServerCommandRevision()).toBeNull()
    expect(peekAppliedServerResourceRevision()).toBeNull()
    expect(sideEffects.resetChatHydration).not.toHaveBeenCalled()
    expect(sideEffects.hydratePromptTemplate).not.toHaveBeenCalled()
    expect(sideEffects.hydrateSelectedCharacter).not.toHaveBeenCalled()
    expect(bootstrapApi.fetchReadOnly).not.toHaveBeenCalled()
  })

  it('invalidates body hydration before a selected prompt-template owner hydration failure', async () => {
    sideEffects.hydratePromptTemplate.mockResolvedValueOnce(false)

    await expect(forceServerResourceRefresh('backup-restore')).resolves.toEqual({
      status: 'error',
      error: 'Selected prompt-template owner hydration failed',
    })

    expect(peekCachedServerCommandRevision()).toBeNull()
    expect(peekAppliedServerResourceRevision()).toBeNull()
    expect(sideEffects.resetChatHydration).toHaveBeenCalledTimes(1)
    expect(sideEffects.resetLorebooks).toHaveBeenCalledTimes(1)
    expect(sideEffects.recordLorebooks).toHaveBeenCalledTimes(1)
    expect(sideEffects.hydrateActiveChat).toHaveBeenCalledWith({ force: true })
    expect(sideEffects.resetChatHydration.mock.invocationCallOrder[0]).toBeLessThan(
      sideEffects.hydratePromptTemplate.mock.invocationCallOrder[0],
    )
    expect(sideEffects.triggerReattach).not.toHaveBeenCalled()
    expect(bootstrapApi.fetchReadOnly).not.toHaveBeenCalled()
  })

  it('coalesces overlapping requests and performs one pending follow-up refresh', async () => {
    let resolveFirst: ((value: { status: 'ok'; revision: number; scope: 'full' }) => void) | undefined
    refreshApi.refreshAll
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce({ status: 'ok', revision: 7, scope: 'full' })

    const first = forceServerResourceRefresh('first', { minimumRevision: 6 })
    const second = forceServerResourceRefresh('second', { minimumRevision: 7 })
    expect(refreshApi.refreshAll).toHaveBeenNthCalledWith(1, expect.objectContaining({ minimumRevision: 6 }))
    expect(refreshApi.refreshAll).toHaveBeenCalledTimes(1)
    resolveFirst?.({ status: 'ok', revision: 6, scope: 'full' })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'ok', revision: 7 },
      { status: 'ok', revision: 7 },
    ])
    expect(refreshApi.refreshAll).toHaveBeenCalledTimes(2)
    expect(refreshApi.refreshAll).toHaveBeenNthCalledWith(2, expect.objectContaining({ minimumRevision: 7 }))
  })
})
