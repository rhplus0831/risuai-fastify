import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getDiagnosticContext,
  loadDiagnosticReferenceKey,
  recordDiagnosticEvent,
  recordDiagnosticEventForDatabase,
  registerDiagnosticDatabase,
  runWithDiagnosticAttempt,
  runWithDiagnosticContext,
} from '../src/diagnosticContext.js'
import { isDiagnosticEventV2, type DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'

const failure = {
  category: 'persistence',
  phase: 'authoritative_commit',
  disposition: 'retryable',
  durationMs: 10,
  journalConfirmed: true,
  authoritativeCommitted: false,
  body: 'PRIVATE-BODY',
}

describe('app and history scoped diagnostic correlation', () => {
  it('keeps async background operations isolated with private stable references after restart', async () => {
    const first = {},
      other = {},
      restarted = {}
    const events: DiagnosticEventV2[] = []
    const otherEvents: DiagnosticEventV2[] = []
    const key = new Uint8Array(32).fill(7)
    registerDiagnosticDatabase(first, { history: () => 'private-lineage', key, record: (event) => events.push(event) })
    registerDiagnosticDatabase(other, {
      history: () => 'private-lineage',
      key: new Uint8Array(32).fill(8),
      record: (event) => otherEvents.push(event),
    })
    await Promise.all([
      runWithDiagnosticContext(
        first,
        { operationId: 'PRIVATE-OPERATION', attemptId: 'PRIVATE-ATTEMPT', requestUid: 'a'.repeat(64) },
        async () => {
          await Promise.resolve()
          recordDiagnosticEvent(failure)
        },
      ),
      runWithDiagnosticContext(other, { operationId: 'PRIVATE-OPERATION' }, async () => {
        await Promise.resolve()
        recordDiagnosticEvent(failure)
      }),
    ])
    registerDiagnosticDatabase(restarted, {
      history: () => 'private-lineage',
      key,
      record: (event) => events.push(event),
    })
    recordDiagnosticEventForDatabase(
      restarted,
      { ...failure, disposition: 'recovered', authoritativeCommitted: true },
      { operationId: 'PRIVATE-OPERATION', attemptId: 'PRIVATE-ATTEMPT', background: true },
    )
    expect(events).toHaveLength(2)
    expect(events[0].operationRef).toMatch(/^[a-f0-9]{32}$/)
    expect(events[1].operationRef).toBe(events[0].operationRef)
    expect(events[1].attemptRef).toBe(events[0].attemptRef)
    expect(events[1].requestUid).toBeUndefined()
    expect(otherEvents[0].operationRef).not.toBe(events[0].operationRef)
    expect(events.every(isDiagnosticEventV2)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
    expect(JSON.stringify(events)).not.toContain('private-lineage')
  })
  it('binds independent provider attempts to lazy generators including direct next/return', async () => {
    const db = {}
    const events: DiagnosticEventV2[] = []
    registerDiagnosticDatabase(db, { history: () => 'lineage', record: (event) => events.push(event) })
    const iterable = runWithDiagnosticContext(db, { operationId: 'operation' }, () =>
      runWithDiagnosticAttempt(async function* () {
        recordDiagnosticEvent(failure)
        yield 1
        await Promise.resolve()
        recordDiagnosticEvent(failure)
        yield 2
      }),
    )
    expect(await iterable.next()).toEqual({ done: false, value: 1 })
    expect(await iterable.next()).toEqual({ done: false, value: 2 })
    await iterable.return(undefined)
    expect(events).toHaveLength(2)
    expect(events[0].attemptRef).toBe(events[1].attemptRef)
    expect(events[0].correlation).toBe('operation')
    let second: string | undefined
    runWithDiagnosticContext(db, { operationId: 'operation' }, () =>
      runWithDiagnosticAttempt(() => {
        second = getDiagnosticContext()?.attemptRef
      }),
    )
    expect(second).not.toBe(events[0].attemptRef)
  })
  it('clears replaced/closed/disabled scopes without changing the callback result', () => {
    const db = {},
      disabled = {}
    let lineage = 'before'
    const events: DiagnosticEventV2[] = []
    const unregister = registerDiagnosticDatabase(db, { history: () => lineage, record: (event) => events.push(event) })
    runWithDiagnosticContext(db, { operationId: 'operation' }, () => {
      lineage = 'after'
      recordDiagnosticEvent(failure)
      expect(
        runWithDiagnosticContext(db, { databaseLineage: 'before' }, () => {
          recordDiagnosticEvent(failure)
          return 42
        }),
      ).toBe(42)
      runWithDiagnosticContext(disabled, {}, () => recordDiagnosticEvent(failure))
    })
    runWithDiagnosticContext(db, {}, () => {
      unregister()
      recordDiagnosticEvent(failure)
    })
    expect(events).toEqual([])
  })
  it('loads only the dedicated private random mapping key and keeps failures nonfatal', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'risu-diag-context-'))
    try {
      const key = await loadDiagnosticReferenceKey(directory)
      expect(key).toHaveLength(32)
      expect(await loadDiagnosticReferenceKey(directory)).toEqual(key)
      expect(await loadDiagnosticReferenceKey(path.join(directory, 'correlation.key/invalid'))).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
