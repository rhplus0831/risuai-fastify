import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isForbiddenPluginNetworkAddress,
  requestPluginNetworkWithRedirects,
  requestResolvedPluginNetworkTarget,
  resolvePluginNetworkTarget,
  type PluginNetworkRedirectDependencies,
  type ResolvedPluginNetworkTarget,
} from '../src/pluginNetwork.js'

interface CapturedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
  localAddress: string | undefined
}

interface RedirectServer {
  port: number
  requests: CapturedRequest[]
  setResponder(responder: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void): void
  close(): Promise<void>
}

function startRedirectServer(): Promise<RedirectServer> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = []
    let responder: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void = (_req, res) => {
      res.writeHead(200)
      res.end('ok')
    }
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
          localAddress: req.socket.localAddress,
        })
        responder(req, res, body)
      })
    })
    server.listen(0, '0.0.0.0', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        setResponder(next) {
          responder = next
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

async function responseText(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function pinnedTestDependencies(): PluginNetworkRedirectDependencies {
  return {
    async resolveTarget(rawUrl): Promise<ResolvedPluginNetworkTarget> {
      const url = new URL(rawUrl)
      if (url.hostname === 'public-a.test' || url.hostname === 'public-b.test') {
        return { url, address: '127.0.0.1', family: 4 }
      }
      return resolvePluginNetworkTarget(rawUrl)
    },
    requestTarget: requestResolvedPluginNetworkTarget,
  }
}

let redirectServer: RedirectServer | undefined

afterEach(async () => {
  await redirectServer?.close()
  redirectServer = undefined
})

describe('plugin network target validation', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    '2001:db8::1',
  ])('classifies %s as forbidden', (address) => {
    expect(isForbiddenPluginNetworkAddress(address)).toBe(true)
  })

  it('accepts a public hostname only after all DNS answers are public', async () => {
    const resolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const },
    ])

    await expect(resolvePluginNetworkTarget('https://public.example/path', resolver)).resolves.toMatchObject({
      address: '93.184.216.34',
      family: 4,
    })
    expect(resolver).toHaveBeenCalledWith('public.example')
  })

  it.each([
    'http://127.0.0.1:6419/api/v1/bootstrap',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://metadata.google.internal/computeMetadata/v1',
    'https://api.risuai.xyz/private',
  ])('rejects direct private, metadata, mapped, or first-party target %s', async (url) => {
    await expect(resolvePluginNetworkTarget(url)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('rejects a public-looking hostname if any DNS answer is private', { tags: 'core' }, async () => {
    await expect(
      resolvePluginNetworkTarget('https://attacker.example', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('uses parsed hostname boundaries rather than substring matching', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }]
    await expect(
      resolvePluginNetworkTarget('https://risuai.xyz.attacker.example/path?next=risuai.xyz', resolver),
    ).resolves.toMatchObject({ address: '93.184.216.34' })
    await expect(resolvePluginNetworkTarget('https://sub.risuai.xyz/path', resolver)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('does not reuse a socket after a new target address is pinned', async () => {
    redirectServer = await startRedirectServer()
    const url = new URL(`http://public-a.test:${redirectServer.port}/pinned`)

    const first = await requestResolvedPluginNetworkTarget(
      { url, address: '127.0.0.1', family: 4 },
      { method: 'GET', headers: {} },
    )
    await responseText(first)
    const second = await requestResolvedPluginNetworkTarget(
      { url, address: '127.0.0.2', family: 4 },
      { method: 'GET', headers: {} },
    )
    await responseText(second)

    expect(redirectServer.requests.map((request) => request.localAddress)).toEqual(['127.0.0.1', '127.0.0.2'])
  })
})

describe('plugin network redirects', () => {
  it('follows a public redirect with fetch-compatible rewriting and strips cross-origin credentials', async () => {
    redirectServer = await startRedirectServer()
    redirectServer.setResponder((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, {
          location: `http://public-b.test:${redirectServer?.port}/final`,
        })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('redirected')
    })

    const response = await requestPluginNetworkWithRedirects(
      `http://public-a.test:${redirectServer.port}/start`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'proxy-authorization': 'Basic secret',
          'x-api-key': 'plugin-secret',
          'content-type': 'application/json',
          'content-length': '7',
          'x-plugin-header': 'kept',
        },
        body: Buffer.from('{"x":1}'),
      },
      pinnedTestDependencies(),
    )

    await expect(responseText(response)).resolves.toBe('redirected')
    expect(redirectServer.requests).toHaveLength(2)
    expect(redirectServer.requests[0]).toMatchObject({ method: 'POST', url: '/start' })
    expect(redirectServer.requests[0].body.toString()).toBe('{"x":1}')
    expect(redirectServer.requests[1]).toMatchObject({ method: 'GET', url: '/final' })
    expect(redirectServer.requests[1].body).toHaveLength(0)
    expect(redirectServer.requests[1].headers.host).toBe(`public-b.test:${redirectServer.port}`)
    expect(redirectServer.requests[1].headers.authorization).toBeUndefined()
    expect(redirectServer.requests[1].headers.cookie).toBeUndefined()
    expect(redirectServer.requests[1].headers['proxy-authorization']).toBeUndefined()
    expect(redirectServer.requests[1].headers['x-api-key']).toBeUndefined()
    expect(redirectServer.requests[1].headers['content-type']).toBeUndefined()
    expect(redirectServer.requests[1].headers['x-plugin-header']).toBe('kept')
  })

  it(
    'blocks a public redirect that pivots to the metadata service before the second connection',
    { tags: 'core' },
    async () => {
      redirectServer = await startRedirectServer()
      redirectServer.setResponder((_req, res) => {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
        res.end()
      })

      await expect(
        requestPluginNetworkWithRedirects(
          `http://public-a.test:${redirectServer.port}/start`,
          { method: 'GET', headers: {} },
          pinnedTestDependencies(),
        ),
      ).rejects.toMatchObject({ statusCode: 403 })
      expect(redirectServer.requests).toHaveLength(1)
    },
  )

  it('aborts while DNS resolution is pending without starting a connection', async () => {
    let finishResolution: ((target: ResolvedPluginNetworkTarget) => void) | undefined
    const requestTarget = vi.fn()
    const controller = new AbortController()
    const pending = requestPluginNetworkWithRedirects(
      'https://public.example/path',
      { method: 'GET', headers: {}, signal: controller.signal },
      {
        resolveTarget: () =>
          new Promise((resolve) => {
            finishResolution = resolve
          }),
        requestTarget,
      },
    )

    await vi.waitFor(() => expect(finishResolution).toBeTypeOf('function'))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestTarget).not.toHaveBeenCalled()
    finishResolution?.({
      url: new URL('https://public.example/path'),
      address: '93.184.216.34',
      family: 4,
    })
  })

  it('returns encoded response bytes unchanged for the proxy to stream', async () => {
    redirectServer = await startRedirectServer()
    const compressed = gzipSync(Buffer.from('encoded plugin payload'))
    redirectServer.setResponder((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' })
      res.end(compressed)
    })

    const response = await requestPluginNetworkWithRedirects(
      `http://public-a.test:${redirectServer.port}/gzip`,
      { method: 'GET', headers: {} },
      pinnedTestDependencies(),
    )
    const chunks: Buffer[] = []
    for await (const chunk of response) chunks.push(Buffer.from(chunk as Uint8Array))

    expect(response.headers['content-encoding']).toBe('gzip')
    expect(Buffer.concat(chunks)).toEqual(compressed)
  })
})
