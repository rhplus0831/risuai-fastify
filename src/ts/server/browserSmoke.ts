import { get } from 'svelte/store'
import { getClientSessionSnapshot } from '../clientSession'
import { alertStore, selectedCharID } from '../stores/coreStores.svelte'
import { charactersResourceState, composeResourceDatabaseSnapshot } from './resourceState.svelte'
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
import { CustomGUISettingMenuStore, QuickSettings, VariableReloadGUIPointer } from '../stores.svelte'
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
    getReadingBoundarySnapshot: () => {
      return {
        selectedCharacterIndex: get(selectedCharID),
        currentCharacterIndex: charactersResourceState.currentChar,
        chatPages: charactersResourceState.characters.map((character) => ({
          characterId: character.chaId,
          chatPage: character.chatPage,
        })),
        quickSettingsOpen: QuickSettings.open,
        customGuiSettingsOpen: get(CustomGUISettingMenuStore),
        variableReload: get(VariableReloadGUIPointer),
        alert: structuredClone(get(alertStore)),
      }
    },
    // Reproduce a restored/deferred overlay store write; App owns its denial.
    restoreRestrictedOverlays: () => {
      QuickSettings.open = true
      CustomGUISettingMenuStore.set(true)
    },
    // Invoke the actual action owners against the hydrated fixture, bypassing
    // controls without bypassing authority. Imports do not initialize Lua.
    probeInteractiveScriptAction: async ({ characterId, chatId, kind, name }) => {
      const character = charactersResourceState.characters.find((row) => row.chaId === characterId)
      const chat = character?.chats.find((row) => row.id === chatId)
      if (!character || !chat) throw new Error('browser_smoke_script_owner_missing')
      const previous = JSON.stringify(character)
      let error: string | null = null
      try {
        if (kind === 'trigger') {
          const { runTrigger } = await import('../process/triggers')
          await runTrigger(character, 'manual', { chat, manualName: name })
        } else {
          const { runLuaButtonTrigger } = await import('../process/scriptings')
          await runLuaButtonTrigger(character, name, { chat })
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
      return {
        triggerCount: character.triggerscript?.length ?? 0,
        sourceUnchanged: JSON.stringify(character) === previous,
        error,
      }
    },
  }
}

function waitForLoaded(timeoutMs = 10_000): Promise<void> {
  return waitForStartupMilestone('background-ready', timeoutMs)
}
