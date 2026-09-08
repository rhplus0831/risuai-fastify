import type { FastifyInstance } from 'fastify'
import {
  BROWSER_DIAGNOSTICS_ENDPOINT,
  BROWSER_DIAGNOSTICS_MAX_BYTES,
  isBrowserDiagnosticsBatch,
  isBrowserDiagnosticsUploadResponse,
  type BrowserDiagnosticsBatch,
  type BrowserDiagnosticsUploadResponse,
} from '@risuai/protocol/remote-diagnostics'
import { hasPassword, isAgentDevAuthBypassed, verifyAssertion, type AuthState } from '../auth.js'
import { extractRisuAuth } from '../http.js'
import { browserDiagnosticsRateLimit } from '../routeRateLimits.js'

export const BROWSER_DIAGNOSTICS_SOURCE_REQUESTS_PER_MINUTE = 24
const MAX_TRACKED_SOURCES = 256
const WINDOW_MS = 60_000

export interface BrowserDiagnosticsRouteOptions {
  enabled: boolean
  ingest(batch: BrowserDiagnosticsBatch): BrowserDiagnosticsUploadResponse | null
}

/** Reader-authenticated telemetry admission never acquires writer ownership. */
export function registerBrowserDiagnosticsRoutes(
  app: FastifyInstance,
  auth: AuthState,
  options: BrowserDiagnosticsRouteOptions,
): void {
  const sources = new Map<string, { expiresAt: number; count: number }>()
  app.addHook('onClose', async () => {
    sources.clear()
  })
  app.post<{ Body: unknown }>(
    BROWSER_DIAGNOSTICS_ENDPOINT,
    {
      bodyLimit: BROWSER_DIAGNOSTICS_MAX_BYTES,
      config: { rateLimit: browserDiagnosticsRateLimit },
      onRequest: async (request, reply) => {
        reply.header('cache-control', 'no-store')
        const timer = setTimeout(() => reply.raw.destroy(), 10_000)
        timer.unref()
        reply.raw.once('close', () => clearTimeout(timer))
        reply.raw.once('finish', () => clearTimeout(timer))
        // Ordinary browser sessions use risu-auth assertions/session tokens.
        // A support-shaped token remains denied even under development bypass.
        if (
          (typeof request.headers.authorization === 'string' &&
            /^Bearer [a-f0-9]{64}$/i.test(request.headers.authorization)) ||
          (typeof request.headers['risu-auth'] === 'string' && /^[a-f0-9]{64}$/i.test(request.headers['risu-auth']))
        )
          return reply.code(401).send({ error: 'unauthorized' })
        if (
          !isAgentDevAuthBypassed(auth) &&
          (!hasPassword(auth) || !(await verifyAssertion(auth, extractRisuAuth(request))).ok)
        )
          return reply.code(401).send({ error: 'unauthorized' })
        if (!options.enabled) return reply.code(503).send({ error: 'disabled' })
        if (request.url !== BROWSER_DIAGNOSTICS_ENDPOINT) return reply.code(400).send({ error: 'invalid-batch' })
        const contentType = request.headers['content-type']
        if (
          typeof contentType !== 'string' ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
          request.headers['content-encoding'] !== undefined
        )
          return reply.code(415).send({ error: 'invalid-batch' })
        const length = request.headers['content-length']
        if (length !== undefined && (!/^\d{1,10}$/.test(length) || Number(length) > BROWSER_DIAGNOSTICS_MAX_BYTES)) {
          return reply.code(413).send({ error: 'invalid-batch' })
        }
      },
      errorHandler: (error, _request, reply) => {
        const status =
          error.statusCode === 429
            ? 429
            : error.statusCode === 413
              ? 413
              : error.statusCode && error.statusCode < 500
                ? 400
                : 500
        const category = status === 429 ? 'rate-limited' : status < 500 ? 'invalid-batch' : 'internal-error'
        reply.header('cache-control', 'no-store').code(status).send({ error: category })
      },
    },
    (request, reply) => {
      if (!isBrowserDiagnosticsBatch(request.body)) return reply.code(400).send({ error: 'invalid-batch' })
      const now = Date.now()
      for (const [id, value] of sources) if (value.expiresAt <= now) sources.delete(id)
      let source = sources.get(request.body.sourceId)
      if (!source) {
        if (sources.size >= MAX_TRACKED_SOURCES) return reply.code(429).send({ error: 'rate-limited' })
        source = { expiresAt: now + WINDOW_MS, count: 0 }
        sources.set(request.body.sourceId, source)
      }
      if (source.count >= BROWSER_DIAGNOSTICS_SOURCE_REQUESTS_PER_MINUTE) {
        return reply.code(429).send({ error: 'rate-limited' })
      }
      source.count++
      try {
        const result = options.ingest(request.body)
        if (!result) return reply.code(503).send({ error: 'storage-unavailable' })
        if (
          !isBrowserDiagnosticsUploadResponse(result) ||
          result.accepted + result.duplicates + result.dropped !== request.body.events.length
        ) {
          return reply.code(500).send({ error: 'internal-error' })
        }
        return result
      } catch {
        return reply.code(503).send({ error: 'storage-unavailable' })
      }
    },
  )
}
