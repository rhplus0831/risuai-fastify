import type { DisplaySourceResponse } from '@risuai/protocol/display-source'
import type { DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'
import { diagnosticsContextEnabled, recordDiagnosticEvent } from './diagnosticContext.js'
import { protocolNowMs, protocolElapsedMs } from './protocolMetrics.js'

type DisplayPerformanceEvent = Extract<DiagnosticEventV2, { category: 'display-performance' }>
type Preparation = NonNullable<DisplayPerformanceEvent['preparation']>
type LoadOwner = keyof NonNullable<Preparation['loads']>
type PreparationTiming = {
  [K in keyof Preparation]: K extends `${string}Ms` ? K : never
}[keyof Preparation] &
  string
type PreparationCount = {
  [K in keyof Preparation]: K extends `${string}Count` ? K : never
}[keyof Preparation] &
  string
export type DisplayPerformanceTiming = keyof DisplayPerformanceEvent['timings']
const boundedDuration = (value: number) => Math.min(86_400_000, protocolElapsedMs(value))
const boundedCount = (value: number) => Math.min(1_000_000_000, Math.max(0, Math.floor(value)))

function jsonSize(bytes: number): NonNullable<Preparation['dependencyJsonSize']> {
  if (bytes === 0) return 'none'
  if (bytes <= 4 * 1024) return 'up-to-4KiB'
  if (bytes <= 64 * 1024) return 'up-to-64KiB'
  if (bytes <= 1024 * 1024) return 'up-to-1MiB'
  if (bytes <= 4 * 1024 * 1024) return 'up-to-4MiB'
  if (bytes <= 16 * 1024 * 1024) return 'up-to-16MiB'
  if (bytes <= 64 * 1024 * 1024) return 'up-to-64MiB'
  return 'over-64MiB'
}

/** Optional, request-owned instrumentation for shared repository helpers. */
export interface DisplaySourceLoadMeasurement {
  read<T>(operation: () => T): T
  parse(json: string): unknown
}

export function readDisplaySourceData<T>(measurement: DisplaySourceLoadMeasurement | undefined, operation: () => T): T {
  return measurement ? measurement.read(operation) : operation()
}

export function parseDisplaySourceJson(json: string, measurement?: DisplaySourceLoadMeasurement): unknown {
  return measurement ? measurement.parse(json) : JSON.parse(json)
}

/** One content-free summary per batch, including failed and abandoned work.
 * No raw metric subscription, input strings, domain IDs or dependency hashes.
 */
export class DisplaySourceDiagnostics {
  readonly timings: DisplayPerformanceEvent['timings'] = {}
  readonly preparation: Preparation = {}
  private readonly loadBytes = new Map<LoadOwner, number>()
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

  measurePreparation<T>(stage: PreparationTiming, operation: () => T): T {
    const startedAt = protocolNowMs()
    try {
      return operation()
    } finally {
      this.preparation[stage] = (this.preparation[stage] ?? 0) + Math.max(0, protocolNowMs() - startedAt)
    }
  }

  dependencySize(json: string): void {
    this.measurePreparation('measurementMs', () => {
      this.preparation.dependencyJsonSize = jsonSize(Buffer.byteLength(json, 'utf8'))
    })
  }

  inputCounts(collect: () => Partial<Record<PreparationCount, number>>): void {
    this.measurePreparation('measurementMs', () => {
      const counts = collect()
      for (const key of Object.keys(counts) as PreparationCount[])
        this.preparation[key] = boundedCount(counts[key] ?? 0)
    })
  }

  incrementPreparation(stage: PreparationCount): void {
    this.preparation[stage] = boundedCount((this.preparation[stage] ?? 0) + 1)
  }

  load(owner: LoadOwner): DisplaySourceLoadMeasurement {
    const record = () => {
      const loads = (this.preparation.loads ??= {})
      return (loads[owner] ??= {})
    }
    const measure = <T>(stage: 'readMs' | 'parseMs', operation: () => T): T => {
      const value = record()
      const startedAt = protocolNowMs()
      try {
        return operation()
      } finally {
        value[stage] = (value[stage] ?? 0) + Math.max(0, protocolNowMs() - startedAt)
      }
    }
    return {
      read: (operation) => measure('readMs', operation),
      parse: (json) => {
        // Inspect only strings already fetched for the real operation. Never
        // serialize the loaded graph a second time just to collect size data.
        this.measurePreparation('measurementMs', () => {
          const value = record()
          const bytes = (this.loadBytes.get(owner) ?? 0) + Buffer.byteLength(json, 'utf8')
          this.loadBytes.set(owner, bytes)
          value.jsonValues = boundedCount((value.jsonValues ?? 0) + 1)
          value.jsonSize = jsonSize(bytes)
        })
        return measure('parseMs', () => JSON.parse(json))
      },
    }
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
    // Round only after accumulation: many sub-0.01 ms JSON parses must not
    // individually round down to zero and disappear from the owner total.
    for (const key of Object.keys(this.preparation) as (keyof Preparation)[]) {
      if (key.endsWith('Ms')) {
        const timing = key as PreparationTiming
        this.preparation[timing] = boundedDuration(this.preparation[timing] ?? 0)
      }
    }
    for (const load of Object.values(this.preparation.loads ?? {})) {
      if (load.readMs !== undefined) load.readMs = boundedDuration(load.readMs)
      if (load.parseMs !== undefined) load.parseMs = boundedDuration(load.parseMs)
    }
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
      preparation: Object.keys(this.preparation).length ? this.preparation : undefined,
    })
  }
}

export function beginDisplaySourceDiagnostics(targetCount: number, enqueuedAt: number, queueDepth: number) {
  return diagnosticsContextEnabled() ? new DisplaySourceDiagnostics(targetCount, enqueuedAt, queueDepth) : undefined
}
