import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_DIAGNOSTICS_MAX_BYTES, type RemoteDiagnosticsResponse } from '@risuai/protocol/remote-diagnostics'
import {
  fetchRemoteDiagnostics,
  parseRemoteDiagnosticsArguments,
  readRemoteDiagnosticsConfig,
} from './diagnostics-remote.js'

const token = 'b7'.repeat(32)
const canary = 'PRIVATE_CHAT_PRESET_BODY_HEADER_ERROR_CANARY'
const instanceId = '8d'.repeat(16)
const envelope: RemoteDiagnosticsResponse = {
  version: 1,
  serverTime: 1000,
  identity: { build: 'unknown', instanceId },
  entries: [
    {
      sequence: 1,
      receivedAt: 1000,
      instanceId,
      entry: { timestamp: 1000, source: 'server', level: 'error', event: 'http', statusCode: 503, durationMs: 120 },
    },
  ],
  sources: { server: 'volatile', browser: 'not-supported' },
  capture: { from: 1000, to: 1000 },
  loss: { dropped: 0, rejected: 0, pruned: 0, truncated: false },
  pagination: { nextCursor: null, snapshotSequence: 1, lastSequence: 1 },
}
type Handler = (request: IncomingMessage, response: ServerResponse) => void
type CliResult = { code: number | string; stdout: string; stderr: string }

describe('remote diagnostics helper with real HTTPS and CLI processes', () => {
  let directory: string
  let certificatePath: string
  let configPath: string
  let server: Server
  let redirectTarget: Server
  let origin: string
  let targetOrigin: string
  let handler: Handler
  let requests: { url: string | undefined; authorization: string | undefined }[]
  let targetRequests = 0

  function writeConfig(value: unknown = { version: 1, origin, token }): void {
    writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 })
    chmodSync(configPath, 0o600)
  }

  function run(args: string[] = [], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RISU_DIAGNOSTICS_REMOTE_CONFIG: configPath,
      NODE_EXTRA_CA_CERTS: certificatePath,
      ...envOverrides,
    }
    delete env.NODE_OPTIONS
    return new Promise((resolveResult) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', resolve('util/diagnostics-remote.ts'), ...args],
        {
          env,
          timeout: 15_000,
          maxBuffer: 2 * REMOTE_DIAGNOSTICS_MAX_BYTES,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => resolveResult({ code: error?.code ?? 0, stdout, stderr }),
      )
    })
  }

  function expectSafeFailure(result: CliResult, category: string): void {
    expect(result).toEqual({ code: 1, stdout: '', stderr: `${category}\n` })
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary)
    expect(`${result.stdout}${result.stderr}`).not.toContain(token)
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'risu-diagnostics-helper-'))
    certificatePath = join(directory, 'fixture-cert.pem')
    configPath = join(directory, 'remote.json')
    const keyPath = join(directory, 'fixture-key.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certificatePath,
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-days',
        '1',
      ],
      { stdio: 'pipe' },
    )
    const options = { key: readFileSync(keyPath), cert: readFileSync(certificatePath) }
    server = createServer(options, (request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization })
      handler(request, response)
    })
    redirectTarget = createServer(options, (_request, response) => {
      targetRequests++
      response.end(canary)
    })
    await Promise.all(
      [server, redirectTarget].map(
        (listener) => new Promise<void>((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen)),
      ),
    )
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    targetOrigin = `https://127.0.0.1:${(redirectTarget.address() as AddressInfo).port}`
  }, 15_000)

  beforeEach(() => {
    requests = []
    targetRequests = 0
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(envelope))
    }
    writeConfig()
  })

  afterAll(async () => {
    await Promise.all(
      [server, redirectTarget].map(
        (listener) =>
          new Promise<void>((resolveClose) => {
            listener.closeAllConnections()
            listener.close(() => resolveClose())
          }),
      ),
    )
    rmSync(directory, { recursive: true, force: true })
  })

  it('fetches seeded sanitized evidence using the real CLI and configured HTTPS origin', async () => {
    const result = await run(['--from=0', '--to', '2000', '--limit', '1'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual(envelope)
    expect(requests).toEqual([
      { url: '/api/v1/support/diagnostics?from=0&to=2000&limit=1', authorization: `Bearer ${token}` },
    ])
    expect(result.stdout).not.toContain(token)
    expect(result.stdout).not.toContain(canary)
  })

  it('fetches request-correlated v2 display performance through the real CLI', async () => {
    const requestUid = 'a'.repeat(64)
    const value: RemoteDiagnosticsResponse = {
      ...envelope,
      version: 2,
      clock: { ordering: 'server-sequence', browserTime: 'client-asserted', skew: 'unknown' },
      collection: { pending: 0, operationContinuity: 'retained' },
      entries: [
        {
          sequence: 1,
          receivedAt: 1000,
          instanceId,
          provenance: { kind: 'server' },
          entry: {
            timestamp: 1000,
            source: 'server',
            level: 'info',
            correlation: 'request',
            requestUid,
            category: 'display-performance',
            outcome: 'ok',
            durationMs: 185,
            queueWaitMs: 2,
            queueDepth: 0,
            targetCount: 2,
            visitedTargetCount: 2,
            executedTargetCount: 0,
            cacheHitCount: 2,
            cacheMissCount: 0,
            inflightJoinCount: 0,
            streamingBypassCount: 0,
            resultCounts: { ok: 2, clientFallback: 0, stale: 0, error: 0 },
            timings: { scopeLoadMs: 170, scopeDecodeMs: 1, sharedDependencyMs: 10 },
          },
        },
      ],
    }
    handler = (_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(value))
    }
    const result = await run(['--version=2', '--category=display-performance', `--requestUid=${requestUid}`])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual(value)
    expect(requests[0].url).toBe(
      `/api/v1/support/diagnostics?version=2&category=display-performance&requestUid=${requestUid}`,
    )
    expect(result.stdout).not.toContain(token)
  })

  it.each(['gzip', 'deflate', 'br'] as const)(
    'validates %s encoded responses after decompression',
    async (encoding) => {
      const compress = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }[encoding]
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': encoding })
        response.end(compress(JSON.stringify(envelope)))
      }
      const result = await run()
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual(envelope)
    },
  )

  it('distinguishes a valid empty result and preserves explicit truncation and losses', async () => {
    const value = { ...envelope, entries: [], loss: { dropped: 4, rejected: 2, pruned: 3, truncated: true } }
    handler = (_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(value))
    }
    const result = await run()
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(value)
  })

  it('fails closed for untrusted TLS and an environment that disables verification', async () => {
    expectSafeFailure(await run([], { NODE_EXTRA_CA_CERTS: undefined }), 'tls-error')
    expectSafeFailure(await run([], { NODE_EXTRA_CA_CERTS: undefined, NODE_TLS_REJECT_UNAUTHORIZED: '0' }), 'tls-error')
    expect(requests).toEqual([])
  }, 15_000)

  it('reports an unavailable server without connection details or configuration contents', async () => {
    const unavailable = createServer()
    await new Promise<void>((resolveListen) => unavailable.listen(0, '127.0.0.1', resolveListen))
    const port = (unavailable.address() as AddressInfo).port
    await new Promise<void>((resolveClose) => unavailable.close(() => resolveClose()))
    writeConfig({ version: 1, origin: `https://127.0.0.1:${port}`, token })
    expectSafeFailure(await run(), 'server-unavailable')
    expect(requests).toEqual([])
  })

  it('rejects redirects before following or forwarding any credential', async () => {
    handler = (_request, response) => {
      response.writeHead(302, {
        Location: `${targetOrigin}/${canary}`,
        'Content-Type': 'text/html',
        'X-Private': canary,
      })
      response.end(`${canary}${token}`)
    }
    expectSafeFailure(await run(), 'redirect-rejected')
    expect(requests).toHaveLength(1)
    expect(targetRequests).toBe(0)
  })

  it.each([
    'disabled',
    'unauthorized',
    'invalid-query',
    'rate-limited',
    'collection-disabled',
    'cursor-expired',
    'storage-unavailable',
    'internal-error',
  ])('prints only the fixed remote %s category', async (error) => {
    handler = (_request, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json', 'X-Private': `${canary}${token}` })
      response.end(JSON.stringify({ error }))
    }
    expectSafeFailure(await run(), error)
  })

  it.each([
    { status: 500, type: 'text/html', body: `<html>${canary}${token}</html>` },
    {
      status: 500,
      type: 'application/json',
      body: JSON.stringify({ error: 'unauthorized', message: `${canary}${token}` }),
    },
    { status: 200, type: 'application/json', body: JSON.stringify({ ...envelope, body: `${canary}${token}` }) },
    {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        ...envelope,
        entries: [{ ...envelope.entries[0], entry: { ...envelope.entries[0].entry, message: `${canary}${token}` } }],
      }),
    },
    { status: 200, type: 'application/json', body: JSON.stringify({ ...envelope, version: 99 }) },
    { status: 200, type: 'application/json', body: `${canary}${token}` },
  ])('discards untrusted error bodies, fields and versions %#', async ({ status, type, body }) => {
    handler = (_request, response) => {
      response.writeHead(status, { 'Content-Type': type })
      response.end(body)
    }
    expectSafeFailure(await run(), 'bad-response')
  })

  it('enforces advertised and streamed wire-byte limits', async () => {
    handler = (_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': REMOTE_DIAGNOSTICS_MAX_BYTES + 1,
      })
      response.end(`${canary}${token}`)
    }
    expectSafeFailure(await run(), 'response-too-large')
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write(' '.repeat(REMOTE_DIAGNOSTICS_MAX_BYTES))
      response.end(`${canary}${token}`)
    }
    expectSafeFailure(await run(), 'response-too-large')
  })

  it('rejects unverified dynamic code coordinates even when the manual v1 schema permits them', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          ...envelope,
          entries: [
            {
              ...envelope.entries[0],
              entry: { ...envelope.entries[0].entry, locations: [`src/${canary}${token}.ts:1:2`] },
            },
          ],
        }),
      )
    }
    expectSafeFailure(await run(), 'bad-response')
  })

  it('stops a gzip expansion bomb at the expanded-byte ceiling', async () => {
    const compressed = gzipSync(`${' '.repeat(REMOTE_DIAGNOSTICS_MAX_BYTES)}${canary}${token}`)
    expect(compressed.length).toBeLessThan(REMOTE_DIAGNOSTICS_MAX_BYTES)
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
      response.end(compressed)
    }
    expectSafeFailure(await run(), 'response-too-large')
  })

  it('rejects truncated HTTP and gzip streams even when their prefix looks valid', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 4096 })
      response.end(JSON.stringify(envelope))
    }
    expectSafeFailure(await run(), 'bad-response')
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
      response.end(gzipSync(JSON.stringify(envelope)).subarray(0, -4))
    }
    expectSafeFailure(await run(), 'bad-response')
  })

  it('bounds the whole request deadline even while a server keeps sending bytes', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      const interval = setInterval(() => response.write(' '), 50)
      response.once('close', () => clearInterval(interval))
    }
    expectSafeFailure(await run(), 'timeout')
  }, 15_000)

  it('rejects duplicate, unknown, invalid and destination flags before any network access', async () => {
    for (const args of [
      ['--origin', `${targetOrigin}/${canary}`],
      ['--token', token],
      ['--limit=1', '--limit=2'],
      ['--limit=201'],
      ['--raw=true'],
      ['--requestUid', canary],
      ['--cursor', instanceId, '--from=0'],
    ]) {
      expect(() => parseRemoteDiagnosticsArguments(args)).toThrow('invalid-query')
    }
    expectSafeFailure(await run(['--origin', `${targetOrigin}/${canary}`]), 'invalid-query')
    expect(requests).toEqual([])
    expect(parseRemoteDiagnosticsArguments(['--', '--cursor', instanceId, '--version=1'])).toEqual({
      cursor: instanceId,
      version: '1',
    })
  })

  it('accepts only the bounded private config file and does not echo bad content', async () => {
    expect(readRemoteDiagnosticsConfig(configPath)).toEqual({ version: 1, origin, token })
    chmodSync(configPath, 0o644)
    expectSafeFailure(await run(), 'config-error')
    writeConfig()
    const symlinkPath = join(directory, 'remote-link.json')
    symlinkSync(configPath, symlinkPath)
    expectSafeFailure(await run([], { RISU_DIAGNOSTICS_REMOTE_CONFIG: symlinkPath }), 'config-error')
    const linkedDirectory = join(directory, 'linked')
    symlinkSync(directory, linkedDirectory)
    expect(() => readRemoteDiagnosticsConfig(join(linkedDirectory, 'remote.json'))).toThrow('config-error')
    writeFileSync(configPath, `${canary}${token}${' '.repeat(4096)}`)
    expectSafeFailure(await run(), 'config-error')
    expectSafeFailure(await run([], { RISU_DIAGNOSTICS_REMOTE_CONFIG: undefined }), 'config-error')
  }, 15_000)

  it('rejects credentials, paths, queries, fragments and insecure origins in the config', async () => {
    for (const badOrigin of [
      origin.replace('https:', 'http:'),
      `${origin}/${canary}`,
      `${origin}/?q=${canary}`,
      `${origin}/#${canary}`,
      origin.replace('https://', `https://${canary}@`),
      `${origin}/?`,
      `${origin}/#`,
      `${origin}/./`,
    ]) {
      writeConfig({ version: 1, origin: badOrigin, token })
      expect(() => readRemoteDiagnosticsConfig(configPath)).toThrow('config-error')
    }
    writeConfig({ version: 1, origin, token, extra: canary })
    expectSafeFailure(await run(), 'config-error')
    expect(requests).toEqual([])
  })

  it('validates config and query for reusable integration callers too', async () => {
    await expect(fetchRemoteDiagnostics({ version: 1, origin: targetOrigin, token: canary })).rejects.toThrow(
      'config-error',
    )
    await expect(fetchRemoteDiagnostics({ version: 1, origin, token }, { raw: canary })).rejects.toThrow(
      'invalid-query',
    )
    expect(targetRequests).toBe(0)
    expect(requests).toEqual([])
  })
})
