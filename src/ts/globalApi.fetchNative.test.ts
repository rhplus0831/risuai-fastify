import { resetClientSessionForTests, canUseClientWriteAccess } from './clientSession'
import { setManagedWriterForTest, demoteAndRepromoteForTest } from './__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const platformState = vi.hoisted(() => ({ isFastifyServer: true }))

vi.mock('./platform', async (importActual) => {
  const actual = await importActual<typeof import('./platform')>()
  return {
    ...actual,
    get isFastifyServer() {
      return platformState.isFastifyServer
    },
  }
})

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'proxy-auth-token',
}))

vi.mock('./process/modules', async (importActual) => {
  const actual = await importActual<typeof import('./process/modules')>()
  return {
    ...actual,
    getModuleAssets: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
    getModules: vi.fn(() => []),
    moduleUpdate: vi.fn(),
  }
})

import { fetchNative, getFetchLogs } from './globalApi.svelte'
import { testDatabaseState } from './__tests__/resourceDatabaseState'

const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

function stubStreamingFetch() {
  let requestSignal: AbortSignal | undefined
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined
  const cancelSource = vi.fn()

  const sourceResponse = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller
      },
      cancel(reason) {
        cancelSource(reason)
      },
    }),
    {
      status: 202,
      statusText: 'Streaming Accepted',
      headers: { 'content-type': 'text/event-stream', 'x-stream-id': 'stream-1' },
    },
  )
  Object.defineProperties(sourceResponse, {
    redirected: { configurable: true, value: true },
    type: { configurable: true, value: 'cors' },
    url: { configurable: true, value: 'https://provider.example.test/final-stream' },
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return sourceResponse
    }) as unknown as typeof fetch,
  )

  return {
    cancelSource,
    close(value?: string) {
      if (value !== undefined) sourceController?.enqueue(new TextEncoder().encode(value))
      sourceController?.close()
    },
    get requestSignal() {
      return requestSignal
    },
  }
}

beforeEach(() => {
  platformState.isFastifyServer = true
  fetchCalls.length = 0
  getFetchLogs().length = 0
  testDatabaseState.db = {
    requestLocation: '',
  }
  delete (window as typeof window & { userScriptFetch?: typeof fetch }).userScriptFetch
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init })
      return new Response('ok', {
        status: 201,
        headers: { 'content-type': 'text/plain' },
      })
    }) as unknown as typeof fetch,
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  getFetchLogs().length = 0
})

describe('fetchNative diagnostics', () => {
  it('does not console.log the request body and keeps structured fetch logs', async () => {
    const body = 'private request body'
    const response = await fetchNative('https://provider.example.test/v1/messages', {
      method: 'POST',
      body,
      headers: { authorization: 'Bearer test' },
      chatId: 'chat-fetch-native',
    })

    expect(response.status).toBe(201)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].input).toBe('https://provider.example.test/v1/messages')
    expect(fetchCalls[0].init?.method).toBe('POST')
    expect(new TextDecoder().decode(fetchCalls[0].init?.body as Uint8Array)).toBe(body)
    expect(console.log).not.toHaveBeenCalledWith(body, 'body')
    expect(getFetchLogs()[0]).toMatchObject({
      body,
      header: JSON.stringify({ authorization: 'Bearer test' }, null, 2),
      response: 'Streamed Fetch',
      success: true,
      url: 'https://provider.example.test/v1/messages',
      responseType: 'stream',
      chatId: 'chat-fetch-native',
    })
  })

  it('omits sensitive request credentials from fetch diagnostics', async () => {
    const body = 'refresh_token=private-refresh&client_secret=private-secret'
    const response = await fetchNative('https://auth.example.test/token', {
      method: 'POST',
      body,
      headers: { authorization: 'Basic private-client' },
      sensitive: true,
    })

    expect(response.status).toBe(201)
    expect(fetchCalls).toHaveLength(1)
    expect(new TextDecoder().decode(fetchCalls[0].init?.body as Uint8Array)).toBe(body)
    expect(getFetchLogs()).toEqual([])
  })
})

describe('fetchNative streaming cancellation', () => {
  it('terminates a response returned after the combined signal was already aborted', async () => {
    const stream = stubStreamingFetch()
    const caller = new AbortController()
    caller.abort()

    const response = await fetchNative('https://provider.example.test/stream', {
      method: 'GET',
      signal: caller.signal,
      requestTimeoutMs: 60_000,
    })

    expect(stream.requestSignal?.aborted).toBe(true)
    await expect(response.text()).rejects.toBeDefined()
    expect(stream.cancelSource).toHaveBeenCalledOnce()
  })

  it('keeps caller abort connected after response headers arrive', async () => {
    const stream = stubStreamingFetch()
    const caller = new AbortController()
    const removeAbortListener = vi.spyOn(caller.signal, 'removeEventListener')
    const response = await fetchNative('https://provider.example.test/stream', {
      method: 'GET',
      signal: caller.signal,
      requestTimeoutMs: 60_000,
    })

    const body = expect(response.text()).rejects.toBeDefined()
    caller.abort()

    expect(stream.requestSignal?.aborted).toBe(true)
    await body
    expect(stream.cancelSource).toHaveBeenCalledOnce()
    expect(removeAbortListener).toHaveBeenCalledTimes(1)
  })

  it('keeps the request deadline active after response headers arrive', async () => {
    vi.useFakeTimers()
    const stream = stubStreamingFetch()
    const caller = new AbortController()
    const removeAbortListener = vi.spyOn(caller.signal, 'removeEventListener')
    const response = await fetchNative('https://provider.example.test/stream', {
      method: 'GET',
      signal: caller.signal,
      requestTimeoutMs: 1_000,
    })

    const body = expect(response.text()).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(stream.requestSignal?.aborted).toBe(true)
    await body
    expect(stream.cancelSource).toHaveBeenCalledOnce()
    expect(removeAbortListener).toHaveBeenCalledTimes(1)
  })

  it('cleans the deadline and caller listener once when the body is canceled', async () => {
    vi.useFakeTimers()
    const stream = stubStreamingFetch()
    const caller = new AbortController()
    const removeAbortListener = vi.spyOn(caller.signal, 'removeEventListener')
    const response = await fetchNative('https://provider.example.test/stream', {
      method: 'GET',
      signal: caller.signal,
      requestTimeoutMs: 1_000,
    })

    await response.body?.cancel('unused response')
    caller.abort()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(stream.cancelSource).toHaveBeenCalledOnce()
    expect(stream.cancelSource).toHaveBeenCalledWith('unused response')
    expect(stream.requestSignal?.aborted).toBe(false)
    expect(removeAbortListener).toHaveBeenCalledTimes(1)
  })

  it('cleans once on normal EOF while preserving response metadata', async () => {
    vi.useFakeTimers()
    const stream = stubStreamingFetch()
    const caller = new AbortController()
    const removeAbortListener = vi.spyOn(caller.signal, 'removeEventListener')
    const response = await fetchNative('https://provider.example.test/stream', {
      method: 'GET',
      signal: caller.signal,
      requestTimeoutMs: 1_000,
    })

    stream.close('done')
    await expect(response.text()).resolves.toBe('done')
    caller.abort()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(202)
    expect(response.statusText).toBe('Streaming Accepted')
    expect(response.headers.get('x-stream-id')).toBe('stream-1')
    expect(response.url).toBe('https://provider.example.test/final-stream')
    expect(response.redirected).toBe(true)
    expect(response.type).toBe('cors')
    expect(stream.requestSignal?.aborted).toBe(false)
    expect(removeAbortListener).toHaveBeenCalledTimes(1)
  })
})

// Each case starts on the conservative path unless it explicitly manages a session.
beforeEach(() => resetClientSessionForTests())

it('rejects delayed native body chunks after demotion and repromotion', async () => {
  setManagedWriterForTest()
  const stream = stubStreamingFetch()
  const response = await fetchNative('https://provider.example.test', { method: 'GET' })
  expect(response.status).toBe(202)
  const text = response.text()
  demoteAndRepromoteForTest()
  stream.close('stale provider output')
  await expect(text).rejects.toThrow('client_write_operation_stale')
  expect(canUseClientWriteAccess()).toBe(true)
})
