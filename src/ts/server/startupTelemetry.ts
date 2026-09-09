import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { getStartupReadinessSnapshot, STARTUP_MILESTONES, subscribeStartupTelemetryEvents } from '../startupReadiness'
import {
  STARTUP_TELEMETRY_MAX_BATCH_EVENTS,
  STARTUP_TELEMETRY_MAX_ATTEMPTS,
  STARTUP_TELEMETRY_MAX_DURATION_MS,
  STARTUP_TELEMETRY_PROTOCOL_VERSION,
  isStartupTelemetryConfiguration,
  type StartupTelemetryConfiguration,
  type StartupTelemetryEvent,
} from '@risuai/protocol/startup-telemetry'

const STARTUP_TELEMETRY_ENDPOINT = '/api/v1/telemetry/startup'
const STARTUP_TELEMETRY_MAX_QUEUED_EVENTS = STARTUP_TELEMETRY_MAX_BATCH_EVENTS * 2

type CollectionState = 'pending' | 'enabled' | 'disabled'

let collectionState: CollectionState = 'pending'
let queuedEvents: StartupTelemetryEvent[] = []
let seenMilestones = new Set<string>()
let stopTelemetrySubscription: (() => void) | null = null
let flushPromise: Promise<void> | null = null
let publisherEpoch = 0

/** Start before the first attempt; existing entry/shell milestones are backfilled. */
export function startStartupTelemetryPublisher(): void {
  if (stopTelemetrySubscription) return
  stopTelemetrySubscription = subscribeStartupTelemetryEvents(queueStartupTelemetryEvent)
  queueCurrentMilestones()
}

/** Apply the authenticated server opt-in. Missing or malformed config disables collection. */
export function configureStartupTelemetry(configuration: unknown): void {
  if (!isStartupTelemetryConfiguration(configuration)) {
    collectionState = 'disabled'
    queuedEvents = []
    seenMilestones.clear()
    return
  }

  if (collectionState === 'disabled') seenMilestones.clear()
  collectionState = 'enabled'
  if (!stopTelemetrySubscription) return
  queueCurrentMilestones()
  scheduleStartupTelemetryFlush()
}

function queueCurrentMilestones(): void {
  const readiness = getStartupReadinessSnapshot()
  for (const milestone of STARTUP_MILESTONES) {
    const timestamp = readiness.timestamps[milestone]
    if (timestamp === undefined || seenMilestones.has(milestone)) continue
    queueStartupTelemetryEvent({
      kind: 'phase-ready',
      milestone,
      entryDurationMs: Math.min(
        STARTUP_TELEMETRY_MAX_DURATION_MS,
        Math.max(0, readiness.durationsFromEntry[milestone] ?? 0),
      ),
      attemptCount: Math.min(STARTUP_TELEMETRY_MAX_ATTEMPTS, readiness.attempts.length),
    })
  }
}

function queueStartupTelemetryEvent(event: Readonly<StartupTelemetryEvent>): void {
  if (event.kind === 'phase-ready') {
    if (seenMilestones.has(event.milestone)) return
    seenMilestones.add(event.milestone)
  }
  if (collectionState === 'disabled') return

  queuedEvents.push({ ...event })
  if (queuedEvents.length > STARTUP_TELEMETRY_MAX_QUEUED_EVENTS) {
    queuedEvents.splice(0, queuedEvents.length - STARTUP_TELEMETRY_MAX_QUEUED_EVENTS)
  }
  scheduleStartupTelemetryFlush()
}

function scheduleStartupTelemetryFlush(): void {
  if (collectionState !== 'enabled' || queuedEvents.length === 0 || flushPromise) return
  const epoch = publisherEpoch
  flushPromise = Promise.resolve()
    .then(() => flushStartupTelemetryBatch(epoch))
    .catch(() => undefined)
    .finally(() => {
      flushPromise = null
      if (epoch === publisherEpoch && queuedEvents.length > 0) scheduleStartupTelemetryFlush()
    })
}

async function flushStartupTelemetryBatch(epoch: number): Promise<void> {
  if (epoch !== publisherEpoch || collectionState !== 'enabled') return
  const events = queuedEvents.splice(0, STARTUP_TELEMETRY_MAX_BATCH_EVENTS)
  if (events.length === 0) return

  try {
    const auth = await getNodeServerProxyAuth()
    if (epoch !== publisherEpoch || collectionState !== 'enabled') return
    await fetch(STARTUP_TELEMETRY_ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: {
        'content-type': 'application/json',
        'risu-auth': auth,
      },
      body: JSON.stringify({ version: STARTUP_TELEMETRY_PROTOCOL_VERSION, events }),
    })
  } catch {
    // Best effort only. Dropping diagnostics must never delay or retry startup.
  }
}

export const __startupTelemetryTestHooks = {
  async flush(): Promise<void> {
    while (flushPromise) await flushPromise
  },
  queuedEventCount(): number {
    return queuedEvents.length
  },
  reset(): void {
    publisherEpoch += 1
    stopTelemetrySubscription?.()
    stopTelemetrySubscription = null
    collectionState = 'pending'
    queuedEvents = []
    seenMilestones = new Set<string>()
    flushPromise = null
  },
}

export type { StartupTelemetryConfiguration }
