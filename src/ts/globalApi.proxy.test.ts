import { resetClientSessionForTests } from './clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from './__tests__/managedClientSession'
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

const proxyAuthMocks = vi.hoisted(() => ({ auth: vi.fn(async () => 'proxy-auth-token') }))
vi.mock('./storage/fastifyStorage', () => ({ getNodeServerProxyAuth: proxyAuthMocks.auth }))

vi.mock('./process/modules', async (importActual) => {
  const actual = await importActual<typeof import('./process/modules')>()
  return { ...actual, moduleUpdate: vi.fn() }
})

import { testDatabaseState } from './__tests__/resourceDatabaseState'
import { fetchNative, globalFetch, pluginFetchNative, pluginGlobalFetch } from './globalApi.svelte'

class FakeWebSocket {
  static OPEN = 1
  readonly OPEN = 1
  readyState = FakeWebSocket.OPEN
  binaryType = 'blob'
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closeCalls = 0

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    fakeWebSocketUrls.push(url)
    fakeWebSocketProtocols.push(protocols)
    fakeWebSockets.push(this)
  }

  send(): void {
    // no-op
  }

  close(): void {
    this.closeCalls += 1
    if (this.readyState === 3) {
      return
    }
    this.readyState = 3
    this.onclose?.()
  }

  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<unknown>)
  }

  emitBinary(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as MessageEvent<unknown>)
  }

  emitError(): void {
    this.onerror?.()
  }
}

const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
const fakeWebSocketUrls: string[] = []
const fakeWebSocketProtocols: Array<string | string[] | undefined> = []
const fakeWebSockets: FakeWebSocket[] = []

async function waitForWebSocket(index = 0): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fakeWebSockets[index]) {
      return fakeWebSockets[index]
    }
    await Promise.resolve()
  }
  throw new Error(`FakeWebSocket ${index} was not created`)
}

function startStreamingProxyFetch(signal?: AbortSignal): Promise<Response> {
  return fetchNative('http://127.0.0.1:11434/v1/chat/completions', {
    body: JSON.stringify({ stream: true }),
    headers: { authorization: 'Bearer test' },
    interceptor: 'openai_streaming',
    method: 'POST',
    networkRoute: 'local_network',
    signal,
  })
}

function proxyDeleteCalls() {
  return fetchCalls.filter((call) => call.init?.method === 'DELETE')
}

beforeEach(() => {
  platformState.isFastifyServer = true
  testDatabaseState.db = {
    usePlainFetch: false,
    requestLocation: '',
  }
  fetchCalls.length = 0
  fakeWebSocketUrls.length = 0
  fakeWebSocketProtocols.length = 0
  fakeWebSockets.length = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    fetchCalls.push({ url, init })
    if (url === '/api/v1/proxy/stream-jobs') {
      return new Response(JSON.stringify({ jobId: 'job 1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (init?.method === 'DELETE' && url.startsWith('/api/v1/proxy/stream-jobs/')) {
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Fastify proxy routing', () => {
  it('routes buffered proxy fetches through the Fastify proxy endpoint', async () => {
    const res = await globalFetch('https://provider.example.test/v1/chat/completions', {
      body: { messages: [] },
      headers: { authorization: 'Bearer test' },
    })

    expect(res.ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('/api/v1/proxy/fetch')
    expect(fetchCalls[0].url).not.toContain('/proxy2')
    expect(fetchCalls[0].init?.headers).toMatchObject({
      'risu-url': encodeURIComponent('https://provider.example.test/v1/chat/completions'),
      'risu-auth': 'proxy-auth-token',
    })
  })

  it('always routes plugin buffered requests through the public-only plugin proxy', async () => {
    testDatabaseState.db.usePlainFetch = true

    const response = await pluginGlobalFetch('https://public.example.test/data', {
      method: 'GET',
      plainFetchForce: true,
      networkRoute: 'local_network',
    })

    expect(response.ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toMatchObject({
      url: '/api/v1/proxy/plugin-fetch',
      init: { method: 'GET' },
    })
  })

  it('always routes plugin native requests through the public-only plugin proxy', async () => {
    const response = await pluginFetchNative('https://public.example.test/data', {
      method: 'GET',
      networkRoute: 'local_network',
    })

    expect(response.ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toMatchObject({
      url: '/api/v1/proxy/plugin-fetch',
      init: { method: 'GET' },
    })
  })

  it.each([
    { method: 'PATCH' as const, body: 'patch-body' },
    { method: 'HEAD' as const, body: undefined },
    { method: 'OPTIONS' as const, body: undefined },
  ])('preserves plugin native $method requests on the dedicated proxy', async ({ method, body }) => {
    const response = await pluginFetchNative('https://public.example.test/resource', {
      method,
      ...(body === undefined ? {} : { body }),
    })

    expect(response.ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toMatchObject({
      url: '/api/v1/proxy/plugin-fetch',
      init: { method },
    })
    if (method === 'HEAD') expect(fetchCalls[0].init?.body).toBeUndefined()
  })

  it('preserves plugin proxy status text in the native response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('accepted', { status: 202, statusText: 'Upstream Accepted' })),
    )

    const response = await pluginFetchNative('https://public.example.test/resource', { method: 'GET' })

    expect(response.status).toBe(202)
    expect(response.statusText).toBe('Upstream Accepted')
  })

  it('preserves GET when globalFetch uses the buffered Fastify proxy', async () => {
    const res = await globalFetch('https://provider.example.test/v1/models', {
      method: 'GET',
      headers: { authorization: 'Bearer test' },
    })

    expect(res.ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toMatchObject({
      url: '/api/v1/proxy/fetch',
      init: {
        method: 'GET',
      },
    })
    expect(fetchCalls[0].init?.body).toBeUndefined()
  })

  it.each([
    { method: 'GET' as const, body: undefined },
    { method: 'POST' as const, body: '{"method":"post"}' },
    { method: 'PUT' as const, body: '{"method":"put"}' },
    { method: 'DELETE' as const, body: undefined },
  ])('preserves $method when fetchNative uses the local-network proxy', async ({ method, body }) => {
    const response = await fetchNative('http://127.0.0.1:11434/resource', {
      method,
      ...(body === undefined ? {} : { body }),
      headers: { authorization: 'Bearer test' },
      networkRoute: 'local_network',
    })

    expect(response.ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toMatchObject({
      url: '/api/v1/proxy/fetch',
      init: { method },
    })
  })

  it('routes local streaming proxy jobs through Fastify create and websocket endpoints', async () => {
    const resPromise = startStreamingProxyFetch()
    const socket = await waitForWebSocket()
    socket.emitError()
    const res = await resPromise

    expect(res.status).toBe(502)
    expect(fetchCalls[0].url).toBe('/api/v1/proxy/stream-jobs')
    expect(fetchCalls[0].url).not.toContain('/proxy-stream-jobs')
    expect(fakeWebSocketUrls).toEqual(['ws://localhost:3000/api/v1/proxy/stream-jobs/job%201/ws'])
    expect(fakeWebSocketProtocols).toEqual([['risu-stream-v1', 'risu-auth.proxy-auth-token']])
    expect(fakeWebSocketUrls[0]).not.toContain('proxy-auth-token')
    expect(fakeWebSocketUrls[0]).not.toContain('/proxy-stream-jobs')
    expect(proxyDeleteCalls()).toHaveLength(1)
  })

  it('returns the existing 499 response shape when aborted before headers', async () => {
    const controller = new AbortController()
    const resPromise = startStreamingProxyFetch(controller.signal)
    await waitForWebSocket()

    controller.abort()
    const res = await resPromise

    expect(res.status).toBe(499)
    expect(res.headers.get('content-type')).toContain('text/plain')
    await expect(res.text()).resolves.toBe('Aborted')
    expect(proxyDeleteCalls()).toHaveLength(1)
    expect(proxyDeleteCalls()[0]).toMatchObject({
      url: '/api/v1/proxy/stream-jobs/job%201',
      init: {
        method: 'DELETE',
        headers: {
          'risu-auth': 'proxy-auth-token',
        },
      },
    })
  })

  it('DELETEs the proxy stream job once when aborted after headers but before a terminal frame', async () => {
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const resPromise = startStreamingProxyFetch(controller.signal)
    const socket = await waitForWebSocket()
    socket.emit({
      type: 'upstream_headers',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const res = await resPromise

    controller.abort()
    socket.close()

    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe('Aborted')
    expect(proxyDeleteCalls()).toHaveLength(1)
    expect(proxyDeleteCalls()[0]).toMatchObject({
      url: '/api/v1/proxy/stream-jobs/job%201',
      init: {
        method: 'DELETE',
        headers: {
          'risu-auth': 'proxy-auth-token',
        },
      },
    })
    expect(removeAbortListener).toHaveBeenCalledTimes(1)
  })

  it('closes normally on terminal done without DELETEing the finished job', async () => {
    const controller = new AbortController()
    const resPromise = startStreamingProxyFetch(controller.signal)
    const socket = await waitForWebSocket()
    socket.emit({
      type: 'upstream_headers',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const res = await resPromise

    socket.emitBinary(new TextEncoder().encode('hello'))
    socket.emit({ type: 'done' })
    controller.abort()

    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe('hello')
    expect(proxyDeleteCalls()).toHaveLength(0)
  })

  it('DELETEs the active proxy job when the response body consumer cancels', async () => {
    const resPromise = startStreamingProxyFetch()
    const socket = await waitForWebSocket()
    socket.emit({
      type: 'upstream_headers',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const res = await resPromise

    await res.body?.cancel('consumer stopped reading')

    expect(proxyDeleteCalls()).toHaveLength(1)
    expect(proxyDeleteCalls()[0]).toMatchObject({
      url: '/api/v1/proxy/stream-jobs/job%201',
      init: {
        method: 'DELETE',
        headers: {
          'risu-auth': 'proxy-auth-token',
        },
      },
    })
  })

  it('rejects and DELETEs the job when a malformed frame arrives after headers', async () => {
    const resPromise = startStreamingProxyFetch()
    const socket = await waitForWebSocket()
    socket.emit({
      type: 'upstream_headers',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const res = await resPromise

    socket.emit({ type: 'chunk', dataBase64: 42 })

    await expect(res.text()).rejects.toThrow('invalid protocol frame')
    expect(proxyDeleteCalls()).toHaveLength(1)
  })

  it('returns a terminal proxy error and DELETEs when a body chunk arrives before headers', async () => {
    const resPromise = startStreamingProxyFetch()
    const socket = await waitForWebSocket()

    socket.emitBinary(new TextEncoder().encode('out-of-order'))
    const res = await resPromise

    expect(res.status).toBe(502)
    await expect(res.text()).resolves.toBe('Proxy WebSocket sent a body chunk before upstream headers')
    expect(proxyDeleteCalls()).toHaveLength(1)
  })

  it('closes on terminal server error without DELETEing the finished job', async () => {
    const controller = new AbortController()
    const resPromise = startStreamingProxyFetch(controller.signal)
    const socket = await waitForWebSocket()

    socket.emit({ type: 'error', status: 503, message: 'upstream failed' })
    const res = await resPromise
    controller.abort()

    expect(res.status).toBe(503)
    await expect(res.text()).resolves.toBe('upstream failed')
    expect(proxyDeleteCalls()).toHaveLength(0)
  })

  it('rejects and DELETEs on WebSocket close before a terminal frame', async () => {
    const resPromise = startStreamingProxyFetch()
    const socket = await waitForWebSocket()
    socket.emit({
      type: 'upstream_headers',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const res = await resPromise

    socket.close()

    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow('closed before a terminal frame')
    expect(proxyDeleteCalls()).toHaveLength(1)
  })
})

// Each case starts on the conservative path unless it explicitly manages a session.
beforeEach(() => resetClientSessionForTests())

describe('generic network writer admission', () => {
  it('denies reader buffered, native and plugin requests without dispatch', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const args = { method: 'GET' as const }
    await expect(globalFetch('https://example.test', args)).resolves.toMatchObject({ ok: false, status: 400 })
    await expect(pluginGlobalFetch('https://example.test', args)).resolves.toMatchObject({ ok: false, status: 400 })
    await expect(fetchNative('https://example.test', args)).rejects.toThrow('client_write_access_required')
    await expect(pluginFetchNative('https://example.test', args)).rejects.toThrow('client_write_access_required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['buffered', 'native', 'stream-job'])(
    'does not dispatch a stale %s proxy request after auth',
    async (kind) => {
      setManagedWriterForTest()
      let release!: (value: string) => void
      proxyAuthMocks.auth.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const pending =
        kind === 'buffered'
          ? pluginGlobalFetch('https://example.test', { method: 'GET' })
          : kind === 'native'
            ? pluginFetchNative('https://example.test', { method: 'GET' })
            : fetchNative('http://127.0.0.1:9000', {
                method: 'POST',
                body: '{}',
                networkRoute: 'local_network',
                interceptor: 'openai_streaming',
              })
      demoteAndRepromoteForTest()
      release('old-auth')
      if (kind === 'buffered') await expect(pending).resolves.toMatchObject({ ok: false, status: 400 })
      else await expect(pending).rejects.toThrow('client_write_operation_stale')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})

it('does not delete an old proxy job when cancelled after repromotion', async () => {
  setManagedWriterForTest()
  const pending = startStreamingProxyFetch()
  const socket = await waitForWebSocket()
  socket.emit({ type: 'upstream_headers', status: 200, headers: { 'content-type': 'text/event-stream' } })
  const response = await pending
  demoteAndRepromoteForTest()
  await response.body?.cancel('reader closed old stream')
  await vi.waitFor(() => expect(socket.closeCalls).toBeGreaterThan(0))
  expect(proxyDeleteCalls()).toHaveLength(0)
})
