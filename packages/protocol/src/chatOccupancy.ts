import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export const CHAT_OCCUPANCY_PROTOCOL_VERSION = 1 as const
export const CHAT_OCCUPANCY_LEASE_MS = 90_000 as const
export const CHAT_OCCUPANCY_RENEW_AFTER_MS = 30_000 as const
export const CHAT_OCCUPANCY_EPOCH_HEADER = 'risu-chat-occupancy-epoch' as const

export const CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT = '/api/v1/chat-occupancies' as const
export const CHAT_OCCUPANCY_SWITCH_ENDPOINT = '/api/v1/chat-occupancies/switch' as const
export const CHAT_OCCUPANCY_NORMALIZE_ENDPOINT = '/api/v1/chat-occupancies/normalize' as const

export const ChatOccupancyClaimClassSchema = Type.Union([Type.Literal('owner'), Type.Literal('chat_only')])
export const ChatOccupancyStateSchema = Type.Union([
  Type.Literal('occupied'),
  Type.Literal('expired'),
  Type.Literal('released'),
])

const SessionIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^\\S(?:.*\\S)?$' })
const ChatIdSchema = Type.String({ minLength: 1, maxLength: 512, pattern: '^\\S(?:.*\\S)?$' })
const EpochSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const TimestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })

export const ChatOccupancyProjectionSchema = Type.Object(
  {
    databaseLineage: Type.String({ minLength: 1 }),
    chatId: ChatIdSchema,
    occupantSessionId: Type.Union([SessionIdSchema, Type.Null()]),
    occupancyEpoch: EpochSchema,
    claimClass: Type.Union([ChatOccupancyClaimClassSchema, Type.Null()]),
    state: ChatOccupancyStateSchema,
    claimedAtMs: Type.Union([TimestampSchema, Type.Null()]),
    leaseExpiresAtMs: Type.Union([TimestampSchema, Type.Null()]),
    updatedAtMs: TimestampSchema,
    releasedAtMs: Type.Union([TimestampSchema, Type.Null()]),
  },
  { additionalProperties: false },
)

export const ChatOccupancySnapshotSchema = Type.Object(
  {
    version: Type.Literal(CHAT_OCCUPANCY_PROTOCOL_VERSION),
    databaseLineage: Type.String({ minLength: 1 }),
    occupancies: Type.Array(ChatOccupancyProjectionSchema),
  },
  { additionalProperties: false },
)

/**
 * Revision-free discovery hint carried by the authenticated application event
 * stream. The lineage remains available even when the complete snapshot is
 * empty; every non-empty row repeats it as part of the authoritative tuple.
 */
export const ChatOccupancyEventSchema = Type.Object(
  {
    type: Type.Literal('occupancy.snapshot'),
    version: Type.Literal(CHAT_OCCUPANCY_PROTOCOL_VERSION),
    databaseLineage: Type.String({ minLength: 1 }),
    occupancies: Type.Array(ChatOccupancyProjectionSchema),
  },
  { additionalProperties: false },
)

export const ChatOccupancyCapabilitySchema = Type.Object(
  {
    version: Type.Literal(CHAT_OCCUPANCY_PROTOCOL_VERSION),
    enabled: Type.Boolean(),
    leaseMs: Type.Literal(CHAT_OCCUPANCY_LEASE_MS),
    renewAfterMs: Type.Literal(CHAT_OCCUPANCY_RENEW_AFTER_MS),
  },
  { additionalProperties: false },
)

export const ChatOccupancyClaimRequestSchema = Type.Object(
  {
    version: Type.Literal(CHAT_OCCUPANCY_PROTOCOL_VERSION),
    claimClass: ChatOccupancyClaimClassSchema,
  },
  { additionalProperties: false },
)

export const ChatOccupancyVersionRequestSchema = Type.Object(
  { version: Type.Literal(CHAT_OCCUPANCY_PROTOCOL_VERSION) },
  { additionalProperties: false },
)

export const ChatOccupancySwitchRequestSchema = Type.Object(
  {
    version: Type.Literal(CHAT_OCCUPANCY_PROTOCOL_VERSION),
    sourceChatId: ChatIdSchema,
    targetChatId: ChatIdSchema,
  },
  { additionalProperties: false },
)

export const ChatOccupancyNormalizeRequestSchema = Type.Object(
  {
    version: Type.Literal(CHAT_OCCUPANCY_PROTOCOL_VERSION),
    selectedChatId: ChatIdSchema,
  },
  { additionalProperties: false },
)

export type ChatOccupancyClaimClass = Static<typeof ChatOccupancyClaimClassSchema>
export type ChatOccupancyState = Static<typeof ChatOccupancyStateSchema>
export type ChatOccupancyProjection = Static<typeof ChatOccupancyProjectionSchema>
export type ChatOccupancySnapshot = Static<typeof ChatOccupancySnapshotSchema>
export type ChatOccupancyEvent = Static<typeof ChatOccupancyEventSchema>
export type ChatOccupancyCapability = Static<typeof ChatOccupancyCapabilitySchema>
export type ChatOccupancyClaimRequest = Static<typeof ChatOccupancyClaimRequestSchema>
export type ChatOccupancyVersionRequest = Static<typeof ChatOccupancyVersionRequestSchema>
export type ChatOccupancySwitchRequest = Static<typeof ChatOccupancySwitchRequestSchema>
export type ChatOccupancyNormalizeRequest = Static<typeof ChatOccupancyNormalizeRequestSchema>

export function isChatOccupancyClaimRequest(value: unknown): value is ChatOccupancyClaimRequest {
  return Value.Check(ChatOccupancyClaimRequestSchema, value)
}

export function isChatOccupancyVersionRequest(value: unknown): value is ChatOccupancyVersionRequest {
  return Value.Check(ChatOccupancyVersionRequestSchema, value)
}

export function isChatOccupancySwitchRequest(value: unknown): value is ChatOccupancySwitchRequest {
  return Value.Check(ChatOccupancySwitchRequestSchema, value)
}

export function isChatOccupancyNormalizeRequest(value: unknown): value is ChatOccupancyNormalizeRequest {
  return Value.Check(ChatOccupancyNormalizeRequestSchema, value)
}

export function isChatOccupancySnapshot(value: unknown): value is ChatOccupancySnapshot {
  return Value.Check(ChatOccupancySnapshotSchema, value) && hasCoherentOccupancies(value)
}

export function isChatOccupancyEvent(value: unknown): value is ChatOccupancyEvent {
  if (!Value.Check(ChatOccupancyEventSchema, value)) return false
  return hasCoherentOccupancies(value)
}

function hasCoherentOccupancies(value: {
  databaseLineage: string
  occupancies: readonly ChatOccupancyProjection[]
}): boolean {
  const chatIds = new Set<string>()
  for (const occupancy of value.occupancies) {
    if (occupancy.databaseLineage !== value.databaseLineage || chatIds.has(occupancy.chatId)) return false
    chatIds.add(occupancy.chatId)
  }
  return true
}

export function isChatOccupancyCapability(value: unknown): value is ChatOccupancyCapability {
  return Value.Check(ChatOccupancyCapabilitySchema, value)
}
