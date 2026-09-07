import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  cancelMemoryJob,
  claimNextMemoryJob,
  createMemoryJob,
  enqueueMemoryJob,
  getMemoryJob,
  listMemoryJobs,
} from '../src/memoryRepository.js'
import type { MemoryEvent } from '../src/memoryEvents.js'
import { MEMORY_JOB_BATCH_MAX_JOBS, MemoryWorker, type MemoryJobHandler } from '../src/memoryWorker.js'

const dataDirs: string[] = []

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-memory-worker-'))
  dataDirs.push(dataDir)
  return dataDir
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  vi.useRealTimers()
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

describe('memory worker lifecycle and dispatch', () => {
  it('starts and stops idempotently', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const worker = new MemoryWorker({ db, pollIntervalMs: 10 })

      worker.start()
      worker.start()
      expect(worker.isRunning).toBe(true)

      await worker.stop()
      await worker.stop()
      expect(worker.isRunning).toBe(false)
      expect(worker.isProcessing).toBe(false)
    } finally {
      db.close()
    }
  })

  it('wakes an idle worker immediately when new work is enqueued', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      const handled: string[] = []
      const worker = new MemoryWorker({
        db,
        pollIntervalMs: 10_000,
        handlers: {
          chunk: (job) => {
            handled.push(job.id)
          },
        },
      })
      worker.start()
      await vi.advanceTimersByTimeAsync(0)

      enqueueMemoryJob(db, { id: 'job-woken', chatId: 'chat-1', kind: 'chunk', payload: {} })
      worker.wake()
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()

      expect(handled).toEqual(['job-woken'])
      await worker.stop()
    } finally {
      db.close()
    }
  })

  it('remembers a wake request made while another job is in flight', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      const firstStarted = deferred()
      const releaseFirst = deferred()
      const handled: string[] = []
      enqueueMemoryJob(db, { id: 'job-first', chatId: 'chat-1', kind: 'chunk', payload: {} })
      const worker = new MemoryWorker({
        db,
        pollIntervalMs: 10_000,
        handlers: {
          chunk: async (job) => {
            handled.push(job.id)
            if (job.id === 'job-first') {
              firstStarted.resolve()
              await releaseFirst.promise
            }
          },
        },
      })
      worker.start()
      await vi.advanceTimersByTimeAsync(0)
      await firstStarted.promise

      enqueueMemoryJob(db, { id: 'job-second', chatId: 'chat-1', kind: 'chunk', payload: {} })
      worker.wake()
      releaseFirst.resolve()
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()

      expect(handled).toEqual(['job-first', 'job-second'])
      await worker.stop()
    } finally {
      db.close()
    }
  })

  it('dispatches chunk, embed, and summarize jobs through stub handlers', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, {
        id: 'job-chunk',
        chatId: 'chat-1',
        kind: 'chunk',
        payload: { reason: 'chunk' },
      })
      enqueueMemoryJob(db, {
        id: 'job-embed',
        chatId: 'chat-1',
        kind: 'embed',
        payload: { chunkId: 'chunk-1' },
      })
      enqueueMemoryJob(db, {
        id: 'job-summarize',
        chatId: 'chat-1',
        kind: 'summarize',
        payload: { chunkId: 'chunk-1', model: 'model-a' },
      })

      const handled: string[] = []
      const handler: MemoryJobHandler = (job) => {
        handled.push(`${job.kind}:${job.id}`)
      }
      const worker = new MemoryWorker({
        db,
        handlers: { chunk: handler, embed: handler, summarize: handler },
      })

      expect(await worker.tick()).toBe(true)
      expect(await worker.tick()).toBe(true)
      expect(await worker.tick()).toBe(true)
      expect(await worker.tick()).toBe(false)

      expect(handled).toEqual(['chunk:job-chunk', 'embed:job-embed', 'summarize:job-summarize'])
      expect(listMemoryJobs(db).map((job) => [job.id, job.status])).toEqual([
        ['job-chunk', 'completed'],
        ['job-embed', 'completed'],
        ['job-summarize', 'completed'],
      ])
    } finally {
      db.close()
    }
  })

  it('emits memory.job events for claimed and completed jobs', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, {
        id: 'job-events',
        chatId: 'chat-1',
        kind: 'summarize',
        payload: { chunkId: 'chunk-1' },
      })
      const events: MemoryEvent[] = []
      const worker = new MemoryWorker({
        db,
        onEvent: (event) => events.push(event),
      })

      expect(await worker.tick()).toBe(true)

      expect(events).toEqual([
        {
          type: 'memory.job',
          chatId: 'chat-1',
          job: {
            id: 'job-events',
            instanceId: expect.any(String),
            kind: 'summarize',
            status: 'running',
            attemptCount: 1,
            maxAttempts: 3,
            updatedAt: expect.any(String),
          },
        },
        {
          type: 'memory.job',
          chatId: 'chat-1',
          job: {
            id: 'job-events',
            instanceId: expect.any(String),
            kind: 'summarize',
            status: 'completed',
            attemptCount: 1,
            maxAttempts: 3,
            error: null,
            updatedAt: expect.any(String),
          },
        },
      ])
      expect(() => JSON.stringify(events)).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('continues claimed job execution when memory event delivery throws', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, {
        id: 'job-event-throw',
        chatId: 'chat-1',
        kind: 'chunk',
        payload: {},
      })
      let handled = false
      const worker = new MemoryWorker({
        db,
        onEvent: () => {
          throw new Error('memory event sink exploded')
        },
        handlers: {
          chunk: () => {
            handled = true
          },
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(handled).toBe(true)
      expect(getMemoryJob(db, 'job-event-throw')).toMatchObject({
        status: 'completed',
        error: null,
      })
    } finally {
      db.close()
    }
  })

  it("round-robins claims across chats so one chat's backlog cannot starve another", async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, { id: 'job-a-1', chatId: 'chat-a', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-a-2', chatId: 'chat-a', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-a-3', chatId: 'chat-a', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-b-1', chatId: 'chat-b', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-b-2', chatId: 'chat-b', kind: 'chunk', payload: {} })

      const handled: string[] = []
      const worker = new MemoryWorker({
        db,
        handlers: {
          chunk: (job) => {
            handled.push(job.id)
          },
        },
      })

      while (await worker.tick()) {
        // drain
      }

      // Strict FIFO would run all of chat-a before chat-b; the fair claim
      // alternates between the pending chats instead.
      expect(handled).toEqual(['job-a-1', 'job-b-1', 'job-a-2', 'job-b-2', 'job-a-3'])
    } finally {
      db.close()
    }
  })

  it("one chat's batch is bounded to a single tick and the other chat is served next", async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, { id: 'job-a-1', chatId: 'chat-a', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-a-2', chatId: 'chat-a', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-a-3', chatId: 'chat-a', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-b-1', chatId: 'chat-b', kind: 'chunk', payload: {} })

      const batches: string[][] = []
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          chunk: async (firstJob, context) => {
            const jobs = [firstJob]
            while (jobs.length < MEMORY_JOB_BATCH_MAX_JOBS) {
              const next = context.claimNext({ chatId: firstJob.chatId, kind: 'chunk' })
              if (!next) break
              jobs.push(next)
            }
            batches.push(jobs.map((job) => job.id))
            for (const job of jobs) context.complete(job.id)
          },
        },
      })

      expect(await worker.tick()).toBe(true)
      expect(await worker.tick()).toBe(true)
      expect(await worker.tick()).toBe(false)

      expect(batches).toEqual([['job-a-1', 'job-a-2', 'job-a-3'], ['job-b-1']])
      expect(listMemoryJobs(db, { status: 'pending' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('drains a multi-batch backlog through immediate productive ticks', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      const totalJobs = MEMORY_JOB_BATCH_MAX_JOBS + 1
      const jobIdWidth = String(totalJobs).length
      for (let index = 1; index <= totalJobs; index += 1) {
        enqueueMemoryJob(db, {
          id: `job-${String(index).padStart(jobIdWidth, '0')}`,
          chatId: 'chat-1',
          kind: 'chunk',
          payload: {},
        })
      }
      // SQLite's creation clock is independent of fake JS timers. Exercise
      // equal creation times explicitly; padded IDs retain the intended order
      // under the repository's created_at/id sort, regardless of insert speed.
      db.prepare('UPDATE memory_jobs SET created_at = ?').run(new Date().toISOString())

      const batches: string[][] = []
      const batchGates = [deferred(), deferred()]
      let nextBatchGate = 0
      const worker = new MemoryWorker({
        db,
        pollIntervalMs: 1_000,
        batchHandlers: {
          chunk: async (firstJob, context) => {
            const jobs = [firstJob]
            while (jobs.length < MEMORY_JOB_BATCH_MAX_JOBS) {
              const next = context.claimNext({ chatId: firstJob.chatId, kind: 'chunk' })
              if (!next) break
              jobs.push(next)
            }
            batches.push(jobs.map((job) => job.id))
            await batchGates[nextBatchGate].promise
            nextBatchGate += 1
            for (const job of jobs) context.complete(job.id)
          },
        },
      })

      worker.start()
      worker.start()
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(0)
      expect(batches).toHaveLength(1)
      expect(batches[0]).toHaveLength(MEMORY_JOB_BATCH_MAX_JOBS)
      expect(vi.getTimerCount()).toBe(0)

      batchGates[0].resolve()
      await flushMicrotasks()
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(0)
      expect(batches).toHaveLength(2)
      expect(batches[1]).toEqual([`job-${totalJobs}`])
      expect(vi.getTimerCount()).toBe(0)

      batchGates[1].resolve()
      await flushMicrotasks()
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(0)
      expect(listMemoryJobs(db, { status: 'pending' })).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(1)

      await worker.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      db.close()
    }
  })

  it('keeps idle polling on the configured delay', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      const handled: string[] = []
      const worker = new MemoryWorker({
        db,
        pollIntervalMs: 1_000,
        handlers: {
          chunk: (job) => {
            handled.push(job.id)
          },
        },
      })

      worker.start()
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()
      expect(handled).toEqual([])
      expect(vi.getTimerCount()).toBe(1)

      enqueueMemoryJob(db, { id: 'job-after-idle', chatId: 'chat-1', kind: 'chunk', payload: {} })
      await vi.advanceTimersByTimeAsync(999)
      expect(handled).toEqual([])
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      await flushMicrotasks()
      expect(handled).toEqual(['job-after-idle'])
      expect(getMemoryJob(db, 'job-after-idle')).toMatchObject({ status: 'completed' })

      await worker.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      db.close()
    }
  })

  it('stop prevents pending fast-path ticks after productive work settles', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, { id: 'job-stop-fast-1', chatId: 'chat-1', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-stop-fast-2', chatId: 'chat-1', kind: 'chunk', payload: {} })
      const gate = deferred()
      const handled: string[] = []
      const worker = new MemoryWorker({
        db,
        pollIntervalMs: 1_000,
        handlers: {
          chunk: async (job) => {
            handled.push(job.id)
            await gate.promise
          },
        },
      })

      worker.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(handled).toEqual(['job-stop-fast-1'])
      expect(vi.getTimerCount()).toBe(0)

      const stop = worker.stop()
      await flushMicrotasks()
      expect(worker.isRunning).toBe(false)

      gate.resolve()
      await stop
      expect(vi.getTimerCount()).toBe(0)
      expect(handled).toEqual(['job-stop-fast-1'])
      expect(getMemoryJob(db, 'job-stop-fast-1')).toMatchObject({ status: 'completed' })
      expect(getMemoryJob(db, 'job-stop-fast-2')).toMatchObject({ status: 'pending' })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(handled).toEqual(['job-stop-fast-1'])
    } finally {
      db.close()
    }
  })

  it('claims only one job at a time', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, { id: 'job-1', chatId: 'chat-1', kind: 'chunk', payload: {} })
      enqueueMemoryJob(db, { id: 'job-2', chatId: 'chat-1', kind: 'embed', payload: {} })
      const gate = deferred()
      const handled: string[] = []
      const worker = new MemoryWorker({
        db,
        handlers: {
          chunk: async (job) => {
            handled.push(job.id)
            await gate.promise
          },
        },
      })

      const firstTick = worker.tick()
      expect(await worker.tick()).toBe(false)
      expect(worker.isProcessing).toBe(true)
      expect(handled).toEqual(['job-1'])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'running' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'pending' })

      gate.resolve()
      expect(await firstTick).toBe(true)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'pending' })
    } finally {
      db.close()
    }
  })

  it('fails a claimed job when a handler throws', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, {
        id: 'job-fail',
        chatId: 'chat-1',
        kind: 'summarize',
        payload: {},
        maxAttempts: 1,
      })
      const worker = new MemoryWorker({
        db,
        handlers: {
          summarize: () => {
            throw new Error('summary stub exploded')
          },
        },
      })

      expect(await worker.tick()).toBe(true)
      expect(getMemoryJob(db, 'job-fail')).toMatchObject({
        status: 'failed',
        error: 'summary stub exploded',
        attemptCount: 1,
      })
    } finally {
      db.close()
    }
  })

  it('emits memory.job events for terminal handler failure', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, {
        id: 'job-fail-events',
        chatId: 'chat-1',
        kind: 'chunk',
        payload: {},
        maxAttempts: 1,
      })
      const events: MemoryEvent[] = []
      const worker = new MemoryWorker({
        db,
        onEvent: (event) => events.push(event),
        handlers: {
          chunk: () => {
            throw new Error('chunk stub exploded')
          },
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(events.map((event) => event.job.status)).toEqual(['running', 'failed'])
      expect(events.at(-1)).toMatchObject({
        type: 'memory.job',
        chatId: 'chat-1',
        job: {
          id: 'job-fail-events',
          instanceId: expect.any(String),
          kind: 'chunk',
          status: 'failed',
          attemptCount: 1,
          maxAttempts: 1,
          updatedAt: expect.any(String),
        },
      })
    } finally {
      db.close()
    }
  })

  it('retries handler failures with backoff before max-attempt failure', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, {
        id: 'job-retry',
        chatId: 'chat-1',
        kind: 'summarize',
        payload: {},
        maxAttempts: 2,
        nextRunAt: '2026-05-24T00:00:00.000Z',
      })
      const worker = new MemoryWorker({
        db,
        retry: {
          now: '2026-05-24T00:00:00.000Z',
          backoffBaseMs: 1_000,
        },
        handlers: {
          summarize: () => {
            throw new Error('summary stub exploded')
          },
        },
      })

      expect(await worker.tick()).toBe(true)
      expect(getMemoryJob(db, 'job-retry')).toMatchObject({
        status: 'pending',
        error: 'summary stub exploded',
        attemptCount: 1,
        nextRunAt: '2026-05-24T00:00:01.000Z',
      })
      expect(await worker.tick()).toBe(false)

      const second = new MemoryWorker({
        db,
        retry: {
          now: '2026-05-24T00:00:01.000Z',
          backoffBaseMs: 1_000,
        },
        handlers: {
          summarize: () => {
            throw new Error('summary stub exploded again')
          },
        },
      })
      expect(await second.tick()).toBe(true)
      expect(getMemoryJob(db, 'job-retry')).toMatchObject({
        status: 'failed',
        error: 'summary stub exploded again',
        attemptCount: 2,
      })
    } finally {
      db.close()
    }
  })

  it('emits memory.job events for retry backoff transitions', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, {
        id: 'job-retry-events',
        chatId: 'chat-1',
        kind: 'embed',
        payload: {},
        maxAttempts: 2,
        nextRunAt: '2026-05-24T00:00:00.000Z',
      })
      const events: MemoryEvent[] = []
      const worker = new MemoryWorker({
        db,
        retry: {
          now: '2026-05-24T00:00:00.000Z',
          backoffBaseMs: 1_000,
        },
        onEvent: (event) => events.push(event),
        handlers: {
          embed: () => {
            throw new Error('embedding stub exploded')
          },
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(events.map((event) => event.job.status)).toEqual(['running', 'pending'])
      expect(events.at(-1)).toMatchObject({
        type: 'memory.job',
        chatId: 'chat-1',
        job: {
          id: 'job-retry-events',
          instanceId: expect.any(String),
          kind: 'embed',
          status: 'pending',
          attemptCount: 1,
          maxAttempts: 2,
          updatedAt: expect.any(String),
        },
      })
    } finally {
      db.close()
    }
  })

  it('leaves a running job cancelled when the handler later settles', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, { id: 'job-cancel', chatId: 'chat-1', kind: 'chunk', payload: {} })
      const gate = deferred()
      const worker = new MemoryWorker({
        db,
        handlers: {
          chunk: async () => {
            await gate.promise
          },
        },
      })

      const tick = worker.tick()
      await Promise.resolve()
      expect(cancelMemoryJob(db, 'job-cancel')).toMatchObject({ status: 'cancelled' })
      gate.resolve()
      expect(await tick).toBe(true)
      expect(getMemoryJob(db, 'job-cancel')).toMatchObject({ status: 'cancelled' })
    } finally {
      db.close()
    }
  })

  it('does not emit completed when a running job is cancelled before the handler settles', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, {
        id: 'job-cancel-events',
        chatId: 'chat-1',
        kind: 'chunk',
        payload: {},
      })
      const gate = deferred()
      const events: MemoryEvent[] = []
      const worker = new MemoryWorker({
        db,
        onEvent: (event) => events.push(event),
        handlers: {
          chunk: async () => {
            await gate.promise
          },
        },
      })

      const tick = worker.tick()
      await Promise.resolve()
      expect(cancelMemoryJob(db, 'job-cancel-events')).toMatchObject({ status: 'cancelled' })
      gate.resolve()
      expect(await tick).toBe(true)

      expect(events.map((event) => event.job.status)).toEqual(['running'])
      expect(getMemoryJob(db, 'job-cancel-events')).toMatchObject({ status: 'cancelled' })
    } finally {
      db.close()
    }
  })

  it('recovers abandoned running jobs before polling starts', async () => {
    const db = openDatabase(makeDataDir())
    try {
      createMemoryJob(db, {
        id: 'job-running',
        chatId: 'chat-1',
        kind: 'chunk',
        payload: {},
        status: 'running',
        attemptCount: 1,
      })
      const worker = new MemoryWorker({
        db,
        pollIntervalMs: 10_000,
        retry: {
          now: '2026-05-24T00:00:00.000Z',
          backoffBaseMs: 1_000,
        },
      })

      worker.start()
      await worker.stop()
      expect(getMemoryJob(db, 'job-running')).toMatchObject({
        status: 'pending',
        error: 'memory job was abandoned while running',
        nextRunAt: '2026-05-24T00:00:01.000Z',
      })
    } finally {
      db.close()
    }
  })

  it('sweeps old terminal memory jobs when worker maintenance starts', async () => {
    const db = openDatabase(makeDataDir())
    try {
      for (const [id, status] of [
        ['old-completed', 'completed'],
        ['old-failed', 'failed'],
        ['old-cancelled', 'cancelled'],
        ['recent-completed', 'completed'],
        ['pending-old', 'pending'],
      ] as const) {
        createMemoryJob(db, {
          id,
          chatId: 'chat-1',
          kind: 'chunk',
          payload: {},
          status,
        })
      }
      db.prepare(
        `
          UPDATE memory_jobs
          SET updated_at = '2026-06-01T00:00:00.000Z'
          WHERE id IN ('old-completed', 'old-failed', 'old-cancelled', 'pending-old')
        `,
      ).run()
      db.prepare(
        `
          UPDATE memory_jobs
          SET updated_at = '2026-06-05T12:00:00.000Z'
          WHERE id = 'recent-completed'
        `,
      ).run()

      const worker = new MemoryWorker({
        db,
        pollIntervalMs: 10_000,
        terminalRetention: {
          now: '2026-06-06T00:00:00.000Z',
          retentionMs: 24 * 60 * 60 * 1000,
        },
      })

      worker.start()
      await worker.stop()

      expect(
        listMemoryJobs(db)
          .map((job) => [job.id, job.status])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      ).toEqual([
        ['pending-old', 'pending'],
        ['recent-completed', 'completed'],
      ])
    } finally {
      db.close()
    }
  })

  it('emits memory.job events for abandoned running job recovery', async () => {
    const db = openDatabase(makeDataDir())
    try {
      createMemoryJob(db, {
        id: 'job-recovered',
        chatId: 'chat-1',
        kind: 'summarize',
        payload: {},
        status: 'running',
        attemptCount: 1,
        maxAttempts: 3,
      })
      createMemoryJob(db, {
        id: 'job-recovered-failed',
        chatId: 'chat-2',
        kind: 'embed',
        payload: {},
        status: 'running',
        attemptCount: 1,
        maxAttempts: 1,
      })
      const events: MemoryEvent[] = []
      const worker = new MemoryWorker({
        db,
        pollIntervalMs: 10_000,
        onEvent: (event) => events.push(event),
        retry: {
          now: '2026-05-24T00:00:00.000Z',
          backoffBaseMs: 1_000,
        },
      })

      worker.start()
      await worker.stop()

      expect(events.map((event) => [event.job.id, event.job.status])).toEqual([
        ['job-recovered', 'pending'],
        ['job-recovered-failed', 'failed'],
      ])
      expect(events[0]).toMatchObject({
        type: 'memory.job',
        chatId: 'chat-1',
        job: {
          id: 'job-recovered',
          instanceId: expect.any(String),
          kind: 'summarize',
          status: 'pending',
          updatedAt: expect.any(String),
        },
      })
      expect(events[1]).toMatchObject({
        type: 'memory.job',
        chatId: 'chat-2',
        job: {
          id: 'job-recovered-failed',
          kind: 'embed',
          status: 'failed',
        },
      })
    } finally {
      db.close()
    }
  })

  it('waits for the in-flight handler during graceful shutdown', async () => {
    const db = openDatabase(makeDataDir())
    try {
      enqueueMemoryJob(db, { id: 'job-stop', chatId: 'chat-1', kind: 'chunk', payload: {} })
      const gate = deferred()
      let settled = false
      const worker = new MemoryWorker({
        db,
        handlers: {
          chunk: async () => {
            await gate.promise
          },
        },
      })

      const tick = worker.tick()
      const stop = worker.stop().then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      gate.resolve()
      await tick
      await stop
      expect(settled).toBe(true)
      expect(worker.isRunning).toBe(false)
      expect(getMemoryJob(db, 'job-stop')).toMatchObject({ status: 'completed' })
    } finally {
      db.close()
    }
  })

  it('starts with Fastify and stops before the database closes', async () => {
    vi.useFakeTimers()
    process.env.LOG_LEVEL = 'silent'
    const dataDir = makeDataDir()
    const db = openDatabase(dataDir)
    enqueueMemoryJob(db, { id: 'job-app', chatId: 'chat-1', kind: 'chunk', payload: {} })
    db.close()

    const gate = deferred()
    let handlerStarted = false
    let appClosed = false
    const { app } = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      memoryWorker: {
        pollIntervalMs: 10_000,
        handlers: {
          chunk: async () => {
            handlerStarted = true
            await gate.promise
          },
        },
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(handlerStarted).toBe(true)
    const close = app.close().then(() => {
      appClosed = true
    })
    await Promise.resolve()
    expect(appClosed).toBe(false)

    gate.resolve()
    await close
    expect(appClosed).toBe(true)

    const checkDb = openDatabase(dataDir)
    try {
      expect(getMemoryJob(checkDb, 'job-app')).toMatchObject({ status: 'completed' })
    } finally {
      checkDb.close()
    }
  })

  it('recovers an abandoned running job after a database reopen and executes it once', async () => {
    vi.useFakeTimers()
    process.env.LOG_LEVEL = 'silent'
    const dataDir = makeDataDir()
    const firstDb = openDatabase(dataDir)
    enqueueMemoryJob(firstDb, {
      id: 'job-reopened',
      chatId: 'chat-1',
      kind: 'chunk',
      payload: {},
      nextRunAt: '2026-08-30T00:00:00.000Z',
    })
    expect(claimNextMemoryJob(firstDb, { now: '2026-08-30T00:00:00.000Z' })).toMatchObject({
      id: 'job-reopened',
      status: 'running',
      attemptCount: 1,
    })
    firstDb.close()

    let executions = 0
    const { app } = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      memoryWorker: {
        pollIntervalMs: 10_000,
        retry: { now: '2026-08-30T00:00:00.000Z', backoffBaseMs: 0 },
        handlers: {
          chunk: () => {
            executions += 1
          },
        },
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(executions).toBe(1)
    await app.close()

    const reopenedDb = openDatabase(dataDir)
    try {
      expect(getMemoryJob(reopenedDb, 'job-reopened')).toMatchObject({
        status: 'completed',
        attemptCount: 2,
        error: null,
      })
    } finally {
      reopenedDb.close()
    }
  })
})
