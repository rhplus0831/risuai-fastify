import { writable } from 'svelte/store'
import { recordBrowserDiagnostic, resetBrowserDiagnosticsSession } from './server/browserDiagnostics'

export type ClientSessionLifecycle =
  | 'resolving'
  | 'reading'
  | 'promoting'
  | 'recovering-writer'
  | 'writing'
  | 'auth-required'

export type ClientConnectionState = 'connecting' | 'live' | 'interrupted'

export interface ClientWriterSnapshot {
  readonly sessionId: string | null
  readonly epoch: number
}

export interface ClientSessionOwnership {
  readonly databaseLineage: string
  readonly writer: ClientWriterSnapshot
}

export interface ClientSessionSnapshot {
  /** The conservative startup path does not participate in this lifecycle. */
  readonly managed: boolean
  readonly lifecycle: ClientSessionLifecycle
  readonly connection: ClientConnectionState
  readonly generation: number
  readonly sessionId: string | null
  readonly databaseLineage: string | null
  readonly writer: ClientWriterSnapshot | null
  readonly authenticated: boolean
  readonly projectionReady: boolean
  readonly recoveryAuthorized: boolean
}

/** Only the operation returned by the coordinator can finish its transition. */
export interface ClientSessionOperation {
  readonly generation: number
  readonly kind: 'startup' | 'promotion' | 'recovery'
}

const initialState: ClientSessionSnapshot = Object.freeze({
  managed: false,
  lifecycle: 'resolving',
  connection: 'connecting',
  generation: 0,
  sessionId: null,
  databaseLineage: null,
  writer: null,
  authenticated: false,
  projectionReady: false,
  recoveryAuthorized: false,
})

let state = initialState
let activeOperation: ClientSessionOperation | null = null
// A coherent shell can precede automatic acquisition. Keep that preview separate
// from an actual reading/writing disposition, including across interrupted recovery.
// Remember which established surface owns the coherent projection so a former
// writer can stay mounted without making a promoting Reader look like a writer.
let establishedRole: 'reader' | 'writer' | null = null
let connectionStartedAt = 0
const stateStore = writable(state)
const writerLossHandlers = new Set<() => void>()

export const clientSessionStore = { subscribe: stateStore.subscribe }

export function getClientSessionSnapshot(): ClientSessionSnapshot {
  return state
}

export function isClientSessionManaged(): boolean {
  return state.managed
}

/** A coherent preview alone is not an established reader/writer disposition. */
export function hasResolvedClientSessionRole(): boolean {
  return !state.managed || establishedRole !== null
}

/** Coherent former-writer projection retained for presentation/recovery, never authority. */
export function hasRetainedClientWriterProjection(): boolean {
  return (
    state.managed &&
    establishedRole === 'writer' &&
    state.authenticated &&
    state.projectionReady &&
    state.lifecycle === 'recovering-writer' &&
    state.writer?.sessionId === state.sessionId
  )
}

/** Compatibility is deliberate: the conservative path retains its existing guards. */
export function canUseClientWriteAccess(): boolean {
  return (
    !state.managed ||
    (state.lifecycle === 'writing' &&
      state.authenticated &&
      state.projectionReady &&
      state.connection === 'live' &&
      state.writer?.sessionId === state.sessionId)
  )
}

/** Recovery is admitted only after an authenticated acquisition/ownership check. */
export function canUseClientRecoveryAccess(): boolean {
  return (
    !state.managed ||
    (state.authenticated &&
      state.connection !== 'interrupted' &&
      state.writer?.sessionId === state.sessionId &&
      (state.lifecycle === 'writing' || (state.lifecycle === 'recovering-writer' && state.recoveryAuthorized)))
  )
}

export function isClientReadOnly(): boolean {
  return state.managed && !canUseClientWriteAccess()
}

export function canRenderClientReadView(): boolean {
  return state.managed && state.authenticated && state.projectionReady && state.lifecycle !== 'auth-required'
}

export function canUseClientReadServices(): boolean {
  return !state.managed || (state.authenticated && state.lifecycle !== 'auth-required')
}

/** Reader content must not hydrate or parse a prospective writer's shell preview. */
export function canUseClientReaderContent(): boolean {
  return canUseClientReadServices() && (!state.managed || establishedRole !== null)
}

export function assertClientWriteAccess(): void {
  if (!canUseClientWriteAccess()) throw new Error('client_write_access_required')
}

export function captureClientSessionGeneration(): number {
  return state.generation
}

export function isClientSessionGenerationCurrent(generation: number): boolean {
  return generation === state.generation
}

/**
 * Runs synchronously after authority is revoked but before Svelte sees the new
 * role. Capture local drafts here; never flush a network mutation from this hook.
 */
export function registerClientWriterLossHandler(handler: () => void): () => void {
  writerLossHandlers.add(handler)
  return () => writerLossHandlers.delete(handler)
}

function publish(next: ClientSessionSnapshot): void {
  const previous = state
  if (!next.authenticated || next.sessionId !== state.sessionId || next.databaseLineage !== state.databaseLineage) {
    establishedRole = null
  }
  if (next.authenticated && next.lifecycle === 'reading') establishedRole = 'reader'
  if (next.authenticated && next.lifecycle === 'writing') establishedRole = 'writer'
  const losingWriter = state.managed && state.lifecycle === 'writing' && next.lifecycle !== 'writing'
  state = Object.freeze(next)
  if (losingWriter) {
    for (const handler of [...writerLossHandlers]) {
      try {
        handler()
      } catch {
        // One owner must not prevent other draft captures or authority revocation.
        console.warn('A local writer draft could not be captured before access changed')
      }
    }
  }
  try {
    if (
      (previous.authenticated && !next.authenticated) ||
      (previous.sessionId !== null && previous.sessionId !== next.sessionId) ||
      (previous.databaseLineage !== null && previous.databaseLineage !== next.databaseLineage)
    )
      resetBrowserDiagnosticsSession()
  } catch {
    // Diagnostic cleanup must not prevent authority subscribers from running.
  }
  stateStore.set(state)
  try {
    if (state !== next) return
    if (!next.managed) return
    const now = performance.now()
    if (previous.sessionId !== next.sessionId || (previous.connection === 'live' && next.connection !== 'live')) {
      connectionStartedAt = now
    }
    if (previous.lifecycle !== next.lifecycle || !previous.managed) {
      recordBrowserDiagnostic({
        category: 'browser',
        level: next.lifecycle === 'auth-required' ? 'warn' : 'info',
        stage: 'ownership',
        outcome:
          next.lifecycle === 'reading'
            ? 'reader'
            : next.lifecycle === 'writing'
              ? 'writer'
              : next.lifecycle === 'auth-required'
                ? 'failed'
                : 'pending',
      })
    }
    if (previous.connection !== next.connection) {
      recordBrowserDiagnostic({
        category: 'browser',
        level: next.connection === 'interrupted' ? 'warn' : 'info',
        stage: 'reconnect',
        outcome: next.connection === 'live' ? 'online' : next.connection === 'interrupted' ? 'offline' : 'pending',
        durationMs: Math.min(86_400_000, Math.max(0, now - connectionStartedAt)),
      })
    }
  } catch {
    // Diagnostics cannot affect authority or state subscribers.
  }
}

function beginOperation(kind: ClientSessionOperation['kind'], next: ClientSessionSnapshot): ClientSessionOperation {
  const generation = state.generation + 1
  activeOperation = Object.freeze({ generation, kind })
  publish({ ...next, generation })
  return activeOperation
}

/** Called only by the connected startup coordinator, after tab identity is resolved. */
export function beginClientSession(sessionId: string): ClientSessionOperation {
  if (!sessionId.trim() || sessionId.length > 128) throw new TypeError('Invalid client session identity')
  return beginOperation('startup', { ...initialState, managed: true, sessionId })
}

export function isClientSessionOperationCurrent(operation: ClientSessionOperation): boolean {
  return activeOperation === operation && operation.generation === state.generation
}

function acceptsOwnership(ownership: ClientSessionOwnership): boolean {
  if (
    !ownership.databaseLineage ||
    !Number.isSafeInteger(ownership.writer.epoch) ||
    ownership.writer.epoch < 0 ||
    (ownership.writer.sessionId !== null &&
      (!ownership.writer.sessionId.trim() || ownership.writer.sessionId.length > 128))
  ) {
    return false
  }
  if (state.databaseLineage !== null && state.databaseLineage !== ownership.databaseLineage) return false
  if (state.writer && ownership.writer.epoch < state.writer.epoch) return false
  if (
    state.writer &&
    ownership.writer.epoch === state.writer.epoch &&
    ownership.writer.sessionId !== state.writer.sessionId
  ) {
    return false
  }
  return true
}

function ownershipFields(ownership: ClientSessionOwnership) {
  return {
    authenticated: true,
    databaseLineage: ownership.databaseLineage,
    writer: Object.freeze({ ...ownership.writer }),
  }
}

/** Coherent authenticated startup reads may render while conditional acquisition is pending. */
export function authenticateClientSessionReadView(
  operation: ClientSessionOperation,
  ownership: ClientSessionOwnership,
): boolean {
  if (!isClientSessionOperationCurrent(operation) || state.lifecycle !== 'resolving' || !acceptsOwnership(ownership))
    return false
  publish({ ...state, ...ownershipFields(ownership) })
  return true
}

/** A read may establish reader state, including a reader whose ID appears in a frame. */
export function settleClientReader(operation: ClientSessionOperation, ownership: ClientSessionOwnership): boolean {
  if (!isClientSessionOperationCurrent(operation) || !acceptsOwnership(ownership)) return false
  activeOperation = null
  publish({ ...state, ...ownershipFields(ownership), lifecycle: 'reading', recoveryAuthorized: false })
  return true
}

export function beginClientPromotion(): ClientSessionOperation | null {
  if (!state.managed || !state.authenticated || state.connection !== 'live') return null
  if (state.lifecycle === 'promoting') return activeOperation
  if (state.lifecycle !== 'reading' && state.lifecycle !== 'recovering-writer') return null
  return beginOperation('promotion', { ...state, lifecycle: 'promoting', recoveryAuthorized: false })
}

/** An interrupted former writer can revalidate ownership, but cannot dispatch yet. */
export function beginClientWriterResume(): ClientSessionOperation | null {
  if (!state.managed || state.lifecycle !== 'recovering-writer') return null
  if (activeOperation?.kind === 'recovery') return activeOperation
  return beginOperation('recovery', {
    ...state,
    connection: 'connecting',
    recoveryAuthorized: false,
  })
}

/**
 * Only a current startup, explicit promotion, or writer-resume operation may
 * enter recovery. A matching writer frame or resource read never calls this.
 */
export function authorizeClientWriterRecovery(
  operation: ClientSessionOperation,
  ownership: ClientSessionOwnership,
): boolean {
  if (
    !isClientSessionOperationCurrent(operation) ||
    !['resolving', 'promoting', 'recovering-writer'].includes(state.lifecycle) ||
    !acceptsOwnership(ownership) ||
    ownership.writer.sessionId !== state.sessionId
  ) {
    return false
  }
  publish({
    ...state,
    ...ownershipFields(ownership),
    lifecycle: 'recovering-writer',
    recoveryAuthorized: true,
  })
  return true
}

export function setClientProjectionReady(ready: boolean, generation = state.generation): boolean {
  if (!state.managed || !isClientSessionGenerationCurrent(generation)) return false
  if (state.projectionReady !== ready) publish({ ...state, projectionReady: ready })
  return true
}

export function completeClientWriterRecovery(operation: ClientSessionOperation): boolean {
  if (
    !isClientSessionOperationCurrent(operation) ||
    state.lifecycle !== 'recovering-writer' ||
    !state.recoveryAuthorized ||
    !state.projectionReady ||
    state.connection !== 'live' ||
    state.writer?.sessionId !== state.sessionId
  ) {
    return false
  }
  activeOperation = null
  publish({ ...state, lifecycle: 'writing', recoveryAuthorized: false })
  return true
}

export function failClientSessionOperation(operation: ClientSessionOperation): boolean {
  if (!isClientSessionOperationCurrent(operation)) return false
  activeOperation = null
  publish({
    ...state,
    generation: state.generation + 1,
    lifecycle: state.authenticated ? 'reading' : 'resolving',
    recoveryAuthorized: false,
  })
  return true
}

/** Writer loss leaves connection health and the last coherent read view intact. */
export function demoteClientSession(): void {
  if (!state.managed || state.lifecycle === 'auth-required') return
  if (state.lifecycle === 'reading' && !activeOperation) return
  activeOperation = null
  publish({
    ...state,
    generation: state.generation + 1,
    lifecycle: state.authenticated ? 'reading' : 'resolving',
    recoveryAuthorized: false,
  })
}

/** Returns false for an obsolete or inconsistent frame; never grants writer authority. */
export function observeClientWriter(writer: ClientWriterSnapshot): boolean {
  if (!state.managed || !state.authenticated || !state.databaseLineage) return false
  if (!acceptsOwnership({ databaseLineage: state.databaseLineage, writer })) return false
  const changed = !state.writer || state.writer.epoch !== writer.epoch || state.writer.sessionId !== writer.sessionId
  if (!changed) return true
  const supersedesOperation = writer.sessionId !== state.sessionId && state.lifecycle !== 'reading'
  if (supersedesOperation) {
    activeOperation = null
    publish({
      ...state,
      generation: state.generation + 1,
      writer: Object.freeze({ ...writer }),
      lifecycle: 'reading',
      recoveryAuthorized: false,
    })
  } else {
    publish({ ...state, writer: Object.freeze({ ...writer }) })
  }
  return true
}

export function setClientConnectionState(connection: ClientConnectionState, generation = state.generation): boolean {
  if (!state.managed || !isClientSessionGenerationCurrent(generation)) return false
  if (connection === state.connection) return true
  const losesAuthority =
    (connection !== 'live' && state.lifecycle === 'writing') ||
    (connection === 'interrupted' && ['recovering-writer', 'promoting'].includes(state.lifecycle))
  if (losesAuthority) {
    activeOperation = null
    publish({
      ...state,
      generation: state.generation + 1,
      connection,
      lifecycle: state.lifecycle === 'promoting' ? 'reading' : 'recovering-writer',
      recoveryAuthorized: false,
    })
  } else {
    publish({ ...state, connection })
  }
  return true
}

export function requireClientAuthentication(): void {
  if (!state.managed || state.lifecycle === 'auth-required') return
  activeOperation = null
  publish({
    ...state,
    generation: state.generation + 1,
    lifecycle: 'auth-required',
    connection: 'interrupted',
    authenticated: false,
    projectionReady: false,
    recoveryAuthorized: false,
    databaseLineage: null,
    writer: null,
  })
}

/** Test reset does not own drafts, outbox records, or conservative startup state. */
export function resetClientSessionForTests(): void {
  activeOperation = null
  establishedRole = null
  connectionStartedAt = 0
  writerLossHandlers.clear()
  state = initialState
  stateStore.set(state)
}
