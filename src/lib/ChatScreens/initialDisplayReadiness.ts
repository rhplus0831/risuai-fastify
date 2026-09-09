export interface InitialDisplayReadiness {
  updateScope(scopeId: string | null, hasRows: boolean, initialRowsPending: boolean): void
  start(scopeId: string | null, registration: symbol): void
  settle(scopeId: string | null, registration: symbol): void
  destroy(): void
}

type ReadinessPhase = 'awaiting-rows' | 'collecting' | 'ready'

export const INITIAL_DISPLAY_MESSAGE_COUNT = 3

export function shouldAwaitInitialDisplayParse(messageIndex: number, messageCount: number): boolean {
  return (
    Number.isInteger(messageIndex) &&
    Number.isInteger(messageCount) &&
    messageCount > 0 &&
    messageIndex >= Math.max(0, messageCount - INITIAL_DISPLAY_MESSAGE_COUNT) &&
    messageIndex < messageCount
  )
}

/**
 * Holds the transcript loading surface over the tracked initial display parses
 * for one chat. Later row reparses are deliberately ignored after the scope is
 * ready because ChatBody keeps its last successful body visible for those.
 */
export function createInitialDisplayReadiness(
  setPending: (pending: boolean) => void,
  afterRender: () => PromiseLike<void>,
): InitialDisplayReadiness {
  let scopeId: string | null = null
  let phase: ReadinessPhase = 'ready'
  let pending = false
  let checkVersion = 0
  let destroyed = false
  const registrations = new Set<symbol>()

  const publishPending = (next: boolean) => {
    if (pending === next) return
    pending = next
    setPending(next)
  }

  const scheduleReadyCheck = () => {
    const version = ++checkVersion
    void Promise.resolve(afterRender()).then(() => {
      if (destroyed || version !== checkVersion || phase !== 'collecting' || registrations.size > 0) {
        return
      }
      phase = 'ready'
      publishPending(false)
    })
  }

  const transition = (nextPhase: ReadinessPhase, force = false) => {
    if (!force && phase === nextPhase) return
    phase = nextPhase
    registrations.clear()
    checkVersion += 1
    publishPending(phase === 'collecting')
    if (phase === 'collecting') scheduleReadyCheck()
  }

  return {
    updateScope(nextScopeId, hasRows, initialRowsPending) {
      if (destroyed) return

      if (nextScopeId !== scopeId) {
        scopeId = nextScopeId
        transition(
          !nextScopeId ? 'ready' : hasRows ? 'collecting' : initialRowsPending ? 'awaiting-rows' : 'ready',
          true,
        )
        return
      }

      if (!nextScopeId) {
        transition('ready')
        return
      }

      if (phase === 'ready') {
        // Later appends and reparses belong to an already-visible transcript.
        // Only a real re-stub/resync may begin another initial display cycle.
        if (initialRowsPending) transition('awaiting-rows')
        return
      }

      if (phase === 'awaiting-rows') {
        if (hasRows) transition('collecting')
        else if (!initialRowsPending) transition('ready')
        return
      }

      if (initialRowsPending) transition('awaiting-rows')
      else if (!hasRows) transition('ready')
    },

    start(registrationScopeId, registration) {
      if (destroyed || registrationScopeId !== scopeId || phase !== 'collecting') return
      registrations.add(registration)
      checkVersion += 1
      publishPending(true)
    },

    settle(registrationScopeId, registration) {
      if (destroyed || registrationScopeId !== scopeId || phase !== 'collecting') return
      if (!registrations.delete(registration)) return
      if (registrations.size === 0) scheduleReadyCheck()
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      registrations.clear()
      checkVersion += 1
      publishPending(false)
    },
  }
}
