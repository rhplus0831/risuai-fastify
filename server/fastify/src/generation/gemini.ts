import {
  observeProviderResult,
  providerDiagnosticFetch,
  observeProviderStream,
  providerDiagnosticRead,
  recordProviderDiagnosticTerminal,
  recordProviderDiagnosticToken,
  recordProviderDiagnosticFailure,
} from './providerDiagnostics.js'
import type { CompletionResult, CompletionStreamFrame } from './frames.js'
import { emitProtocolMetric } from '../protocolMetrics.js'
import { providerBodyMetricFields, summarizeGeminiProviderBody } from './providerBodySummary.js'
import {
  STREAM_BUFFER_OVERFLOW_ERROR,
  hasNonIgnorableSseTail,
  popSseEventBlock,
  streamBufferExceedsCap,
} from './sse.js'
import { resolveVertexBearer } from './vertexAuth.js'
import { readBoundedBodyText } from './body.js'
import { formatUpstreamFetchError, formatUpstreamHttpError, upstreamStatusText } from './upstreamError.js'
import {
  generationTraceSidecarMetricField,
  writeGenerationTraceSidecar,
  type GenerationTraceContext,
} from './generationTraceSidecar.js'
import type { ServerToolDefinition, ServerToolRound } from '@risuai/protocol/server-tool'
import { extractApiResponseMetadata, mergeApiResponseMetadata } from './apiMetadata.js'
import { appendGeminiToolRounds, geminiToolDefinitions, parseGeminiToolCalls } from './serverTools.js'
import { applyAdditionalParameters } from './additionalParams.js'

export interface VertexAuthInput {
  projectId: string
  region: string
  clientEmail: string
  privateKey: string
}

export interface GeminiRequest {
  model: string
  contents: unknown[]
  systemInstruction?: string
  /**
   * Vanilla Google AI Studio path: query-string `key=<apiKey>` against
   * `generativelanguage.googleapis.com`.
   */
  apiKey?: string
  /**
   * Vertex AI path: Bearer-auth against
   * `<region>-aiplatform.googleapis.com` (or the `global` endpoint when
   * `region === 'global'`). When `vertex` is set, `apiKey` is ignored.
   */
  vertex?: VertexAuthInput
  baseUrl: string
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  presencePenalty?: number
  frequencyPenalty?: number
  thinkingTokens?: number
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  thinkingLevelNoMinimal?: boolean
  geminiBlockOff?: boolean
  noCivilIntegrity?: boolean
  responseSchema?: Record<string, unknown>
  extraHeaders?: Record<string, string>
  /** Persisted profile additional-parameter overrides, applied after defaults and extra headers. */
  additionalParams?: Array<[string, string]>
  /** Reveal reasoning deltas as they arrive instead of buffering them until answer text. */
  streamThoughts?: boolean
  trace?: GenerationTraceContext
  tools?: ServerToolDefinition[]
  responseModalities?: readonly GeminiResponseModality[]
  persistInlineData?: (inlineData: GeminiInlineData) => Promise<string>
  onWarning?: (warning: GeminiResponseWarning) => void
  signal: AbortSignal
}

export type GeminiResponseModality = 'TEXT' | 'IMAGE' | 'AUDIO'

export interface GeminiInlineData {
  mimeType: string
  data: string
}

export interface GeminiResponseWarning {
  message: string
  context?: Record<string, unknown>
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { thought: true; thoughtSignature: string }

interface GeminiResolveInput {
  model?: unknown
  messages?: unknown
  apiKey?: unknown
  vertex?: VertexAuthInput
  baseUrl?: unknown
  maxOutputTokens?: unknown
  temperature?: unknown
  topP?: unknown
  topK?: unknown
  presencePenalty?: unknown
  frequencyPenalty?: unknown
  thinkingTokens?: unknown
  thinkingLevel?: unknown
  thinkingLevelNoMinimal?: unknown
  geminiBlockOff?: unknown
  noCivilIntegrity?: unknown
  responseSchema?: unknown
  extraHeaders?: Record<string, string>
  additionalParams?: Array<[string, string]>
  streamThoughts?: unknown
  trace?: GenerationTraceContext
  tools?: ServerToolDefinition[]
  toolRounds?: ServerToolRound[]
  responseModalities?: readonly GeminiResponseModality[]
  persistInlineData?: (inlineData: GeminiInlineData) => Promise<string>
  onWarning?: (warning: GeminiResponseWarning) => void
  signal: AbortSignal
}

interface RawChatMessage {
  role?: unknown
  content?: unknown
  memo?: unknown
  multimodals?: unknown
}

interface RawMultimodal {
  type?: unknown
  base64?: unknown
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Gemini takes:
 *   - `systemInstruction` as a top-level field (parts of system rows joined),
 *   - `contents` alternating between `user` and `model` roles with `parts`.
 *
 * Function/tool rows are dropped. Consecutive same-role rows are coalesced
 * since Gemini also rejects two `user` (or two `model`) in a row. Request-level
 * tool, multimodal, thinking, and response-schema controls are added after this
 * message-only conversion.
 */
export interface GeminiReformatResult {
  contents: GeminiContent[]
  systemInstruction?: string
}

function parseGeminiDataUrl(value: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(value)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

function geminiParts(message: RawChatMessage): GeminiPart[] {
  const content = typeof message.content === 'string' ? message.content : ''
  const isNewChat = typeof message.memo === 'string' && message.memo.startsWith('NewChat')
  const parts: GeminiPart[] = []
  if (!isNewChat && content.length > 0) parts.push({ text: content })
  if (Array.isArray(message.multimodals)) {
    for (const raw of message.multimodals as RawMultimodal[]) {
      if ((raw.type !== 'image' && raw.type !== 'audio' && raw.type !== 'video') || typeof raw.base64 !== 'string') {
        continue
      }
      const parsed = parseGeminiDataUrl(raw.base64)
      if (parsed) parts.push({ inlineData: parsed })
    }
  }
  return parts
}

function appendGeminiParts(target: GeminiPart[], incoming: GeminiPart[]): void {
  const last = target.at(-1)
  const first = incoming[0]
  if (last && 'text' in last && first && 'text' in first) {
    last.text += `\n${first.text}`
    incoming.shift()
  }
  target.push(...incoming)
}

export function reformatForGemini(messages: RawChatMessage[]): GeminiReformatResult {
  const systemTexts: string[] = []
  const contents: GeminiContent[] = []
  for (const m of messages) {
    const content =
      typeof m.memo === 'string' && m.memo.startsWith('NewChat') ? '' : typeof m.content === 'string' ? m.content : ''
    if (m.role === 'system') {
      if (content.length > 0) systemTexts.push(content)
      continue
    }
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : m.role === 'user' ? 'user' : 'user'
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const parts = geminiParts(m)
    if (parts.length === 0) continue
    const prev = contents[contents.length - 1]
    if (prev && prev.role === role) {
      appendGeminiParts(prev.parts, parts)
      continue
    }
    contents.push({ role, parts })
  }
  const systemInstruction = systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined
  return systemInstruction === undefined ? { contents } : { contents, systemInstruction }
}

export function resolveGeminiRequest(input: GeminiResolveInput): GeminiRequest | null {
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  if (!Array.isArray(input.messages)) return null
  const hasApiKey = typeof input.apiKey === 'string' && (input.apiKey as string).length > 0
  const hasVertex =
    !!input.vertex &&
    typeof input.vertex.projectId === 'string' &&
    input.vertex.projectId.length > 0 &&
    typeof input.vertex.region === 'string' &&
    input.vertex.region.length > 0 &&
    typeof input.vertex.clientEmail === 'string' &&
    input.vertex.clientEmail.length > 0 &&
    typeof input.vertex.privateKey === 'string' &&
    input.vertex.privateKey.length > 0
  if (!hasApiKey && !hasVertex) return null

  const reformat = reformatForGemini(input.messages as RawChatMessage[])
  if (reformat.contents.length === 0) return null

  // Vertex requests don't take a baseUrl override — the URL is derived from
  // projectId + region. Only Studio respects baseUrl.
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.length > 0 ? input.baseUrl : DEFAULT_BASE_URL
  const maxOutputTokens =
    typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens > 0
      ? input.maxOutputTokens
      : undefined
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined
  const topK =
    typeof input.topK === 'number' && Number.isFinite(input.topK) && input.topK !== 0 ? input.topK : undefined
  const presencePenalty =
    typeof input.presencePenalty === 'number' && Number.isFinite(input.presencePenalty)
      ? input.presencePenalty
      : undefined
  const frequencyPenalty =
    typeof input.frequencyPenalty === 'number' && Number.isFinite(input.frequencyPenalty)
      ? input.frequencyPenalty
      : undefined
  const thinkingTokens =
    typeof input.thinkingTokens === 'number' && Number.isFinite(input.thinkingTokens) && input.thinkingTokens >= 0
      ? input.thinkingTokens
      : undefined
  const thinkingLevel =
    input.thinkingLevel === 'minimal' ||
    input.thinkingLevel === 'low' ||
    input.thinkingLevel === 'medium' ||
    input.thinkingLevel === 'high'
      ? input.thinkingLevel
      : undefined

  return {
    model: input.model,
    contents: appendGeminiToolRounds(reformat.contents, input.toolRounds ?? []),
    systemInstruction: reformat.systemInstruction,
    apiKey: hasApiKey ? (input.apiKey as string) : undefined,
    vertex: hasVertex ? input.vertex : undefined,
    baseUrl,
    maxOutputTokens,
    temperature,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    thinkingTokens,
    thinkingLevel,
    thinkingLevelNoMinimal: input.thinkingLevelNoMinimal === true,
    geminiBlockOff: input.geminiBlockOff === true,
    noCivilIntegrity: input.noCivilIntegrity === true,
    responseSchema:
      input.responseSchema && typeof input.responseSchema === 'object' && !Array.isArray(input.responseSchema)
        ? (input.responseSchema as Record<string, unknown>)
        : undefined,
    extraHeaders: input.extraHeaders,
    additionalParams: input.additionalParams,
    streamThoughts: input.streamThoughts === true,
    trace: input.trace,
    tools: input.tools,
    responseModalities: input.responseModalities,
    persistInlineData: input.persistInlineData,
    onWarning: input.onWarning,
    signal: input.signal,
  }
}

const GEMINI_SAFETY_CATEGORIES = [
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
] as const

function buildSafetySettings(req: GeminiRequest): Array<{ category: string; threshold: 'BLOCK_NONE' | 'OFF' }> {
  const threshold = req.geminiBlockOff === true ? 'OFF' : 'BLOCK_NONE'
  return GEMINI_SAFETY_CATEGORIES.filter(
    (category) => !(req.noCivilIntegrity === true && category === 'HARM_CATEGORY_CIVIC_INTEGRITY'),
  ).map((category) => ({ category, threshold }))
}

function buildThinkingConfig(req: GeminiRequest): Record<string, unknown> | undefined {
  if ((req.tools?.length ?? 0) > 0) return undefined
  if (req.thinkingTokens !== undefined) {
    return { thinkingBudget: req.thinkingTokens, includeThoughts: true }
  }
  if (req.thinkingLevel === undefined) return undefined
  const thinkingLevel = req.thinkingLevel === 'minimal' && req.thinkingLevelNoMinimal ? 'low' : req.thinkingLevel
  return { thinkingLevel, includeThoughts: true }
}

function buildPayload(req: GeminiRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {}
  if (req.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = req.maxOutputTokens
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature
  if (req.topP !== undefined) generationConfig.topP = req.topP
  if (req.topK !== undefined) generationConfig.topK = req.topK
  if (req.presencePenalty !== undefined) generationConfig.presencePenalty = req.presencePenalty
  if (req.frequencyPenalty !== undefined) generationConfig.frequencyPenalty = req.frequencyPenalty
  if (req.responseModalities !== undefined) generationConfig.responseModalities = [...req.responseModalities]
  const thinkingConfig = buildThinkingConfig(req)
  if (thinkingConfig !== undefined) generationConfig.thinkingConfig = thinkingConfig
  if (req.responseSchema !== undefined) {
    generationConfig.response_mime_type = 'application/json'
    generationConfig.response_schema = req.responseSchema
  }
  const body: Record<string, unknown> = {
    contents: req.contents,
    generationConfig,
    safetySettings: buildSafetySettings(req),
  }
  if (req.systemInstruction !== undefined) {
    body.systemInstruction = { parts: [{ text: req.systemInstruction }] }
  }
  if (req.tools !== undefined && req.tools.length > 0) body.tools = geminiToolDefinitions(req.tools)
  return body
}

/**
 * Gemini 3 preview models and the Gemini 3.5/3.6 Flash family are only
 * available on the `global` Vertex endpoint regardless of configured region.
 * Mirror the SPA's `isVertexGlobalOnlyModel` check.
 */
const VERTEX_GLOBAL_ONLY = /^(?:gemini-3-.*-preview$|gemini-3\.[56]-flash)/

function endpointStudio(req: GeminiRequest, stream: boolean): string {
  const base = req.baseUrl.endsWith('/') ? req.baseUrl.slice(0, -1) : req.baseUrl
  const method = stream ? 'streamGenerateContent' : 'generateContent'
  const apiKey = req.apiKey as string
  const tail = stream
    ? `:${method}?alt=sse&key=${encodeURIComponent(apiKey)}`
    : `:${method}?key=${encodeURIComponent(apiKey)}`
  return `${base}/models/${req.model}${tail}`
}

function endpointVertex(req: GeminiRequest, stream: boolean): string {
  const vertex = req.vertex as VertexAuthInput
  const region = VERTEX_GLOBAL_ONLY.test(req.model) ? 'global' : vertex.region
  const method = stream ? 'streamGenerateContent' : 'generateContent'
  const query = stream ? '?alt=sse' : ''
  const host = region === 'global' ? 'https://aiplatform.googleapis.com' : `https://${region}-aiplatform.googleapis.com`
  return `${host}/v1/projects/${vertex.projectId}/locations/${region}/publishers/google/models/${req.model}:${method}${query}`
}

function endpoint(req: GeminiRequest, stream: boolean): string {
  return req.vertex !== undefined ? endpointVertex(req, stream) : endpointStudio(req, stream)
}

function headers(): Record<string, string> {
  return { 'content-type': 'application/json' }
}

function buildRequestInit(
  req: GeminiRequest,
  defaultHeaders: Record<string, string>,
): { body: Record<string, unknown>; bodyText: string; headers: Record<string, string> } {
  const body = buildPayload(req)
  const requestHeaders = { ...defaultHeaders, ...(req.extraHeaders ?? {}) }
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, requestHeaders, req.additionalParams)
  }
  // Gemini selects streaming through the operation URL, not a body field.
  // Ignore a Chat Completions-style override that could contradict dispatch.
  delete body.stream
  return { body, bodyText: JSON.stringify(body), headers: requestHeaders }
}

async function emitGeminiProviderBodyMetric(args: {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  bodyText: string
  model: string
  stream: boolean
  trace?: GenerationTraceContext
}): Promise<void> {
  const providerBodySidecar = await writeGenerationTraceSidecar({
    context: args.trace,
    kind: args.stream ? 'gemini-stream-body' : 'gemini-body',
    value: {
      provider: 'gemini',
      stream: args.stream,
      url: args.url,
      headers: args.headers,
      body: args.body,
    },
  })
  emitProtocolMetric('generation_provider_request_body', () => ({
    ...providerBodyMetricFields({
      provider: 'gemini',
      stream: args.stream,
      url: args.url,
      body: args.body,
      bodyText: args.bodyText,
      requestModel: args.model,
    }),
    ...summarizeGeminiProviderBody(args.body),
    ...generationTraceSidecarMetricField('providerBodySidecar', providerBodySidecar),
  }))
}

/**
 * For Vertex requests, fetch a fresh (or cached) Bearer and set
 * `Authorization: Bearer ...`. Returns `null` if the token exchange
 * failed; callers propagate the error to the caller as a `fail` result.
 */
async function vertexHeaders(
  req: GeminiRequest,
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
  const base = headers()
  if (req.vertex === undefined) return { ok: true, headers: base }
  const bearer = await resolveVertexBearer(req.vertex.clientEmail, req.vertex.privateKey, req.signal)
  if (bearer.ok === false) return { ok: false, error: bearer.error }
  return { ok: true, headers: { ...base, authorization: `Bearer ${bearer.token}` } }
}

interface GeminiResponsePart {
  text?: unknown
  thought?: unknown
  thoughtSignature?: unknown
  functionCall?: unknown
  inlineData?: unknown
}

interface GeminiCandidate {
  content?: { parts?: GeminiResponsePart[] }
  finishReason?: unknown
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  modelVersion?: unknown
  error?: { message?: unknown; status?: unknown }
}

interface GeminiErrorResponse {
  error?: { message?: unknown; status?: unknown }
}

interface GeminiTextExtractionState {
  thinkingOpen: boolean
}

function hasAnswerText(body: GeminiResponse): boolean {
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  return candidates.some((candidate) => {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    return parts.some((part) => part.thought !== true && typeof part.text === 'string')
  })
}

function extractText(
  body: GeminiResponse,
  state: GeminiTextExtractionState = { thinkingOpen: false },
  closeThoughts = true,
): string {
  let text = ''
  const cands = Array.isArray(body.candidates) ? body.candidates : []
  for (const c of cands) {
    const parts = Array.isArray(c?.content?.parts) ? c.content!.parts : []
    for (const p of parts) {
      if (p.thought === true && typeof p.text === 'string') {
        if (!state.thinkingOpen) {
          text += '<Thoughts>\n'
          state.thinkingOpen = true
        }
        text += p.text
      } else if (typeof p.text === 'string') {
        if (state.thinkingOpen) {
          text += '</Thoughts>\n\n'
          state.thinkingOpen = false
        }
        text += p.text
      }
    }
  }
  if (closeThoughts && state.thinkingOpen) {
    text += '</Thoughts>\n\n'
    state.thinkingOpen = false
  }
  return text
}

function readGeminiInlineData(value: unknown): GeminiInlineData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const mimeType = (value as { mimeType?: unknown }).mimeType
  const data = (value as { data?: unknown }).data
  if (typeof mimeType !== 'string' || mimeType.trim().length === 0 || typeof data !== 'string' || data.length === 0) {
    return null
  }
  return { mimeType: mimeType.trim(), data }
}

function geminiInlineDataWarning(req: GeminiRequest, inlineData: GeminiInlineData | null, error: unknown): void {
  const mimeType = inlineData?.mimeType
  const mediaType = mimeType?.split('/', 1)[0] ?? 'unknown'
  const detail = error instanceof Error ? error.message : String(error)
  req.onWarning?.({
    message: `Gemini returned ${mediaType} output that could not be persisted and was skipped.`,
    context: {
      kind: 'gemini_inline_data_persistence_failed',
      mediaType,
      ...(mimeType ? { mimeType } : {}),
      error: detail,
    },
  })
}

async function extractBufferedContent(body: GeminiResponse, req: GeminiRequest): Promise<string> {
  const state: GeminiTextExtractionState = { thinkingOpen: false }
  let text = ''
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    for (const part of parts) {
      if (part.thought === true && typeof part.text === 'string') {
        if (!state.thinkingOpen) {
          text += '<Thoughts>\n'
          state.thinkingOpen = true
        }
        text += part.text
        continue
      }
      if (typeof part.text === 'string') {
        if (state.thinkingOpen) {
          text += '</Thoughts>\n\n'
          state.thinkingOpen = false
        }
        text += part.text
      }
      if (part.inlineData === undefined) continue
      const inlineData = readGeminiInlineData(part.inlineData)
      if (!inlineData) {
        geminiInlineDataWarning(req, null, new Error('invalid inlineData payload'))
        continue
      }
      if (!req.persistInlineData) {
        geminiInlineDataWarning(req, inlineData, new Error('server asset persistence is unavailable'))
        continue
      }
      try {
        const assetId = await req.persistInlineData(inlineData)
        if (!assetId) throw new Error('asset persistence returned an empty id')
        if (state.thinkingOpen) {
          text += '</Thoughts>\n\n'
          state.thinkingOpen = false
        }
        text += `{{inlay::${assetId}}}`
      } catch (error) {
        geminiInlineDataWarning(req, inlineData, error)
      }
    }
  }
  if (state.thinkingOpen) text += '</Thoughts>\n\n'
  return text
}

function mapFinishReason(raw: unknown): CompletionStreamFrame['finishReason'] {
  if (typeof raw !== 'string' || raw.length === 0) return 'stop'
  if (raw === 'STOP') return 'stop'
  if (raw === 'MAX_TOKENS') return 'length'
  if (raw === 'SAFETY') return 'content_filter'
  return raw.toLowerCase()
}

async function readGeminiStreamError(response: Response, url: string): Promise<CompletionStreamFrame> {
  let message: string | undefined
  let code: string | undefined
  try {
    const text = await readBoundedBodyText(response)
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as GeminiErrorResponse
        if (typeof parsed.error?.message === 'string' && parsed.error.message.length > 0) {
          message = parsed.error.message
        } else {
          message = text
        }
        if (typeof parsed.error?.status === 'string' && parsed.error.status.length > 0) {
          code = parsed.error.status
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

async function runGeminiCore(req: GeminiRequest): Promise<CompletionResult> {
  if (req.signal.aborted) {
    return { type: 'fail', result: 'aborted', aborted: true }
  }

  const h = await vertexHeaders(req)
  if (h.ok === false) {
    if (req.signal.aborted) {
      return { type: 'fail', result: 'aborted', aborted: true }
    }
    return { type: 'fail', result: h.error }
  }

  const url = endpoint(req, false)
  const init = buildRequestInit(req, h.headers)
  let response: Response
  try {
    await emitGeminiProviderBodyMetric({
      url,
      headers: init.headers,
      body: init.body,
      bodyText: init.bodyText,
      model: req.model,
      stream: false,
      trace: req.trace,
    })
    response = await providerDiagnosticFetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.bodyText,
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
    // Gemini's error body shape is `{error: {message, status}}`. Surface the
    // message when present; otherwise pass the raw text through so callers
    // can inspect the upstream payload.
    try {
      const parsed = JSON.parse(raw) as GeminiResponse
      if (typeof parsed.error?.message === 'string') {
        return { type: 'fail', result: parsed.error.message }
      }
    } catch {
      // ignore parse failure, fall through to raw
    }
    return { type: 'fail', result: raw }
  }

  let body: GeminiResponse
  try {
    body = JSON.parse(raw) as GeminiResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

  const apiMetadata = extractApiResponseMetadata(body, ['candidates', 'error', 'modelVersion'])

  const text = await extractBufferedContent(body, req)
  const toolParts = (body.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? [])
  const hasToolCalls = toolParts.some((part) => part.functionCall !== undefined)
  if (hasToolCalls) {
    if (!req.tools || req.tools.length === 0) {
      return { type: 'fail', result: 'upstream returned tool calls when no tools were supplied' }
    }
    const parsed = parseGeminiToolCalls(toolParts, new Set(req.tools.map((tool) => tool.name)))
    if (parsed.ok === false) return { type: 'fail', result: `invalid upstream tool call: ${parsed.error}` }
    const result: CompletionResult = { type: 'success', result: text, toolCalls: parsed.value }
    if (typeof body.modelVersion === 'string') result.model = body.modelVersion
    if (apiMetadata) result.apiMetadata = apiMetadata
    return result
  }
  if (text.length === 0) {
    return { type: 'fail', result: 'upstream returned no text content' }
  }
  const result: CompletionResult = { type: 'success', result: text }
  if (typeof body.modelVersion === 'string') result.model = body.modelVersion
  if (apiMetadata) result.apiMetadata = apiMetadata
  return result
}

async function* runGeminiStreamCore(req: GeminiRequest): AsyncGenerator<CompletionStreamFrame, void, void> {
  if (req.signal.aborted) return

  const h = await vertexHeaders(req)
  if (h.ok === false) {
    if (req.signal.aborted) return
    yield { kind: 'error', error: h.error, code: 'vertex_auth_failed' }
    return
  }

  const url = endpoint(req, true)
  const init = buildRequestInit(req, h.headers)
  let response: Response
  try {
    await emitGeminiProviderBodyMetric({
      url,
      headers: init.headers,
      body: init.body,
      bodyText: init.bodyText,
      model: req.model,
      stream: true,
      trace: req.trace,
    })
    response = await providerDiagnosticFetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.bodyText,
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal.aborted) return
    const msg = err instanceof Error ? err.message : String(err)
    yield { kind: 'error', error: formatUpstreamFetchError(url, msg), code: 'fetch_failed' }
    return
  }

  if (!response.ok) {
    yield await readGeminiStreamError(response, url)
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
  const extractionState: GeminiTextExtractionState = { thinkingOpen: false }
  let bufferedText = ''
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
        evt = popSseEventBlock(buf)
        // Gemini SSE emits `data: <json>` lines. Concatenate any data lines
        // in the block then parse.
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) data += line.slice(6)
          else if (line.startsWith('data:')) data += line.slice(5)
        }
        if (data.length === 0) continue
        let frame: GeminiResponse
        try {
          frame = JSON.parse(data) as GeminiResponse
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          yield { kind: 'error', error: `invalid upstream stream JSON: ${msg}` }
          return
        }
        if (frame.error && typeof frame.error === 'object') {
          recordProviderDiagnosticFailure('unknown-error')
          const message =
            typeof frame.error.message === 'string' && frame.error.message.length > 0
              ? frame.error.message
              : 'upstream returned an error frame'
          const code =
            typeof frame.error.status === 'string' && frame.error.status.length > 0 ? frame.error.status : undefined
          const statusText = upstreamStatusText(response)
          yield {
            kind: 'error',
            error: formatUpstreamHttpError(response, url, { message, code }),
            status: response.status,
            ...(statusText ? { statusText } : {}),
            ...(code ? { code } : {}),
          }
          return
        }
        apiMetadata = mergeApiResponseMetadata(apiMetadata, extractApiResponseMetadata(frame, ['candidates', 'error']))
        const text = extractText(frame, extractionState, false)
        if (text.length > 0) {
          recordProviderDiagnosticToken()
          if (req.streamThoughts || hasAnswerText(frame)) {
            const content = bufferedText + text
            bufferedText = ''
            yield { kind: 'token', content }
          } else {
            bufferedText += text
          }
        }
        const fr = Array.isArray(frame.candidates) ? frame.candidates[0]?.finishReason : undefined
        if (fr !== undefined) {
          recordProviderDiagnosticTerminal()
          finishReason = mapFinishReason(fr)
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
    if (extractionState.thinkingOpen) bufferedText += '</Thoughts>\n\n'
    if (bufferedText.length > 0) yield { kind: 'token', content: bufferedText }
    yield { kind: 'done', finishReason, ...(apiMetadata ? { apiMetadata } : {}) }
  }
}

export function runGemini(req: GeminiRequest): Promise<CompletionResult> {
  return observeProviderResult('gemini', req.signal, () => runGeminiCore(req))
}

export function runGeminiStream(req: GeminiRequest): AsyncGenerator<CompletionStreamFrame, void, void> {
  return observeProviderStream('gemini', req.signal, () => runGeminiStreamCore(req))
}
