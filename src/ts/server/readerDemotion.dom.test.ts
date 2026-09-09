import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import { setManagedWriterForTest } from '../__tests__/managedClientSession'
import { demoteClientSession, getClientSessionSnapshot, resetClientSessionForTests } from '../clientSession'
import {
  recordStartupMilestone,
  resetStartupReadinessForTests,
  settleStartupChatReadiness,
  settleStartupPluginRuntimeReadiness,
  settleStartupGenerationRecoveryReadiness,
} from '../startupReadiness'
import { selectedCharID } from '../stores.svelte'
import * as storage from '../storage/fastifyStorage'
import { setCachedServerCommandRevision } from './commands'
import { resetWriterAccessLostForTests } from './activeWriterSession'
import {
  applyServerChatMessagesResource,
  getReaderChatMessageOwnerState,
  resetChatHydration,
} from './chatMessageHydration.svelte'
import {
  resetGenerationOperationClientForTests,
  stageAcceptedSendGenerationOperation,
  submitStagedAcceptedSendOperation,
} from './generationOperations'
import * as outbox from './pendingMutationOutbox'

const scope = {
  writerSessionId: 'external-operation-test',
  writerEpoch: 1,
  databaseLineage: 'external-operation-database',
  requestedWriterWasActive: true,
}
const target = { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function rawIntent(mutationId: string): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('risu-pending-mutations-v1', 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('mutations', 'readonly').objectStore('mutations').get(mutationId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

async function stage() {
  const staged = await stageAcceptedSendGenerationOperation({
    target,
    message: 'Exact retained user intent',
    draftGeneration: { composer: 'captured generation' },
    generation: {
      syntheticSayNothing: false,
      resetMessages: false,
      inlayAssetRefs: [],
      clientContext: {},
      clientCapabilities: {},
    },
  })
  if ('status' in staged) throw new Error(staged.error)
  return staged
}

function accepted(staged: Awaited<ReturnType<typeof stage>>): Response {
  const operationId = staged.request.operationId
  const messageId = staged.request.acceptedMessageId
  return new Response(
    JSON.stringify({
      operation: {
        operationId,
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        state: 'owned_by_job',
        stateVersion: 2,
        projectionEpoch: 3,
        creatorWriterSessionId: scope.writerSessionId,
        creatorWriterEpoch: 1,
        characterId: target.characterId,
        chatId: target.chatId,
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
          actorWriterSessionId: scope.writerSessionId,
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
        event: { type: 'message.appended', revision: 8, resource: 'message', id: messageId, parentId: target.chatId },
      },
      stream: { href: `/api/v1/generation-operations/${operationId}/stream?attemptNo=1&jobId=job-a&projectionEpoch=3` },
    }),
    { status: 200 },
  )
}

beforeEach(async () => {
  resetClientSessionForTests()
  resetStartupReadinessForTests()
  resetWriterAccessLostForTests()
  resetGenerationOperationClientForTests()
  resetChatHydration()
  vi.stubGlobal('indexedDB', new IDBFactory())
  outbox.resetPendingMutationOutboxForTests()
  setManagedWriterForTest()
  await outbox.preparePendingMutationOutbox(scope)
  for (const milestone of [
    'entry',
    'shell-mounted',
    'reader-ready',
    'writer-ready',
    'plugins-ready',
    'chat-ready',
  ] as const)
    recordStartupMilestone(milestone)
  settleStartupGenerationRecoveryReadiness(true)
  settleStartupChatReadiness(true)
  settleStartupPluginRuntimeReadiness(true)
  ;(testDatabaseState as { db: unknown }).db = {
    currentChar: 0,
    characters: [
      {
        chaId: target.characterId,
        type: 'character',
        name: 'Character',
        chatPage: 0,
        chats: [{ id: target.chatId, message: [] }],
      },
    ],
  }
  selectedCharID.set(0)
  setCachedServerCommandRevision(7)
  applyServerChatMessagesResource(
    target.chatId,
    [{ role: 'char', data: 'Committed baseline', chatId: 'baseline' }],
    undefined,
    [],
  )
  vi.spyOn(storage, 'getNodeServerProxyAuth').mockResolvedValue('auth')
})

afterEach(async () => {
  await outbox.clearPendingMutationOutbox()
  outbox.resetPendingMutationOutboxForTests()
  resetGenerationOperationClientForTests()
  resetClientSessionForTests()
  resetStartupReadinessForTests()
  resetChatHydration()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('reader demotion with encrypted generation intent', () => {
  it('parks the exact staged send without dispatch or reader optimism', async () => {
    const staged = await stage()
    const encrypted = await rawIntent(staged.handle.mutationId)
    expect(encrypted).toBeDefined()
    expect(JSON.stringify(encrypted)).not.toContain('Exact retained user intent')
    const pending = await outbox.listPendingMutations()
    expect(pending[0].intent).toEqual(staged.intent)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    demoteClientSession()
    await expect(submitStagedAcceptedSendOperation(staged)).resolves.toMatchObject({ status: 'retained' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await rawIntent(staged.handle.mutationId)).toEqual(encrypted)
    expect(getReaderChatMessageOwnerState(target.chatId)?.messages.map((row) => row.data)).toEqual([
      'Committed baseline',
    ])
  })

  it.each(['response', 'cleanup'] as const)(
    'settles late acceptance across held %s without changing newer reader content',
    async (holdAt) => {
      const staged = await stage()
      const response = deferred<Response>()
      const cleanup = deferred<void>()
      const discard = outbox.discardPendingMutation
      const discardSpy = vi.spyOn(outbox, 'discardPendingMutation').mockImplementation(async (handle) => {
        if (holdAt === 'cleanup') await cleanup.promise
        return discard(handle)
      })
      const fetchMock = vi.fn(() => response.promise)
      vi.stubGlobal('fetch', fetchMock)
      const submitting = submitStagedAcceptedSendOperation(staged)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      if (holdAt === 'cleanup') {
        response.resolve(accepted(staged))
        await vi.waitFor(() => expect(discardSpy).toHaveBeenCalledWith(staged.handle))
      }
      demoteClientSession()
      applyServerChatMessagesResource(
        target.chatId,
        [
          { role: 'char', data: 'A newer server update', chatId: 'baseline' },
          { ...staged.optimisticMessage, data: 'Certified accepted message' },
        ],
        undefined,
        [],
      )
      if (holdAt === 'response') response.resolve(accepted(staged))
      else cleanup.resolve()
      await expect(submitting).resolves.toMatchObject({ status: 'accepted' })
      expect(await rawIntent(staged.handle.mutationId)).toBeUndefined()
      expect(discardSpy).toHaveBeenCalledWith(staged.handle)
      expect(getClientSessionSnapshot().lifecycle).toBe('reading')
      expect(getReaderChatMessageOwnerState(target.chatId)?.messages.map((row) => row.data)).toEqual([
        'A newer server update',
        'Certified accepted message',
      ])
      expect(fetchMock).toHaveBeenCalledOnce()
    },
  )
})
