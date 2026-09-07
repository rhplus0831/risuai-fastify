import { derived, writable } from 'svelte/store'
import type { ServerMemoryJob } from '../process/request/serverMemory'
import type { ServerMemoryEvent, ServerMemoryJobSnapshot } from './events'

export const MEMORY_JOB_TERMINAL_PROJECTION_LIMIT = 200

interface ProjectedMemoryJob extends ServerMemoryJob {
  source: 'server' | 'local'
  eventVersion: number
  retainedAt: number
}

export interface MemoryJobProjectionState {
  streamId: string | null
  version: number
  jobsByInstance: Record<string, ProjectedMemoryJob>
  nextRetainedAt: number
}

export interface MemoryProgressProjection {
  allActiveJobs: ServerMemoryJob[]
  presentedJobs: ServerMemoryJob[]
  openChatJobs: ServerMemoryJob[]
  backgroundJobs: ServerMemoryJob[]
  activeCount: number
  presentedCount: number
  backgroundCount: number
}

export interface LocalMemoryJobHandle {
  id: string
  instanceId: string
  chatId: string
  kind: ServerMemoryJob['kind']
}

let localInstanceSequence = 0

function initialState(): MemoryJobProjectionState {
  return {
    streamId: null,
    version: 0,
    jobsByInstance: {},
    nextRetainedAt: 0,
  }
}

export const memoryJobProjectionStore = writable<MemoryJobProjectionState>(initialState())

export const activeMemoryJobsStore = derived(memoryJobProjectionStore, (state) => selectActiveMemoryJobs(state))

export function memoryJobInstanceKey(job: Pick<ServerMemoryJob, 'chatId' | 'instanceId'>): string {
  return `${job.chatId}\u0000${job.instanceId}`
}

export function isActiveMemoryJob(job: Pick<ServerMemoryJob, 'status'>): boolean {
  return job.status === 'pending' || job.status === 'running'
}

export function applyServerMemoryJobEvent(event: ServerMemoryEvent): boolean {
  let accepted = false
  memoryJobProjectionStore.update((current) => {
    let state = current
    if (state.streamId !== event.streamId) {
      state = {
        ...state,
        streamId: event.streamId,
        version: 0,
        jobsByInstance: Object.fromEntries(
          Object.entries(state.jobsByInstance).filter(([, job]) => job.source === 'local' || !isActiveMemoryJob(job)),
        ),
      }
    }
    if (event.version <= state.version) return state

    const job: ServerMemoryJob = { chatId: event.chatId, ...event.job }
    const key = memoryJobInstanceKey(job)
    const existing = state.jobsByInstance[key]
    if (existing && !isActiveMemoryJob(existing) && isActiveMemoryJob(job)) {
      return { ...state, version: event.version }
    }

    const jobsByInstance = { ...state.jobsByInstance }
    if (isActiveMemoryJob(job)) {
      removeOlderLogicalJobInstances(jobsByInstance, job)
    }
    jobsByInstance[key] = {
      ...job,
      source: 'server',
      eventVersion: event.version,
      retainedAt: state.nextRetainedAt + 1,
    }
    accepted = true
    return boundTerminalJobs({
      ...state,
      version: event.version,
      jobsByInstance,
      nextRetainedAt: state.nextRetainedAt + 1,
    })
  })
  return accepted
}

export function applyServerMemoryJobSnapshot(snapshot: ServerMemoryJobSnapshot): boolean {
  let accepted = false
  memoryJobProjectionStore.update((current) => {
    const sameStream = current.streamId === snapshot.streamId
    if (sameStream && snapshot.version < current.version) return current
    const jobsByInstance: Record<string, ProjectedMemoryJob> = {}

    for (const [key, job] of Object.entries(current.jobsByInstance)) {
      if (job.source === 'local' || !isActiveMemoryJob(job) || (sameStream && job.eventVersion > snapshot.version)) {
        jobsByInstance[key] = job
      }
    }

    let nextRetainedAt = current.nextRetainedAt
    for (const job of snapshot.jobs) {
      if (!isActiveMemoryJob(job)) continue
      const key = memoryJobInstanceKey(job)
      const newer = jobsByInstance[key]
      if (newer && newer.eventVersion > snapshot.version) continue
      if (newer && !isActiveMemoryJob(newer)) continue
      removeOlderLogicalJobInstances(jobsByInstance, job)
      jobsByInstance[key] = {
        ...job,
        source: 'server',
        eventVersion: snapshot.version,
        retainedAt: ++nextRetainedAt,
      }
    }

    accepted = true
    return boundTerminalJobs({
      streamId: snapshot.streamId,
      version: sameStream ? Math.max(current.version, snapshot.version) : snapshot.version,
      jobsByInstance,
      nextRetainedAt,
    })
  })
  return accepted
}

export function replaceMemoryJobsForChat(
  chatId: string,
  jobs: readonly ServerMemoryJob[],
  snapshot?: { streamId: string; version: number },
): void {
  memoryJobProjectionStore.update((current) => {
    const sameStream = snapshot !== undefined && current.streamId === snapshot.streamId
    const snapshotVersion = snapshot?.version ?? current.version
    const jobsByInstance: Record<string, ProjectedMemoryJob> = {}
    for (const [key, job] of Object.entries(current.jobsByInstance)) {
      if (job.chatId !== chatId || job.source === 'local' || (sameStream && job.eventVersion > snapshotVersion)) {
        jobsByInstance[key] = job
      }
    }

    let nextRetainedAt = current.nextRetainedAt
    for (const job of jobs) {
      if (job.chatId !== chatId) continue
      const key = memoryJobInstanceKey(job)
      const newer = jobsByInstance[key]
      if (newer && sameStream && newer.eventVersion > snapshotVersion) continue
      if (newer && !isActiveMemoryJob(newer) && isActiveMemoryJob(job)) continue
      if (isActiveMemoryJob(job)) removeOlderLogicalJobInstances(jobsByInstance, job)
      jobsByInstance[key] = {
        ...job,
        source: 'server',
        eventVersion: snapshotVersion,
        retainedAt: ++nextRetainedAt,
      }
    }

    return boundTerminalJobs({
      streamId: snapshot?.streamId ?? current.streamId,
      version: snapshot ? (sameStream ? Math.max(current.version, snapshotVersion) : snapshotVersion) : current.version,
      jobsByInstance,
      nextRetainedAt,
    })
  })
}

export function selectMemoryJobs(state: MemoryJobProjectionState): ServerMemoryJob[] {
  return Object.values(state.jobsByInstance).sort(compareProjectedJobs).map(stripProjectionFields)
}

export function startLocalMemoryJob(input: { chatId: string; kind: ServerMemoryJob['kind'] }): LocalMemoryJobHandle {
  const instanceId = `local-${Date.now().toString(36)}-${(++localInstanceSequence).toString(36)}`
  const handle: LocalMemoryJobHandle = {
    id: `local-${input.kind}-${instanceId}`,
    instanceId,
    chatId: input.chatId,
    kind: input.kind,
  }
  updateLocalMemoryJob(handle, 'running')
  return handle
}

export function updateLocalMemoryJob(
  handle: LocalMemoryJobHandle,
  status: ServerMemoryJob['status'],
  error?: string,
): void {
  memoryJobProjectionStore.update((state) => {
    const job: ServerMemoryJob = {
      ...handle,
      status,
      attemptCount: 1,
      maxAttempts: 1,
      updatedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    }
    const jobsByInstance = { ...state.jobsByInstance }
    jobsByInstance[memoryJobInstanceKey(job)] = {
      ...job,
      source: 'local',
      eventVersion: state.version,
      retainedAt: state.nextRetainedAt + 1,
    }
    return boundTerminalJobs({
      ...state,
      jobsByInstance,
      nextRetainedAt: state.nextRetainedAt + 1,
    })
  })
}

export function selectActiveMemoryJobs(state: MemoryJobProjectionState): ServerMemoryJob[] {
  return selectMemoryJobs(state).filter(isActiveMemoryJob)
}

export function selectMemoryJobsForChat(state: MemoryJobProjectionState, chatId: string): ServerMemoryJob[] {
  return selectMemoryJobs(state).filter((job) => job.chatId === chatId)
}

export function selectMemoryProgress(
  state: MemoryJobProjectionState,
  openChatId: string | null,
  openChatOnly: boolean,
): MemoryProgressProjection {
  const allActiveJobs = selectActiveMemoryJobs(state)
  const openChatJobs = openChatId ? allActiveJobs.filter((job) => job.chatId === openChatId) : []
  const backgroundJobs = openChatId ? allActiveJobs.filter((job) => job.chatId !== openChatId) : allActiveJobs
  const presentedJobs = openChatOnly ? openChatJobs : allActiveJobs
  return {
    allActiveJobs,
    presentedJobs,
    openChatJobs,
    backgroundJobs,
    activeCount: allActiveJobs.length,
    presentedCount: presentedJobs.length,
    backgroundCount: openChatOnly ? backgroundJobs.length : 0,
  }
}

/** Discard authenticated job projections when their auth or database scope changes. */
export function resetMemoryJobProjection(): void {
  memoryJobProjectionStore.set(initialState())
}

export function resetMemoryJobProjectionForTests(): void {
  resetMemoryJobProjection()
}

function removeOlderLogicalJobInstances(
  jobsByInstance: Record<string, ProjectedMemoryJob>,
  job: Pick<ServerMemoryJob, 'chatId' | 'id' | 'instanceId'>,
): void {
  for (const [key, current] of Object.entries(jobsByInstance)) {
    if (
      isActiveMemoryJob(current) &&
      current.chatId === job.chatId &&
      current.id === job.id &&
      current.instanceId !== job.instanceId
    ) {
      delete jobsByInstance[key]
    }
  }
}

function boundTerminalJobs(state: MemoryJobProjectionState): MemoryJobProjectionState {
  const terminal = Object.entries(state.jobsByInstance)
    .filter(([, job]) => !isActiveMemoryJob(job))
    .sort((left, right) => right[1].retainedAt - left[1].retainedAt)
  if (terminal.length <= MEMORY_JOB_TERMINAL_PROJECTION_LIMIT) return state
  const jobsByInstance = { ...state.jobsByInstance }
  for (const [key] of terminal.slice(MEMORY_JOB_TERMINAL_PROJECTION_LIMIT)) delete jobsByInstance[key]
  return { ...state, jobsByInstance }
}

function compareProjectedJobs(left: ProjectedMemoryJob, right: ProjectedMemoryJob): number {
  const leftActive = isActiveMemoryJob(left)
  const rightActive = isActiveMemoryJob(right)
  if (leftActive !== rightActive) return leftActive ? -1 : 1
  if (!leftActive && !rightActive) return right.retainedAt - left.retainedAt
  const chatDiff = left.chatId.localeCompare(right.chatId)
  if (chatDiff !== 0) return chatDiff
  const statusDiff = activeStatusRank(left.status) - activeStatusRank(right.status)
  if (statusDiff !== 0) return statusDiff
  return left.id.localeCompare(right.id)
}

function activeStatusRank(status: ServerMemoryJob['status']): number {
  return status === 'running' ? 0 : status === 'pending' ? 1 : 2
}

function stripProjectionFields(job: ProjectedMemoryJob): ServerMemoryJob {
  const { source: _source, eventVersion: _eventVersion, retainedAt: _retainedAt, ...serverJob } = job
  return serverJob
}
