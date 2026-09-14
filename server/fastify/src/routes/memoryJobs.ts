import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthState } from '../auth.js'
import { requireAuth } from '../http.js'
import {
  MEMORY_JOB_KINDS,
  MEMORY_JOB_STATUSES,
  MEMORY_JOB_TERMINAL_STATUSES,
  assertMemoryJobGenerationScope,
  cancelMemoryJob,
  enqueueMemoryJob,
  getMemoryJob,
  listMemoryJobItems,
  type MemoryJobKind,
  type MemoryJobStatus,
} from '../memoryRepository.js'
import {
  buildMemoryJobEvent,
  emitMemoryEventSafely,
  sanitizeMemoryJobError,
  type MemoryEventSink,
} from '../memoryEvents.js'
import { ValidationError } from '../repository.js'
import {
  assertGenerationJobControlInTransaction,
  assertManualChatMutationAllowedInTransaction,
  runImmediateChatMutationTransaction,
  sendChatMutationError,
} from './chatOccupancyMutation.js'

interface CreateMemoryJobBody {
  chatId?: unknown
  kind?: unknown
  payload?: unknown
  maxAttempts?: unknown
  nextRunAt?: unknown
}

interface ListMemoryJobsQuery {
  chatId?: unknown
  kind?: unknown
  status?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isMemoryJobKind(value: unknown): value is MemoryJobKind {
  return typeof value === 'string' && (MEMORY_JOB_KINDS as readonly string[]).includes(value)
}

function isMemoryJobStatus(value: unknown): value is MemoryJobStatus {
  return typeof value === 'string' && (MEMORY_JOB_STATUSES as readonly string[]).includes(value)
}

function emitRouteJobEvent(db: DatabaseSync, onEvent: MemoryEventSink | undefined, jobId: string): void {
  if (!onEvent) return
  const job = getMemoryJob(db, jobId)
  if (!job) return
  emitMemoryEventSafely(onEvent, buildMemoryJobEvent(job))
}

function badRequest(error: string): { error: string } {
  return { error }
}

function memoryJobsEtag(jobs: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(jobs)).digest('base64url')}"`
}

const TERMINAL_JOB_HISTORY_LIMIT = 50

function presentMemoryJobs(jobs: ReturnType<typeof listMemoryJobItems>, explicitStatus?: MemoryJobStatus) {
  const presented = jobs.map((job) => ({ ...job, error: sanitizeMemoryJobError(job.error) }))
  if (explicitStatus === 'pending' || explicitStatus === 'running') return presented
  const active = presented.filter((job) => job.status === 'pending' || job.status === 'running')
  const terminal = presented
    .filter((job) => job.status !== 'pending' && job.status !== 'running')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, TERMINAL_JOB_HISTORY_LIMIT)
  return [...active, ...terminal]
}

export function registerMemoryJobRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  options: {
    onEvent?: MemoryEventSink
    snapshotVersion?: () => { streamId: string; version: number }
    abortRunningJob?: (jobId: string) => boolean
    wakeWorker?: () => void
  } = {},
): void {
  app.post('/api/v1/memory/jobs', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    const body = (req.body ?? {}) as CreateMemoryJobBody
    if (!isObject(body)) {
      reply.code(400)
      return badRequest('body must be an object')
    }
    const chatId = body.chatId
    if (!isNonEmptyString(chatId)) {
      reply.code(400)
      return badRequest('chatId must be a non-empty string')
    }
    const kind = body.kind
    if (!isMemoryJobKind(kind)) {
      reply.code(400)
      return badRequest('kind must be one of: chunk, embed, summarize')
    }
    const maxAttempts = body.maxAttempts
    if (
      maxAttempts !== undefined &&
      (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts <= 0)
    ) {
      reply.code(400)
      return badRequest('maxAttempts must be a positive integer when provided')
    }
    if (body.nextRunAt !== undefined) {
      if (typeof body.nextRunAt !== 'string' || Number.isNaN(Date.parse(body.nextRunAt))) {
        reply.code(400)
        return badRequest('nextRunAt must be a valid timestamp when provided')
      }
    }
    try {
      const job = runImmediateChatMutationTransaction(db, () => {
        assertManualChatMutationAllowedInTransaction(db, chatId, req)
        return enqueueMemoryJob(db, {
          id: randomUUID(),
          chatId,
          kind,
          payload: body.payload ?? {},
          maxAttempts: typeof maxAttempts === 'number' ? maxAttempts : undefined,
          nextRunAt: typeof body.nextRunAt === 'string' ? body.nextRunAt : undefined,
        })
      })
      emitRouteJobEvent(db, options.onEvent, job.id)
      options.wakeWorker?.()
      reply.code(201)
      return { job }
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.code(400)
        return badRequest(err.message)
      }
      return sendChatMutationError(reply, err)
    }
  })

  app.get<{ Querystring: ListMemoryJobsQuery }>('/api/v1/memory/jobs', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    const query = req.query
    if (query.chatId !== undefined && !isNonEmptyString(query.chatId)) {
      reply.code(400)
      return badRequest('chatId must be a non-empty string when provided')
    }
    if (query.kind !== undefined && !isMemoryJobKind(query.kind)) {
      reply.code(400)
      return badRequest('kind must be one of: chunk, embed, summarize')
    }
    if (query.status !== undefined && !isMemoryJobStatus(query.status)) {
      reply.code(400)
      return badRequest('status must be one of: pending, running, completed, failed, cancelled')
    }

    const memorySnapshot = options.snapshotVersion?.()
    const commonFilter = {
      chatId: typeof query.chatId === 'string' ? query.chatId : undefined,
      kind: isMemoryJobKind(query.kind) ? query.kind : undefined,
    }
    const explicitStatus = isMemoryJobStatus(query.status) ? query.status : undefined
    const jobs = explicitStatus
      ? presentMemoryJobs(
          listMemoryJobItems(db, {
            ...commonFilter,
            status: explicitStatus,
            ...((MEMORY_JOB_TERMINAL_STATUSES as readonly MemoryJobStatus[]).includes(explicitStatus)
              ? { limit: TERMINAL_JOB_HISTORY_LIMIT, newestFirst: true }
              : {}),
          }),
          explicitStatus,
        )
      : presentMemoryJobs([
          ...listMemoryJobItems(db, { ...commonFilter, statuses: ['pending', 'running'] }),
          ...listMemoryJobItems(db, {
            ...commonFilter,
            statuses: MEMORY_JOB_TERMINAL_STATUSES,
            limit: TERMINAL_JOB_HISTORY_LIMIT,
            newestFirst: true,
          }),
        ])
    const etag = memoryJobsEtag(jobs)
    reply.header('etag', etag)
    if (memorySnapshot) {
      reply.header('x-risu-memory-stream-id', memorySnapshot.streamId)
      reply.header('x-risu-memory-version', String(memorySnapshot.version))
    }
    if (req.headers['if-none-match'] === etag) {
      reply.code(304)
      return
    }
    return { jobs }
  })

  app.delete<{ Params: { id: string } }>('/api/v1/memory/jobs/:id', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    let job
    try {
      job = runImmediateChatMutationTransaction(db, () => {
        const existing = getMemoryJob(db, req.params.id)
        if (!existing) return null
        assertGenerationJobControlInTransaction(db, {
          chatId: existing.chatId,
          operationId: existing.operationId,
          generationScope: existing.generationScope,
          request: req,
          assertPersistedScope: () => assertMemoryJobGenerationScope(db, existing),
        })
        return cancelMemoryJob(db, existing.id)
      })
    } catch (error) {
      return sendChatMutationError(reply, error)
    }
    if (!job) {
      reply.code(404)
      return { error: 'memory job not found or not cancellable' }
    }
    options.abortRunningJob?.(job.id)
    emitRouteJobEvent(db, options.onEvent, job.id)
    return {
      job: {
        id: job.id,
        instanceId: job.instanceId,
        chatId: job.chatId,
        kind: job.kind,
        status: job.status,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        error: sanitizeMemoryJobError(job.error),
        updatedAt: job.updatedAt,
      },
    }
  })
}
