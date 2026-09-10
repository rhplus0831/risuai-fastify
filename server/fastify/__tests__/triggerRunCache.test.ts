import { describe, expect, it, vi } from 'vitest'
import {
  createTriggerRunCache,
  getRecentTranscriptLower,
  getRecentTranscriptRaw,
  getRecentTranscriptStrictWords,
  invalidateTriggerTranscriptCache,
  type TriggerTranscriptChat,
} from '../src/prompt/triggerRunCache.js'

describe('trigger run cache', () => {
  it('reuses message-array identity until explicit invalidation', () => {
    const cache = createTriggerRunCache()
    const chat: TriggerTranscriptChat = {
      message: [{ data: 'Alpha beta' }, { data: 'Needle' }],
    }
    const slice = vi.spyOn(chat.message, 'slice')

    expect(getRecentTranscriptRaw(cache, chat, 2)).toBe('Alpha beta Needle')
    expect(getRecentTranscriptLower(cache, chat, 2)).toBe('alpha beta needle')
    expect(getRecentTranscriptStrictWords(cache, chat, 2)).toEqual(new Set(['Alpha', 'beta', 'Needle']))
    expect(slice).toHaveBeenCalledOnce()

    chat.message[1].data = 'Changed'
    expect(getRecentTranscriptRaw(cache, chat, 2)).toBe('Alpha beta Needle')

    invalidateTriggerTranscriptCache(cache)
    expect(getRecentTranscriptRaw(cache, chat, 2)).toBe('Alpha beta Changed')
    expect(slice).toHaveBeenCalledTimes(2)
  })
})
