import { expect, test, type Page, type Response } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import type { FastifyInstance } from 'fastify'
import { setupBrowserSmokeAuth } from './auth.js'

// DOM-oracle journeys for visible state. These drive real clicks in the real
// Fastify-served browser, assert on rendered DOM (page.locator), and cross-check
// the store via getDatabaseSnapshot() only to classify.
//
//   - Journey 1: switch chats by clicking sidebar rows -> the generation picker
//     repaints the newly active chat's prompt preset id.
//   - Journey 2 (settle): toggle a sidebar checkbox -> the flip survives the
//     command + resource refresh (not just the optimistic paint).
//   - Journey 3 (GATE): hold an old-lineage command, open the "character"
//     sidebar tab, then import a full state replacement. The same route/history
//     entry must retain the user's sidebar view through the recovery reload.

interface Harness {
  app: FastifyInstance
  baseUrl: string
  dataDir: string
}

interface BrowserFetchResult {
  status: number
  body: unknown
}

interface RevisionedResponseBody {
  revision: number
  databaseLineage?: string
}

let harness: Harness
const diagnosticLinesByPage = new WeakMap<Page, string[]>()

test.beforeEach(async () => {
  // Fresh pages need fresh unowned databases so each case can acquire its own
  // writer without inheriting another case's ownership or mutations.
  harness = await startHarness()
  const assertion = await setupBrowserSmokeAuth(harness.app)
  await importDatabase(harness.app, assertion, phase0FixtureDatabase())
})

test.afterEach(async ({ page }, testInfo) => {
  try {
    if (testInfo.status !== testInfo.expectedStatus) {
      const diagnostics = diagnosticLinesByPage.get(page)?.slice(-20).join('\n')
      if (diagnostics) await testInfo.attach('browser diagnostics', { body: diagnostics, contentType: 'text/plain' })
    }
  } finally {
    try {
      // Release browser subscriptions before shutting down the case's server.
      await page.close()
    } finally {
      if (harness) {
        try {
          await harness.app.close()
        } finally {
          rmSync(harness.dataDir, { recursive: true, force: true })
        }
      }
    }
  }
})

test('switching chats repaints the active-chat generation picker', async ({ page }) => {
  const diagnostics = attachDiagnostics(page)
  await boot(page)
  await openCharacter(page)

  // Open chat A from the sidebar list, then confirm the picker shows preset-a.
  await clickChatRow(page, 'chat-a')
  await expect
    .poll(() => presetPickerSelectedId(page), {
      timeout: 15_000,
      message: 'active-chat prompt picker did not settle on preset-a',
    })
    .toBe('preset-a')

  // Go back to the list and open chat B. The picker must repaint preset-b.
  await page.locator('[data-risu-chat-action="back-to-chat-list"]').first().click()
  await clickChatRow(page, 'chat-b')

  await expect
    .poll(() => presetPickerSelectedId(page), {
      timeout: 15_000,
      message: 'active-chat prompt picker did not settle on preset-b',
    })
    .toBe('preset-b')

  // Classify: the rendered picker id must match the active chat's stored preset.
  const storedPresetId = await page.evaluate(() => {
    const snap = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
    const character = (snap.characters as Array<Record<string, any>>)[0]
    const chat = character.chats[character.chatPage]
    return chat?.generationSettings?.promptPresetId ?? null
  })
  expect(storedPresetId, diagnostics()).toBe('preset-b')
})

test('a sidebar toggle flip survives the command + resource refresh', async ({ page }) => {
  const diagnostics = attachDiagnostics(page)
  await boot(page)
  await openCharacter(page)
  await clickChatRow(page, 'chat-a')

  const flagControl = page.locator('[data-risu-generation-toggle-control][data-risu-toggle-key="flag"]')
  await expect(flagControl).toBeVisible({ timeout: 15_000 })
  await expect(flagControl).toHaveAttribute('data-risu-selected', 'true')

  // Drive a real click on the rendered toggle, then let the save + SSE resource
  // refresh settle. CheckInput hides the real <input>; the <label>
  // is the click target.
  const commandResponsePromise = page.waitForResponse(isFlagToggleOffCommandResponse, { timeout: 15_000 })
  await flagControl.locator('label').first().click()
  await expect
    .poll(() => flagControl.getAttribute('data-risu-selected'), {
      timeout: 15_000,
      message: 'sidebar flag toggle did not paint the command result',
    })
    .toBe('false')

  const commandResponse = await commandResponsePromise
  expect(commandResponse.status(), diagnostics()).toBe(200)
  const command = await readRevisionedResponse(commandResponse, 'chat generation-settings command')
  await waitForAppliedResourceRevision(page, command.revision)

  // The accepted command revision is now applied, so this is the settled paint
  // rather than only the immediate optimistic state.
  await expect(flagControl).toHaveAttribute('data-risu-selected', 'false')

  const stored = await page.evaluate(() => {
    const snap = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
    const character = (snap.characters as Array<Record<string, any>>)[0]
    const chat = character.chats[character.chatPage]
    return chat?.generationSettings?.sidebarToggles?.flag ?? null
  })
  expect(stored, diagnostics()).toBe('0')
})

test('the same-character sidebar view survives old-lineage recovery after import', async ({ page }) => {
  const diagnostics = attachDiagnostics(page)
  await boot(page)
  await openCharacter(page)

  // Reach the chat route via a real row click so the route-application effect
  // is the one driving store state (this is what the untrack fix guards).
  await clickChatRow(page, 'chat-a')

  // Switch the sidebar to the "character" tab.
  const characterTab = page.locator('[data-risu-sidebar-tab="character"]').first()
  await expect(characterTab).toBeVisible({ timeout: 15_000 })
  await characterTab.click()
  await expect
    .poll(() => sidebarTabActive(page, 'character'), {
      timeout: 10_000,
      message: 'character sidebar tab did not become active',
    })
    .toBe(true)
  await expect(page.locator('[data-risu-sidebar-panel="character"]').first()).toBeVisible()

  // Hold a real durable (lineage-tagged) command at the network boundary so the
  // import deterministically leaves old-lineage work in flight. Releasing it
  // after the lineage rotates must produce the ownership conflict and reload
  // this exact history entry. Only receipt-tagged mutations can hit
  // database_lineage_conflict; an untagged command would settle as a benign
  // revision_conflict and never trigger the recovery reload under test.
  const heldCommand = await holdNextRuntimeSettingsCommand(page)
  const previousDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin)
  const lineageConflictResponsePromise = page.waitForResponse(isDatabaseLineageConflictResponse, {
    timeout: 15_000,
  })
  const recoveryNavigationResponsePromise = page.waitForResponse(isRecoveryNavigationResponse(page), {
    timeout: 15_000,
  })
  await page.evaluate(() => {
    void window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true })
  })
  await heldCommand.started

  let importedResponse: BrowserFetchResult
  try {
    importedResponse = await importStateForResync(page)
  } finally {
    heldCommand.release()
  }
  expect(importedResponse.status, diagnostics()).toBe(200)
  const imported = requireRevisionedResponseBody(importedResponse.body, 'RisuSave import')
  expect(imported.databaseLineage, diagnostics()).toEqual(expect.stringMatching(/\S/))

  const lineageConflictResponse = await lineageConflictResponsePromise
  expect(await lineageConflictResponse.json(), diagnostics()).toMatchObject({
    error: 'database_lineage_conflict',
    databaseLineage: imported.databaseLineage,
  })

  const recoveryNavigationResponse = await recoveryNavigationResponsePromise
  expect(recoveryNavigationResponse.status(), diagnostics()).toBe(200)
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate((previous) => performance.timeOrigin !== previous, previousDocumentTimeOrigin)
        } catch {
          return false
        }
      },
      { timeout: 15_000, message: 'recovery navigation did not replace the document' },
    )
    .toBe(true)
  await waitForBrowserLoaded(page)
  await waitForAppliedResourceRevision(page, imported.revision)

  // Store and DOM oracles now run after the new document has loaded the imported
  // revision. The sidebar must retain the user's "character" view through that
  // authoritative recovery.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const snap = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
          const character = (snap.characters as Array<Record<string, any>>)[0]
          return character?.chats?.length ?? 0
        }),
      { timeout: 15_000, message: 'imported chats did not settle in the recovered document' },
    )
    .toBe(2)
  await expect(page).toHaveURL(/\/character\/char-1\/chat-a$/)
  expect(await sidebarTabActive(page, 'character'), diagnostics()).toBe(true)
  await expect(page.locator('[data-risu-sidebar-panel="character"]').first()).toBeVisible()
})

// --- helpers ---------------------------------------------------------------

function attachDiagnostics(page: Page): () => string {
  const lines: string[] = []
  diagnosticLinesByPage.set(page, lines)
  page.on('console', (m) => lines.push(`console.${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`))
  return () => lines.slice(-20).join('\n')
}

async function boot(page: Page): Promise<void> {
  await page.goto(harness.baseUrl)
  await waitForBrowserLoaded(page)
}

async function waitForBrowserLoaded(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 15_000 })
    .toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded())
}

async function openCharacter(page: Page): Promise<void> {
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.selectCharacter(0))
  await expect(page.locator('[data-risu-chat-list="sidebar"]').first()).toBeVisible({ timeout: 15_000 })
}

async function clickChatRow(page: Page, chatId: string): Promise<void> {
  const row = page.locator(`[data-risu-chat-idx][data-risu-chat-id="${chatId}"]`).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('button[data-risu-chat-action="select"]').click()
}

function presetPickerSelectedId(page: Page): Promise<string | null> {
  return page
    .locator('[data-risu-generation-picker-control][data-risu-picker-kind="prompt"]')
    .first()
    .getAttribute('data-risu-picker-selected-id')
}

function sidebarTabActive(page: Page, tab: 'chat' | 'character'): Promise<boolean> {
  return page
    .locator(`[data-risu-sidebar-tab="${tab}"]`)
    .first()
    .getAttribute('data-risu-sidebar-tab-active')
    .then((value) => value === 'true')
}

function isFlagToggleOffCommandResponse(response: Response): boolean {
  const request = response.request()
  if (
    request.method() !== 'PUT' ||
    new URL(response.url()).pathname !== '/api/v1/commands/chats/chat-a/generation-settings'
  ) {
    return false
  }
  try {
    const body = request.postDataJSON() as {
      generationSettings?: { sidebarToggles?: Record<string, unknown> }
      patch?: { sidebarToggles?: Record<string, unknown> }
    }
    return body.generationSettings?.sidebarToggles?.flag === '0' || body.patch?.sidebarToggles?.flag === '0'
  } catch {
    return false
  }
}

async function isDatabaseLineageConflictResponse(response: Response): Promise<boolean> {
  if (response.status() !== 409 || !new URL(response.url()).pathname.startsWith('/api/v1/commands/')) {
    return false
  }
  try {
    const body = (await response.json()) as { error?: unknown }
    return body?.error === 'database_lineage_conflict'
  } catch {
    return false
  }
}

function isRecoveryNavigationResponse(page: Page): (response: Response) => boolean {
  return (response) => {
    const request = response.request()
    return (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      request.method() === 'GET' &&
      new URL(response.url()).pathname === '/character/char-1/chat-a'
    )
  }
}

async function holdNextRuntimeSettingsCommand(page: Page): Promise<{
  started: Promise<void>
  release: () => void
}> {
  let markStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })

  await page.route(
    '**/api/v1/commands/settings/runtime',
    async (route) => {
      markStarted()
      await released
      await route.continue()
    },
    { times: 1 },
  )
  return { started, release }
}

function requireRevisionedResponseBody(value: unknown, label: string): RevisionedResponseBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned a non-object body`)
  }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
    throw new Error(`${label} returned an invalid revision`)
  }
  if (record.databaseLineage !== undefined && typeof record.databaseLineage !== 'string') {
    throw new Error(`${label} returned an invalid database lineage`)
  }
  return {
    revision: record.revision as number,
    ...(typeof record.databaseLineage === 'string' ? { databaseLineage: record.databaseLineage } : {}),
  }
}

async function readRevisionedResponse(response: Response, label: string): Promise<RevisionedResponseBody> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`${label} returned a non-JSON body (HTTP ${response.status()})`)
  }
  return requireRevisionedResponseBody(body, label)
}

async function waitForAppliedResourceRevision(page: Page, minimumRevision: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()), {
      timeout: 15_000,
      message: `browser did not apply server resource revision ${minimumRevision}`,
    })
    .toBeGreaterThanOrEqual(minimumRevision)
}

async function importStateForResync(page: Page): Promise<BrowserFetchResult> {
  const database = phase0FixtureDatabase()
  return page.evaluate(async (database) => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const res = await fetch('/api/v1/import/risusave', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ database }),
    })
    const body: unknown = await res.json().catch(() => null)
    return { status: res.status, body }
  }, database)
}

function phase0FixtureDatabase(): Record<string, unknown> {
  const sidebarToggleTemplate = 'flag=Flag'
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    selectedCharID: 0,
    // currentChar keeps the selected character after a full resync, so the
    // sidebar tab bar (which only shows with a character selected) stays mounted.
    currentChar: 0,
    characterOrder: [],
    characters: [
      {
        chaId: 'char-1',
        type: 'character',
        name: 'Phase0 Character',
        desc: 'DESC',
        utilityBot: false,
        chatPage: 0,
        firstMessage: 'Hello.',
        customscript: [],
        globalLore: [],
        viewScreen: 'none',
        emotionImages: [],
        chats: [
          {
            id: 'chat-a',
            name: 'Chat A',
            note: '',
            localLore: [],
            message: [],
            generationSettings: {
              configured: true,
              personaId: 'persona-a',
              modelPresetId: 'model-preset-a',
              promptPresetId: 'preset-a',
              jailbreakToggle: false,
              sidebarToggles: { flag: '1' },
            },
          },
          {
            id: 'chat-b',
            name: 'Chat B',
            note: '',
            localLore: [],
            message: [],
            generationSettings: {
              configured: true,
              personaId: 'persona-a',
              modelPresetId: 'model-preset-a',
              promptPresetId: 'preset-b',
              jailbreakToggle: false,
              sidebarToggles: { flag: '0' },
            },
          },
        ],
      },
    ],
    formatingOrder: ['main', 'description', 'chats'],
    modelPresets: [{ id: 'model-preset-a', name: 'Model Preset A' }],
    promptPresets: [
      { id: 'preset-a', name: 'Preset A', customPromptTemplateToggle: sidebarToggleTemplate },
      { id: 'preset-b', name: 'Preset B', customPromptTemplateToggle: sidebarToggleTemplate },
    ],
    loadouts: [],
    modules: [],
    username: 'User',
    selectedPersona: 0,
    personas: [{ id: 'persona-a', name: 'User', icon: '', largePortrait: false, personaPrompt: '' }],
    plugins: [],
    pluginCustomStorage: {},
    language: 'en',
    loreBookToken: 8000,
    mainPrompt: 'MAIN',
    maxContext: 100_000,
    maxResponse: 50,
    aiModel: 'echo_model',
  }
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-phase0-visible-'))
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
    throw new Error('Phase 0 visible-state harness did not bind to a TCP port')
  }
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, dataDir }
}

async function importDatabase(app: FastifyInstance, auth: string, database: Record<string, unknown>) {
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': auth },
    payload: { database },
  })
  expect(imported.statusCode).toBe(200)
}
