import {
  canUseClientRecoveryAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { dispatchDurableMutationReplay } from './durableMutationDispatch'
import { dispatchGenerationOperationPendingReplay } from './generationOperations'
import { isGenerationOperationPendingIntent, listPendingMutations } from './pendingMutationOutbox'

export interface PendingMutationReplaySummary {
  attempted: number
  discarded: number
  retained: number
  succeeded: number
  /** Durable Stop controls retained for UI/status reconciliation; never block resource hydration. */
  controlRetained?: number
}

/**
 * Drain this writer/database's durable autosaves after authenticated bootstrap
 * or after an in-session event-stream reconnect. Bootstrap callers run this
 * before resource hydration; reconnect callers retain live optimistic overlays
 * until each replay publishes its final settlement. Transient and genuine
 * stale-writer failures stay encrypted for a later retry; conclusive request,
 * lineage, receipt-ID, and malformed permanent-status failures are explicitly
 * reported before disposal.
 */
export async function replayPendingMutations(): Promise<PendingMutationReplaySummary> {
  const generation = captureClientSessionGeneration()
  const current = () => canUseClientRecoveryAccess() && isClientSessionGenerationCurrent(generation)
  const summary: PendingMutationReplaySummary = { attempted: 0, discarded: 0, retained: 0, succeeded: 0 }
  if (!current()) return summary
  const entries = await listPendingMutations()
  // A Stop and its submit may both survive a crash. Deliver the cancellation
  // first for latency; the server tombstone/state machine makes either order
  // equivalent. listPendingMutations() already returns the remaining entries
  // in their committed IndexedDB order. Do not re-sort them by sequence: that
  // value is generated from each tab's wall clock and is not a cross-tab
  // ordering authority.
  entries.sort((left, right) => {
    const leftCancel = left.intent.kind === 'generation-operation-cancel' ? 0 : 1
    const rightCancel = right.intent.kind === 'generation-operation-cancel' ? 0 : 1
    return leftCancel - rightCancel
  })
  const blockedKeys = new Set<string>()
  const retain = (entry: (typeof entries)[number]) => {
    if (entry.intent.kind === 'generation-operation-cancel')
      summary.controlRetained = (summary.controlRetained ?? 0) + 1
    else summary.retained += 1
  }

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!current()) {
      for (const remaining of entries.slice(index)) retain(remaining)
      break
    }
    if (
      blockedKeys.has(entry.handle.key) ||
      (entry.intent.dependencyKeys ?? []).some((dependencyKey) => blockedKeys.has(dependencyKey))
    ) {
      // Propagate the dependency failure into this mutation's own lane so its
      // later successors cannot overtake the skipped correction.
      blockedKeys.add(entry.handle.key)
      summary.retained += 1
      continue
    }
    summary.attempted += 1
    const outcome = isGenerationOperationPendingIntent(entry.intent)
      ? await dispatchGenerationOperationPendingReplay(entry.handle, entry.intent)
      : await dispatchDurableMutationReplay(entry.handle, entry.intent)
    if (outcome.disposition === 'succeeded') {
      summary.succeeded += 1
    } else if (outcome.disposition === 'retained') {
      if (entry.intent.kind === 'generation-operation-cancel') {
        summary.controlRetained = (summary.controlRetained ?? 0) + 1
      } else {
        summary.retained += 1
      }
      blockedKeys.add(entry.handle.key)
      console.warn(`Pending server mutation replay failed for ${entry.handle.key}`, outcome.result)
    } else if (outcome.disposition === 'skipped' && !current()) {
      retain(entry)
    } else if (outcome.disposition === 'discarded') {
      summary.discarded += 1
      console.warn(`Pending server mutation was discarded for ${entry.handle.key}`, outcome.result)
    }
  }
  return summary
}
