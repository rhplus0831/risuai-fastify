/** @module-tag core */
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const commandApi = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  inlineReplay: vi.fn(),
  replay: vi.fn(),
  withoutReceipt: vi.fn(<T>(execute: () => Promise<T>) => execute()),
  withReceipt: vi.fn(<T>(execute: () => Promise<T>) => execute()),
}))
const recoveryApi = vi.hoisted(() => ({ scheduleReload: vi.fn() }))
const discardAlertApi = vi.hoisted(() => ({ alertError: vi.fn() }))

vi.mock('./commands', () => ({
  acknowledgeServerMutationReceipts: commandApi.acknowledge,
  replayDurableMutationRequestsInline: commandApi.inlineReplay,
  replayDurableMutationRequests: commandApi.replay,
  runServerCommandWithoutMutationReceipt: commandApi.withoutReceipt,
  runServerCommandWithMutationReceipt: commandApi.withReceipt,
}))
vi.mock('./activeWriterSession', () => ({
  schedulePendingMutationRecoveryReload: recoveryApi.scheduleReload,
}))
vi.mock('../alert', () => ({ alertError: discardAlertApi.alertError }))

import {
  dispatchDurableMutation,
  executePreparedDurableMutationWithinQueue,
  registerDurableMutationSettlementListener,
  setPendingMutationDiscardNotifier,
} from './durableMutationDispatch'
import {
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  listPendingMutationReceiptAcknowledgements,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
  type DurableMutationIntent,
} from './pendingMutationOutbox'

const intent: DurableMutationIntent = {
  version: 1,
  requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000 } } }],
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  commandApi.acknowledge.mockReset()
  commandApi.acknowledge.mockResolvedValue(true)
  commandApi.inlineReplay.mockReset()
  commandApi.inlineReplay.mockResolvedValue({ status: 'ok' })
  commandApi.withoutReceipt.mockClear()
  commandApi.withReceipt.mockClear()
  recoveryApi.scheduleReload.mockReset()
  discardAlertApi.alertError.mockReset()
  setPendingMutationDiscardNotifier((_key, error) => discardAlertApi.alertError(error))
  await preparePendingMutationOutbox({
    writerSessionId: 'writer-a',
    writerEpoch: 1,
    databaseLineage: 'database-a',
    requestedWriterWasActive: true,
  })
})

afterEach(async () => {
  setPendingMutationDiscardNotifier(null)
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('durable mutation dispatch', () => {
  it('publishes a terminal discard when ownership preparation removes an old-lineage row', async () => {
    const handle = stagePendingMutation('settings:runtime', intent)
    await expect(handle.ready).resolves.toBe('persisted')
    const settlement = vi.fn()
    const cleanup = registerDurableMutationSettlementListener(handle.mutationId, settlement)

    await expect(
      preparePendingMutationOutbox({
        writerSessionId: 'writer-a',
        writerEpoch: 1,
        databaseLineage: 'database-restored',
        requestedWriterWasActive: true,
      }),
    ).resolves.toEqual({ discarded: 1 })

    expect(settlement).toHaveBeenCalledOnce()
    expect(settlement).toHaveBeenCalledWith('discarded', {})
    cleanup()
  })

  it('does not start the request until the exact encrypted generation is durable', async () => {
    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce(async (algorithm, key, data) => {
      await encryptionGate.promise
      return originalEncrypt(algorithm, key, data)
    })
    const handle = stagePendingMutation('settings:runtime', intent)
    const request = vi.fn(async () => acceptedResult())
    const dispatch = wrappedDispatch(request)

    const pending = dispatchDurableMutation(handle, intent, dispatch)
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()

    encryptionGate.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'ok' })
    expect(request).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationId: handle.mutationId,
        databaseLineage: 'database-a',
        executionWrapper: expect.any(Function),
      }),
    )
  })

  it('locks duplicate same-id dispatches and revalidates the row after the first caller completes', async () => {
    const handle = stagePendingMutation('settings:runtime', intent)
    await handle.ready
    const firstResponse = deferred<ReturnType<typeof acceptedResult>>()
    const request = vi.fn(async () => firstResponse.promise)
    const dispatch = wrappedDispatch(request)

    const first = dispatchDurableMutation(handle, intent, dispatch)
    const duplicate = dispatchDurableMutation(handle, intent, dispatch)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())

    firstResponse.resolve(acceptedResult())
    await expect(first).resolves.toMatchObject({ status: 'ok' })
    await expect(duplicate).resolves.toEqual({ status: 'unavailable' })
    expect(request).toHaveBeenCalledOnce()
    expect(await listPendingMutations()).toEqual([])
  })

  it('retains transient failures and a genuine stale-writer rejection', async () => {
    const transient = stagePendingMutation('settings:runtime', intent)
    await dispatchDurableMutation(
      transient,
      intent,
      wrappedDispatch(async () => ({ status: 'error', error: 'offline' })),
    )
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toContain(transient.mutationId)

    const stale = stagePendingMutation('settings:runtime-2', intent)
    await dispatchDurableMutation(
      stale,
      intent,
      wrappedDispatch(async () => ({
        status: 'error',
        error: 'active_writer_stale',
        reason: 'stale-writer',
      })),
    )
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toContain(stale.mutationId)
    expect(discardAlertApi.alertError).not.toHaveBeenCalled()
  })

  it('evaluates a shared failure only after an earlier same-key durable lock releases', async () => {
    const firstHandle = stagePendingMutation('settings:locked-batch', intent)
    const laterHandle = stagePendingMutation('settings:locked-batch', intent)
    const firstResponse = deferred<ReturnType<typeof acceptedResult>>()
    const firstRequestStarted = deferred<void>()
    const firstRequest = vi.fn(async () => {
      firstRequestStarted.resolve()
      return firstResponse.promise
    })
    const laterRequest = vi.fn(async () => acceptedResult())
    const sharedFailure = { status: 'error' as const, error: 'batch stopped' }
    const beforeExecuteResult = vi.fn(() => sharedFailure)

    const first = dispatchDurableMutation(firstHandle, intent, wrappedDispatch(firstRequest))
    const later = dispatchDurableMutation(laterHandle, intent, wrappedDispatch(laterRequest), {
      beforeExecuteResult,
    })

    await firstRequestStarted.promise
    expect(firstRequest).toHaveBeenCalledOnce()
    expect(beforeExecuteResult).not.toHaveBeenCalled()
    expect(laterRequest).not.toHaveBeenCalled()

    firstResponse.resolve(acceptedResult())
    await expect(first).resolves.toMatchObject({ status: 'ok' })
    await expect(later).resolves.toEqual(sharedFailure)
    expect(beforeExecuteResult).toHaveBeenCalledOnce()
    expect(laterRequest).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([laterHandle.mutationId])
  })

  it('settles a shared batch failure without draining predecessors or sending', async () => {
    const predecessor = stagePendingMutation('settings:runtime', intent)
    await dispatchDurableMutation(
      predecessor,
      intent,
      wrappedDispatch(async () => ({ status: 'error', error: 'offline' })),
    )
    commandApi.inlineReplay.mockClear()

    const laterIntent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxResponse: 1_000 } } }],
    }
    const later = stagePendingMutation('settings:runtime', laterIntent)
    const request = vi.fn(async () => acceptedResult())
    const sharedTransientFailure = { status: 'error' as const, error: 'offline' }

    await expect(
      dispatchDurableMutation(later, laterIntent, wrappedDispatch(request), {
        beforeExecuteResult: () => sharedTransientFailure,
      }),
    ).resolves.toEqual(sharedTransientFailure)

    expect(request).not.toHaveBeenCalled()
    expect(commandApi.inlineReplay).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([
      predecessor.mutationId,
      later.mutationId,
    ])

    const terminal = stagePendingMutation('settings:terminal', intent)
    const sharedTerminalFailure = {
      status: 'error' as const,
      error: 'invalid request',
      reason: 'invalid-request' as const,
    }
    await expect(
      dispatchDurableMutation(terminal, intent, wrappedDispatch(request), {
        beforeExecuteResult: () => sharedTerminalFailure,
      }),
    ).resolves.toEqual(sharedTerminalFailure)
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).not.toContain(terminal.mutationId)
    expect(request).not.toHaveBeenCalled()
  })

  it('still sends an ordinary autosave when durable browser storage is unavailable', async () => {
    const request = vi.fn(async () => acceptedResult())
    const unavailableHandle = {
      key: 'settings:runtime',
      mutationId: 'storage-unavailable',
      sequence: 1,
      ownerWriterSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      phase: 'staged' as const,
      ready: Promise.resolve('unavailable' as const),
    }

    await expect(dispatchDurableMutation(unavailableHandle, intent, wrappedDispatch(request))).resolves.toMatchObject({
      status: 'ok',
    })
    expect(request).toHaveBeenCalledOnce()
    expect(commandApi.withoutReceipt).toHaveBeenCalledOnce()
  })

  it('keeps an accepted receipt acknowledgement durable when its network cleanup fails', async () => {
    commandApi.acknowledge.mockResolvedValue(false)
    const handle = stagePendingMutation('settings:runtime', intent)

    await dispatchDurableMutation(
      handle,
      intent,
      wrappedDispatch(async () => acceptedResult()),
    )

    expect(await listPendingMutations()).toEqual([])
    expect(await listPendingMutationReceiptAcknowledgements()).toEqual([
      expect.objectContaining({ mutationId: handle.mutationId, databaseLineage: 'database-a' }),
    ])
  })

  it('replays an older request that never reached the server before sending its successor', async () => {
    const retained = stagePendingMutation('settings:runtime', intent)
    await dispatchDurableMutation(
      retained,
      intent,
      wrappedDispatch(async () => ({ status: 'error', error: 'network request failed' })),
    )
    const successorIntent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxResponse: 1_000 } } }],
    }
    const successor = stagePendingMutation('settings:runtime', successorIntent, retained)
    const order: string[] = []
    commandApi.inlineReplay.mockImplementation(async () => {
      order.push('retained')
      return { status: 'ok' }
    })

    await expect(
      dispatchDurableMutation(
        successor,
        successorIntent,
        wrappedDispatch(async () => {
          order.push('successor')
          return acceptedResult()
        }),
      ),
    ).resolves.toMatchObject({ status: 'ok' })

    expect(order).toEqual(['retained', 'successor'])
    expect(commandApi.inlineReplay).toHaveBeenCalledWith(intent.requests, retained.mutationId, 'database-a')
    expect(await listPendingMutations()).toEqual([])
  })

  it('drains transitive cross-lane predecessors under stable sorted semantic locks', async () => {
    const targetIntent: DurableMutationIntent = {
      ...intent,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 4_000 } } }],
    }
    const selectBIntent: DurableMutationIntent = {
      ...intent,
      dependencyKeys: ['character-owner:char-b'],
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 6_000 } } }],
    }
    const selectCIntent: DurableMutationIntent = {
      ...intent,
      dependencyKeys: ['character-owner:char-c'],
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000 } } }],
    }
    const targetB = stagePendingMutation('character-owner:char-b', targetIntent)
    const selectB = stagePendingMutation('character-selection', selectBIntent)
    const targetC = stagePendingMutation('character-owner:char-c', targetIntent)
    const selectC = stagePendingMutation('character-selection', selectCIntent)
    await Promise.all([targetB.ready, selectB.ready, targetC.ready, selectC.ready])
    await beginPendingMutationDispatch(targetB)
    await beginPendingMutationDispatch(selectB)
    await beginPendingMutationDispatch(targetC)

    const acquiredLocks: string[] = []
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(async (name: string, _options: unknown, task: () => Promise<unknown>) => {
          acquiredLocks.push(name)
          return task()
        }),
      },
    })
    const order: string[] = []
    commandApi.inlineReplay.mockImplementation(async (_requests, mutationId) => {
      order.push(mutationId)
      return { status: 'ok' }
    })

    await expect(
      dispatchDurableMutation(
        selectC,
        selectCIntent,
        wrappedDispatch(async () => {
          order.push(selectC.mutationId)
          return acceptedResult()
        }),
      ),
    ).resolves.toMatchObject({ status: 'ok' })

    expect(order).toEqual([targetB.mutationId, selectB.mutationId, targetC.mutationId, selectC.mutationId])
    const semanticLocks = acquiredLocks
      .filter((name) => name.includes('durable-mutation-key:'))
      .map((name) => name.slice(name.lastIndexOf(':') + 1))
    expect(semanticLocks).toEqual(['char-b', 'char-c', 'character-selection'])
    expect(await listPendingMutations()).toEqual([])
  })

  it('deduplicates an accepted response-loss predecessor before sending its successor', async () => {
    const retained = stagePendingMutation('settings:runtime', intent)
    await dispatchDurableMutation(
      retained,
      intent,
      wrappedDispatch(async () => ({ status: 'error', error: 'response stream ended' })),
    )
    const successor = stagePendingMutation('settings:runtime', intent, retained)
    const order: string[] = []
    commandApi.inlineReplay.mockImplementation(async (_requests, mutationId) => {
      order.push(`receipt:${mutationId}`)
      return { status: 'ok' }
    })

    await dispatchDurableMutation(
      successor,
      intent,
      wrappedDispatch(async () => {
        order.push(`successor:${successor.mutationId}`)
        return acceptedResult()
      }),
    )

    expect(order).toEqual([`receipt:${retained.mutationId}`, `successor:${successor.mutationId}`])
    expect(commandApi.acknowledge.mock.calls.map(([mutationId]) => mutationId)).toEqual([
      retained.mutationId,
      successor.mutationId,
    ])
    expect(await listPendingMutations()).toEqual([])
  })

  it('retains both generations and does not send the successor while its predecessor is transient', async () => {
    const retained = stagePendingMutation('settings:runtime', intent)
    await dispatchDurableMutation(
      retained,
      intent,
      wrappedDispatch(async () => ({ status: 'error', error: 'offline' })),
    )
    const successor = stagePendingMutation('settings:runtime', intent, retained)
    commandApi.inlineReplay.mockResolvedValue({ status: 'error', error: 'still offline' })
    const successorRequest = vi.fn(async () => acceptedResult())

    await expect(dispatchDurableMutation(successor, intent, wrappedDispatch(successorRequest))).resolves.toEqual({
      status: 'unavailable',
    })

    expect(successorRequest).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([
      retained.mutationId,
      successor.mutationId,
    ])
  })

  it('holds a prompt row behind a transient owner repair and releases it only after repair replay succeeds', async () => {
    const ownerKey = 'prompt-template-owner:preset-a'
    const repairIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-presets/preset-a',
          body: { patch: { id: 'preset-a', promptTemplate: [{ id: 'row-a', text: 'repair snapshot' }] } },
        },
      ],
    }
    const rowIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-items/row-a',
          body: { promptPresetId: 'preset-a', patch: { text: 'latest row edit' } },
        },
      ],
    }
    const repair = stagePendingMutation(ownerKey, repairIntent)
    const repairRequest = vi.fn(async () => ({ status: 'error' as const, error: 'response stream ended' }))
    await dispatchDurableMutation(repair, repairIntent, wrappedDispatch(repairRequest))
    const row = stagePendingMutation(ownerKey, rowIntent)
    const rowRequest = vi.fn(async () => acceptedResult())

    commandApi.inlineReplay.mockResolvedValueOnce({ status: 'error', error: 'still offline' })
    await expect(dispatchDurableMutation(row, rowIntent, wrappedDispatch(rowRequest))).resolves.toEqual({
      status: 'unavailable',
    })

    expect(repairRequest).toHaveBeenCalledOnce()
    expect(rowRequest).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([
      repair.mutationId,
      row.mutationId,
    ])

    commandApi.inlineReplay.mockResolvedValueOnce({ status: 'ok' })
    await expect(dispatchDurableMutation(row, rowIntent, wrappedDispatch(rowRequest))).resolves.toMatchObject({
      status: 'ok',
    })

    expect(commandApi.inlineReplay.mock.calls.map(([, mutationId]) => mutationId)).toEqual([
      repair.mutationId,
      repair.mutationId,
    ])
    expect(rowRequest).toHaveBeenCalledOnce()
    expect(await listPendingMutations()).toEqual([])
  })

  it('holds prompt-item DELETE behind a transient row PATCH and recovers in order', async () => {
    const ownerKey = 'prompt-template-owner:preset-a'
    const patchIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-items/row-a',
          body: { promptPresetId: 'preset-a', patch: { text: 'latest edit' } },
        },
      ],
    }
    const deleteIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'DELETE',
          path: '/prompt-items/row-a',
          body: { promptPresetId: 'preset-a' },
        },
      ],
    }
    const patch = stagePendingMutation(ownerKey, patchIntent)
    await dispatchDurableMutation(
      patch,
      patchIntent,
      wrappedDispatch(async () => ({ status: 'error', error: 'offline' })),
    )
    const deletion = stagePendingMutation(ownerKey, deleteIntent)
    const order: string[] = []
    const deleteRequest = vi.fn(async () => {
      order.push('delete')
      return acceptedResult()
    })

    commandApi.inlineReplay.mockImplementationOnce(async () => {
      order.push('patch-blocked')
      return { status: 'error', error: 'still offline' }
    })
    await expect(dispatchDurableMutation(deletion, deleteIntent, wrappedDispatch(deleteRequest))).resolves.toEqual({
      status: 'unavailable',
    })

    expect(order).toEqual(['patch-blocked'])
    expect(deleteRequest).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([
      patch.mutationId,
      deletion.mutationId,
    ])

    commandApi.inlineReplay.mockImplementationOnce(async () => {
      order.push('patch-recovered')
      return { status: 'ok' }
    })
    await expect(
      dispatchDurableMutation(deletion, deleteIntent, wrappedDispatch(deleteRequest)),
    ).resolves.toMatchObject({ status: 'ok' })

    expect(order).toEqual(['patch-blocked', 'patch-recovered', 'delete'])
    expect(deleteRequest).toHaveBeenCalledOnce()
    expect(await listPendingMutations()).toEqual([])
  })

  it('reloads instead of sending a successor after a terminal predecessor is discarded', async () => {
    const predecessor = stagePendingMutation('settings:runtime', intent)
    await dispatchDurableMutation(
      predecessor,
      intent,
      wrappedDispatch(async () => ({ status: 'error', error: 'offline' })),
    )
    const successorIntent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxResponse: 2_000 } } }],
    }
    const successor = stagePendingMutation('settings:runtime', successorIntent)
    const successorRequest = vi.fn(async () => acceptedResult())
    commandApi.inlineReplay.mockResolvedValueOnce({
      status: 'error',
      error: 'invalid queued request',
      reason: 'invalid-request',
    })

    await expect(
      dispatchDurableMutation(successor, successorIntent, wrappedDispatch(successorRequest)),
    ).resolves.toEqual({ status: 'unavailable' })

    expect(successorRequest).not.toHaveBeenCalled()
    expect(recoveryApi.scheduleReload).toHaveBeenCalledOnce()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([successor.mutationId])
  })

  it('replaces a prepared placeholder before sending under its preserved receipt id', async () => {
    const fallbackIntent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 4_000 } } }],
    }
    const handle = stagePendingMutation('settings:runtime', fallbackIntent)
    const request = vi.fn(async () => acceptedResult())

    const outcome = await executePreparedDurableMutationWithinQueue({ handle, intent }, request)

    expect(outcome).toMatchObject({ disposition: 'sent', handle: { mutationId: handle.mutationId }, intent })
    expect(commandApi.withReceipt).toHaveBeenCalledWith(request, handle.mutationId, 'database-a')
    expect(request).toHaveBeenCalledOnce()
    expect(await listPendingMutations()).toEqual([])
  })

  it('uses a full successor and distinct receipt id when a remote dispatch marker wins', async () => {
    const fallbackIntent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 4_000 } } }],
    }
    const fullIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        { method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000, maxResponse: 1_000 } } },
      ],
    }
    const placeholder = stagePendingMutation('settings:runtime', fallbackIntent)
    await placeholder.ready
    const remote = (await listPendingMutations())[0]!.handle
    await expect(beginPendingMutationDispatch(remote)).resolves.toBe('persisted')
    const selectFull = vi.fn()
    const request = vi.fn(async () => acceptedResult())

    const outcome = await executePreparedDurableMutationWithinQueue(
      { handle: placeholder, intent, standaloneIntent: fullIntent, onStandaloneIntent: selectFull },
      request,
    )

    expect(outcome.disposition).toBe('sent')
    expect(outcome.handle.mutationId).not.toBe(placeholder.mutationId)
    expect(outcome.intent).toEqual(fullIntent)
    expect(selectFull).toHaveBeenCalledOnce()
    expect(commandApi.inlineReplay).toHaveBeenCalledWith(fallbackIntent.requests, placeholder.mutationId, 'database-a')
    expect(commandApi.withReceipt).toHaveBeenCalledWith(request, outcome.handle.mutationId, 'database-a')
    expect(await listPendingMutations()).toEqual([])
  })

  it('does not switch the live body when exact replacement must be retained without sending', async () => {
    const placeholder = stagePendingMutation('settings:runtime', intent)
    await placeholder.ready
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-b',
      requestedWriterWasActive: true,
    })
    const fullIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        { method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000, maxResponse: 1_000 } } },
      ],
    }
    const selectFull = vi.fn()
    const request = vi.fn(async () => acceptedResult())

    const outcome = await executePreparedDurableMutationWithinQueue(
      {
        handle: placeholder,
        intent,
        standaloneIntent: fullIntent,
        onStandaloneIntent: selectFull,
      },
      request,
    )

    expect(outcome).toMatchObject({ disposition: 'retained-without-send', intent })
    expect(selectFull).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('retains an unstarted prepared successor until its transient predecessor can replay', async () => {
    const predecessor = stagePendingMutation('settings:runtime', intent)
    await dispatchDurableMutation(
      predecessor,
      intent,
      wrappedDispatch(async () => ({ status: 'error', error: 'offline' })),
    )
    const successorIntent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxResponse: 1_000 } } }],
    }
    const fullIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        { method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000, maxResponse: 1_000 } } },
      ],
    }
    const successor = stagePendingMutation('settings:runtime', successorIntent)
    const request = vi.fn(async () => acceptedResult())
    const selectFull = vi.fn()
    commandApi.inlineReplay.mockResolvedValueOnce({ status: 'error', error: 'still offline' })

    const retained = await executePreparedDurableMutationWithinQueue(
      {
        handle: successor,
        intent: successorIntent,
        standaloneIntent: fullIntent,
        onStandaloneIntent: selectFull,
      },
      request,
    )

    expect(retained).toMatchObject({ disposition: 'retained-without-send', intent: fullIntent })
    expect(selectFull).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([
      predecessor.mutationId,
      retained.handle.mutationId,
    ])

    commandApi.inlineReplay.mockResolvedValueOnce({ status: 'ok' })
    const retried = await executePreparedDurableMutationWithinQueue(
      { handle: retained.handle, intent: successorIntent, standaloneIntent: fullIntent },
      request,
    )

    expect(retried).toMatchObject({ disposition: 'sent', intent: fullIntent })
    expect(request).toHaveBeenCalledOnce()
    expect(await listPendingMutations()).toEqual([])
  })
})

function acceptedResult() {
  return {
    status: 'ok' as const,
    revision: 2,
    event: { type: 'settings.updated', revision: 2, resource: 'settings' },
  }
}

function wrappedDispatch<T>(request: () => Promise<T>) {
  return vi.fn((options: { executionWrapper?: (execute: () => Promise<T>) => Promise<T> }) => {
    return options.executionWrapper ? options.executionWrapper(request) : request()
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
