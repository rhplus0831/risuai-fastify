import { resetClientSessionForTests } from '../../clientSession'
import { setManagedWriterForTest, demoteAndRepromoteForTest } from '../../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requestChatDataSpy, tokenizeNumSpy } = vi.hoisted(() => ({
  requestChatDataSpy: vi.fn(),
  tokenizeNumSpy: vi.fn(),
}))

vi.mock('../request/request', () => ({
  requestChatData: requestChatDataSpy,
}))

vi.mock('../../tokenizer', () => ({
  tokenizeNum: tokenizeNumSpy,
}))

vi.mock('../modules', async (importActual) => {
  const actual = await importActual<typeof import('../modules')>()
  return { ...actual, moduleUpdate: () => {} }
})

import { get } from 'svelte/store'
import { CharEmotion } from '../../stores.svelte'
import type { Database, character } from '../../storage/database.svelte'
import { runEmotionLlmFallback } from '../postGeneration/emotionFallbackLlm'
import type { CharEmotionEntry, CharEmotionMap } from '../postGeneration/charEmotionStore'

function makeChar(emotionImages: [string, string][]): character {
  return {
    chaId: 'cha-1',
    emotionImages,
  } as unknown as character
}

function freshState(): { database: Database; tempEmotion: CharEmotionEntry[]; charemotions: CharEmotionMap } {
  return { database: {} as Database, tempEmotion: [], charemotions: {} }
}

describe('runEmotionLlmFallback', () => {
  let throwErrorSpy: ReturnType<typeof vi.fn<(msg: string) => void>>
  let mathRandomSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetClientSessionForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(1000))
    CharEmotion.set({})
    requestChatDataSpy.mockReset()
    tokenizeNumSpy.mockReset()
    tokenizeNumSpy.mockImplementation((s: string) => Promise.resolve([s.length]))
    throwErrorSpy = vi.fn<(msg: string) => void>()
    // Stable shuffle for prompt-shape assertions: Math.random() === 0 ⇒
    // shuffleArray's `Math.floor(0 * n) === 0`, so each iteration swaps with
    // index 0, producing a deterministic but order-permuting result.
    mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    mathRandomSpy.mockRestore()
  })

  it('does not start an emotion provider request after delayed tokenization loses writer access', async () => {
    setManagedWriterForTest()
    let release!: (value: number[]) => void
    tokenizeNumSpy.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...freshState(),
    })
    demoteAndRepromoteForTest()
    release([1])
    await pending
    expect(requestChatDataSpy).not.toHaveBeenCalled()
    expect(get(CharEmotion)).toEqual({})
    expect(throwErrorSpy).not.toHaveBeenCalled()
  })

  it('calls requestChatData with mode emotion, the shuffled emotion list, the one-shot example, and the assistant result', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'happy' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'response text',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(requestChatDataSpy).toHaveBeenCalledTimes(1)
    const [arg, mode, signal] = requestChatDataSpy.mock.calls[0]
    expect(mode).toBe('emotion')
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(arg.maxTokens).toBe(30)
    expect(arg.database).toBe(state.database)
    expect(tokenizeNumSpy).toHaveBeenCalledWith('happy', state.database)
    expect(arg.formated[0].role).toBe('system')
    expect(arg.formated[0].content).toContain('happy')
    expect(arg.formated[1]).toMatchObject({ role: 'user', content: expect.stringContaining('Good morning') })
    expect(arg.formated[2]).toMatchObject({ role: 'assistant', content: 'happy' })
    expect(arg.formated[3]).toMatchObject({ role: 'user', content: 'response text' })
  })

  it('uses opts.emotionPrompt2 in the system message when provided', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'happy' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      emotionPrompt2: 'CUSTOM-PROMPT',
      ...state,
    })
    const [arg] = requestChatDataSpy.mock.calls[0]
    expect(arg.formated[0].content.startsWith('CUSTOM-PROMPT')).toBe(true)
  })

  it('builds emobias with +10 per emotion-list token and recency penalties on tempEmotion tokens', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'a' })
    // tokenizeNum mock: each word returns [s.length].
    // emotionList ['a','b'] -> tokens 1,1 (both map to key 1, last write wins -> 10)
    // tempEmotion [['a',...]] -> recency penalty for length=1, i=0:
    //   modifier = 20 - (1 - 1) * 5 = 20
    //   emobias[1] -= 20 -> -10
    const state: { database: Database; tempEmotion: CharEmotionEntry[]; charemotions: CharEmotionMap } = {
      database: {} as Database,
      tempEmotion: [['a', 'a.png', 500]],
      charemotions: { 'cha-1': [['a', 'a.png', 500]] },
    }
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([
        ['a', 'a.png'],
        ['b', 'b.png'],
      ]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    const [arg] = requestChatDataSpy.mock.calls[0]
    expect(arg.bias).toEqual({ 1: -10 })
    expect(tokenizeNumSpy.mock.calls.every(([, database]) => database === state.database)).toBe(true)
  })

  it('on fail with no abort, calls throwError(rq.result)', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'fail', result: 'upstream broken' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(throwErrorSpy).toHaveBeenCalledWith('upstream broken')
  })

  it('on fail with abort, does not call throwError', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'fail', result: 'upstream broken' })
    const controller = new AbortController()
    controller.abort()
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: controller.signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(throwErrorSpy).not.toHaveBeenCalled()
  })

  it('on streaming, calls throwError with Unexpected response type', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'streaming', result: new ReadableStream() })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(throwErrorSpy).toHaveBeenCalledWith('Unexpected response type')
  })

  it('on multiline, calls throwError with Unexpected response type', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'multiline', result: [['user', 'a']] })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(throwErrorSpy).toHaveBeenCalledWith('Unexpected response type')
  })

  it('exact-match strategy: response equals an emotion name → pushes that emotion', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'happy' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([
        ['happy', 'h.png'],
        ['sad', 's.png'],
      ]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(get(CharEmotion)).toEqual({ 'cha-1': [['happy', 'h.png', 1000]] })
  })

  it('exact-match is tried before substring (response "happy" matches exact, not substring)', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'happy' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([
        ['hap', 'hap.png'],
        ['happy', 'happy.png'],
      ]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(get(CharEmotion)).toEqual({ 'cha-1': [['happy', 'happy.png', 1000]] })
  })

  it('substring strategy: response contains an emotion name as substring → pushes that emotion', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'verysadindeed' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([
        ['happy', 'h.png'],
        ['sad', 's.png'],
      ]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(get(CharEmotion)).toEqual({ 'cha-1': [['sad', 's.png', 1000]] })
  })

  it('neutral fallback: no exact/substring match but neutral is in the list → pushes neutral', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'zzz' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([
        ['happy', 'h.png'],
        ['sad', 's.png'],
        ['neutral', 'n.png'],
      ]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(get(CharEmotion)).toEqual({ 'cha-1': [['neutral', 'n.png', 1000]] })
  })

  it('no match anywhere AND no neutral: no push, no error', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'zzz' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([
        ['happy', 'h.png'],
        ['sad', 's.png'],
      ]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(get(CharEmotion)).toEqual({})
    expect(throwErrorSpy).not.toHaveBeenCalled()
  })

  it('normalizes whitespace + newlines + case on the LLM response before matching', async () => {
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: '  HaP\nPy  ' })
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(get(CharEmotion)).toEqual({ 'cha-1': [['happy', 'h.png', 1000]] })
  })

  it('on parse error (rq.result.replace throws), calls throwError with httpError prefix', async () => {
    requestChatDataSpy.mockResolvedValue({
      type: 'success',
      get result(): string {
        throw new Error('forced')
      },
    } as unknown as Awaited<ReturnType<typeof requestChatDataSpy>>)
    const state = freshState()
    await runEmotionLlmFallback({
      result: 'r',
      currentChar: makeChar([['happy', 'h.png']]),
      abortSignal: new AbortController().signal,
      throwError: throwErrorSpy,
      ...state,
    })
    expect(throwErrorSpy).toHaveBeenCalledTimes(1)
    expect(throwErrorSpy.mock.calls[0][0]).toMatch(/forced/)
  })
})
