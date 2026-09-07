import {
  resetClientSessionForTests,
  beginClientSession,
  authorizeClientWriterRecovery,
  setClientConnectionState,
} from '../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const outboxApi = vi.hoisted(() => ({ list: vi.fn() }))
const durableApi = vi.hoisted(() => ({ replay: vi.fn() }))
const generationOperationApi = vi.hoisted(() => ({ replay: vi.fn() }))

vi.mock('./pendingMutationOutbox', () => ({
  isGenerationOperationPendingIntent: (intent: { kind?: string }) => intent.kind?.startsWith('generation-operation-'),
  listPendingMutations: outboxApi.list,
}))
vi.mock('./durableMutationDispatch', () => ({
  dispatchDurableMutationReplay: durableApi.replay,
}))
vi.mock('./generationOperations', () => ({
  dispatchGenerationOperationPendingReplay: generationOperationApi.replay,
}))

import { replayPendingMutations } from './pendingMutationReplay'

beforeEach(() => {
  resetClientSessionForTests()
  vi.clearAllMocks()
  durableApi.replay.mockResolvedValue({ disposition: 'succeeded', result: { status: 'ok' } })
  generationOperationApi.replay.mockResolvedValue({ disposition: 'succeeded', result: { status: 'accepted' } })
})

describe('pending mutation replay', () => {
  it('replays entries serially and retains only transient failures', async () => {
    const entries = [entry('settings:runtime', 'mutation-a'), entry('chat:chat-a', 'mutation-b')]
    outboxApi.list.mockResolvedValue(entries)
    const order: string[] = []
    let releaseFirst!: () => void
    const firstDispatch = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    durableApi.replay.mockImplementation(async (handle) => {
      order.push(handle.mutationId)
      if (handle.mutationId === 'mutation-a') await firstDispatch
      return handle.mutationId === 'mutation-a'
        ? { disposition: 'succeeded', result: { status: 'ok' } }
        : { disposition: 'retained', result: { status: 'error', error: 'offline' } }
    })

    const replay = replayPendingMutations()
    await vi.waitFor(() => expect(order).toEqual(['mutation-a']))
    releaseFirst()
    const summary = await replay

    expect(order).toEqual(['mutation-a', 'mutation-b'])
    expect(summary).toEqual({ attempted: 2, discarded: 0, retained: 1, succeeded: 1 })
  })

  it('preserves committed outbox order when cross-tab wall-clock sequences disagree', async () => {
    const committedFirst = entry('settings:runtime', 'committed-first')
    committedFirst.handle.sequence = 9_000
    const committedSecond = entry('chat:chat-a', 'committed-second')
    committedSecond.handle.sequence = 1
    outboxApi.list.mockResolvedValue([committedFirst, committedSecond])

    await replayPendingMutations()

    expect(durableApi.replay.mock.calls.map(([handle]) => handle.mutationId)).toEqual([
      'committed-first',
      'committed-second',
    ])
  })

  it('routes atomic submit intents back to the generation-operation endpoint', async () => {
    const operationEntry: any = entry('generation-operation-submit:operation-a', 'mutation-operation-a')
    operationEntry.intent.kind = 'generation-operation-submit'
    operationEntry.intent.requests = [
      { method: 'POST', path: '/generation-operations', body: { operationId: 'operation-a' } },
    ]
    outboxApi.list.mockResolvedValue([operationEntry])

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 1,
      discarded: 0,
      retained: 0,
      succeeded: 1,
    })
    expect(generationOperationApi.replay).toHaveBeenCalledWith(operationEntry.handle, operationEntry.intent)
    expect(durableApi.replay).not.toHaveBeenCalled()
  })

  it('replays a persisted Stop before its older submit for cancel-before-POST recovery', async () => {
    const submit: any = entry('generation-operation-submit:operation-a', 'submit-a')
    submit.handle.sequence = 1
    submit.intent.kind = 'generation-operation-submit'
    submit.intent.requests = [{ method: 'POST', path: '/generation-operations', body: { operationId: 'operation-a' } }]
    const cancel: any = entry('generation-operation-cancel:operation-a', 'cancel-a')
    cancel.handle.sequence = 2
    cancel.intent.kind = 'generation-operation-cancel'
    cancel.intent.requests = [
      {
        method: 'PUT',
        path: '/generation-operations/operation-a/cancellation',
        body: { reason: 'user_stop' },
      },
    ]
    outboxApi.list.mockResolvedValue([submit, cancel])

    await replayPendingMutations()

    expect(generationOperationApi.replay.mock.calls.map(([handle]) => handle.mutationId)).toEqual([
      'cancel-a',
      'submit-a',
    ])
  })

  it('reports an unacknowledged Stop as a nonblocking retained control', async () => {
    const cancel: any = entry('generation-operation-cancel:operation-a', 'cancel-a')
    cancel.intent.kind = 'generation-operation-cancel'
    cancel.intent.requests = [
      {
        method: 'PUT',
        path: '/generation-operations/operation-a/cancellation',
        body: { reason: 'user_stop' },
      },
    ]
    outboxApi.list.mockResolvedValue([cancel])
    generationOperationApi.replay.mockResolvedValue({
      disposition: 'retained',
      result: { status: 'failed', error: 'offline' },
    })

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 1,
      controlRetained: 1,
      discarded: 0,
      retained: 0,
      succeeded: 0,
    })
  })

  it('counts terminal mutation-id failures as discarded instead of retrying forever', async () => {
    outboxApi.list.mockResolvedValue([entry('settings:runtime', 'conflict-a')])
    durableApi.replay.mockResolvedValue({
      disposition: 'discarded',
      result: { status: 'error', error: 'mutation_id_conflict', reason: 'mutation-id-conflict' },
    })

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 1,
      discarded: 1,
      retained: 0,
      succeeded: 0,
    })
  })

  it('blocks only later rows for a semantic key when its oldest replay remains transient', async () => {
    outboxApi.list.mockResolvedValue([
      entry('settings:runtime', 'mutation-a'),
      entry('settings:runtime', 'mutation-b'),
      entry('chat:chat-a', 'mutation-c'),
    ])
    durableApi.replay.mockImplementation(async (handle) =>
      handle.mutationId === 'mutation-a'
        ? { disposition: 'retained', result: { status: 'error', error: 'offline' } }
        : { disposition: 'succeeded', result: { status: 'ok' } },
    )

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 2,
      discarded: 0,
      retained: 2,
      succeeded: 1,
    })
    expect(durableApi.replay.mock.calls.map(([handle]) => handle.mutationId)).toEqual(['mutation-a', 'mutation-c'])
  })

  it('keeps a prompt successor blocked until a later replay drains its owner repair', async () => {
    const entries = [
      entry('prompt-template-owner:preset-a', 'id-repair', '/prompt-presets/preset-a'),
      entry('prompt-template-owner:preset-a', 'row-successor', '/prompt-items/row-a'),
    ]
    outboxApi.list.mockResolvedValue(entries)
    durableApi.replay.mockImplementation(async (handle) =>
      handle.mutationId === 'id-repair'
        ? { disposition: 'retained', result: { status: 'error', error: 'offline' } }
        : { disposition: 'succeeded', result: { status: 'ok' } },
    )

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 1,
      discarded: 0,
      retained: 2,
      succeeded: 0,
    })
    expect(durableApi.replay.mock.calls.map(([handle]) => handle.mutationId)).toEqual(['id-repair'])

    durableApi.replay.mockClear()
    durableApi.replay.mockResolvedValue({ disposition: 'succeeded', result: { status: 'ok' } })

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 2,
      discarded: 0,
      retained: 0,
      succeeded: 2,
    })
    expect(durableApi.replay.mock.calls.map(([handle]) => handle.mutationId)).toEqual(['id-repair', 'row-successor'])
  })

  it('propagates a retained dependency into the successor selection lane', async () => {
    outboxApi.list.mockResolvedValue([
      entry('character-owner:char-b', 'patch-b'),
      entry('character-selection', 'select-b', '/characters/select', ['character-owner:char-b']),
      entry('character-selection', 'select-c', '/characters/select'),
      entry('settings:runtime', 'unrelated'),
    ])
    durableApi.replay.mockImplementation(async (handle) =>
      handle.mutationId === 'patch-b'
        ? { disposition: 'retained', result: { status: 'error', error: 'offline' } }
        : { disposition: 'succeeded', result: { status: 'ok' } },
    )

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 2,
      discarded: 0,
      retained: 3,
      succeeded: 1,
    })
    expect(durableApi.replay.mock.calls.map(([handle]) => handle.mutationId)).toEqual(['patch-b', 'unrelated'])
  })

  it('allows a dependent successor after its terminal predecessor is discarded', async () => {
    outboxApi.list.mockResolvedValue([
      entry('character-owner:char-b', 'orphaned-patch'),
      entry('character-selection', 'select-b', '/characters/select', ['character-owner:char-b']),
    ])
    durableApi.replay.mockImplementation(async (handle) =>
      handle.mutationId === 'orphaned-patch'
        ? {
            disposition: 'discarded',
            result: { status: 'error', error: 'character not found', reason: 'not-found' },
          }
        : { disposition: 'succeeded', result: { status: 'ok' } },
    )

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 2,
      discarded: 1,
      retained: 0,
      succeeded: 1,
    })
    expect(durableApi.replay.mock.calls.map(([handle]) => handle.mutationId)).toEqual(['orphaned-patch', 'select-b'])
  })
})

function entry(key: string, mutationId: string, path = '/settings/runtime', dependencyKeys?: string[]) {
  return {
    handle: {
      key,
      mutationId,
      sequence: 1,
      ownerWriterSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      phase: 'staged',
      ready: Promise.resolve('persisted'),
    },
    intent: {
      version: 1,
      requests: [{ method: 'PATCH', path, body: { patch: { maxContext: 8_000 } } }],
      ...(dependencyKeys ? { dependencyKeys } : {}),
    },
  }
}

describe('replay session continuation guards', () => {
  it('does not inspect or replay pending rows in a reader', async () => {
    setManagedReaderForTest()
    await expect(replayPendingMutations()).resolves.toEqual({ attempted: 0, discarded: 0, retained: 0, succeeded: 0 })
    expect(outboxApi.list).not.toHaveBeenCalled()
    expect(durableApi.replay).not.toHaveBeenCalled()
    expect(generationOperationApi.replay).not.toHaveBeenCalled()
  })

  it('admits explicit authenticated writer recovery before ordinary writing is enabled', async () => {
    const operation = beginClientSession('recovery-writer')
    authorizeClientWriterRecovery(operation, {
      databaseLineage: 'database-a',
      writer: { sessionId: 'recovery-writer', epoch: 1 },
    })
    setClientConnectionState('live')
    outboxApi.list.mockResolvedValue([entry('settings:runtime', 'recovered')])
    await expect(replayPendingMutations()).resolves.toEqual({ attempted: 1, discarded: 0, retained: 0, succeeded: 1 })
    expect(durableApi.replay).toHaveBeenCalledOnce()
  })

  it('does not revive a held list after demotion and repromotion', async () => {
    setManagedWriterForTest()
    let release!: (entries: unknown[]) => void
    outboxApi.list.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = replayPendingMutations()
    demoteAndRepromoteForTest()
    release([entry('settings:runtime', 'parked')])
    await expect(pending).resolves.toEqual({ attempted: 0, discarded: 0, retained: 1, succeeded: 0 })
    expect(durableApi.replay).not.toHaveBeenCalled()
  })

  it('settles an already-dispatched acceptance but never starts the next old replay entry', async () => {
    setManagedWriterForTest()
    outboxApi.list.mockResolvedValue([entry('settings:first', 'accepted'), entry('settings:next', 'parked')])
    let release!: (result: unknown) => void
    durableApi.replay.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = replayPendingMutations()
    await vi.waitFor(() => expect(durableApi.replay).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release({ disposition: 'succeeded', result: { status: 'ok' } })
    await expect(pending).resolves.toEqual({ attempted: 1, discarded: 0, retained: 1, succeeded: 1 })
    expect(durableApi.replay).toHaveBeenCalledOnce()
  })
})
