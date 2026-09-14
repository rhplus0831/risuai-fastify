import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { JobRegistry, type JobRegistryOptions, type StreamJob } from './streamJobs.js'

export interface ActiveGenerationJobProjection {
  chatId: string
  jobId: string
  mode?: 'send' | 'continue' | 'regenerate'
  continueDisposition?: 'append' | 'extend'
  regenerateMessageId?: string
  databaseLineage?: string
  operationId?: string
  writerSessionId?: string
  writerEpoch?: number
  operationStateVersion?: number
  projectionEpoch?: number
  attemptNo?: number
  acceptedMessageId?: string
  targetMessageId?: string
}

/**
 * Durable-generation job registry.
 *
 * Wraps the proxy's reconnectable {@link JobRegistry} with the two primitives
 * durable generation adds:
 *
 * 1. a transient **`chatId → jobId` index** for the *running* job per chat — the
 *    submission lock ("one running job per chat"), cleared at completion/cancel
 *    (not at GC) so the user's next send isn't blocked during the 30s reattach
 *    grace; and
 * 2. an **`activeGenerationJobs` projection** surfaced by bootstrap so a returning
 *    client — even after a full reload — discovers and reattaches to a running
 *    generation.
 *
 * Job authority remains process-local (no `db.json`) and separate from the
 * proxy registry. Oversized terminal payload bytes may live in an ephemeral
 * file side channel for the same retention window; those files are replay
 * transport state, not durable generation authority.
 */
export class GenerationJobRegistry {
  readonly registry: JobRegistry
  private readonly runningByChat = new Map<string, string>()
  private readonly runners = new Set<Promise<void>>()

  constructor(dataDir?: string, options: Omit<JobRegistryOptions, 'replaySnapshotDir'> = {}) {
    this.registry = new JobRegistry({
      ...options,
      ...(dataDir ? { replaySnapshotDir: path.join(dataDir, 'runtime', `generation-replay-${randomUUID()}`) } : {}),
    })
  }

  /**
   * Track a detached runner so shutdown can wait for it.
   * `onClose` aborts every job and then settles the runners *before* closing
   * the SQLite handle, so an in-flight cancel-persist still writes to an open
   * database instead of racing `db.close()`.
   */
  trackRunner(runner: Promise<void>): void {
    const tracked = runner.catch(() => {
      // The runner has its own terminal handling; tracking must never reject.
    })
    this.runners.add(tracked)
    void tracked.finally(() => {
      this.runners.delete(tracked)
    })
  }

  /** Wait until every tracked detached runner has settled. */
  async settleRunners(): Promise<void> {
    while (this.runners.size > 0) {
      await Promise.all([...this.runners])
    }
  }

  /** Gracefully finish every attached SSE viewer before HTTP connection drain. */
  async closeViewers(): Promise<void> {
    const closed: Promise<void>[] = []
    for (const job of this.registry.list()) {
      for (const client of [...job.clients]) {
        client.close()
        if (client.closeSettled) closed.push(client.closeSettled)
      }
    }
    await Promise.all(closed)
  }

  /**
   * The currently *running* (not done) job for a chat, if any. A completed,
   * uncollected job does not count — the submission lock releases at completion so the
   * next send is accepted during the reattach grace.
   */
  runningJobForChat(chatId: string): StreamJob | undefined {
    const jobId = this.runningByChat.get(chatId)
    if (!jobId) return undefined
    const job = this.registry.get(jobId)
    if (!job || job.done) {
      // Stale index entry (job GC'd, or completed and uncleared): prune + report free.
      this.runningByChat.delete(chatId)
      return undefined
    }
    return job
  }

  hasRunningJob(chatId: string): boolean {
    return this.runningJobForChat(chatId) !== undefined
  }

  /** Claim the submission lock for `chatId` with the freshly created job. */
  register(chatId: string, jobId: string): void {
    this.runningByChat.set(chatId, jobId)
  }

  /**
   * Release the submission lock at completion/cancel. Guarded on the jobId so a
   * stale clear (from a job that already lost the slot to a newer one) is a no-op.
   */
  clearRunning(chatId: string, jobId: string): void {
    if (this.runningByChat.get(chatId) === jobId) {
      this.runningByChat.delete(chatId)
    }
  }

  /**
   * The transient projection for bootstrap: the chats with a *running* job. Shaped
   * `{ chatId, jobId, mode?, regenerateMessageId? }` so the wire shape is explicit
   * and does not collide with persisted `database` fields. `mode` (+ the regenerate
   * target) lets a reloaded browser reattach with the right generating mode. Done /
   * GC'd jobs are filtered out.
   */
  activeJobs(): ActiveGenerationJobProjection[] {
    const out: ActiveGenerationJobProjection[] = []
    for (const [chatId, jobId] of this.runningByChat.entries()) {
      const job = this.registry.get(jobId)
      if (job && !job.done) {
        out.push({
          chatId,
          jobId,
          ...(job.mode ? { mode: job.mode } : {}),
          ...(job.continueDisposition ? { continueDisposition: job.continueDisposition } : {}),
          ...(job.regenerateMessageId ? { regenerateMessageId: job.regenerateMessageId } : {}),
          ...(job.databaseLineage ? { databaseLineage: job.databaseLineage } : {}),
          ...(job.operationId ? { operationId: job.operationId } : {}),
          ...(job.writerSessionId ? { writerSessionId: job.writerSessionId } : {}),
          ...(job.writerEpoch !== undefined ? { writerEpoch: job.writerEpoch } : {}),
          ...(job.operationStateVersion !== undefined ? { operationStateVersion: job.operationStateVersion } : {}),
          ...(job.projectionEpoch !== undefined ? { projectionEpoch: job.projectionEpoch } : {}),
          ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
          ...(job.acceptedMessageId ? { acceptedMessageId: job.acceptedMessageId } : {}),
          ...(job.targetMessageId ? { targetMessageId: job.targetMessageId } : {}),
        })
      }
    }
    return out
  }

  /** Tick the underlying GC and prune index entries whose job is done / gone. */
  tickGc(now?: number): void {
    this.registry.tickGc(now)
    for (const [chatId, jobId] of this.runningByChat.entries()) {
      const job = this.registry.get(jobId)
      if (!job || job.done) this.runningByChat.delete(chatId)
    }
  }
}
