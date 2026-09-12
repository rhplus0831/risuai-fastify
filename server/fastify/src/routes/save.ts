import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthState } from '../auth.js'
import { COMMAND_EVENT_CATALOG, type CommandEventSink } from '../commands/events.js'
import { getSchemaState } from '../db.js'
import { getDatabaseOwnershipSnapshot, type DatabaseOwnershipSnapshot } from '../databaseLineage.js'
import { requireAuth } from '../http.js'
import { attachAbort } from '../requestAbort.js'
import { getMaintenanceCoordinator, MaintenanceBusyError, type MaintenanceLease } from '../maintenanceCoordinator.js'
import {
  AutomaticBackupError,
  ValidationError,
  applyImport,
  assetPath,
  cleanupCopiedStagedAssetFiles,
  getAllAssetMetadata,
  loadPersistedWithMessages,
  persistStagedAssetsInTransaction,
  type Persisted,
  type StagedAssetLiveFileCopy,
} from '../repository.js'
import {
  listLegacySummaryTombstones,
  replaceLegacyHypaV3MemoryRowsInTransaction,
  type LegacyHypaV3BackfillResult,
} from '../memoryLegacyImport.js'
import {
  UnsupportedGroupCharactersError,
  UnsupportedStandaloneChatBlocksError,
  decodeRisuSaveImportSnapshot,
  normalizeRisuSaveJsonImportSnapshot,
} from '../risuSave/importSnapshot.js'
import type { RisuServerPortableMetadata } from '../risuSave/portableMetadata.js'
import { decodeLocalBackup } from '../risuSave/localBackupImport.js'
import {
  normalizeLegacyLocalBackupImportDatabase,
  prepareLegacyLocalBackupExportDatabase,
} from '../risuSave/localBackupDatabase.js'
import {
  buildRepositoryRisuSaveExportSnapshot,
  buildRisuSaveExportSnapshotFromPersisted,
  encodeRisuSaveBlockExportSnapshot,
  encodeRisuSaveLegacyExportSnapshot,
  type RisuSaveExportSnapshot,
} from '../risuSave/exportSnapshot.js'
import { buildRepositoryRisuSaveBundleExport } from '../risuSave/bundleExport.js'
import { buildRepositoryRisuLocalBackupExport } from '../risuSave/localBackupExport.js'
import {
  buildRisuSaveAssetReport,
  buildRepositoryRisuSaveAssetReport,
  summarizeRisuSaveAssetReport,
} from '../risuSave/assetReferences.js'
import type { LegacyRisuSaveEnvelopeKind } from '../risuSave/legacyEnvelopeCodec.js'
import { importRateLimit } from '../routeRateLimits.js'
import { emitProtocolMetric, protocolDurationMs, protocolMetricsEnabled, protocolNowMs } from '../protocolMetrics.js'
import type { GreetingTranslationRow } from '../translation/greetingTranslationStore.js'

interface ImportBody {
  database?: unknown
}

type ExportEnvelope = LegacyRisuSaveEnvelopeKind | 'risusave-blocks'

interface ExportQuery {
  envelope?: unknown
  compression?: unknown
}

const EXPORT_FILENAME = 'database.risu'
const BUNDLE_EXPORT_FILENAME = 'database.risu.zip'
const LOCAL_BACKUP_EXPORT_FILENAME = 'database.bin'
const ESTIMATED_BACKUP_BYTES_HEADER = 'x-risu-estimated-backup-bytes'
const LOCAL_BACKUP_DATABASE_ENVELOPE = 'legacy-compressed'
const SQLITE_EXPORT_ESTIMATE_FILE = 'risu.db'
const BUNDLE_IMPORT_ROLLBACK_CLEANUP_WARNING = 'Bundle-import rollback could not remove some staged asset files'
// Unlimited by default: the upload streams to a temp file and decodes in bounded
// batches, so size is constrained by disk, not memory. A finite ceiling is opt-in
// via RISU_API_IMPORT_MAX_BYTES (see config.ts).
const DEFAULT_IMPORT_MAX_BYTES = Number.POSITIVE_INFINITY
// Backstop for a bundle's inner `database.risu`: unlike asset entries, it
// inflates fully in memory before decoding, so it needs a finite expanded-size
// cap when no import ceiling is configured.
const DEFAULT_BUNDLE_INNER_RISU_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024

export function registerSaveRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  dataDir: string,
  eventSink: CommandEventSink,
  options: {
    maxExpandedImportBytes?: number
    importMaxBytes?: number
    automaticBackupRetention?: number
  } = {},
): void {
  const importMaxBytes = options.importMaxBytes ?? DEFAULT_IMPORT_MAX_BYTES
  // Use the explicit import ceiling when set; otherwise use the ordinary
  // expanded import cap, falling back to 1 GiB for the embedded `database.risu`.
  const bundleInnerRisuMaxExpandedBytes = Number.isFinite(importMaxBytes)
    ? importMaxBytes
    : (options.maxExpandedImportBytes ?? DEFAULT_BUNDLE_INNER_RISU_MAX_EXPANDED_BYTES)
  app.post('/api/v1/import/risusave', { config: { rateLimit: importRateLimit } }, async (req, reply) => {
    const admittedOwnership = getDatabaseOwnershipSnapshot(db)
    if (!(await requireAuth(authState, req, reply))) return
    const requestAbort = attachAbort(req, reply)
    let maintenanceLease: MaintenanceLease | undefined
    try {
      // Reject known conflicts before buffering/decoding, without holding live
      // ownership while multipart input is still only temporary bytes.
      getMaintenanceCoordinator(dataDir).beginExclusive('import', requestAbort.signal).release()
      if (req.isMultipart()) {
        const uploaded = await readUploadedRisuSave(req)
        throwIfImportRequestAborted(requestAbort.signal)
        const snapshot = decodeRisuSaveImportSnapshot(uploaded, {
          maxExpandedBytes: options.maxExpandedImportBytes,
        })
        throwIfImportRequestAborted(requestAbort.signal)
        assertImportOwnership(db, admittedOwnership)
        maintenanceLease = getMaintenanceCoordinator(dataDir).beginExclusive('import', requestAbort.signal)
        const { revision, event, databaseLineage, writerEpoch, assetReport, memoryLegacyReport } =
          await applyImportedDatabase(
            db,
            dataDir,
            snapshot.database,
            snapshot.portableMetadata,
            snapshot.greetingTranslations,
            {
              automaticBackupRetention: options.automaticBackupRetention,
              signal: maintenanceLease.signal,
              maintenanceLease,
            },
          )
        eventSink.emit(event)
        return {
          revision,
          event,
          databaseLineage,
          writerEpoch,
          importReport: {
            incompleteChatCount: snapshot.incompleteChatCount,
            unsupportedReferenceCount: snapshot.unsupportedReferences.length,
            ...(snapshot.skippedBlocks.length > 0 ? { skippedBlocks: snapshot.skippedBlocks } : {}),
          },
          assetReport,
          ...(memoryLegacyReport ? { memoryLegacyReport } : {}),
        }
      }

      const body = (req.body ?? {}) as ImportBody
      const snapshot = normalizeRisuSaveJsonImportSnapshot(body.database)
      // `normalizeRisuSaveJsonImportSnapshot` returns a request-body-isolated
      // throwaway object for JSON bodies, so the repository can split
      // message rows in place without a second full-corpus clone.
      assertImportOwnership(db, admittedOwnership)
      maintenanceLease = getMaintenanceCoordinator(dataDir).beginExclusive('import', requestAbort.signal)
      const { revision, event, databaseLineage, writerEpoch, assetReport, memoryLegacyReport } =
        await applyImportedDatabase(
          db,
          dataDir,
          snapshot.database,
          snapshot.portableMetadata,
          snapshot.greetingTranslations,
          {
            automaticBackupRetention: options.automaticBackupRetention,
            cloneBeforeMessageSplit: false,
            signal: maintenanceLease.signal,
            maintenanceLease,
          },
        )
      eventSink.emit(event)
      return {
        revision,
        event,
        databaseLineage,
        writerEpoch,
        assetReport,
        ...(memoryLegacyReport ? { memoryLegacyReport } : {}),
      }
    } catch (err) {
      if (err instanceof MaintenanceBusyError) {
        reply.code(503)
        return { error: err.code }
      }
      if (isAbortError(err)) {
        reply.code(499)
        return { error: 'import_aborted' }
      }
      if (err instanceof UnsupportedStandaloneChatBlocksError) {
        reply.code(422)
        return unsupportedStandaloneChatBlockImportResponse(err)
      }
      if (err instanceof UnsupportedGroupCharactersError) {
        reply.code(422)
        return unsupportedGroupImportResponse(err)
      }
      if (err instanceof ValidationError) {
        reply.code(400)
        return { error: err.message }
      }
      if (err instanceof AutomaticBackupError) {
        reply.code(500)
        return { error: err.code }
      }
      throw err
    } finally {
      maintenanceLease?.release()
      requestAbort.cleanup()
    }
  })

  app.post('/api/v1/import/bundle', { config: { rateLimit: importRateLimit } }, async (req, reply) => {
    const admittedOwnership = getDatabaseOwnershipSnapshot(db)
    if (!(await requireAuth(authState, req, reply))) return
    if (!req.isMultipart()) {
      reply.code(400)
      return { error: 'backup import requires a multipart .risu.zip or .bin upload' }
    }

    const requestAbort = attachAbort(req, reply)
    let maintenanceLease: MaintenanceLease | undefined
    let uploadPath: string | null = null
    try {
      // Reject known conflicts before buffering/decoding, without holding live
      // ownership while multipart input is still only temporary bytes.
      getMaintenanceCoordinator(dataDir).beginExclusive('import', requestAbort.signal).release()
      // Stream the (potentially very large) upload to a temp file instead of
      // buffering it in memory, then stream-decode it; assets stage into temp
      // files first so malformed embedded DB bytes cannot leak live side effects.
      uploadPath = await streamUploadToTempFile(req, importMaxBytes)
      throwIfImportRequestAborted(requestAbort.signal)

      const decoded = await decodeLocalBackup(uploadPath, {
        maxExpandedBytes: importMaxBytes,
        maxDatabaseBytes: bundleInnerRisuMaxExpandedBytes,
        signal: requestAbort.signal,
      })

      throwIfImportRequestAborted(requestAbort.signal)
      const snapshot = decodeRisuSaveImportSnapshot(decoded.databaseBytes, {
        maxExpandedBytes: bundleInnerRisuMaxExpandedBytes,
      })
      throwIfImportRequestAborted(requestAbort.signal)
      let assetsCreated = false
      const copiedAssetFiles: StagedAssetLiveFileCopy[] = []
      const importedDatabase =
        decoded.format === 'legacy-local-backup'
          ? normalizeLegacyLocalBackupImportDatabase(snapshot.database, decoded.assetReferenceAliases)
          : snapshot.database
      assertImportOwnership(db, admittedOwnership)
      maintenanceLease = getMaintenanceCoordinator(dataDir).beginExclusive('import', requestAbort.signal)
      const { revision, event, databaseLineage, writerEpoch, assetReport, memoryLegacyReport } =
        await applyImportedDatabase(
          db,
          dataDir,
          importedDatabase,
          snapshot.portableMetadata,
          snapshot.greetingTranslations,
          {
            automaticBackupRetention: options.automaticBackupRetention,
            signal: maintenanceLease.signal,
            maintenanceLease,
            beforeRevision: () => {
              const assetResults = persistStagedAssetsInTransaction(db, dataDir, decoded.stagedAssets, copiedAssetFiles)
              assetsCreated = assetResults.some((result) => result.created)
            },
            onImportRollback: () => {
              const cleanup = cleanupCopiedStagedAssetFiles(copiedAssetFiles)
              if (cleanup.failures.length === 0) return
              try {
                req.log.warn(
                  {
                    err: new AggregateError(
                      cleanup.failures.map((failure) => failure.error),
                      BUNDLE_IMPORT_ROLLBACK_CLEANUP_WARNING,
                    ),
                    failureCount: cleanup.failures.length,
                    attempted: cleanup.attempted,
                    failedFiles: cleanup.failures.map((failure) => failure.file),
                  },
                  BUNDLE_IMPORT_ROLLBACK_CLEANUP_WARNING,
                )
              } catch {
                // Logging is best-effort and must never replace the import error.
              }
            },
          },
        )
      eventSink.emit(event)
      return {
        revision,
        event,
        databaseLineage,
        writerEpoch,
        importReport: {
          incompleteChatCount: snapshot.incompleteChatCount,
          unsupportedReferenceCount: snapshot.unsupportedReferences.length,
          ...(snapshot.skippedBlocks.length > 0 ? { skippedBlocks: snapshot.skippedBlocks } : {}),
        },
        assetReport,
        ...(memoryLegacyReport ? { memoryLegacyReport } : {}),
        bundleReport: {
          includedAssetCount: decoded.includedAssetCount,
          assetsCreated,
        },
      }
    } catch (err) {
      if (err instanceof MaintenanceBusyError) {
        reply.code(503)
        return { error: err.code }
      }
      if (isAbortError(err)) {
        reply.code(499)
        return { error: 'import_aborted' }
      }
      if (err instanceof UnsupportedStandaloneChatBlocksError) {
        reply.code(422)
        return unsupportedStandaloneChatBlockImportResponse(err)
      }
      if (err instanceof UnsupportedGroupCharactersError) {
        reply.code(422)
        return unsupportedGroupImportResponse(err)
      }
      if (err instanceof ValidationError) {
        reply.code(400)
        return { error: err.message }
      }
      if (err instanceof AutomaticBackupError) {
        reply.code(500)
        return { error: err.code }
      }
      throw err
    } finally {
      requestAbort.cleanup()
      if (uploadPath) {
        await fs.promises.rm(path.dirname(uploadPath), { recursive: true, force: true }).catch(() => {})
      }
      maintenanceLease?.release()
    }
  })

  app.get<{ Querystring: ExportQuery }>('/api/v1/export/risusave', { exposeHeadRoute: false }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const exportOptions = parseExportQuery(req.query)
      // Measure snapshot hydration separately from encode/output buffering; emitted
      // bytes still come from the same snapshot-to-encode path.
      const measure = protocolMetricsEnabled()
      const snapshotStart = measure ? protocolNowMs() : 0
      const snapshot = buildRepositoryRisuSaveExportSnapshot(db, dataDir)
      const snapshotLoadMs = measure ? protocolDurationMs(snapshotStart) : undefined
      const encodeStart = measure ? protocolNowMs() : 0
      const bytes = encodeRisuSaveExportSnapshot(snapshot, exportOptions)
      const encodeMs = measure ? protocolDurationMs(encodeStart) : undefined
      emitRisuSaveExportMetric(req.log, {
        bundle: false,
        envelope: exportOptions.envelope,
        compression: exportOptions.compression,
        snapshotLoadMs,
        encodeMs,
        outputBytes: bytes.byteLength,
      })
      eventSink.emit({
        ...COMMAND_EVENT_CATALOG.stateExported,
        revision: getSchemaState(db).revision,
      })
      reply.header('content-type', 'application/octet-stream')
      reply.header('content-disposition', `attachment; filename="${EXPORT_FILENAME}"`)
      return reply.send(Buffer.from(bytes))
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.code(400)
        return { error: err.message }
      }
      throw err
    }
  })

  app.get<{ Querystring: ExportQuery }>('/api/v1/export/bundle', { exposeHeadRoute: false }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const exportOptions = parseExportQuery(req.query)
      // Bundle export materializes the embedded `.risu` before streaming asset
      // entries, so record the same materialization metric as ordinary export.
      const measure = protocolMetricsEnabled()
      const snapshotStart = measure ? protocolNowMs() : 0
      const persisted = loadPersistedWithMessages(db, dataDir)
      persisted.assets = getAllAssetMetadata(db)
      const estimatedBackupBytes = estimateDeviceBackupBytes(dataDir, persisted)
      const snapshot = buildRisuSaveExportSnapshotFromPersisted(persisted, loadPortableMetadata(db), db)
      const snapshotLoadMs = measure ? protocolDurationMs(snapshotStart) : undefined
      const encodeStart = measure ? protocolNowMs() : 0
      const risuBytes = encodeRisuSaveExportSnapshot(snapshot, exportOptions)
      const encodeMs = measure ? protocolDurationMs(encodeStart) : undefined
      emitRisuSaveExportMetric(req.log, {
        bundle: true,
        envelope: exportOptions.envelope,
        compression: exportOptions.compression,
        snapshotLoadMs,
        encodeMs,
        outputBytes: risuBytes.byteLength,
      })
      const bundle = await buildRepositoryRisuSaveBundleExport({
        dataDir,
        persisted,
        risuBytes,
        envelope: exportOptions.envelope,
        compression: exportOptions.compression,
      })
      eventSink.emit({
        ...COMMAND_EVENT_CATALOG.stateExported,
        revision: getSchemaState(db).revision,
      })
      reply.header('content-type', 'application/zip')
      reply.header('content-disposition', `attachment; filename="${BUNDLE_EXPORT_FILENAME}"`)
      reply.header(ESTIMATED_BACKUP_BYTES_HEADER, String(estimatedBackupBytes))
      return reply.send(bundle.stream)
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.code(400)
        return { error: err.message }
      }
      throw err
    }
  })

  app.get('/api/v1/export/local-backup', { exposeHeadRoute: false }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      // The original Risu local backup file is a `.bin` record stream whose
      // database record is named `database.risudat` and carries a legacy-
      // compressed `.risu` payload.
      const measure = protocolMetricsEnabled()
      const snapshotStart = measure ? protocolNowMs() : 0
      const persisted = loadPersistedWithMessages(db, dataDir)
      persisted.assets = getAllAssetMetadata(db)
      const estimatedBackupBytes = estimateDeviceBackupBytes(dataDir, persisted)
      const snapshot = buildRisuSaveExportSnapshotFromPersisted(persisted, loadPortableMetadata(db), db)
      snapshot.database = prepareLegacyLocalBackupExportDatabase(snapshot.database, persisted.assets)
      const snapshotLoadMs = measure ? protocolDurationMs(snapshotStart) : undefined
      const encodeStart = measure ? protocolNowMs() : 0
      const risuBytes = encodeRisuSaveLegacyExportSnapshot(snapshot, LOCAL_BACKUP_DATABASE_ENVELOPE)
      const encodeMs = measure ? protocolDurationMs(encodeStart) : undefined
      emitRisuSaveExportMetric(req.log, {
        bundle: true,
        envelope: LOCAL_BACKUP_DATABASE_ENVELOPE,
        compression: false,
        snapshotLoadMs,
        encodeMs,
        outputBytes: risuBytes.byteLength,
      })
      const localBackup = await buildRepositoryRisuLocalBackupExport({
        dataDir,
        persisted,
        databaseBytes: risuBytes,
        envelope: LOCAL_BACKUP_DATABASE_ENVELOPE,
      })
      eventSink.emit({
        ...COMMAND_EVENT_CATALOG.stateExported,
        revision: getSchemaState(db).revision,
      })
      reply.header('content-type', 'application/octet-stream')
      reply.header('content-disposition', `attachment; filename="${LOCAL_BACKUP_EXPORT_FILENAME}"`)
      reply.header(ESTIMATED_BACKUP_BYTES_HEADER, String(estimatedBackupBytes))
      return reply.send(localBackup.stream)
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.code(400)
        return { error: err.message }
      }
      throw err
    }
  })
}

function unsupportedGroupImportResponse(error: UnsupportedGroupCharactersError) {
  return {
    error: error.message,
    code: 'unsupported-group-characters',
    unsupportedGroupCount: error.count,
    unsupportedGroups: error.groups,
  }
}

function unsupportedStandaloneChatBlockImportResponse(error: UnsupportedStandaloneChatBlocksError) {
  return {
    error: error.message,
    code: 'unsupported-standalone-chat-blocks',
  }
}

function estimateDeviceBackupBytes(dataDir: string, persisted: Persisted): number {
  return estimateSqliteFootprintBytes(dataDir) + estimateReferencedAssetBytes(dataDir, persisted)
}

function estimateSqliteFootprintBytes(dataDir: string): number {
  return safeFileSize(path.join(dataDir, SQLITE_EXPORT_ESTIMATE_FILE))
}

function estimateReferencedAssetBytes(dataDir: string, persisted: Persisted): number {
  const report = buildRisuSaveAssetReport(persisted.database, persisted.assets)
  const assetsById = new Map(persisted.assets.map((asset) => [asset.id, asset]))
  let total = 0

  for (const reference of report.referenced) {
    const asset = assetsById.get(reference.id)
    if (!asset) continue
    if (safeFileSize(assetPath(dataDir, asset)) === 0) continue
    total += asset.size
  }

  return total
}

function safeFileSize(filePath: string): number {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

function emitRisuSaveExportMetric(
  logger: FastifyInstance['log'],
  fields: {
    bundle: boolean
    envelope: ExportEnvelope
    compression: boolean
    snapshotLoadMs?: number
    encodeMs?: number
    outputBytes: number
  },
): void {
  emitProtocolMetric(
    'risusave_export',
    {
      bundle: fields.bundle,
      envelope: fields.envelope,
      compression: fields.compression,
      ...(fields.snapshotLoadMs !== undefined ? { snapshotLoadMs: fields.snapshotLoadMs } : {}),
      ...(fields.encodeMs !== undefined ? { encodeMs: fields.encodeMs } : {}),
      outputBytes: fields.outputBytes,
    },
    logger,
  )
}

function encodeRisuSaveExportSnapshot(
  snapshot: RisuSaveExportSnapshot,
  options: ReturnType<typeof parseExportQuery>,
): Uint8Array {
  return options.envelope === 'risusave-blocks'
    ? encodeRisuSaveBlockExportSnapshot(snapshot, { compression: options.compression })
    : encodeRisuSaveLegacyExportSnapshot(snapshot, options.envelope)
}

function parseExportQuery(query: ExportQuery): {
  envelope: ExportEnvelope
  compression: boolean
} {
  const envelope = readExportEnvelope(query.envelope)
  const compression = readOptionalBoolean(query.compression, 'compression') ?? false
  if (envelope !== 'risusave-blocks' && query.compression !== undefined) {
    throw new ValidationError('compression is only supported for risusave-blocks exports')
  }
  return { envelope, compression }
}

function readExportEnvelope(value: unknown): ExportEnvelope {
  if (value === undefined) return 'risusave-blocks'
  if (
    value === 'risusave-blocks' ||
    value === 'legacy-raw' ||
    value === 'legacy-compressed' ||
    value === 'legacy-stream'
  ) {
    return value
  }
  throw new ValidationError('envelope must be risusave-blocks or a legacy .risu envelope')
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new ValidationError(`${label} must be true or false`)
}

async function readUploadedRisuSave(req: FastifyRequest): Promise<Uint8Array> {
  const file = await req.file()
  if (!file) {
    throw new ValidationError('risusave file missing')
  }
  const bytes = await file.toBuffer()
  if (bytes.length === 0) {
    throw new ValidationError('risusave file is empty')
  }
  return bytes
}

/**
 * Stream the uploaded multipart file to a temp file under a per-route size
 * limit (decoupled from the global body limit so large backups are accepted),
 * returning its path. The caller is responsible for removing the temp dir.
 */
async function streamUploadToTempFile(req: FastifyRequest, maxBytes: number): Promise<string> {
  const file = await req.file({ limits: { fileSize: maxBytes } })
  if (!file) {
    throw new ValidationError('backup file missing')
  }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'risu-import-'))
  const target = path.join(dir, 'upload')
  try {
    await pipeline(file.file, fs.createWriteStream(target))
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  if (file.file.truncated) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw new ValidationError('backup upload exceeds size limit')
  }
  if ((await fs.promises.stat(target)).size === 0) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw new ValidationError('backup file is empty')
  }
  return target
}

/** Upload/decode may overlap a takeover or another completed replacement. */
function assertImportOwnership(db: DatabaseSync, admitted: DatabaseOwnershipSnapshot): void {
  const current = getDatabaseOwnershipSnapshot(db)
  if (
    current.databaseLineage !== admitted.databaseLineage ||
    current.writer.sessionId !== admitted.writer.sessionId ||
    current.writer.epoch !== admitted.writer.epoch
  ) {
    throw new MaintenanceBusyError()
  }
}

async function applyImportedDatabase(
  db: DatabaseSync,
  dataDir: string,
  database: unknown,
  portableMetadata: RisuServerPortableMetadata,
  greetingTranslations: readonly GreetingTranslationRow[],
  options: {
    cloneBeforeMessageSplit?: boolean
    automaticBackupRetention?: number
    signal?: AbortSignal
    maintenanceLease?: MaintenanceLease
    beforeRevision?: (db: DatabaseSync) => void
    onImportRollback?: () => void
  } = {},
): Promise<{
  revision: number
  event: Awaited<ReturnType<typeof applyImport>>['event']
  databaseLineage: string
  writerEpoch: number
  assetReport: ReturnType<typeof summarizeRisuSaveAssetReport>
  memoryLegacyReport?: LegacyHypaV3BackfillResult
}> {
  let result: Awaited<ReturnType<typeof applyImport>>
  let memoryLegacyReport: LegacyHypaV3BackfillResult | undefined
  try {
    result = await applyImport(db, dataDir, database, {
      greetingTranslations,
      automaticBackupRetention: options.automaticBackupRetention,
      signal: options.signal,
      maintenanceLease: options.maintenanceLease,
      cloneBeforeMessageSplit: options.cloneBeforeMessageSplit,
      beforeRevision: () => {
        const backfill = replaceLegacyHypaV3MemoryRowsInTransaction(
          db,
          database,
          portableMetadata.memoryLegacySummaryTombstones,
        )
        if (backfill.skippedSummaries.length > 0) memoryLegacyReport = backfill
        options.beforeRevision?.(db)
      },
    })
  } catch (err) {
    options.onImportRollback?.()
    throw err
  }
  return {
    ...result,
    assetReport: summarizeRisuSaveAssetReport(buildRepositoryRisuSaveAssetReport(dataDir, db)),
    ...(memoryLegacyReport ? { memoryLegacyReport } : {}),
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function throwIfImportRequestAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('Import request aborted')
  error.name = 'AbortError'
  throw error
}

function loadPortableMetadata(db: DatabaseSync): RisuServerPortableMetadata {
  return {
    version: 1,
    memoryLegacySummaryTombstones: listLegacySummaryTombstones(db),
  }
}
