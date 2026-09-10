import { afterEach, describe, expect, it, vi } from 'vitest'

import { installMonacoWorkerErrorEventFilter, isMonacoWorkerErrorEvent } from './monacoWorkerErrors'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('monaco worker error handling', () => {
  it('filters raw Worker error events before Monaco rethrows them as uncaught Events', () => {
    class TestWorker {}
    vi.stubGlobal('Worker', TestWorker)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const originalUnexpectedErrorHandler = vi.fn()
    const handler = {
      unexpectedErrorHandler: originalUnexpectedErrorHandler,
    }
    const workerError = new Event('error')
    Object.defineProperty(workerError, 'target', { value: new TestWorker() })
    const normalError = new Error('real editor failure')

    expect(isMonacoWorkerErrorEvent(workerError)).toBe(true)

    installMonacoWorkerErrorEventFilter(handler)
    handler.unexpectedErrorHandler(workerError)
    handler.unexpectedErrorHandler(normalError)

    expect(consoleWarn).toHaveBeenCalledOnce()
    const [diagnostic, warnedEvent] = consoleWarn.mock.calls[0]!
    expect(typeof diagnostic === 'string' && diagnostic.trim().length > 0).toBe(true)
    expect(warnedEvent).toBe(workerError)
    expect(originalUnexpectedErrorHandler).toHaveBeenCalledOnce()
    expect(originalUnexpectedErrorHandler).toHaveBeenCalledWith(normalError)
  })
})
