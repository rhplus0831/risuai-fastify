import {
  observeProviderResult,
  providerDiagnosticFetch,
  observeProviderStream,
  providerDiagnosticRead,
  recordProviderDiagnosticTerminal,
  recordProviderDiagnosticToken,
} from './providerDiagnostics.js'
import { applyAdditionalParameters, setCanonicalHeader } from './additionalParams.js'
import { emitProtocolMetric } from '../protocolMetrics.js'
import type { CompletionResult, CompletionStreamFrame } from './frames.js'
import { providerBodyMetricFields, summarizeOpenAIProviderBody } from './providerBodySummary.js'
import {
  STREAM_BUFFER_OVERFLOW_ERROR,
  hasNonIgnorableSseTail,
  popSseEventBlock,
  streamBufferExceedsCap,
} from './sse.js'
import { readBoundedBodyText } from './body.js'
import { formatUpstreamFetchError, formatUpstreamHttpError, upstreamStatusText } from './upstreamError.js'
import {
  generationTraceSidecarMetricField,
  writeGenerationTraceSidecar,
  type GenerationTraceContext,
} from './generationTraceSidecar.js'
import type { ServerToolDefinition } from '@risuai/protocol/server-tool'
import { openAIToolDefinitions, parseOpenAIToolCalls } from './serverTools.js'
import { extractApiResponseMetadata, mergeApiResponseMetadata } from './apiMetadata.js'
import { normalizeLegacyOpenAIModelId } from '@risuai/shared-core/legacy-openai-model-aliases'

export interface OpenAIRequest {
  model: string
  messages: unknown[]
  apiKey?: string
  baseUrl: string
  /** Exact Chat Completions endpoint for custom URLs that must not be autofilled. */
  endpointUrl?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  topA?: number
  repetitionPenalty?: number
  frequencyPenalty?: number
  presencePenalty?: number
  reasoningEffort?: string
  verbosity?: string
  serviceTier?: string
  routing?: string
  seed?: number
  responseFormat?: Record<string, unknown>
  prediction?: string
  openRouter?: {
    fallback?: boolean
    middleOut?: boolean
    provider?: { order?: string[]; only?: string[]; ignore?: string[] }
  }
  n?: number
  useCompletionTokens?: boolean
  thinking?: Record<string, unknown>
  deepSeekThinkingOutput?: boolean
  logitBias?: Record<string, number>
  extraHeaders?: Record<string, string>
  /**
   * Pre-validated `[key, value][]` pairs from the SPA's additionalParams /
   * xcustom `params` DSL. Applied to the body + headers after they're
   * constructed, so the user DSL has the last word. See
   * `./additionalParams.ts` for semantics.
   */
  additionalParams?: Array<[string, string]>
  /**
   * When true, every `role: 'system'` message is removed from the wire
   * payload and their contents are joined with `\n` into a single trailing
   * `role: 'system'` message. Mirrors the local SPA's
   * `db.reverseProxyOobaMode` handling in `requestOpenAI`. Only used by the
   * reverse_proxy route today.
   */
  oobaSystemHoist?: boolean
  /** Non-null Ooba WebUI chat arguments overlaid in persisted key order. */
  oobaArgs?: Record<string, unknown>
  trace?: GenerationTraceContext
  tools?: ServerToolDefinition[]
  signal: AbortSignal
}

interface OpenAIResolveInput {
  model?: unknown
  messages?: unknown
  apiKey?: unknown
  baseUrl?: unknown
  endpointUrl?: unknown
  maxTokens?: unknown
  temperature?: unknown
  topP?: unknown
  topK?: unknown
  minP?: unknown
  topA?: unknown
  repetitionPenalty?: unknown
  frequencyPenalty?: unknown
  presencePenalty?: unknown
  reasoningEffort?: unknown
  verbosity?: unknown
  serviceTier?: unknown
  flexProcessing?: unknown
  routing?: unknown
  seed?: unknown
  responseFormat?: unknown
  prediction?: unknown
  openRouter?: OpenAIRequest['openRouter']
  n?: unknown
  useCompletionTokens?: unknown
  thinking?: unknown
  deepSeekThinkingOutput?: unknown
  logitBias?: unknown
  extraHeaders?: Record<string, string>
  additionalParams?: Array<[string, string]>
  oobaSystemHoist?: boolean
  oobaArgs?: unknown
  trace?: GenerationTraceContext
  tools?: ServerToolDefinition[]
  signal: AbortSignal
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

function isOfficialOpenAIUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

export function resolveOpenAIRequest(input: OpenAIResolveInput): OpenAIRequest | null {
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  if (!Array.isArray(input.messages)) return null

  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.length > 0 ? input.baseUrl : DEFAULT_BASE_URL
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.length > 0 ? input.apiKey : undefined
  const maxTokens =
    typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : undefined
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const endpointUrl =
    typeof input.endpointUrl === 'string' && input.endpointUrl.length > 0 ? input.endpointUrl : undefined
  const serviceTier =
    typeof input.serviceTier === 'string'
      ? input.serviceTier
      : input.flexProcessing === true && isOfficialOpenAIUrl(endpointUrl ?? baseUrl)
        ? 'flex'
        : undefined

  const numeric = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

  return {
    model: normalizeLegacyOpenAIModelId(input.model),
    messages: input.messages,
    apiKey,
    baseUrl,
    endpointUrl,
    maxTokens,
    temperature,
    topP: numeric(input.topP),
    topK: numeric(input.topK),
    minP: numeric(input.minP),
    topA: numeric(input.topA),
    repetitionPenalty: numeric(input.repetitionPenalty),
    frequencyPenalty: numeric(input.frequencyPenalty),
    presencePenalty: numeric(input.presencePenalty),
    reasoningEffort: typeof input.reasoningEffort === 'string' ? input.reasoningEffort : undefined,
    verbosity: typeof input.verbosity === 'string' ? input.verbosity : undefined,
    serviceTier,
    routing: typeof input.routing === 'string' ? input.routing : undefined,
    seed: numeric(input.seed),
    responseFormat: record(input.responseFormat),
    prediction: typeof input.prediction === 'string' && input.prediction.length > 0 ? input.prediction : undefined,
    openRouter: input.openRouter,
    n: typeof input.n === 'number' && Number.isInteger(input.n) && input.n > 1 ? Math.min(input.n, 20) : undefined,
    useCompletionTokens: input.useCompletionTokens === true ? true : undefined,
    thinking: record(input.thinking),
    deepSeekThinkingOutput: input.deepSeekThinkingOutput === true,
    logitBias: record(input.logitBias) as Record<string, number> | undefined,
    extraHeaders: input.extraHeaders,
    additionalParams: input.additionalParams,
    oobaSystemHoist: input.oobaSystemHoist === true ? true : undefined,
    oobaArgs: record(input.oobaArgs),
    trace: input.trace,
    tools: input.tools,
    signal: input.signal,
  }
}

interface ChatMessage {
  role?: unknown
  content?: unknown
}

/**
 * Remove every `role: 'system'` row and append a single trailing system
 * row whose content is the joined original system contents. Mirrors
 * `db.reverseProxyOobaMode` in the SPA's `requestOpenAI`, with the empty-stub
 * cleanup (`db.newOAIHandle === true` default) folded in.
 */
export function applyOobaSystemHoist(messages: unknown[]): unknown[] {
  const systemTexts: string[] = []
  const passthrough: unknown[] = []
  for (const m of messages) {
    const row = m as ChatMessage
    if (row && row.role === 'system' && typeof row.content === 'string') {
      systemTexts.push(row.content)
      continue
    }
    passthrough.push(m)
  }
  if (systemTexts.length === 0) return messages
  return [...passthrough, { role: 'system', content: systemTexts.join('\n') }]
}

function buildPayload(req: OpenAIRequest, stream: boolean): Record<string, unknown> {
  const messages = req.oobaSystemHoist === true ? applyOobaSystemHoist(req.messages) : req.messages
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream,
  }
  if (req.maxTokens !== undefined) {
    body[req.useCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.topP !== undefined) body.top_p = req.topP
  if (req.topK !== undefined) body.top_k = req.topK
  if (req.minP !== undefined) body.min_p = req.minP
  if (req.topA !== undefined) body.top_a = req.topA
  if (req.repetitionPenalty !== undefined) body.repetition_penalty = req.repetitionPenalty
  if (req.frequencyPenalty !== undefined) body.frequency_penalty = req.frequencyPenalty
  if (req.presencePenalty !== undefined) body.presence_penalty = req.presencePenalty
  if (req.reasoningEffort !== undefined) body.reasoning_effort = req.reasoningEffort
  if (req.verbosity !== undefined) body.verbosity = req.verbosity
  if (req.serviceTier !== undefined) body.service_tier = req.serviceTier
  if (req.routing !== undefined) body.routing = req.routing
  if (req.seed !== undefined && req.seed > 0) body.seed = req.seed
  if (req.responseFormat !== undefined) body.response_format = req.responseFormat
  if (req.prediction !== undefined) body.prediction = { type: 'content', content: req.prediction }
  if (req.openRouter?.fallback) body.route = 'fallback'
  if (req.openRouter) body.transforms = req.openRouter.middleOut ? ['middle-out'] : []
  if (req.openRouter?.provider) {
    const provider = Object.fromEntries(
      Object.entries(req.openRouter.provider).filter(([, value]) => Array.isArray(value) && value.length > 0),
    )
    if (Object.keys(provider).length > 0) body.provider = provider
  }
  if (req.n !== undefined) body.n = req.n
  if (req.thinking !== undefined) body.thinking = req.thinking
  if (req.thinking?.type === 'enabled') {
    delete body.temperature
    delete body.top_p
    delete body.frequency_penalty
    delete body.presence_penalty
  }
  if (req.logitBias !== undefined && Object.keys(req.logitBias).length > 0) body.logit_bias = req.logitBias
  if (req.tools !== undefined && req.tools.length > 0) body.tools = openAIToolDefinitions(req.tools)
  return body
}

function endpoint(req: OpenAIRequest): string {
  if (req.endpointUrl !== undefined) return req.endpointUrl
  try {
    const url = new URL(req.baseUrl)
    const trimmedPath = url.pathname.replace(/\/+$/u, '')
    if (!trimmedPath.endsWith('/chat/completions')) {
      url.pathname = `${trimmedPath}/chat/completions`
    } else {
      url.pathname = trimmedPath
    }
    return url.toString()
  } catch {
    const base = req.baseUrl.endsWith('/') ? req.baseUrl.slice(0, -1) : req.baseUrl
    return `${base}/chat/completions`
  }
}

function buildHeaders(req: OpenAIRequest): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
    ...(req.extraHeaders ?? {}),
  }
}

/**
 * Build the outgoing body + headers and apply the additionalParams DSL.
 * Centralizes the order: defaults first, extraHeaders second, user DSL last.
 */
function buildRequestInit(
  req: OpenAIRequest,
  stream: boolean,
): {
  payload: Record<string, unknown>
  body: string
  headers: Record<string, string>
} {
  const body = buildPayload(req, stream)
  const headers = buildHeaders(req)
  if (req.oobaSystemHoist === true && req.oobaArgs !== undefined) {
    for (const key of Object.keys(req.oobaArgs)) {
      const value = req.oobaArgs[key]
      if (value !== undefined && value !== null) body[key] = value
    }
  }
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  if (req.apiKey) setCanonicalHeader(headers, 'authorization', `Bearer ${req.apiKey}`)
  // Streaming is selected by dispatch and determines the response parser.
  // Custom parameters must not change the upstream wire format underneath it.
  body.stream = stream
  // Tool definitions are caller-scoped capabilities. A persisted
  // additionalParams entry must not replace them with unrelated functions.
  if (req.tools !== undefined && req.tools.length > 0) body.tools = openAIToolDefinitions(req.tools)
  return { payload: body, body: JSON.stringify(body), headers }
}

async function emitOpenAIProviderBodyMetric(
  url: string,
  init: { payload: Record<string, unknown>; body: string; headers: Record<string, string> },
  stream: boolean,
  trace?: GenerationTraceContext,
): Promise<void> {
  const providerBodySidecar = await writeGenerationTraceSidecar({
    context: trace,
    kind: stream ? 'openai-stream-body' : 'openai-body',
    value: {
      provider: 'openai',
      stream,
      url,
      headers: init.headers,
      body: init.payload,
    },
  })
  emitProtocolMetric('generation_provider_request_body', () => ({
    ...providerBodyMetricFields({
      provider: 'openai',
      stream,
      url,
      body: init.payload,
      bodyText: init.body,
    }),
    ...summarizeOpenAIProviderBody(init.payload),
    ...generationTraceSidecarMetricField('providerBodySidecar', providerBodySidecar),
  }))
}

interface OpenAINonStreamChoice {
  message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown }
  reasoning_content?: unknown
  finish_reason?: unknown
}

interface OpenAINonStreamResponse {
  choices?: OpenAINonStreamChoice[]
  model?: unknown
  error?: { message?: unknown }
}

function normalizeDeepSeekThinking(content: string): string {
  let reasoning = ''
  const visible = content.replace(/^(.*)<\/think>/su, (_match, prefix: string) => {
    reasoning = prefix.replace(/<think>/gu, '')
    return ''
  })
  return reasoning.length > 0 ? `<Thoughts>\n${reasoning}\n</Thoughts>\n${visible}` : visible
}

async function runOpenAICore(req: OpenAIRequest): Promise<CompletionResult> {
  if (req.signal.aborted) {
    return { type: 'fail', result: 'aborted', aborted: true }
  }

  const init = buildRequestInit(req, false)
  const url = endpoint(req)
  let response: Response
  try {
    await emitOpenAIProviderBodyMetric(url, init, false, req.trace)
    response = await providerDiagnosticFetch(url, {
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
    return { type: 'fail', result: formatUpstreamFetchError(url, msg), code: 'fetch_failed' }
  }

  let raw: string
  try {
    raw = await readBoundedBodyText(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream body: ${msg}` }
  }

  if (!response.ok) {
    let message: string | undefined
    let code: string | undefined
    try {
      const body = JSON.parse(raw) as OpenAINonStreamResponse & { error?: { code?: unknown } }
      if (typeof body.error?.message === 'string' && body.error.message.length > 0) {
        message = body.error.message
      }
      if (typeof body.error?.code === 'string' && body.error.code.length > 0) {
        code = body.error.code
      }
    } catch {
      if (raw.trim().length > 0) message = raw
    }
    const statusText = upstreamStatusText(response)
    return {
      type: 'fail',
      result: formatUpstreamHttpError(response, url, { message, code }),
      status: response.status,
      ...(statusText ? { statusText } : {}),
      ...(code ? { code } : {}),
    }
  }

  let body: OpenAINonStreamResponse
  try {
    body = JSON.parse(raw) as OpenAINonStreamResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

  const apiMetadata = extractApiResponseMetadata(body, ['choices', 'error', 'model'])

  const choices = Array.isArray(body.choices) ? body.choices : []
  const choiceText = (choice: OpenAINonStreamChoice | undefined): string | null => {
    if (!choice) return null
    const content = typeof choice.message?.content === 'string' ? choice.message.content : ''
    const reasoning =
      typeof choice.reasoning_content === 'string'
        ? choice.reasoning_content
        : typeof choice.message?.reasoning_content === 'string'
          ? choice.message.reasoning_content
          : typeof choice.message?.reasoning === 'string'
            ? choice.message.reasoning
            : ''
    if (content.length === 0 && reasoning.length === 0) return null
    if (req.deepSeekThinkingOutput && reasoning.length === 0) {
      return normalizeDeepSeekThinking(content)
    }
    return reasoning.length > 0 && !content.startsWith('<Thoughts>')
      ? `<Thoughts>\n${reasoning}\n</Thoughts>\n${content}`
      : content
  }
  const rawToolCalls = choices[0]?.message?.tool_calls
  if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
    if (!req.tools || req.tools.length === 0) {
      return { type: 'fail', result: 'upstream returned tool calls when no tools were supplied' }
    }
    const parsed = parseOpenAIToolCalls(rawToolCalls, new Set(req.tools.map((tool) => tool.name)))
    if (parsed.ok === false) return { type: 'fail', result: `invalid upstream tool call: ${parsed.error}` }
    const result: CompletionResult = {
      type: 'success',
      result: choiceText(choices[0]) ?? '',
      toolCalls: parsed.value,
    }
    if (typeof body.model === 'string') result.model = body.model
    if (apiMetadata) result.apiMetadata = apiMetadata
    return result
  }
  const content = choiceText(choices[0])
  if (content === null) {
    return { type: 'fail', result: 'upstream returned no content' }
  }

  const result: CompletionResult = { type: 'success', result: content }
  const alternates = choices
    .slice(1)
    .map(choiceText)
    .filter((text): text is string => text !== null)
  if (alternates.length > 0) result.alternates = alternates
  if (typeof body.model === 'string') result.model = body.model
  if (apiMetadata) result.apiMetadata = apiMetadata
  return result
}

interface OpenAIDelta {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
}

interface OpenAIStreamChoice {
  delta?: OpenAIDelta
  finish_reason?: unknown
}

interface OpenAIStreamFrame {
  choices?: OpenAIStreamChoice[]
}

interface OpenAIErrorResponse {
  error?: { message?: unknown; code?: unknown }
}

function mapFinishReason(raw: unknown): CompletionStreamFrame['finishReason'] {
  if (typeof raw !== 'string' || raw.length === 0) return 'stop'
  return raw
}

/**
 * Parse one SSE event block from an OpenAI-shape stream. Upstream sends
 * `data: <json>` lines plus a trailing `data: [DONE]` sentinel. Exported so
 * other OpenAI-wire-shape providers (Mistral, etc.) can share the framing.
 */
export function parseOpenAIStyleSseData(block: string): string | null {
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('data: ')) data += line.slice(6)
    else if (line.startsWith('data:')) data += line.slice(5)
  }
  return data.length > 0 ? data : null
}

async function readOpenAIStreamError(response: Response, url: string): Promise<CompletionStreamFrame> {
  let message: string | undefined
  let code: string | undefined
  try {
    const text = await readBoundedBodyText(response)
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as OpenAIErrorResponse
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

async function* runOpenAIStreamCore(req: OpenAIRequest): AsyncGenerator<CompletionStreamFrame, void, void> {
  if (req.signal.aborted) return

  const init = buildRequestInit(req, true)
  const url = endpoint(req)
  let response: Response
  try {
    await emitOpenAIProviderBodyMetric(url, init, true, req.trace)
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
    yield await readOpenAIStreamError(response, url)
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
  let reasoningOpen = false
  let accumulatedContent = ''
  let structuredReasoningSeen = false
  let embeddedThinkingPending = req.deepSeekThinkingOutput === true
  let embeddedThinkingBuffer = ''
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
          if (embeddedThinkingPending && embeddedThinkingBuffer.length > 0) {
            yield { kind: 'token', content: normalizeDeepSeekThinking(embeddedThinkingBuffer) }
          }
          if (reasoningOpen) yield { kind: 'token', content: '\n</Thoughts>\n' }
          yield { kind: 'done', finishReason, ...(apiMetadata ? { apiMetadata } : {}) }
          return
        }
        let frame: OpenAIStreamFrame
        try {
          frame = JSON.parse(data) as OpenAIStreamFrame
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          yield { kind: 'error', error: `invalid upstream stream JSON: ${msg}` }
          return
        }
        apiMetadata = mergeApiResponseMetadata(apiMetadata, extractApiResponseMetadata(frame, ['choices', 'error']))
        const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          recordProviderDiagnosticToken()
          structuredReasoningSeen = true
          if (embeddedThinkingPending && embeddedThinkingBuffer.length > 0) {
            yield { kind: 'token', content: embeddedThinkingBuffer }
            embeddedThinkingBuffer = ''
          }
          embeddedThinkingPending = false
          if (!reasoningOpen) {
            reasoningOpen = true
            yield { kind: 'token', content: '<Thoughts>\n' }
          }
          yield { kind: 'token', content: reasoning }
        }
        const delta = choice?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          recordProviderDiagnosticToken()
          let content = delta
          if (delta.length > accumulatedContent.length && delta.startsWith(accumulatedContent)) {
            content = delta.slice(accumulatedContent.length)
            accumulatedContent = delta
          } else {
            accumulatedContent += delta
          }
          if (reasoningOpen) {
            reasoningOpen = false
            yield { kind: 'token', content: '\n</Thoughts>\n' }
          }
          if (req.deepSeekThinkingOutput && !structuredReasoningSeen && embeddedThinkingPending) {
            embeddedThinkingBuffer += content
            if (embeddedThinkingBuffer.includes('</think>')) {
              const normalized = normalizeDeepSeekThinking(embeddedThinkingBuffer)
              embeddedThinkingBuffer = ''
              embeddedThinkingPending = false
              if (normalized.length > 0) yield { kind: 'token', content: normalized }
            } else if (!'<think>'.startsWith(embeddedThinkingBuffer) && !embeddedThinkingBuffer.startsWith('<think>')) {
              yield { kind: 'token', content: embeddedThinkingBuffer }
              embeddedThinkingBuffer = ''
              embeddedThinkingPending = false
            }
          } else if (content.length > 0) {
            yield { kind: 'token', content }
          }
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
    if (embeddedThinkingPending && embeddedThinkingBuffer.length > 0) {
      yield { kind: 'token', content: normalizeDeepSeekThinking(embeddedThinkingBuffer) }
    }
    if (reasoningOpen) yield { kind: 'token', content: '\n</Thoughts>\n' }
    yield { kind: 'done', finishReason, ...(apiMetadata ? { apiMetadata } : {}) }
  }
}

export function runOpenAI(req: OpenAIRequest): Promise<CompletionResult> {
  return observeProviderResult(req.openRouter === undefined ? 'openai' : 'openrouter', req.signal, () =>
    runOpenAICore(req),
  )
}

export function runOpenAIStream(req: OpenAIRequest): AsyncGenerator<CompletionStreamFrame, void, void> {
  return observeProviderStream(req.openRouter === undefined ? 'openai' : 'openrouter', req.signal, () =>
    runOpenAIStreamCore(req),
  )
}
