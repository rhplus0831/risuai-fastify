import { get, writable } from 'svelte/store'
import { selectedCharID } from '../stores.svelte'
import type { ActiveGenerationJob, GenerationOperationProjection, ServerBootstrapRuntime } from '../server/bootstrap'
import type { ActiveChatTarget } from '../chatCommands'
import type { GenerationReattachOutcome } from './generationReattachOutcome'
import { setGenerationFinalizationPersistences } from './generationPersistenceState'
import {
  activeChatGenerations,
  findChatGenerationActivity,
  findChatGenerationActivityByChatId,
} from './generationActivity.svelte'
import { recordGenerationRecoveryEvent } from '../server/protocolDiagnostics'
import { subscribeBrowserLifecycleRecovery } from '../server/lifecycleRecovery'
import { setCachedServerCommandRevision } from '../server/commands'
import { reportSendChatError } from './sendChatErrors'
import { stablePostGenerationChatTarget } from './postGeneration/stableTarget'
import { charactersResourceState, getCharacterResourceOwner } from '../server/resourceState.svelte'
import {
  getChatHydrationRuntime,
  getGenerationOperationsRuntime,
  getGenerationProcessRuntime,
  getRecoveredEffectsRuntime,
  getServerChatRuntime,
} from './generationRuntimeBridge'
import { captureClientSessionGeneration, clientSessionStore, type ClientSessionSnapshot } from '../clientSession'
import {
  applyGenerationRecoveryJob,
  beginGenerationRecoveryObligation,
  captureGenerationRecoveryObligations,
  hasGenerationRecoveryObligationsForTests,
  markGenerationRecoveryObligationUncertain,
  resetGenerationRecoveryObligations,
  settleCapturedGenerationRecoveryObligation,
  settleGenerationRecoveryObligation,
  type CapturedGenerationRecoveryObligation,
} from './generationRecoveryObligations'

/**
 * Durable generations still running server-side, as surfaced by the bootstrap
 * projection. A reloaded browser uses this to re-attach to the live stream of
 * the chat it opens, instead of only seeing the result once the projection
 * refreshes. Consumed once reattached.
 */
export const activeGenerationJobs = writable<ActiveGenerationJob[]>([])

export type GenerationJobProjectionSource =
  | 'startup'
  | 'full_resource_refresh'
  | 'online'
  | 'visibility'
  | 'pageshow'
  | 'focus'
  | 'status_probe'
  | 'manual_refresh'
  | 'bootstrap'

interface GenerationJobProjectionApplication {
  projectionEpoch?: number
  operations?: readonly GenerationOperationProjection[]
  source?: GenerationJobProjectionSource
}

interface ReattachProjectionCapture {
  applicationVersion: number
  projectionEpoch: number
  chatId: string
  jobId: string
  operationId?: string
  operationStateVersion?: number
  attemptNo?: number
  jobProjectionEpoch?: number
}

interface GenerationObserverRetirementSnapshot {
  jobs: readonly ActiveGenerationJob[]
  jobViewerFence: number
  operationViewerFence: number
}

const authoritativeGenerationJobsById = new Map<string, ActiveGenerationJob>()
let authoritativeGenerationJobByChat = new Map<string, ActiveGenerationJob>()
const supersededGenerationJobChats = new Map<string, string>()
const pendingAbsentGenerationReconciliations = new Map<string, ActiveGenerationJob>()
let activeGenerationProjectionEpoch = 0
let activeGenerationProjectionApplicationVersion = 0
let activeGenerationRecoveryEpoch = 0
const MAX_SUPERSEDED_GENERATION_JOB_CONTEXTS = 128

let recoveryOwnershipSnapshot: ClientSessionSnapshot | undefined

function generationRecoveryOwnershipWasReplaced(previous: ClientSessionSnapshot, next: ClientSessionSnapshot): boolean {
  if (previous.managed !== next.managed) return true
  if (previous.sessionId && previous.sessionId !== next.sessionId) return true
  if (previous.databaseLineage && previous.databaseLineage !== next.databaseLineage) return true
  if (previous.authenticated && !next.authenticated) return true
  return (
    previous.writer?.sessionId === previous.sessionId &&
    next.writer !== null &&
    next.writer.sessionId !== null &&
    next.writer.sessionId !== next.sessionId
  )
}

// Recovery ownership exists before UI reattachment is started. Observe its
// durable scope for the lifetime of this module so auth, lineage, or foreign
// writer replacement invalidates old tokens before late callbacks can run.
clientSessionStore.subscribe((next) => {
  const previous = recoveryOwnershipSnapshot
  recoveryOwnershipSnapshot = next
  if (previous && generationRecoveryOwnershipWasReplaced(previous, next)) {
    resetGenerationRecoveryObligations()
  }
})

function rememberSupersededGenerationJob(jobId: string, chatId: string): void {
  supersededGenerationJobChats.delete(jobId)
  supersededGenerationJobChats.set(jobId, chatId)
  while (supersededGenerationJobChats.size > MAX_SUPERSEDED_GENERATION_JOB_CONTEXTS) {
    const oldest = supersededGenerationJobChats.keys().next().value
    if (typeof oldest !== 'string') break
    supersededGenerationJobChats.delete(oldest)
  }
}

export type GenerationJobLifecycleStatus = 'attached' | 'retrying' | 'exhausted-dead' | 'completed' | 'cancelled'

export interface GenerationJobLifecycle {
  chatId: string
  jobId: string
  operationId?: string
  operationStateVersion?: number
  projectionEpoch?: number
  attemptNo?: number
  status: GenerationJobLifecycleStatus
  reattachAttempts: number
  lastError?: string
  nextRetryAt?: number
  updatedAt: number
}

/**
 * Browser observation state for each durable generation job. Server ownership
 * remains in `activeGenerationJobs`; this projection tells UI consumers whether
 * that job is still being observed, retrying, or has exhausted its observer.
 */
export const generationJobLifecycles = writable<Record<string, GenerationJobLifecycle>>({})

const REATTACH_TRANSPORT_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const
const MAX_RETAINED_TERMINAL_LIFECYCLES = 64

interface ReattachRetryState {
  transportFailures: number
  timer: ReturnType<typeof setTimeout> | null
}

const reattachRetryStates = new Map<string, ReattachRetryState>()
const missingDescriptorRecoveryJobs = new Set<string>()

function sourceRearmsObservation(source: GenerationJobProjectionSource | undefined): boolean {
  return (
    source === 'full_resource_refresh' ||
    source === 'online' ||
    source === 'visibility' ||
    source === 'pageshow' ||
    source === 'focus' ||
    source === 'status_probe' ||
    source === 'manual_refresh'
  )
}

function isTerminalLifecycle(status: GenerationJobLifecycleStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

function updateGenerationJobLifecycle(
  job: ActiveGenerationJob,
  status: GenerationJobLifecycleStatus,
  options: {
    reattachAttempts?: number
    lastError?: string
    nextRetryAt?: number
  } = {},
): void {
  generationJobLifecycles.update((lifecycles) => {
    const previous = lifecycles[job.jobId]
    const next: GenerationJobLifecycle = {
      chatId: job.chatId,
      jobId: job.jobId,
      ...(job.operationId ? { operationId: job.operationId } : {}),
      ...(job.operationStateVersion !== undefined ? { operationStateVersion: job.operationStateVersion } : {}),
      ...(job.projectionEpoch !== undefined ? { projectionEpoch: job.projectionEpoch } : {}),
      ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
      status,
      reattachAttempts: options.reattachAttempts ?? previous?.reattachAttempts ?? 0,
      updatedAt: Date.now(),
    }
    const lastError = options.lastError ?? previous?.lastError
    if (lastError) next.lastError = lastError
    if (options.nextRetryAt !== undefined) next.nextRetryAt = options.nextRetryAt

    const updated = { ...lifecycles, [job.jobId]: next }
    const terminal = Object.values(updated)
      .filter((entry) => isTerminalLifecycle(entry.status))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    for (const expired of terminal.slice(MAX_RETAINED_TERMINAL_LIFECYCLES)) {
      delete updated[expired.jobId]
    }
    return updated
  })
}

function removeNonterminalGenerationJobLifecycle(jobId: string): void {
  generationJobLifecycles.update((lifecycles) => {
    const lifecycle = lifecycles[jobId]
    if (!lifecycle || isTerminalLifecycle(lifecycle.status)) return lifecycles
    const updated = { ...lifecycles }
    delete updated[jobId]
    return updated
  })
}

function knownGenerationJob(jobId: string): ActiveGenerationJob | null {
  const authoritative = authoritativeGenerationJobsById.get(jobId)
  if (authoritative) return authoritative
  const active = get(activeGenerationJobs).find((job) => job.jobId === jobId)
  if (active) return active
  const lifecycle = get(generationJobLifecycles)[jobId]
  if (!lifecycle || isTerminalLifecycle(lifecycle.status)) {
    const chatId = supersededGenerationJobChats.get(jobId)
    return chatId ? { chatId, jobId } : null
  }
  return {
    chatId: lifecycle.chatId,
    jobId: lifecycle.jobId,
    ...(lifecycle.operationId ? { operationId: lifecycle.operationId } : {}),
    ...(lifecycle.operationStateVersion !== undefined
      ? { operationStateVersion: lifecycle.operationStateVersion }
      : {}),
    ...(lifecycle.projectionEpoch !== undefined ? { projectionEpoch: lifecycle.projectionEpoch } : {}),
    ...(lifecycle.attemptNo !== undefined ? { attemptNo: lifecycle.attemptNo } : {}),
  }
}

function clearReattachRetryState(jobId: string): void {
  const state = reattachRetryStates.get(jobId)
  if (state?.timer !== null && state?.timer !== undefined) clearTimeout(state.timer)
  reattachRetryStates.delete(jobId)
  missingDescriptorRecoveryJobs.delete(jobId)
}

function clearAllReattachRetryStates(): void {
  for (const jobId of reattachRetryStates.keys()) clearReattachRetryState(jobId)
  missingDescriptorRecoveryJobs.clear()
}

function isProtocolOperationLive(operation: GenerationOperationProjection): boolean {
  return operation.state === 'owned_by_job' || operation.state === 'stopping'
}

function normalizeGenerationJob(
  job: ActiveGenerationJob,
  operations: ReadonlyMap<string, GenerationOperationProjection>,
): ActiveGenerationJob | null {
  if (!job.operationId) return { ...job }
  const operation = operations.get(job.operationId)
  if (!operation || operation.protocolVersion !== 1) return { ...job }
  const attempt = operation.currentAttempt
  if (!isProtocolOperationLive(operation) || !attempt || attempt.jobId !== job.jobId) return null
  return {
    ...job,
    chatId: operation.chatId ?? job.chatId,
    mode: operation.mode ?? job.mode,
    ...(operation.mode === 'regenerate' && operation.targetMessageId
      ? { regenerateMessageId: operation.targetMessageId }
      : {}),
    operationId: operation.operationId,
    operationStateVersion: operation.stateVersion,
    projectionEpoch: operation.projectionEpoch,
    attemptNo: attempt.attemptNo,
    ...(operation.acceptedMessageId ? { acceptedMessageId: operation.acceptedMessageId } : {}),
    ...(operation.targetMessageId ? { targetMessageId: operation.targetMessageId } : {}),
  }
}

function hasProtocolOrdering(job: ActiveGenerationJob): boolean {
  return (
    typeof job.operationId === 'string' &&
    Number.isSafeInteger(job.projectionEpoch) &&
    Number.isSafeInteger(job.operationStateVersion) &&
    Number.isSafeInteger(job.attemptNo)
  )
}

/**
 * Section 6's total order for malformed/conflicting same-chat projections.
 * A complete protocol lineage outranks compatibility data; job-id order is
 * only the final deterministic tie-breaker.
 */
export function compareActiveGenerationJobAuthority(left: ActiveGenerationJob, right: ActiveGenerationJob): number {
  const leftProtocol = hasProtocolOrdering(left)
  const rightProtocol = hasProtocolOrdering(right)
  if (leftProtocol !== rightProtocol) return leftProtocol ? 1 : -1
  if (leftProtocol && rightProtocol) {
    return (
      left.projectionEpoch! - right.projectionEpoch! ||
      left.operationStateVersion! - right.operationStateVersion! ||
      left.attemptNo! - right.attemptNo! ||
      left.jobId.localeCompare(right.jobId)
    )
  }
  return left.jobId.localeCompare(right.jobId)
}

function deduplicateGenerationJobs(
  jobs: readonly ActiveGenerationJob[],
  operations: readonly GenerationOperationProjection[] = [],
): ActiveGenerationJob[] {
  const operationById = new Map(operations.map((operation) => [operation.operationId, operation]))
  const byChat = new Map<string, ActiveGenerationJob>()
  for (const rawJob of jobs) {
    const job = normalizeGenerationJob(rawJob, operationById)
    if (!job) continue
    const previous = byChat.get(job.chatId)
    if (!previous || compareActiveGenerationJobAuthority(job, previous) > 0) byChat.set(job.chatId, job)
  }
  return [...byChat.values()].sort(
    (left, right) => left.chatId.localeCompare(right.chatId) || compareActiveGenerationJobAuthority(left, right),
  )
}

function replaceAuthoritativeGenerationJobs(jobs: readonly ActiveGenerationJob[]): void {
  authoritativeGenerationJobsById.clear()
  authoritativeGenerationJobByChat = new Map()
  for (const job of jobs) {
    authoritativeGenerationJobsById.set(job.jobId, job)
    authoritativeGenerationJobByChat.set(job.chatId, job)
  }
}

export function authoritativeGenerationJobForChat(chatId: string | null | undefined): ActiveGenerationJob | undefined {
  return chatId ? authoritativeGenerationJobByChat.get(chatId) : undefined
}

export function setActiveGenerationJobs(
  jobs: readonly ActiveGenerationJob[],
  application: GenerationJobProjectionApplication = {},
): boolean {
  const incomingEpoch = application.projectionEpoch
  if (!canApplyActiveGenerationJobProjection(incomingEpoch)) return false
  const previousJobsById = new Map(authoritativeGenerationJobsById)
  if (incomingEpoch !== undefined) activeGenerationProjectionEpoch = incomingEpoch
  activeGenerationProjectionApplicationVersion += 1
  const normalizedJobs = deduplicateGenerationJobs(jobs, application.operations).map((job) => {
    const previous = previousJobsById.get(job.jobId)
    if (!previous) return job
    return compareActiveGenerationJobAuthority(previous, job) > 0 ? { ...job, ...previous } : { ...previous, ...job }
  })
  for (const previous of authoritativeGenerationJobsById.values()) {
    if (!normalizedJobs.some((job) => job.jobId === previous.jobId)) {
      rememberSupersededGenerationJob(previous.jobId, previous.chatId)
    }
  }
  replaceAuthoritativeGenerationJobs(normalizedJobs)
  for (const job of normalizedJobs) applyGenerationRecoveryJob(job)
  const nextJobIds = new Set(normalizedJobs.map((job) => job.jobId))
  for (const jobId of reattachRetryStates.keys()) {
    if (!nextJobIds.has(jobId)) clearReattachRetryState(jobId)
  }
  for (const jobId of missingDescriptorRecoveryJobs) {
    if (!nextJobIds.has(jobId)) missingDescriptorRecoveryJobs.delete(jobId)
  }
  activeGenerationJobs.set(normalizedJobs)

  const rearmObservation = sourceRearmsObservation(application.source)
  if (rearmObservation) {
    for (const job of normalizedJobs) {
      const retry = reattachRetryStates.get(job.jobId)
      const lifecycle = get(generationJobLifecycles)[job.jobId]
      if (!retry && lifecycle?.status !== 'exhausted-dead') continue
      clearReattachRetryState(job.jobId)
      recordGenerationRecoveryEvent(
        {
          trigger: application.source ?? 'bootstrap',
          recoveryEpoch: activeGenerationRecoveryEpoch,
          disposition: 'foreground_retry_reset',
          ...(job.operationId ? { operationId: job.operationId } : {}),
          ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
          jobId: job.jobId,
          priorObserverState: lifecycle?.status,
          nextObserverState: 'retrying',
        },
        'foreground_retry_reset',
      )
    }
  }

  generationJobLifecycles.update((lifecycles) => {
    const updated = { ...lifecycles }
    for (const [jobId, lifecycle] of Object.entries(updated)) {
      if (!nextJobIds.has(jobId) && !isTerminalLifecycle(lifecycle.status)) delete updated[jobId]
    }
    for (const job of normalizedJobs) {
      const previous = updated[job.jobId]
      if (previous && previous.chatId === job.chatId && !isTerminalLifecycle(previous.status) && !rearmObservation) {
        continue
      }
      updated[job.jobId] = {
        chatId: job.chatId,
        jobId: job.jobId,
        ...(job.operationId ? { operationId: job.operationId } : {}),
        ...(job.operationStateVersion !== undefined ? { operationStateVersion: job.operationStateVersion } : {}),
        ...(job.projectionEpoch !== undefined ? { projectionEpoch: job.projectionEpoch } : {}),
        ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
        status: 'retrying',
        reattachAttempts: 0,
        ...(previous?.lastError ? { lastError: previous.lastError } : {}),
        updatedAt: Date.now(),
      }
    }
    return updated
  })
  return true
}

/** Read-only half of the bootstrap projection's atomic acceptance check. */
export function canApplyActiveGenerationJobProjection(projectionEpoch?: number): boolean {
  return projectionEpoch === undefined || projectionEpoch >= activeGenerationProjectionEpoch
}

export function clearActiveGenerationJobProjection(): void {
  activeGenerationRecoveryEpoch += 1
  runtimeJobRefresh?.controller.abort()
  runtimeJobRefresh = null
  clearAllReattachRetryStates()
  authoritativeGenerationJobsById.clear()
  authoritativeGenerationJobByChat = new Map()
  supersededGenerationJobChats.clear()
  resetGenerationRecoveryObligations()
  pendingAbsentGenerationReconciliations.clear()
  activeGenerationProjectionEpoch = 0
  activeGenerationProjectionApplicationVersion += 1
  activeGenerationJobs.set([])
  generationJobLifecycles.set({})
}

/**
 * Compatibility wrapper for callers not yet migrated to per-dispatch tokens.
 */
export function retainUnresolvedGenerationAuthority(chatId: string | undefined, operationId?: string): void {
  const normalizedChatId = chatId?.trim()
  if (!normalizedChatId) return
  const token = beginGenerationRecoveryObligation({
    chatId: normalizedChatId,
    ...(operationId?.trim() ? { operationId: operationId.trim() } : {}),
    kind: 'submit',
    sourceGeneration: captureClientSessionGeneration(),
  })
  markGenerationRecoveryObligationUncertain(token)
}

export function hasUnresolvedGenerationAuthorityForTests(chatId?: string): boolean {
  return hasGenerationRecoveryObligationsForTests(chatId)
}

export function resolveUnresolvedGenerationAuthority(chatId: string | undefined, operationId?: string): void {
  const normalizedChatId = chatId?.trim()
  if (!normalizedChatId) return
  const normalizedOperationId = operationId?.trim() || undefined
  for (const obligation of captureGenerationRecoveryObligations()) {
    if (obligation.chatId !== normalizedChatId) continue
    if (normalizedOperationId ? obligation.operationId !== normalizedOperationId : obligation.operationId) continue
    settleGenerationRecoveryObligation(obligation.token)
  }
}

/**
 * Retain a durable job learned from the live generation response itself. Mobile
 * browsers can discard the response body while leaving the page alive, so the
 * bootstrap-only projection is not sufficient for a same-page reconnect.
 */
export function rememberActiveGenerationJob(job: ActiveGenerationJob): void {
  if (job.projectionEpoch !== undefined) {
    activeGenerationProjectionEpoch = Math.max(activeGenerationProjectionEpoch, job.projectionEpoch)
  }
  const previous = authoritativeGenerationJobByChat.get(job.chatId)
  if (
    previous &&
    previous.jobId !== job.jobId &&
    hasProtocolOrdering(previous) &&
    (!hasProtocolOrdering(job) || compareActiveGenerationJobAuthority(job, previous) <= 0)
  ) {
    return
  }
  applyGenerationRecoveryJob(job)
  pendingAbsentGenerationReconciliations.delete(job.jobId)
  if (previous?.jobId === job.jobId && compareActiveGenerationJobAuthority(job, previous) <= 0) {
    const remembered = {
      ...previous,
      ...job,
      ...(previous.operationId ? { operationId: previous.operationId } : {}),
      ...(previous.operationStateVersion !== undefined
        ? { operationStateVersion: previous.operationStateVersion }
        : {}),
      ...(previous.projectionEpoch !== undefined ? { projectionEpoch: previous.projectionEpoch } : {}),
      ...(previous.attemptNo !== undefined ? { attemptNo: previous.attemptNo } : {}),
    }
    authoritativeGenerationJobsById.set(job.jobId, remembered)
    authoritativeGenerationJobByChat.set(job.chatId, remembered)
    activeGenerationJobs.update((jobs) =>
      jobs.some((entry) => entry.jobId === job.jobId)
        ? jobs.map((entry) => (entry.jobId === job.jobId ? remembered : entry))
        : [remembered, ...jobs.filter((entry) => entry.chatId !== remembered.chatId)],
    )
    updateGenerationJobLifecycle(remembered, 'attached')
    return
  }
  const replacedJobIds = previous && previous.jobId !== job.jobId ? [previous.jobId] : []
  activeGenerationProjectionApplicationVersion += 1
  if (previous) authoritativeGenerationJobsById.delete(previous.jobId)
  const remembered = { ...job }
  authoritativeGenerationJobsById.set(job.jobId, remembered)
  authoritativeGenerationJobByChat.set(job.chatId, remembered)
  activeGenerationJobs.update((jobs) => [
    remembered,
    ...jobs.filter((entry) => entry.jobId !== job.jobId && entry.chatId !== job.chatId),
  ])
  for (const replacedJobId of replacedJobIds) {
    rememberSupersededGenerationJob(replacedJobId, job.chatId)
    clearReattachRetryState(replacedJobId)
    removeNonterminalGenerationJobLifecycle(replacedJobId)
  }
  updateGenerationJobLifecycle(job, 'attached')
}

/** Remove a locally/bootstrap-known job once its terminal frame is observed. */
export function forgetActiveGenerationJob(jobId: string, terminalStatus?: 'completed' | 'cancelled'): void {
  if (!jobId) return
  pendingAbsentGenerationReconciliations.delete(jobId)
  const knownJob = knownGenerationJob(jobId)
  clearReattachRetryState(jobId)
  const authoritative = authoritativeGenerationJobsById.get(jobId)
  if (authoritative) {
    authoritativeGenerationJobsById.delete(jobId)
    if (authoritativeGenerationJobByChat.get(authoritative.chatId)?.jobId === jobId) {
      authoritativeGenerationJobByChat.delete(authoritative.chatId)
    }
    activeGenerationProjectionApplicationVersion += 1
  }
  activeGenerationJobs.update((jobs) => jobs.filter((entry) => entry.jobId !== jobId))
  if (terminalStatus && knownJob) {
    updateGenerationJobLifecycle(knownJob, terminalStatus)
  } else {
    removeNonterminalGenerationJobLifecycle(jobId)
  }
}

export function isChatGenerationKnown(chatId: string | null | undefined): boolean {
  if (!chatId) return false
  return (
    findChatGenerationActivityByChatId(chatId)?.kind === 'message' ||
    get(activeGenerationJobs).some((job) => job.chatId === chatId)
  )
}

function openChatTarget(): ActiveChatTarget | null {
  if (charactersResourceState.status !== 'ready') return null
  const selectedChar =
    charactersResourceState.selectionRevision === null ? get(selectedCharID) : charactersResourceState.currentChar
  if (selectedChar < 0) return null
  const candidate = charactersResourceState.characters[selectedChar]
  if (!candidate?.chaId) return null
  const character = getCharacterResourceOwner(candidate.chaId)
  if (!character || character !== candidate) return null
  const chatPage = character.chatPage ?? 0
  const chat = character.chats?.[chatPage]
  if (!chat?.id || character.chats.filter((candidate) => candidate.id === chat.id).length !== 1) return null
  return {
    selectedCharID: selectedChar,
    chatPage,
    characterId: character.chaId,
    chatId: chat.id,
  }
}

function isOpenChatTargetFresh(target: ActiveChatTarget): boolean {
  const current = openChatTarget()
  if (!current) return false
  if (target.characterId !== undefined || current.characterId !== undefined) {
    if (target.characterId !== current.characterId) return false
  } else if (target.selectedCharID !== current.selectedCharID) {
    return false
  }
  if (target.chatId !== undefined || current.chatId !== undefined) {
    return target.chatId === current.chatId
  }
  return target.chatPage === current.chatPage
}

const reattachingJobIds = new Set<string>()
let reattachQueued = false
let reattachReadinessPredicate = () => true

/**
 * Keep reattachment dormant until the owner of selected-chat readiness says
 * plugin and hydration dependencies are coherent. Tests and non-bootstrap
 * callers retain the historical ready-by-default behavior.
 */
export function setActiveGenerationReattachReadinessPredicate(predicate: () => boolean): void {
  reattachReadinessPredicate = predicate
}

function captureReattachProjection(job: ActiveGenerationJob): ReattachProjectionCapture {
  return {
    applicationVersion: activeGenerationProjectionApplicationVersion,
    projectionEpoch: activeGenerationProjectionEpoch,
    chatId: job.chatId,
    jobId: job.jobId,
    ...(job.operationId ? { operationId: job.operationId } : {}),
    ...(job.operationStateVersion !== undefined ? { operationStateVersion: job.operationStateVersion } : {}),
    ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
    ...(job.projectionEpoch !== undefined ? { jobProjectionEpoch: job.projectionEpoch } : {}),
  }
}

function reattachProjectionStillCurrent(capture: ReattachProjectionCapture): boolean {
  if (
    capture.applicationVersion !== activeGenerationProjectionApplicationVersion ||
    capture.projectionEpoch !== activeGenerationProjectionEpoch
  ) {
    return false
  }
  const current = authoritativeGenerationJobByChat.get(capture.chatId)
  return (
    current?.jobId === capture.jobId &&
    current.operationId === capture.operationId &&
    current.operationStateVersion === capture.operationStateVersion &&
    current.attemptNo === capture.attemptNo &&
    current.projectionEpoch === capture.jobProjectionEpoch
  )
}

function consumePresentedGenerationJob(jobId: string): void {
  activeGenerationJobs.update((jobs) => jobs.filter((entry) => entry.jobId !== jobId))
}

function restorePresentedGenerationJob(job: ActiveGenerationJob, capture: ReattachProjectionCapture): boolean {
  if (!reattachProjectionStillCurrent(capture)) return false
  activeGenerationJobs.update((jobs) => {
    const sameChat = jobs.find((entry) => entry.chatId === job.chatId)
    if (sameChat && compareActiveGenerationJobAuthority(sameChat, job) > 0) return jobs
    return [job, ...jobs.filter((entry) => entry.jobId !== job.jobId && entry.chatId !== job.chatId)]
  })
  return true
}

function isReattachRetryBlocked(jobId: string): boolean {
  const state = reattachRetryStates.get(jobId)
  return (
    state !== undefined && (state.timer !== null || state.transportFailures > REATTACH_TRANSPORT_RETRY_DELAYS_MS.length)
  )
}

function generationObservationPaused(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

function scheduleTransportReattachRetry(job: ActiveGenerationJob, lastError: string): void {
  const jobId = job.jobId
  const state = reattachRetryStates.get(jobId) ?? { transportFailures: 0, timer: null }
  state.transportFailures += 1
  const delay = REATTACH_TRANSPORT_RETRY_DELAYS_MS[state.transportFailures - 1]
  state.timer = null
  reattachRetryStates.set(jobId, state)
  if (delay === undefined) {
    updateGenerationJobLifecycle(job, 'exhausted-dead', {
      reattachAttempts: state.transportFailures,
      lastError,
    })
    recordGenerationRecoveryEvent(
      {
        trigger: 'stream_transport',
        recoveryEpoch: activeGenerationRecoveryEpoch,
        disposition: 'observer_exhaustion',
        ...(job.operationId ? { operationId: job.operationId } : {}),
        ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
        jobId: job.jobId,
        priorObserverState: 'retrying',
        nextObserverState: 'exhausted-dead',
      },
      'observer_exhaustion',
    )
    return
  }

  updateGenerationJobLifecycle(job, 'retrying', {
    reattachAttempts: state.transportFailures,
    lastError,
    nextRetryAt: Date.now() + delay,
  })

  state.timer = setTimeout(() => {
    state.timer = null
    if (reattachDisabled) return
    if (generationObservationPaused()) return
    if (!get(activeGenerationJobs).some((job) => job.jobId === jobId)) {
      clearReattachRetryState(jobId)
      return
    }
    triggerOpenChatGenerationReattach()
  }, delay)
}

/**
 * Request a delayed reattach probe after projection state has settled. This
 * coalesces bursts from selected-character changes, active-chat projection
 * updates, and full resyncs into one guarded `maybeReattachOpenChatGeneration`.
 */
export function triggerOpenChatGenerationReattach(): void {
  if (reattachDisabled || reattachQueued) return
  reattachQueued = true
  queueMicrotask(() => {
    reattachQueued = false
    void maybeReattachOpenChatGeneration()
  })
}

/**
 * If the currently-open chat has a live server generation, re-attach to it and
 * render the replayed stream. No-op when nothing is open, no job matches, or a
 * generation is already in flight locally. Terminal outcomes consume the job;
 * transport failures receive a small, bounded retry budget.
 */
export async function maybeReattachOpenChatGeneration(): Promise<void> {
  if (reattachDisabled || !reattachReadinessPredicate() || generationObservationPaused()) return
  const target = openChatTarget()
  if (!target?.chatId) return
  const job = get(activeGenerationJobs).find((entry) => entry.chatId === target.chatId)
  if (!job) return
  await reattachGenerationJob(job, target)
}

/**
 * Start observation for the currently-open durable job and wait only until the
 * observer has crossed its first scheduling boundary. A live stream may remain
 * active, but startup can then safely publish selected-chat readiness because
 * the job has been claimed by the reattach path.
 */
export async function prepareOpenChatGenerationReattach(): Promise<void> {
  if (reattachDisabled || !reattachReadinessPredicate() || generationObservationPaused()) return
  const reattach = maybeReattachOpenChatGeneration()
  await Promise.resolve()
  void reattach
}

async function reattachGenerationJob(job: ActiveGenerationJob, target: ActiveChatTarget): Promise<void> {
  if (reattachingJobIds.has(job.jobId) || isReattachRetryBlocked(job.jobId) || findChatGenerationActivity(target))
    return

  const capture = captureReattachProjection(job)
  reattachingJobIds.add(job.jobId)
  let reattachAfterSettlement = false
  const previousLifecycle = get(generationJobLifecycles)[job.jobId]
  try {
    // Keep the scheduling boundary that runtime module loading used to provide,
    // so a same-turn chat switch wins before this job is consumed.
    await Promise.resolve()
    const { sendChat, createActiveGenerationAbortController, clearActiveGenerationAbortController } =
      getGenerationProcessRuntime()
    const { generationOperationStreamForActiveJob, isProtocolGenerationOperationJob } = getGenerationOperationsRuntime()
    if (!isOpenChatTargetFresh(target) || !reattachProjectionStillCurrent(capture)) {
      return
    }
    const operationStream = generationOperationStreamForActiveJob(job)
    const missingDescriptor = isProtocolGenerationOperationJob(job) && !operationStream
    if (missingDescriptor && missingDescriptorRecoveryJobs.has(job.jobId)) return
    updateGenerationJobLifecycle(job, 'retrying', {
      reattachAttempts: previousLifecycle?.reattachAttempts ?? 0,
      lastError: previousLifecycle?.lastError,
    })
    if (missingDescriptor) {
      reattachAfterSettlement = await reconcileMissingGenerationDescriptor(job, capture)
      return
    }
    missingDescriptorRecoveryJobs.delete(job.jobId)
    // Consume only after the exact attempt can be attached. The in-flight set
    // already excludes duplicate observers while metadata is being recovered.
    consumePresentedGenerationJob(job.jobId)
    // Carry the running job's mode so the replayed stream renders on the right
    // row (Continue's replayed info selects append/extend; regenerate targets its
    // slot) rather than as a fresh send. Older servers omit `mode` and are treated as send.
    const controller = createActiveGenerationAbortController()
    try {
      let outcome: GenerationReattachOutcome | undefined
      const attached = await sendChat(-1, {
        signal: controller.signal,
        ...(operationStream ? { generationOperationStream: operationStream } : { reattachJobId: job.jobId }),
        expectedTarget: target,
        continue: job.mode === 'continue' ? true : undefined,
        regenerateMessageId: job.mode === 'regenerate' ? job.regenerateMessageId : undefined,
        onReattachOutcome: (value) => {
          outcome = value
        },
      })
      const settledOutcome: GenerationReattachOutcome =
        outcome ??
        (controller.signal.aborted
          ? { status: 'aborted' }
          : attached
            ? { status: 'completed' }
            : { status: 'terminal_failure' })
      if (settledOutcome.status === 'retryable_transport_failure') {
        if (restorePresentedGenerationJob(job, capture)) {
          scheduleTransportReattachRetry(job, settledOutcome.error ?? 'The generation stream could not be reached.')
        }
      } else if (
        settledOutcome.status === 'missing_job' ||
        settledOutcome.status === 'authority_reconciliation_required'
      ) {
        await reconcileGenerationJobAfterObserverLoss(job, capture)
      } else if (settledOutcome.status === 'observer_superseded') {
        // A newer foreground recovery epoch owns the observer. Its projection
        // application and activity subscription decide whether to reattach.
        reattachAfterSettlement = true
      } else if (settledOutcome.status === 'completed' || settledOutcome.status === 'cancelled') {
        forgetActiveGenerationJob(job.jobId, settledOutcome.status)
      } else {
        // The request layer may have remembered the job again after opening its
        // stream. Terminal outcomes still own final removal, even if bootstrap
        // or the response header refreshed the local projection mid-attempt.
        forgetActiveGenerationJob(job.jobId)
      }
    } catch (error) {
      // Untyped exceptions are not transport failures. Consume any copy that
      // the request layer may have remembered and let bootstrap be the only
      // authority that can offer the job again later.
      forgetActiveGenerationJob(job.jobId)
      throw error
    } finally {
      clearActiveGenerationAbortController(controller)
    }
  } catch {
    // Reattach is an optimization; the persisted result still surfaces via the
    // projection refresh.
  } finally {
    reattachingJobIds.delete(job.jobId)
    if (reattachAfterSettlement && !reattachDisabled) triggerOpenChatGenerationReattach()
  }
}

async function reconcileMissingGenerationDescriptor(
  job: ActiveGenerationJob,
  capture: ReattachProjectionCapture,
): Promise<boolean> {
  const authority = await refreshGenerationAuthority('status_probe', {
    supersede: true,
    ...(job.operationId ? { operationId: job.operationId } : {}),
  })
  if (reattachDisabled) return false
  if (authority.status !== 'ok') {
    if (restorePresentedGenerationJob(job, capture)) {
      missingDescriptorRecoveryJobs.add(job.jobId)
      updateGenerationJobLifecycle(job, 'exhausted-dead', { lastError: authority.error })
      return false
    }
    return Boolean(authoritativeGenerationJobForChat(job.chatId))
  }

  const current = authoritativeGenerationJobForChat(job.chatId)
  if (!current) return false
  const { generationOperationStreamForActiveJob, isProtocolGenerationOperationJob } = getGenerationOperationsRuntime()
  if (
    current.jobId === job.jobId &&
    isProtocolGenerationOperationJob(current) &&
    !generationOperationStreamForActiveJob(current)
  ) {
    // An unchanged incomplete projection must not trigger a status-probe loop.
    // Keep the job available for repaired metadata or an explicit/lifecycle retry.
    missingDescriptorRecoveryJobs.add(current.jobId)
    updateGenerationJobLifecycle(current, 'exhausted-dead', {
      lastError: 'Generation retry returned no live stream.',
    })
    return false
  }
  return true
}

/** Reset the retry budget and reattach only the requested durable job. */
export async function retryGenerationJobReattach(jobId: string): Promise<void> {
  if (reattachDisabled) return
  const requestedJob = knownGenerationJob(jobId)
  let job = requestedJob ? authoritativeGenerationJobForChat(requestedJob.chatId) : undefined
  const target = openChatTarget()
  if (!requestedJob || !target?.chatId || target.chatId !== requestedJob.chatId) return

  if (!job && requestedJob.operationId) {
    const { generationOperationProjections, retryGenerationOperation } = getGenerationOperationsRuntime()
    const operation = get(generationOperationProjections).find(
      (candidate) => candidate.operationId === requestedJob.operationId,
    )
    if (operation?.state !== 'retryable' && operation?.state !== 'abandoned') return
    const retried = await retryGenerationOperation(operation.operationId, operation.stateVersion)
    if (retried.status !== 'accepted' || !retried.stream) {
      updateGenerationJobLifecycle(requestedJob, 'exhausted-dead', {
        lastError: retried.status === 'accepted' ? 'Generation retry returned no live stream.' : retried.error,
      })
      return
    }
    job = authoritativeGenerationJobForChat(requestedJob.chatId)
    if (!job) return
  }
  if (!job) return

  clearReattachRetryState(job.jobId)
  const previousLifecycle = get(generationJobLifecycles)[job.jobId]
  updateGenerationJobLifecycle(job, 'retrying', {
    reattachAttempts: 0,
    lastError: previousLifecycle?.lastError,
  })
  if (reattachingJobIds.has(job.jobId) || findChatGenerationActivity(target)) {
    const { retireGenerationJobViewers } = getServerChatRuntime()
    const { retireGenerationOperationViewers } = getGenerationOperationsRuntime()
    retireGenerationJobViewers(job.jobId)
    if (job.operationId) retireGenerationOperationViewers(job.operationId)
    triggerOpenChatGenerationReattach()
    return
  }
  await reattachGenerationJob(job, target)
}

export type GenerationJobRefreshResult =
  | { status: 'active' }
  | { status: 'absent' }
  | { status: 'error'; error: string }

function bootstrapRefreshError(result: { status: 'error'; error: string } | { status: 'unavailable' }): string {
  return result.status === 'error' ? result.error : 'Server bootstrap is unavailable.'
}

async function hydrateReconciledChats(
  jobs: readonly Pick<ActiveGenerationJob, 'chatId'>[],
  options: { strict?: boolean; signal?: AbortSignal | null } = {},
): Promise<ReadonlySet<string>> {
  const hydratedChatIds = new Set<string>()
  if (jobs.length === 0) return hydratedChatIds
  const { hydrateChatMessages } = getChatHydrationRuntime()
  let pendingChatIds = [...new Set(jobs.map((job) => job.chatId))]
  // A terminal resource event can apply a newer transcript while this forced
  // read is in flight. Strict hydration truthfully rejects the now-stale read,
  // but one bounded replacement read should win against that settled
  // projection instead of publishing a permanent dead-observer warning.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const results = await Promise.allSettled(
      pendingChatIds.map((chatId) =>
        hydrateChatMessages(chatId, {
          force: true,
          strict: options.strict,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      ),
    )
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') hydratedChatIds.add(pendingChatIds[index])
    }
    const failedChatIds = pendingChatIds.filter((_chatId, index) => results[index].status === 'rejected')
    if (failedChatIds.length === 0) return hydratedChatIds
    if (options.signal?.aborted) return hydratedChatIds
    pendingChatIds = failedChatIds
  }
  return hydratedChatIds
}

/** Reconcile and retry only the requested job against authoritative bootstrap state. */
export async function refreshGenerationJobFromBootstrap(jobId: string): Promise<GenerationJobRefreshResult> {
  if (reattachDisabled) return { status: 'error', error: 'Generation reattach is disabled.' }
  const requestedJob = knownGenerationJob(jobId)
  if (!requestedJob) return { status: 'absent' }

  const authority = await refreshGenerationAuthority('manual_refresh', { supersede: true })
  if (authority.status !== 'ok') {
    const error = authority.error
    updateGenerationJobLifecycle(requestedJob, 'exhausted-dead', { lastError: error })
    return { status: 'error', error }
  }

  const authoritativeJob = authoritativeGenerationJobForChat(requestedJob.chatId)
  if (!authoritativeJob) {
    return { status: 'absent' }
  }

  clearReattachRetryState(authoritativeJob.jobId)
  const previousLifecycle = get(generationJobLifecycles)[authoritativeJob.jobId]
  updateGenerationJobLifecycle(authoritativeJob, 'retrying', {
    reattachAttempts: 0,
    lastError: previousLifecycle?.lastError,
  })
  const target = openChatTarget()
  if (target?.chatId === authoritativeJob.chatId) {
    await reattachGenerationJob(authoritativeJob, target)
  }
  return { status: 'active' }
}

async function reconcileGenerationJobAfterObserverLoss(
  job: ActiveGenerationJob,
  capture: ReattachProjectionCapture,
): Promise<void> {
  const authority = await refreshGenerationAuthority('status_probe', {
    supersede: true,
    ...(job.operationId ? { operationId: job.operationId } : {}),
  })
  if (authority.status !== 'ok') {
    if (restorePresentedGenerationJob(job, capture)) {
      updateGenerationJobLifecycle(job, 'exhausted-dead', {
        lastError: authority.error,
      })
    }
    return
  }

  const current = authoritativeGenerationJobForChat(job.chatId)
  if (current) {
    triggerOpenChatGenerationReattach()
  }
}

/** Stop only the requested job, preferring its durable operation identity when available. */
export async function stopGenerationJob(jobId: string) {
  const requestedJob = knownGenerationJob(jobId)
  if (!requestedJob) return
  const job = authoritativeGenerationJobForChat(requestedJob.chatId) ?? requestedJob
  if (job.operationId) {
    const { isProtocolGenerationOperationJob, stopGenerationOperation } = getGenerationOperationsRuntime()
    if (!isProtocolGenerationOperationJob(job)) {
      const { cancelServerChatGeneration } = getServerChatRuntime()
      return cancelServerChatGeneration(job.jobId)
    }
    return stopGenerationOperation(job.operationId)
  }
  const { cancelServerChatGeneration } = getServerChatRuntime()
  return cancelServerChatGeneration(job.jobId)
}

let wired = false
let reattachDisabled = false
const GENERATION_AUTHORITY_TIMEOUT_MS = 10_000
const LIFECYCLE_AUTHORITY_RETRY_DELAYS_MS = [500, 2_000, 5_000] as const

type GenerationAuthorityRefreshResult = { status: 'ok' } | { status: 'error'; error: string }

interface GenerationAuthorityRequest {
  epoch: number
  controller: AbortController
  promise: Promise<GenerationAuthorityRefreshResult>
}

let runtimeJobRefresh: GenerationAuthorityRequest | null = null
let lifecycleWakeupQueued = false
let pendingLifecycleWakeupSource: GenerationJobProjectionSource | null = null
let lifecycleRecoverySequence = 0
let lifecycleAuthorityRetryTimer: ReturnType<typeof setTimeout> | null = null
let stopSelectedCharacterSubscription: (() => void) | null = null
let stopGenerationActivitySubscription: (() => void) | null = null
let stopGenerationLifecycleRecoverySubscription: (() => void) | null = null

function waitForRuntimeJobRefresh(
  promise: Promise<GenerationAuthorityRefreshResult>,
  signal: AbortSignal | null | undefined,
): Promise<GenerationAuthorityRefreshResult> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve({ status: 'error', error: 'Generation authority probe was aborted.' })
  return new Promise((resolve) => {
    const settle = () => {
      signal.removeEventListener('abort', settle)
      resolve({ status: 'error', error: 'Generation authority probe was aborted.' })
    }
    signal.addEventListener('abort', settle, { once: true })
    void promise.then(
      (result) => {
        signal.removeEventListener('abort', settle)
        resolve(result)
      },
      () => settle(),
    )
  })
}

function settleBeforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      resolve(null)
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function reconcileAbsentGenerationJobs(
  previousJobs: readonly ActiveGenerationJob[],
  source: GenerationJobProjectionSource,
  signal?: AbortSignal | null,
  terminalObligations: readonly CapturedGenerationRecoveryObligation[] = [],
): Promise<void> {
  retainAbsentGenerationJobsForReconciliation(previousJobs)
  const candidates = new Map(pendingAbsentGenerationReconciliations)
  const absentJobs: ActiveGenerationJob[] = []
  for (const job of candidates.values()) {
    if (authoritativeGenerationJobForChat(job.chatId)) {
      pendingAbsentGenerationReconciliations.delete(job.jobId)
      continue
    }
    pendingAbsentGenerationReconciliations.set(job.jobId, job)
    absentJobs.push(job)
  }
  const awaitingTranscript = terminalObligations.filter(
    (obligation) => obligation.phase === 'awaiting_transcript' && obligation.chatId,
  )
  if (absentJobs.length === 0 && awaitingTranscript.length === 0) return

  for (const job of absentJobs) {
    updateGenerationJobLifecycle(job, 'retrying', {
      reattachAttempts: get(generationJobLifecycles)[job.jobId]?.reattachAttempts ?? 0,
      lastError: get(generationJobLifecycles)[job.jobId]?.lastError,
    })
  }

  const hydratedChatIds = await hydrateReconciledChats(
    [...absentJobs, ...awaitingTranscript.map((obligation) => ({ chatId: obligation.chatId! }))],
    { strict: true, signal },
  )
  if (signal?.aborted) return
  const { generationOperationProjections } = getGenerationOperationsRuntime()
  const operations = get(generationOperationProjections)
  for (const job of absentJobs) {
    let reconciliationSettled = false
    try {
      // Authority may have advanced while strict hydration was in flight. A
      // replacement job owns this chat now; the old absence must not publish a
      // terminal lifecycle or consume the replacement's observation state.
      if (authoritativeGenerationJobForChat(job.chatId)) {
        reconciliationSettled = true
        continue
      }
      const operation = job.operationId
        ? operations.find((candidate) => candidate.operationId === job.operationId)
        : undefined
      if (!hydratedChatIds.has(job.chatId)) {
        updateGenerationJobLifecycle(job, 'exhausted-dead', {
          lastError: 'The generation finished, but its transcript could not be refreshed.',
        })
        continue
      }
      if (operation && (operation.state === 'retryable' || operation.state === 'abandoned')) {
        reconciliationSettled = true
        updateGenerationJobLifecycle(job, 'exhausted-dead', {
          lastError: operation.lastError ?? 'Generation requires authoritative recovery.',
        })
        continue
      }
      if (operation && (operation.state === 'terminal_failed' || operation.state === 'invalidated')) {
        reconciliationSettled = true
        reportSendChatError(operation.lastError ?? 'Generation failed.', {
          target: stablePostGenerationChatTarget(operation.characterId, operation.chatId),
          ...(operation.resultMessageId ? { messageId: operation.resultMessageId } : {}),
          generationInfo: undefined,
        })
        forgetActiveGenerationJob(job.jobId)
        recordGenerationRecoveryEvent(
          {
            trigger: source,
            recoveryEpoch: activeGenerationRecoveryEpoch,
            disposition: 'terminal_reconciliation',
            operationId: operation.operationId,
            ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
            jobId: job.jobId,
            nextDurableState: operation.state,
            priorObserverState: 'attached',
            nextObserverState: 'completed',
          },
          'terminal_reconciliation',
        )
        continue
      }
      const terminalStatus = operation?.state === 'cancelled' ? 'cancelled' : 'completed'
      reconciliationSettled = true
      forgetActiveGenerationJob(job.jobId, terminalStatus)
      recordGenerationRecoveryEvent(
        {
          trigger: source,
          recoveryEpoch: activeGenerationRecoveryEpoch,
          disposition: 'terminal_reconciliation',
          ...(job.operationId ? { operationId: job.operationId } : {}),
          ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
          jobId: job.jobId,
          ...(operation?.state ? { nextDurableState: operation.state } : {}),
          priorObserverState: 'attached',
          nextObserverState: terminalStatus,
        },
        job.operationId ? 'terminal_reconciliation' : 'compatibility_job_expiry',
      )
    } finally {
      if (reconciliationSettled) pendingAbsentGenerationReconciliations.delete(job.jobId)
    }
  }
  for (const obligation of awaitingTranscript) {
    if (obligation.chatId && hydratedChatIds.has(obligation.chatId)) {
      settleCapturedGenerationRecoveryObligation(obligation)
    }
  }
}

function retainAbsentGenerationJobsForReconciliation(previousJobs: readonly ActiveGenerationJob[]): void {
  for (const job of previousJobs) {
    if (authoritativeGenerationJobForChat(job.chatId)) {
      pendingAbsentGenerationReconciliations.delete(job.jobId)
    } else {
      pendingAbsentGenerationReconciliations.set(job.jobId, job)
    }
  }
}

async function retireSupersededGenerationObservers(snapshot: GenerationObserverRetirementSnapshot): Promise<boolean> {
  const activities = get(activeChatGenerations).filter((activity) => activity.kind === 'message' && activity.chatId)
  if (activities.length === 0) return false
  const openChatId = openChatTarget()?.chatId
  const jobs = snapshot.jobs.filter((job) =>
    activities.some((activity) => {
      if (activity.chatId !== job.chatId) return false
      // Only the open chat can acquire a replacement observer. Preserve live
      // background streams so their terminal still delivers completion effects.
      // Absent jobs must still retire and reconcile their persisted outcome.
      if (job.chatId !== openChatId && authoritativeGenerationJobsById.has(job.jobId)) return false
      if (activity.operationId && job.operationId && activity.operationId !== job.operationId) return false
      if (activity.attemptNo !== undefined && job.attemptNo !== undefined && activity.attemptNo !== job.attemptNo) {
        return false
      }
      if (
        activity.projectionEpoch !== undefined &&
        job.projectionEpoch !== undefined &&
        activity.projectionEpoch !== job.projectionEpoch
      ) {
        return false
      }
      return true
    }),
  )
  if (jobs.length === 0) return false
  const { retireGenerationJobViewers } = getServerChatRuntime()
  const { retireGenerationOperationViewers } = getGenerationOperationsRuntime()
  for (const job of jobs) {
    retireGenerationJobViewers(job.jobId, snapshot.jobViewerFence)
    if (job.operationId) retireGenerationOperationViewers(job.operationId, snapshot.operationViewerFence)
  }
  return true
}

async function applyGenerationRecoveryBootstrap(
  runtime: { status: 'ok'; bootstrap: ServerBootstrapRuntime },
  source: GenerationJobProjectionSource,
  signal?: AbortSignal | null,
  capturedRecovery: readonly CapturedGenerationRecoveryObligation[] = [],
  observerRetirement?: GenerationObserverRetirementSnapshot,
): Promise<boolean> {
  const previousJobs = [...authoritativeGenerationJobsById.values()]
  const generationOperations = getGenerationOperationsRuntime()
  const { applyGenerationOperationBootstrap } = generationOperations
  const applied = applyGenerationOperationBootstrap(runtime.bootstrap, source)
  if (!applied) return false
  // Retain vanished jobs before replay can await or time out. Their transcript
  // reconciliation must survive even though the accepted projection has
  // already removed them from the active-job maps.
  retainAbsentGenerationJobsForReconciliation(previousJobs)
  // The authority ingress is synchronous. Advance the command cursor only
  // after its operation/job epoch checks accept the complete projection, and
  // before replay or transcript/effect reconciliation can yield.
  setCachedServerCommandRevision(runtime.bootstrap.revision)
  // Apply every accepted bootstrap slice before replay can publish newer
  // operation authority. Older snapshot data must not overwrite that result
  // after the network await below.
  if (runtime.bootstrap.generationFinalizations) {
    setGenerationFinalizationPersistences(runtime.bootstrap.generationFinalizations)
  }
  const hasPendingGenerationEffects = (runtime.bootstrap.pendingGenerationEffects?.length ?? 0) > 0
  const recoveredGenerationEffects = hasPendingGenerationEffects ? getRecoveredEffectsRuntime() : null
  if (recoveredGenerationEffects) {
    recoveredGenerationEffects.setPendingRecoveredGenerationEffects(runtime.bootstrap.pendingGenerationEffects ?? [])
  }
  // Reconcile exact outbox receipts and replay only still-current idempotent
  // uncertain identities after the accepted snapshot leaves their outcome
  // unresolved. The replay path rechecks each token at actual dispatch time.
  const replay = generationOperations.replayGenerationRecoveryObligations(
    [...capturedRecovery, ...captureGenerationRecoveryObligations()],
    signal ?? undefined,
  )
  if (signal) {
    if ((await settleBeforeAbort(replay, signal)) === null) return false
  } else {
    await replay
  }
  if (signal?.aborted) return false
  const terminalObligations = captureGenerationRecoveryObligations().filter(
    (obligation) => obligation.phase === 'awaiting_transcript',
  )
  // Once the foreground authority projection is accepted, the pre-suspension
  // observer is stale. Retire it before strict transcript hydration so a hung
  // post-resume resource read cannot keep its chat activity spinner alive.
  const observerHandoffRequired =
    sourceRearmsObservation(source) && observerRetirement
      ? await retireSupersededGenerationObservers(observerRetirement)
      : false
  await reconcileAbsentGenerationJobs(previousJobs, source, signal, terminalObligations)
  if (recoveredGenerationEffects) {
    await recoveredGenerationEffects.reconcilePendingRecoveredGenerationEffects().catch(() => undefined)
  }
  // Activity cleanup normally queues this handoff. Queue once more after all
  // accepted recovery work settles so a slow abort cannot consume the only
  // replacement attempt before its foreground activity is released.
  if (observerHandoffRequired) triggerOpenChatGenerationReattach()
  return true
}

async function refreshGenerationAuthority(
  source: GenerationJobProjectionSource,
  options: { signal?: AbortSignal | null; supersede?: boolean; operationId?: string } = {},
): Promise<GenerationAuthorityRefreshResult> {
  if (reattachDisabled) return { status: 'error', error: 'Generation reattach is disabled.' }
  const existing = runtimeJobRefresh
  if (existing && !options.supersede) return waitForRuntimeJobRefresh(existing.promise, options.signal)
  if (existing) {
    existing.controller.abort()
    runtimeJobRefresh = null
    recordGenerationRecoveryEvent(
      {
        trigger: source,
        recoveryEpoch: activeGenerationRecoveryEpoch + 1,
        disposition: 'superseded_bootstrap',
      },
      'superseded_bootstrap',
    )
  }

  const epoch = ++activeGenerationRecoveryEpoch
  const controller = new AbortController()
  const recoveryAtRequestStart = captureGenerationRecoveryObligations()
  let observerRetirement: GenerationObserverRetirementSnapshot | undefined
  if (sourceRearmsObservation(source)) {
    const serverChat = getServerChatRuntime()
    const generationOperations = getGenerationOperationsRuntime()
    observerRetirement = {
      jobs: [...authoritativeGenerationJobsById.values()].filter(
        (job) => !options.operationId || job.operationId === options.operationId,
      ),
      jobViewerFence: serverChat.captureGenerationJobViewerFence(),
      operationViewerFence: generationOperations.captureGenerationOperationViewerFence(),
    }
  }
  let timedOut = false
  const handleOwnerAbort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', handleOwnerAbort, { once: true })
  const deadline = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, GENERATION_AUTHORITY_TIMEOUT_MS)

  let request!: GenerationAuthorityRequest
  const promise = (async (): Promise<GenerationAuthorityRefreshResult> => {
    try {
      const { fetchServerBootstrapReadOnly } = await import('../server/bootstrap')
      if (options.operationId) {
        const { readGenerationOperationStatus } = getGenerationOperationsRuntime()
        const status = await settleBeforeAbort(
          readGenerationOperationStatus(options.operationId, controller.signal),
          controller.signal,
        )
        if (!status) {
          if (timedOut) {
            recordGenerationRecoveryEvent(
              {
                trigger: source,
                recoveryEpoch: epoch,
                disposition: 'authority_timeout',
                operationId: options.operationId,
              },
              'authority_timeout',
            )
            return { status: 'error', error: 'Generation authority refresh timed out.' }
          }
          return { status: 'error', error: 'Generation authority refresh was superseded.' }
        }
      }
      const runtime = await settleBeforeAbort(
        fetchServerBootstrapReadOnly(controller.signal, { cacheRevision: false }),
        controller.signal,
      )
      if (!runtime) {
        if (timedOut) {
          recordGenerationRecoveryEvent(
            {
              trigger: source,
              recoveryEpoch: epoch,
              disposition: 'authority_timeout',
            },
            'authority_timeout',
          )
          return { status: 'error', error: 'Generation authority refresh timed out.' }
        }
        return { status: 'error', error: 'Generation authority refresh was superseded.' }
      }
      if (epoch !== activeGenerationRecoveryEpoch || controller.signal.aborted) {
        return { status: 'error', error: 'Generation authority refresh was superseded.' }
      }
      if (runtime.status !== 'ok') {
        recordGenerationRecoveryEvent({
          trigger: source,
          recoveryEpoch: epoch,
          disposition: 'authority_error',
          ...('requestUid' in runtime && runtime.requestUid ? { requestUid: runtime.requestUid } : {}),
        })
        return { status: 'error', error: bootstrapRefreshError(runtime) }
      }
      const applied = await applyGenerationRecoveryBootstrap(
        runtime,
        source,
        controller.signal,
        recoveryAtRequestStart,
        observerRetirement,
      )
      if (epoch !== activeGenerationRecoveryEpoch || controller.signal.aborted) {
        return {
          status: 'error',
          error: timedOut ? 'Generation authority refresh timed out.' : 'Generation authority refresh was superseded.',
        }
      }
      if (!applied) {
        return { status: 'error', error: 'Generation authority projection was superseded.' }
      }
      return { status: 'ok' }
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(deadline)
      options.signal?.removeEventListener('abort', handleOwnerAbort)
      if (runtimeJobRefresh === request) runtimeJobRefresh = null
    }
  })()
  request = { epoch, controller, promise }
  runtimeJobRefresh = request
  return waitForRuntimeJobRefresh(promise, options.signal)
}

export async function refreshActiveGenerationJobsFromBootstrap(
  signal?: AbortSignal | null,
  source: GenerationJobProjectionSource = 'status_probe',
): Promise<void> {
  await refreshGenerationAuthority(source, { signal })
}

function generationOperationNeedsLifecycleAuthorityRefresh(operation: GenerationOperationProjection): boolean {
  return (
    operation.state === 'accepted' ||
    operation.state === 'launching' ||
    operation.state === 'owned_by_job' ||
    operation.state === 'stopping' ||
    operation.state === 'finalizing'
  )
}

function generationRecoveryInterestKeys(): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const job of authoritativeGenerationJobsById.values()) keys.add(`job:${job.jobId}`)
  for (const obligation of captureGenerationRecoveryObligations()) {
    keys.add(`obligation:${obligation.token}`)
  }
  for (const job of pendingAbsentGenerationReconciliations.values()) keys.add(`reconciliation:${job.jobId}`)
  for (const activity of get(activeChatGenerations)) {
    if (activity.kind === 'message') keys.add(`activity:${activity.id}`)
  }
  for (const operation of get(getGenerationOperationsRuntime().generationOperationProjections)) {
    if (generationOperationNeedsLifecycleAuthorityRefresh(operation)) {
      const attemptIdentity = operation.currentAttempt
        ? `${operation.currentAttempt.retryRequestId}:${operation.currentAttempt.attemptNo}`
        : `${operation.state}:${operation.stateVersion}`
      keys.add(`operation:${operation.operationId}:${attemptIdentity}`)
    }
  }
  return keys
}

function hasGenerationRecoveryInterest(): boolean {
  return generationRecoveryInterestKeys().size > 0
}

function retainsGenerationRecoveryInterest(expected: ReadonlySet<string>): boolean {
  const current = generationRecoveryInterestKeys()
  for (const key of expected) {
    if (current.has(key)) return true
  }
  return false
}

function clearLifecycleAuthorityRetry(): void {
  if (lifecycleAuthorityRetryTimer !== null) clearTimeout(lifecycleAuthorityRetryTimer)
  lifecycleAuthorityRetryTimer = null
}

function scheduleLifecycleAuthorityRetry(
  source: GenerationJobProjectionSource,
  sequence: number,
  completedRetries: number,
): void {
  const delayMs = LIFECYCLE_AUTHORITY_RETRY_DELAYS_MS[completedRetries]
  const retryInterest = generationRecoveryInterestKeys()
  if (delayMs === undefined || reattachDisabled || sequence !== lifecycleRecoverySequence || retryInterest.size === 0) {
    return
  }
  clearLifecycleAuthorityRetry()
  lifecycleAuthorityRetryTimer = setTimeout(() => {
    lifecycleAuthorityRetryTimer = null
    if (
      reattachDisabled ||
      sequence !== lifecycleRecoverySequence ||
      !retainsGenerationRecoveryInterest(retryInterest)
    ) {
      return
    }
    void refreshRuntimeJobsAndTriggerReattach(source, sequence, completedRetries + 1)
  }, delayMs)
}

async function refreshRuntimeJobsAndTriggerReattach(
  source: GenerationJobProjectionSource,
  sequence: number,
  completedRetries: number,
): Promise<void> {
  let authority: GenerationAuthorityRefreshResult
  try {
    authority = await refreshGenerationAuthority(source, { supersede: true })
  } finally {
    if (!reattachDisabled) triggerOpenChatGenerationReattach()
  }
  if (sequence !== lifecycleRecoverySequence || reattachDisabled) return
  if (authority.status === 'ok') {
    if (captureGenerationRecoveryObligations().length > 0 || pendingAbsentGenerationReconciliations.size > 0) {
      scheduleLifecycleAuthorityRetry(source, sequence, completedRetries)
    } else {
      clearLifecycleAuthorityRetry()
    }
    return
  }
  scheduleLifecycleAuthorityRetry(source, sequence, completedRetries)
}

function requestLifecycleGenerationRecovery(source: GenerationJobProjectionSource): void {
  if (!hasGenerationRecoveryInterest()) return
  pendingLifecycleWakeupSource = source
  lifecycleRecoverySequence += 1
  clearLifecycleAuthorityRetry()
  if (lifecycleWakeupQueued) return
  lifecycleWakeupQueued = true
  queueMicrotask(() => {
    lifecycleWakeupQueued = false
    const pendingSource = pendingLifecycleWakeupSource
    pendingLifecycleWakeupSource = null
    if (!pendingSource || reattachDisabled) return
    void refreshRuntimeJobsAndTriggerReattach(pendingSource, lifecycleRecoverySequence, 0)
  })
}

/**
 * Wire the reattach trigger: whenever the selected character changes (the
 * reload-resume entry point — the user opens the chat that was generating), try
 * to re-attach. Idempotent; safe to call once at startup.
 */
export function startActiveGenerationReattach(): void {
  if (wired) return
  wired = true
  reattachDisabled = false
  stopSelectedCharacterSubscription = selectedCharID.subscribe(() => {
    triggerOpenChatGenerationReattach()
  })
  stopGenerationActivitySubscription = activeChatGenerations.subscribe(() => {
    triggerOpenChatGenerationReattach()
  })

  // A mobile tab can remain mounted while its fetch/SSE sockets are discarded.
  // Refresh the server's active-job projection when the page or network returns
  // so even a request dropped before its job-id header arrived can recover.
  stopGenerationLifecycleRecoverySubscription = subscribeBrowserLifecycleRecovery((source, context) => {
    if (!reattachDisabled && context?.suspensionEvidence) requestLifecycleGenerationRecovery(source)
  })
}

export function stopActiveGenerationReattach(): void {
  reattachDisabled = true
  wired = false
  reattachQueued = false
  lifecycleWakeupQueued = false
  pendingLifecycleWakeupSource = null
  lifecycleRecoverySequence += 1
  clearLifecycleAuthorityRetry()
  runtimeJobRefresh?.controller.abort()
  runtimeJobRefresh = null
  reattachingJobIds.clear()
  clearAllReattachRetryStates()
  stopSelectedCharacterSubscription?.()
  stopSelectedCharacterSubscription = null
  stopGenerationActivitySubscription?.()
  stopGenerationActivitySubscription = null
  stopGenerationLifecycleRecoverySubscription?.()
  stopGenerationLifecycleRecoverySubscription = null
}

export function resetGenerationJobLifecyclesForTests(): void {
  lifecycleRecoverySequence += 1
  clearLifecycleAuthorityRetry()
  clearActiveGenerationJobProjection()
  activeGenerationProjectionApplicationVersion = 0
  activeGenerationRecoveryEpoch = 0
  generationJobLifecycles.set({})
}
