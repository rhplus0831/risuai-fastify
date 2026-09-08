import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  isDiagnosticEventV2,
  projectDiagnosticJournalRecord,
  type DiagnosticEventV2,
  type DiagnosticJournalRecord,
} from '@risuai/protocol/remote-diagnostics'
import {
  DIAGNOSTICS_JOURNAL_HARD_LIMITS,
  type DiagnosticsJournalCounters,
  type DiagnosticsJournalLimits,
  type DiagnosticsJournalRequest,
  type DiagnosticsJournalResponse,
  type PendingDiagnosticRecord,
  type StoredDiagnosticRow,
} from './diagnosticsJournalProtocol.js'

export { DIAGNOSTICS_JOURNAL_HARD_LIMITS, DIAGNOSTICS_JOURNAL_VERSION } from './diagnosticsJournalProtocol.js'

export interface DiagnosticsJournalOptions {
  directory: string
  lineage: string
  instanceId: string
  enabled: boolean
  now?: () => number
  /** Tests/operators may lower a bound, never disable or raise a hard limit. */
  limits?: Partial<DiagnosticsJournalLimits>
}

export interface DiagnosticsJournalRead {
  entries: DiagnosticJournalRecord[]
  epoch: string
  source: 'journal' | 'unavailable'
  dropped: number
  rejected: number
  pruned: number
  pending: number
}

export interface DiagnosticsJournal {
  readonly enabled: boolean
  readonly ready: Promise<void>
  record(entry: DiagnosticEventV2, provenance?: DiagnosticJournalRecord['provenance']): boolean
  hasBrowserEvent(sourceId: string, eventId: string): boolean
  read(): DiagnosticsJournalRead
  reset(lineage: string): void
  close(): Promise<void>
}

interface ActiveRequest {
  request: DiagnosticsJournalRequest
  generation: number
  timer: ReturnType<typeof setTimeout>
}

type JournalCommand = {
  [Kind in DiagnosticsJournalRequest['kind']]: Omit<
    Extract<DiagnosticsJournalRequest, { kind: Kind }>,
    'id' | 'epoch' | 'now' | 'loss'
  >
}[DiagnosticsJournalRequest['kind']]

const MAX_COUNTER = Number.MAX_SAFE_INTEGER
const add = (left: number, right: number) => Math.min(MAX_COUNTER, left + right)
const newEpoch = () => randomBytes(16).toString('hex')
const emptyCounters = (): DiagnosticsJournalCounters => ({ dropped: 0, rejected: 0, pruned: 0 })
const keyOf = (record: Pick<DiagnosticJournalRecord, 'provenance'>): string | undefined =>
  record.provenance.kind === 'browser' ? `${record.provenance.sourceId}:${record.provenance.eventId}` : undefined

function boundedInteger(value: unknown, minimum = 0, maximum = MAX_COUNTER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function digestLineage(lineage: string): string {
  if (typeof lineage !== 'string' || lineage.length < 1 || lineage.length > 256) throw new Error()
  return createHash('sha256').update(lineage).digest('hex')
}

function resolveLimits(input: DiagnosticsJournalOptions['limits']): DiagnosticsJournalLimits {
  if (input && Object.keys(input).some((key) => !Object.hasOwn(DIAGNOSTICS_JOURNAL_HARD_LIMITS, key))) throw new Error()
  const limits = { ...DIAGNOSTICS_JOURNAL_HARD_LIMITS, ...input }
  for (const [key, maximum] of Object.entries(DIAGNOSTICS_JOURNAL_HARD_LIMITS)) {
    const value = limits[key as keyof DiagnosticsJournalLimits]
    const minimum = key === 'maxFileBytes' ? 64 * 1024 : key === 'requestTimeoutMs' ? 10 : 1
    if (!boundedInteger(value, minimum, maximum)) throw new Error()
  }
  return limits
}

/** Operational telemetry: record/read/reset never wait for filesystem work. */
export function createDiagnosticsJournal(options: DiagnosticsJournalOptions): DiagnosticsJournal {
  const enabled = options.enabled === true
  let limits: DiagnosticsJournalLimits = { ...DIAGNOSTICS_JOURNAL_HARD_LIMITS }
  let lineageDigest = ''
  let epoch = newEpoch()
  let generation = 0
  let nextRequestId = 0
  let worker: Worker | undefined
  let active: ActiveRequest | undefined
  let terminal = !enabled
  let initialized = false
  let resetPending = false
  let maintenancePending = false
  let restoring: DiagnosticJournalRecord[] | undefined
  let purgePending: number[] = []
  let entries: DiagnosticJournalRecord[] = []
  let queue: PendingDiagnosticRecord[] = []
  let dedup = new Set<string>()
  let nextExpiry = Number.POSITIVE_INFINITY
  const locallyPruned = new Set<number>()
  let diskCounters = emptyCounters()
  let pendingLoss = { dropped: 0, rejected: 0 }
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let closing: Promise<void> | undefined
  let settleClose: (() => void) | undefined
  let gracefulClose = false
  let settleReady!: () => void
  const ready = new Promise<void>((resolve) => (settleReady = resolve))

  function now(): number {
    try {
      const value = options.now?.() ?? Date.now()
      if (boundedInteger(value, 0, 8_640_000_000_000_000)) return value
    } catch {
      /* Telemetry clocks cannot throw into callers. */
    }
    return Date.now()
  }

  function rebuildDedup(): void {
    dedup = new Set<string>()
    nextExpiry = entries.reduce(
      (minimum, record) => Math.min(minimum, record.receivedAt + limits.maxAgeMs + 1),
      Number.POSITIVE_INFINITY,
    )
    const pending = active?.generation === generation && active.request.kind === 'append' ? active.request.records : []
    for (const record of [...entries, ...queue, ...pending]) {
      const key = keyOf(record)
      if (key) dedup.add(key)
    }
  }

  function pruneMemory(): void {
    const cutoff = now() - limits.maxAgeMs
    const retained = entries.filter((record) => {
      if (record.receivedAt >= cutoff) return true
      locallyPruned.add(record.sequence)
      return false
    })
    if (retained.length !== entries.length) {
      entries = retained
      maintenancePending = true
      rebuildDedup()
    }
  }

  function finishClose(): void {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = undefined
    settleReady()
    settleClose?.()
  }

  function fail(): void {
    if (terminal) {
      finishClose()
      return
    }
    terminal = true
    initialized = false
    const inflight =
      active?.generation === generation && active.request.kind === 'append' ? active.request.records.length : 0
    if (active?.generation === generation) {
      pendingLoss.dropped = add(pendingLoss.dropped, active.request.loss.dropped)
      pendingLoss.rejected = add(pendingLoss.rejected, active.request.loss.rejected)
    }
    pendingLoss.dropped = add(pendingLoss.dropped, queue.length + inflight)
    if (active) clearTimeout(active.timer)
    active = undefined
    queue = []
    entries = []
    restoring = undefined
    dedup.clear()
    if (maintenanceTimer) clearInterval(maintenanceTimer)
    // A stalled telemetry worker must never hold application shutdown open.
    // Worker termination is best effort: callers still receive a finite close.
    worker?.unref()
    void worker?.terminate().catch(() => undefined)
    settleReady()
    finishClose()
  }

  function validResponse(response: Exclude<DiagnosticsJournalResponse, { kind: 'failed' }>): boolean {
    return (
      /^[a-f0-9]{32}$/.test(response.epoch) &&
      boundedInteger(response.lastSequence) &&
      response.counters &&
      ['dropped', 'rejected', 'pruned'].every((key) =>
        boundedInteger(response.counters[key as keyof DiagnosticsJournalCounters]),
      ) &&
      Array.isArray(response.entries) &&
      response.entries.length <= limits.maxEvents &&
      Array.isArray(response.retainedSequences) &&
      response.retainedSequences.length <= limits.maxEvents &&
      response.retainedSequences.every((sequence) => boundedInteger(sequence, 1, response.lastSequence)) &&
      new Set(response.retainedSequences).size === response.retainedSequences.length
    )
  }

  function restoreRows(rows: StoredDiagnosticRow[]): { valid: DiagnosticJournalRecord[]; invalid: number[] } {
    const valid: DiagnosticJournalRecord[] = []
    const invalid: number[] = []
    const keys = new Set<string>()
    let bytes = 0
    for (const row of rows) {
      let record: DiagnosticJournalRecord | null = null
      try {
        if (typeof row.json === 'string' && Buffer.byteLength(row.json) <= limits.maxRecordBytes) {
          record = projectDiagnosticJournalRecord(JSON.parse(row.json))
        }
        const key = record ? keyOf(record) : undefined
        if (
          !record ||
          record.sequence !== row.sequence ||
          record.receivedAt !== row.receivedAt ||
          (key ?? null) !== row.browserKey ||
          (key !== undefined && keys.has(key)) ||
          bytes + Buffer.byteLength(row.json!) > limits.maxBytes
        )
          record = null
        else {
          bytes += Buffer.byteLength(row.json!)
          if (key) keys.add(key)
        }
      } catch {
        record = null
      }
      if (record) valid.push(record)
      else if (boundedInteger(row.sequence, 1)) invalid.push(row.sequence)
    }
    return { valid, invalid }
  }

  function send(request: JournalCommand): void {
    if (!worker || terminal || active) return
    const loss = request.kind === 'initialize' || request.kind === 'reset' ? { dropped: 0, rejected: 0 } : pendingLoss
    if (request.kind !== 'initialize' && request.kind !== 'reset') pendingLoss = { dropped: 0, rejected: 0 }
    const outgoing = { ...request, id: ++nextRequestId, epoch, now: now(), loss } as DiagnosticsJournalRequest
    active = { request: outgoing, generation, timer: setTimeout(fail, limits.requestTimeoutMs) }
    // Keep an awaited startup/flush alive only until this finite deadline. The
    // idle worker and maintenance interval remain unreferenced.
    try {
      worker.postMessage(outgoing)
    } catch {
      fail()
    }
  }

  function pump(): void {
    if (terminal || !worker || active) return
    if (resetPending) {
      resetPending = false
      send({ kind: 'reset', lineageDigest })
      return
    }
    if (purgePending.length || restoring !== undefined) {
      const sequences = purgePending
      purgePending = []
      send({ kind: 'purge', sequences })
      return
    }
    if (!initialized) return
    if (queue.length) {
      const records = queue.splice(0, 32)
      send({ kind: 'append', records })
      return
    }
    if (maintenancePending || pendingLoss.dropped || pendingLoss.rejected) {
      maintenancePending = false
      send({ kind: 'prune' })
      return
    }
    if (closing) send({ kind: 'close' })
  }

  function receive(response: DiagnosticsJournalResponse): void {
    const completed = active
    if (!completed || response.id !== completed.request.id || terminal) return
    if (response.kind === 'failed') {
      fail()
      return
    }
    clearTimeout(completed.timer)
    active = undefined
    if (completed.generation !== generation) {
      pump()
      return
    }
    if (!validResponse(response)) {
      fail()
      return
    }
    diskCounters = { ...response.counters }
    const retained = new Set(response.retainedSequences)
    for (const sequence of locallyPruned) if (!retained.has(sequence)) locallyPruned.delete(sequence)
    if (completed.request.kind === 'initialize') epoch = response.epoch
    else if (response.epoch !== epoch) {
      fail()
      return
    }
    const restored = restoreRows(response.entries)
    if (restored.invalid.length) purgePending.push(...restored.invalid)
    if (completed.request.kind === 'initialize') {
      // Confirm exact restoration even when no row needs removal; the worker
      // stamps a legacy unversioned store only after this trusted boundary.
      restoring = restored.valid
    } else if (completed.request.kind === 'purge' && restoring) {
      entries = restoring.filter((record) => retained.has(record.sequence))
      restoring = undefined
      initialized = true
      settleReady()
    } else if (completed.request.kind === 'reset') {
      entries = []
      initialized = true
      settleReady()
    } else {
      entries = [...entries.filter((record) => retained.has(record.sequence)), ...restored.valid]
        .filter((record) => !locallyPruned.has(record.sequence))
        .sort((left, right) => left.sequence - right.sequence)
    }
    rebuildDedup()
    pruneMemory()
    if (response.kind === 'closed') {
      gracefulClose = true
      initialized = false
      if (maintenanceTimer) clearInterval(maintenanceTimer)
      return
    }
    pump()
  }

  try {
    if (enabled) {
      limits = resolveLimits(options.limits)
      lineageDigest = digestLineage(options.lineage)
      if (
        typeof options.directory !== 'string' ||
        options.directory.length > 4096 ||
        !path.isAbsolute(options.directory) ||
        path.normalize(options.directory) !== options.directory ||
        !/^[a-f0-9]{32}$/.test(options.instanceId)
      )
        throw new Error()
      worker = new Worker(new URL('./diagnosticsJournalWorker.ts', import.meta.url), {
        execArgv: [],
        stdout: true,
        stderr: true,
      })
      // Node runtime warnings and native error text are never app/support logs.
      worker.stdout?.on('data', () => undefined)
      worker.stderr?.on('data', () => undefined)
      worker.on('message', receive)
      worker.on('error', fail)
      worker.on('exit', () => {
        if (!gracefulClose && !terminal) fail()
        finishClose()
      })
      worker.unref()
      send({ kind: 'initialize', directory: options.directory, lineageDigest, limits })
      maintenanceTimer = setInterval(
        () => {
          pruneMemory()
          maintenancePending = true
          pump()
        },
        Math.min(limits.maxAgeMs, 60_000),
      )
      maintenanceTimer.unref()
    } else settleReady()
  } catch {
    fail()
  }

  return {
    enabled,
    ready,
    hasBrowserEvent(sourceId, eventId) {
      if (!enabled || terminal || closing || !/^[a-f0-9]{32}$/.test(sourceId) || !/^[a-f0-9]{32}$/.test(eventId))
        return false
      if (now() >= nextExpiry) pruneMemory()
      return dedup.has(`${sourceId}:${eventId}`)
    },
    record(entry, provenance = { kind: 'server' }) {
      if (!enabled || closing || terminal) {
        if (enabled && terminal && !closing) pendingLoss.dropped = add(pendingLoss.dropped, 1)
        return false
      }
      try {
        if (now() >= nextExpiry) pruneMemory()
        if (!isDiagnosticEventV2(entry)) {
          pendingLoss.rejected = add(pendingLoss.rejected, 1)
          pump()
          return false
        }
        const validated = projectDiagnosticJournalRecord({
          sequence: MAX_COUNTER,
          receivedAt: now(),
          instanceId: options.instanceId,
          provenance,
          entry,
        })
        if (
          !validated ||
          Buffer.byteLength(JSON.stringify(validated)) > Math.min(limits.maxRecordBytes, limits.maxBytes)
        ) {
          pendingLoss.rejected = add(pendingLoss.rejected, 1)
          pump()
          return false
        }
        const key = keyOf(validated)
        if (key && dedup.has(key)) return false
        const inflight =
          active?.generation === generation && active.request.kind === 'append' ? active.request.records.length : 0
        if (queue.length + inflight >= limits.maxQueue) {
          pendingLoss.dropped = add(pendingLoss.dropped, 1)
          pump()
          return false
        }
        const { sequence: _sequence, ...pending } = validated
        queue.push(pending)
        if (key) dedup.add(key)
        pump()
        return true
      } catch {
        pendingLoss.rejected = add(pendingLoss.rejected, 1)
        pump()
        return false
      }
    },
    read() {
      pruneMemory()
      const visible =
        initialized && !terminal
          ? entries
              .map((record) => projectDiagnosticJournalRecord(record))
              .filter((record): record is DiagnosticJournalRecord => record !== null)
          : []
      const inflight = active?.generation === generation ? active.request.loss : { dropped: 0, rejected: 0 }
      const result: DiagnosticsJournalRead = {
        entries: visible,
        epoch,
        source: initialized && !terminal ? 'journal' : 'unavailable',
        dropped: add(diskCounters.dropped, add(pendingLoss.dropped, inflight.dropped)),
        rejected: add(diskCounters.rejected, add(pendingLoss.rejected, inflight.rejected)),
        pruned: add(diskCounters.pruned, locallyPruned.size),
        pending:
          queue.length +
          (active?.generation === generation && active.request.kind === 'append' ? active.request.records.length : 0),
      }
      pump()
      return result
    },
    reset(lineage) {
      if (!enabled || closing) return
      generation += 1
      epoch = newEpoch()
      entries = []
      queue = []
      restoring = undefined
      purgePending = []
      locallyPruned.clear()
      dedup.clear()
      nextExpiry = Number.POSITIVE_INFINITY
      diskCounters = emptyCounters()
      pendingLoss = { dropped: 0, rejected: 0 }
      initialized = false
      try {
        lineageDigest = digestLineage(lineage)
      } catch {
        fail()
        return
      }
      resetPending = true
      pump()
    },
    close() {
      if (!closing) {
        closing = new Promise<void>((resolve) => (settleClose = resolve))
        if (maintenanceTimer) clearInterval(maintenanceTimer)
        if (terminal || !enabled) finishClose()
        else {
          closeTimer = setTimeout(() => {
            fail()
            finishClose()
          }, limits.requestTimeoutMs)
          pump()
        }
      }
      return closing
    },
  }
}
