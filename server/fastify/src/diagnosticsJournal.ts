import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  isDiagnosticEventV2,
  projectRemoteDiagnosticRecordV3,
  type DiagnosticEventV2,
  type RemoteDiagnosticFact,
  type RemoteDiagnosticRecordV3,
} from '@risuai/protocol/remote-diagnostics'
import {
  DIAGNOSTICS_JOURNAL_HARD_LIMITS,
  type DiagnosticsJournalCounters,
  type DiagnosticsJournalLimits,
  type DiagnosticsJournalRequest,
  type DiagnosticsJournalResponse,
  type DiagnosticsJournalWorkerFailure,
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
  /** Tests may shorten or disable the bounded automatic-recovery schedule. */
  recoveryDelaysMs?: readonly number[]
  onStateChange?: (event: DiagnosticsJournalStateChange) => void
}

export type DiagnosticsJournalFailure =
  | DiagnosticsJournalWorkerFailure
  | 'worker-start'
  | 'worker-error'
  | 'worker-exit'
  | 'request-timeout'
  | 'invalid-response'

export type DiagnosticsJournalStateChange =
  | {
      state: 'unavailable'
      failure: DiagnosticsJournalFailure
      operation: DiagnosticsJournalRequest['kind']
      recoveryAttempt: number
      retryInMs: number | null
    }
  | { state: 'recovered'; recoveryAttempt: number }

export interface DiagnosticsJournalRead {
  entries: RemoteDiagnosticRecordV3[]
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
  available(): boolean
  record(
    entry: DiagnosticEventV2,
    provenance?: RemoteDiagnosticRecordV3['provenance'],
    facts?: readonly RemoteDiagnosticFact[],
  ): boolean
  hasBrowserEvent(sourceId: string, eventId: string): boolean
  read(): DiagnosticsJournalRead
  reset(lineage: string): void
  close(): Promise<void>
}

interface ActiveRequest {
  request: DiagnosticsJournalRequest
  generation: number
  worker: Worker
  timer: ReturnType<typeof setTimeout>
}

type JournalCommand = {
  [Kind in DiagnosticsJournalRequest['kind']]: Omit<
    Extract<DiagnosticsJournalRequest, { kind: Kind }>,
    'id' | 'epoch' | 'now' | 'loss'
  >
}[DiagnosticsJournalRequest['kind']]

const MAX_COUNTER = Number.MAX_SAFE_INTEGER
const DEFAULT_RECOVERY_DELAYS_MS = Object.freeze([250, 1000, 5000])
const add = (left: number, right: number) => Math.min(MAX_COUNTER, left + right)
const newEpoch = () => randomBytes(16).toString('hex')
const emptyCounters = (): DiagnosticsJournalCounters => ({ dropped: 0, rejected: 0, pruned: 0 })
const keyOf = (record: Pick<RemoteDiagnosticRecordV3, 'provenance'>): string | undefined =>
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
    const minimum = key === 'maxFileBytes' ? 64 * 1024 : key.endsWith('TimeoutMs') ? 10 : 1
    if (!boundedInteger(value, minimum, maximum)) throw new Error()
  }
  return limits
}

function resolveRecoveryDelays(input: DiagnosticsJournalOptions['recoveryDelaysMs']): readonly number[] {
  const delays = input ?? DEFAULT_RECOVERY_DELAYS_MS
  if (delays.length > DEFAULT_RECOVERY_DELAYS_MS.length || delays.some((value) => !boundedInteger(value, 0, 60_000))) {
    throw new Error()
  }
  return [...delays]
}

/** Operational telemetry: record/read/reset never wait for filesystem work. */
export function createDiagnosticsJournal(options: DiagnosticsJournalOptions): DiagnosticsJournal {
  const enabled = options.enabled === true
  let limits: DiagnosticsJournalLimits = { ...DIAGNOSTICS_JOURNAL_HARD_LIMITS }
  let recoveryDelays: readonly number[] = DEFAULT_RECOVERY_DELAYS_MS
  let lineageDigest = ''
  let epoch = newEpoch()
  let generation = 0
  let nextRequestId = 0
  let worker: Worker | undefined
  let active: ActiveRequest | undefined
  let terminal = !enabled
  let initialized = false
  let recoveryAttempt = 0
  let recovering = false
  let resetPending = false
  let maintenancePending = false
  let restoring: Map<number, RemoteDiagnosticRecordV3> | undefined
  let purgePending: number[] = []
  let entries = new Map<number, RemoteDiagnosticRecordV3>()
  let queue: PendingDiagnosticRecord[] = []
  let dedup = new Set<string>()
  let nextExpiry = Number.POSITIVE_INFINITY
  const locallyPruned = new Set<number>()
  let diskCounters = emptyCounters()
  let pendingLoss = { dropped: 0, rejected: 0 }
  let unresolvedLoss:
    | {
        generation: number
        expected: Pick<DiagnosticsJournalCounters, 'dropped' | 'rejected'>
      }
    | undefined
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
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
    nextExpiry = Number.POSITIVE_INFINITY
    const pending = active?.generation === generation && active.request.kind === 'append' ? active.request.records : []
    for (const record of [...entries.values(), ...queue, ...pending]) {
      const key = keyOf(record)
      if (key) dedup.add(key)
      if ('sequence' in record) nextExpiry = Math.min(nextExpiry, record.receivedAt + limits.maxAgeMs + 1)
    }
  }

  function pruneMemory(): void {
    const cutoff = now() - limits.maxAgeMs
    let changed = false
    nextExpiry = Number.POSITIVE_INFINITY
    for (const [sequence, record] of entries) {
      if (record.receivedAt >= cutoff) {
        nextExpiry = Math.min(nextExpiry, record.receivedAt + limits.maxAgeMs + 1)
        continue
      }
      entries.delete(sequence)
      locallyPruned.add(record.sequence)
      const key = keyOf(record)
      if (key) dedup.delete(key)
      changed = true
    }
    if (changed) maintenancePending = true
  }

  function stateChanged(event: DiagnosticsJournalStateChange): void {
    try {
      options.onStateChange?.(Object.freeze({ ...event }))
    } catch {
      /* Diagnostics state reporting must not control recovery. */
    }
  }

  function finishClose(): void {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = undefined
    if (recoveryTimer) clearTimeout(recoveryTimer)
    recoveryTimer = undefined
    settleReady()
    settleClose?.()
  }

  function retryable(failure: DiagnosticsJournalFailure): boolean {
    return !['invalid-storage', 'storage-full', 'invalid-request', 'invalid-response'].includes(failure)
  }

  function terminalFailure(): void {
    terminal = true
    initialized = false
    if (unresolvedLoss?.generation === generation) {
      pendingLoss.dropped = add(
        pendingLoss.dropped,
        Math.max(0, unresolvedLoss.expected.dropped - diskCounters.dropped),
      )
      pendingLoss.rejected = add(
        pendingLoss.rejected,
        Math.max(0, unresolvedLoss.expected.rejected - diskCounters.rejected),
      )
    }
    unresolvedLoss = undefined
    pendingLoss.dropped = add(pendingLoss.dropped, queue.length)
    active = undefined
    queue = []
    entries.clear()
    restoring = undefined
    dedup.clear()
    if (maintenanceTimer) clearInterval(maintenanceTimer)
    settleReady()
    if (closing) finishClose()
  }

  function failWorker(
    failedWorker: Worker | undefined,
    failure: DiagnosticsJournalFailure,
    fallbackOperation: DiagnosticsJournalRequest['kind'] = 'initialize',
  ): void {
    if (failedWorker && worker !== failedWorker) return
    if (!failedWorker && worker) return
    if (terminal) {
      if (closing) finishClose()
      return
    }
    const completed = active?.worker === failedWorker ? active : undefined
    const operation = completed?.request.kind ?? fallbackOperation
    if (completed) {
      clearTimeout(completed.timer)
      if (completed.generation === generation && completed.request.kind === 'append') {
        pendingLoss.dropped = add(pendingLoss.dropped, completed.request.records.length)
      }
      if (
        completed.generation === generation &&
        completed.request.kind !== 'initialize' &&
        completed.request.kind !== 'reset' &&
        !unresolvedLoss
      ) {
        unresolvedLoss = {
          generation,
          expected: {
            dropped: add(diskCounters.dropped, completed.request.loss.dropped),
            rejected: add(diskCounters.rejected, completed.request.loss.rejected),
          },
        }
      }
    }
    active = undefined
    initialized = false
    restoring = undefined
    purgePending = []
    entries.clear()
    locallyPruned.clear()
    rebuildDedup()
    worker = undefined
    if (failedWorker) {
      failedWorker.unref()
      void failedWorker.terminate().catch(() => undefined)
    }
    settleReady()
    if (closing) {
      terminalFailure()
      return
    }
    const delay = retryable(failure) ? recoveryDelays[recoveryAttempt] : undefined
    const nextAttempt = delay === undefined ? recoveryAttempt : recoveryAttempt + 1
    stateChanged({
      state: 'unavailable',
      failure,
      operation,
      recoveryAttempt: nextAttempt,
      retryInMs: delay ?? null,
    })
    if (delay === undefined) {
      terminalFailure()
      return
    }
    recovering = true
    recoveryAttempt = nextAttempt
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined
      startWorker()
    }, delay)
    recoveryTimer.unref()
  }

  function validResponse(
    response: Exclude<DiagnosticsJournalResponse, { kind: 'failed' }>,
    request: DiagnosticsJournalRequest,
  ): boolean {
    const expectedKind = request.kind === 'initialize' ? 'snapshot' : request.kind === 'close' ? 'closed' : 'changed'
    const sequences = response.kind === 'snapshot' ? response.retainedSequences : response.removedSequences
    return (
      response.kind === expectedKind &&
      /^[a-f0-9]{32}$/.test(response.epoch) &&
      boundedInteger(response.lastSequence) &&
      response.counters &&
      ['dropped', 'rejected', 'pruned'].every((key) =>
        boundedInteger(response.counters[key as keyof DiagnosticsJournalCounters]),
      ) &&
      Array.isArray(response.entries) &&
      response.entries.length <= limits.maxEvents &&
      Array.isArray(sequences) &&
      sequences.length <= limits.maxEvents &&
      sequences.every((sequence) => boundedInteger(sequence, 1, response.lastSequence)) &&
      new Set(sequences).size === sequences.length
    )
  }

  function restoreRows(rows: StoredDiagnosticRow[]): { valid: RemoteDiagnosticRecordV3[]; invalid: number[] } {
    const valid: RemoteDiagnosticRecordV3[] = []
    const invalid: number[] = []
    const keys = new Set<string>()
    let bytes = 0
    for (const row of rows) {
      let record: RemoteDiagnosticRecordV3 | null = null
      try {
        if (typeof row.json === 'string' && Buffer.byteLength(row.json) <= limits.maxRecordBytes) {
          record = projectRemoteDiagnosticRecordV3(JSON.parse(row.json))
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
    const target = worker
    const loss = request.kind === 'initialize' || request.kind === 'reset' ? { dropped: 0, rejected: 0 } : pendingLoss
    if (request.kind !== 'initialize' && request.kind !== 'reset') pendingLoss = { dropped: 0, rejected: 0 }
    const outgoing = { ...request, id: ++nextRequestId, epoch, now: now(), loss } as DiagnosticsJournalRequest
    const timeout =
      outgoing.kind === 'initialize'
        ? limits.initializationTimeoutMs
        : outgoing.kind === 'close'
          ? limits.closeTimeoutMs
          : ['prune', 'purge', 'reset'].includes(outgoing.kind)
            ? limits.maintenanceTimeoutMs
            : limits.requestTimeoutMs
    active = {
      request: outgoing,
      generation,
      worker: target,
      timer: setTimeout(() => failWorker(target, 'request-timeout', outgoing.kind), timeout),
    }
    // Idle workers and recovery timers remain unreferenced; each operation has
    // its own finite deadline and never blocks application work.
    try {
      target.postMessage(outgoing)
    } catch {
      failWorker(target, 'worker-error', outgoing.kind)
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

  function recovered(): void {
    initialized = true
    settleReady()
    if (recovering) stateChanged({ state: 'recovered', recoveryAttempt })
    recovering = false
    recoveryAttempt = 0
  }

  function receive(response: DiagnosticsJournalResponse, sourceWorker: Worker): void {
    const completed = active
    if (
      !completed ||
      completed.worker !== sourceWorker ||
      worker !== sourceWorker ||
      response.id !== completed.request.id ||
      terminal
    )
      return
    if (response.kind === 'failed') {
      failWorker(sourceWorker, response.failure, completed.request.kind)
      return
    }
    clearTimeout(completed.timer)
    active = undefined
    if (completed.generation !== generation) {
      pump()
      return
    }
    if (!validResponse(response, completed.request)) {
      failWorker(sourceWorker, 'invalid-response', completed.request.kind)
      return
    }
    if (completed.request.kind === 'initialize' && unresolvedLoss?.generation === generation) {
      pendingLoss.dropped = add(
        pendingLoss.dropped,
        Math.max(0, unresolvedLoss.expected.dropped - response.counters.dropped),
      )
      pendingLoss.rejected = add(
        pendingLoss.rejected,
        Math.max(0, unresolvedLoss.expected.rejected - response.counters.rejected),
      )
      unresolvedLoss = undefined
    }
    diskCounters = { ...response.counters }
    if (completed.request.kind === 'initialize') epoch = response.epoch
    else if (response.epoch !== epoch) {
      failWorker(sourceWorker, 'invalid-response', completed.request.kind)
      return
    }
    const restored = restoreRows(response.entries)
    if (restored.invalid.length) purgePending.push(...restored.invalid)
    if (completed.request.kind === 'initialize') {
      // Confirm exact restoration even when no row needs removal; the worker
      // stamps a legacy unversioned store only after this trusted boundary.
      const retainedSequences = new Set(response.kind === 'snapshot' ? response.retainedSequences : [])
      restoring = new Map(
        restored.valid
          .filter((record) => retainedSequences.has(record.sequence) && !locallyPruned.has(record.sequence))
          .map((record) => [record.sequence, record]),
      )
    } else if (completed.request.kind === 'purge' && restoring) {
      const removed = new Set(response.kind === 'snapshot' ? [] : response.removedSequences)
      for (const sequence of removed) restoring.delete(sequence)
      entries = restoring
      restoring = undefined
      rebuildDedup()
      pruneMemory()
      recovered()
    } else if (completed.request.kind === 'reset') {
      entries.clear()
      rebuildDedup()
      recovered()
    } else {
      const removed = response.kind === 'snapshot' ? [] : response.removedSequences
      for (const sequence of removed) {
        locallyPruned.delete(sequence)
        const record = entries.get(sequence)
        const key = record ? keyOf(record) : undefined
        if (key) dedup.delete(key)
        entries.delete(sequence)
      }
      for (const record of restored.valid) {
        if (locallyPruned.has(record.sequence)) continue
        entries.set(record.sequence, record)
        const key = keyOf(record)
        if (key) dedup.add(key)
        nextExpiry = Math.min(nextExpiry, record.receivedAt + limits.maxAgeMs + 1)
      }
      if (now() >= nextExpiry) pruneMemory()
    }
    if (response.kind === 'closed') {
      gracefulClose = true
      initialized = false
      if (maintenanceTimer) clearInterval(maintenanceTimer)
      return
    }
    pump()
  }

  function startWorker(): void {
    if (!enabled || terminal || closing || worker) return
    resetPending = false
    maintenancePending = false
    gracefulClose = false
    let candidate: Worker
    try {
      candidate = new Worker(new URL('./diagnosticsJournalWorker.ts', import.meta.url), {
        execArgv: [],
        stdout: true,
        stderr: true,
      })
    } catch {
      failWorker(undefined, 'worker-start')
      return
    }
    worker = candidate
    // Node runtime warnings and native error text are never app/support logs.
    candidate.stdout?.on('data', () => undefined)
    candidate.stderr?.on('data', () => undefined)
    candidate.on('message', (response: DiagnosticsJournalResponse) => receive(response, candidate))
    candidate.on('error', () => failWorker(candidate, 'worker-error'))
    candidate.on('exit', () => {
      if (worker !== candidate) return
      if (!gracefulClose) {
        failWorker(candidate, 'worker-exit')
        return
      }
      worker = undefined
      finishClose()
    })
    candidate.unref()
    send({ kind: 'initialize', directory: options.directory, lineageDigest, limits })
  }

  try {
    if (enabled) {
      limits = resolveLimits(options.limits)
      recoveryDelays = resolveRecoveryDelays(options.recoveryDelaysMs)
      lineageDigest = digestLineage(options.lineage)
      if (
        typeof options.directory !== 'string' ||
        options.directory.length > 4096 ||
        !path.isAbsolute(options.directory) ||
        path.normalize(options.directory) !== options.directory ||
        !/^[a-f0-9]{32}$/.test(options.instanceId)
      )
        throw new Error()
      startWorker()
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
    failWorker(undefined, 'invalid-request')
  }

  return {
    enabled,
    ready,
    available() {
      return initialized && !terminal
    },
    hasBrowserEvent(sourceId, eventId) {
      if (!enabled || terminal || closing || !/^[a-f0-9]{32}$/.test(sourceId) || !/^[a-f0-9]{32}$/.test(eventId))
        return false
      if (now() >= nextExpiry) pruneMemory()
      return dedup.has(`${sourceId}:${eventId}`)
    },
    record(entry, provenance = { kind: 'server' }, facts) {
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
        const validated = projectRemoteDiagnosticRecordV3({
          sequence: MAX_COUNTER,
          receivedAt: now(),
          instanceId: options.instanceId,
          provenance,
          entry,
          ...(facts === undefined ? {} : { facts: [...facts] }),
        })
        if (
          !validated ||
          (facts !== undefined && provenance.kind !== 'server') ||
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
      if (now() >= nextExpiry) pruneMemory()
      const visible =
        initialized && !terminal
          ? [...entries.values()]
              .map((record) => projectRemoteDiagnosticRecordV3(record))
              .filter((record): record is RemoteDiagnosticRecordV3 => record !== null)
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
      entries.clear()
      queue = []
      restoring = undefined
      purgePending = []
      locallyPruned.clear()
      dedup.clear()
      nextExpiry = Number.POSITIVE_INFINITY
      diskCounters = emptyCounters()
      pendingLoss = { dropped: 0, rejected: 0 }
      unresolvedLoss = undefined
      initialized = false
      try {
        lineageDigest = digestLineage(lineage)
      } catch {
        failWorker(worker, 'invalid-request', 'reset')
        return
      }
      resetPending = true
      pump()
    },
    close() {
      if (!closing) {
        closing = new Promise<void>((resolve) => (settleClose = resolve))
        if (maintenanceTimer) clearInterval(maintenanceTimer)
        if (recoveryTimer) clearTimeout(recoveryTimer)
        recoveryTimer = undefined
        if (terminal || !enabled || !worker) {
          terminalFailure()
          finishClose()
        } else {
          closeTimer = setTimeout(() => {
            failWorker(worker, 'request-timeout', 'close')
            finishClose()
          }, limits.closeTimeoutMs)
          pump()
        }
      }
      return closing
    },
  }
}
