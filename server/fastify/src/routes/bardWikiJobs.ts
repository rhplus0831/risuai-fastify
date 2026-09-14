import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import type { AuthState } from '../auth.js'
import {
  assertBardWikiJobGenerationScope,
  cancelBardWikiJob,
  getBardWikiJob,
  retryFailedBardWikiJob,
} from '../bardWikiJobs.js'
import { buildBardWikiJobEvent, emitMemoryEventSafely, type MemoryEventSink } from '../memoryEvents.js'
import { requireAuth } from '../http.js'
import {
  assertGenerationJobControlInTransaction,
  runImmediateChatMutationTransaction,
  sendChatMutationError,
} from './chatOccupancyMutation.js'

export function registerBardWikiJobRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  options: {
    onEvent?: MemoryEventSink
    abortRunningJob?: (jobId: string) => boolean
    wakeWorker?: () => void
  } = {},
): void {
  app.post<{ Params: { jobId: string } }>('/api/v1/bardwiki/jobs/:jobId/retry', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    let job
    try {
      job = runImmediateChatMutationTransaction(db, () => {
        const existing = getBardWikiJob(db, req.params.jobId)
        if (!existing) return null
        assertGenerationJobControlInTransaction(db, {
          chatId: existing.chatId,
          operationId: existing.operationId,
          generationScope: existing.generationScope,
          request: req,
          assertPersistedScope: () => assertBardWikiJobGenerationScope(db, existing),
        })
        return retryFailedBardWikiJob(db, existing.id)
      })
    } catch (error) {
      return sendChatMutationError(reply, error)
    }
    if (!job) {
      reply.code(409)
      return { error: 'bardwiki_job_not_retryable' }
    }
    emitJob(options.onEvent, job)
    options.wakeWorker?.()
    return { job: toJobSummary(job) }
  })

  app.delete<{ Params: { jobId: string } }>('/api/v1/bardwiki/jobs/:jobId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    let job
    try {
      job = runImmediateChatMutationTransaction(db, () => {
        const existing = getBardWikiJob(db, req.params.jobId)
        if (!existing) return null
        assertGenerationJobControlInTransaction(db, {
          chatId: existing.chatId,
          operationId: existing.operationId,
          generationScope: existing.generationScope,
          request: req,
          assertPersistedScope: () => assertBardWikiJobGenerationScope(db, existing),
        })
        return cancelBardWikiJob(db, existing.id)
      })
    } catch (error) {
      return sendChatMutationError(reply, error)
    }
    if (!job) {
      const existing = getBardWikiJob(db, req.params.jobId)
      if (!existing) {
        reply.code(404)
        return { error: 'bardwiki_job_not_found' }
      }
      reply.code(409)
      return { error: 'bardwiki_job_not_cancellable' }
    }
    options.abortRunningJob?.(job.id)
    emitJob(options.onEvent, job)
    return { job: toJobSummary(job) }
  })
}

function emitJob(onEvent: MemoryEventSink | undefined, job: NonNullable<ReturnType<typeof getBardWikiJob>>): void {
  if (onEvent) emitMemoryEventSafely(onEvent, buildBardWikiJobEvent(job))
}

function toJobSummary(job: NonNullable<ReturnType<typeof getBardWikiJob>>) {
  const { payload: _payload, ...summary } = job
  return summary
}
