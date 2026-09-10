import { expect, test } from '@playwright/test'
import type { FastBootstrapHarness } from './fastBootstrapHarness.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

let harness: FastBootstrapHarness

test.beforeAll(async () => {
  const database = smallFastBootstrapFixture()
  database.bardWiki = {
    enabledByDefault: true,
    memoryMode: 'bardwiki',
    confirmationPolicy: 'manual',
    modelProfileId: null,
    promptPresetId: null,
    canonicalUpdates: false,
    totalTokenBudget: 2048,
    hybridHypaTokenBudget: 1024,
    hybridBardWikiTokenBudget: 1024,
    maxDocuments: 8,
    maxLinkHops: 1,
    recentMessageCount: 12,
  }
  const character = (database.characters as Array<{ chats: Array<{ message: unknown[] }> }>)[0]
  character.chats[0].message = [
    { chatId: 'bardwiki-user', role: 'user', data: 'We arrive at the old tavern.' },
    { chatId: 'bardwiki-assistant', role: 'char', data: 'Mira lights the lantern.' },
  ]
  harness = await startFastBootstrapHarness(database, { temporaryDirectoryPrefix: 'risu-bardwiki-browser-' })
})

test.afterAll(async () => {
  await closeFastBootstrapHarness(harness)
})

test('BardWiki settings, manual document, confirmation status, and lifecycle tools are visible end to end', async ({
  page,
}) => {
  test.setTimeout(60_000)

  await page.goto(`${harness.baseUrl}/settings/other-bots`)
  await waitForLoaded(page)
  await expect(page).toHaveURL(`${harness.baseUrl}/settings/memory`)
  await page.getByRole('button', { name: 'BardWiki', exact: true }).click()
  await expect(page).toHaveURL(`${harness.baseUrl}/settings/bardwiki`)
  await expect(page.locator('[data-risu-bardwiki-settings]')).toBeVisible()
  await expect(page.locator('[data-risu-bardwiki-settings]')).toContainText('may incur provider cost')
  await expect(
    page.getByRole('checkbox', {
      name: 'Use BardWiki by default',
      exact: true,
    }),
  ).toBeChecked()

  await page.goto(`${harness.baseUrl}/character/fast-bootstrap-small-character/fast-bootstrap-small-chat`)
  await waitForLoaded(page)
  await page.getByTestId('default-chat-menu-button').click()
  await page.getByTestId('default-chat-open-bardwiki').click()

  const dialog = page.getByRole('dialog', { name: 'BardWiki workspace', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'New document', exact: true }).click()
  await dialog.getByLabel('Document title', { exact: true }).fill('Old Tavern')
  await dialog.getByLabel('Logical path', { exact: true }).fill('Places/Old Tavern')
  await dialog.getByLabel('Markdown source', { exact: true }).fill('## Old Tavern\n\nMira waits here.')
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/commands/bardwiki/chats/fast-bootstrap-small-chat/documents',
  )
  await dialog.getByRole('button', { name: 'Create document', exact: true }).click()
  expect((await created).ok()).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Open Old Tavern', exact: true })).toBeVisible()

  await dialog.getByText('Confirmation activity', { exact: true }).click()
  const confirmed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/commands/bardwiki/chats/fast-bootstrap-small-chat/confirmations',
  )
  await dialog.getByRole('button', { name: 'Confirm latest turn', exact: true }).click()
  expect((await confirmed).ok()).toBe(true)
  await expect(dialog).toContainText('Turn bardwiki-user → bardwiki-assistant')
  await expect(dialog).toContainText('Apply confirmed turn')

  await dialog.getByText('Lifecycle and vault tools', { exact: true }).click()
  await expect(dialog).toContainText('fresh mode replaces derived documents')
  await expect(dialog).toContainText('Replace mode overwrites only documents')

  await page.reload()
  await waitForLoaded(page)
  await page.getByTestId('default-chat-menu-button').click()
  await page.getByTestId('default-chat-open-bardwiki').click()
  await expect(page.getByRole('dialog', { name: 'BardWiki workspace', exact: true })).toContainText('Old Tavern')
})

async function waitForLoaded(page: import('@playwright/test').Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded(20_000))
}
