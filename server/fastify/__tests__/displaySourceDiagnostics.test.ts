import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'
import type { DisplaySourceRequest } from '@risuai/protocol/display-source'
import { openDatabase } from '../src/db.js'
import { applyImport, loadPersistedForDisplaySource } from '../src/repository.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { registerDiagnosticDatabase, runWithDiagnosticContext } from '../src/diagnosticContext.js'
import { DisplaySourceService } from '../src/displaySourceService.js'
import { DisplaySourceCache } from '../src/displaySourceCache.js'
import {
  beginDisplaySourceDiagnostics,
  DisplaySourceDiagnostics,
  parseDisplaySourceJson,
  readDisplaySourceData,
} from '../src/displaySourceDiagnostics.js'
import * as metrics from '../src/protocolMetrics.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('retains request association and queue time for an aborted queued batch without running its stages', async () => {
  vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
  const dataDir = mkdtempSync(path.join(tmpdir(), 'display-diagnostics-'))
  const db = openDatabase(dataDir)
  let unregister = () => {}
  let release = () => {}
  try {
    const { revision } = await applyImport(
      db,
      dataDir,
      normalizeRisuSaveSnapshotDatabase({
        characters: [
          {
            chaId: 'char',
            name: 'Character',
            chats: [{ id: 'chat', message: [{ role: 'char', data: 'hello', chatId: 'message' }] }],
          },
        ],
      }),
    )
    const events: DiagnosticEventV2[] = []
    unregister = registerDiagnosticDatabase(db, { history: () => 'synthetic', record: (entry) => events.push(entry) })
    const cache = new DisplaySourceCache()
    const originalResolve = cache.resolve.bind(cache)
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.spyOn(cache, 'resolve').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return originalResolve(...args)
    })
    const service = new DisplaySourceService({ db, dataDir, cache })
    const request: DisplaySourceRequest = {
      protocolVersion: 1,
      baseRevision: revision,
      context: { pageSessionId: 'page' },
      priorityKeys: ['target'],
      targets: [
        {
          requestKey: 'target',
          characterId: 'char',
          messageId: 'message',
          index: 0,
          role: 'char',
          firstMessage: false,
          layer: 'original',
          source: 'hello',
          sourceHash: createHash('sha256').update('hello').digest('hex'),
          projectionEpoch: 0,
        },
      ],
    }
    const first = runWithDiagnosticContext(db, { requestUid: 'a'.repeat(64) }, () =>
      service.transformBatch('chat', request),
    )
    await started
    const controller = new AbortController()
    const queued = runWithDiagnosticContext(db, { requestUid: 'b'.repeat(64) }, () =>
      service.transformBatch('chat', request, controller.signal),
    )
    const rejected = expect(queued).rejects.toThrow('cancelled')
    controller.abort(new Error('cancelled'))
    expect(events.filter((entry) => entry.category === 'display-performance')).toHaveLength(0)
    release()
    const firstResponse = await first
    await rejected
    const summaries = events
      .filter((entry) => entry.category === 'display-performance')
      .sort((a, b) => (a.requestUid ?? '').localeCompare(b.requestUid ?? ''))
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      requestUid: 'a'.repeat(64),
      outcome: 'ok',
      cacheMissCount: 1,
      priorityTargetCount: 1,
      timeToFirstResultMs: expect.any(Number),
      timeToPriorityResultsMs: expect.any(Number),
    })
    expect(summaries[1]).toMatchObject({
      requestUid: 'b'.repeat(64),
      outcome: 'aborted',
      queueDepth: 1,
      queueWaitMs: expect.any(Number),
      visitedTargetCount: 0,
      executedTargetCount: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
      timings: {},
    })
    expect(summaries[1].queueWaitMs).toBeGreaterThan(0)
    expect(summaries[1].resultCounts).toBeUndefined()
    expect(summaries[1].timeToFirstTransformMs).toBeUndefined()
    expect(summaries[1].preparation).toBeUndefined()
    await runWithDiagnosticContext(db, { requestUid: 'c'.repeat(64) }, () => service.transformBatch('chat', request))
    expect(events.filter((entry) => entry.category === 'display-performance').at(-1)).toMatchObject({
      requestUid: 'c'.repeat(64),
      outcome: 'ok',
      cacheHitCount: 1,
    })
    unregister()
    const unmeasured = await new DisplaySourceService({ db, dataDir }).transformBatch('chat', request)
    expect(unmeasured).toEqual(firstResponse)
    const diagnostics = new DisplaySourceDiagnostics(1, 0, 0)
    const beforeRevision = request.baseRevision
    const measuredScope = loadPersistedForDisplaySource(
      db,
      dataDir,
      { chatId: 'chat', characterId: 'char' },
      diagnostics,
    )
    expect(measuredScope).toEqual(loadPersistedForDisplaySource(db, dataDir, { chatId: 'chat', characterId: 'char' }))
    expect(service.currentRevision()).toBe(beforeRevision)
  } finally {
    release()
    unregister()
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('does not create performance capture outside an enabled diagnostic context', () => {
  vi.stubEnv('RISU_PROTOCOL_METRICS', '1')
  expect(beginDisplaySourceDiagnostics(1, 0, 0)).toBeUndefined()
  const clock = vi.spyOn(metrics, 'protocolNowMs')
  expect(readDisplaySourceData(undefined, () => parseDisplaySourceJson('{"ok":true}'))).toEqual({ ok: true })
  expect(clock).not.toHaveBeenCalled()
})

it('retains reached read/parse measurements on failure without retaining content or replacing errors', () => {
  const diagnostics = new DisplaySourceDiagnostics(1, 0, 0)
  const load = diagnostics.load('modules')
  const failure = new Error('PRIVATE-DATABASE-ERROR')
  expect(() =>
    load.read(() => {
      throw failure
    }),
  ).toThrow(failure)
  expect(() => load.parse('PRIVATE-MALFORMED-JSON')).toThrow(SyntaxError)
  expect(diagnostics.preparation.loads?.modules).toMatchObject({
    readMs: expect.any(Number),
    parseMs: expect.any(Number),
    jsonValues: 1,
    jsonSize: 'up-to-4KiB',
  })
  expect(diagnostics.preparation.dependencyHashMs).toBeUndefined()
  expect(JSON.stringify(diagnostics.preparation)).not.toContain('PRIVATE')
})

it('buckets cumulative UTF-8 payload sizes without serializing parsed values', () => {
  const diagnostics = new DisplaySourceDiagnostics(1, 0, 0)
  const load = diagnostics.load('modules')
  const stringify = vi.spyOn(JSON, 'stringify')
  const source = '"' + '한'.repeat(700) + '"'
  load.parse(source)
  expect(diagnostics.preparation.loads?.modules?.jsonSize).toBe('up-to-4KiB')
  load.parse(source)
  expect(diagnostics.preparation.loads?.modules).toMatchObject({ jsonValues: 2, jsonSize: 'up-to-64KiB' })
  expect(stringify).not.toHaveBeenCalled()
})

it('preserves accumulated sub-millisecond work when formatting the final measurements', () => {
  let now = 0
  vi.spyOn(metrics, 'protocolNowMs').mockImplementation(() => now)
  const diagnostics = new DisplaySourceDiagnostics(1, 0, 0)
  const load = diagnostics.load('modules')
  for (let index = 0; index < 10; index++)
    load.read(() => {
      now += 0.003
    })
  diagnostics.finish(undefined, false)
  expect(diagnostics.preparation.loads?.modules?.readMs).toBe(0.03)
})

it('identifies legacy fallback separately without inventing selected-row measurements', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'display-legacy-measurement-'))
  const db = openDatabase(dataDir)
  try {
    db.prepare('INSERT OR REPLACE INTO settings (id, data_json) VALUES (1, ?)').run(
      JSON.stringify({
        characters: [{ chaId: 'char', chats: [{ id: 'chat', message: [{ role: 'char', data: 'hello' }] }] }],
      }),
    )
    const diagnostics = new DisplaySourceDiagnostics(1, 0, 0)
    const target = { characterId: 'char', chatId: 'chat' }
    const measured = loadPersistedForDisplaySource(db, dataDir, target, diagnostics)
    expect(measured).toEqual(loadPersistedForDisplaySource(db, dataDir, target))
    expect(diagnostics.preparation).toMatchObject({ loadPath: 'legacy', legacyLoadMs: expect.any(Number) })
    expect(diagnostics.preparation.loads?.target?.jsonValues).toBeUndefined()
    expect(diagnostics.preparation.loads?.messages).toBeUndefined()
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
