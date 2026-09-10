import { expect, test, type Page } from '@playwright/test'
import type { FastBootstrapHarness } from './fastBootstrapHarness.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

let harness: FastBootstrapHarness

test.beforeAll(async () => {
  const database = uiUxImprovementFixture()
  harness = await startFastBootstrapHarness(database, {
    temporaryDirectoryPrefix: 'risu-ui-ux-baseline-browser-',
  })
})

test.afterAll(async () => {
  await closeFastBootstrapHarness(harness)
})

test('reviewed UI/UX surfaces open from disposable data at both compact viewports', async ({ page }) => {
  const commandRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/v1/commands/')) commandRequests.push(`${request.method()} ${url.pathname}`)
  })

  await page.setViewportSize({ width: 550, height: 775 })
  await openChat(page)
  const navigation = page.locator('[data-risu-responsive-shell="shared-sidebar-dialog"]')
  if (!(await navigation.isVisible())) await page.locator('[data-risu-sidebar-toggle="expand"]').click()
  await expect(navigation).toBeVisible()
  await expect(navigation).toHaveAttribute('aria-modal', 'true')
  await page.keyboard.press('Escape')
  await expect(navigation).toBeHidden()

  await page.goto(`${harness.baseUrl}/settings/agent-presets`)
  await waitForLoaded(page)
  const agentSettings = page.locator('[data-risu-agent-preset-settings]')
  await expect(agentSettings).toBeVisible()
  await expect(agentSettings.locator('[data-risu-agent-preset-row]')).toHaveCount(4)
  await agentSettings.locator('[data-risu-agent-row] button').nth(2).click()
  const agentDrawer = page.locator('[data-risu-agent-editor]')
  await expect(agentDrawer).toBeVisible()
  await expect(agentDrawer.locator('[data-risu-agent-editor-footer]')).toBeVisible()
  await agentDrawer.locator('button').first().click()
  await agentSettings.getByRole('button', { name: 'Edit', exact: true }).first().click()
  const presetDrawer = page.locator('[data-risu-agent-preset-editor]')
  await expect(presetDrawer).toBeVisible()
  await expect(presetDrawer.locator('[data-risu-agent-preset-editor-footer]')).toBeVisible()
  await presetDrawer.locator('button').first().click()

  await page.setViewportSize({ width: 655, height: 691 })
  await page.goto(`${harness.baseUrl}/settings/input-hooks`)
  await waitForLoaded(page)
  await expect(page.locator('[data-risu-input-hook-settings]')).toBeVisible()
  await expect(page.getByRole('article', { name: 'Before-send rewrite' })).toBeVisible()

  await openChat(page)
  await page.getByTestId('default-chat-menu-button').click()
  await page.getByTestId('default-chat-open-bardwiki').click()
  const bardWiki = page.getByRole('dialog', { name: 'BardWiki workspace', exact: true })
  await expect(bardWiki).toBeVisible()
  await expect(bardWiki.getByText('This chat has no BardWiki documents yet.', { exact: true })).toBeVisible()

  expect(commandRequests).toEqual([])
})

function uiUxImprovementFixture(): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  database.agents = [
    {
      id: 'ui-ux-agent',
      name: 'Research Agent',
      version: 1,
      instruction: 'Summarize the relevant context.',
      modelDefaults: { mode: 'inheritMain' },
      runtimeDefaults: {},
      inputScopes: ['currentUserMessage'],
      outputFormat: 'text',
    },
  ]
  database.agentPresets = [
    {
      id: 'ui-ux-ready',
      name: 'Ready preset',
      enabled: true,
      version: 1,
      steps: [],
      agentUses: [presetUse('ui-ux-ready-use', 'ui-ux-agent', 'ready')],
    },
    {
      id: 'ui-ux-empty',
      name: 'Empty preset',
      enabled: true,
      version: 1,
      steps: [],
      agentUses: [],
    },
    {
      id: 'ui-ux-invalid',
      name: 'Invalid preset',
      enabled: true,
      version: 1,
      steps: [],
      agentUses: [presetUse('ui-ux-missing-use', 'missing-agent', 'missing')],
    },
    {
      id: 'ui-ux-stale-output',
      name: 'Stale output preset',
      enabled: true,
      version: 1,
      finalOutputTemplate: '{{agent::removed_output}}',
      steps: [],
      agentUses: [presetUse('ui-ux-stale-use', 'ui-ux-agent', 'stale')],
    },
  ]
  database.agentPresetDefaultId = 'ui-ux-ready'
  database.inputHooks = [
    {
      id: 'ui-ux-input-hook',
      name: 'Before-send rewrite',
      type: 'draft',
      prompt: 'Rewrite this message clearly.',
      model: { mode: 'inheritOtherAx' },
      translation: false,
    },
  ]
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
  return database
}

function presetUse(id: string, agentId: string, outputKey: string): Record<string, unknown> {
  return {
    id,
    agentId,
    enabled: true,
    phase: 'beforeMain',
    dependencies: [],
    outputKey,
    destination: 'promptOutput',
    failurePolicy: { mode: 'required' },
  }
}

async function openChat(page: Page): Promise<void> {
  await page.goto(`${harness.baseUrl}/character/fast-bootstrap-small-character/fast-bootstrap-small-chat`)
  await waitForLoaded(page)
}

async function waitForLoaded(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded(20_000))
}
