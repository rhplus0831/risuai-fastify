import { storeGenerationConfiguration } from '../../src/generationConfiguration.js'
import type { AcceptedEffectiveGenerationConfiguration } from '../../src/prompt/assemble.js'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabaseLineage } from '../../src/databaseLineage.js'
import {
  createGenerationOperation,
  generationEffectiveConfigurationFingerprint,
  reserveGenerationOperationAttempt,
} from '../../src/generationOperations.js'

// Both memory handlers must consume the accepted configuration and exact attempt.
export function acceptedGenerationProvenance(
  db: DatabaseSync,
  acceptedDatabase: unknown,
  seedId: string,
  storageVersion: 1 | 2 = 1,
) {
  const databaseLineage = getDatabaseLineage(db)
  const operationId = `operation-${seedId}`
  const generationScope = { admissionKind: 'legacy_owner' as const }
  let effectiveConfiguration: unknown = {
    version: 1,
    database: acceptedDatabase,
    promptInfo: {},
    resolvedMainProfile: {},
  }
  if (storageVersion === 2) {
    db.exec('BEGIN IMMEDIATE')
    try {
      effectiveConfiguration = storeGenerationConfiguration(
        db,
        effectiveConfiguration as AcceptedEffectiveGenerationConfiguration,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const operation = createGenerationOperation(db, {
    databaseLineage,
    operationId,
    protocolVersion: 1,
    requestOrigin: 'accepted_send',
    creatorWriterSessionId: 'writer-a',
    creatorWriterEpoch: 1,
    generationScope,
    effectiveConfiguration,
    effectiveConfigurationFingerprint: generationEffectiveConfigurationFingerprint(effectiveConfiguration),
    bindingServerInstanceId: 'server-a',
    characterId: 'character-a',
    chatId: 'chat-1',
    mode: 'send',
    acceptedMessageId: 'message-a',
    requestFingerprint: 'a'.repeat(64),
    intent: { mode: 'send' },
    acceptedRevision: 0,
    state: 'accepted',
  })
  const reservation = reserveGenerationOperationAttempt(db, {
    databaseLineage,
    operationId,
    expectedState: 'accepted',
    expectedStateVersion: operation.stateVersion,
    retryRequestId: `retry-${seedId}`,
    jobId: `generation-job-${seedId}`,
    serverInstanceId: 'server-a',
    actorWriterSessionId: 'writer-a',
    actorWriterEpoch: 1,
    launchRevision: 0,
  })
  if (reservation.status !== 'applied' || !reservation.operation.currentAttempt) {
    throw new Error('failed to reserve accepted memory generation attempt')
  }
  return {
    operationId,
    operationAttemptNo: reservation.operation.currentAttempt.attemptNo,
    generationScope,
  }
}
