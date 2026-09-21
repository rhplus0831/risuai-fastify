import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../../platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('../../../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'test-auth-token',
}))

import { LLMFormat } from '../../../model/types'
import type { character } from '../../../storage/database.svelte'
import type { RequestDataArgumentExtended } from '../request'
import {
  extractAnthropicSystem,
  getServerCompletionProvider,
  requestServerCompletion,
  resolveServerCompletionRoute,
} from '../serverCompletion'

function makeTarg(overrides: Partial<RequestDataArgumentExtended> = {}): RequestDataArgumentExtended {
  return {
    bias: {},
    formated: [{ role: 'user', content: 'hi' }],
    aiModel: 'echo_model',
    modelInfo: {
      id: 'echo_model',
      name: 'Echo',
      internalID: 'echo_model',
      provider: 0 as never,
      format: LLMFormat.Echo,
      flags: [],
      parameters: [],
      tokenizer: 0 as never,
      recommended: false,
    } as unknown as RequestDataArgumentExtended['modelInfo'],
    useStreaming: false,
    maxTokens: 64,
    temperature: 0.4,
    mode: 'memory',
    currentChar: { name: 'Mira' } as character,
    ...overrides,
  } as RequestDataArgumentExtended
}

beforeEach(() => {})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveServerCompletionRoute', () => {
  it('routes Fastify completion by server intent without exposing a provider', () => {
    expect(resolveServerCompletionRoute(makeTarg())).toEqual({ type: 'server' })
    expect(getServerCompletionProvider(makeTarg())).toBe('server-intent')
  })

  it('rejects provider preview bodies in Fastify mode', () => {
    const route = resolveServerCompletionRoute(makeTarg({ previewBody: true }))
    expect(route.type).toBe('unsupported')
    expect(route).toEqual({
      type: 'unsupported',
      reason:
        'Provider preview bodies are not supported in Fastify server mode because browser-side provider dispatch is disabled.',
    })
  })
})

describe('requestServerCompletion', () => {
  it('posts server-owned completion intent without provider wire options or secrets', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ type: 'success', result: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const controller = new AbortController()
    const result = await requestServerCompletion(makeTarg(), controller.signal)

    expect(result).toEqual({ type: 'success', result: 'ok' })
    expect(captured!.url).toBe('/api/v1/generate/completion')
    expect(captured!.init.method).toBe('POST')
    expect(captured!.init.signal).toBe(controller.signal)
    expect((captured!.init.headers as Record<string, string>)['risu-auth']).toBe('test-auth-token')
    const payload = JSON.parse(captured!.init.body as string)
    expect(payload).toEqual({
      kind: 'server-intent',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      mode: 'memory',
      maxTokens: 64,
      temperature: 0.4,
      currentCharName: 'Mira',
    })
    expect(JSON.stringify(payload)).not.toMatch(/"provider"|"model"|"options"|"apiKey"|"baseUrl"|"credentials"/)
  })

  it('passes static model intent when the caller provides one', async () => {
    let payload: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        payload = JSON.parse(init.body as string)
        return new Response(JSON.stringify({ type: 'success', result: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    await requestServerCompletion(makeTarg({ staticModel: 'echo_model' }), null)

    expect(payload?.staticModel).toBe('echo_model')
  })

  it('sends bounded tool history and validates the returned call against the supplied definitions', async () => {
    let payload: Record<string, unknown> | null = null
    const tool = {
      name: 'risu-get-character-info',
      description: 'Get character information.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        payload = JSON.parse(init.body as string)
        return new Response(
          JSON.stringify({
            type: 'success',
            result: '',
            toolCalls: [{ id: 'call-2', name: tool.name, arguments: { id: 'next-id' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )

    await expect(
      requestServerCompletion(
        makeTarg({
          tools: [tool],
          toolRounds: [
            {
              assistantContent: '',
              calls: [{ id: 'call-1', name: tool.name, arguments: { id: 'mira-id' } }],
              results: [{ callId: 'call-1', name: tool.name, content: '{"name":"Mira"}' }],
            },
          ],
        }),
        null,
      ),
    ).resolves.toEqual({
      type: 'success',
      result: '',
      toolCalls: [{ id: 'call-2', name: tool.name, arguments: { id: 'next-id' } }],
    })
    expect(payload).toMatchObject({ tools: [tool] })
    expect(payload?.toolRounds).toEqual([
      {
        assistantContent: '',
        calls: [{ id: 'call-1', name: tool.name, arguments: { id: 'mira-id' } }],
        results: [{ callId: 'call-1', name: tool.name, content: '{"name":"Mira"}' }],
      },
    ])
  })

  it('rejects a server tool call that was not in the caller-supplied list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'success',
              result: '',
              toolCalls: [{ id: 'call-1', name: 'arbitrary-tool', arguments: {} }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    await expect(
      requestServerCompletion(
        makeTarg({
          tools: [
            {
              name: 'risu-get-character-info',
              description: 'Get character information.',
              inputSchema: { type: 'object' },
            },
          ],
        }),
        null,
      ),
    ).resolves.toMatchObject({
      type: 'fail',
      result: expect.stringContaining('unavailable tool: arbitrary-tool'),
      noRetry: true,
    })
  })

  it('returns a noRetry failure when the server rejects the intent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'unsupported provider' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await expect(requestServerCompletion(makeTarg(), null)).resolves.toEqual({
      type: 'fail',
      result: 'unsupported provider',
      noRetry: true,
    })
  })

  it('preserves provider status and code fields from non-streaming JSON failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'fail',
              result: 'Provider request failed: HTTP 404 from https://proxy.test/v1/chat/completions: missing',
              status: 404,
              statusText: 'Not Found',
              code: 'upstream_404',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    )

    await expect(requestServerCompletion(makeTarg(), null)).resolves.toEqual({
      type: 'fail',
      result: 'Provider request failed: HTTP 404 from https://proxy.test/v1/chat/completions: missing',
      status: 404,
      statusText: 'Not Found',
      code: 'upstream_404',
    })
  })

  it('reads server completion SSE streams', async () => {
    const bytes = new TextEncoder().encode(
      'event: chunk\ndata: {"type":"token","content":"he"}\n\n' +
        'event: chunk\ndata: {"type":"token","content":"llo 안녕 🌊"}\n\n' +
        'event: chunk\ndata: malformed-json\n\n' +
        'event: chunk\ndata: {"type":"metadata","content":"not text"}\n\n' +
        'event: done\ndata: {"finishReason":"stop"}\n\n' +
        'event: chunk\ndata: {"type":"token","content":"after terminal"}\n\n',
    )
    // Keep coalesced-frame coverage as well as byte-by-byte network fragmentation.
    for (const chunks of [[bytes], Array.from(bytes, (byte) => Uint8Array.of(byte))]) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(stream, { status: 200 })),
      )

      await expect(requestServerCompletion(makeTarg({ useStreaming: true }), null)).resolves.toEqual({
        type: 'success',
        result: 'hello 안녕 🌊',
      })
    }
  })

  it('rejects streaming tools before dispatch while permitting the buffered tool request', async () => {
    const tool = {
      name: 'risu-get-character-info',
      description: 'Get character information.',
      inputSchema: { type: 'object' },
    }
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ type: 'success', result: 'buffered reply' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestServerCompletion(makeTarg({ tools: [tool] }), null)).resolves.toEqual({
      type: 'success',
      result: 'buffered reply',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    fetchMock.mockClear()

    await expect(requestServerCompletion(makeTarg({ tools: [tool], useStreaming: true }), null)).resolves.toEqual({
      type: 'fail',
      result: 'Server tool requests must use buffered completion',
      noRetry: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancels an active completion reader and reports abort instead of returning partial success', async () => {
    const owner = new AbortController()
    const cancel = vi.fn()
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let resolveRead!: () => void
    const reading = new Promise<void>((resolve) => {
      resolveRead = resolve
    })
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          streamController = controller
          controller.enqueue(new TextEncoder().encode('event: chunk\ndata: {"type":"token","content":"partial"}\n\n'))
        },
        pull() {
          resolveRead()
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    )
    const pending = requestServerCompletion(makeTarg({ useStreaming: true }), owner.signal)

    try {
      // With no prefetch, pull starts the read after the queued token was consumed.
      await reading
      owner.abort()
      expect(cancel).toHaveBeenCalledOnce()
      await expect(pending).resolves.toEqual({ type: 'fail', result: 'Aborted' })
    } finally {
      // Let a broken abort-listener implementation settle too, avoiding a leaked reader.
      if (cancel.mock.calls.length === 0) streamController.close()
      await pending
    }
  })

  it('adds provider status and code details to streamed completion errors', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              type: 'provider_error',
              error: 'Not Found',
              status: 404,
              statusText: 'Not Found',
              code: 'upstream_404',
            })}\n\n`,
          ),
        )
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 })),
    )

    await expect(requestServerCompletion(makeTarg({ useStreaming: true }), null)).resolves.toEqual({
      type: 'fail',
      result: 'Not Found (HTTP 404 Not Found, code upstream_404)',
    })
  })
})

describe('extractAnthropicSystem', () => {
  it('extracts string system messages and preserves other rows', () => {
    const result = extractAnthropicSystem([
      { role: 'system', content: 'a' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'b' },
    ])

    expect(result).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'a\n\nb',
    })
  })
})
