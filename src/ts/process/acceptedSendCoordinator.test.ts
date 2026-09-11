import { captureClientSessionGeneration, resetClientSessionForTests } from '../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveChatTarget, ChatMutationFinalOutcome } from '../chatCommands'

const coordinatorMocks = vi.hoisted(() => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  clearController: vi.fn(),
  controller: new AbortController(),
  createController: vi.fn(),
  reconcileAcceptedSendCompletion: vi.fn(),
  reconcileAcceptedSendGenerationEffects: vi.fn(),
  refreshActiveGenerationJobsFromBootstrap: vi.fn(),
  readGenerationOperationStatus: vi.fn(),
  retryGenerationOperation: vi.fn(),
  sendChat: vi.fn(),
  sleep: vi.fn(),
  stageAcceptedSendGenerationOperation: vi.fn(),
  stopGenerationOperation: vi.fn(),
  submitStagedAcceptedSendOperation: vi.fn(),
  waitForPendingCharacterScriptDefinitionSave: vi.fn(),
}))

vi.mock('../chatCommands', () => ({
  waitForPendingChatGenerationSettingsSave: vi.fn(async () => undefined),
}))

vi.mock('../activeChatGenerationSettings', () => ({
  guardActiveChatGenerationSettingsForSend: vi.fn((state) => ({ status: 'ok', state })),
  resolveActiveChatGenerationSettings: vi.fn(() => ({
    chat: { id: 'chat-a', message: [] },
  })),
}))

vi.mock('../persona', () => ({ flushPendingSelectedPersonaUpdate: vi.fn(async () => undefined) }))
vi.mock('../server/scriptDefinitionOwner.svelte', () => ({
  waitForPendingCharacterScriptDefinitionSave: coordinatorMocks.waitForPendingCharacterScriptDefinitionSave,
}))
vi.mock('../alert', () => ({ alertConfirm: coordinatorMocks.alertConfirm, alertError: coordinatorMocks.alertError }))
vi.mock('../../lang', () => ({
  language: {
    acceptedSendRecovery: { providerMayHaveRunConfirm: 'confirm retry' },
    errors: { replyStillSaving: 'reply still saving' },
  },
}))
vi.mock('./serverBackedSendChat', () => ({ collectServerInlayAssetRefs: vi.fn(async () => []) }))
vi.mock('./request/clientContext', () => ({ readBrowserClientContext: vi.fn(() => ({})) }))
vi.mock('./request/serverChat', () => ({ SERVER_CHAT_CLIENT_CAPABILITIES: {} }))
vi.mock('../server/generationOperations', () => ({
  readGenerationOperationStatus: coordinatorMocks.readGenerationOperationStatus,
  retryGenerationOperation: coordinatorMocks.retryGenerationOperation,
  stageAcceptedSendGenerationOperation: coordinatorMocks.stageAcceptedSendGenerationOperation,
  stopGenerationOperation: coordinatorMocks.stopGenerationOperation,
  submitStagedAcceptedSendOperation: coordinatorMocks.submitStagedAcceptedSendOperation,
}))

vi.mock('../util', () => ({
  sleep: coordinatorMocks.sleep,
}))

vi.mock('./index.svelte', () => ({
  clearActiveGenerationAbortController: coordinatorMocks.clearController,
  createActiveGenerationAbortController: coordinatorMocks.createController,
  sendChat: coordinatorMocks.sendChat,
}))

vi.mock('./reattach', () => ({
  refreshActiveGenerationJobsFromBootstrap: coordinatorMocks.refreshActiveGenerationJobsFromBootstrap,
}))

vi.mock('../server/chatMessageHydration.svelte', () => ({
  reconcileAcceptedSendCompletion: coordinatorMocks.reconcileAcceptedSendCompletion,
}))

vi.mock('./recoveredGenerationEffects', () => ({
  reconcileAcceptedSendGenerationEffects: coordinatorMocks.reconcileAcceptedSendGenerationEffects,
}))

import {
  ACCEPTED_SEND_AUTHORITY_PROBE_TIMEOUT_MS,
  acceptedSendRecoveries,
  coordinateAcceptedChatSend,
  dismissAbandonedAcceptedChatSend,
  resetAcceptedSendCoordinatorForTests,
  retryAcceptedChatSend,
} from './acceptedSendCoordinator.svelte'
import { applyAcceptedSendOperationProjection } from './acceptedSendRecoveryState'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function target(): ActiveChatTarget {
  return {
    selectedCharID: 0,
    chatPage: 0,
    characterId: 'character-a',
    chatId: 'chat-a',
  }
}

function projectAbandonedAcceptedSend(): void {
  applyAcceptedSendOperationProjection({
    operationId: 'operation-abandoned',
    protocolVersion: 1,
    requestOrigin: 'accepted_send',
    state: 'abandoned',
    stateVersion: 4,
    projectionEpoch: 4,
    creatorWriterSessionId: 'writer-a',
    creatorWriterEpoch: 1,
    characterId: 'character-a',
    chatId: 'chat-a',
    mode: 'send',
    acceptedMessageId: 'message-a',
    acceptedRevision: 2,
    resultMessageId: 'reply-a',
    providerMayHaveRun: true,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:01.000Z',
  })
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.clearAllMocks()
  coordinatorMocks.controller = new AbortController()
  coordinatorMocks.createController.mockReturnValue(coordinatorMocks.controller)
  coordinatorMocks.sendChat.mockResolvedValue(true)
  coordinatorMocks.alertConfirm.mockResolvedValue(true)
  coordinatorMocks.reconcileAcceptedSendCompletion.mockResolvedValue({
    status: 'not_reconciled',
    reason: 'authority_unavailable',
  })
  coordinatorMocks.reconcileAcceptedSendGenerationEffects.mockResolvedValue({ durableEffectsReconciled: true })
  coordinatorMocks.refreshActiveGenerationJobsFromBootstrap.mockResolvedValue(undefined)
  coordinatorMocks.sleep.mockResolvedValue(undefined)
  coordinatorMocks.waitForPendingCharacterScriptDefinitionSave.mockResolvedValue('idle')
  resetAcceptedSendCoordinatorForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

describe('accepted send coordinator', () => {
  it('does not stage generation while a character script save is still queued', async () => {
    coordinatorMocks.waitForPendingCharacterScriptDefinitionSave.mockResolvedValueOnce('queued')
    const onAppendFailed = vi.fn()

    await expect(
      coordinateAcceptedChatSend({
        target: target(),
        message: { role: 'user', data: 'use the latest character regex' },
        onAppendFailed,
      }),
    ).resolves.toEqual({ status: 'append_failed' })

    expect(coordinatorMocks.waitForPendingCharacterScriptDefinitionSave).toHaveBeenCalledWith('character-a')
    expect(coordinatorMocks.stageAcceptedSendGenerationOperation).not.toHaveBeenCalled()
    expect(onAppendFailed).toHaveBeenCalledWith({
      kind: 'known',
      reason: 'characterDefinitions',
    })
  })

  it('shows a typed notice when a prior reply finalization still fences the chat', async () => {
    const staged = {
      request: { acceptedMessageId: 'message-blocked' },
      target: target(),
      intent: {},
      handle: {},
      optimisticMessage: {},
      rollbackOptimisticAppend: vi.fn(),
    }
    coordinatorMocks.stageAcceptedSendGenerationOperation.mockResolvedValueOnce(staged)
    coordinatorMocks.submitStagedAcceptedSendOperation.mockResolvedValueOnce({
      status: 'rejected',
      code: 'generation_finalization_pending',
      error: 'generation_finalization_pending',
    })
    const onAppendFailed = vi.fn()

    await expect(
      coordinateAcceptedChatSend({
        target: target(),
        message: { role: 'user', data: 'wait for the prior reply' },
        onAppendFailed,
      }),
    ).resolves.toEqual({ status: 'append_failed' })
    expect(coordinatorMocks.alertError).toHaveBeenCalledWith('reply still saving')
    expect(onAppendFailed).not.toHaveBeenCalled()
  })

  it('submits a standard accepted send atomically and reconciles exact completion lineage', async () => {
    const staged = {
      request: { acceptedMessageId: 'message-atomic' },
      target: target(),
      intent: {},
      handle: {},
      optimisticMessage: {},
      rollbackOptimisticAppend: vi.fn(),
    }
    coordinatorMocks.stageAcceptedSendGenerationOperation.mockResolvedValueOnce(staged)
    coordinatorMocks.submitStagedAcceptedSendOperation.mockResolvedValueOnce({
      status: 'accepted',
      response: {
        operation: {
          operationId: 'operation-atomic',
          acceptedMessageId: 'message-atomic',
          state: 'completed',
          resultMessageId: 'reply-atomic',
        },
        append: { disposition: 'accepted', messageId: 'message-atomic' },
      },
    })
    coordinatorMocks.readGenerationOperationStatus.mockResolvedValueOnce({
      status: 'accepted',
      response: {
        operation: {
          operationId: 'operation-atomic',
          acceptedMessageId: 'message-atomic',
          state: 'completed',
          resultMessageId: 'reply-atomic',
        },
      },
    })
    coordinatorMocks.reconcileAcceptedSendCompletion.mockResolvedValueOnce({ status: 'reconciled', source: 'applied' })
    const onAppendAccepted = vi.fn()

    await expect(
      coordinateAcceptedChatSend({
        target: target(),
        message: { role: 'user', data: 'atomic hello' },
        draftGeneration: { sequence: 4 },
        onAppendAccepted,
      }),
    ).resolves.toEqual({
      status: 'generated',
      operationId: 'operation-atomic',
      acceptedMessageId: 'message-atomic',
    })
    expect(coordinatorMocks.stageAcceptedSendGenerationOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        target: target(),
        message: { role: 'user', data: 'atomic hello' },
        draftGeneration: { sequence: 4 },
      }),
    )
    expect(onAppendAccepted).toHaveBeenCalledTimes(1)
    expect(coordinatorMocks.sendChat).not.toHaveBeenCalled()
    expect(coordinatorMocks.reconcileAcceptedSendCompletion).toHaveBeenCalledWith(target(), 'message-atomic', {
      signal: expect.any(AbortSignal),
      operationId: 'operation-atomic',
      resultMessageId: 'reply-atomic',
    })
  })

  it('starts one captured-target generation after a queued append is accepted', async () => {
    const settlement = deferred<ChatMutationFinalOutcome>()
    const onAppendAccepted = vi.fn()
    const input = {
      target: target(),
      append: {
        status: 'queued' as const,
        messageId: 'message-a',
        settlement: settlement.promise,
      },
      onAppendAccepted,
    }

    const first = coordinateAcceptedChatSend(input)
    const duplicate = coordinateAcceptedChatSend(input)

    expect(duplicate).toBe(first)
    expect(coordinatorMocks.sendChat).not.toHaveBeenCalled()
    settlement.resolve({ status: 'accepted' })

    await expect(first).resolves.toEqual({ status: 'generated' })
    expect(onAppendAccepted).toHaveBeenCalledTimes(1)
    expect(coordinatorMocks.sleep).toHaveBeenCalledTimes(1)
    expect(coordinatorMocks.sendChat).toHaveBeenCalledTimes(1)
    expect(coordinatorMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        signal: coordinatorMocks.controller.signal,
        expectedTarget: target(),
      }),
    )
  })

  it('does not generate when a queued append finally fails', async () => {
    const settlement = deferred<ChatMutationFinalOutcome>()
    const onAppendFailed = vi.fn()
    const operation = coordinateAcceptedChatSend({
      target: target(),
      append: {
        status: 'queued',
        messageId: 'message-a',
        settlement: settlement.promise,
      },
      onAppendFailed,
    })

    const failure = { status: 'failed' as const, result: { status: 'unavailable' as const } }
    settlement.resolve(failure)

    await expect(operation).resolves.toEqual({ status: 'append_failed' })
    expect(onAppendFailed).toHaveBeenCalledWith({
      kind: 'known',
      reason: 'queuedServerUnavailable',
      outcome: failure,
    })
    expect(coordinatorMocks.sendChat).not.toHaveBeenCalled()
    expect(get(acceptedSendRecoveries)).toEqual([])
  })

  it('records a target-keyed failure and retries generation without appending', async () => {
    coordinatorMocks.sendChat.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(
      coordinateAcceptedChatSend({
        target: target(),
        append: { status: 'ok', messageId: 'message-a' },
      }),
    ).resolves.toEqual({ status: 'generation_failed', cause: 'generation_failed' })

    const [recovery] = get(acceptedSendRecoveries)
    expect(recovery).toMatchObject({
      target: target(),
      messageId: 'message-a',
      cause: 'generation_failed',
      retrying: false,
    })
    expect(coordinatorMocks.refreshActiveGenerationJobsFromBootstrap).toHaveBeenCalledTimes(1)

    await expect(retryAcceptedChatSend(recovery.id)).resolves.toBe(true)
    expect(coordinatorMocks.sendChat).toHaveBeenCalledTimes(2)
    expect(coordinatorMocks.sendChat).toHaveBeenLastCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: target() }),
    )
    expect(get(acceptedSendRecoveries)).toEqual([])
  })

  it('does not record a failure when the accepted reply was persisted after a mobile stream drop', async () => {
    coordinatorMocks.sendChat.mockResolvedValueOnce(false)
    coordinatorMocks.reconcileAcceptedSendCompletion.mockResolvedValueOnce({
      status: 'reconciled',
      source: 'applied',
    })

    await expect(
      coordinateAcceptedChatSend({
        target: target(),
        append: { status: 'ok', messageId: 'message-a' },
      }),
    ).resolves.toEqual({ status: 'generated' })

    expect(coordinatorMocks.refreshActiveGenerationJobsFromBootstrap).toHaveBeenCalledTimes(1)
    expect(coordinatorMocks.reconcileAcceptedSendCompletion).toHaveBeenCalledWith(target(), 'message-a', {
      signal: expect.any(AbortSignal),
    })
    expect(coordinatorMocks.reconcileAcceptedSendGenerationEffects).toHaveBeenCalledWith(target(), 'message-a')
    expect(get(acceptedSendRecoveries)).toEqual([])
  })

  it('does not treat an unrelated same-chat job as success without the accepted reply', async () => {
    coordinatorMocks.sendChat.mockResolvedValueOnce(false)

    await expect(
      coordinateAcceptedChatSend({
        target: target(),
        append: { status: 'ok', messageId: 'message-a' },
      }),
    ).resolves.toEqual({ status: 'generation_failed', cause: 'generation_failed' })

    expect(coordinatorMocks.refreshActiveGenerationJobsFromBootstrap).toHaveBeenCalledTimes(1)
    expect(coordinatorMocks.reconcileAcceptedSendCompletion).toHaveBeenCalledWith(target(), 'message-a', {
      signal: expect.any(AbortSignal),
    })
    expect(get(acceptedSendRecoveries)).toEqual([
      expect.objectContaining({ target: target(), messageId: 'message-a', cause: 'generation_failed' }),
    ])
  })

  it('keeps a generation-in-progress recovery through a rejected retry and refreshes remote jobs', async () => {
    const rejectForRunningGeneration = async (_index: number, args: unknown): Promise<boolean> => {
      const onFailure = (args as { onFailure?: (failure: { cause: 'generation_in_progress' }) => void }).onFailure
      onFailure?.({ cause: 'generation_in_progress' })
      return false
    }
    coordinatorMocks.sendChat
      .mockImplementationOnce(rejectForRunningGeneration)
      .mockImplementationOnce(rejectForRunningGeneration)
      .mockResolvedValueOnce(true)
    await expect(
      coordinateAcceptedChatSend({
        target: target(),
        append: { status: 'ok', messageId: 'message-a' },
      }),
    ).resolves.toEqual({ status: 'generation_failed', cause: 'generation_in_progress' })

    const [recovery] = get(acceptedSendRecoveries)
    expect(recovery).toMatchObject({
      target: target(),
      messageId: 'message-a',
      cause: 'generation_in_progress',
      retrying: false,
    })
    expect(coordinatorMocks.refreshActiveGenerationJobsFromBootstrap).toHaveBeenCalledTimes(1)

    await expect(retryAcceptedChatSend(recovery.id)).resolves.toBe(false)
    expect(get(acceptedSendRecoveries)).toEqual([
      expect.objectContaining({ id: recovery.id, cause: 'generation_in_progress', retrying: false }),
    ])
    expect(coordinatorMocks.refreshActiveGenerationJobsFromBootstrap).toHaveBeenCalledTimes(2)
    expect(coordinatorMocks.sendChat).toHaveBeenCalledTimes(2)

    await expect(retryAcceptedChatSend(recovery.id)).resolves.toBe(true)
    expect(coordinatorMocks.sendChat).toHaveBeenCalledTimes(3)
    expect(get(acceptedSendRecoveries)).toEqual([])
  })

  it('does not report generated until the completion barrier settles', async () => {
    coordinatorMocks.sendChat.mockResolvedValueOnce(false)
    const barrier = deferred<{ status: 'reconciled'; source: 'applied' }>()
    coordinatorMocks.reconcileAcceptedSendCompletion.mockReturnValueOnce(barrier.promise)
    let observedResult: unknown

    const operation = coordinateAcceptedChatSend({
      target: target(),
      append: { status: 'ok', messageId: 'message-a' },
    }).then((result) => {
      observedResult = result
      return result
    })
    await flushMicrotasks()

    expect(coordinatorMocks.reconcileAcceptedSendCompletion).toHaveBeenCalledTimes(1)
    expect(observedResult).toBeUndefined()
    barrier.resolve({ status: 'reconciled', source: 'applied' })

    await expect(operation).resolves.toEqual({ status: 'generated' })
  })

  it('bounds a never-settling bootstrap refresh and creates a retryable recovery warning', async () => {
    vi.useFakeTimers()
    coordinatorMocks.sendChat.mockResolvedValueOnce(false)
    coordinatorMocks.refreshActiveGenerationJobsFromBootstrap.mockReturnValueOnce(new Promise(() => {}))

    const operation = coordinateAcceptedChatSend({
      target: target(),
      append: { status: 'ok', messageId: 'message-a' },
    })
    await flushMicrotasks()

    expect(get(acceptedSendRecoveries)).toEqual([])
    expect(coordinatorMocks.reconcileAcceptedSendCompletion).not.toHaveBeenCalled()
    const signal = coordinatorMocks.refreshActiveGenerationJobsFromBootstrap.mock.calls[0]?.[0] as AbortSignal
    expect(signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(ACCEPTED_SEND_AUTHORITY_PROBE_TIMEOUT_MS)
    await expect(operation).resolves.toEqual({ status: 'generation_failed', cause: 'generation_failed' })
    expect(signal.aborted).toBe(true)
    expect(get(acceptedSendRecoveries)).toEqual([expect.objectContaining({ messageId: 'message-a', retrying: false })])
  })

  it('bounds a never-settling transcript read and always re-enables Retry', async () => {
    coordinatorMocks.sendChat.mockResolvedValueOnce(false)
    await coordinateAcceptedChatSend({
      target: target(),
      append: { status: 'ok', messageId: 'message-a' },
    })
    const [recovery] = get(acceptedSendRecoveries)

    vi.useFakeTimers()
    coordinatorMocks.sendChat.mockResolvedValueOnce(false)
    coordinatorMocks.reconcileAcceptedSendCompletion.mockReturnValueOnce(new Promise(() => {}))
    const retry = retryAcceptedChatSend(recovery.id)
    await flushMicrotasks()

    expect(get(acceptedSendRecoveries)).toEqual([expect.objectContaining({ id: recovery.id, retrying: true })])
    const bootstrapSignal = coordinatorMocks.refreshActiveGenerationJobsFromBootstrap.mock.calls.at(-1)?.[0]
    const transcriptSignal = coordinatorMocks.reconcileAcceptedSendCompletion.mock.calls.at(-1)?.[2]?.signal
    expect(transcriptSignal).toBe(bootstrapSignal)
    expect(transcriptSignal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(ACCEPTED_SEND_AUTHORITY_PROBE_TIMEOUT_MS)
    await expect(retry).resolves.toBe(false)
    expect(transcriptSignal.aborted).toBe(true)
    expect(get(acceptedSendRecoveries)).toEqual([expect.objectContaining({ id: recovery.id, retrying: false })])
  })

  it('requires explicit confirmation before retrying an abandoned operation that may have been billed', async () => {
    projectAbandonedAcceptedSend()

    coordinatorMocks.alertConfirm.mockResolvedValueOnce(false)
    await expect(retryAcceptedChatSend('operation-abandoned')).resolves.toBe(false)
    expect(coordinatorMocks.retryGenerationOperation).not.toHaveBeenCalled()

    coordinatorMocks.alertConfirm.mockResolvedValueOnce(true)
    coordinatorMocks.retryGenerationOperation.mockResolvedValueOnce({
      status: 'accepted',
      response: { operation: { state: 'owned_by_job' } },
    })
    coordinatorMocks.readGenerationOperationStatus.mockResolvedValueOnce({
      status: 'accepted',
      response: { operation: { state: 'completed', resultMessageId: 'reply-a' } },
    })
    coordinatorMocks.reconcileAcceptedSendCompletion.mockResolvedValueOnce({ status: 'reconciled', source: 'applied' })

    await expect(retryAcceptedChatSend('operation-abandoned')).resolves.toBe(true)
    expect(coordinatorMocks.retryGenerationOperation).toHaveBeenCalledWith('operation-abandoned', 4)
    expect(coordinatorMocks.reconcileAcceptedSendCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: 'character-a', chatId: 'chat-a' }),
      'message-a',
      {
        signal: expect.any(AbortSignal),
        operationId: 'operation-abandoned',
        resultMessageId: 'reply-a',
      },
    )
  })

  it('retains an abandoned retry when dismissal is not acknowledged', async () => {
    projectAbandonedAcceptedSend()
    coordinatorMocks.stopGenerationOperation.mockResolvedValueOnce({ status: 'failed', error: 'offline' })

    await expect(dismissAbandonedAcceptedChatSend('operation-abandoned')).resolves.toBe(false)
    expect(coordinatorMocks.stopGenerationOperation).toHaveBeenCalledExactlyOnceWith('operation-abandoned')
    expect(get(acceptedSendRecoveries)).toEqual([
      expect.objectContaining({ id: 'operation-abandoned', retrying: false }),
    ])
  })

  it('removes an abandoned retry when dismissal is acknowledged', async () => {
    projectAbandonedAcceptedSend()
    coordinatorMocks.stopGenerationOperation.mockResolvedValueOnce({
      status: 'acknowledged',
      disposition: 'cancelled',
      knownAttemptMatched: true,
      operation: { state: 'cancelled' },
    })

    await expect(dismissAbandonedAcceptedChatSend('operation-abandoned')).resolves.toBe(true)
    expect(coordinatorMocks.stopGenerationOperation).toHaveBeenCalledExactlyOnceWith('operation-abandoned')
    expect(get(acceptedSendRecoveries)).toEqual([])
  })
})

describe('accepted send coordinator writer lifecycle', () => {
  it('rejects Reader atomic sends and recovery actions before callbacks or preparation', async () => {
    projectAbandonedAcceptedSend()
    setManagedReaderForTest()
    const onAppendAccepted = vi.fn()
    const onAppendFailed = vi.fn()
    await expect(
      coordinateAcceptedChatSend({ target: target(), message: 'Reader text', onAppendAccepted, onAppendFailed }),
    ).resolves.toEqual({ status: 'append_failed' })
    await expect(retryAcceptedChatSend('missing')).resolves.toBe(false)
    await expect(dismissAbandonedAcceptedChatSend('operation-abandoned')).resolves.toBe(false)
    expect(coordinatorMocks.waitForPendingCharacterScriptDefinitionSave).not.toHaveBeenCalled()
    expect(coordinatorMocks.stageAcceptedSendGenerationOperation).not.toHaveBeenCalled()
    expect(coordinatorMocks.stopGenerationOperation).not.toHaveBeenCalled()
    expect(onAppendAccepted).not.toHaveBeenCalled()
    expect(onAppendFailed).not.toHaveBeenCalled()
  })

  it('does not stage after preflight resumes under a newer writer session', async () => {
    setManagedWriterForTest()
    const scripts = deferred<'idle'>()
    coordinatorMocks.waitForPendingCharacterScriptDefinitionSave.mockReturnValueOnce(scripts.promise)
    const onAppendFailed = vi.fn()
    const pending = coordinateAcceptedChatSend({ target: target(), message: 'held preflight', onAppendFailed })
    await vi.waitFor(() => expect(coordinatorMocks.waitForPendingCharacterScriptDefinitionSave).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    scripts.resolve('idle')
    await expect(pending).resolves.toMatchObject({ status: 'generation_failed' })
    expect(coordinatorMocks.stageAcceptedSendGenerationOperation).not.toHaveBeenCalled()
    expect(onAppendFailed).not.toHaveBeenCalled()
  })

  it('does not acknowledge or generate from an old queued append settlement', async () => {
    setManagedWriterForTest()
    const settlement = deferred<ChatMutationFinalOutcome>()
    const onAppendAccepted = vi.fn()
    const onAppendFailed = vi.fn()
    const pending = coordinateAcceptedChatSend({
      target: target(),
      append: { status: 'queued', messageId: 'held-message', settlement: settlement.promise },
      onAppendAccepted,
      onAppendFailed,
    })
    demoteAndRepromoteForTest()
    settlement.resolve({ status: 'accepted' })
    await expect(pending).resolves.toMatchObject({ status: 'generation_failed' })
    expect(onAppendAccepted).not.toHaveBeenCalled()
    expect(onAppendFailed).not.toHaveBeenCalled()
    expect(coordinatorMocks.sendChat).not.toHaveBeenCalled()
    expect(get(acceptedSendRecoveries)).toEqual([])
  })

  it('does not notify append acceptance or open a stream from a held accepted operation', async () => {
    setManagedWriterForTest()
    coordinatorMocks.stageAcceptedSendGenerationOperation.mockResolvedValueOnce({
      request: { acceptedMessageId: 'old-message' },
      target: target(),
      handle: {},
      intent: {},
      rollbackOptimisticAppend: vi.fn(),
    })
    const submitted = deferred<unknown>()
    coordinatorMocks.submitStagedAcceptedSendOperation.mockReturnValueOnce(submitted.promise)
    const onAppendAccepted = vi.fn()
    const pending = coordinateAcceptedChatSend({ target: target(), message: 'held acceptance', onAppendAccepted })
    await vi.waitFor(() => expect(coordinatorMocks.submitStagedAcceptedSendOperation).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    submitted.resolve({
      status: 'accepted',
      response: {
        operation: { operationId: 'held-op', acceptedMessageId: 'old-message', state: 'completed' },
        append: { disposition: 'accepted' },
      },
    })
    await expect(pending).resolves.toMatchObject({ status: 'generation_failed' })
    expect(onAppendAccepted).not.toHaveBeenCalled()
    expect(coordinatorMocks.readGenerationOperationStatus).not.toHaveBeenCalled()
    expect(coordinatorMocks.sendChat).not.toHaveBeenCalled()
  })

  it('does not retry an operation after its confirmation crosses writer re-promotion', async () => {
    setManagedWriterForTest()
    acceptedSendRecoveries.set([
      {
        id: 'held-retry',
        operationId: 'held-retry',
        target: target(),
        messageId: 'm',
        syntheticSayNothing: false,
        cause: 'generation_failed',
        phase: 'retryable',
        providerMayHaveRun: true,
        retrying: false,
        unrelatedSameChatJob: false,
        stateVersion: 4,
      },
    ])
    const confirmation = deferred<boolean>()
    coordinatorMocks.alertConfirm.mockReturnValueOnce(confirmation.promise)
    const pending = retryAcceptedChatSend('held-retry')
    await vi.waitFor(() => expect(coordinatorMocks.alertConfirm).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    confirmation.resolve(true)
    await expect(pending).resolves.toBe(false)
    expect(coordinatorMocks.retryGenerationOperation).not.toHaveBeenCalled()
    expect(get(acceptedSendRecoveries)[0].retrying).toBe(false)
  })

  it('does not dismiss an operation after acknowledgement crosses writer re-promotion', async () => {
    setManagedWriterForTest()
    projectAbandonedAcceptedSend()
    const acknowledgement = deferred<unknown>()
    coordinatorMocks.stopGenerationOperation.mockReturnValueOnce(acknowledgement.promise)
    const pending = dismissAbandonedAcceptedChatSend('operation-abandoned')
    await vi.waitFor(() => expect(coordinatorMocks.stopGenerationOperation).toHaveBeenCalledOnce())
    expect(get(acceptedSendRecoveries)[0].retrying).toBe(true)

    demoteAndRepromoteForTest()
    acknowledgement.resolve({
      status: 'acknowledged',
      disposition: 'cancelled',
      knownAttemptMatched: true,
      operation: { state: 'cancelled' },
    })

    await expect(pending).resolves.toBe(false)
    expect(get(acceptedSendRecoveries)).toEqual([
      expect.objectContaining({ id: 'operation-abandoned', retrying: false }),
    ])
  })
})

it('preserves exact accepted append identity when an old caller hands off after re-promotion', async () => {
  setManagedWriterForTest()
  const clientGeneration = captureClientSessionGeneration()
  demoteAndRepromoteForTest()
  const onAppendAccepted = vi.fn()
  const onAppendFailed = vi.fn()
  const input = {
    clientGeneration,
    target: target(),
    append: { status: 'ok' as const, messageId: 'old-accepted' },
    onAppendAccepted,
    onAppendFailed,
  }
  await expect(coordinateAcceptedChatSend(input)).resolves.toMatchObject({
    status: 'generation_failed',
    acceptedMessageId: 'old-accepted',
  })
  await expect(coordinateAcceptedChatSend({ ...input, clientGeneration: undefined })).resolves.toMatchObject({
    status: 'generation_failed',
    acceptedMessageId: 'old-accepted',
  })
  expect(coordinatorMocks.sendChat).not.toHaveBeenCalled()
  expect(onAppendAccepted).not.toHaveBeenCalled()
  expect(onAppendFailed).not.toHaveBeenCalled()
})

it('observes an old caller queued settlement after re-promotion without starting generation', async () => {
  setManagedWriterForTest()
  const clientGeneration = captureClientSessionGeneration()
  demoteAndRepromoteForTest()
  const settlement = deferred<ChatMutationFinalOutcome>()
  const onAppendAccepted = vi.fn()
  const pending = coordinateAcceptedChatSend({
    clientGeneration,
    target: target(),
    append: { status: 'queued', messageId: 'old-queued', settlement: settlement.promise },
    onAppendAccepted,
  })
  settlement.resolve({ status: 'accepted' })
  await expect(pending).resolves.toMatchObject({ status: 'generation_failed', acceptedMessageId: 'old-queued' })
  expect(coordinatorMocks.sendChat).not.toHaveBeenCalled()
  expect(onAppendAccepted).not.toHaveBeenCalled()
})

it('releases a retired retry indicator without allowing its old cleanup to clear a newer retry', async () => {
  setManagedWriterForTest()
  acceptedSendRecoveries.set([
    {
      id: 'retry-scope',
      operationId: 'retry-scope',
      target: target(),
      messageId: 'm',
      syntheticSayNothing: false,
      cause: 'generation_failed',
      phase: 'retryable',
      providerMayHaveRun: false,
      unrelatedSameChatJob: false,
      retrying: false,
      stateVersion: 4,
    },
  ])
  const oldResult = deferred<unknown>()
  const newResult = deferred<unknown>()
  coordinatorMocks.retryGenerationOperation
    .mockReturnValueOnce(oldResult.promise)
    .mockReturnValueOnce(newResult.promise)
  const oldRetry = retryAcceptedChatSend('retry-scope')
  expect(get(acceptedSendRecoveries)[0].retrying).toBe(true)
  demoteAndRepromoteForTest()
  expect(get(acceptedSendRecoveries)[0].retrying).toBe(false)
  const newRetry = retryAcceptedChatSend('retry-scope')
  expect(get(acceptedSendRecoveries)[0].retrying).toBe(true)
  oldResult.resolve({ status: 'retained' })
  await expect(oldRetry).resolves.toBe(false)
  expect(get(acceptedSendRecoveries)[0].retrying).toBe(true)
  newResult.resolve({ status: 'retained' })
  await expect(newRetry).resolves.toBe(false)
  expect(get(acceptedSendRecoveries)[0].retrying).toBe(false)
})
