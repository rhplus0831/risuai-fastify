import { get } from 'svelte/store'
import { getClientSessionSnapshot } from '../clientSession'
import { selectedCharID } from '../stores/coreStores.svelte'
import { composeResourceDatabaseSnapshot } from './resourceState.svelte'
import { getRerollBuffer, unReroll } from '../process/rerollNavigation.svelte'
import { acceptedSendRecoveries } from '../process/acceptedSendRecoveryState'
import { activeChatGenerations } from '../process/generationActivity.svelte'
import { generationFinalizationPersistences } from '../process/generationPersistenceState'
import { activeGenerationJobs, generationJobLifecycles } from '../process/reattach'
import { activeWriterSessionHeader } from './activeWriterSession'
import { peekAppliedServerResourceRevision } from './commands'
import { dispatchDurableServerBackedSettingsPatch } from './settingsOwner.svelte'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { alertNormal } from '../alert'
import { currentRoute, navigate } from '../router'
import { QuickSettings } from '../stores.svelte'
import { generationOperationCancellations, generationOperationProjections } from './generationOperations'
import { listPendingMutationReceiptAcknowledgements, listPendingMutations } from './pendingMutationOutbox'
import { clearResourceCache, getPendingResourceCacheWriteCount } from './resourceCache'
import { currentRouteResourceLoadState } from './routeResourceLoader'
import {
  backgroundReady,
  getGenerationReadinessDiagnostic,
  getStartupChatReadinessEvaluations,
  getStartupCoordinatorSnapshot,
  getStartupReadinessSnapshot,
  waitForStartupMilestone,
  type StartupCoordinatorSnapshot,
  type StartupMilestone,
  type StartupReadinessSnapshot,
} from '../startupReadiness'
import type { FastifyBrowserSmokeHook as SharedFastifyBrowserSmokeHook } from '@risuai/shared-core/browser-smoke'

export type FastifyBrowserSmokeHook = SharedFastifyBrowserSmokeHook<
  StartupCoordinatorSnapshot,
  StartupReadinessSnapshot,
  StartupMilestone
>

declare global {
  interface Window {
    __RISU_FASTIFY_BROWSER_SMOKE__?: FastifyBrowserSmokeHook
  }
}

export function installFastifyBrowserSmokeHook() {
  window.__RISU_FASTIFY_BROWSER_SMOKE__ = {
    activeWriterHeaders: async () => ({
      'risu-auth': await getNodeServerProxyAuth(),
      ...activeWriterSessionHeader(),
    }),
    clearResourceCache,
    getPendingResourceCacheWriteCount,
    getAppliedServerResourceRevision: peekAppliedServerResourceRevision,
    getCurrentRoute: () => structuredClone(get(currentRoute)),
    getClientSessionSnapshot: () => structuredClone(getClientSessionSnapshot()),
    getDatabaseSnapshot: composeResourceDatabaseSnapshot,
    getLifecycleSnapshot: async () => ({
      acceptedSendRecoveries: structuredClone(get(acceptedSendRecoveries)),
      activeGenerationJobs: structuredClone(get(activeGenerationJobs)),
      activeChatGenerations: get(activeChatGenerations).map(({ controller: _controller, ...activity }) =>
        structuredClone(activity),
      ),
      generationFinalizations: structuredClone(get(generationFinalizationPersistences)),
      generationJobLifecycles: structuredClone(get(generationJobLifecycles)),
      generationOperationCancellations: structuredClone(get(generationOperationCancellations)),
      generationOperations: structuredClone(get(generationOperationProjections)),
      receiptAcknowledgements: (await listPendingMutationReceiptAcknowledgements()).map(
        ({ mutationId, requestCount, databaseLineage }) => ({ mutationId, requestCount, databaseLineage }),
      ),
      outbox: (await listPendingMutations()).map(({ handle, intent }) => ({
        key: handle.key,
        mutationId: handle.mutationId,
        phase: handle.phase,
        ...(intent.kind ? { kind: intent.kind } : {}),
        requests: structuredClone(intent.requests),
      })),
    }),
    getStartupCoordinatorSnapshot,
    getGenerationReadinessDiagnostic,
    getStartupChatReadinessEvaluations,
    getStartupSnapshot: getStartupReadinessSnapshot,
    getRouteResourceLoadState: currentRouteResourceLoadState,
    isLoaded: backgroundReady,
    // Ride the real durable outbox path so the request carries the mutation
    // receipt + database-lineage headers. The Journey 3 lineage-recovery gate
    // depends on this: an untagged command released after an import only gets
    // a benign revision_conflict, never the database_lineage_conflict reload.
    patchRuntimeSettings: (patch) => dispatchDurableServerBackedSettingsPatch({ patch }),
    waitForLoaded,
    waitForStartupMilestone,
    selectCharacter: (index) => selectedCharID.set(index),
    getRerollCandidates: () =>
      getRerollBuffer().map((entry) => {
        const last = entry.at(-1) as { data?: unknown } | undefined
        return typeof last?.data === 'string' ? last.data : ''
      }),
    swipeRerollBack: () => unReroll(),
    showAlert: (message) => alertNormal(message),
    navigateTo: (path) => navigate(path),
    setQuickSettingsOpen: (open) => {
      QuickSettings.open = open
    },
  }
}

function waitForLoaded(timeoutMs = 10_000): Promise<void> {
  return waitForStartupMilestone('background-ready', timeoutMs)
}
