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
import { activeWriterSessionHeader, handleActiveWriterStaleResponse } from '../server/activeWriterSession'
import { SERVER_DATABASE_LINEAGE_HEADER } from '../server/commands'
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

export interface GenerationEffectExecutionContext {
  /** Stable across an expired-lease reclaim; callbacks can use it as their idempotency key. */
  idempotencyKey: string
  reclaimed: boolean
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

function effectAccessIsCurrent(generation: number): boolean {
  return (
    isClientSessionGenerationCurrent(generation) &&
    canUseClientWriteAccess() &&
    (!isClientSessionManaged() || pluginsReady())
  )
}

function executionContext(generation: number, idempotencyKey: string, reclaimed: boolean) {
  const controller = new AbortController()
  const isCurrent = () => effectAccessIsCurrent(generation)
  const unsubscribe = clientSessionStore.subscribe(() => {
    if (!isCurrent()) controller.abort()
  })
  return { context: { idempotencyKey, reclaimed, isCurrent, signal: controller.signal }, unsubscribe }
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
): Promise<RunGenerationEffectResult<T>> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!effectAccessIsCurrent(sourceGeneration)) return Promise.resolve({ executed: false, status: 'unavailable' })
  const measuredEffect = (context: GenerationEffectExecutionContext) =>
    runMeasuredGenerationEffect(kind, delivery, context, effect)
  if (!ref) {
    if (delivery === 'late_recovery') return Promise.resolve({ executed: false, status: 'unavailable' })
    return Promise.resolve().then(async () => {
      if (!effectAccessIsCurrent(sourceGeneration)) return { executed: false, status: 'unavailable' as const }
      const lease = executionContext(sourceGeneration, `legacy-live-generation-effect:${kind}`, false)
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

  const running = runClaimedGenerationEffect(ref, kind, delivery, measuredEffect, sourceGeneration)
  inFlightEffects.set(key, running as Promise<RunGenerationEffectResult<unknown>>)
  const cleanup = () => {
    if (inFlightEffects.get(key) === running) inFlightEffects.delete(key)
  }
  void running.then(cleanup, cleanup)
  return running
}

async function runClaimedGenerationEffect<T>(
  ref: ServerGenerationEffectLedgerRef,
  kind: GenerationEffectKind,
  delivery: GenerationEffectDelivery,
  effect: (
    context: GenerationEffectExecutionContext,
  ) => Promise<GenerationEffectExecution<T>> | GenerationEffectExecution<T>,
  sourceGeneration: number,
): Promise<RunGenerationEffectResult<T>> {
  const claim = await claimEffect(ref, kind, delivery, sourceGeneration)
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

  if (!effectAccessIsCurrent(sourceGeneration)) return { executed: false, status: 'unavailable' }
  const lease = executionContext(sourceGeneration, claim.idempotencyKey, claim.reclaimed)
  const stopLeaseRenewal = startEffectLeaseRenewal(ref, kind, claim, sourceGeneration, lease.context.signal)
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
): Promise<ClaimedEffectResponse | NotClaimedEffectResponse | null> {
  if (!effectAccessIsCurrent(sourceGeneration)) return null
  const auth = await getNodeServerProxyAuth()
  if (!effectAccessIsCurrent(sourceGeneration)) return null
  let response: Response
  try {
    response = await fetch(
      `/api/v1/generation-effects/${encodeURIComponent(ref.generationId)}/${encodeURIComponent(kind)}/claims`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'risu-auth': auth,
          ...activeWriterSessionHeader(),
          [SERVER_DATABASE_LINEAGE_HEADER]: ref.databaseLineage,
        },
        body: JSON.stringify({ delivery, messageId: ref.messageId }),
      },
    )
  } catch {
    return null
  }
  const body = await readJson(response)
  if (handleActiveWriterStaleResponse(response, body, sourceGeneration)) return null
  if (!effectAccessIsCurrent(sourceGeneration)) return null
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
): () => void {
  if (!claim.leaseExpiresAt) return () => {}
  const remainingMs = Date.parse(claim.leaseExpiresAt) - Date.now()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return () => {}
  const interval = setInterval(
    () => {
      if (!effectAccessIsCurrent(sourceGeneration)) clearInterval(interval)
      else void renewEffectLease(ref, kind, claim.claimId, sourceGeneration)
    },
    Math.max(1_000, Math.min(30_000, Math.floor(remainingMs / 3))),
  )
  const stop = () => clearInterval(interval)
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
): Promise<void> {
  if (!effectAccessIsCurrent(sourceGeneration)) return
  const auth = await getNodeServerProxyAuth()
  if (!effectAccessIsCurrent(sourceGeneration)) return
  try {
    const response = await fetch(
      `/api/v1/generation-effects/${encodeURIComponent(ref.generationId)}/${encodeURIComponent(kind)}/lease`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'risu-auth': auth,
          ...activeWriterSessionHeader(),
          [SERVER_DATABASE_LINEAGE_HEADER]: ref.databaseLineage,
        },
        body: JSON.stringify({ claimId }),
      },
    )
    const body = await readJson(response)
    handleActiveWriterStaleResponse(response, body, sourceGeneration)
  } catch {
    // Expiry makes a lost renewal recoverable; the callback keeps its stable
    // idempotency key in case another writer has to reclaim it.
  }
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
): Promise<boolean> {
  if (!effectAccessIsCurrent(sourceGeneration)) return false
  const auth = await getNodeServerProxyAuth()
  if (!effectAccessIsCurrent(sourceGeneration)) return false
  let response: Response
  try {
    response = await fetch(
      `/api/v1/generation-effects/${encodeURIComponent(ref.generationId)}/${encodeURIComponent(kind)}/receipt`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'risu-auth': auth,
          ...activeWriterSessionHeader(),
          [SERVER_DATABASE_LINEAGE_HEADER]: ref.databaseLineage,
        },
        body: JSON.stringify({ claimId, ...receipt }),
      },
    )
  } catch {
    return false
  }
  const body = await readJson(response)
  if (handleActiveWriterStaleResponse(response, body, sourceGeneration)) return false
  return response.ok
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
  generationEffectTimingObserver = null
}
