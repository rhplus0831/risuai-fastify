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
  DIAGNOSTICS_JOURNAL_VERSION,
  type DiagnosticsJournal,
  type DiagnosticsJournalOptions,
} from '../src/diagnosticsJournal.js'

const faults = vi.hoisted(() => ({
  starts: 0,
  stall: false,
  stalledStarts: 0,
  throwOnStart: false,
  throwingStarts: 0,
  stallAppend: false,
  suppressedAppendResponses: 0,
}))
vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:worker_threads')>()
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        faults.starts++
        if (faults.throwOnStart || faults.throwingStarts > 0) {
          if (faults.throwingStarts > 0) faults.throwingStarts--
          throw new Error('PRIVATE_NATIVE_ERROR_CANARY')
        }
        if (faults.stall || faults.stalledStarts > 0) {
          if (faults.stalledStarts > 0) faults.stalledStarts--
          super('setInterval(() => {}, 1000)', { eval: true, stdout: true, stderr: true })
        } else super(filename, options)
      }
      override postMessage(value: unknown, transferList?: readonly import('node:worker_threads').Transferable[]): void {
        const append = typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'append'
        if (append) {
          if (faults.stallAppend) return
          if (faults.suppressedAppendResponses > 0) {
            faults.suppressedAppendResponses--
            // Deliver the append, but model a committed write whose reply is lost.
            this.removeAllListeners('message')
          }
        }
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
  faults.starts = 0
  faults.stall = false
  faults.stalledStarts = 0
  faults.throwOnStart = false
  faults.throwingStarts = 0
  faults.stallAppend = false
  faults.suppressedAppendResponses = 0
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
        // This envelope includes a cold Node/tsx launch competing with the
        // aggregate suite's worker forks. Journal deadlines are independently
        // tested below; this case proves awaited completion and process exit.
        timeout: 10_000,
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
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: DIAGNOSTICS_JOURNAL_VERSION })
    expect(JSON.stringify(metadata)).not.toContain(LINEAGE)
    database.close()
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(directory, 'journal.sqlite'))).mode & 0o777).toBe(0o600)
  })

  it('persists only validated server facts and revalidates them across restart', async () => {
    const facts = [
      { id: 'runtime.retryable', type: 'boolean', value: true },
      { id: 'runtime.retry-count', type: 'count', value: 2 },
      { id: 'runtime.location.0', type: 'location', value: 'server/fastify/src/app.ts:12:3' },
    ] as const
    const journal = create()
    expect(journal.record(event(), { kind: 'server' }, facts)).toBe(true)
    await journal.ready
    await waitUntil(() => journal.read().entries.length === 1)
    expect(journal.read().entries[0].facts).toEqual(facts)
    await journal.close()

    const restarted = create({ instanceId: 'b'.repeat(32) })
    await restarted.ready
    expect(restarted.read().entries[0].facts).toEqual(facts)
    expect(
      restarted.record(event(), { kind: 'server' }, [
        { id: 'runtime.private', type: 'string', value: CANARY } as never,
      ]),
    ).toBe(false)
    expect(
      restarted.record(
        browserEvent(),
        { kind: 'browser', sourceId: 'c'.repeat(32), eventId: 'd'.repeat(32), clientSequence: 1 },
        [{ id: 'runtime.retryable', type: 'boolean', value: true }],
      ),
    ).toBe(false)
    expect(JSON.stringify(restarted.read())).not.toContain(CANARY)
    expect((await readFile(path.join(directory, 'journal.sqlite'))).includes(Buffer.from(CANARY))).toBe(false)
  })

  it('refuses newer journal versions without modifying existing database bytes', async () => {
    const journal = create()
    journal.record(event())
    await journal.ready
    await journal.close()
    const database = openStore()
    database.exec('PRAGMA user_version = 2')
    database.close()
    const before = await readFile(path.join(directory, 'journal.sqlite'))
    const restarted = create()
    await restarted.ready
    expect(restarted.read().source).toBe('unavailable')
    expect(restarted.read().entries).toEqual([])
    await restarted.close()
    expect(await readFile(path.join(directory, 'journal.sqlite'))).toEqual(before)
  })

  it('migrates only the known unversioned topology after rejecting malformed records', async () => {
    const journal = create()
    journal.record(event())
    await journal.ready
    await journal.close()
    const database = openStore()
    database.exec('PRAGMA user_version = 0')
    database.prepare('UPDATE journal_records SET record = ?').run(CANARY)
    database.close()
    const restarted = create()
    await restarted.ready
    expect(restarted.read().source).toBe('journal')
    expect(restarted.read().entries).toEqual([])
    expect(restarted.read().rejected).toBe(1)
    await restarted.close()
    const migrated = openStore()
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: DIAGNOSTICS_JOURNAL_VERSION })
    migrated.exec('PRAGMA user_version = 0; CREATE TABLE unknown_format (value TEXT)')
    migrated.close()
    const before = await readFile(path.join(directory, 'journal.sqlite'))
    const unknown = create()
    await unknown.ready
    expect(unknown.read().source).toBe('unavailable')
    await unknown.close()
    expect(await readFile(path.join(directory, 'journal.sqlite'))).toEqual(before)
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
    expect(journal.hasBrowserEvent(provenance.sourceId, provenance.eventId)).toBe(true)
    expect(journal.record(browserEvent(), { ...provenance, clientSequence: 2 })).toBe(false)
    provenance.eventId = 'e'.repeat(32)
    await journal.ready
    await journal.close()
    const restarted = create()
    await restarted.ready
    const original = { ...provenance, eventId: 'd'.repeat(32) }
    expect(restarted.read().entries[0].provenance).toEqual({ ...original, clientSequence: 1 })
    expect(restarted.record(browserEvent(), original)).toBe(false)
    expect(restarted.hasBrowserEvent(original.sourceId, original.eventId)).toBe(true)
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
      { initializationTimeoutMs: 30_001 },
      { requestTimeoutMs: 5_001 },
      { maintenanceTimeoutMs: 15_001 },
      { closeTimeoutMs: 1_001 },
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
      initializationTimeoutMs: 30_000,
      requestTimeoutMs: 5_000,
      maintenanceTimeoutMs: 15_000,
      closeTimeoutMs: 1_000,
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
    const throwing = create({ recoveryDelaysMs: [] })
    await throwing.ready
    expect(throwing.record(event())).toBe(false)
    expect(JSON.stringify(throwing.read())).not.toContain('PRIVATE_NATIVE_ERROR_CANARY')
  })

  it('isolates a locked journal from writes to an independent authoritative database', async () => {
    const states: Parameters<NonNullable<DiagnosticsJournalOptions['onStateChange']>>[0][] = []
    let reportUnavailable!: () => void
    const unavailable = new Promise<void>((resolve) => (reportUnavailable = resolve))
    const journal = create({
      recoveryDelaysMs: [1000],
      onStateChange: (event) => {
        states.push(event)
        if (event.state === 'unavailable') reportUnavailable()
      },
    })
    await journal.ready
    const authoritative = new DatabaseSync(path.join(temporary, 'authoritative.sqlite'))
    authoritative.exec('CREATE TABLE state (revision INTEGER); INSERT INTO state VALUES (0)')
    const database = openStore()
    database.exec('BEGIN EXCLUSIVE')
    expect(journal.record(event())).toBe(true)
    authoritative.exec('UPDATE state SET revision = revision + 1')
    await unavailable
    expect(states[0]).toEqual({
      state: 'unavailable',
      failure: 'storage-busy',
      operation: 'append',
      recoveryAttempt: 1,
      retryInMs: 1000,
    })
    expect(journal.read().dropped).toBeGreaterThanOrEqual(1)
    expect(authoritative.prepare('SELECT revision FROM state').get()).toEqual({ revision: 1 })
    await journal.close()
    authoritative.close()
    database.exec('ROLLBACK')
    database.close()
  })

  it('bounds physical SQLite growth and reports full storage without waiting in record()', async () => {
    const states: Parameters<NonNullable<DiagnosticsJournalOptions['onStateChange']>>[0][] = []
    const journal = create({
      limits: { maxFileBytes: 64 * 1024 },
      onStateChange: (event) => states.push(event),
    })
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
    expect(states).toEqual([
      {
        state: 'unavailable',
        failure: 'storage-full',
        operation: 'append',
        recoveryAttempt: 0,
        retryInMs: null,
      },
    ])
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

  it('restores a saturated journal and durably retains the newest 10,000 records', async () => {
    const initial = create()
    await initial.ready
    await initial.close()
    const database = openStore()
    const insert = database.prepare(
      'INSERT INTO journal_records (sequence, received_at, record, browser_key) VALUES (?, ?, ?, NULL)',
    )
    database.exec('BEGIN IMMEDIATE')
    try {
      for (let sequence = 1; sequence <= DIAGNOSTICS_JOURNAL_HARD_LIMITS.maxEvents; sequence++) {
        insert.run(
          sequence,
          NOW,
          JSON.stringify({
            sequence,
            receivedAt: NOW,
            instanceId: INSTANCE,
            provenance: { kind: 'server' },
            entry: event({ durationMs: sequence }),
          }),
        )
      }
      database
        .prepare('UPDATE journal_metadata SET last_sequence = ? WHERE id = 1')
        .run(DIAGNOSTICS_JOURNAL_HARD_LIMITS.maxEvents)
      database.exec('COMMIT')
    } catch (cause) {
      database.exec('ROLLBACK')
      throw cause
    } finally {
      database.close()
    }

    const restarted = create({ instanceId: 'b'.repeat(32) })
    await restarted.ready
    expect(restarted.read().source).toBe('journal')
    expect(restarted.read().entries).toHaveLength(DIAGNOSTICS_JOURNAL_HARD_LIMITS.maxEvents)
    for (let index = 0; index < 32; index++) expect(restarted.record(event({ durationMs: index }))).toBe(true)
    await vi.waitFor(() => expect(restarted.read().pending).toBe(0), { timeout: 10_000, interval: 100 })
    const result = restarted.read()
    expect(result.source).toBe('journal')
    expect(result.pending).toBe(0)
    expect(result.entries).toHaveLength(DIAGNOSTICS_JOURNAL_HARD_LIMITS.maxEvents)
    expect(result.entries[0].sequence).toBe(33)
    expect(result.entries.at(-1)?.sequence).toBe(10_032)
    expect(result.pruned).toBe(32)
    await restarted.close()
    const persisted = openStore()
    expect(
      persisted
        .prepare('SELECT count(*) AS count, min(sequence) AS first, max(sequence) AS last FROM journal_records')
        .get(),
    ).toEqual({ count: 10_000, first: 33, last: 10_032 })
    expect(
      persisted.prepare('SELECT last_sequence AS lastSequence, pruned FROM journal_metadata WHERE id = 1').get(),
    ).toEqual({ lastSequence: 10_032, pruned: 32 })
    persisted.close()
  })

  it('recovers automatically after one stalled startup while preserving queued records', async () => {
    faults.stalledStarts = 1
    const states: Parameters<NonNullable<DiagnosticsJournalOptions['onStateChange']>>[0][] = []
    const journal = create({
      limits: { initializationTimeoutMs: 1000 },
      recoveryDelaysMs: [10],
      onStateChange: (event) => states.push(event),
    })
    expect(journal.record(event())).toBe(true)
    await journal.ready
    expect(journal.read()).toMatchObject({ source: 'unavailable', pending: 1, dropped: 0 })
    await waitUntil(() => journal.available() && journal.read().pending === 0, 10_000)
    expect(journal.read().entries).toEqual([
      expect.objectContaining({ sequence: 1, entry: expect.objectContaining({ durationMs: 10 }) }),
    ])
    expect(states).toEqual([
      {
        state: 'unavailable',
        failure: 'request-timeout',
        operation: 'initialize',
        recoveryAttempt: 1,
        retryInMs: 10,
      },
      { state: 'recovered', recoveryAttempt: 1 },
    ])
  })

  it('recovers a committed append after its acknowledgement is lost without replaying it', async () => {
    const states: Parameters<NonNullable<DiagnosticsJournalOptions['onStateChange']>>[0][] = []
    let reportUnavailable!: () => void
    const unavailable = new Promise<void>((resolve) => (reportUnavailable = resolve))
    const journal = create({
      limits: { requestTimeoutMs: 100 },
      recoveryDelaysMs: [200],
      onStateChange: (event) => {
        states.push(event)
        if (event.state === 'unavailable') reportUnavailable()
      },
    })
    await journal.ready
    faults.suppressedAppendResponses = 1
    expect(journal.record(event({ durationMs: 1 }))).toBe(true)
    await unavailable
    expect(journal.read()).toMatchObject({ source: 'unavailable', pending: 0, dropped: 1 })
    expect(journal.record(event({ durationMs: 2 }))).toBe(true)
    await waitUntil(() => journal.available() && journal.read().pending === 0)
    expect(
      journal.read().entries.map((record) => ('durationMs' in record.entry ? record.entry.durationMs : undefined)),
    ).toEqual([1, 2])
    expect(journal.read().entries.map((record) => record.sequence)).toEqual([1, 2])
    expect(journal.read().dropped).toBe(1)
    expect(states).toEqual([
      {
        state: 'unavailable',
        failure: 'request-timeout',
        operation: 'append',
        recoveryAttempt: 1,
        retryInMs: 200,
      },
      { state: 'recovered', recoveryAttempt: 1 },
    ])
  })

  it('recovers after one worker start failure while preserving queued records', async () => {
    faults.throwingStarts = 1
    const states: Parameters<NonNullable<DiagnosticsJournalOptions['onStateChange']>>[0][] = []
    const journal = create({
      recoveryDelaysMs: [0],
      onStateChange: (event) => states.push(event),
    })
    expect(journal.record(event())).toBe(true)
    await waitUntil(() => journal.available() && journal.read().pending === 0)
    expect(faults.starts).toBe(2)
    expect(journal.read()).toMatchObject({ source: 'journal', pending: 0, dropped: 0 })
    expect(journal.read().entries).toEqual([
      expect.objectContaining({ sequence: 1, entry: expect.objectContaining({ durationMs: 10 }) }),
    ])
    expect(states).toEqual([
      {
        state: 'unavailable',
        failure: 'worker-start',
        operation: 'initialize',
        recoveryAttempt: 1,
        retryInMs: 0,
      },
      { state: 'recovered', recoveryAttempt: 1 },
    ])
  })

  it('bounds repeated recovery attempts and becomes terminal after the configured schedule', async () => {
    faults.stall = true
    const states: Parameters<NonNullable<DiagnosticsJournalOptions['onStateChange']>>[0][] = []
    const journal = create({
      limits: { initializationTimeoutMs: 50 },
      recoveryDelaysMs: [10, 10],
      onStateChange: (event) => states.push(event),
    })
    await waitUntil(() => states.length >= 3)
    expect(faults.starts).toBe(3)
    expect(states).toEqual([
      {
        state: 'unavailable',
        failure: 'request-timeout',
        operation: 'initialize',
        recoveryAttempt: 1,
        retryInMs: 10,
      },
      {
        state: 'unavailable',
        failure: 'request-timeout',
        operation: 'initialize',
        recoveryAttempt: 2,
        retryInMs: 10,
      },
      {
        state: 'unavailable',
        failure: 'request-timeout',
        operation: 'initialize',
        recoveryAttempt: 2,
        retryInMs: null,
      },
    ])
    expect(journal.record(event())).toBe(false)
    expect(journal.available()).toBe(false)
    expect(journal.read()).toMatchObject({ source: 'unavailable', pending: 0, dropped: 1 })
  })

  it('does not start a replacement worker after close while recovery is pending', async () => {
    faults.stalledStarts = 1
    const states: Parameters<NonNullable<DiagnosticsJournalOptions['onStateChange']>>[0][] = []
    let reportUnavailable!: () => void
    const unavailable = new Promise<void>((resolve) => (reportUnavailable = resolve))
    const journal = create({
      limits: { initializationTimeoutMs: 50 },
      recoveryDelaysMs: [0],
      onStateChange: (event) => {
        states.push(event)
        if (event.state === 'unavailable') reportUnavailable()
      },
    })
    await unavailable
    expect(faults.starts).toBe(1)
    await journal.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(faults.starts).toBe(1)
    expect(states).toHaveLength(1)
    expect(journal.read().source).toBe('unavailable')
  })

  it('times out a stalled worker and bounds shutdown even while an append is awaiting acknowledgment', async () => {
    faults.stall = true
    const stalled = create({ limits: { initializationTimeoutMs: 100 }, recoveryDelaysMs: [] })
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
