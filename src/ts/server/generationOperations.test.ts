import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { GenerationOperationProjection } from './bootstrap'

const operationMocks = vi.hoisted(() => ({
  acknowledgeHydratedRecoveries: vi.fn(),
  appendOptimistic: vi.fn(),
  applyAcceptedJobs: vi.fn(),
  applyAcceptedOperation: vi.fn(),
  applyAcceptedBootstrap: vi.fn(),
  beginDispatch: vi.fn(),
  discard: vi.fn(),
  getBaseRevision: vi.fn(),
  isWriterAccessLost: vi.fn(),
  listPending: vi.fn(),
  peekRevision: vi.fn(),
  reconcileDirectEvent: vi.fn(),
  setRevision: vi.fn(),
  stage: vi.fn(),
  canApplyActiveJobs: vi.fn(() => true),
  setActiveJobs: vi.fn(() => true),
  withDirectReconciliation: vi.fn(),
}))

vi.mock('../chatCommands', () => ({
  appendOptimisticGenerationOperationUserMessage: operationMocks.appendOptimistic,
  toMessageSnapshot: (message: unknown) => structuredClone(message),
}))
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: vi.fn(async () => 'auth-a') }))
vi.mock('../process/acceptedSendRecoveryState', () => ({
  acknowledgeHydratedAcceptedSendRecoveries: operationMocks.acknowledgeHydratedRecoveries,
  applyAcceptedSendActiveJobProjection: operationMocks.applyAcceptedJobs,
  applyAcceptedSendBootstrapProjection: operationMocks.applyAcceptedBootstrap,
  applyAcceptedSendOperationProjection: operationMocks.applyAcceptedOperation,
  clearAcceptedSendRecoveryProjection: vi.fn(),
}))
vi.mock('../process/reattach', () => ({
  authoritativeGenerationJobForChat: vi.fn(),
  canApplyActiveGenerationJobProjection: operationMocks.canApplyActiveJobs,
  clearActiveGenerationJobProjection: vi.fn(),
  forgetActiveGenerationJob: vi.fn(),
  rememberActiveGenerationJob: vi.fn(),
  setActiveGenerationJobs: operationMocks.setActiveJobs,
}))
vi.mock('./activeWriterSession', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-a' }),
  handleActiveWriterStaleResponse: vi.fn(),
  isWriterAccessLost: operationMocks.isWriterAccessLost,
}))
vi.mock('./commands', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-a' }),
  getServerCommandBaseRevision: operationMocks.getBaseRevision,
  peekCachedServerCommandRevision: operationMocks.peekRevision,
  setCachedServerCommandRevision: operationMocks.setRevision,
  SERVER_DATABASE_LINEAGE_HEADER: 'risu-database-lineage',
  withDirectServerCommandEventReconciliation: operationMocks.withDirectReconciliation,
}))
vi.mock('./resourceState.svelte', () => ({ captureChatBodyProjectionEpoch: () => 12 }))
vi.mock('./chatTranscriptOwner', () => ({
  getChatTranscriptOwnerState: () => ({
    characterId: 'character-a',
    chatId: 'chat-a',
    messages: [],
    projectionEpoch: 12,
    resourceLoaded: true,
  }),
}))
vi.mock('./pendingMutationOutbox', () => ({
  beginPendingMutationDispatch: operationMocks.beginDispatch,
  discardPendingMutation: operationMocks.discard,
  isGenerationOperationPendingIntent: (intent: { kind?: string }) =>
    intent.kind === 'generation-operation-submit' ||
    intent.kind === 'generation-operation-cancel' ||
    intent.kind === 'generation-operation-retry',
  listPendingMutations: operationMocks.listPending,
  stagePendingMutation: operationMocks.stage,
}))
vi.mock('./bootstrap', () => ({
  parseGenerationOperations: (values: unknown[]) =>
    values.filter(
      (value): value is Record<string, unknown> =>
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).operationId === 'string',
    ),
}))

import {
  applyGenerationOperationBootstrap,
  applyGenerationOperationProjection,
  applyGenerationOperationSseEvent,
  captureGenerationOperationViewerFence,
  dispatchGenerationOperationPendingReplay,
  generationOperationCancellations,
  generationOperationProjections,
  reconcileGenerationOperationErrorBody,
  reconcileGenerationOperationTranscriptHydration,
  registerGenerationOperationViewer,
  replayGenerationRecoveryObligations,
  retireGenerationOperationViewers,
  resetGenerationOperationClientForTests,
  retryGenerationOperation,
  stageAcceptedSendGenerationOperation,
  stageTargetedGenerationOperation,
  stopGenerationOperation,
  submitStagedAcceptedSendOperation,
  submitStagedTargetedGenerationOperation,
} from './generationOperations'
import {
  beginGenerationRecoveryObligation,
  captureGenerationRecoveryObligations,
  markGenerationRecoveryObligationUncertain,
  resetGenerationRecoveryObligations,
} from '../process/generationRecoveryObligations'
import {
  recordStartupMilestone,
  resetStartupReadinessForTests,
  settleStartupChatReadiness,
  settleStartupGenerationRecoveryReadiness,
} from '../startupReadiness'

const operationId = '11111111-1111-4111-8111-111111111111'
const messageId = '22222222-2222-4222-8222-222222222222'

function responseBody(state: GenerationOperationProjection['state'] = 'owned_by_job'): {
  operation: GenerationOperationProjection
  append: {
    disposition: 'accepted'
    messageId: string
    revision: number
    event: { type: string; revision: number; resource: string; id: string; parentId: string }
  }
  stream: { href: string }
} {
  return {
    operation: {
      operationId,
      protocolVersion: 1,
      requestOrigin: 'accepted_send',
      state,
      stateVersion: 2,
      projectionEpoch: 3,
      creatorWriterSessionId: 'writer-a',
      creatorWriterEpoch: 1,
      characterId: 'character-a',
      chatId: 'chat-a',
      mode: 'send',
      acceptedMessageId: messageId,
      acceptedRevision: 8,
      providerMayHaveRun: false,
      currentAttempt: {
        attemptNo: 1,
        retryRequestId: 'retry-a',
        jobId: 'job-a',
        status: 'running',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'writer-a',
        actorWriterEpoch: 1,
        launchRevision: 8,
      },
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:01.000Z',
    },
    append: {
      disposition: 'accepted',
      messageId,
      revision: 8,
      event: {
        type: 'message.appended',
        revision: 8,
        resource: 'message',
        id: messageId,
        parentId: 'chat-a',
      },
    },
    stream: {
      href: `/api/v1/generation-operations/${operationId}/stream?attemptNo=1&jobId=job-a&projectionEpoch=3`,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetClientSessionForTests()
  resetStartupReadinessForTests()
  for (const milestone of [
    'entry',
    'shell-mounted',
    'reader-ready',
    'writer-ready',
    'plugins-ready',
    'chat-ready',
  ] as const) {
    recordStartupMilestone(milestone)
  }
  settleStartupGenerationRecoveryReadiness(true)
  settleStartupChatReadiness(true)
  resetGenerationRecoveryObligations()
  resetGenerationOperationClientForTests()
  let uuidIndex = 0
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => [operationId, messageId][uuidIndex++] ?? operationId),
  })
  operationMocks.peekRevision.mockReturnValue(7)
  operationMocks.isWriterAccessLost.mockReturnValue(false)
  operationMocks.listPending.mockResolvedValue([])
  operationMocks.getBaseRevision.mockResolvedValue(7)
  operationMocks.beginDispatch.mockResolvedValue('persisted')
  operationMocks.discard.mockResolvedValue('deleted')
  operationMocks.reconcileDirectEvent.mockResolvedValue(undefined)
  operationMocks.withDirectReconciliation.mockImplementation(
    async (
      _matches: (event: unknown) => boolean,
      operation: (reconcileResponseEvent: (event: unknown, localEffect?: unknown) => Promise<void>) => Promise<unknown>,
    ) => operation(operationMocks.reconcileDirectEvent),
  )
  operationMocks.appendOptimistic.mockReturnValue({ status: 'ok', rollback: vi.fn() })
  operationMocks.stage.mockImplementation((key: string) => ({
    key,
    mutationId: 'mutation-a',
    sequence: 1,
    ownerWriterSessionId: 'writer-a',
    writerEpoch: 1,
    databaseLineage: 'database-a',
    phase: 'staged',
    ready: Promise.resolve('persisted'),
  }))
})

afterEach(() => {
  resetStartupReadinessForTests()
  resetGenerationRecoveryObligations()
  resetGenerationOperationClientForTests()
})

describe('generation operation client', () => {
  it('retires only operation viewers registered through the captured recovery fence', () => {
    const oldViewer = vi.fn()
    const newViewer = vi.fn()
    registerGenerationOperationViewer(operationId, vi.fn(), oldViewer)
    const fence = captureGenerationOperationViewerFence()
    registerGenerationOperationViewer(operationId, vi.fn(), newViewer)

    retireGenerationOperationViewers(operationId, fence)

    expect(oldViewer).toHaveBeenCalledOnce()
    expect(newViewer).not.toHaveBeenCalled()
    retireGenerationOperationViewers(operationId)
    expect(newViewer).toHaveBeenCalledOnce()
  })

  it('identifies writer ownership loss in a readiness failure', async () => {
    operationMocks.isWriterAccessLost.mockReturnValue(true)

    await expect(
      stageAcceptedSendGenerationOperation({
        target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
        message: 'hello',
        generation: {
          syntheticSayNothing: false,
          resetMessages: false,
          inlayAssetRefs: [],
          clientContext: {},
          clientCapabilities: {},
        },
      }),
    ).resolves.toEqual({
      status: 'error',
      error: 'Generation is not ready (blockers: writer-access-lost; startup phase: chat-ready; last failure: none).',
    })
    expect(operationMocks.stage).not.toHaveBeenCalled()
  })

  it('blocks ordinary staging and dispatch before chat readiness while allowing exact pending replay', async () => {
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      message: 'hello',
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    resetStartupReadinessForTests()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toEqual({
      status: 'retained',
      error:
        'Generation is not ready (blockers: writer-startup, plugin-runtime, generation-recovery, chat-dependencies; startup phase: not-started; last failure: none).',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(captureGenerationRecoveryObligations()).toEqual([])
    await expect(dispatchGenerationOperationPendingReplay(staged.handle, staged.intent)).resolves.toMatchObject({
      disposition: 'succeeded',
      result: { status: 'accepted' },
    })
    expect(fetchMock).toHaveBeenCalledOnce()

    operationMocks.stage.mockClear()
    await expect(
      stageTargetedGenerationOperation({
        target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
        mode: 'regenerate',
        targetMessageId: 'message-a',
        generation: {
          syntheticSayNothing: false,
          resetMessages: false,
          inlayAssetRefs: [],
          clientContext: {},
          clientCapabilities: {},
        },
      }),
    ).resolves.toEqual({
      status: 'error',
      error:
        'Generation is not ready (blockers: writer-startup, plugin-runtime, generation-recovery, chat-dependencies; startup phase: not-started; last failure: none).',
    })
    expect(operationMocks.stage).not.toHaveBeenCalled()
  })

  it('creates both UUIDs before durable staging and appends only after staging is ready', async () => {
    let releaseReady!: () => void
    const ready = new Promise<'persisted'>((resolve) => {
      releaseReady = () => resolve('persisted')
    })
    operationMocks.stage.mockImplementationOnce((key: string) => ({
      key,
      mutationId: 'mutation-a',
      sequence: 1,
      ownerWriterSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      phase: 'staged',
      ready,
    }))

    const staging = stageAcceptedSendGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      message: 'hello',
      draftGeneration: { sequence: 4 },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })

    expect(operationMocks.stage).toHaveBeenCalledWith(
      `generation-operation-submit:${operationId}`,
      expect.objectContaining({
        kind: 'generation-operation-submit',
        requests: [
          expect.objectContaining({
            path: '/generation-operations',
            body: expect.objectContaining({ operationId, acceptedMessageId: messageId }),
          }),
        ],
      }),
    )
    expect(operationMocks.appendOptimistic).not.toHaveBeenCalled()

    releaseReady()
    const staged = await staging
    expect('status' in staged).toBe(false)
    expect(operationMocks.appendOptimistic).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-a' }),
      expect.objectContaining({ chatId: messageId, data: 'hello' }),
    )
    expect(staged).toMatchObject({ optimisticChatBodyProjectionEpoch: 12 })
  })

  it('buffers the accepted append echo and reconciles the response as a local message effect', async () => {
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      message: 'hello',
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const body = responseBody()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    )

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'accepted' })

    expect(operationMocks.withDirectReconciliation).toHaveBeenCalledTimes(1)
    const matches = operationMocks.withDirectReconciliation.mock.calls[0][0] as (event: unknown) => boolean
    expect(matches({ ...body.append.event, origin: { writerSessionId: 'writer-a' } })).toBe(true)
    expect(matches({ ...body.append.event, id: 'another-message' })).toBe(false)
    expect(operationMocks.reconcileDirectEvent).toHaveBeenCalledWith(body.append.event, {
      kind: 'messageMutation',
      operation: 'append',
      chatId: 'chat-a',
      messageId,
      chatBodyProjectionEpoch: 12,
    })
  })

  it('establishes submit recovery before transport and rejects a response for another operation', async () => {
    const staged = await stageManagedSend()
    if ('status' in staged) throw new Error(staged.error)
    let dispatchCapture: ReturnType<typeof captureGenerationRecoveryObligations> = []
    const mismatched = responseBody()
    mismatched.operation = { ...mismatched.operation, operationId: '33333333-3333-4333-8333-333333333333' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        dispatchCapture = captureGenerationRecoveryObligations()
        return new Response(JSON.stringify(mismatched), { status: 200 })
      }),
    )

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toEqual({
      status: 'retained',
      error: 'Invalid generation operation response.',
    })
    expect(dispatchCapture).toEqual([
      expect.objectContaining({ kind: 'submit', operationId, chatId: 'chat-a', phase: 'dispatching' }),
    ])
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ kind: 'submit', operationId, chatId: 'chat-a', phase: 'uncertain' }),
    ])
    expect(operationMocks.discard).not.toHaveBeenCalled()
  })

  it('retains an accepted send whose response omits its reconciliation event', async () => {
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      message: 'hello',
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const body = responseBody()
    delete (body.append as { event?: unknown }).event
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    )

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toEqual({
      status: 'retained',
      error: 'Invalid accepted-send append response.',
    })
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ kind: 'submit', operationId, chatId: 'chat-a', phase: 'uncertain' }),
    ])
    expect(operationMocks.reconcileDirectEvent).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
  })

  it('replays the exact staged operation after a lost response without appending twice', async () => {
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      message: 'hello',
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection lost after write'))
      .mockResolvedValueOnce(new Response(JSON.stringify(responseBody()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'retained' })
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({
        kind: 'submit',
        operationId,
        chatId: 'chat-a',
        phase: 'uncertain',
      }),
    ])
    expect(operationMocks.discard).not.toHaveBeenCalled()

    await expect(dispatchGenerationOperationPendingReplay(staged.handle, staged.intent)).resolves.toMatchObject({
      disposition: 'succeeded',
      result: { status: 'accepted' },
    })
    expect(operationMocks.appendOptimistic).toHaveBeenCalledTimes(1)
    expect(operationMocks.discard).toHaveBeenCalledWith(staged.handle)
    expect(captureGenerationRecoveryObligations()).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const replayBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(replayBody).toEqual(firstBody)
    expect(replayBody).toMatchObject({ operationId, acceptedMessageId: messageId })
  })

  it('discards an accepted submit row from a pre-bootstrap recovery capture without replaying it', async () => {
    const staged = await stageManagedSend()
    if ('status' in staged) throw new Error(staged.error)
    const token = beginGenerationRecoveryObligation({
      kind: 'submit',
      operationId,
      chatId: 'chat-a',
      sourceGeneration: 0,
    })
    markGenerationRecoveryObligationUncertain(token)
    const captured = captureGenerationRecoveryObligations()
    applyGenerationOperationProjection(responseBody().operation)
    expect(captureGenerationRecoveryObligations()).toEqual([])
    operationMocks.listPending.mockResolvedValueOnce([{ handle: staged.handle, intent: staged.intent }])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayGenerationRecoveryObligations(captured)).resolves.toBe(true)

    expect(operationMocks.discard).toHaveBeenCalledWith(staged.handle)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not acknowledge a captured outbox row after its recovery scope is replaced', async () => {
    const staged = await stageManagedSend()
    if ('status' in staged) throw new Error(staged.error)
    const token = beginGenerationRecoveryObligation({
      kind: 'submit',
      operationId,
      chatId: 'chat-a',
      sourceGeneration: 0,
    })
    markGenerationRecoveryObligationUncertain(token)
    const captured = captureGenerationRecoveryObligations()
    let releaseEntries!: () => void
    const entriesReady = new Promise<void>((resolve) => {
      releaseEntries = resolve
    })
    operationMocks.listPending.mockImplementationOnce(async () => {
      await entriesReady
      return [{ handle: staged.handle, intent: staged.intent }]
    })

    const recovery = replayGenerationRecoveryObligations(captured)
    await vi.waitFor(() => expect(operationMocks.listPending).toHaveBeenCalledOnce())
    resetGenerationRecoveryObligations()
    releaseEntries()

    await expect(recovery).resolves.toBe(false)
    expect(operationMocks.discard).not.toHaveBeenCalled()
  })

  it('matches a persisted cancellation when its recovery capture includes the known chat', async () => {
    const handle = {
      key: `generation-operation-cancel:${operationId}`,
      mutationId: 'cancel-mutation-chat-a',
      sequence: 2,
      ownerWriterSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      phase: 'staged' as const,
      ready: Promise.resolve<'persisted'>('persisted'),
    }
    const intent = {
      version: 1 as const,
      kind: 'generation-operation-cancel' as const,
      requests: [
        {
          method: 'PUT' as const,
          path: `/generation-operations/${operationId}/cancellation`,
          body: { reason: 'user_stop' },
        },
      ],
    }
    const token = beginGenerationRecoveryObligation({
      kind: 'cancel',
      operationId,
      chatId: 'chat-a',
      sourceGeneration: 0,
    })
    markGenerationRecoveryObligationUncertain(token)
    operationMocks.listPending.mockResolvedValueOnce([{ handle, intent }])
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'temporary_failure', message: 'try later' }), { status: 503 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayGenerationRecoveryObligations(captureGenerationRecoveryObligations())).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(captureGenerationRecoveryObligations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'cancel', operationId, chatId: 'chat-a', phase: 'uncertain' }),
      ]),
    )
  })

  it('does not overlap a replay while the exact recovery intent is already dispatching', async () => {
    const staged = await stageManagedSend()
    if ('status' in staged) throw new Error(staged.error)
    const token = beginGenerationRecoveryObligation({
      kind: 'submit',
      operationId,
      chatId: 'chat-a',
      sourceGeneration: 0,
    })
    markGenerationRecoveryObligationUncertain(token)
    operationMocks.listPending.mockResolvedValue([{ handle: staged.handle, intent: staged.intent }])
    let releaseResponse!: (response: Response) => void
    const heldResponse = new Promise<Response>((resolve) => {
      releaseResponse = resolve
    })
    const fetchMock = vi.fn(async () => heldResponse)
    vi.stubGlobal('fetch', fetchMock)

    const firstReplay = replayGenerationRecoveryObligations(captureGenerationRecoveryObligations())
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(captureGenerationRecoveryObligations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'submit', operationId, phase: 'uncertain' }),
        expect.objectContaining({ kind: 'submit', operationId, phase: 'dispatching' }),
      ]),
    )

    await expect(replayGenerationRecoveryObligations(captureGenerationRecoveryObligations())).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()

    releaseResponse(new Response(JSON.stringify(responseBody()), { status: 200 }))
    await expect(firstReplay).resolves.toBe(true)
  })

  it.each(['continue', 'regenerate'] as const)(
    'stages %s as an operation-addressed target and retains pre-dispatch recovery on transport loss',
    async (mode) => {
      const staged = await stageTargetedGenerationOperation({
        target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
        mode,
        targetMessageId: 'assistant-a',
        draftGeneration: { sequence: 9 },
        generation: {
          syntheticSayNothing: false,
          resetMessages: false,
          inlayAssetRefs: [],
          clientContext: {},
          clientCapabilities: {},
        },
      })
      if ('status' in staged) throw new Error(staged.error)

      expect(staged.request).toMatchObject({
        operationId,
        mode,
        targetMessageId: 'assistant-a',
        draftGeneration: { sequence: 9 },
      })
      expect(staged.request).not.toHaveProperty('message')
      expect(staged.request).not.toHaveProperty('acceptedMessageId')
      expect(operationMocks.appendOptimistic).not.toHaveBeenCalled()

      let dispatchCapture: ReturnType<typeof captureGenerationRecoveryObligations> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          dispatchCapture = captureGenerationRecoveryObligations()
          throw new Error(`${mode} transport lost`)
        }),
      )
      await expect(submitStagedTargetedGenerationOperation(staged)).resolves.toEqual({
        status: 'retained',
        error: `Network error: ${mode} transport lost`,
      })
      expect(dispatchCapture).toEqual([
        expect.objectContaining({ kind: 'submit', operationId, chatId: 'chat-a', phase: 'dispatching' }),
      ])
      expect(captureGenerationRecoveryObligations()).toEqual([
        expect.objectContaining({ kind: 'submit', operationId, chatId: 'chat-a', phase: 'uncertain' }),
      ])
    },
  )

  it('keeps a retry obligation when a successful response describes an older attempt', async () => {
    const stale = responseBody()
    stale.operation = {
      ...stale.operation,
      stateVersion: 2,
      currentAttempt: { ...stale.operation.currentAttempt!, retryRequestId: 'older-retry' },
    }
    let dispatchCapture: ReturnType<typeof captureGenerationRecoveryObligations> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        dispatchCapture = captureGenerationRecoveryObligations()
        return new Response(JSON.stringify(stale), { status: 200 })
      }),
    )

    await expect(retryGenerationOperation(operationId, 2)).resolves.toEqual({
      status: 'retained',
      error: 'Invalid generation operation response.',
    })
    expect(dispatchCapture).toEqual([
      expect.objectContaining({
        kind: 'retry',
        operationId,
        retryRequestId: operationId,
        minimumStateVersion: 3,
        phase: 'dispatching',
      }),
    ])
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ kind: 'retry', retryRequestId: operationId, phase: 'uncertain' }),
    ])
    expect(operationMocks.discard).not.toHaveBeenCalled()
  })

  it('treats a pending-finalization admission error as a typed terminal rejection', async () => {
    const rollback = vi.fn()
    operationMocks.appendOptimistic.mockReturnValueOnce({ status: 'ok', rollback })
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      message: 'wait for the prior reply',
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'generation_finalization_pending',
              message: 'The previous reply is still saving.',
            }),
            { status: 409 },
          ),
      ),
    )

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toEqual({
      status: 'rejected',
      error: 'The previous reply is still saving.',
      code: 'generation_finalization_pending',
    })
    expect(operationMocks.discard).toHaveBeenCalledWith(staged.handle)
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('persists Stop before dispatch, exposes acknowledgement failure, and retries the same control', async () => {
    const rollback = vi.fn()
    operationMocks.appendOptimistic.mockReturnValueOnce({ status: 'ok', rollback })
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      message: 'hello',
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)

    const tombstone = {
      operation: {
        operationId,
        protocolVersion: 1,
        requestOrigin: 'unbound',
        state: 'cancel_requested',
        stateVersion: 1,
        projectionEpoch: 2,
        creatorWriterSessionId: 'writer-a',
        creatorWriterEpoch: 1,
        providerMayHaveRun: false,
      },
      disposition: 'cancelled_before_acceptance',
      knownAttemptMatched: false,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'temporary_failure', message: 'try later' }), { status: 503 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(tombstone), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(stopGenerationOperation(operationId)).resolves.toMatchObject({ status: 'failed' })
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ kind: 'cancel', operationId, phase: 'uncertain' }),
    ])
    expect(operationMocks.stage).toHaveBeenLastCalledWith(
      `generation-operation-cancel:${operationId}`,
      expect.objectContaining({
        kind: 'generation-operation-cancel',
        requests: [
          {
            method: 'PUT',
            path: `/generation-operations/${operationId}/cancellation`,
            body: { reason: 'user_stop' },
          },
        ],
      }),
    )
    expect(get(generationOperationCancellations)).toEqual([
      expect.objectContaining({ operationId, state: 'stop_failed', error: 'try later' }),
    ])
    expect(rollback).not.toHaveBeenCalled()

    await expect(stopGenerationOperation(operationId)).resolves.toMatchObject({
      status: 'acknowledged',
      disposition: 'cancelled_before_acceptance',
    })
    expect(operationMocks.stage).toHaveBeenCalledTimes(2)
    expect(captureGenerationRecoveryObligations()).toEqual([])
    expect(get(generationOperationCancellations)).toEqual([
      expect.objectContaining({ operationId, state: 'settled_cancelled' }),
    ])
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(operationMocks.discard).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining('cancel') }),
    )
  })

  it('replays a persisted pre-job-ID Stop after reload until the operation settles', async () => {
    const operation = responseBody('stopping').operation
    const handle = {
      key: `generation-operation-cancel:${operationId}`,
      mutationId: 'cancel-mutation-a',
      sequence: 2,
      ownerWriterSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      phase: 'staged' as const,
      ready: Promise.resolve<'persisted'>('persisted'),
    }
    const intent = {
      version: 1 as const,
      kind: 'generation-operation-cancel' as const,
      requests: [
        {
          method: 'PUT' as const,
          path: `/generation-operations/${operationId}/cancellation`,
          body: { reason: 'user_stop' },
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              operation,
              disposition: 'cancelling',
              knownAttemptMatched: false,
            }),
            { status: 202 },
          ),
      ),
    )

    await expect(dispatchGenerationOperationPendingReplay(handle, intent)).resolves.toMatchObject({
      disposition: 'retained',
      result: { status: 'acknowledged', disposition: 'cancelling' },
    })
    expect(get(generationOperationCancellations)).toEqual([
      expect.objectContaining({
        operationId,
        state: 'stop_waiting',
        disposition: 'cancelling',
        jobId: 'job-a',
      }),
    ])
    expect(operationMocks.discard).not.toHaveBeenCalled()
  })

  it('keeps an unacknowledged Stop failed when status still shows an owned runner', () => {
    generationOperationCancellations.set([
      {
        operationId,
        target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
        state: 'stop_failed',
        error: 'Stop acknowledgement failed.',
      },
    ])

    applyGenerationOperationProjection(responseBody('owned_by_job').operation)

    expect(get(generationOperationCancellations)).toEqual([
      expect.objectContaining({
        operationId,
        state: 'stop_failed',
        operationState: 'owned_by_job',
        error: 'Stop acknowledgement failed.',
      }),
    ])
  })

  it('projects completion-finalizing authority without claiming Stop', () => {
    generationOperationCancellations.set([
      {
        operationId,
        target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
        state: 'stop_waiting',
        disposition: 'cancelling',
      },
    ])
    const operation = {
      ...responseBody('finalizing').operation,
      desiredTerminalOutcome: 'completed' as const,
    }

    applyGenerationOperationProjection(operation)

    expect(get(generationOperationCancellations)).toEqual([
      expect.objectContaining({
        operationId,
        state: 'stop_waiting',
        disposition: 'completion_finalizing',
        operationState: 'finalizing',
      }),
    ])
  })

  it('drops a lower-epoch bootstrap atomically, retaining the newer operation and job projection', () => {
    const newerOperation = {
      ...responseBody().operation,
      operationId: '33333333-3333-4333-8333-333333333333',
      stateVersion: 7,
      projectionEpoch: 41,
      currentAttempt: {
        ...responseBody().operation.currentAttempt!,
        attemptNo: 2,
        jobId: 'job-newer',
      },
    }
    const newerJob = {
      chatId: 'chat-a',
      jobId: 'job-newer',
      operationId: newerOperation.operationId,
      operationStateVersion: 7,
      projectionEpoch: 41,
      attemptNo: 2,
    }
    const staleOperation = { ...responseBody().operation, projectionEpoch: 40 }

    expect(
      applyGenerationOperationBootstrap(
        {
          initialized: true,
          revision: 8,
          databaseLineage: 'database-a',
          generationOperationProtocol: { version: 1 },
          generationOperationProjectionEpoch: 41,
          generationOperations: [newerOperation],
          activeGenerationJobs: [newerJob],
        },
        'pageshow',
      ),
    ).toBe(true)
    expect(
      applyGenerationOperationBootstrap(
        {
          initialized: true,
          revision: 8,
          databaseLineage: 'database-a',
          generationOperationProtocol: { version: 1 },
          generationOperationProjectionEpoch: 40,
          generationOperations: [staleOperation],
          activeGenerationJobs: [
            {
              chatId: 'chat-a',
              jobId: 'job-stale',
              operationId,
              operationStateVersion: 2,
              projectionEpoch: 40,
              attemptNo: 1,
            },
          ],
        },
        'visibility',
      ),
    ).toBe(false)

    expect(get(generationOperationProjections)).toEqual([newerOperation])
    expect(operationMocks.setActiveJobs).toHaveBeenCalledTimes(1)
    expect(operationMocks.setActiveJobs).toHaveBeenCalledWith([newerJob], {
      projectionEpoch: 41,
      operations: [newerOperation],
      source: 'pageshow',
    })
  })

  it('preflights the job epoch before a rejected bootstrap can clear recovery authority', () => {
    const token = beginGenerationRecoveryObligation({
      kind: 'submit',
      operationId,
      chatId: 'chat-a',
      sourceGeneration: 0,
    })
    markGenerationRecoveryObligationUncertain(token)
    const before = captureGenerationRecoveryObligations()
    operationMocks.canApplyActiveJobs.mockReturnValueOnce(false)

    expect(
      applyGenerationOperationBootstrap({
        initialized: true,
        revision: 8,
        databaseLineage: 'database-a',
        generationOperationProtocol: { version: 1 },
        generationOperationProjectionEpoch: 3,
        generationOperations: [responseBody().operation],
        activeGenerationJobs: [],
      }),
    ).toBe(false)

    expect(operationMocks.setActiveJobs).not.toHaveBeenCalled()
    expect(operationMocks.applyAcceptedBootstrap).not.toHaveBeenCalled()
    expect(get(generationOperationProjections)).toEqual([])
    expect(captureGenerationRecoveryObligations()).toEqual(before)
  })

  it('keeps a newer per-operation state version when a bootstrap reuses the global epoch', () => {
    const newerOperation = {
      ...responseBody().operation,
      stateVersion: 8,
      projectionEpoch: 41,
      currentAttempt: {
        ...responseBody().operation.currentAttempt!,
        attemptNo: 2,
        jobId: 'job-current',
      },
    }
    const staleOperation = {
      ...newerOperation,
      stateVersion: 7,
      currentAttempt: {
        ...newerOperation.currentAttempt,
        attemptNo: 1,
        jobId: 'job-stale',
      },
    }

    applyGenerationOperationBootstrap({
      initialized: true,
      revision: 8,
      databaseLineage: 'database-a',
      generationOperationProtocol: { version: 1 },
      generationOperationProjectionEpoch: 41,
      generationOperations: [newerOperation],
      activeGenerationJobs: [],
    })
    applyGenerationOperationBootstrap({
      initialized: true,
      revision: 8,
      databaseLineage: 'database-a',
      generationOperationProtocol: { version: 1 },
      generationOperationProjectionEpoch: 41,
      generationOperations: [staleOperation],
      activeGenerationJobs: [],
    })

    expect(get(generationOperationProjections)).toEqual([newerOperation])
    expect(operationMocks.setActiveJobs).toHaveBeenLastCalledWith([], {
      projectionEpoch: 41,
      operations: [newerOperation],
      source: 'bootstrap',
    })
  })

  it('uses the committed terminal result identity instead of the displaced regenerate patch target', () => {
    const current = { ...responseBody().operation, mode: 'regenerate' as const, targetMessageId: 'displaced-row' }
    applyGenerationOperationProjection(current)
    applyGenerationOperationSseEvent({
      type: 'done',
      operationId,
      operationState: 'completed',
      operationStateVersion: current.stateVersion + 1,
      projectionEpoch: current.projectionEpoch + 1,
      attemptNo: current.currentAttempt!.attemptNo,
      jobId: current.currentAttempt!.jobId,
      resultMessageId: 'committed-row',
      postGeneration: { messageId: 'displaced-row' },
    })
    expect(get(generationOperationProjections)[0]).toMatchObject({
      state: 'completed',
      resultMessageId: 'committed-row',
      targetMessageId: 'displaced-row',
    })
  })

  it('ignores a stale SSE frame from an older operation attempt', () => {
    const current = {
      ...responseBody().operation,
      stateVersion: 8,
      projectionEpoch: 41,
      currentAttempt: {
        ...responseBody().operation.currentAttempt!,
        attemptNo: 2,
        jobId: 'job-current',
      },
    }
    applyGenerationOperationProjection(current)

    applyGenerationOperationSseEvent({
      type: 'done',
      operationId,
      operationState: 'completed',
      operationStateVersion: 9,
      projectionEpoch: 42,
      attemptNo: 1,
      jobId: 'job-stale',
    })

    expect(get(generationOperationProjections)).toEqual([current])
  })

  it.each([
    ['completed', 'terminal'],
    ['cancelled', 'terminal'],
    ['terminal_failed', 'terminal'],
    ['invalidated', 'terminal'],
    ['finalizing', 'finalizing'],
    ['retryable', 'recoverable'],
    ['abandoned', 'recoverable'],
    ['accepted', 'nonlive'],
  ] as const)('classifies stale-attempt %s authority as %s', (state, disposition) => {
    const operation = { ...responseBody(state).operation, currentAttempt: undefined }

    expect(reconcileGenerationOperationErrorBody({ operation })).toMatchObject({ disposition, operation })
  })

  it('routes transcript hydration through the shared lifecycle reconciler', () => {
    const messages = [
      { role: 'user', chatId: messageId },
      { role: 'char', chatId: 'reply-a', generationInfo: { operationId } },
    ]

    reconcileGenerationOperationTranscriptHydration('chat-a', messages)

    expect(operationMocks.acknowledgeHydratedRecoveries).toHaveBeenCalledWith('chat-a', messages)
  })
})

function stageManagedSend() {
  return stageAcceptedSendGenerationOperation({
    target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
    message: 'hello',
    generation: {
      syntheticSayNothing: false,
      resetMessages: false,
      inlayAssetRefs: [],
      clientContext: {},
      clientCapabilities: {},
    },
  })
}

function settleCurrentGenerationReadiness(): void {
  settleStartupGenerationRecoveryReadiness(true)
  settleStartupChatReadiness(true)
}

function setReadyManagedWriter(): void {
  setManagedWriterForTest()
  settleCurrentGenerationReadiness()
}

describe('generation operation writer lifecycle', () => {
  it('stops a bootstrapped operation after promotion without a prior local cancellation record', async () => {
    setManagedReaderForTest()
    const operation = {
      ...responseBody().operation,
      creatorWriterSessionId: 'previous-writer',
      currentAttempt: {
        ...responseBody().operation.currentAttempt!,
        actorWriterSessionId: 'previous-writer',
      },
    }
    expect(
      applyGenerationOperationBootstrap({
        initialized: true,
        revision: 8,
        databaseLineage: 'database-a',
        generationOperationProtocol: { version: 1 },
        generationOperationProjectionEpoch: operation.projectionEpoch,
        generationOperations: [operation],
        activeGenerationJobs: [{ chatId: 'chat-a', jobId: 'job-a', operationId }],
      }),
    ).toBe(true)
    expect(get(generationOperationCancellations)).toEqual([])
    demoteAndRepromoteForTest()
    settleCurrentGenerationReadiness()
    const stoppingOperation = {
      ...operation,
      state: 'stopping' as const,
      stateVersion: 3,
      projectionEpoch: 4,
      currentAttempt: { ...operation.currentAttempt, status: 'stopping' as const },
    }
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ operation: stoppingOperation, disposition: 'cancelling', knownAttemptMatched: true }),
          { status: 202 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(stopGenerationOperation(operationId)).resolves.toMatchObject({
      status: 'acknowledged',
      disposition: 'cancelling',
      knownAttemptMatched: true,
    })

    const cancellationBody = { reason: 'user_stop', knownStateVersion: 2, knownAttemptNo: 1, knownJobId: 'job-a' }
    expect(operationMocks.stage).toHaveBeenCalledExactlyOnceWith(`generation-operation-cancel:${operationId}`, {
      version: 1,
      kind: 'generation-operation-cancel',
      requests: [{ method: 'PUT', path: `/generation-operations/${operationId}/cancellation`, body: cancellationBody }],
    })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/generation-operations/${operationId}/cancellation`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'risu-writer-session': 'writer-a', 'risu-database-lineage': 'database-a' }),
        body: JSON.stringify(cancellationBody),
      }),
    )
    expect(get(generationOperationCancellations)).toEqual([
      expect.objectContaining({
        operationId,
        target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
        state: 'stop_waiting',
        operationState: 'stopping',
        stateVersion: 3,
        projectionEpoch: 4,
        attemptNo: 1,
        jobId: 'job-a',
      }),
    ])
    expect(operationMocks.appendOptimistic).not.toHaveBeenCalled()
  })

  it('rejects Reader staging and cancellation before local staging or transport', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(stageManagedSend()).resolves.toMatchObject({ status: 'error' })
    await expect(stopGenerationOperation(operationId)).resolves.toMatchObject({ status: 'failed' })
    await expect(retryGenerationOperation(operationId, 2)).resolves.toMatchObject({ status: 'retained' })
    expect(operationMocks.stage).not.toHaveBeenCalled()
    expect(operationMocks.appendOptimistic).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cannot submit a stage created before writer loss and re-promotion', async () => {
    setReadyManagedWriter()
    const staged = await stageManagedSend()
    if ('status' in staged) throw new Error(staged.error)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    setManagedReaderForTest()
    await expect(dispatchGenerationOperationPendingReplay(staged.handle, staged.intent)).resolves.toMatchObject({
      disposition: 'retained',
    })
    setReadyManagedWriter()
    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'retained' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
  })

  it('settles an exact accepted response without projecting it into the newer writer session', async () => {
    setReadyManagedWriter()
    const staged = await stageManagedSend()
    if ('status' in staged) throw new Error(staged.error)
    let release!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = submitStagedAcceptedSendOperation(staged)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    operationMocks.setRevision.mockClear()
    operationMocks.applyAcceptedOperation.mockClear()
    demoteAndRepromoteForTest()
    settleCurrentGenerationReadiness()
    release(new Response(JSON.stringify(responseBody()), { status: 200 }))
    await expect(pending).resolves.toMatchObject({ status: 'accepted' })
    expect(operationMocks.discard).toHaveBeenCalledWith(staged.handle)
    expect(operationMocks.setRevision).not.toHaveBeenCalled()
    expect(operationMocks.applyAcceptedOperation).not.toHaveBeenCalled()
    expect(operationMocks.reconcileDirectEvent).not.toHaveBeenCalled()
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({
        kind: 'submit',
        operationId,
        chatId: 'chat-a',
        phase: 'uncertain',
      }),
    ])
  })

  it('does not apply a held cancellation acknowledgement after writer loss and re-promotion', async () => {
    setReadyManagedWriter()
    let release!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = stopGenerationOperation(operationId)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const before = get(generationOperationCancellations)
    demoteAndRepromoteForTest()
    settleCurrentGenerationReadiness()
    release(
      new Response(
        JSON.stringify({
          operation: responseBody('cancel_requested').operation,
          disposition: 'cancelling',
          knownAttemptMatched: true,
        }),
        { status: 200 },
      ),
    )
    await expect(pending).resolves.toMatchObject({ status: 'acknowledged', disposition: 'cancelling' })
    expect(get(generationOperationCancellations)).toEqual(before)
    expect(operationMocks.applyAcceptedOperation).not.toHaveBeenCalled()
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ kind: 'cancel', operationId, phase: 'uncertain' }),
    ])
  })
})
