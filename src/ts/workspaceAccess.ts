import {
  canRenderClientReadView,
  canUseClientWriteAccess,
  clientSessionStore,
  getClientSessionSnapshot,
  hasResolvedClientSessionRole,
} from './clientSession'
import { canApplyRoutes, canGenerate, canMutate, canRenderShell, startupCoordinatorStore } from './startupReadiness'

export type WorkspacePresentationMode = 'booting' | 'read-only' | 'promoting' | 'writer'

export interface WorkspaceAccessSnapshot {
  /** Presentation only. Operation admission remains in the narrow capability guards. */
  readonly mode: WorkspacePresentationMode
  /** An established role has a coherent projection available for local browsing. */
  readonly canBrowse: boolean
  /** Writer-owned route handlers may apply persisted selection. */
  readonly canApplyWriterRoute: boolean
  /** Mirrors the existing ordinary mutation guard without replacing it. */
  readonly canMutate: boolean
  /** Mirrors the stricter generation guard without replacing it. */
  readonly canGenerate: boolean
}

export interface WorkspaceAccessReadable {
  subscribe(run: (snapshot: WorkspaceAccessSnapshot) => void): () => void
}

export function getWorkspaceAccessSnapshot(): WorkspaceAccessSnapshot {
  const session = getClientSessionSnapshot()
  const establishedManagedRole = session.managed && hasResolvedClientSessionRole()
  const canBrowse = session.managed ? establishedManagedRole && canRenderClientReadView() : canRenderShell()
  const canApplyWriterRoute = canApplyRoutes() && canUseClientWriteAccess()
  const mutationReady = canMutate()
  const generationReady = canGenerate()

  let mode: WorkspacePresentationMode = 'booting'
  if (canApplyWriterRoute && mutationReady) mode = 'writer'
  else if (
    canBrowse &&
    session.managed &&
    establishedManagedRole &&
    (session.lifecycle === 'promoting' || session.lifecycle === 'recovering-writer')
  )
    mode = 'promoting'
  else if (canBrowse && session.managed && session.lifecycle === 'reading') mode = 'read-only'

  return Object.freeze({
    mode,
    canBrowse,
    canApplyWriterRoute,
    canMutate: mutationReady,
    canGenerate: generationReady,
  })
}

export const workspaceAccessStore: WorkspaceAccessReadable = {
  subscribe(run) {
    let sessionInitialized = false
    let readinessInitialized = false
    const publish = () => {
      if (sessionInitialized && readinessInitialized) run(getWorkspaceAccessSnapshot())
    }
    const stopSession = clientSessionStore.subscribe(() => {
      sessionInitialized = true
      publish()
    })
    const stopReadiness = startupCoordinatorStore.subscribe(() => {
      readinessInitialized = true
      publish()
    })
    return () => {
      stopSession()
      stopReadiness()
    }
  },
}
