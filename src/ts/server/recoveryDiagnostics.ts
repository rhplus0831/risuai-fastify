import type { BrowserRecoveryReason, RecoveryLeaseKind } from '@risuai/protocol/diagnostics'
import { recordClientDiagnostic } from '../diagnostics'
import { getClientSessionSnapshot } from '../clientSession'

export type RecoveryDiagnosticOutcome = 'ok' | 'failed' | 'cancelled' | 'pending' | 'rejected'

export interface RecoveryDiagnosticFacts {
  outcome?: RecoveryDiagnosticOutcome
  level?: 'info' | 'warn' | 'error'
  lease?: RecoveryLeaseKind
  attemptCount?: number
  /** A scheduled retry delay. */
  delayMs?: number
  /** An observed age or wait, such as the time since the last event frame. */
  durationMs?: number
  suspensionEvidence?: boolean
  exclusive?: boolean
}

const MAX_DURATION_MS = 86_400_000

function boundedDuration(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value)))
}

/**
 * Record one content-free connection-recovery decision. Every record carries
 * the session lifecycle/connection it observed plus page visibility and the
 * browser's online flag, so a stalled recovery can be read back as a sequence
 * of reasons instead of as bare state changes. Collection never affects the
 * recovery itself.
 */
export function recordRecoveryDiagnostic(reason: BrowserRecoveryReason, facts: RecoveryDiagnosticFacts = {}): void {
  try {
    const session = getClientSessionSnapshot()
    const outcome = facts.outcome ?? 'ok'
    recordClientDiagnostic({
      event: 'recovery',
      level: facts.level ?? (outcome === 'failed' || outcome === 'rejected' ? 'warn' : 'info'),
      reason,
      outcome,
      lifecycle: session.lifecycle,
      connection: session.connection,
      ...(typeof document !== 'undefined' ? { visible: document.visibilityState === 'visible' } : {}),
      ...(typeof navigator !== 'undefined' ? { online: navigator.onLine !== false } : {}),
      ...(facts.lease ? { lease: facts.lease } : {}),
      ...(facts.attemptCount !== undefined ? { attemptCount: boundedDuration(facts.attemptCount) } : {}),
      ...(facts.delayMs !== undefined ? { delayMs: boundedDuration(facts.delayMs) } : {}),
      ...(facts.durationMs !== undefined ? { durationMs: boundedDuration(facts.durationMs) } : {}),
      ...(facts.suspensionEvidence !== undefined ? { suspensionEvidence: facts.suspensionEvidence } : {}),
      ...(facts.exclusive !== undefined ? { exclusive: facts.exclusive } : {}),
    })
  } catch {
    /* Diagnostics must never affect connection recovery. */
  }
}
