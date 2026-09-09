import { createHash, webcrypto } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { DisplaySourceService } from '../src/displaySourceService.js'
import { readDisplaySourceRequest } from '../src/routes/displaySources.js'
import type { DisplaySourceRequest } from '@risuai/protocol/display-source'
import { getSchemaState, openDatabase } from '../src/db.js'
import { applyImport, loadPersistedForGenerationAssembly } from '../src/repository.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { subscribeProtocolMetrics } from '../src/protocolMetrics.js'
import { decodeGenerationDatabase } from '../src/prompt/generationInputDecoder.js'
import { getActiveModules } from '../src/prompt/modules.js'
import { runTrigger } from '../src/prompt/triggers.js'
import { assertScopedLoadOnHotPath } from './helpers/loadCostHarness.js'

const subtle = webcrypto.subtle

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-display-source-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 8 * 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    memoryWorker: false,
    assetGc: false,
  })
  return { app, dataDir }
}

async function signAssertion(privateKey: CryptoKey, publicJwk: JsonWebKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify({ iat: now, exp: now + 60, pub: publicJwk })).toString('base64url')
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    Buffer.from(signingInput),
  )
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
}

async function setupAuthedClient(app: FastifyInstance): Promise<string> {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { password: 'hunter2' },
      })
    ).statusCode,
  ).toBe(200)
  const keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await subtle.exportKey('jwk', keypair.publicKey)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { password: 'hunter2', publicKey },
      })
    ).statusCode,
  ).toBe(200)
  return signAssertion(keypair.privateKey, publicKey)
}

function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

describe('POST /api/v1/chats/:chatId/display-sources', () => {
  it('accepts a production-shaped singleton-tuple module without rewriting or enabling its automatic triggers', async () => {
    const assertion = await setupAuthedClient(harness.app)
    const tupleTriggers = Array.from({ length: 10 }, (_, index) => ({
      comment: `legacy tuple ${index}`,
      type: [index < 3 || index === 6 ? 'input' : 'output'],
      conditions: [],
      effect: [{ type: 'setvar', operator: '=', var: `legacy-${index}`, value: 'unexpected' }],
    }))
    const canonicalTrigger = {
      comment: 'canonical input',
      type: 'input',
      conditions: [],
      effect: [{ type: 'setvar', operator: '=', var: 'canonical', value: 'ran' }],
    }
    const db = openDatabase(harness.dataDir)
    let revision: number
    let persistedModule: string
    try {
      const seeded = await applyImport(
        db,
        harness.dataDir,
        normalizeRisuSaveSnapshotDatabase({
          enabledModules: ['production-shaped-module'],
          modules: [
            {
              id: 'production-shaped-module',
              name: 'Production-shaped legacy triggers',
              description: '',
              regex: [{ in: 'hello', out: 'rendered', type: 'editdisplay' }],
              trigger: [...tupleTriggers.map((trigger) => ({ ...trigger, type: trigger.type[0] })), canonicalTrigger],
            },
          ],
          characters: [
            {
              chaId: 'char-1',
              name: 'Character',
              chats: [{ id: 'chat-1', message: [{ role: 'char', data: 'hello', chatId: 'message-1' }] }],
            },
          ],
        }),
      )
      revision = seeded.revision
      const importedModule = (
        db
          .prepare("SELECT data_json FROM modules WHERE json_extract(data_json, '$.id') = ?")
          .get('production-shaped-module') as {
          data_json: string
        }
      ).data_json
      const productionShapedModule = JSON.parse(importedModule) as Record<string, unknown>
      productionShapedModule.trigger = [...tupleTriggers, canonicalTrigger]
      persistedModule = JSON.stringify(productionShapedModule)
      db.prepare("UPDATE modules SET data_json = ? WHERE json_extract(data_json, '$.id') = ?").run(
        persistedModule,
        'production-shaped-module',
      )
    } finally {
      db.close()
    }

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/chats/chat-1/display-sources',
      headers: { 'risu-auth': assertion },
      payload: {
        protocolVersion: 1,
        baseRevision: revision,
        context: { pageSessionId: 'production-shaped' },
        targets: [
          {
            requestKey: 'production-shaped',
            characterId: 'char-1',
            messageId: 'message-1',
            index: 0,
            role: 'char',
            firstMessage: false,
            layer: 'original',
            source: 'hello',
            sourceHash: sourceHash('hello'),
            projectionEpoch: 1,
          },
        ],
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().entries).toEqual([
      expect.objectContaining({ requestKey: 'production-shaped', status: 'ok', displaySource: 'rendered' }),
    ])

    const persistedDb = openDatabase(harness.dataDir)
    try {
      const after = (
        persistedDb
          .prepare("SELECT data_json FROM modules WHERE json_extract(data_json, '$.id') = ?")
          .get('production-shaped-module') as {
          data_json: string
        }
      ).data_json
      expect(after).toBe(persistedModule)
      const loaded = loadPersistedForGenerationAssembly(persistedDb, harness.dataDir, {
        characterId: 'char-1',
        chatId: 'chat-1',
      })
      const database = decodeGenerationDatabase(loaded.database)
      const character = database.characters[0]
      const chat = character.chats[0]
      const triggerResult = await runTrigger(
        {
          modules: getActiveModules(database, character, chat),
          database,
          selectedCharID: 0,
          chatPage: 0,
        },
        character,
        'input',
        { chat },
      )
      expect(triggerResult?.chat.scriptstate?.['$canonical']).toBe('ran')
      for (const index of tupleTriggers.keys()) {
        expect(triggerResult?.chat.scriptstate).not.toHaveProperty(`$legacy-${index}`)
      }
    } finally {
      persistedDb.close()
    }
  })

  it('renders imported messages when optional generation settings and lore metadata are null', async () => {
    const assertion = await setupAuthedClient(harness.app)
    const db = openDatabase(harness.dataDir)
    let revision: number
    try {
      const seeded = await applyImport(
        db,
        harness.dataDir,
        normalizeRisuSaveSnapshotDatabase({
          dynamicOutput: null,
          thinkingTokens: null,
          characters: [
            {
              name: 'Imported',
              chaId: 'char-1',
              customscript: [{ in: 'hello', out: 'rendered', type: 'editdisplay' }],
              globalLore: [
                {
                  key: '',
                  secondkey: '',
                  insertorder: 0,
                  comment: '',
                  content: '',
                  mode: 'normal',
                  alwaysActive: false,
                  selective: false,
                  activationPercent: null,
                  loreCache: null,
                },
              ],
              chats: [{ id: 'chat-1', message: [{ role: 'char', data: 'hello', chatId: 'message-1' }] }],
            },
          ],
        }),
      )
      revision = seeded.revision
    } finally {
      db.close()
    }
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/chats/chat-1/display-sources',
      headers: { 'risu-auth': assertion },
      payload: {
        protocolVersion: 1,
        baseRevision: revision,
        context: { pageSessionId: 'page-a', screenWidth: 800, screenHeight: 600, browserLanguage: 'en-US' },
        targets: [
          {
            requestKey: 'nullable',
            characterId: 'char-1',
            messageId: 'message-1',
            index: 0,
            role: 'char',
            firstMessage: false,
            layer: 'original',
            source: 'hello',
            sourceHash: sourceHash('hello'),
            projectionEpoch: 1,
          },
        ],
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      revision,
      entries: [{ requestKey: 'nullable', status: 'ok', displaySource: 'rendered' }],
    })
  })

  it('preserves selected prompt, persona, and module activation inputs in the narrow display scope', async () => {
    const assertion = await setupAuthedClient(harness.app)
    const db = openDatabase(harness.dataDir)
    let revision: number
    try {
      const module = (id: string, namespace: string, marker: string) => ({
        id,
        namespace,
        name: marker,
        description: '',
        regex: [{ in: 'hello', out: `hello[${marker}]`, type: 'editdisplay' }],
      })
      const seeded = await applyImport(
        db,
        harness.dataDir,
        normalizeRisuSaveSnapshotDatabase({
          selectedPersonaId: 'global-persona',
          selectedPersona: 0,
          personas: [
            { id: 'global-persona', name: 'Global user', personaPrompt: 'Global prompt', modules: [] },
            { id: 'chat-persona', name: 'Chat user', personaPrompt: 'Chat prompt', modules: ['persona-ns'] },
          ],
          enabledModules: ['global-ns'],
          agentPresetDefaultId: 'agent-preset',
          agentPresets: [{ id: 'agent-preset', name: 'Agent preset', agentUses: [], moduleIntergration: 'agent-ns' }],
          promptPresets: [
            {
              id: 'prompt-preset',
              name: 'Prompt preset',
              moduleIntergration: 'prompt-ns',
              regex: [{ in: 'hello', out: 'hello[preset]', type: 'editdisplay' }],
            },
          ],
          modules: [
            module('global-module', 'global-ns', 'global'),
            module('character-module', 'character-ns', 'character'),
            module('chat-module', 'chat-ns', 'chat'),
            module('persona-module', 'persona-ns', 'persona'),
            module('prompt-module', 'prompt-ns', 'prompt'),
            module('agent-module', 'agent-ns', 'agent'),
          ],
          characters: [
            {
              chaId: 'char-1',
              name: 'Character',
              modules: ['character-ns'],
              chats: [
                {
                  id: 'chat-1',
                  modules: ['chat-ns'],
                  generationSettings: {
                    configured: true,
                    personaId: 'chat-persona',
                    promptPresetId: 'prompt-preset',
                    jailbreakToggle: false,
                    sidebarToggles: {},
                  },
                  message: [{ role: 'char', data: 'hello', chatId: 'message-1' }],
                },
              ],
            },
          ],
        }),
      )
      revision = seeded.revision
      db.prepare(
        "UPDATE personas SET data_json = json_set(data_json, '$.modules', json(?)) WHERE json_extract(data_json, '$.id') = ?",
      ).run('["persona-ns"]', 'chat-persona')
    } finally {
      db.close()
    }

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/chats/chat-1/display-sources',
      headers: { 'risu-auth': assertion },
      payload: {
        protocolVersion: 1,
        baseRevision: revision,
        context: { pageSessionId: 'selected-scope' },
        targets: [
          {
            requestKey: 'selected-scope',
            characterId: 'char-1',
            messageId: 'message-1',
            index: 0,
            role: 'char',
            firstMessage: false,
            layer: 'original',
            source: 'hello',
            sourceHash: sourceHash('hello'),
            projectionEpoch: 1,
          },
        ],
      },
    })

    expect(response.statusCode, response.body).toBe(200)
    const displaySource = response.json().entries[0].displaySource as string
    for (const marker of ['preset', 'global', 'character', 'chat', 'persona', 'prompt', 'agent']) {
      expect(displaySource).toContain(`[${marker}]`)
    }
  })

  it('keeps Lua scriptstate ephemeral within each target and never persists display-time state', async () => {
    const assertion = await setupAuthedClient(harness.app)
    const db = openDatabase(harness.dataDir)
    const seeded = await applyImport(
      db,
      harness.dataDir,
      normalizeRisuSaveSnapshotDatabase({
        currentChar: 0,
        characters: [
          {
            type: 'character',
            name: 'Tess',
            chaId: 'char-1',
            chatPage: 0,
            triggerscript: [
              {
                comment: 'display lua',
                type: 'display',
                conditions: [],
                effect: [
                  {
                    type: 'triggerlua',
                    code: `
                      listenEdit('editDisplay', function(id, data, meta)
                        local before = getChatVar(id, 'choice')
                        setChatVar(id, 'choice', data)
                        local after = getChatVar(id, 'choice')
                        return data .. ' [before=' .. before .. ', after=' .. after .. ']'
                      end)
                    `,
                  },
                ],
              },
            ],
            chats: [
              {
                id: 'chat-1',
                name: 'Chat',
                note: '',
                localLore: [],
                scriptstate: { $choice: 'seed' },
                message: [
                  { role: 'char', data: 'hello', chatId: 'message-1' },
                  { role: 'char', data: 'world', chatId: 'message-2' },
                ],
              },
            ],
          },
        ],
      }),
    )
    db.close()

    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    })
    expect(bootstrap.statusCode).toBe(200)
    const runtime = bootstrap.json() as { writerEpoch: number; databaseLineage: string }
    const source = 'hello'
    const request = {
      protocolVersion: 1,
      baseRevision: seeded.revision,
      context: { pageSessionId: 'page-a', screenWidth: 800, screenHeight: 600, browserLanguage: 'en-US' },
      targets: [
        {
          requestKey: 'request-a',
          characterId: 'char-1',
          messageId: 'message-1',
          index: 0,
          role: 'char',
          firstMessage: false,
          layer: 'original',
          source,
          sourceHash: sourceHash(source),
          projectionEpoch: 1,
        },
        {
          requestKey: 'request-b',
          characterId: 'char-1',
          messageId: 'message-2',
          index: 1,
          role: 'char',
          firstMessage: false,
          layer: 'original',
          source: 'world',
          sourceHash: sourceHash('world'),
          projectionEpoch: 2,
        },
      ],
    }
    const observedMetrics: Array<Readonly<Record<string, unknown>>> = []
    const previousMetrics = process.env.RISU_PROTOCOL_METRICS
    process.env.RISU_PROTOCOL_METRICS = '1'
    const unsubscribeMetrics = subscribeProtocolMetrics((metric) => observedMetrics.push(metric))
    let response
    let cachedResponse
    let alternateNamespaceResponse
    let reusedNamespaceResponse
    try {
      const sendRequest = (payload = request) =>
        harness.app.inject({
          method: 'POST',
          url: '/api/v1/chats/chat-1/display-sources',
          // The route is a read-only POST; a stale writer header must not gate display projection.
          headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-old' },
          payload,
        })
      response = await assertScopedLoadOnHotPath(sendRequest, {
        allowTables: ['modules', 'prompt_presets', 'personas'],
      })
      cachedResponse = await assertScopedLoadOnHotPath(sendRequest, {
        allowTables: ['modules', 'prompt_presets', 'personas'],
      })
      alternateNamespaceResponse = await assertScopedLoadOnHotPath(
        () => sendRequest({ ...request, context: { ...request.context, pageSessionId: 'page-b' } }),
        { allowTables: ['modules', 'prompt_presets', 'personas'] },
      )
      reusedNamespaceResponse = await assertScopedLoadOnHotPath(sendRequest, {
        allowTables: ['modules', 'prompt_presets', 'personas'],
      })
    } finally {
      unsubscribeMetrics()
      if (previousMetrics === undefined) delete process.env.RISU_PROTOCOL_METRICS
      else process.env.RISU_PROTOCOL_METRICS = previousMetrics
    }

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      revision: seeded.revision,
      contextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      entries: [
        {
          requestKey: 'request-a',
          status: 'ok',
          sourceHash: sourceHash(source),
          displaySource: 'hello [before=seed, after=hello]',
          dependencyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          requestKey: 'request-b',
          status: 'ok',
          sourceHash: sourceHash('world'),
          displaySource: 'world [before=seed, after=world]',
          dependencyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    })
    expect(cachedResponse.statusCode).toBe(200)
    expect(alternateNamespaceResponse.statusCode).toBe(200)
    expect(reusedNamespaceResponse.statusCode).toBe(200)
    const batchMetrics = observedMetrics.filter((metric) => metric.metric === 'display_source_batch')
    expect(batchMetrics).toHaveLength(4)
    expect(batchMetrics[0]).toMatchObject({
      queueDepth: 0,
      transcriptMessageCount: 2,
      batchCacheHitCount: 0,
      batchCacheMissCount: 2,
      batchInflightJoinCount: 0,
      streamingBypassCount: 0,
      scopeLoadMs: expect.any(Number),
      sharedDependencyMs: expect.any(Number),
      targetFingerprintMs: expect.any(Number),
    })
    expect(batchMetrics[1]).toMatchObject({ batchCacheHitCount: 2, batchCacheMissCount: 0 })
    expect(batchMetrics[2]).toMatchObject({ batchCacheHitCount: 0, batchCacheMissCount: 2 })
    expect(batchMetrics[3]).toMatchObject({ batchCacheHitCount: 2, batchCacheMissCount: 0 })

    const persistedDb = openDatabase(harness.dataDir)
    try {
      const row = persistedDb.prepare('SELECT data_json FROM chats WHERE id = ?').get('chat-1') as {
        data_json: string
      }
      const persistedChat = JSON.parse(row.data_json) as Record<string, unknown>
      expect(persistedChat.scriptstate).toEqual({ $choice: 'seed' })
      expect(JSON.stringify(persistedChat)).not.toContain('before=seed')
      expect(getSchemaState(persistedDb).revision).toBe(seeded.revision)
    } finally {
      persistedDb.close()
    }

    expect(runtime.writerEpoch).toBeGreaterThanOrEqual(1)
    expect(runtime.databaseLineage).toEqual(expect.any(String))
  })

  it('discards display-state output when a legacy whole-trigger guard aborts', async () => {
    const assertion = await setupAuthedClient(harness.app)
    const db = openDatabase(harness.dataDir)
    const seeded = await applyImport(
      db,
      harness.dataDir,
      normalizeRisuSaveSnapshotDatabase({
        currentChar: 0,
        characters: [
          {
            type: 'character',
            name: 'Tess',
            chaId: 'char-1',
            chatPage: 0,
            triggerscript: [
              {
                comment: 'abort display output',
                type: 'display',
                conditions: [],
                effect: [
                  { type: 'v2SetDisplayState', valueType: 'value', value: 'mutated display text', indent: 0 },
                  { type: 'v2MakeArrayVar', var: '[]', indent: 0 },
                ],
              },
            ],
            chats: [
              {
                id: 'chat-1',
                name: 'Chat',
                note: '',
                localLore: [],
                message: [{ role: 'char', data: 'original display text', chatId: 'message-1' }],
              },
            ],
          },
        ],
      }),
    )
    db.close()
    const source = 'original display text'

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/chats/chat-1/display-sources',
      headers: { 'risu-auth': assertion },
      payload: {
        protocolVersion: 1,
        baseRevision: seeded.revision,
        context: { pageSessionId: 'page-a' },
        targets: [
          {
            requestKey: 'request-a',
            characterId: 'char-1',
            messageId: 'message-1',
            index: 0,
            role: 'char',
            firstMessage: false,
            layer: 'original',
            source,
            sourceHash: sourceHash(source),
            projectionEpoch: 1,
          },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().entries).toEqual([
      expect.objectContaining({
        requestKey: 'request-a',
        status: 'ok',
        displaySource: source,
      }),
    ])
  })

  it('validates strict source hashes', async () => {
    const assertion = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-new' },
    })

    const malformed = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/chats/chat-1/display-sources',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-new' },
      payload: {
        protocolVersion: 1,
        baseRevision: 0,
        context: { pageSessionId: 'page-a' },
        targets: [
          {
            requestKey: 'request-a',
            characterId: 'char-1',
            index: 0,
            role: 'char',
            firstMessage: false,
            layer: 'original',
            source: 'body',
            sourceHash: 'not-a-hash',
            projectionEpoch: 1,
          },
        ],
      },
    })
    expect(malformed.statusCode).toBe(400)
  })

  it('loads only activation-winning module bodies and keeps their display fingerprint stable', async () => {
    const assertion = await setupAuthedClient(harness.app)
    const db = openDatabase(harness.dataDir)
    let revision: number
    try {
      const seeded = await applyImport(
        db,
        harness.dataDir,
        normalizeRisuSaveSnapshotDatabase({
          enabledModules: ['active-module'],
          modules: [
            {
              id: 'active-module',
              name: 'Active module',
              description: '',
              regex: [{ in: 'hello', out: 'module rendered', type: 'editdisplay' }],
            },
          ],
          characters: [
            {
              chaId: 'char-1',
              name: 'Character',
              chats: [{ id: 'chat-1', message: [{ role: 'char', data: 'hello', chatId: 'message-1' }] }],
            },
          ],
        }),
      )
      revision = seeded.revision
    } finally {
      db.close()
    }

    const request = (pageSessionId: string) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/v1/chats/chat-1/display-sources',
        headers: { 'risu-auth': assertion },
        payload: {
          protocolVersion: 1,
          baseRevision: revision,
          context: { pageSessionId },
          targets: [
            {
              requestKey: `request-${pageSessionId}`,
              characterId: 'char-1',
              messageId: 'message-1',
              index: 0,
              role: 'char',
              firstMessage: false,
              layer: 'original',
              source: 'hello',
              sourceHash: sourceHash('hello'),
              projectionEpoch: 1,
            },
          ],
        },
      })

    const baseline = await request('baseline')
    expect(baseline.statusCode, baseline.body).toBe(200)
    const baselineEntry = baseline.json().entries[0]
    expect(baselineEntry).toMatchObject({ status: 'ok', displaySource: 'module rendered' })

    const incompatibleTrigger = {
      comment: 'incompatible body',
      type: ['input', 'output'],
      conditions: [],
      effect: [],
    }
    const persistedDb = openDatabase(harness.dataDir)
    try {
      persistedDb.prepare('INSERT INTO modules (position, data_json) VALUES (?, ?)').run(
        1,
        JSON.stringify({
          id: 'active-module',
          name: 'Ignored later duplicate',
          description: '',
          trigger: [incompatibleTrigger],
        }),
      )
      persistedDb.prepare('INSERT INTO modules (position, data_json) VALUES (?, ?)').run(
        2,
        JSON.stringify({
          id: 'inactive-module',
          name: 'Inactive module',
          description: '',
          trigger: [incompatibleTrigger],
        }),
      )
      persistedDb
        .prepare(
          'INSERT INTO prompt_presets (position, data_json) SELECT COALESCE(MAX(position), -1) + 1, ? FROM prompt_presets',
        )
        .run(
          JSON.stringify({
            id: 'inactive-prompt',
            regex: [{ in: 'hello', out: 'unused', type: { incompatible: true } }],
          }),
        )
      persistedDb
        .prepare('INSERT INTO personas (position, data_json) SELECT COALESCE(MAX(position), -1) + 1, ? FROM personas')
        .run(JSON.stringify({ id: 'inactive-persona', name: { incompatible: true } }))
    } finally {
      persistedDb.close()
    }

    const narrowed = await request('narrowed')
    expect(narrowed.statusCode, narrowed.body).toBe(200)
    expect(narrowed.json().entries[0]).toMatchObject({
      status: 'ok',
      displaySource: 'module rendered',
      dependencyFingerprint: baselineEntry.dependencyFingerprint,
    })

    const activeIncompatibleDb = openDatabase(harness.dataDir)
    try {
      const row = activeIncompatibleDb.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(row.data_json) as Record<string, unknown>
      settings.enabledModules = ['inactive-module']
      activeIncompatibleDb.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      activeIncompatibleDb.close()
    }
    const activeIncompatible = await request('active-incompatible')
    expect(activeIncompatible.statusCode, activeIncompatible.body).toBe(200)
    expect(activeIncompatible.json().entries).toEqual([
      expect.objectContaining({
        requestKey: 'request-active-incompatible',
        status: 'client_fallback',
        reason: 'scope_input_incompatible',
      }),
    ])
  })
})

function streamingRequest(revision = 0): DisplaySourceRequest {
  return {
    protocolVersion: 1,
    baseRevision: revision,
    context: { pageSessionId: 'stream-page' },
    targets: Array.from({ length: 4 }, (_, index) => ({
      requestKey: `target-${index}`,
      characterId: 'stream-char',
      messageId: `message-${index}`,
      index,
      role: 'char',
      firstMessage: false,
      layer: 'original',
      source: `message ${index}`,
      sourceHash: sourceHash(`message ${index}`),
      projectionEpoch: index,
    })),
    priorityKeys: ['target-3', 'target-2', 'target-1'],
  }
}

describe('prioritized display streams', () => {
  it('rejects priority keys outside the batch or repeated keys', () => {
    expect(() => readDisplaySourceRequest({ ...streamingRequest(), priorityKeys: ['missing'] })).toThrow('priorityKeys')
    expect(() => readDisplaySourceRequest({ ...streamingRequest(), priorityKeys: ['target-1', 'target-1'] })).toThrow(
      'priorityKeys',
    )
  })

  it('flushes three results over HTTP before background completion and preserves request correlation', async () => {
    const assertion = await setupAuthedClient(harness.app)
    let finish!: () => void
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    const transform = vi
      .spyOn(DisplaySourceService.prototype, 'transformBatch')
      .mockImplementation(async (_chatId, request, _signal, onResult) => {
        const context = { protocolVersion: 1 as const, revision: request.baseRevision, contextFingerprint: 'context' }
        const ordered = [...request.targets].sort((a, b) => b.index - a.index)
        const entries = ordered.map((target) => ({
          requestKey: target.requestKey,
          sourceHash: target.sourceHash,
          status: 'ok' as const,
          displaySource: target.source,
          dependencyFingerprint: 'dep',
        }))
        for (const entry of entries.slice(0, 3)) onResult?.({ ...context, entries: [entry] })
        await held
        onResult?.({ ...context, entries: entries.slice(3) })
        return { ...context, entries }
      })
    const address = await harness.app.listen({ host: '127.0.0.1', port: 0 })
    const controller = new AbortController()
    try {
      const response = await fetch(`${address}/api/v1/chats/stream-chat/display-sources`, {
        method: 'POST',
        headers: { 'risu-auth': assertion, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(streamingRequest()),
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(response.headers.get('x-accel-buffering')).toBe('no')
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let data = ''
      while (!data.includes('target-1')) {
        const chunk = await reader.read()
        expect(chunk.done).toBe(false)
        data += decoder.decode(chunk.value, { stream: true })
      }
      expect(data).toContain('target-3')
      expect(data).toContain('target-2')
      expect(data).not.toContain('target-0')
      expect(data).not.toContain('event: done')
      finish()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        data += decoder.decode(chunk.value, { stream: true })
      }
      expect(data).toContain('target-0')
      expect(data).toContain('event: done')
      expect(data.match(/event: result/g)).toHaveLength(4)
    } finally {
      finish()
      controller.abort()
      transform.mockRestore()
    }
  })

  it.each(['revision', 'module'] as const)(
    'executes real targets in priority order and invalidates previously streamed results after a %s change',
    async (change) => {
      const db = openDatabase(harness.dataDir)
      try {
        const seeded = await applyImport(
          db,
          harness.dataDir,
          normalizeRisuSaveSnapshotDatabase({
            characters: [
              {
                chaId: 'stream-char',
                name: 'Character',
                chats: [
                  {
                    id: 'stream-chat',
                    message: streamingRequest().targets.map((target) => ({
                      role: target.role,
                      data: target.source,
                      chatId: target.messageId,
                    })),
                  },
                ],
              },
            ],
          }),
        )
        const service = new DisplaySourceService({ db, dataDir: harness.dataDir })
        const delivered: string[] = []
        const response = await service.transformBatch(
          'stream-chat',
          streamingRequest(seeded.revision),
          undefined,
          (result) => {
            delivered.push(result.entries[0].requestKey)
          },
        )
        expect(delivered).toEqual(['target-3', 'target-2', 'target-1', 'target-0'])
        expect(response.entries.every((entry) => entry.status === 'ok')).toBe(true)
        const staleDelivered: string[] = []
        const stale = await service.transformBatch(
          'stream-chat',
          streamingRequest(seeded.revision),
          undefined,
          (result) => {
            staleDelivered.push(result.entries[0].requestKey)
            if (change === 'revision') db.prepare('UPDATE schema_version SET revision = revision + 1').run()
            else
              db.prepare('INSERT INTO modules (position, data_json) VALUES (0, ?)').run(
                JSON.stringify({ id: 'new-module' }),
              )
          },
        )
        expect(staleDelivered).toEqual(['target-3'])
        expect(stale.entries.every((entry) => entry.status === 'stale')).toBe(true)
        expect(stale.revision).toBe(seeded.revision + (change === 'revision' ? 1 : 0))
      } finally {
        db.close()
      }
    },
  )
})
