import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MASKED_PROVIDER_SECRET } from '../providerSecretMask'
import { requestStoredMcpOAuthRefresh } from './mcpOAuthRefresh'

const proxyAuth = vi.hoisted(() => vi.fn(async () => 'browser-auth'))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: proxyAuth,
}))

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('requestStoredMcpOAuthRefresh', () => {
  beforeEach(() => {
    proxyAuth.mockClear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts only the stable MCP identity with browser authentication', async () => {
    const identity = 'stdio:{"url":"http://127.0.0.1:3010/messages"}'
    fetchMock.mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh-access-token' }))

    await expect(requestStoredMcpOAuthRefresh(identity)).resolves.toBe('fresh-access-token')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/mcp/oauth/refresh')
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'risu-auth': 'browser-auth',
      },
    })
    expect(JSON.parse(init.body as string)).toEqual({ url: identity })
    expect(init.body).not.toContain('refreshToken')
    expect(init.body).not.toContain('clientSecret')
    expect(init.body).not.toContain(MASKED_PROVIDER_SECRET)
  })

  it('propagates cancellation before and during the request', async () => {
    const before = new AbortController()
    before.abort(new DOMException('cancelled', 'AbortError'))
    await expect(
      requestStoredMcpOAuthRefresh('https://mcp.example/messages', { signal: before.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()

    let capturedSignal: AbortSignal | undefined
    fetchMock.mockImplementationOnce(
      async (_url: string, init: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          capturedSignal = init.signal ?? undefined
          capturedSignal?.addEventListener('abort', () => reject(capturedSignal?.reason), { once: true })
        }),
    )
    const during = new AbortController()
    const pending = requestStoredMcpOAuthRefresh('https://mcp.example/messages', { signal: during.signal })
    await vi.waitFor(() => expect(capturedSignal).toBe(during.signal))
    during.abort(new DOMException('cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('sanitizes failures and rejects malformed, masked, or oversized responses', async () => {
    const secretCanary = 'leaked-refresh-token'
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: secretCanary }, 502))
    const error = await requestStoredMcpOAuthRefresh('https://mcp.example/messages').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Stored MCP OAuth refresh failed (502)')
    expect((error as Error).message).not.toContain(secretCanary)

    for (const response of [
      new Response('not-json'),
      jsonResponse({ accessToken: '' }),
      jsonResponse({ accessToken: MASKED_PROVIDER_SECRET }),
      jsonResponse({ accessToken: 'valid', refreshToken: 'must-not-return' }),
      jsonResponse({ accessToken: 'x'.repeat(65 * 1024) }),
    ]) {
      fetchMock.mockResolvedValueOnce(response)
      await expect(requestStoredMcpOAuthRefresh('https://mcp.example/messages')).rejects.toThrow(
        'Stored MCP OAuth refresh response was malformed',
      )
    }
  })

  it('rejects masked or malformed identities before sending a request', async () => {
    for (const identity of ['', ` ${MASKED_PROVIDER_SECRET}`, MASKED_PROVIDER_SECRET]) {
      await expect(requestStoredMcpOAuthRefresh(identity)).rejects.toThrow(
        'Stored MCP OAuth refresh identity was invalid',
      )
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
