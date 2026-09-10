import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildBedrockRequest,
  coerceBedrockCredentials,
  resolveBedrockRequest,
  runBedrock,
} from '../src/generation/bedrock.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const baseCreds = {
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  region: 'us-east-1',
}

describe('coerceBedrockCredentials', () => {
  it('returns null when input is undefined or null', () => {
    expect(coerceBedrockCredentials(undefined)).toBeNull()
    expect(coerceBedrockCredentials(null)).toBeNull()
  })

  it.each([
    [{ secretAccessKey: 's', region: 'r' }, 'options.bedrock.accessKeyId is required'],
    [{ accessKeyId: 'a', region: 'r' }, 'options.bedrock.secretAccessKey is required'],
    [{ accessKeyId: 'a', secretAccessKey: 's' }, 'options.bedrock.region is required'],
  ])('returns a precise error when a required credential is missing', (credentials, error) => {
    expect(coerceBedrockCredentials(credentials)).toEqual({ ok: false, error })
  })

  it('passes optional sessionToken through', () => {
    const r = coerceBedrockCredentials({
      accessKeyId: 'a',
      secretAccessKey: 's',
      region: 'r',
      sessionToken: 'stoken',
    })
    expect(r).toEqual({
      ok: true,
      value: { accessKeyId: 'a', secretAccessKey: 's', region: 'r', sessionToken: 'stoken' },
    })
  })
})

describe('resolveBedrockRequest', () => {
  it('returns null when credentials are invalid', () => {
    const r = resolveBedrockRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: { accessKeyId: 'a' },
      signal: new AbortController().signal,
    })
    expect(r).toBeNull()
  })

  it('returns null when messages is not an array', () => {
    const r = resolveBedrockRequest({
      model: 'm',
      messages: 'oops' as unknown,
      credentials: baseCreds,
      signal: new AbortController().signal,
    })
    expect(r).toBeNull()
  })

  it('defaults maxTokens to 1024 when not provided', () => {
    const r = resolveBedrockRequest({
      model: 'm',
      messages: [],
      credentials: baseCreds,
      signal: new AbortController().signal,
    })
    expect(r?.maxTokens).toBe(1024)
  })

  it('normalizes budget and adaptive thinking controls', () => {
    const r = resolveBedrockRequest({
      model: 'm',
      messages: [],
      credentials: baseCreds,
      thinkingTokens: 4096,
      thinkingType: 'adaptive',
      adaptiveThinkingEffort: 'xhigh',
      supportsAdaptiveThinking: true,
      supportsXHighEffort: false,
      signal: new AbortController().signal,
    })
    expect(r).toMatchObject({
      thinkingTokens: 4096,
      thinkingType: 'adaptive',
      adaptiveThinkingEffort: 'xhigh',
      supportsAdaptiveThinking: true,
      supportsXHighEffort: false,
    })
  })
})

describe('buildBedrockRequest', () => {
  const fixedDate = new Date(Date.UTC(2024, 0, 1, 0, 0, 0))

  it('builds the Bedrock URL with the model id percent-encoded (v2:0 → v2%3A0)', () => {
    const built = buildBedrockRequest({
      model: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      maxTokens: 256,
      date: fixedDate,
      signal: new AbortController().signal,
    })
    expect(built.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke',
    )
  })

  it('emits anthropic_version=bedrock-2023-05-31 and omits the model field from the body', () => {
    const built = buildBedrockRequest({
      model: 'us.anthropic.claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      maxTokens: 128,
      date: fixedDate,
      signal: new AbortController().signal,
    })
    const body = JSON.parse(built.body)
    expect(body.anthropic_version).toBe('bedrock-2023-05-31')
    expect(body.model).toBeUndefined()
    expect(body.stream).toBeUndefined()
    expect(body.max_tokens).toBe(128)
  })

  it('attaches a signed Authorization header with bedrock as the service', () => {
    const built = buildBedrockRequest({
      model: 'us.test',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      maxTokens: 128,
      date: fixedDate,
      signal: new AbortController().signal,
    })
    expect(built.headers['Authorization']).toContain('Credential=AKIA/20240101/us-east-1/bedrock/aws4_request')
    expect(built.headers['x-amz-date']).toBe('20240101T000000Z')
    expect(built.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    {
      label: 'budget',
      thinking: {
        thinkingTokens: 4096,
        thinkingType: 'budget' as const,
      },
      expectedThinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' },
      expectedOutputConfig: undefined,
    },
    {
      label: 'adaptive',
      thinking: {
        thinkingType: 'adaptive' as const,
        adaptiveThinkingEffort: 'xhigh' as const,
        supportsAdaptiveThinking: true,
        supportsXHighEffort: false,
      },
      expectedThinking: { type: 'adaptive', display: 'summarized' },
      expectedOutputConfig: { effort: 'high' },
    },
  ])(
    'sends $label thinking and applies Bedrock sampler rules',
    ({ thinking, expectedThinking, expectedOutputConfig }) => {
      const built = buildBedrockRequest({
        model: 'us.test',
        messages: [{ role: 'user', content: 'hi' }],
        credentials: baseCreds,
        maxTokens: 8192,
        temperature: 0.25,
        topP: 0.8,
        topK: 20,
        ...thinking,
        date: fixedDate,
        signal: new AbortController().signal,
      })
      const body = JSON.parse(built.body)
      expect(body.thinking).toEqual(expectedThinking)
      expect(body.output_config).toEqual(expectedOutputConfig)
      expect(body.temperature).toBe(1)
      expect(body.top_p).toBeUndefined()
      expect(body.top_k).toBeUndefined()
    },
  )

  it('lets additionalParams mutate the body and headers before signing', () => {
    const built = buildBedrockRequest({
      model: 'us.test',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      maxTokens: 128,
      additionalParams: [
        ['header::anthropic-beta', 'cool-beta'],
        ['extra.flag', 'true'],
      ],
      date: fixedDate,
      signal: new AbortController().signal,
    })
    expect(built.headers['anthropic-beta']).toBe('cool-beta')
    const body = JSON.parse(built.body)
    expect(body.extra).toEqual({ flag: true })
    // The Authorization signature must cover anthropic-beta, otherwise
    // AWS rejects the request. Confirm anthropic-beta appears in
    // SignedHeaders.
    expect(built.headers['Authorization']).toMatch(/SignedHeaders=[^,]*anthropic-beta/)
  })

  it('signs with the session token in x-amz-security-token when provided', () => {
    const built = buildBedrockRequest({
      model: 'us.test',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: { ...baseCreds, sessionToken: 'sts-token' },
      maxTokens: 128,
      date: fixedDate,
      signal: new AbortController().signal,
    })
    expect(built.headers['x-amz-security-token']).toBe('sts-token')
    expect(built.headers['Authorization']).toMatch(/SignedHeaders=[^,]*x-amz-security-token/)
  })
})

describe('runBedrock', () => {
  it('POSTs to the Bedrock URL and returns the concatenated text content', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init }
      return ok({
        model: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        content: [
          { type: 'text', text: 'bedrock ' },
          { type: 'text', text: 'ok' },
        ],
        stop_reason: 'end_turn',
      })
    })
    const resolved = resolveBedrockRequest({
      model: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      system: 'be brief',
      maxTokens: 512,
      temperature: 0.5,
      signal: new AbortController().signal,
    })!
    const r = await runBedrock(resolved)
    expect(r.type).toBe('success')
    expect((r as { result: string }).result).toBe('bedrock ok')
    expect(captured!.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke',
    )
    const body = JSON.parse(captured!.init.body as string)
    expect(body.system).toBe('be brief')
    expect(body.temperature).toBe(0.5)
  })

  it('preserves thinking and redacted-thinking blocks in the shared envelope', async () => {
    vi.stubGlobal('fetch', async () =>
      ok({
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'redacted_thinking', data: 'opaque-signature' },
          { type: 'text', text: 'answer' },
        ],
      }),
    )
    const resolved = resolveBedrockRequest({
      model: 'us.test',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      signal: new AbortController().signal,
    })!

    expect(await runBedrock(resolved)).toEqual({
      type: 'success',
      result: '<Thoughts>\nreasoning\n{{redacted_thinking}}\n</Thoughts>\n\nanswer',
    })
  })

  it('returns fail with upstream error.message on non-2xx JSON', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { message: 'AccessDeniedException' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const resolved = resolveBedrockRequest({
      model: 'us.test',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      signal: new AbortController().signal,
    })!
    expect(await runBedrock(resolved)).toEqual({
      type: 'fail',
      result: 'AccessDeniedException',
    })
  })

  it('falls back to raw body when non-2xx is not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('throttled', { status: 429 }))
    const resolved = resolveBedrockRequest({
      model: 'us.test',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      signal: new AbortController().signal,
    })!
    expect(await runBedrock(resolved)).toEqual({ type: 'fail', result: 'throttled' })
  })

  it('returns fail when upstream returns no text content blocks', async () => {
    vi.stubGlobal('fetch', async () => ok({ content: [] }))
    const resolved = resolveBedrockRequest({
      model: 'us.test',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      signal: new AbortController().signal,
    })!
    expect(await runBedrock(resolved)).toEqual({
      type: 'fail',
      result: 'upstream returned no text content',
    })
  })

  it('returns aborted=true when the signal is pre-aborted', async () => {
    const c = new AbortController()
    c.abort()
    let called = false
    vi.stubGlobal('fetch', async () => {
      called = true
      return ok({ content: [{ type: 'text', text: 'x' }] })
    })
    const resolved = resolveBedrockRequest({
      model: 'us.test',
      messages: [{ role: 'user', content: 'hi' }],
      credentials: baseCreds,
      signal: c.signal,
    })!
    const r = await runBedrock(resolved)
    expect(r.aborted).toBe(true)
    expect(called).toBe(false)
  })
})
