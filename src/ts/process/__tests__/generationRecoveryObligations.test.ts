import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyGenerationRecoveryJob,
  applyGenerationRecoveryOperation,
  beginGenerationRecoveryObligation,
  captureGenerationRecoveryObligations,
  captureGenerationRecoveryScope,
  hasGenerationRecoveryObligationsForTests,
  isGenerationRecoveryObligationCurrent,
  isGenerationRecoveryScopeCurrent,
  markGenerationRecoveryObligationUncertain,
  resetGenerationRecoveryObligations,
  settleCapturedGenerationRecoveryObligation,
  settleGenerationRecoveryObligation,
} from '../generationRecoveryObligations'

beforeEach(() => {
  resetGenerationRecoveryObligations()
})

describe('generation recovery obligations', () => {
  it('keeps one unique obligation per dispatch without evicting unresolved work', () => {
    const tokens = new Set<string>()
    for (let index = 0; index < 160; index += 1) {
      tokens.add(
        beginGenerationRecoveryObligation({
          chatId: `chat-${index}`,
          operationId: `operation-${index}`,
          kind: 'submit',
          sourceGeneration: 1,
        }),
      )
    }

    expect(tokens.size).toBe(160)
    expect(captureGenerationRecoveryObligations()).toHaveLength(160)
  })

  it('invalidates older captured evidence when dispatch becomes uncertain', () => {
    const token = beginGenerationRecoveryObligation({
      chatId: 'chat-a',
      operationId: 'operation-a',
      kind: 'submit',
      sourceGeneration: 3,
    })
    const beforeUncertain = captureGenerationRecoveryObligations()[0]

    markGenerationRecoveryObligationUncertain(token)

    expect(isGenerationRecoveryObligationCurrent(beforeUncertain)).toBe(false)
    expect(captureGenerationRecoveryObligations()[0]).toMatchObject({
      token,
      phase: 'uncertain',
      sourceGeneration: 3,
    })
  })

  it('does not let stale callbacks recreate obligations cleared with their ownership scope', () => {
    const token = beginGenerationRecoveryObligation({
      operationId: 'operation-old-scope',
      kind: 'submit',
      sourceGeneration: 4,
    })

    resetGenerationRecoveryObligations()
    markGenerationRecoveryObligationUncertain(token)
    settleGenerationRecoveryObligation(token)

    expect(hasGenerationRecoveryObligationsForTests()).toBe(false)
  })

  it('fences a replaced ownership scope independently of whether its token remains', () => {
    const scope = captureGenerationRecoveryScope()
    const token = beginGenerationRecoveryObligation({
      operationId: 'operation-old-scope',
      kind: 'submit',
      sourceGeneration: 4,
    })
    const captured = captureGenerationRecoveryObligations()[0]

    settleGenerationRecoveryObligation(token)
    expect(isGenerationRecoveryScopeCurrent(scope)).toBe(true)
    expect(isGenerationRecoveryScopeCurrent(captured)).toBe(true)

    resetGenerationRecoveryObligations()
    expect(isGenerationRecoveryScopeCurrent(scope)).toBe(false)
    expect(isGenerationRecoveryScopeCurrent(captured)).toBe(false)
  })

  it('retains terminal submit authority until its exact captured transcript recovery settles', () => {
    const token = beginGenerationRecoveryObligation({
      chatId: 'chat-terminal',
      operationId: 'operation-terminal',
      kind: 'submit',
      sourceGeneration: 1,
    })
    applyGenerationRecoveryOperation({
      operationId: 'operation-terminal',
      chatId: 'chat-terminal',
      state: 'completed',
      stateVersion: 8,
    })
    const terminal = captureGenerationRecoveryObligations()[0]

    settleGenerationRecoveryObligation(token)

    expect(terminal.phase).toBe('awaiting_transcript')
    expect(hasGenerationRecoveryObligationsForTests('chat-terminal')).toBe(true)
    expect(settleCapturedGenerationRecoveryObligation(terminal)).toBe(true)
    expect(hasGenerationRecoveryObligationsForTests()).toBe(false)
  })

  it('does not let hydration for older terminal authority settle a newer terminal projection', () => {
    beginGenerationRecoveryObligation({
      chatId: 'chat-terminal',
      operationId: 'operation-terminal',
      kind: 'submit',
      sourceGeneration: 1,
    })
    applyGenerationRecoveryOperation({
      operationId: 'operation-terminal',
      chatId: 'chat-terminal',
      state: 'completed',
      stateVersion: 8,
      projectionEpoch: 11,
      resultMessageId: 'message-a',
    })
    const olderTerminal = captureGenerationRecoveryObligations()[0]

    applyGenerationRecoveryOperation({
      operationId: 'operation-terminal',
      chatId: 'chat-terminal',
      state: 'completed',
      stateVersion: 9,
      projectionEpoch: 12,
      resultMessageId: 'message-a',
    })

    expect(settleCapturedGenerationRecoveryObligation(olderTerminal)).toBe(false)
    expect(captureGenerationRecoveryObligations()[0]).toMatchObject({
      phase: 'awaiting_transcript',
      terminalAuthority: { stateVersion: 9, projectionEpoch: 12 },
    })
  })

  it('does not resolve retry recovery from the old attempt or state version', () => {
    beginGenerationRecoveryObligation({
      chatId: 'chat-retry',
      operationId: 'operation-retry',
      kind: 'retry',
      sourceGeneration: 2,
      retryRequestId: 'retry-new',
      minimumStateVersion: 12,
    })

    applyGenerationRecoveryOperation({
      operationId: 'operation-retry',
      chatId: 'chat-retry',
      state: 'owned_by_job',
      stateVersion: 12,
      currentAttempt: { retryRequestId: 'retry-old' },
    })
    applyGenerationRecoveryOperation({
      operationId: 'operation-retry',
      chatId: 'chat-retry',
      state: 'owned_by_job',
      stateVersion: 11,
      currentAttempt: { retryRequestId: 'retry-new' },
    })

    expect(hasGenerationRecoveryObligationsForTests()).toBe(true)

    applyGenerationRecoveryOperation({
      operationId: 'operation-retry',
      chatId: 'chat-retry',
      state: 'owned_by_job',
      stateVersion: 12,
      currentAttempt: { retryRequestId: 'retry-new' },
    })

    expect(hasGenerationRecoveryObligationsForTests()).toBe(false)
  })

  it('requires a cancellation state transition at or above the captured version', () => {
    beginGenerationRecoveryObligation({
      operationId: 'operation-cancel',
      kind: 'cancel',
      sourceGeneration: 2,
      minimumStateVersion: 6,
    })

    applyGenerationRecoveryOperation({
      operationId: 'operation-cancel',
      state: 'owned_by_job',
      stateVersion: 6,
    })
    applyGenerationRecoveryOperation({
      operationId: 'operation-cancel',
      state: 'cancel_requested',
      stateVersion: 5,
    })

    expect(hasGenerationRecoveryObligationsForTests()).toBe(true)

    applyGenerationRecoveryOperation({
      operationId: 'operation-cancel',
      state: 'cancel_requested',
      stateVersion: 6,
    })

    expect(hasGenerationRecoveryObligationsForTests()).toBe(false)
  })

  it('uses only an exact sufficiently new protocol job as submit authority', () => {
    beginGenerationRecoveryObligation({ chatId: 'chat-legacy', kind: 'submit', sourceGeneration: 1 })
    beginGenerationRecoveryObligation({
      chatId: 'chat-protocol',
      operationId: 'operation-protocol',
      kind: 'submit',
      sourceGeneration: 1,
      minimumStateVersion: 4,
    })

    applyGenerationRecoveryJob({ chatId: 'chat-legacy' })
    applyGenerationRecoveryJob({
      chatId: 'chat-protocol',
      operationId: 'operation-protocol',
      operationStateVersion: 3,
    })
    expect(captureGenerationRecoveryObligations()).toHaveLength(2)

    applyGenerationRecoveryJob({
      chatId: 'chat-protocol',
      operationId: 'operation-protocol',
      operationStateVersion: 4,
    })
    expect(captureGenerationRecoveryObligations()).toEqual([
      expect.objectContaining({ chatId: 'chat-legacy', kind: 'submit' }),
    ])
  })
})
