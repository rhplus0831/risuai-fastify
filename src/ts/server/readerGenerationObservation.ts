import type { PromptChatEvent } from '@risuai/protocol/generation-sse'
import {
  captureClientSessionGeneration,
  clientSessionStore,
  getClientSessionSnapshot,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { discardReaderProjectionState } from '../readerProjectionLifecycle'
import type { Message } from '../storage/database.svelte'
import { fetchServerBootstrapReadOnly, type GenerationOperationProjection } from './bootstrap'
import { hydrateReaderChatMessageWindow, hydrateReaderGenerationMessages } from './chatMessageHydration.svelte'
import { setCachedServerCommandRevision } from './commands'
import { subscribeBrowserLifecycleRecovery } from './lifecycleRecovery'
import { observeReaderGenerationStream } from './readerGenerationStream'
import type {
  ReaderGenerationIdentity,
  ReaderGenerationProjection,
  ReaderGenerationView,
} from './readerGenerationTypes'
import { getReaderChatIncarnation, getReaderChatMessages } from './readerTranscriptProjection.svelte'

export const READER_GENERATION_POLL_MS = 2_000
export const READER_GENERATION_IDLE_POLL_MS = 5_000
export const READER_GENERATION_READ_TIMEOUT_MS = 15_000
export const READER_GENERATION_RETRY_DELAYS_MS = [500, 2_000, 5_000] as const

export interface ReaderGenerationObservationOptions {
  characterId: string
  chatId: string
  incarnation: number
  loadPages(): number
  onChange(view: ReaderGenerationView): void
}

export interface ReaderGenerationObservation {
  refresh(): void
  stop(): void
}

interface Viewer {
  identity: ReaderGenerationIdentity
  controller: AbortController
}

const streamableStates = new Set<GenerationOperationProjection['state']>(['owned_by_job', 'stopping'])
const pendingStates = new Set<GenerationOperationProjection['state']>([
  'accepted',
  'launching',
  'owned_by_job',
  'stopping',
  'finalizing',
])

function identityKey(identity: Pick<ReaderGenerationIdentity, 'operationId' | 'attemptNo' | 'jobId'>): string {
  return `${identity.operationId}:${identity.attemptNo}:${identity.jobId}`
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      resolve(undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

function exactReaderResult(
  messages: readonly Message[],
  projection: ReaderGenerationProjection,
  resultMessageId: string,
  operation?: GenerationOperationProjection | null,
): boolean {
  const matching = messages.filter((message) => message.chatId === resultMessageId)
  if (matching.length !== 1 || matching[0]?.role !== 'char') return false
  const info = matching[0].generationInfo
  return (
    info?.databaseLineage === projection.databaseLineage &&
    info.operationId === projection.operationId &&
    ((info.attemptNo === projection.attemptNo && info.generationId === projection.generationId) ||
      (operation?.resultMessageId === resultMessageId &&
        !pendingStates.has(operation.state) &&
        operation.projectionEpoch > projection.projectionEpoch &&
        typeof info.attemptNo === 'number' &&
        info.attemptNo > projection.attemptNo &&
        !!info.generationId))
  )
}

/**
 * A selected reader owns one status request, one viewer and one scheduled probe.
 * Bootstrap/status discovery never adopts operation, outbox or effect state into
 * writer stores. Stream text is disposable presentation; only hydration publishes
 * the persisted result. Closing this service only detaches its HTTP viewer.
 */
export function startReaderGenerationObservation(
  options: ReaderGenerationObservationOptions,
): ReaderGenerationObservation {
  const generation = captureClientSessionGeneration()
  const lineage = getClientSessionSnapshot().databaseLineage
  let stopped = false
  let paused = false
  let probeSequence = 0
  let probeController: AbortController | null = null
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  let viewer: Viewer | null = null
  let trackedOperation: GenerationOperationProjection | null = null
  let projection: ReaderGenerationProjection | null = null
  let projectionEpoch = -1
  let probeFailures = 0
  let streamFailures = 0
  let failedIdentity: string | null = null
  let reconcileFailures = 0
  let stopSession: (() => void) | null = null
  let stopLifecycle: (() => void) | null = null
  let stopBrowser: (() => void) | null = null

  function current(): boolean {
    const session = getClientSessionSnapshot()
    return (
      !stopped &&
      session.managed &&
      session.authenticated &&
      (session.lifecycle === 'reading' || session.lifecycle === 'promoting') &&
      isClientSessionGenerationCurrent(generation) &&
      !!lineage &&
      session.databaseLineage === lineage &&
      getReaderChatIncarnation(options.characterId, options.chatId) === options.incarnation
    )
  }

  function available(): boolean {
    return (
      current() &&
      getClientSessionSnapshot().projectionReady &&
      getClientSessionSnapshot().connection !== 'interrupted' &&
      (typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
      (typeof navigator === 'undefined' || navigator.onLine !== false)
    )
  }

  function publish(status: ReaderGenerationView['status'] = projection ? 'watching' : 'idle'): void {
    if (current()) options.onChange({ status, projection })
  }

  function cancelProbe(): void {
    probeSequence += 1
    probeController?.abort()
    probeController = null
    if (probeTimer) clearTimeout(probeTimer)
    probeTimer = null
  }

  function detach(): void {
    const previous = viewer
    viewer = null
    previous?.controller.abort()
  }

  function suspend(announce = true): void {
    paused = true
    cancelProbe()
    detach()
    // Losing a viewer while the document is hidden is expected and the old
    // presentation is not visible. Preserve it until the foreground probe can
    // replace it, so returning to the page does not briefly insert an
    // interruption banner or remove the in-row generation indicator.
    if (!announce) return
    if (projection) projection = { ...projection, status: 'interrupted' }
    publish('interrupted')
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    cancelProbe()
    detach()
    projection = null
    trackedOperation = null
    stopSession?.()
    stopSession = null
    stopLifecycle?.()
    stopLifecycle = null
    stopBrowser?.()
    stopBrowser = null
  }

  function schedule(delayMs: number): void {
    if (!available()) return
    if (probeTimer) clearTimeout(probeTimer)
    probeTimer = setTimeout(() => {
      probeTimer = null
      void probe()
    }, delayMs)
  }

  function interrupted(): void {
    if (projection) projection = { ...projection, status: 'interrupted' }
    publish('interrupted')
  }

  async function authenticationLost(): Promise<void> {
    if (!current()) return
    // This boundary revokes authentication synchronously before cache cleanup.
    await discardReaderProjectionState('auth-loss')
  }

  function streamCurrent(source: Viewer): boolean {
    return available() && viewer === source && !source.controller.signal.aborted
  }

  function applyEvent(source: Viewer, event: PromptChatEvent, accumulator: { text: string; gap: boolean }): void {
    if (!streamCurrent(source) || !projection || identityKey(projection) !== identityKey(source.identity)) return
    let next = { ...projection }
    if (Number.isSafeInteger(event.projectionEpoch)) {
      projectionEpoch = Math.max(projectionEpoch, event.projectionEpoch!)
      next.projectionEpoch = Math.max(next.projectionEpoch, event.projectionEpoch!)
    }
    if (event.type === 'info') {
      // Current Fastify generation ids are the durable job id. A conflicting
      // identity must not redirect a Continue/regenerate overlay to another row.
      if (event.generationId && event.generationId !== source.identity.jobId) {
        throw new Error('Reader generation identity changed within one stream')
      }
      next.generationId = event.generationId ?? next.generationId
      next.halfStreaming = event.halfStreaming === true
      if (event.continueDisposition) next.continueDisposition = event.continueDisposition
      if (event.continueBase !== undefined) {
        if (next.continueBase !== undefined && next.continueBase !== event.continueBase)
          throw new Error('Reader Continue base changed within one attempt')
        next.continueBase = event.continueBase
      }
      next.phase = 'waiting-for-model'
      next.status = 'streaming'
    } else if (event.type === 'token') {
      accumulator.text += event.content
      if (!accumulator.gap && !next.halfStreaming) {
        next.text = (next.continueDisposition === 'extend' ? (next.continueBase ?? '') : '') + accumulator.text
      }
      if (event.generatedTokens !== undefined) next.generatedTokens = event.generatedTokens
      if (event.elapsedMs !== undefined) next.elapsedMs = event.elapsedMs
      next.phase = 'generating'
      next.status = 'streaming'
    } else if (event.type === 'replay_gap') {
      accumulator.text = ''
      accumulator.gap = true
      next.gapTruncated = true
    } else if (event.type === 'stage') {
      next.phase =
        event.stage === 'validate' || event.stage === 'prompt'
          ? 'preparing'
          : event.stage === 'provider'
            ? 'waiting-for-model'
            : 'finalizing'
    } else if (event.type === 'post_generation_progress') {
      next.phase = 'finalizing'
      next.status = 'finalizing'
    } else if (event.type === 'done' || event.type === 'error') {
      if (event.postGeneration?.messageId) next.resultMessageId = event.postGeneration.messageId
      if (event.type === 'done') {
        if (event.halfStreaming !== undefined) next.halfStreaming = event.halfStreaming
        if (event.continueDisposition) next.continueDisposition = event.continueDisposition
        if (event.continueBase !== undefined) {
          if (next.continueBase !== undefined && next.continueBase !== event.continueBase)
            throw new Error('Reader Continue base changed at completion')
          next.continueBase = event.continueBase
        }
      }
      if (typeof event.result === 'string') {
        next.text = (next.continueDisposition === 'extend' ? (next.continueBase ?? '') : '') + event.result
        next.gapTruncated = false
      }
      next.phase = 'finalizing'
      next.status = 'finalizing'
    } else {
      // Prompt contents, message patches, side effects and completion callbacks
      // have no reader-side authority. Committed resources provide their output.
      return
    }
    projection = next
    publish()
  }

  function attach(scope: ReaderGenerationIdentity): void {
    detach()
    const { databaseLineage, characterId, chatId, operationId, attemptNo, jobId, projectionEpoch } = scope
    const identity = { databaseLineage, characterId, chatId, operationId, attemptNo, jobId, projectionEpoch }
    const source: Viewer = { identity, controller: new AbortController() }
    viewer = source
    const accumulator = { text: '', gap: false }
    void observeReaderGenerationStream({
      identity,
      signal: source.controller.signal,
      isCurrent: () => streamCurrent(source),
      onEvent: (event) => applyEvent(source, event, accumulator),
    })
      .then(async (result) => {
        if (!current() || viewer !== source) return
        viewer = null
        if (result.status === 'aborted') {
          if (available()) schedule(READER_GENERATION_IDLE_POLL_MS)
          return
        }
        if (result.status === 'unavailable' && result.httpStatus === 401) {
          await authenticationLost()
          return
        }
        if (result.status === 'terminal') {
          streamFailures = 0
          // The operation snapshot, not transport closure, establishes whether a
          // terminal was persisted, is still finalizing, or retained no result.
          schedule(0)
        } else {
          streamFailures += 1
          failedIdentity = identityKey(identity)
          interrupted()
          schedule(READER_GENERATION_RETRY_DELAYS_MS[streamFailures - 1] ?? READER_GENERATION_IDLE_POLL_MS)
        }
      })
      .catch(() => {
        if (!current() || viewer !== source) return
        viewer = null
        streamFailures += 1
        failedIdentity = identityKey(identity)
        interrupted()
        schedule(READER_GENERATION_RETRY_DELAYS_MS[streamFailures - 1] ?? READER_GENERATION_IDLE_POLL_MS)
      })
  }

  function describe(operation: GenerationOperationProjection): ReaderGenerationProjection | null {
    const attempt = operation.currentAttempt
    if (!attempt || !attempt.jobId || !lineage) return null
    const identity: ReaderGenerationIdentity = {
      databaseLineage: lineage,
      characterId: options.characterId,
      chatId: options.chatId,
      operationId: operation.operationId,
      attemptNo: attempt.attemptNo,
      jobId: attempt.jobId,
      projectionEpoch: operation.projectionEpoch,
    }
    const previous = projection && identityKey(projection) === identityKey(identity) ? projection : null
    return {
      ...identity,
      mode: operation.mode ?? 'send',
      ...(operation.targetMessageId ? { targetMessageId: operation.targetMessageId } : {}),
      generationId: attempt.finalizationGenerationId ?? attempt.jobId,
      text: null,
      status: operation.state === 'finalizing' ? 'finalizing' : 'preparing',
      phase: operation.state === 'finalizing' ? 'finalizing' : 'starting',
      startedAt: Date.now(),
      ...previous,
      projectionEpoch: operation.projectionEpoch,
      ...(operation.resultMessageId ? { resultMessageId: operation.resultMessageId } : {}),
    }
  }

  async function reconcile(
    operation: GenerationOperationProjection | null,
    controller: AbortController,
    sequence: number,
  ): Promise<boolean> {
    const expected = projection
    if (!expected) return true
    const isCurrent = () =>
      available() && probeSequence === sequence && !controller.signal.aborted && projection === expected
    const body = getReaderChatMessages(options.chatId)
    const resultId =
      operation?.resultMessageId ??
      expected.resultMessageId ??
      body?.messages.find(
        (message) => message.chatId && exactReaderResult([message], expected, message.chatId, operation),
      )?.chatId
    if (body?.current && resultId && exactReaderResult(body.messages, expected, resultId, operation)) return true
    const hydrated = await untilAborted(
      resultId
        ? hydrateReaderGenerationMessages(options.chatId, resultId, { signal: controller.signal })
        : hydrateReaderChatMessageWindow(options.chatId, options.loadPages(), {
            force: true,
            signal: controller.signal,
          }),
      controller.signal,
    )
    if (!isCurrent() || !hydrated) return false
    const refreshed = getReaderChatMessages(options.chatId)
    if (!refreshed?.current) return false
    if (resultId) return exactReaderResult(refreshed.messages, expected, resultId, operation)
    if (
      refreshed.messages.some(
        (message) => message.chatId && exactReaderResult([message], expected, message.chatId, operation),
      )
    )
      return true
    // A terminal rejection/cancellation can intentionally persist no assistant.
    // Only a successful authoritative read under that exact terminal status may
    // retire its temporary display. EOF or a missing descriptor cannot do this.
    return operation !== null && !pendingStates.has(operation.state)
  }

  async function probe(): Promise<void> {
    if (!available() || probeController) return
    const sequence = ++probeSequence
    const controller = new AbortController()
    probeController = controller
    const timeout = setTimeout(() => controller.abort(), READER_GENERATION_READ_TIMEOUT_MS)
    const isCurrent = () => available() && probeSequence === sequence && !controller.signal.aborted
    try {
      const result = await untilAborted(
        fetchServerBootstrapReadOnly(controller.signal, { cacheRevision: false }),
        controller.signal,
      )
      if (!isCurrent() || !result) return
      if (result.status !== 'ok') {
        if (result.status === 'error' && result.httpStatus === 401) await authenticationLost()
        else throw new Error('Reader generation status is unavailable')
        return
      }
      const runtime = result.bootstrap
      if (!runtime.initialized || runtime.databaseLineage !== lineage) {
        detach()
        projection = null
        interrupted()
        // ConnectedReaderSync owns database replacement and reinstalls this
        // component under a fresh generation; old job ids are never reused here.
        schedule(READER_GENERATION_IDLE_POLL_MS)
        return
      }
      const epoch = runtime.generationOperationProjectionEpoch
      if (epoch === undefined || !Number.isSafeInteger(epoch) || epoch < projectionEpoch)
        throw new Error('Stale generation status')
      projectionEpoch = epoch
      setCachedServerCommandRevision(runtime.revision)
      const operations = (runtime.generationOperations ?? []).filter(
        (operation) =>
          operation.characterId === options.characterId &&
          operation.chatId === options.chatId &&
          operation.projectionEpoch <= epoch,
      )
      const pending = operations
        .filter((operation) => pendingStates.has(operation.state))
        .sort((left, right) => right.projectionEpoch - left.projectionEpoch)[0]
      const operation =
        pending ?? operations.find((candidate) => candidate.operationId === trackedOperation?.operationId) ?? null
      probeFailures = 0
      if (!operation) {
        if (projection) {
          detach()
          // Active operations cannot fall out of the bounded recent-terminal
          // list. An exact persisted generation can still establish completion
          // when many newer terminal operations displaced this old descriptor.
          const reconciled = await reconcile(null, controller, sequence)
          if (!isCurrent()) return
          if (reconciled) {
            projection = null
            publish()
          } else interrupted()
        } else publish()
        const incomplete = runtime.activeGenerationJobs?.some((job) => job.chatId === options.chatId)
        if (incomplete) interrupted()
        schedule(READER_GENERATION_IDLE_POLL_MS)
        return
      }
      trackedOperation = operation
      if (projection && projection.operationId !== operation.operationId) {
        detach()
        projection = null
        streamFailures = 0
        failedIdentity = null
        reconcileFailures = 0
      }
      if (!pendingStates.has(operation.state)) {
        detach()
        const reconciled =
          projection && operation.operationId === projection.operationId
            ? await reconcile(operation, controller, sequence)
            : false
        if (!isCurrent()) return
        if (reconciled) {
          projection = null
          reconcileFailures = 0
          publish()
        } else if (projection) {
          reconcileFailures += 1
          interrupted()
        } else publish()
        schedule(READER_GENERATION_RETRY_DELAYS_MS[reconcileFailures - 1] ?? READER_GENERATION_IDLE_POLL_MS)
        return
      }
      const next = describe(operation)
      if (!next) {
        detach()
        if (operation.state === 'accepted' || operation.state === 'launching') publish('watching')
        else interrupted()
        schedule(READER_GENERATION_POLL_MS)
        return
      }
      const nextKey = identityKey(next)
      if (!projection || identityKey(projection) !== nextKey) {
        detach()
        streamFailures = 0
        failedIdentity = null
        reconcileFailures = 0
      }
      projection = next
      if (
        next.targetMessageId &&
        next.mode !== 'send' &&
        !getReaderChatMessages(options.chatId)?.messages.some((message) => message.chatId === next.targetMessageId)
      ) {
        publish()
        const hydrated = await untilAborted(
          hydrateReaderGenerationMessages(options.chatId, next.targetMessageId, { signal: controller.signal }),
          controller.signal,
        )
        if (!isCurrent()) return
        if (
          !hydrated ||
          !getReaderChatMessages(options.chatId)?.messages.some((message) => message.chatId === next.targetMessageId)
        ) {
          interrupted()
          schedule(READER_GENERATION_IDLE_POLL_MS)
          return
        }
      }
      const mayAttach =
        streamableStates.has(operation.state) &&
        !(failedIdentity === nextKey && streamFailures > READER_GENERATION_RETRY_DELAYS_MS.length)
      if (mayAttach && !viewer) attach(next)
      else if (!streamableStates.has(operation.state)) {
        if (viewer) detach()
        projection = { ...projection, status: 'finalizing', phase: 'finalizing' }
      }
      if (projection.status === 'interrupted' && mayAttach) projection = { ...projection, status: 'preparing' }
      publish(projection.status === 'interrupted' ? 'interrupted' : 'watching')
      schedule(
        mayAttach || streamableStates.has(operation.state) === false
          ? READER_GENERATION_POLL_MS
          : READER_GENERATION_IDLE_POLL_MS,
      )
    } catch {
      if (!current() || probeSequence !== sequence || controller.signal.aborted) return
      probeFailures += 1
      interrupted()
      const delay = READER_GENERATION_RETRY_DELAYS_MS[probeFailures - 1]
      if (delay !== undefined) schedule(delay)
    } finally {
      clearTimeout(timeout)
      if (probeController === controller) probeController = null
      if (controller.signal.aborted && current() && probeSequence === sequence) {
        probeFailures += 1
        interrupted()
        const delay = READER_GENERATION_RETRY_DELAYS_MS[probeFailures - 1]
        if (delay !== undefined) schedule(delay)
      }
    }
  }

  function refresh(): void {
    if (!available()) {
      if (current()) suspend()
      return
    }
    paused = false
    probeFailures = 0
    streamFailures = 0
    failedIdentity = null
    reconcileFailures = 0
    cancelProbe()
    detach()
    void probe()
  }

  if (!current()) return { refresh, stop }
  stopSession = clientSessionStore.subscribe(() => {
    if (!current()) stop()
    else if (!available()) suspend()
    else if (paused) refresh()
  })
  stopLifecycle = subscribeBrowserLifecycleRecovery(refresh)
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const hidden = () => {
      if (document.visibilityState === 'hidden') suspend(false)
    }
    const offline = () => suspend()
    window.addEventListener('offline', offline)
    const pageHide = () => suspend(false)
    window.addEventListener('pagehide', pageHide)
    document.addEventListener('visibilitychange', hidden)
    stopBrowser = () => {
      window.removeEventListener('offline', offline)
      window.removeEventListener('pagehide', pageHide)
      document.removeEventListener('visibilitychange', hidden)
    }
  }
  refresh()
  return { refresh, stop }
}
