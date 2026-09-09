import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  authenticateClientSessionReadView,
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  completeClientWriterRecovery,
  demoteClientSession,
  failClientSessionOperation,
  requireClientAuthentication,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from './clientSession'
import {
  configureStartupObserverShell,
  recordStartupMilestone,
  resetStartupReadinessForTests,
  settleStartupChatReadiness,
  settleStartupGenerationRecoveryReadiness,
} from './startupReadiness'
import { getWorkspaceAccessSnapshot, workspaceAccessStore } from './workspaceAccess'

const ownership = (sessionId: string | null, epoch = 1, databaseLineage = 'lineage-a') => ({
  databaseLineage,
  writer: { sessionId, epoch },
})

function recordWriterReadiness(): void {
  for (const milestone of ['entry', 'shell-mounted', 'observer-ready', 'writer-ready', 'plugins-ready'] as const)
    recordStartupMilestone(milestone)
  settleStartupChatReadiness(true)
  settleStartupGenerationRecoveryReadiness(true)
}

beforeEach(resetStartupReadinessForTests)
afterEach(resetStartupReadinessForTests)

describe('workspace access presentation model', () => {
  it('keeps an unresolved automatic writer booting despite a coherent preview', () => {
    configureStartupObserverShell(true)
    const startup = beginClientSession('client-a')
    expect(authenticateClientSessionReadView(startup, ownership(null))).toBe(true)
    setClientProjectionReady(true)
    setClientConnectionState('live')
    for (const milestone of ['entry', 'shell-mounted', 'observer-ready'] as const) recordStartupMilestone(milestone)

    expect(getWorkspaceAccessSnapshot()).toEqual({
      mode: 'booting',
      canBrowse: false,
      canApplyWriterRoute: false,
      canMutate: false,
      canGenerate: false,
    })
  })

  it('keeps an established reader browsable through promotion and failure', () => {
    const startup = beginClientSession('client-a')
    expect(settleClientReader(startup, ownership('client-b'))).toBe(true)
    setClientProjectionReady(true)
    setClientConnectionState('live')
    for (const milestone of ['entry', 'shell-mounted', 'observer-ready'] as const) recordStartupMilestone(milestone)
    expect(getWorkspaceAccessSnapshot()).toEqual({
      mode: 'read-only',
      canBrowse: true,
      canApplyWriterRoute: false,
      canMutate: false,
      canGenerate: false,
    })

    const promotion = beginClientPromotion()!
    expect(getWorkspaceAccessSnapshot()).toMatchObject({ mode: 'promoting', canBrowse: true, canMutate: false })
    expect(failClientSessionOperation(promotion)).toBe(true)
    expect(getWorkspaceAccessSnapshot()).toMatchObject({ mode: 'read-only', canBrowse: true })
  })

  it('does not expose writer presentation until recovery and existing guards are ready', () => {
    const startup = beginClientSession('client-a')
    expect(authorizeClientWriterRecovery(startup, ownership('client-a'))).toBe(true)
    setClientProjectionReady(true)
    setClientConnectionState('live')
    expect(getWorkspaceAccessSnapshot().mode).toBe('booting')
    recordWriterReadiness()
    expect(getWorkspaceAccessSnapshot().mode).toBe('booting')
    expect(completeClientWriterRecovery(startup)).toBe(true)
    expect(getWorkspaceAccessSnapshot()).toEqual({
      mode: 'writer',
      canBrowse: true,
      canApplyWriterRoute: true,
      canMutate: true,
      canGenerate: true,
    })
  })

  it('revokes writer capabilities synchronously and clears browsing on auth loss', () => {
    const startup = beginClientSession('client-a')
    expect(authorizeClientWriterRecovery(startup, ownership('client-a'))).toBe(true)
    setClientProjectionReady(true)
    setClientConnectionState('live')
    recordWriterReadiness()
    expect(completeClientWriterRecovery(startup)).toBe(true)
    demoteClientSession()
    expect(getWorkspaceAccessSnapshot()).toMatchObject({ mode: 'read-only', canBrowse: true, canMutate: false })
    requireClientAuthentication()
    expect(getWorkspaceAccessSnapshot()).toMatchObject({ mode: 'booting', canBrowse: false, canMutate: false })
  })

  it('publishes session and readiness transitions through one readable store', () => {
    const modes: string[] = []
    const stop = workspaceAccessStore.subscribe((snapshot) => modes.push(snapshot.mode))
    const startup = beginClientSession('client-a')
    settleClientReader(startup, ownership('client-b'))
    setClientProjectionReady(true)
    setClientConnectionState('live')
    for (const milestone of ['entry', 'shell-mounted', 'observer-ready'] as const) recordStartupMilestone(milestone)
    stop()

    expect(modes[0]).toBe('booting')
    expect(modes.at(-1)).toBe('read-only')
  })
})
