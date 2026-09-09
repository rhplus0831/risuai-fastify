import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'
import { DisplaySourceQueue } from '../src/displaySourceQueue.js'

describe('display target scheduling', () => {
  it('lets priority work overtake waiting background targets without interleaving a running target or its request context', async () => {
    const queue = new DisplaySourceQueue()
    const context = new AsyncLocalStorage<string>()
    const calls: string[] = []
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const active = context.run('active', () =>
      queue.run(2, async () => {
        calls.push(`start:${context.getStore()}`)
        entered()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        calls.push(`end:${context.getStore()}`)
      }),
    )
    await started
    const background = context.run('background', () =>
      queue.run(2, async () => {
        calls.push(context.getStore()!)
      }),
    )
    const priority = context.run('priority', () =>
      queue.run(0, async () => {
        calls.push(context.getStore()!)
      }),
    )
    expect(calls).toEqual(['start:active'])
    release()
    await Promise.all([active, background, priority])
    expect(calls).toEqual(['start:active', 'end:active', 'priority', 'background'])
  })

  it('removes cancelled queued work and continues after a failed target', async () => {
    const queue = new DisplaySourceQueue()
    const controller = new AbortController()
    const cancelled = queue.run(
      0,
      async () => {
        throw new Error('must never run')
      },
      controller.signal,
    )
    const failure = new Error('cancelled')
    controller.abort(failure)
    await expect(cancelled).rejects.toBe(failure)
    await expect(
      queue.run(0, async () => {
        throw new Error('bad script')
      }),
    ).rejects.toThrow('bad script')
    await expect(queue.run(1, async () => 'next')).resolves.toBe('next')
  })
})
