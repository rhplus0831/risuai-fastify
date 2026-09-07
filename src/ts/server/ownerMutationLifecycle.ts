import type { ServerCommandTransportOptions } from './commands'
import { flushRegisteredPendingOwnerMutations } from './pendingOwnerMutationRegistry'
import { canUseClientWriteAccess } from '../clientSession'

export function flushPendingOwnerMutationsForLifecycle(options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  flushRegisteredPendingOwnerMutations(options)
}

let lifecycleListenerRefs = 0
let stopLifecycleListeners: (() => void) | null = null

export function startOwnerMutationLifecycleFlush(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {}
  }

  lifecycleListenerRefs += 1
  if (!stopLifecycleListeners) {
    const flushForLifecycle = () => flushPendingOwnerMutationsForLifecycle({ keepalive: true })
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushForLifecycle()
    }

    window.addEventListener('pagehide', flushForLifecycle)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    stopLifecycleListeners = () => {
      window.removeEventListener('pagehide', flushForLifecycle)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    lifecycleListenerRefs -= 1
    if (lifecycleListenerRefs > 0) return
    lifecycleListenerRefs = 0
    stopLifecycleListeners?.()
    stopLifecycleListeners = null
  }
}
