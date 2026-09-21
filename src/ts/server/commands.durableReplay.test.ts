import { jsonResponse } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { scheduleServerOwnershipReload } from './activeWriterSession'
import {
  acknowledgeServerMutationReceipts,
  patchRuntimeSettings,
  peekCachedServerCommandRevision,
  runServerCommandWithoutMutationReceipt,
  runServerCommandWithMutationReceipt,
  replayDurableMutationRequests,
  replayDurableMutationRequestsInline,
  runServerCommand,
  setCachedServerCommandRevision,
} from './commands'

// The adapter requests ownership recovery; the UI notification and reload lifecycle
// belong to the writer-session suites and must not outlive this transport test.
vi.mock('./activeWriterSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./activeWriterSession')>()),
  scheduleServerOwnershipReload: vi.fn(),
}))

describe('durable command replay and receipts', () => {
  it('uses stable per-request mutation ids for a durable multi-command replay', async () => {
    const calls: Array<{ body: Record<string, unknown>; databaseLineage: string | null; mutationId: string | null }> =
      []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string>
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        calls.push({
          body,
          databaseLineage: headers['risu-database-lineage'] ?? null,
          mutationId: headers['risu-mutation-id'] ?? null,
        })
        const revision = 21 + calls.length
        return jsonResponse({
          revision,
          event: {
            type: calls.length === 1 ? 'settings.updated' : 'character.updated',
            revision,
            resource: calls.length === 1 ? 'settings' : 'characterRow',
          },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(21)

    const result = await replayDurableMutationRequests(
      [
        { method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000 } } },
        { method: 'PATCH', path: '/characters/char-a', body: { patch: { name: 'Recovered name' } } },
      ],
      'pending-replay-a',
      'database-a',
    )

    expect(result).toEqual({ status: 'ok' })
    expect(calls).toEqual([
      {
        body: { baseRevision: 21, patch: { maxContext: 8_000 } },
        databaseLineage: 'database-a',
        mutationId: 'pending-replay-a',
      },
      {
        body: { baseRevision: 22, patch: { name: 'Recovered name' } },
        databaseLineage: 'database-a',
        mutationId: 'pending-replay-a.1',
      },
    ])
  })

  it('replays a predecessor inline before its queued successor without losing either receipt context', async () => {
    const calls: Array<{ body: Record<string, unknown>; mutationId: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string>
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        calls.push({ body, mutationId: headers['risu-mutation-id'] ?? null })
        const revision = 21 + calls.length
        return jsonResponse({
          revision,
          event: { type: 'settings.updated', revision, resource: 'settings' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(21)

    const result = await runServerCommand({
      mutationId: 'successor-b',
      databaseLineage: 'database-a',
      executionWrapper: async (execute) => {
        await expect(
          replayDurableMutationRequestsInline(
            [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000 } } }],
            'predecessor-a',
            'database-a',
          ),
        ).resolves.toEqual({ status: 'ok' })
        return execute()
      },
      command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxResponse: 1_000 } }),
    })

    expect(result).toMatchObject({ status: 'ok', revision: 23 })
    expect(calls).toEqual([
      {
        body: { baseRevision: 21, patch: { maxContext: 8_000 } },
        mutationId: 'predecessor-a',
      },
      {
        body: { baseRevision: 22, patch: { maxResponse: 1_000 } },
        mutationId: 'successor-b',
      },
    ])
  })

  it('suppresses durable receipt headers when browser persistence is unavailable', async () => {
    let capturedHeaders: Record<string, string> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        capturedHeaders = init.headers as Record<string, string>
        return jsonResponse({
          revision: 22,
          event: { type: 'settings.updated', revision: 22, resource: 'settings' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(21)

    await expect(
      runServerCommand({
        mutationId: 'unavailable-browser-storage',
        databaseLineage: 'database-a',
        executionWrapper: (execute) => runServerCommandWithoutMutationReceipt(execute),
        command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 7_000 } }),
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 22 })

    expect(capturedHeaders?.['risu-mutation-id']).toBeUndefined()
    expect(capturedHeaders?.['risu-database-lineage']).toBeUndefined()
  })

  it('restores the reserved receipt context when an exact context throws', async () => {
    let capturedHeaders: Record<string, string> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        capturedHeaders = init.headers as Record<string, string>
        return jsonResponse({
          revision: 22,
          event: { type: 'settings.updated', revision: 22, resource: 'settings' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(21)

    await expect(
      runServerCommand({
        mutationId: 'reserved-placeholder',
        databaseLineage: 'database-a',
        executionWrapper: async (execute) => {
          await expect(
            runServerCommandWithMutationReceipt(
              async () => {
                throw new Error('prepared execution failed')
              },
              'exact-successor',
              'database-a',
            ),
          ).rejects.toThrow('prepared execution failed')
          return execute()
        },
        command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 7_000 } }),
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 22 })

    expect(capturedHeaders?.['risu-mutation-id']).toBe('reserved-placeholder')
    expect(capturedHeaders?.['risu-database-lineage']).toBe('database-a')
  })

  it('retries a durable conflict with live revisions while preserving receipt ids', async () => {
    const calls: Array<{ body: Record<string, unknown>; mutationId: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string>
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        calls.push({ body, mutationId: headers['risu-mutation-id'] ?? null })
        if (calls.length === 1 || calls.length === 3) {
          return jsonResponse({
            revision: 31,
            event: { type: 'settings.updated', revision: 31, resource: 'settings' },
          })
        }
        if (calls.length === 2) return jsonResponse({ error: 'revision_conflict', currentRevision: 32 }, 409)
        return jsonResponse({
          revision: 33,
          event: { type: 'character.updated', revision: 33, resource: 'characterRow' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(30)

    const result = await replayDurableMutationRequests(
      [
        { method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 9_000 } } },
        { method: 'PATCH', path: '/characters/char-b', body: { patch: { name: 'Recovered' } } },
      ],
      'pending-replay-conflict',
      'database-a',
    )

    expect(result).toEqual({ status: 'ok' })
    expect(calls.map((call) => call.mutationId)).toEqual([
      'pending-replay-conflict',
      'pending-replay-conflict.1',
      'pending-replay-conflict',
      'pending-replay-conflict.1',
    ])
    expect(calls.map((call) => call.body.baseRevision)).toEqual([30, 31, 32, 32])
    expect(peekCachedServerCommandRevision()).toBe(33)
  })

  it('sends lineage-bound durable receipt acknowledgements', async () => {
    let captured: RequestInit | undefined
    let capturedUrl: string | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        capturedUrl = String(input)
        captured = init
        return jsonResponse({ acknowledged: 1, requested: 1 })
      }) as unknown as typeof fetch,
    )

    await expect(acknowledgeServerMutationReceipts('pending-a', 1, 'database-a')).resolves.toBe(true)

    expect(capturedUrl).toBe('/api/v1/commands/mutation-receipts/ack')
    expect(captured?.method).toBe('POST')
    expect(JSON.parse(String(captured?.body))).toEqual({
      mutationId: 'pending-a',
      requestCount: 1,
      databaseLineage: 'database-a',
    })
    expect(captured?.headers).toEqual(
      expect.objectContaining({
        'content-type': 'application/json',
        'risu-auth': 'test-auth-token',
        'risu-writer-session': 'command-test-writer',
      }),
    )
  })

  it('classifies a database lineage mismatch before generic revision conflict handling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'database_lineage_conflict', databaseLineage: 'database-b' }, 409),
      ) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(2)

    await expect(
      replayDurableMutationRequests(
        [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 9_000 } } }],
        'pending-old-lineage',
        'database-a',
      ),
    ).resolves.toEqual({
      status: 'error',
      error: 'database_lineage_conflict',
      reason: 'database-lineage',
    })
    expect(scheduleServerOwnershipReload).toHaveBeenCalledOnce()
  })
})
