import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { DiagnosticEventV2Schema, isBrowserDiagnosticEvent } from './diagnosticEvents.js'

export const BROWSER_DIAGNOSTICS_VERSION = 1
export const BROWSER_DIAGNOSTICS_MAX_EVENTS = 32
export const BROWSER_DIAGNOSTICS_MAX_BYTES = 64 * 1024
export const BROWSER_DIAGNOSTICS_MAX_RECORD_BYTES = 4096
const reference = Type.String({ pattern: '^[a-f0-9]{32}$' })
const count = Type.Integer({ minimum: 0, maximum: BROWSER_DIAGNOSTICS_MAX_EVENTS })
const encoder = new TextEncoder()

export const BrowserDiagnosticsConfigurationSchema = Type.Object(
  { version: Type.Literal(BROWSER_DIAGNOSTICS_VERSION) },
  { additionalProperties: false },
)
export type BrowserDiagnosticsConfiguration = Static<typeof BrowserDiagnosticsConfigurationSchema>
export function isBrowserDiagnosticsConfiguration(value: unknown): value is BrowserDiagnosticsConfiguration {
  try {
    return Value.Check(BrowserDiagnosticsConfigurationSchema, value)
  } catch {
    return false
  }
}

export const BrowserDiagnosticsBatchSchema = Type.Object(
  {
    version: Type.Literal(BROWSER_DIAGNOSTICS_VERSION),
    sourceId: reference,
    events: Type.Array(
      Type.Object(
        {
          eventId: reference,
          clientSequence: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }),
          entry: DiagnosticEventV2Schema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: BROWSER_DIAGNOSTICS_MAX_EVENTS },
    ),
  },
  { additionalProperties: false },
)
export type BrowserDiagnosticsBatch = Static<typeof BrowserDiagnosticsBatchSchema>

/** Validate the complete batch before accepting any event; never strip private extras. */
export function isBrowserDiagnosticsBatch(value: unknown): value is BrowserDiagnosticsBatch {
  try {
    if (!Value.Check(BrowserDiagnosticsBatchSchema, value)) return false
    if (encoder.encode(JSON.stringify(value)).byteLength > BROWSER_DIAGNOSTICS_MAX_BYTES) return false
    return value.events.every((event) => {
      const entry = event.entry
      if (!isBrowserDiagnosticEvent(entry)) return false
      // Reserve server-controlled metadata widths so a valid upload cannot
      // become oversized when the journal assigns provenance and ordering.
      const record = {
        sequence: Number.MAX_SAFE_INTEGER,
        receivedAt: 8_640_000_000_000_000,
        instanceId: '0'.repeat(32),
        provenance: {
          kind: 'browser',
          sourceId: value.sourceId,
          eventId: event.eventId,
          clientSequence: event.clientSequence,
        },
        entry,
      }
      return encoder.encode(JSON.stringify(record)).byteLength <= BROWSER_DIAGNOSTICS_MAX_RECORD_BYTES
    })
  } catch {
    return false
  }
}

export const BrowserDiagnosticsUploadResponseSchema = Type.Object(
  { version: Type.Literal(BROWSER_DIAGNOSTICS_VERSION), accepted: count, duplicates: count, dropped: count },
  { additionalProperties: false },
)
export type BrowserDiagnosticsUploadResponse = Static<typeof BrowserDiagnosticsUploadResponseSchema>
export function isBrowserDiagnosticsUploadResponse(value: unknown): value is BrowserDiagnosticsUploadResponse {
  try {
    return (
      Value.Check(BrowserDiagnosticsUploadResponseSchema, value) &&
      value.accepted + value.duplicates + value.dropped <= BROWSER_DIAGNOSTICS_MAX_EVENTS
    )
  } catch {
    return false
  }
}

export const BROWSER_DIAGNOSTICS_ERRORS = [
  'disabled',
  'unauthorized',
  'invalid-batch',
  'rate-limited',
  'storage-unavailable',
  'internal-error',
] as const
export type BrowserDiagnosticsError = (typeof BROWSER_DIAGNOSTICS_ERRORS)[number]
export const BrowserDiagnosticsErrorSchema = Type.Object(
  { error: Type.Union(BROWSER_DIAGNOSTICS_ERRORS.map((value) => Type.Literal(value))) },
  { additionalProperties: false },
)
