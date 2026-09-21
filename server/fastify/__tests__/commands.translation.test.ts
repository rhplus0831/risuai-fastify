import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { getSchemaState, openDatabase } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { ChatOccupancyService } from '../src/chatOccupancy.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import {
  getGreetingTranslation,
  sourceHash,
  upsertGreetingTranslation,
} from '../src/translation/greetingTranslationStore.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  importDatabase,
  readJsonRow,
  persistedChatMessages,
} from './helpers/commandHarness.js'

function appBaseUrl(app: FastifyInstance): string {
  const address = app.server.address() as AddressInfo | null
  expect(address).toBeTruthy()
  return `http://127.0.0.1:${address!.port}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPersistedTranslation(
  app: FastifyInstance,
  assertion: string,
  chatId: string,
  expectedText: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let lastMessage: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    const messages = await persistedChatMessages(app, assertion, chatId)
    lastMessage = messages[0]
    const translation = lastMessage?.translation as Record<string, unknown> | null | undefined
    if (translation?.text === expectedText) {
      return lastMessage
    }
    await sleep(25)
  }
  throw new Error(`Timed out waiting for persisted translation. Last message: ${JSON.stringify(lastMessage)}`)
}

async function waitForActiveMessageTranslation(
  app: FastifyInstance,
  assertion: string,
  expected: { chatId: string; messageId: string },
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bootstrap = await injectComposedResourceDatabase(app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const active = bootstrap.json().activeMessageTranslations as Array<{ chatId: string; messageId: string }>
    if (active.some((entry) => entry.chatId === expected.chatId && entry.messageId === expected.messageId)) {
      return
    }
    await sleep(10)
  }
  throw new Error(`Timed out waiting for active message translation: ${JSON.stringify(expected)}`)
}

async function waitForActiveGreetingTranslation(
  app: FastifyInstance,
  assertion: string,
  expected: { characterId: string; chatId: string; greetingIndex: number },
  timeoutMs = 2_000,
): Promise<{ characterId: string; chatId: string; greetingIndex: number; settingsHash: string; jobId: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bootstrap = await injectComposedResourceDatabase(app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const active = bootstrap.json().activeGreetingTranslations as Array<{
      characterId: string
      chatId: string
      greetingIndex: number
      settingsHash: string
      jobId: string
    }>
    const matching = active.find(
      (entry) =>
        entry.characterId === expected.characterId &&
        entry.chatId === expected.chatId &&
        entry.greetingIndex === expected.greetingIndex,
    )
    if (matching) return matching
    await sleep(10)
  }
  throw new Error(`Timed out waiting for active greeting translation: ${JSON.stringify(expected)}`)
}

async function waitForProjectedGreetingTranslation(
  app: FastifyInstance,
  assertion: string,
  characterId: string,
  chatId: string,
  expectedText: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const projection = await app.inject({
      method: 'GET',
      url: `/api/v1/characters/${encodeURIComponent(characterId)}/greeting-translations?chatId=${encodeURIComponent(chatId)}`,
      headers: { 'risu-auth': assertion },
    })
    const translations = projection.json().translations as Array<{ translation?: Record<string, unknown> }>
    const matching = translations.find((entry) => entry.translation?.text === expectedText)?.translation
    if (matching) return matching
    await sleep(25)
  }
  throw new Error(`Timed out waiting for projected greeting translation: ${expectedText}`)
}

async function importMessageTranslationFixture(
  app: FastifyInstance,
  assertion: string,
  options: { echoMessage: string; echoDelay?: number; sourceText?: string },
): Promise<number> {
  return importDatabase(app, assertion, {
    translator: 'ko',
    translatorInputLanguage: 'en',
    translatorType: 'llm',
    aiModel: 'echo_model',
    echoMessage: options.echoMessage,
    ...(options.echoDelay === undefined ? {} : { echoDelay: options.echoDelay }),
    translatorPrompt: 'Translate {{slot::content}} to {{slot}}',
    translatorMaxResponse: 128,
    characters: [
      {
        chaId: 'char-a',
        name: 'A',
        chats: [
          {
            id: 'chat-a',
            name: 'A chat',
            note: '',
            message: [{ role: 'user', data: options.sourceText ?? 'hello raw', chatId: 'msg-a' }],
            localLore: [],
          },
        ],
        chatFolders: [],
        chatPage: 0,
      },
    ],
    characterOrder: ['char-a'],
  })
}

async function importGreetingTranslationFixture(
  app: FastifyInstance,
  assertion: string,
  options: { echoMessage: string; echoDelay?: number },
): Promise<number> {
  return importDatabase(app, assertion, {
    translator: 'ko',
    translatorInputLanguage: 'en',
    translatorType: 'llm',
    aiModel: 'echo_model',
    echoMessage: options.echoMessage,
    ...(options.echoDelay === undefined ? {} : { echoDelay: options.echoDelay }),
    translatorPrompt: 'Translate {{slot::content}} to {{slot}}',
    translatorMaxResponse: 128,
    characters: [
      {
        chaId: 'char-a',
        name: 'A',
        firstMessage: 'primary greeting',
        alternateGreetings: ['alternate greeting'],
        chats: [{ id: 'chat-a', name: 'A chat', message: [], fmIndex: -1 }],
      },
    ],
    characterOrder: ['char-a'],
  })
}

async function postAndDisconnect(url: string, assertion: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload)
  await new Promise<void>((resolve, reject) => {
    let finished = false
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'risu-auth': assertion,
        },
      },
      (res) => {
        res.resume()
      },
    )
    req.on('error', (err) => {
      if (!finished) reject(err)
    })
    req.on('finish', () => {
      finished = true
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 25)
    })
    req.on('timeout', () => reject(new Error('Timed out writing disconnect test request')))
    req.setTimeout(1_000)
    req.end(body)
  })
}

let harness: Harness

describe('message and greeting translation commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('translates raw message data on the server and stores the result on the message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'translated raw text',
    })

    const translated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(translated.statusCode).toBe(200)
    expect(translated.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'message.updated',
        revision: 2,
        resource: 'message',
        id: 'msg-a',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-a',
      translation: {
        text: 'translated raw text',
        source: 'raw',
        targetLanguage: 'ko',
        inputLanguage: 'en',
        translatorType: 'llm',
      },
    })
    expect(translated.json().translation.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(translated.json().translation.settingsHash).toMatch(/^[a-f0-9]{64}$/)
    expect(typeof translated.json().translation.updatedAt).toBe('number')

    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'hello raw',
        chatId: 'msg-a',
        translation: translated.json().translation,
      },
    ])

    const unchanged = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: translated.json().revision,
        patch: { data: 'hello raw' },
      },
    })
    expect(unchanged.statusCode).toBe(200)
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'hello raw',
        chatId: 'msg-a',
        translation: translated.json().translation,
      },
    ])

    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: unchanged.json().revision,
        patch: { data: 'changed raw' },
      },
    })
    expect(edited.statusCode).toBe(200)
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'changed raw',
        chatId: 'msg-a',
        translation: null,
      },
    ])

    const replacedWithStaleTranslation = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: edited.json().revision,
        messages: [
          {
            role: 'user',
            data: 'changed by replacement',
            chatId: 'msg-a',
            translation: translated.json().translation,
          },
        ],
      },
    })
    expect(replacedWithStaleTranslation.statusCode).toBe(200)
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'changed by replacement',
        chatId: 'msg-a',
        translation: null,
      },
    ])
  })

  it('translates a server-resolved greeting and exposes only the current settings projection', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'translated primary greeting',
    })

    const translated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/-1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, chatId: 'chat-a', jobId: 'greeting-job-a' },
    })
    expect(translated.statusCode).toBe(200)
    expect(translated.json()).toMatchObject({
      revision: revision + 1,
      event: {
        type: 'character.greetingTranslation.updated',
        resource: 'greetingTranslation',
        id: 'char-a',
      },
      jobId: 'greeting-job-a',
      characterId: 'char-a',
      chatId: 'chat-a',
      greetingIndex: -1,
      translation: { text: 'translated primary greeting', source: 'raw', translatorType: 'llm' },
    })
    expect(translated.json().settingsHash).toBe(translated.json().translation.settingsHash)

    const projected = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a/greeting-translations?chatId=chat-a',
      headers: { 'risu-auth': assertion },
    })
    expect(projected.statusCode).toBe(200)
    expect(projected.json()).toEqual({
      revision: revision + 1,
      characterId: 'char-a',
      chatId: 'chat-a',
      settingsHash: translated.json().settingsHash,
      translations: [{ greetingIndex: -1, translation: translated.json().translation }],
    })
    expect(readJsonRow(harness.dataDir, 'characters', 'char-a')).not.toHaveProperty('greetingTranslations')

    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, chatId: 'chat-a', jobId: 'invalid-job' },
    })
    expect(invalid.statusCode).toBe(404)
    expect(invalid.json().error).toBe('Greeting not found: char-a/1')

    const disabled = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/language',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, patch: { translatorType: 'none' } },
    })
    expect(disabled.statusCode).toBe(200)
    const disabledProjection = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a/greeting-translations?chatId=chat-a',
      headers: { 'risu-auth': assertion },
    })
    expect(disabledProjection.json()).toMatchObject({ settingsHash: null, translations: [] })
  })

  it('rejects a greeting translation whose source changes while the provider is running', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'stale greeting translation',
      echoDelay: 0.2,
    })
    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/-1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, chatId: 'chat-a', jobId: 'stale-greeting-job' },
    })
    await waitForActiveGreetingTranslation(harness.app, assertion, {
      characterId: 'char-a',
      chatId: 'chat-a',
      greetingIndex: -1,
    })

    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { firstMessage: 'edited greeting' } },
    })
    expect(edited.statusCode).toBe(200)
    const result = await translating
    expect(result.statusCode).toBe(400)
    expect(result.json().error).toBe('Greeting changed before translation could be saved: char-a/-1')
    const db = openDatabase(harness.dataDir)
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM greeting_translations').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('rechecks chat occupancy before publishing a greeting translation after its provider await', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'translation that must not cross occupancy',
      echoDelay: 0.2,
    })
    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/-1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, chatId: 'chat-a', jobId: 'occupancy-race-greeting-job' },
    })
    await waitForActiveGreetingTranslation(harness.app, assertion, {
      characterId: 'char-a',
      chatId: 'chat-a',
      greetingIndex: -1,
    })

    const db = openDatabase(harness.dataDir)
    try {
      new ChatOccupancyService(db).claim({
        databaseLineage: getDatabaseLineage(db),
        chatId: 'chat-a',
        sessionId: 'reader-after-provider-start',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
    } finally {
      db.close()
    }

    const result = await translating
    expect(result.statusCode).toBe(423)
    expect(result.json()).toMatchObject({
      error: 'chat_occupied',
      conflictingChatIds: ['chat-a'],
      safeRelease: expect.any(String),
    })
    const after = openDatabase(harness.dataDir)
    try {
      expect(after.prepare('SELECT COUNT(*) AS count FROM greeting_translations').get()).toEqual({ count: 0 })
      expect(getSchemaState(after).revision).toBe(revision)
    } finally {
      after.close()
    }
  })

  it('preserves a greeting row changed while the provider request is pending', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'provider greeting translation that must lose',
      echoDelay: 0.2,
    })
    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/greetings/-1/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, chatId: 'chat-a', jobId: 'stale-prior-greeting-job' },
    })
    const active = await waitForActiveGreetingTranslation(harness.app, assertion, {
      characterId: 'char-a',
      chatId: 'chat-a',
      greetingIndex: -1,
    })
    const manualTranslation = {
      text: 'manual greeting translation',
      source: 'raw' as const,
      sourceHash: sourceHash('primary greeting'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: active.settingsHash,
      updatedAt: 123,
    }
    const db = openDatabase(harness.dataDir)
    try {
      upsertGreetingTranslation(db, 'char-a', -1, manualTranslation)
    } finally {
      db.close()
    }

    const result = await translating
    expect(result.statusCode).toBe(400)
    expect(result.json().error).toBe('Greeting translation changed before translation could be saved: char-a/-1')
    const after = openDatabase(harness.dataDir)
    try {
      expect(getGreetingTranslation(after, 'char-a', -1, active.settingsHash)?.translation).toEqual(manualTranslation)
    } finally {
      after.close()
    }
  })

  it('continues greeting translation after the requesting client disconnects', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importGreetingTranslationFixture(harness.app, assertion, {
      echoMessage: 'greeting translated after disconnect',
      echoDelay: 0.5,
    })
    await harness.app.listen({ host: '127.0.0.1', port: 0 })
    await postAndDisconnect(
      `${appBaseUrl(harness.app)}/api/v1/commands/characters/char-a/greetings/-1/translate`,
      assertion,
      { baseRevision: revision, chatId: 'chat-a', jobId: 'disconnected-greeting-job' },
    )

    const during = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(during.statusCode).toBe(200)
    expect(during.json().activeGreetingTranslations).toEqual([
      expect.objectContaining({
        characterId: 'char-a',
        chatId: 'chat-a',
        greetingIndex: -1,
        jobId: 'disconnected-greeting-job',
        status: 'running',
      }),
    ])
    await expect(
      waitForProjectedGreetingTranslation(
        harness.app,
        assertion,
        'char-a',
        'chat-a',
        'greeting translated after disconnect',
      ),
    ).resolves.toMatchObject({ text: 'greeting translated after disconnect', source: 'raw' })
  })

  it('allows unrelated edits while raw translation is waiting on its provider', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'translated after concurrent edit',
      echoDelay: 0.2,
    })

    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })

    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })

    const settings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { font: 'concurrent-font' },
      },
    })
    expect(settings.statusCode).toBe(200)

    const translated = await translating
    expect(translated.statusCode).toBe(200)
    expect(translated.json()).toMatchObject({
      revision: settings.json().revision + 1,
      chatId: 'chat-a',
      messageId: 'msg-a',
      translation: { text: 'translated after concurrent edit' },
    })
  })

  it('rejects raw translation publication when a foreign occupant claims its resolved chat mid-provider', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'translation that must not cross occupancy',
      echoDelay: 0.2,
    })
    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'owner-a' },
      payload: { baseRevision: revision },
    })
    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })
    const occupancyDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      new ChatOccupancyService(occupancyDb).claim({
        databaseLineage: getDatabaseLineage(occupancyDb),
        chatId: 'chat-a',
        sessionId: 'reader-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
    } finally {
      occupancyDb.close()
    }
    const result = await translating
    expect(result.statusCode).toBe(423)
    expect(result.json()).toMatchObject({
      error: 'chat_occupied',
      chatId: 'chat-a',
      conflictingChatIds: ['chat-a'],
    })
    const messages = await persistedChatMessages(harness.app, assertion, 'chat-a')
    expect(messages).toEqual([expect.objectContaining({ chatId: 'msg-a', data: 'hello raw' })])
    expect(messages[0]).not.toHaveProperty('translation')
  })

  it('lets a newer raw translation supersede the operation that previously owned the message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'only translation result',
      echoDelay: 0.2,
    })

    const first = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, jobId: 'translation-job-a' },
    })
    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })

    const newer = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, jobId: 'translation-job-b' },
    })
    const [olderResult, newerResult] = await Promise.all([first, newer])
    expect(olderResult.statusCode).toBe(400)
    expect(olderResult.json().error).toBe('Message translation is no longer current: msg-a')
    expect(newerResult.statusCode).toBe(200)
    expect(newerResult.json()).toMatchObject({
      jobId: 'translation-job-b',
      translation: { text: 'only translation result' },
    })
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      expect.objectContaining({
        chatId: 'msg-a',
        translation: expect.objectContaining({ text: 'only translation result' }),
      }),
    ])
  })

  it('rejects a stale translation when its source message changes during the provider request', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'stale translated text',
      echoDelay: 0.2,
      sourceText: 'original raw text',
    })

    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })

    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { data: 'edited while translating' },
      },
    })
    expect(edited.statusCode).toBe(200)

    const translated = await translating
    expect(translated.statusCode).toBe(400)
    expect(translated.json().error).toBe('Message changed before translation could be saved: msg-a')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: 'edited while translating',
        chatId: 'msg-a',
      },
    ])

    const after = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(after.statusCode).toBe(200)
    expect(after.json().revision).toBe(edited.json().revision)
    expect(after.json().activeMessageTranslations).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: expect.any(String),
        status: 'failed',
        error: 'Message changed before translation could be saved: msg-a',
        completedAt: expect.any(Number),
      }),
    ])
  })

  it('preserves a manual translation edit made while the provider request is pending', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const sourceText = 'original raw text'
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'provider translation that must lose',
      echoDelay: 0.2,
      sourceText,
    })
    const translating = harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/messages/msg-a/translate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, jobId: 'translation-job-a' },
    })
    await waitForActiveMessageTranslation(harness.app, assertion, {
      chatId: 'chat-a',
      messageId: 'msg-a',
    })

    const manualTranslation = {
      text: 'manually edited translation',
      source: 'raw',
      sourceHash: createHash('sha256').update(sourceText).digest('hex'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'manual-settings',
      updatedAt: 123,
    }
    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { translation: manualTranslation } },
    })
    expect(edited.statusCode).toBe(200)

    const translated = await translating
    expect(translated.statusCode).toBe(400)
    expect(translated.json().error).toBe('Message translation changed before translation could be saved: msg-a')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      {
        role: 'user',
        data: sourceText,
        chatId: 'msg-a',
        translation: manualTranslation,
      },
    ])
  })

  it('continues server raw translation after the requesting client disconnects', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importMessageTranslationFixture(harness.app, assertion, {
      echoMessage: 'translated after disconnect',
      echoDelay: 0.5,
    })

    await harness.app.listen({ host: '127.0.0.1', port: 0 })
    await postAndDisconnect(`${appBaseUrl(harness.app)}/api/v1/commands/messages/msg-a/translate`, assertion, {
      baseRevision: revision,
    })

    const during = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(during.statusCode).toBe(200)
    expect(during.json().activeMessageTranslations).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: expect.any(String),
        status: 'running',
      }),
    ])

    const message = await waitForPersistedTranslation(harness.app, assertion, 'chat-a', 'translated after disconnect')
    expect(message.translation).toMatchObject({
      text: 'translated after disconnect',
      source: 'raw',
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
    })

    const after = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(after.statusCode).toBe(200)
    expect(after.json().activeMessageTranslations).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: expect.any(String),
        status: 'succeeded',
        completedAt: expect.any(Number),
      }),
    ])
  })
})
