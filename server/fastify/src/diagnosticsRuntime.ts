import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import {
  promoteRemoteDiagnosticRecord,
  projectDiagnosticEventV2,
  isBrowserDiagnosticsBatch,
  type BrowserDiagnosticsBatch,
  type BrowserDiagnosticsUploadResponse,
  type DiagnosticEventV2,
} from '@risuai/protocol/remote-diagnostics'
import type { AppConfig } from './config.js'
import type { ClientDiagnostics } from './clientDiagnostics.js'
import { createDiagnosticsJournal } from './diagnosticsJournal.js'
import { getDatabaseLineage } from './databaseLineage.js'
import { createVolatileRemoteDiagnostics, type RemoteDiagnosticsSource } from './remoteDiagnostics.js'
import {
  diagnosticsContextEnabled,
  getDiagnosticContext,
  loadDiagnosticReferenceKey,
  recordDiagnosticEventForDatabase,
  registerDiagnosticContextHooks,
  registerDiagnosticDatabase,
  type DiagnosticContext,
} from './diagnosticContext.js'
import { protocolMetricsEnabled } from './protocolMetrics.js'

/** Owns only telemetry; no initialization promise is awaited by application startup. */
export function createDiagnosticsRuntime(
  app: FastifyInstance,
  db: DatabaseSync,
  config: AppConfig,
  collector: ClientDiagnostics,
  instanceId: string,
) {
  const browserEnabled = collector.enabled && config.browserDiagnostics?.enabled === true
  const enabled = collector.enabled && (config.supportDiagnostics?.enabled === true || browserEnabled)
  if (!enabled) {
    const source = createVolatileRemoteDiagnostics(collector, instanceId)
    return {
      source,
      ready: Promise.resolve(),
      close: async () => {},
      journal: undefined,
      browserEnabled: false,
      ingestBrowser: (_batch: BrowserDiagnosticsBatch): BrowserDiagnosticsUploadResponse | null => null,
    }
  }
  const directory = path.join(config.dataDir, 'diagnostics')
  let lineage = getDatabaseLineage(db)
  const journal = createDiagnosticsJournal({ directory, lineage, instanceId, enabled: true })
  let closed = false
  let keyReady = false
  let operationContinuity: 'retained' | 'process-only' = 'process-only'
  const referenceKey = randomBytes(32)
  const startup: { entry: DiagnosticEventV2; context?: DiagnosticContext }[] = []
  let startupDropped = 0
  const record = (entry: DiagnosticEventV2, context?: DiagnosticContext) => {
    if (!keyReady) {
      if (startup.length < 256) startup.push({ entry, context })
      else startupDropped = Math.min(Number.MAX_SAFE_INTEGER, startupDropped + 1)
    } else journal.record(entry)
  }
  const flushStartup = () => {
    while (startup.length) {
      const pending = startup.shift()!
      if (pending.context && pending.context.epoch !== lineage) continue
      const entry = projectDiagnosticEventV2({
        ...pending.entry,
        ...(pending.context
          ? { operationRef: pending.context.operationRef, attemptRef: pending.context.attemptRef }
          : {}),
      })
      if (entry) journal.record(entry)
    }
  }
  const history = () => {
    const current = getDatabaseLineage(db)
    if (current !== lineage) {
      lineage = current
      collector.clear()
      startup.length = 0
      startupDropped = 0
      journal.reset(current)
      recordDiagnosticEventForDatabase(db, {
        category: 'deployment',
        stage: 'history-reset',
        flags: flags(),
        journal: 'starting',
      })
    }
    return current
  }
  const flags = () => ({
    diagnostics: true,
    rawMetrics: protocolMetricsEnabled(),
    rawTrace: Boolean(config.requestTrace),
    fullPrompt: config.generationTrace?.fullPrompt === true,
    browserUpload: browserEnabled,
  })
  // Register before synchronous startup recovery. Only the bounded telemetry
  // queue waits for the key; commands/generation/recovery keep running.
  const unregister = registerDiagnosticDatabase(db, { owner: collector, key: referenceKey, history, record })
  recordDiagnosticEventForDatabase(db, {
    category: 'deployment',
    stage: 'started',
    flags: flags(),
    journal: 'starting',
  })
  let keyDeadline: ReturnType<typeof setTimeout> | undefined
  let resolveDeadline = () => {}
  const keyLoading = Promise.race([
    loadDiagnosticReferenceKey(directory),
    new Promise<undefined>((resolve) => {
      resolveDeadline = () => resolve(undefined)
      keyDeadline = setTimeout(resolveDeadline, 1000)
      keyDeadline.unref()
    }),
  ])
    .then((key) => {
      if (keyDeadline) clearTimeout(keyDeadline)
      if (closed) return
      operationContinuity = key ? 'retained' : 'process-only'
      if (key) referenceKey.set(key)
      keyReady = true
      flushStartup()
    })
    .catch(() => {
      keyReady = true
      flushStartup()
    })
  const ready = Promise.all([keyLoading, journal.ready]).then(() => {
    if (!closed)
      recordDiagnosticEventForDatabase(db, {
        category: 'deployment',
        stage: 'collection-health',
        flags: flags(),
        journal: journal.read().source === 'journal' ? 'ready' : 'unavailable',
      })
  })
  registerDiagnosticContextHooks(app, db)
  app.addHook('onRequest', async () => {
    try {
      history()
    } catch {
      /* Keep authority/readiness independent. */
    }
  })
  const stopLegacy = collector.subscribe((entry, http) => {
    if (closed || entry.event === 'server-started') return
    try {
      history()
      const converted = promoteRemoteDiagnosticRecord({ sequence: 1, receivedAt: Date.now(), instanceId, entry })
      if (!converted) return
      const context = getDiagnosticContext()
      const scoped = context?.owner === collector && diagnosticsContextEnabled()
      if (context && !scoped) return
      const projected = projectDiagnosticEventV2({
        ...converted.entry,
        ...(converted.entry.category === 'http'
          ? { requestBytes: http?.requestBytes ?? 'unknown', responseBytes: http?.responseBytes ?? 'unknown' }
          : {}),
        ...(scoped
          ? {
              correlation: context.operationRef ? 'operation' : context.requestUid ? 'request' : 'background',
              operationRef: context.operationRef,
              attemptRef: context.attemptRef,
              requestUid: context.requestUid,
            }
          : {}),
      })
      if (projected) record(projected, scoped ? context : undefined)
    } catch {
      /* Sanitized telemetry never controls the observed request. */
    }
  })
  const source: RemoteDiagnosticsSource = {
    enabled: collector.enabled,
    read() {
      history()
      const snapshot = journal.read()
      return {
        ...snapshot,
        source: keyReady ? snapshot.source : 'unavailable',
        operationContinuity,
        browserSupported: browserEnabled,
        dropped: Math.min(Number.MAX_SAFE_INTEGER, snapshot.dropped + startupDropped),
        pending: Math.min(256, (snapshot.pending ?? 0) + startup.length),
      }
    },
  }
  return {
    source,
    ready,
    journal,
    browserEnabled,
    ingestBrowser(batch: BrowserDiagnosticsBatch): BrowserDiagnosticsUploadResponse | null {
      if (!browserEnabled || closed || !isBrowserDiagnosticsBatch(batch)) return null
      try {
        history()
        if (journal.read().source !== 'journal') return null
        const result: BrowserDiagnosticsUploadResponse = { version: 1, accepted: 0, duplicates: 0, dropped: 0 }
        for (const event of batch.events) {
          if (journal.hasBrowserEvent(batch.sourceId, event.eventId)) result.duplicates++
          else if (
            journal.record(event.entry, {
              kind: 'browser',
              sourceId: batch.sourceId,
              eventId: event.eventId,
              clientSequence: event.clientSequence,
            })
          )
            result.accepted++
          else result.dropped++
        }
        return result
      } catch {
        return null
      }
    },
    async close() {
      if (closed) return
      recordDiagnosticEventForDatabase(db, {
        category: 'deployment',
        stage: 'stopped',
        flags: flags(),
        journal: journal.read().source === 'journal' ? 'ready' : 'unavailable',
      })
      keyReady = true
      flushStartup()
      closed = true
      resolveDeadline()
      if (keyDeadline) clearTimeout(keyDeadline)
      stopLegacy()
      unregister()
      await journal.close()
    },
  }
}
