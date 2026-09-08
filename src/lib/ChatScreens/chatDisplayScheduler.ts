export const CHAT_DISPLAY_SCHEDULER = Symbol('chat-display-scheduler')

type Job = { key?: string; start(): Promise<void>; cancel(): void }

/** Older rows run one at a time, yielding to input/paint between parses. */
export function createChatDisplayScheduler(schedule: (run: () => void) => () => void = scheduleIdleDisplay) {
  let scope: string | null = null
  let paused = true
  let destroyed = false
  let generation = 0
  let running = false
  let cancelScheduled: (() => void) | undefined
  const jobs: Job[] = []
  let visible = new Set<string>()

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
  }

  return {
    setScope(next: string | null) {
      if (scope === next) return
      clear()
      scope = next
      paused = true
      visible.clear()
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
