import { describe, expect, it } from 'vitest'
import {
  isDiagnosticTransportUrl,
  parseRemoteDiagnosticsQuery,
  projectRemoteDiagnosticRecord,
} from './remoteDiagnostics.js'

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
      { version: '3' },
      { requestUid: 'PRIVATE' },
      { operationRef: '../PRIVATE' },
      { cursor: 'a'.repeat(32), limit: '50' },
      { to: '8640000000000001' },
    ])
      expect(parseRemoteDiagnosticsQuery(input)).toBeNull()
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
