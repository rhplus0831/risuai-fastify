import { describe, expect, it } from 'vitest'
import { createInitialDisplayReadiness, shouldAwaitInitialDisplayParse } from './initialDisplayReadiness'

function createHarness() {
  const pendingChanges: boolean[] = []
  const renderWaiters: Array<() => void> = []
  const readiness = createInitialDisplayReadiness(
    (pending) => pendingChanges.push(pending),
    () =>
      new Promise<void>((resolve) => {
        renderWaiters.push(resolve)
      }),
  )

  return {
    pendingChanges,
    readiness,
    async flushRenderWaiters() {
      const waiters = renderWaiters.splice(0)
      for (const resolve of waiters) resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    renderWaiters,
  }
}

describe('initial transcript display readiness', () => {
  it('tracks only the newest three messages in an initial transcript', () => {
    expect([0, 1, 2, 3].map((index) => shouldAwaitInitialDisplayParse(index, 4))).toEqual([false, true, true, true])
    expect(shouldAwaitInitialDisplayParse(0, 1)).toBe(true)
    expect(shouldAwaitInitialDisplayParse(0, 0)).toBe(false)
  })

  it('keeps the cold transcript pending until every registered parse settles', async () => {
    const harness = createHarness()
    const first = Symbol('first')
    const second = Symbol('second')

    harness.readiness.updateScope('chat-a', true, false)
    harness.readiness.start('chat-a', first)
    harness.readiness.start('chat-a', second)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([true])

    harness.readiness.settle('chat-a', first)
    expect(harness.renderWaiters).toHaveLength(0)

    harness.readiness.settle('chat-a', second)
    expect(harness.renderWaiters).toHaveLength(1)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([true, false])
  })

  it('ignores stale settlements after switching chat scopes', async () => {
    const harness = createHarness()
    const stale = Symbol('stale')
    const current = Symbol('current')

    harness.readiness.updateScope('chat-a', true, false)
    harness.readiness.start('chat-a', stale)
    harness.readiness.updateScope('chat-b', true, false)
    harness.readiness.start('chat-b', current)
    harness.readiness.settle('chat-a', stale)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([true])

    harness.readiness.settle('chat-b', current)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([true, false])
  })

  it('clears after one render when the initial rows do not mount parsed bodies and ignores later reparses', async () => {
    const harness = createHarness()

    harness.readiness.updateScope('chat-a', true, false)
    await harness.flushRenderWaiters()
    expect(harness.pendingChanges).toEqual([true, false])

    harness.readiness.start('chat-a', Symbol('later-reparse'))
    expect(harness.pendingChanges).toEqual([true, false])
  })

  it('keeps a settled empty transcript ready when its first message is appended', async () => {
    const harness = createHarness()
    const firstMessage = Symbol('first-message')

    harness.readiness.updateScope('chat-a', false, true)
    harness.readiness.updateScope('chat-a', false, false)
    harness.readiness.updateScope('chat-a', true, false)
    harness.readiness.start('chat-a', firstMessage)
    harness.readiness.settle('chat-a', firstMessage)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([])
    expect(harness.renderWaiters).toHaveLength(0)
  })

  it('collects initial parses when an unresolved empty shell receives persisted rows', async () => {
    const harness = createHarness()
    const hydratedMessage = Symbol('hydrated-message')

    harness.readiness.updateScope('chat-a', false, true)
    harness.readiness.updateScope('chat-a', true, false)
    harness.readiness.start('chat-a', hydratedMessage)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([true])

    harness.readiness.settle('chat-a', hydratedMessage)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([true, false])
  })

  it('restarts initial display readiness after a ready transcript is re-stubbed', async () => {
    const harness = createHarness()
    const hydratedMessage = Symbol('hydrated-message')

    harness.readiness.updateScope('chat-a', false, false)
    harness.readiness.updateScope('chat-a', false, true)
    harness.readiness.updateScope('chat-a', true, false)
    harness.readiness.start('chat-a', hydratedMessage)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([true])

    harness.readiness.settle('chat-a', hydratedMessage)
    await harness.flushRenderWaiters()

    expect(harness.pendingChanges).toEqual([true, false])
  })
})
