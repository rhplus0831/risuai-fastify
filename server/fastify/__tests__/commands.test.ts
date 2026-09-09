import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { compressSync } from 'fflate'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { readChatGenerationSettingsSave } from '../src/commands/chats.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import { applyJsonCommandMutation, applyMessageFreeJsonCommandMutation } from '../src/commands/mutations.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { addAlternateMessage } from '../src/messageStore.js'
import {
  createMemoryChunk,
  createMemoryJob,
  createMemorySummary,
  listMemoryChunks,
  listMemoryJobs,
} from '../src/memoryRepository.js'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'
import { loadPersisted, writePersistedWithMessages, insertAssetMetadataBatch } from '../src/repository.js'
import { activeMessageRowids, assertOnlyRowsWritten, tableRowidsById } from './helpers/rowStability.js'
import { MODEL_ROLES } from '@risuai/shared-core/model-roles'
import type { FastifyDatabase as Database } from '../src/prompt/serverTypes.js'
import { LLMFlags, LLMFormat } from '@risuai/shared-core/model-types'
import {
  serializeChatGenerationSettingsDigestInput,
  type ChatGenerationSettings,
} from '@risuai/shared-core/chat-generation-settings'
import {
  serializePersonaCollectionDigestInput,
  serializePersonaIdsDigestInput,
  serializePersonaProfileDigestInput,
  type PersonaProfileDigestValue,
  serializeScriptDefinitionCollectionDigestInput,
} from '@risuai/shared-core/mutation-certificates'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import {
  getGreetingTranslation,
  sourceHash,
  upsertGreetingTranslation,
} from '../src/translation/greetingTranslationStore.js'

const subtle = webcrypto.subtle

function chatGenerationSettingsDigest(settings: ChatGenerationSettings | null | undefined): string {
  return createHash('sha256').update(serializeChatGenerationSettingsDigestInput(settings), 'utf8').digest('hex')
}

function personaCollectionDigest(personas: readonly unknown[]): string {
  return createHash('sha256').update(serializePersonaCollectionDigestInput(personas), 'utf8').digest('hex')
}

function personaIdsDigest(personaIds: readonly string[]): string {
  return createHash('sha256').update(serializePersonaIdsDigestInput(personaIds), 'utf8').digest('hex')
}

function personaProfileDigest(profile: PersonaProfileDigestValue): string {
  return createHash('sha256').update(serializePersonaProfileDigestInput(profile), 'utf8').digest('hex')
}

interface Harness {
  app: FastifyInstance
  dataDir: string
  commandEvents: CommandEventSink
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

function readAllDatabaseRows(dataDir: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string
    }>
    return Object.fromEntries(
      tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as unknown[]]),
    )
  } finally {
    db.close()
  }
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-commands-'))
  const commandEvents = createCommandEventSink()
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
    commandEvents,
  })
  return { app, dataDir, commandEvents }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

/** Open a temporary db handle, call loadPersisted, close the handle. */
function loadPersistedFromDir(dataDir: string) {
  const db = openDatabase(dataDir)
  try {
    return loadPersisted(db, dataDir)
  } finally {
    db.close()
  }
}

function databaseLineageFromDir(dataDir: string): string {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    return getDatabaseLineage(db)
  } finally {
    db.close()
  }
}

const LEGACY_COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01'

function coldStorageSidecarPath(dataDir: string, key: string): string {
  const saveDir = path.join(dataDir, 'save')
  mkdirSync(saveDir, { recursive: true })
  const storageKey = `coldstorage/${key}`
  return path.join(saveDir, Buffer.from(storageKey, 'utf8').toString('hex'))
}

function writeColdStorageSidecar(dataDir: string, key: string, value: unknown): string {
  const sidecarPath = coldStorageSidecarPath(dataDir, key)
  writeFileSync(sidecarPath, Buffer.from(compressSync(new TextEncoder().encode(JSON.stringify(value)))))
  return sidecarPath
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
  const sigB64 = Buffer.from(signature).toString('base64url')
  return `${signingInput}.${sigB64}`
}

async function setupAuthedClient(app: FastifyInstance): Promise<{ assertion: string }> {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'hunter2' },
  })
  expect(setup.statusCode).toBe(200)

  const keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await subtle.exportKey('jwk', keypair.publicKey)

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'hunter2', publicKey },
  })
  expect(login.statusCode).toBe(200)

  const assertion = await signAssertion(keypair.privateKey, publicKey)
  return { assertion }
}

async function importDatabase(
  app: FastifyInstance,
  assertion: string,
  database: Record<string, unknown>,
): Promise<number> {
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    // Minimal fixtures need one recognized core key to pass the
    // risusave_empty_database import guard.
    payload: { database: { characters: [], ...database } },
  })
  expect(imported.statusCode).toBe(200)
  return imported.json().revision as number
}

type JsonRowTable = 'characters' | 'chats' | 'modules'

function readJsonRow(table: JsonRowTable, id: string): Record<string, unknown> {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    if (table === 'modules') {
      const rows = db.prepare('SELECT data_json FROM modules ORDER BY position').all() as Array<{
        data_json: string
      }>
      const row = rows
        .map((candidate) => JSON.parse(candidate.data_json) as Record<string, unknown>)
        .find((candidate) => candidate.id === id)
      expect(row, `modules row ${id} should exist`).toBeTruthy()
      return row!
    }
    const row = db.prepare(`SELECT data_json FROM ${table} WHERE id = ?`).get(id) as { data_json: string } | undefined
    expect(row, `${table} row ${id} should exist`).toBeTruthy()
    return JSON.parse(row!.data_json) as Record<string, unknown>
  } finally {
    db.close()
  }
}

function writeJsonRow(table: JsonRowTable, id: string, value: Record<string, unknown>): void {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    if (table === 'modules') {
      const rows = db.prepare('SELECT position, data_json FROM modules ORDER BY position').all() as Array<{
        position: number
        data_json: string
      }>
      const row = rows.find((candidate) => (JSON.parse(candidate.data_json) as Record<string, unknown>).id === id)
      expect(row, `modules row ${id} should exist`).toBeTruthy()
      db.prepare('UPDATE modules SET data_json = ? WHERE position = ?').run(JSON.stringify(value), row!.position)
      return
    }
    db.prepare(`UPDATE ${table} SET data_json = ? WHERE id = ?`).run(JSON.stringify(value), id)
  } finally {
    db.close()
  }
}

function updateSettingsRow(mutator: (settings: Record<string, unknown>) => void): void {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
      data_json: string
    }
    const settings = JSON.parse(row.data_json) as Record<string, unknown>
    mutator(settings)
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
  } finally {
    db.close()
  }
}

// The bootstrap ships chat stubs; read persisted messages via per-chat hydration.
async function persistedChatMessages(
  app: FastifyInstance,
  assertion: string,
  chatId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().message as Array<Record<string, unknown>>
}

async function persistedChatAlternates(
  app: FastifyInstance,
  assertion: string,
  chatId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().alternates as Array<Record<string, unknown>>
}

async function persistedChatHypaV3(app: FastifyInstance, assertion: string, chatId: string): Promise<unknown> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().hypaV3Data
}

async function projectedCharacterRow(
  app: FastifyInstance,
  assertion: string,
  characterId: string,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/characters/${encodeURIComponent(characterId)}`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().character as Record<string, unknown>
}

async function projectedPromptItems(
  app: FastifyInstance,
  assertion: string,
): Promise<{ revision: number; promptTemplate?: Array<Record<string, unknown>> }> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/collections/promptTemplate',
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json() as {
    revision: number
    collections: { promptTemplate?: Array<Record<string, unknown>> }
  }
  return { revision: body.revision, promptTemplate: body.collections.promptTemplate }
}

async function uploadAsset(
  app: FastifyInstance,
  assertion: string,
  bytes = Buffer.from('asset-bytes'),
  contentType = 'image/png',
): Promise<{ assetId: string; revision: number }> {
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: {
      'risu-auth': assertion,
      'content-type': contentType,
    },
    payload: bytes,
  })
  expect(uploaded.statusCode).toBe(201)
  return uploaded.json() as { assetId: string; revision: number }
}

function seedAssetMetadata(dataDir: string, assetId = 'a'.repeat(64)): string {
  const seedDb = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    insertAssetMetadataBatch(seedDb, [{ id: assetId, ext: 'png', size: 1, contentType: 'image/png' }])
  } finally {
    seedDb.close()
  }
  return assetId
}

function appBaseUrl(app: FastifyInstance): string {
  const address = app.server.address() as AddressInfo | null
  expect(address).toBeTruthy()
  return `http://127.0.0.1:${address!.port}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPersistedTranslation(
  app: FastifyInstance,
  assertion: string,
  chatId: string,
  expectedText: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let lastMessage: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    const messages = await persistedChatMessages(app, assertion, chatId)
    lastMessage = messages[0]
    const translation = lastMessage?.translation as Record<string, unknown> | null | undefined
    if (translation?.text === expectedText) {
      return lastMessage
    }
    await sleep(25)
  }
  throw new Error(`Timed out waiting for persisted translation. Last message: ${JSON.stringify(lastMessage)}`)
}

async function waitForActiveMessageTranslation(
  app: FastifyInstance,
  assertion: string,
  expected: { chatId: string; messageId: string },
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bootstrap = await injectComposedResourceDatabase(app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const active = bootstrap.json().activeMessageTranslations as Array<{ chatId: string; messageId: string }>
    if (active.some((entry) => entry.chatId === expected.chatId && entry.messageId === expected.messageId)) {
      return
    }
    await sleep(10)
  }
  throw new Error(`Timed out waiting for active message translation: ${JSON.stringify(expected)}`)
}

async function waitForActiveGreetingTranslation(
  app: FastifyInstance,
  assertion: string,
  expected: { characterId: string; chatId: string; greetingIndex: number },
  timeoutMs = 2_000,
): Promise<{ characterId: string; chatId: string; greetingIndex: number; settingsHash: string; jobId: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bootstrap = await injectComposedResourceDatabase(app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const active = bootstrap.json().activeGreetingTranslations as Array<{
      characterId: string
      chatId: string
      greetingIndex: number
      settingsHash: string
      jobId: string
    }>
    const matching = active.find(
      (entry) =>
        entry.characterId === expected.characterId &&
        entry.chatId === expected.chatId &&
        entry.greetingIndex === expected.greetingIndex,
    )
    if (matching) return matching
    await sleep(10)
  }
  throw new Error(`Timed out waiting for active greeting translation: ${JSON.stringify(expected)}`)
}

async function waitForProjectedGreetingTranslation(
  app: FastifyInstance,
  assertion: string,
  characterId: string,
  chatId: string,
  expectedText: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const projection = await app.inject({
      method: 'GET',
      url: `/api/v1/characters/${encodeURIComponent(characterId)}/greeting-translations?chatId=${encodeURIComponent(chatId)}`,
      headers: { 'risu-auth': assertion },
    })
    const translations = projection.json().translations as Array<{ translation?: Record<string, unknown> }>
    const matching = translations.find((entry) => entry.translation?.text === expectedText)?.translation
    if (matching) return matching
    await sleep(25)
  }
  throw new Error(`Timed out waiting for projected greeting translation: ${expectedText}`)
}

async function importMessageTranslationFixture(
  app: FastifyInstance,
  assertion: string,
  options: { echoMessage: string; echoDelay?: number; sourceText?: string },
): Promise<number> {
  return importDatabase(app, assertion, {
    translator: 'ko',
    translatorInputLanguage: 'en',
    translatorType: 'llm',
    aiModel: 'echo_model',
    echoMessage: options.echoMessage,
    ...(options.echoDelay === undefined ? {} : { echoDelay: options.echoDelay }),
    translatorPrompt: 'Translate {{slot::content}} to {{slot}}',
    translatorMaxResponse: 128,
    characters: [
      {
        chaId: 'char-a',
        name: 'A',
        chats: [
          {
            id: 'chat-a',
            name: 'A chat',
            note: '',
            message: [{ role: 'user', data: options.sourceText ?? 'hello raw', chatId: 'msg-a' }],
            localLore: [],
          },
        ],
        chatFolders: [],
        chatPage: 0,
      },
    ],
    characterOrder: ['char-a'],
  })
}

async function importGreetingTranslationFixture(
  app: FastifyInstance,
  assertion: string,
  options: { echoMessage: string; echoDelay?: number },
): Promise<number> {
  return importDatabase(app, assertion, {
    translator: 'ko',
    translatorInputLanguage: 'en',
    translatorType: 'llm',
    aiModel: 'echo_model',
    echoMessage: options.echoMessage,
    ...(options.echoDelay === undefined ? {} : { echoDelay: options.echoDelay }),
    translatorPrompt: 'Translate {{slot::content}} to {{slot}}',
    translatorMaxResponse: 128,
    characters: [
      {
        chaId: 'char-a',
        name: 'A',
        firstMessage: 'primary greeting',
        alternateGreetings: ['alternate greeting'],
        chats: [{ id: 'chat-a', name: 'A chat', message: [], fmIndex: -1 }],
      },
    ],
    characterOrder: ['char-a'],
  })
}

async function postAndDisconnect(url: string, assertion: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload)
  await new Promise<void>((resolve, reject) => {
    let finished = false
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'risu-auth': assertion,
        },
      },
      (res) => {
        res.resume()
      },
    )
    req.on('error', (err) => {
      if (!finished) reject(err)
    })
    req.on('finish', () => {
      finished = true
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 25)
    })
    req.on('timeout', () => reject(new Error('Timed out writing disconnect test request')))
    req.setTimeout(1_000)
    req.end(body)
  })
}

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  await stopHarness(harness)
})

describe('chat generation settings prompt owner validation', () => {
  it.each(['missing', 'duplicate'])('rejects a %s prompt preset owner', (kind) => {
    const promptPresets = kind === 'missing' ? [{ id: 'other' }] : [{ id: 'prompt-a' }, { id: 'prompt-a' }]
    const context = {
      personas: [],
      modelPresets: [],
      promptPresets,
    }

    expect(() =>
      readChatGenerationSettingsSave({ promptPresetId: 'prompt-a', jailbreakToggle: false }, context),
    ).toThrow('Unknown prompt preset id in generationSettings.promptPresetId: prompt-a')
  })
})

describe('command foundation', () => {
  it('rejects unauthenticated runtime settings commands once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      payload: { baseRevision: 0, patch: { streamGeminiThoughts: true } },
    })

    expect(res.statusCode).toBe(401)
  })

  it('rejects missing and invalid baseRevision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { patch: { streamGeminiThoughts: true } },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toBe('baseRevision must be a non-negative integer')

    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: '0', patch: { streamGeminiThoughts: true } },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('baseRevision must be a non-negative integer')
  })

  it('returns 409 with the current revision when baseRevision is stale', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, { streamGeminiThoughts: false })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { streamGeminiThoughts: true } },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })

  it('emits no event and leaves revision + persisted state untouched on a stale (409) write', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, { streamGeminiThoughts: false })
    // Drop the import's own event so we observe only what the stale write does.
    harness.commandEvents.clear()

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { streamGeminiThoughts: true } },
    })
    expect(res.statusCode).toBe(409)

    // The revision-mismatch guard throws BEFORE the mutate callback, so nothing
    // may have leaked: no event, no revision bump, no persisted write.
    expect(harness.commandEvents.list()).toEqual([])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase).toMatchObject({ streamGeminiThoughts: false })
  })

  it('applies the runtime settings harness command, emits an event, and appears in bootstrap', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
      greeting: 'hi',
    })
    harness.commandEvents.clear()

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'runtime',
      },
      acknowledgedKeys: ['streamGeminiThoughts'],
      settings: {},
    })
    expect(harness.commandEvents.list()).toEqual([res.json().event])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase).toMatchObject({
      streamGeminiThoughts: true,
      greeting: 'hi',
    })
  })

  it('serializes same-base ordinary command transactions to one winner', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      theme: 'dark',
      zoomsize: 100,
    })
    const databaseLineage = databaseLineageFromDir(harness.dataDir)
    harness.commandEvents.clear()
    const attempts = [
      {
        field: 'theme',
        initial: 'dark',
        next: 'light',
        mutationId: 'same-base-theme',
        patch: { theme: 'light' },
      },
      {
        field: 'zoomsize',
        initial: 100,
        next: 88,
        mutationId: 'same-base-zoom',
        patch: { zoomsize: 88 },
      },
    ] as const

    const responses = await Promise.all(
      attempts.map((attempt) =>
        harness.app.inject({
          method: 'PATCH',
          url: '/api/v1/commands/settings/display',
          headers: {
            'risu-auth': assertion,
            'risu-writer-session': 'writer-concurrency',
            'risu-mutation-id': attempt.mutationId,
            'risu-database-lineage': databaseLineage,
          },
          payload: { baseRevision: revision, patch: attempt.patch },
        }),
      ),
    )

    expect(responses.map((response) => response.statusCode).sort((left, right) => left - right)).toEqual([200, 409])
    const winnerIndex = responses.findIndex((response) => response.statusCode === 200)
    const loserIndex = responses.findIndex((response) => response.statusCode === 409)
    expect(winnerIndex).toBeGreaterThanOrEqual(0)
    expect(loserIndex).toBeGreaterThanOrEqual(0)
    const winner = attempts[winnerIndex]!
    const loser = attempts[loserIndex]!
    const winnerBody = responses[winnerIndex]!.json()
    expect(winnerBody).toEqual({
      revision: revision + 1,
      event: {
        type: 'settings.updated',
        revision: revision + 1,
        resource: 'settings',
        id: 'display',
      },
      acknowledgedKeys: [winner.field],
      settings: {},
    })
    expect(responses[loserIndex]!.json()).toEqual({
      error: 'revision_conflict',
      currentRevision: revision + 1,
    })
    expect(harness.commandEvents.list()).toEqual([
      {
        ...winnerBody.event,
        origin: { writerSessionId: 'writer-concurrency' },
      },
    ])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(revision + 1)
    const persistedDatabase = bootstrap.resourceDatabase as Record<string, unknown>
    expect(persistedDatabase[winner.field]).toBe(winner.next)
    expect(persistedDatabase[loser.field]).toBe(loser.initial)

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getSchemaState(db).revision).toBe(revision + 1)
      expect(
        db
          .prepare(
            `
              SELECT revision, type, resource, id
              FROM command_events
              WHERE revision > ?
              ORDER BY revision
            `,
          )
          .all(revision),
      ).toEqual([
        {
          revision: revision + 1,
          type: 'settings.updated',
          resource: 'settings',
          id: 'display',
        },
      ])
      const receipts = db
        .prepare(
          `
            SELECT mutation_id AS mutationId, response_json AS responseJson
            FROM command_mutation_receipts
            ORDER BY mutation_id
          `,
        )
        .all() as unknown as Array<{ mutationId: string; responseJson: string }>
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.mutationId).toBe(winner.mutationId)
      expect(JSON.parse(receipts[0]!.responseJson)).toEqual({
        revision: winnerBody.revision,
        event: winnerBody.event,
        extra: {
          acknowledgedKeys: [winner.field],
          settings: {},
        },
      })
    } finally {
      db.close()
    }
  })

  it('rolls back an ordinary command transaction when event persistence fails', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    const databaseLineage = databaseLineageFromDir(harness.dataDir)
    const before = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    let eventCountBeforeFailure: number
    try {
      eventCountBeforeFailure = (
        before.prepare('SELECT COUNT(*) AS count FROM command_events').get() as { count: number }
      ).count
    } finally {
      before.close()
    }
    harness.commandEvents.clear()
    failCommandEventPersistence(harness.dataDir)

    const failed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-event-failure',
        'risu-mutation-id': 'event-persistence-failure',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })

    expect(failed.statusCode).toBe(500)
    expect(harness.commandEvents.list()).toEqual([])
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase).toMatchObject({ streamGeminiThoughts: false })

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getSchemaState(db).revision).toBe(revision)
      expect(db.prepare('SELECT COUNT(*) AS count FROM command_events').get()).toEqual({
        count: eventCountBeforeFailure,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM command_mutation_receipts').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('persists chain-of-thought exclusion as a boolean language setting', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorSendTextAsIs: true,
      translatorExcludeThoughts: false,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/language',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { translatorExcludeThoughts: true } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      acknowledgedKeys: ['translatorExcludeThoughts'],
      event: { resource: 'settings', id: 'language' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      translatorSendTextAsIs: true,
      translatorExcludeThoughts: true,
    })
  })

  it('does not bump revision or mutate persisted state on validation failure', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: 'yes' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('streamGeminiThoughts must be a boolean')

    const badAdditionalParamsOptIn = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { applyAdditionalParamsToAll: 'yes' } },
    })
    expect(badAdditionalParamsOptIn.statusCode).toBe(400)
    expect(badAdditionalParamsOptIn.json().error).toBe('applyAdditionalParamsToAll must be a boolean')

    const emptyMinP = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { min_p: null } },
    })
    expect(emptyMinP.statusCode).toBe(400)
    expect(emptyMinP.json().error).toBe('min_p must be a finite number')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase).toMatchObject({ streamGeminiThoughts: false })
  })

  it('rolls back a thrown JSON command mutation before bumping revision', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-command-helper-'))
    const db = openDatabase(dataDir)
    const commandEvents = createCommandEventSink()
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: { streamGeminiThoughts: false },
      assets: [],
    })

    try {
      expect(() =>
        applyJsonCommandMutation({
          db,
          dataDir,
          baseRevision: 0,
          eventSink: commandEvents,
          mutate(database) {
            const target = database as Record<string, unknown>
            target.streamGeminiThoughts = true
            throw new Error('boom')
          },
        }),
      ).toThrow('boom')

      expect(getSchemaState(db).revision).toBe(0)
      expect(loadPersisted(db, dataDir).database).toMatchObject({ streamGeminiThoughts: false, characters: [] })
      expect(commandEvents.list()).toEqual([])
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rolls back a thrown message-free JSON command mutation before persisting', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-message-free-command-helper-'))
    const db = openDatabase(dataDir)
    const commandEvents = createCommandEventSink()
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: { streamGeminiThoughts: false },
      assets: [],
    })

    try {
      expect(() =>
        applyMessageFreeJsonCommandMutation({
          db,
          dataDir,
          baseRevision: 0,
          eventSink: commandEvents,
          mutate(database) {
            const target = database as Record<string, unknown>
            target.streamGeminiThoughts = true
            throw new Error('boom')
          },
        }),
      ).toThrow('boom')

      expect(getSchemaState(db).revision).toBe(0)
      expect(loadPersisted(db, dataDir).database).toMatchObject({ streamGeminiThoughts: false, characters: [] })
      expect(commandEvents.list()).toEqual([])
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('first-run database seed', () => {
  it('rejects a settings command on a never-seeded (null database) server', async () => {
    // Regression: a fresh server ships database: null, and every command path
    // requires an existing object. The welcome screen's first action (set
    // username) is the first to hit it.
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/account',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { username: 'Test' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('database must be an object before settings commands can run')
  })

  it('creates the server default database, emits an event, and unblocks settings commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    harness.commandEvents.clear()

    const seeded = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(seeded.statusCode).toBe(200)
    expect(seeded.json()).toEqual({
      revision: 1,
      initialized: true,
      event: {
        type: 'state.initialized',
        revision: 1,
        resource: 'state',
      },
    })
    expect(harness.commandEvents.list()).toEqual([seeded.json().event])

    // The previously-rejected settings command now succeeds against revision 1.
    const account = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/account',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 1, patch: { username: 'Test' } },
    })
    expect(account.statusCode).toBe(200)
    expect(account.json().revision).toBe(2)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase).toMatchObject({
      username: 'Test',
      theme: 'fastify',
      temperature: 80,
      botPresets: [],
      modelPresets: [expect.objectContaining({ id: 'default-model-preset' })],
      promptPresets: [expect.objectContaining({ id: 'default-prompt-preset' })],
      personas: [expect.objectContaining({ id: 'default-persona' })],
    })

    const defaultLorebookId = bootstrap.resourceDatabase.loreBook[0]?.id as string
    expect(defaultLorebookId).toBe('default-global-lorebook')
    const entry = {
      id: 'first-default-entry',
      key: 'first',
      secondkey: '',
      insertorder: 100,
      comment: 'First entry',
      content: 'Persisted content',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    const added = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/commands/lorebooks/${encodeURIComponent(defaultLorebookId)}/entries/${entry.id}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, entry },
    })
    expect(added.statusCode).toBe(200)

    const reloaded = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(reloaded.resourceDatabase.loreBook).toEqual([
      expect.objectContaining({ id: defaultLorebookId, data: [expect.objectContaining({ id: entry.id })] }),
    ])
  })

  it('preserves the single-winner behavior when two clients initialize concurrently', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    harness.commandEvents.clear()

    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        harness.app.inject({
          method: 'POST',
          url: '/api/v1/commands/state/initialize',
          headers: { 'risu-auth': assertion },
          payload: {},
        }),
      ),
    )

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    expect(responses.map((response) => response.json().initialized).sort()).toEqual([false, true])
    expect(responses.map((response) => response.json().revision)).toEqual([1, 1])
    expect(harness.commandEvents.list()).toHaveLength(1)
    expect(harness.commandEvents.list()[0]).toMatchObject({ type: 'state.initialized', revision: 1 })
  })

  it('reports a non-object settings row as uninitialized and safely replaces it when no user data exists', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare("INSERT INTO settings (id, data_json) VALUES (1, '[]')").run()
    } finally {
      db.close()
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().initialized).toBe(false)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ revision: 1, initialized: true })
  })

  it('returns initialize_conflict for characters without settings and reports bootstrap initialized', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare(
        'INSERT INTO characters (id, position, data_json) VALUES (\'char-preserved\', 0, \'{"chaId":"char-preserved","name":"Preserved"}\')',
      ).run()
      db.prepare('INSERT INTO modules (position, data_json) VALUES (0, \'{"id":"module-preserved"}\')').run()
    } finally {
      db.close()
    }
    const before = readAllDatabaseRows(harness.dataDir)
    harness.commandEvents.clear()

    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().initialized).toBe(true)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'initialize_conflict' })
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(before)
    expect(harness.commandEvents.list()).toEqual([])
  })

  it('returns initialize_conflict for orphaned messages without touching any table', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare(
        "INSERT INTO messages (chat_id, seq, uid, role, data, json) VALUES ('chat-lost', 0, 'message-preserved', 'user', 'hello', '{\"uid\":\"message-preserved\"}')",
      ).run()
    } finally {
      db.close()
    }
    const before = readAllDatabaseRows(harness.dataDir)
    harness.commandEvents.clear()

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'initialize_conflict' })
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(before)
    expect(harness.commandEvents.list()).toEqual([])
  })

  it('does not seed database or bump revision when initialization event persistence fails', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    failCommandEventPersistence(harness.dataDir)

    const seeded = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(seeded.statusCode).toBe(500)
    expect(harness.commandEvents.list()).toEqual([])
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getSchemaState(db).revision).toBe(0)
      expect(loadPersisted(db, harness.dataDir).database).toBeNull()
    } finally {
      db.close()
    }
  })

  it('is an idempotent no-op that never clobbers an existing database', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'Existing',
      characters: [{ chaId: 'char-a', name: 'Ada' }],
    })
    harness.commandEvents.clear()

    const seeded = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(seeded.statusCode).toBe(200)
    expect(seeded.json()).toEqual({ revision, initialized: false })
    // No write happened: no event, revision unchanged, data preserved.
    expect(harness.commandEvents.list()).toEqual([])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase).toMatchObject({ username: 'Existing' })
  })

  it('rejects request-shaped database seed payloads', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: { database: { username: 'client-shaped' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('database payload is no longer accepted for state initialization')
  })

  it('rejects non-object initialize bodies', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: ['array'],
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('request body must be an object')
  })
})

describe('scalar settings groups', () => {
  it('applies display settings through the grouped settings command', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      theme: 'dark',
      zoomsize: 100,
      chatScreenWidth: 900,
      desktopSidebarColumns: 1,
      mobileSidebarColumns: 1,
      autoTranslateNotificationDeferCapSeconds: 180,
      paragraphBreakBySentences: false,
      paragraphBreakSentenceCount: 3,
      greeting: 'hi',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          theme: 'light',
          zoomsize: 88,
          chatScreenWidth: 1240,
          desktopSidebarColumns: 4,
          mobileSidebarColumns: 2,
          autoTranslateNotificationDeferCapSeconds: 0,
          paragraphBreakBySentences: true,
          paragraphBreakSentenceCount: 5,
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'display',
      },
      acknowledgedKeys: [
        'theme',
        'zoomsize',
        'chatScreenWidth',
        'desktopSidebarColumns',
        'mobileSidebarColumns',
        'autoTranslateNotificationDeferCapSeconds',
        'paragraphBreakBySentences',
        'paragraphBreakSentenceCount',
      ],
      settings: {},
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase).toMatchObject({
      theme: 'light',
      zoomsize: 88,
      chatScreenWidth: 1240,
      desktopSidebarColumns: 4,
      mobileSidebarColumns: 2,
      autoTranslateNotificationDeferCapSeconds: 0,
      paragraphBreakBySentences: true,
      paragraphBreakSentenceCount: 5,
      greeting: 'hi',
    })
  })

  it('rejects sidebar column values outside each exact integer range', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      desktopSidebarColumns: 1,
      mobileSidebarColumns: 1,
    })

    for (const [key, values, maximum] of [
      ['desktopSidebarColumns', [0, 1.5, 5], 4],
      ['mobileSidebarColumns', [0, 1.5, 3], 2],
    ] as const) {
      for (const value of values) {
        const res = await harness.app.inject({
          method: 'PATCH',
          url: '/api/v1/commands/settings/display',
          headers: { 'risu-auth': assertion },
          payload: { baseRevision: revision, patch: { [key]: value } },
        })

        expect(res.statusCode).toBe(400)
        expect(res.json().error).toBe(`${key} must be an integer from 1 to ${maximum}`)
      }
    }
  })

  it('omits a large verbatim setting value from the command response', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      customCSS: '',
    })
    const customCSS = `/* large */${'x'.repeat(64 * 1024)}`

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { customCSS } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      acknowledgedKeys: ['customCSS'],
      settings: {},
    })
    expect(res.body).not.toContain(customCSS)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.customCSS).toBe(customCSS)
  })

  it('patches large settings objects by field without echoing or replacing untouched data', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const thumbnail = `data:image/png;base64,${'x'.repeat(64 * 1024)}`
    const originalVibe = {
      identifier: 'novelai-vibe-transfer',
      version: 1,
      type: 'image',
      image: '',
      id: 'vibe-a',
      encodings: {},
      name: 'Large vibe',
      thumbnail,
      createdAt: 1,
      importInfo: { model: 'nai-diffusion-4-5-full', information_extracted: 1 },
    }
    const revision = await importDatabase(harness.app, assertion, {
      NAIImgConfig: {
        width: 512,
        height: 768,
        sampler: 'k_euler',
        vibe_data: originalVibe,
      },
      seperateParameters: {
        memory: { temperature: 0.4 },
        emotion: { temperature: 0.2 },
        translate: {},
        otherAx: {},
        scriptMain: {},
        scriptAux: {},
        overrides: { 'openrouter/model': { top_k: 42 } },
      },
    })

    const imagePatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { width: 832 } },
    })

    expect(imagePatch.statusCode, imagePatch.body).toBe(200)
    expect(imagePatch.json()).toEqual({
      revision: revision + 1,
      event: {
        type: 'settings.updated',
        revision: revision + 1,
        resource: 'settings',
        id: 'media',
      },
      group: 'media',
      key: 'NAIImgConfig',
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['width'],
      deletedKeys: [],
      canonicalValues: {},
      canonicalDeletedKeys: [],
    })
    expect(imagePatch.body).not.toContain(thumbnail)

    const parametersPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime/objects/seperateParameters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: imagePatch.json().revision,
        patch: { memory: { temperature: 0.8 } },
      },
    })

    expect(parametersPatch.statusCode, parametersPatch.body).toBe(200)
    expect(parametersPatch.json()).toMatchObject({
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['memory'],
      deletedKeys: [],
      canonicalValues: {},
      canonicalDeletedKeys: [],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.NAIImgConfig).toMatchObject({
      width: 832,
      height: 768,
      sampler: 'k_euler',
      vibe_data: originalVibe,
    })
    expect(bootstrap.resourceDatabase.seperateParameters).toEqual({
      memory: { temperature: 0.8 },
      emotion: { temperature: 0.2 },
      translate: {},
      otherAx: {},
      scriptMain: {},
      scriptAux: {},
      overrides: { 'openrouter/model': { top_k: 42 } },
    })
  })

  it('returns only the masked override when a shallow settings patch changes a secret', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      wavespeedImage: {
        key: 'old-secret',
        model: 'old-model',
        loras: [{ path: 'owner/old', scale: 1 }],
      },
    })

    const modelPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media/objects/wavespeedImage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { model: 'flux' } },
    })
    expect(modelPatch.statusCode, modelPatch.body).toBe(200)
    expect(modelPatch.json()).toMatchObject({
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['model'],
      canonicalValues: {},
    })
    expect(modelPatch.body).not.toContain('old-secret')

    const secretPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media/objects/wavespeedImage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: modelPatch.json().revision, patch: { key: 'new-secret' } },
    })
    expect(secretPatch.statusCode, secretPatch.body).toBe(200)
    expect(secretPatch.json()).toMatchObject({
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['key'],
      canonicalValues: { key: MASKED_PROVIDER_SECRET },
    })
    expect(secretPatch.body).not.toContain('new-secret')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.wavespeedImage).toMatchObject({
      key: MASKED_PROVIDER_SECRET,
      model: 'flux',
      loras: [{ path: 'owner/old', scale: 1 }],
    })
  })

  it('rejects malformed shallow settings updates without advancing the revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      NAIImgConfig: { width: 512, height: 768 },
    })
    const attempts = [
      {
        url: '/api/v1/commands/settings/runtime/objects/NAIImgConfig',
        payload: { baseRevision: revision, patch: { width: 832 } },
      },
      {
        url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
        payload: { baseRevision: revision, patch: { width: 832 }, deleteKeys: ['width'] },
      },
      {
        url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
        payload: { baseRevision: revision, patch: {} },
      },
      {
        url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
        payload: { baseRevision: revision, patch: { width: 832 }, attemptedObject: { width: 832 } },
      },
    ]

    for (const attempt of attempts) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: attempt.url,
        headers: { 'risu-auth': assertion },
        payload: attempt.payload,
      })
      expect(response.statusCode, response.body).toBe(400)
    }

    const valid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { width: 832 } },
    })
    expect(valid.statusCode, valid.body).toBe(200)
    expect(valid.json().revision).toBe(revision + 1)
  })

  it('returns only a normalized settings override alongside the acknowledged keys', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      keepSessionAlive: 'off',
      showUnrecommended: false,
      regexOutputSizeLimitMiB: 16,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          keepSessionAlive: 'pip',
          showUnrecommended: true,
          regexOutputSizeLimitMiB: 32,
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      acknowledgedKeys: ['keepSessionAlive', 'showUnrecommended', 'regexOutputSizeLimitMiB'],
      settings: { keepSessionAlive: 'sound' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      keepSessionAlive: 'sound',
      showUnrecommended: true,
      regexOutputSizeLimitMiB: 32,
    })
  })

  it('rejects regex output limits outside the supported range', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { regexOutputSizeLimitMiB: 16 })

    for (const regexOutputSizeLimitMiB of [0, 65, 1.5]) {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/advanced',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch: { regexOutputSizeLimitMiB } },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('regexOutputSizeLimitMiB must be an integer from 1 to 64')
    }
  })

  it('accepts grouped settings updates across resource families', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const customColorScheme = {
      bgcolor: '#111111',
      darkbg: '#222222',
      borderc: '#333333',
      selected: '#444444',
      draculared: '#555555',
      textcolor: '#eeeeee',
      textcolor2: '#dddddd',
      darkBorderc: '#666666',
      darkbutton: '#777777',
      type: 'dark',
    }
    const revision = await importDatabase(harness.app, assertion, {
      notification: false,
      useAutoSuggestions: false,
      useAutoTranslateInput: false,
      globalscript: [],
    })

    const display = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          notification: true,
          textScreenColor: null,
          promptDiffPrefs: { diffStyle: 'line', contextRadius: 2 },
          customTextTheme: { FontColorStandard: '#ffffff' },
          customColorScheme,
        },
      },
    })
    expect(display.statusCode).toBe(200)

    const runtime = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: display.json().revision,
        patch: { useAutoSuggestions: true },
      },
    })
    expect(runtime.statusCode).toBe(200)

    const language = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/language',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: runtime.json().revision,
        patch: { useAutoTranslateInput: true },
      },
    })
    expect(language.statusCode).toBe(200)

    const advanced = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: language.json().revision,
        patch: {
          globalscript: [{ id: 'script-a', in: 'foo', out: 'bar', type: 'editinput' }],
          allowAllExtentionFiles: true,
          auxModelUnderModelSettings: true,
          pluginCompatibilityMode: true,
          strictScriptCheck: true,
          keepSessionAlive: 'pip',
        },
      },
    })
    expect(advanced.statusCode).toBe(200)

    const sidebar = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/sidebar',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: advanced.json().revision,
        patch: {
          globalChatVariables: { toggle_mood: '1' },
          jailbreakToggle: true,
          chatGenerationTogglePresets: [
            {
              id: 'toggle-preset-a',
              name: 'Toggle Preset A',
              createdAt: 1,
              updatedAt: 2,
              jailbreakToggle: true,
              sidebarToggles: {
                mood: '1',
              },
            },
          ],
          customSidebarItems: [
            {
              id: 'sidebar-loadout',
              type: 'loadout',
              subType: 'none',
              label: 'Loadouts',
            },
          ],
          hotkeys: [{ key: 'a', ctrl: true, action: 'home' }],
        },
      },
    })
    expect(sidebar.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      notification: true,
      useAutoSuggestions: true,
      useAutoTranslateInput: true,
      textScreenColor: null,
      promptDiffPrefs: { diffStyle: 'line', contextRadius: 2 },
      customTextTheme: { FontColorStandard: '#ffffff' },
      customColorScheme,
      globalscript: [{ id: 'script-a', in: 'foo', out: 'bar', type: 'editinput' }],
      allowAllExtentionFiles: true,
      auxModelUnderModelSettings: true,
      globalChatVariables: { toggle_mood: '1' },
      jailbreakToggle: true,
      keepSessionAlive: 'sound',
      chatGenerationTogglePresets: [
        {
          id: 'toggle-preset-a',
          name: 'Toggle Preset A',
          createdAt: 1,
          updatedAt: 2,
          sidebarToggles: {
            mood: '1',
          },
        },
      ],
      customSidebarItems: [
        {
          id: 'sidebar-loadout',
          type: 'loadout',
          subType: 'none',
          label: 'Loadouts',
        },
      ],
      hotkeys: [{ key: 'a', ctrl: true, action: 'home' }],
    })
  })

  it('applies compact global-script mutations without echoing the script corpus', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const largeBody = 'x'.repeat(64 * 1024)
    const scripts = [
      { id: 'script-a', comment: 'A', in: 'a', out: largeBody, type: 'editinput' },
      { id: 'script-b', comment: 'B', in: 'b', out: largeBody, type: 'editoutput' },
    ]
    const revision = await importDatabase(harness.app, assertion, { globalscript: scripts })
    const expectedScripts = [{ ...scripts[0], comment: 'Edited A' }, scripts[1]]

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced/global-scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: {
          op: 'update',
          id: 'script-a',
          patch: { comment: 'Edited A' },
          deleteKeys: [],
        },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: revision + 1,
      event: {
        type: 'settings.updated',
        revision: revision + 1,
        resource: 'settings',
        id: 'advanced',
      },
      group: 'advanced',
      key: 'globalscript',
      certificate: 'global-script-mutation-v1',
      operation: 'update',
      globalScriptsDigest: createHash('sha256')
        .update(serializeScriptDefinitionCollectionDigestInput(expectedScripts), 'utf8')
        .digest('hex'),
      acknowledgedKeys: ['globalscript'],
      settings: {},
    })
    expect(updated.body).not.toContain(largeBody)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.globalscript).toEqual(expectedScripts)

    const unknown = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced/global-scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        mutation: { op: 'delete', id: 'missing-script' },
      },
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toEqual({ error: 'Script definition not found: missing-script' })
  })

  it('rejects malformed custom sidebar setting rows before persistence', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { customSidebarItems: [] })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/sidebar',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customSidebarItems: [
            {
              id: 'bad-setting',
              type: 'setting',
              label: 'Broken setting',
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'customSidebarItems[0].subType must be a string',
    })
  })

  it('rejects unsupported legacy database-key sidebar rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { customSidebarItems: [] })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/sidebar',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customSidebarItems: [
            {
              id: 'legacy-database-key',
              type: 'databaseKey',
              subType: 'temperature',
              label: 'Temperature',
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'customSidebarItems[0].type is unsupported',
    })
  })

  it('sanitizes custom sidebar rows to the supported persisted shape', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { customSidebarItems: [] })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/sidebar',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customSidebarItems: [
            {
              id: 'theme-setting',
              type: 'setting',
              subType: 'display.theme',
              label: 'Theme',
              setting: undefined,
              nested: { unsafe: true },
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.customSidebarItems).toEqual([
      {
        id: 'theme-setting',
        type: 'setting',
        subType: 'display.theme',
        label: 'Theme',
      },
    ])
  })

  it('allows provider scalar updates and masks them in bootstrap', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      openAIKey: 'old',
      aiModel: 'gpt4o-chatgpt',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { openAIKey: 'new-secret', aiModel: 'openrouter' },
      },
    })

    expect(res.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      openAIKey: MASKED_PROVIDER_SECRET,
      aiModel: 'openrouter',
    })
  })

  it('accepts durable model profile selected-model settings through the provider compatibility group', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      aiModel: 'flat-main-model',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          providerCredentials: [
            {
              id: ' credential-vertex ',
              name: ' Vertex ',
              type: 'vertexServiceAccount',
              vertex: {
                clientEmail: ' svc@example.iam.gserviceaccount.com ',
                privateKey: ' private-key ',
              },
            },
          ],
          modelProfiles: [
            {
              id: ' profile-a ',
              name: ' Primary ',
              providerId: ' vertex ',
              modelId: ' gpt-5 ',
              providerOptions: {
                credentialId: ' credential-vertex ',
                requestModel: ' wire-model ',
                extraHeaders: { 'X-Test': ' yes ' },
                additionalParams: [[' header::X-Test ', ' true ']],
                vertex: {
                  projectId: ' project-a ',
                  region: ' us-central1 ',
                },
              },
              runtimeOptions: {
                maxContext: 32768,
                maxResponse: 2048,
                temperature: 70,
                topP: 0.9,
                frequencyPenalty: -25,
                useStreaming: false,
                genTime: 3,
                extractJson: ' object ',
                jsonSchemaEnabled: true,
                stripCoT: false,
                modelTools: [' tool-a ', ''],
                customFlags: [LLMFlags.hasImageInput],
                customTokenizer: ' custom-tokenizer ',
              },
              fallbacks: [
                { mode: 'profile', profileId: ' fallback-profile ' },
                { mode: 'model', modelId: ' fallback-model ' },
              ],
            },
          ],
          modelRoleProfiles: {
            memory: { mode: 'profile', profileId: ' profile-a ' },
            scriptMain: { mode: 'inherit' },
          },
          modelRuntimeDefaults: {
            maxContext: 8192,
            temperature: 55,
            stripCoT: true,
            modelTools: [' tool-a ', ''],
          },
        },
      },
    })

    expect(res.statusCode, res.body).toBe(200)
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      aiModel: 'flat-main-model',
      providerCredentials: [
        {
          id: 'credential-vertex',
          name: 'Vertex',
          type: 'vertexServiceAccount',
          vertex: {
            clientEmail: 'svc@example.iam.gserviceaccount.com',
            privateKey: 'private-key',
          },
        },
      ],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Primary',
          providerId: 'vertex',
          modelId: 'gpt-5',
          providerOptions: {
            credentialId: 'credential-vertex',
            requestModel: 'wire-model',
            extraHeaders: { 'X-Test': 'yes' },
            additionalParams: [['header::X-Test', 'true']],
            vertex: {
              projectId: 'project-a',
              region: 'us-central1',
            },
          },
          runtimeOptions: {
            maxContext: 32768,
            maxResponse: 2048,
            temperature: 70,
            topP: 0.9,
            frequencyPenalty: -25,
            useStreaming: false,
            genTime: 3,
            extractJson: 'object',
            jsonSchemaEnabled: true,
            stripCoT: false,
            modelTools: ['tool-a'],
            customFlags: [LLMFlags.hasImageInput],
            customTokenizer: 'custom-tokenizer',
          },
          fallbacks: [
            { mode: 'profile', profileId: 'fallback-profile' },
            { mode: 'model', modelId: 'fallback-model' },
          ],
        },
      ],
      modelRoleProfiles: {
        ...Object.fromEntries(MODEL_ROLES.map((role) => [role, { mode: 'legacy' }])),
        memory: { mode: 'profile', profileId: 'profile-a' },
        scriptMain: { mode: 'inherit' },
      },
      modelRuntimeDefaults: {
        maxContext: 8192,
        temperature: 55,
        stripCoT: true,
        modelTools: ['tool-a'],
      },
    })
  })

  it('rejects malformed durable model profile scaffold settings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      aiModel: 'flat-main-model',
    })

    const cases: Array<{ patch: Record<string, unknown>; error: string }> = [
      {
        patch: {
          modelProfiles: [
            { id: 'profile-a', name: 'Primary' },
            { id: ' profile-a ', name: 'Duplicate' },
          ],
        },
        error: 'Duplicate model profile id: profile-a',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', providerOptions: { apiKey: 42 } }],
        },
        error:
          'modelProfiles[0].providerOptions.apiKey is no longer supported; reference a credential via modelProfiles[0].providerOptions.credentialId',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', fallbacks: [{ mode: 'legacy', profileId: 'x' }] }],
        },
        error: 'modelProfiles[0].fallbacks[0].mode must be profile or model',
      },
      {
        patch: {
          modelProfiles: [
            {
              id: 'profile-a',
              name: 'Primary',
              fallbacks: [
                { mode: 'profile', profileId: 'fallback-a' },
                { mode: 'profile', profileId: ' fallback-a ' },
              ],
            },
          ],
        },
        error: 'modelProfiles[0].fallbacks[1].profileId must not duplicate fallback-a',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', providerOptions: { openAIKey: 'not-allowed' } }],
        },
        error: 'modelProfiles[0].providerOptions.openAIKey is not supported',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', providerOptions: { requestModel: 42 } }],
        },
        error: 'modelProfiles[0].providerOptions.requestModel must be a string when present',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', runtimeOptions: { notSupported: true } }],
        },
        error: 'modelProfiles[0].runtimeOptions.notSupported is not supported',
      },
      {
        patch: {
          modelProfiles: [{ id: 'profile-a', name: 'Primary', runtimeOptions: { customFlags: [999] } }],
        },
        error:
          'modelProfiles[0].runtimeOptions.customFlags must be an array of valid LLMFlags numeric values when present',
      },
      {
        patch: {
          modelRuntimeDefaults: { notSupported: true },
        },
        error: 'modelRuntimeDefaults.notSupported is not supported',
      },
      {
        patch: {
          modelRuntimeDefaults: { customFlags: [999] },
        },
        error: 'modelRuntimeDefaults.customFlags must be an array of valid LLMFlags numeric values when present',
      },
      {
        patch: {
          modelRoleProfiles: { unknownRole: { mode: 'legacy' } },
        },
        error: 'Unknown model role profile binding: unknownRole',
      },
      {
        patch: {
          modelRoleProfiles: { memory: { mode: 'profile' } },
        },
        error: 'modelRoleProfiles.memory.profileId must be a non-empty string',
      },
      {
        patch: {
          modelRoleProfiles: { memory: { mode: 'profile', profileId: '' } },
        },
        error: 'modelRoleProfiles.memory.profileId must be a non-empty string',
      },
      {
        patch: {
          modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-a', providerOptions: {} } },
        },
        error: 'modelRoleProfiles.memory.providerOptions is not supported',
      },
      {
        patch: {
          modelRoleProfiles: { chatMain: { mode: 'inherit' } },
        },
        error: 'modelRoleProfiles.chatMain.mode does not support inherit',
      },
      {
        patch: {
          modelRoleProfiles: { memory: { mode: 'inherit', profileId: 'profile-a' } },
        },
        error: 'modelRoleProfiles.memory.profileId is only supported for profile mode',
      },
    ]

    for (const candidate of cases) {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/providers',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: candidate.patch,
        },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(candidate.error)
    }
  })

  it('creates and binds a model profile in one revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelProfiles: [],
      providerCredentials: [{ id: 'credential-memory', name: 'Memory', type: 'apiKey', apiKey: 'memory-key' }],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/create-and-bind',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        role: 'memory',
        profile: {
          name: 'Memory Profile',
          providerId: 'openai',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-memory' },
        },
      },
    })

    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { revision: number; profileId: string; role: string; event: Record<string, unknown> }
    expect(body.revision).toBe(revision + 1)
    expect(body.profileId).toMatch(/^mp_/)
    expect(body.role).toBe('memory')
    expect(body.event).toMatchObject({
      type: 'modelProfile.createdAndBound',
      resource: 'modelProfile',
      id: body.profileId,
      revision: revision + 1,
    })

    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      modelProfiles: [
        {
          id: body.profileId,
          name: 'Memory Profile',
          providerId: 'openai',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-memory' },
        },
      ],
      modelRoleProfiles: {
        memory: { mode: 'profile', profileId: body.profileId },
      },
    })
  })

  it('rejects missing credential references on profile create, update, and create-and-bind', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [],
      modelProfiles: [{ id: 'profile-a', name: 'Profile A', providerId: 'openai', modelId: 'gpt-5' }],
    })
    const profile = {
      name: 'Missing credential',
      providerId: 'openai',
      modelId: 'gpt-5',
      providerOptions: { credentialId: 'credential-missing' },
    }

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, profile },
    })
    expect(created.statusCode).toBe(400)
    expect(created.json().error).toBe(
      'profile.providerOptions.credentialId must reference an existing provider credential',
    )

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        expectedProfile: { id: 'profile-a', name: 'Profile A', providerId: 'openai', modelId: 'gpt-5' },
        profile: { ...profile, id: 'profile-a' },
      },
    })
    expect(updated.statusCode).toBe(400)
    expect(updated.json().error).toBe(
      'profile.providerOptions.credentialId must reference an existing provider credential',
    )

    const bound = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/create-and-bind',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, role: 'memory', profile },
    })
    expect(bound.statusCode).toBe(400)
    expect(bound.json().error).toBe(
      'profile.providerOptions.credentialId must reference an existing provider credential',
    )
  })

  it('updates role bindings and their selected model-preset mirror atomically', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [
        { id: 'credential-anthropic', name: 'Anthropic', type: 'apiKey', apiKey: 'anthropic-secret' },
      ],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Profile A',
          providerId: 'debug-echo',
          modelId: 'echo_model',
        },
      ],
      modelPresets: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ],
      modelPresetsId: 0,
    })

    const updated = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/model-role-profiles',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        bindings: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
        modelPresetId: 'model-a',
      },
    })

    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json()).toMatchObject({
      revision: revision + 1,
      roles: ['chatMain'],
      event: {
        type: 'modelPreset.updated',
        resource: 'modelPreset',
        id: 'model-a',
      },
    })
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modelRoleProfiles: Record<string, unknown>
      modelPresets: unknown[]
    }
    expect(persisted.modelRoleProfiles).toMatchObject({
      chatMain: { mode: 'profile', profileId: 'profile-a' },
    })
    expect(persisted.modelPresets).toEqual([
      expect.objectContaining({
        id: 'model-a',
        modelRoleProfiles: expect.objectContaining({
          chatMain: { mode: 'profile', profileId: 'profile-a' },
        }),
      }),
      expect.objectContaining({ id: 'model-b', name: 'Model B' }),
    ])

    const missingPreset = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/model-role-profiles',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        bindings: { chatAux: { mode: 'profile', profileId: 'profile-a' } },
        modelPresetId: 'missing-preset',
      },
    })
    expect(missingPreset.statusCode).toBe(404)
    const afterRejectedMirror = loadPersistedFromDir(harness.dataDir).database as {
      modelRoleProfiles: Record<string, unknown>
    }
    expect(afterRejectedMirror.modelRoleProfiles).toMatchObject({
      chatAux: { mode: 'legacy' },
    })
  })

  it('rejects a memory role binding that the summary worker cannot execute', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [
        { id: 'credential-anthropic', name: 'Anthropic', type: 'apiKey', apiKey: 'anthropic-secret' },
      ],
      modelProfiles: [
        {
          id: 'anthropic-memory',
          name: 'Anthropic Memory',
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet-latest',
          providerOptions: { credentialId: 'credential-anthropic' },
        },
      ],
    })

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/model-role-profiles',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        bindings: { memory: { mode: 'profile', profileId: 'anthropic-memory' } },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe(
      'bindings.memory is unsupported: summarization memory provider is not API-backed OpenAI-compatible: anthropic',
    )
    const persisted = loadPersistedFromDir(harness.dataDir).database as Database
    expect(persisted.modelRoleProfiles).toMatchObject({
      memory: { mode: 'legacy' },
    })
  })

  it('creates, renames, rotates, and deletes provider credentials with masked placeholder semantics', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [{ id: 'credential-in-use', name: 'In use', type: 'apiKey', apiKey: 'in-use-secret' }],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Profile A',
          providerId: 'openai',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-in-use' },
        },
      ],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/provider-credentials',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        credential: { name: 'Created API key', type: 'apiKey', apiKey: 'created-secret' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const credentialId = created.json().credentialId as string
    expect(credentialId).toMatch(/^cred_[0-9a-f]{20}$/)
    expect(created.json().event).toMatchObject({
      type: 'providerCredential.created',
      resource: 'providerCredential',
      id: credentialId,
    })

    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/provider-credentials/${credentialId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        expectedCredential: {
          id: credentialId,
          name: 'Created API key',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
        credential: {
          id: credentialId,
          name: 'Renamed API key',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
      },
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(
      (
        loadPersistedFromDir(harness.dataDir).database as {
          providerCredentials: Array<Record<string, unknown>>
        }
      ).providerCredentials,
    ).toContainEqual({
      id: credentialId,
      name: 'Renamed API key',
      type: 'apiKey',
      apiKey: 'created-secret',
    })

    const rotated = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/provider-credentials/${credentialId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: renamed.json().revision,
        expectedCredential: {
          id: credentialId,
          name: 'Renamed API key',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
        credential: {
          id: credentialId,
          name: 'Renamed API key',
          type: 'apiKey',
          apiKey: 'rotated-secret',
        },
      },
    })
    expect(rotated.statusCode, rotated.body).toBe(200)
    expect(
      (
        loadPersistedFromDir(harness.dataDir).database as {
          providerCredentials: Array<Record<string, unknown>>
        }
      ).providerCredentials,
    ).toContainEqual({
      id: credentialId,
      name: 'Renamed API key',
      type: 'apiKey',
      apiKey: 'rotated-secret',
    })

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/provider-credentials/${credentialId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: rotated.json().revision,
        expectedCredential: {
          id: credentialId,
          name: 'Created API key',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
        credential: {
          id: credentialId,
          name: 'Stale rename',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
      },
    })
    expect(stale.statusCode, stale.body).toBe(409)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/commands/provider-credentials/${credentialId}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: rotated.json().revision },
    })
    expect(deleted.statusCode, deleted.body).toBe(200)

    const inUse = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/provider-credentials/credential-in-use',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: deleted.json().revision },
    })
    expect(inUse.statusCode, inUse.body).toBe(400)
    expect(inUse.json().error).toContain('Profile A (profile-a)')
  })

  it('rejects unresolved masked secrets when changing credential types', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [
        { id: 'credential-api', name: 'API', type: 'apiKey', apiKey: 'api-secret' },
        {
          id: 'credential-vertex',
          name: 'Vertex',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-secret' },
        },
      ],
    })

    const cases = [
      {
        credentialId: 'credential-api',
        expectedCredential: {
          id: 'credential-api',
          name: 'API',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
        credential: {
          id: 'credential-api',
          name: 'API switched to Vertex',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'switched@example.com', privateKey: MASKED_PROVIDER_SECRET },
        },
      },
      {
        credentialId: 'credential-vertex',
        expectedCredential: {
          id: 'credential-vertex',
          name: 'Vertex',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'vertex@example.com', privateKey: MASKED_PROVIDER_SECRET },
        },
        credential: {
          id: 'credential-vertex',
          name: 'Vertex switched to API',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
      },
    ] as const

    for (const testCase of cases) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/commands/provider-credentials/${testCase.credentialId}`,
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          expectedCredential: testCase.expectedCredential,
          credential: testCase.credential,
        },
      })
      expect(response.statusCode, response.body).toBe(400)
      expect(response.json().error).toBe(
        'Masked provider secret placeholders must resolve before a credential can be saved',
      )
    }

    const unresolvedExpected = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/provider-credentials/credential-api',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        expectedCredential: {
          id: 'credential-api',
          name: 'Wrong expected type',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'wrong@example.com', privateKey: MASKED_PROVIDER_SECRET },
        },
        credential: {
          id: 'credential-api',
          name: 'API rotated',
          type: 'apiKey',
          apiKey: 'new-api-secret',
        },
      },
    })
    expect(unresolvedExpected.statusCode, unresolvedExpected.body).toBe(409)

    expect(
      (
        loadPersistedFromDir(harness.dataDir).database as {
          providerCredentials: Array<Record<string, unknown>>
        }
      ).providerCredentials,
    ).toEqual([
      { id: 'credential-api', name: 'API', type: 'apiKey', apiKey: 'api-secret' },
      {
        id: 'credential-vertex',
        name: 'Vertex',
        type: 'vertexServiceAccount',
        vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-secret' },
      },
    ])
  })

  it('rejects stale model profile rows even when the caller has the latest global revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [{ id: 'credential-profile', name: 'Profile', type: 'apiKey', apiKey: 'profile-key' }],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Profile A',
          providerId: 'openai',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-profile', requestModel: 'wire-v1' },
          runtimeOptions: { temperature: 50 },
        },
      ],
    })
    const originalProfile = {
      id: 'profile-a',
      name: 'Profile A',
      providerId: 'openai',
      modelId: 'gpt-5',
      providerOptions: { credentialId: 'credential-profile', requestModel: 'wire-v1' },
      runtimeOptions: { temperature: 50 },
    }
    const concurrentProfile = {
      ...originalProfile,
      providerOptions: { credentialId: 'credential-profile', requestModel: 'wire-v2' },
      runtimeOptions: { temperature: 70 },
    }

    const concurrent = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        expectedProfile: originalProfile,
        profile: concurrentProfile,
      },
    })
    expect(concurrent.statusCode, concurrent.body).toBe(200)
    const concurrentRevision = concurrent.json().revision as number

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: concurrentRevision,
        expectedProfile: originalProfile,
        profile: { ...originalProfile, name: 'Locally renamed' },
      },
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: concurrentRevision })
    expect(
      (loadPersistedFromDir(harness.dataDir).database as { modelProfiles: Array<Record<string, any>> })
        .modelProfiles[0],
    ).toMatchObject({
      name: 'Profile A',
      providerOptions: { credentialId: 'credential-profile', requestModel: 'wire-v2' },
      runtimeOptions: { temperature: 70 },
    })

    const cleared = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: concurrentRevision,
        expectedProfile: concurrentProfile,
        profile: {
          ...concurrentProfile,
          providerOptions: { requestModel: 'wire-v2' },
        },
      },
    })
    expect(cleared.statusCode, cleared.body).toBe(200)
    const clearedRevision = cleared.json().revision as number

    const staleCredentialReference = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/model-profiles/profile-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: clearedRevision,
        expectedProfile: concurrentProfile,
        profile: { ...concurrentProfile, name: 'Stale credential edit' },
      },
    })
    expect(staleCredentialReference.statusCode, staleCredentialReference.body).toBe(409)
    const persistedAfterClear = (
      loadPersistedFromDir(harness.dataDir).database as { modelProfiles: Array<Record<string, any>> }
    ).modelProfiles[0]
    expect(persistedAfterClear.name).toBe('Profile A')
    expect(persistedAfterClear.providerOptions).toEqual({ requestModel: 'wire-v2' })
  })

  it('duplicates model profiles while naturally preserving credential references', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      providerCredentials: [
        {
          id: 'credential-vertex',
          name: 'Vertex',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'svc@example.com', privateKey: 'vertex-private' },
        },
      ],
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Profile A',
          providerId: 'vertex',
          modelId: 'gemini-2.5-pro-vertex',
          providerOptions: {
            credentialId: 'credential-vertex',
            requestModel: 'wire-model',
            vertex: {
              projectId: 'project-a',
              region: 'us-central1',
            },
          },
        },
      ],
    })

    const duplicated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/profile-a/duplicate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, name: 'Profile Copy' },
    })
    expect(duplicated.statusCode, duplicated.body).toBe(200)
    const duplicatedId = duplicated.json().profileId as string

    const profiles = (loadPersistedFromDir(harness.dataDir).database as { modelProfiles: Array<Record<string, any>> })
      .modelProfiles
    const copied = profiles.find((profile) => profile.id === duplicatedId)
    expect(copied).toMatchObject({
      id: duplicatedId,
      name: 'Profile Copy',
      providerOptions: {
        credentialId: 'credential-vertex',
        requestModel: 'wire-model',
        vertex: {
          projectId: 'project-a',
          region: 'us-central1',
        },
      },
    })
  })

  it('reorders model profiles only with a complete stable-id order', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelProfiles: [
        { id: 'profile-a', name: 'A', modelId: 'gpt-5' },
        { id: 'profile-b', name: 'B', modelId: 'gpt-4o' },
        { id: 'profile-c', name: 'C', modelId: 'claude-sonnet-4-5' },
      ],
    })

    const incomplete = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, profileIds: ['profile-b', 'profile-a'] },
    })
    expect(incomplete.statusCode).toBe(400)
    expect(incomplete.json().error).toBe('profileIds must include every existing model profile exactly once')

    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, profileIds: ['profile-a', 'profile-a', 'profile-c'] },
    })
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().error).toBe('Duplicate model profile id: profile-a')

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        order: [
          { kind: 'profile', profileId: 'profile-c' },
          { kind: 'divider', id: 'divider-a' },
          { kind: 'profile', profileId: 'profile-a' },
          { kind: 'profile', profileId: 'profile-b' },
        ],
      },
    })
    expect(reordered.statusCode, reordered.body).toBe(200)
    expect(reordered.json()).toMatchObject({
      revision: revision + 1,
      profileIds: ['profile-c', 'profile-a', 'profile-b'],
      order: [
        { kind: 'profile', profileId: 'profile-c' },
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-a' },
        { kind: 'profile', profileId: 'profile-b' },
      ],
      event: { type: 'modelProfile.reordered', resource: 'modelProfile' },
    })
    const database = loadPersistedFromDir(harness.dataDir).database as {
      modelProfiles: Array<Record<string, unknown>>
      modelProfileOrder: Array<Record<string, unknown>>
    }
    expect(database.modelProfiles).toMatchObject([{ id: 'profile-c' }, { id: 'profile-a' }, { id: 'profile-b' }])
    expect(database.modelProfileOrder).toEqual([
      { kind: 'profile', profileId: 'profile-c' },
      { kind: 'divider', id: 'divider-a' },
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'profile', profileId: 'profile-b' },
    ])
  })

  it('blocks model profile deletion when any Model Preset role binding uses it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelProfiles: [
        { id: 'profile-main', name: 'Main', modelId: 'gpt-5' },
        { id: 'profile-alt', name: 'Alt', modelId: 'gpt-4o' },
      ],
      modelProfileOrder: [
        { kind: 'profile', profileId: 'profile-main' },
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-alt' },
      ],
      modelRoleProfiles: {},
      modelPresets: [
        { id: 'model-a', name: 'Unrelated', modelRoleProfiles: {} },
        {
          id: 'model-b',
          name: 'Uses Main',
          modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-main' } },
        },
      ],
      modelPresetsId: 0,
    })

    const blocked = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, reassignments: {} },
    })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().error).toBe('Model profile profile-main is used by Model Presets: Uses Main')
    expect(
      (loadPersistedFromDir(harness.dataDir).database as { modelProfiles: Array<Record<string, unknown>> })
        .modelProfiles,
    ).toMatchObject([{ id: 'profile-main' }, { id: 'profile-alt' }])
  })

  it('validates model profile delete reassignments and applies direct role updates atomically', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelProfiles: [
        { id: 'profile-main', name: 'Main', modelId: 'gpt-5' },
        { id: 'profile-alt', name: 'Alt', modelId: 'gpt-4o' },
      ],
      modelProfileOrder: [
        { kind: 'profile', profileId: 'profile-main' },
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-alt' },
      ],
      modelRoleProfiles: {
        chatMain: { mode: 'profile', profileId: 'profile-main' },
        memory: { mode: 'profile', profileId: 'profile-main' },
      },
    })

    const missingMain = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, reassignments: { memory: { mode: 'inherit' } } },
    })
    expect(missingMain.statusCode).toBe(400)
    expect(missingMain.json().error).toBe('reassignments.chatMain is required')

    const badInherit = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        reassignments: {
          chatMain: { mode: 'inherit' },
          memory: { mode: 'inherit' },
        },
      },
    })
    expect(badInherit.statusCode).toBe(400)
    expect(badInherit.json().error).toBe('modelRoleProfiles.chatMain.mode does not support inherit')

    const badTarget = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        reassignments: {
          chatMain: { mode: 'profile', profileId: 'missing-profile' },
          memory: { mode: 'inherit' },
        },
      },
    })
    expect(badTarget.statusCode).toBe(400)
    expect(badTarget.json().error).toBe('reassignments.chatMain.profileId must reference an existing profile')

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-profiles/profile-main',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        reassignments: {
          chatMain: { mode: 'legacy' },
          memory: { mode: 'inherit' },
        },
      },
    })
    expect(deleted.statusCode, deleted.body).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: revision + 1,
      profileId: 'profile-main',
      reassignedRoles: ['chatMain', 'memory'],
    })
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      modelProfiles: [{ id: 'profile-alt' }],
      modelProfileOrder: [
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-alt' },
      ],
      modelRoleProfiles: {
        chatMain: { mode: 'legacy' },
        memory: { mode: 'inherit' },
      },
    })
  })

  it('rolls back stale legacy conversion without bumping the revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, {
      aiModel: 'gpt-5',
      subModel: 'claude-sonnet-4-5',
      modelProfiles: [],
    })

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/convert-legacy',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0 },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json()).toMatchObject({ revision: 1 })
    expect(bootstrap.resourceDatabase).toMatchObject({
      modelProfiles: [
        expect.objectContaining({ id: 'mp_legacy_chatMain', modelId: 'gpt-5' }),
        expect.objectContaining({ id: 'mp_legacy_chatAux', modelId: 'claude-sonnet-4-5' }),
      ],
    })
  })

  it('converts legacy model settings into profiles, role bindings, and runtime defaults', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      aiModel: 'gpt-5',
      subModel: 'claude-sonnet-4-5',
      openAIKey: 'openai-key',
      claudeAPIKey: 'claude-key',
      google: { accessToken: 'google-key', projectId: 'vertex-project' },
      vertexClientEmail: 'vertex@example.com',
      vertexPrivateKey: 'vertex-private-key',
      vertexRegion: 'us-central1',
      forceReplaceUrl: 'https://proxy.example.com/chat/risu',
      proxyKey: 'proxy-key',
      customProxyRequestModel: 'local-model',
      customAPIFormat: LLMFormat.OpenAICompatible,
      maxContext: 12345,
      maxResponse: 777,
      temperature: 66,
      top_p: 0.82,
      frequencyPenalty: 51,
      PresensePenalty: 61,
      modelRoles: {
        memory: 'gpt-5',
      },
      seperateModelsForAxModels: true,
      seperateModels: {
        emotion: 'gemini-2.5-flash',
        translate: 'gemini-2.5-pro-vertex',
        scriptAux: 'reverse_proxy',
      },
      seperateParametersEnabled: true,
      seperateParameters: {
        memory: { temperature: 22, top_p: 0.5 },
        otherAx: { temperature: 44 },
        scriptAux: { top_k: 5 },
      },
      fallbackModels: {
        model: ['fallback-main'],
        memory: ['fallback-memory'],
      },
      modelProfiles: [],
    })

    const converted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/convert-legacy',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })

    expect(converted.statusCode, converted.body).toBe(200)
    const body = converted.json() as {
      profileIdsByRole: Record<string, string>
      convertedRoles: string[]
    }
    expect(body.convertedRoles).toEqual(MODEL_ROLES)
    for (const role of MODEL_ROLES) {
      expect(body.profileIdsByRole[role]).toMatch(/^mp_/)
    }

    const database = loadPersistedFromDir(harness.dataDir).database as {
      modelProfiles: Array<Record<string, any>>
      providerCredentials: Array<Record<string, any>>
      modelRoleProfiles: Record<string, any>
      modelRuntimeDefaults: Record<string, unknown>
    }
    const profileById = new Map(database.modelProfiles.map((profile) => [profile.id, profile]))
    const main = profileById.get(body.profileIdsByRole.chatMain)
    const aux = profileById.get(body.profileIdsByRole.chatAux)
    const memory = profileById.get(body.profileIdsByRole.memory)
    const emotion = profileById.get(body.profileIdsByRole.emotion)
    const translate = profileById.get(body.profileIdsByRole.translate)
    const scriptAux = profileById.get(body.profileIdsByRole.scriptAux)
    const credentialById = new Map(database.providerCredentials.map((credential) => [credential.id, credential]))

    expect(database.modelRuntimeDefaults).toMatchObject({
      maxContext: 12345,
      maxResponse: 777,
      temperature: 66,
      topP: 0.82,
      frequencyPenalty: 51,
      presencePenalty: 61,
    })
    expect(main).toMatchObject({
      name: 'Main Chat',
      providerId: 'openai',
      modelId: 'gpt-5',
      providerOptions: { credentialId: expect.stringMatching(/^cred_/) },
      fallbacks: [{ mode: 'model', modelId: 'fallback-main' }],
    })
    expect(aux).toMatchObject({
      name: 'Auxiliary',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      providerOptions: { credentialId: expect.stringMatching(/^cred_/) },
      runtimeOptions: { temperature: 44 },
    })
    expect(memory).toMatchObject({
      name: 'Memory',
      providerId: 'openai',
      modelId: 'gpt-5',
      runtimeOptions: { temperature: 22, topP: 0.5 },
      fallbacks: [{ mode: 'model', modelId: 'fallback-memory' }],
    })
    expect(memory?.providerOptions.credentialId).toBe(main?.providerOptions.credentialId)
    expect(emotion).toMatchObject({
      name: 'Emotion',
      providerId: 'vertex',
      modelId: 'gemini-2.5-flash',
      providerOptions: {
        credentialId: expect.stringMatching(/^cred_/),
        vertex: { projectId: 'vertex-project', region: 'us-central1' },
      },
    })
    expect(translate).toMatchObject({
      name: 'Translate',
      providerId: 'vertex',
      modelId: 'gemini-2.5-pro-vertex',
      providerOptions: {
        credentialId: expect.stringMatching(/^cred_/),
        vertex: { projectId: 'vertex-project', region: 'us-central1' },
      },
    })
    expect(emotion?.providerOptions.credentialId).toBe(translate?.providerOptions.credentialId)
    expect(scriptAux).toMatchObject({
      name: 'Script Auxiliary',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: expect.stringMatching(/^cred_/),
        baseUrl: 'https://proxy.example.com/chat/risu/v1',
        requestModel: 'local-model',
      },
      runtimeOptions: { topK: 5 },
    })
    expect(credentialById.get(main?.providerOptions.credentialId)).toMatchObject({
      name: 'OpenAI (imported)',
      type: 'apiKey',
      apiKey: 'openai-key',
    })
    expect(credentialById.get(aux?.providerOptions.credentialId)).toMatchObject({
      name: 'Anthropic (imported)',
      type: 'apiKey',
      apiKey: 'claude-key',
    })
    expect(credentialById.get(emotion?.providerOptions.credentialId)).toMatchObject({
      name: 'Vertex AI (imported)',
      type: 'vertexServiceAccount',
      vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-private-key' },
    })
    expect(credentialById.get(translate?.providerOptions.credentialId)).toMatchObject({
      name: 'Vertex AI (imported)',
      type: 'vertexServiceAccount',
      vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-private-key' },
    })
    expect(credentialById.get(scriptAux?.providerOptions.credentialId)).toMatchObject({
      name: 'Proxy (imported)',
      type: 'apiKey',
      apiKey: 'proxy-key',
    })
    expect(database.providerCredentials).toContainEqual(
      expect.objectContaining({
        name: 'Google (imported)',
        type: 'apiKey',
        apiKey: 'google-key',
      }),
    )
    expect(database.modelRoleProfiles).toMatchObject({
      chatMain: { mode: 'profile', profileId: body.profileIdsByRole.chatMain },
      chatAux: { mode: 'profile', profileId: body.profileIdsByRole.chatAux },
      memory: { mode: 'profile', profileId: body.profileIdsByRole.memory },
      emotion: { mode: 'profile', profileId: body.profileIdsByRole.emotion },
      otherAx: { mode: 'inherit' },
      translate: { mode: 'profile', profileId: body.profileIdsByRole.translate },
      scriptAux: { mode: 'profile', profileId: body.profileIdsByRole.scriptAux },
    })
  })

  it('applies chat format settings through the provider settings command', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      instructChatTemplate: 'chatml',
      JinjaTemplate: '',
    })
    const jinjaTemplate = '{% for message in messages %}{{ message.content }}{% endfor %}'

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          instructChatTemplate: 'jinja',
          JinjaTemplate: jinjaTemplate,
        },
      },
    })

    expect(res.statusCode, res.body).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      instructChatTemplate: 'jinja',
      JinjaTemplate: jinjaTemplate,
    })
  })

  it('preserves masked provider placeholders while replacing explicit new secrets', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      openAIKey: 'old-openai',
      claudeAPIKey: 'old-claude',
      OaiCompAPIKeys: { deepseek: 'old-deepseek', deepinfra: 'old-deepinfra' },
      customModels: [{ id: 'xcustom:::a', name: 'Custom A', key: 'old-custom', url: 'https://old.example.com' }],
      authRefreshes: [
        {
          url: 'https://mcp.example.com',
          tokenUrl: 'https://mcp.example.com/token',
          refreshToken: 'old-refresh',
          clientId: 'client-id',
          clientSecret: 'old-client-secret',
        },
      ],
      aiModel: 'gpt4o-chatgpt',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          openAIKey: MASKED_PROVIDER_SECRET,
          claudeAPIKey: 'new-claude',
          OaiCompAPIKeys: {
            deepseek: MASKED_PROVIDER_SECRET,
            deepinfra: 'new-deepinfra',
          },
          customModels: [
            {
              id: 'xcustom:::a',
              name: 'Custom A renamed',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://new.example.com',
            },
          ],
          authRefreshes: [
            {
              url: 'https://mcp.example.com',
              tokenUrl: 'https://mcp.example.com/token',
              refreshToken: MASKED_PROVIDER_SECRET,
              clientId: 'client-id-new',
              clientSecret: 'new-client-secret',
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      openAIKey: 'old-openai',
      claudeAPIKey: 'new-claude',
      OaiCompAPIKeys: { deepseek: 'old-deepseek', deepinfra: 'new-deepinfra' },
      customModels: [
        {
          id: 'xcustom:::a',
          name: 'Custom A renamed',
          key: 'old-custom',
          url: 'https://new.example.com',
        },
      ],
      authRefreshes: [
        {
          url: 'https://mcp.example.com',
          tokenUrl: 'https://mcp.example.com/token',
          refreshToken: 'old-refresh',
          clientId: 'client-id-new',
          clientSecret: 'new-client-secret',
        },
      ],
      aiModel: 'gpt4o-chatgpt',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      openAIKey: MASKED_PROVIDER_SECRET,
      claudeAPIKey: MASKED_PROVIDER_SECRET,
      OaiCompAPIKeys: { deepseek: MASKED_PROVIDER_SECRET, deepinfra: MASKED_PROVIDER_SECRET },
      customModels: [{ key: MASKED_PROVIDER_SECRET }],
      authRefreshes: [
        {
          refreshToken: MASKED_PROVIDER_SECRET,
          clientSecret: MASKED_PROVIDER_SECRET,
        },
      ],
    })
  })

  it('restores masked provider array secrets by stable row identity after reorder', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      customModels: [
        { id: 'xcustom:::a', name: 'Custom A', key: 'custom-a', url: 'https://a.example.com' },
        { id: 'xcustom:::b', name: 'Custom B', key: 'custom-b', url: 'https://b.example.com' },
      ],
      providerCredentials: [
        { id: 'credential-a', name: 'Credential A', type: 'apiKey', apiKey: 'credential-a-key' },
        {
          id: 'credential-b',
          name: 'Credential B',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'b@example.com', privateKey: 'credential-b-private-key' },
        },
      ],
      authRefreshes: [
        {
          url: 'https://mcp-a.example.com',
          tokenUrl: 'https://mcp-a.example.com/token',
          refreshToken: 'refresh-a',
          clientId: 'client-a',
          clientSecret: 'secret-a',
        },
        {
          url: 'https://mcp-b.example.com',
          tokenUrl: 'https://mcp-b.example.com/token',
          refreshToken: 'refresh-b',
          clientId: 'client-b',
          clientSecret: 'secret-b',
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customModels: [
            {
              id: 'xcustom:::b',
              name: 'Custom B renamed',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://b2.example.com',
            },
            {
              id: 'xcustom:::a',
              name: 'Custom A renamed',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://a2.example.com',
            },
          ],
          providerCredentials: [
            {
              id: 'credential-b',
              name: 'Credential B renamed',
              type: 'vertexServiceAccount',
              vertex: { clientEmail: 'b-renamed@example.com', privateKey: MASKED_PROVIDER_SECRET },
            },
            {
              id: 'credential-a',
              name: 'Credential A renamed',
              type: 'apiKey',
              apiKey: MASKED_PROVIDER_SECRET,
            },
          ],
          authRefreshes: [
            {
              url: 'https://mcp-b.example.com',
              tokenUrl: 'https://mcp-b.example.com/token',
              refreshToken: MASKED_PROVIDER_SECRET,
              clientId: 'client-b-new',
              clientSecret: MASKED_PROVIDER_SECRET,
            },
            {
              url: 'https://mcp-a.example.com',
              tokenUrl: 'https://mcp-a.example.com/token',
              refreshToken: MASKED_PROVIDER_SECRET,
              clientId: 'client-a-new',
              clientSecret: MASKED_PROVIDER_SECRET,
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      customModels: [
        {
          id: 'xcustom:::b',
          name: 'Custom B renamed',
          key: 'custom-b',
          url: 'https://b2.example.com',
        },
        {
          id: 'xcustom:::a',
          name: 'Custom A renamed',
          key: 'custom-a',
          url: 'https://a2.example.com',
        },
      ],
      providerCredentials: [
        {
          id: 'credential-b',
          name: 'Credential B renamed',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'b-renamed@example.com', privateKey: 'credential-b-private-key' },
        },
        {
          id: 'credential-a',
          name: 'Credential A renamed',
          type: 'apiKey',
          apiKey: 'credential-a-key',
        },
      ],
      authRefreshes: [
        {
          url: 'https://mcp-b.example.com',
          tokenUrl: 'https://mcp-b.example.com/token',
          refreshToken: 'refresh-b',
          clientId: 'client-b-new',
          clientSecret: 'secret-b',
        },
        {
          url: 'https://mcp-a.example.com',
          tokenUrl: 'https://mcp-a.example.com/token',
          refreshToken: 'refresh-a',
          clientId: 'client-a-new',
          clientSecret: 'secret-a',
        },
      ],
    })
  })

  it('does not transplant masked provider array secrets after deleting earlier rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      customModels: [
        { id: 'xcustom:::a', name: 'Custom A', key: 'custom-a', url: 'https://a.example.com' },
        { id: 'xcustom:::b', name: 'Custom B', key: 'custom-b', url: 'https://b.example.com' },
      ],
      authRefreshes: [
        {
          url: 'https://mcp-a.example.com',
          tokenUrl: 'https://mcp-a.example.com/token',
          refreshToken: 'refresh-a',
          clientId: 'client-a',
          clientSecret: 'secret-a',
        },
        {
          url: 'https://mcp-b.example.com',
          tokenUrl: 'https://mcp-b.example.com/token',
          refreshToken: 'refresh-b',
          clientId: 'client-b',
          clientSecret: 'secret-b',
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customModels: [
            {
              id: 'xcustom:::b',
              name: 'Custom B kept',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://b.example.com',
            },
          ],
          authRefreshes: [
            {
              url: 'https://mcp-b.example.com',
              tokenUrl: 'https://mcp-b.example.com/token',
              refreshToken: MASKED_PROVIDER_SECRET,
              clientId: 'client-b',
              clientSecret: MASKED_PROVIDER_SECRET,
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      customModels: [{ id: 'xcustom:::b', name: 'Custom B kept', key: 'custom-b', url: 'https://b.example.com' }],
      authRefreshes: [
        {
          url: 'https://mcp-b.example.com',
          tokenUrl: 'https://mcp-b.example.com/token',
          refreshToken: 'refresh-b',
          clientId: 'client-b',
          clientSecret: 'secret-b',
        },
      ],
    })
  })

  it('rejects masked provider array placeholders without matching row identity', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      customModels: [{ id: 'xcustom:::a', name: 'Custom A', key: 'custom-a', url: 'https://a.example.com' }],
    })

    const missingIdentity = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customModels: [{ name: 'Missing Id', key: MASKED_PROVIDER_SECRET, url: 'https://missing.example.com' }],
        },
      },
    })
    expect(missingIdentity.statusCode).toBe(400)
    expect(missingIdentity.json().error).toContain('without id')

    const unknownRow = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customModels: [
            {
              id: 'xcustom:::missing',
              name: 'Missing',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://missing.example.com',
            },
          ],
        },
      },
    })
    expect(unknownRow.statusCode).toBe(400)
    expect(unknownRow.json().error).toContain('unknown customModels row')
  })

  it('applies manual settings page scalar roots through grouped commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      aiModel: 'gpt4o-chatgpt',
      maxContext: 8000,
      sdProvider: 'webui',
      username: 'User',
    })

    const provider = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          aiModel: 'openrouter',
          subModel: 'claude',
          forceReplaceUrl: 'https://proxy.example.test',
          proxyKey: 'proxy-secret',
          customProxyRequestModel: 'proxy-model',
          customAPIFormat: 1,
          customTokenizer: 'tik',
          google: { accessToken: 'google-secret', projectId: 'project-a' },
          vertexClientEmail: 'vertex@example.test',
          vertexPrivateKey: 'vertex-private',
          vertexAccessToken: '',
          vertexAccessTokenExpires: 0,
          vertexRegion: 'us-central1',
          novellistAPI: 'novellist-secret',
          mancerHeader: 'mancer-secret',
          claudeAPIKey: 'claude-secret',
          mistralKey: 'mistral-secret',
          novelai: { token: 'nai-secret', model: 'nai-model' },
          cohereAPIKey: 'cohere-secret',
          ollamaURL: 'https://ollama.example.test',
          ollamaInputMode: 'manual',
          ollamaCloudModel: 'cloud-model',
          ollamaModelSource: 'cloud',
          ollamaCloudModelName: 'Cloud Model',
          ollamaApiKey: 'ollama-secret',
          ollamaRequestFormat: 1,
          ollamaModel: 'local-model',
          ollamaModelName: '',
          ollamaThinkingMode: 'medium',
          nanogptKey: 'nanogpt-secret',
          nanogptUseSubscriptionEndpoint: true,
          nanogptSubscriptionState: 'active',
          nanogptRequestModel: 'nano-model',
          nanogptRequestModelName: 'Nano Model',
          nanogptProvider: '',
          openrouterKey: 'openrouter-secret',
          openrouterRequestModel: 'openrouter/model',
          openrouterFallback: true,
          openrouterMiddleOut: true,
          openrouterProvider: {
            order: ['OpenAI'],
            only: ['Anthropic'],
            ignore: ['Google'],
          },
          useInstructPrompt: true,
          openAIKey: 'openai-secret',
          OaiCompAPIKeys: { deepseek: 'deepseek-secret' },
          reverseProxyOobaMode: true,
          NAIadventure: true,
          NAIappendName: true,
          koboldURL: 'https://kobold.example.test',
          echoMessage: 'pong',
          echoDelay: 2,
          hordeConfig: { apiKey: 'horde-secret', model: '', softPrompt: '' },
          textgenWebUIStreamURL: 'wss://stream.example.test',
          textgenWebUIBlockingURL: 'https://blocking.example.test',
          ooba: { top_k: 50, top_p: 0.8, formating: { useName: true } },
          reverseProxyOobaArgs: { mode: 'chat', tokenizer: 'llama', top_k: 40 },
          NAIsettings: { topP: 0.75, topK: 80 },
          ainconfig: { top_p: 0.7, top_k: 90 },
          bias: [['token', -10]],
          additionalParams: [['stop', 'value']],
          applyAdditionalParamsToAll: true,
          huggingfaceKey: 'huggingface-secret',
        },
      },
    })
    expect(provider.statusCode, provider.body).toBe(200)

    const runtime = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: provider.json().revision,
        patch: {
          maxContext: 12000,
          epEnabled: true,
          doNotChangeSeperateModels: true,
          seperateParametersEnabled: true,
          seperateParametersByModel: true,
          disableSeperateParameterChangeOnPresetChange: true,
          seperateModels: { memory: 'mem', translate: '', emotion: '', otherAx: '' },
          seperateParameters: {
            memory: { temperature: 0.6 },
            translate: { top_p: 0.7 },
            emotion: {},
            otherAx: {},
            overrides: { 'openrouter/model': { top_k: 42 } },
          },
          localStopStrings: ['stop'],
          useStreaming: true,
          streamGeminiThoughts: true,
        },
      },
    })
    expect(runtime.statusCode).toBe(200)

    const media = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: runtime.json().revision,
        patch: {
          sdProvider: 'wavespeed',
          webUiUrl: 'https://webui.example.test',
          sdSteps: 24,
          sdCFG: 8,
          sdConfig: { width: 1024, height: 768, enable_hr: true },
          NAIImgUrl: 'https://image.novelai.net',
          NAIApiKey: 'nai-image-secret',
          NAIImgModel: 'nai-diffusion-4-5-full',
          NAII2I: true,
          NAIImgConfig: { width: 832, height: 1216, sampler: 'k_euler' },
          dallEQuality: 'hd',
          stabilityKey: 'stability-secret',
          stabilityModel: 'core',
          stabllityStyle: 'anime',
          comfyUiUrl: 'https://comfy.example.test',
          comfyConfig: { workflow: '{}', timeout: 60 },
          falToken: 'fal-secret',
          falModel: 'fal-ai/flux-lora',
          falLora: 'https://lora.example.test/model.safetensors',
          falLoraScale: 0.75,
          ImagenModel: 'imagen-4.0-generate-001',
          ImagenImageSize: '2K',
          ImagenAspectRatio: '16:9',
          ImagenPersonGeneration: 'allow_adult',
          openaiCompatImage: {
            url: 'https://images.example.test/v1/images/generations',
            key: 'compat-image-secret',
            model: 'image-model',
            size: '1024x1024',
            quality: 'high',
          },
          wavespeedImage: {
            key: 'wave-key',
            model: 'flux',
            loras: [{ path: 'owner/model', scale: 1.2 }],
          },
          ttsAutoSpeech: true,
          elevenLabKey: 'eleven-secret',
          voicevoxUrl: 'https://voicevox.example.test',
          fishSpeechKey: 'fish-secret',
          emotionProcesser: 'embedding',
        },
      },
    })
    expect(media.statusCode).toBe(200)

    const memory = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: media.json().revision,
        patch: {
          hypaV3: true,
          hypaV3PresetId: 0,
          selectedHypaV3PresetId: 'fastify-memory',
          hypaV3Presets: [
            {
              id: 'fastify-memory',
              name: 'Fastify memory',
              settings: {
                summarizationModel: 'subModel',
                summarizationPrompt: 'Summarize',
                recentMemoryRatio: 0.4,
                similarMemoryRatio: 0.5,
              },
            },
          ],
          hypaModel: 'custom',
          hypaV3Key: 'hypa-openai-secret',
          hypaCustomSettings: {
            url: 'https://embedding.example.test/v1/embeddings',
            key: 'custom-embedding-secret',
            model: 'embedding-model',
          },
          voyageApiKey: 'voyage-secret',
        },
      },
    })
    expect(memory.statusCode).toBe(200)
    expect(memory.json().settings).toMatchObject({
      hypaV3Key: MASKED_PROVIDER_SECRET,
      hypaCustomSettings: {
        url: 'https://embedding.example.test/v1/embeddings',
        key: MASKED_PROVIDER_SECRET,
        model: 'embedding-model',
      },
      voyageApiKey: MASKED_PROVIDER_SECRET,
    })

    const account = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/account',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: memory.json().revision,
        patch: {
          username: 'Fastify User',
          didFirstSetup: true,
        },
      },
    })
    expect(account.statusCode).toBe(200)

    const advanced = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: account.json().revision,
        patch: {
          moduleIntergration: 'module-ns',
          enableCustomFlags: true,
          customFlags: [8, 21],
          pluginCompatibilityMode: true,
          strictScriptCheck: true,
        },
      },
    })
    expect(advanced.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      aiModel: 'openrouter',
      subModel: 'claude',
      forceReplaceUrl: 'https://proxy.example.test',
      proxyKey: MASKED_PROVIDER_SECRET,
      customProxyRequestModel: 'proxy-model',
      customAPIFormat: 1,
      customTokenizer: 'tik',
      google: { accessToken: MASKED_PROVIDER_SECRET, projectId: 'project-a' },
      vertexClientEmail: 'vertex@example.test',
      vertexPrivateKey: MASKED_PROVIDER_SECRET,
      vertexAccessToken: '',
      vertexAccessTokenExpires: 0,
      vertexRegion: 'us-central1',
      novellistAPI: MASKED_PROVIDER_SECRET,
      mancerHeader: MASKED_PROVIDER_SECRET,
      claudeAPIKey: MASKED_PROVIDER_SECRET,
      mistralKey: MASKED_PROVIDER_SECRET,
      novelai: { token: MASKED_PROVIDER_SECRET, model: 'nai-model' },
      cohereAPIKey: MASKED_PROVIDER_SECRET,
      ollamaURL: 'https://ollama.example.test',
      ollamaInputMode: 'manual',
      ollamaCloudModel: 'cloud-model',
      ollamaModelSource: 'cloud',
      ollamaCloudModelName: 'Cloud Model',
      ollamaApiKey: MASKED_PROVIDER_SECRET,
      ollamaRequestFormat: 1,
      ollamaModel: 'local-model',
      ollamaModelName: '',
      ollamaThinkingMode: 'medium',
      nanogptKey: MASKED_PROVIDER_SECRET,
      nanogptUseSubscriptionEndpoint: true,
      nanogptSubscriptionState: 'active',
      nanogptRequestModel: 'nano-model',
      nanogptRequestModelName: 'Nano Model',
      nanogptProvider: '',
      openrouterKey: MASKED_PROVIDER_SECRET,
      openrouterRequestModel: 'openrouter/model',
      openrouterFallback: true,
      openrouterMiddleOut: true,
      openrouterProvider: {
        order: ['OpenAI'],
        only: ['Anthropic'],
        ignore: ['Google'],
      },
      useInstructPrompt: true,
      openAIKey: MASKED_PROVIDER_SECRET,
      OaiCompAPIKeys: { deepseek: MASKED_PROVIDER_SECRET },
      reverseProxyOobaMode: true,
      NAIadventure: true,
      NAIappendName: true,
      koboldURL: 'https://kobold.example.test',
      echoMessage: 'pong',
      echoDelay: 2,
      hordeConfig: { apiKey: MASKED_PROVIDER_SECRET, model: '', softPrompt: '' },
      textgenWebUIStreamURL: 'wss://stream.example.test',
      textgenWebUIBlockingURL: 'https://blocking.example.test',
      ooba: { top_k: 50, top_p: 0.8, formating: { useName: true } },
      reverseProxyOobaArgs: { mode: 'chat', tokenizer: 'llama', top_k: 40 },
      NAIsettings: { topP: 0.75, topK: 80 },
      ainconfig: { top_p: 0.7, top_k: 90 },
      bias: [['token', -10]],
      additionalParams: [['stop', 'value']],
      applyAdditionalParamsToAll: true,
      huggingfaceKey: MASKED_PROVIDER_SECRET,
      maxContext: 12000,
      useStreaming: true,
      streamGeminiThoughts: true,
      epEnabled: true,
      doNotChangeSeperateModels: true,
      seperateParametersEnabled: true,
      seperateParametersByModel: true,
      disableSeperateParameterChangeOnPresetChange: true,
      seperateModels: { memory: 'mem', translate: '', emotion: '', otherAx: '' },
      seperateParameters: {
        memory: { temperature: 0.6 },
        translate: { top_p: 0.7 },
        emotion: {},
        otherAx: {},
        overrides: { 'openrouter/model': { top_k: 42 } },
      },
      localStopStrings: ['stop'],
      sdProvider: 'wavespeed',
      webUiUrl: 'https://webui.example.test',
      sdSteps: 24,
      sdCFG: 8,
      sdConfig: { width: 1024, height: 768, enable_hr: true },
      NAIImgUrl: 'https://image.novelai.net',
      NAIApiKey: MASKED_PROVIDER_SECRET,
      NAIImgModel: 'nai-diffusion-4-5-full',
      NAII2I: true,
      NAIImgConfig: { width: 832, height: 1216, sampler: 'k_euler' },
      dallEQuality: 'hd',
      stabilityKey: MASKED_PROVIDER_SECRET,
      stabilityModel: 'core',
      stabllityStyle: 'anime',
      comfyUiUrl: 'https://comfy.example.test',
      comfyConfig: { workflow: '{}', timeout: 60 },
      falToken: MASKED_PROVIDER_SECRET,
      falModel: 'fal-ai/flux-lora',
      falLora: 'https://lora.example.test/model.safetensors',
      falLoraScale: 0.75,
      ImagenModel: 'imagen-4.0-generate-001',
      ImagenImageSize: '2K',
      ImagenAspectRatio: '16:9',
      ImagenPersonGeneration: 'allow_adult',
      openaiCompatImage: {
        url: 'https://images.example.test/v1/images/generations',
        key: MASKED_PROVIDER_SECRET,
        model: 'image-model',
        size: '1024x1024',
        quality: 'high',
      },
      wavespeedImage: {
        key: MASKED_PROVIDER_SECRET,
        model: 'flux',
        loras: [{ path: 'owner/model', scale: 1.2 }],
      },
      ttsAutoSpeech: true,
      elevenLabKey: MASKED_PROVIDER_SECRET,
      voicevoxUrl: 'https://voicevox.example.test',
      fishSpeechKey: MASKED_PROVIDER_SECRET,
      emotionProcesser: 'embedding',
      hypaV3: true,
      hypaV3PresetId: 0,
      selectedHypaV3PresetId: 'fastify-memory',
      hypaV3Presets: [
        {
          id: 'fastify-memory',
          name: 'Fastify memory',
          settings: {
            summarizationModel: 'subModel',
            summarizationPrompt: 'Summarize',
            recentMemoryRatio: 0.4,
            similarMemoryRatio: 0.5,
          },
        },
      ],
      hypaModel: 'custom',
      hypaV3Key: MASKED_PROVIDER_SECRET,
      hypaCustomSettings: {
        url: 'https://embedding.example.test/v1/embeddings',
        key: MASKED_PROVIDER_SECRET,
        model: 'embedding-model',
      },
      voyageApiKey: MASKED_PROVIDER_SECRET,
      username: 'Fastify User',
      didFirstSetup: true,
      moduleIntergration: 'module-ns',
      enableCustomFlags: true,
      customFlags: [8, 21],
      pluginCompatibilityMode: true,
      strictScriptCheck: true,
    })
  })

  it('distinguishes settings-only memory patches from Hypa preset collection writes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      hypaV3: false,
      hypaV3Presets: [],
    })

    const settingsOnly = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { hypaV3: true },
      },
    })
    expect(settingsOnly.statusCode).toBe(200)
    expect(settingsOnly.json()).toMatchObject({
      acknowledgedKeys: ['hypaV3'],
      settings: {},
    })
    expect(settingsOnly.json().event).toMatchObject({
      type: 'settings.updated',
      resource: 'settings',
      id: 'memory',
    })

    const withPresets = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: settingsOnly.json().revision,
        patch: {
          selectedHypaV3PresetId: 'cross-resource-memory',
          hypaV3Presets: [
            {
              id: 'cross-resource-memory',
              name: 'Cross-resource memory',
              settings: {
                summarizationModel: 'subModel',
                summarizationPrompt: 'Summarize',
                recentMemoryRatio: 0.4,
                similarMemoryRatio: 0.5,
              },
            },
          ],
        },
      },
    })
    expect(withPresets.statusCode).toBe(200)
    expect(withPresets.json()).toMatchObject({
      acknowledgedKeys: ['selectedHypaV3PresetId', 'hypaV3Presets'],
      settings: {},
    })
    expect(withPresets.json().event).toMatchObject({
      type: 'settings.updated',
      resource: 'settingsWithHypaV3Presets',
      id: 'memory',
    })
  })

  it('keeps stable Hypa selection authoritative and co-writes its numeric projection atomically', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      hypaV3Presets: [
        { id: 'memory-a', name: 'A', settings: {} },
        { id: 'memory-b', name: 'B', settings: {} },
      ],
      selectedHypaV3PresetId: 'memory-a',
      hypaV3PresetId: 0,
    })

    const selected = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { selectedHypaV3PresetId: 'memory-b' } },
    })
    expect(selected.statusCode, selected.body).toBe(200)
    revision = selected.json().revision

    const reordered = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          hypaV3Presets: [
            { id: 'memory-b', name: 'B', settings: {} },
            { id: 'memory-a', name: 'A', settings: {} },
          ],
        },
      },
    })
    expect(reordered.statusCode, reordered.body).toBe(200)

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const settings = JSON.parse(
        (db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }).data_json,
      ) as Record<string, unknown>
      expect(settings).toMatchObject({ selectedHypaV3PresetId: 'memory-b', hypaV3PresetId: 0 })
      const presets = db.prepare('SELECT data_json FROM hypa_v3_presets ORDER BY position').all() as Array<{
        data_json: string
      }>
      expect(presets.map(({ data_json }) => (JSON.parse(data_json) as { id: string }).id)).toEqual([
        'memory-b',
        'memory-a',
      ])
    } finally {
      db.close()
    }
  })

  it('rejects malformed Hypa identity patches and damaged stored rows without write or revision churn', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      hypaV3Presets: [
        { id: 'memory-a', name: 'A', settings: {} },
        { id: 'memory-b', name: 'B', settings: {} },
      ],
      selectedHypaV3PresetId: 'memory-a',
      hypaV3PresetId: 0,
    })

    for (const patch of [
      { hypaV3PresetId: 1 },
      { selectedHypaV3PresetId: 'memory-b', hypaV3PresetId: 0 },
      {
        selectedHypaV3PresetId: 'missing',
        hypaV3Presets: [{ id: 'memory-a', name: 'A', settings: {} }],
      },
      {
        selectedHypaV3PresetId: 'memory-a',
        hypaV3Presets: [{ name: 'Missing id', settings: {} }],
      },
      {
        selectedHypaV3PresetId: 'duplicate',
        hypaV3Presets: [
          { id: 'duplicate', name: 'A', settings: {} },
          { id: 'duplicate', name: 'B', settings: {} },
        ],
      },
    ]) {
      const before = readAllDatabaseRows(harness.dataDir)
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/memory',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch },
      })
      expect(response.statusCode, response.body).toBe(400)
      expect(readAllDatabaseRows(harness.dataDir)).toEqual(before)
    }

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare('UPDATE hypa_v3_presets SET data_json = ? WHERE position = 1').run(
        JSON.stringify({ id: 'memory-a', name: 'Damaged duplicate', settings: {} }),
      )
    } finally {
      db.close()
    }
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { selectedHypaV3PresetId: 'memory-b' } },
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().error).toBe('Duplicate hypaV3Presets id: memory-a')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('rejects legacy Hypa aliases while allowing canonical preset settings to remain authoritative', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      hypaV3Settings: { summarizationPrompt: 'stale flat prompt' },
      supaMemoryKey: 'stale-flat-key',
      hypaV3Presets: [
        {
          id: 'canonical-memory',
          name: 'Canonical memory',
          settings: { summarizationModel: 'subModel', summarizationPrompt: 'canonical prompt' },
        },
      ],
    })

    for (const [key, value] of [
      ['hypaV3Settings', { summarizationPrompt: 'attempted stale overwrite' }],
      ['supaMemoryKey', 'attempted stale key overwrite'],
    ] as const) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/memory',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch: { [key]: value } },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(`Unsupported memory setting: ${key}`)
    }

    const canonical = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          hypaV3Presets: [
            {
              id: 'canonical-memory',
              name: 'Canonical memory',
              settings: { summarizationModel: 'subModel', summarizationPrompt: 'updated canonical prompt' },
            },
          ],
        },
      },
    })
    expect(canonical.statusCode).toBe(200)
    expect(canonical.json().acknowledgedKeys).toEqual(['hypaV3Presets'])

    const memory = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/memory',
      headers: { 'risu-auth': assertion },
    })
    expect(memory.statusCode).toBe(200)
    expect(memory.json().settings).not.toHaveProperty('hypaV3Settings')
    expect(memory.json().settings).not.toHaveProperty('supaMemoryKey')
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      hypaV3Settings: { summarizationPrompt: 'stale flat prompt' },
      supaMemoryKey: 'stale-flat-key',
      hypaV3Presets: [{ settings: { summarizationPrompt: 'updated canonical prompt' } }],
    })
  })

  it('rejects Hypa presets with client-only summary models', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { hypaV3Presets: [] })

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          selectedHypaV3PresetId: 'unsupported-gpu',
          hypaV3Presets: [
            {
              id: 'unsupported-gpu',
              name: 'Unsupported GPU preset',
              settings: { summarizationModel: 'Qwen3-4B-q4f32_1-MLC' },
            },
          ],
        },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('hypaV3Presets[0].settings.summarizationModel must be subModel or memory')
    expect(JSON.stringify(loadPersistedFromDir(harness.dataDir).database)).not.toContain('Qwen3-4B-q4f32_1-MLC')
  })

  it('applies strict prompt settings with sparse normalized acknowledgements', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      outputImageModal: false,
      fallbackModels: {},
      fallbackWhenBlankResponse: false,
      doNotChangeFallbackModels: false,
    })
    const requestedFallbackModels = {
      model: ['fallback-main', '', 7],
      memory: ['fallback-memory'],
    }

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/prompt',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          outputImageModal: true,
          fallbackModels: requestedFallbackModels,
          fallbackWhenBlankResponse: true,
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'prompt',
      },
      acknowledgedKeys: ['outputImageModal', 'fallbackModels', 'fallbackWhenBlankResponse'],
      settings: {
        fallbackModels: {
          model: ['fallback-main'],
          memory: ['fallback-memory'],
          emotion: [],
          translate: [],
          otherAx: [],
          scriptMain: [],
          scriptAux: [],
        },
      },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      outputImageModal: true,
      fallbackModels: res.json().settings.fallbackModels,
      fallbackWhenBlankResponse: true,
      doNotChangeFallbackModels: false,
    })
  })

  it('rejects unknown setting keys without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      theme: 'dark',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { openAIKey: 'wrong-group' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Unsupported display setting: openAIKey')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase).toMatchObject({ theme: 'dark' })
  })

  it('rejects retired Context Agent setting keys while preserving imported old-save data', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentContextEnabled: true,
      agentContextPrompt: 'legacy context prompt',
      agentContextMaxOutput: 999,
      agentContextMaxToolRounds: 2,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { agentContextEnabled: false } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Unsupported advanced setting: agentContextEnabled')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase).toMatchObject({
      agentContextEnabled: true,
      agentContextPrompt: 'legacy context prompt',
      agentContextMaxOutput: 999,
      agentContextMaxToolRounds: 2,
    })
  })

  it('rejects collection fields through the strict prompt settings group', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/prompt',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { promptTemplate: [] } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Unsupported prompt setting: promptTemplate')
  })

  it('rejects unsupported settings groups', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/prompt-template',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { mainPrompt: 'MAIN' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Unsupported settings group: prompt-template')
  })

  it('keeps dedicated read-only settings groups command-owned', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const agents = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/agents',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { agentPresets: [] } },
    })

    expect(agents.statusCode).toBe(400)
    expect(agents.json().error).toBe('Unsupported settings group: agents')

    const models = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/models',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { modelProfiles: [] } },
    })

    expect(models.statusCode).toBe(400)
    expect(models.json().error).toBe('Unsupported settings group: models')
  })
})

describe('bot preset commands', () => {
  it('rejects missing durable ids on public root create commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A' }],
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
      translatorPresets: [{ id: 'translator-a', name: 'A', prompt: '', maxResponse: 100 }],
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [],
          chatFolders: [],
          chatPage: 0,
          viewScreen: 'none',
          bias: [],
          emotionImages: [],
          globalLore: [],
          sdData: [],
          customscript: [],
          triggerscript: [],
        },
      ],
      characterOrder: ['char-a'],
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      modules: [{ id: 'mod-a', name: 'A', description: '' }],
    })

    const cases = [
      {
        url: '/api/v1/commands/presets',
        payload: { baseRevision: revision, preset: { name: 'Missing id' } },
        error: 'preset.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/personas',
        payload: { baseRevision: revision, persona: { name: 'Missing id' } },
        error: 'persona.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/translator-presets',
        payload: { baseRevision: revision, preset: { name: 'Missing id' } },
        error: 'translatorPreset.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/loadouts',
        payload: { baseRevision: revision, loadout: { name: 'Missing id' } },
        error: 'loadout.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/characters',
        payload: { baseRevision: revision, character: { name: 'Missing id' } },
        error: 'character.chaId must be a non-empty string',
      },
      {
        url: '/api/v1/commands/characters/char-a/chats',
        payload: { baseRevision: revision, chat: { name: 'Missing id' } },
        error: 'chat.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/characters/char-a/chat-folders',
        payload: { baseRevision: revision, folder: { name: 'Missing id' } },
        error: 'folder.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/lorebooks',
        payload: { baseRevision: revision, lorebook: { name: 'Missing id', data: [] } },
        error: 'lorebook.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/modules',
        payload: { baseRevision: revision, module: { name: 'Missing id' } },
        error: 'module.id must be a non-empty string',
      },
    ]

    for (const testCase of cases) {
      const res = await harness.app.inject({
        method: 'POST',
        url: testCase.url,
        headers: { 'risu-auth': assertion },
        payload: testCase.payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(testCase.error)
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
  })

  it('creates and updates presets with command events', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A', mainPrompt: 'a prompt' }],
      botPresetsId: 0,
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', mainPrompt: 'b prompt' },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'preset.created',
        revision: 2,
        resource: 'presetCollection',
        id: 'preset-b',
      },
      presetId: 'preset-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'B renamed',
          agentPresets: [{ id: 'agent-preset-b', name: 'Agent B', enabled: true, version: 1, steps: [] }],
          agentPresetDefaultId: 'agent-preset-b',
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event).toMatchObject({
      type: 'preset.updated',
      resource: 'presetRow',
      id: 'preset-b',
    })
    expect(updated.json()).toMatchObject({
      presetId: 'preset-b',
      acknowledgedKeys: ['name', 'agentPresets', 'agentPresetDefaultId'],
      canonicalValues: {},
      canonicalDeletedKeys: [],
    })

    const updatedAgentList = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        patch: {
          agentPresets: [{ id: 'agent-preset-c', name: 'Agent C', enabled: true, version: 1, steps: [] }],
        },
      },
    })
    expect(updatedAgentList.statusCode).toBe(200)
    expect(updatedAgentList.json()).toMatchObject({
      presetId: 'preset-b',
      acknowledgedKeys: ['agentPresets'],
      canonicalValues: {},
      canonicalDeletedKeys: ['agentPresetDefaultId'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.botPresets).toMatchObject([
      { id: 'preset-a', name: 'A' },
      { id: 'preset-b', name: 'B renamed' },
    ])

    const storedPreset = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/legacy-presets/preset-b',
      headers: { 'risu-auth': assertion },
    })
    expect(storedPreset.statusCode).toBe(200)
    expect(storedPreset.json().preset).toMatchObject({
      id: 'preset-b',
      name: 'B renamed',
      agentPresets: [{ id: 'agent-preset-c', name: 'Agent C', enabled: true, version: 1, steps: [] }],
    })
    expect(storedPreset.json().preset).not.toHaveProperty('agentPresetDefaultId')
  })

  it('returns masked sparse canonical preset values after normalization', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A' }],
      botPresetsId: 0,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          modelProfiles: [
            {
              id: ' profile-a ',
              name: ' Profile A ',
              providerId: ' openai ',
              modelId: ' gpt-5 ',
              providerOptions: { apiKey: 'receipt-must-not-leak' },
            },
          ],
        },
      },
    })

    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json()).toMatchObject({
      presetId: 'preset-a',
      acknowledgedKeys: ['modelProfiles'],
      canonicalValues: {
        modelProfiles: [
          {
            id: 'profile-a',
            name: 'Profile A',
            providerId: 'openai',
            modelId: 'gpt-5',
          },
        ],
      },
      canonicalDeletedKeys: [],
    })
    expect(updated.body).not.toContain('receipt-must-not-leak')
  })

  it('resolves masked legacy scalar secrets in preset PATCHes before persisting them', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        {
          id: 'preset-a',
          name: 'A',
          openAIKey: 'stored-openai-secret',
          proxyKey: 'stored-proxy-secret',
        },
      ],
      botPresetsId: 0,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          openAIKey: MASKED_PROVIDER_SECRET,
          proxyKey: MASKED_PROVIDER_SECRET,
        },
      },
    })

    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.body).not.toContain('stored-openai-secret')
    expect(updated.body).not.toContain('stored-proxy-secret')
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      botPresets: Array<Record<string, any>>
    }
    expect(persisted.botPresets[0]).toMatchObject({
      id: 'preset-a',
      openAIKey: 'stored-openai-secret',
      proxyKey: 'stored-proxy-secret',
    })
  })

  it('validates preset image asset references on create and patch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const uploaded = await uploadAsset(harness.app, assertion, Buffer.from('preset-image'))
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A', image: '' }],
      botPresetsId: 0,
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: uploaded.assetId },
      },
    })
    expect(created.statusCode).toBe(200)

    const patchedValid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: { image: uploaded.assetId },
      },
    })
    expect(patchedValid.statusCode).toBe(200)

    const clearValues: unknown[] = [null, '', '-']
    let baseRevision = patchedValid.json().revision as number
    for (const image of clearValues) {
      const cleared = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/presets/preset-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision,
          patch: { image },
        },
      })
      expect(cleared.statusCode).toBe(200)
      baseRevision = cleared.json().revision as number
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.botPresets).toMatchObject([
      { id: 'preset-a', name: 'A', image: '-' },
      { id: 'preset-b', name: 'B', image: uploaded.assetId },
    ])
  })

  it('rejects malformed and missing preset image asset refs without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A', image: '' }],
      botPresetsId: 0,
    })
    const missingAssetId = '0'.repeat(64)

    const malformedCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: 'assets/not-server.png' },
      },
    })
    expect(malformedCreate.statusCode).toBe(400)
    expect(malformedCreate.json().error).toBe('preset.image must be a server asset id')

    const missingCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: missingAssetId },
      },
    })
    expect(missingCreate.statusCode).toBe(400)
    expect(missingCreate.json().error).toBe('preset.image references a missing server asset')

    const malformedImport = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/import',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: 'assets/not-server.png' },
      },
    })
    expect(malformedImport.statusCode).toBe(400)
    expect(malformedImport.json().error).toBe('preset.image must be a server asset id')

    const missingImport = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/import',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: missingAssetId },
      },
    })
    expect(missingImport.statusCode).toBe(400)
    expect(missingImport.json().error).toBe('preset.image references a missing server asset')

    const malformedPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { image: 'assets/not-server.png' },
      },
    })
    expect(malformedPatch.statusCode).toBe(400)
    expect(malformedPatch.json().error).toBe('patch.image must be a server asset id')

    const missingPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { image: missingAssetId },
      },
    })
    expect(missingPatch.statusCode).toBe(400)
    expect(missingPatch.json().error).toBe('patch.image references a missing server asset')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.botPresets).toMatchObject([{ id: 'preset-a', name: 'A', image: '' }])
  })

  it('selects and applies a preset while saving the previously selected snapshot', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', mainPrompt: 'old saved', temperature: 50 },
        {
          id: 'preset-b',
          name: 'B',
          mainPrompt: 'target prompt',
          temperature: 90,
          modelRuntimeDefaults: { maxContext: 9000, modelTools: ['target-tool'] },
          modelProfiles: [
            { id: ' target-profile ', name: ' Target Profile ', modelId: ' target-model ' },
            { id: 'target-profile', name: 'Duplicate' },
          ],
          modelRoleProfiles: {
            memory: { mode: 'profile', profileId: ' target-profile ' },
          },
          agentPresets: [
            { id: ' agent-target ', name: ' Target Agent ', enabled: true, version: 1, steps: [] },
            { id: 'agent-target', name: 'Duplicate', enabled: true, version: 1, steps: [] },
          ],
          agentPresetDefaultId: ' agent-target ',
        },
      ],
      botPresetsId: 0,
      mainPrompt: 'current prompt',
      temperature: 72,
      modelRuntimeDefaults: { maxContext: 7200, modelTools: ['current-tool'] },
      modelProfiles: [{ id: 'current-profile', name: 'Current Profile', modelId: 'current-model' }],
      modelRoleProfiles: {
        memory: { mode: 'profile', profileId: 'current-profile' },
      },
      agentPresets: [{ id: 'current-agent', name: 'Current Agent', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'current-agent',
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: true,
        apply: true,
      },
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 2,
      event: {
        type: 'preset.selected',
        revision: 2,
        resource: 'presetApplied',
        id: 'preset-b',
        parentId: 'preset-a',
      },
      presetId: 'preset-b',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      botPresetsId: 1,
      mainPrompt: 'target prompt',
      temperature: 90,
      modelRuntimeDefaults: { maxContext: 9000, modelTools: ['target-tool'] },
      modelProfiles: [{ id: 'target-profile', name: 'Target Profile', modelId: 'target-model' }],
      modelRoleProfiles: {
        ...Object.fromEntries(MODEL_ROLES.map((role) => [role, { mode: 'legacy' }])),
        memory: { mode: 'profile', profileId: 'target-profile' },
      },
      agentPresets: [{ id: 'agent-target', name: 'Target Agent', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'agent-target',
    })
    expect(bootstrap.resourceDatabase.botPresets[0]).toMatchObject({ id: 'preset-a', name: 'A', image: '' })
    const savedPreset = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/legacy-presets/preset-a',
      headers: { 'risu-auth': assertion },
    })
    expect(savedPreset.statusCode).toBe(200)
    expect(savedPreset.json().preset).toMatchObject({
      id: 'preset-a',
      name: 'A',
      mainPrompt: 'current prompt',
      temperature: 72,
      modelRuntimeDefaults: { maxContext: 7200, modelTools: ['current-tool'] },
      modelProfiles: [{ id: 'current-profile', name: 'Current Profile', modelId: 'current-model' }],
      modelRoleProfiles: expect.objectContaining({
        memory: { mode: 'profile', profileId: 'current-profile' },
      }),
      agentPresets: [{ id: 'current-agent', name: 'Current Agent', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'current-agent',
    })
  })

  it('saves and applies additionalParams when selecting a legacy preset', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', additionalParams: [['stale', 'value']] },
        { id: 'preset-b', name: 'B', additionalParams: [['target', 'value']] },
      ],
      botPresetsId: 0,
      additionalParams: [['current', 'value']],
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: true,
        apply: true,
      },
    })

    expect(selected.statusCode, selected.body).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      additionalParams: Array<[string, string]>
      botPresets: Array<{ id: string; additionalParams?: Array<[string, string]> }>
    }
    expect(persisted.additionalParams).toEqual([['target', 'value']])
    expect(persisted.botPresets[0]?.additionalParams).toEqual([['current', 'value']])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.additionalParams).toEqual([['target', 'value']])
    const savedPreset = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/legacy-presets/preset-a',
      headers: { 'risu-auth': assertion },
    })
    expect(savedPreset.statusCode).toBe(200)
    expect(savedPreset.json().preset.additionalParams).toEqual([['current', 'value']])
  })

  it.each([
    {
      name: 'absent field',
      target: {},
      expected: [['current', 'value']],
    },
    {
      name: 'explicit null',
      target: { additionalParams: null },
      expected: null,
    },
    {
      name: 'default empty array reset',
      target: { additionalParams: [] },
      expected: [],
    },
  ])('keeps the $name distinct when applying legacy preset additionalParams', async ({ target, expected }) => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', additionalParams: [['stale', 'value']] },
        { id: 'preset-b', name: 'B', ...target },
      ],
      botPresetsId: 0,
      additionalParams: [['current', 'value']],
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: false,
        apply: true,
      },
    })

    expect(selected.statusCode, selected.body).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      additionalParams: unknown
      botPresets: Array<Record<string, unknown>>
    }
    expect(persisted.additionalParams).toEqual(expected)
    expect(persisted.botPresets[1]).toEqual(expect.objectContaining({ id: 'preset-b', name: 'B', ...target }))
  })

  it('snapshots normalized default additionalParams before applying a non-default legacy preset', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A' },
        {
          id: 'preset-b',
          name: 'B',
          additionalParams: [
            ['body.option', 'true'],
            ['header::X-Target', 'target'],
          ],
        },
      ],
      botPresetsId: 0,
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: true,
        apply: true,
      },
    })

    expect(selected.statusCode, selected.body).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      additionalParams: Array<[string, string]>
      botPresets: Array<{ id: string; additionalParams?: Array<[string, string]> }>
    }
    expect(persisted.additionalParams).toEqual([
      ['body.option', 'true'],
      ['header::X-Target', 'target'],
    ])
    expect(persisted.botPresets[0]?.additionalParams).toEqual([])
  })

  it('reports the exact resource shape for no-apply preset selection', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', mainPrompt: 'a prompt' },
        { id: 'preset-b', name: 'B', mainPrompt: 'b prompt' },
      ],
      botPresetsId: 0,
    })

    const settingsOnly = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: false,
        apply: false,
      },
    })
    expect(settingsOnly.statusCode).toBe(200)
    expect(settingsOnly.json().event).toMatchObject({
      type: 'preset.selected',
      resource: 'presetPointer',
      id: 'preset-b',
    })

    const revisionOnly = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: settingsOnly.json().revision,
        presetId: 'preset-b',
        saveCurrent: false,
        apply: false,
      },
    })
    expect(revisionOnly.statusCode).toBe(200)
    expect(revisionOnly.json().event).toMatchObject({
      type: 'preset.selected',
      resource: 'revisionOnly',
      id: 'preset-b',
    })

    const collectionOnly = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revisionOnly.json().revision,
        presetId: 'preset-b',
        saveCurrent: true,
        apply: false,
      },
    })
    expect(collectionOnly.statusCode).toBe(200)
    expect(collectionOnly.json().event).toMatchObject({
      type: 'preset.selected',
      resource: 'presetCollection',
      id: 'preset-b',
    })

    const settingsAndCollection = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: collectionOnly.json().revision,
        presetId: 'preset-a',
        saveCurrent: true,
        apply: false,
      },
    })
    expect(settingsAndCollection.statusCode).toBe(200)
    expect(settingsAndCollection.json().event).toMatchObject({
      type: 'preset.selected',
      resource: 'presetCollectionWithPointer',
      id: 'preset-a',
    })
  })

  it('copies, deletes, and reorders presets by id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', mainPrompt: 'a prompt' },
        { id: 'preset-b', name: 'B', mainPrompt: 'b prompt' },
      ],
      botPresetsId: 0,
    })

    const copied = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/preset-a/copy',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        newPresetId: 'preset-copy',
        name: 'A Copy',
      },
    })
    expect(copied.statusCode).toBe(200)
    const copiedPresetId = copied.json().presetId as string
    expect(copiedPresetId).toBe('preset-copy')
    expect(copied.json().event).toMatchObject({
      type: 'preset.copied',
      resource: 'presetCollection',
      id: copiedPresetId,
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: copied.json().revision,
        presetIds: ['preset-b', copiedPresetId, 'preset-a'],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toMatchObject({
      presetReorderCertificate: 'preset-reorder-v1',
      presetKind: 'legacy',
      presetIds: ['preset-b', copiedPresetId, 'preset-a'],
      selectedPresetId: 'preset-a',
      settingsWritten: true,
      event: {
        type: 'preset.reordered',
        resource: 'presetCollectionWithPointer',
      },
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/commands/presets/${copiedPresetId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
        presetId: 'preset-b',
        apply: false,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 4,
      event: {
        type: 'preset.deleted',
        revision: 4,
        resource: 'presetCollectionWithPointer',
        id: copiedPresetId,
      },
      presetId: copiedPresetId,
      selectedPresetId: 'preset-b',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.botPresets.map((preset: { id: string }) => preset.id)).toEqual([
      'preset-b',
      'preset-a',
    ])
    expect(bootstrap.resourceDatabase.botPresetsId).toBe(0)
  })

  it('rejects preset reorder when the persisted selected pointer requires repair', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A' },
        { id: 'preset-b', name: 'B' },
      ],
      botPresetsId: 0,
    })
    updateSettingsRow((settings) => {
      settings.botPresetsId = 99
    })
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetIds: ['preset-b', 'preset-a'],
      },
    })

    expect(reordered.statusCode, reordered.body).toBe(400)
    expect(reordered.json().error).toBe('botPresetsId must select an existing record')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('rejects missing and duplicate preset ids on copy and import', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A' },
        { id: 'preset-b', name: 'B' },
      ],
      botPresetsId: 0,
    })

    const cases = [
      {
        url: '/api/v1/commands/presets/preset-a/copy',
        payload: { baseRevision: revision, name: 'Missing id' },
        error: 'newPresetId must be a non-empty string',
      },
      {
        url: '/api/v1/commands/presets/preset-a/copy',
        payload: { baseRevision: revision, newPresetId: 'preset-b', name: 'Duplicate' },
        error: 'Duplicate preset id: preset-b',
      },
      {
        url: '/api/v1/commands/presets/import',
        payload: { baseRevision: revision, preset: { name: 'Missing id' } },
        error: 'preset.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/presets/import',
        payload: { baseRevision: revision, preset: { id: 'preset-b', name: 'Duplicate' } },
        error: 'Duplicate preset id: preset-b',
      },
    ]

    for (const testCase of cases) {
      const res = await harness.app.inject({
        method: 'POST',
        url: testCase.url,
        headers: { 'risu-auth': assertion },
        payload: testCase.payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(testCase.error)
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.botPresets.map((preset: { id: string }) => preset.id)).toEqual([
      'preset-a',
      'preset-b',
    ])
  })

  it('rejects malformed preset reorder without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A' },
        { id: 'preset-b', name: 'B' },
      ],
      botPresetsId: 0,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetIds: ['preset-a', 'preset-a'],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Duplicate preset id: preset-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.botPresets.map((preset: { id: string }) => preset.id)).toEqual([
      'preset-a',
      'preset-b',
    ])
  })

  it('returns 404 and 409 for missing presets and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A' }],
      botPresetsId: 0,
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Preset not found: missing')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        patch: { name: 'stale' },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('Agent Preset command surface', () => {
  it('creates, updates, defaults, reorders, and projects Agent Presets without Context Agent conversion', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentContextEnabled: true,
      agentContextPrompt: 'legacy context prompt',
      agentContextMaxOutput: 999,
      agentContextMaxToolRounds: 2,
      agentPresets: [],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { name: 'Research Agent' },
      },
    })
    expect(created.statusCode).toBe(200)
    const createdBody = created.json() as { revision: number; presetId: string; event: Record<string, unknown> }
    expect(createdBody.presetId).toMatch(/^ap_/)
    expect(createdBody.event).toMatchObject({
      type: 'agentPreset.created',
      resource: 'agentPreset',
      id: createdBody.presetId,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/agent-presets/${createdBody.presetId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: createdBody.revision,
        patch: {
          name: 'Research Agent Renamed',
          description: 'before-main helper',
          moduleIntergration: 'research-tools, citations',
          finalOutputTemplate: '{{slot::mainOutput}}\n{{agent::research}}',
          maxConcurrency: 2,
          enabled: false,
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      presetId: createdBody.presetId,
      acknowledgedKeys: [
        'name',
        'description',
        'moduleIntergration',
        'finalOutputTemplate',
        'maxConcurrency',
        'enabled',
      ],
      canonicalValues: {
        name: 'Research Agent Renamed',
        description: 'before-main helper',
        moduleIntergration: 'research-tools, citations',
        finalOutputTemplate: '{{slot::mainOutput}}\n{{agent::research}}',
        maxConcurrency: 2,
        enabled: false,
      },
      canonicalDeletedKeys: [],
      updatedAt: expect.any(Number),
    })

    const defaulted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/default',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        agentPresetId: createdBody.presetId,
      },
    })
    expect(defaulted.statusCode).toBe(200)
    expect(defaulted.json()).toMatchObject({
      event: {
        type: 'agentPreset.default.updated',
        resource: 'agentPreset',
        id: createdBody.presetId,
      },
      agentPresetDefaultId: createdBody.presetId,
      certificate: 'agent-preset-collection-v1',
      agentPresetIds: [createdBody.presetId],
    })

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: defaulted.json().revision,
        preset: { name: 'After Agent' },
      },
    })
    expect(second.statusCode).toBe(200)
    const secondId = second.json().presetId as string

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: second.json().revision,
        presetIds: [secondId, createdBody.presetId],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toMatchObject({
      event: {
        type: 'agentPreset.reordered',
        resource: 'agentPreset',
      },
      agentPresetDefaultId: createdBody.presetId,
      certificate: 'agent-preset-collection-v1',
      agentPresetIds: [secondId, createdBody.presetId],
    })

    const settings = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'risu-auth': assertion },
    })
    expect(settings.statusCode).toBe(200)
    expect(settings.json()).toMatchObject({
      settings: {
        agentPresetDefaultId: createdBody.presetId,
      },
    })
    expect(settings.json().settings.agentPresets.map((preset: { id: string }) => preset.id)).toEqual([
      secondId,
      createdBody.presetId,
    ])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.agentPresets).toHaveLength(2)
    expect(bootstrap.resourceDatabase.agentPresets[1]).toMatchObject({
      id: createdBody.presetId,
      name: 'Research Agent Renamed',
      description: 'before-main helper',
      moduleIntergration: 'research-tools, citations',
      finalOutputTemplate: '{{slot::mainOutput}}\n{{agent::research}}',
      maxConcurrency: 2,
      enabled: false,
      steps: [],
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      agentContextEnabled: true,
      agentContextPrompt: 'legacy context prompt',
      agentContextMaxOutput: 999,
      agentContextMaxToolRounds: 2,
    })
  })

  it('migrates step mutations to Agents and duplicates presets with fresh use ids while sharing Agents', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [{ id: 'ap_source', name: 'Source', enabled: true, version: 1, steps: [] }],
    })

    const step = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        step: {
          name: 'Facts',
          phase: 'beforeMain',
          instruction: 'Find relevant facts.',
          outputKey: 'facts',
          inputScopes: ['currentUserMessage'],
        },
      },
    })
    expect(step.statusCode).toBe(200)
    const stepId = step.json().stepId as string
    expect(stepId).toMatch(/^aps_/)

    const duplicateKey = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: step.json().revision,
        step: {
          name: 'Duplicate Facts',
          phase: 'beforeMain',
          instruction: '',
          outputKey: 'facts',
        },
      },
    })
    expect(duplicateKey.statusCode).toBe(400)
    expect(duplicateKey.json().error).toContain('Duplicate enabled Agent Preset output key')

    const afterMain = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: step.json().revision,
        step: {
          name: 'Final polish',
          phase: 'afterMain',
          instruction: 'Polish the answer.',
          outputKey: 'polished',
          destination: 'finalOutput',
        },
      },
    })
    expect(afterMain.statusCode).toBe(200)

    const invalidAfterMainOrdering = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: afterMain.json().revision,
        step: {
          name: 'Advisory after',
          phase: 'afterMain',
          instruction: '',
          outputKey: 'advice',
        },
      },
    })
    expect(invalidAfterMainOrdering.statusCode).toBe(400)
    expect(invalidAfterMainOrdering.json().error).toContain('final-output modifier must be the last')

    const duplicatedStep = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/agent-presets/ap_source/steps/${stepId}/duplicate`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: afterMain.json().revision,
        name: 'Facts Copy',
      },
    })
    expect(duplicatedStep.statusCode).toBe(200)
    const duplicatedStepId = duplicatedStep.json().stepId as string
    expect(duplicatedStepId).not.toBe(stepId)

    const duplicatedPreset = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/duplicate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: duplicatedStep.json().revision,
        name: 'Source Copy',
      },
    })
    expect(duplicatedPreset.statusCode).toBe(200)
    const duplicatedPresetId = duplicatedPreset.json().presetId as string
    expect(duplicatedPresetId).not.toBe('ap_source')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const presets = bootstrap.resourceDatabase.agentPresets as Array<{
      id: string
      agentUses: Array<{ id: string; agentId: string }>
    }>
    const source = presets.find((preset) => preset.id === 'ap_source')!
    const copy = presets.find((preset) => preset.id === duplicatedPresetId)!
    expect(source.agentUses.map((candidate) => candidate.id)).toContain(stepId)
    expect(source.agentUses.map((candidate) => candidate.id)).toContain(duplicatedStepId)
    expect(copy.agentUses.map((candidate) => candidate.id)).not.toContain(stepId)
    expect(copy.agentUses).toHaveLength(source.agentUses.length)
    expect(copy.agentUses.map((use) => use.agentId)).toEqual(source.agentUses.map((use) => use.agentId))
    expect(bootstrap.resourceDatabase.agents).toHaveLength(2)
  })

  it('accepts a last before-main user-input modifier and rejects invalid phase or ordering', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [{ id: 'ap_input', name: 'Input Agent', enabled: true, version: 1, steps: [] }],
    })

    const modifier = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_input/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        step: {
          name: 'Rewrite input',
          phase: 'beforeMain',
          instruction: 'Rewrite the latest user input.',
          outputKey: 'input',
          destination: 'userInput',
        },
      },
    })
    expect(modifier.statusCode).toBe(200)

    const wrongPhase = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_input/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: modifier.json().revision,
        step: {
          name: 'Wrong phase',
          phase: 'afterMain',
          outputKey: 'wrong_phase',
          destination: 'userInput',
        },
      },
    })
    expect(wrongPhase.statusCode).toBe(400)
    expect(wrongPhase.json().error).toContain('Only before-main Agent uses can modify user input')

    const notLast = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_input/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: modifier.json().revision,
        step: {
          name: 'Later context',
          phase: 'beforeMain',
          outputKey: 'later_context',
          destination: 'intermediate',
        },
      },
    })
    expect(notLast.statusCode).toBe(400)
    expect(notLast.json().error).toContain('user-input modifier must be the last')
  })

  it('reuses one standalone Agent across presets and blocks deletion while referenced', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [
        { id: 'ap_one', name: 'One', enabled: true, version: 1, steps: [] },
        { id: 'ap_two', name: 'Two', enabled: true, version: 1, steps: [] },
      ],
    })
    const contextBinding = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agents',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        agent: { name: 'Out of scope', contextBinding: { source: 'chat' } },
      },
    })
    expect(contextBinding.statusCode).toBe(400)
    expect(contextBinding.json().error).toContain('agent.contextBinding is not supported')

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agents',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        agent: {
          name: 'Shared Researcher',
          instruction:
            '<|im_start|>user\nResearch with {{agentInput::reference}} using {{agentToggle::tone}}.<|im_end|>',
          useChatML: true,
          inputScopes: ['currentUserMessage'],
          toggles: [{ key: 'tone', label: 'Tone', kind: 'select', options: ['Warm', 'Formal'] }],
          lorebookInputs: [{ key: 'reference', displayName: 'Reference Notes', required: true }],
          outputFormat: 'text',
        },
      },
    })
    expect(created.statusCode).toBe(200)
    const agentId = created.json().agentId as string

    let currentRevision = created.json().revision as number
    const useIds = new Map<string, string>()
    for (const [presetId, outputKey] of [
      ['ap_one', 'research_one'],
      ['ap_two', 'research_two'],
    ]) {
      const attached = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/commands/agent-presets/${presetId}/uses`,
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: currentRevision, use: { agentId, outputKey } },
      })
      expect(attached.statusCode).toBe(200)
      currentRevision = attached.json().revision
      useIds.set(presetId, attached.json().useId)
    }

    const firstUseId = useIds.get('ap_one')!
    const secondUseId = useIds.get('ap_two')!
    const updatedUse = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/agent-presets/ap_one/uses/${firstUseId}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: currentRevision, patch: { runtimeOverride: { timeoutMs: 45_000 } } },
    })
    expect(updatedUse.statusCode).toBe(200)
    expect(updatedUse.json()).toMatchObject({
      useId: firstUseId,
      agentId,
      acknowledgedKeys: ['runtimeOverride'],
      canonicalValues: { runtimeOverride: { timeoutMs: 45_000 } },
      canonicalDeletedKeys: [],
    })
    currentRevision = updatedUse.json().revision

    const reorderedUses = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_two/uses/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: currentRevision, useIds: [secondUseId] },
    })
    expect(reorderedUses.statusCode).toBe(200)
    currentRevision = reorderedUses.json().revision

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/agents/${agentId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: currentRevision,
        patch: {
          instruction: '<|im_start|>user\nUpdated once for both presets. {{agentInput::reference}}<|im_end|>',
        },
      },
    })
    expect(updated.statusCode).toBe(200)

    const blockedDelete = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/commands/agents/${agentId}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: updated.json().revision },
    })
    expect(blockedDelete.statusCode).toBe(400)
    expect(blockedDelete.json().error).toContain('still used by 2')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.agents).toEqual([
      expect.objectContaining({
        id: agentId,
        instruction: '<|im_start|>user\nUpdated once for both presets. {{agentInput::reference}}<|im_end|>',
        useChatML: true,
        toggles: [{ key: 'tone', label: 'Tone', kind: 'select', options: ['Warm', 'Formal'] }],
        lorebookInputs: [{ key: 'reference', displayName: 'Reference Notes', required: true }],
      }),
    ])
    expect(
      bootstrap.resourceDatabase.agentPresets.map((preset: { agentUses: Array<{ agentId: string }> }) =>
        preset.agentUses.map((use) => use.agentId),
      ),
    ).toEqual([[agentId], [agentId]])
  })

  it('returns exact canonical field receipts for metadata and step PATCHes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [
        {
          id: 'ap_fields',
          name: 'Fields',
          description: 'Old description',
          moduleIntergration: 'old-space',
          enabled: true,
          version: 1,
          maxConcurrency: 4,
          steps: [
            {
              id: 'aps_fields',
              name: 'Fields Step',
              enabled: true,
              phase: 'beforeMain',
              dependencies: [],
              instruction: '',
              model: { mode: 'inheritMain' },
              runtime: {},
              inputScopes: [],
              outputKey: 'fields',
              outputFormat: 'text',
              destination: 'promptOutput',
              failurePolicy: { mode: 'required' },
            },
          ],
        },
      ],
    })

    const metadata = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/agent-presets/ap_fields',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: '  Trimmed Fields  ', description: '   ', moduleIntergration: null, maxConcurrency: null },
      },
    })
    expect(metadata.statusCode).toBe(200)
    expect(metadata.json()).toMatchObject({
      presetId: 'ap_fields',
      acknowledgedKeys: ['name', 'description', 'moduleIntergration', 'maxConcurrency'],
      canonicalValues: { name: 'Trimmed Fields' },
      canonicalDeletedKeys: ['description', 'moduleIntergration', 'maxConcurrency'],
      updatedAt: expect.any(Number),
    })

    const step = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/agent-presets/ap_fields/steps/aps_fields',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: metadata.json().revision,
        patch: {
          name: '  Trimmed Step  ',
          outputKey: '  canonical_key  ',
          inputScopes: ['currentUserMessage', 'currentUserMessage'],
          failurePolicy: 'fallbackText',
        },
      },
    })
    expect(step.statusCode).toBe(200)
    expect(step.json()).toMatchObject({
      presetId: 'ap_fields',
      stepId: 'aps_fields',
      acknowledgedKeys: ['name', 'outputKey', 'inputScopes', 'failurePolicy'],
      canonicalValues: {
        name: 'Trimmed Step',
        outputKey: 'canonical_key',
        inputScopes: ['currentUserMessage'],
        failurePolicy: { mode: 'fallbackText', text: '' },
      },
      canonicalDeletedKeys: [],
      updatedAt: expect.any(Number),
    })
  })

  it('rejects Agent Preset updates when a sibling requires repair', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [
        { id: 'ap_target', name: 'Target', enabled: true, version: 1, steps: [] },
        { id: 'ap_sibling', name: 'Sibling', enabled: true, version: 1, steps: [] },
      ],
      agentPresetDefaultId: 'ap_target',
    })
    updateSettingsRow((settings) => {
      const presets = settings.agentPresets as Array<Record<string, unknown>>
      presets[1] = { ...presets[1], name: '  Repaired Sibling  ', unexpected: true }
    })
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/agent-presets/ap_target',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { enabled: false } },
    })

    expect(updated.statusCode).toBe(400)
    expect(updated.json().error).toContain('Agent configuration must already be canonical')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('rejects Agent Preset reorder/default when the collection requires repair', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [
        { id: 'ap_target', name: 'Target', enabled: true, version: 1, steps: [] },
        { id: 'ap_sibling', name: 'Sibling', enabled: true, version: 1, steps: [] },
      ],
      agentPresetDefaultId: 'ap_target',
    })
    updateSettingsRow((settings) => {
      const presets = settings.agentPresets as Array<Record<string, unknown>>
      presets[1] = { ...presets[1], name: '  Repaired Sibling  ', unexpected: true }
    })
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, presetIds: ['ap_sibling', 'ap_target'] },
    })

    expect(reordered.statusCode).toBe(400)
    expect(reordered.json().error).toContain('Agent configuration must already be canonical')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)

    const defaulted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/default',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, agentPresetId: 'ap_sibling' },
    })

    expect(defaulted.statusCode).toBe(400)
    expect(defaulted.json().error).toContain('Agent configuration must already be canonical')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('deletes Agent Presets and clears default, chat, and loadout references atomically', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentContextEnabled: true,
      agentPresets: [
        { id: 'ap_delete', name: 'Delete Me', enabled: true, version: 1, steps: [] },
        { id: 'ap_keep', name: 'Keep Me', enabled: true, version: 1, steps: [] },
      ],
      agentPresetDefaultId: 'ap_delete',
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          agentPresetId: 'ap_delete',
          agentPresetName: 'Delete Me',
          personaId: '',
        },
        {
          id: 'loadout-b',
          name: 'B',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          agentPresetId: 'ap_keep',
          agentPresetName: 'Keep Me',
          personaId: '',
        },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-delete',
              name: 'Delete chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings: {
                configured: true,
                jailbreakToggle: false,
                agentPresetId: 'ap_delete',
              },
            },
            {
              id: 'chat-keep',
              name: 'Keep chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings: {
                configured: true,
                jailbreakToggle: false,
                agentPresetId: 'ap_keep',
              },
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/agent-presets/ap_delete',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'agentPreset.deleted',
        resource: 'agentPresetDeleted',
        id: 'ap_delete',
      },
      presetId: 'ap_delete',
      clearedDefault: true,
      clearedChatCount: 1,
      clearedLoadoutCount: 1,
    })

    const settings = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'risu-auth': assertion },
    })
    expect(settings.statusCode).toBe(200)
    expect(settings.json().settings.agentPresets).toEqual([
      { id: 'ap_keep', name: 'Keep Me', enabled: true, version: 1, agentUses: [], steps: [] },
    ])
    expect(settings.json().settings.agentPresetDefaultId).toBeUndefined()

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.agentPresets.map((preset: { id: string }) => preset.id)).toEqual(['ap_keep'])
    expect(bootstrap.resourceDatabase.agentPresetDefaultId).toBeUndefined()
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      id: string
      generationSettings?: { agentPresetId?: string }
    }>
    expect(chats.find((chat) => chat.id === 'chat-delete')?.generationSettings).not.toHaveProperty('agentPresetId')
    expect(chats.find((chat) => chat.id === 'chat-keep')?.generationSettings?.agentPresetId).toBe('ap_keep')
    const loadouts = bootstrap.resourceDatabase.loadouts as Array<{
      id: string
      agentPresetId?: string
      agentPresetName?: string
    }>
    expect(loadouts.find((loadout) => loadout.id === 'loadout-a')).not.toHaveProperty('agentPresetId')
    expect(loadouts.find((loadout) => loadout.id === 'loadout-a')).not.toHaveProperty('agentPresetName')
    expect(loadouts.find((loadout) => loadout.id === 'loadout-b')).toMatchObject({
      agentPresetId: 'ap_keep',
      agentPresetName: 'Keep Me',
    })
    expect(bootstrap.resourceDatabase.agentContextEnabled).toBe(true)
  })
})

describe('prompt template and item commands', () => {
  it('patches prompt settings and emits the prompt settings event', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptSettings: { sendName: false, maxThoughtTagDepth: -1 },
      jsonSchemaEnabled: false,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          mainPrompt: 'MAIN',
          jailbreak: 'JB',
          globalNote: 'GN',
          formatingOrder: ['main', 'jailbreak', 'globalNote'],
          promptPreprocess: true,
          presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
          promptSettings: { sendName: true, maxThoughtTagDepth: 4 },
          jsonSchemaEnabled: true,
          jsonSchema: '{"type":"object"}',
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'prompt.settings.updated',
        revision: 2,
        resource: 'prompt',
      },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      mainPrompt: 'MAIN',
      jailbreak: 'JB',
      globalNote: 'GN',
      formatingOrder: ['main', 'jailbreak', 'globalNote'],
      promptPreprocess: true,
      presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
      promptSettings: { sendName: true, maxThoughtTagDepth: 4 },
      jsonSchemaEnabled: true,
      jsonSchema: '{"type":"object"}',
    })
  })

  it('creates, updates, deletes, and reorders prompt items by stable id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptTemplate: [{ id: 'item-a', type: 'description' }],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptItem: {
          id: 'item-b',
          type: 'plain',
          type2: 'normal',
          text: 'hello',
          role: 'system',
          innerFormat: 'legacy format',
          removable: 'drop me',
          largeMetadata: 'x'.repeat(20_000),
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'prompt.item.created',
        revision: 2,
        resource: 'promptItem',
        id: 'item-b',
      },
      itemId: 'item-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-items/item-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          text: 'updated',
          role: 'user',
          innerFormat: null,
        },
        deleteKeys: ['removable'],
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event).toMatchObject({
      type: 'prompt.item.updated',
      resource: 'promptItem',
      id: 'item-b',
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        itemIds: ['item-b', 'item-a'],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event).toMatchObject({
      type: 'prompt.item.reordered',
      resource: 'promptItem',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/prompt-items/item-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event).toMatchObject({
      type: 'prompt.item.deleted',
      resource: 'promptItem',
      id: 'item-a',
    })

    const projected = await projectedPromptItems(harness.app, assertion)
    expect(projected.revision).toBe(deleted.json().revision)
    expect(projected.promptTemplate).toEqual([
      {
        id: 'item-b',
        type: 'plain',
        type2: 'normal',
        text: 'updated',
        role: 'user',
        innerFormat: null,
        largeMetadata: 'x'.repeat(20_000),
      },
    ])
  })

  it('applies sparse prompt item fields and deletions to a selected prompt preset only', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          promptTemplate: [
            {
              id: 'item-a',
              type: 'description',
              text: 'before',
              role2: 'assistant',
              innerFormat: 'legacy format',
              removable: 'drop me',
              largeMetadata: 'x'.repeat(20_000),
            },
          ],
        },
      ],
      promptTemplate: [{ id: 'root-item', type: 'memory', untouched: true }],
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-items/item-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptPresetId: 'prompt-a',
        patch: { id: 'item-a', text: 'after', innerFormat: null, role2: 'char' },
        deleteKeys: ['removable'],
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 2,
      event: {
        type: 'prompt.item.updated',
        revision: 2,
        resource: 'promptItem',
        id: 'item-a',
        parentId: 'prompt-a',
      },
      itemId: 'item-a',
    })

    const presetTemplate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/prompt-a/template',
      headers: { 'risu-auth': assertion },
    })
    expect(presetTemplate.statusCode).toBe(200)
    expect(presetTemplate.json().promptTemplate).toEqual([
      {
        id: 'item-a',
        type: 'description',
        text: 'after',
        role2: 'bot',
        innerFormat: null,
        largeMetadata: 'x'.repeat(20_000),
      },
    ])

    const rootTemplate = await projectedPromptItems(harness.app, assertion)
    expect(rootTemplate.promptTemplate).toEqual([{ id: 'root-item', type: 'memory', untouched: true }])
  })

  it('rejects malformed prompt commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          promptTemplate: [{ id: 'preset-item', type: 'plain', text: 'preset text' }],
        },
      ],
      promptTemplate: [
        { id: 'item-a', type: 'description' },
        { id: 'item-b', type: 'memory' },
      ],
    })

    const settings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { jsonSchemaEnabled: 'yes' },
      },
    })
    expect(settings.statusCode).toBe(400)
    expect(settings.json().error).toBe('jsonSchemaEnabled must be a boolean')

    const promptTemplateSettings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { promptTemplate: [] },
      },
    })
    expect(promptTemplateSettings.statusCode).toBe(400)
    expect(promptTemplateSettings.json().error).toBe('Unsupported prompt setting: promptTemplate')

    const missingId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptItem: { type: 'memory' },
      },
    })
    expect(missingId.statusCode).toBe(400)
    expect(missingId.json().error).toBe('promptItem.id must be a non-empty string')

    const duplicateCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptItem: { id: 'item-a', type: 'memory' },
      },
    })
    expect(duplicateCreate.statusCode).toBe(400)
    expect(duplicateCreate.json().error).toBe('Duplicate prompt item id: item-a')

    const reorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        itemIds: ['item-a', 'item-a'],
      },
    })
    expect(reorder.statusCode).toBe(400)
    expect(reorder.json().error).toBe('Duplicate prompt item id: item-a')

    const invalidUpdates = [
      {
        payload: { patch: {}, deleteKeys: 'text' },
        error: 'deleteKeys must be an array',
      },
      {
        payload: { patch: {}, deleteKeys: [''] },
        error: 'deleteKeys must contain non-empty strings',
      },
      {
        payload: { patch: {}, deleteKeys: ['text', 'text'] },
        error: 'Duplicate delete key: text',
      },
      {
        payload: { patch: {}, deleteKeys: ['id'] },
        error: 'deleteKeys must not contain id',
      },
      {
        payload: { patch: { id: 'item-b', text: 'changed' } },
        error: 'patch.id must match itemId',
      },
      {
        payload: { patch: { text: 'changed' }, deleteKeys: ['text'] },
        error: 'patch and deleteKeys must not overlap: text',
      },
      {
        payload: { patch: {} },
        error: 'prompt item update must include at least one field',
      },
      {
        payload: { patch: { id: 'item-a' } },
        error: 'prompt item update must include at least one field',
      },
      {
        payload: { patch: { ' ': true } },
        error: 'patch keys must be non-empty strings',
      },
    ]

    for (const invalid of invalidUpdates) {
      const update = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/prompt-items/item-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          ...invalid.payload,
        },
      })
      expect(update.statusCode).toBe(400)
      expect(update.json().error).toBe(invalid.error)
    }

    const invalidPresetUpdate = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-items/preset-item',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptPresetId: 'prompt-a',
        patch: { text: 'changed' },
        deleteKeys: ['text'],
      },
    })
    expect(invalidPresetUpdate.statusCode).toBe(400)
    expect(invalidPresetUpdate.json().error).toBe('patch and deleteKeys must not overlap: text')

    const projected = await projectedPromptItems(harness.app, assertion)
    expect(projected.revision).toBe(1)
    expect(projected.promptTemplate?.map((item) => item.id)).toEqual(['item-a', 'item-b'])

    const presetTemplate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/prompt-a/template',
      headers: { 'risu-auth': assertion },
    })
    expect(presetTemplate.json()).toMatchObject({
      revision: 1,
      promptTemplate: [{ id: 'preset-item', type: 'plain', text: 'preset text' }],
    })
  })

  it('enables and disables prompt items through prompt-item commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {})

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items/enable',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        enabled: true,
      },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      revision: 2,
      event: { type: 'prompt.item.enabled', resource: 'promptItem' },
      enabled: true,
    })

    const disabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items/enable',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: enabled.json().revision,
        enabled: false,
      },
    })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json()).toMatchObject({ revision: 3, enabled: false })

    const projected = await projectedPromptItems(harness.app, assertion)
    expect(projected.revision).toBe(disabled.json().revision)
    expect(projected.promptTemplate).toEqual([])
  })

  it('returns 404 and 409 for missing prompt items and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptTemplate: [{ id: 'item-a', type: 'description' }],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-items/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { type: 'memory' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Prompt item not found: missing')

    const stale = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/prompt-items/item-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('persona commands', () => {
  it('rejects unknown, duplicate, and MCP Persona module links', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
      selectedPersona: 0,
      modules: [
        { id: 'module-a', name: 'Module A', description: '' },
        { id: 'mcp-a', name: 'MCP', description: '', mcp: { url: 'internal:risuai' } },
      ],
    })

    for (const [moduleIds, message] of [
      [['missing'], 'Unknown module id in persona.modules: missing'],
      [['module-a', 'module-a'], 'Duplicate module id in persona.modules: module-a'],
      [['mcp-a'], 'Unknown module id in persona.modules: mcp-a'],
    ] as const) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/commands/personas',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          persona: {
            id: `persona-${moduleIds[0]}`,
            name: 'Linked Persona',
            icon: '',
            personaPrompt: '',
            note: '',
            modules: moduleIds,
          },
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(message)
    }
  })

  it('creates, updates, deletes, and reorders personas by stable id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const personaIconId = seedAssetMetadata(harness.dataDir)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'Current',
      userIcon: 'assets/current.png',
      personaPrompt: 'Current prompt',
      userNote: 'Current note',
      modules: [{ id: 'module-a', name: 'Module A', description: '' }],
      personas: [
        {
          id: 'persona-a',
          name: 'A',
          icon: '',
          personaPrompt: 'a prompt',
          note: 'a note',
        },
      ],
      selectedPersona: 0,
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        persona: {
          id: 'persona-b',
          name: 'B',
          displayName: 'Bee',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
          modules: ['module-a'],
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'persona.created',
        revision: 2,
        resource: 'persona',
        id: 'persona-b',
      },
      personaId: 'persona-b',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'create',
      personaProjectionDigest: personaCollectionDigest([
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: 'a note' },
        {
          id: 'persona-b',
          name: 'B',
          displayName: 'Bee',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
          modules: ['module-a'],
        },
      ]),
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: false,
      legacyProfileDigest: null,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: { name: 'B renamed', displayName: 'Localized B', largePortrait: true, modules: ['module-a'] },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 3,
      event: {
        type: 'persona.updated',
        revision: 3,
        resource: 'persona',
        id: 'persona-b',
      },
      personaId: 'persona-b',
      acknowledgedKeys: ['name', 'displayName', 'largePortrait', 'modules'],
      legacyProfileProjectionApplied: false,
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        personaIds: ['persona-b', 'persona-a'],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toEqual({
      revision: 4,
      event: {
        type: 'persona.reordered',
        revision: 4,
        resource: 'persona',
      },
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'reorder',
      personaProjectionDigest: personaCollectionDigest([
        {
          id: 'persona-b',
          name: 'B renamed',
          displayName: 'Localized B',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
          largePortrait: true,
          modules: ['module-a'],
        },
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: 'a note' },
      ]),
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: false,
      legacyProfileDigest: null,
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
        selectPersonaId: 'persona-b',
        mirrorLegacyProfile: true,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'persona.deleted',
        revision: 5,
        resource: 'persona',
        id: 'persona-a',
      },
      personaId: 'persona-a',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'delete',
      personaProjectionDigest: personaCollectionDigest([
        {
          id: 'persona-b',
          name: 'B renamed',
          displayName: 'Localized B',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
          largePortrait: true,
          modules: ['module-a'],
        },
      ]),
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: true,
      legacyProfileDigest: personaProfileDigest({
        name: 'B renamed',
        icon: personaIconId,
        personaPrompt: 'b prompt',
        note: 'b note',
      }),
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      username: 'B renamed',
      userIcon: personaIconId,
      personaPrompt: 'b prompt',
      userNote: 'b note',
      selectedPersona: 0,
    })
    expect(bootstrap.resourceDatabase.personas).toEqual([
      {
        id: 'persona-b',
        name: 'B renamed',
        displayName: 'Localized B',
        icon: personaIconId,
        personaPrompt: 'b prompt',
        note: 'b note',
        largePortrait: true,
        modules: ['module-a'],
      },
    ])
  })

  it('selects a persona while saving the previous legacy profile mirror fields', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const personaIconId = seedAssetMetadata(harness.dataDir)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'Edited A',
      userIcon: 'assets/edited-a.png',
      personaPrompt: 'edited a prompt',
      userNote: 'edited a note',
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: '' },
        {
          id: 'persona-b',
          name: 'B',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
        },
      ],
      selectedPersona: 0,
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        personaId: 'persona-b',
        saveCurrent: true,
        mirrorLegacyProfile: true,
      },
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 2,
      event: {
        type: 'persona.selected',
        revision: 2,
        resource: 'persona',
        id: 'persona-b',
      },
      personaId: 'persona-b',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'select',
      personaProjectionDigest: personaCollectionDigest([
        {
          id: 'persona-a',
          name: 'Edited A',
          icon: 'assets/edited-a.png',
          personaPrompt: 'edited a prompt',
          note: 'edited a note',
        },
        {
          id: 'persona-b',
          name: 'B',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
        },
      ]),
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: true,
      legacyProfileDigest: personaProfileDigest({
        name: 'B',
        icon: personaIconId,
        personaPrompt: 'b prompt',
        note: 'b note',
      }),
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      selectedPersona: 1,
      username: 'B',
      userIcon: personaIconId,
      personaPrompt: 'b prompt',
      userNote: 'b note',
    })
    expect(bootstrap.resourceDatabase.personas[0]).toMatchObject({
      id: 'persona-a',
      name: 'Edited A',
      icon: 'assets/edited-a.png',
      personaPrompt: 'edited a prompt',
      note: 'edited a note',
    })
  })

  it('certifies a no-save persona selection with ordered IDs instead of hashing unrelated row bodies', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'A',
      userIcon: '',
      personaPrompt: 'A prompt',
      userNote: '',
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'A prompt', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'B prompt', note: '' },
      ],
      selectedPersona: 0,
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        personaId: 'persona-b',
        saveCurrent: false,
        mirrorLegacyProfile: true,
      },
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 2,
      event: {
        type: 'persona.selected',
        revision: 2,
        resource: 'persona',
        id: 'persona-b',
      },
      personaId: 'persona-b',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'select',
      personaProjectionDigest: personaIdsDigest(['persona-a', 'persona-b']),
      selectedPersonaId: 'persona-b',
      collectionWritten: false,
      settingsWritten: true,
      legacyProfileProjectionApplied: true,
      legacyProfileDigest: personaProfileDigest({
        name: 'B',
        icon: '',
        personaPrompt: 'B prompt',
        note: '',
      }),
    })
  })

  it('reports when a persona PATCH applies the selected legacy profile projection', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'A',
      userIcon: '',
      personaPrompt: 'Old prompt',
      userNote: 'Old note',
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: 'Old prompt', note: 'Old note' }],
      selectedPersona: 0,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { personaPrompt: 'New prompt', note: 'New note' },
        mirrorLegacyProfile: true,
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      personaId: 'persona-a',
      acknowledgedKeys: ['personaPrompt', 'note'],
      legacyProfileProjectionApplied: true,
    })
    expect(updated.json()).not.toHaveProperty('persona')
    expect(updated.json()).not.toHaveProperty('settings')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      personaPrompt: 'New prompt',
      userNote: 'New note',
    })
  })

  it('rejects malformed persona commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'b prompt', note: '' },
      ],
      selectedPersona: 0,
    })

    const update = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { largePortrait: 'yes' },
      },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().error).toBe('patch.largePortrait must be a boolean')

    const invalidDisplayName = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { displayName: 123 },
      },
    })
    expect(invalidDisplayName.statusCode).toBe(400)
    expect(invalidDisplayName.json().error).toBe('patch.displayName must be a string')

    const reorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        personaIds: ['persona-a', 'persona-a'],
      },
    })
    expect(reorder.statusCode).toBe(400)
    expect(reorder.json().error).toBe('Duplicate persona id: persona-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.personas.map((persona: { id: string }) => persona.id)).toEqual([
      'persona-a',
      'persona-b',
    ])
  })

  it('fails closed on missing or duplicate stable persona ownership without repairing persisted rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'b prompt', note: '' },
      ],
      selectedPersonaId: 'persona-a',
      selectedPersona: 0,
    })
    const databasePath = path.join(harness.dataDir, 'risu.db')

    const corruptSettings = new DatabaseSync(databasePath)
    try {
      const row = corruptSettings.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(row.data_json) as Record<string, unknown>
      settings.selectedPersonaId = 'missing-persona'
      settings.selectedPersona = 0
      corruptSettings.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      corruptSettings.close()
    }
    expect((loadPersistedFromDir(harness.dataDir).database as Record<string, unknown>).selectedPersona).toBe(-1)

    const missingSelection = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, personaId: 'persona-b' },
    })
    expect(missingSelection.statusCode).toBe(400)
    expect(missingSelection.json().error).toBe('selectedPersonaId must reference exactly one existing persona')

    const duplicateRows = new DatabaseSync(databasePath)
    try {
      const settingsRow = duplicateRows.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>
      settings.selectedPersonaId = 'persona-a'
      duplicateRows.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))

      const personaRow = duplicateRows.prepare('SELECT data_json FROM personas WHERE position = 1').get() as {
        data_json: string
      }
      const persona = JSON.parse(personaRow.data_json) as Record<string, unknown>
      persona.id = 'persona-a'
      duplicateRows.prepare('UPDATE personas SET data_json = ? WHERE position = 1').run(JSON.stringify(persona))
    } finally {
      duplicateRows.close()
    }

    const duplicateSelection = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, personaIds: ['persona-a', 'persona-b'] },
    })
    expect(duplicateSelection.statusCode).toBe(400)
    expect(duplicateSelection.json().error).toBe('Duplicate persona id: persona-a')

    const persisted = new DatabaseSync(databasePath)
    try {
      const rows = persisted.prepare('SELECT data_json FROM personas ORDER BY position').all() as Array<{
        data_json: string
      }>
      expect(rows.map((row) => (JSON.parse(row.data_json) as { id: string }).id)).toEqual(['persona-a', 'persona-a'])
      const settingsRow = persisted.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      expect(JSON.parse(settingsRow.data_json)).toMatchObject({ selectedPersonaId: 'persona-a', selectedPersona: 0 })
    } finally {
      persisted.close()
    }
  })

  it('returns 404 and 409 for missing personas and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: '' }],
      selectedPersona: 0,
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Persona not found: missing')

    const stale = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('translator preset commands', () => {
  it('creates, updates, deletes, and selects translator presets by stable id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [
        {
          id: 'translator-a',
          name: 'A',
          prompt: 'translate to A',
          maxResponse: 100,
        },
      ],
      translatorPresetId: 0,
      translatorPrompt: 'translate to A',
      translatorMaxResponse: 100,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'Bound chat',
              note: '',
              message: [],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/translator-presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: {
          id: 'translator-b',
          name: 'B',
          prompt: 'translate to B',
          maxResponse: 200,
        },
        select: true,
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'translatorPreset.created',
        revision: 2,
        resource: 'translatorPreset',
        id: 'translator-b',
      },
      presetId: 'translator-b',
    })
    const bindingDb = openDatabase(harness.dataDir)
    try {
      const row = bindingDb.prepare('SELECT data_json FROM chats WHERE id = ?').get('chat-a') as {
        data_json: string
      }
      const chat = JSON.parse(row.data_json)
      chat.translatorPresetId = 'translator-b'
      bindingDb.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(chat), 'chat-a')
    } finally {
      bindingDb.close()
    }

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'B renamed',
          prompt: 'translate to B updated',
          maxResponse: 250,
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 3,
      event: {
        type: 'translatorPreset.updated',
        revision: 3,
        resource: 'translatorPreset',
        id: 'translator-b',
      },
      presetId: 'translator-b',
      acknowledgedKeys: ['name', 'prompt', 'maxResponse'],
      selectedPresetId: 'translator-b',
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/translator-presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        presetId: 'translator-a',
      },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 4,
      event: {
        type: 'translatorPreset.selected',
        revision: 4,
        resource: 'translatorPreset',
        id: 'translator-a',
      },
      presetId: 'translator-a',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/translator-presets/translator-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: selected.json().revision,
        selectPresetId: 'translator-a',
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'translatorPreset.deleted',
        revision: 5,
        resource: 'state',
        id: 'translator-b',
      },
      presetId: 'translator-b',
      selectedPresetId: 'translator-a',
      cascadedChatIds: ['chat-a'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      translatorPresetId: 'translator-a',
      translatorPrompt: 'translate to A',
      translatorMaxResponse: 100,
    })
    expect(bootstrap.resourceDatabase.translatorPresets).toMatchObject([
      {
        id: 'translator-a',
        name: 'A',
        prompt: 'translate to A',
        maxResponse: 100,
      },
    ])
    expect(bootstrap.resourceDatabase.translatorPresets[0].steps).toMatchObject([
      {
        enabled: true,
        prompt: 'translate to A',
        maxResponse: 100,
        model: { mode: 'inheritTranslate' },
      },
    ])
    expect(bootstrap.resourceDatabase.characters[0].chats[0]).not.toHaveProperty('translatorPresetId')
  })

  it('leaves legacy translator fields unchanged when updating the selected preset', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [{ id: 'translator-a', name: 'A', prompt: 'old prompt', maxResponse: 100 }],
      translatorPresetId: 0,
      translatorPrompt: 'stale scalar prompt',
      translatorMaxResponse: 7,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          prompt: 'new prompt',
          maxResponse: 321,
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 2,
      event: {
        type: 'translatorPreset.updated',
        revision: 2,
        resource: 'translatorPreset',
        id: 'translator-a',
      },
      presetId: 'translator-a',
      acknowledgedKeys: ['prompt', 'maxResponse'],
      selectedPresetId: 'translator-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      translatorPrompt: 'stale scalar prompt',
      translatorMaxResponse: 7,
      translatorPresets: [expect.objectContaining({ id: 'translator-a', prompt: 'new prompt', maxResponse: 321 })],
    })
  })

  it('returns the stable selection when updating a non-selected preset without echoing preset data', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [
        { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
        { id: 'translator-b', name: 'B', prompt: 'b prompt', maxResponse: 200 },
      ],
      translatorPresetId: 0,
      translatorPrompt: 'a prompt',
      translatorMaxResponse: 100,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { prompt: 'a deliberately large prompt is not echoed' },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 2,
      event: {
        type: 'translatorPreset.updated',
        revision: 2,
        resource: 'translatorPreset',
        id: 'translator-b',
      },
      presetId: 'translator-b',
      acknowledgedKeys: ['prompt'],
      selectedPresetId: 'translator-a',
    })
  })

  it('keeps PATCH acknowledgement scoped when sibling state is already canonical', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [
        { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
        { id: 'translator-b', name: 'B', prompt: 'b prompt', maxResponse: 200 },
      ],
      translatorPresetId: 0,
      translatorPrompt: 'a prompt',
      translatorMaxResponse: 100,
    })
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare('UPDATE translator_presets SET data_json = ? WHERE position = 1').run(
        JSON.stringify({
          id: 'translator-b',
          name: '',
          prompt: 'b prompt',
          maxResponse: 200,
          droppedByNormalization: true,
        }),
      )
    } finally {
      db.close()
    }

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { prompt: 'updated a prompt' },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 2,
      event: {
        type: 'translatorPreset.updated',
        revision: 2,
        resource: 'translatorPreset',
        id: 'translator-a',
      },
      presetId: 'translator-a',
      acknowledgedKeys: ['prompt'],
      selectedPresetId: 'translator-a',
    })
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.translatorPresets[1]).toMatchObject({
      id: 'translator-b',
      name: '',
      prompt: 'b prompt',
      maxResponse: 200,
    })
  })

  it('rejects malformed translator preset commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [
        { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
        { id: 'translator-b', name: 'B', prompt: 'b prompt', maxResponse: 200 },
      ],
      translatorPresetId: 0,
    })

    const update = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { maxResponse: 'large' },
      },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().error).toBe('patch.maxResponse must be a finite number')

    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/translator-presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: {
          id: 'translator-a',
          name: 'Duplicate',
          prompt: '',
          maxResponse: 100,
        },
      },
    })
    expect(create.statusCode).toBe(400)
    expect(create.json().error).toBe('Duplicate translator preset id: translator-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.translatorPresets.map((preset: { id: string }) => preset.id)).toEqual([
      'translator-a',
      'translator-b',
    ])
  })

  it('returns 404 and 409 for missing translator presets and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [{ id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 }],
      translatorPresetId: 0,
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Translator preset not found: missing')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/translator-presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        presetId: 'translator-a',
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('loadout commands', () => {
  it('creates, updates, favorites, touches, and deletes loadouts by stable id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: ['char-a'],
          modules: ['module-a'],
          globalVariables: { mood: 'calm' },
          presetName: 'Preset A',
          personaId: 'persona-a',
        },
      ],
      lastLoadedLoadoutName: '',
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        loadout: {
          id: 'loadout-b',
          name: 'B',
          lastUsed: 200,
          favorite: false,
          characterIds: [],
          modules: ['module-b'],
          globalVariables: { tone: 'warm' },
          presetName: 'Preset B',
          modelPresetId: 'model-b',
          modelPresetName: 'Model B',
          promptPresetId: 'prompt-b',
          promptPresetName: 'Prompt B',
          agentPresetId: 'agent-preset-b',
          agentPresetName: 'Agent Preset B',
          personaId: 'persona-b',
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'loadout.created',
        revision: 2,
        resource: 'loadout',
        id: 'loadout-b',
      },
      loadoutId: 'loadout-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/loadouts/loadout-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'B renamed',
          globalVariables: { tone: 'bright' },
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event).toMatchObject({
      type: 'loadout.updated',
      resource: 'loadout',
      id: 'loadout-b',
    })

    const favorited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-b/favorite',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        favorite: true,
      },
    })
    expect(favorited.statusCode).toBe(200)
    expect(favorited.json().event).toMatchObject({
      type: 'loadout.favorited',
      resource: 'loadout',
      id: 'loadout-b',
    })

    const touched = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-b/touch',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: favorited.json().revision,
        lastUsed: 300,
        characterId: 'char-c',
      },
    })
    expect(touched.statusCode).toBe(200)
    expect(touched.json()).toEqual({
      revision: 5,
      event: {
        type: 'loadout.touched',
        revision: 5,
        resource: 'loadout',
        id: 'loadout-b',
      },
      loadoutId: 'loadout-b',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/loadouts/loadout-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: touched.json().revision,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({
      revision: 6,
      event: {
        type: 'loadout.deleted',
        revision: 6,
        resource: 'loadout',
        id: 'loadout-a',
      },
      loadoutId: 'loadout-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      lastLoadedLoadoutName: 'B renamed',
    })
    expect(bootstrap.resourceDatabase.loadouts).toEqual([
      {
        id: 'loadout-b',
        name: 'B renamed',
        lastUsed: 300,
        favorite: true,
        characterIds: ['char-c'],
        modules: ['module-b'],
        globalVariables: { tone: 'bright' },
        presetName: 'Preset B',
        modelPresetId: 'model-b',
        modelPresetName: 'Model B',
        promptPresetId: 'prompt-b',
        promptPresetName: 'Prompt B',
        agentPresetId: 'agent-preset-b',
        agentPresetName: 'Agent Preset B',
        personaId: 'persona-b',
      },
    ])
  })

  it('touches duplicate-named loadouts by stable id without inferring the last-touch name on rename or delete', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'Shared name',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
        {
          id: 'loadout-b',
          name: 'Shared name',
          lastUsed: 200,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
      lastLoadedLoadoutName: 'Before touch',
    })

    const touched = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-b/touch',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, lastUsed: 300 },
    })
    expect(touched.statusCode).toBe(200)

    const afterTouch = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterTouch.resourceDatabase.loadouts).toEqual([
      expect.objectContaining({ id: 'loadout-a', name: 'Shared name', lastUsed: 100 }),
      expect.objectContaining({ id: 'loadout-b', name: 'Shared name', lastUsed: 300 }),
    ])
    expect(afterTouch.resourceDatabase.lastLoadedLoadoutName).toBe('Shared name')

    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/loadouts/loadout-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: touched.json().revision, patch: { name: 'Renamed B' } },
    })
    expect(renamed.statusCode).toBe(200)

    const afterRename = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterRename.resourceDatabase.loadouts[1]).toMatchObject({ id: 'loadout-b', name: 'Renamed B' })
    expect(afterRename.resourceDatabase.lastLoadedLoadoutName).toBe('Shared name')

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/loadouts/loadout-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: renamed.json().revision },
    })
    expect(deleted.statusCode).toBe(200)

    const afterDelete = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterDelete.resourceDatabase.loadouts).toEqual([
      expect.objectContaining({ id: 'loadout-a', name: 'Shared name', lastUsed: 100 }),
    ])
    expect(afterDelete.resourceDatabase.lastLoadedLoadoutName).toBe('Shared name')
  })

  it('fails closed on duplicate persisted loadout ids without repairing sibling rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        { id: 'loadout-a', name: 'A' },
        { id: 'loadout-b', name: 'B' },
      ],
      lastLoadedLoadoutName: 'Before',
    })
    const databasePath = path.join(harness.dataDir, 'risu.db')
    const corrupt = new DatabaseSync(databasePath)
    try {
      const sibling = corrupt.prepare('SELECT data_json FROM loadouts WHERE position = 1').get() as {
        data_json: string
      }
      const row = JSON.parse(sibling.data_json) as Record<string, unknown>
      row.id = 'loadout-a'
      corrupt.prepare('UPDATE loadouts SET data_json = ? WHERE position = 1').run(JSON.stringify(row))
    } finally {
      corrupt.close()
    }

    const favorited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-a/favorite',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, favorite: true },
    })
    expect(favorited.statusCode).toBe(400)
    expect(favorited.json().error).toBe('Duplicate loadout id: loadout-a')

    const persisted = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const rows = persisted.prepare('SELECT data_json FROM loadouts ORDER BY position').all() as Array<{
        data_json: string
      }>
      expect(rows.map((row) => JSON.parse(row.data_json))).toEqual([
        expect.objectContaining({ id: 'loadout-a', favorite: false }),
        expect.objectContaining({ id: 'loadout-a', favorite: false }),
      ])
    } finally {
      persisted.close()
    }
  })

  it('does not duplicate an existing character membership when a loadout is touched', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: ['char-a'],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
      lastLoadedLoadoutName: '',
    })

    const touched = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-a/touch',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        lastUsed: 200,
        characterId: 'char-a',
      },
    })
    expect(touched.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.loadouts[0]).toMatchObject({
      lastUsed: 200,
      characterIds: ['char-a'],
    })
  })

  it('rejects malformed loadout commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
    })

    const update = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/loadouts/loadout-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { lastUsed: 'recently' },
      },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().error).toBe('patch.lastUsed must be a finite number')

    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        loadout: {
          id: 'loadout-a',
          name: 'Duplicate',
          lastUsed: 200,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      },
    })
    expect(create.statusCode).toBe(400)
    expect(create.json().error).toBe('Duplicate loadout id: loadout-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.loadouts).toEqual([
      {
        id: 'loadout-a',
        name: 'A',
        lastUsed: 100,
        favorite: false,
        characterIds: [],
        modules: [],
        globalVariables: {},
        presetName: '',
        modelPresetId: '',
        modelPresetName: '',
        promptPresetId: '',
        promptPresetName: '',
        personaId: '',
      },
    ])
  })

  it('returns 404 and 409 for missing loadouts and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
    })

    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/missing/favorite',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        favorite: true,
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Loadout not found: missing')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-a/touch',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        lastUsed: 200,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('character commands', () => {
  it('adds writer origin only to live command events', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b'],
    })
    harness.commandEvents.clear()

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/select',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: {
        baseRevision: revision,
        characterId: 'char-b',
        lastInteraction: 4321,
      },
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json().event).toEqual({
      type: 'character.selected',
      revision: revision + 1,
      resource: 'characterSelection',
      id: 'char-b',
    })
    expect(harness.commandEvents.list()).toEqual([
      {
        ...selected.json().event,
        origin: { writerSessionId: 'writer-a' },
      },
    ])
  })

  it('selects a character without rewriting unrelated character or chat rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a-1', name: 'A1', message: [] },
            { id: 'chat-a-2', name: 'A2', message: [] },
          ],
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [{ id: 'chat-b-1', name: 'B1', message: [] }],
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })
    const characterRowsBefore = tableRowidsById(harness.dataDir, 'characters')
    const chatRowsBefore = tableRowidsById(harness.dataDir, 'chats')

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        characterId: 'char-b',
        lastInteraction: 4321,
      },
    })

    expect(selected.statusCode).toBe(200)
    // Targeted selection UPDATEs only char-b's row + settings, so no character
    // or chat row is rewritten (every rowid stays put).
    assertOnlyRowsWritten(characterRowsBefore, tableRowidsById(harness.dataDir, 'characters'))
    assertOnlyRowsWritten(chatRowsBefore, tableRowidsById(harness.dataDir, 'chats'))
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      currentChar: 1,
      characters: [{ chaId: 'char-a' }, { chaId: 'char-b', lastInteraction: 4321 }],
    })
  })

  it('atomically cascades alternate greeting deletion and reordering through every child chat', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          alternateGreetings: ['zero', 'one', 'two'],
          chats: [
            { id: 'chat-primary', name: 'Primary', message: [], fmIndex: -1 },
            { id: 'chat-before', name: 'Before', message: [], fmIndex: 0 },
            { id: 'chat-deleted', name: 'Deleted', message: [], fmIndex: 1 },
            { id: 'chat-after', name: 'After', message: [], fmIndex: 2 },
            { id: 'chat-fractional', name: 'Fractional', message: [], fmIndex: 1.5 },
            { id: 'chat-invalid', name: 'Invalid', message: [], fmIndex: 9 },
          ],
        },
      ],
      characterOrder: ['char-a'],
    })
    {
      const db = openDatabase(harness.dataDir)
      try {
        for (const [greetingIndex, source] of [
          [-1, 'primary'],
          [0, 'zero'],
          [1, 'one'],
          [2, 'two'],
        ] as const) {
          upsertGreetingTranslation(db, 'char-a', greetingIndex, {
            text: `${source} translated`,
            source: 'raw',
            sourceHash: sourceHash(source),
            targetLanguage: 'ko',
            inputLanguage: 'en',
            translatorType: 'google',
            settingsHash: 'settings-a',
            updatedAt: 123,
          })
        }
      } finally {
        db.close()
      }
    }

    const deleted = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/alternate-greetings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        alternateGreetings: ['zero', 'two'],
        operation: { type: 'delete', index: 1 },
      },
    })

    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      event: {
        type: 'character.alternateGreetings.updated',
        resource: 'characterRow',
        id: 'char-a',
      },
      characterId: 'char-a',
      certificate: 'alternate-greeting-index-cascade-v1',
      chatGreetingIndices: [
        { chatId: 'chat-primary', fmIndex: -1 },
        { chatId: 'chat-before', fmIndex: 0 },
        { chatId: 'chat-deleted', fmIndex: -1 },
        { chatId: 'chat-after', fmIndex: 1 },
        { chatId: 'chat-fractional', fmIndex: -1 },
        { chatId: 'chat-invalid', fmIndex: -1 },
      ],
    })
    expect(readJsonRow('characters', 'char-a').alternateGreetings).toEqual(['zero', 'two'])
    expect(
      ['chat-primary', 'chat-before', 'chat-deleted', 'chat-after', 'chat-fractional', 'chat-invalid'].map(
        (chatId) => readJsonRow('chats', chatId).fmIndex,
      ),
    ).toEqual([-1, 0, -1, 1, -1, -1])
    {
      const db = openDatabase(harness.dataDir)
      try {
        expect(getGreetingTranslation(db, 'char-a', -1, 'settings-a')?.translation.text).toBe('primary translated')
        expect(getGreetingTranslation(db, 'char-a', 0, 'settings-a')?.translation.text).toBe('zero translated')
        expect(getGreetingTranslation(db, 'char-a', 1, 'settings-a')?.translation.text).toBe('two translated')
        expect(getGreetingTranslation(db, 'char-a', 2, 'settings-a')).toBeNull()
      } finally {
        db.close()
      }
    }

    const swapped = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/alternate-greetings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: deleted.json().revision,
        alternateGreetings: ['two', 'zero'],
        operation: { type: 'swap', firstIndex: 0, secondIndex: 1 },
      },
    })

    expect(swapped.statusCode).toBe(200)
    expect(readJsonRow('characters', 'char-a').alternateGreetings).toEqual(['two', 'zero'])
    expect(readJsonRow('chats', 'chat-before').fmIndex).toBe(1)
    expect(readJsonRow('chats', 'chat-after').fmIndex).toBe(0)
    {
      const db = openDatabase(harness.dataDir)
      try {
        expect(getGreetingTranslation(db, 'char-a', 0, 'settings-a')?.translation.text).toBe('two translated')
        expect(getGreetingTranslation(db, 'char-a', 1, 'settings-a')?.translation.text).toBe('zero translated')
        expect(getGreetingTranslation(db, 'char-a', -1, 'settings-a')?.translation.text).toBe('primary translated')
      } finally {
        db.close()
      }
    }
  })

  it('invalidates only greeting rows whose ordinary character patch changes their source', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          firstMessage: 'primary',
          alternateGreetings: ['zero', 'one'],
          chats: [],
        },
      ],
      characterOrder: ['char-a'],
    })
    const db = openDatabase(harness.dataDir)
    try {
      for (const [greetingIndex, source] of [
        [-1, 'primary'],
        [0, 'zero'],
        [1, 'one'],
      ] as const) {
        upsertGreetingTranslation(db, 'char-a', greetingIndex, {
          text: `${source} translated`,
          source: 'raw',
          sourceHash: sourceHash(source),
          targetLanguage: 'ko',
          inputLanguage: 'en',
          translatorType: 'google',
          settingsHash: 'settings-a',
          updatedAt: 123,
        })
      }
    } finally {
      db.close()
    }

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { firstMessage: 'primary edited', alternateGreetings: ['zero', 'one edited'] },
      },
    })
    expect(patched.statusCode).toBe(200)
    const after = openDatabase(harness.dataDir)
    try {
      expect(getGreetingTranslation(after, 'char-a', -1, 'settings-a')).toBeNull()
      expect(getGreetingTranslation(after, 'char-a', 0, 'settings-a')?.translation.text).toBe('zero translated')
      expect(getGreetingTranslation(after, 'char-a', 1, 'settings-a')).toBeNull()
    } finally {
      after.close()
    }
  })

  it('persists and validates character script model overrides as profile ids', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          scriptModelOverrides: {
            llmProfileId: 'character-main-profile',
            axLlmProfileId: 'character-aux-profile',
          },
        },
      },
    })
    expect(patched.statusCode).toBe(200)
    expect(readJsonRow('characters', 'char-a').scriptModelOverrides).toEqual({
      llmProfileId: 'character-main-profile',
      axLlmProfileId: 'character-aux-profile',
    })

    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        patch: { scriptModelOverrides: { llmProfileId: '' } },
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('patch.scriptModelOverrides.llmProfileId must be a non-empty string')
  })

  it('creates, updates, selects, reorders, and deletes characters by chaId', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          firstMessage: 'hello',
          desc: 'desc a',
          chats: [],
          chatFolders: [],
          chatPage: 0,
          viewScreen: 'none',
          bias: [],
          emotionImages: [],
          globalLore: [],
          sdData: [],
          customscript: [],
          triggerscript: [],
          utilityBot: false,
          exampleMessage: '',
          creatorNotes: '',
          systemPrompt: '',
          postHistoryInstructions: '',
          alternateGreetings: [],
          tags: [],
          creator: '',
          characterVersion: '',
          personality: '',
          scenario: '',
          firstMsgIndex: -1,
          replaceGlobalNote: '',
          additionalText: '',
        },
      ],
      characterOrder: ['char-a'],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          firstMessage: 'hi',
          desc: 'desc b',
          chats: [],
          chatFolders: [],
          chatPage: 0,
          viewScreen: 'none',
          bias: [],
          emotionImages: [],
          globalLore: [],
          sdData: [],
          customscript: [],
          triggerscript: [],
          utilityBot: false,
          exampleMessage: '',
          creatorNotes: '',
          systemPrompt: '',
          postHistoryInstructions: '',
          alternateGreetings: [],
          tags: [],
          creator: '',
          characterVersion: '',
          personality: '',
          scenario: '',
          firstMsgIndex: -1,
          replaceGlobalNote: '',
          additionalText: '',
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'character.created',
        revision: 2,
        resource: 'character',
        id: 'char-b',
      },
      characterId: 'char-b',
      selectedCharacterId: 'char-a',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'B renamed',
          displayName: 'Localized B',
          desc: 'new desc',
          systemPrompt: 'new system prompt',
          ttsMode: 'openai',
          oaiTTSConfig: { enabled: true, voice: 'alloy', model: 'tts-1', format: 'mp3' },
          depth_prompt: { depth: 2, prompt: 'stay close' },
          trashTime: 1000,
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event).toMatchObject({
      type: 'character.updated',
      // trashTime also rewrites characterOrder, so it invalidates the full character resource.
      resource: 'character',
      id: 'char-b',
    })
    expect(
      ((loadPersistedFromDir(harness.dataDir).database as any).characters as Array<Record<string, unknown>>).find(
        (character) => character.chaId === 'char-b',
      ),
    ).toMatchObject({
      name: 'B renamed',
      displayName: 'Localized B',
      systemPrompt: 'new system prompt',
      ttsMode: 'openai',
      oaiTTSConfig: { enabled: true, voice: 'alloy', model: 'tts-1', format: 'mp3' },
      depth_prompt: { depth: 2, prompt: 'stay close' },
    })

    const restored = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        patch: {
          trashTime: null,
        },
      },
    })
    expect(restored.statusCode).toBe(200)
    expect(restored.json().event).toMatchObject({
      type: 'character.updated',
      resource: 'character',
      id: 'char-b',
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: restored.json().revision,
        characterId: 'char-b',
        lastInteraction: 4321,
      },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 5,
      event: {
        type: 'character.selected',
        revision: 5,
        resource: 'characterSelection',
        id: 'char-b',
      },
      characterId: 'char-b',
    })
    expect(
      ((loadPersistedFromDir(harness.dataDir).database as any).characters as Array<Record<string, unknown>>).find(
        (character) => character.chaId === 'char-b',
      ),
    ).toMatchObject({
      lastInteraction: 4321,
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: selected.json().revision,
        characterOrder: [
          {
            id: 'folder-a',
            name: 'Folder A',
            color: 'blue',
            data: ['char-b'],
            askBeforeOpening: true,
          },
          'char-a',
        ],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toEqual({
      revision: 6,
      event: {
        type: 'character.reordered',
        revision: 6,
        resource: 'characterOrder',
      },
      selectedCharacterId: 'char-b',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({
      revision: 7,
      event: {
        type: 'character.deleted',
        revision: 7,
        resource: 'character',
        id: 'char-a',
      },
      characterId: 'char-a',
      selectedCharacterId: 'char-b',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.currentChar).toBe(0)
    expect(bootstrap.resourceDatabase.characters).toMatchObject([
      {
        chaId: 'char-b',
        name: 'B renamed',
        desc: 'new desc',
      },
    ])
    expect(bootstrap.resourceDatabase.characterOrder).toEqual([
      {
        id: 'folder-a',
        name: 'Folder A',
        color: 'blue',
        data: ['char-b'],
        askBeforeOpening: true,
      },
    ])
  })

  it('preserves a stored character TTS key when a sibling patch carries the mask', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-tts',
          name: 'TTS Character',
          oaiTTSConfig: {
            enabled: true,
            apiKey: 'stored-tts-secret',
            voice: 'alloy',
            model: 'tts-1',
            format: 'mp3',
          },
        },
      ],
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-tts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          oaiTTSConfig: {
            enabled: true,
            apiKey: MASKED_PROVIDER_SECRET,
            voice: 'nova',
            model: 'tts-1-hd',
            format: 'opus',
          },
        },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(readJsonRow('characters', 'char-tts').oaiTTSConfig).toEqual({
      enabled: true,
      apiKey: 'stored-tts-secret',
      voice: 'nova',
      model: 'tts-1-hd',
      format: 'opus',
    })
  })

  it('persists the character lore settings deletion sentinel as a removed field', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-lore-settings',
          name: 'Lore Character',
          loreSettings: {
            scanDepth: 4,
            tokenBudget: 800,
            recursiveScanning: true,
          },
        },
      ],
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-lore-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { loreSettings: null },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(readJsonRow('characters', 'char-lore-settings')).not.toHaveProperty('loreSettings')
  })

  it('creates and selects a character in one command', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [],
          chatFolders: [],
        },
      ],
      characterOrder: ['char-a'],
    })

    const createdAndSelected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/create-and-select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          chats: [],
          chatFolders: [],
        },
        initialChat: {
          id: 'chat-b-initial',
          name: 'Chat 1',
          note: '',
          message: [],
          localLore: [],
        },
        lastInteraction: 9876,
      },
    })

    expect(createdAndSelected.statusCode).toBe(200)
    expect(createdAndSelected.json()).toEqual({
      revision: revision + 1,
      event: {
        type: 'character.createdAndSelected',
        revision: revision + 1,
        resource: 'character',
        id: 'char-b',
      },
      characterId: 'char-b',
      selectedCharacterId: 'char-b',
    })
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      currentChar: 1,
      characterOrder: ['char-a', 'char-b'],
    })
    expect(
      ((loadPersistedFromDir(harness.dataDir).database as any).characters as Array<Record<string, unknown>>).find(
        (character) => character.chaId === 'char-b',
      ),
    ).toMatchObject({
      name: 'B',
      lastInteraction: 9876,
      chatPage: 0,
      chats: [
        {
          id: 'chat-b-initial',
          name: 'Chat 1',
          note: '',
          localLore: [],
        },
      ],
    })
  })

  it('rejects malformed character commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [],
          chatFolders: [],
          trashTime: undefined,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [],
          chatFolders: [],
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const update = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { chats: [] },
      },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().error).toBe('patch.chats is owned by a later command slice')

    const invalidDisplayName = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { displayName: 123 },
      },
    })
    expect(invalidDisplayName.statusCode).toBe(400)
    expect(invalidDisplayName.json().error).toBe('patch.displayName must be a string')

    const reorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        characterOrder: ['char-a', 'char-a'],
      },
    })
    expect(reorder.statusCode).toBe(400)
    expect(reorder.json().error).toBe('Duplicate character id in characterOrder: char-a')

    const invalidFolderOpeningPreference = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        characterOrder: [
          {
            id: 'folder-a',
            name: 'Folder A',
            color: 'blue',
            data: ['char-a'],
            askBeforeOpening: 'yes',
          },
          'char-b',
        ],
      },
    })
    expect(invalidFolderOpeningPreference.statusCode).toBe(400)
    expect(invalidFolderOpeningPreference.json().error).toBe('characterOrder[0].askBeforeOpening must be a boolean')

    const embeddedChatCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-c',
          name: 'C',
          chats: [
            {
              id: 'chat-c',
              name: 'C chat',
              message: [{ chatId: 'msg-c', role: 'user', data: 'embedded transcript' }],
            },
          ],
        },
      },
    })
    expect(embeddedChatCreate.statusCode).toBe(400)
    expect(embeddedChatCreate.json().error).toBe('character.chats must be empty; create chats with chat commands')

    const embeddedHypaCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/create-and-select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-c',
          name: 'C',
          chats: [
            {
              id: 'chat-c',
              name: 'C chat',
              hypaV3Data: { version: 3, summaries: [] },
            },
          ],
        },
      },
    })
    expect(embeddedHypaCreate.statusCode).toBe(400)
    expect(embeddedHypaCreate.json().error).toBe('character.chats must be empty; create chats with chat commands')

    const initialChatWithTranscript = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/create-and-select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-c',
          name: 'C',
        },
        initialChat: {
          id: 'chat-c',
          name: 'Chat 1',
          message: [{ chatId: 'message-c', role: 'user', data: 'not message-free' }],
        },
      },
    })
    expect(initialChatWithTranscript.statusCode).toBe(400)
    expect(initialChatWithTranscript.json().error).toBe(
      'initialChat.message must be empty; create transcript messages with message commands',
    )

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characterOrder).toEqual(['char-a', 'char-b'])
  })

  it('returns 404 and 409 for missing characters and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Character not found: missing')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        characterId: 'char-a',
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('chat record and folder commands', () => {
  it('creates, updates, forks, reorders, and deletes chats and chat folders by id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-c',
          name: 'C chat',
          note: '',
          message: [{ role: 'user', data: 'created hello', chatId: 'msg-created' }],
          localLore: [],
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'chat.created',
        revision: 2,
        resource: 'chatTranscript',
        id: 'chat-c',
        parentId: 'char-a',
      },
      chatId: 'chat-c',
      selectedChatId: 'chat-c',
      generationSettings: null,
    })
    await expect(persistedChatMessages(harness.app, assertion, 'chat-c')).resolves.toEqual([
      { role: 'user', data: 'created hello', chatId: 'msg-created' },
    ])
    const createdBootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const createdCharacter = createdBootstrap.resourceDatabase.characters[0]
    expect(createdCharacter.chatPage).toBe(0)
    expect(createdCharacter.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-c', 'chat-a', 'chat-b'])

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-c',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'C renamed',
          note: 'Author note',
          bookmarks: ['msg-a'],
          bookmarkNames: { 'msg-a': 'Pinned' },
          pinned: true,
        },
        select: true,
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      revision: 3,
      event: {
        type: 'chat.updated',
        // Chat metadata lives in one character row, so a foreign refresh ships
        // just the containing character (per-character `characterRow` branch).
        resource: 'characterRow',
        id: 'chat-c',
        parentId: 'char-a',
      },
      chatId: 'chat-c',
      selectedChatId: 'chat-c',
    })

    const forked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        sourcePatch: { folderId: 'folder-a' },
        chat: {
          id: 'chat-fork',
          name: 'A branch',
          note: '',
          message: [{ role: 'char', data: 'branch marker', chatId: 'msg-branch' }],
          localLore: [],
          folderId: 'folder-a',
        },
      },
    })
    expect(forked.statusCode).toBe(200)
    expect(forked.json()).toMatchObject({
      revision: 4,
      event: {
        type: 'chat.forked',
        resource: 'chatTranscript',
        id: 'chat-fork',
        parentId: 'char-a',
      },
      chatId: 'chat-fork',
      sourceChatId: 'chat-a',
      selectedChatId: 'chat-fork',
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: forked.json().revision,
        chatIds: ['chat-a', 'chat-fork', 'chat-c', 'chat-b'],
        folderByChatId: {
          'chat-a': 'folder-a',
          'chat-fork': 'folder-a',
          'chat-c': null,
          'chat-b': 'folder-a',
        },
        selectedChatId: 'chat-c',
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'chat.reordered',
        resource: 'characterRow',
        parentId: 'char-a',
      },
      selectedChatId: 'chat-c',
    })

    const folderCreated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chat-folders',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
        folder: { id: 'folder-b', name: 'Folder B', color: 'blue', folded: false },
      },
    })
    expect(folderCreated.statusCode).toBe(200)
    expect(folderCreated.json().event).toMatchObject({
      type: 'chatFolder.created',
      resource: 'characterRow',
      id: 'folder-b',
      parentId: 'char-a',
    })
    const folderUpdated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chat-folders/folder-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: folderCreated.json().revision,
        patch: { name: 'Folder B renamed', folded: true },
      },
    })
    expect(folderUpdated.statusCode).toBe(200)
    expect(folderUpdated.json().event).toMatchObject({
      type: 'chatFolder.updated',
      resource: 'characterRow',
      id: 'folder-b',
      parentId: 'char-a',
    })

    const foldersReordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chat-folders/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: folderUpdated.json().revision,
        folderIds: ['folder-a', 'folder-b'],
        selectedChatId: 'chat-c',
      },
    })
    expect(foldersReordered.statusCode).toBe(200)
    expect(foldersReordered.json().event).toMatchObject({
      type: 'chatFolder.reordered',
      resource: 'characterRow',
      parentId: 'char-a',
    })

    const folderDeleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chat-folders/folder-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: foldersReordered.json().revision },
    })
    expect(folderDeleted.statusCode).toBe(200)
    expect(folderDeleted.json().event).toMatchObject({
      type: 'chatFolder.deleted',
      resource: 'characterRow',
      id: 'folder-a',
      parentId: 'char-a',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chats/chat-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: folderDeleted.json().revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 10,
      event: {
        type: 'chat.deleted',
        resource: 'characterRow',
        id: 'chat-b',
        parentId: 'char-a',
      },
      chatId: 'chat-b',
      selectedChatId: 'chat-c',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const character = bootstrap.resourceDatabase.characters[0]
    expect(character.chatPage).toBe(2)
    expect(character.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-a', 'chat-fork', 'chat-c'])
    expect(character.chats.map((chat: { folderId?: string | null }) => chat.folderId ?? null)).toEqual([
      null,
      null,
      null,
    ])
    expect(character.chatFolders).toEqual([{ id: 'folder-b', name: 'Folder B renamed', color: 'blue', folded: true }])
    expect(character.chats[2]).toMatchObject({
      id: 'chat-c',
      name: 'C renamed',
      note: 'Author note',
      bookmarks: ['msg-a'],
      bookmarkNames: { 'msg-a': 'Pinned' },
      pinned: true,
    })
  })

  it('atomically replaces every character chat with one empty Chat 1', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'old a', chatId: 'message-a' }],
              localLore: [],
              hypaV3Data: { version: 3, summaries: [{ text: 'old memory', start: 0, end: 1 }] },
            },
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [{ role: 'char', data: 'old b', chatId: 'message-b' }],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
          chatPage: 1,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [{ id: 'chat-other', name: 'Other', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const reset = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-new',
          name: 'Chat 1',
          note: '',
          message: [],
          localLore: [],
          fmIndex: -1,
        },
      },
    })

    expect(reset.statusCode).toBe(200)
    expect(reset.json()).toMatchObject({
      revision: revision + 1,
      event: {
        type: 'chats.reset',
        resource: 'characterRow',
        id: 'chat-new',
        parentId: 'char-a',
      },
      chatId: 'chat-new',
      selectedChatId: 'chat-new',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const [characterA, characterB] = bootstrap.resourceDatabase.characters
    expect(characterA).toMatchObject({
      chaId: 'char-a',
      chatPage: 0,
      chats: [{ id: 'chat-new', name: 'Chat 1', note: '', localLore: [], fmIndex: -1 }],
      chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
    })
    expect(characterA.chats[0].message).toEqual([])
    expect(characterB.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-other'])

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(db.prepare("SELECT id FROM chats WHERE character_id = 'char-a' ORDER BY position").all()).toEqual([
        { id: 'chat-new' },
      ])
      expect(db.prepare("SELECT uid FROM messages WHERE chat_id IN ('chat-a', 'chat-b') ORDER BY uid").all()).toEqual(
        [],
      )
      expect(
        db.prepare("SELECT chat_id FROM chat_hypa_v3 WHERE chat_id IN ('chat-a', 'chat-b') ORDER BY chat_id").all(),
      ).toEqual([])
    } finally {
      db.close()
    }
  })

  it('preserves omitted folder assignments in sparse chat reorder patches', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-b',
            },
            { id: 'chat-c', name: 'C chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [
            { id: 'folder-a', name: 'Folder A', folded: false },
            { id: 'folder-b', name: 'Folder B', folded: false },
          ],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const pureReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chatIds: ['chat-c', 'chat-b', 'chat-a'],
        selectedChatId: 'chat-a',
      },
    })
    expect(pureReorder.statusCode).toBe(200)

    const afterPureReorder = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(
      afterPureReorder.resourceDatabase.characters[0].chats.map((chat: { id: string; folderId?: string | null }) => [
        chat.id,
        chat.folderId ?? null,
      ]),
    ).toEqual([
      ['chat-c', null],
      ['chat-b', 'folder-b'],
      ['chat-a', 'folder-a'],
    ])

    const sparseReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: pureReorder.json().revision,
        chatIds: ['chat-a', 'chat-c', 'chat-b'],
        folderByChatId: { 'chat-b': null },
        selectedChatId: 'chat-a',
      },
    })
    expect(sparseReorder.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(
      bootstrap.resourceDatabase.characters[0].chats.map((chat: { id: string; folderId?: string | null }) => [
        chat.id,
        chat.folderId ?? null,
      ]),
    ).toEqual([
      ['chat-a', 'folder-a'],
      ['chat-c', null],
      ['chat-b', null],
    ])
  })

  it('creates a chat at the head while select:false preserves the selected chat', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            { id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [],
          chatPage: 1,
        },
      ],
      characterOrder: ['char-a'],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        select: false,
        chat: {
          id: 'chat-c',
          name: 'C chat',
          note: '',
          message: [
            { role: 'user', data: 'first', chatId: 'msg-c-1' },
            { role: 'char', data: 'second', chatId: 'msg-c-2' },
          ],
          localLore: [],
        },
      },
    })

    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: 2,
      chatId: 'chat-c',
      selectedChatId: 'chat-b',
      event: {
        type: 'chat.created',
        resource: 'chatTranscript',
        id: 'chat-c',
        parentId: 'char-a',
      },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const character = bootstrap.resourceDatabase.characters[0]
    expect(character.chatPage).toBe(2)
    expect(character.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-c', 'chat-a', 'chat-b'])
    await expect(persistedChatMessages(harness.app, assertion, 'chat-c')).resolves.toEqual([
      { role: 'user', data: 'first', chatId: 'msg-c-1' },
      { role: 'char', data: 'second', chatId: 'msg-c-2' },
    ])
    await expect(persistedChatMessages(harness.app, assertion, 'chat-a')).resolves.toEqual([])
    await expect(persistedChatMessages(harness.app, assertion, 'chat-b')).resolves.toEqual([])
  })

  it('serves created and forked long transcripts from the chat message endpoint', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'Source', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const createdMessages = Array.from({ length: 13 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'char',
      data: `created ${index}`,
      chatId: `created-${index}`,
    }))
    const createdHypaV3Data = {
      version: 3,
      summaries: [{ text: 'created memory', start: 0, end: 4 }],
    }

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-created',
          name: 'Created',
          note: '',
          message: createdMessages,
          localLore: [],
          hypaV3Data: createdHypaV3Data,
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().event).toMatchObject({
      type: 'chat.created',
      resource: 'chatTranscript',
      id: 'chat-created',
      parentId: 'char-a',
    })
    const createdMessagesRead = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-created/messages',
      headers: { 'risu-auth': assertion },
    })
    expect(createdMessagesRead.statusCode).toBe(200)
    expect(createdMessagesRead.json()).toMatchObject({
      revision: 2,
      chatId: 'chat-created',
      message: createdMessages,
      hypaV3Data: createdHypaV3Data,
    })

    const forkedMessages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'char',
      data: `forked ${index}`,
      chatId: `forked-${index}`,
    }))
    const forkedHypaV3Data = {
      version: 3,
      summaries: [{ text: 'forked memory', start: 2, end: 8 }],
    }
    const forked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        chat: {
          id: 'chat-forked',
          name: 'Forked',
          note: '',
          message: forkedMessages,
          localLore: [],
          hypaV3Data: forkedHypaV3Data,
        },
      },
    })
    expect(forked.statusCode).toBe(200)
    expect(forked.json().event).toMatchObject({
      type: 'chat.forked',
      resource: 'chatTranscript',
      id: 'chat-forked',
      parentId: 'char-a',
    })
    const forkedMessagesRead = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-forked/messages',
      headers: { 'risu-auth': assertion },
    })
    expect(forkedMessagesRead.statusCode).toBe(200)
    expect(forkedMessagesRead.json()).toMatchObject({
      revision: 3,
      chatId: 'chat-forked',
      message: forkedMessages,
      hypaV3Data: forkedHypaV3Data,
    })
  })

  it('keeps native create chats incomplete by default and persists explicit generation settings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', customPromptTemplateToggle: 'mode=Mode' }],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const omitted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-omitted',
          name: 'Omitted settings',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(omitted.statusCode).toBe(200)
    expect(omitted.json().event).toMatchObject({
      type: 'chat.created',
      resource: 'characterRow',
      id: 'chat-omitted',
      parentId: 'char-a',
    })
    expect(omitted.json().generationSettings).toBeNull()

    const explicitSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
      sidebarToggles: { mode: '1' },
    }
    const explicit = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: omitted.json().revision,
        chat: {
          id: 'chat-explicit',
          name: 'Explicit settings',
          note: '',
          message: [],
          localLore: [],
          generationSettings: explicitSettings,
        },
      },
    })
    expect(explicit.statusCode).toBe(200)
    expect(explicit.json().generationSettings).toEqual(explicitSettings)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      id: string
      generationSettings?: Record<string, unknown>
    }>
    expect(chats.find((chat) => chat.id === 'chat-omitted')?.generationSettings).toBeUndefined()
    expect(chats.find((chat) => chat.id === 'chat-explicit')?.generationSettings).toEqual(explicitSettings)
  })

  it('updates chat metadata without rewriting message rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'hello', chatId: 'msg-a' },
                { role: 'char', data: 'hi', chatId: 'msg-b' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const beforeRows = activeMessageRowids(harness.dataDir, 'chat-a')
    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          name: 'A renamed',
          note: 'metadata only',
          autoTranslate: true,
          autoTranslateBotOnly: true,
          translatorPresetId: 'translator-preset-a',
          bilingualDisplay: true,
          bilingualEmphasis: 'translation',
          bookmarks: ['msg-a'],
          bookmarkNames: { 'msg-a': 'Pinned' },
        },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
      selectedChatId: 'chat-a',
    })
    expect(activeMessageRowids(harness.dataDir, 'chat-a')).toEqual(beforeRows)
    await expect(persistedChatMessages(harness.app, assertion, 'chat-a')).resolves.toEqual([
      { role: 'user', data: 'hello', chatId: 'msg-a' },
      { role: 'char', data: 'hi', chatId: 'msg-b' },
    ])

    const persisted = loadPersistedFromDir(harness.dataDir) as {
      database: { characters: Array<{ chats: Array<Record<string, unknown>> }> }
    }
    expect(persisted.database.characters[0].chats[0]).toMatchObject({
      id: 'chat-a',
      name: 'A renamed',
      note: 'metadata only',
      autoTranslate: true,
      autoTranslateBotOnly: true,
      translatorPresetId: 'translator-preset-a',
      bilingualDisplay: true,
      bilingualEmphasis: 'translation',
      bookmarks: ['msg-a'],
      bookmarkNames: { 'msg-a': 'Pinned' },
    })
  })

  it('validates and persists sparse bilingual emphasis chat patches', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    for (const value of ['original', 'translation', null] as const) {
      const updated = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/chats/chat-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: { bilingualEmphasis: value },
        },
      })
      expect(updated.statusCode).toBe(200)
      revision = updated.json().revision

      const persisted = loadPersistedFromDir(harness.dataDir) as {
        database: { characters: Array<{ chats: Array<Record<string, unknown>> }> }
      }
      expect(persisted.database.characters[0].chats[0]).toHaveProperty('bilingualEmphasis', value)
    }

    for (const value of ['translated', 1]) {
      const rejected = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/chats/chat-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: { bilingualEmphasis: value },
        },
      })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json().error).toBe(
        "patch.bilingualEmphasis must be 'original', 'translation', null, or undefined",
      )
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
  })

  it('validates, persists, and clears stable translator preset chat bindings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const selected = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { translatorPresetId: 'translator-preset-a' } },
    })
    expect(selected.statusCode).toBe(200)
    revision = selected.json().revision
    expect((loadPersistedFromDir(harness.dataDir) as any).database.characters[0].chats[0].translatorPresetId).toBe(
      'translator-preset-a',
    )

    const cleared = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { translatorPresetId: null } },
    })
    expect(cleared.statusCode).toBe(200)
    revision = cleared.json().revision
    expect((loadPersistedFromDir(harness.dataDir) as any).database.characters[0].chats[0]).not.toHaveProperty(
      'translatorPresetId',
    )

    for (const value of ['', 1, false]) {
      const rejected = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/chats/chat-a',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch: { translatorPresetId: value } },
      })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json().error).toBe('patch.translatorPresetId must be a non-empty string, null, or undefined')
    }
  })

  it('persists chat generation settings with explicit off values and prunes stale toggles', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: ['mod-global'],
      agentPresets: [{ id: 'agent-preset-a', name: 'Agent Preset A', enabled: true, version: 1, steps: [] }],
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          jailbreak: 'jailbreak text',
          customPromptTemplateToggle: 'mode=Mode\nnotes=Notes=text',
          moduleIntergration: 'preset-space',
        },
      ],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      modules: [
        { id: 'mod-global', name: 'Global', description: '', customModuleToggle: 'global=Global' },
        {
          id: 'mod-chat',
          name: 'Chat',
          description: '',
          customModuleToggle: 'chatMode=Chat Mode=select=on,off',
        },
        {
          id: 'mod-character',
          name: 'Character',
          description: '',
          customModuleToggle: 'charText=Character Text=text',
        },
        {
          id: 'mod-integrated',
          namespace: 'preset-space',
          name: 'Integrated',
          description: '',
          customModuleToggle: 'integrated=Integrated=textarea',
        },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          modules: ['mod-character'],
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              modules: ['mod-chat'],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          modelPresetSelectionSource: 'manual',
          promptPresetId: 'prompt-a',
          agentPresetId: 'agent-preset-a',
          togglePresetId: 'deleted-toggle-preset',
          jailbreakToggle: false,
          sidebarToggles: {
            mode: '0',
            notes: '',
            global: '1',
            chatMode: 'off',
            charText: '',
            integrated: '',
            deleted: '1',
          },
        },
      },
    })

    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({
      revision: revision + 1,
      chatId: 'chat-a',
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toEqual({
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      modelPresetSelectionSource: 'manual',
      promptPresetId: 'prompt-a',
      agentPresetId: 'agent-preset-a',
      togglePresetId: 'deleted-toggle-preset',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: '0',
        notes: '',
        global: '1',
        chatMode: 'off',
        charText: '',
        integrated: '',
      },
    })
  })

  it('patches chat generation settings sparsely and returns only an exact application certificate', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [{ id: 'agent-preset-a', name: 'Agent Preset A', enabled: true, version: 1, steps: [] }],
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          customPromptTemplateToggle: 'mode=Mode\nnotes=Notes=text',
        },
        {
          id: 'prompt-b',
          name: 'Prompt B',
          customPromptTemplateToggle: 'mode=Mode',
        },
      ],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings: {
                configured: true,
                personaId: 'persona-a',
                modelPresetId: 'model-a',
                promptPresetId: 'prompt-a',
                agentPresetId: 'agent-preset-a',
                jailbreakToggle: false,
                sidebarToggles: { mode: 'warm', notes: 'keep me' },
              },
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        baseGenerationSettingsDigest: chatGenerationSettingsDigest({
          configured: false,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'prompt-a',
          agentPresetId: 'agent-preset-a',
          jailbreakToggle: false,
          sidebarToggles: { mode: 'warm', notes: 'keep me' },
        }),
        patch: {
          promptPresetId: 'prompt-b',
          sidebarToggles: { mode: 'cold', stale: '1' },
        },
        deleteKeys: ['agentPresetId'],
        sidebarToggleDeleteKeys: ['notes'],
      },
    })

    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({
      revision: revision + 1,
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        revision: revision + 1,
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
      characterId: 'char-a',
      certificate: 'chat-generation-settings-sparse-v1',
      patchedKeys: ['promptPresetId', 'sidebarToggles'],
      deletedKeys: ['agentPresetId'],
      sidebarTogglePatchedKeys: ['mode', 'stale'],
      sidebarToggleDeletedKeys: ['notes'],
      prunedSidebarToggleKeys: ['stale'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toEqual({
      configured: false,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-b',
      jailbreakToggle: false,
      sidebarToggles: { mode: 'cold' },
    })

    const staleBase = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        baseGenerationSettingsDigest: '0'.repeat(64),
        patch: { configured: true },
      },
    })
    expect(staleBase.statusCode).toBe(200)
    expect(staleBase.json()).toMatchObject({
      revision: revision + 2,
      generationSettings: {
        configured: true,
        personaId: 'persona-a',
        modelPresetId: 'model-a',
        promptPresetId: 'prompt-b',
        jailbreakToggle: false,
        sidebarToggles: { mode: 'cold' },
      },
    })
    expect(staleBase.json()).not.toHaveProperty('certificate')
  })

  it('rejects removing a still-required Persona-module toggle value without advancing revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const generationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
      sidebarToggles: { personaFlag: '1' },
    }
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
      personas: [
        {
          id: 'persona-a',
          name: 'Persona A',
          icon: '',
          personaPrompt: '',
          note: '',
          modules: ['module-persona'],
        },
      ],
      modules: [
        {
          id: 'module-persona',
          name: 'Persona module',
          description: '',
          customModuleToggle: 'personaFlag=Persona flag',
        },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings,
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const baseline = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const persistedGenerationSettings = baseline.resourceDatabase.characters[0].chats[0].generationSettings
    expect(persistedGenerationSettings.sidebarToggles).toEqual({ personaFlag: '1' })

    const sparseDelete = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        baseGenerationSettingsDigest: chatGenerationSettingsDigest(persistedGenerationSettings),
        patch: {},
        sidebarToggleDeleteKeys: ['personaFlag'],
      },
    })
    expect(sparseDelete.statusCode).toBe(400)

    const fullDelete = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: {
          ...persistedGenerationSettings,
          sidebarToggles: {},
        },
      },
    })
    expect(fullDelete.statusCode).toBe(400)

    const unchanged = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(unchanged.json().revision).toBe(revision)
    expect(unchanged.resourceDatabase.characters[0].chats[0].generationSettings).toEqual(persistedGenerationSettings)
  })

  it('rejects ambiguous sparse generation-settings updates without advancing the revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const initialSettings = {
      configured: false,
      jailbreakToggle: false,
      sidebarToggles: { mode: 'warm', notes: 'old' },
    }
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings: initialSettings,
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const invalidPayloads = [
      { generationSettings: initialSettings, patch: { configured: false } },
      {},
      { patch: { unknown: true } },
      { patch: {}, deleteKeys: ['configured', 'configured'] },
      { patch: { configured: false }, deleteKeys: ['configured'] },
      { patch: {}, deleteKeys: ['jailbreakToggle'] },
      {
        patch: { sidebarToggles: { mode: 'cold' } },
        deleteKeys: ['sidebarToggles'],
      },
      {
        patch: { sidebarToggles: { mode: 'cold' } },
        sidebarToggleDeleteKeys: ['mode'],
      },
      { patch: { configured: false }, unexpected: true },
    ]

    for (const payload of invalidPayloads) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, ...payload },
      })
      expect(response.statusCode, JSON.stringify(response.json())).toBe(400)
    }

    const unchanged = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(unchanged.json().revision).toBe(revision)
    expect(unchanged.resourceDatabase.characters[0].chats[0].generationSettings).toEqual(initialSettings)

    const valid = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        baseGenerationSettingsDigest: chatGenerationSettingsDigest(initialSettings),
        patch: { configured: false },
      },
    })
    expect(valid.statusCode).toBe(200)
    expect(valid.json().revision).toBe(revision + 1)
  })

  it('rejects invalid chat generation settings without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
      agentPresets: [{ id: 'agent-preset-a', name: 'Agent Preset A', enabled: true, version: 1, steps: [] }],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const validBase = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      agentPresetId: 'agent-preset-a',
      jailbreakToggle: true,
      sidebarToggles: {},
    }
    const cases = [
      {
        generationSettings: { ...validBase, personaId: 'missing-persona' },
        error: 'Unknown persona id in generationSettings.personaId: missing-persona',
      },
      {
        generationSettings: { ...validBase, modelPresetId: 'missing-model-preset' },
        error: 'Unknown model preset id in generationSettings.modelPresetId: missing-model-preset',
      },
      {
        generationSettings: { ...validBase, modelPresetSelectionSource: 'automatic' },
        error: 'generationSettings.modelPresetSelectionSource must be manual or prompt-recommendation',
      },
      {
        generationSettings: { ...validBase, promptPresetId: 'missing-prompt-preset' },
        error: 'Unknown prompt preset id in generationSettings.promptPresetId: missing-prompt-preset',
      },
      {
        generationSettings: { ...validBase, agentPresetId: 'missing-agent-preset' },
        error: 'Unknown agent preset id in generationSettings.agentPresetId: missing-agent-preset',
      },
      {
        generationSettings: { ...validBase, agentPresetId: 123 },
        error: 'generationSettings.agentPresetId must be a string',
      },
      {
        generationSettings: { ...validBase, togglePresetId: 123 },
        error: 'generationSettings.togglePresetId must be a string',
      },
      {
        generationSettings: { ...validBase, sidebarToggles: { mode: 1 } },
        error: 'generationSettings.sidebarToggles.mode must be a string',
      },
      {
        generationSettings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'prompt-a',
          sidebarToggles: {},
        },
        error: 'generationSettings.jailbreakToggle must be present',
      },
    ]

    for (const testCase of cases) {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          generationSettings: testCase.generationSettings,
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(testCase.error)
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toBeUndefined()
  })

  it('rejects generic chat patches that include generation settings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'Preset A' }],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const patch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          generationSettings: {
            configured: true,
            personaId: 'persona-a',
            presetId: 'preset-a',
            jailbreakToggle: false,
            sidebarToggles: {},
          },
        },
      },
    })

    expect(patch.statusCode).toBe(400)
    expect(patch.json().error).toBe('patch.generationSettings is owned by a later command slice')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toBeUndefined()
  })

  it('returns malformed stored chat generation settings without repairing persisted rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            { id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    writeJsonRow('chats', 'chat-a', {
      ...readJsonRow('chats', 'chat-a'),
      generationSettings: {
        configured: true,
        personaId: 123,
        modelPresetId: 'model-a',
        promptPresetId: 'prompt-a',
        togglePresetId: 'missing-is-valid',
        jailbreakToggle: 'bad',
        sidebarToggles: {
          valid: 'on',
          invalid: 1,
          '': 'blank-key',
        },
        unsupported: 'drop-me',
      },
    })
    writeJsonRow('chats', 'chat-b', {
      ...readJsonRow('chats', 'chat-b'),
      generationSettings: {
        personaId: 123,
        jailbreakToggle: 'bad',
        sidebarToggles: { invalid: false },
        unsupported: 'drop-me',
      },
    })
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })

    expect(bootstrap.statusCode).toBe(200)
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      generationSettings?: Record<string, unknown>
    }>
    expect(chats[0].generationSettings).toEqual({
      configured: true,
      personaId: 123,
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      togglePresetId: 'missing-is-valid',
      jailbreakToggle: 'bad',
      sidebarToggles: { valid: 'on', invalid: 1, '': 'blank-key' },
      unsupported: 'drop-me',
    })
    expect(Object.keys(chats[0].generationSettings ?? {}).sort()).toEqual([
      'configured',
      'jailbreakToggle',
      'modelPresetId',
      'personaId',
      'promptPresetId',
      'sidebarToggles',
      'togglePresetId',
      'unsupported',
    ])
    expect(chats[1].generationSettings).toEqual({
      personaId: 123,
      jailbreakToggle: 'bad',
      sidebarToggles: { invalid: false },
      unsupported: 'drop-me',
    })
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('leaves chat generation settings unchanged when global persona and preset selections move', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [
        { id: 'prompt-a', name: 'Prompt A', mainPrompt: 'a' },
        { id: 'prompt-b', name: 'Prompt B', mainPrompt: 'b' },
      ],
      promptPresetsId: 0,
      personas: [
        { id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: 'a', note: '' },
        { id: 'persona-b', name: 'Persona B', icon: '', personaPrompt: 'b', note: '' },
      ],
      selectedPersona: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const chatGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
      sidebarToggles: {},
    }

    const savedSettings = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: chatGenerationSettings,
      },
    })
    expect(savedSettings.statusCode).toBe(200)
    expect(savedSettings.json()).toMatchObject({
      chatId: 'chat-a',
      characterId: 'char-a',
      generationSettings: chatGenerationSettings,
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
    })

    const persona = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: savedSettings.json().revision, personaId: 'persona-b' },
    })
    expect(persona.statusCode).toBe(200)

    const preset = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-presets/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: persona.json().revision, promptPresetId: 'prompt-b' },
    })
    expect(preset.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toEqual(chatGenerationSettings)
  })

  it('inherits complete and incomplete source generation settings on fork unless the fork supplies an explicit override', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          customPromptTemplateToggle: 'mode=Mode',
        },
        {
          id: 'prompt-b',
          name: 'Prompt B',
          customPromptTemplateToggle: 'tone=Tone',
        },
      ],
      personas: [
        { id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' },
        { id: 'persona-b', name: 'Persona B', icon: '', personaPrompt: '', note: '' },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            {
              id: 'chat-incomplete-source',
              name: 'Incomplete source',
              note: '',
              message: [],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const sourceSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
      sidebarToggles: { mode: 'source' },
    }
    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: sourceSettings,
      },
    })
    expect(saved.statusCode).toBe(200)

    const inherited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: saved.json().revision,
        chat: {
          id: 'chat-inherited',
          name: 'Inherited fork',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(inherited.statusCode).toBe(200)
    expect(inherited.json().generationSettings).toEqual(sourceSettings)

    const overrideSettings = {
      configured: true,
      personaId: 'persona-b',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-b',
      jailbreakToggle: true,
      sidebarToggles: { tone: 'warm' },
    }
    const overridden = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: inherited.json().revision,
        chat: {
          id: 'chat-overridden',
          name: 'Overridden fork',
          note: '',
          message: [],
          localLore: [],
          generationSettings: overrideSettings,
        },
      },
    })
    expect(overridden.statusCode).toBe(200)
    expect(overridden.json().generationSettings).toEqual(overrideSettings)

    const incompleteSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
    }
    const savedIncomplete = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-incomplete-source/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: overridden.json().revision,
        generationSettings: incompleteSettings,
      },
    })
    expect(savedIncomplete.statusCode).toBe(200)

    const incompleteInherited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-incomplete-source/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: savedIncomplete.json().revision,
        chat: {
          id: 'chat-incomplete-fork',
          name: 'Incomplete fork',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(incompleteInherited.statusCode).toBe(200)
    expect(incompleteInherited.json().generationSettings).toEqual(incompleteSettings)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      id: string
      generationSettings?: Record<string, unknown>
    }>
    const sourceChat = chats.find((chat) => chat.id === 'chat-a')
    const inheritedChat = chats.find((chat) => chat.id === 'chat-inherited')
    const overriddenChat = chats.find((chat) => chat.id === 'chat-overridden')
    const incompleteSourceChat = chats.find((chat) => chat.id === 'chat-incomplete-source')
    const incompleteForkChat = chats.find((chat) => chat.id === 'chat-incomplete-fork')

    expect(sourceChat?.generationSettings).toEqual(sourceSettings)
    expect(inheritedChat?.generationSettings).toEqual(sourceSettings)
    expect(inheritedChat?.generationSettings).not.toBe(sourceChat?.generationSettings)
    expect(overriddenChat?.generationSettings).toEqual(overrideSettings)
    expect(incompleteSourceChat?.generationSettings).toEqual(incompleteSettings)
    expect(incompleteForkChat?.generationSettings).toEqual(incompleteSettings)
    expect(incompleteForkChat?.generationSettings).not.toBe(incompleteSourceChat?.generationSettings)
  })

  it('rejects chat fork commands without client-supplied fork ids without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            { id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const omittedChat = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
      },
    })
    expect(omittedChat.statusCode).toBe(400)
    expect(omittedChat.json().error).toBe('chat must be an object')

    const missingChatId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          name: 'Fork without id',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(missingChatId.statusCode).toBe(400)
    expect(missingChatId.json().error).toBe('chat.id must be a non-empty string')

    const duplicateChatId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-b',
          name: 'Duplicate fork',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(duplicateChatId.statusCode).toBe(400)
    expect(duplicateChatId.json().error).toBe('Duplicate chat id: chat-b')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.characters[0].chats.map((chat: { id: string }) => chat.id)).toEqual([
      'chat-a',
      'chat-b',
    ])
  })

  it('repairs imported duplicate chat ids across characters', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-shared', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [{ id: 'chat-shared', name: 'B chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    const [charA, charB] = bootstrap.resourceDatabase.characters
    expect(charA.chats[0].id).toBe('chat-shared')
    expect(charB.chats[0].id).not.toBe('chat-shared')
    expect(typeof charB.chats[0].id).toBe('string')
  })

  it('rejects command-created chat ids and message ids already used by another character', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [{ id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const duplicateCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-b/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: { id: 'chat-a', name: 'Duplicate', note: '', message: [], localLore: [] },
      },
    })
    expect(duplicateCreate.statusCode).toBe(400)
    expect(duplicateCreate.json().error).toBe('Duplicate chat id: chat-a')

    const duplicateFork = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: { id: 'chat-a', name: 'Duplicate fork', note: '', message: [], localLore: [] },
      },
    })
    expect(duplicateFork.statusCode).toBe(400)
    expect(duplicateFork.json().error).toBe('Duplicate chat id: chat-a')

    const duplicateCreateMessage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-b/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-c',
          name: 'Message duplicate',
          note: '',
          message: [{ role: 'char', data: 'duplicate', chatId: 'msg-a' }],
          localLore: [],
        },
      },
    })
    expect(duplicateCreateMessage.statusCode).toBe(400)
    expect(duplicateCreateMessage.json().error).toBe('Duplicate message id: msg-a')

    const duplicateForkMessage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-fork',
          name: 'Message duplicate fork',
          note: '',
          message: [{ role: 'char', data: 'duplicate', chatId: 'msg-a' }],
          localLore: [],
        },
      },
    })
    expect(duplicateForkMessage.statusCode).toBe(400)
    expect(duplicateForkMessage.json().error).toBe('Duplicate message id: msg-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(
      bootstrap.resourceDatabase.characters.map((character: { chats: { id: string }[] }) =>
        character.chats.map((chat) => chat.id),
      ),
    ).toEqual([['chat-a'], ['chat-b']])
  })

  it('rejects command-created chat folder ids that already exist on another character', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-b',
            },
          ],
          chatFolders: [{ id: 'folder-b', name: 'Folder B', folded: false }],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const duplicateFolderCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-b/chat-folders',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        folder: { id: 'folder-a', name: 'Duplicate Folder A', folded: false },
      },
    })
    expect(duplicateFolderCreate.statusCode).toBe(400)
    expect(duplicateFolderCreate.json().error).toBe('Duplicate chat folder id: folder-a')

    const duplicateForkFolder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-fork',
          name: 'Fork',
          note: '',
          message: [],
          localLore: [],
        },
        folder: { id: 'folder-a', name: 'Duplicate Fork Folder', folded: false },
      },
    })
    expect(duplicateForkFolder.statusCode).toBe(400)
    expect(duplicateForkFolder.json().error).toBe('Duplicate chat folder id: folder-a')

    const folderUpdated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chat-folders/folder-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Folder B renamed' },
      },
    })
    expect(folderUpdated.statusCode).toBe(200)

    const folderDeleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chat-folders/folder-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: folderUpdated.json().revision },
    })
    expect(folderDeleted.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const characters = bootstrap.resourceDatabase.characters
    expect(characters[0].chatFolders).toEqual([])
    expect(characters[0].chats[0].folderId).toBeNull()
    expect(characters[1].chatFolders).toEqual([{ id: 'folder-b', name: 'Folder B renamed', folded: false }])
    expect(characters[1].chats[0].folderId).toBe('folder-b')
  })

  it('repairs imported duplicate chat folder ids across characters', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder B', folded: false }],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    const [charA, charB] = bootstrap.resourceDatabase.characters
    expect(charA.chatFolders[0].id).toBe('folder-a')
    expect(charA.chats[0].folderId).toBe('folder-a')
    expect(charB.chatFolders[0].id).not.toBe('folder-a')
    expect(typeof charB.chatFolders[0].id).toBe('string')
    expect(charB.chats[0].folderId).toBe(charB.chatFolders[0].id)
  })

  it('rejects chat module links to missing and MCP modules without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modules: [
        { id: 'mod-a', name: 'A', description: '' },
        { id: 'mcp-a', name: 'MCP', description: '', mcp: { url: 'internal:risuai' } },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              modules: ['mod-a'],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missingCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-missing',
          name: 'Missing module chat',
          note: '',
          message: [],
          localLore: [],
          modules: ['missing-module'],
        },
      },
    })
    expect(missingCreate.statusCode).toBe(400)
    expect(missingCreate.json().error).toBe('Unknown module id in chat.modules: missing-module')

    const mcpPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { modules: ['mcp-a'] },
      },
    })
    expect(mcpPatch.statusCode).toBe(400)
    expect(mcpPatch.json().error).toBe('Unknown module id in patch.modules: mcp-a')

    const mcpForkSource = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        sourcePatch: { modules: ['mcp-a'] },
        chat: {
          id: 'chat-fork',
          name: 'Fork',
          note: '',
          message: [],
          localLore: [],
          modules: ['mod-a'],
        },
      },
    })
    expect(mcpForkSource.statusCode).toBe(400)
    expect(mcpForkSource.json().error).toBe('Unknown module id in sourcePatch.modules: mcp-a')

    const missingForkChat = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-fork',
          name: 'Fork',
          note: '',
          message: [],
          localLore: [],
          modules: ['missing-module'],
        },
      },
    })
    expect(missingForkChat.statusCode).toBe(400)
    expect(missingForkChat.json().error).toBe('Unknown module id in chat.modules: missing-module')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats).toMatchObject([
      {
        id: 'chat-a',
        name: 'A chat',
        note: '',
        message: [],
        localLore: [],
        modules: ['mod-a'],
      },
    ])
  })

  it('rejects malformed chat commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            { id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const patch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { message: [] },
      },
    })
    expect(patch.statusCode).toBe(400)
    expect(patch.json().error).toBe('patch.message is owned by a later command slice')

    const reorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chatIds: ['chat-a', 'chat-a'],
      },
    })
    expect(reorder.statusCode).toBe(400)
    expect(reorder.json().error).toBe('Duplicate chat id in chatIds: chat-a')

    const folder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chatIds: ['chat-a', 'chat-b'],
        folderByChatId: { 'chat-a': 'missing-folder' },
      },
    })
    expect(folder.statusCode).toBe(400)
    expect(folder.json().error).toBe('Unknown chat folder id in folderByChatId: missing-folder')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats.map((chat: { id: string }) => chat.id)).toEqual([
      'chat-a',
      'chat-b',
    ])
  })

  it('returns 404 and 409 for missing chats and stale chat revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Chat not found: missing')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        patch: { name: 'Stale' },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('surgical message writes', () => {
  function messageRowids(dataDir: string, chatId: string): { seq: number; rowid: number }[] {
    const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
    try {
      return db.prepare('SELECT rowid, seq FROM messages WHERE chat_id = ? ORDER BY seq').all(chatId) as {
        seq: number
        rowid: number
      }[]
    } finally {
      db.close()
    }
  }

  async function seedTwoChats(assertion: string): Promise<number> {
    return importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A',
              note: '',
              localLore: [],
              message: [{ role: 'user', data: 'a1', chatId: 'a1' }],
            },
            {
              id: 'chat-b',
              name: 'B',
              note: '',
              localLore: [],
              message: [{ role: 'user', data: 'b1', chatId: 'b1' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
  }

  it('appends one row to the target chat without rewriting an unrelated chat', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedTwoChats(assertion)
    const chatBBefore = messageRowids(harness.dataDir, 'chat-b')
    const chatABefore = messageRowids(harness.dataDir, 'chat-a')

    const appended = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, message: { role: 'char', data: 'a2', chatId: 'a2' } },
    })
    expect(appended.statusCode).toBe(200)

    // chat-b is physically untouched (same rowids); chat-a kept its existing
    // row and gained exactly one (no whole-chat rewrite).
    expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
    const chatAAfter = messageRowids(harness.dataDir, 'chat-a')
    expect(chatAAfter.slice(0, chatABefore.length)).toEqual(chatABefore)
    expect(chatAAfter).toHaveLength(chatABefore.length + 1)
  })

  it('conditionally finalizes a generated message only while its owner, generation, and text still match', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A',
              note: '',
              localLore: [],
              message: [
                {
                  role: 'char',
                  data: '<ImgGen="cat">',
                  chatId: 'message-a',
                  generationInfo: { generationId: 'generation-a' },
                },
              ],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const wrongCondition = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/message-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { data: '{{inlay::asset-a}}' },
        expectedData: 'different source',
        expectedChatId: 'chat-a',
        expectedGenerationId: 'generation-a',
      },
    })
    expect(wrongCondition.statusCode).toBe(400)

    const finalized = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/message-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { data: '{{inlay::asset-a}}' },
        expectedData: '<ImgGen="cat">',
        expectedChatId: 'chat-a',
        expectedGenerationId: 'generation-a',
      },
    })
    expect(finalized.statusCode).toBe(200)

    const staleFinalization = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/message-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: finalized.json().revision,
        patch: { data: '{{inlay::asset-stale}}' },
        expectedData: '<ImgGen="cat">',
        expectedChatId: 'chat-a',
        expectedGenerationId: 'generation-a',
      },
    })
    expect(staleFinalization.statusCode).toBe(400)
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a'))[0].data).toBe('{{inlay::asset-a}}')
  })

  it('updates, deletes, truncates, and replaces target chat rows without touching unrelated chats', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A',
              note: '',
              localLore: [],
              bookmarks: ['msg-a1', 'msg-a2', 'msg-a3'],
              bookmarkNames: { 'msg-a1': 'One', 'msg-a2': 'Two', 'msg-a3': 'Three' },
              message: [
                { role: 'user', data: 'a1', chatId: 'msg-a1' },
                { role: 'char', data: 'a2', chatId: 'msg-a2' },
                { role: 'user', data: 'a3', chatId: 'msg-a3' },
              ],
            },
            {
              id: 'chat-b',
              name: 'B',
              note: '',
              localLore: [],
              message: [
                { role: 'user', data: 'b1', chatId: 'msg-b1' },
                { role: 'char', data: 'b2', chatId: 'msg-b2' },
              ],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const chatBBefore = messageRowids(harness.dataDir, 'chat-b')
    const chatABefore = messageRowids(harness.dataDir, 'chat-a')

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a2',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { data: 'a2 updated', disabled: true } },
    })
    expect(updated.statusCode).toBe(200)
    revision = updated.json().revision
    expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
    expect(messageRowids(harness.dataDir, 'chat-a')).toEqual(chatABefore)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/messages/msg-a2',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(deleted.statusCode).toBe(200)
    revision = deleted.json().revision
    expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
    const afterDelete = messageRowids(harness.dataDir, 'chat-a')
    expect(afterDelete).toHaveLength(2)
    expect(afterDelete[0]).toEqual(chatABefore[0])
    expect(afterDelete.map((row) => row.seq)).toEqual([0, 1])
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).map((m) => m.chatId)).toEqual([
      'msg-a1',
      'msg-a3',
    ])
    expect(readJsonRow('chats', 'chat-a')).toMatchObject({
      bookmarks: ['msg-a1', 'msg-a3'],
      bookmarkNames: { 'msg-a1': 'One', 'msg-a3': 'Three' },
    })

    const appended = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        message: { role: 'char', data: 'a4', chatId: 'msg-a4' },
      },
    })
    expect(appended.statusCode).toBe(200)
    revision = appended.json().revision

    const beforeTruncate = messageRowids(harness.dataDir, 'chat-a')
    const truncated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, afterMessageId: 'msg-a1' },
    })
    expect(truncated.statusCode).toBe(200)
    revision = truncated.json().revision
    expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
    const afterTruncate = messageRowids(harness.dataDir, 'chat-a')
    expect(afterTruncate).toEqual([beforeTruncate[0]])
    expect(readJsonRow('chats', 'chat-a')).toMatchObject({
      bookmarks: ['msg-a1'],
      bookmarkNames: { 'msg-a1': 'One' },
    })

    const replaced = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        messages: [
          { role: 'user', data: 'a1', chatId: 'msg-a1' },
          { role: 'char', data: 'a5', chatId: 'msg-a5' },
          { role: 'user', data: 'a6', chatId: 'msg-a6' },
        ],
      },
    })
    expect(replaced.statusCode).toBe(200)
    expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
    const afterReplace = messageRowids(harness.dataDir, 'chat-a')
    expect(afterReplace).toHaveLength(3)
    expect(afterReplace[0]).toEqual(afterTruncate[0])
    expect(afterReplace.map((row) => row.seq)).toEqual([0, 1, 2])
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).map((m) => m.chatId)).toEqual([
      'msg-a1',
      'msg-a5',
      'msg-a6',
    ])
    expect(readJsonRow('chats', 'chat-a')).toMatchObject({
      bookmarks: ['msg-a1'],
      bookmarkNames: { 'msg-a1': 'One' },
    })
  })

  it('a non-message command writes nothing to the messages table', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedTwoChats(assertion)
    const before = [...messageRowids(harness.dataDir, 'chat-a'), ...messageRowids(harness.dataDir, 'chat-b')]

    const persona = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        persona: { id: 'persona-p', name: 'P', personaPrompt: 'hi', note: '' },
      },
    })
    expect(persona.statusCode).toBe(200)

    const after = [...messageRowids(harness.dataDir, 'chat-a'), ...messageRowids(harness.dataDir, 'chat-b')]
    expect(after).toEqual(before)
  })

  it('deleting a chat drops its message rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedTwoChats(assertion)
    expect(messageRowids(harness.dataDir, 'chat-b')).toHaveLength(1)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chats/chat-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(messageRowids(harness.dataDir, 'chat-b')).toEqual([])
    expect(messageRowids(harness.dataDir, 'chat-a')).toHaveLength(1)
  })
})

describe('message history commands', () => {
  it('appends, updates, deletes, truncates, and replaces messages by id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const appended = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        message: { role: 'char', data: 'hi', chatId: 'msg-b' },
      },
    })
    expect(appended.statusCode).toBe(200)
    expect(appended.json()).toEqual({
      revision: 2,
      event: {
        type: 'message.appended',
        revision: 2,
        resource: 'message',
        id: 'msg-b',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: appended.json().revision,
        patch: {
          data: 'hi there',
          disabled: true,
          name: 'Assistant',
          promptInfo: { promptName: 'Preset' },
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      revision: 3,
      event: {
        type: 'message.updated',
        resource: 'message',
        id: 'msg-b',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-b',
    })

    const replaced = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        messages: [
          { role: 'user', data: 'one', chatId: 'msg-1' },
          { role: 'char', data: 'two', chatId: 'msg-2', generationInfo: { model: 'm' } },
          { role: 'user', data: 'three', chatId: 'msg-3' },
        ],
      },
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({
      revision: 4,
      event: {
        type: 'messages.replaced',
        resource: 'message',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
    })

    const truncated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: replaced.json().revision,
        afterMessageId: 'msg-1',
      },
    })
    expect(truncated.statusCode).toBe(200)
    expect(truncated.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'message.truncated',
        resource: 'message',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      afterMessageId: 'msg-1',
      removedCount: 2,
    })

    const appendedAgain = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: truncated.json().revision,
        message: { role: 'char', data: 'tail', chatId: 'msg-tail' },
      },
    })
    expect(appendedAgain.statusCode).toBe(200)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/messages/msg-tail',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: appendedAgain.json().revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 7,
      event: {
        type: 'message.deleted',
        resource: 'message',
        id: 'msg-tail',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-tail',
    })

    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'one', chatId: 'msg-1' },
    ])
  })

  it('invalidates unsummarized chunks and their jobs when persisted message content changes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'stale source', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const db = openDatabase(harness.dataDir)
    try {
      createMemoryChunk(db, {
        id: 'chunk-stale',
        chatId: 'chat-a',
        messageId: 'msg-a',
        rangeStartSeq: 0,
        rangeEndSeq: 0,
        text: 'user: stale source',
      })
      createMemoryJob(db, {
        id: 'job-stale',
        chatId: 'chat-a',
        kind: 'summarize',
        status: 'failed',
        payload: { chunkId: 'chunk-stale', model: 'memory' },
      })
      createMemoryChunk(db, {
        id: 'chunk-summarized',
        chatId: 'chat-a',
        messageId: 'msg-a',
        rangeStartSeq: 0,
        rangeEndSeq: 0,
        text: 'user: summarized source',
        status: 'summarized',
      })
      createMemorySummary(db, {
        id: 'summary-keep',
        chatId: 'chat-a',
        chunkId: 'chunk-summarized',
        model: 'memory',
        text: 'retained summary',
        tokens: 2,
      })
      createMemoryJob(db, {
        id: 'job-summarized',
        chatId: 'chat-a',
        kind: 'summarize',
        status: 'completed',
        payload: { chunkId: 'chunk-summarized', model: 'memory' },
      })
      createMemoryChunk(db, {
        id: 'chunk-other-chat',
        chatId: 'chat-other',
        messageId: 'msg-other',
        rangeStartSeq: 0,
        rangeEndSeq: 0,
        text: 'user: other chat',
      })
      createMemoryJob(db, {
        id: 'job-other-chat',
        chatId: 'chat-other',
        kind: 'summarize',
        status: 'failed',
        payload: { chunkId: 'chunk-other-chat', model: 'memory' },
      })
    } finally {
      db.close()
    }

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { data: 'fresh source' } },
    })
    expect(updated.statusCode).toBe(200)

    const updatedDb = openDatabase(harness.dataDir)
    try {
      expect(listMemoryChunks(updatedDb, { chatId: 'chat-a' }).map((chunk) => chunk.id)).toEqual(['chunk-summarized'])
      expect(listMemoryJobs(updatedDb, { chatId: 'chat-a' }).map((job) => job.id)).toEqual(['job-summarized'])
      expect(listMemoryChunks(updatedDb, { chatId: 'chat-other' }).map((chunk) => chunk.id)).toEqual([
        'chunk-other-chat',
      ])
      expect(listMemoryJobs(updatedDb, { chatId: 'chat-other' }).map((job) => job.id)).toEqual(['job-other-chat'])
    } finally {
      updatedDb.close()
    }
  })

  it('requires truncate and tail anchors to be present while accepting explicit null', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'one', chatId: 'msg-1' },
                { role: 'char', data: 'two', chatId: 'msg-2' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const omittedTruncate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(omittedTruncate.statusCode).toBe(400)
    expect(omittedTruncate.json().error).toBe('afterMessageId is required')

    const omittedTail = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/tail',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, messages: [] },
    })
    expect(omittedTail.statusCode).toBe(400)
    expect(omittedTail.json().error).toBe('afterMessageId is required')
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).map((message) => message.chatId)).toEqual([
      'msg-1',
      'msg-2',
    ])

    const explicitNull = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, afterMessageId: null },
    })
    expect(explicitNull.statusCode).toBe(200)
    expect(explicitNull.json()).toMatchObject({
      afterMessageId: null,
      removedCount: 2,
    })
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([])
  })

  it('rejects ambiguous duplicate UIDs for truncate, tail replacement, and generation results', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'first', chatId: 'duplicate-id' },
                { role: 'char', data: 'second', chatId: 'original-second-id' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const db = openDatabase(harness.dataDir)
    try {
      const row = db.prepare("SELECT json FROM messages WHERE chat_id = 'chat-a' AND seq = 1").get() as {
        json: string
      }
      const message = JSON.parse(row.json) as Record<string, unknown>
      message.chatId = 'duplicate-id'
      db.prepare("UPDATE messages SET uid = 'duplicate-id', json = ? WHERE chat_id = 'chat-a' AND seq = 1").run(
        JSON.stringify(message),
      )
    } finally {
      db.close()
    }

    const truncate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, afterMessageId: 'duplicate-id' },
    })
    expect(truncate.statusCode).toBe(400)
    expect(truncate.json().error).toBe('Ambiguous message id: duplicate-id')

    const tail = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/tail',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, afterMessageId: 'duplicate-id', messages: [] },
    })
    expect(tail.statusCode).toBe(400)
    expect(tail.json().error).toBe('Ambiguous message id: duplicate-id')

    const generation = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'collision',
            chatId: 'duplicate-id',
            promptInfo: {},
            generationInfo: { generationId: 'duplicate-id' },
          },
        },
      },
    })
    expect(generation.statusCode).toBe(400)
    expect(generation.json().error).toBe('Ambiguous message id: duplicate-id')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'first', chatId: 'duplicate-id' },
      { role: 'char', data: 'second', chatId: 'duplicate-id' },
    ])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
  })

  it('rejects retired reroll-preserving truncates and leaves ordinary truncation destructive', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'one', chatId: 'msg-1' },
                { role: 'char', data: 'two', chatId: 'msg-2', generationInfo: { model: 'm' } },
                { role: 'user', data: 'three', chatId: 'msg-3' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const retired = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        afterMessageId: 'msg-1',
        preserveRemovedAsAlternates: true,
      },
    })
    expect(retired.statusCode).toBe(400)
    expect(retired.json().error).toBe('preserveRemovedAsAlternates is no longer supported')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toHaveLength(3)

    const truncated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        afterMessageId: 'msg-1',
      },
    })

    expect(truncated.statusCode).toBe(200)
    expect(truncated.json()).toMatchObject({
      revision: 2,
      chatId: 'chat-a',
      afterMessageId: 'msg-1',
      removedCount: 2,
    })
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'one', chatId: 'msg-1' },
    ])
    expect(await persistedChatAlternates(harness.app, assertion, 'chat-a')).toEqual([])
  })

  it('replaces only the requested message tail', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'one', chatId: 'msg-1' },
                { role: 'char', data: 'two', chatId: 'msg-2' },
                { role: 'user', data: 'three', chatId: 'msg-3' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const tailReplaced = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/tail',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        afterMessageId: 'msg-1',
        messages: [
          { role: 'char', data: 'two alt', chatId: 'msg-2b', generationInfo: { model: 'm' } },
          { role: 'user', data: 'three alt', chatId: 'msg-3b' },
        ],
      },
    })

    expect(tailReplaced.statusCode).toBe(200)
    expect(tailReplaced.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'messages.replaced',
        resource: 'message',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      afterMessageId: 'msg-1',
      replacedCount: 2,
    })
    expect(tailReplaced.json()).not.toHaveProperty('messageIds')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'one', chatId: 'msg-1' },
      { role: 'char', data: 'two alt', chatId: 'msg-2b', generationInfo: { model: 'm' } },
      { role: 'user', data: 'three alt', chatId: 'msg-3b' },
    ])
  })

  it('translates raw message data on the server and stores the result on the message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'translated raw text',
    })

    const translated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(translated.statusCode).toBe(200)
    expect(translated.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'message.updated',
        revision: 2,
        resource: 'message',
        id: 'msg-a',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-a',
      translation: {
        text: 'translated raw text',
        source: 'raw',
        targetLanguage: 'ko',
        inputLanguage: 'en',
        translatorType: 'llm',
      },
    })
    expect(translated.json().translation.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(translated.json().translation.settingsHash).toMatch(/^[a-f0-9]{64}$/)
    expect(typeof translated.json().translation.updatedAt).toBe('number')

    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'hello raw',
        chatId: 'msg-a',
        translation: translated.json().translation,
      },
    ])

    const unchanged = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: translated.json().revision,
        patch: { data: 'hello raw' },
      },
    })
    expect(unchanged.statusCode).toBe(200)
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'hello raw',
        chatId: 'msg-a',
        translation: translated.json().translation,
      },
    ])

    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: unchanged.json().revision,
        patch: { data: 'changed raw' },
      },
    })
    expect(edited.statusCode).toBe(200)
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'changed raw',
        chatId: 'msg-a',
        translation: null,
      },
    ])

    const replacedWithStaleTranslation = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: edited.json().revision,
        messages: [
          {
            role: 'user',
            data: 'changed by replacement',
            chatId: 'msg-a',
            translation: translated.json().translation,
          },
        ],
      },
    })
    expect(replacedWithStaleTranslation.statusCode).toBe(200)
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'changed by replacement',
        chatId: 'msg-a',
        translation: null,
      },
    ])
  })

  it('translates a server-resolved greeting and exposes only the current settings projection', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'translated primary greeting',
    })

    const translated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/-1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, chatId: 'chat-a', jobId: 'greeting-job-a' },
    })
    expect(translated.statusCode).toBe(200)
    expect(translated.json()).toMatchObject({
      revision: revision + 1,
      event: {
        type: 'character.greetingTranslation.updated',
        resource: 'greetingTranslation',
        id: 'char-a',
      },
      jobId: 'greeting-job-a',
      characterId: 'char-a',
      chatId: 'chat-a',
      greetingIndex: -1,
      translation: { text: 'translated primary greeting', source: 'raw', translatorType: 'llm' },
    })
    expect(translated.json().settingsHash).toBe(translated.json().translation.settingsHash)

    const projected = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a/greeting-translations?chatId=chat-a',
      headers: { 'risu-auth': assertion },
    })
    expect(projected.statusCode).toBe(200)
    expect(projected.json()).toEqual({
      revision: revision + 1,
      characterId: 'char-a',
      chatId: 'chat-a',
      settingsHash: translated.json().settingsHash,
      translations: [{ greetingIndex: -1, translation: translated.json().translation }],
    })
    expect(readJsonRow('characters', 'char-a')).not.toHaveProperty('greetingTranslations')

    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, chatId: 'chat-a', jobId: 'invalid-job' },
    })
    expect(invalid.statusCode).toBe(404)
    expect(invalid.json().error).toBe('Greeting not found: char-a/1')

    const disabled = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/language',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, patch: { translatorType: 'none' } },
    })
    expect(disabled.statusCode).toBe(200)
    const disabledProjection = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a/greeting-translations?chatId=chat-a',
      headers: { 'risu-auth': assertion },
    })
    expect(disabledProjection.json()).toMatchObject({ settingsHash: null, translations: [] })
  })

  it('rejects a greeting translation whose source changes while the provider is running', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'stale greeting translation',
      echoDelay: 0.2,
    })
    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/-1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, chatId: 'chat-a', jobId: 'stale-greeting-job' },
    })
    await waitForActiveGreetingTranslation(harness.app, assertion, {
      characterId: 'char-a',
      chatId: 'chat-a',
      greetingIndex: -1,
    })

    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { firstMessage: 'edited greeting' } },
    })
    expect(edited.statusCode).toBe(200)
    const result = await translating
    expect(result.statusCode).toBe(400)
    expect(result.json().error).toBe('Greeting changed before translation could be saved: char-a/-1')
    const db = openDatabase(harness.dataDir)
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM greeting_translations').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('preserves a greeting row changed while the provider request is pending', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'provider greeting translation that must lose',
      echoDelay: 0.2,
    })
    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/-1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, chatId: 'chat-a', jobId: 'stale-prior-greeting-job' },
    })
    const active = await waitForActiveGreetingTranslation(harness.app, assertion, {
      characterId: 'char-a',
      chatId: 'chat-a',
      greetingIndex: -1,
    })
    const manualTranslation = {
      text: 'manual greeting translation',
      source: 'raw' as const,
      sourceHash: sourceHash('primary greeting'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: active.settingsHash,
      updatedAt: 123,
    }
    const db = openDatabase(harness.dataDir)
    try {
      upsertGreetingTranslation(db, 'char-a', -1, manualTranslation)
    } finally {
      db.close()
    }

    const result = await translating
    expect(result.statusCode).toBe(400)
    expect(result.json().error).toBe('Greeting translation changed before translation could be saved: char-a/-1')
    const after = openDatabase(harness.dataDir)
    try {
      expect(getGreetingTranslation(after, 'char-a', -1, active.settingsHash)?.translation).toEqual(manualTranslation)
    } finally {
      after.close()
    }
  })

  it('continues greeting translation after the requesting client disconnects', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'greeting translated after disconnect',
      echoDelay: 0.5,
    })
    await harness.app.listen({ host: '127.0.0.1', port: 0 })
    await postAndDisconnect(
      `${appBaseUrl(harness.app)}/api/v1/commands/characters/char-a/greetings/-1/translate`,
      assertion,
      { baseRevision: revision, chatId: 'chat-a', jobId: 'disconnected-greeting-job' },
    )

    const during = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(during.statusCode).toBe(200)
    expect(during.json().activeGreetingTranslations).toEqual([
      expect.objectContaining({
        characterId: 'char-a',
        chatId: 'chat-a',
        greetingIndex: -1,
        jobId: 'disconnected-greeting-job',
        status: 'running',
      }),
    ])
    await expect(
      waitForProjectedGreetingTranslation(
        harness.app,
        assertion,
        'char-a',
        'chat-a',
        'greeting translated after disconnect',
      ),
    ).resolves.toMatchObject({ text: 'greeting translated after disconnect', source: 'raw' })
  })

  it('allows unrelated edits while raw translation is waiting on its provider', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'translated after concurrent edit',
      echoDelay: 0.2,
    })

    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })

    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })

    const settings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { font: 'concurrent-font' },
      },
    })
    expect(settings.statusCode).toBe(200)

    const translated = await translating
    expect(translated.statusCode).toBe(200)
    expect(translated.json()).toMatchObject({
      revision: settings.json().revision + 1,
      chatId: 'chat-a',
      messageId: 'msg-a',
      translation: { text: 'translated after concurrent edit' },
    })
  })

  it('lets a newer raw translation supersede the operation that previously owned the message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'only translation result',
      echoDelay: 0.2,
    })

    const first = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, jobId: 'translation-job-a' },
    })
    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })

    const newer = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, jobId: 'translation-job-b' },
    })
    const [olderResult, newerResult] = await Promise.all([first, newer])
    expect(olderResult.statusCode).toBe(400)
    expect(olderResult.json().error).toBe('Message translation is no longer current: msg-a')
    expect(newerResult.statusCode).toBe(200)
    expect(newerResult.json()).toMatchObject({
      jobId: 'translation-job-b',
      translation: { text: 'only translation result' },
    })
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      expect.objectContaining({
        chatId: 'msg-a',
        translation: expect.objectContaining({ text: 'only translation result' }),
      }),
    ])
  })

  it('rejects a stale translation when its source message changes during the provider request', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'stale translated text',
      echoDelay: 0.2,
      sourceText: 'original raw text',
    })

    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })

    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { data: 'edited while translating' },
      },
    })
    expect(edited.statusCode).toBe(200)

    const translated = await translating
    expect(translated.statusCode).toBe(400)
    expect(translated.json().error).toBe('Message changed before translation could be saved: msg-a')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'edited while translating',
        chatId: 'msg-a',
      },
    ])

    const after = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(after.statusCode).toBe(200)
    expect(after.json().revision).toBe(edited.json().revision)
    expect(after.json().activeMessageTranslations).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: expect.any(String),
        status: 'failed',
        error: 'Message changed before translation could be saved: msg-a',
        completedAt: expect.any(Number),
      }),
    ])
  })

  it('preserves a manual translation edit made while the provider request is pending', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const sourceText = 'original raw text'
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'provider translation that must lose',
      echoDelay: 0.2,
      sourceText,
    })
    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, jobId: 'translation-job-a' },
    })
    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })

    const manualTranslation = {
      text: 'manually edited translation',
      source: 'raw',
      sourceHash: createHash('sha256').update(sourceText).digest('hex'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'manual-settings',
      updatedAt: 123,
    }
    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { translation: manualTranslation } },
    })
    expect(edited.statusCode).toBe(200)

    const translated = await translating
    expect(translated.statusCode).toBe(400)
    expect(translated.json().error).toBe('Message translation changed before translation could be saved: msg-a')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: sourceText,
        chatId: 'msg-a',
        translation: manualTranslation,
      },
    ])
  })

  it('continues server raw translation after the requesting client disconnects', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'translated after disconnect',
      echoDelay: 0.5,
    })

    await harness.app.listen({ host: '127.0.0.1', port: 0 })
    await postAndDisconnect(`${appBaseUrl(harness.app)}/api/v1/commands/messages/msg-a/translate`, assertion, {
      baseRevision: revision,
    })

    const during = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(during.statusCode).toBe(200)
    expect(during.json().activeMessageTranslations).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: expect.any(String),
        status: 'running',
      }),
    ])

    const message = await waitForPersistedTranslation(harness.app, assertion, 'chat-a', 'translated after disconnect')
    expect(message.translation).toMatchObject({
      text: 'translated after disconnect',
      source: 'raw',
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
    })

    const after = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(after.statusCode).toBe(200)
    expect(after.json().activeMessageTranslations).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: expect.any(String),
        status: 'succeeded',
        completedAt: expect.any(Number),
      }),
    ])
  })

  it('normalizes missing message ids and rejects malformed message commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'missing id' },
                { role: 'char', data: 'duplicate a', chatId: 'dup' },
                { role: 'user', data: 'duplicate b', chatId: 'dup' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const duplicateReplacement = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        messages: [
          { role: 'user', data: 'a', chatId: 'same' },
          { role: 'char', data: 'b', chatId: 'same' },
        ],
      },
    })
    expect(duplicateReplacement.statusCode).toBe(400)
    expect(duplicateReplacement.json().error).toBe('Duplicate message id: same')

    const missingAppendId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        message: { role: 'user', data: 'missing id' },
      },
    })
    expect(missingAppendId.statusCode).toBe(400)
    expect(missingAppendId.json().error).toBe('message.chatId must be a non-empty string')

    const missingReplacementId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        messages: [{ role: 'user', data: 'missing id' }],
      },
    })
    expect(missingReplacementId.statusCode).toBe(400)
    expect(missingReplacementId.json().error).toBe('messages[0].chatId must be a non-empty string')

    const badPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/dup',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { generationInfo: { model: 'later-slice' } },
      },
    })
    expect(badPatch.statusCode).toBe(400)
    expect(badPatch.json().error).toBe('patch.generationInfo is not supported for message commands')

    const badTranslationPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/dup',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { translation: { text: 1 } },
      },
    })
    expect(badTranslationPatch.statusCode).toBe(400)
    expect(badTranslationPatch.json().error).toBe('patch.translation.text must be a string')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    const messages = await persistedChatMessages(harness.app, assertion, 'chat-a')
    expect(messages.map((message) => (message as any).data)).toEqual(['missing id', 'duplicate a', 'duplicate b'])
    expect(messages.map((message) => (message as any).chatId)).toHaveLength(3)
    expect(new Set(messages.map((message) => (message as any).chatId)).size).toBe(3)
  })

  it('repairs imported duplicate message ids across chats and updates local references', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'a', chatId: 'msg-shared' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [{ role: 'char', data: 'b', chatId: 'msg-shared' }],
              bookmarks: ['msg-shared'],
              bookmarkNames: { 'msg-shared': 'Pinned' },
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    const charB = (await projectedCharacterRow(harness.app, assertion, 'char-b')) as {
      chats: Array<{ bookmarks?: unknown; bookmarkNames?: unknown }>
    }
    const chatAMessages = await persistedChatMessages(harness.app, assertion, 'chat-a')
    const chatBMessages = await persistedChatMessages(harness.app, assertion, 'chat-b')
    const renamedMessageId = chatBMessages[0].chatId as string
    expect(chatAMessages[0].chatId).toBe('msg-shared')
    expect(renamedMessageId).not.toBe('msg-shared')
    expect(typeof renamedMessageId).toBe('string')
    // The import's cross-chat uid repair also rewrote chat-b's bookmarks
    // (metadata) to the renamed id — verified against the hydrated character
    // row because bootstrap now shells inactive characters.
    expect(charB.chats[0].bookmarks).toEqual([renamedMessageId])
    expect(charB.chats[0].bookmarkNames).toEqual({ [renamedMessageId]: 'Pinned' })
  })

  it('rejects message ids already used by another chat without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [{ role: 'user', data: 'hi', chatId: 'msg-b' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const duplicateAppend = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        message: { role: 'char', data: 'duplicate append', chatId: 'msg-a' },
      },
    })
    expect(duplicateAppend.statusCode).toBe(400)
    expect(duplicateAppend.json().error).toBe('Duplicate message id: msg-a')

    const duplicateReplace = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-b/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        messages: [{ role: 'char', data: 'duplicate replace', chatId: 'msg-a' }],
      },
    })
    expect(duplicateReplace.statusCode).toBe(400)
    expect(duplicateReplace.json().error).toBe('Duplicate message id: msg-a')

    const duplicateGeneration = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          targetMessageId: 'msg-b',
          message: {
            role: 'char',
            data: 'duplicate generation',
            chatId: 'msg-a',
            generationInfo: { generationId: 'gen-a' },
            promptInfo: { promptName: 'Preset' },
          },
        },
      },
    })
    expect(duplicateGeneration.statusCode).toBe(400)
    expect(duplicateGeneration.json().error).toBe('Duplicate message id: msg-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    const chatAMessages = await persistedChatMessages(harness.app, assertion, 'chat-a')
    const chatBMessages = await persistedChatMessages(harness.app, assertion, 'chat-b')
    expect([...chatAMessages, ...chatBMessages].map((message) => message.chatId)).toEqual(['msg-a', 'msg-b'])
  })

  it('returns 404 and 409 for missing messages and stale message revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { data: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Message not found: missing')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        patch: { data: 'Stale' },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('generation persistence command', () => {
  it('persists generated assistant rows by appending or replacing the target message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'hello', chatId: 'msg-a' },
                { role: 'char', data: 'old tail', chatId: 'msg-old' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const appended = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'fresh answer',
            chatId: 'gen-1',
            promptInfo: { promptName: 'Preset' },
            generationInfo: { generationId: 'gen-1', model: 'echo_model' },
          },
        },
      },
    })
    expect(appended.statusCode).toBe(200)
    expect(appended.json()).toEqual({
      revision: 2,
      event: {
        type: 'generation.persisted',
        revision: 2,
        resource: 'generation',
        id: 'gen-1',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'gen-1',
    })

    const repeated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: appended.json().revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'fresh answer replay',
            chatId: 'gen-1',
            promptInfo: { promptName: 'Preset' },
            generationInfo: { generationId: 'gen-1', model: 'echo_model' },
          },
        },
      },
    })
    expect(repeated.statusCode).toBe(200)
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).map((m) => m.chatId)).toEqual([
      'msg-a',
      'msg-old',
      'gen-1',
    ])

    const replaced = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: repeated.json().revision,
        generationResult: {
          targetMessageId: 'msg-old',
          message: {
            role: 'char',
            data: 'continued answer',
            chatId: 'gen-2',
            promptInfo: { promptName: 'Preset' },
            generationInfo: {
              generationId: 'gen-2',
              model: 'echo_model',
              stageTiming: { stage4: 3 },
            },
          },
        },
      },
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({
      revision: 4,
      event: {
        type: 'generation.persisted',
        resource: 'generation',
        id: 'gen-2',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'gen-2',
    })

    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'hello', chatId: 'msg-a' },
      {
        role: 'char',
        data: 'continued answer',
        chatId: 'gen-2',
        promptInfo: { promptName: 'Preset' },
        generationInfo: {
          generationId: 'gen-2',
          model: 'echo_model',
          stageTiming: { stage4: 3 },
        },
      },
      {
        role: 'char',
        data: 'fresh answer replay',
        chatId: 'gen-1',
        promptInfo: { promptName: 'Preset' },
        generationInfo: { generationId: 'gen-1', model: 'echo_model' },
      },
    ])
    expect(harness.commandEvents.list().at(-1)).toMatchObject({
      type: 'generation.persisted',
      revision: 4,
      resource: 'generation',
      id: 'gen-2',
      parentId: 'chat-a',
    })
  })

  it('preserves a targetless same-UID displaced row and the existing alternate buffer', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'hello', chatId: 'msg-a' },
                {
                  role: 'char',
                  data: 'displaced answer',
                  chatId: 'generation-id',
                  promptInfo: { promptName: 'Old preset' },
                  generationInfo: { generationId: 'generation-id', model: 'old-model' },
                },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const db = openDatabase(harness.dataDir)
    try {
      addAlternateMessage(db, 'chat-a', {
        role: 'char',
        data: 'pre-existing alternate',
        chatId: 'pre-existing-alternate',
      })
    } finally {
      db.close()
    }

    const result = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'replacement answer',
            chatId: 'generation-id',
            promptInfo: { promptName: 'New preset' },
            generationInfo: { generationId: 'generation-id', model: 'new-model' },
          },
        },
      },
    })

    expect(result.statusCode).toBe(200)
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).at(-1)).toEqual({
      role: 'char',
      data: 'replacement answer',
      chatId: 'generation-id',
      promptInfo: { promptName: 'New preset' },
      generationInfo: { generationId: 'generation-id', model: 'new-model' },
    })
    expect(await persistedChatAlternates(harness.app, assertion, 'chat-a')).toEqual(
      expect.arrayContaining([
        {
          role: 'char',
          data: 'displaced answer',
          chatId: 'generation-id',
          promptInfo: { promptName: 'Old preset' },
          generationInfo: { generationId: 'generation-id', model: 'old-model' },
        },
        {
          role: 'char',
          data: 'pre-existing alternate',
          chatId: 'pre-existing-alternate',
        },
      ]),
    )
  })

  it('rejects malformed generation results without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const badRole = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'user',
            data: 'not an assistant',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(badRole.statusCode).toBe(400)
    expect(badRole.json().error).toBe('generationResult.message.role must be char')

    const missingInfo = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: { role: 'char', data: 'missing metadata', chatId: 'gen-1' },
        },
      },
    })
    expect(missingInfo.statusCode).toBe(400)
    expect(missingInfo.json().error).toBe('generationResult.message.generationInfo is required')

    const missingMessageId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'missing id',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(missingMessageId.statusCode).toBe(400)
    expect(missingMessageId.json().error).toBe('generationResult.message.chatId must be a non-empty string')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([])
  })

  it('returns 404 and 409 for missing generation targets and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missingChat = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/missing/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'answer',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(missingChat.statusCode).toBe(404)
    expect(missingChat.json().error).toBe('Chat not found: missing')

    const missingMessage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          targetMessageId: 'missing-message',
          message: {
            role: 'char',
            data: 'answer',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(missingMessage.statusCode).toBe(404)
    expect(missingMessage.json().error).toBe('Message not found for chat chat-a: missing-message')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        generationResult: {
          message: {
            role: 'char',
            data: 'answer',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('chat scriptstate command', () => {
  it('applies partial scriptstate patches and delete keys with a command event', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              scriptstate: { $old: '1', $keep: true },
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { $score: '9', $count: 2 },
        deleteKeys: ['$old'],
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'chat.scriptstate.updated',
        revision: 2,
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({
      $keep: true,
      $score: '9',
      $count: 2,
    })
    expect(harness.commandEvents.list().at(-1)).toEqual(res.json().event)
  })

  it('removes empty scriptstate after deleting the last key', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              scriptstate: { $old: '1' },
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: {}, deleteKeys: ['$old'] },
    })

    expect(res.statusCode).toBe(200)
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toBeUndefined()
  })

  it('rejects malformed scriptstate payloads without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const unsupportedValue = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { $bad: { nested: true } } },
    })
    expect(unsupportedValue.statusCode).toBe(400)
    expect(unsupportedValue.json().error).toBe('patch.$bad must be a string, number, or boolean')

    const empty = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: {}, deleteKeys: [] },
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error).toBe('scriptstate command must include patch fields or deleteKeys')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toBeUndefined()
  })

  it('returns 404 and 409 for missing chats and stale scriptstate revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/missing/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { $x: '1' } },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Chat not found: missing')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { $x: '1' } },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('lorebook commands', () => {
  it('creates, updates, reorders, and deletes global lorebooks with command events', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        lorebook: { id: 'book-b', name: 'B', data: [] },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'lorebook.created',
        revision: 2,
        resource: 'globalLorebook',
        id: 'book-b',
      },
      lorebookId: 'book-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/lorebooks/book-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, patch: { name: 'Renamed' } },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event.type).toBe('lorebook.updated')

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, lorebookIds: ['book-b', 'book-a'] },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event.type).toBe('lorebook.reordered')

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks/book-a/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4 },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'lorebook.selected',
        revision: 5,
        resource: 'globalLorebook',
        id: 'book-a',
      },
      selectedLorebookId: 'book-a',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/lorebooks/book-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event.type).toBe('lorebook.deleted')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(6)
    expect(
      bootstrap.resourceDatabase.loreBook.map((book: { id: string; name: string }) => ({
        id: book.id,
        name: book.name,
      })),
    ).toEqual([{ id: 'book-b', name: 'Renamed' }])
    expect(
      harness.commandEvents
        .list()
        .slice(-5)
        .map((event) => event.type),
    ).toEqual(['lorebook.created', 'lorebook.updated', 'lorebook.reordered', 'lorebook.selected', 'lorebook.deleted'])
  })

  it('rejects deleting the last global lorebook without minting a replacement id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/lorebooks/book-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(deleted.statusCode).toBe(400)
    expect(deleted.json().error).toBe('Cannot delete the last lorebook')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.loreBook).toEqual([{ id: 'book-a', name: 'A', data: [] }])
  })

  it('fails closed on malformed or duplicate persisted global and module target ids', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [
        { id: 'book-a', name: 'A', data: [] },
        { id: 'book-b', name: 'B', data: [] },
      ],
      loreBookPage: 0,
      modules: [
        { id: 'mod-a', name: 'A', description: '' },
        { id: 'mod-b', name: 'B', description: '' },
      ],
    })
    const rewriteRow = (
      table: 'lore_books' | 'modules',
      position: number,
      mutate: (row: Record<string, unknown>) => void,
    ): string => {
      const db = openDatabase(harness.dataDir)
      try {
        const stored = db.prepare(`SELECT data_json FROM ${table} WHERE position = ?`).get(position) as {
          data_json: string
        }
        const row = JSON.parse(stored.data_json) as Record<string, unknown>
        mutate(row)
        const dataJson = JSON.stringify(row)
        db.prepare(`UPDATE ${table} SET data_json = ? WHERE position = ?`).run(dataJson, position)
        return dataJson
      } finally {
        db.close()
      }
    }
    const expectStoredRow = (table: 'lore_books' | 'modules', position: number, dataJson: string): void => {
      const db = openDatabase(harness.dataDir)
      try {
        expect(
          (db.prepare(`SELECT data_json FROM ${table} WHERE position = ?`).get(position) as { data_json: string })
            .data_json,
        ).toBe(dataJson)
      } finally {
        db.close()
      }
    }

    const duplicateLorebook = rewriteRow('lore_books', 1, (row) => {
      row.id = 'book-a'
    })
    let response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/lorebooks/book-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'must not write' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Duplicate lorebook id: book-a')
    expectStoredRow('lore_books', 1, duplicateLorebook)
    rewriteRow('lore_books', 1, (row) => {
      row.id = 'book-b'
    })

    const malformedLorebook = rewriteRow('lore_books', 0, (row) => {
      delete row.id
    })
    response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/lorebooks/book-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'must not write' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('loreBook[0].id must be a non-empty string')
    expectStoredRow('lore_books', 0, malformedLorebook)

    const duplicateModule = rewriteRow('modules', 1, (row) => {
      row.id = 'mod-a'
    })
    response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'must not write' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Duplicate module id: mod-a')
    expectStoredRow('modules', 1, duplicateModule)
    rewriteRow('modules', 1, (row) => {
      row.id = 'mod-b'
    })

    const malformedModule = rewriteRow('modules', 0, (row) => {
      delete row.id
    })
    response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'must not write' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('module[0].id must be a non-empty string')
    expectStoredRow('modules', 0, malformedModule)

    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('replaces global, character, chat, and module lorebook entry collections', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [],
          chats: [{ id: 'chat-a', name: 'Chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [] }],
    })

    const entry = (id: string, comment: string) => ({
      id,
      key: comment.toLowerCase(),
      secondkey: '',
      insertorder: 100,
      comment,
      content: `${comment} content`,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    })

    const global = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, entries: [entry('entry-global', 'Global')] },
    })
    expect(global.statusCode).toBe(200)
    expect(global.json().event).toMatchObject({
      type: 'lorebook.entries.replaced',
      // The global lorebook entries edit ships only loreBook/loreBookPage.
      resource: 'globalLorebook',
      id: 'book-a',
    })

    const character = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, entries: [entry('entry-char', 'Character')] },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json()).toMatchObject({ revision: 3, characterId: 'char-a' })
    // The character globalLore edit ships only the changed character row.
    expect(character.json().event).toMatchObject({
      resource: 'characterLorebook',
      id: 'char-a',
    })

    const chat = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, entries: [entry('entry-chat', 'Chat')] },
    })
    expect(chat.statusCode).toBe(200)
    // localLore lives in the chat row, so a foreign refresh ships its parent character only.
    expect(chat.json().event).toMatchObject({ resource: 'characterRow', id: 'chat-a', parentId: 'char-a' })

    const module = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, entries: [entry('entry-module', 'Module')] },
    })
    expect(module.statusCode).toBe(200)
    expect(module.json()).toMatchObject({ revision: 5, moduleId: 'mod-a' })
    // One module's lorebook is a single `modules`-row edit.
    expect(module.json().event).toMatchObject({ resource: 'moduleUpdated', id: 'mod-a' })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ lorebook?: Array<{ id: string }> }>
    }
    expect(database.loreBook[0].data[0].id).toBe('entry-global')
    expect(database.characters[0].globalLore[0].id).toBe('entry-char')
    expect(database.characters[0].chats[0].localLore[0].id).toBe('entry-chat')
    expect(persisted.modules[0].lorebook?.[0].id).toBe('entry-module')
  })

  it('upserts one lorebook entry through scoped routes without uploading sibling entries', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const entry = (id: string, comment: string) => ({
      id,
      key: comment.toLowerCase(),
      secondkey: '',
      insertorder: 100,
      comment,
      content: `${comment} content`,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    })
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [entry('global-a', 'Global A'), entry('global-b', 'Global B')] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [entry('char-a', 'Character A'), entry('char-b', 'Character B')],
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: '',
              message: [],
              localLore: [entry('chat-a', 'Chat A'), entry('chat-b', 'Chat B')],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [
        { id: 'mod-a', name: 'Mod', lorebook: [entry('module-a', 'Module A'), entry('module-b', 'Module B')] },
        { id: 'mod-b', name: 'Untouched', lorebook: [] },
      ],
    })
    writeJsonRow('modules', 'mod-b', { ...readJsonRow('modules', 'mod-b'), lorebook: undefined })

    const global = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries/global-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, entry: entry('global-b', 'Global B Updated') },
    })
    expect(global.statusCode).toBe(200)
    expect(global.json()).toMatchObject({
      revision: revision + 1,
      lorebookId: 'book-a',
      entryId: 'global-b',
      entryIndex: 1,
      created: false,
    })

    const character = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/lorebooks/entries/char-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, entry: entry('char-b', 'Character B Updated') },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json().event).toMatchObject({ resource: 'characterLorebook', id: 'char-a' })

    const chat = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/lorebooks/entries/chat-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 2, entry: entry('chat-b', 'Chat B Updated') },
    })
    expect(chat.statusCode).toBe(200)
    expect(chat.json().event).toMatchObject({ resource: 'characterRow', id: 'chat-a', parentId: 'char-a' })

    const module = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/lorebooks/entries/module-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 3, entry: entry('module-b', 'Module B Updated') },
    })
    expect(module.statusCode).toBe(200)
    expect(module.json().event).toMatchObject({ resource: 'moduleUpdated', id: 'mod-a' })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/lorebooks/book-a/entries/global-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 4 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({ lorebookId: 'book-a', entryId: 'global-a', entryIndex: 0 })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/mod-a/lorebooks/entries/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 5, entryIds: ['module-b', 'module-a'] },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event).toMatchObject({ resource: 'moduleUpdated', id: 'mod-a' })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ lorebook?: Array<{ comment: string }> }>
    }
    expect(database.loreBook[0].data.map((item: { comment: string }) => item.comment)).toEqual(['Global B Updated'])
    expect(database.characters[0].globalLore.map((item: { comment: string }) => item.comment)).toEqual([
      'Character A',
      'Character B Updated',
    ])
    expect(database.characters[0].chats[0].localLore.map((item: { comment: string }) => item.comment)).toEqual([
      'Chat A',
      'Chat B Updated',
    ])
    expect(persisted.modules[0].lorebook?.map((item: { comment: string }) => item.comment)).toEqual([
      'Module B Updated',
      'Module A',
    ])
    expect(readJsonRow('modules', 'mod-b')).not.toHaveProperty('lorebook')
  })

  it('rejects degraded module lorebook ids before applying an entry command', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const entry = (id: string, comment: string) => ({
      id,
      key: comment.toLowerCase(),
      secondkey: '',
      insertorder: 100,
      comment,
      content: `${comment} content`,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    })
    const revision = await importDatabase(harness.app, assertion, {
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [entry('legacy-id', 'Legacy')] }],
    })
    const degraded = entry('legacy-id', 'Legacy') as Record<string, unknown>
    delete degraded.id
    const degradedModule = {
      ...readJsonRow('modules', 'mod-a'),
      lorebook: [degraded],
    }
    writeJsonRow('modules', 'mod-a', degradedModule)

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/lorebooks/entries/new-entry',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, entry: entry('new-entry', 'New') },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('module mod-a.lorebook[0].id must be a non-empty string')
    expect(readJsonRow('modules', 'mod-a')).toStrictEqual(degradedModule)
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('applies sparse lorebook entry patches in every scope without replacing unchanged fields or siblings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const entry = (id: string, label: string) => ({
      id,
      key: label.toLowerCase(),
      secondkey: '',
      insertorder: 100,
      comment: label,
      content: `${label}:${'large-content-'.repeat(200)}`,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
      activationPercent: 40,
      unknownExtension: { preserve: label },
    })
    let revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [entry('global-a', 'Global A'), entry('global-b', 'Global B')] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [entry('char-a', 'Character A'), entry('char-b', 'Character B')],
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: '',
              message: [],
              localLore: [entry('chat-a', 'Chat A'), entry('chat-b', 'Chat B')],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [entry('module-a', 'Module A'), entry('module-b', 'Module B')] }],
    })

    const cases = [
      { url: '/api/v1/commands/lorebooks/book-a/entries/global-a', targetKey: 'lorebookId', targetId: 'book-a' },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks/entries/char-a',
        targetKey: 'characterId',
        targetId: 'char-a',
      },
      { url: '/api/v1/commands/chats/chat-a/lorebooks/entries/chat-a', targetKey: 'chatId', targetId: 'chat-a' },
      { url: '/api/v1/commands/modules/mod-a/lorebooks/entries/module-a', targetKey: 'moduleId', targetId: 'mod-a' },
    ]
    for (const testCase of cases) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: testCase.url,
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: { comment: 'Sparse update', nullableExtension: null },
          deleteKeys: ['activationPercent'],
        },
      })
      expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
      expect(response.json()).toMatchObject({
        [testCase.targetKey]: testCase.targetId,
        created: false,
        patchedKeys: ['comment', 'nullableExtension'],
        deletedKeys: ['activationPercent'],
      })
      revision = response.json().revision
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    const module = readJsonRow('modules', 'mod-a')
    const updatedEntries = [
      database.loreBook[0].data[0],
      database.characters[0].globalLore[0],
      database.characters[0].chats[0].localLore[0],
      (module.lorebook as Array<Record<string, unknown>>)[0],
    ]
    for (const updated of updatedEntries) {
      expect(updated.comment).toBe('Sparse update')
      expect(updated.nullableExtension).toBeNull()
      expect(updated).not.toHaveProperty('activationPercent')
      expect(updated.content).toContain('large-content-')
      expect(updated.unknownExtension).toHaveProperty('preserve')
    }
    expect(database.loreBook[0].data[1]).toMatchObject(entry('global-b', 'Global B'))
    expect(database.characters[0].globalLore[1]).toMatchObject(entry('char-b', 'Character B'))
    expect(database.characters[0].chats[0].localLore[1]).toMatchObject(entry('chat-b', 'Chat B'))
    expect((module.lorebook as Array<Record<string, unknown>>)[1]).toMatchObject(entry('module-b', 'Module B'))

    for (const testCase of cases) {
      const missingUrl = testCase.url.replace(/[^/]+$/, 'missing-entry')
      const missing = await harness.app.inject({
        method: 'PUT',
        url: missingUrl,
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch: { comment: 'must not create' } },
      })
      expect(missing.statusCode).toBe(404)
    }
    const unchanged = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(unchanged.json().revision).toBe(revision)
  })

  it('rejects malformed sparse lorebook entry writes without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const canonicalEntry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'body',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [canonicalEntry] }],
      loreBookPage: 0,
    })
    const bodies = [
      { entry: canonicalEntry, patch: { comment: 'mixed' } },
      { patch: {} },
      { patch: { id: 'entry-a' } },
      { patch: { comment: 'overlap' }, deleteKeys: ['comment'] },
      { deleteKeys: ['activationPercent', 'activationPercent'] },
      { deleteKeys: ['content'] },
    ]
    for (const body of bodies) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/commands/lorebooks/book-a/entries/entry-a',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, ...body },
      })
      expect(response.statusCode, JSON.stringify(response.json())).toBe(400)
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.loreBook[0].data).toEqual([canonicalEntry])
  })

  it('rejects sparse character and chat lorebook writes when an untargeted sibling is malformed', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const entry = (id: string, label: string) => ({
      id,
      key: label,
      secondkey: '',
      insertorder: 100,
      comment: label,
      content: label,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    })
    let revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [entry('char-target', 'target'), entry('char-sibling', 'sibling')],
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: '',
              message: [],
              localLore: [entry('chat-target', 'target'), entry('chat-sibling', 'sibling')],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const characterRow = readJsonRow('characters', 'char-a')
    delete (characterRow.globalLore as Array<Record<string, unknown>>)[1].comment
    writeJsonRow('characters', 'char-a', characterRow)
    const chatRow = readJsonRow('chats', 'chat-a')
    delete (chatRow.localLore as Array<Record<string, unknown>>)[1].comment
    writeJsonRow('chats', 'chat-a', chatRow)

    const character = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/lorebooks/entries/char-target',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { content: 'character update' } },
    })
    expect(character.statusCode).toBe(400)
    expect(character.json().error).toBe('character char-a.globalLore[1].comment must be a string')

    const chat = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/lorebooks/entries/chat-target',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { content: 'chat update' } },
    })
    expect(chat.statusCode).toBe(400)
    expect(chat.json().error).toBe('chat chat-a.localLore[1].comment must be a string')
    expect((readJsonRow('characters', 'char-a').globalLore as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      'comment',
    )
    expect((readJsonRow('chats', 'chat-a').localLore as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      'comment',
    )
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('rejects malformed lorebook commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
    })

    const malformed = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        entries: [
          {
            id: 'entry-a',
            key: '',
            secondkey: '',
            insertorder: 'bad',
            comment: '',
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
        ],
      },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error).toBe('entries[0].insertorder must be a finite number')

    const missingEntryId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        entries: [
          {
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: '',
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
        ],
      },
    })
    expect(missingEntryId.statusCode).toBe(400)
    expect(missingEntryId.json().error).toBe('entries[0].id must be a non-empty string')

    const duplicateEntryId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        entries: [
          {
            id: 'entry-a',
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: '',
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
          {
            id: 'entry-a',
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: '',
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
        ],
      },
    })
    expect(duplicateEntryId.statusCode).toBe(400)
    expect(duplicateEntryId.json().error).toBe('Duplicate lorebook entry id: entry-a')

    const badReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, lorebookIds: ['book-a', 'book-a'] },
    })
    expect(badReorder.statusCode).toBe(400)
    expect(badReorder.json().error).toBe('Duplicate lorebook id in lorebookIds: book-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.loreBook[0].data).toEqual([])
  })

  it('rejects POST /lorebooks payloads that omit nested entry ids', async () => {
    // The create route uses the no-mint validator so missing entry ids are
    // rejected instead of being silently minted.
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
    })

    const missingId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        lorebook: {
          id: 'book-c',
          name: 'C',
          data: [
            {
              key: 'k',
              secondkey: '',
              insertorder: 100,
              comment: '',
              content: 'c',
              mode: 'normal',
              alwaysActive: false,
              selective: false,
            },
          ],
        },
      },
    })
    expect(missingId.statusCode).toBe(400)
    expect(missingId.json().error).toBe('lorebook.data[0].id must be a non-empty string')

    const duplicateId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        lorebook: {
          id: 'book-c',
          name: 'C',
          data: [
            {
              id: 'dup-entry',
              key: '',
              secondkey: '',
              insertorder: 100,
              comment: '',
              content: '',
              mode: 'normal',
              alwaysActive: false,
              selective: false,
            },
            {
              id: 'dup-entry',
              key: '',
              secondkey: '',
              insertorder: 100,
              comment: '',
              content: '',
              mode: 'normal',
              alwaysActive: false,
              selective: false,
            },
          ],
        },
      },
    })
    expect(duplicateId.statusCode).toBe(400)
    expect(duplicateId.json().error).toBe('Duplicate lorebook entry id: dup-entry')

    // Persisted state unchanged: only book-a from the import remains.
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.loreBook.map((b: { id: string }) => b.id)).toEqual(['book-a'])
  })

  it('rejects PUT /characters /chats /modules lorebook payloads with missing or duplicate entry ids', async () => {
    // The replace routes use the no-mint validator so missing or duplicate entry
    // ids are rejected.
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [],
          chats: [{ id: 'chat-a', name: 'Chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [] }],
    })

    const malformedEntry = {
      key: '',
      secondkey: '',
      insertorder: 100,
      comment: '',
      content: '',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }

    const routes = [
      '/api/v1/commands/characters/char-a/lorebooks',
      '/api/v1/commands/chats/chat-a/lorebooks',
      '/api/v1/commands/modules/mod-a/lorebooks',
    ]

    for (const url of routes) {
      const missing = await harness.app.inject({
        method: 'PUT',
        url,
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, entries: [malformedEntry] },
      })
      expect(missing.statusCode).toBe(400)
      expect(missing.json().error).toBe('entries[0].id must be a non-empty string')

      const duplicate = await harness.app.inject({
        method: 'PUT',
        url,
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          entries: [
            { ...malformedEntry, id: 'dup-entry' },
            { ...malformedEntry, id: 'dup-entry' },
          ],
        },
      })
      expect(duplicate.statusCode).toBe(400)
      expect(duplicate.json().error).toBe('Duplicate lorebook entry id: dup-entry')
    }

    // Persisted state is untouched by the rejected requests; revision is
    // still the post-import baseline.
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    const database = bootstrap.resourceDatabase
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ lorebook?: unknown[] }>
    }
    expect(database.characters[0].globalLore).toEqual([])
    expect(database.characters[0].chats[0].localLore).toEqual([])
    expect(persisted.modules[0].lorebook).toEqual([])
  })

  it('global lorebook commands skip unrelated child-lore validation and keep target payload checks strict', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [
        { id: 'book-a', name: 'A', data: [] },
        { id: 'book-b', name: 'B', data: [] },
      ],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [],
          chats: [{ id: 'chat-a', name: 'Chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [] }],
    })

    const invalidEntry = {
      id: 'bad-lore-entry',
      key: 1,
      secondkey: '',
      insertorder: 100,
      comment: '',
      content: '',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    writeJsonRow('characters', 'char-a', {
      ...readJsonRow('characters', 'char-a'),
      globalLore: [invalidEntry],
    })
    writeJsonRow('chats', 'chat-a', {
      ...readJsonRow('chats', 'chat-a'),
      localLore: [invalidEntry],
    })
    writeJsonRow('modules', 'mod-a', {
      ...readJsonRow('modules', 'mod-a'),
      lorebook: [invalidEntry],
    })
    // Force the collection-scoped loader onto its documented broad fallback so
    // this proves the route, not only the loader, avoids child-lore repair.
    updateSettingsRow((settings) => {
      settings.characters = []
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks/book-b/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(selected.statusCode, JSON.stringify(selected.json())).toBe(200)
    expect(selected.json()).toMatchObject({ revision: 2, selectedLorebookId: 'book-b' })

    const malformedTarget = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, entries: [invalidEntry] },
    })
    expect(malformedTarget.statusCode).toBe(400)
    expect(malformedTarget.json().error).toBe('entries[0].key must be a string')

    const arrayKeyTarget = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, entries: [{ ...invalidEntry, key: [] }] },
    })
    expect(arrayKeyTarget.statusCode).toBe(400)
    expect(arrayKeyTarget.json().error).toBe('entries[0].key must be a string')

    expect(readJsonRow('characters', 'char-a').globalLore).toEqual([invalidEntry])
    expect(readJsonRow('chats', 'chat-a').localLore).toEqual([invalidEntry])
    expect(readJsonRow('modules', 'mod-a').lorebook).toEqual([invalidEntry])
  })

  it('returns 404 and 409 for missing lorebook parents and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
      characters: [],
    })

    const missing = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/missing/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, entries: [] },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Character not found: missing')

    const stale = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, entries: [] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('script and trigger definition commands', () => {
  it('replaces character and module script and trigger definition collections', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          customscript: [],
          triggerscript: [],
          chats: [],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', regex: [], trigger: [] }],
    })

    const script = {
      id: 'script-a',
      comment: 'Regex',
      in: 'a',
      out: 'b',
      type: 'editinput',
      flag: 'g',
      ableFlag: true,
    }
    const trigger = {
      id: 'trigger-a',
      comment: 'Start',
      type: 'start',
      conditions: [],
      effect: [],
    }

    const characterScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [script] },
    })
    expect(characterScripts.statusCode).toBe(200)
    expect(characterScripts.json().event).toMatchObject({
      type: 'scriptDefinitions.replaced',
      resource: 'characterRow',
      id: 'char-a',
    })

    const characterTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, triggers: [trigger] },
    })
    expect(characterTriggers.statusCode).toBe(200)
    expect(characterTriggers.json()).toMatchObject({
      revision: 3,
      characterId: 'char-a',
      event: {
        type: 'triggerDefinitions.replaced',
        resource: 'characterRow',
        id: 'char-a',
      },
    })

    const moduleScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, scripts: [{ ...script, id: 'module-script' }] },
    })
    expect(moduleScripts.statusCode).toBe(200)
    expect(moduleScripts.json()).toMatchObject({ revision: 4, moduleId: 'mod-a' })

    const moduleTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, triggers: [{ ...trigger, id: 'module-trigger' }] },
    })
    expect(moduleTriggers.statusCode).toBe(200)
    expect(moduleTriggers.json().event).toMatchObject({
      type: 'triggerDefinitions.replaced',
      // Module scripts/triggers rewrite only the `modules` table, so they emit
      // a module-scoped resource (distinct from character `characterRow`).
      resource: 'moduleTriggerDefinition',
      id: 'mod-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ regex?: Array<{ id: string }>; trigger?: Array<{ id: string }> }>
    }
    expect(database.characters[0].customscript[0].id).toBe('script-a')
    expect(database.characters[0].triggerscript[0].id).toBe('trigger-a')
    expect(persisted.modules[0].regex?.[0].id).toBe('module-script')
    expect(persisted.modules[0].trigger?.[0].id).toBe('module-trigger')
    expect(
      harness.commandEvents
        .list()
        .slice(-4)
        .map((event) => event.type),
    ).toEqual([
      'scriptDefinitions.replaced',
      'triggerDefinitions.replaced',
      'scriptDefinitions.replaced',
      'triggerDefinitions.replaced',
    ])
  })

  it('rejects malformed script and trigger definitions without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', customscript: [], triggerscript: [] }],
      characterOrder: ['char-a'],
    })

    const badScript = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        scripts: [{ id: 'script-a', comment: 'Bad', in: 1, out: '', type: 'editinput' }],
      },
    })
    expect(badScript.statusCode).toBe(400)
    expect(badScript.json().error).toBe('scripts[0].in must be a string')

    const missingScriptId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        scripts: [{ comment: 'Missing', in: '', out: '', type: 'editinput' }],
      },
    })
    expect(missingScriptId.statusCode).toBe(400)
    expect(missingScriptId.json().error).toBe('scripts[0].id must be a non-empty string')

    const duplicateScriptId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        scripts: [
          { id: 'script-a', comment: 'A', in: '', out: '', type: 'editinput' },
          { id: 'script-a', comment: 'B', in: '', out: '', type: 'editinput' },
        ],
      },
    })
    expect(duplicateScriptId.statusCode).toBe(400)
    expect(duplicateScriptId.json().error).toBe('Duplicate script definition id: script-a')

    const badTrigger = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        triggers: [{ id: 'trigger-a', comment: 'Bad', type: 'start', conditions: {}, effect: [] }],
      },
    })
    expect(badTrigger.statusCode).toBe(400)
    expect(badTrigger.json().error).toBe('triggers[0].conditions must be an array')

    const legacyTupleWrite = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        triggers: [{ id: 'trigger-a', comment: 'Legacy', type: ['start'], conditions: [], effect: [] }],
      },
    })
    expect(legacyTupleWrite.statusCode).toBe(400)
    expect(legacyTupleWrite.json().error).toBe('triggers[0].type must be a string')

    const missingTriggerId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        triggers: [{ comment: 'Missing', type: 'start', conditions: [], effect: [] }],
      },
    })
    expect(missingTriggerId.statusCode).toBe(400)
    expect(missingTriggerId.json().error).toBe('triggers[0].id must be a non-empty string')

    const duplicateTriggerId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        triggers: [
          { id: 'trigger-a', comment: 'A', type: 'start', conditions: [], effect: [] },
          { id: 'trigger-a', comment: 'B', type: 'start', conditions: [], effect: [] },
        ],
      },
    })
    expect(duplicateTriggerId.statusCode).toBe(400)
    expect(duplicateTriggerId.json().error).toBe('Duplicate trigger definition id: trigger-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].customscript).toEqual([])
    expect(bootstrap.resourceDatabase.characters[0].triggerscript).toEqual([])
  })

  it('replaces only the owned definition field on sparse raw character and module rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', customscript: [], triggerscript: [] }],
      characterOrder: ['char-a'],
      modules: [
        { id: 'mod-a', name: 'Mod A', regex: [], trigger: [] },
        { id: 'mod-b', name: 'Mod B', regex: [], trigger: [], opaque: { sibling: true } },
      ],
    })

    const invalidScript = { id: 'invalid-script', comment: 'Invalid', in: 17, out: '', type: 'editinput' }
    const invalidTrigger = {
      id: 'invalid-trigger',
      comment: 'Invalid',
      type: 'start',
      conditions: { legacy: true },
      effect: [],
    }
    const sparseCharacter = {
      chaId: 'char-a',
      customscript: [{ id: 'old-script', comment: 'Old', in: 'a', out: 'b', type: 'editinput' }],
      triggerscript: [invalidTrigger],
      opaque: { preserve: ['character', 1] },
    }
    const sparseModule = {
      id: 'mod-a',
      regex: [{ id: 'old-module-script', comment: 'Old', in: 'a', out: 'b', type: 'editinput' }],
      trigger: [invalidTrigger],
      opaque: { preserve: ['module', 1] },
    }
    const siblingModuleBefore = readJsonRow('modules', 'mod-b')
    writeJsonRow('characters', 'char-a', sparseCharacter)
    writeJsonRow('modules', 'mod-a', sparseModule)

    const script = { id: 'new-script', comment: 'New', in: 'x', out: 'y', type: 'editinput' }
    const characterScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [script] },
    })
    expect(characterScripts.statusCode, JSON.stringify(characterScripts.json())).toBe(200)
    revision = characterScripts.json().revision
    expect(readJsonRow('characters', 'char-a')).toEqual({ ...sparseCharacter, customscript: [script] })

    const moduleScript = { ...script, id: 'new-module-script' }
    const moduleScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [moduleScript] },
    })
    expect(moduleScripts.statusCode, JSON.stringify(moduleScripts.json())).toBe(200)
    revision = moduleScripts.json().revision
    expect(readJsonRow('modules', 'mod-a')).toEqual({ ...sparseModule, regex: [moduleScript] })
    expect(readJsonRow('modules', 'mod-b')).toEqual(siblingModuleBefore)

    const characterBeforeTrigger = {
      ...readJsonRow('characters', 'char-a'),
      customscript: [invalidScript],
    }
    const moduleBeforeTrigger = {
      ...readJsonRow('modules', 'mod-a'),
      regex: [invalidScript],
    }
    writeJsonRow('characters', 'char-a', characterBeforeTrigger)
    writeJsonRow('modules', 'mod-a', moduleBeforeTrigger)
    const trigger = { id: 'new-trigger', comment: 'New', type: 'start', conditions: [], effect: [] }

    const characterTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, triggers: [trigger] },
    })
    expect(characterTriggers.statusCode, JSON.stringify(characterTriggers.json())).toBe(200)
    revision = characterTriggers.json().revision
    expect(readJsonRow('characters', 'char-a')).toEqual({
      ...characterBeforeTrigger,
      triggerscript: [trigger],
    })

    const moduleTrigger = { ...trigger, id: 'new-module-trigger' }
    const moduleTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, triggers: [moduleTrigger] },
    })
    expect(moduleTriggers.statusCode, JSON.stringify(moduleTriggers.json())).toBe(200)
    expect(readJsonRow('modules', 'mod-a')).toEqual({
      ...moduleBeforeTrigger,
      trigger: [moduleTrigger],
    })
    expect(readJsonRow('modules', 'mod-b')).toEqual(siblingModuleBefore)
  })

  it('rejects duplicate raw character ids instead of silently selecting one', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        { chaId: 'char-a', name: 'A', customscript: [], triggerscript: [] },
        { chaId: 'char-b', name: 'B', customscript: [], triggerscript: [] },
      ],
      characterOrder: ['char-a', 'char-b'],
    })
    writeJsonRow('characters', 'char-a', { ...readJsonRow('characters', 'char-a'), chaId: 'duplicate' })
    writeJsonRow('characters', 'char-b', { ...readJsonRow('characters', 'char-b'), chaId: 'duplicate' })

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/duplicate/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [] },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Duplicate character id: duplicate')
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('script and trigger routes skip unrelated definition validation and keep target payload checks strict', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          customscript: [],
          triggerscript: [],
          chats: [],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          customscript: [],
          triggerscript: [],
          chats: [],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
      modules: [
        { id: 'mod-a', name: 'Mod A', regex: [], trigger: [] },
        { id: 'mod-b', name: 'Mod B', regex: [], trigger: [] },
      ],
    })

    const invalidScript = { id: 'bad-script', comment: 'Bad', in: 1, out: '', type: 'editinput' }
    const invalidTrigger = {
      id: 'bad-trigger',
      comment: 'Bad',
      type: 'start',
      conditions: {},
      effect: [],
    }
    writeJsonRow('characters', 'char-b', {
      ...readJsonRow('characters', 'char-b'),
      customscript: [invalidScript],
      triggerscript: [invalidTrigger],
    })
    writeJsonRow('modules', 'mod-b', {
      ...readJsonRow('modules', 'mod-b'),
      regex: [invalidScript],
      trigger: [invalidTrigger],
      lorebook: undefined,
    })

    const script = {
      id: 'script-a',
      comment: 'Regex',
      in: 'a',
      out: 'b',
      type: 'editinput',
    }
    const trigger = {
      id: 'trigger-a',
      comment: 'Start',
      type: 'start',
      conditions: [],
      effect: [],
    }

    const characterScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [script] },
    })
    expect(characterScripts.statusCode, JSON.stringify(characterScripts.json())).toBe(200)

    const characterTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, triggers: [trigger] },
    })
    expect(characterTriggers.statusCode, JSON.stringify(characterTriggers.json())).toBe(200)

    const moduleScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, scripts: [{ ...script, id: 'module-script' }] },
    })
    expect(moduleScripts.statusCode, JSON.stringify(moduleScripts.json())).toBe(200)

    const moduleTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, triggers: [{ ...trigger, id: 'module-trigger' }] },
    })
    expect(moduleTriggers.statusCode, JSON.stringify(moduleTriggers.json())).toBe(200)

    const malformedScripts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5, scripts: { id: 'not-an-array' } },
    })
    expect(malformedScripts.statusCode).toBe(400)
    expect(malformedScripts.json().error).toBe('scripts must be an array')

    const malformedTriggers = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5, triggers: { id: 'not-an-array' } },
    })
    expect(malformedTriggers.statusCode).toBe(400)
    expect(malformedTriggers.json().error).toBe('triggers must be an array')

    expect(readJsonRow('characters', 'char-b').customscript).toEqual([invalidScript])
    expect(readJsonRow('characters', 'char-b').triggerscript).toEqual([invalidTrigger])
    expect(readJsonRow('modules', 'mod-b').regex).toEqual([invalidScript])
    expect(readJsonRow('modules', 'mod-b').trigger).toEqual([invalidTrigger])
    expect(readJsonRow('modules', 'mod-b')).not.toHaveProperty('lorebook')
  })

  it('returns 404 and 409 for missing parents and stale script revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [],
      modules: [{ id: 'mod-a', name: 'Mod', mcp: { url: 'https://example.invalid' } }],
    })

    const missingCharacter = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/missing/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [] },
    })
    expect(missingCharacter.statusCode).toBe(404)
    expect(missingCharacter.json().error).toBe('Character not found: missing')

    const mcpModule = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, scripts: [] },
    })
    expect(mcpModule.statusCode).toBe(404)
    expect(mcpModule.json().error).toBe('Module not found: mod-a')

    const stale = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/missing/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, scripts: [] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('compact script and trigger definition mutations', () => {
  it('updates, creates, reorders, and deletes rows on all four definition owners', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const script = (id: string) => ({
      id,
      comment: `Script ${id}`,
      in: 'input',
      out: 'output',
      type: 'editinput',
      flag: 'g',
      removeMe: 'delete this',
      extension: { original: true },
    })
    const trigger = (id: string) => ({
      id,
      comment: `Trigger ${id}`,
      type: 'start',
      conditions: [],
      effect: [],
      removeMe: 'delete this',
      extension: { original: true },
    })
    let revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          customscript: [script('character-script')],
          triggerscript: [trigger('character-trigger')],
        },
      ],
      characterOrder: ['char-a'],
      modules: [
        {
          id: 'mod-a',
          name: 'Mod',
          regex: [script('module-script')],
          trigger: [trigger('module-trigger')],
        },
      ],
    })

    const targets = [
      {
        url: '/api/v1/commands/characters/char-a/scripts',
        table: 'characters' as const,
        ownerId: 'char-a',
        ownerKey: 'characterId',
        field: 'customscript',
        initialId: 'character-script',
        createdId: 'character-script-created',
        eventType: 'scriptDefinitions.replaced',
        resource: 'characterRow',
        row: script,
      },
      {
        url: '/api/v1/commands/characters/char-a/triggers',
        table: 'characters' as const,
        ownerId: 'char-a',
        ownerKey: 'characterId',
        field: 'triggerscript',
        initialId: 'character-trigger',
        createdId: 'character-trigger-created',
        eventType: 'triggerDefinitions.replaced',
        resource: 'characterRow',
        row: trigger,
      },
      {
        url: '/api/v1/commands/modules/mod-a/scripts',
        table: 'modules' as const,
        ownerId: 'mod-a',
        ownerKey: 'moduleId',
        field: 'regex',
        initialId: 'module-script',
        createdId: 'module-script-created',
        eventType: 'scriptDefinitions.replaced',
        resource: 'moduleScriptDefinition',
        row: script,
      },
      {
        url: '/api/v1/commands/modules/mod-a/triggers',
        table: 'modules' as const,
        ownerId: 'mod-a',
        ownerKey: 'moduleId',
        field: 'trigger',
        initialId: 'module-trigger',
        createdId: 'module-trigger-created',
        eventType: 'triggerDefinitions.replaced',
        resource: 'moduleTriggerDefinition',
        row: trigger,
      },
    ]

    for (const target of targets) {
      const request = async (mutation: Record<string, unknown>) => {
        const response = await harness.app.inject({
          method: 'PATCH',
          url: target.url,
          headers: { 'risu-auth': assertion },
          payload: { baseRevision: revision, mutation },
        })
        expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
        const body = response.json() as Record<string, unknown>
        expect(Object.keys(body).sort()).toEqual(
          target.ownerKey === 'characterId' ? ['characterId', 'event', 'revision'] : ['event', 'moduleId', 'revision'],
        )
        expect(body[target.ownerKey]).toBe(target.ownerId)
        expect(body).not.toHaveProperty('scripts')
        expect(body).not.toHaveProperty('triggers')
        expect(body).not.toHaveProperty('mutation')
        expect(body.event).toMatchObject({
          type: target.eventType,
          resource: target.resource,
          id: target.ownerId,
        })
        revision = body.revision as number
      }
      const readRows = () => readJsonRow(target.table, target.ownerId)[target.field] as Array<Record<string, unknown>>

      await request({
        op: 'update',
        id: target.initialId,
        patch: {
          comment: `Updated ${target.initialId}`,
          extension: { original: true, updated: true },
          addedUnknown: ['preserved'],
        },
        deleteKeys: ['removeMe'],
      })
      expect(readRows()).toHaveLength(1)
      expect(readRows()[0]).toMatchObject({
        id: target.initialId,
        comment: `Updated ${target.initialId}`,
        extension: { original: true, updated: true },
        addedUnknown: ['preserved'],
      })
      expect(readRows()[0]).not.toHaveProperty('removeMe')

      const createdRow = { ...target.row(target.createdId), extension: { created: true } }
      await request({ op: 'create', row: createdRow, index: 0 })
      expect(readRows().map((row) => row.id)).toEqual([target.createdId, target.initialId])
      expect(readRows()[0].extension).toEqual({ created: true })

      await request({ op: 'reorder', ids: [target.initialId, target.createdId] })
      expect(readRows().map((row) => row.id)).toEqual([target.initialId, target.createdId])

      await request({ op: 'delete', id: target.initialId })
      expect(readRows()).toEqual([createdRow])
    }
  })

  it('strictly validates mutation shapes and row-level operations without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          customscript: [
            { id: 'script-a', comment: 'A', in: 'a', out: 'b', type: 'editinput' },
            { id: 'script-b', comment: 'B', in: 'b', out: 'c', type: 'editinput' },
          ],
          triggerscript: [],
        },
      ],
      characterOrder: ['char-a'],
    })
    const url = '/api/v1/commands/characters/char-a/scripts'
    const cases: Array<{
      name: string
      payload: Record<string, unknown>
      status?: number
      error: string
    }> = [
      {
        name: 'legacy scripts field',
        payload: { baseRevision: revision, mutation: { op: 'delete', id: 'script-a' }, scripts: [] },
        error: 'body.scripts is not supported for definition mutation commands',
      },
      {
        name: 'unknown update key',
        payload: {
          baseRevision: revision,
          mutation: { op: 'update', id: 'script-a', patch: { comment: 'x' }, extra: true },
        },
        error: 'mutation.extra is not supported for update',
      },
      {
        name: 'empty update',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'script-a' } },
        error: 'update mutation must include patch fields or deleteKeys',
      },
      {
        name: 'blank update id',
        payload: { baseRevision: revision, mutation: { op: 'update', id: ' ', patch: { comment: 'x' } } },
        error: 'mutation.id must be a non-empty string',
      },
      {
        name: 'id patch',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'script-a', patch: { id: 'new' } } },
        error: 'mutation.patch.id is not supported',
      },
      {
        name: 'id deletion',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'script-a', deleteKeys: ['id'] } },
        error: 'mutation.deleteKeys cannot include id',
      },
      {
        name: 'duplicate delete key',
        payload: {
          baseRevision: revision,
          mutation: { op: 'update', id: 'script-a', deleteKeys: ['comment', 'comment'] },
        },
        error: 'Duplicate mutation.deleteKeys field: comment',
      },
      {
        name: 'patch and delete overlap',
        payload: {
          baseRevision: revision,
          mutation: { op: 'update', id: 'script-a', patch: { comment: 'x' }, deleteKeys: ['comment'] },
        },
        error: 'mutation.deleteKeys cannot also patch comment',
      },
      {
        name: 'invalid resulting row',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'script-a', patch: { in: 17 } } },
        error: 'scripts[0].in must be a string',
      },
      {
        name: 'missing update target',
        payload: { baseRevision: revision, mutation: { op: 'update', id: 'missing', patch: { comment: 'x' } } },
        status: 404,
        error: 'Script definition not found: missing',
      },
      {
        name: 'unknown create key',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { id: 'script-c', comment: 'C', in: '', out: '', type: 'editinput' },
            index: 0,
            extra: true,
          },
        },
        error: 'mutation.extra is not supported for create',
      },
      {
        name: 'negative create index',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { id: 'script-c', comment: 'C', in: '', out: '', type: 'editinput' },
            index: -1,
          },
        },
        error: 'mutation.index must be a non-negative integer',
      },
      {
        name: 'large create index',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { id: 'script-c', comment: 'C', in: '', out: '', type: 'editinput' },
            index: 3,
          },
        },
        error: 'mutation.index must be at most 2',
      },
      {
        name: 'duplicate create id',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { id: 'script-a', comment: 'C', in: '', out: '', type: 'editinput' },
            index: 0,
          },
        },
        error: 'Duplicate script definition id: script-a',
      },
      {
        name: 'missing create id',
        payload: {
          baseRevision: revision,
          mutation: {
            op: 'create',
            row: { comment: 'C', in: '', out: '', type: 'editinput' },
            index: 0,
          },
        },
        error: 'scripts[0].id must be a non-empty string',
      },
      {
        name: 'unknown delete key',
        payload: { baseRevision: revision, mutation: { op: 'delete', id: 'script-a', extra: true } },
        error: 'mutation.extra is not supported for delete',
      },
      {
        name: 'missing delete target',
        payload: { baseRevision: revision, mutation: { op: 'delete', id: 'missing' } },
        status: 404,
        error: 'Script definition not found: missing',
      },
      {
        name: 'unknown reorder key',
        payload: {
          baseRevision: revision,
          mutation: { op: 'reorder', ids: ['script-a', 'script-b'], extra: true },
        },
        error: 'mutation.extra is not supported for reorder',
      },
      {
        name: 'duplicate reorder id',
        payload: { baseRevision: revision, mutation: { op: 'reorder', ids: ['script-a', 'script-a'] } },
        error: 'Duplicate definition id in mutation.ids: script-a',
      },
      {
        name: 'blank reorder id',
        payload: { baseRevision: revision, mutation: { op: 'reorder', ids: ['script-a', ' '] } },
        error: 'mutation.ids[1] must be a non-empty string',
      },
      {
        name: 'unknown reorder id',
        payload: { baseRevision: revision, mutation: { op: 'reorder', ids: ['script-a', 'missing'] } },
        error: 'Unknown script definition id in mutation.ids: missing',
      },
      {
        name: 'incomplete reorder',
        payload: { baseRevision: revision, mutation: { op: 'reorder', ids: ['script-a'] } },
        error: 'mutation.ids must include every script definition',
      },
      {
        name: 'unsupported operation',
        payload: { baseRevision: revision, mutation: { op: 'replace', ids: [] } },
        error: 'Unsupported definition mutation operation: replace',
      },
    ]

    for (const testCase of cases) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url,
        headers: { 'risu-auth': assertion },
        payload: testCase.payload,
      })
      expect(response.statusCode, testCase.name).toBe(testCase.status ?? 400)
      expect(response.json().error, testCase.name).toBe(testCase.error)
    }

    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('creates into absent arrays, rejects present non-arrays, malformed current ids, and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A' }],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod' }],
    })
    writeJsonRow('characters', 'char-a', { chaId: 'char-a', opaque: { exact: true } })
    writeJsonRow('modules', 'mod-a', { id: 'mod-a', opaque: { exact: true } })

    const characterCreate = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: {
          op: 'create',
          row: { id: 'script-a', comment: 'A', in: '', out: '', type: 'editinput', unknown: { keep: true } },
          index: 0,
        },
      },
    })
    expect(characterCreate.statusCode, JSON.stringify(characterCreate.json())).toBe(200)
    revision = characterCreate.json().revision
    expect(readJsonRow('characters', 'char-a')).toEqual({
      chaId: 'char-a',
      opaque: { exact: true },
      customscript: [{ id: 'script-a', comment: 'A', in: '', out: '', type: 'editinput', unknown: { keep: true } }],
    })

    const moduleCreate = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: {
          op: 'create',
          row: { id: 'trigger-a', comment: 'A', type: 'start', conditions: [], effect: [] },
          index: 0,
        },
      },
    })
    expect(moduleCreate.statusCode, JSON.stringify(moduleCreate.json())).toBe(200)
    revision = moduleCreate.json().revision
    expect(readJsonRow('modules', 'mod-a')).toEqual({
      id: 'mod-a',
      opaque: { exact: true },
      trigger: [{ id: 'trigger-a', comment: 'A', type: 'start', conditions: [], effect: [] }],
    })

    writeJsonRow('characters', 'char-a', {
      ...readJsonRow('characters', 'char-a'),
      triggerscript: { legacy: true },
    })
    const nonArray = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/triggers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: {
          op: 'create',
          row: { id: 'trigger-b', comment: 'B', type: 'start', conditions: [], effect: [] },
          index: 0,
        },
      },
    })
    expect(nonArray.statusCode).toBe(400)
    expect(nonArray.json().error).toBe('triggers must be an array')

    writeJsonRow('modules', 'mod-a', {
      ...readJsonRow('modules', 'mod-a'),
      regex: [
        { id: 'duplicate', comment: 'A', in: '', out: '', type: 'editinput' },
        { id: 'duplicate', comment: 'B', in: '', out: '', type: 'editinput' },
      ],
    })
    const duplicateCurrentIds = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: { op: 'update', id: 'duplicate', patch: { comment: 'Updated' } },
      },
    })
    expect(duplicateCurrentIds.statusCode).toBe(400)
    expect(duplicateCurrentIds.json().error).toBe('Duplicate script definition id: duplicate')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/scripts',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision - 1, mutation: { op: 'delete', id: 'script-a' } },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: revision })
  })
})

describe('module record and enablement commands', () => {
  it('creates MCP modules while rejecting malformed MCP identifiers', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [],
    })

    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        module: {
          id: 'mcp-invalid',
          name: 'Invalid MCP',
          description: '',
          mcp: { url: 'http://remote.example/mcp' },
        },
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('module.mcp.url must be a supported MCP identifier')

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        module: {
          id: 'mcp-dice',
          name: 'Dice Tool',
          description: 'Imported MCP module',
          mcp: { url: 'internal:dice' },
          lorebook: [{ comment: 'MCP Info', content: '@@mcp', alwaysActive: true }],
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: revision + 1,
      moduleId: 'mcp-dice',
      event: { type: 'module.created', id: 'mcp-dice' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision + 1)
    expect(bootstrap.resourceDatabase.modules).toContainEqual(
      expect.objectContaining({
        id: 'mcp-dice',
        mcp: { url: 'internal:dice' },
        lorebook: [expect.objectContaining({ comment: 'MCP Info' })],
      }),
    )
  })

  it('creates, patches, enables, reorders, relinks, and deletes modules', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: ['mod-a'],
      modules: [
        { id: 'mod-a', name: 'A', description: 'Alpha' },
        { id: 'mod-b', name: 'B', description: 'Beta' },
        { id: 'mcp-a', name: 'MCP', description: 'Bridge', mcp: { url: 'internal:risuai' } },
      ],
      personas: [
        { id: 'persona-a', name: 'Persona', icon: '', personaPrompt: '', note: '', modules: ['mod-a', 'mod-b'] },
      ],
      selectedPersona: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          modules: ['mod-a', 'mod-b'],
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: '',
              message: [],
              localLore: [],
              modules: ['mod-a', 'mod-b'],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      loadouts: [{ id: 'loadout-a', name: 'L', modules: ['mod-a', 'mod-b'] }],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        module: { id: 'mod-c', name: 'C', description: 'Gamma', namespace: 'ns-c' },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'module.created',
        revision: 2,
        resource: 'moduleCreated',
        id: 'mod-c',
      },
      moduleId: 'mod-c',
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-c',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 2,
        patch: {
          name: 'Renamed C',
          hideIcon: true,
          backgroundEmbedding: '<style>.chattext .name { color: red; }</style>',
          customModuleToggle: 'toggle',
          scriptModelOverrides: { llmProfileId: 'module-main-profile' },
        },
      },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().event.type).toBe('module.updated')

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, moduleId: 'mod-b', enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      revision: 4,
      moduleId: 'mod-b',
      enabled: true,
      event: { type: 'module.enabled', id: 'mod-b' },
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, moduleIds: ['mod-c', 'mod-b', 'mod-a', 'mcp-a'] },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event.type).toBe('module.reordered')

    const characterLinks = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5, moduleIds: ['mod-b', 'mod-a'] },
    })
    expect(characterLinks.statusCode).toBe(200)
    expect(characterLinks.json()).toMatchObject({
      revision: 6,
      characterId: 'char-a',
      event: { type: 'character.modules.reordered', id: 'char-a' },
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/modules/mod-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 6 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event.type).toBe('module.deleted')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    expect(bootstrap.json().revision).toBe(7)
    expect(database.modules.map((module: { id: string }) => module.id)).toEqual(['mod-c', 'mod-a', 'mcp-a'])
    expect(database.modules[0]).toMatchObject({
      id: 'mod-c',
      name: 'Renamed C',
      hideIcon: true,
      backgroundEmbedding: '<style>.chattext .name { color: red; }</style>',
      customModuleToggle: 'toggle',
      scriptModelOverrides: { llmProfileId: 'module-main-profile' },
    })
    expect(database.enabledModules).toEqual(['mod-a'])
    expect(database.personas[0].modules).toEqual(['mod-a'])
    expect(database.characters[0].modules).toEqual(['mod-a'])
    expect(database.characters[0].chats[0].modules).toEqual(['mod-a'])
    expect(database.loadouts[0].modules).toEqual(['mod-a'])
    expect(
      harness.commandEvents
        .list()
        .slice(-6)
        .map((event) => event.type),
    ).toEqual([
      'module.created',
      'module.updated',
      'module.enabled',
      'module.reordered',
      'character.modules.reordered',
      'module.deleted',
    ])
  })

  it('creates, renames, reorders, assigns, and atomically deletes module folders', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      moduleFolders: [],
      modules: [
        { id: 'mod-a', name: 'A', description: 'Alpha' },
        { id: 'mod-b', name: 'B', description: 'Beta' },
      ],
    })

    const createdA = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/module-folders',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, folder: { id: 'folder-a', name: 'Writing' } },
    })
    expect(createdA.statusCode).toBe(200)
    expect(createdA.json()).toMatchObject({
      revision: revision + 1,
      folderId: 'folder-a',
      event: { type: 'moduleFolder.created', resource: 'moduleFolders', id: 'folder-a' },
    })

    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/module-folders/folder-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, patch: { name: 'Prompts' } },
    })
    expect(renamed.statusCode).toBe(200)

    const createdB = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/module-folders',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 2, folder: { id: 'folder-b', name: 'Tools' } },
    })
    expect(createdB.statusCode).toBe(200)

    const reorderedFolders = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/module-folders/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 3, folderIds: ['folder-b', 'folder-a'] },
    })
    expect(reorderedFolders.statusCode).toBe(200)

    const organized = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 4,
        moduleIds: ['mod-b', 'mod-a'],
        folderByModuleId: { 'mod-a': 'folder-a', 'mod-b': 'folder-b' },
      },
    })
    expect(organized.statusCode).toBe(200)

    const incomplete = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 5,
        moduleIds: ['mod-b', 'mod-a'],
        folderByModuleId: { 'mod-a': 'folder-a' },
      },
    })
    expect(incomplete.statusCode).toBe(400)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/module-folders/folder-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 5 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event).toMatchObject({
      type: 'moduleFolder.deleted',
      resource: 'moduleOrganization',
      id: 'folder-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.moduleFolders).toEqual([{ id: 'folder-b', name: 'Tools' }])
    expect(bootstrap.resourceDatabase.modules).toEqual([
      expect.objectContaining({ id: 'mod-b', folderId: 'folder-b' }),
      expect.not.objectContaining({ folderId: expect.anything() }),
    ])
  })

  it('deletes an MCP module and all of its references', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: ['mcp-a'],
      modules: [{ id: 'mcp-a', name: 'MCP', description: 'Bridge', mcp: { url: 'internal:risuai' } }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          modules: ['mcp-a'],
          chats: [{ id: 'chat-a', name: 'Chat', note: '', message: [], localLore: [], modules: ['mcp-a'] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      loadouts: [{ id: 'loadout-a', name: 'L', modules: ['mcp-a'] }],
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/modules/mcp-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })

    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: revision + 1,
      moduleId: 'mcp-a',
      event: { type: 'module.deleted', id: 'mcp-a' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    expect(database.modules).toEqual([])
    expect(database.enabledModules).toEqual([])
    expect(database.characters[0].modules).toEqual([])
    expect(database.characters[0].chats[0].modules).toEqual([])
    expect(database.loadouts[0].modules).toEqual([])
  })

  it('globally enables an MCP module', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [{ id: 'mcp-a', name: 'MCP', description: 'Bridge', mcp: { url: 'internal:risuai' } }],
    })

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, moduleId: 'mcp-a', enabled: true },
    })

    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      revision: revision + 1,
      moduleId: 'mcp-a',
      enabled: true,
      event: { type: 'module.enabled', id: 'mcp-a' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.enabledModules).toEqual(['mcp-a'])
  })

  it('adds and removes character module links, not only reorders', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [
        { id: 'mod-a', name: 'A', description: 'Alpha' },
        { id: 'mod-b', name: 'B', description: 'Beta' },
        { id: 'mcp-a', name: 'MCP', description: '', mcp: { url: 'internal:risuai' } },
      ],
      characters: [{ chaId: 'char-a', name: 'A', modules: [], chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })

    // Add a previously unlinked module.
    const added = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, moduleIds: ['mod-a'] },
    })
    expect(added.statusCode).toBe(200)
    expect(added.json()).toMatchObject({
      revision: 2,
      characterId: 'char-a',
      event: { type: 'character.modules.reordered', id: 'char-a' },
    })

    // Add a second module on top of the first.
    const addedSecond = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, moduleIds: ['mod-a', 'mod-b'] },
    })
    expect(addedSecond.statusCode).toBe(200)

    let bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].modules).toEqual(['mod-a', 'mod-b'])

    // Remove the first module, keeping the second.
    const removed = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, moduleIds: ['mod-b'] },
    })
    expect(removed.statusCode).toBe(200)

    bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(4)
    expect(bootstrap.resourceDatabase.characters[0].modules).toEqual(['mod-b'])

    // Unknown module ids are still rejected.
    const badAdd = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, moduleIds: ['mod-b', 'mod-missing'] },
    })
    expect(badAdd.statusCode).toBe(400)
    expect(badAdd.json().error).toBe('Unknown module id in moduleIds: mod-missing')
    expect(bootstrap.json().revision).toBe(4)

    const badMcpAdd = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, moduleIds: ['mod-b', 'mcp-a'] },
    })
    expect(badMcpAdd.statusCode).toBe(400)
    expect(badMcpAdd.json().error).toBe('Unknown module id in moduleIds: mcp-a')
  })

  it('deletes optional module fields through null patch sentinels', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [
        {
          id: 'mod-a',
          name: 'A',
          description: '',
          namespace: 'old-namespace',
          backgroundEmbedding: 'old background',
          cjs: 'old cjs',
          assets: [],
        },
      ],
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { namespace: null, backgroundEmbedding: null, cjs: null, assets: null },
      },
    })
    expect(patched.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.modules[0]).not.toHaveProperty('namespace')
    expect(bootstrap.resourceDatabase.modules[0]).not.toHaveProperty('backgroundEmbedding')
    expect(bootstrap.resourceDatabase.modules[0]).not.toHaveProperty('cjs')
    expect(bootstrap.resourceDatabase.modules[0]).not.toHaveProperty('assets')

    const invalidPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, patch: { name: null } },
    })
    expect(invalidPatch.statusCode).toBe(400)
    expect(invalidPatch.json().error).toBe('patch.name cannot be deleted')

    const invalidCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        module: { id: 'mod-b', name: 'B', description: '', cjs: null },
      },
    })
    expect(invalidCreate.statusCode).toBe(400)
    expect(invalidCreate.json().error).toBe('module.cjs cannot be deleted')
  })

  it('rejects malformed module commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [{ id: 'mod-a', name: 'A', description: '' }],
      characters: [{ chaId: 'char-a', name: 'A', modules: ['mod-a'] }],
      characterOrder: ['char-a'],
    })

    const badPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { assets: [['bad.png', 'assets/bad.png', 'png']] },
      },
    })
    expect(badPatch.statusCode).toBe(400)
    expect(badPatch.json().error).toBe('patch.assets[0][1] must be a server asset id')

    const badScriptModelOverrides = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { scriptModelOverrides: { modelId: 'raw-model' } },
      },
    })
    expect(badScriptModelOverrides.statusCode).toBe(400)
    expect(badScriptModelOverrides.json().error).toBe('patch.scriptModelOverrides.modelId is not supported')

    const badEnable = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, moduleId: 'mod-a', enabled: 'yes' },
    })
    expect(badEnable.statusCode).toBe(400)
    expect(badEnable.json().error).toBe('enabled must be a boolean')

    const badReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, moduleIds: ['mod-a', 'mod-a'] },
    })
    expect(badReorder.statusCode).toBe(400)
    expect(badReorder.json().error).toBe('Duplicate module id in moduleIds: mod-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.modules).toEqual([{ id: 'mod-a', name: 'A', description: '' }])
  })

  it('returns 404 for MCP module patches and 409 for stale module revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modules: [{ id: 'mcp-a', name: 'MCP', description: '', mcp: { url: 'internal:risuai' } }],
    })

    const mcpPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mcp-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'Nope' } },
    })
    expect(mcpPatch.statusCode).toBe(404)
    expect(mcpPatch.json().error).toBe('Module not found: mcp-a')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, moduleId: 'mcp-a', enabled: true },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('plugin record and configuration commands', () => {
  it.each([2, '2.1'] as const)('rejects V%s-series plugin records without bumping revision', async (version) => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { plugins: [] })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        plugin: {
          name: 'unsupported-plugin',
          script: 'void 0',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version,
        },
      },
    })

    expect(created.statusCode).toBe(400)
    expect(created.json().error).toBe(`plugin.version must be "3.0"; Fastify does not support V2-series plugins`)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.plugins).toEqual([])
  })

  it('creates, patches, enables, selects provider, reorders, and deletes plugins', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentPluginProvider: 'plugin-a',
      plugins: [
        {
          name: 'plugin-a',
          script: 'Risuai.log("A")',
          arguments: { token: 'string' },
          realArg: { token: '' },
          customLink: [],
          argMeta: {},
          version: '3.0',
          enabled: true,
        },
        {
          name: 'plugin-b',
          script: 'Risuai.log("B")',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
          enabled: false,
        },
      ],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        plugin: {
          name: 'plugin-c',
          script: 'Risuai.log("C")',
          arguments: { mode: ['fast', 'slow'] },
          realArg: { mode: 'fast' },
          customLink: [{ link: 'https://example.com', hoverText: 'Docs' }],
          argMeta: { mode: { name: 'Mode' } },
          version: '3.0',
          enabled: true,
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: 2,
      pluginId: 'plugin-c',
      event: { type: 'plugin.created', resource: 'pluginCollection', id: 'plugin-c' },
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/plugin-c',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 2,
        patch: { realArg: { mode: 'slow' }, displayName: 'Plugin C' },
      },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().event).toMatchObject({ type: 'plugin.updated', resource: 'pluginCollection' })

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/plugin-b/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      revision: 4,
      pluginId: 'plugin-b',
      enabled: true,
      event: { type: 'plugin.enabled', resource: 'pluginCollection', id: 'plugin-b' },
    })

    const provider = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/provider',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, provider: 'provider-c' },
    })
    expect(provider.statusCode).toBe(200)
    expect(provider.json()).toMatchObject({
      revision: 5,
      provider: 'provider-c',
      event: { type: 'plugin.provider.selected', resource: 'pluginProvider', id: 'provider-c' },
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5, pluginIds: ['plugin-c', 'plugin-b', 'plugin-a'] },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event).toMatchObject({ type: 'plugin.reordered', resource: 'pluginCollection' })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/plugins/plugin-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 6 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event).toMatchObject({ type: 'plugin.deleted', resource: 'pluginCollection' })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    expect(bootstrap.json().revision).toBe(7)
    expect(database.plugins.map((plugin: { name: string }) => plugin.name)).toEqual(['plugin-c', 'plugin-b'])
    expect(database.plugins[0]).toMatchObject({
      name: 'plugin-c',
      displayName: 'Plugin C',
      realArg: { mode: 'slow' },
    })
    expect(database.plugins[1].enabled).toBe(true)
    expect(database.currentPluginProvider).toBe('provider-c')
    expect(
      harness.commandEvents
        .list()
        .slice(-6)
        .map((event) => event.type),
    ).toEqual([
      'plugin.created',
      'plugin.updated',
      'plugin.enabled',
      'plugin.provider.selected',
      'plugin.reordered',
      'plugin.deleted',
    ])
  })

  it('deletes optional plugin fields through null patch sentinels', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      plugins: [
        {
          name: 'plugin-a',
          script: 'Risuai.log("A")',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
          displayName: 'Plugin A',
          updateURL: 'https://plugins.example/plugin-a.js',
          allowedIPC: ['channel-a'],
          enabled: true,
        },
      ],
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/plugin-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { displayName: null, updateURL: null, allowedIPC: null },
      },
    })
    expect(patched.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.plugins[0]).not.toHaveProperty('displayName')
    expect(bootstrap.resourceDatabase.plugins[0]).not.toHaveProperty('updateURL')
    expect(bootstrap.resourceDatabase.plugins[0]).not.toHaveProperty('allowedIPC')

    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/plugin-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, patch: { script: null } },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('patch.script cannot be deleted')
  })

  it('rejects malformed plugin commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      plugins: [
        {
          name: 'plugin-a',
          script: '',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
        },
      ],
    })

    const badPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/plugin-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'renamed' } },
    })
    expect(badPatch.statusCode).toBe(400)
    expect(badPatch.json().error).toBe('patch.name cannot be changed by plugin commands')

    const badEnable = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/plugin-a/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, enabled: 'yes' },
    })
    expect(badEnable.statusCode).toBe(400)
    expect(badEnable.json().error).toBe('enabled must be a boolean')

    const badReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, pluginIds: ['plugin-a', 'plugin-a'] },
    })
    expect(badReorder.statusCode).toBe(400)
    expect(badReorder.json().error).toBe('Duplicate plugin id in pluginIds: plugin-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.plugins[0].name).toBe('plugin-a')
  })

  it('returns 404 for missing plugins and 409 for stale plugin revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, {
      plugins: [
        {
          name: 'plugin-a',
          script: '',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
        },
      ],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/missing',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 1, patch: { enabled: true } },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Plugin not found: missing')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/plugin-a/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, enabled: true },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('plugin-storage commands', () => {
  it('puts, deletes, and bulk updates plugin custom storage', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      pluginCustomStorage: {
        old: 'value',
        keep: true,
      },
    })

    const put = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/plugin-storage/theme',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, value: { mode: 'dark' } },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({
      revision: 2,
      key: 'theme',
      event: { type: 'pluginStorage.updated', resource: 'pluginStorage', id: 'theme' },
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/plugin-storage/old',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 3,
      key: 'old',
      event: { type: 'pluginStorage.deleted', id: 'old' },
    })

    const bulk = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugin-storage/bulk',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 3,
        values: { score: 42, nested: { ok: true } },
        deleteKeys: ['keep'],
      },
    })
    expect(bulk.statusCode).toBe(200)
    expect(bulk.json()).toMatchObject({
      revision: 4,
      event: { type: 'pluginStorage.bulkUpdated', resource: 'pluginStorage' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(4)
    expect(bootstrap.resourceDatabase.pluginCustomStorage).toEqual({
      theme: { mode: 'dark' },
      score: 42,
      nested: { ok: true },
    })
    expect(
      harness.commandEvents
        .list()
        .slice(-3)
        .map((event) => event.type),
    ).toEqual(['pluginStorage.updated', 'pluginStorage.deleted', 'pluginStorage.bulkUpdated'])
  })

  it('rejects malformed plugin-storage commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      pluginCustomStorage: { existing: 'value' },
    })

    const badKey = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/plugin-storage/%20',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, value: 'x' },
    })
    expect(badKey.statusCode).toBe(400)
    expect(badKey.json().error).toBe('key must be a non-empty string')

    const badBulk = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugin-storage/bulk',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, values: {}, deleteKeys: [] },
    })
    expect(badBulk.statusCode).toBe(400)
    expect(badBulk.json().error).toBe('bulk plugin storage command must change at least one key')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.pluginCustomStorage).toEqual({ existing: 'value' })
  })

  it('returns 409 for stale plugin-storage revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, {
      pluginCustomStorage: {},
    })

    const stale = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/plugin-storage/key',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, value: 'x' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('asset reference commands', () => {
  it('persists uploaded asset ids through owning character, module, persona, settings, and folder commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const firstAsset = await uploadAsset(harness.app, assertion, Buffer.from('first'))
    const secondAsset = await uploadAsset(harness.app, assertion, Buffer.from('second'))
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      username: 'User',
      userIcon: '',
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
      selectedPersona: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          image: '',
          emotionImages: [],
          additionalAssets: [],
          ccAssets: [],
          chats: [],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Module', description: '', assets: [] }],
    })

    const createdCharacter = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          vits: { files: { greeting: firstAsset.assetId } },
          gptSoVitsConfig: {
            ref_audio_data: { fileName: 'ref.wav', assetId: secondAsset.assetId },
          },
          chats: [],
          chatFolders: [],
        },
      },
    })
    expect(createdCharacter.statusCode).toBe(200)
    expect(createdCharacter.json().event).toMatchObject({
      type: 'character.created',
      resource: 'character',
      id: 'char-b',
    })

    const character = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: createdCharacter.json().revision,
        patch: {
          image: firstAsset.assetId,
          emotionImages: [['happy', firstAsset.assetId]],
          additionalAssets: [['extra.png', secondAsset.assetId, 'png']],
          ccAssets: [{ type: 'icon', uri: secondAsset.assetId, name: 'alt', ext: 'png' }],
          prebuiltAssetExclude: [secondAsset.assetId],
          vits: { files: { greeting: firstAsset.assetId } },
          gptSoVitsConfig: {
            ref_audio_data: { fileName: 'ref.wav', assetId: secondAsset.assetId },
          },
        },
      },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json().event).toMatchObject({
      type: 'character.updated',
      resource: 'characterRow',
      id: 'char-a',
    })

    const module = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: character.json().revision,
        patch: { assets: [['module.png', firstAsset.assetId, 'png']] },
      },
    })
    expect(module.statusCode).toBe(200)
    expect(module.json().event).toMatchObject({ type: 'module.updated', id: 'mod-a' })

    const persona = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: module.json().revision,
        patch: { icon: secondAsset.assetId },
        mirrorLegacyProfile: true,
      },
    })
    expect(persona.statusCode).toBe(200)

    const settings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: persona.json().revision,
        patch: { customBackground: firstAsset.assetId },
      },
    })
    expect(settings.statusCode).toBe(200)

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: settings.json().revision,
        characterOrder: [
          {
            id: 'folder-a',
            name: 'Folder A',
            color: '',
            imgFile: secondAsset.assetId,
            img: `/api/v1/assets/${secondAsset.assetId}`,
            data: ['char-a', 'char-b'],
          },
        ],
      },
    })
    expect(reordered.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    expect(database.characters[0]).toMatchObject({
      image: firstAsset.assetId,
      emotionImages: [['happy', firstAsset.assetId]],
      additionalAssets: [['extra.png', secondAsset.assetId, 'png']],
      ccAssets: [{ type: 'icon', uri: secondAsset.assetId, name: 'alt', ext: 'png' }],
      prebuiltAssetExclude: [secondAsset.assetId],
      vits: { files: { greeting: firstAsset.assetId } },
      gptSoVitsConfig: {
        ref_audio_data: { fileName: 'ref.wav', assetId: secondAsset.assetId },
      },
    })
    expect(await projectedCharacterRow(harness.app, assertion, 'char-b')).toMatchObject({
      chaId: 'char-b',
      vits: { files: { greeting: firstAsset.assetId } },
      gptSoVitsConfig: {
        ref_audio_data: { fileName: 'ref.wav', assetId: secondAsset.assetId },
      },
    })
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ assets?: unknown[] }>
    }
    expect(persisted.modules[0].assets).toEqual([['module.png', firstAsset.assetId, 'png']])
    expect(database.personas[0].icon).toBe(secondAsset.assetId)
    expect(database.customBackground).toBe(firstAsset.assetId)
    expect(database.characterOrder[0].imgFile).toBe(secondAsset.assetId)
  })

  it('rejects malformed and missing asset references without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const uploaded = await uploadAsset(harness.app, assertion, Buffer.from('valid-ref'))
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Module', description: '' }],
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
      selectedPersona: 0,
    })
    const missingAssetId = '0'.repeat(64)

    const malformed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { image: 'assets/not-server.png' } },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error).toBe('patch.image must be a server asset id')

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { assets: [['missing.png', missingAssetId, 'png']] },
      },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toBe('patch.assets[0][1] references a missing server asset')

    const missingOrderImage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        characterOrder: [
          {
            id: 'folder-a',
            name: 'Folder A',
            color: '',
            img: missingAssetId,
            data: ['char-a'],
          },
        ],
      },
    })
    expect(missingOrderImage.statusCode).toBe(400)
    expect(missingOrderImage.json().error).toBe('characterOrder[0].img references a missing server asset')

    const valid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { icon: uploaded.assetId } },
    })
    expect(valid.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision + 1)
    expect(bootstrap.resourceDatabase.characters[0].image).toBeUndefined()
    expect(bootstrap.resourceDatabase.modules[0].assets).toBeUndefined()
    expect(bootstrap.resourceDatabase.personas[0].icon).toBe(uploaded.assetId)
  })

  it('rejects malformed and missing character audio asset refs on create and patch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })
    const missingAssetId = '0'.repeat(64)

    const malformedCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          vits: { files: { greeting: 'assets/not-server.wav' } },
        },
      },
    })
    expect(malformedCreate.statusCode).toBe(400)
    expect(malformedCreate.json().error).toBe('character.vits.files.greeting must be a server asset id')

    const missingCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          gptSoVitsConfig: {
            ref_audio_data: { fileName: 'ref.wav', assetId: missingAssetId },
          },
        },
      },
    })
    expect(missingCreate.statusCode).toBe(400)
    expect(missingCreate.json().error).toBe(
      'character.gptSoVitsConfig.ref_audio_data.assetId references a missing server asset',
    )

    const malformedPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          gptSoVitsConfig: {
            ref_audio_data: { fileName: 'ref.wav', assetId: 'assets/not-server.wav' },
          },
        },
      },
    })
    expect(malformedPatch.statusCode).toBe(400)
    expect(malformedPatch.json().error).toBe('patch.gptSoVitsConfig.ref_audio_data.assetId must be a server asset id')

    const missingPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { vits: { files: { greeting: missingAssetId } } },
      },
    })
    expect(missingPatch.statusCode).toBe(400)
    expect(missingPatch.json().error).toBe('patch.vits.files.greeting references a missing server asset')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.characters).toHaveLength(1)
    expect(bootstrap.resourceDatabase.characters[0]).toMatchObject({
      chaId: 'char-a',
      name: 'A',
      chats: [],
      chatFolders: [],
    })
    expect(bootstrap.resourceDatabase.characters[0].vits).toBeUndefined()
    expect(bootstrap.resourceDatabase.characters[0].gptSoVitsConfig).toBeUndefined()
  })

  it('accepts optional character audio clear refs on create and patch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })
    const clearValues = [null, '', '-'] as const

    for (const [index, clearValue] of clearValues.entries()) {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/commands/characters',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          character: {
            chaId: `char-clear-${index}`,
            name: `Clear ${index}`,
            vits: { files: { greeting: clearValue } },
            gptSoVitsConfig: {
              ref_audio_data: { fileName: 'ref.wav', assetId: clearValue },
            },
          },
        },
      })
      expect(created.statusCode).toBe(200)
      revision = created.json().revision

      const patched = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/characters/char-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: {
            vits: { files: { greeting: clearValue } },
            gptSoVitsConfig: {
              ref_audio_data: { fileName: 'ref.wav', assetId: clearValue },
            },
          },
        },
      })
      expect(patched.statusCode).toBe(200)
      revision = patched.json().revision
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    for (const [index, clearValue] of clearValues.entries()) {
      expect(await projectedCharacterRow(harness.app, assertion, `char-clear-${index}`)).toMatchObject({
        vits: { files: { greeting: clearValue } },
        gptSoVitsConfig: {
          ref_audio_data: { fileName: 'ref.wav', assetId: clearValue },
        },
      })
    }
    expect(await projectedCharacterRow(harness.app, assertion, 'char-a')).toMatchObject({
      vits: { files: { greeting: '-' } },
      gptSoVitsConfig: {
        ref_audio_data: { fileName: 'ref.wav', assetId: '-' },
      },
    })
  })
})

describe('legacy cold-storage recovery commands', () => {
  it('recovers an archived character and all of its chats in one revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-cold',
          name: 'Archived shell',
          coldstorage: 'character-archive',
          coldStoragedChats: ['chat-archive'],
          chats: [
            {
              id: 'shell-chat',
              name: 'Shell',
              note: '',
              localLore: [],
              message: [{ role: 'char', data: '', chatId: 'shell-message' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-cold'],
    })
    const sidecarPath = writeColdStorageSidecar(harness.dataDir, 'character-archive', {
      character: {
        chaId: 'char-cold',
        name: 'Recovered character',
        chats: [
          {
            id: 'recovered-chat',
            name: 'Recovered chat',
            note: 'legacy note',
            localLore: [{ key: 'legacy lore' }],
            scriptstate: { score: 7 },
            hypaV3Data: { summaries: [{ text: 'memory' }] },
            message: [
              { role: 'user', data: 'Are you still there?', chatId: 'recovered-message-a' },
              { role: 'char', data: 'Always.', chatId: 'recovered-message-b' },
            ],
          },
        ],
        chatFolders: [],
        chatPage: 0,
      },
    })

    const recovered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'character-archive' },
    })

    expect(recovered.statusCode).toBe(200)
    expect(recovered.json()).toMatchObject({
      revision: revision + 1,
      event: {
        type: 'coldStorage.characterRecovered',
        resource: 'characterRow',
        id: 'char-cold',
      },
      characterId: 'char-cold',
      character: {
        chaId: 'char-cold',
        name: 'Recovered character',
        chats: [{ id: 'recovered-chat' }],
      },
    })
    expect(readJsonRow('characters', 'char-cold')).toMatchObject({
      chaId: 'char-cold',
      name: 'Recovered character',
    })
    expect(readJsonRow('characters', 'char-cold').coldstorage).toBeUndefined()
    expect(readJsonRow('chats', 'recovered-chat')).toMatchObject({
      id: 'recovered-chat',
      scriptstate: { score: 7 },
      localLore: [{ key: 'legacy lore' }],
    })
    expect(await persistedChatMessages(harness.app, assertion, 'recovered-chat')).toEqual([
      expect.objectContaining({ data: 'Are you still there?', chatId: 'recovered-message-a' }),
      expect.objectContaining({ data: 'Always.', chatId: 'recovered-message-b' }),
    ])
    expect(existsSync(sidecarPath)).toBe(true)
    expect(() => readJsonRow('chats', 'shell-chat')).toThrow()
  })

  it('rejects character archives with missing chat arrays before changing live rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-cold',
          name: 'Live character',
          coldstorage: 'malformed-character-archive',
          chats: [
            {
              id: 'live-chat',
              name: 'Live chat',
              note: 'must survive',
              localLore: [],
              hypaV3Data: { summaries: [{ text: 'live memory' }] },
              message: [{ role: 'char', data: 'live transcript', chatId: 'live-message' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-cold'],
    })

    writeColdStorageSidecar(harness.dataDir, 'malformed-character-archive', {
      character: { chaId: 'char-cold', name: 'Missing chats' },
    })
    const missingChats = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'malformed-character-archive' },
    })
    expect(missingChats.statusCode).toBe(400)
    expect(missingChats.json().error).toBe('archive.character.chats must be an array')

    writeColdStorageSidecar(harness.dataDir, 'malformed-character-archive', {
      character: {
        chaId: 'char-cold',
        name: 'Missing messages',
        chats: [{ id: 'recovered-chat', name: 'Recovered chat', note: '', localLore: [] }],
      },
    })
    const missingMessages = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'malformed-character-archive' },
    })
    expect(missingMessages.statusCode).toBe(400)
    expect(missingMessages.json().error).toBe('archive.character.chats[0].message must be an array')

    expect(readJsonRow('characters', 'char-cold')).toMatchObject({
      name: 'Live character',
      coldstorage: 'malformed-character-archive',
    })
    expect(readJsonRow('chats', 'live-chat')).toMatchObject({ name: 'Live chat', note: 'must survive' })
    expect(await persistedChatMessages(harness.app, assertion, 'live-chat')).toEqual([
      { role: 'char', data: 'live transcript', chatId: 'live-message' },
    ])
    expect(await persistedChatHypaV3(harness.app, assertion, 'live-chat')).toEqual({
      summaries: [{ text: 'live memory' }],
    })
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('preserves live Hypa V3 data when a character archive omits it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-cold',
          name: 'Archived shell',
          coldstorage: 'character-without-hypa',
          chats: [
            {
              id: 'shared-chat',
              name: 'Shell chat',
              note: '',
              localLore: [],
              hypaV3Data: { summaries: [{ text: 'live character memory' }] },
              message: [{ role: 'char', data: 'shell', chatId: 'shell-message' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-cold'],
    })
    writeColdStorageSidecar(harness.dataDir, 'character-without-hypa', {
      character: {
        chaId: 'char-cold',
        name: 'Recovered character',
        chats: [
          {
            id: 'shared-chat',
            name: 'Recovered chat',
            note: '',
            localLore: [],
            message: [{ role: 'char', data: 'recovered', chatId: 'recovered-message' }],
          },
        ],
        chatFolders: [],
        chatPage: 0,
      },
    })

    const recovered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'character-without-hypa' },
    })

    expect(recovered.statusCode).toBe(200)
    expect(await persistedChatHypaV3(harness.app, assertion, 'shared-chat')).toEqual({
      summaries: [{ text: 'live character memory' }],
    })
  })

  it('recovers an archived chat transcript and metadata without deleting its sidecar', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-cold',
              name: 'Archived chat',
              note: '',
              localLore: [],
              message: [
                {
                  role: 'char',
                  data: `${LEGACY_COLD_STORAGE_HEADER}chat-archive`,
                  chatId: 'pointer-message',
                },
              ],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const sidecarPath = writeColdStorageSidecar(harness.dataDir, 'chat-archive', {
      message: [
        { role: 'user', data: 'Recovered question', chatId: 'message-a' },
        { role: 'char', data: 'Recovered answer', chatId: 'message-b' },
      ],
      hypaV2Data: { legacy: true },
      hypaV3Data: { summaries: [{ text: 'remember this' }] },
      scriptstate: { route: 'recovered' },
      localLore: [{ key: 'archive lore' }],
    })

    const recovered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'chat-archive' },
    })

    expect(recovered.statusCode).toBe(200)
    expect(recovered.json()).toMatchObject({
      revision: revision + 1,
      event: {
        type: 'coldStorage.chatRecovered',
        resource: 'chatTranscript',
        id: 'chat-cold',
        parentId: 'char-a',
      },
      chat: {
        id: 'chat-cold',
        scriptstate: { route: 'recovered' },
        localLore: [{ key: 'archive lore' }],
      },
    })
    expect(await persistedChatMessages(harness.app, assertion, 'chat-cold')).toEqual([
      expect.objectContaining({ data: 'Recovered question', chatId: 'message-a' }),
      expect.objectContaining({ data: 'Recovered answer', chatId: 'message-b' }),
    ])
    expect(readJsonRow('chats', 'chat-cold')).toMatchObject({
      hypaV2Data: { legacy: true },
      scriptstate: { route: 'recovered' },
      localLore: [{ key: 'archive lore' }],
    })
    expect(existsSync(sidecarPath)).toBe(true)
  })

  it('preserves live Hypa V3 data when a legacy chat archive omits it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-cold',
              name: 'Archived chat',
              note: '',
              localLore: [],
              hypaV3Data: { summaries: [{ text: 'live chat memory' }] },
              message: [
                {
                  role: 'char',
                  data: `${LEGACY_COLD_STORAGE_HEADER}legacy-array-archive`,
                  chatId: 'pointer-message',
                },
              ],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    writeColdStorageSidecar(harness.dataDir, 'legacy-array-archive', [
      { role: 'user', data: 'Recovered question', chatId: 'message-a' },
      { role: 'char', data: 'Recovered answer', chatId: 'message-b' },
    ])

    const recovered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'legacy-array-archive' },
    })

    expect(recovered.statusCode).toBe(200)
    expect(await persistedChatHypaV3(harness.app, assertion, 'chat-cold')).toEqual({
      summaries: [{ text: 'live chat memory' }],
    })
  })

  it('keeps an authoritative chat pointer when its archive is missing or corrupt', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const pointer = `${LEGACY_COLD_STORAGE_HEADER}missing-archive`
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-cold',
              name: 'Archived chat',
              note: '',
              localLore: [],
              message: [{ role: 'char', data: pointer, chatId: 'pointer-message' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'missing-archive' },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toContain('missing-archive')
    expect((await persistedChatMessages(harness.app, assertion, 'chat-cold'))[0].data).toBe(pointer)

    writeFileSync(coldStorageSidecarPath(harness.dataDir, 'missing-archive'), Buffer.from('not compressed json'))
    const corrupt = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'missing-archive' },
    })
    expect(corrupt.statusCode).toBe(400)
    expect(corrupt.json().error).toContain('corrupt')
    expect((await persistedChatMessages(harness.app, assertion, 'chat-cold'))[0].data).toBe(pointer)
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })
})
