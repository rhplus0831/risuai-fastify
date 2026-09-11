import { captureClientSessionGeneration, registerClientWriterLossHandler } from '../clientSession'
import { assertClientWriteOperation, isClientWriteOperationCurrent } from '../clientWriteOperation'
import { get } from 'svelte/store'
import type { ActiveChatTarget, AppendCurrentChatUserMessageResult, ChatMutationFinalOutcome } from '../chatCommands'
import { waitForPendingChatGenerationSettingsSave } from '../chatCommands'
import {
  guardActiveChatGenerationSettingsForSend,
  resolveActiveChatGenerationSettings,
} from '../activeChatGenerationSettings'
import { reconcileAcceptedSendCompletion } from '../server/chatMessageHydration.svelte'
import { sleep } from '../util'
import { clearActiveGenerationAbortController, createActiveGenerationAbortController, sendChat } from './index.svelte'
import { chatGenerationTargetKey } from './generationActivity.svelte'
import type { Message } from '../storage/database.svelte'
import { flushPendingSelectedPersonaUpdate } from '../persona'
import { alertConfirm, alertError } from '../alert'
import { language } from '../../lang'
import { collectServerInlayAssetRefs } from './serverBackedSendChat'
import { readBrowserClientContext } from './request/clientContext'
import { SERVER_CHAT_CLIENT_CAPABILITIES } from './request/serverChat'
import {
  readGenerationOperationStatus,
  retryGenerationOperation,
  stageAcceptedSendGenerationOperation,
  stopGenerationOperation,
  submitStagedAcceptedSendOperation,
  type GenerationOperationStreamDescriptor,
} from '../server/generationOperations'
import {
  acceptedSendRecoveries,
  recordAcceptedSendRecovery,
  removeAcceptedSendRecovery,
  resetAcceptedSendRecoveryStateForTests,
  setAcceptedSendRecoveryRetrying,
  type AcceptedSendRecovery,
  type AcceptedSendRecoveryCause,
} from './acceptedSendRecoveryState'
import { refreshActiveGenerationJobsFromBootstrap } from './reattach'
import { reconcileAcceptedSendGenerationEffects } from './recoveredGenerationEffects'
import { waitForPendingCharacterScriptDefinitionSave } from '../server/scriptDefinitionOwner.svelte'

export {
  acceptedSendRecoveries,
  type AcceptedSendRecovery,
  type AcceptedSendRecoveryCause,
} from './acceptedSendRecoveryState'

type AcceptedAppendResult = Exclude<AppendCurrentChatUserMessageResult, { status: 'error' }>

export type AcceptedSendCoordinatorResult =
  | { status: 'generated' }
  | { status: 'generated'; operationId: string; acceptedMessageId: string }
  | { status: 'append_failed' }
  | { status: 'generation_failed'; cause: AcceptedSendRecoveryCause; acceptedMessageId?: string }

export type AcceptedSendFailureReason =
  | 'chatGenerationSettings'
  | 'personaSettings'
  | 'characterDefinitions'
  | 'activeChatMissing'
  | 'preparation'
  | 'staging'
  | 'queuedConfirmation'
  | 'queuedConflict'
  | 'queuedServerUnavailable'
  | 'appendNotAccepted'

export type AcceptedSendAppendFailure =
  | { kind: 'known'; reason: AcceptedSendFailureReason; outcome?: ChatMutationFinalOutcome }
  | { kind: 'message'; message: string; outcome?: ChatMutationFinalOutcome }

export interface CoordinateAcceptedChatSendInput {
  /** Original caller operation; an awaited append must not adopt a later writer session. */
  clientGeneration?: number
  target: ActiveChatTarget
  /** Compatibility append, used only when protocol v1 was not advertised. */
  append?: AcceptedAppendResult
  /** Protocol-v1 send payload; the coordinator creates both UUIDs before staging. */
  message?: string | Message
  draftGeneration?: unknown
  syntheticSayNothing?: boolean
  onAppendAccepted?: () => void
  onAppendFailed?: (failure: AcceptedSendAppendFailure) => void
}

interface AcceptedGenerationRequest {
  id: string
  operationId?: string
  target: ActiveChatTarget
  messageId: string
  resultMessageId?: string
  syntheticSayNothing: boolean
}

interface CoordinatedOperation {
  promise: Promise<AcceptedSendCoordinatorResult>
  settled: boolean
  sourceGeneration: number
}

const MAX_REMEMBERED_OPERATIONS = 256
export const ACCEPTED_SEND_AUTHORITY_PROBE_TIMEOUT_MS = 10_000
const coordinatedOperations = new Map<string, CoordinatedOperation>()
const activeRetries = new Map<string, number>()
const supersededSend = (acceptedMessageId?: string): AcceptedSendCoordinatorResult => ({
  status: 'generation_failed',
  cause: 'generation_failed',
  ...(acceptedMessageId ? { acceptedMessageId } : {}),
})

function beginRecoveryRetry(id: string, sourceGeneration: number): () => void {
  activeRetries.set(id, sourceGeneration)
  setRecoveryRetrying(id, true)
  const stopWatchingLoss = registerClientWriterLossHandler(() => {
    if (activeRetries.get(id) !== sourceGeneration) return
    activeRetries.delete(id)
    setRecoveryRetrying(id, false)
  })
  return () => {
    stopWatchingLoss()
    if (activeRetries.get(id) !== sourceGeneration) return
    activeRetries.delete(id)
    if (isClientWriteOperationCurrent(sourceGeneration)) setRecoveryRetrying(id, false)
  }
}

function acceptedSendOperationId(target: ActiveChatTarget, messageId: string): string {
  return `${chatGenerationTargetKey(target) ?? 'missing-target'}:message:${messageId}`
}

function trimRememberedOperations(): void {
  while (coordinatedOperations.size > MAX_REMEMBERED_OPERATIONS) {
    const oldestId = [...coordinatedOperations].find(([, operation]) => operation.settled)?.[0]
    if (oldestId === undefined) return
    coordinatedOperations.delete(oldestId)
  }
}

function rememberOperation(
  id: string,
  promise: Promise<AcceptedSendCoordinatorResult>,
  sourceGeneration: number,
): void {
  const operation: CoordinatedOperation = { promise, settled: false, sourceGeneration }
  coordinatedOperations.set(id, operation)
  void promise.then(
    () => {
      operation.settled = true
      trimRememberedOperations()
    },
    () => {
      operation.settled = true
      trimRememberedOperations()
    },
  )
  trimRememberedOperations()
}

function recordRecovery(request: AcceptedGenerationRequest, cause: AcceptedSendRecoveryCause, retrying = false): void {
  recordAcceptedSendRecovery(request, cause, retrying)
}

function setRecoveryRetrying(id: string, retrying: boolean): void {
  setAcceptedSendRecoveryRetrying(id, retrying)
}

function notifyAppendAccepted(callback: (() => void) | undefined): void {
  try {
    callback?.()
  } catch (error) {
    console.error(error)
  }
}

function notifyAppendFailed(
  callback: ((failure: AcceptedSendAppendFailure) => void) | undefined,
  failure: AcceptedSendAppendFailure,
): void {
  try {
    callback?.(failure)
  } catch (error) {
    console.error(error)
  }
}

function failureFromError(error: unknown, fallback: AcceptedSendFailureReason): AcceptedSendAppendFailure {
  if (error instanceof Error && error.message) return { kind: 'message', message: error.message }
  if (typeof error === 'string' && error) return { kind: 'message', message: error }
  return { kind: 'known', reason: fallback }
}

function queuedAppendFailure(
  outcome: Extract<ChatMutationFinalOutcome, { status: 'failed' }>,
): AcceptedSendAppendFailure {
  if (outcome.result.status === 'error') {
    return { kind: 'message', message: outcome.result.error, outcome }
  }
  if (outcome.result.status === 'conflict') {
    return { kind: 'known', reason: 'queuedConflict', outcome }
  }
  return { kind: 'known', reason: 'queuedServerUnavailable', outcome }
}

interface AcceptedGenerationAttempt {
  generated: boolean
  cause: AcceptedSendRecoveryCause
}

async function attemptGeneration(
  request: AcceptedGenerationRequest,
  delayBeforeStart: boolean,
  sourceGeneration: number,
): Promise<AcceptedGenerationAttempt> {
  if (!isClientWriteOperationCurrent(sourceGeneration)) return { generated: false, cause: 'generation_failed' }
  if (delayBeforeStart) await sleep(10)
  if (!isClientWriteOperationCurrent(sourceGeneration)) return { generated: false, cause: 'generation_failed' }

  const abortController = createActiveGenerationAbortController()
  let cause: AcceptedSendRecoveryCause = 'generation_failed'
  try {
    const generated = await sendChat(-1, {
      signal: abortController.signal,
      expectedTarget: request.target,
      syntheticSayNothing: request.syntheticSayNothing,
      onFailure: (failure) => {
        cause = failure.cause
      },
    })
    return { generated: isClientWriteOperationCurrent(sourceGeneration) && generated, cause }
  } catch (error) {
    if (isClientWriteOperationCurrent(sourceGeneration)) console.error(error)
    return { generated: false, cause }
  } finally {
    clearActiveGenerationAbortController(abortController)
  }
}

/**
 * A mobile browser can lose its viewer stream while the detached server job
 * continues. Before calling that a generation failure, ask the server whether
 * the accepted row already has its durable assistant reply. Chat-level job
 * activity is not proof that the job belongs to this accepted message.
 */
type AcceptedGenerationAuthorityOutcome = 'reconciled' | 'not_reconciled' | 'authority_unknown'

async function settleBeforeAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ status: 'settled'; value: T } | { status: 'aborted' }> {
  if (signal.aborted) return { status: 'aborted' }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      resolve({ status: 'aborted' })
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve({ status: 'settled', value })
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function acceptedGenerationReachedServer(
  request: AcceptedGenerationRequest,
  sourceGeneration: number,
): Promise<AcceptedGenerationAuthorityOutcome> {
  if (!isClientWriteOperationCurrent(sourceGeneration)) return 'authority_unknown'
  if (!request.target.chatId) return 'not_reconciled'

  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), ACCEPTED_SEND_AUTHORITY_PROBE_TIMEOUT_MS)
  try {
    const bootstrap = await settleBeforeAbort(
      refreshActiveGenerationJobsFromBootstrap(controller.signal),
      controller.signal,
    )
    if (!isClientWriteOperationCurrent(sourceGeneration) || bootstrap.status === 'aborted' || controller.signal.aborted)
      return 'authority_unknown'

    const completion = await settleBeforeAbort(
      reconcileAcceptedSendCompletion(request.target, request.messageId, {
        signal: controller.signal,
        ...(request.operationId ? { operationId: request.operationId } : {}),
        ...(request.resultMessageId ? { resultMessageId: request.resultMessageId } : {}),
      }),
      controller.signal,
    )
    if (
      !isClientWriteOperationCurrent(sourceGeneration) ||
      completion.status === 'aborted' ||
      controller.signal.aborted
    )
      return 'authority_unknown'
    if (completion.value.status !== 'reconciled') return 'not_reconciled'
    const effects = await settleBeforeAbort(
      reconcileAcceptedSendGenerationEffects(request.target, request.messageId),
      controller.signal,
    )
    if (!isClientWriteOperationCurrent(sourceGeneration) || effects.status === 'aborted' || controller.signal.aborted)
      return 'authority_unknown'
    return effects.value.durableEffectsReconciled ? 'reconciled' : 'not_reconciled'
  } catch {
    return !isClientWriteOperationCurrent(sourceGeneration) || controller.signal.aborted
      ? 'authority_unknown'
      : 'not_reconciled'
  } finally {
    clearTimeout(deadline)
  }
}

async function startAcceptedGeneration(
  request: AcceptedGenerationRequest,
  sourceGeneration: number,
): Promise<AcceptedSendCoordinatorResult> {
  if (!isClientWriteOperationCurrent(sourceGeneration)) return supersededSend(request.messageId)
  removeAcceptedSendRecovery(request.id)
  const attempt = await attemptGeneration(request, true, sourceGeneration)
  if (!isClientWriteOperationCurrent(sourceGeneration)) return supersededSend(request.messageId)
  if (attempt.generated) {
    return { status: 'generated' }
  }

  const completion = await acceptedGenerationReachedServer(request, sourceGeneration)
  if (!isClientWriteOperationCurrent(sourceGeneration)) return supersededSend(request.messageId)
  if (completion === 'reconciled') {
    return { status: 'generated' }
  }

  if (!isClientWriteOperationCurrent(sourceGeneration)) return supersededSend(request.messageId)
  recordRecovery(request, attempt.cause)
  return { status: 'generation_failed', cause: attempt.cause }
}

async function prepareAtomicSendGenerationIntent(input: CoordinateAcceptedChatSendInput, sourceGeneration: number) {
  assertClientWriteOperation(sourceGeneration)
  const readiness = guardActiveChatGenerationSettingsForSend(
    resolveActiveChatGenerationSettings({ target: input.target }),
  )
  if (readiness.status === 'error') {
    return { status: 'error' as const, failure: { kind: 'message' as const, message: readiness.error } }
  }
  if (input.target.chatId) {
    const settings = await waitForPendingChatGenerationSettingsSave(input.target.chatId)
    assertClientWriteOperation(sourceGeneration)
    if (settings && settings.status !== 'ok') {
      return {
        status: 'error' as const,
        failure: { kind: 'known' as const, reason: 'chatGenerationSettings' as const },
      }
    }
  }
  const persona = await flushPendingSelectedPersonaUpdate()
  assertClientWriteOperation(sourceGeneration)
  if (persona && persona.status !== 'ok') {
    return { status: 'error' as const, failure: { kind: 'known' as const, reason: 'personaSettings' as const } }
  }
  const scripts = await waitForPendingCharacterScriptDefinitionSave(input.target.characterId)
  assertClientWriteOperation(sourceGeneration)
  if (scripts === 'queued' || scripts === 'failed') {
    return { status: 'error' as const, failure: { kind: 'known' as const, reason: 'characterDefinitions' as const } }
  }
  // The waits above may hydrate or replace owner projections. Re-resolve the
  // exact generation target so staging uses one fresh, coherent owner snapshot.
  const finalReadiness = guardActiveChatGenerationSettingsForSend(
    resolveActiveChatGenerationSettings({ target: input.target }),
  )
  if (finalReadiness.status === 'error') {
    return { status: 'error' as const, failure: { kind: 'message' as const, message: finalReadiness.error } }
  }
  const chat = finalReadiness.state.chat
  if (!chat) {
    return { status: 'error' as const, failure: { kind: 'known' as const, reason: 'activeChatMissing' as const } }
  }
  const inlayAssetRefs = await collectServerInlayAssetRefs(chat)
  assertClientWriteOperation(sourceGeneration)
  return {
    status: 'ok' as const,
    generation: {
      syntheticSayNothing: input.syntheticSayNothing === true,
      resetMessages: false,
      inlayAssetRefs,
      clientContext: readBrowserClientContext(),
      clientCapabilities: { ...SERVER_CHAT_CLIENT_CAPABILITIES },
    },
  }
}

async function observeAcceptedOperationStream(
  target: ActiveChatTarget,
  stream: GenerationOperationStreamDescriptor,
  sourceGeneration: number,
): Promise<boolean> {
  if (!isClientWriteOperationCurrent(sourceGeneration)) return false
  const controller = createActiveGenerationAbortController()
  try {
    return await sendChat(-1, {
      signal: controller.signal,
      expectedTarget: target,
      generationOperationStream: stream,
    })
  } finally {
    clearActiveGenerationAbortController(controller)
  }
}

async function coordinateAtomicAcceptedChatSend(
  input: CoordinateAcceptedChatSendInput & { message: string | Message },
  sourceGeneration: number,
): Promise<AcceptedSendCoordinatorResult> {
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return { status: 'append_failed' }
  let preparedIntent: Awaited<ReturnType<typeof prepareAtomicSendGenerationIntent>>
  try {
    preparedIntent = await prepareAtomicSendGenerationIntent(input, sourceGeneration)
  } catch (error) {
    if (!isCurrent()) return supersededSend()
    console.error(error)
    notifyAppendFailed(input.onAppendFailed, failureFromError(error, 'preparation'))
    return { status: 'append_failed' }
  }
  if (!isCurrent()) return supersededSend()
  if (preparedIntent.status === 'error') {
    notifyAppendFailed(input.onAppendFailed, preparedIntent.failure)
    return { status: 'append_failed' }
  }
  let staged: Awaited<ReturnType<typeof stageAcceptedSendGenerationOperation>>
  try {
    staged = await stageAcceptedSendGenerationOperation({
      target: input.target,
      message: input.message,
      draftGeneration: input.draftGeneration,
      generation: preparedIntent.generation,
    })
  } catch (error) {
    if (!isCurrent()) return supersededSend()
    console.error(error)
    notifyAppendFailed(input.onAppendFailed, failureFromError(error, 'staging'))
    return { status: 'append_failed' }
  }
  if (!isCurrent()) return supersededSend()
  if ('status' in staged) {
    notifyAppendFailed(input.onAppendFailed, { kind: 'message', message: staged.error })
    return { status: 'append_failed' }
  }

  let submitted: Awaited<ReturnType<typeof submitStagedAcceptedSendOperation>>
  try {
    submitted = await submitStagedAcceptedSendOperation(staged)
  } catch (error) {
    if (!isCurrent()) return supersededSend()
    console.error(error)
    return { status: 'generation_failed', cause: 'generation_failed' }
  }
  if (!isCurrent())
    return supersededSend(
      submitted.status === 'accepted' && submitted.response.append?.disposition === 'accepted'
        ? (submitted.response.operation.acceptedMessageId ?? staged.request.acceptedMessageId)
        : undefined,
    )
  if (submitted.status === 'retained') {
    // The complete intent and optimistic row remain durable. Bootstrap/outbox
    // replay will project the eventual acceptance without appending again.
    return { status: 'generation_failed', cause: 'generation_failed' }
  }
  if (submitted.status === 'rejected' && submitted.code === 'generation_finalization_pending') {
    alertError(language.errors.replyStillSaving)
    return { status: 'append_failed' }
  }
  if (submitted.status !== 'accepted' || submitted.response.append?.disposition !== 'accepted') {
    notifyAppendFailed(
      input.onAppendFailed,
      submitted.status === 'rejected'
        ? { kind: 'message', message: submitted.error }
        : { kind: 'known', reason: 'appendNotAccepted' },
    )
    return { status: 'append_failed' }
  }
  notifyAppendAccepted(input.onAppendAccepted)

  const operationId = submitted.response.operation.operationId
  const acceptedMessageId = submitted.response.operation.acceptedMessageId ?? staged.request.acceptedMessageId
  let stream = submitted.stream
  if (
    !stream &&
    (submitted.response.operation.state === 'accepted' || submitted.response.operation.state === 'launching')
  ) {
    if (!isCurrent()) return supersededSend()
    const status = await readGenerationOperationStatus(operationId)
    if (!isCurrent()) return supersededSend()
    if (status.status === 'accepted') stream = status.stream
  }
  if (stream) await observeAcceptedOperationStream(input.target, stream, sourceGeneration)
  if (!isCurrent()) return supersededSend()

  const status = await readGenerationOperationStatus(operationId)
  if (!isCurrent()) return supersededSend()
  if (status.status === 'accepted' && status.response.operation.state === 'completed') {
    const completion = await acceptedGenerationReachedServer(
      {
        id: operationId,
        operationId,
        target: input.target,
        messageId: acceptedMessageId,
        resultMessageId: status.response.operation.resultMessageId,
        syntheticSayNothing: input.syntheticSayNothing === true,
      },
      sourceGeneration,
    )
    if (!isCurrent()) return supersededSend()
    if (completion === 'reconciled') return { status: 'generated', operationId, acceptedMessageId }
  }
  return { status: 'generation_failed', cause: 'generation_failed' }
}

/**
 * Own a user-message append after dispatch. An immediately accepted append is
 * handed to generation now; a retained append stays here until its durable
 * settlement is accepted. In either case, this module starts generation once
 * for the captured target and never re-appends the user message.
 */
export function coordinateAcceptedChatSend(
  input: CoordinateAcceptedChatSendInput,
): Promise<AcceptedSendCoordinatorResult> {
  const sourceGeneration = input.clientGeneration ?? captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (input.message !== undefined) {
    if (!isCurrent()) return Promise.resolve({ status: 'append_failed' })
    return coordinateAtomicAcceptedChatSend(
      input as CoordinateAcceptedChatSendInput & { message: string | Message },
      sourceGeneration,
    )
  }
  if (!input.append) return Promise.resolve({ status: 'append_failed' })
  const id = acceptedSendOperationId(input.target, input.append.messageId)
  const existing = coordinatedOperations.get(id)
  if (existing)
    return existing.sourceGeneration === sourceGeneration
      ? existing.promise
      : existing.promise.then((settled) =>
          settled.status === 'append_failed' ? settled : supersededSend(input.append!.messageId),
        )

  const request: AcceptedGenerationRequest = {
    id,
    target: input.target,
    messageId: input.append.messageId,
    syntheticSayNothing: input.syntheticSayNothing === true,
  }
  const operation = (async (): Promise<AcceptedSendCoordinatorResult> => {
    if (input.append.status === 'queued') {
      let settlement: ChatMutationFinalOutcome
      try {
        settlement = await input.append.settlement
      } catch (error) {
        if (!isCurrent()) return supersededSend()
        notifyAppendFailed(input.onAppendFailed, failureFromError(error, 'queuedConfirmation'))
        return { status: 'append_failed' }
      }
      if (settlement.status !== 'accepted') {
        if (isCurrent()) notifyAppendFailed(input.onAppendFailed, queuedAppendFailure(settlement))
        return { status: 'append_failed' }
      }
    }

    if (!isCurrent()) return supersededSend(request.messageId)
    notifyAppendAccepted(input.onAppendAccepted)
    return startAcceptedGeneration(request, sourceGeneration)
  })()

  rememberOperation(id, operation, sourceGeneration)
  return operation
}

export function findAcceptedSendRecovery(
  recoveries: readonly AcceptedSendRecovery[],
  target: ActiveChatTarget | null | undefined,
): AcceptedSendRecovery | undefined {
  const targetKey = chatGenerationTargetKey(target)
  if (!targetKey) return undefined
  return recoveries.find(
    (recovery) => recovery.phase === 'retryable' && chatGenerationTargetKey(recovery.target) === targetKey,
  )
}

export function findAcceptedSendRecoveries(
  recoveries: readonly AcceptedSendRecovery[],
  target: ActiveChatTarget | null | undefined,
): AcceptedSendRecovery[] {
  const targetKey = chatGenerationTargetKey(target)
  if (!targetKey) return []
  return recoveries.filter(
    (recovery) => recovery.phase === 'retryable' && chatGenerationTargetKey(recovery.target) === targetKey,
  )
}

export async function retryAcceptedChatSend(id: string): Promise<boolean> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return false
  const recovery = get(acceptedSendRecoveries).find((candidate) => candidate.id === id)
  if (!recovery || recovery.retrying) return false

  if (recovery.operationId) {
    if (recovery.phase !== 'retryable' || recovery.stateVersion === undefined) return false
    if (recovery.providerMayHaveRun && !(await alertConfirm(language.acceptedSendRecovery.providerMayHaveRunConfirm))) {
      return false
    }
    if (!isCurrent()) return false
    const finishRetry = beginRecoveryRetry(id, sourceGeneration)
    try {
      const retried = await retryGenerationOperation(recovery.operationId, recovery.stateVersion)
      if (!isCurrent()) return false
      if (retried.status !== 'accepted') return false
      if (retried.stream) await observeAcceptedOperationStream(recovery.target, retried.stream, sourceGeneration)
      if (!isCurrent()) return false
      const status = await readGenerationOperationStatus(recovery.operationId)
      if (!isCurrent()) return false
      if (status.status !== 'accepted' || status.response.operation.state !== 'completed') return false
      const completion = await acceptedGenerationReachedServer(
        {
          id: recovery.operationId,
          operationId: recovery.operationId,
          target: recovery.target,
          messageId: recovery.messageId,
          resultMessageId: status.response.operation.resultMessageId,
          syntheticSayNothing: recovery.syntheticSayNothing,
        },
        sourceGeneration,
      )
      return isCurrent() && completion === 'reconciled'
    } finally {
      finishRetry()
    }
  }

  const finishRetry = beginRecoveryRetry(id, sourceGeneration)
  const request: AcceptedGenerationRequest = {
    id: recovery.id,
    target: recovery.target,
    messageId: recovery.messageId,
    syntheticSayNothing: recovery.syntheticSayNothing,
  }
  try {
    const attempt = await attemptGeneration(request, false, sourceGeneration)
    if (!isCurrent()) return false
    if (attempt.generated) {
      removeAcceptedSendRecovery(id)
      return true
    }

    // Preserve the warning while authority is checked. The shared deadline can
    // classify a timeout only as unknown, never as generation success/failure.
    recordRecovery(request, attempt.cause, true)
    if ((await acceptedGenerationReachedServer(request, sourceGeneration)) === 'reconciled') {
      if (!isCurrent()) return false
      removeAcceptedSendRecovery(id)
      return true
    }
    return false
  } finally {
    finishRetry()
  }
}

/** Permanently dismiss an abandoned accepted-send retry through server authority. */
export async function dismissAbandonedAcceptedChatSend(id: string): Promise<boolean> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return false
  const recovery = get(acceptedSendRecoveries).find((candidate) => candidate.id === id)
  if (!recovery || recovery.retrying || recovery.operationState !== 'abandoned' || !recovery.operationId) return false

  const finishDismiss = beginRecoveryRetry(id, sourceGeneration)
  try {
    const result = await stopGenerationOperation(recovery.operationId)
    if (!isCurrent() || result.status !== 'acknowledged') return false
    removeAcceptedSendRecovery(id)
    return true
  } finally {
    finishDismiss()
  }
}

export function resetAcceptedSendCoordinatorForTests(): void {
  coordinatedOperations.clear()
  activeRetries.clear()
  resetAcceptedSendRecoveryStateForTests()
}
