import { statSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  SUPPORT_DIAGNOSTICS_STATE_MAX_ITEMS,
  type SupportDiagnosticsStateResponse,
} from '@risuai/protocol/remote-diagnostics'
import {
  DEFAULT_AUTOMATIC_BACKUP_RETENTION,
  DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES,
  type AppConfig,
} from './config.js'
import type { BuildIdentity } from './buildIdentity.js'
import type { ActiveWriterState } from './activeWriter.js'
import type { GenerationJobRegistry } from './generationJobs.js'
import type { JobRegistry } from './streamJobs.js'
import type { ChatOccupancyService } from './chatOccupancy.js'
import type { MaintenanceCoordinator } from './maintenanceCoordinator.js'
import type { RemoteDiagnosticsSource } from './remoteDiagnostics.js'
import { getDatabaseOwnershipSnapshot } from './databaseLineage.js'
import { getSchemaState } from './db.js'
import { generationEffectClass, isGenerationEffectKind } from './generationEffects.js'
import { diagnosticReferenceForDatabase } from './diagnosticContext.js'
import { DIAGNOSTICS_JOURNAL_HARD_LIMITS } from './diagnosticsJournalProtocol.js'
import { DIAGNOSTICS_PROCESS_STARTED_AT, generationRejectionSnapshot } from './generationRejectionCounters.js'
import { protocolMetricsEnabled } from './protocolMetrics.js'

interface WorkerState {
  readonly isRunning: boolean
  readonly isProcessing: boolean
}
export interface SupportDiagnosticsStateSources {
  db: DatabaseSync
  config: AppConfig
  identity: SupportDiagnosticsStateResponse['identity']
  buildIdentity: BuildIdentity
  source: RemoteDiagnosticsSource
  generationJobs: GenerationJobRegistry
  streamJobs: JobRegistry
  occupancy: ChatOccupancyService
  chatOccupancyEnabled: boolean
  writer: ActiveWriterState
  memoryWorker: WorkerState | null
  bardWikiWorker: WorkerState | null
  maintenance: MaintenanceCoordinator
}

const worker = (value: WorkerState | null) => ({
  enabled: value !== null,
  running: value?.isRunning ?? false,
  processing: value?.isProcessing ?? false,
})
function streams(registry: JobRegistry) {
  const jobs = registry.list()
  return {
    total: registry.size(),
    active: jobs.filter((job) => !job.done).length,
    clients: jobs.reduce((total, job) => total + job.clients.size, 0),
    pendingBytes: jobs.reduce((total, job) => total + job.pendingBytes, 0),
    replayMemoryBytes: registry.replayMemoryBytes(),
  }
}
function fileBytes(file: string): number {
  // Missing WAL/SHM files mean zero bytes; all other I/O failures fail closed.
  return statSync(file, { throwIfNoEntry: false })?.size ?? 0
}

/** All database reads run in a single synchronous turn on the shared connection. */
export function readSupportDiagnosticsState(input: SupportDiagnosticsStateSources): SupportDiagnosticsStateResponse {
  const { db, config, source, buildIdentity, maintenance } = input
  const serverTime = Date.now()
  const ownership = getDatabaseOwnershipSnapshot(db)
  const schema = getSchemaState(db)
  const journal = source.read()
  const ref = (kind: 'chat' | 'operation' | 'attempt', id: string) =>
    diagnosticReferenceForDatabase(db, ownership.databaseLineage, kind, id)
  const active = input.generationJobs.activeJobs()
  const occupancies = input.occupancy.snapshot().occupancies
  const leases = occupancies.filter((item) => item.state !== 'released')
  const counts = { occupied: 0, expired: 0, released: 0 }
  for (const item of occupancies) counts[item.state]++
  const countStatuses = <T extends string>(
    sql: string,
    statuses: readonly T[],
    parameters: string[] = [],
  ): Record<T, number> => {
    const result = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>
    for (const row of db.prepare(sql).all(...parameters)) {
      if (!Object.hasOwn(result, String(row.status))) throw new Error('invalid-state')
      result[row.status as T] = Number(row.count)
    }
    return result
  }
  const liveOperations = countStatuses(
    `SELECT state AS status, COUNT(state) AS count FROM generation_operations INDEXED BY generation_operations_one_live_chat
     WHERE database_lineage = ? AND state IN ('accepted', 'launching', 'owned_by_job', 'stopping') GROUP BY state`,
    ['accepted', 'launching', 'owned_by_job', 'stopping'],
    [ownership.databaseLineage],
  )
  const effects = countStatuses(
    `SELECT status, COUNT(*) AS count FROM generation_effects INDEXED BY generation_effects_pending WHERE database_lineage = ? GROUP BY status`,
    ['pending', 'claimed', 'completed', 'skipped', 'failed'],
    [ownership.databaseLineage],
  )
  const effectClaims = {
    durableLive: 0,
    durableExpired: 0,
    nonDurable: 0,
    byKind: {
      igp: 0,
      plugin_output: 0,
      generated_translation: 0,
      notification: 0,
      tts: 0,
      completion_sound: 0,
      emotion_image_state: 0,
    },
  }
  for (const row of db
    .prepare(
      `SELECT effect_kind, (lease_expires_at IS NULL OR lease_expires_at <= ?) AS expired, COUNT(*) AS count
       FROM generation_effects INDEXED BY generation_effects_recoverable_claims
       WHERE database_lineage = ? AND status = 'claimed'
       GROUP BY effect_kind, expired`,
    )
    .all(new Date(serverTime).toISOString(), ownership.databaseLineage)) {
    if (!isGenerationEffectKind(row.effect_kind)) throw new Error('invalid-state')
    const count = Number(row.count)
    effectClaims.byKind[row.effect_kind] += count
    if (generationEffectClass(row.effect_kind) !== 'durable') effectClaims.nonDurable += count
    else if (row.expired) effectClaims.durableExpired += count
    else effectClaims.durableLive += count
  }
  const finalizationRetries = countStatuses(
    'SELECT status, COUNT(*) AS count FROM generation_finalization_retries INDEXED BY idx_generation_finalization_retries_status GROUP BY status',
    ['pending', 'terminal'],
  )
  const memoryJobs = countStatuses(
    'SELECT status, COUNT(*) AS count FROM memory_jobs INDEXED BY idx_memory_jobs_status_created GROUP BY status',
    ['pending', 'running', 'completed', 'failed', 'cancelled'],
  )
  const bardWikiJobs = countStatuses(
    'SELECT status, COUNT(*) AS count FROM bardwiki_jobs INDEXED BY idx_bardwiki_jobs_status_due GROUP BY status',
    ['pending', 'running', 'completed', 'failed', 'cancelled'],
  )
  const pragma = (name: 'page_count' | 'freelist_count' | 'page_size') =>
    Number(db.prepare(`PRAGMA ${name}`).get()![name])
  const [major, minor, patch] = process.versions.node.split('.').map(Number)
  const memory = process.memoryUsage()
  const limits = DIAGNOSTICS_JOURNAL_HARD_LIMITS
  return {
    version: 1,
    serverTime,
    identity: input.identity,
    deployment: {
      buildSource: buildIdentity.source,
      locationsTrusted: buildIdentity.locationsTrusted,
      ...(buildIdentity.dirty !== undefined ? { dirty: buildIdentity.dirty } : {}),
      ...(buildIdentity.commitTime !== undefined ? { commitTime: buildIdentity.commitTime } : {}),
      startedAt: DIAGNOSTICS_PROCESS_STARTED_AT,
    },
    process: {
      uptimeSeconds: process.uptime(),
      node: { major, minor, patch },
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
    },
    config: {
      diagnostics: source.enabled,
      supportDiagnostics: config.supportDiagnostics?.enabled === true,
      browserDiagnostics: config.browserDiagnostics?.enabled === true && source.enabled,
      rawTrace: Boolean(config.requestTrace),
      fullPrompt: config.generationTrace?.fullPrompt === true,
      rawMetrics: protocolMetricsEnabled(),
      chatOccupancy: input.chatOccupancyEnabled,
      staticServing: Boolean(config.staticRoot),
      agentDevAuthBypass: config.agentDevAuthBypass === true,
      hub: config.hubUrl === 'https://sv.risuai.xyz' ? 'default' : 'custom',
      realm: !config.realmUrl || config.realmUrl === 'https://realm.risuai.net' ? 'default' : 'custom',
      trustProxy:
        typeof config.trustProxy === 'boolean'
          ? config.trustProxy
            ? 'enabled'
            : 'disabled'
          : typeof config.trustProxy === 'number'
            ? 'hops'
            : 'custom',
      bodyLimit: config.bodyLimit,
      importUnlimited: config.importMaxBytes === Infinity,
      ...(config.importMaxBytes === Infinity ? {} : { importMaxBytes: config.importMaxBytes }),
      automaticBackupRetention: config.automaticBackupRetention ?? DEFAULT_AUTOMATIC_BACKUP_RETENTION,
      realmImportMaxExpandedBytes: config.realmImportMaxExpandedBytes ?? DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES,
    },
    database: {
      schemaVersion: schema.version,
      revision: schema.revision,
      pageCount: pragma('page_count'),
      freelistCount: pragma('freelist_count'),
      pageSize: pragma('page_size'),
      files: {
        database: fileBytes(path.join(config.dataDir, 'risu.db')),
        wal: fileBytes(path.join(config.dataDir, 'risu.db-wal')),
        shm: fileBytes(path.join(config.dataDir, 'risu.db-shm')),
      },
    },
    journal: {
      source: journal.source,
      available: journal.source !== 'unavailable',
      epoch: journal.epoch,
      retained: journal.entries.length,
      pending: journal.pending ?? 0,
      dropped: journal.dropped,
      rejected: journal.rejected,
      pruned: journal.pruned,
      operationContinuity: journal.operationContinuity ?? 'process-only',
      limits: {
        maxAgeMs: limits.maxAgeMs,
        maxEvents: limits.maxEvents,
        maxBytes: limits.maxBytes,
        maxQueue: limits.maxQueue,
        maxRecordBytes: limits.maxRecordBytes,
        maxFileBytes: limits.maxFileBytes,
      },
    },
    generation: {
      activeTotal: active.length,
      activeTruncated: active.length > SUPPORT_DIAGNOSTICS_STATE_MAX_ITEMS,
      active: active.slice(0, SUPPORT_DIAGNOSTICS_STATE_MAX_ITEMS).map((job) => ({
        chat: ref('chat', job.chatId),
        attempt: ref('attempt', job.jobId),
        ...(job.operationId ? { operation: ref('operation', job.operationId) } : {}),
        ...(job.mode ? { mode: job.mode } : {}),
        ...(job.writerEpoch !== undefined ? { writerEpoch: job.writerEpoch } : {}),
        ...(job.operationStateVersion !== undefined ? { operationStateVersion: job.operationStateVersion } : {}),
        ...(job.projectionEpoch !== undefined ? { projectionEpoch: job.projectionEpoch } : {}),
        ...(job.attemptNo !== undefined ? { attemptNo: job.attemptNo } : {}),
      })),
      jobs: streams(input.generationJobs.registry),
      streams: streams(input.streamJobs),
      liveOperations,
      effects,
      effectClaims,
      finalizationRetries,
    },
    occupancy: {
      counts,
      truncated: leases.length > SUPPORT_DIAGNOSTICS_STATE_MAX_ITEMS,
      leases: leases.slice(0, SUPPORT_DIAGNOSTICS_STATE_MAX_ITEMS).map((item) => ({
        chat: ref('chat', item.chatId),
        state: item.state as 'occupied' | 'expired',
        ...(item.claimClass !== null ? { claimClass: item.claimClass } : {}),
        epoch: item.occupancyEpoch,
        updatedAt: item.updatedAtMs,
        ...(item.claimedAtMs !== null ? { claimedAt: item.claimedAtMs } : {}),
        ...(item.leaseExpiresAtMs !== null ? { expiresAt: item.leaseExpiresAtMs } : {}),
      })),
    },
    writer: {
      present: ownership.writer.sessionId !== null,
      epoch: ownership.writer.epoch,
      runtimePresent: input.writer.sessionId !== null,
      runtimeEpoch: input.writer.epoch,
      connectedSessions: input.writer.connectedSessions.size,
    },
    workers: {
      memory: worker(input.memoryWorker),
      bardWiki: worker(input.bardWikiWorker),
      memoryJobs,
      bardWikiJobs,
      maintenance: {
        closing: maintenance.isClosing,
        closed: maintenance.isClosed,
        reclamationBlocked: maintenance.isReclamationBlocked(),
        activityVersion: maintenance.activityVersion,
        protectionVersion: maintenance.protectionVersion,
      },
    },
    rejections: generationRejectionSnapshot(),
  }
}
