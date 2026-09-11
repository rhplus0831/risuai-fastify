import {
  canUseClientRecoveryAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
  clientSessionStore,
} from '../clientSession'
import { get, writable } from 'svelte/store'
import type { Writable } from 'svelte/store'
import { createSubscriber } from 'svelte/reactivity'
import { registerRetainedChatProjection } from '../server/chatRetainedProjection'
import { getChatTranscriptOwnerState } from '../server/chatTranscriptOwner'
import type { GenerationFinalizationProjectionFence, GenerationFinalizationState } from '../server/bootstrap'
import type { Message } from '../storage/database.svelte'
import { getGenerationOperationsRuntime, getRecoveredEffectsRuntime } from './generationRuntimeBridge'

export interface QueuedGenerationPersistence {
  chatId: string
  messageId: string
  generationId: string
  mode?: 'send' | 'continue' | 'regenerate'
  state?: GenerationFinalizationState
  failureCount?: number
  nextAttemptAt?: string
  provisionalMessage?: Message
  projectionFence?: GenerationFinalizationProjectionFence
}

export type GenerationPersistenceIndicatorState = 'queued' | 'stalled' | 'terminal' | 'stalled_legacy'

const EMPTY_CHAT_FINALIZATIONS: readonly QueuedGenerationPersistence[] = []
const generationFinalizationPersistencesStore = writable<QueuedGenerationPersistence[]>([])
interface ChatFinalizationProjection {
  get(): readonly QueuedGenerationPersistence[]
  set(entries: readonly QueuedGenerationPersistence[]): void
}

function createChatFinalizationProjection(): ChatFinalizationProjection {
  let entries = EMPTY_CHAT_FINALIZATIONS
  let notify = () => {}
  const subscribe = createSubscriber((update) => {
    notify = update
    return () => {
      notify = () => {}
    }
  })
  return {
    get: () => {
      subscribe()
      return entries
    },
    set: (next) => {
      entries = next
      notify()
    },
  }
}

const generationFinalizationPersistencesByChat = new Map<string, ChatFinalizationProjection>()

function finalizationProjectionForChat(chatId: string): ChatFinalizationProjection {
  let projection = generationFinalizationPersistencesByChat.get(chatId)
  if (!projection) {
    projection = createChatFinalizationProjection()
    generationFinalizationPersistencesByChat.set(chatId, projection)
  }
  return projection
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameStructuredValue(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key) => !Object.prototype.hasOwnProperty.call(rightRecord, key))
  ) {
    return false
  }
  return leftKeys.every((key) => sameStructuredValue(leftRecord[key], rightRecord[key]))
}

function sameFinalizationEntries(
  left: readonly QueuedGenerationPersistence[],
  right: readonly QueuedGenerationPersistence[],
): boolean {
  return left.length === right.length && left.every((entry, index) => sameStructuredValue(entry, right[index]))
}

function groupFinalizationsByChat(
  entries: readonly QueuedGenerationPersistence[],
): Map<string, QueuedGenerationPersistence[]> {
  const grouped = new Map<string, QueuedGenerationPersistence[]>()
  for (const entry of entries) {
    const chatEntries = grouped.get(entry.chatId)
    if (chatEntries) chatEntries.push(entry)
    else grouped.set(entry.chatId, [entry])
  }
  return grouped
}

function publishGenerationFinalizationPersistences(entries: readonly QueuedGenerationPersistence[]): void {
  const previous = get(generationFinalizationPersistencesStore)
  if (sameFinalizationEntries(previous, entries)) return

  const previousByChat = groupFinalizationsByChat(previous)
  const next = [...entries]
  const nextByChat = groupFinalizationsByChat(next)
  const chatIds = new Set([...previousByChat.keys(), ...nextByChat.keys()])
  for (const chatId of chatIds) {
    const previousChatEntries = previousByChat.get(chatId) ?? EMPTY_CHAT_FINALIZATIONS
    const nextChatEntries = nextByChat.get(chatId) ?? EMPTY_CHAT_FINALIZATIONS
    if (sameFinalizationEntries(previousChatEntries, nextChatEntries)) continue
    finalizationProjectionForChat(chatId).set(nextChatEntries)
  }
  generationFinalizationPersistencesStore.set(next)
}

export const generationFinalizationPersistences: Writable<QueuedGenerationPersistence[]> = {
  subscribe: generationFinalizationPersistencesStore.subscribe,
  set: publishGenerationFinalizationPersistences,
  update: (updater) => publishGenerationFinalizationPersistences(updater(get(generationFinalizationPersistencesStore))),
}
/** Compatibility alias for callers that only knew about the original live queued state. */
export const queuedGenerationPersistences = generationFinalizationPersistences

const retainedProjectionReleases = new Map<string, () => void>()
// Smoke builds poll observably rather than spending five seconds on each UI assertion.
// Production retains the bounded five-second refresh cadence.
const GENERATION_FINALIZATION_REFRESH_INTERVAL_MS = import.meta.env.VITE_FASTIFY_BROWSER_SMOKE === 'TRUE' ? 100 : 5_000
let refreshEnabled = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight = false
let refreshEpoch = 0

function hasReplayableFinalizations(entries: readonly QueuedGenerationPersistence[]): boolean {
  return entries.some((entry) => entry.state === undefined || entry.state === 'queued' || entry.state === 'stalled')
}

function scheduleGenerationFinalizationRefresh(entries: readonly QueuedGenerationPersistence[]): void {
  if (
    !canUseClientRecoveryAccess() ||
    !refreshEnabled ||
    refreshTimer ||
    refreshInFlight ||
    !hasReplayableFinalizations(entries)
  )
    return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshGenerationFinalizationPersistences()
  }, GENERATION_FINALIZATION_REFRESH_INTERVAL_MS)
}

async function refreshGenerationFinalizationPersistences(): Promise<void> {
  if (!canUseClientRecoveryAccess() || !refreshEnabled || refreshInFlight) return
  const sourceGeneration = captureClientSessionGeneration()
  const startedEpoch = refreshEpoch
  const isCurrent = () =>
    refreshEnabled &&
    startedEpoch === refreshEpoch &&
    canUseClientRecoveryAccess() &&
    isClientSessionGenerationCurrent(sourceGeneration)
  refreshInFlight = true
  const retryTriggers = get(generationFinalizationPersistences).filter(
    (entry) => entry.state === undefined || entry.state === 'queued' || entry.state === 'stalled',
  )
  try {
    const { fetchServerBootstrapReadOnly } = await import('../server/bootstrap')
    if (!isCurrent()) return
    const result = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
    if (isCurrent() && result.status === 'ok' && result.bootstrap.generationFinalizations) {
      const { applyGenerationOperationBootstrap, generationOperationProjections } = getGenerationOperationsRuntime()
      const recoveredGenerationEffects = getRecoveredEffectsRuntime()
      if (!applyGenerationOperationBootstrap(result.bootstrap, 'bootstrap') || !isCurrent()) return
      const acceptedOperations = get(generationOperationProjections)
      recoveredGenerationEffects.setPendingRecoveredGenerationEffects(result.bootstrap.pendingGenerationEffects ?? [])
      await recoveredGenerationEffects.reconcilePendingRecoveredGenerationEffects()
      // Keep the last queued/stalled projection as the refresh trigger until
      // every newly published effect has reconciled. Clearing it first would
      // leave no timer owner when a transient effect runtime failure occurs.
      if (isCurrent() && get(generationOperationProjections) === acceptedOperations) {
        setGenerationFinalizationPersistences(result.bootstrap.generationFinalizations)
      }
    }
  } catch {
    if (!isCurrent()) return
    // Recovered-effect reconciliation force-hydrates the committed transcript.
    // That hydration can acknowledge and clear the provisional row before a
    // transient effect failure is reported. Restore only missing trigger rows
    // so the bounded refresh loop retains an owner for the next retry without
    // overwriting any newer finalization projection.
    const current = get(generationFinalizationPersistences)
    const missingRetryTriggers = retryTriggers.filter(
      (trigger) =>
        !current.some((entry) => entry.chatId === trigger.chatId && entry.generationId === trigger.generationId),
    )
    if (missingRetryTriggers.length > 0) {
      setGenerationFinalizationPersistences([...current, ...missingRetryTriggers])
    }
    // Keep the last truthful projection; the next bounded refresh can retry.
  } finally {
    refreshInFlight = false
    scheduleGenerationFinalizationRefresh(get(generationFinalizationPersistences))
  }
}

function releaseRetainedFinalizationProjections(): void {
  for (const release of retainedProjectionReleases.values()) release()
  retainedProjectionReleases.clear()
}

function messageMatches(left: Message | undefined, right: Message | undefined): boolean {
  return sameStructuredValue(left, right)
}

function findChatMessages(chatId: string): Message[] | null {
  return getChatTranscriptOwnerState(chatId)?.messages ?? null
}

function reapplyGenerationFinalizationProjection(entry: QueuedGenerationPersistence): void {
  const message = entry.provisionalMessage
  const fence = entry.projectionFence
  if (!canUseClientRecoveryAccess() || !message || !fence) return
  const messages = findChatMessages(entry.chatId)
  if (!messages) return
  if (
    messages.some(
      (candidate) =>
        candidate.generationInfo?.generationId === entry.generationId ||
        (candidate.chatId === entry.messageId && messageMatches(candidate, message)),
    )
  ) {
    return
  }
  if (messages.length !== fence.transcriptLength) return
  const tail = messages.at(-1)
  if (fence.kind === 'target-tail') {
    if (!messageMatches(tail, fence.target.message)) return
    messages[messages.length - 1] = structuredClone(message)
    return
  }
  if (fence.tail ? !messageMatches(tail, fence.tail.message) : tail !== undefined) return
  messages.push(structuredClone(message))
}

/** Replace the writer-scoped bootstrap projection and retain its safe provisional rows across hydration. */
export function setGenerationFinalizationPersistences(entries: readonly QueuedGenerationPersistence[]): void {
  releaseRetainedFinalizationProjections()
  const next = entries.map((entry) => structuredClone(entry))
  generationFinalizationPersistences.set(next)
  const sourceGeneration = captureClientSessionGeneration()
  for (const entry of next) {
    if (
      !canUseClientRecoveryAccess() ||
      !entry.provisionalMessage ||
      !entry.projectionFence ||
      entry.state === 'committed_cleanup_pending'
    )
      continue
    const release = registerRetainedChatProjection(
      { kind: 'chat-body', chatId: entry.chatId },
      () => isClientSessionGenerationCurrent(sourceGeneration) && reapplyGenerationFinalizationProjection(entry),
    )
    retainedProjectionReleases.set(entry.generationId, release)
  }
  scheduleGenerationFinalizationRefresh(next)
}

export function markGenerationPersistenceQueued(entry: QueuedGenerationPersistence): void {
  if (!canUseClientRecoveryAccess()) return
  generationFinalizationPersistences.update((entries) => [
    ...entries.filter(
      (candidate) => candidate.chatId !== entry.chatId || candidate.generationId !== entry.generationId,
    ),
    entry,
  ])
  scheduleGenerationFinalizationRefresh([entry])
}

export function clearGenerationPersistence(chatId: string, generationId: string): void {
  const entries = get(generationFinalizationPersistences)
  if (!entries.some((entry) => entry.chatId === chatId && entry.generationId === generationId)) return
  retainedProjectionReleases.get(generationId)?.()
  retainedProjectionReleases.delete(generationId)
  publishGenerationFinalizationPersistences(
    entries.filter((entry) => entry.chatId !== chatId || entry.generationId !== generationId),
  )
}

export function getGenerationFinalizationPersistencesForChat(
  chatId: string | undefined,
): readonly QueuedGenerationPersistence[] {
  if (!chatId) return EMPTY_CHAT_FINALIZATIONS
  return finalizationProjectionForChat(chatId).get()
}

export interface GenerationPersistenceStateLookup {
  byMessageId: ReadonlyMap<string, GenerationPersistenceIndicatorState>
  byGenerationId: ReadonlyMap<string, GenerationPersistenceIndicatorState>
}

export function buildGenerationPersistenceStateLookup(
  entries: readonly QueuedGenerationPersistence[],
): GenerationPersistenceStateLookup {
  const byMessageId = new Map<string, GenerationPersistenceIndicatorState>()
  const byGenerationId = new Map<string, GenerationPersistenceIndicatorState>()
  for (const entry of entries) {
    const state = entry.state ?? 'queued'
    if (state !== 'queued' && state !== 'stalled' && state !== 'terminal' && state !== 'stalled_legacy') continue
    if (!byMessageId.has(entry.messageId)) byMessageId.set(entry.messageId, state)
    if (!byGenerationId.has(entry.generationId)) byGenerationId.set(entry.generationId, state)
  }
  return { byMessageId, byGenerationId }
}

export function generationPersistenceStateFromLookup(
  lookup: GenerationPersistenceStateLookup,
  message: Message,
): GenerationPersistenceIndicatorState | null {
  const messageState = message.chatId ? lookup.byMessageId.get(message.chatId) : undefined
  if (messageState) return messageState
  const generationId = message.generationInfo?.generationId
  return generationId ? (lookup.byGenerationId.get(generationId) ?? null) : null
}

export function generationPersistenceStateForMessage(
  entries: readonly QueuedGenerationPersistence[],
  chatId: string | undefined,
  message: Message,
): GenerationPersistenceIndicatorState | null {
  if (!chatId) return null
  const entry = entries.find(
    (candidate) =>
      candidate.chatId === chatId &&
      (candidate.messageId === message.chatId || candidate.generationId === message.generationInfo?.generationId),
  )
  const state = entry?.state ?? (entry ? 'queued' : undefined)
  return state === 'queued' || state === 'stalled' || state === 'terminal' || state === 'stalled_legacy' ? state : null
}

/** Clear provisional badges only when an authoritative hydration contains the queued generation. */
export function acknowledgeHydratedGenerationPersistences(chatId: string, messages: readonly Message[]): void {
  const entries = get(generationFinalizationPersistences)
  const acknowledgedGenerationIds = new Set<string>()
  const next = entries.filter((entry) => {
    if (entry.chatId !== chatId || entry.state === 'terminal' || entry.state === 'stalled_legacy') return true
    const acknowledged = messages.some(
      (message) =>
        message.generationInfo?.generationId === entry.generationId ||
        (entry.messageId === entry.generationId && message.chatId === entry.generationId),
    )
    if (acknowledged) acknowledgedGenerationIds.add(entry.generationId)
    return !acknowledged
  })
  if (acknowledgedGenerationIds.size === 0) return
  for (const generationId of acknowledgedGenerationIds) {
    retainedProjectionReleases.get(generationId)?.()
    retainedProjectionReleases.delete(generationId)
  }
  publishGenerationFinalizationPersistences(next)
}

export function resetGenerationFinalizationPersistencesForTests(): void {
  stopGenerationFinalizationPersistenceRefresh()
  releaseRetainedFinalizationProjections()
  generationFinalizationPersistences.set([])
}

export function startGenerationFinalizationPersistenceRefresh(): void {
  if (!canUseClientRecoveryAccess()) return
  if (!refreshEnabled) refreshEpoch += 1
  refreshEnabled = true
  scheduleGenerationFinalizationRefresh(get(generationFinalizationPersistences))
}

export function stopGenerationFinalizationPersistenceRefresh(): void {
  refreshEpoch += 1
  refreshEnabled = false
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
}

clientSessionStore.subscribe(() => {
  if (canUseClientRecoveryAccess()) return
  stopGenerationFinalizationPersistenceRefresh()
  releaseRetainedFinalizationProjections()
})
