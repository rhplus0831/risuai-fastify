import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { normalizeReportedClientContext } from './clientContext'

export const DISPLAY_SOURCE_PROTOCOL_VERSION = 1 as const
export const DISPLAY_SOURCE_TRANSFORM_VERSION = 'editdisplay-v2-ephemeral-state' as const

export const DISPLAY_SOURCE_LIMITS = {
  maxTargets: 64,
  maxSourceBytes: 512 * 1024,
  maxRequestSourceBytes: 4 * 1024 * 1024,
  maxRequestKeyLength: 128,
  maxPageSessionIdLength: 128,
} as const

export const DISPLAY_SOURCE_LAYERS = ['original', 'translation', 'bilingual', 'greeting', 'preview'] as const

export const DisplaySourceLayerSchema = Type.Union(DISPLAY_SOURCE_LAYERS.map((layer) => Type.Literal(layer)))

export const DisplayRequestContextSchema = Type.Object(
  {
    pageSessionId: Type.String(),
    browserLanguage: Type.Optional(Type.String()),
    screenWidth: Type.Optional(Type.Number()),
    screenHeight: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
)

export const DisplaySourceTargetSchema = Type.Object(
  {
    requestKey: Type.String(),
    characterId: Type.String(),
    messageId: Type.Optional(Type.String()),
    index: Type.Number(),
    role: Type.Union([Type.String(), Type.Null()]),
    firstMessage: Type.Boolean(),
    layer: DisplaySourceLayerSchema,
    source: Type.String(),
    sourceHash: Type.String(),
    projectionEpoch: Type.Number(),
    /** Growing provider prefix; never eligible for the shared server LRU. */
    streaming: Type.Optional(Type.Boolean()),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)

export const DisplaySourceRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(DISPLAY_SOURCE_PROTOCOL_VERSION),
    baseRevision: Type.Number(),
    context: DisplayRequestContextSchema,
    targets: Type.Array(DisplaySourceTargetSchema),
    /** Target keys in foreground processing order; omitted by legacy JSON clients. */
    priorityKeys: Type.Optional(Type.Array(Type.String(), { maxItems: DISPLAY_SOURCE_LIMITS.maxTargets })),
  },
  { additionalProperties: false },
)

export const DisplaySourceOkResponseEntrySchema = Type.Object(
  {
    requestKey: Type.String(),
    status: Type.Literal('ok'),
    sourceHash: Type.String(),
    dependencyFingerprint: Type.String(),
    displaySource: Type.String(),
  },
  { additionalProperties: false },
)

export const DisplaySourceFallbackResponseEntrySchema = Type.Object(
  {
    requestKey: Type.String(),
    status: Type.Union([Type.Literal('client_fallback'), Type.Literal('stale'), Type.Literal('error')]),
    sourceHash: Type.String(),
    reason: Type.String(),
  },
  { additionalProperties: false },
)

export const DisplaySourceResponseEntrySchema = Type.Union([
  DisplaySourceOkResponseEntrySchema,
  DisplaySourceFallbackResponseEntrySchema,
])

export const DisplaySourceResponseSchema = Type.Object(
  {
    protocolVersion: Type.Literal(DISPLAY_SOURCE_PROTOCOL_VERSION),
    revision: Type.Number(),
    contextFingerprint: Type.String(),
    entries: Type.Array(DisplaySourceResponseEntrySchema),
  },
  { additionalProperties: false },
)

const displayStreamContext = {
  protocolVersion: Type.Literal(DISPLAY_SOURCE_PROTOCOL_VERSION),
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  contextFingerprint: Type.String(),
}

/** A finite POST response stream. Every target has one result, followed by done.
 * Invalidation retires already delivered projections as well as pending work.
 */
export const DisplaySourceStreamEventSchema = Type.Union([
  Type.Object(
    { type: Type.Literal('result'), ...displayStreamContext, entry: DisplaySourceResponseEntrySchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('done'),
      ...displayStreamContext,
      targetCount: Type.Integer({ minimum: 0, maximum: DISPLAY_SOURCE_LIMITS.maxTargets }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('invalidated'),
      revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      reason: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal('error'), reason: Type.String() }, { additionalProperties: false }),
])
export type DisplaySourceStreamEvent = Static<typeof DisplaySourceStreamEventSchema>
export function isDisplaySourceStreamEvent(value: unknown): value is DisplaySourceStreamEvent {
  return Value.Check(DisplaySourceStreamEventSchema, value)
}

export const DisplaySourceNamespaceInputSchema = Type.Object(
  {
    databaseLineage: Type.String(),
    activeWriterEpoch: Type.Number(),
    context: DisplayRequestContextSchema,
    protocolVersion: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
)

export type DisplaySourceLayer = Static<typeof DisplaySourceLayerSchema>
export type DisplayRequestContext = Static<typeof DisplayRequestContextSchema>
export type DisplaySourceTarget = Static<typeof DisplaySourceTargetSchema>
export type DisplaySourceRequest = Static<typeof DisplaySourceRequestSchema>
export type DisplaySourceResponseEntry = Static<typeof DisplaySourceResponseEntrySchema>
export type DisplaySourceResponse = Static<typeof DisplaySourceResponseSchema>
export type DisplaySourceNamespaceInput = Static<typeof DisplaySourceNamespaceInputSchema>

export function isDisplaySourceRequest(value: unknown): value is DisplaySourceRequest {
  return Value.Check(DisplaySourceRequestSchema, value)
}

export function isDisplaySourceResponse(value: unknown): value is DisplaySourceResponse {
  return Value.Check(DisplaySourceResponseSchema, value)
}

export function normalizeDisplayRequestContext(value: unknown): DisplayRequestContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const pageSessionId = typeof raw.pageSessionId === 'string' ? raw.pageSessionId.trim() : ''
  if (pageSessionId.length === 0 || pageSessionId.length > DISPLAY_SOURCE_LIMITS.maxPageSessionIdLength) {
    return undefined
  }
  const reported = normalizeReportedClientContext(raw)
  return { pageSessionId, ...reported }
}

export function normalizeDisplayDependencyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeDisplayDependencyValue(item))
  if (!value || typeof value !== 'object') return value

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const next = (value as Record<string, unknown>)[key]
    if (next === undefined || typeof next === 'function') continue
    normalized[key] = normalizeDisplayDependencyValue(next)
  }
  return normalized
}

export function stableDisplayDependencyJson(value: unknown): string {
  return JSON.stringify(normalizeDisplayDependencyValue(value)) ?? 'null'
}

export function displaySourceNamespaceValue(input: DisplaySourceNamespaceInput): Record<string, unknown> {
  return {
    activeWriterEpoch: input.activeWriterEpoch,
    browserLanguage: input.context.browserLanguage,
    databaseLineage: input.databaseLineage,
    pageSessionId: input.context.pageSessionId,
    protocolVersion: input.protocolVersion ?? DISPLAY_SOURCE_PROTOCOL_VERSION,
    screenHeight: input.context.screenHeight,
    screenWidth: input.context.screenWidth,
  }
}

export function displaySourceNamespaceJson(input: DisplaySourceNamespaceInput): string {
  return stableDisplayDependencyJson(displaySourceNamespaceValue(input))
}
