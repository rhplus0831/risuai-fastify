import { observeProviderResult, providerDiagnosticFetch } from './providerDiagnostics.js'
import { applyAdditionalParameters } from './additionalParams.js'
import type { CompletionResult } from './frames.js'
import { extractApiResponseMetadata } from './apiMetadata.js'
import { readBoundedBodyText } from './body.js'

export interface CohereRequest {
  model: string
  message: string
  chatHistory: CohereChatHistoryEntry[]
  preamble?: string
  apiKey: string
  baseUrl: string
  safetyMode?: 'NONE' | 'CONTEXTUAL' | 'STRICT'
  temperature?: number
  topK?: number
  topP?: number
  presencePenalty?: number
  frequencyPenalty?: number
  /**
   * Headers to merge into the upstream request. Used by reverse_proxy to
   * forward `X-Proxy-Risu: RisuAI` when the user prefixed their URL with
   * `risu::`.
   */
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

export interface CohereChatHistoryEntry {
  role: 'USER' | 'CHATBOT' | 'SYSTEM'
  message: string
}

interface CohereResolveInput {
  model?: unknown
  messages?: unknown
  apiKey?: unknown
  baseUrl?: unknown
  safetyMode?: unknown
  temperature?: unknown
  topK?: unknown
  topP?: unknown
  presencePenalty?: unknown
  frequencyPenalty?: unknown
  extraHeaders?: Record<string, string>
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface RawChatMessage {
  role?: unknown
  content?: unknown
}

const DEFAULT_BASE_URL = 'https://api.cohere.com/v1'

const VALID_SAFETY_MODES = new Set(['NONE', 'CONTEXTUAL', 'STRICT'])

/**
 * Cohere splits a conversation into three parts: a single trailing `message`
 * (the latest user turn), prior turns under `chat_history`, and an optional
 * `preamble` lifted from a leading system message. Mirrors the local browser
 * `requestCohere` path.
 */
export interface CohereReformatResult {
  message: string
  chatHistory: CohereChatHistoryEntry[]
  preamble?: string
  ok: true
}

export interface CohereReformatFailure {
  ok: false
  reason: string
}

export function reformatForCohere(messages: RawChatMessage[]): CohereReformatResult | CohereReformatFailure {
  const working: RawChatMessage[] = [...messages]
  if (working.length === 0) {
    return { ok: false, reason: 'cohere requires at least one user message' }
  }

  // Take the trailing user message as the `message`. If the last row is not a
  // user turn, the local path keeps popping (and concatenating) until it finds
  // one. If we run out, the conversation has no user message at all.
  let lastChatPrompt = ''
  let last = working.pop()!
  if (last.role === 'user' && typeof last.content === 'string') {
    lastChatPrompt = last.content
  } else {
    let popped: RawChatMessage | undefined = last
    while (popped && popped.role !== 'user') {
      const content = typeof popped.content === 'string' ? popped.content : ''
      const prefix = popped.role === 'user' ? '' : `${String(popped.role)}: `
      lastChatPrompt = `${prefix}\n${content}${lastChatPrompt}`
      popped = working.pop()
    }
    if (!popped) {
      return {
        ok: false,
        reason: 'cohere requires a user message to generate a response',
      }
    }
    const content = typeof popped.content === 'string' ? popped.content : ''
    lastChatPrompt = content + lastChatPrompt
  }

  // First message stays as the preamble when it's a system row.
  let preamble: string | undefined
  if (working.length > 0 && working[0].role === 'system') {
    const c = working[0].content
    if (typeof c === 'string') preamble = c
    working.shift()
  }

  const chatHistory: CohereChatHistoryEntry[] = []
  for (const m of working) {
    if (typeof m.content !== 'string' || m.content.length === 0) continue
    if (m.role === 'assistant') {
      chatHistory.push({ role: 'CHATBOT', message: m.content })
    } else if (m.role === 'system') {
      chatHistory.push({ role: 'SYSTEM', message: m.content })
    } else if (m.role === 'user') {
      chatHistory.push({ role: 'USER', message: m.content })
    }
    // function / tool roles are dropped, matching the local filter.
  }

  return { ok: true, message: lastChatPrompt, chatHistory, preamble }
}

export function resolveCohereRequest(input: CohereResolveInput): CohereRequest | null {
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  if (!Array.isArray(input.messages)) return null
  if (typeof input.apiKey !== 'string' || input.apiKey.length === 0) return null

  const reformat = reformatForCohere(input.messages as RawChatMessage[])
  if (!reformat.ok) return null

  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.length > 0 ? input.baseUrl : DEFAULT_BASE_URL
  const safetyMode =
    typeof input.safetyMode === 'string' && VALID_SAFETY_MODES.has(input.safetyMode)
      ? (input.safetyMode as 'NONE' | 'CONTEXTUAL' | 'STRICT')
      : undefined
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const topK = typeof input.topK === 'number' && Number.isFinite(input.topK) ? input.topK : undefined
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined
  const presencePenalty =
    typeof input.presencePenalty === 'number' && Number.isFinite(input.presencePenalty)
      ? input.presencePenalty
      : undefined
  const frequencyPenalty =
    typeof input.frequencyPenalty === 'number' && Number.isFinite(input.frequencyPenalty)
      ? input.frequencyPenalty
      : undefined

  return {
    model: input.model,
    message: reformat.message,
    chatHistory: reformat.chatHistory,
    preamble: reformat.preamble,
    apiKey: input.apiKey,
    baseUrl,
    safetyMode,
    temperature,
    topK,
    topP,
    presencePenalty,
    frequencyPenalty,
    extraHeaders: input.extraHeaders,
    additionalParams: input.additionalParams,
    signal: input.signal,
  }
}

function buildPayload(req: CohereRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    message: req.message,
    chat_history: req.chatHistory,
  }
  if (req.preamble !== undefined) {
    if (req.chatHistory.length > 0) {
      body.preamble = req.preamble
    } else {
      // No history → fold the preamble into the message with a `system:` prefix,
      // matching the local fallback for one-shot conversations.
      body.message = `system: ${req.preamble}`
    }
  }
  if (req.safetyMode !== undefined) body.safety_mode = req.safetyMode
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.topK !== undefined) body.k = req.topK
  if (req.topP !== undefined) body.p = req.topP
  if (req.presencePenalty !== undefined) body.presence_penalty = req.presencePenalty
  if (req.frequencyPenalty !== undefined) body.frequency_penalty = req.frequencyPenalty
  return body
}

function endpoint(req: CohereRequest): string {
  const base = req.baseUrl.endsWith('/') ? req.baseUrl.slice(0, -1) : req.baseUrl
  return `${base}/chat`
}

function buildHeaders(req: CohereRequest): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${req.apiKey}`,
  }
  if (req.extraHeaders !== undefined) {
    for (const [k, v] of Object.entries(req.extraHeaders)) headers[k] = v
  }
  return headers
}

function buildRequestInit(req: CohereRequest): { body: string; headers: Record<string, string> } {
  const body = buildPayload(req)
  const headers = buildHeaders(req)
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  return { body: JSON.stringify(body), headers }
}

interface CohereResponse {
  text?: unknown
  generation_id?: unknown
  finish_reason?: unknown
  message?: { content?: Array<{ text?: unknown }> }
}

async function runCohereCore(req: CohereRequest): Promise<CompletionResult> {
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

  let raw: string
  try {
    raw = await readBoundedBodyText(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream body: ${msg}` }
  }

  if (!response.ok) {
    // Cohere returns errors as arbitrary JSON; the local path stringifies the
    // whole body. Preserve that since each error shape has its own surface.
    return { type: 'fail', result: raw }
  }

  let body: CohereResponse
  try {
    body = JSON.parse(raw) as CohereResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

  if (typeof body.text === 'string' && body.text.length > 0) {
    const apiMetadata = extractApiResponseMetadata(body, ['text', 'message'])
    return { type: 'success', result: body.text, ...(apiMetadata ? { apiMetadata } : {}) }
  }
  // The v2 /chat shape lives behind a different endpoint, but if a caller's
  // proxy returns it the content blocks are an array under message.content.
  if (Array.isArray(body.message?.content)) {
    let text = ''
    for (const block of body.message.content) {
      if (typeof block.text === 'string') text += block.text
    }
    if (text.length > 0) {
      const apiMetadata = extractApiResponseMetadata(body, ['text', 'message'])
      return { type: 'success', result: text, ...(apiMetadata ? { apiMetadata } : {}) }
    }
  }
  return { type: 'fail', result: raw }
}

export function runCohere(req: CohereRequest): Promise<CompletionResult> {
  return observeProviderResult('cohere', req.signal, () => runCohereCore(req))
}
