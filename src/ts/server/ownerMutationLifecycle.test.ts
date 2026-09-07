import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { flushPendingOwnerMutationsForLifecycle, startOwnerMutationLifecycleFlush } from './ownerMutationLifecycle'
import { registerPendingOwnerMutationFlusher } from './pendingOwnerMutationRegistry'
import {
  authorizeClientWriterRecovery,
  beginClientSession,
  completeClientWriterRecovery,
  demoteClientSession,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
} from '../clientSession'

const calls = Array.from({ length: 6 }, () => [] as unknown[])
let unregisterOwnerFlushers: Array<() => void> = []

function allCallBuckets(): unknown[][] {
  return calls
}

beforeEach(() => {
  resetClientSessionForTests()
  for (const bucket of allCallBuckets()) bucket.length = 0
  unregisterOwnerFlushers = calls.map((bucket, index) =>
    registerPendingOwnerMutationFlusher(`test:owner-lifecycle:${index}`, (options) => bucket.push(options)),
  )
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  })
})

afterEach(() => {
  resetClientSessionForTests()
  for (const unregister of unregisterOwnerFlushers) unregister()
  unregisterOwnerFlushers = []
})

describe('flushPendingOwnerMutationsForLifecycle', () => {
  it('keeps already-installed pagehide and visibility callbacks from flushing after demotion', () => {
    const operation = beginClientSession('writer-a')
    authorizeClientWriterRecovery(operation, {
      databaseLineage: 'lineage-a',
      writer: { sessionId: 'writer-a', epoch: 1 },
    })
    setClientProjectionReady(true)
    setClientConnectionState('live')
    completeClientWriterRecovery(operation)
    const stop = startOwnerMutationLifecycleFlush()
    window.dispatchEvent(new Event('pagehide'))
    for (const bucket of allCallBuckets()) expect(bucket).toHaveLength(1)

    demoteClientSession()
    window.dispatchEvent(new Event('pagehide'))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    flushPendingOwnerMutationsForLifecycle({ keepalive: true })
    for (const bucket of allCallBuckets()) expect(bucket).toHaveLength(1)
    stop()
  })
  it('flushes every registered owner mutation', () => {
    flushPendingOwnerMutationsForLifecycle({ keepalive: true })

    for (const bucket of allCallBuckets()) {
      expect(bucket).toEqual([{ keepalive: true }])
    }
  })

  it('pagehide and hidden visibility flush with keepalive until teardown', () => {
    const stop = startOwnerMutationLifecycleFlush()

    window.dispatchEvent(new Event('pagehide'))
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))

    for (const bucket of allCallBuckets()) {
      expect(bucket).toEqual([{ keepalive: true }, { keepalive: true }])
    }

    stop()
    window.dispatchEvent(new Event('pagehide'))
    for (const bucket of allCallBuckets()) {
      expect(bucket).toHaveLength(2)
    }
  })

  it('keeps lifecycle listeners until every owner stops, even when one stop is called twice', () => {
    const stopFirstOwner = startOwnerMutationLifecycleFlush()
    const stopSecondOwner = startOwnerMutationLifecycleFlush()

    stopFirstOwner()
    stopFirstOwner()
    window.dispatchEvent(new Event('pagehide'))

    for (const bucket of allCallBuckets()) {
      expect(bucket).toEqual([{ keepalive: true }])
    }

    stopSecondOwner()
    window.dispatchEvent(new Event('pagehide'))
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))

    for (const bucket of allCallBuckets()) {
      expect(bucket).toHaveLength(1)
    }
  })
})
