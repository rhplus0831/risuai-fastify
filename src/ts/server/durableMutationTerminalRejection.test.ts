import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../platform', () => ({ isFastifyServer: true }))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'test-auth-token',
}))

const recoveryApi = vi.hoisted(() => ({ scheduleReload: vi.fn() }))
const activeWriterApi = vi.hoisted(() => ({ handleStale: vi.fn() }))
const discardAlertApi = vi.hoisted(() => ({ alertError: vi.fn() }))
vi.mock('./activeWriterSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./activeWriterSession')>()),
  activeWriterSessionHeader: () => ({}),
  handleActiveWriterStaleResponse: activeWriterApi.handleStale,
  isWriterAccessLost: () => false,
  schedulePendingMutationRecoveryReload: recoveryApi.scheduleReload,
  scheduleServerOwnershipReload: vi.fn(),
}))
vi.mock('../alert', () => ({ alertError: discardAlertApi.alertError }))

import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  deletePromptItemCommand,
  patchRuntimeSettings,
  runServerCommand,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
} from './commands'
import { dispatchDurableMutation, setPendingMutationDiscardNotifier } from './durableMutationDispatch'
import {
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
  setPendingMutationCommitTransactionHookForTests,
  type DurableMutationIntent,
} from './pendingMutationOutbox'
import { replayPendingMutations } from './pendingMutationReplay'
import { language } from '../../lang'

const databaseLineage = 'database-terminal-rejection'

beforeEach(async () => {
  recoveryApi.scheduleReload.mockReset()
  discardAlertApi.alertError.mockReset()
  activeWriterApi.handleStale.mockReset()
  activeWriterApi.handleStale.mockImplementation(
    (response: Response, body: unknown) =>
      response.status === 423 &&
      !!body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.keys(body as Record<string, unknown>).length === 1 &&
      (body as { error?: unknown }).error === 'active_writer_stale',
  )
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  clearAppliedServerResourceRevision()
  clearCachedServerCommandRevision()
  setServerCommandSuccessReconciler(null)
  setPendingMutationDiscardNotifier((key, error) => {
    discardAlertApi.alertError(
      `${language.pendingMutationDiscarded}\n\n${language.pendingMutationDiscardedDetail(key, error)}`,
    )
  })
  await preparePendingMutationOutbox({
    writerSessionId: 'writer-terminal-rejection',
    writerEpoch: 1,
    databaseLineage,
    requestedWriterWasActive: true,
  })
})

afterEach(async () => {
  setPendingMutationDiscardNotifier(null)
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  clearAppliedServerResourceRevision()
  clearCachedServerCommandRevision()
  setServerCommandSuccessReconciler(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('durable mutation terminal request rejection', () => {
  it.each(['dispatch-marker', 'terminal-delete', 'accepted-delete'] as const)(
    'retains a predecessor and blocks its successor when %s storage fails',
    async (failure) => {
      const intent = (value: number): DurableMutationIntent => ({
        version: 1,
        requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: value } } }],
      })
      const predecessor = stagePendingMutation('settings:runtime', intent(4000))
      await predecessor.ready
      const successor = stagePendingMutation('settings:runtime', intent(8000))
      await successor.ready
      const calls: string[] = []
      setCachedServerCommandRevision(10)
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          if (String(input).endsWith('/mutation-receipts/ack')) return jsonResponse({ acknowledged: 1, requested: 1 })
          const id = new Headers(init.headers).get('risu-mutation-id')!
          calls.push(id)
          if (failure === 'terminal-delete' && id === predecessor.mutationId)
            return jsonResponse({ error: 'Invalid edit' }, 400)
          const revision = 10 + calls.length
          return jsonResponse({ revision, event: { revision, type: 'settings.updated', resource: 'settings' } })
        }),
      )
      const put = IDBObjectStore.prototype.put
      const remove = IDBObjectStore.prototype.delete
      let failed = false
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, key) {
        if (
          !failed &&
          failure === 'dispatch-marker' &&
          value?.mutationId === predecessor.mutationId &&
          value.dispatchStarted
        ) {
          failed = true
          this.transaction.abort()
          throw new DOMException('Injected dispatch marker failure', 'QuotaExceededError')
        }
        return put.call(this, value, key)
      })
      vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (key) {
        if (!failed && failure.endsWith('delete') && key === predecessor.mutationId) {
          failed = true
          throw new DOMException('Injected terminal cleanup failure', 'QuotaExceededError')
        }
        return remove.call(this, key)
      })
      await expect(replayPendingMutations()).resolves.toEqual({ attempted: 1, succeeded: 0, discarded: 0, retained: 2 })
      expect(failed).toBe(true)
      expect(calls).toEqual(failure === 'dispatch-marker' ? [] : [predecessor.mutationId])
      expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([
        predecessor.mutationId,
        successor.mutationId,
      ])
      calls.length = 0
      await expect(replayPendingMutations()).resolves.toMatchObject({ retained: 0, attempted: 2 })
      expect(calls).toEqual([predecessor.mutationId, successor.mutationId])
      expect(await listPendingMutations()).toEqual([])
      await expect(replayPendingMutations()).resolves.toEqual({ attempted: 0, succeeded: 0, discarded: 0, retained: 0 })
    },
  )

  it('does not send an unstaged replacement ahead of its surviving durable predecessor', async () => {
    const older: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 4000 } } }],
    }
    const newer: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8000 } } }],
    }
    const predecessor = stagePendingMutation('settings:runtime', older)
    await predecessor.ready
    setPendingMutationCommitTransactionHookForTests((transaction) => transaction.abort())
    const successor = stagePendingMutation('settings:runtime', newer, predecessor)
    await expect(successor.ready).resolves.toBe('unavailable')
    setPendingMutationCommitTransactionHookForTests(null)
    const send = vi.fn(async () => ({
      status: 'ok' as const,
      revision: 11,
      event: { type: 'settings.updated', resource: 'settings', revision: 11 },
    }))
    await expect(dispatchDurableMutation(successor, newer, wrappedDispatch(send))).resolves.toEqual({
      status: 'unavailable',
    })
    expect(send).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([older])
  })

  it('rolls back a live HTTP 400 and removes its exact outbox generation', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: -1 } } }],
    }
    const handle = stagePendingMutation('settings:runtime', intent)
    const rollback = vi.fn()
    setCachedServerCommandRevision(10)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'maxContext must be positive' }, 400)) as unknown as typeof fetch,
    )

    const result = await dispatchDurableMutation(handle, intent, (options) =>
      runServerCommand({
        ...options,
        rollback,
        command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: -1 } }),
      }),
    )

    expect(result).toEqual({
      status: 'error',
      error: 'maxContext must be positive',
      reason: 'invalid-request',
    })
    expect(rollback).toHaveBeenCalledOnce()
    expect(await listPendingMutations()).toEqual([])
    expect(discardAlertApi.alertError).toHaveBeenCalledWith(
      `${language.pendingMutationDiscarded}\n\n${language.pendingMutationDiscardedDetail(
        'settings:runtime',
        'maxContext must be positive',
      )}`,
    )
  })

  it.each([
    { status: 400, error: 'Bad Request' },
    { status: 404, error: 'Not Found' },
    { status: 423, error: 'Locked' },
  ])('explicitly reports and disposes an unrecognized HTTP $status envelope', async ({ status, error }) => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 12_000 } } }],
    }
    const handle = stagePendingMutation('settings:runtime', intent)
    const rollback = vi.fn()
    setCachedServerCommandRevision(10)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ statusCode: status, error, message: 'non-command response' }, status),
      ) as unknown as typeof fetch,
    )

    const result = await dispatchDurableMutation(handle, intent, (options) =>
      runServerCommand({
        ...options,
        rollback,
        command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 12_000 } }),
      }),
    )

    expect(result).toEqual({ status: 'error', error, reason: 'unrecognized-rejection' })
    expect(rollback).toHaveBeenCalledOnce()
    expect(await listPendingMutations()).toEqual([])
    expect(discardAlertApi.alertError).toHaveBeenCalledWith(
      `${language.pendingMutationDiscarded}\n\n${language.pendingMutationDiscardedDetail('settings:runtime', error)}`,
    )
  })

  it('retains a genuine stale-writer intent and replays it after the same session reclaims a new epoch', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 12_000 } } }],
    }
    const handle = stagePendingMutation('settings:runtime', intent)
    const rollback = vi.fn()
    setCachedServerCommandRevision(10)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'active_writer_stale' }, 423)) as unknown as typeof fetch,
    )

    await expect(
      dispatchDurableMutation(handle, intent, (options) =>
        runServerCommand({
          ...options,
          rollback,
          command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 12_000 } }),
        }),
      ),
    ).resolves.toEqual({ status: 'error', error: 'active_writer_stale', reason: 'stale-writer' })
    expect(rollback).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([handle.mutationId])

    resetPendingMutationOutboxForTests()
    await expect(
      preparePendingMutationOutbox({
        writerSessionId: 'writer-terminal-rejection',
        writerEpoch: 2,
        databaseLineage,
        requestedWriterWasActive: false,
      }),
    ).resolves.toEqual({ discarded: 0 })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/v1/commands/mutation-receipts/ack') {
          return jsonResponse({ acknowledged: 1, requested: 1 })
        }
        return jsonResponse({
          revision: 11,
          event: { type: 'settings.updated', revision: 11, resource: 'settings', id: 'runtime' },
          acknowledgedKeys: ['maxContext'],
          settings: {},
        })
      }) as unknown as typeof fetch,
    )

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 1,
      discarded: 0,
      retained: 0,
      succeeded: 1,
    })
    expect(await listPendingMutations()).toEqual([])
    expect(discardAlertApi.alertError).not.toHaveBeenCalled()
  })

  it('keeps the optimistic projection with a persisted row after a retryable live failure', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 12_000 } } }],
    }
    const handle = stagePendingMutation('settings:runtime', intent)
    const rollback = vi.fn()
    setCachedServerCommandRevision(10)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'temporarily unavailable' }, 500)) as unknown as typeof fetch,
    )

    const result = await dispatchDurableMutation(handle, intent, (options) =>
      runServerCommand({
        ...options,
        rollback,
        command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 12_000 } }),
      }),
    )

    expect(result).toEqual({ status: 'error', error: 'temporarily unavailable' })
    expect(rollback).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([handle.mutationId])
  })

  it('rolls back a retryable failure when durable browser staging was unavailable', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 12_000 } } }],
    }
    const handle = {
      key: 'settings:runtime',
      mutationId: 'unavailable-staging',
      sequence: 1,
      ownerWriterSessionId: 'writer-terminal-rejection',
      writerEpoch: 1,
      databaseLineage,
      phase: 'staged' as const,
      ready: Promise.resolve('unavailable' as const),
    }
    const rollback = vi.fn()
    setCachedServerCommandRevision(10)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'temporarily unavailable' }, 500)) as unknown as typeof fetch,
    )

    const result = await dispatchDurableMutation(handle, intent, (options) =>
      runServerCommand({
        ...options,
        rollback,
        command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 12_000 } }),
      }),
    )

    expect(result).toEqual({ status: 'error', error: 'temporarily unavailable' })
    expect(rollback).toHaveBeenCalledOnce()
    expect(await listPendingMutations()).toEqual([])
  })

  it('keeps a persisted projection when its durable lock rejects before transport', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 12_000 } } }],
    }
    const handle = stagePendingMutation('settings:runtime', intent)
    await expect(handle.ready).resolves.toBe('persisted')
    const rollback = vi.fn()
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(async () => {
          throw new Error('lock manager unavailable')
        }),
      },
    })

    await expect(
      dispatchDurableMutation(handle, intent, (options) =>
        runServerCommand({
          ...options,
          rollback,
          command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 12_000 } }),
        }),
      ),
    ).rejects.toThrow('lock manager unavailable')

    expect(rollback).not.toHaveBeenCalled()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([handle.mutationId])
  })

  it('discards an orphaned HTTP 404 during bootstrap replay', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-items/missing-row',
          body: { promptPresetId: 'missing-preset', patch: { text: 'orphaned edit' } },
        },
      ],
    }
    const handle = stagePendingMutation('prompt-template-owner:missing-preset', intent)
    await handle.ready
    setCachedServerCommandRevision(20)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'Prompt preset not found: missing-preset' }, 404),
      ) as unknown as typeof fetch,
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(replayPendingMutations()).resolves.toEqual({
      attempted: 1,
      discarded: 1,
      retained: 0,
      succeeded: 0,
    })
    expect(await listPendingMutations()).toEqual([])
    expect(warning).toHaveBeenCalledWith(
      'Pending server mutation was discarded for prompt-template-owner:missing-preset',
      expect.objectContaining({
        status: 'error',
        reason: 'not-found',
      }),
    )
  })

  it('discards an invalid predecessor and defers its prompt-item DELETE successor until recovery', async () => {
    const ownerKey = 'prompt-template-owner:preset-a'
    const patchIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-items/row-a',
          body: { promptPresetId: 'preset-a', patch: { text: 'invalid predecessor' } },
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
    const predecessor = stagePendingMutation(ownerKey, patchIntent)
    await dispatchDurableMutation(
      predecessor,
      patchIntent,
      wrappedDispatch(async () => ({ status: 'error', error: 'response stream ended' })),
    )
    const successor = stagePendingMutation(ownerKey, deleteIntent, predecessor)
    setCachedServerCommandRevision(30)

    const calls: Array<{ method: string; mutationId: string | null; url: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const headers = init.headers as Record<string, string> | undefined
        calls.push({
          method: init.method ?? 'GET',
          mutationId: headers?.['risu-mutation-id'] ?? null,
          url,
        })
        if (url === '/api/v1/commands/mutation-receipts/ack') {
          return jsonResponse({ acknowledged: 1, requested: 1 })
        }
        if (url.endsWith('/prompt-items/row-a') && init.method === 'PATCH') {
          return jsonResponse({ error: 'Prompt item patch is no longer valid' }, 400)
        }
        return jsonResponse({
          revision: 31,
          event: {
            type: 'prompt.item.deleted',
            revision: 31,
            resource: 'promptItem',
            id: 'row-a',
            parentId: 'preset-a',
          },
          itemId: 'row-a',
        })
      }) as unknown as typeof fetch,
    )

    const result = await dispatchDurableMutation(successor, deleteIntent, (options) =>
      runServerCommand({
        ...options,
        command: (baseRevision) =>
          deletePromptItemCommand({
            baseRevision,
            promptPresetId: 'preset-a',
            itemId: 'row-a',
          }),
      }),
    )

    expect(result).toEqual({ status: 'unavailable' })
    expect(calls).toEqual([
      {
        method: 'PATCH',
        mutationId: predecessor.mutationId,
        url: '/api/v1/commands/prompt-items/row-a',
      },
    ])
    expect(recoveryApi.scheduleReload).toHaveBeenCalledOnce()
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([successor.mutationId])
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function wrappedDispatch(
  request: () => Promise<ServerCommandResult>,
): (options: ServerCommandTransportOptions) => Promise<ServerCommandResult> {
  return (options) => (options.executionWrapper ? options.executionWrapper(request) : request())
}
