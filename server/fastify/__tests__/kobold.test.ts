import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveKoboldRequest, runKobold } from '../src/generation/kobold.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('resolveKoboldRequest', () => {
  it('returns null when baseUrl is missing', () => {
    expect(
      resolveKoboldRequest({
        messages: [{ role: 'user', content: 'hi' }],
        baseUrl: '',
        signal: new AbortController().signal,
      }),
    ).toBeNull()
  })

  it('pins the retained legacy-instruct flattening', () => {
    // Accepted divergence (PR-18/PR-7 sunset): Kobold keeps this fixed flattening
    // instead of baseline `src/ts/process/templates/chatTemplate.ts` templates.
    const r = resolveKoboldRequest({
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'prior' },
      ],
      baseUrl: 'http://localhost:5001',
      signal: new AbortController().signal,
    })
    expect(r?.prompt).toBe('\n## Instruction\nrules\n## User\nhi\n## Assistant\nprior\n## Response\n')
  })
})

describe('runKobold', () => {
  it('appends /api/v1/generate to a bare base URL and returns results[0].text', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init }
      return ok({ results: [{ text: 'kobold ok' }] })
    })
    const resolved = resolveKoboldRequest({
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: 'http://localhost:5001',
      maxTokens: 128,
      temperature: 0.7,
      signal: new AbortController().signal,
    })!
    const r = await runKobold(resolved)
    expect(r).toEqual({ type: 'success', result: 'kobold ok' })
    expect(captured!.url).toBe('http://localhost:5001/api/v1/generate')
    const sent = JSON.parse(captured!.init.body as string)
    expect(sent.prompt).toBe('\n## User\nhi\n## Response\n')
    expect(sent.max_length).toBe(128)
    expect(sent.temperature).toBe(0.7)
    expect(sent.n).toBe(1)
  })

  it.each([
    {
      name: 'keeps a baseUrl that already includes /api/v1/generate',
      baseUrl: 'http://localhost:5001/api/v1/generate',
      expectedUrl: 'http://localhost:5001/api/v1/generate',
    },
    {
      name: 'posts to a user-supplied non-root path verbatim',
      baseUrl: 'http://localhost:5001/api/v1',
      expectedUrl: 'http://localhost:5001/api/v1',
    },
    {
      name: 'preserves custom paths and query strings verbatim',
      baseUrl: 'http://localhost:5001/custom/generate?profile=legacy',
      expectedUrl: 'http://localhost:5001/custom/generate?profile=legacy',
    },
  ])('$name', async ({ baseUrl, expectedUrl }) => {
    let capturedUrl = ''
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return ok({ results: [{ text: 'x' }] })
    })
    const resolved = resolveKoboldRequest({
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl,
      signal: new AbortController().signal,
    })!
    await runKobold(resolved)
    expect(capturedUrl).toBe(expectedUrl)
  })

  it('applies additional parameters after building the body and injects headers', async () => {
    let captured: RequestInit | null = null
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = init
      return ok({ results: [{ text: 'x' }] })
    })
    const resolved = resolveKoboldRequest({
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: 'http://localhost:5001',
      temperature: 0.7,
      additionalParams: [
        ['temperature', '0.25'],
        ['custom_flag', 'true'],
        ['header::X-Global-Trace', 'kobold'],
      ],
      signal: new AbortController().signal,
    })!

    await runKobold(resolved)

    expect(JSON.parse(captured!.body as string)).toMatchObject({ temperature: 0.25, custom_flag: true })
    expect((captured!.headers as Record<string, string>)['X-Global-Trace']).toBe('kobold')
  })

  it('returns fail with raw body on non-2xx', async () => {
    vi.stubGlobal('fetch', async () => new Response('overloaded', { status: 503 }))
    const resolved = resolveKoboldRequest({
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: 'http://localhost:5001',
      signal: new AbortController().signal,
    })!
    expect(await runKobold(resolved)).toEqual({ type: 'fail', result: 'overloaded', nonRetryable: true })
  })

  it('returns fail when results array lacks text', async () => {
    vi.stubGlobal('fetch', async () => ok({ results: [] }))
    const resolved = resolveKoboldRequest({
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: 'http://localhost:5001',
      signal: new AbortController().signal,
    })!
    expect((await runKobold(resolved)).type).toBe('fail')
  })

  it('returns aborted=true on pre-aborted signal', async () => {
    const c = new AbortController()
    c.abort()
    let called = false
    vi.stubGlobal('fetch', async () => {
      called = true
      return ok({ results: [{ text: 'x' }] })
    })
    const resolved = resolveKoboldRequest({
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: 'http://localhost:5001',
      signal: c.signal,
    })!
    expect((await runKobold(resolved)).aborted).toBe(true)
    expect(called).toBe(false)
  })
})
