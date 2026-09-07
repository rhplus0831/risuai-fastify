import { expect, type Page, type Request, type TestInfo } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { getSchemaState } from '../src/db.js'
import { smallFastBootstrapFixture, type FastBootstrapHarness } from './fastBootstrapHarness.js'

export const ROLLOUT_CHARACTER = 'reader-rollout-character'
export const ROLLOUT_CHAT = 'reader-rollout-chat'
export const ROLLOUT_MESSAGE = 'reader-rollout-message'
export const ROLLOUT_ROUTE = `/character/${ROLLOUT_CHARACTER}/${ROLLOUT_CHAT}`
export const ROLLOUT_ORIGINAL = 'This committed message remains visible through server restart and fallback.'
export const WRITER_SESSION_KEY = 'risu:active-writer-session-id'

export function rolloutFixture(): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  return {
    ...database,
    characterOrder: [ROLLOUT_CHARACTER],
    characters: [
      {
        ...(database.characters as Array<Record<string, unknown>>)[0],
        chaId: ROLLOUT_CHARACTER,
        name: 'Reader Rollout Character',
        alternateGreetings: [],
        chats: [
          {
            id: ROLLOUT_CHAT,
            name: 'Reader Rollout Chat',
            fmIndex: -1,
            note: '',
            localLore: [],
            message: [{ chatId: ROLLOUT_MESSAGE, role: 'char', data: ROLLOUT_ORIGINAL }],
          },
        ],
      },
    ],
  }
}

export function rolloutDurableSnapshot(dataDir: string) {
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
      receipts: db
        .prepare(
          'SELECT mutation_id, database_lineage, creator_writer_session_id, request_fingerprint, response_json, created_at, acknowledged_at FROM command_mutation_receipts ORDER BY mutation_id',
        )
        .all(),
    }
  } finally {
    db.close()
  }
}

export interface RolloutApiRequest {
  method: string
  path: string
  query: string
  writerSession: string | null
  observerSession: string | null
  disconnectExistingWriter: string | null
  expectedWriterEpoch: string | null
  expectedDatabaseLineage: string | null
  mutationId: string | null
  body: string | null
}

export function recordRolloutApiRequest(request: Request, records: RolloutApiRequest[]): void {
  const url = new URL(request.url())
  if (!url.pathname.startsWith('/api/')) return
  const headers = request.headers()
  records.push({
    method: request.method(),
    path: url.pathname,
    query: url.search,
    writerSession: headers['risu-writer-session'] ?? null,
    observerSession: headers['risu-writer-observer-session'] ?? null,
    disconnectExistingWriter: headers['risu-disconnect-existing-writer'] ?? null,
    expectedWriterEpoch: headers['risu-expected-writer-epoch'] ?? null,
    expectedDatabaseLineage: headers['risu-expected-database-lineage'] ?? null,
    mutationId: headers['risu-mutation-id'] ?? null,
    body: request.method() === 'GET' ? null : request.postData(),
  })
}

// Exact cacheReadRouteOptions POSTs in resourceReads.ts are pure reads.
const CACHE_READ_PATHS = new Set([
  ...['display', 'advanced', 'media', 'modules', 'agents', 'language', 'prompt'].map(
    (group) => `/api/v1/settings/${group}`,
  ),
  ...['modules', 'promptPresets', 'personas'].map((name) => `/api/v1/collections/${name}`),
])

export function isForbiddenReaderRequest(request: RolloutApiRequest): boolean {
  if (request.disconnectExistingWriter !== null) return true
  if (request.writerSession !== null && ['/api/v1/bootstrap', '/api/v1/events'].includes(request.path)) return true
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false
  return !(
    request.method === 'POST' &&
    (request.path.startsWith('/api/v1/auth/') ||
      request.path === '/api/v1/diagnostics' ||
      request.path === '/api/v1/telemetry/startup' ||
      CACHE_READ_PATHS.has(request.path) ||
      /^\/api\/v1\/chats\/[^/]+\/display-sources$/u.test(request.path))
  )
}

export async function waitForRolloutHook(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 30_000 })
    .toBe(true)
}

export async function expectRolloutWriter(page: Page): Promise<void> {
  await waitForRolloutHook(page)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000))
  await expect
    .poll(
      () => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      { timeout: 30_000 },
    )
    .toMatchObject({ canMutate: true, canGenerate: true })
  await expect(page.getByTestId('default-chat-composer')).toBeEditable()
  await expect(page.locator('[data-observer-writer-retry]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0)
}

export async function expectRolloutReader(page: Page): Promise<void> {
  await waitForRolloutHook(page)
  await expect(page.locator('[data-observer-lifecycle-status]')).toHaveText(
    'Read only. Updates from the writer appear here.',
    { timeout: 30_000 },
  )
  await expect(page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', ROLLOUT_CHAT)
  await expect(page.locator('[data-reader-composer] textarea')).toBeDisabled()
  await expect(page.locator('[data-observer-writer-retry]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
  ).toMatchObject({ canMutate: false, canGenerate: false })
}

export function rolloutMessageBody(page: Page) {
  return page.locator(`.risu-chat[data-risu-message-id="${ROLLOUT_MESSAGE}"] .chat-message-body`)
}

export async function saveRolloutMessageThroughUi(page: Page, text: string): Promise<void> {
  const row = page.locator(`.risu-chat[data-risu-message-id="${ROLLOUT_MESSAGE}"]`)
  const edit = row.locator('[data-risu-message-action="edit"]')
  if (await edit.count()) await edit.click()
  else {
    await row.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.locator('#risu-popup-menu [data-risu-message-action="edit"]').click()
  }
  const popup = page.getByRole('dialog', { name: 'Popup Editor', exact: true })
  await expect(popup).toBeVisible()
  await popup.getByRole('textbox', { name: 'Plain text editor', exact: true }).fill(text)
  // The default message editor saves through openAutoPopupMessageEditor when
  // its current popup session closes; this dialog has no separate Save button.
  await popup.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(popup).toHaveCount(0)
}

export async function rolloutPageIdentity(page: Page) {
  return page.evaluate(
    (sessionKey) => ({
      sessionId: sessionStorage.getItem(sessionKey),
      timeOrigin: performance.timeOrigin,
      url: location.href,
      role: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot(),
    }),
    WRITER_SESSION_KEY,
  )
}

export async function expectEmptyRolloutQueues(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot()))
    .toMatchObject({
      outbox: [],
      receiptAcknowledgements: [],
      activeGenerationJobs: [],
      activeChatGenerations: [],
    })
}

/** Observe native HTTP response lifetimes; never substitute event data or service state. */
export function observeRolloutEventConnections(app: FastifyInstance) {
  const records: Array<{ id: number; writerSession: string | null; closed: boolean }> = []
  app.server.on('request', (request, response) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/api/v1/events') return
    const value = request.headers['risu-writer-session']
    const record = { id: records.length + 1, writerSession: typeof value === 'string' ? value : null, closed: false }
    records.push(record)
    response.once('close', () => {
      record.closed = true
    })
    response.once('finish', () => {
      record.closed = true
    })
  })
  return {
    records,
    active: () => ({
      writer: records.filter((record) => !record.closed && record.writerSession !== null).length,
      reader: records.filter((record) => !record.closed && record.writerSession === null).length,
    }),
  }
}

export async function stopRolloutServer(harness: FastBootstrapHarness): Promise<void> {
  harness.app.server.closeAllConnections()
  await harness.app.close()
}

export async function restartRolloutServer(harness: FastBootstrapHarness) {
  const port = Number(new URL(harness.baseUrl).port)
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port,
      dataDir: harness.dataDir,
      bodyLimit: 20 * 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      staticRoot: path.resolve('dist'),
      requestTrace: { mode: 'agent' },
    },
    assetGc: false,
    memoryWorker: false,
  })
  harness.app = app
  const connections = observeRolloutEventConnections(app)
  await app.listen({ host: '127.0.0.1', port })
  return connections
}

/** Read the existing encrypted store without opening its key store or staging intent. */
export async function readNativeRolloutOutbox(page: Page) {
  return page.evaluate(async () => {
    const name = 'risu-pending-mutations-v1'
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return []
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        reject(new Error('Outbox did not exist'))
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    try {
      const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const transaction = database.transaction('mutations', 'readonly')
        const request = transaction.objectStore('mutations').getAll()
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>)
        request.onerror = () => reject(request.error)
      })
      return await Promise.all(
        rows.map(async (row) => ({
          mutationId: row.mutationId,
          ownerWriterSessionId: row.ownerWriterSessionId,
          writerEpoch: row.writerEpoch,
          databaseLineage: row.databaseLineage,
          dispatchStarted: row.dispatchStarted,
          ivBytes: row.iv instanceof ArrayBuffer ? row.iv.byteLength : 0,
          ciphertextBytes: row.ciphertext instanceof ArrayBuffer ? row.ciphertext.byteLength : 0,
          ciphertextSha256:
            row.ciphertext instanceof ArrayBuffer
              ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', row.ciphertext)), (byte) =>
                  byte.toString(16).padStart(2, '0'),
                ).join('')
              : null,
          keys: Object.keys(row).sort(),
          ciphertextText: row.ciphertext instanceof ArrayBuffer ? new TextDecoder().decode(row.ciphertext) : '',
        })),
      )
    } finally {
      database.close()
    }
  })
}

export async function readRolloutComposerDrafts(page: Page) {
  return page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith('risu:recovery-draft:composer:v1:'))
      .map(
        (key) =>
          JSON.parse(sessionStorage.getItem(key)!) as {
            writerSessionId: string
            databaseLineage: string
            sequence: number
            payload: { messageInput: string }
          },
      ),
  )
}

export async function attachRolloutEvidence(testInfo: TestInfo, evidence: Record<string, unknown>): Promise<void> {
  const output = testInfo.outputPath('connected-reader-rollout.json')
  writeFileSync(output, JSON.stringify(evidence, null, 2))
  await testInfo.attach('connected-reader-rollout.json', { path: output, contentType: 'application/json' })
}
