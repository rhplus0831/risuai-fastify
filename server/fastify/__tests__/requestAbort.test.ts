import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NON_DURABLE_REQUEST_DEADLINE_MS, attachAbort, createDetachedAbort } from '../src/requestAbort.js'
import { PROXY_STREAM_DEFAULT_TIMEOUT_MS, PROXY_STREAM_MAX_TIMEOUT_MS } from '../src/streamJobs.js'

/**
 * Non-durable request abort plumbing (audit M8). Request-attached signals fire
 * on client disconnect AND at a generous wall-clock deadline mirroring the
 * durable path's 600s `deadlineAt`, so buffered and streaming provider work is
 * bounded at the source instead of per adapter.
 */

type FakeRequestRaw = EventEmitter & { complete: boolean }
type FakeResponseRaw = EventEmitter & { writableEnded: boolean }

function fakeReq(complete = true): { raw: FakeRequestRaw } {
  return { raw: Object.assign(new EventEmitter(), { complete }) }
}

function fakeReply(writableEnded = false): { raw: FakeResponseRaw } {
  return { raw: Object.assign(new EventEmitter(), { writableEnded }) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('attachAbort (non-durable deadline)', () => {
  it('applies the shared 600s default through its exact deadline boundary', () => {
    vi.useFakeTimers()
    expect(NON_DURABLE_REQUEST_DEADLINE_MS).toBe(600_000)
    expect(NON_DURABLE_REQUEST_DEADLINE_MS).toBe(PROXY_STREAM_DEFAULT_TIMEOUT_MS)

    const req = fakeReq()
    const reply = fakeReply()
    const { signal, cleanup } = attachAbort(req, reply)

    vi.advanceTimersByTime(NON_DURABLE_REQUEST_DEADLINE_MS - 1)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)

    cleanup()
  })

  it('the signal aborts once the deadline elapses, with no client disconnect', () => {
    vi.useFakeTimers()
    const req = fakeReq()
    const reply = fakeReply()
    const { signal, cleanup } = attachAbort(req, reply, { deadlineMs: 20 })
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(20)
    expect(signal.aborted).toBe(true)
    cleanup()
  })

  it('refresh keeps an active non-durable generation alive past its original deadline', () => {
    vi.useFakeTimers()
    const req = fakeReq()
    const reply = fakeReply()
    const { signal, refresh, cleanup } = attachAbort(req, reply, { deadlineMs: 100 })

    vi.advanceTimersByTime(90)
    expect(signal.aborted).toBe(false)
    refresh()
    vi.advanceTimersByTime(99)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)

    cleanup()
  })

  it('configured non-durable deadlines are capped at the shared max timeout', () => {
    vi.useFakeTimers()
    const req = fakeReq()
    const reply = fakeReply()
    const { signal, cleanup } = attachAbort(req, reply, {
      deadlineMs: PROXY_STREAM_MAX_TIMEOUT_MS + 10_000,
    })

    vi.advanceTimersByTime(PROXY_STREAM_MAX_TIMEOUT_MS - 1)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)

    cleanup()
  })

  it('does not abort when a normally completed request emits close', () => {
    const req = fakeReq(true)
    const reply = fakeReply()
    const { signal, cleanup } = attachAbort(req, reply)
    expect(signal.aborted).toBe(false)
    req.raw.emit('close')
    expect(signal.aborted).toBe(false)
    cleanup()
  })

  it('aborts when an incomplete request emits close', () => {
    const req = fakeReq(false)
    const reply = fakeReply()
    const { signal, cleanup } = attachAbort(req, reply)
    expect(signal.aborted).toBe(false)
    req.raw.emit('close')
    expect(signal.aborted).toBe(true)
    cleanup()
  })

  it('aborts when the response closes before it is writable-ended', () => {
    const req = fakeReq()
    const reply = fakeReply(false)
    const { signal, cleanup } = attachAbort(req, reply)
    expect(signal.aborted).toBe(false)
    req.raw.emit('close')
    expect(signal.aborted).toBe(false)
    reply.raw.emit('close')
    expect(signal.aborted).toBe(true)
    cleanup()
  })

  it('does not abort when a completed response emits close', () => {
    const req = fakeReq()
    const reply = fakeReply(true)
    const { signal, cleanup } = attachAbort(req, reply)
    expect(signal.aborted).toBe(false)
    reply.raw.emit('close')
    expect(signal.aborted).toBe(false)
    cleanup()
  })

  it('abort() cancels manually (overflow guard path)', () => {
    const req = fakeReq()
    const reply = fakeReply()
    const { signal, abort, cleanup } = attachAbort(req, reply)
    abort()
    expect(signal.aborted).toBe(true)
    cleanup()
  })

  it('cleanup removes the close listener and defuses the deadline timer', () => {
    vi.useFakeTimers()
    const req = fakeReq()
    const reply = fakeReply()
    const { signal, cleanup } = attachAbort(req, reply, { deadlineMs: 20 })
    cleanup()
    expect(req.raw.listenerCount('close')).toBe(0)
    expect(reply.raw.listenerCount('close')).toBe(0)
    req.raw.emit('close')
    reply.raw.emit('close')
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(60)
    expect(signal.aborted).toBe(false)
  })
})

describe('createDetachedAbort', () => {
  it('still aborts detached work at the configured deadline', () => {
    vi.useFakeTimers()
    const { signal, cleanup } = createDetachedAbort({ deadlineMs: 20 })

    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(20)
    expect(signal.aborted).toBe(true)

    cleanup()
  })
})
