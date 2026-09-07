import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginClientSession,
  canUseClientRecoveryAccess,
  canUseClientWriteAccess,
  getClientSessionSnapshot,
  resetClientSessionForTests,
} from './clientSession'
import { resolveConnectedClientStartup } from './connectedClientStartup'

const api = vi.hoisted(() => ({ read: vi.fn(), acquire: vi.fn(), identity: vi.fn() }))
vi.mock('./server/bootstrap', () => ({ fetchServerBootstrap: api.acquire, fetchServerBootstrapReadOnly: api.read }))
vi.mock('./server/connectedTabIdentity', () => ({ resolveConnectedTabIdentity: api.identity }))

function runtime(sessionId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    bootstrap: {
      initialized: true,
      revision: 17,
      databaseLineage: 'lineage-a',
      writerEpoch: 4,
      requestedWriterWasActive: true,
      writer: { sessionId, epoch: 4 },
      ...overrides,
    },
  }
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.resetAllMocks()
  api.identity.mockResolvedValue({ sessionId: 'local-tab', exclusive: true, previousSessionId: null })
  api.read.mockResolvedValue(runtime('other-tab'))
  api.acquire.mockResolvedValue(runtime('local-tab'))
})

describe('connected startup ownership discovery', () => {
  it('keeps a foreign durable writer, whether or not any event connection remains', async () => {
    const result = await resolveConnectedClientStartup()
    expect(result.role).toBe('reader')
    expect(api.acquire).not.toHaveBeenCalled()
    expect(api.read).toHaveBeenCalledExactlyOnceWith(null, { cacheRevision: false })
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      authenticated: true,
      writer: { sessionId: 'other-tab', epoch: 4 },
    })
    expect(canUseClientRecoveryAccess()).toBe(false)
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it.each([null, 'local-tab'])('conditionally acquires only a no-owner or still-owning session (%s)', async (owner) => {
    api.read.mockResolvedValue(runtime(owner))
    const result = await resolveConnectedClientStartup()
    expect(result.role).toBe('writer')
    expect(api.acquire).toHaveBeenCalledExactlyOnceWith(null, {
      expectedWriter: { epoch: 4, databaseLineage: 'lineage-a' },
    })
    expect(canUseClientRecoveryAccess()).toBe(true)
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('preserves the first-run owner branch without treating an empty database as a readable projection', async () => {
    api.read.mockResolvedValue(runtime(null, { initialized: false }))
    api.acquire.mockResolvedValue(runtime('local-tab', { initialized: false }))
    const result = await resolveConnectedClientStartup()
    expect(result.role).toBe('writer')
    expect(result.runtime.initialized).toBe(false)
    expect(getClientSessionSnapshot().projectionReady).toBe(false)
  })

  it('settles the losing acquisition race as a reader without confirming or retrying takeover', async () => {
    api.read
      .mockResolvedValueOnce(runtime(null))
      .mockResolvedValueOnce(runtime('race-winner', { writerEpoch: 5, writer: { sessionId: 'race-winner', epoch: 5 } }))
    api.acquire.mockResolvedValue({ status: 'error', error: 'active_writer_changed' })
    expect((await resolveConnectedClientStartup()).role).toBe('reader')
    expect(api.acquire).toHaveBeenCalledOnce()
    expect(api.read).toHaveBeenCalledTimes(2)
    expect(getClientSessionSnapshot().writer?.sessionId).toBe('race-winner')
  })

  it('cannot turn a held ownership discovery into a write after that startup is superseded', async () => {
    let release!: (value: ReturnType<typeof runtime>) => void
    api.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = resolveConnectedClientStartup()
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledOnce())
    beginClientSession('new-tab')
    release(runtime(null))
    await expect(pending).rejects.toThrow('superseded')
    expect(api.acquire).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().sessionId).toBe('new-tab')
  })

  it('cannot authorize a held acquisition response after a new local session starts', async () => {
    api.read.mockResolvedValue(runtime(null))
    let release!: (value: ReturnType<typeof runtime>) => void
    api.acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = resolveConnectedClientStartup()
    await vi.waitFor(() => expect(api.acquire).toHaveBeenCalledOnce())
    beginClientSession('new-tab')
    release(runtime('local-tab'))
    await expect(pending).rejects.toThrow('superseded')
    expect(canUseClientRecoveryAccess()).toBe(false)
  })

  it('does not infer no-owner from absent legacy metadata', async () => {
    api.read.mockResolvedValue(runtime(null, { writer: undefined }))
    await expect(resolveConnectedClientStartup()).rejects.toThrow('ownership metadata')
    expect(api.acquire).not.toHaveBeenCalled()
  })

  it('keeps an identity without an exclusive lock in reader mode even when the server has no owner', async () => {
    api.identity.mockResolvedValue({ sessionId: 'fresh-tab', exclusive: false, previousSessionId: 'originating-tab' })
    api.read.mockResolvedValue(runtime(null))
    expect((await resolveConnectedClientStartup()).role).toBe('reader')
    expect(api.acquire).not.toHaveBeenCalled()
  })

  it('publishes an authenticated coherent preview while leaving acquisition and ordinary writes separate', async () => {
    api.read.mockResolvedValue(runtime(null))
    api.acquire.mockResolvedValue(
      runtime('local-tab', { writerEpoch: 5, writer: { sessionId: 'local-tab', epoch: 5 } }),
    )
    const onCoherentReadView = vi.fn(async () => {
      expect(getClientSessionSnapshot()).toMatchObject({ authenticated: true, lifecycle: 'resolving' })
      expect(canUseClientRecoveryAccess()).toBe(false)
      expect(canUseClientWriteAccess()).toBe(false)
      expect(api.acquire).not.toHaveBeenCalled()
    })
    expect((await resolveConnectedClientStartup({ onCoherentReadView })).role).toBe('writer')
    expect(onCoherentReadView).toHaveBeenCalledOnce()
  })

  it('requires authentication instead of retrying writer startup after an unauthorized discovery', async () => {
    api.read.mockResolvedValue({ status: 'error', error: 'unauthorized', httpStatus: 401 })
    await expect(resolveConnectedClientStartup()).rejects.toThrow('unauthorized')
    expect(getClientSessionSnapshot().lifecycle).toBe('auth-required')
    expect(api.acquire).not.toHaveBeenCalled()
  })
})
