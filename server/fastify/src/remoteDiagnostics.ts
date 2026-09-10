import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  SUPPORT_DIAGNOSTICS_ENDPOINT,
  REMOTE_DIAGNOSTICS_MAX_BYTES,
  isRemoteDiagnosticsResponse,
  parseRemoteDiagnosticsQuery,
  projectRemoteDiagnosticRecord,
  projectDiagnosticJournalRecord,
  projectRemoteDiagnosticRecordV3,
  promoteRemoteDiagnosticRecord,
  downgradeDiagnosticJournalRecord,
  type RemoteDiagnosticsResponseV1,
  type RemoteDiagnosticsResponseV2,
  type RemoteDiagnosticsResponseV3,
  type RemoteDiagnosticRecord,
  type RemoteDiagnosticRecordV3,
  type RemoteDiagnosticsError,
  type RemoteDiagnosticsQuery,
  type RemoteDiagnosticsResponse,
} from '@risuai/protocol/remote-diagnostics'
import type { ClientDiagnostics } from './clientDiagnostics.js'
import { verifySupportDiagnosticsAuthorization } from './supportDiagnosticsAuth.js'
import { supportDiagnosticsRateLimit } from './routeRateLimits.js'

const SNAPSHOT_TTL_MS = 300_000
const SNAPSHOT_MAX_ENTRIES = 2_000
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
const SNAPSHOT_MAX_COUNT = 32
const reference = () => randomBytes(16).toString('hex')
const projectV2Record = (value: unknown) => {
  const record = projectRemoteDiagnosticRecordV3(value)
  return record
    ? projectDiagnosticJournalRecord({
        sequence: record.sequence,
        receivedAt: record.receivedAt,
        instanceId: record.instanceId,
        provenance: record.provenance,
        entry: record.entry,
      })
    : null
}

export interface RemoteDiagnosticsSource {
  enabled: boolean
  read(): {
    entries: Array<RemoteDiagnosticRecord | RemoteDiagnosticRecordV3>
    epoch: string
    source: 'volatile' | 'journal' | 'unavailable'
    dropped: number
    rejected: number
    pruned: number
    pending?: number
    browserSupported?: boolean
    operationContinuity?: 'retained' | 'process-only'
  }
}

export function createVolatileRemoteDiagnostics(
  diagnostics: ClientDiagnostics,
  instanceId: string,
): RemoteDiagnosticsSource {
  let sequence = 0
  let dropped = 0
  const entries: RemoteDiagnosticRecord[] = []
  const epoch = reference()
  diagnostics.subscribe((entry) => {
    const record = projectRemoteDiagnosticRecord({ sequence: ++sequence, receivedAt: Date.now(), instanceId, entry })
    if (!record) return
    entries.push(record)
    if (entries.length > 300) {
      entries.shift()
      dropped++
    }
  })
  return {
    enabled: diagnostics.enabled,
    read: () => ({
      entries: entries.map((entry) => projectRemoteDiagnosticRecord(entry)!),
      epoch,
      source: 'volatile',
      dropped,
      rejected: 0,
      pruned: 0,
    }),
  }
}

interface Snapshot {
  expiresAt: number
  epoch: string
  pages: Array<Array<RemoteDiagnosticRecord | RemoteDiagnosticRecordV3>>
  cursors: string[]
  metadata:
    | Omit<RemoteDiagnosticsResponseV1, 'entries' | 'pagination' | 'serverTime'>
    | Omit<RemoteDiagnosticsResponseV2, 'entries' | 'pagination' | 'serverTime'>
    | Omit<RemoteDiagnosticsResponseV3, 'entries' | 'pagination' | 'serverTime'>
  snapshotSequence: number
}

/** Cursor tokens address immutable pages; retrying a token returns the same page. */
export function createRemoteDiagnosticsReader(
  source: RemoteDiagnosticsSource,
  identity: RemoteDiagnosticsResponse['identity'],
  now = Date.now,
) {
  const snapshots: Snapshot[] = []
  const projectV3Record = (value: unknown) => {
    const record = projectRemoteDiagnosticRecordV3(value)
    if (!record?.facts?.some((fact) => fact.type === 'location')) return record
    const facts = record.facts.filter(
      (fact) => fact.type !== 'location' || (identity.build !== 'unknown' && record.instanceId === identity.instanceId),
    )
    const { facts: _facts, ...base } = record
    return projectRemoteDiagnosticRecordV3({
      ...base,
      ...(facts.length ? { facts } : {}),
    })
  }
  const prune = (epoch: string) => {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].expiresAt <= now() || snapshots[i].epoch !== epoch) snapshots.splice(i, 1)
    }
  }
  const page = (snapshot: Snapshot, index: number): RemoteDiagnosticsResponse => {
    const common = {
      serverTime: now(),
      pagination: {
        nextCursor: snapshot.cursors[index + 1] ?? null,
        snapshotSequence: snapshot.snapshotSequence,
        lastSequence: snapshot.pages[index].at(-1)?.sequence ?? 0,
      },
    }
    return snapshot.metadata.version === 3
      ? {
          ...snapshot.metadata,
          ...common,
          entries: snapshot.pages[index].map((entry) => projectV3Record(entry)!),
        }
      : snapshot.metadata.version === 2
        ? {
            ...snapshot.metadata,
            ...common,
            entries: snapshot.pages[index].map((entry) => projectV2Record(entry)!),
          }
        : {
            ...snapshot.metadata,
            ...common,
            entries: snapshot.pages[index].map((entry) => projectRemoteDiagnosticRecord(entry)!),
          }
  }
  return {
    clear: () => {
      snapshots.length = 0
    },
    read(query: RemoteDiagnosticsQuery): RemoteDiagnosticsResponse | RemoteDiagnosticsError {
      if (!source.enabled) return 'collection-disabled'
      const current = source.read()
      prune(current.epoch)
      if (current.source === 'unavailable') return 'storage-unavailable'
      if (query.cursor) {
        for (const snapshot of snapshots) {
          const index = snapshot.cursors.indexOf(query.cursor)
          if (index >= 0 && snapshot.metadata.version === query.version) return page(snapshot, index)
        }
        return 'cursor-expired'
      }
      let bytes = 0
      let truncated = false
      const records: Array<RemoteDiagnosticRecord | RemoteDiagnosticRecordV3> = []
      let rejected = current.rejected
      for (const value of current.entries) {
        const persisted = 'provenance' in value
        const validated = persisted ? projectRemoteDiagnosticRecordV3(value) : projectRemoteDiagnosticRecord(value)
        if (!validated) {
          rejected++
          continue
        }
        const record =
          query.version === 3
            ? persisted
              ? projectV3Record(validated)
              : projectV3Record(promoteRemoteDiagnosticRecord(validated as RemoteDiagnosticRecord))
            : query.version === 2
              ? persisted
                ? projectV2Record(validated)
                : promoteRemoteDiagnosticRecord(validated as RemoteDiagnosticRecord)
              : persisted
                ? downgradeDiagnosticJournalRecord(validated as RemoteDiagnosticRecordV3)
                : (validated as RemoteDiagnosticRecord)
        if (!record) continue
        if (record.receivedAt < query.from || record.receivedAt > query.to) continue
        if (query.requestUid && record.entry.requestUid !== query.requestUid) continue
        if (
          query.operationRef &&
          (!('operationRef' in record.entry) || record.entry.operationRef !== query.operationRef)
        )
          continue
        const category = 'category' in record.entry ? record.entry.category : record.entry.event
        if (query.category && category !== query.category) continue
        const size = Buffer.byteLength(JSON.stringify(record))
        if (records.length === SNAPSHOT_MAX_ENTRIES || bytes + size > SNAPSHOT_MAX_BYTES) {
          truncated = true
          break
        }
        bytes += size
        records.push(record)
      }
      const pages: Array<Array<RemoteDiagnosticRecord | RemoteDiagnosticRecordV3>> = [[]]
      let pageBytes = 0
      for (const record of records) {
        const size = Buffer.byteLength(JSON.stringify(record)) + 1
        if (pages.at(-1)!.length >= query.limit || pageBytes + size > REMOTE_DIAGNOSTICS_MAX_BYTES - 4096) {
          pages.push([])
          pageBytes = 0
        }
        pages.at(-1)!.push(record)
        pageBytes += size
      }
      const snapshot: Snapshot = {
        epoch: current.epoch,
        expiresAt: now() + SNAPSHOT_TTL_MS,
        pages,
        cursors: pages.map(() => reference()),
        snapshotSequence: current.entries.at(-1)?.sequence ?? 0,
        metadata: {
          version: query.version,
          identity,
          sources: {
            server: current.source,
            browser:
              query.version >= 2 && current.browserSupported
                ? records.some((record) => record.entry.source === 'browser')
                  ? 'available'
                  : 'none'
                : 'not-supported',
          },
          capture: {
            from: records.length ? Math.min(...records.map((record) => record.receivedAt)) : null,
            to: records.length ? Math.max(...records.map((record) => record.receivedAt)) : null,
          },
          loss: { dropped: current.dropped, rejected, pruned: current.pruned, truncated },
          ...(query.version >= 2
            ? {
                clock: {
                  ordering: 'server-sequence' as const,
                  browserTime: 'client-asserted' as const,
                  skew: 'unknown' as const,
                },
                collection: {
                  pending: current.pending ?? 0,
                  operationContinuity: current.operationContinuity ?? 'process-only',
                },
              }
            : {}),
        } as Snapshot['metadata'],
      }
      if (pages.length > 1) {
        if (snapshots.length >= SNAPSHOT_MAX_COUNT) snapshots.shift()
        snapshots.push(snapshot)
      }
      return page(snapshot, 0)
    },
  }
}

export const SUPPORT_DIAGNOSTIC_STATUS: Record<RemoteDiagnosticsError, number> = {
  disabled: 503,
  unauthorized: 401,
  'invalid-query': 400,
  'rate-limited': 429,
  'collection-disabled': 409,
  'cursor-expired': 410,
  'storage-unavailable': 503,
  'internal-error': 500,
}

export interface SupportDiagnosticsOptions {
  enabled: boolean
  verifierFile?: string
}

export function registerRemoteDiagnosticsRoutes(
  app: FastifyInstance,
  source: RemoteDiagnosticsSource,
  options: SupportDiagnosticsOptions,
  identity: RemoteDiagnosticsResponse['identity'],
) {
  const reader = createRemoteDiagnosticsReader(source, identity)
  const audit: { timestamp: number; outcome: RemoteDiagnosticsError | 'ok' }[] = []
  const auditOutcome = (outcome: RemoteDiagnosticsError | 'ok') => {
    audit.push({ timestamp: Date.now(), outcome })
    if (audit.length > 300) audit.shift()
  }
  app.addHook('onClose', async () => {
    reader.clear()
    audit.length = 0
  })
  app.get(
    SUPPORT_DIAGNOSTICS_ENDPOINT,
    {
      exposeHeadRoute: false,
      bodyLimit: 1024,
      config: { rateLimit: supportDiagnosticsRateLimit },
      onRequest: async (request, reply) => {
        reply.header('cache-control', 'no-store')
        const timer = setTimeout(() => {
          reply.raw.destroy()
        }, 10_000)
        timer.unref()
        reply.raw.once('close', () => clearTimeout(timer))
        reply.raw.once('finish', () => clearTimeout(timer))
        let outcome: RemoteDiagnosticsError | undefined
        if (!options.enabled || !options.verifierFile) outcome = 'disabled'
        else if (!(await verifySupportDiagnosticsAuthorization(request.headers.authorization, options.verifierFile)))
          outcome = 'unauthorized'
        if (outcome) {
          auditOutcome(outcome)
          return reply.code(SUPPORT_DIAGNOSTIC_STATUS[outcome]).send({ error: outcome })
        }
      },
      errorHandler: (error, _request, reply) => {
        const outcome =
          error.statusCode === 429
            ? 'rate-limited'
            : error.statusCode && error.statusCode < 500
              ? 'invalid-query'
              : 'internal-error'
        auditOutcome(outcome)
        reply.header('cache-control', 'no-store').code(SUPPORT_DIAGNOSTIC_STATUS[outcome]).send({ error: outcome })
      },
    },
    async (request, reply) => {
      const query =
        request.url.length <= SUPPORT_DIAGNOSTICS_ENDPOINT.length + 2048
          ? parseRemoteDiagnosticsQuery(request.query)
          : null
      const result = query ? reader.read(query) : 'invalid-query'
      if (typeof result === 'string') {
        auditOutcome(result)
        return reply.code(SUPPORT_DIAGNOSTIC_STATUS[result]).send({ error: result })
      }
      if (
        !isRemoteDiagnosticsResponse(result) ||
        Buffer.byteLength(JSON.stringify(result)) > REMOTE_DIAGNOSTICS_MAX_BYTES
      ) {
        auditOutcome('internal-error')
        return reply.code(500).send({ error: 'internal-error' })
      }
      auditOutcome('ok')
      return result
    },
  )
  return { audit: () => audit.map((entry) => ({ ...entry })) }
}
