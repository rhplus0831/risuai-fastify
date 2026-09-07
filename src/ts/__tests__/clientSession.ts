import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  completeClientWriterRecovery,
  setClientConnectionState,
  setClientProjectionReady,
} from '../clientSession'

const writerOwnership = {
  databaseLineage: 'draft-test-lineage',
  writer: { sessionId: 'draft-test-session', epoch: 1 },
}

export function enterClientWriter(): void {
  const operation = beginClientSession(writerOwnership.writer.sessionId)
  if (!authorizeClientWriterRecovery(operation, writerOwnership)) throw new Error('Writer recovery was not admitted')
  setClientConnectionState('live')
  setClientProjectionReady(true)
  if (!completeClientWriterRecovery(operation)) throw new Error('Writer recovery did not complete')
}

export function repromoteClientWriter(): void {
  const operation = beginClientPromotion()
  if (!operation || !authorizeClientWriterRecovery(operation, writerOwnership))
    throw new Error('Promotion was not admitted')
  if (!completeClientWriterRecovery(operation)) throw new Error('Promotion did not complete')
}
