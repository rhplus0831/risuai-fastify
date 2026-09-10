import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyDatabase as Database } from '../src/prompt/serverTypes.js'
import { resolveModelProfile } from '@risuai/shared-core/model-profile-resolver'
import {
  dispatchChatProvider,
  OPENAI_STRONG_BAN_PUNCTUATION,
  resolveOpenAILogitBias,
} from '../src/prompt/chatDispatch.js'
import { encodeTokens, type TokenEncoding } from '../src/prompt/tokens.js'

function db(overrides: Partial<Database> = {}): Database {
  return {
    aiModel: 'gpt4',
    subModel: 'gpt4',
    modelRoles: {},
    fallbackModels: {},
    customModels: [],
    modelTools: [],
    OaiCompAPIKeys: {},
    openAIKey: 'sk-logit-bias',
    maxResponse: 64,
    temperature: 50,
    useStreaming: false,
    ...overrides,
  } as unknown as Database
}

describe('OpenAI logit-bias parity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('bans the first token of every required punctuation-adjacent variant without depending on traversal order', () => {
    expect(OPENAI_STRONG_BAN_PUNCTUATION).toBe(' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~“”‘’«»「」…–―※')

    const text = 'Ban'
    const variants = new Set([text, text.trim(), text.toLocaleUpperCase(), text.toLocaleLowerCase(), 'Ban', 'ban'])
    const punctuation = [...OPENAI_STRONG_BAN_PUNCTUATION]
    const requiredInputs = new Set([
      ...punctuation,
      ...punctuation.flatMap((char) => [...variants].flatMap((variant) => [variant + char, char + variant])),
    ])
    const punctuationTokenByChar = new Map(punctuation.map((char, index) => [char, index + 1_000]))
    const nonPunctuationTokenByInput = new Map(
      [...requiredInputs]
        .filter((input) => !punctuationTokenByChar.has([...input][0] ?? ''))
        .map((input, index) => [input, index + 10_000]),
    )
    const requestedInputs = new Set<string>()
    const requestedEncodings = new Set<string>()
    const fixtureEncode = (value: string, encoding: TokenEncoding): readonly number[] => {
      if (!requiredInputs.has(value)) throw new Error(`Unexpected encoder input: ${JSON.stringify(value)}`)
      requestedInputs.add(value)
      requestedEncodings.add(encoding)
      const token = punctuationTokenByChar.get([...value][0] ?? '') ?? nonPunctuationTokenByInput.get(value)
      if (token === undefined) throw new Error(`Missing token fixture for: ${JSON.stringify(value)}`)
      return [token, 9_999]
    }

    const bias = resolveOpenAILogitBias([[text, -101]], 'ignored-model', 'o200k_base', fixtureEncode)
    const expectedBias = Object.fromEntries(
      [...nonPunctuationTokenByInput.values()].map((token) => [String(token), -100]),
    )

    expect(requestedInputs).toEqual(requiredInputs)
    expect(requestedEncodings).toEqual(new Set(['o200k_base']))
    expect(bias).toEqual(expectedBias)
    for (const token of punctuationTokenByChar.values()) expect(bias).not.toHaveProperty(String(token))
    expect(bias).not.toHaveProperty('9999')
  })

  it('forwards ordinary and direct-token bias values without clamping', () => {
    const fixtureEncode = vi.fn(() => [41, 42])

    expect(
      resolveOpenAILogitBias(
        [
          ['ordinary', 175],
          ['[[123]]', -250],
        ],
        'gpt-4',
        'cl100k_base',
        fixtureEncode,
      ),
    ).toEqual({ '41': 175, '42': 175, '123': -250 })
    expect(fixtureEncode).toHaveBeenCalledTimes(1)
  })

  it('sends strong-ban and unclamped values through dispatch using the database-selected tokenizer family', async () => {
    let providerBody: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        providerBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const database = db({
      customTokenizer: 'o200k_base',
      providerCredentials: [{ id: 'logit-openai', name: 'Logit OpenAI', type: 'apiKey', apiKey: 'sk-logit-profile' }],
      modelProfiles: [
        {
          id: 'logit-bias-profile',
          name: 'Logit Bias Profile',
          providerId: 'openai',
          modelId: 'gpt4',
          providerOptions: { credentialId: 'logit-openai', requestModel: 'gpt4' },
          runtimeOptions: { customTokenizer: 'o200k_base' },
        },
      ],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'logit-bias-profile' } },
    } as Partial<Database>)
    const frames = await dispatchChatProvider({
      database,
      profile: resolveModelProfile({ database }),
      formated: [{ role: 'user', content: 'hello' }],
      biases: [
        ['forbidden', -101],
        ['ordinary', 175],
        ['[[123]]', -250],
      ],
      signal: new AbortController().signal,
    })
    for await (const _frame of frames) {
      // Consume the buffered request so the captured body is populated.
    }

    const wireBias = providerBody?.logit_bias as Record<string, number>
    expect(wireBias).toBeDefined()
    expect(wireBias['123']).toBe(-250)
    const selectedFamilyTokens = encodeTokens('ordinary', 'o200k_base')
    expect(selectedFamilyTokens).not.toEqual(encodeTokens('ordinary', 'cl100k_base'))
    for (const token of selectedFamilyTokens) expect(wireBias[String(token)]).toBe(175)
    const strongBanValues = Object.entries(wireBias).filter(
      ([token]) => token !== '123' && !selectedFamilyTokens.includes(Number(token)),
    )
    expect(strongBanValues.length).toBeGreaterThan(0)
    expect(new Set(strongBanValues.map(([, value]) => value))).toEqual(new Set([-100]))
    expect(Object.values(wireBias)).not.toContain(-101)
  })
})
