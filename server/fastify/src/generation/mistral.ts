import {
  observeProviderResult,
  providerDiagnosticFetch,
  observeProviderStream,
  providerDiagnosticRead,
  recordProviderDiagnosticTerminal,
  recordProviderDiagnosticToken,
} from './providerDiagnostics.js'
import { applyAdditionalParameters } from './additionalParams.js'
import type { CompletionResult, CompletionStreamFrame } from './frames.js'
import { parseOpenAIStyleSseData } from './openai.js'
import {
  STREAM_BUFFER_OVERFLOW_ERROR,
  hasNonIgnorableSseTail,
  popSseEventBlock,
  streamBufferExceedsCap,
} from './sse.js'
import { readBoundedBodyJson, readBoundedBodyText } from './body.js'
import { formatUpstreamFetchError, formatUpstreamHttpError, upstreamStatusText } from './upstreamError.js'
import { extractApiResponseMetadata, mergeApiResponseMetadata } from './apiMetadata.js'

export interface MistralRequest {
  model: string
  messages: MistralChatMessage[]
  apiKey: string
  baseUrl: string
  safePrompt: boolean
  maxTokens?: number
  temperature?: number
  presencePenalty?: number
  frequencyPenalty?: number
  topP?: number
  /**
   * Extra request headers merged into the upstream request. Used by
   * `reverse_proxy` to forward `X-Proxy-Risu: RisuAI` when the user
   * prefixed their URL with `risu::`.
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

interface MistralResolveInput {
  model?: unknown
  messages?: unknown
  apiKey?: unknown
  baseUrl?: unknown
  safePrompt?: unknown
  maxTokens?: unknown
  temperature?: unknown
  presencePenalty?: unknown
  frequencyPenalty?: unknown
  topP?: unknown
  extraHeaders?: Record<string, string>
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface RawChatMessage {
  role?: unknown
  content?: unknown
}

export interface MistralChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const DEFAULT_BASE_URL = 'https://api.mistral.ai/v1'

/**
 * Mistral enforces a stricter conversation shape than OpenAI: roles must
 * alternate, the first message cannot be assistant, and the only valid roles
 * are system / user / assistant. Coalesce consecutive same-role messages,
 * inline `system` content into the surrounding user turn, and demote
 * `function` rows to user. Mirrors the Mistral branch of the local browser
 * `requestOpenAI` path.
 */
export function reformatForMistral(messages: RawChatMessage[]): MistralChatMessage[] {
  const out: MistralChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const chat = messages[i]
    const role = typeof chat.role === 'string' ? chat.role : ''
    const content = typeof chat.content === 'string' ? chat.content : ''
    if (i === 0) {
      if (role === 'user' || role === 'system') {
        out.push({ role, content })
      } else {
        out.push({ role: 'system', content: `${role}:${content}` })
      }
      continue
    }
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.role === role && (role === 'user' || role === 'assistant' || role === 'system')) {
      prev.content += `\n${content}`
      continue
    }
    if (role === 'system') {
      if (prev !== undefined && prev.role === 'user') {
        prev.content += `\nSystem:${content}`
      } else {
        out.push({ role: 'user', content: `System:${content}` })
      }
      continue
    }
    if (role === 'function') {
      out.push({ role: 'user', content })
      continue
    }
    if (role === 'user' || role === 'assistant') {
      out.push({ role, content })
    } else {
      // Unknown role: drop into user turn rather than discard the text.
      out.push({ role: 'user', content })
    }
  }
  return out
}

export function resolveMistralRequest(input: MistralResolveInput): MistralRequest | null {
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  if (!Array.isArray(input.messages)) return null
  if (typeof input.apiKey !== 'string' || input.apiKey.length === 0) return null

  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.length > 0 ? input.baseUrl : DEFAULT_BASE_URL
  const safePrompt = input.safePrompt === true
  const maxTokens =
    typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : undefined
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const presencePenalty =
    typeof input.presencePenalty === 'number' && Number.isFinite(input.presencePenalty)
      ? input.presencePenalty
      : undefined
  const frequencyPenalty =
    typeof input.frequencyPenalty === 'number' && Number.isFinite(input.frequencyPenalty)
      ? input.frequencyPenalty
      : undefined
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined

  return {
    model: input.model,
    messages: reformatForMistral(input.messages as RawChatMessage[]),
    apiKey: input.apiKey,
    baseUrl,
    safePrompt,
    maxTokens,
    temperature,
    presencePenalty,
    frequencyPenalty,
    topP,
    extraHeaders: input.extraHeaders,
    additionalParams: input.additionalParams,
    signal: input.signal,
  }
}

function buildPayload(req: MistralRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    safe_prompt: req.safePrompt,
    stream,
  }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.presencePenalty !== undefined) body.presence_penalty = req.presencePenalty
  if (req.frequencyPenalty !== undefined) body.frequency_penalty = req.frequencyPenalty
  if (req.topP !== undefined) body.top_p = req.topP
  return body
}

function endpoint(req: MistralRequest): string {
  const base = req.baseUrl.endsWith('/') ? req.baseUrl.slice(0, -1) : req.baseUrl
  return `${base}/chat/completions`
}

function buildHeaders(req: MistralRequest): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${req.apiKey}`,
  }
  if (req.extraHeaders !== undefined) {
    for (const [k, v] of Object.entries(req.extraHeaders)) headers[k] = v
  }
  return headers
}

function buildRequestInit(req: MistralRequest, stream: boolean): { body: string; headers: Record<string, string> } {
  const body = buildPayload(req, stream)
  const headers = buildHeaders(req)
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  body.stream = stream
  return { body: JSON.stringify(body), headers }
}

interface MistralNonStreamChoice {
  message?: { content?: unknown }
  finish_reason?: unknown
}

interface MistralNonStreamResponse {
  choices?: MistralNonStreamChoice[]
  model?: unknown
  error?: { message?: unknown; code?: unknown }
}

async function runMistralCore(req: MistralRequest): Promise<CompletionResult> {
  if (req.signal.aborted) {
    return { type: 'fail', result: 'aborted', aborted: true }
  }

  const init = buildRequestInit(req, false)
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

  let body: MistralNonStreamResponse
  try {
    body = (await readBoundedBodyJson(response)) as MistralNonStreamResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

  const apiMetadata = extractApiResponseMetadata(body, ['choices', 'error', 'model'])

  if (!response.ok) {
    const upstreamMsg = typeof body.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`
    return { type: 'fail', result: upstreamMsg }
  }

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined
  const content = choice?.message?.content
  if (typeof content !== 'string') {
    return { type: 'fail', result: 'upstream returned no content' }
  }

  const result: CompletionResult = { type: 'success', result: content }
  if (typeof body.model === 'string') result.model = body.model
  if (apiMetadata) result.apiMetadata = apiMetadata
  return result
}

interface MistralDelta {
  content?: unknown
}

interface MistralStreamChoice {
  delta?: MistralDelta
  finish_reason?: unknown
}

interface MistralStreamFrame {
  choices?: MistralStreamChoice[]
}

interface MistralErrorResponse {
  error?: { message?: unknown; code?: unknown }
}

function mapFinishReason(raw: unknown): CompletionStreamFrame['finishReason'] {
  if (typeof raw !== 'string' || raw.length === 0) return 'stop'
  return raw
}

async function readMistralStreamError(response: Response, url: string): Promise<CompletionStreamFrame> {
  let message: string | undefined
  let code: string | undefined
  try {
    const text = await readBoundedBodyText(response)
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as MistralErrorResponse
        if (typeof parsed.error?.message === 'string' && parsed.error.message.length > 0) {
          message = parsed.error.message
        }
        if (typeof parsed.error?.code === 'string' && parsed.error.code.length > 0) {
          code = parsed.error.code
        }
      } catch {
        message = text
      }
    }
  } catch {
    // Keep the HTTP status fallback.
  }
  const statusText = upstreamStatusText(response)
  return {
    kind: 'error',
    error: formatUpstreamHttpError(response, url, { message, code }),
    status: response.status,
    ...(statusText ? { statusText } : {}),
    ...(code ? { code } : {}),
  }
}

async function* runMistralStreamCore(req: MistralRequest): AsyncGenerator<CompletionStreamFrame, void, void> {
  if (req.signal.aborted) return

  const init = buildRequestInit(req, true)
  const url = endpoint(req)
  let response: Response
  try {
    response = await providerDiagnosticFetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal.aborted) return
    const msg = err instanceof Error ? err.message : String(err)
    yield { kind: 'error', error: formatUpstreamFetchError(url, msg), code: 'fetch_failed' }
    return
  }

  if (!response.ok) {
    yield await readMistralStreamError(response, url)
    return
  }

  if (!response.body) {
    const statusText = upstreamStatusText(response)
    yield {
      kind: 'error',
      error: formatUpstreamHttpError(response, url, { message: 'upstream returned no stream body' }),
      status: response.status,
      ...(statusText ? { statusText } : {}),
    }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finishReason: CompletionStreamFrame['finishReason'] = 'stop'
  let apiMetadata: Record<string, unknown> | undefined

  try {
    while (true) {
      if (req.signal.aborted) return
      let readResult: ReadableStreamReadResult<Uint8Array>
      try {
        readResult = await providerDiagnosticRead(reader)
      } catch (err) {
        if (req.signal.aborted) return
        const msg = err instanceof Error ? err.message : String(err)
        yield { kind: 'error', error: `upstream stream read failed: ${msg}` }
        return
      }
      const { value, done } = readResult
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let evt = popSseEventBlock(buf)
      while (evt !== null) {
        const { block } = evt
        buf = evt.rest
        const data = parseOpenAIStyleSseData(block)
        evt = popSseEventBlock(buf)
        if (data === null) continue
        if (data.trim() === '[DONE]') {
          recordProviderDiagnosticTerminal()
          yield { kind: 'done', finishReason, ...(apiMetadata ? { apiMetadata } : {}) }
          return
        }
        let frame: MistralStreamFrame
        try {
          frame = JSON.parse(data) as MistralStreamFrame
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          yield { kind: 'error', error: `invalid upstream stream JSON: ${msg}` }
          return
        }
        apiMetadata = mergeApiResponseMetadata(apiMetadata, extractApiResponseMetadata(frame, ['choices', 'error']))
        const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined
        const delta = choice?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          recordProviderDiagnosticToken()
          yield { kind: 'token', content: delta }
        }
        if (choice?.finish_reason) {
          recordProviderDiagnosticTerminal()
          finishReason = mapFinishReason(choice.finish_reason)
        }
      }
      // Post-drain the buffer holds at most one partial event; a
      // delimiter-less upstream must not grow it unbounded.
      if (streamBufferExceedsCap(buf)) {
        yield { kind: 'error', error: STREAM_BUFFER_OVERFLOW_ERROR }
        return
      }
    }
  } finally {
    reader.cancel().catch(() => {
      // swallow
    })
  }

  if (!req.signal.aborted) {
    buf += decoder.decode()
    if (hasNonIgnorableSseTail(buf)) {
      yield { kind: 'error', error: 'truncated upstream stream event' }
      return
    }
    yield { kind: 'done', finishReason, ...(apiMetadata ? { apiMetadata } : {}) }
  }
}

export function runMistral(req: MistralRequest): Promise<CompletionResult> {
  return observeProviderResult('mistral', req.signal, () => runMistralCore(req))
}

export function runMistralStream(req: MistralRequest): AsyncGenerator<CompletionStreamFrame, void, void> {
  return observeProviderStream('mistral', req.signal, () => runMistralStreamCore(req))
}
