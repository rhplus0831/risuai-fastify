import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

let harness: FastBootstrapHarness
test.setTimeout(90_000)
test.beforeEach(async () => {
  harness = await startFastBootstrapHarness({
    ...smallFastBootstrapFixture(),
    showMemoryLimit: false,
    showSavingIcon: true,
  })
})
test.afterEach(async ({ page }) => {
  await page.context().close()
  await closeFastBootstrapHarness(harness)
})

const commandPath = '**/api/v1/commands/settings/display'
const ackPath = '**/api/v1/commands/mutation-receipts/ack'
const toggle = (page: Page) => page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true })
const lifecycle = (page: Page) => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot())

async function bootDisplay(page: Page, reload = false) {
  if (reload) await page.reload({ waitUntil: 'domcontentloaded' })
  else await page.goto(`${harness.baseUrl}/settings/display`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__RISU_FASTIFY_BROWSER_SMOKE__)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000))
  await page.getByRole('button', { name: 'Chat appearance', exact: true }).click()
  await expect(toggle(page)).toBeEnabled()
}

async function flip(page: Page) {
  await toggle(page).focus()
  await toggle(page).press('Space')
}

function truth() {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    const settings = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    return {
      value: JSON.parse(settings.data_json).showMemoryLimit as boolean,
      revision: (db.prepare('SELECT revision FROM schema_version WHERE id = 1').get() as { revision: number }).revision,
      events: db.prepare('SELECT revision FROM command_events ORDER BY revision').all(),
      receipts: db
        .prepare('SELECT mutation_id, acknowledged_at FROM command_mutation_receipts ORDER BY mutation_id')
        .all(),
    }
  } finally {
    db.close()
  }
}

for (const fault of ['lost-after-commit', 'malformed-after-commit', 'before-acceptance'] as const) {
  test(`a visible settings edit stays queued after ${fault} and replays once despite failed receipt acknowledgement`, async ({
    page,
  }) => {
    await bootDisplay(page)
    const before = truth()
    let faulting = true
    let first = true
    const ids: string[] = []
    await page.route(commandPath, async (route) => {
      ids.push(route.request().headers()['risu-mutation-id'] ?? '')
      if (!faulting) return route.continue()
      if (!first || fault === 'before-acceptance') return route.abort('connectionclosed')
      first = false
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      if (fault === 'malformed-after-commit')
        return route.fulfill({ response, body: '{broken receipt', contentType: 'application/json' })
      await route.abort('connectionclosed')
    })
    await flip(page)
    await expect(toggle(page)).toBeChecked()
    await expect.poll(async () => (await lifecycle(page)).outbox.length).toBe(1)
    await expect(page.locator('.saving-animation')).toBeVisible()
    expect(truth().revision).toBe(before.revision + (fault === 'before-acceptance' ? 0 : 1))
    const id = (await lifecycle(page)).outbox[0]!.mutationId
    let failAck = true
    await page.route(ackPath, (route) =>
      failAck
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"injected acknowledgement failure"}',
          })
        : route.continue(),
    )
    faulting = false
    await bootDisplay(page, true)
    await expect(toggle(page)).toBeChecked()
    await expect.poll(async () => (await lifecycle(page)).outbox.length).toBe(0)
    await expect.poll(async () => (await lifecycle(page)).receiptAcknowledgements.length).toBe(1)
    await expect(page.locator('.saving-animation')).toHaveCount(0)
    expect(new Set(ids)).toEqual(new Set([id]))
    expect(ids.length).toBeGreaterThanOrEqual(2)
    const accepted = truth()
    expect(accepted.value).toBe(true)
    expect(accepted.revision).toBe(before.revision + 1)
    expect(accepted.events.length).toBe(before.events.length + 1)
    expect(accepted.receipts).toEqual([{ mutation_id: id, acknowledged_at: null }])
    failAck = false
    await bootDisplay(page, true)
    await expect(toggle(page)).toBeChecked()
    await expect.poll(() => lifecycle(page)).toMatchObject({ outbox: [], receiptAcknowledgements: [] })
    expect(truth().revision).toBe(accepted.revision)
    expect(truth().receipts[0]?.acknowledged_at).toEqual(expect.any(String))
  })
}

test('failed local staging plus failed transport rolls back the visible setting and reports failure', async ({
  page,
}) => {
  await bootDisplay(page)
  const before = truth()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'mutations') throw new DOMException('Injected staging failure', 'QuotaExceededError')
      return put.call(this, value, key)
    }
  })
  const receiptHeaders: Array<string | undefined> = []
  await page.route(commandPath, (route) => {
    receiptHeaders.push(route.request().headers()['risu-mutation-id'])
    return route.abort('connectionclosed')
  })
  await flip(page)
  await expect.poll(() => receiptHeaders.length).toBe(1)
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page.getByRole('alertdialog')).toContainText(/network|save|persist/i)
  await page.getByRole('alertdialog').getByRole('button', { name: 'OK', exact: true }).click()
  await expect(toggle(page)).not.toBeChecked()
  await expect.poll(() => lifecycle(page)).toMatchObject({ outbox: [], receiptAcknowledgements: [] })
  expect(receiptHeaders).toEqual([undefined])
  expect(truth()).toEqual(before)
})

test('a held committed receipt acknowledgement releases the queue for a newer visible edit', async ({ page }) => {
  await bootDisplay(page)
  const before = truth()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  let reached = false
  await page.route(ackPath, async (route) => {
    if (held) return route.continue()
    held = true
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    reached = true
    await gate
    await route.fulfill({ response }).catch(() => undefined)
  })
  try {
    await flip(page)
    await expect.poll(() => reached).toBe(true)
    await expect(toggle(page)).toBeChecked()
    await flip(page)
    await expect(toggle(page)).not.toBeChecked()
    await expect
      .poll(async () => ({
        state: (await lifecycle(page)).outbox,
        value: await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().showMemoryLimit),
      }))
      .toMatchObject({ state: [expect.anything()], value: false })
    await expect.poll(() => truth().revision, { timeout: 40_000 }).toBe(before.revision + 2)
    await expect.poll(async () => (await lifecycle(page)).outbox.length).toBe(0)
    await expect(page.locator('.saving-animation')).toHaveCount(0)
    expect(truth().value).toBe(false)
    const settledRevision = truth().revision
    release()
    await bootDisplay(page, true)
    await expect(toggle(page)).not.toBeChecked()
    await expect.poll(() => lifecycle(page)).toMatchObject({ outbox: [], receiptAcknowledgements: [] })
    expect(truth().revision).toBe(settledRevision)
  } finally {
    release()
  }
})

interface EventDeliveryControl {
  hold: boolean
  received: string
  delivered: string
  release: () => void
}
type DeliveryWindow = typeof window & { __phase03Events: EventDeliveryControl }

async function installEventDeliveryControl(page: Page) {
  await page.addInitScript(() => {
    const control: EventDeliveryControl = { hold: false, received: '', delivered: '', release: () => {} }
    ;(window as DeliveryWindow).__phase03Events = control
    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await nativeFetch(input, init)
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.pathname !== '/api/v1/events' || !response.ok || !response.body) return response
      const reader = response.body.getReader()
      const incoming = new TextDecoder()
      const outgoing = new TextDecoder()
      const held: Uint8Array[] = []
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const deliver = (value: Uint8Array) => {
            control.delivered += outgoing.decode(value, { stream: true })
            controller.enqueue(value)
          }
          control.release = () => {
            control.hold = false
            for (const value of held.splice(0)) deliver(value)
          }
          try {
            while (true) {
              const { value, done } = await reader.read()
              if (done) {
                controller.close()
                return
              }
              control.received += incoming.decode(value, { stream: true })
              if (control.hold) held.push(value)
              else deliver(value)
            }
          } catch (error) {
            controller.error(error)
          }
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      })
      return new Response(body, { status: response.status, headers: response.headers })
    }
  })
}

for (const order of ['SSE-before-HTTP', 'HTTP-before-SSE'] as const) {
  test(`the visible setting settles with ${order} without applying the echo twice`, async ({ page }) => {
    await installEventDeliveryControl(page)
    await bootDisplay(page)
    const before = truth()
    await page.evaluate((hold) => {
      const events = (window as DeliveryWindow).__phase03Events
      events.received = ''
      events.delivered = ''
      events.hold = hold
    }, order === 'HTTP-before-SSE')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let commandResponses = 0
    await page.route(commandPath, async (route) => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      commandResponses++
      if (order === 'SSE-before-HTTP') await gate
      await route.fulfill({ response })
    })
    try {
      await flip(page)
      await expect.poll(() => commandResponses).toBe(1)
      await expect
        .poll(() => page.evaluate(() => (window as DeliveryWindow).__phase03Events.received.includes('event: command')))
        .toBe(true)
      if (order === 'SSE-before-HTTP') {
        expect(
          await page.evaluate(() => (window as DeliveryWindow).__phase03Events.delivered.includes('event: command')),
        ).toBe(true)
        await expect.poll(async () => (await lifecycle(page)).outbox.length).toBe(1)
        await expect(page.locator('.saving-animation')).toBeVisible()
        release()
      } else {
        await expect.poll(() => lifecycle(page)).toMatchObject({ outbox: [], receiptAcknowledgements: [] })
        await expect(page.locator('.saving-animation')).toHaveCount(0)
        expect(
          await page.evaluate(() => (window as DeliveryWindow).__phase03Events.delivered.includes('event: command')),
        ).toBe(false)
        await page.evaluate(() => (window as DeliveryWindow).__phase03Events.release())
      }
      await expect(toggle(page)).toBeChecked()
      await expect.poll(() => lifecycle(page)).toMatchObject({ outbox: [], receiptAcknowledgements: [] })
      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()))
        .toBe(before.revision + 1)
      await expect(page.locator('.saving-animation')).toHaveCount(0)
      expect(truth().value).toBe(true)
      expect(truth().revision).toBe(before.revision + 1)
      expect(truth().events.length).toBe(before.events.length + 1)
      expect(commandResponses).toBe(1)
    } finally {
      release()
    }
  })
}

test('a visible queued edit converges after a real revision gap and reload replay', async ({ page }) => {
  await installEventDeliveryControl(page)
  await bootDisplay(page)
  const before = truth()
  await page.evaluate(() => {
    ;(window as DeliveryWindow).__phase03Events.hold = true
  })
  const headers = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders())
  const advanced = await harness.app.inject({
    method: 'PATCH',
    url: '/api/v1/commands/settings/runtime',
    headers,
    payload: { baseRevision: before.revision, patch: { streamGeminiThoughts: true } },
  })
  expect(advanced.statusCode).toBe(200)
  const statuses: number[] = []
  let settingsRefreshes = 0
  page.on('request', (request) => {
    // Encrypted resource reads use POST; a conflict gap requests the full settings snapshot.
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/settings') settingsRefreshes++
  })
  await page.route(commandPath, async (route) => {
    const response = await route.fetch()
    statuses.push(response.status())
    await route.fulfill({ response })
  })
  await flip(page)
  await expect.poll(() => statuses).toEqual([409])
  await expect(toggle(page)).toBeChecked()
  await expect.poll(() => settingsRefreshes).toBeGreaterThan(0)
  expect(truth().revision).toBe(before.revision + 1)
  await bootDisplay(page, true)
  await expect(toggle(page)).toBeChecked()
  await expect.poll(() => lifecycle(page)).toMatchObject({ outbox: [], receiptAcknowledgements: [] })
  expect(statuses).toEqual([409, 200])
  expect(truth().revision).toBe(before.revision + 2)
  expect(truth().events.length).toBe(before.events.length + 2)
  expect(truth().value).toBe(true)
})
