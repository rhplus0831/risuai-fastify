import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HypaV3MemoryPlan, HypaV3PlannedWindow } from './memoryPlanner.js'
import type { PromptMessage } from './prompt/promptMessage.js'
import { scopeSqlValues, type PersistedGenerationScope } from './generationScope.js'
import {
  createMemoryChunk,
  enqueueMemoryJob,
  getMemoryChunk,
  getMemoryJob,
  type MemoryChunk,
  type MemoryJob,
} from './memoryRepository.js'
import { sanitizeSummaryMessageContent } from './memorySummaryPrompt.js'
import { ValidationError } from './repository.js'

const CHUNK_ID_PREFIX = 'hypav3-chunk'
const SUMMARIZE_JOB_ID_PREFIX = 'hypav3-summarize'
const SUMMARIZE_PAYLOAD_SCHEMA_VERSION = 1

export interface HypaV3SummarizeJobPayload {
  schemaVersion: 1
  chunkId: string
  model: string
  rangeStartSeq: number
  rangeEndSeq: number
  messageIndexes: number[]
  chatMemos: string[]
}

export interface PlanHypaV3ChunkJobsInput {
  db: DatabaseSync
  chatId: string
  chats: readonly PromptMessage[]
  plan: HypaV3MemoryPlan
  model?: string
  maxAttempts?: number
  nextRunAt?: string
  operationId?: string
  operationAttemptNo?: number
  generationScope?: PersistedGenerationScope
  onJobCreated?: (job: MemoryJob) => void
}

export interface PlannedHypaV3ChunkJob {
  window: HypaV3PlannedWindow
  chunk: MemoryChunk
  job: MemoryJob | null
  payload: HypaV3SummarizeJobPayload
  chunkCreated: boolean
  jobCreated: boolean
}

export interface PlanHypaV3ChunkJobsResult {
  planned: PlannedHypaV3ChunkJob[]
  chunksCreated: number
  jobsCreated: number
}

export function planHypaV3ChunkJobs(input: PlanHypaV3ChunkJobsInput): PlanHypaV3ChunkJobsResult {
  validateInput(input)

  if (input.plan.errors.length > 0 || input.plan.plannedWindows.length === 0) {
    return { planned: [], chunksCreated: 0, jobsCreated: 0 }
  }

  const model = input.model ?? input.plan.settings.summarizationModel
  if (typeof model !== 'string' || model.length === 0) {
    throw new ValidationError('summarization model must be a non-empty string')
  }
  if (model !== 'subModel' && model !== 'memory') {
    throw new ValidationError('server-side memory summarization supports only subModel or memory')
  }

  const result = withTransaction(input.db, () => {
    const planned: PlannedHypaV3ChunkJob[] = []
    let chunksCreated = 0
    let jobsCreated = 0

    for (const window of input.plan.plannedWindows) {
      const chunkText = buildChunkText(input.chats, window)
      if (chunkText.length === 0) continue

      const chunkId = buildPlannedChunkId(input.chatId, window, chunkText)
      const existingChunk = getMemoryChunk(input.db, chunkId)
      const chunk =
        existingChunk ??
        createMemoryChunk(input.db, {
          id: chunkId,
          chatId: input.chatId,
          messageId: window.chatMemos.at(-1) ?? null,
          rangeStartSeq: window.startIndex,
          rangeEndSeq: window.endIndexExclusive - 1,
          text: chunkText,
        })
      if (!existingChunk) chunksCreated += 1

      const payload = buildSummarizeJobPayload({ chunkId, model, window })
      const jobId = buildSummarizeJobId(input.chatId, chunkId, model)
      const existingJob = getMemoryJob(input.db, jobId)
      const retainedJob =
        existingJob && chunk.status !== 'summarized'
          ? retainExistingJobAuthority(input.db, existingJob, input)
          : existingJob
      const shouldEnqueue = chunk.status !== 'summarized' && existingJob === null
      const job = shouldEnqueue
        ? enqueueMemoryJob(input.db, {
            id: jobId,
            chatId: input.chatId,
            kind: 'summarize',
            payload,
            maxAttempts: input.maxAttempts,
            nextRunAt: input.nextRunAt,
            operationId: input.operationId,
            operationAttemptNo: input.operationAttemptNo,
            generationScope: input.generationScope,
          })
        : retainedJob
      if (shouldEnqueue) jobsCreated += 1

      planned.push({
        window,
        chunk,
        job,
        payload,
        chunkCreated: existingChunk === null,
        jobCreated: shouldEnqueue,
      })
    }

    return { planned, chunksCreated, jobsCreated }
  })
  for (const item of result.planned) {
    if (item.jobCreated && item.job) input.onJobCreated?.(item.job)
  }
  return result
}

/**
 * Prompt preview may have planned the same deterministic job immediately before
 * an accepted operation. While that job is still untouched, bind it to the
 * accepted attempt instead of silently keeping the old live-configuration
 * path. Claimed/retried jobs and jobs already owned by another accepted attempt
 * retain their original immutable authority.
 */
function retainExistingJobAuthority(
  db: DatabaseSync,
  job: MemoryJob,
  input: Pick<PlanHypaV3ChunkJobsInput, 'operationId' | 'operationAttemptNo' | 'generationScope'>,
): MemoryJob {
  const requestedProvenance =
    input.operationId !== undefined || input.operationAttemptNo !== undefined || input.generationScope !== undefined
  const existingProvenance =
    job.operationId !== undefined || job.operationAttemptNo !== undefined || job.generationScope !== undefined
  if (!requestedProvenance || existingProvenance || job.status !== 'pending' || job.attemptCount !== 0) return job

  const result = db
    .prepare(
      `UPDATE memory_jobs
       SET operation_id = ?, operation_attempt_no = ?,
           admission_kind = ?, occupancy_database_lineage = ?, occupancy_session_id = ?,
           occupancy_epoch = ?, occupancy_claim_class = ?, permission_scope_version = ?,
           permission_scope_json = ?
       WHERE id = ? AND instance_id = ? AND status = 'pending' AND attempt_count = 0
         AND operation_id IS NULL AND operation_attempt_no IS NULL
         AND admission_kind IS NULL AND occupancy_database_lineage IS NULL
         AND occupancy_session_id IS NULL AND occupancy_epoch IS NULL
         AND occupancy_claim_class IS NULL AND permission_scope_version IS NULL
         AND permission_scope_json IS NULL`,
    )
    .run(
      input.operationId ?? null,
      input.operationAttemptNo ?? null,
      ...scopeSqlValues(input.generationScope),
      job.id,
      job.instanceId,
    )
  if (result.changes !== 1) {
    throw new ValidationError(`memory job ${job.id} changed while binding accepted generation authority`)
  }
  return getMemoryJob(db, job.id) as MemoryJob
}

export function buildSummarizeJobPayload(input: {
  chunkId: string
  model: string
  window: HypaV3PlannedWindow
}): HypaV3SummarizeJobPayload {
  return {
    schemaVersion: SUMMARIZE_PAYLOAD_SCHEMA_VERSION,
    chunkId: input.chunkId,
    model: input.model,
    rangeStartSeq: input.window.startIndex,
    rangeEndSeq: input.window.endIndexExclusive - 1,
    messageIndexes: [...input.window.messageIndexes],
    chatMemos: [...input.window.chatMemos],
  }
}

export function buildChunkText(chats: readonly PromptMessage[], window: HypaV3PlannedWindow): string {
  return window.messageIndexes
    .map((index) => {
      const chat = chats[index]
      if (!chat) {
        throw new ValidationError(`planned message index ${index} is outside the chat list`)
      }
      return `${chat.role}: ${sanitizeSummaryContent(chat.content)}`
    })
    .join('\n')
}

function validateInput(input: PlanHypaV3ChunkJobsInput): void {
  if (typeof input.chatId !== 'string' || input.chatId.length === 0) {
    throw new ValidationError('chat id must be a non-empty string')
  }
}

function buildPlannedChunkId(chatId: string, window: HypaV3PlannedWindow, chunkText: string): string {
  return `${CHUNK_ID_PREFIX}-${shortHash(
    JSON.stringify({
      chatId,
      rangeStartSeq: window.startIndex,
      rangeEndSeq: window.endIndexExclusive - 1,
      messageIndexes: window.messageIndexes,
      chatMemos: window.chatMemos,
      chunkText,
    }),
  )}`
}

export function buildSummarizeJobId(chatId: string, chunkId: string, model: string): string {
  return `${SUMMARIZE_JOB_ID_PREFIX}-${shortHash(JSON.stringify({ chatId, chunkId, model }))}`
}

function sanitizeSummaryContent(content: string): string {
  return sanitizeSummaryMessageContent(content)
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    db.exec('SAVEPOINT hypa_chunk_planning')
    try {
      const result = fn()
      db.exec('RELEASE SAVEPOINT hypa_chunk_planning')
      return result
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT hypa_chunk_planning')
      db.exec('RELEASE SAVEPOINT hypa_chunk_planning')
      throw error
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
