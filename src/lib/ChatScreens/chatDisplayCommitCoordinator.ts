export const CHAT_DISPLAY_COMMIT_COORDINATOR = Symbol('chat-display-commit-coordinator')
export const CHAT_DISPLAY_SCROLL_IDLE_MS = 140
export const CHAT_DISPLAY_ANCHOR_GRACE_MS = 1_500
export const CHAT_DISPLAY_IDLE_COMMIT_BATCH = 4

interface PendingCommit {
  key: string
  apply: () => void
  preserveAnchor: boolean
  signal?: AbortSignal
  abort?: () => void
}

interface ChatDisplayCommitCoordinatorOptions {
  applyBatch(commits: readonly (() => void)[], preserveAnchor: boolean): void
  scheduleIdle?: (run: () => void) => () => void
  scheduleFrame?: (run: () => void) => () => void
  batchSize?: number
}

interface ChatDisplayCommitOptions {
  signal?: AbortSignal
  /** Initial bodies and held-height releases must be anchored even after idle. */
  preserveAnchor?: boolean
}

/**
 * Owns the interval between asynchronous body completion and its DOM commit.
 * Off-screen results wait through wheel/touch momentum; visible results can
 * commit immediately, and the remainder flush in bounded idle batches.
 */
export function createChatDisplayCommitCoordinator(options: ChatDisplayCommitCoordinatorOptions) {
  const scheduleIdle = options.scheduleIdle ?? scheduleDisplayIdle
  const scheduleFrame = options.scheduleFrame ?? scheduleDisplayFrame
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? CHAT_DISPLAY_IDLE_COMMIT_BATCH))
  const pending = new Map<string, PendingCommit>()
  let visible = new Set<string>()
  let interacting = false
  let preserveAnchorUntil = 0
  let destroyed = false
  let cancelIdle: (() => void) | undefined
  let cancelFrame: (() => void) | undefined

  const detach = (job: PendingCommit) => {
    if (job.abort) job.signal?.removeEventListener('abort', job.abort)
  }
  const remove = (job: PendingCommit) => {
    if (pending.get(job.key) === job) pending.delete(job.key)
    detach(job)
  }
  const apply = (jobs: PendingCommit[]) => {
    const current = jobs.filter((job) => !job.signal?.aborted && pending.get(job.key) === job)
    for (const job of jobs) remove(job)
    if (current.length > 0) {
      options.applyBatch(
        current.map((job) => job.apply),
        current.some((job) => job.preserveAnchor),
      )
    }
  }
  const eligible = () => [...pending.values()].filter((job) => !interacting || visible.has(job.key)).slice(0, batchSize)
  const scheduleFlush = () => {
    if (destroyed || cancelFrame || eligible().length === 0) return
    cancelFrame = scheduleFrame(() => {
      cancelFrame = undefined
      if (destroyed) return
      apply(eligible())
      scheduleFlush()
    })
  }
  const armIdle = () => {
    cancelIdle?.()
    cancelIdle = scheduleIdle(() => {
      cancelIdle = undefined
      interacting = false
      scheduleFlush()
    })
  }
  const clear = () => {
    cancelIdle?.()
    cancelFrame?.()
    cancelIdle = undefined
    cancelFrame = undefined
    for (const job of pending.values()) detach(job)
    pending.clear()
    visible.clear()
    interacting = false
    preserveAnchorUntil = 0
  }

  return {
    commit(key: string, applyCommit: () => void, commitOptions: ChatDisplayCommitOptions = {}) {
      const { signal } = commitOptions
      if (destroyed || signal?.aborted) return
      const previous = pending.get(key)
      if (previous) remove(previous)
      const job: PendingCommit = {
        key,
        apply: applyCommit,
        preserveAnchor: commitOptions.preserveAnchor === true || interacting || Date.now() <= preserveAnchorUntil,
        signal,
      }
      if (signal) {
        job.abort = () => remove(job)
        signal.addEventListener('abort', job.abort, { once: true })
      }
      pending.set(key, job)
      // Always enter through a frame callback. A ChatBody can settle while a
      // keyed row is being torn down, when Svelte forbids synchronous flushes.
      scheduleFlush()
    },
    noteInteraction() {
      if (destroyed) return
      interacting = true
      preserveAnchorUntil = Date.now() + CHAT_DISPLAY_ANCHOR_GRACE_MS
      armIdle()
    },
    noteScroll() {
      if (!destroyed && interacting) armIdle()
    },
    setVisible(keys: readonly string[]) {
      if (destroyed) return
      visible = new Set(keys)
      scheduleFlush()
    },
    reset() {
      clear()
    },
    destroy() {
      destroyed = true
      clear()
    },
    get interacting() {
      return interacting
    },
    get pending() {
      return pending.size
    },
  }
}

export type ChatDisplayCommitCoordinator = ReturnType<typeof createChatDisplayCommitCoordinator>

function scheduleDisplayIdle(run: () => void): () => void {
  const id = setTimeout(run, CHAT_DISPLAY_SCROLL_IDLE_MS)
  return () => clearTimeout(id)
}

function scheduleDisplayFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(run)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(run, 0)
  return () => clearTimeout(id)
}
