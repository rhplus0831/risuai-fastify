import { describe, expect, it, vi } from 'vitest'
import { MessageTranslationJobRegistry } from '../src/messageTranslationJobs.js'

describe('MessageTranslationJobRegistry', () => {
  it('keeps the same job id from running through terminal success', () => {
    const registry = new MessageTranslationJobRegistry()
    const job = registry.register({ chatId: 'chat-a', messageId: 'message-a' })

    expect(registry.translations()).toEqual([
      {
        chatId: 'chat-a',
        messageId: 'message-a',
        jobId: job.jobId,
        status: 'running',
      },
    ])

    job.succeed()

    expect(registry.translations()).toEqual([
      {
        chatId: 'chat-a',
        messageId: 'message-a',
        jobId: job.jobId,
        status: 'succeeded',
        completedAt: expect.any(Number),
      },
    ])
  })

  it('retains a safe bounded failure message', () => {
    const registry = new MessageTranslationJobRegistry()
    const job = registry.register({ chatId: 'chat-a', messageId: 'message-a' })

    job.fail(new Error(`Bearer secret-token sk-test_123456789 ${'x'.repeat(600)}`))

    const [failure] = registry.translations()
    expect(failure).toMatchObject({
      chatId: 'chat-a',
      messageId: 'message-a',
      jobId: job.jobId,
      status: 'failed',
      completedAt: expect.any(Number),
    })
    expect(failure.error).not.toContain('secret-token')
    expect(failure.error).not.toContain('sk-test_123456789')
    expect(failure.error?.length).toBeLessThanOrEqual(500)
  })

  it('makes the last registered operation current for a message', () => {
    const registry = new MessageTranslationJobRegistry()
    const older = registry.register({ chatId: 'chat-a', messageId: 'message-a', jobId: 'job-a' })
    const current = registry.register({ chatId: 'chat-a', messageId: 'message-a', jobId: 'job-b' })

    expect(older.isCurrent()).toBe(false)
    expect(current.isCurrent()).toBe(true)
    expect(registry.translations()).toEqual([
      {
        chatId: 'chat-a',
        messageId: 'message-a',
        jobId: 'job-b',
        status: 'running',
      },
    ])

    older.succeed()
    expect(registry.translations()[0]).toMatchObject({ jobId: 'job-b', status: 'running' })
    current.succeed()
    expect(current.isCurrent()).toBe(false)
  })

  it('expires terminal outcomes after the retention window', () => {
    vi.useFakeTimers()
    try {
      const registry = new MessageTranslationJobRegistry()
      const job = registry.register({ chatId: 'chat-a', messageId: 'message-a' })
      job.succeed()

      vi.advanceTimersByTime(10 * 60_000 + 1)

      expect(registry.translations()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts cooperative work and drains every tracked continuation before stopping', async () => {
    const registry = new MessageTranslationJobRegistry()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const abort = vi.fn()
    const job = registry.register({ chatId: 'chat-a', messageId: 'message-a', abort })
    const task = registry.track(
      gate.then(() => {
        job.succeed()
      }),
    )

    let stopped = false
    const stop = registry.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(abort).toHaveBeenCalledOnce()
    expect(stopped).toBe(false)
    expect(() => registry.register({ chatId: 'chat-b', messageId: 'message-b' })).toThrow(
      'Message translation registry is shutting down',
    )

    release()
    await task
    await stop
    expect(stopped).toBe(true)
  })
})
