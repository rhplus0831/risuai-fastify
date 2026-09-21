import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { resetWriterAccessLostForTests } from './activeWriterSession'
import { resetStartupReadinessForTests, revokeStartupWriterCapabilities } from '../startupReadiness'
import {
  completeOnboardingCommand,
  getServerCommandBaseRevision,
  patchRuntimeSettings,
  peekAppliedServerResourceRevision,
  peekCachedServerCommandRevision,
  initializeServerDatabaseForBootstrap,
  replayDurableMutationRequests,
  runServerCommand,
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
  setServerCommandConflictGapHandler,
  setServerCommandSuccessReconciler,
} from './commands'

describe('server command transport', () => {
  it('blocks ordinary APIs before writer readiness while allowing only initialization and pending replay', async () => {
    resetStartupReadinessForTests()
    const command = vi.fn()
    const commandFetch = makeCommandFetch((url) =>
      url.endsWith('/state/initialize')
        ? {
            revision: 1,
            initialized: true,
            event: { type: 'state.initialized', revision: 1, resource: 'state' },
          }
        : {
            revision: 2,
            event: { type: 'settings.updated', revision: 2, resource: 'settings' },
          },
    )
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(patchRuntimeSettings({ baseRevision: 0, patch: { maxContext: 4_000 } })).resolves.toEqual({
      status: 'unavailable',
    })
    await expect(runServerCommand({ command })).resolves.toEqual({ status: 'unavailable' })
    expect(command).not.toHaveBeenCalled()
    expect(commandFetch.fetch).not.toHaveBeenCalled()

    await expect(initializeServerDatabaseForBootstrap()).resolves.toMatchObject({ status: 'ok', revision: 1 })
    await expect(
      replayDurableMutationRequests(
        [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 8_000 } } }],
        'pending-before-ready',
        'database-a',
      ),
    ).resolves.toEqual({ status: 'ok' })
    expect(commandFetch.fetch).toHaveBeenCalledTimes(2)
  })

  it('rechecks ordinary capability after a queued command loses writer ownership', async () => {
    setCachedServerCommandRevision(1)
    type HeldCommandResult = {
      status: 'ok'
      revision: number
      event: { type: string; revision: number; resource: string }
    }
    let releaseFirst!: (result: HeldCommandResult) => void
    const firstCommand = vi.fn(
      (_baseRevision: number) =>
        new Promise<HeldCommandResult>((resolve) => {
          releaseFirst = resolve
        }),
    )
    const secondCommand = vi.fn()

    const first = runServerCommand({ command: firstCommand })
    await vi.waitFor(() => expect(firstCommand).toHaveBeenCalledOnce())
    const second = runServerCommand({ command: secondCommand })
    revokeStartupWriterCapabilities()
    releaseFirst({
      status: 'ok',
      revision: 2,
      event: { type: 'settings.updated', revision: 2, resource: 'settings' },
    })

    await expect(first).resolves.toMatchObject({ status: 'ok' })
    await expect(second).resolves.toEqual({ status: 'unavailable' })
    expect(secondCommand).not.toHaveBeenCalled()
  })

  it('patches runtime settings with auth, the active writer identity, and baseRevision', async () => {
    const event = { type: 'settings.updated', revision: 2, resource: 'settings' }
    const commandFetch = makeCommandFetch(() => ({ revision: 2, event }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchRuntimeSettings({
      baseRevision: 1,
      patch: { streamGeminiThoughts: true },
    })

    expect(result).toEqual({ status: 'ok', revision: 2, event })
    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/settings/runtime',
        method: 'PATCH',
        authHeader: 'test-auth-token',
        writerSessionHeader: 'command-test-writer',
        contentType: 'application/json',
        body: {
          baseRevision: 1,
          patch: { streamGeminiThoughts: true },
        },
      },
    ])
  })

  it('rejects malformed 2xx command receipts and rolls back the optimistic command', async () => {
    const validEvent = { type: 'settings.updated', revision: 2, resource: 'settings' }
    const cases: Array<{ label: string; response: () => Response }> = [
      {
        label: 'empty response body',
        response: () => new Response(null, { status: 200 }),
      },
      {
        label: 'missing event',
        response: () => jsonResponse({ revision: 2 }),
      },
      {
        label: 'malformed event',
        response: () => jsonResponse({ revision: 2, event: { ...validEvent, resource: null } }),
      },
      {
        label: 'response/event revision mismatch',
        response: () => jsonResponse({ revision: 3, event: validEvent }),
      },
    ]

    for (const testCase of cases) {
      setCachedServerCommandRevision(1)
      const rollback = vi.fn()
      const reconciler = vi.fn()
      setServerCommandSuccessReconciler(reconciler)
      vi.stubGlobal('fetch', vi.fn(async () => testCase.response()) as unknown as typeof fetch)

      const result = await runServerCommand({
        command: (baseRevision) =>
          patchRuntimeSettings({
            baseRevision,
            patch: { streamGeminiThoughts: true },
          }),
        rollback,
      })

      expect(result, testCase.label).toEqual({ status: 'error', error: 'Invalid command response' })
      expect(rollback, testCase.label).toHaveBeenCalledTimes(1)
      expect(reconciler, testCase.label).not.toHaveBeenCalled()
      expect(peekCachedServerCommandRevision(), testCase.label).toBe(1)
    }
  })

  it('allows only the intentional eventless already-initialized receipt', async () => {
    const responses = [
      { revision: 7, initialized: false },
      { revision: 8, initialized: false, event: null },
      { revision: 8, initialized: true },
      {
        revision: 8,
        initialized: true,
        event: { type: 'state.initialized', revision: 8, resource: 'state' },
      },
    ]
    const commandFetch = makeCommandFetch(() => responses.shift())
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'ok',
      revision: 7,
      initialized: false,
    })
    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'error',
      error: 'Invalid command response',
    })
    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'error',
      error: 'Invalid command response',
    })
    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'ok',
      revision: 8,
      initialized: true,
      event: { type: 'state.initialized', revision: 8, resource: 'state' },
    })
    expect(peekCachedServerCommandRevision()).toBe(8)
  })

  it('preserves initialize_conflict as a distinct command failure', async () => {
    const commandFetch = makeCommandFetch(() => jsonResponse({ error: 'initialize_conflict' }, 409))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({
      status: 'error',
      error: 'initialize_conflict',
      reason: 'initialize-conflict',
    })
  })

  it('sends onboarding preset owners and settings through one command request', async () => {
    const event = { type: 'onboarding.completed', revision: 3, resource: 'legacyBotPreset' }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await completeOnboardingCommand({
      baseRevision: 2,
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
      modelPatch: { aiModel: 'openrouter' },
      promptPatch: { mainPrompt: 'onboarding prompt' },
      settingsPatch: { didFirstSetup: true },
    })

    expect(result).toEqual({
      status: 'ok',
      revision: 3,
      event,
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
    })
    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/onboarding',
        method: 'POST',
        authHeader: 'test-auth-token',
        writerSessionHeader: 'command-test-writer',
        contentType: 'application/json',
        body: {
          baseRevision: 2,
          modelPresetId: 'model-owner',
          promptPresetId: 'prompt-owner',
          modelPatch: { aiModel: 'openrouter' },
          promptPatch: { mainPrompt: 'onboarding prompt' },
          settingsPatch: { didFirstSetup: true },
        },
      },
    ])
  })

  it('reads and caches the command base revision from bootstrap', async () => {
    const commandFetch = makeCommandFetch(() => ({ revision: 12 }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(getServerCommandBaseRevision()).resolves.toBe(12)
    await expect(getServerCommandBaseRevision()).resolves.toBe(12)

    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/bootstrap',
        method: 'GET',
        authHeader: 'test-auth-token',
        writerSessionHeader: null,
        contentType: null,
        body: null,
      },
    ])
  })

  it('does not let an older asynchronous response move the cached revision backward', () => {
    setCachedServerCommandRevision(12)
    setCachedServerCommandRevision(9)

    expect(peekCachedServerCommandRevision()).toBe(12)
  })

  it('tracks the known command revision independently from the applied resource revision', () => {
    setAppliedServerResourceRevision(7)
    setCachedServerCommandRevision(9)

    expect(peekCachedServerCommandRevision()).toBe(9)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('maps revision conflicts to a typed conflict result', async () => {
    const commandFetch = makeCommandFetch(() => jsonResponse({ error: 'revision_conflict', currentRevision: 7 }, 409))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchRuntimeSettings({
      baseRevision: 6,
      patch: { streamGeminiThoughts: true },
    })

    expect(result).toEqual({ status: 'conflict', currentRevision: 7 })
    expect(peekCachedServerCommandRevision()).toBe(7)
    expect(peekAppliedServerResourceRevision()).toBeNull()
  })

  it('reports revision conflicts that prove the resource projection is behind', async () => {
    const commandFetch = makeCommandFetch(() => jsonResponse({ error: 'revision_conflict', currentRevision: 9 }, 409))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const onConflictGap = vi.fn()
    setAppliedServerResourceRevision(6)
    setServerCommandConflictGapHandler(onConflictGap)

    await expect(
      patchRuntimeSettings({
        baseRevision: 6,
        patch: { streamGeminiThoughts: true },
      }),
    ).resolves.toEqual({ status: 'conflict', currentRevision: 9 })

    expect(onConflictGap).toHaveBeenCalledWith(9, 6)
  })

  it.each([
    { status: 400, reason: 'invalid-request' as const },
    { status: 404, reason: 'not-found' as const },
    { status: 401 },
    { status: 403 },
    { status: 429 },
    { status: 500 },
  ])('classifies command HTTP $status without making transient failures terminal', async ({ status, reason }) => {
    const error = `command failed with ${status}`
    const commandFetch = makeCommandFetch(() => jsonResponse({ error }, status))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchRuntimeSettings({
      baseRevision: 1,
      patch: { streamGeminiThoughts: true },
    })

    expect(result).toEqual({
      status: 'error',
      error,
      ...(reason ? { reason } : {}),
    })
  })

  it.each([400, 404, 423])(
    'marks an HTTP %s with a non-command error envelope for explicit durable disposal',
    async (status) => {
      const commandFetch = makeCommandFetch(() =>
        jsonResponse(
          { statusCode: status, error: status === 423 ? 'Locked' : 'Not Found', message: 'proxy response' },
          status,
        ),
      )
      vi.stubGlobal('fetch', commandFetch.fetch)

      await expect(
        patchRuntimeSettings({
          baseRevision: 1,
          patch: { streamGeminiThoughts: true },
        }),
      ).resolves.toEqual({
        status: 'error',
        error: status === 423 ? 'Locked' : 'Not Found',
        reason: 'unrecognized-rejection',
      })
      resetWriterAccessLostForTests()
    },
  )
})
