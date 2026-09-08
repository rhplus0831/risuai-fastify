import {
  DIAGNOSTICS_ENDPOINT,
  DIAGNOSTICS_LIMIT,
  isDiagnosticsResponse,
  projectDiagnosticEntry,
  type DiagnosticEntry,
  type DiagnosticsResponse,
} from '@risuai/protocol/diagnostics'
import {
  isBrowserDiagnosticsBatch,
  isRemoteDiagnosticsResponse,
  projectDiagnosticEventV2,
  projectDiagnosticJournalRecord,
  type DiagnosticEventV2,
  type DiagnosticJournalRecord,
  type RemoteDiagnosticsResponseV2,
} from '@risuai/protocol/remote-diagnostics'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import versionData from '../../../version.json'

export interface LocalBrowserDiagnosticRecord {
  sourceId: string
  eventId: string
  clientSequence: number
  entry: DiagnosticEventV2
}
export type DiagnosticReportEntry = DiagnosticEntry | DiagnosticJournalRecord | LocalBrowserDiagnosticRecord
export type ClientDiagnosticsResult = DiagnosticsResponse | RemoteDiagnosticsResponseV2

export async function fetchClientDiagnostics(signal?: AbortSignal, enriched = false): Promise<ClientDiagnosticsResult> {
  const auth = await getNodeServerProxyAuth()
  const response = await fetch(`${DIAGNOSTICS_ENDPOINT}${enriched ? '?version=2&limit=200' : ''}`, {
    signal,
    cache: 'no-store',
    headers: { 'risu-auth': auth },
  })
  if (!response.ok) throw new Error('diagnostics-unavailable')
  const result: unknown = await response.json()
  if (!isDiagnosticsResponse(result) && !(isRemoteDiagnosticsResponse(result) && result.version === 2))
    throw new Error('invalid-diagnostics')
  return result
}

function safeReportEntry(input: DiagnosticReportEntry): DiagnosticReportEntry | null {
  if ('sequence' in input) return projectDiagnosticJournalRecord(input)
  if (!('entry' in input)) return projectDiagnosticEntry(input)
  const entry = projectDiagnosticEventV2(input.entry)
  if (
    !entry ||
    !isBrowserDiagnosticsBatch({
      version: 1,
      sourceId: input.sourceId,
      events: [{ eventId: input.eventId, clientSequence: input.clientSequence, entry }],
    })
  )
    return null
  return { sourceId: input.sourceId, eventId: input.eventId, clientSequence: input.clientSequence, entry }
}

export function diagnosticEntryFacts(record: DiagnosticReportEntry): DiagnosticEntry | DiagnosticEventV2 {
  return 'entry' in record ? record.entry : record
}

/** Identity deduplication preserves distinct events with identical timestamps/facts. */
export function mergeDiagnosticsEntries(
  browser: DiagnosticReportEntry[],
  server: DiagnosticReportEntry[],
): DiagnosticReportEntry[] {
  const records = new Map<string, DiagnosticReportEntry>()
  let anonymous = 0
  for (const input of [...browser.slice(-DIAGNOSTICS_LIMIT), ...server.slice(-DIAGNOSTICS_LIMIT)]) {
    const record = safeReportEntry(input)
    if (!record) continue
    const key =
      'provenance' in record
        ? record.provenance.kind === 'browser'
          ? `browser:${record.provenance.sourceId}:${record.provenance.eventId}`
          : `server:${record.instanceId}:${record.sequence}`
        : 'entry' in record
          ? `browser:${record.sourceId}:${record.eventId}`
          : `legacy:${anonymous++}`
    records.set(key, record)
  }
  return [...records.values()].sort(
    (left, right) => diagnosticEntryFacts(left).timestamp - diagnosticEntryFacts(right).timestamp,
  )
}

export function diagnosticEntryText(entry: DiagnosticReportEntry): string {
  if ('entry' in entry) {
    const record = safeReportEntry(entry)
    if (!record || !('entry' in record)) return ''
    const { timestamp, source, level, category, ...fields } = record.entry
    const provenance =
      'provenance' in record
        ? record.provenance
        : {
            kind: 'browser',
            sourceId: record.sourceId,
            eventId: record.eventId,
            clientSequence: record.clientSequence,
          }
    return `${new Date(timestamp).toISOString()} ${source} ${level} ${category} ${JSON.stringify({
      ...fields,
      provenance,
      ...('sequence' in record
        ? { sequence: record.sequence, receivedAt: record.receivedAt, instanceId: record.instanceId }
        : {}),
    })}`
  }
  const safe = projectDiagnosticEntry(entry)
  if (!safe) return ''
  const { timestamp, source, level, event, ...fields } = safe
  return `${new Date(timestamp).toISOString()} ${source} ${level} ${event} ${JSON.stringify(fields)}`
}

export function buildDiagnosticsReport(
  browser: DiagnosticReportEntry[],
  server: DiagnosticReportEntry[],
  serverStatus: 'current' | 'unavailable',
  remote?: RemoteDiagnosticsResponseV2,
): string {
  // The report deliberately does not read settings, transcripts, fetch logs, or raw UA/URL values.
  const agent = navigator.userAgent
  const browserFamily = /Firefox\//.test(agent)
    ? 'Firefox'
    : /Edg\//.test(agent)
      ? 'Edge'
      : /(?:Chrome|CriOS)\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Other'
  const os = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Macintosh/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : 'Other'
  const version = /^\d[\w.+-]{0,40}$/.test(versionData.version) ? versionData.version : 'unknown'
  const safeEntries = mergeDiagnosticsEntries(browser, server)
  const enriched = safeEntries.some((entry) => 'entry' in entry) || remote !== undefined
  const safeRemote = isRemoteDiagnosticsResponse(remote) && remote.version === 2 ? remote : undefined
  return [
    `RisuAI diagnostic report v${enriched ? 2 : 1}`,
    `Version: ${version}`,
    `Browser: ${browserFamily}`,
    `OS: ${os}`,
    `Online: ${navigator.onLine}`,
    `Viewport: ${window.innerWidth} x ${window.innerHeight}`,
    `Server diagnostics: ${serverStatus}`,
    ...(enriched
      ? [
          'Ordering: server sequence within retained history; browser times and request associations are client assertions. Cross-source timestamps do not establish causal order.',
          'Browser delivery loss: unknown; client sequence gaps can indicate omitted events.',
        ]
      : []),
    ...(safeRemote
      ? [
          `Sources: ${JSON.stringify(safeRemote.sources)}`,
          `Collection: ${JSON.stringify(safeRemote.collection)}`,
          `Journal loss: ${JSON.stringify({ ...safeRemote.loss, morePages: safeRemote.pagination.nextCursor !== null })}`,
        ]
      : []),
    `Exported: ${new Date().toISOString()}`,
    'Content policy: no message/prompt text, request/response bodies, headers, credentials, raw URLs, or free-form log messages.',
    '',
    ...safeEntries.map(diagnosticEntryText),
    '',
  ].join('\n')
}
