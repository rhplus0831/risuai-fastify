import {
  canUseClientRecoveryAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { getActiveWriterSessionId } from './activeWriterSession'
import {
  countRegisteredDurableMutationSettlements,
  discardRegisteredDurableMutationSettlements,
} from './durableMutationDispatch'
import { resetRegisteredOwnerState } from './pendingOwnerMutationRegistry'
import { preparePendingMutationOutbox } from './pendingMutationOutbox'

export interface ReplacementDatabaseOwnership {
  databaseLineage: string
  writerEpoch: number
}

export interface ReplacementDatabaseOwnershipAdoption {
  discarded: number
  ownershipChanged: boolean
}

let localReplacementOperations = 0
let localReplacementOperationsIdle: Promise<void> = Promise.resolve()
let resolveLocalReplacementOperationsIdle: (() => void) | null = null
let successfullyRefreshedReplacementOwnershipKey: string | null = null
let pendingReplacementRefreshOwnershipKey: string | null = null

function replacementOwnershipKey(ownership: ReplacementDatabaseOwnership): string {
  return `${ownership.databaseLineage}\u0000${ownership.writerEpoch}`
}

export function markReplacementDatabaseOwnershipRefreshed(ownership: ReplacementDatabaseOwnership): void {
  const ownershipKey = replacementOwnershipKey(ownership)
  successfullyRefreshedReplacementOwnershipKey = ownershipKey
  if (pendingReplacementRefreshOwnershipKey === ownershipKey) pendingReplacementRefreshOwnershipKey = null
}

export function wasReplacementDatabaseOwnershipRefreshed(ownership: ReplacementDatabaseOwnership): boolean {
  return successfullyRefreshedReplacementOwnershipKey === replacementOwnershipKey(ownership)
}

export function hasPendingReplacementDatabaseRefresh(): boolean {
  return pendingReplacementRefreshOwnershipKey !== null
}

export function isReplacementDatabaseOwnershipRefreshPending(ownership: ReplacementDatabaseOwnership): boolean {
  return pendingReplacementRefreshOwnershipKey === replacementOwnershipKey(ownership)
}

/** Keep matching SSE replacement events behind the initiating tab's response path. */
export function beginLocalReplacementDatabaseOperation(): () => void {
  if (localReplacementOperations === 0) {
    localReplacementOperationsIdle = new Promise<void>((resolve) => {
      resolveLocalReplacementOperationsIdle = resolve
    })
  }
  localReplacementOperations += 1
  let finished = false
  return () => {
    if (finished) return
    finished = true
    localReplacementOperations -= 1
    if (localReplacementOperations !== 0) return
    resolveLocalReplacementOperationsIdle?.()
    resolveLocalReplacementOperationsIdle = null
  }
}

export async function waitForLocalReplacementDatabaseOperations(): Promise<void> {
  while (localReplacementOperations > 0) await localReplacementOperationsIdle
}

/**
 * Atomically retire the old database owner's in-memory projections before the
 * outbox admits writes under a replacement lineage.
 */
export async function adoptReplacementDatabaseOwnership(
  ownership: ReplacementDatabaseOwnership,
): Promise<ReplacementDatabaseOwnershipAdoption> {
  ownership = { ...ownership }
  const generation = captureClientSessionGeneration()
  const current = () => canUseClientRecoveryAccess() && isClientSessionGenerationCurrent(generation)
  if (!current()) return { discarded: 0, ownershipChanged: false }
  let locallyDiscarded = 0
  let ownershipChanged = false
  let preparation: { discarded: number }
  try {
    preparation = await preparePendingMutationOutbox({
      writerSessionId: getActiveWriterSessionId(),
      writerEpoch: ownership.writerEpoch,
      databaseLineage: ownership.databaseLineage,
      requestedWriterWasActive: true,
      onOwnershipChange: () => {
        if (!current()) return
        ownershipChanged = true
        pendingReplacementRefreshOwnershipKey = replacementOwnershipKey(ownership)
        locallyDiscarded = countRegisteredDurableMutationSettlements()
        resetRegisteredOwnerState()
        discardRegisteredDurableMutationSettlements()
      },
    })
  } catch (error) {
    if (current()) throw error
    // The initiating server replacement may already be accepted. Stale local
    // preparation must not turn that confirmed result into a rejected import.
    return { discarded: locallyDiscarded, ownershipChanged }
  }
  return {
    discarded: Math.max(preparation.discarded, locallyDiscarded),
    ownershipChanged,
  }
}
