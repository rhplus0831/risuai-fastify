import { devices, expect, test, type Page, type TestInfo } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'
import {
  expectEmptyRolloutQueues,
  isForbiddenReaderRequest as isForbiddenRolloutReaderRequest,
  readNativeRolloutOutbox,
  readRolloutComposerDrafts,
  recordRolloutApiRequest,
  rolloutDurableSnapshot,
  waitForRolloutHook,
  type RolloutApiRequest,
} from './connectedReaderRolloutHarness.js'

const CHARACTER_A = 'read-only-ux-atlas'
const CHARACTER_B = 'read-only-ux-harbor'
const CHARACTER_FOLDER = 'read-only-ux-character-folder'
const CHAT_A = 'read-only-ux-history'
const CHAT_B = 'read-only-ux-reading'
const CHAT_NOTES = 'read-only-ux-notes'
const CHAT_FOLDER = 'read-only-ux-chat-folder'
const ROUTE_A = `/character/${CHARACTER_A}/${CHAT_A}`
const ROUTE_B = `/character/${CHARACTER_B}/${CHAT_B}`
const COPY_ID = 'read-only-ux-copy'
const SCRIPT_ID = 'read-only-ux-script'
const COPY_TEXT = 'A committed conversation can be copied on either screen size.'
const LOCAL_EFFECT_TEXT = 'A reader must never execute this local-only alert.'
const WRITE_ACCESS_REASON = 'You need write access to edit this page.'
const SAFE_URL = 'https://reader-reference.invalid/passive-link'
const HISTORY_COUNT = 65
const PORTRAIT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWd0AAAAASUVORK5CYII='
const PALETTE = {
  bgcolor: '#f5f7fc',
  darkbg: '#e2e7f0',
  borderc: '#334155',
  selected: '#cbd5e1',
  draculared: '#dc2626',
  textcolor: '#0f172a',
  textcolor2: '#475569',
  darkBorderc: '#94a3b8',
  darkbutton: '#cbd5e1',
  type: 'light',
}

function fixture(): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  const base = (database.characters as Array<Record<string, unknown>>)[0]!
  return {
    ...database,
    useChatCopy: true,
    chatLoadInitialPages: 15,
    chatLoadAdditionalPages: 15,
    colorSchemeName: 'custom',
    colorScheme: PALETTE,
    customColorScheme: PALETTE,
    font: 'custom',
    customFont: 'Georgia, serif',
    theme: 'mobilechat',
    zoomsize: 120,
    customCSS: ':root { --read-only-ux-theme: confirmed; }',
    roundIcons: true,
    menuSideBar: false,
    hamburgerButtonBottom: false,
    showFolderName: true,
    characterOrder: [CHARACTER_A, { id: CHARACTER_FOLDER, name: 'Voyages', color: 'blue', data: [CHARACTER_B] }],
    characters: [
      {
        ...base,
        chaId: CHARACTER_A,
        name: 'Atlas',
        alternateGreetings: [],
        chats: [
          {
            id: CHAT_A,
            name: 'Atlas History',
            fmIndex: -1,
            note: '',
            localLore: [],
            message: Array.from({ length: HISTORY_COUNT }, (_, index) => ({
              chatId: `read-only-ux-history-${index}`,
              role: index % 2 ? 'char' : 'user',
              data: `Archive message ${index}. **Committed history** remains readable while the other client writes.`,
            })),
          },
        ],
      },
      {
        ...base,
        chaId: CHARACTER_B,
        name: 'Harbor',
        image: PORTRAIT,
        viewScreen: 'emotion',
        alternateGreetings: [],
        backgroundHTML: '<div style="background-color: #dbeafe; width: 100%; height: 100%">Harbor background</div>',
        lowLevelAccess: true,
        triggerscript: [
          {
            comment: 'reader-local-alert',
            type: 'manual',
            conditions: [],
            effect: [{ type: 'showAlert', alertType: 'normal', inputVar: '', value: LOCAL_EFFECT_TEXT }],
          },
          {
            comment: 'reader-lua-button',
            type: 'manual',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `function onButtonClick(id, data)\n  alertNormal(id, ${JSON.stringify(LOCAL_EFFECT_TEXT)})\nend`,
              },
            ],
          },
        ],
        chatFolders: [{ id: CHAT_FOLDER, name: 'Reading shelf', color: 'blue', folded: true }],
        chats: [
          {
            id: CHAT_B,
            name: 'Harbor Reading',
            pinned: true,
            folderId: CHAT_FOLDER,
            fmIndex: -1,
            note: '',
            localLore: [],
            message: [
              { chatId: COPY_ID, role: 'char', data: COPY_TEXT },
              {
                chatId: SCRIPT_ID,
                role: 'char',
                data: [
                  '<button risu-trigger="reader-local-alert">Local alert</button>',
                  '<button risu-btn="reader-lua-button">Lua action</button>',
                  '<span role="button" risu-trigger="reader-local-alert" tabindex="0">Delegated action</span>',
                  '<details><summary>Reader disclosure</summary>Passive detail content</details>',
                  `<a href="${SAFE_URL}">Reader reference</a>`,
                ].join('\n\n'),
              },
            ],
          },
          {
            id: CHAT_NOTES,
            name: 'Harbor Notes',
            fmIndex: -1,
            note: '',
            localLore: [],
            message: [{ chatId: 'read-only-ux-note', role: 'char', data: 'Committed notes remain available.' }],
          },
        ],
      },
    ],
  }
}

function body(page: Page, id: string) {
  return page.locator(`.risu-chat[data-risu-message-id="${id}"] .chat-message-body`)
}

async function screenshotEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

async function readingContrast(page: Page) {
  return page.evaluate(
    ({ copyId, scriptId }) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      type Color = [number, number, number, number]
      const color = (value: string): Color => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = value
        context.fillRect(0, 0, 1, 1)
        const pixel = context.getImageData(0, 0, 1, 1).data
        return [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]! / 255]
      }
      const composite = (foreground: Color, background: Color): Color =>
        [
          ...foreground
            .slice(0, 3)
            .map((channel, index) => channel * foreground[3] + background[index]! * (1 - foreground[3])),
          1,
        ] as Color
      const luminance = (value: Color) =>
        value.slice(0, 3).reduce((result, channel, index) => {
          const normalized = channel / 255
          const linear = normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
          return result + linear * [0.2126, 0.7152, 0.0722][index]!
        }, 0)
      const panel = document.querySelector('[data-reader-transcript]')!
      // The fixture's passive character background is painted behind the panel.
      // Include every real ancestor background, so tinted themes and mobile
      // message bubbles are checked against the surfaces they actually paint.
      const backdrop = color(
        getComputedStyle(document.querySelector('[data-reader-background] > div')!).backgroundColor,
      )
      const selectors = {
        heading: '#reader-chat-heading',
        character: '#reader-chat-heading + p',
        refresh: '[data-reader-refresh]',
        message: `.risu-chat[data-risu-message-id="${copyId}"] .chat-message-body p`,
        summary: `.risu-chat[data-risu-message-id="${scriptId}"] summary`,
        link: `.risu-chat[data-risu-message-id="${scriptId}"] a`,
        composerReason: '#reader-composer-reason',
        takeover: '[data-reader-use-this-device]',
      }
      return Object.fromEntries(
        Object.entries(selectors).map(([name, selector]) => {
          const node = document.querySelector(selector)!
          const ancestors: Element[] = []
          for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
            ancestors.unshift(ancestor)
            if (ancestor === panel) break
          }
          let background = backdrop
          let opacity = 1
          for (const ancestor of ancestors) {
            const style = getComputedStyle(ancestor)
            background = composite(color(style.backgroundColor), background)
            opacity *= Number(style.opacity)
          }
          const foreground = color(getComputedStyle(node).color)
          foreground[3] *= opacity
          const foregroundLight = luminance(composite(foreground, background))
          const backgroundLight = luminance(background)
          return [
            name,
            {
              color: getComputedStyle(node).color,
              background: background.slice(0, 3),
              ratio:
                (Math.max(foregroundLight, backgroundLight) + 0.05) /
                (Math.min(foregroundLight, backgroundLight) + 0.05),
            },
          ]
        }),
      )
    },
    { copyId: COPY_ID, scriptId: SCRIPT_ID },
  )
}

async function expectReadingContrast(page: Page, theme: string) {
  const contrast = await readingContrast(page)
  for (const [name, value] of Object.entries(contrast)) {
    expect(value.ratio, `${theme} ${name} contrast: ${JSON.stringify(value)}`).toBeGreaterThanOrEqual(4.5)
  }
  return contrast
}

async function expectReader(page: Page, chatId: string): Promise<void> {
  await expect(page.locator('[data-reader-lifecycle-status]')).toHaveText(
    'Read only. Updates from the writer appear here.',
    { timeout: 30_000 },
  )
  await expect(page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', chatId)
  await expect(page.locator('[data-reader-composer-field="message"]')).toBeDisabled()
  await expect(page.locator('[data-reader-use-this-device]')).toBeEnabled()
  expect(
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
  ).toMatchObject({ canMutate: false, canGenerate: false })
}

async function openNavigation(page: Page): Promise<void> {
  const toggle = page.locator('[data-reader-navigation-toggle]')
  if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  await expect(page.locator('[data-reader-navigation]')).toBeVisible()
}

async function closeNavigation(page: Page): Promise<void> {
  const drawer = page.locator('#reader-navigation[role="dialog"]')
  if (await drawer.isVisible()) await page.keyboard.press('Escape')
}

async function selection(page: Page) {
  return page.evaluate(() => {
    const value = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getReadingBoundarySnapshot()
    return {
      selectedCharacterIndex: value.selectedCharacterIndex,
      currentCharacterIndex: value.currentCharacterIndex,
      chatPages: value.chatPages,
    }
  })
}

function authoringResource(request: RolloutApiRequest): boolean {
  return /\/api\/v1\/(?:collections\/plugins|settings\/(?:models|plugins)|model-profiles|provider-credentials)(?:\/|$)/u.test(
    request.path,
  )
}

function authoringChunk(path: string): boolean {
  return /\/(?:Settings|\w+Settings|SettingRenderer|Toggles|CharConfig|QuickSettings|CustomGUISettingMenu|PlaygroundMenu)-[^/]+\.js$/u.test(
    path,
  )
}

// Replay recovery also uses these exact aggregate cacheReadRouteOptions
// endpoints. Admit only the cache protocol body, never a domain write body.
const AGGREGATE_CACHE_READ_PATHS = new Set(['/api/v1/settings', '/api/v1/collections', '/api/v1/characters'])
function isForbiddenReaderRequest(request: RolloutApiRequest): boolean {
  if (!isForbiddenRolloutReaderRequest(request)) return false
  if (
    request.method !== 'POST' ||
    !AGGREGATE_CACHE_READ_PATHS.has(request.path) ||
    request.writerSession !== null ||
    request.disconnectExistingWriter !== null ||
    request.mutationId !== null
  )
    return true
  try {
    const body = JSON.parse(request.body ?? '') as { cache?: { version?: number; hashes?: unknown } }
    return (
      Object.keys(body).join() !== 'cache' ||
      Object.keys(body.cache ?? {})
        .sort()
        .join() !== 'hashes,version' ||
      body.cache?.version !== 2 ||
      typeof body.cache.hashes !== 'object' ||
      body.cache.hashes === null ||
      Array.isArray(body.cache.hashes)
    )
  } catch {
    return true
  }
}

for (const viewport of ['desktop', 'mobile'] as const) {
  test(`the shared read-only app supports ${viewport} browsing and contains alternate authoring entry`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000)
    const harness = await startFastBootstrapHarness(fixture(), {
      temporaryDirectoryPrefix: `risu-read-only-app-ux-${viewport}-`,
      databaseSeedMode: 'unowned-migration',
    })
    const writerContext = await browser.newContext()
    const readerContext = await browser.newContext({
      ...(viewport === 'mobile' ? devices['Pixel 7'] : { viewport: { width: 1440, height: 1000 } }),
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    writerContext.setDefaultTimeout(10_000)
    readerContext.setDefaultTimeout(10_000)
    const readerRequests: RolloutApiRequest[] = []
    const requestedAssets: string[] = []
    const pageErrors: string[] = []
    const evidence: Record<string, unknown> = { viewport, readerRequests, requestedAssets, pageErrors }
    const writer = await writerContext.newPage()
    const reader = await readerContext.newPage()
    readerContext.on('request', (request) => {
      recordRolloutApiRequest(request, readerRequests)
      const url = new URL(request.url())
      if (url.origin === harness.baseUrl && !url.pathname.startsWith('/api/')) requestedAssets.push(url.pathname)
    })
    writer.on('pageerror', (error) => pageErrors.push(`writer: ${error.message}`))
    reader.on('pageerror', (error) => pageErrors.push(`reader: ${error.message}`))
    await readerContext.route(SAFE_URL, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Passive reference</h1>' }),
    )
    try {
      // This is the existing reader-authority rollout, not a presentation switch.
      await writer.goto(`${harness.baseUrl}${ROUTE_A}`, { waitUntil: 'domcontentloaded' })
      await waitForRolloutHook(writer)
      await writer.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
      )
      await expect(writer.getByTestId('default-chat-composer')).toBeEditable()
      await expectEmptyRolloutQueues(writer)
      await reader.goto(`${harness.baseUrl}${ROUTE_B}`, { waitUntil: 'domcontentloaded' })
      await waitForRolloutHook(reader)
      await expectReader(reader, CHAT_B)
      await expect(body(reader, COPY_ID)).toHaveText(COPY_TEXT)
      const initial = rolloutDurableSnapshot(harness.dataDir)
      const writerSelection = await selection(writer)
      const readerSelection = await selection(reader)
      const readerOutbox = await readNativeRolloutOutbox(reader)
      const readerDrafts = await readRolloutComposerDrafts(reader)
      evidence.initial = initial
      evidence.writerSelection = writerSelection
      expect(readerSelection.selectedCharacterIndex).toBe(-1)

      await expect(reader.locator('[data-chat-screen-layout]')).toHaveAttribute('data-chat-screen-layout', 'mobilechat')
      await expect(reader.locator('[data-reader-background]')).toContainText('Harbor background')
      await expect(reader.locator('[data-reader-background] > div')).toHaveCSS('background-color', 'rgb(219, 234, 254)')
      expect(
        await reader.evaluate(() => {
          const style = getComputedStyle(document.documentElement)
          return ['--risu-theme-bgcolor', '--risu-font-family', '--read-only-ux-theme'].map((key) =>
            style.getPropertyValue(key).trim(),
          )
        }),
      ).toEqual([PALETTE.bgcolor, 'Georgia, serif', 'confirmed'])
      await expect(body(reader, COPY_ID)).toHaveCSS('font-family', 'Georgia, serif')

      await openNavigation(reader)
      const chatNavigation = reader.locator('[data-reader-navigation]')
      const back = chatNavigation.locator('[data-reader-go-back]')
      await expect(back).toBeEnabled()
      await expect(chatNavigation.locator('button:not(:disabled), input:not(:disabled), [tabindex="0"]')).toHaveText(
        viewport === 'mobile' ? ['Close Menu', 'Go Back'] : ['Go Back'],
      )
      await back.click()
      await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_B}`)
      await expect(reader.locator('[data-risu-navigation-rail]')).toHaveCSS('width', '80px')
      await expect(writer.locator('[data-risu-navigation-rail]')).toBeVisible()
      const navigation = reader.locator('[data-reader-navigation]')
      const hamburger = navigation.getByRole('button', { name: 'Menu', exact: true })
      await hamburger.click()
      await expect(hamburger).toHaveAttribute('aria-expanded', 'true')
      await expect(navigation.locator('[data-risu-hamburger-menu]')).toBeVisible()
      for (const label of ['Settings', 'Playground']) {
        const control = navigation.getByRole('button', { name: new RegExp(`^${label}:`) })
        await expect(control).toBeDisabled()
        await expect(control).toHaveAttribute('title', WRITE_ACCESS_REASON)
        // Programmatic events reach the handler even when a native control is disabled.
        await control.dispatchEvent('pointerenter')
        await control.dispatchEvent('click')
        await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_B}`)
      }
      await hamburger.click()
      await expect(hamburger).toHaveAttribute('aria-expanded', 'false')

      const characterFolder = navigation.locator(`[data-reader-character-folder="${CHARACTER_FOLDER}"]`)
      const folderToggle = characterFolder.getByRole('button', { name: 'Voyages', exact: true })
      await expect(folderToggle).toHaveAttribute('aria-expanded', 'false')
      await folderToggle.focus()
      await reader.keyboard.press('Enter')
      await expect(folderToggle).toBeFocused()
      await expect(folderToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(navigation.locator(`[data-reader-character="${CHARACTER_B}"]`)).toBeVisible()
      const characterSearch = navigation.getByRole('searchbox', { name: 'Search: Character', exact: true })
      await characterSearch.fill('Atlas')
      await expect(navigation.locator(`[data-reader-character="${CHARACTER_B}"]`)).toHaveCount(0)
      await characterSearch.fill('')
      await expect(folderToggle).toHaveAttribute('aria-expanded', 'true')

      const chatFolder = navigation.locator(`[data-risu-chat-folder-id="${CHAT_FOLDER}"]`)
      await expect(chatFolder.getByRole('button', { name: 'Reading shelf', exact: true })).toHaveCSS(
        'color',
        'rgb(255, 255, 255)',
      )
      await expect(chatFolder.getByRole('button', { name: 'Reading shelf', exact: true })).toHaveAttribute(
        'aria-expanded',
        'false',
      )
      await chatFolder.getByRole('button', { name: 'Reading shelf', exact: true }).click()
      await expect(navigation.getByRole('button', { name: 'Open chat Harbor Reading', exact: true })).toBeVisible()
      const chatSearch = navigation.getByRole('searchbox', { name: 'Search: Chats', exact: true })
      await chatSearch.fill('Notes')
      await expect(navigation.locator(`[data-risu-chat-id="${CHAT_B}"]`)).toHaveCount(0)
      await expect(navigation.locator(`[data-risu-chat-id="${CHAT_NOTES}"]`)).toBeVisible()
      await chatSearch.fill('')
      await expect(navigation.locator(`[data-risu-pinned-chat="${CHAT_B}"]`)).toContainText('Harbor Reading')
      await screenshotEvidence(reader, testInfo, `read-only-navigation-${viewport}.png`)

      if (viewport === 'mobile') {
        const drawer = reader.locator('#reader-navigation[role="dialog"]')
        await expect(drawer).toHaveAttribute('aria-modal', 'true')
        for (let step = 0; step < 18; step++) {
          await reader.keyboard.press('Tab')
          expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true)
        }
        await reader.keyboard.press('Escape')
        await expect(drawer).toBeHidden()
        await expect(reader.locator('[data-reader-navigation-toggle]')).toBeFocused()
        await openNavigation(reader)
      }
      await navigation.getByRole('button', { name: 'Open Atlas', exact: true }).click()
      await navigation.getByRole('button', { name: 'Open chat Atlas History', exact: true }).click()
      await expectReader(reader, CHAT_A)
      await expect(body(reader, `read-only-ux-history-${HISTORY_COUNT - 1}`)).toContainText('Archive message 64.')
      const scroll = reader.locator('[data-reader-scroll]')
      await scroll.hover()
      for (let gesture = 0; gesture < 12; gesture++) {
        if (
          readerRequests.some(
            (request) => request.path === `/api/v1/chats/${CHAT_A}/messages` && request.query.includes('start='),
          )
        )
          break
        await reader.mouse.wheel(0, -2_000)
        await reader.waitForTimeout(150)
      }
      await expect
        .poll(() =>
          readerRequests.some(
            (request) => request.path === `/api/v1/chats/${CHAT_A}/messages` && request.query.includes('start='),
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
                  Number(row.getAttribute('data-chat-index')) < 50 && row.textContent?.includes('Archive message'),
              ),
            ),
        )
        .toBe(true)
      await reader.goBack()
      await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_A}`)
      await reader.goBack()
      await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_B}`)
      await reader.goBack()
      await expectReader(reader, CHAT_B)
      await reader.goForward()
      await reader.goForward()
      await reader.goForward()
      await expectReader(reader, CHAT_A)
      await openNavigation(reader)
      await navigation.locator('[data-reader-go-back]').click()
      await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_A}`)
      await navigation.locator(`[data-risu-pinned-chat="${CHAT_B}"]`).getByRole('button').click()
      await expectReader(reader, CHAT_B)

      await openNavigation(reader)
      await navigation.locator('[data-reader-go-back]').click()
      await hamburger.click()
      await navigation.getByRole('button', { name: 'Home', exact: true }).click()
      await expect(reader).toHaveURL(`${harness.baseUrl}/`)
      const catalog = reader.locator('[data-risu-grid-catalog]')
      await catalog.getByRole('searchbox', { name: 'Search', exact: true }).fill('Harbor')
      await expect(catalog.locator(`[data-risu-row-id="${CHARACTER_A}"]`)).toHaveCount(0)
      await catalog
        .locator(`[data-risu-row-id="${CHARACTER_B}"] [data-risu-grid-action="open"]`)
        .first()
        .getByRole('button')
        .click()
      await openNavigation(reader)
      await navigation.getByRole('button', { name: 'Open chat Harbor Reading', exact: true }).click()
      await expectReader(reader, CHAT_B)
      await openNavigation(reader)
      await navigation.locator('[data-reader-go-back]').click()
      await hamburger.click()
      await navigation.getByRole('button', { name: 'Grid', exact: true }).click()
      await expect(reader).toHaveURL(`${harness.baseUrl}/grid`)
      await expect(catalog).toBeVisible()
      await reader.goBack()
      await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_B}`)
      await openNavigation(reader)
      await navigation.getByRole('button', { name: 'Open chat Harbor Reading', exact: true }).click()
      await expectReader(reader, CHAT_B)
      await closeNavigation(reader)

      await reader.locator(`.risu-chat[data-risu-message-id="${COPY_ID}"] [data-risu-message-action="copy"]`).click()
      await expect.poll(() => reader.evaluate(() => navigator.clipboard.readText())).toBe(COPY_TEXT)
      await reader.keyboard.press('Escape')
      const scriptBody = body(reader, SCRIPT_ID)
      await scriptBody.locator('summary').click()
      await expect(scriptBody.locator('details')).toHaveAttribute('open', '')
      await expect(scriptBody.getByText('Passive detail content')).toBeVisible()
      evidence.initialContrast = await expectReadingContrast(reader, 'mobilechat')
      await screenshotEvidence(reader, testInfo, `read-only-${viewport}-mobilechat.png`)
      const popupPromise = readerContext.waitForEvent('page')
      await scriptBody.getByRole('link', { name: 'Reader reference', exact: true }).click()
      const popup = await popupPromise
      await expect(popup).toHaveURL(SAFE_URL)
      await expect(popup.getByRole('heading', { name: 'Passive reference' })).toBeVisible()
      await popup.close()
      const beforeScripts = await reader.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.getReadingBoundarySnapshot(),
      )
      for (const label of ['Local alert', 'Lua action']) {
        await expect(scriptBody.getByRole('button', { name: label, exact: true })).toBeDisabled()
        await expect(scriptBody.getByRole('button', { name: label, exact: true })).toHaveAttribute(
          'aria-disabled',
          'true',
        )
      }
      const delegated = scriptBody.getByRole('button', { name: 'Delegated action', exact: true })
      await expect(delegated).toHaveAttribute('tabindex', '-1')
      // Remove disabled and dispatch bubbling/cancelable events to exercise
      // the real capture/delegation boundary, including non-native controls.
      const prevented = await scriptBody.locator('[risu-trigger], [risu-btn]').evaluateAll((controls) =>
        controls.flatMap((control) => {
          control.removeAttribute('disabled')
          const events = [
            new MouseEvent('click', { bubbles: true, cancelable: true }),
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
          ]
          return events.map((event) => !control.dispatchEvent(event))
        }),
      )
      expect(prevented.length).toBe(9)
      expect(prevented.every(Boolean)).toBe(true)
      for (const kind of ['trigger', 'lua'] as const) {
        expect(
          await reader.evaluate(
            ({ characterId, chatId, kind }) =>
              window.__RISU_FASTIFY_BROWSER_SMOKE__!.probeInteractiveScriptAction({
                characterId,
                chatId,
                kind,
                name: kind === 'trigger' ? 'reader-local-alert' : 'reader-lua-button',
              }),
            { characterId: CHARACTER_B, chatId: CHAT_B, kind },
          ),
        ).toEqual({ triggerCount: 2, sourceUnchanged: true, error: 'client_write_access_required' })
      }
      expect(await reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getReadingBoundarySnapshot())).toEqual(
        beforeScripts,
      )
      await expect(reader.getByText(LOCAL_EFFECT_TEXT, { exact: true })).toHaveCount(0)

      await reader.evaluate(() => {
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo('/settings/4')
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.restoreRestrictedOverlays()
      })
      await reader.keyboard.press('Control+s')
      await reader.keyboard.press('Control+q')
      await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
      await expect
        .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getReadingBoundarySnapshot()))
        .toMatchObject({ quickSettingsOpen: false, customGuiSettingsOpen: false })
      for (const restrictedPath of ['/settings/3', '/settings/4', '/settings/14', '/playground/12', '/inlay']) {
        // A direct history entry deliberately bypasses navigate()'s in-app
        // guard and exercises route resolution, warming, and shell mounting.
        await reader.evaluate((path) => {
          history.pushState(null, '', path)
          dispatchEvent(new PopStateEvent('popstate'))
        }, restrictedPath)
        await expect(reader).toHaveURL(`${harness.baseUrl}${restrictedPath}`)
        await expect(reader.locator('[data-reader-authoring-gate]')).toHaveText(WRITE_ACCESS_REASON)
        await expect(reader.locator('[data-reader-transcript]')).toHaveCount(0)
        await expect(
          reader.locator('[data-testid="settings"], [data-testid="custom-gui-settings"], .setting-bg'),
        ).toHaveCount(0)
        await reader.locator('[data-reader-return-to-reading]').click()
        await expectReader(reader, CHAT_B)
        await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
      }

      expect(readerRequests.filter(isForbiddenReaderRequest)).toEqual([])
      expect(readerRequests.filter(authoringResource)).toEqual([])
      expect(requestedAssets.filter(authoringChunk)).toEqual([])
      expect(requestedAssets.filter((path) => /(?:\.wasm$|\/lua\/|plugin_start)/u.test(path))).toEqual([])
      expect(await selection(reader)).toEqual(readerSelection)
      expect(await selection(writer)).toEqual(writerSelection)
      await expect(writer).toHaveURL(`${harness.baseUrl}${ROUTE_A}`)
      await expect(writer.getByTestId('default-chat-composer')).toBeEditable()
      expect(await readNativeRolloutOutbox(reader)).toEqual(readerOutbox)
      expect(await readRolloutComposerDrafts(reader)).toEqual(readerDrafts)
      await expectEmptyRolloutQueues(reader)
      expect(rolloutDurableSnapshot(harness.dataDir)).toEqual(initial)
      expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      // Only the writer changes display settings after the pure-browsing
      // snapshot assertion. Each committed theme must leave a usable reader
      // transcript and takeover control at this viewport, including portraits.
      const themeBounds: Record<string, unknown> = {}
      const themeContrast: Record<string, unknown> = {}
      for (const theme of ['waifu', 'waifuMobile', 'fastify']) {
        const result = await writer.evaluate(
          (theme) => window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ theme }),
          theme,
        )
        expect(result.status).toBe('ok')
        await expectEmptyRolloutQueues(writer)
        await expect(reader.locator('[data-chat-screen-layout]')).toHaveAttribute('data-chat-screen-layout', theme)
        await expectReader(reader, CHAT_B)
        if (theme === 'waifu' && viewport === 'desktop') {
          const portrait = reader.locator('[data-chat-screen-layout="waifu"] .halfw img')
          await expect(portrait).toBeVisible()
          await expect
            .poll(() =>
              portrait.evaluate((node) => {
                const rect = node.getBoundingClientRect()
                return (
                  (node as HTMLImageElement).naturalWidth > 0 &&
                  document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node
                )
              }),
            )
            .toBe(true)
        }
        const bounds = await reader.evaluate(() => {
          const rectangle = (selector: string) => {
            const rect = document.querySelector(selector)?.getBoundingClientRect()
            return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom } : null
          }
          return {
            transcript: rectangle('[data-reader-scroll]'),
            takeover: rectangle('[data-reader-use-this-device]'),
            viewport: { width: innerWidth, height: innerHeight },
            overflow: document.documentElement.scrollWidth > innerWidth,
          }
        })
        themeBounds[theme] = bounds
        expect(bounds.transcript?.height, `${theme} reader scroll height`).toBeGreaterThan(40)
        expect(bounds.transcript?.width, `${theme} reader scroll width`).toBeGreaterThan(100)
        expect(bounds.takeover?.bottom, `${theme} takeover remains inside viewport`).toBeLessThanOrEqual(
          bounds.viewport.height,
        )
        expect(bounds.overflow, `${theme} horizontal overflow`).toBe(false)
        themeContrast[theme] = await expectReadingContrast(reader, theme)
        expect(readerRequests.filter(isForbiddenReaderRequest)).toEqual([])
        expect(await readNativeRolloutOutbox(reader)).toEqual(readerOutbox)
        await screenshotEvidence(reader, testInfo, `read-only-${viewport}-${theme}.png`)
      }
      evidence.themeBounds = themeBounds
      evidence.themeContrast = themeContrast
      expect(pageErrors).toEqual([])
    } catch (error) {
      await screenshotEvidence(reader, testInfo, 'read-only-app-failure.png').catch(() => undefined)
      throw error
    } finally {
      try {
        evidence.terminal = rolloutDurableSnapshot(harness.dataDir)
        evidence.forbiddenRequests = readerRequests.filter(isForbiddenReaderRequest)
        const output = testInfo.outputPath('read-only-app-ux.json')
        writeFileSync(output, JSON.stringify(evidence, null, 2))
        await testInfo.attach('read-only-app-ux.json', { path: output, contentType: 'application/json' })
      } finally {
        await readerContext.close().catch(() => undefined)
        await writerContext.close().catch(() => undefined)
        await closeFastBootstrapHarness(harness)
      }
    }
  })
}

test('reader target deletion falls back locally and an authenticated-read failure clears protected browsing', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const harness = await startFastBootstrapHarness(fixture(), {
    temporaryDirectoryPrefix: 'risu-reader-target-auth-',
    databaseSeedMode: 'unowned-migration',
  })
  const writerContext = await browser.newContext()
  const readerContext = await browser.newContext()
  const writer = await writerContext.newPage()
  const reader = await readerContext.newPage()
  const requests: RolloutApiRequest[] = []
  const authFailureRequests: string[] = []
  const replayFailureRequests: string[] = []
  const errors: string[] = []
  const evidence: Record<string, unknown> = { requests, authFailureRequests, replayFailureRequests, errors }
  readerContext.on('request', (request) => recordRolloutApiRequest(request, requests))
  writer.on('pageerror', (error) => errors.push(`writer: ${error.message}`))
  reader.on('pageerror', (error) => errors.push(`reader: ${error.message}`))
  try {
    await writer.goto(`${harness.baseUrl}${ROUTE_A}`, { waitUntil: 'domcontentloaded' })
    await waitForRolloutHook(writer)
    await writer.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect(writer.getByTestId('default-chat-composer')).toBeEditable()
    await expectEmptyRolloutQueues(writer)
    await reader.goto(`${harness.baseUrl}${ROUTE_B}`, { waitUntil: 'domcontentloaded' })
    await waitForRolloutHook(reader)
    await expectReader(reader, CHAT_B)
    await expect(body(reader, COPY_ID)).toHaveText(COPY_TEXT)
    const initial = rolloutDurableSnapshot(harness.dataDir)
    const writerSelection = await selection(writer)
    const outbox = await readNativeRolloutOutbox(reader)
    const drafts = await readRolloutComposerDrafts(reader)
    evidence.initial = initial
    await openNavigation(reader)
    const navigation = reader.locator('[data-reader-navigation]')
    await navigation.locator('[data-reader-go-back]').click()
    await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_B}`)
    await navigation
      .locator(`[data-reader-character-folder="${CHARACTER_FOLDER}"]`)
      .getByRole('button', { name: 'Voyages', exact: true })
      .click()
    await navigation.getByRole('searchbox', { name: 'Search: Character', exact: true }).fill('Harbor')
    await navigation
      .locator(`[data-risu-chat-folder-id="${CHAT_FOLDER}"]`)
      .getByRole('button', { name: 'Reading shelf', exact: true })
      .click()
    await navigation.getByRole('searchbox', { name: 'Search: Chats', exact: true }).fill('Harbor')
    await expect(navigation.locator(`[data-risu-chat-id="${CHAT_B}"]`)).toBeVisible()
    await navigation.getByRole('button', { name: 'Open chat Harbor Reading', exact: true }).click()
    await expectReader(reader, CHAT_B)

    const beforeReplayRequests = requests.length
    await reader.route('**/api/v1/events?*', async (route) => {
      if (replayFailureRequests.length === 0) {
        replayFailureRequests.push(route.request().url())
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'event_replay_unavailable',
            currentRevision: initial.revision,
            oldestRevision: initial.revision,
            latestRevision: initial.revision,
          }),
        })
      } else await route.continue()
    })
    // A single controlled exhausted-cursor response on a real reconnect drives
    // the production full-resource refresh and subsequent event subscription.
    await readerContext.setOffline(true)
    await expect
      .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().connection))
      .toBe('interrupted')
    await readerContext.setOffline(false)
    await expect.poll(() => replayFailureRequests.length).toBe(1)
    await expect
      .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().connection), {
        timeout: 30_000,
      })
      .toBe('live')
    await expectReader(reader, CHAT_B)
    await expect(reader).toHaveURL(`${harness.baseUrl}${ROUTE_B}`)
    for (const path of ['/api/v1/settings', '/api/v1/collections', '/api/v1/characters']) {
      expect(
        requests.slice(beforeReplayRequests).some((request) => request.path === path),
        `replay refresh reads ${path}`,
      ).toBe(true)
    }
    await openNavigation(reader)
    await reader.locator('[data-reader-go-back]').click()
    await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_B}`)
    await expect(navigation.getByRole('searchbox', { name: 'Search: Character', exact: true })).toHaveValue('Harbor')
    await expect(navigation.getByRole('searchbox', { name: 'Search: Chats', exact: true })).toHaveValue('Harbor')
    await expect(
      navigation
        .locator(`[data-risu-chat-folder-id="${CHAT_FOLDER}"]`)
        .getByRole('button', { name: 'Reading shelf', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true')
    expect(rolloutDurableSnapshot(harness.dataDir)).toEqual(initial)
    expect(await readNativeRolloutOutbox(reader)).toEqual(outbox)
    expect(requests.filter(isForbiddenReaderRequest)).toEqual([])
    await navigation.getByRole('button', { name: 'Open chat Harbor Reading', exact: true }).click()
    await expectReader(reader, CHAT_B)

    const deleted = await writer.evaluate(
      async ({ chatId }) => {
        const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
        const bootstrap = (await fetch('/api/v1/bootstrap', { headers }).then((response) => response.json())) as {
          revision: number
          databaseLineage: string
        }
        const response = await fetch(`/api/v1/commands/chats/${chatId}`, {
          method: 'DELETE',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'risu-database-lineage': bootstrap.databaseLineage,
          },
          body: JSON.stringify({ baseRevision: bootstrap.revision }),
        })
        return { status: response.status, body: (await response.json()) as { revision: number } }
      },
      { chatId: CHAT_B },
    )
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200)
    await expectReader(reader, CHAT_NOTES)
    await expect(reader).toHaveURL(`${harness.baseUrl}/character/${CHARACTER_B}/${CHAT_NOTES}`)
    await expect(body(reader, 'read-only-ux-note')).toHaveText('Committed notes remain available.')
    await openNavigation(reader)
    await reader.locator('[data-reader-go-back]').click()
    await expect(navigation.locator(`[data-risu-pinned-chat="${CHAT_B}"]`)).toHaveCount(0)
    await expect(navigation.locator(`[data-risu-chat-id="${CHAT_B}"]`)).toHaveCount(0)
    await expect(navigation.getByRole('searchbox', { name: 'Search: Character', exact: true })).toHaveValue('Harbor')
    await expect(navigation.getByRole('searchbox', { name: 'Search: Chats', exact: true })).toHaveValue('Harbor')
    await expect(writer).toHaveURL(`${harness.baseUrl}${ROUTE_A}`)
    expect(await selection(writer)).toEqual(writerSelection)
    expect(requests.filter(isForbiddenReaderRequest)).toEqual([])
    const afterDeletion = rolloutDurableSnapshot(harness.dataDir)
    expect(afterDeletion.revision).toBe(deleted.body.revision)
    expect(afterDeletion.ownership).toEqual(initial.ownership)
    expect(afterDeletion.events.slice(initial.events.length)).toMatchObject([
      { id: CHAT_B, origin_writer_session_id: initial.ownership.active_writer_session_id },
    ])
    evidence.afterDeletion = afterDeletion
    await navigation.getByRole('button', { name: 'Open chat Harbor Notes', exact: true }).click()
    await expectReader(reader, CHAT_NOTES)

    // Controlled transport failure of a real protected read. Server data and
    // auth credentials are untouched, so only Reader B must clear its UI.
    await reader.route(`**/api/v1/chats/${CHAT_NOTES}/messages*`, async (route) => {
      authFailureRequests.push(route.request().url())
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unauthorized' }),
      })
    })
    await reader.locator('[data-reader-refresh]').click()
    await expect.poll(() => authFailureRequests.length).toBeGreaterThan(0)
    const gate = reader.locator('[data-reader-auth-required]')
    await expect(gate).toBeVisible()
    await expect(gate.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
    await expect(
      reader.locator('[data-reader-transcript], [data-reader-navigation], [data-risu-grid-catalog]'),
    ).toHaveCount(0)
    await expect(reader.getByText('Committed notes remain available.', { exact: true })).toHaveCount(0)
    expect(
      await reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()),
    ).toMatchObject({ lifecycle: 'auth-required', authenticated: false, projectionReady: false })
    await expect
      .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters))
      .toEqual([])
    expect(await readNativeRolloutOutbox(reader)).toEqual(outbox)
    expect(await readRolloutComposerDrafts(reader)).toEqual(drafts)
    expect(requests.filter(isForbiddenReaderRequest)).toEqual([])
    expect(rolloutDurableSnapshot(harness.dataDir)).toEqual(afterDeletion)
    await expect(writer.getByTestId('default-chat-composer')).toBeEditable()
    expect(errors).toEqual([])
    await screenshotEvidence(reader, testInfo, 'reader-auth-required.png')
  } catch (error) {
    await screenshotEvidence(reader, testInfo, 'read-only-target-auth-failure.png').catch(() => undefined)
    throw error
  } finally {
    try {
      evidence.terminal = rolloutDurableSnapshot(harness.dataDir)
      const output = testInfo.outputPath('read-only-target-auth.json')
      writeFileSync(output, JSON.stringify(evidence, null, 2))
      await testInfo.attach('read-only-target-auth.json', { path: output, contentType: 'application/json' })
    } finally {
      await readerContext.close().catch(() => undefined)
      await writerContext.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  }
})

test('authenticated display cache POSTs remain pure reads while a different session owns writes', async () => {
  const harness = await startFastBootstrapHarness(fixture(), { temporaryDirectoryPrefix: 'risu-reader-cache-read-' })
  try {
    const writer = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': harness.assertion, 'risu-writer-session': 'read-only-cache-writer' },
    })
    expect(writer.statusCode).toBe(200)
    const before = rolloutDurableSnapshot(harness.dataDir)
    expect(before.ownership.active_writer_session_id).toBe('read-only-cache-writer')
    for (const url of ['/api/v1/settings/display', '/api/v1/collections/personas', ...AGGREGATE_CACHE_READ_PATHS]) {
      const payload = { cache: { version: 2, hashes: {} } }
      const denied = await harness.app.inject({ method: 'POST', url, payload })
      expect(denied.statusCode).toBe(401)
      const response = await harness.app.inject({
        method: 'POST',
        url,
        headers: { 'risu-auth': harness.assertion, 'risu-writer-observer-session': 'read-only-cache-reader' },
        payload,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ revision: before.revision })
      expect(rolloutDurableSnapshot(harness.dataDir)).toEqual(before)
    }
  } finally {
    await closeFastBootstrapHarness(harness)
  }
})
