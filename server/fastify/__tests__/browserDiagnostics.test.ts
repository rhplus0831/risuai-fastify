import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BROWSER_DIAGNOSTICS_ENDPOINT,
  BROWSER_DIAGNOSTICS_MAX_BYTES,
  type BrowserDiagnosticsBatch,
} from '@risuai/protocol/remote-diagnostics'
import { buildApp } from '../src/app.js'
import { createAuthState, registerSessionToken, setPassword } from '../src/auth.js'
import { assertSupportDiagnosticsConfig, loadConfig } from '../src/config.js'
import { registerBrowserDiagnosticsRoutes } from '../src/routes/browserDiagnostics.js'
import { setupAuthedClient } from './helpers/auth.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function temporaryDirectory() {
  const root = mkdtempSync(path.join(tmpdir(), 'risu-browser-diagnostics-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function batch(index = 1): BrowserDiagnosticsBatch {
  return {
    version: 1,
    sourceId: 'a'.repeat(32),
    events: [
      {
        eventId: index.toString(16).padStart(32, '0'),
        clientSequence: index,
        entry: {
          timestamp: 1,
          source: 'browser',
          level: 'error',
          correlation: 'client-asserted',
          requestUid: 'd'.repeat(64),
          category: 'runtime',
          kind: 'runtime-error',
        },
      },
    ],
  }
}

async function harness(
  options: {
    enabled?: boolean
    collection?: boolean
    bypass?: boolean
    trace?: boolean
    logging?: boolean
    dataDir?: string
    unavailable?: boolean
  } = {},
) {
  vi.stubEnv('LOG_LEVEL', options.logging ? 'info' : 'silent')
  const dataDir = options.dataDir ?? path.join(temporaryDirectory(), 'data')
  if (options.unavailable) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, 'diagnostics'), 'occupied')
  }
  const result = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      staticRoot: null,
      clientDiagnostics: options.collection ?? true,
      supportDiagnostics: { enabled: false },
      browserDiagnostics: { enabled: options.enabled ?? true },
      agentDevAuthBypass: options.bypass,
      requestTrace: options.trace ? { mode: 'agent' } : undefined,
    },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  cleanup.push(() => result.app.close())
  await result.diagnostics.ready
  return { ...result, dataDir }
}

async function routeHarness(options: { enabled?: boolean; bypass?: boolean; unavailable?: boolean } = {}) {
  const auth = createAuthState(temporaryDirectory(), { agentDevAuthBypass: options.bypass })
  setPassword(auth, 'synthetic-password')
  const token = registerSessionToken(auth)
  const app = Fastify({ logger: false })
  await app.register(rateLimit, { global: false })
  const ingest = vi.fn((input: BrowserDiagnosticsBatch) =>
    options.unavailable
      ? null
      : {
          version: 1 as const,
          accepted: input.events.length,
          duplicates: 0,
          dropped: 0,
        },
  )
  registerBrowserDiagnosticsRoutes(app, auth, { enabled: options.enabled ?? true, ingest })
  cleanup.push(() => app.close())
  await app.ready()
  return { app, ingest, headers: { 'risu-auth': token } }
}

function upload(app: FastifyInstance, payload: InjectOptions['payload'], headers: InjectOptions['headers'] = {}) {
  return app.inject({ method: 'POST', url: BROWSER_DIAGNOSTICS_ENDPOINT, headers, payload })
}

describe('browser diagnostics admission', () => {
  it('advertises only explicit supported opt-in and permits a reader without changing writer or revision', async () => {
    const h = await harness()
    const { assertion } = await setupAuthedClient(h.app)
    const headers = { 'risu-auth': assertion }
    const before = (await h.app.inject({ url: '/api/v1/bootstrap', headers })).json()
    expect(before.browserDiagnostics).toEqual({ version: 1 })
    expect(before.clientDiagnostics).toEqual({ version: 1 })
    expect((await upload(h.app, batch(), headers)).json()).toEqual({
      version: 1,
      accepted: 1,
      duplicates: 0,
      dropped: 0,
    })
    await vi.waitFor(() => expect(h.diagnostics.journal!.read().pending).toBe(0))
    const after = (await h.app.inject({ url: '/api/v1/bootstrap', headers })).json()
    expect(after.revision).toBe(before.revision)
    expect(after.writer).toEqual(before.writer)
    expect(after.writerEpoch).toBe(before.writerEpoch)
    const joined = (await h.app.inject({ url: '/api/v1/diagnostics?version=2&limit=200', headers })).json()
    expect(joined.sources).toEqual({ server: 'journal', browser: 'available' })
    expect(joined.entries).toContainEqual(
      expect.objectContaining({
        receivedAt: expect.any(Number),
        instanceId: expect.stringMatching(/^[a-f0-9]{32}$/),
        provenance: {
          kind: 'browser',
          sourceId: batch().sourceId,
          eventId: batch().events[0].eventId,
          clientSequence: 1,
        },
        entry: batch().events[0].entry,
      }),
    )
    const emptyWindow = (await h.app.inject({ url: '/api/v1/diagnostics?version=2&from=0&to=1', headers })).json()
    expect(emptyWindow.sources.browser).toBe('none')
    for (const options of [{ enabled: false }, { collection: false }]) {
      const off = await harness({ ...options, bypass: true })
      expect((await off.app.inject('/api/v1/bootstrap')).json()).not.toHaveProperty('browserDiagnostics')
      expect((await upload(off.app, batch())).json()).toEqual({ error: 'disabled' })
      expect(off.diagnostics.journal).toBeUndefined()
    }
  })

  it('deduplicates pending and retained plugin output summaries across application restart', async () => {
    const h = await harness({ bypass: true })
    const input = batch()
    input.events[0].entry = {
      timestamp: 1,
      source: 'browser',
      level: 'warn',
      correlation: 'client-asserted',
      category: 'script',
      runtime: 'plugin',
      hook: 'onOutput',
      runs: 2,
      failures: 1,
      durationMs: 12,
      comparison: 'unavailable',
    }
    input.events.push(input.events[0])
    expect((await upload(h.app, input)).json()).toEqual({ version: 1, accepted: 1, duplicates: 1, dropped: 0 })
    expect((await upload(h.app, batch())).json()).toEqual({ version: 1, accepted: 0, duplicates: 1, dropped: 0 })
    await h.app.close()
    const restarted = await harness({ dataDir: h.dataDir, bypass: true })
    expect((await upload(restarted.app, batch())).json()).toEqual({
      version: 1,
      accepted: 0,
      duplicates: 1,
      dropped: 0,
    })
    const records = restarted.diagnostics.journal!.read().entries.filter((entry) => entry.provenance.kind === 'browser')
    expect(records).toHaveLength(1)
    expect(records[0].entry).toEqual(input.events[0].entry)
  })

  it('rejects forged or content-bearing batches atomically before the sink', async () => {
    const h = await routeHarness()
    const input = batch()
    const item = input.events[0]
    for (const invalid of [
      { ...input, text: 'PRIVATE-CANARY' },
      { ...input, receivedAt: 123 },
      { ...input, events: [] },
      { ...input, events: Array(33).fill(item) },
      { ...input, events: [item, { ...item, provenance: { kind: 'server' } }] },
      ...[
        { source: 'server' },
        { correlation: 'request' },
        { operationRef: 'f'.repeat(32) },
        { attemptRef: 'f'.repeat(32) },
        { raw: 'PRIVATE-CANARY' },
      ].map((fields) => ({ ...input, events: [item, { ...item, entry: { ...item.entry, ...fields } }] })),
    ]) {
      const response = await upload(h.app, invalid, h.headers)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'invalid-batch' })
    }
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('uses ordinary authentication and denies support credentials even under development bypass', async () => {
    const token = '7c'.repeat(32)
    for (const bypass of [false, true]) {
      const h = await routeHarness({ bypass })
      for (const headers of [
        { authorization: `Bearer ${token}` },
        { 'risu-auth': token },
        { ...h.headers, authorization: `Bearer ${token}` },
      ]) {
        const response = await upload(h.app, batch(), headers)
        expect(response.statusCode).toBe(401)
        expect(response.json()).toEqual({ error: 'unauthorized' })
      }
      expect(h.ingest).not.toHaveBeenCalled()
    }
    const h = await routeHarness()
    expect((await upload(h.app, batch())).json()).toEqual({ error: 'unauthorized' })
    expect((await upload(h.app, batch(), h.headers)).statusCode).toBe(200)
  })

  it('bounds source and IP request rates and reports storage failure without blocking application reads', async () => {
    const h = await routeHarness()
    for (let index = 1; index <= 24; index++)
      expect((await upload(h.app, batch(index), h.headers)).statusCode).toBe(200)
    expect((await upload(h.app, batch(25), h.headers)).json()).toEqual({ error: 'rate-limited' })
    expect(h.ingest).toHaveBeenCalledTimes(24)
    const other = await routeHarness()
    for (let index = 1; index <= 60; index++) {
      expect(
        (await upload(other.app, { ...batch(index), sourceId: index.toString(16).padStart(32, '0') }, other.headers))
          .statusCode,
      ).toBe(200)
    }
    const limited = await upload(other.app, { ...batch(61), sourceId: 'f'.repeat(32) }, other.headers)
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toEqual({ error: 'rate-limited' })
    expect(limited.headers['cache-control']).toBe('no-store')
    const unavailable = await harness({ unavailable: true, bypass: true })
    expect((await upload(unavailable.app, batch())).json()).toEqual({ error: 'storage-unavailable' })
    expect((await unavailable.app.inject('/api/v1/bootstrap')).statusCode).toBe(200)
  })

  it('never captures rejected transport canaries in logs, traces, body sidecars or journal', async () => {
    const h = await harness({ trace: true, logging: true })
    // Capture the actual pino destination used by request-child loggers.
    let owner: object | null = h.app.log
    let stream: { write(value: string): unknown } | undefined
    while (owner && !stream) {
      const symbol = Object.getOwnPropertySymbols(owner).find((key) => key.description === 'pino.stream')
      if (symbol) stream = (owner as Record<symbol, typeof stream>)[symbol]
      owner = Object.getPrototypeOf(owner)
    }
    expect(stream).toBeDefined()
    const logs: string[] = []
    vi.spyOn(stream!, 'write').mockImplementation((value) => {
      logs.push(value)
      return true
    })
    const { assertion } = await setupAuthedClient(h.app)
    const headers = { 'risu-auth': assertion, 'content-type': 'application/json' }
    const canary = 'PRIVATE-BROWSER-TRANSPORT-CANARY'
    const supportToken = '7c'.repeat(32)
    const cases = [
      { payload: `{${canary}`, headers, status: 400 },
      { payload: { ...batch(), text: canary }, headers, status: 400 },
      { payload: canary.repeat(Math.ceil((BROWSER_DIAGNOSTICS_MAX_BYTES + 1) / canary.length)), headers, status: 413 },
      { payload: canary, headers: { ...headers, 'content-type': 'text/plain' }, status: 415 },
      { payload: canary, headers: { ...headers, 'content-encoding': 'gzip' }, status: 415 },
      {
        payload: { text: canary },
        headers: { ...headers, authorization: `Bearer ${supportToken}`, 'x-caller': canary },
        status: 401,
      },
      { payload: { text: canary }, headers: { 'content-type': 'application/json', 'risu-auth': canary }, status: 401 },
      { payload: batch(), headers, status: 400, url: `${BROWSER_DIAGNOSTICS_ENDPOINT}?raw=${canary}` },
      { payload: { text: canary }, headers, status: 404, url: `${BROWSER_DIAGNOSTICS_ENDPOINT}/${canary}` },
    ]
    for (const { status, url = BROWSER_DIAGNOSTICS_ENDPOINT, ...request } of cases) {
      const response = await h.app.inject({ method: 'POST', url, ...request })
      expect(response.statusCode).toBe(status)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.body).not.toContain(canary)
      expect(response.body).not.toContain(supportToken)
      expect(response.headers['x-request-uid']).toBeUndefined()
    }
    await vi.waitFor(() => expect(h.diagnostics.journal!.read().pending).toBe(0))
    const records = h.diagnostics.journal!.read().entries
    expect(records.filter((record) => record.entry.source === 'browser')).toEqual([])
    expect(JSON.stringify(records)).not.toContain(canary)
    expect(JSON.stringify(records)).not.toContain(supportToken)
    await h.app.close()
    const trace = readFileSync(path.join(h.dataDir, 'trace/agent.jsonl'), 'utf8')
    for (const content of [
      trace,
      logs.join('\n'),
      readFileSync(path.join(h.dataDir, 'diagnostics/journal.sqlite')).toString(),
    ]) {
      expect(content).not.toContain(canary)
      expect(content).not.toContain(supportToken)
      expect(content).not.toContain(BROWSER_DIAGNOSTICS_ENDPOINT)
    }
    expect(readdirSync(path.join(h.dataDir, 'trace'))).not.toContain('bodies')
  })
})

describe('browser diagnostics configuration', () => {
  it('defaults off and accepts only explicit numeric opt-in', () => {
    expect(loadConfig({}).browserDiagnostics).toEqual({ enabled: false })
    expect(loadConfig({ RISU_BROWSER_DIAGNOSTICS: '0' }).browserDiagnostics).toEqual({ enabled: false })
    expect(loadConfig({ RISU_BROWSER_DIAGNOSTICS: '1' }).browserDiagnostics).toEqual({ enabled: true })
    for (const value of ['', 'true', 'yes', 'PRIVATE-CANARY']) {
      expect(() => loadConfig({ RISU_BROWSER_DIAGNOSTICS: value })).toThrow('Invalid browser diagnostics configuration')
    }
  })

  it('rejects static exposure of existing and future journals including dangling symlink ancestors', () => {
    const root = temporaryDirectory()
    const dataDir = path.join(root, 'data')
    const safeRoot = path.join(root, 'public')
    mkdirSync(dataDir)
    mkdirSync(safeRoot)
    const config = { dataDir, staticRoot: safeRoot, browserDiagnostics: { enabled: true } }
    expect(() => assertSupportDiagnosticsConfig(config)).not.toThrow()
    for (const staticRoot of [root, dataDir, path.join(dataDir, 'diagnostics')]) {
      expect(() => assertSupportDiagnosticsConfig({ ...config, staticRoot })).toThrow(
        'Invalid diagnostics configuration',
      )
    }
    const linkedData = path.join(root, 'linked-data')
    symlinkSync(path.join(safeRoot, 'future-data'), linkedData)
    expect(() => assertSupportDiagnosticsConfig({ ...config, dataDir: linkedData })).toThrow(
      'Invalid diagnostics configuration',
    )
    const linkedStatic = path.join(root, 'linked-static')
    symlinkSync(path.join(dataDir, 'diagnostics'), linkedStatic)
    expect(() => assertSupportDiagnosticsConfig({ ...config, staticRoot: linkedStatic })).toThrow(
      'Invalid diagnostics configuration',
    )
    mkdirSync(path.join(dataDir, 'diagnostics'))
    expect(() => assertSupportDiagnosticsConfig({ ...config, staticRoot: linkedStatic })).toThrow(
      'Invalid diagnostics configuration',
    )
    expect(() =>
      assertSupportDiagnosticsConfig({ ...config, staticRoot: dataDir, browserDiagnostics: { enabled: false } }),
    ).not.toThrow()
  })
})
