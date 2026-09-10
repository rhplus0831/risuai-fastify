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
  const closeNavigation = navigation.locator('[data-risu-responsive-navigation-close]')
  const navigationScrim = navigation.locator('[data-risu-responsive-navigation-scrim]')
  await expect(closeNavigation).toBeVisible()
  await expect(navigationScrim).toBeVisible()
  expect((await closeNavigation.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  expect((await navigationScrim.boundingBox())?.width).toBeGreaterThanOrEqual(56)
  expect(await navigation.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)

  const backToChatList = navigation.locator('[data-risu-chat-action="back-to-chat-list"]')
  if (await backToChatList.isVisible()) await backToChatList.click()
  const chatMenuTrigger = navigation.locator('[data-risu-chat-action="more-actions"]').first()
  await expect(chatMenuTrigger).toBeVisible()
  await expect(chatMenuTrigger).toHaveAttribute('aria-label', /.+: .+/)
  await chatMenuTrigger.click()
  const chatMenu = page.getByRole('menu', { name: 'More actions' })
  await expect(chatMenu).toBeVisible()
  const dangerSection = chatMenu.locator('[data-risu-danger-menu-section]')
  const deleteAction = dangerSection.locator('[data-risu-chat-menu-action="delete"]')
  await expect(deleteAction).toBeVisible()
  await chatMenu.locator('[data-risu-chat-menu-action="copy"]').press('End')
  await expect(deleteAction).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(chatMenu).toBeHidden()
  await expect(chatMenuTrigger).toBeFocused()
  await expect(navigation).toBeVisible()

  await closeNavigation.click()
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
  await expect(agentDrawer.locator('[data-risu-agent-section]').first()).toHaveAttribute(
    'data-risu-agent-section',
    'basics',
  )
  await expect(agentDrawer.locator('[data-risu-agent-section="advanced"]')).not.toHaveAttribute('open', '')
  expect(await agentDrawer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  const instruction = agentDrawer.locator('textarea').nth(1)
  await instruction.evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(0, 0))
  await agentDrawer.locator('[data-risu-agent-insert-token][data-token="{{currentUserMessage}}"]').click()
  await expect(instruction).toHaveValue(/^\{\{currentUserMessage\}\}/)
  page.once('dialog', (dialog) => dialog.accept())
  await agentDrawer.locator('button').first().click()
  await agentSettings.getByRole('button', { name: 'Edit', exact: true }).first().click()
  const presetDrawer = page.locator('[data-risu-agent-preset-editor]')
  await expect(presetDrawer).toBeVisible()
  await expect(presetDrawer.locator('[data-risu-agent-preset-editor-footer]')).toBeVisible()
  await expect(presetDrawer.locator('[data-risu-agent-add-phase] select')).toHaveValue('beforeMain')
  await presetDrawer.locator('[data-risu-agent-preset-insert-output="mainOutput"]').click()
  await expect(presetDrawer.locator('[data-risu-agent-preset-final-output] textarea')).toHaveValue(
    '{{slot::mainOutput}}',
  )
  expect(await presetDrawer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  page.once('dialog', (dialog) => dialog.accept())
  await presetDrawer.locator('button').first().click()

  await page.setViewportSize({ width: 655, height: 691 })
  await page.goto(`${harness.baseUrl}/settings/input-hooks`)
  await waitForLoaded(page)
  await expect(page.locator('[data-risu-input-hook-settings]')).toBeVisible()
  const hook = page.getByRole('article', { name: 'Before-send rewrite' })
  await expect(hook).toBeVisible()
  await expect(hook.locator('[data-risu-hook-outcome]')).toContainText('Before send')
  const promptToggle = hook.getByRole('button', { name: 'Hook prompt: Before-send rewrite' })
  await expect(promptToggle).toHaveAttribute('title', 'Rewrite this message clearly.')
  await promptToggle.focus()
  await expect(hook.locator('[data-risu-input-hook-full-prompt-preview]')).toBeVisible()

  await openChat(page)
  await page.getByTestId('default-chat-menu-button').click()
  await page.getByTestId('default-chat-open-bardwiki').click()
  const bardWiki = page.getByRole('dialog', { name: 'BardWiki workspace', exact: true })
  const bardWikiBackdrop = page.getByTestId('bardwiki-workspace-dialog-root')
  await expect(bardWiki).toBeVisible()
  await expect(bardWikiBackdrop).toHaveCSS('background-color', /(?:oklab\(0 0 0 \/ 0\.7\)|rgba\(0, 0, 0, 0\.7\))/)
  expect(await bardWiki.evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe('none')
  const closeBardWiki = bardWiki.getByRole('button', { name: 'Close', exact: true })
  expect((await closeBardWiki.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  expect((await closeBardWiki.boundingBox())?.width).toBeGreaterThanOrEqual(44)
  expect(await modalBackgroundIsInert(bardWikiBackdrop)).toBe(true)

  const chatOverrides = bardWiki.locator('details').filter({ hasText: 'Chat overrides' }).first()
  await chatOverrides.locator('summary').click()
  await expect(chatOverrides.locator('[data-risu-bardwiki-override="enabled"] option').first()).toHaveText(
    'Inherit — currently Enabled',
  )
  await expect(chatOverrides.locator('[data-risu-bardwiki-override="memory-mode"] option').first()).toHaveText(
    'Inherit — currently BardWiki only',
  )
  await expect(chatOverrides.locator('[data-risu-bardwiki-override="confirmation"] option').first()).toHaveText(
    'Inherit — currently Manual',
  )
  await chatOverrides.locator('[data-risu-bardwiki-override="enabled"] select').selectOption('disabled')

  const guidedEmpty = bardWiki.locator('[data-risu-bardwiki-guided-empty]')
  await expect(guidedEmpty.getByRole('heading', { name: 'Create this chat’s first memory document' })).toBeVisible()
  await expect(guidedEmpty.getByRole('button', { name: 'Create first document' })).toBeVisible()
  await expect(guidedEmpty.getByRole('button', { name: 'Import vault' })).toBeVisible()
  const buildFromChat = guidedEmpty.getByRole('button', { name: 'Build from chat' })
  await expect(buildFromChat).toBeVisible()
  await buildFromChat.click()
  const lifecycle = bardWiki.getByTestId('bardwiki-lifecycle')
  await expect(lifecycle).toHaveAttribute('open', '')
  await expect(lifecycle.getByRole('heading', { name: 'Rebuild from chat' })).toBeVisible()
  await expect(lifecycle.getByRole('option', { name: 'Start fresh from chat' })).toBeAttached()
  await expect(lifecycle.getByRole('option', { name: 'Fill missing topics' })).toBeAttached()
  await expect(lifecycle.getByRole('button', { name: 'Preview rebuild' })).toBeFocused()
  await guidedEmpty.getByRole('button', { name: 'Import vault' }).click()
  await expect(lifecycle.locator('input[type="file"]')).toBeFocused()

  await guidedEmpty.getByRole('button', { name: 'Create first document' }).click()
  const documentPane = bardWiki.locator('[data-risu-bardwiki-pane="documents"]')
  const detailPane = bardWiki.locator('[data-risu-bardwiki-pane="detail"]')
  const backToDocuments = detailPane.getByRole('button', { name: 'Back to documents' })
  await expect(documentPane).toBeHidden()
  await expect(detailPane).toBeVisible()
  await expect(backToDocuments).toBeFocused()
  await detailPane.getByLabel('Markdown source').fill('# Unsaved browser draft')
  await backToDocuments.click()
  await expect(documentPane).toBeVisible()
  await expect(detailPane).toBeHidden()
  const resumeDraft = documentPane.getByRole('button', { name: 'Return to new document draft' })
  await expect(resumeDraft).toBeFocused()
  await resumeDraft.click()
  await expect(detailPane.getByLabel('Markdown source')).toHaveValue('# Unsaved browser draft')
  await expect(chatOverrides.locator('[data-risu-bardwiki-override="enabled"] select')).toHaveValue('disabled')
  await expect(bardWiki.locator('[data-risu-bardwiki-activity-summary]')).toHaveText(
    '0 running · 0 need attention · 0 failed',
  )
  expect(await bardWiki.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)

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

async function modalBackgroundIsInert(modalRoot: ReturnType<Page['locator']>): Promise<boolean> {
  return modalRoot.evaluate((root) => {
    let activeBranch: Element = root
    while (activeBranch.parentElement) {
      const parent = activeBranch.parentElement
      for (const sibling of parent.children) {
        if (
          sibling !== activeBranch &&
          sibling instanceof HTMLElement &&
          (!sibling.inert || sibling.getAttribute('aria-hidden') !== 'true')
        ) {
          return false
        }
      }
      if (parent === document.body) break
      activeBranch = parent
    }
    return true
  })
}
