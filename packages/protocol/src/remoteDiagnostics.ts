import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { DiagnosticEntrySchema, projectDiagnosticEntry } from './diagnostics.js'

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

export const RemoteDiagnosticsResponseSchema = Type.Object(
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
export type RemoteDiagnosticsResponse = Static<typeof RemoteDiagnosticsResponseSchema>
export function isRemoteDiagnosticsResponse(value: unknown): value is RemoteDiagnosticsResponse {
  try {
    return Value.Check(RemoteDiagnosticsResponseSchema, value)
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
  version: 1
  from: number
  to: number
  limit: number
  requestUid?: string
  operationRef?: string
  category?: (typeof REMOTE_DIAGNOSTICS_CATEGORIES)[number]
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
    if (values.version !== undefined && values.version !== '1') return null
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
      !REMOTE_DIAGNOSTICS_CATEGORIES.some((category) => category === values.category)
    )
      return null
    if (
      values.cursor !== undefined &&
      (!/^[a-f0-9]{32}$/.test(String(values.cursor)) || keys.some((key) => key !== 'cursor' && key !== 'version'))
    )
      return null
    return {
      version: 1,
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
