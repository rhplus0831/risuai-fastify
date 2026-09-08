import { describe, expect, it } from 'vitest'
import {
  BROWSER_DIAGNOSTICS_MAX_EVENTS,
  isBrowserDiagnosticsBatch,
  isBrowserDiagnosticsConfiguration,
  isBrowserDiagnosticsUploadResponse,
  type BrowserDiagnosticsBatch,
} from './browserDiagnostics.js'

function batch(): BrowserDiagnosticsBatch {
  return {
    version: 1,
    sourceId: 'a'.repeat(32),
    events: [
      {
        eventId: 'b'.repeat(32),
        clientSequence: 1,
        entry: {
          timestamp: 1,
          source: 'browser',
          level: 'error',
          correlation: 'client-asserted',
          category: 'runtime',
          kind: 'runtime-error',
        },
      },
    ],
  }
}

describe('browser diagnostics upload contract', () => {
  it('accepts only the exact versioned capability and bounded acknowledgment', () => {
    expect(isBrowserDiagnosticsConfiguration({ version: 1 })).toBe(true)
    for (const value of [undefined, {}, { version: 2 }, { version: 1, token: 'PRIVATE_CANARY' }])
      expect(isBrowserDiagnosticsConfiguration(value)).toBe(false)
    expect(isBrowserDiagnosticsUploadResponse({ version: 1, accepted: 1, duplicates: 2, dropped: 3 })).toBe(true)
    for (const value of [
      { version: 2, accepted: 1, duplicates: 0, dropped: 0 },
      { version: 1, accepted: -1, duplicates: 0, dropped: 0 },
      { version: 1, accepted: 32, duplicates: 1, dropped: 0 },
      { version: 1, accepted: 1, duplicates: 0, dropped: 0, message: 'PRIVATE_CANARY' },
    ])
      expect(isBrowserDiagnosticsUploadResponse(value)).toBe(false)
  })

  it('validates complete batches and rejects unknown fields at every boundary', () => {
    expect(isBrowserDiagnosticsBatch(batch())).toBe(true)
    const input = batch()
    for (const value of [
      { ...input, version: 2 },
      { ...input, sourceId: 'domain-private-id' },
      { ...input, body: 'PRIVATE_CANARY' },
      { ...input, events: [] },
      { ...input, events: Array(BROWSER_DIAGNOSTICS_MAX_EVENTS + 1).fill(input.events[0]) },
      { ...input, events: [{ ...input.events[0], eventId: 'PRIVATE_CANARY' }] },
      { ...input, events: [{ ...input.events[0], clientSequence: -1 }] },
      { ...input, events: [{ ...input.events[0], clientSequence: 1_000_000_001 }] },
      { ...input, events: [{ ...input.events[0], text: 'PRIVATE_CANARY' }] },
      {
        ...input,
        events: [input.events[0], { ...input.events[0], entry: { ...input.events[0].entry, text: 'PRIVATE_CANARY' } }],
      },
    ])
      expect(isBrowserDiagnosticsBatch(value)).toBe(false)
  })

  it('cannot impersonate server sources, operations or non-browser event families', () => {
    const input = batch()
    for (const replacement of [
      { source: 'server' },
      { correlation: 'background' },
      { correlation: 'request', requestUid: 'c'.repeat(64) },
      { operationRef: 'c'.repeat(32) },
      { attemptRef: 'c'.repeat(32) },
      { category: 'generation', stage: 'complete', outcome: 'completed', providerMayHaveRun: true },
    ]) {
      expect(
        isBrowserDiagnosticsBatch({
          ...input,
          events: [{ ...input.events[0], entry: { ...input.events[0].entry, ...replacement } }],
        }),
      ).toBe(false)
    }
    const withRequestAssociation = batch()
    withRequestAssociation.events[0].entry.requestUid = 'd'.repeat(64)
    expect(isBrowserDiagnosticsBatch(withRequestAssociation)).toBe(true)
  })

  it('validates legacy nested source/timestamp consistency and never projects a malformed batch', () => {
    const input = batch()
    const entry = {
      timestamp: 1,
      source: 'browser',
      level: 'info',
      correlation: 'client-asserted',
      category: 'legacy',
      detail: { timestamp: 1, source: 'browser', level: 'info', event: 'online' },
    }
    expect(isBrowserDiagnosticsBatch({ ...input, events: [{ ...input.events[0], entry }] })).toBe(true)
    for (const detail of [
      { ...entry.detail, timestamp: 2 },
      { ...entry.detail, source: 'server' },
      { ...entry.detail, text: 'PRIVATE_CANARY' },
    ]) {
      expect(
        isBrowserDiagnosticsBatch({ ...input, events: [{ ...input.events[0], entry: { ...entry, detail } }] }),
      ).toBe(false)
    }
  })
})
