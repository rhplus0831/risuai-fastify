import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { DiagnosticEntrySchema, projectDiagnosticEntry, errorNames } from './diagnostics.js'
export * from './browserDiagnostics.js'
import { GENERATION_REJECTION_CODES, type GenerationRejectionCode } from './generationRejectionCodes.js'
export * from './generationRejectionCodes.js'
import {
  DIAGNOSTIC_EVENT_CATEGORIES,
  DIAGNOSTIC_SIZE_BUCKETS,
  DIAGNOSTIC_PROVIDER_ADAPTERS,
  DIAGNOSTIC_GENERATION_INPUT_DOMAINS,
  DIAGNOSTIC_GENERATION_INPUT_OWNERS,
  DIAGNOSTIC_VALIDATION_RULES,
  DIAGNOSTIC_VALUE_KINDS,
  DiagnosticJournalRecordSchema,
  projectDiagnosticJournalRecord,
  type DiagnosticJournalRecord,
  projectDiagnosticEventV2,
} from './diagnosticEvents.js'
export * from './diagnosticEvents.js'

export const SUPPORT_DIAGNOSTICS_ENDPOINT = '/api/v1/support/diagnostics'
export const SUPPORT_DIAGNOSTICS_STATE_ENDPOINT = '/api/v1/support/diagnostics/state'
export const DIAGNOSTIC_REFERENCE_KINDS = ['operation', 'attempt', 'chat', 'character', 'preset', 'profile'] as const
export type DiagnosticReferenceKind = (typeof DIAGNOSTIC_REFERENCE_KINDS)[number]
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
export const REMOTE_DIAGNOSTIC_FACT_LIMIT = 32
const remoteDiagnosticFactId = Type.String({
  minLength: 3,
  maxLength: 96,
  pattern: '^[a-z][a-z0-9-]{0,31}(?:\\.[a-z0-9][a-z0-9-]{0,31}){1,3}$',
})
const remoteDiagnosticFact = <K extends string, T extends TSchema>(type: K, value: T) =>
  Type.Object(
    {
      id: remoteDiagnosticFactId,
      type: Type.Literal(type),
      value,
    },
    { additionalProperties: false },
  )
const diagnosticSourceLocation = Type.String({
  maxLength: 200,
  pattern:
    '^(?!.*\\.\\.)(?:(?:server/fastify/src|src)/[a-zA-Z0-9_./-]+\\.(?:ts|js|svelte)|assets/[a-zA-Z0-9_.-]+\\.js):[0-9]+:[0-9]+$',
})
export const RemoteDiagnosticFactV3Schema = Type.Union([
  remoteDiagnosticFact('boolean', Type.Boolean()),
  remoteDiagnosticFact('count', Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
  remoteDiagnosticFact('duration-ms', Type.Number({ minimum: 0, maximum: 86_400_000 })),
  remoteDiagnosticFact('size-bucket', enumOf(DIAGNOSTIC_SIZE_BUCKETS)),
  remoteDiagnosticFact('reference', DiagnosticReferenceSchema),
  remoteDiagnosticFact('location', diagnosticSourceLocation),
])
export const RemoteDiagnosticFactSchema = Type.Union([
  ...RemoteDiagnosticFactV3Schema.anyOf,
  remoteDiagnosticFact('rejection-code', enumOf(GENERATION_REJECTION_CODES)),
  remoteDiagnosticFact('error-name', enumOf(errorNames)),
  remoteDiagnosticFact('validation-domain', enumOf(DIAGNOSTIC_GENERATION_INPUT_DOMAINS)),
  remoteDiagnosticFact('validation-owner', enumOf(DIAGNOSTIC_GENERATION_INPUT_OWNERS)),
  remoteDiagnosticFact('validation-rule', enumOf(DIAGNOSTIC_VALIDATION_RULES)),
  remoteDiagnosticFact('value-kind', enumOf(DIAGNOSTIC_VALUE_KINDS)),
  remoteDiagnosticFact('field', Type.String({ minLength: 16, maxLength: 16, pattern: '^[a-f0-9]{16}$' })),
  remoteDiagnosticFact('provider-adapter', enumOf(DIAGNOSTIC_PROVIDER_ADAPTERS)),
  remoteDiagnosticFact('http-status', Type.Integer({ minimum: 100, maximum: 599 })),
])
export type RemoteDiagnosticFact = Static<typeof RemoteDiagnosticFactSchema>
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

export const RemoteDiagnosticRecordV3Schema = Type.Object(
  {
    ...DiagnosticJournalRecordSchema.properties,
    facts: Type.Optional(Type.Array(RemoteDiagnosticFactV3Schema, { maxItems: REMOTE_DIAGNOSTIC_FACT_LIMIT })),
  },
  { additionalProperties: false },
)
export type RemoteDiagnosticRecordV3 = Static<typeof RemoteDiagnosticRecordV3Schema>

export const RemoteDiagnosticRecordV4Schema = Type.Object(
  {
    ...DiagnosticJournalRecordSchema.properties,
    facts: Type.Optional(Type.Array(RemoteDiagnosticFactSchema, { maxItems: REMOTE_DIAGNOSTIC_FACT_LIMIT })),
  },
  { additionalProperties: false },
)
export type RemoteDiagnosticRecordV4 = Static<typeof RemoteDiagnosticRecordV4Schema>

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
export const RemoteDiagnosticsResponseV3Schema = Type.Object(
  {
    ...RemoteDiagnosticsResponseV2Schema.properties,
    version: Type.Literal(3),
    entries: Type.Array(RemoteDiagnosticRecordV3Schema, { maxItems: 200 }),
  },
  { additionalProperties: false },
)
export const RemoteDiagnosticsResponseV4Schema = Type.Object(
  {
    ...RemoteDiagnosticsResponseV3Schema.properties,
    version: Type.Literal(4),
    entries: Type.Array(RemoteDiagnosticRecordV4Schema, { maxItems: 200 }),
  },
  { additionalProperties: false },
)
export const RemoteDiagnosticsResponseSchema = Type.Union([
  RemoteDiagnosticsResponseV1Schema,
  RemoteDiagnosticsResponseV2Schema,
  RemoteDiagnosticsResponseV3Schema,
  RemoteDiagnosticsResponseV4Schema,
])
export type RemoteDiagnosticsResponseV1 = Static<typeof RemoteDiagnosticsResponseV1Schema>
export type RemoteDiagnosticsResponseV2 = Static<typeof RemoteDiagnosticsResponseV2Schema>
export type RemoteDiagnosticsResponseV3 = Static<typeof RemoteDiagnosticsResponseV3Schema>
export type RemoteDiagnosticsResponseV4 = Static<typeof RemoteDiagnosticsResponseV4Schema>
export type RemoteDiagnosticsResponse = Static<typeof RemoteDiagnosticsResponseSchema>
export function isRemoteDiagnosticsResponse(value: unknown): value is RemoteDiagnosticsResponse {
  try {
    if (!Value.Check(RemoteDiagnosticsResponseSchema, value)) return false
    if (value.version === 2 && value.entries.some((entry) => !projectDiagnosticJournalRecord(entry))) return false
    if (value.version === 3 && value.entries.some((entry) => !projectRemoteDiagnosticRecordV3(entry))) return false
    if (value.version === 4 && value.entries.some((entry) => !projectRemoteDiagnosticRecordV4(entry))) return false
    return true
  } catch {
    return false
  }
}

// State is independent of the exact v1/v2/v3/v4 journal envelopes.
const exact = { additionalProperties: false } as const
const statusCounts = <T extends string>(statuses: readonly T[]) => Type.Record(enumOf(statuses), count, exact)
const streamState = Type.Object(
  {
    total: count,
    active: count,
    clients: count,
    pendingBytes: count,
    replayMemoryBytes: count,
  },
  exact,
)
const workerState = Type.Object({ enabled: Type.Boolean(), running: Type.Boolean(), processing: Type.Boolean() }, exact)
export const SUPPORT_DIAGNOSTICS_STATE_MAX_ITEMS = 200
export const SupportDiagnosticsStateResponseSchema = Type.Object(
  {
    version: Type.Literal(1),
    serverTime: timestamp,
    identity: RemoteDiagnosticsResponseV1Schema.properties.identity,
    deployment: Type.Object(
      {
        buildSource: enumOf(['env', 'git', 'unknown']),
        locationsTrusted: Type.Boolean(),
        dirty: Type.Optional(Type.Boolean()),
        commitTime: Type.Optional(timestamp),
        startedAt: timestamp,
      },
      exact,
    ),
    process: Type.Object(
      {
        uptimeSeconds: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        node: Type.Object({ major: count, minor: count, patch: count }, exact),
        memory: Type.Object(
          { rss: count, heapTotal: count, heapUsed: count, external: count, arrayBuffers: count },
          exact,
        ),
      },
      exact,
    ),
    config: Type.Object(
      {
        diagnostics: Type.Boolean(),
        supportDiagnostics: Type.Boolean(),
        browserDiagnostics: Type.Boolean(),
        rawTrace: Type.Boolean(),
        fullPrompt: Type.Boolean(),
        rawMetrics: Type.Boolean(),
        chatOccupancy: Type.Boolean(),
        staticServing: Type.Boolean(),
        agentDevAuthBypass: Type.Boolean(),
        hub: enumOf(['default', 'custom']),
        realm: enumOf(['default', 'custom']),
        trustProxy: enumOf(['disabled', 'enabled', 'hops', 'custom']),
        bodyLimit: count,
        importUnlimited: Type.Boolean(),
        importMaxBytes: Type.Optional(count),
        automaticBackupRetention: count,
        realmImportMaxExpandedBytes: count,
      },
      exact,
    ),
    database: Type.Object(
      {
        schemaVersion: count,
        revision: count,
        pageCount: count,
        freelistCount: count,
        pageSize: count,
        files: Type.Object({ database: count, wal: count, shm: count }, exact),
      },
      exact,
    ),
    journal: Type.Object(
      {
        source: enumOf(['volatile', 'journal', 'unavailable']),
        available: Type.Boolean(),
        epoch: DiagnosticReferenceSchema,
        retained: count,
        pending: count,
        dropped: count,
        rejected: count,
        pruned: count,
        operationContinuity: enumOf(['retained', 'process-only']),
        limits: Type.Object(
          {
            maxAgeMs: count,
            maxEvents: count,
            maxBytes: count,
            maxQueue: count,
            maxRecordBytes: count,
            maxFileBytes: count,
          },
          exact,
        ),
      },
      exact,
    ),
    generation: Type.Object(
      {
        activeTotal: count,
        activeTruncated: Type.Boolean(),
        active: Type.Array(
          Type.Object(
            {
              chat: DiagnosticReferenceSchema,
              operation: Type.Optional(DiagnosticReferenceSchema),
              attempt: DiagnosticReferenceSchema,
              mode: Type.Optional(enumOf(['send', 'continue', 'regenerate'])),
              writerEpoch: Type.Optional(count),
              operationStateVersion: Type.Optional(count),
              projectionEpoch: Type.Optional(count),
              attemptNo: Type.Optional(count),
            },
            exact,
          ),
          { maxItems: SUPPORT_DIAGNOSTICS_STATE_MAX_ITEMS },
        ),
        jobs: streamState,
        streams: streamState,
        liveOperations: statusCounts(['accepted', 'launching', 'owned_by_job', 'stopping']),
        effects: statusCounts(['pending', 'claimed', 'completed', 'skipped', 'failed']),
        effectClaims: Type.Optional(
          Type.Object(
            {
              durableLive: count,
              durableExpired: count,
              nonDurable: count,
              byKind: statusCounts([
                'igp',
                'plugin_output',
                'generated_translation',
                'notification',
                'tts',
                'completion_sound',
                'emotion_image_state',
              ]),
            },
            exact,
          ),
        ),
        finalizationRetries: statusCounts(['pending', 'terminal']),
      },
      exact,
    ),
    occupancy: Type.Object(
      {
        counts: statusCounts(['occupied', 'expired', 'released']),
        truncated: Type.Boolean(),
        leases: Type.Array(
          Type.Object(
            {
              chat: DiagnosticReferenceSchema,
              state: enumOf(['occupied', 'expired']),
              claimClass: Type.Optional(enumOf(['owner', 'chat_only'])),
              epoch: count,
              claimedAt: Type.Optional(timestamp),
              expiresAt: Type.Optional(timestamp),
              updatedAt: timestamp,
            },
            exact,
          ),
          { maxItems: SUPPORT_DIAGNOSTICS_STATE_MAX_ITEMS },
        ),
      },
      exact,
    ),
    writer: Type.Object(
      {
        present: Type.Boolean(),
        epoch: count,
        runtimePresent: Type.Boolean(),
        runtimeEpoch: count,
        connectedSessions: count,
      },
      exact,
    ),
    workers: Type.Object(
      {
        memory: workerState,
        bardWiki: workerState,
        memoryJobs: statusCounts(['pending', 'running', 'completed', 'failed', 'cancelled']),
        bardWikiJobs: statusCounts(['pending', 'running', 'completed', 'failed', 'cancelled']),
        maintenance: Type.Object(
          {
            closing: Type.Boolean(),
            closed: Type.Boolean(),
            reclamationBlocked: Type.Boolean(),
            activityVersion: count,
            protectionVersion: count,
          },
          exact,
        ),
      },
      exact,
    ),
    rejections: Type.Object(
      {
        sinceStartedAt: timestamp,
        byCode: Type.Unsafe<Partial<Record<GenerationRejectionCode, number>>>(
          Type.Partial(statusCounts(GENERATION_REJECTION_CODES), exact),
        ),
      },
      exact,
    ),
  },
  exact,
)
export type SupportDiagnosticsStateResponse = Static<typeof SupportDiagnosticsStateResponseSchema>
export function isSupportDiagnosticsStateResponse(value: unknown): value is SupportDiagnosticsStateResponse {
  try {
    return Value.Check(SupportDiagnosticsStateResponseSchema, value)
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
  version: 1 | 2 | 3 | 4
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
    if (
      values.version !== undefined &&
      values.version !== '1' &&
      values.version !== '2' &&
      values.version !== '3' &&
      values.version !== '4'
    )
      return null
    const version = values.version === '4' ? 4 : values.version === '3' ? 3 : values.version === '2' ? 2 : 1
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
      !(version >= 2 ? DIAGNOSTIC_EVENT_CATEGORIES : REMOTE_DIAGNOSTICS_CATEGORIES).some(
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

export function isRemoteDiagnosticFactV3(value: unknown): value is Static<typeof RemoteDiagnosticFactV3Schema> {
  try {
    return Value.Check(RemoteDiagnosticFactV3Schema, value)
  } catch {
    return false
  }
}

/** Enrichment facts are exact, bounded values rather than rendered text. */
export function projectRemoteDiagnosticFact(value: unknown): RemoteDiagnosticFact | null {
  try {
    return Value.Check(RemoteDiagnosticFactSchema, value) ? structuredClone(value) : null
  } catch {
    return null
  }
}

/** Drop invalid/duplicate facts independently; enrichment cannot suppress the event. */
export function projectRemoteDiagnosticFacts(values: readonly RemoteDiagnosticFact[]): RemoteDiagnosticFact[] {
  const facts: RemoteDiagnosticFact[] = []
  const ids = new Set<string>()
  for (const value of values) {
    const fact = projectRemoteDiagnosticFact(value)
    if (!fact || ids.has(fact.id)) continue
    ids.add(fact.id)
    facts.push(fact)
  }
  while (facts.length > REMOTE_DIAGNOSTIC_FACT_LIMIT) dropRemoteDiagnosticFact(facts)
  return facts
}

/** Stable overflow policy: last location first, then the last remaining fact. */
export function dropRemoteDiagnosticFact(facts: RemoteDiagnosticFact[]): void {
  let index = facts.length - 1
  while (index >= 0 && facts[index].type !== 'location') index--
  facts.splice(index < 0 ? facts.length - 1 : index, 1)
}

/** V3 stays frozen: newer fact types must be removed before this exact check. */
export function projectRemoteDiagnosticRecordV3(value: unknown): RemoteDiagnosticRecordV3 | null {
  try {
    return Value.Check(RemoteDiagnosticRecordV3Schema, value)
      ? (projectRemoteDiagnosticRecordV4(value) as RemoteDiagnosticRecordV3 | null)
      : null
  } catch {
    return null
  }
}

/** Restoration and complete-response checks reject malformed or ambiguous facts. */
export function projectRemoteDiagnosticRecordV4(value: unknown): RemoteDiagnosticRecordV4 | null {
  try {
    if (!Value.Check(RemoteDiagnosticRecordV4Schema, value)) return null
    const record = projectDiagnosticJournalRecord({
      sequence: value.sequence,
      receivedAt: value.receivedAt,
      instanceId: value.instanceId,
      provenance: value.provenance,
      entry: value.entry,
    })
    if (!record) return null
    if (value.facts === undefined) return record
    const ids = new Set<string>()
    const facts: RemoteDiagnosticFact[] = []
    for (const valueFact of value.facts) {
      const fact = projectRemoteDiagnosticFact(valueFact)
      if (!fact || ids.has(fact.id)) return null
      ids.add(fact.id)
      facts.push(fact)
    }
    return { ...record, facts }
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
    // The namespace is ASCII. Decode valid bytes independently so an invalid
    // escape later in the path cannot bypass guards for encoded prefixes.
    const pathname = url
      .split('?')[0]
      .replace(/%([a-f0-9]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    return pathname.startsWith('/api/v1/diagnostics') || pathname.startsWith('/api/v1/support')
  }
}
