/** @module-tag core */

import { expect, test, type Page, type Route } from '@playwright/test'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'
import { readNativeRolloutOutbox } from './connectedReaderRolloutHarness.js'

const CHARACTER_ID = 'fast-bootstrap-small-character'
const CHAT_ID = 'fast-bootstrap-small-chat'
const CHARACTER_ROUTE = `/character/${CHARACTER_ID}/${CHAT_ID}`

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(name: string): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  const character = (database.characters as Array<Record<string, unknown>>)[0]!
  character.name = name
  character.chats = [
    {
      id: CHAT_ID,
      name: 'Browser ownership chat',
      note: '',
      localLore: [],
      message: [{ chatId: 'browser-ownership-message', role: 'char', data: 'Browser ownership transcript' }],
    },
  ]
  return database
}

async function bootWriter(page: Page, harness: FastBootstrapHarness, route = CHARACTER_ROUTE): Promise<void> {
  await page.goto(harness.baseUrl + route, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000))
}

async function bootReader(page: Page, harness: FastBootstrapHarness): Promise<void> {
  await page.goto(harness.baseUrl + CHARACTER_ROUTE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()))
    .toMatchObject({ lifecycle: 'reading', connection: 'live', projectionReady: true })
}

async function writerHeaders(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders())
}

function durableState(harness: FastBootstrapHarness): {
  lineage: string
  revision: number
  characterName: string
  settings: Record<string, unknown>
} {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    const ownership = db.prepare('SELECT lineage FROM database_metadata WHERE id = 1').get() as { lineage: string }
    const schema = db.prepare('SELECT revision FROM schema_version WHERE id = 1').get() as { revision: number }
    const character = db.prepare('SELECT data_json FROM characters WHERE id = ?').get(CHARACTER_ID) as {
      data_json: string
    }
    const settings = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    return {
      lineage: ownership.lineage,
      revision: schema.revision,
      characterName: (JSON.parse(character.data_json) as { name: string }).name,
      settings: JSON.parse(settings.data_json) as Record<string, unknown>,
    }
  } finally {
    db.close()
  }
}

async function patchCharacterName(
  harness: FastBootstrapHarness,
  headers: Record<string, string>,
  baseRevision: number,
  name: string,
) {
  const response = await harness.app.inject({
    method: 'PATCH',
    url: `/api/v1/commands/characters/${CHARACTER_ID}`,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: { baseRevision, patch: { name } },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json<{ revision: number }>()
}

function isProjectionRead(route: Route): boolean {
  const pathname = new URL(route.request().url()).pathname
  return (
    pathname === '/api/v1/settings' ||
    pathname === '/api/v1/collections' ||
    pathname === '/api/v1/characters' ||
    pathname === '/api/v1/inlay-assets'
  )
}

test(
  'a connected reader discards an old-lineage projection before rendering replacement updates',
  { tag: '@core' },
  async ({ browser }) => {
    test.setTimeout(60_000)
    const restoredName = 'RESTORED-LINEAGE-BASELINE'
    const oldLineageName = 'OLD-LINEAGE-LIVE'
    const newLineageName = 'NEW-LINEAGE-AUTHORITATIVE'
    const harness = await startFastBootstrapHarness(fixture(restoredName), {
      temporaryDirectoryPrefix: 'risu-core-lineage-reader-',
    })
    const writerContext = await browser.newContext()
    const readerContext = await browser.newContext()
    const writer = await writerContext.newPage()
    const reader = await readerContext.newPage()
    const projectionRelease = deferred()
    const projectionStarted = deferred()
    let holdProjectionReads = false

    try {
      await bootWriter(writer, harness)
      await bootReader(reader, harness)
      await expect(reader.getByText(restoredName, { exact: true }).first()).toBeVisible()

      const headers = await writerHeaders(writer)
      const backup = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers,
        payload: { label: 'reader lineage baseline' },
      })
      expect(backup.statusCode, backup.body).toBe(201)
      const backupId = backup.json<{ id: string }>().id
      const beforeOldWrite = durableState(harness)
      const oldWrite = await patchCharacterName(harness, headers, beforeOldWrite.revision, oldLineageName)
      await expect
        .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()))
        .toBe(oldWrite.revision)
      await expect(reader.getByText(oldLineageName, { exact: true }).first()).toBeVisible()

      const reportedBeforeRestore = await reader.evaluate(async () => {
        const response = await fetch('/api/v1/ownership', {
          headers: await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders(),
        })
        return { status: response.status, body: await response.json() }
      })
      expect(reportedBeforeRestore).toMatchObject({
        status: 200,
        body: { databaseLineage: beforeOldWrite.lineage },
      })

      await readerContext.setOffline(true)
      await expect(reader.locator('[data-reader-lifecycle-status]')).toContainText('Connection interrupted')
      const restored = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/backups/${backupId}/restore`,
        headers,
      })
      expect(restored.statusCode, restored.body).toBe(200)
      const restoredBody = restored.json<{ databaseLineage: string; revision: number }>()
      expect(restoredBody.databaseLineage).not.toBe(beforeOldWrite.lineage)
      expect(durableState(harness)).toMatchObject({
        lineage: restoredBody.databaseLineage,
        revision: restoredBody.revision,
        characterName: restoredName,
      })

      await reader.route('**/api/v1/**', async (route) => {
        if (!holdProjectionReads || !isProjectionRead(route)) return route.continue()
        projectionStarted.resolve()
        await projectionRelease.promise
        await route.continue()
      })
      holdProjectionReads = true
      const ownershipResponsePromise = reader.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/v1/ownership',
        { timeout: 15_000 },
      )
      await readerContext.setOffline(false)
      const ownershipResponse = await ownershipResponsePromise
      expect(ownershipResponse.status()).toBe(200)
      expect(await ownershipResponse.json()).toMatchObject({ databaseLineage: restoredBody.databaseLineage })
      await Promise.race([projectionStarted.promise, reader.waitForTimeout(5_000)])

      holdProjectionReads = false
      projectionRelease.resolve()
      await expect(reader.getByText(restoredName, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
      await expect(reader.getByText(oldLineageName, { exact: true })).toHaveCount(0)
      await reader.evaluate((oldName) => {
        const state = window as typeof window & {
          __oldLineageRepaints?: number
          __oldLineageObserver?: MutationObserver
        }
        state.__oldLineageRepaints = 0
        state.__oldLineageObserver = new MutationObserver(() => {
          if (document.body.innerText.includes(oldName))
            state.__oldLineageRepaints = (state.__oldLineageRepaints ?? 0) + 1
        })
        state.__oldLineageObserver.observe(document.body, { childList: true, characterData: true, subtree: true })
      }, oldLineageName)
      const afterRestore = durableState(harness)
      const newWrite = await patchCharacterName(harness, headers, afterRestore.revision, newLineageName)
      await expect
        .poll(() => reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()))
        .toBe(newWrite.revision)
      await expect(reader.getByText(newLineageName, { exact: true }).first()).toBeVisible()
      await expect(reader.getByText(oldLineageName, { exact: true })).toHaveCount(0)
      expect(
        await reader.evaluate(() => (window as typeof window & { __oldLineageRepaints?: number }).__oldLineageRepaints),
      ).toBe(0)
      expect(durableState(harness)).toMatchObject({
        lineage: restoredBody.databaseLineage,
        characterName: newLineageName,
      })
    } finally {
      projectionRelease.resolve()
      await readerContext.setOffline(false).catch(() => undefined)
      await readerContext.close().catch(() => undefined)
      await writerContext.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  },
)

test(
  'a writer restore rejects its old-lineage settings cache and paints the restored value without reload',
  { tag: '@core' },
  async ({ browser }) => {
    test.setTimeout(60_000)
    const database = fixture('WRITER-CACHE-CHARACTER')
    database.showMemoryLimit = true
    const harness = await startFastBootstrapHarness(database, {
      temporaryDirectoryPrefix: 'risu-core-lineage-writer-cache-',
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    let restoreStarted = false
    let replacementSettingsSeen = false
    let advertisedOldLineageHashes: string[] = []

    try {
      await bootWriter(page, harness, '/settings/display')
      await page.getByRole('button', { name: 'Chat appearance', exact: true }).click()
      const checkbox = page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true })
      await expect(checkbox).toBeChecked()
      const headers = await writerHeaders(page)
      const backup = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers,
        payload: { label: 'writer cache baseline' },
      })
      expect(backup.statusCode, backup.body).toBe(201)

      const changed = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === '/api/v1/commands/settings/display',
      )
      await checkbox.focus()
      await checkbox.press('Space')
      expect((await changed).status()).toBe(200)
      await expect(checkbox).not.toBeChecked()
      await expect.poll(() => durableState(harness).settings.showMemoryLimit).toBe(false)

      const seededCacheHash = await page.evaluate(async () => {
        const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
        const response = await fetch('/api/v1/settings', { headers })
        const { settings } = (await response.json()) as { settings: Record<string, unknown> }
        const serialized = JSON.stringify(settings)
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
        const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('risu-resource-cache-v1', 1)
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('entries')) request.result.createObjectStore('entries')
            if (!request.result.objectStoreNames.contains('manifests')) request.result.createObjectStore('manifests')
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(['entries', 'manifests'], 'readwrite')
          transaction.objectStore('entries').put(settings, hash)
          transaction.objectStore('manifests').put(
            {
              version: 1,
              hashes: [hash],
              sizes: [new TextEncoder().encode(serialized).byteLength],
              updatedAt: Date.now(),
            },
            'settings:all',
          )
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        database.close()
        return hash
      })
      expect(seededCacheHash).toMatch(/^[a-f0-9]{64}$/)
      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getPendingResourceCacheWriteCount()))
        .toBe(0)
      await page.evaluate(() => {
        const state = window as typeof window & {
          __writerRestoreDocumentMarker?: string
          __writerRestoreProjectionTrail?: unknown[]
          __writerRestoreProjectionTimer?: number
        }
        state.__writerRestoreDocumentMarker = 'same-document'
        state.__writerRestoreProjectionTrail = []
        state.__writerRestoreProjectionTimer = window.setInterval(() => {
          state.__writerRestoreProjectionTrail!.push(
            window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().showMemoryLimit,
          )
        }, 10)
      })

      await page.route('**/api/v1/settings', async (route) => {
        if (!restoreStarted || route.request().method() !== 'POST') return route.continue()
        const requestBody = route.request().postDataJSON() as {
          cache?: { hashes?: { settings?: unknown } }
        }
        const hashes = requestBody.cache?.hashes?.settings
        advertisedOldLineageHashes = Array.isArray(hashes)
          ? hashes.filter((value): value is string => typeof value === 'string')
          : []
        const response = await route.fetch()
        replacementSettingsSeen = true
        await route.fulfill({ response })
      })

      await page.evaluate((route) => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo(route), '/settings/backup')
      await expect(page.getByRole('button', { name: 'Load Server Backup', exact: true })).toBeVisible()
      restoreStarted = true
      await page.getByRole('button', { name: 'Load Server Backup', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'YES', exact: true }).click()
      await page.getByRole('button', { name: /writer cache baseline/i }).click()
      const loaded = page.getByRole('dialog', { name: 'Loaded server backup', exact: true })
      await expect(loaded).toBeVisible()
      await expect.poll(() => replacementSettingsSeen).toBe(true)
      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().showMemoryLimit))
        .toBe(true)
      const projection = await page.evaluate(() => {
        const state = window as typeof window & {
          __writerRestoreDocumentMarker?: string
          __writerRestoreProjectionTrail?: unknown[]
          __writerRestoreProjectionTimer?: number
        }
        if (state.__writerRestoreProjectionTimer !== undefined) clearInterval(state.__writerRestoreProjectionTimer)
        return {
          showMemoryLimit: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().showMemoryLimit,
          documentMarker: state.__writerRestoreDocumentMarker,
          trail: state.__writerRestoreProjectionTrail ?? [],
        }
      })
      expect(projection.showMemoryLimit).toBe(true)
      expect(projection.documentMarker).toBe('same-document')
      const restoredIndex = projection.trail.findIndex((value) => value === true)
      expect(restoredIndex).toBeGreaterThanOrEqual(0)
      expect(projection.trail.slice(restoredIndex)).not.toContain(false)
      expect(
        advertisedOldLineageHashes,
        'the writer replacement refresh must not advertise a superseded-lineage settings snapshot',
      ).toEqual([])
      await loaded.getByRole('button', { name: 'OK', exact: true }).click()
      await page.locator('[data-reader-use-this-device]').click()
      const takeoverConfirmation = page.getByRole('button', { name: 'Disconnect existing client', exact: true })
      if (
        await takeoverConfirmation.waitFor({ state: 'visible', timeout: 1_000 }).then(
          () => true,
          () => false,
        )
      ) {
        await takeoverConfirmation.click()
      }
      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().lifecycle), {
          timeout: 30_000,
        })
        .toBe('writing')
      await page.evaluate((route) => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo(route), '/settings/display')
      const appearance = page.getByRole('button', { name: 'Chat appearance', exact: true })
      await expect(appearance).toBeVisible()
      await appearance.click()
      await expect(page.getByRole('checkbox', { name: 'Show Memory Limit', exact: true })).toBeChecked()
      expect(durableState(harness).settings.showMemoryLimit).toBe(true)
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
      await context.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  },
)

test(
  'two encrypted old-lineage edits are rejected after restore and reported to the writer',
  { tag: '@core' },
  async ({ browser }) => {
    test.setTimeout(60_000)
    const baselineFont = 'Browser Ownership Baseline Font'
    const oldLineageFont = 'CLIENT1-OLD-LINEAGE-FONT'
    const oldLineageCss = ':root { --client1-old-lineage: 731px; }'
    const database = fixture('CLIENT1-RESTORED-CHARACTER')
    database.font = baselineFont
    database.customFont = baselineFont
    database.customCSS = ''
    const harness = await startFastBootstrapHarness(database, {
      temporaryDirectoryPrefix: 'risu-core-lineage-outbox-',
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    const firstCommandRelease = deferred()
    let heldCommandRequests = 0

    try {
      await bootWriter(page, harness)
      const headers = await writerHeaders(page)
      const backup = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers,
        payload: { label: 'encrypted outbox baseline' },
      })
      expect(backup.statusCode, backup.body).toBe(201)
      const backupId = backup.json<{ id: string }>().id

      const beforeAdvance = durableState(harness)
      const advanced = await patchCharacterName(harness, headers, beforeAdvance.revision, 'CLIENT1-OLD-LINEAGE-ADVANCE')
      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()))
        .toBe(advanced.revision)

      await page.route('**/api/v1/commands/settings/**', async (route) => {
        heldCommandRequests += 1
        if (heldCommandRequests === 1) await firstCommandRelease.promise
        await route.continue()
      })
      await page.evaluate(
        ({ font, css }) => {
          void window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ font, customFont: font })
          void window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ customCSS: css })
        },
        { font: oldLineageFont, css: oldLineageCss },
      )
      await expect
        .poll(
          async () => (await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot())).outbox,
        )
        .toHaveLength(2)
      const encryptedRows = await readNativeRolloutOutbox(page)
      expect(encryptedRows).toHaveLength(2)
      for (const row of encryptedRows) {
        expect(row.ciphertextBytes).toBeGreaterThan(0)
        expect(row.ciphertextText).not.toContain('CLIENT1-OLD-LINEAGE')
        expect(row.databaseLineage).toBe(beforeAdvance.lineage)
      }

      const restored = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/backups/${backupId}/restore`,
        headers,
      })
      expect(restored.statusCode, restored.body).toBe(200)
      const restoredBody = restored.json<{ databaseLineage: string; revision: number }>()
      expect(restoredBody.databaseLineage).not.toBe(beforeAdvance.lineage)
      expect(restoredBody.revision).toBe(advanced.revision)
      firstCommandRelease.resolve()

      const warning = page.getByRole('alertdialog')
      await expect
        .poll(async () => {
          const current = durableState(harness).settings
          if (current.font === oldLineageFont || current.customCSS === oldLineageCss) return 'old-lineage-write-applied'
          return (await warning.isVisible()) ? 'discard-warning-visible' : 'pending'
        })
        .not.toBe('pending')
      const truth = durableState(harness)
      expect(truth.lineage).toBe(restoredBody.databaseLineage)
      expect(truth.settings.font).toBe(baselineFont)
      expect(truth.settings.customFont).toBe(baselineFont)
      expect(truth.settings.customCSS).toBe('')
      await expect(warning).toBeVisible({ timeout: 15_000 })
      await expect(warning).toContainText(/queued changes.*discarded|pending changes.*discarded/is)
      expect(await readNativeRolloutOutbox(page)).toEqual([])
    } finally {
      firstCommandRelease.resolve()
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
      await context.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  },
)
