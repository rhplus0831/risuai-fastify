import { expect, test } from '@playwright/test'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

for (const navigation of ['direct', 'refresh'] as const) {
  test(`${navigation} chat startup waits for display dependencies and preserves the first processed body through background startup`, async ({
    page,
  }) => {
    const database = smallFastBootstrapFixture()
    const character = (
      database.characters as Array<{ chaId: string; chats: Array<{ id: string; message: unknown[] }> }>
    )[0]
    const chat = character.chats[0]
    chat.message = [{ chatId: 'display-startup-message', role: 'char', data: 'Unprocessed startup message' }]
    database.plugins = [
      {
        name: 'Startup display test',
        script:
          "await risuai.addRisuScriptHandler('display', (text) => text.replaceAll('Unprocessed startup', 'Processed startup'))",
        version: '3.0',
        enabled: true,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
      },
    ]
    const harness = await startFastBootstrapHarness(database)
    const gates = new Map<string, { promise: Promise<void>; release(): void }>()
    for (const path of ['collections/personas', 'collections/modules', 'collections/plugins', 'settings/memory']) {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.set(`/api/v1/${path}`, { promise, release })
    }
    const seen = new Set<string>()
    const errors: string[] = []
    const latest = page.locator('[data-risu-message-id="display-startup-message"] .chat-message-body')
    const url = `${harness.baseUrl}/character/${character.chaId}/${chat.id}`
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      if (navigation === 'refresh') {
        await page.goto(url)
        await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
        await expect(latest).toContainText('Processed startup message')
        await page.evaluate(() =>
          window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 10_000),
        )
      }
      await page.addInitScript(() => {
        const state = { rawTextSeen: false, disappeared: false, rendered: false }
        Object.assign(window, { __chatStartupDisplay: state })
        new MutationObserver(() => {
          const body = document.querySelector('[data-risu-message-id="display-startup-message"] .chat-message-body')
          const text = body?.textContent ?? ''
          if (text.includes('Unprocessed startup')) state.rawTextSeen = true
          if (state.rendered && !text.includes('Processed startup')) state.disappeared = true
          if (text.includes('Processed startup')) state.rendered = true
        }).observe(document, { childList: true, subtree: true, characterData: true })
      })
      await page.route('**/api/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname
        const gate = gates.get(path)
        if (gate) {
          seen.add(path)
          await gate.promise
        }
        await route.continue()
      })
      const messages = page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/api/v1/chats/${chat.id}/messages`,
      )
      if (navigation === 'refresh') await page.reload()
      else await page.goto(url)
      await messages
      await expect.poll(() => seen.size).toBe(gates.size)
      await expect(page.locator('[data-chat-message-skeleton]')).toBeVisible()
      await expect(page.locator('[data-testid="default-chat-composer"]')).toBeVisible()
      await expect(latest).toHaveCount(0)

      gates.get('/api/v1/collections/personas')!.release()
      gates.get('/api/v1/collections/modules')!.release()
      await expect(latest).toHaveCount(0)
      gates.get('/api/v1/collections/plugins')!.release()
      if (navigation === 'direct') {
        await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
      }
      // Memory still blocks generation/background readiness, but cannot block display.
      await expect(latest).toContainText('Processed startup message')
      await expect(page.locator('[data-chat-message-skeleton]')).toHaveCount(0)
      gates.get('/api/v1/settings/memory')!.release()
      await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 10_000),
      )
      await expect(latest).toContainText('Processed startup message')
      expect(
        await page.evaluate(() => (window as unknown as { __chatStartupDisplay: unknown }).__chatStartupDisplay),
      ).toEqual({ rawTextSeen: false, disappeared: false, rendered: true })
      expect(errors).toEqual([])
    } finally {
      gates.forEach((gate) => gate.release())
      // Late asset responses can retain a context-owned keepalive socket.
      await page.context().close()
      await closeFastBootstrapHarness(harness)
    }
  })
}

test('direct chat startup releases the newest rows before older display work and preserves their scroll anchor', async ({
  page,
}) => {
  const database = smallFastBootstrapFixture()
  const character = (
    database.characters as Array<{ chaId: string; chats: Array<{ id: string; message: unknown[] }> }>
  )[0]
  const chat = character.chats[0]
  chat.message = Array.from({ length: 12 }, (_, index) => ({
    chatId: `startup-message-${index}`,
    role: index % 2 ? 'char' : 'user',
    data:
      index === 11
        ? 'Newest startup message'
        : `Startup history ${index}. ${'Earlier transcript paragraph. '.repeat(12)}`,
  }))
  const harness = await startFastBootstrapHarness(database)
  let releaseOlder!: () => void
  const olderGate = new Promise<void>((resolve) => {
    releaseOlder = resolve
  })
  let blockedOlder = 0
  let characterReads = 0
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/v1/characters/${character.chaId}`) characterReads++
  })
  await page.route('**/api/v1/chats/*/display-sources', async (route) => {
    const body = route.request().postDataJSON() as { targets: Array<{ index: number }> }
    if (body.targets.some((target) => target.index < 10)) {
      blockedOlder++
      await olderGate
    }
    await route.continue()
  })
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${harness.baseUrl}/character/${character.chaId}/${chat.id}`)
    const latest = page.locator('[data-risu-message-id="startup-message-11"] .chat-message-body')
    await expect(latest).toContainText('Newest startup message')
    await expect.poll(() => blockedOlder).toBe(1)
    await expect(page.locator('.risu-chat[data-risu-message-id^="startup-message-"]')).toHaveCount(12)
    await expect(page.locator('[data-risu-message-id="startup-message-0"] .chat-message-body')).not.toContainText(
      'Startup history 0',
    )
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 10_000),
    )
    expect(characterReads).toBe(1)
    const offset = () =>
      latest.evaluate((node) => {
        const transcript = document.querySelector<HTMLElement>('[data-default-chat-transcript]')!
        const row = node.closest('.chat-message-container')!
        return Math.abs(row.getBoundingClientRect().top - transcript.getBoundingClientRect().top - transcript.clientTop)
      })
    await expect.poll(offset).toBeLessThanOrEqual(1)
    releaseOlder()
    await expect(page.locator('[data-risu-message-id="startup-message-0"] .chat-message-body')).toContainText(
      'Startup history 0',
    )
    await expect.poll(offset).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  } finally {
    releaseOlder()
    await page.context().close()
    await closeFastBootstrapHarness(harness)
  }
})
