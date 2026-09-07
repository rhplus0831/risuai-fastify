import { expect, test, type Page, type Request } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zipSync } from 'fflate'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { getSchemaState } from '../src/db.js'
import { setupBrowserSmokeAuth } from './auth.js'
import { importFastBootstrapDatabase } from './fastBootstrapHarness.js'

const realmId = 'realm-confirmation-character'
const characterName = 'Realm Confirmation Character'
const openRealmLabel = 'Open Risu Realm Discover and download new characters from RisuRealm.'
const importPath = '/api/v1/import/realm-character'
const lowLevelPrompt =
  'This content uses Low Level Access. which means this content can access the AI model and your storage directly. Do you really want to import this content?'

interface ImportRequestBody {
  id: string
  baseRevision: number
  allowLowLevelAccess: boolean
  pendingImportToken?: string
  clientCapabilities: { realmProgressDelta: boolean }
}

interface PersistedCharacter {
  chaId: string
  name: string
  lowLevelAccess: boolean
  firstMessage: string
}

interface SseFrame {
  event: string
  data: Record<string, unknown>
}

interface ObservedImportStream {
  chunks: Buffer[]
  finished: boolean
}

test.setTimeout(45_000)
test.use({ actionTimeout: 10_000 })

for (const answer of ['YES', 'NO'] as const) {
  test(`Realm import moves from actual download progress to low-level confirmation and handles ${answer}`, async ({
    page,
    context,
  }, testInfo) => {
    const upstream = await startRealmUpstream()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-realm-confirmation-browser-'))
    const importRequests: ImportRequestBody[] = []
    const characterResourceRequests: string[] = []
    const pageErrors: string[] = []
    let observeImportResources = false
    process.env.LOG_LEVEL = 'silent'
    let app: FastifyInstance | undefined
    try {
      app = (
        await buildApp({
          config: {
            host: '127.0.0.1',
            port: 0,
            dataDir,
            bodyLimit: 2 * 1024 * 1024,
            importMaxBytes: Number.POSITIVE_INFINITY,
            trustProxy: false,
            hubUrl: upstream.url,
            realmUrl: upstream.url,
            staticRoot: path.resolve('dist'),
          },
          assetGc: false,
          memoryWorker: false,
        })
      ).app
      const importStreams = observeImportStreams(app)
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Realm browser harness did not bind a TCP port')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const assertion = await setupBrowserSmokeAuth(app)
      await importFastBootstrapDatabase(app, assertion, {
        version: 1,
        didFirstSetup: true,
        formatversion: 5,
        language: 'en',
        currentChar: -1,
        characterOrder: [],
        characters: [],
        botPresets: [],
        loadouts: [],
        modules: [],
        personas: [],
        plugins: [],
        pluginCustomStorage: {},
        goCharacterOnImport: true,
        doNotWarnExternalServers: false,
      })
      page.on('pageerror', (error) => pageErrors.push(error.message))
      page.on('request', (request) => {
        if (isRealmImport(request)) importRequests.push(request.postDataJSON() as ImportRequestBody)
        const pathname = new URL(request.url()).pathname
        if (observeImportResources && /^\/api\/v1\/characters(?:\/|$)/u.test(pathname)) {
          characterResourceRequests.push(pathname)
        }
      })

      await page.goto(baseUrl)
      await waitForStartup(page)
      await page.getByRole('button', { name: openRealmLabel, exact: true }).click()
      const externalWarning = page
        .getByRole('alertdialog')
        .filter({ hasText: 'Continuing will send a request to an external server' })
      await expect(externalWarning).toBeVisible()
      await externalWarning.getByRole('button', { name: 'YES', exact: true }).click()
      await expect(page.getByText('No Realm characters found.', { exact: true })).toBeVisible()
      expect(upstream.requests.filter((entry) => entry.path.startsWith('/realm/'))).toHaveLength(1)
      await realmMenuButton(page).click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Import character from URL or ID', exact: true })
        .click()
      await page.getByLabel('Enter a Realm character URL or ID', { exact: true }).fill(realmId)
      await page
        .getByRole('dialog')
        .filter({ has: page.getByLabel('Enter a Realm character URL or ID', { exact: true }) })
        .getByRole('button', { name: 'OK', exact: true })
        .click()
      const terms = page
        .getByRole('dialog')
        .filter({ hasText: 'To download characters from RisuRealm, review and accept the following policies:' })
      await expect(terms).toBeVisible()
      expect(importRequests).toEqual([])
      const initial = persistedState(dataDir)
      expect(initial.characters).toEqual([])
      expect(initial.assetCount).toBe(0)
      observeImportResources = true

      const firstResponsePromise = page.waitForResponse((response) => isRealmImport(response.request()))
      await terms.getByRole('button', { name: 'Accept', exact: true }).click()
      const firstResponse = await firstResponsePromise
      expect(firstResponse.status()).toBe(200)
      expect(firstResponse.headers()['content-type']).toContain('text/event-stream')
      await expect.poll(() => upstream.firstChunkSent).toBe(true)
      const downloadProgress = page.getByRole('progressbar', { name: 'Downloading Realm character', exact: true })
      await expect(downloadProgress).toBeVisible()
      // The held, real first chunk must advance the actual streamed progress.
      await expect.poll(async () => Number(await downloadProgress.getAttribute('aria-valuenow'))).toBeGreaterThan(5)
      expect(importRequests).toEqual([
        {
          id: realmId,
          baseRevision: initial.revision,
          allowLowLevelAccess: false,
          clientCapabilities: { realmProgressDelta: true },
        },
      ])
      expect(dynamicDownloads(upstream.requests)).toHaveLength(1)
      expect(persistedState(dataDir)).toEqual(initial)

      upstream.releaseDownload()
      expect(importStreams).toHaveLength(1)
      const firstFrames = await readSseFrames(importStreams[0]!)
      await testInfo.attach('initial-realm-import-sse.json', {
        body: JSON.stringify(firstFrames, null, 2),
        contentType: 'application/json',
      })
      expect(firstFrames.some((frame) => frame.event === 'progress' && frame.data.phase === 'download')).toBe(true)
      expect(firstFrames.filter((frame) => frame.event === 'low_level_access')).toHaveLength(1)
      expect(firstFrames.some((frame) => frame.event === 'done')).toBe(false)
      const pending = firstFrames.find((frame) => frame.event === 'low_level_access')!.data
      expect(pending).toMatchObject({ code: 'low_level_access_confirmation_required' })
      expect(pending.pendingImportToken).toMatch(/^[a-f0-9]{32}$/u)
      expect(persistedState(dataDir)).toEqual(initial)
      expect(importRequests).toHaveLength(1)
      expect(characterResourceRequests).toEqual([])

      // Fault oracle: the actual server has answered and progress was visible;
      // omitting characterCards.ts's progress release leaves this dialog queued.
      const confirmation = page.getByRole('alertdialog').filter({ hasText: lowLevelPrompt })
      await expect(
        confirmation,
        'The real low-level import response must replace progress with an actionable confirmation',
      ).toBeVisible({ timeout: 5_000 })
      await expect(page.getByRole('progressbar')).toHaveCount(0)
      await expect(confirmation.getByRole('button', { name: 'YES', exact: true })).toBeEnabled()
      await expect(confirmation.getByRole('button', { name: 'NO', exact: true })).toBeEnabled()
      expect(importRequests).toHaveLength(1)
      expect(dynamicDownloads(upstream.requests)).toHaveLength(1)
      expect(persistedState(dataDir)).toEqual(initial)

      if (answer === 'YES') {
        const acceptedResponsePromise = page.waitForResponse((response) => isRealmImport(response.request()))
        await confirmation.getByRole('button', { name: answer, exact: true }).click()
        const acceptedResponse = await acceptedResponsePromise
        expect(importStreams).toHaveLength(2)
        const acceptedFrames = await readSseFrames(importStreams[1]!)
        expect(acceptedResponse.status()).toBe(200)
        expect(acceptedFrames.filter((frame) => frame.event === 'done')).toHaveLength(1)
        const accepted = acceptedFrames.find((frame) => frame.event === 'done')!.data
        expect(accepted.characterId).toEqual(expect.any(String))
        expect(accepted.event).toMatchObject({
          type: 'character.created',
          resource: 'character',
          id: accepted.characterId,
          revision: accepted.revision,
        })
        expect(importRequests).toEqual([
          importRequests[0],
          {
            id: realmId,
            baseRevision: initial.revision,
            allowLowLevelAccess: true,
            pendingImportToken: pending.pendingImportToken,
            clientCapabilities: { realmProgressDelta: true },
          },
        ])
        expect(dynamicDownloads(upstream.requests)).toHaveLength(1)
        await expect.poll(() => characterResourceRequests.includes('/api/v1/characters')).toBe(true)
        await expect(page.getByRole('alertdialog')).toHaveCount(0)
        await expect(page.getByText(characterName, { exact: true }).first()).toBeVisible()
        await expect
          .poll(() => new URL(page.url()).pathname.split('/').slice(0, 3))
          .toEqual(['', 'character', accepted.characterId])
        const imported = persistedState(dataDir)
        expect(imported.characters).toEqual([
          expect.objectContaining({
            chaId: accepted.characterId,
            name: characterName,
            lowLevelAccess: true,
            firstMessage: 'Hello from the downloaded Realm package.',
          }),
        ])
        expect(imported.assetCount).toBe(1)
        expect(imported.characterEvents).toEqual([{ id: accepted.characterId, revision: accepted.revision }])
        const apiCharacter = await app.inject({
          method: 'GET',
          url: `/api/v1/characters/${accepted.characterId}`,
          headers: { 'risu-auth': assertion },
        })
        expect(apiCharacter.statusCode).toBe(200)
        expect(apiCharacter.json()).toMatchObject({
          character: { chaId: accepted.characterId, name: characterName, lowLevelAccess: true },
        })
        await page.reload()
        await waitForStartup(page)
        await expect(page.getByText(characterName, { exact: true }).first()).toBeVisible()
        expect(new URL(page.url()).pathname.split('/').slice(0, 3)).toEqual(['', 'character', accepted.characterId])
        expect(persistedState(dataDir).characters).toEqual(imported.characters)
        expect(persistedState(dataDir).characterEvents).toEqual(imported.characterEvents)
        expect(importRequests).toHaveLength(2)
      } else {
        await confirmation.getByRole('button', { name: answer, exact: true }).click()
        await expect(confirmation).toHaveCount(0)
        await expect(page.getByRole('progressbar')).toHaveCount(0)
        // A new visible input can open and close after rejection; no hook clears the modal.
        await realmMenuButton(page).click()
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Import character from URL or ID', exact: true })
          .click()
        const input = page.getByLabel('Enter a Realm character URL or ID', { exact: true })
        await expect(input).toBeVisible()
        await input.press('Escape')
        await expect(input).toHaveCount(0)
        expect(importRequests).toHaveLength(1)
        expect(characterResourceRequests).toEqual([])
        expect(persistedState(dataDir)).toEqual(initial)
        await page.reload()
        await waitForStartup(page)
        await expect(page.getByRole('button', { name: openRealmLabel, exact: true })).toBeVisible()
        expect(persistedState(dataDir)).toEqual(initial)
        expect(importRequests).toHaveLength(1)
      }
      expect(dynamicDownloads(upstream.requests)).toHaveLength(1)
      expect(dynamicDownloads(upstream.requests)[0]).toEqual({
        method: 'GET',
        path: `/api/v1/download/dynamic/${realmId}?cors=true`,
      })
      expect(pageErrors).toEqual([])
    } finally {
      await testInfo.attach('realm-import-requests.json', {
        body: JSON.stringify(importRequests, null, 2),
        contentType: 'application/json',
      })
      upstream.releaseDownload()
      await context.close()
      await app?.close()
      await upstream.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
}

function isRealmImport(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === importPath
}

function realmMenuButton(page: Page) {
  return page
    .getByRole('textbox', { name: 'Search Realm characters', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Menu', exact: true })
}

async function waitForStartup(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 15_000 })
    .toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 20_000))
}

function observeImportStreams(app: FastifyInstance): ObservedImportStream[] {
  const streams: ObservedImportStream[] = []
  // Chromium does not retain fetch-SSE bodies for Network.getResponseBody.
  // Observe the real server's writes and forward every original argument and
  // return value unchanged; this does not supply frames or affect client parsing.
  app.addHook('onRequest', (request, reply, done) => {
    if (request.method === 'POST' && request.url === importPath) {
      const stream: ObservedImportStream = { chunks: [], finished: false }
      streams.push(stream)
      const write = reply.raw.write
      reply.raw.write = function (...args: unknown[]): boolean {
        const chunk = args[0]
        stream.chunks.push(
          typeof chunk === 'string'
            ? Buffer.from(chunk, typeof args[1] === 'string' ? (args[1] as BufferEncoding) : 'utf8')
            : Buffer.from(chunk as Uint8Array),
        )
        return Reflect.apply(write, this, args) as boolean
      }
      reply.raw.once('finish', () => {
        stream.finished = true
      })
    }
    done()
  })
  return streams
}

async function readSseFrames(stream: ObservedImportStream): Promise<SseFrame[]> {
  await expect.poll(() => stream.finished).toBe(true)
  return Buffer.concat(stream.chunks)
    .toString('utf8')
    .trim()
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n')
      return {
        event: lines.find((line) => line.startsWith('event: '))!.slice(7),
        data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<string, unknown>,
      }
    })
}

function persistedState(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    return {
      revision: getSchemaState(db).revision,
      characters: (
        db.prepare('SELECT data_json FROM characters ORDER BY position').all() as Array<{ data_json: string }>
      ).map((row) => {
        const { chaId, name, lowLevelAccess, firstMessage } = JSON.parse(row.data_json) as PersistedCharacter
        return { chaId, name, lowLevelAccess, firstMessage }
      }),
      assetCount: (db.prepare('SELECT COUNT(*) AS count FROM assets').get() as { count: number }).count,
      characterEvents: db
        .prepare("SELECT id, revision FROM command_events WHERE type = 'character.created' ORDER BY revision")
        .all(),
    }
  } finally {
    db.close()
  }
}

function dynamicDownloads(requests: Array<{ path: string }>) {
  return requests.filter((entry) => entry.path.startsWith('/api/v1/download/dynamic/'))
}

async function startRealmUpstream() {
  let releaseDownload!: () => void
  const released = new Promise<void>((resolve) => {
    releaseDownload = resolve
  })
  const requests: Array<{ path: string; method: string }> = []
  let firstChunkSent = false
  const payload = lowLevelRealmCharx()
  const server = http.createServer((request, response) => {
    const requestPath = request.url ?? ''
    requests.push({ path: requestPath, method: request.method ?? '' })
    if (requestPath.startsWith('/realm/')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('[]')
      return
    }
    if (requestPath === `/api/v1/download/dynamic/${realmId}?cors=true`) {
      response.writeHead(200, { 'content-type': 'application/charx', 'content-length': payload.byteLength })
      const split = Math.floor(payload.byteLength / 2)
      response.write(payload.subarray(0, split))
      firstChunkSent = true
      void released.then(() => {
        response.end(payload.subarray(split))
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Realm upstream did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    releaseDownload,
    get firstChunkSent() {
      return firstChunkSent
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

// The real chara_card_v3/ZIP contract used by the Realm API fixtures. The card's
// actual low-level flag triggers staging/confirmation; no import result is stubbed.
function lowLevelRealmCharx(): Uint8Array {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: characterName,
      description: 'A deterministic Realm confirmation fixture.',
      personality: '',
      scenario: '',
      first_mes: 'Hello from the downloaded Realm package.',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: { risuai: { lowLevelAccess: true } },
      assets: [{ type: 'icon', uri: 'embeded://assets/main.png', name: 'main', ext: 'png' }],
    },
  }
  return zipSync(
    {
      'card.json': new TextEncoder().encode(JSON.stringify(card)),
      'assets/main.png': Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2KQAAAABJRU5ErkJggg==',
        'base64',
      ),
    },
    { level: 0 },
  )
}
