export const CHAT_DISPLAY_SCHEDULER = Symbol('chat-display-scheduler')

type Job = { key?: string; start(): Promise<void>; cancel(): void }
type Priority = 'critical' | 'normal' | 'background'
type BatchJob = {
  key?: string
  priority: Priority
  start(priority: Priority, prepared: () => void): Promise<void>
  cancel(): void
}

/** Batch server input preparation; retain serial idle parsing for browser-only work. */
export function createChatDisplayScheduler(
  schedule: (run: () => void) => () => void = scheduleIdleDisplay,
  collect: (scope: string) => () => void = () => () => {},
) {
  let scope: string | null = null
  let paused = true
  let destroyed = false
  let generation = 0
  let running = false
  let cancelScheduled: (() => void) | undefined
  const jobs: Job[] = []
  let visible = new Set<string>()
  let nearest: readonly string[] = []
  const batchJobs: BatchJob[] = []
  const runningBatchJobs = new Set<BatchJob>()
  let batchScheduled = false

  const drainBatch = () => {
    if (destroyed || batchScheduled || batchJobs.length === 0 || runningBatchJobs.size >= 64) return
    batchScheduled = true
    // A Svelte mount registers a window's rows in one turn. Start their input
    // preparation together; network completion does not gate sibling admission.
    queueMicrotask(() => {
      batchScheduled = false
      if (destroyed) return
      const rank = (job: BatchJob) =>
        job.priority === 'critical' ? -1 : job.key && nearest.includes(job.key) ? nearest.indexOf(job.key) : Infinity
      batchJobs.sort((a, b) => rank(a) - rank(b))
      const jobs = batchJobs.splice(0, Math.max(0, 64 - runningBatchJobs.size))
      if (!jobs.length) return
      const release = collect(scope ?? '')
      let preparing = jobs.length
      const criticalKeys = new Set(jobs.filter((job) => job.priority === 'critical').map((job) => job.key))
      for (const job of jobs) {
        if (criticalKeys.size >= 3) break
        criticalKeys.add(job.key)
      }
      for (const job of jobs) {
        let prepared = false
        const ready = () => {
          if (prepared) return
          prepared = true
          if (--preparing === 0) release()
        }
        runningBatchJobs.add(job)
        void job.start(criticalKeys.has(job.key) ? 'critical' : job.priority, ready).finally(() => {
          ready()
          runningBatchJobs.delete(job)
          drainBatch()
        })
      }
      if (batchJobs.length) setTimeout(drainBatch, 0)
    })
  }

  const drain = () => {
    if (destroyed || paused || running || cancelScheduled || jobs.length === 0) return
    cancelScheduled = schedule(() => {
      cancelScheduled = undefined
      if (destroyed || paused) return
      const visibleIndex = jobs.findIndex((candidate) => candidate.key && visible.has(candidate.key))
      const [job] = jobs.splice(visibleIndex >= 0 ? visibleIndex : 0, 1)
      if (!job) return
      running = true
      const startedGeneration = generation
      void job.start().finally(() => {
        if (startedGeneration !== generation) return
        running = false
        drain()
      })
    })
  }
  const clear = () => {
    generation += 1
    running = false
    cancelScheduled?.()
    cancelScheduled = undefined
    for (const job of jobs.splice(0)) job.cancel()
    for (const job of batchJobs.splice(0)) job.cancel()
    for (const job of runningBatchJobs) job.cancel()
    runningBatchJobs.clear()
  }

  return {
    setScope(next: string | null) {
      if (scope === next) return
      clear()
      scope = next
      paused = true
      visible.clear()
      nearest = []
    },
    setPaused(next: boolean) {
      paused = next
      if (paused) {
        cancelScheduled?.()
        cancelScheduled = undefined
      } else drain()
    },
    setVisible(keys: readonly string[]) {
      visible = new Set(keys)
      drain()
    },
    setNearest(keys: readonly string[]) {
      nearest = keys
    },
    runBatch<T>(
      work: (priority: Priority, prepared: () => void) => Promise<T>,
      signal: AbortSignal,
      key: string | undefined,
      priority: Priority,
    ): Promise<T | undefined> {
      if (destroyed || signal.aborted) return Promise.resolve(undefined)
      return new Promise((resolve, reject) => {
        const cancel = () => {
          const index = batchJobs.indexOf(job)
          if (index >= 0) batchJobs.splice(index, 1)
          signal.removeEventListener('abort', cancel)
          resolve(undefined)
        }
        const job: BatchJob = {
          key,
          priority,
          cancel,
          async start(nextPriority, prepared) {
            if (signal.aborted) {
              prepared()
              cancel()
              return
            }
            try {
              resolve(await work(nextPriority, prepared))
            } catch (error) {
              reject(error)
            } finally {
              signal.removeEventListener('abort', cancel)
            }
          },
        }
        signal.addEventListener('abort', cancel, { once: true })
        batchJobs.push(job)
        drainBatch()
      })
    },
    run<T>(work: () => Promise<T>, signal: AbortSignal, key?: string): Promise<T | undefined> {
      if (destroyed || signal.aborted) return Promise.resolve(undefined)
      return new Promise((resolve, reject) => {
        const cancel = () => {
          const index = jobs.indexOf(job)
          if (index >= 0) jobs.splice(index, 1)
          signal.removeEventListener('abort', cancel)
          resolve(undefined)
        }
        const job: Job = {
          key,
          cancel,
          async start() {
            signal.removeEventListener('abort', cancel)
            if (signal.aborted) return resolve(undefined)
            try {
              const result = await work()
              resolve(signal.aborted ? undefined : result)
            } catch (error) {
              reject(error)
            }
          },
        }
        signal.addEventListener('abort', cancel, { once: true })
        jobs.push(job)
        drain()
      })
    },
    destroy() {
      destroyed = true
      clear()
    },
  }
}

export type ChatDisplayScheduler = ReturnType<typeof createChatDisplayScheduler>

function scheduleIdleDisplay(run: () => void): () => void {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 100 })
    return () => window.cancelIdleCallback(id)
  }
  const id = setTimeout(run, 16)
  return () => clearTimeout(id)
}
