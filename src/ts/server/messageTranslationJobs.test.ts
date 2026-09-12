import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bootstrapMocks = vi.hoisted(() => ({
  fetchServerBootstrapReadOnly: vi.fn(),
}))

vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: vi.fn() }))
vi.mock('../translator/translator', () => ({ getTranslatorSettingsSignatureKey: () => 'settings-a' }))

vi.mock('./bootstrap', () => ({
  fetchServerBootstrapReadOnly: bootstrapMocks.fetchServerBootstrapReadOnly,
}))

import {
  activeMessageTranslations,
  beginActiveMessageTranslation,
  clearMessageTranslationJob,
  isCurrentMessageTranslationJob,
  publishSettledMessageTranslation,
  setActiveMessageTranslations,
  startActiveMessageTranslationRefresh,
  stopActiveMessageTranslationRefresh,
} from './messageTranslationJobs'

describe('active message translation refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopActiveMessageTranslationRefresh()
    bootstrapMocks.fetchServerBootstrapReadOnly.mockReset()
    setActiveMessageTranslations([])
  })

  afterEach(() => {
    stopActiveMessageTranslationRefresh()
    for (const job of get(activeMessageTranslations)) clearMessageTranslationJob(job.jobId)
    setActiveMessageTranslations([])
    vi.useRealTimers()
  })

  it('publishes a local operation before the request and rejects a second mounted starter', () => {
    expect(
      beginActiveMessageTranslation({
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: 'job-a',
        status: 'running',
      }),
    ).toBe(true)
    expect(
      beginActiveMessageTranslation({
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: 'job-b',
        status: 'running',
      }),
    ).toBe(false)
    expect(isCurrentMessageTranslationJob('msg-a', 'job-a')).toBe(true)
    expect(isCurrentMessageTranslationJob('msg-a', 'job-b')).toBe(false)
    expect(get(activeMessageTranslations)).toEqual([
      { chatId: 'chat-a', messageId: 'msg-a', jobId: 'job-a', status: 'running' },
    ])

    // A bootstrap refresh racing before server registration must not erase the
    // local ownership entry.
    setActiveMessageTranslations([])
    expect(isCurrentMessageTranslationJob('msg-a', 'job-a')).toBe(true)
  })

  it('refreshes bootstrap translations and retains a detached failure for the row', async () => {
    const failedJob = {
      chatId: 'chat-a',
      messageId: 'msg-a',
      jobId: 'job-a',
      status: 'failed' as const,
      error: 'provider rejected the request',
      completedAt: 123,
    }
    bootstrapMocks.fetchServerBootstrapReadOnly.mockResolvedValue({
      status: 'ok',
      bootstrap: {
        initialized: true,
        revision: 1,
        activeMessageTranslations: [failedJob],
      },
    })

    startActiveMessageTranslationRefresh()
    setActiveMessageTranslations([{ chatId: 'chat-a', messageId: 'msg-a', jobId: 'job-a', status: 'running' }])

    await vi.advanceTimersByTimeAsync(5_000)

    expect(bootstrapMocks.fetchServerBootstrapReadOnly).toHaveBeenCalledWith(null, {
      cacheRevision: false,
    })
    expect(get(activeMessageTranslations)).toEqual([failedJob])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(bootstrapMocks.fetchServerBootstrapReadOnly).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending refresh timer when stopped', async () => {
    startActiveMessageTranslationRefresh()
    setActiveMessageTranslations([{ chatId: 'chat-a', messageId: 'msg-a', jobId: 'job-a', status: 'running' }])

    stopActiveMessageTranslationRefresh()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(bootstrapMocks.fetchServerBootstrapReadOnly).not.toHaveBeenCalled()
  })
})

// Both detached translation consumers must retire reads across terminal and
// lifecycle changes. Keep the store, polling and sibling owner implementations real.
import {
  activeGreetingTranslations,
  clearGreetingTranslationJob,
  publishSettledGreetingTranslation,
  setActiveGreetingTranslations,
  startActiveGreetingTranslationRefresh,
  stopActiveGreetingTranslationRefresh,
} from './greetingTranslations.svelte'

for (const family of ['message', 'greeting'] as const) {
  describe(`${family} translation held refresh recovery`, () => {
    const job = {
      chatId: 'chat-a',
      messageId: 'msg-a',
      characterId: 'char-a',
      greetingIndex: -1,
      settingsHash: 'settings-a',
      jobId: 'job-a',
      status: 'running' as const,
    }
    const set = (jobs: (typeof job)[]) =>
      family === 'message' ? setActiveMessageTranslations(jobs) : setActiveGreetingTranslations(jobs)
    const read = () => (family === 'message' ? get(activeMessageTranslations) : get(activeGreetingTranslations))
    const start = family === 'message' ? startActiveMessageTranslationRefresh : startActiveGreetingTranslationRefresh
    const stop = family === 'message' ? stopActiveMessageTranslationRefresh : stopActiveGreetingTranslationRefresh
    const clear = family === 'message' ? clearMessageTranslationJob : clearGreetingTranslationJob
    const response = (jobs: unknown[]) => ({
      status: 'ok',
      bootstrap: {
        [family === 'message' ? 'activeMessageTranslations' : 'activeGreetingTranslations']: jobs,
      },
    })

    beforeEach(() => {
      vi.useFakeTimers()
      stop()
      for (const value of read()) clear(value.jobId)
      bootstrapMocks.fetchServerBootstrapReadOnly.mockReset()
    })
    afterEach(() => {
      stop()
      for (const value of read()) clear(value.jobId)
      vi.useRealTimers()
    })

    it.each(['succeeded', 'failed'] as const)('cannot revive a %s job from a held running snapshot', async (status) => {
      let release!: (value: unknown) => void
      bootstrapMocks.fetchServerBootstrapReadOnly.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      set([job])
      start()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(bootstrapMocks.fetchServerBootstrapReadOnly).toHaveBeenCalledTimes(1)
      const terminal = { ...job, status, completedAt: 123 }
      if (family === 'message') publishSettledMessageTranslation(terminal)
      else publishSettledGreetingTranslation(terminal)
      release(response([job]))
      await vi.advanceTimersByTimeAsync(0)
      expect(read()).toEqual([terminal])
      await vi.advanceTimersByTimeAsync(20_000)
      expect(bootstrapMocks.fetchServerBootstrapReadOnly).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('lets a new refresh lifecycle settle before the retired read and ignores its late failure', async () => {
      let release!: (value: unknown) => void
      bootstrapMocks.fetchServerBootstrapReadOnly.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      set([job])
      start()
      await vi.advanceTimersByTimeAsync(5_000)
      stop()
      clear(job.jobId)
      const replacement = { ...job, jobId: 'job-b' }
      const terminal = { ...replacement, status: 'succeeded', completedAt: 456 }
      bootstrapMocks.fetchServerBootstrapReadOnly.mockResolvedValueOnce(response([terminal]))
      set([replacement])
      start()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(read()).toEqual([terminal])
      release(response([{ ...job, status: 'failed', error: 'retired provider' }]))
      await vi.advanceTimersByTimeAsync(0)
      expect(read()).toEqual([terminal])
      await vi.advanceTimersByTimeAsync(20_000)
      expect(bootstrapMocks.fetchServerBootstrapReadOnly).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
}
