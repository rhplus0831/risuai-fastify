import { describe, expect, it } from 'vitest'
import {
  isDiagnosticEventV2,
  projectDiagnosticEventV2,
  projectDiagnosticJournalRecord,
  diagnosticSizeBucket,
  type DiagnosticEventV2,
} from './diagnosticEvents.js'
import {
  downgradeDiagnosticJournalRecord,
  isRemoteDiagnosticsResponse,
  parseRemoteDiagnosticsQuery,
  promoteRemoteDiagnosticRecord,
} from './remoteDiagnostics.js'

const base = { timestamp: 1, source: 'server', level: 'info', correlation: 'background' }
const examples = [
  {
    category: 'deployment',
    stage: 'started',
    flags: { diagnostics: true, rawMetrics: false, rawTrace: false, fullPrompt: false, browserUpload: false },
    journal: 'ready',
  },
  {
    category: 'http',
    routeId: 'unknown',
    method: 'GET',
    statusCode: 500,
    durationMs: 20,
    requestBytes: 'unknown',
    responseBytes: 'small',
    outcome: 'server-error',
  },
  { category: 'runtime', kind: 'runtime-error', errorName: 'TypeError' },
  { category: 'generation', stage: 'dispatch', outcome: 'ambiguous', providerMayHaveRun: true },
  {
    category: 'prompt',
    outcome: 'ok',
    durationMs: 1,
    rows: 2,
    truncation: 'applied',
    inputTokens: 50,
    budgetTokens: 100,
  },
  {
    category: 'provider',
    adapter: 'openai',
    transport: 'stream',
    stage: 'terminal',
    outcome: 'timeout',
    durationMs: 5,
    providerMayHaveRun: true,
    timeToFirstTokenMs: 1,
    maxStreamGapMs: 4,
  },
  {
    category: 'persistence',
    phase: 'authoritative_commit',
    disposition: 'retryable',
    durationMs: 3,
    journalConfirmed: true,
    authoritativeCommitted: false,
  },
  {
    category: 'script',
    hook: 'onOutput',
    runtime: 'lua',
    runs: 1,
    failures: 0,
    durationMs: 3,
    allowedCalls: 2,
    blockedCalls: 1,
    outputChanged: false,
    transcriptChanged: true,
  },
  { category: 'browser', stage: 'hydration', outcome: 'failed', attemptCount: 2 },
  { category: 'legacy', detail: { timestamp: 1, source: 'server', level: 'warn', event: 'startup' } },
]

describe('exact v2 diagnostic families', () => {
  it.each(examples)('projects only approved facts for $category and rejects content-bearing restoration', (example) => {
    const entry = { ...base, ...example }
    expect(isDiagnosticEventV2(entry)).toBe(true)
    const dirty = { ...entry, body: 'CANARY', hash: 'CANARY', error: { message: 'CANARY' }, customName: 'CANARY' }
    expect(isDiagnosticEventV2(dirty)).toBe(false)
    const safe = projectDiagnosticEventV2(dirty)
    expect(safe).toEqual(entry)
    const record = {
      sequence: 1,
      receivedAt: 2,
      instanceId: 'a'.repeat(32),
      provenance: { kind: 'server' },
      entry: safe,
    }
    expect(projectDiagnosticJournalRecord(record)).toEqual(record)
    expect(projectDiagnosticJournalRecord({ ...record, body: 'CANARY' })).toBeNull()
    expect(projectDiagnosticJournalRecord({ ...record, entry: dirty })).toBeNull()
    expect(JSON.stringify(projectDiagnosticJournalRecord(record))).not.toContain('CANARY')
  })
  it('rejects unknown enums, unbounded measurements, unsafe coordinates and forged browser identities', () => {
    for (const entry of [
      { ...base, ...examples[5], adapter: 'PRIVATE-MODEL' },
      { ...base, ...examples[4], durationMs: Infinity },
      { ...base, ...examples[4], durationMs: 86_400_001 },
      { ...base, ...examples[4], rows: 1_000_000_001 },
      { ...base, ...examples[3], correlation: 'operation' },
      { ...base, ...examples[2], locations: ['src/PRIVATE.ts:1:2'] },
    ])
      expect(isDiagnosticEventV2(entry)).toBe(false)
    const entry = {
      ...base,
      ...examples[3],
      source: 'browser',
      correlation: 'client-asserted',
      operationRef: 'a'.repeat(32),
    }
    expect(
      projectDiagnosticJournalRecord({
        sequence: 1,
        receivedAt: 2,
        instanceId: 'a'.repeat(32),
        provenance: { kind: 'browser', sourceId: 'b'.repeat(32), eventId: 'c'.repeat(32), clientSequence: 1 },
        entry,
      }),
    ).toBeNull()
  })
  it('negotiates v2 categories explicitly while preserving exact v1 responses', () => {
    expect(parseRemoteDiagnosticsQuery({ version: '2', category: 'provider' })).toMatchObject({
      version: 2,
      category: 'provider',
    })
    expect(parseRemoteDiagnosticsQuery({ category: 'provider' })).toBeNull()
    expect(parseRemoteDiagnosticsQuery({ version: '2', category: 'runtime-error' })).toBeNull()
    const first = {
      sequence: 1,
      receivedAt: 2,
      instanceId: 'a'.repeat(32),
      entry: { timestamp: 1, source: 'server', level: 'info', event: 'http', statusCode: 500, durationMs: 2 },
    } as const
    const promoted = promoteRemoteDiagnosticRecord(first)!
    expect(promoted.entry.category).toBe('http')
    expect(downgradeDiagnosticJournalRecord(promoted)?.entry).toMatchObject(first.entry)
    const envelope = {
      version: 1,
      serverTime: 2,
      identity: { build: 'unknown', instanceId: 'a'.repeat(32) },
      entries: [first],
      sources: { server: 'journal', browser: 'not-supported' },
      capture: { from: 2, to: 2 },
      loss: { dropped: 0, rejected: 0, pruned: 0, truncated: false },
      pagination: { nextCursor: null, snapshotSequence: 1, lastSequence: 1 },
    }
    expect(isRemoteDiagnosticsResponse(envelope)).toBe(true)
    expect(isRemoteDiagnosticsResponse({ ...envelope, entries: [promoted] })).toBe(false)
    expect(
      isRemoteDiagnosticsResponse({
        ...envelope,
        version: 2,
        entries: [promoted],
        clock: { ordering: 'server-sequence', browserTime: 'client-asserted', skew: 'unknown' },
        collection: { pending: 0, operationContinuity: 'retained' },
      }),
    ).toBe(true)
  })
  it('has coarse byte buckets with no textual fallback', () => {
    expect([0, 10, 5000, 100_000, 2_000_000, 'PRIVATE', -1].map(diagnosticSizeBucket)).toEqual([
      'none',
      'small',
      'medium',
      'large',
      'huge',
      'unknown',
      'unknown',
    ])
  })
})
