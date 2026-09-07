import { getActiveWriterSessionId, installConnectedWriterSessionId } from './activeWriterSession'

export interface ConnectedTabIdentity {
  readonly sessionId: string
  readonly exclusive: boolean
  /** Preserved for explicit local recovery when the lock facility is unavailable. */
  readonly previousSessionId: string | null
}

const PREVIOUS_SESSION_KEY = 'risu:connected-reader-previous-session-id'
let resolved: ConnectedTabIdentity | null = null
let resolving: Promise<ConnectedTabIdentity> | null = null
let releaseLock: (() => void) | null = null
let generation = 0

/** A suspended or duplicated tab cannot infer ownership from a missing heartbeat. */
export function resolveConnectedTabIdentity(): Promise<ConnectedTabIdentity> {
  if (resolved) return Promise.resolve(resolved)
  if (resolving) return resolving
  const running = resolveIdentity(generation).finally(() => {
    if (resolving === running) resolving = null
  })
  resolving = running
  return running
}

async function resolveIdentity(sourceGeneration: number): Promise<ConnectedTabIdentity> {
  const assertCurrent = () => {
    if (sourceGeneration !== generation) throw new Error('Page identity resolution was superseded')
  }
  const candidate = getActiveWriterSessionId()
  const locks = globalThis.navigator?.locks
  if (locks) {
    try {
      const retained = await claim(locks, candidate, sourceGeneration)
      assertCurrent()
      if (retained) return remember(candidate, true, null)
      // A copied sessionStorage belongs to a different live page. Its drafts
      // remain with that page, and are never adopted by the duplicate.
      const fresh = crypto.randomUUID()
      const claimed = await claim(locks, fresh, sourceGeneration)
      assertCurrent()
      if (claimed) return remember(fresh, true, null)
    } catch {
      // No lock is proof of exclusivity: remain a reader until explicit action.
    }
  }
  assertCurrent()
  let previousSessionId = candidate
  try {
    previousSessionId = sessionStorage.getItem(PREVIOUS_SESSION_KEY) || candidate
    sessionStorage.setItem(PREVIOUS_SESSION_KEY, previousSessionId)
  } catch {}
  return remember(crypto.randomUUID(), false, previousSessionId)
}

function remember(sessionId: string, exclusive: boolean, previousSessionId: string | null): ConnectedTabIdentity {
  installConnectedWriterSessionId(sessionId)
  resolved = Object.freeze({ sessionId, exclusive, previousSessionId })
  return resolved
}

function claim(locks: LockManager, sessionId: string, sourceGeneration: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    void locks
      .request(`risu:client-session:${sessionId}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock || sourceGeneration !== generation) {
          resolve(false)
          return
        }
        await new Promise<void>((release) => {
          releaseLock = release
          resolve(true)
        })
      })
      .catch(reject)
  })
}

/** Page lifecycle owns release; persisted-page resume must resolve and revalidate. */
export function releaseConnectedTabIdentity(): void {
  generation += 1
  releaseLock?.()
  releaseLock = null
  resolved = null
  resolving = null
}
