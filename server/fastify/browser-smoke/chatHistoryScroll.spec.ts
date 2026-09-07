import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { closeFastBootstrapHarness, startFastBootstrapHarness } from './fastBootstrapHarness.js'
import { RESIDENCY_CHARACTER_ID, RESIDENCY_CHAT_ID, transcriptResidencyFixture } from './transcriptResidencyFixture.js'

// DOM trace snapshots affect the scheduling this regression exercises.
test.use({ trace: 'off' })

const TRANSCRIPT = '[data-default-chat-transcript]'
const MESSAGE_COUNT = 300
const STATIC_IMAGE = `<style>
.image-container {
  width: 30em;
  height: 30em;
  margin: auto;
  border-radius: 20px;
}
@media (max-width: 768px) {
  .image-container { width: 20em; height: 15em; }
}
</style>
<div class="image-container" style="background-image: linear-gradient(135deg, #183c69, #badaea);" tabindex="0"></div>`

async function historyViewport(page: Page) {
  return page.locator(TRANSCRIPT).evaluate((transcript) => {
    const viewport = transcript.getBoundingClientRect()
    const owner = transcript.querySelector('[data-transcript-window-rows]')!
    const visible = Array.from(transcript.querySelectorAll<HTMLElement>('.risu-chat[data-risu-message-id]'))
      .map((row) => ({
        id: row.dataset.risuMessageId!,
        index: Number(row.dataset.chatIndex),
        top: row.getBoundingClientRect().top - viewport.top,
        bottom: row.getBoundingClientRect().bottom - viewport.top,
        readable: row.querySelector('.chat-message-body')?.textContent?.includes('History message') ?? false,
      }))
      .filter((row) => row.bottom > 0 && row.top < viewport.height)
      .sort((left, right) => left.top - right.top)
    return {
      time: performance.now(),
      scrollTop: transcript.scrollTop,
      scrollHeight: transcript.scrollHeight,
      clientHeight: transcript.clientHeight,
      windowRows: Number(owner.getAttribute('data-transcript-window-rows')),
      residentRows: Number(owner.getAttribute('data-transcript-resident-rows')),
      busy: owner.getAttribute('aria-busy'),
      visible,
    }
  })
}

for (const { pageDelay, assets, reverse, label } of [
  { pageDelay: 0, assets: false, reverse: false, label: 'continuous upward wheel input' },
  { pageDelay: 150, assets: true, reverse: true, label: 'rapid reversals and pauses among tall messages' },
]) {
  test(`300-message history stays readable with ${label}`, async ({ page }, testInfo) => {
    test.setTimeout(150_000)
    const database = transcriptResidencyFixture(MESSAGE_COUNT)
    const character = (database.characters as Array<{ chats: Array<{ message: Array<{ data: string }> }> }>)[0]
    character.chats[0].message.forEach((message, index) => {
      const paragraph = 'This is a long chat message with ordinary words that wrap naturally across the chat viewport. '
      message.data = (`History message ${index}.\n\n` + (paragraph.repeat(2) + '\n\n').repeat(5)).slice(0, 800)
      // No hover resizing: the regression also occurs with static rich content.
      if (assets && index % 2 === 1) message.data += '\n\n' + STATIC_IMAGE
      // Exercise a large difference between estimated, pending, and parsed row heights.
      if (assets && index % 15 === 1) message.data += '\n\n<div style="height: 7607px;">Tall message content</div>'
    })
    const harness = await startFastBootstrapHarness(database)
    const errors: string[] = []
    const scriptAssetPaths: string[] = []
    const scriptAssetResponses: { url: string; path: string; status: number }[] = []
    const consoleDiagnostics: { type: string; text: string }[] = []
    const samples: Awaited<ReturnType<typeof historyViewport>>[] = []
    const pauses: { delta: number; samples: Awaited<ReturnType<typeof historyViewport>>[] }[] = []
    const remountPause = {
      delta: -600,
      preparation: [] as Awaited<ReturnType<typeof historyViewport>>[],
      samples: [] as Awaited<ReturnType<typeof historyViewport>>[],
    }
    let olderPageRequests = 0
    page.on('pageerror', (error) => errors.push(error.message))
    if (reverse) {
      page.on('request', (request) => {
        if (request.resourceType() === 'script') scriptAssetPaths.push(new URL(request.url()).pathname)
      })
      page.on('response', (response) => {
        if (response.request().resourceType() === 'script' && response.ok()) {
          scriptAssetResponses.push({
            url: response.url(),
            path: new URL(response.url()).pathname,
            status: response.status(),
          })
        }
      })
      page.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') {
          consoleDiagnostics.push({ type: message.type(), text: message.text() })
        }
      })
    }
    await page.setViewportSize({ width: 1721, height: 1271 })
    const cdp = await page.context().newCDPSession(page)
    await page.route(`**/api/v1/chats/${RESIDENCY_CHAT_ID}/messages?*`, async (route) => {
      if (new URL(route.request().url()).searchParams.has('start')) {
        olderPageRequests++
        if (pageDelay) await new Promise((resolve) => setTimeout(resolve, pageDelay))
      }
      await route.continue()
    })
    try {
      await page.goto(`${harness.baseUrl}/character/${RESIDENCY_CHARACTER_ID}/${RESIDENCY_CHAT_ID}`)
      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__?.isLoaded() ?? false), {
          timeout: 30_000,
        })
        .toBe(true)
      await expect(page.locator('[data-risu-message-id="residency-message-299"] .chat-message-body')).toContainText(
        'History message 299.',
      )
      await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 10_000),
      )
      await expect(page.locator('[data-transcript-window-rows]')).toHaveAttribute('aria-busy', 'false')
      await expect
        .poll(() =>
          page
            .locator('[data-transcript-row-id] .chat-message-body')
            .evaluateAll(
              (bodies) => bodies.length === 30 && bodies.every((body) => body.textContent?.includes('History message')),
            ),
        )
        .toBe(true)
      expect((await historyViewport(page)).windowRows).toBe(30)
      const bounds = (await page.locator(TRANSCRIPT).boundingBox())!
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)

      let anchoredPauses = 0
      for (const pass of reverse ? [0, 1] : []) {
        if (pass === 1) {
          const remountedMessage = page.locator('.risu-chat[data-risu-message-id="residency-message-298"]')
          await expect(remountedMessage, 'previously readable ordinary row is unmounted').toHaveCount(0)
          // Remount the same previously readable row with one fixed return gesture.
          await cdp.send('Input.synthesizeScrollGesture', {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            yDistance: -1_000_000,
            speed: 1_000_000,
            gestureSourceType: 'mouse',
          })
          // Await completion of the same fixed upward input before measuring a pause.
          await cdp.send('Input.synthesizeScrollGesture', {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            yDistance: 600,
            speed: 100_000,
            gestureSourceType: 'mouse',
            preventFling: true,
          })
          await expect(
            remountedMessage.locator('.chat-message-body'),
            'ordinary row is readable after remount',
          ).toContainText('History message 298.')
          await expect
            .poll(
              async () =>
                (await historyViewport(page)).visible.some((row) => row.id === 'residency-message-298' && row.readable),
              { message: 'ordinary row is visible after remount' },
            )
            .toBe(true)
          // This measured pause starts only after the existing real remount input
          // and an explicit first-geometric-row readiness precondition. Keep the
          // successful frame as sample zero; later samples cannot replace its ID.
          await expect
            .poll(
              async () => {
                const sample = await historyViewport(page)
                remountPause.preparation.push(sample)
                if (!sample.visible[0]?.readable) return false
                remountPause.samples.push(sample)
                return true
              },
              { message: 'first geometric row is readable before the remount pause', timeout: 5_000, intervals: [32] },
            )
            .toBe(true)
          const remountAnchor = remountPause.samples[0].visible[0]
          for (let frame = 1; frame < 30; frame++) {
            await page.waitForTimeout(32)
            remountPause.samples.push(await historyViewport(page))
          }
          const remountPositions = remountPause.samples.map((sample) =>
            sample.visible.find((row) => row.id === remountAnchor.id),
          )
          expect(
            remountPositions.every((row) => row?.readable),
            `message ${remountAnchor.index} stays visible during remount pause`,
          ).toBe(true)
          expect(
            Math.max(...remountPositions.map((row) => Math.abs(row!.top - remountAnchor.top))),
            `message ${remountAnchor.index} stays anchored during remount pause`,
          ).toBeLessThanOrEqual(1)
          anchoredPauses++
        }
        for (const delta of [-85_000, 35_000, -40_000, 25_000, -35_000, 30_000, -35_000]) {
          await cdp.send('Input.synthesizeScrollGesture', {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            yDistance: -delta,
            speed: 100_000,
            gestureSourceType: 'mouse',
          })
          const pause: Awaited<ReturnType<typeof historyViewport>>[] = []
          for (let frame = 0; frame < 30; frame++) {
            const sample = await historyViewport(page)
            pause.push(sample)
            await page.waitForTimeout(32)
          }
          pauses.push({ delta, samples: pause })
          const anchor = pause[0].visible[0]
          if (anchor?.readable) {
            anchoredPauses++
            const positions = pause.map((sample) => sample.visible.find((row) => row.id === anchor.id))
            expect(
              positions.every((row) => row?.readable),
              `message ${anchor.index} stays visible during pause`,
            ).toBe(true)
            expect(
              Math.max(...positions.map((row) => Math.abs(row!.top - anchor.top))),
              `message ${anchor.index} stays anchored`,
            ).toBeLessThanOrEqual(1)
          }
        }
      }
      samples.push(await historyViewport(page))

      // Real wheel input continues across page fetches and progressive row admission.
      // Never assign scrollTop or wait for each older page to finish rendering.
      for (let gesture = 0; gesture < 6; gesture++) {
        let scrolling = true
        await Promise.all([
          (async () => {
            const deliveries: Promise<unknown>[] = []
            let deliveryError: unknown
            for (let event = 0; event < 850; event++) {
              // Send on a free-wheel cadence without waiting for each browser
              // acknowledgement, which otherwise serializes input to frame rate.
              deliveries.push(
                cdp
                  .send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: bounds.x + bounds.width / 2,
                    y: bounds.y + bounds.height / 2,
                    deltaX: 0,
                    deltaY: -120,
                  })
                  .catch((error: unknown) => {
                    deliveryError ??= error
                  }),
              )
              await new Promise((resolve) => setTimeout(resolve, 6))
            }
            await Promise.all(deliveries)
            if (deliveryError) throw deliveryError
          })().finally(() => {
            scrolling = false
          }),
          (async () => {
            while (scrolling) {
              samples.push(await historyViewport(page))
              await page.waitForTimeout(32)
            }
          })(),
        ])
        if (samples.at(-1)!.visible.some((row) => row.index === 0 && row.readable)) break
      }
      expect(
        samples.at(-1)!.visible.some((row) => row.index === 0 && row.readable),
        'first message reached',
      ).toBe(true)
      expect(olderPageRequests).toBeGreaterThan(0)
      const reversals = samples.slice(1).flatMap((sample, index) => {
        const previous = samples[index]
        return sample.visible.flatMap((row) => {
          const before = previous.visible.find((candidate) => candidate.id === row.id && candidate.readable)
          return before && row.readable && row.top - before.top < -sample.clientHeight
            ? [{ index: row.index, delta: row.top - before.top, time: sample.time }]
            : []
        })
      })
      expect(reversals, 'readable messages never snap backward by a viewport during upward scrolling').toEqual([])
      await page.waitForTimeout(750)
      const settled = await historyViewport(page)
      samples.push(settled)
      expect(
        settled.visible.some((row) => row.index === 0 && row.readable),
        'first message remains visible',
      ).toBe(true)
      expect(settled.windowRows).toBe(MESSAGE_COUNT)
      expect(
        Math.max(
          ...[
            ...samples,
            ...pauses.flatMap((pause) => pause.samples),
            ...remountPause.preparation,
            ...remountPause.samples,
          ].map((sample) => sample.residentRows),
        ),
      ).toBeLessThanOrEqual(76)
      expect(errors).toEqual([])
      if (reverse) expect(anchoredPauses, 'readable rows exercised across pauses').toBeGreaterThan(0)
    } finally {
      const observations = testInfo.outputPath('history-scroll-observations.json')
      writeFileSync(
        observations,
        JSON.stringify({
          assets,
          pageDelay,
          olderPageRequests,
          errors,
          pauses,
          samples,
          ...(reverse ? { remountPause, scriptAssetPaths, scriptAssetResponses, consoleDiagnostics } : {}),
        }),
      )
      await testInfo.attach('history-scroll-observations', {
        path: observations,
        contentType: 'application/json',
      })
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('history-scroll-failure', { body: await page.screenshot(), contentType: 'image/png' })
      }
      await page.unrouteAll({ behavior: 'wait' })
      await page.close()
      await closeFastBootstrapHarness(harness)
    }
  })
}
