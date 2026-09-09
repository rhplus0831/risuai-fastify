import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ACTIVE_WRITER_SESSION_HEADER } from '../src/activeWriter.js'
import { subscribeProtocolMetrics } from '../src/protocolMetrics.js'
import { setupAuthedClient } from './helpers/auth.js'

interface Harness {
  app: FastifyInstance
  dataDir: string
}

interface ProtocolMetric extends Record<string, unknown> {
  metric: string
}

const PREVIOUS_PROTOCOL_METRICS = process.env.RISU_PROTOCOL_METRICS
let harness: Harness
let assertion: string
let metrics: ProtocolMetric[]
let unsubscribeMetrics: () => void

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-startup-telemetry-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      requestTrace: { mode: 'agent' },
    },
    memoryWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  return { app, dataDir }
}

beforeEach(async () => {
  process.env.RISU_PROTOCOL_METRICS = '1'
  metrics = []
  unsubscribeMetrics = subscribeProtocolMetrics((metric) => metrics.push(metric as ProtocolMetric))
  harness = await startHarness()
  ;({ assertion } = await setupAuthedClient(harness.app))
})

afterEach(async () => {
  unsubscribeMetrics()
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
  if (PREVIOUS_PROTOCOL_METRICS === undefined) delete process.env.RISU_PROTOCOL_METRICS
  else process.env.RISU_PROTOCOL_METRICS = PREVIOUS_PROTOCOL_METRICS
})

function browserStartupMetrics(): ProtocolMetric[] {
  return metrics.filter((metric) => metric.metric === 'browser_startup')
}

describe('startup telemetry route', () => {
  it('advertises collection and emits only validated metadata without active-writer ownership', async () => {
    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: 'writer-a' },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().startupTelemetry).toEqual({ version: 2, sampleRate: 1 })

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/telemetry/startup',
      headers: { 'risu-auth': assertion },
      payload: {
        version: 2,
        events: [
          {
            kind: 'phase-ready',
            milestone: 'reader-ready',
            entryDurationMs: 42.5,
            attemptCount: 1,
          },
          {
            kind: 'diagnostic-failure',
            failureCode: 'plugin-initialization-failed',
            failureMilestone: 'plugins-ready',
            attemptCount: 1,
          },
        ],
      },
    })

    expect(response.statusCode).toBe(204)
    expect(browserStartupMetrics()).toEqual([
      {
        metric: 'browser_startup',
        schemaVersion: 2,
        kind: 'phase-ready',
        milestone: 'reader-ready',
        entryDurationMs: 42.5,
        attemptCount: 1,
        requestUid: response.headers['x-request-uid'],
      },
      {
        metric: 'browser_startup',
        schemaVersion: 2,
        kind: 'diagnostic-failure',
        failureCode: 'plugin-initialization-failed',
        failureMilestone: 'plugins-ready',
        attemptCount: 1,
        requestUid: response.headers['x-request-uid'],
      },
    ])
  })

  it('requires authentication and rejects unknown or content-bearing fields', async () => {
    const unauthenticated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/telemetry/startup',
      payload: { version: 2, events: [] },
    })
    expect(unauthenticated.statusCode).toBe(401)

    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/telemetry/startup',
      headers: { 'risu-auth': assertion },
      payload: {
        version: 2,
        events: [
          {
            kind: 'phase-ready',
            milestone: 'writer-ready',
            entryDurationMs: 10,
            attemptCount: 1,
            routeContent: '/characters/private-character/private-chat',
          },
        ],
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(browserStartupMetrics()).toEqual([])
  })

  it('does not advertise or emit browser metrics when protocol metrics are disabled', async () => {
    process.env.RISU_PROTOCOL_METRICS = ''
    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json()).not.toHaveProperty('startupTelemetry')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/telemetry/startup',
      headers: { 'risu-auth': assertion },
      payload: {
        version: 2,
        events: [
          {
            kind: 'attempt-completed',
            attemptDurationMs: 50,
            attemptCount: 1,
          },
        ],
      },
    })
    expect(response.statusCode).toBe(204)
    expect(browserStartupMetrics()).toEqual([])
  })
})
