import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { writePersistedWithMessages } from '../src/repository.js'
import { attachAbort } from '../src/requestAbort.js'
import { CompletionOutputLimitError, collectCompletionFrames, pipeStream } from '../src/routes/generation.js'
import { STREAM_CLIENT_MAX_BUFFERED_BYTES } from '../src/streamBackpressure.js'
import type { CompletionStreamFrame } from '../src/generation/frames.js'
import { LLMFormat } from '@risuai/shared-core/model-types'

vi.mock('../src/generation/horde.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/generation/horde.js')>()
  return {
    ...actual,
    // Route tests own request mapping; horde.test.ts owns real poll cadence.
    runHorde: (request: Parameters<typeof actual.runHorde>[0]) =>
      actual.runHorde({ ...request, pollIntervalMs: request.pollIntervalMs ?? 1 }),
  }
})

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

let harness: Harness
let originalFetch: typeof globalThis.fetch | undefined

beforeEach(async () => {
  harness = await startHarness()
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  vi.useRealTimers()
  if (originalFetch) {
    globalThis.fetch = originalFetch
  }
  await stopHarness(harness)
})

const basePayload = {
  provider: 'echo',
  model: 'echo_model',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
}

function writeDatabase(database: Record<string, unknown>): void {
  const providerCredentials = Array.isArray(database.providerCredentials) ? [...database.providerCredentials] : []
  const existingApiKeys = new Set(
    providerCredentials.flatMap((credential) =>
      credential && typeof credential === 'object' && !Array.isArray(credential)
        ? [String((credential as Record<string, unknown>).apiKey ?? '')]
        : [],
    ),
  )
  for (const key of [
    database.openAIKey,
    database.proxyKey,
    database.openrouterKey,
    database.nanogptKey,
    database.ollamaApiKey,
    database.claudeAPIKey,
    database.mistralKey,
    database.cohereAPIKey,
    database.hordeConfig && typeof database.hordeConfig === 'object' && !Array.isArray(database.hordeConfig)
      ? (database.hordeConfig as Record<string, unknown>).apiKey
      : undefined,
  ]) {
    if (typeof key !== 'string' || key.length === 0 || existingApiKeys.has(key)) continue
    providerCredentials.push({
      id: `completion-test-credential-${providerCredentials.length + 1}`,
      name: 'Completion test credential',
      type: 'apiKey',
      apiKey: key,
    })
    existingApiKeys.add(key)
  }
  const db = openDatabase(harness.dataDir)
  try {
    writePersistedWithMessages(db, harness.dataDir, {
      _version: 1,
      database: {
        aiModel: 'echo_model',
        subModel: 'echo_model',
        echoMessage: 'Echo Message',
        echoDelay: 0,
        maxResponse: 200,
        temperature: 50,
        useStreaming: false,
        characters: [],
        ...database,
        ...(providerCredentials.length > 0 ? { providerCredentials } : {}),
      },
      assets: [],
    })
  } finally {
    db.close()
  }
}

function openAIChatResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function ollamaChatResponse(text: string, model = 'ollama-model'): Response {
  return new Response(JSON.stringify({ model, message: { role: 'assistant', content: text }, done: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

interface FakeRawReply extends EventEmitter {
  statusCode: number
  headers: Record<string, string>
  chunks: string[]
  ended: boolean
  writableEnded: boolean
  writableLength: number
  writeHead(statusCode: number, headers: Record<string, string>): void
  write(chunk: string): boolean
  end(): void
}

function fakeReply(bufferedBytes = 0): { reply: FastifyReply; raw: FakeRawReply } {
  const raw = new EventEmitter() as FakeRawReply
  raw.statusCode = 0
  raw.headers = {}
  raw.chunks = []
  raw.ended = false
  raw.writableEnded = false
  raw.writableLength = bufferedBytes
  raw.writeHead = (statusCode, headers) => {
    raw.statusCode = statusCode
    raw.headers = headers
  }
  raw.write = (chunk) => {
    raw.chunks.push(chunk)
    raw.writableLength += Buffer.byteLength(chunk)
    return true
  }
  raw.end = () => {
    raw.ended = true
    raw.writableEnded = true
  }
  return { reply: { raw } as unknown as FastifyReply, raw }
}

function fakeAbortReq(): {
  raw: EventEmitter & { complete: boolean }
} {
  return { raw: Object.assign(new EventEmitter(), { complete: true }) }
}

function waitForFrame(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

describe('POST /api/v1/generate/completion', () => {
  it('returns 401 without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      payload: basePayload,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a body missing provider with 400', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, provider: undefined },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'provider is required' })
  })

  it('rejects a body where messages is not an array', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, messages: 'oops' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/messages/)
  })

  it('rejects a non-boolean stream field', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, stream: 'yes' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/stream/)
  })

  it('returns 501 for providers not yet implemented', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, provider: 'novelai' },
    })
    expect(res.statusCode).toBe(501)
    expect(res.json()).toEqual({
      reason: 'provider not implemented yet: novelai',
    })
  })

  it('echo non-streaming returns the configured message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        options: { echo: { message: 'pong', delayMs: 0 } },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ type: 'success', result: 'pong' })
  })

  it('records legacy completion prompts and responses without provider credentials', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const generated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        options: {
          echo: { message: 'history pong', delayMs: 0 },
          openai: { apiKey: 'must-not-be-recorded' },
        },
      },
    })
    expect(generated.statusCode).toBe(200)

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/request-history',
      headers: { 'risu-auth': assertion },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({
      records: [
        {
          status: 'success',
          source: 'completion',
          profile: {
            sourceKind: 'legacy-client-request',
            provider: 'echo',
            modelId: 'echo_model',
          },
          responsePreview: 'history pong',
        },
      ],
    })

    const historyId = listed.json().records[0].id as string
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/request-history/${historyId}`,
      headers: { 'risu-auth': assertion },
    })
    expect(detail.json()).toMatchObject({
      record: {
        prompt: [{ role: 'user', content: 'hi' }],
        response: 'history pong',
      },
    })
    expect(JSON.stringify(detail.json())).not.toContain('must-not-be-recorded')
  })

  it('echo non-streaming falls back to default message when options.echo is absent', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ type: 'success', result: 'Echo Message' })
  })

  it('echo streaming emits one chunk frame and one done frame', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        stream: true,
        options: { echo: { message: 'flow', delayMs: 0 } },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'flow' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
  })

  it('server-intent completion resolves provider settings from the server database', async () => {
    writeDatabase({ echoMessage: 'server-owned pong' })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        mode: 'model',
        maxTokens: 64,
        temperature: 0.3,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ type: 'success', result: 'server-owned pong' })
  })

  it('round-trips only supplied tool calls and browser results through server-owned OpenAI dispatch', async () => {
    writeDatabase({ aiModel: 'gpt4o', openAIKey: 'sk-server-owned' })
    const tool = {
      name: 'risu-get-character-info',
      description: 'Get character information.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    }
    const sentBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      if (sentBodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: tool.name, arguments: '{"id":"mira-id"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return openAIChatResponse('Mira is ready.')
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'Is Mira available?' }],
        stream: false,
        mode: 'model',
        tools: [tool],
      },
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toEqual({
      type: 'success',
      result: '',
      toolCalls: [{ id: 'call-1', name: tool.name, arguments: { id: 'mira-id' } }],
    })

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'Is Mira available?' }],
        stream: false,
        mode: 'model',
        tools: [tool],
        toolRounds: [
          {
            assistantContent: '',
            calls: [{ id: 'call-1', name: tool.name, arguments: { id: 'mira-id' } }],
            results: [{ callId: 'call-1', name: tool.name, content: '{"name":"Mira"}' }],
          },
        ],
      },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ type: 'success', result: 'Mira is ready.' })
    expect(sentBodies).toHaveLength(2)
    expect(sentBodies[0].tools).toEqual([
      {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      },
    ])
    expect(sentBodies[1].messages).toEqual([
      { role: 'user', content: 'Is Mira available?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: tool.name, arguments: '{"id":"mira-id"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"name":"Mira"}' },
    ])
  })

  it('proxies native Ollama Cloud tool rounds with the server model and stored credential', async () => {
    writeDatabase({
      aiModel: 'ollama-cloud',
      ollamaApiKey: 'sk-server-ollama-cloud',
      ollamaCloudModel: 'server-native-model',
      ollamaRequestFormat: LLMFormat.Ollama,
      ollamaThinkingMode: 'medium',
    })
    let captured:
      | {
          url: string
          headers: Record<string, string>
          body: Record<string, unknown>
        }
      | undefined
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      }
      return new Response(
        `${JSON.stringify({ message: { role: 'assistant', content: 'cloud stream' }, done: true })}\n`,
        {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const toggles = encodeURIComponent(JSON.stringify({ tools: '1' }))
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generate/completion?operation=ollama-cloud-tool&protocol=native&mode=model&staticModel=ollama-cloud&characterId=char-cloud&chatId=chat-cloud&toggles=${toggles}`,
      headers: { 'risu-auth': assertion },
      payload: {
        model: 'browser-controlled-model',
        messages: [{ role: 'user', content: 'use a tool' }],
        stream: true,
        think: false,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/x-ndjson')
    expect(res.body).toContain('cloud stream')
    expect(captured).toBeDefined()
    expect(captured?.url).toBe('https://ollama.com/api/chat')
    expect(captured?.headers.authorization).toBe('Bearer sk-server-ollama-cloud')
    expect(captured?.body).toMatchObject({
      model: 'server-native-model',
      stream: true,
      think: 'medium',
      messages: [{ role: 'user', content: 'use a tool' }],
    })

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/request-history',
      headers: { 'risu-auth': assertion },
    })
    expect(listed.json()).toMatchObject({
      records: [
        {
          status: 'success',
          source: 'chat',
          context: { characterId: 'char-cloud', chatId: 'chat-cloud' },
          profile: { provider: 'ollama', modelId: 'ollama-cloud' },
        },
      ],
    })
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/request-history/${listed.json().records[0].id as string}`,
      headers: { 'risu-auth': assertion },
    })
    expect(detail.json()).toMatchObject({
      record: {
        prompt: { messages: [{ role: 'user', content: 'use a tool' }] },
        toggles: { tools: '1' },
      },
    })
    expect(detail.json().record.response).toContain('cloud stream')
    expect(JSON.stringify(detail.json())).not.toContain('sk-server-ollama-cloud')
  })

  it.each([
    [LLMFormat.OpenAICompatible, 'openai-chat', 'https://ollama.com/v1/chat/completions'],
    [LLMFormat.OpenAIResponseAPI, 'openai-responses', 'https://ollama.com/v1/responses'],
    [LLMFormat.Anthropic, 'anthropic', 'https://ollama.com/v1/messages'],
  ] as const)(
    'proxies %s Ollama Cloud profile tool rounds only to the fixed endpoint',
    async (format, protocol, url) => {
      writeDatabase({
        aiModel: 'echo_model',
        providerCredentials: [
          {
            id: 'credential-ollama',
            name: 'Ollama Cloud',
            type: 'apiKey',
            apiKey: 'sk-server-profile-ollama',
          },
        ],
        modelProfiles: [
          {
            id: 'ollama-cloud-profile',
            name: 'Ollama Cloud Profile',
            providerId: 'ollama',
            modelId: 'ollama-cloud',
            providerOptions: {
              credentialId: 'credential-ollama',
              requestModel: 'server-profile-model',
              ollama: { requestFormat: format },
              extraHeaders: {
                'X-Ollama-Trace': 'profile-trace',
                Authorization: 'Bearer browser-controlled',
              },
              additionalParams: [
                ['metadata.audit', 'true'],
                ['header::X-Ollama-Param', 'profile-param'],
                ['header::Authorization', 'Bearer parameter-controlled'],
              ],
            },
          },
        ],
      })
      const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
      globalThis.fetch = (async (upstreamUrl: string, init: RequestInit) => {
        calls.push({
          url: upstreamUrl,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof globalThis.fetch

      const { assertion } = await setupAuthedClient(harness.app)
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/generate/completion?operation=ollama-cloud-tool&protocol=${protocol}&mode=model&profileId=ollama-cloud-profile`,
        headers: { 'risu-auth': assertion },
        payload: {
          model: 'browser-controlled-model',
          messages: [{ role: 'user', content: 'hello' }],
          ...(protocol === 'openai-responses' ? {} : { stream: false }),
        },
      })

      expect(res.statusCode).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        url,
        headers: {
          authorization: 'Bearer sk-server-profile-ollama',
          'X-Ollama-Trace': 'profile-trace',
          'X-Ollama-Param': 'profile-param',
        },
        body: {
          model: 'server-profile-model',
          metadata: { audit: true },
          ...(protocol === 'openai-responses' ? {} : { stream: false }),
        },
      })
      expect(new Headers(calls[0].headers).get('authorization')).toBe('Bearer sk-server-profile-ollama')
      expect(Object.keys(calls[0].headers).filter((key) => key.toLowerCase() === 'authorization')).toHaveLength(1)
    },
  )

  it('rejects stale protocols and caller-supplied target URLs before Ollama Cloud dispatch', async () => {
    writeDatabase({
      aiModel: 'ollama-cloud',
      ollamaApiKey: 'sk-server-ollama-cloud',
      ollamaCloudModel: 'server-native-model',
      ollamaRequestFormat: LLMFormat.Ollama,
    })
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    const { assertion } = await setupAuthedClient(harness.app)

    const mismatch = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion?operation=ollama-cloud-tool&protocol=openai-chat&mode=model&staticModel=ollama-cloud',
      headers: { 'risu-auth': assertion },
      payload: { model: 'ignored', messages: [{ role: 'user', content: 'hi' }], stream: false },
    })
    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.json().error).toContain('protocol no longer matches')

    const arbitraryTarget = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion?operation=ollama-cloud-tool&protocol=native&mode=model&staticModel=ollama-cloud&url=https%3A%2F%2Fevil.example',
      headers: { 'risu-auth': assertion },
      payload: { model: 'ignored', messages: [{ role: 'user', content: 'hi' }], stream: false },
    })
    expect(arbitraryTarget.statusCode).toBe(400)
    expect(arbitraryTarget.json()).toEqual({ error: 'invalid Ollama Cloud tool request identity' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('server-intent completion preserves the uninitialized database response', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'database is not initialized' })
  })

  it('server-intent completion preserves model-mode selection and provider payload options', async () => {
    writeDatabase({
      aiModel: 'gpt4o',
      subModel: 'gpt4om',
      openAIKey: 'sk-server-owned',
      // `/completion` callers own their explicit stream flag; persisted
      // half-streaming must not turn intentionally buffered auxiliary calls on.
      halfStreaming: true,
      modelRoles: {
        scriptMain: 'gpt-5',
      },
      seperateModelsForAxModels: true,
      seperateModels: {
        memory: 'gpt41',
        emotion: 'gpt41-mini',
        otherAx: 'gpt41-nano',
        translate: 'gpt-5-mini',
        scriptAux: 'gpt-5-nano',
      },
    })
    const sentBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(init.body as string))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'server mode ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const modes = [
      ['model', 'gpt-4o'],
      ['submodel', 'gpt-4o-mini'],
      ['memory', 'gpt-4.1'],
      ['emotion', 'gpt-4.1-mini'],
      ['otherAx', 'gpt-4.1-nano'],
      ['translate', 'gpt-5-mini'],
      ['scriptMain', 'gpt-5'],
      ['scriptAux', 'gpt-5-nano'],
    ] as const
    for (const [mode] of modes) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/completion',
        headers: { 'risu-auth': assertion },
        payload: {
          kind: 'server-intent',
          messages: [{ role: 'user', content: `hi ${mode}` }],
          stream: false,
          mode,
          maxTokens: 321,
          temperature: 0.42,
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ type: 'success', result: 'server mode ok' })
    }

    expect(sentBodies).toHaveLength(modes.length)
    expect(sentBodies.map((body) => body.model)).toEqual(modes.map(([, model]) => model))
    for (const body of sentBodies) {
      expect(body.stream).toBe(false)
      if (String(body.model).startsWith('gpt-5')) {
        expect(body.max_completion_tokens).toBe(321)
        expect(body.max_tokens).toBeUndefined()
      } else {
        expect(body.max_tokens).toBe(321)
      }
      expect(body.temperature).toBe(0.42)
    }
  })

  it('server-intent completion preserves staticModel and streaming response bytes', async () => {
    writeDatabase({
      aiModel: 'gpt4o',
      openAIKey: 'sk-server-owned',
    })
    let sent: Record<string, unknown> | null = null
    const enc = new TextEncoder()
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'streamed' } }] })}\n\n`),
          )
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        staticModel: 'gpt4om',
        maxTokens: 11,
        temperature: 0.25,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'streamed' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
    expect(sent).toMatchObject({
      model: 'gpt-4o-mini',
      stream: true,
      max_tokens: 11,
      temperature: 0.25,
    })
  })

  it('server-intent completion resolves staticModel xcustom provider settings from the custom row', async () => {
    writeDatabase({
      aiModel: 'gpt4o',
      openAIKey: 'sk-primary',
      customModels: [
        {
          id: 'xcustom:::fallback-openai',
          name: 'Fallback OpenAI',
          internalId: 'fallback-internal-model',
          url: 'https://fallback.example.com/custom/v1/chat/completions',
          key: 'sk-fallback',
          format: LLMFormat.OpenAICompatible,
          params: 'extra.fallback=true\nheader::X-Fallback-Trace=fallback-static',
          flags: [],
          tokenizer: 0,
        },
      ],
    })
    const captured: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured.push({
        url,
        body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
        headers: init.headers as Record<string, string>,
      })
      return openAIChatResponse('static fallback ok')
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        mode: 'memory',
        staticModel: 'xcustom:::fallback-openai',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'static fallback ok' })
    expect(captured).toHaveLength(1)
    const sent = captured[0]
    expect(sent.url).toBe('https://fallback.example.com/custom/v1/chat/completions')
    expect(sent.body.model).toBe('fallback-internal-model')
    expect(sent.body.extra).toEqual({ fallback: true })
    expect(sent.headers.authorization).toBe('Bearer sk-fallback')
    expect(sent.headers.authorization).not.toBe('Bearer sk-primary')
    expect(sent.headers['X-Fallback-Trace']).toBe('fallback-static')
  })

  it('server-intent completion resolves fallbackProfileId from durable profile settings', async () => {
    writeDatabase({
      aiModel: 'echo_model',
      top_p: 0.91,
      frequencyPenalty: 88,
      PresensePenalty: 77,
      providerCredentials: [
        { id: 'credential-fallback', name: 'Fallback', type: 'apiKey', apiKey: 'sk-fallback-profile' },
      ],
      modelProfiles: [
        {
          id: 'fallback-profile',
          name: 'Fallback Profile',
          modelId: 'reverse_proxy',
          providerOptions: {
            credentialId: 'credential-fallback',
            requestModel: 'fallback-wire-model',
            baseUrl: 'https://fallback-profile.example.com/v1',
          },
          runtimeOptions: {
            maxResponse: 77,
            temperature: 33,
            topP: 0.42,
            frequencyPenalty: 25,
            presencePenalty: -50,
          },
        },
      ],
    })
    const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
        headers: init.headers as Record<string, string>,
      })
      return openAIChatResponse('durable fallback ok')
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        mode: 'model',
        fallbackProfileId: 'fallback-profile',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ type: 'success', result: 'durable fallback ok' })
    const sentRequest = sent[0]
    if (!sentRequest) throw new Error('expected fallback profile request to be captured')
    expect(sentRequest).toMatchObject({
      url: 'https://fallback-profile.example.com/v1/chat/completions',
      body: {
        model: 'fallback-wire-model',
        max_tokens: 77,
        temperature: 0.33,
        top_p: 0.42,
        frequency_penalty: 0.25,
        presence_penalty: -0.5,
      },
    })
    expect(sentRequest.headers.authorization).toBe('Bearer sk-fallback-profile')
  })

  it('server-intent completion rejects malformed fallbackProfileId', async () => {
    writeDatabase({ aiModel: 'echo_model' })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        fallbackProfileId: 42,
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'fallbackProfileId must be a string when provided' })
  })

  it.each([
    {
      label: 'missing active durable profile',
      database: {
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'missing-profile' } },
      },
      stream: true,
      reason: 'profile-not-found',
    },
    {
      label: 'model-less active durable profile',
      database: {
        modelProfiles: [{ id: 'empty-profile', name: 'Empty Profile' }],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'empty-profile' } },
      },
      stream: false,
      reason: 'profile-model-missing',
    },
    {
      label: 'unsupported active durable profile',
      database: {
        modelProfiles: [
          {
            id: 'unsupported-profile',
            name: 'Unsupported Profile',
            providerId: 'not-a-provider',
            modelId: 'gpt-5',
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'unsupported-profile' } },
      },
      stream: false,
      reason: 'unsupported-provider-id',
    },
    {
      label: 'incomplete active first-class durable profile',
      database: {
        modelProfiles: [
          {
            id: 'incomplete-profile',
            name: 'Incomplete Profile',
            providerId: 'openai',
            modelId: 'gpt-5',
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'incomplete-profile' } },
      },
      stream: false,
      reason: 'api-key-missing',
    },
  ])('server-intent completion rejects $label before provider dispatch', async (testCase) => {
    writeDatabase(testCase.database)
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: testCase.stream,
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['content-type']).not.toBe('text/event-stream')
    expect(res.json().error).toContain(testCase.reason)
    expect(res.json().error).toContain('Model profile')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('server-intent completion dispatches provider request models from the resolved profile', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured.push({
        url,
        body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
        headers: init.headers as Record<string, string>,
      })
      if (url.endsWith('/api/chat')) return ollamaChatResponse('profile request ok', 'llama3')
      return openAIChatResponse('profile request ok')
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const cases: Array<{
      label: string
      database: Record<string, unknown>
      expectedUrl: string
      expectedModel: string
      expectedHeader?: [string, string]
    }> = [
      {
        label: 'reverse_proxy',
        database: {
          aiModel: 'reverse_proxy',
          customProxyRequestModel: 'proxy-wire-model',
          customAPIFormat: LLMFormat.OpenAICompatible,
          forceReplaceUrl: 'https://proxy.example.com/v1',
          proxyKey: 'sk-proxy',
        },
        expectedUrl: 'https://proxy.example.com/v1/chat/completions',
        expectedModel: 'proxy-wire-model',
      },
      {
        label: 'xcustom internal id',
        database: {
          providerCredentials: [
            { id: 'xcustom-credential', name: 'Profile OpenAI', type: 'apiKey', apiKey: 'sk-xcustom' },
          ],
          modelProfiles: [
            {
              id: 'xcustom-profile',
              name: 'Profile OpenAI',
              modelId: 'custom-api',
              providerId: 'custom-api',
              providerOptions: {
                credentialId: 'xcustom-credential',
                baseUrl: 'https://custom.example.com/v1',
                requestModel: 'xcustom-wire-model',
              },
            },
          ],
          modelProfileOrder: ['xcustom-profile'],
          modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'xcustom-profile' } },
        },
        expectedUrl: 'https://custom.example.com/v1/chat/completions',
        expectedModel: 'xcustom-wire-model',
      },
      {
        label: 'OpenRouter request model',
        database: {
          aiModel: 'openrouter',
          openrouterKey: 'sk-openrouter',
          openrouterRequestModel: 'anthropic/claude-sonnet',
        },
        expectedUrl: 'https://openrouter.ai/api/v1/chat/completions',
        expectedModel: 'anthropic/claude-sonnet',
        expectedHeader: ['X-Title', 'RisuAI'],
      },
      {
        label: 'NanoGPT request model and provider header',
        database: {
          aiModel: 'nanogpt',
          nanogptKey: 'sk-nano',
          nanogptRequestModel: 'nano/provider-model',
          nanogptProvider: 'together',
          nanogptUseSubscriptionEndpoint: true,
        },
        expectedUrl: 'https://nano-gpt.com/api/subscription/v1/chat/completions',
        expectedModel: 'nano/provider-model',
        expectedHeader: ['X-Provider', 'together'],
      },
      {
        label: 'Ollama cloud request model',
        database: {
          aiModel: 'ollama-cloud',
          ollamaApiKey: 'sk-ollama-cloud',
          ollamaRequestFormat: LLMFormat.OpenAICompatible,
          ollamaCloudModel: 'gpt-oss:20b',
        },
        expectedUrl: 'https://ollama.com/v1/chat/completions',
        expectedModel: 'gpt-oss:20b',
      },
      {
        label: 'native Ollama request model',
        database: {
          aiModel: 'ollama-hosted',
          ollamaURL: 'http://localhost:11434',
          ollamaModel: 'llama3',
        },
        expectedUrl: 'http://localhost:11434/api/chat',
        expectedModel: 'llama3',
      },
    ]

    for (const testCase of cases) {
      writeDatabase(testCase.database)
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/completion',
        headers: { 'risu-auth': assertion },
        payload: {
          kind: 'server-intent',
          messages: [{ role: 'user', content: `hi ${testCase.label}` }],
          stream: false,
        },
      })
      expect(res.statusCode, `${testCase.label}: ${res.body}`).toBe(200)
      expect(res.json()).toMatchObject({ type: 'success', result: 'profile request ok' })

      const sent = captured.at(-1)
      expect(sent?.url).toBe(testCase.expectedUrl)
      expect(sent?.body.model).toBe(testCase.expectedModel)
      if (testCase.expectedHeader) {
        const [name, value] = testCase.expectedHeader
        expect(sent?.headers[name]).toBe(value)
      }
    }
  })

  it('server-intent completion rejects unknown OpenAI-compatible ids before provider dispatch', async () => {
    writeDatabase({
      aiModel: 'unregistered-local-model',
      openAIKey: 'sk-server-owned',
    })
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error:
        'unsupported /chat provider: unknown OpenAI-compatible model "unregistered-local-model" cannot be dispatched by the server',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('server-intent completion synthesizes the current character name for horde cleanup', async () => {
    writeDatabase({
      aiModel: 'horde:::auto',
      hordeConfig: { apiKey: 'hk-server-owned' },
      instructChatTemplate: 'gpt2',
      maxContext: 100,
      maxResponse: 20,
      username: 'User',
    })
    globalThis.fetch = (async (url: string) => {
      const asString = String(url)
      if (asString.endsWith('/generate/text/async')) {
        return new Response(JSON.stringify({ id: 'horde-job' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          done: true,
          generations: [{ text: 'clean result\nGuide: trailing role text' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        currentCharName: 'Guide',
      },
    })

    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ type: 'success', result: 'clean result' })
  })

  it('server-intent completion rejects provider wire fields', async () => {
    writeDatabase({})
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        kind: 'server-intent',
        provider: 'echo',
        model: 'echo_model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { echo: { message: 'client-owned pong' } },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'server-intent completion must not include provider, model, or options',
    })
  })

  it.each([
    { field: 'provider', label: 'a provider', value: 'openai' },
    { field: 'model', label: 'a model', value: 'client-owned-model' },
    { field: 'options', label: 'options', value: { openai: { apiKey: 'client-owned-key' } } },
    { field: 'provider', label: 'a null provider', value: null },
    { field: 'model', label: 'a null model', value: null },
    { field: 'options', label: 'null options', value: null },
  ])('server-intent completion rejects $label independently before dispatch', async ({ field, value }) => {
    writeDatabase({ aiModel: 'gpt4o', openAIKey: 'sk-server-owned' })
    const fetchSpy = vi.fn(async () => openAIChatResponse('server-owned answer'))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    const { assertion } = await setupAuthedClient(harness.app)
    const request = {
      method: 'POST' as const,
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
    }
    const payload = {
      kind: 'server-intent',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }

    // The identical request without the forbidden field must be dispatchable.
    const control = await harness.app.inject({ ...request, payload })
    expect(control.statusCode).toBe(200)
    expect(control.json()).toEqual({ type: 'success', result: 'server-owned answer' })
    expect(fetchSpy).toHaveBeenCalledOnce()
    fetchSpy.mockClear()

    const rejected = await harness.app.inject({ ...request, payload: { ...payload, [field]: value } })

    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toEqual({
      error: 'server-intent completion must not include provider, model, or options',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('server-intent completion rejects streaming tools before dispatch', async () => {
    writeDatabase({ aiModel: 'gpt4o', openAIKey: 'sk-server-owned' })
    const fetchSpy = vi.fn(async () => openAIChatResponse('buffered tool answer'))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    const { assertion } = await setupAuthedClient(harness.app)
    const request = {
      method: 'POST' as const,
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
    }
    const payload = {
      kind: 'server-intent',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      tools: [{ name: 'lookup', description: 'Look up a record', inputSchema: { type: 'object' } }],
    }

    const control = await harness.app.inject({ ...request, payload })
    expect(control.statusCode).toBe(200)
    expect(control.json()).toEqual({ type: 'success', result: 'buffered tool answer' })
    expect(fetchSpy).toHaveBeenCalledOnce()
    fetchSpy.mockClear()

    const rejected = await harness.app.inject({ ...request, payload: { ...payload, stream: true } })

    expect(rejected.statusCode).toBe(400)
    expect(rejected.headers['content-type']).toMatch(/application\/json/)
    expect(rejected.json()).toEqual({ error: 'server-intent tool requests must use buffered completion' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'missing', tools: undefined },
    { label: 'empty', tools: [] },
  ])('server-intent completion rejects toolRounds with $label tools before dispatch', async ({ tools }) => {
    writeDatabase({ aiModel: 'gpt4o', openAIKey: 'sk-server-owned' })
    const fetchSpy = vi.fn(async () => openAIChatResponse('tool round answer'))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    const { assertion } = await setupAuthedClient(harness.app)
    const request = {
      method: 'POST' as const,
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
    }
    const payload = {
      kind: 'server-intent',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      tools: [{ name: 'lookup', description: 'Look up a record', inputSchema: { type: 'object' } }],
      // No unavailable call or malformed result can mask the tools requirement.
      toolRounds: [],
    }

    const control = await harness.app.inject({ ...request, payload })
    expect(control.statusCode).toBe(200)
    expect(control.json()).toEqual({ type: 'success', result: 'tool round answer' })
    expect(fetchSpy).toHaveBeenCalledOnce()
    fetchSpy.mockClear()

    const rejected = await harness.app.inject({ ...request, payload: { ...payload, tools } })

    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toEqual({ error: 'toolRounds require supplied tools' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('echo non-streaming honors options.echo.delayMs', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const start = Date.now()
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        options: { echo: { message: 'slow', delayMs: 40 } },
      },
    })
    const elapsed = Date.now() - start
    expect(res.statusCode).toBe(200)
    expect(elapsed).toBeGreaterThanOrEqual(30)
    expect(res.json()).toEqual({ type: 'success', result: 'slow' })
  })
})

describe('POST /api/v1/generate/completion (openai)', () => {
  const openaiPayload = {
    provider: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    options: {
      openai: {
        apiKey: 'sk-test',
        baseUrl: 'https://upstream.example.com/v1',
      },
    },
  }

  it('400s when options.openai.apiKey is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...openaiPayload, options: { openai: { apiKey: '' } } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'options.openai.apiKey is required',
    })
  })

  it('non-streaming forwards model + messages + Bearer auth and returns assistant content', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'gpt-4o',
          choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: openaiPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ type: 'success', result: 'pong', model: 'gpt-4o' })

    expect(captured!.url).toBe('https://upstream.example.com/v1/chat/completions')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.model).toBe('gpt-4o')
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(sent.stream).toBe(false)
  })

  it('non-streaming propagates upstream error.message as a 200 + type=fail', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: { message: 'rate limit hit' } }), { status: 429 })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: openaiPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      type: 'fail',
      result: 'Provider request failed: HTTP 429 from https://upstream.example.com/v1/chat/completions: rate limit hit',
      status: 429,
    })
  })

  it('streaming relays upstream SSE deltas through the normalized envelope', async () => {
    const enc = new TextEncoder()
    const upstreamFrames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] })}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const f of upstreamFrames) controller.enqueue(enc.encode(f))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...openaiPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'hel' })}\n\n` +
        `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'lo' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
  })

  it('active streaming completion survives past the original deadline', async () => {
    vi.useFakeTimers()
    const req = fakeAbortReq()
    const { reply, raw } = fakeReply()
    const { signal, refresh, cleanup } = attachAbort(req, reply, { deadlineMs: 100 })
    let settled = false

    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      if (await waitForFrame(90, signal)) yield { kind: 'token', content: 'a' }
      if (await waitForFrame(90, signal)) yield { kind: 'token', content: 'b' }
      if (!signal.aborted) yield { kind: 'done', finishReason: 'stop' }
    }

    const run = pipeStream(reply, frames(), refresh).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(90)
    expect(signal.aborted).toBe(false)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(11)
    expect(signal.aborted).toBe(false)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(79)
    await run

    expect(raw.ended).toBe(true)
    expect(raw.chunks.join('')).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'a' })}\n\n` +
        `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'b' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
    cleanup()
  })

  it('aborts the upstream before writing another SSE frame to a slow consumer', async () => {
    const { reply, raw } = fakeReply(STREAM_CLIENT_MAX_BUFFERED_BYTES)
    const abort = vi.fn()
    let produced = 0
    let finalized = false

    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      try {
        produced += 1
        yield { kind: 'token', content: 'first' }
        produced += 1
        yield { kind: 'token', content: 'second' }
      } finally {
        finalized = true
      }
    }

    await pipeStream(reply, frames(), undefined, abort)

    expect(abort).toHaveBeenCalledOnce()
    expect(raw.chunks).toEqual([])
    expect(raw.ended).toBe(true)
    expect(produced).toBe(1)
    expect(finalized).toBe(true)
  })

  it('rejects buffered completion output at the UTF-8 byte cap before retaining the overflow token', async () => {
    let finalized = false
    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      try {
        yield { kind: 'token', content: '한' }
        yield { kind: 'token', content: 'abc' }
        yield { kind: 'done', finishReason: 'stop' }
      } finally {
        finalized = true
      }
    }

    await expect(collectCompletionFrames(frames(), 5)).rejects.toEqual(
      expect.objectContaining<Partial<CompletionOutputLimitError>>({
        name: 'CompletionOutputLimitError',
        message: 'completion output exceeded the 5-byte buffer cap',
        maxBytes: 5,
      }),
    )
    expect(finalized).toBe(true)
  })

  it('accepts buffered completion output exactly at the UTF-8 byte cap', async () => {
    let finalized = false
    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      try {
        yield { kind: 'token', content: '한' }
        yield { kind: 'token', content: 'ab' }
        yield { kind: 'token', content: '' }
        yield { kind: 'done', finishReason: 'stop' }
      } finally {
        finalized = true
      }
    }

    await expect(collectCompletionFrames(frames(), 5)).resolves.toEqual({ type: 'success', result: '한ab' })
    expect(finalized).toBe(true)
  })

  it('idle streaming completion aborts at the bounded deadline', async () => {
    vi.useFakeTimers()
    const req = fakeAbortReq()
    const { reply, raw } = fakeReply()
    const { signal, refresh, cleanup } = attachAbort(req, reply, { deadlineMs: 100 })

    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      if (await waitForFrame(200, signal)) yield { kind: 'token', content: 'late' }
    }

    const run = pipeStream(reply, frames(), refresh)
    await vi.advanceTimersByTimeAsync(99)
    expect(signal.aborted).toBe(false)
    expect(raw.ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await run

    expect(signal.aborted).toBe(true)
    expect(raw.ended).toBe(true)
    expect(raw.chunks).toEqual([])
    cleanup()
  })

  it('empty streaming completion tokens do not refresh the deadline', async () => {
    vi.useFakeTimers()
    const req = fakeAbortReq()
    const { reply, raw } = fakeReply()
    const { signal, refresh, cleanup } = attachAbort(req, reply, { deadlineMs: 100 })

    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      if (await waitForFrame(90, signal)) yield { kind: 'token', content: '' }
      if (await waitForFrame(20, signal)) yield { kind: 'token', content: 'late' }
    }

    const run = pipeStream(reply, frames(), refresh)
    await vi.advanceTimersByTimeAsync(90)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    await run

    expect(signal.aborted).toBe(true)
    expect(raw.ended).toBe(true)
    expect(raw.chunks.join('')).toBe(`event: chunk\ndata: ${JSON.stringify({ type: 'token', content: '' })}\n\n`)
    cleanup()
  })

  it('streaming relays CRLF-delimited upstream SSE deltas through the normalized envelope', async () => {
    const enc = new TextEncoder()
    const upstreamFrames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] })}\r\n\r\n`,
      `data: [DONE]\r\n\r\n`,
    ]
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const f of upstreamFrames) controller.enqueue(enc.encode(f))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...openaiPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'hel' })}\n\n` +
        `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'lo' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
  })

  it('streaming emits an error event when upstream returns non-OK', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'upstream broke', code: 'boom' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...openaiPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: error\ndata: ${JSON.stringify({
        type: 'provider_error',
        error:
          'Provider request failed: HTTP 500 from https://upstream.example.com/v1/chat/completions (boom): upstream broke',
        status: 500,
        code: 'boom',
      })}\n\n`,
    )
  })

  it('streaming emits an error event when upstream has no body', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...openaiPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(
      `event: error\ndata: ${JSON.stringify({
        type: 'provider_error',
        error:
          'Provider request failed: HTTP 200 from https://upstream.example.com/v1/chat/completions: upstream returned no stream body',
        status: 200,
      })}\n\n`,
    )
  })

  it('streaming emits an error event for invalid upstream stream JSON', async () => {
    const enc = new TextEncoder()
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('data: {nope}\n\n'))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...openaiPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('event: error')
    expect(res.body).toContain('invalid upstream stream JSON')
  })

  it('streaming emits an error event for unterminated upstream SSE tails', async () => {
    const enc = new TextEncoder()
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('data: {nope}'))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...openaiPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(
      `event: error\ndata: ${JSON.stringify({
        type: 'provider_error',
        error: 'truncated upstream stream event',
      })}\n\n`,
    )
  })
})

describe('POST /api/v1/generate/completion (nanogpt + openrouter)', () => {
  const okOpenAIResponse = (text: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  it('nanogpt 400s when options.nanogpt.apiKey is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'nanogpt',
        model: 'nanogpt',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { nanogpt: {} },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'options.nanogpt.apiKey is required' })
  })

  it('nanogpt forwards to nano-gpt.com with optional X-Provider', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return okOpenAIResponse('hi from nano')
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'nanogpt',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { nanogpt: { apiKey: 'nk-test', providerHint: 'openai' } },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'hi from nano' })

    expect(captured!.url).toBe('https://nano-gpt.com/api/v1/chat/completions')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer nk-test')
    expect(headers['X-Provider']).toBe('openai')
  })

  it('nanogpt routes the subscription endpoint when useSubscription=true', async () => {
    let capturedUrl = ''
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url
      return okOpenAIResponse('sub')
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'nanogpt',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { nanogpt: { apiKey: 'nk-test', useSubscription: true } },
      },
    })
    expect(capturedUrl).toBe('https://nano-gpt.com/api/subscription/v1/chat/completions')
  })

  it('openrouter 400s when options.openrouter.apiKey is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openrouter',
        model: 'openrouter-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { openrouter: {} },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'options.openrouter.apiKey is required' })
  })

  it('openrouter forwards to openrouter.ai with X-Title + HTTP-Referer', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return okOpenAIResponse('openrouter ok')
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openrouter',
        model: 'anthropic/claude-3.5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { openrouter: { apiKey: 'or-test' } },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'openrouter ok' })

    expect(captured!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer or-test')
    expect(headers['X-Title']).toBe('RisuAI')
    expect(headers['HTTP-Referer']).toBe('https://risuai.xyz')
  })
})

describe('POST /api/v1/generate/completion (anthropic)', () => {
  const anthropicPayload = {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    options: {
      anthropic: { apiKey: 'sk-ant-test', maxTokens: 512 },
    },
  }

  it('400s when options.anthropic.apiKey is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...anthropicPayload, options: { anthropic: {} } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'options.anthropic.apiKey is required' })
  })

  it('non-streaming forwards to /messages with x-api-key + anthropic-version and returns text', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'hi from claude' }],
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        ...anthropicPayload,
        options: {
          anthropic: { apiKey: 'sk-ant-test', maxTokens: 512, system: 'be brief' },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      type: 'success',
      result: 'hi from claude',
      model: 'claude-3-5-sonnet-20241022',
    })

    expect(captured!.url).toBe('https://api.anthropic.com/v1/messages')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.model).toBe('claude-3-5-sonnet-20241022')
    expect(sent.max_tokens).toBe(512)
    expect(sent.system).toBe('be brief')
    expect(sent.stream).toBe(false)
  })

  it('streaming relays content_block_delta + message_stop into the normalized envelope', async () => {
    const enc = new TextEncoder()
    const upstreamFrames = [
      `event: message_start\ndata: {}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: 'text_delta', text: 'hi' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' } })}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
    ]
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const f of upstreamFrames) controller.enqueue(enc.encode(f))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...anthropicPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'hi' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
  })

  it('applies additionalParams overlay to the anthropic body + headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'rp ok' }],
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'anthropic',
        model: 'claude-on-proxy',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          anthropic: {
            apiKey: 'sk-proxy',
            baseUrl: 'https://proxy.example.com/v1',
            maxTokens: 256,
            additionalParams: [
              ['header::anthropic-beta', 'cool-beta'],
              ['extra.flag', 'true'],
            ],
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'rp ok' })
    expect(captured!.url).toBe('https://proxy.example.com/v1/messages')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.extra).toEqual({ flag: true })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['anthropic-beta']).toBe('cool-beta')
    expect(headers['x-api-key']).toBe('sk-proxy')
  })

  it('400s with a specific error when options.anthropic.additionalParams is malformed', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          anthropic: {
            apiKey: 'sk-ant-test',
            additionalParams: 'oops',
          },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.anthropic\.additionalParams/)
  })
})

describe('POST /api/v1/generate/completion (mistral)', () => {
  const mistralPayload = {
    provider: 'mistral',
    model: 'mistral-large-latest',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ],
    stream: false,
    options: {
      mistral: { apiKey: 'mk-test', maxTokens: 256, temperature: 0.4 },
    },
  }

  it('400s when options.mistral.apiKey is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...mistralPayload, options: { mistral: {} } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'options.mistral.apiKey is required' })
  })

  it('non-streaming forwards to api.mistral.ai with Bearer auth, safe_prompt=false, and the reformatted messages', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'mistral-large-latest',
          choices: [{ message: { content: 'mistral ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: mistralPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      type: 'success',
      result: 'mistral ok',
      model: 'mistral-large-latest',
    })

    expect(captured!.url).toBe('https://api.mistral.ai/v1/chat/completions')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer mk-test')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.model).toBe('mistral-large-latest')
    expect(sent.safe_prompt).toBe(false)
    expect(sent.max_tokens).toBe(256)
    expect(sent.temperature).toBe(0.4)
    // The two consecutive user turns must be coalesced before the upstream
    // sees them. That collapse happens server-side, not in the SPA payload.
    expect(sent.messages).toEqual([{ role: 'user', content: 'first\nsecond' }])
  })

  it('streaming relays upstream SSE deltas through the normalized envelope', async () => {
    const enc = new TextEncoder()
    const upstreamFrames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'mis' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'tral' }, finish_reason: 'stop' }] })}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const f of upstreamFrames) controller.enqueue(enc.encode(f))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...mistralPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'mis' })}\n\n` +
        `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'tral' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
  })
})

describe('POST /api/v1/generate/completion (mistral additionalParams + reverse_proxy)', () => {
  it('applies additionalParams overlay to the mistral body + headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'mistral-on-proxy',
          choices: [{ message: { content: 'rp ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'mistral',
        model: 'mistral-on-proxy',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          mistral: {
            apiKey: 'sk-proxy',
            baseUrl: 'https://proxy.example.com/v1',
            maxTokens: 256,
            extraHeaders: { 'X-Proxy-Risu': 'RisuAI' },
            additionalParams: [
              ['header::X-Custom', 'cool'],
              ['extra.flag', 'true'],
            ],
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'rp ok' })
    expect(captured!.url).toBe('https://proxy.example.com/v1/chat/completions')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.extra).toEqual({ flag: true })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('cool')
    expect(headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(headers.authorization).toBe('Bearer sk-proxy')
  })

  it('400s with a specific error when options.mistral.additionalParams is malformed', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'mistral',
        model: 'mistral-large-latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          mistral: {
            apiKey: 'mk-test',
            additionalParams: 'oops',
          },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.mistral\.additionalParams/)
  })
})

describe('POST /api/v1/generate/completion (openai with custom baseUrl)', () => {
  // DeepSeek / DeepInfra route through provider='openai' with a derived
  // baseUrl (from modelInfo.endpoint) and a key from db.OaiCompAPIKeys[...].
  // The wire shape is identical to vanilla openai; only the URL differs.
  const deepseekPayload = {
    provider: 'openai',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    options: {
      openai: {
        apiKey: 'ds-key',
        baseUrl: 'https://api.deepseek.com/beta',
      },
    },
  }

  it('routes to {baseUrl}/chat/completions when options.openai.baseUrl is set', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [{ message: { content: 'deepseek ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: deepseekPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'deepseek ok' })
    expect(captured!.url).toBe('https://api.deepseek.com/beta/chat/completions')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ds-key')
  })
})

describe('POST /api/v1/generate/completion (xcustom OAI-compat additionalParams)', () => {
  it('applies the additionalParams overlay to the outgoing body + headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'gpt-on-acme',
          choices: [{ message: { content: 'xcustom ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai',
        model: 'gpt-on-acme',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          openai: {
            apiKey: 'sk-xcustom',
            baseUrl: 'https://acme.example.com/v1',
            temperature: 0.7,
            additionalParams: [
              ['header::X-Custom', 'hello'],
              ['extra.flag', 'true'],
              ['temperature', '{{none}}'],
            ],
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'xcustom ok' })
    expect(captured!.url).toBe('https://acme.example.com/v1/chat/completions')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.extra).toEqual({ flag: true })
    // temperature was set to 0.7 in defaults, then deleted by {{none}}.
    expect(sent.temperature).toBeUndefined()
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('hello')
  })

  it('applies oobaSystemHoist + extraHeaders for reverse_proxy through the same openai route', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'rp ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai',
        model: 'gpt-on-proxy',
        messages: [
          { role: 'system', content: 'rule 1' },
          { role: 'user', content: 'q' },
          { role: 'system', content: 'rule 2' },
        ],
        stream: false,
        options: {
          openai: {
            apiKey: 'sk-proxy',
            baseUrl: 'https://proxy.example.com/v1',
            oobaSystemHoist: true,
            extraHeaders: { 'X-Proxy-Risu': 'RisuAI' },
            additionalParams: [['header::X-Custom', 'rp-hello']],
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'rp ok' })
    expect(captured!.url).toBe('https://proxy.example.com/v1/chat/completions')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'system', content: 'rule 1\nrule 2' },
    ])
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(headers['X-Custom']).toBe('rp-hello')
    expect(headers.authorization).toBe('Bearer sk-proxy')
  })

  it('400s with a specific error when additionalParams shape is malformed', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai',
        model: 'gpt-on-acme',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          openai: {
            apiKey: 'sk-xcustom',
            additionalParams: 'oops',
          },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/additionalParams/)
  })
})

describe('POST /api/v1/generate/completion (cohere)', () => {
  const coherePayload = {
    provider: 'cohere',
    model: 'command-r-plus-04-2024',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'what now' },
    ],
    stream: false,
    options: { cohere: { apiKey: 'co-test', safetyMode: 'NONE' } },
  }

  it('400s when options.cohere.apiKey is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...coherePayload, options: { cohere: {} } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'options.cohere.apiKey is required' })
  })

  it('400s when stream=true (cohere streaming not supported yet)', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...coherePayload, stream: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/cohere streaming/)
  })

  it('forwards to api.cohere.com/v1/chat with the reformatted message + chat_history + preamble', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify({ text: 'cohere ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: coherePayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'cohere ok' })

    expect(captured!.url).toBe('https://api.cohere.com/v1/chat')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer co-test')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.message).toBe('what now')
    expect(sent.preamble).toBe('be brief')
    expect(sent.chat_history).toEqual([
      { role: 'USER', message: 'hello' },
      { role: 'CHATBOT', message: 'hi' },
    ])
    expect(sent.safety_mode).toBe('NONE')
  })
})

describe('POST /api/v1/generate/completion (cohere additionalParams + reverse_proxy)', () => {
  it('applies additionalParams overlay to the cohere body + headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify({ text: 'rp ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'cohere',
        model: 'command-on-proxy',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          cohere: {
            apiKey: 'sk-proxy',
            baseUrl: 'https://proxy.example.com/v1',
            extraHeaders: { 'X-Proxy-Risu': 'RisuAI' },
            additionalParams: [
              ['header::X-Custom', 'cool'],
              ['extra.flag', 'true'],
            ],
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'rp ok' })
    expect(captured!.url).toBe('https://proxy.example.com/v1/chat')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.extra).toEqual({ flag: true })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('cool')
    expect(headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(headers.authorization).toBe('Bearer sk-proxy')
  })

  it('400s with a specific error when options.cohere.additionalParams is malformed', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'cohere',
        model: 'command-r-plus-04-2024',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          cohere: {
            apiKey: 'co-test',
            additionalParams: 'oops',
          },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.cohere\.additionalParams/)
  })
})

describe('POST /api/v1/generate/completion (openai-responses)', () => {
  it('forwards to /v1/responses with input items', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'gpt-5',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'resp ok' }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai-responses',
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { 'openai-responses': { apiKey: 'sk-resp', maxOutputTokens: 128 } },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'resp ok' })
    expect(captured!.url).toBe('https://api.openai.com/v1/responses')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
    expect(sent.max_output_tokens).toBe(128)
  })

  it('rejects streaming before dispatch because Responses completion is buffered', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai-responses',
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        options: { 'openai-responses': { apiKey: 'sk-resp' } },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'openai-responses streaming is not yet supported; set stream: false' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/generate/completion (openai-responses additionalParams + reverse_proxy)', () => {
  it('applies additionalParams overlay to the openai-responses body + headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'gpt-on-proxy',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'rp ok' }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai-responses',
        model: 'gpt-on-proxy',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          'openai-responses': {
            apiKey: 'sk-proxy',
            baseUrl: 'https://proxy.example.com/v1',
            maxOutputTokens: 256,
            additionalParams: [
              ['header::X-Custom', 'cool'],
              ['extra.flag', 'true'],
            ],
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'rp ok' })
    expect(captured!.url).toBe('https://proxy.example.com/v1/responses')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.extra).toEqual({ flag: true })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('cool')
    expect(headers.authorization).toBe('Bearer sk-proxy')
  })

  it('400s with a specific error when options["openai-responses"].additionalParams is malformed', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai-responses',
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          'openai-responses': {
            apiKey: 'sk-resp',
            additionalParams: 'oops',
          },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\["openai-responses"\]\.additionalParams/)
  })
})

describe('POST /api/v1/generate/completion (openai-legacy-instruct additionalParams + reverse_proxy)', () => {
  it('applies additionalParams overlay to the legacy-instruct body + headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'gpt-on-proxy',
          choices: [{ text: 'rp ok' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai-legacy-instruct',
        model: 'gpt-on-proxy',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          'openai-legacy-instruct': {
            apiKey: 'sk-proxy',
            baseUrl: 'https://proxy.example.com/v1',
            maxTokens: 256,
            additionalParams: [
              ['header::X-Custom', 'cool'],
              ['extra.flag', 'true'],
            ],
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'rp ok' })
    expect(captured!.url).toBe('https://proxy.example.com/v1/completions')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.extra).toEqual({ flag: true })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('cool')
    expect(headers.authorization).toBe('Bearer sk-proxy')
  })

  it('400s with a specific error when options["openai-legacy-instruct"].additionalParams is malformed', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'openai-legacy-instruct',
        model: 'gpt-3.5-turbo-instruct',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          'openai-legacy-instruct': {
            apiKey: 'sk-test',
            additionalParams: 'oops',
          },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\["openai-legacy-instruct"\]\.additionalParams/)
  })
})

describe('POST /api/v1/generate/completion (openai-legacy-instruct)', () => {
  const legacyPayload = {
    provider: 'openai-legacy-instruct',
    model: 'gpt-3.5-turbo-instruct',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    stream: false,
    options: {
      'openai-legacy-instruct': { apiKey: 'sk-test', maxTokens: 128 },
    },
  }

  it('400s when apiKey is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...legacyPayload, options: { 'openai-legacy-instruct': {} } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400s when stream=true (not yet supported)', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...legacyPayload, stream: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('forwards to /v1/completions with a flattened prompt', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify({ choices: [{ text: 'pong' }], model: 'gpt-3.5-turbo-instruct' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: legacyPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'pong' })
    expect(captured!.url).toBe('https://api.openai.com/v1/completions')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.prompt).toContain('## User\nhi')
    expect(sent.prompt).toContain('## Response')
  })
})

describe('POST /api/v1/generate/completion (horde)', () => {
  it('400s when options.horde.prompt is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'horde',
        model: 'koboldcpp/Mistral',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { horde: {} },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.horde\.prompt/)
  })

  it('400s when stream=true is requested', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'horde',
        model: 'koboldcpp/Mistral',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        options: { horde: { prompt: 'flattened' } },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/horde streaming is not yet supported/)
  })

  it('submits async + polls + returns generations[0].text', async () => {
    let pollCount = 0
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/generate/text/async')) {
        return new Response(JSON.stringify({ id: 'route-job' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (init?.method === 'DELETE') {
        return new Response('{}', { status: 200 })
      }
      pollCount++
      if (pollCount < 2) {
        return new Response(JSON.stringify({ done: false }), { status: 200 })
      }
      return new Response(JSON.stringify({ done: true, generations: [{ text: 'horde route ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'horde',
        model: 'koboldcpp/Mistral',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          horde: {
            prompt: 'flattened user: hi',
            apiKey: 'my-key',
            // Short poll interval keeps the test fast without fake timers
            // (the route hits real timers under hood).
            pollIntervalMs: 10,
            timeoutMs: 5000,
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'horde route ok' })
  })
})

describe('POST /api/v1/generate/completion (bedrock)', () => {
  it('400s when options.bedrock.credentials is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'bedrock',
        model: 'us.test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { bedrock: {} },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.bedrock\.credentials/)
  })

  it('400s when credentials are partially populated', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'bedrock',
        model: 'us.test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          bedrock: { credentials: { accessKeyId: 'AKIA', secretAccessKey: 's' } },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.bedrock\.region/)
  })

  it('400s when streaming is requested (not supported yet)', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'bedrock',
        model: 'us.test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        options: {
          bedrock: {
            credentials: { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1' },
          },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/bedrock streaming is not yet supported/)
  })

  it('signs the request with SigV4 and forwards the body to the Bedrock URL', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'bedrock route ok' }],
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'bedrock',
        model: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          bedrock: {
            credentials: {
              accessKeyId: 'AKIA',
              secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
              region: 'us-east-1',
            },
            maxTokens: 256,
            system: 'be brief',
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'bedrock route ok' })
    expect(captured!.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke',
    )
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['Authorization']).toContain('AWS4-HMAC-SHA256 Credential=AKIA/')
    expect(headers['Authorization']).toContain('us-east-1/bedrock/aws4_request')
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
    const body = JSON.parse(captured!.init.body as string)
    expect(body.anthropic_version).toBe('bedrock-2023-05-31')
    expect(body.system).toBe('be brief')
    expect(body.max_tokens).toBe(256)
    expect(body.model).toBeUndefined()
  })
})

describe('POST /api/v1/generate/completion (gemini vertex)', () => {
  it('400s when options.gemini.vertex is partially populated', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          gemini: {
            vertex: { projectId: 'p', region: 'us-central1' },
          },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.gemini\.vertex\.clientEmail/)
  })

  it('routes a buffered Vertex request through token exchange then the vertex prediction endpoint', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const { _resetVertexTokenCacheForTesting } = await import('../src/generation/vertexAuth.js')
    _resetVertexTokenCacheForTesting()

    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'ya29.route-token', expires_in: 3599 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          modelVersion: 'gemini-2.5-pro',
          candidates: [{ content: { parts: [{ text: 'vertex route ok' }] }, finishReason: 'STOP' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: {
          gemini: {
            vertex: {
              projectId: 'my-project',
              region: 'us-central1',
              clientEmail: 'svc@my-project.iam.gserviceaccount.com',
              privateKey,
            },
          },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ type: 'success', result: 'vertex route ok' })
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent',
    ])
    const headers = calls[1].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ya29.route-token')
  })
})

describe('POST /api/v1/generate/completion (gemini)', () => {
  const geminiPayload = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    stream: false,
    options: { gemini: { apiKey: 'goog-test', maxOutputTokens: 256 } },
  }

  it('400s when options.gemini.apiKey is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...geminiPayload, options: { gemini: {} } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.gemini\.apiKey/)
  })

  it('non-streaming forwards to /models/<model>:generateContent?key=<apiKey> with contents + systemInstruction', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          modelVersion: 'gemini-2.5-flash',
          candidates: [{ content: { parts: [{ text: 'gemini ok' }] }, finishReason: 'STOP' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: geminiPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      type: 'success',
      result: 'gemini ok',
      model: 'gemini-2.5-flash',
    })

    expect(captured!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=goog-test',
    )
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
    expect(sent.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] })
    expect(sent.generationConfig).toEqual({ maxOutputTokens: 256 })
  })

  it('streaming relays per-frame candidates text into the normalized envelope', async () => {
    const enc = new TextEncoder()
    const frame = (text: string, fr?: string): string => {
      const c: Record<string, unknown> = { content: { parts: [{ text }] } }
      if (fr !== undefined) c.finishReason = fr
      return `data: ${JSON.stringify({ candidates: [c] })}\n\n`
    }
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(frame('hi')))
          controller.enqueue(enc.encode(frame(' there', 'STOP')))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...geminiPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'hi' })}\n\n` +
        `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: ' there' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
  })
})

describe('POST /api/v1/generate/completion (ollama)', () => {
  const ollamaPayload = {
    provider: 'ollama',
    model: 'llama3',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    stream: false,
    options: { ollama: { baseUrl: 'http://localhost:11434', maxTokens: 128 } },
  }

  it('400s when options.ollama.baseUrl is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...ollamaPayload, options: { ollama: {} } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/options\.ollama\.baseUrl/)
  })

  it('non-streaming forwards to {baseUrl}/api/chat and returns message.content', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          model: 'llama3',
          message: { role: 'assistant', content: 'ollama route ok' },
          done: true,
          done_reason: 'stop',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: ollamaPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      type: 'success',
      result: 'ollama route ok',
      model: 'llama3',
    })

    expect(captured!.url).toBe('http://localhost:11434/api/chat')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.model).toBe('llama3')
    expect(sent.stream).toBe(false)
    expect(sent.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ])
    expect(sent.options).toEqual({ num_predict: 128 })
  })

  it('streaming relays per-line NDJSON content into the normalized envelope', async () => {
    const enc = new TextEncoder()
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(`${JSON.stringify({ message: { content: 'hi' }, done: false })}\n`))
          controller.enqueue(enc.encode(`${JSON.stringify({ message: { content: ' there' }, done: false })}\n`))
          controller.enqueue(
            enc.encode(`${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })}\n`),
          )
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...ollamaPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: 'hi' })}\n\n` +
        `event: chunk\ndata: ${JSON.stringify({ type: 'token', content: ' there' })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`,
    )
  })

  it('streaming emits an error event when upstream returns non-OK', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'ollama failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...ollamaPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe(
      `event: error\ndata: ${JSON.stringify({
        type: 'provider_error',
        error: 'Provider request failed: HTTP 500 from http://localhost:11434/api/chat: ollama failed',
        status: 500,
      })}\n\n`,
    )
  })

  it('streaming emits an error event when upstream has no body', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...ollamaPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(
      `event: error\ndata: ${JSON.stringify({
        type: 'provider_error',
        error:
          'Provider request failed: HTTP 200 from http://localhost:11434/api/chat: upstream returned no stream body',
        status: 200,
      })}\n\n`,
    )
  })

  it('streaming emits an error event for invalid upstream NDJSON', async () => {
    const enc = new TextEncoder()
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('{not-json}\n'))
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }) as unknown as typeof globalThis.fetch

    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/completion',
      headers: { 'risu-auth': assertion },
      payload: { ...ollamaPayload, stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('event: error')
    expect(res.body).toContain('invalid upstream stream JSON')
  })
})
