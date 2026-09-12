import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMemoryJob, ServerMemoryResult } from '../process/request/serverMemory'
import {
  MEMORY_JOB_TERMINAL_FENCE_LIMIT,
  clearMemoryJobTerminalUpdateFence,
  recordTerminalMemoryJobUpdate,
  shouldAcceptMemoryJobUpdate,
} from './memoryJobOrdering'
import { createMemoryJobRefreshController, hasActiveMemoryJobs } from './memoryJobRefresh'

const NOW = new Date('2026-06-01T00:00:00.000Z')

function job(
  status: ServerMemoryJob['status'],
  id = `job-${status}`,
  chatId = 'chat-1',
  instanceId = `${id}-instance`,
): ServerMemoryJob {
  return {
    id,
    instanceId,
    chatId,
    kind: 'summarize',
    status,
    attemptCount: 1,
    maxAttempts: 3,
    updatedAt: NOW.toISOString(),
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('memory job refresh controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearMemoryJobTerminalUpdateFence()
  })

  afterEach(() => {
    clearMemoryJobTerminalUpdateFence()
    vi.useRealTimers()
  })

  it('detects pending and running jobs as active', () => {
    expect(hasActiveMemoryJobs([job('pending')])).toBe(true)
    expect(hasActiveMemoryJobs([job('running')])).toBe(true)
    expect(hasActiveMemoryJobs([job('completed'), job('failed'), job('cancelled')])).toBe(false)
  })

  it('does not overlap refresh requests and runs one queued refresh afterward', async () => {
    const first = deferred<ServerMemoryResult<{ jobs: ServerMemoryJob[] }>>()
    const second = deferred<ServerMemoryResult<{ jobs: ServerMemoryJob[] }>>()
    const listJobs = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const seenJobs: ServerMemoryJob[][] = []
    const loading: boolean[] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs,
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: (value) => loading.push(value),
      now: () => NOW,
    })

    const firstRefresh = controller.refresh()
    const queuedRefresh = controller.refresh()

    expect(listJobs).toHaveBeenCalledTimes(1)
    first.resolve({ status: 'ok', jobs: [job('running', 'job-1')] })
    await firstRefresh
    expect(listJobs).toHaveBeenCalledTimes(2)

    second.resolve({ status: 'ok', jobs: [] })
    await queuedRefresh
    await vi.runOnlyPendingTimersAsync()

    expect(seenJobs.map((jobs) => jobs.map((entry) => entry.id))).toEqual([['job-1'], []])
    expect(loading).toEqual([true, false, true, false])
    controller.dispose()
  })

  it('polls only while active jobs exist', async () => {
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ok', jobs: [job('pending', 'job-1')] })
      .mockResolvedValueOnce({ status: 'ok', jobs: [] })
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      intervalMs: 1000,
      listJobs,
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    await controller.refresh()
    expect(listJobs).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(listJobs).toHaveBeenCalledTimes(2)
    expect(seenJobs.map((jobs) => jobs.map((entry) => entry.id))).toEqual([['job-1'], []])

    await vi.advanceTimersByTimeAsync(3000)
    expect(listJobs).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it.each(['error', 'unavailable', 'throw'] as const)(
    'recovers a lost terminal event after one %s refresh without user action',
    async (failure) => {
      const running = job('running', 'job-1')
      const completed = { ...running, status: 'completed' as const }
      const listJobs = vi.fn().mockResolvedValueOnce({ status: 'ok', jobs: [running] })
      if (failure === 'throw') listJobs.mockRejectedValueOnce(new Error('temporary network failure'))
      else
        listJobs.mockResolvedValueOnce(
          failure === 'error' ? { status: 'error', error: 'temporary failure' } : { status: 'unavailable' },
        )
      listJobs.mockResolvedValueOnce({ status: 'ok', jobs: [completed] })
      const seen: ServerMemoryJob[][] = []
      const onError = vi.fn()
      const controller = createMemoryJobRefreshController({
        chatId: 'chat-1',
        intervalMs: 1000,
        listJobs,
        onJobs: (jobs) => seen.push(jobs),
        onError,
        onClear: vi.fn(),
        onLoading: vi.fn(),
      })
      try {
        await controller.refresh()
        await vi.advanceTimersByTimeAsync(1000)
        expect(onError).toHaveBeenCalledTimes(1)
        expect(seen.at(-1)).toEqual([running])
        await vi.advanceTimersByTimeAsync(1000)
        expect(seen.at(-1)).toEqual([completed])
        await vi.advanceTimersByTimeAsync(5000)
        expect(listJobs).toHaveBeenCalledTimes(3)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        controller.dispose()
      }
    },
  )

  it('reuses the last job list when polling returns not-modified', async () => {
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ok', etag: '"jobs-a"', jobs: [job('running', 'job-1')] })
      .mockResolvedValueOnce({ status: 'not-modified', etag: '"jobs-a"' })
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      intervalMs: 1000,
      listJobs,
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    await controller.refresh()
    await vi.advanceTimersByTimeAsync(1000)

    expect(listJobs).toHaveBeenNthCalledWith(1, 'chat-1', expect.any(AbortSignal), undefined)
    expect(listJobs).toHaveBeenNthCalledWith(2, 'chat-1', expect.any(AbortSignal), '"jobs-a"')
    expect(seenJobs.map((jobs) => jobs.map((entry) => entry.id))).toEqual([['job-1'], ['job-1']])
    controller.dispose()
  })

  it('keeps a terminal update when an older list refresh returns the same job running', async () => {
    const pendingList = deferred<ServerMemoryResult<{ jobs: ServerMemoryJob[] }>>()
    const listJobs = vi.fn().mockReturnValueOnce(pendingList.promise)
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs,
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    const refresh = controller.refresh()
    expect(controller.applyJobUpdate(job('cancelled', 'job-1'))).toBe(true)

    pendingList.resolve({ status: 'ok', jobs: [job('running', 'job-1')] })
    await refresh

    expect(seenJobs.map((jobs) => jobs.map((entry) => entry.id))).toEqual([['job-1'], ['job-1']])
    controller.dispose()
  })

  it('does not let an older empty GET erase a newer active event', async () => {
    const pendingList = deferred<ServerMemoryResult<{ jobs: ServerMemoryJob[] }>>()
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs: vi.fn().mockReturnValue(pendingList.promise),
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    const refresh = controller.refresh()
    const running = job('running', 'job-newer')
    expect(controller.applyJobUpdate(running)).toBe(true)
    pendingList.resolve({ status: 'ok', jobs: [] })
    await refresh

    expect(seenJobs.at(-1)).toEqual([running])
    controller.dispose()
  })

  it('filters cached not-modified jobs after a terminal update', async () => {
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ok', etag: '"jobs-a"', jobs: [job('running', 'job-1')] })
      .mockResolvedValueOnce({ status: 'not-modified', etag: '"jobs-a"' })
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs,
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    await controller.refresh()
    expect(controller.applyJobUpdate(job('cancelled', 'job-1'))).toBe(true)
    await controller.refresh()

    expect(listJobs).toHaveBeenNthCalledWith(2, 'chat-1', expect.any(AbortSignal), '"jobs-a"')
    expect(seenJobs.map((jobs) => jobs.map((entry) => entry.id))).toEqual([['job-1'], ['job-1'], ['job-1']])
    controller.dispose()
  })

  it('ignores stale active job updates after a terminal update', () => {
    const listJobs = vi.fn()
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs,
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    expect(controller.applyJobUpdate(job('running', 'job-1'))).toBe(true)
    expect(controller.applyJobUpdate(job('cancelled', 'job-1'))).toBe(true)
    expect(controller.applyJobUpdate(job('running', 'job-1'))).toBe(false)

    expect(seenJobs.map((jobs) => jobs.map((entry) => entry.id))).toEqual([['job-1'], ['job-1']])
    controller.dispose()
  })

  it('retains a failed job and its server error', () => {
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs: vi.fn(),
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })
    const failed = {
      ...job('failed', 'job-1'),
      error: 'provider authentication failed',
      updatedAt: NOW.toISOString(),
    }

    expect(controller.applyJobUpdate(failed)).toBe(true)
    expect(seenJobs.at(-1)).toEqual([failed])
    controller.dispose()
  })

  it('preserves shared terminal fences when creating and switching into a chat', () => {
    const listJobs = vi.fn().mockResolvedValue({ status: 'ok', jobs: [] })
    recordTerminalMemoryJobUpdate({
      chatId: 'chat-2',
      instanceId: 'job-instance-1',
      status: 'cancelled',
    })
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs,
      onJobs: vi.fn(),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    expect(shouldAcceptMemoryJobUpdate({ chatId: 'chat-2', instanceId: 'job-instance-1', status: 'running' })).toBe(
      false,
    )

    controller.setChatId('chat-2')

    expect(shouldAcceptMemoryJobUpdate({ chatId: 'chat-2', instanceId: 'job-instance-1', status: 'running' })).toBe(
      false,
    )
    controller.dispose()
  })

  it('accepts a recreated logical id with a new instance and bounds terminal fences', () => {
    recordTerminalMemoryJobUpdate({
      chatId: 'chat-1',
      instanceId: 'old-instance',
      status: 'completed',
    })
    expect(shouldAcceptMemoryJobUpdate({ chatId: 'chat-1', instanceId: 'old-instance', status: 'running' })).toBe(false)
    expect(shouldAcceptMemoryJobUpdate({ chatId: 'chat-1', instanceId: 'new-instance', status: 'running' })).toBe(true)

    for (let index = 0; index <= MEMORY_JOB_TERMINAL_FENCE_LIMIT; index += 1) {
      recordTerminalMemoryJobUpdate({
        chatId: 'chat-1',
        instanceId: `bounded-instance-${index}`,
        status: 'cancelled',
      })
    }
    expect(shouldAcceptMemoryJobUpdate({ chatId: 'chat-1', instanceId: 'old-instance', status: 'running' })).toBe(true)
  })

  it('replaces an old active instance when the same logical id is recreated', () => {
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs: vi.fn(),
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    expect(controller.applyJobUpdate(job('running', 'logical-job', 'chat-1', 'old-instance'))).toBe(true)
    const recreated = job('pending', 'logical-job', 'chat-1', 'new-instance')
    expect(controller.applyJobUpdate(recreated)).toBe(true)
    expect(seenJobs.at(-1)).toEqual([recreated])
    controller.dispose()
  })

  it('resets local terminal state on chat id changes and ignores old-chat job updates', () => {
    const listJobs = vi.fn().mockResolvedValue({ status: 'ok', jobs: [] })
    const seenJobs: ServerMemoryJob[][] = []
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      listJobs,
      onJobs: (jobs) => seenJobs.push(jobs),
      onError: vi.fn(),
      onClear: vi.fn(),
      onLoading: vi.fn(),
      now: () => NOW,
    })

    expect(controller.applyJobUpdate(job('cancelled', 'job-1', 'chat-1'))).toBe(true)
    controller.setChatId('chat-2')

    expect(controller.applyJobUpdate(job('running', 'job-1', 'chat-1'))).toBe(false)
    expect(controller.applyJobUpdate(job('running', 'job-1', 'chat-2'))).toBe(true)

    expect(seenJobs.map((jobs) => jobs.map((entry) => `${entry.chatId}:${entry.id}`))).toEqual([
      ['chat-1:job-1'],
      ['chat-2:job-1'],
    ])
    controller.dispose()
  })

  it('clears state and stops polling when the chat id becomes empty', async () => {
    const listJobs = vi.fn().mockResolvedValue({ status: 'ok', jobs: [job('running', 'job-1')] })
    const onClear = vi.fn()
    const controller = createMemoryJobRefreshController({
      chatId: 'chat-1',
      intervalMs: 1000,
      listJobs,
      onJobs: vi.fn(),
      onError: vi.fn(),
      onClear,
      onLoading: vi.fn(),
      now: () => NOW,
    })

    await controller.refresh()
    controller.setChatId('')
    expect(onClear).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3000)
    expect(listJobs).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
})
