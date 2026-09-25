import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { isRemoteDiagnosticsResponse, SUPPORT_DIAGNOSTICS_ENDPOINT } from '@risuai/protocol/remote-diagnostics'
import { buildApp, type BuiltApp } from '../src/app.js'
import type { BuildIdentity } from '../src/buildIdentity.js'
import { mintSupportDiagnosticsCredential } from '../src/supportDiagnosticsAuth.js'
import { readRemoteDiagnosticsConfig } from '../../../util/diagnostics-remote.js'
import { setupAuthedClient } from './helpers/auth.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

const head = 'c'.repeat(40)
const canary = 'PRIVATE_BUILD_IDENTITY_ERROR_MESSAGE_4c1e'

async function startWithIdentity(buildIdentity: BuildIdentity): Promise<{ built: BuiltApp; token: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'risu-build-identity-'))
  const privateDir = path.join(root, 'private')
  mkdirSync(privateDir, { mode: 0o700 })
  const verifierFile = path.join(privateDir, 'verifier.json')
  const credentialFile = path.join(privateDir, 'remote.json')
  await mintSupportDiagnosticsCredential({ verifierFile, credentialFile, origin: 'https://synthetic.invalid' })
  const built = await buildApp({
    buildIdentity,
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir: path.join(root, 'data'),
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://synthetic.invalid',
      staticRoot: null,
      clientDiagnostics: true,
      supportDiagnostics: { enabled: true, verifierFile },
    },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
  })
  built.app.get('/api/v1/private-build-identity-failure', async () => {
    const error = new Error(canary)
    error.stack = `Error: ${canary}\n    at handler (/deploy/server/fastify/src/app.ts:12:3)\n    at plugin (/private/plugin.ts:9:1)`
    throw error
  })
  cleanup.push(async () => {
    await built.app.close()
    rmSync(root, { recursive: true, force: true })
  })
  await built.app.ready()
  await built.diagnostics.ready
  return { built, token: readRemoteDiagnosticsConfig(credentialFile).token }
}

async function readFailureRecord(built: BuiltApp, token: string) {
  const { assertion } = await setupAuthedClient(built.app)
  const failure = await built.app.inject({
    url: '/api/v1/private-build-identity-failure',
    headers: { 'risu-auth': assertion },
  })
  expect(failure.statusCode).toBe(500)
  await vi.waitFor(() => expect(built.diagnostics.journal?.read().pending).toBe(0), { timeout: 5000, interval: 20 })
  const response = await built.app.inject({
    url: `${SUPPORT_DIAGNOSTICS_ENDPOINT}?version=3&requestUid=${failure.headers['x-request-uid']}`,
    headers: { authorization: `Bearer ${token}` },
  })
  expect(response.statusCode).toBe(200)
  const value: unknown = response.json()
  if (!isRemoteDiagnosticsResponse(value) || value.version !== 3) throw new Error('expected validated v3 evidence')
  expect(response.body).not.toContain(canary)
  expect(response.body).not.toContain('plugin.ts')
  const record = value.entries.find((entry) => entry.entry.category === 'runtime')
  if (!record) throw new Error('expected the runtime failure record')
  return { identity: value.identity, record }
}

it('reports the git head as the build identity but withholds error locations from a dirty checkout', async () => {
  vi.stubEnv('LOG_LEVEL', 'silent')
  vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
  const dirty = await startWithIdentity({
    build: head,
    source: 'git',
    locationsTrusted: false,
    dirty: true,
    commitTime: 1_790_000_000_000,
  })
  const withheld = await readFailureRecord(dirty.built, dirty.token)
  expect(withheld.identity).toEqual({ build: head, instanceId: withheld.identity.instanceId })
  expect(withheld.record.entry).toMatchObject({ category: 'runtime', errorName: 'Error' })
  expect(JSON.stringify(withheld.record)).not.toContain('location')

  const clean = await startWithIdentity({
    build: head,
    source: 'git',
    locationsTrusted: true,
    dirty: false,
    commitTime: 1_790_000_000_000,
  })
  const exported = await readFailureRecord(clean.built, clean.token)
  expect(exported.identity).toEqual({ build: head, instanceId: exported.identity.instanceId })
  expect(exported.record).toMatchObject({
    entry: { category: 'runtime', errorName: 'Error' },
    facts: [{ id: 'runtime.location.0', type: 'location', value: 'server/fastify/src/app.ts:12:3' }],
  })
})
