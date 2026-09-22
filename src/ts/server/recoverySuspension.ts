import { fetchServerOwnership } from './bootstrap'
import { recordRecoveryDiagnostic } from './recoveryDiagnostics'

/**
 * Whether connection recovery may run right now, shared by the bootstrap
 * dispatcher and the connected reader stream.
 *
 * A hidden page is always suspended: `visibilitychange` reliably resumes it.
 * `navigator.onLine === false` is only a hint. Android Chrome can report it on
 * a working network and never fire `online`, which used to leave every gate
 * closed forever. While a visible page is gated by the flag alone, a silent
 * ownership probe runs with backoff; one server answer proves the flag stale,
 * after which the flag is ignored until the next `online` or `offline` event.
 */

const NETWORK_PROBE_BASE_DELAY_MS = 1_000
const NETWORK_PROBE_MAX_DELAY_MS = 30_000

type NetworkReachableListener = () => void

const listeners = new Set<NetworkReachableListener>()
let offlineFlagDistrusted = false
let probeTimer: ReturnType<typeof setTimeout> | null = null
let probeController: AbortController | null = null
let probeAttempt = 0
let listenersInstalled = false

export function browserIsHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** The raw flag, for callers that only widen a delay or pick a failure reason. */
export function browserReportsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

export function browserRecoverySuspended(): boolean {
  return browserIsHidden() || (browserReportsOffline() && !offlineFlagDistrusted)
}

export function calculateNetworkProbeDelayMs(attempt: number, random: () => number = Math.random): number {
  const normalizedAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  const value = random()
  const jitter = Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5
  return Math.min(
    NETWORK_PROBE_MAX_DELAY_MS,
    Math.max(
      1,
      Math.round(
        Math.min(NETWORK_PROBE_MAX_DELAY_MS, NETWORK_PROBE_BASE_DELAY_MS * 2 ** normalizedAttempt) *
          (0.8 + jitter * 0.4),
      ),
    ),
  )
}

/** Runs when a probe proved the network reachable behind a false offline flag. */
export function subscribeNetworkReachable(listener: NetworkReachableListener): () => void {
  listeners.add(listener)
  installBrowserListeners()
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Called by every recovery gate that just returned early. It arms nothing
 * while the page is hidden, while the flag is already distrusted, while the
 * flag says online, or while a probe is pending.
 */
export function scheduleNetworkProbe(): void {
  if (probeTimer || probeController) return
  if (browserIsHidden() || offlineFlagDistrusted || !browserReportsOffline()) return
  installBrowserListeners()
  const delayMs = calculateNetworkProbeDelayMs(probeAttempt++)
  // A genuinely offline page would otherwise journal every backoff cycle;
  // the first cycle of a streak and the eventual answer are the evidence.
  if (probeAttempt === 1) {
    recordRecoveryDiagnostic('network-probe-scheduled', { outcome: 'pending', attemptCount: probeAttempt, delayMs })
  }
  probeTimer = setTimeout(() => {
    probeTimer = null
    void runNetworkProbe()
  }, delayMs)
}

async function runNetworkProbe(): Promise<void> {
  if (browserIsHidden() || offlineFlagDistrusted || !browserReportsOffline()) return
  const controller = new AbortController()
  probeController = controller
  const startedAt = Date.now()
  let reachable = false
  try {
    const result = await fetchServerOwnership(controller.signal)
    reachable = result.status === 'ok' || (result.status === 'error' && typeof result.httpStatus === 'number')
  } catch {
    reachable = false
  } finally {
    if (probeController === controller) probeController = null
  }
  if (controller.signal.aborted) {
    recordRecoveryDiagnostic('network-probe', { outcome: 'cancelled', attemptCount: probeAttempt })
    return
  }
  if (!reachable) {
    if (probeAttempt === 1) {
      recordRecoveryDiagnostic('network-probe', {
        outcome: 'failed',
        attemptCount: probeAttempt,
        durationMs: Date.now() - startedAt,
      })
    }
    scheduleNetworkProbe()
    return
  }
  // The flag is provably wrong; recovery decides on real requests from here.
  offlineFlagDistrusted = true
  const attempts = probeAttempt
  probeAttempt = 0
  recordRecoveryDiagnostic('network-probe', { attemptCount: attempts, durationMs: Date.now() - startedAt })
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error(error)
    }
  }
}

function cancelNetworkProbe(): void {
  if (probeTimer) clearTimeout(probeTimer)
  probeTimer = null
  probeController?.abort()
  probeController = null
}

/** A fresh `online`/`offline` event is better evidence than any earlier probe. */
function trustOfflineFlag(): void {
  offlineFlagDistrusted = false
  probeAttempt = 0
  cancelNetworkProbe()
}

const handleOnline = (): void => trustOfflineFlag()
// The event is real evidence, but the flag it sets may never clear again:
// keep probing so a network that returns without `online` is still noticed.
const handleOffline = (): void => {
  trustOfflineFlag()
  scheduleNetworkProbe()
}
const handleVisibilityChange = (): void => {
  if (!browserIsHidden()) return
  // A fresh foreground return deserves a prompt probe, not the walked-up delay.
  probeAttempt = 0
  cancelNetworkProbe()
}

function installBrowserListeners(): void {
  if (listenersInstalled || typeof window === 'undefined' || typeof document === 'undefined') return
  listenersInstalled = true
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  document.addEventListener('visibilitychange', handleVisibilityChange)
}

/** App and test teardown: forget every probe and trust the flag again. Subscribers own their own unsubscription. */
export function resetRecoverySuspension(): void {
  trustOfflineFlag()
  if (!listenersInstalled || typeof window === 'undefined' || typeof document === 'undefined') return
  listenersInstalled = false
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
}
