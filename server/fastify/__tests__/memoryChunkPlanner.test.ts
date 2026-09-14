import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/db.js'
import { planHypaV3ChunkJobs } from '../src/memoryChunkPlanner.js'
import { planStandardHypaV3Memory } from '../src/memoryPlanner.js'
import { listMemoryChunks, listMemoryJobs, updateMemoryChunkStatus } from '../src/memoryRepository.js'
import type { PromptMessage } from '../src/prompt/promptMessage.js'

const dataDirs: string[] = []

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-memory-chunk-planner-'))
  dataDirs.push(dataDir)
  return dataDir
}

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

function chat(memo: string, content = memo, role: PromptMessage['role'] = 'assistant'): PromptMessage {
  return { role, content, memo }
}

function fixedTokenizer(tokensByMemo: Record<string, number>, memoryTokens = 7) {
  return (item: PromptMessage): number => {
    if (item.memo && item.memo in tokensByMemo) return tokensByMemo[item.memo]
    if (item.content.startsWith('<Past Events Summary>')) return memoryTokens
    return 5
  }
}

describe('Hypa V3 chunk/job planning bridge', () => {
  it('persists planner windows as ordered chunks and summarize jobs', () => {
    const db = openDatabase(makeDataDir())
    try {
      const chats = ['m0', 'm1', 'm2', 'm3', 'tail'].map((memo) => chat(memo))
      const plan = planStandardHypaV3Memory({
        chats,
        currentTokens: 120,
        maxContextTokens: 100,
        maxResponseTokens: 0,
        settings: {
          maxChatsPerSummary: 2,
          queryChatCount: 1,
          summarizationModel: 'subModel',
        },
        tokenizeChat: fixedTokenizer({ m0: 10, m1: 10, m2: 10, m3: 10, tail: 10 }),
      })

      expect(plan.errors).toEqual([])
      const visiblePendingJobs: string[] = []
      const result = planHypaV3ChunkJobs({
        db,
        chatId: 'chat-1',
        chats,
        plan,
        onJobCreated: (job) => {
          expect(job.status).toBe('pending')
          expect(job.instanceId).not.toBe('')
          expect(listMemoryJobs(db, { chatId: 'chat-1' }).map((current) => current.id)).toContain(job.id)
          visiblePendingJobs.push(job.id)
        },
      })

      expect(result.chunksCreated).toBe(2)
      expect(result.jobsCreated).toBe(2)
      expect(visiblePendingJobs).toEqual(result.planned.map((entry) => entry.job!.id))
      expect(result.planned.map((entry) => entry.chunk.rangeStartSeq)).toEqual([0, 2])
      expect(result.planned.map((entry) => entry.chunk.rangeEndSeq)).toEqual([1, 3])
      expect(result.planned.map((entry) => entry.chunk.text)).toEqual([
        'assistant: m0\nassistant: m1',
        'assistant: m2\nassistant: m3',
      ])
      expect(result.planned.map((entry) => entry.job?.payload)).toEqual([
        {
          schemaVersion: 1,
          chunkId: result.planned[0].chunk.id,
          model: 'subModel',
          rangeStartSeq: 0,
          rangeEndSeq: 1,
          messageIndexes: [0, 1],
          chatMemos: ['m0', 'm1'],
        },
        {
          schemaVersion: 1,
          chunkId: result.planned[1].chunk.id,
          model: 'subModel',
          rangeStartSeq: 2,
          rangeEndSeq: 3,
          messageIndexes: [2, 3],
          chatMemos: ['m2', 'm3'],
        },
      ])
      expect(listMemoryChunks(db, { chatId: 'chat-1' }).map((row) => row.id)).toEqual(
        result.planned.map((entry) => entry.chunk.id),
      )
      expect(
        listMemoryJobs(db, { chatId: 'chat-1', kind: 'summarize' })
          .map((row) => row.id)
          .sort(),
      ).toEqual(result.planned.map((entry) => entry.job?.id).sort())
    } finally {
      db.close()
    }
  })

  it('is idempotent when the same chat ranges are planned repeatedly', () => {
    const db = openDatabase(makeDataDir())
    try {
      const chats = ['m0', 'm1', 'm2', 'tail'].map((memo) => chat(memo))
      const plan = planStandardHypaV3Memory({
        chats,
        currentTokens: 100,
        maxContextTokens: 100,
        maxResponseTokens: 0,
        settings: {
          maxChatsPerSummary: 2,
          queryChatCount: 1,
          summarizationModel: 'subModel',
        },
        tokenizeChat: fixedTokenizer({ m0: 10, m1: 10, m2: 10, tail: 10 }),
      })
      const first = planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan })
      const second = planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan })

      expect(first.chunksCreated).toBe(1)
      expect(first.jobsCreated).toBe(1)
      expect(second.chunksCreated).toBe(0)
      expect(second.jobsCreated).toBe(0)
      expect(second.planned[0].chunk.id).toBe(first.planned[0].chunk.id)
      expect(second.planned[0].job?.id).toBe(first.planned[0].job?.id)
      expect(listMemoryChunks(db, { chatId: 'chat-1' })).toHaveLength(1)
      expect(listMemoryJobs(db, { chatId: 'chat-1', kind: 'summarize' })).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('binds an untouched preview-planned job to the first accepted operation without rewriting that authority', () => {
    const db = openDatabase(makeDataDir())
    try {
      const chats = ['m0', 'm1', 'm2', 'tail'].map((memo) => chat(memo))
      const plan = planStandardHypaV3Memory({
        chats,
        currentTokens: 100,
        maxContextTokens: 100,
        maxResponseTokens: 0,
        settings: {
          maxChatsPerSummary: 2,
          queryChatCount: 1,
          summarizationModel: 'subModel',
        },
        tokenizeChat: fixedTokenizer({ m0: 10, m1: 10, m2: 10, tail: 10 }),
      })
      const preview = planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan })
      const accepted = planHypaV3ChunkJobs({
        db,
        chatId: 'chat-1',
        chats,
        plan,
        operationId: 'operation-accepted',
        operationAttemptNo: 2,
        generationScope: { admissionKind: 'legacy_owner' },
      })

      expect(accepted.jobsCreated).toBe(0)
      expect(accepted.planned[0].job).toMatchObject({
        id: preview.planned[0].job?.id,
        instanceId: preview.planned[0].job?.instanceId,
        operationId: 'operation-accepted',
        operationAttemptNo: 2,
        generationScope: { admissionKind: 'legacy_owner' },
      })

      const laterOperation = planHypaV3ChunkJobs({
        db,
        chatId: 'chat-1',
        chats,
        plan,
        operationId: 'operation-later',
        operationAttemptNo: 1,
        generationScope: { admissionKind: 'chat_only' },
      })
      expect(laterOperation.planned[0].job).toMatchObject({
        operationId: 'operation-accepted',
        operationAttemptNo: 2,
        generationScope: { admissionKind: 'legacy_owner' },
      })
    } finally {
      db.close()
    }
  })

  it('does not reset summarized chunks during replanning', () => {
    const db = openDatabase(makeDataDir())
    try {
      const chats = ['m0', 'm1', 'm2', 'tail'].map((memo) => chat(memo))
      const plan = planStandardHypaV3Memory({
        chats,
        currentTokens: 100,
        maxContextTokens: 100,
        maxResponseTokens: 0,
        settings: {
          maxChatsPerSummary: 2,
          queryChatCount: 1,
          summarizationModel: 'subModel',
        },
        tokenizeChat: fixedTokenizer({ m0: 10, m1: 10, m2: 10, tail: 10 }),
      })
      const first = planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan })
      updateMemoryChunkStatus(db, first.planned[0].chunk.id, 'summarized')

      const second = planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan })

      expect(second.chunksCreated).toBe(0)
      expect(second.jobsCreated).toBe(0)
      expect(second.planned[0].chunk.status).toBe('summarized')
      expect(listMemoryChunks(db, { chatId: 'chat-1', status: 'summarized' })).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('uses only planner-selected message indexes for chunk text and payload memos', () => {
    const db = openDatabase(makeDataDir())
    try {
      const chats: PromptMessage[] = [
        { role: 'user', content: 'example', memo: 'e0', name: 'example_user' },
        chat('NewChat', '[Start a new chat]', 'system'),
        chat('empty', '   '),
        chat('user', 'hello', 'user'),
        chat('assistant', ' reply with spaces '),
        chat('tail', 'tail'),
      ]
      const plan = planStandardHypaV3Memory({
        chats,
        currentTokens: 130,
        maxContextTokens: 100,
        maxResponseTokens: 0,
        settings: {
          doNotSummarizeUserMessage: true,
          maxChatsPerSummary: 5,
          queryChatCount: 1,
          summarizationModel: 'subModel',
        },
        tokenizeChat: fixedTokenizer({
          e0: 10,
          NewChat: 10,
          empty: 10,
          user: 10,
          assistant: 10,
          tail: 10,
        }),
      })

      expect(plan.errors).toEqual([])
      const result = planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan })

      expect(result.planned).toHaveLength(1)
      expect(result.planned[0].chunk.text).toBe('assistant: reply with spaces')
      expect(result.planned[0].payload).toMatchObject({
        rangeStartSeq: 0,
        rangeEndSeq: 4,
        messageIndexes: [4],
        chatMemos: ['assistant'],
      })
    } finally {
      db.close()
    }
  })

  it('does not persist rows when planning produced errors or no windows', () => {
    const db = openDatabase(makeDataDir())
    try {
      const chats = [chat('m0'), chat('m1'), chat('m2')]
      const errored = planStandardHypaV3Memory({
        chats,
        currentTokens: 130,
        maxContextTokens: 100,
        maxResponseTokens: 0,
        settings: { queryChatCount: 3 },
        tokenizeChat: fixedTokenizer({ m0: 10, m1: 10, m2: 10 }),
      })
      const empty = planStandardHypaV3Memory({
        chats,
        currentTokens: 80,
        maxContextTokens: 100,
        maxResponseTokens: 0,
        tokenizeChat: fixedTokenizer({ m0: 10, m1: 10, m2: 10 }),
      })

      expect(planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan: errored })).toEqual({
        planned: [],
        chunksCreated: 0,
        jobsCreated: 0,
      })
      expect(planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan: empty })).toEqual({
        planned: [],
        chunksCreated: 0,
        jobsCreated: 0,
      })
      expect(listMemoryChunks(db, { chatId: 'chat-1' })).toEqual([])
      expect(listMemoryJobs(db, { chatId: 'chat-1' })).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects unsupported client-only summarizers before creating jobs', () => {
    const db = openDatabase(makeDataDir())
    try {
      const chats = ['m0', 'm1', 'm2', 'm3', 'tail'].map((memo) => chat(memo))
      const plan = planStandardHypaV3Memory({
        chats,
        currentTokens: 120,
        maxContextTokens: 100,
        maxResponseTokens: 0,
        settings: {
          maxChatsPerSummary: 2,
          queryChatCount: 1,
          summarizationModel: 'Qwen3-4B-q4f32_1-MLC',
        },
        tokenizeChat: fixedTokenizer({ m0: 10, m1: 10, m2: 10, m3: 10, tail: 10 }),
      })

      expect(plan.plannedWindows.length).toBeGreaterThan(0)

      expect(() => planHypaV3ChunkJobs({ db, chatId: 'chat-1', chats, plan })).toThrow(
        'server-side memory summarization supports only subModel or memory',
      )
      expect(listMemoryChunks(db, { chatId: 'chat-1' })).toEqual([])
      expect(listMemoryJobs(db, { chatId: 'chat-1' })).toEqual([])
    } finally {
      db.close()
    }
  })
})
