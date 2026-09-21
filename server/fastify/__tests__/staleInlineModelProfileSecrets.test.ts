import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { resolveMemorySummaryModel } from '../src/memorySummaryModel.js'
import { resolveModelProfile } from '@risuai/shared-core/model-profile-resolver'
import { canonicalModelProfileFixture } from '../../../test/fixtures/canonicalModelProfile'

const subtle = webcrypto.subtle
const STALE_KEY = 'sk-stale-inline-secret-e2e'
const STALE_VERTEX_EMAIL = 'stale-vertex-client@example.com'
const STALE_VERTEX = 'stale-vertex-private-key-e2e'
const STALE_BOT_PRESET_KEY = 'sk-stale-bot-preset-inline-secret-e2e'
const STALE_BOT_PRESET_VERTEX_EMAIL = 'stale-bot-preset-vertex-client@example.com'
const STALE_BOT_PRESET_VERTEX = 'stale-bot-preset-vertex-private-key-e2e'
const STALE_MODEL_PRESET_KEY = 'sk-stale-model-preset-inline-secret-e2e'
const STALE_MODEL_PRESET_VERTEX_EMAIL = 'stale-model-preset-vertex-client@example.com'
const STALE_MODEL_PRESET_VERTEX = 'stale-model-preset-vertex-private-key-e2e'

const ALL_STALE_SECRETS = [
  STALE_KEY,
  STALE_VERTEX_EMAIL,
  STALE_VERTEX,
  STALE_BOT_PRESET_KEY,
  STALE_BOT_PRESET_VERTEX_EMAIL,
  STALE_BOT_PRESET_VERTEX,
  STALE_MODEL_PRESET_KEY,
  STALE_MODEL_PRESET_VERTEX_EMAIL,
  STALE_MODEL_PRESET_VERTEX,
] as const

async function startApp(dataDir: string): Promise<FastifyInstance> {
  process.env.LOG_LEVEL = 'silent'
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 2 * 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      requestTrace: { mode: 'agent' },
    },
    memoryWorker: false,
    assetGc: false,
  })
  return app
}

async function signAssertion(privateKey: CryptoKey, publicJwk: JsonWebKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', typ: 'JWT' }
  const payload = { iat: now, exp: now + 60, pub: publicJwk }
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

describe('stale inline profile secrets in a pre-credential-store DB', () => {
  let dataDir: string
  let app: FastifyInstance
  let keypair: CryptoKeyPair
  let publicJwk: JsonWebKey

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'risu-stale-secret-'))
    app = await startApp(dataDir)
    keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    publicJwk = await subtle.exportKey('jwk', keypair.publicKey)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2', publicKey: publicJwk },
    })
    expect(setup.statusCode).toBe(200)
  })

  afterEach(async () => {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('durably scrubs settings and preset rows before reads, exports, or extraction', { tags: 'core' }, async () => {
    // 1. Seed a valid DB through the import route.
    const assertion1 = await signAssertion(keypair.privateKey, publicJwk)
    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': assertion1 },
      payload: {
        database: {
          modelProfiles: [{ id: 'profile-a', name: 'Legacy', providerId: 'openai', modelId: 'gpt-4.1' }],
          botPresets: [
            {
              id: 'legacy-preset-a',
              name: 'Legacy Preset',
              temperature: 0.42,
              modelProfiles: [
                {
                  id: 'legacy-preset-profile',
                  name: 'Legacy Preset Profile',
                  providerId: 'openai',
                  modelId: 'gpt-4.1',
                },
              ],
            },
          ],
          botPresetsId: 0,
          modelPresets: [
            {
              id: 'model-preset-a',
              name: 'Model Preset',
              temperature: 0.81,
              modelProfiles: [
                {
                  id: 'model-preset-profile',
                  name: 'Model Preset Profile',
                  providerId: 'anthropic',
                  modelId: 'claude-sonnet-4',
                },
              ],
            },
          ],
          modelPresetsId: 0,
        },
      },
    })
    expect(imported.statusCode).toBe(200)
    await app.close()

    // 2. Tamper the stored settings the way an OLD server version wrote them:
    //    inline apiKey + Vertex service-account fields on the profile row.
    const sqlite = new DatabaseSync(path.join(dataDir, 'risu.db'))
    const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
      data_json: string
    }
    const settings = JSON.parse(row.data_json)
    expect(Array.isArray(settings.modelProfiles)).toBe(true)
    settings.modelProfiles[0].providerOptions = {
      apiKey: STALE_KEY,
      vertex: {
        projectId: 'preserved-project',
        clientEmail: STALE_VERTEX_EMAIL,
        privateKey: STALE_VERTEX,
      },
    }
    sqlite.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))

    const botPresetRow = sqlite.prepare('SELECT position, data_json FROM bot_presets').get() as {
      position: number
      data_json: string
    }
    const botPreset = JSON.parse(botPresetRow.data_json)
    botPreset.modelProfiles[0].providerOptions = {
      apiKey: STALE_BOT_PRESET_KEY,
      vertex: {
        projectId: 'preserved-bot-preset-project',
        clientEmail: STALE_BOT_PRESET_VERTEX_EMAIL,
        privateKey: STALE_BOT_PRESET_VERTEX,
      },
    }
    sqlite
      .prepare('UPDATE bot_presets SET data_json = ? WHERE position = ?')
      .run(JSON.stringify(botPreset), botPresetRow.position)

    const modelPresetRow = sqlite.prepare('SELECT position, data_json FROM model_presets').get() as {
      position: number
      data_json: string
    }
    const modelPreset = JSON.parse(modelPresetRow.data_json)
    modelPreset.modelProfiles[0].providerOptions = {
      apiKey: STALE_MODEL_PRESET_KEY,
      vertex: {
        projectId: 'preserved-model-preset-project',
        clientEmail: STALE_MODEL_PRESET_VERTEX_EMAIL,
        privateKey: STALE_MODEL_PRESET_VERTEX,
      },
    }
    sqlite
      .prepare('UPDATE model_presets SET data_json = ? WHERE position = ?')
      .run(JSON.stringify(modelPreset), modelPresetRow.position)
    sqlite.close()

    // 3. Reopen the app on the tampered dataDir (same registered client key).
    app = await startApp(dataDir)
    const assertion2 = await signAssertion(keypair.privateKey, publicJwk)

    // 4. Resource reads must never expose the stale secrets.
    for (const url of [
      '/api/v1/settings',
      '/api/v1/settings/providers',
      '/api/v1/settings/models',
      '/api/v1/collections',
      '/api/v1/collections/modelPresets',
      '/api/v1/legacy-presets/legacy-preset-a',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { 'risu-auth': assertion2 } })
      expect(res.statusCode).toBe(200)
      for (const secret of ALL_STALE_SECRETS) expect(res.body).not.toContain(secret)
    }

    const exported = await app.inject({
      method: 'GET',
      url: '/api/v1/export/risusave?envelope=legacy-raw',
      headers: { 'risu-auth': assertion2 },
    })
    expect(exported.statusCode).toBe(200)
    const portablePayload = Buffer.from(exported.rawPayload).toString('utf8')
    for (const secret of ALL_STALE_SECRETS) {
      expect(portablePayload).not.toContain(secret)
    }

    // 5. The load-time repair is durable before any profile mutation runs.
    const repairedSqlite = new DatabaseSync(path.join(dataDir, 'risu.db'))
    const repairedRow = repairedSqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
      data_json: string
    }
    const repairedBotPresetRow = repairedSqlite.prepare('SELECT data_json FROM bot_presets').get() as {
      data_json: string
    }
    const repairedModelPresetRow = repairedSqlite.prepare('SELECT data_json FROM model_presets').get() as {
      data_json: string
    }
    repairedSqlite.close()
    const durableRows = [repairedRow.data_json, repairedBotPresetRow.data_json, repairedModelPresetRow.data_json]
    for (const secret of ALL_STALE_SECRETS) {
      for (const durableRow of durableRows) expect(durableRow).not.toContain(secret)
    }
    expect(JSON.parse(repairedRow.data_json).modelProfiles[0].providerOptions).toEqual({
      vertex: { projectId: 'preserved-project' },
    })
    expect(JSON.parse(repairedBotPresetRow.data_json).modelProfiles[0].providerOptions).toEqual({
      vertex: { projectId: 'preserved-bot-preset-project' },
    })
    expect(JSON.parse(repairedModelPresetRow.data_json).modelProfiles[0].providerOptions).toEqual({
      vertex: { projectId: 'preserved-model-preset-project' },
    })

    // 6. Profile commands must still work against the repaired legacy rows.
    const settingsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'risu-auth': assertion2 },
    })
    const revision = settingsRes.json().revision
    expect(typeof revision).toBe('number')
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles/profile-a/duplicate',
      headers: { 'risu-auth': assertion2 },
      payload: { baseRevision: revision, name: 'Copy A' },
    })
    expect(dup.statusCode).toBe(200)

    // 7. Extracting the repaired legacy preset must not copy a stale secret
    //    back into model_presets.
    const extracted = await app.inject({
      method: 'POST',
      url: '/api/v1/commands/legacy-bot-presets/legacy-preset-a/extract',
      headers: { 'risu-auth': assertion2 },
      payload: { baseRevision: dup.json().revision, mode: 'model' },
    })
    expect(extracted.statusCode).toBe(200)
    expect(typeof extracted.json().modelPresetId).toBe('string')
    for (const secret of ALL_STALE_SECRETS) expect(extracted.body).not.toContain(secret)

    const extractedSqlite = new DatabaseSync(path.join(dataDir, 'risu.db'))
    const extractedRows = extractedSqlite
      .prepare('SELECT data_json FROM model_presets ORDER BY position')
      .all() as Array<{
      data_json: string
    }>
    extractedSqlite.close()
    const extractedPreset = extractedRows
      .map((candidate) => JSON.parse(candidate.data_json))
      .find((candidate) => candidate.id === extracted.json().modelPresetId)
    expect(extractedPreset).toBeTruthy()
    expect(extractedPreset.modelProfiles[0].providerOptions).toEqual({
      vertex: { projectId: 'preserved-bot-preset-project' },
    })
    for (const secret of ALL_STALE_SECRETS) {
      expect(JSON.stringify(extractedPreset)).not.toContain(secret)
    }
  })

  it('keeps a durable role binding ahead of stale flat model state through dispatch and projections', async () => {
    const { staleFlat, credential, profile, bindings } = canonicalModelProfileFixture
    const database = {
      ...staleFlat,
      providerCredentials: [credential],
      modelProfiles: [profile],
      modelRoleProfiles: bindings,
    }

    const initialized = await app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': await signAssertion(keypair.privateKey, publicJwk) },
      payload: { database: { version: 1 } },
    })
    expect(initialized.statusCode).toBe(200)

    const resolved = resolveModelProfile({ database: database as never, role: 'memory' })
    expect(resolved.source.kind).toBe('durable-profile')
    expect(resolved.modelId).toBe(profile.modelId)
    expect(resolved.requestModel).toBe(profile.providerOptions.requestModel)
    expect(resolved.providerOptions.apiKey).toBe(credential.apiKey)

    const dispatch = resolveMemorySummaryModel(database as never, 'memory')
    expect(dispatch).toEqual({
      ok: true,
      request: {
        provider: 'openai',
        model: profile.providerOptions.requestModel,
        options: { openai: { apiKey: credential.apiKey } },
      },
    })

    const sqlite = new DatabaseSync(path.join(dataDir, 'risu.db'))
    const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    const persisted = JSON.parse(row.data_json)
    Object.assign(persisted, database)
    sqlite.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(persisted))
    sqlite.close()

    await app.close()
    app = await startApp(dataDir)

    const projected = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/models',
      headers: { 'risu-auth': await signAssertion(keypair.privateKey, publicJwk) },
    })
    expect(projected.statusCode).toBe(200)
    expect(projected.json().settings).toMatchObject({
      providerCredentials: [{ id: credential.id, apiKey: '__RISU_SECRET_MASKED__' }],
      modelProfiles: [profile],
      modelRoleProfiles: bindings,
    })
    expect(projected.body).not.toContain(credential.apiKey)
    expect(projected.body).not.toContain(staleFlat.openAIKey)

    const tracePath = path.join(dataDir, 'trace', 'agent.jsonl')
    for (let attempt = 0; attempt < 20 && !existsSync(tracePath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(existsSync(tracePath)).toBe(true)
    const trace = readFileSync(tracePath, 'utf8')
    expect(trace).not.toContain(credential.apiKey)
    expect(trace).not.toContain(staleFlat.openAIKey)
  })
})
