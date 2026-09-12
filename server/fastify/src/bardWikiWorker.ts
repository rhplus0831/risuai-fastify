import type { DatabaseSync } from 'node:sqlite'
import { getDatabaseLineage } from './databaseLineage.js'
import {
  claimNextBardWikiJob,
  completeBardWikiJob,
  failBardWikiJob,
  listPendingBardWikiJobChatIds,
  pruneTerminalBardWikiJobs,
  recoverRunningBardWikiJobs,
  retryOrFailBardWikiJob,
  type BardWikiJob,
  type BardWikiJobKind,
  type BardWikiJobRetryOptions,
  type PruneTerminalBardWikiJobsOptions,
} from './bardWikiJobs.js'
import { buildBardWikiJobEvent, emitMemoryEventSafely, type MemoryEventSink } from './memoryEvents.js'

export const BARDWIKI_WORKER_DEFAULT_POLL_INTERVAL_MS = 1_000
export const BARDWIKI_WORKER_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface BardWikiJobHandlerContext {
  signal: AbortSignal
}

export type BardWikiJobHandlerResult = void | { outcome: 'rescheduled'; job: BardWikiJob }
export type BardWikiJobHandler = (
  job: BardWikiJob,
  context: BardWikiJobHandlerContext,
) => BardWikiJobHandlerResult | Promise<BardWikiJobHandlerResult>
export type BardWikiJobHandlers = Record<BardWikiJobKind, BardWikiJobHandler>

export interface BardWikiWorkerOptions {
  db: DatabaseSync
  pollIntervalMs?: number
  handlers?: Partial<BardWikiJobHandlers>
  onEvent?: MemoryEventSink
  onError?: (error: unknown) => void
  retry?: BardWikiJobRetryOptions
  terminalRetention?: false | (PruneTerminalBardWikiJobsOptions & { intervalMs?: number })
}

export class BardWikiJobHandlerError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message)
    this.name = 'BardWikiJobHandlerError'
    this.code = code
    this.retryable = options.retryable ?? true
  }
}

export class BardWikiWorker {
  private readonly db: DatabaseSync
  private readonly pollIntervalMs: number
  private readonly handlers: BardWikiJobHandlers
  private readonly onEvent: MemoryEventSink | null
  private readonly onError: (error: unknown) => void
  private readonly retry: BardWikiJobRetryOptions
  private readonly terminalRetention: (PruneTerminalBardWikiJobsOptions & { intervalMs: number }) | null
  private readonly chatLastServedAt = new Map<string, number>()
  private readonly runningJobAbortControllers = new Map<string, AbortController>()
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<boolean> | null = null
  private active = false
  private wakeRequested = false
  private lastRetentionSweepAtMs = 0
  private serveSequence = 0
  private databaseLineage: string

  constructor(options: BardWikiWorkerOptions) {
    this.db = options.db
    this.databaseLineage = getDatabaseLineage(this.db)
    this.pollIntervalMs = normalizeInterval(options.pollIntervalMs, BARDWIKI_WORKER_DEFAULT_POLL_INTERVAL_MS)
    this.handlers = {
      apply_turn: noopBardWikiJobHandler,
      reconcile_receipt: noopBardWikiJobHandler,
      rebuild_chat: noopBardWikiJobHandler,
      ...options.handlers,
    }
    this.onEvent = options.onEvent ?? null
    this.onError = options.onError ?? defaultBardWikiWorkerErrorHandler
    this.retry = options.retry ?? {}
    const retention = options.terminalRetention === false ? null : (options.terminalRetention ?? {})
    this.terminalRetention =
      retention === null
        ? null
        : {
            ...retention,
            intervalMs: normalizeInterval(retention.intervalMs, BARDWIKI_WORKER_RETENTION_SWEEP_INTERVAL_MS),
          }
  }

  get isRunning(): boolean {
    return this.active
  }

  get isProcessing(): boolean {
    return this.inFlight !== null
  }

  abortRunningJob(jobId: string): boolean {
    const controller = this.runningJobAbortControllers.get(jobId)
    if (!controller) return false
    controller.abort(new Error('BardWiki job cancelled'))
    return true
  }

  wake(): void {
    if (!this.active) return
    if (this.inFlight) {
      this.wakeRequested = true
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.schedule(0)
  }

  start(): void {
    if (this.active) return
    for (const job of recoverRunningBardWikiJobs(this.db, this.retry)) this.emitJob(job)
    this.runRetentionSweep()
    this.active = true
    this.schedule(0)
  }

  async stop(): Promise<void> {
    if (!this.active && this.timer === null && this.inFlight === null) return
    this.active = false
    this.wakeRequested = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.inFlight) await this.inFlight
  }

  async tick(): Promise<boolean> {
    if (this.inFlight) return false
    const lineage = getDatabaseLineage(this.db)
    if (lineage !== this.databaseLineage) {
      this.databaseLineage = lineage
      this.chatLastServedAt.clear()
      for (const job of recoverRunningBardWikiJobs(this.db, this.retry)) this.emitJob(job)
    }
    this.maybeRunRetentionSweep()
    const task = this.processOne()
    this.inFlight = task
    try {
      return await task
    } finally {
      this.inFlight = null
      if (this.active && this.wakeRequested) {
        this.wakeRequested = false
        if (this.timer) {
          clearTimeout(this.timer)
          this.timer = null
        }
        this.schedule(0)
      }
    }
  }

  private schedule(delayMs: number): void {
    if (!this.active || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      let didWork = false
      void this.tick()
        .then((result) => {
          didWork = result
        })
        .catch(this.onError)
        .finally(() => this.schedule(didWork ? 0 : this.pollIntervalMs))
    }, delayMs)
    this.timer.unref()
  }

  private claimNextJobFairly(): BardWikiJob | null {
    const pendingChatIds = listPendingBardWikiJobChatIds(
      this.db,
      this.retry.now === undefined ? {} : { now: this.retry.now },
    )
    if (pendingChatIds.length === 0) return null
    const live = new Set(pendingChatIds)
    for (const chatId of this.chatLastServedAt.keys()) {
      if (!live.has(chatId)) this.chatLastServedAt.delete(chatId)
    }
    let pick = pendingChatIds[0]
    let pickServedAt = this.chatLastServedAt.get(pick) ?? 0
    for (const chatId of pendingChatIds) {
      const servedAt = this.chatLastServedAt.get(chatId) ?? 0
      if (servedAt < pickServedAt) {
        pick = chatId
        pickServedAt = servedAt
      }
    }
    const job = claimNextBardWikiJob(
      this.db,
      this.retry.now === undefined ? { chatId: pick } : { chatId: pick, now: this.retry.now },
    )
    if (job) this.chatLastServedAt.set(pick, ++this.serveSequence)
    return job
  }

  private async processOne(): Promise<boolean> {
    const job = this.claimNextJobFairly()
    if (!job) return false
    const lineage = getDatabaseLineage(this.db)
    const current = () => getDatabaseLineage(this.db) === lineage
    const controller = new AbortController()
    this.runningJobAbortControllers.set(job.id, controller)
    this.emitJob(job)
    try {
      const handled = await this.handlers[job.kind](job, { signal: controller.signal })
      if (!current()) return true
      if (handled && typeof handled === 'object' && handled.outcome === 'rescheduled') {
        if (handled.job.id !== job.id || handled.job.status !== 'pending') {
          throw new BardWikiJobHandlerError('bardwiki_invalid_job', 'Handler returned an invalid rescheduled job', {
            retryable: false,
          })
        }
        this.emitJob(handled.job)
      } else {
        const completed = completeBardWikiJob(this.db, job.id)
        if (completed) this.emitJob(completed)
      }
    } catch (error) {
      if (!current()) return true
      const summary = error instanceof Error && error.message ? error.message : String(error)
      const code = error instanceof BardWikiJobHandlerError ? error.code : 'bardwiki_job_handler_failed'
      const next =
        error instanceof BardWikiJobHandlerError && !error.retryable
          ? failBardWikiJob(this.db, job.id, code, summary || 'BardWiki job handler failed')
          : retryOrFailBardWikiJob(this.db, job.id, code, summary || 'BardWiki job handler failed', this.retry)
      if (next) this.emitJob(next)
    } finally {
      if (this.runningJobAbortControllers.get(job.id) === controller) {
        this.runningJobAbortControllers.delete(job.id)
      }
    }
    return true
  }

  private maybeRunRetentionSweep(): void {
    if (!this.terminalRetention) return
    const nowMs = Date.now()
    if (nowMs - this.lastRetentionSweepAtMs >= this.terminalRetention.intervalMs) this.runRetentionSweep(nowMs)
  }

  private runRetentionSweep(nowMs = Date.now()): void {
    if (!this.terminalRetention) return
    try {
      pruneTerminalBardWikiJobs(this.db, this.terminalRetention)
      this.lastRetentionSweepAtMs = nowMs
    } catch (error) {
      this.onError(error)
    }
  }

  private emitJob(job: BardWikiJob): void {
    if (this.onEvent) emitMemoryEventSafely(this.onEvent, buildBardWikiJobEvent(job))
  }
}

function normalizeInterval(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback
}

function noopBardWikiJobHandler(): void {
  // Concrete analysis/reconciliation/rebuild handlers are installed by their owning phases.
}

function defaultBardWikiWorkerErrorHandler(error: unknown): void {
  console.error('BardWiki worker failed', error)
}
