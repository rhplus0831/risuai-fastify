import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as fflate from 'fflate'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import { ACTIVE_WRITER_SESSION_HEADER } from '../src/activeWriter.js'
import {
  writePersistedWithMessages,
  assetsDir,
  insertAssetMetadataBatch,
  getAssetMetadataById,
  cleanupCopiedStagedAssetFiles,
  listBackups,
  loadPersistedWithMessages,
} from '../src/repository.js'
import { openDatabase } from '../src/db.js'
import { getDatabaseOwnershipSnapshot } from '../src/databaseLineage.js'
import { setupAuthedClient } from './helpers/auth.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { encodeLegacyRisuSaveEnvelope } from '../src/risuSave/legacyEnvelopeCodec.js'
import { encodeRisuSaveBlockEnvelope, RisuSaveBlockType } from '../src/risuSave/blockCodec.js'
import { RISUSAVE_EMPTY_DATABASE_ERROR, RISUSAVE_INCOMPLETE_BLOCKS_ERROR } from '../src/risuSave/importSnapshot.js'
import { decodeRisuSaveImportSnapshot } from '../src/risuSave/importSnapshot.js'
import { RISU_SERVER_DATA_KEY } from '../src/risuSave/portableMetadata.js'
import {
  decodeLocalBackup,
  LOCAL_BACKUP_LEGACY_MAX_NAME_BYTES,
  LOCAL_BACKUP_ZIP_MAX_ENTRIES,
  LOCAL_BACKUP_ZIP_MAX_NAME_BYTES,
} from '../src/risuSave/localBackupImport.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'

interface Harness {
  app: FastifyInstance
  dataDir: string
  commandEvents: CommandEventSink
}

const ASSET_BYTES = Buffer.from('bundle-import-png-bytes')
const ASSET_ID = createHash('sha256').update(ASSET_BYTES).digest('hex')
const SECOND_ASSET_BYTES = Buffer.from('bundle-import-second-png-bytes')
const SECOND_ASSET_ID = createHash('sha256').update(SECOND_ASSET_BYTES).digest('hex')

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-risu-bundle-import-'))
  const commandEvents = createCommandEventSink()
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 4 * 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    memoryWorker: false,
    commandEvents,
  })
  return { app, dataDir, commandEvents }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

/**
 * Persist a database that references a real content-addressed asset and write
 * the matching asset file, so the exported bundle round-trips through the
 * import hash check (which a faithful export always satisfies).
 */
function persistDatabaseWithAsset(dataDir: string, imageReference = ASSET_ID): void {
  const db = openDatabase(dataDir)
  try {
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: {
        version: 1,
        selectedCharID: 0,
        currentChar: 0,
        characters: [
          {
            chaId: 'bundle-import-char',
            name: 'Bundle Import Character',
            image: imageReference,
            chatFolders: [],
            chatPage: 0,
            chats: [
              {
                id: 'bundle-import-chat',
                name: 'Bundle Import Chat',
                note: '',
                localLore: [],
                generationSettings: {
                  configured: true,
                  personaId: 'persona-a',
                  modelPresetId: 'model-a',
                  promptPresetId: 'prompt-a',
                  jailbreakToggle: false,
                  sidebarToggles: { mode: 'source-mode' },
                },
                message: [{ role: 'user', data: 'hello', chatId: 'bundle-import-message' }],
              },
            ],
          },
        ],
        characterOrder: ['bundle-import-char'],
        personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
        selectedPersona: 0,
        selectedPersonaId: 'persona-a',
        username: 'Persona A',
        userIcon: '',
        personaPrompt: '',
        userNote: '',
        modelPresetsId: 0,
        modelPresets: [{ id: 'model-a', name: 'Model A' }],
        promptPresetsId: 0,
        promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
        modules: [{ id: 'module-a', name: 'Module A' }],
        loadouts: [{ id: 'loadout-a', name: 'Loadout A' }],
        plugins: [{ id: 'plugin-a', name: 'Plugin A', version: '3.0' }],
        pluginCustomStorage: {},
      },
      assets: [],
    })
    insertAssetMetadataBatch(db, [{ id: ASSET_ID, ext: 'png', size: ASSET_BYTES.length, contentType: 'image/png' }])
  } finally {
    db.close()
  }

  const dir = assetsDir(dataDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${ASSET_ID}.png`), ASSET_BYTES)
}

function persistDatabaseWithGroup(dataDir: string): void {
  const db = openDatabase(dataDir)
  try {
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: {
        version: 1,
        selectedCharID: 0,
        characters: [
          {
            type: 'group',
            chaId: 'legacy-group-a',
            name: 'Legacy Party',
            image: '',
            chats: [
              {
                id: 'legacy-group-chat',
                name: 'Group Chat',
                note: '',
                localLore: [],
                message: [{ role: 'user', data: 'group history', chatId: 'group-message' }],
              },
            ],
          },
        ],
        characterOrder: ['legacy-group-a'],
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
}

function persistLiveDatabase(dataDir: string): void {
  const db = openDatabase(dataDir)
  try {
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: {
        ...createInitialDatabase(),
        version: 1,
        tag: 'preserve-live-bundle-data',
        currentChar: 0,
        characters: [{ chaId: 'live-char', name: 'Live Character', chats: [], chatFolders: [], chatPage: -1 }],
        characterOrder: ['live-char'],
        botPresets: [],
        modules: [{ id: 'live-module', name: 'Live Module' }],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
      },
      assets: [],
    })
  } finally {
    db.close()
  }
}

/** Build the original app's LocalWriter `.bin` blob: [u32-LE nameLen][name][u32-LE dataLen][data] records. */
function buildLegacyBin(records: { name: string; data: Uint8Array }[]): Buffer {
  const parts: Buffer[] = []
  for (const record of records) {
    const name = Buffer.from(record.name, 'utf8')
    const nameLen = Buffer.alloc(4)
    nameLen.writeUInt32LE(name.length, 0)
    const dataLen = Buffer.alloc(4)
    dataLen.writeUInt32LE(record.data.length, 0)
    parts.push(nameLen, name, dataLen, Buffer.from(record.data))
  }
  return Buffer.concat(parts)
}

function readLegacyBinRecord(bytes: Uint8Array, targetName: string): Uint8Array {
  const buffer = Buffer.from(bytes)
  let offset = 0
  while (offset < buffer.length) {
    const nameLength = buffer.readUInt32LE(offset)
    offset += 4
    const name = buffer.subarray(offset, offset + nameLength).toString('utf8')
    offset += nameLength
    const dataLength = buffer.readUInt32LE(offset)
    offset += 4
    const data = buffer.subarray(offset, offset + dataLength)
    offset += dataLength
    if (name === targetName) return data
  }
  throw new Error(`Missing legacy backup record: ${targetName}`)
}

function buildBundleZip(databaseBytes: Uint8Array): Uint8Array {
  return fflate.zipSync({
    'database.risu': databaseBytes,
    'manifest.json': new TextEncoder().encode(JSON.stringify({ version: 1 })),
    [`assets/${ASSET_ID}.png`]: ASSET_BYTES,
  })
}

function buildBundleZipEntries(entries: ReadonlyArray<{ name: string; data?: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = []
  const zip = new fflate.Zip((error, chunk) => {
    if (error) throw error
    chunks.push(chunk)
  })
  for (const { name, data = new Uint8Array() } of entries) {
    const entry = new fflate.ZipPassThrough(name)
    zip.add(entry)
    entry.push(data, true)
  }
  zip.end()
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

function localAssetStageDirectories(parent: string): string[] {
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('assets-stage-'))
    .map((entry) => path.join(parent, entry.name))
}

function trackExplicitBufferMaterialization(): {
  maxBytes(): number
  restore(): void
} {
  const alloc = vi.spyOn(Buffer, 'alloc')
  const allocUnsafe = vi.spyOn(Buffer, 'allocUnsafe')
  const from = vi.spyOn(Buffer, 'from')
  const concat = vi.spyOn(Buffer, 'concat')
  return {
    maxBytes: () => {
      const allocationSizes = [...alloc.mock.calls, ...allocUnsafe.mock.calls].map(([size]) => size)
      const copySizes = from.mock.calls.map(([value]) => {
        if (ArrayBuffer.isView(value)) return value.byteLength
        if (value instanceof ArrayBuffer) return value.byteLength
        return 0
      })
      const concatSizes = concat.mock.calls.map(([chunks, totalLength]) => {
        if (totalLength !== undefined) return totalLength
        return chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      })
      return Math.max(0, ...allocationSizes, ...copySizes, ...concatSizes)
    },
    restore: () => {
      concat.mockRestore()
      from.mockRestore()
      allocUnsafe.mockRestore()
      alloc.mockRestore()
    },
  }
}

function multipartBundle(bytes: Uint8Array, filename = 'database.risu.zip') {
  const boundary = `risu-bundle-boundary-${ASSET_ID.slice(0, 8)}`
  const head = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: application/zip',
      '',
      '',
    ].join('\r\n'),
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

let harness: Harness
let assertion: string

beforeEach(async () => {
  harness = await startHarness()
  ;({ assertion } = await setupAuthedClient(harness.app))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopHarness(harness)
})

function authedInject(opts: Record<string, unknown>) {
  const headers = (opts.headers ?? {}) as Record<string, string>
  return harness.app.inject({
    ...opts,
    headers: { 'risu-auth': assertion, ...headers },
  })
}

function authedComposedResourceDatabase(opts: Record<string, unknown>) {
  const headers = (opts.headers ?? {}) as Record<string, string>
  return injectComposedResourceDatabase(harness.app, {
    ...opts,
    headers: { 'risu-auth': assertion, ...headers },
  } as never)
}

async function exportBundleZip(): Promise<Buffer> {
  const exported = await authedInject({ method: 'GET', url: '/api/v1/export/bundle' })
  expect(exported.statusCode).toBe(200)
  return exported.rawPayload
}

async function expectNoImportedAssetSideEffects(h: Harness): Promise<void> {
  const asset = await h.app.inject({ method: 'GET', url: `/api/v1/assets/${ASSET_ID}` })
  expect(asset.statusCode).toBe(404)
  expect(existsSync(path.join(assetsDir(h.dataDir), `${ASSET_ID}.png`))).toBe(false)
  expect(h.commandEvents.list().map((event) => event.type)).not.toEqual(
    expect.arrayContaining(['asset.created', 'state.imported']),
  )

  const db = openDatabase(h.dataDir)
  try {
    expect(getAssetMetadataById(db, ASSET_ID)).toBeNull()
    const commandEvents = db
      .prepare('SELECT type FROM command_events ORDER BY revision ASC')
      .all() as unknown as Array<{ type: string }>
    expect(commandEvents.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(['asset.created', 'state.imported']),
    )
  } finally {
    db.close()
  }
}

function readBackupDatabase(dataDir: string, id: string): Record<string, unknown> {
  const backupRoot = path.join(dataDir, 'backups', id)
  const backupDb = new DatabaseSync(path.join(backupRoot, 'risu.db'), { readOnly: true })
  try {
    return loadPersistedWithMessages(backupDb, backupRoot).database as Record<string, unknown>
  } finally {
    backupDb.close()
  }
}

function failCommandEventPersistence(dataDir: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    db.exec(`
      CREATE TRIGGER fail_command_event_insert
      BEFORE INSERT ON command_events
      BEGIN
        SELECT RAISE(FAIL, 'injected command event failure');
      END;
    `)
  } finally {
    db.close()
  }
}

describe('repository .risu bundle import route', () => {
  it.each(['writer-change', 'writer-return', 'replacement'] as const)(
    'rejects an upload whose admitted ownership changed during intake: %s',
    async (schedule) => {
      await authedInject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { [ACTIVE_WRITER_SESSION_HEADER]: 'writer-a' },
      })
      let entered!: () => void
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        entered = resolve
      })
      const resume = new Promise<void>((resolve) => {
        release = resolve
      })
      let uploadDir: string | undefined
      const original = fs.promises.mkdtemp.bind(fs.promises)
      vi.spyOn(fs.promises, 'mkdtemp').mockImplementation(async (prefix) => {
        const dir = await original(prefix)
        if (String(prefix).includes('risu-import-')) {
          uploadDir = dir
          entered()
          await resume
        }
        return dir
      })
      const upload = multipartBundle(
        buildBundleZip(encodeLegacyRisuSaveEnvelope({ characters: [], tag: 'obsolete-upload' })),
      )
      const pending = authedInject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'content-type': upload.contentType, [ACTIVE_WRITER_SESSION_HEADER]: 'writer-a' },
        payload: upload.payload,
      }).then((response) => response)
      try {
        await held
        if (schedule === 'replacement') {
          const replaced = await authedInject({
            method: 'POST',
            url: '/api/v1/import/risusave',
            headers: { [ACTIVE_WRITER_SESSION_HEADER]: 'writer-a' },
            payload: { database: { characters: [], tag: 'current-replacement' } },
          })
          expect(replaced.statusCode, replaced.body).toBe(200)
        } else {
          await authedInject({
            method: 'GET',
            url: '/api/v1/bootstrap',
            headers: { [ACTIVE_WRITER_SESSION_HEADER]: 'writer-b' },
          })
          if (schedule === 'writer-return')
            await authedInject({
              method: 'GET',
              url: '/api/v1/bootstrap',
              headers: { [ACTIVE_WRITER_SESSION_HEADER]: 'writer-a' },
            })
        }
        const read = () => {
          const db = openDatabase(harness.dataDir)
          try {
            return {
              ownership: getDatabaseOwnershipSnapshot(db),
              state: loadPersistedWithMessages(db, harness.dataDir),
              backups: listBackups(harness.dataDir),
              events: db.prepare('SELECT * FROM command_events').all(),
            }
          } finally {
            db.close()
          }
        }
        const current = read()
        release()
        const response = await pending
        expect(response.statusCode, response.body).toBe(503)
        expect(response.json()).toMatchObject({ error: 'maintenance_busy' })
        expect(read()).toEqual(current)
        expect(fs.existsSync(uploadDir!)).toBe(false)
      } finally {
        release()
        await pending
      }
    },
  )

  it('drains temporary upload files without publication after an actual HTTP disconnect', async () => {
    const url = await harness.app.listen({ host: '127.0.0.1', port: 0 })
    let entered!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      entered = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    let uploadDir: string | undefined
    const original = fs.promises.mkdtemp.bind(fs.promises)
    vi.spyOn(fs.promises, 'mkdtemp').mockImplementation(async (prefix) => {
      const dir = await original(prefix)
      if (String(prefix).includes('risu-import-')) {
        uploadDir = dir
        entered()
        await resume
      }
      return dir
    })
    const disconnected = new Promise<void>((resolve) =>
      harness.app.server.once('connection', (socket) => socket.once('close', () => resolve())),
    )
    const upload = multipartBundle(
      buildBundleZip(encodeLegacyRisuSaveEnvelope({ characters: [], tag: 'aborted upload' })),
    )
    const controller = new AbortController()
    const request = fetch(url + '/api/v1/import/bundle', {
      method: 'POST',
      headers: { 'risu-auth': assertion, 'content-type': upload.contentType },
      body: upload.payload,
      signal: controller.signal,
    }).then(
      () => 'unexpected success',
      () => 'disconnected',
    )
    try {
      await held
      controller.abort()
      expect(await request).toBe('disconnected')
      await disconnected
      release()
      await vi.waitFor(() => expect(fs.existsSync(uploadDir!)).toBe(false))
      await expectNoImportedAssetSideEffects(harness)
      expect(listBackups(harness.dataDir)).toEqual([])
    } finally {
      release?.()
      controller.abort()
      await request
    }
  })

  it('stops local-backup decoding before staging when the request is already aborted', async () => {
    const bundlePath = path.join(harness.dataDir, 'aborted-before-decode.risu.zip')
    writeFileSync(bundlePath, buildBundleZip(encodeLegacyRisuSaveEnvelope({ characters: [] })))
    const controller = new AbortController()
    controller.abort()

    await expect(
      decodeLocalBackup(bundlePath, { maxExpandedBytes: Infinity, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('streams a multi-megabyte ZIP asset to its stage file without explicitly materializing or concatenating it', async () => {
    const assetBytes = Buffer.alloc(3 * 1024 * 1024, 0x5a)
    const assetId = createHash('sha256').update(assetBytes).digest('hex')
    const databaseBytes = encodeLegacyRisuSaveEnvelope({ characters: [] })
    const bundlePath = path.join(harness.dataDir, 'streamed-zip-asset.risu.zip')
    writeFileSync(
      bundlePath,
      buildBundleZipEntries([
        { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
        { name: `assets/${assetId}.png`, data: assetBytes },
        { name: 'database.risu', data: databaseBytes },
      ]),
    )

    const buffers = trackExplicitBufferMaterialization()
    let decoded: Awaited<ReturnType<typeof decodeLocalBackup>>
    try {
      decoded = await decodeLocalBackup(bundlePath, {
        maxExpandedBytes: Infinity,
        maxDatabaseBytes: Infinity,
      })
      expect(buffers.maxBytes()).toBeLessThan(assetBytes.length)
    } finally {
      buffers.restore()
    }

    expect(decoded.stagedAssets).toHaveLength(1)
    expect(decoded.stagedAssets[0]).toMatchObject({ id: assetId, size: assetBytes.length })
    expect(fs.readFileSync(decoded.stagedAssets[0].filePath)).toEqual(assetBytes)
  })

  it('reads legacy media in bounded chunks and skips an unrelated multi-megabyte record without allocating it', async () => {
    const unrelatedBytes = Buffer.alloc(4 * 1024 * 1024, 0x3c)
    const assetBytes = Buffer.alloc(3 * 1024 * 1024, 0xa5)
    const assetId = createHash('sha256').update(assetBytes).digest('hex')
    const databaseBytes = encodeLegacyRisuSaveEnvelope({ characters: [] })
    const bundlePath = path.join(harness.dataDir, 'streamed-legacy-asset.bin')
    writeFileSync(
      bundlePath,
      buildLegacyBin([
        { name: 'cold-storage.json', data: unrelatedBytes },
        { name: `${assetId}.png`, data: assetBytes },
        { name: 'database.risudat', data: databaseBytes },
      ]),
    )

    const buffers = trackExplicitBufferMaterialization()
    let decoded: Awaited<ReturnType<typeof decodeLocalBackup>>
    try {
      decoded = await decodeLocalBackup(bundlePath, {
        maxExpandedBytes: Infinity,
        maxDatabaseBytes: Infinity,
      })
      expect(buffers.maxBytes()).toBeLessThan(assetBytes.length)
    } finally {
      buffers.restore()
    }

    expect(decoded.stagedAssets).toHaveLength(1)
    expect(decoded.stagedAssets[0]).toMatchObject({ id: assetId, size: assetBytes.length })
    expect(fs.readFileSync(decoded.stagedAssets[0].filePath)).toEqual(assetBytes)
  })

  it('rejects an oversized legacy record name before allocating it and cleans earlier staged assets', async () => {
    const databaseBytes = encodeLegacyRisuSaveEnvelope({ characters: [] })
    const oversizedName = Buffer.alloc(LOCAL_BACKUP_LEGACY_MAX_NAME_BYTES + 1, 0x78)
    const oversizedNameLength = Buffer.alloc(4)
    oversizedNameLength.writeUInt32LE(oversizedName.byteLength, 0)
    const emptyDataLength = Buffer.alloc(4)
    const bundlePath = path.join(harness.dataDir, 'oversized-legacy-record-name.bin')
    writeFileSync(
      bundlePath,
      Buffer.concat([
        buildLegacyBin([{ name: `${ASSET_ID}.png`, data: ASSET_BYTES }]),
        oversizedNameLength,
        oversizedName,
        emptyDataLength,
        buildLegacyBin([{ name: 'database.risudat', data: databaseBytes }]),
      ]),
    )

    const buffers = trackExplicitBufferMaterialization()
    try {
      await expect(
        decodeLocalBackup(bundlePath, { maxExpandedBytes: Infinity, maxDatabaseBytes: Infinity }),
      ).rejects.toThrow(`Legacy backup record name exceeds ${LOCAL_BACKUP_LEGACY_MAX_NAME_BYTES} bytes`)
      expect(buffers.maxBytes()).toBeLessThan(oversizedName.byteLength)
    } finally {
      buffers.restore()
    }
    expect(localAssetStageDirectories(harness.dataDir)).toEqual([])
  })

  it('rejects duplicate legacy database records and cleans earlier staged assets', async () => {
    const databaseBytes = encodeLegacyRisuSaveEnvelope({ characters: [] })
    const bundlePath = path.join(harness.dataDir, 'duplicate-legacy-database.bin')
    writeFileSync(
      bundlePath,
      buildLegacyBin([
        { name: 'database.risudat', data: databaseBytes },
        { name: `${ASSET_ID}.png`, data: ASSET_BYTES },
        { name: 'database.risudat', data: databaseBytes },
      ]),
    )

    await expect(
      decodeLocalBackup(bundlePath, { maxExpandedBytes: Infinity, maxDatabaseBytes: Infinity }),
    ).rejects.toThrow('Legacy backup contains a duplicate database.risudat record')
    expect(localAssetStageDirectories(harness.dataDir)).toEqual([])
  })

  it.each(['risu-bundle-zip', 'legacy-local-backup'] as const)(
    'enforces maxDatabaseBytes before buffering a %s database and cleans earlier staged assets',
    async (format) => {
      const databaseBytes = Buffer.alloc(2 * 1024 * 1024, 0x7d)
      const bundlePath = path.join(
        harness.dataDir,
        format === 'risu-bundle-zip' ? 'database-cap.zip' : 'database-cap.bin',
      )
      const bytes =
        format === 'risu-bundle-zip'
          ? buildBundleZipEntries([
              { name: `assets/${ASSET_ID}.png`, data: ASSET_BYTES },
              { name: 'database.risu', data: databaseBytes },
              { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
            ])
          : buildLegacyBin([
              { name: `${ASSET_ID}.png`, data: ASSET_BYTES },
              { name: 'database.risudat', data: databaseBytes },
            ])
      writeFileSync(bundlePath, bytes)

      await expect(
        decodeLocalBackup(bundlePath, {
          maxExpandedBytes: Infinity,
          maxDatabaseBytes: 128 * 1024,
        }),
      ).rejects.toThrow('Local backup database exceeds size limit')
      expect(localAssetStageDirectories(harness.dataDir)).toEqual([])
    },
  )

  it.each(['risu-bundle-zip', 'legacy-local-backup'] as const)(
    'rejects a %s asset hash mismatch and removes every staged file',
    async (format) => {
      const databaseBytes = encodeLegacyRisuSaveEnvelope({ characters: [] })
      const bundlePath = path.join(
        harness.dataDir,
        format === 'risu-bundle-zip' ? 'hash-mismatch.zip' : 'hash-mismatch.bin',
      )
      const bytes =
        format === 'risu-bundle-zip'
          ? buildBundleZipEntries([
              { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
              { name: `assets/${ASSET_ID}.png`, data: SECOND_ASSET_BYTES },
              { name: 'database.risu', data: databaseBytes },
            ])
          : buildLegacyBin([
              { name: `${ASSET_ID}.png`, data: SECOND_ASSET_BYTES },
              { name: 'database.risudat', data: databaseBytes },
            ])
      writeFileSync(bundlePath, bytes)

      await expect(
        decodeLocalBackup(bundlePath, { maxExpandedBytes: Infinity, maxDatabaseBytes: Infinity }),
      ).rejects.toThrow('content hash check')
      expect(localAssetStageDirectories(harness.dataDir)).toEqual([])
    },
  )

  it.each(['risu-bundle-zip', 'legacy-local-backup'] as const)(
    'closes and removes an in-progress %s stage file when decoding is aborted',
    async (format) => {
      const assetBytes = Buffer.alloc(3 * 1024 * 1024, 0x66)
      const assetId = createHash('sha256').update(assetBytes).digest('hex')
      const databaseBytes = encodeLegacyRisuSaveEnvelope({ characters: [] })
      const bundlePath = path.join(
        harness.dataDir,
        format === 'risu-bundle-zip' ? 'aborted-stage.zip' : 'aborted-stage.bin',
      )
      const bytes =
        format === 'risu-bundle-zip'
          ? buildBundleZipEntries([
              { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
              { name: `assets/${assetId}.png`, data: assetBytes },
              { name: 'database.risu', data: databaseBytes },
            ])
          : buildLegacyBin([
              { name: `${assetId}.png`, data: assetBytes },
              { name: 'database.risudat', data: databaseBytes },
            ])
      writeFileSync(bundlePath, bytes)
      const controller = new AbortController()
      const originalWriteSync = fs.writeSync
      const writeSync = vi.spyOn(fs, 'writeSync').mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
        const written = Reflect.apply(originalWriteSync, fs, args) as number
        controller.abort()
        return written
      }) as typeof fs.writeSync)

      try {
        await expect(
          decodeLocalBackup(bundlePath, {
            maxExpandedBytes: Infinity,
            maxDatabaseBytes: Infinity,
            signal: controller.signal,
          }),
        ).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        writeSync.mockRestore()
      }
      expect(localAssetStageDirectories(harness.dataDir)).toEqual([])
    },
  )

  it('forwards the route inner-database ceiling into local-backup decoding', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-database-cap-'))
    const { app } = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      memoryWorker: false,
      commandEvents: createCommandEventSink(),
    })
    try {
      const { assertion: cappedAssertion } = await setupAuthedClient(app)
      const upload = multipartBundle(
        buildBundleZipEntries([
          { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
          { name: 'database.risu', data: Buffer.alloc(2048, 0x2a) },
        ]),
      )
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': cappedAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'Local backup database exceeds size limit' })
    } finally {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('isolates staged-asset cleanup failures and continues through every eligible file', () => {
    const preExisting = path.join(harness.dataDir, 'pre-existing-asset')
    const firstNew = path.join(harness.dataDir, 'first-new-asset')
    const secondNew = path.join(harness.dataDir, 'second-new-asset')
    const thirdNew = path.join(harness.dataDir, 'third-new-asset')
    for (const file of [preExisting, firstNew, secondNew, thirdNew]) writeFileSync(file, 'bytes')

    const failure = new Error('injected first cleanup failure')
    const originalRmSync = fs.rmSync.bind(fs)
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === firstNew) throw failure
      return originalRmSync(target, options)
    })

    const result = cleanupCopiedStagedAssetFiles([
      { file: preExisting, existedBefore: true },
      { file: firstNew, existedBefore: false },
      { file: secondNew, existedBefore: false },
      { file: thirdNew, existedBefore: false },
    ])

    expect(result).toEqual({
      attempted: 3,
      removed: 2,
      failures: [{ file: firstNew, error: failure }],
    })
    expect(rmSpy.mock.calls.map(([file]) => String(file))).toEqual([firstNew, secondNew, thirdNew])
    expect(existsSync(preExisting)).toBe(true)
    expect(existsSync(firstNew)).toBe(true)
    expect(existsSync(secondNew)).toBe(false)
    expect(existsSync(thirdNew)).toBe(false)
  })

  it('logs one aggregate rollback warning without masking the import failure or skipping later assets', async () => {
    const databaseBytes = encodeLegacyRisuSaveEnvelope(
      { characters: [], tag: 'must-roll-back-after-staged-assets' },
      'legacy-raw',
    )
    const bundle = fflate.zipSync({
      'database.risu': databaseBytes,
      'manifest.json': new TextEncoder().encode(JSON.stringify({ version: 1 })),
      [`assets/${ASSET_ID}.png`]: ASSET_BYTES,
      [`assets/${SECOND_ASSET_ID}.png`]: SECOND_ASSET_BYTES,
    })
    failCommandEventPersistence(harness.dataDir)

    const firstLiveFile = path.join(assetsDir(harness.dataDir), `${ASSET_ID}.png`)
    const secondLiveFile = path.join(assetsDir(harness.dataDir), `${SECOND_ASSET_ID}.png`)
    const cleanupFailure = new Error('injected live-file cleanup failure')
    const originalRmSync = fs.rmSync.bind(fs)
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === firstLiveFile) throw cleanupFailure
      return originalRmSync(target, options)
    })
    const warnSpy = vi.spyOn(harness.app.log, 'warn')

    const upload = multipartBundle(bundle)
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      headers: { 'content-type': upload.contentType },
      payload: upload.payload,
    })

    expect(imported.statusCode).toBe(500)
    expect(imported.json().message).toContain('injected command event failure')
    expect(existsSync(firstLiveFile)).toBe(true)
    expect(existsSync(secondLiveFile)).toBe(false)

    const db = openDatabase(harness.dataDir)
    try {
      expect(getAssetMetadataById(db, ASSET_ID)).toBeNull()
      expect(getAssetMetadataById(db, SECOND_ASSET_ID)).toBeNull()
      expect((loadPersistedWithMessages(db, harness.dataDir).database as Record<string, unknown>)?.tag).toBeUndefined()
    } finally {
      db.close()
    }

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [fields, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect(message).toBe('Bundle-import rollback could not remove some staged asset files')
    expect(fields).toMatchObject({
      failureCount: 1,
      attempted: 2,
      failedFiles: [firstLiveFile],
    })
    expect(fields.err).toBeInstanceOf(AggregateError)
    expect((fields.err as AggregateError).message).toBe(
      'Bundle-import rollback could not remove some staged asset files',
    )
    expect((fields.err as AggregateError).errors).toEqual([cleanupFailure])
  })

  it('emits no cleanup warning when rollback removes every staged asset', async () => {
    const databaseBytes = encodeLegacyRisuSaveEnvelope(
      { characters: [], tag: 'must-roll-back-with-clean-cleanup' },
      'legacy-raw',
    )
    const bundle = fflate.zipSync({
      'database.risu': databaseBytes,
      'manifest.json': new TextEncoder().encode(JSON.stringify({ version: 1 })),
      [`assets/${ASSET_ID}.png`]: ASSET_BYTES,
      [`assets/${SECOND_ASSET_ID}.png`]: SECOND_ASSET_BYTES,
    })
    failCommandEventPersistence(harness.dataDir)
    const warnSpy = vi.spyOn(harness.app.log, 'warn')

    const upload = multipartBundle(bundle)
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      headers: { 'content-type': upload.contentType },
      payload: upload.payload,
    })

    expect(imported.statusCode).toBe(500)
    expect(imported.json().message).toContain('injected command event failure')
    expect(existsSync(path.join(assetsDir(harness.dataDir), `${ASSET_ID}.png`))).toBe(false)
    expect(existsSync(path.join(assetsDir(harness.dataDir), `${SECOND_ASSET_ID}.png`))).toBe(false)
    expect(
      warnSpy.mock.calls.some(
        ([, message]) => message === 'Bundle-import rollback could not remove some staged asset files',
      ),
    ).toBe(false)
  })

  it('restores the database and bundled assets into a fresh instance', async () => {
    persistDatabaseWithAsset(harness.dataDir)
    const zip = await exportBundleZip()

    // A clean instance with no prior state, proving the bundle alone is a
    // portable backup that reconstructs both the database and its assets.
    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const warnSpy = vi.spyOn(fresh.app.log, 'warn')
      const upload = multipartBundle(zip)
      const imported = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })

      expect(imported.statusCode).toBe(200)
      const body = imported.json() as Record<string, unknown>
      expect(body.importReport).toEqual({
        incompleteChatCount: 1,
        unsupportedReferenceCount: 0,
      })
      expect(body.importReport).not.toHaveProperty('unsupportedReferences')
      expect(body).not.toHaveProperty('format')
      expect(body).not.toHaveProperty('envelope')
      expect(body.bundleReport).toEqual({ includedAssetCount: 1, assetsCreated: true })
      expect(body.assetReport).toMatchObject({ referencedCount: 1, missingCount: 0 })
      expect(typeof body.revision).toBe('number')

      // The bundled asset bytes are now served by the fresh instance.
      const asset = await fresh.app.inject({
        method: 'GET',
        url: `/api/v1/assets/${ASSET_ID}`,
      })
      expect(asset.statusCode).toBe(200)
      expect(Buffer.from(asset.rawPayload).equals(ASSET_BYTES)).toBe(true)

      // The database is restored with imported chats requiring local confirmation.
      const bootstrap = await injectComposedResourceDatabase(fresh.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': freshAssertion },
      })
      expect(bootstrap.statusCode).toBe(200)
      expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toEqual({
        configured: false,
        personaId: 'persona-a',
        modelPresetId: 'model-a',
        promptPresetId: 'prompt-a',
        jailbreakToggle: false,
        sidebarToggles: { mode: 'source-mode' },
      })

      // The character that references the asset is exportable after import.
      const exported = await fresh.app.inject({
        method: 'GET',
        url: '/api/v1/export/risusave',
        headers: { 'risu-auth': freshAssertion },
      })
      expect(exported.statusCode).toBe(200)

      // state.imported is the bundle-import success signal; per-asset events
      // are intentionally not emitted for staged backup assets.
      expect(fresh.commandEvents.list().some((event) => event.type === 'state.imported')).toBe(true)
      expect(fresh.commandEvents.list().some((event) => event.type === 'asset.created')).toBe(false)
      expect(
        warnSpy.mock.calls.some(
          ([, message]) => message === 'Bundle-import rollback could not remove some staged asset files',
        ),
      ).toBe(false)
      expect(listBackups(fresh.dataDir)).toEqual([])
    } finally {
      await stopHarness(fresh)
    }
  })

  it.each([
    ['/api/v1/export/bundle', 'database.risu.zip'],
    ['/api/v1/export/local-backup', 'database.bin'],
  ] as const)('round-trips portable tombstones through %s without operational secrets', async (url, filename) => {
    persistDatabaseWithAsset(harness.dataDir)
    const sourceDb = openDatabase(harness.dataDir)
    try {
      sourceDb.exec(`
        INSERT INTO memory_legacy_summary_tombstones (summary_id, chat_id, deleted_at)
        VALUES ('bundle-summary', 'bundle-import-chat', '2026-07-23T00:00:00.000Z');
        INSERT INTO generation_finalization_retries (
          generation_id, chat_id, mode, message_json, alternate_messages_json,
          chat_var_mutations_json, status
        ) VALUES (
          'bundle-queue-secret', 'bundle-import-chat', 'send',
          '{"role":"char","data":"bundle-queue-payload"}', '[]', '[]', 'terminal'
        );
        INSERT INTO push_subscriptions (endpoint, subscription_json)
        VALUES (
          'https://push.example/bundle-secret',
          '{"endpoint":"https://push.example/bundle-secret","keys":{"auth":"bundle-push-auth"}}'
        );
      `)
    } finally {
      sourceDb.close()
    }

    const exported = await authedInject({ method: 'GET', url })
    expect(exported.statusCode).toBe(200)
    const databaseBytes = filename.endsWith('.zip')
      ? fflate.unzipSync(new Uint8Array(exported.rawPayload))['database.risu']
      : readLegacyBinRecord(exported.rawPayload, 'database.risudat')
    const decoded = decodeRisuSaveImportSnapshot(databaseBytes)
    expect(decoded.portableMetadata).toEqual({
      version: 1,
      memoryLegacySummaryTombstones: [
        {
          summaryId: 'bundle-summary',
          chatId: 'bundle-import-chat',
          deletedAt: '2026-07-23T00:00:00.000Z',
        },
      ],
    })
    const portablePayload = JSON.stringify(decoded)
    expect(portablePayload).not.toContain('bundle-queue-secret')
    expect(portablePayload).not.toContain('bundle-queue-payload')
    expect(portablePayload).not.toContain('https://push.example/bundle-secret')
    expect(portablePayload).not.toContain('bundle-push-auth')

    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const upload = multipartBundle(exported.rawPayload, filename)
      const imported = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })
      expect(imported.statusCode).toBe(200)

      const targetDb = openDatabase(fresh.dataDir)
      try {
        expect(
          targetDb.prepare('SELECT summary_id, chat_id, deleted_at FROM memory_legacy_summary_tombstones').all(),
        ).toEqual([
          {
            summary_id: 'bundle-summary',
            chat_id: 'bundle-import-chat',
            deleted_at: '2026-07-23T00:00:00.000Z',
          },
        ])
      } finally {
        targetDb.close()
      }
      const bootstrap = await injectComposedResourceDatabase(fresh.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': freshAssertion },
      })
      expect(bootstrap.resourceDatabase).not.toHaveProperty(RISU_SERVER_DATA_KEY)
    } finally {
      await stopHarness(fresh)
    }
  })

  it('takes pre-import safety snapshots for zip and legacy .bin replacements', async () => {
    persistDatabaseWithAsset(harness.dataDir)
    const zip = await exportBundleZip()
    const exported = await authedInject({
      method: 'GET',
      url: '/api/v1/export/risusave?envelope=legacy-compressed',
    })
    expect(exported.statusCode).toBe(200)
    const legacyBin = buildLegacyBin([
      { name: 'database.risudat', data: exported.rawPayload },
      { name: `${ASSET_ID}.png`, data: ASSET_BYTES },
    ])

    for (const [bytes, filename, baselineTag] of [
      [zip, 'database.risu.zip', 'before-zip-import'],
      [legacyBin, 'database.bin', 'before-bin-import'],
    ] as const) {
      const target = await startHarness()
      try {
        const { assertion: targetAssertion } = await setupAuthedClient(target.app)
        const baseline = await target.app.inject({
          method: 'POST',
          url: '/api/v1/import/risusave',
          headers: { 'risu-auth': targetAssertion },
          payload: { database: { version: 1, tag: baselineTag } },
        })
        expect(baseline.statusCode).toBe(200)

        const upload = multipartBundle(bytes, filename)
        const imported = await target.app.inject({
          method: 'POST',
          url: '/api/v1/import/bundle',
          headers: { 'risu-auth': targetAssertion, 'content-type': upload.contentType },
          payload: upload.payload,
        })
        expect(imported.statusCode).toBe(200)

        const automatic = listBackups(target.dataDir).filter((backup) => backup.kind === 'automatic')
        expect(automatic).toHaveLength(1)
        expect(readBackupDatabase(target.dataDir, automatic[0].id)).toMatchObject({ tag: baselineTag })
      } finally {
        await stopHarness(target)
      }
    }
  })

  it('restores a legacy .bin backup from the original app (database.risudat + assets)', async () => {
    // A legacy `.bin` carries `database.risudat` (a legacy-compressed `.risu`)
    // plus content-addressed asset records named `<sha256>.<ext>`. The original
    // app and Fastify both hash asset bytes with sha256, so references resolve
    // without remapping. Produce the database bytes via the legacy export.
    persistDatabaseWithAsset(harness.dataDir)
    const exported = await authedInject({
      method: 'GET',
      url: '/api/v1/export/risusave?envelope=legacy-compressed',
    })
    expect(exported.statusCode).toBe(200)
    const databaseRisudat = exported.rawPayload

    const bin = buildLegacyBin([
      { name: 'database.risudat', data: databaseRisudat },
      // Original LocalWriter records use the asset's basename `<sha256>.png`.
      { name: `${ASSET_ID}.png`, data: ASSET_BYTES },
      // Unrelated JSON records have no server asset analogue and must be skipped.
      { name: 'somekey.json', data: Buffer.from('{"cold":true}') },
    ])

    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const upload = multipartBundle(bin, 'backup.bin')
      const imported = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })

      expect(imported.statusCode).toBe(200)
      const body = imported.json() as Record<string, unknown>
      expect(body.importReport).toEqual({
        incompleteChatCount: 1,
        unsupportedReferenceCount: 0,
      })
      expect(body.importReport).not.toHaveProperty('unsupportedReferences')
      expect(body).not.toHaveProperty('format')
      // Only the content-addressed media record registered; the unrelated `.json` was skipped.
      expect(body.bundleReport).toEqual({ includedAssetCount: 1, assetsCreated: true })
      expect(body.assetReport).toMatchObject({ referencedCount: 1, missingCount: 0 })

      const asset = await fresh.app.inject({ method: 'GET', url: `/api/v1/assets/${ASSET_ID}` })
      expect(asset.statusCode).toBe(200)
      expect(Buffer.from(asset.rawPayload).equals(ASSET_BYTES)).toBe(true)
    } finally {
      await stopHarness(fresh)
    }
  })

  it('rejects group characters in zip and legacy bin backups without replacing the live database', async () => {
    persistDatabaseWithGroup(harness.dataDir)
    const zip = await exportBundleZip()
    const localBackup = await authedInject({ method: 'GET', url: '/api/v1/export/local-backup' })
    expect(localBackup.statusCode).toBe(200)

    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const before = await injectComposedResourceDatabase(fresh.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': freshAssertion },
      })
      expect(before.statusCode).toBe(200)

      for (const [bytes, filename] of [
        [zip, 'group-backup.risu.zip'],
        [localBackup.rawPayload, 'group-backup.bin'],
      ] as const) {
        const upload = multipartBundle(bytes, filename)
        const imported = await fresh.app.inject({
          method: 'POST',
          url: '/api/v1/import/bundle',
          headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
          payload: upload.payload,
        })

        expect(imported.statusCode).toBe(422)
        expect(imported.json()).toMatchObject({
          code: 'unsupported-group-characters',
          unsupportedGroupCount: 1,
          unsupportedGroups: [{ id: 'legacy-group-a', name: 'Legacy Party' }],
          error: expect.stringContaining('active database was not changed'),
        })
      }

      const after = await injectComposedResourceDatabase(fresh.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': freshAssertion },
      })
      expect(after.json()).toMatchObject({
        revision: before.json().revision,
        databaseLineage: before.json().databaseLineage,
      })
      expect(after.resourceDatabase).toEqual(before.resourceDatabase)
      expect(fresh.commandEvents.list().some((event) => event.type === 'state.imported')).toBe(false)
    } finally {
      await stopHarness(fresh)
    }
  })

  it('salvages supported bundle blocks and reports skipped standalone CHAT blocks', async () => {
    persistLiveDatabase(harness.dataDir)
    const before = await authedComposedResourceDatabase({ method: 'GET', url: '/api/v1/bootstrap' })
    const databaseBytes = encodeRisuSaveBlockEnvelope([
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({
          version: 2,
          tag: 'salvaged-bundle',
          __directory: ['supported-character', 'standalone-chat'],
        }),
      },
      {
        name: 'supported-character',
        type: RisuSaveBlockType.CHARACTER_WITHOUT_CHAT,
        data: JSON.stringify({ chaId: 'bundle-char', name: 'Bundle Character', chats: [] }),
      },
      {
        name: 'standalone-chat',
        type: RisuSaveBlockType.CHAT,
        data: JSON.stringify({ id: 'standalone-chat', name: 'Unsupported Chat', message: [] }),
      },
    ])
    const upload = multipartBundle(buildBundleZip(databaseBytes))

    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      headers: { 'content-type': upload.contentType },
      payload: upload.payload,
    })

    expect(imported.statusCode).toBe(200)
    expect(imported.json()).toMatchObject({
      importReport: {
        skippedBlocks: [{ name: 'standalone-chat', type: 'CHAT' }],
      },
      assetReport: { orphanedCount: 1 },
      bundleReport: { includedAssetCount: 1, assetsCreated: true },
    })

    const after = await authedComposedResourceDatabase({ method: 'GET', url: '/api/v1/bootstrap' })
    expect(after.resourceDatabase).toMatchObject({
      tag: 'salvaged-bundle',
      characters: [expect.objectContaining({ chaId: 'bundle-char', name: 'Bundle Character' })],
    })
    expect(after.resourceDatabase.tag).not.toBe(before.resourceDatabase.tag)
    expect(listBackups(harness.dataDir)).toHaveLength(1)
    const importedAsset = await authedInject({ method: 'GET', url: `/api/v1/assets/${ASSET_ID}` })
    expect(importedAsset.statusCode).toBe(200)
    expect(harness.commandEvents.list().map((event) => event.type)).toContain('state.imported')
  })

  it('canonicalizes original-backup media references with non-sha256 record names', async () => {
    const legacyRecordName = '550e8400-e29b-41d4-a716-446655440000.png'
    persistDatabaseWithAsset(harness.dataDir, `assets/${legacyRecordName}`)
    const exported = await authedInject({
      method: 'GET',
      url: '/api/v1/export/risusave?envelope=legacy-compressed',
    })
    expect(exported.statusCode).toBe(200)

    const bin = buildLegacyBin([
      { name: legacyRecordName, data: ASSET_BYTES },
      { name: 'database.risudat', data: exported.rawPayload },
    ])
    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const upload = multipartBundle(bin, 'original-custom-id.bin')
      const imported = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })

      expect(imported.statusCode).toBe(200)
      expect(imported.json()).toMatchObject({
        bundleReport: { includedAssetCount: 1, assetsCreated: true },
        assetReport: { referencedCount: 1, missingCount: 0 },
      })

      const db = openDatabase(fresh.dataDir)
      try {
        const database = loadPersistedWithMessages(db, fresh.dataDir).database as {
          characters: Array<{ image: string }>
        }
        expect(database.characters[0].image).toBe(ASSET_ID)
      } finally {
        db.close()
      }

      const asset = await fresh.app.inject({ method: 'GET', url: `/api/v1/assets/${ASSET_ID}` })
      expect(asset.statusCode).toBe(200)
      expect(Buffer.from(asset.rawPayload).equals(ASSET_BYTES)).toBe(true)
    } finally {
      await stopHarness(fresh)
    }
  })

  it('round-trips supported non-media assets through a legacy .bin backup', async () => {
    const assetCases = [
      {
        fileName: 'model.onnx',
        ext: 'onnx',
        contentType: 'application/x-onnx',
        bytes: Buffer.from('local-backup-onnx-bytes'),
      },
      {
        fileName: 'theme.css',
        ext: 'css',
        contentType: 'text/css',
        bytes: Buffer.from('.local-backup { color: rebeccapurple; }'),
      },
      {
        fileName: 'signature.json',
        ext: 'json',
        contentType: 'application/x-risu-inlay-signature+json',
        bytes: Buffer.from('{"signature":"local-backup"}'),
      },
    ].map((asset) => ({
      ...asset,
      id: createHash('sha256').update(asset.bytes).digest('hex'),
    }))

    const sourceDb = openDatabase(harness.dataDir)
    try {
      writePersistedWithMessages(sourceDb, harness.dataDir, {
        _version: 1,
        database: {
          version: 1,
          selectedCharID: 0,
          characters: [],
          characterOrder: [],
          botPresets: [],
          modules: [
            {
              id: 'non-media-module',
              name: 'Non-media module',
              assets: assetCases.map((asset) => [asset.fileName, asset.id, asset.ext]),
            },
          ],
          loadouts: [],
          plugins: [],
          pluginCustomStorage: {},
        },
        assets: [],
      })
      insertAssetMetadataBatch(
        sourceDb,
        assetCases.map((asset) => ({
          id: asset.id,
          ext: asset.ext,
          size: asset.bytes.length,
          contentType: asset.contentType,
        })),
      )
    } finally {
      sourceDb.close()
    }

    mkdirSync(assetsDir(harness.dataDir), { recursive: true })
    for (const asset of assetCases) {
      writeFileSync(path.join(assetsDir(harness.dataDir), `${asset.id}.${asset.ext}`), asset.bytes)
    }

    const exported = await authedInject({ method: 'GET', url: '/api/v1/export/local-backup' })
    expect(exported.statusCode).toBe(200)

    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const upload = multipartBundle(exported.rawPayload, 'backup.bin')
      const imported = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })

      expect(imported.statusCode).toBe(200)
      const body = imported.json() as Record<string, unknown>
      expect(body.bundleReport).toEqual({ includedAssetCount: assetCases.length, assetsCreated: true })
      expect(body.assetReport).toMatchObject({
        referencedCount: assetCases.length,
        missingCount: 0,
      })

      for (const asset of assetCases) {
        const restored = await fresh.app.inject({ method: 'GET', url: `/api/v1/assets/${asset.id}` })
        expect(restored.statusCode).toBe(200)
        expect(restored.headers['content-type']).toContain(asset.contentType)
        expect(Buffer.from(restored.rawPayload).equals(asset.bytes)).toBe(true)
      }

      const restoredDb = openDatabase(fresh.dataDir)
      try {
        const database = loadPersistedWithMessages(restoredDb, fresh.dataDir).database as Record<string, unknown>
        const modules = database.modules as Array<{ assets: Array<[string, string, string]> }>
        expect(modules[0].assets.map((asset) => asset[1])).toEqual(assetCases.map((asset) => asset.id))
      } finally {
        restoredDb.close()
      }
    } finally {
      await stopHarness(fresh)
    }
  })

  it('rejects a zip backup with assets and malformed database.risu without persisting asset side effects', async () => {
    persistDatabaseWithAsset(harness.dataDir)
    const files = fflate.unzipSync(new Uint8Array(await exportBundleZip()))
    files['database.risu'] = new TextEncoder().encode('not a valid risu database')
    const tampered = fflate.zipSync(files)

    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const upload = multipartBundle(tampered)
      const imported = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })

      expect(imported.statusCode).toBe(400)
      await expectNoImportedAssetSideEffects(fresh)
    } finally {
      await stopHarness(fresh)
    }
  })

  it('rejects a legacy .bin backup with assets and malformed database.risudat without persisting asset side effects', async () => {
    const bin = buildLegacyBin([
      { name: 'database.risudat', data: new TextEncoder().encode('not a valid risu database') },
      { name: `${ASSET_ID}.png`, data: ASSET_BYTES },
    ])

    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const upload = multipartBundle(bin, 'backup.bin')
      const imported = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })

      expect(imported.statusCode).toBe(400)
      await expectNoImportedAssetSideEffects(fresh)
    } finally {
      await stopHarness(fresh)
    }
  })

  it('rejects hollow bundle and legacy .bin databases before snapshots, assets, or live mutations', async () => {
    persistLiveDatabase(harness.dataDir)
    const before = await authedComposedResourceDatabase({ method: 'GET', url: '/api/v1/bootstrap' })
    const hollowDatabase = encodeLegacyRisuSaveEnvelope({}, 'legacy-compressed')
    const inputs = [
      { bytes: buildBundleZip(hollowDatabase), filename: 'hollow.risu.zip' },
      {
        bytes: buildLegacyBin([
          { name: 'database.risudat', data: hollowDatabase },
          { name: `${ASSET_ID}.png`, data: ASSET_BYTES },
        ]),
        filename: 'hollow.bin',
      },
    ]

    for (const input of inputs) {
      const upload = multipartBundle(input.bytes, input.filename)
      const imported = await authedInject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'content-type': upload.contentType },
        payload: upload.payload,
      })
      expect(imported.statusCode).toBe(400)
      expect(imported.json()).toEqual({ error: RISUSAVE_EMPTY_DATABASE_ERROR })
    }

    const after = await authedComposedResourceDatabase({ method: 'GET', url: '/api/v1/bootstrap' })
    expect(after.json()).toMatchObject({
      revision: before.json().revision,
      databaseLineage: before.json().databaseLineage,
    })
    expect(after.resourceDatabase).toEqual(before.resourceDatabase)
    expect(listBackups(harness.dataDir)).toEqual([])
    await expectNoImportedAssetSideEffects(harness)
  })

  it('rejects an exact-block-boundary truncated bundle before snapshots, assets, or live mutations', async () => {
    persistLiveDatabase(harness.dataDir)
    const before = await authedComposedResourceDatabase({ method: 'GET', url: '/api/v1/bootstrap' })
    const blocks = [
      {
        name: 'root',
        type: RisuSaveBlockType.ROOT,
        data: JSON.stringify({ version: 2, __directory: ['preset', 'modules', 'config'] }),
      },
      {
        name: 'preset',
        type: RisuSaveBlockType.BOTPRESET,
        data: JSON.stringify([]),
      },
      {
        name: 'modules',
        type: RisuSaveBlockType.MODULES,
        data: JSON.stringify([]),
      },
      {
        name: 'config',
        type: RisuSaveBlockType.CONFIG,
        data: JSON.stringify({ version: 1 }),
      },
    ]
    const complete = encodeRisuSaveBlockEnvelope(blocks)
    const boundary = encodeRisuSaveBlockEnvelope(blocks.slice(0, 2)).byteLength
    const upload = multipartBundle(buildBundleZip(complete.slice(0, boundary)), 'truncated.risu.zip')
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      headers: { 'content-type': upload.contentType },
      payload: upload.payload,
    })

    expect(imported.statusCode).toBe(400)
    expect(imported.json()).toEqual({ error: RISUSAVE_INCOMPLETE_BLOCKS_ERROR })
    const after = await authedComposedResourceDatabase({ method: 'GET', url: '/api/v1/bootstrap' })
    expect(after.json()).toMatchObject({
      revision: before.json().revision,
      databaseLineage: before.json().databaseLineage,
    })
    expect(after.resourceDatabase).toEqual(before.resourceDatabase)
    expect(listBackups(harness.dataDir)).toEqual([])
    await expectNoImportedAssetSideEffects(harness)
  })

  it('accepts an upload larger than the global body limit', async () => {
    // The harness body limit is 4 MiB; the device-import route uses its own
    // (much larger) limit and streams the upload to disk, so a bundle bigger
    // than the body limit must still import.
    const bigBytes = Buffer.alloc(5 * 1024 * 1024, 7)
    const bigId = createHash('sha256').update(bigBytes).digest('hex')
    const bigDb = openDatabase(harness.dataDir)
    try {
      writePersistedWithMessages(bigDb, harness.dataDir, {
        _version: 1,
        database: {
          version: 1,
          selectedCharID: 0,
          characters: [{ chaId: 'big', name: 'Big', image: bigId, chats: [] }],
          characterOrder: ['big'],
          botPresets: [],
          modules: [],
          loadouts: [],
          plugins: [],
          pluginCustomStorage: {},
        },
        assets: [],
      })
      insertAssetMetadataBatch(bigDb, [{ id: bigId, ext: 'png', size: bigBytes.length, contentType: 'image/png' }])
    } finally {
      bigDb.close()
    }
    const dir = assetsDir(harness.dataDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${bigId}.png`), bigBytes)

    const zip = await exportBundleZip()
    expect(zip.length).toBeGreaterThan(4 * 1024 * 1024)

    const fresh = await startHarness()
    try {
      const { assertion: freshAssertion } = await setupAuthedClient(fresh.app)
      const upload = multipartBundle(zip)
      const imported = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': freshAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })
      expect(imported.statusCode).toBe(200)
      const asset = await fresh.app.inject({ method: 'GET', url: `/api/v1/assets/${bigId}` })
      expect(asset.statusCode).toBe(200)
    } finally {
      await stopHarness(fresh)
    }
  })

  it('rejects a device-backup upload larger than a configured finite ceiling', async () => {
    // The import ceiling defaults to unlimited (multi-GB backups stream in with
    // bounded memory), but an operator can still cap it via importMaxBytes. With
    // a tiny cap, an over-limit upload is truncated mid-stream and rejected
    // rather than silently saved.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-import-cap-'))
    const { app } = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 4 * 1024 * 1024,
        importMaxBytes: 1024,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      memoryWorker: false,
      commandEvents: createCommandEventSink(),
    })
    try {
      const { assertion: capAssertion } = await setupAuthedClient(app)
      const oversized = buildLegacyBin([{ name: 'database.risudat', data: Buffer.alloc(4096, 1) }])
      const upload = multipartBundle(oversized, 'backup.bin')
      const imported = await app.inject({
        method: 'POST',
        url: '/api/v1/import/bundle',
        headers: { 'risu-auth': capAssertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })
      expect(imported.statusCode).toBe(400)
      expect((imported.json() as { error: string }).error).toContain('exceeds size limit')
    } finally {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects unauthenticated bundle imports once a password is set', async () => {
    persistDatabaseWithAsset(harness.dataDir)
    const zip = await exportBundleZip()
    const upload = multipartBundle(zip)

    const imported = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: upload.payload,
      headers: { 'content-type': upload.contentType },
    })
    expect(imported.statusCode).toBe(401)
  })

  it('rejects non-multipart bundle imports', async () => {
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: { database: {} },
    })
    expect(imported.statusCode).toBe(400)
    expect(imported.json()).toEqual({
      error: 'backup import requires a multipart .risu.zip or .bin upload',
    })
  })

  it('rejects archives that are not valid zips', async () => {
    const upload = multipartBundle(new TextEncoder().encode('not a zip at all'))
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: upload.payload,
      headers: { 'content-type': upload.contentType },
    })
    expect(imported.statusCode).toBe(400)
  })

  it('caps the expanded size of the embedded database.risu even when the bundle import is unlimited', async () => {
    // importMaxBytes is Infinity in this harness, so the inner `.risu` falls
    // back to the expanded-import cap (bodyLimit = 4 MiB). A tiny gzip that
    // expands past that must be rejected during inflate, not materialized.
    const { encodeLegacyRisuSaveEnvelope } = await import('../src/risuSave/legacyEnvelopeCodec.js')
    const bomb = encodeLegacyRisuSaveEnvelope({ version: 1, blob: 'x'.repeat(6 * 1024 * 1024) }, 'legacy-stream')
    const zip = fflate.zipSync({
      'database.risu': bomb,
      'manifest.json': new TextEncoder().encode(JSON.stringify({ version: 1 })),
    })

    const upload = multipartBundle(zip)
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: upload.payload,
      headers: { 'content-type': upload.contentType },
    })
    expect(imported.statusCode).toBe(400)
    expect((imported.json() as { error: string }).error).toContain('exceeds size limit')
  })

  it('rejects a bundle whose manifest version is unsupported', async () => {
    persistDatabaseWithAsset(harness.dataDir)
    const files = fflate.unzipSync(new Uint8Array(await exportBundleZip()))
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'))
    manifest.version = 2
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    const tampered = fflate.zipSync(files)

    const upload = multipartBundle(tampered)
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: upload.payload,
      headers: { 'content-type': upload.contentType },
    })
    expect(imported.statusCode).toBe(400)
    expect((imported.json() as { error: string }).error).toContain('manifest version')
  })

  it.each([
    {
      label: 'duplicate entry names',
      entries: [
        { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
        { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
      ],
      expected: 'duplicate entry',
    },
    {
      label: 'ambiguous database names',
      entries: [
        { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
        { name: 'replacement.risu', data: encodeLegacyRisuSaveEnvelope({ version: 1 }, 'legacy-raw') },
      ],
      expected: 'must be named database.risu',
    },
    {
      label: 'oversized entry names',
      entries: [
        { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ version: 1 })) },
        { name: 'x'.repeat(LOCAL_BACKUP_ZIP_MAX_NAME_BYTES + 1) },
      ],
      expected: `entry name exceeds ${LOCAL_BACKUP_ZIP_MAX_NAME_BYTES} bytes`,
    },
  ])('rejects structurally ambiguous bundles with $label', async ({ entries, expected }) => {
    const upload = multipartBundle(buildBundleZipEntries(entries))
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: upload.payload,
      headers: { 'content-type': upload.contentType },
    })

    expect(imported.statusCode).toBe(400)
    expect((imported.json() as { error: string }).error).toContain(expected)
  })

  it('bounds zero-byte bundle entry cardinality independently of expanded bytes', async () => {
    const entries = Array.from({ length: LOCAL_BACKUP_ZIP_MAX_ENTRIES + 1 }, (_, index) => ({
      name: `empty/${index}`,
    }))
    const upload = multipartBundle(buildBundleZipEntries(entries))

    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: upload.payload,
      headers: { 'content-type': upload.contentType },
    })

    expect(imported.statusCode).toBe(400)
    expect((imported.json() as { error: string }).error).toContain(
      `.risu bundle exceeds ${LOCAL_BACKUP_ZIP_MAX_ENTRIES} entries`,
    )
  })

  it('rejects a bundle whose asset bytes do not match their content hash', async () => {
    persistDatabaseWithAsset(harness.dataDir)
    const files = fflate.unzipSync(new Uint8Array(await exportBundleZip()))
    files[`assets/${ASSET_ID}.png`] = new TextEncoder().encode('tampered asset bytes')
    const tampered = fflate.zipSync(files)

    const upload = multipartBundle(tampered)
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: upload.payload,
      headers: { 'content-type': upload.contentType },
    })
    expect(imported.statusCode).toBe(400)
    expect((imported.json() as { error: string }).error).toContain('content hash')
  })

  it('refuses bundle imports from a stale (non-active) writer session', async () => {
    persistDatabaseWithAsset(harness.dataDir)
    const zip = await exportBundleZip()

    // Latch session-a as the active writer via the writer-intent bootstrap.
    const bootstrap = await authedComposedResourceDatabase({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { [ACTIVE_WRITER_SESSION_HEADER]: 'session-a' },
    })
    expect(bootstrap.statusCode).toBe(200)

    const upload = multipartBundle(zip)
    const imported = await authedInject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      payload: upload.payload,
      headers: { 'content-type': upload.contentType },
    })
    expect(imported.statusCode).toBe(423)
    expect(imported.json()).toMatchObject({ error: 'active_writer_stale' })
  })
})
