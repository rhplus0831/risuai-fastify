import { afterEach, expect, it, vi } from 'vitest'
import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  completeClientWriterRecovery,
  demoteClientSession,
  resetClientSessionForTests,
} from '../clientSession'
import { enterClientWriter } from '../__tests__/clientSession'
import {
  applyPendingSettingsProjectionOverlays,
  registerPendingSettingsProjectionOverlay,
} from './settingsPendingProjection'

afterEach(() => resetClientSessionForTests())

it('admits overlays only for ordinary writers, including after recovery completes', () => {
  const overlay = vi.fn((target: Record<string, unknown>) => {
    target.value = 'pending'
  })
  const stop = registerPendingSettingsProjectionOverlay(overlay)
  try {
    enterClientWriter()
    const writer = { value: 'server' }
    applyPendingSettingsProjectionOverlays(writer)
    expect(writer.value).toBe('pending')
    demoteClientSession()
    const reader = { value: 'server' }
    applyPendingSettingsProjectionOverlays(reader)
    expect(reader.value).toBe('server')
    const operation = beginClientPromotion()!
    authorizeClientWriterRecovery(operation, {
      databaseLineage: 'draft-test-lineage',
      writer: { sessionId: 'draft-test-session', epoch: 1 },
    })
    const recovering = { value: 'server' }
    applyPendingSettingsProjectionOverlays(recovering)
    expect(recovering.value).toBe('server')
    expect(completeClientWriterRecovery(operation)).toBe(true)
    applyPendingSettingsProjectionOverlays(recovering)
    expect(recovering.value).toBe('pending')
    expect(overlay).toHaveBeenCalledTimes(2)
  } finally {
    stop()
  }
})
