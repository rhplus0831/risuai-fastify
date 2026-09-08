import { Type, type Static, type TObject } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { DiagnosticEntrySchema } from './diagnostics.js'
import { PROTOCOL_ROUTE_OPERATION_CATALOG } from './routeOperation.js'
import { STARTUP_TELEMETRY_FAILURE_CODES } from './startupTelemetry.js'

const enumOf = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)))
const timestamp = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 })
const count = Type.Integer({ minimum: 0, maximum: 1_000_000_000 })
const duration = Type.Number({ minimum: 0, maximum: 86_400_000 })
const reference = Type.String({ pattern: '^[a-f0-9]{32}$' })
export const DIAGNOSTIC_SIZE_BUCKETS = ['none', 'small', 'medium', 'large', 'huge', 'unknown'] as const
export const DIAGNOSTIC_PROVIDER_ADAPTERS = [
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'cohere',
  'ollama',
  'novelai',
  'openrouter',
  'unknown',
] as const
export const DIAGNOSTIC_CANCELLATION_ORIGINS = [
  'none',
  'user',
  'deadline',
  'disconnect',
  'server-shutdown',
  'unknown',
] as const
export const DIAGNOSTIC_DISPLAY_STAGES = [
  'revision',
  'namespace',
  'scope-load',
  'scope-decode',
  'scope-resolution',
  'shared-dependencies',
  'target-preparation',
  'postcondition',
  'unknown',
] as const
export const DIAGNOSTIC_DISPLAY_FAILURE_KINDS = [
  'generation-input-validation',
  'malformed-persistence',
  'storage',
  'runtime',
  'unknown',
] as const
export const DIAGNOSTIC_GENERATION_INPUT_DOMAINS = ['settings', 'database', 'preflight', 'provider', 'memory'] as const
export const DIAGNOSTIC_GENERATION_INPUT_OWNERS = [
  'settings',
  'character',
  'chat',
  'message',
  'memory',
  'lorebook',
  'module',
  'prompt-preset',
  'persona',
  'model-preset',
  'model-profile',
  'provider-credential',
  'agent-preset',
  'custom-model',
  'unknown',
] as const
export const DIAGNOSTIC_VALIDATION_RULES = [
  'type',
  'required',
  'const',
  'any-of',
  'not',
  'items',
  'min-items',
  'max-items',
  'other',
] as const
export const DIAGNOSTIC_VALUE_KINDS = [
  'undefined',
  'null',
  'array',
  'object',
  'string',
  'number',
  'boolean',
  'other',
] as const
const size = enumOf(DIAGNOSTIC_SIZE_BUCKETS)
const base = {
  timestamp,
  source: enumOf(['server', 'browser']),
  level: enumOf(['info', 'warn', 'error']),
  correlation: enumOf(['request', 'operation', 'background', 'unavailable', 'client-asserted']),
  requestUid: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  operationRef: Type.Optional(reference),
  attemptRef: Type.Optional(reference),
}
const object = <T extends Record<string, import('@sinclair/typebox').TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false })

const eventSchemas = {
  deployment: object({
    ...base,
    category: Type.Literal('deployment'),
    stage: enumOf(['started', 'collection-health', 'history-reset', 'stopped']),
    flags: object({
      diagnostics: Type.Boolean(),
      rawMetrics: Type.Boolean(),
      rawTrace: Type.Boolean(),
      fullPrompt: Type.Boolean(),
      browserUpload: Type.Boolean(),
    }),
    journal: enumOf(['starting', 'ready', 'unavailable', 'disabled']),
    queueDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 256 })),
    dropped: Type.Optional(count),
    rejected: Type.Optional(count),
  }),
  http: object({
    ...base,
    category: Type.Literal('http'),
    routeId: enumOf([...PROTOCOL_ROUTE_OPERATION_CATALOG.map((route) => route.id), 'unknown', 'external', 'resource']),
    method: enumOf(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']),
    statusCode: Type.Integer({ minimum: 0, maximum: 599 }),
    durationMs: duration,
    requestBytes: size,
    responseBytes: size,
    outcome: enumOf(['ok', 'client-error', 'server-error', 'aborted']),
  }),
  runtime: object({
    ...base,
    category: Type.Literal('runtime'),
    kind: enumOf(['console', 'runtime-error', 'unhandled-rejection']),
    errorName: Type.Optional(DiagnosticEntrySchema.properties.errorName),
  }),
  display: object({
    ...base,
    category: Type.Literal('display'),
    stage: enumOf(DIAGNOSTIC_DISPLAY_STAGES),
    outcome: enumOf(['failed', 'handled-fallback']),
    failureKind: enumOf(DIAGNOSTIC_DISPLAY_FAILURE_KINDS),
    validationDomain: Type.Optional(enumOf(DIAGNOSTIC_GENERATION_INPUT_DOMAINS)),
    validationOwner: Type.Optional(enumOf(DIAGNOSTIC_GENERATION_INPUT_OWNERS)),
    validationFieldRef: Type.Optional(Type.String({ pattern: '^[a-f0-9]{16}$' })),
    validationRule: Type.Optional(enumOf(DIAGNOSTIC_VALIDATION_RULES)),
    valueKind: Type.Optional(enumOf(DIAGNOSTIC_VALUE_KINDS)),
  }),
  generation: object({
    ...base,
    category: Type.Literal('generation'),
    stage: enumOf([
      'accepted',
      'assembly',
      'dispatch',
      'post-generation',
      'finalization',
      'complete',
      'cancellation',
      'recovery',
    ]),
    outcome: enumOf(['pending', 'completed', 'cancelled', 'failed', 'ambiguous', 'rejected']),
    providerMayHaveRun: Type.Boolean(),
    durationMs: Type.Optional(duration),
    cancellationOrigin: Type.Optional(enumOf(DIAGNOSTIC_CANCELLATION_ORIGINS)),
  }),
  prompt: object({
    ...base,
    category: Type.Literal('prompt'),
    outcome: enumOf(['ok', 'stopped', 'error']),
    durationMs: duration,
    rows: Type.Optional(count),
    roles: Type.Optional(object({ system: count, user: count, assistant: count, tool: count, other: count })),
    inputTokens: Type.Optional(count),
    budgetTokens: Type.Optional(count),
    truncatedTokens: Type.Optional(count),
    truncation: enumOf(['none', 'applied', 'unknown']),
    media: Type.Optional(object({ image: count, audio: count, video: count, other: count })),
    selectedMemoryCount: Type.Optional(count),
    loreEntryCount: Type.Optional(count),
  }),
  provider: object({
    ...base,
    category: Type.Literal('provider'),
    adapter: enumOf(DIAGNOSTIC_PROVIDER_ADAPTERS),
    transport: enumOf(['stream', 'json', 'unknown']),
    stage: enumOf(['dispatch', 'headers', 'terminal']),
    outcome: enumOf([
      'started',
      'ok',
      'http-error',
      'timeout',
      'disconnected',
      'cancelled',
      'invalid-response',
      'unknown-error',
    ]),
    durationMs: duration,
    providerMayHaveRun: Type.Boolean(),
    timeToHeadersMs: Type.Optional(duration),
    timeToFirstTokenMs: Type.Optional(duration),
    maxStreamGapMs: Type.Optional(duration),
    chunkCount: Type.Optional(count),
    responseBytes: Type.Optional(size),
    statusCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 599 })),
    retryOrdinal: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    cancellationOrigin: Type.Optional(enumOf(DIAGNOSTIC_CANCELLATION_ORIGINS)),
  }),
  persistence: object({
    ...base,
    category: Type.Literal('persistence'),
    phase: enumOf([
      'assembly',
      'journal',
      'authoritative_commit',
      'cleanup',
      'bookkeeping',
      'replay_fence',
      'complete',
      'unknown',
    ]),
    disposition: enumOf([
      'queued',
      'retryable',
      'terminal',
      'committed',
      'cleanup-pending',
      'recovered',
      'failed',
      'unknown',
    ]),
    durationMs: duration,
    journalConfirmed: Type.Optional(Type.Boolean()),
    authoritativeCommitted: Type.Optional(Type.Boolean()),
    cleanupComplete: Type.Optional(Type.Boolean()),
    retryCount: Type.Optional(count),
    queueDepth: Type.Optional(count),
    queueAgeMs: Type.Optional(duration),
    revisionGap: Type.Optional(count),
    contention: Type.Optional(Type.Boolean()),
  }),
  script: object({
    ...base,
    category: Type.Literal('script'),
    hook: enumOf(['editInput', 'editOutput', 'onInput', 'onOutput', 'trigger', 'plugin', 'unknown']),
    runtime: enumOf(['lua', 'regex', 'plugin', 'unknown']),
    runs: count,
    failures: count,
    durationMs: duration,
    allowedCalls: Type.Optional(count),
    blockedCalls: Type.Optional(count),
    outputChanged: Type.Optional(Type.Boolean()),
    transcriptChanged: Type.Optional(Type.Boolean()),
    comparison: Type.Optional(enumOf(['complete', 'unavailable'])),
  }),
  browser: object({
    ...base,
    category: Type.Literal('browser'),
    stage: enumOf(['startup', 'hydration', 'cache', 'ownership', 'reconnect', 'stale-response', 'queue']),
    outcome: enumOf([
      'ready',
      'pending',
      'failed',
      'cancelled',
      'stale-rejected',
      'reader',
      'writer',
      'offline',
      'online',
      'unknown',
    ]),
    durationMs: Type.Optional(duration),
    queuedCount: Type.Optional(count),
    queueAgeMs: Type.Optional(duration),
    attemptCount: Type.Optional(count),
    failureCode: Type.Optional(enumOf(STARTUP_TELEMETRY_FAILURE_CODES)),
    build: Type.Optional(Type.String({ pattern: '^(?:[a-f0-9]{40,64}|unknown)$' })),
  }),
  legacy: object({
    ...base,
    category: Type.Literal('legacy'),
    detail: Type.Omit(DiagnosticEntrySchema, ['locations'], { additionalProperties: false }),
  }),
}
export const DIAGNOSTIC_EVENT_CATEGORIES = Object.keys(eventSchemas) as (keyof typeof eventSchemas)[]
export const DiagnosticEventV2Schema = Type.Union(Object.values(eventSchemas))
export type DiagnosticEventV2 = Static<typeof DiagnosticEventV2Schema>

export function isDiagnosticEventV2(input: unknown): input is DiagnosticEventV2 {
  try {
    if (!Value.Check(DiagnosticEventV2Schema, input)) return false
    if (input.correlation === 'operation' && !input.operationRef) return false
    if (input.correlation === 'request' && !input.requestUid) return false
    if (
      input.category === 'legacy' &&
      (input.detail.source !== input.source || input.detail.timestamp !== input.timestamp)
    )
      return false
    if (input.category === 'display') {
      const validationFields = [
        input.validationDomain,
        input.validationOwner,
        input.validationFieldRef,
        input.validationRule,
        input.valueKind,
      ]
      if (input.failureKind === 'generation-input-validation') {
        if (
          input.stage !== 'scope-decode' ||
          input.validationDomain === undefined ||
          input.validationOwner === undefined ||
          input.validationRule === undefined ||
          input.valueKind === undefined
        )
          return false
      } else if (validationFields.some((field) => field !== undefined)) return false
    }
    return true
  } catch {
    return false
  }
}

/** Browser assertions may contain only locally observed, content-free families. */
export function isBrowserDiagnosticEvent(input: unknown): input is DiagnosticEventV2 {
  if (
    !isDiagnosticEventV2(input) ||
    input.source !== 'browser' ||
    input.correlation !== 'client-asserted' ||
    input.operationRef !== undefined ||
    input.attemptRef !== undefined
  )
    return false
  if (input.category === 'script') {
    return (
      input.runtime === 'plugin' &&
      input.hook === 'onOutput' &&
      input.comparison === 'unavailable' &&
      input.outputChanged === undefined &&
      input.transcriptChanged === undefined &&
      input.allowedCalls === undefined &&
      input.blockedCalls === undefined
    )
  }
  return ['legacy', 'browser', 'http', 'runtime'].includes(input.category)
}

/** Local producers select facts; every family has its own exact allowlist. */
export function projectDiagnosticEventV2(input: unknown): DiagnosticEventV2 | null {
  try {
    if (!input || typeof input !== 'object') return null
    const value = input as Record<string, unknown>
    if (typeof value.category !== 'string' || !Object.hasOwn(eventSchemas, value.category)) return null
    const schema: TObject = eventSchemas[value.category as keyof typeof eventSchemas]
    const out: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(schema.properties)) {
      if (value[key] !== undefined && Value.Check(field, value[key])) out[key] = structuredClone(value[key])
    }
    return isDiagnosticEventV2(out) ? out : null
  } catch {
    return null
  }
}

export const DiagnosticJournalRecordSchema = object({
  sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  receivedAt: timestamp,
  instanceId: reference,
  provenance: Type.Union([
    object({ kind: Type.Literal('server') }),
    object({ kind: Type.Literal('browser'), sourceId: reference, eventId: reference, clientSequence: count }),
  ]),
  entry: DiagnosticEventV2Schema,
})
export type DiagnosticJournalRecord = Static<typeof DiagnosticJournalRecordSchema>

/** Restoration and remote reads reject whole malformed records, never repair arbitrary text. */
export function projectDiagnosticJournalRecord(input: unknown): DiagnosticJournalRecord | null {
  try {
    if (!Value.Check(DiagnosticJournalRecordSchema, input) || !isDiagnosticEventV2(input.entry)) return null
    if (input.provenance.kind === 'server' && input.entry.source !== 'server') return null
    if (input.provenance.kind === 'browser' && !isBrowserDiagnosticEvent(input.entry)) return null
    return structuredClone(input)
  } catch {
    return null
  }
}

/** Coarse bytes; no content inspection or hashing. */
export function diagnosticSizeBucket(bytes: unknown): (typeof DIAGNOSTIC_SIZE_BUCKETS)[number] {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown'
  return bytes === 0
    ? 'none'
    : bytes <= 4096
      ? 'small'
      : bytes <= 65_536
        ? 'medium'
        : bytes <= 1_048_576
          ? 'large'
          : 'huge'
}
