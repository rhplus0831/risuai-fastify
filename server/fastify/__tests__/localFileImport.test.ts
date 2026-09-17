import { request } from 'node:http'
import { getMaintenanceCoordinator } from '../src/maintenanceCoordinator.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, createCipheriv } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as fflate from 'fflate'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { getSchemaState } from '../src/db.js'
import { getAllAssetMetadata, loadPersisted } from '../src/repository.js'
import { setupAuthedClient } from './helpers/auth.js'

interface Harness {
  app: FastifyInstance
  dataDir: string
}

const rpackMap = readFileSync(path.join(process.cwd(), 'src/ts/rpack/rpack_map.bin'))
const rpackEncodeMap = rpackMap.subarray(0, 256)

async function startHarness(maxExpandedBytes?: number): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-local-file-import-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: 16 * 1024 * 1024,
      realmImportMaxExpandedBytes: maxExpandedBytes,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    memoryWorker: false,
  })
  return { app, dataDir }
}

function currentRevision(dataDir: string): number {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    return getSchemaState(db).revision
  } finally {
    db.close()
  }
}

function persistedState(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    return {
      database: loadPersisted(db, dataDir).database as Record<string, unknown>,
      assets: getAllAssetMetadata(db),
    }
  } finally {
    db.close()
  }
}

function multipartFile(bytes: Uint8Array, filename: string) {
  const boundary = `risu-local-import-${Date.now()}`
  const head = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: application/octet-stream',
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

function encodeRpack(data: Uint8Array): Buffer {
  const encoded = Buffer.alloc(data.byteLength)
  for (let index = 0; index < data.byteLength; index += 1) encoded[index] = rpackEncodeMap[data[index]]
  return encoded
}

function risum(module: Record<string, unknown>, assets: readonly Uint8Array[] = []): Buffer {
  const headerPayload = encodeRpack(Buffer.from(JSON.stringify({ type: 'risuModule', module })))
  const header = Buffer.alloc(6)
  header.writeUInt8(111, 0)
  header.writeUInt8(0, 1)
  header.writeUInt32LE(headerPayload.length, 2)
  const chunks: Buffer[] = [header, headerPayload]
  for (const asset of assets) {
    const encoded = encodeRpack(asset)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(encoded.length, 0)
    chunks.push(Buffer.from([1]), length, encoded)
  }
  chunks.push(Buffer.from([0]))
  return Buffer.concat(chunks)
}

function characterArchive(mainImage: Uint8Array): Uint8Array {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Uploaded Character',
      description: 'Processed by Fastify',
      personality: '',
      scenario: '',
      first_mes: 'Hello',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: { risuai: {} },
      assets: [{ type: 'icon', uri: 'embeded://assets/main.png', name: 'main', ext: 'png' }],
    },
  }
  return fflate.zipSync(
    {
      'card.json': Buffer.from(JSON.stringify(card)),
      'assets/main.png': mainImage,
    },
    { level: 0 },
  )
}

function readImportFrames(text: string) {
  return text
    .trim()
    .split('\n\n')
    .map((block) => {
      const [event, data] = block.split('\n')
      return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) }
    })
}

let harness: Harness
let assertion: string

beforeEach(async () => {
  harness = await startHarness()
  ;({ assertion } = await setupAuthedClient(harness.app))
  const initialized = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/commands/state/initialize',
    headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    payload: {},
  })
  expect(initialized.statusCode, initialized.body).toBe(200)
})

afterEach(async () => {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

describe('local character and module file imports', () => {
  it.each([false, true])('uploads one CharX file and creates the character (progress: %s)', async (streaming) => {
    const mainImage = Buffer.from('server-side character image')
    const upload = multipartFile(characterArchive(mainImage), 'character.charx')
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/character-card?baseRevision=${currentRevision(harness.dataDir)}`,
      headers: {
        'content-type': upload.contentType,
        ...(streaming ? { accept: 'text/event-stream' } : {}),
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: upload.payload,
    })

    expect(response.statusCode, response.body).toBe(200)
    let body = response.json.bind(response)
    if (streaming) {
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(response.headers['x-accel-buffering']).toBe('no')
      const frames = readImportFrames(response.body)
      const progress = frames.filter((frame) => frame.event === 'progress').map((frame) => frame.data)
      expect([...new Set(progress.map((frame) => frame.phase))]).toEqual(['read', 'assets', 'convert', 'commit'])
      expect(progress).toContainEqual(
        expect.objectContaining({
          phase: 'assets',
          completedAssets: 1,
          completedBytes: characterArchive(mainImage).byteLength,
          totalBytes: characterArchive(mainImage).byteLength,
        }),
      )
      expect(frames.at(-1)).toMatchObject({ event: 'result', data: { statusCode: 200 } })
      body = () => frames.at(-1)!.data.body
    }
    expect(body()).toMatchObject({
      event: { type: 'character.created', resource: 'character' },
      characterId: expect.any(String),
      importReport: { droppedArchiveEntries: [], droppedInlineAssets: [] },
    })
    const state = persistedState(harness.dataDir)
    const characters = state.database.characters as Array<Record<string, unknown>>
    expect(characters).toHaveLength(1)
    expect(characters[0]).toMatchObject({
      name: 'Uploaded Character',
      image: createHash('sha256').update(mainImage).digest('hex'),
    })
    expect(state.assets).toHaveLength(1)
  })

  it('preserves streamed confirmation, validation and revision-conflict results', async () => {
    const headers = { 'risu-auth': assertion, 'risu-writer-session': 'writer-a', accept: 'text/event-stream' }
    const card = {
      spec: 'chara_card_v3',
      data: { name: 'Confirmed bot', extensions: { risuai: { lowLevelAccess: true } } },
    }
    const upload = multipartFile(Buffer.from(JSON.stringify(card)), 'character.json')
    const baseRevision = currentRevision(harness.dataDir)
    const challenge = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/character-card?baseRevision=${baseRevision}`,
      headers: { ...headers, 'content-type': upload.contentType },
      payload: upload.payload,
    })
    const challengeResult = readImportFrames(challenge.body).at(-1)!.data
    expect(challengeResult).toMatchObject({
      statusCode: 409,
      body: { code: 'low_level_access_confirmation_required', pendingImportToken: expect.any(String) },
    })
    expect(persistedState(harness.dataDir).database.characters).toHaveLength(0)
    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/character-card',
      headers,
      payload: { baseRevision, pendingImportToken: challengeResult.body.pendingImportToken, allowLowLevelAccess: true },
    })
    expect(readImportFrames(accepted.body).at(-1)).toMatchObject({
      event: 'result',
      data: { statusCode: 200, body: { characterId: expect.any(String) } },
    })

    const malformed = multipartFile(Buffer.from('{bad json'), 'character.json')
    const failed = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/character-card?baseRevision=${currentRevision(harness.dataDir)}`,
      headers: { ...headers, 'content-type': malformed.contentType },
      payload: malformed.payload,
    })
    expect(readImportFrames(failed.body).at(-1)).toMatchObject({
      event: 'result',
      data: { statusCode: 400, body: { error: expect.any(String) } },
    })
    const stale = multipartFile(characterArchive(Buffer.from('image')), 'character.charx')
    const conflict = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/character-card?baseRevision=${baseRevision}`,
      headers: { ...headers, 'content-type': stale.contentType },
      payload: stale.payload,
    })
    expect(readImportFrames(conflict.body).at(-1)).toMatchObject({
      event: 'result',
      data: { statusCode: 409, body: { currentRevision: currentRevision(harness.dataDir) } },
    })
    expect(persistedState(harness.dataDir).database.characters).toHaveLength(1)
  })

  it('keeps a low-level .risum on the server, then creates it after token confirmation', async () => {
    const assetBytes = Buffer.from('module webp bytes')
    const moduleBytes = risum(
      {
        id: 'source-module-id',
        name: 'Uploaded Module',
        description: 'Processed by Fastify',
        lowLevelAccess: true,
        assets: [['portrait', '', 'portrait.webp']],
      },
      [assetBytes],
    )
    const upload = multipartFile(moduleBytes, 'module.risum')
    const baseRevision = currentRevision(harness.dataDir)
    const challenge = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/module?baseRevision=${baseRevision}`,
      headers: {
        'content-type': upload.contentType,
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: upload.payload,
    })

    expect(challenge.statusCode).toBe(409)
    const challengeBody = challenge.json() as { pendingImportToken: string }
    expect(challengeBody).toMatchObject({
      code: 'low_level_access_confirmation_required',
      pendingImportToken: expect.any(String),
    })
    expect(persistedState(harness.dataDir).database.modules as unknown[]).toHaveLength(0)
    expect(persistedState(harness.dataDir).assets).toHaveLength(0)

    const confirmed = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/module',
      headers: {
        'content-type': 'application/json',
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: {
        baseRevision,
        pendingImportToken: challengeBody.pendingImportToken,
        allowLowLevelAccess: true,
      },
    })

    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json()).toMatchObject({
      event: { type: 'module.created', resource: 'moduleCreated' },
      moduleId: expect.any(String),
    })
    const state = persistedState(harness.dataDir)
    const modules = state.database.modules as Array<Record<string, unknown>>
    expect(modules).toHaveLength(1)
    expect(modules[0]).toMatchObject({
      id: expect.not.stringMatching(/^source-module-id$/),
      name: 'Uploaded Module',
      lowLevelAccess: true,
      assets: [['portrait', createHash('sha256').update(assetBytes).digest('hex'), 'portrait.webp']],
    })
    expect(state.assets).toHaveLength(1)
  })

  it('accepts the existing top-level JSON risuModule interchange shape', async () => {
    const upload = multipartFile(
      Buffer.from(
        JSON.stringify({
          type: 'risuModule',
          id: 'source-json-id',
          name: 'JSON Module',
          description: 'Existing JSON interchange shape',
          folderId: 'foreign-folder',
        }),
      ),
      'module.json',
    )
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/module?baseRevision=${currentRevision(harness.dataDir)}`,
      headers: {
        'content-type': upload.contentType,
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: upload.payload,
    })

    expect(response.statusCode, response.body).toBe(200)
    const modules = persistedState(harness.dataDir).database.modules as Array<Record<string, unknown>>
    expect(modules).toHaveLength(1)
    expect(modules[0]).toMatchObject({
      id: expect.not.stringMatching(/^source-json-id$/),
      name: 'JSON Module',
      description: 'Existing JSON interchange shape',
    })
    expect(modules[0]).not.toHaveProperty('folderId')
  })
})

// These requests opt into live intake, rather than only a streamed response.
describe('live local-file ingestion', () => {
  function streamingUpload(bytes: Uint8Array, filename: string, options: Record<string, unknown> = {}) {
    const upload = multipartFile(bytes, filename)
    const boundary = upload.contentType.split('boundary=')[1]
    const field = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${JSON.stringify(options)}\r\n`,
    )
    return { ...upload, payload: Buffer.concat([field, upload.payload]) }
  }
  async function send(bytes: Uint8Array, filename: string, kind = 'character-card', options = {}) {
    const upload = streamingUpload(bytes, filename, options)
    return harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/${kind}?stream=1&baseRevision=${currentRevision(harness.dataDir)}`,
      headers: { 'content-type': upload.contentType, 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: upload.payload,
    })
  }
  it.each([
    ['bot.json', 'character-card', { name: 'Bot', description: 'Description', first_mes: 'Hello' }],
    ['module.json', 'module', { type: 'risuModule', module: { id: 'old', name: 'Module' } }],
    ['module.lorebook', 'module', { type: 'risuModule', module: { id: 'old', name: 'Module' } }],
  ] as const)('enforces the configured JSON limit for %s at the route', async (filename, kind, data) => {
    await harness.app.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
    harness = await startHarness(1024)
    ;({ assertion } = await setupAuthedClient(harness.app))
    const initialized = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: {},
    })
    expect(initialized.statusCode, initialized.body).toBe(200)
    const response = await send(Buffer.from(JSON.stringify(data) + ' '.repeat(1024)), filename, kind)
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().error).toContain('exceeds size limit')
    const state = persistedState(harness.dataDir).database
    expect(state.characters ?? []).toHaveLength(0)
    expect(state.modules ?? []).toHaveLength(0)
  })

  it.each([
    ['bot.json', 'character', { name: 'Large bot', description: 'Description', first_mes: 'Hello' }],
    ['module.json', 'module', { type: 'risuModule', module: { id: 'old', name: 'Large module' } }],
    ['module.lorebook', 'module', { type: 'risuModule', module: { id: 'old', name: 'Large module' } }],
  ] as const)('imports standalone %s above 50 MiB within the configured limit', async (fileName, kind, data) => {
    const { importLocalFileStream } = await import('../src/localFileImport.js')
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    async function* source() {
      yield Buffer.from(JSON.stringify(data))
      const padding = Buffer.alloc(1024 * 1024, 32)
      for (let i = 0; i < 51; i++) yield padding
    }
    try {
      const imported = await importLocalFileStream({
        kind,
        source: source(),
        db,
        dataDir: harness.dataDir,
        fileName,
        maxExpandedBytes: 310 * 1024 * 1024,
      })
      expect(imported).toMatchObject(
        kind === 'character' ? { character: { name: 'Large bot' } } : { module: { name: 'Large module' } },
      )
    } finally {
      db.close()
    }
  })
  it('accepts a large risum header within the configured allowance and rejects it above that allowance', async () => {
    const { importLocalFileStream } = await import('../src/localFileImport.js')
    const bytes = risum({ id: 'old', name: 'Large module', description: 'x'.repeat(51 * 1024 * 1024) })
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    const importing = (maxExpandedBytes: number) =>
      importLocalFileStream({
        kind: 'module',
        fileName: 'large.risum',
        db,
        dataDir: harness.dataDir,
        maxExpandedBytes,
        source: (async function* () {
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
            yield bytes.subarray(offset, offset + 64 * 1024)
        })(),
      })
    try {
      await expect(importing(50 * 1024 * 1024)).rejects.toThrow('exceeds size limit')
      const result = await importing(60 * 1024 * 1024)
      expect(result).toMatchObject({ module: { name: 'Large module' } })
      expect('module' in result && (result.module.description as string).length).toBe(51 * 1024 * 1024)
    } finally {
      db.close()
    }
  })

  it.each(
    ['module', 'character-card'].flatMap((kind) =>
      ['live', 'retained'].flatMap((mode) => ['before-file', 'during-file'].map((phase) => ({ kind, mode, phase }))),
    ),
  )('drains a stalled $kind upload ($mode, $phase) on server shutdown', async ({ kind, mode, phase }) => {
    const address = await harness.app.listen({ host: '127.0.0.1', port: 0 })
    const boundary = 'stalled-import'
    const coordinator = getMaintenanceCoordinator(harness.dataDir)
    const admission = vi.spyOn(coordinator, 'beginAssetStaging')
    const upload = request(
      `${address}/api/v1/import/${kind}?stream=${mode === 'live' ? 1 : 0}&baseRevision=${currentRevision(harness.dataDir)}`,
      {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'risu-auth': assertion,
          'risu-writer-session': 'writer-a',
          ...(kind === 'character-card' ? { accept: 'text/event-stream' } : {}),
        },
      },
      (response) => response.resume(),
    )
    upload.on('error', () => {})
    let closing: Promise<void> | undefined
    try {
      const filename = kind === 'module' ? 'stalled.risum' : 'stalled.charx'
      upload.write(`--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n{}\r\n`)
      if (phase === 'during-file') {
        upload.write(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        )
        upload.write(Buffer.from(kind === 'module' ? [111, 0] : [80, 75]))
      }
      await vi.waitFor(() => expect(admission).toHaveBeenCalled())
      if (mode === 'live' && phase === 'during-file') {
        await vi.waitFor(() => expect(coordinator.isReclamationBlocked()).toBe(true))
      }
      let closed = false
      closing = harness.app.close().then(() => {
        closed = true
      })
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 })
      expect(coordinator.isClosed).toBe(true)
    } finally {
      upload.destroy()
      await closing
      admission.mockRestore()
    }
  })

  it('imports a metadata-last archive and requires server-side consent despite client preflight', async () => {
    const image = Buffer.from('live intake image')
    const files = fflate.unzipSync(characterArchive(image))
    const data = JSON.parse(Buffer.from(files['card.json']).toString())
    data.data.extensions.risuai.lowLevelAccess = true
    const archive = fflate.zipSync({ 'assets/main.png': image, 'card.json': Buffer.from(JSON.stringify(data)) })
    const denied = await send(archive, 'bot.charx')
    expect(denied.statusCode, denied.body).toBe(400)
    expect(persistedState(harness.dataDir).database.characters as unknown[]).toHaveLength(0)
    const accepted = await send(archive, 'bot.charx', 'character-card', { allowLowLevelAccess: true })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().importReport.droppedArchiveEntries).toEqual([])
  })
  it('streams encrypted PNG chunks and reconstructs the image after preflight consent', async () => {
    const card = JSON.parse(
      Buffer.from(fflate.unzipSync(characterArchive(Buffer.from('image')))['card.json']).toString(),
    )
    card.spec = 'chara_card_v2'
    delete card.data.assets
    card.data.extensions.risuai.lowLevelAccess = true
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('secret').digest(), Buffer.alloc(12))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(card)), cipher.final(), cipher.getAuthTag()])
    const encoded = `rcc||rccv1||${encrypted.toString('base64')}||${createHash('sha256').update(encrypted).digest('hex')}||${Buffer.from(JSON.stringify({ usePassword: true })).toString('base64')}`
    const chunk = (name: string, bytes: Buffer) => {
      const output = Buffer.alloc(bytes.length + 12)
      output.writeUInt32BE(bytes.length)
      output.write(name, 4)
      bytes.copy(output, 8)
      return output
    }
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const image = Buffer.concat([signature, chunk('IDAT', Buffer.from('image bytes')), chunk('IEND', Buffer.alloc(0))])
    const bytes = Buffer.concat([signature, chunk('tEXt', Buffer.from(`ccv3\0${encoded}`)), image.subarray(8)])
    const response = await send(bytes, 'bot.png', 'character-card', { password: 'secret', allowLowLevelAccess: true })
    expect(response.statusCode, response.body).toBe(200)
    const state = persistedState(harness.dataDir)
    expect(state.assets).toHaveLength(1)
    expect(state.assets[0].id).toBe(createHash('sha256').update(image).digest('hex'))
  })

  it.each(['Comment', 'chara'])('skips large PNG %s text while preserving the usable card and image', async (key) => {
    const { importLocalFileStream, importLocalCharacterFile } = await import('../src/localFileImport.js')
    const { StreamBytes } = await import('../src/localImportStreamBytes.js')
    const chunk = (name: string, bytes: Buffer) => {
      const output = Buffer.alloc(bytes.length + 12)
      output.writeUInt32BE(bytes.length)
      output.write(name, 4)
      bytes.copy(output, 8)
      return output
    }
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const image = Buffer.concat([signature, chunk('IDAT', Buffer.from('image')), chunk('IEND', Buffer.alloc(0))])
    const card = { name: 'Text chunk fixture', description: 'Preserved', first_mes: 'Hello' }
    const ignored = chunk('tEXt', Buffer.concat([Buffer.from(`${key}\0`), Buffer.alloc(67 * 1024 * 1024, 32)]))
    const bytes = Buffer.concat([
      signature,
      ignored,
      chunk('tEXt', Buffer.from(`ccv3\0${Buffer.from(JSON.stringify(card)).toString('base64')}`)),
      image.subarray(8),
    ])
    const filePath = path.join(harness.dataDir, 'text-fixture.png')
    fs.writeFileSync(filePath, bytes)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    const args = { db, dataDir: harness.dataDir, fileName: 'bot.png', maxExpandedBytes: 310 * 1024 * 1024 }
    const read = vi.spyOn(StreamBytes.prototype, 'read')
    try {
      const retained = await importLocalCharacterFile({ ...args, filePath })
      const streamed = await importLocalFileStream({
        ...args,
        kind: 'character',
        source: (async function* () {
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
            yield bytes.subarray(offset, offset + 64 * 1024)
        })(),
      })
      expect(streamed).toMatchObject({
        character: { name: card.name, desc: card.description, image: retained.character.image },
        report: { droppedArchiveEntries: [], droppedInlineAssets: [] },
      })
      expect(retained.character.image).toBe(createHash('sha256').update(image).digest('hex'))
      expect(Math.max(...read.mock.calls.map(([size]) => size))).toBeLessThanOrEqual(64 * 1024)
      // Draining ignored data must still reject truncation, not silently accept it.
      await expect(
        importLocalFileStream({
          ...args,
          kind: 'character',
          source: (async function* () {
            yield bytes.subarray(0, 1024)
          })(),
        }),
      ).rejects.toThrow('ended unexpectedly')
    } finally {
      read.mockRestore()
      db.close()
    }
  })

  it('still rejects an oversized PNG embedded asset instead of skipping it as ancillary text', async () => {
    const { importLocalFileStream } = await import('../src/localFileImport.js')
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const header = Buffer.alloc(8)
    header.writeUInt32BE(67 * 1024 * 1024)
    header.write('tEXt', 4)
    const prefix = Buffer.alloc(80, 65)
    Buffer.from('chara-ext-asset_:fixture\0').copy(prefix)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      await expect(
        importLocalFileStream({
          db,
          dataDir: harness.dataDir,
          kind: 'character',
          fileName: 'oversized.png',
          source: (async function* () {
            yield Buffer.concat([signature, header, prefix])
          })(),
        }),
      ).rejects.toThrow('PNG embedded asset exceeds size limit')
      expect(getAllAssetMetadata(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects a truncated archive instead of committing a partially received bot', async () => {
    const bytes = characterArchive(Buffer.from('image'))
    const response = await send(bytes.subarray(0, bytes.length - 10), 'bot.charx')
    expect(response.statusCode, response.body).toBe(400)
    expect(persistedState(harness.dataDir).database.characters).toHaveLength(0)
  })

  it('preserves a terminal result when live intake also streams progress', async () => {
    const upload = streamingUpload(characterArchive(Buffer.from('live SSE image')), 'bot.charx')
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/import/character-card?stream=1&baseRevision=${currentRevision(harness.dataDir)}`,
      headers: {
        'content-type': upload.contentType,
        accept: 'text/event-stream',
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: upload.payload,
    })
    expect(readImportFrames(response.body).at(-1)).toMatchObject({
      event: 'result',
      data: { statusCode: 200, body: { event: { type: 'character.created' } } },
    })
  })

  it('reads framed module assets incrementally and rejects truncated input without creation', async () => {
    const bytes = risum({ id: 'old', name: 'Streamed module', lowLevelAccess: true, assets: [['one', 'old', 'png']] }, [
      Buffer.from('streamed asset'),
    ])
    const malformed = await send(bytes.subarray(0, bytes.length - 2), 'module.risum', 'module', {
      allowLowLevelAccess: true,
    })
    expect(malformed.statusCode, malformed.body).toBe(400)
    expect(persistedState(harness.dataDir).database.modules).toEqual([])
    const accepted = await send(bytes, 'module.risum', 'module', { allowLowLevelAccess: true })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().event.type).toBe('module.created')
  })
})

it('imports more than 310 MiB incrementally with metadata last and no dropped tail assets', async () => {
  const { importLocalFileStream } = await import('../src/localFileImport.js')
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  let uploadEnded = false
  let persistedDuringUpload = false
  let generatedBytes = 0
  const image = Buffer.alloc(1024 * 1024, 42)
  const card = JSON.parse(Buffer.from(fflate.unzipSync(characterArchive(image))['card.json']).toString())
  card.data.assets[0].uri = 'embeded://assets/319.png'
  async function* source() {
    let output: Uint8Array[] = []
    const zip = new fflate.Zip((error, bytes) => {
      if (error) throw error
      output.push(bytes)
    })
    for (let index = 0; index < 320; index++) {
      const entry = new fflate.ZipPassThrough(`assets/${index}.png`)
      zip.add(entry)
      entry.push(image, true)
      for (const bytes of output) {
        generatedBytes += bytes.length
        yield bytes
      }
      output = []
    }
    const entry = new fflate.ZipPassThrough('card.json')
    zip.add(entry)
    entry.push(Buffer.from(JSON.stringify(card)), true)
    zip.end()
    for (const bytes of output) {
      generatedBytes += bytes.length
      yield bytes
    }
    uploadEnded = true
  }
  try {
    const imported = await importLocalFileStream({
      kind: 'character',
      source: source(),
      db,
      dataDir: harness.dataDir,
      fileName: 'large.charx',
      reportProgress: (progress) => {
        if (progress.completedAssets && !uploadEnded) persistedDuringUpload = true
      },
    })
    expect(generatedBytes).toBeGreaterThan(310 * 1024 * 1024)
    expect(persistedDuringUpload).toBe(true)
    expect(imported).toMatchObject({
      character: { image: createHash('sha256').update(image).digest('hex') },
      report: { droppedArchiveEntries: [] },
    })
  } finally {
    db.close()
  }
}, 30000)
