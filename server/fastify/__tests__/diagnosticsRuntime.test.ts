import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClientDiagnostics, registerClientDiagnosticsHooks } from '../src/clientDiagnostics.js'
import { createDiagnosticsRuntime } from '../src/diagnosticsRuntime.js'
import { openDatabase, getSchemaState } from '../src/db.js'
import { rotateDatabaseLineage } from '../src/databaseLineage.js'
import { recordDiagnosticEvent, runWithDiagnosticContext } from '../src/diagnosticContext.js'
import { emitProtocolMetric } from '../src/protocolMetrics.js'
import { createRemoteDiagnosticsReader } from '../src/remoteDiagnostics.js'
import { parseRemoteDiagnosticsQuery } from '@risuai/protocol/remote-diagnostics'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

async function harness(blockStorage = false, build = 'unknown') {
  vi.stubEnv('RISU_PROTOCOL_METRICS', '')
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-diagnostics-runtime-'))
  const db = openDatabase(dataDir)
  if (blockStorage) writeFileSync(path.join(dataDir, 'diagnostics'), 'private fixture obstruction')
  const app = Fastify({ logger: false })
  const collector = createClientDiagnostics(true)
  registerClientDiagnosticsHooks(app, collector)
  const runtime = createDiagnosticsRuntime(
    app,
    db,
    {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://example.invalid',
      clientDiagnostics: true,
      supportDiagnostics: { enabled: true },
    },
    collector,
    { instanceId: 'ab'.repeat(16), build },
  )
  cleanup.push(async () => {
    await runtime.close()
    await app.close()
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  await runtime.ready
  const settled = async () => {
    await vi.waitFor(() => expect(runtime.journal!.read().pending).toBe(0))
  }
  return { app, db, collector, runtime, settled }
}

describe('diagnostics runtime isolation from application authority', () => {
  it('exports sanitized application frames only for the matching known build and only in v3', async () => {
    const build = 'c'.repeat(40)
    const h = await harness(false, build)
    const canary = 'PRIVATE_RUNTIME_ERROR_MESSAGE_CANARY'
    h.app.get('/api/v1/build-bound-frame', async () => {
      const error = new Error(canary)
      error.stack = `Error: ${canary}\n    at handler (/deploy/server/fastify/src/app.ts:12:3)\n    at plugin (/private/plugin.ts:9:1)`
      throw error
    })
    const failure = await h.app.inject('/api/v1/build-bound-frame')
    await h.settled()
    const identity = { build, instanceId: 'ab'.repeat(16) }
    const reader = createRemoteDiagnosticsReader(h.runtime.source, identity)
    const requestUid = failure.headers['x-request-uid']
    const v3 = reader.read(parseRemoteDiagnosticsQuery({ version: '3', requestUid })!)
    const v2 = reader.read(parseRemoteDiagnosticsQuery({ version: '2', requestUid })!)
    if (typeof v3 === 'string' || typeof v2 === 'string') throw new Error('unexpected diagnostic error')
    if (v3.version !== 3 || v2.version !== 2) throw new Error('unexpected diagnostic version')
    const runtime = v3.entries.find((record) => record.entry.category === 'runtime')
    expect(runtime).toMatchObject({
      entry: { errorName: 'Error' },
      facts: [{ id: 'runtime.location.0', type: 'location', value: 'server/fastify/src/app.ts:12:3' }],
    })
    expect(JSON.stringify(v2)).not.toContain('facts')
    expect(JSON.stringify(v3)).not.toContain(canary)
    expect(JSON.stringify(v3)).not.toContain('plugin.ts')

    const unknown = await harness()
    unknown.collector.record({
      event: 'runtime-error',
      level: 'error',
      errorName: 'TypeError',
      locations: ['server/fastify/src/app.ts:12:3'],
    })
    await unknown.settled()
    const unknownReader = createRemoteDiagnosticsReader(unknown.runtime.source, {
      build: 'unknown',
      instanceId: 'ab'.repeat(16),
    })
    const unknownV3 = unknownReader.read(parseRemoteDiagnosticsQuery({ version: '3' })!)
    if (typeof unknownV3 === 'string') throw new Error(unknownV3)
    if (unknownV3.version !== 3) throw new Error('unexpected diagnostic version')
    expect(JSON.stringify(unknownV3)).not.toContain('location')
  })

  it('retains scoped metrics after the original request leaves the 2000 UID recognition window', async () => {
    const h = await harness()
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.app.get('/api/v1/held', async () => {
      started()
      await gate
      emitProtocolMetric('generation_persistence', { status: 'error', durationMs: 17, prompt: 'PRIVATE-CANARY' })
      return { done: true }
    })
    h.app.get('/api/v1/noop', async () => ({}))
    const held = h.app.inject('/api/v1/held').then((response) => response)
    await entered
    for (let index = 0; index < 2001; index++) await h.app.inject('/api/v1/noop')
    await h.settled()
    release()
    const response = await held
    await h.settled()
    const evidence = h.runtime.source.read().entries
    expect(evidence).toContainEqual(
      expect.objectContaining({
        entry: expect.objectContaining({
          category: 'legacy',
          requestUid: response.headers['x-request-uid'],
          detail: expect.objectContaining({ metric: 'generation_persistence', outcome: 'error', durationMs: 17 }),
        }),
      }),
    )
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE-CANARY')
  })

  it('invalidates old cursors, retained provenance and stale async scopes when authoritative history changes', async () => {
    const h = await harness()
    const before = getSchemaState(h.db)
    const event = { category: 'generation', stage: 'recovery', outcome: 'completed', providerMayHaveRun: true }
    for (let index = 0; index < 3; index++)
      runWithDiagnosticContext(h.db, { operationId: `private-${index}` }, () => recordDiagnosticEvent(event))
    await h.settled()
    const reader = createRemoteDiagnosticsReader(h.runtime.source, { build: 'unknown', instanceId: 'ab'.repeat(16) })
    const first = reader.read(parseRemoteDiagnosticsQuery({ version: '2', limit: '1' })!)
    if (typeof first === 'string') throw new Error(first)
    const cursor = first.pagination.nextCursor!
    expect(cursor).toMatch(/^[a-f0-9]{32}$/)
    const previousEpoch = h.runtime.source.read().epoch
    runWithDiagnosticContext(h.db, { operationId: 'private-stale' }, () => {
      rotateDatabaseLineage(h.db)
      recordDiagnosticEvent(event)
    })
    await h.settled()
    await vi.waitFor(() => expect(h.runtime.source.read().source).toBe('journal'))
    expect(h.runtime.source.read().epoch).not.toBe(previousEpoch)
    expect(reader.read(parseRemoteDiagnosticsQuery({ version: '2', cursor })!)).toBe('cursor-expired')
    expect(h.runtime.source.read().entries.every((record) => !('operationRef' in record.entry))).toBe(true)
    expect(h.collector.snapshot()).toEqual([])
    expect(getSchemaState(h.db)).toEqual(before)
  })

  it('keeps successful application work and revisions independent of unavailable diagnostic storage', async () => {
    const h = await harness(true)
    const before = getSchemaState(h.db)
    h.app.get('/api/v1/success', async () => {
      recordDiagnosticEvent({
        category: 'generation',
        stage: 'complete',
        outcome: 'completed',
        providerMayHaveRun: false,
      })
      return { success: true }
    })
    expect((await h.app.inject('/api/v1/success')).json()).toEqual({ success: true })
    expect(h.runtime.source.read().source).toBe('unavailable')
    expect(getSchemaState(h.db)).toEqual(before)
    const reader = createRemoteDiagnosticsReader(h.runtime.source, { build: 'unknown', instanceId: 'ab'.repeat(16) })
    expect(reader.read(parseRemoteDiagnosticsQuery({ version: '2' })!)).toBe('storage-unavailable')
  })
})
