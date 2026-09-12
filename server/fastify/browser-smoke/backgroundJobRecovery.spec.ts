import { expect, test, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { createMemoryChunk } from '../src/memoryRepository.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

const characterId = 'fast-bootstrap-small-character'
const chatId = 'fast-bootstrap-small-chat'
const messageId = 'phase05-message'
const translated = 'The lantern shines beyond the mountains.'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function startProvider(output = translated) {
  const requests: { body: Record<string, unknown>; response: ServerResponse }[] = []
  const gate = deferred()
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    requests.push({ body, response })
    await gate.promise
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Provider did not bind')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    release: () => gate.resolve(),
    close: async () => {
      gate.resolve()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}

function fixture(providerUrl: string) {
  const database = smallFastBootstrapFixture()
  Object.assign(database, {
    translator: 'ko',
    translatorInputLanguage: 'en',
    translatorType: 'llm',
    translatorSendTextAsIs: true,
    translatorPrompt: 'Translate {{slot::content}}',
    translatorMaxResponse: 128,
    providerCredentials: [
      { id: 'phase05-credential', name: 'Fixture provider', type: 'apiKey', apiKey: 'fixture-key' },
    ],
    modelProfiles: [
      {
        id: 'phase05-profile',
        name: 'Fixture provider',
        providerId: 'custom-api',
        modelId: 'gpt-4o-mini',
        providerOptions: { credentialId: 'phase05-credential', baseUrl: providerUrl, requestModel: 'gpt-4o-mini' },
        runtimeOptions: { useStreaming: false },
      },
    ],
    modelRoleProfiles: {
      translate: { mode: 'profile', profileId: 'phase05-profile' },
      memory: { mode: 'profile', profileId: 'phase05-profile' },
    },
  })
  const character = (database.characters as Array<Record<string, unknown>>)[0]
  character.firstMessage = 'The lantern is waiting.'
  ;(character.chats as Array<Record<string, unknown>>)[0].message = [
    { chatId: 'phase05-user', role: 'user', data: 'Where is the lantern?' },
    { chatId: messageId, role: 'char', data: 'The lantern is above the mountain.' },
  ]
  return database
}

async function ready(page: Page, harness: FastBootstrapHarness) {
  await page.goto(`${harness.baseUrl}/character/${characterId}/${chatId}`)
  await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded(20_000))
  await expect(page.getByTestId('default-chat-composer')).toBeEnabled()
}

function durableTranslation(harness: FastBootstrapHarness, family: 'message' | 'greeting') {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    if (family === 'message') {
      const row = db.prepare('SELECT json FROM messages WHERE uid = ? AND alternate = 0').get(messageId) as {
        json: string
      }
      return JSON.parse(row.json).translation?.text ?? null
    }
    const rows = db.prepare('SELECT * FROM greeting_translations').all()
    return JSON.stringify(rows)
  } finally {
    db.close()
  }
}

for (const family of ['message', 'greeting'] as const) {
  test(`${family} translation settles despite an older held running bootstrap`, async ({ page }) => {
    test.setTimeout(60_000)
    const provider = await startProvider()
    const harness = await startFastBootstrapHarness(fixture(provider.url), {
      temporaryDirectoryPrefix: 'risu-phase05-translation-',
    })
    const releaseSnapshot = deferred()
    let held = false
    let bootstraps = 0
    try {
      await ready(page, harness)
      const buttons = page.locator('[data-risu-message-action="translate"]')
      await expect(buttons).toHaveCount(3)
      const translate = family === 'greeting' ? buttons.last() : buttons.first()
      await expect(translate).toBeEnabled()
      await page.route('**/api/v1/bootstrap*', async (route) => {
        bootstraps += 1
        const response = await route.fetch()
        const body = await response.json()
        const jobs = body[family === 'message' ? 'activeMessageTranslations' : 'activeGreetingTranslations'] ?? []
        if (!held && jobs.some((job: { status: string }) => job.status === 'running')) {
          held = true
          await releaseSnapshot.promise
        }
        await route.fulfill({ response })
      })
      await translate.click()
      await expect(translate).toHaveAttribute('aria-busy', 'true')
      await expect.poll(() => provider.requests.length).toBe(1)
      await expect.poll(() => held, { timeout: 10_000 }).toBe(true)
      provider.release()
      await expect.poll(() => durableTranslation(harness, family)).toContain(translated)
      await expect(page.getByText(translated, { exact: true })).toBeVisible()
      await expect(translate).toHaveAttribute('aria-busy', 'false')
      releaseSnapshot.resolve()
      await page.waitForTimeout(100)
      await expect(translate).toHaveAttribute('aria-busy', 'false')
      await expect(translate).toBeEnabled()
      const settledBootstraps = bootstraps
      await page.waitForTimeout(5_500)
      expect(bootstraps).toBe(settledBootstraps)
      expect(provider.requests).toHaveLength(1)
      await page.reload()
      await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
      await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded(20_000))
      await expect(page.getByTestId('default-chat-composer')).toBeEnabled()
      await expect.poll(() => durableTranslation(harness, family)).toContain(translated)
      await expect(page.locator('[data-risu-message-action="translate"][aria-busy="true"]')).toHaveCount(0)
    } finally {
      releaseSnapshot.resolve()
      provider.release()
      await page.close()
      await test.step('close Fastify and its workers', () => closeFastBootstrapHarness(harness))
      await test.step('close deterministic provider', () => provider.close())
    }
  })
}

function writerHeaders(harness: FastBootstrapHarness) {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    const row = db
      .prepare('SELECT active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
      .get() as { active_writer_session_id: string; writer_epoch: number }
    return {
      'risu-auth': harness.assertion,
      'risu-writer-session': row.active_writer_session_id,
      'risu-writer-epoch': String(row.writer_epoch),
    }
  } finally {
    db.close()
  }
}

async function openMemory(page: Page) {
  await page.getByTestId('default-chat-menu-button').click()
  await page.getByRole('menuitem', { name: 'Hypa V3 Modal', exact: true }).click()
  const panel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Server memory jobs', exact: true }) })
  await expect(panel).toBeVisible()
  return panel
}

test('real memory worker recovers a lost terminal event and a failed list read without duplicate output', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const summary = 'Mira carried the lantern across the mountain.'
  const provider = await startProvider(summary)
  const database = fixture(provider.url)
  Object.assign(database, {
    hypaV3: true,
    showMenuHypaMemoryModal: true,
    selectedHypaV3PresetId: 'phase05-memory',
    hypaV3PresetId: 0,
    hypaV3Presets: [
      {
        id: 'phase05-memory',
        name: 'Memory',
        settings: {
          summarizationModel: 'subModel',
          summarizationPrompt: 'Summarize {{slot}}',
          summarizationMaxConcurrent: 1,
        },
      },
    ],
  })
  const harness = await startFastBootstrapHarness(database, {
    temporaryDirectoryPrefix: 'risu-phase05-memory-',
    memoryWorker: { pollIntervalMs: 20 },
  })
  let listReads = 0
  let rejectNextList = false
  let droppedTerminals = 0
  harness.app.server.prependListener('request', (request, response) => {
    if (!request.url?.startsWith('/api/v1/events')) return
    const write = response.write.bind(response)
    response.write = ((chunk: unknown, ...args: unknown[]) => {
      const frame = String(chunk)
      if (frame.includes('event: memory\n') && frame.includes('"status":"completed"')) {
        droppedTerminals += 1
        return true
      }
      return (write as (...args: unknown[]) => boolean)(chunk, ...args)
    }) as typeof response.write
  })
  try {
    await ready(page, harness)
    const panel = await openMemory(page)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      createMemoryChunk(db, {
        id: 'phase05-chunk',
        chatId,
        messageId,
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'The lantern travels across the mountain.',
      })
    } finally {
      db.close()
    }
    const enqueued = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/memory/jobs',
      headers: writerHeaders(harness),
      payload: {
        chatId,
        kind: 'summarize',
        payload: {
          schemaVersion: 1,
          chunkId: 'phase05-chunk',
          model: 'subModel',
          rangeStartSeq: 0,
          rangeEndSeq: 1,
          messageIndexes: [0, 1],
          chatMemos: ['phase05-user', messageId],
        },
      },
    })
    expect(enqueued.statusCode, enqueued.body).toBe(201)
    const id = enqueued.json().job.id as string
    await expect.poll(() => provider.requests.length).toBe(1)
    await expect(panel.getByText('running', { exact: true })).toBeVisible()
    await page.route('**/api/v1/memory/jobs?*', async (route) => {
      listReads += 1
      if (rejectNextList) {
        rejectNextList = false
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'temporary job list failure' }),
        })
      } else await route.continue()
    })
    rejectNextList = true
    provider.release()
    const persisted = () => {
      const read = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
      try {
        return {
          job: read.prepare('SELECT status FROM memory_jobs WHERE id = ?').get(id),
          summaries: read.prepare('SELECT text FROM memory_summaries WHERE chat_id = ?').all(chatId),
        }
      } finally {
        read.close()
      }
    }
    await expect.poll(persisted).toEqual({ job: { status: 'completed' }, summaries: [{ text: summary }] })
    expect(droppedTerminals).toBe(1)
    await expect(panel).toContainText('temporary job list failure', { timeout: 10_000 })
    await expect(panel.getByText('completed', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(panel.getByText('running', { exact: true })).toHaveCount(0)
    const settledReads = listReads
    await page.waitForTimeout(5_500)
    expect(listReads).toBe(settledReads)
    expect(provider.requests).toHaveLength(1)
    await page.reload()
    await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded(20_000))
    const reloaded = await openMemory(page)
    await expect(reloaded.getByText('completed', { exact: true })).toBeVisible()
    expect(persisted()).toEqual({ job: { status: 'completed' }, summaries: [{ text: summary }] })
  } finally {
    provider.release()
    await page.context().setOffline(false)
    await page.close()
    await closeFastBootstrapHarness(harness)
    await provider.close()
  }
})

async function openBardWiki(page: Page) {
  await page.getByTestId('default-chat-menu-button').click()
  await page.getByTestId('default-chat-open-bardwiki').click()
  const dialog = page.getByRole('dialog', { name: 'BardWiki workspace', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test('BardWiki real rebuild preserves terminal state across an older read and preserves manual edits on the next rebuild', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const draft = {
    title: 'Lantern Event',
    logicalPath: 'Events/Lantern',
    aliases: [],
    markdown: '## Lantern Event\n\nThe lantern is above the mountain.',
  }
  const provider = await startProvider(JSON.stringify(draft))
  const database = fixture(provider.url)
  database.bardWiki = {
    enabledByDefault: true,
    memoryMode: 'bardwiki',
    confirmationPolicy: 'manual',
    modelProfileId: 'phase05-profile',
    promptPresetId: null,
    canonicalUpdates: false,
    totalTokenBudget: 2048,
    hybridHypaTokenBudget: 1024,
    hybridBardWikiTokenBudget: 1024,
    maxDocuments: 8,
    maxLinkHops: 1,
    recentMessageCount: 12,
  }
  const harness = await startFastBootstrapHarness(database, { temporaryDirectoryPrefix: 'risu-phase05-bardwiki-' })
  const releaseOldRead = deferred()
  let held = false
  let oldReadRevision: number | undefined
  const read = () => {
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      return {
        jobs: db
          .prepare('SELECT id, instance_id, status, attempt_count FROM bardwiki_jobs ORDER BY rowid')
          .all() as Array<{ id: string; instance_id: string; status: string; attempt_count: number }>,
        documents: db
          .prepare('SELECT id, markdown FROM bardwiki_documents WHERE deleted_at IS NULL ORDER BY id')
          .all() as Array<{ id: string; markdown: string }>,
        revision: (db.prepare('SELECT revision FROM schema_version WHERE id = 1').get() as { revision: number })
          .revision,
      }
    } finally {
      db.close()
    }
  }
  try {
    await ready(page, harness)
    const dialog = await openBardWiki(page)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.exec(
        "CREATE TRIGGER hold_bardwiki_completion BEFORE UPDATE OF status ON bardwiki_jobs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'held completion write'); END",
      )
    } finally {
      db.close()
    }
    await page.route(`**/api/v1/bardwiki/chats/${chatId}`, async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      if (
        !held &&
        body.documents?.length === 1 &&
        body.jobs?.some(
          (job: { status: string; attemptCount: number }) => job.status === 'pending' && job.attemptCount === 1,
        )
      ) {
        held = true
        oldReadRevision = body.revision
        await releaseOldRead.promise
      }
      await route.fulfill({ response })
    })
    page.on('dialog', (dialog) => dialog.accept())
    const rebuild = async () => {
      const tools = dialog.getByTestId('bardwiki-lifecycle')
      if ((await tools.getAttribute('open')) === null)
        await dialog.getByText('Build and transfer', { exact: true }).click()
      await dialog.getByRole('button', { name: 'Preview rebuild', exact: true }).click()
      await dialog.getByRole('button', { name: 'Start rebuild', exact: true }).click()
    }
    await rebuild()
    await expect.poll(() => provider.requests.length).toBe(1)
    await expect(dialog).toContainText('1 running')
    provider.release()
    await expect.poll(() => held, { timeout: 10_000 }).toBe(true)
    const storage = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      storage.exec('DROP TRIGGER hold_bardwiki_completion')
    } finally {
      storage.close()
    }
    await expect.poll(() => read().jobs[0]?.status).toBe('completed')
    await expect(dialog.locator('[data-job-instance]').first()).toContainText('Completed')
    expect(read().revision).toBe(oldReadRevision)
    releaseOldRead.resolve()
    await page.waitForTimeout(150)
    await expect(dialog).toContainText('0 running')
    await expect(dialog.locator('[data-job-instance]').first()).toContainText('Completed')
    await expect(dialog.locator('[data-job-instance]').filter({ hasText: 'Pending' })).toHaveCount(0)
    expect(provider.requests).toHaveLength(1)
    expect(read().documents.map((document) => document.markdown)).toEqual([draft.markdown])

    await dialog.getByRole('button', { name: 'Open Lantern Event', exact: true }).click()
    const manual = '## Lantern Event\n\nMy manual correction must survive the rebuild.'
    await dialog.getByLabel('Markdown source', { exact: true }).fill(manual)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => read().documents[0]?.markdown).toBe(manual)
    await rebuild()
    await expect.poll(() => read().jobs.map((job) => job.status)).toEqual(['completed', 'completed'])
    expect(provider.requests).toHaveLength(2)
    expect(
      read()
        .documents.map((document) => document.markdown)
        .sort(),
    ).toEqual([draft.markdown, manual].sort())
    await expect(dialog.getByRole('button', { name: 'Open Lantern Event', exact: true })).toHaveCount(2)
    await page.reload()
    await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded(20_000))
    const reloaded = await openBardWiki(page)
    await expect(reloaded.getByRole('button', { name: 'Open Lantern Event', exact: true })).toHaveCount(2)
    await expect(reloaded).toContainText('0 running')
  } finally {
    releaseOldRead.resolve()
    provider.release()
    await page.close()
    await closeFastBootstrapHarness(harness)
    await provider.close()
  }
})
