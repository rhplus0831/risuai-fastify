import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AssembleInput } from '../prompt/assemble.js'
import { readActiveWriterSessionId } from '../activeWriter.js'
import type { AuthState } from '../auth.js'
import { requireAuth } from '../http.js'
import {
  DATABASE_LINEAGE_HEADER,
  DatabaseLineageConflictError,
  assertDatabaseLineage,
  getDatabaseLineage,
  getDatabaseWriterMetadata,
} from '../databaseLineage.js'
import { bumpRevision, getSchemaState } from '../db.js'
import {
  EntityNotFoundError,
  RevisionMismatchError,
  ValidationError,
  loadPersistedForChatMutation,
} from '../repository.js'
import { normalizeAllCharacterChats, requireChatLocation } from '../commands/chats.js'
import { createMessageRecord, type MessageRecord } from '../commands/messages.js'
import {
  COMMAND_EVENT_CATALOG,
  persistCommandEvent,
  type CommandEvent,
  type CommandEventSink,
} from '../commands/events.js'
import { activeMessageIdExists, appendChatMessage, getChatMessages } from '../messageStore.js'
import {
  GENERATION_OPERATION_PROTOCOL_VERSION,
  GenerationOperationAttemptConflictError,
  bindCancelledGenerationOperationInTransaction,
  createGenerationOperation,
  generationOperationForRetryRequest,
  generationOperationRequestFingerprint,
  getGenerationOperationProjection,
  getGenerationOperationProjectionEpoch,
  getGenerationOperationStoredRequest,
  insertGenerationOperationInTransaction,
  reserveGenerationOperationAttempt,
  reserveGenerationOperationAttemptInTransaction,
  transitionGenerationOperation,
  transitionGenerationOperationInTransaction,
  type GenerationOperationMode,
  type GenerationOperationProjection,
} from '../generationOperations.js'
import type { GenerationJobRegistry } from '../generationJobs.js'
import type { MessageTranslationJobRegistry } from '../messageTranslationJobs.js'
import { generationSubmitRateLimit } from '../routeRateLimits.js'
import {
  attachGenerationOperationViewer,
  launchGenerationOperation,
  preflightGenerationOperationSettings,
  readGenerationClientCapabilities,
  toChatGenerationAssembleInput,
  type ChatRequestBody,
  type GenerationChatRouteOptions,
} from './generationChat.js'
import type { GenerationTraceOptions } from '../generation/generationTraceSidecar.js'
import { findUncommittedGenerationFinalizationForChat } from '../generationFinalizationRetry.js'
import { readRequestTraceUid } from '../requestTrace.js'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface AtomicGenerationOperationRequest {
  protocolVersion: 1
  operationId: string
  baseRevision: number
  characterId: string
  chatId: string
  mode: GenerationOperationMode
  acceptedMessageId?: string
  targetMessageId?: string
  message?: MessageRecord
  draftGeneration: unknown
  generation: {
    syntheticSayNothing: boolean
    resetMessages: boolean
    loadoutId?: string
    inlayAssetRefs: unknown[]
    clientContext: unknown
    clientCapabilities: Record<string, unknown>
  }
}

interface GenerationOperationIntent {
  protocolVersion: 1
  characterId: string
  chatId: string
  mode: GenerationOperationMode
  acceptedMessageId?: string
  targetMessageId?: string
  message?: MessageRecord
  draftGeneration: unknown
  generation: AtomicGenerationOperationRequest['generation']
}

interface AcceptedAppendProjection {
  disposition: 'accepted' | 'not_appended'
  messageId: string
  revision?: number
  event?: CommandEvent
}

interface SubmitMutationResult {
  created: boolean
  operation: GenerationOperationProjection
  append?: AcceptedAppendProjection
}

class OperationHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'OperationHttpError'
  }
}

export interface GenerationOperationRouteDependencies {
  serverInstanceId: string
  generationJobs: GenerationJobRegistry
  messageTranslationJobs: MessageTranslationJobRegistry
  generationChatOptions?: GenerationChatRouteOptions
  generationTrace?: GenerationTraceOptions
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${label} is required`)
  return value
}

function canonicalUuid(value: unknown, label: string): string {
  const id = requiredString(value, label)
  if (!UUID_V4_RE.test(id)) throw new ValidationError(`${label} must be a lowercase UUID v4`)
  return id
}

function readRequestedDatabaseLineage(req: FastifyRequest): string {
  const raw = req.headers[DATABASE_LINEAGE_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${DATABASE_LINEAGE_HEADER} header is required`)
  }
  return value
}

function readRequiredWriterSessionId(req: FastifyRequest): string {
  const writerSessionId = readActiveWriterSessionId(req)
  if (!writerSessionId) throw new ValidationError('risu-writer-session header is required')
  return writerSessionId
}

function normalizeGenerationOptions(value: unknown): AtomicGenerationOperationRequest['generation'] {
  if (!isRecord(value)) throw new ValidationError('generation must be an object')
  if (value.syntheticSayNothing !== undefined && typeof value.syntheticSayNothing !== 'boolean') {
    throw new ValidationError('generation.syntheticSayNothing must be a boolean')
  }
  if (value.resetMessages !== undefined && typeof value.resetMessages !== 'boolean') {
    throw new ValidationError('generation.resetMessages must be a boolean')
  }
  if (value.loadoutId !== undefined && typeof value.loadoutId !== 'string') {
    throw new ValidationError('generation.loadoutId must be a string')
  }
  if (value.inlayAssetRefs !== undefined && !Array.isArray(value.inlayAssetRefs)) {
    throw new ValidationError('generation.inlayAssetRefs must be an array')
  }
  if (value.clientCapabilities !== undefined && !isRecord(value.clientCapabilities)) {
    throw new ValidationError('generation.clientCapabilities must be an object')
  }
  return {
    syntheticSayNothing: value.syntheticSayNothing === true,
    resetMessages: value.resetMessages === true,
    ...(typeof value.loadoutId === 'string' ? { loadoutId: value.loadoutId } : {}),
    inlayAssetRefs: structuredClone((value.inlayAssetRefs as unknown[] | undefined) ?? []),
    clientContext: structuredClone(value.clientContext ?? {}),
    clientCapabilities: structuredClone((value.clientCapabilities as Record<string, unknown> | undefined) ?? {}),
  }
}

function parseSubmitRequest(body: unknown): AtomicGenerationOperationRequest {
  if (!isRecord(body)) throw new ValidationError('request body must be an object')
  if (body.protocolVersion !== GENERATION_OPERATION_PROTOCOL_VERSION) {
    throw new ValidationError(`protocolVersion must be ${GENERATION_OPERATION_PROTOCOL_VERSION}`)
  }
  if (!Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 0) {
    throw new ValidationError('baseRevision must be a non-negative integer')
  }
  const operationId = canonicalUuid(body.operationId, 'operationId')
  const characterId = requiredString(body.characterId, 'characterId')
  const chatId = requiredString(body.chatId, 'chatId')
  if (body.mode !== 'send' && body.mode !== 'continue' && body.mode !== 'regenerate') {
    throw new ValidationError('mode must be send, continue, or regenerate')
  }
  if (body.draftGeneration === undefined) throw new ValidationError('draftGeneration is required')
  const generation = normalizeGenerationOptions(body.generation)
  if (body.mode === 'send') {
    const acceptedMessageId = canonicalUuid(body.acceptedMessageId, 'acceptedMessageId')
    const message = createMessageRecord(structuredClone(body.message), 'message')
    if (message.role !== 'user') throw new ValidationError('message.role must be user')
    if (message.chatId !== acceptedMessageId) {
      throw new ValidationError('acceptedMessageId must equal message.chatId')
    }
    if (generation.syntheticSayNothing && message.data !== '*says nothing*') {
      throw new ValidationError('syntheticSayNothing requires the say-nothing sentinel')
    }
    return {
      protocolVersion: 1,
      operationId,
      baseRevision: body.baseRevision as number,
      characterId,
      chatId,
      mode: 'send',
      acceptedMessageId,
      message,
      draftGeneration: structuredClone(body.draftGeneration),
      generation,
    }
  }
  if (body.message !== undefined || body.acceptedMessageId !== undefined) {
    throw new ValidationError(`${body.mode} must not include message or acceptedMessageId`)
  }
  return {
    protocolVersion: 1,
    operationId,
    baseRevision: body.baseRevision as number,
    characterId,
    chatId,
    mode: body.mode,
    targetMessageId: requiredString(body.targetMessageId, 'targetMessageId'),
    draftGeneration: structuredClone(body.draftGeneration),
    generation,
  }
}

function intentFromRequest(request: AtomicGenerationOperationRequest): GenerationOperationIntent {
  return {
    protocolVersion: 1,
    characterId: request.characterId,
    chatId: request.chatId,
    mode: request.mode,
    ...(request.acceptedMessageId ? { acceptedMessageId: request.acceptedMessageId } : {}),
    ...(request.targetMessageId ? { targetMessageId: request.targetMessageId } : {}),
    ...(request.message ? { message: structuredClone(request.message) } : {}),
    draftGeneration: structuredClone(request.draftGeneration),
    generation: structuredClone(request.generation),
  }
}

function fingerprintRequest(request: AtomicGenerationOperationRequest): string {
  return generationOperationRequestFingerprint({
    operationId: request.operationId,
    baseRevision: request.baseRevision,
    ...intentFromRequest(request),
  })
}

function appendProjection(
  operation: GenerationOperationProjection,
  databaseLineage: string,
): AcceptedAppendProjection | undefined {
  if (operation.mode !== 'send' || !operation.acceptedMessageId) return undefined
  if (operation.acceptedRevision === undefined) {
    return { disposition: 'not_appended', messageId: operation.acceptedMessageId }
  }
  return {
    disposition: 'accepted',
    messageId: operation.acceptedMessageId,
    revision: operation.acceptedRevision,
    event: {
      ...COMMAND_EVENT_CATALOG.messageAppended,
      id: operation.acceptedMessageId,
      parentId: operation.chatId,
      revision: operation.acceptedRevision,
      databaseLineage,
      operationId: operation.operationId,
      sourceMessageId: operation.acceptedMessageId,
    },
  }
}

function validateTargetInTransaction(db: DatabaseSync, request: AtomicGenerationOperationRequest): void {
  if (request.mode === 'send') return
  const tail = getChatMessages(db, request.chatId).at(-1) as Record<string, unknown> | undefined
  if (!tail || tail.chatId !== request.targetMessageId || tail.role !== 'char') {
    throw new OperationHttpError(409, 'operation_target_stale')
  }
}

function acceptSubmitTransaction(args: {
  db: DatabaseSync
  dataDir: string
  request: AtomicGenerationOperationRequest
  databaseLineage: string
  writerSessionId: string
  writerEpoch: number
  serverInstanceId: string
}): SubmitMutationResult & { liveEvent?: CommandEvent } {
  const { db, request } = args
  const fingerprint = fingerprintRequest(request)
  const intent = intentFromRequest(request)
  db.exec('BEGIN IMMEDIATE')
  let committed = false
  try {
    assertDatabaseLineage(db, args.databaseLineage)
    const existing = getGenerationOperationProjection(db, args.databaseLineage, request.operationId)
    if (existing) {
      const stored = getGenerationOperationStoredRequest(db, args.databaseLineage, request.operationId)
      if (existing.requestOrigin === 'unbound' && existing.state === 'cancel_requested') {
        const bound = bindCancelledGenerationOperationInTransaction(db, {
          databaseLineage: args.databaseLineage,
          operationId: request.operationId,
          expectedStateVersion: existing.stateVersion,
          requestOrigin: request.mode === 'send' ? 'accepted_send' : request.mode,
          bindingServerInstanceId: args.serverInstanceId,
          characterId: request.characterId,
          chatId: request.chatId,
          mode: request.mode,
          acceptedMessageId: request.acceptedMessageId,
          targetMessageId: request.targetMessageId,
          clientDraftGeneration: request.draftGeneration,
          requestFingerprint: fingerprint,
          intent,
        })
        if (bound.status !== 'applied') throw new OperationHttpError(409, 'operation_state_conflict')
        db.exec('COMMIT')
        committed = true
        return {
          created: false,
          operation: bound.operation,
          append: appendProjection(bound.operation, args.databaseLineage),
        }
      }
      if (stored?.requestFingerprint !== fingerprint) {
        throw new OperationHttpError(409, 'operation_id_conflict')
      }
      db.exec('COMMIT')
      committed = true
      return {
        created: false,
        operation: existing,
        append: appendProjection(existing, args.databaseLineage),
      }
    }

    const liveClaim = db
      .prepare(
        `
          SELECT operation_id AS operationId
          FROM generation_operations
          WHERE database_lineage = ? AND chat_id = ?
            AND state IN ('accepted', 'launching', 'owned_by_job', 'stopping')
          LIMIT 1
        `,
      )
      .get(args.databaseLineage, request.chatId) as { operationId: string } | undefined
    if (liveClaim) throw new OperationHttpError(409, 'generation_in_progress', { operationId: liveClaim.operationId })
    const pendingFinalization = findUncommittedGenerationFinalizationForChat(db, request.chatId)
    if (pendingFinalization) {
      throw new OperationHttpError(409, 'generation_finalization_pending', {
        generationId: pendingFinalization.generationId,
        message: 'The previous reply is still saving. Try again when it finishes.',
      })
    }

    const { revision: currentRevision } = getSchemaState(db)
    if (request.baseRevision !== currentRevision) throw new RevisionMismatchError(currentRevision)
    const persisted = loadPersistedForChatMutation(db, args.dataDir, { chatId: request.chatId })
    const characters = normalizeAllCharacterChats(persisted.database)
    const { character } = requireChatLocation(characters, request.chatId)
    if (character.chaId !== request.characterId) throw new EntityNotFoundError('chat does not belong to character')
    validateTargetInTransaction(db, request)
    const settingsPreflight = preflightGenerationOperationSettings(
      assembleInputForIntent(intent, currentRevision).input,
      args.dataDir,
      db,
    )
    if (settingsPreflight.status === 'rejected') {
      const details = isRecord(settingsPreflight.body)
        ? settingsPreflight.body
        : { message: String(settingsPreflight.body) }
      throw new OperationHttpError(
        settingsPreflight.statusCode,
        typeof details.error === 'string' ? details.error : 'generation_settings_not_ready',
        details,
      )
    }

    let acceptedRevision = currentRevision
    let liveEvent: CommandEvent | undefined
    if (request.mode === 'send') {
      if (activeMessageIdExists(db, request.acceptedMessageId!)) {
        throw new OperationHttpError(409, 'message_id_conflict')
      }
      appendChatMessage(db, request.chatId, request.message!)
      acceptedRevision = bumpRevision(db)
      liveEvent = {
        ...COMMAND_EVENT_CATALOG.messageAppended,
        id: request.acceptedMessageId,
        parentId: request.chatId,
        revision: acceptedRevision,
        databaseLineage: args.databaseLineage,
        operationId: request.operationId,
        sourceMessageId: request.acceptedMessageId,
        origin: { writerSessionId: args.writerSessionId },
      }
      persistCommandEvent(db, liveEvent)
    }
    const operation = insertGenerationOperationInTransaction(db, {
      databaseLineage: args.databaseLineage,
      operationId: request.operationId,
      protocolVersion: 1,
      requestOrigin: request.mode === 'send' ? 'accepted_send' : request.mode,
      creatorWriterSessionId: args.writerSessionId,
      creatorWriterEpoch: args.writerEpoch,
      bindingServerInstanceId: args.serverInstanceId,
      characterId: request.characterId,
      chatId: request.chatId,
      mode: request.mode,
      acceptedMessageId: request.acceptedMessageId,
      targetMessageId: request.targetMessageId,
      clientDraftGeneration: request.draftGeneration,
      requestFingerprint: fingerprint,
      intent,
      acceptedRevision,
      state: 'accepted',
    })
    db.exec('COMMIT')
    committed = true
    return {
      created: true,
      operation,
      ...(request.mode === 'send'
        ? {
            append: appendProjection(operation, args.databaseLineage)!,
            liveEvent,
          }
        : {}),
    }
  } catch (error) {
    if (!committed) db.exec('ROLLBACK')
    throw error
  }
}

function intentAssembleInput(
  operation: GenerationOperationProjection,
  intent: GenerationOperationIntent,
  reuseAcceptedSubmitTransforms = false,
): {
  input: AssembleInput
  chatBody: ChatRequestBody
} {
  return assembleInputForIntent(intent, operation.acceptedRevision, reuseAcceptedSubmitTransforms)
}

function assembleInputForIntent(
  intent: GenerationOperationIntent,
  acceptedRevision: number | undefined,
  reuseAcceptedSubmitTransforms = false,
): { input: AssembleInput; chatBody: ChatRequestBody } {
  const body: ChatRequestBody = {
    chatId: intent.chatId,
    characterId: intent.characterId,
    mode: intent.mode,
    durable: true,
    ...(intent.mode === 'send' && intent.message ? { userMessage: intent.message.data } : {}),
    ...(intent.mode === 'regenerate' ? { regenerateMessageId: intent.targetMessageId } : {}),
    syntheticSayNothing: intent.generation.syntheticSayNothing,
    resetMessages: intent.generation.resetMessages,
    loadoutId: intent.generation.loadoutId,
    inlayAssetRefs: intent.generation.inlayAssetRefs,
    clientContext: intent.generation.clientContext,
    clientCapabilities: intent.generation.clientCapabilities,
    expectedRevision: acceptedRevision,
  }
  const input = toChatGenerationAssembleInput(body)
  if (intent.mode === 'send' && intent.acceptedMessageId) {
    input.acceptedMessageId = intent.acceptedMessageId
    if (reuseAcceptedSubmitTransforms) input.reuseAcceptedSubmitTransforms = true
  }
  return { input, chatBody: body }
}

function streamProjection(operation: GenerationOperationProjection): { href: string } | undefined {
  const attempt = operation.currentAttempt
  if (!attempt) return undefined
  return {
    href: `/api/v1/generation-operations/${encodeURIComponent(operation.operationId)}/stream?attemptNo=${attempt.attemptNo}&jobId=${encodeURIComponent(attempt.jobId)}&projectionEpoch=${operation.projectionEpoch}`,
  }
}

function launchCommittedOperation(args: {
  db: DatabaseSync
  operation: GenerationOperationProjection
  intent: GenerationOperationIntent
  writerSessionId: string
  writerEpoch: number
  dependencies: GenerationOperationRouteDependencies
  req: FastifyRequest
  retryRequestId: string
  dataDir: string
  eventSink: CommandEventSink
  reuseAcceptedSubmitTransforms?: boolean
}): GenerationOperationProjection {
  let operation = args.operation
  if (operation.state === 'accepted' || operation.state === 'retryable' || operation.state === 'abandoned') {
    const reservation = reserveGenerationOperationAttempt(args.db, {
      databaseLineage: getDatabaseLineage(args.db),
      operationId: operation.operationId,
      expectedState: operation.state,
      expectedStateVersion: operation.stateVersion,
      retryRequestId: args.retryRequestId,
      jobId: randomUUID(),
      serverInstanceId: args.dependencies.serverInstanceId,
      actorWriterSessionId: args.writerSessionId,
      actorWriterEpoch: args.writerEpoch,
      launchRevision: getSchemaState(args.db).revision,
    })
    if (reservation.status === 'stale' || !reservation.operation.currentAttempt) {
      return reservation.operation ?? operation
    }
    operation = reservation.operation
  }
  if (operation.state !== 'launching') return operation
  if (operation.currentAttempt?.serverInstanceId !== args.dependencies.serverInstanceId) return operation
  const { input, chatBody } = intentAssembleInput(operation, args.intent, args.reuseAcceptedSubmitTransforms)
  try {
    return launchGenerationOperation({
      operation,
      db: args.db,
      input,
      dataDir: args.dataDir,
      eventSink: args.eventSink,
      clientCapabilities: readGenerationClientCapabilities(chatBody),
      options: args.dependencies.generationChatOptions ?? {},
      generationTrace: args.dependencies.generationTrace,
      generationJobs: args.dependencies.generationJobs,
      messageTranslationJobs: args.dependencies.messageTranslationJobs,
      metricContext: {
        requestId: String(args.req.id),
        requestUid: readRequestTraceUid(args.req),
        chatId: input.chatId,
        characterId: input.characterId,
        mode: input.mode,
        durable: true,
      },
    })
  } catch (error) {
    args.req.log.error({ err: error, operationId: operation.operationId }, 'generation operation launch failed')
    const projected = getGenerationOperationProjection(args.db, getDatabaseLineage(args.db), operation.operationId)
    if (projected) return projected
    throw error
  }
}

function operationResponse(operation: GenerationOperationProjection, append?: AcceptedAppendProjection) {
  return {
    operation,
    ...(append ? { append } : {}),
    ...(streamProjection(operation) ? { stream: streamProjection(operation)! } : {}),
  }
}

function sendOperationError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof OperationHttpError) {
    return reply.code(error.statusCode).send({ error: error.code, ...error.details })
  }
  if (error instanceof DatabaseLineageConflictError) {
    return reply.code(409).send({ error: 'database_lineage_conflict', databaseLineage: error.databaseLineage })
  }
  if (error instanceof RevisionMismatchError) {
    return reply.code(409).send({ error: 'revision_conflict', currentRevision: error.currentRevision })
  }
  if (error instanceof ValidationError) return reply.code(400).send({ error: error.message })
  if (error instanceof EntityNotFoundError) return reply.code(404).send({ error: error.message })
  if (error instanceof GenerationOperationAttemptConflictError) {
    return reply.code(409).send({ error: 'stale_generation_attempt' })
  }
  const sqliteCode =
    error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
  if (sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
    return reply.code(409).send({ error: 'generation_in_progress' })
  }
  throw error
}

export function registerGenerationOperationRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  dataDir: string,
  eventSink: CommandEventSink,
  dependencies: GenerationOperationRouteDependencies,
): void {
  app.post(
    '/api/v1/generation-operations',
    { config: { rateLimit: generationSubmitRateLimit } },
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const request = parseSubmitRequest(req.body)
        const databaseLineage = readRequestedDatabaseLineage(req)
        const writerSessionId = readRequiredWriterSessionId(req)
        const writerEpoch = getDatabaseWriterMetadata(db).epoch
        const result = acceptSubmitTransaction({
          db,
          dataDir,
          request,
          databaseLineage,
          writerSessionId,
          writerEpoch,
          serverInstanceId: dependencies.serverInstanceId,
        })
        if (result.liveEvent) {
          try {
            eventSink.emit(result.liveEvent)
          } catch (error) {
            req.log.warn({ err: error, operationId: request.operationId }, 'accepted-send event delivery failed')
          }
        }
        let operation = result.operation
        if (operation.state === 'accepted' && operation.bindingServerInstanceId === dependencies.serverInstanceId) {
          operation = launchCommittedOperation({
            db,
            operation,
            intent: intentFromRequest(request),
            writerSessionId,
            writerEpoch,
            dependencies,
            req,
            retryRequestId: request.operationId,
            dataDir,
            eventSink,
          })
        }
        if (operation.currentAttempt) {
          reply.header('x-risu-generation-job-id', operation.currentAttempt.jobId)
          reply.header('x-risu-generation-operation-id', operation.operationId)
          reply.header('x-risu-generation-attempt-no', String(operation.currentAttempt.attemptNo))
          reply.header('x-risu-generation-projection-epoch', String(operation.projectionEpoch))
        }
        return reply.code(result.created ? 201 : 200).send(operationResponse(operation, result.append))
      } catch (error) {
        return sendOperationError(reply, error)
      }
    },
  )

  app.get<{ Params: { operationId: string } }>(
    '/api/v1/generation-operations/:operationId',
    { exposeHeadRoute: false },
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const operationId = canonicalUuid(req.params.operationId, 'operationId')
        const operation = getGenerationOperationProjection(db, getDatabaseLineage(db), operationId)
        if (!operation) return reply.code(404).send({ error: 'generation_operation_not_found' })
        return { operation, projectionEpoch: getGenerationOperationProjectionEpoch(db) }
      } catch (error) {
        return sendOperationError(reply, error)
      }
    },
  )

  app.get<{
    Params: { operationId: string }
    Querystring: { attemptNo?: string; jobId?: string; projectionEpoch?: string }
  }>('/api/v1/generation-operations/:operationId/stream', { exposeHeadRoute: false }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const operationId = canonicalUuid(req.params.operationId, 'operationId')
      const operation = getGenerationOperationProjection(db, getDatabaseLineage(db), operationId)
      const attempt = operation?.currentAttempt
      const attemptNo = Number(req.query.attemptNo)
      const projectionEpoch = Number(req.query.projectionEpoch)
      if (
        !operation ||
        !attempt ||
        !Number.isSafeInteger(attemptNo) ||
        attempt.attemptNo !== attemptNo ||
        attempt.jobId !== req.query.jobId ||
        !Number.isSafeInteger(projectionEpoch) ||
        operation.projectionEpoch !== projectionEpoch
      ) {
        return reply.code(409).send({ error: 'stale_generation_attempt', operation })
      }
      const job = dependencies.generationJobs.registry.get(attempt.jobId)
      if (!job || job.operationId !== operationId || job.attemptNo !== attempt.attemptNo) {
        return reply.code(409).send({ error: 'stale_generation_attempt', operation })
      }
      attachGenerationOperationViewer({
        req,
        reply,
        db,
        generationJobs: dependencies.generationJobs,
        job,
        options: dependencies.generationChatOptions,
      })
    } catch (error) {
      return sendOperationError(reply, error)
    }
  })

  app.put<{ Params: { operationId: string } }>(
    '/api/v1/generation-operations/:operationId/cancellation',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const operationId = canonicalUuid(req.params.operationId, 'operationId')
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const body = isRecord(req.body) ? req.body : {}
        if (body.reason !== undefined && body.reason !== 'user_stop') {
          throw new ValidationError('reason must be user_stop')
        }
        const writerSessionId = readRequiredWriterSessionId(req)
        const writerEpoch = getDatabaseWriterMetadata(db).epoch
        let operation: GenerationOperationProjection
        let knownAttemptMatched = false
        let disposition = 'terminal_nonrunning'
        let statusCode = 200
        let abortJob: ReturnType<GenerationJobRegistry['registry']['get']>
        let deleteJobId: string | undefined
        let completedResult: { messageId?: string; revision: number } | undefined
        db.exec('BEGIN IMMEDIATE')
        let committed = false
        try {
          assertDatabaseLineage(db, databaseLineage)
          const current = getGenerationOperationProjection(db, databaseLineage, operationId)
          if (!current) {
            operation = insertGenerationOperationInTransaction(db, {
              databaseLineage,
              operationId,
              protocolVersion: 1,
              requestOrigin: 'unbound',
              creatorWriterSessionId: writerSessionId,
              creatorWriterEpoch: writerEpoch,
              state: 'cancel_requested',
            })
            disposition = 'cancelled_before_acceptance'
          } else {
            operation = current
            knownAttemptMatched =
              (body.knownStateVersion === undefined || body.knownStateVersion === current.stateVersion) &&
              (body.knownAttemptNo === undefined || body.knownAttemptNo === current.currentAttempt?.attemptNo) &&
              (body.knownJobId === undefined || body.knownJobId === current.currentAttempt?.jobId)
            if (current.state === 'cancel_requested') {
              disposition = 'cancelled_before_acceptance'
            } else if (
              current.state === 'accepted' ||
              current.state === 'launching' ||
              current.state === 'retryable' ||
              current.state === 'abandoned'
            ) {
              deleteJobId = current.currentAttempt?.jobId
              operation =
                transitionGenerationOperationInTransaction(db, {
                  databaseLineage,
                  operationId,
                  expectedState: current.state,
                  expectedStateVersion: current.stateVersion,
                  nextState: 'cancelled',
                  cancelRequestedAt: new Date().toISOString(),
                }).operation ?? current
              disposition = 'cancelled'
            } else if (current.state === 'owned_by_job' || current.state === 'stopping') {
              if (current.state === 'owned_by_job') {
                operation =
                  transitionGenerationOperationInTransaction(db, {
                    databaseLineage,
                    operationId,
                    expectedState: 'owned_by_job',
                    expectedStateVersion: current.stateVersion,
                    nextState: 'stopping',
                    cancelRequestedAt: new Date().toISOString(),
                  }).operation ?? current
              }
              abortJob = operation.currentAttempt
                ? dependencies.generationJobs.registry.get(operation.currentAttempt.jobId)
                : undefined
              if (abortJob) {
                disposition = 'cancelling'
                statusCode = 202
              } else {
                operation =
                  transitionGenerationOperationInTransaction(db, {
                    databaseLineage,
                    operationId,
                    expectedState: 'stopping',
                    expectedStateVersion: operation.stateVersion,
                    nextState: 'cancelled',
                    cancelRequestedAt: operation.cancelRequestedAt,
                  }).operation ?? operation
                disposition = 'cancelled'
              }
            } else if (current.state === 'finalizing') {
              disposition =
                current.desiredTerminalOutcome === 'cancelled' ? 'cancelled_finalizing' : 'completion_finalizing'
            } else if (current.state === 'cancelled') {
              disposition = 'already_cancelled'
            } else if (current.state === 'completed') {
              disposition = 'already_completed'
              const persistedEvent = db
                .prepare(
                  `SELECT revision FROM command_events
                   WHERE database_lineage = ? AND operation_id = ? AND type = 'generation.persisted'
                   ORDER BY revision DESC LIMIT 1`,
                )
                .get(databaseLineage, operationId) as { revision: number } | undefined
              completedResult = {
                ...(current.resultMessageId ? { messageId: current.resultMessageId } : {}),
                revision: persistedEvent?.revision ?? getSchemaState(db).revision,
              }
            }
          }
          db.exec('COMMIT')
          committed = true
        } catch (error) {
          if (!committed) db.exec('ROLLBACK')
          throw error
        }
        if (deleteJobId) dependencies.generationJobs.registry.deleteJob(deleteJobId, 'user_stop')
        if (abortJob) {
          abortJob.operationStateVersion = operation.stateVersion
          abortJob.projectionEpoch = operation.projectionEpoch
          abortJob.abortController.abort('user_stop')
        }
        return reply.code(statusCode).send({
          disposition,
          knownAttemptMatched,
          operation,
          ...(completedResult ? { result: completedResult } : {}),
        })
      } catch (error) {
        return sendOperationError(reply, error)
      }
    },
  )

  app.post<{ Params: { operationId: string } }>(
    '/api/v1/generation-operations/:operationId/retries',
    { config: { rateLimit: generationSubmitRateLimit } },
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const operationId = canonicalUuid(req.params.operationId, 'operationId')
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        const retryRequestId = canonicalUuid(req.body.retryRequestId, 'retryRequestId')
        if (!Number.isSafeInteger(req.body.expectedStateVersion) || (req.body.expectedStateVersion as number) <= 0) {
          throw new ValidationError('expectedStateVersion must be a positive integer')
        }
        const writerSessionId = readRequiredWriterSessionId(req)
        const writerEpoch = getDatabaseWriterMetadata(db).epoch
        let operation: GenerationOperationProjection
        let intent: GenerationOperationIntent
        let createdAttempt = false
        db.exec('BEGIN IMMEDIATE')
        let committed = false
        try {
          assertDatabaseLineage(db, databaseLineage)
          const replay = generationOperationForRetryRequest(db, databaseLineage, retryRequestId)
          if (replay?.operationId !== undefined && replay.operationId !== operationId) {
            throw new OperationHttpError(409, 'retry_request_id_conflict')
          }
          const current = getGenerationOperationProjection(db, databaseLineage, operationId)
          if (!current) throw new OperationHttpError(404, 'generation_operation_not_found')
          const stored = getGenerationOperationStoredRequest(db, databaseLineage, operationId)
          if (!stored?.intent || !isRecord(stored.intent)) {
            throw new OperationHttpError(409, 'operation_intent_missing')
          }
          intent = stored.intent as unknown as GenerationOperationIntent
          if (replay) {
            operation = current
          } else {
            if (current.state !== 'retryable' && current.state !== 'abandoned') {
              throw new OperationHttpError(409, 'operation_not_retryable', { operation: current })
            }
            if (current.stateVersion !== req.body.expectedStateVersion) {
              throw new OperationHttpError(409, 'operation_state_conflict', { operation: current })
            }
            const exactRequest: AtomicGenerationOperationRequest = {
              protocolVersion: 1,
              operationId,
              baseRevision: current.acceptedRevision ?? getSchemaState(db).revision,
              characterId: current.characterId!,
              chatId: current.chatId!,
              mode: current.mode!,
              acceptedMessageId: current.acceptedMessageId,
              targetMessageId: current.targetMessageId,
              message: intent.message,
              draftGeneration: intent.draftGeneration,
              generation: intent.generation,
            }
            validateTargetInTransaction(db, exactRequest)
            if (current.mode === 'send') {
              const tail = getChatMessages(db, current.chatId!).at(-1) as Record<string, unknown> | undefined
              if (!tail || tail.chatId !== current.acceptedMessageId || tail.role !== 'user') {
                throw new OperationHttpError(409, 'operation_target_stale', { operation: current })
              }
            }
            const settingsPreflight = preflightGenerationOperationSettings(
              assembleInputForIntent(intent, current.acceptedRevision).input,
              dataDir,
              db,
            )
            if (settingsPreflight.status === 'rejected') {
              const details = isRecord(settingsPreflight.body)
                ? settingsPreflight.body
                : { message: String(settingsPreflight.body) }
              throw new OperationHttpError(
                settingsPreflight.statusCode,
                typeof details.error === 'string' ? details.error : 'generation_settings_not_ready',
                details,
              )
            }
            const reservation = reserveGenerationOperationAttemptInTransaction(db, {
              databaseLineage,
              operationId,
              expectedState: current.state,
              expectedStateVersion: current.stateVersion,
              retryRequestId,
              jobId: randomUUID(),
              serverInstanceId: dependencies.serverInstanceId,
              actorWriterSessionId: writerSessionId,
              actorWriterEpoch: writerEpoch,
              launchRevision: getSchemaState(db).revision,
            })
            operation = reservation.operation ?? current
            createdAttempt = reservation.status === 'applied'
          }
          db.exec('COMMIT')
          committed = true
        } catch (error) {
          if (!committed) db.exec('ROLLBACK')
          throw error
        }
        if (
          operation.state === 'launching' &&
          operation.currentAttempt?.serverInstanceId === dependencies.serverInstanceId
        ) {
          operation = launchCommittedOperation({
            db,
            operation,
            intent,
            writerSessionId,
            writerEpoch,
            dependencies,
            req,
            retryRequestId,
            dataDir,
            eventSink,
            reuseAcceptedSubmitTransforms: true,
          })
        }
        // The persisted retry-request lookup remains valid after the live attempt
        // descriptor disappears. Return its receipt separately from stream authority.
        return reply.code(createdAttempt ? 202 : 200).send({
          ...operationResponse(operation),
          acceptedRetryRequestId: retryRequestId,
        })
      } catch (error) {
        return sendOperationError(reply, error)
      }
    },
  )
}
