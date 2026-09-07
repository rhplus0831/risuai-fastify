import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { closeFastBootstrapHarness, startFastBootstrapHarness } from './fastBootstrapHarness.js'
import { RESIDENCY_CHARACTER_ID, RESIDENCY_CHAT_ID, transcriptResidencyFixture } from './transcriptResidencyFixture.js'

// DOM trace snapshots can change the scheduling of a one-frame regression.
test.use({ trace: 'off' })

type EntrySample = {
  at: number
  pending: boolean
  readable: boolean
  top: number
  height: number
  viewportHeight: number
  scrollTop: number
  spacer: number
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  for (const navigation of ['direct', 'chat-list'] as const) {
    for (const tall of [false, true]) {
      test(`${viewport.width}px ${navigation} entry reveals a ${tall ? 'tall' : 'short'} last message without a transient jump`, async ({
        page,
      }, testInfo) => {
        const database = transcriptResidencyFixture(12)
        const character = (database.characters as Array<{ chats: Array<{ message: Array<{ data: string }> }> }>)[0]
        character.chats[0].message[11].data =
          'Entry message beginning.\n\n' +
          (tall
            ? ('A paragraph of the last message that wraps across the viewport. '.repeat(5) + '\n\n').repeat(12)
            : '') +
          'Entry message end.'
        const harness = await startFastBootstrapHarness(database)
        let releaseDisplay!: () => void
        const displayGate = new Promise<void>((resolve) => {
          releaseDisplay = resolve
        })
        let blocked = false
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.setViewportSize(viewport)
        await page.addInitScript(() => {
          const samples: EntrySample[] = []
          Reflect.set(window, '__chatEntrySamples', samples)
          const sample = () => {
            const transcript = document.querySelector<HTMLElement>('[data-default-chat-transcript]')
            const row = transcript?.querySelector<HTMLElement>('[data-risu-message-id="residency-message-11"]')
            if (!transcript || !row) return
            if (samples.length >= 600) samples.shift()
            const rect = row.closest('.chat-message-container')!.getBoundingClientRect()
            samples.push({
              at: performance.now(),
              pending: transcript.hasAttribute('data-chat-initial-display-pending'),
              readable:
                rect.height > 0 &&
                getComputedStyle(row).visibility === 'visible' &&
                (row.querySelector('.chat-message-body')?.textContent?.includes('Entry message beginning.') ?? false),
              top: rect.top - transcript.getBoundingClientRect().top - transcript.clientTop,
              height: rect.height,
              viewportHeight: transcript.clientHeight,
              scrollTop: transcript.scrollTop,
              spacer:
                transcript.querySelector('[data-latest-message-scroll-spacer]')?.getBoundingClientRect().height ?? 0,
            })
          }
          const frame = () => {
            // Sample after this rendering turn's animation callbacks, including the
            // application's scroll corrections, rather than racing them in rAF.
            setTimeout(sample, 0)
            requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
        await page.route('**/api/v1/chats/*/display-sources', async (route) => {
          const body = route.request().postDataJSON() as { targets: Array<{ index: number }> }
          if (body.targets.some((target) => target.index === 11)) {
            blocked = true
            await displayGate
          }
          await route.continue()
        })
        try {
          if (navigation === 'direct') {
            await page.goto(`${harness.baseUrl}/character/${RESIDENCY_CHARACTER_ID}/${RESIDENCY_CHAT_ID}`)
          } else {
            await page.goto(harness.baseUrl)
            await expect
              .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__?.isLoaded() ?? false))
              .toBe(true)
            await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.selectCharacter(0))
            const chatRow = page.locator(`[data-risu-chat-id="${RESIDENCY_CHAT_ID}"]`).first()
            const recentChat = page.getByRole('button', { name: /Open most recent chat Transcript Residency Chat/ })
            await expect.poll(async () => (await chatRow.isVisible()) || (await recentChat.isVisible())).toBe(true)
            if (await chatRow.isVisible()) await chatRow.locator('button[data-risu-chat-action="select"]').click()
            else await recentChat.click()
          }
          await expect.poll(() => blocked).toBe(true)
          await expect(page.locator('[data-chat-message-skeleton]')).toBeVisible()
          // Ensure the skeleton is actually presented before the async body arrives.
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          )
          releaseDisplay()
          await expect(page.locator('[data-chat-message-skeleton]')).toHaveCount(0)
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (Reflect.get(window, '__chatEntrySamples') as EntrySample[]).filter(
                    (sample) => !sample.pending && sample.readable,
                  ).length,
              ),
            )
            .toBeGreaterThanOrEqual(30)
          const samples = await page.evaluate(() => Reflect.get(window, '__chatEntrySamples') as EntrySample[])
          const visible = samples.filter((sample) => !sample.pending && sample.readable)
          expect(visible.length).toBeGreaterThanOrEqual(30)
          expect(visible.at(-1)!.height > visible.at(-1)!.viewportHeight).toBe(tall)
          expect(
            visible.filter((sample) => Math.abs(sample.top) > 1),
            'every visible frame starts at the last message beginning',
          ).toEqual([])
          expect(errors).toEqual([])
        } finally {
          releaseDisplay()
          const observations = testInfo.outputPath('chat-entry-frames.json')
          writeFileSync(
            observations,
            JSON.stringify(await page.evaluate(() => Reflect.get(window, '__chatEntrySamples'))),
          )
          await testInfo.attach('chat-entry-frames', {
            path: observations,
            contentType: 'application/json',
          })
          if (testInfo.status !== testInfo.expectedStatus) {
            const screenshot = testInfo.outputPath('chat-entry-failure.png')
            await page.screenshot({ path: screenshot })
            await testInfo.attach('chat-entry-failure', { path: screenshot, contentType: 'image/png' })
          }
          await page.context().close()
          await closeFastBootstrapHarness(harness)
        }
      })
    }
  }
}
