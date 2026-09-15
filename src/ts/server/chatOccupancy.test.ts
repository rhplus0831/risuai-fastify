import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { ChatOccupancyProjection } from '@risuai/protocol/chat-occupancy'

const transport = vi.hoisted(() => ({
  claim: vi.fn(),
  snapshot: vi.fn(),
  normalize: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
  switch: vi.fn(),
}))
const identity = vi.hoisted(() => ({
  current: { sessionId: 'reader-a', exclusive: true, previousSessionId: null as string | null },
  resolve: vi.fn(),
}))

vi.mock('./chatOccupancyTransport', () => ({
  claimChatOccupancy: transport.claim,
  fetchChatOccupancySnapshot: transport.snapshot,
  normalizeChatOccupancies: transport.normalize,
  releaseChatOccupancy: transport.release,
  renewChatOccupancy: transport.renew,
  switchChatOccupancy: transport.switch,
}))
vi.mock('./connectedTabIdentity', () => ({
  resolveConnectedTabIdentity: () => identity.resolve(),
}))
vi.mock('./browserDiagnostics', () => ({
  recordBrowserDiagnostic: vi.fn(),
  resetBrowserDiagnosticsSession: vi.fn(),
}))

import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  canUseClientWriteAccess,
  completeClientWriterRecovery,
  demoteClientSession,
  requireClientAuthentication,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from '../clientSession'
import {
  applyClientChatOccupancyEvent,
  captureClientChatOccupancyAuthority,
  clearClientChatOccupancyIdentity,
  claimClientChatOccupancy,
  clientChatOccupancyStore,
  configureClientChatOccupancy,
  getClientChatOccupancySnapshot,
  listClientChatOccupancyAuthorities,
  isClientChatOccupancyAuthorityCurrent,
  normalizeClientChatOccupancies,
  projectClientChatOccupancy,
  refreshClientChatOccupancies,
  releaseClientChatOccupancy,
  resetClientChatOccupancyForTests,
  setClientChatOccupancyIdentity,
  switchClientChatOccupancy,
} from './chatOccupancy'

const capability = { version: 1 as const, enabled: true, leaseMs: 90_000 as const, renewAfterMs: 30_000 as const }

function occupancy(
  chatId: string,
  occupantSessionId: string | null,
  occupancyEpoch: number,
  options: Partial<ChatOccupancyProjection> = {},
): ChatOccupancyProjection {
  const active = occupantSessionId !== null
  return {
    databaseLineage: 'database-a',
    chatId,
    occupantSessionId,
    occupancyEpoch,
    claimClass: active ? 'chat_only' : null,
    state: active ? 'occupied' : 'released',
    claimedAtMs: active ? Date.now() : null,
    leaseExpiresAtMs: active ? Date.now() + 90_000 : null,
    updatedAtMs: Date.now(),
    releasedAtMs: active ? null : Date.now(),
    ...options,
  }
}

function beginReader(rows: ChatOccupancyProjection[] = []) {
  const operation = beginClientSession('reader-a')
  setClientChatOccupancyIdentity(identity.current, operation.generation)
  settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'owner-a', epoch: 1 } })
  setClientProjectionReady(true)
  setClientConnectionState('live')
  expect(
    configureClientChatOccupancy(capability, {
      version: 1,
      databaseLineage: 'database-a',
      occupancies: rows,
    }),
  ).toBe(true)
  return operation.generation
}

function becomeWriter(rows: ChatOccupancyProjection[] = []) {
  const operation = beginClientSession('reader-a')
  setClientChatOccupancyIdentity(identity.current, operation.generation)
  authorizeClientWriterRecovery(operation, {
    databaseLineage: 'database-a',
    writer: { sessionId: 'reader-a', epoch: 1 },
  })
  setClientProjectionReady(true)
  setClientConnectionState('live')
  completeClientWriterRecovery(operation)
  configureClientChatOccupancy(capability, {
    version: 1,
    databaseLineage: 'database-a',
    occupancies: rows,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  identity.current = { sessionId: 'reader-a', exclusive: true, previousSessionId: null }
  identity.resolve.mockImplementation(async () => identity.current)
  for (const mock of Object.values(transport)) mock.mockReset()
  resetClientChatOccupancyForTests()
  resetClientSessionForTests()
})

afterEach(() => {
  resetClientChatOccupancyForTests()
  resetClientSessionForTests()
  vi.useRealTimers()
})

describe('client chat occupancy coordinator', () => {
  it('projects available, self-owned, and foreign chats without granting general write access', () => {
    beginReader([occupancy('self', 'reader-a', 2), occupancy('foreign', 'reader-b', 4), occupancy('free', null, 7)])

    expect(projectClientChatOccupancy('missing')).toMatchObject({ kind: 'available', expectedOccupancyEpoch: 0 })
    expect(projectClientChatOccupancy('free')).toMatchObject({ kind: 'available', expectedOccupancyEpoch: 7 })
    expect(projectClientChatOccupancy('self')).toMatchObject({ kind: 'self-owned' })
    expect(projectClientChatOccupancy('foreign')).toMatchObject({ kind: 'foreign-owned' })
    expect(captureClientChatOccupancyAuthority('self')).toMatchObject({
      version: 1,
      databaseLineage: 'database-a',
      sessionId: 'reader-a',
      sessionGeneration: 1,
      chatId: 'self',
      occupancyEpoch: 2,
      claimClass: 'chat_only',
    })
    expect(listClientChatOccupancyAuthorities()).toHaveLength(1)
    const authority = captureClientChatOccupancyAuthority('self')
    expect(authority && isClientChatOccupancyAuthorityCurrent(authority, { requireEnabled: true })).toBe(true)
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('invalidates captured authority when its occupancy epoch changes', () => {
    const generation = beginReader([occupancy('self', 'reader-a', 2)])
    const authority = captureClientChatOccupancyAuthority('self')
    expect(authority).not.toBeNull()

    expect(
      applyClientChatOccupancyEvent(
        {
          type: 'occupancy.snapshot',
          version: 1,
          databaseLineage: 'database-a',
          occupancies: [occupancy('self', 'reader-a', 3)],
        },
        { generation, sessionId: 'reader-a' },
      ),
    ).toBe(true)
    expect(authority && isClientChatOccupancyAuthorityCurrent(authority)).toBe(false)
  })

  it('fails closed for absent, disabled, mixed-lineage, and nonexclusive bootstrap capabilities', async () => {
    const operation = beginClientSession('reader-a')
    identity.current = { sessionId: 'reader-a', exclusive: false, previousSessionId: 'old-reader' }
    setClientChatOccupancyIdentity(identity.current, operation.generation)
    settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'owner-a', epoch: 1 } })
    setClientProjectionReady(true)
    setClientConnectionState('live')

    expect(configureClientChatOccupancy(undefined, undefined)).toBe(false)
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({ kind: 'unsupported', identity: 'unavailable' })
    await expect(refreshClientChatOccupancies()).resolves.toEqual({
      status: 'unavailable',
      reason: 'protocol-unavailable',
    })
    expect(transport.snapshot).not.toHaveBeenCalled()
    expect(
      configureClientChatOccupancy(capability, { version: 1, databaseLineage: 'database-b', occupancies: [] }),
    ).toBe(false)
    expect(
      configureClientChatOccupancy({ ...capability, renewAfterMs: 29_999 } as unknown as typeof capability, {
        version: 1,
        databaseLineage: 'database-a',
        occupancies: [],
      }),
    ).toBe(false)
    expect(
      configureClientChatOccupancy(
        { ...capability, enabled: false },
        { version: 1, databaseLineage: 'database-a', occupancies: [] },
      ),
    ).toBe(true)
    await expect(claimClientChatOccupancy('chat-a')).resolves.toEqual({
      status: 'unavailable',
      reason: 'protocol-disabled',
    })

    configureClientChatOccupancy(capability, { version: 1, databaseLineage: 'database-a', occupancies: [] })
    await expect(claimClientChatOccupancy('chat-a')).resolves.toEqual({
      status: 'unavailable',
      reason: 'identity-not-exclusive',
    })
    expect(transport.claim).not.toHaveBeenCalled()
  })

  it('revalidates connection and rollout after asynchronous identity resolution', async () => {
    beginReader([])
    clearClientChatOccupancyIdentity()
    let resolveIdentity!: (value: typeof identity.current) => void
    identity.resolve.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveIdentity = resolve
      }),
    )

    const claim = claimClientChatOccupancy('chat-a')
    setClientConnectionState('interrupted')
    resolveIdentity(identity.current)
    await expect(claim).resolves.toEqual({ status: 'unavailable', reason: 'connection-unavailable' })
    expect(transport.claim).not.toHaveBeenCalled()

    setClientConnectionState('live')
    clearClientChatOccupancyIdentity()
    identity.resolve.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveIdentity = resolve
      }),
    )
    const disabledDuringAdmission = claimClientChatOccupancy('chat-b')
    expect(
      configureClientChatOccupancy(
        { ...capability, enabled: false },
        { version: 1, databaseLineage: 'database-a', occupancies: [] },
      ),
    ).toBe(true)
    resolveIdentity(identity.current)
    await expect(disabledDuringAdmission).resolves.toEqual({ status: 'unavailable', reason: 'protocol-disabled' })
    expect(transport.claim).not.toHaveBeenCalled()
  })

  it('does not reinstall exclusive identity when lock release supersedes asynchronous admission', async () => {
    beginReader([])
    clearClientChatOccupancyIdentity()
    let resolveIdentity!: (value: typeof identity.current) => void
    identity.resolve.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveIdentity = resolve
      }),
    )

    const claim = claimClientChatOccupancy('chat-a')
    await Promise.resolve()
    clearClientChatOccupancyIdentity()
    resolveIdentity(identity.current)

    await expect(claim).resolves.toEqual({ status: 'unavailable', reason: 'identity-not-exclusive' })
    expect(getClientChatOccupancySnapshot().identity).toBe('unknown')
    expect(transport.claim).not.toHaveBeenCalled()
  })

  it('does not dispatch when lock release supersedes an already-resolved admission', async () => {
    beginReader([])
    transport.claim.mockResolvedValue({ status: 'ok', occupancy: occupancy('chat-a', 'reader-a', 1) })

    const claim = claimClientChatOccupancy('chat-a')
    clearClientChatOccupancyIdentity()

    await expect(claim).resolves.toEqual({ status: 'unavailable', reason: 'identity-not-exclusive' })
    expect(getClientChatOccupancySnapshot().identity).toBe('unknown')
    expect(transport.claim).not.toHaveBeenCalled()
  })

  it('keeps rollback cleanup available while disabled but blocks new claims and switches', async () => {
    const held = occupancy('chat-a', 'reader-a', 2)
    beginReader([held])
    configureClientChatOccupancy(
      { ...capability, enabled: false },
      { version: 1, databaseLineage: 'database-a', occupancies: [held] },
    )
    const released = occupancy('chat-a', null, 3)
    transport.release.mockResolvedValue({ status: 'ok', occupancy: released })

    await expect(claimClientChatOccupancy('chat-b')).resolves.toEqual({
      status: 'unavailable',
      reason: 'protocol-disabled',
    })
    await expect(switchClientChatOccupancy('chat-a', 'chat-b')).resolves.toEqual({
      status: 'unavailable',
      reason: 'protocol-disabled',
    })
    await expect(normalizeClientChatOccupancies('chat-a')).resolves.toEqual({
      status: 'unavailable',
      reason: 'protocol-disabled',
    })
    await expect(releaseClientChatOccupancy('chat-a')).resolves.toEqual({ status: 'ok', occupancy: released })
    expect(transport.release).toHaveBeenCalledOnce()
  })

  it('accepts only fresh occupancy frames from the exact stream session and lineage', () => {
    const generation = beginReader([occupancy('chat-a', 'reader-a', 3, { updatedAtMs: 5_000 })])
    const source = { generation, sessionId: 'reader-a' }

    expect(
      applyClientChatOccupancyEvent(
        {
          type: 'occupancy.snapshot',
          version: 1,
          databaseLineage: 'database-a',
          occupancies: [occupancy('chat-a', 'reader-b', 2, { updatedAtMs: 6_000 })],
        },
        source,
      ),
    ).toBe(false)
    expect(
      applyClientChatOccupancyEvent(
        { type: 'occupancy.snapshot', version: 1, databaseLineage: 'database-b', occupancies: [] },
        source,
      ),
    ).toBe(false)
    expect(
      applyClientChatOccupancyEvent(
        { type: 'occupancy.snapshot', version: 1, databaseLineage: 'database-a', occupancies: [] },
        { generation, sessionId: 'another-page' },
      ),
    ).toBe(false)

    const newest = occupancy('chat-a', 'reader-b', 4, { updatedAtMs: 7_000 })
    expect(
      applyClientChatOccupancyEvent(
        { type: 'occupancy.snapshot', version: 1, databaseLineage: 'database-a', occupancies: [newest] },
        source,
      ),
    ).toBe(true)
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({ kind: 'foreign-owned', occupancy: newest })
  })

  it('does not let an older empty bootstrap or SSE snapshot erase a newly observed tuple', () => {
    const row = occupancy('chat-a', 'reader-a', 3, { updatedAtMs: 5_000 })
    const generation = beginReader([row])

    expect(
      configureClientChatOccupancy(capability, {
        version: 1,
        databaseLineage: 'database-a',
        occupancies: [],
      }),
    ).toBe(true)
    expect(projectClientChatOccupancy('chat-a').kind).toBe('self-owned')
    expect(
      applyClientChatOccupancyEvent(
        { type: 'occupancy.snapshot', version: 1, databaseLineage: 'database-a', occupancies: [] },
        { generation, sessionId: 'reader-a' },
      ),
    ).toBe(false)
    expect(projectClientChatOccupancy('chat-a').kind).toBe('self-owned')
  })

  it('rejects delayed refresh removal and same-epoch conflicting authority', async () => {
    const row = occupancy('chat-a', 'reader-a', 3, { updatedAtMs: 5_000 })
    const generation = beginReader([row])
    transport.snapshot.mockResolvedValue({
      status: 'ok',
      snapshot: { version: 1, databaseLineage: 'database-a', occupancies: [] },
    })

    await expect(refreshClientChatOccupancies()).resolves.toMatchObject({ status: 'ok' })
    expect(projectClientChatOccupancy('chat-a').kind).toBe('self-owned')
    expect(
      applyClientChatOccupancyEvent(
        {
          type: 'occupancy.snapshot',
          version: 1,
          databaseLineage: 'database-a',
          occupancies: [occupancy('chat-a', 'reader-b', 3, { updatedAtMs: 5_000 })],
        },
        { generation, sessionId: 'reader-a' },
      ),
    ).toBe(false)
    expect(projectClientChatOccupancy('chat-a').kind).toBe('self-owned')
  })

  it('derives claim class from current ownership and sends the projected epoch', async () => {
    beginReader([occupancy('chat-a', null, 6)])
    const claimed = occupancy('chat-a', 'reader-a', 7)
    transport.claim.mockResolvedValue({ status: 'ok', occupancy: claimed })

    await expect(claimClientChatOccupancy('chat-a')).resolves.toEqual({ status: 'ok', occupancy: claimed })
    expect(transport.claim).toHaveBeenCalledWith(
      { databaseLineage: 'database-a', sessionId: 'reader-a', generation: expect.any(Number) },
      { chatId: 'chat-a', expectedOccupancyEpoch: 6, claimClass: 'chat_only' },
      expect.any(AbortSignal),
    )
    expect(canUseClientWriteAccess()).toBe(false)

    resetClientChatOccupancyForTests()
    resetClientSessionForTests()
    becomeWriter([occupancy('chat-b', null, 0)])
    const ownerClaim = occupancy('chat-b', 'reader-a', 1, { claimClass: 'owner' })
    transport.claim.mockResolvedValue({ status: 'ok', occupancy: ownerClaim })
    await claimClientChatOccupancy('chat-b')
    expect(transport.claim).toHaveBeenLastCalledWith(
      expect.any(Object),
      { chatId: 'chat-b', expectedOccupancyEpoch: 0, claimClass: 'owner' },
      expect.any(AbortSignal),
    )
  })

  it('keeps occupancy through navigation-independent role changes and clears it on auth or lineage replacement', () => {
    beginReader([occupancy('chat-a', 'reader-a', 1)])
    const readerAuthority = captureClientChatOccupancyAuthority('chat-a')!
    const promotion = beginClientPromotion()!
    authorizeClientWriterRecovery(promotion, {
      databaseLineage: 'database-a',
      writer: { sessionId: 'reader-a', epoch: 2 },
    })
    setClientConnectionState('live')
    setClientProjectionReady(true)
    completeClientWriterRecovery(promotion)
    expect(projectClientChatOccupancy('chat-a').kind).toBe('self-owned')
    expect(isClientChatOccupancyAuthorityCurrent(readerAuthority)).toBe(false)
    expect(captureClientChatOccupancyAuthority('chat-a')?.sessionGeneration).toBe(promotion.generation)
    demoteClientSession()
    expect(projectClientChatOccupancy('chat-a').kind).toBe('self-owned')

    requireClientAuthentication()
    expect(getClientChatOccupancySnapshot()).toMatchObject({ support: 'unknown', occupancies: [] })
    const replacement = beginClientSession('reader-a')
    setClientChatOccupancyIdentity(identity.current, replacement.generation)
    settleClientReader(replacement, {
      databaseLineage: 'database-b',
      writer: { sessionId: 'owner-b', epoch: 1 },
    })
    expect(getClientChatOccupancySnapshot()).toMatchObject({ databaseLineage: 'database-b', occupancies: [] })
  })

  it('renews every advertised interval without releasing on connection interruption', async () => {
    const held = occupancy('chat-a', 'reader-a', 2)
    beginReader([held])
    const renewed = {
      ...held,
      leaseExpiresAtMs: held.leaseExpiresAtMs! + 30_000,
      updatedAtMs: held.updatedAtMs + 30_000,
    }
    transport.renew.mockResolvedValue({ status: 'ok', occupancy: renewed })

    await vi.advanceTimersByTimeAsync(29_999)
    expect(transport.renew).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.renew).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'reader-a', databaseLineage: 'database-a' }),
      held,
      expect.any(AbortSignal),
    )
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({ kind: 'self-owned', occupancy: renewed })
    setClientConnectionState('interrupted')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(transport.renew).toHaveBeenCalledTimes(2)
    expect(transport.release).not.toHaveBeenCalled()
  })

  it('does not postpone renewal when unrelated occupancy snapshots arrive', async () => {
    const held = occupancy('chat-a', 'reader-a', 2)
    const generation = beginReader([held])
    transport.renew.mockResolvedValue({ status: 'ok', occupancy: held })

    await vi.advanceTimersByTimeAsync(29_000)
    expect(
      applyClientChatOccupancyEvent(
        {
          type: 'occupancy.snapshot',
          version: 1,
          databaseLineage: 'database-a',
          occupancies: [held, occupancy('chat-b', 'reader-b', 1)],
        },
        { generation, sessionId: 'reader-a' },
      ),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.renew).toHaveBeenCalledTimes(1)
  })

  it('revokes authority and renewal immediately when the page releases its exclusive identity', async () => {
    const held = occupancy('chat-a', 'reader-a', 2)
    beginReader([held])
    clearClientChatOccupancyIdentity()

    expect(captureClientChatOccupancyAuthority('chat-a')).toBeNull()
    expect(getClientChatOccupancySnapshot().identity).toBe('unknown')
    expect(projectClientChatOccupancy('chat-a').kind).toBe('foreign-owned')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transport.renew).not.toHaveBeenCalled()
  })

  it('uses exact self tuples for release, atomic switch, and all-row normalization', async () => {
    const first = occupancy('chat-a', 'reader-a', 2)
    const second = occupancy('chat-b', 'reader-a', 5, { claimClass: 'owner' })
    beginReader([first, second])
    const target = occupancy('chat-c', 'reader-a', 8)
    transport.switch.mockResolvedValue({ status: 'ok', occupancy: target })

    await expect(switchClientChatOccupancy('chat-a', 'chat-c')).resolves.toEqual({
      status: 'ok',
      occupancy: target,
    })
    expect(transport.switch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'reader-a' }),
      { sourceChatId: 'chat-a', targetChatId: 'chat-c', occupancyEpoch: 2 },
      expect.any(AbortSignal),
    )
    expect(projectClientChatOccupancy('chat-a').kind).toBe('available')

    const normalized = { ...target, claimClass: 'chat_only' as const }
    transport.normalize.mockResolvedValue({ status: 'ok', occupancy: normalized })
    await normalizeClientChatOccupancies('chat-c')
    expect(projectClientChatOccupancy('chat-b').kind).toBe('available')
    expect(projectClientChatOccupancy('chat-c')).toMatchObject({ kind: 'self-owned', occupancy: normalized })

    const released = occupancy('chat-c', null, 9)
    transport.release.mockResolvedValue({ status: 'ok', occupancy: released })
    await releaseClientChatOccupancy('chat-c')
    expect(transport.release).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'reader-a' }),
      normalized,
      expect.any(AbortSignal),
    )
    expect(projectClientChatOccupancy('chat-c')).toMatchObject({ kind: 'available', expectedOccupancyEpoch: 9 })
  })

  it('publishes pending and exact server errors without optimistic authority', async () => {
    beginReader([])
    let resolve!: (value: unknown) => void
    transport.claim.mockReturnValue(
      new Promise((settle) => {
        resolve = settle
      }),
    )
    const states: Array<ReturnType<typeof getClientChatOccupancySnapshot>> = []
    const stop = clientChatOccupancyStore.subscribe((value) => states.push(value))
    const pending = claimClientChatOccupancy('chat-a')
    await vi.waitFor(() =>
      expect(get(clientChatOccupancyStore).pending).toMatchObject({ action: 'claim', chatId: 'chat-a' }),
    )
    const rejection = {
      status: 'error' as const,
      error: 'chat_occupied',
      httpStatus: 423,
      details: { chatId: 'chat-a', safeRelease: 'Use the current occupant.' },
    }
    resolve(rejection)
    await expect(pending).resolves.toEqual(rejection)
    expect(get(clientChatOccupancyStore).lastError).toEqual(rejection)
    expect(projectClientChatOccupancy('chat-a').kind).toBe('available')
    expect(states.some((value) => value.pending?.action === 'claim')).toBe(true)
    stop()
  })

  it('retains pending feedback while a newer bootstrap snapshot fences the delayed action result', async () => {
    beginReader([])
    let resolve!: (value: unknown) => void
    transport.claim.mockReturnValue(
      new Promise((settle) => {
        resolve = settle
      }),
    )
    const pending = claimClientChatOccupancy('chat-a')
    await vi.waitFor(() => expect(get(clientChatOccupancyStore).pending?.action).toBe('claim'))

    const newer = occupancy('chat-a', 'reader-b', 2)
    expect(
      configureClientChatOccupancy(capability, {
        version: 1,
        databaseLineage: 'database-a',
        occupancies: [newer],
      }),
    ).toBe(true)
    expect(get(clientChatOccupancyStore).pending?.action).toBe('claim')

    resolve({ status: 'ok', occupancy: occupancy('chat-a', 'reader-a', 1) })
    await expect(pending).resolves.toMatchObject({ status: 'ok' })
    expect(projectClientChatOccupancy('chat-a')).toMatchObject({
      kind: 'foreign-owned',
      occupancy: { occupancyEpoch: 2, occupantSessionId: 'reader-b' },
    })
    expect(get(clientChatOccupancyStore).pending).toBeNull()
  })

  it('settles pending feedback when an unexpected coordinator dependency rejects', async () => {
    beginReader([])
    transport.claim.mockRejectedValue(new Error('unexpected transport failure'))

    await expect(claimClientChatOccupancy('chat-a')).resolves.toEqual({
      status: 'error',
      error: 'unexpected transport failure',
    })
    expect(get(clientChatOccupancyStore)).toMatchObject({
      pending: null,
      lastError: { status: 'error', error: 'unexpected transport failure' },
    })
  })
})
