import { pluginsReady } from '../startupReadiness'
import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
  isClientSessionManaged,
  clientSessionStore,
} from '../clientSession'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import type { Message } from '../storage/database.svelte'
import {
  ACTIVE_WRITER_SESSION_HEADER,
  activeWriterSessionHeader,
  handleActiveWriterStaleResponse,
} from '../server/activeWriterSession'
import {
  SERVER_DATABASE_LINEAGE_HEADER,
  peekCachedServerCommandRevision,
  setCachedServerCommandRevision,
  type IgpEffectMessageClaim,
} from '../server/commands'
import {
  clientChatOccupancyStore,
  isClientChatOccupancyAuthorityCurrent,
  type ClientChatOccupancyAuthority,
} from '../server/chatOccupancy'
import type { PendingGenerationEffect } from '../server/bootstrap'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'

export type GenerationEffectKind =
  | 'igp'
  | 'plugin_output'
  | 'notification'
  | 'tts'
  | 'completion_sound'
  | 'emotion_image_state'

export type GenerationEffectDelivery = 'live_terminal' | 'late_recovery'

export type GenerationEffectExecution<T> =
  | { status: 'completed'; value: T }
  | { status: 'skipped'; reason: string; value?: T }

export interface RunGenerationEffectResult<T> {
  executed: boolean
  value?: T
  status: 'completed' | 'skipped' | 'failed' | 'already_receipted' | 'unavailable'
}

export interface RunGenerationEffectOptions {
  /** Ask the server to grant a recent late notification/sound exactly once. */
  recoverRecentCompletionAlert?: boolean
  /** Exact admission authority for an occupancy-scoped accepted operation. */
  chatOccupancyAuthority?: ClientChatOccupancyAuthority
}

export interface GenerationEffectExecutionContext {
  /** Stable across an expired-lease reclaim; callbacks can use it as their idempotency key. */
  idempotencyKey: string
  reclaimed: boolean
  /** Present only for an actual IGP lease; legacy live callbacks have no claim. */
  igpEffect?: IgpEffectMessageClaim
  /** Old claims cannot resume callbacks after writer loss or a later promotion. */
  isCurrent(): boolean
  signal: AbortSignal
}

interface ClaimedEffectResponse {
  status: 'claimed'
  claimId: string
  leaseExpiresAt?: string
  idempotencyKey: string
  reclaimed: boolean
}

interface NotClaimedEffectResponse {
  status: 'not_claimed'
  reason: string
}

const inFlightEffects = new Map<string, Promise<RunGenerationEffectResult<unknown>>>()
const activeGenerationInlayPreparations = new Map<string, string>()

function generationInlayPreparationKey(ref: ServerGenerationEffectLedgerRef): string {
  return JSON.stringify([
    ref.version,
    ref.databaseLineage,
    ref.keyType,
    ref.keyId,
    ref.generationId,
    ref.characterId,
    ref.chatId,
    ref.messageId,
  ])
}

/** Register only the provider currently owned by this live page. The server
 * marker remains authoritative; this local identity prevents a translation
 * event in the same page from misclassifying its own running provider as an
 * abandoned reload obligation. */
export function registerActiveGenerationInlayPreparation(
  ref: ServerGenerationEffectLedgerRef,
  preparationId: string,
): () => void {
  const key = generationInlayPreparationKey(ref)
  activeGenerationInlayPreparations.set(key, preparationId)
  return () => {
    if (activeGenerationInlayPreparations.get(key) === preparationId) activeGenerationInlayPreparations.delete(key)
  }
}

export function isGenerationInlayPreparationActive(
  ref: ServerGenerationEffectLedgerRef,
  preparationId: string,
): boolean {
  return activeGenerationInlayPreparations.get(generationInlayPreparationKey(ref)) === preparationId
}

/** The request can be locally active before its durable marker is visible to
 * bootstrap recovery. Keep that acknowledgement window fenced by the exact
 * operation/message identity rather than by a server-issued marker alone. */
export function hasActiveGenerationInlayPreparation(ref: ServerGenerationEffectLedgerRef): boolean {
  return activeGenerationInlayPreparations.has(generationInlayPreparationKey(ref))
}

export interface GenerationEffectTiming {
  kind: GenerationEffectKind
  delivery: GenerationEffectDelivery
  durationMs: number
  status: 'completed' | 'skipped' | 'failed'
}

let generationEffectTimingObserver: ((timing: GenerationEffectTiming) => void) | null = null

export function setGenerationEffectTimingObserverForTests(
  observer: ((timing: GenerationEffectTiming) => void) | null,
): void {
  generationEffectTimingObserver = observer
}

async function runMeasuredGenerationEffect<T>(
  kind: GenerationEffectKind,
  delivery: GenerationEffectDelivery,
  context: GenerationEffectExecutionContext,
  effect: (
    context: GenerationEffectExecutionContext,
  ) => Promise<GenerationEffectExecution<T>> | GenerationEffectExecution<T>,
): Promise<GenerationEffectExecution<T>> {
  const canMeasure = typeof performance !== 'undefined' && typeof performance.now === 'function'
  const startedAt = canMeasure ? performance.now() : 0
  let status: GenerationEffectTiming['status'] = 'failed'
  try {
    const result = await effect(context)
    status = result.status
    return result
  } finally {
    if (canMeasure) {
      const durationMs = performance.now() - startedAt
      generationEffectTimingObserver?.({ kind, delivery, durationMs, status })
      if (import.meta.env.DEV && typeof performance.measure === 'function') {
        try {
          performance.measure(`risu:generation-effect:${kind}:${delivery}`, {
            start: startedAt,
            duration: durationMs,
            detail: { kind, delivery, status },
          })
        } catch {
          // Performance entry support differs across browsers; timing is diagnostic only.
        }
      }
    }
  }
}

export function completedGenerationEffect<T>(value: T): GenerationEffectExecution<T> {
  return { status: 'completed', value }
}

export function skippedGenerationEffect<T = never>(reason: string, value?: T): GenerationEffectExecution<T> {
  return { status: 'skipped', reason, ...(value === undefined ? {} : { value }) }
}

export function generationEffectRefFromPending(effect: PendingGenerationEffect): ServerGenerationEffectLedgerRef {
  return {
    version: 1,
    databaseLineage: effect.databaseLineage,
    keyType: effect.keyType,
    keyId: effect.keyId,
    generationId: effect.generationId,
    characterId: effect.characterId,
    chatId: effect.chatId,
    messageId: effect.messageId,
  }
}

export function generationEffectRefFromMessage(message: Message): ServerGenerationEffectLedgerRef | undefined {
  const info = message.generationInfo
  const databaseLineage = info?.databaseLineage?.trim()
  const generationId = info?.generationId?.trim()
  const keyType = info?.effectLedgerKeyType
  const keyId = info?.effectLedgerKeyId?.trim()
  const messageId = message.chatId?.trim()
  const characterId = info?.effectLedgerCharacterId?.trim()
  const chatId = info?.effectLedgerChatId?.trim()
  if (
    !databaseLineage ||
    !generationId ||
    !characterId ||
    !chatId ||
    !messageId ||
    (keyType !== 'operation' && keyType !== 'generation') ||
    !keyId
  ) {
    return undefined
  }
  return { version: 1, databaseLineage, keyType, keyId, generationId, characterId, chatId, messageId }
}

function effectAccessIsCurrent(
  generation: number,
  ref?: ServerGenerationEffectLedgerRef,
  authority?: ClientChatOccupancyAuthority,
): boolean {
  if (!isClientSessionGenerationCurrent(generation)) return false
  if (authority) {
    return (
      ref !== undefined &&
      authority.sessionGeneration === generation &&
      authority.databaseLineage === ref.databaseLineage &&
      authority.chatId === ref.chatId &&
      isClientChatOccupancyAuthorityCurrent(authority)
    )
  }
  return canUseClientWriteAccess() && (!isClientSessionManaged() || pluginsReady())
}

function executionContext(
  generation: number,
  idempotencyKey: string,
  reclaimed: boolean,
  ref: ServerGenerationEffectLedgerRef | undefined,
  authority: ClientChatOccupancyAuthority | undefined,
  igpEffect?: IgpEffectMessageClaim,
) {
  const controller = new AbortController()
  const isCurrent = () => effectAccessIsCurrent(generation, ref, authority)
  const unsubscribeSession = clientSessionStore.subscribe(() => {
    if (!isCurrent()) controller.abort()
  })
  const unsubscribeOccupancy = authority
    ? clientChatOccupancyStore.subscribe(() => {
        if (!isCurrent()) controller.abort()
      })
    : () => {}
  return {
    context: { idempotencyKey, reclaimed, ...(igpEffect ? { igpEffect } : {}), isCurrent, signal: controller.signal },
    unsubscribe: () => {
      unsubscribeSession()
      unsubscribeOccupancy()
    },
  }
}

/**
 * Obtain the server's one-shot dispatch authority before running an effect,
 * then persist its terminal receipt. With no additive ledger reference (older
 * server), only a live terminal retains the historical behavior.
 */
export function runLedgeredGenerationEffect<T>(
  ref: ServerGenerationEffectLedgerRef | undefined,
  kind: GenerationEffectKind,
  delivery: GenerationEffectDelivery,
  effect: (
    context: GenerationEffectExecutionContext,
  ) => Promise<GenerationEffectExecution<T>> | GenerationEffectExecution<T>,
  options: RunGenerationEffectOptions = {},
): Promise<RunGenerationEffectResult<T>> {
  const sourceGeneration = captureClientSessionGeneration()
  const authority = options.chatOccupancyAuthority
  if (!effectAccessIsCurrent(sourceGeneration, ref, authority)) {
    return Promise.resolve({ executed: false, status: 'unavailable' })
  }
  const measuredEffect = (context: GenerationEffectExecutionContext) =>
    runMeasuredGenerationEffect(kind, delivery, context, effect)
  if (!ref) {
    if (delivery === 'late_recovery') return Promise.resolve({ executed: false, status: 'unavailable' })
    return Promise.resolve().then(async () => {
      if (!effectAccessIsCurrent(sourceGeneration)) return { executed: false, status: 'unavailable' as const }
      const lease = executionContext(
        sourceGeneration,
        `legacy-live-generation-effect:${kind}`,
        false,
        undefined,
        undefined,
      )
      try {
        const result = await measuredEffect(lease.context)
        return {
          executed: true,
          value: result.value,
          status: lease.context.isCurrent() ? result.status : ('unavailable' as const),
        }
      } finally {
        lease.unsubscribe()
      }
    })
  }

  const key = `${sourceGeneration}:${ref.databaseLineage}:${ref.generationId}:${kind}`
  const existing = inFlightEffects.get(key)
  if (existing) return existing as Promise<RunGenerationEffectResult<T>>

  const running = runClaimedGenerationEffect(ref, kind, delivery, measuredEffect, sourceGeneration, options)
  inFlightEffects.set(key, running as Promise<RunGenerationEffectResult<unknown>>)
  const cleanup = () => {
    if (inFlightEffects.get(key) === running) inFlightEffects.delete(key)
  }
  void running.then(cleanup, cleanup)
  return running
}

export type ClaimedIgpCommitResult = 'accepted' | 'target_stale' | 'ambiguous'
export type PreparedGenerationInlayMutationResult = 'accepted' | 'target_stale' | 'ambiguous'

export type ClaimedIgpExecutionResult =
  | { status: 'success'; result: string }
  | { status: 'skipped'; reason: 'not_configured' }

/** Execute IGP through the exact claimed-effect route. The server resolves the
 * accepted operation's immutable prompt, provider profile, credentials, and
 * generation parameters; no general browser write authority is consulted. */
export async function executeClaimedIgpEffect(
  ref: ServerGenerationEffectLedgerRef,
  claim: IgpEffectMessageClaim,
  authority: ClientChatOccupancyAuthority,
  signal?: AbortSignal,
): Promise<ClaimedIgpExecutionResult> {
  const sourceGeneration = authority.sessionGeneration
  if (claim.generationId !== ref.generationId || !effectAccessIsCurrent(sourceGeneration, ref, authority)) {
    throw new Error('IGP effect authority is stale')
  }
  const result = await requestGenerationEffect(
    ref,
    'igp',
    'completion',
    'POST',
    { claimId: claim.claimId },
    sourceGeneration,
    signal,
    authority,
  )
  if (!result) throw new Error('IGP provider execution is unavailable')
  const { response, body } = result
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  if (!response.ok) {
    const reason =
      typeof record?.error === 'string' && record.error.length > 0
        ? record.error
        : `IGP provider execution failed with HTTP ${response.status}`
    throw new Error(reason)
  }
  if (record?.status === 'skipped' && record.reason === 'not_configured') {
    return { status: 'skipped', reason: 'not_configured' }
  }
  if (record?.type === 'fail' && typeof record.result === 'string') throw new Error(record.result)
  if (record?.type !== 'success' || typeof record.result !== 'string') {
    throw new Error('IGP provider execution returned an invalid response')
  }
  return { status: 'success', result: record.result }
}

/** Commit the data-only IGP edit through its exact accepted-operation effect lease. */
export async function commitClaimedIgpEffect(
  ref: ServerGenerationEffectLedgerRef,
  claim: IgpEffectMessageClaim,
  authority: ClientChatOccupancyAuthority,
  input: {
    readonly data: string
    readonly expectedData: string
    readonly expectedGenerationId: string
  },
  signal?: AbortSignal,
): Promise<ClaimedIgpCommitResult> {
  const sourceGeneration = authority.sessionGeneration
  if (
    claim.generationId !== ref.generationId ||
    input.expectedGenerationId !== ref.generationId ||
    !effectAccessIsCurrent(sourceGeneration, ref, authority)
  ) {
    return 'target_stale'
  }
  let baseRevision = peekCachedServerCommandRevision()
  if (baseRevision === null) return 'ambiguous'
  for (let revisionAttempt = 0; revisionAttempt < 4; revisionAttempt += 1) {
    const result = await requestGenerationEffect(
      ref,
      'igp',
      'commit',
      'PUT',
      {
        baseRevision,
        claimId: claim.claimId,
        data: input.data,
        expectedData: input.expectedData,
        expectedGenerationId: input.expectedGenerationId,
      },
      sourceGeneration,
      signal,
      authority,
    )
    if (!result) {
      return effectAccessIsCurrent(sourceGeneration, ref, authority) ? 'ambiguous' : 'target_stale'
    }
    const { response, body } = result
    const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    if (response.ok) {
      const event = record?.event
      const effect = record?.effect
      if (
        !record ||
        !Number.isSafeInteger(record.revision) ||
        record.chatId !== ref.chatId ||
        record.messageId !== ref.messageId ||
        !event ||
        typeof event !== 'object' ||
        Array.isArray(event) ||
        (event as Record<string, unknown>).type !== 'message.updated' ||
        (event as Record<string, unknown>).resource !== 'message' ||
        (event as Record<string, unknown>).id !== ref.messageId ||
        (event as Record<string, unknown>).parentId !== ref.chatId ||
        (event as Record<string, unknown>).revision !== record.revision ||
        !effect ||
        typeof effect !== 'object' ||
        Array.isArray(effect) ||
        (effect as Record<string, unknown>).status !== 'completed' ||
        (effect as Record<string, unknown>).claimId !== claim.claimId
      ) {
        return 'ambiguous'
      }
      setCachedServerCommandRevision(record.revision as number)
      return 'accepted'
    }
    if (
      response.status === 409 &&
      record?.error === 'revision_conflict' &&
      Number.isSafeInteger(record.currentRevision) &&
      (record.currentRevision as number) >= 0 &&
      revisionAttempt < 3
    ) {
      baseRevision = record.currentRevision as number
      setCachedServerCommandRevision(baseRevision)
      continue
    }
    return 'target_stale'
  }
  return 'ambiguous'
}

interface PreparedGenerationInlayMutationInput {
  operationId: string
  preparationId: string
  expectedData?: string
  finalData?: string
}

function hasCapturedOwnerInlayAuthority(
  ref: ServerGenerationEffectLedgerRef,
  authority: ClientChatOccupancyAuthority,
): boolean {
  return (
    ref.version === 1 &&
    ref.keyType === 'operation' &&
    authority.version === 1 &&
    authority.claimClass === 'owner' &&
    ref.keyId.trim().length > 0 &&
    ref.generationId.trim().length > 0 &&
    ref.messageId.trim().length > 0 &&
    authority.databaseLineage === ref.databaseLineage &&
    authority.chatId === ref.chatId &&
    authority.sessionId.trim().length > 0 &&
    Number.isSafeInteger(authority.sessionGeneration) &&
    authority.sessionGeneration >= 0 &&
    Number.isSafeInteger(authority.occupancyEpoch) &&
    authority.occupancyEpoch >= 0
  )
}

async function mutatePreparedGenerationInlay(
  ref: ServerGenerationEffectLedgerRef,
  authority: ClientChatOccupancyAuthority,
  action: 'inlay-preparation' | 'inlay-finalization' | 'inlay-abandonment',
  input: PreparedGenerationInlayMutationInput,
  signal?: AbortSignal,
): Promise<PreparedGenerationInlayMutationResult> {
  const sourceGeneration = authority.sessionGeneration
  const capturedAbandonment = action === 'inlay-abandonment' && hasCapturedOwnerInlayAuthority(ref, authority)
  if (
    ref.keyType !== 'operation' ||
    ref.keyId !== input.operationId ||
    (!capturedAbandonment && !effectAccessIsCurrent(sourceGeneration, ref, authority))
  ) {
    return 'target_stale'
  }
  let baseRevision = peekCachedServerCommandRevision()
  if (baseRevision === null) return 'ambiguous'
  for (let revisionAttempt = 0; revisionAttempt < 4; revisionAttempt += 1) {
    const result = await requestGenerationEffect(
      ref,
      'igp',
      action,
      'PUT',
      {
        baseRevision,
        operationId: input.operationId,
        preparationId: input.preparationId,
        ...(input.expectedData !== undefined ? { expectedData: input.expectedData } : {}),
        ...(input.finalData !== undefined ? { finalData: input.finalData } : {}),
      },
      sourceGeneration,
      signal,
      authority,
      capturedAbandonment,
    )
    if (!result) {
      return capturedAbandonment || effectAccessIsCurrent(sourceGeneration, ref, authority)
        ? 'ambiguous'
        : 'target_stale'
    }
    const { response, body } = result
    const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    if (response.ok) {
      const event = record?.event
      const expectedDisposition =
        action === 'inlay-preparation'
          ? record?.inlayPreparation === 'prepared'
          : action === 'inlay-abandonment'
            ? record?.inlayPreparation === 'abandoned'
            : record?.inlayFinalization === 'committed' || record?.inlayFinalization === 'deferred'
      if (
        !record ||
        !Number.isSafeInteger(record.revision) ||
        record.chatId !== ref.chatId ||
        record.messageId !== ref.messageId ||
        record.preparationId !== input.preparationId ||
        !expectedDisposition ||
        !event ||
        typeof event !== 'object' ||
        Array.isArray(event) ||
        (event as Record<string, unknown>).type !== 'message.updated' ||
        (event as Record<string, unknown>).resource !== 'message' ||
        (event as Record<string, unknown>).id !== ref.messageId ||
        (event as Record<string, unknown>).parentId !== ref.chatId ||
        (event as Record<string, unknown>).revision !== record.revision
      ) {
        return 'ambiguous'
      }
      setCachedServerCommandRevision(record.revision as number)
      return 'accepted'
    }
    if (
      response.status === 409 &&
      record?.error === 'revision_conflict' &&
      Number.isSafeInteger(record.currentRevision) &&
      (record.currentRevision as number) >= 0 &&
      revisionAttempt < 3
    ) {
      baseRevision = record.currentRevision as number
      setCachedServerCommandRevision(baseRevision)
      continue
    }
    return 'target_stale'
  }
  return 'ambiguous'
}

export function beginPreparedGenerationInlay(
  ref: ServerGenerationEffectLedgerRef,
  authority: ClientChatOccupancyAuthority,
  input: { operationId: string; preparationId: string; expectedData: string },
  signal?: AbortSignal,
): Promise<PreparedGenerationInlayMutationResult> {
  return mutatePreparedGenerationInlay(ref, authority, 'inlay-preparation', input, signal)
}

export function finalizePreparedGenerationInlay(
  ref: ServerGenerationEffectLedgerRef,
  authority: ClientChatOccupancyAuthority,
  input: {
    operationId: string
    preparationId: string
    expectedData: string
    finalData: string
  },
  signal?: AbortSignal,
): Promise<PreparedGenerationInlayMutationResult> {
  return mutatePreparedGenerationInlay(ref, authority, 'inlay-finalization', input, signal)
}

export function abandonPreparedGenerationInlay(
  ref: ServerGenerationEffectLedgerRef,
  authority: ClientChatOccupancyAuthority,
  input: { operationId: string; preparationId: string },
  signal?: AbortSignal,
): Promise<PreparedGenerationInlayMutationResult> {
  return mutatePreparedGenerationInlay(ref, authority, 'inlay-abandonment', input, signal)
}

async function runClaimedGenerationEffect<T>(
  ref: ServerGenerationEffectLedgerRef,
  kind: GenerationEffectKind,
  delivery: GenerationEffectDelivery,
  effect: (
    context: GenerationEffectExecutionContext,
  ) => Promise<GenerationEffectExecution<T>> | GenerationEffectExecution<T>,
  sourceGeneration: number,
  options: RunGenerationEffectOptions,
): Promise<RunGenerationEffectResult<T>> {
  const authority = options.chatOccupancyAuthority
  const claim = await claimEffect(ref, kind, delivery, sourceGeneration, options, authority)
  if (!claim) return { executed: false, status: 'unavailable' }
  if (claim.status !== 'claimed' || typeof claim.claimId !== 'string') {
    return {
      executed: false,
      status:
        claim.status === 'not_claimed' &&
        (claim.reason === 'already_receipted' || claim.reason === 'late_recovery_skipped')
          ? 'already_receipted'
          : 'unavailable',
    }
  }

  if (!effectAccessIsCurrent(sourceGeneration, ref, authority)) return { executed: false, status: 'unavailable' }
  const lease = executionContext(
    sourceGeneration,
    claim.idempotencyKey,
    claim.reclaimed,
    ref,
    authority,
    kind === 'igp' ? { generationId: ref.generationId, claimId: claim.claimId } : undefined,
  )
  const stopLeaseRenewal = startEffectLeaseRenewal(ref, kind, claim, sourceGeneration, lease.context.signal, authority)
  try {
    const result = await effect(lease.context)
    const receipted = await settleEffect(
      ref,
      kind,
      claim.claimId,
      {
        status: result.status,
        ...(result.status === 'skipped' ? { reason: result.reason } : {}),
      },
      sourceGeneration,
      authority,
    )
    return {
      executed: true,
      value: result.value,
      status: receipted ? result.status : 'unavailable',
    }
  } catch (error) {
    await settleEffect(
      ref,
      kind,
      claim.claimId,
      {
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
      },
      sourceGeneration,
      authority,
    )
    throw error
  } finally {
    stopLeaseRenewal()
    lease.unsubscribe()
  }
}

async function claimEffect(
  ref: ServerGenerationEffectLedgerRef,
  kind: GenerationEffectKind,
  delivery: GenerationEffectDelivery,
  sourceGeneration: number,
  options: RunGenerationEffectOptions,
  authority?: ClientChatOccupancyAuthority,
): Promise<ClaimedEffectResponse | NotClaimedEffectResponse | null> {
  const result = await requestGenerationEffect(
    ref,
    kind,
    'claims',
    'POST',
    {
      delivery,
      messageId: ref.messageId,
      ...(options.recoverRecentCompletionAlert ? { recoverRecentCompletionAlert: true } : {}),
    },
    sourceGeneration,
    undefined,
    authority,
  )
  if (!result) return null
  const { response, body } = result
  if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (record.status === 'claimed' && typeof record.claimId === 'string') {
    return {
      status: 'claimed',
      claimId: record.claimId,
      ...(typeof record.leaseExpiresAt === 'string' ? { leaseExpiresAt: record.leaseExpiresAt } : {}),
      idempotencyKey:
        typeof record.idempotencyKey === 'string' ? record.idempotencyKey : generationEffectIdempotencyKey(ref, kind),
      reclaimed: record.reclaimed === true,
    }
  }
  if (record.status === 'not_claimed' && typeof record.reason === 'string') {
    return { status: 'not_claimed', reason: record.reason }
  }
  return null
}

function startEffectLeaseRenewal(
  ref: ServerGenerationEffectLedgerRef,
  kind: GenerationEffectKind,
  claim: ClaimedEffectResponse,
  sourceGeneration: number,
  signal: AbortSignal,
  authority?: ClientChatOccupancyAuthority,
): () => void {
  if (!claim.leaseExpiresAt) return () => {}
  const remainingMs = Date.parse(claim.leaseExpiresAt) - Date.now()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return () => {}
  const controller = new AbortController()
  let renewing = false
  const interval = setInterval(
    () => {
      if (!effectAccessIsCurrent(sourceGeneration, ref, authority)) clearInterval(interval)
      else if (!renewing) {
        renewing = true
        void renewEffectLease(ref, kind, claim.claimId, sourceGeneration, controller.signal, authority).finally(() => {
          renewing = false
        })
      }
    },
    Math.max(1_000, Math.min(30_000, Math.floor(remainingMs / 3))),
  )
  const stop = () => {
    clearInterval(interval)
    controller.abort()
  }
  signal.addEventListener('abort', stop, { once: true })
  return () => {
    stop()
    signal.removeEventListener('abort', stop)
  }
}

async function renewEffectLease(
  ref: ServerGenerationEffectLedgerRef,
  kind: GenerationEffectKind,
  claimId: string,
  sourceGeneration: number,
  signal: AbortSignal,
  authority?: ClientChatOccupancyAuthority,
): Promise<void> {
  // Expiry makes a lost renewal recoverable; callbacks retain their stable
  // idempotency key if another writer has to reclaim the effect.
  await requestGenerationEffect(ref, kind, 'lease', 'PUT', { claimId }, sourceGeneration, signal, authority)
}

function generationEffectIdempotencyKey(ref: ServerGenerationEffectLedgerRef, kind: GenerationEffectKind): string {
  return ['generation-effect-v1', ref.databaseLineage, ref.keyType, ref.keyId, kind].map(encodeURIComponent).join(':')
}

async function settleEffect(
  ref: ServerGenerationEffectLedgerRef,
  kind: GenerationEffectKind,
  claimId: string,
  receipt: { status: 'completed' | 'skipped' | 'failed'; reason?: string; lastError?: string },
  sourceGeneration: number,
  authority?: ClientChatOccupancyAuthority,
): Promise<boolean> {
  const result = await requestGenerationEffect(
    ref,
    kind,
    'receipt',
    'PUT',
    {
      claimId,
      ...receipt,
    },
    sourceGeneration,
    undefined,
    authority,
  )
  return result?.response.ok ?? false
}

const GENERATION_EFFECT_REQUEST_TIMEOUT_MS = 30_000
const GENERATION_EFFECT_PROVIDER_TIMEOUT_MS = 10 * 60_000

/** Bound auth, transport and body consumption together, including transports
 * that ignore abort. Retiring the request leaves server claim/receipt authority
 * intact so the next recovery can discover an already committed outcome. */
async function requestGenerationEffect(
  ref: ServerGenerationEffectLedgerRef,
  kind: GenerationEffectKind,
  action:
    | 'claims'
    | 'lease'
    | 'receipt'
    | 'commit'
    | 'completion'
    | 'inlay-preparation'
    | 'inlay-finalization'
    | 'inlay-abandonment',
  method: 'POST' | 'PUT',
  payload: object,
  sourceGeneration: number,
  signal?: AbortSignal,
  authority?: ClientChatOccupancyAuthority,
  allowCapturedAuthority = false,
): Promise<{ response: Response; body: unknown } | null> {
  const accessIsAvailable = () =>
    allowCapturedAuthority && authority
      ? hasCapturedOwnerInlayAuthority(ref, authority)
      : effectAccessIsCurrent(sourceGeneration, ref, authority)
  if (!accessIsAvailable() || signal?.aborted) return null
  const controller = new AbortController()
  let resolveCancelled!: (value: null) => void
  const cancelled = new Promise<null>((resolve) => {
    resolveCancelled = resolve
  })
  const abort = () => {
    controller.abort()
    resolveCancelled(null)
  }
  signal?.addEventListener('abort', abort, { once: true })
  const unsubscribe = allowCapturedAuthority
    ? () => {}
    : clientSessionStore.subscribe(() => {
        if (!accessIsAvailable()) abort()
      })
  const unsubscribeOccupancy =
    authority && !allowCapturedAuthority
      ? clientChatOccupancyStore.subscribe(() => {
          if (!accessIsAvailable()) abort()
        })
      : () => {}
  const deadline = setTimeout(
    abort,
    action === 'completion' ? GENERATION_EFFECT_PROVIDER_TIMEOUT_MS : GENERATION_EFFECT_REQUEST_TIMEOUT_MS,
  )
  const isCurrent = () => !controller.signal.aborted && accessIsAvailable()
  try {
    return await Promise.race([
      cancelled,
      (async () => {
        try {
          const auth = await getNodeServerProxyAuth()
          if (!isCurrent()) return null
          const response = await fetch(
            `/api/v1/generation-effects/${encodeURIComponent(ref.generationId)}/${encodeURIComponent(kind)}/${action}`,
            {
              method,
              headers: {
                'content-type': 'application/json',
                'risu-auth': auth,
                ...activeWriterSessionHeader(),
                ...(authority ? { [ACTIVE_WRITER_SESSION_HEADER]: authority.sessionId } : {}),
                [SERVER_DATABASE_LINEAGE_HEADER]: ref.databaseLineage,
              },
              body: JSON.stringify(payload),
              signal: controller.signal,
            },
          )
          if (!isCurrent()) return null
          const body = await readJson(response)
          if (!isCurrent() || (!authority && handleActiveWriterStaleResponse(response, body, sourceGeneration))) {
            return null
          }
          return { response, body }
        } catch {
          return null
        }
      })(),
    ])
  } finally {
    clearTimeout(deadline)
    unsubscribe()
    unsubscribeOccupancy()
    signal?.removeEventListener('abort', abort)
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function resetGenerationEffectLedgerForTests(): void {
  inFlightEffects.clear()
  activeGenerationInlayPreparations.clear()
  generationEffectTimingObserver = null
}
