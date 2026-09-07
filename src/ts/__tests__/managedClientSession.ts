import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  completeClientWriterRecovery,
  demoteClientSession,
  getClientSessionSnapshot,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from '../clientSession'

export function setManagedWriterForTest(): void {
  const operation = beginClientSession('external-operation-test')
  const ownership = {
    databaseLineage: 'external-operation-database',
    writer: { sessionId: 'external-operation-test', epoch: 1 },
  }
  authorizeClientWriterRecovery(operation, ownership)
  setClientProjectionReady(true)
  setClientConnectionState('live')
  if (!completeClientWriterRecovery(operation)) throw new Error('Failed to prepare test writer')
}

export function setManagedReaderForTest(): void {
  const operation = beginClientSession('external-operation-test')
  settleClientReader(operation, {
    databaseLineage: 'external-operation-database',
    writer: { sessionId: 'other-writer', epoch: 1 },
  })
  setClientProjectionReady(true)
  setClientConnectionState('live')
}

export function demoteAndRepromoteForTest(): void {
  demoteClientSession()
  const operation = beginClientPromotion()
  if (!operation) throw new Error('Failed to begin test promotion')
  const snapshot = getClientSessionSnapshot()
  authorizeClientWriterRecovery(operation, {
    databaseLineage: snapshot.databaseLineage!,
    writer: { sessionId: snapshot.sessionId, epoch: snapshot.writer!.epoch + 1 },
  })
  if (!completeClientWriterRecovery(operation)) throw new Error('Failed to complete test promotion')
}
