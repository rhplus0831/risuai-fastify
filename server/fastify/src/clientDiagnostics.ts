import type { FastifyInstance } from 'fastify'
import { performance } from 'node:perf_hooks'
import {
  DIAGNOSTICS_ENDPOINT,
  DIAGNOSTICS_LIMIT,
  DIAGNOSTICS_VERSION,
  DIAGNOSTIC_METRICS,
  diagnosticErrorFields,
  projectDiagnosticEntry,
  type DiagnosticEntry,
} from '@risuai/protocol/diagnostics'
import type { AuthState } from './auth.js'
import { requireAuth } from './http.js'
import { ensureRequestTraceUid, readRequestTraceUid } from './requestTrace.js'
import { findProtocolRouteDecision } from './routeManifest.js'
import { subscribeProtocolMetrics } from './protocolMetrics.js'
import {
  diagnosticSizeBucket,
  isDiagnosticTransportUrl,
  parseRemoteDiagnosticsQuery,
  type RemoteDiagnosticsResponse,
} from '@risuai/protocol/remote-diagnostics'
import { getDiagnosticContext, diagnosticsContextEnabled } from './diagnosticContext.js'
import {
  createRemoteDiagnosticsReader,
  SUPPORT_DIAGNOSTIC_STATUS,
  type RemoteDiagnosticsSource,
} from './remoteDiagnostics.js'
import { supportDiagnosticsRateLimit } from './routeRateLimits.js'

export function createClientDiagnostics(enabled: boolean) {
  let entries: DiagnosticEntry[] = []
  type HttpFacts = {
    requestBytes: ReturnType<typeof diagnosticSizeBucket>
    responseBytes: ReturnType<typeof diagnosticSizeBucket>
  }
  const listeners = new Set<(entry: DiagnosticEntry, http?: HttpFacts) => void>()
  const record = (input: Record<string, unknown>, http?: HttpFacts) => {
    if (!enabled) return
    const entry = projectDiagnosticEntry({ ...input, timestamp: Date.now(), source: 'server' })
    if (!entry) return
    entries.push(entry)
    if (entries.length > DIAGNOSTICS_LIMIT) entries.shift()
    for (const listener of listeners) {
      try {
        listener(projectDiagnosticEntry(entry)!, http)
      } catch {
        /* Telemetry is best effort. */
      }
    }
  }
  return {
    enabled,
    record,
    subscribe(listener: (entry: DiagnosticEntry, http?: HttpFacts) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => entries.map((entry) => projectDiagnosticEntry(entry)!),
    clear: () => {
      entries = []
    },
    recordLog(args: unknown[], level: number) {
      if (!enabled || level < 40) return
      try {
        const first = args[0]
        const error =
          first instanceof Error
            ? first
            : first && typeof first === 'object'
              ? (first as Record<string, unknown>).err
              : undefined
        record({
          event: 'console',
          level: level >= 50 ? 'error' : 'warn',
          ...diagnosticErrorFields(error instanceof Error ? error : new Error()),
        })
      } catch {
        /* Logging must not affect the operation being observed. */
      }
    },
  }
}

export type ClientDiagnostics = ReturnType<typeof createClientDiagnostics>

export function registerClientDiagnosticsHooks(app: FastifyInstance, diagnostics: ClientDiagnostics): void {
  if (!diagnostics.enabled) return
  const starts = new WeakMap<object, number>()
  // Scope the process-wide metric subscription to requests belonging to this app.
  const requestUids = new Set<string>()
  app.addHook('onRequest', async (request, reply) => {
    if (isDiagnosticTransportUrl(request.url)) return
    const uid = ensureRequestTraceUid(request, reply)
    starts.set(request, performance.now())
    requestUids.add(uid)
    if (requestUids.size > 2_000) requestUids.delete(requestUids.values().next().value!)
  })
  app.addHook('onError', async (request, _reply, error) => {
    if (isDiagnosticTransportUrl(request.url)) return
    diagnostics.record({
      event: 'runtime-error',
      level: 'error',
      requestUid: readRequestTraceUid(request),
      routeId: findProtocolRouteDecision(request.method, request.url.split('?')[0])?.id ?? 'unknown',
      ...diagnosticErrorFields(error),
    })
  })
  app.addHook('onResponse', async (request, reply) => {
    if (isDiagnosticTransportUrl(request.url)) return
    const route = findProtocolRouteDecision(request.method, request.url.split('?')[0])
    if (route?.id === 'diagnostics-read' || !request.url.startsWith('/api/')) return
    const bytes = (value: unknown) =>
      typeof value === 'number'
        ? diagnosticSizeBucket(value)
        : typeof value === 'string' && /^[0-9]{1,16}$/.test(value)
          ? diagnosticSizeBucket(Number(value))
          : 'unknown'
    diagnostics.record(
      {
        event: 'http',
        level: reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info',
        routeId: route?.id ?? 'unknown',
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: Math.round(Math.max(0, performance.now() - (starts.get(request) ?? performance.now()))),
        requestUid: readRequestTraceUid(request),
      },
      {
        requestBytes: bytes(request.headers['content-length']),
        responseBytes: bytes(reply.getHeader('content-length')),
      },
    )
  })
  const unsubscribe = subscribeProtocolMetrics(
    (metric) => {
      if (!DIAGNOSTIC_METRICS.some((name) => name === metric.metric)) return
      const context = getDiagnosticContext()
      if (context && (context.owner !== diagnostics || !diagnosticsContextEnabled())) return
      if (!context && (typeof metric.requestUid !== 'string' || !requestUids.has(metric.requestUid))) return
      diagnostics.record({
        event: 'protocol',
        level: metric.status === 'error' ? 'error' : 'info',
        metric: metric.metric,
        requestUid: context?.requestUid ?? metric.requestUid,
        durationMs: metric.durationMs,
        payloadBytes: metric.payloadBytes,
        attemptCount: metric.attemptCount,
        outcome: metric.status,
        phase: metric.milestone,
        code: metric.failureCode ?? metric.kind,
      })
    },
    { namesWhenDisabled: DIAGNOSTIC_METRICS },
  )
  app.addHook('onClose', async () => {
    unsubscribe()
    diagnostics.clear()
    requestUids.clear()
  })
  diagnostics.record({ event: 'server-started', level: 'info' })
}

export function registerClientDiagnosticsRoutes(
  app: FastifyInstance,
  auth: AuthState,
  diagnostics: ClientDiagnostics,
  source?: RemoteDiagnosticsSource,
  identity?: RemoteDiagnosticsResponse['identity'],
): void {
  const reader = source && identity ? createRemoteDiagnosticsReader(source, identity) : undefined
  app.addHook('onClose', async () => reader?.clear())
  app.get(
    DIAGNOSTICS_ENDPOINT,
    {
      exposeHeadRoute: false,
      bodyLimit: 1024,
      config: { rateLimit: supportDiagnosticsRateLimit },
      errorHandler: (error, _request, reply) => {
        const category =
          error.statusCode === 429
            ? 'rate-limited'
            : error.statusCode && error.statusCode < 500
              ? 'invalid-query'
              : 'internal-error'
        reply.header('cache-control', 'no-store').code(SUPPORT_DIAGNOSTIC_STATUS[category]).send({ error: category })
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      if (!(await requireAuth(auth, request, reply))) return
      if (diagnostics.enabled && reader && (request.query as Record<string, unknown>)?.version !== undefined) {
        const query =
          request.url.length <= DIAGNOSTICS_ENDPOINT.length + 2048 ? parseRemoteDiagnosticsQuery(request.query) : null
        if (!query || query.version !== 2) return reply.code(400).send({ error: 'invalid-query' })
        const result = reader.read(query)
        if (typeof result === 'string') return reply.code(SUPPORT_DIAGNOSTIC_STATUS[result]).send({ error: result })
        return result
      }
      return { version: DIAGNOSTICS_VERSION, enabled: diagnostics.enabled, entries: diagnostics.snapshot() }
    },
  )
}
