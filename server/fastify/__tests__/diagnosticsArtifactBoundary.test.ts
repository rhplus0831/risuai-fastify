import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { createDiagnosticsJournal } from '../src/diagnosticsJournal.js'
import { insertAssetMetadataBatch, writePersistedWithMessages } from '../src/repository.js'
import { decodeRisuSaveImportSnapshot } from '../src/risuSave/importSnapshot.js'
import { setupAuthedClient } from './helpers/auth.js'

const token = 'e2'.repeat(32)
const digest = createHash('sha256').update(token).digest('hex')
const correlationKey = Buffer.from('PRIVATE_DIAGNOSTIC_KEY_'.padEnd(32, 'X'))
const publicDocument = '<!doctype html><title>public application</title>'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.unstubAllEnvs()
})

async function harness(
  aliases?: 'nested' | 'index',
  fileRootAlias?: {
    root: 'save' | 'assets' | 'backups'
    target: 'journal' | 'verifier'
    browserOnly?: boolean
    disabled?: boolean
  },
  disabled = false,
) {
  vi.stubEnv('LOG_LEVEL', 'silent')
  const root = mkdtempSync(path.join(tmpdir(), 'risu-diagnostic-artifacts-'))
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'data')
  const staticRoot = path.join(root, 'public')
  const privateDir = path.join(root, 'private')
  const directory = path.join(dataDir, 'diagnostics')
  for (const dir of [directory, staticRoot, privateDir]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const verifierFile = path.join(privateDir, 'verifier.json')
  writeFileSync(
    verifierFile,
    JSON.stringify({ version: 1, credentials: [{ id: 'artifact-boundary', sha256: digest }] }),
    { mode: 0o600 },
  )
  writeFileSync(path.join(directory, 'correlation.key'), correlationKey, { mode: 0o600 })
  if (fileRootAlias)
    symlinkSync(fileRootAlias.target === 'journal' ? directory : privateDir, path.join(dataDir, fileRootAlias.root))
  if (aliases === 'index') symlinkSync(verifierFile, path.join(staticRoot, 'index.html'))
  else writeFileSync(path.join(staticRoot, 'index.html'), publicDocument)
  if (aliases === 'nested') {
    // Static routes enumerate existing files once at startup. Seed the actual
    // journal so this case exercises a registered downloadable SQLite alias.
    const db = openDatabase(dataDir)
    const lineage = getDatabaseLineage(db)
    db.close()
    const journal = createDiagnosticsJournal({ directory, lineage, instanceId: 'a4'.repeat(16), enabled: true })
    await journal.ready
    await journal.close()
    mkdirSync(path.join(staticRoot, 'nested'))
    symlinkSync(verifierFile, path.join(staticRoot, 'nested/verifier.json'))
    symlinkSync(directory, path.join(staticRoot, 'nested/telemetry'))
    writeFileSync(path.join(root, 'shared-public.txt'), 'shared public file')
    symlinkSync(path.join(root, 'shared-public.txt'), path.join(staticRoot, 'nested/shared.txt'))
    writeFileSync(path.join(staticRoot, 'nested/A'), 'public decoded filename')
    symlinkSync(verifierFile, path.join(staticRoot, 'nested/%41'))
  }
  const built = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://synthetic.invalid',
      staticRoot,
      clientDiagnostics: true,
      supportDiagnostics: fileRootAlias?.browserOnly
        ? undefined
        : { enabled: !disabled && fileRootAlias?.disabled !== true, verifierFile },
      browserDiagnostics: fileRootAlias?.browserOnly ? { enabled: true } : undefined,
    },
    generationChat: { finalizationRetry: false },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
  })
  cleanup.push(async () => {
    await built.app.close()
  })
  await built.app.ready()
  await built.diagnostics.ready
  if (!disabled) {
    await vi.waitFor(() => expect(built.diagnostics.journal?.read().pending).toBe(0))
    expect(built.diagnostics.journal?.read().source).toBe('journal')
  }
  const db = openDatabase(dataDir)
  try {
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: {
        version: 1,
        characters: [],
        botPresets: [],
        modules: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
      },
      assets: [],
    })
  } finally {
    db.close()
  }
  const { assertion } = await setupAuthedClient(built.app)
  return { ...built, root, dataDir, directory, verifierFile, headers: { 'risu-auth': assertion } }
}

function expectNoPrivateArtifacts(bytes: Uint8Array | string): void {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes)
  for (const secret of [token, digest, correlationKey.toString('utf8'), 'journal_records', 'journal_meta']) {
    expect(buffer.includes(Buffer.from(secret)), secret).toBe(false)
    expect(buffer.includes(Buffer.from(Buffer.from(secret).toString('base64'))), secret).toBe(false)
  }
}

it('keeps the live journal and private keys outside application storage, asset, static, backup and export surfaces', async () => {
  const h = await harness()
  expect(readFileSync(path.join(h.directory, 'correlation.key'))).toEqual(correlationKey)
  expect(readFileSync(path.join(h.directory, 'journal.sqlite')).includes(Buffer.from('journal_records'))).toBe(true)
  const listed = await h.app.inject({ url: '/api/v1/storage/list', headers: h.headers })
  expect(listed.json()).toEqual({ success: true, content: [] })
  for (const filename of ['diagnostics/journal.sqlite', 'diagnostics/correlation.key', h.verifierFile]) {
    for (const filePath of [filename, `../${filename}`, Buffer.from(`../${filename}`).toString('hex')]) {
      const response = await h.app.inject({
        url: '/api/v1/storage/read',
        headers: { ...h.headers, 'file-path': filePath },
      })
      expectNoPrivateArtifacts(response.rawPayload)
      expect(response.statusCode === 400 || (response.statusCode === 200 && response.rawPayload.length === 0)).toBe(
        true,
      )
    }
    for (const url of [`/${filename}`, `/api/v1/assets/${encodeURIComponent(filename)}`]) {
      const response = await h.app.inject({ url, headers: h.headers })
      expectNoPrivateArtifacts(response.rawPayload)
      expect(response.statusCode === 404 || response.body === publicDocument).toBe(true)
    }
  }

  const backup = await h.app.inject({ method: 'POST', url: '/api/v1/backups', headers: h.headers, payload: {} })
  expect(backup.statusCode).toBe(201)
  const backupPath = path.join(h.dataDir, 'backups', backup.json().id)
  const names = readdirSync(backupPath, { recursive: true }).map(String)
  expect(names.filter((name) => !['risu.db-shm', 'risu.db-wal'].includes(name)).sort()).toEqual([
    'assets',
    'manifest.json',
    'risu.db',
    'save',
  ])
  for (const name of names.filter((name) => !['assets', 'save'].includes(name)))
    expectNoPrivateArtifacts(readFileSync(path.join(backupPath, name)))
  const snapshot = new DatabaseSync(path.join(backupPath, 'risu.db'), { readOnly: true })
  try {
    expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'journal_%'").all()).toEqual([])
  } finally {
    snapshot.close()
  }

  for (const suffix of ['risusave', 'risusave?envelope=legacy-raw', 'bundle', 'local-backup']) {
    const response = await h.app.inject({ url: `/api/v1/export/${suffix}`, headers: h.headers })
    expect(response.statusCode).toBe(200)
    expectNoPrivateArtifacts(response.rawPayload)
    let databaseBytes: Uint8Array = response.rawPayload
    if (suffix === 'bundle') {
      const entries = unzipSync(response.rawPayload)
      expect(Object.keys(entries).sort()).toEqual(['database.risu', 'manifest.json'])
      databaseBytes = entries['database.risu']
      for (const entry of Object.values(entries)) expectNoPrivateArtifacts(entry)
    } else if (suffix === 'local-backup') {
      const bytes = response.rawPayload
      const nameLength = bytes.readUInt32LE(0)
      expect(bytes.subarray(4, 4 + nameLength).toString('utf8')).toBe('database.risudat')
      const size = bytes.readUInt32LE(4 + nameLength)
      databaseBytes = bytes.subarray(8 + nameLength)
      expect(databaseBytes.length).toBe(size)
    }
    expectNoPrivateArtifacts(JSON.stringify(decodeRisuSaveImportSnapshot(databaseBytes)))
  }
}, 20_000)

it('blocks nested static symlinks to the support verifier and diagnostic journal directory', async () => {
  const h = await harness('nested')
  for (const url of [
    '/nested/verifier.json',
    '/nested/telemetry/correlation.key',
    '/nested/telemetry/journal.sqlite',
  ]) {
    expect(h.app.hasRoute({ method: 'GET', url })).toBe(true)
    const response = await h.app.inject({ url })
    expectNoPrivateArtifacts(response.rawPayload)
    expect(response.statusCode === 404 || response.body === publicDocument).toBe(true)
  }
  expect((await h.app.inject('/nested/shared.txt')).body).toBe('shared public file')
  for (const url of ['/nested/%2541', '/nested/%41']) expectNoPrivateArtifacts((await h.app.inject(url)).rawPayload)
})

it('does not use a private verifier symlink as the root document or SPA fallback', async () => {
  const h = await harness('index')
  for (const url of ['/', '/index.html', '/unmatched-spa-page']) {
    const response = await h.app.inject({ url })
    expectNoPrivateArtifacts(response.rawPayload)
    expect(response.statusCode).toBe(404)
  }
})

it.each([false, true])(
  'blocks private artifact file aliases in storage and asset readers with collection disabled=%s',
  async (disabled) => {
    const h = await harness(undefined, undefined, disabled)
    const assets = path.join(h.dataDir, 'assets')
    mkdirSync(assets, { recursive: true })
    mkdirSync(path.join(h.dataDir, 'save'), { recursive: true })
    const publicFile = path.join(h.root, 'ordinary-file')
    writeFileSync(publicFile, 'ordinary public bytes')
    const targets = [path.join(h.directory, 'correlation.key'), h.verifierFile, publicFile]
    const db = openDatabase(h.dataDir)
    try {
      for (const [index, file] of targets.entries()) {
        const id = String(index + 1).repeat(64)
        const storageKey = Buffer.from(`alias-${index}`).toString('hex')
        symlinkSync(file, path.join(assets, `${id}.bin`))
        symlinkSync(file, path.join(h.dataDir, 'save', storageKey))
        insertAssetMetadataBatch(db, [
          { id, ext: 'bin', contentType: 'application/octet-stream', size: readFileSync(file).length },
        ])
        for (const request of [
          { url: '/api/v1/storage/read', headers: { ...h.headers, 'file-path': storageKey } },
          { url: `/api/v1/assets/${id}`, headers: h.headers },
          { method: 'HEAD' as const, url: `/api/v1/assets/${id}`, headers: h.headers },
        ]) {
          const response = await h.app.inject(request)
          expectNoPrivateArtifacts(response.rawPayload)
          expect(response.statusCode).toBe(file === publicFile ? 200 : 404)
          if (file === publicFile && request.method !== 'HEAD') expect(response.body).toBe('ordinary public bytes')
        }
      }
    } finally {
      db.close()
    }
  },
)

it.each(['save', 'assets', 'backups'] as const)(
  'rejects the %s file root when it aliases private diagnostic artifacts',
  async (root) => {
    for (const target of ['journal', 'verifier'] as const) {
      await expect(harness(undefined, { root, target })).rejects.toThrow(/Invalid .*diagnostics configuration/)
      await expect(harness(undefined, { root, target, disabled: true })).rejects.toThrow(
        /Invalid .*diagnostics configuration/,
      )
    }
    await expect(harness(undefined, { root, target: 'journal', browserOnly: true })).rejects.toThrow(
      'Invalid diagnostics configuration',
    )
  },
)
