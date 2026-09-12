import { expect, test, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { zipSync } from 'fflate'
import { encodeLegacyRisuSaveEnvelope } from '../src/risuSave/legacyEnvelopeCodec.js'
import {
  startFastBootstrapHarness,
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function state(harness: FastBootstrapHarness) {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    return {
      ownership: db.prepare('SELECT * FROM database_metadata').get(),
      revision: db.prepare('SELECT revision FROM schema_version').get(),
      settings: JSON.parse((db.prepare('SELECT data_json FROM settings').get() as { data_json: string }).data_json),
      imports: db.prepare("SELECT * FROM command_events WHERE type = 'state.imported'").all(),
      restores: db.prepare("SELECT * FROM command_events WHERE type = 'state.restored'").all(),
    }
  } finally {
    db.close()
  }
}

async function ready(page: Page, harness: FastBootstrapHarness, route = '/settings/backup') {
  await page.goto(harness.baseUrl + route)
  await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded(20_000))
}

async function upload(page: Page, bytes: Buffer) {
  await page.getByRole('button', { name: 'Load Backup Locally', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
  await (await picker).setFiles({ name: 'audit.risu.zip', mimeType: 'application/zip', buffer: bytes })
}

function bundle() {
  const database = smallFastBootstrapFixture()
  database.showMemoryLimit = true
  ;(database.characters as Array<Record<string, unknown>>)[0].name = 'Restored audit character'
  return Buffer.from(
    zipSync({
      'database.risu': encodeLegacyRisuSaveEnvelope(database, 'legacy-raw'),
      'manifest.json': Buffer.from(JSON.stringify({ version: 1 })),
    }),
  )
}

async function checkRestoredSetting(page: Page, harness: FastBootstrapHarness) {
  await ready(page, harness, '/settings/display')
  await page.getByRole('button', { name: 'Chat appearance', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true })).toBeChecked()
}

for (const schedule of ['invalid-upload', 'refresh-failure', 'lost-response', 'writer-change'] as const) {
  test(`device backup recovery through the file picker: ${schedule}`, async ({ page }) => {
    test.setTimeout(60_000)
    const database = smallFastBootstrapFixture()
    database.showMemoryLimit = false
    const harness = await startFastBootstrapHarness(database, { temporaryDirectoryPrefix: 'risu-phase06-import-' })
    const release = deferred()
    const committed = deferred()
    let imports = 0
    let failRefresh = false
    try {
      await ready(page, harness)
      const before = state(harness)
      if (schedule === 'invalid-upload') {
        await upload(page, Buffer.from('invalid backup bytes'))
        const error = page.getByRole('alertdialog', { name: 'Error', exact: true })
        await expect(error).toBeVisible()
        expect(state(harness)).toEqual(before)
        await error.getByRole('button', { name: 'OK', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Load Backup Locally', exact: true })).toBeEnabled()
      }
      await page.route('**/api/v1/import/bundle', async (route) => {
        imports += 1
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        committed.resolve()
        if (schedule === 'refresh-failure') failRefresh = true
        if (schedule === 'writer-change') await release.promise
        if (schedule === 'lost-response') await route.abort('connectionreset')
        else await route.fulfill({ response })
      })
      await page.route('**/api/v1/settings', (route) =>
        failRefresh
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'held import refresh' }),
            })
          : route.continue(),
      )
      await upload(page, bundle())
      await committed.promise
      expect(state(harness).settings.showMemoryLimit).toBe(true)
      expect(state(harness).ownership).not.toEqual(before.ownership)
      expect(state(harness).imports).toHaveLength(before.imports.length + 1)
      if (schedule === 'writer-change') {
        const takeover = await harness.app.inject({
          method: 'GET',
          url: '/api/v1/bootstrap',
          headers: {
            'risu-auth': harness.assertion,
            'risu-writer-session': 'phase06-successor',
            'risu-disconnect-existing-writer': 'true',
          },
        })
        expect(takeover.statusCode).toBe(200)
        await expect
          .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().lifecycle))
          .toBe('reading')
        release.resolve()
        await page.waitForTimeout(200)
        await expect(page.getByRole('dialog', { name: /^Local backup loaded/ })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Load Backup Locally', exact: true })).toHaveCount(0)
      } else if (schedule === 'refresh-failure' || schedule === 'lost-response') {
        const error = page.getByRole('alertdialog').filter({
          hasText: schedule === 'refresh-failure' ? /Backup imported, but resource refresh failed/ : /Network error/,
        })
        await expect(error).toBeVisible()
        await expect(page.getByRole('dialog', { name: /^Local backup loaded/ })).toHaveCount(0)
        await error.getByRole('button', { name: 'OK', exact: true }).click()
      } else {
        const success = page.getByRole('dialog', { name: /^Local backup loaded/ })
        await expect(success).toBeVisible()
        await success.getByRole('button', { name: 'OK', exact: true }).click()
      }
      failRefresh = false
      await page.unroute('**/api/v1/import/bundle')
      if (schedule === 'writer-change') {
        await page.goto(harness.baseUrl + '/character/fast-bootstrap-small-character/fast-bootstrap-small-chat')
        await expect
          .poll(() =>
            page.evaluate(
              () => window.__RISU_FASTIFY_BROWSER_SMOKE__?.getClientSessionSnapshot().projectionReady ?? false,
            ),
          )
          .toBe(true)
        await expect(page.getByText('Restored audit character', { exact: true }).first()).toBeVisible()
        await expect(page.getByTestId('default-chat-composer')).toHaveCount(0)
      } else await checkRestoredSetting(page, harness)
      expect(imports).toBe(1)
      expect(state(harness).settings.showMemoryLimit).toBe(true)
      expect(state(harness).imports).toHaveLength(before.imports.length + 1)
    } finally {
      release.resolve()
      await page.close()
      await closeFastBootstrapHarness(harness)
    }
  })
}

test('server backup selection restores authored settings and survives reload', async ({ page }) => {
  test.setTimeout(60_000)
  const database = smallFastBootstrapFixture()
  database.showMemoryLimit = true
  const harness = await startFastBootstrapHarness(database, { temporaryDirectoryPrefix: 'risu-phase06-restore-' })
  try {
    await ready(page, harness)
    await page.getByRole('button', { name: 'Save Server Backup', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
    const saved = page.getByRole('dialog', { name: 'Server backup saved', exact: true })
    await expect(saved).toBeVisible()
    await saved.getByRole('button', { name: 'OK', exact: true }).click()
    await checkRestoredSetting(page, harness)
    const changed = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === '/api/v1/commands/settings/display',
    )
    await page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true }).focus()
    await page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true }).press('Space')
    expect((await changed).ok()).toBe(true)
    expect(state(harness).settings.showMemoryLimit).toBe(false)
    await ready(page, harness)
    const before = state(harness)
    await page.getByRole('button', { name: 'Load Server Backup', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
    await page.getByRole('button', { name: /Manual backup/ }).click()
    const loaded = page.getByRole('dialog', { name: 'Loaded server backup', exact: true })
    await expect(loaded).toBeVisible()
    await loaded.getByRole('button', { name: 'OK', exact: true }).click()
    expect(state(harness).ownership).not.toEqual(before.ownership)
    expect(state(harness).restores).toHaveLength(1)
    await checkRestoredSetting(page, harness)
  } finally {
    await page.close()
    await closeFastBootstrapHarness(harness)
  }
})
