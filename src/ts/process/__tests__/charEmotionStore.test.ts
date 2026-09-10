import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { CharEmotion } from '../../stores.svelte'
import { loadAndTrimCharEmotion, pushCharEmotionEntry, type CharEmotionEntry } from '../postGeneration/charEmotionStore'

describe('loadAndTrimCharEmotion', () => {
  beforeEach(() => {
    CharEmotion.set({})
  })

  it('returns an empty tempEmotion when no prior entry exists for chaId', () => {
    const { tempEmotion, charemotions } = loadAndTrimCharEmotion('cha-1')
    expect(tempEmotion).toEqual([])
    expect(charemotions).toEqual({})
  })

  it('returns the existing emotion history unchanged when length < 5', () => {
    const initial: CharEmotionEntry[] = [
      ['e1', 'e1.png', 100],
      ['e2', 'e2.png', 200],
    ]
    CharEmotion.set({ 'cha-1': initial })
    const { tempEmotion } = loadAndTrimCharEmotion('cha-1')
    expect(tempEmotion).toEqual([
      ['e1', 'e1.png', 100],
      ['e2', 'e2.png', 200],
    ])
    expect(get(CharEmotion)['cha-1']).toEqual(tempEmotion)
  })

  it('does not trim at the > 4 boundary (length 4 is preserved)', () => {
    const initial: CharEmotionEntry[] = [
      ['e1', 'e1.png', 100],
      ['e2', 'e2.png', 200],
      ['e3', 'e3.png', 300],
      ['e4', 'e4.png', 400],
    ]
    CharEmotion.set({ 'cha-1': initial })
    const { tempEmotion } = loadAndTrimCharEmotion('cha-1')
    expect(tempEmotion).toEqual(initial)
    expect(get(CharEmotion)['cha-1']).toEqual(tempEmotion)
  })

  it('splices the oldest entry when length > 4', () => {
    const initial: CharEmotionEntry[] = [
      ['e1', 'e1.png', 100],
      ['e2', 'e2.png', 200],
      ['e3', 'e3.png', 300],
      ['e4', 'e4.png', 400],
      ['e5', 'e5.png', 500],
    ]
    CharEmotion.set({ 'cha-1': initial })
    const { tempEmotion } = loadAndTrimCharEmotion('cha-1')
    expect(tempEmotion).toEqual([
      ['e2', 'e2.png', 200],
      ['e3', 'e3.png', 300],
      ['e4', 'e4.png', 400],
      ['e5', 'e5.png', 500],
    ])
    expect(get(CharEmotion)['cha-1']).toEqual(tempEmotion)
  })
})

describe('pushCharEmotionEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(1000))
    CharEmotion.set({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushes a [name, image, Date.now()] tuple onto tempEmotion', () => {
    const tempEmotion: CharEmotionEntry[] = []
    const charemotions = {}
    pushCharEmotionEntry({
      emoTuple: ['happy', 'h.png'],
      tempEmotion,
      charemotions,
      chaId: 'cha-1',
    })
    expect(tempEmotion).toEqual([['happy', 'h.png', 1000]])
  })

  it('propagates the update via CharEmotion.set so subscribers fire', () => {
    let lastValue: unknown = null
    const unsub = CharEmotion.subscribe((v) => {
      lastValue = v
    })
    pushCharEmotionEntry({
      emoTuple: ['happy', 'h.png'],
      tempEmotion: [],
      charemotions: {},
      chaId: 'cha-1',
    })
    unsub()
    expect(lastValue).toEqual({ 'cha-1': [['happy', 'h.png', 1000]] })
    expect(get(CharEmotion)).toEqual({ 'cha-1': [['happy', 'h.png', 1000]] })
  })

  it('appends rather than replacing when tempEmotion already has entries', () => {
    const tempEmotion: CharEmotionEntry[] = [['prior', 'p.png', 500]]
    pushCharEmotionEntry({
      emoTuple: ['happy', 'h.png'],
      tempEmotion,
      charemotions: { 'cha-1': tempEmotion },
      chaId: 'cha-1',
    })
    expect(tempEmotion).toEqual([
      ['prior', 'p.png', 500],
      ['happy', 'h.png', 1000],
    ])
  })
})
