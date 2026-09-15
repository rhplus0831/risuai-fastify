import { devices, expect, test, type Request, type Route } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { closeFastBootstrapHarness } from './fastBootstrapHarness.js'
import {
  CHAT_OBSERVER,
  ACCEPTED_IGP_PROMPT,
  ACCEPTED_IGP_SUFFIX,
  ACCEPTED_IGP_INPUT_ROW,
  ACCEPTED_IGP_MODEL,
  ACCEPTED_IGP_CREDENTIAL,
  ACCEPTED_TRANSLATION_MODEL,
  ACCEPTED_TRANSLATION,
  CLEARED_MODEL_ROLE_PROFILES,
  OccupancyProvider,
  startIgpProvider,
  type Client,
  fixture,
  readTruth,
  readSharedMutationBoundary,
  readCurrentSettings,
  startHarness,
  createClient,
  waitForHook,
  bootOwner,
  bootReader,
  configureChats,
  directTupleMutation,
  patchOwnerSettings,
  expectOccupancyState,
  claimFromUi,
  sendFromUi,
  chatMessages,
  expectCompleted,
  auditChatOnlyMutations,
} from './chatOccupancyHarness.js'

test('configured chat-only IGP commits atomically once when its response and receipt are lost', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OBSERVER, { chunks: ['Configured IGP source.'] })
  const igpProvider = await startIgpProvider()
  const configuredDatabase = fixture()
  configuredDatabase.igpPrompt = ACCEPTED_IGP_PROMPT
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
  configuredCharacter.triggerscript = [
    {
      comment: '',
      type: 'input',
      conditions: [],
      effect: [
        {
          type: 'triggerlua',
          code: `
            function onInput(triggerId)
              addChat(triggerId, 'char', '${ACCEPTED_IGP_INPUT_ROW}')
            end
          `,
        },
      ],
    },
  ]
  const configuredChat = (configuredCharacter.chats as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === CHAT_OBSERVER,
  )!
  configuredChat.autoTranslate = true
  const harness = await startHarness(provider, 'risu-chat-occupancy-configured-igp-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    await igpProvider.close()
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'owner')
    const sender = await createClient(browser, 'igp-sender', devices['Pixel 7'])
    clients.push(owner, sender)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_OBSERVER)
    await configureChats(owner.page)
    await bootReader(sender, harness, CHAT_OBSERVER)
    await claimFromUi(sender)
    const senderMutationAuditStart = sender.records.length
    const serverStatuses = new Map<Request, number>()
    const completionExecutions: Array<{
      request: Request
      status: number
      headers: Record<string, string>
      body: Record<string, unknown>
      response: Record<string, unknown>
    }> = []
    let lostCommit:
      | {
          request: Request
          status: number
          headers: Record<string, string>
          body: Record<string, unknown>
          response: Record<string, unknown>
        }
      | undefined
    let lostReceipt:
      | {
          request: Request
          status: number
          headers: Record<string, string>
          body: Record<string, unknown>
          response: Record<string, unknown>
        }
      | undefined
    let resolveLostCommit!: () => void
    let resolveLostReceipt!: () => void
    const commitReached = new Promise<void>((resolve) => {
      resolveLostCommit = resolve
    })
    const receiptReached = new Promise<void>((resolve) => {
      resolveLostReceipt = resolve
    })
    let commitTransports = 0
    let receiptTransports = 0
    let resolveHeldIgpClaim!: () => void
    let releaseHeldIgpClaim!: () => void
    const igpClaimIntercepted = new Promise<void>((resolve) => {
      resolveHeldIgpClaim = resolve
    })
    const heldIgpClaimRelease = new Promise<void>((resolve) => {
      releaseHeldIgpClaim = resolve
    })
    const holdProductionIgpClaim = async (route: Route) => {
      resolveHeldIgpClaim()
      await heldIgpClaimRelease
      await route.continue()
    }
    const observeProductionCompletion = async (route: Route) => {
      const request = route.request()
      const response = await route.fetch()
      const body = (await response.json()) as Record<string, unknown>
      completionExecutions.push({
        request,
        status: response.status(),
        headers: request.headers(),
        body: request.postDataJSON() as Record<string, unknown>,
        response: body,
      })
      await route.fulfill({ response })
    }
    const loseProductionCommitResponse = async (route: Route) => {
      commitTransports += 1
      if (commitTransports > 1) return route.continue()
      const request = route.request()
      const response = await route.fetch()
      lostCommit = {
        request,
        status: response.status(),
        headers: request.headers(),
        body: request.postDataJSON() as Record<string, unknown>,
        response: (await response.json()) as Record<string, unknown>,
      }
      serverStatuses.set(request, response.status())
      resolveLostCommit()
      await route.abort('connectionclosed')
    }
    const loseProductionReceiptResponse = async (route: Route) => {
      receiptTransports += 1
      if (receiptTransports > 1) return route.continue()
      const request = route.request()
      const response = await route.fetch()
      lostReceipt = {
        request,
        status: response.status(),
        headers: request.headers(),
        body: request.postDataJSON() as Record<string, unknown>,
        response: (await response.json()) as Record<string, unknown>,
      }
      serverStatuses.set(request, response.status())
      resolveLostReceipt()
      await route.abort('connectionclosed')
    }
    await sender.context.route('**/api/v1/generation-effects/*/igp/completion', observeProductionCompletion)
    await sender.context.route('**/api/v1/generation-effects/*/igp/commit', loseProductionCommitResponse)
    await sender.context.route('**/api/v1/generation-effects/*/igp/receipt', loseProductionReceiptResponse)
    await sender.context.route('**/api/v1/generation-effects/*/igp/claims', holdProductionIgpClaim)

    await sendFromUi(sender, 'Run configured IGP.')
    await igpClaimIntercepted
    await expect.poll(() => provider.calls(CHAT_OBSERVER)).toBe(1)
    await expect
      .poll(() => {
        const truth = readTruth(harness.dataDir)
        const operation = truth.operations.find((candidate) => candidate.chat_id === CHAT_OBSERVER)
        return truth.effects.find(
          (candidate) =>
            candidate.operation_id === operation?.operation_id && candidate.effect_kind === 'generated_translation',
        )?.status
      })
      .toBe('completed')
    const acceptedBeforeSettingsMutation = readTruth(harness.dataDir)
    const acceptedOperation = acceptedBeforeSettingsMutation.operations.find(
      (candidate) => candidate.chat_id === CHAT_OBSERVER,
    )!
    expect(acceptedOperation).toMatchObject({
      state: 'completed',
      admission_kind: 'chat_only',
      occupancy_session_id: sender.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'chat_only',
      accepted_message_id: expect.any(String),
      result_message_id: expect.any(String),
    })
    expect(
      chatMessages(acceptedBeforeSettingsMutation, CHAT_OBSERVER).map(({ role, data, uid }) => ({
        role,
        data,
        uid,
      })),
    ).toEqual([
      { role: 'char', data: `Seed for ${CHAT_OBSERVER}.`, uid: `seed-${CHAT_OBSERVER}` },
      { role: 'char', data: ACCEPTED_IGP_INPUT_ROW, uid: expect.any(String) },
      { role: 'user', data: 'Run configured IGP.', uid: acceptedOperation.accepted_message_id },
      { role: 'char', data: 'Configured IGP source.', uid: acceptedOperation.result_message_id },
    ])
    const translatedResultBeforeIgp = acceptedBeforeSettingsMutation.messages.find(
      (message) => message.uid === acceptedOperation.result_message_id,
    )!
    const translatedResultJson = JSON.parse(translatedResultBeforeIgp.json) as Record<string, unknown>
    expect(translatedResultJson.translation).toEqual({
      source: 'raw',
      text: ACCEPTED_TRANSLATION,
      sourceHash: createHash('sha256').update('Configured IGP source.').digest('hex'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      updatedAt: expect.any(Number),
    })
    const translatedEffectBeforeIgp = acceptedBeforeSettingsMutation.effects.find(
      (candidate) =>
        candidate.operation_id === acceptedOperation.operation_id && candidate.effect_kind === 'generated_translation',
    )!
    expect(translatedEffectBeforeIgp).toEqual({
      operation_id: acceptedOperation.operation_id,
      generation_id: expect.any(String),
      chat_id: CHAT_OBSERVER,
      message_id: acceptedOperation.result_message_id,
      effect_kind: 'generated_translation',
      effect_class: 'durable',
      status: 'completed',
      claim_id: expect.any(String),
      delivery: 'server',
      reason: null,
    })
    expect(completionExecutions).toEqual([])

    await patchOwnerSettings(owner.page, 'providers', {
      providerCredentials: [],
      modelProfiles: [],
      modelProfileOrder: [],
      modelRoleProfiles: {},
    })
    await expect
      .poll(() => {
        const settings = readCurrentSettings(harness.dataDir)
        return {
          igpPrompt: settings.igpPrompt,
          providerCredentials: settings.providerCredentials,
          modelProfiles: settings.modelProfiles,
          modelProfileOrder: settings.modelProfileOrder,
          modelRoleProfiles: settings.modelRoleProfiles,
        }
      })
      .toEqual({
        igpPrompt: ACCEPTED_IGP_PROMPT,
        providerCredentials: [],
        modelProfiles: [],
        modelProfileOrder: [],
        modelRoleProfiles: CLEARED_MODEL_ROLE_PROFILES,
      })
    const settingsAfterMutation = readCurrentSettings(harness.dataDir)
    const sharedAfterOwnerMutation = readSharedMutationBoundary(harness.dataDir)
    expect(completionExecutions).toEqual([])

    releaseHeldIgpClaim()
    await expect.poll(() => completionExecutions.length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => commitTransports, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => receiptTransports, { timeout: 30_000 }).toBe(1)
    await Promise.all([commitReached, receiptReached])
    await expectCompleted(harness.dataDir, CHAT_OBSERVER)
    expect(provider.calls(CHAT_OBSERVER)).toBe(1)
    const completed = readTruth(harness.dataDir)
    const operation = completed.operations.find((candidate) => candidate.chat_id === CHAT_OBSERVER)!
    const result = completed.messages.find((message) => message.uid === operation.result_message_id)!
    const igp = completed.effects.find(
      (candidate) => candidate.operation_id === operation.operation_id && candidate.effect_kind === 'igp',
    )!
    expect(igp).toMatchObject({
      generation_id: expect.any(String),
      message_id: result.uid,
      status: 'completed',
      claim_id: expect.any(String),
      reason: null,
    })
    const generationId = String(igp.generation_id)
    const claimId = String(igp.claim_id)
    const committedData = `Configured IGP source.${ACCEPTED_IGP_SUFFIX}`
    expect(igpProvider.requests).toHaveLength(4)
    const translationProviderRequests = igpProvider.requests.filter(
      (request) => request.body.model === ACCEPTED_TRANSLATION_MODEL,
    )
    const igpProviderRequests = igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)
    // The connected owner auto-translates ordinary newly exposed rows, while
    // the generated result remains owned by the durable server effect above.
    expect(translationProviderRequests).toHaveLength(3)
    expect(
      translationProviderRequests
        .map(({ method, path, authorization, body }) => ({
          method,
          path,
          authorization,
          model: body.model,
          stream: body.stream,
          messages: body.messages,
        }))
        .sort((left, right) => JSON.stringify(left.messages).localeCompare(JSON.stringify(right.messages))),
    ).toEqual([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        authorization: `Bearer ${ACCEPTED_IGP_CREDENTIAL}`,
        model: ACCEPTED_TRANSLATION_MODEL,
        stream: false,
        messages: [{ role: 'system', content: 'Translate Configured IGP source.' }],
      },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        authorization: `Bearer ${ACCEPTED_IGP_CREDENTIAL}`,
        model: ACCEPTED_TRANSLATION_MODEL,
        stream: false,
        messages: [{ role: 'system', content: `Translate ${ACCEPTED_IGP_INPUT_ROW}` }],
      },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        authorization: `Bearer ${ACCEPTED_IGP_CREDENTIAL}`,
        model: ACCEPTED_TRANSLATION_MODEL,
        stream: false,
        messages: [{ role: 'system', content: 'Translate Run configured IGP.' }],
      },
    ])
    expect(igpProviderRequests).toHaveLength(1)
    expect(igpProviderRequests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      authorization: `Bearer ${ACCEPTED_IGP_CREDENTIAL}`,
      body: {
        model: ACCEPTED_IGP_MODEL,
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'Last=Configured IGP source.; Char=Configured IGP source.; Index=3',
          },
        ],
      },
    })
    expect(JSON.stringify(igpProviderRequests[0].body)).not.toContain('Run configured IGP.')
    expect(JSON.stringify(igpProviderRequests[0].body)).not.toContain(`Seed for ${CHAT_OBSERVER}.`)
    expect(JSON.stringify(igpProviderRequests[0].body)).not.toContain(ACCEPTED_IGP_INPUT_ROW)
    expect(JSON.stringify(igpProviderRequests[0].body)).not.toContain(ACCEPTED_TRANSLATION)
    expect(completionExecutions).toHaveLength(1)
    expect(completionExecutions[0]).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': sender.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: { claimId },
      response: { type: 'success', result: ACCEPTED_IGP_SUFFIX },
    })
    expect(lostCommit).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': sender.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: {
        baseRevision: expect.any(Number),
        claimId,
        data: committedData,
        expectedData: 'Configured IGP source.',
        expectedGenerationId: generationId,
      },
      response: {
        revision: expect.any(Number),
        chatId: CHAT_OBSERVER,
        messageId: result.uid,
        effect: { status: 'completed', claimId },
      },
    })
    expect(lostReceipt).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': sender.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: { claimId, status: 'completed' },
      response: { effect: { status: 'completed', claimId } },
    })
    expect(result.data).toBe(committedData)
    expect((JSON.parse(result.json) as Record<string, unknown>).translation).toBeNull()
    expect(readTruth(harness.dataDir).effects.filter((candidate) => candidate.generation_id === generationId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ effect_kind: 'igp', status: 'completed', claim_id: claimId }),
        expect.objectContaining({
          effect_kind: 'plugin_output',
          status: 'skipped',
          reason: 'unsupported_chat_only_scope',
        }),
        expect.objectContaining({
          effect_kind: 'emotion_image_state',
          status: 'skipped',
          reason: 'unsupported_chat_only_scope',
        }),
      ]),
    )

    const newerDraft = 'IGP recovery must not replace this newer draft.'
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toBeEnabled()
    await sender.page.locator('[data-reader-composer-field="message"]').fill(newerDraft)
    await Promise.all([
      sender.context.unroute('**/api/v1/generation-effects/*/igp/completion', observeProductionCompletion),
      sender.context.unroute('**/api/v1/generation-effects/*/igp/commit', loseProductionCommitResponse),
      sender.context.unroute('**/api/v1/generation-effects/*/igp/receipt', loseProductionReceiptResponse),
      sender.context.unroute('**/api/v1/generation-effects/*/igp/claims', holdProductionIgpClaim),
    ])
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', CHAT_OBSERVER)
    await expectOccupancyState(sender.page, 'self-owned')
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toHaveValue(newerDraft)
    await expect(
      sender.page.locator(`.risu-chat[data-risu-message-id="${result.uid}"] .chat-message-body`),
    ).toContainText(committedData)
    await expect
      .poll(() =>
        readTruth(harness.dataDir)
          .effects.filter((candidate) => candidate.operation_id === operation.operation_id)
          .every((candidate) => ['completed', 'skipped', 'failed'].includes(candidate.status)),
      )
      .toBe(true)
    expect(completionExecutions).toHaveLength(1)
    expect(commitTransports).toBe(1)
    expect(receiptTransports).toBe(1)
    expect(provider.calls(CHAT_OBSERVER)).toBe(1)
    expect(igpProvider.requests).toHaveLength(4)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)).toHaveLength(3)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(1)
    const settingsAfterReload = readCurrentSettings(harness.dataDir)
    expect({
      igpPrompt: settingsAfterReload.igpPrompt,
      providerCredentials: settingsAfterReload.providerCredentials,
      modelProfiles: settingsAfterReload.modelProfiles,
      modelProfileOrder: settingsAfterReload.modelProfileOrder,
      modelRoleProfiles: settingsAfterReload.modelRoleProfiles,
    }).toEqual({
      igpPrompt: ACCEPTED_IGP_PROMPT,
      providerCredentials: [],
      modelProfiles: [],
      modelProfileOrder: [],
      modelRoleProfiles: CLEARED_MODEL_ROLE_PROFILES,
    })
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedAfterOwnerMutation)

    const terminalTruth = readTruth(harness.dataDir)
    const automaticTranslationConflicts = clients
      .flatMap((client) => client.records)
      .filter(
        (record) =>
          record.path === `/api/v1/commands/messages/${acceptedOperation.result_message_id}/translate` &&
          record.body?.automatic === true,
      )
      .map((record) => ({ automatic: record.body?.automatic, status: record.status }))
    // A client that observes the raw row before the server translation settles
    // may race one automatic request, which must be rejected. If the server-
    // authored translation hydrates first, the client suppresses that request.
    expect(automaticTranslationConflicts.length).toBeLessThanOrEqual(1)
    expect(automaticTranslationConflicts.every((record) => record.automatic === true && record.status === 409)).toBe(
      true,
    )
    const auditedRecords = sender.records.slice(senderMutationAuditStart).map((record) => {
      const serverStatus = serverStatuses.get(record.request)
      return serverStatus === undefined ? record : { ...record, status: serverStatus }
    })
    const senderMutationAudit = auditChatOnlyMutations({ ...sender, records: auditedRecords }, terminalTruth, [
      CHAT_OBSERVER,
    ])
    expect(senderMutationAudit.violations).toEqual([])
    expect(
      senderMutationAudit.authorizedEffects.filter(
        (effect) => effect.generationId === generationId && effect.effectKind === 'igp',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'claims', operationId: operation.operation_id, messageId: result.uid }),
        expect.objectContaining({ action: 'completion', operationId: operation.operation_id, messageId: result.uid }),
        expect.objectContaining({ action: 'commit', operationId: operation.operation_id, messageId: result.uid }),
        expect.objectContaining({ action: 'receipt', operationId: operation.operation_id, messageId: result.uid }),
      ]),
    )
    const occupancy = readTruth(harness.dataDir).occupancy.find(
      (candidate) => (candidate as Record<string, unknown>).chat_id === CHAT_OBSERVER,
    ) as Record<string, unknown>
    const released = await directTupleMutation(sender.page, {
      chatId: CHAT_OBSERVER,
      databaseLineage: completed.ownership.lineage,
      sessionId: sender.sessionId,
      occupancyEpoch: Number(occupancy.occupancy_epoch),
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } })
    expect(provider.calls(CHAT_OBSERVER)).toBe(1)
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-configured-igp.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          acceptedBeforeSettingsMutation,
          settingsAfterMutation: {
            igpPrompt: settingsAfterMutation.igpPrompt,
            providerCredentials: settingsAfterMutation.providerCredentials,
            modelProfiles: settingsAfterMutation.modelProfiles,
            modelProfileOrder: settingsAfterMutation.modelProfileOrder,
            modelRoleProfiles: settingsAfterMutation.modelRoleProfiles,
          },
          igpProviderRequests: igpProvider.requests,
          operation,
          completionExecutions: completionExecutions.map(({ request: _request, ...execution }) => execution),
          lostCommit: lostCommit ? { ...lostCommit, request: undefined } : undefined,
          lostReceipt: lostReceipt ? { ...lostReceipt, request: undefined } : undefined,
          transportCounts: { commit: commitTransports, receipt: receiptTransports },
          committedData,
          newerDraft,
          automaticTranslationConflicts,
          mutationAudit: senderMutationAudit,
          released,
          providerCalls: provider.calls(CHAT_OBSERVER),
          truth: terminalTruth,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-configured-igp', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    await igpProvider.close()
  }
})
