import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  chatOutputListeners.clear()
  setChatOutputRuntimeReadyPredicate(() => true)
  resetClientSessionForTests()
})

describe('chat output effect authority', () => {
  it('does not admit a stale originating effect after its caller resumes as a fresh writer', async () => {
    enterClientWriter()
    const listener = vi.fn()
    chatOutputListeners.add(listener)
    await runChatOutputListeners(snapshot, { isCurrent: () => false })
    expect(listener).not.toHaveBeenCalled()
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
  })
})
