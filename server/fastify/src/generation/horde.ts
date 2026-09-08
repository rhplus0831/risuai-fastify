import {
  observeProviderResult,
  providerDiagnosticFetch,
  recordProviderDiagnosticFailure,
} from './providerDiagnostics.js'
import { applyAdditionalParameters } from './additionalParams.js'
import type { CompletionResult } from './frames.js'
import { readBoundedBodyJson, readBoundedBodyText } from './body.js'
import { extractApiResponseMetadata, mergeApiResponseMetadata } from './apiMetadata.js'
import { formatUpstreamHttpError } from './upstreamError.js'

/**
 * Stable Horde text dispatcher. Mirrors the local SPA's `requestHorde` path:
 *
 *   1. `POST /api/v2/generate/text/async` with the flattened prompt +
 *      sampler params → `{id, kudos?, message?}`. Returns 202 on accept.
 *   2. Poll `GET /api/v2/generate/text/status/<id>` every
 *      `pollIntervalMs` (default 2 s) until `done: true` or until the
 *      wall-clock `timeoutMs` (default 5 min) elapses.
 *   3. On abort, fire `DELETE /api/v2/generate/text/status/<id>` so the
 *      Horde worker stops the in-flight job.
 *
 * The client pre-flattens the prompt via the SPA's `applyChatTemplate`
 * and sends the resulting string in `options.horde.prompt`. The server
 * returns buffered text without character or user context.
 *
 * Streaming is unsupported because Horde polling returns only a final
 * generation payload.
 */

const HORDE_BASE_URL = 'https://stablehorde.net/api/v2'
const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_ANON_KEY = '0000000000'
export const HORDE_DELETE_CLEANUP_TIMEOUT_MS = 10_000

export interface HordeRequest {
  prompt: string
  model: string
  apiKey: string
  maxTokens?: number
  maxContextLength?: number
  temperature?: number
  topK?: number
  topP?: number
  additionalParams?: Array<[string, string]>
  /** Override poll interval for deterministic tests. Defaults to 2 s. */
  pollIntervalMs?: number
  /** Override wall-clock timeout. Defaults to 5 min. */
  timeoutMs?: number
  signal: AbortSignal
}

interface HordeResolveInput {
  prompt?: unknown
  model?: unknown
  apiKey?: unknown
  maxTokens?: unknown
  maxContextLength?: unknown
  temperature?: unknown
  topK?: unknown
  topP?: unknown
  additionalParams?: Array<[string, string]>
  pollIntervalMs?: unknown
  timeoutMs?: unknown
  signal: AbortSignal
}

export function resolveHordeRequest(input: HordeResolveInput): HordeRequest | null {
  if (typeof input.prompt !== 'string' || input.prompt.length === 0) return null
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.length > 0 ? input.apiKey : DEFAULT_ANON_KEY
  const maxTokens =
    typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : undefined
  const maxContextLength =
    typeof input.maxContextLength === 'number' && Number.isFinite(input.maxContextLength) && input.maxContextLength > 0
      ? input.maxContextLength
      : undefined
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const topK = typeof input.topK === 'number' && Number.isFinite(input.topK) ? input.topK : undefined
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined
  const pollIntervalMs =
    typeof input.pollIntervalMs === 'number' && Number.isFinite(input.pollIntervalMs) && input.pollIntervalMs > 0
      ? input.pollIntervalMs
      : undefined
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : undefined

  return {
    prompt: input.prompt,
    model: input.model,
    apiKey,
    maxTokens,
    maxContextLength,
    temperature,
    topK,
    topP,
    additionalParams: input.additionalParams,
    pollIntervalMs,
    timeoutMs,
    signal: input.signal,
  }
}

function buildAsyncPayload(req: HordeRequest): Record<string, unknown> {
  const params: Record<string, unknown> = { n: 1, singleline: false }
  if (req.maxContextLength !== undefined) params.max_context_length = req.maxContextLength
  if (req.maxTokens !== undefined) params.max_length = req.maxTokens
  if (req.temperature !== undefined) params.temperature = req.temperature
  if (req.topK !== undefined) params.top_k = req.topK
  if (req.topP !== undefined) params.top_p = req.topP

  const payload: Record<string, unknown> = {
    prompt: req.prompt,
    params,
    trusted_workers: false,
    workerslow_workers: true,
    _blacklist: false,
    dry_run: false,
  }
  if (req.model !== 'auto') {
    // Mirror the SPA's `requestHorde` model list expansion, which adds
    // whitespace variants to widen worker matching.
    payload.models = [req.model, req.model.trim(), ' ' + req.model, req.model + ' ']
  }
  return payload
}

function buildAsyncRequestInit(req: HordeRequest): { body: string; headers: Record<string, string> } {
  const body = buildAsyncPayload(req)
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: req.apiKey }
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  return { body: JSON.stringify(body), headers }
}

interface AsyncResponse {
  id?: unknown
  kudos?: unknown
  message?: unknown
}

interface StatusResponse {
  done?: unknown
  is_possible?: unknown
  generations?: Array<{ text?: unknown }>
  faulted?: unknown
  message?: unknown
}

/**
 * Sleep until either `ms` elapses or `signal` aborts. Resolves on time-
 * out; rejects with `aborted` when the signal fires.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function createCleanupDeleteSignal(): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal.timeout === 'function') {
    return {
      signal: AbortSignal.timeout(HORDE_DELETE_CLEANUP_TIMEOUT_MS),
      cleanup: () => {},
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HORDE_DELETE_CLEANUP_TIMEOUT_MS)
  timeout.unref?.()
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  }
}

function fireDeleteJob(jobId: string, apiKey: string): void {
  // Fire-and-forget; we're already aborting or shutting down.
  const cleanupDelete = createCleanupDeleteSignal()
  try {
    fetch(`${HORDE_BASE_URL}/generate/text/status/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      headers: { apikey: apiKey },
      signal: cleanupDelete.signal,
    })
      .catch(() => {
        // ignore; the worker may have already finished
      })
      .finally(cleanupDelete.cleanup)
  } catch {
    cleanupDelete.cleanup()
  }
}

async function runHordeCore(req: HordeRequest): Promise<CompletionResult> {
  if (req.signal.aborted) {
    return { type: 'fail', result: 'aborted', aborted: true }
  }

  const pollIntervalMs = req.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  // Step 1: submit the async job.
  let asyncResp: Response
  try {
    const init = buildAsyncRequestInit(req)
    asyncResp = await providerDiagnosticFetch(`${HORDE_BASE_URL}/generate/text/async`, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal.aborted) return { type: 'fail', result: 'aborted', aborted: true }
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `upstream fetch failed: ${msg}` }
  }

  // Horde returns 202 on accept. Anything else is an error worth
  // surfacing verbatim.
  if (asyncResp.status !== 202) {
    let raw = ''
    try {
      raw = await readBoundedBodyText(asyncResp)
    } catch {
      // ignore
    }
    return { type: 'fail', result: raw.length > 0 ? raw : `HTTP ${asyncResp.status}` }
  }

  let asyncBody: AsyncResponse
  try {
    asyncBody = (await readBoundedBodyJson(asyncResp)) as AsyncResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid async response JSON: ${msg}` }
  }
  if (typeof asyncBody.id !== 'string' || asyncBody.id.length === 0) {
    return { type: 'fail', result: 'horde async response missing job id' }
  }
  const jobId = asyncBody.id
  const submissionMetadata = extractApiResponseMetadata(asyncBody, ['id', 'message'])

  // Wire up abort → DELETE.
  let abortHandled = false
  const onAbort = (): void => {
    if (abortHandled) return
    abortHandled = true
    fireDeleteJob(jobId, req.apiKey)
  }
  if (req.signal.aborted) {
    onAbort()
    return { type: 'fail', result: 'aborted', aborted: true }
  }
  req.signal.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      if (req.signal.aborted) {
        return { type: 'fail', result: 'aborted', aborted: true }
      }
      if (Date.now() >= deadline) {
        recordProviderDiagnosticFailure('timeout')
        fireDeleteJob(jobId, req.apiKey)
        return { type: 'fail', result: 'horde job timed out' }
      }
      try {
        await sleep(pollIntervalMs, req.signal)
      } catch {
        return { type: 'fail', result: 'aborted', aborted: true }
      }

      let statusResp: Response
      const statusUrl = `${HORDE_BASE_URL}/generate/text/status/${encodeURIComponent(jobId)}`
      try {
        statusResp = await providerDiagnosticFetch(statusUrl, {
          method: 'GET',
          headers: { apikey: req.apiKey },
          signal: req.signal,
        })
      } catch (err) {
        if (req.signal.aborted) {
          return { type: 'fail', result: 'aborted', aborted: true }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { type: 'fail', result: `horde status poll failed: ${msg}` }
      }

      if (!statusResp.ok) {
        let message: string | undefined
        try {
          const raw = await readBoundedBodyText(statusResp)
          if (raw.length > 0) message = raw
        } catch {
          // Keep the bounded HTTP status fallback.
        }
        fireDeleteJob(jobId, req.apiKey)
        return { type: 'fail', result: formatUpstreamHttpError(statusResp, statusUrl, { message }) }
      }

      let body: StatusResponse
      try {
        body = (await readBoundedBodyJson(statusResp)) as StatusResponse
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { type: 'fail', result: `invalid horde status JSON: ${msg}` }
      }

      if (body.is_possible === false) {
        fireDeleteJob(jobId, req.apiKey)
        return { type: 'fail', result: 'horde reports the job is not possible', nonRetryable: true }
      }
      if (body.faulted === true) {
        fireDeleteJob(jobId, req.apiKey)
        const msg = typeof body.message === 'string' ? body.message : 'unknown'
        return { type: 'fail', result: `horde job faulted: ${msg}` }
      }
      if (body.done === true) {
        const gens = Array.isArray(body.generations) ? body.generations : []
        const text = typeof gens[0]?.text === 'string' ? gens[0].text : ''
        if (text.length === 0) {
          return { type: 'fail', result: 'horde finished with no generations', nonRetryable: true }
        }
        const apiMetadata = mergeApiResponseMetadata(
          { jobId },
          submissionMetadata,
          extractApiResponseMetadata(body, ['generations', 'message', 'done']),
        )
        return { type: 'success', result: text, ...(apiMetadata ? { apiMetadata } : {}) }
      }
    }
  } finally {
    req.signal.removeEventListener('abort', onAbort)
  }
}

export function runHorde(req: HordeRequest): Promise<CompletionResult> {
  return observeProviderResult('unknown', req.signal, () => runHordeCore(req))
}
