import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
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

test('reviewed UI/UX surfaces open from disposable data at both compact viewports', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
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
  await screenshotEvidence(page, testInfo, 'after-sidebar-550x775.png')

  const backToChatList = navigation.locator('[data-risu-chat-action="back-to-chat-list"]')
  if (await backToChatList.isVisible()) await backToChatList.click()
  const chatMenuTrigger = navigation
    .locator('[data-risu-chat-id="fast-bootstrap-small-chat"]')
    .locator('[data-risu-chat-action="more-actions"]')
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
  await screenshotEvidence(page, testInfo, 'after-agent-presets.png')
  await agentSettings.getByRole('button', { name: 'Edit Agent Research Agent' }).click()
  const agentDrawer = page.locator('[data-risu-agent-editor]')
  await expect(agentDrawer).toBeVisible()
  await expect(agentDrawer.locator('[data-risu-agent-editor-footer]')).toBeVisible()
  await expect(agentDrawer.locator('[data-risu-agent-section]').first()).toHaveAttribute(
    'data-risu-agent-section',
    'basics',
  )
  await expect(agentDrawer.locator('[data-risu-agent-section="advanced"]')).not.toHaveAttribute('open', '')
  expect(await agentDrawer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await screenshotEvidence(page, testInfo, 'after-agent-editor.png')
  const instruction = agentDrawer.locator('textarea').nth(1)
  await instruction.evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(0, 0))
  await agentDrawer.locator('[data-risu-agent-insert-token][data-token="{{currentUserMessage}}"]').click()
  await expect(instruction).toHaveValue(/^\{\{currentUserMessage\}\}/)
  page.once('dialog', (dialog) => dialog.accept())
  await agentDrawer.locator('button').first().click()
  await agentSettings.getByRole('button', { name: 'Edit Preset Ready preset' }).click()
  const presetDrawer = page.locator('[data-risu-agent-preset-editor]')
  await expect(presetDrawer).toBeVisible()
  await expect(presetDrawer.locator('[data-risu-agent-preset-editor-footer]')).toBeVisible()
  await expect(presetDrawer.locator('[data-risu-agent-add-phase] select')).toHaveValue('beforeMain')
  await presetDrawer.locator('[data-risu-agent-preset-insert-output="mainOutput"]').click()
  await expect(presetDrawer.locator('[data-risu-agent-preset-final-output] textarea')).toHaveValue(
    '{{slot::mainOutput}}',
  )
  expect(await presetDrawer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await screenshotEvidence(page, testInfo, 'after-preset-editor.png')
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
  await screenshotEvidence(page, testInfo, 'after-input-hooks.png')

  await openChat(page)
  if (!(await navigation.isVisible())) await page.locator('[data-risu-sidebar-toggle="expand"]').click()
  await expect(navigation).toBeVisible()
  await screenshotEvidence(page, testInfo, 'after-sidebar-655x691.png')
  await navigation.locator('[data-risu-responsive-navigation-close]').click()
  await expect(navigation).toBeHidden()
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
  await screenshotEvidence(page, testInfo, 'after-bardwiki-workspace.png')
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

test('keyboard, reduced-motion, reflow, persistence, and modal contracts work together', async ({ page }) => {
  test.setTimeout(120_000)
  const visualHarness = harness
  const mutationDatabase = uiUxImprovementFixture()
  mutationDatabase.agentPresets = (mutationDatabase.agentPresets as Array<{ id: string }>).filter(
    ({ id }) => id === 'ui-ux-ready' || id === 'ui-ux-empty',
  )
  harness = await startFastBootstrapHarness(mutationDatabase, {
    temporaryDirectoryPrefix: 'risu-ui-ux-keyboard-browser-',
  })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 655, height: 691 })
    await openChat(page)
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
    await expect(page.locator('html')).toHaveClass(/risu-reduced-motion/)
    await expect(page.locator('html')).toHaveCSS('--risu-animation-speed', '0.01ms')

    const openNavigation = page.locator('[data-risu-sidebar-toggle="expand"]')
    await openNavigation.focus()
    await openNavigation.press('Enter')
    const navigation = page.locator('[data-risu-responsive-shell="shared-sidebar-dialog"]')
    await expect(navigation).toBeVisible()
    expect(await navigation.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    expect(await modalBackgroundIsInert(navigation)).toBe(true)

    const characterRail = navigation.locator('[data-risu-sidebar-character-controls]')
    expect(await characterRail.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
    const lastCharacter = navigation.getByRole('button', {
      name: 'Navigation rail character 14 with a complete accessible name',
    })
    await lastCharacter.focus()
    await expect(lastCharacter).toBeFocused()
    await expectInside(lastCharacter, characterRail)

    const backToChatList = navigation.locator('[data-risu-chat-action="back-to-chat-list"]')
    if (await backToChatList.isVisible()) {
      await backToChatList.focus()
      await backToChatList.press('Enter')
    }
    const folder = navigation.locator('[data-risu-chat-folder-id="ui-ux-long-folder"]')
    const folderToggle = folder.locator('[data-risu-chat-action="toggle-folder"]')
    await folderToggle.focus()
    await folderToggle.press('Enter')
    await expect(folderToggle).toHaveAttribute('aria-expanded', 'true')
    const folderMenuTrigger = folder.getByRole('button', {
      name: 'More actions: Archived investigations with an intentionally long localized-style label',
    })
    await folderMenuTrigger.click()
    const folderMenu = page.getByRole('menu', { name: 'More actions' })
    await expect(folderMenu).toBeVisible()
    await folderMenu.locator('[data-risu-chat-menu-action="rename-folder"]').press('End')
    await expect(folderMenu.locator('[data-risu-chat-menu-action="delete-folder"]')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(folderMenuTrigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(navigation).toBeHidden()
    await expect(openNavigation).toBeFocused()

    // A 640 CSS-pixel viewport represents the reflow width of a 1280px desktop at 200% browser zoom.
    await page.setViewportSize({ width: 640, height: 450 })
    await page.goto(`${harness.baseUrl}/settings/agent-presets`)
    await waitForLoaded(page)
    const agentSettings = page.locator('[data-risu-agent-preset-settings]')
    expect(await agentSettings.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    const createAgent = agentSettings
      .locator('[data-risu-agent-settings]')
      .getByRole('button', { name: 'Create Agent' })
    await createAgent.focus()
    await createAgent.press('Enter')
    const agentDrawer = page.locator('[data-risu-agent-editor]')
    const agentBackdrop = agentDrawer.locator('..')
    await expect(agentDrawer).toBeVisible()
    await expect(agentDrawer.getByRole('button', { name: 'Close' })).toBeFocused()
    expect(await modalBackgroundIsInert(agentBackdrop)).toBe(true)
    expect(await agentDrawer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await expectFooterInsideViewport(agentDrawer.locator('[data-risu-agent-editor-footer]'), 450)
    await agentDrawer.getByLabel('Name').fill('Browser-created summary Agent')
    await agentDrawer.getByLabel('Instruction').fill('Summarize the current request clearly.')
    const saveAgent = agentDrawer.getByRole('button', { name: 'Save', exact: true })
    await saveAgent.focus()
    await saveAgent.press('Enter')
    await expect(agentDrawer).toBeHidden()
    await expect(
      agentSettings.locator('[data-risu-agent-row]').filter({ hasText: 'Browser-created summary Agent' }),
    ).toBeVisible()

    const readyPreset = agentSettings.locator('[data-risu-agent-preset-row][data-preset-id="ui-ux-ready"]')
    const editReadyPreset = readyPreset.getByRole('button', { name: 'Edit Preset Ready preset' })
    await editReadyPreset.focus()
    await editReadyPreset.press('Enter')
    const presetDrawer = page.locator('[data-risu-agent-preset-editor]')
    const presetBackdrop = presetDrawer.locator('..')
    await expect(presetDrawer).toBeVisible()
    await expect(presetDrawer.getByRole('button', { name: 'Close' })).toBeFocused()
    expect(await modalBackgroundIsInert(presetBackdrop)).toBe(true)
    expect(await presetDrawer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await expectFooterInsideViewport(presetDrawer.locator('[data-risu-agent-preset-editor-footer]'), 450)
    const secondaryUse = presetDrawer.locator('[data-risu-agent-preset-step]').filter({
      hasText: 'Secondary Fact-checking Agent with a long label',
    })
    const moveSecondaryUp = secondaryUse.getByRole('button', {
      name: 'Move Secondary Fact-checking Agent with a long label up',
    })
    await moveSecondaryUp.focus()
    await moveSecondaryUp.press('Enter')
    await expect(presetDrawer.locator('[data-risu-agent-use-position-announcement]')).toContainText(
      'moved in Before Main',
    )

    const createNestedAgent = presetDrawer.getByRole('button', { name: 'Create another Agent' })
    await createNestedAgent.focus()
    await createNestedAgent.press('Enter')
    const nestedAgentDrawer = page.locator('[data-risu-agent-editor]')
    await expect(nestedAgentDrawer).toBeVisible()
    await expect(nestedAgentDrawer.getByRole('button', { name: 'Close' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(nestedAgentDrawer).toBeHidden()
    await expect(createNestedAgent).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(presetDrawer).toBeHidden()
    await expect(editReadyPreset).toBeFocused()

    const deleteReadyPreset = readyPreset.getByRole('button', { name: 'Delete Agent Preset Ready preset' })
    await deleteReadyPreset.focus()
    await deleteReadyPreset.press('Enter')
    const deleteDialog = page.getByRole('alertdialog', { name: 'Check Agent Preset deletion impact' })
    await expect(deleteDialog).toBeVisible()
    await expect(deleteDialog.locator('[data-risu-agent-preset-delete-unavailable]')).toContainText('Loadouts')
    await expect(deleteDialog.getByRole('button', { name: 'Close' })).toBeFocused()
    const retryDeleteImpact = deleteDialog.getByRole('button', { name: 'Retry impact check' })
    await retryDeleteImpact.focus()
    await retryDeleteImpact.press('Enter')
    await expect(deleteDialog.locator('[data-risu-agent-preset-delete-unavailable]')).toBeVisible()
    await expect(retryDeleteImpact).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(deleteDialog).toBeHidden()
    await expect(deleteReadyPreset).toBeFocused()

    await page.goto(`${harness.baseUrl}/settings/input-hooks`)
    await waitForLoaded(page)
    const hook = page.getByRole('article', { name: 'Before-send rewrite' })
    const hookName = hook.getByLabel('Name')
    await hookName.focus()
    await hookName.fill('Before-send rewrite with a deliberately long localized-style name')
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
    const renamedHook = page.getByRole('article', {
      name: 'Before-send rewrite with a deliberately long localized-style name',
    })
    const deleteHook = renamedHook.getByRole('button', {
      name: 'Delete hook: Before-send rewrite with a deliberately long localized-style name',
    })
    await expect(deleteHook).toBeVisible()
    await deleteHook.focus()
    page.once('dialog', (dialog) => dialog.dismiss())
    await deleteHook.press('Enter')
    await expect(renamedHook).toBeVisible()
    await expect(deleteHook).toBeFocused()
    page.once('dialog', (dialog) => dialog.accept())
    await deleteHook.press('Enter')
    await expect(renamedHook).toBeHidden()
    await expect(page.getByRole('button', { name: 'Add hook' })).toBeFocused()

    await openChat(page)
    const chatMenuButton = page.getByTestId('default-chat-menu-button')
    await chatMenuButton.focus()
    await chatMenuButton.press('Enter')
    const openBardWiki = page.getByTestId('default-chat-open-bardwiki')
    await openBardWiki.focus()
    await openBardWiki.press('Enter')
    const bardWiki = page.getByRole('dialog', { name: 'BardWiki workspace', exact: true })
    const bardWikiBackdrop = page.getByTestId('bardwiki-workspace-dialog-root')
    await expect(bardWiki.getByRole('button', { name: 'Close' })).toBeFocused()
    expect(await modalBackgroundIsInert(bardWikiBackdrop)).toBe(true)
    const buildFromChat = bardWiki.getByRole('button', { name: 'Build from chat' })
    await buildFromChat.focus()
    await buildFromChat.press('Enter')
    const previewRebuild = bardWiki.getByRole('button', { name: 'Preview rebuild' })
    await expect(previewRebuild).toBeFocused()
    await previewRebuild.press('Enter')
    await expect(bardWiki.getByTestId('bardwiki-rebuild-preview')).toContainText('0 eligible transcript turns')

    await createBardWikiDocument(page, bardWiki, 'Browser memory one', 1)
    await createBardWikiDocument(page, bardWiki, 'Browser memory two', 2)
    await createBardWikiDocument(page, bardWiki, 'Browser memory three', 3)
    await expect(bardWiki.locator('[data-risu-bardwiki-pane="documents"]')).toBeVisible()
    await expect(bardWiki.locator('[data-risu-bardwiki-document-id]')).toHaveCount(3)
    await page.keyboard.press('Escape')
    await expect(bardWiki).toBeHidden()
    await expect(chatMenuButton).toBeFocused()

    await page.setViewportSize({ width: 1280, height: 900 })
    await chatMenuButton.press('Enter')
    await page.getByTestId('default-chat-open-bardwiki').press('Enter')
    await expect(bardWiki.locator('[data-risu-bardwiki-pane="documents"]')).toBeVisible()
    await expect(bardWiki.locator('[data-risu-bardwiki-pane="detail"]')).toBeVisible()
    await bardWiki.getByRole('button', { name: 'Open Browser memory one' }).focus()
    await bardWiki.getByRole('button', { name: 'Open Browser memory one' }).press('Enter')
    await expect(bardWiki.getByLabel('Markdown source')).toHaveValue('# Browser memory one')
    const activity = bardWiki.getByTestId('bardwiki-activity').locator('summary')
    await activity.focus()
    await activity.press('Enter')
    await expect(bardWiki.getByTestId('bardwiki-activity')).toHaveAttribute('open', '')
    expect(await bardWiki.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  } finally {
    await page.close()
    await closeFastBootstrapHarness(harness)
    harness = visualHarness
  }
})

function uiUxImprovementFixture(): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  const characters = database.characters as Array<{
    chaId: string
    name: string
    chats: Array<Record<string, unknown>>
    chatFolders?: Array<Record<string, unknown>>
  }>
  const currentCharacter = characters[0]!
  currentCharacter.chatFolders = [
    {
      id: 'ui-ux-long-folder',
      name: 'Archived investigations with an intentionally long localized-style label',
      color: 'blue',
      folded: true,
    },
  ]
  currentCharacter.chats.push({
    id: 'ui-ux-long-chat',
    name: 'A very long conversation title that must remain available on keyboard focus and hover',
    folderId: 'ui-ux-long-folder',
    note: '',
    localLore: [],
    message: [],
  })
  for (let index = 1; index <= 14; index += 1) {
    characters.push({
      ...structuredClone(currentCharacter),
      chaId: `ui-ux-rail-character-${index}`,
      name: `Navigation rail character ${index} with a complete accessible name`,
      chats: [],
      chatFolders: [],
    })
  }
  database.characterOrder = characters.map((character) => character.chaId)
  database.reducedMotion = true
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
    {
      id: 'ui-ux-agent-secondary',
      name: 'Secondary Fact-checking Agent with a long label',
      version: 1,
      instruction: 'Check {{currentUserMessage}} for contradictions.',
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
      agentUses: [
        presetUse('ui-ux-ready-use', 'ui-ux-agent', 'ready'),
        presetUse('ui-ux-ready-secondary-use', 'ui-ux-agent-secondary', 'secondary'),
      ],
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

async function screenshotEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

async function expectInside(target: Locator, container: Locator): Promise<void> {
  const [targetBox, containerBox] = await Promise.all([target.boundingBox(), container.boundingBox()])
  expect(targetBox).not.toBeNull()
  expect(containerBox).not.toBeNull()
  expect(targetBox!.y).toBeGreaterThanOrEqual(containerBox!.y)
  expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(containerBox!.y + containerBox!.height)
}

async function expectFooterInsideViewport(footer: Locator, viewportHeight: number): Promise<void> {
  await expect(footer).toBeVisible()
  const box = await footer.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight)
}

async function createBardWikiDocument(page: Page, dialog: Locator, title: string, index: number): Promise<void> {
  const create = dialog.getByRole('button', {
    name: index === 1 ? 'Create first document' : 'New document',
    exact: true,
  })
  await create.focus()
  await create.press('Enter')
  await dialog.getByLabel('Document title', { exact: true }).fill(title)
  await dialog.getByLabel('Logical path', { exact: true }).fill(`Browser/${index}`)
  await dialog.getByLabel('Markdown source', { exact: true }).fill(`# ${title}`)
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      new URL(candidate.url()).pathname === '/api/v1/commands/bardwiki/chats/fast-bootstrap-small-chat/documents',
  )
  const submit = dialog.getByRole('button', { name: 'Create document', exact: true })
  await submit.focus()
  await submit.press('Enter')
  expect((await response).ok()).toBe(true)
  const backToDocuments = dialog.getByRole('button', { name: 'Back to documents' })
  await expect(backToDocuments).toBeFocused()
  await backToDocuments.press('Enter')
  await expect(dialog.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible()
}

async function modalBackgroundIsInert(modalRoot: Locator): Promise<boolean> {
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
