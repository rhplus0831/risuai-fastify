import { describe, expect, it } from 'vitest'
import { createChatDisplayScheduler } from './chatDisplayScheduler'
import { createInitialDisplayReadiness } from './initialDisplayReadiness'

function harness() {
  const callbacks = new Set<() => void>()
  const scheduler = createChatDisplayScheduler((run) => {
    callbacks.add(run)
    return () => callbacks.delete(run)
  })
  scheduler.setScope('chat-a')
  return {
    scheduler,
    callbacks,
    async frame() {
      const current = [...callbacks]
      callbacks.clear()
      current.forEach((run) => run())
      for (let i = 0; i < 5; i++) await Promise.resolve()
    },
  }
}

describe('progressive chat display', () => {
  it('releases older rows after critical display settles, one completed parse per idle turn', async () => {
    const h = harness()
    const readiness = createInitialDisplayReadiness(
      (pending) => h.scheduler.setPaused(pending),
      () => Promise.resolve(),
    )
    readiness.updateScope('chat-a', true, false)
    const critical = Symbol()
    readiness.start('chat-a', critical)
    const started: number[] = []
    let finish!: () => void
    const first = h.scheduler.run(async () => {
      started.push(1)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return 'first'
    }, new AbortController().signal)
    const second = h.scheduler.run(async () => {
      started.push(2)
      return 'second'
    }, new AbortController().signal)
    await h.frame()
    expect(started).toEqual([])
    readiness.settle('chat-a', critical)
    await Promise.resolve()
    await h.frame()
    expect(started).toEqual([1])
    await h.frame()
    expect(started).toEqual([1])
    finish()
    await first
    await h.frame()
    await h.frame()
    await expect(second).resolves.toBe('second')
    expect(started).toEqual([1, 2])
    h.scheduler.destroy()
  })

  it('drops cancelled, switched and destroyed queued work without blocking a new chat', async () => {
    const h = harness()
    const started: string[] = []
    const controller = new AbortController()
    const cancelled = h.scheduler.run(async () => {
      started.push('cancelled')
      return true
    }, controller.signal)
    controller.abort()
    await expect(cancelled).resolves.toBeUndefined()
    const old = h.scheduler.run(async () => {
      started.push('old')
      return true
    }, new AbortController().signal)
    h.scheduler.setScope('chat-b')
    await expect(old).resolves.toBeUndefined()
    h.scheduler.setPaused(false)
    const current = h.scheduler.run(async () => {
      started.push('current')
      return true
    }, new AbortController().signal)
    await h.frame()
    await expect(current).resolves.toBe(true)
    const last = h.scheduler.run(async () => {
      started.push('destroyed')
      return true
    }, new AbortController().signal)
    h.scheduler.destroy()
    await h.frame()
    await expect(last).resolves.toBeUndefined()
    expect(started).toEqual(['current'])
  })

  it('promotes a newly visible queued row ahead of older background work', async () => {
    const h = harness()
    h.scheduler.setPaused(false)
    const started: string[] = []
    const queued = ['oldest', 'visible', 'middle'].map((key) =>
      h.scheduler.run(
        async () => {
          started.push(key)
          return key
        },
        new AbortController().signal,
        key,
      ),
    )
    h.scheduler.setVisible(['visible'])
    await h.frame()
    expect(started).toEqual(['visible'])
    await h.frame()
    await h.frame()
    await h.frame()
    await Promise.all(queued)
    expect(started).toEqual(['visible', 'oldest', 'middle'])
  })
})
