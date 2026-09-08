import { describe, expect, it, vi } from 'vitest'
import type { DiagnosticJournalRecord, RemoteDiagnosticsResponseV2 } from '@risuai/protocol/remote-diagnostics'
import {
  buildDiagnosticsReport,
  diagnosticEntryText,
  fetchClientDiagnostics,
  mergeDiagnosticsEntries,
  type LocalBrowserDiagnosticRecord,
} from './clientDiagnostics'

vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: async () => 'PRIVATE-AUTH-CANARY' }))

const local: LocalBrowserDiagnosticRecord = {
  sourceId: 'ab'.repeat(16),
  eventId: 'cd'.repeat(16),
  clientSequence: 1,
  entry: {
    timestamp: 100,
    source: 'browser',
    level: 'warn',
    category: 'browser',
    correlation: 'client-asserted',
    stage: 'hydration',
    outcome: 'failed',
  },
}
const uploaded: DiagnosticJournalRecord = {
  sequence: 2,
  instanceId: 'ef'.repeat(16),
  receivedAt: 200,
  provenance: {
    kind: 'browser',
    sourceId: local.sourceId,
    eventId: local.eventId,
    clientSequence: local.clientSequence,
  },
  entry: local.entry,
}
const envelope: RemoteDiagnosticsResponseV2 = {
  version: 2,
  serverTime: 200,
  identity: { instanceId: 'ef'.repeat(16), build: 'unknown' },
  entries: [uploaded],
  sources: { server: 'journal', browser: 'available' },
  capture: { from: 200, to: 200 },
  loss: { dropped: 2, rejected: 0, pruned: 0, truncated: false },
  pagination: { nextCursor: '12'.repeat(16), snapshotSequence: 2, lastSequence: 2 },
  clock: { ordering: 'server-sequence', browserTime: 'client-asserted', skew: 'unknown' },
  collection: { pending: 0, operationContinuity: 'retained' },
}

describe('combined manual diagnostic reports', () => {
  it('deduplicates by event identity and preserves identical but distinct events', () => {
    const distinct = { ...local, eventId: '45'.repeat(16), clientSequence: 2 }
    expect(mergeDiagnosticsEntries([local, distinct], [uploaded])).toEqual([uploaded, distinct])
    const report = buildDiagnosticsReport([local, distinct], [uploaded], 'current', envelope)
    expect(report).toContain('RisuAI diagnostic report v2')
    expect(report.match(/"stage":"hydration"/g)).toHaveLength(2)
    expect(report).toContain('"dropped":2')
    expect(report).toContain('"morePages":true')
    expect(report).toContain('client assertions')
  })
  it('keeps local enriched evidence exportable offline and rejects forged server records', () => {
    const forged = {
      ...uploaded,
      entry: { ...uploaded.entry, prompt: 'PRIVATE-CANARY' },
    } as unknown as DiagnosticJournalRecord
    const report = buildDiagnosticsReport([local], [forged], 'unavailable')
    expect(report).toContain('Server diagnostics: unavailable')
    expect(report.match(/"stage":"hydration"/g)).toHaveLength(1)
    expect(report).not.toContain('PRIVATE')
    expect(diagnosticEntryText(forged)).toBe('')
    expect(diagnosticEntryText({ ...local, sourceId: 'PRIVATE-CANARY' })).toBe('')
  })
  it('accepts an older exact manual response after a v2 request and validates newer responses', async () => {
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: 1, enabled: true, entries: [] })))
    try {
      expect((await fetchClientDiagnostics(undefined, true)).version).toBe(1)
      expect(transport).toHaveBeenCalledWith(
        '/api/v1/diagnostics?version=2&limit=200',
        expect.objectContaining({ headers: { 'risu-auth': 'PRIVATE-AUTH-CANARY' } }),
      )
      transport.mockResolvedValue(new Response(JSON.stringify(envelope)))
      expect((await fetchClientDiagnostics(undefined, true)).version).toBe(2)
      transport.mockResolvedValue(
        new Response(JSON.stringify({ ...envelope, entries: [{ ...uploaded, private: 'PRIVATE-CANARY' }] })),
      )
      await expect(fetchClientDiagnostics(undefined, true)).rejects.toThrow('invalid-diagnostics')
    } finally {
      transport.mockRestore()
    }
  })
})
