import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { buildSummarizeJobId, type HypaV3SummarizeJobPayload } from '../memoryChunkPlanner.js'
import {
  enqueueMemoryJob,
  getMemoryChunk,
  getMemoryJob,
  listMemoryEmbeddings,
  listMemorySummaries,
  type EnqueueMemoryJobInput,
  type MemoryJob,
} from '../memoryRepository.js'
import type { PromptMemoryMissingMemoryDiagnostics } from './memoryAdapter.js'
import type { PersistedGenerationScope } from '../generationScope.js'
import { isMemorySummaryCompatibleWithModel } from '../memorySummaryCompatibility.js'

const EMBED_JOB_ID_PREFIX = 'hypav3-embed'
const EMBED_PAYLOAD_SCHEMA_VERSION = 1

export interface PromptMemoryFollowUpDiagnostics {
  attempted: boolean
  jobsCreated: number
  existingJobs: number
  summarizeChunkIds: string[]
  embedChunkIds: string[]
  skippedChunkIdsMissingSummaries: string[]
  skippedChunkIdsMissingEmbeddings: string[]
  skippedSummaryIdsMissingChunks: string[]
  errors: string[]
}

export interface EnqueuePromptMemoryFollowUpsInput {
  db: DatabaseSync
  chatId: string
  summaryModel: string
  embeddingModel: string
  diagnostics: PromptMemoryMissingMemoryDiagnostics
  operationId?: string
  operationAttemptNo?: number
  generationScope?: PersistedGenerationScope
  enqueueJob?: (job: EnqueueMemoryJobInput) => MemoryJob
  onJobCreated?: (job: MemoryJob) => void
}

interface HypaV3EmbedJobPayload {
  schemaVersion: 1
  chunkId: string
  model: string
}

export function enqueuePromptMemoryFollowUps(
  input: EnqueuePromptMemoryFollowUpsInput,
): PromptMemoryFollowUpDiagnostics {
  const result = emptyPromptMemoryFollowUpDiagnostics()
  if (!input.diagnostics.followUpEligible || !input.diagnostics.hasMissingMemory) {
    return result
  }

  result.attempted = true
  const enqueueJob = input.enqueueJob ?? ((job) => enqueueMemoryJob(input.db, job))

  for (const chunkId of sortedUnique(input.diagnostics.chunkIdsMissingSummaries)) {
    const chunk = getMemoryChunk(input.db, chunkId)
    if (!chunk || chunk.chatId !== input.chatId) {
      result.skippedChunkIdsMissingSummaries.push(chunkId)
      continue
    }
    const existingSummary = listMemorySummaries(input.db, { chatId: input.chatId, chunkId }).find((summary) =>
      isMemorySummaryCompatibleWithModel(summary, input.summaryModel),
    )
    if (existingSummary) continue

    const payload: HypaV3SummarizeJobPayload = {
      schemaVersion: 1,
      chunkId,
      model: input.summaryModel,
      rangeStartSeq: chunk.rangeStartSeq,
      rangeEndSeq: chunk.rangeEndSeq,
      messageIndexes: rangeInclusive(chunk.rangeStartSeq, chunk.rangeEndSeq),
      chatMemos: chunk.messageId ? [chunk.messageId] : [],
    }
    enqueueIdempotentJob(input.db, result, enqueueJob, input.onJobCreated, {
      id: buildSummarizeJobId(input.chatId, chunkId, input.summaryModel),
      chatId: input.chatId,
      kind: 'summarize',
      payload,
      operationId: input.operationId,
      operationAttemptNo: input.operationAttemptNo,
      generationScope: input.generationScope,
    })
    result.summarizeChunkIds.push(chunkId)
  }

  for (const chunkId of sortedUnique(input.diagnostics.chunkIdsMissingEmbeddings)) {
    const chunk = getMemoryChunk(input.db, chunkId)
    if (!chunk || chunk.chatId !== input.chatId) {
      result.skippedChunkIdsMissingEmbeddings.push(chunkId)
      continue
    }
    const existingEmbedding = listMemoryEmbeddings(input.db, {
      chatId: input.chatId,
      chunkId,
      model: input.embeddingModel,
    })[0]
    if (existingEmbedding) continue

    const payload: HypaV3EmbedJobPayload = {
      schemaVersion: EMBED_PAYLOAD_SCHEMA_VERSION,
      chunkId,
      model: input.embeddingModel,
    }
    enqueueIdempotentJob(input.db, result, enqueueJob, input.onJobCreated, {
      id: buildEmbedJobId(input.chatId, chunkId, input.embeddingModel),
      chatId: input.chatId,
      kind: 'embed',
      payload,
      operationId: input.operationId,
      operationAttemptNo: input.operationAttemptNo,
      generationScope: input.generationScope,
    })
    result.embedChunkIds.push(chunkId)
  }

  result.skippedSummaryIdsMissingChunks.push(...sortedUnique(input.diagnostics.summaryIdsMissingChunks))
  return result
}

export function emptyPromptMemoryFollowUpDiagnostics(): PromptMemoryFollowUpDiagnostics {
  return {
    attempted: false,
    jobsCreated: 0,
    existingJobs: 0,
    summarizeChunkIds: [],
    embedChunkIds: [],
    skippedChunkIdsMissingSummaries: [],
    skippedChunkIdsMissingEmbeddings: [],
    skippedSummaryIdsMissingChunks: [],
    errors: [],
  }
}

function enqueueIdempotentJob(
  db: DatabaseSync,
  diagnostics: PromptMemoryFollowUpDiagnostics,
  enqueueJob: (job: EnqueueMemoryJobInput) => MemoryJob,
  onJobCreated: ((job: MemoryJob) => void) | undefined,
  job: EnqueueMemoryJobInput,
): void {
  if (getMemoryJob(db, job.id)) {
    diagnostics.existingJobs += 1
    return
  }
  try {
    const created = enqueueJob(job)
    diagnostics.jobsCreated += 1
    onJobCreated?.(created)
  } catch (error) {
    diagnostics.errors.push(errorMessage(error))
  }
}

function buildEmbedJobId(chatId: string, chunkId: string, model: string): string {
  return `${EMBED_JOB_ID_PREFIX}-${shortHash(JSON.stringify({ chatId, chunkId, model }))}`
}

function rangeInclusive(start: number, end: number): number[] {
  const values: number[] = []
  for (let value = start; value <= end; value += 1) values.push(value)
  return values
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'failed to enqueue prompt memory follow-up job'
}
