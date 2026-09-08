import {
  BROWSER_DIAGNOSTICS_ENDPOINT,
  BROWSER_DIAGNOSTICS_MAX_EVENTS,
  isBrowserDiagnosticsBatch,
  isBrowserDiagnosticsConfiguration,
  isBrowserDiagnosticsUploadResponse,
  projectDiagnosticEventV2,
  type DiagnosticEventV2,
} from '@risuai/protocol/remote-diagnostics'

const STORAGE_KEY = 'risu:diagnostics:browser:v1'
const MAX_HISTORY = 300
const MAX_PENDING = 256
const MAX_AGE_MS = 5 * 60_000
const MAX_STORED_BYTES = 1_500_000
const MAX_ATTEMPTS = 3
const CADENCE_MS = 5_000
const REQUEST_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 4096
const ID = /^[a-f0-9]{32}$/
const SCOPE = /^[a-f0-9]{64}$/

export interface LocalBrowserDiagnostic {
  sourceId: string
  eventId: string
  clientSequence: number
  entry: DiagnosticEventV2
}

interface Pending {
  record: LocalBrowserDiagnostic
  attempts: number
  queuedAt: number
  nextAttemptAt: number
}

interface Transport {
  /** Already-authenticated assertion only; this callback must never open a login flow. */
  auth(): Promise<string | null>
  /** Private local scope comparison input; never exported or retained as raw text. */
  databaseLineage?: string
}

interface StoredState {
  sourceId: string
  exclusive: boolean
  nextSequence: number
  scope: string
  history: LocalBrowserDiagnostic[]
  pending: Pending[]
}

let state: 'pending' | 'enabled' | 'disabled' = 'pending'
let generation = 0
let sourceId: string | undefined
let nextSequence = 0
let exclusive = false
let identityReady = false
const provisional = new Set<string>()
let scope: string | undefined
let history: LocalBrowserDiagnostic[] = []
let pending: Pending[] = []
let transport: Transport | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let active: AbortController | undefined
let flushPromise: Promise<void> | undefined
let preparing: Promise<void> | undefined
let releaseLock: (() => void) | undefined
let lifecycleCleanup: (() => void) | undefined
const listeners = new Set<() => void>()

export function captureBrowserDiagnosticsGeneration(): number {
  return generation
}

export function browserDiagnosticsCaptureEnabled(): boolean {
  return state !== 'disabled'
}

export function isBrowserDiagnosticsGenerationCurrent(value: number): boolean {
  return value === generation
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* A report view cannot affect application work. */
    }
  }
}

export function subscribeBrowserDiagnostics(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function randomId(): string | undefined {
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

function key(record: Pick<LocalBrowserDiagnostic, 'sourceId' | 'eventId'>): string {
  return `${record.sourceId}:${record.eventId}`
}

function validLocalRecord(value: unknown): value is LocalBrowserDiagnostic {
  if (!value || typeof value !== 'object') return false
  const record = value as LocalBrowserDiagnostic
  if (Object.keys(record).some((field) => !['sourceId', 'eventId', 'clientSequence', 'entry'].includes(field)))
    return false
  return isBrowserDiagnosticsBatch({
    version: 1,
    sourceId: record.sourceId,
    events: [{ eventId: record.eventId, clientSequence: record.clientSequence, entry: record.entry }],
  })
}

/** Only exact browser families survive capture, restoration and local report reads. */
export function recordBrowserDiagnostic(input: Record<string, unknown>): void {
  if (state === 'disabled') return
  try {
    const timestamp = Date.now()
    const entry = projectDiagnosticEventV2({
      ...input,
      timestamp,
      source: 'browser',
      correlation: 'client-asserted',
      operationRef: undefined,
      attemptRef: undefined,
      ...(input.category === 'legacy' && input.detail && typeof input.detail === 'object'
        ? { detail: { ...input.detail, source: 'browser', timestamp } }
        : {}),
    })
    if (!entry) return
    sourceId ??= randomId()
    const eventId = randomId()
    if (!sourceId || !eventId) return
    if (nextSequence >= 1_000_000_000) {
      sourceId = randomId()
      nextSequence = 0
      exclusive = false
      releaseLock?.()
      releaseLock = undefined
      if (!sourceId) return
    }
    const record = { sourceId, eventId, clientSequence: nextSequence + 1, entry }
    if (!validLocalRecord(record)) return
    nextSequence++
    if (!identityReady) provisional.add(eventId)
    history.push(record)
    if (history.length > MAX_HISTORY) {
      const dropped = history.shift()
      if (dropped) provisional.delete(dropped.eventId)
    }
    pending.push({ record, attempts: 0, queuedAt: timestamp, nextAttemptAt: timestamp })
    if (pending.length > MAX_PENDING) pending.shift()
    prune()
    persist()
    notify()
    schedule()
  } catch {
    /* Safe collection is independent of application success. */
  }
}

export function getBrowserDiagnosticsSnapshot(): {
  enabled: boolean
  sourceId?: string
  entries: LocalBrowserDiagnostic[]
} {
  if (state !== 'enabled') return { enabled: false, entries: [] }
  return { enabled: true, sourceId, entries: history.filter(validLocalRecord).map((record) => structuredClone(record)) }
}

function prune(): void {
  const now = Date.now()
  pending = pending.filter(
    (item) => now - item.queuedAt < MAX_AGE_MS && item.queuedAt <= now && item.attempts < MAX_ATTEMPTS,
  )
}

function persist(): void {
  if (state !== 'enabled' || !scope || !sourceId) return
  try {
    const value = JSON.stringify({
      version: 1,
      sourceId,
      exclusive,
      nextSequence,
      scope,
      history,
      pending: pending.map((item) => ({
        sourceId: item.record.sourceId,
        eventId: item.record.eventId,
        attempts: item.attempts,
        queuedAt: item.queuedAt,
        nextAttemptAt: item.nextAttemptAt,
      })),
    })
    if (value.length <= MAX_STORED_BYTES) sessionStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* Storage-disabled browsers retain only the bounded in-memory report. */
  }
}

function restore(): StoredState | undefined {
  try {
    const text = sessionStorage.getItem(STORAGE_KEY)
    if (!text || text.length > MAX_STORED_BYTES) return undefined
    const value = JSON.parse(text)
    if (
      !value ||
      value.version !== 1 ||
      !ID.test(value.sourceId) ||
      typeof value.exclusive !== 'boolean' ||
      !SCOPE.test(value.scope) ||
      !Number.isSafeInteger(value.nextSequence) ||
      value.nextSequence < 0 ||
      value.nextSequence > 1_000_000_000 ||
      !Array.isArray(value.history) ||
      value.history.length > MAX_HISTORY ||
      !Array.isArray(value.pending) ||
      value.pending.length > MAX_PENDING
    )
      return undefined
    const savedHistory: LocalBrowserDiagnostic[] = value.history.filter(validLocalRecord)
    const records = new Map(savedHistory.map((record) => [key(record), record]))
    const savedPending: Pending[] = []
    for (const item of value.pending) {
      if (!item || typeof item !== 'object' || !ID.test(item.sourceId) || !ID.test(item.eventId)) continue
      const record = records.get(key(item))
      if (
        !record ||
        !Number.isSafeInteger(item.attempts) ||
        item.attempts < 0 ||
        item.attempts >= MAX_ATTEMPTS ||
        !Number.isSafeInteger(item.queuedAt) ||
        !Number.isSafeInteger(item.nextAttemptAt) ||
        item.queuedAt < 0 ||
        item.queuedAt > Date.now() ||
        item.nextAttemptAt < item.queuedAt ||
        item.nextAttemptAt > item.queuedAt + MAX_AGE_MS
      )
        continue
      savedPending.push({ record, attempts: item.attempts, queuedAt: item.queuedAt, nextAttemptAt: item.nextAttemptAt })
    }
    return {
      sourceId: value.sourceId,
      exclusive: value.exclusive,
      nextSequence: Math.max(
        value.nextSequence,
        ...savedHistory.filter((record) => record.sourceId === value.sourceId).map((record) => record.clientSequence),
      ),
      scope: value.scope,
      history: [...records.values()],
      pending: savedPending,
    }
  } catch {
    return undefined
  }
}

async function scopeFingerprint(lineage: string | undefined): Promise<string | undefined> {
  // This private fingerprint only fences local restoration across data replacement.
  // It is never included in records, snapshots, upload bodies or support output.
  if (typeof lineage !== 'string' || lineage.length === 0 || lineage.length > 256) return undefined
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lineage))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

async function claimIdentity(candidate: string, epoch: number): Promise<boolean> {
  const locks = globalThis.navigator?.locks
  if (!locks) return false
  try {
    return await new Promise<boolean>((resolve) => {
      void locks
        .request(`risu:browser-diagnostics:${candidate}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (!lock || epoch !== generation) {
            resolve(false)
            return
          }
          await new Promise<void>((release) => {
            releaseLock = release
            resolve(true)
          })
        })
        .catch(() => resolve(false))
    })
  } catch {
    return false
  }
}

/** Bootstrap opts in independently of manual v1 diagnostics and never waits for transport. */
export function configureBrowserDiagnostics(configuration: unknown, nextTransport?: Transport): boolean {
  if (!isBrowserDiagnosticsConfiguration(configuration) || !nextTransport) {
    resetBrowserDiagnosticsSession()
    return false
  }
  if (state === 'enabled' && transport?.databaseLineage === nextTransport.databaseLineage) {
    transport = nextTransport
    schedule()
    return true
  }
  const previousTransport = transport
  if (previousTransport && previousTransport.databaseLineage !== nextTransport.databaseLineage)
    resetBrowserDiagnosticsSession()
  transport = nextTransport
  state = 'pending'
  const epoch = ++generation
  active?.abort()
  releaseLock?.()
  releaseLock = undefined
  clearTimeout(timer)
  timer = undefined
  preparing = (async () => {
    const fingerprint = await scopeFingerprint(nextTransport.databaseLineage)
    if (epoch !== generation) return
    const saved = restore()
    const previous = saved && fingerprint && saved.scope === fingerprint ? saved : undefined
    const candidate = (previous?.exclusive ? previous.sourceId : undefined) ?? sourceId ?? randomId()
    if (!candidate) {
      resetBrowserDiagnosticsSession()
      return
    }
    let retained = await claimIdentity(candidate, epoch)
    if (epoch !== generation) return
    let chosen = candidate
    if (!retained) {
      const fresh = randomId()
      if (!fresh) {
        resetBrowserDiagnosticsSession()
        return
      }
      chosen = fresh
      retained = await claimIdentity(fresh, epoch)
      if (epoch !== generation) return
    }
    if (!chosen) {
      resetBrowserDiagnosticsSession()
      return
    }
    const currentHistory = history
    const currentPending = pending
    let sequence = Math.max(
      chosen === previous?.sourceId ? previous.nextSequence : 0,
      ...currentHistory
        .filter((record) => record.sourceId === chosen && !provisional.has(record.eventId))
        .map((record) => record.clientSequence),
    )
    if (sequence + provisional.size > 1_000_000_000) {
      const replacement = randomId()
      if (!replacement) {
        resetBrowserDiagnosticsSession()
        return
      }
      releaseLock?.()
      releaseLock = undefined
      chosen = replacement
      retained = false
      sequence = 0
    }
    const replaced = new Map<LocalBrowserDiagnostic, LocalBrowserDiagnostic>()
    const freshHistory = currentHistory.map((record) => {
      if (!provisional.has(record.eventId)) return record
      const next = { ...record, sourceId: chosen, clientSequence: ++sequence }
      replaced.set(record, next)
      return next
    })
    sourceId = chosen
    exclusive = retained
    identityReady = true
    provisional.clear()
    nextSequence = sequence
    scope = fingerprint
    if (!scope) {
      try {
        sessionStorage.removeItem(STORAGE_KEY)
      } catch {}
    }
    const combined = new Map([...(previous?.history ?? []), ...freshHistory].map((record) => [key(record), record]))
    history = [...combined.values()].slice(-MAX_HISTORY)
    const combinedPending = new Map(
      [
        ...(previous?.pending ?? []),
        ...currentPending.map((item) => ({ ...item, record: replaced.get(item.record) ?? item.record })),
      ].map((item) => [key(item.record), item]),
    )
    pending = [...combinedPending.values()].slice(-MAX_PENDING)
    prune()
    state = 'enabled'
    persist()
    notify()
    schedule()
  })()
    .catch(() => {
      if (epoch === generation) resetBrowserDiagnosticsSession()
    })
    .finally(() => {
      if (epoch === generation) preparing = undefined
    })
  return true
}

/** Auth/data/session loss discards identities and aborts work without entering authentication UI. */
export function resetBrowserDiagnosticsSession(): void {
  if (state === 'disabled' && !transport && !active && !preparing && history.length === 0 && pending.length === 0)
    return
  generation++
  state = 'disabled'
  transport = undefined
  scope = undefined
  sourceId = undefined
  nextSequence = 0
  exclusive = false
  identityReady = false
  provisional.clear()
  history = []
  pending = []
  active?.abort()
  active = undefined
  flushPromise = undefined
  clearTimeout(timer)
  timer = undefined
  releaseLock?.()
  releaseLock = undefined
  preparing = undefined
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {}
  notify()
}

function schedule(): void {
  if (state !== 'enabled' || timer || flushPromise || !transport) return
  const previousCount = pending.length
  prune()
  if (pending.length !== previousCount) persist()
  if (pending.length === 0) return
  const expiresIn = Math.min(...pending.map((item) => item.queuedAt + MAX_AGE_MS)) - Date.now()
  const wait = Math.min(Math.max(CADENCE_MS, pending[0].nextAttemptAt - Date.now()), Math.max(1, expiresIn))
  timer = setTimeout(() => {
    timer = undefined
    const epoch = generation
    const running = flush(epoch)
      .catch(() => undefined)
      .finally(() => {
        if (flushPromise === running) flushPromise = undefined
        if (epoch === generation) schedule()
      })
    flushPromise = running
  }, wait)
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
    throw new Error('invalid-response')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('invalid-response')
  let bytes = 0
  let text = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), signal)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('invalid-response')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error('diagnostic-request-aborted'))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    if (stop) signal.removeEventListener('abort', stop)
  }
}

async function flush(epoch: number): Promise<void> {
  if (epoch !== generation || state !== 'enabled' || !transport) return
  const previousCount = pending.length
  prune()
  if (pending.length !== previousCount) persist()
  const first = pending[0]
  if (!first || first.nextAttemptAt > Date.now()) return
  const batch: Pending[] = []
  for (const item of pending) {
    if (item.record.sourceId !== first.record.sourceId || item.nextAttemptAt > Date.now()) break
    if (batch.length >= BROWSER_DIAGNOSTICS_MAX_EVENTS) break
    batch.push(item)
    if (!isBrowserDiagnosticsBatch(makeBatch(batch))) {
      batch.pop()
      break
    }
  }
  if (batch.length === 0) {
    pending.shift()
    persist()
    return
  }
  const controller = new AbortController()
  active = controller
  const expiresIn = Math.min(...batch.map((item) => item.queuedAt + MAX_AGE_MS)) - Date.now()
  const deadline = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, Math.max(1, expiresIn)))
  const keys = new Set(batch.map((item) => key(item.record)))
  const currentTransport = transport
  for (const item of batch) item.attempts++
  persist()
  let succeeded = false
  try {
    const auth = await withAbort(currentTransport.auth(), controller.signal)
    if (epoch !== generation || state !== 'enabled' || controller.signal.aborted) return
    if (auth === null) {
      resetBrowserDiagnosticsSession()
      return
    }
    const response = await withAbort(
      fetch(BROWSER_DIAGNOSTICS_ENDPOINT, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'risu-auth': auth },
        body: JSON.stringify(makeBatch(batch)),
      }),
      controller.signal,
    )
    if (epoch !== generation) return
    if (response.status === 429 || response.status >= 500) return
    if (!response.ok) {
      resetBrowserDiagnosticsSession()
      return
    }
    let reply: unknown
    try {
      reply = await readResponse(response, controller.signal)
    } catch {
      if (controller.signal.aborted) return
      resetBrowserDiagnosticsSession()
      return
    }
    if (epoch !== generation) return
    if (
      !isBrowserDiagnosticsUploadResponse(reply) ||
      reply.accepted + reply.duplicates + reply.dropped !== batch.length
    ) {
      resetBrowserDiagnosticsSession()
      return
    }
    succeeded = true
  } catch {
    /* Offline, timeout and 5xx retries remain bounded and never become diagnostic events. */
  } finally {
    clearTimeout(deadline)
    controller.abort()
    if (active === controller) active = undefined
    if (epoch === generation) {
      if (succeeded) pending = pending.filter((item) => !keys.has(key(item.record)))
      else for (const item of batch) item.nextAttemptAt = Date.now() + CADENCE_MS * 3 ** (item.attempts - 1)
      prune()
      persist()
    }
  }
}

function makeBatch(items: Pending[]) {
  return {
    version: 1,
    sourceId: items[0]?.record.sourceId,
    events: items.map(({ record: { eventId, clientSequence, entry } }) => ({ eventId, clientSequence, entry })),
  }
}

/** Page teardown keeps retry identities, while aborting traffic and releasing source exclusivity. */
export function initializeBrowserDiagnostics(): () => void {
  if (lifecycleCleanup) return lifecycleCleanup
  const pause = () => {
    generation++
    active?.abort()
    active = undefined
    flushPromise = undefined
    clearTimeout(timer)
    timer = undefined
    releaseLock?.()
    releaseLock = undefined
    persist()
    if (state === 'enabled') state = 'pending'
    identityReady = false
  }
  const resume = (event: PageTransitionEvent) => {
    if (event.persisted && transport) configureBrowserDiagnostics({ version: 1 }, transport)
  }
  window.addEventListener('pagehide', pause)
  window.addEventListener('pageshow', resume)
  lifecycleCleanup = () => {
    pause()
    window.removeEventListener('pagehide', pause)
    window.removeEventListener('pageshow', resume)
    lifecycleCleanup = undefined
  }
  return lifecycleCleanup
}

export const __browserDiagnosticsTestHooks = {
  async settled(): Promise<void> {
    await preparing
    await flushPromise
  },
  pendingCount(): number {
    prune()
    return pending.length
  },
  stop(): void {
    lifecycleCleanup?.()
    resetBrowserDiagnosticsSession()
  },
}
