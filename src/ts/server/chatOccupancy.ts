import {
  CHAT_OCCUPANCY_PROTOCOL_VERSION,
  isChatOccupancyCapability,
  isChatOccupancyEvent,
  isChatOccupancySnapshot,
  type ChatOccupancyCapability,
  type ChatOccupancyClaimClass,
  type ChatOccupancyEvent,
  type ChatOccupancyProjection,
  type ChatOccupancySnapshot,
} from '@risuai/protocol/chat-occupancy'
import { writable } from 'svelte/store'
import {
  captureClientSessionGeneration,
  clientSessionStore,
  getClientSessionSnapshot,
  type ClientSessionSnapshot,
} from '../clientSession'
import { resolveConnectedTabIdentity, type ConnectedTabIdentity } from './connectedTabIdentity'
import {
  claimChatOccupancy as requestClaim,
  fetchChatOccupancySnapshot as requestSnapshot,
  normalizeChatOccupancies as requestNormalization,
  releaseChatOccupancy as requestRelease,
  renewChatOccupancy as requestRenewal,
  switchChatOccupancy as requestSwitch,
  type ChatOccupancyMutationTransportResult,
  type ChatOccupancyRequestScope,
  type ChatOccupancySnapshotTransportResult,
  type ChatOccupancyTransportError,
} from './chatOccupancyTransport'

export type ClientChatOccupancySupport = 'unknown' | 'unsupported' | 'disabled' | 'enabled'
export type ClientChatOccupancyIdentity = 'unknown' | 'exclusive' | 'unavailable'
export type ClientChatOccupancyAction = 'claim' | 'renew' | 'release' | 'switch' | 'normalize' | 'refresh'

export interface ClientChatOccupancyPendingAction {
  readonly action: Exclude<ClientChatOccupancyAction, 'renew' | 'refresh'>
  readonly chatId: string
  readonly targetChatId?: string
}

export interface ClientChatOccupancySnapshot {
  readonly support: ClientChatOccupancySupport
  readonly capability: ChatOccupancyCapability | null
  readonly identity: ClientChatOccupancyIdentity
  readonly sessionId: string | null
  readonly databaseLineage: string | null
  readonly sessionGeneration: number
  readonly occupancies: readonly ChatOccupancyProjection[]
  readonly pending: ClientChatOccupancyPendingAction | null
  readonly lastError: ChatOccupancyTransportError | null
}

export type ClientChatOccupancyProjection =
  | {
      readonly kind: 'unsupported'
      readonly support: ClientChatOccupancySupport
      readonly identity: ClientChatOccupancyIdentity
      readonly occupancy: ChatOccupancyProjection | null
    }
  | {
      readonly kind: 'available'
      readonly support: 'enabled' | 'disabled'
      readonly identity: ClientChatOccupancyIdentity
      readonly occupancy: ChatOccupancyProjection | null
      readonly expectedOccupancyEpoch: number
    }
  | {
      readonly kind: 'self-owned'
      readonly support: 'enabled' | 'disabled'
      readonly identity: ClientChatOccupancyIdentity
      readonly occupancy: ChatOccupancyProjection
    }
  | {
      readonly kind: 'foreign-owned'
      readonly support: 'enabled' | 'disabled'
      readonly identity: ClientChatOccupancyIdentity
      readonly occupancy: ChatOccupancyProjection
    }

export interface ClientChatOccupancyAuthority {
  readonly version: typeof CHAT_OCCUPANCY_PROTOCOL_VERSION
  readonly databaseLineage: string
  readonly chatId: string
  readonly sessionId: string
  readonly sessionGeneration: number
  readonly occupancyEpoch: number
  readonly claimClass: ChatOccupancyClaimClass
}

export type ClientChatOccupancyActionResult =
  | ChatOccupancyMutationTransportResult
  | {
      readonly status: 'unavailable'
      readonly reason:
        | 'protocol-unavailable'
        | 'protocol-disabled'
        | 'identity-not-exclusive'
        | 'session-unavailable'
        | 'connection-unavailable'
        | 'not-self-occupied'
        | 'busy'
    }

export type ClientChatOccupancyRefreshResult =
  | ChatOccupancySnapshotTransportResult
  | { readonly status: 'unavailable'; readonly reason: 'protocol-unavailable' | 'session-unavailable' }

const initialState: ClientChatOccupancySnapshot = Object.freeze({
  support: 'unknown',
  capability: null,
  identity: 'unknown',
  sessionId: null,
  databaseLineage: null,
  sessionGeneration: 0,
  occupancies: Object.freeze([]),
  pending: null,
  lastError: null,
})

let state = initialState
let knownIdentity: ConnectedTabIdentity | null = null
let identityRevision = 0
let actionController: AbortController | null = null
let renewalTimer: ReturnType<typeof setTimeout> | null = null
let renewalRunning = false
let renewalController: AbortController | null = null
type ClientChatOccupancyRecoveryHandler = (options: { readonly refresh: boolean }) => void | Promise<void>
const recoveryHandlers = new Set<ClientChatOccupancyRecoveryHandler>()
const stateStore = writable(state)

export const clientChatOccupancyStore = { subscribe: stateStore.subscribe }

/** Install an exact-scope recovery coordinator without coupling it to general-owner recovery. */
export function registerClientChatOccupancyRecoveryHandler(handler: ClientChatOccupancyRecoveryHandler): () => void {
  recoveryHandlers.add(handler)
  return () => recoveryHandlers.delete(handler)
}

/** Request recovery after connection/readiness changes that do not themselves publish occupancy state. */
export function requestClientChatOccupancyRecovery(options: { readonly refresh?: boolean } = {}): void {
  if (recoveryHandlers.size === 0) return
  queueMicrotask(() => {
    for (const handler of recoveryHandlers) {
      try {
        void Promise.resolve(handler({ refresh: options.refresh === true })).catch((error) => {
          console.warn('Occupied-chat generation recovery failed:', error)
        })
      } catch (error) {
        console.warn('Occupied-chat generation recovery failed:', error)
      }
    }
  })
}

export function getClientChatOccupancySnapshot(): ClientChatOccupancySnapshot {
  return state
}

/** Called after the page identity lock is resolved and the managed session begins. */
export function setClientChatOccupancyIdentity(identity: ConnectedTabIdentity, generation: number): boolean {
  const session = getClientSessionSnapshot()
  if (!session.managed || session.generation !== generation || session.sessionId !== identity.sessionId) return false
  identityRevision += 1
  knownIdentity = Object.freeze({ ...identity })
  publish({
    ...state,
    identity: identity.exclusive ? 'exclusive' : 'unavailable',
    sessionId: identity.sessionId,
    sessionGeneration: generation,
  })
  return true
}

/** Revokes browser-side admission immediately when the page releases its Web Lock. */
export function clearClientChatOccupancyIdentity(): void {
  identityRevision += 1
  knownIdentity = null
  abortActions()
  publish({ ...state, identity: 'unknown', pending: null })
}

/** Installs only an exact, lineage-coherent protocol snapshot from bootstrap. */
export function configureClientChatOccupancy(
  capability: ChatOccupancyCapability | undefined,
  snapshot: ChatOccupancySnapshot | undefined,
  sourceGeneration = captureClientSessionGeneration(),
): boolean {
  const session = getClientSessionSnapshot()
  if (
    !session.managed ||
    !session.authenticated ||
    session.generation !== sourceGeneration ||
    !session.sessionId ||
    !session.databaseLineage
  ) {
    return false
  }
  const exactCapability = capability && isChatOccupancyCapability(capability) ? capability : undefined
  const exactSnapshot = snapshot && isChatOccupancySnapshot(snapshot) ? snapshot : undefined
  if (!exactCapability || !exactSnapshot || exactSnapshot.databaseLineage !== session.databaseLineage) {
    abortActions()
    publish({
      ...initialState,
      support: 'unsupported',
      identity: identityForSession(session.sessionId),
      sessionId: session.sessionId,
      databaseLineage: session.databaseLineage,
      sessionGeneration: sourceGeneration,
    })
    return false
  }
  const sameScope = state.sessionId === session.sessionId && state.databaseLineage === session.databaseLineage
  const retainsNewerSnapshot =
    sameScope &&
    state.support !== 'unknown' &&
    state.support !== 'unsupported' &&
    snapshotRegresses(exactSnapshot.occupancies, state.occupancies)
  publish({
    support: exactCapability.enabled ? 'enabled' : 'disabled',
    capability: Object.freeze({ ...exactCapability }),
    identity: identityForSession(session.sessionId),
    sessionId: session.sessionId,
    databaseLineage: session.databaseLineage,
    sessionGeneration: sourceGeneration,
    occupancies: retainsNewerSnapshot ? state.occupancies : freezeOccupancies(exactSnapshot.occupancies),
    pending: sameScope ? state.pending : null,
    lastError: null,
  })
  return true
}

/** Applies a revision-free full snapshot only for the stream's exact page scope. */
export function applyClientChatOccupancyEvent(
  event: ChatOccupancyEvent,
  source: { readonly generation: number; readonly sessionId: string | null },
): boolean {
  const session = getClientSessionSnapshot()
  if (
    !isChatOccupancyEvent(event) ||
    state.support === 'unknown' ||
    state.support === 'unsupported' ||
    !session.authenticated ||
    session.generation !== source.generation ||
    session.sessionId !== source.sessionId ||
    state.sessionId !== source.sessionId ||
    state.databaseLineage !== event.databaseLineage ||
    session.databaseLineage !== event.databaseLineage ||
    snapshotRegresses(event.occupancies, state.occupancies)
  ) {
    return false
  }
  publish({ ...state, sessionGeneration: source.generation, occupancies: freezeOccupancies(event.occupancies) })
  return true
}

export function projectClientChatOccupancy(chatId: string): ClientChatOccupancyProjection {
  const occupancy = state.occupancies.find((candidate) => candidate.chatId === chatId) ?? null
  if (state.support === 'unknown' || state.support === 'unsupported') {
    return { kind: 'unsupported', support: state.support, identity: state.identity, occupancy }
  }
  if (
    !occupancy ||
    occupancy.state !== 'occupied' ||
    occupancy.leaseExpiresAtMs === null ||
    occupancy.leaseExpiresAtMs <= Date.now()
  ) {
    return {
      kind: 'available',
      support: state.support,
      identity: state.identity,
      occupancy,
      expectedOccupancyEpoch: occupancy?.occupancyEpoch ?? 0,
    }
  }
  return occupancy.occupantSessionId === state.sessionId && state.identity === 'exclusive'
    ? { kind: 'self-owned', support: state.support, identity: state.identity, occupancy }
    : { kind: 'foreign-owned', support: state.support, identity: state.identity, occupancy }
}

export function captureClientChatOccupancyAuthority(chatId: string): ClientChatOccupancyAuthority | null {
  const projected = projectClientChatOccupancy(chatId)
  const session = getClientSessionSnapshot()
  if (
    projected.kind !== 'self-owned' ||
    state.identity !== 'exclusive' ||
    !session.authenticated ||
    !session.projectionReady ||
    session.connection !== 'live' ||
    session.generation !== state.sessionGeneration ||
    session.sessionId !== state.sessionId ||
    session.databaseLineage !== state.databaseLineage ||
    !state.databaseLineage ||
    !state.sessionId ||
    projected.occupancy.claimClass === null ||
    projected.occupancy.leaseExpiresAtMs === null ||
    projected.occupancy.leaseExpiresAtMs <= Date.now()
  ) {
    return null
  }
  return Object.freeze({
    version: CHAT_OCCUPANCY_PROTOCOL_VERSION,
    databaseLineage: state.databaseLineage,
    chatId,
    sessionId: state.sessionId,
    sessionGeneration: state.sessionGeneration,
    occupancyEpoch: projected.occupancy.occupancyEpoch,
    claimClass: projected.occupancy.claimClass,
  })
}

export function isClientChatOccupancyAuthorityCurrent(
  authority: ClientChatOccupancyAuthority,
  options: { readonly requireEnabled?: boolean } = {},
): boolean {
  if (options.requireEnabled && state.support !== 'enabled') return false
  const current = captureClientChatOccupancyAuthority(authority.chatId)
  return (
    current !== null &&
    current.version === authority.version &&
    current.databaseLineage === authority.databaseLineage &&
    current.chatId === authority.chatId &&
    current.sessionId === authority.sessionId &&
    current.sessionGeneration === authority.sessionGeneration &&
    current.occupancyEpoch === authority.occupancyEpoch &&
    current.claimClass === authority.claimClass
  )
}

export function listClientChatOccupancyAuthorities(): readonly ClientChatOccupancyAuthority[] {
  return Object.freeze(
    state.occupancies.flatMap((occupancy) => {
      const authority = captureClientChatOccupancyAuthority(occupancy.chatId)
      return authority ? [authority] : []
    }),
  )
}

export async function refreshClientChatOccupancies(signal?: AbortSignal): Promise<ClientChatOccupancyRefreshResult> {
  if (occupancyProtocolUnavailable()) {
    return { status: 'unavailable', reason: 'protocol-unavailable' }
  }
  const scope = captureRequestScope()
  if (!scope) return { status: 'unavailable', reason: 'session-unavailable' }
  const result = await requestSnapshot(scope, signal)
  if (result.status !== 'ok') {
    if (result.status === 'error') publish({ ...state, lastError: result })
    return result
  }
  const current = getClientSessionSnapshot()
  if (
    current.generation !== scope.generation ||
    current.sessionId !== scope.sessionId ||
    current.databaseLineage !== scope.databaseLineage
  ) {
    return { status: 'unavailable', reason: 'superseded' }
  }
  if (!snapshotRegresses(result.snapshot.occupancies, state.occupancies)) {
    publish({ ...state, occupancies: freezeOccupancies(result.snapshot.occupancies), lastError: null })
  }
  return result
}

export function claimClientChatOccupancy(chatId: string): Promise<ClientChatOccupancyActionResult> {
  return runAction({ action: 'claim', chatId }, true, async (scope, signal) => {
    const projected = projectClientChatOccupancy(chatId)
    if (projected.kind === 'unsupported') return { status: 'unavailable', reason: 'protocol-unavailable' }
    const session = getClientSessionSnapshot()
    const claimClass: ChatOccupancyClaimClass = session.writer?.sessionId === session.sessionId ? 'owner' : 'chat_only'
    return requestClaim(
      scope,
      {
        chatId,
        expectedOccupancyEpoch:
          projected.kind === 'available' ? projected.expectedOccupancyEpoch : projected.occupancy.occupancyEpoch,
        claimClass,
      },
      signal,
    )
  })
}

export function releaseClientChatOccupancy(chatId: string): Promise<ClientChatOccupancyActionResult> {
  return runAction({ action: 'release', chatId }, false, async (scope, signal) => {
    const occupancy = selfOccupancy(chatId, true)
    if (!occupancy) return { status: 'unavailable', reason: 'not-self-occupied' }
    return requestRelease(scope, occupancy, signal)
  })
}

export function switchClientChatOccupancy(
  sourceChatId: string,
  targetChatId: string,
): Promise<ClientChatOccupancyActionResult> {
  return runAction({ action: 'switch', chatId: sourceChatId, targetChatId }, true, async (scope, signal) => {
    const source = selfOccupancy(sourceChatId)
    if (!source) return { status: 'unavailable', reason: 'not-self-occupied' }
    const result = await requestSwitch(
      scope,
      { sourceChatId, targetChatId, occupancyEpoch: source.occupancyEpoch },
      signal,
    )
    if (result.status === 'ok' && sourceChatId !== targetChatId) retireProjection(source)
    return result
  })
}

export function normalizeClientChatOccupancies(selectedChatId: string): Promise<ClientChatOccupancyActionResult> {
  return runAction({ action: 'normalize', chatId: selectedChatId }, true, async (scope, signal) => {
    const selected = selfOccupancy(selectedChatId)
    if (!selected) return { status: 'unavailable', reason: 'not-self-occupied' }
    const result = await requestNormalization(scope, selected, signal)
    if (result.status === 'ok') {
      publish({
        ...state,
        occupancies: freezeOccupancies(
          state.occupancies.map((occupancy) =>
            occupancy.occupantSessionId === state.sessionId && occupancy.chatId !== selectedChatId
              ? tombstoneAfter(occupancy)
              : occupancy,
          ),
        ),
      })
    }
    return result
  })
}

export function resetClientChatOccupancyForTests(): void {
  abortActions()
  identityRevision += 1
  knownIdentity = null
  renewalRunning = false
  renewalController = null
  state = initialState
  stateStore.set(state)
}

async function runAction(
  pending: ClientChatOccupancyPendingAction,
  requiresEnabled: boolean,
  operation: (scope: ChatOccupancyRequestScope, signal: AbortSignal) => Promise<ClientChatOccupancyActionResult>,
): Promise<ClientChatOccupancyActionResult> {
  if (state.pending) return { status: 'unavailable', reason: 'busy' }
  const admission = await admitAction(requiresEnabled)
  if ('status' in admission) return admission
  const staleAdmission = revalidateActionAdmission(admission, requiresEnabled)
  if (staleAdmission) return staleAdmission
  if (state.pending) return { status: 'unavailable', reason: 'busy' }
  const controller = new AbortController()
  actionController = controller
  publish({ ...state, pending: Object.freeze({ ...pending }), lastError: null })
  let result: ClientChatOccupancyActionResult
  try {
    result = await operation(admission.scope, controller.signal)
  } catch (error) {
    result = {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (actionController !== controller) return result
  actionController = null
  if (result.status === 'ok') mergeProjection(result.occupancy)
  else if (result.status === 'error') mergeErrorProjections(result)
  publish({ ...state, pending: null, lastError: result.status === 'error' ? result : null })
  return result
}

async function admitAction(
  requiresEnabled: boolean,
): Promise<
  | { readonly scope: ChatOccupancyRequestScope; readonly identityRevision: number }
  | Extract<ClientChatOccupancyActionResult, { status: 'unavailable' }>
> {
  if (occupancyProtocolUnavailable()) {
    return { status: 'unavailable', reason: 'protocol-unavailable' }
  }
  if (requiresEnabled && state.support !== 'enabled') return { status: 'unavailable', reason: 'protocol-disabled' }
  const session = getClientSessionSnapshot()
  if (!session.authenticated || !session.projectionReady || !session.sessionId || !session.databaseLineage) {
    return { status: 'unavailable', reason: 'session-unavailable' }
  }
  if (session.connection !== 'live') return { status: 'unavailable', reason: 'connection-unavailable' }
  let identity = knownIdentity
  if (!identity || identity.sessionId !== session.sessionId) {
    const sourceIdentityRevision = identityRevision
    try {
      identity = await resolveConnectedTabIdentity()
      if (sourceIdentityRevision !== identityRevision) {
        return { status: 'unavailable', reason: 'identity-not-exclusive' }
      }
      if (!setClientChatOccupancyIdentity(identity, session.generation)) {
        return { status: 'unavailable', reason: 'session-unavailable' }
      }
    } catch {
      return { status: 'unavailable', reason: 'identity-not-exclusive' }
    }
  }
  if (occupancyProtocolUnavailable()) {
    return { status: 'unavailable', reason: 'protocol-unavailable' }
  }
  if (requiresEnabled && state.support !== 'enabled') return { status: 'unavailable', reason: 'protocol-disabled' }
  const current = getClientSessionSnapshot()
  if (
    !current.authenticated ||
    !current.projectionReady ||
    current.generation !== session.generation ||
    current.sessionId !== session.sessionId ||
    current.databaseLineage !== session.databaseLineage
  ) {
    return { status: 'unavailable', reason: 'session-unavailable' }
  }
  if (current.connection !== 'live') return { status: 'unavailable', reason: 'connection-unavailable' }
  if (!identity.exclusive || identity.sessionId !== session.sessionId) {
    return { status: 'unavailable', reason: 'identity-not-exclusive' }
  }
  const scope = captureRequestScope()
  return scope ? { scope, identityRevision } : { status: 'unavailable', reason: 'session-unavailable' }
}

function revalidateActionAdmission(
  admission: { readonly scope: ChatOccupancyRequestScope; readonly identityRevision: number },
  requiresEnabled: boolean,
): Extract<ClientChatOccupancyActionResult, { status: 'unavailable' }> | null {
  if (occupancyProtocolUnavailable()) return { status: 'unavailable', reason: 'protocol-unavailable' }
  if (requiresEnabled && state.support !== 'enabled') return { status: 'unavailable', reason: 'protocol-disabled' }
  if (
    admission.identityRevision !== identityRevision ||
    state.identity !== 'exclusive' ||
    !knownIdentity?.exclusive ||
    knownIdentity.sessionId !== admission.scope.sessionId
  ) {
    return { status: 'unavailable', reason: 'identity-not-exclusive' }
  }
  const session = getClientSessionSnapshot()
  if (
    !session.authenticated ||
    !session.projectionReady ||
    session.generation !== admission.scope.generation ||
    session.sessionId !== admission.scope.sessionId ||
    session.databaseLineage !== admission.scope.databaseLineage ||
    state.sessionGeneration !== admission.scope.generation ||
    state.sessionId !== admission.scope.sessionId ||
    state.databaseLineage !== admission.scope.databaseLineage
  ) {
    return { status: 'unavailable', reason: 'session-unavailable' }
  }
  return session.connection === 'live' ? null : { status: 'unavailable', reason: 'connection-unavailable' }
}

function captureRequestScope(): ChatOccupancyRequestScope | null {
  const session = getClientSessionSnapshot()
  if (
    !session.authenticated ||
    !session.sessionId ||
    !session.databaseLineage ||
    state.sessionId !== session.sessionId ||
    state.databaseLineage !== session.databaseLineage ||
    state.sessionGeneration !== session.generation
  ) {
    return null
  }
  return {
    databaseLineage: session.databaseLineage,
    sessionId: session.sessionId,
    generation: session.generation,
  }
}

function occupancyProtocolUnavailable(): boolean {
  return state.support === 'unknown' || state.support === 'unsupported'
}

function selfOccupancy(chatId: string, allowExpired = false): ChatOccupancyProjection | null {
  const occupancy = state.occupancies.find((candidate) => candidate.chatId === chatId)
  if (!occupancy || occupancy.occupantSessionId !== state.sessionId) return null
  if (allowExpired) return occupancy.state === 'released' ? null : occupancy
  return occupancy.state === 'occupied' &&
    occupancy.leaseExpiresAtMs !== null &&
    occupancy.leaseExpiresAtMs > Date.now()
    ? occupancy
    : null
}

function selfOccupancies(): ChatOccupancyProjection[] {
  return state.occupancies.filter(
    (occupancy) =>
      occupancy.state === 'occupied' &&
      occupancy.occupantSessionId === state.sessionId &&
      occupancy.leaseExpiresAtMs !== null &&
      occupancy.leaseExpiresAtMs > Date.now(),
  )
}

function mergeProjection(projection: ChatOccupancyProjection): void {
  if (projection.databaseLineage !== state.databaseLineage) return
  const existing = state.occupancies.find((occupancy) => occupancy.chatId === projection.chatId)
  if (existing && projectionRegresses(projection, existing)) return
  publish({
    ...state,
    occupancies: freezeOccupancies([
      ...state.occupancies.filter((occupancy) => occupancy.chatId !== projection.chatId),
      projection,
    ]),
  })
}

function retireProjection(occupancy: ChatOccupancyProjection): void {
  mergeProjection(tombstoneAfter(occupancy))
}

function tombstoneAfter(occupancy: ChatOccupancyProjection): ChatOccupancyProjection {
  return {
    databaseLineage: occupancy.databaseLineage,
    chatId: occupancy.chatId,
    occupantSessionId: null,
    occupancyEpoch: occupancy.occupancyEpoch + 1,
    claimClass: null,
    state: 'released',
    claimedAtMs: null,
    leaseExpiresAtMs: null,
    updatedAtMs: occupancy.updatedAtMs,
    releasedAtMs: occupancy.updatedAtMs,
  }
}

function snapshotRegresses(
  incoming: readonly ChatOccupancyProjection[],
  existing: readonly ChatOccupancyProjection[],
): boolean {
  const byChat = new Map(existing.map((occupancy) => [occupancy.chatId, occupancy]))
  const incomingChats = new Set(incoming.map((occupancy) => occupancy.chatId))
  if (existing.some((occupancy) => !incomingChats.has(occupancy.chatId))) return true
  return incoming.some((occupancy) => {
    const previous = byChat.get(occupancy.chatId)
    return previous ? projectionRegresses(occupancy, previous) : false
  })
}

function mergeErrorProjections(error: ChatOccupancyTransportError): void {
  const current = error.details?.current
  if (current && isProjectionForCurrentLineage(current)) mergeProjection(current as ChatOccupancyProjection)
  const currentChats = error.details?.currentChats
  if (Array.isArray(currentChats)) {
    for (const candidate of currentChats) {
      if (isProjectionForCurrentLineage(candidate)) mergeProjection(candidate as ChatOccupancyProjection)
    }
  }
  const occupied = error.details?.occupancy
  if (occupied && isProjectionForCurrentLineage(occupied)) mergeProjection(occupied as ChatOccupancyProjection)
}

function isProjectionForCurrentLineage(value: unknown): boolean {
  return (
    state.databaseLineage !== null &&
    isChatOccupancySnapshot({
      version: CHAT_OCCUPANCY_PROTOCOL_VERSION,
      databaseLineage: state.databaseLineage,
      occupancies: [value],
    })
  )
}

function projectionRegresses(incoming: ChatOccupancyProjection, existing: ChatOccupancyProjection): boolean {
  return (
    incoming.occupancyEpoch < existing.occupancyEpoch ||
    (incoming.occupancyEpoch === existing.occupancyEpoch &&
      (incoming.updatedAtMs < existing.updatedAtMs ||
        (incoming.updatedAtMs === existing.updatedAtMs && !sameProjection(incoming, existing))))
  )
}

function sameProjection(left: ChatOccupancyProjection, right: ChatOccupancyProjection): boolean {
  return (
    left.databaseLineage === right.databaseLineage &&
    left.chatId === right.chatId &&
    left.occupantSessionId === right.occupantSessionId &&
    left.occupancyEpoch === right.occupancyEpoch &&
    left.claimClass === right.claimClass &&
    left.state === right.state &&
    left.claimedAtMs === right.claimedAtMs &&
    left.leaseExpiresAtMs === right.leaseExpiresAtMs &&
    left.updatedAtMs === right.updatedAtMs &&
    left.releasedAtMs === right.releasedAtMs
  )
}

function freezeOccupancies(occupancies: readonly ChatOccupancyProjection[]): readonly ChatOccupancyProjection[] {
  return Object.freeze(
    [...occupancies]
      .sort((left, right) => left.chatId.localeCompare(right.chatId))
      .map((occupancy) => Object.freeze({ ...occupancy })),
  )
}

function identityForSession(sessionId: string): ClientChatOccupancyIdentity {
  if (!knownIdentity || knownIdentity.sessionId !== sessionId) return 'unknown'
  return knownIdentity.exclusive ? 'exclusive' : 'unavailable'
}

function publish(next: ClientChatOccupancySnapshot): void {
  state = Object.freeze(next)
  stateStore.set(state)
  scheduleRenewal()
  // Also notify after authority disappears so recovery-only UI derived from a
  // previous claim is cleared for observers and signed-out sessions.
  requestClientChatOccupancyRecovery()
}

function scheduleRenewal(): void {
  if (!state.capability || state.identity !== 'exclusive' || selfOccupancies().length === 0) {
    if (renewalTimer) clearTimeout(renewalTimer)
    renewalTimer = null
    return
  }
  if (renewalRunning || renewalTimer) return
  renewalTimer = setTimeout(() => {
    renewalTimer = null
    void renewOwnedOccupancies()
  }, state.capability.renewAfterMs)
}

async function renewOwnedOccupancies(): Promise<void> {
  if (renewalRunning) return
  const scope = captureRequestScope()
  if (!scope || state.identity !== 'exclusive') {
    scheduleRenewal()
    return
  }
  renewalRunning = true
  const controller = new AbortController()
  renewalController = controller
  let latestError: ChatOccupancyTransportError | null = null
  try {
    for (const occupancy of selfOccupancies()) {
      const result = await requestRenewal(scope, occupancy, controller.signal)
      if (result.status === 'ok') mergeProjection(result.occupancy)
      else if (result.status === 'error') latestError = result
    }
    if (latestError) publish({ ...state, lastError: latestError })
  } finally {
    if (renewalController === controller) renewalController = null
    renewalRunning = false
    scheduleRenewal()
  }
}

function abortActions(): void {
  actionController?.abort()
  actionController = null
  renewalController?.abort()
  renewalController = null
  if (renewalTimer) clearTimeout(renewalTimer)
  renewalTimer = null
}

function observeSession(session: ClientSessionSnapshot): void {
  if (!session.managed || !session.authenticated || !session.sessionId || !session.databaseLineage) {
    if (state !== initialState) {
      abortActions()
      identityRevision += 1
      knownIdentity = null
      publish(initialState)
    }
    return
  }
  if (state.sessionId === session.sessionId && state.databaseLineage === session.databaseLineage) {
    if (state.sessionGeneration !== session.generation) {
      actionController?.abort()
      actionController = null
      renewalController?.abort()
      renewalController = null
      publish({ ...state, sessionGeneration: session.generation, pending: null })
    }
    return
  }
  abortActions()
  identityRevision += 1
  knownIdentity = knownIdentity?.sessionId === session.sessionId ? knownIdentity : null
  publish({
    ...initialState,
    identity: identityForSession(session.sessionId),
    sessionId: session.sessionId,
    databaseLineage: session.databaseLineage,
    sessionGeneration: session.generation,
  })
}

clientSessionStore.subscribe(observeSession)
