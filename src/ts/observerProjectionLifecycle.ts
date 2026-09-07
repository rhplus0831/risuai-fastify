import { clearObserverRouteIntent } from './observerRouteIntent'
import { configureClientDiagnostics } from './diagnostics'
import {
  observerShellLifecycleStore,
  setObserverShellLifecycleMode,
  type ObserverProjectionDiscardReason,
} from './observerShellLifecycle.svelte'
import { clearCharacterShellHydrationState } from './server/characterShellHydration.svelte'
import { resetChatHydration } from './server/chatMessageHydration.svelte'
import { clearAppliedServerResourceRevision, clearCachedServerCommandRevision } from './server/commands'
import { resetLorebookHydration } from './server/lorebookOwner.svelte'
import { lorebookPageOwner } from './server/lorebookPageOwner.svelte'
import { resetPromptTemplateHydration } from './server/promptTemplateHydration'
import { clearResourceCache } from './server/resourceCache'
import {
  resetServerResourceState,
  resetServerResourceRevisionFencesForDatabaseReplacement,
} from './server/resourceState.svelte'
import { selectedCharID } from './stores.svelte'
import { requireClientAuthentication } from './clientSession'
import { resetMemoryJobProjection } from './server/memoryJobProjection.svelte'
import { resetBardWikiResource } from './server/bardWikiResource'

/**
 * Drop observer-era local intent and optional detail identities whenever their
 * authentication or database ownership scope is no longer valid. Only auth
 * loss blanks the authenticated shell immediately; replacement refreshes keep
 * the old shell visible until their authoritative snapshot is ready.
 */
export async function discardObserverProjectionState(reason: ObserverProjectionDiscardReason): Promise<void> {
  if (reason === 'auth-loss') {
    // Revoke authority and capture mounted drafts before the first asynchronous
    // cache operation or UI teardown. Late reads now carry an obsolete generation.
    requireClientAuthentication()
    configureClientDiagnostics(undefined)
    resetServerResourceState()
    selectedCharID.set(-1)
    clearCachedServerCommandRevision()
    clearAppliedServerResourceRevision()
    setObserverShellLifecycleMode('auth-lost')
  }
  clearObserverRouteIntent()
  clearCharacterShellHydrationState()
  resetChatHydration()
  resetLorebookHydration()
  lorebookPageOwner.reset()
  resetPromptTemplateHydration()
  resetMemoryJobProjection()
  resetBardWikiResource()
  if (reason !== 'auth-loss') {
    clearCachedServerCommandRevision()
    clearAppliedServerResourceRevision()
    resetServerResourceRevisionFencesForDatabaseReplacement()
  }
  await clearResourceCache()

  observerShellLifecycleStore.update((state) => ({ ...state, lastDiscardReason: reason }))
}
