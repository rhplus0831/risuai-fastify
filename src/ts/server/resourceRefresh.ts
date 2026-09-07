import { selectedCharID } from '../stores.svelte'
import {
  canUseClientRecoveryAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
  isClientSessionManaged,
} from '../clientSession'
import {
  mergePendingAgentPresetCharactersResource,
  mergePendingAgentPresetLoadoutsResource,
  mergePendingAgentPresetSettingsResource,
} from '../agentPresets'
import {
  mergePendingPluginCollectionResource,
  mergePendingPluginProviderResource,
  mergePendingPluginStorageResource,
} from '../pluginCommands'
import { reapplyPendingPresetProjections } from '../storage/database.svelte'
import { reapplyPendingPromptTemplateStructuralProjections } from './promptTemplateMutations.svelte'
import { triggerOpenChatGenerationReattach } from '../process/reattach'
import { applyServerChatMessagesResource, hydrateActiveChat, resetChatHydration } from './chatMessageHydration.svelte'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  peekAppliedServerResourceRevision,
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
  type CommandEvent,
} from './commands'
import {
  applyServerCharacterLorebookResource,
  markCharacterLorebookHydrated,
  recordCanonicalCharacterLorebookScopes,
  recordCanonicalLorebookCollections,
  recordHydratedCharacterLorebooks,
  resetLorebookHydration,
} from './lorebookOwner.svelte'
import {
  charactersResourceState,
  resetServerResourceRevisionFencesForDatabaseReplacement,
} from './resourceState.svelte'
import { clearActiveMessageTranslation, setActiveMessageTranslations } from './messageTranslationJobs'
import {
  clearGreetingTranslationProjection,
  refreshGreetingTranslationProjection,
  setActiveGreetingTranslations,
} from './greetingTranslations.svelte'
import { fetchServerBootstrapReadOnly } from './bootstrap'
import { applyGenerationOperationBootstrap } from './generationOperations'
import { recordFullResourceRefresh } from './protocolDiagnostics'
import { ensurePromptTemplateHydrated } from './promptTemplateHydration'
import { hydrateSelectedCharacterShell } from './characterShellHydration.svelte'
import {
  refreshAllServerResources,
  refreshInvalidatedServerResources,
  type ServerResourceInvalidationHooks,
} from './resourceInvalidation'
import {
  resolveSelectedCharacterIndexAfterRefresh,
  trackSelectedCharacterDuringRefresh,
  type SelectedCharacterRefreshSnapshot,
} from './selectedCharacterRefresh'

export type ServerResourceRefreshResult =
  | { status: 'ok'; revision: number }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

let serverResourceRefreshPromise: Promise<ServerResourceRefreshResult> | null = null
let serverResourceRefreshGeneration = -1
let serverResourceRefreshPending = false
let serverDatabaseReplacementRefreshPending = false
let serverDatabaseReplacementDiscardPromise: Promise<void> | null = null

export const serverResourceInvalidationHooks: ServerResourceInvalidationHooks = {
  reapplyPendingPresetProjections,
  reapplyPendingPromptTemplateStructuralProjections,
  mergePendingAgentPresetSettings: mergePendingAgentPresetSettingsResource,
  mergePendingAgentPresetLoadouts: mergePendingAgentPresetLoadoutsResource,
  mergePendingAgentPresetCharacters: mergePendingAgentPresetCharactersResource,
  mergePendingPluginCollection: mergePendingPluginCollectionResource,
  mergePendingPluginProvider: mergePendingPluginProviderResource,
  mergePendingPluginStorage: mergePendingPluginStorageResource,
  applyChatMessages: applyServerChatMessagesResource,
  applyCharacterLorebook: applyServerCharacterLorebookResource,
  markCharacterLorebookHydrated,
  recordCanonicalCharacterLorebookScopes,
  recordCanonicalLorebookCollections,
  triggerOpenChatGenerationReattach,
  clearActiveMessageTranslation,
  refreshGreetingTranslations: async (characterId, minimumRevision) => {
    clearGreetingTranslationProjection(characterId)
    const character = readyCharacterOwners().find((candidate) => candidate.chaId === characterId)
    const chatId = character?.chats?.[character.chatPage]?.id
    if (!chatId) return true
    const result = await refreshGreetingTranslationProjection(characterId, chatId, { minimumRevision })
    return result.status === 'ok'
  },
}

/**
 * Coalesced, authoritative refresh used after restores, replay gaps, and other
 * cases where a narrow command-event invalidation is not safe.
 */
export async function forceServerResourceRefresh(
  reason: string,
  options: { resource?: string } = {},
): Promise<ServerResourceRefreshResult> {
  if (!canUseClientRecoveryAccess()) return { status: 'unavailable' }
  const generation = captureClientSessionGeneration()
  recordFullResourceRefresh(reason, options.resource)
  if (serverResourceRefreshPromise && serverResourceRefreshGeneration === generation) {
    serverResourceRefreshPending = true
    return serverResourceRefreshPromise
  }

  serverResourceRefreshGeneration = generation
  const running = runServerResourceRefresh(generation)
  serverResourceRefreshPromise = running
  try {
    return await running
  } finally {
    if (serverResourceRefreshPromise === running) serverResourceRefreshPromise = null
  }
}

/** Force a full snapshot that may legitimately rewind every server revision. */
export function forceServerDatabaseReplacementRefresh(
  reason: string,
  options: { resource?: string } = {},
): Promise<ServerResourceRefreshResult> {
  if (!canUseClientRecoveryAccess()) return Promise.resolve({ status: 'unavailable' })
  const generation = captureClientSessionGeneration()
  serverDatabaseReplacementRefreshPending = true
  serverDatabaseReplacementDiscardPromise ??= import('../observerProjectionLifecycle').then(
    ({ discardObserverProjectionState }) => {
      if (isClientSessionGenerationCurrent(generation) && canUseClientRecoveryAccess())
        return discardObserverProjectionState('database-replacement')
    },
  )
  clearCachedServerCommandRevision()
  clearAppliedServerResourceRevision()
  return forceServerResourceRefresh(reason, options)
}

/**
 * Apply the character-list invalidation returned by a successful Realm import.
 * The imported character originates on the server, so it still needs one
 * authoritative character read, but unrelated settings, collections, runtime
 * jobs, and already-hydrated chat bodies do not.
 *
 * A revision gap can contain an unrelated write that must not be skipped. Keep
 * the complete-refresh fallback for that recovery case; the normal contiguous
 * response and an event already applied from SSE stay narrow.
 */
export async function refreshServerRealmImportResources(input: {
  revision: number
  event: CommandEvent
  characterId: string
}): Promise<ServerResourceRefreshResult> {
  const generation = captureClientSessionGeneration()
  if (!canUseClientRecoveryAccess()) return { status: 'unavailable' }
  const isCurrent = () => isClientSessionGenerationCurrent(generation) && canUseClientRecoveryAccess()
  const appliedRevision = peekAppliedServerResourceRevision()
  if (!isMatchingRealmCharacterCreatedEvent(input) || appliedRevision === null) {
    return forceServerResourceRefresh('realm-import', { resource: input.event.resource })
  }
  if (input.event.revision > appliedRevision + 1) {
    return forceServerResourceRefresh('realm-import', { resource: input.event.resource })
  }

  const selectionTracker = trackSelectedCharacterDuringRefresh()
  try {
    const result = await refreshInvalidatedServerResources(input.event, {
      appliedRevision,
      hooks: serverResourceInvalidationHooks,
      ...(isClientSessionManaged() ? { isCurrent } : {}),
    })
    if (!isCurrent()) return { status: 'unavailable' }
    if (result.status !== 'ok') return result

    if (result.scope === 'full') {
      // This is not expected for a validated, contiguous character.created
      // event, but retain full-refresh hydration semantics if the invalidation
      // planner broadens the event in the future.
      recordFullResourceRefresh('realm-import', input.event.resource)
      return completeFullServerResourceRefresh(result.revision, selectionTracker.snapshot(), generation)
    }

    if (result.scope === 'targeted') {
      // Preserve existing hydration identities. Only mark characters whose
      // character-list payload actually carried a resident lorebook.
      recordHydratedCharacterLorebooks(readyCharacterOwners())
    }
    setCachedServerCommandRevision(result.revision)
    setAppliedServerResourceRevision(result.revision)
    void hydrateSelectedCharacterShell({ supersede: true })
    return { status: 'ok', revision: result.revision }
  } finally {
    selectionTracker.stop()
  }
}

async function runServerResourceRefresh(generation: number): Promise<ServerResourceRefreshResult> {
  let latestResult: ServerResourceRefreshResult | null = null
  const isCurrent = () => isClientSessionGenerationCurrent(generation) && canUseClientRecoveryAccess()

  do {
    if (!isCurrent()) return { status: 'unavailable' }
    serverResourceRefreshPending = false
    if (serverDatabaseReplacementRefreshPending) {
      serverDatabaseReplacementRefreshPending = false
      const discardPromise = serverDatabaseReplacementDiscardPromise
      if (discardPromise) {
        try {
          await discardPromise
        } finally {
          if (serverDatabaseReplacementDiscardPromise === discardPromise) {
            serverDatabaseReplacementDiscardPromise = null
          }
        }
      }
      if (!isCurrent()) return { status: 'unavailable' }
      // A replacement request can join an older full refresh that was already
      // reading the previous database. Reset again after that iteration drains
      // so its higher revision cannot fence out the replacement snapshot.
      clearCachedServerCommandRevision()
      clearAppliedServerResourceRevision()
      resetServerResourceRevisionFencesForDatabaseReplacement()
    }
    const selectionTracker = trackSelectedCharacterDuringRefresh()
    try {
      const result = await refreshAllServerResources({
        hooks: serverResourceInvalidationHooks,
        ...(isClientSessionManaged() ? { isCurrent } : {}),
      })
      if (!isCurrent()) return { status: 'unavailable' }
      if (result.status !== 'ok') {
        latestResult = result
        continue
      }

      latestResult = await completeFullServerResourceRefresh(result.revision, selectionTracker.snapshot(), generation)
    } finally {
      selectionTracker.stop()
    }
  } while (serverResourceRefreshPending || serverDatabaseReplacementRefreshPending)

  return latestResult ?? { status: 'error', error: 'Server resource refresh did not complete' }
}

async function completeFullServerResourceRefresh(
  revision: number,
  selection: SelectedCharacterRefreshSnapshot,
  generation: number,
): Promise<ServerResourceRefreshResult> {
  const isCurrent = () => isClientSessionGenerationCurrent(generation) && canUseClientRecoveryAccess()
  if (!isCurrent()) return { status: 'unavailable' }
  syncSelectedCharacterAfterRefresh(selection)

  // Full character reads intentionally carry message-free chat rows. Reset
  // hydration identities before any later hydration can fail so every chat is
  // fetched again from its REST body endpoint, including same-id transcripts
  // replaced by a backup restore.
  resetChatHydration()
  resetLorebookHydration()
  clearGreetingTranslationProjection()
  recordHydratedCharacterLorebooks(readyCharacterOwners())
  void hydrateActiveChat({ force: true })

  if (!(await ensurePromptTemplateHydrated({ force: true, minimumRevision: revision }))) {
    return { status: 'error', error: 'Selected prompt-template owner hydration failed' }
  }
  if (!isCurrent()) return { status: 'unavailable' }
  reapplyPendingPresetProjections()
  reapplyPendingPromptTemplateStructuralProjections()
  setCachedServerCommandRevision(revision)
  setAppliedServerResourceRevision(revision)
  void hydrateSelectedCharacterShell({ supersede: true })
  await refreshRuntimeJobs(generation)
  if (!isCurrent()) return { status: 'unavailable' }
  triggerOpenChatGenerationReattach()
  return { status: 'ok', revision }
}

function isMatchingRealmCharacterCreatedEvent(input: {
  revision: number
  event: CommandEvent
  characterId: string
}): boolean {
  return (
    Number.isInteger(input.revision) &&
    input.revision >= 0 &&
    input.event.revision === input.revision &&
    input.event.type === 'character.created' &&
    input.event.resource === 'character' &&
    input.event.id === input.characterId
  )
}

function syncSelectedCharacterAfterRefresh(selection: SelectedCharacterRefreshSnapshot): void {
  if (selection.target.selectedIndex < 0) return
  selectedCharID.set(resolveSelectedCharacterIndexAfterRefresh(selection.target))
}

async function refreshRuntimeJobs(generation: number): Promise<void> {
  const runtime = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
  if (!isClientSessionGenerationCurrent(generation) || !canUseClientRecoveryAccess()) return
  if (runtime.status !== 'ok') return
  applyGenerationOperationBootstrap(runtime.bootstrap, 'full_resource_refresh')
  setActiveMessageTranslations(runtime.bootstrap.activeMessageTranslations ?? [])
  setActiveGreetingTranslations(runtime.bootstrap.activeGreetingTranslations ?? [])
}

function readyCharacterOwners() {
  return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
}
