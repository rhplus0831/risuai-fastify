import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { closeFastBootstrapHarness } from './fastBootstrapHarness.js'
import {
  CHAT_OWNER,
  CHAT_OBSERVER,
  STATIC_LAST_INTERACTION,
  ACCEPTED_IGP_PROMPT,
  ACCEPTED_IGP_SUFFIX,
  ACCEPTED_IGP_MODEL,
  ACCEPTED_IGP_CREDENTIAL,
  ACCEPTED_TRANSLATION_MODEL,
  OccupancyProvider,
  startIgpProvider,
  startHeldImageProvider,
  startSequentialImageProvider,
  type Client,
  fixture,
  readTruth,
  readInlayPreparation,
  startHarness,
  createClient,
  waitForHook,
  bootOwner,
  bootReader,
  configureChats,
  directClaim,
  directTupleMutation,
  expectOccupancyState,
  promoteViaUi,
  sendFromUi,
  chatMessages,
  expectCompleted,
} from './chatOccupancyHarness.js'

test('owner emotion inlay finalizes through exact accepted-operation lineage in Chromium', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  // Keep the provider open until Chromium has attached the accepted-operation
  // stream. An instant provider can legitimately finish before the browser GET
  // reaches Fastify, exercising reattachment rather than the live terminal path
  // whose inlay transport this regression proves.
  provider.configure(CHAT_OWNER, { chunks: ['Reply <Emotion="happy">'], holdAfterChunk: 1 })
  const configuredDatabase = fixture()
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'emotion'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.emotionImages = [['happy', 'happy.png']]
  const harness = await startHarness(provider, 'risu-chat-occupancy-emotion-inlay-', {
    database: configuredDatabase,
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'emotion-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )

    await sendFromUi(owner, 'Show a happy emotion.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await expect
      .poll(
        () =>
          owner.records.filter(
            (record) =>
              record.method === 'PUT' &&
              /\/api\/v1\/generation-effects\/[^/]+\/igp\/inlay-(?:preparation|finalization)$/u.test(record.path) &&
              record.status === 200,
          ).length,
        { timeout: 30_000 },
      )
      .toBe(2)

    const truth = readTruth(harness.dataDir)
    const operation = truth.operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    const result = truth.messages.find((candidate) => candidate.uid === operation.result_message_id)!
    const inlayMutations = owner.records.filter(
      (record) =>
        record.method === 'PUT' &&
        /\/api\/v1\/generation-effects\/[^/]+\/igp\/inlay-(?:preparation|finalization)$/u.test(record.path),
    )
    const preparation = inlayMutations.find((record) => record.path.endsWith('/inlay-preparation'))!
    const finalization = inlayMutations.find((record) => record.path.endsWith('/inlay-finalization'))!
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(result.data).toBe('Reply {{emotion::happy}}')
    expect(result.data).not.toContain('<Emotion=')
    expect(inlayMutations).toHaveLength(2)
    expect(preparation).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': truth.ownership.lineage,
      },
      body: {
        baseRevision: expect.any(Number),
        operationId: operation.operation_id,
        preparationId: expect.any(String),
        expectedData: 'Reply <Emotion="happy">',
      },
    })
    expect(finalization).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': truth.ownership.lineage,
      },
      body: {
        baseRevision: expect.any(Number),
        operationId: operation.operation_id,
        preparationId: preparation.body?.preparationId,
        expectedData: 'Reply <Emotion="happy">',
        finalData: 'Reply {{emotion::happy}}',
      },
    })
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('owner-emotion-inlay-lineage.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          operation,
          result,
          inlayMutations: inlayMutations.map(({ method, path, headers, body, status }) => ({
            method,
            path,
            headers,
            body,
            status,
          })),
          truth,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('owner-emotion-inlay-lineage', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('legacy owner emotion inlay persists with lineage when chat occupancy rollout is disabled', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <Emotion="happy">'], holdAfterChunk: 1 })
  const configuredDatabase = fixture()
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'emotion'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.emotionImages = [['happy', 'happy.png']]
  const harness = await startHarness(provider, 'risu-chat-occupancy-disabled-emotion-inlay-', {
    database: configuredDatabase,
    chatOccupancyEnabled: false,
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'legacy-emotion-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)

    await sendFromUi(owner, 'Show a legacy happy emotion.', true)
    await expect.poll(() => provider.calls(CHAT_OWNER), { timeout: 30_000 }).toBe(1)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expect
      .poll(() => chatMessages(readTruth(harness.dataDir), CHAT_OWNER).at(-1)?.data, { timeout: 30_000 })
      .toBe('Reply {{emotion::happy}}')

    const truth = readTruth(harness.dataDir)
    const result = chatMessages(truth, CHAT_OWNER).at(-1)!
    const findMessageMutation = () =>
      owner.records.find(
        (record) =>
          record.method === 'PATCH' &&
          record.path === `/api/v1/commands/messages/${encodeURIComponent(result.uid)}` &&
          record.body?.expectedData === 'Reply <Emotion="happy">',
      )
    await expect.poll(() => findMessageMutation()?.status, { timeout: 30_000 }).toBe(200)
    const messageMutation = findMessageMutation()
    expect(messageMutation).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': truth.ownership.lineage,
      },
      body: {
        expectedChatId: CHAT_OWNER,
        expectedGenerationId: expect.any(String),
        patch: { data: 'Reply {{emotion::happy}}' },
      },
    })
    expect(
      owner.records.filter((record) => /\/igp\/inlay-(?:preparation|finalization|abandonment)$/u.test(record.path)),
    ).toHaveLength(0)
    expect(pageErrors).toEqual([])
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('legacy owner image inlay persists with lineage when chat occupancy rollout is disabled', async ({ browser }) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <ImgGen="happy cat">'], holdAfterChunk: 1 })
  const imageProvider = await startHeldImageProvider()
  const configuredDatabase = fixture()
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'legacy-image-key',
    model: 'legacy-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: 'best quality, {{slot}}',
    negative: 'worse quality',
    instructions: '',
    emotionInstructions: '',
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-disabled-image-inlay-', {
    database: configuredDatabase,
    chatOccupancyEnabled: false,
  }).catch(async (error: unknown) => {
    await imageProvider.close()
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'legacy-image-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)

    await sendFromUi(owner, 'Show a legacy image.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await imageProvider.started
    expect(imageProvider.requests).toHaveLength(1)
    imageProvider.release()
    await expect
      .poll(() => chatMessages(readTruth(harness.dataDir), CHAT_OWNER).at(-1)?.data, { timeout: 30_000 })
      .toMatch(/^Reply \{\{inlay::[a-f0-9]{64}\}\}$/u)

    const truth = readTruth(harness.dataDir)
    const result = chatMessages(truth, CHAT_OWNER).at(-1)!
    const findMessageMutation = () =>
      owner.records.find(
        (record) =>
          record.method === 'PATCH' &&
          record.path === `/api/v1/commands/messages/${encodeURIComponent(result.uid)}` &&
          record.body?.expectedData === 'Reply <ImgGen="happy cat">',
      )
    await expect.poll(() => findMessageMutation()?.status, { timeout: 30_000 }).toBe(200)
    const messageMutation = findMessageMutation()
    expect(messageMutation).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': truth.ownership.lineage,
      },
      body: {
        expectedChatId: CHAT_OWNER,
        expectedGenerationId: expect.any(String),
        patch: { data: result.data },
      },
    })
    expect(
      owner.records.filter((record) => /\/igp\/inlay-(?:preparation|finalization|abandonment)$/u.test(record.path)),
    ).toHaveLength(0)
    expect(pageErrors).toEqual([])
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await Promise.all([closeFastBootstrapHarness(harness), imageProvider.close()])
  }
})

test('legacy held image failure preserves a newer owner edit through failed refreshes', async ({ browser }) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <ImgGen="happy cat">'], holdAfterChunk: 1 })
  const imageProvider = await startHeldImageProvider(500)
  const configuredDatabase = fixture()
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.disableAutoPopupMessageEditor = true
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'failed-image-key',
    model: 'failed-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: '{{slot}}',
    negative: '',
    instructions: '',
    emotionInstructions: '',
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-disabled-stale-image-', {
    database: configuredDatabase,
    chatOccupancyEnabled: false,
  }).catch(async (error: unknown) => {
    await imageProvider.close()
    throw error
  })
  const clients: Client[] = []
  try {
    const owner = await createClient(browser, 'legacy-stale-image-owner')
    clients.push(owner)
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)

    await sendFromUi(owner, 'Image before editing.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream$/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await imageProvider.started

    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    const messageId = operation.result_message_id!
    const newerData = 'Newer owner edit must survive.'
    const edit = await owner.page.evaluate(
      async ({ messageId, lineage, newerData }) => {
        const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
        const bootstrap = await fetch('/api/v1/bootstrap', { headers })
        const { revision } = (await bootstrap.json()) as { revision: number }
        const response = await fetch(`/api/v1/commands/messages/${encodeURIComponent(messageId)}`, {
          method: 'PATCH',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'risu-database-lineage': lineage,
          },
          body: JSON.stringify({ baseRevision: revision, patch: { data: newerData } }),
        })
        return { status: response.status, body: (await response.json()) as Record<string, unknown> }
      },
      { messageId, lineage: readTruth(harness.dataDir).ownership.lineage, newerData },
    )
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    const projection = () =>
      owner.page.evaluate(
        ({ chatId, messageId }) => {
          const database = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
          const chats = database.characters.flatMap((character) => character.chats) as Array<{
            id?: string
            message?: Array<{ chatId?: string; data?: string }>
          }>
          return chats.find((chat) => chat.id === chatId)?.message?.find((message) => message.chatId === messageId)
            ?.data
        },
        { chatId: CHAT_OWNER, messageId },
      )
    await expect.poll(projection, { timeout: 30_000 }).toBe(newerData)
    await owner.context.route('**/api/v1/chats/**', (route) => route.abort('failed'))
    await owner.context.route('**/api/v1/characters/**', (route) => route.abort('failed'))

    imageProvider.release()
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.filter(
            (effect) => effect.chat_id === CHAT_OWNER && ['pending', 'claimed'].includes(effect.status),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(0)
    expect(
      chatMessages(readTruth(harness.dataDir), CHAT_OWNER).find((message) => message.uid === messageId)?.data,
    ).toBe(newerData)
    await expect.poll(projection, { timeout: 5_000 }).toBe(newerData)
    expect(
      owner.records.filter(
        (record) =>
          record.method === 'PATCH' &&
          record.path === `/api/v1/commands/messages/${encodeURIComponent(messageId)}` &&
          record.body?.expectedData === 'Reply <ImgGen="happy cat">',
      ),
    ).toHaveLength(0)
  } finally {
    provider.releaseAll()
    imageProvider.release()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await Promise.all([closeFastBootstrapHarness(harness), imageProvider.close()])
  }
})

test('held browser image generation keeps translated IGP pending until exact inlay settlement', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <ImgGen="happy cat">'], holdAfterChunk: 1 })
  const igpProvider = await startIgpProvider()
  const imageProvider = await startHeldImageProvider()
  const configuredDatabase = fixture()
  configuredDatabase.igpPrompt = ACCEPTED_IGP_PROMPT
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'accepted-image-key',
    model: 'accepted-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  configuredDatabase.providerCredentials = [
    {
      id: 'accepted-igp-credential',
      name: 'Accepted IGP credential',
      type: 'apiKey',
      apiKey: ACCEPTED_IGP_CREDENTIAL,
    },
  ]
  configuredDatabase.modelProfiles = [
    {
      id: 'accepted-igp-profile',
      name: 'Accepted IGP profile',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'accepted-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_IGP_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
    {
      id: 'accepted-translation-profile',
      name: 'Accepted translation profile',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'accepted-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_TRANSLATION_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
  ]
  configuredDatabase.modelProfileOrder = ['accepted-igp-profile', 'accepted-translation-profile']
  configuredDatabase.modelRoleProfiles = {
    emotion: { mode: 'profile', profileId: 'accepted-igp-profile' },
    translate: { mode: 'profile', profileId: 'accepted-translation-profile' },
  }
  configuredDatabase.translator = 'ko'
  configuredDatabase.translatorInputLanguage = 'en'
  configuredDatabase.translatorType = 'llm'
  configuredDatabase.translatorSendTextAsIs = true
  configuredDatabase.translatorPrompt = 'Translate {{slot::content}}'
  configuredDatabase.translatorMaxResponse = 128
  configuredDatabase.autoTranslateNotificationDeferCapSeconds = 30
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: 'best quality, {{slot}}',
    negative: 'worse quality',
    instructions: '',
    emotionInstructions: '',
  }
  const configuredChat = (configuredCharacter.chats as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === CHAT_OWNER,
  )!
  configuredChat.autoTranslate = true
  configuredChat.autoTranslateBotOnly = true
  const seedText = `Seed for ${CHAT_OWNER}.`
  const seedMessage = (configuredChat.message as Array<Record<string, unknown>>)[0]!
  seedMessage.translation = {
    source: 'raw',
    text: 'Translated seed.',
    sourceHash: createHash('sha256').update(seedText).digest('hex'),
    targetLanguage: 'ko',
    inputLanguage: 'en',
    translatorType: 'llm',
    settingsHash: 'seed-translation-already-present',
    updatedAt: STATIC_LAST_INTERACTION,
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-held-imggen-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    await Promise.all([igpProvider.close(), imageProvider.close()])
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'held-image-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    expect(igpProvider.requests).toEqual([])

    await sendFromUi(owner, 'Generate one held image.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await expect.poll(() => imageProvider.requests.length, { timeout: 30_000 }).toBe(1)
    await imageProvider.started
    await expect
      .poll(() => igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const heldTruth = readTruth(harness.dataDir)
    const operation = heldTruth.operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) =>
              effect.operation_id === operation.operation_id && effect.effect_kind === 'generated_translation',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(() => readInlayPreparation(harness.dataDir, operation.operation_id), { timeout: 30_000 })
      .toMatchObject({
        preparationId: expect.any(String),
        expectedData: 'Reply <ImgGen="happy cat">',
        status: 'pending',
      })
    const heldMessage = readTruth(harness.dataDir).messages.find(
      (candidate) => candidate.uid === operation.result_message_id,
    )!
    expect(heldMessage.data).toBe('Reply <ImgGen="happy cat">')
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(0)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(0)

    imageProvider.release()
    await expect
      .poll(
        () =>
          owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization') && record.status === 200),
        { timeout: 30_000 },
      )
      .toHaveLength(1)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) => effect.operation_id === operation.operation_id && effect.effect_kind === 'igp',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir)
            .effects.filter(
              (effect) =>
                effect.operation_id === operation.operation_id && ['pending', 'claimed'].includes(effect.status),
            )
            .map((effect) => `${effect.effect_kind}:${effect.status}`),
        { timeout: 30_000 },
      )
      .toEqual([])

    const completed = readTruth(harness.dataDir)
    const result = completed.messages.find((candidate) => candidate.uid === operation.result_message_id)!
    const assetMatch = /\{\{inlay::([a-f0-9]{64})\}\}/u.exec(result.data)
    const inlayPreparation = owner.records.find((record) => record.path.endsWith('/igp/inlay-preparation'))!
    const inlayFinalization = owner.records.find((record) => record.path.endsWith('/igp/inlay-finalization'))!
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)).toHaveLength(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(1)
    expect(imageProvider.requests).toHaveLength(1)
    expect(assetMatch?.[1]).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.data).toBe(`Reply {{inlay::${assetMatch?.[1]}}}${ACCEPTED_IGP_SUFFIX}`)
    expect(result.data).not.toContain('<ImgGen=')
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'completed',
    })
    expect(imageProvider.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/images/generations',
      authorization: 'Bearer accepted-image-key',
      body: {
        prompt: 'best quality, happy cat',
        response_format: 'b64_json',
        model: 'accepted-image-model',
      },
    })
    expect(inlayPreparation).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: {
        operationId: operation.operation_id,
        preparationId: expect.any(String),
        expectedData: 'Reply <ImgGen="happy cat">',
      },
    })
    expect(inlayFinalization).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: {
        operationId: operation.operation_id,
        preparationId: inlayPreparation.body?.preparationId,
        expectedData: 'Reply <ImgGen="happy cat">',
        finalData: `Reply {{inlay::${assetMatch?.[1]}}}`,
      },
    })
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('held-imggen-translation-inlay-igp.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          operation,
          providerCounts: {
            main: provider.calls(CHAT_OWNER),
            translation: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)
              .length,
            igp: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL).length,
            image: imageProvider.requests.length,
          },
          imageProviderRequests: imageProvider.requests,
          igpProviderRequests: igpProvider.requests,
          inlayMutations: [inlayPreparation, inlayFinalization].map(({ method, path, headers, body, status }) => ({
            method,
            path,
            headers,
            body,
            status,
          })),
          completed,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('held-imggen-translation-inlay-igp', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    imageProvider.release()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    await Promise.all([igpProvider.close(), imageProvider.close()])
  }
})

test('a completed first ImgGen settlement cannot time out a later provider across regex passes', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, {
    chunks: ['First <ImgGen="fast"> then {{ImgGen="slow"}}'],
    holdAfterChunk: 1,
  })
  const imageProvider = await startSequentialImageProvider()
  const configuredDatabase = fixture()
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'sequential-image-key',
    model: 'sequential-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: 'best quality, {{slot}}',
    negative: 'worse quality',
    instructions: '',
    emotionInstructions: '',
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-sequential-imggen-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    await imageProvider.close()
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'sequential-image-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )

    await owner.page.clock.install()
    await sendFromUi(owner, 'Generate sequential mixed image tags.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await imageProvider.secondStarted
    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    await expect
      .poll(
        () => owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets').length,
        { timeout: 30_000 },
      )
      .toBe(1)
    expect(imageProvider.requests).toHaveLength(2)
    expect(imageProvider.requests.map((request) => request.body.prompt)).toEqual([
      'best quality, fast',
      'best quality, slow',
    ])

    // The retired shared deadline failed here: it started when the first
    // provider returned and aborted the still-running second request at 30s.
    // Advance browser timers only; the held HTTP provider stays real.
    await owner.page.clock.fastForward(31_000)
    expect(imageProvider.secondAborted).toBe(false)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-abandonment'))).toHaveLength(0)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(0)
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toMatchObject({
      preparationId: expect.any(String),
      expectedData: 'First <ImgGen="fast"> then {{ImgGen="slow"}}',
      status: 'pending',
    })

    imageProvider.releaseSecond()
    await expect
      .poll(
        () =>
          owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization') && record.status === 200)
            .length,
        { timeout: 30_000 },
      )
      .toBe(1)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.filter(
            (effect) =>
              effect.operation_id === operation.operation_id && ['pending', 'claimed'].includes(effect.status),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(0)

    const completed = readTruth(harness.dataDir)
    const result = completed.messages.find((candidate) => candidate.uid === operation.result_message_id)!
    const assetIds = [...result.data.matchAll(/\{\{inlay::([a-f0-9]{64})\}\}/gu)].map((match) => match[1])
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(imageProvider.requests).toHaveLength(2)
    expect(owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets')).toHaveLength(
      2,
    )
    expect(assetIds).toHaveLength(2)
    expect(result.data).toBe(`First {{inlay::${assetIds[0]}}} then {{inlay::${assetIds[1]}}}`)
    expect(result.data).not.toMatch(/<ImgGen=|\{\{ImgGen=/u)
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'skipped',
    })
    const occupied = completed.occupancy.find(
      (candidate) => (candidate as { chat_id?: string }).chat_id === CHAT_OWNER,
    ) as { occupancy_epoch: number }
    const released = await directTupleMutation(owner.page, {
      chatId: CHAT_OWNER,
      databaseLineage: completed.ownership.lineage,
      sessionId: owner.sessionId,
      occupancyEpoch: occupied.occupancy_epoch,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } })
    expect(pageErrors).toEqual([])
  } finally {
    provider.releaseAll()
    imageProvider.releaseSecond()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await Promise.all([closeFastBootstrapHarness(harness), imageProvider.close()])
  }
})

test('role loss cancels a held inlay asset upload and releases exact recovery without reload', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <ImgGen="happy cat">'], holdAfterChunk: 1 })
  const igpProvider = await startIgpProvider()
  const imageProvider = await startHeldImageProvider()
  const configuredDatabase = fixture()
  configuredDatabase.igpPrompt = ACCEPTED_IGP_PROMPT
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'cancelled-upload-image-key',
    model: 'cancelled-upload-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  configuredDatabase.providerCredentials = [
    {
      id: 'cancelled-upload-igp-credential',
      name: 'Cancelled upload IGP credential',
      type: 'apiKey',
      apiKey: ACCEPTED_IGP_CREDENTIAL,
    },
  ]
  configuredDatabase.modelProfiles = [
    {
      id: 'cancelled-upload-igp-profile',
      name: 'Cancelled upload IGP',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'cancelled-upload-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_IGP_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
    {
      id: 'cancelled-upload-translation-profile',
      name: 'Cancelled upload translation',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'cancelled-upload-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_TRANSLATION_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
  ]
  configuredDatabase.modelProfileOrder = ['cancelled-upload-igp-profile', 'cancelled-upload-translation-profile']
  configuredDatabase.modelRoleProfiles = {
    emotion: { mode: 'profile', profileId: 'cancelled-upload-igp-profile' },
    translate: { mode: 'profile', profileId: 'cancelled-upload-translation-profile' },
  }
  configuredDatabase.translator = 'ko'
  configuredDatabase.translatorInputLanguage = 'en'
  configuredDatabase.translatorType = 'llm'
  configuredDatabase.translatorSendTextAsIs = true
  configuredDatabase.translatorPrompt = 'Translate {{slot::content}}'
  configuredDatabase.translatorMaxResponse = 128
  configuredDatabase.autoTranslateNotificationDeferCapSeconds = 30
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: 'best quality, {{slot}}',
    negative: 'worse quality',
    instructions: '',
    emotionInstructions: '',
  }
  const configuredChat = (configuredCharacter.chats as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === CHAT_OWNER,
  )!
  configuredChat.autoTranslate = true
  configuredChat.autoTranslateBotOnly = true
  const seedText = `Seed for ${CHAT_OWNER}.`
  const seedMessage = (configuredChat.message as Array<Record<string, unknown>>)[0]!
  seedMessage.translation = {
    source: 'raw',
    text: 'Translated seed.',
    sourceHash: createHash('sha256').update(seedText).digest('hex'),
    targetLanguage: 'ko',
    inputLanguage: 'en',
    translatorType: 'llm',
    settingsHash: 'cancelled-upload-seed-translation',
    updatedAt: STATIC_LAST_INTERACTION,
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-cancelled-inlay-upload-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    await Promise.all([igpProvider.close(), imageProvider.close()])
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  let releaseUpload!: () => void
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  let uploadStarted = false
  try {
    const owner = await createClient(browser, 'cancelled-upload-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(`${owner.name}: ${error.message}`))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await owner.context.route('**/api/v1/assets', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      uploadStarted = true
      await uploadGate
      await route.continue().catch(() => undefined)
    })

    await sendFromUi(owner, 'Cancel the held upload after its provider.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await imageProvider.started
    await expect
      .poll(() => igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) =>
              effect.operation_id === operation.operation_id && effect.effect_kind === 'generated_translation',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(() => readInlayPreparation(harness.dataDir, operation.operation_id), { timeout: 30_000 })
      .toMatchObject({
        preparationId: expect.any(String),
        expectedData: 'Reply <ImgGen="happy cat">',
        status: 'pending',
      })
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(0)

    imageProvider.release()
    await expect.poll(() => uploadStarted, { timeout: 30_000 }).toBe(true)
    expect(owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets')).toHaveLength(
      1,
    )
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(0)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(0)

    const successor = await createClient(browser, 'cancelled-upload-successor')
    clients.push(successor)
    successor.page.on('pageerror', (error) => pageErrors.push(`${successor.name}: ${error.message}`))
    await bootReader(successor, harness, CHAT_OBSERVER)
    const writerEpoch = readTruth(harness.dataDir).ownership.writer_epoch
    await promoteViaUi(successor, owner, harness.dataDir, writerEpoch + 1)
    await expectOccupancyState(owner.page, 'normalization-required')
    const normalize = owner.page.locator('[data-reader-occupancy-normalize]')
    await expect(normalize).toBeEnabled()
    await normalize.click()
    await expectOccupancyState(owner.page, 'self-owned')

    await expect
      .poll(
        () =>
          owner.records.filter((record) => record.path.endsWith('/igp/inlay-abandonment') && record.status === 200)
            .length,
        { timeout: 30_000 },
      )
      .toBe(1)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(0)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir)
            .effects.filter(
              (effect) =>
                effect.operation_id === operation.operation_id && ['pending', 'claimed'].includes(effect.status),
            )
            .map((effect) => `${effect.effect_kind}:${effect.status}`),
        { timeout: 30_000 },
      )
      .toEqual([])

    const completed = readTruth(harness.dataDir)
    const result = completed.messages.find((message) => message.uid === operation.result_message_id)!
    const operationEffects = completed.effects.filter((effect) => effect.operation_id === operation.operation_id)
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(imageProvider.requests).toHaveLength(1)
    expect(owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets')).toHaveLength(
      1,
    )
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)).toHaveLength(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(1)
    expect(result.data).toBe(`Reply <ImgGen="happy cat">${ACCEPTED_IGP_SUFFIX}`)
    expect(operationEffects.filter((effect) => ['pending', 'claimed'].includes(effect.status))).toHaveLength(0)
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'completed',
    })

    const occupied = completed.occupancy.find(
      (candidate) => (candidate as { chat_id?: string }).chat_id === CHAT_OWNER,
    ) as { occupancy_epoch: number }
    const released = await directTupleMutation(owner.page, {
      chatId: CHAT_OWNER,
      databaseLineage: completed.ownership.lineage,
      sessionId: owner.sessionId,
      occupancyEpoch: occupied.occupancy_epoch,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } })
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('role-loss-held-inlay-upload.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          operation,
          providerCounts: {
            main: provider.calls(CHAT_OWNER),
            image: imageProvider.requests.length,
            upload: owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets')
              .length,
            translation: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)
              .length,
            igp: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL).length,
          },
          inlayMutations: owner.records
            .filter((record) => /\/igp\/inlay-(?:preparation|finalization|abandonment)$/u.test(record.path))
            .map(({ method, path, headers, body, status }) => ({ method, path, headers, body, status })),
          completed,
          released,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('role-loss-held-inlay-upload', {
      path: evidencePath,
      contentType: 'application/json',
    })
    releaseUpload()
  } finally {
    releaseUpload()
    provider.releaseAll()
    imageProvider.release()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    await Promise.all([igpProvider.close(), imageProvider.close()])
  }
})

test('held inlay preparation acknowledgement blocks translated recovery until exact settlement', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <Emotion="happy">'], holdAfterChunk: 1 })
  let releaseTranslation!: () => void
  const translationGate = new Promise<void>((resolve) => {
    releaseTranslation = resolve
  })
  const igpProvider = await startIgpProvider({ translationGate })
  const configuredDatabase = fixture()
  configuredDatabase.igpPrompt = ACCEPTED_IGP_PROMPT
  configuredDatabase.providerCredentials = [
    {
      id: 'held-ack-credential',
      name: 'Held acknowledgement credential',
      type: 'apiKey',
      apiKey: ACCEPTED_IGP_CREDENTIAL,
    },
  ]
  configuredDatabase.modelProfiles = [
    {
      id: 'held-ack-igp-profile',
      name: 'Held acknowledgement IGP',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'held-ack-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_IGP_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
    {
      id: 'held-ack-translation-profile',
      name: 'Held acknowledgement translation',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'held-ack-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_TRANSLATION_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
  ]
  configuredDatabase.modelProfileOrder = ['held-ack-igp-profile', 'held-ack-translation-profile']
  configuredDatabase.modelRoleProfiles = {
    emotion: { mode: 'profile', profileId: 'held-ack-igp-profile' },
    translate: { mode: 'profile', profileId: 'held-ack-translation-profile' },
  }
  configuredDatabase.translator = 'ko'
  configuredDatabase.translatorInputLanguage = 'en'
  configuredDatabase.translatorType = 'llm'
  configuredDatabase.translatorSendTextAsIs = true
  configuredDatabase.translatorPrompt = 'Translate {{slot::content}}'
  configuredDatabase.translatorMaxResponse = 128
  configuredDatabase.autoTranslateNotificationDeferCapSeconds = 1
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'emotion'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.emotionImages = [['happy', 'happy.png']]
  const configuredChat = (configuredCharacter.chats as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === CHAT_OWNER,
  )!
  configuredChat.autoTranslate = true
  configuredChat.autoTranslateBotOnly = true
  const seedText = `Seed for ${CHAT_OWNER}.`
  const seedMessage = (configuredChat.message as Array<Record<string, unknown>>)[0]!
  seedMessage.translation = {
    source: 'raw',
    text: 'Translated seed.',
    sourceHash: createHash('sha256').update(seedText).digest('hex'),
    targetLanguage: 'ko',
    inputLanguage: 'en',
    translatorType: 'llm',
    settingsHash: 'held-ack-seed-translation',
    updatedAt: STATIC_LAST_INTERACTION,
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-held-preparation-ack-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    releaseTranslation()
    await igpProvider.close()
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  let releasePreparation!: () => void
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve
  })
  let heldPreparation = false
  try {
    const owner = await createClient(browser, 'held-preparation-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await owner.context.route('**/api/v1/generation-effects/*/igp/inlay-preparation', async (route) => {
      heldPreparation = true
      await preparationGate
      await route.continue()
    })

    await sendFromUi(owner, 'Reserve before recovered IGP.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await expect.poll(() => heldPreparation, { timeout: 30_000 }).toBe(true)
    await expect
      .poll(() => igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    const bootstrapCountBeforeTranslation = owner.records.filter(
      (record) => record.method === 'GET' && record.path === '/api/v1/bootstrap',
    ).length

    releaseTranslation()
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) =>
              effect.operation_id === operation.operation_id && effect.effect_kind === 'generated_translation',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(
        () => owner.records.filter((record) => record.method === 'GET' && record.path === '/api/v1/bootstrap').length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(bootstrapCountBeforeTranslation)

    const heldTruth = readTruth(harness.dataDir)
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'pending',
    })
    expect(
      heldTruth.effects.find((effect) => effect.operation_id === operation.operation_id && effect.effect_kind === 'igp')
        ?.status,
    ).toBe('pending')
    expect(heldTruth.messages.find((message) => message.uid === operation.result_message_id)?.data).toBe(
      'Reply <Emotion="happy">',
    )
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(0)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/claims'))).toHaveLength(0)

    releasePreparation()
    await expect
      .poll(
        () =>
          owner.records.filter((record) => record.path.endsWith('/igp/inlay-preparation') && record.status === 200)
            .length,
        { timeout: 30_000 },
      )
      .toBe(1)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) => effect.operation_id === operation.operation_id && effect.effect_kind === 'igp',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.filter(
            (effect) =>
              effect.operation_id === operation.operation_id && ['pending', 'claimed'].includes(effect.status),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(0)

    const completed = readTruth(harness.dataDir)
    const result = completed.messages.find((message) => message.uid === operation.result_message_id)!
    const operationEffects = completed.effects.filter((effect) => effect.operation_id === operation.operation_id)
    const generationRequests = owner.records.filter((record) => record.path.includes('/generation-effects/'))
    const preparations = generationRequests.filter((record) => record.path.endsWith('/igp/inlay-preparation'))
    const preparation = preparations.find((record) => record.status === 200)!
    const finalization = generationRequests.find((record) => record.path.endsWith('/igp/inlay-finalization'))!
    const claim = generationRequests.find((record) => record.path.endsWith('/igp/claims'))!
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)).toHaveLength(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(1)
    expect(result.data).toBe(`Reply {{emotion::happy}}${ACCEPTED_IGP_SUFFIX}`)
    expect(result.data).not.toContain('<Emotion=')
    expect(operationEffects.filter((effect) => ['pending', 'claimed'].includes(effect.status))).toHaveLength(0)
    // Translation advanced the shared revision while Chromium deliberately
    // held the first request. The client replays the same stable preparation
    // identity once, rather than starting another provider obligation.
    expect(preparations.map((record) => record.status)).toEqual([409, 200])
    expect(new Set(preparations.map((record) => record.body?.preparationId)).size).toBe(1)
    expect(generationRequests.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(1)
    expect(generationRequests.indexOf(preparation)).toBeLessThan(generationRequests.indexOf(finalization))
    expect(generationRequests.indexOf(finalization)).toBeLessThan(generationRequests.indexOf(claim))
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'completed',
    })
    expect(pageErrors).toEqual([])

    const occupied = completed.occupancy.find(
      (candidate) => (candidate as { chat_id?: string }).chat_id === CHAT_OWNER,
    ) as { occupancy_epoch: number }
    const released = await directTupleMutation(owner.page, {
      chatId: CHAT_OWNER,
      databaseLineage: completed.ownership.lineage,
      sessionId: owner.sessionId,
      occupancyEpoch: occupied.occupancy_epoch,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } })

    const evidencePath = testInfo.outputPath('held-preparation-translation-inlay-igp.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          operation,
          heldTruth,
          completed,
          providerCounts: {
            main: provider.calls(CHAT_OWNER),
            translation: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)
              .length,
            igp: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL).length,
          },
          generationRequests,
          released,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('held-preparation-translation-inlay-igp', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    releaseTranslation()
    releasePreparation()
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    await igpProvider.close()
  }
})
