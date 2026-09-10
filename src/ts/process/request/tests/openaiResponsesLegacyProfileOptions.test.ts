import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const globalFetchMock = vi.hoisted(() => vi.fn())

vi.mock('src/ts/globalApi.svelte', () => {
  class AppendableBuffer {
    buffer = new Uint8Array()
    append = vi.fn()
  }

  return {
    AppendableBuffer,
    addFetchLog: vi.fn(),
    downloadFile: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: {
      getItem: vi.fn(),
      keys: vi.fn(async () => []),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    },
    globalFetch: globalFetchMock,
    openURL: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(),
    saveAssets: vi.fn(async () => []),
    textifyReadableStream: vi.fn(),
  }
})

vi.mock('../../../globalApi.svelte', () => {
  class AppendableBuffer {
    buffer = new Uint8Array()
    append = vi.fn()
  }

  return {
    AppendableBuffer,
    addFetchLog: vi.fn(),
    downloadFile: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: {
      getItem: vi.fn(),
      keys: vi.fn(async () => []),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    },
    globalFetch: globalFetchMock,
    openURL: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(),
    saveAssets: vi.fn(async () => []),
    textifyReadableStream: vi.fn(),
  }
})

vi.mock('../../modules', async (importActual) => {
  const actual = await importActual<typeof import('../../modules')>()
  return {
    ...actual,
    getModuleMcps: () => [],
    getModuleToggles: () => '',
    getModuleTriggers: () => [],
    moduleUpdate: () => {},
  }
})

import { resolveModelProfile, type ResolvedModelProfile } from '../../../model/modelProfileResolver'
import type { ModelProfileRecord } from '../../../model/modelProfileRecords'
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, OpenAIParameters, type LLMModel } from '../../../model/types'
import { setDatabase, type Database } from '../../../storage/database.svelte'
import { requestOpenAILegacyInstruct, requestOpenAIResponseAPI } from '../openAI/requests'
import type { RequestDataArgumentExtended } from '../request'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

interface PreviewPayload {
  url: string
  body: Record<string, any>
  headers: Record<string, string>
}

function db(overrides: Partial<Database> = {}): Database {
  return {
    aiModel: 'gpt-5-response-api',
    subModel: 'gpt-5-mini',
    modelRoles: {},
    seperateModelsForAxModels: false,
    seperateModels: {},
    fallbackModels: {},
    customModels: [],
    modelTools: [],
    temperature: 50,
    frequencyPenalty: -1000,
    PresensePenalty: -1000,
    maxContext: 8192,
    maxResponse: 512,
    useStreaming: false,
    genTime: 1,
    extractJson: '',
    OaiCompAPIKeys: {},
    openrouterProvider: { order: [], only: [], ignore: [] },
    localNetworkMode: false,
    gptVisionQuality: 'auto',
    newOAIHandle: false,
    ...overrides,
  } as unknown as Database
}

function modelInfo(overrides: Partial<LLMModel>): LLMModel {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider: LLMProvider.OpenAI,
    format: LLMFormat.OpenAIResponseAPI,
    flags: [LLMFlags.hasFullSystemPrompt],
    parameters: OpenAIParameters,
    tokenizer: LLMTokenizer.Unknown,
    ...overrides,
  }
}

function resolveDurableProfile(
  database: Database,
  record: Omit<ModelProfileRecord, 'id' | 'name'>,
  apiKey?: string,
  lookupModelInfo?: (database: Database, modelId: string) => LLMModel | null | undefined,
): ResolvedModelProfile {
  const profileId = 'request-profile'
  const credentialId = apiKey ? 'request-profile-credential' : undefined
  const durableDatabase = {
    ...database,
    providerCredentials: apiKey
      ? [{ id: credentialId, name: 'Request profile credential', type: 'apiKey', apiKey }]
      : database.providerCredentials,
    modelProfiles: [
      {
        id: profileId,
        name: 'Request profile',
        ...record,
        providerOptions: {
          ...(record.providerOptions ?? {}),
          ...(credentialId ? { credentialId } : {}),
        },
      },
    ],
    modelRoleProfiles: { chatMain: { mode: 'profile', profileId } },
  } as unknown as Database
  return resolveModelProfile({ database: durableDatabase, lookupModelInfo })
}

function makeArg(
  profile: ResolvedModelProfile,
  overrides: Partial<RequestDataArgumentExtended> = {},
): RequestDataArgumentExtended {
  return {
    database: getDatabase(),
    formated: [
      { role: 'system', content: 'profile system' },
      { role: 'user', content: 'hello' },
    ],
    bias: {},
    biasString: [],
    aiModel: profile.modelId,
    maxTokens: 64,
    useStreaming: false,
    previewBody: true,
    mode: 'model',
    modelInfo: profile.modelInfo,
    resolvedProfile: profile,
    ...overrides,
  } as RequestDataArgumentExtended
}

async function previewResponse(arg: RequestDataArgumentExtended): Promise<PreviewPayload> {
  const result = await requestOpenAIResponseAPI(arg)
  expect(result.type).toBe('success')
  if (typeof result.result !== 'string') throw new Error('Expected preview body string')
  return JSON.parse(result.result) as PreviewPayload
}

async function previewLegacy(arg: RequestDataArgumentExtended): Promise<PreviewPayload> {
  const result = await requestOpenAILegacyInstruct(arg)
  expect(result.type).toBe('success')
  if (typeof result.result !== 'string') throw new Error('Expected preview body string')
  return JSON.parse(result.result) as PreviewPayload
}

beforeEach(() => {
  globalFetchMock.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('requestOpenAIResponseAPI profile provider options', () => {
  it('uses reverse_proxy profile URL, key, request model, additional params, and risu header over flat DB conflicts', async () => {
    const profile = resolveDurableProfile(
      db({
        aiModel: 'reverse_proxy',
        customAPIFormat: LLMFormat.OpenAIResponseAPI,
      } as Partial<Database>),
      {
        providerId: 'custom-api',
        modelId: 'custom-api',
        providerOptions: {
          baseUrl: 'https://profile.proxy.example/v1',
          requestModel: 'profile-responses-model',
          extraHeaders: { 'X-Proxy-Risu': 'RisuAI' },
          additionalParams: [
            ['profile_param', '"from-profile"'],
            ['header::X-Profile-Param', 'profile-header'],
          ],
        },
      },
      'sk-profile-proxy',
      () =>
        modelInfo({
          id: 'custom-api',
          internalID: 'profile-responses-model',
          provider: LLMProvider.AsIs,
          format: LLMFormat.OpenAIResponseAPI,
        }),
    )
    setDatabase(
      db({
        aiModel: 'reverse_proxy',
        customAPIFormat: LLMFormat.OpenAIResponseAPI,
        forceReplaceUrl: 'risu::https://flat.proxy.example/v1',
        proxyKey: 'sk-flat-proxy',
        customProxyRequestModel: 'flat-responses-model',
        additionalParams: [
          ['flat_param', '"from-flat"'],
          ['header::X-Flat-Param', 'flat-header'],
        ],
      } as Partial<Database>),
    )

    const payload = await previewResponse(
      makeArg(profile, {
        customURL: getDatabase().forceReplaceUrl,
        key: 'sk-flat-arg-proxy',
      }),
    )

    expect(payload.url).toBe('https://profile.proxy.example/v1/responses')
    expect(payload.headers.Authorization).toBe('Bearer sk-profile-proxy')
    expect(payload.headers['X-Proxy-Risu']).toBe('RisuAI')
    expect(payload.headers['X-Profile-Param']).toBe('profile-header')
    expect(payload.headers['X-Flat-Param']).toBeUndefined()
    expect(payload.body.model).toBe('profile-responses-model')
    expect(payload.body.profile_param).toBe('from-profile')
    expect(payload.body.flat_param).toBeUndefined()
  })

  it('uses ollama-cloud profile API key, request model, and Responses base URL over flat conflicts', async () => {
    const profile = resolveDurableProfile(
      db({ aiModel: 'ollama-cloud' } as Partial<Database>),
      {
        providerId: 'ollama',
        modelId: 'ollama-cloud',
        providerOptions: {
          requestModel: 'profile-ollama-responses',
          ollama: { requestFormat: LLMFormat.OpenAIResponseAPI, modelSource: 'cloud' },
        },
      },
      'sk-profile-ollama',
    )
    setDatabase(
      db({
        aiModel: 'ollama-cloud',
        ollamaApiKey: 'sk-flat-ollama',
        ollamaRequestFormat: LLMFormat.OpenAIResponseAPI,
        ollamaCloudModel: 'flat-ollama-responses',
        ollamaModelSource: 'cloud',
      } as Partial<Database>),
    )

    const payload = await previewResponse(
      makeArg(profile, {
        customURL: 'https://flat.ollama.example/v1/responses',
        key: 'sk-flat-arg-ollama',
        modelInfo: modelInfo({
          id: 'ollama-cloud',
          internalID: 'flat-ollama-wire',
          provider: LLMProvider.Ollama,
          format: LLMFormat.OpenAIResponseAPI,
        }),
      }),
    )

    expect(payload.url).toBe('https://ollama.com/v1/responses')
    expect(payload.headers.Authorization).toBe('Bearer sk-profile-ollama')
    expect(payload.body.model).toBe('profile-ollama-responses')
    expect(payload.body.store).toBeUndefined()
  })

  it('uses profile runtime modelTools for hosted search over conflicting flat DB tools', async () => {
    const profile = resolveDurableProfile(
      db({ aiModel: 'gpt-5-response-api' } as Partial<Database>),
      {
        providerId: 'openai',
        modelId: 'gpt-5-response-api',
        runtimeOptions: { modelTools: ['search'] },
      },
      'sk-profile-openai',
    )
    setDatabase(
      db({
        aiModel: 'gpt-5-response-api',
        openAIKey: 'sk-flat-openai',
        modelTools: [],
      } as Partial<Database>),
    )
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      data: {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'searched with profile tools' }],
          },
        ],
      },
      headers: {},
      status: 200,
    })

    const result = await requestOpenAIResponseAPI(makeArg(profile, { previewBody: false }))

    expect(result).toEqual({ type: 'success', result: 'searched with profile tools' })
    expect(globalFetchMock).toHaveBeenCalledTimes(1)
    const [, requestOptions] = globalFetchMock.mock.calls[0] as [
      string,
      { body: Record<string, any>; headers: Record<string, string> },
    ]
    expect(requestOptions.headers.Authorization).toBe('Bearer sk-profile-openai')
    expect(requestOptions.body.tools).toEqual([{ type: 'web_search_preview' }])
  })

  it('preserves Responses JSON schema formatting and configured extraction on the retained client path', async () => {
    const schema =
      '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}'
    const database = db({
      aiModel: 'gpt-5-response-api',
      openAIKey: 'sk-profile-openai',
      jsonSchemaEnabled: true,
      jsonSchema: schema,
      strictJsonSchema: true,
      extractJson: 'answer',
    } as Partial<Database>)
    const profile = resolveDurableProfile(
      database,
      {
        providerId: 'openai',
        modelId: 'gpt-5-response-api',
        runtimeOptions: { jsonSchemaEnabled: true, jsonSchema: schema, extractJson: 'answer' },
      },
      'sk-profile-openai',
    )
    setDatabase(database)

    const preview = await previewResponse(makeArg(profile, { schema, extractJson: 'answer' }))
    expect(preview.body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'format',
        strict: true,
        schema: JSON.parse(schema),
      },
    })

    globalFetchMock.mockResolvedValueOnce({ ok: true, data: { output_text: '{"answer":"extracted"}' } })
    await expect(
      requestOpenAIResponseAPI(makeArg(profile, { previewBody: false, schema, extractJson: 'answer' })),
    ).resolves.toEqual({ type: 'success', result: 'extracted' })
  })

  function setupTerminalResponseProfile(): ResolvedModelProfile {
    const profile = resolveDurableProfile(
      db({ aiModel: 'gpt-5-response-api' } as Partial<Database>),
      { providerId: 'openai', modelId: 'gpt-5-response-api' },
      'sk-profile-openai',
    )
    setDatabase(db({ aiModel: 'gpt-5-response-api', openAIKey: 'sk-flat-openai' } as Partial<Database>))
    return profile
  }

  it('parses buffered reasoning content', async () => {
    const profile = setupTerminalResponseProfile()
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      data: {
        output: [
          { id: 'rs_stale', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'reasoned' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
        ],
      },
    })

    await expect(requestOpenAIResponseAPI(makeArg(profile, { previewBody: false }))).resolves.toEqual({
      type: 'success',
      result: '<Thoughts>\n\nreasoned\n\n</Thoughts>\nanswer',
    })
  })

  it('rejects an incomplete buffered response', async () => {
    const profile = setupTerminalResponseProfile()
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      data: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'partial' },
    })

    await expect(requestOpenAIResponseAPI(makeArg(profile, { previewBody: false }))).resolves.toEqual({
      type: 'fail',
      result: 'Incomplete response: max_output_tokens\npartial',
    })
  })

  it('rejects a failed buffered response', async () => {
    const profile = setupTerminalResponseProfile()
    globalFetchMock.mockResolvedValueOnce({ ok: true, data: { status: 'failed', error: { message: 'bad request' } } })

    await expect(requestOpenAIResponseAPI(makeArg(profile, { previewBody: false }))).resolves.toEqual({
      type: 'fail',
      result: '{"message":"bad request"}',
    })
  })
})

describe('requestOpenAILegacyInstruct profile provider options', () => {
  it('uses NanoGPTLegacy profile key, request model, provider header, and completions URL over flat conflicts', async () => {
    const nanoLegacyInfo = modelInfo({
      id: 'nanogpt-legacy-profile',
      name: 'NanoGPT Legacy Profile',
      provider: LLMProvider.NanoGPT,
      format: LLMFormat.NanoGPTLegacy,
    })
    const profile = resolveDurableProfile(
      db({ aiModel: nanoLegacyInfo.id } as Partial<Database>),
      {
        modelId: nanoLegacyInfo.id,
        providerOptions: {
          requestModel: 'profile/nano-legacy-model',
          nanogpt: { providerHint: 'profile-provider' },
        },
      },
      'sk-profile-nano',
      () => nanoLegacyInfo,
    )
    setDatabase(
      db({
        aiModel: nanoLegacyInfo.id,
        nanogptKey: 'sk-flat-nano',
        nanogptRequestModel: 'flat/nano-legacy-model',
        nanogptProvider: 'flat-provider',
        openAIKey: 'sk-flat-openai',
      } as Partial<Database>),
    )

    const payload = await previewLegacy(
      makeArg(profile, {
        key: 'sk-flat-arg-nano',
      }),
    )

    expect(payload.url).toBe('https://nano-gpt.com/api/v1/completions')
    expect(payload.headers.Authorization).toBe('Bearer sk-profile-nano')
    expect(payload.headers['X-Provider']).toBe('profile-provider')
    expect(payload.body.model).toBe('profile/nano-legacy-model')
  })

  it('keeps no-resolvedProfile legacy instruct URL, key, and hard-coded model fallback behavior', async () => {
    setDatabase(
      db({
        aiModel: 'legacy-instruct',
        openAIKey: 'sk-db-openai',
      } as Partial<Database>),
    )

    const payload = await previewLegacy({
      database: getDatabase(),
      formated: [
        { role: 'system', content: 'legacy system' },
        { role: 'user', content: 'hello' },
      ],
      bias: {},
      biasString: [],
      aiModel: 'legacy-instruct',
      maxTokens: 64,
      useStreaming: false,
      previewBody: true,
      mode: 'model',
      customURL: 'https://legacy.example/v1/completions',
      key: 'sk-arg-openai',
      modelInfo: modelInfo({
        id: 'legacy-instruct',
        internalID: 'flat-legacy-wire',
        format: LLMFormat.OpenAILegacyInstruct,
      }),
    } as RequestDataArgumentExtended)

    expect(payload.url).toBe('https://legacy.example/v1/completions')
    expect(payload.headers.Authorization).toBe('Bearer sk-arg-openai')
    expect(payload.body.model).toBe('gpt-3.5-turbo-instruct')
  })
})
