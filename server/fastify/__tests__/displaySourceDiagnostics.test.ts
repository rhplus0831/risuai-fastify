import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'
import type { DisplaySourceRequest } from '@risuai/protocol/display-source'
import { openDatabase } from '../src/db.js'
import { applyImport } from '../src/repository.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { registerDiagnosticDatabase, runWithDiagnosticContext } from '../src/diagnosticContext.js'
import { DisplaySourceService } from '../src/displaySourceService.js'
import { DisplaySourceCache } from '../src/displaySourceCache.js'
import { beginDisplaySourceDiagnostics } from '../src/displaySourceDiagnostics.js'

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
    await first
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
    await runWithDiagnosticContext(db, { requestUid: 'c'.repeat(64) }, () => service.transformBatch('chat', request))
    expect(events.filter((entry) => entry.category === 'display-performance').at(-1)).toMatchObject({
      requestUid: 'c'.repeat(64),
      outcome: 'ok',
      cacheHitCount: 1,
    })
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
})
