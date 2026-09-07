import { resetClientSessionForTests } from '../../clientSession'
import { setManagedWriterForTest, demoteAndRepromoteForTest } from '../../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { addTextSpy, similaritySearchScoredSpy } = vi.hoisted(() => ({
  addTextSpy: vi.fn<(texts: string[]) => Promise<void>>(),
  similaritySearchScoredSpy: vi.fn<(query: string) => Promise<[string, number][]>>(),
}))

vi.mock('../memory/hypamemory', () => ({
  HypaProcesser: class {
    addText = addTextSpy
    similaritySearchScored = similaritySearchScoredSpy
  },
}))

vi.mock('../modules', async (importActual) => {
  const actual = await importActual<typeof import('../modules')>()
  return { ...actual, moduleUpdate: () => {} }
})

import { get } from 'svelte/store'
import { CharEmotion } from '../../stores.svelte'
import type { character } from '../../storage/database.svelte'
import { runEmotionEmbeddingFallback } from '../postGeneration/emotionFallbackEmbedding'
import type { CharEmotionEntry, CharEmotionMap } from '../postGeneration/charEmotionStore'

function makeChar(emotionImages: [string, string][]): character {
  return {
    chaId: 'cha-1',
    emotionImages,
  } as unknown as character
}

function freshState(): { tempEmotion: CharEmotionEntry[]; charemotions: CharEmotionMap } {
  return { tempEmotion: [], charemotions: {} }
}

describe('runEmotionEmbeddingFallback', () => {
  beforeEach(() => {
    resetClientSessionForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2000))
    CharEmotion.set({})
    addTextSpy.mockReset()
    addTextSpy.mockResolvedValue(undefined)
    similaritySearchScoredSpy.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not project a held similarity result after writer loss and re-promotion', async () => {
    setManagedWriterForTest()
    let release!: (value: [string, number][]) => void
    similaritySearchScoredSpy.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = runEmotionEmbeddingFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      ...freshState(),
    })
    await vi.waitFor(() => expect(similaritySearchScoredSpy).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release([['emotion:happy', 1]])
    await pending
    expect(get(CharEmotion)).toEqual({})
  })

  it('feeds HypaProcesser an "emotion:"-prefixed list and searches with the result text', async () => {
    similaritySearchScoredSpy.mockResolvedValue([['emotion:happy', 0.9]])
    const state = freshState()
    await runEmotionEmbeddingFallback({
      result: 'I am content today',
      currentChar: makeChar([
        ['happy', 'h.png'],
        ['sad', 's.png'],
      ]),
      ...state,
    })
    expect(addTextSpy).toHaveBeenCalledWith(['emotion:happy', 'emotion:sad'])
    expect(similaritySearchScoredSpy).toHaveBeenCalledWith('I am content today')
  })

  it('strips the "emotion:" prefix before matching against emotionImages', async () => {
    similaritySearchScoredSpy.mockResolvedValue([
      ['emotion:happy', 0.9],
      ['emotion:sad', 0.1],
    ])
    const state = freshState()
    await runEmotionEmbeddingFallback({
      result: 'r',
      currentChar: makeChar([
        ['happy', 'h.png'],
        ['sad', 's.png'],
      ]),
      ...state,
    })
    expect(get(CharEmotion)).toEqual({ 'cha-1': [['happy', 'h.png', 2000]] })
  })

  it('picks the top-scored emotion after the recency penalty', async () => {
    // happy starts highest, but it's the most recent in tempEmotion, so it
    // gets the biggest penalty. sad takes the lead and gets pushed.
    similaritySearchScoredSpy.mockResolvedValue([
      ['emotion:happy', 0.5],
      ['emotion:sad', 0.49],
    ])
    const state = {
      tempEmotion: [['happy', 'h.png', 1000]] as CharEmotionEntry[],
      charemotions: { 'cha-1': [['happy', 'h.png', 1000]] as CharEmotionEntry[] },
    }
    await runEmotionEmbeddingFallback({
      result: 'r',
      currentChar: makeChar([
        ['happy', 'h.png'],
        ['sad', 's.png'],
      ]),
      ...state,
    })
    // recency penalty for happy at i=0, length=1: (5 - (1 - 1)) / 200 = 0.025
    // happy: 0.5 - 0.025 = 0.475 ; sad: 0.49 ; sad wins.
    expect(state.tempEmotion).toEqual([
      ['happy', 'h.png', 1000],
      ['sad', 's.png', 2000],
    ])
  })

  it('skips the penalty for tempEmotion entries not in the searched list', async () => {
    similaritySearchScoredSpy.mockResolvedValue([['emotion:happy', 0.5]])
    const state = {
      tempEmotion: [['unknown', 'u.png', 1000]] as CharEmotionEntry[],
      charemotions: { 'cha-1': [['unknown', 'u.png', 1000]] as CharEmotionEntry[] },
    }
    await runEmotionEmbeddingFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      ...state,
    })
    expect(state.tempEmotion).toEqual([
      ['unknown', 'u.png', 1000],
      ['happy', 'h.png', 2000],
    ])
  })

  it('no-ops when the top-scored emotion is not in currentChar.emotionImages', async () => {
    // Race-condition shape: emotionImages was just edited; the top result no
    // longer exists. Preserved behavior — no push, no error.
    similaritySearchScoredSpy.mockResolvedValue([['emotion:ghost', 0.9]])
    const state = freshState()
    await runEmotionEmbeddingFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      ...state,
    })
    expect(get(CharEmotion)).toEqual({})
    expect(state.tempEmotion).toEqual([])
  })

  it('handles an empty emotionImages without throwing', async () => {
    similaritySearchScoredSpy.mockResolvedValue([])
    const state = freshState()
    await runEmotionEmbeddingFallback({
      result: 'r',
      currentChar: makeChar([]),
      ...state,
    })
    expect(addTextSpy).toHaveBeenCalledWith([])
    expect(get(CharEmotion)).toEqual({})
  })
})
