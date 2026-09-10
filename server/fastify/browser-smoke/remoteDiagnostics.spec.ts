import { expect, test } from '@playwright/test'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isRemoteDiagnosticsResponse, type RemoteDiagnosticsResponseV2 } from '@risuai/protocol/remote-diagnostics'
import { buildApp } from '../src/app.js'
import { importFastBootstrapDatabase, smallFastBootstrapFixture } from './fastBootstrapHarness.js'
import { setupBrowserSmokeAuth } from './auth.js'

test('an authenticated reader uploads browser failures and the HTTPS helper retrieves safe joined evidence', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  process.env.LOG_LEVEL = 'silent'
  const root = mkdtempSync(path.join(tmpdir(), 'risu-browser-diagnostics-'))
  const dataDir = path.join(root, 'data')
  const privateDir = path.join(root, 'private')
  mkdirSync(privateDir, { mode: 0o700 })
  const verifierFile = path.join(privateDir, 'verifier.json')
  const token = randomBytes(32).toString('hex')
  const canary = 'PRIVATE_BROWSER_CHAT_PRESET_QUERY_ERROR_CANARY_921'
  writeFileSync(
    verifierFile,
    JSON.stringify({
      version: 1,
      credentials: [
        {
          id: 'ba'.repeat(16),
          digest: createHash('sha256').update(token).digest('hex'),
          createdAt: Date.now() - 1000,
          expiresAt: Date.now() + 600_000,
          revokedAt: null,
        },
      ],
    }),
    { mode: 0o600 },
  )
  const certificate = path.join(privateDir, 'certificate.pem')
  const key = path.join(privateDir, 'key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-days',
      '1',
    ],
    { stdio: 'pipe' },
  )
  const built = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://example.invalid',
      staticRoot: path.resolve('dist'),
      clientDiagnostics: true,
      supportDiagnostics: { enabled: true, verifierFile },
      browserDiagnostics: { enabled: true },
    },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  const { app, diagnostics } = built
  app.get('/api/v1/diagnostic-browser-failure', async (_request, reply) => reply.code(503).send({ error: canary }))
  const https = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) =>
    app.routing(request, response),
  )
  const context = await browser.newContext()
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('missing-fixture-address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    await new Promise<void>((resolve) => https.listen(0, '127.0.0.1', resolve))
    const tlsAddress = https.address()
    if (!tlsAddress || typeof tlsAddress === 'string') throw new Error('missing-fixture-address')
    const helperConfig = path.join(privateDir, 'remote.json')
    writeFileSync(helperConfig, JSON.stringify({ version: 1, origin: `https://127.0.0.1:${tlsAddress.port}`, token }), {
      mode: 0o600,
    })
    const helper = () =>
      new Promise<RemoteDiagnosticsResponseV2>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NODE_EXTRA_CA_CERTS: certificate,
          RISU_DIAGNOSTICS_REMOTE_CONFIG: helperConfig,
        }
        delete env.NODE_OPTIONS
        delete env.FORCE_COLOR
        delete env.NO_COLOR
        execFile(
          process.execPath,
          ['--import', 'tsx/esm', path.resolve('util/diagnostics-remote.ts'), '--version=2', '--limit=200'],
          { env, timeout: 15_000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error || stderr) return reject(new Error('helper-fixture-failed'))
            const result: unknown = JSON.parse(stdout)
            if (!isRemoteDiagnosticsResponse(result) || result.version !== 2)
              return reject(new Error('invalid-helper-envelope'))
            resolve(result)
          },
        )
      })
    const auth = await setupBrowserSmokeAuth(app)
    const fixture = smallFastBootstrapFixture()
    const character = (fixture.characters as Array<Record<string, unknown>>)[0]
    character.description = canary
    const chat = (character.chats as Array<Record<string, unknown>>)[0]
    chat.note = canary
    await importFastBootstrapDatabase(app, auth, fixture, { dataDir })
    const owner = await app.inject({
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': auth, 'risu-writer-session': 'synthetic-other-writer' },
    })
    expect(owner.statusCode).toBe(200)
    await diagnostics.ready
    await context.addInitScript((credential) => sessionStorage.setItem('risuauth', credential), auth)
    const page = await context.newPage()
    const uploads: { auth: boolean; body: string }[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/diagnostics/browser')
        uploads.push({
          auth: Boolean(request.headers()['risu-auth']),
          body: request.postData() ?? '',
        })
    })
    await page.goto(`${baseUrl}/character/fast-bootstrap-small-character/fast-bootstrap-small-chat`)
    await expect(page.locator('[data-reader-composer-field="message"]')).toBeDisabled()
    const domain = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    const authority = () =>
      domain.prepare('SELECT active_writer_session_id, writer_epoch FROM database_metadata WHERE id=1').get()
    const revision = () => domain.prepare('SELECT revision FROM schema_version WHERE id=1').get()
    const beforeAuthority = authority()
    const beforeRevision = revision()
    try {
      expect(beforeAuthority).toMatchObject({ active_writer_session_id: 'synthetic-other-writer', writer_epoch: 1 })
      const uid = await page.evaluate(async (secret) => {
        const response = await fetch(`/api/v1/diagnostic-browser-failure?private=${secret}`)
        window.dispatchEvent(new ErrorEvent('error', { error: new TypeError(secret), message: secret }))
        return response.headers.get('x-request-uid')
      }, canary)
      expect(uid).toMatch(/^[a-f0-9]{64}$/)
      await page.route('**/api/v1/diagnostic-network-failure', (route) => route.abort('failed'))
      await page.evaluate(() => fetch('/api/v1/diagnostic-network-failure').catch(() => undefined))
      await expect.poll(() => uploads.length, { timeout: 20_000 }).toBeGreaterThan(0)
      let fetched!: RemoteDiagnosticsResponseV2
      await expect
        .poll(
          async () => {
            fetched = await helper()
            return fetched.entries.some(({ entry }) => entry.source === 'browser' && entry.requestUid === uid)
          },
          { timeout: 20_000, intervals: [1000, 2000] },
        )
        .toBe(true)
      expect(fetched.sources).toEqual({ server: 'journal', browser: 'available' })
      expect(fetched.entries).toContainEqual(
        expect.objectContaining({
          entry: expect.objectContaining({ source: 'server', requestUid: uid, category: 'http', statusCode: 503 }),
        }),
      )
      expect(fetched.entries).toContainEqual(
        expect.objectContaining({
          entry: expect.objectContaining({ source: 'browser', category: 'http', statusCode: 0, outcome: 'aborted' }),
        }),
      )
      expect(fetched.entries).toContainEqual(
        expect.objectContaining({
          provenance: expect.objectContaining({ kind: 'browser' }),
          entry: expect.objectContaining({
            source: 'browser',
            category: 'runtime',
            kind: 'runtime-error',
            errorName: 'TypeError',
          }),
        }),
      )
      expect(uploads.every((upload) => upload.auth)).toBe(true)
      const safe = JSON.stringify({ fetched, uploads: uploads.map((upload) => upload.body) })
      for (const secret of [canary, token, auth]) {
        expect(safe).not.toContain(secret)
        expect(safe).not.toContain(Buffer.from(secret).toString('base64'))
        expect(safe).not.toContain(Buffer.from(secret).toString('hex'))
      }
      const browserIds = fetched.entries
        .filter((record) => record.provenance.kind === 'browser')
        .map((record) =>
          record.provenance.kind === 'browser' ? `${record.provenance.sourceId}:${record.provenance.eventId}` : '',
        )
      expect(new Set(browserIds).size).toBe(browserIds.length)
      const uploadsBeforeReload = uploads.length
      await page.reload()
      await expect(page.locator('[data-reader-composer-field="message"]')).toBeDisabled()
      await expect.poll(() => uploads.length, { timeout: 20_000 }).toBeGreaterThan(uploadsBeforeReload)
      const afterReload = await helper()
      for (const id of browserIds)
        expect(
          afterReload.entries.filter(
            (record) =>
              record.provenance.kind === 'browser' &&
              `${record.provenance.sourceId}:${record.provenance.eventId}` === id,
          ),
        ).toHaveLength(1)
      expect(authority()).toEqual(beforeAuthority)
      expect(revision()).toEqual(beforeRevision)
    } finally {
      domain.close()
    }
  } finally {
    await context.close()
    https.closeAllConnections()
    await new Promise<void>((resolve) => https.close(() => resolve()))
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
