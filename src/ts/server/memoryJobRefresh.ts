import type { ServerMemoryJob, ServerMemoryResult, ServerMemorySnapshotVersion } from '../process/request/serverMemory'
import { isTerminalMemoryJobStatus, recordTerminalMemoryJobUpdate } from './memoryJobOrdering'

const DEFAULT_REFRESH_INTERVAL_MS = 5000
const TERMINAL_JOB_HISTORY_LIMIT = 50

type TimerHandle = ReturnType<typeof setInterval>

export interface MemoryJobRefreshController {
  refresh(): Promise<void>
  applyJobUpdate(job: ServerMemoryJob): boolean
  setChatId(chatId: string): void
  dispose(): void
}

export interface MemoryJobRefreshControllerOptions {
  chatId: string
  intervalMs?: number
  listJobs: (
    chatId: string,
    signal?: AbortSignal | null,
    etag?: string,
  ) => Promise<ServerMemoryResult<{ jobs: ServerMemoryJob[] }>>
  onJobs(jobs: ServerMemoryJob[], loadedAt: string, snapshot?: ServerMemorySnapshotVersion): void
  onError(error: string): void
  onClear(): void
  onLoading(loading: boolean): void
  now?: () => Date
}

export function hasActiveMemoryJobs(jobs: readonly Pick<ServerMemoryJob, 'status'>[]): boolean {
  return jobs.some((job) => job.status === 'pending' || job.status === 'running')
}

export function createMemoryJobRefreshController(
  options: MemoryJobRefreshControllerOptions,
): MemoryJobRefreshController {
  const intervalMs = options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  const now = options.now ?? (() => new Date())
  let chatId = options.chatId
  let requestSerial = 0
  let inFlight = false
  let queued = false
  let disposed = false
  let refreshTimer: TimerHandle | null = null
  let activeController: AbortController | null = null
  let lastEtag: string | undefined
  let lastJobs: ServerMemoryJob[] = []
  let liveUpdateSerial = 0
  const liveUpdateSerials = new Map<string, number>()
  const terminalJobInstances = new Set<string>()

  function stopPolling(): void {
    if (!refreshTimer) return
    clearInterval(refreshTimer)
    refreshTimer = null
  }

  function syncPolling(jobs: readonly Pick<ServerMemoryJob, 'status'>[]): void {
    if (disposed || !chatId || !hasActiveMemoryJobs(jobs)) {
      stopPolling()
      return
    }
    if (refreshTimer) return
    refreshTimer = setInterval(() => {
      void refresh()
    }, intervalMs)
  }

  function recordTerminalJob(job: ServerMemoryJob): void {
    terminalJobInstances.add(jobKey(job))
    recordTerminalMemoryJobUpdate(job)
  }

  function normalizeJobs(jobs: readonly ServerMemoryJob[], requestUpdateFence: number): ServerMemoryJob[] {
    const nextJobs = new Map(
      lastJobs.filter((job) => isTerminalMemoryJobStatus(job.status)).map((job) => [jobKey(job), job]),
    )
    for (const job of jobs) {
      if (job.chatId !== chatId) continue
      const key = jobKey(job)
      if ((liveUpdateSerials.get(key) ?? 0) > requestUpdateFence) continue
      if (isTerminalMemoryJobStatus(job.status)) {
        recordTerminalJob(job)
        nextJobs.set(key, job)
      } else if (!terminalJobInstances.has(key)) {
        removeOlderLogicalJobInstances(nextJobs, job)
        nextJobs.set(key, job)
      }
    }
    for (const job of lastJobs) {
      if ((liveUpdateSerials.get(jobKey(job)) ?? 0) > requestUpdateFence) {
        nextJobs.set(jobKey(job), job)
      }
    }
    return boundTerminalHistory([...nextJobs.values()])
  }

  function boundTerminalHistory(jobs: readonly ServerMemoryJob[]): ServerMemoryJob[] {
    const active = jobs.filter((job) => !isTerminalMemoryJobStatus(job.status))
    const terminal = jobs
      .filter((job) => isTerminalMemoryJobStatus(job.status))
      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
      .slice(0, TERMINAL_JOB_HISTORY_LIMIT)
    return [...active, ...terminal]
  }

  function clearChatState(): void {
    lastEtag = undefined
    lastJobs = []
    liveUpdateSerials.clear()
    terminalJobInstances.clear()
  }

  function publishJobs(nextJobs: ServerMemoryJob[], snapshot?: ServerMemorySnapshotVersion): void {
    lastJobs = nextJobs
    const retainedKeys = new Set(nextJobs.map(jobKey))
    for (const key of liveUpdateSerials.keys()) {
      if (!retainedKeys.has(key)) liveUpdateSerials.delete(key)
    }
    terminalJobInstances.clear()
    for (const job of nextJobs) {
      if (isTerminalMemoryJobStatus(job.status)) terminalJobInstances.add(jobKey(job))
    }
    options.onJobs(nextJobs, now().toISOString(), snapshot)
    syncPolling(nextJobs)
  }

  function applyJobUpdate(job: ServerMemoryJob): boolean {
    if (disposed || !chatId || job.chatId !== chatId) return false

    const terminal = isTerminalMemoryJobStatus(job.status)
    if (terminal) {
      recordTerminalJob(job)
    } else if (terminalJobInstances.has(jobKey(job))) {
      return false
    }

    const updateSerial = ++liveUpdateSerial
    liveUpdateSerials.set(jobKey(job), updateSerial)
    const nextJobs = lastJobs.filter(
      (current) =>
        jobKey(current) !== jobKey(job) &&
        !(isActiveMemoryJobStatus(current.status) && current.id === job.id && current.instanceId !== job.instanceId),
    )
    nextJobs.push(job)
    publishJobs(boundTerminalHistory(nextJobs))
    return true
  }

  async function refresh(): Promise<void> {
    if (disposed) return
    if (!chatId) {
      requestSerial += 1
      queued = false
      clearChatState()
      activeController?.abort()
      activeController = null
      inFlight = false
      stopPolling()
      options.onLoading(false)
      options.onClear()
      return
    }

    if (inFlight) {
      queued = true
      return
    }

    const serial = ++requestSerial
    const requestUpdateFence = liveUpdateSerial
    const controller = new AbortController()
    activeController = controller
    inFlight = true
    options.onLoading(true)

    try {
      const result = await options.listJobs(chatId, controller.signal, lastEtag)
      if (disposed || serial !== requestSerial) return

      if (result.status === 'ok') {
        lastEtag = result.etag
        publishJobs(normalizeJobs(result.jobs, requestUpdateFence), result.memorySnapshot)
      } else if (result.status === 'not-modified') {
        lastEtag = result.etag ?? lastEtag
        publishJobs(normalizeJobs(lastJobs, requestUpdateFence), result.memorySnapshot)
      } else {
        syncPolling(lastJobs)
        options.onError(result.status === 'unavailable' ? 'Server memory jobs are unavailable.' : result.error)
      }
    } catch (err) {
      if (disposed || serial !== requestSerial || controller.signal.aborted) return
      syncPolling(lastJobs)
      const message = err instanceof Error ? err.message : String(err)
      options.onError(`Network error: ${message}`)
    } finally {
      if (serial === requestSerial) {
        activeController = null
        inFlight = false
        options.onLoading(false)
        if (queued && !disposed) {
          queued = false
          void refresh()
        }
      }
    }
  }

  function setChatId(nextChatId: string): void {
    if (nextChatId === chatId) return
    chatId = nextChatId
    requestSerial += 1
    queued = false
    clearChatState()
    activeController?.abort()
    activeController = null
    inFlight = false
    stopPolling()
    void refresh()
  }

  function dispose(): void {
    disposed = true
    queued = false
    activeController?.abort()
    activeController = null
    stopPolling()
  }

  return {
    refresh,
    applyJobUpdate,
    setChatId,
    dispose,
  }
}

function jobKey(job: Pick<ServerMemoryJob, 'chatId' | 'instanceId'>): string {
  return `${job.chatId}\u0000${job.instanceId}`
}

function isActiveMemoryJobStatus(status: ServerMemoryJob['status']): boolean {
  return status === 'pending' || status === 'running'
}

function removeOlderLogicalJobInstances(
  jobs: Map<string, ServerMemoryJob>,
  replacement: Pick<ServerMemoryJob, 'chatId' | 'id' | 'instanceId'>,
): void {
  for (const [key, job] of jobs) {
    if (
      isActiveMemoryJobStatus(job.status) &&
      job.chatId === replacement.chatId &&
      job.id === replacement.id &&
      job.instanceId !== replacement.instanceId
    ) {
      jobs.delete(key)
    }
  }
}
