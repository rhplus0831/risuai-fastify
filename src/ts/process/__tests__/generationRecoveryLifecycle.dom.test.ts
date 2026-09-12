import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { ActiveGenerationJob, GenerationOperationProjection } from '../../server/bootstrap'

const h = vi.hoisted(() => {
  function makeStore<T>(initial: T) {
    let value = initial
    const subscribers = new Set<(next: T) => void>()
    return {
      set(next: T) {
        value = next
        for (const subscriber of subscribers) subscriber(value)
      },
      subscribe(subscriber: (next: T) => void) {
        subscribers.add(subscriber)
        subscriber(value)
        return () => subscribers.delete(subscriber)
      },
      current: () => value,
    }
  }

  const pending: Array<{ handle: Record<string, unknown>; intent: Record<string, unknown> }> = []
  let mutationSequence = 0
  return {
    database: {} as Record<string, unknown>,
    selectedCharID: makeStore(-1),
    fetchBootstrap: vi.fn(),
    hydrateChatMessages: vi.fn(),
    reconcileDirectEvent: vi.fn(async () => undefined),
    pending,
    uuids: [] as string[],
    stagePendingMutation(key: string, intent: Record<string, unknown>) {
      mutationSequence += 1
      const handle = {
        key,
        mutationId: `mutation-${mutationSequence}`,
        sequence: mutationSequence,
        ownerWriterSessionId: 'writer-a',
        writerEpoch: 1,
        databaseLineage: 'database-a',
        phase: 'staged',
        ready: Promise.resolve('persisted'),
      }
      pending.push({ handle, intent })
      return handle
    },
    reset() {
      pending.splice(0)
      mutationSequence = 0
      this.uuids = []
    },
  }
})

vi.mock('../../stores.svelte', () => ({ selectedCharID: h.selectedCharID }))
vi.mock('../../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: vi.fn(async () => 'auth-a') }))
vi.mock('../../chatCommands', () => ({
  appendOptimisticGenerationOperationUserMessage: vi.fn(() => ({ status: 'ok', rollback: vi.fn() })),
  ensureMessageId: vi.fn(),
  mutateChatWithScopedCommand: vi.fn(() => false),
  toMessageSnapshot: (message: unknown) => structuredClone(message),
}))
vi.mock('../../server/activeWriterSession', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-a' }),
  handleActiveWriterStaleResponse: vi.fn(),
  isWriterAccessLost: vi.fn(() => false),
}))
vi.mock('../../server/commands', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-a' }),
  getServerCommandBaseRevision: vi.fn(async () => 7),
  peekCachedServerCommandRevision: vi.fn(() => 7),
  setCachedServerCommandRevision: vi.fn(),
  SERVER_DATABASE_LINEAGE_HEADER: 'risu-database-lineage',
  withDirectServerCommandEventReconciliation: vi.fn(
    async (_matches: unknown, dispatch: (reconcile: typeof h.reconcileDirectEvent) => Promise<unknown>) =>
      dispatch(h.reconcileDirectEvent),
  ),
}))
vi.mock('../../server/resourceState.svelte', () => ({
  charactersResourceState: {
    status: 'ready',
    get characters() {
      return (h.database.characters as unknown[]) ?? []
    },
    get currentChar() {
      return h.selectedCharID.current()
    },
    selectionRevision: null,
  },
  getCharacterResourceOwner: (characterId: string) =>
    ((h.database.characters as Array<{ chaId: string }> | undefined) ?? []).find(
      (character) => character.chaId === characterId,
    ),
  settingsResourceState: {
    status: 'ready',
    groupStatuses: { advanced: 'ready' },
    value: { inlayErrorResponse: false },
  },
  captureChatBodyProjectionEpoch: () => 12,
}))
vi.mock('../../server/chatTranscriptOwner', () => ({
  getChatTranscriptOwnerState: () => ({
    characterId: 'character-a',
    chatId: 'chat-a',
    messages: [],
    projectionEpoch: 12,
    resourceLoaded: true,
  }),
}))
vi.mock('../../server/chatMessageHydration.svelte', () => ({
  getChatMessageOwnerState: vi.fn(() => null),
}))
vi.mock('../../../lib/ChatScreens/DefaultChatScreen.composerDrafts', () => ({
  deleteDefaultChatComposerDraft: vi.fn(() => false),
  isDefaultChatComposerDraftGenerationCurrent: vi.fn(() => false),
}))
vi.mock('../../alert', () => ({ alertError: vi.fn() }))
vi.mock('../../server/protocolDiagnostics', () => ({ recordGenerationRecoveryEvent: vi.fn() }))
vi.mock('../../server/pendingMutationOutbox', () => ({
  beginPendingMutationDispatch: vi.fn(async (handle: { phase: string }) => {
    handle.phase = 'dispatching'
    return 'persisted'
  }),
  discardPendingMutation: vi.fn(async (handle: { mutationId: string }) => {
    const index = h.pending.findIndex((entry) => entry.handle.mutationId === handle.mutationId)
    if (index < 0) return 'superseded'
    h.pending.splice(index, 1)
    return 'deleted'
  }),
  isGenerationOperationPendingIntent: (intent: { kind?: string }) =>
    intent.kind === 'generation-operation-submit' ||
    intent.kind === 'generation-operation-retry' ||
    intent.kind === 'generation-operation-cancel',
  listPendingMutations: vi.fn(async () => [...h.pending]),
  stagePendingMutation: vi.fn((key: string, intent: Record<string, unknown>) => h.stagePendingMutation(key, intent)),
}))
vi.mock('../../server/bootstrap', () => ({
  fetchServerBootstrapReadOnly: h.fetchBootstrap,
  parseGenerationOperations: (values: unknown[]) =>
    values.filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'operationId' in value,
    ),
}))

import {
  authorizeClientWriterRecovery,
  beginClientSession,
  beginClientWriterResume,
  captureClientSessionGeneration,
  completeClientWriterRecovery,
  getClientSessionSnapshot,
  observeClientWriter,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
} from '../../clientSession'
import {
  applyGenerationOperationBootstrap,
  applyGenerationOperationProjection,
  configureGenerationOperationProtocol,
  generationOperationProjections,
  reconcileGenerationOperationLifecycle,
  reconcileGenerationOperationTranscriptHydration,
  replayGenerationRecoveryObligations,
  resetGenerationOperationClientForTests,
  retryGenerationOperation,
  stageAcceptedSendGenerationOperation,
  submitStagedAcceptedSendOperation,
} from '../../server/generationOperations'
import {
  activeGenerationJobs,
  refreshActiveGenerationJobsFromBootstrap,
  resetGenerationJobLifecyclesForTests,
  setActiveGenerationJobs,
  startActiveGenerationReattach,
  stopActiveGenerationReattach,
} from '../reattach'
import {
  activeChatGenerations,
  beginChatGenerationActivity,
  finishChatGenerationActivity,
  resetChatGenerationActivitiesForTests,
} from '../generationActivity.svelte'
import {
  beginGenerationRecoveryObligation,
  captureGenerationRecoveryObligations,
  markGenerationRecoveryObligationUncertain,
  resetGenerationRecoveryObligations,
} from '../generationRecoveryObligations'
import {
  registerChatHydrationRuntime,
  registerGenerationOperationsRuntime,
  registerGenerationProcessRuntime,
  registerRecoveredEffectsRuntime,
  registerServerChatRuntime,
} from '../generationRuntimeBridge'
import { acceptedSendRecoveryById, resetAcceptedSendRecoveryStateForTests } from '../acceptedSendRecoveryState'
import {
  recordStartupMilestone,
  resetStartupReadinessForTests,
  settleStartupChatReadiness,
  settleStartupGenerationRecoveryReadiness,
} from '../../startupReadiness'

const operationId = '11111111-1111-4111-8111-111111111111'
const messageId = '22222222-2222-4222-8222-222222222222'
const retryRequestId = '33333333-3333-4333-8333-333333333333'

function operation(
  state: GenerationOperationProjection['state'],
  options: Partial<GenerationOperationProjection> = {},
): GenerationOperationProjection {
  return {
    operationId,
    protocolVersion: 1,
    requestOrigin: 'accepted_send',
    state,
    stateVersion: 2,
    projectionEpoch: 2,
    creatorWriterSessionId: 'writer-a',
    creatorWriterEpoch: 1,
    characterId: 'character-a',
    chatId: 'chat-a',
    mode: 'send',
    acceptedMessageId: messageId,
    acceptedRevision: 8,
    providerMayHaveRun: state !== 'accepted',
    ...options,
  }
}

function runningResponse(op = operation('owned_by_job')) {
  const currentAttempt =
    op.currentAttempt ??
    ({
      attemptNo: 1,
      retryRequestId: 'initial-attempt',
      jobId: 'job-a',
      status: 'running',
      serverInstanceId: 'server-a',
      actorWriterSessionId: 'writer-a',
      actorWriterEpoch: 1,
      launchRevision: 8,
    } satisfies NonNullable<GenerationOperationProjection['currentAttempt']>)
  const projected = { ...op, currentAttempt }
  return {
    operation: projected,
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
      href: `/api/v1/generation-operations/${projected.operationId}/stream?attemptNo=${currentAttempt.attemptNo}&jobId=${currentAttempt.jobId}&projectionEpoch=${projected.projectionEpoch}`,
    },
  }
}

function bootstrap(
  operations: readonly GenerationOperationProjection[],
  activeJobs: readonly ActiveGenerationJob[] = [],
  epoch = operations.reduce((maximum, candidate) => Math.max(maximum, candidate.projectionEpoch), 0),
) {
  return {
    status: 'ok' as const,
    bootstrap: {
      initialized: true,
      revision: 8,
      databaseLineage: 'database-a',
      generationOperationProtocol: { version: 1 },
      generationOperationProjectionEpoch: epoch,
      generationOperations: [...operations],
      activeGenerationJobs: [...activeJobs],
    },
  }
}

function generationInput() {
  return {
    target: { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
    message: 'hello',
    generation: {
      syntheticSayNothing: false,
      resetMessages: false,
      inlayAssetRefs: [],
      clientContext: {},
      clientCapabilities: {},
    },
  }
}

async function stageSend() {
  const staged = await stageAcceptedSendGenerationOperation(generationInput())
  if ('status' in staged) throw new Error(staged.error)
  return staged
}

function setReadyWriter(): void {
  const startup = beginClientSession('writer-a')
  const ownership = { databaseLineage: 'database-a', writer: { sessionId: 'writer-a', epoch: 1 } }
  authorizeClientWriterRecovery(startup, ownership)
  setClientProjectionReady(true)
  setClientConnectionState('live')
  if (!completeClientWriterRecovery(startup)) throw new Error('Could not prepare the managed writer fixture.')
}

function settleGenerationReadiness(): void {
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
}

function seedUnrelatedPendingMutation(): void {
  h.stagePendingMutation('unrelated-settings', {
    version: 1,
    requests: [{ method: 'PATCH', path: '/settings', body: { theme: 'dark' } }],
  })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

beforeEach(() => {
  stopActiveGenerationReattach()
  resetGenerationOperationClientForTests()
  resetGenerationJobLifecyclesForTests()
  resetGenerationRecoveryObligations()
  resetAcceptedSendRecoveryStateForTests()
  resetChatGenerationActivitiesForTests()
  resetClientSessionForTests()
  resetStartupReadinessForTests()
  h.reset()
  h.database = { characters: [] }
  h.selectedCharID.set(-1)
  h.fetchBootstrap.mockReset()
  h.hydrateChatMessages.mockReset()
  h.reconcileDirectEvent.mockClear()
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => h.uuids.shift()) })

  setReadyWriter()
  settleGenerationReadiness()
  configureGenerationOperationProtocol({ version: 1 }, 'database-a')
  registerGenerationOperationsRuntime({
    applyGenerationOperationBootstrap,
    generationOperationProjections,
    generationOperationStreamForActiveJob: (_job: never) => undefined,
    isProtocolGenerationOperationJob: (job: { operationId?: string }) => Boolean(job.operationId),
    readGenerationOperationStatus: vi.fn(async () => ({ status: 'retained', error: 'unused' })),
    replayGenerationRecoveryObligations,
    retireGenerationOperationViewers: vi.fn(),
    retryGenerationOperation,
    stopGenerationOperation: vi.fn(async () => ({ status: 'failed', error: 'unused' })),
  } as never)
  registerChatHydrationRuntime({
    acknowledgeMessageMutationLocalEffect: vi.fn(),
    hydrateChatMessages: h.hydrateChatMessages,
    stopChatMessageHydration: vi.fn(),
  } as never)
  registerGenerationProcessRuntime({
    clearActiveGenerationAbortController: vi.fn(),
    createActiveGenerationAbortController: vi.fn(() => new AbortController()),
    sendChat: vi.fn(async () => false),
  } as never)
  registerServerChatRuntime({
    cancelServerChatGeneration: vi.fn(async () => ({ status: 'failed', error: 'unused' })),
    retireGenerationJobViewers: vi.fn(),
  } as never)
  registerRecoveredEffectsRuntime({
    reconcilePendingRecoveredGenerationEffects: vi.fn(async () => undefined),
    setPendingRecoveredGenerationEffects: vi.fn(),
  })
})

afterEach(() => {
  stopActiveGenerationReattach()
  resetGenerationOperationClientForTests()
  resetGenerationRecoveryObligations()
  resetAcceptedSendRecoveryStateForTests()
  resetChatGenerationActivitiesForTests()
  resetClientSessionForTests()
  resetStartupReadinessForTests()
  vi.unstubAllGlobals()
})

describe('generation recovery lifecycle integration', () => {
  it('recovers a lost protocol response through visibility, hydrates terminal authority, and selectively settles', async () => {
    h.uuids = [operationId, messageId]
    const transportSnapshots: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        transportSnapshots.push(captureGenerationRecoveryObligations())
        throw new Error('response lost after write')
      }),
    )
    const activity = beginChatGenerationActivity({
      target: generationInput().target,
      kind: 'message',
      operationId,
    })!
    const staged = await stageSend()

    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'retained' })
    finishChatGenerationActivity(activity.id)

    expect(transportSnapshots).toEqual([
      [expect.objectContaining({ operationId, chatId: 'chat-a', kind: 'submit', phase: 'dispatching' })],
    ])
    expect(get(activeGenerationJobs)).toEqual([])
    expect(get(activeChatGenerations)).toEqual([])
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ operationId, kind: 'submit', phase: 'uncertain' }),
    ])
    seedUnrelatedPendingMutation()

    const completed = operation('completed', {
      stateVersion: 4,
      projectionEpoch: 4,
      resultMessageId: 'assistant-a',
    })
    h.fetchBootstrap.mockResolvedValueOnce(bootstrap([completed], [], 4))
    h.hydrateChatMessages.mockImplementationOnce(async (chatId: string, options: unknown) => {
      expect(chatId).toBe('chat-a')
      expect(options).toMatchObject({ force: true, strict: true, signal: expect.any(AbortSignal) })
      expect(captureGenerationRecoveryObligations()).toEqual([
        expect.objectContaining({
          operationId,
          phase: 'awaiting_transcript',
          terminalAuthority: expect.objectContaining({ state: 'completed', resultMessageId: 'assistant-a' }),
        }),
      ])
      reconcileGenerationOperationTranscriptHydration('chat-a', [
        { role: 'user', chatId: messageId },
        { role: 'char', chatId: 'assistant-a', generationInfo: { operationId } },
      ])
    })
    startActiveGenerationReattach()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(h.hydrateChatMessages).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(captureGenerationRecoveryObligations()).toEqual([]))

    expect(get(generationOperationProjections)).toEqual([completed])
    expect(acceptedSendRecoveryById(operationId)).toBeUndefined()
    expect(h.pending).toHaveLength(1)
    expect(h.pending[0]?.handle.key).toBe('unrelated-settings')
  })

  it('keeps a pending obligation through empty bootstrap and same-writer resume, then fences foreign scope loss', async () => {
    h.uuids = [operationId, messageId]
    let reject!: (error: Error) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((_resolve, rejectPromise) => {
          reject = rejectPromise
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const staged = await stageSend()
    const pending = submitStagedAcceptedSendOperation(staged)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const dispatching = captureGenerationRecoveryObligations()[0]
    h.fetchBootstrap.mockResolvedValueOnce(bootstrap([], [], 1))
    startActiveGenerationReattach()

    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(h.fetchBootstrap).toHaveBeenCalledOnce())
    await flushMicrotasks()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(captureGenerationRecoveryObligations()).toEqual([dispatching])

    const generationBeforeInterruption = getClientSessionSnapshot().generation
    setClientConnectionState('interrupted')
    const resume = beginClientWriterResume()!
    expect(getClientSessionSnapshot().generation).toBe(generationBeforeInterruption + 2)
    authorizeClientWriterRecovery(resume, {
      databaseLineage: 'database-a',
      writer: { sessionId: 'writer-a', epoch: 1 },
    })
    setClientConnectionState('live')
    expect(completeClientWriterRecovery(resume)).toBe(true)
    expect(captureGenerationRecoveryObligations()).toEqual([dispatching])

    expect(observeClientWriter({ sessionId: 'foreign-writer', epoch: 2 })).toBe(true)
    expect(captureGenerationRecoveryObligations()).toEqual([])
    reject(new Error('late response loss'))
    await expect(pending).resolves.toMatchObject({ status: 'retained' })
    expect(captureGenerationRecoveryObligations()).toEqual([])
  })

  it('replays the exact retained submit after empty authority and preserves unrelated outbox work', async () => {
    h.uuids = [operationId, messageId]
    seedUnrelatedPendingMutation()
    const requestBodies: unknown[] = []
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      if (requestBodies.length === 1) throw new Error('request may not have arrived')
      return new Response(JSON.stringify(runningResponse()), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const staged = await stageSend()
    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'retained' })
    h.fetchBootstrap.mockResolvedValueOnce(bootstrap([], [], 1))
    startActiveGenerationReattach()

    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(captureGenerationRecoveryObligations()).toEqual([]))

    expect(requestBodies[1]).toEqual(requestBodies[0])
    expect(requestBodies[1]).toMatchObject({ operationId, acceptedMessageId: messageId })
    expect(get(activeGenerationJobs)).toEqual([
      expect.objectContaining({ operationId, jobId: 'job-a', chatId: 'chat-a' }),
    ])
    expect(h.pending).toHaveLength(1)
    expect(h.pending[0]?.handle.key).toBe('unrelated-settings')
  })

  it('rejects an operation/job epoch disagreement atomically without clearing exact recovery interest', () => {
    const baseline = operation('owned_by_job', {
      operationId: 'baseline-operation',
      acceptedMessageId: 'baseline-message',
      projectionEpoch: 10,
      stateVersion: 2,
      currentAttempt: {
        attemptNo: 1,
        retryRequestId: 'baseline-retry',
        jobId: 'baseline-job',
        status: 'running',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'writer-a',
        actorWriterEpoch: 1,
        launchRevision: 8,
      },
    })
    expect(applyGenerationOperationBootstrap(bootstrap([baseline], [], 10).bootstrap, 'bootstrap')).toBe(true)
    setActiveGenerationJobs([{ chatId: 'other-chat', jobId: 'epoch-12-job' }], { projectionEpoch: 12 })
    const token = beginGenerationRecoveryObligation({
      operationId,
      chatId: 'chat-a',
      kind: 'submit',
      sourceGeneration: captureClientSessionGeneration(),
    })
    markGenerationRecoveryObligationUncertain(token)
    const incoming = operation('owned_by_job', { projectionEpoch: 11, stateVersion: 3 })

    expect(
      reconcileGenerationOperationLifecycle({
        kind: 'bootstrap',
        source: 'visibility',
        runtime: bootstrap([incoming], [], 11).bootstrap,
      }),
    ).toBe(false)

    expect(get(generationOperationProjections)).toEqual([baseline])
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'other-chat', jobId: 'epoch-12-job' }])
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ token, operationId, phase: 'uncertain' }),
    ])
  })

  it('receipts a completed retry without a live descriptor, then hydrates without clearing a newer obligation', async () => {
    const retryable = operation('retryable', { stateVersion: 5, projectionEpoch: 5 })
    applyGenerationOperationProjection(retryable)
    h.uuids = [retryRequestId]
    const completed = operation('completed', { stateVersion: 9, projectionEpoch: 9, resultMessageId: 'assistant-a' })
    const bodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length === 1) throw new Error('accepted retry response lost')
        return new Response(JSON.stringify({ operation: completed, acceptedRetryRequestId: retryRequestId }), {
          status: 200,
        })
      }),
    )
    await expect(retryGenerationOperation(operationId, 5)).resolves.toMatchObject({ status: 'retained' })
    h.fetchBootstrap.mockResolvedValueOnce(bootstrap([completed], [], 9))
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    h.hydrateChatMessages.mockImplementationOnce(async () => {
      await barrier
    })
    startActiveGenerationReattach()
    const recovery = refreshActiveGenerationJobsFromBootstrap()
    await vi.waitFor(() => expect(h.hydrateChatMessages).toHaveBeenCalledOnce())
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ kind: 'retry', retryRequestId, phase: 'awaiting_transcript' }),
      expect.objectContaining({ kind: 'retry', retryRequestId, phase: 'awaiting_transcript' }),
    ])
    expect(h.pending).toEqual([])
    expect(bodies).toEqual([
      { retryRequestId, expectedStateVersion: 5 },
      { retryRequestId, expectedStateVersion: 5 },
    ])
    const newer = beginGenerationRecoveryObligation({
      operationId,
      chatId: 'chat-a',
      kind: 'cancel',
      minimumStateVersion: 10,
      sourceGeneration: captureClientSessionGeneration(),
    })
    markGenerationRecoveryObligationUncertain(newer)
    release()
    await recovery
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ token: newer, kind: 'cancel', phase: 'uncertain' }),
    ])
    expect(get(generationOperationProjections)).toEqual([completed])
  })

  it('settles terminal Chat B while Chat A strict hydration fails, and later retries only Chat A', async () => {
    const a = operation('completed', { stateVersion: 5, projectionEpoch: 5, resultMessageId: 'assistant-a' })
    const b = operation('completed', {
      operationId: 'operation-b',
      chatId: 'chat-b',
      stateVersion: 5,
      projectionEpoch: 5,
      resultMessageId: 'assistant-b',
    })
    for (const op of [a, b]) {
      const token = beginGenerationRecoveryObligation({
        operationId: op.operationId,
        chatId: op.chatId,
        kind: 'submit',
        sourceGeneration: captureClientSessionGeneration(),
      })
      markGenerationRecoveryObligationUncertain(token)
    }
    startActiveGenerationReattach()
    h.fetchBootstrap.mockResolvedValue(bootstrap([a, b], [], 5))
    h.hydrateChatMessages.mockImplementation(async (chatId: string) => {
      if (chatId === 'chat-a') throw new Error('A transcript unavailable')
    })
    await refreshActiveGenerationJobsFromBootstrap()
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ operationId, chatId: 'chat-a', phase: 'awaiting_transcript' }),
    ])
    expect(h.hydrateChatMessages.mock.calls.map(([chatId]) => chatId)).toEqual(['chat-a', 'chat-b', 'chat-a'])
    h.hydrateChatMessages.mockReset().mockResolvedValue(undefined)
    await refreshActiveGenerationJobsFromBootstrap()
    expect(h.hydrateChatMessages.mock.calls.map(([chatId]) => chatId)).toEqual(['chat-a'])
    expect(captureGenerationRecoveryObligations()).toEqual([])
    startActiveGenerationReattach()
    window.dispatchEvent(new Event('focus'))
    await flushMicrotasks()
    expect(h.fetchBootstrap).toHaveBeenCalledTimes(2)
  })

  it('does not settle an unknown retry response from the old retryable state', async () => {
    const retryable = operation('retryable', {
      requestOrigin: 'regenerate',
      mode: 'regenerate',
      acceptedMessageId: undefined,
      targetMessageId: 'assistant-old',
      stateVersion: 5,
      projectionEpoch: 5,
      currentAttempt: {
        attemptNo: 1,
        retryRequestId: 'retry-old',
        jobId: 'job-old',
        status: 'retryable_failed',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'writer-a',
        actorWriterEpoch: 1,
        launchRevision: 8,
      },
    })
    applyGenerationOperationProjection(retryable)
    h.uuids = [retryRequestId]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('retry response lost')
      }),
    )
    await expect(retryGenerationOperation(operationId, retryable.stateVersion)).resolves.toMatchObject({
      status: 'retained',
    })
    const uncertain = captureGenerationRecoveryObligations()[0]!
    expect(uncertain).toMatchObject({
      kind: 'retry',
      operationId,
      retryRequestId,
      minimumStateVersion: 6,
      phase: 'uncertain',
    })

    reconcileGenerationOperationLifecycle({ kind: 'operation', source: 'status', operation: retryable })
    expect(captureGenerationRecoveryObligations()).toEqual([uncertain])

    const acceptedRetry = operation('owned_by_job', {
      requestOrigin: 'regenerate',
      mode: 'regenerate',
      acceptedMessageId: undefined,
      targetMessageId: 'assistant-old',
      stateVersion: 6,
      projectionEpoch: 6,
      currentAttempt: {
        attemptNo: 2,
        retryRequestId,
        jobId: 'job-retry',
        status: 'running',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'writer-a',
        actorWriterEpoch: 1,
        launchRevision: 9,
      },
    })
    reconcileGenerationOperationLifecycle({ kind: 'operation', source: 'retry', operation: acceptedRetry })

    expect(captureGenerationRecoveryObligations()).toEqual([])
    expect(get(activeGenerationJobs)).toEqual([
      expect.objectContaining({ operationId, attemptNo: 2, jobId: 'job-retry' }),
    ])
  })
})
