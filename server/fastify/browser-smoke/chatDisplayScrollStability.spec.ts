import { expect, test, type Page } from '@playwright/test'
import { gateDisplayStreamResults } from './displayStreamGate.js'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

test.use({ trace: 'off' })

const TRANSCRIPT = '[data-default-chat-transcript]'
const MESSAGE_COUNT = 18
const CRITICAL_MESSAGE_COUNT = 3
const WHEEL_STEP = 90
const ROW_MARKER = 'Deferred display row'
const STATIC_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

type ResponseMode = 'delayed-success' | 'handled-fallback'
type PagingMode = 'bounded' | 'legacy'

interface DeliveryGate {
  indexes: number[]
  released: boolean
  release(): void
}

interface ViewportRow {
  id: string
  top: number
  readable: boolean
  pending: boolean
}

interface ViewportFrame {
  scrollTop: number
  clientHeight: number
  rows: ViewportRow[]
  visible: ViewportRow[]
}

interface IdleAnchorSample {
  time: number
  phase: 'animation-frame' | 'after-frame' | 'mutation'
  top: number | null
  readable: boolean
  sameNode: boolean
}

for (const responseMode of ['delayed-success', 'handled-fallback'] as const satisfies readonly ResponseMode[]) {
  for (const pagingMode of ['bounded', 'legacy'] as const satisfies readonly PagingMode[]) {
    test(`${responseMode} display bodies preserve the active-scroll anchor in ${pagingMode} paging`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(180_000)
      const database = displayScrollFixture()
      const character = (
        database.characters as Array<{ chaId: string; chats: Array<{ id: string; message: unknown[] }> }>
      )[0]
      const chat = character.chats[0]
      const harness = await startFastBootstrapHarness(database)
      if (responseMode === 'handled-fallback')
        makeSelectedCharacterDisplayIncompatible(harness.dataDir, character.chaId)

      const blocked: DeliveryGate[] = []
      const deliveredDuringGesture: number[][] = []
      const responseEntries: Array<{ status: string; reason?: string }> = []
      const errors: string[] = []
      let releaseImmediately = false
      let gestureActive = false
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript((legacy) => {
        if (legacy) localStorage.setItem('risu-transcript-legacy-paging', '1')
      }, pagingMode === 'legacy')
      await page.setViewportSize({ width: 390, height: 844 })
      await gateDisplayStreamResults(page, async (result) => {
        const indexes = [result.index]
        const background = !result.priority
        responseEntries.push({ status: result.status, reason: result.reason })
        if (background && !releaseImmediately) {
          let release!: () => void
          const held = new Promise<void>((resolve) => {
            release = resolve
          })
          const gate: DeliveryGate = {
            indexes,
            released: false,
            release() {
              if (gate.released) return
              gate.released = true
              release()
            },
          }
          blocked.push(gate)
          await held
        }
        if (background && gestureActive) deliveredDuringGesture.push(indexes)
      })

      try {
        await page.goto(`${harness.baseUrl}/character/${character.chaId}/${chat.id}`)
        await expect(
          page.locator(`[data-risu-message-id="display-scroll-${MESSAGE_COUNT - 1}"] .chat-message-body`),
        ).toContainText(`${ROW_MARKER} ${MESSAGE_COUNT - 1}.`)
        await page.evaluate(() =>
          window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 10_000),
        )
        await expect.poll(() => blocked.filter((gate) => !gate.released).length).toBeGreaterThan(0)
        await expect(page.locator('[data-transcript-pending-geometry]').first()).toBeAttached()

        const bounds = await page.locator(TRANSCRIPT).boundingBox()
        if (!bounds) throw new Error('Display-scroll transcript did not expose browser geometry')
        const cdp = await page.context().newCDPSession(page)
        const frames: ViewportFrame[] = []
        gestureActive = true
        try {
          await Promise.all([
            (async () => {
              for (let event = 0; event < 180; event++) {
                await cdp.send('Input.dispatchMouseEvent', {
                  type: 'mouseWheel',
                  x: bounds.x + bounds.width / 2,
                  y: bounds.y + bounds.height / 2,
                  deltaX: 0,
                  deltaY: -WHEEL_STEP,
                })
                await page.waitForTimeout(8)
                // Sample each wheel frame before dispatching the next step.
                // An independent timer can miss several valid 90px steps under
                // concurrent browser load and mistake their sum for a jump.
                await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
                frames.push(await displayViewport(page))
              }
            })().finally(() => {
              gestureActive = false
            }),
            (async () => {
              for (let delivery = 0; delivery < 6; delivery++) {
                // Let scrolling move past queued rows before their serialized
                // replies arrive, leaving unfinished newer rows below the
                // eventual reading position as in the production trace.
                await page.waitForTimeout(delivery === 0 ? 1_500 : 150)
                await expect
                  .poll(() => blocked.filter((gate) => !gate.released).length, { timeout: 20_000 })
                  .toBeGreaterThan(0)
                blocked.find((gate) => !gate.released)!.release()
                await expect.poll(() => deliveredDuringGesture.length, { timeout: 20_000 }).toBeGreaterThan(delivery)
              }
            })(),
          ])
        } finally {
          gestureActive = false
          await cdp.detach()
        }

        expect(deliveredDuringGesture.length).toBeGreaterThanOrEqual(6)
        assertContinuousVisibleRows(frames)
        let afterGesture = await displayViewport(page)
        let anchor = afterGesture.visible.find((row) => row.readable && !row.pending)
        // A fast gesture can reach an older placeholder before its prioritized
        // parse runs. Let that visible row become readable while keeping the
        // skipped newer rows pending below it.
        for (let promotion = 0; !anchor && promotion < 3; promotion++) {
          await expect.poll(() => blocked.some((gate) => !gate.released)).toBe(true)
          const visibleIndexes = new Set(afterGesture.visible.map((row) => Number(row.id.split('-').at(-1))))
          const gate =
            blocked.find((gate) => !gate.released && gate.indexes.some((index) => visibleIndexes.has(index))) ??
            blocked.find((gate) => !gate.released)!
          gate.release()
          for (const index of gate.indexes) {
            await expect(
              page.locator(`[data-risu-message-id="display-scroll-${index}"] .chat-message-body`),
            ).toContainText(`${ROW_MARKER} ${index}.`)
          }
          afterGesture = await displayViewport(page)
          anchor = afterGesture.visible.find((row) => row.readable && !row.pending)
        }
        expect(anchor, 'a stable readable row remains visible when the gesture ends').toBeDefined()

        // Production continued receiving sequential first-body results after the
        // interaction grace expired. Sample the frames between these late
        // commits and residency correction, not just the settled viewport.
        await page.waitForTimeout(1_800)
        const lateIndexes = await page
          .locator('[data-transcript-pending-geometry]')
          .evaluateAll((rows) =>
            rows.map((row) =>
              Number(
                row.querySelector<HTMLElement>('[data-risu-message-id]')?.dataset.risuMessageId?.split('-').at(-1),
              ),
            ),
          )
        expect(
          lateIndexes.some((index) => index > Number(anchor!.id.split('-').at(-1))),
          `late bodies ${lateIndexes.join(',')} include a row newer than anchor ${anchor!.id}`,
        ).toBe(true)
        await startIdleAnchorSampling(page, anchor!.id)

        releaseImmediately = true
        blocked.forEach((gate) => gate.release())
        await expect
          .poll(
            () =>
              page
                .locator(`[data-risu-message-id^="display-scroll-"] .chat-message-body`)
                .evaluateAll(
                  (bodies, marker) => bodies.filter((body) => body.textContent?.includes(marker as string)).length,
                  ROW_MARKER,
                ),
            { timeout: 30_000 },
          )
          .toBe(MESSAGE_COUNT)
        await expect(page.locator('[data-display-scroll-card]')).toHaveCount(MESSAGE_COUNT)
        const images = page.locator('img[alt^="Deferred display image"]')
        await expect(images).toHaveCount(MESSAGE_COUNT / 2)
        await expect
          .poll(() => images.evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).complete)))
          .toBe(true)
        await page.waitForTimeout(200)
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        )

        const settled = await displayViewport(page)
        const idleSamples = await stopIdleAnchorSampling(page)
        await testInfo.attach('late-display-anchor-frames', {
          body: JSON.stringify(idleSamples),
          contentType: 'application/json',
        })
        expect(idleSamples.length).toBeGreaterThan(10)
        for (const sample of idleSamples) {
          expect(sample.sameNode, `${sample.phase} at ${sample.time}ms retains the readable anchor node`).toBe(true)
          expect(sample.readable, `${sample.phase} at ${sample.time}ms retains the anchor body`).toBe(true)
          expect(sample.top, `${sample.phase} at ${sample.time}ms keeps the anchor mounted`).not.toBeNull()
          expect(
            Math.abs(sample.top! - anchor!.top),
            `${sample.phase} at ${sample.time}ms preserves the anchor through late body commits`,
          ).toBeLessThanOrEqual(1)
        }
        const settledAnchor = settled.visible.find((row) => row.id === anchor!.id)
        expect(settledAnchor?.readable, `anchor ${anchor!.id} stays readable after idle flushing`).toBe(true)
        expect(
          Math.abs(settledAnchor!.top - anchor!.top),
          `anchor ${anchor!.id} viewport displacement`,
        ).toBeLessThanOrEqual(1)
        const backgroundEntries = responseEntries.slice(CRITICAL_MESSAGE_COUNT)
        expect(backgroundEntries.length).toBeGreaterThanOrEqual(6)
        if (responseMode === 'delayed-success') {
          expect(responseEntries.every((entry) => entry.status === 'ok')).toBe(true)
        } else {
          expect(
            responseEntries.every(
              (entry) => entry.status === 'client_fallback' && entry.reason === 'scope_input_incompatible',
            ),
          ).toBe(true)
        }
        expect(errors).toEqual([])
      } finally {
        gestureActive = false
        releaseImmediately = true
        blocked.forEach((gate) => gate.release())
        await page.context().close()
        await closeFastBootstrapHarness(harness)
      }
    })
  }
}

async function startIdleAnchorSampling(page: Page, id: string): Promise<void> {
  await page.evaluate(
    ({ selector, id, marker }) => {
      const transcript = document.querySelector<HTMLElement>(selector)!
      const rowSelector = `.risu-chat[data-risu-message-id="${CSS.escape(id)}"]`
      const original = transcript.querySelector<HTMLElement>(rowSelector)
      const samples: IdleAnchorSample[] = []
      const started = performance.now()
      let frame = 0
      let stopped = false
      const timers = new Set<ReturnType<typeof setTimeout>>()
      const sample = (phase: IdleAnchorSample['phase']) => {
        if (stopped) return
        const row = transcript.querySelector<HTMLElement>(rowSelector)
        samples.push({
          time: performance.now() - started,
          phase,
          top: row ? row.getBoundingClientRect().top - transcript.getBoundingClientRect().top : null,
          readable: row?.querySelector('.chat-message-body')?.textContent?.includes(marker) ?? false,
          sameNode: row !== null && row === original,
        })
      }
      const nextFrame = () => {
        sample('animation-frame')
        const timer = setTimeout(() => {
          timers.delete(timer)
          sample('after-frame')
        }, 0)
        timers.add(timer)
        frame = requestAnimationFrame(nextFrame)
      }
      const observer = new MutationObserver(() => sample('mutation'))
      observer.observe(transcript, { childList: true, subtree: true, attributes: true, characterData: true })
      frame = requestAnimationFrame(nextFrame)
      Object.assign(window, {
        __lateDisplayAnchor: {
          stop() {
            stopped = true
            cancelAnimationFrame(frame)
            timers.forEach(clearTimeout)
            observer.disconnect()
            return samples
          },
        },
      })
    },
    { selector: TRANSCRIPT, id, marker: ROW_MARKER },
  )
}

async function stopIdleAnchorSampling(page: Page): Promise<IdleAnchorSample[]> {
  return page.evaluate(() => {
    const runtime = window as typeof window & { __lateDisplayAnchor?: { stop(): IdleAnchorSample[] } }
    const samples = runtime.__lateDisplayAnchor!.stop()
    delete runtime.__lateDisplayAnchor
    return samples
  })
}

function displayScrollFixture(): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  const character = (
    database.characters as Array<{ chats: Array<{ message: Array<{ chatId: string; role: string; data: string }> }> }>
  )[0]
  character.chats[0].message = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    chatId: `display-scroll-${index}`,
    role: index % 2 ? 'char' : 'user',
    data: [
      `${ROW_MARKER} ${index}.`,
      `<div data-display-scroll-card="${index}" style="height:${420 + (index % 3) * 160}px">Tall custom card ${index}</div>`,
      index % 2 === 0
        ? `<img alt="Deferred display image ${index}" src="${STATIC_IMAGE}" loading="eager" width="240" height="180">`
        : '',
      'Wrapped display text. '.repeat(18),
    ]
      .filter(Boolean)
      .join('\n\n'),
  }))
  Object.assign(database, {
    chatLoadInitialPages: MESSAGE_COUNT,
    chatLoadAdditionalPages: 6,
  })
  return database
}

function makeSelectedCharacterDisplayIncompatible(dataDir: string, characterId: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    const row = db.prepare('SELECT data_json FROM characters WHERE id = ?').get(characterId) as {
      data_json: string
    }
    const character = JSON.parse(row.data_json) as Record<string, unknown>
    character.customscript = [{ in: 'never', out: 'never', type: { incompatible: true } }]
    db.prepare('UPDATE characters SET data_json = ? WHERE id = ?').run(JSON.stringify(character), characterId)
  } finally {
    db.close()
  }
}

function displayResponseEntries(value: unknown): Array<{ status: string; reason?: string }> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { entries?: unknown }).entries)) return []
  return (value as { entries: unknown[] }).entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as { status?: unknown }).status !== 'string') return []
    const status = (entry as { status: string }).status
    const reason = (entry as { reason?: unknown }).reason
    return [{ status, ...(typeof reason === 'string' ? { reason } : {}) }]
  })
}

async function displayViewport(page: Page): Promise<ViewportFrame> {
  return page.locator(TRANSCRIPT).evaluate((transcript, marker) => {
    const viewport = transcript.getBoundingClientRect()
    const measured = Array.from(transcript.querySelectorAll<HTMLElement>('.risu-chat[data-risu-message-id]')).map(
      (row) => {
        const rect = row.getBoundingClientRect()
        const wrapper = row.closest<HTMLElement>('[data-transcript-row-id]')
        return {
          id: row.dataset.risuMessageId!,
          top: rect.top - viewport.top,
          bottom: rect.bottom - viewport.top,
          readable: row.querySelector('.chat-message-body')?.textContent?.includes(marker as string) ?? false,
          pending: wrapper?.hasAttribute('data-transcript-pending-geometry') ?? false,
        }
      },
    )
    const visible = measured
      .filter((row) => row.bottom > 0 && row.top < viewport.height)
      .sort((left, right) => left.top - right.top)
      .map(({ bottom: _bottom, ...row }) => row)
    return {
      scrollTop: transcript.scrollTop,
      clientHeight: transcript.clientHeight,
      rows: measured.map(({ bottom: _bottom, ...row }) => row),
      visible,
    }
  }, ROW_MARKER)
}

function assertContinuousVisibleRows(frames: readonly ViewportFrame[]): void {
  expect(frames.length).toBeGreaterThan(10)
  const comparisons = frames.slice(1).flatMap((frame, index) => {
    const previous = frames[index]
    const overlap = frame.visible.filter((row) => previous.visible.some((candidate) => candidate.id === row.id))
    return previous.visible.length > 0 && frame.visible.length > 0 ? [{ frame: index + 1, overlap }] : []
  })
  expect(comparisons.length).toBeGreaterThan(10)
  let readableComparisons = 0
  for (const comparison of comparisons) {
    expect(comparison.overlap.length, `frame ${comparison.frame} retains a visible row identity`).toBeGreaterThan(0)
    // A pending card can grow upward on its first render while the readable
    // row below it stays fixed. Track already-readable rows that this wheel
    // step should leave visible, not expanding placeholders or rows the user
    // intentionally scrolls out. Look them up among all mounted rows so an
    // unexpected displacement outside the viewport cannot evade the check.
    const previous = frames[comparison.frame - 1]
    const next = frames[comparison.frame]
    for (const before of previous.visible.filter(
      (row) => row.readable && !row.pending && row.top + WHEEL_STEP < previous.clientHeight,
    )) {
      readableComparisons++
      const after = next.rows.find((row) => row.id === before.id)
      expect(after?.readable, `frame ${comparison.frame} retains readable row ${before.id}`).toBe(true)
      expect(after?.pending, `frame ${comparison.frame} does not replace readable row ${before.id}`).toBe(false)
      expect(
        Math.abs(after!.top - before.top),
        `frame ${comparison.frame} readable-row displacement: ${JSON.stringify({ before, after })}`,
      ).toBeLessThanOrEqual(240)
    }
  }
  expect(readableComparisons, 'active input exercises already-readable row positions').toBeGreaterThan(10)
}
