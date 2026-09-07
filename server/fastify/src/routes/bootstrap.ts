import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { ActiveWriterState } from '../activeWriter.js'
import {
  disconnectExistingWriterWasConfirmed,
  readActiveWriterSessionId,
  registerActiveWriterSession,
  requestedWriterWasActive,
  writerTakeoverRequiresConfirmation,
} from '../activeWriter.js'
import type { AuthState } from '../auth.js'
import type { GenerationJobRegistry } from '../generationJobs.js'
import { requireAuth } from '../http.js'
import { getSchemaState } from '../db.js'
import type { MessageTranslationJobRegistry } from '../messageTranslationJobs.js'
import type { GreetingTranslationJobRegistry } from '../greetingTranslationJobs.js'
import {
  emitProtocolMetric,
  jsonPayloadBytes,
  protocolDurationMs,
  protocolMetricsEnabled,
  protocolNowMs,
} from '../protocolMetrics.js'
import { readRequestTraceUid } from '../requestTrace.js'
import { getDatabaseLineage, getDatabaseWriterMetadata } from '../databaseLineage.js'
import { assessDatabaseInitialization } from '../databaseInitialization.js'
import {
  GENERATION_OPERATION_PROTOCOL_VERSION,
  getGenerationOperationProjectionEpoch,
  listGenerationOperationProjections,
} from '../generationOperations.js'
import { listGenerationFinalizationRetryProjections } from '../generationFinalizationRetry.js'
import { listPendingClientGenerationEffects } from '../generationEffects.js'
import { DISPLAY_SOURCE_PROTOCOL_VERSION } from '@risuai/protocol/display-source'
import { STARTUP_TELEMETRY_PROTOCOL_VERSION } from '@risuai/protocol/startup-telemetry'
import { DIAGNOSTICS_VERSION } from '@risuai/protocol/diagnostics'

export const ASSET_BASE_URL = '/api/v1/assets'
export const WRITER_OBSERVER_SESSION_HEADER = 'risu-writer-observer-session'
export const EXPECTED_WRITER_EPOCH_HEADER = 'risu-expected-writer-epoch'
export const EXPECTED_DATABASE_LINEAGE_HEADER = 'risu-expected-database-lineage'

function readExpectedWriter(req: FastifyRequest): { epoch: number; databaseLineage: string } | null | undefined {
  const epoch = req.headers[EXPECTED_WRITER_EPOCH_HEADER]
  const databaseLineage = req.headers[EXPECTED_DATABASE_LINEAGE_HEADER]
  if (epoch === undefined && databaseLineage === undefined) return undefined
  if (
    readActiveWriterSessionId(req) === null ||
    typeof epoch !== 'string' ||
    !/^(0|[1-9]\d*)$/u.test(epoch) ||
    !Number.isSafeInteger(Number(epoch)) ||
    typeof databaseLineage !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(databaseLineage)
  )
    return null
  return { epoch: Number(epoch), databaseLineage }
}

function readWriterObserverSessionId(req: FastifyRequest): string | null {
  const raw = req.headers[WRITER_OBSERVER_SESSION_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const sessionId = value.trim()
  return sessionId.length > 0 && sessionId.length <= 128 ? sessionId : null
}

export function registerBootstrapRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  _dataDir: string,
  activeWriterState?: ActiveWriterState,
  generationJobs?: GenerationJobRegistry,
  messageTranslationJobs?: MessageTranslationJobRegistry,
  greetingTranslationJobs?: GreetingTranslationJobRegistry,
  clientDiagnostics = false,
): void {
  app.get('/api/v1/bootstrap', { exposeHeadRoute: false }, async (req, reply) => {
    const metricStartedAt = protocolMetricsEnabled() ? protocolNowMs() : 0
    if (!(await requireAuth(authState, req, reply))) return
    const expectedWriter = readExpectedWriter(req)
    if (expectedWriter === null || (expectedWriter !== undefined && !activeWriterState)) {
      return reply.code(400).send({
        error: 'invalid_expected_writer',
        reason:
          'Conditional acquisition requires a writer session, a non-negative integer epoch, and a database lineage.',
      })
    }
    // No await separates this check, takeover confirmation, and registration.
    // A competing request cannot acquire between discovery validation and registration.
    if (
      expectedWriter !== undefined &&
      (expectedWriter.epoch !== getDatabaseWriterMetadata(db).epoch ||
        expectedWriter.databaseLineage !== getDatabaseLineage(db))
    ) {
      return reply.code(409).send({
        error: 'active_writer_changed',
        reason:
          'Writer ownership or the database changed after discovery. Read current ownership before acquiring write access.',
      })
    }
    if (
      activeWriterState &&
      writerTakeoverRequiresConfirmation(activeWriterState, req) &&
      !disconnectExistingWriterWasConfirmed(req)
    ) {
      reply.code(409).send({
        error: 'active_writer_connected',
        reason: 'Another browser session is still connected. Confirm its disconnection before taking write access.',
      })
      return
    }
    const wasRequestedWriterActive = activeWriterState ? requestedWriterWasActive(activeWriterState, req) : undefined
    if (activeWriterState) {
      registerActiveWriterSession(activeWriterState, req)
    }
    const requestedWriterSessionId = readActiveWriterSessionId(req)
    const observerWriterSessionId = readWriterObserverSessionId(req)
    const writerScopedSessionId = requestedWriterSessionId ?? observerWriterSessionId
    const ownsWriterScope =
      activeWriterState !== undefined &&
      writerScopedSessionId !== null &&
      writerScopedSessionId === activeWriterState.sessionId
    const { version, revision } = getSchemaState(db)
    const generationOperationProjectionEpoch = getGenerationOperationProjectionEpoch(db)
    const generationOperations = listGenerationOperationProjections(db)
    const writer = getDatabaseWriterMetadata(db)
    const response = {
      // A damaged database with durable user data must never invite the client
      // to run first-use initialization. The initialize command uses this same
      // classifier and returns a conflict if a race reaches it anyway.
      initialized: assessDatabaseInitialization(db).state !== 'uninitialized',
      revision,
      schemaVersion: version,
      databaseLineage: getDatabaseLineage(db),
      writerEpoch: writer.epoch,
      writer,
      ...(wasRequestedWriterActive === undefined ? {} : { requestedWriterWasActive: wasRequestedWriterActive }),
      assetBaseUrl: ASSET_BASE_URL,
      generationOperationProtocol: { version: GENERATION_OPERATION_PROTOCOL_VERSION },
      displaySourceProtocol: { version: DISPLAY_SOURCE_PROTOCOL_VERSION },
      ...(clientDiagnostics ? { clientDiagnostics: { version: DIAGNOSTICS_VERSION } } : {}),
      ...(protocolMetricsEnabled()
        ? { startupTelemetry: { version: STARTUP_TELEMETRY_PROTOCOL_VERSION, sampleRate: 1 as const } }
        : {}),
      generationOperationProjectionEpoch,
      generationOperations,
      // Transient running generations so a returning client, even after a full
      // reload, can discover and reattach. Server-memory only.
      activeGenerationJobs: generationJobs?.activeJobs() ?? [],
      // SQLite-backed finalization work is projected only to the active writer.
      // Unlike process-local jobs, these rows survive browser and server restarts.
      ...(ownsWriterScope ? { generationFinalizations: listGenerationFinalizationRetryProjections(db) } : {}),
      ...(ownsWriterScope ? { pendingGenerationEffects: listPendingClientGenerationEffects(db) } : {}),
      // Detached message translations and their short-lived terminal outcomes.
      // This lets a returning browser preserve busy controls, report failures,
      // and rehydrate successful translations after reload.
      activeMessageTranslations: messageTranslationJobs?.translations() ?? [],
      activeGreetingTranslations: greetingTranslationJobs?.translations() ?? [],
    }
    emitProtocolMetric(
      'bootstrap_projection',
      () => {
        const requestUid = readRequestTraceUid(req)
        return {
          revision,
          durationMs: protocolDurationMs(metricStartedAt),
          payloadBytes: jsonPayloadBytes(response),
          ...(requestUid ? { requestUid } : {}),
          activeGenerationJobCount: response.activeGenerationJobs.length,
          generationOperationCount: generationOperations.length,
          generationOperationProjectionEpoch,
          generationFinalizationCount:
            'generationFinalizations' in response ? (response.generationFinalizations?.length ?? 0) : 0,
          pendingGenerationEffectCount:
            'pendingGenerationEffects' in response ? (response.pendingGenerationEffects?.length ?? 0) : 0,
          activeMessageTranslationCount: response.activeMessageTranslations.length,
          activeGreetingTranslationCount: response.activeGreetingTranslations.length,
        }
      },
      req.log,
    )
    return response
  })
}
