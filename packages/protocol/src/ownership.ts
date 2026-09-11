import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export const OWNERSHIP_ENDPOINT = '/api/v1/ownership'
export const OWNERSHIP_PROTOCOL_VERSION = 1 as const

export const OwnershipWriterSchema = Type.Object(
  {
    sessionId: Type.Union([Type.String({ minLength: 1, maxLength: 128, pattern: '^\\S(?:.*\\S)?$' }), Type.Null()]),
    epoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
)

export const OwnershipResponseSchema = Type.Object(
  {
    version: Type.Literal(OWNERSHIP_PROTOCOL_VERSION),
    databaseLineage: Type.String({ minLength: 1 }),
    writer: OwnershipWriterSchema,
  },
  { additionalProperties: false },
)

export type OwnershipWriter = Static<typeof OwnershipWriterSchema>
export type OwnershipResponse = Static<typeof OwnershipResponseSchema>

export function isOwnershipResponse(value: unknown): value is OwnershipResponse {
  return Value.Check(OwnershipResponseSchema, value)
}
