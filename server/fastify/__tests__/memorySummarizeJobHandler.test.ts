import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { invalidateUnsummarizedMemoryForChat } from '../src/memoryInvalidation.js'
import { openDatabase } from '../src/db.js'
import {
  createSummarizeMemoryJobBatchHandler,
  createSummarizeMemoryJobHandler,
  type SummarizeMemoryJobHandlerOptions,
} from '../src/memorySummarizeJobHandler.js'
import { MemoryWorker } from '../src/memoryWorker.js'
import {
  cancelMemoryJob,
  createMemoryChunk,
  createMemorySummary,
  enqueueMemoryJob,
  getMemoryChunk,
  getMemoryJob,
  listMemorySummaries,
  updateMemoryChunkStatus,
} from '../src/memoryRepository.js'
import { LEGACY_HYPA_V3_SUMMARY_MODEL } from '../src/memorySummaryCompatibility.js'
import type { SummaryAdapterResult } from '../src/memorySummaryAdapter.js'
import { DEFAULT_SUMMARIZATION_PROMPT } from '../src/memorySummaryPrompt.js'
import { writePersistedWithMessages } from '../src/repository.js'
import { assertScopedLoadOnHotPath } from './helpers/loadCostHarness.js'

const dataDirs: string[] = []

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-memory-summarize-handler-'))
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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

function payload(chunkId = 'chunk-1', rangeStartSeq = 0, rangeEndSeq = 1) {
  return {
    schemaVersion: 1,
    chunkId,
    model: 'subModel',
    rangeStartSeq,
    rangeEndSeq,
    messageIndexes: [rangeStartSeq, rangeEndSeq],
    chatMemos: [`m${rangeStartSeq}`, `m${rangeEndSeq}`],
  }
}

function database(settings: Record<string, unknown> = {}) {
  return {
    subModel: 'gpt-4o-mini',
    openAIKey: 'sk-test',
    providerCredentials: [
      {
        id: 'credential-memory',
        name: 'Memory',
        type: 'apiKey',
        apiKey: 'sk-test',
      },
    ],
    modelProfiles: [
      {
        id: 'profile-memory',
        name: 'Memory',
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        providerOptions: { credentialId: 'credential-memory', requestModel: 'gpt-4o-mini' },
      },
    ],
    modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-memory' } },
    selectedHypaV3PresetId: 'memory-default',
    hypaV3PresetId: 0,
    hypaV3Presets: [
      {
        id: 'memory-default',
        name: 'Default',
        settings: {
          summarizationModel: 'subModel',
          summarizationPrompt: 'Summarize this: {{slot}}',
          reSummarizationPrompt: '',
          ...settings,
        },
      },
    ],
    hypaV3Settings: {
      summarizationPrompt: 'STALE FLAT PROMPT {{slot}}',
      summarizationRequestsPerMinute: 1,
    },
    characters: [{ chats: [{ id: 'chat-1' }] }],
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
    kind: 'summarize',
    payload: jobPayload,
  })
}

function seedBatchJob(
  db: ReturnType<typeof openDatabase>,
  input: {
    id: string
    chunkId: string
    rangeStartSeq: number
    rangeEndSeq: number
    text: string
    nextRunAt?: string
  },
) {
  createMemoryChunk(db, {
    id: input.chunkId,
    chatId: 'chat-1',
    messageId: input.chunkId,
    rangeStartSeq: input.rangeStartSeq,
    rangeEndSeq: input.rangeEndSeq,
    text: input.text,
  })
  return enqueueMemoryJob(db, {
    id: input.id,
    chatId: 'chat-1',
    kind: 'summarize',
    payload: payload(input.chunkId, input.rangeStartSeq, input.rangeEndSeq),
    nextRunAt: input.nextRunAt,
  })
}

describe('summarize memory job handler', () => {
  it('builds the prompt, writes the summary, marks the chunk summarized, and lets the worker complete the job', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedChunkAndJob(db)
      const summarize = vi.fn(async () => ({ text: 'summary text', tokens: 12 }))
      const worker = new MemoryWorker({
        db,
        handlers: {
          summarize: createSummarizeMemoryJobHandler({
            db,
            loadDatabase: database,
            summarize,
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(summarize).toHaveBeenCalledOnce()
      const [messages, opts] = (summarize.mock.calls as any[][])[0]
      expect(messages).toEqual([
        {
          role: 'user',
          content: 'assistant: first\nassistant: second',
        },
        {
          role: 'system',
          content: 'Summarize this: {{slot}}',
        },
      ])
      expect(opts).toMatchObject({
        provider: 'openai',
        model: 'gpt-4o-mini',
        options: { openai: { apiKey: 'sk-test' } },
        maxTokens: 8192,
        temperature: 0,
      })
      expect(listMemorySummaries(db, { chatId: 'chat-1', chunkId: 'chunk-1' })).toEqual([
        expect.objectContaining({
          chatId: 'chat-1',
          chunkId: 'chunk-1',
          model: 'subModel',
          text: 'summary text',
          tokens: 12,
          metadata: expect.objectContaining({
            source: 'hypav3-summarize-job',
            provider: 'openai',
            providerModel: 'gpt-4o-mini',
            jobId: 'job-1',
            chatMemos: ['m0', 'm1'],
          }),
        }),
      ])
      expect(getMemoryChunk(db, 'chunk-1')).toMatchObject({ status: 'summarized' })
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed', error: null })
    } finally {
      db.close()
    }
  })

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['non-string', 42],
  ])('fails closed to normalized settings for a %s stable preset selection', async (_label, selectedPresetId) => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      const invalidSelectionDatabase = {
        ...database({ summarizationPrompt: 'NUMERIC PRESET MUST NOT BE USED {{slot}}' }),
        selectedHypaV3PresetId: selectedPresetId,
        hypaV3PresetId: 0,
      }
      const summarize = vi.fn(async () => ({ text: 'summary text', tokens: 12 }))

      await createSummarizeMemoryJobHandler({
        db,
        loadDatabase: () => invalidSelectionDatabase,
        summarize,
      })(job)

      expect(summarize).toHaveBeenCalledOnce()
      expect((summarize.mock.calls as any[][])[0][0]).toEqual([
        {
          role: 'user',
          content: 'assistant: first\nassistant: second',
        },
        {
          role: 'system',
          content: DEFAULT_SUMMARIZATION_PROMPT,
        },
      ])
      expect(invalidSelectionDatabase.hypaV3Presets).toEqual([expect.objectContaining({ id: 'memory-default' })])
      expect(invalidSelectionDatabase.selectedHypaV3PresetId).toBe(selectedPresetId)
    } finally {
      db.close()
    }
  })

  it.each(['success', 'failure'] as const)(
    'preserves a completed sibling when source invalidation precedes a held provider %s',
    async (late) => {
      const db = openDatabase(makeDataDir())
      let release!: () => void
      let tick: Promise<boolean> | undefined
      try {
        seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', rangeStartSeq: 0, rangeEndSeq: 1, text: 'held source' })
        seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', rangeStartSeq: 2, rangeEndSeq: 3, text: 'valid sibling' })
        const worker = new MemoryWorker({
          db,
          batchHandlers: {
            summarize: createSummarizeMemoryJobBatchHandler({
              db,
              loadDatabase: () => database({ summarizationMaxConcurrent: 2 }),
              sleep: async () => {},
              summarize: async (messages) => {
                if (messages.some((message) => String(message.content).includes('held source'))) {
                  await new Promise<void>((resolve) => {
                    release = resolve
                  })
                  if (late === 'failure') throw new Error('obsolete provider failure')
                }
                return { text: 'Persisted sibling', tokens: 2 }
              },
            }),
          },
        })
        tick = worker.tick()
        await vi.waitFor(() => expect(listMemorySummaries(db, { chatId: 'chat-1' })).toHaveLength(1))
        expect(invalidateUnsummarizedMemoryForChat(db, 'chat-1')).toEqual({ chunksDeleted: 1, jobsDeleted: 1 })
        release()
        await tick
        expect(getMemoryJob(db, 'job-1')).toBeNull()
        expect(getMemoryChunk(db, 'chunk-1')).toBeNull()
        expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed' })
        expect(listMemorySummaries(db, { chatId: 'chat-1' }).map((row) => row.chunkId)).toEqual(['chunk-2'])
      } finally {
        release?.()
        await tick
        db.close()
      }
    },
  )

  it('reuses committed output after the job completion write fails and SQLite reopens', async () => {
    const dataDir = makeDataDir()
    let db = openDatabase(dataDir)
    const summarize = vi.fn(async () => ({ text: 'Exactly one durable summary', tokens: 5 }))
    try {
      seedChunkAndJob(db)
      db.exec(
        "CREATE TRIGGER hold_completion BEFORE UPDATE OF status ON memory_jobs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'completion write failed'); END",
      )
      const worker = new MemoryWorker({
        db,
        retry: { backoffBaseMs: 0 },
        handlers: {
          summarize: createSummarizeMemoryJobHandler({ db, loadDatabase: () => database(), summarize }),
        },
      })
      await worker.tick()
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'pending', attemptCount: 1 })
      expect(listMemorySummaries(db, { chatId: 'chat-1' }).map((row) => row.text)).toEqual([
        'Exactly one durable summary',
      ])
      db.exec('DROP TRIGGER hold_completion')
      db.close()
      db = openDatabase(dataDir)
      const replacement = new MemoryWorker({
        db,
        handlers: {
          summarize: createSummarizeMemoryJobHandler({ db, loadDatabase: () => database(), summarize }),
        },
      })
      await replacement.tick()
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed', attemptCount: 2 })
      expect(listMemorySummaries(db, { chatId: 'chat-1' }).map((row) => row.text)).toEqual([
        'Exactly one durable summary',
      ])
      expect(summarize).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
    }
  })

  it('is idempotent when the target summary already exists', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      const handler = createSummarizeMemoryJobHandler({
        db,
        loadDatabase: database,
        summarize: async () => ({ text: 'summary text', tokens: 0 }),
      })
      await handler(job)
      updateMemoryChunkStatus(db, 'chunk-1', 'pending')

      const summarize = vi.fn(async (): Promise<SummaryAdapterResult> => {
        throw new Error('should not call provider twice')
      })
      await createSummarizeMemoryJobHandler({
        db,
        loadDatabase: database,
        summarize,
      })(job)

      expect(summarize).not.toHaveBeenCalled()
      expect(listMemorySummaries(db, { chatId: 'chat-1', chunkId: 'chunk-1' })).toHaveLength(1)
      expect(getMemoryChunk(db, 'chunk-1')).toMatchObject({ status: 'summarized' })
    } finally {
      db.close()
    }
  })

  it('treats an imported legacy summary as an existing result for a queued active-model job', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      createMemorySummary(db, {
        id: 'legacy-summary',
        chatId: 'chat-1',
        chunkId: 'chunk-1',
        model: LEGACY_HYPA_V3_SUMMARY_MODEL,
        text: 'imported summary',
        metadata: { source: 'legacy-hypav3', chatMemos: ['m0', 'm1'], isImportant: true },
        tokens: 0,
      })
      const summarize = vi.fn(async (): Promise<SummaryAdapterResult> => {
        throw new Error('legacy summary must prevent re-summarization')
      })

      await createSummarizeMemoryJobHandler({ db, loadDatabase: database, summarize })(job)

      expect(summarize).not.toHaveBeenCalled()
      expect(listMemorySummaries(db, { chatId: 'chat-1', chunkId: 'chunk-1' })).toMatchObject([
        { id: 'legacy-summary', model: LEGACY_HYPA_V3_SUMMARY_MODEL, text: 'imported summary' },
      ])
      expect(getMemoryChunk(db, 'chunk-1')).toMatchObject({ status: 'summarized' })
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
        kind: 'summarize',
        payload: payload('missing-chunk'),
      })
      const handler = createSummarizeMemoryJobHandler({
        db,
        loadDatabase: database,
        summarize: async () => ({ text: 'summary', tokens: 0 }),
      })

      await expect(handler(job)).rejects.toThrow('memory chunk not found: missing-chunk')
    } finally {
      db.close()
    }
  })

  it('fails when persisted chat data is missing', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      const handler = createSummarizeMemoryJobHandler({
        db,
        loadDatabase: () => ({ ...database(), characters: [] }),
        summarize: async () => ({ text: 'summary', tokens: 0 }),
      })

      await expect(handler(job)).rejects.toThrow('chat data not found for chat chat-1')
      expect(listMemorySummaries(db, { chatId: 'chat-1', chunkId: 'chunk-1' })).toHaveLength(0)
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
        kind: 'summarize',
        payload: { schemaVersion: 1, chunkId: '', model: 'subModel' },
      })
      const summarize = vi.fn(async () => ({ text: 'summary', tokens: 0 }))
      const handler = createSummarizeMemoryJobHandler({
        db,
        loadDatabase: database,
        summarize,
      })

      await expect(handler(job)).rejects.toThrow('summarize payload chunkId must be a non-empty string')
      expect(summarize).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('fails provider errors and marks the chunk failed for observability', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      const handler = createSummarizeMemoryJobHandler({
        db,
        loadDatabase: database,
        summarize: async () => ({ error: 'provider exploded' }),
      })

      await expect(handler(job)).rejects.toThrow('provider exploded')
      expect(getMemoryChunk(db, 'chunk-1')).toMatchObject({ status: 'failed' })
      expect(listMemorySummaries(db, { chatId: 'chat-1', chunkId: 'chunk-1' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('rolls back invalid summary writes and marks the chunk failed', async () => {
    const db = openDatabase(makeDataDir())
    try {
      const job = seedChunkAndJob(db)
      const handler = createSummarizeMemoryJobHandler({
        db,
        loadDatabase: database,
        summarize: async () => ({ text: '', tokens: 0 }),
      })

      await expect(handler(job)).rejects.toThrow('summary text must be a non-empty string')
      expect(getMemoryChunk(db, 'chunk-1')).toMatchObject({ status: 'failed' })
      expect(listMemorySummaries(db, { chatId: 'chat-1', chunkId: 'chunk-1' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it.each([1, 3])(
    'persists and emits each summary completion during a batch with concurrency %i',
    async (concurrency) => {
      const db = openDatabase(makeDataDir())
      const gates = Array.from({ length: 5 }, () => {
        let resolve!: () => void
        const promise = new Promise<void>((done) => {
          resolve = done
        })
        return { promise, resolve }
      })
      let tick: Promise<boolean> | undefined
      try {
        for (let index = 0; index < gates.length; index += 1) {
          seedBatchJob(db, {
            id: `job-${index + 1}`,
            chunkId: `chunk-${index + 1}`,
            rangeStartSeq: index * 2,
            rangeEndSeq: index * 2 + 1,
            text: `chunk ${index + 1}`,
          })
        }
        const liveStatuses = new Map<string, string>()
        const completions: Array<{ jobId: string; savedSummaries: number }> = []
        const worker = new MemoryWorker({
          db,
          onEvent: (event) => {
            if (event.type !== 'memory.job') return
            liveStatuses.set(event.job.id, event.job.status)
            if (event.job.status === 'completed') {
              completions.push({
                jobId: event.job.id,
                savedSummaries: listMemorySummaries(db, { chatId: 'chat-1' }).length,
              })
            }
          },
          batchHandlers: {
            summarize: createSummarizeMemoryJobBatchHandler({
              db,
              loadDatabase: () => database({ summarizationMaxConcurrent: concurrency }),
              sleep: async () => {},
              summarize: async (messages) => {
                const text = String(messages[0]?.content ?? '')
                const index = Number(text.split(' ')[1]) - 1
                await gates[index].promise
                return { text: `summary for ${text}`, tokens: 1 }
              },
            }),
          },
        })

        tick = worker.tick()
        await flushMicrotasks()
        expect([...liveStatuses.values()]).toEqual(Array(5).fill('running'))

        // A slow first request must not delay completion updates for later jobs.
        const completionOrder = concurrency === 1 ? [1, 2, 3, 4, 5] : [3, 4, 5, 2, 1]
        for (const [index, jobNumber] of completionOrder.entries()) {
          gates[jobNumber - 1].resolve()
          await flushMicrotasks()

          expect(completions).toHaveLength(index + 1)
          expect(completions.at(-1)).toEqual({ jobId: `job-${jobNumber}`, savedSummaries: index + 1 })
          expect([...liveStatuses.values()].filter((status) => status === 'running')).toHaveLength(4 - index)
          expect(getMemoryJob(db, `job-${jobNumber}`)).toMatchObject({ status: 'completed' })
          if (index < 4) expect(worker.isProcessing).toBe(true)
        }

        await expect(tick).resolves.toBe(true)
        expect(listMemorySummaries(db, { chatId: 'chat-1' }).map((summary) => summary.chunkId)).toEqual([
          'chunk-1',
          'chunk-2',
          'chunk-3',
          'chunk-4',
          'chunk-5',
        ])
      } finally {
        for (const gate of gates) gate.resolve()
        await tick
        db.close()
      }
    },
  )

  it('commits batch summaries independently after a sibling write fails', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'chunk one',
        nextRunAt: '2026-05-25T00:00:00.000Z',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        rangeStartSeq: 2,
        rangeEndSeq: 3,
        text: 'chunk two',
        nextRunAt: '2026-05-25T00:00:00.000Z',
      })
      seedBatchJob(db, {
        id: 'job-3',
        chunkId: 'chunk-3',
        rangeStartSeq: 4,
        rangeEndSeq: 5,
        text: 'chunk three',
        nextRunAt: '2026-05-25T00:00:00.000Z',
      })
      const worker = new MemoryWorker({
        db,
        retry: {
          now: '2026-05-25T00:00:00.000Z',
          backoffBaseMs: 1_000,
        },
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ summarizationMaxConcurrent: 3 }),
            // The rate-limit delay is covered separately. This case exercises
            // independent persistence after one sibling result is invalid.
            sleep: async () => {},
            summarize: async (messages) => {
              const text = String(messages[0]?.content ?? '')
              if (text.includes('chunk two')) return { text: '', tokens: 0 }
              return { text: `summary for ${text}`, tokens: 1 }
            },
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(listMemorySummaries(db, { chatId: 'chat-1' }).map((summary) => summary.chunkId)).toEqual([
        'chunk-1',
        'chunk-3',
      ])
      expect(getMemoryChunk(db, 'chunk-1')).toMatchObject({ status: 'summarized' })
      expect(getMemoryChunk(db, 'chunk-2')).toMatchObject({ status: 'failed' })
      expect(getMemoryChunk(db, 'chunk-3')).toMatchObject({ status: 'summarized' })
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed', error: null })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({
        status: 'pending',
        error: 'summary text must be a non-empty string',
        nextRunAt: '2026-05-25T00:00:01.000Z',
      })
      expect(getMemoryJob(db, 'job-3')).toMatchObject({ status: 'completed', error: null })
    } finally {
      db.close()
    }
  })

  it('commits independent summarize jobs after a sibling provider failure', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'chunk one',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        rangeStartSeq: 2,
        rangeEndSeq: 3,
        text: 'chunk two',
      })
      seedBatchJob(db, {
        id: 'job-3',
        chunkId: 'chunk-3',
        rangeStartSeq: 4,
        rangeEndSeq: 5,
        text: 'chunk three',
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ summarizationMaxConcurrent: 3 }),
            sleep: async () => {},
            summarize: async (messages) => {
              const text = String(messages[0]?.content ?? '')
              if (text.includes('chunk two')) return { error: 'provider transient' }
              return { text: `summary for ${text}`, tokens: 1 }
            },
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(
        listMemorySummaries(db, { chatId: 'chat-1' })
          .map((summary) => summary.chunkId)
          .sort(),
      ).toEqual(['chunk-1', 'chunk-3'])
      expect(getMemoryChunk(db, 'chunk-1')).toMatchObject({ status: 'summarized' })
      expect(getMemoryChunk(db, 'chunk-2')).toMatchObject({ status: 'failed' })
      expect(getMemoryChunk(db, 'chunk-3')).toMatchObject({ status: 'summarized' })
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

  it('limits batch provider dispatch by summarizationMaxConcurrent', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'chunk one',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        rangeStartSeq: 2,
        rangeEndSeq: 3,
        text: 'chunk two',
      })
      seedBatchJob(db, {
        id: 'job-3',
        chunkId: 'chunk-3',
        rangeStartSeq: 4,
        rangeEndSeq: 5,
        text: 'chunk three',
      })
      let active = 0
      let maxActive = 0
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ summarizationMaxConcurrent: 2 }),
            sleep: async () => {},
            summarize: async () => {
              active += 1
              maxActive = Math.max(maxActive, active)
              await Promise.resolve()
              active -= 1
              return { text: 'summary', tokens: 1 }
            },
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(maxActive).toBeLessThanOrEqual(2)
      expect(
        listMemorySummaries(db, { chatId: 'chat-1' })
          .map((summary) => summary.chunkId)
          .sort(),
      ).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
      expect(getMemoryJob(db, 'job-3')).toMatchObject({ status: 'completed', attemptCount: 1 })
    } finally {
      db.close()
    }
  })

  it('applies summarizationRequestsPerMinute between provider dispatches', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'chunk one',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        rangeStartSeq: 2,
        rangeEndSeq: 3,
        text: 'chunk two',
      })
      let now = 0
      const sleeps: number[] = []
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ summarizationMaxConcurrent: 2, summarizationRequestsPerMinute: 60 }),
            now: () => now,
            sleep: async (ms) => {
              sleeps.push(ms)
              now += ms
            },
            summarize: async () => ({ text: 'summary', tokens: 1 }),
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(sleeps).toEqual([1_000])
      expect(listMemorySummaries(db, { chatId: 'chat-1' })).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('aborts a hung summarize fetch through runOpenAI within the deadline', async () => {
    vi.useFakeTimers()
    const db = openDatabase(makeDataDir())
    try {
      seedChunkAndJob(db)
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = (): void => reject(new Error('aborted'))
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            providerFetchDeadlineMs: 25,
            sleep: async () => {},
          }),
        },
      })

      const tick = worker.tick()
      await flushMicrotasks()

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'running' })

      await vi.advanceTimersByTimeAsync(25)
      await expect(tick).resolves.toBe(true)

      expect(getMemoryJob(db, 'job-1')).toMatchObject({
        status: 'pending',
        error: 'aborted',
      })
      expect(getMemoryChunk(db, 'chunk-1')).toMatchObject({ status: 'failed' })
      expect(listMemorySummaries(db, { chatId: 'chat-1' })).toHaveLength(0)
      expect(worker.isProcessing).toBe(false)
    } finally {
      db.close()
    }
  })

  it.each(['success', 'failure'] as const)(
    'retires an abort-insensitive summary request and ignores its late %s after a sibling and recreated instance complete',
    async (late) => {
      vi.useFakeTimers()
      const db = openDatabase(makeDataDir())
      let release!: () => void
      let tick: Promise<boolean> | undefined
      try {
        seedBatchJob(db, { id: 'job-1', chunkId: 'chunk-1', rangeStartSeq: 0, rangeEndSeq: 1, text: 'held source' })
        seedBatchJob(db, { id: 'job-2', chunkId: 'chunk-2', rangeStartSeq: 2, rangeEndSeq: 3, text: 'sibling source' })
        let holdFirst = true
        const summarize = vi.fn(async (messages: readonly { content: string }[]) => {
          if (holdFirst && messages.some((message) => message.content.includes('held source'))) {
            holdFirst = false
            await new Promise<void>((resolve) => {
              release = resolve
            })
            if (late === 'failure') throw new Error('retired failure')
          }
          return { text: 'Current sibling summary', tokens: 4 }
        })
        const worker = new MemoryWorker({
          db,
          batchHandlers: {
            summarize: createSummarizeMemoryJobBatchHandler({
              db,
              loadDatabase: () => database({ summarizationMaxConcurrent: 1 }),
              summarize: summarize as never,
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
        expect(listMemorySummaries(db, { chatId: 'chat-1' }).map((row) => row.chunkId)).toEqual(['chunk-2'])
        const previous = getMemoryJob(db, 'job-1')!
        db.prepare('DELETE FROM memory_jobs WHERE id = ?').run(previous.id)
        const replacement = enqueueMemoryJob(db, {
          id: previous.id,
          chatId: previous.chatId,
          kind: 'summarize',
          payload: previous.payload,
        })
        expect(replacement.instanceId).not.toBe(previous.instanceId)
        await worker.tick()
        expect(getMemoryJob(db, previous.id)).toMatchObject({ instanceId: replacement.instanceId, status: 'completed' })
        const currentOutput = listMemorySummaries(db, { chatId: 'chat-1' })
        expect(currentOutput).toHaveLength(2)
        release()
        await vi.advanceTimersByTimeAsync(0)
        expect(listMemorySummaries(db, { chatId: 'chat-1' })).toEqual(currentOutput)
        expect(getMemoryJob(db, previous.id)).toMatchObject({ instanceId: replacement.instanceId, status: 'completed' })
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        release?.()
        await tick
        db.close()
      }
    },
  )

  it('forwards worker cancellation to the running provider signal and retains cancelled state', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedChunkAndJob(db)
      let providerSignal: AbortSignal | undefined
      const summarize: NonNullable<SummarizeMemoryJobHandlerOptions['summarize']> = vi.fn(
        async (_messages, opts): Promise<SummaryAdapterResult> => {
          providerSignal = opts.signal
          return new Promise<SummaryAdapterResult>((_resolve, reject) => {
            const onAbort = (): void => reject(new Error('provider aborted by cancellation'))
            if (opts.signal?.aborted) {
              onAbort()
              return
            }
            opts.signal?.addEventListener('abort', onAbort, { once: true })
          })
        },
      )
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({
            db,
            loadDatabase: database,
            summarize,
          }),
        },
      })

      const tick = worker.tick()
      await flushMicrotasks()
      expect(providerSignal).toBeDefined()
      expect(cancelMemoryJob(db, 'job-1')).toMatchObject({ status: 'cancelled' })
      expect(worker.abortRunningJob('job-1')).toBe(true)
      await expect(tick).resolves.toBe(true)

      expect(providerSignal?.aborted).toBe(true)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'cancelled' })
      expect(listMemorySummaries(db, { chatId: 'chat-1' })).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('scopes batch cancellation to the addressed provider job', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'chunk one',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        rangeStartSeq: 2,
        rangeEndSeq: 3,
        text: 'chunk two',
      })
      const providerSignals = new Map<string, AbortSignal>()
      let finishSecond!: () => void
      const secondGate = new Promise<void>((resolve) => {
        finishSecond = resolve
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ summarizationMaxConcurrent: 2 }),
            sleep: async () => {},
            summarize: async (messages, opts) => {
              const text = String(messages[0]?.content ?? '')
              const jobId = text.includes('chunk one') ? 'job-1' : 'job-2'
              if (opts.signal) providerSignals.set(jobId, opts.signal)
              if (jobId === 'job-2') {
                await secondGate
                return { text: 'second summary', tokens: 1 }
              }
              return new Promise<SummaryAdapterResult>((_resolve, reject) => {
                opts.signal?.addEventListener('abort', () => reject(new Error('first cancelled')), { once: true })
              })
            },
          }),
        },
      })

      const tick = worker.tick()
      await flushMicrotasks()
      expect(providerSignals.size).toBe(2)
      expect(cancelMemoryJob(db, 'job-1')).toMatchObject({ status: 'cancelled' })
      expect(worker.abortRunningJob('job-1')).toBe(true)
      expect(providerSignals.get('job-1')?.aborted).toBe(true)
      expect(providerSignals.get('job-2')?.aborted).toBe(false)
      finishSecond()
      await expect(tick).resolves.toBe(true)

      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'cancelled' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed', attemptCount: 1 })
      expect(listMemorySummaries(db, { chatId: 'chat-1' })).toEqual([
        expect.objectContaining({ chunkId: 'chunk-2', text: 'second summary' }),
      ])
    } finally {
      db.close()
    }
  })

  it('commits a sibling summary after another running batch job is cancelled', async () => {
    const db = openDatabase(makeDataDir())
    try {
      seedBatchJob(db, {
        id: 'job-1',
        chunkId: 'chunk-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'chunk one',
      })
      seedBatchJob(db, {
        id: 'job-2',
        chunkId: 'chunk-2',
        rangeStartSeq: 2,
        rangeEndSeq: 3,
        text: 'chunk two',
      })
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({
            db,
            loadDatabase: () => database({ summarizationMaxConcurrent: 2 }),
            sleep: async () => {},
            summarize: async (messages) => {
              const text = String(messages[0]?.content ?? '')
              if (text.includes('chunk one')) cancelMemoryJob(db, 'job-1')
              return { text: 'summary', tokens: 1 }
            },
          }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(listMemorySummaries(db, { chatId: 'chat-1' })).toEqual([
        expect.objectContaining({ chunkId: 'chunk-2', text: 'summary' }),
      ])
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'cancelled' })
      expect(getMemoryJob(db, 'job-2')).toMatchObject({ status: 'completed', error: null })
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
      seedChunkAndJob(db)
      const summarize = vi.fn(async () => ({ text: 'summary text', tokens: 12 }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          // No loadDatabase injection: the default dataDir path is under test.
          summarize: createSummarizeMemoryJobBatchHandler({ db, dataDir, summarize }),
        },
      })

      // hypa_v3_presets is the one collection the memory path legitimately
      // reads whole (it is the settings source); everything else must stay
      // scoped — chat existence is checked via id-only stubs, never the
      // characters/chats/messages payload parse.
      await assertScopedLoadOnHotPath(() => worker.tick(), {
        allowTables: ['hypa_v3_presets'],
      })

      expect(summarize).toHaveBeenCalledOnce()
      expect(listMemorySummaries(db, { chatId: 'chat-1' })).toHaveLength(1)
      expect(getMemoryJob(db, 'job-1')).toMatchObject({ status: 'completed' })
    } finally {
      db.close()
    }
  })

  it('uses the memory role from the model preset bound to the target chat', async () => {
    const dataDir = makeDataDir()
    const db = openDatabase(dataDir)
    try {
      writePersistedWithMessages(db, dataDir, {
        _version: 4,
        database: {
          ...database(),
          modelRoles: { memory: 'gpt4om' },
          modelPresetsId: 0,
          promptPresetsId: 0,
          modelPresets: [
            {
              id: 'model-global',
              name: 'Global model',
              modelRoles: { memory: 'gpt4om' },
              modelProfiles: [
                {
                  id: 'profile-global-memory',
                  name: 'Global memory',
                  providerId: 'openai',
                  modelId: 'gpt-4o-mini',
                  providerOptions: { credentialId: 'credential-memory', requestModel: 'gpt-4o-mini' },
                },
              ],
              modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-global-memory' } },
            },
            {
              id: 'model-chat',
              name: 'Chat model',
              modelRoles: { memory: 'gpt41-mini' },
              modelProfiles: [
                {
                  id: 'profile-chat-memory',
                  name: 'Chat memory',
                  providerId: 'openai',
                  modelId: 'gpt41-mini',
                  providerOptions: { credentialId: 'credential-memory', requestModel: 'gpt41-mini' },
                },
              ],
              modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-chat-memory' } },
            },
          ],
          promptPresets: [{ id: 'prompt-chat', name: 'Chat prompt' }],
          characters: [
            {
              chaId: 'char-1',
              type: 'character',
              name: 'Tess',
              chats: [
                {
                  id: 'chat-1',
                  name: 'main',
                  generationSettings: {
                    configured: true,
                    modelPresetId: 'model-chat',
                    promptPresetId: 'prompt-chat',
                  },
                  message: [{ role: 'user', data: 'hello' }],
                },
              ],
            },
          ],
        },
        assets: [],
      } as never)
      seedChunkAndJob(db)
      const summarize = vi.fn(async () => ({ text: 'chat-bound summary', tokens: 7 }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({ db, dataDir, summarize }),
        },
      })

      await assertScopedLoadOnHotPath(() => worker.tick(), {
        allowTables: ['hypa_v3_presets'],
      })

      expect(summarize).toHaveBeenCalledOnce()
      const [, request] = (summarize.mock.calls as any[][])[0]
      expect(request).toMatchObject({
        provider: 'openai',
        model: 'gpt41-mini',
        options: { openai: { apiKey: 'sk-test' } },
      })
      expect(listMemorySummaries(db, { chatId: 'chat-1' })).toEqual([
        expect.objectContaining({
          text: 'chat-bound summary',
          metadata: expect.objectContaining({ providerModel: 'gpt41-mini' }),
        }),
      ])
    } finally {
      db.close()
    }
  })

  it('an unknown chat fails with the same chat-not-found error through the scoped loader', async () => {
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
              chats: [{ id: 'chat-1', name: 'main', message: [] }],
            },
          ],
        },
        assets: [],
      } as never)
      createMemoryChunk(db, {
        id: 'chunk-x',
        chatId: 'chat-9',
        messageId: 'm1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'assistant: orphaned',
      })
      enqueueMemoryJob(db, {
        id: 'job-x',
        chatId: 'chat-9',
        kind: 'summarize',
        payload: payload('chunk-x'),
      })
      const summarize = vi.fn(async () => ({ text: 'should not run', tokens: 1 }))
      const worker = new MemoryWorker({
        db,
        batchHandlers: {
          summarize: createSummarizeMemoryJobBatchHandler({ db, dataDir, summarize }),
        },
      })

      expect(await worker.tick()).toBe(true)

      expect(summarize).not.toHaveBeenCalled()
      expect(getMemoryJob(db, 'job-x')).toMatchObject({
        status: 'pending',
        error: 'chat data not found for chat chat-9',
      })
    } finally {
      db.close()
    }
  })
})
