import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_DIAGNOSTICS_ENDPOINT,
  isBrowserDiagnosticsBatch,
  type BrowserDiagnosticsBatch,
} from '@risuai/protocol/remote-diagnostics'

type Publisher = typeof import('./browserDiagnostics')
const CANARY = 'PRIVATE-BROWSER-CONTENT-CREDENTIAL-LINEAGE'
const STORAGE_KEY = 'risu:diagnostics:browser:v1'
let publisher: Publisher
let cleanups: Array<() => void>
let requests: Array<{ init: RequestInit; batch: BrowserDiagnosticsBatch }>
let fetchMock: ReturnType<typeof vi.fn>
let auth: ReturnType<typeof vi.fn<() => Promise<string | null>>>
let held: Set<string>

function accepted(batch: BrowserDiagnosticsBatch): Response {
  return new Response(JSON.stringify({ version: 1, accepted: batch.events.length, duplicates: 0, dropped: 0 }), {
    headers: { 'content-type': 'application/json' },
  })
}

async function page(): Promise<Publisher> {
  vi.resetModules()
  const module = await import('./browserDiagnostics')
  const stop = module.initializeBrowserDiagnostics()
  cleanups.push(() => {
    stop()
    module.__browserDiagnosticsTestHooks.stop()
  })
  return module
}

async function enable(module = publisher, lineage = CANARY): Promise<void> {
  expect(module.configureBrowserDiagnostics({ version: 1 }, { auth, databaseLineage: lineage })).toBe(true)
  await module.__browserDiagnosticsTestHooks.settled()
}

function record(module = publisher, durationMs = 1): void {
  module.recordBrowserDiagnostic({
    category: 'browser',
    level: 'warn',
    stage: 'hydration',
    outcome: 'failed',
    durationMs,
  })
}

async function advance(ms = 5000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await publisher.__browserDiagnosticsTestHooks.settled()
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
  vi.stubEnv('VITE_RISU_BUILD_ID', '')
  vi.stubGlobal('crypto', webcrypto)
  sessionStorage.clear()
  cleanups = []
  requests = []
  held = new Set()
  vi.stubGlobal('navigator', {
    locks: {
      request: vi.fn(async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
        if (held.has(name)) return callback(null)
        held.add(name)
        try {
          await callback({ name })
        } finally {
          held.delete(name)
        }
      }),
    },
  })
  auth = vi.fn(async (): Promise<string | null> => CANARY)
  fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit) => {
    const batch = JSON.parse(String(init.body)) as BrowserDiagnosticsBatch
    requests.push({ init, batch })
    return accepted(batch)
  })
  vi.stubGlobal('fetch', fetchMock)
  publisher = await page()
})

afterEach(async () => {
  cleanups.forEach((cleanup) => cleanup())
  await Promise.resolve()
  sessionStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('browser diagnostics publisher lifecycle', () => {
  it('excludes diagnostic transport namespaces and rejected uploads from fetch capture loops', async () => {
    const diagnostics = await import('../diagnostics')
    const stop = diagnostics.initializeClientDiagnostics()
    cleanups.push(stop)
    diagnostics.configureClientDiagnostics({ version: 1 })
    await enable()
    record()
    await advance()
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toHaveLength(2)
    expect(publisher.getBrowserDiagnosticsSnapshot().entries[0].entry).toMatchObject({
      category: 'browser',
      stage: 'startup',
      outcome: 'pending',
      build: 'unknown',
    })
    expect(diagnostics.getClientDiagnosticsSnapshot().entries).toEqual([])

    fetchMock.mockImplementation(async () => new Response(CANARY, { status: 400 }))
    for (const url of [
      '/api/v1/diagnostics?version=2',
      '/api/v1/diagnostics/browser/rejected',
      '/api/v1/support/diagnostics/rejected',
      '/api/v1/%64iagnostics/browser',
    ])
      await window.fetch(url, { method: 'POST', body: CANARY })
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toHaveLength(2)
    expect(diagnostics.getClientDiagnosticsSnapshot().entries).toEqual([])

    fetchMock.mockResolvedValue(new Response(CANARY, { status: 503, headers: { 'X-Request-UID': 'a'.repeat(64) } }))
    await window.fetch(`/api/v1/characters/${CANARY}`)
    expect(publisher.getBrowserDiagnosticsSnapshot().entries.at(-1)?.entry).toMatchObject({
      category: 'http',
      statusCode: 503,
      requestUid: 'a'.repeat(64),
      correlation: 'client-asserted',
    })
    expect(JSON.stringify(publisher.getBrowserDiagnosticsSnapshot())).not.toContain(CANARY)
    expect(diagnostics.getClientDiagnosticsSnapshot().entries).toHaveLength(1)
  })

  it.each(['a'.repeat(40), CANARY])(
    'records one validated frontend build identity before bootstrap (%s)',
    async (build) => {
      vi.stubEnv('VITE_RISU_BUILD_ID', build)
      const diagnostics = await import('../diagnostics')
      const stop = diagnostics.initializeClientDiagnostics()
      cleanups.push(stop)
      expect(diagnostics.initializeClientDiagnostics()).toBe(stop)
      await enable()
      const snapshot = publisher.getBrowserDiagnosticsSnapshot()
      expect(snapshot.entries).toHaveLength(1)
      expect(snapshot.entries[0].entry).toMatchObject({
        category: 'browser',
        stage: 'startup',
        outcome: 'pending',
        build: build === CANARY ? 'unknown' : build,
      })
      expect(JSON.stringify(snapshot)).not.toContain(CANARY)
    },
  )

  it('uploads bounded pre-bootstrap events once through ordinary reader auth after independent opt-in', async () => {
    record()
    expect(publisher.getBrowserDiagnosticsSnapshot()).toEqual({ enabled: false, entries: [] })
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    await enable()
    await advance()
    expect(requests).toHaveLength(1)
    expect(requests[0].batch.events).toHaveLength(1)
    expect(isBrowserDiagnosticsBatch(requests[0].batch)).toBe(true)
    expect(requests[0].init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'risu-auth': CANARY },
    })
    expect(fetchMock.mock.calls[0][0]).toBe(BROWSER_DIAGNOSTICS_ENDPOINT)
    expect(requests[0].init.headers).not.toHaveProperty('risu-writer-session')
    expect(JSON.stringify(requests[0].batch)).not.toContain(CANARY)
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toContain(CANARY)
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toHaveLength(1)
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(0)
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, { version: 2 }, { version: 1, private: CANARY }])(
    'sends nothing for missing or incompatible opt-in %j',
    async (configuration) => {
      record()
      publisher.configureBrowserDiagnostics(configuration, { auth, databaseLineage: CANARY })
      record()
      await advance(60_000)
      expect(auth).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(0)
      expect(publisher.getBrowserDiagnosticsSnapshot()).toEqual({ enabled: false, entries: [] })
    },
  )

  it('caps pre-bootstrap queue/history, batches and pending age without changing event order', async () => {
    for (let index = 0; index < 350; index++) record(publisher, index)
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(256)
    await enable()
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toHaveLength(300)
    await advance(40_000)
    expect(requests).toHaveLength(8)
    expect(requests.every(({ batch }) => batch.events.length === 32 && isBrowserDiagnosticsBatch(batch))).toBe(true)
    const events = requests.flatMap(({ batch }) => batch.events)
    expect(events).toHaveLength(256)
    expect(events.map((event) => event.clientSequence)).toEqual(
      [...events.map((event) => event.clientSequence)].sort((a, b) => a - b),
    )

    record()
    vi.setSystemTime(Date.now() + 300_001)
    await advance()
    expect(requests).toHaveLength(8)
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(0)
  })

  it('retries transient failures three times with stable IDs and bounded backoff', async () => {
    fetchMock.mockImplementation(async (_input: unknown, init: RequestInit) => {
      requests.push({ init, batch: JSON.parse(String(init.body)) })
      return new Response(CANARY, { status: 503 })
    })
    await enable()
    record()
    await advance(5000)
    expect(requests).toHaveLength(1)
    await advance(5000)
    expect(requests).toHaveLength(2)
    await advance(14_999)
    expect(requests).toHaveLength(2)
    await advance(1)
    expect(requests).toHaveLength(3)
    expect(requests[1].batch).toEqual(requests[0].batch)
    expect(requests[2].batch).toEqual(requests[0].batch)
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(0)
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toHaveLength(1)
    await advance(60_000)
    expect(requests).toHaveLength(3)
  })

  it.each([400, 401, 403, 404, 409, 413])(
    'stops permanently rejected transport %s without exposing its body',
    async (status) => {
      fetchMock.mockResolvedValue(new Response(CANARY, { status }))
      await enable()
      record()
      await advance()
      expect(publisher.getBrowserDiagnosticsSnapshot()).toEqual({ enabled: false, entries: [] })
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
      await advance(60_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('uses a finite timeout even when optional auth never settles', async () => {
    auth.mockImplementation(() => new Promise(() => undefined))
    await enable()
    record()
    await vi.advanceTimersByTimeAsync(10_000)
    await publisher.__browserDiagnosticsTestHooks.settled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(1)
    publisher.resetBrowserDiagnosticsSession()
    auth.mockResolvedValue('ordinary-app-auth')
    await enable()
    record()
    await advance()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('clears and aborts stale work on auth/session reset while new opt-in remains independent', async () => {
    let resolveOld!: (response: Response) => void
    fetchMock.mockImplementationOnce((_input: unknown, init: RequestInit) => {
      requests.push({ init, batch: JSON.parse(String(init.body)) })
      return new Promise<Response>((resolve) => {
        resolveOld = resolve
      })
    })
    await enable()
    record()
    const epoch = publisher.captureBrowserDiagnosticsGeneration()
    await vi.advanceTimersByTimeAsync(5000)
    publisher.resetBrowserDiagnosticsSession()
    expect(requests[0].init.signal?.aborted).toBe(true)
    expect(publisher.isBrowserDiagnosticsGenerationCurrent(epoch)).toBe(false)
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    await enable()
    record()
    resolveOld(accepted(requests[0].batch))
    await advance()
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toHaveLength(1)
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(0)
    expect(requests[1].batch.sourceId).not.toBe(requests[0].batch.sourceId)
  })

  it('retains acknowledged history and retries exact identities after a same-tab reload', async () => {
    await enable()
    record()
    await advance()
    record()
    fetchMock.mockImplementationOnce(async (_input: unknown, init: RequestInit) => {
      requests.push({ init, batch: JSON.parse(String(init.body)) })
      throw new Error(CANARY)
    })
    await advance()
    const old = publisher.getBrowserDiagnosticsSnapshot()
    const stop = publisher.initializeBrowserDiagnostics()
    stop()
    await Promise.resolve()
    publisher = await page()
    await enable()
    record()
    expect(publisher.getBrowserDiagnosticsSnapshot().sourceId).toBe(old.sourceId)
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toHaveLength(3)
    await advance()
    expect(requests[2].batch.events[0]).toEqual(requests[1].batch.events[0])
    expect(requests[2].batch.events[1].clientSequence).toBe(3)
  })

  it('separates duplicated tabs and preserves copied pending identities for server deduplication', async () => {
    await enable()
    record()
    const first = publisher.getBrowserDiagnosticsSnapshot()
    const duplicate = await page()
    await enable(duplicate)
    record(duplicate)
    const next = duplicate.getBrowserDiagnosticsSnapshot()
    expect(next.sourceId).not.toBe(first.sourceId)
    expect(held.size).toBe(2)
    expect(next.entries[0]).toEqual(first.entries[0])
    expect(next.entries[1].sourceId).toBe(next.sourceId)
    expect(next.entries[1].eventId).not.toBe(first.entries[0].eventId)
  })

  it('uses a fresh source without locks while replaying the stored original event identities', async () => {
    vi.stubGlobal('navigator', {})
    await enable()
    record()
    const old = publisher.getBrowserDiagnosticsSnapshot()
    publisher.initializeBrowserDiagnostics()()
    publisher = await page()
    await enable()
    record()
    const current = publisher.getBrowserDiagnosticsSnapshot()
    expect(current.sourceId).not.toBe(old.sourceId)
    expect(current.entries[0]).toEqual(old.entries[0])
    expect(current.entries[1].sourceId).toBe(current.sourceId)
  })

  it('does not restore prior database evidence or invalid content-bearing stored entries', async () => {
    await enable()
    record()
    publisher.initializeBrowserDiagnostics()()
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)
    stored.history[0].entry.prompt = CANARY
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    publisher = await page()
    await enable()
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toEqual([])
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toContain(CANARY)
    record()
    publisher.initializeBrowserDiagnostics()()
    publisher = await page()
    await enable(publisher, 'unrelated-database')
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toEqual([])
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(0)
  })

  it('rejects unbounded stored retry delays and expires a valid deferred event without new captures', async () => {
    await enable()
    record()
    publisher.initializeBrowserDiagnostics()()
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)
    stored.pending[0].nextAttemptAt = Number.MAX_SAFE_INTEGER
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    publisher = await page()
    await enable()
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(0)
    expect(publisher.getBrowserDiagnosticsSnapshot().entries).toHaveLength(1)
    publisher.initializeBrowserDiagnostics()()

    stored.pending[0].nextAttemptAt = stored.pending[0].queuedAt + 300_000
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    publisher = await page()
    await enable()
    await advance(300_000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!).pending).toEqual([])
  })

  it('rotates an exhausted source sequence before assigning pre-bootstrap events', async () => {
    await enable()
    record()
    publisher.initializeBrowserDiagnostics()()
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)
    stored.nextSequence = 1_000_000_000
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    publisher = await page()
    record()
    await enable()
    const snapshot = publisher.getBrowserDiagnosticsSnapshot()
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.sourceId).not.toBe(stored.sourceId)
    expect(snapshot.entries[1].clientSequence).toBe(1)
    await advance(10_000)
    expect(requests.every(({ batch }) => isBrowserDiagnosticsBatch(batch))).toBe(true)
  })

  it('rejects forged categories and stamps browser provenance without copying arbitrary producer fields', async () => {
    await enable()
    publisher.recordBrowserDiagnostic({
      category: 'runtime',
      level: 'error',
      kind: 'runtime-error',
      source: 'server',
      correlation: 'operation',
      operationRef: 'a'.repeat(32),
      attemptRef: 'b'.repeat(32),
      errorName: 'TypeError',
      message: CANARY,
    })
    publisher.recordBrowserDiagnostic({ category: 'provider', level: 'error', source: 'server', message: CANARY })
    const snapshot = publisher.getBrowserDiagnosticsSnapshot()
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].entry).toMatchObject({
      source: 'browser',
      correlation: 'client-asserted',
      errorName: 'TypeError',
    })
    expect(snapshot.entries[0].entry).not.toHaveProperty('operationRef')
    expect(snapshot.entries[0].entry).not.toHaveProperty('attemptRef')
    expect(JSON.stringify(snapshot)).not.toContain(CANARY)
  })

  it.each([
    () => new Response(CANARY, { headers: { 'content-type': 'text/html' } }),
    () =>
      new Response(JSON.stringify({ version: 1, accepted: 1, duplicates: 0, dropped: 0, private: CANARY }), {
        headers: { 'content-type': 'application/json' },
      }),
    () => new Response(' '.repeat(4097), { headers: { 'content-type': 'application/json' } }),
  ])('stops on invalid or oversized acknowledgements without reporting their contents', async (response) => {
    fetchMock.mockResolvedValue(response())
    await enable()
    record()
    await advance()
    expect(publisher.getBrowserDiagnosticsSnapshot()).toEqual({ enabled: false, entries: [] })
    expect(publisher.__browserDiagnosticsTestHooks.pendingCount()).toBe(0)
  })
})
