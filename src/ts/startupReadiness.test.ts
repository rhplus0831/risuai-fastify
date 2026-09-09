import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enterClientWriter, repromoteClientWriter } from './__tests__/clientSession'
import { demoteClientSession } from './clientSession'
import {
  backgroundReady,
  beginStartupAttempt,
  canApplyRoutes,
  canGenerate,
  canMutate,
  canRenderShell,
  completeStartupAttempt,
  failStartupAttempt,
  getGenerationReadinessDiagnostic,
  getStartupCoordinatorSnapshot,
  getStartupReadinessSnapshot,
  pluginsReady,
  recordStartupMilestone,
  recordStartupCapabilityFailure,
  resetStartupReadinessForTests,
  restoreStartupWriterCapabilities,
  revokeStartupWriterCapabilities,
  retryStartupCapability,
  runStartupStep,
  settleStartupChatReadiness,
  settleStartupGenerationRecoveryReadiness,
  settleStartupPluginRuntimeReadiness,
  waitForStartupMilestone,
} from './startupReadiness'

beforeEach(resetStartupReadinessForTests)

afterEach(() => {
  resetStartupReadinessForTests()
  vi.useRealTimers()
})

describe('startup readiness instrumentation', () => {
  it('requires current generation recovery and chat readiness after managed writer promotion', () => {
    enterClientWriter()
    for (const milestone of ['entry', 'shell-mounted', 'reader-ready', 'writer-ready', 'plugins-ready'] as const)
      recordStartupMilestone(milestone)
    settleStartupChatReadiness(true)
    settleStartupGenerationRecoveryReadiness(true)
    expect(canGenerate()).toBe(true)
    demoteClientSession()
    repromoteClientWriter()
    expect(canMutate()).toBe(true)
    expect(canGenerate()).toBe(false)
    settleStartupGenerationRecoveryReadiness(true)
    expect(canGenerate()).toBe(false)
    settleStartupChatReadiness(true)
    expect(canGenerate()).toBe(true)
  })
  it('publishes ordered, monotonic transitions when signals arrive out of order', () => {
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 5)
    expect(recordStartupMilestone('writer-ready', 12)).toBe('pending')
    expect(getStartupReadinessSnapshot().phase).toBe('shell-mounted')

    recordStartupMilestone('reader-ready', 15)

    expect(getStartupReadinessSnapshot()).toMatchObject({
      phase: 'writer-ready',
      timestamps: {
        entry: 0,
        'shell-mounted': 5,
        'reader-ready': 15,
        'writer-ready': 15,
      },
      durationsFromEntry: {
        entry: 0,
        'shell-mounted': 5,
        'reader-ready': 15,
        'writer-ready': 15,
      },
    })
  })

  it('suppresses duplicate signals without rewriting the first transition', () => {
    recordStartupMilestone('entry', 0)
    expect(recordStartupMilestone('entry', 99)).toBe('duplicate')

    expect(getStartupReadinessSnapshot().timestamps.entry).toBe(0)
  })

  it('records retry failures without error or browser-content data', () => {
    const firstAttempt = beginStartupAttempt(10)
    failStartupAttempt(firstAttempt, 'writer-bootstrap-failed', 'reader-ready', 12)
    const secondAttempt = beginStartupAttempt(13)
    completeStartupAttempt(secondAttempt, 20)

    const snapshot = getStartupReadinessSnapshot()
    expect(snapshot.attempts).toEqual([
      {
        attemptId: 1,
        startedAtMs: 10,
        failedAtMs: 12,
        failureCode: 'writer-bootstrap-failed',
        failureMilestone: 'reader-ready',
      },
      { attemptId: 2, startedAtMs: 13, completedAtMs: 20 },
    ])
    expect(JSON.stringify(snapshot)).not.toMatch(/character|chat content|prompt|plugin storage|account/i)
  })

  it('derives narrow capabilities at coordinator-owned milestone boundaries', () => {
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 1)
    expect([canRenderShell(), canApplyRoutes(), canMutate(), pluginsReady(), canGenerate()]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ])

    recordStartupMilestone('reader-ready', 2)
    expect(canRenderShell()).toBe(false)
    expect(canMutate()).toBe(false)

    recordStartupMilestone('writer-ready', 3)
    expect(canRenderShell()).toBe(true)
    expect(canApplyRoutes()).toBe(true)
    expect(canMutate()).toBe(true)
    expect(canGenerate()).toBe(false)

    recordStartupMilestone('plugins-ready', 4)
    expect(pluginsReady()).toBe(true)
    expect(canGenerate()).toBe(false)

    settleStartupChatReadiness(true)
    expect(canGenerate()).toBe(false)

    settleStartupGenerationRecoveryReadiness(true)
    expect(canGenerate()).toBe(true)

    settleStartupPluginRuntimeReadiness(false)
    expect(pluginsReady()).toBe(false)
    expect(canGenerate()).toBe(false)

    settleStartupPluginRuntimeReadiness(true)
    expect(pluginsReady()).toBe(true)
    expect(canGenerate()).toBe(true)

    expect(backgroundReady()).toBe(false)
    recordStartupMilestone('background-ready', 7)
    expect(backgroundReady()).toBe(true)
  })

  it('reports the exact privacy-safe blockers behind generation readiness', () => {
    expect(getGenerationReadinessDiagnostic()).toEqual({
      ready: false,
      blockers: ['writer-startup', 'plugin-runtime', 'generation-recovery', 'chat-dependencies'],
      phase: null,
    })

    for (const milestone of ['entry', 'shell-mounted', 'reader-ready', 'writer-ready', 'plugins-ready'] as const) {
      recordStartupMilestone(milestone)
    }
    settleStartupGenerationRecoveryReadiness(true)
    const attemptId = beginStartupAttempt()
    recordStartupCapabilityFailure(attemptId, 'selected-chat-hydration-failed', 'chat-ready')

    expect(getGenerationReadinessDiagnostic()).toEqual({
      ready: false,
      blockers: ['chat-dependencies'],
      phase: 'plugins-ready',
      failureCode: 'selected-chat-hydration-failed',
    })

    settleStartupChatReadiness(true)
    expect(getGenerationReadinessDiagnostic()).toEqual({ ready: true, blockers: [], phase: 'chat-ready' })

    revokeStartupWriterCapabilities()
    expect(getGenerationReadinessDiagnostic()).toEqual({
      ready: false,
      blockers: ['writer-capabilities-revoked'],
      phase: 'chat-ready',
    })
  })

  it('keeps unmanaged startup hidden until writer readiness', () => {
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 1)
    recordStartupMilestone('reader-ready', 2)

    expect(canRenderShell()).toBe(false)
    expect(canApplyRoutes()).toBe(false)
    expect(canMutate()).toBe(false)
    expect(canGenerate()).toBe(false)
  })

  it('settles background work even when an earlier localized milestone cannot transition', () => {
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 1)
    recordStartupMilestone('reader-ready', 2)
    recordStartupMilestone('writer-ready', 3)

    expect(recordStartupMilestone('background-ready', 4)).toBe('pending')
    expect(getStartupReadinessSnapshot().phase).toBe('writer-ready')
    expect(backgroundReady()).toBe(true)
  })

  it('revokes writer-owned capabilities without hiding the readable shell or milestone history', () => {
    for (const milestone of [
      'entry',
      'shell-mounted',
      'reader-ready',
      'writer-ready',
      'plugins-ready',
      'chat-ready',
    ] as const) {
      recordStartupMilestone(milestone)
    }
    settleStartupChatReadiness(true)
    settleStartupGenerationRecoveryReadiness(true)

    revokeStartupWriterCapabilities()

    expect(canRenderShell()).toBe(true)
    expect(canApplyRoutes()).toBe(false)
    expect(canMutate()).toBe(false)
    expect(canGenerate()).toBe(false)
    expect(pluginsReady()).toBe(true)
    expect(getStartupReadinessSnapshot().phase).toBe('chat-ready')
    expect(getStartupCoordinatorSnapshot().writerCapabilitiesRevoked).toBe(true)

    restoreStartupWriterCapabilities()

    expect(canApplyRoutes()).toBe(true)
    expect(canMutate()).toBe(true)
    expect(canGenerate()).toBe(true)
    expect(getStartupCoordinatorSnapshot().writerCapabilitiesRevoked).toBe(false)
  })

  it('records per-capability failures and clears them when readiness is reached', () => {
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 1)
    const attemptId = beginStartupAttempt(2)
    failStartupAttempt(attemptId, 'plugin-initialization-failed', 'plugins-ready', 3)

    expect(getStartupCoordinatorSnapshot().failures).toEqual({
      pluginsReady: expect.objectContaining({ attemptId, failureCode: 'plugin-initialization-failed' }),
      canGenerate: expect.objectContaining({ attemptId, failureCode: 'plugin-initialization-failed' }),
    })

    recordStartupMilestone('reader-ready', 4)
    recordStartupMilestone('writer-ready', 5)
    recordStartupMilestone('plugins-ready', 6)
    expect(getStartupCoordinatorSnapshot().failures.pluginsReady).toBeUndefined()
    expect(getStartupCoordinatorSnapshot().failures.canGenerate).toBeDefined()

    settleStartupChatReadiness(true)
    settleStartupGenerationRecoveryReadiness(true)
    expect(getStartupCoordinatorSnapshot().failures.canGenerate).toBeUndefined()
  })

  it('deduplicates successful steps and in-flight targeted retries', async () => {
    const step = vi.fn(async () => 'ready')
    await expect(runStartupStep('plugin-runtime', step)).resolves.toBe('ready')
    await expect(runStartupStep('plugin-runtime', step)).resolves.toBe('ready')
    expect(step).toHaveBeenCalledOnce()

    let releaseRetry!: () => void
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRetry = resolve
        }),
    )
    const firstRetry = retryStartupCapability('canRenderShell', retry)
    const secondRetry = retryStartupCapability('canRenderShell', retry)
    await Promise.resolve()
    expect(retry).toHaveBeenCalledOnce()
    releaseRetry()
    await Promise.all([firstRetry, secondRetry])
  })

  it('removes a failed startup step from the in-flight cache so a later attempt can succeed', async () => {
    const step = vi.fn().mockRejectedValueOnce(new Error('plugin unavailable')).mockResolvedValueOnce('ready')

    await expect(runStartupStep('plugin-runtime', step)).rejects.toThrow('plugin unavailable')
    await expect(runStartupStep('plugin-runtime', step)).resolves.toBe('ready')
    await expect(runStartupStep('plugin-runtime', step)).resolves.toBe('ready')

    expect(step).toHaveBeenCalledTimes(2)
  })

  it('shares a rejected capability retry and permits a fresh retry after cleanup', async () => {
    const retry = vi.fn().mockRejectedValueOnce(new Error('still offline')).mockResolvedValueOnce('recovered')

    const first = retryStartupCapability('canGenerate', retry)
    const concurrent = retryStartupCapability('canGenerate', retry)
    expect(concurrent).toBe(first)
    await expect(first).rejects.toThrow('still offline')

    await expect(retryStartupCapability('canGenerate', retry)).resolves.toBe('recovered')
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('waits for a narrow milestone and rejects on timeout', async () => {
    vi.useFakeTimers()
    const waiting = waitForStartupMilestone('writer-ready', 100)
    recordStartupMilestone('entry', 0)
    recordStartupMilestone('shell-mounted', 1)
    recordStartupMilestone('reader-ready', 2)
    recordStartupMilestone('writer-ready', 3)
    await expect(waiting).resolves.toBeUndefined()

    const timedOut = waitForStartupMilestone('chat-ready', 100)
    const rejection = expect(timedOut).rejects.toThrow('Timed out waiting for startup milestone: chat-ready')
    await vi.advanceTimersByTimeAsync(100)
    await rejection
  })
})
