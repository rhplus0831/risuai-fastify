import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const STORAGE_KEY = 'risu:active-writer-session-id'
const takeoverMocks = vi.hoisted(() => ({
  alertError: vi.fn(),
  alertRequiredSelect: vi.fn(),
  stopEvents: vi.fn(),
  stopTranslations: vi.fn(),
  stopReattach: vi.fn(),
  stopPersistenceRefresh: vi.fn(),
  stopHydration: vi.fn(),
  invalidateResourceCacheWork: vi.fn(),
}))

vi.mock('./resourceCache', () => ({ invalidateResourceCacheWork: takeoverMocks.invalidateResourceCacheWork }))

vi.mock('../alert', () => ({
  alertError: takeoverMocks.alertError,
  alertRequiredSelect: takeoverMocks.alertRequiredSelect,
}))
vi.mock('../../lang', () => ({
  language: {
    pendingMutationRecoveryReload: 'pending mutation recovery',
    reloadSession: 'stale writer recovery',
    writerTakeoverTitle: 'write access moved',
    writerTakeoverBody: 'another session took over',
    writerTakeoverRefreshNow: 'refresh now',
    writerTakeoverStayOffline: 'stay offline',
    writerOfflineBanner: 'offline and read-only',
    writerOfflineRefresh: 'refresh',
    writerAccessLostMutation: 'writer mutation blocked',
  },
}))
vi.mock('../bootstrap', () => ({ stopServerResourceEvents: takeoverMocks.stopEvents }))
vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'active-writer-test-auth',
}))
vi.mock('./messageTranslationJobs', () => ({
  stopActiveMessageTranslationRefresh: takeoverMocks.stopTranslations,
}))
vi.mock('./greetingTranslations.svelte', () => ({
  stopActiveGreetingTranslationRefresh: vi.fn(),
}))
vi.mock('../process/reattach', () => ({ stopActiveGenerationReattach: takeoverMocks.stopReattach }))
vi.mock('../process/generationPersistenceState', () => ({
  stopGenerationFinalizationPersistenceRefresh: takeoverMocks.stopPersistenceRefresh,
}))
vi.mock('./chatMessageHydration.svelte', () => ({ stopChatMessageHydration: takeoverMocks.stopHydration }))

function stubSessionStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  } as unknown as Storage
  vi.stubGlobal('sessionStorage', storage)
  return { storage, values }
}

function stubCryptoSessionId(sessionId: string) {
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => sessionId),
  })
}

async function importActiveWriterSession() {
  vi.resetModules()
  const { registerChatHydrationRuntime } = await import('../process/generationRuntimeBridge')
  registerChatHydrationRuntime({ stopChatMessageHydration: takeoverMocks.stopHydration } as never)
  return await import('./activeWriterSession')
}

function stubMutationObserver() {
  let callback: MutationCallback | undefined
  const observe = vi.fn()

  vi.stubGlobal(
    'MutationObserver',
    class {
      observe = observe
      disconnect = vi.fn()
      takeRecords = vi.fn(() => [])

      constructor(nextCallback: MutationCallback) {
        callback = nextCallback
      }
    },
  )

  return {
    observe,
    notify(records: MutationRecord[]) {
      if (!callback) throw new Error('MutationObserver has not been constructed')
      callback(records, {} as MutationObserver)
    },
  }
}

beforeEach(() => {
  takeoverMocks.alertRequiredSelect.mockReset()
  takeoverMocks.alertRequiredSelect.mockImplementation(() => new Promise(() => {}))
  takeoverMocks.alertError.mockReset()
  takeoverMocks.stopEvents.mockReset()
  takeoverMocks.stopTranslations.mockReset()
  takeoverMocks.stopReattach.mockReset()
  takeoverMocks.stopHydration.mockReset()
  takeoverMocks.invalidateResourceCacheWork.mockReset()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
  document.body.innerHTML = ''
})

describe('active writer browser session', () => {
  it('stores the generated writer session and reuses it after a same-tab reload', async () => {
    const { values } = stubSessionStorage()
    stubCryptoSessionId('writer-from-crypto')

    let activeWriterSession = await importActiveWriterSession()
    expect(activeWriterSession.peekActiveWriterSessionId()).toBeNull()
    expect(activeWriterSession.getActiveWriterSessionId()).toBe('writer-from-crypto')
    expect(values.get(STORAGE_KEY)).toBe('writer-from-crypto')

    activeWriterSession = await importActiveWriterSession()
    expect(activeWriterSession.peekActiveWriterSessionId()).toBeNull()
    expect(activeWriterSession.getActiveWriterSessionId()).toBe('writer-from-crypto')
  })

  it('ignores invalid stored writer session IDs', async () => {
    const { values } = stubSessionStorage({ [STORAGE_KEY]: 'x'.repeat(129) })
    stubCryptoSessionId('replacement-writer')

    const activeWriterSession = await importActiveWriterSession()

    expect(activeWriterSession.getActiveWriterSessionId()).toBe('replacement-writer')
    expect(values.get(STORAGE_KEY)).toBe('replacement-writer')
  })

  it('keeps generating a writer session when sessionStorage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => {
        throw new Error('storage blocked')
      }),
      setItem: vi.fn(() => {
        throw new Error('storage blocked')
      }),
    })
    stubCryptoSessionId('storage-blocked-writer')

    const activeWriterSession = await importActiveWriterSession()

    expect(activeWriterSession.getActiveWriterSessionId()).toBe('storage-blocked-writer')
  })

  it('latches a 423 takeover without scheduling a reload and gates server commands', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const activeWriterSession = await importActiveWriterSession()
    const startupReadiness = await import('../startupReadiness')
    for (const milestone of [
      'entry',
      'shell-mounted',
      'observer-ready',
      'writer-ready',
      'plugins-ready',
      'chat-ready',
    ] as const) {
      startupReadiness.recordStartupMilestone(milestone)
    }
    startupReadiness.settleStartupChatReadiness(true)
    startupReadiness.settleStartupGenerationRecoveryReadiness(true)
    expect(startupReadiness.canMutate()).toBe(true)
    expect(startupReadiness.canGenerate()).toBe(true)

    document.body.innerHTML = '<div id="app"><button>background action</button></div>'
    expect(
      activeWriterSession.handleActiveWriterStaleResponse(new Response(null, { status: 423 }), {
        error: 'active_writer_stale',
      }),
    ).toBe(true)
    expect(activeWriterSession.isWriterAccessLost()).toBe(true)
    expect(takeoverMocks.invalidateResourceCacheWork).toHaveBeenCalledOnce()
    expect(startupReadiness.canRenderShell()).toBe(true)
    expect(startupReadiness.canMutate()).toBe(false)
    expect(startupReadiness.canGenerate()).toBe(false)
    expect(document.getElementById('app')?.classList.contains('risu-writer-takeover-pending')).toBe(true)
    const { canUseServerCommands } = await import('./commands')
    const { canUseServerEvents } = await import('./events')
    expect(canUseServerCommands()).toBe(false)
    expect(canUseServerEvents()).toBe(false)
    const { observerShellLifecycleStore } = await import('../observerShellLifecycle.svelte')
    expect(get(observerShellLifecycleStore).mode).toBe('writer-lost')

    await vi.waitFor(() => expect(takeoverMocks.alertRequiredSelect).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reload).not.toHaveBeenCalled()
    activeWriterSession.resetWriterAccessLostForTests()
  })

  it('opens only the recovery transport latch and re-latches it after a failed attempt', async () => {
    const activeWriterSession = await importActiveWriterSession()
    const startupReadiness = await import('../startupReadiness')
    for (const milestone of ['entry', 'shell-mounted', 'observer-ready', 'writer-ready'] as const) {
      startupReadiness.recordStartupMilestone(milestone)
    }
    activeWriterSession.enterWriterTakeoverFlow()

    expect(activeWriterSession.beginWriterAccessRecovery()).toBe(true)
    expect(takeoverMocks.invalidateResourceCacheWork).toHaveBeenCalledTimes(2)
    expect(activeWriterSession.isWriterAccessLost()).toBe(false)
    expect(startupReadiness.canMutate()).toBe(false)

    activeWriterSession.completeWriterAccessRecovery(false)
    expect(takeoverMocks.invalidateResourceCacheWork).toHaveBeenCalledTimes(3)
    expect(activeWriterSession.isWriterAccessLost()).toBe(true)
    expect(startupReadiness.canMutate()).toBe(false)

    activeWriterSession.resetWriterAccessLostForTests()
  })

  it('does not latch an unrecognized 423 response body', async () => {
    const activeWriterSession = await importActiveWriterSession()

    expect(
      activeWriterSession.handleActiveWriterStaleResponse(new Response(null, { status: 423 }), {
        error: 'resource_locked',
      }),
    ).toBe(false)
    expect(activeWriterSession.isWriterAccessLost()).toBe(false)
    expect(takeoverMocks.alertRequiredSelect).not.toHaveBeenCalled()
    activeWriterSession.resetWriterAccessLostForTests()
  })

  it('reports a latched mutation attempt loudly only once', async () => {
    const activeWriterSession = await importActiveWriterSession()
    activeWriterSession.handleActiveWriterStaleResponse(new Response(null, { status: 423 }), {
      error: 'active_writer_stale',
    })

    expect(activeWriterSession.reportWriterAccessLostMutation()).toBe(true)
    expect(activeWriterSession.reportWriterAccessLostMutation()).toBe(true)
    await vi.waitFor(() => expect(takeoverMocks.alertError).toHaveBeenCalledWith('writer mutation blocked'))
    expect(takeoverMocks.alertError).toHaveBeenCalledOnce()
    activeWriterSession.resetWriterAccessLostForTests()
  })

  it('starts the writer takeover flow only once', async () => {
    const activeWriterSession = await importActiveWriterSession()

    activeWriterSession.enterWriterTakeoverFlow()
    activeWriterSession.enterWriterTakeoverFlow()

    await vi.waitFor(() => expect(takeoverMocks.alertRequiredSelect).toHaveBeenCalledOnce())
    expect(takeoverMocks.stopEvents).toHaveBeenCalledOnce()
    expect(takeoverMocks.stopTranslations).toHaveBeenCalledOnce()
    expect(takeoverMocks.stopReattach).toHaveBeenCalledOnce()
    expect(takeoverMocks.stopHydration).toHaveBeenCalledOnce()
  })

  it('freezes editable content after the user stays offline', async () => {
    takeoverMocks.alertRequiredSelect.mockResolvedValue('1')
    const mutationObserver = stubMutationObserver()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    document.body.innerHTML = `
      <div id="app">
        <input id="draft" type="text" value="draft">
        <textarea id="message">message</textarea>
        <div id="editor" contenteditable="true">editable</div>
      </div>
    `
    const activeWriterSession = await importActiveWriterSession()

    activeWriterSession.enterWriterTakeoverFlow()

    await vi.waitFor(() => expect(document.getElementById('app')?.classList.contains('risu-offline-frozen')).toBe(true))
    expect(document.getElementById('draft')).toHaveProperty('readOnly', true)
    expect(document.getElementById('message')).toHaveProperty('readOnly', true)
    expect(document.getElementById('editor')?.getAttribute('contenteditable')).toBe('false')
    expect(document.getElementById('risu-offline-frozen-banner')?.textContent).toContain('offline and read-only')
    expect(reload).not.toHaveBeenCalled()
    expect(document.getElementById('app')?.classList.contains('risu-writer-takeover-pending')).toBe(false)
    const { observerShellLifecycleStore } = await import('../observerShellLifecycle.svelte')
    expect(get(observerShellLifecycleStore).mode).toBe('offline')

    const laterTextarea = document.createElement('textarea')
    const appRoot = document.getElementById('app')
    appRoot?.appendChild(laterTextarea)

    // Mutation delivery is browser behavior. Invoke the registered callback directly so Happy DOM's
    // timer-based observer emulation cannot make this application-level assertion load-sensitive.
    mutationObserver.notify([
      {
        type: 'childList',
        target: appRoot,
        addedNodes: [laterTextarea],
      } as unknown as MutationRecord,
    ])

    expect(mutationObserver.observe).toHaveBeenCalledWith(appRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'readonly', 'type'],
    })
    expect(laterTextarea.readOnly).toBe(true)

    expect(activeWriterSession.beginWriterAccessRecovery()).toBe(true)
    activeWriterSession.completeWriterAccessRecovery(true)
    expect(activeWriterSession.isWriterAccessLost()).toBe(false)
    expect(document.getElementById('risu-offline-frozen-banner')).toBeNull()
    expect(document.getElementById('app')?.classList.contains('risu-offline-frozen')).toBe(false)
  })

  it('notifies once and reloads when a terminal durable predecessor loses its rollback', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const activeWriterSession = await importActiveWriterSession()

    activeWriterSession.schedulePendingMutationRecoveryReload()
    activeWriterSession.scheduleServerOwnershipReload()
    await vi.advanceTimersByTimeAsync(100)

    expect(takeoverMocks.alertError).toHaveBeenCalledOnce()
    expect(takeoverMocks.alertError).toHaveBeenCalledWith('pending mutation recovery')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps database-lineage ownership recovery on the forced reload path', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const activeWriterSession = await importActiveWriterSession()

    activeWriterSession.scheduleServerOwnershipReload()
    await vi.advanceTimersByTimeAsync(100)

    expect(takeoverMocks.alertError).toHaveBeenCalledOnce()
    expect(takeoverMocks.alertError).toHaveBeenCalledWith('stale writer recovery')
    expect(takeoverMocks.alertRequiredSelect).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledOnce()
  })
})

describe('managed writer recovery interaction', () => {
  it('keeps connected reader controls available while recovering a lost writer', async () => {
    const activeWriterSession = await importActiveWriterSession()
    const session = await import('../clientSession')
    const operation = session.beginClientSession('managed-client')
    session.authorizeClientWriterRecovery(operation, {
      databaseLineage: 'managed-lineage',
      writer: { sessionId: 'managed-client', epoch: 1 },
    })
    session.setClientProjectionReady(true)
    session.setClientConnectionState('live')
    expect(session.completeClientWriterRecovery(operation)).toBe(true)
    document.body.innerHTML = '<div id="app"><button>Read another chat</button></div>'
    activeWriterSession.enterWriterTakeoverFlow()
    expect(activeWriterSession.isWriterAccessLost()).toBe(true)
    expect(session.canUseClientWriteAccess()).toBe(false)
    const promotion = session.beginClientPromotion()!
    expect(
      session.authorizeClientWriterRecovery(promotion, {
        databaseLineage: 'managed-lineage',
        writer: { sessionId: 'managed-client', epoch: 2 },
      }),
    ).toBe(true)
    expect(activeWriterSession.beginWriterAccessRecovery()).toBe(true)
    expect(session.canUseClientWriteAccess()).toBe(false)
    expect(session.canUseClientReadServices()).toBe(true)
    expect(document.getElementById('app')?.classList.contains('risu-writer-takeover-pending')).toBe(false)
    expect(takeoverMocks.alertRequiredSelect).not.toHaveBeenCalled()
    activeWriterSession.completeWriterAccessRecovery(false)
    expect(document.getElementById('app')?.classList.contains('risu-writer-takeover-pending')).toBe(false)
  })
})
