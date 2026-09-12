import { expect, test, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

let harness: FastBootstrapHarness
const characterId = (name: string) => `phase04-${name}`
const chatId = (name: string) => `phase04-chat-${name}`
const route = (name: string) => `/character/${characterId(name)}/${chatId(name)}`
function ownership() {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    return db
      .prepare('SELECT lineage, active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
      .get()
  } finally {
    db.close()
  }
}
function fixture() {
  const base = smallFastBootstrapFixture()
  const character = (base.characters as Array<Record<string, unknown>>)[0]!
  return {
    ...base,
    currentChar: -1,
    showMemoryLimit: false,
    characterOrder: ['phase04-a', 'phase04-b'],
    modelPresets: [{ id: 'phase04-model', name: 'Model' }],
    promptPresetsId: 0,
    promptPresets: ['default', 'a', 'b'].map((name) => ({
      id: `phase04-prompt-${name}`,
      name: `Prompt ${name}`,
      promptTemplate: [{ type: 'plain', text: `Canonical prompt ${name}`, role: 'system' }],
    })),
    characters: ['a', 'b'].map((name) => ({
      ...character,
      chaId: characterId(name),
      name: `Phase Four ${name.toUpperCase()}`,
      firstMessage: '',
      chats: [
        {
          id: chatId(name),
          name: `Chat ${name}`,
          note: '',
          localLore: [],
          message: [
            { role: 'char', chatId: `phase04-message-${name}`, data: `Canonical ${name.toUpperCase()} transcript` },
          ],
          generationSettings: {
            configured: true,
            personaId: null,
            modelPresetId: 'phase04-model',
            promptPresetId: `phase04-prompt-${name}`,
            jailbreakToggle: false,
            sidebarToggles: {},
          },
        },
      ],
    })),
  }
}
test.setTimeout(90_000)
test.beforeEach(async ({ page }) => {
  harness = await startFastBootstrapHarness(fixture())
  // Disable optional character warming so the selected navigation owns these reads.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }),
  )
})
test.afterEach(async ({ page }) => {
  await page.context().close()
  await closeFastBootstrapHarness(harness)
})
async function boot(page: Page, path = '/settings/display') {
  await page.goto(`${harness.baseUrl}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__RISU_FASTIFY_BROWSER_SMOKE__)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000))
}
async function expectB(page: Page) {
  await expect(page.locator('.chat-message-body').filter({ hasText: 'Canonical B transcript' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRouteResourceLoadState()))
    .toMatchObject({ status: 'ready', error: null })
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getCurrentRoute()))
    .toMatchObject({ kind: 'character', chaId: 'phase04-b', chatId: 'phase04-chat-b' })
  expect(
    await page.evaluate(() => {
      const db = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
      const character = db.characters.find((row) => row.chaId === 'phase04-b')!
      const ownerId = character.chats[character.chatPage].generationSettings?.promptPresetId
      return {
        ownerId,
        template: (
          db as typeof db & { promptPresets: Array<{ id: string; promptTemplate?: unknown }> }
        ).promptPresets.find((row) => row.id === ownerId)?.promptTemplate,
      }
    }),
  ).toMatchObject({ ownerId: 'phase04-prompt-b', template: [{ text: 'Canonical prompt b' }] })
}
for (const boundary of ['detail', 'bodies'] as const)
  for (const late of ['success', 'failure'] as const) {
    test(`navigation B stays usable while A ${boundary} waits and after late ${late}`, async ({ page }) => {
      await boot(page)
      const paths =
        boundary === 'detail'
          ? ['/api/v1/characters/phase04-a']
          : ['/api/v1/chats/phase04-chat-a/messages', '/api/v1/prompt-presets/phase04-prompt-a/template']
      const releases: Array<() => void> = []
      const reached = new Set<string>()
      await page.route('**/api/v1/**', async (intercepted) => {
        const path = new URL(intercepted.request().url()).pathname
        if (!paths.includes(path)) return intercepted.continue()
        const response = await intercepted.fetch()
        const gate = new Promise<void>((resolve) => releases.push(resolve))
        reached.add(path)
        await gate
        if (late === 'failure')
          await intercepted
            .fulfill({ status: 503, contentType: 'application/json', body: '{"error":"late A failure"}' })
            .catch(() => undefined)
        else await intercepted.fulfill({ response }).catch(() => undefined)
      })
      try {
        await page.evaluate((path) => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo(path), route('a'))
        await expect.poll(() => reached.size).toBe(paths.length)
        await page.evaluate((path) => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo(path), route('b'))
        await expectB(page)
        for (const release of releases.reverse()) release()
        await page.unrouteAll({ behavior: 'wait' })
        await expectB(page)
        await expect(page.locator('.chat-message-body').filter({ hasText: 'Canonical A transcript' })).toHaveCount(0)
      } finally {
        for (const release of releases) release()
      }
    })
  }
for (const fault of ['corrupt', 'missing'] as const) {
  test(`authenticated reload rejects a ${fault} native cache entry and restores the visible setting`, async ({
    page,
  }) => {
    const exchanges: Array<{ hashes: string[]; value: unknown; authenticated: boolean }> = []
    await page.route('**/api/v1/settings/display', async (intercepted) => {
      const response = await intercepted.fetch()
      const body = await response.json()
      exchanges.push({
        hashes: intercepted.request().postDataJSON()?.cache?.hashes?.settings ?? [],
        value: body.settings,
        authenticated: !!intercepted.request().headers()['risu-auth'],
      })
      await intercepted.fulfill({ response })
    })
    await boot(page)
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getPendingResourceCacheWriteCount()))
      .toBe(0)
    exchanges.length = 0
    await boot(page)
    await expect.poll(() => exchanges.length).toBeGreaterThan(0)
    expect(
      exchanges.some((entry) => entry.hashes.length > 0 && typeof entry.value === 'string' && entry.authenticated),
    ).toBe(true)
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getPendingResourceCacheWriteCount()))
      .toBe(0)
    const poisonedHash = await page.evaluate(async (fault) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('risu-resource-cache-v1')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const tx = db.transaction(['entries', 'manifests'], 'readwrite')
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
        const manifest = await new Promise<{ hashes: string[] }>((resolve, reject) => {
          const request = tx.objectStore('manifests').get('settings:group:display')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const hash = manifest.hashes[0]!
        if (fault === 'missing') tx.objectStore('entries').delete(hash)
        else tx.objectStore('entries').put({ showMemoryLimit: true }, hash)
        await done
        return hash
      } finally {
        db.close()
      }
    }, fault)
    exchanges.length = 0
    await boot(page)
    await page.getByRole('button', { name: 'Chat appearance', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true })).not.toBeChecked()
    expect(
      exchanges.some(
        (entry) => !entry.hashes.includes(poisonedHash) && typeof entry.value === 'object' && entry.authenticated,
      ),
    ).toBe(true)
  })
}

for (const boundary of ['chat', 'prompt'] as const) {
  test(`direct navigation reports failed ${boundary} loading and Retry reveals authoritative content`, async ({
    page,
  }) => {
    const path =
      boundary === 'chat' ? '/api/v1/chats/phase04-chat-a/messages' : '/api/v1/prompt-presets/phase04-prompt-a/template'
    let failing = true
    await page.route(`**${path}*`, (intercepted) =>
      failing
        ? intercepted.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"Injected selected body failure"}',
          })
        : intercepted.continue(),
    )
    await page.goto(`${harness.baseUrl}${route('a')}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__RISU_FASTIFY_BROWSER_SMOKE__)
    await expect(page.getByTestId('route-resource-error')).toBeVisible()
    await expect(page.locator('.chat-message-body').filter({ hasText: 'Canonical A transcript' })).toHaveCount(0)
    expect(
      await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
    ).toMatchObject({ canRenderShell: true })
    failing = false
    await page.getByTestId('route-resource-error').getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.locator('.chat-message-body').filter({ hasText: 'Canonical A transcript' })).toBeVisible()
    await expect(page.getByTestId('route-resource-error')).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRouteResourceLoadState()))
      .toMatchObject({ status: 'ready', error: null })
  })
}

for (const fault of ['failed', 'older'] as const) {
  test(`reader gap recovery retains visible content through a ${fault} full snapshot and converges without acquiring writes`, async ({
    page: writer,
    browser,
  }) => {
    await boot(writer)
    const context = await browser.newContext()
    const reader = await context.newPage()
    const requests: Array<{ path: string; method: string; writer: string | undefined }> = []
    reader.on('request', (request) =>
      requests.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
        writer: request.headers()['risu-writer-session'],
      }),
    )
    try {
      await reader.goto(`${harness.baseUrl}${route('b')}`, { waitUntil: 'domcontentloaded' })
      await reader.waitForFunction(() => !!window.__RISU_FASTIFY_BROWSER_SMOKE__)
      const transcript = reader.locator('.chat-message-body').filter({ hasText: 'Canonical B transcript' })
      await expect(transcript).toBeVisible()
      await expect
        .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()))
        .toMatchObject({ lifecycle: 'reading', connection: 'live' })
      const before = await reader.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision(),
      )
      if (before === null) throw new Error('Reader has no applied resource revision')
      const headers = await writer.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders())
      const originalOwnership = ownership()
      const paths = ['/api/v1/settings', '/api/v1/collections', '/api/v1/characters', '/api/v1/inlay-assets']
      const snapshots = new Map<string, string>()
      for (const path of paths) {
        const response = await harness.app.inject({ method: 'GET', url: path, headers })
        expect(response.statusCode).toBe(200)
        expect(response.json().revision).toBe(before)
        snapshots.set(path, response.body)
      }
      await context.setOffline(true)
      await expect(reader.locator('[data-reader-lifecycle-status]')).toContainText('Connection interrupted')
      const changed = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/commands/chats/phase04-chat-b/messages',
        headers,
        payload: {
          baseRevision: before,
          message: { role: 'char', chatId: 'phase04-after-gap', data: 'Authoritative message after the gap' },
        },
      })
      expect(changed.statusCode).toBe(200)
      const revision = changed.json().revision as number
      expect(revision).toBe(before + 1)
      const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
      try {
        expect(db.prepare('DELETE FROM command_events WHERE revision = ?').run(revision).changes).toBe(1)
      } finally {
        db.close()
      }
      let faulting = true
      let gapSeen = false
      let fullResponses = 0
      let prematureChatReads = 0
      reader.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/v1/events' && response.status() === 409) gapSeen = true
      })
      await reader.route('**/api/v1/**', async (intercepted) => {
        const path = new URL(intercepted.request().url()).pathname
        if (!faulting) return intercepted.continue()
        if (path === '/api/v1/chats/phase04-chat-b/messages') {
          prematureChatReads++
          return intercepted.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"new body must not be needed for a rejected snapshot"}',
          })
        }
        if (!paths.includes(path)) return intercepted.continue()
        fullResponses++
        if (fault === 'older')
          return intercepted.fulfill({ status: 200, contentType: 'application/json', body: snapshots.get(path)! })
        if (path === '/api/v1/collections')
          return intercepted.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"injected full snapshot failure"}',
          })
        return intercepted.continue()
      })
      await context.setOffline(false)
      await expect.poll(() => gapSeen).toBe(true)
      await expect.poll(() => fullResponses).toBeGreaterThanOrEqual(4)
      await reader.waitForTimeout(300)
      await expect(transcript).toBeVisible()
      expect(prematureChatReads).toBe(0)
      expect(
        await reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()),
      ).toBe(before)
      faulting = false
      await reader.evaluate(() => window.dispatchEvent(new Event('online')))
      await expect(
        reader.locator('.chat-message-body').filter({ hasText: 'Authoritative message after the gap' }),
      ).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()))
        .toBe(revision)
      await expect
        .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()))
        .toMatchObject({ lifecycle: 'reading', connection: 'live' })
      expect(
        requests.filter(
          (request) => request.path.startsWith('/api/v1/commands/') || request.path === '/api/v1/ownership/acquire',
        ),
      ).toEqual([])
      expect(
        requests
          .filter((request) => request.path === '/api/v1/bootstrap' || request.path === '/api/v1/events')
          .every((request) => !request.writer),
      ).toBe(true)
      const count = requests.length
      expect(ownership()).toEqual(originalOwnership)
      await reader.evaluate(() => {
        for (let i = 0; i < 4; i++) window.dispatchEvent(new Event('focus'))
      })
      await reader.waitForTimeout(250)
      expect(
        requests
          .slice(count)
          .filter(
            (request) =>
              request.path === '/api/v1/bootstrap' ||
              request.path === '/api/v1/ownership' ||
              paths.includes(request.path),
          ),
      ).toEqual([])
    } finally {
      await context.close()
    }
  })
}
