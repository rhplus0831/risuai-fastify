import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { ActiveGenerationJob, GenerationOperationProjection } from '../../server/bootstrap'

// vi.hoisted runs before imports, so build minimal svelte-store-contract fakes
// inline rather than importing `writable`.
const h = vi.hoisted(() => {
  function makeStore<T>(initial: T) {
    let value = initial
    const subs = new Set<(value: T) => void>()
    return {
      set(next: T) {
        value = next
        for (const fn of subs) fn(value)
      },
      subscribe(fn: (value: T) => void) {
        subs.add(fn)
        fn(value)
        return () => subs.delete(fn)
      },
      current() {
        return value
      },
    }
  }
  return {
    database: {} as Record<string, unknown>,
    selectedCharID: makeStore(-1),
    doingChat: makeStore(false),
    createActiveGenerationAbortController: vi.fn(() => new AbortController()),
    clearActiveGenerationAbortController: vi.fn(),
    sendChat: vi.fn(
      async (
        _chatProcessIndex: number,
        _args: {
          signal?: AbortSignal
          reattachJobId?: string
          generationOperationStream?: {
            operationId: string
            attemptNo: number
            jobId: string
            projectionEpoch: number
            href: string
          }
          onReattachOutcome?: (outcome: {
            status:
              | 'retryable_transport_failure'
              | 'terminal_failure'
              | 'missing_job'
              | 'aborted'
              | 'cancelled'
              | 'completed'
            error?: string
          }) => void
        },
      ) => true,
    ),
    fetchRuntimeJobs: vi.fn(),
    readGenerationOperationStatus: vi.fn(async () => ({ status: 'retained', error: 'test status probe' })),
    setCachedServerCommandRevision: vi.fn(),
    hydrateChatMessages: vi.fn(
      async (_chatId?: string, _options?: { force?: boolean; strict?: boolean; signal?: AbortSignal | null }) =>
        undefined,
    ),
    cancelServerChatGeneration: vi.fn(async () => undefined),
    captureGenerationJobViewerFence: vi.fn(() => 17),
    retireGenerationJobViewers: vi.fn(),
    applyGenerationOperationBootstrap: vi.fn(),
    isProtocolGenerationOperationJob: vi.fn((job: { operationId?: string }) => Boolean(job.operationId)),
    generationOperationStreamForActiveJob: vi.fn((job: ActiveGenerationJob) =>
      job.operationId
        ? {
            operationId: job.operationId,
            ...(job.acceptedMessageId ? { acceptedMessageId: job.acceptedMessageId } : {}),
            attemptNo: job.attemptNo ?? 1,
            jobId: job.jobId,
            projectionEpoch: job.projectionEpoch ?? 1,
            href: `/api/v1/generation-operations/${job.operationId}/stream?attemptNo=${job.attemptNo ?? 1}&jobId=${job.jobId}&projectionEpoch=${job.projectionEpoch ?? 1}`,
          }
        : undefined,
    ),
    stopGenerationOperation: vi.fn(async () => ({ status: 'acknowledged' })),
    captureGenerationOperationViewerFence: vi.fn(() => 29),
    retireGenerationOperationViewers: vi.fn(),
    retryGenerationOperation: vi.fn(),
    replayGenerationRecoveryObligations: vi.fn(async () => false),
    generationOperationProjections: makeStore([]),
  }
})

vi.mock('../../stores.svelte', () => ({
  selectedCharID: h.selectedCharID,
}))

vi.mock('../../storage/database.svelte', () => ({
  getDatabase: () => h.database,
}))

vi.mock('../../server/resourceState.svelte', () => ({
  charactersResourceState: {
    status: 'ready',
    get characters() {
      return (h.database.characters as Array<{ chaId: string }> | undefined) ?? []
    },
    get currentChar() {
      return h.selectedCharID.current()
    },
    selectionRevision: null,
  },
  getCharacterResourceOwner: (characterId: string) => {
    const matches = ((h.database.characters as Array<{ chaId: string }> | undefined) ?? []).filter(
      (character) => character.chaId === characterId,
    )
    return matches.length === 1 ? matches[0] : undefined
  },
}))

vi.mock('../../server/bootstrap', () => ({
  fetchServerBootstrapReadOnly: h.fetchRuntimeJobs,
}))

vi.mock('../../server/commands', () => ({
  setCachedServerCommandRevision: h.setCachedServerCommandRevision,
}))

vi.mock('../../server/chatMessageHydration.svelte', () => ({
  hydrateChatMessages: h.hydrateChatMessages,
}))

vi.mock('../request/serverChat', () => ({
  cancelServerChatGeneration: h.cancelServerChatGeneration,
  retireGenerationJobViewers: h.retireGenerationJobViewers,
}))

vi.mock('../../server/generationOperations', () => ({
  applyGenerationOperationBootstrap: h.applyGenerationOperationBootstrap,
  generationOperationStreamForActiveJob: h.generationOperationStreamForActiveJob,
  isProtocolGenerationOperationJob: h.isProtocolGenerationOperationJob,
  stopGenerationOperation: h.stopGenerationOperation,
  retireGenerationOperationViewers: h.retireGenerationOperationViewers,
  retryGenerationOperation: h.retryGenerationOperation,
  replayGenerationRecoveryObligations: h.replayGenerationRecoveryObligations,
  generationOperationProjections: h.generationOperationProjections,
}))

vi.mock('../index.svelte', () => ({
  sendChat: h.sendChat,
  doingChat: h.doingChat,
  createActiveGenerationAbortController: h.createActiveGenerationAbortController,
  clearActiveGenerationAbortController: h.clearActiveGenerationAbortController,
}))

import {
  activeGenerationJobs,
  authoritativeGenerationJobForChat,
  clearActiveGenerationJobProjection,
  forgetActiveGenerationJob,
  generationJobLifecycles,
  hasUnresolvedGenerationAuthorityForTests,
  maybeReattachOpenChatGeneration,
  prepareOpenChatGenerationReattach,
  refreshActiveGenerationJobsFromBootstrap,
  refreshGenerationJobFromBootstrap,
  rememberActiveGenerationJob,
  retainUnresolvedGenerationAuthority,
  resetGenerationJobLifecyclesForTests,
  retryGenerationJobReattach,
  setActiveGenerationReattachReadinessPredicate,
  setActiveGenerationJobs,
  startActiveGenerationReattach,
  stopGenerationJob,
  stopActiveGenerationReattach,
  triggerOpenChatGenerationReattach,
} from '../reattach'
import { applyGenerationRecoveryOperation } from '../generationRecoveryObligations'
import {
  beginChatGenerationActivity,
  finishChatGenerationActivity,
  resetChatGenerationActivitiesForTests,
} from '../generationActivity.svelte'
import {
  getGenerationOperationsRuntime,
  registerChatHydrationRuntime,
  registerGenerationOperationsRuntime,
  registerGenerationProcessRuntime,
  registerRecoveredEffectsRuntime,
  registerServerChatRuntime,
} from '../generationRuntimeBridge'

async function usePartialProtocolOperation() {
  const runtime = getGenerationOperationsRuntime()
  const operations = await vi.importActual<typeof import('../../server/generationOperations')>(
    '../../server/generationOperations',
  )
  registerGenerationOperationsRuntime(runtime)
  const operation: GenerationOperationProjection = {
    operationId: 'operation-partial',
    protocolVersion: 1,
    requestOrigin: 'accepted_send',
    state: 'owned_by_job',
    stateVersion: 2,
    projectionEpoch: 40,
    creatorWriterSessionId: 'writer-a',
    creatorWriterEpoch: 1,
    characterId: 'char-a',
    chatId: 'chat-1',
    mode: 'send',
    providerMayHaveRun: true,
  }
  operations.generationOperationProjections.set([operation])
  const applyBootstrap = h.applyGenerationOperationBootstrap.getMockImplementation()!
  h.applyGenerationOperationBootstrap.mockImplementation((runtime, source) => {
    operations.generationOperationProjections.set(runtime.generationOperations ?? [])
    return applyBootstrap(runtime, source)
  })
  h.generationOperationStreamForActiveJob.mockImplementation(operations.generationOperationStreamForActiveJob)
  h.isProtocolGenerationOperationJob.mockImplementation(operations.isProtocolGenerationOperationJob)
  // A job_accepted frame can retain the job while its earlier operation
  // projection still lacks currentAttempt. Bootstrap can repair this later.
  const job = {
    chatId: 'chat-1',
    jobId: 'job-partial',
    operationId: operation.operationId,
    operationStateVersion: operation.stateVersion,
    projectionEpoch: operation.projectionEpoch,
    attemptNo: 1,
  }
  rememberActiveGenerationJob(job)
  return { job, operation, operations }
}

function withProtocolAttempt(operation: GenerationOperationProjection): GenerationOperationProjection {
  return {
    ...operation,
    currentAttempt: {
      attemptNo: 1,
      retryRequestId: 'retry-a',
      jobId: 'job-partial',
      status: 'running',
      serverInstanceId: 'server-a',
      actorWriterSessionId: 'writer-a',
      actorWriterEpoch: 1,
      launchRevision: 8,
    },
  }
}

function setPendingGenerationOperation(
  operationId: string,
  chatId = 'chat-1',
  state: GenerationOperationProjection['state'] = 'accepted',
): void {
  h.generationOperationProjections.set([
    {
      operationId,
      protocolVersion: 1,
      requestOrigin: state === 'cancel_requested' ? 'unbound' : 'accepted_send',
      state,
      stateVersion: 1,
      projectionEpoch: 1,
      creatorWriterSessionId: 'writer-a',
      creatorWriterEpoch: 1,
      characterId: 'char-a',
      chatId,
      mode: 'send',
      providerMayHaveRun: false,
    },
  ])
}

function openChat(chatId: string): void {
  const characters = [{ chaId: 'char-a', chatPage: 0, chats: [{ id: chatId, message: [] }] }]
  h.database = { characters }
  h.selectedCharID.set(0)
}

function reportReattachOutcome(
  status: 'retryable_transport_failure' | 'terminal_failure' | 'missing_job' | 'cancelled' | 'completed',
): void {
  h.sendChat.mockImplementationOnce(async (_chatProcessIndex, args) => {
    args.onReattachOutcome?.({ status, error: status === 'completed' ? undefined : `${status} test error` })
    return status === 'completed'
  })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

beforeEach(() => {
  registerGenerationProcessRuntime({
    clearActiveGenerationAbortController: h.clearActiveGenerationAbortController,
    createActiveGenerationAbortController: h.createActiveGenerationAbortController,
    sendChat: h.sendChat,
  } as never)
  registerGenerationOperationsRuntime({
    applyGenerationOperationBootstrap: h.applyGenerationOperationBootstrap,
    captureGenerationOperationViewerFence: h.captureGenerationOperationViewerFence,
    generationOperationProjections: h.generationOperationProjections,
    generationOperationStreamForActiveJob: h.generationOperationStreamForActiveJob,
    isProtocolGenerationOperationJob: h.isProtocolGenerationOperationJob,
    readGenerationOperationStatus: h.readGenerationOperationStatus,
    replayGenerationRecoveryObligations: h.replayGenerationRecoveryObligations,
    retireGenerationOperationViewers: h.retireGenerationOperationViewers,
    retryGenerationOperation: h.retryGenerationOperation,
    stopGenerationOperation: h.stopGenerationOperation,
  } as never)
  registerChatHydrationRuntime({ hydrateChatMessages: h.hydrateChatMessages } as never)
  registerServerChatRuntime({
    cancelServerChatGeneration: h.cancelServerChatGeneration,
    captureGenerationJobViewerFence: h.captureGenerationJobViewerFence,
    retireGenerationJobViewers: h.retireGenerationJobViewers,
  } as never)
  registerRecoveredEffectsRuntime({
    reconcilePendingRecoveredGenerationEffects: vi.fn(async () => undefined),
    setPendingRecoveredGenerationEffects: vi.fn(),
  })
  h.database = { characters: [] }
  h.selectedCharID.set(-1)
  h.sendChat.mockReset()
  h.sendChat.mockResolvedValue(true)
  h.createActiveGenerationAbortController.mockClear()
  h.clearActiveGenerationAbortController.mockClear()
  h.fetchRuntimeJobs.mockReset()
  h.readGenerationOperationStatus.mockReset()
  h.fetchRuntimeJobs.mockResolvedValue({
    status: 'ok',
    bootstrap: { activeGenerationJobs: [] },
  })
  h.setCachedServerCommandRevision.mockClear()
  h.hydrateChatMessages.mockClear()
  h.cancelServerChatGeneration.mockClear()
  h.captureGenerationJobViewerFence.mockClear()
  h.retireGenerationJobViewers.mockClear()
  h.applyGenerationOperationBootstrap.mockClear()
  h.applyGenerationOperationBootstrap.mockImplementation((runtime, source) => {
    for (const operation of runtime.generationOperations ?? []) applyGenerationRecoveryOperation(operation)
    setActiveGenerationJobs(runtime.activeGenerationJobs ?? [], {
      projectionEpoch: runtime.generationOperationProjectionEpoch ?? 0,
      operations: runtime.generationOperations ?? [],
      source,
    })
    return true
  })
  h.isProtocolGenerationOperationJob.mockReset()
  h.generationOperationStreamForActiveJob.mockReset()
  h.stopGenerationOperation.mockClear()
  h.captureGenerationOperationViewerFence.mockClear()
  h.retireGenerationOperationViewers.mockClear()
  h.retryGenerationOperation.mockReset()
  h.replayGenerationRecoveryObligations.mockReset()
  h.replayGenerationRecoveryObligations.mockResolvedValue(false)
  h.generationOperationProjections.set([])
  h.doingChat.set(false)
  resetGenerationJobLifecyclesForTests()
  setActiveGenerationReattachReadinessPredicate(() => true)
  setActiveGenerationJobs([])
  resetChatGenerationActivitiesForTests()
})

describe('reattach open-chat generation', () => {
  it('retains partial protocol metadata for bounded recovery when authority is unavailable', async () => {
    openChat('chat-1')
    const { job, operations } = await usePartialProtocolOperation()
    expect(operations.isProtocolGenerationOperationJob(job)).toBe(true)
    expect(operations.generationOperationStreamForActiveJob(job)).toBeUndefined()
    h.fetchRuntimeJobs.mockResolvedValue({ status: 'error', error: 'bootstrap offline' })

    await maybeReattachOpenChatGeneration()
    triggerOpenChatGenerationReattach()
    triggerOpenChatGenerationReattach()
    await flushMicrotasks()

    expect.soft(authoritativeGenerationJobForChat(job.chatId)).toEqual(job)
    expect.soft(get(activeGenerationJobs)).toEqual([job])
    expect.soft(h.fetchRuntimeJobs).toHaveBeenCalledOnce()
    expect.soft(get(generationJobLifecycles)[job.jobId]).toMatchObject({
      status: 'exhausted-dead',
      lastError: 'bootstrap offline',
    })
    expect(h.sendChat).not.toHaveBeenCalled()
    expect(h.createActiveGenerationAbortController).not.toHaveBeenCalled()
    expect(h.retryGenerationOperation).not.toHaveBeenCalled()
  })

  it('reattaches once when the bounded authority probe supplies the missing attempt metadata', async () => {
    openChat('chat-1')
    const { job, operation } = await usePartialProtocolOperation()
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: {
        generationOperationProjectionEpoch: 40,
        generationOperations: [withProtocolAttempt(operation)],
        activeGenerationJobs: [job],
      },
    })

    await maybeReattachOpenChatGeneration()
    await flushMicrotasks()

    expect(h.readGenerationOperationStatus).toHaveBeenCalledOnce()
    expect(h.readGenerationOperationStatus).toHaveBeenCalledWith(job.operationId, expect.any(AbortSignal))
    expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()
    expect(h.sendChat).toHaveBeenCalledOnce()
    expect(h.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        generationOperationStream: expect.objectContaining({
          operationId: job.operationId,
          jobId: job.jobId,
          attemptNo: 1,
          projectionEpoch: 40,
        }),
      }),
    )
    expect(h.retryGenerationOperation).not.toHaveBeenCalled()
    expect(get(activeGenerationJobs)).toEqual([])
    expect(get(generationJobLifecycles)[job.jobId]?.status).toBe('completed')
    triggerOpenChatGenerationReattach()
    await flushMicrotasks()
    expect(h.sendChat).toHaveBeenCalledOnce()
  })

  it('bounds unchanged incomplete authority and permits a later explicit metadata recovery', async () => {
    vi.useFakeTimers()
    try {
      openChat('chat-1')
      const { job, operation, operations } = await usePartialProtocolOperation()
      const incompleteOperation = withProtocolAttempt({ ...operation, stateVersion: 1 })
      operations.generationOperationProjections.set([incompleteOperation])
      h.fetchRuntimeJobs.mockResolvedValue({
        status: 'ok',
        bootstrap: {
          generationOperationProjectionEpoch: 40,
          // The retained job carries the newer acceptance state version. The
          // older operation cannot provide an exact descriptor for that job.
          generationOperations: [incompleteOperation],
          activeGenerationJobs: [job],
        },
      })

      await maybeReattachOpenChatGeneration()
      for (let index = 0; index < 4; index += 1) {
        triggerOpenChatGenerationReattach()
        await flushMicrotasks()
      }
      expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()
      expect(h.sendChat).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(get(activeGenerationJobs)).toEqual([expect.objectContaining(job)])
      expect(get(generationJobLifecycles)[job.jobId]).toMatchObject({
        status: 'exhausted-dead',
        lastError: 'Generation retry returned no live stream.',
      })

      await retryGenerationJobReattach(job.jobId)
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(2)
      expect(h.sendChat).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      h.fetchRuntimeJobs.mockResolvedValueOnce({
        status: 'ok',
        bootstrap: {
          generationOperationProjectionEpoch: 40,
          generationOperations: [withProtocolAttempt(operation)],
          activeGenerationJobs: [job],
        },
      })
      await retryGenerationJobReattach(job.jobId)
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(3)
      expect(h.sendChat).toHaveBeenCalledOnce()
      expect(h.retryGenerationOperation).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('rejects stale descriptor recovery when a held probe loses its selected-chat authority', async () => {
    openChat('chat-1')
    const { job } = await usePartialProtocolOperation()
    let settleProbe!: (value: unknown) => void
    h.fetchRuntimeJobs.mockImplementationOnce(() => new Promise((resolve) => (settleProbe = resolve)))

    const attachment = maybeReattachOpenChatGeneration()
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce())
    expect(get(activeGenerationJobs)).toEqual([job])
    const replacement = { chatId: job.chatId, jobId: 'job-replacement' }
    setActiveGenerationJobs([replacement], { projectionEpoch: 41 })
    let settleReplacement!: () => void
    h.sendChat.mockImplementationOnce(() => new Promise((resolve) => (settleReplacement = () => resolve(true))))
    settleProbe({ status: 'error', error: 'late authority failure' })
    await attachment
    await flushMicrotasks()

    expect(authoritativeGenerationJobForChat(job.chatId)).toEqual(replacement)
    expect(get(generationJobLifecycles)[job.jobId]).toBeUndefined()
    expect(h.sendChat).toHaveBeenCalledOnce()
    expect(h.sendChat).toHaveBeenCalledWith(-1, expect.objectContaining({ reattachJobId: replacement.jobId }))
    settleReplacement()
    await flushMicrotasks()
  })

  it('accepts repaired metadata after an exhausted probe without republishing the retained job', async () => {
    openChat('chat-1')
    const { job, operation, operations } = await usePartialProtocolOperation()
    h.fetchRuntimeJobs.mockResolvedValue({ status: 'error', error: 'bootstrap offline' })
    await maybeReattachOpenChatGeneration()
    expect(get(generationJobLifecycles)[job.jobId]?.status).toBe('exhausted-dead')

    operations.generationOperationProjections.set([withProtocolAttempt(operation)])
    triggerOpenChatGenerationReattach()
    await flushMicrotasks()

    expect(h.sendChat).toHaveBeenCalledOnce()
    expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()
    expect(get(generationJobLifecycles)[job.jobId]?.status).toBe('completed')
  })

  it('expires a held metadata probe without consuming its job or leaving retry work scheduled', async () => {
    vi.useFakeTimers()
    try {
      openChat('chat-1')
      const { job } = await usePartialProtocolOperation()
      h.fetchRuntimeJobs.mockImplementationOnce(() => new Promise(() => undefined))
      const attachment = maybeReattachOpenChatGeneration()
      await vi.advanceTimersByTimeAsync(10_000)
      await attachment

      expect(get(activeGenerationJobs)).toEqual([job])
      expect(get(generationJobLifecycles)[job.jobId]).toMatchObject({
        status: 'exhausted-dead',
        lastError: 'Generation authority refresh timed out.',
      })
      expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()
      expect(h.sendChat).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      triggerOpenChatGenerationReattach()
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()
    } finally {
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('does not resurrect missing metadata after database projection recovery is cleared', async () => {
    openChat('chat-1')
    const { job, operation } = await usePartialProtocolOperation()
    let settleProbe!: (value: unknown) => void
    h.fetchRuntimeJobs.mockImplementationOnce(() => new Promise((resolve) => (settleProbe = resolve)))

    const attachment = maybeReattachOpenChatGeneration()
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce())
    clearActiveGenerationJobProjection()
    settleProbe({
      status: 'ok',
      bootstrap: {
        generationOperationProjectionEpoch: 40,
        generationOperations: [withProtocolAttempt(operation)],
        activeGenerationJobs: [job],
      },
    })
    await attachment
    await flushMicrotasks()

    expect(authoritativeGenerationJobForChat(job.chatId)).toBeUndefined()
    expect(get(activeGenerationJobs)).toEqual([])
    expect(get(generationJobLifecycles)).toEqual({})
    expect(h.sendChat).not.toHaveBeenCalled()
    expect(h.applyGenerationOperationBootstrap).not.toHaveBeenCalled()
  })

  it('holds a selected durable job until chat readiness opens the reattach barrier', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-held' }])
    let ready = false
    setActiveGenerationReattachReadinessPredicate(() => ready)

    await maybeReattachOpenChatGeneration()
    expect(h.sendChat).not.toHaveBeenCalled()
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-1', jobId: 'job-held' }])

    ready = true
    await prepareOpenChatGenerationReattach()

    await vi.waitFor(() => {
      expect(h.sendChat).toHaveBeenCalledWith(-1, expect.objectContaining({ reattachJobId: 'job-held' }))
    })
  })

  it('deduplicates malformed same-chat protocol candidates by epoch, version, attempt, and job id', () => {
    const older = {
      chatId: 'chat-1',
      jobId: 'job-z',
      operationId: 'operation-a',
      projectionEpoch: 40,
      operationStateVersion: 8,
      attemptNo: 2,
    }
    const newer = {
      chatId: 'chat-1',
      jobId: 'job-a',
      operationId: 'operation-b',
      projectionEpoch: 41,
      operationStateVersion: 1,
      attemptNo: 1,
    }

    setActiveGenerationJobs([newer, older], { projectionEpoch: 41 })
    expect(get(activeGenerationJobs)).toEqual([newer])

    setActiveGenerationJobs([older, newer], { projectionEpoch: 41 })
    expect(get(activeGenerationJobs)).toEqual([newer])
  })

  it('reattaches protocol jobs through the exact operation attempt stream', async () => {
    openChat('chat-1')
    const job = {
      chatId: 'chat-1',
      jobId: 'job-protocol',
      operationId: 'operation-protocol',
      operationStateVersion: 5,
      projectionEpoch: 40,
      attemptNo: 2,
      acceptedMessageId: 'message-protocol',
    }
    setActiveGenerationJobs([job], { projectionEpoch: 40 })

    await maybeReattachOpenChatGeneration()

    expect(h.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        generationOperationStream: expect.objectContaining({
          operationId: 'operation-protocol',
          attemptNo: 2,
          jobId: 'job-protocol',
          projectionEpoch: 40,
        }),
      }),
    )
  })

  it('drops the pinned stale restoration and resolves reattach Stop to the newer same-chat authority', async () => {
    openChat('chat-1')
    const staleJob = {
      chatId: 'chat-1',
      jobId: 'job-a',
      operationId: 'operation-a',
      operationStateVersion: 3,
      projectionEpoch: 40,
      attemptNo: 1,
      acceptedMessageId: 'message-a',
    }
    const newerJob = {
      chatId: 'chat-1',
      jobId: 'job-b',
      operationId: 'operation-b',
      operationStateVersion: 1,
      projectionEpoch: 41,
      attemptNo: 1,
      acceptedMessageId: 'message-b',
    }
    setActiveGenerationJobs([staleJob], { projectionEpoch: 40 })
    let settleStale!: () => void
    h.sendChat.mockImplementationOnce(
      (_chatProcessIndex, args) =>
        new Promise<boolean>((resolve) => {
          settleStale = () => {
            args.onReattachOutcome?.({ status: 'retryable_transport_failure', error: 'stale observer failed' })
            resolve(false)
          }
        }),
    )

    const staleReattach = maybeReattachOpenChatGeneration()
    await vi.waitFor(() => expect(h.sendChat).toHaveBeenCalledTimes(1))
    expect(get(activeGenerationJobs)).toEqual([])

    setActiveGenerationJobs([newerJob], { projectionEpoch: 41 })
    settleStale()
    await staleReattach

    expect(get(activeGenerationJobs)).toEqual([newerJob])
    expect(get(generationJobLifecycles)['job-a']).toBeUndefined()

    await stopGenerationJob('job-a')
    expect(h.stopGenerationOperation).toHaveBeenCalledOnce()
    expect(h.stopGenerationOperation).toHaveBeenCalledWith('operation-b')
  })

  it('resolves stale Retry and Refresh controls to the newer same-chat attempt', async () => {
    openChat('chat-1')
    const staleJob = {
      chatId: 'chat-1',
      jobId: 'job-stale-control',
      operationId: 'operation-stale-control',
      operationStateVersion: 3,
      projectionEpoch: 40,
      attemptNo: 1,
    }
    const retryJob = {
      chatId: 'chat-1',
      jobId: 'job-retry-current',
      operationId: 'operation-retry-current',
      operationStateVersion: 4,
      projectionEpoch: 41,
      attemptNo: 2,
    }
    setActiveGenerationJobs([staleJob], { projectionEpoch: 40 })
    setActiveGenerationJobs([retryJob], { projectionEpoch: 41 })

    await retryGenerationJobReattach(staleJob.jobId)

    expect(h.sendChat).toHaveBeenLastCalledWith(
      -1,
      expect.objectContaining({
        generationOperationStream: expect.objectContaining({ jobId: retryJob.jobId, attemptNo: 2 }),
      }),
    )

    const refreshJob = {
      chatId: 'chat-1',
      jobId: 'job-refresh-current',
      operationId: 'operation-refresh-current',
      operationStateVersion: 5,
      projectionEpoch: 42,
      attemptNo: 3,
    }
    setActiveGenerationJobs([staleJob], { projectionEpoch: 41 })
    setActiveGenerationJobs([refreshJob], { projectionEpoch: 42 })
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: {
        generationOperationProjectionEpoch: 42,
        activeGenerationJobs: [refreshJob],
      },
    })

    await expect(refreshGenerationJobFromBootstrap(staleJob.jobId)).resolves.toEqual({ status: 'active' })
    expect(h.sendChat).toHaveBeenLastCalledWith(
      -1,
      expect.objectContaining({
        generationOperationStream: expect.objectContaining({ jobId: refreshJob.jobId, attemptNo: 3 }),
      }),
    )
  })

  it('retains and forgets a job learned from the live response', () => {
    setActiveGenerationJobs([
      { chatId: 'chat-1', jobId: 'job-old' },
      { chatId: 'chat-2', jobId: 'job-other' },
    ])

    rememberActiveGenerationJob({ chatId: 'chat-1', jobId: 'job-new', mode: 'send' })

    expect(get(activeGenerationJobs)).toEqual([
      { chatId: 'chat-1', jobId: 'job-new', mode: 'send' },
      { chatId: 'chat-2', jobId: 'job-other' },
    ])
    expect(get(generationJobLifecycles)['job-new']).toMatchObject({
      chatId: 'chat-1',
      jobId: 'job-new',
      status: 'attached',
      reattachAttempts: 0,
    })
    forgetActiveGenerationJob('job-new')
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-2', jobId: 'job-other' }])
  })

  it('reattaches the open chat and consumes the job', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-1' }])

    await maybeReattachOpenChatGeneration()

    expect(h.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        reattachJobId: 'job-1',
        expectedTarget: {
          selectedCharID: 0,
          chatPage: 0,
          characterId: 'char-a',
          chatId: 'chat-1',
        },
      }),
    )
    expect(get(activeGenerationJobs)).toEqual([])
  })

  // continue/regenerate are durable, so a reload can reattach to them; the mode
  // must ride the reattach so the replayed stream renders on the right row.
  it('reattaches a continue job with the continue flag', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-c', mode: 'continue' }])

    await maybeReattachOpenChatGeneration()

    expect(h.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        reattachJobId: 'job-c',
        continue: true,
        regenerateMessageId: undefined,
      }),
    )
  })

  it('reattaches a regenerate job with its target id', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-r', mode: 'regenerate', regenerateMessageId: 'msg-1' }])

    await maybeReattachOpenChatGeneration()

    expect(h.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        reattachJobId: 'job-r',
        continue: undefined,
        regenerateMessageId: 'msg-1',
      }),
    )
  })

  it('does nothing when no job matches the open chat', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-other', jobId: 'job-x' }])

    await maybeReattachOpenChatGeneration()

    expect(h.sendChat).not.toHaveBeenCalled()
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-other', jobId: 'job-x' }])
  })

  it('does not restore a consumed job after an unclassified exception', async () => {
    openChat('chat-1')
    const job = { chatId: 'chat-1', jobId: 'job-1', mode: 'continue' as const }
    setActiveGenerationJobs([job])
    h.sendChat.mockRejectedValueOnce(new Error('temporary network failure'))

    await maybeReattachOpenChatGeneration()

    expect(get(activeGenerationJobs)).toEqual([])
    expect(h.clearActiveGenerationAbortController).toHaveBeenCalledTimes(1)
  })

  it('restores a consumed job after a retryable transport failure', async () => {
    openChat('chat-1')
    const job = { chatId: 'chat-1', jobId: 'job-1', mode: 'continue' as const }
    setActiveGenerationJobs([job])
    reportReattachOutcome('retryable_transport_failure')

    await maybeReattachOpenChatGeneration()
    triggerOpenChatGenerationReattach()
    await flushMicrotasks()

    expect(get(activeGenerationJobs)).toEqual([job])
    expect(h.sendChat).toHaveBeenCalledTimes(1)
    expect(h.clearActiveGenerationAbortController).toHaveBeenCalledTimes(1)
  })

  it('consumes a job after a terminal SSE error without retrying after microtasks settle', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-terminal' }])
    reportReattachOutcome('terminal_failure')

    await maybeReattachOpenChatGeneration()
    triggerOpenChatGenerationReattach()
    await flushMicrotasks()

    expect(h.sendChat).toHaveBeenCalledTimes(1)
    expect(get(activeGenerationJobs)).toEqual([])
  })

  it('consumes an expired 404 job without retrying after microtasks settle', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-missing' }])
    reportReattachOutcome('missing_job')

    await maybeReattachOpenChatGeneration()
    triggerOpenChatGenerationReattach()
    await flushMicrotasks()

    expect(h.sendChat).toHaveBeenCalledTimes(1)
    expect(get(activeGenerationJobs)).toEqual([])
  })

  it('backs off and bounds retries for a repeatedly failing transport', async () => {
    vi.useFakeTimers()
    try {
      openChat('chat-1')
      const job = { chatId: 'chat-1', jobId: 'job-transport' }
      setActiveGenerationJobs([job])
      h.sendChat.mockImplementation(async (_chatProcessIndex, args) => {
        args.onReattachOutcome?.({ status: 'retryable_transport_failure', error: 'offline' })
        return false
      })

      await maybeReattachOpenChatGeneration()
      triggerOpenChatGenerationReattach()
      triggerOpenChatGenerationReattach()
      await flushMicrotasks()

      expect(h.sendChat).toHaveBeenCalledTimes(1)
      expect(get(activeGenerationJobs)).toEqual([job])
      expect(vi.getTimerCount()).toBe(1)
      expect(get(generationJobLifecycles)['job-transport']).toMatchObject({
        status: 'retrying',
        reattachAttempts: 1,
        lastError: 'offline',
      })

      for (let expectedAttempts = 2; expectedAttempts <= 4; expectedAttempts += 1) {
        await vi.advanceTimersToNextTimerAsync()
        await flushMicrotasks()
        expect(h.sendChat).toHaveBeenCalledTimes(expectedAttempts)
      }

      expect(vi.getTimerCount()).toBe(0)
      triggerOpenChatGenerationReattach()
      triggerOpenChatGenerationReattach()
      await flushMicrotasks()
      expect(h.sendChat).toHaveBeenCalledTimes(4)
      expect(get(activeGenerationJobs)).toEqual([job])
      expect(get(generationJobLifecycles)['job-transport']).toMatchObject({
        chatId: 'chat-1',
        jobId: 'job-transport',
        status: 'exhausted-dead',
        reattachAttempts: 4,
        lastError: 'offline',
      })
    } finally {
      setActiveGenerationJobs([])
      vi.useRealTimers()
    }
  })

  it('re-arms an exhausted exact attempt after a successful foreground authority probe', async () => {
    vi.useFakeTimers()
    try {
      openChat('chat-1')
      const job = {
        chatId: 'chat-1',
        jobId: 'job-rearmed',
        operationId: 'operation-rearmed',
        operationStateVersion: 5,
        projectionEpoch: 20,
        attemptNo: 2,
      }
      setActiveGenerationJobs([job], { projectionEpoch: 20 })
      h.sendChat.mockImplementation(async (_chatProcessIndex, args) => {
        args.onReattachOutcome?.({ status: 'retryable_transport_failure', error: 'offline' })
        return false
      })

      await maybeReattachOpenChatGeneration()
      for (let attempt = 2; attempt <= 4; attempt += 1) {
        await vi.advanceTimersToNextTimerAsync()
        await flushMicrotasks()
      }
      expect(get(generationJobLifecycles)[job.jobId]?.status).toBe('exhausted-dead')

      h.fetchRuntimeJobs.mockResolvedValueOnce({
        status: 'ok',
        bootstrap: {
          generationOperationProjectionEpoch: 20,
          activeGenerationJobs: [job],
        },
      })
      await refreshActiveGenerationJobsFromBootstrap(undefined, 'visibility')
      await maybeReattachOpenChatGeneration()

      expect(h.sendChat).toHaveBeenCalledTimes(5)
      expect(get(generationJobLifecycles)[job.jobId]).toMatchObject({
        status: 'retrying',
        reattachAttempts: 1,
        lastError: 'offline',
      })
    } finally {
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('manually retries only the exact exhausted job and records terminal completion', async () => {
    vi.useFakeTimers()
    try {
      openChat('chat-1')
      const exhaustedJob = { chatId: 'chat-1', jobId: 'job-exact' }
      const otherJob = { chatId: 'chat-2', jobId: 'job-other' }
      setActiveGenerationJobs([exhaustedJob, otherJob])
      h.sendChat.mockImplementation(async (_chatProcessIndex, args) => {
        args.onReattachOutcome?.({ status: 'retryable_transport_failure', error: 'offline' })
        return false
      })

      await maybeReattachOpenChatGeneration()
      for (let attempt = 2; attempt <= 4; attempt += 1) {
        await vi.advanceTimersToNextTimerAsync()
        await flushMicrotasks()
      }
      expect(get(generationJobLifecycles)['job-exact']?.status).toBe('exhausted-dead')

      reportReattachOutcome('completed')
      await retryGenerationJobReattach('job-exact')

      expect(h.sendChat).toHaveBeenLastCalledWith(-1, expect.objectContaining({ reattachJobId: 'job-exact' }))
      expect(get(activeGenerationJobs)).toEqual([otherJob])
      expect(get(generationJobLifecycles)['job-exact']).toMatchObject({
        status: 'completed',
        reattachAttempts: 0,
        lastError: 'offline',
      })
      expect(get(generationJobLifecycles)['job-other']?.status).toBe('retrying')
    } finally {
      resetGenerationJobLifecyclesForTests()
      setActiveGenerationJobs([])
      vi.useRealTimers()
    }
  })

  it('records the typed cancelled terminal separately from completion', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-cancelled' }])
    reportReattachOutcome('cancelled')

    await maybeReattachOpenChatGeneration()

    expect(get(activeGenerationJobs)).toEqual([])
    expect(get(generationJobLifecycles)['job-cancelled']?.status).toBe('cancelled')
  })

  it('reconciles bootstrap jobs into the public lifecycle after a reload', () => {
    resetGenerationJobLifecyclesForTests()

    setActiveGenerationJobs([{ chatId: 'chat-reload', jobId: 'job-reload', mode: 'continue' }])

    expect(get(generationJobLifecycles)['job-reload']).toMatchObject({
      chatId: 'chat-reload',
      jobId: 'job-reload',
      status: 'retrying',
      reattachAttempts: 0,
    })
  })

  it('refreshes the exact exhausted job, removes an absent authority job, and hydrates its chat', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([
      { chatId: 'chat-1', jobId: 'job-refresh' },
      { chatId: 'chat-2', jobId: 'job-other' },
    ])
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: { activeGenerationJobs: [{ chatId: 'chat-2', jobId: 'job-other' }] },
    })

    await expect(refreshGenerationJobFromBootstrap('job-refresh')).resolves.toEqual({ status: 'absent' })

    expect(h.fetchRuntimeJobs).toHaveBeenCalledWith(expect.any(AbortSignal), { cacheRevision: false })
    expect(h.hydrateChatMessages).toHaveBeenCalledWith('chat-1', {
      force: true,
      strict: true,
      signal: expect.any(AbortSignal),
    })
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-2', jobId: 'job-other' }])
    expect(get(generationJobLifecycles)['job-refresh']?.status).toBe('completed')
  })

  it('preserves the failed lifecycle when authoritative refresh itself fails', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-refresh-error' }])
    h.fetchRuntimeJobs.mockResolvedValueOnce({ status: 'error', error: 'bootstrap offline' })

    await expect(refreshGenerationJobFromBootstrap('job-refresh-error')).resolves.toEqual({
      status: 'error',
      error: 'bootstrap offline',
    })

    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-1', jobId: 'job-refresh-error' }])
    expect(get(generationJobLifecycles)['job-refresh-error']).toMatchObject({
      status: 'exhausted-dead',
      lastError: 'bootstrap offline',
    })
  })

  it('stops only the requested known job id', async () => {
    setActiveGenerationJobs([
      { chatId: 'chat-1', jobId: 'job-stop' },
      { chatId: 'chat-2', jobId: 'job-other' },
    ])

    await stopGenerationJob('job-stop')

    expect(h.cancelServerChatGeneration).toHaveBeenCalledTimes(1)
    expect(h.cancelServerChatGeneration).toHaveBeenCalledWith('job-stop')
  })

  it('stops a protocol-v1 job through its exact operation identity', async () => {
    setActiveGenerationJobs([
      { chatId: 'chat-1', jobId: 'job-stop', operationId: 'operation-stop' },
      { chatId: 'chat-2', jobId: 'job-other', operationId: 'operation-other' },
    ])

    await stopGenerationJob('job-stop')

    expect(h.stopGenerationOperation).toHaveBeenCalledOnce()
    expect(h.stopGenerationOperation).toHaveBeenCalledWith('operation-stop')
    expect(h.cancelServerChatGeneration).not.toHaveBeenCalled()
  })

  it('authoritatively clears and hydrates a stale known job during the generic bootstrap refresh', async () => {
    setActiveGenerationJobs([{ chatId: 'chat-stale', jobId: 'job-stale' }])
    h.fetchRuntimeJobs.mockResolvedValueOnce({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })

    await refreshActiveGenerationJobsFromBootstrap()

    expect(get(activeGenerationJobs)).toEqual([])
    expect(get(generationJobLifecycles)['job-stale']?.status).toBe('completed')
    expect(h.hydrateChatMessages).toHaveBeenCalledWith('chat-stale', {
      force: true,
      strict: true,
      signal: expect.any(AbortSignal),
    })
  })

  it('retries a terminal hydration invalidated by a newer transcript projection', async () => {
    setActiveGenerationJobs([{ chatId: 'chat-stale', jobId: 'job-stale' }])
    h.fetchRuntimeJobs.mockResolvedValueOnce({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })
    h.hydrateChatMessages.mockRejectedValueOnce(new Error('Chat hydration incomplete for: chat-stale'))

    await refreshActiveGenerationJobsFromBootstrap()

    expect(h.hydrateChatMessages).toHaveBeenCalledTimes(2)
    expect(get(activeGenerationJobs)).toEqual([])
    expect(get(generationJobLifecycles)['job-stale']?.status).toBe('completed')
  })

  it('retires a stale foreground observer before a terminal transcript hydration settles', async () => {
    openChat('chat-1')
    const job = {
      chatId: 'chat-1',
      jobId: 'job-hung-hydration',
      operationId: 'operation-hung-hydration',
    }
    setActiveGenerationJobs([job])
    const activity = beginChatGenerationActivity({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
      kind: 'message',
      operationId: job.operationId,
    })!
    let hydrationSignal: AbortSignal | null | undefined
    h.hydrateChatMessages.mockImplementationOnce(
      (_chatId, options) =>
        new Promise<void>((_resolve, reject) => {
          hydrationSignal = options?.signal
          hydrationSignal?.addEventListener('abort', () => reject(new Error('hydration aborted')), { once: true })
        }),
    )
    h.fetchRuntimeJobs.mockResolvedValueOnce({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })
    const controller = new AbortController()

    try {
      const refresh = refreshActiveGenerationJobsFromBootstrap(controller.signal, 'visibility')
      await vi.waitFor(() => expect(h.hydrateChatMessages).toHaveBeenCalledTimes(1))

      expect(h.retireGenerationJobViewers).toHaveBeenCalledWith(job.jobId, 17)
      expect(h.retireGenerationOperationViewers).toHaveBeenCalledWith(job.operationId, 29)
      expect(hydrationSignal).toBeInstanceOf(AbortSignal)
      expect(hydrationSignal?.aborted).toBe(false)

      controller.abort()
      await expect(refresh).resolves.toBeUndefined()
      expect(hydrationSignal?.aborted).toBe(true)
      await flushMicrotasks()
    } finally {
      finishChatGenerationActivity(activity.id)
    }
  })

  it('retries an absent-job transcript reconciliation after its first authority epoch times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      setActiveGenerationJobs([{ chatId: 'chat-stale', jobId: 'job-interrupted-hydration' }])
      h.fetchRuntimeJobs.mockResolvedValue({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })
      h.hydrateChatMessages.mockImplementationOnce(
        (_chatId, options) =>
          new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('hydration aborted')), { once: true })
          }),
      )
      startActiveGenerationReattach()

      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()
      expect(h.hydrateChatMessages).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10_000)
      await flushMicrotasks()
      expect(get(generationJobLifecycles)['job-interrupted-hydration']?.status).toBe('retrying')
      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(1)

      await vi.advanceTimersToNextTimerAsync()
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(2)
      expect(h.hydrateChatMessages).toHaveBeenCalledTimes(2)
      expect(get(generationJobLifecycles)['job-interrupted-hydration']?.status).toBe('completed')
    } finally {
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('retains an absent job when targeted replay holds the accepted authority epoch until timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      setActiveGenerationJobs([{ chatId: 'chat-stale', jobId: 'job-before-replay-timeout' }])
      h.fetchRuntimeJobs.mockResolvedValue({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })
      h.replayGenerationRecoveryObligations.mockReturnValueOnce(new Promise<boolean>(() => {}))

      const firstRefresh = refreshActiveGenerationJobsFromBootstrap()
      await vi.waitFor(() => expect(h.replayGenerationRecoveryObligations).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(10_000)
      await firstRefresh

      expect(h.hydrateChatMessages).not.toHaveBeenCalled()

      await refreshActiveGenerationJobsFromBootstrap()

      expect(h.hydrateChatMessages).toHaveBeenCalledWith('chat-stale', {
        force: true,
        strict: true,
        signal: expect.any(AbortSignal),
      })
      expect(get(generationJobLifecycles)['job-before-replay-timeout']?.status).toBe('completed')
    } finally {
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('settles absent jobs independently when only one transcript hydration fails', async () => {
    setActiveGenerationJobs([
      { chatId: 'chat-complete', jobId: 'job-complete' },
      { chatId: 'chat-failed', jobId: 'job-failed' },
    ])
    h.fetchRuntimeJobs.mockResolvedValue({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })
    h.hydrateChatMessages
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('chat-failed first hydration failed'))
      .mockRejectedValueOnce(new Error('chat-failed replacement hydration failed'))

    await refreshActiveGenerationJobsFromBootstrap()

    expect(h.hydrateChatMessages.mock.calls.map(([chatId]) => chatId)).toEqual([
      'chat-complete',
      'chat-failed',
      'chat-failed',
    ])
    expect(get(generationJobLifecycles)['job-complete']?.status).toBe('completed')
    expect(get(generationJobLifecycles)['job-failed']).toMatchObject({
      status: 'exhausted-dead',
      lastError: 'The generation finished, but its transcript could not be refreshed.',
    })
  })

  it('retries a failed absent-job hydration after accepted authority and stops once hydrated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      setActiveGenerationJobs([{ chatId: 'chat-stale', jobId: 'job-needs-hydration' }])
      startActiveGenerationReattach()
      h.fetchRuntimeJobs.mockResolvedValue({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })
      h.hydrateChatMessages
        .mockRejectedValueOnce(new Error('first strict hydration failed'))
        .mockRejectedValueOnce(new Error('replacement strict hydration failed'))
        .mockResolvedValueOnce(undefined)

      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()

      expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()
      expect(h.hydrateChatMessages).toHaveBeenCalledTimes(2)
      expect(get(generationJobLifecycles)['job-needs-hydration']?.status).toBe('exhausted-dead')

      await vi.advanceTimersByTimeAsync(500)
      await flushMicrotasks()

      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(2)
      expect(h.hydrateChatMessages).toHaveBeenCalledTimes(3)
      expect(get(generationJobLifecycles)['job-needs-hydration']?.status).toBe('completed')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('does not restore or retry a consumed job after abort while reattach is pending', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-1' }])
    let settleReattach!: (attached: boolean) => void
    h.sendChat.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleReattach = resolve
        }),
    )

    const pending = maybeReattachOpenChatGeneration()
    await vi.waitFor(() => expect(h.sendChat).toHaveBeenCalledTimes(1))

    h.createActiveGenerationAbortController.mock.results.at(-1)?.value.abort()
    settleReattach(false)
    await pending
    triggerOpenChatGenerationReattach()
    await flushMicrotasks()

    expect(h.sendChat).toHaveBeenCalledTimes(1)
    expect(get(activeGenerationJobs)).toEqual([])
    expect(h.clearActiveGenerationAbortController).toHaveBeenCalledTimes(1)
  })

  it('keeps the job while the same chat already has a client generation activity', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-1' }])
    const activity = beginChatGenerationActivity({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
      kind: 'message',
    })!

    await maybeReattachOpenChatGeneration()

    expect(h.sendChat).not.toHaveBeenCalled()
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-1', jobId: 'job-1' }])

    finishChatGenerationActivity(activity.id)
    await maybeReattachOpenChatGeneration()
    expect(h.sendChat).toHaveBeenCalledWith(-1, expect.objectContaining({ reattachJobId: 'job-1' }))
  })

  it('does nothing when no chat is open', async () => {
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-1' }])

    await maybeReattachOpenChatGeneration()

    expect(h.sendChat).not.toHaveBeenCalled()
  })

  it('does not start the previous chat job after the active chat switches during runtime loading', async () => {
    h.database = {
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            { id: 'chat-1', message: [] },
            { id: 'chat-2', message: [] },
          ],
        },
      ],
    }
    h.selectedCharID.set(0)
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-1' }])

    const reattach = maybeReattachOpenChatGeneration()
    ;(h.database.characters as Array<{ chatPage: number }>)[0].chatPage = 1
    await reattach

    expect(h.sendChat).not.toHaveBeenCalled()
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-1', jobId: 'job-1' }])
  })

  it('keeps concurrent reattach controllers isolated when Chat A is aborted', async () => {
    const pendingCalls = new Map<
      string,
      {
        signal: AbortSignal
        settle: (attached: boolean) => void
      }
    >()
    h.sendChat.mockImplementation(
      (_chatProcessIndex, args) =>
        new Promise<boolean>((resolve) => {
          pendingCalls.set(args.reattachJobId ?? '', {
            signal: args.signal!,
            settle: resolve,
          })
        }),
    )
    h.database = {
      characters: [
        { chaId: 'char-a', chatPage: 0, chats: [{ id: 'chat-a', message: [] }] },
        { chaId: 'char-b', chatPage: 0, chats: [{ id: 'chat-b', message: [] }] },
      ],
    }
    h.selectedCharID.set(0)
    setActiveGenerationJobs([
      { chatId: 'chat-a', jobId: 'job-a' },
      { chatId: 'chat-b', jobId: 'job-b' },
    ])

    const pendingA = maybeReattachOpenChatGeneration()
    await vi.waitFor(() => expect(pendingCalls.has('job-a')).toBe(true))
    h.selectedCharID.set(1)
    const pendingB = maybeReattachOpenChatGeneration()
    await vi.waitFor(() => expect(pendingCalls.has('job-b')).toBe(true))

    h.createActiveGenerationAbortController.mock.results[0]?.value.abort()

    expect(pendingCalls.get('job-a')?.signal.aborted).toBe(true)
    expect(pendingCalls.get('job-b')?.signal.aborted).toBe(false)
    pendingCalls.get('job-a')?.settle(false)
    pendingCalls.get('job-b')?.settle(true)
    await Promise.all([pendingA, pendingB])

    expect(h.sendChat).toHaveBeenCalledTimes(2)
    expect(get(activeGenerationJobs)).toEqual([])
    expect(h.clearActiveGenerationAbortController).toHaveBeenCalledTimes(2)
  })

  it('reattaches after a queued trigger observes a same-character chat switch', async () => {
    h.database = {
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            { id: 'chat-1', message: [] },
            { id: 'chat-2', message: [] },
          ],
        },
      ],
    }
    h.selectedCharID.set(0)
    setActiveGenerationJobs([{ chatId: 'chat-2', jobId: 'job-2' }])
    ;(h.database.characters as Array<{ chatPage: number }>)[0].chatPage = 1

    triggerOpenChatGenerationReattach()

    await vi.waitFor(() => {
      expect(h.sendChat).toHaveBeenCalledWith(
        -1,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          reattachJobId: 'job-2',
        }),
      )
    })
    expect(get(activeGenerationJobs)).toEqual([])
  })

  it('does not reattach a terminal job again when generation activity settles', async () => {
    openChat('chat-1')
    setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-terminal' }])
    startActiveGenerationReattach()
    h.sendChat.mockImplementationOnce(async (_chatProcessIndex, args) => {
      const activity = beginChatGenerationActivity({
        target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
        kind: 'message',
      })!
      args.onReattachOutcome?.({ status: 'terminal_failure', error: 'terminal SSE error' })
      finishChatGenerationActivity(activity.id)
      return false
    })

    await maybeReattachOpenChatGeneration()
    await flushMicrotasks()

    expect(h.sendChat).toHaveBeenCalledTimes(1)
    expect(get(activeGenerationJobs)).toEqual([])
  })

  it('probes a pre-job-id operation when the browser network returns', async () => {
    openChat('chat-1')
    startActiveGenerationReattach()
    setPendingGenerationOperation('operation-online')
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: { activeGenerationJobs: [{ chatId: 'chat-1', jobId: 'job-online' }] },
    })

    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => {
      expect(h.fetchRuntimeJobs).toHaveBeenCalledWith(expect.any(AbortSignal), { cacheRevision: false })
      expect(h.sendChat).toHaveBeenCalledWith(-1, expect.objectContaining({ reattachJobId: 'job-online' }))
    })
  })

  it('probes a known job after suspension even when its chat is not open', async () => {
    setActiveGenerationJobs([{ chatId: 'chat-background', jobId: 'job-retained' }])
    startActiveGenerationReattach()
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: { activeGenerationJobs: [{ chatId: 'chat-background', jobId: 'job-retained' }] },
    })

    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce())
    expect(h.sendChat).not.toHaveBeenCalled()
  })

  it('keeps probing a compatibility request whose job identity remains ambiguous', async () => {
    startActiveGenerationReattach()
    retainUnresolvedGenerationAuthority('chat-unknown')
    h.fetchRuntimeJobs.mockResolvedValue({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })

    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce())
    expect(hasUnresolvedGenerationAuthorityForTests('chat-unknown')).toBe(true)

    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(2))
    expect(hasUnresolvedGenerationAuthorityForTests('chat-unknown')).toBe(true)
  })

  it('keeps a bounded retry after an accepted bootstrap leaves an obligation unresolved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      startActiveGenerationReattach()
      retainUnresolvedGenerationAuthority('chat-still-unknown')
      h.fetchRuntimeJobs.mockResolvedValue({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })

      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(500)
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(2)
      expect(hasUnresolvedGenerationAuthorityForTests('chat-still-unknown')).toBe(true)
    } finally {
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('strictly hydrates terminal operation recovery even when no job was ever observed', async () => {
    retainUnresolvedGenerationAuthority('chat-terminal', 'operation-terminal')
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: {
        generationOperationProjectionEpoch: 7,
        activeGenerationJobs: [],
        generationOperations: [
          {
            operationId: 'operation-terminal',
            protocolVersion: 1,
            requestOrigin: 'accepted_send',
            state: 'completed',
            stateVersion: 5,
            projectionEpoch: 7,
            creatorWriterSessionId: 'writer-a',
            creatorWriterEpoch: 1,
            characterId: 'char-a',
            chatId: 'chat-terminal',
            mode: 'send',
            providerMayHaveRun: true,
          },
        ],
      },
    })

    await refreshActiveGenerationJobsFromBootstrap()

    expect(h.hydrateChatMessages).toHaveBeenCalledWith('chat-terminal', {
      force: true,
      strict: true,
      signal: expect.any(AbortSignal),
    })
    expect(hasUnresolvedGenerationAuthorityForTests('chat-terminal')).toBe(false)
  })

  it('does not clear unresolved authority added after an older bootstrap request starts', async () => {
    let resolveBootstrap!: (value: { status: 'ok'; bootstrap: { activeGenerationJobs: never[] } }) => void
    h.fetchRuntimeJobs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBootstrap = resolve
      }),
    )
    const refresh = refreshActiveGenerationJobsFromBootstrap()
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce())

    retainUnresolvedGenerationAuthority('chat-newer-request')
    resolveBootstrap({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })
    await refresh

    expect(hasUnresolvedGenerationAuthorityForTests('chat-newer-request')).toBe(true)
  })

  it('does not clear unresolved authority when a stale bootstrap projection is rejected', async () => {
    retainUnresolvedGenerationAuthority('chat-stale-bootstrap')
    h.applyGenerationOperationBootstrap.mockReturnValueOnce(false)
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: { generationOperationProjectionEpoch: 1, activeGenerationJobs: [] },
    })

    await refreshActiveGenerationJobsFromBootstrap()

    expect(hasUnresolvedGenerationAuthorityForTests('chat-stale-bootstrap')).toBe(true)
  })

  it('honors a suspension recovery already requested before its message activity settles', async () => {
    openChat('chat-1')
    startActiveGenerationReattach()
    const activity = beginChatGenerationActivity({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
      kind: 'message',
    })!

    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    finishChatGenerationActivity(activity.id)
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce())
  })

  it('does not refresh generation authority after suspension without recovery interest', async () => {
    startActiveGenerationReattach()
    h.fetchRuntimeJobs.mockClear()

    window.dispatchEvent(new Event('online'))
    await flushMicrotasks()

    expect(h.fetchRuntimeJobs).not.toHaveBeenCalled()
  })

  it('does not poll settled or user-action generation operation states after suspension', async () => {
    startActiveGenerationReattach()
    const stableStates: GenerationOperationProjection['state'][] = ['cancel_requested', 'retryable', 'abandoned']

    for (const state of stableStates) {
      setPendingGenerationOperation(`operation-${state}`, 'chat-1', state)
      window.dispatchEvent(new Event('online'))
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs, `state ${state} should not trigger an authority read`).not.toHaveBeenCalled()
    }
  })

  it('retries a failed foreground authority probe while a durable observer remains hung', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const job = {
      chatId: 'chat-1',
      jobId: 'job-foreground-retry',
      operationId: 'operation-foreground-retry',
    }
    let activity: ReturnType<typeof beginChatGenerationActivity> = null
    try {
      openChat('chat-1')
      startActiveGenerationReattach()
      setActiveGenerationJobs([job])
      activity = beginChatGenerationActivity({
        target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
        kind: 'message',
        operationId: job.operationId,
      })
      h.fetchRuntimeJobs
        .mockResolvedValueOnce({ status: 'error', error: 'bootstrap offline' })
        .mockResolvedValueOnce({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })

      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()

      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(1)
      expect(h.retireGenerationJobViewers).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersToNextTimerAsync()
      await flushMicrotasks()

      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(2)
      expect(h.hydrateChatMessages).toHaveBeenCalledWith('chat-1', {
        force: true,
        strict: true,
        signal: expect.any(AbortSignal),
      })
      expect(h.retireGenerationJobViewers).toHaveBeenCalledWith(job.jobId, 17)
      expect(h.retireGenerationOperationViewers).toHaveBeenCalledWith(job.operationId, 29)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      if (activity) finishChatGenerationActivity(activity.id)
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('bounds foreground authority retries for a persistently unavailable bootstrap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let activity: ReturnType<typeof beginChatGenerationActivity> = null
    try {
      openChat('chat-1')
      startActiveGenerationReattach()
      setActiveGenerationJobs([{ chatId: 'chat-1', jobId: 'job-bounded-foreground-retry' }])
      activity = beginChatGenerationActivity({
        target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
        kind: 'message',
      })
      h.fetchRuntimeJobs.mockResolvedValue({ status: 'error', error: 'bootstrap offline' })

      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(1)

      for (let expectedCalls = 2; expectedCalls <= 4; expectedCalls += 1) {
        await vi.advanceTimersToNextTimerAsync()
        await flushMicrotasks()
        expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(expectedCalls)
      }

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      if (activity) finishChatGenerationActivity(activity.id)
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('does not let unrelated later work adopt an older lifecycle retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let laterActivity: ReturnType<typeof beginChatGenerationActivity> = null
    try {
      setActiveGenerationJobs([{ chatId: 'chat-original', jobId: 'job-original' }])
      startActiveGenerationReattach()
      h.fetchRuntimeJobs.mockResolvedValue({ status: 'error', error: 'bootstrap offline' })

      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()
      expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()

      forgetActiveGenerationJob('job-original')
      laterActivity = beginChatGenerationActivity({
        target: { selectedCharID: 0, chatPage: 0, characterId: 'char-later', chatId: 'chat-later' },
        kind: 'message',
      })
      await vi.advanceTimersToNextTimerAsync()
      await flushMicrotasks()

      expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce()
    } finally {
      if (laterActivity) finishChatGenerationActivity(laterActivity.id)
      resetGenerationJobLifecyclesForTests()
      vi.useRealTimers()
    }
  })

  it('advances the known command revision after the recovery projection is accepted', async () => {
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: { revision: 15_017, activeGenerationJobs: [] },
    })
    h.applyGenerationOperationBootstrap.mockImplementationOnce(() => {
      expect(h.setCachedServerCommandRevision).not.toHaveBeenCalled()
      return true
    })

    await refreshActiveGenerationJobsFromBootstrap()

    expect(h.setCachedServerCommandRevision).toHaveBeenCalledTimes(1)
  })

  it('routes suspension-backed wakeups through the shared bootstrap reconciler and ignores ordinary focus', async () => {
    openChat('chat-1')
    startActiveGenerationReattach()
    const activity = beginChatGenerationActivity({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
      kind: 'message',
    })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    const wakeups: Array<{
      source: 'online' | 'pageshow' | 'focus' | 'visibility'
      dispatch: () => void
    }> = [
      { source: 'online', dispatch: () => window.dispatchEvent(new Event('online')) },
      {
        source: 'pageshow',
        dispatch: () => {
          const event = new PageTransitionEvent('pageshow')
          Object.defineProperty(event, 'persisted', { value: true })
          window.dispatchEvent(event)
        },
      },
      {
        source: 'focus',
        dispatch: () => {
          window.dispatchEvent(new Event('pagehide'))
          window.dispatchEvent(new Event('focus'))
        },
      },
      {
        source: 'visibility',
        dispatch: () => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
          document.dispatchEvent(new Event('visibilitychange'))
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
          document.dispatchEvent(new Event('visibilitychange'))
        },
      },
    ]
    for (const [index, wakeup] of wakeups.entries()) {
      wakeup.dispatch()
      await vi.waitFor(() => expect(h.applyGenerationOperationBootstrap).toHaveBeenCalledTimes(index + 1))
      await flushMicrotasks()
    }

    expect(h.applyGenerationOperationBootstrap.mock.calls.map((call) => call[1])).toEqual(
      wakeups.map(({ source }) => source),
    )

    window.dispatchEvent(new Event('focus'))
    await flushMicrotasks()
    expect(h.applyGenerationOperationBootstrap).toHaveBeenCalledTimes(wakeups.length)
    if (activity) finishChatGenerationActivity(activity.id)
  })

  it('settles and releases a never-ending bootstrap refresh when its authority signal aborts', async () => {
    const controller = new AbortController()
    h.fetchRuntimeJobs.mockReturnValueOnce(new Promise(() => {}))

    const refresh = refreshActiveGenerationJobsFromBootstrap(controller.signal)
    await vi.waitFor(() => {
      expect(h.fetchRuntimeJobs).toHaveBeenCalledWith(expect.any(AbortSignal), { cacheRevision: false })
    })

    controller.abort()
    await expect(refresh).resolves.toBeUndefined()

    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: { activeGenerationJobs: [] },
    })
    await expect(refreshActiveGenerationJobsFromBootstrap()).resolves.toBeUndefined()
    expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(2)
  })

  it('supersedes a never-ending lifecycle bootstrap with a newer foreground epoch', async () => {
    startActiveGenerationReattach()
    setPendingGenerationOperation('operation-superseded')
    h.fetchRuntimeJobs.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({
      status: 'ok',
      bootstrap: { revision: 22, activeGenerationJobs: [] },
    })

    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(1))

    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pageshow'))
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(h.setCachedServerCommandRevision).toHaveBeenCalledWith(22))
    expect(h.setCachedServerCommandRevision).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(h.applyGenerationOperationBootstrap).toHaveBeenCalledWith(expect.anything(), 'pageshow'),
    )
  })

  it('retires a preserved same-chat viewer after foreground authority succeeds', async () => {
    openChat('chat-1')
    const job = {
      chatId: 'chat-1',
      jobId: 'job-preserved-viewer',
      operationId: 'operation-preserved-viewer',
      operationStateVersion: 4,
      projectionEpoch: 12,
      attemptNo: 1,
    }
    setActiveGenerationJobs([job], { projectionEpoch: 12 })
    const activity = beginChatGenerationActivity({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
      kind: 'message',
      operationId: job.operationId,
    })!
    h.fetchRuntimeJobs.mockResolvedValueOnce({
      status: 'ok',
      bootstrap: {
        generationOperationProjectionEpoch: 12,
        activeGenerationJobs: [job],
      },
    })

    await refreshActiveGenerationJobsFromBootstrap(undefined, 'visibility')

    expect(h.retireGenerationJobViewers).toHaveBeenCalledWith(job.jobId, 17)
    expect(h.retireGenerationOperationViewers).toHaveBeenCalledWith(job.operationId, 29)
    finishChatGenerationActivity(activity.id)
    await maybeReattachOpenChatGeneration()
    expect(h.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({ generationOperationStream: expect.objectContaining({ jobId: job.jobId }) }),
    )
  })

  it.each([false, true])(
    'preserves a live background viewer when switching during recovery is %s',
    async (switchDuringRecovery) => {
      openChat(switchDuringRecovery ? 'chat-1' : 'chat-2')
      const job = {
        chatId: 'chat-1',
        jobId: 'job-background',
        operationId: 'operation-background',
        operationStateVersion: 4,
        projectionEpoch: 12,
        attemptNo: 1,
      }
      setActiveGenerationJobs([job], { projectionEpoch: 12 })
      const activity = beginChatGenerationActivity({
        target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: job.chatId },
        kind: 'message',
        operationId: job.operationId,
      })!
      let release!: () => void
      h.fetchRuntimeJobs.mockReturnValueOnce(
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 'ok',
              bootstrap: {
                generationOperationProjectionEpoch: 12,
                activeGenerationJobs: [job],
              },
            })
        }),
      )
      try {
        const refresh = refreshActiveGenerationJobsFromBootstrap(undefined, 'focus')
        await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce())
        if (switchDuringRecovery) openChat('chat-2')
        release()
        await refresh
        await maybeReattachOpenChatGeneration()
        expect(h.retireGenerationJobViewers).not.toHaveBeenCalled()
        expect(h.retireGenerationOperationViewers).not.toHaveBeenCalled()
        expect(h.sendChat).not.toHaveBeenCalled()
      } finally {
        finishChatGenerationActivity(activity.id)
      }
    },
  )

  it('retires an absent background viewer and hydrates its terminal transcript', async () => {
    openChat('chat-2')
    const job = { chatId: 'chat-1', jobId: 'job-background-terminal', operationId: 'operation-background-terminal' }
    setActiveGenerationJobs([job])
    const activity = beginChatGenerationActivity({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: job.chatId },
      kind: 'message',
      operationId: job.operationId,
    })!
    h.fetchRuntimeJobs.mockResolvedValueOnce({ status: 'ok', bootstrap: { activeGenerationJobs: [] } })
    try {
      await refreshActiveGenerationJobsFromBootstrap(undefined, 'focus')
      expect(h.retireGenerationJobViewers).toHaveBeenCalledWith(job.jobId, 17)
      expect(h.retireGenerationOperationViewers).toHaveBeenCalledWith(job.operationId, 29)
      expect(h.hydrateChatMessages).toHaveBeenCalledWith(
        job.chatId,
        expect.objectContaining({ force: true, strict: true }),
      )
    } finally {
      finishChatGenerationActivity(activity.id)
    }
  })

  it('does not retire a newer same-chat observer that starts while recovery is in flight', async () => {
    openChat('chat-1')
    const oldJob = {
      chatId: 'chat-1',
      jobId: 'job-old-observer',
      operationId: 'operation-old-observer',
      operationStateVersion: 3,
      projectionEpoch: 20,
      attemptNo: 1,
    }
    const newJob = {
      chatId: 'chat-1',
      jobId: 'job-new-observer',
      operationId: 'operation-new-observer',
      operationStateVersion: 1,
      projectionEpoch: 21,
      attemptNo: 1,
    }
    setActiveGenerationJobs([oldJob], { projectionEpoch: 20 })
    const oldActivity = beginChatGenerationActivity({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
      kind: 'message',
      operationId: oldJob.operationId,
      attemptNo: oldJob.attemptNo,
      projectionEpoch: oldJob.projectionEpoch,
    })!
    let resolveBootstrap!: (value: {
      status: 'ok'
      bootstrap: { generationOperationProjectionEpoch: number; activeGenerationJobs: Array<typeof newJob> }
    }) => void
    h.fetchRuntimeJobs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBootstrap = resolve
      }),
    )

    const refresh = refreshActiveGenerationJobsFromBootstrap(undefined, 'visibility')
    await vi.waitFor(() => expect(h.fetchRuntimeJobs).toHaveBeenCalledOnce())
    finishChatGenerationActivity(oldActivity.id)
    setActiveGenerationJobs([newJob], { projectionEpoch: 21 })
    const newActivity = beginChatGenerationActivity({
      target: { selectedCharID: 0, chatPage: 0, characterId: 'char-a', chatId: 'chat-1' },
      kind: 'message',
      operationId: newJob.operationId,
      attemptNo: newJob.attemptNo,
      projectionEpoch: newJob.projectionEpoch,
    })!
    resolveBootstrap({
      status: 'ok',
      bootstrap: { generationOperationProjectionEpoch: 21, activeGenerationJobs: [newJob] },
    })

    await refresh

    expect(h.retireGenerationJobViewers).not.toHaveBeenCalled()
    expect(h.retireGenerationOperationViewers).not.toHaveBeenCalled()
    finishChatGenerationActivity(newActivity.id)
  })

  it('stops lifecycle probes from reconnecting to the server', async () => {
    openChat('chat-1')
    startActiveGenerationReattach()
    stopActiveGenerationReattach()
    h.fetchRuntimeJobs.mockClear()

    window.dispatchEvent(new Event('online'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(h.fetchRuntimeJobs).not.toHaveBeenCalled()
    expect(h.sendChat).not.toHaveBeenCalled()
  })
})
