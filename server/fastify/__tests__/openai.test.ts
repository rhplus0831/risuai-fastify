import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { applyOobaSystemHoist, resolveOpenAIRequest, runOpenAI, runOpenAIStream } from '../src/generation/openai.js'
import { MAX_STREAM_BUFFER_CHARS, STREAM_BUFFER_OVERFLOW_ERROR } from '../src/generation/sse.js'
import type { GenerationTraceContext, GenerationTraceSidecarEntry } from '../src/generation/generationTraceSidecar.js'

interface ProtocolMetric {
  metric: string
  provider?: string
  stream?: boolean
  endpointHost?: string
  endpointPath?: string
  requestBodyBytes?: number
  requestBodySha256?: string
  requestModel?: string
  messageCount?: number
  messageRoleCounts?: Record<string, number>
  systemMessageCount?: number
  systemContentBytes?: number
  messageContentBytes?: number
  messageContentSha256?: string
  contentPartCount?: number
  textPartCount?: number
  imagePartCount?: number
  audioPartCount?: number
  mediaPartCount?: number
  toolCount?: number
  functionCount?: number
  providerBodySidecar?: GenerationTraceSidecarEntry
}

async function withProtocolMetrics<T>(
  run: (metrics: ProtocolMetric[], rawMetricLines: string[]) => Promise<T>,
): Promise<T> {
  const previous = process.env.RISU_PROTOCOL_METRICS
  const metrics: ProtocolMetric[] = []
  const rawMetricLines: string[] = []
  process.env.RISU_PROTOCOL_METRICS = '1'
  const infoSpy = vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
    if (typeof message !== 'string' || !message.startsWith('[protocol-metric] ')) return
    rawMetricLines.push(message)
    metrics.push(JSON.parse(message.slice('[protocol-metric] '.length)) as ProtocolMetric)
  })
  try {
    return await run(metrics, rawMetricLines)
  } finally {
    infoSpy.mockRestore()
    if (previous === undefined) {
      delete process.env.RISU_PROTOCOL_METRICS
    } else {
      process.env.RISU_PROTOCOL_METRICS = previous
    }
  }
}

function providerBodyMetrics(metrics: ProtocolMetric[]): ProtocolMetric[] {
  return metrics.filter((metric) => metric.metric === 'generation_provider_request_body')
}

function traceContext(dataDir: string, maxGzipBytes = 10 * 1024 * 1024): GenerationTraceContext {
  return {
    dataDir,
    options: { fullPrompt: true, maxGzipBytes },
    generationId: 'openai-test-generation',
  }
}

function readSidecar(dataDir: string, entry: GenerationTraceSidecarEntry | undefined): string {
  expect(entry).toMatchObject({ status: 'written', path: expect.stringMatching(/^trace\/generation\/.+\.json\.gz$/) })
  const written = entry as Extract<GenerationTraceSidecarEntry, { status: 'written' }>
  return gunzipSync(readFileSync(path.join(dataDir, written.path))).toString('utf8')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('applyOobaSystemHoist', () => {
  it('leaves messages unchanged when no system rows are present', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const before = structuredClone(msgs)

    expect(applyOobaSystemHoist(msgs)).toEqual(before)
    expect(msgs).toEqual(before)
  })

  it('removes systems in place and appends a single trailing system with joined content', () => {
    const r = applyOobaSystemHoist([
      { role: 'system', content: 'a' },
      { role: 'user', content: 'q' },
      { role: 'system', content: 'b' },
    ])
    expect(r).toEqual([
      { role: 'user', content: 'q' },
      { role: 'system', content: 'a\nb' },
    ])
  })

  it('passes through non-string content (multimodal systems) unchanged', () => {
    const multimodal = [{ type: 'text', text: 'hello' }]
    const r = applyOobaSystemHoist([
      { role: 'system', content: multimodal },
      { role: 'user', content: 'q' },
    ])
    expect(r).toEqual([
      { role: 'system', content: multimodal },
      { role: 'user', content: 'q' },
    ])
  })
})

describe('resolveOpenAIRequest', () => {
  it.each([
    ['gpt4o', 'gpt-4o'],
    ['gpt4om', 'gpt-4o-mini'],
    ['gpt4o-chatgpt', 'chatgpt-4o-latest'],
    ['gpt35', 'gpt-3.5-turbo'],
    ['gpt4_1106', 'gpt-4-1106-preview'],
    ['custom-model', 'custom-model'],
  ])('normalizes legacy OpenAI model selector %s to %s before the request', (selected, wireModel) => {
    const resolved = resolveOpenAIRequest({
      model: selected,
      messages: [],
      apiKey: 'sk-x',
      signal: new AbortController().signal,
    })
    expect(resolved?.model).toBe(wireModel)
  })

  it('allows missing apiKey for optional-auth compatible endpoints', () => {
    const r = resolveOpenAIRequest({
      model: 'gpt-4o',
      messages: [],
      apiKey: '',
      signal: new AbortController().signal,
    })
    expect(r?.apiKey).toBeUndefined()
    expect(r?.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('returns null when messages is not an array', () => {
    const r = resolveOpenAIRequest({
      model: 'gpt-4o',
      messages: 'oops' as unknown as unknown[],
      apiKey: 'sk-x',
      signal: new AbortController().signal,
    })
    expect(r).toBeNull()
  })

  it('defaults baseUrl to api.openai.com when not provided', () => {
    const r = resolveOpenAIRequest({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'sk-x',
      signal: new AbortController().signal,
    })
    expect(r?.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('resolves Flex processing only for the official OpenAI endpoint', () => {
    const official = resolveOpenAIRequest({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'sk-x',
      flexProcessing: true,
      signal: new AbortController().signal,
    })
    const custom = resolveOpenAIRequest({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'sk-x',
      baseUrl: 'https://custom.example/v1',
      flexProcessing: true,
      signal: new AbortController().signal,
    })

    expect(official?.serviceTier).toBe('flex')
    expect(custom?.serviceTier).toBeUndefined()
  })

  it('drops a non-positive maxTokens', () => {
    const r = resolveOpenAIRequest({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'sk-x',
      maxTokens: 0,
      signal: new AbortController().signal,
    })
    expect(r?.maxTokens).toBeUndefined()
  })

  it('keeps a positive maxTokens and a finite temperature', () => {
    const r = resolveOpenAIRequest({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'sk-x',
      maxTokens: 256,
      temperature: 0.4,
      signal: new AbortController().signal,
    })
    expect(r?.maxTokens).toBe(256)
    expect(r?.temperature).toBe(0.4)
  })
})

describe('runOpenAI (non-streaming)', () => {
  function ok(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('posts to {baseUrl}/chat/completions with Bearer auth and returns the assistant content', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init }
      return ok({
        model: 'gpt-4o',
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      })
    })

    const r = await runOpenAI({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      maxTokens: 64,
      temperature: 0.2,
      signal: new AbortController().signal,
    })
    expect(r).toEqual({ type: 'success', result: 'hello', model: 'gpt-4o' })

    expect(captured!.url).toBe('https://api.openai.com/v1/chat/completions')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['content-type']).toBe('application/json')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      max_tokens: 64,
      temperature: 0.2,
    })
  })

  it('omits absent temperature and unsupported bias fields from the request body', async () => {
    let captured: { init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = { init }
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })

    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.temperature).toBeUndefined()
    expect(sent.logit_bias).toBeUndefined()
    expect(sent.biases).toBeUndefined()
  })

  it('merges extraHeaders into the upstream request', async () => {
    let capturedHeaders: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      extraHeaders: { 'X-Title': 'RisuAI', 'HTTP-Referer': 'https://risuai.xyz' },
      signal: new AbortController().signal,
    })
    expect(capturedHeaders['X-Title']).toBe('RisuAI')
    expect(capturedHeaders['HTTP-Referer']).toBe('https://risuai.xyz')
    expect(capturedHeaders.authorization).toBe('Bearer k')
  })

  it('hoists every system message into a single trailing system row when oobaSystemHoist is set', async () => {
    let captured: { init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = { init }
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'm',
      messages: [
        { role: 'system', content: 'rule 1' },
        { role: 'user', content: 'q' },
        { role: 'system', content: 'rule 2' },
        { role: 'assistant', content: 'a' },
      ],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      oobaSystemHoist: true,
      signal: new AbortController().signal,
    })
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 'rule 1\nrule 2' },
    ])
  })

  it('leaves messages untouched when oobaSystemHoist is undefined/false', async () => {
    let captured: { init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = { init }
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'm',
      messages: [
        { role: 'system', content: 'rule 1' },
        { role: 'user', content: 'q' },
      ],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.messages).toEqual([
      { role: 'system', content: 'rule 1' },
      { role: 'user', content: 'q' },
    ])
  })

  it('overlays every non-null reverse-proxy Ooba argument before additionalParams', async () => {
    let captured: { init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = { init }
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      temperature: 0.7,
      topK: 20,
      oobaSystemHoist: true,
      oobaArgs: {
        mode: 'chat-instruct',
        name1: 'Persona',
        greeting: '',
        do_sample: false,
        top_k: 73,
        temperature: 0.4,
        nested_extension: { enabled: true },
        ignored_null: null,
        ignored_undefined: undefined,
      },
      additionalParams: [['temperature', '0.9']],
      signal: new AbortController().signal,
    })

    const sent = JSON.parse(captured!.init.body as string)
    expect(sent).toMatchObject({
      mode: 'chat-instruct',
      name1: 'Persona',
      greeting: '',
      do_sample: false,
      top_k: 73,
      temperature: 0.9,
      nested_extension: { enabled: true },
    })
    expect(sent.ignored_null).toBeUndefined()
    expect(sent.ignored_undefined).toBeUndefined()
  })

  it('applies additionalParams to the body + headers after the default payload is built', async () => {
    let captured: { init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = { init }
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      maxTokens: 256,
      temperature: 0.7,
      additionalParams: [
        ['header::X-Title', 'RisuAI'],
        ['extra.flag', 'true'],
        ['extra.nested.value', 'json::[1, 2]'],
        ['temperature', '{{none}}'],
      ],
      signal: new AbortController().signal,
    })
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.model).toBe('m')
    expect(sent.max_tokens).toBe(256)
    expect(sent.temperature).toBeUndefined()
    expect(sent.extra).toEqual({ flag: true, nested: { value: [1, 2] } })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['X-Title']).toBe('RisuAI')
  })

  it('restores buffered stream=false after additionalParams', async () => {
    let sent: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return ok({ choices: [{ message: { content: 'buffered' } }] })
    })

    const result = await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      additionalParams: [['stream', 'true']],
      signal: new AbortController().signal,
    })

    expect(sent.stream).toBe(false)
    expect(result).toEqual({ type: 'success', result: 'buffered' })
  })

  it('does not let additionalParams replace caller-scoped tool definitions', async () => {
    let captured: { init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = { init }
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    const tool = {
      name: 'risu-get-character-info',
      description: 'Get character information.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    }
    await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      tools: [tool],
      additionalParams: [
        ['tools', 'json::[{"type":"function","function":{"name":"arbitrary-tool","parameters":{"type":"object"}}}]'],
      ],
      signal: new AbortController().signal,
    })

    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      },
    ])
  })

  it('strips a trailing slash from baseUrl', async () => {
    let capturedUrl = ''
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1/',
      signal: new AbortController().signal,
    })
    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('uses an exact custom endpoint with its query string unchanged', async () => {
    let capturedUrl = ''
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://unused.example/v1',
      endpointUrl: 'https://proxy.example/v1/chat/completions?api-version=2025-01-01',
      signal: new AbortController().signal,
    })

    expect(capturedUrl).toBe('https://proxy.example/v1/chat/completions?api-version=2025-01-01')
  })

  it.each([
    [
      'query-bearing base',
      'https://proxy.example/v1?api-version=2025-01-01',
      'https://proxy.example/v1/chat/completions?api-version=2025-01-01',
    ],
    [
      'query-bearing trailing slash base',
      'https://proxy.example/v1/?api-version=2025-01-01',
      'https://proxy.example/v1/chat/completions?api-version=2025-01-01',
    ],
    [
      'completed trailing slash endpoint',
      'https://proxy.example/v1/chat/completions/?api-version=2025-01-01',
      'https://proxy.example/v1/chat/completions?api-version=2025-01-01',
    ],
  ])('appends chat/completions before the query for a %s', async (_label, baseUrl, expectedUrl) => {
    let capturedUrl = ''
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl,
      signal: new AbortController().signal,
    })

    expect(capturedUrl).toBe(expectedUrl)
  })

  it('normalizes flagged embedded DeepSeek thinking in buffered choices', async () => {
    vi.stubGlobal('fetch', async () =>
      ok({
        choices: [
          { message: { content: '<think>hidden reasoning</think>answer' } },
          { message: { content: '<think>alternate thought</think>alternate' } },
        ],
      }),
    )

    expect(
      await runOpenAI({
        model: 'deep-model',
        messages: [],
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        deepSeekThinkingOutput: true,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      type: 'success',
      result: '<Thoughts>\nhidden reasoning\n</Thoughts>\nanswer',
      alternates: ['<Thoughts>\nalternate thought\n</Thoughts>\nalternate'],
    })
  })

  it('returns fail with upstream error context on non-2xx', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({ error: { message: 'invalid model', code: 'model_not_found' } }), {
        status: 400,
      })
    })
    const r = await runOpenAI({
      model: 'badmodel',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })
    expect(r).toEqual({
      type: 'fail',
      result:
        'Provider request failed: HTTP 400 from https://api.openai.com/v1/chat/completions (model_not_found): invalid model',
      status: 400,
      code: 'model_not_found',
    })
  })

  it('adds endpoint context when error.message is absent', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }))
    const r = await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })
    expect(r).toEqual({
      type: 'fail',
      result:
        'Provider request failed: HTTP 500 from https://api.openai.com/v1/chat/completions: upstream returned an empty error body',
      status: 500,
    })
  })

  it('returns fail when upstream returns no content', async () => {
    vi.stubGlobal('fetch', async () => ok({ choices: [{ message: {} }] }))
    const r = await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })
    expect(r).toEqual({ type: 'fail', result: 'upstream returned no content' })
  })

  it('returns aborted=true when signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    let called = false
    vi.stubGlobal('fetch', async () => {
      called = true
      return ok({ choices: [{ message: { content: 'x' } }] })
    })
    const r = await runOpenAI({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: c.signal,
    })
    expect(r.aborted).toBe(true)
    expect(called).toBe(false)
  })

  it('emits provider request body metadata without leaking prompt text or API keys', async () => {
    const prompt = 'OPENAI_PROMPT_MUST_NOT_LEAK'
    const bodySecret = 'sk-body-secret-must-not-leak'
    let capturedBody = ''
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body)
      return ok({ choices: [{ message: { content: 'x' } }] })
    })

    await withProtocolMetrics(async (metrics, rawMetricLines) => {
      await runOpenAI({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'be brief' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
            ],
          },
        ],
        apiKey: 'sk-header-secret-must-not-leak',
        baseUrl: 'https://api.openai.com/v1',
        additionalParams: [['apiKey', bodySecret]],
        signal: new AbortController().signal,
      })

      const metric = providerBodyMetrics(metrics)[0]
      expect(metric).toMatchObject({
        provider: 'openai',
        stream: false,
        endpointHost: 'api.openai.com',
        endpointPath: '/v1/chat/completions',
        requestModel: 'gpt-4o',
        messageCount: 2,
        messageRoleCounts: { system: 1, user: 1 },
        systemMessageCount: 1,
        systemContentBytes: Buffer.byteLength('be brief', 'utf8'),
        messageContentBytes: Buffer.byteLength(`be brief${prompt}`, 'utf8'),
        contentPartCount: 3,
        textPartCount: 2,
        imagePartCount: 1,
        audioPartCount: 0,
        mediaPartCount: 1,
        toolCount: 0,
        functionCount: 0,
      })
      expect(metric.requestBodyBytes).toBe(Buffer.byteLength(capturedBody, 'utf8'))
      expect(metric.requestBodySha256).toMatch(/^[a-f0-9]{64}$/)
      expect(metric.messageContentSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(metric.providerBodySidecar).toBeUndefined()
      expect(rawMetricLines.join('\n')).not.toContain(prompt)
      expect(rawMetricLines.join('\n')).not.toContain(bodySecret)
      expect(rawMetricLines.join('\n')).not.toContain('sk-header-secret-must-not-leak')
    })
  })

  it('writes opt-in provider body sidecars with redacted OpenAI secrets', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-openai-sidecar-'))
    vi.stubGlobal('fetch', async () => ok({ choices: [{ message: { content: 'x' } }] }))

    try {
      await withProtocolMetrics(async (metrics) => {
        await runOpenAI({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'OPENAI_PROVIDER_PROMPT_VISIBLE_IN_SIDECAR' }],
          apiKey: 'sk-header-secret-sidecar',
          baseUrl: 'https://api.openai.com/v1',
          extraHeaders: {
            'X-Api-Key': 'extra-header-secret',
            Referer: 'https://example.test/path?token=query-secret',
          },
          additionalParams: [
            ['apiKey', 'body-api-secret'],
            ['image_url.url', 'data:image/png;base64,abc123'],
          ],
          signal: new AbortController().signal,
          trace: traceContext(dataDir),
        })

        const metric = providerBodyMetrics(metrics)[0]
        const sidecarText = readSidecar(dataDir, metric.providerBodySidecar)
        expect(sidecarText).toContain('OPENAI_PROVIDER_PROMPT_VISIBLE_IN_SIDECAR')
        expect(sidecarText).not.toContain('sk-header-secret-sidecar')
        expect(sidecarText).not.toContain('extra-header-secret')
        expect(sidecarText).not.toContain('body-api-secret')
        expect(sidecarText).not.toContain('query-secret')
        expect(sidecarText).not.toContain('abc123')
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('omits OpenAI provider body sidecars over the gzip cap', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-openai-sidecar-cap-'))
    vi.stubGlobal('fetch', async () => ok({ choices: [{ message: { content: 'x' } }] }))

    try {
      await withProtocolMetrics(async (metrics) => {
        await runOpenAI({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'cap overflow' }],
          apiKey: 'sk-test',
          baseUrl: 'https://api.openai.com/v1',
          signal: new AbortController().signal,
          trace: traceContext(dataDir, 1),
        })

        expect(providerBodyMetrics(metrics)[0].providerBodySidecar).toMatchObject({
          status: 'omitted',
          reason: 'max_gzip_bytes_exceeded',
          maxGzipBytes: 1,
        })
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('buckets unusual provider body roles without leaking role text in metrics', async () => {
    const unusualRole = 'ROLE_SECRET_MUST_NOT_LEAK'
    vi.stubGlobal('fetch', async () => ok({ choices: [{ message: { content: 'x' } }] }))

    await withProtocolMetrics(async (metrics, rawMetricLines) => {
      await runOpenAI({
        model: 'gpt-4o',
        messages: [
          { role: unusualRole, content: 'hi' },
          { role: 'user', content: 'normal' },
        ],
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        signal: new AbortController().signal,
      })

      const metric = providerBodyMetrics(metrics)[0]
      expect(metric.messageRoleCounts).toEqual({ other: 1, user: 1 })
      expect(rawMetricLines.join('\n')).not.toContain(unusualRole)
    })
  })

  it('keeps provider body hashes and counts stable for identical requests', async () => {
    vi.stubGlobal('fetch', async () => ok({ choices: [{ message: { content: 'x' } }] }))

    await withProtocolMetrics(async (metrics) => {
      const request = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'same prompt' }],
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
      }
      await runOpenAI({ ...request, signal: new AbortController().signal })
      await runOpenAI({ ...request, signal: new AbortController().signal })

      const [first, second] = providerBodyMetrics(metrics)
      expect(second.requestBodySha256).toBe(first.requestBodySha256)
      expect(second.messageContentSha256).toBe(first.messageContentSha256)
      expect(second.messageCount).toBe(first.messageCount)
      expect(second.messageRoleCounts).toEqual(first.messageRoleCounts)
    })
  })
})

function sseUpstream(chunks: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function tokenFrame(content: string, finish?: string): string {
  const frame = {
    choices: [finish ? { delta: { content }, finish_reason: finish } : { delta: { content } }],
  }
  return `data: ${JSON.stringify(frame)}\n\n`
}

function crlf(s: string): string {
  return s.replace(/\n/g, '\r\n')
}

describe('runOpenAIStream', () => {
  it('translates upstream deltas into our token frames + a trailing done', async () => {
    vi.stubGlobal('fetch', async () => {
      return sseUpstream([tokenFrame('hello'), tokenFrame(' world'), `data: [DONE]\n\n`])
    })
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      { kind: 'token', content: 'hello' },
      { kind: 'token', content: ' world' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('converts cumulative proxy fragments into append-only token frames', async () => {
    vi.stubGlobal('fetch', async () => {
      return sseUpstream([tokenFrame('Hel'), tokenFrame('Hello'), `data: [DONE]\n\n`])
    })
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      { kind: 'token', content: 'Hel' },
      { kind: 'token', content: 'lo' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('normalizes a flagged DeepSeek think block split across content deltas', async () => {
    vi.stubGlobal('fetch', async () =>
      sseUpstream([
        tokenFrame('<thi'),
        tokenFrame('nk>hidden reasoning</thi'),
        tokenFrame('nk>answer'),
        `data: [DONE]\n\n`,
      ]),
    )
    const frames: unknown[] = []
    for await (const frame of runOpenAIStream({
      model: 'deep-model',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      deepSeekThinkingOutput: true,
      signal: new AbortController().signal,
    })) {
      frames.push(frame)
    }

    expect(frames).toEqual([
      { kind: 'token', content: '<Thoughts>\nhidden reasoning\n</Thoughts>\nanswer' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('accepts CRLF-delimited upstream SSE frames', async () => {
    vi.stubGlobal('fetch', async () => {
      return sseUpstream([crlf(tokenFrame('hello')), crlf(tokenFrame(' world')), `data: [DONE]\r\n\r\n`])
    })
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      { kind: 'token', content: 'hello' },
      { kind: 'token', content: ' world' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('emits a done frame at end-of-stream when upstream omits [DONE]', async () => {
    vi.stubGlobal('fetch', async () => sseUpstream([tokenFrame('only')]))
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      { kind: 'token', content: 'only' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('propagates upstream finish_reason through the done frame', async () => {
    vi.stubGlobal('fetch', async () => {
      return sseUpstream([tokenFrame('foo'), tokenFrame('', 'length'), `data: [DONE]\n\n`])
    })
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      { kind: 'token', content: 'foo' },
      { kind: 'done', finishReason: 'length' },
    ])
  })

  it('yields nothing when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    vi.stubGlobal('fetch', async () => sseUpstream([tokenFrame('x')]))
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: c.signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([])
  })

  it('handles a partial frame split across reader chunks', async () => {
    vi.stubGlobal('fetch', async () => {
      const half = tokenFrame('chunky')
      return sseUpstream([half.slice(0, 10), half.slice(10), `data: [DONE]\n\n`])
    })
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      { kind: 'token', content: 'chunky' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })

  it('surfaces upstream non-OK responses as error frames', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({ error: { message: 'rate limited', code: 'rate_limit' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    })
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      {
        kind: 'error',
        error:
          'Provider request failed: HTTP 500 from https://api.openai.com/v1/chat/completions (rate_limit): rate limited',
        status: 500,
        code: 'rate_limit',
      },
    ])
  })

  it('surfaces empty upstream non-OK responses with endpoint context', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://proxy.example.test/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      {
        kind: 'error',
        error:
          'Provider request failed: HTTP 404 from https://proxy.example.test/v1/chat/completions: upstream returned an empty error body',
        status: 404,
      },
    ])
  })

  it('surfaces a missing upstream stream body as an error frame', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      {
        kind: 'error',
        error:
          'Provider request failed: HTTP 200 from https://api.openai.com/v1/chat/completions: upstream returned no stream body',
        status: 200,
      },
    ])
  })

  it('surfaces invalid upstream stream JSON as an error frame', async () => {
    vi.stubGlobal('fetch', async () => sseUpstream(['data: {nope}\n\n']))
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('invalid upstream stream JSON'),
    })
  })

  it('surfaces unterminated upstream SSE tails as an error frame', async () => {
    vi.stubGlobal('fetch', async () => sseUpstream(['data: {nope}']))
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([{ kind: 'error', error: 'truncated upstream stream event' }])
  })

  it('bounds the accumulation buffer when upstream never sends an event delimiter', async () => {
    // > MAX_STREAM_BUFFER_CHARS of delimiter-less bytes, streamed in 1 MB
    // chunks. Without the cap the adapter would buffer the whole stream.
    const chunk = 'x'.repeat(1024 * 1024)
    vi.stubGlobal('fetch', async () =>
      sseUpstream(Array.from({ length: MAX_STREAM_BUFFER_CHARS / chunk.length + 2 }, () => chunk)),
    )
    const frames: unknown[] = []
    for await (const f of runOpenAIStream({
      model: 'gpt-4o',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      signal: new AbortController().signal,
    })) {
      frames.push(f)
    }
    expect(frames).toEqual([{ kind: 'error', error: STREAM_BUFFER_OVERFLOW_ERROR }])
  })

  it('emits provider request body metadata with stream:true', async () => {
    vi.stubGlobal('fetch', async () => sseUpstream([tokenFrame('hello'), `data: [DONE]\n\n`]))

    await withProtocolMetrics(async (metrics) => {
      const frames: unknown[] = []
      for await (const f of runOpenAIStream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'stream prompt' }],
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        signal: new AbortController().signal,
      })) {
        frames.push(f)
      }

      expect(frames.at(-1)).toEqual({ kind: 'done', finishReason: 'stop' })
      const metric = providerBodyMetrics(metrics)[0]
      expect(metric).toMatchObject({
        provider: 'openai',
        stream: true,
        endpointPath: '/v1/chat/completions',
        requestModel: 'gpt-4o',
        messageCount: 1,
      })
    })
  })

  it('restores streaming stream=true after additionalParams', async () => {
    let sent: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return sseUpstream([tokenFrame('streamed'), `data: [DONE]\n\n`])
    })
    const frames: unknown[] = []
    for await (const frame of runOpenAIStream({
      model: 'm',
      messages: [],
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      additionalParams: [['stream', 'false']],
      signal: new AbortController().signal,
    })) {
      frames.push(frame)
    }

    expect(sent.stream).toBe(true)
    expect(frames).toEqual([
      { kind: 'token', content: 'streamed' },
      { kind: 'done', finishReason: 'stop' },
    ])
  })
})
