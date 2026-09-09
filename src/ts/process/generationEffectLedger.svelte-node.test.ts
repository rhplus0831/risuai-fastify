import {
  recordStartupMilestone,
  resetStartupReadinessForTests,
  pluginsReady,
  settleStartupPluginRuntimeReadiness,
} from '../startupReadiness'
import {
  resetClientSessionForTests,
  beginClientSession,
  authorizeClientWriterRecovery,
  setClientProjectionReady,
  setClientConnectionState,
  canUseClientRecoveryAccess,
  canUseClientWriteAccess,
} from '../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completedGenerationEffect,
  resetGenerationEffectLedgerForTests,
  runLedgeredGenerationEffect,
  setGenerationEffectTimingObserverForTests,
  type GenerationEffectExecutionContext,
} from './generationEffectLedger'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'

vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: vi.fn().mockResolvedValue('auth') }))
vi.mock('../server/activeWriterSession', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-a' }),
  handleActiveWriterStaleResponse: () => false,
}))

const ref: ServerGenerationEffectLedgerRef = {
  version: 1,
  databaseLineage: 'lineage-a',
  keyType: 'operation',
  keyId: 'operation-a',
  generationId: 'generation-a',
  characterId: 'character-a',
  chatId: 'chat-a',
  messageId: 'message-a',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetClientSessionForTests()
  resetStartupReadinessForTests()
  for (const milestone of ['entry', 'shell-mounted', 'reader-ready', 'writer-ready', 'plugins-ready'] as const)
    recordStartupMilestone(milestone)
  resetGenerationEffectLedgerForTests()
})

describe('client generation effect ledger', () => {
  it('reports the isolated callback duration and outcome', async () => {
    const timings: Array<{ kind: string; delivery: string; durationMs: number; status: string }> = []
    setGenerationEffectTimingObserverForTests((timing) => timings.push(timing))

    await expect(
      runLedgeredGenerationEffect(undefined, 'plugin_output', 'live_terminal', () =>
        completedGenerationEffect(undefined),
      ),
    ).resolves.toMatchObject({ executed: true, status: 'completed' })

    expect(timings).toEqual([
      expect.objectContaining({
        kind: 'plugin_output',
        delivery: 'live_terminal',
        status: 'completed',
        durationMs: expect.any(Number),
      }),
    ])
  })

  it('runs a live durable effect once and writes its completion receipt', async () => {
    let claimed = false
    let receipted = false
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (claimed) return jsonResponse({ status: 'not_claimed', reason: 'already_receipted' })
        claimed = true
        return jsonResponse({ status: 'claimed', claimId: 'claim-a' }, 201)
      }
      receipted = true
      return jsonResponse({ effect: { status: 'completed' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const effect = vi.fn(() => completedGenerationEffect('applied'))

    await expect(runLedgeredGenerationEffect(ref, 'igp', 'live_terminal', effect)).resolves.toEqual({
      executed: true,
      value: 'applied',
      status: 'completed',
    })
    await expect(runLedgeredGenerationEffect(ref, 'igp', 'late_recovery', effect)).resolves.toEqual({
      executed: false,
      status: 'already_receipted',
    })

    expect(effect).toHaveBeenCalledTimes(1)
    expect(effect).toHaveBeenCalledWith({
      idempotencyKey: 'generation-effect-v1:lineage-a:operation:operation-a:igp',
      reclaimed: false,
      igpEffect: { generationId: 'generation-a', claimId: 'claim-a' },
      isCurrent: expect.any(Function),
      signal: expect.any(AbortSignal),
    })
    expect(receipted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      claimId: 'claim-a',
      status: 'completed',
    })
  })

  it('does not grant IGP message receipt authority to a legacy or different-kind callback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse({ status: 'claimed', claimId: 'plugin-claim' }, 201)
          : jsonResponse({ effect: { status: 'completed' } }),
      ),
    )
    const effect = vi.fn((_context: GenerationEffectExecutionContext) => completedGenerationEffect(undefined))
    await runLedgeredGenerationEffect(undefined, 'igp', 'live_terminal', effect)
    await runLedgeredGenerationEffect(ref, 'plugin_output', 'live_terminal', effect)
    expect(effect).toHaveBeenCalledTimes(2)
    for (const [context] of effect.mock.calls) {
      expect(context).not.toHaveProperty('igpEffect')
    }
  })

  it('does not invoke an ephemeral effect when late recovery records its skip', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'not_claimed',
        reason: 'late_recovery_skipped',
        effect: { status: 'skipped', reason: 'late_recovery' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const effect = vi.fn(() => completedGenerationEffect(undefined))

    await expect(runLedgeredGenerationEffect(ref, 'notification', 'late_recovery', effect)).resolves.toEqual({
      executed: false,
      status: 'already_receipted',
    })
    expect(effect).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      delivery: 'late_recovery',
      messageId: 'message-a',
    })
  })

  it('fires every ephemeral effect on a live terminal and writes each receipt', async () => {
    const claimedKinds: string[] = []
    const receiptedKinds: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const kind = url.split('/').at(-2) ?? ''
      if (init?.method === 'POST') {
        claimedKinds.push(kind)
        return jsonResponse({ status: 'claimed', claimId: `claim-${kind}` }, 201)
      }
      receiptedKinds.push(kind)
      return jsonResponse({ effect: { status: 'completed' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const callbacks = {
      notification: vi.fn(() => completedGenerationEffect(undefined)),
      tts: vi.fn(() => completedGenerationEffect(undefined)),
      completion_sound: vi.fn(() => completedGenerationEffect(undefined)),
    }

    for (const kind of ['notification', 'tts', 'completion_sound'] as const) {
      await expect(runLedgeredGenerationEffect(ref, kind, 'live_terminal', callbacks[kind])).resolves.toMatchObject({
        executed: true,
        status: 'completed',
      })
      expect(callbacks[kind]).toHaveBeenCalledTimes(1)
    }

    expect(claimedKinds).toEqual(['notification', 'tts', 'completion_sound'])
    expect(receiptedKinds).toEqual(['notification', 'tts', 'completion_sound'])
  })

  it('coalesces concurrent recovery attempts behind one durable claim', async () => {
    let releaseClaim!: () => void
    const claimBarrier = new Promise<void>((resolve) => {
      releaseClaim = resolve
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        await claimBarrier
        return jsonResponse({ status: 'claimed', claimId: 'claim-a' }, 201)
      }
      return jsonResponse({ effect: { status: 'completed' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const effect = vi.fn(() => completedGenerationEffect(undefined))

    const first = runLedgeredGenerationEffect(ref, 'plugin_output', 'late_recovery', effect)
    const second = runLedgeredGenerationEffect(ref, 'plugin_output', 'late_recovery', effect)
    releaseClaim()
    await Promise.all([first, second])

    expect(effect).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('generation effect writer lifecycle', () => {
  it('does not claim or invoke live or recovered effects as a Reader', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const effect = vi.fn(() => completedGenerationEffect(undefined))
    for (const delivery of ['live_terminal', 'late_recovery'] as const) {
      await expect(runLedgeredGenerationEffect(ref, 'igp', delivery, effect)).resolves.toEqual({
        executed: false,
        status: 'unavailable',
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
  })

  it('does not dispatch a claim after auth resumes in a different writer session', async () => {
    setManagedWriterForTest()
    let release!: (auth: string) => void
    vi.mocked(getNodeServerProxyAuth).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const effect = vi.fn(() => completedGenerationEffect(undefined))
    const pending = runLedgeredGenerationEffect(ref, 'igp', 'live_terminal', effect)
    demoteAndRepromoteForTest()
    release('auth')
    await expect(pending).resolves.toEqual({ executed: false, status: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
  })

  it('leaves a held claim unexecuted after loss and re-promotion', async () => {
    setManagedWriterForTest()
    let release!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const effect = vi.fn(() => completedGenerationEffect(undefined))
    const pending = runLedgeredGenerationEffect(ref, 'igp', 'live_terminal', effect)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release(jsonResponse({ status: 'claimed', claimId: 'old-claim' }, 201))
    await expect(pending).resolves.toEqual({ executed: false, status: 'unavailable' })
    expect(effect).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('aborts an executing callback and stops lease renewal and receipts after writer loss', async () => {
    setManagedWriterForTest()
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { status: 'claimed', claimId: 'old-claim', leaseExpiresAt: new Date(Date.now() + 9000).toISOString() },
            201,
          ),
        )
      vi.stubGlobal('fetch', fetchMock)
      let release!: () => void
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      let context!: Parameters<Parameters<typeof runLedgeredGenerationEffect>[3]>[0]
      const pending = runLedgeredGenerationEffect(ref, 'igp', 'live_terminal', async (value) => {
        context = value
        await barrier
        return completedGenerationEffect('finished')
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(context.isCurrent()).toBe(true)
      demoteAndRepromoteForTest()
      expect(context.signal.aborted).toBe(true)
      expect(context.isCurrent()).toBe(false)
      await vi.advanceTimersByTimeAsync(10000)
      expect(fetchMock).toHaveBeenCalledOnce()
      release()
      await expect(pending).resolves.toEqual({ executed: true, value: 'finished', status: 'unavailable' })
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

it('does not claim or receipt recovered effects during validated writer recovery', async () => {
  const operation = beginClientSession('recovering-writer')
  authorizeClientWriterRecovery(operation, {
    databaseLineage: 'lineage-a',
    writer: { sessionId: 'recovering-writer', epoch: 1 },
  })
  setClientProjectionReady(true)
  setClientConnectionState('live')
  expect(canUseClientRecoveryAccess()).toBe(true)
  expect(canUseClientWriteAccess()).toBe(false)
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const effect = vi.fn(() => completedGenerationEffect(undefined))
  await expect(runLedgeredGenerationEffect(ref, 'plugin_output', 'late_recovery', effect)).resolves.toEqual({
    executed: false,
    status: 'unavailable',
  })
  expect(fetchMock).not.toHaveBeenCalled()
  expect(effect).not.toHaveBeenCalled()
})

it('leaves managed recovered effects unclaimed until ordinary writing and coherent plugin boot', async () => {
  resetStartupReadinessForTests()
  setManagedWriterForTest()
  expect(canUseClientWriteAccess()).toBe(true)
  expect(pluginsReady()).toBe(false)
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST'
      ? jsonResponse({ status: 'claimed', claimId: 'ready-claim' }, 201)
      : jsonResponse({ effect: { status: 'completed' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const effect = vi.fn(() => completedGenerationEffect('applied'))
  await expect(runLedgeredGenerationEffect(ref, 'plugin_output', 'late_recovery', effect)).resolves.toEqual({
    executed: false,
    status: 'unavailable',
  })
  expect(fetchMock).not.toHaveBeenCalled()
  expect(effect).not.toHaveBeenCalled()
  for (const milestone of ['entry', 'shell-mounted', 'reader-ready', 'writer-ready', 'plugins-ready'] as const)
    recordStartupMilestone(milestone)
  settleStartupPluginRuntimeReadiness(false)
  await expect(runLedgeredGenerationEffect(ref, 'plugin_output', 'late_recovery', effect)).resolves.toEqual({
    executed: false,
    status: 'unavailable',
  })
  expect(fetchMock).not.toHaveBeenCalled()
  settleStartupPluginRuntimeReadiness(true)
  await expect(runLedgeredGenerationEffect(ref, 'plugin_output', 'late_recovery', effect)).resolves.toEqual({
    executed: true,
    status: 'completed',
    value: 'applied',
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(effect).toHaveBeenCalledOnce()
})
