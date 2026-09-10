import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TtsSynthesisRequest } from '@risuai/protocol/tts-synthesis'
import { buildApp } from '../src/app.js'
import { createTtsDisconnectAbort } from '../src/routes/tts.js'
import { executeTtsSynthesis, parseTtsSynthesisRequest, resolveTtsUpstreamRequest } from '../src/tts.js'

const storedContext = {
  settings: {
    elevenLabKey: 'stored-eleven-key',
    fishSpeechKey: 'stored-fish-key',
    huggingfaceKey: 'stored-hf-key',
    NAIApiKey: 'stored-nai-key',
    openAIKey: 'stored-openai-key',
  },
  character: {
    chaId: 'char-openai',
    ttsMode: 'openai',
    oaiVoice: 'nova',
    oaiTTSConfig: {
      enabled: true,
      baseURL: 'https://stored-tts.example/v1/',
      apiKey: 'stored-character-key',
      model: 'stored-tts-model',
      voice: 'stored-voice',
      format: 'wav',
    },
  },
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name)
}

function body(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function expectSemanticUrl(actualValue: string, expectedValue: string): void {
  const actual = new URL(actualValue)
  const expected = new URL(expectedValue)
  expect({
    protocol: actual.protocol,
    host: actual.host,
    pathname: actual.pathname,
    username: actual.username,
    password: actual.password,
    hash: actual.hash,
  }).toEqual({
    protocol: expected.protocol,
    host: expected.host,
    pathname: expected.pathname,
    username: expected.username,
    password: expected.password,
    hash: expected.hash,
  })

  const sortEntries = (entries: [string, string][]): [string, string][] =>
    entries.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
  const actualEntries = Array.from(actual.searchParams.entries())
  const expectedEntries = Array.from(expected.searchParams.entries())
  expect(actualEntries).toHaveLength(expectedEntries.length)
  expect(sortEntries(actualEntries)).toEqual(sortEntries(expectedEntries))
}

describe('TTS synthesis request allowlist', () => {
  it.each([
    {
      request: {
        operation: 'elevenlabs.synthesize',
        credential: { source: 'stored' },
        input: { text: 'hello', voiceId: 'voice/a' },
      } satisfies TtsSynthesisRequest,
      url: 'https://api.elevenlabs.io/v1/text-to-speech/voice%2Fa',
      authHeader: ['xi-api-key', 'stored-eleven-key'],
      expectedBody: { text: 'hello', model_id: 'eleven_multilingual_v2' },
    },
    {
      request: {
        operation: 'fish.synthesize',
        credential: { source: 'stored' },
        input: { text: 'hello', referenceId: 'fish-voice', chunkLength: 200, normalize: true },
      } satisfies TtsSynthesisRequest,
      url: 'https://api.fish.audio/v1/tts',
      authHeader: ['authorization', 'Bearer stored-fish-key'],
      expectedBody: {
        text: 'hello',
        reference_id: 'fish-voice',
        chunk_length: 200,
        normalize: true,
        format: 'mp3',
        mp3_bitrate: 192,
      },
    },
    {
      request: {
        operation: 'huggingface.synthesize',
        credential: { source: 'stored' },
        input: { text: 'hello', model: 'owner/model name' },
      } satisfies TtsSynthesisRequest,
      url: 'https://api-inference.huggingface.co/models/owner/model%20name',
      authHeader: ['authorization', 'Bearer stored-hf-key'],
      expectedBody: { inputs: 'hello' },
    },
    {
      request: {
        operation: 'novelai.synthesize',
        credential: { source: 'stored' },
        input: { text: 'hello world', seed: 'Aini voice', version: 'v2' },
      } satisfies TtsSynthesisRequest,
      url: 'https://api.novelai.net/ai/generate-voice?text=hello+world&voice=-1&seed=Aini+voice&opus=false&version=v2',
      authHeader: ['authorization', 'Bearer stored-nai-key'],
    },
    {
      request: {
        operation: 'openai.synthesize',
        credential: { source: 'stored-character', characterId: 'char-openai' },
        input: { text: 'hello' },
      } satisfies TtsSynthesisRequest,
      url: 'https://stored-tts.example/v1/audio/speech',
      authHeader: ['authorization', 'Bearer stored-character-key'],
      expectedBody: {
        model: 'stored-tts-model',
        input: 'hello',
        voice: 'stored-voice',
        response_format: 'wav',
      },
    },
  ])('maps $request.operation to a bounded configured target', ({ request, url, authHeader, expectedBody }) => {
    const upstream = resolveTtsUpstreamRequest(request, storedContext)
    if (request.operation === 'novelai.synthesize') expectSemanticUrl(upstream.url, url)
    else expect(upstream.url).toBe(url)
    expect(upstream.init.redirect).toBe('error')
    expect(header(upstream.init, authHeader[0])).toBe(authHeader[1])
    if (expectedBody) expect(body(upstream.init)).toEqual(expectedBody)
    else expect(upstream.init.body).toBeUndefined()
  })

  it('allows a caller-owned OpenAI-compatible key only with a validated explicit config', () => {
    const request = parseTtsSynthesisRequest({
      operation: 'openai.synthesize',
      credential: { source: 'provided', apiKey: 'draft-key' },
      input: {
        text: 'hello',
        config: {
          baseUrl: 'http://127.0.0.1:8080/v1/',
          model: 'local-tts',
          voice: 'local-voice',
          format: 'opus',
        },
      },
    })
    const upstream = resolveTtsUpstreamRequest(request, storedContext)

    expect(upstream.url).toBe('http://127.0.0.1:8080/v1/audio/speech')
    expect(header(upstream.init, 'authorization')).toBe('Bearer draft-key')
    expect(body(upstream.init)).toMatchObject({ model: 'local-tts', response_format: 'opus' })
  })

  it('keeps a stored global fallback bound to the persisted character endpoint', () => {
    const request: TtsSynthesisRequest = {
      operation: 'openai.synthesize',
      credential: { source: 'stored-character', characterId: 'char-openai' },
      input: { text: 'hello' },
    }
    const upstream = resolveTtsUpstreamRequest(request, {
      settings: { openAIKey: 'stored-global-key' },
      character: {
        chaId: 'char-openai',
        ttsMode: 'openai',
        oaiTTSConfig: {
          enabled: true,
          baseURL: 'https://stored-custom.example/v1',
          model: 'custom-model',
          voice: 'custom-voice',
          format: 'aac',
        },
      },
    })

    expect(upstream.url).toBe('https://stored-custom.example/v1/audio/speech')
    expect(header(upstream.init, 'authorization')).toBe('Bearer stored-global-key')
  })

  it('rejects caller-selected targets for stored secrets, masked draft keys, and arbitrary fields', () => {
    expect(() =>
      parseTtsSynthesisRequest({
        operation: 'openai.synthesize',
        credential: { source: 'stored-character', characterId: 'char-openai' },
        input: {
          text: 'hello',
          config: { baseUrl: 'https://attacker.example', model: 'x', voice: 'x', format: 'mp3' },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_tts_request' }))
    expect(() =>
      parseTtsSynthesisRequest({
        operation: 'fish.synthesize',
        credential: { source: 'provided', apiKey: '__RISU_SECRET_MASKED__' },
        input: { text: 'hello', referenceId: 'voice', chunkLength: 200, normalize: false },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_tts_request' }))
    expect(() =>
      parseTtsSynthesisRequest({
        operation: 'elevenlabs.synthesize',
        credential: { source: 'stored' },
        input: { text: 'hello', voiceId: 'voice', url: 'https://attacker.example' },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_tts_request' }))
    expect(() =>
      parseTtsSynthesisRequest({
        operation: 'openai.synthesize',
        credential: { source: 'provided', apiKey: 'draft-key' },
        input: {
          text: 'hello',
          config: {
            baseUrl: 'https://user:password@example.com/v1?redirect=attacker',
            model: 'x',
            voice: 'x',
            format: 'mp3',
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_tts_request' }))
  })

  it('rejects invalid stored character identity before issuing a request', () => {
    const request: TtsSynthesisRequest = {
      operation: 'openai.synthesize',
      credential: { source: 'stored-character', characterId: 'other-character' },
      input: { text: 'hello' },
    }
    expect(() => resolveTtsUpstreamRequest(request, storedContext)).toThrow(
      expect.objectContaining({ code: 'tts_character_unavailable' }),
    )
  })
})

describe('TTS synthesis execution bounds', () => {
  const request: TtsSynthesisRequest = {
    operation: 'elevenlabs.synthesize',
    credential: { source: 'stored' },
    input: { text: 'hello', voiceId: 'voice' },
  }

  it('returns only bounded audio bytes and a normalized content type', async () => {
    await expect(
      executeTtsSynthesis(request, storedContext, {
        fetchImpl: (async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'audio/mpeg; charset=binary' },
          })) as typeof fetch,
      }),
    ).resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg' })
  })

  it('sanitizes upstream failures and rejects non-audio or oversized success bodies', async () => {
    await expect(
      executeTtsSynthesis(request, storedContext, {
        fetchImpl: (async () => new Response('secret diagnostic', { status: 401 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'tts_upstream_failed', statusCode: 502, upstreamStatus: 401 })

    await expect(
      executeTtsSynthesis(request, storedContext, {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ secret: true }), {
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'tts_upstream_invalid_response', statusCode: 502 })

    await expect(
      executeTtsSynthesis(request, storedContext, {
        fetchImpl: (async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } })) as typeof fetch,
        maxResponseBytes: 2,
      }),
    ).rejects.toMatchObject({ code: 'tts_upstream_invalid_response', statusCode: 502 })
  })

  it('retries a warming HuggingFace model within fixed attempt and wait bounds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ estimated_time: 0.01 }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8]), { headers: { 'content-type': 'audio/wav' } }))
    const sleepImpl = vi.fn(async () => {})

    await expect(
      executeTtsSynthesis(
        {
          operation: 'huggingface.synthesize',
          credential: { source: 'stored' },
          input: { text: 'hello', model: 'owner/model' },
        },
        storedContext,
        { fetchImpl: fetchImpl as typeof fetch, sleepImpl },
      ),
    ).resolves.toMatchObject({ contentType: 'audio/wav' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledWith(10, expect.any(AbortSignal))
  })

  it('aborts an upstream request at its fixed deadline', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        }),
    )
    await expect(
      executeTtsSynthesis(request, storedContext, { fetchImpl: fetchImpl as typeof fetch, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'tts_upstream_timeout', statusCode: 504 })
  })
})

describe('TTS request disconnect handling', () => {
  it('ignores a completed request close and aborts an unfinished response close', () => {
    const request = Object.assign(new EventEmitter(), { complete: true })
    const response = Object.assign(new EventEmitter(), { writableEnded: false })
    const disconnect = createTtsDisconnectAbort(request, response)

    request.emit('close')
    expect(disconnect.signal.aborted).toBe(false)
    response.emit('close')
    expect(disconnect.signal.aborted).toBe(true)
    disconnect.cleanup()
  })
})

interface Harness {
  app: FastifyInstance
  dataDir: string
}

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!
    await harness.app.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
  }
})

async function startHarness(fetchImpl: typeof fetch): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-tts-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      agentDevAuthBypass: true,
    },
    memoryWorker: false,
    assetGc: false,
    ttsSynthesis: { fetchImpl },
  })
  await app.ready()
  const harness = { app, dataDir }
  harnesses.push(harness)
  return harness
}

async function seedTtsDatabase(app: FastifyInstance): Promise<void> {
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    payload: {
      database: {
        openAIKey: 'server-global-openai-key',
        characters: [
          {
            type: 'character',
            chaId: 'char-openai',
            name: 'OpenAI voice',
            ttsMode: 'openai',
            oaiTTSConfig: {
              enabled: true,
              baseURL: 'https://persisted-tts.example/v1',
              apiKey: 'server-character-openai-key',
              model: 'tts-persisted',
              voice: 'voice-persisted',
              format: 'flac',
            },
            chats: [],
          },
        ],
      },
    },
  })
  expect(imported.statusCode, imported.body).toBe(200)
}

describe('POST /api/v1/tts/synthesize', () => {
  it('loads raw character credentials and their endpoint together without exposing either', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(new Uint8Array([9, 8, 7]), { headers: { 'content-type': 'audio/flac' } })),
    )
    const harness = await startHarness(fetchImpl as typeof fetch)
    await seedTtsDatabase(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/tts/synthesize',
      payload: {
        operation: 'openai.synthesize',
        credential: { source: 'stored-character', characterId: 'char-openai' },
        input: { text: 'hello' },
      },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-type']).toBe('audio/flac')
    expect(response.rawPayload).toEqual(Buffer.from([9, 8, 7]))
    expect(fetchImpl.mock.calls[0][0]).toBe('https://persisted-tts.example/v1/audio/speech')
    expect(header(fetchImpl.mock.calls[0][1] as RequestInit, 'authorization')).toBe(
      'Bearer server-character-openai-key',
    )
    expect(body(fetchImpl.mock.calls[0][1] as RequestInit)).toEqual({
      model: 'tts-persisted',
      input: 'hello',
      voice: 'voice-persisted',
      response_format: 'flac',
    })
    expect(response.body).not.toContain('server-character-openai-key')
    expect(response.body).not.toContain('persisted-tts.example')
  })

  it('rejects an endpoint override before a stored character credential reaches egress', async () => {
    const fetchImpl = vi.fn()
    const harness = await startHarness(fetchImpl as typeof fetch)
    await seedTtsDatabase(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/tts/synthesize',
      payload: {
        operation: 'openai.synthesize',
        credential: { source: 'stored-character', characterId: 'char-openai' },
        input: {
          text: 'hello',
          config: { baseUrl: 'https://attacker.example', model: 'x', voice: 'x', format: 'mp3' },
        },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_tts_request' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns only a sanitized error and upstream status', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret upstream diagnostic', { status: 403 }))
    const harness = await startHarness(fetchImpl as typeof fetch)
    await seedTtsDatabase(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/tts/synthesize',
      payload: {
        operation: 'openai.synthesize',
        credential: { source: 'stored-character', characterId: 'char-openai' },
        input: { text: 'hello' },
      },
    })

    expect(response.statusCode).toBe(502)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ error: 'tts_upstream_failed', upstreamStatus: 403 })
    expect(response.body).not.toContain('secret upstream diagnostic')
    expect(response.body).not.toContain('server-character-openai-key')
  })
})
