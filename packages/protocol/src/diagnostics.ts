import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { PROTOCOL_ROUTE_OPERATION_CATALOG } from './routeOperation.js'
import { STARTUP_TELEMETRY_FAILURE_CODES, STARTUP_TELEMETRY_MILESTONES } from './startupTelemetry.js'

export const DIAGNOSTICS_VERSION = 1 as const
export const DIAGNOSTICS_LIMIT = 300
export const DIAGNOSTICS_ENDPOINT = '/api/v1/diagnostics'
export const DIAGNOSTIC_METRICS = [
  'command_mutation',
  'bootstrap_projection',
  'generation_prompt_assembly',
  'generation_prompt_emission',
  'generation_persistence',
  'generation_persistence_retry',
  'generation_cancel_persistence',
  'generation_lua_runtime',
  'generation_lua_post_generation_trace',
  'generation_compatibility_stream_attach',
  'browser_startup',
] as const

const enumSchema = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)))
const boundedNumber = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const errorNames = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'SecurityError',
  'QuotaExceededError',
  'GenerationInputValidationError',
  'UnknownError',
] as const

// This is an allowlist, not a redacted copy of arbitrary logs. Free-form messages,
// bodies, headers, URLs, domain IDs, settings and plugin/Lua values have no field.
export const DiagnosticEntrySchema = Type.Object(
  {
    timestamp: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 }),
    source: enumSchema(['browser', 'server']),
    level: enumSchema(['info', 'warn', 'error']),
    event: enumSchema([
      'http',
      'network-failure',
      'runtime-error',
      'unhandled-rejection',
      'console',
      'online',
      'offline',
      'startup',
      'protocol',
      'generation-recovery',
      'server-started',
    ]),
    routeId: Type.Optional(
      enumSchema([...PROTOCOL_ROUTE_OPERATION_CATALOG.map((route) => route.id), 'unknown', 'external', 'resource']),
    ),
    method: Type.Optional(enumSchema(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'])),
    requestUid: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    statusCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 599 })),
    durationMs: Type.Optional(boundedNumber),
    payloadBytes: Type.Optional(boundedNumber),
    attemptCount: Type.Optional(boundedNumber),
    metric: Type.Optional(enumSchema(DIAGNOSTIC_METRICS)),
    phase: Type.Optional(enumSchema(STARTUP_TELEMETRY_MILESTONES)),
    code: Type.Optional(
      enumSchema([
        ...STARTUP_TELEMETRY_FAILURE_CODES,
        'phase-ready',
        'attempt-completed',
        'attempt-failed',
        'diagnostic-failure',
        'stale_attempt_redirect',
        'terminal_reconciliation',
        'compatibility_job_expiry',
        'observer_exhaustion',
        'foreground_retry_reset',
        'superseded_bootstrap',
        'authority_timeout',
      ]),
    ),
    outcome: Type.Optional(
      enumSchema([
        'ok',
        'error',
        'success',
        'failed',
        'cancelled',
        'queued',
        'committed',
        'rejected',
        'unconfirmed',
        'pending',
        'retryable',
        'terminal',
        'completed',
        'abandoned',
      ]),
    ),
    errorName: Type.Optional(enumSchema(errorNames)),
    locations: Type.Optional(
      Type.Array(
        Type.String({
          maxLength: 200,
          pattern:
            '^(?:(?:server/fastify/src|src)/[a-zA-Z0-9_./-]+\\.(?:ts|js|svelte)|assets/[a-zA-Z0-9_.-]+\\.js):[0-9]+:[0-9]+$',
        }),
        { maxItems: 6 },
      ),
    ),
  },
  { additionalProperties: false },
)

export type DiagnosticEntry = Static<typeof DiagnosticEntrySchema>
export const DiagnosticsConfigurationSchema = Type.Object(
  { version: Type.Literal(DIAGNOSTICS_VERSION) },
  { additionalProperties: false },
)
export type DiagnosticsConfiguration = Static<typeof DiagnosticsConfigurationSchema>
export const DiagnosticsResponseSchema = Type.Object(
  {
    version: Type.Literal(DIAGNOSTICS_VERSION),
    enabled: Type.Boolean(),
    entries: Type.Array(DiagnosticEntrySchema, { maxItems: DIAGNOSTICS_LIMIT }),
  },
  { additionalProperties: false },
)
export type DiagnosticsResponse = Static<typeof DiagnosticsResponseSchema>

export function isDiagnosticsConfiguration(value: unknown): value is DiagnosticsConfiguration {
  return Value.Check(DiagnosticsConfigurationSchema, value)
}

export function isDiagnosticsResponse(value: unknown): value is DiagnosticsResponse {
  return Value.Check(DiagnosticsResponseSchema, value)
}

/** Re-project at every boundary, including session restoration and text export. */
export function projectDiagnosticEntry(value: unknown): DiagnosticEntry | null {
  try {
    if (!value || typeof value !== 'object') return null
    const input = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, schema] of Object.entries(DiagnosticEntrySchema.properties)) {
      const field = input[key]
      if (field !== undefined && Value.Check(schema, field)) {
        result[key] = Array.isArray(field) ? [...field] : field
      }
    }
    return Value.Check(DiagnosticEntrySchema, result) ? result : null
  } catch {
    return null
  }
}

/** Only application code coordinates survive; the complete error message is removed first. */
export function diagnosticErrorFields(error: unknown): Pick<DiagnosticEntry, 'errorName' | 'locations'> {
  try {
    if (!(error instanceof Error)) return { errorName: 'UnknownError' }
    const errorName = errorNames.find((name) => name === error.name) ?? 'Error'
    const heading = error.message ? `${error.name}: ${error.message}` : error.name
    const stack = error.stack ?? ''
    const frames = stack.startsWith(heading) ? stack.slice(heading.length) : ''
    const locations: string[] = []
    for (const frame of frames.split('\n').slice(0, 30)) {
      // Ignore function names, origins, absolute paths, query strings, and eval/plugin code.
      const match = frame.match(
        /(?:\/|^)((?:server\/fastify\/src|src)\/[a-zA-Z0-9_./-]+\.(?:ts|js|svelte)|assets\/[a-zA-Z0-9_.-]+\.js)(?:\?[^\s():]*)?:(\d+):(\d+)\)?\s*$/,
      )
      if (match && !match[1].includes('..')) locations.push(`${match[1]}:${match[2]}:${match[3]}`)
      if (locations.length === 6) break
    }
    return { errorName, ...(locations.length ? { locations } : {}) }
  } catch {
    return { errorName: 'UnknownError' }
  }
}
