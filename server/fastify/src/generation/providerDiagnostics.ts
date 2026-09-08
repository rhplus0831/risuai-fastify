import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import {
  DIAGNOSTIC_PROVIDER_ADAPTERS,
  diagnosticSizeBucket,
  type DiagnosticEventV2,
} from '@risuai/protocol/remote-diagnostics'
import { diagnosticsContextEnabled, recordDiagnosticEvent, runWithDiagnosticAttempt } from '../diagnosticContext.js'
import type { CompletionStreamFrame } from './frames.js'

type ProviderEvent = Extract<DiagnosticEventV2, { category: 'provider' }>
type Adapter = ProviderEvent['adapter']
type Outcome = ProviderEvent['outcome']
type Failure = Exclude<Outcome, 'started' | 'ok'>
type Transport = ProviderEvent['transport']
const attempts = new AsyncLocalStorage<ProviderAttempt>()
const boundedDuration = (value: number) => Math.max(0, Math.min(86_400_000, value))

/** Model names, endpoints, error messages and provider-defined codes are never inspected. */
function errorIsTimeout(error: unknown): boolean {
  try {
    if (!(error instanceof Error)) return false
    if (error.name === 'TimeoutError') return true
    const cause = error.cause as { code?: unknown } | undefined
    return (
      typeof cause?.code === 'string' &&
      ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(cause.code)
    )
  } catch {
    return false
  }
}

export function diagnosticProviderAdapter(input: unknown): Adapter {
  if (input === 'openai-responses' || input === 'openai-legacy-instruct') return 'openai'
  return DIAGNOSTIC_PROVIDER_ADAPTERS.find((adapter) => adapter === input) ?? 'unknown'
}

class ProviderAttempt {
  readonly startedAt = performance.now()
  dispatchedAt?: number
  headersAt?: number
  firstTokenAt?: number
  statusCode?: number
  failure?: Failure
  receivedBytes = 0
  chunkCount = 0
  maxStreamGapMs = 0
  observedTerminal = false
  finished = false
  within: <T>(callback: () => T) => T = (callback) => callback()

  constructor(
    readonly adapter: Adapter,
    readonly transport: Transport,
    readonly signal: AbortSignal,
  ) {}

  emit(stage: ProviderEvent['stage'], outcome: Outcome): void {
    try {
      const event: Record<string, unknown> = {
        category: 'provider',
        level: outcome === 'ok' || outcome === 'started' ? 'info' : outcome === 'cancelled' ? 'warn' : 'error',
        adapter: this.adapter,
        transport: this.transport,
        stage,
        outcome,
        durationMs: boundedDuration(performance.now() - this.startedAt),
        providerMayHaveRun: this.dispatchedAt !== undefined,
        ...(this.statusCode !== undefined ? { statusCode: this.statusCode } : {}),
        ...(this.headersAt !== undefined && this.dispatchedAt !== undefined
          ? { timeToHeadersMs: boundedDuration(this.headersAt - this.dispatchedAt) }
          : {}),
      }
      if (stage === 'terminal') {
        event.responseBytes = this.headersAt === undefined ? 'unknown' : diagnosticSizeBucket(this.receivedBytes)
        event.chunkCount = this.chunkCount
        if (this.transport === 'stream') {
          event.maxStreamGapMs = boundedDuration(this.maxStreamGapMs)
          if (this.firstTokenAt !== undefined && this.dispatchedAt !== undefined) {
            event.timeToFirstTokenMs = boundedDuration(this.firstTokenAt - this.dispatchedAt)
          }
        }
        if (outcome === 'timeout') event.cancellationOrigin = 'deadline'
        else if (outcome === 'cancelled') event.cancellationOrigin = 'unknown'
        else if (outcome === 'disconnected') event.cancellationOrigin = 'disconnect'
      }
      this.within(() => recordDiagnosticEvent(event))
    } catch {
      // Diagnostics are independent of the provider result and cleanup path.
    }
  }

  terminal(fallback: Outcome): void {
    if (this.finished) return
    this.finished = true
    const outcome = this.signal.aborted
      ? errorIsTimeout(this.signal.reason)
        ? 'timeout'
        : 'cancelled'
      : (this.failure ?? fallback)
    this.emit('terminal', outcome)
  }

  failed(error: unknown, fallback: Failure): void {
    this.failure ??= errorIsTimeout(error) || errorIsTimeout(this.signal.reason) ? 'timeout' : fallback
  }

  unsuccessful(): Failure {
    return this.failure ?? (this.headersAt !== undefined ? 'invalid-response' : 'unknown-error')
  }
}

function createAttempt(adapter: Adapter, transport: Transport, signal: AbortSignal): ProviderAttempt | undefined {
  try {
    const attempt = new ProviderAttempt(adapter, transport, signal)
    attempt.within = runWithDiagnosticAttempt(() => attempts.run(attempt, () => AsyncLocalStorage.snapshot()))
    return attempt
  } catch {
    // If context creation fails, continue the application without diagnostics.
    return undefined
  }
}

/** No response clone, proxy, drain, extra buffering, or request mutation. */
export async function providerDiagnosticFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const attempt = attempts.getStore()
  if (!attempt || attempt.finished) return fetch(...args)
  if (attempt.dispatchedAt === undefined) {
    attempt.dispatchedAt = performance.now()
    attempt.emit('dispatch', 'started')
  }
  try {
    const response = await fetch(...args)
    if (Number.isInteger(response.status) && response.status >= 0 && response.status <= 599) {
      attempt.statusCode = response.status
    }
    if (!response.ok) attempt.failure = 'http-error'
    if (attempt.headersAt === undefined) {
      attempt.headersAt = performance.now()
      attempt.emit('headers', response.ok ? 'ok' : 'http-error')
    }
    return response
  } catch (error) {
    // Once fetch has been invoked, lack of a response never proves safe replay.
    attempt.failed(error, 'disconnected')
    throw error
  }
}

/** Counts only bytes the adapter already consumes; the largest awaited read excludes consumer processing time. */
export async function providerDiagnosticRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const attempt = attempts.getStore()
  if (!attempt || attempt.finished) return reader.read()
  const startedAt = performance.now()
  try {
    const result = await reader.read()
    if (!result.done) {
      attempt.receivedBytes = Math.min(Number.MAX_SAFE_INTEGER, attempt.receivedBytes + result.value.byteLength)
      attempt.chunkCount = Math.min(1_000_000_000, attempt.chunkCount + 1)
    }
    return result
  } catch (error) {
    attempt.failed(error, 'disconnected')
    throw error
  } finally {
    if (attempt.transport === 'stream') {
      attempt.maxStreamGapMs = Math.max(attempt.maxStreamGapMs, performance.now() - startedAt)
    }
  }
}

/** Called at the parsed upstream content boundary, before local reasoning buffering. */
export function recordProviderDiagnosticToken(): void {
  const attempt = attempts.getStore()
  if (attempt && attempt.firstTokenAt === undefined) attempt.firstTokenAt = performance.now()
}

/** Recognized provider completion marker; its original value is never retained. */
export function recordProviderDiagnosticTerminal(): void {
  const attempt = attempts.getStore()
  if (attempt) attempt.observedTerminal = true
}

export function recordProviderDiagnosticFailure(failure: Failure): void {
  const attempt = attempts.getStore()
  if (attempt) attempt.failure ??= failure
}

export function recordProviderDispatchFailure(signal: AbortSignal, adapter: unknown = 'unknown'): void {
  if (diagnosticsContextEnabled())
    createAttempt(diagnosticProviderAdapter(adapter), 'unknown', signal)?.terminal('unknown-error')
}

export async function observeProviderResult<T extends { type: 'success' | 'fail'; aborted?: boolean }>(
  adapter: Adapter,
  signal: AbortSignal,
  callback: () => Promise<T>,
): Promise<T> {
  if (!diagnosticsContextEnabled()) return callback()
  const attempt = createAttempt(adapter, 'json', signal)
  if (!attempt) return callback()
  try {
    const result = await attempt.within(callback)
    attempt.terminal(result.type === 'success' ? 'ok' : result.aborted ? 'cancelled' : attempt.unsuccessful())
    return result
  } catch (error) {
    attempt.failed(error, attempt.unsuccessful())
    attempt.terminal(attempt.unsuccessful())
    throw error
  }
}

export function observeProviderStream(
  adapter: Adapter,
  signal: AbortSignal,
  callback: () => AsyncGenerator<CompletionStreamFrame, void, void>,
): AsyncGenerator<CompletionStreamFrame, void, void> {
  if (!diagnosticsContextEnabled()) return callback()
  const attempt = createAttempt(adapter, 'stream', signal)
  if (!attempt) return callback()
  const iterator = attempt.within(callback)
  const step = async (
    method: 'next' | 'return' | 'throw',
    value?: unknown,
  ): Promise<IteratorResult<CompletionStreamFrame, void>> => {
    try {
      const next = await attempt.within(() =>
        method === 'next'
          ? iterator.next(value as void)
          : method === 'return'
            ? iterator.return(value as void)
            : iterator.throw(value),
      )
      if (next.done === true) {
        attempt.terminal(
          method === 'return' ? 'cancelled' : attempt.dispatchedAt === undefined ? 'unknown-error' : 'disconnected',
        )
      } else {
        const frame = next.value
        if (frame.kind === 'error') attempt.terminal(attempt.unsuccessful())
        else if (frame.kind === 'done') attempt.terminal(attempt.observedTerminal ? 'ok' : 'disconnected')
      }
      return next
    } catch (error) {
      attempt.failed(error, attempt.unsuccessful())
      attempt.terminal(attempt.unsuccessful())
      throw error
    }
  }
  return {
    next: (value?: void) => step('next', value),
    return: (value) => step('return', value),
    throw: (error) => step('throw', error),
    [Symbol.asyncIterator]() {
      return this
    },
  }
}
