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
    const onInitializationRequired = vi.fn(async () => true)
    const result = await resolveConnectedClientStartup({ onInitializationRequired })
    expect(result.role).toBe('writer')
    expect(result.runtime.initialized).toBe(false)
    expect(getClientSessionSnapshot().projectionReady).toBe(false)
    expect(onInitializationRequired).not.toHaveBeenCalled()
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
    const onInitializationRequired = vi.fn(async () => true)
    expect((await resolveConnectedClientStartup({ onInitializationRequired })).role).toBe('reader')
    expect(api.acquire).not.toHaveBeenCalled()
    expect(onInitializationRequired).not.toHaveBeenCalled()
  })

  it('waits for explicit first-run confirmation before acquiring with the fresh unlocked identity', async () => {
    const identity = { sessionId: 'fresh-tab', exclusive: false, previousSessionId: 'originating-tab' }
    api.identity.mockResolvedValue(identity)
    api.read.mockResolvedValue(runtime(null, { initialized: false }))
    api.acquire.mockResolvedValue(runtime('fresh-tab', { initialized: false }))
    let confirm!: (confirmed: boolean) => void
    const onInitializationRequired = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve
        }),
    )
    const onCoherentReadView = vi.fn(async () => {})
    const startup = resolveConnectedClientStartup({ onInitializationRequired, onCoherentReadView })
    await vi.waitFor(() => expect(onInitializationRequired).toHaveBeenCalledOnce())

    expect(onInitializationRequired).toHaveBeenCalledWith(
      expect.objectContaining({ generation: getClientSessionSnapshot().generation, kind: 'startup' }),
    )
    expect(api.acquire).not.toHaveBeenCalled()
    expect(onCoherentReadView).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot()).toMatchObject({
      sessionId: 'fresh-tab',
      lifecycle: 'resolving',
      projectionReady: false,
    })
    expect(canUseClientRecoveryAccess()).toBe(false)
    expect(canUseClientWriteAccess()).toBe(false)

    confirm(true)
    const result = await startup
    expect(result.role).toBe('writer')
    expect(result.runtime.initialized).toBe(false)
    expect(api.acquire).toHaveBeenCalledExactlyOnceWith(null, {
      expectedWriter: { epoch: 4, databaseLineage: 'lineage-a' },
    })
    expect(getClientSessionSnapshot()).toMatchObject({
      sessionId: 'fresh-tab',
      lifecycle: 'recovering-writer',
      projectionReady: false,
    })
    expect(canUseClientRecoveryAccess()).toBe(true)
    expect(canUseClientWriteAccess()).toBe(false)
    expect(identity.previousSessionId).toBe('originating-tab')
  })

  it.each(['missing', 'declined'])(
    'does not acquire or expose an empty reader projection when confirmation is %s',
    async (decision) => {
      api.identity.mockResolvedValue({ sessionId: 'fresh-tab', exclusive: false, previousSessionId: 'originating-tab' })
      api.read.mockResolvedValue(runtime(null, { initialized: false }))
      const onCoherentReadView = vi.fn(async () => {})
      const onInitializationRequired = vi.fn(async () => false)

      await expect(
        resolveConnectedClientStartup({
          onCoherentReadView,
          ...(decision === 'declined' ? { onInitializationRequired } : {}),
        }),
      ).rejects.toThrow('Waiting for the server database to be initialized')
      expect(api.acquire).not.toHaveBeenCalled()
      expect(onCoherentReadView).not.toHaveBeenCalled()
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'resolving', projectionReady: false })
      expect(canUseClientRecoveryAccess()).toBe(false)
      expect(canUseClientWriteAccess()).toBe(false)
    },
  )

  it.each(['foreign', 'unknown'])('never offers setup for %s ownership on an empty server', async (owner) => {
    api.identity.mockResolvedValue({ sessionId: 'fresh-tab', exclusive: false, previousSessionId: 'originating-tab' })
    api.read.mockResolvedValue(
      runtime('other-tab', { initialized: false, ...(owner === 'unknown' ? { writer: undefined } : {}) }),
    )
    const onInitializationRequired = vi.fn(async () => true)

    await expect(resolveConnectedClientStartup({ onInitializationRequired })).rejects.toThrow(
      owner === 'unknown' ? 'ownership metadata' : 'Waiting for the server database to be initialized',
    )
    expect(onInitializationRequired).not.toHaveBeenCalled()
    expect(api.acquire).not.toHaveBeenCalled()
    expect(canUseClientRecoveryAccess()).toBe(false)
  })

  it('rereads a lost explicit first-run acquisition as an initialized reader without taking over', async () => {
    api.identity.mockResolvedValue({ sessionId: 'fresh-tab', exclusive: false, previousSessionId: 'originating-tab' })
    api.read
      .mockResolvedValueOnce(runtime(null, { initialized: false }))
      .mockResolvedValueOnce(runtime('race-winner', { writerEpoch: 5, writer: { sessionId: 'race-winner', epoch: 5 } }))
    api.acquire.mockResolvedValue({ status: 'error', error: 'active_writer_changed' })
    const onInitializationRequired = vi.fn(async () => true)

    const result = await resolveConnectedClientStartup({ onInitializationRequired })

    expect(result.role).toBe('reader')
    expect(result.runtime.initialized).toBe(true)
    expect(getClientSessionSnapshot()).toMatchObject({
      sessionId: 'fresh-tab',
      lifecycle: 'reading',
      writer: { sessionId: 'race-winner', epoch: 5 },
    })
    expect(onInitializationRequired).toHaveBeenCalledOnce()
    expect(api.acquire).toHaveBeenCalledExactlyOnceWith(null, {
      expectedWriter: { epoch: 4, databaseLineage: 'lineage-a' },
    })
    expect(api.read).toHaveBeenCalledTimes(2)
    expect(canUseClientRecoveryAccess()).toBe(false)
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('cannot acquire after an explicit setup decision belongs to a superseded startup', async () => {
    api.identity.mockResolvedValue({ sessionId: 'fresh-tab', exclusive: false, previousSessionId: 'originating-tab' })
    api.read.mockResolvedValue(runtime(null, { initialized: false }))
    let confirm!: (confirmed: boolean) => void
    const onInitializationRequired = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve
        }),
    )
    const startup = resolveConnectedClientStartup({ onInitializationRequired })
    await vi.waitFor(() => expect(onInitializationRequired).toHaveBeenCalledOnce())
    beginClientSession('newer-tab')
    confirm(true)

    await expect(startup).rejects.toThrow('superseded')
    expect(api.acquire).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().sessionId).toBe('newer-tab')
    expect(canUseClientRecoveryAccess()).toBe(false)
    expect(canUseClientWriteAccess()).toBe(false)
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
