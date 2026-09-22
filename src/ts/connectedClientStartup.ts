import {
  authorizeClientWriterRecovery,
  authenticateClientSessionReadView,
  beginClientSession,
  isClientSessionOperationCurrent,
  settleClientReader,
  requireClientAuthentication,
  type ClientSessionOperation,
  type ClientSessionOwnership,
} from './clientSession'
import { fetchServerBootstrap, fetchServerBootstrapReadOnly, type ServerBootstrapRuntime } from './server/bootstrap'
import { readAutoAcquireDisconnectedWriterPreference } from './server/automaticWriterAcquisition'
import { resolveConnectedTabIdentity } from './server/connectedTabIdentity'
import { setClientChatOccupancyIdentity } from './server/chatOccupancy'
import { recordRecoveryDiagnostic } from './server/recoveryDiagnostics'

export interface ConnectedStartupResult {
  readonly role: 'reader' | 'writer'
  readonly runtime: ServerBootstrapRuntime
  readonly operation: ClientSessionOperation
  /**
   * The page settled as a reader only because the acquisition preference could
   * not be read. The caller retries automatic acquisition instead of leaving
   * the role to the next foreground return or an explicit Use this device.
   */
  readonly acquisitionDeferred: boolean
}

export function bootstrapOwnership(runtime: ServerBootstrapRuntime): ClientSessionOwnership {
  if (!runtime.databaseLineage || !runtime.writer || !Number.isSafeInteger(runtime.writer.epoch)) {
    throw new Error('Server bootstrap is missing current ownership metadata')
  }
  return { databaseLineage: runtime.databaseLineage, writer: runtime.writer }
}

/** Automatic acquisition remains conditional and never disconnects a live writer. */
export async function resolveConnectedClientStartup(
  options: {
    onOperationStarted?: (operation: ClientSessionOperation) => void
    onInitializationRequired?: (operation: ClientSessionOperation) => Promise<boolean>
  } = {},
): Promise<ConnectedStartupResult> {
  const identity = await resolveConnectedTabIdentity()
  const operation = beginClientSession(identity.sessionId)
  setClientChatOccupancyIdentity(identity, operation.generation)
  options.onOperationStarted?.(operation)
  // A discarded or restarted page re-enters here; `exclusive` says whether it
  // may acquire at all, and a recovered identity distinguishes resume from restart.
  recordRecoveryDiagnostic('startup-identity', {
    outcome: identity.exclusive ? 'ok' : 'rejected',
    exclusive: identity.exclusive,
  })
  const assertCurrent = () => {
    if (!isClientSessionOperationCurrent(operation)) throw new Error('Connected startup was superseded')
  }
  let result = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
  assertCurrent()
  if (result.status !== 'ok') {
    if (result.status === 'error' && result.httpStatus === 401) requireClientAuthentication()
    throw new Error(result.status === 'unavailable' ? 'Server bootstrap is unavailable' : result.error)
  }
  let runtime = result.bootstrap
  const ownership = bootstrapOwnership(runtime)
  if (!authenticateClientSessionReadView(operation, ownership)) throw new Error('Connected startup was superseded')
  let initializationConfirmed = false
  if (
    identity.exclusive === false &&
    runtime.initialized === false &&
    ownership.writer.sessionId === null &&
    options.onInitializationRequired
  ) {
    initializationConfirmed = await options.onInitializationRequired(operation)
    assertCurrent()
  }
  const foreignWriter =
    identity.exclusive &&
    runtime.initialized &&
    ownership.writer.sessionId !== null &&
    ownership.writer.sessionId !== identity.sessionId
  const preference = foreignWriter ? await readAutoAcquireDisconnectedWriterPreference() : null
  assertCurrent()
  if (preference) {
    recordRecoveryDiagnostic('startup-auto-acquire-preference', {
      outcome: preference.status !== 'ok' ? 'failed' : preference.enabled ? 'ok' : 'rejected',
      attemptCount: preference.attempts,
    })
  }
  // An unreadable preference is not a refusal. It never grants takeover, but
  // the reader it settles keeps retrying acquisition rather than waiting for a tap.
  const autoAcquire = preference?.status === 'ok' && preference.enabled
  const acquisitionDeferred = preference?.status === 'unavailable'
  if (
    (identity.exclusive || initializationConfirmed) &&
    (ownership.writer.sessionId === null || ownership.writer.sessionId === identity.sessionId || autoAcquire)
  ) {
    // The precondition makes the discovery/acquisition race atomic on the server.
    // In particular, a still-owning reload cannot take back ownership after a
    // different client wins while this read is in flight.
    const acquired = await fetchServerBootstrap(null, {
      expectedWriter: {
        epoch: ownership.writer.epoch,
        databaseLineage: ownership.databaseLineage,
      },
    })
    assertCurrent()
    recordRecoveryDiagnostic('startup-acquire', {
      outcome:
        acquired.status === 'ok'
          ? 'ok'
          : acquired.status === 'active-writer-connected' ||
              (acquired.status === 'error' && ['active_writer_changed', 'active_writer_stale'].includes(acquired.error))
            ? 'rejected'
            : 'failed',
      exclusive: identity.exclusive,
    })
    if (acquired.status === 'ok') {
      if (!authorizeClientWriterRecovery(operation, bootstrapOwnership(acquired.bootstrap))) {
        throw new Error('Server did not authorize writer recovery')
      }
      return { role: 'writer', runtime: acquired.bootstrap, operation, acquisitionDeferred: false }
    }
    if (acquired.status === 'error' && acquired.httpStatus === 401) requireClientAuthentication()
    if (
      acquired.status !== 'active-writer-connected' &&
      (acquired.status !== 'error' || !['active_writer_changed', 'active_writer_stale'].includes(acquired.error))
    ) {
      throw new Error(acquired.status === 'unavailable' ? 'Server bootstrap is unavailable' : acquired.error)
    }
    result = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
    assertCurrent()
    if (result.status !== 'ok') {
      if (result.status === 'error' && result.httpStatus === 401) requireClientAuthentication()
      throw new Error(result.status === 'unavailable' ? 'Server bootstrap is unavailable' : result.error)
    }
    runtime = result.bootstrap
  }
  if (!runtime.initialized) throw new Error('Waiting for the server database to be initialized')
  if (!settleClientReader(operation, bootstrapOwnership(runtime))) throw new Error('Reader startup was superseded')
  recordRecoveryDiagnostic('startup-reader', {
    outcome: acquisitionDeferred ? 'pending' : 'ok',
    exclusive: identity.exclusive,
  })
  return { role: 'reader', runtime, operation, acquisitionDeferred }
}
