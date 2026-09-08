import { observeProviderResult, providerDiagnosticFetch } from './providerDiagnostics.js'
import { applyAdditionalParameters, setCanonicalHeader } from './additionalParams.js'
import type { CompletionResult } from './frames.js'
import { extractApiResponseMetadata } from './apiMetadata.js'
import { readBoundedBodyJson } from './body.js'
import { normalizeLegacyOpenAIModelId } from '@risuai/shared-core/legacy-openai-model-aliases'

export interface OpenAILegacyInstructRequest {
  model: string
  prompt: string
  apiKey: string
  baseUrl: string
  maxTokens?: number
  temperature?: number
  topP?: number
  presencePenalty?: number
  frequencyPenalty?: number
  stop?: string[]
  extraHeaders?: Record<string, string>
  /**
   * Pre-validated `[key, value][]` pairs from the SPA's additionalParams /
   * xcustom `params` DSL. Applied after the dispatcher builds its default
   * body + headers, so the user DSL has the last word. See
   * `./additionalParams.ts` for semantics.
   */
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface ResolveInput {
  model?: unknown
  messages?: unknown
  apiKey?: unknown
  baseUrl?: unknown
  maxTokens?: unknown
  temperature?: unknown
  topP?: unknown
  presencePenalty?: unknown
  frequencyPenalty?: unknown
  stop?: unknown
  extraHeaders?: Record<string, string>
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface RawChatMessage {
  role?: unknown
  content?: unknown
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_STOP = ['User:', ' User:', 'user:', ' user:']

/**
 * Flatten an OpenAI-shaped messages array into a single prompt string with
 * `## Author` section headers. Mirrors the local browser
 * `requestOpenAILegacyInstruct` path.
 */
export function flattenForLegacyInstruct(messages: RawChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content.trim() : ''
    if (content.length === 0) continue
    let author = ''
    if (m.role === 'user') author = 'User'
    else if (m.role === 'assistant') author = 'Assistant'
    else if (m.role === 'system') author = 'Instruction'
    else author = typeof m.role === 'string' ? m.role : 'Other'
    lines.push(`\n## ${author}\n${content}`)
  }
  return lines.join('') + '\n## Response\n'
}

export function resolveOpenAILegacyInstructRequest(input: ResolveInput): OpenAILegacyInstructRequest | null {
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  if (!Array.isArray(input.messages)) return null
  if (typeof input.apiKey !== 'string' || input.apiKey.length === 0) return null

  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.length > 0 ? input.baseUrl : DEFAULT_BASE_URL
  const maxTokens =
    typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : undefined
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined
  const presencePenalty =
    typeof input.presencePenalty === 'number' && Number.isFinite(input.presencePenalty)
      ? input.presencePenalty
      : undefined
  const frequencyPenalty =
    typeof input.frequencyPenalty === 'number' && Number.isFinite(input.frequencyPenalty)
      ? input.frequencyPenalty
      : undefined
  const stop =
    Array.isArray(input.stop) && input.stop.every((s) => typeof s === 'string') ? (input.stop as string[]) : undefined

  return {
    model: normalizeLegacyOpenAIModelId(input.model),
    prompt: flattenForLegacyInstruct(input.messages as RawChatMessage[]),
    apiKey: input.apiKey,
    baseUrl,
    maxTokens,
    temperature,
    topP,
    presencePenalty,
    frequencyPenalty,
    stop,
    extraHeaders: input.extraHeaders,
    additionalParams: input.additionalParams,
    signal: input.signal,
  }
}

function endpoint(req: OpenAILegacyInstructRequest): string {
  const base = req.baseUrl.endsWith('/') ? req.baseUrl.slice(0, -1) : req.baseUrl
  return `${base}/completions`
}

function buildHeaders(req: OpenAILegacyInstructRequest): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${req.apiKey}`,
    ...(req.extraHeaders ?? {}),
  }
}

function buildRequestInit(req: OpenAILegacyInstructRequest): { body: string; headers: Record<string, string> } {
  const body = buildPayload(req)
  const headers = buildHeaders(req)
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  setCanonicalHeader(headers, 'authorization', `Bearer ${req.apiKey}`)
  return { body: JSON.stringify(body), headers }
}

function buildPayload(req: OpenAILegacyInstructRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    stop: req.stop ?? DEFAULT_STOP,
    top_p: req.topP ?? 1,
  }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.presencePenalty !== undefined) body.presence_penalty = req.presencePenalty
  if (req.frequencyPenalty !== undefined) body.frequency_penalty = req.frequencyPenalty
  return body
}

interface LegacyInstructResponse {
  choices?: Array<{ text?: unknown }>
  model?: unknown
  error?: { message?: unknown }
}

async function runOpenAILegacyInstructCore(req: OpenAILegacyInstructRequest): Promise<CompletionResult> {
  if (req.signal.aborted) {
    return { type: 'fail', result: 'aborted', aborted: true }
  }

  const init = buildRequestInit(req)
  let response: Response
  try {
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

  let body: LegacyInstructResponse
  try {
    body = (await readBoundedBodyJson(response)) as LegacyInstructResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

  if (!response.ok) {
    const upstreamMsg = typeof body.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`
    return { type: 'fail', result: upstreamMsg }
  }

  const text = body.choices?.[0]?.text
  if (typeof text !== 'string') {
    return { type: 'fail', result: 'upstream returned no completion text' }
  }
  // The local code strips `##\n` markers from the response since the prompt
  // formatting can leak them back in the model's output.
  const result: CompletionResult = { type: 'success', result: text.replace(/##\n/g, '') }
  if (typeof body.model === 'string') result.model = body.model
  const apiMetadata = extractApiResponseMetadata(body, ['choices', 'error', 'model'])
  if (apiMetadata) result.apiMetadata = apiMetadata
  return result
}

export function runOpenAILegacyInstruct(req: OpenAILegacyInstructRequest): Promise<CompletionResult> {
  return observeProviderResult('openai', req.signal, () => runOpenAILegacyInstructCore(req))
}
