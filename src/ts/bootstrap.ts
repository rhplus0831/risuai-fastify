import { get } from 'svelte/store'
import { botMakerMode } from './stores.svelte'
import { LoadingStatusState, selectedCharID } from './stores/coreStores.svelte'
import { currentRoute } from './router'
import { isPreWriterObserverShellEnabled } from './observerShellFlag'
import {
  isPluginRuntimeReady,
  loadPlugins,
  startPluginRuntimeSync,
  stopPluginRuntimeSync,
} from './plugins/plugins.svelte'
import { alertError, alertMd, alertRequiredSelect, waitAlert } from './alert'
import { updateReducedMotion } from './gui/animation'
import { updateColorScheme, updateTextThemeAndCSS } from './gui/colorscheme'
import { awaitLanguageReady, changeLanguage, language } from 'src/lang'
import { resolveUniquePromptPreset } from '@risuai/shared-core/effective-prompt-template'
import { updateGuisize } from './gui/guisize'
import { fetchServerBootstrap, fetchServerBootstrapReadOnly, type ServerBootstrapRuntime } from './server/bootstrap'
import { subscribeServerCommandEvents, type ServerMemoryEvent, type ServerMemoryJobSnapshot } from './server/events'
import { publishServerMemoryJobEvent } from './server/memoryJobEvents'
import { publishServerBardWikiJobEvent, publishServerBardWikiJobSnapshot } from './server/bardWikiJobEvents'
import {
  deferOwnServerCommandReconciliation,
  initializeServerDatabaseForBootstrap,
  notifyServerCommandLocalEffectApplied,
  peekAppliedServerResourceRevision,
  peekCachedServerCommandRevision,
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
  setServerCommandConflictGapHandler,
  setServerCommandSuccessReconciler,
  type CommandEvent,
  type AgentPresetCollectionMutationLocalEffect,
  type AgentPresetPatchLocalEffect,
  type AgentPresetStepPatchLocalEffect,
  type LegacyPresetPatchLocalEffect,
  type PresetReorderLocalEffect,
  type PersonaMutationLocalEffect,
  type PersonaPatchLocalEffect,
  type ServerCommandLocalEffect,
  type TranslatorPresetPatchLocalEffect,
} from './server/commands'
import {
  adoptPendingMutationWriterSessionId,
  beginWriterAccessRecovery,
  completeWriterAccessRecovery,
  enterWriterTakeoverFlow,
  getActiveWriterSessionId,
  peekActiveWriterSessionId,
} from './server/activeWriterSession'
import { observerShellLifecycleStore, setObserverShellLifecycleMode } from './observerShellLifecycle.svelte'
import { startOwnerMutationLifecycleFlush } from './server/ownerMutationLifecycle'
import { replayPendingMutations } from './server/pendingMutationReplay'
import { applyGenerationOperationBootstrap, configureGenerationOperationProtocol } from './server/generationOperations'
import { configureDisplaySourceProtocol } from './server/displaySources'
import {
  countBlockingPendingMutationRecords,
  preparePendingMutationOutbox,
  readSinglePendingMutationOwner,
} from './server/pendingMutationOutbox'
import { initializeDraftRecoveryScope } from './server/draftRecoveryScope'
import {
  flushPendingMutationReceiptAcknowledgements,
  setPendingMutationDiscardNotifier,
} from './server/durableMutationDispatch'
import {
  acknowledgeCreatedChatTranscriptLocalEffect,
  acknowledgeMessageMutationLocalEffect,
  applyMessageTranslationLocalEffect,
  hydrateActiveChat,
  invalidateChatHydration,
  resetChatHydration,
  requestActiveChatReadinessRefresh,
  setActiveChatReadinessRefreshHook,
  startChatMessageHydration,
  stopChatMessageHydration,
} from './server/chatMessageHydration.svelte'
import {
  hydrateSelectedCharacterShell,
  startSelectedCharacterShellHydration,
  stopSelectedCharacterShellHydration,
} from './server/characterShellHydration.svelte'
import {
  isCharacterLorebookHydrated,
  recordHydratedCharacterLorebooks,
  resetLorebookHydration,
} from './server/lorebookOwner.svelte'
import {
  prepareOpenChatGenerationReattach,
  setActiveGenerationReattachReadinessPredicate,
  startActiveGenerationReattach,
  stopActiveGenerationReattach,
  triggerOpenChatGenerationReattach,
} from './process/reattach'
import { subscribeBrowserLifecycleRecovery } from './server/lifecycleRecovery'
import {
  setGenerationFinalizationPersistences,
  startGenerationFinalizationPersistenceRefresh,
  stopGenerationFinalizationPersistenceRefresh,
} from './process/generationPersistenceState'
import {
  setActiveMessageTranslations,
  startActiveMessageTranslationRefresh,
  stopActiveMessageTranslationRefresh,
} from './server/messageTranslationJobs'
import {
  setActiveGreetingTranslations,
  startActiveGreetingTranslationRefresh,
  stopActiveGreetingTranslationRefresh,
} from './server/greetingTranslations.svelte'
import { applyServerMemoryJobEvent, applyServerMemoryJobSnapshot } from './server/memoryJobProjection.svelte'
import {
  loadInitialServerResources,
  refreshAllServerResources,
  refreshInvalidatedServerResources,
} from './server/resourceInvalidation'
import { ensureResourceSurfaces, stopRouteResourceLoader } from './server/routeResourceLoader'
import {
  forceServerDatabaseReplacementRefresh,
  forceServerResourceRefresh,
  serverResourceInvalidationHooks,
} from './server/resourceRefresh'
import {
  adoptReplacementDatabaseOwnership,
  hasPendingReplacementDatabaseRefresh,
  isReplacementDatabaseOwnershipRefreshPending,
  markReplacementDatabaseOwnershipRefreshed,
  waitForLocalReplacementDatabaseOperations,
  wasReplacementDatabaseOwnershipRefreshed,
  type ReplacementDatabaseOwnership,
} from './server/replacementDatabaseOwnership'
import {
  resolveSelectedCharacterIndexAfterRefresh,
  trackSelectedCharacterDuringRefresh,
  type SelectedCharacterRefreshSnapshot,
} from './server/selectedCharacterRefresh'
import {
  applyCharacterCollectionMutationLocalEffect,
  applyCharacterPatchLocalEffect,
  applyCharacterOrderLocalEffect,
  applyCharacterRowMutationLocalEffect,
  applyCharacterSelectionLocalEffect,
  applyChatPatchLocalEffect,
  applyChatGenerationSettingsLocalEffect,
  applySettingsPatchLocalEffect,
  applyPluginCollectionMutationLocalEffect,
  applyPluginProviderLocalEffect,
  applyPluginStorageLocalEffect,
  applyModuleCollectionMutationLocalEffect,
  applyModuleEnabledLocalEffect,
  applyPromptItemMutationLocalEffect,
  applyLegacyPresetPatchLocalEffect,
  applyPresetReorderLocalEffect,
  applyAgentPresetCollectionMutationLocalEffect,
  applyAgentPresetPatchLocalEffect,
  applyAgentPresetStepPatchLocalEffect,
  applyPersonaMutationLocalEffect,
  applyPersonaPatchLocalEffect,
  applyTranslatorPresetPatchLocalEffect,
  applySplitPresetPatchLocalEffect,
  applyGlobalLorebookMutationLocalEffect,
  applyLoadoutMutationLocalEffect,
  applyLorebookMutationLocalEffect,
  charactersResourceState,
  collectionsResourceState,
  getCharacterResourceOwner,
  hasChatBodyProjectionEpochChanged,
  hasCharacterLorebookProjectionEpochChanged,
  hasCharacterRowProjectionEpochChanged,
  hasCollectionProjectionEpochChanged,
  hasLorebookPageProjectionEpochChanged,
  hasSettingsGroupProjectionEpochChanged,
  hasSettingsProjectionEpochChanged,
  isCollectionAcknowledgementTainted,
  isSettingsAcknowledgementTainted,
  isSettingsGroupAcknowledgementTainted,
  settingsResourceState,
} from './server/resourceState.svelte'
import { hasDestructiveRefreshEpochChanged } from './server/staleStateGuards'
import {
  ensurePromptTemplateHydrated,
  hasPromptTemplateOwnerProjectionEpochChanged,
  isPromptTemplateOwnerAcknowledgementTainted,
  isPromptTemplateHydrated,
  markPromptTemplateProjectionApplied,
  peekPromptTemplateOwnerRevision,
} from './server/promptTemplateHydration'
import { setSettingsRuntimeProjectionHook } from './server/settingsRuntimeProjectionHooks'
import { updateHeightMode } from './gui/heightMode'
import {
  discardPendingRecoveredGenerationEffects,
  reconcilePendingRecoveredGenerationEffects,
  setPendingRecoveredGenerationEffects,
} from './process/recoveredGenerationEffects'
import {
  advanceStartupChatReadinessEvaluation,
  backgroundReady,
  beginStartupAttempt,
  beginStartupChatReadinessEvaluation,
  canRenderShell,
  canMutate,
  completeStartupAttempt,
  configureStartupObserverShell,
  failStartupAttempt,
  finishStartupChatReadinessEvaluation,
  recordStartupCapabilityFailure,
  recordStartupMilestone,
  restoreStartupWriterCapabilities,
  retryStartupCapability,
  runStartupStep,
  settleStartupChatReadiness,
  settleStartupGenerationRecoveryReadiness,
  startupRetryTargetForMilestone,
  type StartupAttemptFailureCode,
  type StartupMilestone,
  type StartupRetryTarget,
} from './startupReadiness'
import { startStartupTelemetryPublisher } from './server/startupTelemetry'
import { cacheDisplaySettings } from './gui/displaySettingsCache'
import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  beginClientWriterResume,
  canUseClientWriteAccess,
  canUseClientRecoveryAccess,
  captureClientSessionGeneration,
  clientSessionStore,
  completeClientWriterRecovery,
  demoteClientSession,
  failClientSessionOperation,
  getClientSessionSnapshot,
  isClientSessionGenerationCurrent,
  isClientSessionManaged,
  isClientSessionOperationCurrent,
  observeClientWriter,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
  type ClientSessionOperation,
} from './clientSession'
import { bootstrapOwnership, resolveConnectedClientStartup } from './connectedClientStartup'
import { startConnectedReaderSync } from './server/connectedReaderSync'
import { releaseConnectedTabIdentity } from './server/connectedTabIdentity'
import { invalidateResourceCacheWork } from './server/resourceCache'
import { discardObserverProjectionState } from './observerProjectionLifecycle'

setPendingMutationDiscardNotifier((key, error) => {
  alertError(`${language.pendingMutationDiscarded}\n\n${language.pendingMutationDiscardedDetail(key, error)}`)
})

const COLOR_SCHEME_RUNTIME_KEYS = new Set(['colorScheme', 'colorSchemeName', 'customBackground'])
const TEXT_THEME_RUNTIME_KEYS = new Set(['textTheme', 'customTextTheme', 'font', 'customFont', 'customCSS'])
const GUI_SIZE_RUNTIME_KEYS = new Set(['textAreaSize', 'textAreaTextSize', 'sideBarSize'])

class FatalBootstrapError extends Error {}

class RetainedWriterRecoveryError extends Error {}

class StartupChatDependencyError extends Error {
  constructor(
    readonly failureCode: Extract<
      StartupAttemptFailureCode,
      | 'selected-character-hydration-failed'
      | 'selected-chat-hydration-failed'
      | 'selected-prompt-template-hydration-failed'
    >,
    message: string,
  ) {
    super(message)
  }
}

function hasProjectedRuntimeKey(keys: readonly string[], candidates: ReadonlySet<string>): boolean {
  return keys.some((key) => candidates.has(key))
}

setSettingsRuntimeProjectionHook((keys) => {
  cacheDisplaySettings(settingsResourceState.value, keys)
  const colorSchemeChanged = hasProjectedRuntimeKey(keys, COLOR_SCHEME_RUNTIME_KEYS)
  if (colorSchemeChanged) updateColorScheme()
  if (colorSchemeChanged || hasProjectedRuntimeKey(keys, TEXT_THEME_RUNTIME_KEYS)) updateTextThemeAndCSS()
  if (hasProjectedRuntimeKey(keys, GUI_SIZE_RUNTIME_KEYS)) updateGuisize()
  if (keys.includes('animationSpeed') || keys.includes('reducedMotion')) updateReducedMotion()
  if (keys.includes('heightMode')) updateHeightMode()
  if (backgroundReady() && keys.includes('notification')) {
    void reconcileProjectedPushNotificationSetting(settingsResourceState.value.notification === true)
  }
})

const SERVER_RESOURCE_RECONNECT_BASE_DELAY_MS = 1000
const SERVER_RESOURCE_RECONNECT_MAX_DELAY_MS = 30_000
const SERVER_RESOURCE_RECONNECT_JITTER_RATIO = 0.2
const SERVER_RESOURCE_EVENT_STALE_TIMEOUT_MS = 60_000

let serverResourceEventSubscription: { unsubscribe: () => void } | null = null
let stopOwnerMutationLifecycleFlush: (() => void) | null = null
// Serializes resource invalidation so the applied revision cursor advances in
// command-event order.
let serverResourceSyncChain: Promise<void> = Promise.resolve()
let serverResourceEventsDesired = false
let serverResourceReconnectTimer: ReturnType<typeof setTimeout> | null = null
let serverResourceReconnectAttempt = 0
let serverResourceEventEpoch = 0
let serverResourceLastFrameAt = 0
let serverResourceEventWatchdogTimer: ReturnType<typeof setTimeout> | null = null
let stopServerResourceRecoveryListeners: (() => void) | null = null
let reconnectPendingMutationReplay: Promise<void> | null = null
let serverResourceRuntimeReplayEnabled = false
let stopStartupChatReadinessSync: (() => void) | null = null
let startupChatReadinessEpoch = 0
let startupChatReadinessTarget: string | null = null
let startupChatReattachReady = false
let startupGenerationRecoveryReady = false
let stopStoreRuntimeEffects: (() => void) | null = null
let stopDomObserver: (() => void) | null = null
let stopGlobalErrorHandlers: (() => void) | null = null
let stopPushRuntime: (() => void) | null = null
let connectedReaderSync: ReturnType<typeof startConnectedReaderSync> | null = null
let stopConnectedSessionLifecycle: (() => void) | null = null
let connectedReaderRefresh: { generation: number; promise: Promise<void> } | null = null
let connectedWriterResume: Promise<void> | null = null
let connectedWriterResumeTimer: ReturnType<typeof setTimeout> | null = null
let connectedWriterResumeAttempt = 0
let stopConnectedPageLifecycle: (() => void) | null = null
let connectedAuthenticationRetry: Promise<void> | null = null
let connectedWriterOwnershipCheck: Promise<void> | null = null
let connectedReaderRefreshTimer: ReturnType<typeof setTimeout> | null = null
let connectedReaderRefreshAttempt = 0
let connectedWriterPromotion: {
  operation: ClientSessionOperation
  controller: AbortController
  promise: Promise<ConnectedWriterPromotionResult>
} | null = null
let connectedInitializationDecision: {
  operation: ClientSessionOperation
  controller: AbortController
} | null = null

setActiveGenerationReattachReadinessPredicate(
  () => startupChatReattachReady && startupGenerationRecoveryReady && isPluginRuntimeReady(),
)

function initialSelectedCharacterIndex(): number {
  const currentChar = charactersResourceState.currentChar
  const characterCount = charactersResourceState.characters.length
  if (Number.isInteger(currentChar) && (currentChar as number) >= 0 && (currentChar as number) < characterCount) {
    return currentChar as number
  }
  return -1
}

function applyResourceOwnerMutation<T>(mutation: () => T): T {
  return mutation()
}

let loadDataInFlight: Promise<void> | null = null
let observerWriterPromotionRetryInFlight: Promise<boolean> | null = null

/**
 * Loads the application data. Concurrent callers share one attempt loop, and a
 * retry resumes at its failed capability because successful coordinator steps
 * are retained.
 */
export function loadData(): Promise<void> {
  startStartupTelemetryPublisher()
  if (backgroundReady()) return Promise.resolve()
  if (loadDataInFlight) return loadDataInFlight

  const running = loadDataUntilSettled().finally(() => {
    loadDataInFlight = null
  })
  loadDataInFlight = running
  return running
}

async function loadDataUntilSettled(): Promise<void> {
  let retryTarget: StartupRetryTarget | null = null
  while (!backgroundReady()) {
    const outcome = retryTarget
      ? await retryStartupCapability(retryTarget, runLoadDataAttempt)
      : await runLoadDataAttempt()
    if (!outcome) return
    retryTarget = outcome
  }
}

async function runLoadDataAttempt(): Promise<StartupRetryTarget | null> {
  const startupAttemptId = beginStartupAttempt()
  const failureCode: StartupAttemptFailureCode = 'writer-bootstrap-failed'
  const observerShellEnabled = isPreWriterObserverShellEnabled()
  let attemptGeneration = captureClientSessionGeneration()
  configureStartupObserverShell(observerShellEnabled)
  try {
    if (observerShellEnabled) {
      installConnectedSessionLifecycle()
      const startup = await resolveConnectedClientStartup({
        onOperationStarted: (operation) => {
          attemptGeneration = operation.generation
        },
        onCoherentReadView: (runtime, operation) =>
          installConnectedReaderProjection(runtime, operation.generation, { subscribe: false }),
        onInitializationRequired: confirmConnectedServerInitialization,
      })
      if (startup.role === 'reader') {
        await installConnectedReaderProjection(startup.runtime, startup.operation.generation)
        recordStartupMilestone('background-ready')
        completeStartupAttempt(startupAttemptId)
        return null
      }
      await recoverConnectedWriter(startup.runtime, startup.operation)
    } else {
      await runStartupStep('writer-shell', () => loadWebInitialDatabase({ coordinated: true }))
    }
    const writerGeneration = captureClientSessionGeneration()
    const assertWriterCurrent = () => {
      if (!isClientSessionGenerationCurrent(writerGeneration) || !canUseClientWriteAccess()) {
        throw new Error('Writer startup was superseded')
      }
    }
    await runStartupStep('chat-hydration-runtime', () => {
      startSelectedCharacterShellHydration()
      startChatMessageHydration()
    })
    const backgroundReadiness = runStartupStep('background-readiness', () =>
      settleStartupBackgroundReadiness(startupAttemptId),
    ).catch((error) => {
      if (isClientSessionGenerationCurrent(writerGeneration)) throw error
    })
    const pluginRuntimeReady = await settleStartupPluginRuntime(startupAttemptId)
    assertWriterCurrent()
    if (pluginRuntimeReady) await settleStartupGenerationRecovery(startupAttemptId)
    assertWriterCurrent()
    try {
      await runStartupStep('chat-readiness', ensureStartupChatReadiness)
      assertWriterCurrent()
      settleStartupChatReadiness(true)
    } catch (error) {
      assertWriterCurrent()
      const dependencyError =
        error instanceof StartupChatDependencyError
          ? error
          : new StartupChatDependencyError('selected-chat-hydration-failed', 'Selected chat hydration failed')
      recordStartupCapabilityFailure(startupAttemptId, dependencyError.failureCode, 'chat-ready')
      settleStartupChatReadiness(false)
      console.warn(dependencyError.message)
    }
    startStartupChatReadinessSync(startupAttemptId)
    await backgroundReadiness
    assertWriterCurrent()
    await reconcileProjectedPushNotificationSetting(settingsResourceState.value.notification === true)
    recordStartupMilestone('background-ready')
    completeStartupAttempt(startupAttemptId)
    return null
  } catch (error) {
    if (!isClientSessionGenerationCurrent(attemptGeneration)) {
      failStartupAttempt(startupAttemptId, failureCode, 'writer-ready')
      return null
    }
    if (isClientSessionManaged() && getClientSessionSnapshot().lifecycle === 'auth-required') {
      failStartupAttempt(startupAttemptId, failureCode, 'observer-ready')
      return null
    }
    if (isClientSessionManaged() && getClientSessionSnapshot().authenticated) {
      const state = getClientSessionSnapshot()
      if (state.lifecycle === 'resolving' && !state.projectionReady) {
        // A failed initial shell/locale preview has not established readable
        // content or attempted writer acquisition. Retry that startup boundary
        // after acknowledgement instead of silently abandoning it as a reader.
        failStartupAttempt(startupAttemptId, failureCode, 'observer-ready')
        alertError(error)
        await waitAlert()
        if (
          !isClientSessionGenerationCurrent(attemptGeneration) ||
          !getClientSessionSnapshot().authenticated ||
          getClientSessionSnapshot().lifecycle !== 'resolving' ||
          error instanceof FatalBootstrapError
        ) {
          return null
        }
        return startupRetryTargetForMilestone('observer-ready')
      }
      if (state.lifecycle === 'recovering-writer' && state.connection === 'interrupted') {
        scheduleConnectedWriterResume()
      } else {
        demoteClientSession()
        await refreshConnectedReader()
      }
      failStartupAttempt(startupAttemptId, failureCode, 'writer-ready')
      recordStartupMilestone('background-ready')
      console.warn('Writer startup deferred while the read view remains available:', error)
      return null
    }
    const observerReady = observerShellEnabled && canRenderShell()
    const failureMilestone: StartupMilestone = observerReady ? 'writer-ready' : 'observer-ready'
    if (
      observerShellEnabled &&
      get(observerShellLifecycleStore).mode !== 'takeover-denied' &&
      get(observerShellLifecycleStore).mode !== 'auth-lost'
    ) {
      setObserverShellLifecycleMode('unavailable')
    }
    failStartupAttempt(startupAttemptId, failureCode, failureMilestone)
    if (observerReady) {
      console.warn('Writer startup deferred while the observer shell remains available:', error)
      return null
    }
    alertError(error)
    await waitAlert()
    if (error instanceof FatalBootstrapError) return null
    return startupRetryTargetForMilestone(failureMilestone)
  }
}

async function installConnectedReaderProjection(
  runtime: ServerBootstrapRuntime,
  generation: number,
  options: { subscribe?: boolean; full?: boolean } = {},
): Promise<void> {
  const isCurrent = () => isClientSessionGenerationCurrent(generation) && getClientSessionSnapshot().authenticated
  if (!isCurrent()) return
  setObserverShellLifecycleMode('waiting')
  LoadingStatusState.text = 'Loading Server Data...'
  const ownership = bootstrapOwnership(runtime)
  initializeDraftRecoveryScope({
    writerSessionId: getActiveWriterSessionId(),
    databaseLineage: ownership.databaseLineage,
  })
  configureGenerationOperationProtocol(runtime.generationOperationProtocol, runtime.databaseLineage)
  configureDisplaySourceProtocol(runtime.displaySourceProtocol, runtime.databaseLineage, runtime.writerEpoch)
  // A former writer can retain non-shell optimistic values and loaded flags.
  // Replace those with a coherent server snapshot before reader synchronization.
  const resources = options.full
    ? await refreshAllServerResources({ mode: 'reader', isCurrent })
    : await loadInitialServerResources({ isCurrent })
  if (!isCurrent()) return
  if (resources.status !== 'ok') {
    throw new Error(resources.status === 'error' ? resources.error : 'Server resources are unavailable')
  }
  resetChatHydration()
  resetLorebookHydration()
  setCachedServerCommandRevision(resources.revision)
  setAppliedServerResourceRevision(resources.revision)
  updateColorScheme()
  updateTextThemeAndCSS()
  updateReducedMotion()
  updateHeightMode()
  updateGuisize()
  void changeLanguage(settingsResourceState.value.language)
  await awaitLanguageReady()
  if (!isCurrent()) return
  setClientProjectionReady(true, generation)
  recordStartupMilestone('observer-ready')
  if (options.subscribe === false) return
  await connectReaderSession(generation)
}

/** Keep the reader stream current while an explicit takeover is being confirmed. */
async function connectReaderSession(generation: number): Promise<void> {
  const isCurrent = () => isClientSessionGenerationCurrent(generation) && getClientSessionSnapshot().authenticated
  if (!isCurrent()) return
  connectedReaderSync?.stop()
  connectedReaderSync = startConnectedReaderSync({
    onAuthLoss: async () => {
      if (isCurrent()) await discardObserverProjectionState('auth-loss')
    },
    onLineageChange: async (ownership) => {
      if (!isCurrent()) return
      const operation = beginClientSession(getActiveWriterSessionId())
      const { discardObserverProjectionState } = await import('./observerProjectionLifecycle')
      await discardObserverProjectionState('lineage-change')
      if (!isClientSessionOperationCurrent(operation)) return
      if (!settleClientReader(operation, ownership)) return
      await refreshConnectedReader()
    },
  })
  await connectedReaderSync.ready
}

async function recoverConnectedWriter(
  runtime: ServerBootstrapRuntime,
  operation: ClientSessionOperation,
): Promise<void> {
  const isCurrent = () => isClientSessionOperationCurrent(operation)
  if (!isCurrent()) throw new Error('Writer recovery was superseded')
  // A reader's former live stream is not proof that the writer transport has
  // been installed. Recovery must establish its own successful subscription.
  setClientConnectionState('connecting', operation.generation)
  beginWriterAccessRecovery()
  await loadWebInitialDatabase({ preparedBootstrap: runtime, isCurrent })
  if (!isCurrent()) throw new Error('Writer recovery was superseded')
  if (!serverResourceEventSubscription) throw new Error('Server event subscription is unavailable')
  if (!isCurrent() || !completeClientWriterRecovery(operation)) throw new Error('Writer recovery is incomplete')
  completeWriterAccessRecovery(true)
  restoreStartupWriterCapabilities()
}

/** An empty server needs an explicit action when this page cannot establish exclusivity. */
async function confirmConnectedServerInitialization(operation: ClientSessionOperation): Promise<boolean> {
  if (!isClientSessionOperationCurrent(operation)) return false
  const controller = new AbortController()
  const decision = { operation, controller }
  connectedInitializationDecision = decision
  const stop = clientSessionStore.subscribe(() => {
    if (!isClientSessionOperationCurrent(operation)) controller.abort()
  })
  try {
    const selection = await alertRequiredSelect(
      [language.connectedReaders.setupThisServer],
      language.connectedReaders.setupServerBody,
      language.connectedReaders.setupServerTitle,
      { signal: controller.signal },
    )
    return selection === '0' && !controller.signal.aborted && isClientSessionOperationCurrent(operation)
  } finally {
    stop()
    if (connectedInitializationDecision === decision) connectedInitializationDecision = null
  }
}

/** Reader re-entry never performs acquisition or touches dormant local intent. */
function refreshConnectedReader(): Promise<void> {
  const generation = captureClientSessionGeneration()
  if (connectedReaderRefresh?.generation === generation) return connectedReaderRefresh.promise
  const promise = (async () => {
    setClientConnectionState('connecting', generation)
    const result = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
    if (!isClientSessionGenerationCurrent(generation)) return
    if (result.status !== 'ok') {
      if (result.status === 'error' && result.httpStatus === 401) {
        if (isClientSessionGenerationCurrent(generation)) await discardObserverProjectionState('auth-loss')
        return
      }
      throw new Error(result.status === 'unavailable' ? 'Server bootstrap is unavailable' : result.error)
    }
    if (!result.bootstrap.initialized) throw new Error('Waiting for the server database to be initialized')
    const state = getClientSessionSnapshot()
    const ownership = bootstrapOwnership(result.bootstrap)
    if (state.databaseLineage !== ownership.databaseLineage) {
      const operation = beginClientSession(getActiveWriterSessionId())
      const { discardObserverProjectionState } = await import('./observerProjectionLifecycle')
      await discardObserverProjectionState('lineage-change')
      if (!settleClientReader(operation, ownership)) return
      await installConnectedReaderProjection(result.bootstrap, operation.generation, { full: true })
      return
    }
    if (!observeClientWriter(ownership.writer)) throw new Error('Reader ownership discovery was stale')
    await installConnectedReaderProjection(result.bootstrap, generation, { full: true })
    if (isClientSessionGenerationCurrent(generation)) connectedReaderRefreshAttempt = 0
  })()
    .catch((error) => {
      if (isClientSessionGenerationCurrent(generation)) {
        setClientConnectionState('interrupted', generation)
        scheduleConnectedReaderRefresh(generation)
      }
      console.warn('Reader refresh failed:', error)
    })
    .finally(() => {
      if (connectedReaderRefresh?.promise === promise) connectedReaderRefresh = null
    })
  connectedReaderRefresh = { generation, promise }
  return promise
}

function scheduleConnectedReaderRefresh(generation = captureClientSessionGeneration()): void {
  if (connectedReaderRefreshTimer || getClientSessionSnapshot().lifecycle !== 'reading' || browserIsOffline()) return
  connectedReaderRefreshTimer = setTimeout(() => {
    connectedReaderRefreshTimer = null
    if (isClientSessionGenerationCurrent(generation) && getClientSessionSnapshot().lifecycle === 'reading')
      void refreshConnectedReader()
  }, calculateServerResourceReconnectDelayMs(connectedReaderRefreshAttempt++))
}

function installConnectedSessionLifecycle(): void {
  if (stopConnectedSessionLifecycle) return
  let previous = getClientSessionSnapshot()
  stopConnectedSessionLifecycle = clientSessionStore.subscribe((state) => {
    const lostWriter =
      previous.managed &&
      ['writing', 'recovering-writer', 'promoting'].includes(previous.lifecycle) &&
      state.generation !== previous.generation
    previous = state
    if (!state.managed) return
    if (lostWriter || state.lifecycle === 'auth-required') {
      invalidateResourceCacheWork()
      stopFailedWriterPromotionRuntimes()
      stopDeferredStartupRuntimes()
      connectedReaderSync?.stop()
      connectedReaderSync = null
      if (connectedReaderRefreshTimer) clearTimeout(connectedReaderRefreshTimer)
      connectedReaderRefreshTimer = null
      if (state.lifecycle === 'reading') void refreshConnectedReader()
    }
  })
  if (typeof window !== 'undefined') {
    const offline = () => {
      if (!isClientSessionManaged()) return
      setClientConnectionState('interrupted')
      if (connectedWriterResumeTimer) clearTimeout(connectedWriterResumeTimer)
      connectedWriterResumeTimer = null
    }
    const online = () => {
      const state = getClientSessionSnapshot()
      if (!state.managed) return
      if (state.lifecycle === 'recovering-writer') void resumeConnectedWriter()
      else if (state.lifecycle === 'reading' && !connectedReaderSync) void refreshConnectedReader()
    }
    const pageHide = () => {
      if (getClientSessionSnapshot().lifecycle === 'resolving') demoteClientSession()
      setClientConnectionState('interrupted')
      stopFailedWriterPromotionRuntimes()
      connectedReaderSync?.stop()
      connectedReaderSync = null
      releaseConnectedTabIdentity()
    }
    const pageShow = (event: PageTransitionEvent) => {
      // A persisted page released its exclusivity. Reload preserves its URL and
      // draft stores while running discovery again before any write is admitted.
      if (event.persisted) window.location.reload()
    }
    window.addEventListener('pagehide', pageHide)
    window.addEventListener('pageshow', pageShow)
    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    stopConnectedPageLifecycle = () => {
      window.removeEventListener('pagehide', pageHide)
      window.removeEventListener('pageshow', pageShow)
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
    }
  }
}

function scheduleConnectedWriterResume(): void {
  if (
    browserIsOffline() ||
    getClientSessionSnapshot().lifecycle !== 'recovering-writer' ||
    connectedWriterResumeTimer ||
    connectedWriterResume
  )
    return
  const delay = calculateServerResourceReconnectDelayMs(connectedWriterResumeAttempt++)
  connectedWriterResumeTimer = setTimeout(() => {
    connectedWriterResumeTimer = null
    void resumeConnectedWriter()
  }, delay)
}

async function resumeConnectedWriter(): Promise<void> {
  if (browserIsOffline()) return
  if (connectedWriterResume) return connectedWriterResume
  const operation = beginClientWriterResume()
  if (!operation) return
  const running = (async () => {
    const result = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
    if (!isClientSessionOperationCurrent(operation)) return
    if (result.status !== 'ok') {
      if (result.status === 'error' && result.httpStatus === 401) {
        await discardObserverProjectionState('auth-loss')
        return
      }
      throw new Error(result.status === 'unavailable' ? 'Server is unavailable' : result.error)
    }
    const ownership = bootstrapOwnership(result.bootstrap)
    if (
      ownership.databaseLineage !== getClientSessionSnapshot().databaseLineage ||
      ownership.writer.sessionId !== getActiveWriterSessionId()
    ) {
      failClientSessionOperation(operation)
      await refreshConnectedReader()
      return
    }
    // Resume is conditional as well: a writer change between this read and
    // recovery must never turn reconnection into a takeover.
    const verified = await fetchServerBootstrap(null, {
      expectedWriter: { epoch: ownership.writer.epoch, databaseLineage: ownership.databaseLineage },
    })
    if (!isClientSessionOperationCurrent(operation)) return
    if (verified.status !== 'ok') {
      if (verified.status === 'error' && verified.httpStatus === 401) {
        await discardObserverProjectionState('auth-loss')
        return
      }
      failClientSessionOperation(operation)
      await refreshConnectedReader()
      return
    }
    if (!authorizeClientWriterRecovery(operation, bootstrapOwnership(verified.bootstrap))) return
    await recoverConnectedWriter(verified.bootstrap, operation)
    connectedWriterResumeAttempt = 0
    await settleConnectedWriterStartup(operation)
  })()
    .catch((error) => {
      if (isClientSessionGenerationCurrent(operation.generation)) setClientConnectionState('interrupted')
      console.warn('Writer reconnection failed:', error)
    })
    .finally(() => {
      if (connectedWriterResume === running) connectedWriterResume = null
      scheduleConnectedWriterResume()
    })
  connectedWriterResume = running
  return running
}

async function settleConnectedWriterStartup(operation: ClientSessionOperation): Promise<void> {
  const isCurrent = () => isClientSessionGenerationCurrent(operation.generation) && canUseClientWriteAccess()
  if (!isCurrent()) return
  const startupAttemptId = beginStartupAttempt()
  startSelectedCharacterShellHydration()
  startChatMessageHydration()
  const pluginReady = await settleStartupPluginRuntime(startupAttemptId)
  if (!isCurrent()) return
  if (pluginReady) await settleStartupGenerationRecovery(startupAttemptId)
  if (!isCurrent()) return
  try {
    await ensureStartupChatReadiness()
    if (!isCurrent()) return
    settleStartupChatReadiness(true)
  } catch (error) {
    if (!isCurrent()) return
    const failure = error instanceof StartupChatDependencyError ? error.failureCode : 'selected-chat-hydration-failed'
    recordStartupCapabilityFailure(startupAttemptId, failure, 'chat-ready')
    settleStartupChatReadiness(false)
  }
  startStartupChatReadinessSync(startupAttemptId)
  await settleStartupBackgroundReadiness(startupAttemptId)
  if (!isCurrent()) return
  recordStartupMilestone('background-ready')
  completeStartupAttempt(startupAttemptId)
}

export type ConnectedWriterPromotionResult =
  | { status: 'promoted' }
  | { status: 'cancelled' | 'superseded' }
  | { status: 'failed'; reason: 'interrupted' | 'retained-work' | 'unavailable' }

/** One explicit switch; reconnect and ordinary reads never call this acquisition path. */
export function promoteConnectedReader(): Promise<ConnectedWriterPromotionResult> {
  if (connectedWriterPromotion && isClientSessionGenerationCurrent(connectedWriterPromotion.operation.generation))
    return connectedWriterPromotion.promise
  const operation = beginClientPromotion()
  if (!operation)
    return Promise.resolve({
      status: 'failed',
      reason: browserIsOffline() || getClientSessionSnapshot().connection !== 'live' ? 'interrupted' : 'unavailable',
    })

  const controller = new AbortController()
  let interrupted = false
  const stopOperation = clientSessionStore.subscribe((state) => {
    if (state.generation !== operation.generation) {
      if (state.connection === 'interrupted') interrupted = true
      controller.abort()
    }
  })
  if (connectedReaderRefreshTimer) clearTimeout(connectedReaderRefreshTimer)
  connectedReaderRefreshTimer = null
  const current = () => isClientSessionOperationCurrent(operation)
  const superseded = (): ConnectedWriterPromotionResult =>
    interrupted ? { status: 'failed', reason: 'interrupted' } : { status: 'superseded' }
  const returnToReader = (result: ConnectedWriterPromotionResult): ConnectedWriterPromotionResult => {
    if (!isClientSessionGenerationCurrent(operation.generation)) return superseded()
    const state = getClientSessionSnapshot()
    if (state.lifecycle === 'recovering-writer' || state.lifecycle === 'writing') completeWriterAccessRecovery(false)
    if (!failClientSessionOperation(operation)) demoteClientSession()
    // The lifecycle subscription also starts this refresh after demotion. Its
    // generation-scoped promise deduplicates both callers without delaying the
    // user's cancellation/failure result on another network operation.
    void refreshConnectedReader()
    return result
  }

  const running = (async (): Promise<ConnectedWriterPromotionResult> => {
    // Promotion advances the generation, so replace its old read stream while
    // keeping the coherent projection and the reader's local route available.
    await connectReaderSession(operation.generation)
    if (!current()) return superseded()
    const discovered = await fetchServerBootstrapReadOnly(controller.signal, { cacheRevision: false })
    if (!current()) return superseded()
    if (discovered.status !== 'ok') {
      if (discovered.status === 'error' && discovered.httpStatus === 401) {
        await discardObserverProjectionState('auth-loss')
        return { status: 'failed', reason: 'unavailable' }
      }
      throw new Error(discovered.status === 'unavailable' ? 'Server is unavailable' : discovered.error)
    }
    const ownership = bootstrapOwnership(discovered.bootstrap)
    if (ownership.databaseLineage !== getClientSessionSnapshot().databaseLineage) {
      const replacement = beginClientSession(getActiveWriterSessionId())
      await discardObserverProjectionState('lineage-change')
      if (settleClientReader(replacement, ownership)) void refreshConnectedReader()
      return { status: 'superseded' }
    }
    if (!observeClientWriter(ownership.writer)) return returnToReader({ status: 'failed', reason: 'unavailable' })
    if (!current()) return superseded()
    if (!discovered.bootstrap.initialized) throw new Error('The server database is not initialized')
    const expectedWriter = { epoch: ownership.writer.epoch, databaseLineage: ownership.databaseLineage }
    let acquired = await fetchServerBootstrap(controller.signal, { expectedWriter })
    if (!current()) return superseded()
    if (acquired.status === 'active-writer-connected') {
      const selection = await alertRequiredSelect(
        [language.writerConnectDisconnectExisting, language.cancel],
        language.writerConnectConflictBody,
        language.writerConnectConflictTitle,
        { signal: controller.signal },
      )
      if (!current()) return superseded()
      if (selection !== '0') return returnToReader({ status: 'cancelled' })
      acquired = await fetchServerBootstrap(controller.signal, { expectedWriter, disconnectExistingWriter: true })
      if (!current()) return superseded()
    }
    if (acquired.status !== 'ok') {
      if (acquired.status === 'error' && acquired.httpStatus === 401) {
        await discardObserverProjectionState('auth-loss')
        return { status: 'failed', reason: 'unavailable' }
      }
      return returnToReader({ status: 'failed', reason: 'unavailable' })
    }
    if (!authorizeClientWriterRecovery(operation, bootstrapOwnership(acquired.bootstrap)))
      return returnToReader({ status: 'failed', reason: 'unavailable' })
    connectedReaderSync?.stop()
    connectedReaderSync = null
    await recoverConnectedWriter(acquired.bootstrap, operation)
    await settleConnectedWriterStartup(operation)
    return isClientSessionGenerationCurrent(operation.generation) && canUseClientWriteAccess()
      ? { status: 'promoted' }
      : superseded()
  })()
    .catch((error): ConnectedWriterPromotionResult => {
      if (!isClientSessionGenerationCurrent(operation.generation)) return superseded()
      console.warn('Explicit writer switch failed:', error)
      return returnToReader({
        status: 'failed',
        reason:
          error instanceof RetainedWriterRecoveryError
            ? 'retained-work'
            : browserIsOffline() || getClientSessionSnapshot().connection === 'interrupted'
              ? 'interrupted'
              : 'unavailable',
      })
    })
    .finally(() => {
      stopOperation()
      if (connectedWriterPromotion?.promise === running) connectedWriterPromotion = null
    })
  connectedWriterPromotion = { operation, controller, promise: running }
  return running
}

function browserIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** Idempotent targeted takeover/recovery used by the permanent observer UI. */
export function retryObserverWriterPromotion(): Promise<boolean> {
  if (isClientSessionManaged()) return Promise.resolve(false)
  if (observerWriterPromotionRetryInFlight) return observerWriterPromotionRetryInFlight

  const retry = (async () => {
    setObserverShellLifecycleMode('retrying')
    if (!backgroundReady()) {
      await loadData()
      return canMutate()
    }

    const startupAttemptId = beginStartupAttempt()
    const recoveringLostWriter = beginWriterAccessRecovery()
    try {
      await loadWebInitialDatabase()
      if (!serverResourceEventSubscription) {
        throw new Error('Server event subscription is unavailable')
      }
      startSelectedCharacterShellHydration()
      startChatMessageHydration()
      try {
        await ensureStartupChatReadiness()
        settleStartupChatReadiness(true)
      } catch (error) {
        const dependencyError =
          error instanceof StartupChatDependencyError
            ? error
            : new StartupChatDependencyError('selected-chat-hydration-failed', 'Selected chat hydration failed')
        recordStartupCapabilityFailure(startupAttemptId, dependencyError.failureCode, 'chat-ready')
        settleStartupChatReadiness(false)
      }
      startStartupChatReadinessSync(startupAttemptId)
      restoreStartupWriterCapabilities()
      if (recoveringLostWriter) completeWriterAccessRecovery(true)
      setObserverShellLifecycleMode('promoted')
      completeStartupAttempt(startupAttemptId)
      return canMutate()
    } catch (error) {
      stopFailedWriterPromotionRuntimes()
      if (recoveringLostWriter) completeWriterAccessRecovery(false)
      setObserverShellLifecycleMode('unavailable')
      failStartupAttempt(startupAttemptId, 'writer-bootstrap-failed', 'writer-ready')
      console.warn('Observer writer promotion retry failed:', error)
      return false
    }
  })().finally(() => {
    if (observerWriterPromotionRetryInFlight === retry) observerWriterPromotionRetryInFlight = null
  })

  observerWriterPromotionRetryInFlight = retry
  return retry
}

function stopFailedWriterPromotionRuntimes(): void {
  startupChatReattachReady = false
  startupGenerationRecoveryReady = false
  stopServerResourceEvents()
  stopActiveMessageTranslationRefresh()
  stopActiveGreetingTranslationRefresh()
  stopActiveGenerationReattach()
  stopGenerationFinalizationPersistenceRefresh()
  stopChatMessageHydration()
}

/** Dispose the connected page coordinator in app/test teardown. */
export function stopConnectedClientServices(): void {
  stopConnectedSessionLifecycle?.()
  stopConnectedSessionLifecycle = null
  if (connectedInitializationDecision) {
    connectedInitializationDecision.controller.abort()
    failClientSessionOperation(connectedInitializationDecision.operation)
    connectedInitializationDecision = null
  }
  if (connectedWriterPromotion) {
    connectedWriterPromotion.controller.abort()
    if (isClientSessionGenerationCurrent(connectedWriterPromotion.operation.generation)) {
      if (!failClientSessionOperation(connectedWriterPromotion.operation)) demoteClientSession()
      stopFailedWriterPromotionRuntimes()
      stopDeferredStartupRuntimes()
    }
    connectedWriterPromotion = null
  }
  stopConnectedPageLifecycle?.()
  stopConnectedPageLifecycle = null
  connectedReaderSync?.stop()
  connectedReaderSync = null
  if (connectedWriterResumeTimer) clearTimeout(connectedWriterResumeTimer)
  connectedWriterResumeTimer = null
  connectedWriterResumeAttempt = 0
  if (connectedReaderRefreshTimer) clearTimeout(connectedReaderRefreshTimer)
  connectedReaderRefreshTimer = null
  connectedReaderRefreshAttempt = 0
  releaseConnectedTabIdentity()
}

export function retryConnectedAuthentication(): Promise<void> {
  if (connectedAuthenticationRetry) return connectedAuthenticationRetry
  const generation = captureClientSessionGeneration()
  if (getClientSessionSnapshot().lifecycle !== 'auth-required') return Promise.resolve()
  const running = (async () => {
    const auth = await import('./storage/fastifyStorage')
    if (!isClientSessionGenerationCurrent(generation)) return
    auth.invalidateNodeServerProxyAuth()
    await auth.getNodeServerProxyAuth()
    if (!isClientSessionGenerationCurrent(generation)) return
    await runLoadDataAttempt()
  })().finally(() => {
    if (connectedAuthenticationRetry === running) connectedAuthenticationRetry = null
  })
  connectedAuthenticationRetry = running
  return running
}

async function settleStartupPluginRuntime(startupAttemptId: number): Promise<boolean> {
  const generation = captureClientSessionGeneration()
  const assertCurrent = () => {
    if (!isClientSessionGenerationCurrent(generation) || !canUseClientWriteAccess())
      throw new Error('Plugin startup was superseded')
  }
  LoadingStatusState.text = 'Loading Plugins...'
  try {
    await runStartupStep('plugin-runtime', async () => {
      await ensureResourceSurfaces(['runtime:plugins'])
      assertCurrent()
      await loadPlugins()
      assertCurrent()
      startPluginRuntimeSync()
      recordStartupMilestone('plugins-ready')
    })
    return true
  } catch (error) {
    if (!isClientSessionGenerationCurrent(generation)) return false
    startupGenerationRecoveryReady = false
    settleStartupGenerationRecoveryReadiness(false)
    recordStartupCapabilityFailure(startupAttemptId, 'plugin-initialization-failed', 'plugins-ready')
    console.warn('Plugin runtime initialization failed:', error)
    return false
  }
}

async function settleStartupGenerationRecovery(
  startupAttemptId: number,
  recovery: () => Promise<void> = reconcilePendingRecoveredGenerationEffects,
): Promise<boolean> {
  const generation = captureClientSessionGeneration()
  if (!canUseClientWriteAccess()) return false
  startupGenerationRecoveryReady = false
  try {
    await runStartupStep('generation-recovery', recovery)
    if (!isClientSessionGenerationCurrent(generation) || !canUseClientWriteAccess()) return false
    startupGenerationRecoveryReady = true
    settleStartupGenerationRecoveryReadiness(true)
    return true
  } catch (error) {
    if (!isClientSessionGenerationCurrent(generation)) return false
    startupGenerationRecoveryReady = false
    settleStartupGenerationRecoveryReadiness(false)
    recordStartupCapabilityFailure(startupAttemptId, 'generation-recovery-failed', 'chat-ready')
    console.warn('Generation recovery initialization failed:', error)
    return false
  }
}

/** Targeted retry for a localized generation-recovery startup failure. */
export function retryGenerationRecoveryStartup(): Promise<boolean> {
  return retryStartupCapability('canGenerate', async () => {
    const startupAttemptId = beginStartupAttempt()
    const generationRecoveryReady = await settleStartupGenerationRecovery(startupAttemptId)
    completeStartupAttempt(startupAttemptId)
    return generationRecoveryReady
  })
}

/** Permanently skip unfinished recovered effects and reopen generation. */
export function discardGenerationRecoveryStartup(): Promise<boolean> {
  return retryStartupCapability('canGenerate', async () => {
    const startupAttemptId = beginStartupAttempt()
    const generationRecoveryReady = await settleStartupGenerationRecovery(
      startupAttemptId,
      discardPendingRecoveredGenerationEffects,
    )
    completeStartupAttempt(startupAttemptId)
    return generationRecoveryReady
  })
}

/** Localized retry used by the plugin-readiness status surface. */
export function retryPluginStartup(): Promise<boolean> {
  return retryStartupCapability('pluginsReady', async () => {
    const startupAttemptId = beginStartupAttempt()
    const pluginRuntimeReady = await settleStartupPluginRuntime(startupAttemptId)
    if (!pluginRuntimeReady) {
      completeStartupAttempt(startupAttemptId)
      return false
    }

    const generationRecoveryReady = await settleStartupGenerationRecovery(startupAttemptId)
    if (generationRecoveryReady) {
      try {
        await runStartupStep('chat-readiness', ensureStartupChatReadiness)
        settleStartupChatReadiness(true)
      } catch (error) {
        const dependencyError =
          error instanceof StartupChatDependencyError
            ? error
            : new StartupChatDependencyError('selected-chat-hydration-failed', 'Selected chat hydration failed')
        recordStartupCapabilityFailure(startupAttemptId, dependencyError.failureCode, 'chat-ready')
        settleStartupChatReadiness(false)
      }
    }
    completeStartupAttempt(startupAttemptId)
    return generationRecoveryReady
  })
}

async function settleStartupBackgroundReadiness(startupAttemptId: number): Promise<void> {
  const generation = captureClientSessionGeneration()
  const assertCurrent = () => {
    if (!isClientSessionGenerationCurrent(generation) || !canUseClientWriteAccess())
      throw new Error('Background startup was superseded')
  }
  const resourceReadiness = ensureResourceSurfaces(['runtime:background-effects'])
  const results = await Promise.allSettled([
    runStartupStep('push-runtime', async () => {
      await resourceReadiness
      assertCurrent()
      const pushRuntime = await import('./server/pushNotificationSetting')
      assertCurrent()
      stopPushRuntime ??= pushRuntime.stopPushNotificationCoordinator
      const { initializePushNotificationCoordinator, reconcileChatCompletionPushNotificationSetting } = pushRuntime
      await initializePushNotificationCoordinator()
      assertCurrent()
      await reconcileChatCompletionPushNotificationSetting(settingsResourceState.value.notification === true)
    }),
    runStartupStep('background-runtime', async () => {
      await resourceReadiness
      assertCurrent()
      LoadingStatusState.text = 'Checking For Format Update...'

      LoadingStatusState.text = 'Updating States...'
      updateErrorHandling()
      if (!localStorage.getItem('nightlyWarned') && window.location.hostname === 'nightly.risuai.xyz') {
        alertMd(language.nightlyWarning)
        await waitAlert()
        //for testing, leave empty
        localStorage.setItem('nightlyWarned', '')
      }
      if (window.isSecureContext === false && localStorage.getItem('insecureOriginWarned') === null) {
        alertMd(language.insecureOriginWarning)
        await waitAlert()
        localStorage.setItem('insecureOriginWarned', 'true')
      }
      const [runtimeEffects, observer, modelList, modules, customBackground, legacyMemoryNotice] = await Promise.all([
        import('./stores/runtimeEffects.svelte'),
        import('./observer.svelte'),
        import('./model/modellist'),
        import('./process/modules'),
        import('./server/customBackgroundSetting'),
        import('./process/legacyMemoryMigrationNotice'),
      ])
      assertCurrent()
      stopStoreRuntimeEffects ??= runtimeEffects.installStoreRuntimeEffects()
      stopDomObserver ??= observer.startObserveDom()
      customBackground.normalizeLegacyCustomBackgroundSetting()
      legacyMemoryNotice.showLegacyMemoryMigrationNoticeIfNeeded()
      const settings = settingsResourceState.status === 'ready' ? settingsResourceState.value : {}
      await modelList.registerModelDynamic({
        dynamicModelRegistry: settings.dynamicModelRegistry,
        googleAccessToken: settings.google?.accessToken,
        claudeAPIKey: settings.claudeAPIKey,
      })
      assertCurrent()
      modules.moduleUpdate()
    }),
  ])

  if (!isClientSessionGenerationCurrent(generation)) return

  const labels = ['push runtime', 'optional background runtime'] as const
  const failureCodes: StartupAttemptFailureCode[] = ['push-initialization-failed', 'runtime-initialization-failed']
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      recordStartupCapabilityFailure(startupAttemptId, failureCodes[index]!, 'background-ready')
      console.warn(`Failed to initialize ${labels[index]}:`, result.reason)
    }
  })
}

/** App/remount cleanup for optional and plugin runtimes that may outlive SSE. */
export function stopDeferredStartupRuntimes(): void {
  stopGlobalErrorHandlers?.()
  stopGlobalErrorHandlers = null
  stopStoreRuntimeEffects?.()
  stopStoreRuntimeEffects = null
  stopDomObserver?.()
  stopDomObserver = null
  stopPushRuntime?.()
  stopPushRuntime = null
  stopPluginRuntimeSync()
  stopRouteResourceLoader()
}

async function reconcileProjectedPushNotificationSetting(enabled: boolean): Promise<void> {
  try {
    const pushRuntime = await import('./server/pushNotificationSetting')
    stopPushRuntime ??= pushRuntime.stopPushNotificationCoordinator
    await pushRuntime.reconcileChatCompletionPushNotificationSetting(enabled)
  } catch (error) {
    console.warn('Failed to reconcile projected push notification setting:', error)
  }
}

async function ensureStartupChatReadiness(): Promise<void> {
  const generation = captureClientSessionGeneration()
  const assertCurrent = () => {
    if (!isClientSessionGenerationCurrent(generation) || !canUseClientWriteAccess())
      throw new Error('Chat startup was superseded')
  }
  assertCurrent()
  startupChatReattachReady = false
  // Initial recovery installs selection synchronization only after this work
  // settles. A restored reader route can change its target in the meantime;
  // evaluate that new target instead of losing the change or certifying the old one.
  while (true) {
    const target = currentStartupChatReadinessTarget()
    const evaluationId = beginStartupChatReadinessEvaluation(generation, target)
    try {
      try {
        await ensureResourceSurfaces(['runtime:chat-generation'])
        assertCurrent()
        if (target !== currentStartupChatReadinessTarget()) continue
        advanceStartupChatReadinessEvaluation(evaluationId, 'character')
        const characterHydrated = await hydrateSelectedCharacterShell()
        assertCurrent()
        if (target !== currentStartupChatReadinessTarget()) continue
        if (!characterHydrated) {
          throw new StartupChatDependencyError(
            'selected-character-hydration-failed',
            'Selected character detail hydration failed',
          )
        }
        const promptPresetId = currentStartupPromptTemplateOwnerId()
        advanceStartupChatReadinessEvaluation(evaluationId, 'chat-and-prompt')
        const [chatHydrated, promptHydrated] = await Promise.all([
          hydrateActiveChat(),
          ensurePromptTemplateHydrated({
            ...(promptPresetId !== currentGlobalPromptTemplateOwnerId() ? { applyProjection: false } : {}),
            promptPresetId,
            minimumRevision: peekAppliedServerResourceRevision() ?? undefined,
          }),
        ])
        assertCurrent()
        if (target !== currentStartupChatReadinessTarget()) continue
        if (!chatHydrated) {
          throw new StartupChatDependencyError('selected-chat-hydration-failed', 'Selected chat hydration failed')
        }
        if (!promptHydrated) {
          throw new StartupChatDependencyError(
            'selected-prompt-template-hydration-failed',
            'Selected prompt-template owner hydration failed',
          )
        }
      } catch (error) {
        assertCurrent()
        if (target !== currentStartupChatReadinessTarget()) continue
        throw error
      }
      startupChatReattachReady = true
      advanceStartupChatReadinessEvaluation(evaluationId, 'reattach')
      startActiveGenerationReattach()
      await prepareOpenChatGenerationReattach()
      assertCurrent()
      if (target === currentStartupChatReadinessTarget()) return
      startupChatReattachReady = false
    } finally {
      finishStartupChatReadinessEvaluation(evaluationId)
    }
  }
}

function startStartupChatReadinessSync(startupAttemptId: number): void {
  if (stopStartupChatReadinessSync) return
  startupChatReadinessTarget = currentStartupChatReadinessTarget()
  const refreshReadiness = (options: { force?: boolean } = {}) => {
    const target = currentStartupChatReadinessTarget()
    if (!options.force && target === startupChatReadinessTarget) return
    startupChatReadinessTarget = target
    const readinessEpoch = startupChatReadinessEpoch + 1
    startupChatReadinessEpoch = readinessEpoch
    settleStartupChatReadiness(false)
    void ensureStartupChatReadiness()
      .then(() => {
        if (readinessEpoch === startupChatReadinessEpoch) settleStartupChatReadiness(true)
      })
      .catch((error) => {
        if (readinessEpoch !== startupChatReadinessEpoch) return
        const dependencyError =
          error instanceof StartupChatDependencyError
            ? error
            : new StartupChatDependencyError('selected-chat-hydration-failed', 'Selected chat hydration failed')
        recordStartupCapabilityFailure(startupAttemptId, dependencyError.failureCode, 'chat-ready')
        console.warn(dependencyError.message)
      })
  }
  let initialEmission = true
  const stopSelectedCharacterSync = selectedCharID.subscribe(() => {
    if (initialEmission) {
      initialEmission = false
      return
    }
    refreshReadiness()
  })
  let initialRouteEmission = true
  const stopRouteSync = currentRoute.subscribe(() => {
    if (initialRouteEmission) {
      initialRouteEmission = false
      return
    }
    refreshReadiness()
  })
  setActiveChatReadinessRefreshHook(refreshReadiness)
  stopStartupChatReadinessSync = () => {
    stopSelectedCharacterSync()
    stopRouteSync()
    setActiveChatReadinessRefreshHook(null)
    startupChatReadinessTarget = null
  }
}

function currentStartupChatReadinessTarget(): string {
  const route = get(currentRoute)
  const selectedIndex = get(selectedCharID)
  const character = charactersResourceState.characters[selectedIndex]
  const chatId = character?.chats?.[character?.chatPage ?? 0]?.id
  const promptPresetId = currentStartupPromptTemplateOwnerId()
  return `${route.kind}\u0000${route.path}\u0000${selectedIndex}\u0000${character?.chaId ?? ''}\u0000${chatId ?? ''}\u0000${promptPresetId ?? ''}`
}

function currentStartupPromptTemplateOwnerId(): string | null {
  const selectedIndex = get(selectedCharID)
  const character = charactersResourceState.characters[selectedIndex]
  const chat = character?.chats?.[character?.chatPage ?? 0]
  const chatPromptPresetId = chat?.generationSettings?.promptPresetId
  if (typeof chatPromptPresetId === 'string' && chatPromptPresetId.trim() !== '') {
    return chatPromptPresetId.trim()
  }

  return currentGlobalPromptTemplateOwnerId()
}

export function currentGlobalPromptTemplateOwnerId(): string | null {
  const promptPresets = collectionsResourceState.values.promptPresets
  const selectedPromptPresetIndex = settingsResourceState.value.promptPresetsId
  if (!Number.isInteger(selectedPromptPresetIndex) || selectedPromptPresetIndex < 0) return null
  if (!Array.isArray(promptPresets)) return null
  const selectedPromptPreset = promptPresets[selectedPromptPresetIndex]
  const selectedPromptPresetId = selectedPromptPreset?.id
  if (typeof selectedPromptPresetId !== 'string' || selectedPromptPresetId.trim() === '') return null
  return resolveUniquePromptPreset(promptPresets, selectedPromptPresetId)?.id ?? null
}

export async function loadWebInitialDatabase(
  options: {
    coordinated?: boolean
    preparedBootstrap?: ServerBootstrapRuntime
    isCurrent?: () => boolean
  } = {},
) {
  const coordinate: typeof runStartupStep = options.coordinated
    ? runStartupStep
    : (_step, operation) => Promise.resolve().then(operation)
  const assertCurrent = () => {
    if (options.isCurrent && !options.isCurrent()) throw new Error('Writer recovery was superseded')
  }
  const runWriterStep: typeof runStartupStep = (step, operation) =>
    coordinate(step, async () => {
      assertCurrent()
      const result = await operation()
      assertCurrent()
      return result
    })
  LoadingStatusState.text = 'Loading Server Data...'
  if (!options.preparedBootstrap)
    await runWriterStep('writer-owner-adoption', async () => {
      const pendingMutationOwner = await readSinglePendingMutationOwner()
      if (pendingMutationOwner) {
        adoptPendingMutationWriterSessionId(pendingMutationOwner.writerSessionId)
      }
    })
  const firstBootstrap = options.preparedBootstrap
    ? { status: 'ok' as const, bootstrap: options.preparedBootstrap }
    : await runWriterStep('writer-bootstrap', async () => {
        let result = await fetchServerBootstrap()
        if (result.status === 'active-writer-connected') {
          const selection = await alertRequiredSelect(
            [language.writerConnectDisconnectExisting, language.cancel],
            language.writerConnectConflictBody,
            language.writerConnectConflictTitle,
          )
          if (selection !== '0') {
            setObserverShellLifecycleMode('takeover-denied')
            throw new FatalBootstrapError(language.writerConnectCancelled)
          }
          result = await fetchServerBootstrap(null, { disconnectExistingWriter: true })
        }
        if (result.status !== 'ok') {
          throw new Error(result.status === 'unavailable' ? 'Server bootstrap is unavailable' : result.error)
        }
        return result
      })
  const runtime = await runWriterStep('writer-initialize', () =>
    firstBootstrap.bootstrap.initialized
      ? firstBootstrap.bootstrap
      : initializeFreshServerDatabase(firstBootstrap.bootstrap),
  )
  configureGenerationOperationProtocol(runtime.generationOperationProtocol, runtime.databaseLineage)
  configureDisplaySourceProtocol(runtime.displaySourceProtocol, runtime.databaseLineage, runtime.writerEpoch)

  const { databaseLineage, requestedWriterWasActive, writerEpoch } = firstBootstrap.bootstrap
  if (
    !databaseLineage ||
    typeof requestedWriterWasActive !== 'boolean' ||
    typeof writerEpoch !== 'number' ||
    !Number.isSafeInteger(writerEpoch)
  ) {
    throw new Error('Server bootstrap is missing durable mutation ownership metadata')
  }
  initializeDraftRecoveryScope({
    writerSessionId: getActiveWriterSessionId(),
    databaseLineage,
  })
  await runWriterStep('writer-outbox-prepare', async () => {
    const pendingMutationPreparation = await preparePendingMutationOutbox({
      writerSessionId: getActiveWriterSessionId(),
      writerEpoch,
      databaseLineage,
      requestedWriterWasActive,
    })
    if (pendingMutationPreparation.discarded > 0) {
      alertError(language.pendingMutationDiscarded)
    }
  })
  await runWriterStep('writer-receipt-flush', flushPendingMutationReceiptAcknowledgements)
  await runWriterStep('writer-pending-replay', async () => {
    const pendingMutationReplay = await replayPendingMutations()
    const remainingPendingMutationRecords = await countBlockingPendingMutationRecords()
    if (
      pendingMutationReplay.retained > 0 ||
      remainingPendingMutationRecords === null ||
      remainingPendingMutationRecords > 0
    ) {
      throw new RetainedWriterRecoveryError(language.pendingMutationReplayRetained)
    }
  })

  const resources = await runWriterStep('writer-resource-hydration', async () => {
    // From this point on the explicit resource owners are authoritative.
    // Hydration and reconciliation apply only through those owner boundaries.
    const result = await loadInitialServerResources({
      hooks: serverResourceInvalidationHooks,
      ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
    })
    if (result.status !== 'ok') {
      throw new Error(
        result.status === 'unavailable'
          ? 'Server resource APIs are unavailable'
          : `Server resource load failed: ${result.error}`,
      )
    }
    return result
  })

  await runWriterStep('writer-projection-install', async () => {
    selectedCharID.set(initialSelectedCharacterIndex())
    resetChatHydration()
    resetLorebookHydration()
    recordHydratedCharacterLorebooks(charactersResourceState.characters)
    setCachedServerCommandRevision(resources.revision)
    setAppliedServerResourceRevision(resources.revision)
    markReplacementDatabaseOwnershipRefreshed({ databaseLineage, writerEpoch })
    setServerCommandSuccessReconciler((event, coalescedEvents, localEffects) =>
      enqueueServerResourceSync(() =>
        processServerCommandEvents(coalescedEvents.length > 0 ? coalescedEvents : [event], localEffects),
      ),
    )
    setServerCommandConflictGapHandler(handleServerCommandConflictGap)
    // The conservative shell boundary is writer-ready, so every visual and
    // selection input used by the root UI must be coherent before events can
    // publish that capability.
    updateColorScheme()
    updateTextThemeAndCSS()
    updateReducedMotion()
    updateHeightMode()
    updateGuisize()
    if (settingsResourceState.value.botSettingAtStart) botMakerMode.set(true)
    void changeLanguage(settingsResourceState.value.language)
    await awaitLanguageReady()
    assertCurrent()
    if (isClientSessionManaged()) setClientProjectionReady(true)
    recordStartupMilestone('observer-ready')
  })
  await runWriterStep('writer-runtime-services', () => {
    applyGenerationOperationBootstrap(runtime, 'startup')
    setPendingRecoveredGenerationEffects(runtime.pendingGenerationEffects ?? [])
    setGenerationFinalizationPersistences(runtime.generationFinalizations ?? [])
    startGenerationFinalizationPersistenceRefresh()
    setActiveMessageTranslations(runtime.activeMessageTranslations ?? [])
    setActiveGreetingTranslations(runtime.activeGreetingTranslations ?? [])
    startActiveMessageTranslationRefresh()
    startActiveGreetingTranslationRefresh()
    stopOwnerMutationLifecycleFlush?.()
    stopOwnerMutationLifecycleFlush = startOwnerMutationLifecycleFlush()
  })
  await runWriterStep('writer-event-subscription', async () => {
    serverResourceRuntimeReplayEnabled = false
    try {
      await startServerResourceEvents({ replayPendingMutations: false })
    } finally {
      serverResourceRuntimeReplayEnabled = true
    }
  })
}

/**
 * One-time first-run seed. The initialize response supplies the new revision,
 * so the pre-initialize runtime metadata remains valid when this client wins
 * the initialization race. A read-only bootstrap retry is only needed when a
 * different client initialized the database first.
 */
async function initializeFreshServerDatabase(initialRuntime: ServerBootstrapRuntime): Promise<ServerBootstrapRuntime> {
  const result = await initializeServerDatabaseForBootstrap()
  if (result.status === 'ok') {
    setCachedServerCommandRevision(result.revision)
    if (result.initialized === true) {
      return {
        ...initialRuntime,
        initialized: true,
        revision: result.revision,
      }
    }

    const bootstrap = await fetchServerBootstrapReadOnly()
    if (bootstrap.status !== 'ok') {
      throw new Error(bootstrap.status === 'unavailable' ? 'Server bootstrap is unavailable' : bootstrap.error)
    }
    if (!bootstrap.bootstrap.initialized) {
      throw new Error('Initial server database seed failed: server is still uninitialized')
    }
    return bootstrap.bootstrap
  }

  if (result.status === 'error' && result.reason === 'initialize-conflict') {
    throw new FatalBootstrapError(language.serverDatabaseDamaged)
  }

  throw new Error(`Initial server database seed failed: ${serverCommandFailureMessage(result)}`)
}

function serverCommandFailureMessage(
  result: Exclude<Awaited<ReturnType<typeof initializeServerDatabaseForBootstrap>>, { status: 'ok' }>,
): string {
  switch (result.status) {
    case 'conflict':
      return `revision conflict at ${result.currentRevision}`
    case 'error':
      return result.error
    case 'unavailable':
      return 'server commands unavailable'
  }
}

export function stopServerResourceEvents() {
  serverResourceEventsDesired = false
  serverResourceRuntimeReplayEnabled = false
  serverResourceEventEpoch += 1
  teardownServerResourceSubscription()
  stopServerResourceRecoveryListeners?.()
  stopServerResourceRecoveryListeners = null
  stopOwnerMutationLifecycleFlush?.()
  stopOwnerMutationLifecycleFlush = null
  stopStartupChatReadinessSync?.()
  stopStartupChatReadinessSync = null
  setActiveChatReadinessRefreshHook(null)
  startupChatReadinessTarget = null
  startupChatReadinessEpoch += 1
  setServerCommandSuccessReconciler(null)
  setServerCommandConflictGapHandler(null)
  stopSelectedCharacterShellHydration()
  if (serverResourceReconnectTimer) {
    clearTimeout(serverResourceReconnectTimer)
    serverResourceReconnectTimer = null
  }
  serverResourceReconnectAttempt = 0
}

async function startServerResourceEvents(options: { replayPendingMutations?: boolean } = {}) {
  const eventEpoch = serverResourceEventEpoch + 1
  serverResourceEventEpoch = eventEpoch
  teardownServerResourceSubscription()
  serverResourceEventsDesired = true
  ensureServerResourceRecoveryListeners()
  const subscription = await subscribeServerCommandEvents({
    sinceRevision: peekAppliedServerResourceRevision(),
    onCommandEvent: (event) => {
      if (isCurrentServerResourceEventEpoch(eventEpoch)) handleServerCommandEvent(event)
    },
    onMemoryEvent: (event) => {
      if (isCurrentServerResourceEventEpoch(eventEpoch)) applyServerMemoryEvent(event)
    },
    onBardWikiEvent: (event) => {
      if (isCurrentServerResourceEventEpoch(eventEpoch)) publishServerBardWikiJobEvent(event)
    },
    onMemorySnapshot: (snapshot) => {
      if (isCurrentServerResourceEventEpoch(eventEpoch)) applyServerMemorySnapshot(snapshot)
    },
    onWriterEvent: (event) => {
      if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
      if (isClientSessionManaged()) observeClientWriter(event)
      if (event.sessionId !== null && event.sessionId !== getActiveWriterSessionId()) {
        enterWriterTakeoverFlow()
      }
    },
    onFrame: (frame) =>
      recordServerResourceEventFrame(eventEpoch, frame.event === 'message' && frame.data.length === 0),
    onError: (error) => {
      if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
      console.warn(error)
      if (error.includes('Malformed command event frame')) {
        enqueueServerResourceSync(async () => {
          if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
          await forceServerResourceRefresh('malformed-command-event')
          scheduleServerResourceReconnect(eventEpoch)
        })
        return
      }
      scheduleServerResourceReconnect(eventEpoch)
    },
    onClose: () => {
      if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
      scheduleServerResourceReconnect(eventEpoch)
    },
  })
  if (!isCurrentServerResourceEventEpoch(eventEpoch)) {
    if (subscription.status === 'ok') subscription.unsubscribe()
    return
  }
  if (subscription.status === 'ok') {
    serverResourceReconnectAttempt = 0
    serverResourceEventSubscription = subscription
    recordServerResourceEventFrame(eventEpoch)
    recordStartupMilestone('writer-ready')
    if (isClientSessionManaged()) setClientConnectionState('live')
    setObserverShellLifecycleMode('promoted')
    if (options.replayPendingMutations !== false) triggerReconnectPendingMutationReplay()
    if (hasPendingReplacementDatabaseRefresh()) {
      enqueueServerResourceSync(async () => {
        if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
        const refreshed = await retryPendingReplacementDatabaseRefresh()
        if (!refreshed) scheduleServerResourceReconnect(eventEpoch)
      })
    }
  } else if (subscription.status === 'error') {
    if (isClientSessionManaged() && subscription.httpStatus === 401) {
      await discardObserverProjectionState('auth-loss')
      return
    }
    setObserverShellLifecycleMode('unavailable')
    console.warn(`Server event subscription failed: ${subscription.error}`)
    scheduleServerResourceReconnect(eventEpoch)
  } else if (subscription.status === 'replay-unavailable') {
    setObserverShellLifecycleMode('unavailable')
    console.warn(`Server event replay unavailable at revision ${subscription.currentRevision}; refreshing resources`)
    enqueueServerResourceSync(async () => {
      if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
      await refreshAfterUnavailableEventReplay()
      scheduleServerResourceReconnect(eventEpoch)
    })
  }
}

async function refreshAfterUnavailableEventReplay(): Promise<void> {
  const reconciliation = await reconcileReplacementDatabaseOwnership()
  if (reconciliation === null) return
  const replacementRefresh =
    reconciliation.ownershipChanged ||
    isReplacementDatabaseOwnershipRefreshPending(reconciliation.ownership) ||
    !wasReplacementDatabaseOwnershipRefreshed(reconciliation.ownership)
  const refresh = replacementRefresh
    ? await forceServerDatabaseReplacementRefresh('event-replay-unavailable')
    : await forceServerResourceRefresh('event-replay-unavailable')
  if (replacementRefresh && refresh.status === 'ok') {
    markReplacementDatabaseOwnershipRefreshed(reconciliation.ownership)
  }
}

async function retryPendingReplacementDatabaseRefresh(): Promise<boolean> {
  const reconciliation = await reconcileReplacementDatabaseOwnership()
  if (reconciliation === null) return false
  if (!isReplacementDatabaseOwnershipRefreshPending(reconciliation.ownership)) return true
  const refresh = await forceServerDatabaseReplacementRefresh('database-replacement-reconnect')
  if (refresh.status !== 'ok') {
    if (refresh.status === 'error') {
      console.warn(`Pending server database replacement refresh failed: ${refresh.error}`)
    }
    return false
  }
  markReplacementDatabaseOwnershipRefreshed(reconciliation.ownership)
  return true
}

function teardownServerResourceSubscription() {
  clearServerResourceEventWatchdog()
  serverResourceEventSubscription?.unsubscribe()
  serverResourceEventSubscription = null
}

function scheduleServerResourceReconnect(eventEpoch = serverResourceEventEpoch) {
  if (isClientSessionManaged()) {
    if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
    setClientConnectionState('interrupted')
    scheduleConnectedWriterResume()
    return
  }
  if (serverResourceReconnectTimer || !serverResourceEventsDesired || eventEpoch !== serverResourceEventEpoch) {
    return
  }
  const delayMs = calculateServerResourceReconnectDelayMs(serverResourceReconnectAttempt)
  serverResourceReconnectAttempt += 1
  serverResourceReconnectTimer = setTimeout(() => {
    serverResourceReconnectTimer = null
    if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
    void (async () => {
      await startServerResourceEvents()
    })()
  }, delayMs)
}

function recordServerResourceEventFrame(eventEpoch: number, retryPendingMutations = false): void {
  if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
  serverResourceLastFrameAt = Date.now()
  armServerResourceEventWatchdog(eventEpoch, SERVER_RESOURCE_EVENT_STALE_TIMEOUT_MS)
  if (serverResourceRuntimeReplayEnabled && retryPendingMutations) triggerReconnectPendingMutationReplay()
}

function armServerResourceEventWatchdog(eventEpoch: number, delayMs: number): void {
  clearServerResourceEventWatchdog()
  serverResourceEventWatchdogTimer = setTimeout(
    () => {
      serverResourceEventWatchdogTimer = null
      if (!isCurrentServerResourceEventEpoch(eventEpoch)) return
      const remainingMs = SERVER_RESOURCE_EVENT_STALE_TIMEOUT_MS - (Date.now() - serverResourceLastFrameAt)
      if (remainingMs > 0) {
        armServerResourceEventWatchdog(eventEpoch, remainingMs)
        return
      }
      console.warn('Server event stream heartbeat timed out; reconnecting')
      teardownServerResourceSubscription()
      scheduleServerResourceReconnect(eventEpoch)
    },
    Math.max(1, delayMs),
  )
}

function clearServerResourceEventWatchdog(): void {
  if (!serverResourceEventWatchdogTimer) return
  clearTimeout(serverResourceEventWatchdogTimer)
  serverResourceEventWatchdogTimer = null
}

function isCurrentServerResourceEventEpoch(eventEpoch: number): boolean {
  return serverResourceEventsDesired && eventEpoch === serverResourceEventEpoch
}

function ensureServerResourceRecoveryListeners(): void {
  if (stopServerResourceRecoveryListeners || typeof window === 'undefined' || typeof document === 'undefined') return
  stopServerResourceRecoveryListeners = subscribeBrowserLifecycleRecovery(() => restartServerResourceEvents())
}

function restartServerResourceEvents(): void {
  if (isClientSessionManaged()) {
    if (getClientSessionSnapshot().lifecycle === 'writing') {
      if (connectedWriterOwnershipCheck) return
      const generation = captureClientSessionGeneration()
      const check = (async () => {
        const result = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
        if (!isClientSessionGenerationCurrent(generation)) return
        if (result.status !== 'ok') {
          if (result.status === 'error' && result.httpStatus === 401) {
            await discardObserverProjectionState('auth-loss')
            return
          }
          setClientConnectionState('interrupted')
          scheduleConnectedWriterResume()
          return
        }
        if (result.bootstrap.databaseLineage !== getClientSessionSnapshot().databaseLineage) {
          demoteClientSession()
          return
        }
        if (result.bootstrap.writer) observeClientWriter(result.bootstrap.writer)
      })().finally(() => {
        if (connectedWriterOwnershipCheck === check) connectedWriterOwnershipCheck = null
      })
      connectedWriterOwnershipCheck = check
      return
    }
    scheduleConnectedWriterResume()
    return
  }
  if (!serverResourceEventsDesired) return
  if (serverResourceReconnectTimer) {
    clearTimeout(serverResourceReconnectTimer)
    serverResourceReconnectTimer = null
  }
  void startServerResourceEvents()
}

function triggerReconnectPendingMutationReplay(): void {
  if (!serverResourceEventsDesired || reconnectPendingMutationReplay) return
  const replay = (async () => {
    const summary = await replayPendingMutations()
    if (summary.discarded === 0) return
    await enqueueServerResourceSync(async () => {
      await forceServerResourceRefresh('pending-mutation-replay-discarded')
    })
  })().catch((error) => console.warn('Pending mutation reconnect replay failed', error))
  reconnectPendingMutationReplay = replay
  void replay.finally(() => {
    if (reconnectPendingMutationReplay === replay) reconnectPendingMutationReplay = null
  })
}

function handleServerCommandConflictGap(currentRevision: number, appliedRevision: number): void {
  if (currentRevision <= appliedRevision) return
  void enqueueServerResourceSync(async () => {
    const latestAppliedRevision = peekAppliedServerResourceRevision()
    if (latestAppliedRevision !== null && latestAppliedRevision >= currentRevision) return
    try {
      await forceServerResourceRefresh('conflict-gap')
    } finally {
      restartServerResourceEvents()
    }
  })
}

export function calculateServerResourceReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const normalizedAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  const exponentialDelay = Math.min(
    SERVER_RESOURCE_RECONNECT_MAX_DELAY_MS,
    SERVER_RESOURCE_RECONNECT_BASE_DELAY_MS * 2 ** normalizedAttempt,
  )
  const randomValue = random()
  const normalizedRandom = Number.isFinite(randomValue) && randomValue >= 0 && randomValue <= 1 ? randomValue : 0.5
  const jitterMultiplier =
    1 - SERVER_RESOURCE_RECONNECT_JITTER_RATIO + normalizedRandom * SERVER_RESOURCE_RECONNECT_JITTER_RATIO * 2
  const jitteredDelay = Math.round(exponentialDelay * jitterMultiplier)

  return Math.min(SERVER_RESOURCE_RECONNECT_MAX_DELAY_MS, Math.max(1, jitteredDelay))
}

function applyServerMemoryEvent(event: ServerMemoryEvent) {
  if (!applyServerMemoryJobEvent(event)) return
  publishServerMemoryJobEvent(event)
}

function applyServerMemorySnapshot(snapshot: ServerMemoryJobSnapshot) {
  applyServerMemoryJobSnapshot(snapshot)
  publishServerBardWikiJobSnapshot({
    streamId: snapshot.streamId,
    version: snapshot.version,
    jobs: snapshot.bardWikiJobs,
  })
}

/**
 * Apply API resource invalidations in command revision order. Dedicated read
 * endpoints own the mapping from event resources to settings, collections,
 * character rows, transcripts, and lorebooks; revision gaps fall back to one
 * complete resource refresh.
 */
function handleServerCommandEvent(event: CommandEvent) {
  if (isOwnCommandEvent(event) && deferOwnServerCommandReconciliation(event)) return
  enqueueServerResourceSync(() => processServerCommandEvents([event]))
}

function enqueueServerResourceSync(task: () => Promise<void>): Promise<void> {
  const generation = captureClientSessionGeneration()
  serverResourceSyncChain = serverResourceSyncChain
    .then(() => {
      if (!isClientSessionGenerationCurrent(generation) || !canUseClientRecoveryAccess()) return
      return task()
    })
    .catch((error) => console.warn('Server resource sync failed', error))
  return serverResourceSyncChain
}

async function processServerCommandEvents(
  events: readonly CommandEvent[],
  localEffects: ReadonlyMap<number, ServerCommandLocalEffect> = new Map(),
): Promise<void> {
  if (events.length === 0) return
  const generation = captureClientSessionGeneration()
  const isCurrent = () => isClientSessionGenerationCurrent(generation) && canUseClientRecoveryAccess()

  const sortedEvents = [...events].sort((left, right) => left.revision - right.revision)
  let pendingAuthoritativeEvents: CommandEvent[] = []

  const flushPendingAuthoritativeEvents = async (): Promise<boolean> => {
    if (pendingAuthoritativeEvents.length === 0) return true
    const pending = pendingAuthoritativeEvents
    pendingAuthoritativeEvents = []
    return processAuthoritativeServerCommandEvents(pending)
  }

  for (const event of sortedEvents) {
    if (!isCurrent()) return
    const localEffect = localEffects.get(event.revision)
    if (!localEffect) {
      pendingAuthoritativeEvents.push(event)
      continue
    }

    if (!(await flushPendingAuthoritativeEvents())) return
    if (!isCurrent()) return
    const appliedRevision = peekAppliedServerResourceRevision()
    if (appliedRevision !== null && event.revision <= appliedRevision) continue

    if (
      appliedRevision !== null &&
      event.revision === appliedRevision + 1 &&
      applyContiguousServerCommandLocalEffect(event, localEffect)
    ) {
      notifyServerCommandLocalEffectApplied(event, localEffect)
      advanceKnownServerCommandRevision(event.revision)
      setAppliedServerResourceRevision(event.revision)
      continue
    }

    // A local acknowledgement can only advance a contiguous cursor. A gap or
    // an effect whose target disappeared must retain the ordinary authoritative
    // invalidation path.
    if (!(await processAuthoritativeServerCommandEvents([event]))) return
  }

  await flushPendingAuthoritativeEvents()
}

function applyLegacyPresetPatchAcknowledgement(
  event: CommandEvent,
  localEffect: LegacyPresetPatchLocalEffect,
): boolean {
  if (
    event.type !== 'preset.updated' ||
    event.resource !== 'presetRow' ||
    event.id !== localEffect.presetId ||
    event.parentId !== undefined ||
    !Number.isInteger(localEffect.collectionProjectionEpoch) ||
    localEffect.collectionProjectionEpoch < 0 ||
    hasCollectionProjectionEpochChanged('botPresets', localEffect.collectionProjectionEpoch) ||
    isCollectionAcknowledgementTainted('botPresets')
  ) {
    return false
  }
  return applyResourceOwnerMutation(() =>
    applyLegacyPresetPatchLocalEffect({
      revision: event.revision,
      presetId: localEffect.presetId,
      fields: localEffect.fields,
    }),
  )
}

function applyPresetReorderAcknowledgement(event: CommandEvent, localEffect: PresetReorderLocalEffect): boolean {
  const collectionName = localEffect.presetKind === 'legacy' ? 'botPresets' : 'modelPresets'
  const expectedType = localEffect.presetKind === 'legacy' ? 'preset.reordered' : 'modelPreset.reordered'
  const expectedResource =
    localEffect.presetKind === 'legacy'
      ? localEffect.settingsWritten
        ? 'presetCollectionWithPointer'
        : 'presetCollection'
      : 'modelPreset'
  if (
    event.type !== expectedType ||
    event.resource !== expectedResource ||
    event.id !== undefined ||
    event.parentId !== undefined ||
    !Number.isInteger(localEffect.collectionProjectionEpoch) ||
    localEffect.collectionProjectionEpoch < 0 ||
    !Number.isInteger(localEffect.settingsProjectionEpoch) ||
    localEffect.settingsProjectionEpoch < 0 ||
    hasCollectionProjectionEpochChanged(collectionName, localEffect.collectionProjectionEpoch) ||
    isCollectionAcknowledgementTainted(collectionName) ||
    (localEffect.settingsWritten &&
      (hasSettingsProjectionEpochChanged(localEffect.settingsProjectionEpoch) || isSettingsAcknowledgementTainted())) ||
    currentPresetReorderSelection(localEffect.presetKind) !== localEffect.selectedPresetId
  ) {
    return false
  }
  return applyResourceOwnerMutation(() =>
    applyPresetReorderLocalEffect({
      revision: event.revision,
      presetKind: localEffect.presetKind,
      presetIds: localEffect.presetIds,
      selectedPresetId: localEffect.selectedPresetId,
      settingsWritten: localEffect.settingsWritten,
    }),
  )
}

function applyPersonaPatchAcknowledgement(event: CommandEvent, localEffect: PersonaPatchLocalEffect): boolean {
  if (
    event.type !== 'persona.updated' ||
    event.resource !== 'persona' ||
    event.id !== localEffect.personaId ||
    event.parentId !== undefined ||
    !Number.isInteger(localEffect.collectionProjectionEpoch) ||
    localEffect.collectionProjectionEpoch < 0 ||
    !Number.isInteger(localEffect.settingsProjectionEpoch) ||
    localEffect.settingsProjectionEpoch < 0 ||
    hasCollectionProjectionEpochChanged('personas', localEffect.collectionProjectionEpoch) ||
    isCollectionAcknowledgementTainted('personas') ||
    (localEffect.legacyProfileProjectionApplied &&
      (hasSettingsProjectionEpochChanged(localEffect.settingsProjectionEpoch) || isSettingsAcknowledgementTainted()))
  ) {
    return false
  }
  return applyResourceOwnerMutation(() =>
    applyPersonaPatchLocalEffect({
      revision: event.revision,
      personaId: localEffect.personaId,
      attemptedPatch: localEffect.attemptedPatch,
      attemptedPersona: localEffect.attemptedPersona,
      attemptedLegacyProfile: localEffect.attemptedLegacyProfile,
      legacyProfileProjectionApplied: localEffect.legacyProfileProjectionApplied,
    }),
  )
}

function applyPersonaMutationAcknowledgement(event: CommandEvent, localEffect: PersonaMutationLocalEffect): boolean {
  const expectedEventType: Record<PersonaMutationLocalEffect['operation'], string> = {
    create: 'persona.created',
    delete: 'persona.deleted',
    select: 'persona.selected',
    reorder: 'persona.reordered',
  }
  const targetExpected = localEffect.operation !== 'reorder'
  if (
    event.type !== expectedEventType[localEffect.operation] ||
    event.resource !== 'persona' ||
    event.parentId !== undefined ||
    (targetExpected ? event.id !== localEffect.targetPersonaId : event.id !== undefined) ||
    (targetExpected ? typeof localEffect.targetPersonaId !== 'string' : localEffect.targetPersonaId !== null) ||
    !Number.isInteger(localEffect.collectionProjectionEpoch) ||
    localEffect.collectionProjectionEpoch < 0 ||
    !Number.isInteger(localEffect.settingsProjectionEpoch) ||
    localEffect.settingsProjectionEpoch < 0 ||
    hasCollectionProjectionEpochChanged('personas', localEffect.collectionProjectionEpoch) ||
    isCollectionAcknowledgementTainted('personas') ||
    (localEffect.settingsWritten &&
      (hasSettingsProjectionEpochChanged(localEffect.settingsProjectionEpoch) || isSettingsAcknowledgementTainted()))
  ) {
    return false
  }
  return applyResourceOwnerMutation(() =>
    applyPersonaMutationLocalEffect({
      revision: event.revision,
      operation: localEffect.operation,
      collectionWritten: localEffect.collectionWritten,
      settingsWritten: localEffect.settingsWritten,
    }),
  )
}

function applyAgentPresetCollectionMutationAcknowledgement(
  event: CommandEvent,
  localEffect: AgentPresetCollectionMutationLocalEffect,
): boolean {
  const expectedType = localEffect.operation === 'reorder' ? 'agentPreset.reordered' : 'agentPreset.default.updated'
  const expectedEventId =
    localEffect.operation === 'default' ? (localEffect.agentPresetDefaultId ?? undefined) : undefined
  if (
    event.type !== expectedType ||
    event.resource !== 'agentPreset' ||
    event.id !== expectedEventId ||
    event.parentId !== undefined ||
    !Number.isInteger(localEffect.settingsProjectionEpoch) ||
    localEffect.settingsProjectionEpoch < 0 ||
    hasSettingsGroupProjectionEpochChanged('agents', localEffect.settingsProjectionEpoch) ||
    isSettingsGroupAcknowledgementTainted('agents') ||
    isSettingsAcknowledgementTainted()
  ) {
    return false
  }
  return applyResourceOwnerMutation(() =>
    applyAgentPresetCollectionMutationLocalEffect({
      revision: event.revision,
      operation: localEffect.operation,
      presetIds: localEffect.presetIds,
      agentPresetDefaultId: localEffect.agentPresetDefaultId,
    }),
  )
}

function applyAgentPresetPatchAcknowledgement(event: CommandEvent, localEffect: AgentPresetPatchLocalEffect): boolean {
  if (
    event.type !== 'agentPreset.updated' ||
    event.resource !== 'agentPreset' ||
    event.id !== localEffect.presetId ||
    event.parentId !== undefined ||
    !Number.isInteger(localEffect.settingsProjectionEpoch) ||
    localEffect.settingsProjectionEpoch < 0 ||
    hasSettingsGroupProjectionEpochChanged('agents', localEffect.settingsProjectionEpoch) ||
    isSettingsGroupAcknowledgementTainted('agents') ||
    isSettingsAcknowledgementTainted()
  ) {
    return false
  }
  return applyResourceOwnerMutation(() =>
    applyAgentPresetPatchLocalEffect({
      revision: event.revision,
      presetId: localEffect.presetId,
      fields: localEffect.fields,
      updatedAt: localEffect.updatedAt,
    }),
  )
}

function applyAgentPresetStepPatchAcknowledgement(
  event: CommandEvent,
  localEffect: AgentPresetStepPatchLocalEffect,
): boolean {
  if (
    event.type !== 'agentPreset.step.updated' ||
    event.resource !== 'agentPreset' ||
    event.id !== localEffect.stepId ||
    event.parentId !== localEffect.presetId ||
    !Number.isInteger(localEffect.settingsProjectionEpoch) ||
    localEffect.settingsProjectionEpoch < 0 ||
    hasSettingsGroupProjectionEpochChanged('agents', localEffect.settingsProjectionEpoch) ||
    isSettingsGroupAcknowledgementTainted('agents') ||
    isSettingsAcknowledgementTainted()
  ) {
    return false
  }
  return applyResourceOwnerMutation(() =>
    applyAgentPresetStepPatchLocalEffect({
      revision: event.revision,
      presetId: localEffect.presetId,
      stepId: localEffect.stepId,
      fields: localEffect.fields,
      updatedAt: localEffect.updatedAt,
    }),
  )
}

function applyTranslatorPresetPatchAcknowledgement(
  event: CommandEvent,
  localEffect: TranslatorPresetPatchLocalEffect,
): boolean {
  const translatorPresets = collectionsResourceState.values.translatorPresets
  const selectedId = settingsResourceState.value.translatorPresetId
  const selectedPreset =
    typeof selectedId === 'string' && Array.isArray(translatorPresets)
      ? translatorPresets.find((preset) => preset.id === selectedId)
      : undefined
  if (
    event.type !== 'translatorPreset.updated' ||
    event.resource !== 'translatorPreset' ||
    event.id !== localEffect.presetId ||
    event.parentId !== undefined ||
    !Number.isInteger(localEffect.collectionProjectionEpoch) ||
    localEffect.collectionProjectionEpoch < 0 ||
    !Number.isInteger(localEffect.languageSettingsProjectionEpoch) ||
    localEffect.languageSettingsProjectionEpoch < 0 ||
    selectedPreset?.id !== localEffect.selectedPresetId ||
    hasCollectionProjectionEpochChanged('translatorPresets', localEffect.collectionProjectionEpoch) ||
    isCollectionAcknowledgementTainted('translatorPresets') ||
    hasSettingsGroupProjectionEpochChanged('language', localEffect.languageSettingsProjectionEpoch) ||
    isSettingsGroupAcknowledgementTainted('language') ||
    isSettingsAcknowledgementTainted()
  ) {
    return false
  }
  return applyResourceOwnerMutation(() =>
    applyTranslatorPresetPatchLocalEffect({
      revision: event.revision,
      presetId: localEffect.presetId,
      attemptedPatch: localEffect.attemptedPatch,
      attemptedPreset: localEffect.attemptedPreset,
      selectedPresetId: localEffect.selectedPresetId,
    }),
  )
}

function applyContiguousServerCommandLocalEffect(event: CommandEvent, localEffect: ServerCommandLocalEffect): boolean {
  if (
    localEffect.destructiveRefreshEpoch !== undefined &&
    (!Number.isInteger(localEffect.destructiveRefreshEpoch) ||
      localEffect.destructiveRefreshEpoch < 0 ||
      hasDestructiveRefreshEpochChanged(localEffect.destructiveRefreshEpoch))
  ) {
    return false
  }

  switch (localEffect.kind) {
    case 'agentPresetCollectionMutation':
      return applyAgentPresetCollectionMutationAcknowledgement(event, localEffect)
    case 'agentPresetPatch':
      return applyAgentPresetPatchAcknowledgement(event, localEffect)
    case 'agentPresetStepPatch':
      return applyAgentPresetStepPatchAcknowledgement(event, localEffect)
    case 'legacyPresetPatch':
      return applyLegacyPresetPatchAcknowledgement(event, localEffect)
    case 'presetReorder':
      return applyPresetReorderAcknowledgement(event, localEffect)
    case 'personaPatch':
      return applyPersonaPatchAcknowledgement(event, localEffect)
    case 'personaMutation':
      return applyPersonaMutationAcknowledgement(event, localEffect)
    case 'translatorPresetPatch':
      return applyTranslatorPresetPatchAcknowledgement(event, localEffect)
    case 'chatGenerationSettings':
      if (
        event.type !== 'chat.updated' ||
        event.resource !== 'characterRow' ||
        event.id !== localEffect.chatId ||
        event.parentId !== localEffect.characterId ||
        (localEffect.characterRowProjectionEpoch !== undefined &&
          (!Number.isInteger(localEffect.characterRowProjectionEpoch) ||
            localEffect.characterRowProjectionEpoch < 0 ||
            hasCharacterRowProjectionEpochChanged(localEffect.characterId, localEffect.characterRowProjectionEpoch)))
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyChatGenerationSettingsLocalEffect({
          revision: event.revision,
          characterId: localEffect.characterId,
          chatId: localEffect.chatId,
          attemptedGenerationSettings: localEffect.attemptedGenerationSettings,
          generationSettings: localEffect.generationSettings,
        }),
      )
    case 'characterPatch':
      if (event.resource !== 'characterRow' || event.id !== localEffect.characterId) return false
      return applyResourceOwnerMutation(() =>
        applyCharacterPatchLocalEffect({
          revision: event.revision,
          characterId: localEffect.characterId,
          patch: localEffect.patch,
        }),
      )
    case 'characterSelection':
      if (event.resource !== 'characterSelection' || event.id !== localEffect.characterId) return false
      return applyResourceOwnerMutation(() =>
        applyCharacterSelectionLocalEffect({
          revision: event.revision,
          characterId: localEffect.characterId,
          lastInteraction: localEffect.lastInteraction,
        }),
      )
    case 'characterCollectionMutation': {
      const expectedType =
        localEffect.operation === 'create'
          ? 'character.created'
          : localEffect.operation === 'createAndSelect'
            ? 'character.createdAndSelected'
            : 'character.deleted'
      if (
        event.type !== expectedType ||
        event.resource !== 'character' ||
        event.id !== localEffect.characterId ||
        event.parentId !== undefined
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyCharacterCollectionMutationLocalEffect({
          revision: event.revision,
          operation: localEffect.operation,
          characterId: localEffect.characterId,
          selectedCharacterId: localEffect.selectedCharacterId,
        }),
      )
    }
    case 'chatPatch':
      if (
        event.resource !== 'characterRow' ||
        event.id !== localEffect.chatId ||
        event.parentId !== localEffect.characterId
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyChatPatchLocalEffect({
          revision: event.revision,
          characterId: localEffect.characterId,
          chatId: localEffect.chatId,
          patch: localEffect.patch,
          select: localEffect.select,
        }),
      )
    case 'chatStructureMutation': {
      if (hasDestructiveRefreshEpochChanged(localEffect.optimisticEpoch)) return false
      if (hasCharacterRowProjectionEpochChanged(localEffect.characterId, localEffect.optimisticRowEpoch)) {
        return false
      }
      const expectedType =
        localEffect.operation === 'create'
          ? 'chat.created'
          : localEffect.operation === 'delete'
            ? 'chat.deleted'
            : localEffect.operation === 'fork'
              ? 'chat.forked'
              : localEffect.operation === 'reorder'
                ? 'chat.reordered'
                : localEffect.operation === 'folderCreate'
                  ? 'chatFolder.created'
                  : localEffect.operation === 'folderDelete'
                    ? 'chatFolder.deleted'
                    : 'chatFolder.reordered'
      const createsTranscript = localEffect.operation === 'create' || localEffect.operation === 'fork'
      const reorders = localEffect.operation === 'reorder' || localEffect.operation === 'folderReorder'
      if (
        event.type !== expectedType ||
        event.parentId !== localEffect.characterId ||
        (event.resource !== 'characterRow' && !(createsTranscript && event.resource === 'chatTranscript')) ||
        (reorders ? event.id !== undefined : event.id !== localEffect.targetId)
      ) {
        return false
      }
      if (
        reorders &&
        (!Array.isArray(localEffect.attemptedIds) ||
          localEffect.attemptedIds.some((id) => typeof id !== 'string' || id.trim() === '') ||
          new Set(localEffect.attemptedIds).size !== localEffect.attemptedIds.length)
      ) {
        return false
      }
      if (!reorders && (typeof localEffect.targetId !== 'string' || localEffect.targetId.trim() === '')) return false

      if (createsTranscript) {
        const attemptedGenerationSettings = localEffect.attemptedGenerationSettings
        const generationSettings = localEffect.generationSettings
        if (
          !Object.prototype.hasOwnProperty.call(localEffect, 'attemptedGenerationSettings') ||
          !Object.prototype.hasOwnProperty.call(localEffect, 'generationSettings') ||
          (attemptedGenerationSettings !== null &&
            (!attemptedGenerationSettings ||
              typeof attemptedGenerationSettings !== 'object' ||
              Array.isArray(attemptedGenerationSettings))) ||
          (generationSettings !== null &&
            (!generationSettings || typeof generationSettings !== 'object' || Array.isArray(generationSettings)))
        ) {
          return false
        }
      }

      let createdChatMatches: Array<{ characterId: string; message: unknown }> = []
      if (createsTranscript) {
        createdChatMatches = charactersResourceState.characters.flatMap((character) =>
          (character.chats ?? [])
            .filter((chat) => chat.id === localEffect.targetId)
            .map((chat) => ({ characterId: character.chaId, message: chat.message })),
        )
        if (
          createdChatMatches.length !== 1 ||
          createdChatMatches[0].characterId !== localEffect.characterId ||
          !Array.isArray(createdChatMatches[0].message)
        ) {
          return false
        }
      }

      return applyResourceOwnerMutation(() => {
        if (
          !applyCharacterRowMutationLocalEffect({
            revision: event.revision,
            characterId: localEffect.characterId,
            targetId: localEffect.targetId ?? localEffect.characterId,
          })
        ) {
          return false
        }
        if (createsTranscript && localEffect.targetId) {
          const createdChat = getCharacterResourceOwner(localEffect.characterId)?.chats?.find(
            (chat) => chat.id === localEffect.targetId,
          )
          if (
            createdChat &&
            JSON.stringify(createdChat.generationSettings ?? null) ===
              JSON.stringify(localEffect.attemptedGenerationSettings)
          ) {
            if (localEffect.generationSettings === null) {
              delete createdChat.generationSettings
            } else {
              createdChat.generationSettings = JSON.parse(
                JSON.stringify(localEffect.generationSettings),
              ) as typeof createdChat.generationSettings
            }
          }
          return acknowledgeCreatedChatTranscriptLocalEffect(localEffect.targetId)
        }
        if (localEffect.operation === 'delete' && localEffect.targetId) {
          invalidateChatHydration(localEffect.targetId)
        }
        return true
      })
    }
    case 'settingsPatch': {
      const writesHypaV3Presets = Object.prototype.hasOwnProperty.call(localEffect.attemptedPatch, 'hypaV3Presets')
      if (
        event.type !== 'settings.updated' ||
        event.resource !== (writesHypaV3Presets ? 'settingsWithHypaV3Presets' : 'settings') ||
        event.id !== localEffect.group ||
        event.parentId !== undefined
      ) {
        return false
      }
      if (
        !Number.isInteger(localEffect.settingsProjectionEpoch) ||
        localEffect.settingsProjectionEpoch < 0 ||
        hasSettingsGroupProjectionEpochChanged(localEffect.group, localEffect.settingsProjectionEpoch) ||
        isSettingsGroupAcknowledgementTainted(localEffect.group)
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applySettingsPatchLocalEffect({
          revision: event.revision,
          group: localEffect.group,
          attemptedPatch: localEffect.attemptedPatch,
          settings: localEffect.settings,
        }),
      )
    }
    case 'pluginStorage': {
      const expectedType =
        localEffect.operation === 'put'
          ? 'pluginStorage.updated'
          : localEffect.operation === 'delete'
            ? 'pluginStorage.deleted'
            : 'pluginStorage.bulkUpdated'
      if (event.resource !== 'pluginStorage' || event.type !== expectedType) return false
      if (localEffect.operation === 'bulk' ? event.id !== undefined : event.id !== localEffect.key) return false
      return applyResourceOwnerMutation(() => applyPluginStorageLocalEffect({ revision: event.revision }))
    }
    case 'pluginCollectionMutation': {
      const expectedType =
        localEffect.operation === 'create'
          ? 'plugin.created'
          : localEffect.operation === 'update'
            ? 'plugin.updated'
            : localEffect.operation === 'delete'
              ? 'plugin.deleted'
              : localEffect.operation === 'enable'
                ? 'plugin.enabled'
                : 'plugin.reordered'
      if (event.resource !== 'pluginCollection' || event.type !== expectedType) return false
      if (localEffect.operation === 'reorder' ? event.id !== undefined : event.id !== localEffect.pluginId) return false
      return applyResourceOwnerMutation(() =>
        applyPluginCollectionMutationLocalEffect({
          revision: event.revision,
          operation: localEffect.operation,
          pluginId: localEffect.pluginId,
          pluginIds: localEffect.pluginIds,
        }),
      )
    }
    case 'pluginProvider':
      if (
        event.type !== 'plugin.provider.selected' ||
        event.resource !== 'pluginProvider' ||
        event.id !== localEffect.provider
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyPluginProviderLocalEffect({ revision: event.revision, provider: localEffect.provider }),
      )
    case 'moduleCollectionMutation': {
      const expectedType =
        localEffect.operation === 'create'
          ? 'module.created'
          : localEffect.operation === 'update'
            ? 'module.updated'
            : localEffect.operation === 'reorder'
              ? 'module.reordered'
              : localEffect.operation === 'lorebooks'
                ? 'lorebook.entries.replaced'
                : localEffect.operation === 'scripts'
                  ? 'scriptDefinitions.replaced'
                  : 'triggerDefinitions.replaced'
      const expectedResource =
        localEffect.operation === 'create'
          ? 'moduleCreated'
          : localEffect.operation === 'reorder'
            ? 'moduleReordered'
            : localEffect.operation === 'scripts'
              ? 'moduleScriptDefinition'
              : localEffect.operation === 'triggers'
                ? 'moduleTriggerDefinition'
                : 'moduleUpdated'
      if (event.type !== expectedType || event.resource !== expectedResource || event.parentId !== undefined) {
        return false
      }
      if (localEffect.operation === 'reorder' ? event.id !== undefined : event.id !== localEffect.moduleId) {
        return false
      }
      const definitionProjectionEpoch = localEffect.collectionProjectionEpoch
      if (
        (localEffect.operation === 'scripts' || localEffect.operation === 'triggers') &&
        (typeof definitionProjectionEpoch !== 'number' ||
          !Number.isInteger(definitionProjectionEpoch) ||
          definitionProjectionEpoch < 0 ||
          hasCollectionProjectionEpochChanged('modules', definitionProjectionEpoch))
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyModuleCollectionMutationLocalEffect({
          revision: event.revision,
          operation: localEffect.operation,
          moduleId: localEffect.moduleId,
          moduleIds: localEffect.moduleIds,
        }),
      )
    }
    case 'moduleEnabled':
      if (
        event.type !== 'module.enabled' ||
        event.resource !== 'moduleEnabled' ||
        event.id !== localEffect.moduleId ||
        event.parentId !== undefined
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyModuleEnabledLocalEffect({
          revision: event.revision,
          moduleId: localEffect.moduleId,
          enabled: localEffect.enabled,
        }),
      )
    case 'promptItemMutation': {
      const expectedType = {
        create: 'prompt.item.created',
        update: 'prompt.item.updated',
        delete: 'prompt.item.deleted',
        reorder: 'prompt.item.reordered',
        enable: 'prompt.item.enabled',
      }[localEffect.operation]
      const collectionName = localEffect.promptPresetId === null ? 'promptTemplate' : 'promptPresets'
      const itemOperation =
        localEffect.operation === 'create' || localEffect.operation === 'update' || localEffect.operation === 'delete'
      if (
        expectedType === undefined ||
        event.type !== expectedType ||
        event.resource !== 'promptItem' ||
        event.parentId !== (localEffect.promptPresetId ?? undefined) ||
        (itemOperation ? event.id !== localEffect.itemId : event.id !== undefined) ||
        (localEffect.promptPresetId !== null &&
          (typeof localEffect.promptPresetId !== 'string' || localEffect.promptPresetId.trim() === '')) ||
        !Number.isInteger(localEffect.collectionProjectionEpoch) ||
        localEffect.collectionProjectionEpoch < 0 ||
        !Number.isInteger(localEffect.ownerProjectionEpoch) ||
        localEffect.ownerProjectionEpoch < 0 ||
        hasCollectionProjectionEpochChanged(collectionName, localEffect.collectionProjectionEpoch) ||
        hasPromptTemplateOwnerProjectionEpochChanged(localEffect.promptPresetId, localEffect.ownerProjectionEpoch) ||
        !isPromptTemplateHydrated(localEffect.promptPresetId) ||
        isPromptTemplateOwnerAcknowledgementTainted(localEffect.promptPresetId) ||
        peekPromptTemplateOwnerRevision(localEffect.promptPresetId) === null
      ) {
        return false
      }

      return applyResourceOwnerMutation(() => {
        if (
          !applyPromptItemMutationLocalEffect({
            revision: event.revision,
            operation: localEffect.operation,
            promptPresetId: localEffect.promptPresetId,
            itemId: localEffect.itemId,
            itemIds: localEffect.itemIds,
            enabled: localEffect.enabled,
            ownerState: localEffect.ownerState,
          })
        ) {
          return false
        }
        markPromptTemplateProjectionApplied(localEffect.promptPresetId, event.revision, {
          advanceProjectionEpoch: false,
        })
        return true
      })
    }
    case 'splitPresetPatch': {
      const collectionName = localEffect.presetKind === 'model' ? 'modelPresets' : 'promptPresets'
      const expectedType = localEffect.presetKind === 'model' ? 'modelPreset.updated' : 'promptPreset.updated'
      const expectedResource = localEffect.presetKind === 'model' ? 'modelPreset' : 'promptPreset'
      const selectedModelPresetId = currentSplitPresetId('model')
      const selectedPromptPresetId = currentSplitPresetId('prompt')
      const selectedPresetId = localEffect.presetKind === 'model' ? selectedModelPresetId : selectedPromptPresetId
      if (
        event.type !== expectedType ||
        event.resource !== expectedResource ||
        event.id !== localEffect.presetId ||
        event.parentId !== undefined ||
        !Number.isInteger(localEffect.collectionProjectionEpoch) ||
        localEffect.collectionProjectionEpoch < 0 ||
        hasCollectionProjectionEpochChanged(collectionName, localEffect.collectionProjectionEpoch) ||
        isCollectionAcknowledgementTainted(collectionName) ||
        selectedPresetId !== localEffect.selectedPresetId ||
        (localEffect.presetKind === 'model' && selectedPromptPresetId !== localEffect.selectedPromptPresetId)
      ) {
        return false
      }
      if (
        localEffect.selectedProjectionApplied &&
        (!Number.isInteger(localEffect.settingsProjectionEpoch) ||
          localEffect.settingsProjectionEpoch < 0 ||
          hasSettingsProjectionEpochChanged(localEffect.settingsProjectionEpoch) ||
          isSettingsAcknowledgementTainted() ||
          selectedPresetId !== localEffect.presetId)
      ) {
        return false
      }
      if (localEffect.ownerProjectionApplied) {
        if (
          localEffect.presetKind !== 'prompt' ||
          selectedPromptPresetId !== localEffect.presetId ||
          !Number.isInteger(localEffect.promptOwnerProjectionEpoch) ||
          (localEffect.promptOwnerProjectionEpoch as number) < 0 ||
          !Number.isInteger(localEffect.promptOwnerRevision) ||
          (localEffect.promptOwnerRevision as number) < 0 ||
          hasPromptTemplateOwnerProjectionEpochChanged(
            localEffect.presetId,
            localEffect.promptOwnerProjectionEpoch as number,
          ) ||
          !isPromptTemplateHydrated(localEffect.presetId) ||
          isPromptTemplateOwnerAcknowledgementTainted(localEffect.presetId) ||
          peekPromptTemplateOwnerRevision(localEffect.presetId) !== localEffect.promptOwnerRevision ||
          !selectedPromptPresetOwnsTemplate(localEffect.presetId)
        ) {
          return false
        }
      }

      return applyResourceOwnerMutation(() => {
        if (
          !applySplitPresetPatchLocalEffect({
            revision: event.revision,
            presetKind: localEffect.presetKind,
            presetId: localEffect.presetId,
            attemptedPatch: localEffect.attemptedPatch,
            preset: localEffect.preset,
            attemptedSettings: localEffect.attemptedSettings,
            settings: localEffect.settings,
            selectedProjectionApplied: localEffect.selectedProjectionApplied,
            ownerProjectionApplied: localEffect.ownerProjectionApplied,
          })
        ) {
          return false
        }
        if (localEffect.ownerProjectionApplied) {
          markPromptTemplateProjectionApplied(localEffect.presetId, event.revision, {
            advanceProjectionEpoch: false,
          })
        }
        return true
      })
    }
    case 'globalLorebookMutation': {
      const expectedType =
        localEffect.operation === 'create'
          ? 'lorebook.created'
          : localEffect.operation === 'update'
            ? 'lorebook.updated'
            : localEffect.operation === 'delete'
              ? 'lorebook.deleted'
              : localEffect.operation === 'reorder'
                ? 'lorebook.reordered'
                : 'lorebook.selected'
      if (event.type !== expectedType || event.resource !== 'globalLorebook' || event.parentId !== undefined) {
        return false
      }

      const changesCollection = localEffect.operation !== 'select'
      const changesPage =
        localEffect.operation === 'delete' || localEffect.operation === 'reorder' || localEffect.operation === 'select'
      if (
        changesCollection &&
        (typeof localEffect.collectionProjectionEpoch !== 'number' ||
          !Number.isInteger(localEffect.collectionProjectionEpoch) ||
          localEffect.collectionProjectionEpoch < 0 ||
          hasCollectionProjectionEpochChanged('loreBook', localEffect.collectionProjectionEpoch))
      ) {
        return false
      }
      if (
        changesPage &&
        (typeof localEffect.pageProjectionEpoch !== 'number' ||
          !Number.isInteger(localEffect.pageProjectionEpoch) ||
          localEffect.pageProjectionEpoch < 0 ||
          hasLorebookPageProjectionEpochChanged(localEffect.pageProjectionEpoch))
      ) {
        return false
      }

      if (localEffect.operation === 'reorder') {
        if (
          event.id !== undefined ||
          !Array.isArray(localEffect.lorebookIds) ||
          localEffect.lorebookIds.some((id) => typeof id !== 'string' || id.trim() === '') ||
          new Set(localEffect.lorebookIds).size !== localEffect.lorebookIds.length ||
          (localEffect.selectedLorebookId !== null &&
            (typeof localEffect.selectedLorebookId !== 'string' ||
              localEffect.selectedLorebookId.trim() === '' ||
              !localEffect.lorebookIds.includes(localEffect.selectedLorebookId)))
        ) {
          return false
        }
      } else if (
        typeof localEffect.lorebookId !== 'string' ||
        localEffect.lorebookId.trim() === '' ||
        event.id !== localEffect.lorebookId ||
        (localEffect.operation === 'select' && localEffect.selectedLorebookId !== localEffect.lorebookId)
      ) {
        return false
      }

      return applyResourceOwnerMutation(() =>
        applyGlobalLorebookMutationLocalEffect({
          revision: event.revision,
          operation: localEffect.operation,
          lorebookId: localEffect.lorebookId,
          lorebookIds: localEffect.lorebookIds,
          selectedLorebookId: localEffect.selectedLorebookId,
        }),
      )
    }
    case 'lorebookMutation': {
      if (
        localEffect.operation !== 'replace' &&
        localEffect.operation !== 'upsert' &&
        localEffect.operation !== 'delete' &&
        localEffect.operation !== 'reorder'
      ) {
        return false
      }

      if (localEffect.scope === 'global') {
        if (
          event.type !== 'lorebook.entries.replaced' ||
          event.resource !== 'globalLorebook' ||
          event.id !== localEffect.lorebookId ||
          event.parentId !== undefined ||
          typeof localEffect.collectionProjectionEpoch !== 'number' ||
          !Number.isInteger(localEffect.collectionProjectionEpoch) ||
          localEffect.collectionProjectionEpoch < 0 ||
          hasCollectionProjectionEpochChanged('loreBook', localEffect.collectionProjectionEpoch)
        ) {
          return false
        }
      } else if (localEffect.scope === 'character') {
        if (
          event.type !== 'lorebook.entries.replaced' ||
          event.resource !== 'characterLorebook' ||
          event.id !== localEffect.characterId ||
          event.parentId !== undefined ||
          typeof localEffect.characterRowProjectionEpoch !== 'number' ||
          !Number.isInteger(localEffect.characterRowProjectionEpoch) ||
          localEffect.characterRowProjectionEpoch < 0 ||
          typeof localEffect.characterLorebookProjectionEpoch !== 'number' ||
          !Number.isInteger(localEffect.characterLorebookProjectionEpoch) ||
          localEffect.characterLorebookProjectionEpoch < 0 ||
          typeof localEffect.characterId !== 'string' ||
          !isCharacterLorebookHydrated(localEffect.characterId) ||
          hasCharacterRowProjectionEpochChanged(localEffect.characterId, localEffect.characterRowProjectionEpoch) ||
          hasCharacterLorebookProjectionEpochChanged(
            localEffect.characterId,
            localEffect.characterLorebookProjectionEpoch,
          )
        ) {
          return false
        }
      } else if (
        localEffect.scope !== 'chat' ||
        event.type !== 'lorebook.entries.replaced' ||
        event.resource !== 'characterRow' ||
        event.id !== localEffect.chatId ||
        event.parentId !== localEffect.characterId ||
        typeof localEffect.characterId !== 'string' ||
        typeof localEffect.characterRowProjectionEpoch !== 'number' ||
        !Number.isInteger(localEffect.characterRowProjectionEpoch) ||
        localEffect.characterRowProjectionEpoch < 0 ||
        hasCharacterRowProjectionEpochChanged(localEffect.characterId, localEffect.characterRowProjectionEpoch)
      ) {
        return false
      }

      return applyResourceOwnerMutation(() =>
        applyLorebookMutationLocalEffect({
          revision: event.revision,
          scope: localEffect.scope,
          operation: localEffect.operation,
          lorebookId: localEffect.lorebookId,
          characterId: localEffect.characterId,
          chatId: localEffect.chatId,
        }),
      )
    }
    case 'loadoutMutation': {
      const expectedType = {
        create: 'loadout.created',
        delete: 'loadout.deleted',
        favorite: 'loadout.favorited',
        touch: 'loadout.touched',
      }[localEffect.operation]
      if (
        event.type !== expectedType ||
        event.resource !== 'loadout' ||
        event.id !== localEffect.loadoutId ||
        event.parentId !== undefined ||
        typeof localEffect.loadoutsProjectionEpoch !== 'number' ||
        !Number.isInteger(localEffect.loadoutsProjectionEpoch) ||
        localEffect.loadoutsProjectionEpoch < 0 ||
        hasCollectionProjectionEpochChanged('loadouts', localEffect.loadoutsProjectionEpoch)
      ) {
        return false
      }
      if (
        localEffect.operation === 'touch' &&
        (typeof localEffect.settingsProjectionEpoch !== 'number' ||
          !Number.isInteger(localEffect.settingsProjectionEpoch) ||
          localEffect.settingsProjectionEpoch < 0 ||
          typeof localEffect.loadedName !== 'string' ||
          localEffect.loadedName.trim() === '' ||
          hasSettingsGroupProjectionEpochChanged('sidebar', localEffect.settingsProjectionEpoch))
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyLoadoutMutationLocalEffect({
          revision: event.revision,
          operation: localEffect.operation,
          loadoutId: localEffect.loadoutId,
        }),
      )
    }
    case 'characterDefinitionMutation': {
      const expectedType =
        localEffect.operation === 'scripts' ? 'scriptDefinitions.replaced' : 'triggerDefinitions.replaced'
      if (
        event.type !== expectedType ||
        event.resource !== 'characterRow' ||
        event.id !== localEffect.characterId ||
        event.parentId !== undefined ||
        !Number.isInteger(localEffect.optimisticRowEpoch) ||
        localEffect.optimisticRowEpoch < 0 ||
        hasCharacterRowProjectionEpochChanged(localEffect.characterId, localEffect.optimisticRowEpoch)
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyCharacterRowMutationLocalEffect({
          revision: event.revision,
          characterId: localEffect.characterId,
          targetId: localEffect.characterId,
        }),
      )
    }
    case 'messageTranslation':
      if (
        event.type !== 'message.updated' ||
        event.resource !== 'message' ||
        event.id !== localEffect.messageId ||
        event.parentId !== localEffect.chatId
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyMessageTranslationLocalEffect(localEffect.chatId, localEffect.messageId, localEffect.translation),
      )
    case 'messageMutation': {
      const expectedType =
        localEffect.operation === 'append'
          ? 'message.appended'
          : localEffect.operation === 'update'
            ? 'message.updated'
            : localEffect.operation === 'delete'
              ? 'message.deleted'
              : localEffect.operation === 'truncate'
                ? 'message.truncated'
                : 'messages.replaced'
      if (
        event.type !== expectedType ||
        event.resource !== 'message' ||
        event.parentId !== localEffect.chatId ||
        (localEffect.messageId === undefined ? event.id !== undefined : event.id !== localEffect.messageId) ||
        !Number.isInteger(localEffect.chatBodyProjectionEpoch) ||
        localEffect.chatBodyProjectionEpoch < 0 ||
        hasChatBodyProjectionEpochChanged(localEffect.chatId, localEffect.chatBodyProjectionEpoch)
      ) {
        return false
      }
      return applyResourceOwnerMutation(() => acknowledgeMessageMutationLocalEffect(localEffect.chatId))
    }
    case 'characterRowMutation': {
      const expectedType =
        localEffect.operation === 'chatFolderUpdate' ? 'chatFolder.updated' : 'chat.scriptstate.updated'
      if (
        event.type !== expectedType ||
        event.resource !== 'characterRow' ||
        event.id !== localEffect.targetId ||
        event.parentId !== localEffect.characterId
      ) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyCharacterRowMutationLocalEffect({
          revision: event.revision,
          characterId: localEffect.characterId,
          targetId: localEffect.targetId,
        }),
      )
    }
    case 'characterOrder':
      if (event.type !== 'character.reordered' || event.resource !== 'characterOrder' || event.id !== undefined) {
        return false
      }
      return applyResourceOwnerMutation(() =>
        applyCharacterOrderLocalEffect({ revision: event.revision, attemptedOrder: localEffect.attemptedOrder }),
      )
  }
}

function currentSplitPresetId(kind: 'model' | 'prompt'): string | null {
  const presets =
    kind === 'model' ? collectionsResourceState.values.modelPresets : collectionsResourceState.values.promptPresets
  const selectedIndex =
    kind === 'model' ? settingsResourceState.value.modelPresetsId : settingsResourceState.value.promptPresetsId
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || !Array.isArray(presets)) return null
  if (kind === 'prompt') {
    return resolveUniquePromptPreset(presets, presets[selectedIndex]?.id)?.id ?? null
  }
  const id = presets[selectedIndex]?.id
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

function currentPresetReorderSelection(kind: PresetReorderLocalEffect['presetKind']): string | null {
  if (kind === 'model') return currentSplitPresetId('model')
  const botPresets = collectionsResourceState.values.botPresets
  const selectedIndex = settingsResourceState.value.botPresetsId
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || !Array.isArray(botPresets)) return null
  const id = botPresets[selectedIndex]?.id
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

function selectedPromptPresetOwnsTemplate(promptPresetId: string): boolean {
  const promptPresets = collectionsResourceState.values.promptPresets
  const selectedIndex = settingsResourceState.value.promptPresetsId
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || !Array.isArray(promptPresets)) return false
  const preset = resolveUniquePromptPreset(promptPresets, promptPresetId) as Record<string, unknown> | undefined
  if (!preset || preset !== promptPresets[selectedIndex]) return false
  return preset?.id === promptPresetId && Object.prototype.hasOwnProperty.call(preset, 'promptTemplate')
}

async function processAuthoritativeServerCommandEvents(events: readonly CommandEvent[]): Promise<boolean> {
  if (events.length === 0) return true
  const generation = captureClientSessionGeneration()
  const isCurrent = () => isClientSessionGenerationCurrent(generation) && canUseClientRecoveryAccess()
  if (!isCurrent()) return false

  if (events.some(isDatabaseReplacementEvent)) {
    const reconciliation = await reconcileReplacementDatabaseOwnership()
    if (!isCurrent()) return false
    if (reconciliation === null) {
      scheduleServerResourceReconnect()
      return false
    }
    if (
      !reconciliation.ownershipChanged &&
      !isReplacementDatabaseOwnershipRefreshPending(reconciliation.ownership) &&
      wasReplacementDatabaseOwnershipRefreshed(reconciliation.ownership)
    ) {
      return true
    }
    const refresh = await forceServerDatabaseReplacementRefresh('database-replacement-event', {
      resource: 'state',
    })
    if (!isCurrent()) return false
    if (refresh.status === 'ok') {
      markReplacementDatabaseOwnershipRefreshed(reconciliation.ownership)
      return true
    }
    if (refresh.status === 'error') {
      console.warn(`Server database replacement refresh failed: ${refresh.error}`)
    }
    scheduleServerResourceReconnect()
    return false
  }

  const selectionTracker = trackSelectedCharacterDuringRefresh()
  try {
    const result = await refreshInvalidatedServerResources(events, {
      appliedRevision: peekAppliedServerResourceRevision(),
      hooks: serverResourceInvalidationHooks,
      ...(isClientSessionManaged() ? { isCurrent } : {}),
    })
    if (!isCurrent()) return false

    if (result.status !== 'ok') {
      if (result.status === 'error') console.warn(`Server resource invalidation failed: ${result.error}`)
      scheduleServerResourceReconnect()
      return false
    }
    if (result.scope === 'none') return true

    reconcileSelectedCharacterAfterResourceRefresh(events, selectionTracker.snapshot())

    if (result.scope === 'full') {
      if (!isCurrent()) return false
      // Full character projections omit chat bodies. Clear their hydration
      // identities before prompt-template hydration can fail so the active
      // transcript is still fetched from its body endpoint.
      resetChatHydration()
      resetLorebookHydration()
      recordHydratedCharacterLorebooks(charactersResourceState.characters)
      requestActiveChatReadinessRefresh()
      void hydrateActiveChat({ force: true })
    } else {
      recordHydratedCharacterLorebooks(charactersResourceState.characters)
    }

    if (
      result.scope === 'full' &&
      !(await ensurePromptTemplateHydrated({ force: true, minimumRevision: result.revision }))
    ) {
      console.warn('Server resource invalidation failed: selected prompt-template owner hydration failed')
      scheduleServerResourceReconnect()
      return false
    }

    if (result.scope === 'full') {
      if (!isCurrent()) return false
      triggerOpenChatGenerationReattach()
    }

    advanceKnownServerCommandRevision(result.revision)
    setAppliedServerResourceRevision(result.revision)
    void hydrateSelectedCharacterShell({ supersede: true })
    return true
  } finally {
    selectionTracker.stop()
  }
}

function isDatabaseReplacementEvent(event: CommandEvent): boolean {
  return event.type === 'state.restored' || event.type === 'state.imported'
}

async function reconcileReplacementDatabaseOwnership(): Promise<{
  ownership: ReplacementDatabaseOwnership
  ownershipChanged: boolean
} | null> {
  const generation = captureClientSessionGeneration()
  const isCurrent = () => isClientSessionGenerationCurrent(generation) && canUseClientRecoveryAccess()
  if (!isCurrent()) return null
  await waitForLocalReplacementDatabaseOperations()
  if (!isCurrent()) return null
  const runtime = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
  if (!isCurrent()) return null
  if (runtime.status !== 'ok') {
    if (runtime.status === 'error') {
      console.warn(`Server database ownership refresh failed: ${runtime.error}`)
    }
    return null
  }
  const { databaseLineage, writerEpoch } = runtime.bootstrap
  if (
    isClientSessionManaged() &&
    (databaseLineage !== getClientSessionSnapshot().databaseLineage ||
      runtime.bootstrap.writer?.sessionId !== getActiveWriterSessionId())
  ) {
    demoteClientSession()
    void refreshConnectedReader()
    return null
  }
  if (!databaseLineage || typeof writerEpoch !== 'number' || !Number.isSafeInteger(writerEpoch) || writerEpoch < 0) {
    console.warn('Server database ownership refresh failed: bootstrap ownership metadata is missing')
    return null
  }
  const ownership = {
    databaseLineage,
    writerEpoch,
  }
  initializeDraftRecoveryScope({
    writerSessionId: getActiveWriterSessionId(),
    databaseLineage,
  })
  const adoption = await adoptReplacementDatabaseOwnership(ownership)
  if (!isCurrent()) return null
  if (adoption.ownershipChanged) {
    const { discardObserverProjectionState } = await import('./observerProjectionLifecycle')
    await discardObserverProjectionState('lineage-change')
  }
  if (adoption.discarded > 0) alertError(language.backupQueuedChangesDiscarded)
  return { ownership, ownershipChanged: adoption.ownershipChanged }
}

function reconcileSelectedCharacterAfterResourceRefresh(
  events: readonly CommandEvent[],
  selection: SelectedCharacterRefreshSnapshot,
): void {
  if (!selection.selectionChanged && events.some((event) => event.resource === 'characterSelection')) {
    selectedCharID.set(initialSelectedCharacterIndex())
    return
  }
  if (selection.target.selectedIndex < 0) return

  selectedCharID.set(resolveSelectedCharacterIndexAfterRefresh(selection.target))
}

function isOwnCommandEvent(event: CommandEvent): boolean {
  const writerSessionId = peekActiveWriterSessionId()
  return !!writerSessionId && event.origin?.writerSessionId === writerSessionId
}

function advanceKnownServerCommandRevision(revision: number): void {
  const cached = peekCachedServerCommandRevision()
  if (cached === null || revision > cached) {
    setCachedServerCommandRevision(revision)
  }
}

/**
 * Updates the error handling by adding custom handlers for errors and unhandled promise rejections.
 */
export function createGlobalErrorHandlers() {
  const errorHandler = (event: ErrorEvent | Event) => {
    console.error(getGlobalErrorLogPayload(event))
    if (isResourceOrWorkerErrorTarget(event.target)) {
      return
    }
    const alertPayload = getUsableGlobalErrorAlertPayload(event)
    if (alertPayload !== null) {
      alertError(alertPayload)
    }
  }
  const rejectHandler = (event: PromiseRejectionEvent) => {
    console.error(event.reason)
    const alertPayload = getUsableRejectionAlertPayload(event.reason)
    if (alertPayload !== null) {
      alertError(alertPayload)
    }
  }
  return { errorHandler, rejectHandler }
}

function updateErrorHandling() {
  if (stopGlobalErrorHandlers) return
  const { errorHandler, rejectHandler } = createGlobalErrorHandlers()
  window.addEventListener('error', errorHandler)
  window.addEventListener('unhandledrejection', rejectHandler)
  stopGlobalErrorHandlers = () => {
    window.removeEventListener('error', errorHandler)
    window.removeEventListener('unhandledrejection', rejectHandler)
  }
}

function getGlobalErrorLogPayload(event: ErrorEvent | Event): unknown {
  if ('error' in event) {
    return event.error
  }
  return event
}

function isResourceOrWorkerErrorTarget(target: EventTarget | null): boolean {
  if (target === null || target === window) {
    return false
  }
  if (typeof Worker !== 'undefined' && target instanceof Worker) {
    return true
  }
  return typeof Element !== 'undefined' && target instanceof Element
}

function getUsableGlobalErrorAlertPayload(event: ErrorEvent | Event): Error | string | null {
  const error = 'error' in event ? event.error : undefined
  const errorPayload = getUsableErrorLikeAlertPayload(error)
  if (errorPayload !== null) {
    return errorPayload
  }

  const message = 'message' in event ? event.message : undefined
  return getUsableErrorLikeAlertPayload(message)
}

function getUsableRejectionAlertPayload(reason: unknown): Error | string | null {
  return getUsableErrorLikeAlertPayload(reason)
}

function getUsableErrorLikeAlertPayload(value: unknown): Error | string | null {
  if (value instanceof Error) {
    return value.message.trim() ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  return null
}
