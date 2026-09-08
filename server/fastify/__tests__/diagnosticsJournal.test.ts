import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticEventV2, DiagnosticJournalRecord } from '@risuai/protocol/remote-diagnostics'
import {
  createDiagnosticsJournal,
  DIAGNOSTICS_JOURNAL_HARD_LIMITS,
  type DiagnosticsJournal,
  type DiagnosticsJournalOptions,
} from '../src/diagnosticsJournal.js'

const faults = vi.hoisted(() => ({ stall: false, throwOnStart: false, stallAppend: false }))
vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:worker_threads')>()
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (faults.throwOnStart) throw new Error('PRIVATE_NATIVE_ERROR_CANARY')
        if (faults.stall) super('setInterval(() => {}, 1000)', { eval: true, stdout: true, stderr: true })
        else super(filename, options)
      }
      override postMessage(value: unknown, transferList?: readonly import('node:worker_threads').Transferable[]): void {
        if (
          faults.stallAppend &&
          typeof value === 'object' &&
          value !== null &&
          'kind' in value &&
          value.kind === 'append'
        )
          return
        super.postMessage(value, transferList)
      }
    },
  }
})

const NOW = 1_700_000_000_000
const INSTANCE = 'a'.repeat(32)
const LINEAGE = 'synthetic-authoritative-history'
const CANARY = 'PRIVATE_CHAT_PRESET_BODY_CREDENTIAL_ERROR_CANARY'
let temporary: string
let directory: string
let clock: number
let journals: DiagnosticsJournal[]

function event(extra: Partial<Extract<DiagnosticEventV2, { category: 'persistence' }>> = {}): DiagnosticEventV2 {
  return {
    timestamp: clock,
    source: 'server',
    level: 'info',
    correlation: 'background',
    category: 'persistence',
    phase: 'authoritative_commit',
    disposition: 'recovered',
    durationMs: 10,
    ...extra,
  }
}

function browserEvent(): DiagnosticEventV2 {
  return {
    timestamp: clock,
    source: 'browser',
    level: 'info',
    correlation: 'client-asserted',
    category: 'browser',
    stage: 'ownership',
    outcome: 'reader',
  }
}

function create(extra: Partial<DiagnosticsJournalOptions> = {}): DiagnosticsJournal {
  const journal = createDiagnosticsJournal({
    directory,
    lineage: LINEAGE,
    instanceId: INSTANCE,
    enabled: true,
    now: () => clock,
    ...extra,
  })
  journals.push(journal)
  return journal
}

async function waitUntil(predicate: () => boolean, timeout = 3000): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout, interval: 10 })
}

function openStore(): DatabaseSync {
  return new DatabaseSync(path.join(directory, 'journal.sqlite'))
}

beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'risu-diagnostics-journal-'))
  directory = path.join(temporary, 'diagnostics')
  clock = NOW
  journals = []
  faults.stall = false
  faults.throwOnStart = false
  faults.stallAppend = false
})

afterEach(async () => {
  await Promise.all(journals.map((journal) => journal.close()))
  await rm(temporary, { recursive: true, force: true })
})

describe('bounded diagnostics journal', () => {
  it('settles awaited startup and close in a standalone process without unrelated live handles', async () => {
    const source = new URL('../src/diagnosticsJournal.ts', import.meta.url).href
    const script = `
      import { createDiagnosticsJournal } from ${JSON.stringify(source)};
      const journal = createDiagnosticsJournal({ directory: process.env.TEST_DIAGNOSTICS_DIRECTORY, lineage: 'synthetic', instanceId: '${INSTANCE}', enabled: true });
      await journal.ready;
      journal.record({ timestamp: Date.now(), source: 'server', level: 'info', correlation: 'background', category: 'runtime', kind: 'runtime-error' });
      await journal.close();
      console.log('closed');
    `
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { PATH: process.env.PATH, TEST_DIAGNOSTICS_DIRECTORY: directory },
        timeout: 3000,
        maxBuffer: 4096,
      },
    )
    expect(result.stdout).toBe('closed\n')
    expect(result.stderr).toBe('')
    const database = openStore()
    expect(database.prepare('SELECT count(*) AS value FROM journal_records').get()).toEqual({ value: 1 })
    database.close()
  })

  it('queues during initialization, persists exact records, and restores sequence and epoch across restart', async () => {
    const journal = create()
    expect(journal.read().source).toBe('unavailable')
    expect(journal.record(event())).toBe(true)
    await journal.ready
    await waitUntil(() => journal.read().entries.length === 1)
    const initial = journal.read()
    expect(initial.entries[0]).toEqual({
      sequence: 1,
      receivedAt: NOW,
      instanceId: INSTANCE,
      provenance: { kind: 'server' },
      entry: event(),
    })
    expect(initial.source).toBe('journal')
    await journal.close()
    const restarted = create({ instanceId: 'b'.repeat(32) })
    await restarted.ready
    expect(restarted.read().entries).toEqual(initial.entries)
    expect(restarted.read().epoch).toBe(initial.epoch)
    expect(restarted.record(event({ disposition: 'committed' }))).toBe(true)
    await waitUntil(() => restarted.read().entries.length === 2)
    expect(restarted.read().entries.map((record) => [record.sequence, record.instanceId])).toEqual([
      [1, INSTANCE],
      [2, 'b'.repeat(32)],
    ])
    const database = openStore()
    const metadata = database.prepare('SELECT * FROM journal_metadata').get()
    expect(JSON.stringify(metadata)).not.toContain(LINEAGE)
    database.close()
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(directory, 'journal.sqlite'))).mode & 0o777).toBe(0o600)
  })

  it('bounds the outstanding queue and durably accounts for overflow without blocking callers', async () => {
    const journal = create({ limits: { maxQueue: 3 } })
    expect([
      journal.record(event()),
      journal.record(event()),
      journal.record(event()),
      journal.record(event()),
    ]).toEqual([true, true, true, false])
    expect(journal.read().dropped).toBe(1)
    expect(journal.read().pending).toBe(3)
    await journal.ready
    await waitUntil(() => journal.read().entries.length === 3)
    expect(journal.read().pending).toBe(0)
    await journal.close()
    const restarted = create()
    await restarted.ready
    expect(restarted.read().entries).toHaveLength(3)
    expect(restarted.read().dropped).toBe(1)
  })

  it('keeps the newest count-bounded records and preserves sequence gaps after pruning', async () => {
    const journal = create({ limits: { maxEvents: 3 } })
    for (let index = 0; index < 10; index++) expect(journal.record(event({ durationMs: index }))).toBe(true)
    await journal.ready
    await waitUntil(() => journal.read().entries.at(-1)?.sequence === 10)
    expect(journal.read().entries.map((record) => record.sequence)).toEqual([8, 9, 10])
    expect(journal.read().pruned).toBe(7)
    await journal.close()
    const restarted = create({ limits: { maxEvents: 3 } })
    await restarted.ready
    expect(restarted.read().pruned).toBe(7)
    restarted.record(event())
    await waitUntil(() => restarted.read().entries.at(-1)?.sequence === 11)
    expect(restarted.read().entries.map((record) => record.sequence)).toEqual([9, 10, 11])
  })

  it('enforces retained byte limits independently of event count and removes expired evidence on reads and startup', async () => {
    const journal = create({ limits: { maxBytes: 1000, maxAgeMs: 1000 } })
    for (let index = 0; index < 10; index++) journal.record(event())
    await journal.ready
    await waitUntil(() => journal.read().entries.at(-1)?.sequence === 10)
    const captured = journal.read()
    expect(captured.entries.length).toBeLessThan(10)
    expect(
      captured.entries.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record)), 0),
    ).toBeLessThanOrEqual(1000)
    expect(captured.pruned).toBe(10 - captured.entries.length)
    clock += 1001
    expect(journal.read().entries).toEqual([])
    expect(journal.read().pruned).toBe(10)
    await journal.close()
    const restarted = create({ limits: { maxAgeMs: 1000 } })
    await restarted.ready
    expect(restarted.read().entries).toEqual([])
    expect(restarted.read().pruned).toBe(10)
  })

  it('prunes age on startup even if the previous process closed while records were still current', async () => {
    const journal = create({ limits: { maxAgeMs: 500 } })
    journal.record(event())
    await journal.ready
    await journal.close()
    clock += 501
    const restarted = create({ limits: { maxAgeMs: 500 } })
    await restarted.ready
    expect(restarted.read().entries).toEqual([])
    expect(restarted.read().pruned).toBe(1)
  })

  it('rejects extra content fields, forged provenance and oversize records before any persistence', async () => {
    const journal = create()
    const privateEntry = { ...event(), body: CANARY }
    expect(journal.record(privateEntry as DiagnosticEventV2)).toBe(false)
    expect(
      journal.record(event(), {
        kind: 'browser',
        sourceId: 'a'.repeat(32),
        eventId: 'b'.repeat(32),
        clientSequence: 1,
      }),
    ).toBe(false)
    expect(journal.record(browserEvent())).toBe(false)
    await journal.ready
    await journal.close()
    const database = openStore()
    expect(database.prepare('SELECT record FROM journal_records').all()).toEqual([])
    database.close()
    expect((await readFile(path.join(directory, 'journal.sqlite'))).includes(Buffer.from(CANARY))).toBe(false)
    const tiny = create({ directory: path.join(temporary, 'tiny'), limits: { maxRecordBytes: 128 } })
    expect(tiny.record(event())).toBe(false)
    await tiny.ready
    expect(tiny.read().rejected).toBe(1)
    expect(tiny.read().entries).toEqual([])
  })

  it('copies queued inputs and returned snapshots so caller mutation cannot change persisted evidence', async () => {
    const input = event()
    const journal = create()
    expect(journal.record(input)).toBe(true)
    Object.assign(input, { category: CANARY, body: CANARY })
    await journal.ready
    await waitUntil(() => journal.read().entries.length === 1)
    const snapshot = journal.read()
    Object.assign(snapshot.entries[0].entry, { category: CANARY, body: CANARY })
    snapshot.entries.splice(0)
    expect(journal.read().entries[0].entry).toEqual(event())
    expect(JSON.stringify(journal.read())).not.toContain(CANARY)
    await journal.close()
    const database = openStore()
    expect(JSON.stringify(database.prepare('SELECT record FROM journal_records').all())).not.toContain(CANARY)
    database.close()
  })

  it('revalidates and securely removes corrupt restored rows without ever returning the original payload', async () => {
    const journal = create()
    journal.record(event())
    await journal.ready
    await journal.close()
    const database = openStore()
    const row = database.prepare('SELECT record FROM journal_records').get() as { record: string }
    database
      .prepare('UPDATE journal_records SET record = ?')
      .run(JSON.stringify({ ...JSON.parse(row.record), text: CANARY }))
    database.close()
    const restarted = create()
    await restarted.ready
    expect(restarted.read().source).toBe('journal')
    expect(restarted.read().entries).toEqual([])
    expect(restarted.read().rejected).toBe(1)
    expect(JSON.stringify(restarted.read())).not.toContain(CANARY)
    await restarted.close()
    expect((await readFile(path.join(directory, 'journal.sqlite'))).includes(Buffer.from(CANARY))).toBe(false)
  })

  it('detects record/row metadata mismatches during restoration', async () => {
    const journal = create()
    journal.record(event())
    await journal.ready
    await journal.close()
    const database = openStore()
    database.prepare('UPDATE journal_records SET received_at = ?').run(NOW + 1)
    database.close()
    const restarted = create()
    await restarted.ready
    expect(restarted.read().entries).toEqual([])
    expect(restarted.read().rejected).toBe(1)
  })

  it('bounds startup reads of oversized rows and removes them before schema restoration', async () => {
    const journal = create()
    journal.record(event())
    await journal.ready
    await journal.close()
    const database = openStore()
    database.prepare('UPDATE journal_records SET record = ?').run(CANARY.repeat(1000))
    database.close()
    const restarted = create()
    await restarted.ready
    expect(restarted.read().entries).toEqual([])
    expect(restarted.read().rejected).toBe(1)
    expect(JSON.stringify(restarted.read())).not.toContain(CANARY)
  })

  it('deduplicates browser identity before flush and across restart while keeping independent sources distinct', async () => {
    const provenance: DiagnosticJournalRecord['provenance'] = {
      kind: 'browser',
      sourceId: 'c'.repeat(32),
      eventId: 'd'.repeat(32),
      clientSequence: 1,
    }
    const journal = create()
    expect(journal.record(browserEvent(), provenance)).toBe(true)
    expect(journal.record(browserEvent(), { ...provenance, clientSequence: 2 })).toBe(false)
    provenance.eventId = 'e'.repeat(32)
    await journal.ready
    await journal.close()
    const restarted = create()
    await restarted.ready
    const original = { ...provenance, eventId: 'd'.repeat(32) }
    expect(restarted.read().entries[0].provenance).toEqual({ ...original, clientSequence: 1 })
    expect(restarted.record(browserEvent(), original)).toBe(false)
    expect(restarted.record(browserEvent(), { ...original, sourceId: 'f'.repeat(32) })).toBe(true)
    await waitUntil(() => restarted.read().entries.length === 2)
  })

  it('expires browser deduplication with retained evidence and revalidates dedup metadata on restart', async () => {
    const provenance: DiagnosticJournalRecord['provenance'] = {
      kind: 'browser',
      sourceId: 'c'.repeat(32),
      eventId: 'd'.repeat(32),
      clientSequence: 1,
    }
    const journal = create({ limits: { maxAgeMs: 500 } })
    journal.record(browserEvent(), provenance)
    await journal.ready
    await waitUntil(() => journal.read().pending === 0)
    clock += 501
    expect(journal.record(browserEvent(), provenance)).toBe(true)
    await waitUntil(() => journal.read().entries.at(-1)?.sequence === 2)
    expect(journal.read().entries).toHaveLength(1)
    await journal.close()
    const database = openStore()
    database.prepare('UPDATE journal_records SET browser_key = ?').run(CANARY)
    database.close()
    const restarted = create()
    await restarted.ready
    expect(restarted.read().entries).toEqual([])
    expect(restarted.read().rejected).toBe(1)
  })

  it('clears in-flight writes, queued records, identities and epochs immediately on history reset', async () => {
    const journal = create()
    await journal.ready
    const before = journal.read().epoch
    journal.record(event({ disposition: 'failed' }))
    journal.reset('replacement-history')
    expect(journal.read().entries).toEqual([])
    expect(journal.read().epoch).not.toBe(before)
    expect(journal.read().source).toBe('unavailable')
    journal.record(event({ disposition: 'recovered' }))
    await waitUntil(() => journal.read().entries.length === 1)
    expect(journal.read().entries[0]).toMatchObject({ sequence: 1, entry: { disposition: 'recovered' } })
    const after = journal.read()
    await journal.close()
    const restarted = create({ lineage: 'replacement-history' })
    await restarted.ready
    expect(restarted.read().entries).toEqual(after.entries)
    expect(restarted.read().epoch).toBe(after.epoch)
  })

  it('fences initialization and clears retained rows when authoritative lineage changes between processes', async () => {
    const journal = create()
    journal.record(event({ disposition: 'failed' }))
    journal.reset('replacement-history')
    journal.record(event({ disposition: 'recovered' }))
    await journal.ready
    await waitUntil(() => journal.read().entries.length === 1)
    expect(journal.read().entries[0]).toMatchObject({ sequence: 1, entry: { disposition: 'recovered' } })
    await journal.close()
    const restarted = create({ lineage: 'another-replacement' })
    await restarted.ready
    expect(restarted.read().entries).toEqual([])
    expect(restarted.read().pruned).toBe(0)
  })

  it('is disabled without creating files and rejects unlimited, invalid or raised bounds', async () => {
    const disabled = create({ enabled: false })
    await disabled.ready
    expect(disabled.record(event())).toBe(false)
    expect(await readdir(temporary)).toEqual([])
    for (const limits of [
      { maxEvents: 0 },
      { maxBytes: Infinity },
      { maxQueue: 257 },
      { maxAgeMs: 86_400_001 },
      { maxRecordBytes: 4097 },
      { requestTimeoutMs: 1001 },
    ]) {
      const invalid = create({ limits })
      await invalid.ready
      expect(invalid.read().source).toBe('unavailable')
      expect(invalid.record(event())).toBe(false)
    }
    expect(await readdir(temporary)).toEqual([])
    expect(DIAGNOSTICS_JOURNAL_HARD_LIMITS).toMatchObject({
      maxEvents: 10_000,
      maxBytes: 8 * 1024 * 1024,
      maxQueue: 256,
      maxRecordBytes: 4096,
    })
  })

  it('isolates invalid directories, symlinks, corrupt SQLite and worker startup failures with no raw error output', async () => {
    await writeFile(path.join(temporary, 'file'), CANARY)
    const invalid = create({ directory: path.join(temporary, 'file', 'journal') })
    await invalid.ready
    expect(invalid.read().source).toBe('unavailable')
    const healthy = create()
    await healthy.ready
    await healthy.close()
    const alias = path.join(temporary, 'alias')
    await symlink(directory, alias)
    const linked = create({ directory: alias })
    await linked.ready
    expect(linked.read().source).toBe('unavailable')
    await writeFile(path.join(directory, 'journal.sqlite'), CANARY)
    const corrupt = create()
    await corrupt.ready
    expect(corrupt.read().source).toBe('unavailable')
    expect(JSON.stringify(corrupt.read())).not.toContain(CANARY)
    faults.throwOnStart = true
    const throwing = create()
    await throwing.ready
    expect(throwing.record(event())).toBe(false)
    expect(JSON.stringify(throwing.read())).not.toContain('PRIVATE_NATIVE_ERROR_CANARY')
  })

  it('isolates a locked journal from writes to an independent authoritative database', async () => {
    const journal = create()
    await journal.ready
    const authoritative = new DatabaseSync(path.join(temporary, 'authoritative.sqlite'))
    authoritative.exec('CREATE TABLE state (revision INTEGER); INSERT INTO state VALUES (0)')
    const database = openStore()
    database.exec('BEGIN EXCLUSIVE')
    expect(journal.record(event())).toBe(true)
    authoritative.exec('UPDATE state SET revision = revision + 1')
    await waitUntil(() => journal.read().source === 'unavailable')
    expect(journal.read().dropped).toBeGreaterThanOrEqual(1)
    expect(authoritative.prepare('SELECT revision FROM state').get()).toEqual({ revision: 1 })
    authoritative.close()
    database.exec('ROLLBACK')
    database.close()
    await journal.close()
  })

  it('bounds physical SQLite growth and reports full storage without waiting in record()', async () => {
    const journal = create({ limits: { maxFileBytes: 64 * 1024 } })
    await journal.ready
    for (let index = 0; index < 256; index++)
      journal.record(
        event({
          durationMs: index,
          retryCount: index,
          queueDepth: index,
          queueAgeMs: index,
          contention: true,
          journalConfirmed: true,
          authoritativeCommitted: false,
          cleanupComplete: false,
        }),
      )
    await waitUntil(() => journal.read().source === 'unavailable')
    expect(journal.read().dropped).toBeGreaterThan(0)
    expect((await stat(path.join(directory, 'journal.sqlite'))).size).toBeLessThanOrEqual(64 * 1024)
    expect((await readdir(directory)).some((file) => file.endsWith('-wal'))).toBe(false)
  })

  it('keeps small and detailed synthetic workloads within independent count and byte budgets', async () => {
    const journal = create({ limits: { maxEvents: 200, maxBytes: 64 * 1024 } })
    await journal.ready
    for (const detail of [false, true]) {
      for (let batch = 0; batch < 4; batch++) {
        for (let index = 0; index < 256; index++) {
          const entry: DiagnosticEventV2 = detail
            ? {
                timestamp: clock,
                source: 'server',
                level: 'warn',
                correlation: 'operation',
                operationRef: 'e'.repeat(32),
                attemptRef: 'f'.repeat(32),
                requestUid: 'a'.repeat(64),
                category: 'provider',
                adapter: 'openai',
                transport: 'stream',
                stage: 'terminal',
                outcome: 'timeout',
                durationMs: 1000,
                providerMayHaveRun: true,
                timeToHeadersMs: 10,
                timeToFirstTokenMs: 20,
                maxStreamGapMs: 980,
                chunkCount: 100,
                responseBytes: 'large',
                statusCode: 200,
                retryOrdinal: 1,
                cancellationOrigin: 'deadline',
              }
            : event()
          expect(journal.record(entry)).toBe(true)
        }
        await waitUntil(() => journal.read().pending === 0)
      }
      const snapshot = journal.read()
      expect(snapshot.source).toBe('journal')
      expect(snapshot.dropped).toBe(0)
      expect(snapshot.entries.length).toBeLessThanOrEqual(200)
      expect(
        snapshot.entries.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record)), 0),
      ).toBeLessThanOrEqual(64 * 1024)
      expect(snapshot.entries.length + snapshot.pruned).toBe(detail ? 2048 : 1024)
    }
    expect((await stat(path.join(directory, 'journal.sqlite'))).size).toBeLessThanOrEqual(
      DIAGNOSTICS_JOURNAL_HARD_LIMITS.maxFileBytes,
    )
  })

  it('times out a stalled worker and bounds shutdown even while an append is awaiting acknowledgment', async () => {
    faults.stall = true
    const stalled = create({ limits: { requestTimeoutMs: 100 } })
    expect(stalled.record(event())).toBe(true)
    const started = performance.now()
    await stalled.ready
    expect(performance.now() - started).toBeLessThan(1500)
    expect(stalled.read().source).toBe('unavailable')
    expect(stalled.read().dropped).toBe(1)
    faults.stall = false
    const appending = create()
    await appending.ready
    faults.stallAppend = true
    appending.record(event())
    const closing = performance.now()
    await appending.close()
    expect(performance.now() - closing).toBeLessThan(1800)
    expect(appending.record(event())).toBe(false)
    expect(appending.read().source).toBe('unavailable')
    expect(appending.read().dropped).toBe(1)
  })
})
