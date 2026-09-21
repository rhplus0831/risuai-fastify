import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  ASSET_GC_FILE_READ_CONCURRENCY,
  ASSET_GC_RECLAIM_BATCH,
  ASSET_GC_RESULT_LIMIT,
  runAssetGc,
} from '../src/assetGc.js'
import { rotateDatabaseLineage } from '../src/databaseLineage.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { closeMaintenance, getMaintenanceCoordinator, MaintenanceBusyError } from '../src/maintenanceCoordinator.js'
import {
  addAssets,
  assetById,
  assetPath,
  assetsDir,
  createBackup,
  getAllAssetMetadata,
  insertAssetMetadataBatch,
  writePersistedWithMessages,
  type PersistedAsset,
} from '../src/repository.js'
import { setupAuthedClient } from './helpers/auth.js'

const NOW = 10_000_000_000
const GRACE_MS = 60 * 60_000
const OLD_MTIME = (NOW - GRACE_MS - 60_000) / 1000
const ORPHAN = 'a'.repeat(64)
const SECOND_ORPHAN = 'b'.repeat(64)
const BYTES = Buffer.from([1, 2, 3])

let dataDir: string
let db: DatabaseSync

function metadata(id: string): PersistedAsset {
  return { id, ext: 'png', size: BYTES.length, contentType: 'image/png' }
}

function writeOldFile(id: string): string {
  fs.mkdirSync(assetsDir(dataDir), { recursive: true })
  const file = assetPath(dataDir, metadata(id))
  fs.writeFileSync(file, BYTES)
  fs.utimesSync(file, OLD_MTIME, OLD_MTIME)
  return file
}

function seedOrphans(ids: readonly string[] = [ORPHAN]): void {
  insertAssetMetadataBatch(db, ids.map(metadata))
  for (const id of ids) writeOldFile(id)
}

function expectRetained(ids: readonly string[] = [ORPHAN]): void {
  for (const id of ids) {
    expect(assetById(db, id)).toEqual(metadata(id))
    expect(fs.readFileSync(assetPath(dataDir, metadata(id)))).toEqual(BYTES)
  }
}

function expectScratchRemoved(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    expect(fs.existsSync(path.join(dataDir, `.asset-gc-references.sqlite${suffix}`))).toBe(false)
  }
}

function totalChanges(): number {
  return Number(db.prepare('SELECT total_changes() AS count').get()?.count)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for GC or request progress')), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  let text = ''
  while (!text.includes(marker)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`Stream ended before ${marker}`)
    text += Buffer.from(chunk.value).toString('utf8')
  }
  return text
}

beforeEach(() => {
  vi.stubEnv('LOG_LEVEL', 'silent')
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'risu-asset-gc-scheduling-'))
  db = openDatabase(dataDir)
  writePersistedWithMessages(db, dataDir, { _version: 1, database: { characters: [] }, assets: [] })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await closeMaintenance(dataDir)
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('asset GC scheduling and reclamation fences', () => {
  it('bounds concurrent file-age reads and drains all started reads before releasing a cancelled sweep', async () => {
    const ids = Array.from({ length: 9 }, (_, index) => index.toString(16).padStart(64, '0'))
    seedOrphans(ids)
    const started = deferred()
    const release = deferred()
    const abort = new AbortController()
    const originalStat = fs.promises.stat
    let active = 0
    let peak = 0
    let calls = 0
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (...args) => {
      calls++
      active++
      peak = Math.max(peak, active)
      if (active === ASSET_GC_FILE_READ_CONCURRENCY) started.resolve()
      try {
        await release.promise
        return await originalStat(...args)
      } finally {
        active--
      }
    })
    const sweep = runAssetGc(dataDir, { db, now: () => NOW, signal: abort.signal })
    try {
      await bounded(started.promise)
      abort.abort()
      expect(active).toBe(ASSET_GC_FILE_READ_CONCURRENCY)
      expect(() => getMaintenanceCoordinator(dataDir).beginExclusive('backup')).toThrow(MaintenanceBusyError)
    } finally {
      release.resolve()
    }
    expect((await bounded(sweep)).status).toBe('cancelled')
    expect(active).toBe(0)
    expect(calls).toBe(ASSET_GC_FILE_READ_CONCURRENCY)
    expect(peak).toBe(ASSET_GC_FILE_READ_CONCURRENCY)
    expectRetained(ids)
    expectScratchRemoved()
    getMaintenanceCoordinator(dataDir).beginExclusive('backup').release()
  })

  it.each(['discovered', 'before-reclaim'] as const)(
    'retains candidates when a reference is inserted at %s',
    async (interleaveAt) => {
      seedOrphans()
      let interleaved = false
      const result = await runAssetGc(dataDir, {
        db,
        graceMs: GRACE_MS,
        now: () => NOW,
        onPhase(phase) {
          if (phase !== interleaveAt) return
          interleaved = true
          db.prepare("UPDATE settings SET data_json = json_set(data_json, '$.userIcon', ?) WHERE id = 1").run(ORPHAN)
        },
      })

      expect(interleaved).toBe(true)
      expect(result.status).toBe('stale')
      expect(result.deletedAssetCount).toBe(0)
      expectRetained()
      expectScratchRemoved()
      expect((await runAssetGc(dataDir, { db, now: () => NOW })).status).toBe('completed')
      expectRetained()
    },
  )

  it('observes external connection writes even when local total_changes is unchanged', async () => {
    seedOrphans()
    const external = new DatabaseSync(path.join(dataDir, 'risu.db'))
    const initialChanges = totalChanges()
    const initialVersion = db.prepare('PRAGMA data_version').get()?.data_version
    try {
      const result = await runAssetGc(dataDir, {
        db,
        now: () => NOW,
        onPhase(phase) {
          if (phase !== 'discovered') return
          external
            .prepare("UPDATE settings SET data_json = json_set(data_json, '$.userIcon', ?) WHERE id = 1")
            .run(ORPHAN)
          expect(totalChanges()).toBe(initialChanges)
          expect(db.prepare('PRAGMA data_version').get()?.data_version).not.toBe(initialVersion)
        },
      })
      expect(result.status).toBe('stale')
      expectRetained()
      expectScratchRemoved()
    } finally {
      external.close()
    }
  })

  it('does not reclaim candidates from a replaced database lineage', async () => {
    seedOrphans()
    const result = await runAssetGc(dataDir, {
      db,
      now: () => NOW,
      onPhase(phase) {
        if (phase === 'discovered') rotateDatabaseLineage(db)
      },
    })
    expect(result.status).toBe('stale')
    expectRetained()
    expectScratchRemoved()
  })

  it('invalidates discovery even when asset staging begins and finishes within the yield', async () => {
    seedOrphans()
    const coordinator = getMaintenanceCoordinator(dataDir)
    const result = await runAssetGc(dataDir, {
      db,
      now: () => NOW,
      onPhase(phase) {
        if (phase !== 'discovered') return
        const staging = coordinator.beginAssetStaging()
        staging.release()
        expect(coordinator.isReclamationBlocked()).toBe(false)
      },
    })
    expect(result.status).toBe('stale')
    expectRetained()
    expectScratchRemoved()
  })

  it.each(['backup', 'staging'] as const)('defers discovery while a %s lease owns live assets', async (kind) => {
    seedOrphans()
    const coordinator = getMaintenanceCoordinator(dataDir)
    const lease = kind === 'backup' ? coordinator.beginExclusive('backup') : coordinator.beginAssetStaging()
    try {
      const result = await runAssetGc(dataDir, { db, now: () => NOW })
      expect(result.status).toBe('skipped')
      expect(result.referenceScan).toBeUndefined()
      expectRetained()
      expectScratchRemoved()
    } finally {
      lease.release()
    }
    const resumed = await runAssetGc(dataDir, { db, now: () => NOW })
    expect(resumed.status).toBe('completed')
    expect(resumed.deletedAssetIds).toEqual([ORPHAN])
  })

  it('skips overlapping sweeps and rejects a backup until GC cleanup releases ownership', async () => {
    seedOrphans()
    let observedOverlap = false
    const result = await runAssetGc(dataDir, {
      db,
      now: () => NOW,
      async onPhase(phase) {
        if (phase !== 'discovered') return
        observedOverlap = true
        expect((await runAssetGc(dataDir, { db, now: () => NOW })).status).toBe('skipped')
        await expect(createBackup(db, dataDir)).rejects.toThrow(MaintenanceBusyError)
        expect(fs.existsSync(path.join(dataDir, '.asset-gc-references.sqlite'))).toBe(true)
      },
    })
    expect(observedOverlap).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.deletedAssetIds).toEqual([ORPHAN])
    expectScratchRemoved()
    getMaintenanceCoordinator(dataDir).beginExclusive('backup').release()
  })

  it('cancels without reclaiming and retains the lease until scratch cleanup finishes', async () => {
    seedOrphans()
    const abort = new AbortController()
    const coordinator = getMaintenanceCoordinator(dataDir)
    const result = await runAssetGc(dataDir, {
      db,
      now: () => NOW,
      signal: abort.signal,
      onPhase(phase) {
        if (phase !== 'discovered') return
        abort.abort(new Error('request cancelled'))
        expect(() => coordinator.beginExclusive('backup')).toThrow(MaintenanceBusyError)
        expect(fs.existsSync(path.join(dataDir, '.asset-gc-references.sqlite'))).toBe(true)
      },
    })
    expect(result.status).toBe('cancelled')
    expectRetained()
    expectScratchRemoved()
    coordinator.beginExclusive('backup').release()
  })

  it('keeps shutdown pending while a suspended GC owns its scratch database', async () => {
    seedOrphans()
    const reachedDiscovery = deferred()
    const releaseDiscovery = deferred()
    const sweep = runAssetGc(dataDir, {
      db,
      now: () => NOW,
      async onPhase(phase) {
        if (phase !== 'discovered') return
        reachedDiscovery.resolve()
        await releaseDiscovery.promise
      },
    })
    let closing: Promise<void> | undefined
    let drained = false
    try {
      await bounded(reachedDiscovery.promise)
      closing = closeMaintenance(dataDir).then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(getMaintenanceCoordinator(dataDir).isClosing).toBe(true)
      expect(fs.existsSync(path.join(dataDir, '.asset-gc-references.sqlite'))).toBe(true)
      expect((await runAssetGc(dataDir, { db })).status).toBe('skipped')
    } finally {
      releaseDiscovery.resolve()
      await closing
    }
    expect((await sweep).status).toBe('cancelled')
    expect(drained).toBe(true)
    expect(getMaintenanceCoordinator(dataDir).isClosed).toBe(true)
    expectRetained()
    expectScratchRemoved()
  })

  it.each(['discovered', 'before-reclaim'] as const)(
    'serves real authenticated HTTP and command SSE while GC is suspended at %s',
    async (interleaveAt) => {
      seedOrphans()
      const { app } = await buildApp({
        config: {
          host: '127.0.0.1',
          port: 0,
          dataDir,
          bodyLimit: 1024 * 1024,
          importMaxBytes: Infinity,
          trustProxy: false,
          hubUrl: 'https://sv.risuai.xyz',
        },
        assetGc: false,
        memoryWorker: false,
        bardWikiWorker: false,
        generationChat: { finalizationRetry: false },
      })
      const abort = new AbortController()
      const reachedPhase = deferred()
      const releasePhase = deferred()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let sweep: ReturnType<typeof runAssetGc> | undefined
      let settled = false
      try {
        const { assertion } = await setupAuthedClient(app)
        const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
        const headers = { 'risu-auth': assertion }
        const stream = await bounded(fetch(`${baseUrl}/api/v1/events`, { headers, signal: abort.signal }))
        expect(stream.status).toBe(200)
        reader = stream.body!.getReader()
        await bounded(readUntil(reader, ': connected'))
        sweep = runAssetGc(dataDir, {
          db,
          now: () => NOW,
          async onPhase(phase) {
            if (phase !== interleaveAt) return
            reachedPhase.resolve()
            await releasePhase.promise
          },
        })
        void sweep.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        await bounded(reachedPhase.promise)
        const query = await bounded(fetch(`${baseUrl}/api/v1/inlay-assets`, { headers, signal: abort.signal }))
        expect(query.status).toBe(200)
        await query.arrayBuffer()
        const command = await bounded(
          fetch(`${baseUrl}/api/v1/commands/settings/runtime`, {
            method: 'PATCH',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ baseRevision: getSchemaState(db).revision, patch: { streamGeminiThoughts: true } }),
            signal: abort.signal,
          }),
        )
        expect(command.status).toBe(200)
        await command.arrayBuffer()
        expect(await bounded(readUntil(reader, 'settings.updated'))).toContain('event: command')
        expect(settled).toBe(false)
        expectRetained()
        releasePhase.resolve()
        expect((await bounded(sweep)).status).toBe('stale')
        expectRetained()
        expectScratchRemoved()
      } finally {
        releasePhase.resolve()
        try {
          await sweep
        } finally {
          abort.abort()
          reader?.releaseLock()
          await app.close()
        }
      }
    },
  )

  it('rolls back a failed reclamation COMMIT before any canonical file is unlinked', async () => {
    seedOrphans()
    const originalExec = db.exec.bind(db)
    let rejectedCommit = false
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' && !rejectedCommit) {
        rejectedCommit = true
        throw new Error('injected commit failure')
      }
      originalExec(sql)
    })

    await expect(runAssetGc(dataDir, { db, now: () => NOW })).rejects.toThrow('injected commit failure')

    expect(rejectedCommit).toBe(true)
    expect(db.isTransaction).toBe(false)
    expectRetained()
    expectScratchRemoved()
    getMaintenanceCoordinator(dataDir).beginExclusive('backup').release()
  })

  it('invalidates discovery on a deduplicated upload that only refreshes file mtime', { tags: 'core' }, async () => {
    const uploadId = createHash('sha256').update(BYTES).digest('hex')
    seedOrphans([uploadId, SECOND_ORPHAN])
    const changesBeforeUpload = totalChanges()
    const coordinator = getMaintenanceCoordinator(dataDir)
    const activityBeforeUpload = coordinator.activityVersion
    const result = await runAssetGc(dataDir, {
      db,
      now: () => NOW,
      onPhase(phase) {
        if (phase !== 'discovered') return
        const [uploaded] = addAssets(db, dataDir, [{ bytes: BYTES, contentType: 'image/png' }])
        expect(uploaded).toMatchObject({ created: false, entry: { id: uploadId } })
        expect(totalChanges()).toBe(changesBeforeUpload)
        expect(coordinator.activityVersion).toBeGreaterThan(activityBeforeUpload)
        expect(fs.statSync(assetPath(dataDir, metadata(uploadId))).mtimeMs).toBeGreaterThan(NOW)
      },
    })
    expect(result.status).toBe('stale')
    expect(result.deletedAssetCount).toBe(0)
    expectRetained([uploadId, SECOND_ORPHAN])
    expectScratchRemoved()
  })

  it('preserves a re-upload after a committed batch and stops before reclaiming another batch', async () => {
    const uploadId = createHash('sha256').update(BYTES).digest('hex')
    const otherIds = Array.from(
      { length: ASSET_GC_RECLAIM_BATCH },
      (_, index) => `f${index.toString(16).padStart(63, '0')}`,
    )
    seedOrphans([uploadId, ...otherIds])
    let committedBatches = 0
    const result = await runAssetGc(dataDir, {
      db,
      now: () => NOW,
      onPhase(phase) {
        if (phase !== 'after-reclaim') return
        committedBatches++
        expect(assetById(db, uploadId)).toBeNull()
        expect(fs.existsSync(assetPath(dataDir, metadata(uploadId)))).toBe(false)
        expect(addAssets(db, dataDir, [{ bytes: BYTES, contentType: 'image/png' }])[0]?.created).toBe(true)
      },
    })
    expect(committedBatches).toBe(1)
    expect(result.status).toBe('stale')
    expect(result.deletedAssetCount).toBe(ASSET_GC_RECLAIM_BATCH)
    expectRetained([uploadId, otherIds[otherIds.length - 1]!])
    expect(getAllAssetMetadata(db)).toHaveLength(2)
    expectScratchRemoved()
  })

  it('bounds deletion turns and result arrays while preserving full deletion counts', async () => {
    const assetCount = ASSET_GC_RESULT_LIMIT + ASSET_GC_RECLAIM_BATCH + 1
    const ids = Array.from({ length: assetCount }, (_, index) => index.toString(16).padStart(64, '0'))
    insertAssetMetadataBatch(db, ids.map(metadata))
    const strayIds = Array.from({ length: 9 }, (_, index) => `f${index.toString(16).padStart(63, '0')}`)
    for (const id of strayIds) writeOldFile(id)
    const remainingCount = () => Number(db.prepare('SELECT count(*) AS count FROM assets').get()?.count)
    let previousCount = assetCount
    const batchSizes: number[] = []
    const result = await runAssetGc(dataDir, {
      db,
      now: () => NOW,
      onPhase(phase) {
        if (phase !== 'after-reclaim') return
        const count = remainingCount()
        if (count !== previousCount) batchSizes.push(previousCount - count)
        previousCount = count
      },
    })
    expect(result.status).toBe('completed')
    expect(result.scannedOrphans).toBe(assetCount)
    expect(result.deletedAssetCount).toBe(assetCount)
    expect(result.deletedStrayFileCount).toBe(strayIds.length)
    expect(result.deletedAssetIds).toHaveLength(ASSET_GC_RESULT_LIMIT)
    expect(result.deletedStrayFiles).toEqual([])
    expect(result.resultsTruncated).toBe(true)
    expect(batchSizes).toHaveLength(Math.ceil(assetCount / ASSET_GC_RECLAIM_BATCH))
    expect(Math.max(...batchSizes)).toBe(ASSET_GC_RECLAIM_BATCH)
    expect(batchSizes.reduce((sum, count) => sum + count, 0)).toBe(assetCount)
    expect(remainingCount()).toBe(0)
    expect(fs.readdirSync(assetsDir(dataDir))).toEqual([])
    expectScratchRemoved()
  })
})
