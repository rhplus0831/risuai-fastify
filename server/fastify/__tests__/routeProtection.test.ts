import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ACTIVE_WRITER_SESSION_HEADER } from '../src/activeWriter.js'
import { parseRouteTree } from './helpers/routeCatalog.js'
import {
  findProtocolRouteDecision,
  findProtocolRouteDecisions,
  isProtocolMutatingMethod,
  protocolRouteMatches,
  PROTOCOL_ROUTE_MANIFEST,
  PROTOCOL_ROUTE_POLICIES,
} from '../src/routeManifest.js'
import { assetExistsRateLimit, authLoginRateLimit, generationSubmitRateLimit } from '../src/routeRateLimits.js'

// Table-wide protection invariants for the Fastify port.
//
// Auth (`requireAuth`) stays explicit in route handlers, while route ownership
// decisions live in the protocol manifest. These tests derive the route set from
// the running app (`printRoutes`) and make every API route carry a manifest
// decision, then enforce the auth decisions against the live handlers.

const subtle = webcrypto.subtle

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-route-protection-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    memoryWorker: false,
  })
  await app.ready()
  return { app, dataDir }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

type InjectMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/** Replace `:param` route segments with a concrete placeholder so inject hits it. */
function concreteUrl(path: string): string {
  return path.replace(/:[^/]+/g, 'x').replace(/\*/g, 'x')
}

async function setupPassword(app: FastifyInstance): Promise<string> {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'hunter2' },
  })
  expect(setup.statusCode).toBe(200)

  const keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await subtle.exportKey('jwk', keypair.publicKey)
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'hunter2', publicKey },
  })
  expect(login.statusCode).toBe(200)

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', typ: 'JWT' }
  const payload = { iat: now, exp: now + 60, pub: publicKey }
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const signingInput = `${b64(header)}.${b64(payload)}`
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    keypair.privateKey,
    Buffer.from(signingInput),
  )
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
}

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  await stopHarness(harness)
})

describe('route protection (table-wide auth enforcement)', () => {
  it('keeps public and conditional auth exceptions within the independently reviewed allowlist', () => {
    const reviewedExceptions = [
      'health:public',
      'auth-status:public',
      'auth-setup:public',
      'auth-login:public',
      'auth-crypto:public',
      'support-diagnostics-read:diagnostics-read',
      'asset-read:public',
      'asset-exists:public',
      'push-vapid-public-key:public',
      'hub-proxy:conditional',
    ]
    const actualExceptions = PROTOCOL_ROUTE_MANIFEST.filter((entry) => entry.auth.decision !== 'required').map(
      (entry) => `${entry.id}:${entry.auth.decision}`,
    )

    expect(actualExceptions).toEqual(reviewedExceptions)
  })

  it('keeps mutating active-writer exceptions within the independently reviewed allowlist', () => {
    const reviewedExceptions = [
      'auth-setup:auth-session',
      'auth-login:auth-session',
      'auth-crypto:stateless-helper',
      'startup-telemetry:stateless-helper',
      'settings-cache-read:read-only-post',
      'settings-group-cache-read:read-only-post',
      'collections-cache-read:read-only-post',
      'collection-cache-read:read-only-post',
      'character-aggregate-cache-read:read-only-post',
      'characters-cache-read:read-only-post',
      'chat-messages-bulk-read:read-only-post',
      'chat-display-sources:read-only-post',
      'character-lorebook-cache-read:read-only-post',
      'character-lorebooks-bulk-read:read-only-post',
      'legacy-preset-cache-read:read-only-post',
      'prompt-preset-template-cache-read:read-only-post',
      'asset-exists:read-only-post',
      'push-subscription-create:auth-session',
      'push-subscription-delete:auth-session',
      'mcp-oauth-refresh:runtime-proxy',
      'embedding-operations:runtime-proxy',
      'provider-operations:runtime-proxy',
      'openai-transcription:runtime-proxy',
      'tts-synthesis:runtime-proxy',
      'image-generation:runtime-generation',
      'proxy-fetch:runtime-proxy',
      'proxy-plugin-fetch:runtime-proxy',
      'proxy-stream-job-create:runtime-proxy',
      'proxy-stream-job-cancel:runtime-proxy',
      'hub-proxy:runtime-proxy',
      'generation-completion:runtime-generation',
    ]
    const actualExceptions = PROTOCOL_ROUTE_MANIFEST.filter(
      (entry) => entry.methods.some(isProtocolMutatingMethod) && entry.activeWriter.decision !== 'active-writer',
    ).map((entry) => `${entry.id}:${entry.activeWriter.decision}`)

    expect(actualExceptions).toEqual(reviewedExceptions)
  })

  it('has a protocol-manifest decision for every live API route', async () => {
    const routes = parseRouteTree(harness.app.printRoutes({ commonPrefix: false }))
    const unclassified = routes
      .filter((route) => route.path.startsWith('/api/v1/'))
      .filter((route) => !findProtocolRouteDecision(route.method, route.path))
      .map((route) => `${route.method} ${route.path}`)

    expect(unclassified).toEqual([])
  })

  it('keeps live routes, shared operations, and server policy bidirectionally unique', () => {
    const routes = parseRouteTree(harness.app.printRoutes({ commonPrefix: false })).filter((route) =>
      route.path.startsWith('/api/v1/'),
    )
    const ambiguousOrMissing = routes
      .map((route) => ({ route, decisions: findProtocolRouteDecisions(route.method, route.path) }))
      .filter(({ decisions }) => decisions.length !== 1)
      .map(({ route, decisions }) => `${route.method} ${route.path} -> ${decisions.map(({ id }) => id).join(',')}`)
    const stale = PROTOCOL_ROUTE_MANIFEST.filter(
      (entry) => !routes.some((route) => protocolRouteMatches(entry, route.method, route.path)),
    ).map(({ id }) => id)
    const manifestIds = PROTOCOL_ROUTE_MANIFEST.map(({ id }) => id)
    const policyIds = PROTOCOL_ROUTE_POLICIES.map(({ id }) => id)

    expect(ambiguousOrMissing).toEqual([])
    expect(stale).toEqual([])
    expect(new Set(manifestIds).size).toBe(manifestIds.length)
    expect(policyIds).toEqual(manifestIds)
  })

  it('requires auth on every manifest-protected API route once a password is set', async () => {
    await setupPassword(harness.app)

    const routes = parseRouteTree(harness.app.printRoutes({ commonPrefix: false }))
    const apiRoutes = routes.filter((route) => route.path.startsWith('/api/v1/'))
    // Sanity: the parser actually found the command surface.
    expect(apiRoutes.filter((route) => isProtocolMutatingMethod(route.method)).length).toBeGreaterThan(50)

    const unprotected: string[] = []
    for (const route of apiRoutes) {
      const key = `${route.method} ${route.path}`
      const decision = findProtocolRouteDecision(route.method, route.path)
      if (!decision || decision.auth.decision === 'public' || decision.auth.decision === 'diagnostics-read') continue

      const method = route.method as InjectMethod
      const request = {
        method,
        url: concreteUrl(route.path),
        ...(isProtocolMutatingMethod(route.method) ? { payload: {} } : {}),
      }
      const res = await harness.app.inject({
        ...request,
        // No `risu-auth` header: a protected route must reject before doing work.
      })
      // requireAuth rejects with 401; anything else (200/400/404/409/423/500…)
      // means the handler ran past the auth gate without a token.
      if (res.statusCode !== 401) {
        unprotected.push(`${key} -> ${res.statusCode}`)
      }
    }

    expect(unprotected).toEqual([])
  })

  it('classifies data-reading POSTs as authenticated read-only routes', () => {
    for (const path of [
      '/api/v1/characters/:id/lorebook',
      '/api/v1/chats/:chatId/display-sources',
      '/api/v1/legacy-presets/:id',
      '/api/v1/prompt-presets/:id/template',
    ]) {
      expect(findProtocolRouteDecision('POST', path)).toMatchObject({
        methods: ['POST'],
        path,
        auth: { decision: 'required' },
        activeWriter: { decision: 'read-only-post' },
      })
    }
  })

  it('leaves the documented public routes reachable without auth', async () => {
    await setupPassword(harness.app)

    // auth/crypto: stateless helper, succeeds without a token.
    const crypto = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/crypto',
      payload: { data: 'abc' },
    })
    expect(crypto.statusCode).toBe(200)

    // assets/exists: a read-only probe, reachable without a token.
    const exists = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/exists',
      payload: { ids: [] },
    })
    expect(exists.statusCode).not.toBe(401)

    // content-addressed asset reads are public; a missing asset should 404, not 401.
    const missingAssetId = 'a'.repeat(64)
    const asset = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${missingAssetId}`,
    })
    expect(asset.statusCode).toBe(404)
  })

  it('requires auth on the durable-generation reattach + cancel routes', async () => {
    await setupPassword(harness.app)
    const reattach = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/generate/chat/some-id/stream',
    })
    expect(reattach.statusCode).toBe(401)
    const cancel = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/generate/chat/some-id',
    })
    expect(cancel.statusCode).toBe(401)
  })

  it('rejects accidental HEAD requests on expensive GET routes', async () => {
    const assertion = await setupPassword(harness.app)
    const urls = [
      '/api/v1/bootstrap',
      '/api/v1/chats/chat-a/messages',
      '/api/v1/export/risusave',
      '/api/v1/export/bundle',
      '/api/v1/export/local-backup',
      '/api/v1/events',
      '/api/v1/generate/chat/missing-job/stream',
    ]

    for (const url of urls) {
      const res = await harness.app.inject({
        method: 'HEAD',
        url,
        headers: { 'risu-auth': assertion },
      })
      expect(res.statusCode, url).toBe(404)
    }
  })

  it('authenticates raw buffered proxy bodies before body parsing', async () => {
    await setupPassword(harness.app)
    const payload = Buffer.alloc(1024 * 1024 + 1)

    for (const url of ['/api/v1/proxy/fetch', '/api/v1/hub/upload']) {
      const res = await harness.app.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/octet-stream',
          ...(url.includes('/proxy/') ? { 'risu-url': encodeURIComponent('https://example.com/') } : {}),
        },
        payload,
      })
      expect(res.statusCode, url).toBe(401)
    }
  })
})

describe('active-writer header validation', () => {
  async function authed(): Promise<string> {
    return setupPassword(harness.app)
  }

  it('treats a missing writer-session header as a non-writer once a session is latched', async () => {
    const assertion = await authed()
    // Latch session-a as the active writer via the writer-intent bootstrap.
    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: 'session-a' },
    })
    expect(bootstrap.statusCode).toBe(200)

    // A mutating request with NO writer-session header is not the active writer.
    const noHeader = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': assertion },
      payload: { database: { streamGeminiThoughts: false } },
    })
    expect(noHeader.statusCode).toBe(423)
    expect(noHeader.json()).toMatchObject({ error: 'active_writer_stale' })
  })

  it('rejects an empty / whitespace-only / oversize writer-session header', async () => {
    const assertion = await authed()
    await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: 'session-a' },
    })

    for (const bad of ['', '   ', 'x'.repeat(129)]) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: bad },
        payload: { database: { streamGeminiThoughts: false } },
      })
      expect(res.statusCode).toBe(423)
    }
  })

  it('accepts mutations before any writer session is latched (fresh server)', async () => {
    const assertion = await authed()
    // No bootstrap-with-writer-header yet: state.sessionId is null, so any
    // authenticated writer is accepted (the single-user bootstrap window).
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': assertion },
      payload: { database: { streamGeminiThoughts: false } },
    })
    expect(res.statusCode).toBe(200)
  })

  it('does not apply the active-writer gate to authenticated hash-aware resource reads', async () => {
    const assertion = await authed()
    const initialized = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': assertion },
      payload: { database: { streamGeminiThoughts: false } },
    })
    expect(initialized.statusCode, initialized.body).toBe(200)
    await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: 'session-a' },
    })

    for (const { url, statusCode } of [
      { url: '/api/v1/settings', statusCode: 200 },
      { url: '/api/v1/settings/display', statusCode: 200 },
      { url: '/api/v1/collections', statusCode: 200 },
      { url: '/api/v1/collections/modules', statusCode: 200 },
      { url: '/api/v1/characters', statusCode: 200 },
      { url: '/api/v1/characters/aggregate', statusCode: 200 },
      { url: '/api/v1/characters/x/lorebook', statusCode: 200 },
      { url: '/api/v1/legacy-presets/x', statusCode: 404 },
      { url: '/api/v1/prompt-presets/x/template', statusCode: 404 },
    ]) {
      const res = await harness.app.inject({
        method: 'POST',
        url,
        headers: { 'risu-auth': assertion },
        payload: { cache: { version: 2, hashes: {} } },
      })
      expect(res.statusCode, url).toBe(statusCode)
    }
  })
})

describe('explicit route rate limits', () => {
  it('allows the public asset-existence burst represented by the high-asset fixture', () => {
    const fixtureAssetCount = 4_361
    const legacyAssetBatchSize = 32
    const requiredBurst = Math.ceil(fixtureAssetCount / legacyAssetBatchSize)

    expect(Number(assetExistsRateLimit.max)).toBeGreaterThanOrEqual(requiredBurst)
  })

  it('limits auth login attempts with an explicit route limit', async () => {
    const setup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    expect(setup.statusCode).toBe(200)

    const publicKey = await subtle.exportKey(
      'jwk',
      ((await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair)
        .publicKey,
    )
    const allowedAttempts = Number(authLoginRateLimit.max)
    for (let i = 0; i < allowedAttempts; i += 1) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { password: 'wrong-password', publicKey },
      })
      expect(res.statusCode).toBe(400)
    }

    const limited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'wrong-password', publicKey },
    })
    expect(limited.statusCode).toBe(429)
  })

  it('does not apply ordinary request limits to durable generation reattach streams', async () => {
    const assertion = await setupPassword(harness.app)
    const attempts = Number(generationSubmitRateLimit.max) + 1

    for (let i = 0; i < attempts; i += 1) {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/generate/chat/missing-job/stream',
        headers: { 'risu-auth': assertion },
      })
      expect(res.statusCode).toBe(404)
    }
  })
})
