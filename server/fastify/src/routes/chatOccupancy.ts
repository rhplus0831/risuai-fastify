import {
  CHAT_OCCUPANCY_EPOCH_HEADER,
  CHAT_OCCUPANCY_NORMALIZE_ENDPOINT,
  CHAT_OCCUPANCY_PROTOCOL_VERSION,
  CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT,
  CHAT_OCCUPANCY_SWITCH_ENDPOINT,
  isChatOccupancyClaimRequest,
  isChatOccupancyNormalizeRequest,
  isChatOccupancySwitchRequest,
  isChatOccupancyVersionRequest,
} from '@risuai/protocol/chat-occupancy'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthState } from '../auth.js'
import { ACTIVE_WRITER_SESSION_HEADER, readActiveWriterSessionId } from '../activeWriter.js'
import { ChatOccupancyError, type ChatOccupancyService } from '../chatOccupancy.js'
import { DATABASE_LINEAGE_HEADER } from '../databaseLineage.js'
import { requireAuth } from '../http.js'

export interface ChatOccupancyRouteOptions {
  enabled?: boolean
}

export function registerChatOccupancyRoutes(
  app: FastifyInstance,
  authState: AuthState,
  service: ChatOccupancyService,
  options: ChatOccupancyRouteOptions = {},
): void {
  const enabled = options.enabled === true

  app.get(CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT, { exposeHeadRoute: false }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!(await requireAuth(authState, request, reply))) return
    return service.snapshot()
  })

  app.post<{ Params: { chatId: string }; Body: unknown }>(
    `${CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT}/:chatId/claim`,
    async (request, reply) => {
      if (!(await requireAuth(authState, request, reply))) return
      if (!isChatOccupancyClaimRequest(request.body)) return protocolRequired(reply, enabled)
      if (!enabled) return protocolRequired(reply, false)
      try {
        return service.claim({
          databaseLineage: readLineage(request),
          chatId: request.params.chatId,
          sessionId: readSession(request),
          claimClass: request.body.claimClass,
          expectedOccupancyEpoch: readEpoch(request),
        })
      } catch (error) {
        return sendOccupancyError(reply, error)
      }
    },
  )

  app.put<{ Params: { chatId: string }; Body: unknown }>(
    `${CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT}/:chatId/lease`,
    async (request, reply) => {
      if (!(await requireAuth(authState, request, reply))) return
      if (!isChatOccupancyVersionRequest(request.body)) return protocolRequired(reply, enabled)
      try {
        return service.renew(readTuple(request, request.params.chatId))
      } catch (error) {
        return sendOccupancyError(reply, error)
      }
    },
  )

  app.delete<{ Params: { chatId: string }; Body: unknown }>(
    `${CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT}/:chatId`,
    async (request, reply) => {
      if (!(await requireAuth(authState, request, reply))) return
      if (!isChatOccupancyVersionRequest(request.body)) return protocolRequired(reply, enabled)
      try {
        return service.release(readTuple(request, request.params.chatId))
      } catch (error) {
        return sendOccupancyError(reply, error)
      }
    },
  )

  app.post<{ Body: unknown }>(CHAT_OCCUPANCY_SWITCH_ENDPOINT, async (request, reply) => {
    if (!(await requireAuth(authState, request, reply))) return
    if (!isChatOccupancySwitchRequest(request.body)) return protocolRequired(reply, enabled)
    if (!enabled) return protocolRequired(reply, false)
    try {
      return service.switch({
        ...readTuple(request, request.body.sourceChatId),
        targetChatId: request.body.targetChatId,
      })
    } catch (error) {
      return sendOccupancyError(reply, error)
    }
  })

  app.post<{ Body: unknown }>(CHAT_OCCUPANCY_NORMALIZE_ENDPOINT, async (request, reply) => {
    if (!(await requireAuth(authState, request, reply))) return
    if (!isChatOccupancyNormalizeRequest(request.body)) return protocolRequired(reply, enabled)
    try {
      return service.normalize(readTuple(request, request.body.selectedChatId))
    } catch (error) {
      return sendOccupancyError(reply, error)
    }
  })
}

function readTuple(request: FastifyRequest, chatId: string) {
  return {
    databaseLineage: readLineage(request),
    chatId,
    sessionId: readSession(request),
    occupancyEpoch: readEpoch(request),
  }
}

function readEpoch(request: FastifyRequest): number {
  const rawEpoch = request.headers[CHAT_OCCUPANCY_EPOCH_HEADER]
  const epoch = Array.isArray(rawEpoch) ? rawEpoch[0] : rawEpoch
  if (typeof epoch !== 'string' || !/^(0|[1-9]\d*)$/u.test(epoch) || !Number.isSafeInteger(Number(epoch))) {
    throw new Error(`${CHAT_OCCUPANCY_EPOCH_HEADER} header is required`)
  }
  return Number(epoch)
}

function readLineage(request: FastifyRequest): string {
  const raw = request.headers[DATABASE_LINEAGE_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`${DATABASE_LINEAGE_HEADER} header is required`)
  }
  return value
}

function readSession(request: FastifyRequest): string {
  const sessionId = readActiveWriterSessionId(request)
  if (!sessionId) throw new Error(`${ACTIVE_WRITER_SESSION_HEADER} header is required`)
  return sessionId
}

function protocolRequired(reply: FastifyReply, enabled: boolean) {
  return reply.code(426).send({
    error: 'chat_occupancy_protocol_required',
    supportedVersion: CHAT_OCCUPANCY_PROTOCOL_VERSION,
    enabled,
    reason: enabled
      ? 'This request must use the exact chat occupancy protocol version.'
      : 'Chat occupancy claims are not enabled on this server.',
  })
}

function sendOccupancyError(reply: FastifyReply, error: unknown) {
  if (error instanceof ChatOccupancyError) {
    return reply.code(error.statusCode).send({ error: error.code, ...error.details })
  }
  if (error instanceof Error) return reply.code(400).send({ error: error.message })
  throw error
}
