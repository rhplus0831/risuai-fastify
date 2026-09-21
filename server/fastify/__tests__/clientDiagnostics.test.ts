import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createClientDiagnostics } from '../src/clientDiagnostics.js'
import { emitProtocolMetric, protocolMetricsEnabled } from '../src/protocolMetrics.js'
import { readRequestTraceUid } from '../src/requestTrace.js'
import { setupAuthedClient } from './helpers/auth.js'
import { DIAGNOSTICS_LIMIT, isDiagnosticsResponse } from '@risuai/protocol/diagnostics'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function harness(enabled: boolean) {
  vi.stubEnv('LOG_LEVEL', 'silent')
  vi.stubEnv('RISU_PROTOCOL_METRICS', '')
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-diagnostics-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      clientDiagnostics: enabled,
    },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  cleanup.push(async () => {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return app
}

describe('client diagnostics', () => {
  it('defaults off, follows both development trace modes, and accepts an explicit override', () => {
    expect(loadConfig({}).clientDiagnostics).toBe(false)
    for (const mode of ['human', 'agent']) {
      expect(loadConfig({ RISU_API_TRACE_MODE: mode }).clientDiagnostics).toBe(true)
      expect(loadConfig({ RISU_API_TRACE_MODE: mode, RISU_CLIENT_DIAGNOSTICS: '0' }).clientDiagnostics).toBe(false)
    }
    for (const flag of ['1', 'true', 'yes', 'on'])
      expect(loadConfig({ RISU_CLIENT_DIAGNOSTICS: flag }).clientDiagnostics).toBe(true)
  })

  it('requires authentication and advertises only enabled collection', async () => {
    const app = await harness(false)
    const { assertion } = await setupAuthedClient(app)
    const denied = await app.inject('/api/v1/diagnostics')
    expect(denied.statusCode).toBe(401)
    expect(denied.headers['cache-control']).toBe('no-store')
    const headers = { 'risu-auth': assertion }
    const response = await app.inject({ url: '/api/v1/diagnostics', headers })
    expect(response.json()).toEqual({ version: 1, enabled: false, entries: [] })
    const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers })
    expect(bootstrap.json().clientDiagnostics).toBeUndefined()
    expect(bootstrap.headers['x-request-uid']).toBeUndefined()
  })

  it(
    'exposes useful request/error metadata without bodies, URLs, credentials, or free text',
    { tags: 'core' },
    async () => {
      const app = await harness(true)
      const privateText = 'PRIVATE-PROMPT-MESSAGE-SECRET'
      app.post('/api/v1/diagnostic-test/:id', async () => {
        throw new TypeError(privateText)
      })
      const { assertion } = await setupAuthedClient(app)
      const headers = { 'risu-auth': assertion }
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/diagnostic-test/${privateText}?key=${privateText}`,
        headers: { ...headers, 'x-api-key': privateText, 'x-request-uid': privateText },
        payload: { prompt: privateText, message: privateText },
      })
      expect(response.statusCode).toBe(500)
      const uid = response.headers['x-request-uid']
      expect(uid).toMatch(/^[a-f0-9]{64}$/)
      const result = await app.inject({ url: '/api/v1/diagnostics', headers })
      expect(result.headers['cache-control']).toBe('no-store')
      expect(isDiagnosticsResponse(result.json())).toBe(true)
      expect(result.body).not.toContain(privateText)
      expect(result.body).not.toContain(assertion)
      expect(result.json().entries).toContainEqual(
        expect.objectContaining({ event: 'http', statusCode: 500, requestUid: uid, routeId: 'unknown' }),
      )
      expect(result.json().entries).toContainEqual(
        expect.objectContaining({ event: 'runtime-error', errorName: 'TypeError', requestUid: uid }),
      )
      const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers })
      expect(bootstrap.json().clientDiagnostics).toEqual({ version: 1 })
    },
  )

  it('captures selected correlated metrics without enabling raw protocol output or leaking between app instances', async () => {
    const app = await harness(true)
    const other = await harness(true)
    app.get('/api/v1/diagnostic-test', async (request) => {
      emitProtocolMetric('generation_persistence', {
        requestUid: readRequestTraceUid(request),
        status: 'error',
        durationMs: 21,
        prompt: 'PRIVATE-TEXT',
        error: 'PRIVATE-TEXT',
        characterId: 'PRIVATE-TEXT',
      })
      return {}
    })
    const { assertion } = await setupAuthedClient(app)
    const { assertion: otherAssertion } = await setupAuthedClient(other)
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    const response = await app.inject('/api/v1/diagnostic-test')
    const first = (await app.inject({ url: '/api/v1/diagnostics', headers: { 'risu-auth': assertion } })).json()
    expect(first.entries).toContainEqual(
      expect.objectContaining({ metric: 'generation_persistence', outcome: 'error', durationMs: 21 }),
    )
    expect(JSON.stringify(first)).not.toContain('PRIVATE-TEXT')
    const second = (await other.inject({ url: '/api/v1/diagnostics', headers: { 'risu-auth': otherAssertion } })).json()
    expect(JSON.stringify(second)).not.toContain(response.headers['x-request-uid'])
    expect(protocolMetricsEnabled()).toBe(false)
    expect(output).not.toHaveBeenCalled()
  })

  it('bounds runtime logs and projects data again when returning snapshots', () => {
    const recorder = createClientDiagnostics(true)
    for (let i = 0; i < DIAGNOSTICS_LIMIT + 10; i++)
      recorder.record({ event: 'http', level: 'info', durationMs: i, message: 'PRIVATE' })
    const events = recorder.snapshot()
    expect(events).toHaveLength(DIAGNOSTICS_LIMIT)
    expect(events[0].durationMs).toBe(10)
    events[0].durationMs = 99_999
    expect(recorder.snapshot()[0].durationMs).toBe(10)
    recorder.recordLog([{ err: new Error('PRIVATE'), prompt: 'PRIVATE' }, 'PRIVATE'], 50)
    expect(recorder.snapshot().at(-1)).toMatchObject({ level: 'error', event: 'console', errorName: 'Error' })
    expect(JSON.stringify(recorder.snapshot())).not.toContain('PRIVATE')
  })
})
