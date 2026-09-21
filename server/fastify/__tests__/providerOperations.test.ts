import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderOperationRequest } from '@risuai/protocol/provider-operation'
import { buildApp } from '../src/app.js'
import {
  executeProviderOperation,
  parseProviderOperationRequest,
  ProviderOperationError,
  resolveProviderUpstreamRequest,
} from '../src/providerOperations.js'
import { createProviderOperationDisconnectAbort } from '../src/routes/providerOperations.js'

const storedSettings = {
  nanogptKey: 'stored-nanogpt-key',
  openrouterKey: 'stored-openrouter-key',
  ollamaApiKey: 'stored-ollama-key',
  wavespeedImage: { key: 'stored-wavespeed-key' },
  google: { accessToken: 'stored-google-key' },
  claudeAPIKey: 'stored-anthropic-key',
  deeplOptions: { key: 'stored-deepl-key', freeApi: true },
  deeplXOptions: { token: 'stored-deeplx-token', url: 'http://127.0.0.1:1188/base/' },
  elevenLabKey: 'stored-elevenlabs-key',
  fishSpeechKey: 'stored-fish-key',
  providerCredentials: [
    { id: 'credential-openrouter', name: 'OpenRouter', type: 'apiKey', apiKey: 'profile-openrouter-key' },
    { id: 'credential-google', name: 'Google', type: 'apiKey', apiKey: 'profile-google-key' },
  ],
  modelProfiles: [
    {
      id: 'openrouter-profile',
      modelId: 'openrouter',
      providerOptions: { credentialId: 'credential-openrouter' },
    },
    {
      id: 'google-profile',
      providerId: 'google',
      modelId: 'gemini-2.5-pro',
      providerOptions: { credentialId: 'credential-google' },
    },
    {
      id: 'openrouter-global-fallback',
      modelId: 'openrouter',
      providerOptions: {},
    },
  ],
}

function request(
  operation: ProviderOperationRequest['operation'],
  input?: ProviderOperationRequest['input'],
): ProviderOperationRequest {
  return {
    operation,
    credential: { source: 'stored' },
    ...(input ? { input } : {}),
  }
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name)
}

const coreIt = (name: string, fn: () => void | Promise<void>): void => it(name, { tags: 'core' }, fn)

describe('provider operation allowlist', () => {
  it.each([
    {
      operation: 'nanogpt.balance' as const,
      url: 'https://nano-gpt.com/api/check-balance',
      method: 'POST',
      header: ['x-api-key', 'stored-nanogpt-key'],
    },
    {
      operation: 'nanogpt.subscription' as const,
      url: 'https://nano-gpt.com/api/subscription/v1/usage',
      method: 'GET',
      header: ['authorization', 'Bearer stored-nanogpt-key'],
    },
    {
      operation: 'nanogpt.model-providers' as const,
      input: { modelId: 'owner/model' },
      url: 'https://nano-gpt.com/api/models/owner%2Fmodel/providers',
      method: 'GET',
      header: ['authorization', 'Bearer stored-nanogpt-key'],
    },
    {
      operation: 'nanogpt.models' as const,
      url: 'https://nano-gpt.com/api/personalized/v1/models?detailed=true',
      method: 'GET',
      header: ['authorization', 'Bearer stored-nanogpt-key'],
    },
    {
      operation: 'nanogpt.subscription-models' as const,
      url: 'https://nano-gpt.com/api/subscription/v1/models?detailed=true',
      method: 'GET',
      header: ['authorization', 'Bearer stored-nanogpt-key'],
    },
    {
      operation: 'openrouter.models' as const,
      url: 'https://openrouter.ai/api/v1/models',
      method: 'GET',
      header: ['authorization', 'Bearer stored-openrouter-key'],
    },
    {
      operation: 'openrouter.providers' as const,
      url: 'https://openrouter.ai/api/v1/providers',
      method: 'GET',
      header: ['authorization', 'Bearer stored-openrouter-key'],
    },
    {
      operation: 'llmgateway.models' as const,
      url: 'https://api.llmgateway.io/v1/models',
      method: 'GET',
    },
    {
      operation: 'neuralwatt.models' as const,
      url: 'https://api.neuralwatt.com/v1/models',
      method: 'GET',
    },
    {
      operation: 'ollama.cloud-models' as const,
      url: 'https://ollama.com/api/tags',
      method: 'GET',
      header: ['authorization', 'Bearer stored-ollama-key'],
    },
    {
      operation: 'wavespeed.models' as const,
      url: 'https://api.wavespeed.ai/api/v3/models',
      method: 'GET',
      header: ['authorization', 'Bearer stored-wavespeed-key'],
    },
    {
      operation: 'google.models' as const,
      url: 'https://generativelanguage.googleapis.com/v1beta/models?key=stored-google-key',
      method: 'GET',
    },
    {
      operation: 'google.count-tokens' as const,
      input: { modelId: 'models/gemini-2.5-pro', text: 'hello world' },
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens?key=stored-google-key',
      method: 'POST',
    },
    {
      operation: 'anthropic.models' as const,
      url: 'https://api.anthropic.com/v1/models',
      method: 'GET',
      header: ['x-api-key', 'stored-anthropic-key'],
    },
    {
      operation: 'deepl.translate' as const,
      input: { text: 'hello', sourceLanguage: 'en', targetLanguage: 'ko' },
      url: 'https://api-free.deepl.com/v2/translate',
      method: 'POST',
      header: ['authorization', 'DeepL-Auth-Key stored-deepl-key'],
    },
    {
      operation: 'deeplx.translate' as const,
      input: { text: 'hello', sourceLanguage: 'en', targetLanguage: 'ko' },
      url: 'http://127.0.0.1:1188/base/translate',
      method: 'POST',
      header: ['authorization', 'Bearer stored-deeplx-token'],
    },
    {
      operation: 'elevenlabs.voices' as const,
      url: 'https://api.elevenlabs.io/v1/voices',
      method: 'GET',
      header: ['xi-api-key', 'stored-elevenlabs-key'],
    },
    {
      operation: 'fish.models' as const,
      url: 'https://api.fish.audio/model?self=true',
      method: 'GET',
      header: ['authorization', 'Bearer stored-fish-key'],
    },
  ])('maps $operation to its fixed upstream request', ({ operation, input, url, method, header: expected }) => {
    const upstream = resolveProviderUpstreamRequest(request(operation, input), storedSettings)

    expect(upstream.url).toBe(url)
    expect(upstream.init.method).toBe(method)
    expect(upstream.init.redirect).toBe('error')
    expect(header(upstream.init, 'accept')).toBe('application/json')
    if (expected) expect(header(upstream.init, expected[0])).toBe(expected[1])
    if (operation === 'anthropic.models') {
      expect(header(upstream.init, 'anthropic-version')).toBe('2023-06-01')
    }
    if (operation === 'google.count-tokens') {
      expect(JSON.parse(String(upstream.init.body))).toEqual({
        contents: [{ parts: [{ text: 'hello world' }] }],
      })
    }
    if (operation === 'deepl.translate') {
      expect(JSON.parse(String(upstream.init.body))).toEqual({ text: ['hello'], target_lang: 'KO' })
    }
    if (operation === 'deeplx.translate') {
      expect(JSON.parse(String(upstream.init.body))).toEqual({
        text: 'hello',
        source_lang: 'EN',
        target_lang: 'KO',
      })
    }
  })

  it('uses the public NanoGPT catalog and omits optional authorization when no key is selected', () => {
    const nano = resolveProviderUpstreamRequest(
      { operation: 'nanogpt.models', credential: { source: 'none' } },
      storedSettings,
    )
    const openrouter = resolveProviderUpstreamRequest(
      { operation: 'openrouter.models', credential: { source: 'none' } },
      storedSettings,
    )

    expect(nano.url).toBe('https://nano-gpt.com/api/v1/models?detailed=true')
    expect(header(nano.init, 'authorization')).toBeNull()
    expect(header(openrouter.init, 'authorization')).toBeNull()

    const llmGateway = resolveProviderUpstreamRequest(
      { operation: 'llmgateway.models', credential: { source: 'none' } },
      storedSettings,
    )
    expect(llmGateway.url).toBe('https://api.llmgateway.io/v1/models')
    expect(header(llmGateway.init, 'authorization')).toBeNull()

    const neuralwatt = resolveProviderUpstreamRequest(
      { operation: 'neuralwatt.models', credential: { source: 'none' } },
      storedSettings,
    )
    expect(neuralwatt.url).toBe('https://api.neuralwatt.com/v1/models')
    expect(header(neuralwatt.init, 'authorization')).toBeNull()
  })

  coreIt('resolves only matching model-profile secrets and preserves the same-provider flat fallback', () => {
    const profile = resolveProviderUpstreamRequest(
      {
        operation: 'openrouter.models',
        credential: { source: 'model-profile', profileId: 'openrouter-profile' },
      },
      storedSettings,
    )
    const fallback = resolveProviderUpstreamRequest(
      {
        operation: 'openrouter.models',
        credential: { source: 'model-profile', profileId: 'openrouter-global-fallback' },
      },
      storedSettings,
    )

    expect(header(profile.init, 'authorization')).toBe('Bearer profile-openrouter-key')
    expect(header(fallback.init, 'authorization')).toBe('Bearer stored-openrouter-key')
    expect(() =>
      resolveProviderUpstreamRequest(
        {
          operation: 'anthropic.models',
          credential: { source: 'model-profile', profileId: 'google-profile' },
        },
        storedSettings,
      ),
    ).toThrow(expect.objectContaining({ code: 'provider_credential_unavailable' }))
  })

  it('rejects arbitrary proxy fields and a masked sentinel supplied as a draft key', () => {
    expect(() =>
      parseProviderOperationRequest({
        operation: 'openrouter.models',
        credential: { source: 'stored' },
        url: 'https://attacker.example',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_provider_operation_request' }))

    expect(() =>
      parseProviderOperationRequest({
        operation: 'openrouter.models',
        credential: { source: 'provided', apiKey: '__RISU_SECRET_MASKED__' },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_provider_operation_request' }))
  })

  it('strictly validates Google token count inputs', () => {
    expect(() =>
      parseProviderOperationRequest({
        operation: 'google.count-tokens',
        credential: { source: 'stored' },
        input: { modelId: 'gemini-2.5-pro', text: 'hello', url: 'https://attacker.example' },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_provider_operation_request' }))

    expect(() =>
      parseProviderOperationRequest({
        operation: 'google.count-tokens',
        credential: { source: 'stored' },
        input: { modelId: 'gemini-2.5-pro', text: 'x'.repeat(512 * 1024 + 1) },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_provider_operation_request' }))
  })

  it('keeps DeepLX targets server-owned and strictly validates translation inputs', () => {
    const withoutToken = resolveProviderUpstreamRequest(
      {
        operation: 'deeplx.translate',
        credential: { source: 'none' },
        input: { text: 'hello', sourceLanguage: 'en', targetLanguage: 'ko' },
      },
      storedSettings,
    )
    expect(withoutToken.url).toBe('http://127.0.0.1:1188/base/translate')
    expect(header(withoutToken.init, 'authorization')).toBeNull()

    expect(() =>
      parseProviderOperationRequest({
        operation: 'deeplx.translate',
        credential: { source: 'stored' },
        input: {
          text: 'hello',
          sourceLanguage: 'en',
          targetLanguage: 'ko',
          url: 'https://attacker.example',
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_provider_operation_request' }))

    expect(() =>
      resolveProviderUpstreamRequest(
        {
          operation: 'deeplx.translate',
          credential: { source: 'none' },
          input: { text: 'hello', sourceLanguage: 'en', targetLanguage: 'ko' },
        },
        { deeplXOptions: { url: 'file:///etc/passwd' } },
      ),
    ).toThrow(expect.objectContaining({ code: 'provider_credential_unavailable' }))
  })

  it('requires account credentials before issuing an upstream request', () => {
    expect(() =>
      resolveProviderUpstreamRequest({ operation: 'nanogpt.balance', credential: { source: 'none' } }, storedSettings),
    ).toThrow(expect.objectContaining({ code: 'provider_credential_unavailable' }))
  })
})

describe('provider operation execution bounds', () => {
  it('returns parsed JSON without exposing request credentials in its result', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }] })))

    await expect(
      executeProviderOperation({ operation: 'openrouter.models', credential: { source: 'stored' } }, storedSettings, {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({ data: [{ id: 'model-a' }] })
  })

  it('sanitizes upstream errors and rejects oversized responses', async () => {
    await expect(
      executeProviderOperation({ operation: 'openrouter.models', credential: { source: 'stored' } }, storedSettings, {
        fetchImpl: (async () =>
          new Response('provider body containing stored-openrouter-key', { status: 401 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'provider_operation_failed', statusCode: 502, upstreamStatus: 401 })

    await expect(
      executeProviderOperation({ operation: 'openrouter.models', credential: { source: 'stored' } }, storedSettings, {
        fetchImpl: (async () => new Response(JSON.stringify({ tooLarge: true }))) as typeof fetch,
        maxResponseBytes: 5,
      }),
    ).rejects.toMatchObject({ code: 'provider_operation_invalid_response', statusCode: 502 })
  })

  it('aborts a provider operation at its fixed deadline', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        }),
    )

    await expect(
      executeProviderOperation({ operation: 'openrouter.models', credential: { source: 'stored' } }, storedSettings, {
        fetchImpl: fetchImpl as typeof fetch,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'provider_operation_timeout', statusCode: 504 })
  })
})

describe('provider operation disconnect handling', () => {
  it('ignores a normal request close and aborts an unfinished response close', () => {
    const request = Object.assign(new EventEmitter(), { complete: true })
    const response = Object.assign(new EventEmitter(), { writableEnded: false })
    const disconnect = createProviderOperationDisconnectAbort(request, response)

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
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-provider-operations-'))
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
    providerOperations: { fetchImpl },
  })
  await app.ready()
  const harness = { app, dataDir }
  harnesses.push(harness)
  return harness
}

async function seedOpenRouterKey(app: FastifyInstance, openrouterKey: string): Promise<void> {
  const initialized = await app.inject({
    method: 'POST',
    url: '/api/v1/commands/state/initialize',
    payload: {},
  })
  expect(initialized.statusCode, initialized.body).toBe(200)
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/v1/commands/settings/providers',
    payload: {
      baseRevision: initialized.json().revision,
      patch: { openrouterKey },
    },
  })
  expect(patched.statusCode, patched.body).toBe(200)
}

describe('POST /api/v1/provider-operations', () => {
  it('uses the raw SQLite secret while keeping it out of the client response', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }))),
    )
    const harness = await startHarness(fetchImpl as typeof fetch)
    await seedOpenRouterKey(harness.app, 'server-only-openrouter-key')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/provider-operations',
      payload: {
        operation: 'openrouter.models',
        credential: { source: 'stored' },
      },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ operation: 'openrouter.models', data: { data: [] } })
    expect(response.body).not.toContain('server-only-openrouter-key')
    expect(header(fetchImpl.mock.calls[0][1] as RequestInit, 'authorization')).toBe('Bearer server-only-openrouter-key')
    expect((fetchImpl.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false)
  })

  it('uses a one-shot draft override without replacing the stored credential', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }))),
    )
    const harness = await startHarness(fetchImpl as typeof fetch)
    await seedOpenRouterKey(harness.app, 'server-only-openrouter-key')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/provider-operations',
      payload: {
        operation: 'openrouter.models',
        credential: { source: 'provided', apiKey: 'draft-openrouter-key' },
      },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(header(fetchImpl.mock.calls[0][1] as RequestInit, 'authorization')).toBe('Bearer draft-openrouter-key')

    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/provider-operations',
      payload: {
        operation: 'openrouter.models',
        credential: { source: 'stored' },
      },
    })
    expect(header(fetchImpl.mock.calls[1][1] as RequestInit, 'authorization')).toBe('Bearer server-only-openrouter-key')
  })

  it('returns only a sanitized upstream status on provider failure', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('secret upstream diagnostic', { status: 403, statusText: 'Forbidden' }),
    )
    const harness = await startHarness(fetchImpl as typeof fetch)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/provider-operations',
      payload: {
        operation: 'openrouter.models',
        credential: { source: 'provided', apiKey: 'draft-openrouter-key' },
      },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'provider_operation_failed', upstreamStatus: 403 })
    expect(response.body).not.toContain('secret upstream diagnostic')
    expect(response.body).not.toContain('draft-openrouter-key')
  })
})
