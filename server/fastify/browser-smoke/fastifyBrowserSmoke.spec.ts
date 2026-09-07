import { devices, expect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import type { FastifyInstance } from 'fastify'
import { setupBrowserSmokeAuth } from './auth.js'

interface Harness {
  app: FastifyInstance
  baseUrl: string
  dataDir: string
}

interface StorageAuditRecord {
  surface: string
  operation: string
  detail?: string
}

declare global {
  interface Window {
    __RISU_FASTIFY_STORAGE_WRITE_AUDIT__?: {
      records: StorageAuditRecord[]
    }
    __RISU_SET_MOCK_VISUAL_VIEWPORT__?: (state: {
      event?: 'resize' | 'scroll'
      height?: number
      offsetTop?: number
      pageTop?: number
    }) => void
  }
}

let harness: Harness
let browserSmokeAssertion: string

test.beforeEach(async () => {
  harness = await startHarness()
  browserSmokeAssertion = await setupBrowserSmokeAuth(harness.app)
  await importDatabase(harness.app, browserSmokeAssertion, browserSmokeDatabase())
})

function browserSmokeDatabase(includeDragFixtures = false): Record<string, unknown> {
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    selectedCharID: 0,
    characterOrder: [],
    characters: [
      {
        chaId: 'char-smoke',
        type: 'character',
        name: 'Smoke Character',
        chats: [
          {
            id: 'chat-smoke',
            name: 'Smoke Chat',
            note: '',
            localLore: [],
            message: [],
          },
        ],
        chatPage: 0,
        customscript: [],
        firstMessage: '',
        globalLore: [],
        viewScreen: 'none',
        emotionImages: [],
      },
    ],
    botPresets: [],
    ...(includeDragFixtures
      ? {
          promptPresets: [
            { id: 'prompt-smoke-a', name: 'Prompt Smoke A', promptTemplate: [] },
            { id: 'prompt-smoke-b', name: 'Prompt Smoke B', promptTemplate: [] },
          ],
          promptPresetsId: 0,
          modelProfiles: [
            {
              id: 'profile-smoke-a',
              name: 'Profile Smoke A',
              providerId: 'debug-echo',
              modelId: 'debug-echo',
            },
            {
              id: 'profile-smoke-b',
              name: 'Profile Smoke B',
              providerId: 'debug-echo',
              modelId: 'debug-echo',
            },
          ],
          modelProfileOrder: [
            { kind: 'profile', profileId: 'profile-smoke-a' },
            { kind: 'profile', profileId: 'profile-smoke-b' },
          ],
          modelRoleProfiles: {},
          modelRuntimeDefaults: {},
          providerCredentials: [],
        }
      : {}),
    loadouts: [],
    loreBook: [
      { id: 'lore-smoke-a', name: 'Lore Smoke A', data: [] },
      { id: 'lore-smoke-b', name: 'Lore Smoke B', data: [] },
    ],
    loreBookPage: 0,
    modules: [],
    personas: [],
    plugins: [],
    pluginCustomStorage: {},
    language: 'en',
    loreBookToken: 8000,
    mainPrompt: '',
    streamGeminiThoughts: false,
  }
}

test.afterEach(async ({ context }) => {
  await context.close()
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

test('Fastify-served browser loads bootstrap, subscribes to events, and refreshes after a command', async ({
  page,
}) => {
  const apiRequests: string[] = []
  const resourceCacheRequests: Array<{ path: string; hashes: Record<string, unknown> }> = []
  const browserDiagnostics: string[] = []
  await page.addInitScript(() => {
    const audit: { records: StorageAuditRecord[] } = { records: [] }
    Object.defineProperty(window, '__RISU_FASTIFY_STORAGE_WRITE_AUDIT__', {
      configurable: true,
      value: audit,
    })

    const record = (surface: string, operation: string, detail?: unknown) => {
      audit.records.push({
        surface,
        operation,
        detail: typeof detail === 'string' ? detail : undefined,
      })
    }
    const patchMethod = (target: unknown, method: string, surface: string, operation = method, detailIndex = 0) => {
      const holder = target as Record<string, unknown> | undefined
      const original = holder?.[method]
      if (!holder || typeof original !== 'function') return
      holder[method] = function patchedStorageAuditMethod(this: unknown, ...args: unknown[]) {
        record(surface, operation, args[detailIndex])
        return original.apply(this, args)
      }
    }

    patchMethod(window.indexedDB, 'open', 'indexedDB')
    patchMethod(window.indexedDB, 'deleteDatabase', 'indexedDB')
    patchMethod((window as any).IDBDatabase?.prototype, 'createObjectStore', 'indexedDB')
    patchMethod((window as any).IDBDatabase?.prototype, 'deleteObjectStore', 'indexedDB')
    patchMethod((window as any).IDBObjectStore?.prototype, 'add', 'indexedDB')
    patchMethod((window as any).IDBObjectStore?.prototype, 'put', 'indexedDB')
    patchMethod((window as any).IDBObjectStore?.prototype, 'delete', 'indexedDB')
    patchMethod((window as any).IDBObjectStore?.prototype, 'clear', 'indexedDB')
    patchMethod(Object.getPrototypeOf(window.navigator.storage), 'getDirectory', 'opfs')
  })
  page.on('console', (message) => {
    browserDiagnostics.push(`console.${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => {
    browserDiagnostics.push(`pageerror: ${error.message}`)
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/v1/')) {
      apiRequests.push(`${request.method()} ${url.pathname}`)
    }
    if (
      request.method() === 'POST' &&
      ['/api/v1/settings', '/api/v1/collections', '/api/v1/characters'].includes(url.pathname)
    ) {
      const body = request.postDataJSON() as { cache?: { hashes?: unknown } } | null
      if (body?.cache?.hashes && typeof body.cache.hashes === 'object') {
        resourceCacheRequests.push({ path: url.pathname, hashes: body.cache.hashes as Record<string, unknown> })
      }
    }
  })

  await page.goto(harness.baseUrl)

  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(globalThis, '__NODE__')))).toBe(false)
  await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)

  try {
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded())
  } catch (err) {
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '<body unavailable>')
    throw new Error(
      [
        err instanceof Error ? err.message : String(err),
        `body: ${bodyText.slice(0, 1000)}`,
        ...browserDiagnostics.slice(-20),
      ].join('\n'),
    )
  }
  await expect(page.locator('[data-char-id="char-smoke"]')).toBeVisible()

  await expect
    .poll(() => apiRequests.filter((entry) => entry === 'GET /api/v1/bootstrap').length)
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(() => apiRequests.filter((entry) => entry === 'GET /api/v1/events').length)
    .toBeGreaterThanOrEqual(1)
  expect(apiRequests).toContain('GET /api/v1/resources/shell')
  expect(apiRequests).not.toContain('POST /api/v1/settings')
  expect(apiRequests).not.toContain('POST /api/v1/collections')
  expect(apiRequests).not.toContain('POST /api/v1/characters')
  expect(apiRequests).not.toContain('GET /api/v1/inlay-assets')
  expect(apiRequests.some((entry) => entry.startsWith('POST /api/v1/settings/'))).toBe(true)
  expect(apiRequests.some((entry) => entry.startsWith('POST /api/v1/collections/'))).toBe(true)

  const initialProjection = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot())
  expect(initialProjection?.streamGeminiThoughts).toBe(false)

  const commandResult = await page.evaluate(() =>
    window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({
      streamGeminiThoughts: true,
    }),
  )
  expect(commandResult).toMatchObject({
    status: 'ok',
    event: { type: 'settings.updated', resource: 'settings' },
  })

  const apiRouteResults = await page.evaluate(async () => {
    const activeWriterHeaders = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const generated = await fetch('/api/v1/generate/completion', {
      body: JSON.stringify({
        provider: 'echo',
        model: 'echo_model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { echo: { message: 'pong', delayMs: 0 } },
      }),
      headers: { ...activeWriterHeaders, 'content-type': 'application/json' },
      method: 'POST',
    })
    const generatedBody = await generated.json()

    const chunks = await fetch('/api/v1/memory/chunks/chat-smoke', {
      headers: activeWriterHeaders,
    })
    const summaries = await fetch('/api/v1/memory/summaries/chat-smoke', {
      headers: activeWriterHeaders,
    })
    const exported = await fetch('/api/v1/export/risusave', {
      headers: activeWriterHeaders,
    })
    const exportedBytes = await exported.blob()
    const importForm = new FormData()
    importForm.append('file', exportedBytes, 'database.risu')
    const imported = await fetch('/api/v1/import/risusave', {
      body: importForm,
      headers: activeWriterHeaders,
      method: 'POST',
    })
    const importedBody = await imported.json()
    const bundle = await fetch('/api/v1/export/bundle', { headers: activeWriterHeaders })

    const uploaded = await fetch('/api/v1/assets', {
      body: new Uint8Array([1, 2, 3]),
      headers: { ...activeWriterHeaders, 'content-type': 'image/png' },
      method: 'POST',
    })
    const uploadedBody = await uploaded.json()
    const asset = await fetch(`/api/v1/assets/${uploadedBody.assetId}`, {
      headers: activeWriterHeaders,
    })

    return {
      asset: asset.status,
      bundle: bundle.status,
      chunks: chunks.status,
      exported: exported.status,
      generated: generated.status,
      generatedBody,
      imported: imported.status,
      importedBody,
      summaries: summaries.status,
      uploaded: uploaded.status,
    }
  })
  expect(apiRouteResults).toMatchObject({
    asset: 200,
    bundle: 200,
    chunks: 200,
    exported: 200,
    generated: 200,
    generatedBody: { type: 'success', result: 'pong' },
    imported: 200,
    importedBody: { event: { type: 'state.imported', resource: 'state' } },
    summaries: 200,
    uploaded: 201,
  })

  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().streamGeminiThoughts))
    .toBe(true)

  expect(apiRequests).toContain('PATCH /api/v1/commands/settings/runtime')
  expect(apiRequests).toContain('POST /api/v1/assets')
  expect(apiRequests).toContain('POST /api/v1/generate/completion')
  expect(apiRequests).toContain('GET /api/v1/export/risusave')
  expect(apiRequests).toContain('GET /api/v1/export/bundle')
  expect(apiRequests).toContain('POST /api/v1/import/risusave')
  expect(apiRequests).toContain('GET /api/v1/memory/chunks/chat-smoke')
  expect(apiRequests).toContain('GET /api/v1/memory/summaries/chat-smoke')
  for (const resource of ['settings', 'collections', 'characters']) {
    const path = `/api/v1/${resource}`
    await expect.poll(() => resourceCacheRequests.filter((entry) => entry.path === path).length).toBeGreaterThan(0)
    const requests = resourceCacheRequests.filter((entry) => entry.path === path)
    const hasCachedHash = (entry: (typeof requests)[number] | undefined) =>
      Object.values(entry?.hashes ?? {}).some(
        (hashes) =>
          Array.isArray(hashes) && hashes.some((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)),
      )
    // The in-test database import changes lineage; its replacement refresh
    // must not advertise cache identities from the superseded database.
    expect(hasCachedHash(requests.at(-1))).toBe(false)
  }
  expect(apiRequests.filter((entry) => /^((GET)|(POST)) \/api\/v1\/storage\//.test(entry))).toEqual([])
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window.__RISU_FASTIFY_STORAGE_WRITE_AUDIT__?.records ?? []).filter((record) => record.surface !== 'indexedDB'),
      ),
    )
    .toEqual([])
})

test('authored settings survive local backup restore and a full reload', async ({ page }) => {
  test.setTimeout(90_000)
  const database = browserSmokeDatabase()
  database.showMemoryLimit = false
  await importDatabase(harness.app, browserSmokeAssertion, database)

  await page.goto(`${harness.baseUrl}/settings/display`)
  await waitForBrowserSmokeLoaded(page)
  await page.getByRole('button', { name: 'Others', exact: true }).click()

  const showMemoryLimit = page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true })
  await expect(showMemoryLimit).not.toBeChecked()
  const enabled = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === '/api/v1/commands/settings/display',
  )
  await showMemoryLimit.focus()
  await showMemoryLimit.press('Space')
  expect((await enabled).ok()).toBe(true)

  await page.goto(`${harness.baseUrl}/settings/backup`)
  await waitForBrowserSmokeLoaded(page)
  await page.getByRole('button', { name: 'Save local backup', exact: true }).click()
  const downloadStarted = page.waitForEvent('download')
  await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
  const backupDownload = await downloadStarted
  const backupPath = await backupDownload.path()
  if (!backupPath) throw new Error('Local backup download did not produce a filesystem path')
  await page
    .getByRole('dialog', { name: 'Local backup saved', exact: true })
    .getByRole('button', { name: 'OK' })
    .click()

  await page.goto(`${harness.baseUrl}/settings/display`)
  await waitForBrowserSmokeLoaded(page)
  await page.getByRole('button', { name: 'Others', exact: true }).click()
  const changedAfterBackup = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === '/api/v1/commands/settings/display',
  )
  const changedShowMemoryLimit = page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true })
  await changedShowMemoryLimit.focus()
  await changedShowMemoryLimit.press('Space')
  expect((await changedAfterBackup).ok()).toBe(true)

  await page.goto(`${harness.baseUrl}/settings/backup`)
  await waitForBrowserSmokeLoaded(page)
  await page.getByRole('button', { name: 'Load Backup Locally', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
  const fileChooserOpened = page.waitForEvent('filechooser')
  await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
  const fileChooser = await fileChooserOpened
  const restored = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/import/bundle',
  )
  await fileChooser.setFiles(backupPath)
  expect((await restored).ok()).toBe(true)
  const backupLoadedDialog = page.getByRole('dialog', { name: /^Local backup loaded(?:\.|, but )/ })
  await expect(backupLoadedDialog).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().showMemoryLimit))
    .toBe(true)
  await backupLoadedDialog.getByRole('button', { name: 'OK' }).click()

  await page.reload()
  await waitForBrowserSmokeLoaded(page)
  await page.goto(`${harness.baseUrl}/settings/display`)
  await waitForBrowserSmokeLoaded(page)
  await page.getByRole('button', { name: 'Others', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true })).toBeChecked()
})

test('authored character identity fields survive command acceptance and a full reload', async ({ page }) => {
  test.setTimeout(60_000)
  const database = browserSmokeDatabase()
  const character = (database.characters as Array<Record<string, unknown>>)[0]
  character.desc = 'Original description'
  character.firstMessage = 'Original greeting'
  await importDatabase(harness.app, browserSmokeAssertion, database)

  await page.goto(`${harness.baseUrl}/character/char-smoke/chat-smoke`)
  await waitForBrowserSmokeLoaded(page)
  await page.locator('[data-risu-sidebar-tab="character"]').click()
  const characterEditor = page.locator('[data-risu-lazy-surface="character-editor"]')
  await expect(characterEditor).toHaveAttribute('data-risu-lazy-state', 'ready')

  const name = page.getByRole('textbox', { name: 'Character Name', exact: true })
  const description = page.getByRole('textbox', { name: 'Description', exact: true })
  const firstMessage = page.getByRole('textbox', { name: 'First Message', exact: true })
  await expect(name).toHaveValue('Smoke Character')
  await expect(description).toHaveValue('Original description')
  await expect(firstMessage).toHaveValue('Original greeting')

  const acceptedPatch = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'PATCH' ||
      new URL(response.url()).pathname !== '/api/v1/commands/characters/char-smoke'
    ) {
      return false
    }
    const body = response.request().postDataJSON() as { patch?: Record<string, unknown> } | null
    return body?.patch?.firstMessage === 'Authored greeting'
  })
  await name.fill('Authored Character')
  await description.fill('Authored description')
  await firstMessage.fill('Authored greeting')
  expect((await acceptedPatch).ok()).toBe(true)

  await expect
    .poll(() =>
      page.evaluate(() => {
        const character = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters[0]
        return {
          chaId: character.chaId,
          desc: character.desc,
          firstMessage: character.firstMessage,
          name: character.name,
        }
      }),
    )
    .toEqual({
      chaId: 'char-smoke',
      desc: 'Authored description',
      firstMessage: 'Authored greeting',
      name: 'Authored Character',
    })

  await page.reload()
  await waitForBrowserSmokeLoaded(page)
  await page.locator('[data-risu-sidebar-tab="character"]').click()
  await expect(characterEditor).toHaveAttribute('data-risu-lazy-state', 'ready')
  await expect(page.getByRole('textbox', { name: 'Character Name', exact: true })).toHaveValue('Authored Character')
  await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Authored description')
  await expect(page.getByRole('textbox', { name: 'First Message', exact: true })).toHaveValue('Authored greeting')
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters[0].chaId))
    .toBe('char-smoke')
})

test('translator preset bindings persist independently across chats', async ({ page }) => {
  test.setTimeout(60_000)
  const database = browserSmokeDatabase()
  Object.assign(database, {
    translator: 'ko',
    translatorInputLanguage: 'en',
    translatorType: 'llm',
    translatorPresetId: 'translator-smoke-a',
    translatorPrompt: 'Global translator',
    translatorMaxResponse: 128,
    translatorPresets: [
      { id: 'translator-smoke-a', name: 'Translator Smoke A', prompt: 'Global translator', maxResponse: 128 },
      { id: 'translator-smoke-b', name: 'Translator Smoke B', prompt: 'Chat translator', maxResponse: 256 },
    ],
  })
  const character = database.characters as Array<{ chats: Array<Record<string, unknown>> }>
  character[0].chats.push({
    id: 'chat-smoke-b',
    name: 'Smoke Chat B',
    note: '',
    localLore: [],
    message: [],
  })
  await importDatabase(harness.app, browserSmokeAssertion, database)

  const openChat = async (chatId: string) => {
    await page.goto(`${harness.baseUrl}/character/char-smoke/${chatId}`)
    await waitForBrowserSmokeLoaded(page)
    await expect
      .poll(() =>
        page.evaluate(
          (expectedChatId) =>
            window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters[0].chats[
              window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters[0].chatPage
            ].id === expectedChatId,
          chatId,
        ),
      )
      .toBe(true)
  }
  const presetSelect = () => page.locator('[data-risu-chat-translation-setting="translatorPresetId"] select').first()

  await openChat('chat-smoke')
  await expect(presetSelect()).toBeVisible()
  await expect(presetSelect()).toHaveValue('')
  const firstBindingSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === '/api/v1/commands/chats/chat-smoke',
  )
  await presetSelect().selectOption('translator-smoke-b')
  expect((await firstBindingSaved).ok()).toBe(true)

  await openChat('chat-smoke-b')
  await expect(presetSelect()).toHaveValue('')
  const secondBindingSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === '/api/v1/commands/chats/chat-smoke-b',
  )
  await presetSelect().selectOption('translator-smoke-a')
  expect((await secondBindingSaved).ok()).toBe(true)

  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.fromEntries(
          window
            .__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
            .characters[0].chats.map((chat) => [chat.id, chat.translatorPresetId ?? null]),
        ),
      ),
    )
    .toEqual({ 'chat-smoke': 'translator-smoke-b', 'chat-smoke-b': 'translator-smoke-a' })

  await openChat('chat-smoke')
  await expect(presetSelect()).toHaveValue('translator-smoke-b')
})

test('flagged observer shell survives denial and cross-tab writer takeover without mutation', async ({ browser }) => {
  test.setTimeout(60_000)
  await importDatabase(harness.app, browserSmokeAssertion, browserSmokeDatabase())
  const writerContext = await browser.newContext()
  const observerContext = await browser.newContext()
  const observerFlagKey = 'risu:fast-bootstrap-observer-shell'
  await Promise.all([
    writerContext.addInitScript((key) => {
      try {
        sessionStorage.setItem(key, 'enabled')
      } catch {}
    }, observerFlagKey),
    observerContext.addInitScript((key) => {
      try {
        sessionStorage.setItem(key, 'enabled')
      } catch {}
    }, observerFlagKey),
  ])
  const writerPage = await writerContext.newPage()
  const observerPage = await observerContext.newPage()
  const observerCommandRequests: string[] = []
  observerPage.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/v1/commands/')) {
      observerCommandRequests.push(`${request.method()} ${url.pathname}`)
    }
  })

  try {
    await writerPage.goto(harness.baseUrl)
    await waitForBrowserSmokeLoaded(writerPage)

    await observerPage.goto(harness.baseUrl)
    await expect(observerPage.locator('[data-observer-shell]')).toBeVisible()
    await expect(observerPage.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await observerPage.getByRole('button', { name: 'Cancel', exact: true }).click()

    await expect(observerPage.locator('[data-observer-lifecycle-status]')).toContainText(
      'Another session still has write access',
    )
    expect(
      await observerPage.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters.map((character) => character.chaId),
      ),
    ).toContain('char-smoke')

    await observerPage.getByRole('button', { name: 'Open Smoke Character', exact: true }).click()
    await expect(observerPage).toHaveURL(/\/character\/char-smoke$/)
    expect(observerCommandRequests).toEqual([])

    await observerPage.getByRole('button', { name: 'Retry write access', exact: true }).click()
    await expect(observerPage.getByRole('button', { name: 'Disconnect existing client', exact: true })).toBeVisible()
    await observerPage.getByRole('button', { name: 'Disconnect existing client', exact: true }).click()
    await waitForBrowserSmokeLoaded(observerPage)

    await expect(observerPage.locator('[data-observer-shell]')).toHaveCount(0)
    await expect(observerPage.locator('[data-char-id="char-smoke"]')).toBeVisible()
    expect(observerCommandRequests).toEqual([])

    await expect(writerPage.locator('[data-observer-shell]')).toBeVisible()
    await expect
      .poll(() =>
        writerPage.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      )
      .toMatchObject({ canApplyRoutes: false, canGenerate: false, canMutate: false })
    expect(
      await writerPage.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters.map((character) => character.chaId),
      ),
    ).toContain('char-smoke')

    await writerPage.getByRole('button', { name: 'Stay on this page (offline)', exact: true }).click()
    await expect(writerPage.locator('[data-observer-lifecycle-status]')).toContainText(
      'This tab is staying in read-only mode',
    )
    await expect(writerPage.getByRole('button', { name: 'Retry write access', exact: true })).toBeVisible()
  } finally {
    await Promise.all([writerContext.close(), observerContext.close()])
  }
})

test('core chat controls and blocking alerts remain accessible across responsive viewports', async ({ page }) => {
  const database = browserSmokeDatabase()
  database.fixedChatTextarea = true
  await importDatabase(harness.app, browserSmokeAssertion, database)

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto(harness.baseUrl)
    await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded())
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.selectCharacter(0))

    const chatRow = page.locator('[data-risu-chat-id="chat-smoke"]').first()
    const mobileRecentChat = page.getByRole('button', { name: /Open most recent chat Smoke Chat/ })
    await expect.poll(async () => (await chatRow.isVisible()) || (await mobileRecentChat.isVisible())).toBe(true)
    if (await chatRow.isVisible()) {
      await chatRow.locator('button[data-risu-chat-action="select"]').click()
    } else {
      await mobileRecentChat.click()
    }

    const composer = page.getByTestId('default-chat-composer')
    const composerDock = page.locator('[data-default-chat-composer-dock]')
    const transcript = page.locator('[data-default-chat-transcript]')
    await expect(composer).toBeVisible()
    await expect(composerDock).toBeVisible()
    await expect(transcript).toBeVisible()
    await expect(composerDock.locator('[data-testid="default-chat-composer"]')).toHaveCount(1)
    await expect(transcript.locator('[data-testid="default-chat-composer"]')).toHaveCount(0)
    await expect(composer).toHaveAccessibleName(/.+/)
    await expect(page.getByTestId('default-chat-send-button')).toHaveAccessibleName(/.+/)
    await expect(page.getByTestId('default-chat-menu-button')).toHaveAccessibleName(/.+/)
    await expect(page.locator('button button')).toHaveCount(0)

    await composer.focus()
    await expect(page.locator('html')).toHaveAttribute('data-risu-visual-viewport-active', 'true')
    const chatGeometry = await page.evaluate(() => {
      const dock = document.querySelector<HTMLElement>('[data-default-chat-composer-dock]')
      const transcriptElement = document.querySelector<HTMLElement>('[data-default-chat-transcript]')
      const shell = document.querySelector<HTMLElement>('[data-risu-visual-viewport-shell]')
      if (!dock || !transcriptElement || !shell) return null
      const dockRect = dock.getBoundingClientRect()
      const transcriptRect = transcriptElement.getBoundingClientRect()
      const shellRect = shell.getBoundingClientRect()
      return {
        dockBottom: dockRect.bottom,
        shellBottom: shellRect.bottom,
        transcriptBottom: transcriptRect.bottom,
        transcriptOverflowY: getComputedStyle(transcriptElement).overflowY,
        dockTop: dockRect.top,
      }
    })
    expect(chatGeometry).not.toBeNull()
    expect(chatGeometry!.transcriptOverflowY).toBe('auto')
    expect(Math.abs(chatGeometry!.dockBottom - chatGeometry!.shellBottom)).toBeLessThanOrEqual(1)
    expect(chatGeometry!.transcriptBottom).toBeLessThanOrEqual(chatGeometry!.dockTop + 1)
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.showAlert('Accessibility smoke alert'))
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Accessibility smoke alert')
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Tab')
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    await expect(page).toHaveScreenshot(`blocking-alert-${viewport.name}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
    await page.getByRole('button', { name: 'OK' }).click()
    await expect(dialog).toBeHidden()
    await expect(composer).toBeFocused()

    await expect(page).toHaveScreenshot(`core-chat-${viewport.name}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }
})

test('latest-message start alignment never mutates spacer geometry during free scrolling', async ({ page }) => {
  const database = browserSmokeDatabase()
  database.floatingChatInput = false
  const character = (
    database.characters as Array<{
      chats: Array<Record<string, unknown> & { message?: Array<Record<string, unknown>> }>
    }>
  )[0]
  character.chats[0].message = Array.from({ length: 24 }, (_, index) => ({
    chatId: `alignment-message-${index}`,
    role: index % 2 === 0 ? 'user' : 'char',
    data:
      index === 23
        ? 'Latest alignment smoke message'
        : `Alignment history ${index}: ${'scrollable transcript content '.repeat(12)}`,
  }))
  await importDatabase(harness.app, browserSmokeAssertion, database)

  const openChat = async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(harness.baseUrl)
    await waitForBrowserSmokeLoaded(page)
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.selectCharacter(0))

    const chatRow = page.locator('[data-risu-chat-id="chat-smoke"]').first()
    const mobileRecentChat = page.getByRole('button', { name: /Open most recent chat Smoke Chat/ })
    await expect.poll(async () => (await chatRow.isVisible()) || (await mobileRecentChat.isVisible())).toBe(true)
    if (await chatRow.isVisible()) {
      await chatRow.locator('button[data-risu-chat-action="select"]').click()
    } else {
      await mobileRecentChat.click()
    }
  }

  const transcript = page.locator('[data-default-chat-transcript]')
  const latestMessage = page.locator('.chat-message-container', { hasText: 'Latest alignment smoke message' })
  const spacer = page.locator('[data-latest-message-scroll-spacer]')
  const latestStartOffset = () =>
    latestMessage.evaluate((node) => {
      const transcriptElement = document.querySelector<HTMLElement>('[data-default-chat-transcript]')
      if (!transcriptElement) return Number.POSITIVE_INFINITY
      return Math.abs(
        node.getBoundingClientRect().top -
          (transcriptElement.getBoundingClientRect().top + transcriptElement.clientTop),
      )
    })

  await openChat()
  await expect(latestMessage).toHaveCount(1)
  await expect(spacer).toHaveCount(1)
  await expect.poll(latestStartOffset).toBeLessThanOrEqual(1)
  const expandedSpacerHeight = await spacer.evaluate((node) => node.getBoundingClientRect().height)
  expect(expandedSpacerHeight).toBeGreaterThan(100)

  await transcript.dispatchEvent('pointerdown')
  await transcript.evaluate((node) => {
    node.scrollTop = -160
    node.dispatchEvent(new Event('scroll'))
  })
  await latestMessage.evaluate((node) => {
    node.style.minHeight = `${node.getBoundingClientRect().height + 180}px`
  })
  await expect
    .poll(() => spacer.evaluate((node) => node.getBoundingClientRect().height))
    .toBeCloseTo(expandedSpacerHeight, 0)

  await transcript.evaluate((node) => {
    node.scrollTop = 0
    node.dispatchEvent(new Event('scroll'))
  })
  await expect
    .poll(() => spacer.evaluate((node) => node.getBoundingClientRect().height))
    .toBeCloseTo(expandedSpacerHeight, 0)

  // Start a fresh semantic entry, consume the spacer with a tall latest row,
  // then prove a later free-scroll return to zero does not recreate it.
  await openChat()
  await expect.poll(latestStartOffset).toBeLessThanOrEqual(1)
  await latestMessage.evaluate((node) => {
    const transcriptElement = document.querySelector<HTMLElement>('[data-default-chat-transcript]')
    if (!transcriptElement) throw new Error('Expected transcript while growing latest message')
    node.style.minHeight = `${transcriptElement.clientHeight + 200}px`
  })
  await expect.poll(() => spacer.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(1)
  await expect.poll(latestStartOffset).toBeLessThanOrEqual(1)
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBeLessThan(-100)

  await transcript.dispatchEvent('pointerdown')
  await transcript.evaluate((node) => {
    node.scrollTop -= 100
    node.dispatchEvent(new Event('scroll'))
  })
  await latestMessage.evaluate((node) => node.style.removeProperty('min-height'))
  await expect.poll(() => spacer.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(1)

  await transcript.evaluate((node) => {
    node.scrollTop = 0
    node.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => spacer.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(1)
  await expect
    .poll(() => latestMessage.evaluate((node) => node.getBoundingClientRect().top))
    .toBeGreaterThan((await transcript.evaluate((node) => node.getBoundingClientRect().top)) + 50)
})

test('mobile in-flow composer opens from a button above the stable keyboard viewport', async ({ page }) => {
  const database = browserSmokeDatabase()
  database.inputHooks = [{ id: 'draft-smoke', name: 'Draft Smoke', prompt: '', type: 'draft' }]
  const character = (
    database.characters as Array<{
      chats: Array<Record<string, unknown> & { message?: Array<Record<string, unknown>> }>
    }>
  )[0]
  character.chats[0].selectedDraftHookId = 'draft-smoke'
  character.chats[0].message = Array.from({ length: 24 }, (_, index) => ({
    chatId: `keyboard-message-${index}`,
    role: index % 2 === 0 ? 'user' : 'char',
    data:
      index === 23
        ? 'Keyboard viewport message 23: newest short message'
        : `Keyboard viewport message ${index}: ${'scrollable transcript content '.repeat(12)}`,
  }))
  await importDatabase(harness.app, browserSmokeAssertion, database)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    const state = {
      height: window.innerHeight,
      offsetTop: 0,
      pageTop: 0,
    }
    const visualViewport = new EventTarget()
    Object.defineProperties(visualViewport, {
      height: { configurable: true, get: () => state.height },
      offsetTop: { configurable: true, get: () => state.offsetTop },
      pageTop: { configurable: true, get: () => state.pageTop },
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    })
    window.__RISU_SET_MOCK_VISUAL_VIEWPORT__ = (next) => {
      if (next.height !== undefined) state.height = next.height
      if (next.offsetTop !== undefined) state.offsetTop = next.offsetTop
      if (next.pageTop !== undefined) state.pageTop = next.pageTop
      if (next.event) visualViewport.dispatchEvent(new Event(next.event))
    }
  })
  await page.goto(harness.baseUrl)
  await waitForBrowserSmokeLoaded(page)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.selectCharacter(0))

  const chatRow = page.locator('[data-risu-chat-id="chat-smoke"]').first()
  const mobileRecentChat = page.getByRole('button', { name: /Open most recent chat Smoke Chat/ })
  await expect.poll(async () => (await chatRow.isVisible()) || (await mobileRecentChat.isVisible())).toBe(true)
  if (await chatRow.isVisible()) {
    await chatRow.locator('button[data-risu-chat-action="select"]').click()
  } else {
    await mobileRecentChat.click()
  }

  const composer = page.getByTestId('default-chat-composer')
  const transcript = page.locator('[data-default-chat-transcript]')
  const latestMessage = page.locator('.chat-message-container', {
    hasText: 'Keyboard viewport message 23: newest short message',
  })
  await expect(page.getByTestId('default-chat-draft-input')).toBeVisible()
  await expect(latestMessage).toHaveCount(1)
  await expect(page.locator('[data-latest-message-scroll-spacer]')).toHaveCount(1)
  await expect
    .poll(() =>
      latestMessage.evaluate((node) => {
        const transcriptElement = document.querySelector<HTMLElement>('[data-default-chat-transcript]')
        if (!transcriptElement) return Number.POSITIVE_INFINITY
        return Math.abs(
          node.getBoundingClientRect().top -
            (transcriptElement.getBoundingClientRect().top + transcriptElement.clientTop),
        )
      }),
    )
    .toBeLessThanOrEqual(1)
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(0)

  await latestMessage.evaluate((node) => {
    node.style.minHeight = `${node.getBoundingClientRect().height + 160}px`
  })
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(0)

  await latestMessage.evaluate((node) => {
    node.style.removeProperty('min-height')
  })
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(0)

  await latestMessage.evaluate((node) => {
    const transcriptElement = document.querySelector<HTMLElement>('[data-default-chat-transcript]')
    if (!transcriptElement) throw new Error('Expected transcript while expanding newest row')
    node.style.minHeight = `${transcriptElement.clientHeight + 160}px`
  })
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBeLessThan(-100)
  await expect
    .poll(() =>
      latestMessage.evaluate((node) => {
        const transcriptElement = document.querySelector<HTMLElement>('[data-default-chat-transcript]')
        if (!transcriptElement) return Number.POSITIVE_INFINITY
        return Math.abs(
          node.getBoundingClientRect().top -
            (transcriptElement.getBoundingClientRect().top + transcriptElement.clientTop),
        )
      }),
    )
    .toBeLessThanOrEqual(1)

  await latestMessage.evaluate((node) => {
    node.style.removeProperty('min-height')
  })
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(0)
  await expect(page.locator('[data-default-chat-composer-dock]')).toHaveCount(0)
  await expect(transcript.locator('[data-testid="default-chat-composer"]')).toHaveCount(1)
  await expect
    .poll(() =>
      transcript.evaluate((node) => {
        node.scrollTop = 0
        const composerElement = node.querySelector<HTMLElement>('[data-testid="default-chat-composer"]')
        if (!composerElement) return null
        return {
          composerBottom: composerElement.getBoundingClientRect().bottom,
          scrollTop: node.scrollTop,
          transcriptBottom: node.getBoundingClientRect().bottom,
        }
      }),
    )
    .toEqual(expect.objectContaining({ scrollTop: 0 }))
  await composer.focus()
  await expect(page.locator('html')).toHaveAttribute('data-risu-visual-viewport-active', 'true')
  await expect
    .poll(() => page.locator('html').evaluate((node) => node.style.getPropertyValue('--risu-visual-viewport-height')))
    .toBe('844px')

  await page.evaluate(() => {
    window.__RISU_SET_MOCK_VISUAL_VIEWPORT__?.({ event: 'resize', height: 80, offsetTop: 0, pageTop: 0 })
  })
  await page.waitForTimeout(20)

  await expect(page.locator('html')).not.toHaveAttribute('data-risu-visual-viewport-active')
  expect(
    await page.locator('html').evaluate((node) => node.style.getPropertyValue('--risu-visual-viewport-height')),
  ).toBe('')
  expect(
    await page.locator('html').evaluate((node) => ({
      pageTop: node.style.getPropertyValue('--risu-visual-viewport-page-top'),
      shifted: node.hasAttribute('data-risu-visual-viewport-shifted'),
    })),
  ).toEqual({ pageTop: '', shifted: false })

  await transcript.evaluate((node) => {
    node.scrollTop = 0
  })

  await page.evaluate(() => {
    window.__RISU_SET_MOCK_VISUAL_VIEWPORT__?.({ height: 417, offsetTop: 380, pageTop: 380 })
    const scroller = document.scrollingElement
    if (scroller) scroller.scrollTop = 267
  })
  await expect
    .poll(() =>
      page.locator('html').evaluate((node) => ({
        height: node.style.getPropertyValue('--risu-visual-viewport-height'),
        pageTop: node.style.getPropertyValue('--risu-visual-viewport-page-top'),
        shifted: node.hasAttribute('data-risu-visual-viewport-shifted'),
        scrollTop: document.scrollingElement?.scrollTop ?? null,
      })),
    )
    .toEqual({ height: '417px', pageTop: '', shifted: false, scrollTop: 0 })

  const keyboardGeometry = await page.evaluate(() => {
    const composerElement = document.querySelector<HTMLElement>('[data-testid="default-chat-composer"]')
    const transcriptElement = document.querySelector<HTMLElement>('[data-default-chat-transcript]')
    const shell = document.querySelector<HTMLElement>('[data-risu-visual-viewport-shell]')
    if (!composerElement || !transcriptElement || !shell) return null
    const composerRect = composerElement.getBoundingClientRect()
    const transcriptRect = transcriptElement.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    return {
      composerTop: composerRect.top,
      composerBottom: composerRect.bottom,
      transcriptBottom: transcriptRect.bottom,
      transcriptScrollTop: transcriptElement.scrollTop,
      shellTop: shellRect.top,
      shellBottom: shellRect.bottom,
      shellHeight: shellRect.height,
      shellMidpoint: shellRect.top + shellRect.height / 2,
      shellTransform: getComputedStyle(shell).transform,
    }
  })
  expect(keyboardGeometry).not.toBeNull()
  expect(Math.abs(keyboardGeometry!.shellTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(keyboardGeometry!.shellHeight - 417)).toBeLessThanOrEqual(1)
  expect(Math.abs(keyboardGeometry!.shellBottom - 417)).toBeLessThanOrEqual(1)
  expect(keyboardGeometry!.shellTransform).toBe('none')
  expect(keyboardGeometry!.composerTop).toBeGreaterThan(keyboardGeometry!.shellMidpoint)
  expect(Math.abs(keyboardGeometry!.transcriptBottom - keyboardGeometry!.shellBottom)).toBeLessThanOrEqual(1)
  expect(keyboardGeometry!.transcriptScrollTop).toBe(0)
  expect(keyboardGeometry!.composerBottom).toBeLessThanOrEqual(keyboardGeometry!.transcriptBottom)
  expect(keyboardGeometry!.transcriptBottom - keyboardGeometry!.composerBottom).toBeLessThanOrEqual(16)

  expect(await page.evaluate(() => window.localStorage.getItem('risu-keyboard-viewport-height:portrait'))).toBe('417')
  await composer.blur()
  await page.waitForTimeout(725)
  await expect(page.locator('html')).not.toHaveAttribute('data-risu-visual-viewport-active')
  await page.evaluate(() => {
    window.__RISU_SET_MOCK_VISUAL_VIEWPORT__?.({ height: 844, offsetTop: 0, pageTop: 0 })
  })

  const immediatePreLift = await composer.evaluate((node) => {
    const scroller = document.scrollingElement
    if (scroller) scroller.scrollTop = 267
    node.focus()
    const root = document.documentElement
    return {
      active: root.getAttribute('data-risu-visual-viewport-active'),
      height: root.style.getPropertyValue('--risu-visual-viewport-height'),
      scrollTop: scroller?.scrollTop ?? null,
    }
  })
  expect(immediatePreLift).toEqual({ active: 'true', height: '417px', scrollTop: 0 })

  const preLiftDuringMotion = await page.evaluate(() => {
    window.__RISU_SET_MOCK_VISUAL_VIEWPORT__?.({ event: 'resize', height: 417, offsetTop: 380, pageTop: 380 })
    const root = document.documentElement
    return {
      active: root.getAttribute('data-risu-visual-viewport-active'),
      height: root.style.getPropertyValue('--risu-visual-viewport-height'),
    }
  })
  expect(preLiftDuringMotion).toEqual({ active: 'true', height: '417px' })
  await page.waitForTimeout(300)
  await expect(page.locator('html')).toHaveAttribute('data-risu-visual-viewport-active', 'true')
  await expect
    .poll(() => page.locator('html').evaluate((node) => node.style.getPropertyValue('--risu-visual-viewport-height')))
    .toBe('417px')

  await composer.fill('Floating keyboard draft')

  await transcript.dispatchEvent('pointerdown')
  await expect
    .poll(() =>
      transcript.evaluate((node) => {
        node.scrollTop = -Math.min(1_200, Math.max(0, node.scrollHeight - node.clientHeight))
        node.dispatchEvent(new Event('scroll'))
        return node.scrollTop
      }),
    )
    .toBeLessThan(-40)
  const floatingCard = page.locator('[data-floating-chat-input="true"]')
  const floatingButton = page.getByTestId('floating-chat-input-button')
  await expect(floatingCard).toHaveCount(0)
  await expect(floatingButton).toBeVisible()

  // Keep enough history above the composer to remain away from the bottom
  // when hiding it releases the keyboard's reduced viewport.
  const historyAnchor = await transcript.evaluate((node) => {
    const viewport = node.getBoundingClientRect()
    const row = Array.from(node.querySelectorAll<HTMLElement>('[data-transcript-row-id]'))
      .filter(
        (row) => row.getBoundingClientRect().bottom > viewport.top && row.getBoundingClientRect().top < viewport.bottom,
      )
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0]!
    return { id: row.dataset.transcriptRowId!, top: row.getBoundingClientRect().top - viewport.top }
  })
  const historyOffset = () =>
    page.locator(`[data-transcript-row-id="${historyAnchor.id}"]`).evaluate((node) => {
      const transcriptElement = document.querySelector('[data-default-chat-transcript]')!
      return node.getBoundingClientRect().top - transcriptElement.getBoundingClientRect().top
    })

  await floatingButton.click()
  await expect(floatingCard).toBeVisible()
  await expect(floatingCard).toHaveClass(/floating-chat-composer/)
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue('Floating keyboard draft')

  const floatingGeometry = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-floating-chat-input="true"]')
    const shell = document.querySelector<HTMLElement>('[data-risu-visual-viewport-shell]')
    if (!card || !shell) return null
    const cardRect = card.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    return {
      cardTop: cardRect.top,
      cardBottom: cardRect.bottom,
      shellTop: shellRect.top,
      shellBottom: shellRect.bottom,
    }
  })
  expect(floatingGeometry).not.toBeNull()
  expect(floatingGeometry!.cardTop).toBeGreaterThanOrEqual(floatingGeometry!.shellTop)
  expect(floatingGeometry!.cardBottom).toBeLessThanOrEqual(floatingGeometry!.shellBottom)

  await page.getByTestId('default-chat-menu-button').click()
  await expect(page.getByTestId('floating-chat-input-go-to-bottom')).toBeVisible()
  await expect(page.getByTestId('floating-chat-input-hide')).toBeVisible()
  await expect(page.getByTestId('default-chat-overflow-menu')).toHaveClass(/chat-overflow-menu-fixed/)
  await page.getByTestId('floating-chat-input-hide').click()

  await expect(floatingCard).toHaveCount(0)
  await expect(floatingButton).toBeVisible()
  await expect(floatingButton).toBeFocused()
  await expect(page.locator('html')).not.toHaveAttribute('data-risu-visual-viewport-active')
  await expect.poll(async () => Math.abs((await historyOffset()) - historyAnchor.top)).toBeLessThanOrEqual(1)
  const floatingButtonGeometry = await floatingButton.evaluate((button) => {
    const shell = document.querySelector<HTMLElement>('[data-risu-visual-viewport-shell]')
    if (!shell) return null
    return {
      buttonBottom: button.getBoundingClientRect().bottom,
      shellBottom: shell.getBoundingClientRect().bottom,
    }
  })
  expect(floatingButtonGeometry).not.toBeNull()
  expect(floatingButtonGeometry!.buttonBottom).toBeLessThanOrEqual(floatingButtonGeometry!.shellBottom)

  await floatingButton.click()
  await expect(floatingCard).toBeVisible()
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue('Floating keyboard draft')
  await expect(page.locator('html')).toHaveAttribute('data-risu-visual-viewport-active', 'true')
  await expect.poll(async () => Math.abs((await historyOffset()) - historyAnchor.top)).toBeLessThanOrEqual(1)

  await page.getByTestId('default-chat-menu-button').click()
  await page.getByTestId('floating-chat-input-go-to-bottom').click()
  await expect(floatingCard).toHaveCount(0)
  await expect(floatingButton).toHaveCount(0)
  await expect(transcript).toHaveJSProperty('scrollTop', 0)
  await expect(transcript.locator('[data-default-chat-composer-flow]')).toHaveCount(1)
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue('Floating keyboard draft')
})

test('prompt presets and model profiles reorder from an immediate mobile touch drag', async ({ browser }) => {
  test.setTimeout(60_000)
  await importDatabase(harness.app, browserSmokeAssertion, browserSmokeDatabase(true))
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()

  try {
    await page.goto(`${harness.baseUrl}/settings/prompt-settings`)
    await waitForBrowserSmokeLoaded(page)

    await page.getByRole('button', { name: 'Prompt Smoke A', exact: true }).click()
    const promptRows = page.locator('[data-risu-generation-picker-row][data-risu-picker-kind="prompt"]')
    await expect(promptRows).toHaveCount(2)
    const promptReorder = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/commands/prompt-presets/reorder',
    )
    await dragByTouch(page, promptRows.nth(0).locator('[data-risu-preset-drag-handle]'), promptRows.nth(1))
    expect((await promptReorder).ok()).toBe(true)
    await expect
      .poll(() => promptRows.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.risuRowId)))
      .toEqual(['prompt-smoke-b', 'prompt-smoke-a'])

    await page.goto(`${harness.baseUrl}/settings/model`)
    await waitForBrowserSmokeLoaded(page)
    await page.getByRole('button', { name: 'Models', exact: true }).click()
    const profileRows = page.locator('[data-model-profile-row]')
    await expect(profileRows).toHaveCount(2)
    const profileReorder = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/commands/model-profiles/reorder',
    )
    await dragByTouch(page, profileRows.nth(0).locator('[data-model-profile-drag-handle]'), profileRows.nth(1))
    expect((await profileReorder).ok()).toBe(true)
    await expect
      .poll(() => profileRows.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.profileId)))
      .toEqual(['profile-smoke-b', 'profile-smoke-a'])
  } finally {
    await context.close()
  }
})

test('global lorebook page owner hydrates once, selects by stable id, and survives reload', async ({ page }) => {
  await importDatabase(harness.app, browserSmokeAssertion, browserSmokeDatabase())
  const focusedReads: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/resources/settings/loreBookPage') focusedReads.push(url.pathname)
  })

  await page.goto(`${harness.baseUrl}/settings/global-lorebook`)
  await waitForBrowserSmokeLoaded(page)
  await expect(page.getByRole('button', { name: 'Lore Smoke A', exact: true })).toBeVisible()
  expect(focusedReads).toHaveLength(1)

  await page.getByRole('button', { name: 'Lore Smoke A', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Lorebook' })
  await expect(dialog).toBeVisible()
  const selectionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/commands/lorebooks/lore-smoke-b/select',
  )
  await dialog.getByRole('button', { name: 'Lore Smoke B', exact: true }).click()
  expect((await selectionResponse).ok()).toBe(true)
  await expect(dialog.locator('.bg-selected').getByRole('button', { name: 'Lore Smoke B', exact: true })).toBeVisible()

  await page.reload()
  await waitForBrowserSmokeLoaded(page)
  await expect(page.getByRole('button', { name: 'Lore Smoke B', exact: true })).toBeVisible()
})

async function waitForBrowserSmokeLoaded(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded())
}

async function dragByTouch(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Touch drag target is not visible')

  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }
  const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height * 0.8 }
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...start, id: 1 }],
    })
    for (let step = 1; step <= 8; step += 1) {
      const progress = step / 8
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
            id: 1,
          },
        ],
      })
      await page.waitForTimeout(16)
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await session.detach()
  }
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-browser-smoke-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      staticRoot: path.resolve('dist'),
    },
    memoryWorker: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fastify browser smoke harness did not bind to a TCP port')
  }
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
  }
}

async function importDatabase(app: FastifyInstance, auth: string, database: Record<string, unknown>) {
  // The import route is writer-guarded: once an earlier test's page has
  // registered a writer session, a header-less inject is rejected with 423.
  // Claim the lease the way a freshly booted tab would (bootstrap registers
  // the requested writer session), then import under that same session.
  const writerSession = `browser-smoke-import-${randomUUID()}`
  const registered = await app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': auth, 'risu-writer-session': writerSession },
  })
  expect(registered.statusCode).toBe(200)
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': auth, 'risu-writer-session': writerSession },
    payload: { database },
  })
  expect(imported.statusCode).toBe(200)
}
