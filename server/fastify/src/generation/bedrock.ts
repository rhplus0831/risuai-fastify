import { observeProviderResult, providerDiagnosticFetch } from './providerDiagnostics.js'
import { applyAdditionalParameters } from './additionalParams.js'
import type { CompletionResult } from './frames.js'
import { extractApiResponseMetadata } from './apiMetadata.js'
import { encodePathSegment, signSigV4 } from './sigv4.js'
import { readBoundedBodyText } from './body.js'

/**
 * AWS Bedrock Claude (Anthropic Messages) dispatcher. Mirrors the local SPA's
 * `requestClaude` Bedrock branch:
 *
 *  - POST `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`
 *  - Body is the Anthropic Messages payload with `anthropic_version:
 *    'bedrock-2023-05-31'` instead of the regular date-string version,
 *    and no top-level `model` / `stream` fields (the model id is in the
 *    URL).
 *  - Auth via AWS SigV4. The `service` name on the signing line is
 *    `bedrock` (not `bedrock-runtime`).
 *
 * Streaming is unsupported because the `:invoke-with-response-stream`
 * variant uses AWS EventStream binary framing rather than SSE.
 */

export interface BedrockCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}

export interface BedrockRequest {
  model: string
  messages: unknown[]
  credentials: BedrockCredentials
  system?: string
  maxTokens: number
  temperature?: number
  topP?: number
  topK?: number
  thinkingTokens?: number
  thinkingType?: 'off' | 'budget' | 'adaptive'
  adaptiveThinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  supportsAdaptiveThinking?: boolean
  supportsXHighEffort?: boolean
  additionalParams?: Array<[string, string]>
  /** Override clock for deterministic SigV4 tests. */
  date?: Date
  signal: AbortSignal
}

interface BedrockResolveInput {
  model?: unknown
  messages?: unknown
  credentials?: unknown
  system?: unknown
  maxTokens?: unknown
  temperature?: unknown
  topP?: unknown
  topK?: unknown
  thinkingTokens?: unknown
  thinkingType?: unknown
  adaptiveThinkingEffort?: unknown
  supportsAdaptiveThinking?: unknown
  supportsXHighEffort?: unknown
  additionalParams?: Array<[string, string]>
  date?: Date
  signal: AbortSignal
}

const DEFAULT_MAX_TOKENS = 1024

export interface BedrockCredentialsCoerced {
  ok: true
  value: BedrockCredentials
}

export type BedrockCredentialsResult = BedrockCredentialsCoerced | { ok: false; error: string }

/**
 * Validate the `options.bedrock` credential block. Returned shape mirrors
 * the route's `coerceVertexAuth` pattern: callers reply 400 on `ok:false`.
 */
export function coerceBedrockCredentials(raw: unknown): BedrockCredentialsResult | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') {
    return { ok: false, error: 'options.bedrock must be an object' }
  }
  const v = raw as Record<string, unknown>
  if (typeof v.accessKeyId !== 'string' || v.accessKeyId.length === 0) {
    return { ok: false, error: 'options.bedrock.accessKeyId is required' }
  }
  if (typeof v.secretAccessKey !== 'string' || v.secretAccessKey.length === 0) {
    return { ok: false, error: 'options.bedrock.secretAccessKey is required' }
  }
  if (typeof v.region !== 'string' || v.region.length === 0) {
    return { ok: false, error: 'options.bedrock.region is required' }
  }
  const out: BedrockCredentials = {
    accessKeyId: v.accessKeyId,
    secretAccessKey: v.secretAccessKey,
    region: v.region,
  }
  if (typeof v.sessionToken === 'string' && v.sessionToken.length > 0) {
    out.sessionToken = v.sessionToken
  }
  return { ok: true, value: out }
}

export function resolveBedrockRequest(input: BedrockResolveInput): BedrockRequest | null {
  if (typeof input.model !== 'string' || input.model.length === 0) return null
  if (!Array.isArray(input.messages)) return null
  const creds = coerceBedrockCredentials(input.credentials)
  if (creds === null || creds.ok === false) return null

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
    messages: input.messages,
    credentials: creds.value,
    system,
    maxTokens,
    temperature,
    topP,
    topK,
    thinkingTokens,
    thinkingType,
    adaptiveThinkingEffort,
    supportsAdaptiveThinking: input.supportsAdaptiveThinking === true,
    supportsXHighEffort: input.supportsXHighEffort === true,
    additionalParams: input.additionalParams,
    date: input.date,
    signal: input.signal,
  }
}

function buildPayload(req: BedrockRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    messages: req.messages,
    max_tokens: req.maxTokens,
  }
  if (req.system !== undefined) body.system = req.system
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.topP !== undefined) body.top_p = req.topP
  if (req.topK !== undefined) body.top_k = req.topK
  if (req.thinkingType === 'adaptive' && req.supportsAdaptiveThinking) {
    const effort =
      req.adaptiveThinkingEffort === 'xhigh' && !req.supportsXHighEffort
        ? 'high'
        : (req.adaptiveThinkingEffort ?? 'high')
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort }
    body.temperature = 1
    delete body.top_p
    delete body.top_k
  } else if (req.thinkingType !== 'off' && req.thinkingTokens !== undefined) {
    body.thinking = { type: 'enabled', budget_tokens: req.thinkingTokens, display: 'summarized' }
    body.temperature = 1
    delete body.top_p
    delete body.top_k
  }
  return body
}

interface BedrockBuildResult {
  url: string
  body: string
  headers: Record<string, string>
}

/**
 * Build the URL + final body + signed headers for a Bedrock request.
 * Exported for tests that pin the SigV4 signature against a known input.
 */
export function buildBedrockRequest(req: BedrockRequest): BedrockBuildResult {
  const host = `bedrock-runtime.${req.credentials.region}.amazonaws.com`
  const encodedModel = encodePathSegment(req.model)
  const path = `/model/${encodedModel}/invoke`
  const url = `https://${host}${path}`

  let body = buildPayload(req)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, headers, req.additionalParams)
  }
  const bodyString = JSON.stringify(body)

  const signed = signSigV4(
    {
      accessKeyId: req.credentials.accessKeyId,
      secretAccessKey: req.credentials.secretAccessKey,
      sessionToken: req.credentials.sessionToken,
    },
    {
      method: 'POST',
      host,
      path,
      headers,
      body: bodyString,
      region: req.credentials.region,
      service: 'bedrock',
      date: req.date,
    },
  )

  return { url, body: bodyString, headers: signed.headers }
}

interface BedrockResponseContentBlock {
  type?: unknown
  text?: unknown
  thinking?: unknown
}

interface BedrockResponse {
  content?: BedrockResponseContentBlock[]
  model?: unknown
  stop_reason?: unknown
  error?: { message?: unknown }
}

async function runBedrockCore(req: BedrockRequest): Promise<CompletionResult> {
  if (req.signal.aborted) {
    return { type: 'fail', result: 'aborted', aborted: true }
  }

  const built = buildBedrockRequest(req)

  let response: Response
  try {
    response = await providerDiagnosticFetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: built.body,
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
      const parsed = JSON.parse(raw) as BedrockResponse
      if (typeof parsed.error?.message === 'string') {
        return { type: 'fail', result: parsed.error.message }
      }
    } catch {
      // fall through to raw
    }
    return { type: 'fail', result: raw }
  }

  let body: BedrockResponse
  try {
    body = JSON.parse(raw) as BedrockResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'fail', result: `invalid upstream JSON: ${msg}` }
  }

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
  if (text.length === 0) {
    return { type: 'fail', result: 'upstream returned no text content' }
  }

  const result: CompletionResult = { type: 'success', result: text }
  if (typeof body.model === 'string') result.model = body.model
  const apiMetadata = extractApiResponseMetadata(body, ['content', 'error', 'model'])
  if (apiMetadata) result.apiMetadata = apiMetadata
  return result
}

export function runBedrock(req: BedrockRequest): Promise<CompletionResult> {
  return observeProviderResult('unknown', req.signal, () => runBedrockCore(req))
}
