import { describe, expect, it } from 'vitest'
import {
  isRemoteDiagnosticsResponse,
  isDiagnosticTransportUrl,
  parseRemoteDiagnosticsQuery,
  projectRemoteDiagnosticFact,
  projectRemoteDiagnosticRecord,
  projectRemoteDiagnosticRecordV3,
} from './remoteDiagnostics.js'

const v2Record = {
  sequence: 1,
  receivedAt: 2,
  instanceId: 'a'.repeat(32),
  provenance: { kind: 'server' },
  entry: {
    timestamp: 1,
    source: 'server',
    level: 'error',
    correlation: 'background',
    category: 'runtime',
    kind: 'runtime-error',
    errorName: 'TypeError',
  },
} as const

const v3Envelope = (entries: unknown[]) => ({
  version: 3,
  serverTime: 2,
  identity: { build: 'b'.repeat(40), instanceId: 'a'.repeat(32) },
  entries,
  sources: { server: 'journal', browser: 'available' },
  capture: { from: 1, to: 2 },
  loss: { dropped: 0, rejected: 0, pruned: 0, truncated: false },
  pagination: { nextCursor: null, snapshotSequence: 1, lastSequence: 1 },
  clock: { ordering: 'server-sequence', browserTime: 'client-asserted', skew: 'unknown' },
  collection: { pending: 0, operationContinuity: 'retained' },
})

describe('remote diagnostics finite protocol', () => {
  it('accepts only bounded exact filters and cursor-only continuations', () => {
    expect(parseRemoteDiagnosticsQuery({}, 4_000_000)).toEqual({ version: 1, from: 400_000, to: 4_000_000, limit: 50 })
    expect(parseRemoteDiagnosticsQuery({ cursor: 'a'.repeat(32), version: '1' })).toMatchObject({
      cursor: 'a'.repeat(32),
    })
    for (const input of [
      { raw: 'true' },
      { category: 'PRIVATE' },
      { limit: '201' },
      { limit: 'NaN' },
      { limit: '1e2' },
      { limit: ['1', '2'] },
      { from: '0', to: '86400001' },
      { from: '2', to: '1' },
      { version: '4' },
      { requestUid: 'PRIVATE' },
      { operationRef: '../PRIVATE' },
      { cursor: 'a'.repeat(32), limit: '50' },
      { to: '8640000000000001' },
    ])
      expect(parseRemoteDiagnosticsQuery(input)).toBeNull()
    expect(parseRemoteDiagnosticsQuery({ version: '3', category: 'provider' })).toMatchObject({
      version: 3,
      category: 'provider',
    })
    expect(parseRemoteDiagnosticsQuery({ version: '3', category: 'runtime-error' })).toBeNull()
  })
  it('projects again without unverified stack coordinates or arbitrary fields', () => {
    const record = projectRemoteDiagnosticRecord({
      sequence: 1,
      receivedAt: 1,
      instanceId: 'a'.repeat(32),
      private: 'CANARY',
      entry: {
        timestamp: 1,
        source: 'server',
        event: 'http',
        level: 'error',
        message: 'CANARY',
        locations: ['src/CANARY.ts:1:2'],
        statusCode: 500,
      },
    })
    expect(record?.entry.statusCode).toBe(500)
    expect(JSON.stringify(record)).not.toContain('CANARY')
    expect(projectRemoteDiagnosticRecord({ ...record, instanceId: 'CANARY' })).toBeNull()
  })
  it('accepts only bounded typed v3 facts and preserves the exact v2 entry', () => {
    const facts = [
      { id: 'runtime.retryable', type: 'boolean', value: true },
      { id: 'runtime.retry-count', type: 'count', value: 2 },
      { id: 'runtime.elapsed', type: 'duration-ms', value: 12.5 },
      { id: 'runtime.payload-size', type: 'size-bucket', value: 'medium' },
      { id: 'runtime.related-operation', type: 'reference', value: 'c'.repeat(32) },
      { id: 'runtime.location.0', type: 'location', value: 'server/fastify/src/app.ts:12:3' },
      { id: 'runtime.location.1', type: 'location', value: 'src/lib/App.svelte:4:5' },
      { id: 'runtime.location.2', type: 'location', value: 'assets/index.js:7:8' },
    ] as const
    const projected = projectRemoteDiagnosticRecordV3({ ...v2Record, facts })
    expect(projected).toEqual({ ...v2Record, facts })
    expect(projected?.entry).toEqual(v2Record.entry)
    expect(isRemoteDiagnosticsResponse(v3Envelope([projected]))).toBe(true)
    expect(isRemoteDiagnosticsResponse({ ...v3Envelope([v2Record]), version: 2 })).toBe(true)
    expect(isRemoteDiagnosticsResponse({ ...v3Envelope([{ ...v2Record, facts }]), version: 2 })).toBe(false)
  })
  it('rejects duplicate, unbounded, content-bearing, and non-application v3 facts', () => {
    const duplicate = [
      { id: 'runtime.attempts', type: 'count', value: 1 },
      { id: 'runtime.attempts', type: 'count', value: 2 },
    ]
    expect(projectRemoteDiagnosticRecordV3({ ...v2Record, facts: duplicate })).toBeNull()
    expect(isRemoteDiagnosticsResponse(v3Envelope([{ ...v2Record, facts: duplicate }]))).toBe(false)
    expect(
      projectRemoteDiagnosticRecordV3({
        ...v2Record,
        facts: Array.from({ length: 33 }, (_, index) => ({
          id: `runtime.count.${index}`,
          type: 'count',
          value: index,
        })),
      }),
    ).toBeNull()
    for (const fact of [
      { id: 'PRIVATE', type: 'boolean', value: true },
      { id: 'runtime.private', type: 'string', value: 'CANARY' },
      { id: 'runtime.private', type: 'count', value: 'CANARY' },
      { id: 'runtime.count', type: 'count', value: 1_000_000_001 },
      { id: 'runtime.elapsed', type: 'duration-ms', value: Infinity },
      { id: 'runtime.size', type: 'size-bucket', value: 'CANARY' },
      { id: 'runtime.reference', type: 'reference', value: 'CANARY' },
      { id: 'runtime.location', type: 'location', value: '/private/server/fastify/src/app.ts:1:2' },
      { id: 'runtime.location', type: 'location', value: 'src/../private.ts:1:2' },
      { id: 'runtime.location', type: 'location', value: 'plugins/private.ts:1:2' },
      { id: 'runtime.safe', type: 'boolean', value: true, private: 'CANARY' },
    ]) {
      expect(projectRemoteDiagnosticFact(fact)).toBeNull()
      expect(projectRemoteDiagnosticRecordV3({ ...v2Record, facts: [fact] })).toBeNull()
    }
    expect(JSON.stringify(projectRemoteDiagnosticRecordV3({ ...v2Record, facts: duplicate }))).not.toContain('CANARY')
  })
  it('recognizes rejected diagnostic namespace traffic before routing', () => {
    for (const url of [
      '/api/v1/support/diagnostics?raw=CANARY',
      '/api/v1/support/invalid',
      '/api/v1/diagnostics/browser',
      '/api/v1/diagnostics/%',
      '/api/v1/%73upport/diagnostics',
      '/api/v1/%73upport/diagnostics%CANARY',
      '/api/v1/%64iagnostics/browser%CANARY',
      '/api/v1/%64iagnostics/%E0%A4%A',
      '/api/v1/%64iagnostics%',
      '/api/v1/%73upport%',
      '/api/v1/%73upport%E0%A4',
    ]) {
      expect(isDiagnosticTransportUrl(url)).toBe(true)
    }
    expect(isDiagnosticTransportUrl('/api/v1/chats/x')).toBe(false)
  })
})
