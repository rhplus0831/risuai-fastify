import { get, writable } from 'svelte/store'
import type { ActiveMessageTranslation } from './bootstrap'

const ACTIVE_MESSAGE_TRANSLATION_REFRESH_MS = 5_000

/**
 * Message translations still running server-side, as surfaced by bootstrap.
 * Unlike generation jobs there is no stream to reattach to; rows use this only
 * to preserve their spinner/disabled state across a page refresh.
 */
export const activeMessageTranslations = writable<ActiveMessageTranslation[]>([])

let refreshWired = false
let refreshGeneration = 0
let refreshInFlight = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let stopRefreshSubscription: (() => void) | null = null
const locallyStartedTranslationJobIds = new Set<string>()

export function setActiveMessageTranslations(jobs: readonly ActiveMessageTranslation[]): void {
  const remote = [...jobs]
  const remoteMessageIds = new Set(remote.map((job) => job.messageId))
  for (const job of remote) {
    if (locallyStartedTranslationJobIds.has(job.jobId)) locallyStartedTranslationJobIds.delete(job.jobId)
  }
  activeMessageTranslations.update((current) => [
    ...remote,
    ...current.filter(
      (job) =>
        job.status === 'running' &&
        locallyStartedTranslationJobIds.has(job.jobId) &&
        !remoteMessageIds.has(job.messageId),
    ),
  ])
}

/** Atomically publish a locally started request so every mounted row sees it. */
export function beginActiveMessageTranslation(job: ActiveMessageTranslation & { status: 'running' }): boolean {
  let started = false
  activeMessageTranslations.update((jobs) => {
    if (jobs.some((candidate) => candidate.messageId === job.messageId && candidate.status === 'running')) {
      return jobs
    }
    started = true
    locallyStartedTranslationJobIds.add(job.jobId)
    return [...jobs.filter((candidate) => candidate.messageId !== job.messageId), job]
  })
  return started
}

/** Publish a terminal server-owned job unless a different, newer job is running for the row. */
export function publishSettledMessageTranslation(
  job: ActiveMessageTranslation & { status: 'succeeded' | 'failed' },
): void {
  activeMessageTranslations.update((jobs) => {
    const current = jobs.find((candidate) => candidate.messageId === job.messageId)
    if (current?.status === 'running' && current.jobId !== job.jobId) return jobs
    locallyStartedTranslationJobIds.delete(job.jobId)
    return [...jobs.filter((candidate) => candidate.messageId !== job.messageId), job]
  })
}

export function isCurrentMessageTranslationJob(messageId: string, jobId: string): boolean {
  return get(activeMessageTranslations).some(
    (job) => job.messageId === messageId && job.jobId === jobId && job.status === 'running',
  )
}

export function clearActiveMessageTranslation(messageId: string): void {
  activeMessageTranslations.update((jobs) => {
    for (const job of jobs) {
      if (job.messageId === messageId) locallyStartedTranslationJobIds.delete(job.jobId)
    }
    return jobs.filter((job) => job.messageId !== messageId)
  })
}

export function clearMessageTranslationJob(jobId: string): void {
  locallyStartedTranslationJobIds.delete(jobId)
  activeMessageTranslations.update((jobs) => jobs.filter((job) => job.jobId !== jobId))
}

export function startActiveMessageTranslationRefresh(): void {
  if (refreshWired) return
  refreshWired = true
  stopRefreshSubscription = activeMessageTranslations.subscribe(scheduleActiveMessageTranslationRefresh)
}

export function stopActiveMessageTranslationRefresh(): void {
  refreshWired = false
  refreshGeneration += 1
  refreshInFlight = false
  stopRefreshSubscription?.()
  stopRefreshSubscription = null
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function scheduleActiveMessageTranslationRefresh(jobs: readonly ActiveMessageTranslation[]): void {
  if (!jobs.some((job) => job.status === 'running')) {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = null
    return
  }
  if (!refreshWired || refreshInFlight || refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshActiveMessageTranslations()
  }, ACTIVE_MESSAGE_TRANSLATION_REFRESH_MS)
}

async function refreshActiveMessageTranslations(): Promise<void> {
  if (!refreshWired || refreshInFlight) return
  const generation = refreshGeneration
  const jobsAtStart = get(activeMessageTranslations)
  if (!jobsAtStart.some((job) => job.status === 'running')) return
  refreshInFlight = true
  try {
    const { fetchServerBootstrapReadOnly } = await import('./bootstrap')
    if (!refreshWired || generation !== refreshGeneration) return
    const bootstrap = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
    // A command receipt, newer snapshot or UI settlement owns any intervening
    // change. A retired reader also cannot publish into its replacement.
    if (
      refreshWired &&
      generation === refreshGeneration &&
      get(activeMessageTranslations) === jobsAtStart &&
      bootstrap.status === 'ok'
    ) {
      setActiveMessageTranslations(bootstrap.bootstrap.activeMessageTranslations ?? [])
    }
  } catch (error) {
    console.warn('Message translation pending refresh failed', error)
  } finally {
    if (generation === refreshGeneration) {
      refreshInFlight = false
      if (refreshWired) scheduleActiveMessageTranslationRefresh(get(activeMessageTranslations))
    }
  }
}
