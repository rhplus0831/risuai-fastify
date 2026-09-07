import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const readerApi = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), retry: vi.fn() }))

const bootstrapApi = vi.hoisted(() => ({
  fetch: vi.fn(),
  fetchReadOnly: vi.fn(),
}))

const resourceApi = vi.hoisted(() => ({
  loadInitial: vi.fn(),
  readAll: vi.fn(),
  refreshInvalidated: vi.fn(),
  forceRefresh: vi.fn(),
  forceReplacement: vi.fn(),
  hooks: { kind: 'resource-hooks' },
}))

const routeResourceApi = vi.hoisted(() => ({
  ensure: vi.fn(async () => undefined),
  stop: vi.fn(),
}))

const commandApi = vi.hoisted(() => ({
  initialize: vi.fn(),
  reconciler: null as null | ((event: any, events: any[], localEffects: ReadonlyMap<number, any>) => Promise<void>),
}))

const eventApi = vi.hoisted(() => ({
  subscriptions: [] as Array<{
    sinceRevision?: number | null
    onCommandEvent: (event: TestCommandEvent) => void
    onMemoryEvent?: (event: TestMemoryEvent) => void
    onMemorySnapshot?: (snapshot: TestMemorySnapshot) => void
    onWriterEvent?: (event: TestWriterEvent) => void
    onFrame?: (frame?: { event: string; data: string }) => void
    onError?: (error: string) => void
    onClose?: () => void
  }>,
  unsubscribe: vi.fn(),
  subscribe: vi.fn(),
}))

const hydrationApi = vi.hoisted(() => ({
  acknowledgeCreatedChatTranscriptLocalEffect: vi.fn(() => true),
  acknowledgeMessageMutationLocalEffect: vi.fn(() => true),
  applyMessageTranslationLocalEffect: vi.fn(() => true),
  hydrateActiveChat: vi.fn(async () => true),
  invalidateChatHydration: vi.fn(),
  readinessRefreshHook: null as null | (() => void),
  requestReadinessRefresh: vi.fn(),
  resetChatHydration: vi.fn(),
  startChatMessageHydration: vi.fn(),
  stopChatMessageHydration: vi.fn(),
}))
const characterHydrationApi = vi.hoisted(() => ({
  clear: vi.fn(),
  hydrateSelected: vi.fn(async () => true),
  startSelected: vi.fn(),
  stopSelected: vi.fn(),
}))

const lorebookApi = vi.hoisted(() => ({
  isCharacterLorebookHydrated: vi.fn(() => true),
  recordHydratedCharacterLorebooks: vi.fn(),
  resetLorebookHydration: vi.fn(),
}))

const promptTemplateApi = vi.hoisted(() => ({
  ensure: vi.fn(async () => true),
  hasOwnerEpochChanged: vi.fn(() => false),
  isHydrated: vi.fn(() => true),
  isTainted: vi.fn(() => false),
  markProjectionApplied: vi.fn(),
  peekOwnerRevision: vi.fn((): number | null => 5),
  reset: vi.fn(),
}))

const runtimeApi = vi.hoisted(() => ({
  prepareOpenChatGenerationReattach: vi.fn(async () => undefined),
  setActiveGenerationReattachReadinessPredicate: vi.fn(),
  setActiveGenerationJobs: vi.fn(),
  setGenerationFinalizationPersistences: vi.fn(),
  startGenerationFinalizationPersistenceRefresh: vi.fn(),
  stopGenerationFinalizationPersistenceRefresh: vi.fn(),
  startActiveGenerationReattach: vi.fn(),
  stopActiveGenerationReattach: vi.fn(),
  triggerOpenChatGenerationReattach: vi.fn(),
  setActiveMessageTranslations: vi.fn(),
  startActiveMessageTranslationRefresh: vi.fn(),
  stopActiveMessageTranslationRefresh: vi.fn(),
  setActiveGreetingTranslations: vi.fn(),
  startActiveGreetingTranslationRefresh: vi.fn(),
  stopActiveGreetingTranslationRefresh: vi.fn(),
  applyGenerationOperationBootstrap: vi.fn(),
  configureGenerationOperationProtocol: vi.fn(),
}))
const recoveredGenerationApi = vi.hoisted(() => ({
  discardPendingRecoveredGenerationEffects: vi.fn(async () => undefined),
  reconcilePendingRecoveredGenerationEffects: vi.fn(async () => undefined),
  setPendingRecoveredGenerationEffects: vi.fn(),
}))

const ownerMutationLifecycleApi = vi.hoisted(() => ({ stop: vi.fn(), start: vi.fn() }))
const pendingMutationApi = vi.hoisted(() => ({
  count: vi.fn(),
  flushAcknowledgements: vi.fn(),
  prepare: vi.fn(),
  readOwner: vi.fn(),
  replay: vi.fn(),
  scope: null as string | null,
}))
const ownershipApi = vi.hoisted(() => ({ count: vi.fn(() => 0), discard: vi.fn(), reset: vi.fn() }))
const projectionLifecycleApi = vi.hoisted(() => ({ discard: vi.fn(async (_reason: string) => undefined) }))
const memoryApi = vi.hoisted(() => ({ publish: vi.fn(), applyEvent: vi.fn(() => true), applySnapshot: vi.fn() }))
const activeWriterApi = vi.hoisted(() => ({ adoptPendingOwner: vi.fn(), enterTakeover: vi.fn() }))
const pushApi = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  reconcile: vi.fn(async () => ({ status: 'applied' })),
  stop: vi.fn(),
}))
const optionalRuntimeApi = vi.hoisted(() => ({
  disposeStoreEffects: vi.fn(),
  installStoreEffects: vi.fn(),
  startObserver: vi.fn(),
  stopObserver: vi.fn(),
  stopPluginSync: vi.fn(),
}))

interface TestCommandEvent {
  type: string
  revision: number
  resource: string
  id?: string
  parentId?: string
  origin?: { writerSessionId: string }
}

interface TestMemoryEvent {
  type: 'memory.job'
  streamId: string
  version: number
  chatId: string
  job: {
    id: string
    instanceId: string
    kind: string
    status: string
    attemptCount: number
    maxAttempts: number
    updatedAt?: string
  }
}

interface TestMemorySnapshot {
  type: 'memory.snapshot'
  streamId: string
  version: number
  jobs: Array<TestMemoryEvent['job'] & { chatId: string }>
}

interface TestWriterEvent {
  sessionId: string | null
  epoch: number
}

// The lifecycle's real hydration/cache clearing has its own focused suite.
// Keep bootstrap ordering independent of that cold dynamic import's duration.
vi.mock('./observerProjectionLifecycle', () => ({
  discardObserverProjectionState: projectionLifecycleApi.discard,
}))

vi.mock('./server/connectedTabIdentity', () => ({
  resolveConnectedTabIdentity: async () => ({
    sessionId: getActiveWriterSessionId(),
    exclusive: true,
    previousSessionId: null,
  }),
  releaseConnectedTabIdentity: vi.fn(),
}))
vi.mock('./server/connectedReaderSync', () => ({ startConnectedReaderSync: readerApi.start }))

vi.mock('./server/bootstrap', () => ({
  fetchServerBootstrap: bootstrapApi.fetch,
  fetchServerBootstrapReadOnly: bootstrapApi.fetchReadOnly,
}))

vi.mock('./storage/fastifyStorage', async (importActual) => {
  const actual = await importActual<typeof import('./storage/fastifyStorage')>()
  return {
    ...actual,
    getNodeServerProxyAuth: async () => 'bootstrap-test-auth-token',
  }
})

vi.mock('./server/resourceInvalidation', () => ({
  loadInitialServerResources: resourceApi.loadInitial,
  refreshAllServerResources: resourceApi.readAll,
  refreshInvalidatedServerResources: resourceApi.refreshInvalidated,
}))

vi.mock('./server/routeResourceLoader', () => ({
  ensureResourceSurfaces: routeResourceApi.ensure,
  stopRouteResourceLoader: routeResourceApi.stop,
}))

vi.mock('./server/resourceRefresh', () => ({
  forceServerDatabaseReplacementRefresh: resourceApi.forceReplacement,
  forceServerResourceRefresh: resourceApi.forceRefresh,
  serverResourceInvalidationHooks: resourceApi.hooks,
}))

vi.mock('./server/events', () => ({ subscribeServerCommandEvents: eventApi.subscribe }))
vi.mock('./server/activeWriterSession', async (importActual) => {
  const actual = await importActual<typeof import('./server/activeWriterSession')>()
  return {
    ...actual,
    adoptPendingMutationWriterSessionId: (sessionId: string) => {
      activeWriterApi.adoptPendingOwner(sessionId)
      return actual.adoptPendingMutationWriterSessionId(sessionId)
    },
    enterWriterTakeoverFlow: activeWriterApi.enterTakeover,
  }
})
vi.mock('./server/chatMessageHydration.svelte', () => ({
  ...hydrationApi,
  requestActiveChatReadinessRefresh: hydrationApi.requestReadinessRefresh,
  setActiveChatReadinessRefreshHook: (hook: (() => void) | null) => {
    hydrationApi.readinessRefreshHook = hook
  },
}))
vi.mock('./server/characterShellHydration.svelte', () => ({
  clearCharacterShellHydrationState: characterHydrationApi.clear,
  hydrateSelectedCharacterShell: characterHydrationApi.hydrateSelected,
  startSelectedCharacterShellHydration: characterHydrationApi.startSelected,
  stopSelectedCharacterShellHydration: characterHydrationApi.stopSelected,
}))
vi.mock('./server/lorebookOwner.svelte', () => lorebookApi)
vi.mock('./server/promptTemplateHydration', () => ({
  ensurePromptTemplateHydrated: promptTemplateApi.ensure,
  hasPromptTemplateOwnerProjectionEpochChanged: promptTemplateApi.hasOwnerEpochChanged,
  isPromptTemplateHydrated: promptTemplateApi.isHydrated,
  isPromptTemplateOwnerAcknowledgementTainted: promptTemplateApi.isTainted,
  markPromptTemplateProjectionApplied: promptTemplateApi.markProjectionApplied,
  peekPromptTemplateOwnerRevision: promptTemplateApi.peekOwnerRevision,
  resetPromptTemplateHydration: promptTemplateApi.reset,
}))
vi.mock('./server/ownerMutationLifecycle', () => ({
  startOwnerMutationLifecycleFlush: ownerMutationLifecycleApi.start,
}))
vi.mock('./server/pendingMutationReplay', () => ({
  replayPendingMutations: pendingMutationApi.replay,
}))
vi.mock('./server/pendingMutationOutbox', () => ({
  countBlockingPendingMutationRecords: pendingMutationApi.count,
  preparePendingMutationOutbox: pendingMutationApi.prepare,
  readSinglePendingMutationOwner: pendingMutationApi.readOwner,
  stagePendingMutation: vi.fn(),
}))
vi.mock('./server/pendingOwnerMutationRegistry', async (importActual) => {
  const actual = await importActual<typeof import('./server/pendingOwnerMutationRegistry')>()
  return { ...actual, resetRegisteredOwnerState: ownershipApi.reset }
})
vi.mock('./server/durableMutationDispatch', () => ({
  countRegisteredDurableMutationSettlements: ownershipApi.count,
  discardRegisteredDurableMutationSettlements: ownershipApi.discard,
  flushPendingMutationReceiptAcknowledgements: pendingMutationApi.flushAcknowledgements,
  setPendingMutationDiscardNotifier: vi.fn(),
}))
vi.mock('./process/reattach', () => ({
  prepareOpenChatGenerationReattach: runtimeApi.prepareOpenChatGenerationReattach,
  setActiveGenerationReattachReadinessPredicate: runtimeApi.setActiveGenerationReattachReadinessPredicate,
  setActiveGenerationJobs: runtimeApi.setActiveGenerationJobs,
  startActiveGenerationReattach: runtimeApi.startActiveGenerationReattach,
  stopActiveGenerationReattach: runtimeApi.stopActiveGenerationReattach,
  triggerOpenChatGenerationReattach: runtimeApi.triggerOpenChatGenerationReattach,
}))
vi.mock('./process/generationPersistenceState', () => ({
  setGenerationFinalizationPersistences: runtimeApi.setGenerationFinalizationPersistences,
  startGenerationFinalizationPersistenceRefresh: runtimeApi.startGenerationFinalizationPersistenceRefresh,
  stopGenerationFinalizationPersistenceRefresh: runtimeApi.stopGenerationFinalizationPersistenceRefresh,
}))
vi.mock('./process/recoveredGenerationEffects', () => recoveredGenerationApi)
vi.mock('./server/messageTranslationJobs', () => ({
  setActiveMessageTranslations: runtimeApi.setActiveMessageTranslations,
  startActiveMessageTranslationRefresh: runtimeApi.startActiveMessageTranslationRefresh,
  stopActiveMessageTranslationRefresh: runtimeApi.stopActiveMessageTranslationRefresh,
}))
vi.mock('./server/greetingTranslations.svelte', () => ({
  setActiveGreetingTranslations: runtimeApi.setActiveGreetingTranslations,
  startActiveGreetingTranslationRefresh: runtimeApi.startActiveGreetingTranslationRefresh,
  stopActiveGreetingTranslationRefresh: runtimeApi.stopActiveGreetingTranslationRefresh,
}))
vi.mock('./server/generationOperations', () => ({
  applyGenerationOperationBootstrap: runtimeApi.applyGenerationOperationBootstrap,
  configureGenerationOperationProtocol: runtimeApi.configureGenerationOperationProtocol,
}))
vi.mock('./server/memoryJobEvents', () => ({ publishServerMemoryJobEvent: memoryApi.publish }))
vi.mock('./server/memoryJobProjection.svelte', () => ({
  applyServerMemoryJobEvent: memoryApi.applyEvent,
  applyServerMemoryJobSnapshot: memoryApi.applySnapshot,
}))

vi.mock('./server/commands', async (importActual) => {
  const actual = await importActual<typeof import('./server/commands')>()
  return {
    ...actual,
    initializeServerDatabaseForBootstrap: commandApi.initialize,
    setServerCommandSuccessReconciler: (reconciler: typeof commandApi.reconciler) => {
      commandApi.reconciler = reconciler
      actual.setServerCommandSuccessReconciler(reconciler)
    },
  }
})

vi.mock('./plugins/plugins.svelte', () => ({
  isPluginRuntimeReady: () => true,
  loadPlugins: vi.fn(async () => undefined),
  startPluginRuntimeSync: vi.fn(),
  stopPluginRuntimeSync: optionalRuntimeApi.stopPluginSync,
}))
vi.mock('./alert', () => ({
  alertError: vi.fn(),
  alertMd: vi.fn(),
  alertRequiredSelect: vi.fn(async () => '0'),
  waitAlert: vi.fn(async () => undefined),
}))
vi.mock('./gui/animation', () => ({ updateReducedMotion: vi.fn() }))
vi.mock('./gui/colorscheme', () => ({ updateColorScheme: vi.fn(), updateTextThemeAndCSS: vi.fn() }))
vi.mock('./gui/guisize', () => ({ updateGuisize: vi.fn() }))
vi.mock('./gui/heightMode', () => ({ updateHeightMode: vi.fn() }))
vi.mock('./observer.svelte', () => ({
  startObserveDom: optionalRuntimeApi.startObserver,
  stopObserveDom: optionalRuntimeApi.stopObserver,
}))
vi.mock('./stores/runtimeEffects.svelte', () => ({
  installStoreRuntimeEffects: optionalRuntimeApi.installStoreEffects,
}))
vi.mock('./process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))
vi.mock('./model/modellist', () => ({
  getModelInfo: vi.fn(() => ({ type: 'chat' })),
  registerModelDynamic: vi.fn(),
}))
vi.mock('./server/pushNotificationSetting', () => ({
  initializePushNotificationCoordinator: pushApi.initialize,
  reconcileChatCompletionPushNotificationSetting: pushApi.reconcile,
  stopPushNotificationCoordinator: pushApi.stop,
}))

import {
  calculateServerResourceReconnectDelayMs,
  createGlobalErrorHandlers,
  currentGlobalPromptTemplateOwnerId,
  discardGenerationRecoveryStartup,
  loadData,
  loadWebInitialDatabase,
  promoteConnectedReader,
  retryGenerationRecoveryStartup,
  retryObserverWriterPromotion,
  retryPluginStartup,
  stopDeferredStartupRuntimes,
  stopConnectedClientServices,
  stopServerResourceEvents,
} from './bootstrap'
import {
  canUseClientWriteAccess,
  clientSessionStore,
  getClientSessionSnapshot,
  observeClientWriter,
  setClientConnectionState,
} from './clientSession'
import { loadPlugins, startPluginRuntimeSync } from './plugins/plugins.svelte'
import { alertError, alertRequiredSelect, waitAlert } from './alert'
import { language } from 'src/lang'
import * as languageRuntime from 'src/lang'
import { updateHeightMode } from './gui/heightMode'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  peekAppliedServerResourceRevision,
  peekCachedServerCommandRevision,
  patchRuntimeSettings,
  subscribeServerCommandLocalEffectApplied,
  withDirectServerCommandEventReconciliation,
} from './server/commands'
import { getActiveWriterSessionId, resetWriterAccessLostForTests } from './server/activeWriterSession'
import { adoptReplacementDatabaseOwnership } from './server/replacementDatabaseOwnership'
import {
  backgroundReady,
  getStartupCoordinatorSnapshot,
  getStartupReadinessSnapshot,
  recordStartupMilestone,
  resetStartupReadinessForTests,
} from './startupReadiness'

import {
  applyCollectionsResource,
  applyCharacterResource,
  applySettingsResource,
  applySettingsGroupResource,
  captureChatBodyProjectionEpoch,
  captureCollectionProjectionEpoch,
  captureLorebookPageProjectionEpoch,
  captureCharacterLorebookProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  captureSettingsGroupProjectionEpoch,
  captureSettingsProjectionEpoch,
  collectionsResourceState,
  hasCollectionProjectionEpochChanged,
  hasLorebookPageProjectionEpochChanged,
  hasSettingsGroupProjectionEpochChanged,
  isSettingsGroupAcknowledgementTainted,
  markCollectionAcknowledgementTainted,
  markCharacterLorebookProjectionApplied,
  markChatBodyProjectionApplied,
  markSettingsAcknowledgementTainted,
  markSettingsGroupAcknowledgementTainted,
  replaceResourceDatabase,
  resetServerResourceState,
  settingsResourceState,
} from './server/resourceState.svelte'
import { captureDestructiveRefreshEpoch, createDestructiveRefreshToken } from './server/staleStateGuards'
import { selectedCharID } from './stores.svelte'
import { currentRoute } from './router'
import { updateReducedMotion } from './gui/animation'
import { updateColorScheme, updateTextThemeAndCSS } from './gui/colorscheme'
import { updateGuisize } from './gui/guisize'
import { __observerShellFlagTestHooks } from './observerShellFlag'
import { observerShellLifecycleStore, resetObserverShellLifecycleForTests } from './observerShellLifecycle.svelte'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

function runtimeBootstrap(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    bootstrap: {
      initialized: true,
      revision: 4,
      databaseLineage: 'database-a',
      requestedWriterWasActive: true,
      writerEpoch: 1,
      writer: { sessionId: getActiveWriterSessionId(), epoch: 1 },
      activeGenerationJobs: [{ chatId: 'chat-a', jobId: 'job-a' }],
      generationFinalizations: [
        {
          generationId: 'generation-a',
          chatId: 'chat-a',
          messageId: 'generation-a',
          mode: 'send',
          state: 'queued',
          failureCount: 1,
        },
      ],
      activeMessageTranslations: [{ chatId: 'chat-a', messageId: 'message-a' }],
      activeGreetingTranslations: [
        {
          characterId: 'char-a',
          chatId: 'chat-a',
          greetingIndex: -1,
          settingsHash: 'settings-a',
          jobId: 'greeting-job-a',
        },
      ],
      ...overrides,
    },
  }
}

function seedResourceDatabase() {
  replaceResourceDatabase(
    {
      characters: [
        {
          type: 'character',
          chaId: 'char-a',
          name: 'Ada',
          chatPage: 0,
          chats: [{ id: 'chat-a', message: [] }],
        },
        {
          type: 'character',
          chaId: 'char-b',
          name: 'Bea',
          chatPage: 0,
          chats: [{ id: 'chat-b', message: [] }],
        },
      ],
      characterOrder: ['char-a', 'char-b'],
      currentChar: 1,
      modules: [],
      loadouts: [
        {
          id: 'loadout-a',
          name: 'Loadout A',
          lastUsed: 100,
          favorite: false,
          characterIds: ['char-a'],
          modules: [],
          globalVariables: {},
          presetName: '',
          modelPresetId: '',
          modelPresetName: '',
          promptPresetId: '',
          promptPresetName: '',
          personaId: '',
        },
      ],
      personas: [],
      botPresets: [],
      language: 'en',
      lastLoadedLoadoutName: 'Before',
    } as never,
    5,
  )
}

beforeEach(() => {
  stopConnectedClientServices()
  resetWriterAccessLostForTests()
  __observerShellFlagTestHooks.setOverride(false)
  resetObserverShellLifecycleForTests()
  resetStartupReadinessForTests()
  recordStartupMilestone('entry', 0)
  recordStartupMilestone('shell-mounted', 1)
  stopDeferredStartupRuntimes()
  stopServerResourceEvents()
  resetServerResourceState()
  seedResourceDatabase()
  selectedCharID.set(-1)
  currentRoute.set({ kind: 'home', path: '/' })
  clearCachedServerCommandRevision()
  clearAppliedServerResourceRevision()

  vi.clearAllMocks()
  readerApi.start.mockImplementation(() => {
    setClientConnectionState('live')
    return { stop: readerApi.stop, retry: readerApi.retry, ready: Promise.resolve() }
  })
  recoveredGenerationApi.discardPendingRecoveredGenerationEffects.mockReset().mockResolvedValue(undefined)
  recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects.mockReset().mockResolvedValue(undefined)
  recoveredGenerationApi.setPendingRecoveredGenerationEffects.mockReset()
  activeWriterApi.adoptPendingOwner.mockClear()
  optionalRuntimeApi.installStoreEffects.mockReturnValue(optionalRuntimeApi.disposeStoreEffects)
  optionalRuntimeApi.startObserver.mockReturnValue(optionalRuntimeApi.stopObserver)
  ownershipApi.count.mockClear()
  ownershipApi.discard.mockReset()
  ownershipApi.reset.mockReset()
  projectionLifecycleApi.discard.mockReset().mockResolvedValue(undefined)
  eventApi.subscriptions = []
  hydrationApi.readinessRefreshHook = null
  ownerMutationLifecycleApi.start.mockReturnValue(ownerMutationLifecycleApi.stop)
  pendingMutationApi.flushAcknowledgements.mockReset()
  pendingMutationApi.flushAcknowledgements.mockResolvedValue(undefined)
  pendingMutationApi.count.mockReset()
  pendingMutationApi.count.mockResolvedValue(0)
  pendingMutationApi.prepare.mockReset()
  pendingMutationApi.prepare.mockImplementation(async (input) => {
    const scope = `${input.writerSessionId}\u0000${input.writerEpoch}\u0000${input.databaseLineage}`
    if (pendingMutationApi.scope !== null && pendingMutationApi.scope !== scope) input.onOwnershipChange?.()
    pendingMutationApi.scope = scope
    return { discarded: 0 }
  })
  pendingMutationApi.scope = null
  pendingMutationApi.readOwner.mockReset()
  pendingMutationApi.readOwner.mockResolvedValue(null)
  pendingMutationApi.replay.mockResolvedValue({ attempted: 0, discarded: 0, retained: 0, succeeded: 0 })
  promptTemplateApi.ensure.mockReset().mockResolvedValue(true)
  promptTemplateApi.hasOwnerEpochChanged.mockReset()
  promptTemplateApi.hasOwnerEpochChanged.mockReturnValue(false)
  promptTemplateApi.isHydrated.mockReset()
  promptTemplateApi.isHydrated.mockReturnValue(true)
  promptTemplateApi.isTainted.mockReset()
  promptTemplateApi.isTainted.mockReturnValue(false)
  promptTemplateApi.markProjectionApplied.mockReset()
  promptTemplateApi.peekOwnerRevision.mockReset()
  promptTemplateApi.peekOwnerRevision.mockReturnValue(5)
  bootstrapApi.fetch.mockResolvedValue(runtimeBootstrap())
  bootstrapApi.fetchReadOnly.mockResolvedValue(runtimeBootstrap({ revision: 5 }))
  resourceApi.loadInitial.mockResolvedValue({ status: 'ok', revision: 5, scope: 'full' })
  resourceApi.readAll.mockResolvedValue({ status: 'ok', revision: 5, scope: 'full' })
  routeResourceApi.ensure.mockReset().mockResolvedValue(undefined)
  resourceApi.refreshInvalidated.mockImplementation(async (events: TestCommandEvent | TestCommandEvent[]) => {
    const batch = Array.isArray(events) ? events : [events]
    return { status: 'ok', revision: batch.at(-1)?.revision ?? 5, scope: 'targeted' }
  })
  resourceApi.forceRefresh.mockResolvedValue({ status: 'ok', revision: 9 })
  resourceApi.forceReplacement.mockResolvedValue({ status: 'ok', revision: 9 })
  commandApi.initialize.mockResolvedValue({ status: 'ok', revision: 1, initialized: true })
  eventApi.subscribe.mockImplementation(async (input) => {
    eventApi.subscriptions.push(input)
    return { status: 'ok', unsubscribe: eventApi.unsubscribe }
  })
})

afterEach(() => {
  stopConnectedClientServices()
  __observerShellFlagTestHooks.setOverride(null)
  resetObserverShellLifecycleForTests()
  stopDeferredStartupRuntimes()
  stopServerResourceEvents()
  resetStartupReadinessForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('API-backed client bootstrap', () => {
  it('fails closed when the globally selected prompt owner is duplicated', () => {
    getDatabase().promptPresets = [
      { id: 'prompt-a', name: 'Prompt A' },
      { id: 'prompt-a', name: 'Duplicate Prompt A' },
    ] as never
    getDatabase().promptPresetsId = 0

    expect(currentGlobalPromptTemplateOwnerId()).toBeNull()
  })

  it.each([false, true])(
    'holds first shell capability for selected locale readiness (observer=%s)',
    async (observer) => {
      __observerShellFlagTestHooks.setOverride(observer)
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
    },
  )

  it('retries locale loading in a resumed projection step without rehydrating the shell', async () => {
    const failure = new Error('locale chunk unavailable')
    vi.spyOn(languageRuntime, 'awaitLanguageReady').mockRejectedValueOnce(failure)
    const selection = vi.spyOn(languageRuntime, 'changeLanguage')
    await loadData()
    expect(alertError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(resourceApi.loadInitial).toHaveBeenCalledOnce()
    expect(selection).toHaveBeenCalledTimes(2)
    expect(selection).toHaveBeenNthCalledWith(1, 'en')
    expect(selection).toHaveBeenNthCalledWith(2, 'en')
    expect(backgroundReady()).toBe(true)
  })

  it('keeps the conservative writer-first boundary when the observer flag is disabled', async () => {
    await loadData()

    expect(bootstrapApi.fetchReadOnly).not.toHaveBeenCalled()
    expect(resourceApi.loadInitial).toHaveBeenCalledOnce()
    expect(resourceApi.loadInitial).toHaveBeenCalledWith({ hooks: resourceApi.hooks })
    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      observerShellEnabled: false,
      capabilities: {
        canRenderShell: true,
        canApplyRoutes: true,
        canMutate: true,
      },
    })
  })

  it('starts a permanent reader without writer recovery, plugins, effects, or canonical selection', async () => {
    __observerShellFlagTestHooks.setOverride(true)
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
    await expect(retryObserverWriterPromotion()).resolves.toBe(false)
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
  })

  it('keeps commands blocked until the owning session finishes recovery, coherent hydration, and subscription', async () => {
    __observerShellFlagTestHooks.setOverride(true)
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

  it('parks retained pending intent and opens a reader projection when writer recovery cannot finish', async () => {
    __observerShellFlagTestHooks.setOverride(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    pendingMutationApi.replay.mockResolvedValue({ attempted: 1, discarded: 0, retained: 1, succeeded: 0 })
    await loadData()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    expect(getStartupCoordinatorSnapshot().capabilities.canMutate).toBe(false)
    expect(readerApi.start).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(resourceApi.loadInitial).toHaveBeenCalledOnce()
    expect(resourceApi.readAll).toHaveBeenCalledOnce()
    expect(loadPlugins).not.toHaveBeenCalled()
  })

  it('passively becomes a reader after a foreign writer frame and never asks for the legacy offline choice', async () => {
    __observerShellFlagTestHooks.setOverride(true)
    await loadData()
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: 'new-writer', epoch: 2 } }),
    )
    eventApi.subscriptions[0]!.onWriterEvent!({ sessionId: 'new-writer', epoch: 2 })
    expect(getStartupCoordinatorSnapshot().capabilities.canMutate).toBe(false)
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledOnce())
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      writer: { sessionId: 'new-writer', epoch: 2 },
    })
    expect(eventApi.unsubscribe).toHaveBeenCalledOnce()
    expect(alertRequiredSelect).not.toHaveBeenCalled()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
  })

  it('retries a failed demotion read without acquiring, replaying, or claiming a live connection', async () => {
    __observerShellFlagTestHooks.setOverride(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadData()
    bootstrapApi.fetchReadOnly
      .mockResolvedValueOnce({ status: 'error', error: 'temporary network failure' })
      .mockResolvedValue(runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: 'new-writer', epoch: 2 } }))
    eventApi.subscriptions[0]!.onWriterEvent!({ sessionId: 'new-writer', epoch: 2 })
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('interrupted'))
    expect(readerApi.start).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledOnce(), { timeout: 3000 })
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live' })
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
  })

  it('revokes writer dispatch on the browser offline signal and revalidates ownership when online', async () => {
    __observerShellFlagTestHooks.setOverride(true)
    await loadData()
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'recovering-writer', connection: 'interrupted' })
    expect(getStartupCoordinatorSnapshot().capabilities.canMutate).toBe(false)
    expect(eventApi.unsubscribe).toHaveBeenCalledOnce()
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(eventApi.subscriptions).toHaveLength(2))
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    expect(bootstrapApi.fetch).toHaveBeenLastCalledWith(null, {
      expectedWriter: { epoch: 1, databaseLineage: 'database-a' },
    })
    expect(readerApi.start).not.toHaveBeenCalled()
  })

  it('retries a replacement reader read in the new lineage without adopting writer or pending scope', async () => {
    __observerShellFlagTestHooks.setOverride(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    await loadData()
    const callbacks = readerApi.start.mock.calls[0]![0]
    const replacement = { databaseLineage: 'database-b', writer: { sessionId: 'replacement-writer', epoch: 0 } }
    projectionLifecycleApi.discard.mockImplementationOnce(async () => {
      clearCachedServerCommandRevision()
      clearAppliedServerResourceRevision()
    })
    bootstrapApi.fetchReadOnly
      .mockResolvedValueOnce({ status: 'error', error: 'temporary replacement read failure' })
      .mockResolvedValue(runtimeBootstrap({ ...replacement, writerEpoch: 0, revision: 1 }))
    resourceApi.readAll.mockResolvedValue({ status: 'ok', revision: 1, scope: 'full' })
    await callbacks.onLineageChange(replacement)
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      databaseLineage: 'database-b',
      connection: 'interrupted',
    })
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      databaseLineage: 'database-b',
      projectionReady: true,
      connection: 'live',
    })
    expect(peekAppliedServerResourceRevision()).toBe(1)
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(pendingMutationApi.replay).not.toHaveBeenCalled()
    expect(pendingMutationApi.flushAcknowledgements).not.toHaveBeenCalled()
    expect(projectionLifecycleApi.discard).toHaveBeenCalledExactlyOnceWith('lineage-change')
  })

  it.each(['plugin', 'generation', 'chat'] as const)(
    'ignores old %s startup completion after a newer writer recovery finishes',
    async (heldStep) => {
      __observerShellFlagTestHooks.setOverride(true)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const step =
        heldStep === 'plugin'
          ? vi.mocked(loadPlugins)
          : heldStep === 'generation'
            ? recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects
            : hydrationApi.hydrateActiveChat
      if (heldStep === 'chat')
        hydrationApi.hydrateActiveChat.mockImplementationOnce(async () => {
          await held
          return true
        })
      else
        step.mockImplementationOnce(async () => {
          await held
        })
      const oldStartup = loadData()
      await vi.waitFor(() => expect(step).toHaveBeenCalledOnce())
      eventApi.subscriptions[0]!.onClose!()
      await vi.waitFor(() => expect(eventApi.subscriptions).toHaveLength(2), { timeout: 3000 })
      await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
      const currentGeneration = getClientSessionSnapshot().generation
      release()
      await oldStartup
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', generation: currentGeneration })
      expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: true, canGenerate: true })
      expect(readerApi.start).not.toHaveBeenCalled()
      expect(backgroundReady()).toBe(true)
    },
  )

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
          failureMilestone: 'observer-ready',
        },
        { attemptId: 2, completedAtMs: expect.any(Number) },
      ],
    })
  })

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
        'writer-owner-adoption',
        'writer-bootstrap',
        'writer-initialize',
        'writer-outbox-prepare',
        'writer-receipt-flush',
        'writer-pending-replay',
        'writer-resource-hydration',
        'writer-projection-install',
        'writer-runtime-services',
        'writer-event-subscription',
        'writer-shell',
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

    withTestDatabaseWrite(() => {
      getDatabase().characters[1].chatPage = 0
    })
    hydrationApi.readinessRefreshHook?.()
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))

    releaseOlderChat(false)
    await Promise.resolve()
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

  it('preserves the owner, takeover, outbox, receipt, replay, projection, and event order', async () => {
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
    expect(get(observerShellLifecycleStore).mode).toBe('takeover-denied')
  })

  it('stops before hydration when transient failures leave encrypted changes queued', async () => {
    pendingMutationApi.replay.mockResolvedValue({ attempted: 1, discarded: 0, retained: 1, succeeded: 0 })
    pendingMutationApi.count.mockResolvedValue(1)

    await expect(loadWebInitialDatabase()).rejects.toThrow('pending changes')

    expect(resourceApi.loadInitial).not.toHaveBeenCalled()
  })

  it('hydrates with a retained Stop control so its retry UI can remain available', async () => {
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

  it('initializes a fresh server without refetching unchanged runtime metadata', async () => {
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

  it('shows a fatal damaged-database alert and does not retry an initialize conflict', async () => {
    bootstrapApi.fetch.mockResolvedValue(runtimeBootstrap({ initialized: false, revision: 0 }))
    commandApi.initialize.mockResolvedValue({
      status: 'error',
      error: 'initialize_conflict',
      reason: 'initialize-conflict',
    })

    await loadData()

    expect(commandApi.initialize).toHaveBeenCalledTimes(1)
    expect(bootstrapApi.fetch).toHaveBeenCalledTimes(1)
    expect(bootstrapApi.fetchReadOnly).not.toHaveBeenCalled()
    expect(resourceApi.loadInitial).not.toHaveBeenCalled()
    expect(backgroundReady()).toBe(false)
    expect(alertError).toHaveBeenCalledTimes(1)
    expect(alertError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('database appears damaged') }),
    )
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

  it('refreshes the targeted API resources for a contiguous command event', async () => {
    await loadWebInitialDatabase()
    const event = { type: 'persona.updated', revision: 6, resource: 'persona', id: 'persona-a' }
    eventApi.subscriptions[0].onCommandEvent(event)

    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(1))
    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(6))
  })

  it.each(['state.restored', 'state.imported'])(
    'reconciles replacement ownership before applying a cross-tab %s event',
    async (type) => {
      await loadWebInitialDatabase()
      const event = { type, revision: 6, resource: 'state' }
      const order: string[] = []
      bootstrapApi.fetchReadOnly.mockReset()
      bootstrapApi.fetchReadOnly.mockImplementationOnce(async () => {
        order.push('bootstrap')
        return runtimeBootstrap({ revision: 3, databaseLineage: 'database-restored', writerEpoch: 2 })
      })
      pendingMutationApi.prepare.mockReset()
      pendingMutationApi.prepare.mockImplementationOnce(async (input) => {
        order.push('prepare')
        input.onOwnershipChange?.()
        pendingMutationApi.scope = `${input.writerSessionId}\u0000${input.writerEpoch}\u0000${input.databaseLineage}`
        return { discarded: 2 }
      })
      ownershipApi.reset.mockImplementationOnce(() => {
        order.push('reset')
      })
      resourceApi.forceReplacement.mockImplementationOnce(async () => {
        order.push('refresh')
        return { status: 'ok', revision: 3 }
      })
      let finishProjectionDiscard!: () => void
      const projectionDiscard = new Promise<void>((resolve) => {
        finishProjectionDiscard = resolve
      })
      projectionLifecycleApi.discard.mockImplementationOnce(async () => {
        order.push('discard')
        await projectionDiscard
      })

      eventApi.subscriptions[0].onCommandEvent({ ...event, revision: 3 })

      try {
        await vi.waitFor(() => expect(projectionLifecycleApi.discard).toHaveBeenCalledExactlyOnceWith('lineage-change'))
        expect(order).toEqual(['bootstrap', 'prepare', 'reset', 'discard'])
        expect(resourceApi.forceReplacement).not.toHaveBeenCalled()
      } finally {
        finishProjectionDiscard()
      }
      await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledOnce())
      expect(order).toEqual(['bootstrap', 'prepare', 'reset', 'discard', 'refresh'])
      expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledWith(null, { cacheRevision: false })
      expect(pendingMutationApi.prepare).toHaveBeenCalledWith({
        writerSessionId: getActiveWriterSessionId(),
        writerEpoch: 2,
        databaseLineage: 'database-restored',
        requestedWriterWasActive: true,
        onOwnershipChange: expect.any(Function),
      })
      expect(resourceApi.forceReplacement).toHaveBeenCalledWith('database-replacement-event', {
        resource: 'state',
      })
      expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
      expect(ownershipApi.discard).toHaveBeenCalledOnce()
      expect(alertError).toHaveBeenCalledOnce()
    },
  )

  it('retries a failed replacement snapshot when the state event is replayed', async () => {
    await loadWebInitialDatabase()
    const event = { type: 'state.restored', revision: 3, resource: 'state' }
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ revision: 3, databaseLineage: 'database-retry', writerEpoch: 2 }),
    )
    resourceApi.forceReplacement
      .mockResolvedValueOnce({ status: 'error', error: 'settings failed' })
      .mockResolvedValueOnce({ status: 'ok', revision: 3 })

    eventApi.subscriptions[0].onCommandEvent(event)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(1))

    eventApi.subscriptions[0].onCommandEvent(event)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(2))

    expect(ownershipApi.reset).toHaveBeenCalledOnce()
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(1, 'database-replacement-event', {
      resource: 'state',
    })
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(2, 'database-replacement-event', {
      resource: 'state',
    })
  })

  it('retries a failed replacement snapshot after a normal reconnect without another event', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    await loadWebInitialDatabase()
    const event = { type: 'state.restored', revision: 3, resource: 'state' }
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ revision: 3, databaseLineage: 'database-reconnect-retry', writerEpoch: 2 }),
    )
    resourceApi.forceReplacement
      .mockResolvedValueOnce({ status: 'error', error: 'settings failed' })
      .mockResolvedValueOnce({ status: 'ok', revision: 3 })

    eventApi.subscriptions[0].onCommandEvent(event)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(2))

    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(1, 'database-replacement-event', {
      resource: 'state',
    })
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(2, 'database-replacement-reconnect')
    expect(ownershipApi.reset).toHaveBeenCalledOnce()
  })

  it('retries a failed replay-unavailable replacement snapshot after a normal reconnect', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    eventApi.subscribe
      .mockResolvedValueOnce({ status: 'replay-unavailable', currentRevision: 3 })
      .mockImplementationOnce(async (input) => {
        eventApi.subscriptions.push(input)
        return { status: 'ok', unsubscribe: eventApi.unsubscribe }
      })
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ revision: 3, databaseLineage: 'database-replay-retry', writerEpoch: 2 }),
    )
    resourceApi.forceReplacement
      .mockResolvedValueOnce({ status: 'error', error: 'settings failed' })
      .mockResolvedValueOnce({ status: 'ok', revision: 3 })

    await loadWebInitialDatabase()
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(2))

    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(1, 'event-replay-unavailable')
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(2, 'database-replacement-reconnect')
    expect(ownershipApi.reset).toHaveBeenCalledOnce()
  })

  it('refreshes again after an older targeted read drains behind a successful local restore', async () => {
    await loadWebInitialDatabase()
    const order: string[] = []
    let finishOldRead!: () => void
    const oldReadFinished = new Promise<void>((resolve) => {
      finishOldRead = resolve
    })
    resourceApi.refreshInvalidated.mockImplementationOnce(async () => {
      order.push('old-read-started')
      await oldReadFinished
      order.push('old-read-applied')
      return { status: 'ok', revision: 6, scope: 'targeted' }
    })
    resourceApi.forceReplacement.mockImplementation(async (reason) => {
      order.push(reason)
      return { status: 'ok', revision: 3 }
    })
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ revision: 3, databaseLineage: 'database-local-restore', writerEpoch: 2 }),
    )

    eventApi.subscriptions[0].onCommandEvent({
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    })
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledOnce())

    await adoptReplacementDatabaseOwnership({ databaseLineage: 'database-local-restore', writerEpoch: 2 })
    await resourceApi.forceReplacement('backup-restore')
    eventApi.subscriptions[0].onCommandEvent({ type: 'state.restored', revision: 3, resource: 'state' })
    finishOldRead()

    await vi.waitFor(() =>
      expect(resourceApi.forceReplacement).toHaveBeenCalledWith('database-replacement-event', {
        resource: 'state',
      }),
    )
    expect(order).toEqual(['old-read-started', 'backup-restore', 'old-read-applied', 'database-replacement-event'])
  })

  it('preserves a newer character selection while a targeted resource invalidation is pending', async () => {
    await loadWebInitialDatabase()
    selectedCharID.set(0)
    const event = { type: 'settings.updated', revision: 6, resource: 'settings', id: 'display' }
    let finishRead!: () => void
    const readFinished = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    resourceApi.refreshInvalidated.mockImplementationOnce(async () => {
      await readFinished
      return { status: 'ok', revision: event.revision, scope: 'targeted' }
    })

    const reconciliation = commandApi.reconciler?.(event, [event], new Map())
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(1))
    selectedCharID.set(1)
    finishRead()
    await reconciliation

    expect(getDatabase().characters[get(selectedCharID)]?.chaId).toBe('char-b')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('deduplicates an own direct event before, during, and after response resource reconciliation', async () => {
    await loadWebInitialDatabase()
    const event = {
      type: 'character.created',
      revision: 6,
      resource: 'character',
      id: 'char-imported',
      origin: { writerSessionId: getActiveWriterSessionId() },
    }
    let startRead!: () => void
    const readStarted = new Promise<void>((resolve) => {
      startRead = resolve
    })
    let finishRead!: () => void
    const readFinished = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    let characterReadCount = 0
    resourceApi.refreshInvalidated.mockImplementation(async (_events, options) => {
      if (event.revision <= (options?.appliedRevision ?? -1)) {
        return { status: 'ok', revision: options?.appliedRevision ?? event.revision, scope: 'none' }
      }
      characterReadCount += 1
      startRead()
      await readFinished
      return { status: 'ok', revision: event.revision, scope: 'targeted' }
    })

    await withDirectServerCommandEventReconciliation(
      (candidate) => candidate.type === 'character.created' && candidate.resource === 'character',
      async (reconcileResponseEvent) => {
        eventApi.subscriptions[0].onCommandEvent(event)
        const applyingResponse = reconcileResponseEvent(event)
        await readStarted
        eventApi.subscriptions[0].onCommandEvent(event)
        finishRead()
        await applyingResponse
      },
    )

    expect(characterReadCount).toBe(1)
    expect(peekAppliedServerResourceRevision()).toBe(6)

    eventApi.subscriptions[0].onCommandEvent(event)
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(2))
    expect(characterReadCount).toBe(1)
  })

  it('applies contiguous generation-settings command effects without a resource read and preserves a newer edit', async () => {
    await loadWebInitialDatabase()
    const attemptedA = {
      configured: true,
      jailbreakToggle: false,
      sidebarToggles: { mode: '0', stale: '1' },
    }
    const canonicalA = {
      configured: true,
      jailbreakToggle: false,
      sidebarToggles: { mode: '0' },
    }
    const attemptedB = {
      configured: true,
      jailbreakToggle: true,
      sidebarToggles: { mode: '1', stale: '1' },
    }
    const canonicalB = {
      configured: true,
      jailbreakToggle: true,
      sidebarToggles: { mode: '1' },
    }
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats[0].generationSettings = attemptedB
    })

    const eventA = {
      type: 'chat.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }
    await commandApi.reconciler?.(
      eventA,
      [eventA],
      new Map([
        [
          6,
          {
            kind: 'chatGenerationSettings',
            chatId: 'chat-a',
            characterId: 'char-a',
            attemptedGenerationSettings: attemptedA,
            generationSettings: canonicalA,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(attemptedB)
    expect(peekAppliedServerResourceRevision()).toBe(6)

    const eventB = { ...eventA, revision: 7 }
    await commandApi.reconciler?.(
      eventB,
      [eventB],
      new Map([
        [
          7,
          {
            kind: 'chatGenerationSettings',
            chatId: 'chat-a',
            characterId: 'char-a',
            attemptedGenerationSettings: attemptedB,
            generationSettings: canonicalB,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].chats[0].generationSettings).toEqual(canonicalB)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('acknowledges a contiguous settings patch without re-reading its group', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().theme = 'LIGHT'
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('display')
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'display',
            attemptedPatch: { theme: 'LIGHT' },
            settings: { theme: 'light' },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().theme).toBe('light')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('falls back when an authoritative settings apply supersedes an optimistic intent', async () => {
    await loadWebInitialDatabase()
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('display')
    withTestDatabaseWrite(() => {
      getDatabase().theme = 'optimistic'
    })
    applySettingsGroupResource(
      {
        revision: 5,
        group: 'display',
        settings: { theme: 'authoritative-before-command' },
      },
      ['theme'],
    )
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'display',
            attemptedPatch: { theme: 'optimistic' },
            settings: { theme: 'canonical' },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(getDatabase().theme).toBe('authoritative-before-command')
  })

  it('falls back when a models read supersedes an optimistic provider-owned model profile intent', async () => {
    await loadWebInitialDatabase()
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('providers')
    withTestDatabaseWrite(() => {
      getDatabase().modelProfiles = [{ id: 'profile-optimistic', name: 'Optimistic Profile' }] as never
    })
    applySettingsGroupResource(
      {
        revision: 5,
        group: 'models',
        settings: {
          modelProfiles: [{ id: 'profile-authoritative', name: 'Authoritative Profile' }],
        },
      },
      ['modelProfiles'],
    )
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'providers',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'providers',
            attemptedPatch: {
              modelProfiles: [{ id: 'profile-optimistic', name: 'Optimistic Profile' }],
            },
            settings: {
              modelProfiles: [{ id: 'profile-optimistic', name: 'Optimistic Profile' }],
            },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(getDatabase().modelProfiles).toEqual([{ id: 'profile-authoritative', name: 'Authoritative Profile' }])
  })

  it('authoritatively reconciles an accepted settings patch without an optimistic effect', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().theme = 'old-local-value'
    })
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    }
    resourceApi.refreshInvalidated.mockImplementationOnce(async () => {
      applySettingsGroupResource(
        {
          revision: 6,
          group: 'display',
          settings: { theme: 'light' },
        },
        ['theme'],
      )
      return { status: 'ok', revision: 6, scope: 'targeted' }
    })

    await commandApi.reconciler?.(event, [event], new Map())

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(getDatabase().theme).toBe('light')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges an exact prompt settings patch only against its unchanged untainted projection', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().mainPrompt = 'optimistic'
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('prompt')
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'prompt',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'prompt',
            attemptedPatch: { mainPrompt: 'optimistic' },
            settings: { mainPrompt: 'canonical' },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().mainPrompt).toBe('canonical')
    expect(hasSettingsGroupProjectionEpochChanged('prompt', settingsProjectionEpoch)).toBe(false)
    expect(isSettingsGroupAcknowledgementTainted('prompt')).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it.each([
    ['wrong event type', { type: 'prompt.settings.updated' }],
    ['wrong event resource', { resource: 'prompt' }],
    ['wrong event group', { id: 'runtime' }],
    ['parent-scoped event', { parentId: 'unexpected' }],
  ])('falls back when a prompt settings acknowledgement has a %s', async (_label, eventOverride) => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().mainPrompt = 'optimistic'
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('prompt')
    const event = {
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'prompt',
      ...eventOverride,
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'settingsPatch',
            group: 'prompt',
            attemptedPatch: { mainPrompt: 'optimistic' },
            settings: { mainPrompt: 'canonical' },
            settingsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it.each(['missing epoch', 'changed epoch', 'tainted projection'])(
    '%s forces a prompt settings group fallback',
    async (failure) => {
      await loadWebInitialDatabase()
      const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('prompt')
      if (failure === 'changed epoch') {
        applySettingsGroupResource(
          {
            revision: 5,
            group: 'prompt',
            settings: { mainPrompt: 'authoritative' },
          },
          ['mainPrompt'],
        )
      } else if (failure === 'tainted projection') {
        markSettingsGroupAcknowledgementTainted('prompt')
      }
      withTestDatabaseWrite(() => {
        getDatabase().mainPrompt = 'optimistic'
      })
      const event = {
        type: 'settings.updated',
        revision: 6,
        resource: 'settings',
        id: 'prompt',
      }
      const localEffect = {
        kind: 'settingsPatch',
        group: 'prompt',
        attemptedPatch: { mainPrompt: 'optimistic' },
        settings: { mainPrompt: 'canonical' },
        ...(failure === 'missing epoch' ? {} : { settingsProjectionEpoch }),
      }

      await commandApi.reconciler?.(event, [event], new Map([[6, localEffect]]))

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
    },
  )

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

  it('acknowledges contiguous legacy/model preset reorders without collection or settings reads', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          botPresets: [
            { id: 'preset-a', name: 'Newer A' },
            { id: 'preset-b', name: 'Newer B' },
          ] as never,
        },
      },
      'botPresets',
    )
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          modelPresets: [
            { id: 'model-a', name: 'Newer A' },
            { id: 'model-b', name: 'Newer B' },
            { id: 'model-c', name: 'Newer C' },
          ] as never,
        },
      },
      'modelPresets',
    )
    applySettingsResource({ revision: 5, settings: { botPresetsId: 0, modelPresetsId: 0 } })
    const legacyCollectionEpoch = captureCollectionProjectionEpoch('botPresets')
    const modelCollectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    withTestDatabaseWrite(() => {
      getDatabase().botPresets = [getDatabase().botPresets[1], getDatabase().botPresets[0]]
      getDatabase().botPresetsId = 1
      getDatabase().modelPresets = [
        getDatabase().modelPresets[0],
        getDatabase().modelPresets[2],
        getDatabase().modelPresets[1],
      ]
      getDatabase().modelPresetsId = 0
    })
    const legacyEvent = {
      type: 'preset.reordered',
      revision: 6,
      resource: 'presetCollectionWithPointer',
    }
    const modelEvent = { type: 'modelPreset.reordered', revision: 7, resource: 'modelPreset' }

    await commandApi.reconciler?.(
      modelEvent,
      [legacyEvent, modelEvent],
      new Map([
        [
          6,
          {
            kind: 'presetReorder',
            presetKind: 'legacy',
            collectionProjectionEpoch: legacyCollectionEpoch,
            settingsProjectionEpoch,
            presetIds: ['preset-b', 'preset-a'],
            selectedPresetId: 'preset-a',
            settingsWritten: true,
          },
        ],
        [
          7,
          {
            kind: 'presetReorder',
            presetKind: 'model',
            collectionProjectionEpoch: modelCollectionEpoch,
            settingsProjectionEpoch,
            presetIds: ['model-a', 'model-c', 'model-b'],
            selectedPresetId: 'model-a',
            settingsWritten: false,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b', 'preset-a'])
    expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-a', 'model-c', 'model-b'])
    expect(collectionsResourceState.revisions.botPresets).toBe(6)
    expect(collectionsResourceState.revisions.modelPresets).toBe(7)
    expect(settingsResourceState.fullRevision).toBe(6)
    expect(hasCollectionProjectionEpochChanged('botPresets', legacyCollectionEpoch)).toBe(false)
    expect(hasCollectionProjectionEpochChanged('modelPresets', modelCollectionEpoch)).toBe(false)
    expect(captureSettingsProjectionEpoch()).toBe(settingsProjectionEpoch)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('ignores unrelated full-settings staleness for a collection-only model preset reorder', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          modelPresets: [
            { id: 'model-a', name: 'A' },
            { id: 'model-b', name: 'B' },
            { id: 'model-c', name: 'C' },
          ] as never,
        },
      },
      'modelPresets',
    )
    applySettingsResource({ revision: 5, settings: { modelPresetsId: 1 } })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    const staleSettingsProjectionEpoch = captureSettingsProjectionEpoch()
    applySettingsResource({ revision: 5, settings: { modelPresetsId: 1 } })
    markSettingsAcknowledgementTainted()
    withTestDatabaseWrite(() => {
      getDatabase().modelPresets = [
        getDatabase().modelPresets[2],
        getDatabase().modelPresets[1],
        getDatabase().modelPresets[0],
      ]
    })
    const event = { type: 'modelPreset.reordered', revision: 6, resource: 'modelPreset' }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'presetReorder',
            presetKind: 'model',
            collectionProjectionEpoch,
            settingsProjectionEpoch: staleSettingsProjectionEpoch,
            presetIds: ['model-c', 'model-b', 'model-a'],
            selectedPresetId: 'model-b',
            settingsWritten: false,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(collectionsResourceState.revisions.modelPresets).toBe(6)
    expect(settingsResourceState.fullRevision).toBe(5)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it.each([
    'collection epoch',
    'collection taint',
    'settings epoch',
    'settings taint',
    'selection mismatch',
    'noncanonical pointer',
    'event resource',
  ])('falls back to authoritative reconciliation for a preset reorder with a stale %s proof', async (failure) => {
    await loadWebInitialDatabase()
    const presets = [
      { id: 'preset-b', name: 'B' },
      { id: 'preset-a', name: 'A' },
    ]
    applyCollectionsResource({ revision: 5, collections: { botPresets: presets as never } }, 'botPresets')
    applySettingsResource({ revision: 5, settings: { botPresetsId: 1 } })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    let selectedPresetId: string | null = 'preset-a'
    let resource = 'presetCollectionWithPointer'
    if (failure === 'collection epoch') {
      applyCollectionsResource({ revision: 5, collections: { botPresets: presets as never } }, 'botPresets')
    } else if (failure === 'collection taint') {
      markCollectionAcknowledgementTainted('botPresets')
    } else if (failure === 'settings epoch') {
      applySettingsResource({ revision: 5, settings: { botPresetsId: 1 } })
    } else if (failure === 'settings taint') {
      markSettingsAcknowledgementTainted()
    } else if (failure === 'selection mismatch') {
      withTestDatabaseWrite(() => {
        getDatabase().botPresetsId = 0
      })
    } else if (failure === 'noncanonical pointer') {
      selectedPresetId = null
      withTestDatabaseWrite(() => {
        getDatabase().botPresetsId = -1
      })
    } else {
      resource = 'presetCollection'
    }
    const event = { type: 'preset.reordered', revision: 6, resource }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'presetReorder',
            presetKind: 'legacy',
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            presetIds: ['preset-b', 'preset-a'],
            selectedPresetId,
            settingsWritten: true,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges a contiguous selected model preset PATCH field-wise without collection or settings reads', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          modelPresets: [{ id: 'model-a', name: 'Model A', temperature: 0.4 }] as never,
          promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }] as never,
        },
      },
      'modelPresets',
    )
    applyCollectionsResource(
      { revision: 5, collections: { promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }] as never } },
      'promptPresets',
    )
    withTestDatabaseWrite(() => {
      getDatabase().modelPresetsId = 0
      getDatabase().promptPresetsId = 0
      getDatabase().modelPresets[0].temperature = 0.6
      getDatabase().temperature = 0.6
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const event = {
      type: 'modelPreset.updated',
      revision: 6,
      resource: 'modelPreset',
      id: 'model-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'splitPresetPatch',
            presetKind: 'model',
            presetId: 'model-a',
            attemptedPatch: { temperature: 0.6 },
            preset: { temperature: 0.5 },
            attemptedSettings: { temperature: 0.6 },
            settings: { temperature: 0.5 },
            selectedProjectionApplied: true,
            ownerProjectionApplied: false,
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            selectedPresetId: 'model-a',
            selectedPromptPresetId: 'prompt-a',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().modelPresets[0].temperature).toBe(0.5)
    expect(getDatabase().temperature).toBe(0.5)
    expect(collectionsResourceState.revisions.modelPresets).toBe(6)
    expect(hasCollectionProjectionEpochChanged('modelPresets', collectionProjectionEpoch)).toBe(false)
    expect(captureSettingsProjectionEpoch()).toBe(settingsProjectionEpoch)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges a contiguous legacy preset PATCH field-wise without re-reading the row', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          botPresets: [
            {
              id: 'preset-a',
              name: 'Optimistic',
              temperature: 0.6,
              agentPresetDefaultId: 'missing-agent',
            },
          ] as never,
        },
      },
      'botPresets',
    )
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    withTestDatabaseWrite(() => {
      getDatabase().botPresets[0].name = 'Newer local edit'
    })
    const event = {
      type: 'preset.updated',
      revision: 6,
      resource: 'presetRow',
      id: 'preset-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'legacyPresetPatch',
            presetId: 'preset-a',
            collectionProjectionEpoch,
            fields: {
              name: {
                attempted: { present: true, value: 'Optimistic' },
                canonical: { present: true, value: 'Canonical' },
              },
              temperature: {
                attempted: { present: true, value: 0.6 },
                canonical: { present: true, value: 0.5 },
              },
              agentPresetDefaultId: {
                attempted: { present: true, value: 'missing-agent' },
                canonical: { present: false },
              },
            },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().botPresets[0]).toMatchObject({
      id: 'preset-a',
      name: 'Newer local edit',
      temperature: 0.5,
    })
    expect(getDatabase().botPresets[0].agentPresetDefaultId).toBeUndefined()
    expect(collectionsResourceState.revisions.botPresets).toBe(6)
    expect(hasCollectionProjectionEpochChanged('botPresets', collectionProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it.each(['changed epoch', 'tainted projection'])('%s forces a legacy preset PATCH fallback', async (failure) => {
    await loadWebInitialDatabase()
    const preset = { id: 'preset-a', name: 'Optimistic' }
    applyCollectionsResource({ revision: 5, collections: { botPresets: [preset] as never } }, 'botPresets')
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    if (failure === 'changed epoch') {
      applyCollectionsResource({ revision: 5, collections: { botPresets: [preset] as never } }, 'botPresets')
    } else {
      markCollectionAcknowledgementTainted('botPresets')
    }
    const event = {
      type: 'preset.updated',
      revision: 6,
      resource: 'presetRow',
      id: 'preset-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'legacyPresetPatch',
            presetId: 'preset-a',
            collectionProjectionEpoch,
            fields: {
              name: {
                attempted: { present: true, value: 'Optimistic' },
                canonical: { present: true, value: 'Canonical' },
              },
            },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges a contiguous persona PATCH without a collection/settings read or apply-epoch bump', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          personas: [
            {
              id: 'persona-a',
              name: 'Attempted name',
              icon: 'attempted-icon',
              personaPrompt: 'Attempted prompt',
              note: 'Attempted note',
            },
          ] as never,
        },
      },
      'personas',
    )
    withTestDatabaseWrite(() => {
      getDatabase().selectedPersona = 0
      getDatabase().selectedPersonaId = 'persona-a'
      getDatabase().username = 'Attempted name'
      getDatabase().userIcon = 'attempted-icon'
      getDatabase().personaPrompt = 'Attempted prompt'
      getDatabase().userNote = 'Attempted note'
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    withTestDatabaseWrite(() => {
      getDatabase().personas[0].name = 'Newer local name'
      getDatabase().username = 'Newer local name'
    })
    const event = {
      type: 'persona.updated',
      revision: 6,
      resource: 'persona',
      id: 'persona-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'personaPatch',
            personaId: 'persona-a',
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            attemptedPatch: { personaPrompt: 'Attempted prompt', note: 'Attempted note' },
            attemptedPersona: {
              id: 'persona-a',
              name: 'Attempted name',
              icon: 'attempted-icon',
              personaPrompt: 'Attempted prompt',
              note: 'Attempted note',
            },
            attemptedLegacyProfile: {
              username: 'Attempted name',
              userIcon: 'attempted-icon',
              personaPrompt: 'Attempted prompt',
              userNote: 'Attempted note',
            },
            legacyProfileProjectionApplied: true,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().personas[0].name).toBe('Newer local name')
    expect(getDatabase().username).toBe('Newer local name')
    expect(collectionsResourceState.revisions.personas).toBe(6)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('coalesces an accepted persona PATCH followed by deletion without a resource read', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          personas: [{ id: 'persona-b', name: 'B', icon: '', personaPrompt: 'B', note: '' }] as never,
        },
      },
      'personas',
    )
    withTestDatabaseWrite(() => {
      getDatabase().selectedPersona = 0
      getDatabase().selectedPersonaId = 'persona-b'
      getDatabase().username = 'B'
      getDatabase().userIcon = ''
      getDatabase().personaPrompt = 'B'
      getDatabase().userNote = ''
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const patchEvent = {
      type: 'persona.updated',
      revision: 6,
      resource: 'persona',
      id: 'persona-a',
    }
    const deleteEvent = {
      type: 'persona.deleted',
      revision: 7,
      resource: 'persona',
      id: 'persona-a',
    }

    await commandApi.reconciler?.(
      deleteEvent,
      [patchEvent, deleteEvent],
      new Map([
        [
          6,
          {
            kind: 'personaPatch',
            personaId: 'persona-a',
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            attemptedPatch: { name: 'Edited A' },
            attemptedPersona: {
              id: 'persona-a',
              name: 'Edited A',
              icon: '',
              personaPrompt: 'A',
              note: '',
            },
            attemptedLegacyProfile: {
              username: 'Edited A',
              userIcon: '',
              personaPrompt: 'A',
              userNote: '',
            },
            legacyProfileProjectionApplied: true,
          },
        ],
        [
          7,
          {
            kind: 'personaMutation',
            operation: 'delete',
            targetPersonaId: 'persona-a',
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            collectionWritten: true,
            settingsWritten: true,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().personas).toEqual([expect.objectContaining({ id: 'persona-b', name: 'B' })])
    expect(getDatabase().username).toBe('B')
    expect(collectionsResourceState.revisions.personas).toBe(7)
    expect(settingsResourceState.fullRevision).toBe(7)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it.each(['collection epoch', 'settings epoch', 'collection taint', 'settings taint'])(
    '%s forces a persona PATCH authoritative fallback',
    async (failure) => {
      await loadWebInitialDatabase()
      const persona = {
        id: 'persona-a',
        name: 'Attempted',
        icon: '',
        personaPrompt: '',
        note: '',
      }
      applyCollectionsResource({ revision: 5, collections: { personas: [persona] as never } }, 'personas')
      withTestDatabaseWrite(() => {
        getDatabase().selectedPersona = 0
        getDatabase().selectedPersonaId = 'persona-a'
        getDatabase().username = 'Attempted'
        getDatabase().userIcon = ''
        getDatabase().personaPrompt = ''
        getDatabase().userNote = ''
      })
      const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
      const settingsProjectionEpoch = captureSettingsProjectionEpoch()
      if (failure === 'collection epoch') {
        applyCollectionsResource({ revision: 5, collections: { personas: [persona] as never } }, 'personas')
      } else if (failure === 'settings epoch') {
        applySettingsResource({ revision: 5, settings: { username: 'Attempted' } })
      } else if (failure === 'collection taint') {
        markCollectionAcknowledgementTainted('personas')
      } else {
        markSettingsAcknowledgementTainted()
      }
      const event = {
        type: 'persona.updated',
        revision: 6,
        resource: 'persona',
        id: 'persona-a',
      }

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'personaPatch',
              personaId: 'persona-a',
              collectionProjectionEpoch,
              settingsProjectionEpoch,
              attemptedPatch: { name: 'Attempted' },
              attemptedPersona: persona,
              attemptedLegacyProfile: {
                username: 'Attempted',
                userIcon: '',
                personaPrompt: '',
                userNote: '',
              },
              legacyProfileProjectionApplied: true,
            },
          ],
        ]),
      )

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
    },
  )

  it.each([
    ['create', 'persona.created', 'persona-b', true, true],
    ['delete', 'persona.deleted', 'persona-a', true, true],
    ['select', 'persona.selected', 'persona-b', false, true],
    ['reorder', 'persona.reordered', undefined, true, true],
  ] as const)(
    'acknowledges a contiguous persona %s without collection/settings reads',
    async (operation, eventType, targetPersonaId, collectionWritten, settingsWritten) => {
      await loadWebInitialDatabase()
      applyCollectionsResource(
        {
          revision: 5,
          collections: {
            personas: [
              { id: 'persona-a', name: 'Newer A', icon: '', personaPrompt: 'A', note: '' },
              { id: 'persona-b', name: 'Newer B', icon: '', personaPrompt: 'B', note: '' },
            ] as never,
          },
        },
        'personas',
      )
      withTestDatabaseWrite(() => {
        getDatabase().selectedPersona = 1
        getDatabase().selectedPersonaId = 'persona-b'
        getDatabase().username = 'Newer B'
        getDatabase().userIcon = ''
        getDatabase().personaPrompt = 'Newer B prompt'
        getDatabase().userNote = 'Newer B note'
      })
      const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
      const settingsProjectionEpoch = captureSettingsProjectionEpoch()
      const event = {
        type: eventType,
        revision: 6,
        resource: 'persona',
        ...(targetPersonaId ? { id: targetPersonaId } : {}),
      }

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'personaMutation',
              operation,
              targetPersonaId: targetPersonaId ?? null,
              collectionProjectionEpoch,
              settingsProjectionEpoch,
              collectionWritten,
              settingsWritten,
            },
          ],
        ]),
      )

      expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
      expect(collectionsResourceState.revisions.personas).toBe(collectionWritten ? 6 : 5)
      expect(settingsResourceState.fullRevision).toBe(settingsWritten ? 6 : 5)
      expect(getDatabase().personas).toEqual([
        expect.objectContaining({ id: 'persona-a', name: 'Newer A' }),
        expect.objectContaining({ id: 'persona-b', name: 'Newer B' }),
      ])
      expect(getDatabase().username).toBe('Newer B')
      expect(peekAppliedServerResourceRevision()).toBe(6)
    },
  )

  it.each(['collection epoch', 'settings epoch', 'collection taint', 'settings taint', 'event identity'])(
    '%s forces a structural persona acknowledgement fallback',
    async (failure) => {
      await loadWebInitialDatabase()
      const personas = [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'A', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'B', note: '' },
      ]
      applyCollectionsResource({ revision: 5, collections: { personas: personas as never } }, 'personas')
      withTestDatabaseWrite(() => {
        getDatabase().selectedPersona = 1
        getDatabase().selectedPersonaId = 'persona-b'
        getDatabase().username = 'B'
        getDatabase().userIcon = ''
        getDatabase().personaPrompt = 'B'
        getDatabase().userNote = ''
      })
      const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
      const settingsProjectionEpoch = captureSettingsProjectionEpoch()
      if (failure === 'collection epoch') {
        applyCollectionsResource({ revision: 5, collections: { personas: personas as never } }, 'personas')
      } else if (failure === 'settings epoch') {
        applySettingsResource({
          revision: 5,
          settings: {
            selectedPersona: 1,
            selectedPersonaId: 'persona-b',
            username: 'B',
            userIcon: '',
            personaPrompt: 'B',
            userNote: '',
          },
        })
      } else if (failure === 'collection taint') {
        markCollectionAcknowledgementTainted('personas')
      } else if (failure === 'settings taint') {
        markSettingsAcknowledgementTainted()
      }
      const event = {
        type: 'persona.selected',
        revision: 6,
        resource: failure === 'event identity' ? 'settings' : 'persona',
        id: 'persona-b',
      }

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'personaMutation',
              operation: 'select',
              targetPersonaId: 'persona-b',
              collectionProjectionEpoch,
              settingsProjectionEpoch,
              collectionWritten: false,
              settingsWritten: true,
            },
          ],
        ]),
      )

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
    },
  )

  it('acknowledges Agent Preset fields locally and notifies settlement only after the effect applies', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets = [
        {
          id: 'ap_a',
          name: '  Attempted Name  ',
          description: null as never,
          enabled: true,
          version: 1,
          steps: [],
        },
      ]
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('agents')
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets[0].name = 'newer local name'
    })
    const event = {
      type: 'agentPreset.updated',
      revision: 6,
      resource: 'agentPreset',
      id: 'ap_a',
    }
    const appliedEffects: unknown[] = []
    const unsubscribe = subscribeServerCommandLocalEffectApplied((_event, localEffect) => {
      appliedEffects.push(localEffect)
    })
    const localEffect = {
      kind: 'agentPresetPatch' as const,
      presetId: 'ap_a',
      settingsProjectionEpoch,
      fields: {
        name: {
          attempted: { present: true as const, value: '  Attempted Name  ' },
          canonical: { present: true as const, value: 'Attempted Name' },
        },
        description: {
          attempted: { present: true as const, value: null },
          canonical: { present: false as const },
        },
      },
      updatedAt: 600,
    }

    await commandApi.reconciler?.(event, [event], new Map([[6, localEffect]]))
    unsubscribe()

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().agentPresets[0]).toMatchObject({ name: 'newer local name', updatedAt: 600 })
    expect(getDatabase().agentPresets[0]).not.toHaveProperty('description')
    expect(settingsResourceState.groupRevisions.agents).toBe(6)
    expect(hasSettingsGroupProjectionEpochChanged('agents', settingsProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(6)
    expect(appliedEffects).toEqual([localEffect])
  })

  it.each(['agents epoch', 'agents taint', 'global settings taint', 'agents unready'])(
    '%s forces an Agent Preset PATCH authoritative fallback without settling its local effect',
    async (failure) => {
      await loadWebInitialDatabase()
      withTestDatabaseWrite(() => {
        getDatabase().agentPresets = [{ id: 'ap_a', name: 'Attempted', enabled: true, version: 1, steps: [] }]
      })
      const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('agents')
      if (failure === 'agents epoch') {
        applySettingsGroupResource(
          {
            revision: 5,
            group: 'agents',
            settings: {
              agentPresets: [{ id: 'ap_a', name: 'Attempted', enabled: true, version: 1, steps: [] }],
            },
          },
          ['agents', 'agentPresets', 'agentPresetDefaultId'],
        )
      } else if (failure === 'agents taint') {
        markSettingsGroupAcknowledgementTainted('agents')
      } else if (failure === 'global settings taint') {
        markSettingsAcknowledgementTainted()
      } else {
        settingsResourceState.status = 'idle'
      }
      const event = {
        type: 'agentPreset.updated',
        revision: 6,
        resource: 'agentPreset',
        id: 'ap_a',
      }
      const appliedEffects: unknown[] = []
      const unsubscribe = subscribeServerCommandLocalEffectApplied((_event, localEffect) => {
        appliedEffects.push(localEffect)
      })

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'agentPresetPatch',
              presetId: 'ap_a',
              settingsProjectionEpoch,
              fields: {
                name: {
                  attempted: { present: true, value: 'Attempted' },
                  canonical: { present: true, value: 'Attempted' },
                },
              },
              updatedAt: 600,
            },
          ],
        ]),
      )
      unsubscribe()

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
      expect(appliedEffects).toEqual([])
    },
  )

  it('fences contiguous optimistic Agent Preset reorder/default writes without an agents read', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets = [
        { id: 'ap_a', name: 'Preset A', enabled: true, version: 1, steps: [] },
        { id: 'ap_b', name: 'Preset B', enabled: true, version: 1, steps: [] },
      ]
      getDatabase().agentPresetDefaultId = 'ap_a'
    })
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('agents')
    withTestDatabaseWrite(() => {
      getDatabase().agentPresets = [getDatabase().agentPresets[1], getDatabase().agentPresets[0]]
    })
    const reorderEvent = {
      type: 'agentPreset.reordered',
      revision: 6,
      resource: 'agentPreset',
    }
    const reorderEffect = {
      kind: 'agentPresetCollectionMutation' as const,
      operation: 'reorder' as const,
      settingsProjectionEpoch,
      presetIds: ['ap_b', 'ap_a'],
      agentPresetDefaultId: 'ap_a',
    }

    await commandApi.reconciler?.(reorderEvent, [reorderEvent], new Map([[6, reorderEffect]]))

    withTestDatabaseWrite(() => {
      getDatabase().agentPresetDefaultId = 'ap_b'
    })
    const defaultEvent = {
      type: 'agentPreset.default.updated',
      revision: 7,
      resource: 'agentPreset',
      id: 'ap_b',
    }
    const defaultEffect = {
      kind: 'agentPresetCollectionMutation' as const,
      operation: 'default' as const,
      settingsProjectionEpoch,
      presetIds: ['ap_b', 'ap_a'],
      agentPresetDefaultId: 'ap_b',
    }

    await commandApi.reconciler?.(defaultEvent, [defaultEvent], new Map([[7, defaultEffect]]))

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().agentPresets.map((preset) => preset.id)).toEqual(['ap_b', 'ap_a'])
    expect(getDatabase().agentPresetDefaultId).toBe('ap_b')
    expect(settingsResourceState.groupRevisions.agents).toBe(7)
    expect(hasSettingsGroupProjectionEpochChanged('agents', settingsProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it.each(['agents epoch', 'agents taint', 'live identities'])(
    '%s forces Agent Preset reorder acknowledgement through authoritative reconciliation',
    async (failure) => {
      await loadWebInitialDatabase()
      withTestDatabaseWrite(() => {
        getDatabase().agentPresets = [
          { id: 'ap_b', name: 'Preset B', enabled: true, version: 1, steps: [] },
          { id: 'ap_a', name: 'Preset A', enabled: true, version: 1, steps: [] },
        ]
        getDatabase().agentPresetDefaultId = 'ap_a'
      })
      const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('agents')
      if (failure === 'agents epoch') {
        applySettingsGroupResource(
          {
            revision: 5,
            group: 'agents',
            settings: {
              agentPresets: [
                { id: 'ap_b', name: 'Preset B', enabled: true, version: 1, steps: [] },
                { id: 'ap_a', name: 'Preset A', enabled: true, version: 1, steps: [] },
              ],
              agentPresetDefaultId: 'ap_a',
            },
          },
          ['agents', 'agentPresets', 'agentPresetDefaultId'],
        )
      } else if (failure === 'agents taint') {
        markSettingsGroupAcknowledgementTainted('agents')
      } else {
        withTestDatabaseWrite(() => {
          getDatabase().agentPresets = [getDatabase().agentPresets[1], getDatabase().agentPresets[0]]
        })
      }
      const event = {
        type: 'agentPreset.reordered',
        revision: 6,
        resource: 'agentPreset',
      }

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'agentPresetCollectionMutation',
              operation: 'reorder',
              settingsProjectionEpoch,
              presetIds: ['ap_b', 'ap_a'],
              agentPresetDefaultId: 'ap_a',
            },
          ],
        ]),
      )

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
    },
  )

  it('acknowledges a contiguous translator preset PATCH without collection/language reads or apply-epoch bumps', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          translatorPresets: [
            { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
            { id: 'translator-b', name: 'B', prompt: 'attempted prompt', maxResponse: 200 },
          ] as never,
        },
      },
      'translatorPresets',
    )
    withTestDatabaseWrite(() => {
      getDatabase().translatorPresetId = 'translator-a'
      getDatabase().translatorPrompt = 'a prompt'
      getDatabase().translatorMaxResponse = 100
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('translatorPresets')
    const languageSettingsProjectionEpoch = captureSettingsGroupProjectionEpoch('language')
    withTestDatabaseWrite(() => {
      getDatabase().translatorPresets[1].prompt = 'newer local prompt'
    })
    const event = {
      type: 'translatorPreset.updated',
      revision: 6,
      resource: 'translatorPreset',
      id: 'translator-b',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'translatorPresetPatch',
            presetId: 'translator-b',
            collectionProjectionEpoch,
            languageSettingsProjectionEpoch,
            selectedPresetId: 'translator-a',
            attemptedPatch: { prompt: 'attempted prompt' },
            attemptedPreset: {
              id: 'translator-b',
              name: 'B',
              prompt: 'attempted prompt',
              maxResponse: 200,
            },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().translatorPresets[1].prompt).toBe('newer local prompt')
    expect(collectionsResourceState.revisions.translatorPresets).toBe(6)
    expect(settingsResourceState.groupRevisions.language).toBe(6)
    expect(hasCollectionProjectionEpochChanged('translatorPresets', collectionProjectionEpoch)).toBe(false)
    expect(hasSettingsGroupProjectionEpochChanged('language', languageSettingsProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it.each([
    'collection epoch',
    'language epoch',
    'collection taint',
    'language taint',
    'global settings taint',
    'selection mismatch',
    'collection unready',
    'language unready',
  ])('%s forces a translator preset PATCH authoritative fallback', async (failure) => {
    await loadWebInitialDatabase()
    const presets = [
      { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
      { id: 'translator-b', name: 'B', prompt: 'attempted prompt', maxResponse: 200 },
    ]
    applyCollectionsResource({ revision: 5, collections: { translatorPresets: presets as never } }, 'translatorPresets')
    withTestDatabaseWrite(() => {
      getDatabase().translatorPresetId = 'translator-a'
      getDatabase().translatorPrompt = 'a prompt'
      getDatabase().translatorMaxResponse = 100
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('translatorPresets')
    const languageSettingsProjectionEpoch = captureSettingsGroupProjectionEpoch('language')
    if (failure === 'collection epoch') {
      applyCollectionsResource(
        { revision: 5, collections: { translatorPresets: presets as never } },
        'translatorPresets',
      )
    } else if (failure === 'language epoch') {
      applySettingsGroupResource(
        {
          revision: 5,
          group: 'language',
          settings: {
            translatorPresetId: 'translator-a',
            translatorPrompt: 'a prompt',
            translatorMaxResponse: 100,
          },
        },
        ['translatorPresetId', 'translatorPrompt', 'translatorMaxResponse'],
      )
    } else if (failure === 'collection taint') {
      markCollectionAcknowledgementTainted('translatorPresets')
    } else if (failure === 'language taint') {
      markSettingsGroupAcknowledgementTainted('language')
    } else if (failure === 'global settings taint') {
      markSettingsAcknowledgementTainted()
    } else if (failure === 'selection mismatch') {
      withTestDatabaseWrite(() => {
        getDatabase().translatorPresetId = 'translator-b'
        getDatabase().translatorPrompt = 'attempted prompt'
        getDatabase().translatorMaxResponse = 200
      })
    } else if (failure === 'collection unready') {
      collectionsResourceState.statuses.translatorPresets = 'idle'
    } else {
      settingsResourceState.status = 'idle'
    }
    const event = {
      type: 'translatorPreset.updated',
      revision: 6,
      resource: 'translatorPreset',
      id: 'translator-b',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'translatorPresetPatch',
            presetId: 'translator-b',
            collectionProjectionEpoch,
            languageSettingsProjectionEpoch,
            selectedPresetId: 'translator-a',
            attemptedPatch: { prompt: 'attempted prompt' },
            attemptedPreset: presets[1],
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges metadata-only prompt preset PATCHes without owner hydration or settings reads', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      { revision: 5, collections: { promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }] as never } },
      'promptPresets',
    )
    withTestDatabaseWrite(() => {
      getDatabase().promptPresetsId = 0
      getDatabase().promptPresets[0].name = 'Prompt renamed'
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const event = {
      type: 'promptPreset.updated',
      revision: 6,
      resource: 'promptPreset',
      id: 'prompt-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'splitPresetPatch',
            presetKind: 'prompt',
            presetId: 'prompt-a',
            attemptedPatch: { name: 'Prompt renamed' },
            preset: { name: 'Prompt renamed' },
            attemptedSettings: {},
            settings: {},
            selectedProjectionApplied: false,
            ownerProjectionApplied: false,
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            selectedPresetId: 'prompt-a',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(promptTemplateApi.isHydrated).not.toHaveBeenCalled()
    expect(promptTemplateApi.markProjectionApplied).not.toHaveBeenCalled()
    expect(getDatabase().promptPresets[0].name).toBe('Prompt renamed')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('canonicalizes the prompt owner without rewriting its compatibility projection', async () => {
    await loadWebInitialDatabase()
    const attemptedTemplate = [{ type: 'plain', text: 'Optimistic' }]
    const canonicalTemplate = [{ id: 'item-a', type: 'plain', text: 'Optimistic' }]
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          promptPresets: [{ id: 'prompt-a', name: 'Prompt A', promptTemplate: attemptedTemplate }] as never,
        },
      },
      'promptPresets',
    )
    applyCollectionsResource(
      { revision: 5, collections: { promptTemplate: attemptedTemplate as never } },
      'promptTemplate',
    )
    withTestDatabaseWrite(() => {
      getDatabase().promptPresetsId = 0
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    const event = {
      type: 'promptPreset.updated',
      revision: 6,
      resource: 'promptPreset',
      id: 'prompt-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'splitPresetPatch',
            presetKind: 'prompt',
            presetId: 'prompt-a',
            attemptedPatch: { promptTemplate: attemptedTemplate },
            preset: { promptTemplate: canonicalTemplate },
            attemptedSettings: {},
            settings: {},
            selectedProjectionApplied: false,
            ownerProjectionApplied: true,
            collectionProjectionEpoch,
            settingsProjectionEpoch: captureSettingsProjectionEpoch(),
            selectedPresetId: 'prompt-a',
            promptOwnerProjectionEpoch: 19,
            promptOwnerRevision: 5,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().promptPresets[0].promptTemplate).toEqual(canonicalTemplate)
    expect(getDatabase().promptTemplate).toEqual(attemptedTemplate)
    expect(promptTemplateApi.markProjectionApplied).toHaveBeenCalledWith('prompt-a', 6, {
      advanceProjectionEpoch: false,
    })
  })

  it('falls back when a split-preset PATCH collection proof is tainted', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      { revision: 5, collections: { modelPresets: [{ id: 'model-a', name: 'Model A' }] as never } },
      'modelPresets',
    )
    withTestDatabaseWrite(() => {
      getDatabase().modelPresetsId = 0
      getDatabase().modelPresets[0].name = 'Model renamed'
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    markCollectionAcknowledgementTainted('modelPresets')
    const event = {
      type: 'modelPreset.updated',
      revision: 6,
      resource: 'modelPreset',
      id: 'model-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'splitPresetPatch',
            presetKind: 'model',
            presetId: 'model-a',
            attemptedPatch: { name: 'Model renamed' },
            preset: { name: 'Model renamed' },
            attemptedSettings: {},
            settings: {},
            selectedProjectionApplied: false,
            ownerProjectionApplied: false,
            collectionProjectionEpoch,
            settingsProjectionEpoch: captureSettingsProjectionEpoch(),
            selectedPresetId: 'model-a',
            selectedPromptPresetId: null,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges a contiguous exact preset-owned prompt item without fetching its owner', async () => {
    await loadWebInitialDatabase()
    const ownerItems = [{ id: 'prompt-item-a', type: 'plain', text: 'optimistic' }]
    withTestDatabaseWrite(() => {
      getDatabase().promptPresets = [{ id: 'prompt-preset-a', name: 'A', promptTemplate: ownerItems }] as never
      getDatabase().promptTemplate = ownerItems as never
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    const event = {
      type: 'prompt.item.created',
      revision: 6,
      resource: 'promptItem',
      id: 'prompt-item-a',
      parentId: 'prompt-preset-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'promptItemMutation',
            operation: 'create',
            promptPresetId: 'prompt-preset-a',
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 19,
            ownerState: { enabled: true, items: ownerItems },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().promptPresets[0].promptTemplate).toEqual(ownerItems)
    expect(collectionsResourceState.revisions.promptPresets).toBe(6)
    expect(hasCollectionProjectionEpochChanged('promptPresets', collectionProjectionEpoch)).toBe(false)
    expect(promptTemplateApi.markProjectionApplied).toHaveBeenCalledWith('prompt-preset-a', 6, {
      advanceProjectionEpoch: false,
    })
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges overlapping accepted prompt updates against the final live row without fetching', async () => {
    await loadWebInitialDatabase()
    const firstOwnerItems = [{ id: 'prompt-item-a', type: 'plain', text: 'first accepted edit', role: 'system' }]
    const finalOwnerItems = [{ ...firstOwnerItems[0], role: 'user' }]
    withTestDatabaseWrite(() => {
      getDatabase().promptPresets = [{ id: 'prompt-preset-a', name: 'A', promptTemplate: finalOwnerItems }] as never
      getDatabase().promptTemplate = finalOwnerItems as never
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    const firstEvent = {
      type: 'prompt.item.updated',
      revision: 6,
      resource: 'promptItem',
      id: 'prompt-item-a',
      parentId: 'prompt-preset-a',
    }
    const secondEvent = { ...firstEvent, revision: 7 }

    await commandApi.reconciler?.(
      secondEvent,
      [firstEvent, secondEvent],
      new Map([
        [
          6,
          {
            kind: 'promptItemMutation',
            operation: 'update',
            promptPresetId: 'prompt-preset-a',
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 19,
            ownerState: { enabled: true, items: firstOwnerItems },
          },
        ],
        [
          7,
          {
            kind: 'promptItemMutation',
            operation: 'update',
            promptPresetId: 'prompt-preset-a',
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 19,
            ownerState: { enabled: true, items: finalOwnerItems },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().promptPresets[0].promptTemplate).toEqual(finalOwnerItems)
    expect(collectionsResourceState.revisions.promptPresets).toBe(7)
    expect(promptTemplateApi.markProjectionApplied).toHaveBeenNthCalledWith(1, 'prompt-preset-a', 6, {
      advanceProjectionEpoch: false,
    })
    expect(promptTemplateApi.markProjectionApplied).toHaveBeenNthCalledWith(2, 'prompt-preset-a', 7, {
      advanceProjectionEpoch: false,
    })
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it.each([
    'collection epoch',
    'owner epoch',
    'unhydrated owner',
    'tainted owner',
    'missing owner revision',
    'item mismatch',
    'foreign owner',
  ])('falls back for a prompt acknowledgement with an invalid %s', async (failure) => {
    await loadWebInitialDatabase()
    const ownerItems = [{ id: 'prompt-item-a', type: 'plain', text: 'optimistic' }]
    withTestDatabaseWrite(() => {
      getDatabase().promptPresets = [{ id: 'prompt-preset-a', name: 'A', promptTemplate: ownerItems }] as never
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptPresets')
    if (failure === 'collection epoch') {
      applyCollectionsResource(
        {
          revision: 5,
          collections: {
            promptPresets: [{ id: 'prompt-preset-a', name: 'A', promptTemplate: ownerItems }] as never,
          },
        },
        'promptPresets',
      )
    } else if (failure === 'owner epoch') {
      promptTemplateApi.hasOwnerEpochChanged.mockReturnValue(true)
    } else if (failure === 'unhydrated owner') {
      promptTemplateApi.isHydrated.mockReturnValue(false)
    } else if (failure === 'tainted owner') {
      promptTemplateApi.isTainted.mockReturnValue(true)
    } else if (failure === 'missing owner revision') {
      promptTemplateApi.peekOwnerRevision.mockReturnValue(null)
    }
    const event = {
      type: 'prompt.item.updated',
      revision: 6,
      resource: 'promptItem',
      id: failure === 'item mismatch' ? 'wrong-item' : 'prompt-item-a',
      parentId: failure === 'foreign owner' ? 'prompt-preset-b' : 'prompt-preset-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'promptItemMutation',
            operation: 'update',
            promptPresetId: 'prompt-preset-a',
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 19,
            ownerState: { enabled: true, items: ownerItems },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(promptTemplateApi.markProjectionApplied).not.toHaveBeenCalled()
  })

  it('keeps gapped and foreign prompt events on authoritative owner reconciliation', async () => {
    await loadWebInitialDatabase()
    const ownerItems = [{ id: 'prompt-item-a', type: 'plain', text: 'optimistic' }]
    withTestDatabaseWrite(() => {
      getDatabase().promptTemplate = ownerItems as never
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('promptTemplate')
    const gappedEvent = {
      type: 'prompt.item.updated',
      revision: 7,
      resource: 'promptItem',
      id: 'prompt-item-a',
    }

    await commandApi.reconciler?.(
      gappedEvent,
      [gappedEvent],
      new Map([
        [
          7,
          {
            kind: 'promptItemMutation',
            operation: 'update',
            promptPresetId: null,
            itemId: 'prompt-item-a',
            collectionProjectionEpoch,
            ownerProjectionEpoch: 3,
            ownerState: { enabled: true, items: ownerItems },
          },
        ],
      ]),
    )
    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([gappedEvent], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })

    const foreignEvent = { ...gappedEvent, revision: 8 }
    eventApi.subscriptions[0].onCommandEvent(foreignEvent)
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(2))
    expect(resourceApi.refreshInvalidated).toHaveBeenLastCalledWith([foreignEvent], {
      appliedRevision: 7,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges contiguous scoped lorebook mutations without replacing newer optimistic entries', async () => {
    await loadWebInitialDatabase()
    const entry = (id: string, content: string) => ({
      id,
      key: id,
      secondkey: '',
      insertorder: 100,
      comment: id,
      content,
      mode: 'normal' as const,
      alwaysActive: false,
      selective: false,
    })
    withTestDatabaseWrite(() => {
      getDatabase().loreBook = [
        { id: 'book-a', name: 'Book A', data: [entry('global-entry', 'global newer')] },
      ] as never
      getDatabase().characters[0].globalLore = [entry('character-entry', 'character newer')]
      getDatabase().characters[0].chats[0].localLore = [entry('chat-entry', 'chat newer')]
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
    const characterRowProjectionEpoch = captureCharacterRowProjectionEpoch('char-a')
    const characterLorebookProjectionEpoch = captureCharacterLorebookProjectionEpoch('char-a')
    const globalEvent = {
      type: 'lorebook.entries.replaced',
      revision: 6,
      resource: 'globalLorebook',
      id: 'book-a',
    }
    const characterEvent = {
      type: 'lorebook.entries.replaced',
      revision: 7,
      resource: 'characterLorebook',
      id: 'char-a',
    }
    const chatEvent = {
      type: 'lorebook.entries.replaced',
      revision: 8,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      chatEvent,
      [globalEvent, characterEvent, chatEvent],
      new Map([
        [
          6,
          {
            kind: 'lorebookMutation',
            scope: 'global',
            operation: 'upsert',
            lorebookId: 'book-a',
            collectionProjectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'lorebookMutation',
            scope: 'character',
            operation: 'replace',
            characterId: 'char-a',
            characterRowProjectionEpoch,
            characterLorebookProjectionEpoch,
          },
        ],
        [
          8,
          {
            kind: 'lorebookMutation',
            scope: 'chat',
            operation: 'reorder',
            characterId: 'char-a',
            chatId: 'chat-a',
            characterRowProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().loreBook[0].data[0].content).toBe('global newer')
    expect(getDatabase().characters[0].globalLore[0].content).toBe('character newer')
    expect(getDatabase().characters[0].chats[0].localLore[0].content).toBe('chat newer')
    expect(peekAppliedServerResourceRevision()).toBe(8)
  })

  it('acknowledges contiguous top-level lorebook mutations without re-reading collection or settings', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().loreBook = [
        { id: 'book-b', name: 'Newer B', data: [] },
        { id: 'book-c', name: 'Newer C', data: [] },
      ] as never
      getDatabase().loreBookPage = 0
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
    const pageProjectionEpoch = captureLorebookPageProjectionEpoch()
    const events = [
      { type: 'lorebook.created', revision: 6, resource: 'globalLorebook', id: 'book-c' },
      { type: 'lorebook.updated', revision: 7, resource: 'globalLorebook', id: 'book-b' },
      { type: 'lorebook.selected', revision: 8, resource: 'globalLorebook', id: 'book-c' },
      { type: 'lorebook.reordered', revision: 9, resource: 'globalLorebook' },
      { type: 'lorebook.deleted', revision: 10, resource: 'globalLorebook', id: 'book-a' },
    ]

    await commandApi.reconciler?.(
      events.at(-1),
      events,
      new Map([
        [
          6,
          {
            kind: 'globalLorebookMutation',
            operation: 'create',
            lorebookId: 'book-c',
            collectionProjectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'globalLorebookMutation',
            operation: 'update',
            lorebookId: 'book-b',
            collectionProjectionEpoch,
          },
        ],
        [
          8,
          {
            kind: 'globalLorebookMutation',
            operation: 'select',
            lorebookId: 'book-c',
            selectedLorebookId: 'book-c',
            pageProjectionEpoch,
          },
        ],
        [
          9,
          {
            kind: 'globalLorebookMutation',
            operation: 'reorder',
            lorebookIds: ['book-b', 'book-c'],
            selectedLorebookId: 'book-b',
            collectionProjectionEpoch,
            pageProjectionEpoch,
          },
        ],
        [
          10,
          {
            kind: 'globalLorebookMutation',
            operation: 'delete',
            lorebookId: 'book-a',
            collectionProjectionEpoch,
            pageProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().loreBook).toEqual([
      { id: 'book-b', name: 'Newer B', data: [] },
      { id: 'book-c', name: 'Newer C', data: [] },
    ])
    expect(getDatabase().loreBookPage).toBe(0)
    expect(hasCollectionProjectionEpochChanged('loreBook', collectionProjectionEpoch)).toBe(false)
    expect(hasLorebookPageProjectionEpochChanged(pageProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(10)
  })

  it('falls back when an authoritative lorebook collection supersedes a top-level local effect', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().loreBook = [{ id: 'book-a', name: 'Book A', data: [] }] as never
      getDatabase().loreBookPage = 0
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
    applyCollectionsResource(
      {
        revision: 6,
        collections: { loreBook: [{ id: 'book-a', name: 'Projected A', data: [] }] as never },
      },
      'loreBook',
    )
    const event = { type: 'lorebook.updated', revision: 6, resource: 'globalLorebook', id: 'book-a' }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'globalLorebookMutation',
            operation: 'update',
            lorebookId: 'book-a',
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

  it('falls back when authoritative settings supersede a top-level lorebook page effect', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().loreBook = [
        { id: 'book-a', name: 'Book A', data: [] },
        { id: 'book-b', name: 'Book B', data: [] },
      ] as never
      getDatabase().loreBookPage = 1
    })
    const pageProjectionEpoch = captureLorebookPageProjectionEpoch()
    applySettingsResource({ revision: 6, settings: { loreBookPage: 0 } })
    const event = { type: 'lorebook.selected', revision: 6, resource: 'globalLorebook', id: 'book-b' }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'globalLorebookMutation',
            operation: 'select',
            lorebookId: 'book-b',
            selectedLorebookId: 'book-b',
            pageProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('falls back when a dedicated character-lorebook projection supersedes an optimistic effect', async () => {
    await loadWebInitialDatabase()
    const characterRowProjectionEpoch = captureCharacterRowProjectionEpoch('char-a')
    const characterLorebookProjectionEpoch = captureCharacterLorebookProjectionEpoch('char-a')
    markCharacterLorebookProjectionApplied('char-a')
    const event = {
      type: 'lorebook.entries.replaced',
      revision: 6,
      resource: 'characterLorebook',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'lorebookMutation',
            scope: 'character',
            operation: 'upsert',
            characterId: 'char-a',
            characterRowProjectionEpoch,
            characterLorebookProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges contiguous optimistic loadout create and delete without resource reads', async () => {
    await loadWebInitialDatabase()
    const loadoutsProjectionEpoch = captureCollectionProjectionEpoch('loadouts')
    withTestDatabaseWrite(() => {
      getDatabase().loadouts = [
        {
          ...getDatabase().loadouts[0],
          id: 'loadout-b',
          name: 'Created Loadout',
        },
      ]
    })
    const createEvent = {
      type: 'loadout.created',
      revision: 6,
      resource: 'loadout',
      id: 'loadout-b',
    }
    const deleteEvent = {
      type: 'loadout.deleted',
      revision: 7,
      resource: 'loadout',
      id: 'loadout-a',
    }

    await commandApi.reconciler?.(
      deleteEvent,
      [createEvent, deleteEvent],
      new Map([
        [
          6,
          {
            kind: 'loadoutMutation',
            operation: 'create',
            loadoutId: 'loadout-b',
            loadoutsProjectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'loadoutMutation',
            operation: 'delete',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().loadouts).toEqual([expect.objectContaining({ id: 'loadout-b', name: 'Created Loadout' })])
    expect(hasCollectionProjectionEpochChanged('loadouts', loadoutsProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('falls back when the loadout collection epoch changes before a create/delete acknowledgement', async () => {
    await loadWebInitialDatabase()
    const loadoutsProjectionEpoch = captureCollectionProjectionEpoch('loadouts')
    applyCollectionsResource(
      {
        revision: 6,
        collections: {
          loadouts: [
            {
              ...getDatabase().loadouts[0],
              name: 'Authoritative Loadout',
            },
          ],
        },
      },
      'loadouts',
    )
    const event = {
      type: 'loadout.deleted',
      revision: 6,
      resource: 'loadout',
      id: 'loadout-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'loadoutMutation',
            operation: 'delete',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges contiguous optimistic loadout favorite and touch without resource reads', async () => {
    await loadWebInitialDatabase()
    const loadoutsProjectionEpoch = captureCollectionProjectionEpoch('loadouts')
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('sidebar')
    withTestDatabaseWrite(() => {
      const loadout = getDatabase().loadouts[0]
      loadout.favorite = false
      loadout.lastUsed = 300
      loadout.characterIds.push('char-b')
      getDatabase().lastLoadedLoadoutName = 'Newer loaded name'
    })
    const favoriteEvent = {
      type: 'loadout.favorited',
      revision: 6,
      resource: 'loadout',
      id: 'loadout-a',
    }
    const touchEvent = {
      type: 'loadout.touched',
      revision: 7,
      resource: 'loadout',
      id: 'loadout-a',
    }

    await commandApi.reconciler?.(
      touchEvent,
      [favoriteEvent, touchEvent],
      new Map([
        [
          6,
          {
            kind: 'loadoutMutation',
            operation: 'favorite',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'loadoutMutation',
            operation: 'touch',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
            settingsProjectionEpoch,
            loadedName: 'Loadout A',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().loadouts[0]).toMatchObject({
      favorite: false,
      lastUsed: 300,
      characterIds: ['char-a', 'char-b'],
    })
    expect(getDatabase().lastLoadedLoadoutName).toBe('Newer loaded name')
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('falls back when a targeted projection changes before a loadout acknowledgement', async () => {
    await loadWebInitialDatabase()
    const loadoutsProjectionEpoch = captureCollectionProjectionEpoch('loadouts')
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('sidebar')
    applyCollectionsResource(
      {
        revision: 6,
        collections: {
          loadouts: [
            {
              ...getDatabase().loadouts[0],
              favorite: true,
            },
          ],
        },
      },
      'loadouts',
    )
    applySettingsGroupResource(
      { revision: 6, group: 'sidebar', settings: { lastLoadedLoadoutName: 'Authoritative' } },
      ['lastLoadedLoadoutName'],
    )
    const event = {
      type: 'loadout.touched',
      revision: 6,
      resource: 'loadout',
      id: 'loadout-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'loadoutMutation',
            operation: 'touch',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
            settingsProjectionEpoch,
            loadedName: 'Loadout A',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges contiguous optimistic character definitions without reading the row', async () => {
    await loadWebInitialDatabase()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].customscript = [{ id: 'script-newer', out: 'newer' }] as never
      getDatabase().characters[0].triggerscript = [{ id: 'trigger-newer', comment: 'newer' }] as never
    })
    const scriptsEvent = {
      type: 'scriptDefinitions.replaced',
      revision: 6,
      resource: 'characterRow',
      id: 'char-a',
    }
    const triggersEvent = {
      type: 'triggerDefinitions.replaced',
      revision: 7,
      resource: 'characterRow',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      triggersEvent,
      [scriptsEvent, triggersEvent],
      new Map([
        [
          6,
          {
            kind: 'characterDefinitionMutation',
            operation: 'scripts',
            characterId: 'char-a',
            optimisticRowEpoch,
          },
        ],
        [
          7,
          {
            kind: 'characterDefinitionMutation',
            operation: 'triggers',
            characterId: 'char-a',
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].customscript).toEqual([{ id: 'script-newer', out: 'newer' }])
    expect(getDatabase().characters[0].triggerscript).toEqual([{ id: 'trigger-newer', comment: 'newer' }])
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('falls back when a character row changes before a definition acknowledgement', async () => {
    await loadWebInitialDatabase()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    const authoritativeCharacter = JSON.parse(JSON.stringify(getDatabase().characters[0]))
    authoritativeCharacter.customscript = [{ id: 'script-authoritative', out: 'server' }]
    applyCharacterResource({ revision: 6, character: authoritativeCharacter })
    const event = {
      type: 'scriptDefinitions.replaced',
      revision: 6,
      resource: 'characterRow',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterDefinitionMutation',
            operation: 'scripts',
            characterId: 'char-a',
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
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

  it('applies a contiguous canonical message translation without fetching the transcript', async () => {
    await loadWebInitialDatabase()
    const translation = {
      source: 'raw',
      text: 'translated',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const event = {
      type: 'message.updated',
      revision: 6,
      resource: 'message',
      id: 'message-a',
      parentId: 'chat-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'messageTranslation',
            chatId: 'chat-a',
            messageId: 'message-a',
            translation,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(hydrationApi.applyMessageTranslationLocalEffect).toHaveBeenCalledWith('chat-a', 'message-a', translation)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges a contiguous optimistic message append without fetching the transcript', async () => {
    await loadWebInitialDatabase()
    const chatBodyProjectionEpoch = captureChatBodyProjectionEpoch('chat-a')
    const event = {
      type: 'message.appended',
      revision: 6,
      resource: 'message',
      id: 'message-a',
      parentId: 'chat-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'messageMutation',
            operation: 'append',
            chatId: 'chat-a',
            messageId: 'message-a',
            chatBodyProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(hydrationApi.acknowledgeMessageMutationLocalEffect).toHaveBeenCalledWith('chat-a')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('authoritatively rereads a message mutation after a deferred stale chat read replaces its optimism', async () => {
    await loadWebInitialDatabase()
    const chatBodyProjectionEpoch = captureChatBodyProjectionEpoch('chat-a')
    const event = {
      type: 'message.updated',
      revision: 6,
      resource: 'message',
      id: 'message-a',
      parentId: 'chat-a',
    }

    // Model a chat read that began after the optimistic edit and applied its
    // pre-command response before the accepted command is acknowledged.
    markChatBodyProjectionApplied('chat-a')

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'messageMutation',
            operation: 'update',
            chatId: 'chat-a',
            messageId: 'message-a',
            chatBodyProjectionEpoch,
          },
        ],
      ]),
    )

    expect(hydrationApi.acknowledgeMessageMutationLocalEffect).not.toHaveBeenCalled()
    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges contiguous optimistic chat structure mutations without row or transcript reads', async () => {
    await loadWebInitialDatabase()
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats.unshift(
        { id: 'chat-created', message: [{ role: 'user', data: 'created', chatId: 'message-created' }] } as never,
        { id: 'chat-forked', message: [] } as never,
      )
    })
    const effects = [
      {
        event: {
          type: 'chat.created',
          revision: 6,
          resource: 'chatTranscript',
          id: 'chat-created',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'create',
          characterId: 'char-a',
          targetId: 'chat-created',
          optimisticEpoch,
          optimisticRowEpoch,
          attemptedGenerationSettings: null,
          generationSettings: null,
        },
      },
      {
        event: {
          type: 'chat.forked',
          revision: 7,
          resource: 'chatTranscript',
          id: 'chat-forked',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'fork',
          characterId: 'char-a',
          targetId: 'chat-forked',
          optimisticEpoch,
          optimisticRowEpoch,
          attemptedGenerationSettings: null,
          generationSettings: { configured: true, jailbreakToggle: false },
        },
      },
      {
        event: { type: 'chat.reordered', revision: 8, resource: 'characterRow', parentId: 'char-a' },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'reorder',
          characterId: 'char-a',
          attemptedIds: ['chat-forked', 'chat-created', 'chat-a'],
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
      {
        event: {
          type: 'chatFolder.created',
          revision: 9,
          resource: 'characterRow',
          id: 'folder-a',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'folderCreate',
          characterId: 'char-a',
          targetId: 'folder-a',
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
      {
        event: {
          type: 'chatFolder.deleted',
          revision: 10,
          resource: 'characterRow',
          id: 'folder-a',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'folderDelete',
          characterId: 'char-a',
          targetId: 'folder-a',
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
      {
        event: { type: 'chatFolder.reordered', revision: 11, resource: 'characterRow', parentId: 'char-a' },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'folderReorder',
          characterId: 'char-a',
          attemptedIds: [],
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
      {
        event: {
          type: 'chat.deleted',
          revision: 12,
          resource: 'characterRow',
          id: 'chat-deleted',
          parentId: 'char-a',
        },
        effect: {
          kind: 'chatStructureMutation',
          operation: 'delete',
          characterId: 'char-a',
          targetId: 'chat-deleted',
          optimisticEpoch,
          optimisticRowEpoch,
        },
      },
    ] as const

    await commandApi.reconciler?.(
      effects.at(-1)!.event,
      effects.map(({ event }) => event),
      new Map(effects.map(({ event, effect }) => [event.revision, effect])),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(hydrationApi.acknowledgeCreatedChatTranscriptLocalEffect).toHaveBeenCalledTimes(2)
    expect(hydrationApi.acknowledgeCreatedChatTranscriptLocalEffect).toHaveBeenNthCalledWith(1, 'chat-created')
    expect(hydrationApi.acknowledgeCreatedChatTranscriptLocalEffect).toHaveBeenNthCalledWith(2, 'chat-forked')
    expect(hydrationApi.invalidateChatHydration).toHaveBeenCalledWith('chat-deleted')
    expect(getDatabase().characters[0].chats.find((chat) => chat.id === 'chat-forked')?.generationSettings).toEqual({
      configured: true,
      jailbreakToggle: false,
    })
    expect(peekAppliedServerResourceRevision()).toBe(12)
  })

  it('keeps malformed chat structure effects on authoritative reconciliation', async () => {
    await loadWebInitialDatabase()
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    const event = {
      type: 'chat.reordered',
      revision: 6,
      resource: 'characterRow',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'chatStructureMutation',
            operation: 'reorder',
            characterId: 'char-a',
            attemptedIds: ['chat-a', 'chat-a'],
            optimisticEpoch,
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('does not fence a structural effect after a full projection refresh', async () => {
    await loadWebInitialDatabase()
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    createDestructiveRefreshToken('chat-structure-bootstrap-test-refresh')
    const event = {
      type: 'chat.reordered',
      revision: 6,
      resource: 'characterRow',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'chatStructureMutation',
            operation: 'reorder',
            characterId: 'char-a',
            attemptedIds: ['chat-a'],
            optimisticEpoch,
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('rereads an accepted character patch erased by an in-flight full refresh', async () => {
    await loadWebInitialDatabase()
    const destructiveRefreshEpoch = captureDestructiveRefreshEpoch()
    createDestructiveRefreshToken('character-patch-bootstrap-test-refresh')
    const event = {
      type: 'character.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterPatch',
            characterId: 'char-a',
            patch: { name: 'accepted optimistic name' },
            destructiveRefreshEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('does not fence a structural effect after a targeted character refresh', async () => {
    await loadWebInitialDatabase()
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    expect(
      applyCharacterResource({
        revision: 5,
        character: JSON.parse(JSON.stringify(getDatabase().characters[0])),
      }),
    ).toBe(true)
    const event = {
      type: 'chat.reordered',
      revision: 6,
      resource: 'characterRow',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'chatStructureMutation',
            operation: 'reorder',
            characterId: 'char-a',
            attemptedIds: ['chat-a'],
            optimisticEpoch,
            optimisticRowEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges a contiguous character patch without a resource read and preserves a newer edit', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].name = 'Newer queued edit'
    })
    const event = {
      type: 'character.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterPatch',
            characterId: 'char-a',
            patch: { name: 'Accepted edit' },
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].name).toBe('Newer queued edit')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges contiguous optimistic character collection mutations without a collection read', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters.push({ chaId: 'char-c', name: 'Cora', chats: [] } as never)
      getDatabase().characters.push({ chaId: 'char-d', name: 'Dara', chats: [] } as never)
      getDatabase().characters.splice(1, 1)
      getDatabase().characterOrder = ['char-d', 'char-c', 'char-a']
      ;(getDatabase() as unknown as { currentChar: number }).currentChar = 0
    })
    selectedCharID.set(0)
    const created = {
      type: 'character.created',
      revision: 6,
      resource: 'character',
      id: 'char-c',
    }
    const createdAndSelected = {
      type: 'character.createdAndSelected',
      revision: 7,
      resource: 'character',
      id: 'char-d',
    }
    const deleted = {
      type: 'character.deleted',
      revision: 8,
      resource: 'character',
      id: 'char-b',
    }

    await commandApi.reconciler?.(
      deleted,
      [created, createdAndSelected, deleted],
      new Map([
        [
          6,
          {
            kind: 'characterCollectionMutation',
            operation: 'create',
            characterId: 'char-c',
            selectedCharacterId: 'char-b',
          },
        ],
        [
          7,
          {
            kind: 'characterCollectionMutation',
            operation: 'createAndSelect',
            characterId: 'char-d',
            selectedCharacterId: 'char-d',
          },
        ],
        [
          8,
          {
            kind: 'characterCollectionMutation',
            operation: 'delete',
            characterId: 'char-b',
            selectedCharacterId: 'char-d',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters.map((candidate) => candidate.chaId)).toEqual(['char-a', 'char-c', 'char-d'])
    expect(getDatabase().characterOrder).toEqual(['char-d', 'char-c', 'char-a'])
    expect((getDatabase() as unknown as { currentChar: number }).currentChar).toBe(0)
    expect(get(selectedCharID)).toBe(0)
    expect(peekAppliedServerResourceRevision()).toBe(8)
  })

  it('keeps unsafe character collection effects on authoritative reconciliation', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters.push({ chaId: 'char-c', name: 'Cora', chats: [] } as never)
    })
    const event = {
      type: 'character.created',
      revision: 6,
      resource: 'character',
      id: 'char-c',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterCollectionMutation',
            operation: 'create',
            characterId: 'char-c',
            selectedCharacterId: 'char-b',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('keeps foreign character collection events on authoritative reconciliation', async () => {
    await loadWebInitialDatabase()
    const event = {
      type: 'character.created',
      revision: 6,
      resource: 'character',
      id: 'char-foreign',
    }

    await commandApi.reconciler?.(event, [event], new Map())

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('does not apply a character collection effect across a revision gap', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters.push({ chaId: 'char-c', name: 'Cora', chats: [] } as never)
      getDatabase().characterOrder = ['char-a', 'char-b', 'char-c']
    })
    const event = {
      type: 'character.created',
      revision: 7,
      resource: 'character',
      id: 'char-c',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          7,
          {
            kind: 'characterCollectionMutation',
            operation: 'create',
            characterId: 'char-c',
            selectedCharacterId: 'char-b',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('fences contiguous nested character and order writes without resource reads', async () => {
    await loadWebInitialDatabase()
    const rowEvent = {
      type: 'chat.scriptstate.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }
    const orderEvent = {
      type: 'character.reordered',
      revision: 7,
      resource: 'characterOrder',
    }

    await commandApi.reconciler?.(
      orderEvent,
      [rowEvent, orderEvent],
      new Map([
        [
          6,
          {
            kind: 'characterRowMutation',
            operation: 'chatScriptstate',
            characterId: 'char-a',
            targetId: 'chat-a',
          },
        ],
        [7, { kind: 'characterOrder', attemptedOrder: ['char-a', 'char-b'] }],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('acknowledges a contiguous character selection without replacing a newer selection', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].lastInteraction = 200
    })
    const event = {
      type: 'character.selected',
      revision: 6,
      resource: 'characterSelection',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'characterSelection',
            characterId: 'char-a',
            lastInteraction: 100,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect((getDatabase() as unknown as { currentChar: number }).currentChar).toBe(1)
    expect(getDatabase().characters[0].lastInteraction).toBe(200)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('acknowledges a contiguous chat selection without replacing a newer selection', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats.push({ id: 'chat-newer', message: [] } as never)
      getDatabase().characters[0].chatPage = 1
    })
    const event = {
      type: 'chat.updated',
      revision: 6,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'chatPatch',
            characterId: 'char-a',
            chatId: 'chat-a',
            patch: {},
            select: true,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().characters[0].chatPage).toBe(1)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('uses a full resource result revision and invalidates chat hydration after a gap', async () => {
    await loadWebInitialDatabase()
    resourceApi.refreshInvalidated.mockResolvedValueOnce({ status: 'ok', revision: 12, scope: 'full' })
    eventApi.subscriptions[0].onCommandEvent({ type: 'state.changed', revision: 9, resource: 'state' })

    await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(12))
    expect(hydrationApi.resetChatHydration).toHaveBeenCalledTimes(2)
    expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledWith({ force: true })
    expect(hydrationApi.requestReadinessRefresh).toHaveBeenCalledOnce()
    expect(promptTemplateApi.ensure).toHaveBeenLastCalledWith({ force: true, minimumRevision: 12 })
    expect(runtimeApi.triggerOpenChatGenerationReattach).toHaveBeenCalledTimes(1)
  })

  it('invalidates body hydration without advancing the cursor when full-refresh prompt hydration fails', async () => {
    await loadWebInitialDatabase()
    promptTemplateApi.ensure.mockResolvedValueOnce(false)
    resourceApi.refreshInvalidated.mockResolvedValueOnce({ status: 'ok', revision: 12, scope: 'full' })
    eventApi.subscriptions[0].onCommandEvent({ type: 'state.changed', revision: 9, resource: 'state' })

    await vi.waitFor(() => expect(promptTemplateApi.ensure).toHaveBeenCalledOnce())
    expect(promptTemplateApi.ensure).toHaveBeenLastCalledWith({ force: true, minimumRevision: 12 })
    expect(peekAppliedServerResourceRevision()).toBe(5)
    expect(hydrationApi.resetChatHydration).toHaveBeenCalledTimes(2)
    expect(lorebookApi.resetLorebookHydration).toHaveBeenCalledTimes(2)
    expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledWith({ force: true })
    expect(runtimeApi.triggerOpenChatGenerationReattach).not.toHaveBeenCalled()
  })

  it('does not advance the applied cursor when an invalidation read fails', async () => {
    await loadWebInitialDatabase()
    resourceApi.refreshInvalidated.mockResolvedValueOnce({ status: 'error', error: 'network down' })
    eventApi.subscriptions[0].onCommandEvent({ type: 'persona.updated', revision: 6, resource: 'persona' })

    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(1))
    expect(peekAppliedServerResourceRevision()).toBe(5)
  })

  it('reconciles ownership before replay-unavailable recovery when a disconnected tab missed a restore', async () => {
    eventApi.subscribe.mockResolvedValueOnce({ status: 'replay-unavailable', currentRevision: 3 })
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ revision: 3, databaseLineage: 'database-missed-restore', writerEpoch: 2 }),
    )

    await loadWebInitialDatabase()

    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledWith('event-replay-unavailable'))
    expect(ownershipApi.reset).toHaveBeenCalledOnce()
    expect(ownershipApi.discard).toHaveBeenCalledOnce()
    expect(resourceApi.forceRefresh).not.toHaveBeenCalledWith('event-replay-unavailable')
  })

  it('repairs replay and malformed-frame failures through a complete resource refresh', async () => {
    eventApi.subscribe.mockResolvedValueOnce({ status: 'replay-unavailable', currentRevision: 9 })
    await loadWebInitialDatabase()
    await vi.waitFor(() => expect(resourceApi.forceRefresh).toHaveBeenCalledWith('event-replay-unavailable'))

    stopServerResourceEvents()
    eventApi.subscribe.mockImplementationOnce(async (input) => {
      eventApi.subscriptions.push(input)
      return { status: 'ok', unsubscribe: eventApi.unsubscribe }
    })
    await loadWebInitialDatabase()
    eventApi.subscriptions.at(-1)?.onError?.('Malformed command event frame: bad JSON')
    await vi.waitFor(() => expect(resourceApi.forceRefresh).toHaveBeenCalledWith('malformed-command-event'))
  })

  it('publishes memory events without refreshing durable resources', async () => {
    await loadWebInitialDatabase()
    const event: TestMemoryEvent = {
      type: 'memory.job',
      streamId: 'memory-stream-1',
      version: 2,
      chatId: 'chat-a',
      job: {
        id: 'job-a',
        instanceId: 'job-instance-a',
        kind: 'summarize',
        status: 'running',
        attemptCount: 1,
        maxAttempts: 3,
      },
    }
    eventApi.subscriptions[0].onMemoryEvent?.(event)

    expect(memoryApi.applyEvent).toHaveBeenCalledWith(event)
    expect(memoryApi.publish).toHaveBeenCalledWith(event)
    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
  })

  it('hydrates memory projection snapshots without refreshing durable resources', async () => {
    await loadWebInitialDatabase()
    const snapshot: TestMemorySnapshot = {
      type: 'memory.snapshot',
      streamId: 'memory-stream-1',
      version: 1,
      jobs: [
        {
          id: 'job-a',
          instanceId: 'job-instance-a',
          chatId: 'chat-a',
          kind: 'summarize',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
        },
      ],
    }
    eventApi.subscriptions[0].onMemorySnapshot?.(snapshot)

    expect(memoryApi.applySnapshot).toHaveBeenCalledWith(snapshot)
    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
  })

  it('enters the takeover flow only for a different non-null writer session', async () => {
    await loadWebInitialDatabase()
    const ownSessionId = getActiveWriterSessionId()

    eventApi.subscriptions[0].onWriterEvent?.({ sessionId: null, epoch: 0 })
    eventApi.subscriptions[0].onWriterEvent?.({ sessionId: ownSessionId, epoch: 1 })
    expect(activeWriterApi.enterTakeover).not.toHaveBeenCalled()

    eventApi.subscriptions[0].onWriterEvent?.({ sessionId: 'different-writer', epoch: 2 })
    expect(activeWriterApi.enterTakeover).toHaveBeenCalledOnce()
  })

  it('stops the resource event subscription and owner mutation lifecycle', async () => {
    await loadWebInitialDatabase()
    stopServerResourceEvents()
    expect(eventApi.unsubscribe).toHaveBeenCalledTimes(1)
    expect(ownerMutationLifecycleApi.stop).toHaveBeenCalledTimes(1)
  })
})

describe('resource event reconnect backoff', () => {
  it('uses a live heartbeat to retry retained mutations without a reconnect', async () => {
    await loadWebInitialDatabase()
    expect(pendingMutationApi.replay).toHaveBeenCalledTimes(1)

    eventApi.subscriptions[0].onFrame?.({ event: 'message', data: '' })

    await vi.waitFor(() => expect(pendingMutationApi.replay).toHaveBeenCalledTimes(2))
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
  })

  it('reconnects a stream that stops delivering heartbeat frames', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await loadWebInitialDatabase()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
    eventApi.subscriptions[0].onFrame?.({ event: 'message', data: '' })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.unsubscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
  })

  it('resubscribes on online, visibility, pageshow, and focus recovery', async () => {
    await loadWebInitialDatabase()
    expect(pendingMutationApi.replay).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(pendingMutationApi.replay).toHaveBeenCalledTimes(2))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(3))
    window.dispatchEvent(new Event('pageshow'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(4))
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(5))

    expect(eventApi.unsubscribe).toHaveBeenCalledTimes(4)
  })

  it('refreshes and resubscribes when a conflict proves the applied projection is behind', async () => {
    await loadWebInitialDatabase()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'revision_conflict', currentRevision: 9 }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await expect(
      patchRuntimeSettings({
        baseRevision: 5,
        patch: { streamGeminiThoughts: true },
      }),
    ).resolves.toEqual({ status: 'conflict', currentRevision: 9 })

    await vi.waitFor(() => expect(resourceApi.forceRefresh).toHaveBeenCalledWith('conflict-gap'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(2))
  })

  it('schedules increasing reconnect delays during a simulated outage', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    eventApi.subscribe.mockImplementation(async (input) => {
      eventApi.subscriptions.push(input)
      if (eventApi.subscriptions.length === 1) {
        return { status: 'ok', unsubscribe: eventApi.unsubscribe }
      }
      return { status: 'error', error: 'offline' }
    })

    await loadWebInitialDatabase()
    eventApi.subscriptions[0].onClose?.()

    await vi.advanceTimersByTimeAsync(999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3)
  })

  it('keeps one pending reconnect timer for repeated stream failures', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await loadWebInitialDatabase()
    eventApi.subscriptions[0].onClose?.()
    eventApi.subscriptions[0].onClose?.()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
  })

  it('resets reconnect backoff to the base delay after a successful subscribe', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await loadWebInitialDatabase()
    eventApi.subscriptions[0].onClose?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)

    eventApi.subscriptions[1].onClose?.()
    await vi.advanceTimersByTimeAsync(999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3)
  })

  it('stop clears pending reconnect and resets the next outage to base delay', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await loadWebInitialDatabase()
    eventApi.subscriptions[0].onClose?.()
    stopServerResourceEvents()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)

    await loadWebInitialDatabase()
    eventApi.subscriptions[1].onClose?.()
    await vi.advanceTimersByTimeAsync(999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3)
  })

  it('uses capped exponential delay with bounded jitter', () => {
    expect(calculateServerResourceReconnectDelayMs(0, () => 0.5)).toBe(1000)
    expect(calculateServerResourceReconnectDelayMs(1, () => 0.5)).toBe(2000)
    expect(calculateServerResourceReconnectDelayMs(2, () => 0.5)).toBe(4000)
    expect(calculateServerResourceReconnectDelayMs(5, () => 0.5)).toBe(30000)
    expect(calculateServerResourceReconnectDelayMs(10, () => 1)).toBe(30000)
    expect(calculateServerResourceReconnectDelayMs(0, () => Number.NaN)).toBe(1000)
  })
})

describe('global bootstrap error handlers', () => {
  it('global handlers ignore null error events and undefined rejections without useless alerts', () => {
    const { errorHandler, rejectHandler } = createGlobalErrorHandlers()

    errorHandler(new ErrorEvent('error'))
    rejectHandler({ reason: undefined } as PromiseRejectionEvent)

    expect(alertError).not.toHaveBeenCalled()
  })

  it('resource-target global errors skip generic application alerts', () => {
    const { errorHandler } = createGlobalErrorHandlers()
    const event = new ErrorEvent('error', { error: new Error('asset failed') })
    Object.defineProperty(event, 'target', { value: document.createElement('img') })

    errorHandler(event)

    expect(alertError).not.toHaveBeenCalled()
  })

  it('useful global Error objects and message strings still alert', () => {
    const { errorHandler, rejectHandler } = createGlobalErrorHandlers()
    const error = new Error('useful error')

    errorHandler(new ErrorEvent('error', { error }))
    rejectHandler({ reason: 'useful rejection' } as PromiseRejectionEvent)

    expect(alertError).toHaveBeenNthCalledWith(1, error)
    expect(alertError).toHaveBeenNthCalledWith(2, 'useful rejection')
  })
})

describe('explicit connected writer switching', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((finish) => {
      resolve = finish
    })
    return { promise, resolve }
  }

  async function startReader() {
    __observerShellFlagTestHooks.setOverride(true)
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    await loadData()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
    )
  }

  function newerWriter() {
    const writer = { sessionId: 'newer-writer', epoch: 3 }
    bootstrapApi.fetchReadOnly.mockResolvedValue(runtimeBootstrap({ writer, writerEpoch: 3 }))
    observeClientWriter(writer)
    return writer
  }

  it('shares one confirmed acquisition/recovery chain and keeps the chosen reader route', async () => {
    await startReader()
    currentRoute.set({ kind: 'character', path: '/character/char-a/chat-a', chaId: 'char-a', chatId: 'chat-a' })
    const held = deferred<{ status: 'ok'; revision: number; scope: 'shell' }>()
    resourceApi.loadInitial.mockImplementationOnce(() => held.promise)
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
    const switching = promoteConnectedReader()
    expect(promoteConnectedReader()).toBe(switching)
    await vi.waitFor(() => expect(resourceApi.loadInitial).toHaveBeenCalledTimes(2))
    expect(promoteConnectedReader()).toBe(switching)
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'recovering-writer', projectionReady: true })
    expect(canUseClientWriteAccess()).toBe(false)
    expect(readerApi.start).toHaveBeenCalledTimes(2)
    expect(bootstrapApi.fetch).toHaveBeenNthCalledWith(1, expect.any(AbortSignal), {
      expectedWriter: { epoch: 1, databaseLineage: 'database-a' },
    })
    expect(bootstrapApi.fetch).toHaveBeenNthCalledWith(2, expect.any(AbortSignal), {
      expectedWriter: { epoch: 1, databaseLineage: 'database-a' },
      disconnectExistingWriter: true,
    })
    expect(alertRequiredSelect).toHaveBeenCalledWith(
      [language.writerConnectDisconnectExisting, language.cancel],
      language.writerConnectConflictBody,
      language.writerConnectConflictTitle,
      { signal: expect.any(AbortSignal) },
    )
    held.resolve({ status: 'ok', revision: 9, scope: 'shell' })
    await expect(switching).resolves.toEqual({ status: 'promoted' })
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'writing',
      connection: 'live',
      writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
    })
    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: true, canGenerate: true })
    expect(get(currentRoute)).toMatchObject({ chaId: 'char-a', chatId: 'chat-a' })
    expect(pendingMutationApi.readOwner).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
    expect(pendingMutationApi.flushAcknowledgements).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(eventApi.subscribe).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      pendingMutationApi.flushAcknowledgements.mock.invocationCallOrder[0]!,
    )
    expect(pendingMutationApi.flushAcknowledgements.mock.invocationCallOrder[0]).toBeLessThan(
      pendingMutationApi.replay.mock.invocationCallOrder[0]!,
    )
    expect(pendingMutationApi.replay.mock.invocationCallOrder[0]).toBeLessThan(
      resourceApi.loadInitial.mock.invocationCallOrder[1]!,
    )
    expect(resourceApi.loadInitial.mock.invocationCallOrder[1]).toBeLessThan(
      eventApi.subscribe.mock.invocationCallOrder[0]!,
    )
  })

  it('cancels without takeover, replay, or blocking a fresh reader subscription', async () => {
    await startReader()
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
    vi.mocked(alertRequiredSelect).mockResolvedValueOnce('1')
    await expect(promoteConnectedReader()).resolves.toEqual({ status: 'cancelled' })
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(3))
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(pendingMutationApi.replay).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      projectionReady: true,
      connection: 'live',
    })
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('aborts its own confirmation when a newer writer wins and ignores a late confirm', async () => {
    await startReader()
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
    const selection = deferred<string>()
    vi.mocked(alertRequiredSelect).mockImplementationOnce(() => selection.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(alertRequiredSelect).toHaveBeenCalledOnce())
    const signal = vi.mocked(alertRequiredSelect).mock.calls[0]![3]!.signal!
    newerWriter()
    expect(signal.aborted).toBe(true)
    selection.resolve('0')
    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('rejects a held acquisition success after a later writer without applying its bootstrap', async () => {
    await startReader()
    const acquisition = deferred<ReturnType<typeof runtimeBootstrap>>()
    bootstrapApi.fetch.mockImplementationOnce(() => acquisition.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledOnce())
    const writer = newerWriter()
    acquisition.resolve(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
    )
    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(eventApi.subscribe).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', writer })
  })

  it.each(['prepare', 'receipt', 'replay', 'hydration', 'events'] as const)(
    'does not continue writer work after supersession during %s',
    async (phase) => {
      await startReader()
      const held = deferred<unknown>()
      const step =
        phase === 'prepare'
          ? pendingMutationApi.prepare
          : phase === 'receipt'
            ? pendingMutationApi.flushAcknowledgements
            : phase === 'replay'
              ? pendingMutationApi.replay
              : phase === 'hydration'
                ? resourceApi.loadInitial
                : eventApi.subscribe
      const oldCount = step.mock.calls.length
      step.mockImplementationOnce(() => held.promise)
      const switching = promoteConnectedReader()
      await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(oldCount + 1))
      expect(canUseClientWriteAccess()).toBe(false)
      newerWriter()
      held.resolve(
        phase === 'prepare'
          ? { discarded: 0 }
          : phase === 'receipt'
            ? undefined
            : phase === 'replay'
              ? { attempted: 0, discarded: 0, retained: 0, succeeded: 0 }
              : phase === 'hydration'
                ? { status: 'ok', revision: 7, scope: 'shell' }
                : { status: 'ok', unsubscribe: eventApi.unsubscribe },
      )
      await expect(switching).resolves.toEqual({ status: 'superseded' })
      expect(canUseClientWriteAccess()).toBe(false)
      expect(loadPlugins).not.toHaveBeenCalled()
      expect(recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects).not.toHaveBeenCalled()
      if (phase === 'prepare') expect(pendingMutationApi.flushAcknowledgements).not.toHaveBeenCalled()
      if (phase === 'prepare' || phase === 'receipt') expect(pendingMutationApi.replay).not.toHaveBeenCalled()
      if (phase !== 'events') expect(eventApi.subscribe).not.toHaveBeenCalled()
      else expect(eventApi.unsubscribe).toHaveBeenCalled()
      await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
      expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    },
  )

  it.each(['retained', 'unreadable'] as const)(
    'preserves %s recovery work while returning to a usable reader',
    async (reason) => {
      await startReader()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (reason === 'retained')
        pendingMutationApi.replay.mockResolvedValueOnce({ attempted: 1, discarded: 0, retained: 1, succeeded: 0 })
      else pendingMutationApi.count.mockResolvedValueOnce(null)
      bootstrapApi.fetchReadOnly.mockResolvedValue(
        runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
      )
      await expect(promoteConnectedReader()).resolves.toEqual({ status: 'failed', reason: 'retained-work' })
      await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(3))
      expect(getClientSessionSnapshot()).toMatchObject({
        lifecycle: 'reading',
        projectionReady: true,
        connection: 'live',
      })
      expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
      expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
      expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
      expect(ownershipApi.discard).not.toHaveBeenCalled()
      expect(loadPlugins).not.toHaveBeenCalled()
    },
  )

  it.each(['replay-unavailable', 'unavailable'] as const)(
    'cannot inherit reader connection readiness when the writer subscription is %s',
    async (status) => {
      await startReader()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const refresh = deferred<{ status: 'ok'; revision: number }>()
      resourceApi.forceRefresh.mockImplementationOnce(() => refresh.promise)
      resourceApi.forceReplacement.mockImplementationOnce(() => refresh.promise)
      eventApi.subscribe.mockResolvedValueOnce(
        status === 'replay-unavailable' ? { status, currentRevision: 12 } : { status },
      )
      const acquired = runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } })
      bootstrapApi.fetch.mockImplementationOnce(async () => {
        bootstrapApi.fetchReadOnly.mockResolvedValue(acquired)
        return acquired
      })
      const lifecycles: string[] = []
      const stop = clientSessionStore.subscribe((state) => lifecycles.push(state.lifecycle))
      try {
        await expect(promoteConnectedReader()).resolves.toEqual({ status: 'failed', reason: 'unavailable' })
        expect(lifecycles).not.toContain('writing')
        expect(canUseClientWriteAccess()).toBe(false)
        expect(loadPlugins).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
        expect(getClientSessionSnapshot().lifecycle).toBe('reading')
        expect(eventApi.subscribe).toHaveBeenCalledOnce()
      } finally {
        refresh.resolve({ status: 'ok', revision: 12 })
        stop()
      }
    },
  )

  it('does not automatically reacquire after the conditional server check loses a race', async () => {
    await startReader()
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'error', error: 'active_writer_changed', httpStatus: 409 })
    await expect(promoteConnectedReader()).resolves.toEqual({ status: 'failed', reason: 'unavailable' })
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(3))
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('requires fresh explicit action after an interrupted confirmation', async () => {
    await startReader()
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
    const selection = deferred<string>()
    vi.mocked(alertRequiredSelect).mockImplementationOnce(() => selection.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(alertRequiredSelect).toHaveBeenCalledOnce())
    window.dispatchEvent(new Event('offline'))
    selection.resolve('0')
    await expect(switching).resolves.toEqual({ status: 'failed', reason: 'interrupted' })
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('clears a newly discovered lineage without claiming its writer', async () => {
    await startReader()
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({
        databaseLineage: 'database-b',
        writerEpoch: 0,
        writer: { sessionId: 'replacement-writer', epoch: 0 },
      }),
    )
    await expect(promoteConnectedReader()).resolves.toEqual({ status: 'superseded' })
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
    expect(projectionLifecycleApi.discard).toHaveBeenCalledWith('lineage-change')
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', databaseLineage: 'database-b' })
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
  })

  it('does not let an older held result demote a later successful explicit switch', async () => {
    await startReader()
    const oldAcquisition = deferred<ReturnType<typeof runtimeBootstrap>>()
    bootstrapApi.fetch.mockImplementationOnce(() => oldAcquisition.promise)
    const oldSwitch = promoteConnectedReader()
    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledOnce())
    newerWriter()
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({
        writerEpoch: 4,
        writer: { sessionId: getActiveWriterSessionId(), epoch: 4 },
      }),
    )
    const newSwitch = promoteConnectedReader()
    expect(newSwitch).not.toBe(oldSwitch)
    await expect(newSwitch).resolves.toEqual({ status: 'promoted' })
    const generation = getClientSessionSnapshot().generation
    oldAcquisition.resolve(
      runtimeBootstrap({
        writerEpoch: 2,
        writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
      }),
    )
    await expect(oldSwitch).resolves.toEqual({ status: 'superseded' })
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'writing',
      generation,
      writer: { sessionId: getActiveWriterSessionId(), epoch: 4 },
    })
    expect(canUseClientWriteAccess()).toBe(true)
    expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
  })

  it('does not publish resources from a stale ownership discovery after demotion', async () => {
    __observerShellFlagTestHooks.setOverride(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadData()
    const writer = { sessionId: 'newer-writer', epoch: 3 }
    bootstrapApi.fetchReadOnly
      .mockResolvedValueOnce(runtimeBootstrap())
      .mockResolvedValue(runtimeBootstrap({ writer, writerEpoch: 3 }))
    eventApi.subscriptions[0]!.onWriterEvent!(writer)
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('interrupted'))
    expect(resourceApi.readAll).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledOnce(), { timeout: 3000 })
    expect(resourceApi.readAll).toHaveBeenCalledOnce()
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live', writer })
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
  })

  it('fences deferred services when teardown follows completed writer recovery', async () => {
    await startReader()
    const plugins = deferred<void>()
    vi.mocked(loadPlugins).mockImplementationOnce(() => plugins.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(loadPlugins).toHaveBeenCalledOnce())
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    const ownerStops = ownerMutationLifecycleApi.stop.mock.calls.length
    stopConnectedClientServices()
    expect(canUseClientWriteAccess()).toBe(false)
    expect(ownerMutationLifecycleApi.stop.mock.calls.length).toBeGreaterThan(ownerStops)
    plugins.resolve()
    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(startPluginRuntimeSync).not.toHaveBeenCalled()
    expect(recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('tears down a held operation without allowing it to acquire afterward', async () => {
    await startReader()
    const discovery = deferred<ReturnType<typeof runtimeBootstrap>>()
    bootstrapApi.fetchReadOnly.mockImplementationOnce(() => discovery.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledTimes(2))
    stopConnectedClientServices()
    discovery.resolve(runtimeBootstrap())
    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
  })
})
