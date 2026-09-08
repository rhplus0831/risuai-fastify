import { performance } from 'node:perf_hooks'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDiagnosticEventV2, type DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'
import { registerDiagnosticDatabase, runWithDiagnosticContext } from '../src/diagnosticContext.js'
import { resolveOpenAIRequest, runOpenAI, runOpenAIStream } from '../src/generation/openai.js'
import { resolveGeminiRequest, runGeminiStream } from '../src/generation/gemini.js'
import { dispatchChatProvider } from '../src/prompt/chatDispatch.js'
import type { FastifyDatabase } from '../src/prompt/serverTypes.js'
import type { CompletionStreamFrame } from '../src/generation/frames.js'

const canary = 'PRIVATE_PROVIDER_CHAT_PRESET_MODEL_HEADER_KEY_BODY_ERROR_CANARY'
const requestUid = 'ae'.repeat(32)
const encoder = new TextEncoder()
type ProviderEvent = Extract<DiagnosticEventV2, { category: 'provider' }>
let clock = 0
const disposers: (() => void)[] = []

function collector(enabled = true, fail = false) {
  const db = {}
  const events: DiagnosticEventV2[] = []
  if (enabled)
    disposers.push(
      registerDiagnosticDatabase(db, {
        key: new Uint8Array(32).fill(9),
        history: () => canary,
        record(event) {
          if (fail) throw new Error(canary)
          events.push(event)
        },
      }),
    )
  return {
    events,
    run: <T>(callback: () => T) => runWithDiagnosticContext(db, { requestUid, operationId: canary }, callback),
    provider: () => events.filter((event): event is ProviderEvent => event.category === 'provider'),
  }
}

/** A scripted upstream reader makes observation time and cleanup exact without extra reads. */
function providerResponse(chunks: Array<string | Error>, status = 200) {
  let cursor = 0
  const reader = {
    read: vi.fn(async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      clock += 20
      const chunk = chunks[cursor++]
      if (chunk instanceof Error) throw chunk
      return chunk === undefined ? { done: true, value: undefined } : { done: false, value: encoder.encode(chunk) }
    }),
    cancel: vi.fn(async () => undefined),
  }
  const getReader = vi.fn(() => reader)
  const response = new Response(null, {
    status,
    statusText: canary,
    headers: { 'Content-Type': 'application/json', 'X-Provider-Private': canary },
  })
  Object.defineProperty(response, 'body', { value: { getReader } })
  const clone = vi.spyOn(response, 'clone')
  const fetch = vi.fn(async () => {
    clock += 12
    return response
  })
  vi.stubGlobal('fetch', fetch)
  return { response, reader, getReader, clone, fetch }
}

function openAIRequest(signal = new AbortController().signal) {
  return resolveOpenAIRequest({
    model: canary,
    messages: [{ role: 'user', content: canary }],
    apiKey: canary,
    baseUrl: `https://synthetic.invalid/${canary}`,
    extraHeaders: { 'X-Private': canary },
    signal,
  })!
}

function openAIChunk(content = canary, finishReason?: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }], custom_metadata: canary })}\n\n`
}

async function consume(frames: AsyncIterable<CompletionStreamFrame>) {
  const values: CompletionStreamFrame[] = []
  for await (const frame of frames) values.push(frame)
  return values
}

function expectSafe(events: DiagnosticEventV2[]) {
  expect(events.every(isDiagnosticEventV2)).toBe(true)
  expect(JSON.stringify(events)).not.toContain(canary)
  for (const event of events) {
    expect(event).toMatchObject({
      source: 'server',
      correlation: 'operation',
      requestUid,
      operationRef: expect.stringMatching(/^[a-f0-9]{32}$/),
      attemptRef: expect.stringMatching(/^[a-f0-9]{32}$/),
    })
  }
}

beforeEach(() => {
  clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('safe provider attempt diagnostics', () => {
  it('observes actual headers, parsed first token, consumed bytes and read stalls with one bounded terminal event', async () => {
    const fixture = providerResponse([openAIChunk(), 'data: [DONE]\n\n'])
    const scope = collector()
    const request = openAIRequest()
    const { frames } = scope.run(() => ({ frames: runOpenAIStream(request) }))
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(scope.events).toEqual([])
    expect(await frames.next()).toMatchObject({ value: { kind: 'token', content: canary } })
    clock += 1000 // Consumer processing is not an upstream read stall.
    expect(await frames.next()).toMatchObject({ value: { kind: 'done' } })
    await frames.next()
    const events = scope.provider()
    expect(events.map((event) => event.stage)).toEqual(['dispatch', 'headers', 'terminal'])
    expect(events[1]).toMatchObject({ timeToHeadersMs: 12, statusCode: 200, providerMayHaveRun: true })
    expect(events[2]).toMatchObject({
      adapter: 'openai',
      transport: 'stream',
      outcome: 'ok',
      timeToFirstTokenMs: 32,
      maxStreamGapMs: 20,
      chunkCount: 2,
      responseBytes: 'small',
    })
    expect(new Set(events.map((event) => event.attemptRef)).size).toBe(1)
    expect(fixture.getReader).toHaveBeenCalledTimes(1)
    expect(fixture.reader.read).toHaveBeenCalledTimes(2)
    expect(fixture.reader.cancel).toHaveBeenCalledTimes(1)
    expect(fixture.clone).not.toHaveBeenCalled()
    expect(fixture.fetch).toHaveBeenCalledWith(
      `https://synthetic.invalid/${canary}/chat/completions`,
      expect.objectContaining({ signal: request.signal }),
    )
    expectSafe(events)
  })

  it('measures Gemini first parsed content before local reasoning buffering', async () => {
    const frame = (part: unknown, finishReason?: string) =>
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [part] }, ...(finishReason ? { finishReason } : {}) }], modelVersion: canary })}\n\n`
    const fixture = providerResponse([frame({ text: canary, thought: true }), frame({ text: 'answer' }, 'STOP')])
    const scope = collector()
    const request = resolveGeminiRequest({
      model: canary,
      messages: [{ role: 'user', content: canary }],
      apiKey: canary,
      signal: new AbortController().signal,
      streamThoughts: false,
    })!
    const { frames } = scope.run(() => ({ frames: runGeminiStream(request) }))
    const first = await frames.next()
    expect(first.value).toMatchObject({ kind: 'token' })
    expect(clock).toBe(52)
    await consume(frames)
    expect(scope.provider().at(-1)).toMatchObject({
      adapter: 'gemini',
      stage: 'terminal',
      outcome: 'ok',
      timeToFirstTokenMs: 32,
      chunkCount: 2,
      maxStreamGapMs: 20,
    })
    expect(fixture.reader.cancel).toHaveBeenCalledTimes(1)
    expectSafe(scope.events)
  })

  it('distinguishes a pre-dispatch timeout from an ambiguous timeout after fetch is invoked', async () => {
    const scope = collector()
    const fetch = vi.fn(async () => {
      throw new DOMException(canary, 'TimeoutError')
    })
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort(new DOMException(canary, 'TimeoutError'))
    await scope.run(() => runOpenAI(openAIRequest(controller.signal)))
    expect(fetch).not.toHaveBeenCalled()
    expect(scope.provider()).toHaveLength(1)
    expect(scope.provider()[0]).toMatchObject({
      stage: 'terminal',
      outcome: 'timeout',
      providerMayHaveRun: false,
      cancellationOrigin: 'deadline',
    })
    await scope.run(() => runOpenAI(openAIRequest()))
    expect(fetch).toHaveBeenCalledTimes(1)
    const events = scope.provider()
    expect(events.at(-1)).toMatchObject({
      stage: 'terminal',
      outcome: 'timeout',
      providerMayHaveRun: true,
      cancellationOrigin: 'deadline',
    })
    expect(events[0].operationRef).toBe(events.at(-1)!.operationRef)
    expect(events[0].attemptRef).not.toBe(events.at(-1)!.attemptRef)
    expectSafe(events)
  })

  it('retains partial content and distinguishes a thrown stream disconnect', async () => {
    const fixture = providerResponse([openAIChunk(), new Error(canary)])
    const scope = collector()
    const frames = await scope.run(() => consume(runOpenAIStream(openAIRequest())))
    expect(frames[0]).toMatchObject({ kind: 'token', content: canary })
    expect(frames.at(-1)).toMatchObject({ kind: 'error' })
    expect(scope.provider().at(-1)).toMatchObject({
      outcome: 'disconnected',
      providerMayHaveRun: true,
      cancellationOrigin: 'disconnect',
      chunkCount: 1,
    })
    expect(fixture.reader.cancel).toHaveBeenCalledTimes(1)
    expectSafe(scope.events)
  })

  it('reports missing provider completion markers without changing the existing clean-EOF frames', async () => {
    providerResponse([openAIChunk()])
    const scope = collector()
    const frames = await scope.run(() => consume(runOpenAIStream(openAIRequest())))
    expect(frames.map((frame) => frame.kind)).toEqual(['token', 'done'])
    expect(scope.provider().at(-1)).toMatchObject({ outcome: 'disconnected', providerMayHaveRun: true })
    expectSafe(scope.events)
  })

  it.each(['abort', 'return'] as const)('preserves %s cleanup after a partial stream', async (mode) => {
    const fixture = providerResponse([openAIChunk(), 'data: [DONE]\n\n'])
    const scope = collector()
    const controller = new AbortController()
    const { frames } = scope.run(() => ({ frames: runOpenAIStream(openAIRequest(controller.signal)) }))
    await frames.next()
    if (mode === 'abort') {
      controller.abort(new DOMException(canary, 'AbortError'))
      await frames.next()
    } else await frames.return()
    expect(fixture.reader.read).toHaveBeenCalledTimes(1)
    expect(fixture.reader.cancel).toHaveBeenCalledTimes(1)
    expect(scope.provider().filter((event) => event.stage === 'terminal')).toHaveLength(1)
    expect(scope.provider().at(-1)).toMatchObject({
      outcome: 'cancelled',
      cancellationOrigin: 'unknown',
      providerMayHaveRun: true,
    })
    expectSafe(scope.events)
  })

  it('forwards consumer throw to the original generator and preserves its cleanup and error identity', async () => {
    const fixture = providerResponse([openAIChunk()])
    const scope = collector()
    const { frames } = scope.run(() => ({ frames: runOpenAIStream(openAIRequest()) }))
    await frames.next()
    const error = new Error(canary)
    await expect(frames.throw(error)).rejects.toBe(error)
    expect(fixture.reader.cancel).toHaveBeenCalledTimes(1)
    expectSafe(scope.events)
  })

  it.each([
    { status: 429, body: JSON.stringify({ error: { message: canary, code: canary } }), outcome: 'http-error' },
    { status: 200, body: canary, outcome: 'invalid-response' },
    { status: 200, body: JSON.stringify({ choices: [], private: canary }), outcome: 'invalid-response' },
  ])('reports $outcome using bounded facts without parsing private error text', async ({ status, body, outcome }) => {
    providerResponse([body], status)
    const scope = collector()
    const result = await scope.run(() => runOpenAI(openAIRequest()))
    expect(result.type).toBe('fail')
    expect(scope.provider().at(-1)).toMatchObject({
      outcome,
      statusCode: status,
      providerMayHaveRun: true,
      responseBytes: 'small',
    })
    expectSafe(scope.events)
  })

  it('rejects malformed streaming payloads without exporting a textual fallback', async () => {
    providerResponse([`data: ${canary}\n\n`])
    const scope = collector()
    expect((await scope.run(() => consume(runOpenAIStream(openAIRequest()))))[0].kind).toBe('error')
    expect(scope.provider().at(-1)).toMatchObject({ outcome: 'invalid-response', providerMayHaveRun: true })
    expectSafe(scope.events)
  })

  it('classifies a Gemini provider error frame without exporting its message or status label', async () => {
    providerResponse([`data: ${JSON.stringify({ error: { message: canary, status: canary } })}\n\n`])
    const scope = collector()
    const request = resolveGeminiRequest({
      model: canary,
      messages: [{ role: 'user', content: canary }],
      apiKey: canary,
      signal: new AbortController().signal,
    })!
    const frames = await scope.run(() => consume(runGeminiStream(request)))
    expect(frames[0].kind).toBe('error')
    expect(scope.provider().at(-1)).toMatchObject({
      outcome: 'unknown-error',
      statusCode: 200,
      providerMayHaveRun: true,
    })
    expectSafe(scope.events)
  })

  it('records dispatch admission failures before any provider could run', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const scope = collector()
    const database = {
      modelProfiles: [
        {
          id: canary,
          name: canary,
          providerId: 'openai',
          modelId: 'gpt-4o',
          providerOptions: { credentialId: 'missing' },
        },
      ],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: canary } },
    } as unknown as FastifyDatabase
    await expect(
      scope.run(() =>
        dispatchChatProvider({
          database,
          formated: [{ role: 'user', content: canary }],
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(scope.provider()).toHaveLength(1)
    expect(scope.provider()[0]).toMatchObject({ stage: 'terminal', providerMayHaveRun: false, transport: 'unknown' })
    expectSafe(scope.events)
  })

  it.each([
    { diagnostics: true, rawMetrics: false, fullPrompt: false },
    { diagnostics: true, rawMetrics: true, fullPrompt: false },
    { diagnostics: true, rawMetrics: false, fullPrompt: true },
    { diagnostics: false, rawMetrics: true, fullPrompt: true },
  ])(
    'keeps safe events separate with flags $diagnostics/$rawMetrics/$fullPrompt',
    async ({ diagnostics, rawMetrics, fullPrompt }) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'risu-provider-diagnostics-'))
      vi.stubEnv('RISU_PROTOCOL_METRICS', rawMetrics ? '1' : '0')
      vi.spyOn(console, 'info').mockImplementation(() => undefined)
      const fixture = providerResponse([JSON.stringify({ choices: [{ message: { content: canary } }], model: canary })])
      const scope = collector(diagnostics)
      const request = openAIRequest()
      if (fullPrompt)
        request.trace = {
          dataDir: directory,
          generationId: canary,
          options: { fullPrompt: true, maxGzipBytes: 1024 * 1024 },
        }
      try {
        const result = await scope.run(() => runOpenAI(request))
        expect(result).toMatchObject({ type: 'success', result: canary })
        expect(scope.events).toHaveLength(diagnostics ? 3 : 0)
        expect(fixture.fetch).toHaveBeenCalledTimes(1)
        expect(fixture.clone).not.toHaveBeenCalled()
        expectSafe(scope.events)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('isolates diagnostics failure and concurrent application scopes without changing results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ choices: [{ message: { content: canary } }] })),
    )
    const first = collector()
    const second = collector()
    const failed = collector(true, true)
    const results = await Promise.all(
      [first, second, failed].map((scope) => scope.run(() => runOpenAI(openAIRequest()))),
    )
    expect(results.every((result) => result.type === 'success' && result.result === canary)).toBe(true)
    expect(first.events).toHaveLength(3)
    expect(second.events).toHaveLength(3)
    expect(failed.events).toHaveLength(0)
    expect(first.provider()[0].attemptRef).not.toBe(second.provider()[0].attemptRef)
    expectSafe(first.events)
    expectSafe(second.events)
  })

  it('omits evidence if attempt context initialization fails while preserving provider completion', async () => {
    providerResponse([JSON.stringify({ choices: [{ message: { content: canary } }] })])
    const scope = collector()
    vi.spyOn(AsyncLocalStorage, 'snapshot').mockImplementation(() => {
      throw new Error(canary)
    })
    expect(await scope.run(() => runOpenAI(openAIRequest()))).toMatchObject({ type: 'success', result: canary })
    expect(scope.events).toEqual([])
  })
})
