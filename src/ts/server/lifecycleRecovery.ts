export type BrowserLifecycleRecoveryTrigger = 'visibility' | 'pageshow' | 'online' | 'focus'

export interface BrowserLifecycleRecoveryContext {
  /** A hidden/offline/pagehide or persisted-page transition preceded this foreground event. */
  suspensionEvidence: boolean
}

export type BrowserLifecycleRecoveryListener = (
  trigger: BrowserLifecycleRecoveryTrigger,
  context?: BrowserLifecycleRecoveryContext,
) => void

const listeners = new Set<BrowserLifecycleRecoveryListener>()
let installed = false
let queued = false
let pendingTrigger: BrowserLifecycleRecoveryTrigger | null = null
let pendingSuspensionEvidence = false
let suspensionEvidence = false

function queueRecovery(trigger: BrowserLifecycleRecoveryTrigger, observedSuspension = suspensionEvidence): void {
  pendingTrigger = trigger
  pendingSuspensionEvidence ||= observedSuspension
  if (observedSuspension) suspensionEvidence = false
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    const next = pendingTrigger
    const context = { suspensionEvidence: pendingSuspensionEvidence }
    pendingTrigger = null
    pendingSuspensionEvidence = false
    if (!next) return
    for (const listener of [...listeners]) {
      try {
        listener(next, context)
      } catch (error) {
        console.error(error)
      }
    }
  })
}

const handleVisibilityChange = (): void => {
  if (document.visibilityState === 'hidden') {
    suspensionEvidence = true
    return
  }
  if (document.visibilityState === 'visible') queueRecovery('visibility')
}
const handlePageHide = (): void => {
  suspensionEvidence = true
}
const handleOffline = (): void => {
  suspensionEvidence = true
}
const handlePageShow = (event: PageTransitionEvent): void =>
  queueRecovery('pageshow', suspensionEvidence || event.persisted)
const handleOnline = (): void => queueRecovery('online', true)
const handleFocus = (): void => queueRecovery('focus')

function installListeners(): void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return
  installed = true
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('offline', handleOffline)
  window.addEventListener('pageshow', handlePageShow)
  window.addEventListener('online', handleOnline)
  window.addEventListener('focus', handleFocus)
}

function uninstallListeners(): void {
  if (!installed || typeof window === 'undefined' || typeof document === 'undefined') return
  installed = false
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('pagehide', handlePageHide)
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('pageshow', handlePageShow)
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('focus', handleFocus)
  queued = false
  pendingTrigger = null
  pendingSuspensionEvidence = false
  suspensionEvidence = false
}

/**
 * Subscribe to one coalesced browser foreground-recovery signal. Generation,
 * resource SSE, and future recovery domains share these physical listeners.
 * This coalesces notification only: each subscriber owns its request sequencing
 * and the authority required to settle its domain's recovery obligations.
 */
export function subscribeBrowserLifecycleRecovery(listener: BrowserLifecycleRecoveryListener): () => void {
  listeners.add(listener)
  installListeners()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) uninstallListeners()
  }
}
