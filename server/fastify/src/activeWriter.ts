import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabaseWriterMetadata, registerDatabaseWriterSession } from './databaseLineage.js'
import { routeRequiresActiveWriter } from './routeManifest.js'
import { createWriterEventBus, type WriterEventBus } from './writerEvents.js'

export const ACTIVE_WRITER_SESSION_HEADER = 'risu-writer-session'
export const DISCONNECT_EXISTING_WRITER_HEADER = 'risu-disconnect-existing-writer'

export interface ActiveWriterState {
  sessionId: string | null
  epoch: number
  db: DatabaseSync
  events: WriterEventBus
  connectedSessions: Map<string, number>
}

export function createActiveWriterState(db: DatabaseSync): ActiveWriterState {
  const metadata = getDatabaseWriterMetadata(db)
  return { ...metadata, db, events: createWriterEventBus(), connectedSessions: new Map() }
}

export function trackConnectedWriterSession(state: ActiveWriterState, sessionId: string | null): () => void {
  if (sessionId === null) return () => {}
  state.connectedSessions.set(sessionId, (state.connectedSessions.get(sessionId) ?? 0) + 1)

  let connected = true
  return () => {
    if (!connected) return
    connected = false
    const count = state.connectedSessions.get(sessionId) ?? 0
    if (count <= 1) {
      state.connectedSessions.delete(sessionId)
      return
    }
    state.connectedSessions.set(sessionId, count - 1)
  }
}

export function writerTakeoverRequiresConfirmation(state: ActiveWriterState, req: FastifyRequest): boolean {
  const requestedSessionId = readActiveWriterSessionId(req)
  const currentSessionId = state.sessionId
  if (requestedSessionId === null || currentSessionId === null || requestedSessionId === currentSessionId) {
    return false
  }
  return (state.connectedSessions.get(currentSessionId) ?? 0) > 0
}

export function disconnectExistingWriterWasConfirmed(req: FastifyRequest): boolean {
  const raw = req.headers[DISCONNECT_EXISTING_WRITER_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === 'true'
}

export function registerActiveWriterSession(state: ActiveWriterState, req: FastifyRequest): void {
  const sessionId = readActiveWriterSessionId(req)
  if (sessionId !== null) {
    const previousSessionId = state.sessionId
    const previousEpoch = state.epoch
    const ownership = registerDatabaseWriterSession(state.db, sessionId)
    state.sessionId = ownership.writer.sessionId
    state.epoch = ownership.writer.epoch
    if (ownership.writer.sessionId !== previousSessionId || ownership.writer.epoch !== previousEpoch) {
      state.events.emit({ databaseLineage: ownership.databaseLineage, ...ownership.writer })
    }
  }
}

export function requestedWriterWasActive(state: ActiveWriterState, req: FastifyRequest): boolean | undefined {
  const requestedSessionId = readActiveWriterSessionId(req)
  if (requestedSessionId === null) return undefined
  return state.sessionId === null || requestedSessionId === state.sessionId
}

export function registerActiveWriterGuard(app: FastifyInstance, state: ActiveWriterState): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!isServerOwnedMutation(req)) return
    requireActiveWriter(state, req, reply)
  })
}

export function requireActiveWriter(state: ActiveWriterState, req: FastifyRequest, reply: FastifyReply): boolean {
  if (isActiveWriter(state, req)) return true
  sendStaleWriterReply(reply)
  return false
}

function isActiveWriter(state: ActiveWriterState, req: FastifyRequest): boolean {
  if (state.sessionId === null) return true
  return readActiveWriterSessionId(req) === state.sessionId
}

export function readActiveWriterSessionId(req: FastifyRequest): string | null {
  const raw = req.headers[ACTIVE_WRITER_SESSION_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const sessionId = value.trim()
  if (sessionId.length === 0 || sessionId.length > 128) return null
  return sessionId
}

function sendStaleWriterReply(reply: FastifyReply): void {
  reply.code(423).send({
    error: 'active_writer_stale',
    reason: 'A newer browser session is now the active writer. Reload this session before saving.',
  })
}

function isServerOwnedMutation(req: FastifyRequest): boolean {
  const method = req.method.toUpperCase()
  const path = req.url.split('?')[0] ?? req.url
  return routeRequiresActiveWriter(method, path)
}
