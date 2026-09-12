import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDatabase, getSchemaState } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { runAssetGc } from '../src/assetGc.js'
import { BackupAssetError } from '../src/backupFiles.js'
import { BackupCopyPool } from '../src/backupCopyPool.js'
import { getMaintenanceCoordinator, MaintenanceBusyError } from '../src/maintenanceCoordinator.js'
import {
  addAsset,
  applyImport,
  assetPath,
  assetsDir,
  backupDir,
  createBackup,
  getAllAssetMetadata,
  listBackups,
  loadPersisted,
  restoreBackup,
  upsertInlayCatalogEntry,
  writePersistedWithMessages,
  type PersistedAsset,
  type BackupManifest,
} from '../src/repository.js'
import { setupAuthedClient } from './helpers/auth.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import * as generationOperations from '../src/generationOperations.js'

const sqliteHook = vi.hoisted(() => ({ before: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  return {
    ...actual,
    backup: async (...args: Parameters<typeof actual.backup>) => {
      await sqliteHook.before?.()
      return actual.backup(...args)
    },
  }
})

const BYTES = Buffer.from('/* referenced synthetic backup asset */')
let dataDir: string
let db: DatabaseSync
let app: FastifyInstance
let assertion: string
let referenced: PersistedAsset
let orphan: PersistedAsset
let pending: Promise<unknown>[]
let releases: Array<() => void>
let commandEvents: CommandEventSink

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise.catch(() => undefined))
  return promise
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function pauseCopy() {
  const entered = deferred()
  const resumed = deferred()
  releases.push(resumed.resolve)
  const original = BackupCopyPool.prototype.runBatch
  let paused = false
  vi.spyOn(BackupCopyPool.prototype, 'runBatch').mockImplementation(async function (this: BackupCopyPool, entries) {
    if (!paused && entries.some((entry) => entry.from.startsWith(`${assetsDir(dataDir)}${path.sep}`))) {
      paused = true
      entered.resolve()
      await resumed.promise
    }
    return original.call(this, entries)
  })
  return { entered: entered.promise, resume: resumed.resolve }
}

function seedRetentionManifest(index: number, kind: 'manual' | 'automatic', createdAt = '2024-01-01T00:00:00.000Z') {
  const id = `2024-01-01-00-00-00-${index.toString(16).padStart(6, '0')}`
  const root = backupDir(dataDir, id)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id, kind, createdAt }))
  return id
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) {
  let text = ''
  while (!text.includes(marker)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`Stream ended before ${marker}`)
    text += Buffer.from(chunk.value).toString('utf8')
  }
  return text
}

beforeEach(async () => {
  vi.stubEnv('LOG_LEVEL', 'silent')
  pending = []
  releases = []
  commandEvents = createCommandEventSink()
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'risu-backup-maintenance-'))
  db = openDatabase(dataDir)
  referenced = addAsset(db, dataDir, { bytes: BYTES, contentType: 'text/css' }).entry
  orphan = addAsset(db, dataDir, { bytes: Buffer.from('/* orphan */'), contentType: 'text/css' }).entry
  writePersistedWithMessages(db, dataDir, {
    _version: 1,
    database: { userIcon: referenced.id, characters: [], streamGeminiThoughts: false, tag: 'before' },
    assets: getAllAssetMetadata(db),
  })
  const built = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      automaticBackupRetention: 1,
    },
    assetGc: false,
    memoryWorker: false,
    bardWikiWorker: false,
    generationChat: { finalizationRetry: false },
    commandEvents,
  })
  app = built.app
  assertion = (await setupAuthedClient(app)).assertion
})

afterEach(async () => {
  sqliteHook.before = undefined
  releases.forEach((release) => release())
  await Promise.all(pending)
  vi.restoreAllMocks()
  await app.close()
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('backup maintenance ownership', () => {
  it('selects newest automatic backups by createdAt then id without counting manual or corrupt manifests', async () => {
    const automatic = [4, 1, 3, 2].map((index) => seedRetentionManifest(index, 'automatic'))
    const manual = Array.from({ length: 40 }, (_, index) => seedRetentionManifest(index + 100, 'manual'))
    const corrupt = seedRetentionManifest(200, 'automatic')
    fs.writeFileSync(path.join(backupDir(dataDir, corrupt), 'manifest.json'), '{broken')
    const mismatched = seedRetentionManifest(201, 'automatic')
    fs.writeFileSync(
      path.join(backupDir(dataDir, mismatched), 'manifest.json'),
      JSON.stringify({ id: 'wrong', kind: 'automatic', createdAt: '2099' }),
    )
    await applyImport(db, dataDir, { characters: [] }, { automaticBackupRetention: 3 })
    const retained = listBackups(dataDir)
    expect(
      retained
        .filter((backup) => backup.kind === 'manual')
        .map((backup) => backup.id)
        .sort(),
    ).toEqual(manual.sort())
    expect(retained.filter((backup) => backup.kind === 'automatic')).toHaveLength(3)
    expect(automatic.filter((id) => fs.existsSync(backupDir(dataDir, id))).sort()).toEqual(
      [automatic[0], automatic[2]].sort(),
    )
    expect(fs.existsSync(backupDir(dataDir, corrupt))).toBe(true)
    expect(fs.existsSync(backupDir(dataDir, mismatched))).toBe(true)
  })

  it.each(['manual', 'automatic'] as const)(
    'counts a protected %s restore source before selecting retention capacity',
    async (kind) => {
      const source = await createBackup(db, dataDir, null, { kind })
      fs.writeFileSync(
        path.join(backupDir(dataDir, source.id), 'manifest.json'),
        JSON.stringify({ ...source, createdAt: '2020-01-01T00:00:00.000Z' }),
      )
      const old = seedRetentionManifest(1, 'automatic', '2022-01-01T00:00:00.000Z')
      const newer = seedRetentionManifest(2, 'automatic', '2025-01-01T00:00:00.000Z')
      let atCommit: BackupManifest[] = []
      await restoreBackup(db, dataDir, source.id, {
        automaticBackupRetention: 2,
        onCommitted() {
          atCommit = listBackups(dataDir)
        },
      })
      expect(atCommit.some((backup) => backup.id === source.id)).toBe(true)
      expect(atCommit.some((backup) => backup.id === old)).toBe(false)
      expect(atCommit.some((backup) => backup.id === newer)).toBe(kind === 'manual')
      expect(atCommit.filter((backup) => backup.kind === 'automatic')).toHaveLength(2)
    },
  )

  it.each(['complete', 'cancel'] as const)(
    'allows request/event-loop progress and can %s while retention awaits a manifest read',
    async (outcome) => {
      const manual = seedRetentionManifest(1, 'manual')
      const entered = deferred()
      const resumed = deferred()
      releases.push(resumed.resolve)
      const originalRead = fs.promises.readFile.bind(fs.promises)
      vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
        if (String(args[0]) === path.join(backupDir(dataDir, manual), 'manifest.json')) {
          entered.resolve()
          await resumed.promise
        }
        return originalRead(...args)
      })
      const controller = new AbortController()
      const imported = track(
        applyImport(db, dataDir, { characters: [] }, { automaticBackupRetention: 1, signal: controller.signal }),
      )
      await entered.promise
      let progressed = false
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          progressed = true
          resolve()
        }),
      )
      expect(progressed).toBe(true)
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/inlay-assets', headers: { 'risu-auth': assertion } }))
          .statusCode,
      ).toBe(200)
      if (outcome === 'cancel') controller.abort()
      resumed.resolve()
      if (outcome === 'cancel') {
        await expect(imported).rejects.toMatchObject({ name: 'AbortError' })
        expect((loadPersisted(db, dataDir).database as Record<string, unknown>).tag).toBe('before')
        expect(listBackups(dataDir).filter((backup) => backup.kind === 'automatic')).toHaveLength(1)
      } else await imported
      expect(fs.existsSync(backupDir(dataDir, manual))).toBe(true)
    },
  )

  it('publishes restore effects before retention permits new-lineage commands and generation work', async () => {
    const source = await createBackup(db, dataDir, null, { kind: 'automatic' })
    const entered = deferred()
    const resumed = deferred()
    releases.push(resumed.resolve)
    const originalRm = fs.promises.rm.bind(fs.promises)
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]) === backupDir(dataDir, source.id)) {
        entered.resolve()
        await resumed.promise
      }
      return originalRm(...args)
    })
    const reconciliation = vi.spyOn(generationOperations, 'reconcileGenerationOperationsAtStartup')
    commandEvents.clear()
    const restored = track(
      app.inject({ method: 'POST', url: `/api/v1/backups/${source.id}/restore`, headers: { 'risu-auth': assertion } }),
    )
    await entered.promise
    expect(commandEvents.list().map((event) => event.type)).toEqual(['state.restored'])
    expect(reconciliation).toHaveBeenCalledTimes(1)
    const serverInstanceId = reconciliation.mock.calls[0][1]
    const databaseLineage = getDatabaseLineage(db)
    generationOperations.createGenerationOperation(db, {
      databaseLineage,
      operationId: 'accepted-during-retention',
      protocolVersion: 1,
      requestOrigin: 'continue',
      mode: 'continue',
      state: 'accepted',
      creatorWriterSessionId: 'retention-writer',
      creatorWriterEpoch: 0,
      bindingServerInstanceId: serverInstanceId,
      characterId: 'retention-character',
      chatId: 'retention-chat',
      requestFingerprint: 'a'.repeat(64),
      intent: { mode: 'continue' },
    })
    const reservation = generationOperations.reserveGenerationOperationAttempt(db, {
      databaseLineage,
      operationId: 'accepted-during-retention',
      expectedState: 'accepted',
      expectedStateVersion: 1,
      retryRequestId: 'retention-attempt',
      jobId: 'retention-job',
      serverInstanceId,
      actorWriterSessionId: 'retention-writer',
      actorWriterEpoch: 0,
      launchRevision: getSchemaState(db).revision,
    })
    expect(reservation.status).toBe('applied')
    const command = await app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: getSchemaState(db).revision, patch: { streamGeminiThoughts: true } },
    })
    expect(command.statusCode).toBe(200)
    resumed.resolve()
    expect((await restored).statusCode).toBe(200)
    expect(commandEvents.list().map((event) => event.type)).toEqual(['state.restored', 'settings.updated'])
    const [restoreEvent, commandEvent] = commandEvents.list()
    expect(commandEvent.revision).toBe(restoreEvent.revision + 1)
    expect(reconciliation).toHaveBeenCalledTimes(1)
    expect(
      generationOperations.getGenerationOperationProjection(db, databaseLineage, 'accepted-during-retention'),
    ).toMatchObject({ state: 'launching', currentAttempt: { status: 'reserved', serverInstanceId } })
  })

  it('protects assets from GC before the SQLite snapshot first yields', async () => {
    const entered = deferred()
    const resumed = deferred()
    releases.push(resumed.resolve)
    sqliteHook.before = async () => {
      entered.resolve()
      await resumed.promise
    }
    const backup = track(createBackup(db, dataDir))
    await entered.promise
    expect(getMaintenanceCoordinator(dataDir).isReclamationBlocked()).toBe(true)
    expect((await runAssetGc(dataDir, { db, graceMs: 0 })).deletedAssetIds).toEqual([])
    expect(fs.existsSync(assetPath(dataDir, orphan))).toBe(true)
    resumed.resolve()
    await backup
    expect((await runAssetGc(dataDir, { db, graceMs: 0 })).deletedAssetIds).toEqual([orphan.id])
  })

  it('permits authenticated API, command SSE, and upload progress while excluding destructive peers and save writes', async () => {
    const source = await createBackup(db, dataDir)
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    const abort = new AbortController()
    releases.push(() => abort.abort())
    const stream = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = stream.body!.getReader()
    await readUntil(reader, ': connected')
    const barrier = pauseCopy()
    const backup = track(createBackup(db, dataDir))
    await barrier.entered
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/inlay-assets', headers: { 'risu-auth': assertion } }))
        .statusCode,
    ).toBe(200)
    for (const [method, url] of [
      ['POST', '/api/v1/backups'],
      ['DELETE', `/api/v1/backups/${source.id}`],
      ['POST', `/api/v1/backups/${source.id}/restore`],
      ['POST', '/api/v1/storage/write'],
      ['POST', '/api/v1/storage/remove'],
      ['POST', '/api/v1/import/risusave'],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: {
          'risu-auth': assertion,
          'file-path': '6162',
          ...(method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
        },
        payload: method === 'DELETE' ? undefined : { database: { characters: [] } },
      })
      expect(response.statusCode, url).toBe(503)
    }
    expect(() => getMaintenanceCoordinator(dataDir).beginAssetStaging()).toThrow(MaintenanceBusyError)
    const command = await app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: getSchemaState(db).revision, patch: { streamGeminiThoughts: true } },
    })
    expect(command.statusCode).toBe(200)
    expect(await readUntil(reader, 'settings.updated')).toContain('event: command')
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'risu-auth': assertion, 'content-type': 'text/css' },
      payload: '/* concurrent */',
    })
    expect(upload.statusCode).toBe(201)
    barrier.resume()
    const result = await backup
    expect(result.assetCount).toBe(2)
    const snapshot = new DatabaseSync(path.join(backupDir(dataDir, result.id), 'risu.db'))
    try {
      expect(
        (loadPersisted(snapshot, backupDir(dataDir, result.id)).database as Record<string, unknown>)
          .streamGeminiThoughts,
      ).toBe(false)
    } finally {
      snapshot.close()
    }
    expect(fs.readFileSync(assetPath(backupDir(dataDir, result.id), referenced))).toEqual(BYTES)
    abort.abort()
    reader.releaseLock()
  })

  it.each(['file', 'metadata', 'catalog'] as const)(
    'fails closed on missing required %s and releases ownership',
    async (kind) => {
      if (kind === 'metadata') db.prepare('DELETE FROM assets WHERE id = ?').run(referenced.id)
      else if (kind === 'catalog') {
        const catalogAsset = addAsset(db, dataDir, {
          bytes: Buffer.from(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
            'hex',
          ),
          contentType: 'image/png',
        }).entry
        upsertInlayCatalogEntry(db, { assetId: catalogAsset.id, aliases: [], name: 'required catalog asset' })
        fs.rmSync(assetPath(dataDir, catalogAsset))
      } else fs.rmSync(assetPath(dataDir, referenced))
      await expect(createBackup(db, dataDir)).rejects.toBeInstanceOf(BackupAssetError)
      expect(listBackups(dataDir)).toEqual([])
      expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual([])
      expect(getMaintenanceCoordinator(dataDir).isReclamationBlocked()).toBe(false)
    },
  )

  it.each(['missing', 'wrong-size', 'wrong-hash'] as const)(
    'rejects an unusable restore fallback (%s) before changing live state',
    async (damage) => {
      const source = await createBackup(db, dataDir)
      fs.rmSync(assetPath(dataDir, referenced))
      const fallback = assetPath(backupDir(dataDir, source.id), referenced)
      if (damage === 'missing') fs.rmSync(fallback)
      else fs.writeFileSync(fallback, damage === 'wrong-size' ? Buffer.from('bad') : Buffer.alloc(BYTES.length))
      const lineage = getDatabaseLineage(db)
      await expect(restoreBackup(db, dataDir, source.id)).rejects.toMatchObject({ code: 'automatic_backup_failed' })
      expect(getDatabaseLineage(db)).toBe(lineage)
      expect(listBackups(dataDir).map((backup) => backup.id)).toEqual([source.id])
      expect(fs.existsSync(assetPath(dataDir, referenced))).toBe(false)
    },
  )

  it('uses verified pinned restore bytes only in the safety snapshot without repairing the live source', async () => {
    const source = await createBackup(db, dataDir)
    fs.rmSync(assetPath(dataDir, referenced))
    const barrier = pauseCopy()
    const restore = track(restoreBackup(db, dataDir, source.id))
    await barrier.entered
    expect(fs.existsSync(assetPath(dataDir, referenced))).toBe(false)
    barrier.resume()
    await restore
    const safety = listBackups(dataDir).find((backup) => backup.kind === 'automatic')!
    expect(fs.readFileSync(assetPath(backupDir(dataDir, safety.id), referenced))).toEqual(BYTES)
    expect(fs.readFileSync(assetPath(dataDir, referenced))).toEqual(BYTES)
  })

  it.each([
    ['import', 'command'],
    ['import', 'upload'],
    ['restore', 'command'],
    ['restore', 'upload'],
  ] as const)(
    'keeps accepted work and completed safety backup when %s becomes stale after %s',
    async (operation, mutation) => {
      const source = operation === 'restore' ? await createBackup(db, dataDir) : undefined
      const barrier = pauseCopy()
      const beforeLineage = getDatabaseLineage(db)
      const imported = track(
        source
          ? restoreBackup(db, dataDir, source.id)
          : applyImport(db, dataDir, { characters: [], tag: 'replacement' }),
      )
      await barrier.entered
      if (mutation === 'command') {
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/v1/commands/settings/runtime',
          headers: { 'risu-auth': assertion },
          payload: { baseRevision: getSchemaState(db).revision, patch: { streamGeminiThoughts: true } },
        })
        expect(response.statusCode).toBe(200)
      } else
        addAsset(db, dataDir, { bytes: Buffer.from('/* accepted after safety capture */'), contentType: 'text/css' })
      barrier.resume()
      await expect(imported).rejects.toBeInstanceOf(MaintenanceBusyError)
      expect(getDatabaseLineage(db)).toBe(beforeLineage)
      expect((loadPersisted(db, dataDir).database as Record<string, unknown>).tag).toBe('before')
      expect(listBackups(dataDir)).toHaveLength(source ? 2 : 1)
    },
  )

  it('captures the destructive write fence before starting SQLite backup', async () => {
    sqliteHook.before = async () => {
      addAsset(db, dataDir, { bytes: Buffer.from('/* accepted while SQLite was starting */'), contentType: 'text/css' })
    }
    await expect(applyImport(db, dataDir, { characters: [], tag: 'replacement' })).rejects.toBeInstanceOf(
      MaintenanceBusyError,
    )
    expect((loadPersisted(db, dataDir).database as Record<string, unknown>).tag).toBe('before')
    expect(listBackups(dataDir)).toHaveLength(1)
  })

  it.each(['cancel', 'takeover'] as const)(
    'rejects a restore before publication after %s during its safety snapshot',
    async (schedule) => {
      const source = await createBackup(db, dataDir, 'restore source')
      const before = {
        database: loadPersisted(db, dataDir).database,
        lineage: getDatabaseLineage(db),
        revision: getSchemaState(db).revision,
      }
      const barrier = pauseCopy()
      const controller = new AbortController()
      const restoring = track(restoreBackup(db, dataDir, source.id, { signal: controller.signal }))
      await barrier.entered
      if (schedule === 'cancel') controller.abort()
      else {
        const takeover = await app.inject({
          method: 'GET',
          url: '/api/v1/bootstrap',
          headers: { 'risu-auth': assertion, 'risu-writer-session': 'successor' },
        })
        expect(takeover.statusCode).toBe(200)
      }
      barrier.resume()
      if (schedule === 'cancel') await expect(restoring).rejects.toMatchObject({ name: 'AbortError' })
      else await expect(restoring).rejects.toBeInstanceOf(MaintenanceBusyError)
      expect({
        database: loadPersisted(db, dataDir).database,
        lineage: getDatabaseLineage(db),
        revision: getSchemaState(db).revision,
      }).toEqual(before)
      expect(fs.readdirSync(dataDir).filter((name) => name.includes('restore'))).toEqual([])
      expect(getMaintenanceCoordinator(dataDir).isReclamationBlocked()).toBe(false)
    },
  )

  it('drains a cancelled copy before removing partial output and releasing the lease', async () => {
    const controller = new AbortController()
    const barrier = pauseCopy()
    const backup = track(createBackup(db, dataDir, null, { signal: controller.signal }))
    await barrier.entered
    controller.abort()
    expect(getMaintenanceCoordinator(dataDir).isReclamationBlocked()).toBe(true)
    barrier.resume()
    await expect(backup).rejects.toMatchObject({ name: 'AbortError' })
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual([])
    expect(getMaintenanceCoordinator(dataDir).isReclamationBlocked()).toBe(false)
  })

  it('aborts a held HTTP backup in preClose and drains it before closing SQLite', async () => {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    releases.push(() => app.server.closeAllConnections())
    const barrier = pauseCopy()
    const backup = track(
      fetch(`${baseUrl}/api/v1/backups`, {
        method: 'POST',
        headers: { 'risu-auth': assertion, 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    await barrier.entered
    let closed = false
    const close = track(
      app.close().then(() => {
        closed = true
      }),
    )
    await vi.waitFor(() => expect(getMaintenanceCoordinator(dataDir).isClosing).toBe(true), { timeout: 1000 })
    expect(closed).toBe(false)
    barrier.resume()
    const response = await bounded(backup, 'aborted HTTP response')
    expect(response.status).toBe(499)
    await response.text()
    await bounded(close, 'app close after response')
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual([])
  })
})
