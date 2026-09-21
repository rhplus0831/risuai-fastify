import { createDeferred, jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  patchServerBackedSettings,
  patchRuntimeSettings,
  patchSettingsGroup,
  peekCachedServerCommandRevision,
  runServerCommand,
  runServerCommandSequence,
  updateCharacterCommand,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
  type ServerCommandResult,
} from './commands'
import { captureDestructiveRefreshEpoch, createDestructiveRefreshToken } from './staleStateGuards'

describe('server command queue and rollback', () => {
  it('notifies the command success reconciler before resolving an ok command', async () => {
    const event = {
      type: 'generation.persisted',
      revision: 3,
      resource: 'generation',
      id: 'message-a',
      parentId: 'chat-a',
      databaseLineage: 'database-a',
      operationId: 'operation-a',
      sourceMessageId: 'message-user-a',
      jobId: 'job-a',
      origin: { writerSessionId: 'w1' },
    }
    const commandFetch = makeCommandFetch(() => ({ revision: 3, event }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observed: unknown[] = []

    setServerCommandSuccessReconciler(async (commandEvent) => {
      observed.push(commandEvent)
    })

    const result = await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { theme: 'light' },
    })

    expect(result).toEqual({ status: 'ok', revision: 3, event })
    expect(observed).toEqual([event])
  })

  it('notifies the command success reconciler for custom runServerCommand factories', async () => {
    const event = { type: 'custom.updated', revision: 8, resource: 'asset' }
    const observed: unknown[] = []
    setCachedServerCommandRevision(7)
    setServerCommandSuccessReconciler(async (commandEvent) => {
      observed.push(commandEvent)
    })

    const result = await runServerCommand({
      command: async (baseRevision) => ({
        status: 'ok' as const,
        revision: baseRevision + 1,
        event,
      }),
    })

    expect(result).toEqual({ status: 'ok', revision: 8, event })
    expect(observed).toEqual([event])
  })

  it('serializes independent high-level mutations so each request uses the previously accepted revision', async () => {
    const firstResponse = createDeferred<Response>()
    const calls: Array<{ body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (calls.length === 1) return firstResponse.promise
        return jsonResponse({
          revision: 12,
          event: { type: 'settings.updated', revision: 12, resource: 'settings' },
        })
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(10)

    const first = runServerCommand({
      command: (baseRevision) =>
        patchRuntimeSettings({
          baseRevision,
          patch: { maxContext: 8_000 },
        }),
    })
    const second = patchServerBackedSettings({
      patch: { maxResponse: 1_000 },
    })

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.body).toEqual({
      baseRevision: 10,
      patch: { maxContext: 8_000 },
    })

    firstResponse.resolve(
      jsonResponse({
        revision: 11,
        event: { type: 'settings.updated', revision: 11, resource: 'settings' },
      }),
    )

    await expect(first).resolves.toMatchObject({ status: 'ok', revision: 11 })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]?.body).toEqual({
      baseRevision: 11,
      patch: { maxResponse: 1_000 },
    })
    await expect(second).resolves.toMatchObject({ status: 'ok', revision: 12 })
  })

  it('carries the enqueue-time refresh epoch through a command that waits in the queue', async () => {
    const firstResponse = createDeferred<Response>()
    const secondResponse = createDeferred<Response>()
    const calls: string[] = []
    let observedEffect: ServerCommandLocalEffect | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return calls.length === 1 ? firstResponse.promise : secondResponse.promise
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(10)
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffect = localEffects.get(12)
    })

    const first = runServerCommand({
      command: (baseRevision) =>
        patchRuntimeSettings({
          baseRevision,
          patch: { maxContext: 8_000 },
        }),
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    const queuedEpoch = captureDestructiveRefreshEpoch()
    const second = runServerCommand({
      command: (baseRevision) =>
        updateCharacterCommand({
          baseRevision,
          characterId: 'char-b',
          patch: { name: 'accepted optimistic name' },
        }),
    })
    createDestructiveRefreshToken('queued-character-patch-refresh')

    firstResponse.resolve(
      jsonResponse({
        revision: 11,
        event: { type: 'settings.updated', revision: 11, resource: 'settings' },
      }),
    )
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    secondResponse.resolve(
      jsonResponse({
        revision: 12,
        event: {
          type: 'character.updated',
          revision: 12,
          resource: 'characterRow',
          id: 'char-b',
        },
        characterId: 'char-b',
      }),
    )

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'ok', revision: 11 },
      { status: 'ok', revision: 12 },
    ])
    expect(observedEffect?.destructiveRefreshEpoch).toBe(queuedEpoch)
    expect(observedEffect?.destructiveRefreshEpoch).not.toBe(captureDestructiveRefreshEpoch())
  })

  it('starts a queued transport before reconciling the older command and never restores its older optimistic value', async () => {
    const firstResponse = createDeferred<Response>()
    const secondResponse = createDeferred<Response>()
    const reconcileRelease = createDeferred<void>()
    const calls: Array<{ body: unknown }> = []
    const reconciled: Array<{ revision: number; coalescedRevisions: number[] }> = []
    let visibleValue = 'first optimistic value'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        return calls.length === 1 ? firstResponse.promise : secondResponse.promise
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(10)
    setServerCommandSuccessReconciler(async (event, coalescedEvents) => {
      reconciled.push({
        revision: event.revision,
        coalescedRevisions: coalescedEvents.map((coalescedEvent) => coalescedEvent.revision),
      })
      await reconcileRelease.promise
      visibleValue = event.revision === 11 ? 'first server value' : 'second optimistic value'
    })

    const first = runServerCommand({
      command: (baseRevision) =>
        patchRuntimeSettings({
          baseRevision,
          patch: { maxContext: 8_000 },
        }),
    })
    visibleValue = 'second optimistic value'
    const second = patchServerBackedSettings({
      patch: { maxResponse: 1_000 },
    })
    let commandsSettled = false
    const commands = Promise.all([first, second]).then((results) => {
      commandsSettled = true
      return results
    })

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    firstResponse.resolve(
      jsonResponse({
        revision: 11,
        event: { type: 'settings.updated', revision: 11, resource: 'settings' },
      }),
    )

    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]?.body).toEqual({
      baseRevision: 11,
      patch: { maxResponse: 1_000 },
    })
    expect(reconciled).toEqual([])
    expect(visibleValue).toBe('second optimistic value')

    secondResponse.resolve(
      jsonResponse({
        revision: 12,
        event: { type: 'settings.updated', revision: 12, resource: 'settings' },
      }),
    )

    await vi.waitFor(() => expect(reconciled).toEqual([{ revision: 12, coalescedRevisions: [11, 12] }]))
    expect(commandsSettled).toBe(false)
    expect(visibleValue).toBe('second optimistic value')
    reconcileRelease.resolve()

    await expect(commands).resolves.toEqual([
      expect.objectContaining({ status: 'ok', revision: 11 }),
      expect.objectContaining({ status: 'ok', revision: 12 }),
    ])
    expect(reconciled).toEqual([{ revision: 12, coalescedRevisions: [11, 12] }])
    expect(visibleValue).toBe('second optimistic value')
  })

  it('runs a multi-step sequence with advancing revisions and one coalesced local-effect reconciliation', async () => {
    const attempts = [{ maxContext: 8_000 }, { maxResponse: 1_000 }]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => {
      const patch = attempts[responseIndex]
      const revision = 11 + responseIndex
      responseIndex += 1
      return {
        revision,
        event: {
          type: 'settings.updated',
          revision,
          resource: 'settings',
          id: 'runtime',
        },
        acknowledgedKeys: Object.keys(patch),
        settings: {},
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    setCachedServerCommandRevision(10)
    const reconciliations: Array<{
      latestRevision: number
      revisions: number[]
      localEffects: Array<[number, ServerCommandLocalEffect]>
    }> = []
    setServerCommandSuccessReconciler((event, events, localEffects) => {
      reconciliations.push({
        latestRevision: event.revision,
        revisions: events.map((candidate) => candidate.revision),
        localEffects: Array.from(localEffects.entries()),
      })
    })
    const rollback = vi.fn()

    const result = await runServerCommandSequence(
      [
        (baseRevision) =>
          patchSettingsGroup({
            group: 'runtime',
            baseRevision,
            patch: attempts[0],
            acknowledgeOptimistic: true,
            optimisticProjectionEpoch: 9,
          }),
        (baseRevision) =>
          patchSettingsGroup({
            group: 'runtime',
            baseRevision,
            patch: attempts[1],
            acknowledgeOptimistic: true,
            optimisticProjectionEpoch: 9,
          }),
      ],
      rollback,
    )

    expect(result).toBeNull()
    expect(rollback).not.toHaveBeenCalled()
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 10, patch: attempts[0] },
      { baseRevision: 11, patch: attempts[1] },
    ])
    expect(reconciliations).toEqual([
      {
        latestRevision: 12,
        revisions: [11, 12],
        localEffects: [
          [
            11,
            {
              kind: 'settingsPatch',
              group: 'runtime',
              attemptedPatch: attempts[0],
              settings: attempts[0],
              settingsProjectionEpoch: 9,
            },
          ],
          [
            12,
            {
              kind: 'settingsPatch',
              group: 'runtime',
              attemptedPatch: attempts[1],
              settings: attempts[1],
              settingsProjectionEpoch: 9,
            },
          ],
        ],
      },
    ])
  })

  it('keeps a command sequence atomic against unrelated queued work and advances custom success revisions', async () => {
    const firstStarted = createDeferred<void>()
    const releaseFirst = createDeferred<void>()
    const order: string[] = []
    const bases: number[] = []
    const success = (revision: number, type: string): ServerCommandResult => ({
      status: 'ok',
      revision,
      event: { type, revision, resource: 'asset' },
    })
    setCachedServerCommandRevision(20)

    const sequence = runServerCommandSequence([
      async (baseRevision) => {
        order.push('sequence-1')
        bases.push(baseRevision)
        firstStarted.resolve()
        await releaseFirst.promise
        return success(baseRevision + 1, 'sequence.first')
      },
      async (baseRevision) => {
        order.push('sequence-2')
        bases.push(baseRevision)
        return success(baseRevision + 1, 'sequence.second')
      },
    ])

    await firstStarted.promise
    const unrelated = runServerCommand({
      command: async (baseRevision) => {
        order.push('unrelated')
        bases.push(baseRevision)
        return success(baseRevision + 1, 'unrelated.updated')
      },
    })
    releaseFirst.resolve()

    await expect(Promise.all([sequence, unrelated])).resolves.toEqual([
      null,
      expect.objectContaining({ status: 'ok', revision: 23 }),
    ])
    expect(order).toEqual(['sequence-1', 'sequence-2', 'unrelated'])
    expect(bases).toEqual([20, 21, 22])
    expect(peekCachedServerCommandRevision()).toBe(23)
  })

  it('runs a per-step execution wrapper before that step acquires its base revision', async () => {
    const order: string[] = []
    const bases: number[] = []
    const success = (revision: number, type: string): ServerCommandResult => ({
      status: 'ok',
      revision,
      event: { type, revision, resource: 'asset' },
    })
    setCachedServerCommandRevision(30)

    const result = await runServerCommandSequence([
      async (baseRevision) => {
        order.push('first-command')
        bases.push(baseRevision)
        return success(baseRevision + 1, 'sequence.first')
      },
      {
        command: async (baseRevision) => {
          order.push('wrapped-command')
          bases.push(baseRevision)
          return success(baseRevision + 1, 'sequence.wrapped')
        },
        executionWrapper: async (execute) => {
          order.push('wrapped-predecessor')
          setCachedServerCommandRevision(40)
          return execute()
        },
      },
      async (baseRevision) => {
        order.push('last-command')
        bases.push(baseRevision)
        return success(baseRevision + 1, 'sequence.last')
      },
    ])

    expect(result).toBeNull()
    expect(order).toEqual(['first-command', 'wrapped-predecessor', 'wrapped-command', 'last-command'])
    expect(bases).toEqual([30, 40, 41])
    expect(peekCachedServerCommandRevision()).toBe(42)
  })

  it('rolls back when a command execution wrapper retains the mutation without sending', async () => {
    const rollback = vi.fn()
    const command = vi.fn(async () => ({ status: 'unavailable' as const }))

    await expect(
      runServerCommand({
        command,
        rollback,
        executionWrapper: async () => ({ status: 'unavailable' }),
      }),
    ).resolves.toEqual({ status: 'unavailable' })

    expect(command).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('keeps an optimistic projection when a durable execution wrapper retains the exact row', async () => {
    const rollback = vi.fn()
    const command = vi.fn(async () => ({ status: 'unavailable' as const }))

    await expect(
      runServerCommand({
        command,
        rollback,
        executionWrapper: async () => ({ status: 'unavailable' }),
        failureRollbackDisposition: () => 'retain',
      }),
    ).resolves.toEqual({ status: 'unavailable' })

    expect(command).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('consults a durable rollback disposition when an execution wrapper rejects', async () => {
    const rollback = vi.fn()
    let retained = false

    await expect(
      runServerCommand({
        command: async () => ({ status: 'unavailable' }),
        rollback,
        executionWrapper: async () => {
          retained = true
          throw new Error('durable lock failed')
        },
        failureRollbackDisposition: () => (retained ? 'retain' : 'rollback'),
      }),
    ).rejects.toThrow('durable lock failed')

    expect(rollback).not.toHaveBeenCalled()
  })

  it('normalizes a rejected per-step execution wrapper and rolls the sequence back once', async () => {
    setCachedServerCommandRevision(50)
    const rollback = vi.fn()
    const wrappedCommand = vi.fn(async () => ({ status: 'unavailable' as const }))
    const skipped = vi.fn(async () => ({ status: 'unavailable' as const }))

    const result = await runServerCommandSequence(
      [
        {
          command: wrappedCommand,
          executionWrapper: async () => {
            throw new Error('prepared durability failed')
          },
        },
        skipped,
      ],
      rollback,
    )

    expect(result).toEqual({
      status: 'error',
      error: 'Command execution wrapper rejected: prepared durability failed',
    })
    expect(wrappedCommand).not.toHaveBeenCalled()
    expect(skipped).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('fails a sequence fast and rolls back before reconciling its accepted events', async () => {
    const order: string[] = []
    let reconciledRevisions: number[] = []
    let reconciledLocalEffects: Array<[number, ServerCommandLocalEffect]> = []
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => {
      responseIndex += 1
      if (responseIndex === 1) {
        order.push('accepted-response')
        return {
          revision: 51,
          event: { type: 'settings.updated', revision: 51, resource: 'settings', id: 'runtime' },
          acknowledgedKeys: ['maxContext'],
          settings: { maxContext: 8_000 },
        }
      }
      order.push('conflict-response')
      return jsonResponse({ currentRevision: 55 }, 409)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    setCachedServerCommandRevision(50)
    setServerCommandSuccessReconciler((_event, events, localEffects) => {
      order.push('reconcile')
      reconciledRevisions = events.map((event) => event.revision)
      reconciledLocalEffects = Array.from(localEffects.entries())
    })
    const rollback = vi.fn(async () => {
      order.push('rollback-start')
      await Promise.resolve()
      order.push('rollback-finish')
    })
    const skipped = vi.fn(async (baseRevision: number) => ({
      status: 'ok' as const,
      revision: baseRevision + 1,
      event: { type: 'skipped.updated', revision: baseRevision + 1, resource: 'asset' },
    }))

    const result = await runServerCommandSequence(
      [
        (baseRevision) =>
          patchSettingsGroup({
            group: 'runtime',
            baseRevision,
            patch: { maxContext: 8_000 },
            acknowledgeOptimistic: true,
            optimisticProjectionEpoch: 9,
          }),
        (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxResponse: 1_000 } }),
        skipped,
      ],
      rollback,
    )

    expect(result).toEqual({ status: 'conflict', currentRevision: 55 })
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 50, patch: { maxContext: 8_000 } },
      { baseRevision: 51, patch: { maxResponse: 1_000 } },
    ])
    expect(skipped).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['accepted-response', 'conflict-response', 'rollback-start', 'rollback-finish', 'reconcile'])
    expect(reconciledRevisions).toEqual([51])
    expect(reconciledLocalEffects).toEqual([])
    expect(peekCachedServerCommandRevision()).toBe(55)
  })

  it('invalidates an asynchronous sequence rollback when a destructive refresh wins during cleanup', async () => {
    setCachedServerCommandRevision(50)
    const cleanupStarted = createDeferred<void>()
    const cleanupRelease = createDeferred<void>()
    const restoreProjection = vi.fn()

    const sequence = runServerCommandSequence(
      [async () => ({ status: 'error' as const, error: 'terminal failure' })],
      async (rollbackIsCurrent) => {
        expect(rollbackIsCurrent()).toBe(true)
        cleanupStarted.resolve()
        await cleanupRelease.promise
        if (rollbackIsCurrent()) restoreProjection()
      },
    )

    await cleanupStarted.promise
    createDestructiveRefreshToken('sequence-cleanup-refresh')
    cleanupRelease.resolve()

    await expect(sequence).resolves.toEqual({ status: 'error', error: 'terminal failure' })
    expect(restoreProjection).not.toHaveBeenCalled()
  })

  it('completes compatibility sequences whose successful result has no command event', async () => {
    setCachedServerCommandRevision(60)
    const reconciler = vi.fn()
    const rollback = vi.fn()
    setServerCommandSuccessReconciler(reconciler)

    const result = await runServerCommandSequence(
      [async () => ({ status: 'ok' }) as unknown as ServerCommandResult],
      rollback,
    )

    expect(result).toBeNull()
    expect(rollback).not.toHaveBeenCalled()
    expect(reconciler).not.toHaveBeenCalled()
    expect(peekCachedServerCommandRevision()).toBe(60)
  })

  it('rolls back a failed command result when no destructive refresh occurred', async () => {
    setCachedServerCommandRevision(12)
    const rollback = vi.fn()

    const result = await runServerCommand({
      command: async () => ({ status: 'error' as const, error: 'forced failure' }),
      rollback,
    })

    expect(result).toEqual({ status: 'error', error: 'forced failure' })
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('skips command-result rollback when the destructive refresh epoch changed after dispatch', async () => {
    setCachedServerCommandRevision(12)
    const rollback = vi.fn()

    const result = await runServerCommand({
      command: async () => {
        createDestructiveRefreshToken('test-full-resync')
        return { status: 'error' as const, error: 'forced failure' }
      },
      rollback,
    })

    expect(result).toEqual({ status: 'error', error: 'forced failure' })
    expect(rollback).not.toHaveBeenCalled()
  })

  it('captures a fresh epoch for commands dispatched after a destructive refresh', async () => {
    setCachedServerCommandRevision(12)
    createDestructiveRefreshToken('test-refresh-before-dispatch')
    const rollback = vi.fn()

    const result = await runServerCommand({
      command: async () => ({ status: 'error' as const, error: 'forced failure' }),
      rollback,
    })

    expect(result).toEqual({ status: 'error', error: 'forced failure' })
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('a rejected command factory rolls back once and resolves to an error result', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 7 }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollback = vi.fn()

    // Pre-fix the rejection escaped `void runServerCommand(...)` as an
    // unhandled rejection and the rollback never ran.
    const result = await runServerCommand({
      command: async () => {
        throw new Error('factory exploded')
      },
      rollback,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'Command factory rejected: factory exploded',
    })
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('a synchronous factory throw is also surfaced and rolled back', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 7 }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollback = vi.fn()

    const result = await runServerCommand({
      command: () => {
        throw new TypeError('bad command input')
      },
      rollback,
    })

    expect(result.status).toBe('error')
    expect(rollback).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})
