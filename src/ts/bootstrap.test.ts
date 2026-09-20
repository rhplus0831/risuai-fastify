import { setupBootstrapTests, bootstrapMocks, runtimeBootstrap, coreIt } from './bootstrap.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { currentGlobalPromptTemplateOwnerId, loadData, loadWebInitialDatabase } from './bootstrap'
import { getClientSessionSnapshot, requireClientAuthentication } from './clientSession'
import { loadPlugins } from './plugins/plugins.svelte'
import { alertError, alertRequiredSelect, waitAlert } from './alert'
import { language } from 'src/lang'
import * as languageRuntime from 'src/lang'
import { peekAppliedServerResourceRevision, peekCachedServerCommandRevision } from './server/commands'
import { getActiveWriterSessionId } from './server/activeWriterSession'
import { backgroundReady, getStartupCoordinatorSnapshot, getStartupReadinessSnapshot } from './startupReadiness'
import { selectedCharID } from './stores.svelte'
import { readerWorkspaceLifecycleStore } from './readerWorkspaceLifecycle.svelte'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

const {
  readerApi,
  bootstrapApi,
  resourceApi,
  commandApi,
  eventApi,
  hydrationApi,
  characterHydrationApi,
  promptTemplateApi,
  runtimeApi,
  recoveredGenerationApi,
  pendingMutationApi,
  activeWriterApi,
  pushApi,
} = bootstrapMocks

setupBootstrapTests()

describe('API-backed client bootstrap', () => {
  it('fails closed when the globally selected prompt owner is duplicated', () => {
    getDatabase().promptPresets = [
      { id: 'prompt-a', name: 'Prompt A' },
      { id: 'prompt-a', name: 'Duplicate Prompt A' },
    ] as never
    getDatabase().promptPresetsId = 0

    expect(currentGlobalPromptTemplateOwnerId()).toBeNull()
  })

  it('holds first shell capability for selected locale readiness', async () => {
    let release!: () => void
    const readiness = vi.spyOn(languageRuntime, 'awaitLanguageReady').mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const loading = loadData()
    await vi.waitFor(() => expect(readiness).toHaveBeenCalledOnce())
    expect(resourceApi.loadInitial).toHaveBeenCalledOnce()
    expect(getStartupCoordinatorSnapshot().capabilities.canRenderShell).toBe(false)
    expect(eventApi.subscribe).not.toHaveBeenCalled()
    expect(backgroundReady()).toBe(false)
    release()
    await loading
    expect(getStartupCoordinatorSnapshot().capabilities.canRenderShell).toBe(true)
    expect(backgroundReady()).toBe(true)
  })

  it.each(['unowned', 'owning'] as const)(
    'keeps a failed %s-writer locale recovery hidden after acquisition',
    async (ownership) => {
      const expectedEpoch = ownership === 'unowned' ? 0 : 1
      bootstrapApi.fetchReadOnly.mockResolvedValue(
        runtimeBootstrap({
          writerEpoch: expectedEpoch,
          writer: { sessionId: ownership === 'unowned' ? null : getActiveWriterSessionId(), epoch: expectedEpoch },
        }),
      )
      const failure = new Error('initial locale chunk unavailable')
      vi.spyOn(languageRuntime, 'awaitLanguageReady').mockRejectedValueOnce(failure)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await loadData()

      expect(waitAlert).not.toHaveBeenCalled()
      expect(alertError).not.toHaveBeenCalled()
      expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledOnce()
      expect(bootstrapApi.fetch).toHaveBeenCalledExactlyOnceWith(null, {
        expectedWriter: { epoch: expectedEpoch, databaseLineage: 'database-a' },
      })
      expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
      expect(readerApi.start).not.toHaveBeenCalled()
      expect(getClientSessionSnapshot()).toMatchObject({
        lifecycle: 'recovering-writer',
        connection: 'interrupted',
        authenticated: true,
        projectionReady: false,
      })
      expect(getStartupCoordinatorSnapshot().capabilities.canRenderShell).toBe(false)
      expect(backgroundReady()).toBe(false)
    },
  )

  it('clears a pending writer recovery when authentication is lost', async () => {
    vi.spyOn(languageRuntime, 'awaitLanguageReady').mockRejectedValueOnce(new Error('initial locale chunk unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadData()
    requireClientAuthentication()
    expect(getClientSessionSnapshot().lifecycle).toBe('auth-required')
    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(readerApi.start).not.toHaveBeenCalled()
  })

  it('starts a permanent reader without writer recovery, plugins, effects, or canonical selection', async () => {
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    selectedCharID.set(1)
    await loadData()
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      connection: 'live',
      projectionReady: true,
    })
    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({
      canRenderShell: true,
      canApplyRoutes: true,
      canMutate: false,
      canGenerate: false,
    })
    expect(get(selectedCharID)).toBe(1)
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(pendingMutationApi.readOwner).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(pendingMutationApi.replay).not.toHaveBeenCalled()
    expect(pendingMutationApi.flushAcknowledgements).not.toHaveBeenCalled()
    expect(eventApi.subscribe).not.toHaveBeenCalled()
    expect(loadPlugins).not.toHaveBeenCalled()
    expect(recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects).not.toHaveBeenCalled()
    expect(pushApi.initialize).not.toHaveBeenCalled()
    expect(readerApi.start).toHaveBeenCalledOnce()
    expect(peekAppliedServerResourceRevision()).toBe(5)
    expect(backgroundReady()).toBe(true)
  })

  // prettier-ignore
  coreIt('keeps commands blocked until the owning session finishes recovery, coherent hydration, and subscription', async () => {
    let releaseEvents!: (value: { status: 'ok'; unsubscribe: typeof eventApi.unsubscribe }) => void
    eventApi.subscribe.mockImplementationOnce((input) => {
      eventApi.subscriptions.push(input)
      return new Promise((resolve) => {
        releaseEvents = resolve
      })
    })
    resourceApi.loadInitial.mockResolvedValue({ status: 'ok', revision: 8, scope: 'shell' })
    const loading = loadData()
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledOnce())
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'recovering-writer',
      projectionReady: true,
      recoveryAuthorized: true,
    })
    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({
      canRenderShell: true,
      canApplyRoutes: true,
      canMutate: false,
    })
    expect(pendingMutationApi.readOwner).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetch).toHaveBeenCalledExactlyOnceWith(null, {
      expectedWriter: { epoch: 1, databaseLineage: 'database-a' },
    })
    expect(peekAppliedServerResourceRevision()).toBe(8)
    expect(eventApi.subscriptions[0]?.sinceRevision).toBe(8)
    releaseEvents({ status: 'ok', unsubscribe: eventApi.unsubscribe })
    await loading
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    expect(getStartupCoordinatorSnapshot().capabilities.canMutate).toBe(true)
    expect(readerApi.start).not.toHaveBeenCalled()
  })

  it('retries startup after the user acknowledges a transient bootstrap failure', async () => {
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'unavailable' }).mockResolvedValueOnce(runtimeBootstrap())

    await loadData()

    expect(alertError).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetch).toHaveBeenCalledTimes(2)
    expect(backgroundReady()).toBe(true)
    expect(getStartupReadinessSnapshot()).toMatchObject({
      phase: 'background-ready',
      attempts: [
        {
          attemptId: 1,
          failureCode: 'writer-bootstrap-failed',
          failureMilestone: 'reader-ready',
        },
        { attemptId: 2, completedAtMs: expect.any(Number) },
      ],
    })
  })

  it('loads resource APIs and writer runtime services without starting selected hydration owners', async () => {
    await loadWebInitialDatabase()

    expect(bootstrapApi.fetch).toHaveBeenCalledTimes(1)
    expect(pendingMutationApi.prepare).toHaveBeenCalledWith({
      writerSessionId: expect.any(String),
      writerEpoch: 1,
      databaseLineage: 'database-a',
      requestedWriterWasActive: true,
    })
    expect(pendingMutationApi.flushAcknowledgements).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(runtimeApi.configureGenerationOperationProtocol).toHaveBeenCalledWith(undefined, 'database-a')
    expect(pendingMutationApi.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      pendingMutationApi.replay.mock.invocationCallOrder[0],
    )
    expect(pendingMutationApi.replay.mock.invocationCallOrder[0]).toBeLessThan(
      resourceApi.loadInitial.mock.invocationCallOrder[0],
    )
    expect(resourceApi.loadInitial).toHaveBeenCalledWith({ hooks: resourceApi.hooks })
    expect(runtimeApi.applyGenerationOperationBootstrap).toHaveBeenCalledWith(runtimeBootstrap().bootstrap, 'startup')
    expect(pendingMutationApi.replay.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeApi.applyGenerationOperationBootstrap.mock.invocationCallOrder[0],
    )
    expect(resourceApi.loadInitial.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeApi.applyGenerationOperationBootstrap.mock.invocationCallOrder[0],
    )
    expect(runtimeApi.setGenerationFinalizationPersistences).toHaveBeenCalledWith([
      expect.objectContaining({ generationId: 'generation-a', state: 'queued' }),
    ])
    expect(peekCachedServerCommandRevision()).toBe(5)
    expect(peekAppliedServerResourceRevision()).toBe(5)
    expect(get(selectedCharID)).toBe(1)
    expect(runtimeApi.setActiveMessageTranslations).toHaveBeenCalledWith([{ chatId: 'chat-a', messageId: 'message-a' }])
    expect(runtimeApi.setActiveGreetingTranslations).toHaveBeenCalledWith([
      {
        characterId: 'char-a',
        chatId: 'chat-a',
        greetingIndex: -1,
        settingsHash: 'settings-a',
        jobId: 'greeting-job-a',
      },
    ])
    expect(hydrationApi.startChatMessageHydration).not.toHaveBeenCalled()
    expect(characterHydrationApi.startSelected).not.toHaveBeenCalled()
    expect(promptTemplateApi.ensure).not.toHaveBeenCalled()
    expect(eventApi.subscriptions[0]?.sinceRevision).toBe(5)
  })

  // prettier-ignore
  coreIt('preserves the owner, takeover, outbox, receipt, replay, projection, and event order', async () => {
    pendingMutationApi.readOwner.mockResolvedValueOnce({
      writerSessionId: 'recovered-writer',
      writerEpoch: 1,
      databaseLineage: 'database-a',
    })
    bootstrapApi.fetch
      .mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
      .mockResolvedValueOnce(runtimeBootstrap({ requestedWriterWasActive: false, writerEpoch: 2 }))

    await loadWebInitialDatabase()

    expect(pendingMutationApi.readOwner.mock.invocationCallOrder[0]).toBeLessThan(
      activeWriterApi.adoptPendingOwner.mock.invocationCallOrder[0],
    )
    expect(activeWriterApi.adoptPendingOwner.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrapApi.fetch.mock.invocationCallOrder[0],
    )
    expect(bootstrapApi.fetch.mock.invocationCallOrder[1]).toBeLessThan(
      pendingMutationApi.prepare.mock.invocationCallOrder[0],
    )
    expect(pendingMutationApi.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      pendingMutationApi.flushAcknowledgements.mock.invocationCallOrder[0],
    )
    expect(pendingMutationApi.flushAcknowledgements.mock.invocationCallOrder[0]).toBeLessThan(
      pendingMutationApi.replay.mock.invocationCallOrder[0],
    )
    expect(pendingMutationApi.replay.mock.invocationCallOrder[0]).toBeLessThan(
      resourceApi.loadInitial.mock.invocationCallOrder[0],
    )
    expect(resourceApi.loadInitial.mock.invocationCallOrder[0]).toBeLessThan(
      eventApi.subscribe.mock.invocationCallOrder[0],
    )
  })

  it('prompts before explicitly disconnecting a still-connected writer', async () => {
    bootstrapApi.fetch
      .mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
      .mockResolvedValueOnce(runtimeBootstrap({ requestedWriterWasActive: false, writerEpoch: 2 }))

    await loadWebInitialDatabase()

    expect(alertRequiredSelect).toHaveBeenCalledWith(
      [language.writerConnectDisconnectExisting, language.cancel],
      language.writerConnectConflictBody,
      language.writerConnectConflictTitle,
      { purpose: 'client-session' },
    )
    expect(bootstrapApi.fetch).toHaveBeenNthCalledWith(1)
    expect(bootstrapApi.fetch).toHaveBeenNthCalledWith(2, null, { disconnectExistingWriter: true })
    expect(pendingMutationApi.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ requestedWriterWasActive: false, writerEpoch: 2 }),
    )
  })

  it('leaves the existing writer connected when the new client cancels', async () => {
    bootstrapApi.fetch.mockResolvedValueOnce({
      status: 'active-writer-connected',
      error: 'active_writer_connected',
    })
    vi.mocked(alertRequiredSelect).mockResolvedValueOnce('1')

    await expect(loadWebInitialDatabase()).rejects.toThrow(language.writerConnectCancelled)

    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(resourceApi.loadInitial).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(get(readerWorkspaceLifecycleStore).mode).toBe('takeover-denied')
  })

  it('stops before hydration when transient failures leave encrypted changes queued', async () => {
    pendingMutationApi.replay.mockResolvedValue({ attempted: 1, discarded: 0, retained: 1, succeeded: 0 })
    pendingMutationApi.count.mockResolvedValue(1)

    await expect(loadWebInitialDatabase()).rejects.toThrow('pending changes')

    expect(resourceApi.loadInitial).not.toHaveBeenCalled()
  })

  it('hydrates with a retained generation control so Stop and Retry recovery UI can remain available', async () => {
    pendingMutationApi.replay.mockResolvedValue({
      attempted: 1,
      controlRetained: 1,
      discarded: 0,
      retained: 0,
      succeeded: 0,
    })
    pendingMutationApi.count.mockResolvedValue(0)

    await loadWebInitialDatabase()

    expect(resourceApi.loadInitial).toHaveBeenCalledOnce()
    expect(runtimeApi.applyGenerationOperationBootstrap).toHaveBeenCalledOnce()
  })

  it.each([1, null])('stops before hydration when the raw pending-row count is %s', async (count) => {
    pendingMutationApi.count.mockResolvedValue(count)

    await expect(loadWebInitialDatabase()).rejects.toThrow('pending changes')

    expect(resourceApi.loadInitial).not.toHaveBeenCalled()
  })

  it('warns when unsafe drafts are discarded during ownership preparation', async () => {
    pendingMutationApi.prepare.mockResolvedValue({ discarded: 2 })

    await loadWebInitialDatabase()

    expect(alertError).toHaveBeenCalledWith(expect.stringContaining('pending changes'))
  })

  // prettier-ignore
  coreIt('initializes a fresh server without refetching unchanged runtime metadata', async () => {
    bootstrapApi.fetch.mockResolvedValue(runtimeBootstrap({ initialized: false, revision: 0 }))

    await loadWebInitialDatabase()

    expect(commandApi.initialize).toHaveBeenCalledTimes(1)
    expect(bootstrapApi.fetchReadOnly).not.toHaveBeenCalled()
    expect(resourceApi.loadInitial).toHaveBeenCalledTimes(1)
    expect(runtimeApi.applyGenerationOperationBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ activeGenerationJobs: [{ chatId: 'chat-a', jobId: 'job-a' }] }),
      'startup',
    )
    expect(runtimeApi.setActiveMessageTranslations).toHaveBeenCalledWith([{ chatId: 'chat-a', messageId: 'message-a' }])
    expect(runtimeApi.setActiveGreetingTranslations).toHaveBeenCalledWith([
      {
        characterId: 'char-a',
        chatId: 'chat-a',
        greetingIndex: -1,
        settingsHash: 'settings-a',
        jobId: 'greeting-job-a',
      },
    ])
  })

  it('refetches runtime metadata when another client wins initialization', async () => {
    bootstrapApi.fetch.mockResolvedValue(runtimeBootstrap({ initialized: false, revision: 0 }))
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({
        initialized: true,
        revision: 1,
        activeGenerationJobs: [{ chatId: 'chat-b', jobId: 'job-b' }],
        activeMessageTranslations: [],
        activeGreetingTranslations: [],
      }),
    )
    commandApi.initialize.mockResolvedValue({ status: 'ok', revision: 1, initialized: false })

    await loadWebInitialDatabase()

    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledTimes(1)
    expect(runtimeApi.applyGenerationOperationBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ activeGenerationJobs: [{ chatId: 'chat-b', jobId: 'job-b' }] }),
      'startup',
    )
    expect(runtimeApi.setActiveMessageTranslations).toHaveBeenCalledWith([])
    expect(runtimeApi.setActiveGreetingTranslations).toHaveBeenCalledWith([])
  })

  it('keeps an acquired writer fenced after a fatal initialize conflict', async () => {
    bootstrapApi.fetch.mockResolvedValue(runtimeBootstrap({ initialized: false, revision: 0 }))
    commandApi.initialize.mockResolvedValue({
      status: 'error',
      error: 'initialize_conflict',
      reason: 'initialize-conflict',
    })

    await loadData()

    expect(commandApi.initialize).toHaveBeenCalledTimes(1)
    expect(bootstrapApi.fetch).toHaveBeenCalledTimes(1)
    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledOnce()
    expect(resourceApi.loadInitial).not.toHaveBeenCalled()
    expect(backgroundReady()).toBe(false)
    expect(alertError).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'recovering-writer',
      connection: 'interrupted',
      projectionReady: false,
    })
  })

  it('rejects unavailable bootstrap and failed resource reads without starting events', async () => {
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'unavailable' })
    await expect(loadWebInitialDatabase()).rejects.toThrow('Server bootstrap is unavailable')
    expect(eventApi.subscribe).not.toHaveBeenCalled()

    bootstrapApi.fetch.mockResolvedValueOnce(runtimeBootstrap())
    resourceApi.loadInitial.mockResolvedValueOnce({ status: 'error', error: 'settings failed' })
    await expect(loadWebInitialDatabase()).rejects.toThrow('Server resource load failed: settings failed')
    expect(eventApi.subscribe).not.toHaveBeenCalled()
  })

  it('keeps shell and mutation readiness when the selected prompt-template owner cannot be hydrated', async () => {
    promptTemplateApi.ensure.mockResolvedValueOnce(false)

    await loadData()

    expect(peekCachedServerCommandRevision()).toBe(5)
    expect(peekAppliedServerResourceRevision()).toBe(5)
    expect(eventApi.subscribe).toHaveBeenCalledOnce()
    expect(promptTemplateApi.ensure).toHaveBeenCalledWith({ promptPresetId: null, minimumRevision: 5 })
    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      capabilities: {
        canRenderShell: true,
        canMutate: true,
        canGenerate: false,
      },
      failures: {
        canGenerate: expect.objectContaining({ failureCode: 'selected-prompt-template-hydration-failed' }),
      },
    })

    selectedCharID.set(0)
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
    expect(promptTemplateApi.ensure).toHaveBeenCalledTimes(2)
  })
})
