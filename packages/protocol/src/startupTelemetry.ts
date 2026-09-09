import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export const STARTUP_TELEMETRY_PROTOCOL_VERSION = 2 as const
export const STARTUP_TELEMETRY_MAX_BATCH_EVENTS = 32
export const STARTUP_TELEMETRY_MAX_ATTEMPTS = 10_000
export const STARTUP_TELEMETRY_MAX_DURATION_MS = 24 * 60 * 60 * 1000

export const STARTUP_TELEMETRY_MILESTONES = [
  'entry',
  'shell-mounted',
  'reader-ready',
  'writer-ready',
  'plugins-ready',
  'chat-ready',
  'background-ready',
] as const

export const StartupTelemetryMilestoneSchema = Type.Union([
  Type.Literal('entry'),
  Type.Literal('shell-mounted'),
  Type.Literal('reader-ready'),
  Type.Literal('writer-ready'),
  Type.Literal('plugins-ready'),
  Type.Literal('chat-ready'),
  Type.Literal('background-ready'),
])

export type StartupTelemetryMilestone = Static<typeof StartupTelemetryMilestoneSchema>

export const STARTUP_TELEMETRY_FAILURE_CODES = [
  'writer-bootstrap-failed',
  'push-initialization-failed',
  'plugin-initialization-failed',
  'generation-recovery-failed',
  'selected-character-hydration-failed',
  'selected-chat-hydration-failed',
  'selected-prompt-template-hydration-failed',
  'runtime-initialization-failed',
] as const

export const StartupTelemetryFailureCodeSchema = Type.Union([
  Type.Literal('writer-bootstrap-failed'),
  Type.Literal('push-initialization-failed'),
  Type.Literal('plugin-initialization-failed'),
  Type.Literal('generation-recovery-failed'),
  Type.Literal('selected-character-hydration-failed'),
  Type.Literal('selected-chat-hydration-failed'),
  Type.Literal('selected-prompt-template-hydration-failed'),
  Type.Literal('runtime-initialization-failed'),
])

export type StartupTelemetryFailureCode = Static<typeof StartupTelemetryFailureCodeSchema>

const StartupTelemetryEventBaseSchema = {
  attemptCount: Type.Integer({ minimum: 0, maximum: STARTUP_TELEMETRY_MAX_ATTEMPTS }),
}

const StartupTelemetryDurationSchema = Type.Number({ minimum: 0, maximum: STARTUP_TELEMETRY_MAX_DURATION_MS })

export const StartupTelemetryPhaseEventSchema = Type.Object(
  {
    ...StartupTelemetryEventBaseSchema,
    kind: Type.Literal('phase-ready'),
    milestone: StartupTelemetryMilestoneSchema,
    entryDurationMs: StartupTelemetryDurationSchema,
  },
  { additionalProperties: false },
)

export const StartupTelemetryAttemptCompletedEventSchema = Type.Object(
  {
    ...StartupTelemetryEventBaseSchema,
    kind: Type.Literal('attempt-completed'),
    attemptDurationMs: StartupTelemetryDurationSchema,
  },
  { additionalProperties: false },
)

export const StartupTelemetryAttemptFailedEventSchema = Type.Object(
  {
    ...StartupTelemetryEventBaseSchema,
    kind: Type.Literal('attempt-failed'),
    attemptDurationMs: StartupTelemetryDurationSchema,
    failureCode: StartupTelemetryFailureCodeSchema,
    failureMilestone: StartupTelemetryMilestoneSchema,
  },
  { additionalProperties: false },
)

export const StartupTelemetryDiagnosticFailureEventSchema = Type.Object(
  {
    ...StartupTelemetryEventBaseSchema,
    kind: Type.Literal('diagnostic-failure'),
    failureCode: StartupTelemetryFailureCodeSchema,
    failureMilestone: StartupTelemetryMilestoneSchema,
  },
  { additionalProperties: false },
)

export const StartupTelemetryEventSchema = Type.Union([
  StartupTelemetryPhaseEventSchema,
  StartupTelemetryAttemptCompletedEventSchema,
  StartupTelemetryAttemptFailedEventSchema,
  StartupTelemetryDiagnosticFailureEventSchema,
])

export type StartupTelemetryPhaseEvent = Static<typeof StartupTelemetryPhaseEventSchema>
export type StartupTelemetryAttemptCompletedEvent = Static<typeof StartupTelemetryAttemptCompletedEventSchema>
export type StartupTelemetryAttemptFailedEvent = Static<typeof StartupTelemetryAttemptFailedEventSchema>
export type StartupTelemetryDiagnosticFailureEvent = Static<typeof StartupTelemetryDiagnosticFailureEventSchema>
export type StartupTelemetryEvent = Static<typeof StartupTelemetryEventSchema>

/** Browser startup snapshots exposed to the browser-smoke diagnostic bridge. */
export type StartupCapability = 'canRenderShell' | 'canApplyRoutes' | 'canMutate' | 'pluginsReady' | 'canGenerate'
export type StartupRetryTarget = StartupCapability | 'backgroundReady'
export type StartupStep =
  | 'writer-owner-adoption'
  | 'writer-bootstrap'
  | 'writer-initialize'
  | 'writer-outbox-prepare'
  | 'writer-receipt-flush'
  | 'writer-pending-replay'
  | 'writer-resource-hydration'
  | 'writer-projection-install'
  | 'writer-runtime-services'
  | 'writer-event-subscription'
  | 'chat-hydration-runtime'
  | 'chat-readiness'
  | 'push-runtime'
  | 'plugin-runtime'
  | 'generation-recovery'
  | 'background-runtime'
  | 'background-readiness'

export interface StartupAttemptSnapshot {
  attemptId: number
  startedAtMs: number
  completedAtMs?: number
  failedAtMs?: number
  failureCode?: StartupTelemetryFailureCode
  failureMilestone?: StartupTelemetryMilestone
}

export interface StartupReadinessSnapshot {
  schemaVersion: 1
  phase: StartupTelemetryMilestone | null
  timestamps: Partial<Record<StartupTelemetryMilestone, number>>
  durationsFromEntry: Partial<Record<StartupTelemetryMilestone, number>>
  attempts: StartupAttemptSnapshot[]
}

export interface StartupCapabilityFailureSnapshot {
  attemptId: number
  failureCode: StartupTelemetryFailureCode
  failureMilestone: StartupTelemetryMilestone
  failedAtMs: number
}

export interface StartupCoordinatorSnapshot {
  schemaVersion: 1
  capabilities: Record<StartupCapability, boolean>
  writerCapabilitiesRevoked: boolean
  failures: Partial<Record<StartupRetryTarget, StartupCapabilityFailureSnapshot>>
  completedSteps: StartupStep[]
}

export const StartupTelemetryBatchSchema = Type.Object(
  {
    version: Type.Literal(STARTUP_TELEMETRY_PROTOCOL_VERSION),
    events: Type.Array(StartupTelemetryEventSchema, {
      minItems: 1,
      maxItems: STARTUP_TELEMETRY_MAX_BATCH_EVENTS,
    }),
  },
  { additionalProperties: false },
)

export const StartupTelemetryConfigurationSchema = Type.Object(
  {
    version: Type.Literal(STARTUP_TELEMETRY_PROTOCOL_VERSION),
    sampleRate: Type.Literal(1),
  },
  { additionalProperties: false },
)

export type StartupTelemetryBatch = Static<typeof StartupTelemetryBatchSchema>
export type StartupTelemetryConfiguration = Static<typeof StartupTelemetryConfigurationSchema>

export function isStartupTelemetryBatch(value: unknown): value is StartupTelemetryBatch {
  return Value.Check(StartupTelemetryBatchSchema, value)
}

export function isStartupTelemetryConfiguration(value: unknown): value is StartupTelemetryConfiguration {
  return Value.Check(StartupTelemetryConfigurationSchema, value)
}

export function isStartupTelemetryEvent(value: unknown): value is StartupTelemetryEvent {
  return Value.Check(StartupTelemetryEventSchema, value)
}
