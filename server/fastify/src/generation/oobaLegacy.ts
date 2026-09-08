import { observeProviderResult, providerDiagnosticFetch } from './providerDiagnostics.js'
import { applyAdditionalParameters } from './additionalParams.js'
import type { CompletionResult } from './frames.js'
import { extractApiResponseMetadata } from './apiMetadata.js'
import { flattenForLegacyInstruct } from './openaiLegacyInstruct.js'
import { readBoundedBodyText } from './body.js'

export interface OobaLegacyRequest {
  prompt: string
  baseUrl: string
  maxTokens?: number
  truncationLength?: number
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  typicalP?: number
  repetitionPenalty?: number
  encoderRepetitionPenalty?: number
  minLength?: number
  noRepeatNgramSize?: number
  numBeams?: number
  penaltyAlpha?: number
  lengthPenalty?: number
  topA?: number
  tfs?: number
  epsilonCutoff?: number
  etaCutoff?: number
  doSample?: boolean
  earlyStopping?: boolean
  seed?: number
  addBosToken?: boolean
  banEosToken?: boolean
  skipSpecialTokens?: boolean
  stoppingStrings?: string[]
  apiKey?: string
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface ResolveInput {
  messages?: unknown
  baseUrl?: unknown
  maxTokens?: unknown
  truncationLength?: unknown
  temperature?: unknown
  topP?: unknown
  topK?: unknown
  minP?: unknown
  typicalP?: unknown
  repetitionPenalty?: unknown
  encoderRepetitionPenalty?: unknown
  minLength?: unknown
  noRepeatNgramSize?: unknown
  numBeams?: unknown
  penaltyAlpha?: unknown
  lengthPenalty?: unknown
  topA?: unknown
  tfs?: unknown
  epsilonCutoff?: unknown
  etaCutoff?: unknown
  doSample?: unknown
  earlyStopping?: unknown
  seed?: unknown
  addBosToken?: unknown
  banEosToken?: unknown
  skipSpecialTokens?: unknown
  stoppingStrings?: unknown
  apiKey?: unknown
  additionalParams?: Array<[string, string]>
  signal: AbortSignal
}

interface RawChatMessage {
  role?: unknown
  content?: unknown
}

const OOBA_LEGACY_USER_MARKERS = ['user', 'human', 'input', 'inst', 'instruction']

function toTitleCase(value: string): string {
  return value[0].toUpperCase() + value.slice(1).toLowerCase()
}

/** Mirrors the retained SPA `getStopStrings(false)` construction. */
export function buildOobaLegacyStopStrings(userPrefix: string, username: string): string[] {
  const stopStrings = ['GPT4 User', '</s>', '<|end', '<|im_end', userPrefix, `${username}:`]
  for (const marker of OOBA_LEGACY_USER_MARKERS) {
    for (const value of [marker.toLowerCase(), marker.toUpperCase(), marker.replace(/\w\S*/gu, toTitleCase)]) {
      stopStrings.push(`${value}:`, `<<${value}>>`, `### ${value}`)
    }
  }
  return [...new Set(stopStrings)]
}

export function resolveOobaLegacyRequest(input: ResolveInput): OobaLegacyRequest | null {
  if (!Array.isArray(input.messages)) return null
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length === 0) return null

  const prompt = flattenForLegacyInstruct(input.messages as RawChatMessage[])
  const maxTokens =
    typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : undefined
  const truncationLength =
    typeof input.truncationLength === 'number' && Number.isFinite(input.truncationLength) && input.truncationLength > 0
      ? input.truncationLength
      : undefined
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : undefined
  const topP = typeof input.topP === 'number' && Number.isFinite(input.topP) ? input.topP : undefined
  const topK = typeof input.topK === 'number' && Number.isFinite(input.topK) ? input.topK : undefined
  const minP = typeof input.minP === 'number' && Number.isFinite(input.minP) ? input.minP : undefined
  const typicalP = typeof input.typicalP === 'number' && Number.isFinite(input.typicalP) ? input.typicalP : undefined
  const repetitionPenalty =
    typeof input.repetitionPenalty === 'number' && Number.isFinite(input.repetitionPenalty)
      ? input.repetitionPenalty
      : undefined
  const numeric = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const boolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
  const stoppingStrings =
    Array.isArray(input.stoppingStrings) && input.stoppingStrings.every((s) => typeof s === 'string')
      ? (input.stoppingStrings as string[])
      : undefined
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.length > 0 ? input.apiKey : undefined

  return {
    prompt,
    baseUrl: input.baseUrl,
    maxTokens,
    truncationLength,
    temperature,
    topP,
    topK,
    minP,
    typicalP,
    repetitionPenalty,
    encoderRepetitionPenalty: numeric(input.encoderRepetitionPenalty),
    minLength: numeric(input.minLength),
    noRepeatNgramSize: numeric(input.noRepeatNgramSize),
    numBeams: numeric(input.numBeams),
    penaltyAlpha: numeric(input.penaltyAlpha),
    lengthPenalty: numeric(input.lengthPenalty),
    topA: numeric(input.topA),
    tfs: numeric(input.tfs),
    epsilonCutoff: numeric(input.epsilonCutoff),
    etaCutoff: numeric(input.etaCutoff),
    doSample: boolean(input.doSample),
    earlyStopping: boolean(input.earlyStopping),
    seed: numeric(input.seed),
    addBosToken: boolean(input.addBosToken),
    banEosToken: boolean(input.banEosToken),
    skipSpecialTokens: boolean(input.skipSpecialTokens),
    stoppingStrings,
    apiKey,
    additionalParams: input.additionalParams,
    signal: input.signal,
  }
}

function endpoint(req: OobaLegacyRequest): string {
  // Normalize only the path. Applying `/api...` to the whole URL corrupts
  // hosts such as `api.example.com`.
  try {
    const url = new URL(req.baseUrl)
    const basePath = url.pathname.replace(/\/api(?:\/.*)?$/u, '').replace(/\/+$/u, '')
    url.pathname = `${basePath}/api/v1/generate`
    return url.toString()
  } catch {
    const match = req.baseUrl.match(/^([^?#]*)(.*)$/u)
    const base = (match?.[1] ?? req.baseUrl).replace(/\/api(?:\/.*)?$/u, '').replace(/\/+$/u, '')
    return `${base}/api/v1/generate${match?.[2] ?? ''}`
  }
}

function buildPayload(req: OobaLegacyRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    do_sample: req.doSample ?? true,
    seed: req.seed ?? -1,
  }
  if (req.maxTokens !== undefined) body.max_new_tokens = req.maxTokens
  if (req.truncationLength !== undefined) body.truncation_length = req.truncationLength
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.topP !== undefined) body.top_p = req.topP
  if (req.topK !== undefined) body.top_k = req.topK
  if (req.minP !== undefined) body.min_p = req.minP
  if (req.typicalP !== undefined) body.typical_p = req.typicalP
  if (req.repetitionPenalty !== undefined) body.repetition_penalty = req.repetitionPenalty
  if (req.encoderRepetitionPenalty !== undefined) body.encoder_repetition_penalty = req.encoderRepetitionPenalty
  if (req.minLength !== undefined) body.min_length = req.minLength
  if (req.noRepeatNgramSize !== undefined) body.no_repeat_ngram_size = req.noRepeatNgramSize
  if (req.numBeams !== undefined) body.num_beams = req.numBeams
  if (req.penaltyAlpha !== undefined) body.penalty_alpha = req.penaltyAlpha
  if (req.lengthPenalty !== undefined) body.length_penalty = req.lengthPenalty
  if (req.topA !== undefined) body.top_a = req.topA
  if (req.tfs !== undefined) body.tfs = req.tfs
  if (req.epsilonCutoff !== undefined) body.epsilon_cutoff = req.epsilonCutoff
  if (req.etaCutoff !== undefined) body.eta_cutoff = req.etaCutoff
  if (req.earlyStopping !== undefined) body.early_stopping = req.earlyStopping
  if (req.addBosToken !== undefined) body.add_bos_token = req.addBosToken
  if (req.banEosToken !== undefined) body.ban_eos_token = req.banEosToken
  if (req.skipSpecialTokens !== undefined) body.skip_special_tokens = req.skipSpecialTokens
  if (req.stoppingStrings !== undefined) body.stopping_strings = req.stoppingStrings
  return body
}

function headers(req: OobaLegacyRequest): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (req.apiKey !== undefined) h['X-API-KEY'] = req.apiKey
  return h
}

function buildRequestInit(req: OobaLegacyRequest): { body: string; headers: Record<string, string> } {
  const body = buildPayload(req)
  const requestHeaders = headers(req)
  if (req.additionalParams !== undefined && req.additionalParams.length > 0) {
    applyAdditionalParameters(body, requestHeaders, req.additionalParams)
  }
  return { body: JSON.stringify(body), headers: requestHeaders }
}

interface OobaResponse {
  results?: Array<{ text?: unknown }>
}

async function runOobaLegacyCore(req: OobaLegacyRequest): Promise<CompletionResult> {
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

  if (!response.ok) return { type: 'fail', result: raw }

  let body: OobaResponse
  try {
    body = JSON.parse(raw) as OobaResponse
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

export function runOobaLegacy(req: OobaLegacyRequest): Promise<CompletionResult> {
  return observeProviderResult('unknown', req.signal, () => runOobaLegacyCore(req))
}
