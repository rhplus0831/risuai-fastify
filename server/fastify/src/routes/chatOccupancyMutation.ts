import type { DatabaseSync } from 'node:sqlite'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { readActiveWriterSessionId } from '../activeWriter.js'
import { assertChatsAvailableForMutationInTransaction, ChatOccupancyError } from '../chatOccupancy.js'
import { getDatabaseLineage } from '../databaseLineage.js'
import { GenerationAdmissionError, type PersistedGenerationScope } from '../generationScope.js'
import { listGenerationOccupancyPins } from '../generationScope.js'

export function runImmediateChatMutationTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function assertManualChatMutationAllowedInTransaction(
  db: DatabaseSync,
  chatId: string,
  request: FastifyRequest,
): void {
  const actorSessionId = readActiveWriterSessionId(request)
  assertChatsAvailableForMutationInTransaction(
    db,
    {
      chatIds: [chatId],
      ...(actorSessionId === null ? {} : { allowedSessionId: actorSessionId }),
      includePins: false,
    },
    { pinQuery: listGenerationOccupancyPins },
  )
}

export function assertGenerationJobControlInTransaction(
  db: DatabaseSync,
  input: {
    chatId: string
    operationId?: string
    generationScope?: PersistedGenerationScope
    request: FastifyRequest
    assertPersistedScope: () => void
  },
): void {
  if (!input.generationScope) {
    assertManualChatMutationAllowedInTransaction(db, input.chatId, input.request)
    return
  }

  // Re-read the complete job/operation/attempt lineage before considering the
  // requester's identity. A copied operation id or scope must fail as stale,
  // rather than turning a manual control route into a target-confusion bypass.
  input.assertPersistedScope()
  if (!input.operationId) {
    throw new GenerationAdmissionError(409, 'generation_job_lineage_missing')
  }
  const operation = db
    .prepare(
      `SELECT creator_writer_session_id
       FROM generation_operations
       WHERE database_lineage = ? AND operation_id = ? AND chat_id = ?`,
    )
    .get(getDatabaseLineage(db), input.operationId, input.chatId) as { creator_writer_session_id: string } | undefined
  if (!operation) {
    throw new GenerationAdmissionError(409, 'generation_job_lineage_stale')
  }
  if (readActiveWriterSessionId(input.request) !== operation.creator_writer_session_id) {
    throw new GenerationAdmissionError(423, 'generation_job_foreign_session')
  }
}

export function sendChatMutationError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof ChatOccupancyError) {
    return reply.code(error.statusCode).send({ error: error.code, ...error.details })
  }
  if (error instanceof GenerationAdmissionError) {
    return reply.code(error.statusCode).send({ error: error.code, ...error.details })
  }
  throw error
}
