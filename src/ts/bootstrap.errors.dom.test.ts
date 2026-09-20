import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./alert', () => ({ alertError: vi.fn() }))
import { createGlobalErrorHandlers } from './bootstrap'
import { alertError } from './alert'

beforeEach(() => vi.clearAllMocks())

describe('global bootstrap error handlers', () => {
  it('global handlers ignore null error events and undefined rejections without useless alerts', () => {
    const { errorHandler, rejectHandler } = createGlobalErrorHandlers()

    errorHandler(new ErrorEvent('error'))
    rejectHandler({ reason: undefined } as PromiseRejectionEvent)

    expect(alertError).not.toHaveBeenCalled()
  })

  it('resource-target global errors skip generic application alerts', () => {
    const { errorHandler } = createGlobalErrorHandlers()
    const event = new ErrorEvent('error', { error: new Error('asset failed') })
    Object.defineProperty(event, 'target', { value: document.createElement('img') })

    errorHandler(event)

    expect(alertError).not.toHaveBeenCalled()
  })

  it('useful global Error objects and message strings still alert', () => {
    const { errorHandler, rejectHandler } = createGlobalErrorHandlers()
    const error = new Error('useful error')

    errorHandler(new ErrorEvent('error', { error }))
    rejectHandler({ reason: 'useful rejection' } as PromiseRejectionEvent)

    expect(alertError).toHaveBeenNthCalledWith(1, error)
    expect(alertError).toHaveBeenNthCalledWith(2, 'useful rejection')
  })
})
