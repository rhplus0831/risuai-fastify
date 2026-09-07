import { webcrypto } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import fastifyCompress from '@fastify/compress'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createAuthState } from '../src/auth.js'
import { CURRENT_SCHEMA_VERSION, openDatabase } from '../src/db.js'
import { GenerationJobRegistry } from '../src/generationJobs.js'
import { registerBootstrapRoutes } from '../src/routes/bootstrap.js'
import {
  enqueueGenerationFinalizationRetry,
  markGenerationFinalizationRetryFailure,
} from '../src/generationFinalizationRetry.js'

const subtle = webcrypto.subtle

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-'))
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
  })
  return { app, dataDir }
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
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

  return { assertion: await signAssertion(keypair.privateKey, publicKey) }
}

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  await stopHarness(harness)
})

describe('bootstrap runtime metadata', () => {
  it('rejects bootstrap on a fresh data dir until a password is set', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap' })

    expect(response.statusCode).toBe(401)
  })

  it('rejects unauthenticated bootstrap once a password is set', async () => {
    const setup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    expect(setup.statusCode).toBe(200)

    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap' })

    expect(response.statusCode).toBe(401)
  })

  it('returns only runtime metadata for an uninitialized database', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: {
        'risu-auth': assertion,
        // The retired body-cache manifest is deliberately ignored.
        'x-risu-body-cache-manifest': '%7Bmalformed',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      initialized: false,
      revision: 0,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      databaseLineage: expect.any(String),
      writerEpoch: 0,
      writer: { sessionId: null, epoch: 0 },
      assetBaseUrl: '/api/v1/assets',
      generationOperationProtocol: { version: 1 },
      displaySourceProtocol: { version: 1 },
      generationOperationProjectionEpoch: 0,
      generationOperations: [],
      activeGenerationJobs: [],
      activeMessageTranslations: [],
      activeGreetingTranslations: [],
    })
  })

  it('reports initialization and revision without transferring database state', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const imported = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': assertion },
      payload: { database: { greeting: 'hi', characters: [{ chaId: 'char-a', name: 'Ada' }] } },
    })
    expect(imported.statusCode).toBe(200)

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      initialized: true,
      revision: 1,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      databaseLineage: expect.any(String),
      writerEpoch: 0,
      writer: { sessionId: null, epoch: 0 },
      assetBaseUrl: '/api/v1/assets',
      generationOperationProtocol: { version: 1 },
      displaySourceProtocol: { version: 1 },
      generationOperationProjectionEpoch: 1,
      generationOperations: [],
      activeGenerationJobs: [],
      activeMessageTranslations: [],
      activeGreetingTranslations: [],
    })
    expect(response.json()).not.toHaveProperty('database')
  })

  it('reconstructs writer-scoped pending and terminal finalization state after an app restart', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.close()

    const db = openDatabase(harness.dataDir)
    try {
      enqueueGenerationFinalizationRetry(db, {
        generationId: 'generation-pending',
        chatId: 'chat-a',
        mode: 'send',
        message: {
          role: 'char',
          data: 'pending reply',
          chatId: 'generation-pending',
          generationInfo: { generationId: 'generation-pending' },
        },
        chatVarMutations: [],
        targetSnapshot: { mode: 'send', kind: 'tail', transcriptLength: 0 },
      })
      markGenerationFinalizationRetryFailure(db, 'generation-pending', 'temporary failure', false)

      enqueueGenerationFinalizationRetry(db, {
        generationId: 'generation-terminal',
        chatId: 'chat-a',
        mode: 'send',
        message: { role: 'char', data: 'terminal reply', chatId: 'generation-terminal' },
        chatVarMutations: [],
        targetSnapshot: { mode: 'send', kind: 'tail', transcriptLength: 0 },
      })
      markGenerationFinalizationRetryFailure(db, 'generation-terminal', 'unsafe target', true)

      enqueueGenerationFinalizationRetry(db, {
        generationId: 'generation-legacy',
        chatId: 'chat-a',
        mode: 'send',
        message: { role: 'char', data: 'legacy reply', chatId: 'generation-legacy' },
        chatVarMutations: [],
      })
      db.prepare(
        `
          UPDATE generation_finalization_retries
          SET mode = 'continue', target_message_id = 'message-a'
          WHERE generation_id = 'generation-legacy'
        `,
      ).run()
      markGenerationFinalizationRetryFailure(db, 'generation-legacy', 'stalled_legacy', true)
    } finally {
      db.close()
    }

    const rebuilt = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir: harness.dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      generationChat: { finalizationRetry: false },
    })
    harness.app = rebuilt.app

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    })

    expect(response.statusCode).toBe(200)
    const finalizations = response.json().generationFinalizations
    expect(finalizations).toHaveLength(3)
    expect(finalizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          generationId: 'generation-pending',
          state: 'queued',
          failureCount: 1,
          provisionalMessage: expect.objectContaining({ data: 'pending reply' }),
        }),
        expect.objectContaining({ generationId: 'generation-terminal', state: 'terminal' }),
        expect.objectContaining({
          generationId: 'generation-legacy',
          messageId: 'message-a',
          state: 'stalled_legacy',
        }),
      ]),
    )

    const observer = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-observer-session': 'different-writer' },
    })
    expect(observer.statusCode).toBe(200)
    expect(observer.json().generationFinalizations).toBeUndefined()
  })

  it('migrates the pre-Agent settings owner before generation-settings commands run', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const imported = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': assertion },
      payload: {
        database: {
          modelPresets: [{ id: 'model-a', name: 'Model A' }],
          agentPresets: [
            {
              id: 'legacy-agent-preset',
              name: 'Legacy Agent Preset',
              enabled: true,
              version: 1,
              steps: [],
            },
          ],
          characters: [
            {
              chaId: 'char-a',
              name: 'Character A',
              chats: [{ id: 'chat-a', name: 'Chat A', note: '', message: [], localLore: [] }],
              chatFolders: [],
              chatPage: 0,
            },
          ],
          characterOrder: ['char-a'],
        },
      },
    })
    expect(imported.statusCode, imported.body).toBe(200)
    await harness.app.close()

    const db = openDatabase(harness.dataDir)
    try {
      const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const settings = JSON.parse(row.data_json) as Record<string, unknown>
      delete settings.agents
      settings.agentPresets = [
        {
          id: 'legacy-agent-preset',
          name: 'Legacy Agent Preset',
          enabled: true,
          version: 1,
          steps: [],
        },
      ]
      db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      db.close()
    }

    const rebuilt = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir: harness.dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      memoryWorker: false,
      assetGc: false,
    })
    harness.app = rebuilt.app

    const agents = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/agents',
      headers: { 'risu-auth': assertion },
    })
    expect(agents.statusCode, agents.body).toBe(200)
    expect(agents.json().settings).toMatchObject({
      agents: [],
      agentPresets: [expect.objectContaining({ id: 'legacy-agent-preset', agentUses: [], steps: [] })],
    })

    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: imported.json().revision,
        generationSettings: {
          configured: true,
          modelPresetId: 'model-a',
          modelPresetSelectionSource: 'manual',
          jailbreakToggle: false,
        },
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().generationSettings).toMatchObject({
      configured: true,
      modelPresetId: 'model-a',
      jailbreakToggle: false,
    })
  })

  it('gzip-compresses large bootstrap JSON without changing the body', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-bootstrap-compression-'))
    const app = Fastify({ logger: false })
    const db = openDatabase(dataDir)
    try {
      await app.register(fastifyCompress, {
        global: true,
        globalDecompression: false,
        threshold: 1024,
      })
      const generationJobs = new GenerationJobRegistry()
      for (let index = 0; index < 64; index++) {
        const job = generationJobs.registry.create({ timeoutMs: 60_000, heartbeatSec: 15 })
        job.chatId = `chat-${index}-${'active'.repeat(40)}`
        job.mode = 'send'
        generationJobs.register(job.chatId, job.id)
      }
      registerBootstrapRoutes(
        app,
        db,
        createAuthState(dataDir, { agentDevAuthBypass: true }),
        dataDir,
        undefined,
        generationJobs,
      )

      const uncompressed = await app.inject({ method: 'GET', url: '/api/v1/bootstrap' })
      const compressed = await app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'accept-encoding': 'gzip' },
      })

      expect(uncompressed.statusCode).toBe(200)
      expect(uncompressed.headers['content-encoding']).toBeUndefined()
      expect(compressed.statusCode).toBe(200)
      expect(compressed.headers['content-encoding']).toBe('gzip')
      expect(gunzipSync(compressed.rawPayload).toString('utf8')).toBe(uncompressed.body)
      expect(compressed.rawPayload.length).toBeLessThan(uncompressed.rawPayload.length * 0.7)
    } finally {
      await app.close()
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
