import { getClientSessionSnapshot, resetClientSessionForTests } from '../clientSession'
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
  listChatOccupancyPending: vi.fn(),
  listOccupancyAuthorities: vi.fn(() => []),
  peekRevision: vi.fn(),
  reconcileDirectEvent: vi.fn(),
  setRevision: vi.fn(),
  stage: vi.fn(),
  stageChatOccupancy: vi.fn(),
  chatOccupancyCurrent: vi.fn(),
  canApplyActiveJobs: vi.fn(() => true),
  captureOccupancy: vi.fn(),
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
  ACTIVE_WRITER_SESSION_HEADER: 'risu-writer-session',
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
  listChatOccupancyGenerationMutations: operationMocks.listChatOccupancyPending,
  listOriginatingChatOccupancyGenerationMutations: operationMocks.listChatOccupancyPending,
  stagePendingMutation: operationMocks.stage,
  stageChatOccupancyGenerationMutation: operationMocks.stageChatOccupancy,
}))
vi.mock('./chatOccupancy', () => ({
  captureClientChatOccupancyAuthority: operationMocks.captureOccupancy,
  isClientChatOccupancyAuthorityCurrent: operationMocks.chatOccupancyCurrent,
  listClientChatOccupancyAuthorities: operationMocks.listOccupancyAuthorities,
  registerClientChatOccupancyRecoveryHandler: vi.fn(),
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
  chatOccupancyGenerationRecoveryProjections,
  captureGenerationOperationViewerFence,
  configureGenerationOperationProtocol,
  dispatchGenerationOperationPendingReplay,
  discardChatOccupancyRequiresResubmission,
  generationOperationCancellations,
  generationOperationProjections,
  readGenerationOperationStatus,
  recoverCurrentChatOccupancyGenerationMutations,
  replayChatOccupancyGenerationMutations,
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
  stopChatOccupancyGeneration,
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

function occupancyAuthority(claimClass: 'owner' | 'chat_only' = 'chat_only') {
  const session = getClientSessionSnapshot()
  return {
    version: 1 as const,
    databaseLineage: 'database-a',
    chatId: 'chat-a',
    sessionId: session.sessionId,
    sessionGeneration: session.generation,
    occupancyEpoch: 7,
    claimClass,
  }
}

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

function occupiedResponseBody(
  authority: ReturnType<typeof occupancyAuthority>,
  state: GenerationOperationProjection['state'] = 'owned_by_job',
) {
  const response = responseBody(state)
  response.operation.creatorWriterSessionId = authority.sessionId
  response.operation.generationScope = {
    admissionKind: authority.claimClass === 'chat_only' ? 'chat_only' : 'owner_occupancy',
    occupancyDatabaseLineage: authority.databaseLineage,
    occupancySessionId: authority.sessionId,
    occupancyEpoch: authority.occupancyEpoch,
    occupancyClaimClass: authority.claimClass,
    permissionScopeVersion: 1,
    permissionScope: [],
  }
  return response
}

function occupiedStopPending(
  authority: ReturnType<typeof occupancyAuthority>,
  options: {
    interaction?: 'send' | 'reroll' | 'continue' | 'regenerate'
    occupancyEpoch?: number
    epochDisposition?: 'current' | 'stale'
  } = {},
) {
  const interaction = options.interaction ?? 'send'
  const occupancyEpoch = options.occupancyEpoch ?? authority.occupancyEpoch
  const handle = {
    key: `generation-operation-cancel:${operationId}`,
    mutationId: 'chat-stop-mutation',
    sequence: 3,
    ownerWriterSessionId: authority.sessionId,
    writerEpoch: occupancyEpoch,
    databaseLineage: authority.databaseLineage,
    authorityKind: 'chat-occupancy' as const,
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
        body: {
          reason: 'user_stop',
          chatId: 'chat-a',
          chatOccupancy: { version: 1 as const, interaction },
        },
      },
    ],
  }
  return {
    handle,
    intent,
    chatId: 'chat-a',
    occupancyEpoch,
    epochDisposition: options.epochDisposition ?? ('current' as const),
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
  operationMocks.listChatOccupancyPending.mockResolvedValue([])
  operationMocks.chatOccupancyCurrent.mockReturnValue(true)
  operationMocks.captureOccupancy.mockReturnValue(null)
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
  operationMocks.stageChatOccupancy.mockImplementation((key: string) => ({
    key,
    mutationId: 'mutation-chat-a',
    sequence: 1,
    ownerWriterSessionId: getClientSessionSnapshot().sessionId,
    writerEpoch: 7,
    databaseLineage: 'database-a',
    authorityKind: 'chat-occupancy',
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

describe('occupied-chat generation operation client', () => {
  it('does not let a demoted owner-class occupancy admit fresh generation', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority('owner')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      stageAcceptedSendGenerationOperation({
        target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
        message: 'demoted owner hello',
        chatOccupancy: { authority, interaction: 'send' },
        generation: {
          syntheticSayNothing: false,
          resetMessages: false,
          inlayAssetRefs: [],
          clientContext: {},
          clientCapabilities: {},
        },
      }),
    ).resolves.toMatchObject({ status: 'error' })
    expect(operationMocks.stageChatOccupancy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stages and retries an accepted Send under one frozen occupancy tuple', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const chatOccupancy = { authority, interaction: 'send' as const }
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'reader hello',
      chatOccupancy,
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const accepted = responseBody()
    accepted.operation.creatorWriterSessionId = authority.sessionId
    accepted.operation.currentAttempt!.actorWriterSessionId = authority.sessionId
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'revision_conflict', currentRevision: 8 }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(accepted), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'accepted' })

    expect(operationMocks.stage).not.toHaveBeenCalled()
    expect(operationMocks.stageChatOccupancy).toHaveBeenCalledWith(
      `generation-operation-submit:${operationId}`,
      expect.objectContaining({ kind: 'generation-operation-submit' }),
      authority,
      { requireEnabled: true },
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = fetchMock.mock.calls[0]!
    const second = fetchMock.mock.calls[1]!
    for (const call of [first, second]) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            'risu-writer-session': authority.sessionId,
            'risu-database-lineage': authority.databaseLineage,
            'risu-chat-occupancy-epoch': '7',
          }),
        }),
      )
      expect(JSON.parse(call[1].body)).toMatchObject({
        chatId: 'chat-a',
        chatOccupancy: { version: 1, interaction: 'send' },
      })
    }
    expect(JSON.parse(first[1].body).baseRevision).toBe(7)
    expect(JSON.parse(second[1].body).baseRevision).toBe(8)
  })

  it('retains the exact occupied-chat Send after exhausting bounded revision retries', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const draftGeneration = { sequence: 12, source: 'occupied-chat-retry-exhaustion' }
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'retain this exact send',
      draftGeneration,
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const rollback = vi.fn(staged.rollbackOptimisticAppend)
    staged.rollbackOptimisticAppend = rollback
    const stagedBody = structuredClone(staged.intent.requests[0]!.body)
    const conflictRevisions = [8, 9, 10, 11]
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const currentRevision = conflictRevisions.shift()
      return new Response(
        JSON.stringify({
          error: 'revision_conflict',
          message: `The server revision advanced to ${currentRevision}.`,
          currentRevision,
        }),
        { status: 409 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toEqual({
      status: 'retained',
      error: 'The server revision advanced to 11.',
      code: 'revision_conflict',
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(
      fetchMock.mock.calls.map(([, init]) => {
        const body = JSON.parse(init!.body as string)
        return {
          baseRevision: body.baseRevision,
          operationId: body.operationId,
          acceptedMessageId: body.acceptedMessageId,
          message: body.message,
          draftGeneration: body.draftGeneration,
        }
      }),
    ).toEqual(
      [7, 8, 9, 10].map((baseRevision) => ({
        baseRevision,
        operationId,
        acceptedMessageId: messageId,
        message: expect.objectContaining({ chatId: messageId, data: 'retain this exact send' }),
        draftGeneration,
      })),
    )
    expect(operationMocks.setRevision.mock.calls).toEqual([[8], [9], [10]])
    expect(staged.intent.requests[0]!.body).toEqual(stagedBody)
    expect(staged.request).toMatchObject({
      operationId,
      acceptedMessageId: messageId,
      baseRevision: 7,
      draftGeneration,
    })
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({
        kind: 'submit',
        operationId,
        chatId: 'chat-a',
        phase: 'uncertain',
      }),
    ])
    expect(operationMocks.beginDispatch).toHaveBeenCalledExactlyOnceWith(staged.handle)
    expect(operationMocks.stageChatOccupancy).toHaveBeenCalledTimes(1)
    expect(operationMocks.stage).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('settles an exact accepted Send when rollout disables during its response', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    let enabled = true
    operationMocks.chatOccupancyCurrent.mockImplementation(
      (_authority, options?: { requireEnabled?: boolean }) => enabled || options?.requireEnabled !== true,
    )
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'accepted before rollback',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const accepted = responseBody()
    accepted.operation.creatorWriterSessionId = authority.sessionId
    accepted.operation.currentAttempt!.actorWriterSessionId = authority.sessionId
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        enabled = false
        return new Response(JSON.stringify(accepted), { status: 200 })
      }),
    )

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'accepted' })

    expect(get(generationOperationProjections)).toEqual([accepted.operation])
    expect(operationMocks.reconcileDirectEvent).toHaveBeenCalledWith(
      accepted.append.event,
      expect.objectContaining({ messageId }),
    )
    expect(operationMocks.discard).toHaveBeenCalledWith(staged.handle)
    expect(operationMocks.chatOccupancyCurrent).toHaveBeenCalledWith(authority, { requireEnabled: false })
  })

  it('retains a staged Send without transport after its occupancy changes', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'stale reader',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    operationMocks.chatOccupancyCurrent.mockReturnValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'retained' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stages and submits owner Continue under the exact occupied-chat tuple', async () => {
    setReadyManagedWriter()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority('owner')
    const staged = await stageTargetedGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      mode: 'continue',
      targetMessageId: 'reply-a',
      chatOccupancy: { authority, interaction: 'continue' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const accepted = occupiedResponseBody(authority)
    accepted.operation.requestOrigin = 'continue'
    accepted.operation.mode = 'continue'
    accepted.operation.targetMessageId = 'reply-a'
    accepted.operation.resultMessageId = 'reply-a'
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(accepted), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitStagedTargetedGenerationOperation(staged)).resolves.toMatchObject({ status: 'accepted' })

    expect(operationMocks.stage).not.toHaveBeenCalled()
    expect(operationMocks.stageChatOccupancy).toHaveBeenCalledWith(
      `generation-operation-submit:${operationId}`,
      expect.objectContaining({ kind: 'generation-operation-submit' }),
      authority,
      { requireEnabled: true },
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          'risu-writer-session': authority.sessionId,
          'risu-database-lineage': authority.databaseLineage,
          'risu-chat-occupancy-epoch': String(authority.occupancyEpoch),
        }),
      }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
      chatId: 'chat-a',
      mode: 'continue',
      targetMessageId: 'reply-a',
      chatOccupancy: { version: 1, interaction: 'continue' },
    })
  })

  it.each([
    { label: 'Continue', mode: 'continue' as const, interaction: 'continue' as const },
    { label: 'Regenerate', mode: 'regenerate' as const, interaction: 'regenerate' as const },
  ])('rejects fresh chat-only $label before staging or transport', async (scenario) => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority('chat_only')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      stageTargetedGenerationOperation({
        target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
        mode: scenario.mode,
        targetMessageId: 'reply-a',
        chatOccupancy: { authority, interaction: scenario.interaction },
        generation: {
          syntheticSayNothing: false,
          resetMessages: false,
          inlayAssetRefs: [],
          clientContext: {},
          clientCapabilities: {},
        },
      }),
    ).resolves.toMatchObject({ status: 'error', error: 'This interaction is unavailable in chat-only mode.' })
    expect(operationMocks.stageChatOccupancy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads an admitted operation for settlement after rollout disables', async () => {
    setManagedReaderForTest()
    const authority = occupancyAuthority()
    operationMocks.chatOccupancyCurrent.mockImplementation(
      (_authority, options?: { requireEnabled?: boolean }) => options?.requireEnabled !== true,
    )
    const accepted = responseBody()
    accepted.operation.creatorWriterSessionId = authority.sessionId
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(accepted), { status: 200 })),
    )

    await expect(
      readGenerationOperationStatus(operationId, undefined, { authority, interaction: 'send' }),
    ).resolves.toMatchObject({ status: 'accepted' })
    expect(operationMocks.chatOccupancyCurrent).toHaveBeenCalledWith(authority, { requireEnabled: false })
  })

  it('Stops only its locally admitted operation with control authority that may outlive enablement', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageTargetedGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      mode: 'regenerate',
      targetMessageId: 'reply-a',
      chatOccupancy: { authority, interaction: 'reroll' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const operation = {
      ...responseBody('owned_by_job').operation,
      creatorWriterSessionId: authority.sessionId,
      mode: 'regenerate' as const,
      targetMessageId: 'reply-a',
      currentAttempt: {
        ...responseBody().operation.currentAttempt!,
        actorWriterSessionId: authority.sessionId,
      },
    }
    applyGenerationOperationProjection(operation)
    const cancelled = { ...operation, state: 'cancelled' as const, stateVersion: 3, projectionEpoch: 4 }
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ operation: cancelled, disposition: 'cancelled', knownAttemptMatched: true }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      stopChatOccupancyGeneration({
        selectedCharID: -1,
        chatPage: -1,
        characterId: 'character-a',
        chatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'acknowledged', disposition: 'cancelled' })

    expect(operationMocks.stage).not.toHaveBeenCalled()
    expect(operationMocks.stageChatOccupancy).toHaveBeenLastCalledWith(
      `generation-operation-cancel:${operationId}`,
      expect.objectContaining({
        kind: 'generation-operation-cancel',
        requests: [
          expect.objectContaining({
            body: expect.objectContaining({
              chatId: 'chat-a',
              chatOccupancy: { version: 1, interaction: 'reroll' },
            }),
          }),
        ],
      }),
      authority,
      { requireEnabled: false },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/generation-operations/${operationId}/cancellation`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'risu-writer-session': authority.sessionId,
          'risu-database-lineage': authority.databaseLineage,
          'risu-chat-occupancy-epoch': '7',
        }),
      }),
    )
  })

  it('restores occupied-chat Stop after owner-to-chat-only normalization preserves the tuple', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const admittedAuthority = occupancyAuthority('owner')
    const authority = { ...admittedAuthority, claimClass: 'chat_only' as const }
    const operation = {
      ...occupiedResponseBody(admittedAuthority, 'owned_by_job').operation,
      currentAttempt: {
        ...occupiedResponseBody(admittedAuthority).operation.currentAttempt!,
        actorWriterSessionId: authority.sessionId,
      },
    }
    // Reload can project the accepted owner operation before the demoted reader
    // finishes normalizing its retained claim, so no current authority exists
    // when the projection is first applied.
    operationMocks.captureOccupancy.mockReturnValue(null)
    applyGenerationOperationProjection(operation)
    operationMocks.captureOccupancy.mockReturnValue(authority)
    const cancelled = { ...operation, state: 'cancelled' as const, stateVersion: 3, projectionEpoch: 4 }
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ operation: cancelled, disposition: 'cancelled', knownAttemptMatched: true }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      stopChatOccupancyGeneration({
        selectedCharID: -1,
        chatPage: -1,
        characterId: 'character-a',
        chatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'acknowledged', disposition: 'cancelled' })

    expect(operationMocks.stageChatOccupancy).toHaveBeenCalledWith(
      `generation-operation-cancel:${operationId}`,
      expect.objectContaining({
        requests: [
          expect.objectContaining({
            body: expect.objectContaining({
              chatId: authority.chatId,
              chatOccupancy: { version: 1, interaction: 'send' },
            }),
          }),
        ],
      }),
      authority,
      { requireEnabled: false },
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('stages an exact target-scoped Stop before the occupied-chat submit reaches the server', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'cancel before submit',
      chatOccupancy: { authority, interaction: 'send' },
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
        ...occupiedResponseBody(authority, 'cancel_requested').operation,
        requestOrigin: 'unbound' as const,
        acceptedRevision: undefined,
      },
      disposition: 'cancelled_before_acceptance',
      knownAttemptMatched: false,
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(tombstone), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      stopChatOccupancyGeneration({
        selectedCharID: -1,
        chatPage: -1,
        characterId: 'character-a',
        chatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'acknowledged', disposition: 'cancelled_before_acceptance' })

    expect(operationMocks.stageChatOccupancy).toHaveBeenLastCalledWith(
      `generation-operation-cancel:${operationId}`,
      expect.objectContaining({
        requests: [
          expect.objectContaining({
            body: {
              reason: 'user_stop',
              chatId: authority.chatId,
              chatOccupancy: { version: 1, interaction: 'send' },
            },
          }),
        ],
      }),
      authority,
      { requireEnabled: false },
    )
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/generation-operations/${operationId}/cancellation`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'risu-writer-session': authority.sessionId,
          'risu-database-lineage': authority.databaseLineage,
          'risu-chat-occupancy-epoch': String(authority.occupancyEpoch),
        }),
      }),
    )
  })

  it('refuses to Stop a same-chat operation that was not locally admitted', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const operation = {
      ...responseBody('owned_by_job').operation,
      creatorWriterSessionId: getClientSessionSnapshot().sessionId,
    }
    applyGenerationOperationProjection(operation)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      stopChatOccupancyGeneration({
        selectedCharID: -1,
        chatPage: -1,
        characterId: 'character-a',
        chatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'failed' })
    expect(operationMocks.stageChatOccupancy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reconciles a lost occupied-chat Send response by operation identity before replay', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'response was lost',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle: staged.handle,
        intent: staged.intent,
        chatId: 'chat-a',
        occupancyEpoch: authority.occupancyEpoch,
        epochDisposition: 'current',
      },
    ])
    const accepted = occupiedResponseBody(authority)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(accepted), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({ disposition: 'succeeded', result: expect.objectContaining({ status: 'accepted' }) }),
    ])

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/generation-operations/${operationId}`,
      expect.any(Object),
    )
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).toHaveBeenCalledWith(staged.handle)
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([])
  })

  it.each([
    { label: 'Send', mode: 'send' as const, interaction: 'send' as const, resultMessageId: messageId },
    {
      label: 'Continue extend',
      mode: 'continue' as const,
      interaction: 'continue' as const,
      resultMessageId: 'reply-a',
    },
    {
      label: 'Continue append',
      mode: 'continue' as const,
      interaction: 'continue' as const,
      resultMessageId: '33333333-3333-4333-8333-333333333333',
    },
    {
      label: 'Regenerate',
      mode: 'regenerate' as const,
      interaction: 'regenerate' as const,
      resultMessageId: '33333333-3333-4333-8333-333333333333',
    },
  ])('settles a lost owner $label response after same-tuple chat-only normalization', async (scenario) => {
    setReadyManagedWriter()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const admittedAuthority = occupancyAuthority('owner')
    const stagedResult =
      scenario.mode === 'send'
        ? await stageAcceptedSendGenerationOperation({
            target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
            message: 'accepted before normalization',
            chatOccupancy: { authority: admittedAuthority, interaction: 'send' },
            generation: {
              syntheticSayNothing: false,
              resetMessages: false,
              inlayAssetRefs: [],
              clientContext: {},
              clientCapabilities: {},
            },
          })
        : await stageTargetedGenerationOperation({
            target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
            mode: scenario.mode,
            targetMessageId: 'reply-a',
            chatOccupancy: { authority: admittedAuthority, interaction: scenario.interaction },
            generation: {
              syntheticSayNothing: scenario.label === 'Continue append',
              resetMessages: false,
              inlayAssetRefs: [],
              clientContext: {},
              clientCapabilities: {},
            },
          })
    if ('status' in stagedResult) throw new Error(stagedResult.error)

    setManagedReaderForTest()
    const normalizedAuthority = {
      ...admittedAuthority,
      sessionGeneration: getClientSessionSnapshot().generation,
      claimClass: 'chat_only' as const,
    }
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle: stagedResult.handle,
        intent: stagedResult.intent,
        chatId: 'chat-a',
        occupancyEpoch: admittedAuthority.occupancyEpoch,
        epochDisposition: 'current',
      },
    ])
    const accepted = occupiedResponseBody(admittedAuthority)
    accepted.operation.requestOrigin =
      scenario.mode === 'send' ? 'accepted_send' : scenario.mode === 'continue' ? 'continue' : 'regenerate'
    accepted.operation.mode = scenario.mode
    if (scenario.mode !== 'send') accepted.operation.targetMessageId = 'reply-a'
    accepted.operation.resultMessageId = scenario.resultMessageId
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(accepted), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(normalizedAuthority)).resolves.toEqual([
      expect.objectContaining({ disposition: 'succeeded', result: expect.objectContaining({ status: 'accepted' }) }),
    ])

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/generation-operations/${operationId}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'risu-writer-session': normalizedAuthority.sessionId,
          'risu-chat-occupancy-epoch': String(normalizedAuthority.occupancyEpoch),
        }),
      }),
    )
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).toHaveBeenCalledWith(stagedResult.handle)
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([])
  })

  it.each([
    { label: 'Continue', mode: 'continue' as const, interaction: 'continue' as const, draftSequence: 31 },
    { label: 'Regenerate', mode: 'regenerate' as const, interaction: 'regenerate' as const, draftSequence: 32 },
  ])('keeps a proven-unaccepted owner $label dormant after same-tuple chat-only normalization', async (scenario) => {
    setReadyManagedWriter()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const admittedAuthority = occupancyAuthority('owner')
    const draftGeneration = { sequence: scenario.draftSequence, source: 'owner-before-normalization' }
    const stagedResult = await stageTargetedGenerationOperation({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
      mode: scenario.mode,
      targetMessageId: 'reply-a',
      draftGeneration,
      chatOccupancy: { authority: admittedAuthority, interaction: scenario.interaction },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in stagedResult) throw new Error(stagedResult.error)

    setManagedReaderForTest()
    const normalizedAuthority = {
      ...admittedAuthority,
      sessionGeneration: getClientSessionSnapshot().generation,
      claimClass: 'chat_only' as const,
    }
    operationMocks.listChatOccupancyPending.mockResolvedValue([
      {
        handle: stagedResult.handle,
        intent: stagedResult.intent,
        chatId: 'chat-a',
        occupancyEpoch: admittedAuthority.occupancyEpoch,
        epochDisposition: 'current',
      },
    ])
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: 'generation_operation_not_found' }), {
          status: 404,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(replayChatOccupancyGenerationMutations(normalizedAuthority)).resolves.toEqual([
        expect.objectContaining({
          disposition: 'retained',
          result: expect.objectContaining({ status: 'rejected', code: 'generation_operation_not_found' }),
        }),
      ])
    }

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`/api/v1/generation-operations/${operationId}`)
      expect(init).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            'risu-writer-session': normalizedAuthority.sessionId,
            'risu-chat-occupancy-epoch': String(normalizedAuthority.occupancyEpoch),
          }),
        }),
      )
    }
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === '/api/v1/generation-operations' && (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toEqual([])
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
    expect(stagedResult.intent.requests[0]?.body?.draftGeneration).toEqual(draftGeneration)
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([
      expect.objectContaining({
        mutationId: stagedResult.handle.mutationId,
        chatId: 'chat-a',
        operationId,
        kind: scenario.interaction,
        occupancyEpoch: admittedAuthority.occupancyEpoch,
        disposition: 'requires_resubmission',
        error: 'This interaction is unavailable in chat-only mode.',
      }),
    ])
  })

  it.each([
    { admissionKind: 'owner_occupancy' as const, occupancyClaimClass: 'chat_only' as const },
    { admissionKind: 'chat_only' as const, occupancyClaimClass: 'owner' as const },
  ])('rejects malformed immutable recovery provenance %#', async (malformed) => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'malformed provenance must remain fenced',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle: staged.handle,
        intent: staged.intent,
        chatId: 'chat-a',
        occupancyEpoch: authority.occupancyEpoch,
        epochDisposition: 'current',
      },
    ])
    const accepted = occupiedResponseBody(authority)
    accepted.operation.generationScope = { ...accepted.operation.generationScope!, ...malformed }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(accepted), { status: 200 })),
    )

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({
        disposition: 'retained',
        result: expect.objectContaining({ status: 'rejected', code: 'generation_recovery_origin_mismatch' }),
      }),
    ])
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
  })

  it('does not redispatch when the operation id exists with a different accepted intent', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'must remain fenced',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle: staged.handle,
        intent: staged.intent,
        chatId: 'chat-a',
        occupancyEpoch: authority.occupancyEpoch,
        epochDisposition: 'current',
      },
    ])
    const conflicting = occupiedResponseBody(authority)
    conflicting.operation.acceptedMessageId = '33333333-3333-4333-8333-333333333333'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(conflicting), { status: 200 })),
    )

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({ disposition: 'retained', result: expect.objectContaining({ status: 'accepted' }) }),
    ])

    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([
      expect.objectContaining({ disposition: 'retained', operationId }),
    ])
  })

  it('retains a pending Send when status resolves to a reroll admitted under the same tuple', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'origin must match',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle: staged.handle,
        intent: staged.intent,
        chatId: 'chat-a',
        occupancyEpoch: authority.occupancyEpoch,
        epochDisposition: 'current',
      },
    ])
    const wrongOrigin = occupiedResponseBody(authority)
    wrongOrigin.operation.requestOrigin = 'regenerate'
    wrongOrigin.operation.mode = 'regenerate'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(wrongOrigin), { status: 200 })),
    )

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({
        disposition: 'retained',
        result: expect.objectContaining({ status: 'rejected', code: 'generation_recovery_origin_mismatch' }),
      }),
    ])

    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
  })

  it('keeps a proven-unaccepted expired-epoch Send dormant until a fresh explicit Send succeeds', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'expired pending send',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const staleHandle = { ...staged.handle, writerEpoch: authority.occupancyEpoch - 1 }
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle: staleHandle,
        intent: staged.intent,
        chatId: 'chat-a',
        occupancyEpoch: authority.occupancyEpoch - 1,
        epochDisposition: 'stale',
      },
    ])
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'generation_operation_not_found' }), {
          status: 404,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({ disposition: 'retained' }),
    ])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        operationId,
        kind: 'send',
        occupancyEpoch: authority.occupancyEpoch - 1,
        disposition: 'requires_resubmission',
      }),
    ])

    await discardChatOccupancyRequiresResubmission('chat-a', 'send')
    expect(operationMocks.discard).toHaveBeenCalledWith(staleHandle)
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([])
  })

  it('reconciles a lost exact-scope reroll Stop tombstone without dispatching the cancellation twice', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const handle = {
      key: `generation-operation-cancel:${operationId}`,
      mutationId: 'chat-stop-mutation',
      sequence: 3,
      ownerWriterSessionId: authority.sessionId,
      writerEpoch: authority.occupancyEpoch,
      databaseLineage: authority.databaseLineage,
      authorityKind: 'chat-occupancy' as const,
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
          body: {
            reason: 'user_stop',
            chatId: 'chat-a',
            chatOccupancy: { version: 1, interaction: 'reroll' },
          },
        },
      ],
    }
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle,
        intent,
        chatId: 'chat-a',
        occupancyEpoch: authority.occupancyEpoch,
        epochDisposition: 'current',
      },
    ])
    const completedStop = occupiedResponseBody(authority, 'cancelled')
    completedStop.operation.requestOrigin = 'unbound'
    completedStop.operation.mode = 'regenerate'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(completedStop), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({ disposition: 'succeeded' }),
    ])

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/generation-operations/${operationId}`,
      expect.any(Object),
    )
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).toHaveBeenCalledWith(handle)
  })

  it('settles both exact sibling Send and Stop rows from a pre-acceptance cancellation tombstone', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'must never reach the provider',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    const stop = occupiedStopPending(authority)
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle: staged.handle,
        intent: staged.intent,
        chatId: 'chat-a',
        occupancyEpoch: authority.occupancyEpoch,
        epochDisposition: 'current',
      },
      stop,
    ])
    const tombstone = {
      ...occupiedResponseBody(authority, 'cancel_requested').operation,
      requestOrigin: 'unbound' as const,
      acceptedMessageId: undefined,
      acceptedRevision: undefined,
      currentAttempt: undefined,
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ operation: tombstone }), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({ disposition: 'succeeded', result: expect.objectContaining({ status: 'accepted' }) }),
      expect.objectContaining({ disposition: 'succeeded', result: expect.objectContaining({ status: 'accepted' }) }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/v1/generation-operations/${operationId}`,
      `/api/v1/generation-operations/${operationId}`,
    ])
    expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit).method)).toBe(true)
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).toHaveBeenCalledTimes(2)
    expect(operationMocks.discard).toHaveBeenCalledWith(staged.handle)
    expect(operationMocks.discard).toHaveBeenCalledWith(stop.handle)
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([])
  })

  it.each(['stale epoch', 'mismatched scope'] as const)(
    'keeps a sibling Send dormant for a %s cancellation tombstone',
    async (scenario) => {
      setManagedReaderForTest()
      configureGenerationOperationProtocol({ version: 1 }, 'database-a')
      const authority = occupancyAuthority()
      const staged = await stageAcceptedSendGenerationOperation({
        target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
        message: 'must remain dormant',
        chatOccupancy: { authority, interaction: 'send' },
        generation: {
          syntheticSayNothing: false,
          resetMessages: false,
          inlayAssetRefs: [],
          clientContext: {},
          clientCapabilities: {},
        },
      })
      if ('status' in staged) throw new Error(staged.error)
      const stale = scenario === 'stale epoch'
      const handle = stale ? { ...staged.handle, writerEpoch: authority.occupancyEpoch - 1 } : staged.handle
      operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
        {
          handle,
          intent: staged.intent,
          chatId: 'chat-a',
          occupancyEpoch: stale ? authority.occupancyEpoch - 1 : authority.occupancyEpoch,
          epochDisposition: stale ? 'stale' : 'current',
        },
      ])
      const responseAuthority = {
        ...authority,
        occupancyEpoch: stale ? authority.occupancyEpoch - 1 : authority.occupancyEpoch + 1,
      }
      const tombstone = {
        ...occupiedResponseBody(responseAuthority, 'cancel_requested').operation,
        requestOrigin: 'unbound' as const,
        acceptedMessageId: undefined,
        acceptedRevision: undefined,
        currentAttempt: undefined,
      }
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ operation: tombstone }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
        expect.objectContaining({ disposition: 'retained' }),
      ])

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
      expect(operationMocks.discard).not.toHaveBeenCalled()
      expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([
        expect.objectContaining({
          mutationId: handle.mutationId,
          kind: 'send',
          disposition: 'retained',
        }),
      ])
    },
  )

  it('replays an exact current-authority staged Stop when status still shows the provider running', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const pending = occupiedStopPending(authority)
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([pending])
    const running = occupiedResponseBody(authority, 'owned_by_job')
    const cancelled = occupiedResponseBody(authority, 'cancelled').operation
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(running), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation: cancelled, disposition: 'cancelled', knownAttemptMatched: true }), {
          status: 200,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({
        disposition: 'succeeded',
        result: expect.objectContaining({ status: 'acknowledged', disposition: 'cancelled' }),
      }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/v1/generation-operations/${operationId}`)
    expect(fetchMock.mock.calls[1]![0]).toBe(`/api/v1/generation-operations/${operationId}/cancellation`)
    expect(operationMocks.beginDispatch).toHaveBeenCalledWith(pending.handle)
    expect(operationMocks.discard).toHaveBeenCalledWith(pending.handle)
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([])
  })

  it.each(['send', 'continue', 'regenerate'] as const)(
    'replays one lost %s Stop after owner-to-chat-only normalization without generation redispatch',
    async (interaction) => {
      setManagedReaderForTest()
      configureGenerationOperationProtocol({ version: 1 }, 'database-a')
      const normalizedAuthority = occupancyAuthority('chat_only')
      const admittedAuthority = { ...normalizedAuthority, claimClass: 'owner' as const }
      const pending = occupiedStopPending(normalizedAuthority, { interaction })
      operationMocks.listChatOccupancyPending.mockResolvedValueOnce([pending])
      const running = occupiedResponseBody(admittedAuthority, 'owned_by_job')
      running.operation.requestOrigin =
        interaction === 'send' ? 'accepted_send' : interaction === 'continue' ? 'continue' : 'regenerate'
      running.operation.mode = interaction === 'send' ? 'send' : interaction === 'continue' ? 'continue' : 'regenerate'
      if (interaction !== 'send') running.operation.targetMessageId = 'reply-a'
      const cancelled = {
        ...running.operation,
        state: 'cancelled' as const,
        stateVersion: running.operation.stateVersion + 1,
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(running), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ operation: cancelled, disposition: 'cancelled', knownAttemptMatched: true }), {
            status: 200,
          }),
        )
      vi.stubGlobal('fetch', fetchMock)

      await expect(replayChatOccupancyGenerationMutations(normalizedAuthority)).resolves.toEqual([
        expect.objectContaining({
          disposition: 'succeeded',
          result: expect.objectContaining({ status: 'acknowledged', disposition: 'cancelled' }),
        }),
      ])

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `/api/v1/generation-operations/${operationId}`,
        `/api/v1/generation-operations/${operationId}/cancellation`,
      ])
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            url === '/api/v1/generation-operations' && (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toEqual([])
      expect(operationMocks.beginDispatch).toHaveBeenCalledOnce()
      expect(operationMocks.discard).toHaveBeenCalledWith(pending.handle)
    },
  )

  it('retains an exact staged Stop when its replay transport fails before the server receives it', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const pending = occupiedStopPending(authority)
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([pending])
    const running = occupiedResponseBody(authority, 'owned_by_job')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(running), { status: 200 }))
      .mockRejectedValueOnce(new Error('connection failed before request receipt'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({
        disposition: 'retained',
        result: expect.objectContaining({
          status: 'failed',
          error: 'Network error: connection failed before request receipt',
        }),
      }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![0]).toBe(`/api/v1/generation-operations/${operationId}/cancellation`)
    expect(operationMocks.beginDispatch).toHaveBeenCalledWith(pending.handle)
    expect(operationMocks.discard).not.toHaveBeenCalled()
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([
      expect.objectContaining({
        mutationId: pending.handle.mutationId,
        kind: 'stop',
        disposition: 'retained',
      }),
    ])
  })

  it.each(['stale epoch', 'mismatched origin'] as const)('keeps a %s staged Stop dormant', async (scenario) => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const stale = scenario === 'stale epoch'
    const pending = occupiedStopPending(authority, {
      occupancyEpoch: stale ? authority.occupancyEpoch - 1 : authority.occupancyEpoch,
      epochDisposition: stale ? 'stale' : 'current',
    })
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([pending])
    const responseAuthority = {
      ...authority,
      occupancyEpoch: stale ? authority.occupancyEpoch - 1 : authority.occupancyEpoch,
    }
    const running = occupiedResponseBody(responseAuthority, 'owned_by_job')
    if (!stale) running.operation.mode = 'regenerate'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(running), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({ disposition: 'retained' }),
    ])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(operationMocks.discard).not.toHaveBeenCalled()
    expect(get(chatOccupancyGenerationRecoveryProjections)).toEqual([
      expect.objectContaining({
        mutationId: pending.handle.mutationId,
        kind: 'stop',
        disposition: 'retained',
      }),
    ])
  })

  it('replays an exact occupied-chat intent only after status proves the operation is absent', async () => {
    setManagedReaderForTest()
    configureGenerationOperationProtocol({ version: 1 }, 'database-a')
    const authority = occupancyAuthority()
    const staged = await stageAcceptedSendGenerationOperation({
      target: { selectedCharID: -1, chatPage: -1, characterId: 'character-a', chatId: 'chat-a' },
      message: 'safe exact replay',
      chatOccupancy: { authority, interaction: 'send' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: {},
        clientCapabilities: {},
      },
    })
    if ('status' in staged) throw new Error(staged.error)
    operationMocks.listChatOccupancyPending.mockResolvedValueOnce([
      {
        handle: staged.handle,
        intent: staged.intent,
        chatId: 'chat-a',
        occupancyEpoch: authority.occupancyEpoch,
        epochDisposition: 'current',
      },
    ])
    const accepted = occupiedResponseBody(authority)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'generation_operation_not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(accepted), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(replayChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({ disposition: 'succeeded', result: expect.objectContaining({ status: 'accepted' }) }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/v1/generation-operations/${operationId}`)
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/generation-operations')
    expect(operationMocks.beginDispatch).toHaveBeenCalledWith(staged.handle)
  })

  it('grants an observer no recovery authority and does not inspect the scoped outbox', async () => {
    setManagedReaderForTest()
    operationMocks.listOccupancyAuthorities.mockReturnValueOnce([])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(recoverCurrentChatOccupancyGenerationMutations()).resolves.toEqual([])

    expect(operationMocks.listChatOccupancyPending).not.toHaveBeenCalled()
    expect(operationMocks.beginDispatch).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

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
