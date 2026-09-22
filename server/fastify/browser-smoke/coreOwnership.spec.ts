/** @module-tag core */

import { expect, test, type Page } from '@playwright/test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

const CHARACTER_ID = 'fast-bootstrap-small-character'
const CHAT_ID = 'fast-bootstrap-small-chat'
const STALE_CHARACTER = 'AUTH-STALE-CHARACTER'
const STALE_MESSAGE = 'AUTH-STALE-CHAT-CONTENT'

function fixture(): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  const character = (database.characters as Array<Record<string, unknown>>)[0]!
  character.name = STALE_CHARACTER
  character.chats = [
    {
      id: CHAT_ID,
      name: 'Auth ownership chat',
      note: '',
      localLore: [],
      message: [{ chatId: 'auth-stale-message', role: 'char', data: STALE_MESSAGE }],
    },
  ]
  return database
}

async function boot(page: Page, harness: FastBootstrapHarness): Promise<void> {
  await page.goto(`${harness.baseUrl}/character/${CHARACTER_ID}/${CHAT_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000))
}

function durableSettings(harness: FastBootstrapHarness): { revision: number; streamGeminiThoughts: unknown } {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    const revision = (db.prepare('SELECT revision FROM schema_version WHERE id = 1').get() as { revision: number })
      .revision
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    return {
      revision,
      streamGeminiThoughts: (JSON.parse(row.data_json) as Record<string, unknown>).streamGeminiThoughts,
    }
  } finally {
    db.close()
  }
}

test(
  'a 401 ownership probe clears the signed-in projection and refuses a later write',
  { tag: '@core' },
  async ({ browser }) => {
    test.setTimeout(60_000)
    const harness = await startFastBootstrapHarness(fixture(), {
      temporaryDirectoryPrefix: 'risu-core-ownership-auth-',
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    const eventResponses: Array<{ request: IncomingMessage; response: ServerResponse }> = []
    const onServerRequest = (request: IncomingMessage, response: ServerResponse) => {
      if (new URL(request.url ?? '/', harness.baseUrl).pathname !== '/api/v1/events') return
      if (!request.headers['risu-writer-session']) return
      eventResponses.push({ request, response })
    }
    harness.app.server.on('request', onServerRequest)

    try {
      await boot(page, harness)
      await expect(page.getByText(STALE_CHARACTER, { exact: true }).first()).toBeVisible()
      await expect(page.getByText(STALE_MESSAGE, { exact: true })).toBeVisible()
      await expect(page.getByTestId('default-chat-composer')).toBeEditable()
      await expect.poll(() => eventResponses.filter(({ response }) => !response.destroyed).length).toBeGreaterThan(0)
      const before = durableSettings(harness)

      await page.route('**/api/v1/ownership', async (route) => {
        await route.continue({
          headers: { ...route.request().headers(), 'risu-auth': 'revoked-browser-ownership-credential' },
        })
      })
      const ownershipProbe = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/v1/ownership',
        { timeout: 15_000 },
      )
      const liveEvent = [...eventResponses].reverse().find(({ response }) => !response.destroyed)
      liveEvent?.response.destroy()
      const rejected = await ownershipProbe
      expect(rejected.status(), 'the real ownership route must reject the dropped credential').toBe(401)
      expect(await rejected.json()).toMatchObject({ error: 'Auth required' })

      await expect(page.locator('[data-reader-auth-required]')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText(STALE_CHARACTER, { exact: true })).toHaveCount(0)
      await expect(page.getByText(STALE_MESSAGE, { exact: true })).toHaveCount(0)
      await expect(page.getByTestId('default-chat-composer')).toHaveCount(0)
      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()))
        .toMatchObject({ lifecycle: 'auth-required', authenticated: false, projectionReady: false })
      expect(
        await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters),
      ).toEqual([])

      const refused = await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true }),
      )
      expect(refused).toMatchObject({ status: 'unavailable' })
      expect(durableSettings(harness)).toEqual(before)
    } finally {
      harness.app.server.off('request', onServerRequest)
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
      await context.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  },
)
