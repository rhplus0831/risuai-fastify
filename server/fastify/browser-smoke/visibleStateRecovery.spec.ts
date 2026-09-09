import { expect, test, type Page, type Response } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
//   - Journey 3 (GATE): retain the character sidebar across an old-lineage
//     command and import: conservative startup reloads, while connected startup
//     becomes a Reader in place and restores the view after Use this device.

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
      // Release subscriptions and the context's HTTP pool before server shutdown.
      await page.context().close()
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

test('role-first startup preserves the same-character sidebar view through old-lineage recovery reload', async ({
  page,
}) => {
  const diagnostics = attachDiagnostics(page)
  await openCharacterSidebarForImport(page)
  expect(await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot())).toMatchObject({
    managed: true,
    lifecycle: 'writing',
  })

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

test('connected-default import recovery preserves the character sidebar after explicit same-owner writer recovery', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000)
  page.setDefaultTimeout(10_000)
  const diagnostics = attachDiagnostics(page)
  const traffic: Array<{
    method: string
    path: string
    writerSession: string | null
    observerSession: string | null
    expectedWriterEpoch: string | null
    expectedDatabaseLineage: string | null
    disconnectExistingWriter: string | null
    mutationId: string | null
    databaseLineage: string | null
    body: string | null
  }> = []
  const bootstraps: Array<{ writerSession: string | null; status: number; body: unknown }> = []
  const bootstrapReads: Array<Promise<void>> = []
  const documentResponses: Array<{ url: string; status: number }> = []
  const evidence: Record<string, unknown> = {
    mode: 'connected-default',
    traffic,
    bootstraps,
    documentResponses,
    importEventEvidence:
      'The import response exposes state.imported. Consumption of its SSE event is inferred from source and subsequent ownership discovery; no raw SSE frame body is asserted.',
  }
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return
    const headers = request.headers()
    traffic.push({
      method: request.method(),
      path: url.pathname,
      writerSession: headers['risu-writer-session'] ?? null,
      observerSession: headers['risu-writer-observer-session'] ?? null,
      expectedWriterEpoch: headers['risu-expected-writer-epoch'] ?? null,
      expectedDatabaseLineage: headers['risu-expected-database-lineage'] ?? null,
      disconnectExistingWriter: headers['risu-disconnect-existing-writer'] ?? null,
      mutationId: headers['risu-mutation-id'] ?? null,
      databaseLineage: headers['risu-database-lineage'] ?? null,
      body: request.method() === 'GET' ? null : request.postData(),
    })
  })
  page.on('response', (response) => {
    const request = response.request()
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentResponses.push({ url: response.url(), status: response.status() })
    }
    if (new URL(response.url()).pathname === '/api/v1/bootstrap') {
      bootstrapReads.push(
        response
          .json()
          .then((body: unknown) => {
            bootstraps.push({
              writerSession: request.headers()['risu-writer-session'] ?? null,
              status: response.status(),
              body,
            })
          })
          .catch(() => undefined),
      )
    }
  })
  let heldCommand: Awaited<ReturnType<typeof holdNextRuntimeSettingsCommand>> | undefined
  try {
    expect(importOwnershipSnapshot().ownership).toMatchObject({ active_writer_session_id: null, writer_epoch: 0 })
    await openCharacterSidebarForImport(page)
    const original = await page.evaluate(() => ({
      role: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot(),
      url: location.href,
      timeOrigin: performance.timeOrigin,
    }))
    expect(original.role).toMatchObject({ managed: true, lifecycle: 'writing', recoveryAuthorized: false })
    expect(original.role.sessionId).toMatch(/\S/u)
    const beforeImport = importOwnershipSnapshot()
    expect(beforeImport.ownership).toMatchObject({ active_writer_session_id: original.role.sessionId, writer_epoch: 1 })
    expect(beforeImport.ownership.lineage).toBe(original.role.databaseLineage)
    evidence.original = {
      ...original,
      sql: beforeImport,
      sidebarCharacterActive: await sidebarTabActive(page, 'character'),
    }

    heldCommand = await holdNextRuntimeSettingsCommand(page)
    await page.evaluate(() => {
      void window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true })
    })
    await heldCommand.started
    const heldRequest = traffic.filter((request) => request.path === '/api/v1/commands/settings/runtime').at(-1)!
    expect(heldRequest).toMatchObject({
      method: 'PATCH',
      writerSession: original.role.sessionId,
      databaseLineage: original.role.databaseLineage,
      mutationId: expect.stringMatching(/\S/u),
    })
    expect(JSON.parse(heldRequest.body!)).toMatchObject({ patch: { streamGeminiThoughts: true } })
    evidence.heldRequest = heldRequest
    const importTrafficStart = traffic.length
    const importedResponse = await importStateForResync(page)
    evidence.import = { response: importedResponse }
    expect(importedResponse.status, diagnostics()).toBe(200)
    const imported = requireRevisionedResponseBody(importedResponse.body, 'RisuSave import')
    expect(imported.databaseLineage).toMatch(/\S/u)
    expect(imported.databaseLineage).not.toBe(beforeImport.ownership.lineage)
    expect(importedResponse.body).toMatchObject({ event: { type: 'state.imported', revision: imported.revision } })
    // Keep the old command held until the actual replacement projection is a
    // coherent Reader. Its later conflict must respect the superseded writer
    // generation, independent of response-versus-SSE scheduling races.
    await expect(page.locator('[data-reader-lifecycle-status]')).toHaveText(
      'Read only. Updates from the writer appear here.',
      { timeout: 30_000 },
    )
    await expect(page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', 'chat-a')
    await expect(page.locator('[data-reader-composer] textarea')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Open chat Chat B', exact: true })).toBeVisible()
    await waitForAppliedResourceRevision(page, imported.revision)
    const reader = await page.evaluate(() => ({
      role: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot(),
      url: location.href,
      timeOrigin: performance.timeOrigin,
      chatIds: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters[0]?.chats.map((chat) => chat.id),
    }))
    expect(reader).toMatchObject({
      url: original.url,
      timeOrigin: original.timeOrigin,
      chatIds: ['chat-a', 'chat-b'],
      role: {
        managed: true,
        lifecycle: 'reading',
        databaseLineage: imported.databaseLineage,
        sessionId: original.role.sessionId,
        writer: { sessionId: original.role.sessionId, epoch: 1 },
      },
    })
    const afterImport = importOwnershipSnapshot()
    expect(afterImport.ownership).toEqual({ ...beforeImport.ownership, lineage: imported.databaseLineage })
    expect(afterImport.revision).toBe(imported.revision)
    evidence.readerBeforeOldResponse = { ...reader, sql: afterImport }
    const conflictPromise = page.waitForResponse(isDatabaseLineageConflictResponse, { timeout: 20_000 })
    heldCommand.release()
    const conflict = await conflictPromise
    const conflictBody: unknown = await conflict.json()
    expect(conflictBody).toMatchObject({
      error: 'database_lineage_conflict',
      databaseLineage: imported.databaseLineage,
    })
    evidence.import = { response: importedResponse, conflictStatus: conflict.status(), conflictBody }
    await expect(page.locator('[data-reader-lifecycle-status]')).toHaveText(
      'Read only. Updates from the writer appear here.',
    )
    const readerTraffic = traffic.slice(importTrafficStart)
    const readerDiscovery = readerTraffic.filter((request) => request.path === '/api/v1/bootstrap')
    expect(readerDiscovery.length).toBeGreaterThan(0)
    expect(
      readerDiscovery.every(
        (request) => request.writerSession === null && request.observerSession === original.role.sessionId,
      ),
    ).toBe(true)
    expect(
      readerTraffic
        .filter((request) => request.path === '/api/v1/events')
        .every((request) => request.writerSession === null),
    ).toBe(true)
    expect(readerTraffic.some((request) => request.path === '/api/v1/events')).toBe(true)
    expect(readerTraffic.filter((request) => request.path.startsWith('/api/v1/commands/'))).toEqual([])
    expect(readerTraffic.filter((request) => request.disconnectExistingWriter !== null)).toEqual([])
    expect(documentResponses).toEqual([{ url: harness.baseUrl + '/', status: 200 }])
    evidence.reader = { ...reader, sql: afterImport, traffic: readerTraffic }

    const promotionTrafficStart = traffic.length
    await page.locator('[data-reader-use-this-device]').click()
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()), {
        timeout: 30_000,
      })
      .toMatchObject({
        managed: true,
        lifecycle: 'writing',
        databaseLineage: imported.databaseLineage,
        sessionId: original.role.sessionId,
        writer: { sessionId: original.role.sessionId, epoch: 1 },
      })
    await expect
      .poll(() =>
        page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      )
      .toMatchObject({ canMutate: true, canGenerate: true })
    await expect(page.getByTestId('default-chat-composer')).toBeEditable()
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot()))
      .toMatchObject({ outbox: [], receiptAcknowledgements: [] })
    const afterPromotion = importOwnershipSnapshot()
    expect(afterPromotion).toEqual(afterImport)
    const promotionRequests = traffic.slice(promotionTrafficStart)
    const acquisition = promotionRequests.filter(
      (request) => request.path === '/api/v1/bootstrap' && request.writerSession !== null,
    )
    expect(acquisition).toEqual([
      expect.objectContaining({
        writerSession: original.role.sessionId,
        expectedWriterEpoch: '1',
        expectedDatabaseLineage: imported.databaseLineage,
        disconnectExistingWriter: null,
      }),
    ])
    expect(promotionRequests.filter((request) => request.disconnectExistingWriter !== null)).toEqual([])
    await Promise.all(bootstrapReads)
    const acquiredResponses = bootstraps.filter(
      (response) =>
        response.writerSession === original.role.sessionId &&
        (response.body as { databaseLineage?: unknown } | null)?.databaseLineage === imported.databaseLineage,
    )
    expect(acquiredResponses).toEqual([
      expect.objectContaining({
        status: 200,
        body: expect.objectContaining({
          databaseLineage: imported.databaseLineage,
          writer: { sessionId: original.role.sessionId, epoch: 1 },
          requestedWriterWasActive: true,
        }),
      }),
    ])
    const final = await page.evaluate(() => ({
      role: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot(),
      url: location.href,
      timeOrigin: performance.timeOrigin,
    }))
    evidence.afterPromotion = {
      ...final,
      sql: afterPromotion,
      traffic: promotionRequests,
      acquisitionResponses: acquiredResponses,
      sidebarCharacterActive: await sidebarTabActive(page, 'character'),
    }
    expect(final).toMatchObject({ url: original.url, timeOrigin: original.timeOrigin })
    expect(documentResponses).toHaveLength(1)
    expect(await sidebarTabActive(page, 'character'), diagnostics()).toBe(true)
    await expect(page.locator('[data-risu-sidebar-panel="character"]').first()).toBeVisible()
  } finally {
    heldCommand?.release()
    await Promise.all(bootstrapReads)
    evidence.terminalSql = importOwnershipSnapshot()
    await testInfo.attach('connected-import-sidebar-recovery.json', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
  }
})

// --- helpers ---------------------------------------------------------------

function importOwnershipSnapshot() {
  const database = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    return {
      ownership: database
        .prepare('SELECT lineage, active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
        .get() as { lineage: string; active_writer_session_id: string | null; writer_epoch: number },
      revision: (database.prepare('SELECT revision FROM schema_version WHERE id = 1').get() as { revision: number })
        .revision,
      settings: database.prepare('SELECT data_json FROM settings WHERE id = 1').get(),
      chats: database
        .prepare('SELECT id, character_id, position, data_json FROM chats ORDER BY character_id, position')
        .all(),
      events: database
        .prepare('SELECT revision, type, resource, origin_writer_session_id FROM command_events ORDER BY revision')
        .all(),
      receipts: database
        .prepare(
          'SELECT mutation_id, database_lineage, creator_writer_session_id, request_fingerprint, response_json FROM command_mutation_receipts ORDER BY mutation_id',
        )
        .all(),
    }
  } finally {
    database.close()
  }
}

async function openCharacterSidebarForImport(page: Page): Promise<void> {
  await boot(page)
  await openCharacter(page)
  // Real row and tab clicks establish the route and the originating view.
  await clickChatRow(page, 'chat-a')
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
}

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
