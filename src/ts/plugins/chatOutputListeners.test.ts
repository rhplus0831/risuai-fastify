import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isBrowserDiagnosticEvent, projectDiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'
const browserEvidence = vi.hoisted(() => ({
  entries: [] as Record<string, unknown>[],
  generation: 0,
  record: vi.fn(),
}))
vi.mock('../server/browserDiagnostics', () => ({
  recordBrowserDiagnostic: (entry: Record<string, unknown>) => browserEvidence.record(entry),
  resetBrowserDiagnosticsSession: () => {
    browserEvidence.generation++
  },
  captureBrowserDiagnosticsGeneration: () => browserEvidence.generation,
  isBrowserDiagnosticsGenerationCurrent: (generation: number) => generation === browserEvidence.generation,
}))
import { demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import {
  chatOutputListeners,
  runChatOutputListeners,
  setChatOutputRuntimeReadyPredicate,
  type ChatOutputListenerArg,
} from './chatOutputListeners'

const snapshot = {
  char: { chaId: 'character' },
  chat: { id: 'chat', message: [] },
  characterIndex: 0,
  chatIndex: 0,
  messageIndex: 0,
} as ChatOutputListenerArg

beforeEach(() => {
  browserEvidence.entries = []
  browserEvidence.generation++
  browserEvidence.record.mockImplementation((entry) => browserEvidence.entries.push(entry))
})

afterEach(() => {
  chatOutputListeners.clear()
  setChatOutputRuntimeReadyPredicate(() => true)
  resetClientSessionForTests()
  vi.restoreAllMocks()
})

describe('chat output effect authority', () => {
  it('does not admit a stale originating effect after its caller resumes as a fresh writer', async () => {
    enterClientWriter()
    const listener = vi.fn()
    chatOutputListeners.add(listener)
    await runChatOutputListeners(snapshot, { isCurrent: () => false })
    expect(listener).not.toHaveBeenCalled()
    expect(browserEvidence.entries).toEqual([])
  })

  it('does not invoke fresh registrations after an earlier listener awaited across demotion and promotion', async () => {
    enterClientWriter()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = vi.fn(() => held)
    const next = vi.fn()
    chatOutputListeners.add(first)
    const running = runChatOutputListeners(snapshot)
    expect(first).toHaveBeenCalledOnce()
    demoteClientSession()
    repromoteClientWriter()
    chatOutputListeners.add(next)
    release()
    await running
    expect(next).not.toHaveBeenCalled()
    expect(browserEvidence.entries).toEqual([])
  })

  it('summarizes actual invoked and rejected callbacks without exposing arguments, errors, or unmeasured host calls', async () => {
    enterClientWriter()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    chatOutputListeners.add((arg) => {
      arg.chat.message.push({ role: 'char', data: 'MUTATED_PRIVATE_OUTPUT', chatId: 'private-id' })
      clock.mockReturnValue(150)
    })
    chatOutputListeners.add(() => {
      throw new Error('PRIVATE_SYNC_FAILURE')
    })
    chatOutputListeners.add(async () => {
      throw { message: 'PRIVATE_ASYNC_FAILURE', credential: 'PRIVATE_SECRET' }
    })
    await runChatOutputListeners({ ...snapshot, effectIdempotencyKey: 'PRIVATE_EFFECT_KEY' })
    expect(browserEvidence.entries).toEqual([
      {
        category: 'script',
        level: 'warn',
        runtime: 'plugin',
        hook: 'onOutput',
        runs: 3,
        failures: 2,
        durationMs: 50,
        comparison: 'unavailable',
      },
    ])
    expect(JSON.stringify(browserEvidence.entries)).not.toMatch(
      /PRIVATE|private-id|allowedCalls|blockedCalls|outputChanged|transcriptChanged/,
    )
    expect(
      isBrowserDiagnosticEvent(
        projectDiagnosticEventV2({
          ...browserEvidence.entries[0],
          source: 'browser',
          correlation: 'client-asserted',
          timestamp: Date.now(),
        }),
      ),
    ).toBe(true)
    expect(snapshot.chat.message).toEqual([])
  })

  it.each(['diagnostic-session', 'cancellation'] as const)(
    'discards late callback evidence after %s changes',
    async (change) => {
      enterClientWriter()
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      chatOutputListeners.add(() => held)
      const next = vi.fn()
      chatOutputListeners.add(next)
      const controller = new AbortController()
      const running = runChatOutputListeners(snapshot, { signal: controller.signal })
      if (change === 'diagnostic-session') browserEvidence.generation++
      else controller.abort()
      release()
      await running
      expect(next).toHaveBeenCalledTimes(change === 'diagnostic-session' ? 1 : 0)
      expect(browserEvidence.entries).toEqual([])
    },
  )

  it('keeps completed output effects independent of recorder failure', async () => {
    enterClientWriter()
    const listener = vi.fn()
    chatOutputListeners.add(listener)
    browserEvidence.record.mockImplementation(() => {
      throw new Error('recorder failed')
    })
    await expect(runChatOutputListeners(snapshot)).resolves.toBeUndefined()
    expect(listener).toHaveBeenCalledOnce()
  })
})
