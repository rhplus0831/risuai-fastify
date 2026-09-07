import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  beginClientWriterResume,
  canRenderClientReadView,
  canUseClientReadServices,
  canUseClientRecoveryAccess,
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  clientSessionStore,
  completeClientWriterRecovery,
  demoteClientSession,
  failClientSessionOperation,
  getClientSessionSnapshot,
  isClientSessionGenerationCurrent,
  isClientSessionOperationCurrent,
  observeClientWriter,
  registerClientWriterLossHandler,
  requireClientAuthentication,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from './clientSession'

const ownership = (sessionId: string | null, epoch = 1, databaseLineage = 'lineage-a') => ({
  databaseLineage,
  writer: { sessionId, epoch },
})

function becomeReader() {
  const operation = beginClientSession('client-a')
  expect(settleClientReader(operation, ownership('client-b'))).toBe(true)
  setClientProjectionReady(true)
  setClientConnectionState('live')
}

function becomeWriter() {
  const operation = beginClientSession('client-a')
  expect(authorizeClientWriterRecovery(operation, ownership('client-a'))).toBe(true)
  setClientProjectionReady(true)
  setClientConnectionState('live')
  expect(completeClientWriterRecovery(operation)).toBe(true)
}

afterEach(resetClientSessionForTests)

describe('connected client session authority', () => {
  it('leaves the conservative path under its existing admission policy', () => {
    expect(getClientSessionSnapshot().managed).toBe(false)
    expect(canUseClientWriteAccess()).toBe(true)
    expect(canUseClientRecoveryAccess()).toBe(true)
    expect(canRenderClientReadView()).toBe(false)
  })

  it('keeps reader reads available across interruption without acquiring or replaying', () => {
    becomeReader()
    expect(canRenderClientReadView()).toBe(true)
    expect(canUseClientReadServices()).toBe(true)
    expect(canUseClientWriteAccess()).toBe(false)
    expect(canUseClientRecoveryAccess()).toBe(false)

    setClientConnectionState('interrupted')
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    expect(canRenderClientReadView()).toBe(true)
    expect(beginClientPromotion()).toBeNull()
    setClientConnectionState('connecting')
    setClientConnectionState('live')
    expect(canUseClientWriteAccess()).toBe(false)
    expect(canUseClientRecoveryAccess()).toBe(false)

    // Even an authoritative frame naming this client is observation, not a
    // successful explicit acquisition and recovery operation.
    expect(observeClientWriter({ sessionId: 'client-a', epoch: 2 })).toBe(true)
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    expect(canUseClientWriteAccess()).toBe(false)
    expect(canUseClientRecoveryAccess()).toBe(false)
  })

  it('requires current acquisition, coherent resources and a live connection before writing', () => {
    const operation = beginClientSession('client-a')
    setClientConnectionState('live')
    setClientProjectionReady(true)
    expect(canRenderClientReadView()).toBe(false)
    expect(completeClientWriterRecovery(operation)).toBe(false)
    expect(authorizeClientWriterRecovery(operation, ownership('client-b'))).toBe(false)

    expect(authorizeClientWriterRecovery(operation, ownership('client-a'))).toBe(true)
    expect(canUseClientRecoveryAccess()).toBe(true)
    expect(canUseClientWriteAccess()).toBe(false)
    setClientProjectionReady(false)
    expect(completeClientWriterRecovery(operation)).toBe(false)
    setClientProjectionReady(true)
    expect(completeClientWriterRecovery(operation)).toBe(true)
    expect(canUseClientWriteAccess()).toBe(true)
    expect(completeClientWriterRecovery(operation)).toBe(false)
  })

  it('shares promotion, tolerates its old initial frame and rejects a superseding writer', () => {
    becomeReader()
    const promotion = beginClientPromotion()!
    expect(beginClientPromotion()).toBe(promotion)
    expect(canUseClientRecoveryAccess()).toBe(false)
    expect(observeClientWriter({ sessionId: 'client-b', epoch: 1 })).toBe(true)
    expect(isClientSessionOperationCurrent(promotion)).toBe(true)
    expect(observeClientWriter({ sessionId: 'client-a', epoch: 2 })).toBe(true)
    expect(canUseClientWriteAccess()).toBe(false)
    expect(authorizeClientWriterRecovery(promotion, ownership('client-a', 2))).toBe(true)

    expect(observeClientWriter({ sessionId: 'client-c', epoch: 3 })).toBe(true)
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    expect(completeClientWriterRecovery(promotion)).toBe(false)
    expect(authorizeClientWriterRecovery(promotion, ownership('client-a', 2))).toBe(false)
    expect(canRenderClientReadView()).toBe(true)
    expect(canUseClientRecoveryAccess()).toBe(false)
  })

  it('captures local drafts after revocation and before publishing the reader to UI', () => {
    becomeWriter()
    const order: string[] = []
    const unsubscribe = clientSessionStore.subscribe((snapshot) => order.push(`UI:${snapshot.lifecycle}`))
    let captured = ''
    let mountedDraft = 'new unsaved text'
    const stopCapture = registerClientWriterLossHandler(() => {
      expect(canUseClientWriteAccess()).toBe(false)
      expect(order.at(-1)).toBe('UI:writing')
      captured = mountedDraft
      order.push('captured')
    })
    const stopUnmount = clientSessionStore.subscribe((snapshot) => {
      if (snapshot.lifecycle === 'reading') mountedDraft = ''
    })

    demoteClientSession()
    expect(captured).toBe('new unsaved text')
    expect(mountedDraft).toBe('')
    expect(order.slice(-2)).toEqual(['captured', 'UI:reading'])
    expect(getClientSessionSnapshot().connection).toBe('live')
    demoteClientSession()
    expect(order.filter((entry) => entry === 'captured')).toHaveLength(1)
    stopCapture()
    stopUnmount()
    unsubscribe()
  })

  it('does not let connectivity alone restore an interrupted writer', () => {
    becomeWriter()
    const oldGeneration = captureClientSessionGeneration()
    setClientConnectionState('interrupted')
    expect(getClientSessionSnapshot().lifecycle).toBe('recovering-writer')
    expect(canUseClientRecoveryAccess()).toBe(false)
    expect(isClientSessionGenerationCurrent(oldGeneration)).toBe(false)
    setClientConnectionState('live')
    expect(canUseClientWriteAccess()).toBe(false)
    expect(canUseClientRecoveryAccess()).toBe(false)

    const recovery = beginClientWriterResume()!
    expect(beginClientWriterResume()).toBe(recovery)
    expect(authorizeClientWriterRecovery(recovery, ownership('client-b', 2))).toBe(false)
    expect(settleClientReader(recovery, ownership('client-b', 2))).toBe(true)
    expect(canRenderClientReadView()).toBe(true)
    expect(completeClientWriterRecovery(recovery)).toBe(false)
  })

  it('keeps a failed promotion readable and permanently invalidates its old callback', () => {
    becomeReader()
    const first = beginClientPromotion()!
    expect(failClientSessionOperation(first)).toBe(true)
    expect(canRenderClientReadView()).toBe(true)
    const second = beginClientPromotion()!
    expect(second).not.toBe(first)
    expect(failClientSessionOperation(first)).toBe(false)
    expect(authorizeClientWriterRecovery(first, ownership('client-a', 2))).toBe(false)
    expect(authorizeClientWriterRecovery(second, ownership('client-a', 2))).toBe(true)
    expect(completeClientWriterRecovery(second)).toBe(true)
  })

  it('rejects old ownership, lineage and hydration callbacks after authentication loss', () => {
    becomeReader()
    const promotion = beginClientPromotion()!
    const generation = captureClientSessionGeneration()
    requireClientAuthentication()
    expect(canRenderClientReadView()).toBe(false)
    expect(canUseClientReadServices()).toBe(false)
    expect(setClientProjectionReady(true, generation)).toBe(false)
    expect(setClientConnectionState('live', generation)).toBe(false)
    expect(authorizeClientWriterRecovery(promotion, ownership('client-a', 2))).toBe(false)
    expect(observeClientWriter({ sessionId: 'client-a', epoch: 2 })).toBe(false)

    const fresh = beginClientSession('client-a')
    expect(authorizeClientWriterRecovery(fresh, ownership('client-a', 0, 'lineage-b'))).toBe(true)
    expect(settleClientReader(promotion, ownership('client-b', 3))).toBe(false)
    expect(getClientSessionSnapshot().databaseLineage).toBe('lineage-b')
  })

  it('does not allow an older snapshot or contradictory same-epoch frame to replace known authority', () => {
    becomeReader()
    expect(observeClientWriter({ sessionId: 'client-c', epoch: 3 })).toBe(true)
    expect(observeClientWriter({ sessionId: 'client-b', epoch: 1 })).toBe(false)
    expect(observeClientWriter({ sessionId: 'client-a', epoch: 3 })).toBe(false)
    const promotion = beginClientPromotion()!
    expect(authorizeClientWriterRecovery(promotion, ownership('client-a', 4, 'lineage-b'))).toBe(false)
    expect(getClientSessionSnapshot().writer).toEqual({ sessionId: 'client-c', epoch: 3 })
  })

  it('continues other draft captures when one owner fails without restoring write access', () => {
    becomeWriter()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const captured = vi.fn()
    registerClientWriterLossHandler(() => {
      throw new Error('draft owner failed')
    })
    registerClientWriterLossHandler(captured)
    demoteClientSession()
    expect(captured).toHaveBeenCalledOnce()
    expect(canUseClientWriteAccess()).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
