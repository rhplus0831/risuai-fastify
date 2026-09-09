import { devices, expect, test, type Page, type Request } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getSchemaState } from '../src/db.js'
import {
  closeFastBootstrapHarness,
  setObserverShellMode,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

const CHARACTER_A = 'connected-reader-character-a'
const CHARACTER_B = 'connected-reader-character-b'
const CHAT_A = 'connected-reader-chat-a'
const CHAT_B = 'connected-reader-chat-b'
const ROUTE_A = `/character/${CHARACTER_A}/${CHAT_A}`
const ROUTE_B = `/character/${CHARACTER_B}/${CHAT_B}`
const SESSION_KEY = 'risu:active-writer-session-id'
const SEED_MESSAGE_COUNT = 65
const COPY_TEXT = 'Reader B can copy this committed conversation.'
const LIVE_MESSAGE_ID = 'connected-reader-live-message'
const LIVE_TEXT = 'Writer A committed this message while Reader B was connected.'
const SECOND_READER_MESSAGE_ID = 'connected-reader-independent-message'
const SECOND_READER_TEXT = 'Reader C receives this commit in its own selected chat.'
const RECONNECTED_MESSAGE_ID = 'connected-reader-reconnected-message'
const RECONNECTED_TEXT = 'Writer A committed this message while Reader B was offline.'
// resourceReads.ts registers these exact POST routes with cacheReadRouteOptions;
// their bodies contain cache hashes and their handlers only return read values.
const CACHE_READ_PATHS = new Set([
  ...['display', 'advanced', 'media', 'modules', 'agents', 'language', 'prompt'].map(
    (group) => `/api/v1/settings/${group}`,
  ),
  ...['modules', 'promptPresets', 'personas'].map((name) => `/api/v1/collections/${name}`),
])

interface ApiRequestRecord {
  method: string
  path: string
  query: string
  writerSession: string | null
  observerSession: string | null
}

function fixture(): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  const baseCharacter = (database.characters as Array<Record<string, unknown>>)[0]!
  return {
    ...database,
    useChatCopy: true,
    chatLoadInitialPages: 15,
    chatLoadAdditionalPages: 15,
    characterOrder: [CHARACTER_A, CHARACTER_B],
    characters: [
      {
        ...baseCharacter,
        chaId: CHARACTER_A,
        name: 'Reader Character A',
        alternateGreetings: [],
        chats: [
          {
            id: CHAT_A,
            name: 'Reader Chat A',
            fmIndex: -1,
            note: '',
            localLore: [],
            message: Array.from({ length: SEED_MESSAGE_COUNT }, (_, index) => ({
              chatId: `connected-reader-history-${index}`,
              role: index % 2 ? 'char' : 'user',
              data: `Reader history message ${index}. **Committed text** remains readable on a narrow mobile display.`,
            })),
          },
        ],
      },
      {
        ...baseCharacter,
        chaId: CHARACTER_B,
        name: 'Reader Character B',
        alternateGreetings: [],
        chats: [
          {
            id: CHAT_B,
            name: 'Reader Chat B',
            fmIndex: -1,
            note: '',
            localLore: [],
            message: [{ chatId: 'connected-reader-copy-message', role: 'char', data: COPY_TEXT }],
          },
        ],
      },
    ],
  }
}

function recordApiRequest(request: Request, records: ApiRequestRecord[]): void {
  const url = new URL(request.url())
  if (!url.pathname.startsWith('/api/')) return
  const headers = request.headers()
  records.push({
    method: request.method(),
    path: url.pathname,
    query: url.search,
    writerSession: headers['risu-writer-session'] ?? null,
    observerSession: headers['risu-writer-observer-session'] ?? null,
  })
}

function isReaderMutation(request: ApiRequestRecord): boolean {
  if (request.writerSession !== null && (request.path === '/api/v1/bootstrap' || request.path === '/api/v1/events'))
    return true
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false
  // These POST transports authenticate, report diagnostics, or perform pure display reads.
  if (
    request.method === 'POST' &&
    (request.path.startsWith('/api/v1/auth/') ||
      request.path === '/api/v1/diagnostics' ||
      request.path === '/api/v1/telemetry/startup' ||
      CACHE_READ_PATHS.has(request.path) ||
      /^\/api\/v1\/chats\/[^/]+\/display-sources$/u.test(request.path))
  )
    return false
  return true
}

function durableSnapshot(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    return {
      revision: getSchemaState(db).revision,
      ownership: db
        .prepare('SELECT lineage, active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
        .get() as { lineage: string; active_writer_session_id: string | null; writer_epoch: number },
      settings: db.prepare('SELECT data_json FROM settings WHERE id = 1').get(),
      characters: db.prepare('SELECT id, position, data_json FROM characters ORDER BY position').all(),
      chats: db
        .prepare('SELECT id, character_id, position, data_json FROM chats ORDER BY character_id, position')
        .all(),
      messages: db.prepare('SELECT chat_id, seq, uid, role, data FROM messages ORDER BY chat_id, seq').all(),
      events: db
        .prepare(
          'SELECT revision, type, resource, id, parent_id, origin_writer_session_id FROM command_events ORDER BY revision',
        )
        .all(),
    }
  } finally {
    db.close()
  }
}

async function waitForSmokeHook(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), {
      timeout: 30_000,
    })
    .toBe(true)
}

async function expectReader(page: Page, chatId: string): Promise<void> {
  await expect(page.locator('[data-observer-lifecycle-status]')).toHaveText(
    'Read only. Updates from the writer appear here.',
    { timeout: 30_000 },
  )
  await expect(page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', chatId)
  await expect(page.locator('[data-reader-composer-field="message"]')).toBeDisabled()
  await expect(page.locator('[data-observer-writer-retry]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
  ).toMatchObject({ canMutate: false, canGenerate: false })
}

function messageBody(page: Page, id: string) {
  return page.locator(`.risu-chat[data-risu-message-id="${id}"] .chat-message-body`)
}

async function openReaderNavigation(page: Page): Promise<void> {
  const toggle = page.locator('[data-reader-navigation-toggle]')
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  const back = page.locator('[data-reader-go-back]')
  if (await back.isVisible()) await back.click()
}

async function writerCommand(page: Page, commandPath: string, body: Record<string, unknown>): Promise<number> {
  const result = await page.evaluate(
    async ({ commandPath, body }) => {
      const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
      const bootstrapResponse = await fetch('/api/v1/bootstrap', { headers })
      if (!bootstrapResponse.ok) throw new Error(`Writer bootstrap failed: ${bootstrapResponse.status}`)
      const bootstrap = (await bootstrapResponse.json()) as { revision: number; databaseLineage: string }
      const response = await fetch(commandPath, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'risu-database-lineage': bootstrap.databaseLineage },
        body: JSON.stringify({ ...body, baseRevision: bootstrap.revision }),
      })
      return { status: response.status, body: (await response.json()) as { revision?: number } }
    },
    { commandPath, body },
  )
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  expect(result.body.revision).toEqual(expect.any(Number))
  return result.body.revision!
}

async function expectAppliedRevision(page: Page, revision: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision() ?? -1), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(revision)
}

test('a mobile connected Reader follows committed updates and browses locally without taking write access', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const harness = await startFastBootstrapHarness(fixture(), {
    temporaryDirectoryPrefix: 'risu-connected-reader-browsing-',
    databaseSeedMode: 'unowned-migration',
  })
  const writerContext = await browser.newContext()
  const readerContext = await browser.newContext({
    ...devices['Pixel 7'],
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  writerContext.setDefaultTimeout(10_000)
  readerContext.setDefaultTimeout(10_000)
  const readerRequests: ApiRequestRecord[] = []
  const clonedTabRequests: ApiRequestRecord[] = []
  const pageErrors: string[] = []
  const evidence: Record<string, unknown> = { readerRequests, clonedTabRequests, pageErrors }
  const writer = await writerContext.newPage()
  const reader = await readerContext.newPage()
  readerContext.on('request', (request) => recordApiRequest(request, readerRequests))
  writer.on('pageerror', (error) => pageErrors.push(`writer: ${error.message}`))
  reader.on('pageerror', (error) => pageErrors.push(`reader: ${error.message}`))
  try {
    await setObserverShellMode(writerContext, 'enabled')
    await setObserverShellMode(readerContext, 'enabled')
    evidence.initial = durableSnapshot(harness.dataDir)
    expect(durableSnapshot(harness.dataDir).ownership).toMatchObject({
      active_writer_session_id: null,
      writer_epoch: 0,
    })

    await writer.goto(`${harness.baseUrl}${ROUTE_A}`, { waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(writer)
    await writer.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    expect(
      await writer.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
    ).toMatchObject({ canMutate: true, canGenerate: true })
    const writerSession = await writer.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)
    expect(writerSession).toMatch(/\S/u)
    expect(durableSnapshot(harness.dataDir).ownership).toMatchObject({
      active_writer_session_id: writerSession,
      writer_epoch: 1,
    })

    await reader.goto(`${harness.baseUrl}${ROUTE_A}`, { waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(reader)
    await expectReader(reader, CHAT_A)
    await expect(messageBody(reader, `connected-reader-history-${SEED_MESSAGE_COUNT - 1}`)).toContainText(
      `Reader history message ${SEED_MESSAGE_COUNT - 1}.`,
    )
    const readerSession = await reader.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)
    expect(readerSession).toMatch(/\S/u)
    expect(readerSession).not.toBe(writerSession)
    expect(readerRequests.filter(isReaderMutation)).toEqual([])
    evidence.sessions = { writerSession, readerSession, mobileViewport: reader.viewportSize() }

    // Ordinary scrolling crosses the first message page while the Reader owns no selected character.
    const scroll = reader.locator('[data-reader-scroll]')
    await scroll.hover()
    for (let gesture = 0; gesture < 12; gesture++) {
      if (
        readerRequests.some(
          (request) =>
            request.path === `/api/v1/chats/${CHAT_A}/messages` && new URLSearchParams(request.query).has('start'),
        )
      )
        break
      await reader.mouse.wheel(0, -2_000)
      await reader.waitForTimeout(150)
    }
    await expect
      .poll(() =>
        readerRequests.some(
          (request) =>
            request.path === `/api/v1/chats/${CHAT_A}/messages` && new URLSearchParams(request.query).has('start'),
        ),
      )
      .toBe(true)
    await expect
      .poll(() =>
        reader
          .locator('[data-reader-transcript] .risu-chat[data-chat-index]')
          .evaluateAll((rows) =>
            rows.some(
              (row) =>
                Number(row.getAttribute('data-chat-index')) < 50 &&
                Boolean(row.querySelector('.chat-message-body')?.textContent?.includes('Reader history message')),
            ),
          ),
      )
      .toBe(true)

    await reader.reload({ waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(reader)
    await expectReader(reader, CHAT_A)
    await expect(messageBody(reader, `connected-reader-history-${SEED_MESSAGE_COUNT - 1}`)).toContainText(
      `Reader history message ${SEED_MESSAGE_COUNT - 1}.`,
    )
    expect(await reader.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe(readerSession)

    // Duplicated browser tabs can inherit sessionStorage. Real origin Web Locks
    // must prevent that copied writer identity from becoming a second writer.
    const clonedTab = await writerContext.newPage()
    clonedTab.on('request', (request) => recordApiRequest(request, clonedTabRequests))
    clonedTab.on('pageerror', (error) => pageErrors.push(`cloned tab: ${error.message}`))
    await clonedTab.addInitScript(({ key, copiedId }) => sessionStorage.setItem(key, copiedId!), {
      key: SESSION_KEY,
      copiedId: writerSession,
    })
    await clonedTab.goto(`${harness.baseUrl}${ROUTE_A}`, { waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(clonedTab)
    await expectReader(clonedTab, CHAT_A)
    const clonedTabSession = await clonedTab.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)
    expect(clonedTabSession).toMatch(/\S/u)
    expect(clonedTabSession).not.toBe(writerSession)
    expect(clonedTabSession).not.toBe(readerSession)
    expect(clonedTabRequests.filter(isReaderMutation)).toEqual([])
    evidence.clonedTabSession = clonedTabSession
    await writer.reload({ waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(writer)
    await writer.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    expect(await writer.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe(writerSession)
    expect(durableSnapshot(harness.dataDir).ownership).toMatchObject({
      active_writer_session_id: writerSession,
      writer_epoch: 1,
    })

    const liveRevision = await writerCommand(writer, `/api/v1/commands/chats/${CHAT_A}/messages`, {
      message: { chatId: LIVE_MESSAGE_ID, role: 'char', data: LIVE_TEXT },
    })
    for (const observer of [reader, clonedTab]) {
      await expect(messageBody(observer, LIVE_MESSAGE_ID)).toHaveText(LIVE_TEXT, { timeout: 30_000 })
      await expectAppliedRevision(observer, liveRevision)
    }
    const liveSnapshot = durableSnapshot(harness.dataDir)
    expect(liveSnapshot.messages).toContainEqual(expect.objectContaining({ uid: LIVE_MESSAGE_ID, data: LIVE_TEXT }))
    expect(liveSnapshot.events).toContainEqual(
      expect.objectContaining({ revision: liveRevision, id: LIVE_MESSAGE_ID, origin_writer_session_id: writerSession }),
    )
    evidence.liveRevision = liveRevision

    await writer.getByRole('button', { name: 'Reader Character B', exact: true }).click()
    await writer.getByRole('button', { name: 'Open most recent chat Reader Chat B', exact: true }).click()
    await expect(writer).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
    await expect(messageBody(writer, 'connected-reader-copy-message')).toHaveText(COPY_TEXT)
    await expect
      .poll(() => writer.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot()))
      .toMatchObject({ outbox: [], receiptAcknowledgements: [] })
    const selectionRevision = durableSnapshot(harness.dataDir).revision
    await expectAppliedRevision(reader, selectionRevision)
    await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_A}`)
    await expectReader(reader, CHAT_A)
    await expectAppliedRevision(clonedTab, selectionRevision)
    await expect(clonedTab).toHaveURL(`${harness.baseUrl}${ROUTE_A}`)
    await expectReader(clonedTab, CHAT_A)
    const beforeSecondReaderNavigation = durableSnapshot(harness.dataDir)
    expect(JSON.parse((beforeSecondReaderNavigation.settings as { data_json: string }).data_json)).toMatchObject({
      currentChar: 1,
    })
    const writerUrl = writer.url()

    await openReaderNavigation(clonedTab)
    await clonedTab.getByRole('button', { name: 'Open Reader Character B', exact: true }).click()
    await clonedTab.getByRole('button', { name: 'Open chat Reader Chat B', exact: true }).click()
    await expect(clonedTab).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
    await expectReader(clonedTab, CHAT_B)
    await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_A}`)
    expect(durableSnapshot(harness.dataDir)).toEqual(beforeSecondReaderNavigation)
    const secondReaderRevision = await writerCommand(writer, `/api/v1/commands/chats/${CHAT_B}/messages`, {
      message: { chatId: SECOND_READER_MESSAGE_ID, role: 'char', data: SECOND_READER_TEXT },
    })
    await expect(messageBody(clonedTab, SECOND_READER_MESSAGE_ID)).toHaveText(SECOND_READER_TEXT, { timeout: 30_000 })
    await expectAppliedRevision(clonedTab, secondReaderRevision)
    await expectAppliedRevision(reader, secondReaderRevision)
    await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_A}`)
    await expectReader(reader, CHAT_A)
    await expect(messageBody(reader, SECOND_READER_MESSAGE_ID)).toHaveCount(0)
    const beforeLocalBrowsing = durableSnapshot(harness.dataDir)
    expect(beforeLocalBrowsing.events).toContainEqual(
      expect.objectContaining({
        revision: secondReaderRevision,
        id: SECOND_READER_MESSAGE_ID,
        origin_writer_session_id: writerSession,
      }),
    )
    evidence.secondReaderRevision = secondReaderRevision
    evidence.independentReaderRoutes = { reader: reader.url(), clonedTab: clonedTab.url() }

    // These are production navigation buttons. Reader selection must never become a command.
    await openReaderNavigation(reader)
    await reader.getByRole('button', { name: 'Open Reader Character B', exact: true }).click()
    await reader.getByRole('button', { name: 'Open chat Reader Chat B', exact: true }).click()
    await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
    await expectReader(reader, CHAT_B)
    await expect(messageBody(reader, 'connected-reader-copy-message')).toHaveText(COPY_TEXT)
    const copyRow = reader.locator('.risu-chat[data-risu-message-id="connected-reader-copy-message"]')
    await copyRow.locator('[data-risu-message-action="copy"]').click()
    await expect.poll(() => reader.evaluate(() => navigator.clipboard.readText())).toBe(COPY_TEXT)
    await reader.keyboard.press('Escape')

    await openReaderNavigation(reader)
    await reader.getByRole('button', { name: 'Open Reader Character A', exact: true }).click()
    await reader.getByRole('button', { name: 'Open chat Reader Chat A', exact: true }).click()
    await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_A}`)
    await expectReader(reader, CHAT_A)
    await reader.goBack()
    await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_A}`)
    await reader.goBack()
    await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_B}`)
    await reader.goBack()
    await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
    await expect(messageBody(reader, 'connected-reader-copy-message')).toHaveText(COPY_TEXT)
    await reader.goForward()
    await reader.goForward()
    await reader.goForward()
    await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_A}`)
    await expect(messageBody(reader, LIVE_MESSAGE_ID)).toHaveText(LIVE_TEXT)

    await reader.reload({ waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(reader)
    await expectReader(reader, CHAT_A)
    await expect(messageBody(reader, LIVE_MESSAGE_ID)).toHaveText(LIVE_TEXT)
    expect(await reader.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe(readerSession)
    await writer.bringToFront()
    await reader.bringToFront()
    await expectReader(reader, CHAT_A)
    expect(writer.url()).toBe(writerUrl)
    await expect(clonedTab).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
    await expectReader(clonedTab, CHAT_B)
    await expect(messageBody(clonedTab, SECOND_READER_MESSAGE_ID)).toHaveText(SECOND_READER_TEXT)
    expect(durableSnapshot(harness.dataDir)).toEqual(beforeLocalBrowsing)
    expect(readerRequests.filter(isReaderMutation)).toEqual([])
    evidence.afterLocalBrowsing = durableSnapshot(harness.dataDir)

    await readerContext.setOffline(true)
    evidence.offline = await reader.evaluate(() => ({ online: navigator.onLine }))
    expect(evidence.offline).toEqual({ online: false })
    await expect(reader.locator('[data-observer-lifecycle-status]')).toHaveText(
      'Connection interrupted. Showing the last received content.',
      { timeout: 15_000 },
    )
    await expect(messageBody(reader, LIVE_MESSAGE_ID)).toHaveText(LIVE_TEXT)
    const reconnectRevision = await writerCommand(writer, `/api/v1/commands/chats/${CHAT_A}/messages`, {
      message: { chatId: RECONNECTED_MESSAGE_ID, role: 'char', data: RECONNECTED_TEXT },
    })
    await expectAppliedRevision(clonedTab, reconnectRevision)
    await expect(clonedTab).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
    await expectReader(clonedTab, CHAT_B)
    await readerContext.setOffline(false)
    await expectReader(reader, CHAT_A)
    await expect(messageBody(reader, RECONNECTED_MESSAGE_ID)).toHaveText(RECONNECTED_TEXT, { timeout: 30_000 })
    await expectAppliedRevision(reader, reconnectRevision)
    evidence.reconnectRevision = reconnectRevision
    evidence.final = durableSnapshot(harness.dataDir)
    expect(durableSnapshot(harness.dataDir).ownership).toEqual(beforeLocalBrowsing.ownership)
    expect(readerRequests.filter(isReaderMutation)).toEqual([])
    expect(clonedTabRequests.filter(isReaderMutation)).toEqual([])
    const readerBootstraps = readerRequests.filter((request) => request.path === '/api/v1/bootstrap')
    expect(readerBootstraps.length).toBeGreaterThanOrEqual(2)
    expect(
      readerBootstraps.every((request) => request.observerSession === readerSession && request.writerSession === null),
    ).toBe(true)
    expect(readerRequests.some((request) => request.path === '/api/v1/events' && request.writerSession === null)).toBe(
      true,
    )
    const clonedBootstraps = clonedTabRequests.filter((request) => request.path === '/api/v1/bootstrap')
    expect(clonedBootstraps.length).toBeGreaterThan(0)
    expect(
      clonedBootstraps.every(
        (request) => request.observerSession === clonedTabSession && request.writerSession === null,
      ),
    ).toBe(true)
    expect(
      clonedTabRequests.some((request) => request.path === '/api/v1/events' && request.writerSession === null),
    ).toBe(true)
    const readerLifecycleEvidence = []
    for (const [name, observer] of [
      ['reader', reader],
      ['clonedTab', clonedTab],
    ] as const) {
      const lifecycle = await observer.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot())
      const role = await observer.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot())
      expect(lifecycle).toMatchObject({
        outbox: [],
        receiptAcknowledgements: [],
        activeGenerationJobs: [],
        activeChatGenerations: [],
      })
      expect(role).toMatchObject({
        managed: true,
        lifecycle: 'reading',
        writer: { sessionId: writerSession, epoch: 1 },
      })
      readerLifecycleEvidence.push({ name, role, lifecycle, url: observer.url() })
    }
    evidence.readerLifecycleEvidence = readerLifecycleEvidence
    expect(pageErrors).toEqual([])
    const screenshotPath = testInfo.outputPath('connected-reader-mobile.png')
    await reader.screenshot({ path: screenshotPath })
    await testInfo.attach('connected-reader-mobile.png', { path: screenshotPath, contentType: 'image/png' })
  } finally {
    try {
      evidence.forbiddenReaderRequests = readerRequests.filter(isReaderMutation)
      evidence.forbiddenClonedTabRequests = clonedTabRequests.filter(isReaderMutation)
      evidence.terminal = durableSnapshot(harness.dataDir)
      const evidencePath = testInfo.outputPath('connected-reader-browsing.json')
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
      await testInfo.attach('connected-reader-browsing.json', { path: evidencePath, contentType: 'application/json' })
      if (testInfo.status !== testInfo.expectedStatus) {
        const screenshot = await reader.screenshot().catch(() => null)
        if (screenshot) {
          await testInfo.attach('connected-reader-failure.png', { body: screenshot, contentType: 'image/png' })
        }
      }
    } finally {
      await readerContext.close().catch(() => undefined)
      await writerContext.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  }
})
