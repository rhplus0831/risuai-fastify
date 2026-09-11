import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCompress from '@fastify/compress'
import fastifyMultipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { allowApplicationFileRead, allowDiagnosticStaticFile } from './diagnosticsStaticFiles.js'
import { onDiagnosticBadUrl } from './diagnosticsRequestRouting.js'
import { createActiveWriterState, registerActiveWriterGuard } from './activeWriter.js'
import { registerBardWikiReadRoutes } from './routes/bardWiki.js'
import { registerBardWikiJobRoutes } from './routes/bardWikiJobs.js'
import {
  assertAgentDevAuthBypassHost,
  assertSupportDiagnosticsConfig,
  DEFAULT_AUTOMATIC_BACKUP_RETENTION,
  DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES,
  type AppConfig,
  loadConfig,
} from './config.js'
import { createAuthState } from './auth.js'
import { createCommandEventSink, type CommandEventSink } from './commands/events.js'
import { openDatabase } from './db.js'
import { closeMaintenance, openMaintenance } from './maintenanceCoordinator.js'
import { ASSET_BULK_BINARY_CONTENT_TYPE, registerAssetsRoutes } from './routes/assets.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerBackupRoutes } from './routes/backups.js'
import { registerStorageUsageRoutes } from './routes/storageUsage.js'
import { registerBootstrapRoutes } from './routes/bootstrap.js'
import { registerOwnershipRoutes } from './routes/ownership.js'
import { registerCommandRoutes } from './routes/commands.js'
import { registerResourceReadRoutes } from './routes/resourceReads.js'
import { registerEventsRoutes } from './routes/events.js'
import { registerEmbeddingOperationRoutes, type EmbeddingOperationRouteOptions } from './routes/embeddingOperations.js'
import { registerGenerationRoutes } from './routes/generation.js'
import {
  registerGenerationChatRoutes,
  retryPendingGenerationCompletionEffects,
  retryQueuedGenerationFinalizations,
  type GenerationChatRouteOptions,
} from './routes/generationChat.js'
import { registerGenerationOperationRoutes } from './routes/generationOperations.js'
import { registerGenerationEffectRoutes } from './routes/generationEffects.js'
import { registerLoreTokenCountRoutes } from './routes/loreTokenCounts.js'
import { registerDisplaySourceRoutes } from './routes/displaySources.js'
import { DisplaySourceService } from './displaySourceService.js'
import { bootPromptVariables } from './prompt/promptVariablesBoot.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerHubRoutes } from './routes/hub.js'
import { registerLegacyStorageRoutes } from './routes/legacyStorage.js'
import { registerMemoryJobRoutes } from './routes/memoryJobs.js'
import { registerMemoryReadRoutes } from './routes/memoryReads.js'
import { registerMcpOAuthRefreshRoutes, type McpOAuthRefreshRouteOptions } from './routes/mcpOAuthRefresh.js'
import {
  registerOpenAITranscriptionRoutes,
  type OpenAITranscriptionRouteOptions,
} from './routes/openAITranscription.js'
import { registerProviderOperationRoutes, type ProviderOperationRouteOptions } from './routes/providerOperations.js'
import { registerImageGenerationRoutes, type ImageGenerationRouteOptions } from './routes/imageGeneration.js'
import { registerProxyRoutes } from './routes/proxy.js'
import { registerPushNotificationRoutes } from './routes/pushNotifications.js'
import { registerRequestHistoryRoutes } from './routes/requestHistory.js'
import { registerRealmImportRoutes } from './routes/realmImport.js'
import { registerLocalFileImportRoutes } from './routes/localFileImport.js'
import { registerSaveRoutes } from './routes/save.js'
import { registerStreamJobRoutes } from './routes/streamJobs.js'
import { registerStartupTelemetryRoutes } from './routes/startupTelemetry.js'
import { registerTtsRoutes, type TtsSynthesisRouteOptions } from './routes/tts.js'
import {
  SUPPORTED_ASSET_CONTENT_TYPES,
  ensureDbJsonImported,
  loadPersistedWithMessages,
  migrateLegacyAgentConfigurationInSqlite,
  recoverInterruptedRestoreSwaps,
  repairPersistedModelProfileInlineSecretsInSqlite,
} from './repository.js'
import { ASSET_GC_INTERVAL_MS, type AssetGcOptions, runAssetGc } from './assetGc.js'
import { JobRegistry, PROXY_STREAM_GC_INTERVAL_MS } from './streamJobs.js'
import { GenerationJobRegistry } from './generationJobs.js'
import { MessageTranslationJobRegistry } from './messageTranslationJobs.js'
import { GreetingTranslationJobRegistry } from './greetingTranslationJobs.js'
import {
  buildBardWikiJobEvent,
  buildMemoryJobEvent,
  createMemoryEventBus,
  type MemoryEventSink,
} from './memoryEvents.js'
import { backfillLegacyHypaV3MemoryRows } from './memoryLegacyImport.js'
import { MemoryWorker, type MemoryWorkerOptions } from './memoryWorker.js'
import { BardWikiWorker, type BardWikiWorkerOptions } from './bardWikiWorker.js'
import { createBardWikiApplyTurnHandler } from './bardWikiApplyTurnHandler.js'
import { createBardWikiReconcileReceiptHandler } from './bardWikiReconcileHandler.js'
import { createBardWikiRebuildHandler } from './bardWikiRebuildHandler.js'
import { createEmbedMemoryJobBatchHandler, createEmbedMemoryJobHandler } from './memoryEmbedJobHandler.js'
import { createSummarizeMemoryJobBatchHandler, createSummarizeMemoryJobHandler } from './memorySummarizeJobHandler.js'
import { registerRequestTrace } from './requestTrace.js'
import {
  createClientDiagnostics,
  registerClientDiagnosticsHooks,
  registerClientDiagnosticsRoutes,
} from './clientDiagnostics.js'
import { createPushNotificationService } from './pushNotifications.js'
import {
  getGenerationOperationProjection,
  reconcileGenerationOperationsAtStartup,
  transitionGenerationOperation,
} from './generationOperations.js'
import { reconcileGenerationEffectsAtStartup } from './generationEffects.js'
import {
  isDiagnosticTransportUrl,
  SUPPORT_DIAGNOSTICS_ENDPOINT,
  BROWSER_DIAGNOSTICS_ENDPOINT,
} from '@risuai/protocol/remote-diagnostics'
import { registerBrowserDiagnosticsRoutes } from './routes/browserDiagnostics.js'
import { registerRemoteDiagnosticsRoutes } from './remoteDiagnostics.js'
import { createDiagnosticsRuntime } from './diagnosticsRuntime.js'

/**
 * Node `server.requestTimeout` backstop the wall-clock bound for
 * receiving one request. Mirrors the durable generation path's 600s
 * `deadlineAt` reference instead of Node's implicit 300s default.
 */
export const REQUEST_RECEIVE_TIMEOUT_MS = 600_000
export const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const STATIC_REVALIDATE_CACHE_CONTROL = 'public, max-age=0'
/**
 * /token/** vocab files are multi-MB and unhashed, so they can't be
 * immutable; 30 days keeps them out of the request path while capping
 * staleness if a vocab file is ever replaced in place.
 */
export const STATIC_TOKENIZER_CACHE_CONTROL = 'public, max-age=2592000'

export interface BuildAppOptions {
  config?: AppConfig
  generationChat?: GenerationChatRouteOptions
  realmImport?: {
    deadlineMs?: number
    maxExpandedImportBytes?: number
    maxDynamicJsonBytes?: number
    maxFetchedAssetBytes?: number
    maxFetchedAssetTotalBytes?: number
  }
  memoryWorker?: false | Omit<MemoryWorkerOptions, 'db'>
  bardWikiWorker?: false | Omit<BardWikiWorkerOptions, 'db'>
  memoryEvents?: MemoryEventSink
  commandEvents?: CommandEventSink
  mcpOAuthRefresh?: McpOAuthRefreshRouteOptions
  openAITranscription?: OpenAITranscriptionRouteOptions
  providerOperations?: ProviderOperationRouteOptions
  embeddingOperations?: EmbeddingOperationRouteOptions
  ttsSynthesis?: TtsSynthesisRouteOptions
  imageGeneration?: ImageGenerationRouteOptions
  /**
   * Periodic server-side asset GC. `false` disables the timer (tests that do
   * not exercise GC). An options object tunes the grace window / interval.
   */
  assetGc?: false | (AssetGcOptions & { intervalMs?: number })
}

export interface BuiltApp {
  app: FastifyInstance
  config: AppConfig
  generationJobs: GenerationJobRegistry
  diagnostics: ReturnType<typeof createDiagnosticsRuntime>
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = opts.config ?? loadConfig()
  assertAgentDevAuthBypassHost(config)
  assertSupportDiagnosticsConfig(config)
  const diagnostics = createClientDiagnostics(config.clientDiagnostics ?? Boolean(config.requestTrace))
  const diagnosticInstanceId = randomBytes(16).toString('hex')
  const diagnosticIdentity = {
    instanceId: diagnosticInstanceId,
    build: /^[a-f0-9]{40,64}$/.test(process.env.RISU_BUILD_ID ?? '') ? process.env.RISU_BUILD_ID! : 'unknown',
  }
  const app = Fastify({
    routerOptions: { onBadUrl: onDiagnosticBadUrl },
    disableRequestLogging: (request) => isDiagnosticTransportUrl(request.url),
    logger:
      process.env.LOG_LEVEL === 'silent'
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            hooks: {
              logMethod(args, method, level) {
                diagnostics.recordLog(args, level)
                return method.apply(this, args)
              },
            },
          },
    bodyLimit: config.bodyLimit,
    trustProxy: config.trustProxy,
    // Generous explicit backstop for receiving a request, aligned
    // with the durable path's 600s deadline. Bounds only the request-receive
    // phase (Node clears it once the body has arrived), so long SSE responses
    // and slow generations are unaffected; multi-GB backup uploads on a LAN
    // still fit comfortably.
    requestTimeout: REQUEST_RECEIVE_TIMEOUT_MS,
  })

  // This guard precedes body parsers and trace/collector hooks, including invalid
  // methods and subpaths. Diagnostic errors never echo raw URL or input.
  app.addHook('onRequest', async (request, reply) => {
    if (!isDiagnosticTransportUrl(request.url)) return
    reply.header('cache-control', 'no-store')
    const pathname = request.url.split('?')[0]
    if (request.method === 'POST' && pathname === BROWSER_DIAGNOSTICS_ENDPOINT) return
    if (request.method !== 'GET' || !['/api/v1/diagnostics', SUPPORT_DIAGNOSTICS_ENDPOINT].includes(pathname)) {
      return reply.code(404).send({ error: 'invalid-query' })
    }
    if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) {
      return reply.code(400).send({ error: 'invalid-query' })
    }
  })

  registerClientDiagnosticsHooks(app, diagnostics)
  if (config.requestTrace) {
    registerRequestTrace(app, { dataDir: config.dataDir, ...config.requestTrace })
  }

  await app.register(fastifyCompress, {
    global: true,
    globalDecompression: false,
    threshold: 1024,
  })

  await app.register(rateLimit, {
    global: false,
    max: 2000,
    timeWindow: '1 minute',
  })

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.bodyLimit,
      files: 1,
    },
  })

  app.addContentTypeParser(SUPPORTED_ASSET_CONTENT_TYPES, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })
  app.addContentTypeParser(ASSET_BULK_BINARY_CONTENT_TYPE, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  await app.register(fastifyWebsocket, {
    options: {
      perMessageDeflate: true,
    },
  })

  openMaintenance(config.dataDir)
  const db = openDatabase(config.dataDir, { allowMissingDatabase: config.allowMissingDatabase })
  const serverInstanceId = randomUUID()
  // Directory swaps are journaled around the SQLite restore transaction. Finish
  // an interrupted swap before any backfill, import, route, or worker can
  // observe a database/filesystem mixture.
  recoverInterruptedRestoreSwaps(db, config.dataDir, app.log)
  const activeWriterState = createActiveWriterState(db)
  // Legacy memory backfill reads chat.message[]; hydrate from the table (or the
  // still-embedded legacy db.json before boot import retires it) so it sees the
  // real history.
  const legacyMemoryBackfill = backfillLegacyHypaV3MemoryRows(
    db,
    loadPersistedWithMessages(db, config.dataDir).database,
  )
  if (legacyMemoryBackfill.skippedSummaries.length > 0) {
    app.log.warn(
      {
        skippedSummaryCount: legacyMemoryBackfill.skippedSummaries.length,
        skippedSummaries: legacyMemoryBackfill.skippedSummaries,
      },
      'Skipped malformed legacy Hypa V3 summaries during startup backfill',
    )
  }
  // Proactively import any legacy db.json into SQLite and retire the file.
  // No-op once converged. Must run after the backfill above, which needs the
  // embedded messages before boot import retires a legacy db.json.
  ensureDbJsonImported(db, config.dataDir, app.log)
  // Databases created before reusable Agents had only Agent Presets. Upgrade
  // that legacy owner before strict command validation observes it.
  migrateLegacyAgentConfigurationInSqlite(db)
  // Pre-credential-store preset copies must be repaired before routes or
  // workers can load them into a response, command baseline, or export.
  repairPersistedModelProfileInlineSecretsInSqlite(db)
  const diagnosticsRuntime = createDiagnosticsRuntime(app, db, config, diagnostics, diagnosticIdentity)
  reconcileGenerationOperationsAtStartup(db, serverInstanceId, app.log)
  reconcileGenerationEffectsAtStartup(db)
  const memoryEventBus = createMemoryEventBus(app.log)
  if (opts.memoryEvents) memoryEventBus.subscribe(opts.memoryEvents)
  const emitMemoryEvent: MemoryEventSink = (event) => memoryEventBus.emit(event)
  const commandEventSink = opts.commandEvents ?? createCommandEventSink()
  const defaultSummarizeOptions = { db, dataDir: config.dataDir }
  const defaultEmbedOptions = { db, dataDir: config.dataDir }
  const defaultMemoryHandlers = {
    embed: createEmbedMemoryJobHandler(defaultEmbedOptions),
    summarize: createSummarizeMemoryJobHandler(defaultSummarizeOptions),
  }
  const memoryWorkerOptions = opts.memoryWorker === false ? null : (opts.memoryWorker ?? {})
  const defaultMemoryBatchHandlers = {
    ...(memoryWorkerOptions?.handlers?.embed === undefined
      ? { embed: createEmbedMemoryJobBatchHandler(defaultEmbedOptions) }
      : {}),
    ...(memoryWorkerOptions?.handlers?.summarize === undefined
      ? { summarize: createSummarizeMemoryJobBatchHandler(defaultSummarizeOptions) }
      : {}),
  }
  const memoryWorker =
    memoryWorkerOptions === null
      ? null
      : new MemoryWorker({
          db,
          onEvent: emitMemoryEvent,
          ...memoryWorkerOptions,
          handlers: {
            ...defaultMemoryHandlers,
            ...memoryWorkerOptions.handlers,
          },
          batchHandlers: {
            ...defaultMemoryBatchHandlers,
            ...memoryWorkerOptions.batchHandlers,
          },
        })
  memoryWorker?.start()
  const bardWikiWorkerOptions = opts.bardWikiWorker === false ? null : (opts.bardWikiWorker ?? {})
  const bardWikiWorker =
    bardWikiWorkerOptions === null
      ? null
      : new BardWikiWorker({
          db,
          onEvent: emitMemoryEvent,
          ...bardWikiWorkerOptions,
          handlers: {
            apply_turn: createBardWikiApplyTurnHandler({
              db,
              dataDir: config.dataDir,
              eventSink: commandEventSink,
            }),
            reconcile_receipt: createBardWikiReconcileReceiptHandler({ db, eventSink: commandEventSink }),
            rebuild_chat: createBardWikiRebuildHandler({
              db,
              dataDir: config.dataDir,
              eventSink: commandEventSink,
            }),
            ...bardWikiWorkerOptions.handlers,
          },
        })
  bardWikiWorker?.start()
  const onBardWikiJobEnqueued = (job: Parameters<typeof buildBardWikiJobEvent>[0]): void => {
    emitMemoryEvent(buildBardWikiJobEvent(job))
    bardWikiWorker?.wake()
    try {
      opts.generationChat?.onBardWikiJobEnqueued?.(job)
    } catch (error) {
      app.log.warn({ err: error, bardWikiJobId: job.id }, 'BardWiki job observer failed')
    }
  }
  const authState = createAuthState(config.dataDir, {
    agentDevAuthBypass: config.agentDevAuthBypass === true,
  })
  const pushNotifications = createPushNotificationService(db, config.dataDir)
  const displaySourceService = new DisplaySourceService({
    db,
    dataDir: config.dataDir,
  })
  const streamJobRegistry = new JobRegistry()
  // Separately GC-ticked registry for detached chat generations and their
  // transient chatId→jobId submission lock.
  const generationJobRegistry = new GenerationJobRegistry(config.dataDir)
  const messageTranslationJobRegistry = new MessageTranslationJobRegistry()
  const greetingTranslationJobRegistry = new GreetingTranslationJobRegistry()
  const gcTimer = setInterval(() => {
    streamJobRegistry.tickGc()
    generationJobRegistry.tickGc()
  }, PROXY_STREAM_GC_INTERVAL_MS)
  gcTimer.unref()

  // Periodic, reference-counted reclamation of orphaned content-addressed
  // assets. Runs off the request hot path; a grace window protects bytes that
  // were just uploaded and are about to be referenced.
  const assetGcOptions = opts.assetGc === false ? null : (opts.assetGc ?? {})
  const assetGcTimer =
    assetGcOptions === null
      ? null
      : setInterval(() => {
          void runAssetGc(config.dataDir, { ...assetGcOptions, db }).catch((err) => {
            app.log.error({ err }, 'asset GC sweep failed')
          })
        }, assetGcOptions.intervalMs ?? ASSET_GC_INTERVAL_MS)
  assetGcTimer?.unref()
  let generationFinalizationRetryTimer: ReturnType<typeof setInterval> | null = null

  // preClose precedes Fastify's HTTP drain: active backup requests must receive
  // shutdown cancellation while they still own their copy leases.
  app.addHook('preClose', () => {
    // Start cancellation immediately; HTTP connection drain and maintenance
    // cleanup proceed together. onClose awaits the same drain before SQLite.
    void closeMaintenance(config.dataDir)
  })

  app.addHook('onClose', async () => {
    // Abort cooperative copies/staging, reject admission, and drain every
    // started filesystem operation before any continuation can use closed DB.
    await closeMaintenance(config.dataDir)
    await bardWikiWorker?.stop()
    await memoryWorker?.stop()
    clearInterval(gcTimer)
    if (assetGcTimer) clearInterval(assetGcTimer)
    if (generationFinalizationRetryTimer) clearInterval(generationFinalizationRetryTimer)
    for (const job of streamJobRegistry.list()) {
      streamJobRegistry.deleteJob(job.id)
    }
    for (const job of generationJobRegistry.registry.list()) {
      if (job.databaseLineage && job.operationId) {
        const operation = getGenerationOperationProjection(db, job.databaseLineage, job.operationId)
        if (operation?.state === 'owned_by_job' || operation?.state === 'launching') {
          transitionGenerationOperation(db, {
            databaseLineage: job.databaseLineage,
            operationId: job.operationId,
            expectedState: operation.state,
            expectedStateVersion: operation.stateVersion,
            nextState: 'abandoned',
            failureCode: 'server_shutdown',
            failurePhase: 'shutdown',
            providerMayHaveRun: operation.providerMayHaveRun,
            runnerSettledAt: new Date().toISOString(),
          })
        }
      }
      generationJobRegistry.registry.deleteJob(job.id, 'server_shutdown')
    }
    // Detached runners were just system-aborted. Owned work was marked
    // abandoned above; an already-stopping user cancellation keeps its durable
    // state until the runner commits its partial (or a replayable journal)
    // before the database closes.
    await generationJobRegistry.settleRunners()
    generationJobRegistry.registry.dispose()
    await diagnosticsRuntime.close()
    db.close()
  })

  registerHealthRoutes(app, db)
  registerAuthRoutes(app, authState)
  registerBootstrapRoutes(
    app,
    db,
    authState,
    config.dataDir,
    activeWriterState,
    generationJobRegistry,
    messageTranslationJobRegistry,
    greetingTranslationJobRegistry,
    diagnostics.enabled,
    diagnosticsRuntime.browserEnabled,
  )
  registerOwnershipRoutes(app, db, authState)
  registerActiveWriterGuard(app, activeWriterState)
  registerClientDiagnosticsRoutes(app, authState, diagnostics, diagnosticsRuntime.source, diagnosticIdentity)
  registerRemoteDiagnosticsRoutes(
    app,
    diagnosticsRuntime.source,
    config.supportDiagnostics ?? { enabled: false },
    diagnosticIdentity,
  )
  registerBrowserDiagnosticsRoutes(app, authState, {
    enabled: diagnosticsRuntime.browserEnabled,
    ingest: diagnosticsRuntime.ingestBrowser,
  })
  registerStartupTelemetryRoutes(app, authState)
  registerResourceReadRoutes(app, db, authState, config.dataDir)
  registerBardWikiReadRoutes(app, db, authState)
  registerBardWikiJobRoutes(app, db, authState, {
    onEvent: emitMemoryEvent,
    abortRunningJob: (jobId) => bardWikiWorker?.abortRunningJob(jobId) ?? false,
    wakeWorker: () => bardWikiWorker?.wake(),
  })
  registerSaveRoutes(app, db, authState, config.dataDir, commandEventSink, {
    maxExpandedImportBytes: config.bodyLimit,
    importMaxBytes: config.importMaxBytes,
    automaticBackupRetention: config.automaticBackupRetention ?? DEFAULT_AUTOMATIC_BACKUP_RETENTION,
  })
  registerRealmImportRoutes(app, db, authState, config.dataDir, commandEventSink, {
    hubUrl: config.hubUrl,
    realmUrl: config.realmUrl,
    maxExpandedImportBytes: config.realmImportMaxExpandedBytes ?? DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES,
    ...opts.realmImport,
  })
  registerLocalFileImportRoutes(app, db, authState, config.dataDir, commandEventSink, activeWriterState, {
    maxUploadBytes: config.importMaxBytes,
    maxExpandedBytes: config.realmImportMaxExpandedBytes ?? DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES,
  })
  registerCommandRoutes(
    app,
    db,
    authState,
    config.dataDir,
    commandEventSink,
    messageTranslationJobRegistry,
    greetingTranslationJobRegistry,
    { wakeWorker: () => bardWikiWorker?.wake() },
  )
  registerDisplaySourceRoutes(app, authState, displaySourceService)
  registerLoreTokenCountRoutes(app, db, config.dataDir, authState)
  registerEventsRoutes(app, db, authState, commandEventSink, memoryEventBus, activeWriterState)
  const canReadApplicationFile = (file: string) => allowApplicationFileRead(config, file)
  registerAssetsRoutes(app, db, authState, config.dataDir, activeWriterState, canReadApplicationFile)
  registerStorageUsageRoutes(app, authState, config.dataDir)
  registerBackupRoutes(app, db, authState, config.dataDir, commandEventSink, {
    automaticBackupRetention: config.automaticBackupRetention ?? DEFAULT_AUTOMATIC_BACKUP_RETENTION,
    serverInstanceId,
  })
  registerRequestHistoryRoutes(app, db, authState)
  registerPushNotificationRoutes(app, authState, pushNotifications)
  registerMcpOAuthRefreshRoutes(app, db, authState, config.dataDir, commandEventSink, opts.mcpOAuthRefresh)
  registerOpenAITranscriptionRoutes(app, db, authState, opts.openAITranscription)
  registerEmbeddingOperationRoutes(app, db, authState, opts.embeddingOperations)
  registerProviderOperationRoutes(app, db, authState, opts.providerOperations)
  registerTtsRoutes(app, db, authState, opts.ttsSynthesis)
  registerImageGenerationRoutes(app, db, authState, {
    keiHubUrl: config.hubUrl,
    ...opts.imageGeneration,
  })
  registerProxyRoutes(app, authState)
  registerStreamJobRoutes(app, authState, streamJobRegistry)
  registerHubRoutes(app, db, authState, config.hubUrl)
  registerLegacyStorageRoutes(app, authState, config.dataDir, canReadApplicationFile)
  registerGenerationRoutes(app, db, authState, config.dataDir)
  registerGenerationChatRoutes(
    app,
    db,
    authState,
    config.dataDir,
    commandEventSink,
    generationJobRegistry,
    messageTranslationJobRegistry,
    serverInstanceId,
    {
      ...opts.generationChat,
      pushNotifications: opts.generationChat?.pushNotifications ?? pushNotifications,
      onPromptMemoryJobEnqueued: (job) => {
        emitMemoryEvent(buildMemoryJobEvent(job))
        try {
          opts.generationChat?.onPromptMemoryJobEnqueued?.(job)
        } catch (error) {
          app.log.warn({ err: error, memoryJobId: job.id }, 'prompt memory job observer failed')
        }
      },
      onBardWikiJobEnqueued,
    },
    config.generationTrace,
  )
  registerGenerationOperationRoutes(app, db, authState, config.dataDir, commandEventSink, {
    serverInstanceId,
    generationJobs: generationJobRegistry,
    messageTranslationJobs: messageTranslationJobRegistry,
    generationChatOptions: {
      ...opts.generationChat,
      pushNotifications: opts.generationChat?.pushNotifications ?? pushNotifications,
      onPromptMemoryJobEnqueued: (job) => {
        emitMemoryEvent(buildMemoryJobEvent(job))
        try {
          opts.generationChat?.onPromptMemoryJobEnqueued?.(job)
        } catch (error) {
          app.log.warn({ err: error, memoryJobId: job.id }, 'prompt memory job observer failed')
        }
      },
      onBardWikiJobEnqueued,
    },
    generationTrace: config.generationTrace,
  })
  registerGenerationEffectRoutes(app, db, authState)
  const finalizationRetryRaw = opts.generationChat?.finalizationRetry
  const finalizationRetryOptions = finalizationRetryRaw === false ? false : (finalizationRetryRaw ?? {})
  const runGenerationCompletionEffectRetrySweep = (): void => {
    void retryPendingGenerationCompletionEffects({
      db,
      dataDir: config.dataDir,
      eventSink: commandEventSink,
      messageTranslationJobs: messageTranslationJobRegistry,
      runMessageTranslation: opts.generationChat?.runMessageTranslation,
    }).catch((err) => app.log.error({ err }, 'generation completion effect retry sweep failed'))
  }
  const runGenerationFinalizationRetrySweep = (): void => {
    try {
      retryQueuedGenerationFinalizations({
        db,
        dataDir: config.dataDir,
        eventSink: commandEventSink,
        logger: app.log,
        maxPerSweep: finalizationRetryOptions !== false ? finalizationRetryOptions.maxPerSweep : undefined,
        baseDelayMs: finalizationRetryOptions !== false ? finalizationRetryOptions.baseDelayMs : undefined,
        maxDelayMs: finalizationRetryOptions !== false ? finalizationRetryOptions.maxDelayMs : undefined,
        pushNotifications,
        messageTranslationJobs: messageTranslationJobRegistry,
        runMessageTranslation: opts.generationChat?.runMessageTranslation,
        onBardWikiJobEnqueued,
      })
    } catch (err) {
      app.log.error({ err }, 'generation finalization retry sweep failed')
    }
    runGenerationCompletionEffectRetrySweep()
  }
  if (finalizationRetryOptions !== false) {
    runGenerationFinalizationRetrySweep()
  } else {
    // Server-owned translation receipts survive independently of the
    // finalization queue and must reconcile even when that retry loop is off.
    runGenerationCompletionEffectRetrySweep()
  }
  generationFinalizationRetryTimer =
    finalizationRetryOptions === false
      ? null
      : setInterval(runGenerationFinalizationRetrySweep, finalizationRetryOptions.intervalMs ?? 5000)
  generationFinalizationRetryTimer?.unref()
  registerMemoryJobRoutes(app, db, authState, {
    onEvent: emitMemoryEvent,
    snapshotVersion: () => memoryEventBus.snapshotVersion(),
    abortRunningJob: (jobId) => memoryWorker?.abortRunningJob(jobId) ?? false,
    wakeWorker: () => memoryWorker?.wake(),
  })
  registerMemoryReadRoutes(app, db, authState)
  bootPromptVariables()

  if (config.staticRoot && fs.existsSync(config.staticRoot)) {
    const staticAssetsRoot = path.join(config.staticRoot, 'assets')
    const staticTokenizerRoot = path.join(config.staticRoot, 'token')

    await app.register(fastifyStatic, {
      root: config.staticRoot,
      prefix: '/',
      wildcard: false,
      index: false,
      cacheControl: false,
      allowedPath: (pathname, root) => allowDiagnosticStaticFile(config, pathname, root),
      setHeaders: (res, filePath) => {
        res.setHeader(
          'Cache-Control',
          isPathWithin(staticAssetsRoot, filePath)
            ? STATIC_ASSET_CACHE_CONTROL
            : isPathWithin(staticTokenizerRoot, filePath)
              ? STATIC_TOKENIZER_CACHE_CONTROL
              : STATIC_REVALIDATE_CACHE_CONTROL,
        )
      },
    })

    app.get('/', async (_req, reply) => {
      return reply.sendFile('index.html')
    })

    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'not found' })
        return
      }
      return reply.sendFile('index.html')
    })
  }

  return { app, config, generationJobs: generationJobRegistry, diagnostics: diagnosticsRuntime }
}
