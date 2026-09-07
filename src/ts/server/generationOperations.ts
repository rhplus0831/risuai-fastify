import {
  canUseClientWriteAccess,
  canUseClientRecoveryAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { get, writable } from 'svelte/store'
import {
  appendOptimisticGenerationOperationUserMessage,
  toMessageSnapshot,
  type ActiveChatTarget,
} from '../chatCommands'
import type { Message } from '../storage/database.svelte'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import {
  acknowledgeHydratedAcceptedSendRecoveries,
  applyAcceptedSendBootstrapProjection,
  applyAcceptedSendOperationProjection,
  clearAcceptedSendRecoveryProjection,
} from '../process/acceptedSendRecoveryState'
import {
  authoritativeGenerationJobForChat,
  clearActiveGenerationJobProjection,
  forgetActiveGenerationJob,
  rememberActiveGenerationJob,
  setActiveGenerationJobs,
  type GenerationJobProjectionSource,
} from '../process/reattach'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse, isWriterAccessLost } from './activeWriterSession'
import {
  getServerCommandBaseRevision,
  peekCachedServerCommandRevision,
  setCachedServerCommandRevision,
  SERVER_DATABASE_LINEAGE_HEADER,
  withDirectServerCommandEventReconciliation,
  type CommandEvent,
  type MessageMutationLocalEffect,
  type ServerCommandLocalEffect,
} from './commands'
import {
  beginPendingMutationDispatch,
  discardPendingMutation,
  isGenerationOperationPendingIntent,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
} from './pendingMutationOutbox'
import {
  parseGenerationOperations,
  type ActiveGenerationJob,
  type GenerationOperationProjection,
  type ServerBootstrapRuntime,
} from './bootstrap'
import { recordGenerationRecoveryEvent } from './protocolDiagnostics'
import { registerGenerationOperationsRuntime } from '../process/generationRuntimeBridge'
import { language } from '../../lang'
import { canGenerate, getGenerationReadinessDiagnostic } from '../startupReadiness'

const GENERATION_OPERATIONS_ENDPOINT = '/api/v1/generation-operations'
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_REVISION_RETRIES = 3
const CANCELLATION_STATUS_TIMEOUT_MS = 10_000
const CANCELLATION_RECONCILE_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 5_000] as const

type GenerationOperationAccess = 'ordinary' | 'pending-replay'

function canUseGenerationOperationAccess(access: GenerationOperationAccess): boolean {
  return (
    !isWriterAccessLost() &&
    (access === 'pending-replay' ? canUseClientRecoveryAccess() : canUseClientWriteAccess() && canGenerate())
  )
}

function generationAccessIsCurrent(access: GenerationOperationAccess, sourceGeneration: number): boolean {
  return canUseGenerationOperationAccess(access) && isClientSessionGenerationCurrent(sourceGeneration)
}

const stagedOperationGenerations = new WeakMap<PendingMutationHandle, number>()

function generationNotReadyError(): string {
  const readiness = getGenerationReadinessDiagnostic()
  const blockers: string[] = [...readiness.blockers]
  if (isWriterAccessLost()) blockers.unshift('writer-access-lost')
  return language.composerDraftRecovery.sendFailureDetails.generationNotReady(
    blockers.length > 0 ? blockers.join(', ') : 'readiness-changed',
    readiness.phase ?? 'not-started',
    readiness.failureCode ?? 'none',
  )
}

export interface GenerationOperationGenerationIntent {
  syntheticSayNothing: boolean
  resetMessages: boolean
  loadoutId?: string
  inlayAssetRefs: unknown[]
  clientContext: unknown
  clientCapabilities: Record<string, unknown>
}

interface GenerationOperationSubmitRequestBase extends Record<string, unknown> {
  protocolVersion: 1
  operationId: string
  baseRevision: number
  characterId: string
  chatId: string
  draftGeneration: unknown
  generation: GenerationOperationGenerationIntent
}

export type GenerationOperationSubmitRequest = GenerationOperationSubmitRequestBase &
  (
    | {
        mode: 'send'
        acceptedMessageId: string
        message: Record<string, unknown> & { role?: 'user' | 'char'; data?: string; chatId?: string }
      }
    | {
        mode: 'continue' | 'regenerate'
        targetMessageId: string
      }
  )

export interface GenerationOperationStreamDescriptor {
  operationId: string
  acceptedMessageId?: string
  attemptNo: number
  jobId: string
  projectionEpoch: number
  href: string
}

export interface GenerationOperationResponse {
  operation: GenerationOperationProjection
  append?: {
    disposition: 'accepted' | 'not_appended'
    messageId: string
    revision?: number
    event?: CommandEvent
  }
  stream?: { href: string }
}

export type GenerationOperationCancellationDisposition =
  | 'cancelled_before_acceptance'
  | 'cancelling'
  | 'cancelled'
  | 'cancelled_finalizing'
  | 'completion_finalizing'
  | 'already_cancelled'
  | 'already_completed'
  | 'terminal_nonrunning'

export type GenerationOperationCancellationState =
  | 'none'
  | 'stop_staging'
  | 'stop_sending'
  | 'stop_waiting'
  | 'stop_failed'
  | 'stopped_finalizing'
  | 'settled_cancelled'
  | 'settled_completed'
  | 'settled_nonrunning'

export interface GenerationOperationCancellation {
  operationId: string
  target?: ActiveChatTarget
  state: GenerationOperationCancellationState
  disposition?: GenerationOperationCancellationDisposition
  operationState?: GenerationOperationProjection['state']
  stateVersion?: number
  projectionEpoch?: number
  attemptNo?: number
  jobId?: string
  error?: string
  code?: string
  knownAttemptMatched?: boolean
}

export type GenerationOperationCancellationResult =
  | {
      status: 'acknowledged'
      disposition: GenerationOperationCancellationDisposition
      operation: GenerationOperationProjection
      knownAttemptMatched: boolean
    }
  | { status: 'failed'; error: string; code?: string }

export interface StagedAcceptedSendOperation {
  target: ActiveChatTarget
  request: GenerationOperationSubmitRequest & { mode: 'send' }
  intent: DurableMutationIntent & { kind: 'generation-operation-submit' }
  handle: PendingMutationHandle
  optimisticMessage: Message
  optimisticChatBodyProjectionEpoch: number
  rollbackOptimisticAppend: () => void
}

export interface StagedTargetedGenerationOperation {
  target: ActiveChatTarget
  request: GenerationOperationSubmitRequest & { mode: 'continue' | 'regenerate' }
  intent: DurableMutationIntent & { kind: 'generation-operation-submit' }
  handle: PendingMutationHandle
}

export type GenerationOperationDispatchResult =
  | {
      status: 'accepted'
      response: GenerationOperationResponse
      stream?: GenerationOperationStreamDescriptor
    }
  | { status: 'retained'; error: string; code?: string }
  | { status: 'rejected'; error: string; code?: string; operation?: GenerationOperationProjection }

export type GenerationOperationPendingReplayOutcome = {
  disposition: 'discarded' | 'retained' | 'succeeded'
  result?: GenerationOperationDispatchResult | GenerationOperationCancellationResult
}

export const generationOperationProjections = writable<GenerationOperationProjection[]>([])
export const generationOperationCancellations = writable<GenerationOperationCancellation[]>([])

interface GenerationOperationCancellationRuntime {
  handle?: PendingMutationHandle
  intent?: DurableMutationIntent & { kind: 'generation-operation-cancel' }
  inFlight?: Promise<GenerationOperationCancellationResult>
  rollbackOptimisticAppend?: () => void
  viewers: Set<GenerationOperationViewer>
  reconcileAttempt: number
  reconcileTimer?: ReturnType<typeof setTimeout>
}

interface GenerationOperationViewer {
  onStop: () => void
  onRetire: () => void
}

const cancellationRuntimeByOperationId = new Map<string, GenerationOperationCancellationRuntime>()
let cancellationWakeListenersInstalled = false

let generationOperationProtocolVersion = 0
let generationOperationProjectionEpoch = 0
let generationOperationDatabaseLineage: string | null = null

export function configureGenerationOperationProtocol(
  protocol: { version: number } | undefined,
  databaseLineage?: string,
): void {
  generationOperationProtocolVersion = protocol?.version === 1 ? 1 : 0
  if (databaseLineage && generationOperationDatabaseLineage !== databaseLineage) {
    generationOperationDatabaseLineage = databaseLineage
    generationOperationProjectionEpoch = 0
    generationOperationProjections.set([])
    for (const runtime of cancellationRuntimeByOperationId.values()) {
      if (runtime.reconcileTimer !== undefined) clearTimeout(runtime.reconcileTimer)
    }
    cancellationRuntimeByOperationId.clear()
    generationOperationCancellations.set([])
    clearAcceptedSendRecoveryProjection()
    clearActiveGenerationJobProjection()
  }
}

export function canUseGenerationOperationProtocol(): boolean {
  return generationOperationProtocolVersion === 1
}

export function resetGenerationOperationClientForTests(): void {
  generationOperationProtocolVersion = 0
  generationOperationProjectionEpoch = 0
  generationOperationDatabaseLineage = null
  generationOperationProjections.set([])
  for (const runtime of cancellationRuntimeByOperationId.values()) {
    if (runtime.reconcileTimer !== undefined) clearTimeout(runtime.reconcileTimer)
  }
  cancellationRuntimeByOperationId.clear()
  generationOperationCancellations.set([])
  clearAcceptedSendRecoveryProjection()
  clearActiveGenerationJobProjection()
}

function createProtocolUuid(): string {
  const id = globalThis.crypto?.randomUUID?.()
  if (!id || !UUID_V4_RE.test(id)) throw new Error('A secure UUID generator is required for accepted sends.')
  return id
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function targetMatches(left: ActiveChatTarget | undefined, right: ActiveChatTarget | null | undefined): boolean {
  if (!left || !right) return false
  if (left.chatId && right.chatId) return left.chatId === right.chatId
  if (left.characterId && right.characterId && left.characterId !== right.characterId) return false
  return left.selectedCharID === right.selectedCharID && left.chatPage === right.chatPage
}

function cancellationRuntime(operationId: string): GenerationOperationCancellationRuntime {
  let runtime = cancellationRuntimeByOperationId.get(operationId)
  if (!runtime) {
    runtime = { viewers: new Set(), reconcileAttempt: 0 }
    cancellationRuntimeByOperationId.set(operationId, runtime)
  }
  return runtime
}

function cancellationByOperationId(operationId: string): GenerationOperationCancellation | undefined {
  return get(generationOperationCancellations).find((candidate) => candidate.operationId === operationId)
}

function cancellationAuthorityEstablished(control: GenerationOperationCancellation | undefined): boolean {
  return (
    control?.operationState === 'cancel_requested' ||
    control?.operationState === 'stopping' ||
    control?.operationState === 'finalizing' ||
    control?.operationState === 'cancelled' ||
    control?.operationState === 'completed' ||
    control?.operationState === 'terminal_failed' ||
    control?.operationState === 'invalidated'
  )
}

function updateGenerationOperationCancellation(
  operationId: string,
  update: (previous: GenerationOperationCancellation | undefined) => GenerationOperationCancellation | null,
): void {
  generationOperationCancellations.update((controls) => {
    const previous = controls.find((candidate) => candidate.operationId === operationId)
    const next = update(previous)
    const retained = controls.filter((candidate) => candidate.operationId !== operationId)
    if (!next) return retained
    const updated = [...retained, next]
    if (updated.length <= 256) return updated
    return updated.slice(updated.length - 256)
  })
}

function trackLocalGenerationOperation(
  operationId: string,
  target: ActiveChatTarget,
  rollbackOptimisticAppend: () => void,
): void {
  cancellationRuntime(operationId).rollbackOptimisticAppend = rollbackOptimisticAppend
  updateGenerationOperationCancellation(operationId, (previous) => ({
    operationId,
    target: { ...target },
    state: previous?.state ?? 'none',
    ...(previous?.disposition ? { disposition: previous.disposition } : {}),
    ...(previous?.operationState ? { operationState: previous.operationState } : {}),
    ...(previous?.stateVersion !== undefined ? { stateVersion: previous.stateVersion } : {}),
    ...(previous?.projectionEpoch !== undefined ? { projectionEpoch: previous.projectionEpoch } : {}),
    ...(previous?.attemptNo !== undefined ? { attemptNo: previous.attemptNo } : {}),
    ...(previous?.jobId ? { jobId: previous.jobId } : {}),
    ...(previous?.error ? { error: previous.error } : {}),
    ...(previous?.code ? { code: previous.code } : {}),
    ...(previous?.knownAttemptMatched !== undefined ? { knownAttemptMatched: previous.knownAttemptMatched } : {}),
  }))
}

export function findGenerationOperationIdForTarget(target: ActiveChatTarget | null | undefined): string | undefined {
  if (!target) return undefined
  const authoritativeJob = authoritativeGenerationJobForChat(target.chatId)
  if (authoritativeJob?.operationId && isProtocolGenerationOperationJob(authoritativeJob)) {
    return authoritativeJob.operationId
  }
  const authoritativeOperation = get(generationOperationProjections)
    .filter(
      (operation) =>
        operation.protocolVersion === 1 &&
        operation.chatId === target.chatId &&
        (operation.state === 'accepted' ||
          operation.state === 'launching' ||
          operation.state === 'owned_by_job' ||
          operation.state === 'stopping'),
    )
    .sort(
      (left, right) =>
        left.projectionEpoch - right.projectionEpoch ||
        left.stateVersion - right.stateVersion ||
        (left.currentAttempt?.attemptNo ?? 0) - (right.currentAttempt?.attemptNo ?? 0) ||
        (left.currentAttempt?.jobId ?? '').localeCompare(right.currentAttempt?.jobId ?? '') ||
        left.operationId.localeCompare(right.operationId),
    )
    .at(-1)
  if (authoritativeOperation) return authoritativeOperation.operationId
  const local = get(generationOperationCancellations)
    .filter(
      (control) =>
        targetMatches(control.target, target) &&
        (control.state === 'none' ||
          control.state === 'stop_staging' ||
          control.state === 'stop_sending' ||
          control.state === 'stop_waiting' ||
          control.state === 'stop_failed'),
    )
    .at(-1)
  if (local) return local.operationId
  return undefined
}

export function registerGenerationOperationViewer(
  operationId: string,
  onStop: () => void,
  onRetire: () => void = onStop,
): () => void {
  const runtime = cancellationRuntime(operationId)
  const viewer = { onStop, onRetire }
  runtime.viewers.add(viewer)
  const state = cancellationByOperationId(operationId)?.state
  if (
    state === 'stop_sending' ||
    state === 'stop_waiting' ||
    state === 'stopped_finalizing' ||
    state === 'settled_cancelled' ||
    state === 'settled_completed' ||
    state === 'settled_nonrunning'
  ) {
    queueMicrotask(onStop)
  }
  return () => runtime.viewers.delete(viewer)
}

function detachGenerationOperationViewers(operationId: string): void {
  const runtime = cancellationRuntime(operationId)
  for (const viewer of [...runtime.viewers]) {
    try {
      viewer.onStop()
    } catch (error) {
      console.error(error)
    }
  }
  runtime.viewers.clear()
}

/** Retire stale local observers without changing durable operation state. */
export function retireGenerationOperationViewers(operationId: string): void {
  const runtime = cancellationRuntimeByOperationId.get(operationId)
  if (!runtime) return
  for (const viewer of [...runtime.viewers]) {
    try {
      viewer.onRetire()
    } catch (error) {
      console.error(error)
    }
  }
  runtime.viewers.clear()
}

function operationIntentForSubmit(request: GenerationOperationSubmitRequest): DurableMutationIntent & {
  kind: 'generation-operation-submit'
} {
  return {
    version: 1,
    kind: 'generation-operation-submit',
    requests: [{ method: 'POST', path: '/generation-operations', body: cloneJson(request) }],
  }
}

function operationIntentForRetry(
  operationId: string,
  retryRequestId: string,
  expectedStateVersion: number,
): DurableMutationIntent & { kind: 'generation-operation-retry' } {
  return {
    version: 1,
    kind: 'generation-operation-retry',
    requests: [
      {
        method: 'POST',
        path: `/generation-operations/${encodeURIComponent(operationId)}/retries`,
        body: { retryRequestId, expectedStateVersion },
      },
    ],
  }
}

function operationIntentForCancellation(
  operationId: string,
  advisory: Pick<GenerationOperationCancellation, 'stateVersion' | 'attemptNo' | 'jobId'> = {},
): DurableMutationIntent & { kind: 'generation-operation-cancel' } {
  return {
    version: 1,
    kind: 'generation-operation-cancel',
    requests: [
      {
        method: 'PUT',
        path: `/generation-operations/${encodeURIComponent(operationId)}/cancellation`,
        body: {
          reason: 'user_stop',
          ...(advisory.stateVersion !== undefined ? { knownStateVersion: advisory.stateVersion } : {}),
          ...(advisory.attemptNo !== undefined ? { knownAttemptNo: advisory.attemptNo } : {}),
          ...(advisory.jobId ? { knownJobId: advisory.jobId } : {}),
        },
      },
    ],
  }
}

export async function stageAcceptedSendGenerationOperation(input: {
  target: ActiveChatTarget
  message: string | Message
  draftGeneration?: unknown
  generation: GenerationOperationGenerationIntent
}): Promise<StagedAcceptedSendOperation | { status: 'error'; error: string }> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!canUseGenerationOperationAccess('ordinary')) {
    return { status: 'error', error: generationNotReadyError() }
  }
  if (!input.target.characterId || !input.target.chatId) {
    return { status: 'error', error: 'The active chat has no durable server identity.' }
  }
  const baseRevision = peekCachedServerCommandRevision() ?? (await getServerCommandBaseRevision())
  if (!generationAccessIsCurrent('ordinary', sourceGeneration))
    return { status: 'error', error: generationNotReadyError() }
  if (baseRevision === null) return { status: 'error', error: 'The server revision is unavailable.' }

  // Both identifiers exist before the complete request is staged.
  const operationId = createProtocolUuid()
  const acceptedMessageId = createProtocolUuid()
  const optimisticMessage: Message =
    typeof input.message === 'string'
      ? { role: 'user', data: input.message, time: Date.now(), chatId: acceptedMessageId }
      : { ...cloneJson(input.message), chatId: acceptedMessageId }
  const request: GenerationOperationSubmitRequest & { mode: 'send' } = {
    protocolVersion: 1,
    operationId,
    baseRevision,
    characterId: input.target.characterId,
    chatId: input.target.chatId,
    mode: 'send',
    acceptedMessageId,
    message: toMessageSnapshot(optimisticMessage),
    draftGeneration: cloneJson(input.draftGeneration ?? null),
    generation: cloneJson(input.generation),
  }
  const intent = operationIntentForSubmit(request)
  const handle = stagePendingMutation(`generation-operation-submit:${operationId}`, intent)
  stagedOperationGenerations.set(handle, sourceGeneration)
  const persistence = await handle.ready
  if (!generationAccessIsCurrent('ordinary', sourceGeneration))
    return { status: 'error', error: generationNotReadyError() }
  if (persistence !== 'persisted') {
    return { status: 'error', error: 'The accepted send could not be staged durably.' }
  }
  const { getChatTranscriptOwnerState } = await import('./chatTranscriptOwner')
  if (!generationAccessIsCurrent('ordinary', sourceGeneration))
    return { status: 'error', error: generationNotReadyError() }
  const optimistic = appendOptimisticGenerationOperationUserMessage(input.target, optimisticMessage)
  if (optimistic.status === 'error') {
    await discardPendingMutation(handle)
    return optimistic
  }
  const transcriptOwner = getChatTranscriptOwnerState(input.target.chatId)
  if (!transcriptOwner) {
    optimistic.rollback()
    await discardPendingMutation(handle)
    return { status: 'error', error: 'The active chat transcript owner is unavailable.' }
  }
  const optimisticChatBodyProjectionEpoch = transcriptOwner.projectionEpoch
  trackLocalGenerationOperation(operationId, input.target, optimistic.rollback)
  return {
    target: { ...input.target },
    request,
    intent,
    handle,
    optimisticMessage,
    optimisticChatBodyProjectionEpoch,
    rollbackOptimisticAppend: optimistic.rollback,
  }
}

export async function stageTargetedGenerationOperation(input: {
  target: ActiveChatTarget
  mode: 'continue' | 'regenerate'
  targetMessageId: string
  draftGeneration?: unknown
  generation: GenerationOperationGenerationIntent
}): Promise<StagedTargetedGenerationOperation | { status: 'error'; error: string }> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!canUseGenerationOperationAccess('ordinary')) {
    return { status: 'error', error: generationNotReadyError() }
  }
  if (!input.target.characterId || !input.target.chatId) {
    return { status: 'error', error: 'The active chat has no durable server identity.' }
  }
  if (!input.targetMessageId) {
    return { status: 'error', error: 'The generation target has no durable message identity.' }
  }
  const baseRevision = peekCachedServerCommandRevision() ?? (await getServerCommandBaseRevision())
  if (!generationAccessIsCurrent('ordinary', sourceGeneration))
    return { status: 'error', error: generationNotReadyError() }
  if (baseRevision === null) return { status: 'error', error: 'The server revision is unavailable.' }

  const operationId = createProtocolUuid()
  const request: GenerationOperationSubmitRequest & { mode: 'continue' | 'regenerate' } = {
    protocolVersion: 1,
    operationId,
    baseRevision,
    characterId: input.target.characterId,
    chatId: input.target.chatId,
    mode: input.mode,
    targetMessageId: input.targetMessageId,
    draftGeneration: cloneJson(input.draftGeneration ?? null),
    generation: cloneJson(input.generation),
  }
  const intent = operationIntentForSubmit(request)
  const handle = stagePendingMutation(`generation-operation-submit:${operationId}`, intent)
  stagedOperationGenerations.set(handle, sourceGeneration)
  const persistence = await handle.ready
  if (!generationAccessIsCurrent('ordinary', sourceGeneration))
    return { status: 'error', error: generationNotReadyError() }
  if (persistence !== 'persisted') {
    return { status: 'error', error: 'The generation operation could not be staged durably.' }
  }
  trackLocalGenerationOperation(operationId, input.target, () => undefined)
  return { target: { ...input.target }, request, intent, handle }
}

function errorMessage(body: unknown, response: Response): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (typeof record.message === 'string' && record.message) return record.message
    if (typeof record.error === 'string' && record.error) return record.error
  }
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const value = (body as Record<string, unknown>).error
  return typeof value === 'string' ? value : undefined
}

function operationFromBody(body: unknown): GenerationOperationProjection | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  return parseGenerationOperations([record.operation])[0]
}

function commandEventFromValue(value: unknown): CommandEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return undefined
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) return undefined
  if (typeof record.resource !== 'string') return undefined
  if (record.id !== undefined && typeof record.id !== 'string') return undefined
  if (record.parentId !== undefined && typeof record.parentId !== 'string') return undefined
  if (
    record.origin !== undefined &&
    (!record.origin ||
      typeof record.origin !== 'object' ||
      Array.isArray(record.origin) ||
      typeof (record.origin as { writerSessionId?: unknown }).writerSessionId !== 'string')
  ) {
    return undefined
  }
  return {
    type: record.type,
    revision: record.revision as number,
    resource: record.resource,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.parentId === 'string' ? { parentId: record.parentId } : {}),
    ...(record.origin
      ? { origin: { writerSessionId: (record.origin as { writerSessionId: string }).writerSessionId } }
      : {}),
  }
}

function responseFromBody(body: unknown): GenerationOperationResponse | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const operation = operationFromBody(body)
  if (!operation) return undefined
  const result: GenerationOperationResponse = { operation }
  if (record.append && typeof record.append === 'object' && !Array.isArray(record.append)) {
    const append = record.append as Record<string, unknown>
    if (
      (append.disposition === 'accepted' || append.disposition === 'not_appended') &&
      typeof append.messageId === 'string'
    ) {
      const event = commandEventFromValue(append.event)
      result.append = {
        disposition: append.disposition,
        messageId: append.messageId,
        ...(Number.isSafeInteger(append.revision) && (append.revision as number) >= 0
          ? { revision: append.revision as number }
          : {}),
        ...(event ? { event } : {}),
      }
    }
  }
  if (record.stream && typeof record.stream === 'object' && !Array.isArray(record.stream)) {
    const href = (record.stream as Record<string, unknown>).href
    if (typeof href === 'string') result.stream = { href }
  }
  return result
}

function operationStreamHref(operation: GenerationOperationProjection): string | undefined {
  const attempt = operation.currentAttempt
  if (!attempt) return undefined
  return `${GENERATION_OPERATIONS_ENDPOINT}/${encodeURIComponent(operation.operationId)}/stream?attemptNo=${attempt.attemptNo}&jobId=${encodeURIComponent(attempt.jobId)}&projectionEpoch=${operation.projectionEpoch}`
}

function safeOperationStreamHref(operation: GenerationOperationProjection, supplied?: string): string | undefined {
  const expected = operationStreamHref(operation)
  if (!expected) return undefined
  return supplied === expected ? supplied : expected
}

export function generationOperationStreamDescriptor(
  response: GenerationOperationResponse,
): GenerationOperationStreamDescriptor | undefined {
  const operation = response.operation
  const attempt = operation.currentAttempt
  if (!attempt) return undefined
  const href = safeOperationStreamHref(operation, response.stream?.href)
  if (!href) return undefined
  return {
    operationId: operation.operationId,
    ...(operation.acceptedMessageId ? { acceptedMessageId: operation.acceptedMessageId } : {}),
    attemptNo: attempt.attemptNo,
    jobId: attempt.jobId,
    projectionEpoch: operation.projectionEpoch,
    href,
  }
}

function generationOperationForJob(
  job: Pick<ActiveGenerationJob, 'operationId'>,
): GenerationOperationProjection | undefined {
  if (!job.operationId) return undefined
  return get(generationOperationProjections).find((operation) => operation.operationId === job.operationId)
}

export function isProtocolGenerationOperationJob(job: Pick<ActiveGenerationJob, 'operationId'>): boolean {
  return generationOperationForJob(job)?.protocolVersion === 1
}

/** Resolve a protocol job only when every captured attempt field is still exact. */
export function generationOperationStreamForActiveJob(
  job: ActiveGenerationJob,
): GenerationOperationStreamDescriptor | undefined {
  const operation = generationOperationForJob(job)
  const attempt = operation?.currentAttempt
  if (
    !operation ||
    operation.protocolVersion !== 1 ||
    (operation.state !== 'owned_by_job' && operation.state !== 'stopping') ||
    !attempt ||
    attempt.jobId !== job.jobId ||
    (job.attemptNo !== undefined && attempt.attemptNo !== job.attemptNo) ||
    (job.operationStateVersion !== undefined && operation.stateVersion !== job.operationStateVersion) ||
    (job.projectionEpoch !== undefined && operation.projectionEpoch !== job.projectionEpoch)
  ) {
    return undefined
  }
  return generationOperationStreamDescriptor({ operation })
}

export type GenerationOperationErrorAuthority =
  | { disposition: 'unresolved' }
  | {
      disposition: 'redirected'
      operation: GenerationOperationProjection
      stream: GenerationOperationStreamDescriptor
    }
  | {
      disposition: 'terminal' | 'finalizing' | 'recoverable' | 'nonlive'
      operation: GenerationOperationProjection
    }

/** Apply a typed error-body projection and classify its durable authority. */
export function reconcileGenerationOperationErrorBody(body: unknown): GenerationOperationErrorAuthority {
  const operation = operationFromBody(body)
  if (!operation) return { disposition: 'unresolved' }
  applyGenerationOperationProjection(operation, undefined, 'stale_reattach')
  const stream =
    operation.state === 'owned_by_job' || operation.state === 'stopping'
      ? generationOperationStreamDescriptor({ operation })
      : undefined
  if (stream) return { disposition: 'redirected', operation, stream }
  if (
    operation.state === 'completed' ||
    operation.state === 'cancelled' ||
    operation.state === 'terminal_failed' ||
    operation.state === 'invalidated'
  ) {
    return { disposition: 'terminal', operation }
  }
  if (operation.state === 'finalizing') return { disposition: 'finalizing', operation }
  if (operation.state === 'retryable' || operation.state === 'abandoned') {
    return { disposition: 'recoverable', operation }
  }
  return { disposition: 'nonlive', operation }
}

function clearCancellationReconcileTimer(operationId: string): void {
  const runtime = cancellationRuntimeByOperationId.get(operationId)
  if (!runtime || runtime.reconcileTimer === undefined) return
  clearTimeout(runtime.reconcileTimer)
  runtime.reconcileTimer = undefined
}

function retireCancellationIntent(operationId: string): void {
  const runtime = cancellationRuntimeByOperationId.get(operationId)
  clearCancellationReconcileTimer(operationId)
  if (!runtime?.handle) return
  const handle = runtime.handle
  void discardPendingMutation(handle).then((outcome) => {
    if (outcome === 'deleted' || outcome === 'superseded') {
      const current = cancellationRuntimeByOperationId.get(operationId)
      if (current?.handle === handle) {
        current.handle = undefined
        current.intent = undefined
      }
    }
  })
}

function forgetTerminalCancellationJob(
  operation: GenerationOperationProjection,
  outcome?: 'cancelled' | 'completed',
): void {
  const jobId = operation.currentAttempt?.jobId
  if (!jobId) return
  forgetActiveGenerationJob(jobId, outcome)
}

function cancellationTargetFromOperation(
  operation: GenerationOperationProjection,
  previous?: GenerationOperationCancellation,
): ActiveChatTarget | undefined {
  if (previous.target) return previous.target
  if (!operation.chatId && !operation.characterId) return undefined
  return {
    selectedCharID: -1,
    chatPage: -1,
    characterId: operation.characterId,
    chatId: operation.chatId,
  }
}

function cancellationTargetForOperationId(
  operationId: string,
  previous?: GenerationOperationCancellation,
): ActiveChatTarget | undefined {
  if (previous?.target) return previous.target
  const operation = get(generationOperationProjections).find((candidate) => candidate.operationId === operationId)
  return operation ? cancellationTargetFromOperation(operation, previous) : undefined
}

function syncGenerationOperationCancellationProjection(operation: GenerationOperationProjection): void {
  const previous = cancellationByOperationId(operation.operationId)
  if (!previous) return
  let state = previous.state
  let disposition = previous.disposition
  if (previous.state !== 'none') {
    if (operation.state === 'cancel_requested') {
      state = 'settled_cancelled'
      disposition = 'cancelled_before_acceptance'
      retireCancellationIntent(operation.operationId)
    } else if (operation.state === 'cancelled') {
      state = 'settled_cancelled'
      disposition = 'already_cancelled'
      forgetTerminalCancellationJob(operation, 'cancelled')
      retireCancellationIntent(operation.operationId)
    } else if (operation.state === 'completed') {
      state = 'settled_completed'
      disposition = 'already_completed'
      forgetTerminalCancellationJob(operation, 'completed')
      retireCancellationIntent(operation.operationId)
    } else if (operation.state === 'finalizing' && operation.desiredTerminalOutcome === 'cancelled') {
      state = 'stopped_finalizing'
      disposition = 'cancelled_finalizing'
    } else if (operation.state === 'finalizing' && operation.desiredTerminalOutcome === 'completed') {
      state = 'stop_waiting'
      disposition = 'completion_finalizing'
    } else if (operation.state === 'stopping') {
      state = 'stop_waiting'
      disposition = 'cancelling'
    } else if (operation.state === 'terminal_failed' || operation.state === 'invalidated') {
      forgetTerminalCancellationJob(operation)
      retireCancellationIntent(operation.operationId)
      state = 'settled_nonrunning'
      disposition = 'terminal_nonrunning'
    }
  } else if (
    operation.state === 'completed' ||
    operation.state === 'cancelled' ||
    operation.state === 'terminal_failed' ||
    operation.state === 'invalidated' ||
    operation.state === 'retryable' ||
    operation.state === 'abandoned'
  ) {
    updateGenerationOperationCancellation(operation.operationId, () => null)
    return
  }
  updateGenerationOperationCancellation(operation.operationId, (current) => ({
    operationId: operation.operationId,
    target: cancellationTargetFromOperation(operation, current ?? previous),
    state,
    ...(disposition ? { disposition } : {}),
    operationState: operation.state,
    stateVersion: operation.stateVersion,
    projectionEpoch: operation.projectionEpoch,
    ...(operation.currentAttempt
      ? { attemptNo: operation.currentAttempt.attemptNo, jobId: operation.currentAttempt.jobId }
      : {}),
    ...(current?.error ? { error: current.error } : {}),
    ...(current?.code ? { code: current.code } : {}),
    ...(current?.knownAttemptMatched !== undefined ? { knownAttemptMatched: current.knownAttemptMatched } : {}),
  }))
  if (state === 'stop_waiting' || state === 'stopped_finalizing') {
    scheduleGenerationOperationCancellationReconcile(operation.operationId)
  }
}

function applyGenerationOperationProjectionState(
  operation: GenerationOperationProjection,
  capturedTarget?: ActiveChatTarget,
): boolean {
  generationOperationProjectionEpoch = Math.max(generationOperationProjectionEpoch, operation.projectionEpoch)
  let accepted = true
  generationOperationProjections.update((operations) => {
    const previous = operations.find((candidate) => candidate.operationId === operation.operationId)
    if (
      previous &&
      (previous.projectionEpoch > operation.projectionEpoch ||
        (previous.projectionEpoch === operation.projectionEpoch && previous.stateVersion > operation.stateVersion))
    ) {
      accepted = false
      return operations
    }
    return [...operations.filter((candidate) => candidate.operationId !== operation.operationId), operation].sort(
      (left, right) =>
        left.projectionEpoch - right.projectionEpoch || left.operationId.localeCompare(right.operationId),
    )
  })
  if (!accepted) return false
  applyAcceptedSendOperationProjection(operation, capturedTarget)
  syncGenerationOperationCancellationProjection(operation)
  return true
}

function applyGenerationOperationBootstrapState(
  runtime: ServerBootstrapRuntime,
  source: GenerationJobProjectionSource,
): boolean {
  configureGenerationOperationProtocol(runtime.generationOperationProtocol, runtime.databaseLineage)
  const epoch = runtime.generationOperationProjectionEpoch ?? 0
  if (epoch < generationOperationProjectionEpoch) return false
  const previousOperations = get(generationOperationProjections)
  generationOperationProjectionEpoch = epoch
  const operations = (runtime.generationOperations ?? []).map((operation) => {
    const previous = previousOperations.find((candidate) => candidate.operationId === operation.operationId)
    if (!previous) return operation
    if (
      previous.projectionEpoch > operation.projectionEpoch ||
      (previous.projectionEpoch === operation.projectionEpoch && previous.stateVersion > operation.stateVersion)
    ) {
      return previous
    }
    return operation
  })
  generationOperationProjections.set([...operations])
  applyAcceptedSendBootstrapProjection(operations, runtime.activeGenerationJobs ?? [], epoch)
  for (const operation of operations) syncGenerationOperationCancellationProjection(operation)
  setActiveGenerationJobs(runtime.activeGenerationJobs ?? [], {
    projectionEpoch: epoch,
    operations,
    source,
  })
  return true
}

function operationFromSseEvent(data: Record<string, unknown>): GenerationOperationProjection | undefined {
  if (
    typeof data.operationId !== 'string' ||
    !Number.isSafeInteger(data.operationStateVersion) ||
    !Number.isSafeInteger(data.projectionEpoch)
  ) {
    return undefined
  }
  const previous = get(generationOperationProjections).find((operation) => operation.operationId === data.operationId)
  if (!previous) return undefined
  if (Number.isSafeInteger(data.attemptNo) && typeof data.jobId === 'string' && previous.currentAttempt) {
    const attemptNo = data.attemptNo as number
    if (
      attemptNo < previous.currentAttempt.attemptNo ||
      (attemptNo === previous.currentAttempt.attemptNo && data.jobId !== previous.currentAttempt.jobId)
    ) {
      return undefined
    }
  }
  const operation: GenerationOperationProjection = {
    ...previous,
    stateVersion: data.operationStateVersion as number,
    projectionEpoch: data.projectionEpoch as number,
  }
  if (typeof data.operationState === 'string') {
    operation.state = data.operationState as GenerationOperationProjection['state']
  } else if (data.type === 'job_accepted') {
    operation.state = 'owned_by_job'
  }
  if (Number.isSafeInteger(data.attemptNo) && typeof data.jobId === 'string' && operation.currentAttempt) {
    operation.currentAttempt = {
      ...operation.currentAttempt,
      attemptNo: data.attemptNo as number,
      jobId: data.jobId,
      status: operation.state === 'stopping' ? 'stopping' : 'running',
    }
  }
  if (data.type === 'done') {
    const postGeneration =
      data.postGeneration && typeof data.postGeneration === 'object' && !Array.isArray(data.postGeneration)
        ? (data.postGeneration as Record<string, unknown>)
        : undefined
    if (typeof postGeneration?.messageId === 'string') operation.resultMessageId = postGeneration.messageId
  }
  return operation
}

function reconcileActiveJobFromOperation(
  operation: GenerationOperationProjection,
  options: { removeNonlive: boolean },
): void {
  const attempt = operation.currentAttempt
  if (
    operation.protocolVersion === 1 &&
    operation.chatId &&
    attempt &&
    (operation.state === 'owned_by_job' || operation.state === 'stopping')
  ) {
    rememberActiveGenerationJob({
      chatId: operation.chatId,
      jobId: attempt.jobId,
      ...(operation.mode ? { mode: operation.mode } : {}),
      ...(operation.mode === 'regenerate' && operation.targetMessageId
        ? { regenerateMessageId: operation.targetMessageId }
        : {}),
      operationId: operation.operationId,
      operationStateVersion: operation.stateVersion,
      projectionEpoch: operation.projectionEpoch,
      attemptNo: attempt.attemptNo,
      ...(operation.acceptedMessageId ? { acceptedMessageId: operation.acceptedMessageId } : {}),
      ...(operation.targetMessageId ? { targetMessageId: operation.targetMessageId } : {}),
    })
    return
  }
  const current = authoritativeGenerationJobForChat(operation.chatId)
  if (options.removeNonlive && current?.operationId === operation.operationId) {
    forgetActiveGenerationJob(current.jobId)
  }
}

export type GenerationOperationReconcilerSource =
  | GenerationJobProjectionSource
  | 'submit'
  | 'status'
  | 'retry'
  | 'cancellation'
  | 'job_accepted'
  | 'terminal_sse'
  | 'sse'
  | 'stale_reattach'
  | 'transcript_hydration'

export type GenerationOperationLifecycleUpdate =
  | {
      kind: 'bootstrap'
      source: GenerationJobProjectionSource
      runtime: ServerBootstrapRuntime
    }
  | {
      kind: 'operation'
      source: GenerationOperationReconcilerSource
      operation: GenerationOperationProjection
      capturedTarget?: ActiveChatTarget
    }
  | {
      kind: 'sse'
      source: 'job_accepted' | 'terminal_sse' | 'sse'
      data: Record<string, unknown>
      job?: Pick<ActiveGenerationJob, 'chatId' | 'mode' | 'regenerateMessageId'>
    }
  | {
      kind: 'transcript_hydration'
      source: 'transcript_hydration'
      chatId: string
      messages: readonly unknown[]
    }

/**
 * The single browser ingress for operation/job authority. Bootstrap refreshes,
 * lifecycle wakeups, local SSE, and transcript hydration all converge here so
 * they share one epoch fence and one same-chat selector.
 */
export function reconcileGenerationOperationLifecycle(update: GenerationOperationLifecycleUpdate): boolean {
  if (update.kind === 'bootstrap') {
    return applyGenerationOperationBootstrapState(update.runtime, update.source)
  }
  if (update.kind === 'transcript_hydration') {
    acknowledgeHydratedAcceptedSendRecoveries(update.chatId, update.messages)
    return true
  }
  if (update.kind === 'operation') {
    const applied = applyGenerationOperationProjectionState(update.operation, update.capturedTarget)
    if (applied) reconcileActiveJobFromOperation(update.operation, { removeNonlive: true })
    return applied
  }

  const operation = operationFromSseEvent(update.data)
  if (operation && !applyGenerationOperationProjectionState(operation)) return false
  if (operation) reconcileActiveJobFromOperation(operation, { removeNonlive: false })
  const jobId = typeof update.data.jobId === 'string' ? update.data.jobId : undefined
  if (update.source === 'job_accepted' && jobId && update.job) {
    rememberActiveGenerationJob({
      ...update.job,
      jobId,
      ...(typeof update.data.databaseLineage === 'string' ? { databaseLineage: update.data.databaseLineage } : {}),
      ...(typeof update.data.operationId === 'string' ? { operationId: update.data.operationId } : {}),
      ...(typeof update.data.writerSessionId === 'string' ? { writerSessionId: update.data.writerSessionId } : {}),
      ...(Number.isSafeInteger(update.data.writerEpoch) ? { writerEpoch: update.data.writerEpoch as number } : {}),
      ...(Number.isSafeInteger(update.data.operationStateVersion)
        ? { operationStateVersion: update.data.operationStateVersion as number }
        : {}),
      ...(Number.isSafeInteger(update.data.projectionEpoch)
        ? { projectionEpoch: update.data.projectionEpoch as number }
        : {}),
      ...(Number.isSafeInteger(update.data.attemptNo) ? { attemptNo: update.data.attemptNo as number } : {}),
      ...(typeof update.data.acceptedMessageId === 'string'
        ? { acceptedMessageId: update.data.acceptedMessageId }
        : {}),
      ...(typeof update.data.targetMessageId === 'string' ? { targetMessageId: update.data.targetMessageId } : {}),
    })
  } else if (update.source === 'terminal_sse' && jobId) {
    if (update.data.type === 'done') {
      const outcome = update.data.outcome === 'cancelled' ? 'cancelled' : 'completed'
      forgetActiveGenerationJob(jobId, outcome)
    } else {
      forgetActiveGenerationJob(jobId)
    }
  }
  return true
}

export function applyGenerationOperationProjection(
  operation: GenerationOperationProjection,
  capturedTarget?: ActiveChatTarget,
  source: GenerationOperationReconcilerSource = 'status',
): void {
  reconcileGenerationOperationLifecycle({ kind: 'operation', source, operation, capturedTarget })
}

export function applyGenerationOperationBootstrap(
  runtime: ServerBootstrapRuntime,
  source: GenerationJobProjectionSource = 'bootstrap',
): boolean {
  return reconcileGenerationOperationLifecycle({ kind: 'bootstrap', source, runtime })
}

/** Update a known operation from additive lineage carried by every protocol-v1 SSE frame. */
export function applyGenerationOperationSseEvent(
  data: Record<string, unknown>,
  job?: Pick<ActiveGenerationJob, 'chatId' | 'mode' | 'regenerateMessageId'>,
): void {
  reconcileGenerationOperationLifecycle({
    kind: 'sse',
    source:
      data.type === 'job_accepted'
        ? 'job_accepted'
        : data.type === 'done' || data.type === 'error'
          ? 'terminal_sse'
          : 'sse',
    data,
    ...(job ? { job } : {}),
  })
}

export function reconcileGenerationOperationTranscriptHydration(chatId: string, messages: readonly unknown[]): void {
  reconcileGenerationOperationLifecycle({
    kind: 'transcript_hydration',
    source: 'transcript_hydration',
    chatId,
    messages,
  })
}

function cancellationResponseFromBody(body: unknown):
  | {
      disposition: GenerationOperationCancellationDisposition
      operation: GenerationOperationProjection
      knownAttemptMatched: boolean
    }
  | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const allowed: readonly GenerationOperationCancellationDisposition[] = [
    'cancelled_before_acceptance',
    'cancelling',
    'cancelled',
    'cancelled_finalizing',
    'completion_finalizing',
    'already_cancelled',
    'already_completed',
    'terminal_nonrunning',
  ]
  if (!allowed.includes(record.disposition as GenerationOperationCancellationDisposition)) return undefined
  const operation = operationFromBody(body)
  if (!operation || typeof record.knownAttemptMatched !== 'boolean') return undefined
  return {
    disposition: record.disposition as GenerationOperationCancellationDisposition,
    operation,
    knownAttemptMatched: record.knownAttemptMatched,
  }
}

function cancellationStateForDisposition(
  disposition: GenerationOperationCancellationDisposition,
): GenerationOperationCancellationState {
  if (
    disposition === 'cancelled_before_acceptance' ||
    disposition === 'cancelled' ||
    disposition === 'already_cancelled'
  ) {
    return 'settled_cancelled'
  }
  if (disposition === 'already_completed') return 'settled_completed'
  if (disposition === 'terminal_nonrunning') return 'settled_nonrunning'
  if (disposition === 'cancelled_finalizing') return 'stopped_finalizing'
  return 'stop_waiting'
}

function cancellationDispositionIsTerminal(disposition: GenerationOperationCancellationDisposition): boolean {
  return (
    disposition === 'cancelled_before_acceptance' ||
    disposition === 'cancelled' ||
    disposition === 'already_cancelled' ||
    disposition === 'already_completed' ||
    disposition === 'terminal_nonrunning'
  )
}

function scheduleGenerationOperationCancellationReconcile(operationId: string): void {
  installGenerationOperationCancellationWakeListeners()
  const control = cancellationByOperationId(operationId)
  if (
    !control ||
    (control.state !== 'stop_waiting' && control.state !== 'stopped_finalizing') ||
    cancellationRuntime(operationId).reconcileTimer !== undefined
  ) {
    return
  }
  const runtime = cancellationRuntime(operationId)
  const delay =
    CANCELLATION_RECONCILE_DELAYS_MS[Math.min(runtime.reconcileAttempt, CANCELLATION_RECONCILE_DELAYS_MS.length - 1)]
  runtime.reconcileAttempt += 1
  runtime.reconcileTimer = setTimeout(() => {
    runtime.reconcileTimer = undefined
    void refreshGenerationOperationCancellation(operationId)
  }, delay)
}

function wakeGenerationOperationCancellationReconciliation(): void {
  for (const control of get(generationOperationCancellations)) {
    if (control.state === 'stop_waiting' || control.state === 'stopped_finalizing') {
      clearCancellationReconcileTimer(control.operationId)
      void refreshGenerationOperationCancellation(control.operationId)
    }
  }
}

function installGenerationOperationCancellationWakeListeners(): void {
  if (cancellationWakeListenersInstalled || typeof window === 'undefined' || typeof document === 'undefined') return
  cancellationWakeListenersInstalled = true
  window.addEventListener('online', wakeGenerationOperationCancellationReconciliation)
  window.addEventListener('pageshow', wakeGenerationOperationCancellationReconciliation)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wakeGenerationOperationCancellationReconciliation()
  })
}

function applyCancellationAcknowledgement(
  response: NonNullable<ReturnType<typeof cancellationResponseFromBody>>,
): GenerationOperationCancellationResult {
  applyGenerationOperationProjection(response.operation)
  const state = cancellationStateForDisposition(response.disposition)
  updateGenerationOperationCancellation(response.operation.operationId, (previous) => ({
    operationId: response.operation.operationId,
    target: previous?.target,
    state,
    disposition: response.disposition,
    operationState: response.operation.state,
    stateVersion: response.operation.stateVersion,
    projectionEpoch: response.operation.projectionEpoch,
    ...(response.operation.currentAttempt
      ? {
          attemptNo: response.operation.currentAttempt.attemptNo,
          jobId: response.operation.currentAttempt.jobId,
        }
      : {}),
    knownAttemptMatched: response.knownAttemptMatched,
  }))
  if (
    response.disposition === 'cancelled_before_acceptance' ||
    (response.operation.state === 'cancelled' && response.operation.acceptedRevision === undefined)
  ) {
    const runtime = cancellationRuntimeByOperationId.get(response.operation.operationId)
    runtime?.rollbackOptimisticAppend?.()
    if (runtime) runtime.rollbackOptimisticAppend = undefined
  }
  if (cancellationDispositionIsTerminal(response.disposition)) {
    retireCancellationIntent(response.operation.operationId)
  } else {
    scheduleGenerationOperationCancellationReconcile(response.operation.operationId)
  }
  return {
    status: 'acknowledged',
    disposition: response.disposition,
    operation: response.operation,
    knownAttemptMatched: response.knownAttemptMatched,
  }
}

async function dispatchGenerationOperationCancellation(
  handle: PendingMutationHandle,
  intent: DurableMutationIntent & { kind: 'generation-operation-cancel' },
  access: GenerationOperationAccess,
  sourceGeneration = captureClientSessionGeneration(),
): Promise<GenerationOperationCancellationResult> {
  if (!generationAccessIsCurrent(access, sourceGeneration))
    return { status: 'failed', error: generationNotReadyError() }
  if (!handle.databaseLineage) return { status: 'failed', error: 'The Stop intent has no database lineage.' }
  const persistence = await beginPendingMutationDispatch(handle)
  if (persistence !== 'persisted') return { status: 'failed', error: 'The Stop intent is not durably staged.' }
  const request = intent.requests[0]
  let auth: string
  try {
    auth = await getNodeServerProxyAuth()
  } catch (error) {
    return {
      status: 'failed',
      error:
        error instanceof Error
          ? `Unable to prepare Stop: ${error.message}`
          : `Unable to prepare Stop: ${String(error)}`,
    }
  }
  if (!generationAccessIsCurrent(access, sourceGeneration))
    return { status: 'failed', error: generationNotReadyError() }
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), CANCELLATION_STATUS_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`/api/v1${request.path}`, {
      method: request.method,
      headers: {
        'content-type': 'application/json',
        'risu-auth': auth,
        [SERVER_DATABASE_LINEAGE_HEADER]: handle.databaseLineage,
        ...activeWriterSessionHeader(),
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })
  } catch (error) {
    return {
      status: 'failed',
      error: controller.signal.aborted
        ? 'Stop acknowledgement timed out.'
        : error instanceof Error
          ? `Network error: ${error.message}`
          : `Network error: ${String(error)}`,
    }
  } finally {
    clearTimeout(deadline)
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // A malformed success cannot acknowledge durable cancellation authority.
  }
  if (!response.ok) {
    handleActiveWriterStaleResponse(response, body, sourceGeneration)
    return {
      status: 'failed',
      error: errorMessage(body, response),
      ...(errorCode(body) ? { code: errorCode(body) } : {}),
    }
  }
  const parsed = cancellationResponseFromBody(body)
  if (!parsed) return { status: 'failed', error: 'Invalid generation cancellation response.' }
  if (!generationAccessIsCurrent(access, sourceGeneration)) return { status: 'acknowledged', ...parsed }
  return applyCancellationAcknowledgement(parsed)
}

function cancellationAdvisory(
  operationId: string,
): Pick<GenerationOperationCancellation, 'stateVersion' | 'attemptNo' | 'jobId'> {
  const operation = get(generationOperationProjections).find((candidate) => candidate.operationId === operationId)
  const control = cancellationByOperationId(operationId)
  return {
    stateVersion: operation?.stateVersion ?? control?.stateVersion,
    attemptNo: operation?.currentAttempt?.attemptNo ?? control?.attemptNo,
    jobId: operation?.currentAttempt?.jobId ?? control?.jobId,
  }
}

async function sendGenerationOperationCancellation(
  operationId: string,
  existing?: {
    handle: PendingMutationHandle
    intent: DurableMutationIntent & { kind: 'generation-operation-cancel' }
  },
  access: GenerationOperationAccess = 'ordinary',
): Promise<GenerationOperationCancellationResult> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!canUseGenerationOperationAccess(access)) return { status: 'failed', error: generationNotReadyError() }
  const runtime = cancellationRuntime(operationId)
  if (runtime.inFlight) return runtime.inFlight
  const dispatch = (async (): Promise<GenerationOperationCancellationResult> => {
    let handle = existing?.handle ?? runtime.handle
    let intent = existing?.intent ?? runtime.intent
    if (!handle || !intent) {
      intent = operationIntentForCancellation(operationId, cancellationAdvisory(operationId))
      updateGenerationOperationCancellation(operationId, (previous) => ({
        operationId,
        target: cancellationTargetForOperationId(operationId, previous),
        state: 'stop_staging',
        ...(previous?.operationState ? { operationState: previous.operationState } : {}),
        ...(previous?.stateVersion !== undefined ? { stateVersion: previous.stateVersion } : {}),
        ...(previous?.projectionEpoch !== undefined ? { projectionEpoch: previous.projectionEpoch } : {}),
        ...(previous?.attemptNo !== undefined ? { attemptNo: previous.attemptNo } : {}),
        ...(previous?.jobId ? { jobId: previous.jobId } : {}),
      }))
      let staged: Awaited<PendingMutationHandle['ready']>
      try {
        handle = stagePendingMutation(`generation-operation-cancel:${operationId}`, intent)
        staged = await handle.ready
      } catch (error) {
        if (!generationAccessIsCurrent(access, sourceGeneration))
          return { status: 'failed', error: generationNotReadyError() }
        const failed = {
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        }
        updateGenerationOperationCancellation(operationId, (previous) => ({
          ...(cancellationAuthorityEstablished(previous)
            ? previous!
            : {
                operationId,
                target: previous?.target,
                state: 'stop_failed' as const,
                error: failed.error,
              }),
        }))
        return failed
      }
      if (!generationAccessIsCurrent(access, sourceGeneration))
        return { status: 'failed', error: generationNotReadyError() }
      if (staged !== 'persisted') {
        const failed = { status: 'failed' as const, error: 'The Stop intent could not be staged durably.' }
        updateGenerationOperationCancellation(operationId, (previous) => ({
          ...(cancellationAuthorityEstablished(previous)
            ? previous!
            : {
                operationId,
                target: previous?.target,
                state: 'stop_failed' as const,
                error: failed.error,
              }),
        }))
        return failed
      }
      runtime.handle = handle
      runtime.intent = intent
    }
    if (!generationAccessIsCurrent(access, sourceGeneration))
      return { status: 'failed', error: generationNotReadyError() }
    updateGenerationOperationCancellation(operationId, (previous) => ({
      operationId,
      target: previous?.target,
      state: 'stop_sending',
      ...(previous?.operationState ? { operationState: previous.operationState } : {}),
      ...(previous?.stateVersion !== undefined ? { stateVersion: previous.stateVersion } : {}),
      ...(previous?.projectionEpoch !== undefined ? { projectionEpoch: previous.projectionEpoch } : {}),
      ...(previous?.attemptNo !== undefined ? { attemptNo: previous.attemptNo } : {}),
      ...(previous?.jobId ? { jobId: previous.jobId } : {}),
    }))
    detachGenerationOperationViewers(operationId)
    let result: GenerationOperationCancellationResult
    try {
      result = await dispatchGenerationOperationCancellation(handle, intent, access, sourceGeneration)
    } catch (error) {
      result = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (!generationAccessIsCurrent(access, sourceGeneration)) return result
    if (result.status === 'failed') {
      updateGenerationOperationCancellation(operationId, (previous) =>
        cancellationAuthorityEstablished(previous)
          ? previous!
          : {
              operationId,
              target: previous?.target,
              state: 'stop_failed',
              ...(previous?.disposition ? { disposition: previous.disposition } : {}),
              ...(previous?.operationState ? { operationState: previous.operationState } : {}),
              ...(previous?.stateVersion !== undefined ? { stateVersion: previous.stateVersion } : {}),
              ...(previous?.projectionEpoch !== undefined ? { projectionEpoch: previous.projectionEpoch } : {}),
              ...(previous?.attemptNo !== undefined ? { attemptNo: previous.attemptNo } : {}),
              ...(previous?.jobId ? { jobId: previous.jobId } : {}),
              error: result.error,
              ...(result.code ? { code: result.code } : {}),
            },
      )
    }
    return result
  })()
  runtime.inFlight = dispatch
  return dispatch.finally(() => {
    if (runtime.inFlight === dispatch) runtime.inFlight = undefined
  })
}

export function stopGenerationOperation(operationId: string): Promise<GenerationOperationCancellationResult> {
  return sendGenerationOperationCancellation(operationId)
}

export async function refreshGenerationOperationCancellation(
  operationId: string,
): Promise<GenerationOperationCancellationResult | GenerationOperationDispatchResult> {
  const sourceGeneration = captureClientSessionGeneration()
  clearCancellationReconcileTimer(operationId)
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), CANCELLATION_STATUS_TIMEOUT_MS)
  let status: GenerationOperationDispatchResult
  try {
    status = await readGenerationOperationStatus(operationId, controller.signal)
  } catch (error) {
    status = {
      status: 'retained',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(deadline)
  }
  if (!isClientSessionGenerationCurrent(sourceGeneration)) return status
  if (status.status !== 'accepted') {
    updateGenerationOperationCancellation(operationId, (previous) => ({
      operationId,
      target: previous?.target,
      state: 'stop_failed',
      error: status.error,
      ...(status.code ? { code: status.code } : {}),
    }))
    return status
  }
  const operation = status.response.operation
  if (
    operation.state === 'accepted' ||
    operation.state === 'launching' ||
    operation.state === 'owned_by_job' ||
    operation.state === 'retryable' ||
    operation.state === 'abandoned'
  ) {
    const failed = { status: 'failed' as const, error: 'Stop has not been acknowledged by the server.' }
    updateGenerationOperationCancellation(operationId, (previous) => ({
      operationId,
      target: previous?.target,
      state: 'stop_failed',
      operationState: operation.state,
      stateVersion: operation.stateVersion,
      projectionEpoch: operation.projectionEpoch,
      error: failed.error,
    }))
    return failed
  }
  scheduleGenerationOperationCancellationReconcile(operationId)
  return status
}

function shouldDiscardOperationFailure(code: string | undefined, status: number): boolean {
  return (
    status === 400 ||
    status === 404 ||
    code === 'database_lineage_conflict' ||
    code === 'operation_id_conflict' ||
    code === 'message_id_conflict' ||
    code === 'generation_in_progress' ||
    code === 'generation_finalization_pending' ||
    code === 'operation_intent_missing' ||
    code === 'operation_not_retryable' ||
    code === 'operation_state_conflict' ||
    code === 'operation_target_stale' ||
    code === 'retry_request_id_conflict'
  )
}

interface AcceptedSendEventTarget {
  chatId: string
  messageId: string
  matches: (event: CommandEvent) => boolean
}

function acceptedSendEventTarget(intent: DurableMutationIntent): AcceptedSendEventTarget | null {
  if (intent.kind !== 'generation-operation-submit') return null
  const body = intent.requests[0]?.body
  if (body?.mode !== 'send' || typeof body.chatId !== 'string' || typeof body.acceptedMessageId !== 'string') {
    return null
  }
  const chatId = body.chatId
  const messageId = body.acceptedMessageId
  return {
    chatId,
    messageId,
    matches: (event) =>
      event.type === 'message.appended' &&
      event.resource === 'message' &&
      event.id === messageId &&
      event.parentId === chatId,
  }
}

function acceptedSendResponseEvent(
  response: GenerationOperationResponse,
  target: AcceptedSendEventTarget,
): { status: 'ok'; event?: CommandEvent } | { status: 'invalid' } {
  const append = response.append
  if (!append || append.messageId !== target.messageId) return { status: 'invalid' }
  if (append.disposition === 'not_appended') {
    return append.event === undefined ? { status: 'ok' } : { status: 'invalid' }
  }
  if (
    append.revision === undefined ||
    !append.event ||
    append.event.revision !== append.revision ||
    !target.matches(append.event)
  ) {
    return { status: 'invalid' }
  }
  return { status: 'ok', event: append.event }
}

async function dispatchPendingGenerationOperation(
  handle: PendingMutationHandle,
  intent: DurableMutationIntent,
  access: GenerationOperationAccess = 'ordinary',
  acceptedSendLocalEffect?: MessageMutationLocalEffect,
  sourceGeneration = captureClientSessionGeneration(),
): Promise<GenerationOperationDispatchResult> {
  if (!generationAccessIsCurrent(access, sourceGeneration)) {
    return { status: 'retained', error: generationNotReadyError() }
  }
  if (
    !isGenerationOperationPendingIntent(intent) ||
    intent.kind === 'generation-operation-cancel' ||
    !handle.databaseLineage
  ) {
    return { status: 'rejected', error: 'Invalid generation operation outbox intent.' }
  }
  const persistence = await beginPendingMutationDispatch(handle)
  if (persistence !== 'persisted') {
    return { status: 'retained', error: 'The generation operation is not durably staged.' }
  }

  const request = intent.requests[0]
  const body = cloneJson(request.body)
  const auth = await getNodeServerProxyAuth()
  const acceptedSendTarget = acceptedSendEventTarget(intent)
  const dispatch = async (
    reconcileResponseEvent?: (event: CommandEvent, localEffect?: ServerCommandLocalEffect) => Promise<void>,
  ): Promise<GenerationOperationDispatchResult> => {
    let revisionRetries = 0
    while (true) {
      if (!generationAccessIsCurrent(access, sourceGeneration)) {
        return { status: 'retained', error: generationNotReadyError() }
      }
      let response: Response
      try {
        response = await fetch(`/api/v1${request.path}`, {
          method: request.method,
          headers: {
            'content-type': 'application/json',
            'risu-auth': auth,
            [SERVER_DATABASE_LINEAGE_HEADER]: handle.databaseLineage,
            ...activeWriterSessionHeader(),
          },
          body: JSON.stringify(body),
        })
      } catch (error) {
        return {
          status: 'retained',
          error: error instanceof Error ? `Network error: ${error.message}` : `Network error: ${String(error)}`,
        }
      }

      let responseBody: unknown = null
      try {
        responseBody = await response.json()
      } catch {
        // Non-JSON success is retained because the server may already have accepted it.
      }
      if (response.ok) {
        const parsed = responseFromBody(responseBody)
        if (!parsed) return { status: 'retained', error: 'Invalid generation operation response.' }
        const appendReconciliation = acceptedSendTarget
          ? acceptedSendResponseEvent(parsed, acceptedSendTarget)
          : { status: 'ok' as const }
        if (appendReconciliation.status === 'invalid') {
          return { status: 'retained', error: 'Invalid accepted-send append response.' }
        }
        await discardPendingMutation(handle)
        if (!generationAccessIsCurrent(access, sourceGeneration))
          return { status: 'accepted', response: parsed, stream: generationOperationStreamDescriptor(parsed) }
        if (parsed.append?.revision !== undefined) setCachedServerCommandRevision(parsed.append.revision)
        applyGenerationOperationProjection(parsed.operation)
        if (appendReconciliation.event && reconcileResponseEvent) {
          await reconcileResponseEvent(appendReconciliation.event, acceptedSendLocalEffect)
        }
        return { status: 'accepted', response: parsed, stream: generationOperationStreamDescriptor(parsed) }
      }

      handleActiveWriterStaleResponse(response, responseBody, sourceGeneration)
      const code = errorCode(responseBody)
      if (!generationAccessIsCurrent(access, sourceGeneration))
        return { status: 'retained', error: errorMessage(responseBody, response), ...(code ? { code } : {}) }
      if (
        intent.kind === 'generation-operation-submit' &&
        response.status === 409 &&
        code === 'revision_conflict' &&
        responseBody &&
        typeof responseBody === 'object' &&
        Number.isSafeInteger((responseBody as Record<string, unknown>).currentRevision) &&
        revisionRetries < MAX_REVISION_RETRIES
      ) {
        body.baseRevision = (responseBody as Record<string, unknown>).currentRevision
        setCachedServerCommandRevision(body.baseRevision as number)
        revisionRetries += 1
        continue
      }

      const operation = operationFromBody(responseBody)
      if (operation) applyGenerationOperationProjection(operation)
      const error = errorMessage(responseBody, response)
      if (shouldDiscardOperationFailure(code, response.status)) {
        await discardPendingMutation(handle)
        return { status: 'rejected', error, ...(code ? { code } : {}), ...(operation ? { operation } : {}) }
      }
      return { status: 'retained', error, ...(code ? { code } : {}) }
    }
  }

  return acceptedSendTarget
    ? withDirectServerCommandEventReconciliation(acceptedSendTarget.matches, dispatch)
    : dispatch()
}

export async function submitStagedAcceptedSendOperation(
  staged: StagedAcceptedSendOperation,
): Promise<GenerationOperationDispatchResult> {
  const sourceGeneration = stagedOperationGenerations.get(staged.handle) ?? captureClientSessionGeneration()
  const result = await dispatchPendingGenerationOperation(
    staged.handle,
    staged.intent,
    'ordinary',
    {
      kind: 'messageMutation',
      operation: 'append',
      chatId: staged.request.chatId,
      messageId: staged.request.acceptedMessageId,
      chatBodyProjectionEpoch: staged.optimisticChatBodyProjectionEpoch,
    },
    sourceGeneration,
  )
  if (!generationAccessIsCurrent('ordinary', sourceGeneration)) return result
  if (result.status === 'accepted') {
    if (result.response.append?.disposition !== 'accepted') staged.rollbackOptimisticAppend()
  } else if (result.status === 'rejected') {
    staged.rollbackOptimisticAppend()
    updateGenerationOperationCancellation(staged.request.operationId, () => null)
    cancellationRuntimeByOperationId.delete(staged.request.operationId)
  }
  return result
}

export async function submitStagedTargetedGenerationOperation(
  staged: StagedTargetedGenerationOperation,
): Promise<GenerationOperationDispatchResult> {
  const sourceGeneration = stagedOperationGenerations.get(staged.handle) ?? captureClientSessionGeneration()
  const result = await dispatchPendingGenerationOperation(
    staged.handle,
    staged.intent,
    'ordinary',
    undefined,
    sourceGeneration,
  )
  if (!generationAccessIsCurrent('ordinary', sourceGeneration)) return result
  if (result.status === 'rejected') {
    updateGenerationOperationCancellation(staged.request.operationId, () => null)
    cancellationRuntimeByOperationId.delete(staged.request.operationId)
  }
  return result
}

export async function readGenerationOperationStatus(
  operationId: string,
  signal?: AbortSignal,
): Promise<GenerationOperationDispatchResult> {
  const sourceGeneration = captureClientSessionGeneration()
  const auth = await getNodeServerProxyAuth()
  let response: Response
  try {
    response = await fetch(`${GENERATION_OPERATIONS_ENDPOINT}/${encodeURIComponent(operationId)}`, {
      headers: { 'risu-auth': auth },
      signal,
    })
  } catch (error) {
    return { status: 'retained', error: error instanceof Error ? error.message : String(error) }
  }
  const requestUid = response.headers.get('X-Request-UID') || undefined
  let body: unknown = null
  try {
    body = await response.json()
  } catch {}
  if (!response.ok) {
    recordGenerationRecoveryEvent({
      trigger: 'operation_status',
      recoveryEpoch: 0,
      disposition: errorCode(body) ?? `http_${response.status}`,
      operationId,
      requestUid,
    })
    return {
      status: 'rejected',
      error: errorMessage(body, response),
      ...(errorCode(body) ? { code: errorCode(body) } : {}),
    }
  }
  const parsed = responseFromBody(body)
  if (!parsed) return { status: 'retained', error: 'Invalid generation operation status response.' }
  if (isClientSessionGenerationCurrent(sourceGeneration)) applyGenerationOperationProjection(parsed.operation)
  return { status: 'accepted', response: parsed, stream: generationOperationStreamDescriptor(parsed) }
}

export async function retryGenerationOperation(
  operationId: string,
  expectedStateVersion: number,
): Promise<GenerationOperationDispatchResult> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!canUseGenerationOperationAccess('ordinary')) {
    return { status: 'retained', error: generationNotReadyError() }
  }
  const retryRequestId = createProtocolUuid()
  const intent = operationIntentForRetry(operationId, retryRequestId, expectedStateVersion)
  const handle = stagePendingMutation(`generation-operation-retry:${operationId}`, intent)
  const persistence = await handle.ready
  if (persistence !== 'persisted') {
    return { status: 'retained', error: 'The generation retry could not be staged durably.' }
  }
  return dispatchPendingGenerationOperation(handle, intent, 'ordinary', undefined, sourceGeneration)
}

export async function dispatchGenerationOperationPendingReplay(
  handle: PendingMutationHandle,
  intent: DurableMutationIntent,
): Promise<GenerationOperationPendingReplayOutcome> {
  if (!canUseGenerationOperationAccess('pending-replay'))
    return { disposition: 'retained', result: { status: 'retained', error: generationNotReadyError() } }
  if (intent.kind === 'generation-operation-cancel') {
    const cancellationIntent = intent as DurableMutationIntent & { kind: 'generation-operation-cancel' }
    const operationId = (() => {
      const match = /^\/generation-operations\/([^/?#]+)\/cancellation$/.exec(intent.requests[0]?.path ?? '')
      if (!match) return undefined
      try {
        return decodeURIComponent(match[1]!)
      } catch {
        return match[1]
      }
    })()
    if (!operationId) {
      await discardPendingMutation(handle)
      return {
        disposition: 'discarded',
        result: { status: 'failed', error: 'Invalid generation cancellation outbox intent.' },
      }
    }
    const runtime = cancellationRuntime(operationId)
    runtime.handle = handle
    runtime.intent = cancellationIntent
    updateGenerationOperationCancellation(operationId, (previous) => ({
      operationId,
      target: previous?.target,
      state: 'stop_sending',
      ...(previous?.operationState ? { operationState: previous.operationState } : {}),
      ...(previous?.stateVersion !== undefined ? { stateVersion: previous.stateVersion } : {}),
      ...(previous?.projectionEpoch !== undefined ? { projectionEpoch: previous.projectionEpoch } : {}),
      ...(previous?.attemptNo !== undefined ? { attemptNo: previous.attemptNo } : {}),
      ...(previous?.jobId ? { jobId: previous.jobId } : {}),
    }))
    const result = await sendGenerationOperationCancellation(
      operationId,
      { handle, intent: cancellationIntent },
      'pending-replay',
    )
    if (result.status === 'failed') return { disposition: 'retained', result }
    return {
      disposition: cancellationDispositionIsTerminal(result.disposition) ? 'succeeded' : 'retained',
      result,
    }
  }
  const result = await dispatchPendingGenerationOperation(handle, intent, 'pending-replay')
  if (result.status === 'accepted') return { disposition: 'succeeded', result }
  if (result.status === 'rejected') return { disposition: 'discarded', result }
  return { disposition: 'retained', result }
}

registerGenerationOperationsRuntime({
  applyGenerationOperationBootstrap,
  generationOperationProjections,
  generationOperationStreamForActiveJob,
  isProtocolGenerationOperationJob,
  readGenerationOperationStatus,
  retireGenerationOperationViewers,
  retryGenerationOperation,
  stopGenerationOperation,
})
