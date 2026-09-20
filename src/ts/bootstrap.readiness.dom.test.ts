import { bootstrapMocks } from './bootstrap.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  discardGenerationRecoveryStartup,
  loadData,
  loadWebInitialDatabase,
  retryGenerationRecoveryStartup,
  retryPluginStartup,
  stopDeferredStartupRuntimes,
} from './bootstrap'
import { loadPlugins, startPluginRuntimeSync } from './plugins/plugins.svelte'
import { alertError, waitAlert } from './alert'
import { updateHeightMode } from './gui/heightMode'
import { peekAppliedServerResourceRevision } from './server/commands'
import {
  backgroundReady,
  getStartupChatReadinessEvaluations,
  getStartupCoordinatorSnapshot,
  getStartupReadinessSnapshot,
} from './startupReadiness'
import { applySettingsGroupResource } from './server/resourceState.svelte'
import { selectedCharID } from './stores.svelte'
import { currentRoute } from './router'
import { updateReducedMotion } from './gui/animation'
import { updateColorScheme, updateTextThemeAndCSS } from './gui/colorscheme'
import { updateGuisize } from './gui/guisize'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const {
  bootstrapApi,
  resourceApi,
  eventApi,
  hydrationApi,
  characterHydrationApi,
  promptTemplateApi,
  runtimeApi,
  recoveredGenerationApi,
  pendingMutationApi,
  pushApi,
  optionalRuntimeApi,
} = bootstrapMocks

describe('API-backed client bootstrap', () => {
  it('starts plugin runtime synchronization after the initial plugin load', async () => {
    await loadData()

    expect(loadPlugins).toHaveBeenCalledOnce()
    expect(startPluginRuntimeSync).toHaveBeenCalledOnce()
    expect(vi.mocked(loadPlugins).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(startPluginRuntimeSync).mock.invocationCallOrder[0],
    )
  })

  it('starts selected hydration after writer readiness and prepares reattach after chat dependencies', async () => {
    await loadData()

    expect(eventApi.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      characterHydrationApi.startSelected.mock.invocationCallOrder[0],
    )
    expect(eventApi.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      hydrationApi.startChatMessageHydration.mock.invocationCallOrder[0],
    )
    expect(promptTemplateApi.ensure.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeApi.startActiveGenerationReattach.mock.invocationCallOrder[0],
    )
    expect(runtimeApi.startActiveGenerationReattach.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeApi.prepareOpenChatGenerationReattach.mock.invocationCallOrder[0],
    )
  })

  it('localizes plugin startup failure and retries it without repeating successful startup steps', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(loadPlugins).mockRejectedValueOnce(new Error('plugin startup failed')).mockResolvedValueOnce(undefined)

    await loadData()

    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(resourceApi.loadInitial).toHaveBeenCalledOnce()
    expect(eventApi.subscribe).toHaveBeenCalledOnce()
    expect(pushApi.initialize).toHaveBeenCalledOnce()
    expect(loadPlugins).toHaveBeenCalledOnce()
    expect(startPluginRuntimeSync).not.toHaveBeenCalled()
    expect(backgroundReady()).toBe(true)
    expect(alertError).not.toHaveBeenCalled()
    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      capabilities: {
        canRenderShell: true,
        canApplyRoutes: true,
        canMutate: true,
        pluginsReady: false,
        canGenerate: false,
      },
      failures: {
        pluginsReady: expect.objectContaining({ failureCode: 'plugin-initialization-failed' }),
        canGenerate: expect.objectContaining({ failureCode: 'plugin-initialization-failed' }),
      },
    })
    expect(consoleWarn).toHaveBeenCalledWith('Plugin runtime initialization failed:', expect.any(Error))

    await expect(retryPluginStartup()).resolves.toBe(true)

    expect(loadPlugins).toHaveBeenCalledTimes(2)
    expect(startPluginRuntimeSync).toHaveBeenCalledOnce()
    expect(getStartupReadinessSnapshot().attempts).toEqual([
      expect.objectContaining({ attemptId: 1, completedAtMs: expect.any(Number) }),
      expect.objectContaining({ attemptId: 2, completedAtMs: expect.any(Number) }),
    ])
    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      capabilities: {
        canRenderShell: true,
        canApplyRoutes: true,
        canMutate: true,
        pluginsReady: true,
        canGenerate: true,
      },
      failures: {},
      completedSteps: expect.arrayContaining([
        'chat-hydration-runtime',
        'push-runtime',
        'plugin-runtime',
        'generation-recovery',
        'chat-readiness',
        'background-runtime',
        'background-readiness',
      ]),
    })
  })

  it('retries a localized generation recovery failure without repeating successful startup steps', async () => {
    const recoveryFailure = new Error('generation effects unavailable')
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects
      .mockRejectedValueOnce(recoveryFailure)
      .mockResolvedValueOnce(undefined)

    await loadData()

    expect(backgroundReady()).toBe(true)
    expect(recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects).toHaveBeenCalledOnce()
    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      capabilities: {
        canRenderShell: true,
        canApplyRoutes: true,
        canMutate: true,
        pluginsReady: true,
        canGenerate: false,
      },
      failures: {
        canGenerate: expect.objectContaining({ failureCode: 'generation-recovery-failed' }),
      },
    })
    expect(consoleWarn).toHaveBeenCalledWith('Generation recovery initialization failed:', recoveryFailure)

    await expect(retryGenerationRecoveryStartup()).resolves.toBe(true)

    expect(recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects).toHaveBeenCalledTimes(2)
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(resourceApi.loadInitial).toHaveBeenCalledOnce()
    expect(eventApi.subscribe).toHaveBeenCalledOnce()
    expect(pushApi.initialize).toHaveBeenCalledOnce()
    expect(loadPlugins).toHaveBeenCalledOnce()
    expect(startPluginRuntimeSync).toHaveBeenCalledOnce()
    expect(getStartupReadinessSnapshot().attempts).toEqual([
      expect.objectContaining({ attemptId: 1, completedAtMs: expect.any(Number) }),
      expect.objectContaining({ attemptId: 2, completedAtMs: expect.any(Number) }),
    ])
    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      capabilities: {
        canRenderShell: true,
        canApplyRoutes: true,
        canMutate: true,
        pluginsReady: true,
        canGenerate: true,
      },
      failures: {},
      completedSteps: expect.arrayContaining(['generation-recovery', 'chat-readiness', 'background-readiness']),
    })
  })

  it('discards a localized generation recovery failure and reopens generation', async () => {
    recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects.mockRejectedValueOnce(
      new Error('generation effects unavailable'),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await loadData()

    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(false)
    await expect(discardGenerationRecoveryStartup()).resolves.toBe(true)

    expect(recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects).toHaveBeenCalledOnce()
    expect(recoveredGenerationApi.discardPendingRecoveredGenerationEffects).toHaveBeenCalledOnce()
    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      capabilities: { canGenerate: true },
      failures: {},
      completedSteps: expect.arrayContaining(['generation-recovery']),
    })
  })

  it('allows plugin and chat readiness to complete while push initialization is delayed', async () => {
    let releasePush!: () => void
    pushApi.initialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePush = resolve
        }),
    )

    const loading = loadData()

    await vi.waitFor(() => expect(loadPlugins).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({
      canRenderShell: true,
      canMutate: true,
      pluginsReady: true,
    })
    expect(backgroundReady()).toBe(false)

    releasePush()
    await loading
    expect(backgroundReady()).toBe(true)
  })

  it('isolates a failed push initialization from shell, mutation, and chat readiness', async () => {
    const pushFailure = new Error('push storage unavailable')
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pushApi.initialize.mockRejectedValueOnce(pushFailure)

    await loadData()

    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({
      canRenderShell: true,
      canMutate: true,
      pluginsReady: true,
      canGenerate: true,
    })
    expect(backgroundReady()).toBe(true)
    expect(alertError).not.toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalledWith('Failed to initialize push runtime:', pushFailure)
  })

  it('owns idempotent cleanup for deferred app and plugin runtimes', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const removeEventListener = vi.spyOn(window, 'removeEventListener')

    await loadData()

    expect(optionalRuntimeApi.installStoreEffects).toHaveBeenCalledOnce()
    expect(optionalRuntimeApi.startObserver).toHaveBeenCalledOnce()
    expect(addEventListener.mock.calls.filter(([type]) => type === 'error')).toHaveLength(1)
    expect(addEventListener.mock.calls.filter(([type]) => type === 'unhandledrejection')).toHaveLength(1)

    stopDeferredStartupRuntimes()
    stopDeferredStartupRuntimes()

    expect(optionalRuntimeApi.disposeStoreEffects).toHaveBeenCalledOnce()
    expect(optionalRuntimeApi.stopObserver).toHaveBeenCalledOnce()
    expect(pushApi.stop).toHaveBeenCalledOnce()
    expect(optionalRuntimeApi.stopPluginSync).toHaveBeenCalledTimes(2)
    expect(removeEventListener.mock.calls.filter(([type]) => type === 'error')).toHaveLength(1)
    expect(removeEventListener.mock.calls.filter(([type]) => type === 'unhandledrejection')).toHaveLength(1)
  })

  it('shares one coordinator attempt loop between concurrent startup callers', async () => {
    let releasePlugins!: () => void
    vi.mocked(loadPlugins).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePlugins = resolve
        }),
    )

    const firstLoad = loadData()
    const secondLoad = loadData()
    expect(secondLoad).toBe(firstLoad)
    await vi.waitFor(() => expect(loadPlugins).toHaveBeenCalledOnce())

    releasePlugins()
    await Promise.all([firstLoad, secondLoad])

    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(eventApi.subscribe).toHaveBeenCalledOnce()
    expect(getStartupReadinessSnapshot().attempts).toHaveLength(1)
  })

  it('keeps event revisions contiguous across coordinator transitions', async () => {
    let releasePush!: () => void
    pushApi.initialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePush = resolve
        }),
    )
    let releasePlugins!: () => void
    vi.mocked(loadPlugins).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePlugins = resolve
        }),
    )
    let releaseCharacter!: () => void
    characterHydrationApi.hydrateSelected.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCharacter = () => resolve(true)
        }),
    )
    let releaseWarning!: () => void
    vi.mocked(waitAlert).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof waitAlert>>>((resolve) => {
          releaseWarning = () => resolve({ type: 'none', msg: '' })
        }),
    )

    const secureContextDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    localStorage.removeItem('insecureOriginWarned')
    eventApi.subscribe.mockImplementationOnce(async (input) => {
      eventApi.subscriptions.push(input)
      input.onCommandEvent({ type: 'settings.updated', revision: 6, resource: 'settings' })
      return { status: 'ok', unsubscribe: eventApi.unsubscribe }
    })

    let loading: Promise<void> | undefined
    try {
      loading = loadData()

      await vi.waitFor(() => expect(pushApi.initialize).toHaveBeenCalledOnce())
      expect(eventApi.subscriptions[0]?.sinceRevision).toBe(5)
      await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(6))

      eventApi.subscriptions[0].onCommandEvent({ type: 'settings.updated', revision: 7, resource: 'settings' })
      await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(7))
      releasePush()

      await vi.waitFor(() => expect(loadPlugins).toHaveBeenCalledOnce())
      eventApi.subscriptions[0].onCommandEvent({ type: 'settings.updated', revision: 8, resource: 'settings' })
      await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(8))
      releasePlugins()

      await vi.waitFor(() => expect(characterHydrationApi.hydrateSelected).toHaveBeenCalled())
      eventApi.subscriptions[0].onCommandEvent({ type: 'settings.updated', revision: 9, resource: 'settings' })
      await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(9))
      releaseCharacter()

      await vi.waitFor(() => expect(waitAlert).toHaveBeenCalledOnce())
      expect(getStartupReadinessSnapshot().phase).toBe('chat-ready')
      eventApi.subscriptions[0].onCommandEvent({ type: 'settings.updated', revision: 10, resource: 'settings' })
      await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(10))
      releaseWarning()

      await loading
      expect(getStartupReadinessSnapshot().phase).toBe('background-ready')
      expect(resourceApi.refreshInvalidated.mock.calls.map(([events]) => events)).toEqual([
        [expect.objectContaining({ revision: 6 })],
        [expect.objectContaining({ revision: 7 })],
        [expect.objectContaining({ revision: 8 })],
        [expect.objectContaining({ revision: 9 })],
        [expect.objectContaining({ revision: 10 })],
      ])
    } finally {
      releasePush?.()
      releasePlugins?.()
      releaseCharacter?.()
      releaseWarning?.()
      await loading?.catch(() => undefined)
      localStorage.removeItem('insecureOriginWarned')
      if (secureContextDescriptor) Object.defineProperty(window, 'isSecureContext', secureContextDescriptor)
      else Reflect.deleteProperty(window, 'isSecureContext')
    }
  })

  it('reports the selected-character dependency without blocking the readable shell', async () => {
    characterHydrationApi.hydrateSelected.mockResolvedValueOnce(false)

    await loadData()

    expect(backgroundReady()).toBe(true)
    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      capabilities: {
        canRenderShell: true,
        canMutate: true,
        canGenerate: false,
      },
      failures: {
        canGenerate: expect.objectContaining({ failureCode: 'selected-character-hydration-failed' }),
      },
    })
    expect(hydrationApi.hydrateActiveChat).not.toHaveBeenCalled()

    selectedCharID.set(0)
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
    expect(getStartupCoordinatorSnapshot().failures.canGenerate).toBeUndefined()
  })

  it('loads the selected chat and prompt together while keeping generation gated until both settle', async () => {
    let releaseChat!: (ready: boolean) => void
    let releasePrompt!: (ready: boolean) => void
    hydrationApi.hydrateActiveChat.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseChat = resolve
        }),
    )
    promptTemplateApi.ensure.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releasePrompt = resolve
        }),
    )

    const loading = loadData()
    await vi.waitFor(() => expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledOnce())
    expect(promptTemplateApi.ensure).toHaveBeenCalledOnce()
    releasePrompt(true)
    await Promise.resolve()
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(false)
    releaseChat(true)
    await loading
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true)
  })

  it('fences same-character chat hydration and ignores an older target result', async () => {
    await loadData()
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true)
    hydrationApi.hydrateActiveChat.mockClear()

    let releaseOlderChat!: (ready: boolean) => void
    hydrationApi.hydrateActiveChat.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseOlderChat = resolve
        }),
    )
    withTestDatabaseWrite(() => {
      const character = getDatabase().characters[1]
      character.chats.push({ id: 'chat-b-new', message: [] } as never)
      character.chatPage = 1
    })
    hydrationApi.readinessRefreshHook?.()

    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(false)
    await vi.waitFor(() => expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledOnce())

    let releaseNewerChat!: (ready: boolean) => void
    hydrationApi.hydrateActiveChat.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseNewerChat = resolve
        }),
    )
    withTestDatabaseWrite(() => {
      getDatabase().characters[1].chatPage = 0
    })
    hydrationApi.readinessRefreshHook?.()
    await vi.waitFor(() => expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledTimes(2))
    const evaluations = getStartupChatReadinessEvaluations()
    expect(evaluations).toHaveLength(2)
    expect(new Set(evaluations.map((evaluation) => evaluation.evaluationId)).size).toBe(2)
    expect(evaluations.map((evaluation) => evaluation.target.split('\u0000')[4]).sort()).toEqual([
      'chat-b',
      'chat-b-new',
    ])
    expect(evaluations.every((evaluation) => evaluation.phase === 'chat-and-prompt')).toBe(true)
    releaseNewerChat(true)
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
    expect(getStartupChatReadinessEvaluations()).toHaveLength(1)

    releaseOlderChat(false)
    await vi.waitFor(() => expect(getStartupChatReadinessEvaluations()).toEqual([]))
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true)
    expect(getStartupCoordinatorSnapshot().failures.canGenerate).toBeUndefined()
  })

  it('fences same-chat prompt hydration and ignores an older owner result', async () => {
    await loadData()
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true)
    promptTemplateApi.ensure.mockClear()

    let releaseOlderPrompt!: (ready: boolean) => void
    promptTemplateApi.ensure.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseOlderPrompt = resolve
        }),
    )
    withTestDatabaseWrite(() => {
      getDatabase().characters[1].chats[0].generationSettings = { promptPresetId: 'prompt-older' }
    })
    hydrationApi.readinessRefreshHook?.()

    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(false)
    await vi.waitFor(() =>
      expect(promptTemplateApi.ensure).toHaveBeenCalledWith({
        applyProjection: false,
        promptPresetId: 'prompt-older',
        minimumRevision: 5,
      }),
    )

    withTestDatabaseWrite(() => {
      getDatabase().characters[1].chats[0].generationSettings = { promptPresetId: 'prompt-newer' }
    })
    hydrationApi.readinessRefreshHook?.()
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
    expect(promptTemplateApi.ensure).toHaveBeenCalledWith({
      applyProjection: false,
      promptPresetId: 'prompt-newer',
      minimumRevision: 5,
    })

    releaseOlderPrompt(false)
    await Promise.resolve()
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true)
    expect(getStartupCoordinatorSnapshot().failures.canGenerate).toBeUndefined()
  })

  it('supersedes selected-chat readiness when only the route identity changes', async () => {
    await loadData()
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true)
    characterHydrationApi.hydrateSelected.mockClear()

    let releaseOlderRoute!: (ready: boolean) => void
    characterHydrationApi.hydrateSelected.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseOlderRoute = resolve
        }),
    )
    currentRoute.set({ kind: 'settings', path: '/settings/model', section: 'model', index: 17 })

    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(false)
    await vi.waitFor(() => expect(characterHydrationApi.hydrateSelected).toHaveBeenCalledOnce())

    currentRoute.set({ kind: 'character', path: '/character/char-b/chat-b', chaId: 'char-b', chatId: 'chat-b' })
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))

    releaseOlderRoute(true)
    await Promise.resolve()
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true)
    expect(getStartupCoordinatorSnapshot().failures.canGenerate).toBeUndefined()
  })

  it('reconciles disabled device push state after the initial settings load', async () => {
    await loadData()

    expect(pushApi.initialize).toHaveBeenCalledOnce()
    expect(pushApi.initialize.mock.invocationCallOrder[0]).toBeLessThan(pushApi.reconcile.mock.invocationCallOrder[0])
    expect(pushApi.reconcile).toHaveBeenCalledTimes(2)
    expect(pushApi.reconcile).toHaveBeenNthCalledWith(1, false)
    expect(pushApi.reconcile).toHaveBeenNthCalledWith(2, false)
  })

  it('reconciles a notification projection received while startup is still loading', async () => {
    let releasePlugins!: () => void
    vi.mocked(loadPlugins).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePlugins = resolve
        }),
    )

    const loading = loadData()
    await vi.waitFor(() => expect(loadPlugins).toHaveBeenCalledOnce())
    expect(backgroundReady()).toBe(false)

    expect(
      applySettingsGroupResource(
        {
          revision: 6,
          group: 'display',
          settings: { notification: true },
        },
        ['notification'],
      ),
    ).toBe(true)
    expect(pushApi.reconcile).toHaveBeenCalledTimes(1)
    expect(pushApi.reconcile).toHaveBeenLastCalledWith(false)

    releasePlugins()
    await loading

    expect(pushApi.reconcile).toHaveBeenCalledTimes(2)
    expect(pushApi.reconcile).toHaveBeenLastCalledWith(true)
  })

  it('reapplies display runtime effects after an authoritative settings projection', () => {
    expect(
      applySettingsGroupResource(
        {
          revision: 6,
          group: 'display',
          settings: {
            animationSpeed: 0.5,
            heightMode: 'dvh',
            colorScheme: {
              bgcolor: '#282a36',
              darkbg: '#21222c',
              borderc: '#6272a4',
              selected: '#44475a',
              draculared: '#ff5555',
              textcolor: '#f8f8f2',
              textcolor2: '#94a3b8',
              darkBorderc: '#4b5563',
              darkbutton: '#374151',
              type: 'dark',
            },
            textAreaSize: 2,
            textTheme: 'highcontrast',
          },
        },
        ['animationSpeed', 'colorScheme', 'heightMode', 'textAreaSize', 'textTheme'],
      ),
    ).toBe(true)

    expect(updateColorScheme).toHaveBeenCalledOnce()
    expect(updateTextThemeAndCSS).toHaveBeenCalledOnce()
    expect(updateGuisize).toHaveBeenCalledOnce()
    expect(updateReducedMotion).toHaveBeenCalledOnce()
    expect(updateHeightMode).toHaveBeenCalledOnce()
  })

  it('reconciles device push state after an authoritative notification projection', async () => {
    await loadData()
    pushApi.reconcile.mockClear()

    expect(
      applySettingsGroupResource(
        {
          revision: 6,
          group: 'display',
          settings: { notification: true },
        },
        ['notification'],
      ),
    ).toBe(true)

    await vi.waitFor(() => expect(pushApi.reconcile).toHaveBeenCalledOnce())
    expect(pushApi.reconcile).toHaveBeenCalledWith(true)
  })

  it('preserves newer generation effects when startup authority was superseded during recovery', async () => {
    runtimeApi.applyGenerationOperationBootstrap.mockReturnValueOnce(false)

    await loadWebInitialDatabase()

    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(runtimeApi.applyGenerationOperationBootstrap).toHaveBeenCalledOnce()
    expect(recoveredGenerationApi.setPendingRecoveredGenerationEffects).not.toHaveBeenCalled()
    expect(runtimeApi.setGenerationFinalizationPersistences).not.toHaveBeenCalled()
    expect(runtimeApi.startGenerationFinalizationPersistenceRefresh).toHaveBeenCalledOnce()
  })
})
