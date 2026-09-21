import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, webcrypto } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import * as fflate from 'fflate'
import { buildApp, type BuildAppOptions } from '../src/app.js'
import { DatabaseSync } from 'node:sqlite'
import { getAllAssetMetadata, loadPersisted, type Persisted } from '../src/repository.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'

const cryptoMock = vi.hoisted(() => ({
  randomUuidOverride: undefined as string | undefined,
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomUUID: () => cryptoMock.randomUuidOverride ?? actual.randomUUID(),
  }
})

function queryAssets(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    return getAllAssetMetadata(db)
  } finally {
    db.close()
  }
}

function loadPersistedFromDir(dataDir: string): Persisted {
  const db = openDatabase(dataDir)
  try {
    return loadPersisted(db, dataDir)
  } finally {
    db.close()
  }
}

function commandEventCount(dataDir: string): number {
  const db = openDatabase(dataDir)
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM command_events').get() as {
      count: number
    }
    return row.count
  } finally {
    db.close()
  }
}

function commandEventsAfter(dataDir: string, revision: number) {
  const db = openDatabase(dataDir)
  try {
    return db
      .prepare(
        `
          SELECT revision, type, resource, id
          FROM command_events
          WHERE revision > ?
          ORDER BY revision ASC
        `,
      )
      .all(revision) as Array<{
      revision: number
      type: string
      resource: string
      id: string | null
    }>
  } finally {
    db.close()
  }
}

function currentRevision(dataDir: string): number {
  const db = openDatabase(dataDir)
  try {
    return getSchemaState(db).revision
  } finally {
    db.close()
  }
}

function assetIdFor(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const rpackMap = readFileSync(path.join(process.cwd(), 'src/ts/rpack/rpack_map.bin'))
const rpackEncodeMap = rpackMap.subarray(0, 256)

function encodeRpackForTest(data: Uint8Array): Uint8Array {
  const encoded = Buffer.alloc(data.byteLength)
  for (let i = 0; i < data.byteLength; i += 1) {
    encoded[i] = rpackEncodeMap[data[i]]
  }
  return encoded
}

function risuModuleForTest(module: Record<string, unknown>): Uint8Array {
  const header = encodeRpackForTest(
    Buffer.from(
      JSON.stringify(
        {
          module: {
            name: 'Realm CharX Module',
            description: 'Module for Realm CharX',
            id: 'module-a',
            ...module,
          },
          type: 'risuModule',
        },
        null,
        2,
      ),
      'utf-8',
    ),
  )
  const output = Buffer.alloc(1 + 1 + 4 + header.byteLength + 1)
  let offset = 0
  output.writeUInt8(111, offset)
  offset += 1
  output.writeUInt8(0, offset)
  offset += 1
  output.writeUInt32LE(header.byteLength, offset)
  offset += 4
  output.set(header, offset)
  offset += header.byteLength
  output.writeUInt8(0, offset)
  return output
}

function regexScript(id = 'regex-a') {
  return {
    id,
    comment: 'Realm regex',
    in: 'seed',
    out: 'sprout',
    type: 'editinput',
    flag: '',
    ableFlag: false,
  }
}

function luaTrigger(id = 'trigger-a') {
  return {
    id,
    comment: 'Realm Lua trigger',
    type: 'input',
    conditions: [],
    effect: [{ type: 'triggerlua', code: 'setChatVar(id, "realmScript", "present")' }],
  }
}

function moduleLorebookEntry(id = 'lore-a') {
  return {
    id,
    key: 'seed',
    secondkey: '',
    insertorder: 10,
    comment: 'Realm module lore',
    content: 'Module lore survived import.',
    mode: 'normal',
    alwaysActive: false,
    selective: false,
    extentions: { risu_case_sensitive: false },
    useRegex: false,
  }
}

function assetFileNames(dataDir: string): string[] {
  const dir = path.join(dataDir, 'assets')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

function realmCharxTempDirs(): Set<string> {
  return new Set(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith('risu-realm-charx-'))
      .map((name) => path.join(tmpdir(), name)),
  )
}

function newRealmCharxTempDirs(before: Set<string>): string[] {
  const after = realmCharxTempDirs()
  return [...after].filter((dir) => !before.has(dir)).sort()
}

function realmJsonTempDirs(): Set<string> {
  return new Set(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith('risu-realm-json-assets-'))
      .map((name) => path.join(tmpdir(), name)),
  )
}

function newRealmJsonTempDirs(before: Set<string>): string[] {
  const after = realmJsonTempDirs()
  return [...after].filter((dir) => !before.has(dir)).sort()
}

async function waitFor<T>(promise: Promise<T>, label: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const subtle = webcrypto.subtle
const directRealmImportTestRun = process.env.RISU_DIRECT_REALM_IMPORT_TEST === 'true'
const directOnlyIt = directRealmImportTestRun ? it : it.skip

interface CapturedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface EchoServer {
  url: string
  requests: CapturedRequest[]
  setResponder(fn: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void | Promise<void>): void
  close(): Promise<void>
}

function startEcho(): Promise<EchoServer> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = []
    let responder: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void | Promise<void> = (
      _req,
      res,
    ) => {
      res.writeHead(404)
      res.end()
    }
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        })
        void Promise.resolve(responder(req, res, body)).catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        setResponder(fn) {
          responder = fn
        },
        close() {
          return new Promise((r) => server.close(() => r()))
        },
      })
    })
  })
}

interface Harness {
  app: FastifyInstance
  dataDir: string
  commandEvents: CommandEventSink
}

async function startHarness(upstreamUrl: string, realmImport?: BuildAppOptions['realmImport']): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-realm-import-'))
  const commandEvents = createCommandEventSink()
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: upstreamUrl,
      realmUrl: upstreamUrl,
    },
    assetGc: false,
    commandEvents,
    realmImport: { maxExpandedImportBytes: 1024 * 1024, ...realmImport },
  })
  return { app, dataDir, commandEvents }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

async function signAssertion(privateKey: CryptoKey, publicJwk: JsonWebKey, ttlSec = 60): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', typ: 'JWT' }
  const payload = { iat: now, exp: now + ttlSec, pub: publicJwk }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    Buffer.from(signingInput),
  )
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
}

async function setupAuthedClient(app: FastifyInstance): Promise<{ assertion: string }> {
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'hunter2' },
  })
  const keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await subtle.exportKey('jwk', keypair.publicKey)
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'hunter2', publicKey },
  })
  return { assertion: await signAssertion(keypair.privateKey, publicKey) }
}

async function importEmptyDatabase(app: FastifyInstance, assertion: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    payload: { database: { characters: [], characterOrder: [], currentChar: -1 } },
  })
  expect(res.statusCode).toBe(200)
  return res.json().revision as number
}

function realmCard(
  options: {
    lowLevelAccess?: boolean
    regex?: unknown[]
    trigger?: unknown[]
  } = {},
) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Realm Utility',
      description: 'does useful things',
      personality: 'helpful',
      scenario: 'testing',
      first_mes: 'hello',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['utility'],
      creator: 'tester',
      character_version: '1',
      extensions: {
        risuai: {
          emotions: [['happy', 'emotion-img']],
          additionalAssets: [['theme', 'theme-css', 'theme.css']],
          vits: { 'voice.wav': 'voice-wav' },
          lowLevelAccess: options.lowLevelAccess,
          customScripts: options.regex,
          triggerscript: options.trigger,
        },
      },
      character_book: {
        scan_depth: 5,
        token_budget: 800,
        recursive_scanning: true,
        extensions: {},
        entries: [] as Array<Record<string, unknown>>,
      },
    },
  }
}

function realmJsonAssetPayloads(suffix = '') {
  const marker = suffix ? ` ${suffix}` : ''
  return {
    main: `main image${marker}`,
    emotion: `emotion image${marker}`,
    theme: suffix ? `body { color: red; } /* ${suffix} */` : 'body { color: red; }',
    voice: `voice data${marker}`,
  }
}

function respondRealmJsonCard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  suffix = '',
  card: unknown = realmCard(),
): boolean {
  const payloads = realmJsonAssetPayloads(suffix)
  if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ card, img: 'main-img' }))
    return true
  }
  if (req.url === '/resource/main-img') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(payloads.main)
    return true
  }
  if (req.url === '/resource/emotion-img') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(payloads.emotion)
    return true
  }
  if (req.url === '/resource/theme-css') {
    res.writeHead(200, { 'content-type': 'text/css' })
    res.end(payloads.theme)
    return true
  }
  if (req.url === '/resource/voice-wav') {
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(payloads.voice)
    return true
  }
  return false
}

function realmCharx(
  options: {
    lowLevelAccess?: boolean
    moduleData?: Uint8Array
    assetSuffix?: string
    preserveMainAsset?: boolean
    conversionFailure?: boolean
  } = {},
): Uint8Array {
  const marker = options.assetSuffix ? ` ${options.assetSuffix}` : ''
  const cardAssets = options.conversionFailure
    ? [
        {
          type: 'x-risu-asset',
          uri: `data:text/css;base64,${Buffer.from('inline conversion asset').toString('base64')}`,
          name: 'inline',
          ext: 'css',
        },
        { type: 'icon', uri: 'embeded://assets/missing.png', name: 'main', ext: 'png' },
      ]
    : [
        { type: 'icon', uri: 'embeded://assets/main.png', name: 'main', ext: 'png' },
        { type: 'emotion', uri: 'embeded://assets/happy.png', name: 'happy', ext: 'png' },
        { type: 'x-risu-asset', uri: '__asset:assets/theme.css', name: 'theme', ext: 'css' },
      ]
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Realm CharX',
      description: 'packed character',
      personality: '',
      scenario: '',
      first_mes: 'hello from charx',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: { risuai: { lowLevelAccess: options.lowLevelAccess } },
      assets: cardAssets,
    },
  }
  const files: Record<string, Uint8Array> = {
    'card.json': new TextEncoder().encode(JSON.stringify(card)),
    'assets/main.png': new TextEncoder().encode(options.preserveMainAsset ? 'main image' : `main image${marker}`),
    'assets/happy.png': new TextEncoder().encode(`happy image${marker}`),
    'assets/theme.css': new TextEncoder().encode(
      options.assetSuffix ? `body { color: red; } /* ${options.assetSuffix} */` : 'body { color: red; }',
    ),
  }
  if (options.moduleData) {
    files['module.risum'] = options.moduleData
  }
  return fflate.zipSync(files, { level: 0 })
}

function oversizedExpandedRealmCharx(): Uint8Array {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Realm Oversized',
      description: 'packed character with oversized expanded assets',
      personality: '',
      scenario: '',
      first_mes: 'hello from oversized',
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
      'card.json': new TextEncoder().encode(JSON.stringify(card)),
      'assets/main.png': new Uint8Array(1024 * 1024 + 1),
    },
    { level: 9 },
  )
}

function jpegPrefixedRealmCharx(): Uint8Array {
  const prefix = Buffer.alloc(128, 0x20)
  prefix.set(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
  const zip = realmCharx()
  const bytes = new Uint8Array(prefix.byteLength + zip.byteLength)
  bytes.set(prefix)
  bytes.set(zip, prefix.byteLength)
  return bytes
}

function manyDisplayAssetRealmCharx(assetCount: number): Uint8Array {
  const assets = Array.from({ length: assetCount }, (_, index) => ({
    type: 'x-risu-asset',
    uri: `__asset:assets/display/display-${index}.png`,
    name: `display-${index}`,
    ext: 'png',
  }))
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Realm Many Assets',
      description: 'packed character with many display assets',
      personality: '',
      scenario: '',
      first_mes: 'hello from many assets',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: { risuai: {} },
      assets: [{ type: 'icon', uri: 'embeded://assets/main.png', name: 'main', ext: 'png' }, ...assets],
    },
  }
  const files: Record<string, Uint8Array> = {
    'card.json': new TextEncoder().encode(JSON.stringify(card)),
    'assets/main.png': new TextEncoder().encode('main image'),
  }
  for (let i = 0; i < assetCount; i += 1) {
    files[`assets/display/display-${i}.png`] = new TextEncoder().encode(`display image ${i}`)
    files[`x_meta/display-${i}.json`] = new TextEncoder().encode('{"ok":true}')
  }
  return fflate.zipSync(files, { level: 0 })
}

function parseSsePayload(payload: string): Array<{ event: string; data: unknown }> {
  return payload
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        if (line.startsWith('data: ')) data += line.slice(6)
      }
      return { event, data: JSON.parse(data) as unknown }
    })
}

function progressPercents(frames: Array<{ event: string; data: unknown }>): number[] {
  return frames
    .filter((frame) => frame.event === 'progress')
    .map((frame) => (frame.data as { percent: number }).percent)
}

function expectStarterChatWithoutGenerationSettings(character: Record<string, unknown>): void {
  const chats = character.chats as Array<Record<string, unknown>>
  expect(chats).toHaveLength(1)
  expect(chats[0]).toMatchObject({
    id: expect.any(String),
    note: '',
    name: 'Chat 1',
    localLore: [],
  })
  expect(chats[0]).not.toHaveProperty('generationSettings')
}

let harness: Harness
let echo: EchoServer

beforeEach(async () => {
  echo = await startEcho()
  harness = await startHarness(echo.url)
})

afterEach(async () => {
  await stopHarness(harness)
  await echo.close()
})

describe('Realm character import route', () => {
  it('streams progress while importing JSON Realm cards', async () => {
    const card = realmCard()
    card.data.character_book.entries = [
      {
        keys: ['first'],
        secondary_keys: [],
        content: 'First realm lore row',
        insertion_order: 1,
        name: 'First',
      },
      {
        keys: ['second'],
        secondary_keys: [],
        content: 'Second realm lore row',
        insertion_order: 2,
        name: 'Second',
      },
    ]
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ card, img: 'main-img' }))
        return
      }
      if (req.url === '/resource/main-img') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('main image')
        return
      }
      if (req.url === '/resource/emotion-img') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('emotion image')
        return
      }
      if (req.url === '/resource/theme-css') {
        res.writeHead(200, { 'content-type': 'text/css' })
        res.end('body { color: red; }')
        return
      }
      if (req.url === '/resource/voice-wav') {
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end('voice data')
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: {
        accept: 'text/event-stream',
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const frames = parseSsePayload(res.payload)
    expect(frames.map((frame) => frame.event)).toContain('progress')
    for (const frame of frames.filter((candidate) => candidate.event === 'progress')) {
      expect(frame.data).toMatchObject({
        phase: expect.any(String),
        message: expect.any(String),
        percent: expect.any(Number),
      })
    }
    expect(frames.at(-1)).toMatchObject({
      event: 'done',
      data: { characterId: expect.any(String), revision: expect.any(Number) },
    })
    expect(progressPercents(frames)).toEqual([...progressPercents(frames)].sort((a, b) => a - b))
    expect(progressPercents(frames).at(-1)).toBe(100)
    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    const importedLorebook = character.globalLore as Array<Record<string, unknown>>
    expect(importedLorebook).toHaveLength(2)
    expect(importedLorebook.every((entry) => typeof entry.id === 'string' && entry.id.length > 0)).toBe(true)
    expect(new Set(importedLorebook.map((entry) => entry.id)).size).toBe(2)
  })

  it('negotiates percent-only Realm progress deltas while preserving terminal frames', async () => {
    echo.setResponder((req, res) => {
      if (respondRealmJsonCard(req, res)) return
      res.writeHead(404)
      res.end()
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: {
        accept: 'text/event-stream',
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: {
        id: 'realm-id',
        baseRevision,
        clientCapabilities: { realmProgressDelta: true },
      },
    })

    expect(res.statusCode).toBe(200)
    const frames = parseSsePayload(res.payload)
    const progress = frames
      .filter((frame) => frame.event === 'progress')
      .map((frame) => frame.data as Record<string, unknown>)
    expect(progress[0]).toEqual({ phase: 'validate', message: 'Preparing Realm import', percent: 1 })
    expect(progress.some((frame) => Object.keys(frame).length === 1 && typeof frame.percent === 'number')).toBe(true)
    expect(
      progress.some(
        (frame, index) =>
          index > 0 &&
          (Object.prototype.hasOwnProperty.call(frame, 'phase') ||
            Object.prototype.hasOwnProperty.call(frame, 'message')),
      ),
    ).toBe(true)
    expect(progressPercents(frames)).toEqual([...progressPercents(frames)].sort((a, b) => a - b))
    expect(frames.at(-1)).toMatchObject({
      event: 'done',
      data: { characterId: expect.any(String), revision: expect.any(Number) },
    })
  })

  it('streams low-level-access confirmation requests without writing assets', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ card: realmCard({ lowLevelAccess: true }), img: 'main-img' }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: {
        accept: 'text/event-stream',
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    const frames = parseSsePayload(res.payload)
    expect(frames.at(-1)).toEqual({
      event: 'low_level_access',
      data: {
        error: 'Character import requires low-level-access confirmation',
        code: 'low_level_access_confirmation_required',
      },
    })
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
  })

  it('streams charx extraction and asset progress', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        const bytes = Buffer.from(realmCharx())
        res.writeHead(200, {
          'content-type': 'application/charx',
          'content-length': String(bytes.byteLength),
        })
        res.end(bytes)
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: {
        accept: 'text/event-stream',
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    const frames = parseSsePayload(res.payload)
    const progress = frames
      .filter((frame) => frame.event === 'progress')
      .map((frame) => frame.data as { phase: string; percent: number })
    expect(progress.map((frame) => frame.phase)).toEqual(
      expect.arrayContaining(['download', 'extract', 'assets', 'convert', 'commit']),
    )
    expect(frames.at(-1)).toMatchObject({ event: 'done' })
  })

  it('preserves scripts stored in Realm charx module metadata', async () => {
    const regex = regexScript('charx-regex')
    const duplicateRegex = regexScript('charx-regex')
    const trigger = luaTrigger('charx-trigger')
    const duplicateTrigger = luaTrigger('charx-trigger')
    const lorebook = moduleLorebookEntry('charx-lore')
    const duplicateLorebook = moduleLorebookEntry('charx-lore')
    const moduleData = risuModuleForTest({
      regex: [regex, duplicateRegex],
      trigger: [trigger, duplicateTrigger],
      lorebook: [lorebook, duplicateLorebook],
    })

    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/charx' })
        res.end(Buffer.from(realmCharx({ moduleData })))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    const importedScripts = character.customscript as Array<Record<string, unknown>>
    const importedTriggers = character.triggerscript as Array<Record<string, unknown>>
    expect(importedScripts[0]).toEqual(regex)
    expect(importedScripts[1]).toMatchObject({ ...duplicateRegex, id: expect.any(String) })
    expect(importedScripts[1].id).not.toBe('charx-regex')
    expect(new Set(importedScripts.map((script) => script.id)).size).toBe(2)
    expect(importedTriggers[0]).toEqual(trigger)
    expect(importedTriggers[1]).toMatchObject({ ...duplicateTrigger, id: expect.any(String) })
    expect(importedTriggers[1].id).not.toBe('charx-trigger')
    expect(new Set(importedTriggers.map((script) => script.id)).size).toBe(2)
    const importedLorebook = character.globalLore as Array<Record<string, unknown>>
    expect(importedLorebook).toHaveLength(2)
    expect(importedLorebook[0]).toEqual(lorebook)
    expect(importedLorebook[1]).toMatchObject({ ...duplicateLorebook, id: expect.any(String) })
    expect(importedLorebook[1].id).not.toBe('charx-lore')
    expect(new Set(importedLorebook.map((entry) => entry.id)).size).toBe(2)
  })

  it('fetches Realm assets server-side and creates the character in one client request', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ card: realmCard(), img: 'main-img' }))
        return
      }
      if (req.url === '/resource/main-img') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('main image')
        return
      }
      if (req.url === '/resource/emotion-img') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('emotion image')
        return
      }
      if (req.url === '/resource/theme-css') {
        res.writeHead(200, { 'content-type': 'text/css' })
        res.end('body { color: red; }')
        return
      }
      if (req.url === '/resource/voice-wav') {
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end('voice data')
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().event).toMatchObject({ type: 'character.created', resource: 'character' })
    expect(harness.commandEvents.list().at(-1)).toMatchObject({
      type: 'character.created',
      resource: 'character',
      origin: { writerSessionId: 'writer-a' },
    })
    expect(echo.requests.map((req) => req.url)).toEqual([
      '/api/v1/download/dynamic/realm-id?cors=true',
      '/resource/main-img',
      '/resource/emotion-img',
      '/resource/theme-css',
      '/resource/voice-wav',
    ])

    const assets = queryAssets(harness.dataDir)
    expect(assets).toHaveLength(4)
    expect(assets.map((asset) => asset.contentType).sort()).toEqual(['audio/wav', 'image/png', 'image/png', 'text/css'])
    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    expect(character.name).toBe('Realm Utility')
    expect(character.image).toMatch(/^[a-f0-9]{64}$/)
    expect(character.emotionImages).toEqual([['happy', expect.stringMatching(/^[a-f0-9]{64}$/)]])
    expect(character.additionalAssets).toEqual([['theme', expect.stringMatching(/^[a-f0-9]{64}$/), 'theme.css']])
    expect(character.extentions).toMatchObject({ risuRealmImportId: 'realm-id' })
    expect(character.vits).toMatchObject({
      files: { 'voice.wav': expect.stringMatching(/^[a-f0-9]{64}$/) },
    })
  })

  it('preserves inline JSON Realm card scripts', async () => {
    const regex = regexScript('json-regex')
    const trigger = luaTrigger('json-trigger')

    echo.setResponder((req, res) => {
      if (respondRealmJsonCard(req, res, '', realmCard({ regex: [regex], trigger: [trigger] }))) return
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    expect(character.customscript).toEqual([regex])
    expect(character.triggerscript).toEqual([trigger])
  })

  it('creates Realm starter chats without generation settings', async () => {
    echo.setResponder((req, res) => {
      if (respondRealmJsonCard(req, res)) return
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    expectStarterChatWithoutGenerationSettings(character)
  })

  it('JSON Realm card asset import uses one batched asset revision and event', async () => {
    echo.setResponder((req, res) => {
      if (respondRealmJsonCard(req, res)) return
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ revision: baseRevision + 2 })
    expect(queryAssets(harness.dataDir)).toHaveLength(4)
    expect(commandEventsAfter(harness.dataDir, baseRevision)).toEqual([
      {
        revision: baseRevision + 1,
        type: 'asset.created',
        resource: 'asset',
        id: null,
      },
      {
        revision: baseRevision + 2,
        type: 'character.created',
        resource: 'character',
        id: res.json().characterId,
      },
    ])
  })

  it('JSON Realm import removes newly persisted assets when character append fails', async () => {
    let assetSuffix = ''
    echo.setResponder((req, res) => {
      if (respondRealmJsonCard(req, res, assetSuffix)) return
      res.writeHead(404)
      res.end()
    })

    const duplicateCharacterId = '11111111-1111-4111-8111-111111111111'
    cryptoMock.randomUuidOverride = duplicateCharacterId

    try {
      const { assertion } = await setupAuthedClient(harness.app)
      const baseRevision = await importEmptyDatabase(harness.app, assertion)
      const first = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/realm-character',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
        payload: { id: 'realm-id', baseRevision },
      })

      expect(first.statusCode).toBe(200)
      const assetsAfterFirstImport = queryAssets(harness.dataDir)
      const filesAfterFirstImport = assetFileNames(harness.dataDir)

      assetSuffix = 'second'
      const duplicate = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/realm-character',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
        payload: { id: 'realm-id', baseRevision: currentRevision(harness.dataDir) },
      })

      expect(duplicate.statusCode).toBe(400)
      expect(duplicate.json()).toEqual({
        error: `Duplicate character id: ${duplicateCharacterId}`,
      })
      expect(queryAssets(harness.dataDir)).toEqual(assetsAfterFirstImport)
      expect(assetFileNames(harness.dataDir)).toEqual(filesAfterFirstImport)

      const secondPayloads = realmJsonAssetPayloads(assetSuffix)
      const removedFiles = [
        `${assetIdFor(secondPayloads.main)}.png`,
        `${assetIdFor(secondPayloads.emotion)}.png`,
        `${assetIdFor(secondPayloads.theme)}.css`,
        `${assetIdFor(secondPayloads.voice)}.wav`,
      ]
      for (const fileName of removedFiles) {
        expect(existsSync(path.join(harness.dataDir, 'assets', fileName))).toBe(false)
      }

      const persisted = loadPersistedFromDir(harness.dataDir)
      expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(1)
    } finally {
      cryptoMock.randomUuidOverride = undefined
    }
  })

  it('aborts a hung dynamic Realm download at the import deadline', async () => {
    await stopHarness(harness)
    harness = await startHarness(echo.url, { deadlineMs: 30 })

    let resolveUpstreamClosed: () => void = () => undefined
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamClosed = resolve
    })
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.flushHeaders()
        res.on('close', () => resolveUpstreamClosed())
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(504)
    expect(res.json()).toEqual({ error: 'Realm import timed out after 30ms' })
    await waitFor(upstreamClosed, 'hung Realm dynamic download to close')
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    const persisted = loadPersistedFromDir(harness.dataDir)
    expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(0)
  })

  it('aborts upstream resource fetch when the SSE client disconnects', async () => {
    await stopHarness(harness)
    harness = await startHarness(echo.url, { deadlineMs: 5000 })

    let resolveResourceStarted: () => void = () => undefined
    let resolveResourceClosed: () => void = () => undefined
    const resourceStarted = new Promise<void>((resolve) => {
      resolveResourceStarted = resolve
    })
    const resourceClosed = new Promise<void>((resolve) => {
      resolveResourceClosed = resolve
    })

    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ card: realmCard(), img: 'main-img' }))
        return
      }
      if (req.url === '/resource/main-img') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.flushHeaders()
        resolveResourceStarted()
        res.on('close', () => resolveResourceClosed())
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)
    const baseUrl = await harness.app.listen({ host: '127.0.0.1', port: 0 })
    const clientAbort = new AbortController()

    const response = await fetch(`${baseUrl}/api/v1/import/realm-character`, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      body: JSON.stringify({ id: 'realm-id', baseRevision }),
      signal: clientAbort.signal,
    })
    const readBody = response.text().catch((err: unknown) => err)
    await waitFor(resourceStarted, 'resource fetch to start')

    clientAbort.abort()

    await waitFor(resourceClosed, 'upstream resource fetch to close')
    await waitFor(readBody, 'client response body to finish after abort')
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    const persisted = loadPersistedFromDir(harness.dataDir)
    expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(0)
  })

  it('rejects known-length oversized Realm dynamic JSON before reading the body', async () => {
    await stopHarness(harness)
    harness = await startHarness(echo.url, { maxDynamicJsonBytes: 32 })

    let bodyWriteAttempted = false
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '33',
        })
        res.flushHeaders()
        bodyTimer = setTimeout(() => {
          bodyWriteAttempted = true
          if (!res.destroyed) {
            res.end(JSON.stringify({ card: realmCard(), img: 'main-img' }))
          }
        }, 50)
        res.on('close', () => {
          if (bodyTimer) clearTimeout(bodyTimer)
        })
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })
    if (bodyTimer) clearTimeout(bodyTimer)

    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'Realm dynamic JSON exceeds size limit' })
    expect(bodyWriteAttempted).toBe(false)
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
  })

  it('aborts unknown-length oversized Realm dynamic JSON once the cap is crossed', async () => {
    await stopHarness(harness)
    harness = await startHarness(echo.url, { maxDynamicJsonBytes: 32 })

    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(16, 0x61))
    let chunksAttempted = 0
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.flushHeaders()
        const timer = setInterval(() => {
          if (res.destroyed) {
            clearInterval(timer)
            return
          }
          if (chunksAttempted >= chunks.length) {
            clearInterval(timer)
            res.end()
            return
          }
          res.write(chunks[chunksAttempted])
          chunksAttempted += 1
        }, 10)
        res.on('close', () => clearInterval(timer))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'Realm dynamic JSON exceeds size limit' })
    expect(chunksAttempted).toBeLessThan(chunks.length)
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
  })

  it('rejects JSON-card fetched resources above the per-asset cap before reading the body', async () => {
    await stopHarness(harness)
    harness = await startHarness(echo.url, {
      maxFetchedAssetBytes: 8,
      maxFetchedAssetTotalBytes: 1024,
    })

    let bodyWriteAttempted = false
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ card: realmCard(), img: 'main-img' }))
        return
      }
      if (req.url === '/resource/main-img') {
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': '9',
        })
        res.flushHeaders()
        bodyTimer = setTimeout(() => {
          bodyWriteAttempted = true
          if (!res.destroyed) res.end('main data')
        }, 50)
        res.on('close', () => {
          if (bodyTimer) clearTimeout(bodyTimer)
        })
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })
    if (bodyTimer) clearTimeout(bodyTimer)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Realm fetched asset too large: realm.png' })
    expect(bodyWriteAttempted).toBe(false)
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
  })

  it('rejects cumulative JSON-card fetched assets and cleans staged files', async () => {
    await stopHarness(harness)
    harness = await startHarness(echo.url, {
      maxFetchedAssetBytes: 1024,
      maxFetchedAssetTotalBytes: 24,
    })

    echo.setResponder((req, res) => {
      if (respondRealmJsonCard(req, res)) return
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)
    const tempDirsBefore = realmJsonTempDirs()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Realm fetched assets exceed size limit' })
    expect(newRealmJsonTempDirs(tempDirsBefore)).toEqual([])
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    const persisted = loadPersistedFromDir(harness.dataDir)
    expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(0)
  })

  it('keeps valid JSON Realm import output unchanged with disk-staged assets', async () => {
    echo.setResponder((req, res) => {
      if (respondRealmJsonCard(req, res)) return
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    const payloads = realmJsonAssetPayloads()
    const expectedAssets = [
      {
        id: assetIdFor(payloads.main),
        ext: 'png',
        size: Buffer.byteLength(payloads.main),
        contentType: 'image/png',
        bytes: payloads.main,
      },
      {
        id: assetIdFor(payloads.emotion),
        ext: 'png',
        size: Buffer.byteLength(payloads.emotion),
        contentType: 'image/png',
        bytes: payloads.emotion,
      },
      {
        id: assetIdFor(payloads.theme),
        ext: 'css',
        size: Buffer.byteLength(payloads.theme),
        contentType: 'text/css',
        bytes: payloads.theme,
      },
      {
        id: assetIdFor(payloads.voice),
        ext: 'wav',
        size: Buffer.byteLength(payloads.voice),
        contentType: 'audio/wav',
        bytes: payloads.voice,
      },
    ].sort((a, b) => a.id.localeCompare(b.id))

    expect(queryAssets(harness.dataDir)).toEqual(expectedAssets.map(({ bytes: _bytes, ...asset }) => asset))
    for (const asset of expectedAssets) {
      expect(Buffer.from(readFileSync(path.join(harness.dataDir, 'assets', `${asset.id}.${asset.ext}`)))).toEqual(
        Buffer.from(asset.bytes),
      )
    }

    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    expect(character).toMatchObject({
      name: 'Realm Utility',
      firstMessage: 'hello',
      desc: 'does useful things',
      image: assetIdFor(payloads.main),
      emotionImages: [['happy', assetIdFor(payloads.emotion)]],
      additionalAssets: [['theme', assetIdFor(payloads.theme), 'theme.css']],
      vits: {
        name: 'Imported VITS',
        files: { 'voice.wav': assetIdFor(payloads.voice) },
      },
    })
    expect(character.chaId).toBe(res.json().characterId)
  })

  it('rejects duplicate Realm character ids without bumping revision or emitting events', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ card: realmCard(), img: 'main-img' }))
        return
      }
      if (req.url === '/resource/main-img') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('main image')
        return
      }
      if (req.url === '/resource/emotion-img') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('emotion image')
        return
      }
      if (req.url === '/resource/theme-css') {
        res.writeHead(200, { 'content-type': 'text/css' })
        res.end('body { color: red; }')
        return
      }
      if (req.url === '/resource/voice-wav') {
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end('voice data')
        return
      }
      res.writeHead(404)
      res.end()
    })

    const duplicateCharacterId = '11111111-1111-4111-8111-111111111111'
    cryptoMock.randomUuidOverride = duplicateCharacterId

    try {
      const { assertion } = await setupAuthedClient(harness.app)
      const baseRevision = await importEmptyDatabase(harness.app, assertion)
      const first = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/realm-character',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
        payload: { id: 'realm-id', baseRevision },
      })

      expect(first.statusCode).toBe(200)
      expect(first.json().characterId).toBe(duplicateCharacterId)
      const revisionAfterFirstImport = currentRevision(harness.dataDir)
      const eventsAfterFirstImport = commandEventCount(harness.dataDir)

      const duplicate = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/realm-character',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
        payload: { id: 'realm-id', baseRevision: revisionAfterFirstImport },
      })

      expect(duplicate.statusCode).toBe(400)
      expect(duplicate.json()).toEqual({
        error: `Duplicate character id: ${duplicateCharacterId}`,
      })
      expect(currentRevision(harness.dataDir)).toBe(revisionAfterFirstImport)
      expect(commandEventCount(harness.dataDir)).toBe(eventsAfterFirstImport)
      const persisted = loadPersistedFromDir(harness.dataDir)
      expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(1)
    } finally {
      cryptoMock.randomUuidOverride = undefined
    }
  })

  it('requires explicit confirmation before importing low-level-access cards', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ card: realmCard({ lowLevelAccess: true }), img: 'main-img' }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'low_level_access_confirmation_required' })
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    expect(echo.requests.map((req) => req.url)).toEqual(['/api/v1/download/dynamic/realm-id?cors=true'])
  })

  it('reuses a downloaded low-level Realm charx package after confirmation', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/charx' })
        res.end(Buffer.from(realmCharx({ lowLevelAccess: true })))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(first.statusCode).toBe(409)
    expect(first.json()).toMatchObject({
      code: 'low_level_access_confirmation_required',
      pendingImportToken: expect.any(String),
    })
    expect(queryAssets(harness.dataDir)).toHaveLength(0)

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: {
        id: 'realm-id',
        baseRevision,
        allowLowLevelAccess: true,
        pendingImportToken: first.json().pendingImportToken,
      },
    })

    expect(second.statusCode).toBe(200)
    expect(echo.requests.map((req) => req.url)).toEqual(['/api/v1/download/dynamic/realm-id?cors=true'])
    expect(queryAssets(harness.dataDir)).toHaveLength(3)
    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    expect(character.name).toBe('Realm CharX')
    expect(character.lowLevelAccess).toBe(true)
  })

  it('imports Realm charx packages server-side without falling back to client asset uploads', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/charx' })
        res.end(Buffer.from(realmCharx()))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    expect(echo.requests.map((req) => req.url)).toEqual(['/api/v1/download/dynamic/realm-id?cors=true'])

    const assets = queryAssets(harness.dataDir)
    expect(assets).toHaveLength(3)
    expect(assets.map((asset) => asset.contentType).sort()).toEqual(['image/png', 'image/png', 'text/css'])
    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    expect(character.name).toBe('Realm CharX')
    expect(character.image).toMatch(/^[a-f0-9]{64}$/)
    expect(character.emotionImages).toEqual([['happy', expect.stringMatching(/^[a-f0-9]{64}$/)]])
    expect(character.additionalAssets).toEqual([['theme', expect.stringMatching(/^[a-f0-9]{64}$/), 'css']])
  })

  it('removes earlier CharX asset files when a later package asset write fails', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/charx' })
        res.end(Buffer.from(realmCharx()))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)
    const failingAssetId = assetIdFor('happy image')
    const writeFileSync = fs.writeFileSync
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => {
      if (String(file).endsWith(`${failingAssetId}.png`)) {
        throw new Error('injected CharX asset write failure')
      }
      return writeFileSync(file, data)
    })

    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/realm-character',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
        payload: { id: 'realm-id', baseRevision },
      })

      expect(res.statusCode).toBe(500)
    } finally {
      writeSpy.mockRestore()
    }

    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    expect(assetFileNames(harness.dataDir)).toEqual([])
    const persisted = loadPersistedFromDir(harness.dataDir)
    expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(0)
  })

  it('removes packaged and inline CharX assets when card conversion fails', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/charx' })
        res.end(Buffer.from(realmCharx({ conversionFailure: true })))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Embedded card asset not found: assets/missing.png' })
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    expect(assetFileNames(harness.dataDir)).toEqual([])
    const persisted = loadPersistedFromDir(harness.dataDir)
    expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(0)
  })

  it(
    'removes new CharX assets but preserves deduplicated assets when character append fails',
    { tags: 'core' },
    async () => {
      let assetSuffix = ''
      echo.setResponder((req, res) => {
        if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
          res.writeHead(200, { 'content-type': 'application/charx' })
          res.end(
            Buffer.from(
              realmCharx(
                assetSuffix
                  ? {
                      assetSuffix,
                      preserveMainAsset: true,
                    }
                  : {},
              ),
            ),
          )
          return
        }
        res.writeHead(404)
        res.end()
      })

      const duplicateCharacterId = '11111111-1111-4111-8111-111111111111'
      cryptoMock.randomUuidOverride = duplicateCharacterId

      try {
        const { assertion } = await setupAuthedClient(harness.app)
        const baseRevision = await importEmptyDatabase(harness.app, assertion)
        const first = await harness.app.inject({
          method: 'POST',
          url: '/api/v1/import/realm-character',
          headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
          payload: { id: 'realm-id', baseRevision },
        })

        expect(first.statusCode).toBe(200)
        const assetsAfterFirstImport = queryAssets(harness.dataDir)
        const filesAfterFirstImport = assetFileNames(harness.dataDir)

        assetSuffix = 'second'
        const duplicate = await harness.app.inject({
          method: 'POST',
          url: '/api/v1/import/realm-character',
          headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
          payload: { id: 'realm-id', baseRevision: currentRevision(harness.dataDir) },
        })

        expect(duplicate.statusCode).toBe(400)
        expect(duplicate.json()).toEqual({
          error: `Duplicate character id: ${duplicateCharacterId}`,
        })
        expect(queryAssets(harness.dataDir)).toEqual(assetsAfterFirstImport)
        expect(assetFileNames(harness.dataDir)).toEqual(filesAfterFirstImport)
        expect(existsSync(path.join(harness.dataDir, 'assets', `${assetIdFor('main image')}.png`))).toBe(true)

        const newAssetFiles = [
          `${assetIdFor('happy image second')}.png`,
          `${assetIdFor('body { color: red; } /* second */')}.css`,
        ]
        for (const fileName of newAssetFiles) {
          expect(existsSync(path.join(harness.dataDir, 'assets', fileName))).toBe(false)
        }
      } finally {
        cryptoMock.randomUuidOverride = undefined
      }
    },
  )

  it('rejects known-length Realm charx downloads above the staging cap before reading the body', async () => {
    let bodyWriteAttempted = false
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, {
          'content-type': 'application/charx',
          'content-length': String(3 * 1024 * 1024 + 1),
        })
        res.flushHeaders()
        bodyTimer = setTimeout(() => {
          bodyWriteAttempted = true
          if (!res.destroyed) {
            res.end(Buffer.alloc(3 * 1024 * 1024 + 1))
          }
        }, 50)
        res.on('close', () => {
          if (bodyTimer) clearTimeout(bodyTimer)
        })
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)
    const tempDirsBefore = realmCharxTempDirs()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })
    if (bodyTimer) clearTimeout(bodyTimer)

    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'Realm charx download exceeds size limit' })
    expect(bodyWriteAttempted).toBe(false)
    expect(newRealmCharxTempDirs(tempDirsBefore)).toEqual([])
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    const persisted = loadPersistedFromDir(harness.dataDir)
    expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(0)
  })

  it('aborts unknown-length Realm charx downloads as soon as the staging cap is crossed', async () => {
    const chunks = Array.from({ length: 50 }, () => Buffer.alloc(400 * 1024, 0x61))
    let chunksAttempted = 0
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/charx' })
        res.flushHeaders()
        const timer = setInterval(() => {
          if (res.destroyed) {
            clearInterval(timer)
            return
          }
          if (chunksAttempted >= chunks.length) {
            clearInterval(timer)
            res.end()
            return
          }
          res.write(chunks[chunksAttempted])
          chunksAttempted += 1
        }, 10)
        res.on('close', () => clearInterval(timer))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)
    const tempDirsBefore = realmCharxTempDirs()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'Realm charx download exceeds size limit' })
    expect(chunksAttempted).toBeLessThan(chunks.length)
    expect(newRealmCharxTempDirs(tempDirsBefore)).toEqual([])
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    const persisted = loadPersistedFromDir(harness.dataDir)
    expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(0)
  })

  it('accepts a valid Realm charx download within the staging cap', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        const bytes = Buffer.from(realmCharx())
        res.writeHead(200, {
          'content-type': 'application/charx',
          'content-length': String(bytes.byteLength),
        })
        res.end(bytes)
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)
    const tempDirsBefore = realmCharxTempDirs()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)
    expect(newRealmCharxTempDirs(tempDirsBefore)).toEqual([])
    expect(
      queryAssets(harness.dataDir)
        .map((asset) => asset.contentType)
        .sort(),
    ).toEqual(['image/png', 'image/png', 'text/css'])
    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    expect(character.name).toBe('Realm CharX')
    expect(character.image).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects Realm charx packages whose expanded payload exceeds the import limit', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/charx' })
        res.end(Buffer.from(oversizedExpandedRealmCharx()))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Realm charx expanded payload exceeds size limit' })
    expect(queryAssets(harness.dataDir)).toHaveLength(0)
    const persisted = loadPersistedFromDir(harness.dataDir)
    expect((persisted.database as { characters: unknown[] }).characters).toHaveLength(0)
  })

  it('imports JPEG-prefixed Realm charx packages', async () => {
    echo.setResponder((req, res) => {
      if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
        res.writeHead(200, { 'content-type': 'application/charx' })
        res.end(Buffer.from(jpegPrefixedRealmCharx()))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseRevision = await importEmptyDatabase(harness.app, assertion)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/realm-character',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: { id: 'realm-id', baseRevision },
    })

    expect(res.statusCode).toBe(200)

    const persisted = loadPersistedFromDir(harness.dataDir)
    const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
    expect(character.name).toBe('Realm CharX')
    expect(queryAssets(harness.dataDir)).toHaveLength(3)
  })

  directOnlyIt(
    'imports Realm charx packages with thousands of display assets',
    async () => {
      echo.setResponder((req, res) => {
        if (req.url?.startsWith('/api/v1/download/dynamic/realm-id')) {
          res.writeHead(200, { 'content-type': 'application/charx' })
          res.end(Buffer.from(manyDisplayAssetRealmCharx(7000)))
          return
        }
        res.writeHead(404)
        res.end()
      })

      const { assertion } = await setupAuthedClient(harness.app)
      const baseRevision = await importEmptyDatabase(harness.app, assertion)

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/realm-character',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
        payload: { id: 'realm-id', baseRevision },
      })

      expect(res.statusCode).toBe(200)
      expect(queryAssets(harness.dataDir)).toHaveLength(7001)
      const persisted = loadPersistedFromDir(harness.dataDir)
      const character = (persisted.database as { characters: Array<Record<string, unknown>> }).characters[0]
      expect(character.name).toBe('Realm Many Assets')
      expect(character.additionalAssets).toHaveLength(7000)
    },
    60000,
  )
})
