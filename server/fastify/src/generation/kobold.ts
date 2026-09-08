import { observeProviderResult, providerDiagnosticFetch } from './providerDiagnostics.js'
import { applyAdditionalParameters } from './additionalParams.js'
import type { CompletionResult } from './frames.js'
import { extractApiResponseMetadata } from './apiMetadata.js'
import { flattenForLegacyInstruct } from './openaiLegacyInstruct.js'
import { readBoundedBodyText } from './body.js'

export interface KoboldRequest {
  prompt: string
  baseUrl: string
  maxTokens?: number
  maxContextLength?: number
  temperature?: number
  topP?: number
  topK?: number
  topA?: number
  repetitionPenalty?: number
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface ResolveInput {
  messages?: unknown
  baseUrl?: unknown
  maxTokens?: unknown
  maxContextLength?: unknown
  temperature?: unknown
  topP?: unknown
  topK?: unknown
  topA?: unknown
  repetitionPenalty?: unknown
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface RawChatMessage {
  role?: unknown
  content?: unknown
}

export function resolveKoboldRequest(input: ResolveInput): KoboldRequest | null {
  if (!Array.isArray(input.messages)) return null
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length === 0) return null

  const prompt = flattenForLegacyInstruct(input.messages as RawChatMessage[])
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
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined
  const topK = typeof input.topK === 'number' && Number.isFinite(input.topK) ? input.topK : undefined
  const topA = typeof input.topA === 'number' && Number.isFinite(input.topA) ? input.topA : undefined
  const repetitionPenalty =
    typeof input.repetitionPenalty === 'number' && Number.isFinite(input.repetitionPenalty)
      ? input.repetitionPenalty
      : undefined

  return {
    prompt,
    baseUrl: input.baseUrl,
    maxTokens,
    maxContextLength,
    temperature,
    topP,
    topK,
    topA,
    repetitionPenalty,
    additionalParams: input.additionalParams,
    signal: input.signal,
  }
}

function endpoint(req: KoboldRequest): string {
  const url = new URL(req.baseUrl)
  if (url.pathname.length < 3) url.pathname = '/api/v1/generate'
  return url.toString()
}

function buildPayload(req: KoboldRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    n: 1,
  }
  if (req.maxTokens !== undefined) body.max_length = req.maxTokens
  if (req.maxContextLength !== undefined) body.max_context_length = req.maxContextLength
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.topP !== undefined) body.top_p = req.topP
  if (req.topK !== undefined) body.top_k = req.topK
  if (req.topA !== undefined) body.top_a = req.topA
  if (req.repetitionPenalty !== undefined) body.rep_pen = req.repetitionPenalty
  return body
}

function buildRequestInit(req: KoboldRequest): { body: string; headers: Record<string, string> } {
  const body = buildPayload(req)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  return { body: JSON.stringify(body), headers }
}

interface KoboldResponse {
  results?: Array<{ text?: unknown }>
}

async function runKoboldCore(req: KoboldRequest): Promise<CompletionResult> {
  if (req.signal.aborted) {
    return { type: 'fail', result: 'aborted', aborted: true }
  }

  let response: Response
  try {
    const init = buildRequestInit(req)
    response = await providerDiagnosticFetch(endpoint(req), {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal.aborted) {
      return { type: 'fail', result: 'aborted', aborted: true }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `upstream fetch failed: ${msg}` }
  }

  let raw: string
  try {
    raw = await readBoundedBodyText(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream body: ${msg}` }
  }

  if (!response.ok) return { type: 'fail', result: raw, nonRetryable: true }

  let body: KoboldResponse
  try {
    body = JSON.parse(raw) as KoboldResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

  const text = body.results?.[0]?.text
  if (typeof text !== 'string') {
    return { type: 'fail', result: 'upstream returned no text' }
  }
  const apiMetadata = extractApiResponseMetadata(body, ['results'])
  return { type: 'success', result: text, ...(apiMetadata ? { apiMetadata } : {}) }
}

export function runKobold(req: KoboldRequest): Promise<CompletionResult> {
  return observeProviderResult('unknown', req.signal, () => runKoboldCore(req))
}
