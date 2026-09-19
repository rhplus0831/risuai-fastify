import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LLMFlags,
  LLMFormat,
  LLMProvider,
  LLMTokenizer,
  OpenAIParameters,
  type LLMModel,
} from '@risuai/shared-core/model-types'
import {
  resolveModelProfile,
  resolveModelProfileWithLegacyCompatibility,
  type ResolvedModelProfile,
} from '@risuai/shared-core/model-profile-resolver'
import type { PromptMessage } from '../src/prompt/promptMessage.js'
import type { FastifyDatabase as Database } from '../src/prompt/serverTypes.js'
import { MASKED_PROVIDER_SECRET } from '@risuai/shared-core/provider-secret-mask'
import { _resetVertexTokenCacheForTesting } from '../src/generation/vertexAuth.js'
import { dispatchChatProvider, getServerGenerationModelString } from '../src/prompt/chatDispatch.js'
import type { PromptRowSummary } from '../src/prompt/promptSummary.js'

interface CapturedDispatchRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  rawBody: string
}

interface ProtocolMetric {
  metric: string
  provider?: string
  modelId?: string
  wireModel?: string
  profileId?: string
  profileSourceKind?: string
  profileProviderId?: string
  modelInfoFormat?: number
  modelInfoFlags?: number[]
  prePromptHash?: string
  prePromptRowCount?: number
  prePromptRoleSequence?: string
  prePromptRows?: PromptRowSummary[]
  postPromptHash?: string
  postPromptRowCount?: number
  postPromptRoleSequence?: string
  postPromptRows?: PromptRowSummary[]
  promptReformatted?: boolean
  promptRowCountChanged?: boolean
  promptRoleSequenceChanged?: boolean
  promptReferenceChanged?: boolean
}

function db(overrides: Partial<Database> = {}): Database {
  const database = {
    aiModel: 'gpt-5',
    subModel: 'gpt-5-mini',
    modelRoles: {},
    fallbackModels: {},
    customModels: [],
    modelTools: [],
    OaiCompAPIKeys: {},
    maxResponse: 64,
    temperature: 50,
    useStreaming: false,
    ...overrides,
  } as unknown as Database

  if (overrides.modelProfiles === undefined && overrides.modelRoleProfiles === undefined) {
    const raw = database as unknown as Record<string, unknown>
    const modelId = typeof raw.aiModel === 'string' ? raw.aiModel : 'gpt-5'
    const bedrockPrefix = modelId.startsWith('anthropic.')
      ? Number(modelId.match(/(\d{8})/)?.[1] ?? 0) >= 20250929
        ? 'global'
        : 'us'
      : undefined
    const key =
      modelId === 'reverse_proxy'
        ? raw.proxyKey
        : modelId === 'openrouter'
          ? raw.openrouterKey
          : modelId === 'nanogpt'
            ? raw.nanogptKey
            : modelId.includes('ollama')
              ? raw.ollamaApiKey
              : modelId.startsWith('claude-') || modelId.startsWith('anthropic.')
                ? raw.claudeAPIKey
                : modelId.startsWith('gemini-')
                  ? (raw.google as { accessToken?: unknown } | undefined)?.accessToken
                  : modelId.startsWith('deepseek-')
                    ? (raw.OaiCompAPIKeys as Record<string, unknown> | undefined)?.deepseek
                    : modelId.startsWith('mistral')
                      ? raw.mistralKey
                      : modelId.startsWith('cohere-')
                        ? raw.cohereAPIKey
                        : modelId.startsWith('horde:::')
                          ? (raw.hordeConfig as { apiKey?: unknown } | undefined)?.apiKey
                          : modelId === 'mancer'
                            ? raw.mancerHeader
                            : raw.openAIKey
    const profileProviderOptions: Record<string, unknown> = {
      ...(modelId.startsWith('xcustom:::') || modelId.startsWith('horde:::')
        ? {}
        : {
            requestModel:
              modelId === 'reverse_proxy'
                ? raw.customProxyRequestModel
                : modelId === 'openrouter'
                  ? raw.openrouterRequestModel
                  : modelId === 'nanogpt'
                    ? raw.nanogptRequestModel
                    : modelId === 'ollama-cloud'
                      ? raw.ollamaCloudModel
                      : modelId.includes('ollama')
                        ? raw.ollamaModel
                        : modelId.startsWith('anthropic.')
                          ? `${bedrockPrefix}.${modelId}`
                          : modelId.startsWith('gemini-')
                            ? undefined
                            : modelId,
          }),
    }
    if (modelId === 'reverse_proxy') {
      profileProviderOptions.baseUrl = raw.forceReplaceUrl
      profileProviderOptions.additionalParams = raw.additionalParams
      profileProviderOptions.reverseProxy = {
        autofillRequestUrl: raw.autofillRequestUrl,
        oobaSystemHoist: raw.reverseProxyOobaMode,
        oobaArgs: raw.reverseProxyOobaArgs,
      }
    } else if (modelId === 'openrouter') {
      profileProviderOptions.openrouter = {
        fallback: raw.openrouterFallback,
        middleOut: raw.openrouterMiddleOut,
        provider: raw.openrouterProvider,
      }
    } else if (modelId === 'nanogpt') {
      profileProviderOptions.nanogpt = {
        providerHint: raw.nanogptProvider,
        useSubscriptionEndpoint: raw.nanogptUseSubscriptionEndpoint,
        subscriptionState: raw.nanogptSubscriptionState,
      }
    } else if (modelId === 'ollama-cloud') {
      profileProviderOptions.ollama = {
        requestFormat: raw.ollamaRequestFormat,
        modelSource: raw.ollamaModelSource,
        thinkingMode: raw.ollamaThinkingMode,
      }
    } else if (modelId.includes('ollama')) {
      profileProviderOptions.baseUrl = raw.ollamaURL
      profileProviderOptions.ollama = {
        url: raw.ollamaURL,
        requestFormat: raw.ollamaRequestFormat,
        modelSource: raw.ollamaModelSource,
        thinkingMode: raw.ollamaThinkingMode,
      }
    } else if (modelId === 'kobold') {
      profileProviderOptions.baseUrl = raw.koboldURL
    } else if (modelId === 'mancer') {
      profileProviderOptions.baseUrl = raw.textgenWebUIBlockingURL
    }

    const runtimeOptions: Record<string, unknown> = {}
    const runtimeFields: Record<string, string> = {
      maxContext: 'maxContext',
      maxResponse: 'maxResponse',
      temperature: 'temperature',
      top_p: 'topP',
      top_k: 'topK',
      min_p: 'minP',
      top_a: 'topA',
      repetition_penalty: 'repetitionPenalty',
      frequencyPenalty: 'frequencyPenalty',
      PresensePenalty: 'presencePenalty',
      reasoningEffort: 'reasoningEffort',
      thinkingTokens: 'thinkingTokens',
      thinkingType: 'thinkingType',
      deepseekThinkingType: 'deepseekThinkingType',
      adaptiveThinkingEffort: 'adaptiveThinkingEffort',
      deepseekReasoningEffort: 'deepseekReasoningEffort',
      verbosity: 'verbosity',
      halfStreaming: 'halfStreaming',
      useStreaming: 'useStreaming',
      genTime: 'genTime',
      extractJson: 'extractJson',
      jsonSchemaEnabled: 'jsonSchemaEnabled',
      jsonSchema: 'jsonSchema',
      strictJsonSchema: 'strictJsonSchema',
      outputImageModal: 'outputImageModal',
      stripCoT: 'stripCoT',
      dynamicOutput: 'dynamicOutput',
      modelTools: 'modelTools',
      enableCustomFlags: 'enableCustomFlags',
      customFlags: 'customFlags',
      customTokenizer: 'customTokenizer',
    }
    for (const [databaseField, profileField] of Object.entries(runtimeFields)) {
      const value = raw[databaseField]
      if (value !== undefined) runtimeOptions[profileField] = value
    }
    const profileId = 'fixture-default-profile'
    const providerCredentials = Array.isArray(raw.providerCredentials) ? [...raw.providerCredentials] : []
    if (typeof key === 'string' && key.length > 0) {
      providerCredentials.push({
        id: 'fixture-default-credential',
        name: 'Fixture credential',
        type: 'apiKey',
        apiKey: key,
      })
      profileProviderOptions.credentialId = 'fixture-default-credential'
    }
    raw.providerCredentials = providerCredentials
    raw.modelProfiles = [
      {
        id: profileId,
        name: 'Fixture default profile',
        modelId,
        providerOptions: profileProviderOptions,
        runtimeOptions,
      },
    ]
    raw.modelRoleProfiles = { chatMain: { mode: 'profile', profileId } }
  }
  return database
}

function geminiModelInfo(overrides: Partial<LLMModel>): LLMModel {
  return {
    id: 'gemini-2.5-flash',
    name: 'Gemini Test Model',
    provider: LLMProvider.GoogleCloud,
    format: LLMFormat.GoogleCloud,
    flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.requiresAlternateRole, LLMFlags.mustStartWithUserInput],
    parameters: OpenAIParameters,
    tokenizer: LLMTokenizer.GoogleCloud,
    ...overrides,
  }
}

function okOpenAIResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okOpenAILegacyInstructResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ choices: [{ text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okOpenAIResponsesResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okAnthropicResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okCohereResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okOllamaResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ message: { role: 'assistant', content: text }, done: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okKoboldResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ results: [{ text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okOobaLegacyResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ results: [{ text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okBedrockResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okGeminiResponse(text = 'profile ok'): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function parseCapturedBody(rawBody: string): Record<string, unknown> {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return {}
  }
}

function captureRequest(url: string | URL | Request, init?: RequestInit): CapturedDispatchRequest {
  const rawBody = String(init?.body ?? '{}')
  return {
    url: String(url),
    headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    body: parseCapturedBody(rawBody),
    rawBody,
  }
}

function captureDispatchRequests(response: Response = okOpenAIResponse()): CapturedDispatchRequest[] {
  const captured: CapturedDispatchRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push(captureRequest(url, init))
      return response.clone()
    }) as unknown as typeof fetch,
  )
  return captured
}

function captureOpenAIRequests(): CapturedDispatchRequest[] {
  return captureDispatchRequests(okOpenAIResponse())
}

async function withProtocolMetrics<T>(run: (metrics: ProtocolMetric[]) => Promise<T>): Promise<T> {
  const previous = process.env.RISU_PROTOCOL_METRICS
  const metrics: ProtocolMetric[] = []
  process.env.RISU_PROTOCOL_METRICS = '1'
  const infoSpy = vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
    if (typeof message !== 'string' || !message.startsWith('[protocol-metric] ')) return
    metrics.push(JSON.parse(message.slice('[protocol-metric] '.length)) as ProtocolMetric)
  })
  try {
    return await run(metrics)
  } finally {
    infoSpy.mockRestore()
    if (previous === undefined) {
      delete process.env.RISU_PROTOCOL_METRICS
    } else {
      process.env.RISU_PROTOCOL_METRICS = previous
    }
  }
}

function captureHordeRequests(text = 'profile ok'): CapturedDispatchRequest[] {
  const captured: CapturedDispatchRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push(captureRequest(url, init))
      if (String(url).endsWith('/generate/text/async')) {
        return new Response(JSON.stringify({ id: 'profile-horde-job' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (String(url).endsWith('/generate/text/status/profile-horde-job')) {
        return new Response(JSON.stringify({ done: true, generations: [{ text }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected Horde URL: ${String(url)}`)
    }) as unknown as typeof fetch,
  )
  return captured
}

function captureVertexRequests(text = 'profile ok'): CapturedDispatchRequest[] {
  const captured: CapturedDispatchRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push(captureRequest(url, init))
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'ya29.profile-token', expires_in: 3599 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return okGeminiResponse(text)
    }) as unknown as typeof fetch,
  )
  return captured
}

function generatePrivateKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey
}

async function dispatchWithProfile(
  profile: ResolvedModelProfile,
  database: Database,
  formated: PromptMessage[] = [{ role: 'user', content: 'hello' }],
  expectedApiMetadata?: Record<string, unknown>,
): Promise<void> {
  const frames = await dispatchChatProvider({
    database,
    profile,
    formated,
    signal: new AbortController().signal,
  })
  const emitted = []
  for await (const frame of frames) {
    emitted.push(frame)
  }
  expect(emitted).toEqual([
    { kind: 'token', content: 'profile ok' },
    {
      kind: 'done',
      finishReason: 'stop',
      ...(expectedApiMetadata ? { apiMetadata: expectedApiMetadata } : {}),
    },
  ])
}

async function dispatchHordeWithProfile(
  profile: ResolvedModelProfile,
  database: Database,
  formated: PromptMessage[] = [{ role: 'user', content: 'hello' }],
): Promise<void> {
  vi.useFakeTimers()
  const frames = await dispatchChatProvider({
    database,
    profile,
    formated,
    signal: new AbortController().signal,
  })
  const emittedPromise = (async () => {
    const emitted = []
    for await (const frame of frames) {
      emitted.push(frame)
    }
    return emitted
  })()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(2000)
  await expect(emittedPromise).resolves.toEqual([
    { kind: 'token', content: 'profile ok' },
    { kind: 'done', finishReason: 'stop', apiMetadata: { jobId: 'profile-horde-job' } },
  ])
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('dispatchChatProvider final wire controls', () => {
  it('uses upstream streaming when half-streaming is enabled and normal streaming is off', async () => {
    const database = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'wire-model',
      customAPIFormat: LLMFormat.OpenAICompatible,
      forceReplaceUrl: 'https://wire.example/v1/chat/completions',
      proxyKey: 'sk-wire',
      autofillRequestUrl: true,
      useStreaming: false,
      halfStreaming: true,
    } as Partial<Database>)
    const streamResponse = new Response(
      [
        'data: {"choices":[{"delta":{"content":"half"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" streamed"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    const captured = captureDispatchRequests(streamResponse)
    const profile = resolveModelProfile({ database })

    const frames = await dispatchChatProvider({
      database,
      profile,
      formated: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    })
    const emitted = []
    for await (const frame of frames) emitted.push(frame)

    expect(captured).toHaveLength(1)
    expect(captured[0].body.stream).toBe(true)
    expect(emitted).toEqual([
      { kind: 'token', content: 'half' },
      { kind: 'token', content: ' streamed' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('strips known CoT blocks when the effective profile runtime option is enabled', async () => {
    const database = db({
      echoMessage: '<Thoughts>private reasoning</Thoughts>\nVisible answer\n<think>private tail</think>',
      useStreaming: true,
      modelRuntimeDefaults: { stripCoT: true },
      modelProfiles: [{ id: 'strip-cot-profile', name: 'Strip CoT', modelId: 'echo_model' }],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'strip-cot-profile' } },
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const frames = await dispatchChatProvider({
      database,
      profile,
      formated: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    })
    const emitted = []
    for await (const frame of frames) emitted.push(frame)

    expect(profile.runtimeOptions.stripCoT).toBe(true)
    expect(emitted).toEqual([
      { kind: 'token', content: 'Visible answer' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('preserves CoT when a profile disables an enabled runtime default', async () => {
    const response = '<Thoughts>profile-visible reasoning</Thoughts>\nVisible answer'
    const database = db({
      echoMessage: response,
      modelRuntimeDefaults: { stripCoT: true },
      modelProfiles: [
        {
          id: 'preserve-cot-profile',
          name: 'Preserve CoT',
          modelId: 'echo_model',
          runtimeOptions: { stripCoT: false },
        },
      ],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'preserve-cot-profile' } },
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const frames = await dispatchChatProvider({
      database,
      profile,
      formated: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    })
    const emitted = []
    for await (const frame of frames) emitted.push(frame)

    expect(profile.runtimeOptions.stripCoT).toBe(false)
    expect(emitted).toEqual([
      { kind: 'token', content: response },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('sends supported runtime controls, schema, prediction, multi-generation, and logit bias', async () => {
    const database = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'wire-model',
      customAPIFormat: LLMFormat.OpenAICompatible,
      forceReplaceUrl: 'https://wire.example/v1/chat/completions',
      proxyKey: 'sk-wire',
      autofillRequestUrl: true,
      newOAIHandle: true,
      gptVisionQuality: 'high',
      temperature: 73,
      top_p: 0.82,
      top_k: 40,
      min_p: 0.12,
      top_a: 0.08,
      repetition_penalty: 1.13,
      frequencyPenalty: 25,
      PresensePenalty: 35,
      generationSeed: 42,
      jsonSchemaEnabled: true,
      jsonSchema: 'interface Reply {\nanswer: string\nconfidence?: number\n}',
      strictJsonSchema: true,
      OAIPrediction: 'known prefix',
      genTime: 2,
      useStreaming: true,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured: CapturedDispatchRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured.push(captureRequest(url, init))
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: 'first', reasoning_content: 'thought one' } },
              { message: { content: 'second' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch,
    )

    const frames = await dispatchChatProvider({
      database,
      profile,
      formated: [
        { role: 'system', content: '[Start a new chat]', memo: 'NewChat', removable: true },
        {
          role: 'user',
          content: 'hello',
          memo: 'internal',
          attr: ['internal'],
          multimodals: [{ type: 'image', base64: 'data:image/png;base64,AA' }],
          thoughts: ['hidden'],
          cachePoint: true,
        },
      ],
      biases: [
        ['[[123]]', -50],
        ['avoid', -100],
      ],
      multiGeneration: true,
      signal: new AbortController().signal,
    })
    const emitted = []
    for await (const frame of frames) emitted.push(frame)

    expect(captured).toHaveLength(1)
    expect(captured[0].body).toMatchObject({
      model: 'wire-model',
      stream: false,
      max_tokens: 64,
      temperature: 0.73,
      top_p: 0.82,
      top_k: 40,
      min_p: 0.12,
      top_a: 0.08,
      repetition_penalty: 1.13,
      frequency_penalty: 0.25,
      presence_penalty: 0.35,
      seed: 42,
      n: 2,
      prediction: { type: 'content', content: 'known prefix' },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'format',
          strict: true,
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
            required: ['answer'],
          },
        },
      },
      logit_bias: { '123': -50 },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA', detail: 'high' } },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    })
    expect(JSON.stringify(captured[0].body.messages)).not.toMatch(
      /NewChat|memo|removable|attr|multimodals|thoughts|cachePoint/u,
    )
    expect(Object.keys(captured[0].body.logit_bias as Record<string, number>).length).toBeGreaterThan(1)
    expect(emitted).toEqual([
      { kind: 'token', content: '<Thoughts>\nthought one\n</Thoughts>\nfirst' },
      { kind: 'done', finishReason: 'stop', alternates: ['second'] },
    ])
  })

  it.each([
    ['gpt-5.1', -1, 'none'],
    ['gpt-5.4-pro', 0, 'medium'],
    ['gpt-5.5', 3, 'xhigh'],
    ['gpt-5', 3, 'high'],
  ])('maps %s reasoning effort %i to %s on the live OpenAI path', async (model, value, expected) => {
    const database = db({
      aiModel: model,
      openAIKey: 'sk-openai',
      reasoningEffort: value,
      verbosity: undefined,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].body.reasoning_effort).toBe(expected)
    expect(captured[0].body.verbosity).toBe('medium')
  })

  it('sends Flex processing on official OpenAI Chat Completions requests', async () => {
    const database = db({
      aiModel: 'gpt-5',
      openAIKey: 'sk-openai',
      openAIFlexProcessing: true,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(captured[0].body.service_tier).toBe('flex')
  })

  it('sends Flex processing when a custom Chat Completions URL targets the official OpenAI host', async () => {
    const database = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'gpt-5',
      customAPIFormat: LLMFormat.OpenAICompatible,
      forceReplaceUrl: 'https://api.openai.com/v1/chat/completions',
      proxyKey: 'sk-openai',
      autofillRequestUrl: true,
      openAIFlexProcessing: true,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(captured[0].body.service_tier).toBe('flex')
  })

  it.each([
    {
      label: 'the toggle is off',
      database: db({ aiModel: 'gpt-5', openAIKey: 'sk-openai', openAIFlexProcessing: false } as Partial<Database>),
    },
    {
      label: 'a custom endpoint is not OpenAI',
      database: db({
        aiModel: 'reverse_proxy',
        customProxyRequestModel: 'custom-model',
        customAPIFormat: LLMFormat.OpenAICompatible,
        forceReplaceUrl: 'https://custom.example/v1/chat/completions',
        proxyKey: 'sk-custom',
        autofillRequestUrl: true,
        openAIFlexProcessing: true,
      } as Partial<Database>),
    },
    {
      label: 'the provider is OpenRouter',
      database: db({
        aiModel: 'openrouter',
        openrouterKey: 'sk-openrouter',
        openrouterRequestModel: 'openai/gpt-5',
        openAIFlexProcessing: true,
      } as Partial<Database>),
    },
    {
      label: 'the provider is NanoGPT',
      database: db({
        aiModel: 'nanogpt',
        nanogptKey: 'sk-nano',
        nanogptRequestModel: 'gpt-5',
        nanogptUseSubscriptionEndpoint: false,
        openAIFlexProcessing: true,
      } as Partial<Database>),
    },
  ])('omits global Flex processing when $label', async ({ database }) => {
    const profile = resolveModelProfile({ database })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].body.service_tier).toBeUndefined()
  })

  it('omits json_schema response_format for a noStructuredOutput model on the live OpenAI path', async () => {
    const database = db({
      aiModel: 'gpt-5.4-pro',
      openAIKey: 'sk-openai',
      jsonSchemaEnabled: true,
      jsonSchema: '{"type":"object"}',
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, database)

    expect(profile.modelInfo.flags).toContain(LLMFlags.noStructuredOutput)
    expect(captured).toHaveLength(1)
    expect(captured[0].body.response_format).toBeUndefined()
  })

  it('honors Claude Opus 4.8 adaptive thinking with xhigh effort on the live Anthropic path', async () => {
    const database = db({
      aiModel: 'claude-opus-4-8',
      claudeAPIKey: 'sk-anthropic',
      thinkingType: 'adaptive',
      adaptiveThinkingEffort: 'xhigh',
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureDispatchRequests(okAnthropicResponse())

    await dispatchWithProfile(profile, database)

    expect(profile.modelInfo.flags).toEqual(
      expect.arrayContaining([LLMFlags.claudeAdaptiveThinking, LLMFlags.claudeXHighEffort]),
    )
    expect(captured).toHaveLength(1)
    expect(captured[0].body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(captured[0].body.output_config).toEqual({ effort: 'xhigh' })
  })

  it('applies the configured JSON extraction path to buffered provider output', async () => {
    const database = db({
      aiModel: 'echo_model',
      echoMessage: '```json\n{"reply":{"text":"visible"}}\n```',
      useStreaming: true,
      jsonSchemaEnabled: true,
      jsonSchema: '{"type":"object"}',
      extractJson: 'reply.text',
    } as Partial<Database>)
    const frames = await dispatchChatProvider({
      database,
      formated: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    })
    const emitted = []
    for await (const frame of frames) emitted.push(frame)

    expect(emitted).toEqual([
      { kind: 'token', content: 'visible' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })
})

describe('dispatchChatProvider profile providerOptions', () => {
  it.each([
    { enabled: true, expectedApplied: true },
    { enabled: false, expectedApplied: false },
  ])(
    'applies ordinary Gemini flat body/header params only when the all-model opt-in is $enabled',
    async ({ enabled, expectedApplied }) => {
      const database = db({
        aiModel: 'gemini-2.5-flash',
        google: { accessToken: 'profile-google-key', projectId: '' },
        applyAdditionalParamsToAll: enabled,
        additionalParams: [
          ['globalFlag', 'true'],
          ['header::X-Global-Trace', 'enabled'],
        ],
      } as Partial<Database>)
      const profile = resolveModelProfile({
        database,
        lookupModelInfo: (_database, id) =>
          geminiModelInfo({
            id,
            internalID: 'models/gemini-opt-in-wire-model',
            provider: LLMProvider.GoogleCloud,
            format: LLMFormat.GoogleCloud,
          }),
      })
      const captured = captureDispatchRequests(okGeminiResponse())

      await dispatchWithProfile(profile, database)

      expect(captured).toHaveLength(1)
      expect(captured[0].body.globalFlag).toBe(expectedApplied ? true : undefined)
      expect(captured[0].headers['X-Global-Trace']).toBe(expectedApplied ? 'enabled' : undefined)
    },
  )

  it('emits metadata-only prompt reformat metrics when provider flags change rows', async () => {
    const profile = resolveModelProfileWithLegacyCompatibility({
      database: db({
        aiModel: 'gemini-2.5-flash',
        google: { accessToken: 'profile-google-key', projectId: 'profile-project' },
        modelRoleProfiles: {},
      } as Partial<Database>),
      lookupModelInfo: (_database, id) =>
        geminiModelInfo({
          id,
          internalID: 'models/gemini-profile-wire-model',
          provider: LLMProvider.GoogleCloud,
          format: LLMFormat.GoogleCloud,
        }),
    })
    const database = db({
      aiModel: 'gemini-2.5-flash',
      google: { accessToken: 'profile-google-key', projectId: 'profile-project' },
      modelRoleProfiles: {},
    } as Partial<Database>)
    const formated: PromptMessage[] = [
      { role: 'system', content: 'slice-2-secret-dispatch-system' },
      { role: 'user', content: 'slice-2-secret-dispatch-user-a' },
      { role: 'user', content: 'slice-2-secret-dispatch-user-b' },
    ]
    captureDispatchRequests(okGeminiResponse())

    await withProtocolMetrics(async (metrics) => {
      await dispatchWithProfile(profile, database, formated)

      const metric = metrics.find((entry) => entry.metric === 'generation_prompt_dispatch_reformat')
      expect(metric).toMatchObject({
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        wireModel: 'gemini-profile-wire-model',
        profileId: expect.any(String),
        profileSourceKind: 'legacy-aiModel',
        modelInfoFormat: LLMFormat.GoogleCloud,
        prePromptRowCount: 3,
        prePromptRoleSequence: 'system,user,user',
        prePromptRows: expect.any(Array),
        postPromptRowCount: 2,
        postPromptRoleSequence: 'system,user',
        postPromptRows: expect.any(Array),
        promptReformatted: true,
        promptRowCountChanged: true,
        promptRoleSequenceChanged: true,
        promptReferenceChanged: true,
      })
      expect(metric?.prePromptHash).toMatch(/^[a-f0-9]{64}$/)
      expect(metric?.postPromptHash).toMatch(/^[a-f0-9]{64}$/)
      expect(metric?.prePromptHash).not.toBe(metric?.postPromptHash)
      expect(metric?.prePromptRows).toHaveLength(3)
      expect(metric?.postPromptRows).toHaveLength(2)
      expect(JSON.stringify(metrics)).not.toContain('slice-2-secret-dispatch')
    })
  })

  it('uses a selected durable profile API key for outbound OpenRouter authorization', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'gpt-5',
        openrouterKey: 'sk-flat-openrouter',
        openrouterRequestModel: 'flat/openrouter',
        providerCredentials: [
          {
            id: 'credential-openrouter',
            name: 'OpenRouter',
            type: 'apiKey',
            apiKey: 'sk-durable-openrouter',
          },
        ],
        modelProfiles: [
          {
            id: 'openrouter-profile',
            name: 'OpenRouter Profile',
            modelId: 'openrouter',
            providerOptions: {
              credentialId: 'credential-openrouter',
              requestModel: 'profile/openrouter',
            },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'openrouter-profile' } },
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'openrouter',
      openrouterKey: 'sk-conflicting-openrouter',
      openrouterRequestModel: 'conflict/openrouter',
    } as Partial<Database>)
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-durable-openrouter')
    expect(captured[0].body.model).toBe('profile/openrouter')
  })

  it('uses reverse_proxy profile options over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'reverse_proxy',
        customProxyRequestModel: 'profile-proxy-model',
        customAPIFormat: LLMFormat.OpenAICompatible,
        forceReplaceUrl: 'risu::https://profile-proxy.example.com',
        proxyKey: 'sk-profile-proxy',
        autofillRequestUrl: true,
        reverseProxyOobaMode: true,
        reverseProxyOobaArgs: {
          mode: 'chat-instruct',
          turn_template: '<|user|>{{user}}',
          name1: 'Profile Persona',
          name2: 'Profile Character',
          context: 'Profile context',
          greeting: '',
          chat_instruct_command: 'Continue the chat',
          preset: 'Profile preset',
          tokenizer: 'profile-tokenizer',
          min_p: 0.17,
          top_k: 73,
          do_sample: false,
          ban_eos_token: true,
          grammar_string: 'root ::= "ok"',
        },
        additionalParams: [
          ['header::X-Profile', 'profile'],
          ['profileFlag', 'true'],
        ],
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'flat-proxy-model',
      customAPIFormat: LLMFormat.OpenAICompatible,
      forceReplaceUrl: 'https://flat-proxy.example.com/v1',
      proxyKey: 'sk-flat-proxy',
      autofillRequestUrl: true,
      reverseProxyOobaMode: false,
      reverseProxyOobaArgs: { mode: 'chat', name1: 'Flat Persona', grammar_string: 'flat-only' },
      additionalParams: [
        ['header::X-Flat', 'flat'],
        ['flatFlag', 'true'],
      ],
    } as Partial<Database>)
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, flatConflict, [
      { role: 'system', content: 'profile system 1' },
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'profile system 2' },
    ])

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://profile-proxy.example.com/v1/chat/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-profile-proxy')
    expect(captured[0].headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(captured[0].headers['X-Profile']).toBe('profile')
    expect(captured[0].headers['X-Flat']).toBeUndefined()
    expect(captured[0].body.model).toBe('profile-proxy-model')
    expect(captured[0].body.profileFlag).toBe(true)
    expect(captured[0].body.flatFlag).toBeUndefined()
    expect(captured[0].body).toMatchObject({
      mode: 'chat-instruct',
      turn_template: '<|user|>{{user}}',
      name1: 'Profile Persona',
      name2: 'Profile Character',
      context: 'Profile context',
      greeting: '',
      chat_instruct_command: 'Continue the chat',
      preset: 'Profile preset',
      tokenizer: 'profile-tokenizer',
      min_p: 0.17,
      top_k: 73,
      do_sample: false,
      ban_eos_token: true,
      grammar_string: 'root ::= "ok"',
    })
    expect(captured[0].body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'profile system 1\nprofile system 2' },
    ])
  })

  it('preserves a profile null that clears conflicting legacy reverse-proxy arguments', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'reverse_proxy',
        forceReplaceUrl: 'https://proxy.example.com/v1',
        customProxyRequestModel: 'profile-proxy-model',
        customAPIFormat: LLMFormat.OpenAICompatible,
        proxyKey: 'fixture-proxy-key',
        autofillRequestUrl: true,
        reverseProxyOobaMode: true,
        reverseProxyOobaArgs: null,
      }),
    })
    expect(profile.providerOptions.reverseProxy?.oobaArgs).toBeNull()
    const flatConflict = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'flat-proxy-model',
      customAPIFormat: LLMFormat.OpenAICompatible,
      forceReplaceUrl: 'https://flat-proxy.example.com/v1',
      reverseProxyOobaMode: true,
      reverseProxyOobaArgs: { mode: 'chat', grammar_string: 'legacy-only' },
    })
    const captured = captureOpenAIRequests()
    await dispatchWithProfile(profile, flatConflict)
    expect(captured).toHaveLength(1)
    expect(captured[0].body.mode).toBeUndefined()
    expect(captured[0].body.grammar_string).toBeUndefined()
  })

  it.each([
    {
      label: 'autofill off custom operation',
      configuredUrl: 'https://proxy.example.com/custom/chat?api-version=2025-01-01',
      autofill: false,
      expectedUrl: 'https://proxy.example.com/custom/chat?api-version=2025-01-01',
    },
    {
      label: 'autofill off Chat Completions endpoint',
      configuredUrl: 'https://proxy.example.com/v1/chat/completions?api-version=2025-01-01',
      autofill: false,
      expectedUrl: 'https://proxy.example.com/v1/chat/completions?api-version=2025-01-01',
    },
    {
      label: 'autofill on v1 query',
      configuredUrl: 'https://proxy.example.com/v1?api-version=2025-01-01',
      autofill: true,
      expectedUrl: 'https://proxy.example.com/v1/chat/completions?api-version=2025-01-01',
    },
    {
      label: 'autofill on v1 trailing slash query',
      configuredUrl: 'https://proxy.example.com/v1/?api-version=2025-01-01',
      autofill: true,
      expectedUrl: 'https://proxy.example.com/v1/chat/completions?api-version=2025-01-01',
    },
    {
      label: 'autofill on completed trailing slash query',
      configuredUrl: 'https://proxy.example.com/v1/chat/completions/?api-version=2025-01-01',
      autofill: true,
      expectedUrl: 'https://proxy.example.com/v1/chat/completions?api-version=2025-01-01',
    },
  ])('preserves query placement for $label', async ({ configuredUrl, autofill, expectedUrl }) => {
    const database = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'query-model',
      customAPIFormat: LLMFormat.OpenAICompatible,
      forceReplaceUrl: configuredUrl,
      proxyKey: 'sk-query',
      autofillRequestUrl: autofill,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, database)

    expect(captured[0].url).toBe(expectedUrl)
  })

  it('forwards persisted Gemini reverse-proxy URL, headers, key, and body overrides', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'reverse_proxy',
        customProxyRequestModel: 'gemini-proxy-model',
        customAPIFormat: LLMFormat.GoogleCloud,
        forceReplaceUrl: 'risu::https://gemini-proxy.example.com/google/v1beta',
        proxyKey: 'profile-gemini-proxy-key',
        autofillRequestUrl: true,
        additionalParams: [
          ['header::X-Proxy-Auth', 'profile-header'],
          ['generationConfig.temperature', '0.91'],
          ['profileFlag', 'true'],
        ],
      } as Partial<Database>),
      lookupModelInfo: (_database, id) =>
        geminiModelInfo({
          id,
          internalID: 'gemini-proxy-model',
          provider: LLMProvider.GoogleCloud,
          format: LLMFormat.GoogleCloud,
        }),
    })
    const flatConflict = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'flat-gemini-model',
      customAPIFormat: LLMFormat.GoogleCloud,
      forceReplaceUrl: 'https://flat-gemini.example.com/v1beta',
      proxyKey: 'flat-gemini-key',
      autofillRequestUrl: true,
      additionalParams: [
        ['header::X-Flat', 'flat'],
        ['flatFlag', 'true'],
      ],
    } as Partial<Database>)
    const captured = captureDispatchRequests(okGeminiResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(
      'https://gemini-proxy.example.com/google/v1beta/models/gemini-proxy-model:generateContent?key=profile-gemini-proxy-key',
    )
    expect(captured[0].headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(captured[0].headers['X-Proxy-Auth']).toBe('profile-header')
    expect(captured[0].headers['X-Flat']).toBeUndefined()
    expect(captured[0].body.generationConfig).toMatchObject({ temperature: 0.91 })
    expect(captured[0].body.profileFlag).toBe(true)
    expect(captured[0].body.flatFlag).toBeUndefined()
  })

  it('preserves legacy reverse_proxy autofill for converted custom-api profile mirrors', async () => {
    const database = db({
      aiModel: 'reverse_proxy',
      customAPIFormat: LLMFormat.OpenAICompatible,
      forceReplaceUrl: 'https://util.node.mephistopheles.moe/chat/risu',
      proxyKey: 'sk-flat-proxy',
      autofillRequestUrl: true,
      providerCredentials: [{ id: 'credential-proxy', name: 'Proxy', type: 'apiKey', apiKey: 'sk-profile-proxy' }],
      modelProfiles: [
        {
          id: 'converted-custom-api',
          name: 'Converted Custom API',
          providerId: 'custom-api',
          modelId: 'custom-api',
          providerOptions: {
            credentialId: 'credential-proxy',
            baseUrl: 'https://util.node.mephistopheles.moe/chat/risu',
            requestModel: 'extension',
          },
        },
      ],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'converted-custom-api' } },
    } as Partial<Database>)
    const profile = resolveModelProfile({ database, role: 'chatMain' })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://util.node.mephistopheles.moe/chat/risu/v1/chat/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-profile-proxy')
    expect(captured[0].body.model).toBe('extension')
  })

  it('uses OpenAI legacy instruct profile options over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'reverse_proxy',
        customProxyRequestModel: 'profile-legacy-model',
        customAPIFormat: LLMFormat.OpenAILegacyInstruct,
        forceReplaceUrl: 'risu::https://profile-legacy.example.com/v1',
        proxyKey: 'sk-profile-legacy',
        autofillRequestUrl: true,
        additionalParams: [
          ['header::X-Profile', 'profile'],
          ['profileFlag', 'true'],
        ],
      } as Partial<Database>),
      lookupModelInfo: (_database, id) =>
        ({
          id,
          name: id,
          internalID: 'profile-legacy-model',
          provider: LLMProvider.AsIs,
          format: LLMFormat.OpenAILegacyInstruct,
          flags: [LLMFlags.hasFirstSystemPrompt],
          parameters: OpenAIParameters,
          tokenizer: LLMTokenizer.Unknown,
        }) as LLMModel,
    })
    const flatConflict = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'flat-legacy-model',
      customAPIFormat: LLMFormat.OpenAILegacyInstruct,
      forceReplaceUrl: 'https://flat-legacy.example.com/v1',
      proxyKey: 'sk-flat-legacy',
      autofillRequestUrl: true,
      additionalParams: [
        ['header::X-Flat', 'flat'],
        ['flatFlag', 'true'],
      ],
    } as Partial<Database>)
    const captured = captureDispatchRequests(okOpenAILegacyInstructResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://profile-legacy.example.com/v1/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-profile-legacy')
    expect(captured[0].headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(captured[0].headers['X-Profile']).toBe('profile')
    expect(captured[0].headers['X-Flat']).toBeUndefined()
    expect(captured[0].body.model).toBe('profile-legacy-model')
    expect(captured[0].body.profileFlag).toBe(true)
    expect(captured[0].body.flatFlag).toBeUndefined()
  })

  it('uses OpenAI Responses profile options over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'reverse_proxy',
        customProxyRequestModel: 'profile-responses-model',
        customAPIFormat: LLMFormat.OpenAIResponseAPI,
        forceReplaceUrl: 'risu::https://profile-responses.example.com/v1',
        proxyKey: 'sk-profile-responses',
        autofillRequestUrl: true,
        useStreaming: true,
        additionalParams: [
          ['header::X-Profile', 'profile'],
          ['profileFlag', 'true'],
        ],
      } as Partial<Database>),
      lookupModelInfo: (_database, id) =>
        ({
          id,
          name: id,
          internalID: 'profile-responses-model',
          provider: LLMProvider.AsIs,
          format: LLMFormat.OpenAIResponseAPI,
          flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.hasStreaming],
          parameters: OpenAIParameters,
          tokenizer: LLMTokenizer.tiktokenO200Base,
        }) as LLMModel,
    })
    const flatConflict = db({
      aiModel: 'ollama-cloud',
      ollamaApiKey: 'sk-flat-ollama',
      ollamaRequestFormat: LLMFormat.OpenAIResponseAPI,
      ollamaCloudModel: 'flat-ollama-responses',
    } as Partial<Database>)
    const captured = captureDispatchRequests(okOpenAIResponsesResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://profile-responses.example.com/v1/responses')
    expect(captured[0].headers.authorization).toBe('Bearer sk-profile-responses')
    expect(captured[0].headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(captured[0].headers['X-Profile']).toBe('profile')
    expect(captured[0].body.model).toBe('profile-responses-model')
    expect(captured[0].body.profileFlag).toBe(true)
    expect(captured[0].body.store).toBe(false)
    expect(captured[0].body.stream).toBeUndefined()
  })

  it('preserves an exact OpenAI Responses reverse-proxy endpoint when autofill is disabled', async () => {
    const database = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'exact-responses-model',
      customAPIFormat: LLMFormat.OpenAIResponseAPI,
      forceReplaceUrl: 'https://proxy.example.com/exact-response?api-version=2026-01-01',
      proxyKey: 'sk-exact-responses',
      autofillRequestUrl: false,
    } as Partial<Database>)
    const profile = resolveModelProfile({
      database,
      lookupModelInfo: (_database, id) =>
        ({
          id,
          name: id,
          internalID: 'exact-responses-model',
          provider: LLMProvider.AsIs,
          format: LLMFormat.OpenAIResponseAPI,
          flags: [LLMFlags.hasFirstSystemPrompt, LLMFlags.hasStreaming],
          parameters: OpenAIParameters,
          tokenizer: LLMTokenizer.tiktokenO200Base,
        }) as LLMModel,
    })
    const captured = captureDispatchRequests(okOpenAIResponsesResponse())

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://proxy.example.com/exact-response?api-version=2026-01-01')
  })

  it.each([
    ['gpt-5.1-response-api', -1, 'none'],
    ['gpt-5.4-pro-response-api', 0, 'medium'],
    ['gpt-5.5-response-api', 3, 'xhigh'],
    ['gpt-5-response-api', 3, 'high'],
  ])('preserves %s reasoning effort %i as %s on the Responses wire', async (model, value, expected) => {
    const database = db({
      aiModel: model,
      openAIKey: 'sk-openai',
      reasoningEffort: value,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureDispatchRequests(okOpenAIResponsesResponse())

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].body.reasoning).toEqual({ effort: expected, summary: 'auto' })
    expect(captured[0].body.text).toEqual({ verbosity: 'medium' })
    expect(JSON.stringify(captured[0].body)).not.toMatch(/reasoning_effort_(?:none|xhigh|min_medium)/u)
  })

  it('uses Responses-native tools and sanitized bounded tool continuation input', async () => {
    const database = db({
      aiModel: 'gpt-5.5-response-api',
      openAIKey: 'sk-openai',
      modelTools: ['search'],
      reasoningEffort: 3,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureDispatchRequests(okOpenAIResponsesResponse())
    const frames = await dispatchChatProvider({
      database,
      profile,
      formated: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
      tools: [{ name: 'lookup', description: 'Lookup data', inputSchema: { type: 'object' } }],
      toolRounds: [
        {
          assistantContent: '',
          calls: [{ id: 'call-1', name: 'lookup', arguments: { query: 'weather' } }],
          results: [{ callId: 'call-1', name: 'lookup', content: 'sunny' }],
        },
      ],
    })
    for await (const _frame of frames) {
      // Consume the buffered adapter frames so the request completes.
    }

    expect(captured[0].body.tools).toEqual([
      { type: 'function', name: 'lookup', description: 'Lookup data', parameters: { type: 'object' } },
      { type: 'web_search_preview' },
    ])
    expect(captured[0].body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: '{"query":"weather"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'call-1', output: 'sunny' },
    ])
    expect(captured[0].body.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
  })

  it('preserves reasoning effort on the NanoGPT Responses remap without leaking capability markers', async () => {
    const nanoResponsesInfo: LLMModel = {
      id: 'nanogpt-responses-test',
      name: 'NanoGPT Responses Test',
      internalID: 'nanogpt',
      provider: LLMProvider.NanoGPT,
      format: LLMFormat.NanoGPTResponses,
      flags: [LLMFlags.hasFullSystemPrompt],
      parameters: ['temperature', 'top_p', 'reasoning_effort', 'reasoning_effort_none', 'reasoning_effort_xhigh'],
      tokenizer: LLMTokenizer.Unknown,
    }
    const database = db({
      aiModel: 'flat-main-model',
      nanogptKey: 'sk-nano',
      nanogptProvider: 'flat-provider-must-not-win',
      nanogptUseSubscriptionEndpoint: false,
      reasoningEffort: 3,
      providerCredentials: [
        { id: 'nanogpt-responses-credential', name: 'NanoGPT', type: 'apiKey', apiKey: 'sk-profile-nano' },
      ],
      modelProfiles: [
        {
          id: 'nanogpt-responses-profile',
          name: 'NanoGPT Responses Profile',
          modelId: nanoResponsesInfo.id,
          providerOptions: {
            credentialId: 'nanogpt-responses-credential',
            requestModel: 'provider/nano-model',
            nanogpt: {
              providerHint: 'must-not-be-sent-on-subscription',
              useSubscriptionEndpoint: true,
            },
          },
        },
      ],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'nanogpt-responses-profile' } },
    } as Partial<Database>)
    const profile = resolveModelProfile({
      database,
      lookupModelInfo: (_database, id) => (id === nanoResponsesInfo.id ? nanoResponsesInfo : undefined),
    })
    const captured = captureDispatchRequests(okOpenAIResponsesResponse())

    await dispatchWithProfile(profile, database)

    expect(captured[0].url).toBe('https://nano-gpt.com/api/subscription/v1/responses')
    expect(captured[0].headers['X-Provider']).toBeUndefined()
    expect(captured[0].body.model).toBe('provider/nano-model')
    expect(captured[0].body.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
    expect(JSON.stringify(captured[0].body)).not.toContain('reasoning_effort_xhigh')
  })

  it('uses the profile model id for OpenAI Responses Ollama Cloud store ownership', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'ollama-cloud',
        ollamaApiKey: 'sk-profile-ollama',
        ollamaRequestFormat: LLMFormat.OpenAIResponseAPI,
        ollamaCloudModel: 'profile-ollama-responses',
        ollamaModelSource: 'cloud',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'flat-responses-model',
      customAPIFormat: LLMFormat.OpenAIResponseAPI,
      forceReplaceUrl: 'https://flat-responses.example.com/v1',
      proxyKey: 'sk-flat-responses',
      additionalParams: [['header::X-Flat', 'flat']],
    } as Partial<Database>)
    const captured = captureDispatchRequests(okOpenAIResponsesResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://ollama.com/v1/responses')
    expect(captured[0].headers.authorization).toBe('Bearer sk-profile-ollama')
    expect(captured[0].headers['X-Flat']).toBeUndefined()
    expect(captured[0].body.model).toBe('profile-ollama-responses')
    expect(captured[0].body.store).toBeUndefined()
    expect(captured[0].body.reasoning).toBeUndefined()
    expect(JSON.stringify(captured[0].body)).not.toMatch(/reasoning_effort_(?:none|xhigh|min_medium)/u)
  })

  it('uses Anthropic xcustom profile options over conflicting flat database fields', async () => {
    const profile = resolveModelProfileWithLegacyCompatibility({
      database: db({
        aiModel: 'xcustom:::profile-anthropic',
        customModels: [
          {
            id: 'xcustom:::profile-anthropic',
            name: 'Profile Anthropic',
            internalId: 'profile-claude-model',
            url: 'https://profile-anthropic.example.com/v1/messages',
            key: 'sk-profile-anthropic',
            format: LLMFormat.Anthropic,
            tokenizer: 0,
            flags: [],
            params: 'header::anthropic-beta=profile-beta\nprofileFlag=true',
          },
        ] as Database['customModels'],
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'xcustom:::profile-anthropic',
      customModels: [
        {
          id: 'xcustom:::profile-anthropic',
          name: 'Flat Anthropic',
          internalId: 'flat-claude-model',
          url: 'https://flat-anthropic.example.com/v1/messages',
          key: 'sk-flat-anthropic',
          format: LLMFormat.Anthropic,
          tokenizer: 0,
          flags: [],
          params: 'header::X-Flat=flat\nflatFlag=true',
        },
      ] as Database['customModels'],
    } as Partial<Database>)
    const captured = captureDispatchRequests(okAnthropicResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://profile-anthropic.example.com/v1/messages')
    expect(captured[0].headers['x-api-key']).toBe('sk-profile-anthropic')
    expect(captured[0].headers['anthropic-beta']).toBe('profile-beta')
    expect(captured[0].headers['X-Flat']).toBeUndefined()
    expect(captured[0].body.model).toBe('profile-claude-model')
    expect(captured[0].body.profileFlag).toBe(true)
    expect(captured[0].body.flatFlag).toBeUndefined()
  })

  it('uses Mistral reverse_proxy profile options over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'reverse_proxy',
        customProxyRequestModel: 'profile-mistral-model',
        customAPIFormat: LLMFormat.Mistral,
        forceReplaceUrl: 'risu::https://profile-mistral.example.com',
        proxyKey: 'sk-profile-mistral',
        autofillRequestUrl: true,
        additionalParams: [
          ['header::X-Profile', 'profile'],
          ['profileFlag', 'true'],
        ],
      } as Partial<Database>),
      lookupModelInfo: (_database, id) =>
        ({
          id,
          name: id,
          internalID: 'profile-mistral-model',
          provider: LLMProvider.AsIs,
          format: LLMFormat.Mistral,
          flags: [LLMFlags.hasFirstSystemPrompt],
          parameters: OpenAIParameters,
          tokenizer: LLMTokenizer.Mistral,
        }) as LLMModel,
    })
    const flatConflict = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'flat-mistral-model',
      customAPIFormat: LLMFormat.Mistral,
      forceReplaceUrl: 'https://flat-mistral.example.com/v1',
      proxyKey: 'sk-flat-mistral',
      autofillRequestUrl: true,
      additionalParams: [
        ['header::X-Flat', 'flat'],
        ['flatFlag', 'true'],
      ],
    } as Partial<Database>)
    const captured = captureDispatchRequests(okOpenAIResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://profile-mistral.example.com/v1/chat/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-profile-mistral')
    expect(captured[0].headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(captured[0].headers['X-Profile']).toBe('profile')
    expect(captured[0].headers['X-Flat']).toBeUndefined()
    expect(captured[0].body.model).toBe('profile-mistral-model')
    expect(captured[0].body.profileFlag).toBe(true)
    expect(captured[0].body.flatFlag).toBeUndefined()
  })

  it('uses Cohere reverse_proxy profile options over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'reverse_proxy',
        customProxyRequestModel: 'profile-cohere-model',
        customAPIFormat: LLMFormat.Cohere,
        forceReplaceUrl: 'risu::https://profile-cohere.example.com',
        proxyKey: 'sk-profile-cohere',
        autofillRequestUrl: true,
        additionalParams: [
          ['header::X-Profile', 'profile'],
          ['profileFlag', 'true'],
        ],
      } as Partial<Database>),
      lookupModelInfo: (_database, id) =>
        ({
          id,
          name: id,
          internalID: 'profile-cohere-model',
          provider: LLMProvider.AsIs,
          format: LLMFormat.Cohere,
          flags: [LLMFlags.hasFirstSystemPrompt],
          parameters: OpenAIParameters,
          tokenizer: LLMTokenizer.Cohere,
        }) as LLMModel,
    })
    const flatConflict = db({
      aiModel: 'reverse_proxy',
      customProxyRequestModel: 'flat-cohere-model',
      customAPIFormat: LLMFormat.Cohere,
      forceReplaceUrl: 'https://flat-cohere.example.com/v1',
      proxyKey: 'sk-flat-cohere',
      autofillRequestUrl: true,
      additionalParams: [
        ['header::X-Flat', 'flat'],
        ['flatFlag', 'true'],
      ],
    } as Partial<Database>)
    const captured = captureDispatchRequests(okCohereResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://profile-cohere.example.com/v1/chat')
    expect(captured[0].headers.authorization).toBe('Bearer sk-profile-cohere')
    expect(captured[0].headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(captured[0].headers['X-Profile']).toBe('profile')
    expect(captured[0].headers['X-Flat']).toBeUndefined()
    expect(captured[0].body.model).toBe('profile-cohere-model')
    expect(captured[0].body.profileFlag).toBe(true)
    expect(captured[0].body.flatFlag).toBeUndefined()
  })

  it('uses native Ollama profile URL, model, and thinking mode over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'ollama-hosted',
        ollamaURL: 'http://profile-ollama.example.com',
        ollamaModel: 'profile-llama',
        ollamaThinkingMode: 'medium',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'ollama-hosted',
      ollamaURL: 'http://flat-ollama.example.com',
      ollamaModel: 'flat-llama',
      ollamaThinkingMode: 'off',
    } as Partial<Database>)
    const captured = captureDispatchRequests(okOllamaResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('http://profile-ollama.example.com/api/chat')
    expect(captured[0].body.model).toBe('profile-llama')
    expect(captured[0].body.think).toBe('medium')
  })

  it('uses Kobold profile URL over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'kobold',
        koboldURL: 'http://profile-kobold.example.com',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'kobold',
      koboldURL: 'http://flat-kobold.example.com',
    } as Partial<Database>)
    const captured = captureDispatchRequests(okKoboldResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('http://profile-kobold.example.com/api/v1/generate')
  })

  it('preserves Kobold HTTP non-retryability on the provider failure frame', async () => {
    const database = db({ aiModel: 'kobold', koboldURL: 'http://kobold.example.com' } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    vi.stubGlobal('fetch', async () => new Response('kobold denied', { status: 401 }))

    const source = await dispatchChatProvider({
      database,
      profile,
      formated: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    })
    const emitted = []
    for await (const frame of source) emitted.push(frame)

    expect(emitted).toEqual([{ kind: 'error', error: 'kobold denied', nonRetryable: true }])
  })

  it('uses OobaLegacy profile URL and API key over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'mancer',
        textgenWebUIBlockingURL: 'http://profile-ooba.example.com/api/v1/blocking',
        mancerHeader: 'profile-mancer-key',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'mancer',
      textgenWebUIBlockingURL: 'http://flat-ooba.example.com/api/v1/blocking',
      mancerHeader: 'flat-mancer-key',
      temperature: 67,
      localStopStrings: ['STOP\\nHERE'],
      ooba: {
        top_p: 0.81,
        top_k: 73,
        typical_p: 0.92,
        repetition_penalty: 1.17,
        do_sample: false,
        seed: 42,
      } as Database['ooba'],
    } as Partial<Database>)
    const captured = captureDispatchRequests(okOobaLegacyResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('http://profile-ooba.example.com/api/v1/generate')
    expect(captured[0].headers['X-API-KEY']).toBe('profile-mancer-key')
    expect(captured[0].body).toMatchObject({
      temperature: 0.67,
      top_p: 0.81,
      top_k: 73,
      typical_p: 0.92,
      repetition_penalty: 1.17,
      do_sample: false,
      seed: 42,
      stopping_strings: ['STOP\nHERE'],
    })
  })

  it('sends baseline Ooba stops and truncation budget, then cleans the effective character turn', async () => {
    const database = db({
      aiModel: 'mancer',
      textgenWebUIBlockingURL: 'http://ooba.example.com/api/v1/blocking',
      mancerHeader: 'mancer-key',
      username: 'Active Persona',
      maxContext: 8_192,
      maxResponse: 64,
      currentChar: 0,
      characters: [{ name: 'Wrong First Character' }, { name: 'Active Character' }],
      ooba: {
        formating: { userPrefix: '### Persona Input:' },
      } as Database['ooba'],
    } as unknown as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureDispatchRequests(okOobaLegacyResponse('clean answer\nActive Character: trailing turn'))

    const source = await dispatchChatProvider({
      database,
      profile,
      formated: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hello' },
      ],
      outputTokens: 123,
      currentCharacterName: 'Active Character',
      signal: new AbortController().signal,
    })
    const emitted = []
    for await (const frame of source) emitted.push(frame)

    expect(captured).toHaveLength(1)
    expect(captured[0].body.truncation_length).toBe(123)
    expect(captured[0].body.stopping_strings).toEqual([
      'GPT4 User',
      '</s>',
      '<|end',
      '<|im_end',
      '### Persona Input:',
      'Active Persona:',
      'user:',
      '<<user>>',
      '### user',
      'USER:',
      '<<USER>>',
      '### USER',
      'User:',
      '<<User>>',
      '### User',
      'human:',
      '<<human>>',
      '### human',
      'HUMAN:',
      '<<HUMAN>>',
      '### HUMAN',
      'Human:',
      '<<Human>>',
      '### Human',
      'input:',
      '<<input>>',
      '### input',
      'INPUT:',
      '<<INPUT>>',
      '### INPUT',
      'Input:',
      '<<Input>>',
      '### Input',
      'inst:',
      '<<inst>>',
      '### inst',
      'INST:',
      '<<INST>>',
      '### INST',
      'Inst:',
      '<<Inst>>',
      '### Inst',
      'instruction:',
      '<<instruction>>',
      '### instruction',
      'INSTRUCTION:',
      '<<INSTRUCTION>>',
      '### INSTRUCTION',
      'Instruction:',
      '<<Instruction>>',
      '### Instruction',
    ])
    expect(emitted).toEqual([
      { kind: 'token', content: 'clean answer' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('uses Bedrock profile credentials and request model over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        providerCredentials: [
          {
            id: 'bedrock-profile-credential',
            name: 'Bedrock profile',
            type: 'apiKey',
            apiKey: 'PROFILEAKIA:profile-secret:ap-southeast-2',
          },
        ],
        modelProfiles: [
          {
            id: 'bedrock-profile',
            name: 'Bedrock profile',
            modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
            providerOptions: {
              credentialId: 'bedrock-profile-credential',
              requestModel: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
            },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'bedrock-profile' } },
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      claudeAPIKey: 'FLATAKIA:flat-secret:us-east-1',
    } as Partial<Database>)
    const captured = captureDispatchRequests(okBedrockResponse())

    await dispatchWithProfile(
      profile,
      flatConflict,
      [
        { role: 'system', content: 'profile system 1' },
        { role: 'system', content: 'profile system 2' },
        { role: 'user', content: 'hello' },
      ],
      { stop_reason: 'end_turn' },
    )

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(
      'https://bedrock-runtime.ap-southeast-2.amazonaws.com/model/us.anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke',
    )
    expect(captured[0].headers.Authorization).toContain('Credential=PROFILEAKIA/')
    expect(captured[0].headers.Authorization).toContain('/ap-southeast-2/bedrock/aws4_request')
    expect(captured[0].headers.Authorization).not.toContain('FLATAKIA')
    expect(captured[0].headers.Authorization).not.toContain('/us-east-1/bedrock/aws4_request')
    expect(captured[0].body.anthropic_version).toBe('bedrock-2023-05-31')
    expect(captured[0].body.system).toBe('profile system 1\n\nprofile system 2')
    expect(captured[0].body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
    expect(captured[0].body.model).toBeUndefined()
  })

  it('uses the global Bedrock request-model prefix for newer profile models', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        claudeAPIKey: 'PROFILEAKIA:profile-secret:eu-central-1',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      claudeAPIKey: 'FLATAKIA:flat-secret:us-west-2',
    } as Partial<Database>)
    const captured = captureDispatchRequests(okBedrockResponse())

    await dispatchWithProfile(profile, flatConflict, undefined, { stop_reason: 'end_turn' })

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(
      'https://bedrock-runtime.eu-central-1.amazonaws.com/model/global.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke',
    )
    expect(captured[0].headers.Authorization).toContain('/eu-central-1/bedrock/aws4_request')
    expect(captured[0].body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  })

  it.each([undefined, null])(
    'does not enable a Bedrock thinking budget for the unset value %j',
    async (thinkingTokens) => {
      const database = db({
        aiModel: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
        claudeAPIKey: 'PROFILEAKIA:profile-secret:us-east-1',
        thinkingType: 'budget',
        thinkingTokens,
        temperature: 25,
      })
      const profile = resolveModelProfile({ database })
      expect(profile.runtimeOptions.thinkingTokens).toBeUndefined()
      const captured = captureDispatchRequests(okBedrockResponse())
      await dispatchWithProfile(profile, database, undefined, { stop_reason: 'end_turn' })
      expect(captured).toHaveLength(1)
      expect(captured[0].body.thinking).toBeUndefined()
      expect(captured[0].body.temperature).toBe(0.25)
    },
  )

  it('maps Bedrock thinking budget and restores the Bedrock sampler constraints', async () => {
    const database = db({
      aiModel: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
      claudeAPIKey: 'PROFILEAKIA:profile-secret:us-east-1',
      thinkingType: 'budget',
      thinkingTokens: 4096,
      temperature: 25,
      top_p: 0.8,
      top_k: 20,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureDispatchRequests(okBedrockResponse())

    await dispatchWithProfile(profile, database, undefined, { stop_reason: 'end_turn' })

    expect(captured).toHaveLength(1)
    expect(captured[0].body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
      display: 'summarized',
    })
    expect(captured[0].body.temperature).toBe(1)
    expect(captured[0].body.top_p).toBeUndefined()
    expect(captured[0].body.top_k).toBeUndefined()
  })

  it('uses Google AI Studio profile API key and request model over conflicting flat database fields', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'gemini-2.5-flash',
        google: { accessToken: 'profile-google-key', projectId: 'profile-project' },
        providerCredentials: [
          { id: 'google-profile-credential', name: 'Google profile', type: 'apiKey', apiKey: 'profile-google-key' },
        ],
        modelProfiles: [
          {
            id: 'google-profile',
            name: 'Google profile',
            modelId: 'gemini-2.5-flash',
            providerOptions: { credentialId: 'google-profile-credential', requestModel: 'gemini-profile-wire-model' },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'google-profile' } },
      } as Partial<Database>),
      lookupModelInfo: (_database, id) =>
        geminiModelInfo({
          id,
          internalID: 'models/gemini-profile-wire-model',
          provider: LLMProvider.GoogleCloud,
          format: LLMFormat.GoogleCloud,
        }),
    })
    const flatConflict = db({
      aiModel: 'gemini-2.5-pro',
      google: { accessToken: 'flat-google-key', projectId: 'flat-project' },
    } as Partial<Database>)
    const captured = captureDispatchRequests(okGeminiResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-profile-wire-model:generateContent?key=profile-google-key',
    )
    expect(captured[0].url).not.toContain('flat-google-key')
    expect(captured[0].body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
  })

  it.each([
    { flag: LLMFlags.hasImageOutput, modalities: ['TEXT', 'IMAGE'] },
    { flag: LLMFlags.hasAudioOutput, modalities: ['TEXT', 'AUDIO'] },
  ])('forces buffered Gemini dispatch and requests $modalities output for flag $flag', async ({ flag, modalities }) => {
    const database = db({
      aiModel: 'gemini-2.5-flash',
      google: { accessToken: 'profile-google-key', projectId: 'profile-project' },
      useStreaming: true,
      providerCredentials: [
        { id: 'gemini-media-credential', name: 'Gemini profile', type: 'apiKey', apiKey: 'profile-google-key' },
      ],
      modelProfiles: [
        {
          id: 'gemini-media-profile',
          name: 'Gemini media profile',
          modelId: 'gemini-2.5-flash',
          providerOptions: {
            credentialId: 'gemini-media-credential',
            requestModel: 'gemini-media-output',
            customApi: { flags: [flag] },
          },
          runtimeOptions: { useStreaming: false, enableCustomFlags: true, customFlags: [flag] },
        },
      ],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'gemini-media-profile' } },
    } as Partial<Database>)
    const profile = resolveModelProfile({
      database,
      lookupModelInfo: (_database, id) =>
        geminiModelInfo({
          id,
          internalID: 'gemini-media-output',
          flags: [flag],
        }),
    })
    const captured = captureDispatchRequests(okGeminiResponse())

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toContain(':generateContent?key=')
    expect(captured[0].url).not.toContain(':streamGenerateContent')
    expect((captured[0].body.generationConfig as Record<string, unknown>).responseModalities).toEqual(modalities)
  })

  it('leaves buffered non-output-capable Gemini requests without responseModalities', async () => {
    const database = db({
      aiModel: 'gemini-2.5-flash',
      google: { accessToken: 'profile-google-key', projectId: 'profile-project' },
      useStreaming: false,
      providerCredentials: [
        { id: 'gemini-text-credential', name: 'Gemini profile', type: 'apiKey', apiKey: 'profile-google-key' },
      ],
      modelProfiles: [
        {
          id: 'gemini-text-profile',
          name: 'Gemini text profile',
          modelId: 'gemini-2.5-flash',
          providerOptions: { credentialId: 'gemini-text-credential', requestModel: 'gemini-text-only' },
        },
      ],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'gemini-text-profile' } },
    } as Partial<Database>)
    const profile = resolveModelProfile({
      database,
      lookupModelInfo: (_database, id) => geminiModelInfo({ id, internalID: 'gemini-text-only' }),
    })
    const captured = captureDispatchRequests(okGeminiResponse())

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect((captured[0].body.generationConfig as Record<string, unknown>).responseModalities).toBeUndefined()
  })

  it('forwards Gemini model safety flags and the translated effective JSON schema', async () => {
    const database = db({
      aiModel: 'gemini-2.5-flash-lite-preview-09-2025',
      google: { accessToken: 'profile-google-key', projectId: 'profile-project' },
      jsonSchemaEnabled: true,
      jsonSchema: JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string' },
          details: {
            type: 'object',
            additionalProperties: false,
            properties: { score: { type: 'number' } },
          },
        },
        required: ['answer'],
      }),
    } as Partial<Database>)
    const profile = resolveModelProfile({
      database,
      lookupModelInfo: (_database, id) =>
        geminiModelInfo({
          id,
          internalID: 'gemini-2.5-flash-lite-preview-09-2025',
          flags: [
            LLMFlags.geminiBlockOff,
            LLMFlags.hasFirstSystemPrompt,
            LLMFlags.requiresAlternateRole,
            LLMFlags.mustStartWithUserInput,
          ],
        }),
    })
    const captured = captureDispatchRequests(okGeminiResponse())

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect(captured[0].body.safetySettings).toEqual([
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
    ])
    expect(captured[0].body.generationConfig).toMatchObject({
      response_mime_type: 'application/json',
      response_schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          details: {
            type: 'object',
            properties: { score: { type: 'number' } },
          },
        },
        required: ['answer'],
      },
    })
    expect(JSON.stringify(captured[0].body.generationConfig)).not.toContain('$schema')
    expect(JSON.stringify(captured[0].body.generationConfig)).not.toContain('additionalProperties')
  })

  it.each([
    { model: 'gemini-3.6-flash', reasoningEffort: -1, expectedLevel: 'minimal' },
    { model: 'gemini-3.1-pro-preview', reasoningEffort: -1, expectedLevel: 'low' },
    { model: 'gemini-3-flash-preview', reasoningEffort: 1, expectedLevel: 'medium' },
  ])('maps $model reasoning effort to $expectedLevel on the live Gemini path', async (testCase) => {
    const database = db({
      aiModel: testCase.model,
      google: { accessToken: 'profile-google-key', projectId: 'profile-project' },
      reasoningEffort: testCase.reasoningEffort,
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    const captured = captureDispatchRequests(okGeminiResponse())

    await dispatchWithProfile(profile, database)

    expect(captured).toHaveLength(1)
    expect((captured[0].body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingLevel: testCase.expectedLevel,
      includeThoughts: true,
    })
  })

  it.each([
    { label: 'missing', google: undefined },
    { label: 'blank', google: { accessToken: '   ', projectId: 'profile-project' } },
  ])('does not fall back to flat DB Google key when the profile key is $label', async (testCase) => {
    const profile = resolveModelProfileWithLegacyCompatibility({
      database: db({
        aiModel: 'gemini-2.5-flash',
        ...(testCase.google === undefined ? {} : { google: testCase.google }),
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'gemini-2.5-flash',
      google: { accessToken: 'flat-google-key', projectId: 'flat-project' },
    } as Partial<Database>)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, flatConflict)).rejects.toThrow(
      testCase.google === undefined
        ? 'options.gemini.apiKey or options.gemini.vertex is required'
        : 'credential-missing',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses Vertex profile service-account auth and request model over conflicting flat database fields', async () => {
    _resetVertexTokenCacheForTesting()
    const profilePrivateKey = generatePrivateKey()
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'gemini-2.5-pro-vertex',
        google: { accessToken: 'studio-key-ignored-for-vertex', projectId: 'profile-project' },
        vertexRegion: 'us-central1',
        vertexClientEmail: 'svc@profile-project.iam.gserviceaccount.com',
        vertexPrivateKey: profilePrivateKey,
        vertexAccessToken: 'cached-profile-token',
        providerCredentials: [
          {
            id: 'vertex-profile-credential',
            name: 'Vertex profile',
            type: 'vertexServiceAccount',
            vertex: { clientEmail: 'svc@profile-project.iam.gserviceaccount.com', privateKey: profilePrivateKey },
          },
        ],
        modelProfiles: [
          {
            id: 'vertex-profile',
            name: 'Vertex profile',
            modelId: 'gemini-2.5-pro-vertex',
            providerOptions: {
              credentialId: 'vertex-profile-credential',
              requestModel: 'gemini-profile-vertex-wire-model',
              vertex: { projectId: 'profile-project', region: 'us-central1' },
            },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'vertex-profile' } },
      } as Partial<Database>),
      lookupModelInfo: (_database, id) =>
        geminiModelInfo({
          id,
          internalID: 'models/gemini-profile-vertex-wire-model',
          provider: LLMProvider.VertexAI,
          format: LLMFormat.VertexAIGemini,
        }),
    })
    const flatConflict = db({
      aiModel: 'gemini-2.5-flash-vertex',
      google: { accessToken: 'flat-studio-key', projectId: 'flat-project' },
      vertexRegion: 'europe-west1',
      vertexClientEmail: 'svc@flat-project.iam.gserviceaccount.com',
      vertexPrivateKey: 'not-a-valid-flat-private-key',
      vertexAccessToken: 'flat-cached-token',
    } as Partial<Database>)
    const captured = captureVertexRequests()

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(2)
    expect(captured[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(captured[1].url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/profile-project/locations/us-central1/publishers/google/models/gemini-profile-vertex-wire-model:generateContent',
    )
    expect(captured[1].url).not.toContain('flat-project')
    expect(captured[1].url).not.toContain('europe-west1')
    expect(captured[1].headers.authorization).toBe('Bearer ya29.profile-token')

    const assertion = new URLSearchParams(captured[0].rawBody).get('assertion')
    expect(assertion).toBeTruthy()
    const jwtPayload = JSON.parse(Buffer.from(assertion!.split('.')[1], 'base64url').toString('utf8')) as {
      iss?: string
    }
    expect(jwtPayload.iss).toBe('svc@profile-project.iam.gserviceaccount.com')
  })

  it.each([
    {
      label: 'missing',
      profileDatabase: {
        aiModel: 'gemini-2.5-pro-vertex',
      } as Partial<Database>,
    },
    {
      label: 'partial',
      profileDatabase: {
        aiModel: 'gemini-2.5-pro-vertex',
        google: { accessToken: 'studio-key-ignored-for-vertex', projectId: 'profile-project' },
        vertexRegion: 'us-central1',
        vertexClientEmail: 'svc@profile-project.iam.gserviceaccount.com',
      } as Partial<Database>,
    },
  ])('does not fall back to flat DB Vertex auth when profile auth is $label', async (testCase) => {
    _resetVertexTokenCacheForTesting()
    const profile = resolveModelProfileWithLegacyCompatibility({ database: db(testCase.profileDatabase) })
    const flatConflict = db({
      aiModel: 'gemini-2.5-pro-vertex',
      google: { accessToken: 'flat-studio-key', projectId: 'flat-project' },
      vertexRegion: 'us-central1',
      vertexClientEmail: 'svc@flat-project.iam.gserviceaccount.com',
      vertexPrivateKey: generatePrivateKey(),
      vertexAccessToken: 'flat-cached-token',
    } as Partial<Database>)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, flatConflict)).rejects.toThrow(
      /(?:configuration is incomplete|vertex-(?:project-id|region|client-email|private-key)-missing)/u,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses Horde profile API key and request model over conflicting flat database fields', async () => {
    const profile = resolveModelProfileWithLegacyCompatibility({
      database: db({
        aiModel: 'horde:::profile-horde-model',
        hordeConfig: { apiKey: 'profile-horde-key', model: '', softPrompt: '' },
        instructChatTemplate: 'chatml',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'horde:::flat-horde-model',
      hordeConfig: { apiKey: 'flat-horde-key', model: '', softPrompt: '' },
      instructChatTemplate: 'gpt2',
    } as Partial<Database>)
    const captured = captureHordeRequests()

    await dispatchHordeWithProfile(profile, flatConflict)

    expect(captured.length).toBeGreaterThanOrEqual(2)
    expect(captured[0].url).toBe('https://stablehorde.net/api/v2/generate/text/async')
    expect(captured[0].headers.apikey).toBe('profile-horde-key')
    expect(captured[1].headers.apikey).toBe('profile-horde-key')
    expect(captured[0].body.models).toEqual([
      'profile-horde-model',
      'profile-horde-model',
      ' profile-horde-model',
      'profile-horde-model ',
    ])
  })

  it.each([
    {
      template: 'chatml',
      expected:
        '<|im_start|>system\nrules<|im_end|>\n<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\nprior<|im_end|>\n<|im_start|>assistant\n',
    },
    {
      template: 'llama3',
      expected: 'system: rules\n\nuser: hello\n\nassistant: prior\n\nassistant:',
    },
  ])('pins Horde $template legacy-template output', async ({ template, expected }) => {
    // Accepted divergence (PR-18/PR-7 sunset): do not port baseline
    // `src/ts/process/templates/chatTemplate.ts`; pin ChatML and the generic fallback.
    const database = db({
      aiModel: 'horde:::profile-horde-model',
      hordeConfig: { apiKey: 'profile-horde-key', model: '', softPrompt: '' },
      instructChatTemplate: template,
    } as Partial<Database>)
    const profile = resolveModelProfileWithLegacyCompatibility({ database })
    const captured = captureHordeRequests()

    await dispatchHordeWithProfile(profile, database, [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'prior' },
    ])

    expect(captured[0].body.prompt).toBe(expected)
  })

  it('cleans Horde output with the effective character instead of characters[0]', async () => {
    vi.useFakeTimers()
    const database = db({
      aiModel: 'horde:::profile-horde-model',
      hordeConfig: { apiKey: 'profile-horde-key', model: '', softPrompt: '' },
      instructChatTemplate: 'chatml',
      currentChar: 0,
      characters: [{ name: 'Wrong First Character' }, { name: 'Active Character' }],
    } as unknown as Partial<Database>)
    const profile = resolveModelProfileWithLegacyCompatibility({ database })
    captureHordeRequests('clean result\nActive Character: trailing role text')
    const source = await dispatchChatProvider({
      database,
      profile,
      formated: [{ role: 'user', content: 'hello' }],
      currentCharacterName: 'Active Character',
      signal: new AbortController().signal,
    })
    const emittedPromise = (async () => {
      const emitted = []
      for await (const frame of source) emitted.push(frame)
      return emitted
    })()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(emittedPromise).resolves.toEqual([
      { kind: 'token', content: 'clean result' },
      { kind: 'done', finishReason: 'stop', apiMetadata: { jobId: 'profile-horde-job' } },
    ])
  })

  it('preserves impossible Horde job non-retryability on the provider failure frame', async () => {
    vi.useFakeTimers()
    const database = db({
      aiModel: 'horde:::profile-horde-model',
      hordeConfig: { apiKey: 'profile-horde-key', model: '', softPrompt: '' },
      instructChatTemplate: 'chatml',
    } as Partial<Database>)
    const profile = resolveModelProfileWithLegacyCompatibility({ database })
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/generate/text/async')) {
        return new Response(JSON.stringify({ id: 'impossible-job' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (String(url).endsWith('/generate/text/status/impossible-job') && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ is_possible: false, done: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (init?.method === 'DELETE') return new Response('{}', { status: 200 })
      throw new Error(`unexpected Horde URL: ${String(url)}`)
    })

    const source = await dispatchChatProvider({
      database,
      profile,
      formated: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    })
    const emittedPromise = (async () => {
      const emitted = []
      for await (const frame of source) emitted.push(frame)
      return emitted
    })()
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(emittedPromise).resolves.toEqual([
      { kind: 'error', error: 'horde reports the job is not possible', nonRetryable: true },
    ])
  })

  it('uses the anonymous Horde key when the profile key is blank despite a flat DB key', async () => {
    const profile = resolveModelProfileWithLegacyCompatibility({
      database: db({
        aiModel: 'horde:::profile-horde-model',
        hordeConfig: { apiKey: '   ', model: '', softPrompt: '' },
        instructChatTemplate: 'chatml',
        modelRoleProfiles: {},
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'horde:::flat-horde-model',
      hordeConfig: { apiKey: 'flat-horde-key', model: '', softPrompt: '' },
      instructChatTemplate: 'gpt2',
    } as Partial<Database>)
    const captured = captureHordeRequests()

    await dispatchHordeWithProfile(profile, flatConflict)

    expect(captured.length).toBeGreaterThanOrEqual(2)
    expect(captured[0].headers.apikey).toBe('0000000000')
    expect(captured[1].headers.apikey).toBe('0000000000')
    expect(captured[0].body.models).toEqual([
      'profile-horde-model',
      'profile-horde-model',
      ' profile-horde-model',
      'profile-horde-model ',
    ])
  })

  it('omits the OobaLegacy API key when the profile key is blank despite a flat DB key', async () => {
    const profile = resolveModelProfileWithLegacyCompatibility({
      database: db({
        aiModel: 'mancer',
        textgenWebUIBlockingURL: 'http://profile-ooba.example.com/api/v1/blocking',
        mancerHeader: '   ',
        modelRoleProfiles: {},
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'mancer',
      textgenWebUIBlockingURL: 'http://flat-ooba.example.com/api/v1/blocking',
      mancerHeader: 'flat-mancer-key',
    } as Partial<Database>)
    const captured = captureDispatchRequests(okOobaLegacyResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('http://profile-ooba.example.com/api/v1/generate')
    expect(captured[0].headers['X-API-KEY']).toBeUndefined()
  })

  it.each([
    { label: 'missing', claudeAPIKey: undefined },
    { label: 'blank', claudeAPIKey: '   ' },
  ])('does not fall back to flat DB Bedrock credentials when the profile key is $label', async (testCase) => {
    const profileDatabase: Partial<Database> = {
      aiModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    }
    if (testCase.claudeAPIKey !== undefined) {
      profileDatabase.claudeAPIKey = testCase.claudeAPIKey
    }
    const profile = resolveModelProfile({ database: db(profileDatabase) })
    const flatConflict = db({
      aiModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      claudeAPIKey: 'FLATAKIA:flat-secret:us-east-1',
    } as Partial<Database>)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, flatConflict)).rejects.toThrow(
      /(?:configuration is incomplete|credential-missing)/u,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects malformed Bedrock profile credentials before fetch', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        claudeAPIKey: 'PROFILEAKIA:profile-secret:ap-southeast-2:extra',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      claudeAPIKey: 'FLATAKIA:flat-secret:us-east-1',
    } as Partial<Database>)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, flatConflict)).rejects.toThrow(
      'The key assigned to this request is invalid.',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a masked Bedrock marker if it reaches server dispatch authority', async () => {
    const database = db({
      aiModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      claudeAPIKey: MASKED_PROVIDER_SECRET,
    } as Partial<Database>)
    const profile = resolveModelProfile({
      database,
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, database)).rejects.toThrow('The key assigned to this request is invalid.')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves the native Ollama missing-URL error and does not fall back to flat DB URL', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'ollama-hosted',
        ollamaModel: 'profile-llama',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'ollama-hosted',
      ollamaURL: 'http://flat-ollama.example.com',
      ollamaModel: 'flat-llama',
    } as Partial<Database>)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, flatConflict)).rejects.toThrow('options.ollama.baseUrl is required')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves the Kobold missing-URL error and does not fall back to flat DB URL', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'kobold',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'kobold',
      koboldURL: 'http://flat-kobold.example.com',
    } as Partial<Database>)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, flatConflict)).rejects.toThrow('options.kobold.baseUrl is required')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves the OobaLegacy missing-URL error and does not fall back to flat DB URL', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'mancer',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'mancer',
      textgenWebUIBlockingURL: 'http://flat-ooba.example.com/api/v1/blocking',
      mancerHeader: 'flat-mancer-key',
    } as Partial<Database>)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, flatConflict)).rejects.toThrow(
      'options["ooba-legacy"].baseUrl is required',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('derives Cohere safety mode from the profile model id instead of flat aiModel', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'cohere-command-r-03-2024',
        cohereAPIKey: 'sk-profile-cohere',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'cohere-command-r',
      cohereAPIKey: 'sk-flat-cohere',
    } as Partial<Database>)
    const captured = captureDispatchRequests(okCohereResponse())

    await dispatchWithProfile(profile, flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].headers.authorization).toBe('Bearer sk-profile-cohere')
    expect(captured[0].body.model).toBe('cohere-command-r-03-2024')
    expect(captured[0].body.safety_mode).toBeUndefined()
  })

  it.each([
    {
      label: 'OpenRouter',
      profileDatabase: db({
        aiModel: 'openrouter',
        openrouterKey: 'sk-profile-openrouter',
        openrouterRequestModel: 'profile/provider-model',
      } as Partial<Database>),
      flatConflict: db({
        aiModel: 'openrouter',
        openrouterKey: 'sk-flat-openrouter',
        openrouterRequestModel: 'flat/provider-model',
      } as Partial<Database>),
      expectedUrl: 'https://openrouter.ai/api/v1/chat/completions',
      expectedAuthorization: 'Bearer sk-profile-openrouter',
      expectedModel: 'profile/provider-model',
      expectedHeader: ['X-Title', 'RisuAI'] as const,
    },
    {
      label: 'NanoGPT',
      profileDatabase: db({
        aiModel: 'nanogpt',
        nanogptKey: 'sk-profile-nano',
        nanogptRequestModel: 'profile/nano-model',
        nanogptProvider: 'profile-provider',
        nanogptUseSubscriptionEndpoint: true,
      } as Partial<Database>),
      flatConflict: db({
        aiModel: 'nanogpt',
        nanogptKey: 'sk-flat-nano',
        nanogptRequestModel: 'flat/nano-model',
        nanogptProvider: 'flat-provider',
        nanogptUseSubscriptionEndpoint: false,
      } as Partial<Database>),
      expectedUrl: 'https://nano-gpt.com/api/subscription/v1/chat/completions',
      expectedAuthorization: 'Bearer sk-profile-nano',
      expectedModel: 'profile/nano-model',
      expectedHeader: ['X-Provider', 'profile-provider'] as const,
    },
  ])('uses $label profile options over conflicting flat fields', async (testCase) => {
    const profile = resolveModelProfile({ database: testCase.profileDatabase })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, testCase.flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(testCase.expectedUrl)
    expect(captured[0].headers.authorization).toBe(testCase.expectedAuthorization)
    expect(captured[0].headers[testCase.expectedHeader[0]]).toBe(testCase.expectedHeader[1])
    expect(captured[0].body.model).toBe(testCase.expectedModel)
  })

  it.each([
    {
      label: 'xcustom OpenAI-compatible',
      profileDatabase: db({
        aiModel: 'xcustom:::profile-openai',
        customModels: [
          {
            id: 'xcustom:::profile-openai',
            name: 'Profile Custom',
            internalId: 'profile-xcustom-model',
            url: 'https://profile-custom.example.com/v1/chat/completions',
            key: 'sk-profile-xcustom',
            format: LLMFormat.OpenAICompatible,
            tokenizer: 0,
            flags: [],
            params: 'header::X-Profile=profile\nprofileFlag=true',
          },
        ] as Database['customModels'],
      } as Partial<Database>),
      flatConflict: db({
        aiModel: 'xcustom:::profile-openai',
        customModels: [
          {
            id: 'xcustom:::profile-openai',
            name: 'Flat Custom',
            internalId: 'flat-xcustom-model',
            url: 'https://flat-custom.example.com/v1/chat/completions',
            key: 'sk-flat-xcustom',
            format: LLMFormat.OpenAICompatible,
            tokenizer: 0,
            flags: [],
            params: 'header::X-Flat=flat\nflatFlag=true',
          },
        ] as Database['customModels'],
      } as Partial<Database>),
      expectedUrl: 'https://profile-custom.example.com/v1/chat/completions',
      expectedAuthorization: 'Bearer sk-profile-xcustom',
      expectedModel: 'profile-xcustom-model',
      expectedHeader: ['X-Profile', 'profile'] as const,
      expectedBodyField: ['profileFlag', true] as const,
      absentHeader: 'X-Flat',
      absentBodyField: 'flatFlag',
    },
    {
      label: 'key-identifier OpenAI-compatible',
      profileDatabase: db({
        aiModel: 'deepseek-chat',
        OaiCompAPIKeys: { deepseek: 'sk-profile-deepseek' },
      } as Partial<Database>),
      flatConflict: db({
        aiModel: 'deepseek-chat',
        OaiCompAPIKeys: { deepseek: 'sk-flat-deepseek' },
      } as Partial<Database>),
      expectedUrl: 'https://api.deepseek.com/beta/chat/completions',
      expectedAuthorization: 'Bearer sk-profile-deepseek',
      expectedModel: 'deepseek-chat',
    },
    {
      label: 'ollama-cloud OpenAI-compatible',
      profileDatabase: db({
        aiModel: 'ollama-cloud',
        ollamaApiKey: 'sk-profile-ollama',
        ollamaRequestFormat: LLMFormat.OpenAICompatible,
        ollamaCloudModel: 'profile-ollama-cloud-model',
      } as Partial<Database>),
      flatConflict: db({
        aiModel: 'ollama-cloud',
        ollamaApiKey: 'sk-flat-ollama',
        ollamaRequestFormat: LLMFormat.OpenAICompatible,
        ollamaCloudModel: 'flat-ollama-cloud-model',
      } as Partial<Database>),
      expectedUrl: 'https://ollama.com/v1/chat/completions',
      expectedAuthorization: 'Bearer sk-profile-ollama',
      expectedModel: 'profile-ollama-cloud-model',
    },
  ])('uses $label profile options on the OpenAI branch', async (testCase) => {
    const profile =
      testCase.label === 'xcustom OpenAI-compatible'
        ? resolveModelProfileWithLegacyCompatibility({ database: testCase.profileDatabase })
        : resolveModelProfile({ database: testCase.profileDatabase })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, testCase.flatConflict)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(testCase.expectedUrl)
    expect(captured[0].headers.authorization).toBe(testCase.expectedAuthorization)
    expect(captured[0].body.model).toBe(testCase.expectedModel)
    if (testCase.expectedHeader) {
      expect(captured[0].headers[testCase.expectedHeader[0]]).toBe(testCase.expectedHeader[1])
    }
    if (testCase.expectedBodyField) {
      expect(captured[0].body[testCase.expectedBodyField[0]]).toBe(testCase.expectedBodyField[1])
    }
    if (testCase.absentHeader) {
      expect(captured[0].headers[testCase.absentHeader]).toBeUndefined()
    }
    if (testCase.absentBodyField) {
      expect(captured[0].body[testCase.absentBodyField]).toBeUndefined()
    }
  })

  it('carries the DeepSeek embedded-thinking output flag into the OpenAI parser', async () => {
    const database = db({
      aiModel: 'deepseek-reasoner',
      OaiCompAPIKeys: { deepseek: 'sk-deepseek' },
    } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    captureDispatchRequests(okOpenAIResponse('<think>private reasoning</think>visible answer'))

    const frames = await dispatchChatProvider({
      database,
      profile,
      formated: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    })
    const emitted = []
    for await (const frame of frames) emitted.push(frame)

    expect(profile.modelInfo.flags).toContain(LLMFlags.deepSeekThinkingOutput)
    expect(emitted).toEqual([
      { kind: 'token', content: '<Thoughts>\nprivate reasoning\n</Thoughts>\nvisible answer' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('allows first-class Custom API profiles without an API key', async () => {
    const profile = resolveModelProfile({
      database: db({
        modelProfiles: [
          {
            id: 'custom-api-profile',
            name: 'Custom API',
            providerId: 'custom-api',
            modelId: 'custom-api',
            providerOptions: {
              baseUrl: 'https://profile-custom.example.com/v1',
              requestModel: 'profile-custom-model',
              extraHeaders: { 'X-Profile': 'custom' },
            },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'custom-api-profile' } },
      } as unknown as Partial<Database>),
    })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(
      profile,
      db({
        aiModel: 'reverse_proxy',
        forceReplaceUrl: 'https://flat-custom.example.com/v1',
        proxyKey: 'sk-flat-custom',
        customProxyRequestModel: 'flat-custom-model',
      } as Partial<Database>),
    )

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://profile-custom.example.com/v1/chat/completions')
    expect(captured[0].headers.authorization).toBeUndefined()
    expect(captured[0].headers['X-Profile']).toBe('custom')
    expect(captured[0].body.model).toBe('profile-custom-model')
  })

  it('dispatches first-class LLM Gateway profiles through its fixed OpenAI-compatible endpoint', async () => {
    const profile = resolveModelProfile({
      database: db({
        providerCredentials: [{ id: 'credential-gateway', name: 'LLM Gateway', type: 'apiKey', apiKey: 'sk-gateway' }],
        modelProfiles: [
          {
            id: 'llmgateway-profile',
            name: 'LLM Gateway',
            providerId: 'llmgateway',
            modelId: 'gpt-4o-mini',
            providerOptions: {
              credentialId: 'credential-gateway',
              baseUrl: 'https://attacker.example/v1',
              llmGateway: {
                reasoningEffort: 'max',
                verbosity: 'high',
                serviceTier: 'priority',
                routing: 'throughput',
              },
            },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'llmgateway-profile' } },
      } as unknown as Partial<Database>),
    })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(
      profile,
      db({ openAIKey: 'flat-openai-key', openAIFlexProcessing: true } as Partial<Database>),
    )

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://api.llmgateway.io/v1/chat/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-gateway')
    expect(captured[0].body.model).toBe('gpt-4o-mini')
    expect(captured[0].body.reasoning_effort).toBe('max')
    expect(captured[0].body.verbosity).toBe('high')
    expect(captured[0].body.service_tier).toBe('priority')
    expect(captured[0].body.routing).toBe('throughput')
  })

  it('dispatches first-class Neuralwatt profiles through its fixed OpenAI-compatible endpoint', async () => {
    const profile = resolveModelProfile({
      database: db({
        providerCredentials: [
          { id: 'credential-neuralwatt', name: 'Neuralwatt', type: 'apiKey', apiKey: 'sk-neuralwatt' },
        ],
        modelProfiles: [
          {
            id: 'neuralwatt-profile',
            name: 'Neuralwatt',
            providerId: 'neuralwatt',
            modelId: 'gemma-4-31b',
            providerOptions: {
              credentialId: 'credential-neuralwatt',
              baseUrl: 'https://attacker.example/v1',
            },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'neuralwatt-profile' } },
      } as unknown as Partial<Database>),
    })
    const captured = captureOpenAIRequests()

    await dispatchWithProfile(profile, db({ openAIKey: 'flat-openai-key' } as Partial<Database>))

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://api.neuralwatt.com/v1/chat/completions')
    expect(captured[0].headers.authorization).toBe('Bearer sk-neuralwatt')
    expect(captured[0].body.model).toBe('gemma-4-31b')
  })

  it('returns the final input content as-is for first-class Debug Echo profiles', async () => {
    const profile = resolveModelProfile({
      database: db({
        modelProfiles: [
          {
            id: 'debug-echo-profile',
            name: 'Debug Echo',
            providerId: 'debug-echo',
            modelId: 'debug-echo',
            providerOptions: {
              baseUrl: 'debug://profile-base',
              requestModel: 'profile-debug-model',
            },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'debug-echo-profile' } },
      } as unknown as Partial<Database>),
    })
    const expectedContent = '  exact input\ncontent  '
    const controller = new AbortController()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    try {
      const frames = await dispatchChatProvider({
        database: db({
          aiModel: 'echo_model',
          echoMessage: 'flat echo should not leak',
          echoDelay: 60,
          applyAdditionalParamsToAll: true,
          additionalParams: [['message', 'additional params should not replace the input']],
        } as Partial<Database>),
        profile,
        formated: [
          { role: 'system', content: 'do not echo this' },
          { role: 'assistant', content: 'or this' },
          { role: 'user', content: expectedContent },
        ],
        signal: controller.signal,
      })
      expect(setTimeoutSpy).not.toHaveBeenCalled()

      const emitted = []
      for await (const frame of frames) {
        emitted.push(frame)
      }

      expect(emitted).toEqual([
        {
          kind: 'token',
          content: expectedContent,
        },
        { kind: 'done', finishReason: 'stop' },
      ])
    } finally {
      controller.abort()
      setTimeoutSpy.mockRestore()
    }
  })

  it.each([
    {
      label: 'incomplete official OpenAI profile',
      database: db({
        modelProfiles: [
          {
            id: 'openai-missing-key',
            name: 'OpenAI Missing Key',
            providerId: 'openai',
            modelId: 'gpt-5',
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'openai-missing-key' } },
      } as unknown as Partial<Database>),
      reason: 'api-key-missing',
    },
    {
      label: 'unsupported provider id profile',
      database: db({
        modelProfiles: [
          {
            id: 'unsupported-provider',
            name: 'Unsupported Provider',
            providerId: 'not-a-provider',
            modelId: 'gpt-5',
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'unsupported-provider' } },
      } as unknown as Partial<Database>),
      reason: 'unsupported-provider-id',
    },
  ])('rejects $label before provider fetch', async (testCase) => {
    const profile = resolveModelProfile({ database: testCase.database })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, testCase.database)).rejects.toThrow(testCase.reason)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves the NanoGPT missing-key error and does not fall back to flat DB keys', async () => {
    const profile = resolveModelProfile({
      database: db({
        aiModel: 'nanogpt',
        nanogptRequestModel: 'profile/nano-model',
      } as Partial<Database>),
    })
    const flatConflict = db({
      aiModel: 'nanogpt',
      nanogptKey: 'sk-flat-nano',
      nanogptRequestModel: 'flat/nano-model',
    } as Partial<Database>)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, flatConflict)).rejects.toThrow('options.nanogpt.apiKey is required')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'Anthropic',
      profileDatabase: db({
        aiModel: 'claude-3-5-sonnet-20241022',
      } as Partial<Database>),
      flatConflict: db({
        aiModel: 'claude-3-5-sonnet-20241022',
        claudeAPIKey: 'sk-flat-anthropic',
      } as Partial<Database>),
      error: 'options.anthropic.apiKey is required',
    },
    {
      label: 'Mistral',
      profileDatabase: db({
        aiModel: 'mistral-large-latest',
      } as Partial<Database>),
      flatConflict: db({
        aiModel: 'mistral-large-latest',
        mistralKey: 'sk-flat-mistral',
      } as Partial<Database>),
      error: 'options.mistral.apiKey is required',
    },
    {
      label: 'Cohere',
      profileDatabase: db({
        aiModel: 'cohere-command-r',
      } as Partial<Database>),
      flatConflict: db({
        aiModel: 'cohere-command-r',
        cohereAPIKey: 'sk-flat-cohere',
      } as Partial<Database>),
      error: 'options.cohere.apiKey is required',
    },
  ])('preserves the $label missing-key error and does not fall back to flat DB keys', async (testCase) => {
    const profile = resolveModelProfile({ database: testCase.profileDatabase })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(dispatchWithProfile(profile, testCase.flatConflict)).rejects.toThrow(testCase.error)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('getServerGenerationModelString', () => {
  it.each([
    {
      database: db({
        aiModel: 'reverse_proxy',
        reverseProxyOobaMode: false,
        customProxyRequestModel: 'reverse/model',
      } as Partial<Database>),
      expected: 'custom-reverse/model',
    },
    {
      database: db({ aiModel: 'openrouter', openrouterRequestModel: 'openrouter/model' } as Partial<Database>),
      expected: 'openrouter-openrouter/model',
    },
    {
      database: db({
        aiModel: 'nanogpt',
        nanogptRequestModel: 'nano/model',
        nanogptRequestModelName: 'Nano Label',
        nanogptUseSubscriptionEndpoint: true,
      } as Partial<Database>),
      expected: 'NanoGPT Nano Label [SUB]',
    },
    {
      database: db({
        aiModel: 'ollama-hosted',
        ollamaModel: 'ollama/model',
        ollamaModelName: 'Ollama Label',
      } as Partial<Database>),
      expected: 'Ollama Local Ollama Label',
    },
    {
      database: db({
        aiModel: 'ollama-cloud',
        ollamaCloudModel: 'cloud/model',
        ollamaCloudModelName: 'Cloud Label',
      } as Partial<Database>),
      expected: 'Ollama Cloud Cloud Label',
    },
  ])('ports the baseline provider label for $expected', ({ database, expected }) => {
    const legacyDatabase = { ...database, modelProfiles: [], modelRoleProfiles: {} } as Database
    expect(
      getServerGenerationModelString(
        legacyDatabase,
        resolveModelProfileWithLegacyCompatibility({ database: legacyDatabase }),
      ),
    ).toBe(expected)
  })

  it('uses a durable selected profile request model without dropping the provider prefix', () => {
    const database = db({ aiModel: 'openrouter', openrouterRequestModel: 'flat/model' } as Partial<Database>)
    const profile = resolveModelProfile({ database })
    profile.source = { ...profile.source, kind: 'durable-profile' }
    profile.requestModel = 'profile/model'

    expect(getServerGenerationModelString(database, profile)).toBe('openrouter-profile/model')
  })
})
