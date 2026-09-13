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
import { shouldAutoAcquireDisconnectedWriter } from './server/automaticWriterAcquisition'
import { resolveConnectedTabIdentity } from './server/connectedTabIdentity'

export interface ConnectedStartupResult {
  readonly role: 'reader' | 'writer'
  readonly runtime: ServerBootstrapRuntime
  readonly operation: ClientSessionOperation
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
  options.onOperationStarted?.(operation)
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
  const autoAcquire =
    identity.exclusive &&
    runtime.initialized &&
    ownership.writer.sessionId !== null &&
    ownership.writer.sessionId !== identity.sessionId
      ? await shouldAutoAcquireDisconnectedWriter()
      : false
  assertCurrent()
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
    if (acquired.status === 'ok') {
      if (!authorizeClientWriterRecovery(operation, bootstrapOwnership(acquired.bootstrap))) {
        throw new Error('Server did not authorize writer recovery')
      }
      return { role: 'writer', runtime: acquired.bootstrap, operation }
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
  return { role: 'reader', runtime, operation }
}
