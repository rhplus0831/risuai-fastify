import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  auth: vi.fn(async () => 'startup-telemetry-auth'),
}))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: transport.auth,
}))

import {
  beginStartupAttempt,
  canMutate,
  completeStartupAttempt,
  failStartupAttempt,
  getStartupReadinessSnapshot,
  recordStartupCapabilityFailure,
  recordStartupMilestone,
  resetStartupReadinessForTests,
  subscribeStartupTelemetryEvents,
} from '../startupReadiness'
import {
  __startupTelemetryTestHooks,
  configureStartupTelemetry,
  startStartupTelemetryPublisher,
} from './startupTelemetry'
import type { StartupTelemetryBatch, StartupTelemetryEvent } from '@risuai/protocol/startup-telemetry'

interface CapturedRequest {
  url: string
  init: RequestInit
  batch: StartupTelemetryBatch
}

let requests: CapturedRequest[]

beforeEach(() => {
  resetStartupReadinessForTests()
  __startupTelemetryTestHooks.reset()
  transport.auth.mockReset()
  transport.auth.mockResolvedValue('startup-telemetry-auth')
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        url: String(input),
        init,
        batch: JSON.parse(String(init.body)) as StartupTelemetryBatch,
      })
      return new Response(null, { status: 204 })
    }),
  )
})

afterEach(() => {
  __startupTelemetryTestHooks.reset()
  resetStartupReadinessForTests()
  vi.unstubAllGlobals()
})

function emittedEvents(): StartupTelemetryEvent[] {
  return requests.flatMap((request) => request.batch.events)
}

describe('startup telemetry publisher', () => {
  it('backfills existing milestones and emits each phase and attempt once through authenticated keepalive fetch', async () => {
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 5)
    startStartupTelemetryPublisher()
    configureStartupTelemetry({ version: 2, sampleRate: 1 })

    const attemptId = beginStartupAttempt(10)
    recordStartupMilestone('reader-ready', 20)
    recordStartupMilestone('writer-ready', 30)
    recordStartupMilestone('plugins-ready', 40)
    recordStartupMilestone('chat-ready', 50)
    recordStartupMilestone('background-ready', 60)
    recordStartupMilestone('background-ready', 999)
    completeStartupAttempt(attemptId, 70)
    await __startupTelemetryTestHooks.flush()

    const events = emittedEvents()
    expect(events.filter((event) => event.kind === 'phase-ready').map((event) => event.milestone)).toEqual([
      'entry',
      'shell-mounted',
      'reader-ready',
      'writer-ready',
      'plugins-ready',
      'chat-ready',
      'background-ready',
    ])
    expect(events.at(-1)).toEqual({
      kind: 'attempt-completed',
      attemptDurationMs: 60,
      attemptCount: 1,
    })
    expect(requests.every((request) => request.url === '/api/v1/telemetry/startup')).toBe(true)
    expect(requests.every((request) => request.init.keepalive === true)).toBe(true)
    expect(
      requests.every(
        (request) => (request.init.headers as Record<string, string>)['risu-auth'] === 'startup-telemetry-auth',
      ),
    ).toBe(true)
  })

  it('drops pending data when collection is disabled and never starts an auth or network request', async () => {
    startStartupTelemetryPublisher()
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 1)
    configureStartupTelemetry(undefined)
    const attemptId = beginStartupAttempt(2)
    failStartupAttempt(attemptId, 'writer-bootstrap-failed', 'reader-ready', 3)
    await __startupTelemetryTestHooks.flush()

    expect(requests).toEqual([])
    expect(transport.auth).not.toHaveBeenCalled()
    expect(__startupTelemetryTestHooks.queuedEventCount()).toBe(0)
  })

  it('backfills milestones buffered before telemetry opt-in', async () => {
    startStartupTelemetryPublisher()
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 1)
    configureStartupTelemetry({ version: 2, sampleRate: 1 })
    await __startupTelemetryTestHooks.flush()

    expect(emittedEvents()).toHaveLength(2)
    expect(emittedEvents().map((event) => event.kind)).toEqual(['phase-ready', 'phase-ready'])
  })

  it('isolates synchronous listeners and rejected transports from readiness capabilities', async () => {
    const stopThrowingListener = subscribeStartupTelemetryEvents(() => {
      throw new Error('telemetry sink failed')
    })
    transport.auth.mockRejectedValueOnce(new Error('auth unavailable'))
    startStartupTelemetryPublisher()
    configureStartupTelemetry({ version: 2, sampleRate: 1 })

    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 1)
    const attemptId = beginStartupAttempt(2)
    recordStartupMilestone('reader-ready', 3)
    recordStartupMilestone('writer-ready', 4)
    completeStartupAttempt(attemptId, 5)
    await __startupTelemetryTestHooks.flush()
    stopThrowingListener()

    expect(canMutate()).toBe(true)
    expect(getStartupReadinessSnapshot().phase).toBe('writer-ready')
  })

  it('bounds pre-configuration diagnostic retention', () => {
    startStartupTelemetryPublisher()
    recordStartupMilestone('entry', 0)
    const attemptId = beginStartupAttempt(1)
    for (let index = 0; index < 100; index += 1) {
      recordStartupCapabilityFailure(attemptId, 'runtime-initialization-failed', 'background-ready', index + 2)
    }

    expect(__startupTelemetryTestHooks.queuedEventCount()).toBe(64)
  })
})
