import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import type { FastifyInstance } from 'fastify'
import { setupBrowserSmokeAuth } from './auth.js'

// Swipe persistence E2E. Proves the real Fastify-served browser reconstructs the
// reroll swipe buffer from persisted alternate rows after a reload, and that
// swiping back over the rebuilt buffer works under the live read-only projection guard.

interface Harness {
  app: FastifyInstance
  baseUrl: string
  dataDir: string
}

let harness: Harness

test.beforeAll(async () => {
  harness = await startHarness()
  const assertion = await setupBrowserSmokeAuth(harness.app)
  await importDatabase(harness.app, assertion, rerollFixtureDatabase())
})

test.afterAll(async () => {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

test('rerolled candidates survive a reload and stay swipe-recoverable', { tag: '@core' }, async ({ page }) => {
  const diagnostics: string[] = []
  const generationRequestPaths: string[] = []
  page.on('console', (m) => diagnostics.push(`console.${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => diagnostics.push(`pageerror: ${e.message}`))
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/generation-operations') || pathname.includes('/messages/truncate')) {
      generationRequestPaths.push(pathname)
    }
  })

  await page.goto(harness.baseUrl)
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), {
      timeout: 15_000,
    })
    .toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded())
  await expectLoadedCharacterVisible(page)
  await markRerollChatGenerationSettingsReady(page)

  // Ensure the fixture character is open, then let the chat hydrate.
  await openFixtureChat(page)
  await expectVisibleChatRow(page, 0, 'greet me')
  await expectVisibleChatRow(page, 1, 'old reply')

  // The open chat hydrates to [user, char 'old reply'].
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const snap = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
          const chat = (snap.characters as Array<{ chats: Array<{ message: Array<{ data: string }> }> }>)[0].chats[0]
          return chat.message.map((m) => m.data)
        }),
      { timeout: 15_000 },
    )
    .toEqual(['greet me', 'old reply'])

  // Drive the production UI reroll. It must submit the target-preserving
  // generation operation without first issuing a transcript truncate.
  const operationResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/generation-operations' && response.request().method() === 'POST',
  )
  await page.locator('.default-chat-screen .risu-chat[data-chat-index="1"] [data-risu-message-action="reroll"]').click()
  expect((await operationResponse).ok(), diagnostics.slice(-15).join('\n')).toBe(true)
  const projectionRow = page.locator(
    '.default-chat-screen .chat-message-container[data-generation-display-projection="regenerate"]',
  )
  await expect(projectionRow).toBeVisible({ timeout: 5_000 })
  await expect(projectionRow.locator('[data-generation-projection-loading]')).toBeVisible()
  await expect(projectionRow).not.toContainText('old reply')
  await expect(page.locator('.default-chat-screen .chat-message-container')).toHaveCount(2)
  await expect
    .poll(
      () =>
        page.locator('[data-default-chat-transcript]').evaluate((transcript) => (transcript as HTMLElement).scrollTop),
      { timeout: 5_000 },
    )
    .toBe(0)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const snap = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
          const chat = (snap.characters as Array<{ chats: Array<{ message: Array<{ data: string }> }> }>)[0].chats[0]
          return chat.message.at(-1)?.data ?? ''
        }),
      { timeout: 15_000, message: diagnostics.slice(-15).join('\n') },
    )
    .toContain('rerolled reply')
  await expect(projectionRow).toHaveCount(0)
  await expect(page.locator('.default-chat-screen .chat-message-container')).toHaveCount(2)
  await expect(page.getByTestId('default-chat-send-button')).toBeVisible({ timeout: 15_000 })
  expect(generationRequestPaths.some((pathname) => pathname === '/api/v1/generation-operations')).toBe(true)
  expect(generationRequestPaths.some((pathname) => pathname.includes('/messages/truncate'))).toBe(false)

  // RELOAD: the buffer must be rebuilt purely from the persisted projection.
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), {
      timeout: 15_000,
    })
    .toBe(true)
  // The smoke bridge is installed before route/bootstrap settlement. Use the
  // visible app shell below as the reload readiness signal; awaiting the bridge's
  // original bootstrap promise can outlive the replaced reload execution context.
  await expectLoadedCharacterVisible(page)
  // Ensure the fixture character is open after the reload.
  await openFixtureChat(page)
  await expectVisibleChatRow(page, 0, 'greet me')
  await expectVisibleChatRow(page, 1, 'rerolled reply')

  // The normal active-chat hydration must reconstruct the reroll buffer. Poll
  // that production path instead of forcing a second, overlapping hydration.
  // The displaced 'old reply' is recoverable alongside the new active candidate.
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRerollCandidates()), {
      timeout: 15_000,
    })
    .toEqual(expect.arrayContaining([expect.stringContaining('old reply'), expect.stringContaining('rerolled reply')]))
  const candidatesAfterReload = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRerollCandidates())
  expect(candidatesAfterReload.length).toBe(2)

  // The active tail is the new candidate before swiping.
  const tailBefore = await page.evaluate(() => {
    const snap = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
    const message = (snap.characters as Array<{ chats: Array<{ message: Array<{ data: string }> }> }>)[0].chats[0]
      .message
    return message.at(-1)!.data
  })
  expect(tailBefore).toContain('rerolled reply')

  // Swipe back over the rebuilt buffer (under the live projection guard) → the
  // prior candidate 'old reply' is recovered as the active tail.
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.swipeRerollBack())
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const snap = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
          const message = (snap.characters as Array<{ chats: Array<{ message: Array<{ data: string }> }> }>)[0].chats[0]
            .message
          return message.at(-1)?.data ?? ''
        }),
      { timeout: 15_000 },
    )
    .toContain('old reply')
  await expectVisibleChatRow(page, 1, 'old reply')
})

async function expectLoadedCharacterVisible(page: Page): Promise<void> {
  await expect(page.locator('[data-char-id="char-1"]')).toBeVisible()
}

async function openFixtureChat(page: Page): Promise<void> {
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.selectCharacter(0))
  const fixtureEntry = page
    .locator('.default-chat-screen .risu-chat[data-chat-index="0"], [data-risu-chat-idx][data-risu-chat-id="chat-1"]')
    .first()
  await expect(fixtureEntry).toBeVisible({ timeout: 15_000 })
  const needsOpen = await fixtureEntry.evaluate((node) =>
    node.matches('[data-risu-chat-idx][data-risu-chat-id="chat-1"]'),
  )
  if (needsOpen) {
    await fixtureEntry.locator('button[data-risu-chat-action="select"]').click()
  }
}

async function expectVisibleChatRow(page: Page, index: number, text: string): Promise<void> {
  const row = page.locator(`.default-chat-screen .risu-chat[data-chat-index="${index}"]`)
  await expect(row).toBeVisible()
  await expect(row).toContainText(text)
}

async function markRerollChatGenerationSettingsReady(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const bootstrap = await fetch('/api/v1/bootstrap', { headers })
    const bootstrapBody = (await bootstrap.json()) as { revision?: unknown }
    const res = await fetch('/api/v1/commands/chats/chat-1/generation-settings', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: bootstrapBody.revision,
        generationSettings: {
          configured: true,
          personaId: 'persona-reroll-smoke',
          modelPresetId: 'model-preset-reroll-smoke',
          promptPresetId: 'preset-reroll-smoke',
          jailbreakToggle: false,
          sidebarToggles: {},
        },
      }),
    })
    return { body: await res.json(), status: res.status }
  })
  expect(result, JSON.stringify(result.body)).toMatchObject({ status: 200 })
}

function rerollFixtureDatabase(): Record<string, unknown> {
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    currentChar: 0,
    selectedCharID: 0,
    characterOrder: [],
    characters: [
      {
        chaId: 'char-1',
        type: 'character',
        name: 'Reroll Char',
        desc: 'DESC',
        utilityBot: false,
        chatPage: 0,
        firstMessage: 'Greetings.',
        customscript: [],
        globalLore: [],
        viewScreen: 'none',
        emotionImages: [],
        chats: [
          {
            id: 'chat-1',
            name: 'Chat',
            note: '',
            localLore: [],
            message: [
              { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
              { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
            ],
          },
        ],
      },
    ],
    formatingOrder: ['main', 'description', 'chats'],
    promptSettings: {
      assistantPrefill: '',
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
    },
    modelPresets: [{ id: 'model-preset-reroll-smoke', name: 'Reroll Smoke Model Preset' }],
    promptPresets: [{ id: 'preset-reroll-smoke', name: 'Reroll Smoke Prompt Preset' }],
    loadouts: [],
    modules: [],
    username: 'User',
    selectedPersona: 0,
    personas: [
      {
        id: 'persona-reroll-smoke',
        name: 'User',
        icon: '',
        largePortrait: false,
        personaPrompt: '',
      },
    ],
    plugins: [],
    pluginCustomStorage: {},
    language: 'en',
    loreBookToken: 8000,
    mainPrompt: 'MAIN',
    maxContext: 100_000,
    maxResponse: 50,
    swipe: false,
    aiModel: 'echo_model',
    echoMessage: 'rerolled reply',
    echoDelay: 0.5,
  }
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-reroll-smoke-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      staticRoot: path.resolve('dist'),
    },
    memoryWorker: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fastify reroll smoke harness did not bind to a TCP port')
  }
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, dataDir }
}

async function importDatabase(app: FastifyInstance, auth: string, database: Record<string, unknown>) {
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': auth },
    payload: { database },
  })
  expect(imported.statusCode).toBe(200)
}
