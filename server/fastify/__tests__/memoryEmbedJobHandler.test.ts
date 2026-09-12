import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/db.js'
import { createEmbedMemoryJobBatchHandler, createEmbedMemoryJobHandler } from '../src/memoryEmbedJobHandler.js'
import {
  MEMORY_EMBEDDING_APPROX_CHARS_PER_TOKEN,
  MEMORY_EMBEDDING_FALLBACK_MAX_INPUT_BYTES,
  VOYAGE_CONTEXTUAL_MAX_CONTEXT_CHUNK_TOKENS,
  VOYAGE_CONTEXTUAL_MAX_CONTEXT_TOKENS,
} from '../src/memoryEmbeddingModel.js'
import { MEMORY_JOB_BATCH_MAX_JOBS, MemoryWorker } from '../src/memoryWorker.js'
import {
  cancelMemoryJob,
  createMemoryChunk,
  enqueueMemoryJob,
  getMemoryJob,
  listMemoryEmbeddings,
  listMemoryJobs,
} from '../src/memoryRepository.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { createBackup, restoreBackup, writePersistedWithMessages } from '../src/repository.js'
import { assertScopedLoadOnHotPath } from './helpers/loadCostHarness.js'

const dataDirs: string[] = []

type ProtocolMetric = Record<string, unknown> & { metric: string }

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-memory-embed-handler-'))
  dataDirs.push(dataDir)
  return dataDir
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

function resolveOnAbort<T>(signal: AbortSignal, value: T): Promise<T> {
  return new Promise((resolve) => {
    const done = (): void => resolve(value)
    if (signal.aborted) {
      done()
      return
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function resolveAfterUnlessAborted<T>(signal: AbortSignal, delayMs: number, value: T, aborted: T): Promise<T> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(aborted)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, delayMs)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

function payload(chunkId = 'chunk-1', model = 'custom') {
  return {
    schemaVersion: 1,
    chunkId,
    model,
  }
}

function database(settings: Record<string, unknown> = {}) {
  return {
    hypaModel: 'custom',
    voyageApiKey: 'voyage-key',
    hypaCustomSettings: {
      url: 'https://example.test/v1',
      model: 'custom-embed',
      key: 'sk-test',
    },
    selectedHypaV3PresetId: 'memory-default',
    hypaV3PresetId: 0,
    hypaV3Presets: [
      {
        id: 'memory-default',
        name: 'Default',
        settings: {
          embeddingRequestsPerMinute: 100,
          embeddingMaxConcurrent: 1,
          ...settings,
        },
      },
    ],
    hypaV3Settings: {
      embeddingRequestsPerMinute: 1,
      embeddingMaxConcurrent: 1,
    },
  }
}

function seedChunkAndJob(db: ReturnType<typeof openDatabase>, jobPayload = payload()) {
  createMemoryChunk(db, {
    id: jobPayload.chunkId,
    chatId: 'chat-1',
    messageId: 'm1',
    rangeStartSeq: 0,
    rangeEndSeq: 1,
    text: 'assistant: first\nassistant: second',
  })
  return enqueueMemoryJob(db, {
    id: 'job-1',
    chatId: 'chat-1',
    kind: 'embed',
    payload: jobPayload,
  })
}

function seedBatchJob(
  db: ReturnType<typeof openDatabase>,
  input: { id: string; chunkId: string; text: string; model?: string },
) {
  createMemoryChunk(db, {
    id: input.chunkId,
    chatId: 'chat-1',
    messageId: input.chunkId,
    rangeStartSeq: 0,
    rangeEndSeq: 1,
    text: input.text,
  })
  return enqueueMemoryJob(db, {
    id: input.id,
    chatId: 'chat-1',
    kind: 'embed',
    payload: payload(input.chunkId, input.model ?? 'custom'),
  })
}

async function withProtocolMetrics<T>(run: (metrics: ProtocolMetric[]) => Promise<T>): Promise<T> {
  const previous = process.env.RISU_PROTOCOL_METRICS
  const metrics: ProtocolMetric[] = []
  process.env.RISU_PROTOCOL_METRICS = '1'
  const info = vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
    if (typeof message !== 'string' || !message.startsWith('[protocol-metric] ')) return
    metrics.push(JSON.parse(message.slice('[protocol-metric] '.length)) as ProtocolMetric)
  })
  try {
    return await run(metrics)
  } finally {
    info.mockRestore()
    if (previous === undefined) {
      delete process.env.RISU_PROTOCOL_METRICS
    } else {
      process.env.RISU_PROTOCOL_METRICS = previous
    }
  }
}

describe('embed memory job handler', () => {
  it('fetches an embedding, writes the vector, and lets the worker complete the job', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedChunkAndJob(db)
      const embed = vi.fn(async () => ({
        model: 'custom',
        vectors: [new Float32Array([0.25, -1.5, 3])],
        dim: 3,
      }))
      const worker = new MemoryWorker({
        db,
        handlers: {
          embed: createEmbedMemoryJobHandler({
            db,
            loadDatabase: database,
            embed,
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(embed).toHaveBeenCalledOnce()
      expect((embed.mock.calls as any[][])[0][0]).toMatchObject({
        request: {
          provider: 'custom',
          endpoint: 'https://example.test/v1/embeddings',
          apiKey: 'sk-test',
          model: 'custom',
          wireModel: 'custom-embed',
        },
        input: ['assistant: first\nassistant: second'],
      })
      const embeddings = listMemoryEmbeddings(db, { chatId: 'chat-1', chunkId: 'chunk-1' })
      expect(embeddings).toHaveLength(1)
      expect(embeddings[0]).toMatchObject({
        chatId: 'chat-1',
        chunkId: 'chunk-1',
        model: 'custom',
        dim: 3,
        groupId: null,
        groupIndex: null,
      })
      expect(Array.from(embeddings[0].vector)).toEqual([0.25, -1.5, 3])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed', error: null })
    } finally {
      db.close()
    }
  })

  it('is idempotent when the target embedding already exists', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      const handler = createEmbedMemoryJobHandler({
        db,
        loadDatabase: database,
        embed: async () => ({ model: 'custom', vectors: [new Float32Array([1, 2])], dim: 2 }),
      })
      await handler(job)

      const embed = vi.fn(async () => {
        throw new Error('should not call provider twice')
      })
      await createEmbedMemoryJobHandler({
        db,
        loadDatabase: database,
        embed,
      })(job)

      expect(embed).not.toHaveBeenCalled()
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1', chunkId: 'chunk-1' })).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('fails missing chunks with a useful error', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = enqueueMemoryJob(db, {
        id: 'job-1',
        chatId: 'chat-1',
        kind: 'embed',
        payload: payload('missing-chunk'),
      })
      const handler = createEmbedMemoryJobHandler({
        db,
        loadDatabase: database,
        embed: async () => ({ model: 'custom', vectors: [new Float32Array([1])], dim: 1 }),
      })

      await expect(handler(job)).rejects.toThrow('memory chunk not found: missing-chunk')
    } finally {
      db.close()
    }
  })

  it('fails invalid payloads before provider dispatch', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = enqueueMemoryJob(db, {
        id: 'job-1',
        chatId: 'chat-1',
        kind: 'embed',
        payload: { schemaVersion: 1, chunkId: '', model: 'custom' },
      })
      const embed = vi.fn(async () => ({
        model: 'custom',
        vectors: [new Float32Array([1])],
        dim: 1,
      }))
      const handler = createEmbedMemoryJobHandler({
        db,
        loadDatabase: database,
        embed,
      })

      await expect(handler(job)).rejects.toThrow('embed payload chunkId must be a non-empty string')
      expect(embed).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('fails unsupported embedding models before provider dispatch', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db, payload('chunk-1', 'MiniLM'))
      const embed = vi.fn(async () => ({
        model: 'MiniLM',
        vectors: [new Float32Array([1])],
        dim: 1,
      }))
      const handler = createEmbedMemoryJobHandler({
        db,
        loadDatabase: database,
        embed,
      })

      await expect(handler(job)).rejects.toThrow(
        'server-side memory embeddings do not support browser-local model MiniLM',
      )
      expect(embed).not.toHaveBeenCalled()
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('fails an oversized single chunk before provider request construction', async () => {
    const db = openDatabase(makeDataDir())
    try {
      createMemoryChunk(db, {
        id: 'chunk-1',
        chatId: 'chat-1',
        messageId: 'm1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'x'.repeat(MEMORY_EMBEDDING_FALLBACK_MAX_INPUT_BYTES + 1),
      })
      const job = enqueueMemoryJob(db, {
        id: 'job-1',
        chatId: 'chat-1',
        kind: 'embed',
        payload: payload('chunk-1', 'custom'),
      })
      const embed = vi.fn(async () => ({
        model: 'custom',
        vectors: [new Float32Array([1])],
        dim: 1,
      }))
      const handler = createEmbedMemoryJobHandler({
        db,
        loadDatabase: database,
        embed,
      })

      await expect(handler(job)).rejects.toThrow('memory embedding chunk chunk-1 exceeds maxInputBytes')
      expect(embed).not.toHaveBeenCalled()
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('fails an oversized non-contextual batch item before provider dispatch', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'x'.repeat(MEMORY_EMBEDDING_FALLBACK_MAX_INPUT_BYTES + 1),
      })
      seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', text: 'valid chunk' })
      const embed = vi.fn(async (opts: { input: readonly string[] }) => ({
        model: 'custom',
        vectors: [new Float32Array([String(opts.input[0]).length])],
        dim: 1,
      }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embed: embed as never,
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(embed).toHaveBeenCalledOnce()
      expect((embed.mock.calls as any[][])[0][0].input).toEqual(['valid chunk'])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({
        status: 'pending',
        error: expect.stringContaining('memory embedding chunk chunk-1 exceeds maxInputBytes'),
      })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed', error: null })
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' }).map((row) => row.chunkId)).toEqual(['chunk-2'])
    } finally {
      db.close()
    }
  })

  it('fails provider errors without writing a vector', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      const handler = createEmbedMemoryJobHandler({
        db,
        loadDatabase: database,
        embed: async () => ({ error: 'provider exploded' }),
      })

      await expect(handler(job)).rejects.toThrow('provider exploded')
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('rolls back invalid embedding writes', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      const handler = createEmbedMemoryJobHandler({
        db,
        loadDatabase: database,
        embed: async () => ({ model: 'custom', vectors: [new Float32Array([1, 2])], dim: 3 }),
      })

      await expect(handler(job)).rejects.toThrow('embedding dimension mismatch: expected 3, got 2')
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('limits batch provider dispatch by embeddingMaxConcurrent', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', text: 'chunk one' })
      seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', text: 'chunk two' })
      seedBatchJob(db, { id: 'job-3', chunkId: 'chunk-3', text: 'chunk three' })
      const selectedDatabase = {
        ...database(),
        selectedHypaV3PresetId: 'selected-memory',
        hypaV3PresetId: 0,
        hypaV3Presets: [
          {
            id: 'numeric-memory',
            name: 'Numeric compatibility projection',
            settings: { embeddingMaxConcurrent: 1 },
          },
          {
            id: 'selected-memory',
            name: 'Stable selection',
            settings: { embeddingMaxConcurrent: 2 },
          },
        ],
      }
      let active = 0
      let maxActive = 0
      const releases: Array<() => void> = []
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: () => selectedDatabase,
            sleep: async () => {},
            embed: async () => {
              active += 1
              maxActive = Math.max(maxActive, active)
              await new Promise<void>((resolve) => {
                releases.push(() => {
                  active -= 1
                  resolve()
                })
              })
              return { model: 'custom', vectors: [new Float32Array([1])], dim: 1 }
            },
          }),
        },
      })

      const tick = worker.tick()
      await flushMicrotasks()
      expect(releases).toHaveLength(2)

      // The stable selected preset allows two concurrent jobs; both the
      // numeric compatibility projection and stale flat settings would
      // incorrectly serialize this batch.
      expect(maxActive).toBe(2)
      for (const release of releases.splice(0)) release()
      await flushMicrotasks()
      for (const release of releases.splice(0)) release()
      expect(await tick).toBe(true)
      expect(
        listMemoryEmbeddings(db, { chatId: 'chat-1' })
          .map((embedding) => embedding.chunkId)
          .sort(),
      ).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
      expect(getMemoryJob(db, 'job-3')).toMatchObject({ status: 'completed', attemptCount: 1 })
    } finally {
      db.close()
    }
  })

  it('applies embeddingRequestsPerMinute between provider dispatches', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', text: 'chunk one' })
      seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', text: 'chunk two' })
      let now = 0
      const sleeps: number[] = []
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ embeddingMaxConcurrent: 2, embeddingRequestsPerMinute: 60 }),
            now: () => now,
            sleep: async (ms) => {
              sleeps.push(ms)
              now += ms
            },
            embed: async () => ({ model: 'custom', vectors: [new Float32Array([1])], dim: 1 }),
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(sleeps).toEqual([1_000])
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('aborts a hung normal embedding provider call and continues the batch', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', text: 'hung chunk' })
      seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', text: 'fast chunk' })
      const embed = vi.fn(async (opts: { input: readonly string[]; signal: AbortSignal }) => {
        const text = String(opts.input[0] ?? '')
        if (text.includes('hung')) {
          return resolveOnAbort(opts.signal, { error: 'aborted', code: 'aborted' as const })
        }
        return { model: 'custom', vectors: [new Float32Array([text.length])], dim: 1 }
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ embeddingMaxConcurrent: 1 }),
            embed: embed as never,
            sleep: async () => {},
            providerFetchDeadlineMs: 25,
          }),
        },
      })

      const tick = worker.tick()
      await flushMicrotasks()

      expect(embed).toHaveBeenCalledOnce()
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'running' })

      await vi.advanceTimersByTimeAsync(24)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'running' })

      await vi.advanceTimersByTimeAsync(1)
      await expect(tick).resolves.toBe(true)

      expect(embed).toHaveBeenCalledTimes(2)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({
        status: 'pending',
        error: 'aborted',
      })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed', error: null })
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' }).map((row) => row.chunkId)).toEqual(['chunk-2'])
    } finally {
      db.close()
    }
  })

  it.each(['single', 'batch'] as const)(
    'fences %s embeddings across restore and recovers a running snapshot',
    async (mode) => {
      const dataDir = makeDataDir()
      const db = openDatabase(dataDir)
      writePersistedWithMessages(db, dataDir, { _version: 1, database: createInitialDatabase(), assets: [] })
      seedChunkAndJob(db)
      let release!: () => void
      const embed = vi
        .fn()
        .mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { model: 'custom', vectors: [new Float32Array([9, 9])], dim: 2 }
        })
        .mockResolvedValue({ model: 'custom', vectors: [new Float32Array([1, 2])], dim: 2 })
      const options = { db, loadDatabase: database, sleep: async () => {}, embed }
      const worker = new MemoryWorker({
        db,
        retry: { backoffBaseMs: 0 },
        ...(mode === 'single'
          ? { handlers: { embed: createEmbedMemoryJobHandler(options) } }
          : { batchHandlers: { embed: createEmbedMemoryJobBatchHandler(options) } }),
      })
      const old = worker.tick()
      try {
        await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce())
        const backup = await createBackup(db, dataDir, 'running embedding')
        await restoreBackup(db, dataDir, backup.id)
        const restored = getMemoryJob(db, 'job-1')
        release()
        await old
        expect(getMemoryJob(db, 'job-1')).toEqual(restored)
        expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toEqual([])
        await worker.tick()
        expect(getMemoryJob(db, 'job-1')?.status).toBe('completed')
        expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(1)
        expect(embed).toHaveBeenCalledTimes(2)
      } finally {
        release?.()
        await old
        await worker.stop()
        db.close()
      }
    },
  )

  it.each(['success', 'failure'] as const)(
    'retires an abort-insensitive embedding request and ignores its late %s after a sibling and recreated instance complete',
    async (late) => {
      vi.useFakeTimers()
      const db = openDatabase(makeDataDir())
      let release!: () => void
      let tick: Promise<boolean> | undefined
      try {
        seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', text: 'held source' })
        seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', text: 'sibling source' })
        let holdFirst = true
        const embed = vi.fn(async (input: { input: readonly string[] }) => {
          if (input.input[0] === 'held source' && holdFirst) {
            holdFirst = false
            await new Promise<void>((resolve) => {
              release = resolve
            })
            if (late === 'failure') throw new Error('retired failure')
          }
          return { model: 'custom', vectors: [new Float32Array([1, 2])], dim: 2 }
        })
        const worker = new MemoryWorker({
          db,
          batchHandlers: {
            embed: createEmbedMemoryJobBatchHandler({
              db,
              loadDatabase: () => database({ embeddingMaxConcurrent: 1 }),
              embed: embed as never,
              sleep: async () => {},
              providerFetchDeadlineMs: 25,
            }),
          },
        })
        let settled = false
        tick = worker.tick().then((value) => {
          settled = true
          return value
        })
        await vi.advanceTimersByTimeAsync(25)
        expect(settled).toBe(true)
        await tick
        expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'pending' })
        expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed' })
        expect(listMemoryEmbeddings(db, { chatId: 'chat-1' }).map((row) => row.chunkId)).toEqual(['chunk-2'])
        const previous = getMemoryJob(db, 'job-1')!
        db.prepare('DELETE FROM memory_jobs WHERE id = ?').run(previous.id)
        const replacement = enqueueMemoryJob(db, {
          id: previous.id,
          chatId: previous.chatId,
          kind: 'embed',
          payload: previous.payload,
        })
        expect(replacement.instanceId).not.toBe(previous.instanceId)
        await worker.tick()
        expect(getMemoryJob(db, previous.id)).toMatchObject({ instanceId: replacement.instanceId, status: 'completed' })
        const currentOutput = listMemoryEmbeddings(db, { chatId: 'chat-1' })
        expect(currentOutput).toHaveLength(2)
        release()
        await vi.advanceTimersByTimeAsync(0)
        expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toEqual(currentOutput)
        expect(getMemoryJob(db, previous.id)).toMatchObject({ instanceId: replacement.instanceId, status: 'completed' })
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        release?.()
        await tick
        db.close()
      }
    },
  )

  it('clears the embedding deadline after a provider call resolves under it', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      seedChunkAndJob(db)
      const providerSignals: AbortSignal[] = []
      const worker = new MemoryWorker({
        db,
        handlers: {
          embed: createEmbedMemoryJobHandler({
            db,
            loadDatabase: database,
            providerFetchDeadlineMs: 50,
            embed: async (opts) => {
              providerSignals.push(opts.signal)
              return resolveAfterUnlessAborted(
                opts.signal,
                20,
                { model: 'custom', vectors: [new Float32Array([1])], dim: 1 },
                { error: 'aborted', code: 'aborted' as const },
              )
            },
          }),
        },
      })

      const tick = worker.tick()
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(20)
      await expect(tick).resolves.toBe(true)

      expect(providerSignals).toHaveLength(1)
      expect(providerSignals[0]?.aborted).toBe(false)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed', error: null })

      await vi.advanceTimersByTimeAsync(100)
      expect(providerSignals[0]?.aborted).toBe(false)
    } finally {
      db.close()
    }
  })

  it('aborts a hung single contextual embedding provider call within the deadline', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      seedChunkAndJob(db, payload('chunk-1', 'voyageContext3'))
      const embedGroups = vi.fn((opts: { signal: AbortSignal }) => {
        return resolveOnAbort(opts.signal, { error: 'aborted', code: 'aborted' as const })
      })
      const worker = new MemoryWorker({
        db,
        handlers: {
          embed: createEmbedMemoryJobHandler({
            db,
            loadDatabase: database,
            embedGroups: embedGroups as never,
            providerFetchDeadlineMs: 25,
            sleep: async () => {},
          }),
        },
      })

      const tick = worker.tick()
      await flushMicrotasks()

      expect(embedGroups).toHaveBeenCalledOnce()
      expect((embedGroups.mock.calls as any[][])[0][0]).toMatchObject({
        request: { provider: 'voyage-contextual' },
        groups: [['assistant: first\nassistant: second']],
      })
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'running' })

      await vi.advanceTimersByTimeAsync(24)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'running' })

      await vi.advanceTimersByTimeAsync(1)
      await expect(tick).resolves.toBe(true)

      expect(getMemoryJob(db, 'job-1')).toMatchObject({
        status: 'pending',
        error: 'aborted',
      })
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1', chunkId: 'chunk-1' })).toHaveLength(0)
      expect(worker.isProcessing).toBe(false)
    } finally {
      db.close()
    }
  })

  it('commits a staged sibling embedding after another running batch job is cancelled', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', text: 'chunk one' })
      seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', text: 'chunk two' })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ embeddingMaxConcurrent: 2 }),
            sleep: async () => {},
            embed: async (opts) => {
              const text = String(opts.input[0] ?? '')
              if (text.includes('chunk one')) cancelMemoryJob(db, 'job-1')
              return { model: 'custom', vectors: [new Float32Array([1])], dim: 1 }
            },
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toEqual([expect.objectContaining({ chunkId: 'chunk-2' })])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'cancelled' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed', error: null })
    } finally {
      db.close()
    }
  })

  it('commits independent embed jobs after a sibling provider failure', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', text: 'chunk one' })
      seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', text: 'chunk two' })
      seedBatchJob(db, { id: 'job-3', chunkId: 'chunk-3', text: 'chunk three' })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ embeddingMaxConcurrent: 3 }),
            sleep: async () => {},
            embed: async (opts) => {
              const text = String(opts.input[0] ?? '')
              if (text.includes('chunk two')) return { error: 'provider transient' }
              return { model: 'custom', vectors: [new Float32Array([text.length])], dim: 1 }
            },
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(
        listMemoryEmbeddings(db, { chatId: 'chat-1' })
          .map((embedding) => embedding.chunkId)
          .sort(),
      ).toEqual(['chunk-1', 'chunk-3'])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed', error: null })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({
        status: 'pending',
        error: 'provider transient',
      })
      expect(getMemoryJob(db, 'job-3')).toMatchObject({ status: 'completed', error: null })
    } finally {
      db.close()
    }
  })

  it.each([
    ['voyageContext3', 'voyage-context-3'],
    ['voyageContext4', 'voyage-context-4'],
  ])('groups %s embed jobs and persists ordered group metadata', async (model, wireModel) => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'second contextual chunk',
        model,
      })
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'first contextual chunk',
        model,
      })
      const embedGroups = vi.fn(async () => ({
        model: wireModel,
        groups: [[new Float32Array([1, 2]), new Float32Array([3, 4])]],
        dim: 2,
      }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups,
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(embedGroups).toHaveBeenCalledOnce()
      expect((embedGroups.mock.calls as any[][])[0][0]).toMatchObject({
        request: {
          provider: 'voyage-contextual',
          endpoint: 'https://api.voyageai.com/v1/contextualizedembeddings',
          apiKey: 'voyage-key',
          model: wireModel,
          wireModel,
        },
        groups: [['first contextual chunk', 'second contextual chunk']],
      })
      const embeddings = listMemoryEmbeddings(db, {
        chatId: 'chat-1',
        model,
      })
      expect(embeddings.map((embedding) => embedding.chunkId)).toEqual(['chunk-1', 'chunk-2'])
      expect(embeddings.map((embedding) => embedding.groupIndex)).toEqual([0, 1])
      expect(embeddings[0].groupId).toMatch(/^hypav3-embedding-group-/)
      expect(embeddings[1].groupId).toBe(embeddings[0].groupId)
      expect(Array.from(embeddings[0].vector)).toEqual([1, 2])
      expect(Array.from(embeddings[1].vector)).toEqual([3, 4])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed' })
    } finally {
      db.close()
    }
  })

  it('fails an oversized contextual chunk before provider request construction', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'valid contextual chunk',
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'x'.repeat((VOYAGE_CONTEXTUAL_MAX_CONTEXT_CHUNK_TOKENS + 1) * MEMORY_EMBEDDING_APPROX_CHARS_PER_TOKEN),
        model: 'voyageContext3',
      })
      const embedGroups = vi.fn(async (opts: { groups: readonly (readonly string[])[] }) => ({
        model: 'voyage-context-3',
        groups: [opts.groups[0].map(() => new Float32Array([1]))],
        dim: 1,
      }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups: embedGroups as never,
            sleep: async () => {},
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(embedGroups).toHaveBeenCalledOnce()
      expect((embedGroups.mock.calls as any[][])[0][0].groups).toEqual([['valid contextual chunk']])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed', error: null })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({
        status: 'pending',
        error: expect.stringContaining('memory embedding chunk chunk-2 exceeds maxInputTokens'),
      })
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' }).map((row) => row.chunkId)).toEqual(['chunk-1'])
    } finally {
      db.close()
    }
  })

  it('sends a valid contextual batch under the model window in one request', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'a'.repeat(100_000),
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'b'.repeat(100_000),
        model: 'voyageContext3',
      })
      const embedGroups = vi.fn(async (opts: { groups: readonly (readonly string[])[] }) => ({
        model: 'voyage-context-3',
        groups: [opts.groups[0].map((_text, index) => new Float32Array([index + 1]))],
        dim: 1,
      }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups: embedGroups as never,
          }),
        },
      })

      await withProtocolMetrics(async (metrics) => {
        expect(await worker.tick()).toBe(true)

        expect(embedGroups).toHaveBeenCalledOnce()
        expect((embedGroups.mock.calls as any[][])[0][0].groups).toEqual([['a'.repeat(100_000), 'b'.repeat(100_000)]])
        expect(metrics.some((entry) => entry.metric === 'memory_contextual_embed_split')).toBe(false)
      })
      const embeddings = listMemoryEmbeddings(db, { chatId: 'chat-1', model: 'voyageContext3' })
      expect(embeddings.map((row) => row.chunkId)).toEqual(['chunk-1', 'chunk-2'])
      expect(embeddings[1].groupId).toBe(embeddings[0].groupId)
    } finally {
      db.close()
    }
  })

  it('emits a protocol metric when provider limits split a contextual batch', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'a'.repeat(124_000),
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'b'.repeat(124_000),
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-3',
        chunkId: 'chunk-3',
        text: 'c'.repeat(124_000),
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-4',
        chunkId: 'chunk-4',
        text: 'd'.repeat(124_000),
        model: 'voyageContext3',
      })
      const embedGroups = vi.fn(async (opts: { groups: readonly (readonly string[])[] }) => ({
        model: 'voyage-context-3',
        groups: [opts.groups[0].map((_text, index) => new Float32Array([index + 1]))],
        dim: 1,
      }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups: embedGroups as never,
            sleep: async () => {},
          }),
        },
      })

      await withProtocolMetrics(async (metrics) => {
        expect(await worker.tick()).toBe(true)

        expect(embedGroups).toHaveBeenCalledTimes(2)
        expect((embedGroups.mock.calls as any[][])[0][0].groups).toEqual([
          ['a'.repeat(124_000), 'b'.repeat(124_000), 'c'.repeat(124_000)],
        ])
        expect((embedGroups.mock.calls as any[][])[1][0].groups).toEqual([['d'.repeat(124_000)]])
        expect(metrics.find((entry) => entry.metric === 'memory_contextual_embed_split')).toEqual(
          expect.objectContaining({
            chatId: 'chat-1',
            model: 'voyageContext3',
            provider: 'voyage-contextual',
            requestModel: 'voyage-context-3',
            originalJobCount: 4,
            subBatchCount: 2,
            tokenBudget: VOYAGE_CONTEXTUAL_MAX_CONTEXT_TOKENS,
            budgetSource: 'model-context-limit',
            subBatchJobCounts: [3, 1],
          }),
        )
      })
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1', model: 'voyageContext3' }).map((row) => row.chunkId)).toEqual(
        ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4'],
      )
    } finally {
      db.close()
    }
  })

  it('retries an ordered Voyage contextual batch after provider failure', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'first contextual chunk',
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'second contextual chunk',
        model: 'voyageContext3',
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups: async () => ({ error: 'voyage exploded', code: 'upstream' }),
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(0)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({
        status: 'pending',
        error: 'voyage exploded',
      })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({
        status: 'pending',
        error: 'voyage exploded',
      })
    } finally {
      db.close()
    }
  })

  it('rolls back a Voyage contextual group when one staged vector cannot persist', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'first contextual chunk',
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'second contextual chunk',
        model: 'voyageContext3',
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups: async () => ({
              model: 'voyage-context-3',
              groups: [[new Float32Array([1]), new Float32Array([2, 3])]],
              dim: 1,
            }),
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(0)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({
        status: 'pending',
        error: 'embedding dimension mismatch: expected 1, got 2',
      })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({
        status: 'pending',
        error: 'embedding dimension mismatch: expected 1, got 2',
      })
    } finally {
      db.close()
    }
  })

  it('caps the drained embed batch at MEMORY_JOB_BATCH_MAX_JOBS per tick', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const total = MEMORY_JOB_BATCH_MAX_JOBS + 1
      for (let i = 1; i <= total; i++) {
        const suffix = String(i).padStart(2, '0')
        seedBatchJob(db, { id: `job-${suffix}`, chunkId: `chunk-${suffix}`, text: `chunk ${i}` })
      }
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            sleep: async () => {},
            embed: async () => ({ model: 'custom', vectors: [new Float32Array([1])], dim: 1 }),
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(listMemoryJobs(db, { status: 'completed' })).toHaveLength(MEMORY_JOB_BATCH_MAX_JOBS)
      expect(listMemoryJobs(db, { status: 'pending' })).toHaveLength(1)

      expect(await worker.tick()).toBe(true)
      expect(listMemoryJobs(db, { status: 'pending' })).toHaveLength(0)
      expect(listMemoryJobs(db, { status: 'completed' })).toHaveLength(total)
    } finally {
      db.close()
    }
  })

  it('slices a contextual batch into token-aware sub-batches with per-sub-batch group ids', async () => {
    const db = openDatabase(makeDataDir())
    try {
      // 40 chars ≈ 10 tokens each; a 20-token budget fits exactly two chunks.
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'a'.repeat(40),
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'b'.repeat(40),
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-3',
        chunkId: 'chunk-3',
        text: 'c'.repeat(40),
        model: 'voyageContext3',
      })
      const embedGroups = vi.fn(async (opts: { groups: readonly (readonly string[])[] }) => ({
        model: 'voyage-context-3',
        groups: [opts.groups[0].map((_text, index) => new Float32Array([index + 1]))],
        dim: 1,
      }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups: embedGroups as never,
            sleep: async () => {},
            contextualSubBatchTokenBudget: 20,
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(embedGroups).toHaveBeenCalledTimes(2)
      expect((embedGroups.mock.calls as any[][])[0][0].groups).toEqual([['a'.repeat(40), 'b'.repeat(40)]])
      expect((embedGroups.mock.calls as any[][])[1][0].groups).toEqual([['c'.repeat(40)]])

      const embeddings = listMemoryEmbeddings(db, { chatId: 'chat-1', model: 'voyageContext3' })
      expect(embeddings.map((embedding) => embedding.chunkId).sort()).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
      const byChunk = new Map(embeddings.map((embedding) => [embedding.chunkId, embedding]))
      // groupId is consistent within a sub-batch and distinct across sub-batches.
      expect(byChunk.get('chunk-2')?.groupId).toBe(byChunk.get('chunk-1')?.groupId)
      expect(byChunk.get('chunk-3')?.groupId).not.toBe(byChunk.get('chunk-1')?.groupId)
      expect(byChunk.get('chunk-1')?.groupIndex).toBe(0)
      expect(byChunk.get('chunk-2')?.groupIndex).toBe(1)
      expect(byChunk.get('chunk-3')?.groupIndex).toBe(0)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed' })
      expect(getMemoryJob(db, 'job-3')).toMatchObject({ status: 'completed' })
    } finally {
      db.close()
    }
  })

  it('a failing contextual sub-batch is committed independently and does not fail unrelated chunks', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'a'.repeat(40),
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'b'.repeat(40),
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-3',
        chunkId: 'chunk-3',
        text: 'c'.repeat(40),
        model: 'voyageContext3',
      })
      let call = 0
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            sleep: async () => {},
            contextualSubBatchTokenBudget: 20,
            embedGroups: async (opts) => {
              call += 1
              if (call === 1) return { error: 'voyage exploded', code: 'upstream' }
              return {
                model: 'voyage-context-3',
                groups: [opts.groups[0].map(() => new Float32Array([1]))],
                dim: 1,
              }
            },
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      // Sub-batch 1 (chunk-1, chunk-2) failed alone…
      expect(getMemoryJob(db, 'job-1')).toMatchObject({
        status: 'pending',
        error: 'voyage exploded',
      })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({
        status: 'pending',
        error: 'voyage exploded',
      })
      // …while sub-batch 2 (chunk-3) committed its embedding and completed.
      expect(getMemoryJob(db, 'job-3')).toMatchObject({ status: 'completed', error: null })
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' }).map((embedding) => embedding.chunkId)).toEqual(['chunk-3'])
    } finally {
      db.close()
    }
  })

  it('aborts a hung contextual embedding provider call within the deadline', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'first contextual chunk',
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'second contextual chunk',
        model: 'voyageContext3',
      })
      const embedGroups = vi.fn((opts: { signal: AbortSignal }) => {
        return resolveOnAbort(opts.signal, { error: 'aborted', code: 'aborted' as const })
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups: embedGroups as never,
            providerFetchDeadlineMs: 25,
            sleep: async () => {},
          }),
        },
      })

      const tick = worker.tick()
      await flushMicrotasks()

      expect(embedGroups).toHaveBeenCalledOnce()
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'running' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'running' })

      await vi.advanceTimersByTimeAsync(25)
      await expect(tick).resolves.toBe(true)

      expect(getMemoryJob(db, 'job-1')).toMatchObject({
        status: 'pending',
        error: 'aborted',
      })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({
        status: 'pending',
        error: 'aborted',
      })
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('the default loader performs zero whole-corpus payload reads per batch', async () => {
    const dataDir = makeDataDir()
    const db = openDatabase(dataDir)
    try {
      writePersistedWithMessages(db, dataDir, {
        _version: 4,
        database: {
          ...database(),
          characters: [
            {
              chaId: 'char-1',
              type: 'character',
              name: 'Tess',
              chats: [
                { id: 'chat-1', name: 'main', message: [{ role: 'user', data: 'hello' }] },
                { id: 'chat-2', name: 'side', message: [{ role: 'user', data: 'bye' }] },
              ],
            },
          ],
        },
        assets: [],
      } as never)
      seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', text: 'chunk one' })
      const embed = vi.fn(async () => ({
        model: 'custom',
        vectors: [new Float32Array([0.5])],
        dim: 1,
      }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          // No loadDatabase injection: the default dataDir path is under test.
          embed: createEmbedMemoryJobBatchHandler({ db, dataDir, embed }),
        },
      })

      // hypa_v3_presets is the one collection the memory path legitimately
      // reads whole (it is the settings source); everything else must stay
      // scoped — no characters/chats/messages/collection payload parses.
      await assertScopedLoadOnHotPath(() => worker.tick(), {
        allowTables: ['hypa_v3_presets'],
      })

      // The scoped read still resolved the provider request from settings.
      expect(embed).toHaveBeenCalledOnce()
      expect((embed.mock.calls as any[][])[0][0]).toMatchObject({
        request: {
          provider: 'custom',
          endpoint: 'https://example.test/v1/embeddings',
          apiKey: 'sk-test',
        },
      })
      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toHaveLength(1)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed' })
    } finally {
      db.close()
    }
  })

  it('commits staged Voyage contextual sibling vectors after a running job is cancelled', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        text: 'first contextual chunk',
        model: 'voyageContext3',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        text: 'second contextual chunk',
        model: 'voyageContext3',
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          embed: createEmbedMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            embedGroups: async () => {
              cancelMemoryJob(db, 'job-1')
              return {
                model: 'voyage-context-3',
                groups: [[new Float32Array([1]), new Float32Array([2])]],
                dim: 1,
              }
            },
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(listMemoryEmbeddings(db, { chatId: 'chat-1' })).toEqual([
        expect.objectContaining({ chunkId: 'chunk-2', groupIndex: 1 }),
      ])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'cancelled' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed', error: null })
    } finally {
      db.close()
    }
  })
})
