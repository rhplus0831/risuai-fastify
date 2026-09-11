import type { RemoteDiagnosticRecordV3 } from '@risuai/protocol/remote-diagnostics'

export const DIAGNOSTICS_JOURNAL_VERSION = 1

export interface DiagnosticsJournalLimits {
  maxAgeMs: number
  maxEvents: number
  maxBytes: number
  maxQueue: number
  maxRecordBytes: number
  maxFileBytes: number
  initializationTimeoutMs: number
  requestTimeoutMs: number
  maintenanceTimeoutMs: number
  closeTimeoutMs: number
}

export const DIAGNOSTICS_JOURNAL_HARD_LIMITS: Readonly<DiagnosticsJournalLimits> = Object.freeze({
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxEvents: 10_000,
  maxBytes: 8 * 1024 * 1024,
  maxQueue: 256,
  maxRecordBytes: 4096,
  // SQLite overhead is separate from the retained JSON byte budget. DELETE
  // rollback journaling can temporarily consume one additional file of this size.
  maxFileBytes: 16 * 1024 * 1024,
  initializationTimeoutMs: 30_000,
  requestTimeoutMs: 5_000,
  maintenanceTimeoutMs: 15_000,
  closeTimeoutMs: 1_000,
})

export interface DiagnosticsJournalCounters {
  dropped: number
  rejected: number
  pruned: number
}

export type PendingDiagnosticRecord = Omit<RemoteDiagnosticRecordV3, 'sequence'>

export interface StoredDiagnosticRow {
  sequence: number
  receivedAt: number
  browserKey: string | null
  json: string | null
}

export type DiagnosticsJournalWorkerFailure =
  | 'invalid-storage'
  | 'storage-busy'
  | 'storage-full'
  | 'storage-io'
  | 'invalid-request'
  | 'worker-failed'

interface JournalRequestBase {
  id: number
  epoch: string
  now: number
  loss: Pick<DiagnosticsJournalCounters, 'dropped' | 'rejected'>
}

export type DiagnosticsJournalRequest = JournalRequestBase &
  (
    | { kind: 'initialize'; directory: string; lineageDigest: string; limits: DiagnosticsJournalLimits }
    | { kind: 'append'; records: PendingDiagnosticRecord[] }
    | { kind: 'purge'; sequences: number[] }
    | { kind: 'prune' }
    | { kind: 'reset'; lineageDigest: string }
    | { kind: 'close' }
  )

interface DiagnosticsJournalResponseBase {
  id: number
  epoch: string
  lastSequence: number
  counters: DiagnosticsJournalCounters
  entries: StoredDiagnosticRow[]
}

export type DiagnosticsJournalResponse =
  | { id: number; kind: 'failed'; failure: DiagnosticsJournalWorkerFailure }
  | (DiagnosticsJournalResponseBase & { kind: 'snapshot'; retainedSequences: number[] })
  | (DiagnosticsJournalResponseBase & { kind: 'changed' | 'closed'; removedSequences: number[] })
