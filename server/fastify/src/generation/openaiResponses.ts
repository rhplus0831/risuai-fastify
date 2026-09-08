import { observeProviderResult, providerDiagnosticFetch } from './providerDiagnostics.js'
import { applyAdditionalParameters, setCanonicalHeader } from './additionalParams.js'
import type { CompletionResult } from './frames.js'
import { extractApiResponseMetadata } from './apiMetadata.js'
import { readBoundedBodyText } from './body.js'
import { appendOpenAIResponsesToolRounds, parseOpenAIResponsesToolCalls } from './serverTools.js'
import type { ServerToolRound } from '@risuai/protocol/server-tool'
import { normalizeLegacyOpenAIModelId } from '@risuai/shared-core/legacy-openai-model-aliases'

export interface OpenAIResponsesRequest {
  model: string
  input: ResponseItem[]
  apiKey: string
  baseUrl: string
  endpointUrl?: string
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  reasoningEffort?: string
  reasoningSummary?: boolean
  verbosity?: string
  responseFormat?: Record<string, unknown>
  tools?: unknown[]
  store?: boolean
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
  endpointUrl?: unknown
  maxOutputTokens?: unknown
  temperature?: unknown
  topP?: unknown
  reasoningEffort?: unknown
  reasoningSummary?: unknown
  verbosity?: unknown
  responseFormat?: unknown
  tools?: unknown
  toolRounds?: readonly ServerToolRound[]
  store?: unknown
  developerRole?: unknown
  visionQuality?: unknown
  newOAIHandle?: unknown
  extraHeaders?: Record<string, string>
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface RawChatMessage {
  role?: unknown
  content?: unknown
  memo?: unknown
  multimodals?: unknown
}

type ResponseInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' | 'low' | 'high' }
  | { type: 'input_file'; file_data: string }
type ResponseOutputContent =
  | {
      type: 'output_text'
      text: string
      annotations: unknown[]
    }
  | { type: 'refusal'; refusal: string }

interface ResponseInputItem {
  role: 'user' | 'system' | 'developer'
  content: ResponseInputContent[]
}

interface ResponseOutputItem {
  type: 'message'
  role: 'assistant'
  status: 'completed' | 'incomplete'
  content: ResponseOutputContent[]
}

interface ResponseFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  status: 'completed'
}

interface ResponseFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

type ResponseItem = ResponseInputItem | ResponseOutputItem | ResponseFunctionCallItem | ResponseFunctionCallOutputItem

interface RawMultimodal {
  type?: unknown
  base64?: unknown
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/**
 * The Responses API takes `input: ResponseItem[]` rather than `messages[]`.
 * user/system rows become input_text wrappers; assistant rows become
 * output_text wrappers (with `status: completed` except for a trailing
 * assistant which is marked `incomplete` so the model continues from there).
 * Tool continuation rows are appended separately from the validated bounded
 * tool-round protocol.
 */
export function buildResponseInput(
  messages: RawChatMessage[],
  options: { developerRole?: boolean; visionQuality?: unknown; newOAIHandle?: boolean } = {},
): ResponseItem[] {
  const detail =
    options.visionQuality === 'low' || options.visionQuality === 'high' ? options.visionQuality : ('auto' as const)
  const items: ResponseItem[] = []
  for (const m of messages) {
    const text =
      options.newOAIHandle !== false && typeof m.memo === 'string' && m.memo.startsWith('NewChat')
        ? ''
        : typeof m.content === 'string'
          ? m.content
          : ''
    if (m.role === 'assistant') {
      if (text.length === 0) continue
      items.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      })
    } else if (m.role === 'user' || m.role === 'system' || m.role === 'developer') {
      const content: ResponseInputContent[] = []
      if (text.length > 0) content.push({ type: 'input_text', text })
      if (Array.isArray(m.multimodals)) {
        for (const raw of m.multimodals as RawMultimodal[]) {
          if (typeof raw.base64 !== 'string') continue
          if (raw.type === 'image') {
            content.push({ type: 'input_image', detail, image_url: raw.base64 })
          } else if (raw.type === 'audio' || raw.type === 'video') {
            content.push({ type: 'input_file', file_data: raw.base64 })
          }
        }
      }
      if (content.length === 0) continue
      items.push({
        role: options.developerRole && m.role === 'system' ? 'developer' : m.role,
        content,
      })
    }
  }
  // If the trailing row is an assistant message, mark it incomplete so the
  // model continues that turn.
  const last = items[items.length - 1]
  if (last && 'role' in last && last.role === 'assistant') {
    last.status = 'incomplete'
  }
  return items
}

export function resolveOpenAIResponsesRequest(input: ResolveInput): OpenAIResponsesRequest | null {
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  if (!Array.isArray(input.messages)) return null
  if (typeof input.apiKey !== 'string' || input.apiKey.length === 0) return null

  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.length > 0 ? input.baseUrl : DEFAULT_BASE_URL
  const maxOutputTokens =
    typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens > 0
      ? input.maxOutputTokens
      : undefined
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined
  const reasoningEffort = typeof input.reasoningEffort === 'string' ? input.reasoningEffort : undefined
  const reasoningSummary = input.reasoningSummary === true || reasoningEffort !== undefined
  const verbosity = typeof input.verbosity === 'string' ? input.verbosity : undefined
  const responseFormat =
    input.responseFormat && typeof input.responseFormat === 'object' && !Array.isArray(input.responseFormat)
      ? (input.responseFormat as Record<string, unknown>)
      : undefined
  const tools = Array.isArray(input.tools) ? input.tools : undefined
  const store = typeof input.store === 'boolean' ? input.store : undefined

  return {
    model: normalizeLegacyOpenAIModelId(input.model),
    input: appendOpenAIResponsesToolRounds(
      buildResponseInput(input.messages as RawChatMessage[], {
        developerRole: input.developerRole === true,
        visionQuality: input.visionQuality,
        newOAIHandle: input.newOAIHandle !== false,
      }),
      input.toolRounds ?? [],
    ) as ResponseItem[],
    apiKey: input.apiKey,
    baseUrl,
    endpointUrl: typeof input.endpointUrl === 'string' && input.endpointUrl.length > 0 ? input.endpointUrl : undefined,
    maxOutputTokens,
    temperature,
    topP,
    reasoningEffort,
    reasoningSummary,
    verbosity,
    responseFormat,
    tools,
    store,
    extraHeaders: input.extraHeaders,
    additionalParams: input.additionalParams,
    signal: input.signal,
  }
}

function endpoint(req: OpenAIResponsesRequest): string {
  if (req.endpointUrl !== undefined) return req.endpointUrl
  try {
    const url = new URL(req.baseUrl)
    const pathname = url.pathname.replace(/\/+$/u, '')
    if (!pathname.endsWith('/responses')) url.pathname = `${pathname}/responses`
    return url.toString()
  } catch {
    const match = req.baseUrl.match(/^([^?#]*)(.*)$/u)
    const base = (match?.[1] ?? req.baseUrl).replace(/\/+$/u, '')
    const suffix = match?.[2] ?? ''
    return `${base.endsWith('/responses') ? base : `${base}/responses`}${suffix}`
  }
}

function buildHeaders(req: OpenAIResponsesRequest): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${req.apiKey}`,
    ...(req.extraHeaders ?? {}),
  }
}

function buildRequestInit(req: OpenAIResponsesRequest): { body: string; headers: Record<string, string> } {
  const body = buildPayload(req)
  const headers = buildHeaders(req)
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  setCanonicalHeader(headers, 'authorization', `Bearer ${req.apiKey}`)
  return { body: JSON.stringify(body), headers }
}

function buildPayload(req: OpenAIResponsesRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
  }
  if (req.store !== undefined) body.store = req.store
  if (req.maxOutputTokens !== undefined) body.max_output_tokens = req.maxOutputTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.topP !== undefined) body.top_p = req.topP
  if (req.reasoningEffort !== undefined || req.reasoningSummary === true) {
    body.reasoning = {
      ...(req.reasoningEffort !== undefined ? { effort: req.reasoningEffort } : {}),
      ...(req.reasoningSummary === true ? { summary: 'auto' } : {}),
    }
  }
  if (req.verbosity !== undefined) body.text = { verbosity: req.verbosity }
  if (req.responseFormat !== undefined) {
    body.text = { ...((body.text as Record<string, unknown> | undefined) ?? {}), format: req.responseFormat }
  }
  if (req.tools !== undefined && req.tools.length > 0) body.tools = req.tools
  return body
}

interface ResponsesAPIBody {
  output_text?: unknown
  output?: Array<{
    type?: unknown
    id?: unknown
    call_id?: unknown
    name?: unknown
    arguments?: unknown
    status?: unknown
    content?: unknown
    summary?: unknown
    text?: unknown
    summary_text?: unknown
    reasoning_text?: unknown
    reasoning?: unknown
  }>
  model?: unknown
  status?: unknown
  incomplete_details?: { reason?: unknown }
  error?: { message?: unknown }
}

function collectReasoningText(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (Array.isArray(value)) return value.flatMap(collectReasoningText)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return ['text', 'summary_text', 'reasoning_text', 'reasoning', 'summary'].flatMap((key) =>
    collectReasoningText(record[key]),
  )
}

function extractResponsesResult(body: ResponsesAPIBody): string | null {
  const hasTopLevelOutputText = typeof body.output_text === 'string'
  const texts: string[] = hasTopLevelOutputText ? [body.output_text as string] : []
  const refusals: string[] = []
  const thoughts: string[] = []
  for (const item of body.output ?? []) {
    if (item.type === 'reasoning') {
      thoughts.push(
        ...collectReasoningText(item.summary),
        ...collectReasoningText(item.content),
        ...collectReasoningText(item.text),
        ...collectReasoningText(item.summary_text),
        ...collectReasoningText(item.reasoning_text),
        ...collectReasoningText(item.reasoning),
      )
    }
    if (item.type !== 'message') continue
    if (!Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (!content || typeof content !== 'object') continue
      const record = content as Record<string, unknown>
      if (record.type === 'output_text' && typeof record.text === 'string' && !hasTopLevelOutputText) {
        texts.push(record.text)
      }
      if (record.type === 'refusal' && typeof record.refusal === 'string') refusals.push(record.refusal)
    }
  }
  let result = texts.length > 0 ? texts.join('\n') : refusals.join('\n')
  if (thoughts.length > 0 && !result.startsWith('<Thoughts>')) {
    result = `<Thoughts>\n\n${thoughts.join('\n\n')}\n\n</Thoughts>\n${result}`
  }
  return result.length > 0 ? result : null
}

function responseFunctionToolNames(tools: readonly unknown[] | undefined): Set<string> {
  const names = new Set<string>()
  for (const tool of tools ?? []) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue
    const record = tool as Record<string, unknown>
    if (record.type === 'function' && typeof record.name === 'string') names.add(record.name)
  }
  return names
}

function responseFailureText(value: unknown): string {
  try {
    return JSON.stringify(value) || 'upstream Responses request failed'
  } catch {
    return 'upstream Responses request failed'
  }
}

async function runOpenAIResponsesCore(req: OpenAIResponsesRequest): Promise<CompletionResult> {
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
    try {
      const parsed = JSON.parse(raw) as ResponsesAPIBody
      if (typeof parsed.error?.message === 'string') {
        return { type: 'fail', result: parsed.error.message }
      }
    } catch {
      // ignore parse failure, surface raw
    }
    return { type: 'fail', result: raw }
  }

  let body: ResponsesAPIBody
  try {
    body = JSON.parse(raw) as ResponsesAPIBody
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

  const text = extractResponsesResult(body)
  if (body.status === 'failed' || body.error) {
    return { type: 'fail', result: responseFailureText(body.error ?? body) }
  }
  if (body.status === 'incomplete') {
    const reason =
      typeof body.incomplete_details?.reason === 'string'
        ? `Incomplete response: ${body.incomplete_details.reason}`
        : 'Incomplete response'
    return { type: 'fail', result: text === null ? reason : `${reason}\n${text}` }
  }

  const hasFunctionCalls = body.output?.some((item) => item.type === 'function_call') === true
  let toolCalls
  if (hasFunctionCalls) {
    const parsed = parseOpenAIResponsesToolCalls(body.output, responseFunctionToolNames(req.tools))
    if (parsed.ok === false) return { type: 'fail', result: parsed.error }
    toolCalls = parsed.value
  }
  if (text === null && !toolCalls) {
    return { type: 'fail', result: 'upstream returned no output text' }
  }
  const result: CompletionResult = { type: 'success', result: text ?? '', ...(toolCalls ? { toolCalls } : {}) }
  if (typeof body.model === 'string') result.model = body.model
  const apiMetadata = extractApiResponseMetadata(body, ['output_text', 'output', 'error', 'model'])
  if (apiMetadata) result.apiMetadata = apiMetadata
  return result
}

export function runOpenAIResponses(req: OpenAIResponsesRequest): Promise<CompletionResult> {
  return observeProviderResult('openai', req.signal, () => runOpenAIResponsesCore(req))
}
