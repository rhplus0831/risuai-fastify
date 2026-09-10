import { describe, expect, it } from 'vitest'
import {
  CHAT_GENERATION_INPUT_HOOK_STAGE,
  chatGenerationLoadingPhaseFromStage,
  getChatGenerationLoadingLanguageKey,
  getPostGenerationScriptProgress,
  normalizeChatGenerationLoadingPhase,
} from './chatGenerationLoading'

describe('chat generation loading stage mapping', () => {
  it('maps process stages to typed, user-facing phases', () => {
    expect(chatGenerationLoadingPhaseFromStage(0)).toBe('starting')
    expect(chatGenerationLoadingPhaseFromStage(1)).toBe('preparing')
    expect(chatGenerationLoadingPhaseFromStage(2)).toBe('checking-memory')
    expect(chatGenerationLoadingPhaseFromStage(3)).toBe('waiting-for-model')
    expect(chatGenerationLoadingPhaseFromStage(4)).toBe('finalizing')
    expect(chatGenerationLoadingPhaseFromStage(CHAT_GENERATION_INPUT_HOOK_STAGE)).toBe('input-hook')

    expect(getChatGenerationLoadingLanguageKey('starting')).toBe('chatGenerationStageStarting')
    expect(getChatGenerationLoadingLanguageKey('preparing')).toBe('chatGenerationStagePreparingPrompt')
    expect(getChatGenerationLoadingLanguageKey('checking-memory')).toBe('chatGenerationStageCheckingMemory')
    expect(getChatGenerationLoadingLanguageKey('waiting-for-model')).toBe('chatGenerationStageWaitingForModel')
    expect(getChatGenerationLoadingLanguageKey('generating')).toBe('chatGenerationStageGenerating')
    expect(getChatGenerationLoadingLanguageKey('finalizing')).toBe('chatGenerationStageFinalizing')
    expect(getChatGenerationLoadingLanguageKey('input-hook')).toBe('chatGenerationStageInputHook')
  })

  it('falls back to the starting phase for unknown values', () => {
    expect(normalizeChatGenerationLoadingPhase(-1)).toBe('starting')
    expect(normalizeChatGenerationLoadingPhase('unknown')).toBe('starting')
    expect(normalizeChatGenerationLoadingPhase(null)).toBe('starting')
    expect(getChatGenerationLoadingLanguageKey(undefined)).toBe('chatGenerationStageStarting')
  })

  it('simulates bounded progress for post-generation scripts', () => {
    const baseline = getPostGenerationScriptProgress(1_000, 1_000, 0)
    const timeProgress = getPostGenerationScriptProgress(1_000, 10_000, 0)
    const callProgress = getPostGenerationScriptProgress(1_000, 1_000, 3)
    const combinedProgress = getPostGenerationScriptProgress(1_000, 10_000, 3)
    const maximumProgress = getPostGenerationScriptProgress(1_000, 60_000, 100)

    expect(baseline).toBeGreaterThanOrEqual(0)
    expect(getPostGenerationScriptProgress(1_000, 0, 0)).toBe(baseline)
    expect(getPostGenerationScriptProgress(1_000, 1_000, -1)).toBe(baseline)
    expect(timeProgress).toBeGreaterThan(baseline)
    expect(callProgress).toBeGreaterThan(baseline)
    expect(combinedProgress).toBeGreaterThanOrEqual(timeProgress)
    expect(combinedProgress).toBeGreaterThanOrEqual(callProgress)
    expect(maximumProgress).toBe(94)
    expect(maximumProgress).toBeLessThan(100)
  })
})
