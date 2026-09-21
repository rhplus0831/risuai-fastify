import { setupChatCommandTests, stubCommandFetch } from './chatCommands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  type ServerCommandResult,
} from './server/commands'
import { createDestructiveRefreshToken } from './server/staleStateGuards'
import { runOptimisticCommandSequence, runOptimisticCommandSequenceAsync } from './chatCommands'

setupChatCommandTests()

describe('runner rejection rollback', () => {
  it('reconciles all successful optimistic sequence steps once through the async wrapper', async () => {
    setCachedServerCommandRevision(70)
    const bases: number[] = []
    const reconciliations: number[][] = []
    setServerCommandSuccessReconciler((_event, events) => {
      reconciliations.push(events.map((event) => event.revision))
    })
    const success = (revision: number): ServerCommandResult => ({
      status: 'ok',
      revision,
      event: { type: 'chat.updated', revision, resource: 'characterRow' },
    })

    const result = await runOptimisticCommandSequenceAsync(
      [
        async (baseRevision) => {
          bases.push(baseRevision)
          return success(baseRevision + 1)
        },
        async (baseRevision) => {
          bases.push(baseRevision)
          return success(baseRevision + 1)
        },
      ],
      vi.fn(),
    )

    expect(result).toBeNull()
    expect(bases).toEqual([70, 71])
    expect(reconciliations).toEqual([[71, 72]])
  })

  it('skips sequence rollback when a destructive refresh lands before failure', async () => {
    stubCommandFetch()
    const rollback = vi.fn()
    const command = vi.fn(async () => {
      createDestructiveRefreshToken('test-sequence-full-resync')
      return { status: 'error' as const, error: 'forced failure' }
    })

    runOptimisticCommandSequence([command], rollback)

    await vi.waitFor(() => {
      expect(command).toHaveBeenCalledTimes(1)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('skips async sequence rollback when a destructive refresh lands before failure', async () => {
    stubCommandFetch()
    const rollback = vi.fn()

    const result = await runOptimisticCommandSequenceAsync(
      [
        async () => {
          createDestructiveRefreshToken('test-async-sequence-full-resync')
          return { status: 'error' as const, error: 'forced failure' }
        },
      ],
      rollback,
    )

    expect(result).toEqual({ status: 'error', error: 'forced failure' })
    expect(rollback).not.toHaveBeenCalled()
  })

  it('a rejecting factory in runOptimisticCommandSequence rolls back instead of silently diverging', async () => {
    stubCommandFetch()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollback = vi.fn()

    runOptimisticCommandSequence(
      [
        async () => {
          throw new Error('sequence factory exploded')
        },
      ],
      rollback,
    )

    await vi.waitFor(() => {
      expect(rollback).toHaveBeenCalledTimes(1)
    })
    consoleError.mockRestore()
  })

  it('a mid-sequence rejection rolls back once and skips the remaining commands', async () => {
    setCachedServerCommandRevision(10)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollback = vi.fn()
    const reconciliations: number[][] = []
    setServerCommandSuccessReconciler((_event, events) => {
      reconciliations.push(events.map((event) => event.revision))
    })
    const acceptedCommand = vi.fn(
      async (baseRevision: number): Promise<ServerCommandResult> => ({
        status: 'ok',
        revision: baseRevision + 1,
        event: { type: 'chat.updated', revision: baseRevision + 1, resource: 'characterRow' },
      }),
    )
    const rejectingCommand = vi.fn(async (_baseRevision: number): Promise<ServerCommandResult> => {
      throw new Error('second factory exploded')
    })
    const laterCommand = vi.fn(async (): Promise<ServerCommandResult> => ({ status: 'unavailable' }))

    try {
      await expect(
        runOptimisticCommandSequenceAsync([acceptedCommand, rejectingCommand, laterCommand], rollback),
      ).resolves.toMatchObject({ status: 'error', error: expect.stringContaining('second factory exploded') })

      expect(acceptedCommand).toHaveBeenCalledExactlyOnceWith(10)
      expect(rejectingCommand).toHaveBeenCalledExactlyOnceWith(11)
      expect(rollback).toHaveBeenCalledOnce()
      expect(laterCommand).not.toHaveBeenCalled()
      expect(reconciliations).toEqual([[11]])
    } finally {
      consoleError.mockRestore()
    }
  })
})
