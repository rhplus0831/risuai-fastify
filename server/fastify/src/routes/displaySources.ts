import type { FastifyInstance } from 'fastify'
import type { AuthState } from '../auth.js'
import { requireAuth } from '../http.js'
import { readChatId } from '../commands/chats.js'
import { EntityNotFoundError, ValidationError } from '../repository.js'
import {
  DISPLAY_SOURCE_LIMITS,
  DISPLAY_SOURCE_PROTOCOL_VERSION,
  normalizeDisplayRequestContext,
  type DisplaySourceLayer,
  type DisplaySourceRequest,
  type DisplaySourceTarget,
  type DisplaySourceStreamEvent,
} from '@risuai/protocol/display-source'
import type { DisplaySourceService } from '../displaySourceService.js'
import { displaySourceFailureDiagnostic } from '../displaySourceService.js'
import { recordDiagnosticEvent } from '../diagnosticContext.js'
import { writeBoundedRaw } from '../streamBackpressure.js'

const DISPLAY_SOURCE_LAYERS: ReadonlySet<DisplaySourceLayer> = new Set([
  'original',
  'translation',
  'bilingual',
  'greeting',
  'preview',
])
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u
const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/u

function nonEmptyBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new ValidationError(`${label} must be between 1 and ${maxLength} characters`)
  }
  return normalized
}

function readTarget(value: unknown, index: number): DisplaySourceTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`targets[${index}] must be an object`)
  }
  const raw = value as Record<string, unknown>
  const requestKey = nonEmptyBoundedString(
    raw.requestKey,
    `targets[${index}].requestKey`,
    DISPLAY_SOURCE_LIMITS.maxRequestKeyLength,
  )
  const characterId = nonEmptyBoundedString(raw.characterId, `targets[${index}].characterId`, 256)
  if (!ID_PATTERN.test(characterId)) throw new ValidationError(`targets[${index}].characterId is invalid`)
  const messageId =
    raw.messageId === undefined ? undefined : nonEmptyBoundedString(raw.messageId, `targets[${index}].messageId`, 256)
  if (messageId !== undefined && !ID_PATTERN.test(messageId)) {
    throw new ValidationError(`targets[${index}].messageId is invalid`)
  }
  if (!Number.isSafeInteger(raw.index) || (raw.index as number) < -1) {
    throw new ValidationError(`targets[${index}].index must be an integer greater than or equal to -1`)
  }
  if (raw.role !== null && (typeof raw.role !== 'string' || raw.role.length > 64)) {
    throw new ValidationError(`targets[${index}].role must be null or a bounded string`)
  }
  if (typeof raw.firstMessage !== 'boolean') {
    throw new ValidationError(`targets[${index}].firstMessage must be a boolean`)
  }
  if (typeof raw.layer !== 'string' || !DISPLAY_SOURCE_LAYERS.has(raw.layer as DisplaySourceLayer)) {
    throw new ValidationError(`targets[${index}].layer is invalid`)
  }
  if (typeof raw.source !== 'string') throw new ValidationError(`targets[${index}].source must be a string`)
  if (Buffer.byteLength(raw.source, 'utf8') > DISPLAY_SOURCE_LIMITS.maxSourceBytes) {
    throw new ValidationError(`targets[${index}].source exceeds the byte limit`)
  }
  if (typeof raw.sourceHash !== 'string' || !SOURCE_HASH_PATTERN.test(raw.sourceHash)) {
    throw new ValidationError(`targets[${index}].sourceHash must be a lowercase SHA-256 digest`)
  }
  if (!Number.isSafeInteger(raw.projectionEpoch) || (raw.projectionEpoch as number) < 0) {
    throw new ValidationError(`targets[${index}].projectionEpoch must be a non-negative integer`)
  }
  if (raw.streaming !== undefined && typeof raw.streaming !== 'boolean') {
    throw new ValidationError(`targets[${index}].streaming must be a boolean when present`)
  }
  const name = raw.name === undefined ? undefined : nonEmptyBoundedString(raw.name, `targets[${index}].name`, 256)
  return {
    requestKey,
    characterId,
    ...(messageId ? { messageId } : {}),
    index: raw.index as number,
    role: raw.role as string | null,
    firstMessage: raw.firstMessage,
    layer: raw.layer as DisplaySourceLayer,
    source: raw.source,
    sourceHash: raw.sourceHash,
    projectionEpoch: raw.projectionEpoch as number,
    ...(raw.streaming === true ? { streaming: true } : {}),
    ...(name ? { name } : {}),
  }
}

export function readDisplaySourceRequest(value: unknown): DisplaySourceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('request body must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.protocolVersion !== DISPLAY_SOURCE_PROTOCOL_VERSION) {
    throw new ValidationError(`protocolVersion must be ${DISPLAY_SOURCE_PROTOCOL_VERSION}`)
  }
  if (!Number.isSafeInteger(raw.baseRevision) || (raw.baseRevision as number) < 0) {
    throw new ValidationError('baseRevision must be a non-negative integer')
  }
  const context = normalizeDisplayRequestContext(raw.context)
  if (!context) throw new ValidationError('context is invalid')
  if (
    !Array.isArray(raw.targets) ||
    raw.targets.length === 0 ||
    raw.targets.length > DISPLAY_SOURCE_LIMITS.maxTargets
  ) {
    throw new ValidationError(`targets must contain between 1 and ${DISPLAY_SOURCE_LIMITS.maxTargets} entries`)
  }
  const targets = raw.targets.map(readTarget)
  const requestKeys = new Set(targets.map((target) => target.requestKey))
  if (requestKeys.size !== targets.length) throw new ValidationError('target requestKey values must be unique')
  if (
    raw.priorityKeys !== undefined &&
    (!Array.isArray(raw.priorityKeys) ||
      raw.priorityKeys.length > targets.length ||
      raw.priorityKeys.some((key) => typeof key !== 'string' || !requestKeys.has(key)) ||
      new Set(raw.priorityKeys).size !== raw.priorityKeys.length)
  )
    throw new ValidationError('priorityKeys must contain unique keys from targets')
  const totalSourceBytes = targets.reduce((total, target) => total + Buffer.byteLength(target.source, 'utf8'), 0)
  if (totalSourceBytes > DISPLAY_SOURCE_LIMITS.maxRequestSourceBytes) {
    throw new ValidationError('display source request exceeds the total source byte limit')
  }
  return {
    protocolVersion: DISPLAY_SOURCE_PROTOCOL_VERSION,
    baseRevision: raw.baseRevision as number,
    context,
    targets,
    ...(raw.priorityKeys === undefined ? {} : { priorityKeys: raw.priorityKeys as string[] }),
  }
}

export function registerDisplaySourceRoutes(
  app: FastifyInstance,
  authState: AuthState,
  service: DisplaySourceService,
): void {
  app.post('/api/v1/chats/:chatId/display-sources', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    const controller = new AbortController()
    const streaming = req.headers.accept?.includes('text/event-stream') === true
    let streamStarted = false
    const send = (event: DisplaySourceStreamEvent) => {
      if (controller.signal.aborted) throw controller.signal.reason
      if (!streamStarted) {
        streamStarted = true
        reply.hijack()
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value)
        }
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        })
      }
      const { type, ...data } = event
      if (
        !writeBoundedRaw(reply.raw, `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`, {
          onOverflow: () => controller.abort(new Error('Display source stream buffer exceeded')),
        })
      ) {
        controller.abort(new Error('Display source stream closed'))
        throw controller.signal.reason
      }
    }
    const abortRequest = () => {
      if (!controller.signal.aborted) controller.abort(new Error('Display source client disconnected'))
    }
    const abortClosedResponse = () => {
      if (!reply.raw.writableEnded) abortRequest()
    }
    req.raw.once('aborted', abortRequest)
    reply.raw.once('close', abortClosedResponse)
    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const request = readDisplaySourceRequest(req.body)
      if (!streaming) return await service.transformBatch(chatId, request, controller.signal)
      const delivered = new Set<string>()
      const response = await service.transformBatch(chatId, request, controller.signal, (result) => {
        for (const entry of result.entries) {
          send({
            type: 'result',
            protocolVersion: result.protocolVersion,
            revision: result.revision,
            contextFingerprint: result.contextFingerprint,
            entry,
          })
          delivered.add(entry.requestKey)
        }
      })
      const retired = response.entries.find(
        (entry) =>
          entry.status === 'stale' &&
          (entry.reason === 'revision_changed_during_transform' || entry.reason === 'display_namespace_retired'),
      )
      if (retired && retired.status !== 'ok') {
        send({ type: 'invalidated', revision: response.revision, reason: retired.reason })
      } else {
        for (const entry of response.entries) {
          if (!delivered.has(entry.requestKey))
            send({
              type: 'result',
              protocolVersion: response.protocolVersion,
              revision: response.revision,
              contextFingerprint: response.contextFingerprint,
              entry,
            })
        }
        send({
          type: 'done',
          protocolVersion: response.protocolVersion,
          revision: response.revision,
          contextFingerprint: response.contextFingerprint,
          targetCount: response.entries.length,
        })
      }
      reply.raw.end()
      return reply
    } catch (error) {
      if (controller.signal.aborted) return reply
      if (streamStarted) {
        recordDiagnosticEvent({ category: 'display', level: 'error', ...displaySourceFailureDiagnostic(error) })
        req.log.error({ err: error }, 'display source stream failed')
        send({ type: 'error', reason: 'display_source_transform_failed' })
        reply.raw.end()
        return reply
      }
      if (error instanceof EntityNotFoundError) return reply.code(404).send({ error: error.message })
      if (error instanceof ValidationError) {
        const isRevisionConflict = error.message.includes('base revision is stale')
        return reply.code(isRevisionConflict ? 409 : 400).send({
          error: isRevisionConflict ? 'revision_conflict' : error.message,
          ...(isRevisionConflict ? { currentRevision: service.currentRevision() } : {}),
        })
      }
      const diagnostic = displaySourceFailureDiagnostic(error)
      recordDiagnosticEvent({ category: 'display', level: 'error', ...diagnostic })
      req.log.error({ err: error, displaySourceFailure: diagnostic }, 'display source transform failed')
      return reply.code(500).send({ error: 'display_source_transform_failed' })
    } finally {
      req.raw.off('aborted', abortRequest)
      reply.raw.off('close', abortClosedResponse)
    }
  })
}
