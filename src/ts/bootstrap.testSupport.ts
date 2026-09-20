// Import this fixture before bootstrap or its dependencies so Vitest installs the mocks first.
import { afterEach, beforeEach, it, vi } from 'vitest'
import { stopDeferredStartupRuntimes, stopConnectedClientServices, stopServerResourceEvents } from './bootstrap'
import { setClientConnectionState } from './clientSession'
import { loadPlugins, startPluginRuntimeSync } from './plugins/plugins.svelte'
import { alertError, alertRequiredSelect, waitAlert } from './alert'
import { language } from 'src/lang'
import { updateHeightMode } from './gui/heightMode'
import { clearAppliedServerResourceRevision, clearCachedServerCommandRevision } from './server/commands'
import { getActiveWriterSessionId, resetWriterAccessLostForTests } from './server/activeWriterSession'
import { recordStartupMilestone, resetStartupReadinessForTests } from './startupReadiness'
import { replaceResourceDatabase, resetServerResourceState } from './server/resourceState.svelte'
import { selectedCharID } from './stores.svelte'
import { currentRoute } from './router'
import { updateReducedMotion } from './gui/animation'
import { updateColorScheme, updateTextThemeAndCSS } from './gui/colorscheme'
import { updateGuisize } from './gui/guisize'
import { resetReaderWorkspaceLifecycleForTests } from './readerWorkspaceLifecycle.svelte'

const readerApi = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), retry: vi.fn() }))
const autoWriterApi = vi.hoisted(() => ({ enabled: vi.fn() }))
vi.mock('./server/automaticWriterAcquisition', () => ({ shouldAutoAcquireDisconnectedWriter: autoWriterApi.enabled }))
const identityApi = vi.hoisted(() => ({ exclusive: true }))

const bootstrapApi = vi.hoisted(() => ({
  fetch: vi.fn(),
  fetchReadOnly: vi.fn(),
  fetchOwnership: vi.fn(),
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
    onOccupancyEvent?: (event: any) => void
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
const occupancyApi = vi.hoisted(() => ({
  configure: vi.fn(),
  applyEvent: vi.fn(),
  recover: vi.fn(),
  setIdentity: vi.fn(),
  clearIdentity: vi.fn(),
}))
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

export interface TestCommandEvent {
  type: string
  revision: number
  resource: string
  id?: string
  parentId?: string
  origin?: { writerSessionId: string }
}

export interface TestMemoryEvent {
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

export interface TestMemorySnapshot {
  type: 'memory.snapshot'
  streamId: string
  version: number
  jobs: Array<TestMemoryEvent['job'] & { chatId: string }>
}

export interface TestWriterEvent {
  databaseLineage?: string
  sessionId: string | null
  epoch: number
}

// The lifecycle's real hydration/cache clearing has its own focused suite.
// Keep bootstrap ordering independent of that cold dynamic import's duration.
vi.mock('./readerProjectionLifecycle', () => ({
  discardReaderProjectionState: projectionLifecycleApi.discard,
}))

vi.mock('./server/connectedTabIdentity', () => ({
  resolveConnectedTabIdentity: async () => ({
    sessionId: getActiveWriterSessionId(),
    exclusive: identityApi.exclusive,
    previousSessionId: null,
  }),
  releaseConnectedTabIdentity: vi.fn(),
}))
vi.mock('./server/connectedReaderSync', () => ({ startConnectedReaderSync: readerApi.start }))

vi.mock('./server/bootstrap', () => ({
  fetchServerBootstrap: bootstrapApi.fetch,
  fetchServerBootstrapReadOnly: bootstrapApi.fetchReadOnly,
  fetchServerOwnership: bootstrapApi.fetchOwnership,
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
vi.mock('./server/chatOccupancy', () => ({
  configureClientChatOccupancy: occupancyApi.configure,
  applyClientChatOccupancyEvent: occupancyApi.applyEvent,
  setClientChatOccupancyIdentity: occupancyApi.setIdentity,
  clearClientChatOccupancyIdentity: occupancyApi.clearIdentity,
  requestClientChatOccupancyRecovery: occupancyApi.recover,
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

export function runtimeBootstrap(overrides: Record<string, unknown> = {}) {
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

export function runtimeOwnership(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    ownership: {
      version: 1 as const,
      databaseLineage: 'database-a',
      writer: { sessionId: getActiveWriterSessionId(), epoch: 1 },
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
  identityApi.exclusive = true
  resetReaderWorkspaceLifecycleForTests()
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
  autoWriterApi.enabled.mockReset().mockResolvedValue(false)
  runtimeApi.applyGenerationOperationBootstrap.mockReset().mockReturnValue(true)
  occupancyApi.configure.mockReset()
  occupancyApi.applyEvent.mockReset()
  occupancyApi.setIdentity.mockReset()
  occupancyApi.clearIdentity.mockReset()
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
  bootstrapApi.fetchOwnership.mockResolvedValue(runtimeOwnership())
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
  resetReaderWorkspaceLifecycleForTests()
  stopDeferredStartupRuntimes()
  stopServerResourceEvents()
  resetStartupReadinessForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

export const coreIt = (name: string, fn: () => void | Promise<void>): void => it(name, { tags: 'core' }, fn)
export const bootstrapMocks = {
  readerApi,
  autoWriterApi,
  identityApi,
  bootstrapApi,
  resourceApi,
  routeResourceApi,
  commandApi,
  eventApi,
  hydrationApi,
  characterHydrationApi,
  lorebookApi,
  promptTemplateApi,
  runtimeApi,
  recoveredGenerationApi,
  ownerMutationLifecycleApi,
  pendingMutationApi,
  ownershipApi,
  projectionLifecycleApi,
  memoryApi,
  occupancyApi,
  activeWriterApi,
  pushApi,
  optionalRuntimeApi,
}
