import type { DatabaseSync } from 'node:sqlite'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { ActiveWriterState } from '../activeWriter.js'
import { readActiveWriterSessionId, trackConnectedWriterSession } from '../activeWriter.js'
import type { AuthState } from '../auth.js'
import { getDatabaseOwnershipSnapshot } from '../databaseLineage.js'
import {
  listPersistedCommandEventHistory,
  selectCommandEventReplay,
  type CommandEvent,
  type CommandEventSink,
} from '../commands/events.js'
import { getSchemaState } from '../db.js'
import { requireAuth } from '../http.js'
import {
  sanitizeMemoryJobError,
  type MemoryEvent,
  type MemoryEventBus,
  type MemoryJobSnapshot,
} from '../memoryEvents.js'
import { listMemoryJobItems } from '../memoryRepository.js'
import { listBardWikiJobSnapshotSummaries } from '../bardWikiRepository.js'
import { emitProtocolMetric, protocolDurationMs, protocolMetricsEnabled, protocolNowMs } from '../protocolMetrics.js'
import { writeBoundedRaw } from '../streamBackpressure.js'
import type { WriterEvent } from '../writerEvents.js'

function formatSseComment(comment: string): string {
  return `: ${comment}\n\n`
}

function formatCommandEvent(event: CommandEvent): string {
  return `id: ${event.revision}\nevent: command\ndata: ${JSON.stringify(event)}\n\n`
}

function formatMemoryEvent(event: MemoryEvent): string {
  return `event: memory\ndata: ${JSON.stringify(event)}\n\n`
}

function formatMemorySnapshot(snapshot: MemoryJobSnapshot): string {
  return `event: memory_snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`
}

function formatWriterEvent(event: { databaseLineage: string; sessionId: string | null; epoch: number }): string {
  return `event: writer\ndata: ${JSON.stringify(event)}\n\n`
}

type EventStreamFrameType = 'writer' | 'connected' | 'command' | 'memory_snapshot' | 'memory' | 'heartbeat'
type EventStreamCloseReason = 'normal_close' | 'client_abort' | 'slow_consumer_overflow' | 'replay_unavailable'

interface EventStreamMetricTracker {
  recordFrame(type: EventStreamFrameType, text: string): void
  finish(reason: EventStreamCloseReason): void
}

export function createEventStreamMetricTracker(logger?: FastifyBaseLogger): EventStreamMetricTracker | null {
  if (!protocolMetricsEnabled()) return null
  const startedAt = protocolNowMs()
  const frameCounts: Record<EventStreamFrameType, number> = {
    writer: 0,
    connected: 0,
    command: 0,
    memory_snapshot: 0,
    memory: 0,
    heartbeat: 0,
  }
  const frameBytes: Record<EventStreamFrameType, number> = {
    writer: 0,
    connected: 0,
    command: 0,
    memory_snapshot: 0,
    memory: 0,
    heartbeat: 0,
  }
  let rawBytes = 0
  let frameCount = 0
  let finished = false
  return {
    recordFrame(type, text) {
      const bytes = Buffer.byteLength(text, 'utf8')
      frameCounts[type] += 1
      frameBytes[type] += bytes
      frameCount += 1
      rawBytes += bytes
    },
    finish(reason) {
      if (finished) return
      finished = true
      emitProtocolMetric(
        'event_stream_connection',
        {
          rawBytes,
          frameCount,
          frameCounts,
          frameBytes,
          connectionLifetimeMs: protocolDurationMs(startedAt),
          closeReason: reason,
          writeOverflow: reason === 'slow_consumer_overflow',
        },
        logger,
      )
    },
  }
}

export function registerEventsRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  commandEvents: CommandEventSink,
  memoryEvents: MemoryEventBus,
  activeWriterState: ActiveWriterState,
): void {
  app.get('/api/v1/events', { exposeHeadRoute: false }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    const cursor = readReplayCursor(req.query, req.headers['last-event-id'])
    if (cursor.status === 'error') {
      reply.code(400).send({
        error: 'invalid_event_replay_cursor',
        reason: cursor.reason,
      })
      return
    }

    let liveCommandDelivery = false
    let liveMemoryDelivery = false
    let liveWriterDelivery = false
    const queuedCommandEvents: CommandEvent[] = []
    const queuedMemoryEvents: MemoryEvent[] = []
    const queuedWriterEvents: WriterEvent[] = []
    let heartbeat: NodeJS.Timeout | null = null
    let unsubscribeCommand: (() => void) | null = null
    let unsubscribeMemory: (() => void) | null = null
    let unsubscribeWriter: (() => void) | null = null
    let disconnectWriterSession: (() => void) | null = null
    let cleanedUp = false
    let streamMetrics: EventStreamMetricTracker | null = null
    const cleanup = (reason: EventStreamCloseReason): void => {
      if (cleanedUp) return
      cleanedUp = true
      if (heartbeat) {
        clearInterval(heartbeat)
      }
      unsubscribeCommand?.()
      unsubscribeMemory?.()
      unsubscribeWriter?.()
      disconnectWriterSession?.()
      req.raw.off('aborted', onRequestAborted)
      req.raw.off('close', onRequestClose)
      reply.raw.off('finish', onResponseFinish)
      reply.raw.off('close', onResponseClose)
      streamMetrics?.finish(reason)
    }
    const onRequestAborted = (): void => cleanup('client_abort')
    const onRequestClose = (): void => cleanup(reply.raw.writableEnded ? 'normal_close' : 'client_abort')
    const onResponseFinish = (): void => cleanup('normal_close')
    const onResponseClose = (): void => cleanup(reply.raw.writableEnded ? 'normal_close' : 'client_abort')
    const sendFrame = (type: EventStreamFrameType, text: string): boolean => {
      const written = writeBoundedRaw(reply.raw, text, {
        onOverflow: () => cleanup('slow_consumer_overflow'),
      })
      if (written) streamMetrics?.recordFrame(type, text)
      return written
    }
    unsubscribeCommand = commandEvents.subscribe((event) => {
      if (liveCommandDelivery) {
        if (!reply.raw.writableEnded) {
          sendFrame('command', formatCommandEvent(event))
        }
        return
      }
      queuedCommandEvents.push(event)
    })
    unsubscribeMemory = memoryEvents.subscribe((event) => {
      if (liveMemoryDelivery) {
        if (!reply.raw.writableEnded) {
          sendFrame('memory', formatMemoryEvent(event))
        }
        return
      }
      queuedMemoryEvents.push(event)
    })
    unsubscribeWriter = activeWriterState.events.subscribe((event) => {
      if (liveWriterDelivery) {
        if (!reply.raw.writableEnded) {
          sendFrame('writer', formatWriterEvent(event))
        }
        return
      }
      queuedWriterEvents.push(event)
    })
    const initialOwnership = getDatabaseOwnershipSnapshot(db)
    const initialWriterEvent = {
      databaseLineage: initialOwnership.databaseLineage,
      ...initialOwnership.writer,
    }
    const snapshotVersion = memoryEvents.snapshotVersion()
    const memorySnapshot: MemoryJobSnapshot = {
      type: 'memory.snapshot',
      ...snapshotVersion,
      jobs: listMemoryJobItems(db, { statuses: ['pending', 'running'] }).map((job) => ({
        ...job,
        error: sanitizeMemoryJobError(job.error),
      })),
      bardWikiJobs: listBardWikiJobSnapshotSummaries(db).map((job) => ({
        ...job,
        errorCode: sanitizeMemoryJobError(job.errorCode),
        errorSummary: sanitizeMemoryJobError(job.errorSummary),
      })),
    }
    req.raw.once('aborted', onRequestAborted)
    req.raw.once('close', onRequestClose)
    reply.raw.once('finish', onResponseFinish)
    reply.raw.once('close', onResponseClose)

    const currentRevision = getSchemaState(db).revision
    // The full history read+map exists for replay — and for the opt-in
    // replay metric's oldest/latest fields, so metric output stays identical
    // when metrics are on. A fresh no-replay connect in the default config
    // must not pay it.
    const history =
      cursor.sinceRevision !== null || protocolMetricsEnabled()
        ? listPersistedCommandEventHistory(db)
        : ([] as readonly CommandEvent[])
    const replay =
      cursor.sinceRevision === null
        ? { status: 'ok' as const, events: [] as readonly CommandEvent[] }
        : selectCommandEventReplay(history, cursor.sinceRevision, currentRevision)

    if (replay.status === 'unavailable') {
      cleanup('replay_unavailable')
      emitProtocolMetric(
        'event_replay',
        {
          status: 'unavailable',
          requestedRevision: cursor.sinceRevision,
          currentRevision: replay.currentRevision,
          oldestRevision: replay.oldestRevision,
          latestRevision: replay.latestRevision,
        },
        req.log,
      )
      reply.code(409).send({
        error: 'event_replay_unavailable',
        requestedRevision: cursor.sinceRevision,
        currentRevision: replay.currentRevision,
        ...(replay.oldestRevision !== undefined ? { oldestRevision: replay.oldestRevision } : {}),
        ...(replay.latestRevision !== undefined ? { latestRevision: replay.latestRevision } : {}),
      })
      return
    }
    emitProtocolMetric(
      'event_replay',
      {
        status: 'ok',
        requestedRevision: cursor.sinceRevision,
        currentRevision,
        replayedEventCount: replay.events.length,
        oldestRevision: history[0]?.revision,
        latestRevision: history.at(-1)?.revision,
      },
      req.log,
    )

    streamMetrics = createEventStreamMetricTracker(req.log)
    reply.hijack()
    disconnectWriterSession = trackConnectedWriterSession(activeWriterState, readActiveWriterSessionId(req))
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    sendFrame('writer', formatWriterEvent(initialWriterEvent))
    sendFrame('connected', formatSseComment('connected'))
    sendFrame('memory_snapshot', formatMemorySnapshot(memorySnapshot))
    for (const event of queuedWriterEvents) {
      if (!reply.raw.writableEnded) {
        sendFrame('writer', formatWriterEvent(event))
      }
    }
    queuedWriterEvents.length = 0
    liveWriterDelivery = true
    for (const event of replay.events) {
      if (!reply.raw.writableEnded) {
        sendFrame('command', formatCommandEvent(event))
      }
    }
    for (const event of queuedCommandEvents) {
      if (!reply.raw.writableEnded && (cursor.sinceRevision === null || event.revision > currentRevision)) {
        sendFrame('command', formatCommandEvent(event))
      }
    }
    queuedCommandEvents.length = 0
    liveCommandDelivery = true

    const armed = armSseLiveDelivery({
      tornDown: () => cleanedUp,
      startHeartbeat: () =>
        setInterval(() => {
          if (!reply.raw.writableEnded) {
            sendFrame('heartbeat', formatSseComment('heartbeat'))
          }
        }, 25_000),
      subscribeMemory: () => {
        for (const event of queuedMemoryEvents) {
          if (
            !reply.raw.writableEnded &&
            event.streamId === memorySnapshot.streamId &&
            typeof event.version === 'number' &&
            event.version > memorySnapshot.version
          ) {
            sendFrame('memory', formatMemoryEvent(event))
          }
        }
        queuedMemoryEvents.length = 0
        liveMemoryDelivery = true
        return unsubscribeMemory ?? (() => {})
      },
    })
    heartbeat = armed.heartbeat
    unsubscribeMemory = armed.unsubscribeMemory
  })
}

/**
 * Arm the live-delivery legs (heartbeat interval + memory-event fanout) after
 * the replay flush. When the flush itself tore the stream down — a
 * slow-consumer overflow runs `cleanup` mid-handler via `writeBoundedRaw`'s
 * `onOverflow` — arming anyway would leak both forever: `cleanup` already ran
 * and its `cleanedUp` latch keeps it from ever running again.
 * Exported for the regression test.
 */
export function armSseLiveDelivery(args: {
  tornDown: () => boolean
  startHeartbeat: () => NodeJS.Timeout
  subscribeMemory: () => () => void
}): { heartbeat: NodeJS.Timeout | null; unsubscribeMemory: (() => void) | null } {
  if (args.tornDown()) {
    return { heartbeat: null, unsubscribeMemory: null }
  }
  const heartbeat = args.startHeartbeat()
  heartbeat.unref()
  return { heartbeat, unsubscribeMemory: args.subscribeMemory() }
}

type ReplayCursorResult = { status: 'ok'; sinceRevision: number | null } | { status: 'error'; reason: string }

function readReplayCursor(query: unknown, lastEventIdHeader: unknown): ReplayCursorResult {
  const queryValue = readQuerySinceRevision(query)
  if (queryValue !== undefined) {
    return parseCursorValue(queryValue, 'sinceRevision')
  }

  const headerValue = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader
  if (headerValue !== undefined) {
    return parseCursorValue(headerValue, 'Last-Event-ID')
  }

  return { status: 'ok', sinceRevision: null }
}

function readQuerySinceRevision(query: unknown): unknown {
  if (!query || typeof query !== 'object') return undefined
  const value = (query as { sinceRevision?: unknown }).sinceRevision
  return Array.isArray(value) ? value[0] : value
}

function parseCursorValue(value: unknown, label: string): ReplayCursorResult {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { status: 'error', reason: `${label} must be a non-negative integer` }
  }
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) {
    return { status: 'error', reason: `${label} must be a non-negative integer` }
  }
  const revision = Number(text)
  if (!Number.isSafeInteger(revision)) {
    return { status: 'error', reason: `${label} must be a safe integer` }
  }
  return { status: 'ok', sinceRevision: revision }
}
