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
  DiagnosticsJournalWorkerFailure,
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
let retained = new Map<number, RowMetadata>()
let retainedBytes = 0
let expiries: Expiry[] = []

interface RowMetadata {
  sequence: number
  receivedAt: number
  bytes: number
}

interface Expiry {
  sequence: number
  expiresAt: number
}

class JournalWorkerError extends Error {
  readonly failure: DiagnosticsJournalWorkerFailure

  constructor(failure: DiagnosticsJournalWorkerFailure) {
    super(failure)
    this.failure = failure
  }
}

function invalidStorage(): never {
  throw new JournalWorkerError('invalid-storage')
}

function invalidRequest(): never {
  throw new JournalWorkerError('invalid-request')
}

function failureOf(cause: unknown): DiagnosticsJournalWorkerFailure {
  if (cause instanceof JournalWorkerError) return cause.failure
  const sqliteCode =
    cause && typeof cause === 'object' && 'errcode' in cause && typeof cause.errcode === 'number'
      ? cause.errcode
      : undefined
  if (sqliteCode === 5 || sqliteCode === 6) return 'storage-busy'
  if (sqliteCode === 13) return 'storage-full'
  if (sqliteCode === 11 || sqliteCode === 26) return 'invalid-storage'
  if (sqliteCode === 8 || sqliteCode === 10 || sqliteCode === 14) return 'storage-io'
  const code =
    cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
  if (code && ['SQLITE_BUSY', 'SQLITE_LOCKED'].some((prefix) => code.startsWith(prefix))) return 'storage-busy'
  if (code && (['ENOSPC', 'EDQUOT'].includes(code) || code.startsWith('SQLITE_FULL'))) return 'storage-full'
  if (
    code &&
    (['EACCES', 'EPERM', 'EROFS', 'EIO'].includes(code) ||
      ['SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_READONLY'].some((prefix) => code.startsWith(prefix)))
  )
    return 'storage-io'
  return 'worker-failed'
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
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum || (info.mode & 0o077) !== 0) invalidStorage()
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

function retain(rows: RowMetadata[], now: number): RowMetadata[] {
  const chronological = rows
    .filter((row) => row.receivedAt >= now - limits.maxAgeMs && row.bytes <= limits.maxRecordBytes)
    .sort((left, right) => left.sequence - right.sequence)
  let bytes = chronological.reduce((sum, row) => sum + row.bytes, 0)
  let start = 0
  while (chronological.length - start > limits.maxEvents || bytes > limits.maxBytes) {
    bytes -= chronological[start++].bytes
  }
  return chronological.slice(start)
}

function earlierRows(sequence: number): number {
  return Number(db!.prepare('DELETE FROM journal_records WHERE sequence < ?').run(sequence).changes)
}

function deleteSequences(sequences: readonly number[]): number {
  if (!sequences.length) return 0
  const remove = db!.prepare('DELETE FROM journal_records WHERE sequence = ?')
  let changes = 0
  for (const sequence of sequences) changes += Number(remove.run(sequence).changes)
  return changes
}

function less(left: Expiry, right: Expiry): boolean {
  return left.expiresAt < right.expiresAt || (left.expiresAt === right.expiresAt && left.sequence < right.sequence)
}

function pushExpiry(value: Expiry): void {
  expiries.push(value)
  let index = expiries.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (!less(expiries[index], expiries[parent])) break
    ;[expiries[index], expiries[parent]] = [expiries[parent], expiries[index]]
    index = parent
  }
}

function popExpiry(): Expiry | undefined {
  const first = expiries[0]
  const last = expiries.pop()
  if (!first || !last || expiries.length === 0) return first
  expiries[0] = last
  let index = 0
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index
    if (left < expiries.length && less(expiries[left], expiries[smallest])) smallest = left
    if (right < expiries.length && less(expiries[right], expiries[smallest])) smallest = right
    if (smallest === index) return first
    ;[expiries[index], expiries[smallest]] = [expiries[smallest], expiries[index]]
    index = smallest
  }
}

function remember(row: RowMetadata): void {
  retained.set(row.sequence, row)
  retainedBytes += row.bytes
  pushExpiry({ sequence: row.sequence, expiresAt: row.receivedAt + limits.maxAgeMs + 1 })
}

function forget(sequence: number): boolean {
  const row = retained.get(sequence)
  if (!row) return false
  retained.delete(sequence)
  retainedBytes -= row.bytes
  return true
}

function retentionVictims(now: number): number[] {
  const victims: number[] = []
  while (expiries[0] && expiries[0].expiresAt <= now) {
    const expired = popExpiry()!
    if (forget(expired.sequence)) victims.push(expired.sequence)
  }
  while (retained.size > limits.maxEvents || retainedBytes > limits.maxBytes) {
    const oldest = retained.keys().next().value as number | undefined
    if (oldest === undefined) break
    forget(oldest)
    victims.push(oldest)
  }
  return victims
}

function initializeRetention(now: number): void {
  const scanned = allMetadata()
  const keep = retain(scanned, now)
  const keepSet = new Set(keep.map((row) => row.sequence))
  const victims = scanned.filter((row) => !keepSet.has(row.sequence)).map((row) => row.sequence)
  let removed = deleteSequences(victims)
  const oldestScanned = scanned.at(-1)?.sequence
  if (oldestScanned !== undefined) removed += earlierRows(oldestScanned)
  counters.pruned = add(counters.pruned, removed)
  retained = new Map()
  retainedBytes = 0
  expiries = []
  for (const row of keep) remember(row)
}

function prune(now: number): number[] {
  const victims = retentionVictims(now)
  counters.pruned = add(counters.pruned, deleteSequences(victims))
  return victims
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
    if (version !== 0 && version !== JOURNAL_VERSION) invalidStorage()
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
      invalidStorage()
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
        invalidStorage()
    }
    const indexes = probe.prepare('PRAGMA index_list(journal_records)').all() as {
      name: string
      unique: number
      origin: string
      partial: number
    }[]
    if (indexes.length !== 1 || indexes[0].unique !== 1 || indexes[0].origin !== 'u' || indexes[0].partial !== 0)
      invalidStorage()
    const indexed = probe.prepare('PRAGMA index_info(sqlite_autoindex_journal_records_1)').all() as { name: string }[]
    if (indexed.length !== 1 || indexed[0].name !== 'browser_key') invalidStorage()
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
    limits.maxAgeMs > 86_400_000 ||
    limits.initializationTimeoutMs < 10 ||
    limits.initializationTimeoutMs > 30_000 ||
    limits.requestTimeoutMs < 10 ||
    limits.requestTimeoutMs > 5_000 ||
    limits.maintenanceTimeoutMs < 10 ||
    limits.maintenanceTimeoutMs > 15_000 ||
    limits.closeTimeoutMs < 10 ||
    limits.closeTimeoutMs > 1_000
  )
    invalidRequest()
  fs.mkdirSync(request.directory, { recursive: true, mode: 0o700 })
  const directoryInfo = fs.lstatSync(request.directory)
  if (
    !directoryInfo.isDirectory() ||
    (directoryInfo.mode & 0o077) !== 0 ||
    fs.realpathSync(request.directory) !== request.directory
  )
    invalidStorage()
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
  if (pageSize !== 4096 || fs.statSync(file).size > limits.maxFileBytes) invalidStorage()
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
      invalidStorage()
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
    if ((maximum.value ?? 0) > lastSequence) invalidStorage()
    initializeRetention(request.now)
    writeMetadata()
    db.exec('COMMIT')
  } catch (cause) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* SQLite may already have rolled back; preserve the classified cause. */
    }
    throw cause
  }
}

function browserKey(record: PendingDiagnosticRecord): string | null {
  return record.provenance.kind === 'browser' ? `${record.provenance.sourceId}:${record.provenance.eventId}` : null
}

function append(
  records: PendingDiagnosticRecord[],
  now: number,
): { entries: StoredDiagnosticRow[]; removedSequences: number[] } {
  if (records.length > 32) invalidRequest()
  const additions: StoredDiagnosticRow[] = []
  const batchKeys = new Set<string>()
  const contains = db!.prepare('SELECT 1 FROM journal_records WHERE browser_key = ? AND received_at >= ?')
  const expired = retentionVictims(now)
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
    const row = { sequence, receivedAt: record.receivedAt, browserKey: key, json }
    additions.push(row)
    remember({ sequence, receivedAt: record.receivedAt, bytes })
  }
  const victims = [...expired, ...retentionVictims(now)]
  const existingVictims = victims.filter((sequence) => !additions.some((row) => row.sequence === sequence))
  counters.pruned = add(counters.pruned, deleteSequences(existingVictims))
  const insert = db!.prepare(
    'INSERT INTO journal_records (sequence, received_at, record, browser_key) VALUES (?, ?, ?, ?)',
  )
  for (const row of additions) {
    if (retained.has(row.sequence)) insert.run(row.sequence, row.receivedAt, row.json, row.browserKey)
    else counters.pruned = add(counters.pruned, 1)
  }
  return {
    entries: additions.filter((row) => retained.has(row.sequence)),
    removedSequences: existingVictims,
  }
}

port.on('message', (request: DiagnosticsJournalRequest) => {
  try {
    if (request.kind === 'initialize') {
      if (db) invalidRequest()
      initialize(request)
      const entries = readRows()
      const response: DiagnosticsJournalResponse = {
        id: request.id,
        kind: 'snapshot',
        epoch,
        lastSequence,
        counters,
        entries,
        retainedSequences: entries.map((row) => row.sequence),
      }
      port.postMessage(response)
      return
    }
    if (!db) invalidRequest()
    if (request.kind !== 'reset' && request.epoch !== epoch) invalidRequest()
    let entries: StoredDiagnosticRow[] = []
    let removedSequences: number[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      if (request.kind === 'reset') {
        db.exec('DELETE FROM journal_records')
        lineageDigest = request.lineageDigest
        epoch = request.epoch
        lastSequence = 0
        counters = { dropped: 0, rejected: 0, pruned: 0 }
        retained = new Map()
        retainedBytes = 0
        expiries = []
      } else {
        counters.dropped = add(counters.dropped, request.loss.dropped)
        counters.rejected = add(counters.rejected, request.loss.rejected)
        if (request.kind === 'append') {
          const result = append(request.records, request.now)
          entries = result.entries
          removedSequences = result.removedSequences
        } else if (request.kind === 'purge') {
          if (request.sequences.length > limits.maxEvents) invalidRequest()
          const remove = db.prepare('DELETE FROM journal_records WHERE sequence = ?')
          for (const sequence of request.sequences) {
            forget(sequence)
            counters.rejected = add(counters.rejected, Number(remove.run(sequence).changes))
          }
          removedSequences = [...request.sequences, ...prune(request.now)]
          if (needsVersionMarker) {
            db.exec(`PRAGMA user_version = ${JOURNAL_VERSION}`)
            needsVersionMarker = false
          }
        } else removedSequences = prune(request.now)
      }
      writeMetadata()
      db.exec('COMMIT')
    } catch (cause) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* SQLite may already have rolled back; preserve the classified cause. */
      }
      throw cause
    }
    const response: DiagnosticsJournalResponse = {
      id: request.id,
      kind: request.kind === 'close' ? 'closed' : 'changed',
      epoch,
      lastSequence,
      counters,
      entries,
      removedSequences,
    }
    if (request.kind === 'close') {
      db.close()
      db = undefined
    }
    port.postMessage(response)
    if (request.kind === 'close') port.close()
  } catch (cause) {
    // No native error, path, serialized input, or SQLite diagnostic leaves this worker.
    port.postMessage({ id: request.id, kind: 'failed', failure: failureOf(cause) } satisfies DiagnosticsJournalResponse)
    try {
      db?.close()
    } catch {
      /* best effort; the owner also terminates failed workers */
    }
    db = undefined
    port.close()
  }
})
