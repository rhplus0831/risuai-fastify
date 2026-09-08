import {
  observeProviderResult,
  providerDiagnosticFetch,
  observeProviderStream,
  providerDiagnosticRead,
  recordProviderDiagnosticTerminal,
  recordProviderDiagnosticToken,
  recordProviderDiagnosticFailure,
} from './providerDiagnostics.js'
import { applyAdditionalParameters } from './additionalParams.js'
import type { CompletionResult, CompletionStreamFrame } from './frames.js'
import {
  STREAM_BUFFER_OVERFLOW_ERROR,
  hasNonIgnorableSseTail,
  popSseEventBlock,
  streamBufferExceedsCap,
} from './sse.js'
import { readBoundedBodyJson, readBoundedBodyText } from './body.js'
import { formatUpstreamFetchError, formatUpstreamHttpError, upstreamStatusText } from './upstreamError.js'
import type { ServerToolDefinition, ServerToolRound } from '@risuai/protocol/server-tool'
import { anthropicToolDefinitions, appendAnthropicToolRounds, parseAnthropicToolCalls } from './serverTools.js'
import { extractApiResponseMetadata, mergeApiResponseMetadata } from './apiMetadata.js'

export interface AnthropicRequest {
  model: string
  messages: unknown[]
  apiKey: string
  baseUrl: string
  version: string
  maxTokens: number
  system?: string
  temperature?: number
  topP?: number
  topK?: number
  thinkingTokens?: number
  thinkingType?: 'off' | 'budget' | 'adaptive'
  adaptiveThinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  supportsAdaptiveThinking?: boolean
  supportsXHighEffort?: boolean
  oneHourCache?: boolean
  extraHeaders?: Record<string, string>
  /**
   * Pre-validated `[key, value][]` pairs from the SPA's additionalParams /
   * xcustom `params` DSL. Applied after the dispatcher builds its default
   * body + headers, so the user DSL has the last word. See
   * `./additionalParams.ts` for semantics.
   */
  additionalParams?: Array<[string, string]>
  tools?: ServerToolDefinition[]
  signal: AbortSignal
}

interface AnthropicResolveInput {
  model?: unknown
  messages?: unknown
  apiKey?: unknown
  baseUrl?: unknown
  version?: unknown
  maxTokens?: unknown
  system?: unknown
  temperature?: unknown
  topP?: unknown
  topK?: unknown
  thinkingTokens?: unknown
  thinkingType?: unknown
  adaptiveThinkingEffort?: unknown
  supportsAdaptiveThinking?: unknown
  supportsXHighEffort?: unknown
  oneHourCache?: unknown
  extraHeaders?: Record<string, string>
  additionalParams?: Array<[string, string]>
  tools?: ServerToolDefinition[]
  toolRounds?: ServerToolRound[]
  signal: AbortSignal
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'
const DEFAULT_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 1024

export function resolveAnthropicRequest(input: AnthropicResolveInput): AnthropicRequest | null {
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  if (!Array.isArray(input.messages)) return null
  if (typeof input.apiKey !== 'string' || input.apiKey.length === 0) return null

  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.length > 0 ? input.baseUrl : DEFAULT_BASE_URL
  const version = typeof input.version === 'string' && input.version.length > 0 ? input.version : DEFAULT_VERSION
  const maxTokens =
    typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : DEFAULT_MAX_TOKENS
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined
  const topK = typeof input.topK === 'number' && Number.isFinite(input.topK) ? input.topK : undefined
  const thinkingTokens =
    typeof input.thinkingTokens === 'number' && Number.isFinite(input.thinkingTokens) && input.thinkingTokens > 0
      ? input.thinkingTokens
      : undefined
  const thinkingType =
    input.thinkingType === 'off' || input.thinkingType === 'budget' || input.thinkingType === 'adaptive'
      ? input.thinkingType
      : undefined
  const adaptiveThinkingEffort =
    input.adaptiveThinkingEffort === 'low' ||
    input.adaptiveThinkingEffort === 'medium' ||
    input.adaptiveThinkingEffort === 'high' ||
    input.adaptiveThinkingEffort === 'xhigh' ||
    input.adaptiveThinkingEffort === 'max'
      ? input.adaptiveThinkingEffort
      : undefined
  const system = typeof input.system === 'string' && input.system.length > 0 ? input.system : undefined

  return {
    model: input.model,
    messages: appendAnthropicToolRounds(input.messages, input.toolRounds ?? []),
    apiKey: input.apiKey,
    baseUrl,
    version,
    maxTokens,
    system,
    temperature,
    topP,
    topK,
    thinkingTokens,
    thinkingType,
    adaptiveThinkingEffort,
    supportsAdaptiveThinking: input.supportsAdaptiveThinking === true,
    supportsXHighEffort: input.supportsXHighEffort === true,
    oneHourCache: input.oneHourCache === true,
    extraHeaders: input.extraHeaders,
    additionalParams: input.additionalParams,
    tools: input.tools,
    signal: input.signal,
  }
}

function buildPayload(req: AnthropicRequest, stream: boolean): Record<string, unknown> {
  const hasTools = (req.tools?.length ?? 0) > 0
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    stream,
  }
  if (req.system !== undefined) body.system = req.system
  if (req.tools !== undefined && req.tools.length > 0) body.tools = anthropicToolDefinitions(req.tools)
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.topP !== undefined) body.top_p = req.topP
  if (req.topK !== undefined) body.top_k = req.topK
  if (!hasTools && req.thinkingType === 'adaptive' && req.supportsAdaptiveThinking) {
    const effort =
      req.adaptiveThinkingEffort === 'xhigh' && !req.supportsXHighEffort
        ? 'high'
        : (req.adaptiveThinkingEffort ?? 'high')
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort }
    delete body.temperature
    delete body.top_p
    delete body.top_k
  } else if (!hasTools && req.thinkingType !== 'off' && req.thinkingTokens !== undefined) {
    body.thinking = { type: 'enabled', budget_tokens: req.thinkingTokens, display: 'summarized' }
    delete body.temperature
    delete body.top_p
    delete body.top_k
  }
  return body
}

function endpoint(req: AnthropicRequest): string {
  const base = req.baseUrl.endsWith('/') ? req.baseUrl.slice(0, -1) : req.baseUrl
  return `${base}/messages`
}

function buildHeaders(req: AnthropicRequest): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': req.apiKey,
    'anthropic-version': req.version,
    ...(req.extraHeaders ?? {}),
  }
  const hasAnthropicBeta = Object.keys(headers).some((key) => key.toLocaleLowerCase() === 'anthropic-beta')
  const hasAdditionalParamBeta = req.additionalParams?.some(
    ([key]) => key.startsWith('header::') && key.slice('header::'.length).toLocaleLowerCase() === 'anthropic-beta',
  )
  if (req.oneHourCache && !hasAnthropicBeta && !hasAdditionalParamBeta) {
    headers['anthropic-beta'] = 'extended-cache-ttl-2025-04-11'
  }
  return headers
}

function buildRequestInit(req: AnthropicRequest, stream: boolean): { body: string; headers: Record<string, string> } {
  const body = buildPayload(req, stream)
  const headers = buildHeaders(req)
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  body.stream = stream
  if (req.tools !== undefined && req.tools.length > 0) {
    // Extended-thinking blocks carry signatures that this bounded browser
    // round-trip intentionally does not retain. Keep tool turns compatible,
    // and prevent additionalParams from widening the supplied tool set or
    // re-enabling thinking behind the protocol's back.
    body.tools = anthropicToolDefinitions(req.tools)
    delete body.thinking
    delete body.output_config
  }
  return { body: JSON.stringify(body), headers }
}

interface AnthropicContentBlock {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  model?: unknown
  stop_reason?: unknown
  error?: { message?: unknown; type?: unknown }
}

async function runAnthropicCore(req: AnthropicRequest): Promise<CompletionResult> {
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

  let body: AnthropicResponse
  try {
    body = (await readBoundedBodyJson(response)) as AnthropicResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

  if (!response.ok) {
    const upstreamMsg = typeof body.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`
    return { type: 'fail', result: upstreamMsg }
  }

  const apiMetadata = extractApiResponseMetadata(body, ['content', 'error', 'model', 'stop_reason'])

  // Preserve summarized/reasoning blocks in the shared `<Thoughts>` envelope,
  // matching the browser provider path so the response parser can retain them.
  let text = ''
  let thinkingOpen = false
  if (Array.isArray(body.content)) {
    for (const block of body.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (thinkingOpen) {
          text += '</Thoughts>\n\n'
          thinkingOpen = false
        }
        text += block.text
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        if (!thinkingOpen) {
          text += '<Thoughts>\n'
          thinkingOpen = true
        }
        text += block.thinking
      } else if (block.type === 'redacted_thinking') {
        if (!thinkingOpen) {
          text += '<Thoughts>\n'
          thinkingOpen = true
        }
        text += '\n{{redacted_thinking}}\n'
      }
    }
  }
  if (thinkingOpen) text += '</Thoughts>\n\n'
  const hasToolUse = body.content?.some((block) => block.type === 'tool_use') === true
  if (hasToolUse) {
    if (!req.tools || req.tools.length === 0) {
      return { type: 'fail', result: 'upstream returned tool calls when no tools were supplied' }
    }
    const parsed = parseAnthropicToolCalls(body.content, new Set(req.tools.map((tool) => tool.name)))
    if (parsed.ok === false) return { type: 'fail', result: `invalid upstream tool call: ${parsed.error}` }
    const result: CompletionResult = { type: 'success', result: text, toolCalls: parsed.value }
    if (typeof body.model === 'string') result.model = body.model
    if (apiMetadata) result.apiMetadata = apiMetadata
    return result
  }
  if (text.length === 0) {
    return { type: 'fail', result: 'upstream returned no text content' }
  }

  const result: CompletionResult = { type: 'success', result: text }
  if (typeof body.model === 'string') result.model = body.model
  if (apiMetadata) result.apiMetadata = apiMetadata
  return result
}

interface AnthropicStreamEvent {
  event: string
  data: string
}

interface AnthropicDelta {
  type?: unknown
  text?: unknown
  thinking?: unknown
  stop_reason?: unknown
}

interface AnthropicStreamFrame {
  type?: unknown
  message?: unknown
  delta?: AnthropicDelta
  error?: { message?: unknown; type?: unknown }
}

interface AnthropicErrorResponse {
  error?: { message?: unknown; type?: unknown }
}

function parseUpstreamEvent(block: string): AnthropicStreamEvent | null {
  let event = ''
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) data += line.slice(6)
  }
  if (!event) return null
  return { event, data }
}

function mapFinishReason(raw: unknown): CompletionStreamFrame['finishReason'] {
  if (typeof raw !== 'string' || raw.length === 0) return 'stop'
  if (raw === 'end_turn') return 'stop'
  if (raw === 'max_tokens') return 'length'
  if (raw === 'stop_sequence') return 'stop'
  return raw
}

async function readAnthropicStreamError(response: Response, url: string): Promise<CompletionStreamFrame> {
  let message: string | undefined
  let code: string | undefined
  try {
    const text = await readBoundedBodyText(response)
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as AnthropicErrorResponse
        if (typeof parsed.error?.message === 'string' && parsed.error.message.length > 0) {
          message = parsed.error.message
        }
        if (typeof parsed.error?.type === 'string' && parsed.error.type.length > 0) {
          code = parsed.error.type
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

async function* runAnthropicStreamCore(req: AnthropicRequest): AsyncGenerator<CompletionStreamFrame, void, void> {
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
    yield await readAnthropicStreamError(response, url)
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
  let sawStop = false
  let thinkingOpen = false
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

      let eventBlock = popSseEventBlock(buf)
      while (eventBlock !== null) {
        const { block } = eventBlock
        buf = eventBlock.rest
        eventBlock = popSseEventBlock(buf)
        const evt = parseUpstreamEvent(block)
        if (!evt) continue

        let frame: AnthropicStreamFrame | undefined
        try {
          frame = JSON.parse(evt.data) as AnthropicStreamFrame
        } catch (err) {
          if (
            evt.event === 'message_start' ||
            evt.event === 'content_block_delta' ||
            evt.event === 'message_delta' ||
            evt.event === 'error'
          ) {
            const msg = err instanceof Error ? err.message : String(err)
            yield { kind: 'error', error: `invalid upstream stream JSON: ${msg}` }
            return
          }
        }

        if (frame?.type === 'error' || evt.event === 'error') {
          recordProviderDiagnosticFailure('unknown-error')
          const message =
            typeof frame?.error?.message === 'string' && frame.error.message.length > 0
              ? frame.error.message
              : 'Anthropic stream failed without an error message.'
          const code =
            typeof frame?.error?.type === 'string' && frame.error.type.length > 0 ? frame.error.type : undefined
          yield { kind: 'error', error: message, ...(code ? { code } : {}) }
          return
        }

        if (evt.event === 'message_start') {
          apiMetadata = mergeApiResponseMetadata(apiMetadata, extractApiResponseMetadata(frame?.message, ['content']))
        } else if (evt.event === 'content_block_delta') {
          const t = frame?.delta?.text
          if (
            (frame?.delta?.type === 'text' || frame?.delta?.type === 'text_delta') &&
            typeof t === 'string' &&
            t.length > 0
          ) {
            recordProviderDiagnosticToken()
            if (thinkingOpen) {
              thinkingOpen = false
              yield { kind: 'token', content: '</Thoughts>\n\n' }
            }
            yield { kind: 'token', content: t }
          } else if (
            (frame?.delta?.type === 'thinking' || frame?.delta?.type === 'thinking_delta') &&
            typeof frame.delta.thinking === 'string'
          ) {
            recordProviderDiagnosticToken()
            if (!thinkingOpen) {
              thinkingOpen = true
              yield { kind: 'token', content: '<Thoughts>\n' }
            }
            yield { kind: 'token', content: frame.delta.thinking }
          } else if (frame?.delta?.type === 'redacted_thinking') {
            recordProviderDiagnosticToken()
            if (!thinkingOpen) {
              thinkingOpen = true
              yield { kind: 'token', content: '<Thoughts>\n' }
            }
            yield { kind: 'token', content: '\n{{redacted_thinking}}\n' }
          }
        } else if (evt.event === 'message_delta') {
          apiMetadata = mergeApiResponseMetadata(apiMetadata, extractApiResponseMetadata(frame, ['delta']))
          if (frame?.delta?.stop_reason !== undefined) {
            recordProviderDiagnosticTerminal()
            finishReason = mapFinishReason(frame.delta.stop_reason)
          }
        } else if (evt.event === 'message_stop') {
          recordProviderDiagnosticTerminal()
          sawStop = true
          if (thinkingOpen) yield { kind: 'token', content: '</Thoughts>\n\n' }
          yield { kind: 'done', finishReason, ...(apiMetadata ? { apiMetadata } : {}) }
          return
        }
        // content_block_start / content_block_stop / ping: ignore
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

  if (!sawStop && !req.signal.aborted) {
    buf += decoder.decode()
    if (hasNonIgnorableSseTail(buf)) {
      yield { kind: 'error', error: 'truncated upstream stream event' }
      return
    }
    if (thinkingOpen) yield { kind: 'token', content: '</Thoughts>\n\n' }
    yield { kind: 'done', finishReason, ...(apiMetadata ? { apiMetadata } : {}) }
  }
}

export function runAnthropic(req: AnthropicRequest): Promise<CompletionResult> {
  return observeProviderResult('anthropic', req.signal, () => runAnthropicCore(req))
}

export function runAnthropicStream(req: AnthropicRequest): AsyncGenerator<CompletionStreamFrame, void, void> {
  return observeProviderStream('anthropic', req.signal, () => runAnthropicStreamCore(req))
}
