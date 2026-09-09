import { describe, expect, it } from 'vitest'
import {
  STARTUP_TELEMETRY_FAILURE_CODES,
  STARTUP_TELEMETRY_MAX_BATCH_EVENTS,
  STARTUP_TELEMETRY_MAX_DURATION_MS,
  STARTUP_TELEMETRY_MILESTONES,
  STARTUP_TELEMETRY_PROTOCOL_VERSION,
  StartupTelemetryFailureCodeSchema,
  StartupTelemetryMilestoneSchema,
  isStartupTelemetryBatch,
  isStartupTelemetryConfiguration,
  type StartupTelemetryBatch,
} from '@risuai/protocol/startup-telemetry'

function batch(events: StartupTelemetryBatch['events']): StartupTelemetryBatch {
  return { version: STARTUP_TELEMETRY_PROTOCOL_VERSION, events }
}

describe('startup telemetry protocol', () => {
  it('publishes stable milestone and failure-code taxonomies', () => {
    expect(STARTUP_TELEMETRY_MILESTONES).toEqual([
      'entry',
      'shell-mounted',
      'reader-ready',
      'writer-ready',
      'plugins-ready',
      'chat-ready',
      'background-ready',
    ])
    expect(STARTUP_TELEMETRY_FAILURE_CODES).toEqual([
      'writer-bootstrap-failed',
      'push-initialization-failed',
      'plugin-initialization-failed',
      'generation-recovery-failed',
      'selected-character-hydration-failed',
      'selected-chat-hydration-failed',
      'selected-prompt-template-hydration-failed',
      'runtime-initialization-failed',
    ])
    expect(StartupTelemetryMilestoneSchema.anyOf.map((entry) => entry.const)).toEqual(STARTUP_TELEMETRY_MILESTONES)
    expect(StartupTelemetryFailureCodeSchema.anyOf.map((entry) => entry.const)).toEqual(STARTUP_TELEMETRY_FAILURE_CODES)
  })

  it('accepts the exact bounded event shapes', () => {
    expect(
      isStartupTelemetryBatch(
        batch([
          {
            kind: 'phase-ready',
            milestone: 'writer-ready',
            entryDurationMs: 125.25,
            attemptCount: 1,
          },
          {
            kind: 'attempt-completed',
            attemptDurationMs: 150,
            attemptCount: 1,
          },
          {
            kind: 'attempt-failed',
            attemptDurationMs: 25,
            attemptCount: 2,
            failureCode: 'writer-bootstrap-failed',
            failureMilestone: 'writer-ready',
          },
          {
            kind: 'diagnostic-failure',
            attemptCount: 2,
            failureCode: 'plugin-initialization-failed',
            failureMilestone: 'plugins-ready',
          },
        ]),
      ),
    ).toBe(true)
    expect(isStartupTelemetryConfiguration({ version: 2, sampleRate: 1 })).toBe(true)
  })

  it('rejects arbitrary content fields, unknown taxonomy values, and invalid configuration', () => {
    const validPhase = {
      kind: 'phase-ready',
      milestone: 'writer-ready',
      entryDurationMs: 125,
      attemptCount: 1,
    } as const
    expect(isStartupTelemetryBatch({ ...batch([validPhase]), route: '/characters/private' })).toBe(false)
    expect(isStartupTelemetryBatch({ version: 2, events: [{ ...validPhase, account: 'private-account' }] })).toBe(false)
    expect(isStartupTelemetryBatch({ version: 2, events: [{ ...validPhase, milestone: 'private-route' }] })).toBe(false)
    expect(isStartupTelemetryConfiguration({ version: 1, sampleRate: 0.5 })).toBe(false)
    expect(isStartupTelemetryConfiguration({ version: 1, sampleRate: 1, account: 'private-account' })).toBe(false)
  })

  it('rejects empty or oversized batches and unbounded numeric values', () => {
    const validPhase = {
      kind: 'phase-ready' as const,
      milestone: 'entry' as const,
      entryDurationMs: 0,
      attemptCount: 0,
    }
    expect(isStartupTelemetryBatch(batch([]))).toBe(false)
    expect(
      isStartupTelemetryBatch(batch(Array.from({ length: STARTUP_TELEMETRY_MAX_BATCH_EVENTS + 1 }, () => validPhase))),
    ).toBe(false)
    expect(
      isStartupTelemetryBatch(batch([{ ...validPhase, entryDurationMs: STARTUP_TELEMETRY_MAX_DURATION_MS + 1 }])),
    ).toBe(false)
    expect(isStartupTelemetryBatch(batch([{ ...validPhase, attemptCount: Number.MAX_SAFE_INTEGER }]))).toBe(false)
  })
})
