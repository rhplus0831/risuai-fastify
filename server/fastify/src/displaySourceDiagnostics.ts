import type { DisplaySourceResponse } from '@risuai/protocol/display-source'
import type { DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'
import { diagnosticsContextEnabled, recordDiagnosticEvent } from './diagnosticContext.js'
import { protocolNowMs, protocolElapsedMs } from './protocolMetrics.js'

type DisplayPerformanceEvent = Extract<DiagnosticEventV2, { category: 'display-performance' }>
export type DisplayPerformanceTiming = keyof DisplayPerformanceEvent['timings']
const boundedDuration = (value: number) => Math.min(86_400_000, protocolElapsedMs(value))
const boundedCount = (value: number) => Math.min(1_000_000_000, Math.max(0, Math.floor(value)))

/** One content-free summary per batch, including failed and abandoned work.
 * No raw metric subscription, input strings, domain IDs or dependency hashes.
 */
export class DisplaySourceDiagnostics {
  readonly timings: DisplayPerformanceEvent['timings'] = {}
  outcome: DisplayPerformanceEvent['outcome'] = 'failed'
  queueWaitMs = 0
  visitedTargetCount = 0
  executedTargetCount = 0
  cacheHitCount = 0
  cacheMissCount = 0
  inflightJoinCount = 0
  streamingBypassCount = 0
  transcriptMessageCount?: number
  private timeToFirstTransformMs?: number
  private timeToFirstResultMs?: number
  private timeToPriorityResultsMs?: number
  priorityTargetCount = 0
  private priorityResults = 0

  constructor(
    private readonly targetCount: number,
    private readonly enqueuedAt: number,
    private readonly queueDepth: number,
  ) {}

  addDuration(stage: DisplayPerformanceTiming, durationMs: number): void {
    this.timings[stage] = boundedDuration((this.timings[stage] ?? 0) + durationMs)
  }

  transformStarted(streaming: boolean): void {
    this.timeToFirstTransformMs ??= boundedDuration(protocolNowMs() - this.enqueuedAt)
    this.executedTargetCount++
    if (streaming) this.streamingBypassCount++
    else this.cacheMissCount++
  }

  resultReady(priority: boolean): void {
    this.timeToFirstResultMs ??= boundedDuration(protocolNowMs() - this.enqueuedAt)
    if (priority && ++this.priorityResults === this.priorityTargetCount) {
      this.timeToPriorityResultsMs = boundedDuration(protocolNowMs() - this.enqueuedAt)
    }
  }

  finish(response: DisplaySourceResponse | undefined, aborted: boolean): void {
    const resultCounts = response
      ? {
          ok: response.entries.filter((entry) => entry.status === 'ok').length,
          clientFallback: response.entries.filter((entry) => entry.status === 'client_fallback').length,
          stale: response.entries.filter((entry) => entry.status === 'stale').length,
          error: response.entries.filter((entry) => entry.status === 'error').length,
        }
      : undefined
    if (aborted) this.outcome = 'aborted'
    else if (resultCounts) {
      this.outcome =
        resultCounts.ok === this.targetCount
          ? 'ok'
          : resultCounts.clientFallback === this.targetCount
            ? 'client-fallback'
            : resultCounts.stale === this.targetCount
              ? 'stale'
              : 'partial'
    }
    recordDiagnosticEvent({
      category: 'display-performance',
      level: this.outcome === 'failed' ? 'error' : this.outcome === 'ok' ? 'info' : 'warn',
      outcome: this.outcome,
      durationMs: boundedDuration(protocolNowMs() - this.enqueuedAt),
      queueWaitMs: boundedDuration(this.queueWaitMs),
      queueDepth: boundedCount(this.queueDepth),
      targetCount: this.targetCount,
      visitedTargetCount: this.visitedTargetCount,
      executedTargetCount: this.executedTargetCount,
      cacheHitCount: this.cacheHitCount,
      cacheMissCount: this.cacheMissCount,
      inflightJoinCount: this.inflightJoinCount,
      streamingBypassCount: this.streamingBypassCount,
      transcriptMessageCount:
        this.transcriptMessageCount === undefined ? undefined : boundedCount(this.transcriptMessageCount),
      timeToFirstTransformMs: this.timeToFirstTransformMs,
      timeToFirstResultMs: this.timeToFirstResultMs,
      timeToPriorityResultsMs: this.timeToPriorityResultsMs,
      priorityTargetCount: this.priorityTargetCount,
      resultCounts,
      timings: this.timings,
    })
  }
}

export function beginDisplaySourceDiagnostics(targetCount: number, enqueuedAt: number, queueDepth: number) {
  return diagnosticsContextEnabled() ? new DisplaySourceDiagnostics(targetCount, enqueuedAt, queueDepth) : undefined
}
