import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  STARTUP_TELEMETRY_PROTOCOL_VERSION,
  isStartupTelemetryBatch,
  type StartupTelemetryEvent,
} from '@risuai/protocol/startup-telemetry'
import type { AuthState } from '../auth.js'
import { requireAuth } from '../http.js'
import { emitProtocolMetric } from '../protocolMetrics.js'
import { readRequestTraceUid } from '../requestTrace.js'

export const STARTUP_TELEMETRY_BODY_LIMIT = 16 * 1024

export function registerStartupTelemetryRoutes(app: FastifyInstance, authState: AuthState): void {
  app.post<{ Body: unknown }>(
    '/api/v1/telemetry/startup',
    { bodyLimit: STARTUP_TELEMETRY_BODY_LIMIT },
    async (request, reply) => {
      if (!(await requireAuth(authState, request, reply))) return
      if (!isStartupTelemetryBatch(request.body)) {
        reply.code(400).send({
          error: 'invalid_startup_telemetry',
          reason: 'Startup telemetry must match the versioned metadata-only contract.',
        })
        return
      }

      const requestUid = readRequestTraceUid(request)
      for (const event of request.body.events) {
        try {
          emitProtocolMetric('browser_startup', () => metricFields(event, requestUid), request.log)
        } catch {
          // Diagnostics must not affect the client request or any readiness path.
        }
      }
      reply.code(204).send()
    },
  )
}

function metricFields(event: StartupTelemetryEvent, requestUid?: string): Record<string, unknown> {
  return {
    schemaVersion: STARTUP_TELEMETRY_PROTOCOL_VERSION,
    kind: event.kind,
    attemptCount: event.attemptCount,
    ...(event.kind === 'phase-ready' ? { milestone: event.milestone, entryDurationMs: event.entryDurationMs } : {}),
    ...(event.kind === 'attempt-completed' || event.kind === 'attempt-failed'
      ? { attemptDurationMs: event.attemptDurationMs }
      : {}),
    ...(event.kind === 'attempt-failed' || event.kind === 'diagnostic-failure'
      ? { failureCode: event.failureCode, failureMilestone: event.failureMilestone }
      : {}),
    ...(requestUid ? { requestUid } : {}),
  }
}
