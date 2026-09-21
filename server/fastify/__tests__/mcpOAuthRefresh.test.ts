import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import {
  MCP_OAUTH_REFRESH_REQUEST_BODY_LIMIT_BYTES,
  executeStoredMcpOAuthRefresh,
  parseMcpOAuthRefreshRequest,
  resolveStoredMcpOAuthRefreshRecord,
} from '../src/mcpOAuthRefresh.js'
import { resolveMcpOAuthRefreshAddresses } from '../src/mcpOAuthRefreshEgress.js'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'
import { createMcpOAuthRefreshDisconnectAbort } from '../src/routes/mcpOAuthRefresh.js'

const MCP_URL = 'https://mcp.example/messages'
const TOKEN_URL = 'https://auth.example/token'

const storedSettings = {
  authRefreshes: [
    {
      url: MCP_URL,
      tokenUrl: TOKEN_URL,
      refreshToken: 'stored-refresh-token',
      clientId: 'stored-client-id',
      clientSecret: 'stored-client-secret',
    },
  ],
}

function formBody(init: RequestInit): URLSearchParams {
  return new URLSearchParams(init.body as string)
}

describe('stored MCP OAuth refresh validation', () => {
  it('accepts only a bounded stable MCP identity request', () => {
    expect(parseMcpOAuthRefreshRequest({ url: MCP_URL })).toEqual({ url: MCP_URL })
    expect(parseMcpOAuthRefreshRequest({ url: 'stdio:{"url":"http://127.0.0.1:3010/messages"}' })).toEqual({
      url: 'stdio:{"url":"http://127.0.0.1:3010/messages"}',
    })

    for (const body of [
      null,
      {},
      { url: 'not-a-mcp-url' },
      { url: ` ${MCP_URL}` },
      { url: MASKED_PROVIDER_SECRET },
      { url: MCP_URL, tokenUrl: 'https://attacker.example/token' },
    ]) {
      expect(() => parseMcpOAuthRefreshRequest(body)).toThrow(
        expect.objectContaining({ code: 'invalid_mcp_oauth_refresh_request' }),
      )
    }
  })

  it('resolves the unique raw record by identity', () => {
    expect(resolveStoredMcpOAuthRefreshRecord(storedSettings, MCP_URL)).toEqual(storedSettings.authRefreshes[0])
    expect(() => resolveStoredMcpOAuthRefreshRecord(storedSettings, 'https://unknown.example/messages')).toThrow(
      expect.objectContaining({ code: 'mcp_oauth_refresh_not_found' }),
    )
  })

  it('rejects duplicate, malformed, extra-field, and masked stored records', () => {
    const valid = storedSettings.authRefreshes[0]
    const invalidSettings = [
      { authRefreshes: [valid, { ...valid }] },
      { authRefreshes: [{ ...valid, url: 'not-a-url' }] },
      { authRefreshes: [{ ...valid, unexpected: true }] },
      { authRefreshes: [{ ...valid, refreshToken: MASKED_PROVIDER_SECRET }] },
      { authRefreshes: [{ ...valid, clientSecret: MASKED_PROVIDER_SECRET }] },
      { authRefreshes: [{ ...valid, tokenUrl: 'file:///tmp/token' }] },
      { authRefreshes: [{ ...valid, tokenUrl: 'https://user:password@auth.example/token' }] },
      { authRefreshes: [{ ...valid, tokenUrl: 'https://auth.example/token#credentials' }] },
    ]

    for (const settings of invalidSettings) {
      expect(() => resolveStoredMcpOAuthRefreshRecord(settings, MCP_URL)).toThrow(
        expect.objectContaining({ code: 'mcp_oauth_refresh_configuration_invalid' }),
      )
    }
  })
})

describe('stored MCP OAuth refresh execution', () => {
  it('posts only the raw stored refresh fields and returns only the access token', async () => {
    const onRotatedRefreshToken = vi.fn()
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: 'fresh-access-token',
            refresh_token: 'rotated-refresh-token-that-must-not-return',
            token_type: 'Bearer',
          }),
        ),
    )

    await expect(
      executeStoredMcpOAuthRefresh({ url: MCP_URL }, storedSettings, {
        fetchImpl: fetchImpl as typeof fetch,
        onRotatedRefreshToken,
      }),
    ).resolves.toEqual({ accessToken: 'fresh-access-token' })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(TOKEN_URL)
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    })
    expect(formBody(init).get('grant_type')).toBe('refresh_token')
    expect(formBody(init).get('refresh_token')).toBe('stored-refresh-token')
    expect(formBody(init).get('client_id')).toBe('stored-client-id')
    expect(formBody(init).get('client_secret')).toBe('stored-client-secret')
    expect(init.signal?.aborted).toBe(false)
    expect(onRotatedRefreshToken).toHaveBeenCalledWith({
      url: MCP_URL,
      previousRefreshToken: 'stored-refresh-token',
      refreshToken: 'rotated-refresh-token-that-must-not-return',
    })
  })

  it('sanitizes upstream failures and rejects malformed or oversized token responses', async () => {
    await expect(
      executeStoredMcpOAuthRefresh({ url: MCP_URL }, storedSettings, {
        fetchImpl: (async () =>
          new Response('diagnostic containing stored-refresh-token', { status: 401 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'mcp_oauth_refresh_failed', statusCode: 502, upstreamStatus: 401 })

    for (const response of [
      new Response('not-json'),
      new Response(JSON.stringify({ access_token: '' })),
      new Response(JSON.stringify({ token_type: 'Bearer' })),
      new Response(JSON.stringify({ access_token: 'fresh-access-token', refresh_token: '' })),
    ]) {
      await expect(
        executeStoredMcpOAuthRefresh({ url: MCP_URL }, storedSettings, {
          fetchImpl: (async () => response) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'mcp_oauth_refresh_invalid_response', statusCode: 502 })
    }

    await expect(
      executeStoredMcpOAuthRefresh({ url: MCP_URL }, storedSettings, {
        fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'fresh-access-token' }))) as typeof fetch,
        maxResponseBytes: 5,
      }),
    ).rejects.toMatchObject({ code: 'mcp_oauth_refresh_invalid_response', statusCode: 502 })
  })

  it('bounds the upstream deadline and propagates caller cancellation', async () => {
    const hangingFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        }),
    )

    await expect(
      executeStoredMcpOAuthRefresh({ url: MCP_URL }, storedSettings, {
        fetchImpl: hangingFetch as typeof fetch,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'mcp_oauth_refresh_timeout', statusCode: 504 })

    const cancellation = new AbortController()
    const cancelled = executeStoredMcpOAuthRefresh({ url: MCP_URL }, storedSettings, {
      fetchImpl: hangingFetch as typeof fetch,
      signal: cancellation.signal,
    })
    cancellation.abort()

    await expect(cancelled).rejects.toMatchObject({ code: 'mcp_oauth_refresh_cancelled', statusCode: 499 })
    expect((hangingFetch.mock.calls[1][1] as RequestInit).signal?.aborted).toBe(true)
  })

  it('preserves local HTTP OAuth for a local stdio MCP identity', async () => {
    let receivedBody = ''
    const tokenServer = createServer((request, response) => {
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        receivedBody += chunk
      })
      request.on('end', () => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ access_token: 'local-access-token' }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      tokenServer.once('error', reject)
      tokenServer.listen(0, '127.0.0.1', resolve)
    })
    const address = tokenServer.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP token server')
    const identity = `stdio:{"url":"http://127.0.0.1:${address.port}/messages"}`
    const settings = {
      authRefreshes: [
        {
          ...storedSettings.authRefreshes[0],
          url: identity,
          tokenUrl: `http://127.0.0.1:${address.port}/token`,
        },
      ],
    }

    try {
      await expect(executeStoredMcpOAuthRefresh({ url: identity }, settings)).resolves.toEqual({
        accessToken: 'local-access-token',
      })
      expect(new URLSearchParams(receivedBody).get('refresh_token')).toBe('stored-refresh-token')
    } finally {
      await new Promise<void>((resolve) => tokenServer.close(() => resolve()))
    }
  })

  it('does not let a public MCP identity select a local token endpoint', async () => {
    const settings = {
      authRefreshes: [{ ...storedSettings.authRefreshes[0], tokenUrl: 'http://127.0.0.1:43119/token' }],
    }
    await expect(executeStoredMcpOAuthRefresh({ url: MCP_URL }, settings)).rejects.toMatchObject({
      code: 'mcp_oauth_refresh_failed',
      statusCode: 502,
    })
  })

  it('does not treat an unrelated stdio wrapper as a local MCP identity', async () => {
    const identity = 'stdio:{"url":"https://mcp.example/messages"}'
    const settings = {
      authRefreshes: [
        {
          ...storedSettings.authRefreshes[0],
          url: identity,
          tokenUrl: 'http://127.0.0.1:43119/token',
        },
      ],
    }
    await expect(executeStoredMcpOAuthRefresh({ url: identity }, settings)).rejects.toMatchObject({
      code: 'mcp_oauth_refresh_failed',
      statusCode: 502,
    })
  })
})

describe('MCP OAuth refresh egress validation', () => {
  const publicLookup = async (): Promise<Array<{ address: string; family: number }>> => [
    { address: '93.184.216.34', family: 4 },
  ]
  const localLookup = async (): Promise<Array<{ address: string; family: number }>> => [
    { address: '127.0.0.1', family: 4 },
  ]

  it('allows public HTTPS and explicitly local HTTP targets', async () => {
    await expect(
      resolveMcpOAuthRefreshAddresses('https://auth.example/token', { lookup: publicLookup }),
    ).resolves.toMatchObject({ addresses: ['93.184.216.34'] })
    await expect(
      resolveMcpOAuthRefreshAddresses('http://localhost:3000/token', {
        allowLocalTarget: true,
        lookup: localLookup,
      }),
    ).resolves.toMatchObject({ addresses: ['127.0.0.1'] })
  })

  it('rejects local targets for public identities, public HTTP, mixed DNS, userinfo, and fragments', async () => {
    const mixedLookup = async (): Promise<Array<{ address: string; family: number }>> => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]
    for (const promise of [
      resolveMcpOAuthRefreshAddresses('https://localhost/token', { lookup: localLookup }),
      resolveMcpOAuthRefreshAddresses('http://auth.example/token', {
        allowLocalTarget: true,
        lookup: publicLookup,
      }),
      resolveMcpOAuthRefreshAddresses('https://auth.example/token', {
        allowLocalTarget: true,
        lookup: mixedLookup,
      }),
      resolveMcpOAuthRefreshAddresses('https://user:password@auth.example/token', { lookup: publicLookup }),
      resolveMcpOAuthRefreshAddresses('https://auth.example/token#fragment', { lookup: publicLookup }),
    ]) {
      await expect(promise).rejects.toThrow('unsafe MCP OAuth token URL')
    }
  })

  it('rejects IPv6 link-local and deprecated site-local targets even when local OAuth is allowed', async () => {
    for (const address of ['fe80::1', 'fec0::1']) {
      await expect(
        resolveMcpOAuthRefreshAddresses(`https://[${address}]/token`, { allowLocalTarget: true }),
      ).rejects.toThrow('unsafe MCP OAuth token URL')
    }
  })

  it('propagates cancellation while DNS resolution is pending', async () => {
    const cancellation = new AbortController()
    const pending = resolveMcpOAuthRefreshAddresses(
      'https://auth.example/token',
      {
        lookup: async () => await new Promise<Array<{ address: string; family: number }>>(() => undefined),
      },
      cancellation.signal,
    )
    cancellation.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('MCP OAuth refresh disconnect handling', () => {
  it('ignores normal request completion and aborts an unfinished response close', () => {
    const request = Object.assign(new EventEmitter(), { complete: true })
    const response = Object.assign(new EventEmitter(), { writableEnded: false })
    const disconnect = createMcpOAuthRefreshDisconnectAbort(request, response)

    request.emit('close')
    expect(disconnect.signal.aborted).toBe(false)

    response.emit('close')
    expect(disconnect.signal.aborted).toBe(true)
    disconnect.cleanup()
  })
})

interface Harness {
  app: FastifyInstance
  dataDir: string
}

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!
    await harness.app.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
  }
})

async function startHarness(fetchImpl: typeof fetch, commandEvents?: CommandEventSink): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-mcp-oauth-refresh-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      agentDevAuthBypass: true,
    },
    memoryWorker: false,
    assetGc: false,
    ...(commandEvents ? { commandEvents } : {}),
    mcpOAuthRefresh: { fetchImpl },
  })
  await app.ready()
  const harness = { app, dataDir }
  harnesses.push(harness)
  return harness
}

async function seedRefreshRecord(app: FastifyInstance): Promise<void> {
  const initialized = await app.inject({
    method: 'POST',
    url: '/api/v1/commands/state/initialize',
    payload: {},
  })
  expect(initialized.statusCode, initialized.body).toBe(200)
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/v1/commands/settings/providers',
    payload: {
      baseRevision: initialized.json().revision,
      patch: storedSettings,
    },
  })
  expect(patched.statusCode, patched.body).toBe(200)
}

describe('POST /api/v1/mcp/oauth/refresh', () => {
  it('loads the raw SQLite row without returning refresh credentials', { tags: 'core' }, async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ access_token: 'route-access-token' }))),
    )
    const harness = await startHarness(fetchImpl as typeof fetch)
    await seedRefreshRecord(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/oauth/refresh',
      payload: { url: MCP_URL },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ accessToken: 'route-access-token' })
    expect(response.body).not.toContain('stored-refresh-token')
    expect(response.body).not.toContain('stored-client-secret')
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(formBody(init).get('refresh_token')).toBe('stored-refresh-token')
    expect(formBody(init).get('client_secret')).toBe('stored-client-secret')
    expect(init.signal?.aborted).toBe(false)
  })

  it('persists a rotated refresh token and uses it on the next stored refresh', async () => {
    const refreshTokens: string[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const refreshToken = formBody(init ?? {}).get('refresh_token') ?? ''
      refreshTokens.push(refreshToken)
      return new Response(
        JSON.stringify(
          refreshTokens.length === 1
            ? { access_token: 'first-access-token', refresh_token: 'rotated-refresh-token' }
            : { access_token: 'second-access-token' },
        ),
      )
    })
    const commandEvents = createCommandEventSink()
    const harness = await startHarness(fetchImpl as typeof fetch, commandEvents)
    await seedRefreshRecord(harness.app)
    commandEvents.clear()

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/oauth/refresh',
      payload: { url: MCP_URL },
    })
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/oauth/refresh',
      payload: { url: MCP_URL },
    })

    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toEqual({ accessToken: 'first-access-token' })
    expect(first.body).not.toContain('rotated-refresh-token')
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json()).toEqual({ accessToken: 'second-access-token' })
    expect(refreshTokens).toEqual(['stored-refresh-token', 'rotated-refresh-token'])
    expect(commandEvents.list()).toEqual([
      expect.objectContaining({ type: 'settings.updated', resource: 'settings', id: 'providers' }),
    ])
  })

  it('returns only sanitized upstream failure metadata', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('secret diagnostic containing stored-refresh-token', { status: 403 }),
    )
    const harness = await startHarness(fetchImpl as typeof fetch)
    await seedRefreshRecord(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/oauth/refresh',
      payload: { url: MCP_URL },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'mcp_oauth_refresh_failed', upstreamStatus: 403 })
    expect(response.body).not.toContain('secret diagnostic')
    expect(response.body).not.toContain('stored-refresh-token')
  })

  it('enforces the small route-specific body limit before loading credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'unused' })))
    const harness = await startHarness(fetchImpl as typeof fetch)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/oauth/refresh',
      payload: { url: `https://mcp.example/${'x'.repeat(MCP_OAUTH_REFRESH_REQUEST_BODY_LIMIT_BYTES)}` },
    })

    expect(response.statusCode).toBe(413)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
