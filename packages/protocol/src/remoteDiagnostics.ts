import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { DiagnosticEntrySchema, projectDiagnosticEntry } from './diagnostics.js'
export * from './browserDiagnostics.js'
import {
  DIAGNOSTIC_EVENT_CATEGORIES,
  DiagnosticJournalRecordSchema,
  projectDiagnosticJournalRecord,
  type DiagnosticJournalRecord,
  projectDiagnosticEventV2,
} from './diagnosticEvents.js'
export * from './diagnosticEvents.js'

export const SUPPORT_DIAGNOSTICS_ENDPOINT = '/api/v1/support/diagnostics'
export const BROWSER_DIAGNOSTICS_ENDPOINT = '/api/v1/diagnostics/browser'
export const REMOTE_DIAGNOSTICS_MAX_BYTES = 512 * 1024
export const REMOTE_DIAGNOSTICS_MAX_WINDOW_MS = 86_400_000
export const REMOTE_DIAGNOSTICS_CATEGORIES = [
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
] as const
const enumOf = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)))
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const timestamp = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 })
const nullableTime = Type.Union([timestamp, Type.Null()])
export const DiagnosticReferenceSchema = Type.String({ pattern: '^[a-f0-9]{32}$' })
export const RemoteDiagnosticRecordSchema = Type.Object(
  {
    sequence: count,
    receivedAt: timestamp,
    instanceId: DiagnosticReferenceSchema,
    entry: Type.Omit(DiagnosticEntrySchema, ['locations'], { additionalProperties: false }),
  },
  { additionalProperties: false },
)
export type RemoteDiagnosticRecord = Static<typeof RemoteDiagnosticRecordSchema>

export const RemoteDiagnosticsResponseV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    serverTime: timestamp,
    identity: Type.Object(
      {
        build: Type.String({ pattern: '^(?:[a-f0-9]{40,64}|unknown)$' }),
        instanceId: DiagnosticReferenceSchema,
      },
      { additionalProperties: false },
    ),
    entries: Type.Array(RemoteDiagnosticRecordSchema, { maxItems: 200 }),
    sources: Type.Object(
      {
        server: enumOf(['volatile', 'journal', 'unavailable', 'disabled']),
        browser: enumOf(['not-supported', 'none', 'available']),
      },
      { additionalProperties: false },
    ),
    capture: Type.Object({ from: nullableTime, to: nullableTime }, { additionalProperties: false }),
    loss: Type.Object(
      { dropped: count, rejected: count, pruned: count, truncated: Type.Boolean() },
      { additionalProperties: false },
    ),
    pagination: Type.Object(
      {
        nextCursor: Type.Union([DiagnosticReferenceSchema, Type.Null()]),
        snapshotSequence: count,
        lastSequence: count,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export const RemoteDiagnosticsResponseV2Schema = Type.Object(
  {
    ...RemoteDiagnosticsResponseV1Schema.properties,
    version: Type.Literal(2),
    entries: Type.Array(DiagnosticJournalRecordSchema, { maxItems: 200 }),
    clock: Type.Object(
      {
        ordering: Type.Literal('server-sequence'),
        browserTime: Type.Literal('client-asserted'),
        skew: Type.Literal('unknown'),
      },
      { additionalProperties: false },
    ),
    collection: Type.Object(
      {
        pending: Type.Integer({ minimum: 0, maximum: 256 }),
        operationContinuity: enumOf(['retained', 'process-only']),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export const RemoteDiagnosticsResponseSchema = Type.Union([
  RemoteDiagnosticsResponseV1Schema,
  RemoteDiagnosticsResponseV2Schema,
])
export type RemoteDiagnosticsResponseV1 = Static<typeof RemoteDiagnosticsResponseV1Schema>
export type RemoteDiagnosticsResponseV2 = Static<typeof RemoteDiagnosticsResponseV2Schema>
export type RemoteDiagnosticsResponse = Static<typeof RemoteDiagnosticsResponseSchema>
export function isRemoteDiagnosticsResponse(value: unknown): value is RemoteDiagnosticsResponse {
  try {
    if (!Value.Check(RemoteDiagnosticsResponseSchema, value)) return false
    if (value.version === 2 && value.entries.some((entry) => !projectDiagnosticJournalRecord(entry))) return false
    return true
  } catch {
    return false
  }
}

export const REMOTE_DIAGNOSTICS_ERRORS = [
  'disabled',
  'unauthorized',
  'invalid-query',
  'rate-limited',
  'collection-disabled',
  'cursor-expired',
  'storage-unavailable',
  'internal-error',
] as const
export type RemoteDiagnosticsError = (typeof REMOTE_DIAGNOSTICS_ERRORS)[number]
export const RemoteDiagnosticsErrorSchema = Type.Object(
  { error: enumOf(REMOTE_DIAGNOSTICS_ERRORS) },
  { additionalProperties: false },
)

export interface RemoteDiagnosticsQuery {
  version: 1 | 2
  from: number
  to: number
  limit: number
  requestUid?: string
  operationRef?: string
  category?: (typeof REMOTE_DIAGNOSTICS_CATEGORIES)[number] | (typeof DIAGNOSTIC_EVENT_CATEGORIES)[number]
  cursor?: string
}

/** Finite grammar shared by the route and operator helper; never echoes input. */
export function parseRemoteDiagnosticsQuery(input: unknown, now = Date.now()): RemoteDiagnosticsQuery | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const values = input as Record<string, unknown>
    const keys = Object.keys(values)
    if (
      keys.some(
        (key) => !['version', 'from', 'to', 'limit', 'requestUid', 'operationRef', 'category', 'cursor'].includes(key),
      )
    )
      return null
    if (Object.values(values).some((value) => typeof value !== 'string' || value.length > 64)) return null
    if (values.version !== undefined && values.version !== '1' && values.version !== '2') return null
    const version = values.version === '2' ? 2 : 1
    const integer = (value: unknown, fallback: number) =>
      value === undefined
        ? fallback
        : typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value))
          ? Number(value)
          : NaN
    const to = integer(values.to, now)
    const from = integer(values.from, Math.max(0, to - 3_600_000))
    const limit = integer(values.limit, 50)
    if (
      !Number.isFinite(to) ||
      !Number.isFinite(from) ||
      from > to ||
      to > 8_640_000_000_000_000 ||
      to - from > REMOTE_DIAGNOSTICS_MAX_WINDOW_MS
    )
      return null
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) return null
    if (values.requestUid !== undefined && !/^[a-f0-9]{64}$/.test(String(values.requestUid))) return null
    if (values.operationRef !== undefined && !/^[a-f0-9]{32}$/.test(String(values.operationRef))) return null
    if (
      values.category !== undefined &&
      !(version === 2 ? DIAGNOSTIC_EVENT_CATEGORIES : REMOTE_DIAGNOSTICS_CATEGORIES).some(
        (category) => category === values.category,
      )
    )
      return null
    if (
      values.cursor !== undefined &&
      (!/^[a-f0-9]{32}$/.test(String(values.cursor)) || keys.some((key) => key !== 'cursor' && key !== 'version'))
    )
      return null
    return {
      version,
      from,
      to,
      limit,
      ...(values.requestUid ? { requestUid: String(values.requestUid) } : {}),
      ...(values.operationRef ? { operationRef: String(values.operationRef) } : {}),
      ...(values.category ? { category: values.category as RemoteDiagnosticsQuery['category'] } : {}),
      ...(values.cursor ? { cursor: String(values.cursor) } : {}),
    }
  } catch {
    return null
  }
}

/** V1 remains exact. Remote output omits unverified dynamic stack coordinates. */
export function projectRemoteDiagnosticRecord(value: unknown): RemoteDiagnosticRecord | null {
  try {
    if (!value || typeof value !== 'object') return null
    const input = value as Record<string, unknown>
    const entry = projectDiagnosticEntry(input.entry)
    if (!entry) return null
    delete entry.locations
    const record = { sequence: input.sequence, receivedAt: input.receivedAt, instanceId: input.instanceId, entry }
    return Value.Check(RemoteDiagnosticRecordSchema, record) ? record : null
  } catch {
    return null
  }
}

/** Existing capture facts enter v2 through an explicit closed representation. */
export function promoteRemoteDiagnosticRecord(record: RemoteDiagnosticRecord): DiagnosticJournalRecord | null {
  const base = {
    timestamp: record.entry.timestamp,
    source: 'server',
    level: record.entry.level,
    correlation: record.entry.requestUid ? 'request' : 'background',
    requestUid: record.entry.requestUid,
  }
  const entry =
    record.entry.event === 'http'
      ? projectDiagnosticEventV2({
          ...base,
          category: 'http',
          routeId: record.entry.routeId ?? 'unknown',
          method: record.entry.method ?? 'GET',
          statusCode: record.entry.statusCode ?? 0,
          durationMs: Math.min(86_400_000, record.entry.durationMs ?? 0),
          requestBytes: 'unknown',
          responseBytes: 'unknown',
          outcome:
            (record.entry.statusCode ?? 0) >= 500
              ? 'server-error'
              : (record.entry.statusCode ?? 0) >= 400
                ? 'client-error'
                : 'ok',
        })
      : ['runtime-error', 'unhandled-rejection', 'console'].includes(record.entry.event)
        ? projectDiagnosticEventV2({
            ...base,
            category: 'runtime',
            kind: record.entry.event,
            errorName: record.entry.errorName,
          })
        : projectDiagnosticEventV2({ ...base, category: 'legacy', detail: record.entry })
  return entry ? projectDiagnosticJournalRecord({ ...record, entry, provenance: { kind: 'server' } }) : null
}

/** V1 gets only facts it already understands; richer events never masquerade as v1. */
export function downgradeDiagnosticJournalRecord(record: DiagnosticJournalRecord): RemoteDiagnosticRecord | null {
  if (record.entry.source !== 'server') return null
  const event = record.entry
  const base = { timestamp: event.timestamp, source: 'server', level: event.level, requestUid: event.requestUid }
  let entry: unknown
  if (event.category === 'legacy') entry = event.detail
  else if (event.category === 'http')
    entry = {
      ...base,
      event: 'http',
      routeId: event.routeId,
      method: event.method,
      statusCode: event.statusCode,
      durationMs: event.durationMs,
    }
  else if (event.category === 'runtime') entry = { ...base, event: event.kind, errorName: event.errorName }
  else if (event.category === 'deployment' && event.stage === 'started') entry = { ...base, event: 'server-started' }
  else if (event.category === 'prompt')
    entry = {
      ...base,
      event: 'protocol',
      metric: 'generation_prompt_assembly',
      durationMs: event.durationMs,
      outcome: event.outcome === 'error' ? 'error' : event.outcome === 'stopped' ? 'cancelled' : 'ok',
    }
  else if (event.category === 'persistence')
    entry = {
      ...base,
      event: 'protocol',
      metric: event.disposition === 'recovered' ? 'generation_persistence_retry' : 'generation_persistence',
      durationMs: event.durationMs,
      outcome: event.authoritativeCommitted ? 'committed' : event.disposition === 'failed' ? 'error' : 'pending',
    }
  else if (event.category === 'script')
    entry = {
      ...base,
      event: 'protocol',
      metric: 'generation_lua_runtime',
      durationMs: event.durationMs,
      outcome: event.failures ? 'error' : 'ok',
    }
  else return null
  return projectRemoteDiagnosticRecord({
    sequence: record.sequence,
    receivedAt: record.receivedAt,
    instanceId: record.instanceId,
    entry,
  })
}

/** Includes rejected methods and subpaths, before parser/auth/trace hooks. */
export function isDiagnosticTransportUrl(url: string): boolean {
  try {
    const pathname = decodeURIComponent(url.split('?')[0])
    return (
      pathname === '/api/v1/diagnostics' ||
      pathname.startsWith('/api/v1/diagnostics/') ||
      pathname === '/api/v1/support' ||
      pathname.startsWith('/api/v1/support/')
    )
  } catch {
    return url.startsWith('/api/v1/diagnostics') || url.startsWith('/api/v1/support')
  }
}
