// Node >=24 executes this erasable TS worker without app loaders. Only this
// isolated worker opens the telemetry database; it never opens the domain DB.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parentPort } from 'node:worker_threads'
import type {
  DiagnosticsJournalCounters,
  DiagnosticsJournalLimits,
  DiagnosticsJournalRequest,
  DiagnosticsJournalResponse,
  PendingDiagnosticRecord,
  StoredDiagnosticRow,
} from './diagnosticsJournalProtocol.js'

const port = parentPort!
const MAX_INTEGER = Number.MAX_SAFE_INTEGER
// Keep in sync with the browser-free protocol constant; this native worker
// intentionally has no runtime imports of transformed application modules.
const JOURNAL_VERSION = 1
let db: DatabaseSync | undefined
let needsVersionMarker = false
let limits: DiagnosticsJournalLimits
let epoch = ''
let lineageDigest = ''
let lastSequence = 0
let counters: DiagnosticsJournalCounters = { dropped: 0, rejected: 0, pruned: 0 }

interface RowMetadata {
  sequence: number
  receivedAt: number
  bytes: number
}

function add(left: number, right: number): number {
  return Math.min(MAX_INTEGER, left + right)
}

function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function checkFile(file: string, maximum: number): void {
  try {
    const info = fs.lstatSync(file)
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum || (info.mode & 0o077) !== 0) throw new Error()
  } catch (cause) {
    if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) throw cause
  }
}

function writeMetadata(): void {
  db!
    .prepare(
      'UPDATE journal_metadata SET lineage_digest = ?, epoch = ?, last_sequence = ?, dropped = ?, rejected = ?, pruned = ? WHERE id = 1',
    )
    .run(lineageDigest, epoch, lastSequence, counters.dropped, counters.rejected, counters.pruned)
}

function allMetadata(): RowMetadata[] {
  // The cap is enforced in SQL before crossing into JavaScript, even if an
  // operator edited this dedicated store while the app was stopped.
  return db!
    .prepare(
      `SELECT sequence, received_at AS receivedAt, length(CAST(record AS BLOB)) AS bytes
     FROM journal_records ORDER BY sequence DESC LIMIT ?`,
    )
    .all(limits.maxEvents) as unknown as RowMetadata[]
}

function retain(rows: RowMetadata[], now: number): number[] {
  const chronological = rows
    .filter((row) => row.receivedAt >= now - limits.maxAgeMs && row.bytes <= limits.maxRecordBytes)
    .sort((left, right) => left.sequence - right.sequence)
  let bytes = chronological.reduce((sum, row) => sum + row.bytes, 0)
  let start = 0
  while (chronological.length - start > limits.maxEvents || bytes > limits.maxBytes) {
    bytes -= chronological[start++].bytes
  }
  return chronological.slice(start).map((row) => row.sequence)
}

function deleteExcept(sequences: number[]): number {
  const result = sequences.length
    ? db!
        .prepare(`DELETE FROM journal_records WHERE sequence NOT IN (${sequences.map(() => '?').join(',')})`)
        .run(...sequences)
    : db!.prepare('DELETE FROM journal_records').run()
  return Number(result.changes)
}

function prune(now: number): number[] {
  const retained = retain(allMetadata(), now)
  counters.pruned = add(counters.pruned, deleteExcept(retained))
  return retained
}

function readRows(): StoredDiagnosticRow[] {
  return db!
    .prepare(
      `SELECT sequence, received_at AS receivedAt, browser_key AS browserKey,
       CASE WHEN length(CAST(record AS BLOB)) <= ? THEN record ELSE NULL END AS json
     FROM journal_records ORDER BY sequence LIMIT ?`,
    )
    .all(limits.maxRecordBytes, limits.maxEvents) as unknown as StoredDiagnosticRow[]
}

function inspectVersion(file: string): number {
  const probe = new DatabaseSync(file, { readOnly: true })
  try {
    const version = Number((probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version !== 0 && version !== JOURNAL_VERSION) throw new Error()
    const objects = probe
      .prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 3")
      .all() as { type: string; name: string }[]
    if (objects.length === 0 && version === 0) return version
    if (
      JSON.stringify(objects.map(({ type, name }) => [type, name])) !==
      JSON.stringify([
        ['table', 'journal_metadata'],
        ['table', 'journal_records'],
      ])
    )
      throw new Error()
    const expected: Record<string, string[]> = {
      journal_metadata: [
        'id:INTEGER:0:1',
        'lineage_digest:TEXT:1:0',
        'epoch:TEXT:1:0',
        'last_sequence:INTEGER:1:0',
        'dropped:INTEGER:1:0',
        'rejected:INTEGER:1:0',
        'pruned:INTEGER:1:0',
      ],
      journal_records: ['sequence:INTEGER:0:1', 'received_at:INTEGER:1:0', 'record:TEXT:1:0', 'browser_key:TEXT:0:0'],
    }
    for (const [table, columns] of Object.entries(expected)) {
      const actual = probe.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string
        type: string
        notnull: number
        pk: number
      }[]
      if (
        JSON.stringify(actual.map((column) => `${column.name}:${column.type}:${column.notnull}:${column.pk}`)) !==
        JSON.stringify(columns)
      )
        throw new Error()
    }
    const indexes = probe.prepare('PRAGMA index_list(journal_records)').all() as {
      name: string
      unique: number
      origin: string
      partial: number
    }[]
    if (indexes.length !== 1 || indexes[0].unique !== 1 || indexes[0].origin !== 'u' || indexes[0].partial !== 0)
      throw new Error()
    const indexed = probe.prepare('PRAGMA index_info(sqlite_autoindex_journal_records_1)').all() as { name: string }[]
    if (indexed.length !== 1 || indexed[0].name !== 'browser_key') throw new Error()
    return version
  } finally {
    probe.close()
  }
}

function initialize(request: Extract<DiagnosticsJournalRequest, { kind: 'initialize' }>): void {
  limits = request.limits
  // Defense in depth: the main thread is the only producer of this protocol.
  if (
    limits.maxEvents < 1 ||
    limits.maxEvents > 10_000 ||
    limits.maxRecordBytes < 1 ||
    limits.maxRecordBytes > 4096 ||
    limits.maxBytes < 1 ||
    limits.maxBytes > 8 * 1024 * 1024 ||
    limits.maxFileBytes < 64 * 1024 ||
    limits.maxFileBytes > 16 * 1024 * 1024 ||
    limits.maxAgeMs < 1 ||
    limits.maxAgeMs > 86_400_000
  )
    throw new Error()
  fs.mkdirSync(request.directory, { recursive: true, mode: 0o700 })
  const directoryInfo = fs.lstatSync(request.directory)
  if (
    !directoryInfo.isDirectory() ||
    (directoryInfo.mode & 0o077) !== 0 ||
    fs.realpathSync(request.directory) !== request.directory
  )
    throw new Error()
  const file = path.join(request.directory, 'journal.sqlite')
  for (const suffix of ['', '-journal', '-wal', '-shm']) checkFile(`${file}${suffix}`, limits.maxFileBytes + 64 * 1024)
  // Exclusive creation fixes permissions before SQLite first sees the file.
  try {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    fs.closeSync(fd)
  } catch (cause) {
    if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST')) throw cause
  }
  needsVersionMarker = inspectVersion(file) === 0
  db = new DatabaseSync(file)
  db.exec(`
    PRAGMA trusted_schema = OFF;
    PRAGMA busy_timeout = 50;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA secure_delete = ON;
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA max_page_count = ${Math.floor(limits.maxFileBytes / 4096)};
    CREATE TABLE IF NOT EXISTS journal_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lineage_digest TEXT NOT NULL,
      epoch TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      dropped INTEGER NOT NULL,
      rejected INTEGER NOT NULL,
      pruned INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_records (
      sequence INTEGER PRIMARY KEY,
      received_at INTEGER NOT NULL,
      record TEXT NOT NULL,
      browser_key TEXT UNIQUE
    );
  `)
  const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
  if (pageSize !== 4096 || fs.statSync(file).size > limits.maxFileBytes) throw new Error()
  const metadata = db.prepare('SELECT * FROM journal_metadata WHERE id = 1').get() as
    | Record<string, unknown>
    | undefined
  lineageDigest = request.lineageDigest
  epoch = request.epoch
  if (metadata) {
    if (
      !/^[a-f0-9]{64}$/.test(String(metadata.lineage_digest)) ||
      !/^[a-f0-9]{32}$/.test(String(metadata.epoch)) ||
      !['last_sequence', 'dropped', 'rejected', 'pruned'].every((key) => validCounter(metadata[key]))
    )
      throw new Error()
    if (metadata.lineage_digest === lineageDigest) {
      epoch = String(metadata.epoch)
      lastSequence = Number(metadata.last_sequence)
      counters = {
        dropped: Number(metadata.dropped),
        rejected: Number(metadata.rejected),
        pruned: Number(metadata.pruned),
      }
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!metadata || metadata.lineage_digest !== lineageDigest) {
      db.exec('DELETE FROM journal_records; DELETE FROM journal_metadata')
      db.prepare('INSERT INTO journal_metadata VALUES (1, ?, ?, 0, 0, 0, 0)').run(lineageDigest, epoch)
    }
    counters.rejected = add(
      counters.rejected,
      Number(
        db
          .prepare(
            `DELETE FROM journal_records WHERE sequence < 1 OR sequence > ?
             OR typeof(received_at) != 'integer' OR received_at < 0 OR received_at > 8640000000000000
             OR typeof(record) != 'text' OR length(CAST(record AS BLOB)) > ? OR length(record) = 0`,
          )
          .run(MAX_INTEGER, limits.maxRecordBytes).changes,
      ),
    )
    const maximum = db.prepare('SELECT max(sequence) AS value FROM journal_records').get() as { value: number | null }
    if ((maximum.value ?? 0) > lastSequence) throw new Error()
    prune(request.now)
    writeMetadata()
    db.exec('COMMIT')
  } catch (cause) {
    db.exec('ROLLBACK')
    throw cause
  }
}

function browserKey(record: PendingDiagnosticRecord): string | null {
  return record.provenance.kind === 'browser' ? `${record.provenance.sourceId}:${record.provenance.eventId}` : null
}

function append(records: PendingDiagnosticRecord[], now: number): StoredDiagnosticRow[] {
  if (records.length > 32) throw new Error()
  const additions: StoredDiagnosticRow[] = []
  const candidates = allMetadata()
  const batchKeys = new Set<string>()
  const contains = db!.prepare('SELECT 1 FROM journal_records WHERE browser_key = ? AND received_at >= ?')
  for (const record of records) {
    const key = browserKey(record)
    if (key && (batchKeys.has(key) || contains.get(key, now - limits.maxAgeMs))) continue
    if (lastSequence >= MAX_INTEGER) {
      counters.dropped = add(counters.dropped, 1)
      continue
    }
    const sequence = lastSequence + 1
    const json = JSON.stringify({ sequence, ...record })
    const bytes = Buffer.byteLength(json)
    if (bytes > limits.maxRecordBytes || bytes > limits.maxBytes) {
      counters.rejected = add(counters.rejected, 1)
      continue
    }
    lastSequence = sequence
    if (key) batchKeys.add(key)
    additions.push({ sequence, receivedAt: record.receivedAt, browserKey: key, json })
    candidates.push({ sequence, receivedAt: record.receivedAt, bytes })
  }
  const retained = retain(candidates, now)
  const retainedSet = new Set(retained)
  counters.pruned = add(counters.pruned, deleteExcept(retained))
  const insert = db!.prepare(
    'INSERT INTO journal_records (sequence, received_at, record, browser_key) VALUES (?, ?, ?, ?)',
  )
  for (const row of additions) {
    if (retainedSet.has(row.sequence)) insert.run(row.sequence, row.receivedAt, row.json, row.browserKey)
    else counters.pruned = add(counters.pruned, 1)
  }
  return additions.filter((row) => retainedSet.has(row.sequence))
}

port.on('message', (request: DiagnosticsJournalRequest) => {
  try {
    if (request.kind === 'initialize') {
      if (db) throw new Error()
      initialize(request)
      const response: DiagnosticsJournalResponse = {
        id: request.id,
        kind: 'snapshot',
        epoch,
        lastSequence,
        counters,
        entries: readRows(),
        retainedSequences: allMetadata().map((row) => row.sequence),
      }
      port.postMessage(response)
      return
    }
    if (!db) throw new Error()
    if (request.kind !== 'reset' && request.epoch !== epoch) throw new Error()
    let entries: StoredDiagnosticRow[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      if (request.kind === 'reset') {
        db.exec('DELETE FROM journal_records')
        lineageDigest = request.lineageDigest
        epoch = request.epoch
        lastSequence = 0
        counters = { dropped: 0, rejected: 0, pruned: 0 }
      } else {
        counters.dropped = add(counters.dropped, request.loss.dropped)
        counters.rejected = add(counters.rejected, request.loss.rejected)
        if (request.kind === 'append') entries = append(request.records, request.now)
        else if (request.kind === 'purge') {
          if (request.sequences.length > limits.maxEvents) throw new Error()
          const remove = db.prepare('DELETE FROM journal_records WHERE sequence = ?')
          for (const sequence of request.sequences)
            counters.rejected = add(counters.rejected, Number(remove.run(sequence).changes))
          if (needsVersionMarker) {
            db.exec(`PRAGMA user_version = ${JOURNAL_VERSION}`)
            needsVersionMarker = false
          }
        }
        prune(request.now)
      }
      writeMetadata()
      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      throw cause
    }
    const response: DiagnosticsJournalResponse = {
      id: request.id,
      kind: request.kind === 'close' ? 'closed' : 'changed',
      epoch,
      lastSequence,
      counters,
      entries,
      retainedSequences: allMetadata().map((row) => row.sequence),
    }
    if (request.kind === 'close') {
      db.close()
      db = undefined
    }
    port.postMessage(response)
    if (request.kind === 'close') port.close()
  } catch {
    // No native error, path, serialized input, or SQLite diagnostic leaves this worker.
    port.postMessage({ id: request.id, kind: 'failed' } satisfies DiagnosticsJournalResponse)
    try {
      db?.close()
    } catch {
      /* best effort; the owner also terminates failed workers */
    }
    db = undefined
    port.close()
  }
})
