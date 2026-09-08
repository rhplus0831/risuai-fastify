import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  isRemoteDiagnosticsResponse,
  parseRemoteDiagnosticsQuery,
  SUPPORT_DIAGNOSTICS_ENDPOINT,
} from '@risuai/protocol/remote-diagnostics'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { applyImport } from '../src/repository.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { assertSupportDiagnosticsConfig, loadConfig } from '../src/config.js'
import { createClientDiagnostics } from '../src/clientDiagnostics.js'
import { createRemoteDiagnosticsReader, createVolatileRemoteDiagnostics } from '../src/remoteDiagnostics.js'
import { findProtocolRouteDecision } from '../src/routeManifest.js'
import { parseRouteTree } from './helpers/routeCatalog.js'
import { setupAuthedClient } from './helpers/auth.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function harness(options: { enabled?: boolean; collection?: boolean; bypass?: boolean; trace?: boolean } = {}) {
  vi.stubEnv('LOG_LEVEL', 'silent')
  const root = mkdtempSync(path.join(tmpdir(), 'risu-remote-diagnostics-'))
  const dataDir = path.join(root, 'data')
  const privateDir = path.join(root, 'private')
  mkdirSync(privateDir, { mode: 0o700 })
  const verifierFile = path.join(privateDir, 'verifier.json')
  const token = '7c'.repeat(32)
  const credential = {
    id: 'ab'.repeat(16),
    digest: createHash('sha256').update(token).digest('hex'),
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 86_400_000,
    revokedAt: null,
  }
  const save = () => {
    writeFileSync(verifierFile, JSON.stringify({ version: 1, credentials: [credential] }), { mode: 0o600 })
    chmodSync(verifierFile, 0o600)
  }
  save()
  const { app, diagnostics } = await buildApp({
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
      supportDiagnostics: { enabled: options.enabled ?? true, verifierFile },
      agentDevAuthBypass: options.bypass,
      requestTrace: options.trace ? { mode: 'agent' } : undefined,
    },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  await diagnostics.ready
  cleanup.push(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    app,
    diagnostics,
    root,
    dataDir,
    verifierFile,
    token,
    credential,
    save,
    headers: { authorization: `Bearer ${token}` },
  }
}

describe('remote support diagnostics', () => {
  it('negotiates joined manual v2 reads with ordinary app auth while preserving exact v1 fallback', async () => {
    const h = await harness()
    const { assertion } = await setupAuthedClient(h.app)
    await vi.waitFor(() => expect(h.diagnostics.journal!.read().pending).toBe(0))
    const headers = { 'risu-auth': assertion }
    const legacy = (await h.app.inject({ url: '/api/v1/diagnostics', headers })).json()
    expect(legacy.version).toBe(1)
    expect(legacy.enabled).toBe(true)
    const joined = await h.app.inject({ url: '/api/v1/diagnostics?version=2&limit=200', headers })
    expect(joined.statusCode).toBe(200)
    expect(joined.json().version).toBe(2)
    expect(isRemoteDiagnosticsResponse(joined.json())).toBe(true)
    expect(joined.json().sources.server).toBe('journal')
    expect((await h.app.inject({ url: '/api/v1/diagnostics?version=2', headers: h.headers })).statusCode).toBe(401)
    const invalid = await h.app.inject({ url: '/api/v1/diagnostics?version=2&raw=PRIVATE-MANUAL-CANARY', headers })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toEqual({ error: 'invalid-query' })
  })

  it('requires independent explicit enablement and valid credentials in every application auth state', async () => {
    const h = await harness()
    expect((await h.app.inject(SUPPORT_DIAGNOSTICS_ENDPOINT)).statusCode).toBe(401)
    expect((await h.app.inject({ url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: h.headers })).statusCode).toBe(200)
    const { assertion } = await setupAuthedClient(h.app)
    expect(
      (await h.app.inject({ url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: { 'risu-auth': assertion } })).statusCode,
    ).toBe(401)
    h.credential.revokedAt = Date.now() as never
    h.save()
    expect((await h.app.inject({ url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: h.headers })).statusCode).toBe(401)
    h.credential.revokedAt = null
    h.credential.expiresAt = Date.now() - 1
    h.save()
    expect((await h.app.inject({ url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: h.headers })).statusCode).toBe(401)
    const bypass = await harness({ bypass: true })
    expect((await bypass.app.inject(SUPPORT_DIAGNOSTICS_ENDPOINT)).statusCode).toBe(401)
    const off = await harness({ enabled: false })
    expect((await off.app.inject({ url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: off.headers })).json()).toEqual({
      error: 'disabled',
    })
    const noCollection = await harness({ collection: false })
    expect(
      (await noCollection.app.inject({ url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: noCollection.headers })).json(),
    ).toEqual({ error: 'collection-disabled' })
  })

  it('grants no access through ordinary authentication on every protected route', async () => {
    const h = await harness()
    await setupAuthedClient(h.app)
    const failures: string[] = []
    await h.app.ready()
    const routes = parseRouteTree(h.app.printRoutes({ commonPrefix: false }))
    for (const route of routes) {
      const decision = findProtocolRouteDecision(route.method, route.path)
      if (decision?.auth.decision !== 'required') continue
      const url = route.path.replace(/:[^/]+/g, 'x').replace(/\*/g, 'x')
      const method = route.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
      const response = await h.app.inject({
        method,
        url,
        headers: { ...h.headers, 'risu-auth': h.token },
        ...(['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? { payload: {} } : {}),
      })
      if (response.statusCode !== 401) failures.push(`${method} ${decision.id}: ${response.statusCode}`)
    }
    expect(failures).toEqual([])
    expect((await h.app.inject({ url: '/api/v1/health', headers: h.headers })).statusCode).toBe(200)
  })

  it('returns useful projected metadata and fixed errors with no raw transport artifacts', async () => {
    const h = await harness({ trace: true })
    const canary = 'PRIVATE-CONTENT-CREDENTIAL-CANARY'
    h.app.get('/api/v1/diagnostic-failure', async () => {
      throw new Error(canary)
    })
    const failure = await h.app.inject('/api/v1/diagnostic-failure')
    await vi.waitFor(() => expect(h.diagnostics.journal?.read().pending).toBe(0))
    const result = await h.app.inject({ url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: h.headers })
    expect(isRemoteDiagnosticsResponse(result.json())).toBe(true)
    expect(result.json().sources).toEqual({ server: 'journal', browser: 'not-supported' })
    expect(result.json().entries).toContainEqual(
      expect.objectContaining({
        entry: expect.objectContaining({
          event: 'http',
          statusCode: 500,
          requestUid: failure.headers['x-request-uid'],
        }),
      }),
    )
    expect(result.body).not.toContain(canary)
    expect(result.body).not.toContain(h.token)
    const badRequests = [
      { url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?raw=${canary}`, headers: h.headers },
      { url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: { authorization: `Bearer ${canary}`, 'x-caller': canary } },
      { url: `/api/v1/support/${canary}`, method: 'POST' as const, headers: h.headers, payload: { text: canary } },
      { url: '/api/v1/diagnostics/browser', method: 'POST' as const, headers: h.headers, payload: `{${canary}` },
      { url: SUPPORT_DIAGNOSTICS_ENDPOINT, method: 'HEAD' as const, headers: h.headers },
    ]
    for (const request of badRequests) {
      const response = await h.app.inject(request)
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.body).not.toContain(canary)
    }
    // Baseline trace retains operator-only errors. Remove that evidence before
    // isolating diagnostic transport requests; their raw inputs must be absent.
    await h.app.close()
    const trace = readFileSync(path.join(h.dataDir, 'trace/agent.jsonl'), 'utf8')
    expect(trace).not.toContain('/api/v1/support')
    expect(trace).not.toContain('/api/v1/diagnostics/browser')
    expect(trace).not.toContain(h.token)
    expect(readdirSync(path.join(h.dataDir, 'trace'))).not.toContain('bodies')
  })

  it('reports content-free display scope decode details for remote diagnosis', async () => {
    const h = await harness()
    const { assertion } = await setupAuthedClient(h.app)
    const db = openDatabase(h.dataDir)
    const privateValue = 'PRIVATE-DISPLAY-VALIDATION-CANARY'
    let revision: number
    try {
      const imported = await applyImport(
        db,
        h.dataDir,
        normalizeRisuSaveSnapshotDatabase({
          characters: [
            {
              chaId: 'diagnostic-character',
              name: 'Diagnostic character',
              chats: [
                {
                  id: 'diagnostic-chat',
                  message: [{ role: 'char', data: 'hello', chatId: 'diagnostic-message' }],
                },
              ],
            },
          ],
        }),
      )
      revision = imported.revision
      const row = db.prepare('SELECT data_json FROM characters WHERE id = ?').get('diagnostic-character') as {
        data_json: string
      }
      const character = JSON.parse(row.data_json) as Record<string, unknown>
      character.prebuiltAssetCommand = { privateValue }
      db.prepare('UPDATE characters SET data_json = ? WHERE id = ?').run(
        JSON.stringify(character),
        'diagnostic-character',
      )
    } finally {
      db.close()
    }

    const source = 'hello'
    const payload = {
      protocolVersion: 1,
      baseRevision: revision,
      context: { pageSessionId: 'diagnostic-page' },
      targets: [
        {
          requestKey: 'diagnostic-request',
          characterId: 'diagnostic-character',
          messageId: 'diagnostic-message',
          index: 0,
          role: 'char',
          firstMessage: false,
          layer: 'original',
          source,
          sourceHash: createHash('sha256').update(source).digest('hex'),
          projectionEpoch: 1,
        },
      ],
    }
    const failure = await h.app.inject({
      method: 'POST',
      url: '/api/v1/chats/diagnostic-chat/display-sources',
      headers: { 'risu-auth': assertion },
      payload,
    })
    expect(failure.statusCode).toBe(500)
    expect(failure.json()).toEqual({ error: 'display_source_transform_failed' })

    await vi.waitFor(() => expect(h.diagnostics.journal!.read().pending).toBe(0))
    const evidence = await h.app.inject({
      url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?version=2&category=display&requestUid=${failure.headers['x-request-uid']}`,
      headers: h.headers,
    })
    expect(evidence.statusCode).toBe(200)
    expect(isRemoteDiagnosticsResponse(evidence.json())).toBe(true)
    expect(evidence.json().entries).toContainEqual(
      expect.objectContaining({
        entry: expect.objectContaining({
          source: 'server',
          category: 'display',
          stage: 'scope-decode',
          outcome: 'failed',
          failureKind: 'generation-input-validation',
          validationDomain: 'database',
          validationOwner: 'character',
          validationFieldRef: createHash('sha256')
            .update('generation-input-field:prebuiltAssetCommand')
            .digest('hex')
            .slice(0, 16),
          validationRule: 'type',
          valueKind: 'object',
          requestUid: failure.headers['x-request-uid'],
        }),
      }),
    )
    expect(evidence.body).not.toContain(privateValue)
    expect(evidence.body).not.toContain('diagnostic-character')
    expect(evidence.body).not.toContain('diagnostic-chat')
    expect(evidence.body).not.toContain('diagnostic-message')

    const malformedCanary = 'PRIVATE-DISPLAY-MALFORMED-JSON-CANARY'
    const malformedDb = openDatabase(h.dataDir)
    try {
      malformedDb.exec('PRAGMA ignore_check_constraints = ON')
      malformedDb
        .prepare('UPDATE characters SET data_json = ? WHERE id = ?')
        .run(`{"private":"${malformedCanary}"`, 'diagnostic-character')
    } finally {
      malformedDb.close()
    }
    const malformedFailure = await h.app.inject({
      method: 'POST',
      url: '/api/v1/chats/diagnostic-chat/display-sources',
      headers: { 'risu-auth': assertion },
      payload,
    })
    expect(malformedFailure.statusCode).toBe(500)
    await vi.waitFor(() => expect(h.diagnostics.journal!.read().pending).toBe(0))
    const malformedEvidence = await h.app.inject({
      url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?version=2&category=display&requestUid=${malformedFailure.headers['x-request-uid']}`,
      headers: h.headers,
    })
    expect(malformedEvidence.json().entries).toContainEqual(
      expect.objectContaining({
        entry: expect.objectContaining({
          category: 'display',
          stage: 'scope-load',
          outcome: 'failed',
          failureKind: 'malformed-persistence',
          requestUid: malformedFailure.headers['x-request-uid'],
        }),
      }),
    )
    expect(malformedEvidence.body).not.toContain(malformedCanary)
  })

  it('distinguishes bad query, empty result, expired cursor and effective throttling', async () => {
    const h = await harness()
    for (const query of ['raw=true', 'limit=201', 'limit=1&limit=2', 'version=3', 'from=0&to=86400001']) {
      const response = await h.app.inject({ url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?${query}`, headers: h.headers })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'invalid-query' })
    }
    const empty = await h.app.inject({ url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?from=0&to=1`, headers: h.headers })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().entries).toEqual([])
    expect(
      (await h.app.inject({ url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?cursor=${'0'.repeat(32)}`, headers: h.headers }))
        .statusCode,
    ).toBe(410)
    let response = empty
    for (let i = 0; i < 30; i++)
      response = await h.app.inject({ url: SUPPORT_DIAGNOSTICS_ENDPOINT, headers: h.headers })
    expect(response.statusCode).toBe(429)
    expect(response.json()).toEqual({ error: 'rate-limited' })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('keeps immutable sequence pages during appends and bounds volatile loss and cursor lifetime', () => {
    const collector = createClientDiagnostics(true)
    const source = createVolatileRemoteDiagnostics(collector, 'a'.repeat(32))
    const reader = createRemoteDiagnosticsReader(source, { build: 'unknown', instanceId: 'a'.repeat(32) })
    for (let i = 0; i < 310; i++) collector.record({ event: 'http', level: 'info', durationMs: i })
    const query = parseRemoteDiagnosticsQuery({ limit: '100' })!
    const first = reader.read(query)
    if (typeof first === 'string') throw new Error(first)
    expect(first.loss.dropped).toBe(10)
    expect(first.entries[0].sequence).toBe(11)
    collector.record({ event: 'http', level: 'info' })
    const cursor = first.pagination.nextCursor!
    const next = reader.read(parseRemoteDiagnosticsQuery({ cursor })!)
    if (typeof next === 'string') throw new Error(next)
    expect(next.entries[0].sequence).toBe(111)
    expect(next.pagination.snapshotSequence).toBe(310)
    expect(reader.read(parseRemoteDiagnosticsQuery({ cursor })!)).toMatchObject({ entries: next.entries })
    // Reader closes over the original clock function; separate controlled clock
    // proves expiration without relying on mutated global function references.
    let clock = 10
    const expiring = createRemoteDiagnosticsReader(
      source,
      { build: 'unknown', instanceId: 'a'.repeat(32) },
      () => clock,
    )
    const before = expiring.read(query)
    if (typeof before === 'string') throw new Error(before)
    clock += 300_001
    expect(expiring.read(parseRemoteDiagnosticsQuery({ cursor: before.pagination.nextCursor! })!)).toBe(
      'cursor-expired',
    )
  })

  it('rejects invalid enablement and verifier locations in application-owned trees', () => {
    expect(loadConfig({}).supportDiagnostics?.enabled).toBe(false)
    expect(() => loadConfig({ RISU_SUPPORT_DIAGNOSTICS: 'true' })).toThrow('Invalid support diagnostics configuration')
    expect(() => loadConfig({ RISU_SUPPORT_DIAGNOSTICS: '1' })).toThrow('Invalid support diagnostics configuration')
    for (const verifierFile of [
      path.join(process.cwd(), 'private/verifier.json'),
      '/tmp/risu-data/secrets.json',
      '/tmp/risu-static/secrets.json',
    ]) {
      expect(() =>
        assertSupportDiagnosticsConfig({
          dataDir: '/tmp/risu-data',
          staticRoot: '/tmp/risu-static',
          supportDiagnostics: { enabled: true, verifierFile },
        }),
      ).toThrow()
    }
  })
})
