import type { ServerCommandTransportOptions } from './commands'
import { canUseClientWriteAccess } from '../clientSession'

type PendingOwnerMutationFlusher = (options: ServerCommandTransportOptions) => void
type PendingOwnerResetter = () => void

const pendingOwnerMutationFlushers = new Map<string, PendingOwnerMutationFlusher>()
const pendingOwnerResetters = new Map<string, PendingOwnerResetter>()

/** Register a lazily loaded owner without making bootstrap import its feature module. */
export function registerPendingOwnerMutationFlusher(id: string, flusher: PendingOwnerMutationFlusher): () => void {
  pendingOwnerMutationFlushers.set(id, flusher)
  return () => {
    if (pendingOwnerMutationFlushers.get(id) === flusher) pendingOwnerMutationFlushers.delete(id)
  }
}

export function flushRegisteredPendingOwnerMutations(options: ServerCommandTransportOptions): void {
  if (!canUseClientWriteAccess()) return
  for (const flusher of pendingOwnerMutationFlushers.values()) flusher(options)
}

/** Flush one owner before a structural action changes the projection it watches. */
export function flushRegisteredPendingOwnerMutation(id: string, options: ServerCommandTransportOptions): boolean {
  if (!canUseClientWriteAccess()) return false
  const flusher = pendingOwnerMutationFlushers.get(id)
  if (!flusher) return false
  flusher(options)
  return true
}

/** Register in-memory state that must not survive a database ownership change. */
export function registerPendingOwnerResetter(id: string, resetter: PendingOwnerResetter): () => void {
  pendingOwnerResetters.set(id, resetter)
  return () => {
    if (pendingOwnerResetters.get(id) === resetter) pendingOwnerResetters.delete(id)
  }
}

export function resetRegisteredOwnerState(): void {
  for (const resetter of pendingOwnerResetters.values()) resetter()
}
