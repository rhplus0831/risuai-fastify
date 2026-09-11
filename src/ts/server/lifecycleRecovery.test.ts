import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeBrowserLifecycleRecovery } from './lifecycleRecovery'

const cleanups: Array<() => void> = []
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState')

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  if (originalVisibilityState) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityState)
  } else {
    Reflect.deleteProperty(document, 'visibilityState')
  }
})

describe('browser lifecycle recovery', () => {
  it('coalesces one foreground event burst for every recovery domain', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const generation = vi.fn()
    const resources = vi.fn()
    cleanups.push(subscribeBrowserLifecycleRecovery(generation))
    cleanups.push(subscribeBrowserLifecycleRecovery(resources))

    document.dispatchEvent(new Event('visibilitychange'))
    const pageShow = new PageTransitionEvent('pageshow')
    Object.defineProperty(pageShow, 'persisted', { value: true })
    window.dispatchEvent(pageShow)
    await Promise.resolve()

    expect(generation).toHaveBeenCalledOnce()
    expect(generation).toHaveBeenCalledWith('pageshow', { suspensionEvidence: true })
    expect(resources).toHaveBeenCalledOnce()
    expect(resources).toHaveBeenCalledWith('pageshow', { suspensionEvidence: true })
  })

  it('suppresses hidden visibility changes and reports online and focus recovery separately', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const listener = vi.fn()
    cleanups.push(subscribeBrowserLifecycleRecovery(listener))

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()

    expect(listener.mock.calls).toEqual([
      ['online', { suspensionEvidence: true }],
      ['focus', { suspensionEvidence: false }],
    ])
  })

  it('isolates a throwing recovery domain from the remaining subscribers', async () => {
    const failure = new Error('generation recovery failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      cleanups.push(
        subscribeBrowserLifecycleRecovery(() => {
          throw failure
        }),
      )
      const resources = vi.fn()
      cleanups.push(subscribeBrowserLifecycleRecovery(resources))

      window.dispatchEvent(new Event('online'))
      await Promise.resolve()

      expect(consoleError).toHaveBeenCalledWith(failure)
      expect(resources).toHaveBeenCalledWith('online', { suspensionEvidence: true })
    } finally {
      consoleError.mockRestore()
    }
  })

  it('cancels queued work after the final unsubscribe and reinstalls cleanly', async () => {
    const abandoned = vi.fn()
    const unsubscribe = subscribeBrowserLifecycleRecovery(abandoned)
    window.dispatchEvent(new Event('online'))
    unsubscribe()
    await Promise.resolve()
    expect(abandoned).not.toHaveBeenCalled()

    const reinstalled = vi.fn()
    cleanups.push(subscribeBrowserLifecycleRecovery(reinstalled))
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(reinstalled).toHaveBeenCalledWith('focus', { suspensionEvidence: false })
  })

  it('latches pagehide evidence until the next foreground signal', async () => {
    const listener = vi.fn()
    cleanups.push(subscribeBrowserLifecycleRecovery(listener))

    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()

    expect(listener.mock.calls).toEqual([
      ['focus', { suspensionEvidence: true }],
      ['focus', { suspensionEvidence: false }],
    ])
  })
})
