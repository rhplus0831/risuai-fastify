import { describe, expect, it } from 'vitest'
import {
  isDiagnosticEventV2,
  isBrowserDiagnosticEvent,
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
import { diagnosticErrorFields } from './diagnostics.js'

const base = { timestamp: 1, source: 'server', level: 'info', correlation: 'background' }
const displayPerformance = {
  category: 'display-performance',
  outcome: 'ok',
  durationMs: 185,
  queueWaitMs: 5,
  queueDepth: 1,
  targetCount: 2,
  visitedTargetCount: 2,
  executedTargetCount: 1,
  cacheHitCount: 1,
  cacheMissCount: 1,
  inflightJoinCount: 0,
  streamingBypassCount: 0,
  transcriptMessageCount: 100,
  timeToFirstTransformMs: 175,
  resultCounts: { ok: 2, clientFallback: 0, stale: 0, error: 0 },
  timings: { scopeLoadMs: 120, scopeDecodeMs: 10, sharedDependencyMs: 40, luaMs: 2, regexMs: 3 },
  preparation: {
    loadPath: 'selected',
    loads: {
      settings: { readMs: 2, parseMs: 3, jsonValues: 1, jsonSize: 'up-to-64KiB' },
      target: { readMs: 1, parseMs: 2, jsonValues: 2, jsonSize: 'up-to-1MiB' },
      messages: { readMs: 2, parseMs: 1, jsonValues: 100, jsonSize: 'up-to-4MiB' },
      memory: { readMs: 1 },
      promptPresets: { readMs: 1, parseMs: 1, jsonValues: 1, jsonSize: 'up-to-4KiB' },
      personas: { readMs: 1, parseMs: 1, jsonValues: 1, jsonSize: 'up-to-4KiB' },
      modules: { readMs: 10, parseMs: 20, jsonValues: 3, jsonSize: 'up-to-16MiB' },
    },
    configurationMs: 35,
    dependencyBuildMs: 1,
    dependencyNormalizeMs: 25,
    dependencySerializeMs: 10,
    dependencyHashMs: 3,
    dependencyJsonSize: 'up-to-16MiB',
    measurementMs: 1,
    activeModuleCount: 3,
    moduleAssetCount: 100,
    moduleRegexCount: 10,
    moduleTriggerCount: 5,
    characterAssetCount: 10,
    characterRegexCount: 2,
    characterTriggerCount: 1,
  },
}
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
  {
    category: 'display',
    stage: 'scope-decode',
    outcome: 'handled-fallback',
    failureKind: 'generation-input-validation',
    validationDomain: 'database',
    validationOwner: 'message',
    validationFieldRef: 'a'.repeat(16),
    validationRule: 'type',
    valueKind: 'number',
  },
  { category: 'legacy', detail: { timestamp: 1, source: 'server', level: 'warn', event: 'startup' } },
  displayPerformance,
]

describe('exact v2 diagnostic families', () => {
  it('exports bounded performance summaries only in v2 and rejects browser or content-bearing records', () => {
    const entry = { ...base, ...displayPerformance }
    expect(parseRemoteDiagnosticsQuery({ version: '2', category: 'display-performance' })).toMatchObject({
      category: 'display-performance',
    })
    expect(parseRemoteDiagnosticsQuery({ category: 'display-performance' })).toBeNull()
    const record = projectDiagnosticJournalRecord({
      sequence: 1,
      receivedAt: 2,
      instanceId: 'a'.repeat(32),
      provenance: { kind: 'server' },
      entry,
    })!
    expect(downgradeDiagnosticJournalRecord(record)).toBeNull()
    const browserEntry = { ...entry, source: 'browser', correlation: 'client-asserted' }
    expect(isDiagnosticEventV2(browserEntry)).toBe(true)
    expect(isBrowserDiagnosticEvent(browserEntry)).toBe(false)
    expect(
      projectDiagnosticJournalRecord({
        ...record,
        provenance: { kind: 'browser', sourceId: 'b'.repeat(32), eventId: 'c'.repeat(32), clientSequence: 1 },
        entry: browserEntry,
      }),
    ).toBeNull()
    for (const extra of [
      { targetCount: 65 },
      { queueWaitMs: -1 },
      { durationMs: Infinity },
      { transcriptMessageCount: 1_000_000_001 },
      { timings: { scopeLoadMs: 86_400_001 } },
      { timings: { scopeLoadMs: 1, script: 'PRIVATE-SCRIPT' } },
      { resultCounts: { ...displayPerformance.resultCounts, messageId: 'PRIVATE-ID' } },
      { preparation: { dependencyHashMs: -1 } },
      { preparation: { dependencyJsonSize: 'PRIVATE-JSON' } },
      { preparation: { activeModuleCount: 1_000_000_001 } },
      { preparation: { loads: { 'PRIVATE-OWNER': { readMs: 1 } } } },
      { preparation: { loads: { modules: { readMs: Infinity } } } },
      { preparation: { loads: { modules: { jsonValues: -1 } } } },
      { preparation: { loads: { modules: { json: 'PRIVATE-JSON' } } } },
    ])
      expect(isDiagnosticEventV2({ ...entry, ...extra })).toBe(false)
    expect(JSON.stringify(record).length).toBeLessThan(4096)
    const { preparation, ...oldEntry } = entry
    expect(isDiagnosticEventV2(oldEntry)).toBe(true)
    // Allow large bounded numbers and every owner without exceeding journal admission.
    const maximal = JSON.parse(JSON.stringify(record), (key, value) => {
      if (typeof value !== 'number') return value
      if (key.endsWith('Ms')) return 86_400_000
      if ((key.endsWith('Count') && key !== 'targetCount') || key === 'jsonValues') return 1_000_000_000
      return value
    })
    maximal.entry.preparation.legacyLoadMs = 86_400_000
    expect(isDiagnosticEventV2(maximal.entry)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(maximal))).toBeLessThan(4096)
  })
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
      {
        ...base,
        category: 'display',
        stage: 'scope-decode',
        outcome: 'failed',
        failureKind: 'generation-input-validation',
      },
      {
        ...base,
        category: 'display',
        stage: 'scope-load',
        outcome: 'failed',
        failureKind: 'malformed-persistence',
        validationFieldRef: 'a'.repeat(16),
      },
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
    const displayRecord = projectDiagnosticJournalRecord({
      sequence: 2,
      receivedAt: 2,
      instanceId: 'a'.repeat(32),
      provenance: { kind: 'server' },
      entry: { ...base, ...examples[9] },
    })!
    expect(displayRecord.entry.category).toBe('display')
    expect(downgradeDiagnosticJournalRecord(displayRecord)).toBeNull()
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
  it('preserves the content-free generation validator error class', () => {
    const error = new Error('PRIVATE-VALIDATION-MESSAGE')
    error.name = 'GenerationInputValidationError'
    const fields = diagnosticErrorFields(error)
    expect(fields).toMatchObject({ errorName: 'GenerationInputValidationError' })
    expect(JSON.stringify(fields)).not.toContain('PRIVATE-VALIDATION-MESSAGE')
  })
})
