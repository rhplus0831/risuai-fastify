import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  beginHalfStreamingProgress,
  clearHalfStreamingProgress,
  halfStreamingProgress,
  recordHalfStreamingToken,
  resetHalfStreamingProgressForTests,
} from './halfStreamingProgress'

const target = {
  characterId: 'char-1',
  chatId: 'chat-1',
  generationId: 'generation-1',
}

describe('halfStreamingProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(1_000))
    resetHalfStreamingProgressForTests()
  })

  afterEach(() => vi.useRealTimers())

  it('reports token-frame throughput from the first received token', () => {
    beginHalfStreamingProgress(target)
    recordHalfStreamingToken(target)
    expect(get(halfStreamingProgress)).toContainEqual(
      expect.objectContaining({ generatedTokens: 1, tokensPerSecond: 0 }),
    )

    vi.setSystemTime(new Date(1_100))
    recordHalfStreamingToken(target)
    expect(get(halfStreamingProgress)).toContainEqual(
      expect.objectContaining({ generatedTokens: 2, tokensPerSecond: 10 }),
    )

    vi.setSystemTime(new Date(1_200))
    recordHalfStreamingToken(target)
    expect(get(halfStreamingProgress)).toContainEqual(
      expect.objectContaining({ generatedTokens: 3, tokensPerSecond: 10 }),
    )
  })

  it('counts a batched first sample without inventing a generation interval', () => {
    beginHalfStreamingProgress(target)

    recordHalfStreamingToken(target, 3_500, { generatedTokens: 12 })

    expect(get(halfStreamingProgress)).toContainEqual(
      expect.objectContaining({
        generatedTokens: 12,
        tokensPerSecond: 0,
      }),
    )
  })

  it('averages cumulative token progress over at most five seconds of client arrival time', () => {
    beginHalfStreamingProgress(target)
    recordHalfStreamingToken(target, 1_000, { generatedTokens: 10 })
    recordHalfStreamingToken(target, 2_000, { generatedTokens: 20 })
    recordHalfStreamingToken(target, 4_000, { generatedTokens: 50 })

    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 50, tokensPerSecond: 40 / 3 })

    recordHalfStreamingToken(target, 7_000, { generatedTokens: 80 })

    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 80, tokensPerSecond: 12 })
  })

  it('does not invent a rate for cumulative samples arriving together', () => {
    beginHalfStreamingProgress(target)
    recordHalfStreamingToken(target, 100_000, { generatedTokens: 100 })
    recordHalfStreamingToken(target, 100_000, { generatedTokens: 120 })

    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 120, tokensPerSecond: 0 })

    recordHalfStreamingToken(target, 102_000, { generatedTokens: 140 })
    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 140, tokensPerSecond: 10 })
  })

  it('does not inflate totals or speed on regressive or incomplete samples', () => {
    beginHalfStreamingProgress(target)
    recordHalfStreamingToken(target, 2_000, { generatedTokens: 10 })
    recordHalfStreamingToken(target, 3_000, { generatedTokens: 20 })
    recordHalfStreamingToken(target, 3_200, { generatedTokens: 10 })
    recordHalfStreamingToken(target, 3_300, { generatedTokens: 15 })
    recordHalfStreamingToken(target, 3_400, { generatedTokens: Number.NaN })
    recordHalfStreamingToken(target, 3_500)

    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 20, tokensPerSecond: 10 })
  })

  it('handles zero counts and equal client timestamps without dividing by zero', () => {
    beginHalfStreamingProgress(target)
    recordHalfStreamingToken(target, 1_000, { generatedTokens: 0 })
    recordHalfStreamingToken(target, 6_000, { generatedTokens: 10 })
    recordHalfStreamingToken(target, 6_000, { generatedTokens: 20 })
    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 20, tokensPerSecond: 0 })

    recordHalfStreamingToken(target, 7_000, { generatedTokens: 30 })
    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 30, tokensPerSecond: 10 })
  })

  it('interpolates the cumulative count at the five-second window boundary', () => {
    beginHalfStreamingProgress(target)
    recordHalfStreamingToken(target, 0, { generatedTokens: 10 })
    recordHalfStreamingToken(target, 4_000, { generatedTokens: 30 })
    recordHalfStreamingToken(target, 6_000, { generatedTokens: 70 })

    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 70, tokensPerSecond: 11 })
  })

  it('drops the rolling speed when a later sample adds no tokens', () => {
    beginHalfStreamingProgress(target)
    recordHalfStreamingToken(target, 0, { generatedTokens: 10 })
    recordHalfStreamingToken(target, 1_000, { generatedTokens: 20 })
    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 20, tokensPerSecond: 10 })

    recordHalfStreamingToken(target, 6_000, { generatedTokens: 20 })
    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 20, tokensPerSecond: 0 })
  })

  it.each(['generation-1', 'generation-2'])('resets count and timing when beginning %s', (generationId) => {
    beginHalfStreamingProgress(target)
    recordHalfStreamingToken(target, 2_000, { generatedTokens: 100 })
    recordHalfStreamingToken(target, 3_000, { generatedTokens: 200 })

    const nextTarget = { ...target, generationId }
    beginHalfStreamingProgress(nextTarget)
    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 0, tokensPerSecond: 0 })
    recordHalfStreamingToken(nextTarget, 20_000, { generatedTokens: 2 })
    recordHalfStreamingToken(nextTarget, 21_000, { generatedTokens: 12 })

    expect(get(halfStreamingProgress)[0]).toMatchObject({ generatedTokens: 12, tokensPerSecond: 10 })
  })

  it('does not let an old generation clear a newer generation', () => {
    beginHalfStreamingProgress(target)
    beginHalfStreamingProgress({ ...target, generationId: 'generation-2' })

    clearHalfStreamingProgress(target)

    expect(get(halfStreamingProgress)).toEqual([expect.objectContaining({ generationId: 'generation-2' })])
  })

  it('keeps interleaved chat throughput independent and cannot revive a completed target', () => {
    const otherTarget = {
      characterId: 'char-2',
      chatId: 'chat-2',
      generationId: 'generation-2',
    }
    beginHalfStreamingProgress(target)
    beginHalfStreamingProgress(otherTarget)

    recordHalfStreamingToken(target, 2_000, { generatedTokens: 4 })
    recordHalfStreamingToken(otherTarget, 3_000, { generatedTokens: 9 })
    recordHalfStreamingToken(target, 4_000, { generatedTokens: 12 })
    recordHalfStreamingToken(otherTarget, 5_000, { generatedTokens: 18 })

    expect(get(halfStreamingProgress)).toEqual([
      expect.objectContaining({ chatId: 'chat-1', generatedTokens: 12, tokensPerSecond: 4 }),
      expect.objectContaining({ chatId: 'chat-2', generatedTokens: 18, tokensPerSecond: 4.5 }),
    ])

    clearHalfStreamingProgress(target)
    recordHalfStreamingToken(target, 5_000, { generatedTokens: 20 })

    expect(get(halfStreamingProgress)).toEqual([
      expect.objectContaining({ chatId: 'chat-2', generatedTokens: 18, tokensPerSecond: 4.5 }),
    ])
  })

  it('bounds retained live generations and ignores an evicted target', () => {
    const targets = Array.from({ length: 17 }, (_, index) => ({
      characterId: `char-${index}`,
      chatId: `chat-${index}`,
      generationId: `generation-${index}`,
    }))
    targets.forEach((progressTarget) => beginHalfStreamingProgress(progressTarget))

    recordHalfStreamingToken(targets[0], 2_000, { generatedTokens: 5 })

    const progress = get(halfStreamingProgress)
    expect(progress).toHaveLength(16)
    expect(progress.some((entry) => entry.generationId === 'generation-0')).toBe(false)
  })
})
