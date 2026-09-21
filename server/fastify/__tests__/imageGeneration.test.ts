import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import * as fflate from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageGenerationRequest } from '@risuai/protocol/image-generation-operation'
import { buildApp } from '../src/app.js'
import { executeImageGeneration, parseImageGenerationRequest } from '../src/imageGeneration.js'
import { createImageGenerationDisconnectAbort } from '../src/routes/imageGeneration.js'

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngBytes(extra = 'image'): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.from(extra)])
}

function pngJson(extra = 'image'): string {
  return JSON.stringify({ data: [{ b64_json: pngBytes(extra).toString('base64') }] })
}

function responseBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit
}

function authHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization')
}

function dalleRequest(credential: ImageGenerationRequest['credential'] = { source: 'stored' }): ImageGenerationRequest {
  return { provider: 'dalle', credential, prompt: 'a lantern-lit library', quality: 'hd' }
}

describe('image generation request validation', () => {
  it('accepts closed provider inputs and rejects caller-selected fields', () => {
    expect(parseImageGenerationRequest(dalleRequest())).toEqual(dalleRequest())
    expect(() => parseImageGenerationRequest({ ...dalleRequest(), url: 'https://attacker.test' })).toThrow(
      'invalid_image_generation_request',
    )
    expect(() =>
      parseImageGenerationRequest({
        provider: 'wavespeed',
        credential: { source: 'provided', apiKey: 'key' },
        prompt: 'test',
        model: '../predictions/secret',
      }),
    ).toThrow('invalid_image_generation_request')
  })

  it('bounds NovelAI samples, dimensions, and reference bytes', () => {
    const payload = {
      input: 'prompt',
      model: 'nai-diffusion-4-5-full',
      action: 'generate',
      parameters: {
        n_samples: 1,
        width: 1024,
        height: 1024,
        steps: 28,
        scale: 5,
        negative_prompt: '',
        sampler: 'k_euler_ancestral',
        noise_schedule: 'karras',
        seed: 1,
        extra_noise_seed: 2,
        reference_image_multiple: ['opaque-vibe-encoding'],
      },
    }
    expect(
      parseImageGenerationRequest({ provider: 'novelai', credential: { source: 'stored' }, payload }),
    ).toMatchObject({ provider: 'novelai' })
    expect(() =>
      parseImageGenerationRequest({
        provider: 'novelai',
        credential: { source: 'stored' },
        payload: { ...payload, parameters: { ...payload.parameters, n_samples: 2 } },
      }),
    ).toThrow('invalid_image_generation_request')
    expect(() =>
      parseImageGenerationRequest({
        provider: 'novelai',
        credential: { source: 'stored' },
        payload: { ...payload, parameters: { ...payload.parameters, width: 2050 } },
      }),
    ).toThrow('invalid_image_generation_request')
  })

  it('never accepts the browser mask as a provided credential', () => {
    expect(() =>
      parseImageGenerationRequest(dalleRequest({ source: 'provided', apiKey: '__RISU_SECRET_MASKED__' })),
    ).toThrow('invalid_image_generation_request')
  })
})

describe('image generation provider execution', () => {
  it('uses the stored DALL-E credential only on the fixed OpenAI target', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(pngJson(), { headers: { 'content-type': 'application/json' } })),
    )
    const result = await executeImageGeneration(dalleRequest(), { openAIKey: 'server-only-key' }, { fetchImpl })

    expect(result.contentType).toBe('image/png')
    expect(result.bytes).toEqual(pngBytes())
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/generations')
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(init.redirect).toBe('error')
    expect(authHeader(init)).toBe('Bearer server-only-key')
    expect(JSON.parse(String(init.body))).toMatchObject({ quality: 'hd', response_format: 'b64_json' })
  })

  it('uses only the persisted compatible endpoint while allowing a one-shot raw key', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(pngJson())),
    )
    await executeImageGeneration(
      { provider: 'openai-compat', credential: { source: 'provided', apiKey: 'draft-key' }, prompt: 'prompt' },
      {
        openaiCompatImage: {
          url: 'https://images.example.test/v1/images/generations',
          key: 'stored-key',
          model: 'image-model',
          size: '512x512',
          quality: 'medium',
        },
      },
      { fetchImpl },
    )

    expect(fetchImpl.mock.calls[0][0]).toBe('https://images.example.test/v1/images/generations')
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(init.redirect).toBe('error')
    expect(authHeader(init)).toBe('Bearer draft-key')
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: 'prompt',
      response_format: 'b64_json',
      size: '512x512',
      quality: 'medium',
      model: 'image-model',
    })
  })

  it('builds bounded Stability multipart requests with the raw stored key', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(responseBody(pngBytes()), { headers: { 'content-type': 'image/png' } })),
    )
    const result = await executeImageGeneration(
      {
        provider: 'stability',
        credential: { source: 'stored' },
        prompt: 'prompt',
        negativePrompt: '',
        model: 'core',
        style: 'anime',
      },
      { stabilityKey: 'stored-stability-key' },
      { fetchImpl },
    )

    expect(result.contentType).toBe('image/png')
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.stability.ai/v2beta/stable-image/generate/core')
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(authHeader(init)).toBe('Bearer stored-stability-key')
    expect(init.redirect).toBe('error')
    expect((init.body as FormData).get('prompt')).toBe('prompt')
    expect((init.body as FormData).get('style_preset')).toBe('anime')
  })

  it('downloads Fal output only from its fixed media host without forwarding the key', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ images: [{ url: 'https://v3.fal.media/files/result.webp' }] })),
      )
      .mockResolvedValueOnce(
        new Response(
          responseBody(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('x')])),
          { headers: { 'content-type': 'image/webp' } },
        ),
      )
    const result = await executeImageGeneration(
      {
        provider: 'fal',
        credential: { source: 'stored' },
        prompt: 'prompt',
        model: 'fal-ai/flux/dev',
        width: 1024,
        height: 1024,
      },
      { falToken: 'stored-fal-key' },
      { fetchImpl: fetchImpl as typeof fetch },
    )

    expect(result.contentType).toBe('image/webp')
    expect(fetchImpl.mock.calls[0][0]).toBe('https://fal.run/fal-ai/flux/dev')
    expect(authHeader(fetchImpl.mock.calls[0][1])).toBe('Key stored-fal-key')
    expect(fetchImpl.mock.calls[1][0]).toBe('https://v3.fal.media/files/result.webp')
    expect(authHeader(fetchImpl.mock.calls[1][1])).toBeNull()
  })

  it('uses the raw stored Google key for a fixed allowlisted Imagen model', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            predictions: [{ bytesBase64Encoded: pngBytes('imagen').toString('base64'), mimeType: 'image/png' }],
          }),
        ),
      ),
    )
    const result = await executeImageGeneration(
      {
        provider: 'imagen',
        credential: { source: 'stored' },
        prompt: 'prompt',
        model: 'imagen-4.0-generate-001',
        imageSize: '2K',
        aspectRatio: '16:9',
        personGeneration: 'allow_adult',
      },
      { google: { accessToken: 'stored-google-key' } },
      { fetchImpl },
    )

    expect(result.bytes).toEqual(pngBytes('imagen'))
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=stored-google-key',
    )
    expect(JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))).toEqual({
      instances: [{ prompt: 'prompt' }],
      parameters: {
        sampleCount: 1,
        aspectRatio: '16:9',
        personGeneration: 'allow_adult',
        sampleImageSize: '2K',
      },
    })
  })

  it('fails closed when a required stored credential is unavailable', async () => {
    await expect(executeImageGeneration(dalleRequest(), {}, { fetchImpl: vi.fn() })).rejects.toMatchObject({
      code: 'image_generation_credential_unavailable',
      statusCode: 422,
    })
  })

  it('reports malformed or oversized provider image payloads as sanitized upstream failures', async () => {
    const malformedFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ data: [{ b64_json: 'not-base64!' }] }))),
    )
    await expect(
      executeImageGeneration(dalleRequest(), { openAIKey: 'stored-key' }, { fetchImpl: malformedFetch }),
    ).rejects.toMatchObject({ code: 'image_generation_invalid_response', statusCode: 502 })

    const oversizedFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(pngJson('larger-than-test-limit'))),
    )
    await expect(
      executeImageGeneration(
        dalleRequest(),
        { openAIKey: 'stored-key' },
        { fetchImpl: oversizedFetch, maxImageBytes: 8 },
      ),
    ).rejects.toMatchObject({ code: 'image_generation_invalid_response', statusCode: 502 })
  })

  it('keeps the legacy Kei account token server-side on its configured Hub target', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: true, data: `data:image/png;base64,${pngBytes('kei').toString('base64')}` }),
        ),
      ),
    )
    const result = await executeImageGeneration(
      { provider: 'kei', credential: { source: 'stored' }, prompt: 'prompt' },
      { account: { token: 'stored-account-token' }, keiServerURL: '' },
      { fetchImpl, keiHubUrl: 'https://hub.example.test' },
    )

    expect(result.bytes).toEqual(pngBytes('kei'))
    expect(fetchImpl.mock.calls[0][0]).toBe('https://hub.example.test/kei/imaggen')
    expect(new Headers((fetchImpl.mock.calls[0][1] as RequestInit).headers).get('x-api-key')).toBe(
      'stored-account-token',
    )
  })

  it('polls WaveSpeed within a fixed budget and never forwards the key to its result CDN', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'prediction-1' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'processing' } })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { status: 'completed', outputs: ['https://cdn.wavespeed.ai/results/image.png'] },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(responseBody(pngBytes()), { headers: { 'content-type': 'image/png' } }))
    const sleepImpl = vi.fn(async () => undefined)

    await executeImageGeneration(
      {
        provider: 'wavespeed',
        credential: { source: 'stored' },
        prompt: 'prompt',
        model: 'wavespeed-ai/flux-dev',
      },
      { wavespeedImage: { key: 'stored-wavespeed-key' } },
      { fetchImpl: fetchImpl as typeof fetch, sleepImpl },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.wavespeed.ai/api/v3/wavespeed-ai/flux-dev')
    expect(authHeader(fetchImpl.mock.calls[1][1])).toBe('Bearer stored-wavespeed-key')
    expect(fetchImpl.mock.calls[3][0]).toBe('https://cdn.wavespeed.ai/results/image.png')
    expect(authHeader(fetchImpl.mock.calls[3][1])).toBeNull()
    expect(sleepImpl).toHaveBeenCalledOnce()
  })

  it('rejects provider-controlled output egress outside the allowlist', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'prediction-1' } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { status: 'completed', outputs: ['https://127.0.0.1/internal'] } })),
      )
    await expect(
      executeImageGeneration(
        {
          provider: 'wavespeed',
          credential: { source: 'stored' },
          prompt: 'prompt',
          model: 'wavespeed-ai/flux-dev',
        },
        { wavespeedImage: { key: 'stored-wavespeed-key' } },
        { fetchImpl: fetchImpl as typeof fetch, sleepImpl: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'image_generation_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('extracts only a bounded image from NovelAI archives', async () => {
    const archive = fflate.zipSync({
      'metadata.json': Buffer.from('{}'),
      'image.png': pngBytes('novel'),
    })
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(responseBody(archive))),
    )
    const request = parseImageGenerationRequest({
      provider: 'novelai',
      credential: { source: 'stored' },
      payload: {
        input: 'prompt',
        model: 'nai-diffusion-4-5-full',
        action: 'generate',
        parameters: {
          n_samples: 1,
          width: 1024,
          height: 1024,
          steps: 28,
          scale: 5,
          negative_prompt: 'negative',
          sampler: 'k_euler_ancestral',
          noise_schedule: 'karras',
          seed: 1,
          extra_noise_seed: 2,
        },
      },
    })
    const result = await executeImageGeneration(
      request,
      { NAIApiKey: 'stored-nai-key', NAIImgUrl: 'https://image.novelai.net/ai/generate-image' },
      { fetchImpl },
    )
    expect(result.bytes).toEqual(pngBytes('novel'))
    expect(authHeader(fetchImpl.mock.calls[0][1])).toBe('Bearer stored-nai-key')
  })

  it('never sends the stored NovelAI credential to a configured custom endpoint', async () => {
    const fetchImpl = vi.fn()
    const request = parseImageGenerationRequest({
      provider: 'novelai',
      credential: { source: 'stored' },
      payload: {
        input: 'prompt',
        model: 'nai-diffusion-4-5-full',
        action: 'generate',
        parameters: {
          n_samples: 1,
          width: 1024,
          height: 1024,
          steps: 28,
          scale: 5,
          negative_prompt: '',
          sampler: 'k_euler_ancestral',
          noise_schedule: 'karras',
          seed: 1,
          extra_noise_seed: 2,
        },
      },
    })

    await expect(
      executeImageGeneration(
        request,
        { NAIApiKey: 'stored-nai-key', NAIImgUrl: 'http://127.0.0.1/private-generation' },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'image_generation_configuration_invalid' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses only an explicit draft credential for a configured custom NovelAI endpoint', async () => {
    const archive = fflate.zipSync({ 'image.png': pngBytes('custom-novel') })
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(responseBody(archive))),
    )
    const request = parseImageGenerationRequest({
      provider: 'novelai',
      credential: { source: 'provided', apiKey: 'draft-nai-key' },
      payload: {
        input: 'prompt',
        model: 'nai-diffusion-4-5-full',
        action: 'generate',
        parameters: {
          n_samples: 1,
          width: 1024,
          height: 1024,
          steps: 28,
          scale: 5,
          negative_prompt: '',
          sampler: 'k_euler_ancestral',
          noise_schedule: 'karras',
          seed: 1,
          extra_noise_seed: 2,
        },
      },
    })

    const result = await executeImageGeneration(
      request,
      { NAIApiKey: 'stored-must-not-leak', NAIImgUrl: 'https://custom.example.test/generate' },
      { fetchImpl },
    )

    expect(result.bytes).toEqual(pngBytes('custom-novel'))
    expect(fetchImpl.mock.calls[0][0]).toBe('https://custom.example.test/generate')
    expect(authHeader(fetchImpl.mock.calls[0][1])).toBe('Bearer draft-nai-key')
  })

  it('stops WaveSpeed polling at the configured attempt limit', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'prediction-1' } })))
      .mockImplementation(async () => new Response(JSON.stringify({ data: { status: 'processing' } })))
    await expect(
      executeImageGeneration(
        {
          provider: 'wavespeed',
          credential: { source: 'stored' },
          prompt: 'prompt',
          model: 'wavespeed-ai/flux-dev',
        },
        { wavespeedImage: { key: 'stored-key' } },
        {
          fetchImpl: fetchImpl as typeof fetch,
          maxWaveSpeedPollAttempts: 2,
          sleepImpl: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'image_generation_timeout' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
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
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-image-generation-'))
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
    imageGeneration: { fetchImpl },
  })
  await app.ready()
  const harness = { app, dataDir }
  harnesses.push(harness)
  return harness
}

async function seedOpenAiKey(app: FastifyInstance, openAIKey: string): Promise<void> {
  const initialized = await app.inject({ method: 'POST', url: '/api/v1/commands/state/initialize', payload: {} })
  expect(initialized.statusCode, initialized.body).toBe(200)
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/v1/commands/settings/providers',
    payload: { baseRevision: initialized.json().revision, patch: { openAIKey } },
  })
  expect(patched.statusCode, patched.body).toBe(200)
}

describe('POST /api/v1/image-generation', () => {
  it('returns bounded binary image bytes without exposing the raw SQLite key', { tags: 'core' }, async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(pngJson())),
    )
    const harness = await startHarness(fetchImpl as typeof fetch)
    await seedOpenAiKey(harness.app, 'server-only-openai-key')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/image-generation',
      payload: dalleRequest(),
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-type']).toContain('image/png')
    expect(response.rawPayload).toEqual(pngBytes())
    expect(response.body).not.toContain('server-only-openai-key')
    expect(authHeader(fetchImpl.mock.calls[0][1])).toBe('Bearer server-only-openai-key')
  })

  it('sanitizes upstream errors and never echoes credentials or provider bodies', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response('secret provider diagnostic', { status: 403 })),
    )
    const harness = await startHarness(fetchImpl as typeof fetch)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/image-generation',
      payload: dalleRequest({ source: 'provided', apiKey: 'one-shot-secret' }),
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'image_generation_failed', upstreamStatus: 403 })
    expect(response.body).not.toContain('secret provider diagnostic')
    expect(response.body).not.toContain('one-shot-secret')
  })
})

describe('image generation disconnect abort', () => {
  it('aborts unfinished requests and removes listeners on cleanup', () => {
    const request = Object.assign(new EventEmitter(), { complete: false })
    const response = Object.assign(new EventEmitter(), { writableEnded: false })
    const disconnect = createImageGenerationDisconnectAbort(request, response)
    request.emit('close')
    expect(disconnect.signal.aborted).toBe(true)
    disconnect.cleanup()
    expect(request.listenerCount('close')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
  })
})
