import {
  canUseClientRecoveryAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import {
  acknowledgeServerMutationReceipts,
  replayDurableMutationRequests,
  replayDurableMutationRequestsInline,
  runServerCommandWithoutMutationReceipt,
  runServerCommandWithMutationReceipt,
  type DurableMutationReplayResult,
  type ServerCommandErrorReason,
  type ServerCommandExecutionWrapper,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
} from './commands'
import { schedulePendingMutationRecoveryReload } from './activeWriterSession'
import {
  beginPendingMutationDispatch,
  completePendingMutation,
  deletePendingMutationReceiptAcknowledgement,
  discardPendingMutation,
  isPendingMutationCurrent,
  getPendingMutationHandleSessionGeneration,
  listPendingMutationPredecessors,
  listPendingMutationReceiptAcknowledgements,
  registerPendingMutationDiscardListener,
  replaceStagedPendingMutationIntent,
  type DurableMutationIntent,
  type PendingMutationHandle,
  type PendingMutationReceiptAcknowledgement,
} from './pendingMutationOutbox'

const localMutationLockTails = new Map<string, Promise<void>>()
const locallyClaimedMutationIds = new Set<string>()
export type DurableMutationFinalSettlement = 'accepted' | 'discarded'
export interface DurableMutationFinalSettlementDetails {
  result?: DurableMutationReplayResult
}
type DurableMutationSettlementListener = (
  settlement: DurableMutationFinalSettlement,
  details: DurableMutationFinalSettlementDetails,
) => void
const durableMutationSettlementListeners = new Map<string, Set<DurableMutationSettlementListener>>()
export type PendingMutationDiscardNotifier = (key: string, error: string) => void | Promise<void>
let pendingMutationDiscardNotifier: PendingMutationDiscardNotifier | null = null

/** Install the UI-owned notifier before durable replay or live mutation dispatch begins. */
export function setPendingMutationDiscardNotifier(notifier: PendingMutationDiscardNotifier | null): void {
  pendingMutationDiscardNotifier = notifier
}

/** Observe replay/predecessor settlement for an optimistic projection retained in this page. */
export function registerDurableMutationSettlementListener(
  mutationId: string,
  listener: DurableMutationSettlementListener,
): () => void {
  const listeners = durableMutationSettlementListeners.get(mutationId) ?? new Set()
  listeners.add(listener)
  durableMutationSettlementListeners.set(mutationId, listeners)
  return () => {
    const current = durableMutationSettlementListeners.get(mutationId)
    current?.delete(listener)
    if (current?.size === 0) durableMutationSettlementListeners.delete(mutationId)
  }
}

function publishDurableMutationFinalSettlement(
  mutationId: string,
  settlement: DurableMutationFinalSettlement,
  details: DurableMutationFinalSettlementDetails = {},
): void {
  const listeners = [...(durableMutationSettlementListeners.get(mutationId) ?? [])]
  durableMutationSettlementListeners.delete(mutationId)
  for (const listener of listeners) {
    try {
      listener(settlement, details)
    } catch (error) {
      console.error('Durable mutation settlement listener rejected:', error)
    }
  }
}

/** Settle listeners whose shared outbox rows may already be gone in another tab. */
export function discardRegisteredDurableMutationSettlements(): number {
  const mutationIds = [...durableMutationSettlementListeners.keys()]
  for (const mutationId of mutationIds) publishDurableMutationFinalSettlement(mutationId, 'discarded')
  return mutationIds.length
}

export function countRegisteredDurableMutationSettlements(): number {
  return durableMutationSettlementListeners.size
}

registerPendingMutationDiscardListener((mutationId) => {
  publishDurableMutationFinalSettlement(mutationId, 'discarded')
})

export interface PreparedDurableMutationExecutionInput {
  handle: PendingMutationHandle
  intent: DurableMutationIntent
  standaloneIntent?: DurableMutationIntent
  onStandaloneIntent?: () => void
}

export type DurableMutationSettlement = 'accepted' | 'discarded' | 'retained' | 'superseded' | 'unavailable'

export type PreparedDurableMutationExecutionOutcome<T extends Record<string, unknown> = {}> =
  | {
      disposition: 'sent'
      handle: PendingMutationHandle
      intent: DurableMutationIntent
      result: ServerCommandResult<T>
      settlement: DurableMutationSettlement
    }
  | {
      disposition: 'retained-without-send'
      handle: PendingMutationHandle
      intent: DurableMutationIntent
      settlement: Extract<DurableMutationSettlement, 'retained' | 'superseded' | 'unavailable'>
    }

export interface DurableMutationDispatchOptions<T extends Record<string, unknown> = {}> {
  /**
   * Reuse a failure already observed by an earlier synchronously reserved
   * queue slot. The check runs under the durable key/mutation locks before
   * predecessor draining, so later batch rows settle without another request.
   */
  beforeExecuteResult?: () => Exclude<ServerCommandResult<T>, { status: 'ok' }> | undefined
}

/**
 * Wait for the exact encrypted generation, acquire an origin-wide lock, then
 * start the network request. Page-exit callers rely on the already-staged row
 * and next-start replay if the asynchronous lock prevents a keepalive request.
 */
export function dispatchDurableMutation<T extends Record<string, unknown> = {}>(
  handle: PendingMutationHandle,
  intent: DurableMutationIntent,
  dispatch: (options: ServerCommandTransportOptions) => Promise<ServerCommandResult<T>>,
  options: DurableMutationDispatchOptions<T> = {},
): Promise<ServerCommandResult<T>> {
  const generation = captureClientSessionGeneration()
  if (!handle.databaseLineage) {
    const executionWrapper: ServerCommandExecutionWrapper = (execute) =>
      withLocalPendingMutationLock(`risu:durable-mutation-unavailable:${handle.key}`, async () => {
        const shortCircuitResult = options.beforeExecuteResult?.()
        if (shortCircuitResult) return shortCircuitResult
        return runServerCommandWithoutMutationReceipt(execute)
      })
    return dispatch({
      executionWrapper,
      failureRollbackDisposition: () => 'rollback',
    })
  }
  // Freeze synchronously before the caller can stage a successor, and enqueue
  // the command synchronously so later structural actions cannot overtake it.
  // IndexedDB transactions begin asynchronously, so claim the exact ID in
  // memory first to guarantee that duplicate same-page callers cannot race and
  // let the later caller become the durable dispatcher.
  const ownsLocalClaim = !locallyClaimedMutationIds.has(handle.mutationId)
  if (ownsLocalClaim) locallyClaimedMutationIds.add(handle.mutationId)
  const readiness = ownsLocalClaim ? beginPendingMutationDispatch(handle) : Promise.resolve('superseded' as const)
  let settlement: DurableMutationSettlement = 'unavailable'
  const executionWrapper: ServerCommandExecutionWrapper = async (execute) => {
    try {
      return await withPendingMutationDispatchLocks(handle, intent.dependencyKeys ?? [], async () => {
        const persistence = await readiness
        if (persistence === 'superseded') return { status: 'unavailable' }
        if (persistence === 'persisted' && !(await isPendingMutationCurrent(handle))) {
          return { status: 'unavailable' }
        }
        const shortCircuitResult = options.beforeExecuteResult?.()
        if (shortCircuitResult) {
          settlement = await settleDurableMutation(handle, intent, shortCircuitResult, generation)
          return shortCircuitResult
        }
        if (persistence === 'persisted' && !(await drainPendingMutationPredecessors(handle, generation))) {
          settlement = 'retained'
          return { status: 'unavailable' }
        }
        const result =
          persistence === 'unavailable' ? await runServerCommandWithoutMutationReceipt(execute) : await execute()
        settlement = await settleDurableMutation(handle, intent, result, generation)
        return result
      })
    } catch (error) {
      if ((await readiness) === 'persisted') settlement = 'retained'
      throw error
    }
  }
  let dispatched: Promise<ServerCommandResult<T>>
  try {
    dispatched = dispatch({
      mutationId: handle.mutationId,
      databaseLineage: handle.databaseLineage,
      executionWrapper,
      failureRollbackDisposition: () => (settlement === 'retained' ? 'retain' : 'rollback'),
    })
  } catch (error) {
    if (ownsLocalClaim) locallyClaimedMutationIds.delete(handle.mutationId)
    throw error
  }
  return ownsLocalClaim
    ? dispatched.finally(() => {
        locallyClaimedMutationIds.delete(handle.mutationId)
      })
    : dispatched
}

/**
 * Prepare and execute one durable mutation inside an already-reserved global
 * command slot. A full standalone intent is selected when an immutable
 * placeholder or retained predecessor could invalidate a sparse base.
 */
export async function executePreparedDurableMutationWithinQueue<T extends Record<string, unknown> = {}>(
  input: PreparedDurableMutationExecutionInput,
  execute: () => Promise<ServerCommandResult<T>>,
): Promise<PreparedDurableMutationExecutionOutcome<T>> {
  const generation = captureClientSessionGeneration()
  if (!input.handle.databaseLineage) {
    const result = await runServerCommandWithoutMutationReceipt(execute)
    return { disposition: 'sent', handle: input.handle, intent: input.intent, result, settlement: 'unavailable' }
  }

  const anticipatedDependencyKeys = [
    ...(input.intent.dependencyKeys ?? []),
    ...(input.standaloneIntent?.dependencyKeys ?? []),
  ]
  return withPendingMutationDependencyKeyLocks(input.handle, anticipatedDependencyKeys, async (lockedKeys) => {
    let handle = input.handle
    let intent = input.intent
    let standaloneSelected = false

    const replaceIntent = async (
      nextIntent: DurableMutationIntent,
    ): Promise<'replaced' | 'successor' | 'retained' | 'unavailable'> => {
      const replacement = await replaceStagedPendingMutationIntent(handle, nextIntent)
      if (replacement.status === 'replaced' || replacement.status === 'successor') {
        handle = replacement.handle
        intent = nextIntent
        return replacement.status
      }
      if (replacement.status === 'unavailable' && (await input.handle.ready) === 'unavailable') {
        return 'unavailable'
      }
      return 'retained'
    }

    const selectStandaloneIntent = async (): Promise<'ready' | 'retained' | 'unavailable'> => {
      if (standaloneSelected || !input.standaloneIntent) return 'ready'
      const replacement = await replaceIntent(input.standaloneIntent)
      if (replacement !== 'replaced' && replacement !== 'successor') return replacement
      standaloneSelected = true
      input.onStandaloneIntent?.()
      return 'ready'
    }

    const exactReplacement = await replaceIntent(intent)
    if (exactReplacement === 'unavailable') {
      if (input.standaloneIntent) {
        intent = input.standaloneIntent
        standaloneSelected = true
        input.onStandaloneIntent?.()
      }
      const result = await runServerCommandWithoutMutationReceipt(execute)
      return { disposition: 'sent' as const, handle, intent, result, settlement: 'unavailable' as const }
    }
    if (exactReplacement === 'retained') {
      return { disposition: 'retained-without-send' as const, handle, intent, settlement: 'retained' as const }
    }
    if (exactReplacement === 'successor') {
      const standalone = await selectStandaloneIntent()
      if (standalone === 'unavailable') {
        if (input.standaloneIntent && !standaloneSelected) {
          intent = input.standaloneIntent
          standaloneSelected = true
          input.onStandaloneIntent?.()
        }
        const result = await runServerCommandWithoutMutationReceipt(execute)
        return { disposition: 'sent' as const, handle, intent, result, settlement: 'unavailable' as const }
      }
      if (standalone === 'retained') {
        return { disposition: 'retained-without-send' as const, handle, intent, settlement: 'retained' as const }
      }
    }

    const predecessors = await listPendingMutationPredecessors(handle)
    if (predecessors.status !== 'ok') {
      return {
        disposition: 'retained-without-send' as const,
        handle,
        intent,
        settlement: predecessors.status,
      }
    }
    if (predecessors.entries.length > 0) {
      const standalone = await selectStandaloneIntent()
      if (standalone !== 'ready') {
        return { disposition: 'retained-without-send' as const, handle, intent, settlement: standalone }
      }
    }

    // Exact replacement can create a later successor when another tab marked
    // the placeholder first. Re-read its closure and never acquire a newly
    // discovered key out of order while the current sorted lock set is held.
    const preparedPredecessors = await listPendingMutationPredecessors(handle)
    if (
      preparedPredecessors.status !== 'ok' ||
      preparedPredecessors.semanticKeys.some((semanticKey) => !lockedKeys.has(semanticKey))
    ) {
      return {
        disposition: 'retained-without-send' as const,
        handle,
        intent,
        settlement: preparedPredecessors.status === 'ok' ? 'retained' : preparedPredecessors.status,
      }
    }
    if (preparedPredecessors.entries.length > 0 && !(await drainPendingMutationPredecessors(handle, generation))) {
      return { disposition: 'retained-without-send' as const, handle, intent, settlement: 'retained' as const }
    }

    const persistence = await beginPendingMutationDispatch(handle)
    if (persistence !== 'persisted') {
      return { disposition: 'retained-without-send' as const, handle, intent, settlement: persistence }
    }

    return withPendingMutationLock(handle.databaseLineage!, handle.mutationId, async () => {
      if (!(await isPendingMutationCurrent(handle))) {
        return { disposition: 'retained-without-send' as const, handle, intent, settlement: 'superseded' as const }
      }
      const result = await runServerCommandWithMutationReceipt(execute, handle.mutationId, handle.databaseLineage!)
      const settlement = await settleDurableMutation(handle, intent, result, generation)
      return { disposition: 'sent' as const, handle, intent, result, settlement }
    })
  })
}

export interface DurableMutationReplayOutcome {
  disposition: 'discarded' | 'retained' | 'skipped' | 'succeeded'
  result?: DurableMutationReplayResult
}

function isTerminalRequestRejection(reason: ServerCommandErrorReason | undefined): boolean {
  return reason === 'invalid-request' || reason === 'not-found' || reason === 'unrecognized-rejection'
}

function shouldDiscardDurableMutation(reason: ServerCommandErrorReason | undefined): boolean {
  return isTerminalRequestRejection(reason) || reason === 'database-lineage' || reason === 'mutation-id-conflict'
}

export async function dispatchDurableMutationReplay(
  handle: PendingMutationHandle,
  intent: DurableMutationIntent,
): Promise<DurableMutationReplayOutcome> {
  const generation = captureClientSessionGeneration()
  const current = () => canUseClientRecoveryAccess() && isClientSessionGenerationCurrent(generation)
  if (!current()) return { disposition: 'retained' }
  if (!handle.databaseLineage) return { disposition: 'discarded' }
  return withPendingMutationDispatchLocks(handle, intent.dependencyKeys ?? [], async () => {
    if (!current()) return { disposition: 'retained' }
    const persistence = await beginPendingMutationDispatch(handle)
    if (!current()) return { disposition: 'retained' }
    if (persistence !== 'persisted') return { disposition: 'skipped' }

    const result = await replayDurableMutationRequests(intent.requests, handle.mutationId, handle.databaseLineage!)
    if (result.status === 'ok') {
      const completed = await completePendingMutation(handle, intent.requests.length)
      if (completed !== 'deleted') return { disposition: 'skipped', result }
      publishDurableMutationFinalSettlement(handle.mutationId, 'accepted', { result })
      if (current())
        await flushReceiptAcknowledgement(
          {
            mutationId: handle.mutationId,
            requestCount: intent.requests.length,
            databaseLineage: handle.databaseLineage!,
            queuedAt: 0,
          },
          generation,
        )
      return { disposition: 'succeeded', result }
    }
    if (result.status === 'error' && shouldDiscardDurableMutation(result.reason)) {
      const discarded = await discardPendingMutation(handle)
      if (discarded === 'deleted') {
        publishDurableMutationFinalSettlement(handle.mutationId, 'discarded', { result })
        if (current() && isTerminalRequestRejection(result.reason))
          await notifyPendingMutationDiscarded(handle.key, result.error)
      }
      return { disposition: 'discarded', result }
    }
    return { disposition: 'retained', result }
  })
}

async function drainPendingMutationPredecessors(handle: PendingMutationHandle, generation: number): Promise<boolean> {
  const current = () => canUseClientRecoveryAccess() && isClientSessionGenerationCurrent(generation)
  if (!current()) return false
  const predecessors = await listPendingMutationPredecessors(handle)
  if (!current() || predecessors.status !== 'ok') return false

  for (const predecessor of predecessors.entries) {
    if (!current()) return false
    const ready = await withPendingMutationLock(
      predecessor.handle.databaseLineage!,
      predecessor.handle.mutationId,
      async () => {
        if (!current()) return false
        const persistence = await beginPendingMutationDispatch(predecessor.handle)
        if (!current()) return false
        if (persistence === 'superseded') return true
        if (persistence !== 'persisted') return false

        const result = await replayDurableMutationRequestsInline(
          predecessor.intent.requests,
          predecessor.handle.mutationId,
          predecessor.handle.databaseLineage!,
        )
        if (result.status === 'ok') {
          const completed = await completePendingMutation(predecessor.handle, predecessor.intent.requests.length)
          if (completed === 'superseded') return true
          if (completed !== 'deleted') return false
          publishDurableMutationFinalSettlement(predecessor.handle.mutationId, 'accepted', { result })
          await flushReceiptAcknowledgement(
            {
              mutationId: predecessor.handle.mutationId,
              requestCount: predecessor.intent.requests.length,
              databaseLineage: predecessor.handle.databaseLineage!,
              queuedAt: 0,
            },
            generation,
          )
          return true
        }
        if (result.status === 'error' && shouldDiscardDurableMutation(result.reason)) {
          const discarded = await discardPendingMutation(predecessor.handle)
          if (discarded !== 'deleted' && discarded !== 'superseded') return false
          if (discarded === 'deleted') {
            publishDurableMutationFinalSettlement(predecessor.handle.mutationId, 'discarded', { result })
            if (current() && isTerminalRequestRejection(result.reason)) {
              await notifyPendingMutationDiscarded(predecessor.handle.key, result.error)
            }
            // The request was rejected and the durable row is gone, but this
            // page no longer owns the predecessor's optimistic rollback. Stop
            // the successor and let startup replay it before hydrating the
            // authoritative state that removes the rejected projection.
            if (current()) schedulePendingMutationRecoveryReload()
            return false
          }
          // A malformed/orphaned predecessor says nothing about a later exact
          // body. Ownership and lineage failures do, so they still stop here.
          return result.reason === 'mutation-id-conflict' || isTerminalRequestRejection(result.reason)
        }
        return false
      },
    )
    if (!ready || !current()) return false
  }
  return true
}

/**
 * Accepted requests atomically become durable receipt-ACK work. Exact requests
 * rejected as invalid, missing, or carrying an unrecognized permanent-status
 * envelope are dropped with an explicit user-visible notice. A genuine stale
 * writer rejection remains queued for a same-session ownership reclaim.
 * Lineage and receipt-id failures remain terminal; all other failures retry.
 */
export async function settleDurableMutation(
  handle: PendingMutationHandle,
  intent: DurableMutationIntent,
  result: ServerCommandResult | null | undefined,
  generation = getPendingMutationHandleSessionGeneration(handle),
): Promise<DurableMutationSettlement> {
  const current = () => canUseClientRecoveryAccess() && isClientSessionGenerationCurrent(generation)
  if (result?.status === 'ok') {
    const completed = await completePendingMutation(handle, intent.requests.length)
    if (completed !== 'deleted' || !handle.databaseLineage) {
      return completed === 'superseded' ? 'superseded' : 'unavailable'
    }
    await flushReceiptAcknowledgement(
      {
        mutationId: handle.mutationId,
        requestCount: intent.requests.length,
        databaseLineage: handle.databaseLineage,
        queuedAt: 0,
      },
      generation,
    )
    return 'accepted'
  }
  if (result?.status === 'error' && shouldDiscardDurableMutation(result.reason)) {
    const persistence = await handle.ready
    if (persistence !== 'persisted') return persistence
    const discarded = await discardPendingMutation(handle)
    if (discarded === 'deleted') {
      if (current() && isTerminalRequestRejection(result.reason))
        await notifyPendingMutationDiscarded(handle.key, result.error)
      return 'discarded'
    }
    if (discarded === 'superseded') return 'superseded'
    // Never restore a projection while an exact terminal row may still be
    // durable. Startup replay will discard it before authoritative hydration.
    return 'retained'
  }
  const persistence = await handle.ready
  if (persistence === 'persisted') return 'retained'
  return persistence
}

async function notifyPendingMutationDiscarded(key: string, error: string): Promise<void> {
  await pendingMutationDiscardNotifier?.(key, error)
}

/** Retry crash-safe receipt cleanup after authenticated bootstrap. */
export async function flushPendingMutationReceiptAcknowledgements(): Promise<void> {
  const generation = captureClientSessionGeneration()
  const current = () => canUseClientRecoveryAccess() && isClientSessionGenerationCurrent(generation)
  if (!current()) return
  const acknowledgements = await listPendingMutationReceiptAcknowledgements()
  for (const acknowledgement of acknowledgements) {
    if (!current()) return
    await withPendingMutationLock(acknowledgement.databaseLineage, acknowledgement.mutationId, () =>
      flushReceiptAcknowledgement(acknowledgement, generation),
    )
  }
}

async function flushReceiptAcknowledgement(
  acknowledgement: PendingMutationReceiptAcknowledgement,
  generation: number,
): Promise<void> {
  if (!canUseClientRecoveryAccess() || !isClientSessionGenerationCurrent(generation)) return
  const accepted = await acknowledgeServerMutationReceipts(
    acknowledgement.mutationId,
    acknowledgement.requestCount,
    acknowledgement.databaseLineage,
  )
  if (accepted) await deletePendingMutationReceiptAcknowledgement(acknowledgement)
}

async function withPendingMutationLock<T>(
  databaseLineage: string,
  mutationId: string,
  task: () => Promise<T>,
): Promise<T> {
  return withNamedPendingMutationLock(`risu:durable-mutation:${databaseLineage}:${mutationId}`, task)
}

async function withLocalPendingMutationLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  // Web Locks are widely available, but keep same-tab correctness in older
  // engines. Server receipt tombstones remain the cross-tab fallback defense.
  const previous = localMutationLockTails.get(name) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  const queuedTail = previous.then(() => tail)
  localMutationLockTails.set(name, queuedTail)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (localMutationLockTails.get(name) === queuedTail) localMutationLockTails.delete(name)
  }
}

function withPendingMutationDispatchLocks<T>(
  handle: PendingMutationHandle,
  dependencyKeys: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  return withPendingMutationDependencyKeyLocks(handle, dependencyKeys, () =>
    withPendingMutationLock(handle.databaseLineage!, handle.mutationId, task),
  )
}

const RETRY_DEPENDENCY_KEY_LOCKS = Symbol('retry-dependency-key-locks')

async function withPendingMutationDependencyKeyLocks<T>(
  handle: PendingMutationHandle,
  dependencyKeys: readonly string[],
  task: (lockedKeys: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
  const knownKeys = new Set<string>([handle.key, ...dependencyKeys])
  while (true) {
    const discovery = await listPendingMutationPredecessors(handle, dependencyKeys)
    if (discovery.status === 'ok') {
      for (const semanticKey of discovery.semanticKeys) knownKeys.add(semanticKey)
    }

    const sortedKeys = Array.from(knownKeys).sort()
    const lockedKeys = new Set(sortedKeys)
    const outcome = await withPendingMutationKeyLocks(handle.databaseLineage!, sortedKeys, async () => {
      const recheck = await listPendingMutationPredecessors(handle, dependencyKeys)
      if (recheck.status === 'ok') {
        const missingKeys = recheck.semanticKeys.filter((semanticKey) => !lockedKeys.has(semanticKey))
        if (missingKeys.length > 0) return { retry: RETRY_DEPENDENCY_KEY_LOCKS, missingKeys } as const
      }
      return { value: await task(lockedKeys) } as const
    })
    if ('value' in outcome) return outcome.value
    for (const semanticKey of outcome.missingKeys) knownKeys.add(semanticKey)
  }
}

function withPendingMutationKeyLocks<T>(
  databaseLineage: string,
  semanticKeys: readonly string[],
  task: () => Promise<T>,
  index = 0,
): Promise<T> {
  const semanticKey = semanticKeys[index]
  if (semanticKey === undefined) return task()
  return withNamedPendingMutationLock(`risu:durable-mutation-key:${databaseLineage}:${semanticKey}`, () =>
    withPendingMutationKeyLocks(databaseLineage, semanticKeys, task, index + 1),
  )
}

async function withNamedPendingMutationLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const lockManager = globalThis.navigator?.locks
  if (lockManager) return lockManager.request(name, { mode: 'exclusive' }, task)
  return withLocalPendingMutationLock(name, task)
}
