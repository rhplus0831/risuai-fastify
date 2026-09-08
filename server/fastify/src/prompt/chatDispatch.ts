import type { ProviderGenerationSettings as Database, ServerSeparateParameters } from './serverTypes.js'
import type { DatabaseSync } from 'node:sqlite'
import type { PromptMessage } from './promptMessage.js'
import { LLMFlags, LLMFormat, LLMProvider, type LLMFormat as LLMFormatValue } from '@risuai/shared-core/model-types'
import { OpenAIModels } from '@risuai/shared-core/openai-models'
import type { CompletionResult, CompletionStreamFrame } from '../generation/frames.js'
import { stripCoTFromCompletionFrames } from '../generation/stripCoT.js'
import { resolveEchoRequest, runEcho, runEchoStream } from '../generation/echo.js'
import { resolveOpenAIRequest, runOpenAI, runOpenAIStream } from '../generation/openai.js'
import { resolveAnthropicRequest, runAnthropic, runAnthropicStream } from '../generation/anthropic.js'
import { resolveMistralRequest, runMistral, runMistralStream } from '../generation/mistral.js'
import { resolveCohereRequest, runCohere } from '../generation/cohere.js'
import {
  resolveGeminiRequest,
  runGemini,
  runGeminiStream,
  type GeminiInlineData,
  type GeminiResponseModality,
  type GeminiResponseWarning,
  type VertexAuthInput,
} from '../generation/gemini.js'
import { resolveOpenAILegacyInstructRequest, runOpenAILegacyInstruct } from '../generation/openaiLegacyInstruct.js'
import { resolveOpenAIResponsesRequest, runOpenAIResponses } from '../generation/openaiResponses.js'
import { resolveKoboldRequest, runKobold } from '../generation/kobold.js'
import { resolveOllamaRequest, runOllama, runOllamaStream } from '../generation/ollama.js'
import { resolveBedrockRequest, runBedrock, type BedrockCredentials } from '../generation/bedrock.js'
import { resolveHordeRequest, runHorde } from '../generation/horde.js'
import { resolveOpenRouterFreeModel } from '../generation/openrouterFreeModel.js'
import { buildOobaLegacyStopStrings, resolveOobaLegacyRequest, runOobaLegacy } from '../generation/oobaLegacy.js'
import {
  resolveProviderCapability,
  type ProviderCapabilityInput,
  type ProviderUnsupportedReason,
} from '@risuai/shared-core/provider-capability'
import {
  assertModelProfileGenerationReady,
  resolveModelProfile,
  resolveProfileRequestModel,
  type ResolvedModelProfile,
} from '@risuai/shared-core/model-profile-resolver'
import { emitProtocolMetric } from '../protocolMetrics.js'
import { promptSummaryMetricFields, summarizePromptRows } from './promptSummary.js'
import type { GenerationTraceContext } from '../generation/generationTraceSidecar.js'
import { encodeTokens, encodingForModel, tokenize } from './tokens.js'
import { ensureTokenizerLoadedForDb, tokenizerEncodingFromDb } from './tokenizerConfig.js'
import type { TokenEncoding } from './tokens.js'
import type { ServerToolDefinition, ServerToolRound } from '@risuai/protocol/server-tool'
import { appendOpenAIToolRounds, openAIResponsesToolDefinitions } from '../generation/serverTools.js'
import {
  buildAnthropicWireMessages,
  buildOpenAIWireMessages,
  sanitizeTextMessages,
} from '../generation/providerMessages.js'
import { extractConfiguredJsonValue, parseConfiguredJsonSchemaText } from '../generation/jsonControls.js'
import {
  completeRequestHistory,
  requestHistoryRedactionValues,
  requestHistoryProfileSnapshot,
  tryBeginRequestHistory,
  wrapRequestHistoryFrames,
  type RequestHistoryContext,
} from '../requestHistory.js'
import { persistServerInlayAsset } from '../inlayAssetPersistence.js'
import { getProfileAdditionalParameters } from '../generation/additionalParams.js'
import { recordProviderDispatchFailure } from '../generation/providerDiagnostics.js'

export interface ChatDispatchHistoryInput {
  db: DatabaseSync
  source: string
  context?: RequestHistoryContext
  toggles?: Record<string, string>
  metadata?: Record<string, unknown>
}

/** Fastify's generation-facing database input until the provider domain is narrowed in its own Phase 4 slice. */
export type ChatDispatchDatabase = Database

interface ChatDispatchArgs {
  database: ChatDispatchDatabase
  formated: PromptMessage[]
  outputTokens?: number
  profile?: ResolvedModelProfile
  signal: AbortSignal
  trace?: GenerationTraceContext
  biases?: [string, number][]
  /** Main chat send/regenerate only; auxiliary/continue flows stay single-choice. */
  multiGeneration?: boolean
  /** Browser-owned tool definitions for one bounded server-completion round trip. */
  tools?: ServerToolDefinition[]
  /** Prior calls and browser-executed results, converted to provider-native history server-side. */
  toolRounds?: ServerToolRound[]
  /** Optional internal schema override matching the retained low-level generation contract. */
  schema?: string
  /** Durable diagnostics for one actual provider attempt. */
  history?: ChatDispatchHistoryInput
  /** Provider-flag-normalized messages prepared by the public dispatch boundary. */
  finalizedMessages?: PromptMessage[]
  /** Effective character selected for this generation, including non-zero database positions. */
  currentCharacterName?: string
  /** Reports a dispatch-time sentinel resolution to generation metadata owners. */
  onResolvedModel?: (model: string) => void
  /** Main generation route capability for provider-returned media. */
  inlayAssetPersistence?: { db: DatabaseSync; dataDir: string }
  /** Provider warnings surfaced over the owning route's warning channel. */
  onWarning?: (warning: GeminiResponseWarning) => void
}

type CustomModelEntry = NonNullable<Database['customModels']>[number]

interface ModelInfoLite {
  id: string
  format: LLMFormatValue
  internalID?: string
  endpoint?: string
  keyIdentifier?: string
  flags: number[]
  unsupportedReason?: string
}

interface OpenAICompatibleVariant {
  apiKey?: string
  baseUrl?: string
  endpointUrl?: string
  extraHeaders?: Record<string, string>
  additionalParams?: Array<[string, string]>
  oobaSystemHoist?: boolean
  oobaArgs?: unknown
}

const NANOGPT_BASE_URL = 'https://nano-gpt.com/api/v1'
const NANOGPT_SUBSCRIPTION_BASE_URL = 'https://nano-gpt.com/api/subscription/v1'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const DISABLED_SAMPLER_SENTINEL = -1000

const DEFAULT_OPENAI_FLAGS = [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming]
const FIRST_SYSTEM_FLAGS = [LLMFlags.hasFirstSystemPrompt]
const ALTERNATING_FLAGS = [
  LLMFlags.hasFirstSystemPrompt,
  LLMFlags.requiresAlternateRole,
  LLMFlags.mustStartWithUserInput,
]
const OPENAI_MODEL_IDS = new Set(
  OpenAIModels.flatMap((model) => [model.id, model.internalID]).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  ),
)

export interface ChatDispatchReformatInstrumentation {
  fullPromptClones: number
}

const chatDispatchReformatInstrumentation: ChatDispatchReformatInstrumentation = {
  fullPromptClones: 0,
}

export function resetChatDispatchReformatInstrumentation(): void {
  chatDispatchReformatInstrumentation.fullPromptClones = 0
}

export function getChatDispatchReformatInstrumentation(): ChatDispatchReformatInstrumentation {
  return { ...chatDispatchReformatInstrumentation }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber<T extends number>(value: T | undefined): T | undefined
function asNumber(value: unknown): number | undefined
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeDispatchSampler(value: unknown, options: { scale?: number } = {}): number | undefined {
  const numeric = asNumber(value)
  if (numeric === undefined || numeric === DISABLED_SAMPLER_SENTINEL) return undefined
  return options.scale ? numeric / options.scale : numeric
}

interface DispatchParameters {
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  topA?: number
  repetitionPenalty?: number
  frequencyPenalty?: number
  presencePenalty?: number
  reasoningEffort?: string
  thinkingTokens?: number
  verbosity?: string
}

function dispatchParameterOverride(db: Database, profile: ResolvedModelProfile): ServerSeparateParameters | undefined {
  if (!db.seperateParametersEnabled || !db.seperateParametersByModel) return undefined
  return db.seperateParameters?.overrides?.[profile.modelId]
}

const dispatchSamplerFields = {
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  top_a: 'top_a',
  repetition_penalty: 'repetition_penalty',
  frequency_penalty: 'frequencyPenalty',
  presence_penalty: 'PresensePenalty',
  reasoning_effort: 'reasoningEffort',
  thinking_tokens: 'thinkingTokens',
  verbosity: 'verbosity',
} as const satisfies Partial<Record<keyof ServerSeparateParameters, keyof Database>>

function reasoningEffort(
  value: unknown,
  disabledEffort: 'minimal' | 'none' = 'minimal',
  supportsXHigh = false,
  minEffort: 'low' | 'medium' = 'low',
): string | undefined {
  const numeric = asNumber(value)
  if (numeric === undefined || numeric === DISABLED_SAMPLER_SENTINEL) return undefined
  if (numeric === -1) return disabledEffort
  if (numeric === 0) return minEffort
  if (numeric === 1) return 'medium'
  if (numeric === 2) return 'high'
  if (numeric === 3) return supportsXHigh ? 'xhigh' : 'high'
  return 'medium'
}

function verbosity(value: unknown): string | undefined {
  const numeric = asNumber(value)
  if (numeric === undefined || numeric === DISABLED_SAMPLER_SENTINEL) return undefined
  return ['low', 'medium', 'high'][numeric] ?? 'medium'
}

function parseConfiguredJsonSchema(db: Database, schemaOverride?: string): Record<string, unknown> | undefined {
  if (schemaOverride === undefined && db.jsonSchemaEnabled !== true) return undefined
  const raw = typeof schemaOverride === 'string' ? schemaOverride.trim() : db.jsonSchema?.trim()
  if (!raw) return undefined
  return parseConfiguredJsonSchemaText(raw)
}

function stripGeminiUnsupportedSchemaKeywords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripGeminiUnsupportedSchemaKeywords)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '$schema' && key !== 'additionalProperties')
      .map(([key, nested]) => [key, stripGeminiUnsupportedSchemaKeywords(nested)]),
  )
}

function geminiResponseSchema(db: Database, schemaOverride?: string): Record<string, unknown> | undefined {
  const schema = parseConfiguredJsonSchema(db, schemaOverride)
  return schema ? (stripGeminiUnsupportedSchemaKeywords(schema) as Record<string, unknown>) : undefined
}

function openAIChatResponseFormat(db: Database, flags: readonly number[]): Record<string, unknown> | undefined {
  if (flags.includes(LLMFlags.noStructuredOutput)) return undefined
  const schema = parseConfiguredJsonSchema(db)
  if (!schema) return undefined
  return {
    type: 'json_schema',
    json_schema: { name: 'format', strict: db.strictJsonSchema === true, schema },
  }
}

function openAIResponsesFormat(db: Database): Record<string, unknown> | undefined {
  const schema = parseConfiguredJsonSchema(db)
  if (!schema) return undefined
  return { type: 'json_schema', name: 'format', strict: db.strictJsonSchema === true, schema }
}

function resolveOpenRouterRequestOptions(
  provider: string,
  profile: ResolvedModelProfile,
): Parameters<typeof resolveOpenAIRequest>[0]['openRouter'] {
  if (provider !== 'openrouter') return undefined
  const options = profile.providerOptions.openrouter
  return {
    fallback: options?.fallback === true,
    middleOut: options?.middleOut === true,
    provider: options?.provider,
  }
}

function resolveDeepSeekThinking(db: Database, flags: readonly number[]): Record<string, unknown> | undefined {
  if (!flags.includes(LLMFlags.deepSeekThinkingToggle)) return undefined
  return db.deepseekThinkingType === 'enabled'
    ? { type: 'enabled', reasoning_effort: db.deepseekReasoningEffort ?? 'high' }
    : { type: 'disabled' }
}

export const OPENAI_STRONG_BAN_PUNCTUATION = ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~“”‘’«»「」…–―※'

export function resolveOpenAILogitBias(
  rows: readonly [string, number][],
  model: string,
  selectedEncoding?: TokenEncoding,
  encode: (text: string, encoding: TokenEncoding) => readonly number[] = encodeTokens,
): Record<string, number> {
  const bias: Record<string, number> = {}
  const encoding = selectedEncoding ?? encodingForModel(model)
  const assignTokens = (text: string, value: number): void => {
    for (const token of encode(text, encoding)) bias[String(token)] = value
  }
  for (const [rawText, rawValue] of rows) {
    if (typeof rawText !== 'string' || typeof rawValue !== 'number' || !Number.isFinite(rawValue)) continue
    if (rawText.startsWith('[[') && rawText.endsWith(']]')) {
      const token = Number.parseInt(rawText.replace('[[', '').replace(']]', ''), 10)
      bias[String(token)] = rawValue
      continue
    }
    if (rawValue === -101) {
      const variants = [
        rawText,
        rawText.trim(),
        rawText.toLocaleUpperCase(),
        rawText.toLocaleLowerCase(),
        rawText ? rawText[0].toLocaleUpperCase() + rawText.slice(1) : '',
        rawText ? rawText[0].toLocaleLowerCase() + rawText.slice(1) : '',
      ]
      const punctuationTokens = new Set<number>()
      for (const char of OPENAI_STRONG_BAN_PUNCTUATION) {
        const token = encode(char, encoding)[0]
        if (token !== undefined) punctuationTokens.add(token)
      }
      const banFirstToken = (text: string): void => {
        const token = encode(text, encoding)[0]
        if (token !== undefined && !punctuationTokens.has(token)) bias[String(token)] = -100
      }
      for (const char of OPENAI_STRONG_BAN_PUNCTUATION) {
        banFirstToken(char)
        for (const variant of variants) {
          banFirstToken(variant + char)
          banFirstToken(char + variant)
        }
      }
      continue
    }
    assignTokens(rawText, rawValue)
  }
  return bias
}

/** Resolve only parameters declared by the selected model's capability row. */
export function resolveDispatchParameters(db: Database, profile: ResolvedModelProfile): DispatchParameters {
  const supported = new Set(profile.modelInfo.parameters)
  const override = dispatchParameterOverride(db, profile)
  const from = (key: keyof typeof dispatchSamplerFields, databaseDefault?: number): number | undefined =>
    override ? override[key] : (db[dispatchSamplerFields[key]] ?? databaseDefault)
  const out: DispatchParameters = {}
  if (supported.has('temperature')) out.temperature = normalizeDispatchSampler(from('temperature'), { scale: 100 })
  if (supported.has('top_p')) out.topP = normalizeDispatchSampler(from('top_p'))
  if (supported.has('top_k')) out.topK = normalizeDispatchSampler(from('top_k'))
  if (supported.has('min_p')) out.minP = normalizeDispatchSampler(from('min_p'))
  if (supported.has('top_a')) out.topA = normalizeDispatchSampler(from('top_a'))
  if (supported.has('repetition_penalty')) {
    out.repetitionPenalty = normalizeDispatchSampler(from('repetition_penalty'))
  }
  if (supported.has('frequency_penalty')) {
    out.frequencyPenalty = normalizeDispatchSampler(from('frequency_penalty'), { scale: 100 })
  }
  if (supported.has('presence_penalty')) {
    out.presencePenalty = normalizeDispatchSampler(from('presence_penalty'), { scale: 100 })
  }
  if (supported.has('reasoning_effort')) {
    out.reasoningEffort = reasoningEffort(
      from('reasoning_effort'),
      supported.has('reasoning_effort_none') ? 'none' : 'minimal',
      supported.has('reasoning_effort_xhigh'),
      supported.has('reasoning_effort_min_medium') ? 'medium' : 'low',
    )
  }
  if (supported.has('thinking_tokens')) {
    out.thinkingTokens = normalizeDispatchSampler(from('thinking_tokens'))
  }
  if (supported.has('verbosity')) out.verbosity = verbosity(from('verbosity', 1))
  return out
}

function additionalParams(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Array<[string, string]> = []
  for (const row of value) {
    if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string') {
      out.push([row[0], row[1]])
    }
  }
  return out.length > 0 ? out : undefined
}

function parseXcustomParams(params: unknown): Array<[string, string]> | undefined {
  if (typeof params !== 'string' || params.length === 0) return undefined
  const out: Array<[string, string]> = []
  for (const line of params.split('\n')) {
    const split = line.split('=')
    if (split.length < 2) continue
    out.push([split[0], split.slice(1).join('=')])
  }
  return out.length > 0 ? out : undefined
}

function findXcustomEntry(db: Database, aiModel: string): CustomModelEntry | null {
  const models = Array.isArray(db.customModels) ? db.customModels : []
  return models.find((m) => m.id === aiModel) ?? null
}

function deriveOpenAIBaseUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    const trimmedPath = url.pathname.replace(/\/+$/u, '')
    if (trimmedPath.endsWith('/chat/completions')) {
      url.pathname = trimmedPath.slice(0, -'/chat/completions'.length)
      return url.toString().replace(/\/$/u, '')
    }
    url.pathname = trimmedPath
    return url.toString().replace(/\/$/u, '')
  } catch {
    const trimmed = endpoint.replace(/\/+$/u, '')
    return trimmed.endsWith('/chat/completions') ? trimmed.slice(0, -'/chat/completions'.length) : trimmed
  }
}

function autofillOpenAIEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const path = url.pathname
    if (path.endsWith('v1')) {
      url.pathname += '/chat/completions'
    } else if (path.endsWith('v1/')) {
      url.pathname += 'chat/completions'
    } else if (!(path.endsWith('completions') || path.endsWith('completions/'))) {
      url.pathname += path.endsWith('/') ? 'v1/chat/completions' : '/v1/chat/completions'
    }
    return url.toString()
  } catch {
    if (rawUrl.endsWith('v1')) return `${rawUrl}/chat/completions`
    if (rawUrl.endsWith('v1/')) return `${rawUrl}chat/completions`
    if (rawUrl.endsWith('completions') || rawUrl.endsWith('completions/')) return rawUrl
    return rawUrl + (rawUrl.endsWith('/') ? 'v1/chat/completions' : '/v1/chat/completions')
  }
}

function resolveReverseProxyUrl(
  rawUrl: string,
  autofill: boolean,
): {
  baseUrl: string
  endpointUrl: string
  risuIdentify: boolean
} {
  let url = rawUrl
  let risuIdentify = false
  if (url.startsWith('risu::')) {
    risuIdentify = true
    url = url.slice('risu::'.length)
  }
  if (autofill) {
    url = autofillOpenAIEndpoint(url)
  }
  return { baseUrl: deriveOpenAIBaseUrl(url), endpointUrl: url, risuIdentify }
}

function stripTrailingPath(rawUrl: string, path: string): string {
  try {
    const url = new URL(rawUrl)
    const trimmedPath = url.pathname.replace(/\/+$/u, '')
    if (trimmedPath.endsWith(path)) url.pathname = trimmedPath.slice(0, -path.length)
    else url.pathname = trimmedPath
    return url.toString().replace(/\/$/u, '')
  } catch {
    const trimmed = rawUrl.replace(/\/+$/u, '')
    return trimmed.endsWith(path) ? trimmed.slice(0, -path.length) : trimmed
  }
}

function resolveModelInfo(db: Database): ModelInfoLite {
  const aiModel = asString(db.aiModel) ?? ''
  if (aiModel === 'reverse_proxy') {
    return {
      id: aiModel,
      internalID: asString(db.customProxyRequestModel) ?? aiModel,
      format: asNumber(db.customAPIFormat) ?? LLMFormat.OpenAICompatible,
      flags: DEFAULT_OPENAI_FLAGS,
    }
  }

  if (aiModel.startsWith('xcustom:::')) {
    const entry = findXcustomEntry(db, aiModel)
    if (entry) {
      return {
        id: asString(entry.id) ?? aiModel,
        internalID: asString(entry.internalId) ?? asString(entry.id) ?? aiModel,
        format: asNumber(entry.format) ?? LLMFormat.OpenAICompatible,
        flags: DEFAULT_OPENAI_FLAGS,
      }
    }
  }

  if (aiModel.startsWith('horde:::')) {
    return { id: aiModel, format: LLMFormat.Horde, flags: FIRST_SYSTEM_FLAGS }
  }
  if (aiModel === 'echo_model') {
    return { id: aiModel, format: LLMFormat.Echo, flags: DEFAULT_OPENAI_FLAGS }
  }
  if (aiModel === 'openrouter') {
    return { id: aiModel, format: LLMFormat.OpenAICompatible, flags: DEFAULT_OPENAI_FLAGS }
  }
  if (aiModel === 'nanogpt') {
    return { id: aiModel, format: LLMFormat.NanoGPT, flags: DEFAULT_OPENAI_FLAGS }
  }
  if (aiModel === 'novelai' || aiModel === 'novelai_kayra') {
    return { id: aiModel, format: LLMFormat.NovelAI, flags: DEFAULT_OPENAI_FLAGS }
  }
  if (aiModel === 'novellist' || aiModel === 'novellist_damsel') {
    return { id: aiModel, format: LLMFormat.NovelList, flags: [] }
  }
  if (aiModel === 'ooba') {
    return { id: aiModel, format: LLMFormat.Ooba, flags: FIRST_SYSTEM_FLAGS }
  }
  if (aiModel === 'custom' || aiModel.startsWith('pluginmodel:::')) {
    return { id: aiModel, format: LLMFormat.Plugin, flags: DEFAULT_OPENAI_FLAGS }
  }
  if (aiModel.startsWith('hf:::')) {
    return { id: aiModel, format: LLMFormat.WebLLM, flags: DEFAULT_OPENAI_FLAGS }
  }
  if (aiModel === 'ollama-cloud') {
    return {
      id: aiModel,
      format: asNumber(db.ollamaRequestFormat) ?? LLMFormat.OpenAICompatible,
      flags: DEFAULT_OPENAI_FLAGS,
    }
  }
  if (asString(db.ollamaURL) && aiModel.includes('ollama')) {
    return { id: aiModel, format: LLMFormat.Ollama, flags: ALTERNATING_FLAGS }
  }
  if (aiModel.startsWith('deepseek-')) {
    return {
      id: aiModel,
      format: LLMFormat.OpenAICompatible,
      endpoint: 'https://api.deepseek.com/beta/chat/completions',
      keyIdentifier: 'deepseek',
      flags: ALTERNATING_FLAGS,
    }
  }
  if (aiModel.startsWith('deepinfra_')) {
    return {
      id: aiModel.slice('deepinfra_'.length),
      format: LLMFormat.OpenAICompatible,
      endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',
      keyIdentifier: 'deepinfra',
      flags: ALTERNATING_FLAGS,
    }
  }
  if (aiModel.startsWith('anthropic.')) {
    return {
      id: aiModel,
      internalID: aiModel,
      format: LLMFormat.AWSBedrockClaude,
      flags: FIRST_SYSTEM_FLAGS,
    }
  }
  if (aiModel.startsWith('claude-')) {
    return { id: aiModel, format: LLMFormat.Anthropic, flags: FIRST_SYSTEM_FLAGS }
  }
  if (aiModel.startsWith('mistral') || aiModel.startsWith('magistral')) {
    return { id: aiModel, format: LLMFormat.Mistral, flags: ALTERNATING_FLAGS }
  }
  if (aiModel.startsWith('cohere-')) {
    return { id: aiModel, format: LLMFormat.Cohere, flags: ALTERNATING_FLAGS }
  }
  if (aiModel.startsWith('gemini-')) {
    const isVertex = aiModel.endsWith('-vertex') || asString(db.vertexClientEmail) !== undefined
    return {
      id: aiModel,
      internalID: isVertex ? aiModel.replace(/-vertex$/, '') : aiModel,
      format: isVertex ? LLMFormat.VertexAIGemini : LLMFormat.GoogleCloud,
      flags: ALTERNATING_FLAGS,
    }
  }
  if (aiModel.includes('instruct')) {
    return { id: aiModel, format: LLMFormat.OpenAILegacyInstruct, flags: DEFAULT_OPENAI_FLAGS }
  }
  if (aiModel.endsWith('-response-api')) {
    return {
      id: aiModel,
      internalID: aiModel.slice(0, -'-response-api'.length),
      format: LLMFormat.OpenAIResponseAPI,
      flags: DEFAULT_OPENAI_FLAGS,
    }
  }
  if (asString(db.koboldURL)) {
    return { id: aiModel, format: LLMFormat.Kobold, flags: FIRST_SYSTEM_FLAGS }
  }
  if (asString(db.textgenWebUIBlockingURL)) {
    return { id: aiModel, format: LLMFormat.OobaLegacy, flags: FIRST_SYSTEM_FLAGS }
  }

  if (!OPENAI_MODEL_IDS.has(aiModel)) {
    return {
      id: aiModel,
      format: LLMFormat.OpenAICompatible,
      flags: DEFAULT_OPENAI_FLAGS,
      unsupportedReason: `unsupported /chat provider: unknown OpenAI-compatible model "${aiModel}" cannot be dispatched by the server`,
    }
  }

  return { id: aiModel, format: LLMFormat.OpenAICompatible, flags: DEFAULT_OPENAI_FLAGS }
}

interface ReformatBranchNeeds {
  systemPrompt: boolean
  firstSystemPrompt: boolean
  alternateRole: boolean
  startWithUserInput: boolean
}

function resolveReformatBranchNeeds(flags: readonly number[]): ReformatBranchNeeds {
  const systemPrompt = !flags.includes(LLMFlags.hasFullSystemPrompt)
  return {
    systemPrompt,
    firstSystemPrompt: systemPrompt && flags.includes(LLMFlags.hasFirstSystemPrompt),
    alternateRole: flags.includes(LLMFlags.requiresAlternateRole),
    startWithUserInput: flags.includes(LLMFlags.mustStartWithUserInput),
  }
}

function needsReformatClone(needs: ReformatBranchNeeds): boolean {
  return needs.systemPrompt || needs.alternateRole || needs.startWithUserInput
}

function cloneDispatchRows(rows: PromptMessage[]): PromptMessage[] {
  chatDispatchReformatInstrumentation.fullPromptClones++
  return structuredClone(rows)
}

export function reformatMessages(db: Database, rows: PromptMessage[], flags: readonly number[]): PromptMessage[] {
  const needs = resolveReformatBranchNeeds(flags)
  if (!needsReformatClone(needs)) return rows

  let formated = cloneDispatchRows(rows)
  let systemPrompt: PromptMessage | null = null

  if (needs.systemPrompt) {
    if (needs.firstSystemPrompt) {
      while (formated[0]?.role === 'system') {
        if (systemPrompt) {
          systemPrompt.content += '\n\n' + formated[0].content
        } else {
          systemPrompt = formated[0]
        }
        formated = formated.slice(1)
      }
    }

    for (const row of formated) {
      if (row.role === 'system') {
        row.content = db.systemContentReplacement
          ? db.systemContentReplacement.replace('{{slot}}', row.content)
          : `system: ${row.content}`
        const replacement = asString(db.systemRoleReplacement) || 'user'
        row.role =
          replacement === 'assistant' ||
          replacement === 'user' ||
          replacement === 'function' ||
          replacement === 'system'
            ? replacement
            : 'user'
      }
    }
  }

  if (needs.alternateRole) {
    const merged: PromptMessage[] = []
    for (const row of formated) {
      const prev = merged[merged.length - 1]
      if (prev && prev.role === row.role) {
        prev.content += '\n' + row.content
        if (row.multimodals) {
          prev.multimodals ??= []
          prev.multimodals.push(...row.multimodals)
        }
        if (row.thoughts) {
          prev.thoughts ??= []
          prev.thoughts.push(...row.thoughts)
        }
        if (row.cachePoint) prev.cachePoint = true
      } else {
        merged.push(row)
      }
    }
    formated = merged
  }

  if (needs.startWithUserInput) {
    if (formated.length === 0 || formated[0].role !== 'user') {
      formated.unshift({ role: 'user', content: ' ' })
    }
  }

  if (systemPrompt) formated.unshift(systemPrompt)
  return formated
}

/**
 * Build the shared capability table's input from the server-resolved
 * `ModelInfoLite` + the route `db`. `ollama-cloud`'s format is pre-remapped to
 * `db.ollamaRequestFormat` by `resolveModelInfo` for dispatch, but the table
 * classifies it the way the browser does — through the Ollama arm, which also
 * gates on `db.ollamaApiKey` — so feed `LLMFormat.Ollama` here; the dispatch
 * arms still read the remapped `info.format`.
 */
function buildChatCapabilityInput(db: Database, info: ModelInfoLite): ProviderCapabilityInput {
  const aiModel = asString(db.aiModel) ?? ''
  return {
    format: aiModel === 'ollama-cloud' ? LLMFormat.Ollama : info.format,
    aiModel,
    endpoint: info.endpoint,
    keyIdentifier: info.keyIdentifier,
    internalID: info.internalID,
    config: {
      forceReplaceUrl: asString(db.forceReplaceUrl),
      proxyKey: asString(db.proxyKey),
      oaiCompApiKeys: db.OaiCompAPIKeys,
      customModels: db.customModels,
      googleProjectId: db.google?.projectId,
      vertexRegion: db.vertexRegion,
      vertexClientEmail: db.vertexClientEmail,
      vertexPrivateKey: db.vertexPrivateKey,
      claudeAPIKey: db.claudeAPIKey,
      instructChatTemplate: asString(db.instructChatTemplate),
      jinjaTemplate: asString(db.JinjaTemplate),
      ollamaApiKey: asString(db.ollamaApiKey),
      ollamaRequestFormat: asNumber(db.ollamaRequestFormat),
      ollamaURL: asString(db.ollamaURL),
    },
  }
}

/**
 * Map the shared capability table's unsupported category to the specific /chat
 * error message clients/tests rely on. The routing decision is shared with
 * server-intent completion through Fastify; only the prose differs (see
 * `docs/structure/providers-and-models.md`).
 */
function chatProviderUnsupportedReason(reason: ProviderUnsupportedReason, info: ModelInfoLite): string {
  switch (reason) {
    case 'novelai':
      return 'unsupported /chat provider: NovelAI text generation must use local dispatch'
    case 'novellist':
      return 'unsupported /chat provider: NovelList must use local dispatch'
    case 'ooba':
      return 'unsupported /chat provider: Ooba OpenAI-compatible chat must use local dispatch'
    case 'plugin':
      return 'unsupported /chat provider: plugin providers must use local dispatch'
    case 'webllm':
      return 'unsupported /chat provider: local WebLLM models must use local dispatch'
    case 'config-incomplete':
      return `unsupported /chat provider: ${info.id} configuration is incomplete for server dispatch`
    case 'format-not-server-routable':
    default:
      return `unsupported /chat provider: ${info.format}`
  }
}

export type ChatProviderRoute = { routable: true; provider: string } | { routable: false; reason: string }
type ChatProviderRouteTarget = ModelInfoLite | ResolvedModelProfile

function isResolvedModelProfile(target: ChatProviderRouteTarget): target is ResolvedModelProfile {
  return 'providerCapability' in target && 'modelInfo' in target
}

/**
 * The /chat counterpart to `resolveServerCompletionRoute`. Profile-aware callers
 * carry the server-only unknown-id guard through `modelInfo.unsupportedReason`;
 * legacy callers still get the same guard from `resolveModelInfo`. The shared
 * `resolveProviderCapability` table owns the routing decision, so /chat cannot
 * drift from server-intent completion. The openai adapter applies
 * `oobaSystemHoist` for reverse-proxy Ooba mode.
 */
export function resolveChatProviderRoute(
  db: Database,
  target: ChatProviderRouteTarget = resolveModelInfo(db),
): ChatProviderRoute {
  let profile: ResolvedModelProfile | undefined
  let info: ModelInfoLite
  if (isResolvedModelProfile(target)) {
    profile = target
    info = target.modelInfo
  } else {
    info = target
  }
  if (info.unsupportedReason) {
    return { routable: false, reason: info.unsupportedReason }
  }
  const verdict = profile?.providerCapability ?? resolveProviderCapability(buildChatCapabilityInput(db, info))
  if (verdict.routable === true) return { routable: true, provider: verdict.provider }
  return { routable: false, reason: chatProviderUnsupportedReason(verdict.reason, info) }
}

function resolveBedrockWireModel(internalId: string): string {
  let useGlobal = false
  const dateMatch = internalId.match(/(\d{8})/)
  const datePart = dateMatch ? Number(dateMatch[1]) : NaN
  const versionMatch = internalId.match(/claude-(?:opus-|sonnet-|haiku-)?(\d+)-(\d+)/)
  if (!Number.isNaN(datePart) && datePart > 0) {
    useGlobal = datePart >= 20250929
  } else if (versionMatch) {
    const major = Number(versionMatch[1])
    const minor = Number(versionMatch[2])
    useGlobal = major > 4 || (major === 4 && minor >= 5)
  }
  return (useGlobal ? 'global.' : 'us.') + internalId
}

function parseLegacyProfileBedrockCredentials(apiKey: string | undefined): BedrockCredentials | null {
  if (!apiKey) return null
  const parts = apiKey.split(':')
  if (parts.length !== 3) {
    throw new Error('The key assigned to this request is invalid.')
  }
  const [accessKeyId, secretAccessKey, region] = parts
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error('The key assigned to this request is invalid.')
  }
  return { accessKeyId, secretAccessKey, region }
}

export function resolveProviderModel(
  db: Database,
  info: ModelInfoLite,
  provider: string,
  profile?: ResolvedModelProfile,
): string {
  if (profile) return resolveProfileRequestModel(profile)
  const aiModel = asString(db.aiModel) ?? ''
  if (aiModel === 'ollama-cloud') return db.ollamaCloudModel ?? ''
  if (provider === 'ollama') return db.ollamaModel ?? ''
  if (aiModel.startsWith('xcustom:::')) {
    const entry = findXcustomEntry(db, aiModel)
    const internal = asString(entry?.internalId)
    return internal ?? asString(entry?.id) ?? aiModel
  }
  if (aiModel === 'reverse_proxy') return db.customProxyRequestModel ?? ''
  if (provider === 'bedrock') return resolveBedrockWireModel(info.internalID ?? info.id)
  if (provider === 'horde') return aiModel.startsWith('horde:::') ? aiModel.slice('horde:::'.length) : aiModel
  if (provider === 'nanogpt') return db.nanogptRequestModel ?? ''
  if (provider === 'openrouter') return db.openrouterRequestModel ?? ''
  if (provider === 'gemini') {
    const raw = info.internalID ?? info.id
    return raw.startsWith('models/') ? raw.slice('models/'.length) : raw
  }
  if (provider === 'openai-legacy-instruct') {
    return info.format === LLMFormat.NanoGPTLegacy ? (db.nanogptRequestModel ?? '') : 'gpt-3.5-turbo-instruct'
  }
  if (provider === 'anthropic' && info.format === LLMFormat.NanoGPTMessages) {
    return db.nanogptRequestModel ?? ''
  }
  if (provider === 'openai-responses') {
    return info.format === LLMFormat.NanoGPTResponses ? (db.nanogptRequestModel ?? '') : (info.internalID ?? info.id)
  }
  return info.id
}

function resolveLegacyMirrorCustomApiBaseUrl(
  db: Database,
  profile: ResolvedModelProfile,
  baseUrl: string | undefined,
): { baseUrl: string | undefined; endpointUrl?: string; extraHeaders?: Record<string, string> } {
  const legacyUrl = asString(db.forceReplaceUrl)
  if (
    !baseUrl ||
    !legacyUrl ||
    asString(db.aiModel) !== 'reverse_proxy' ||
    profile.source.kind !== 'durable-profile' ||
    profile.status.providerId !== 'custom-api'
  ) {
    return { baseUrl }
  }

  const legacyStrippedBaseUrl = stripTrailingPath(legacyUrl, '/chat/completions')
  if (baseUrl !== legacyUrl && baseUrl !== legacyStrippedBaseUrl) {
    return { baseUrl }
  }

  const resolved = resolveReverseProxyUrl(legacyUrl, db.autofillRequestUrl !== false)
  return {
    baseUrl: resolved.baseUrl,
    endpointUrl: resolved.endpointUrl,
    ...(resolved.risuIdentify ? { extraHeaders: { 'X-Proxy-Risu': 'RisuAI' } } : {}),
  }
}

function resolveProfileOpenAIVariant(
  db: Database,
  profile?: ResolvedModelProfile,
): OpenAICompatibleVariant | null | undefined {
  if (!profile) return undefined
  const options = profile.providerOptions
  const apiKey = asString(options.apiKey)
  if (!apiKey && profile.status.providerId !== 'custom-api') return null
  const legacyMirror = resolveLegacyMirrorCustomApiBaseUrl(db, profile, asString(options.baseUrl))
  const extraHeaders =
    legacyMirror.extraHeaders || options.extraHeaders
      ? {
          ...(options.extraHeaders ?? {}),
          ...(legacyMirror.extraHeaders ?? {}),
        }
      : undefined
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl: legacyMirror.baseUrl,
    endpointUrl:
      legacyMirror.endpointUrl ??
      (profile.modelId === 'reverse_proxy' && options.reverseProxy?.autofillRequestUrl === false
        ? legacyMirror.baseUrl
        : undefined),
    extraHeaders,
    additionalParams: options.additionalParams,
    oobaSystemHoist: options.reverseProxy?.oobaSystemHoist === true,
    oobaArgs: options.reverseProxy?.oobaArgs,
  }
}

function resolveProfileOllamaBaseUrl(profile: ResolvedModelProfile): string | undefined {
  const options = profile.providerOptions
  return asString(options.ollama?.url) ?? asString(options.baseUrl)
}

function resolveOllamaThinkMode(value: unknown): boolean | 'low' | 'medium' | 'high' | undefined {
  if (value === 'off') return false
  if (value === 'on') return true
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return undefined
}

function resolveDebugEchoMessage(profile: ResolvedModelProfile): string {
  return JSON.stringify(
    {
      provider: 'debug-echo',
      baseUrl: profile.providerOptions.baseUrl ?? '',
      requestModel: profile.providerOptions.requestModel ?? '',
    },
    null,
    2,
  )
}

function resolveProfileVertexAuth(profile: ResolvedModelProfile): VertexAuthInput | undefined {
  const vertex = profile.providerOptions.vertex
  const projectId = asString(vertex?.projectId)
  const region = asString(vertex?.region)
  const clientEmail = asString(vertex?.clientEmail)
  const privateKey = asString(vertex?.privateKey)
  if (!projectId || !region || !clientEmail || !privateKey) return undefined
  return { projectId, region, clientEmail, privateKey }
}

export function resolveOpenAIVariant(
  db: Database,
  info: ModelInfoLite,
  provider: string,
  profile?: ResolvedModelProfile,
): OpenAICompatibleVariant | null {
  const profileVariant = resolveProfileOpenAIVariant(db, profile)
  if (profileVariant !== undefined) return profileVariant

  const aiModel = asString(db.aiModel) ?? ''
  if (aiModel === 'ollama-cloud') {
    const apiKey = asString(db.ollamaApiKey)
    return apiKey ? { apiKey, baseUrl: 'https://ollama.com/v1' } : null
  }
  if (provider === 'nanogpt') {
    const apiKey = asString(db.nanogptKey)
    return apiKey
      ? {
          apiKey,
          baseUrl: db.nanogptUseSubscriptionEndpoint === true ? NANOGPT_SUBSCRIPTION_BASE_URL : NANOGPT_BASE_URL,
          extraHeaders: asString(db.nanogptProvider) ? { 'X-Provider': db.nanogptProvider as string } : undefined,
        }
      : null
  }
  if (provider === 'openrouter') {
    const apiKey = asString(db.openrouterKey)
    return apiKey
      ? {
          apiKey,
          baseUrl: OPENROUTER_BASE_URL,
          extraHeaders: { 'X-Title': 'RisuAI', 'HTTP-Referer': 'https://risuai.xyz' },
        }
      : null
  }
  if (aiModel === 'reverse_proxy') {
    const apiKey = asString(db.proxyKey)
    const rawUrl = asString(db.forceReplaceUrl)
    if (!apiKey || !rawUrl) return null
    const { baseUrl, endpointUrl, risuIdentify } = resolveReverseProxyUrl(rawUrl, db.autofillRequestUrl !== false)
    return {
      apiKey,
      baseUrl,
      endpointUrl,
      extraHeaders: risuIdentify ? { 'X-Proxy-Risu': 'RisuAI' } : undefined,
      additionalParams: additionalParams(db.additionalParams),
      oobaSystemHoist: db.reverseProxyOobaMode === true,
      oobaArgs: db.reverseProxyOobaArgs,
    }
  }
  if (aiModel.startsWith('xcustom:::')) {
    const entry = findXcustomEntry(db, aiModel)
    const apiKey = asString(entry?.key)
    const url = asString(entry?.url)
    if (!entry || !apiKey || !url) return null
    return {
      apiKey,
      baseUrl: deriveOpenAIBaseUrl(url),
      endpointUrl: url,
      additionalParams: parseXcustomParams(entry.params),
    }
  }
  if (info.keyIdentifier) {
    const apiKey = asString(db.OaiCompAPIKeys?.[info.keyIdentifier])
    if (!apiKey) return null
    return {
      apiKey,
      baseUrl: info.endpoint ? deriveOpenAIBaseUrl(info.endpoint) : undefined,
      endpointUrl: info.endpoint,
    }
  }
  const apiKey = asString(db.openAIKey)
  return apiKey ? { apiKey } : null
}

function extractSystem(messages: PromptMessage[], newOAIHandle = true): { messages: PromptMessage[]; system?: string } {
  const systemTexts: string[] = []
  const passthrough: PromptMessage[] = []
  for (const row of messages) {
    if (row.role === 'system' && typeof row.content === 'string' && row.content.length > 0) {
      if (!(newOAIHandle && row.memo?.startsWith('NewChat'))) systemTexts.push(row.content)
    } else {
      passthrough.push(row)
    }
  }
  return systemTexts.length > 0
    ? { messages: passthrough, system: systemTexts.join('\n\n') }
    : { messages: passthrough }
}

function applyChatTemplate(db: Database, messages: PromptMessage[]): string {
  // Accepted divergence (PR-18/PR-7 sunset): Fastify intentionally does not
  // port the SPA's `src/ts/process/templates/chatTemplate.ts` engine.
  const type = asString(db.instructChatTemplate)
  if (type === 'chatml' || type === 'gpt2') {
    const rows = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      .map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`)
    return `${rows.join('')}<|im_start|>assistant\n`
  }
  const rows = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => `${m.role}: ${m.content}`)
  return `${rows.join('\n\n')}\n\nassistant:`
}

function unstringlizeChat(text: string, formated: PromptMessage[], char: string, username: string): string {
  const chunks = ['system note:', 'system:', 'system note：', 'system：']
  if (char) chunks.push(`${char}:`, `${char}：`, `${char}: `, `${char}： `)
  if (username) chunks.push(`${username}:`, `${username}：`, `${username}: `, `${username}： `)
  for (const row of formated) {
    if (row.name) chunks.push(`${row.name}:`, `${row.name}：`, `${row.name}: `, `${row.name}： `)
  }
  let minIndex = -1
  for (const chunk of chunks) {
    const index = text.indexOf(chunk)
    if (index !== -1 && (minIndex === -1 || index < minIndex)) minIndex = index
  }
  return minIndex === -1 ? text : text.substring(0, minIndex).trim()
}

function cleanupCharacterName(args: ChatDispatchArgs, db: Database): string {
  if (args.currentCharacterName) return args.currentCharacterName
  const currentChar = db.currentChar
  const selected = typeof currentChar === 'number' && Number.isInteger(currentChar) ? currentChar : 0
  return db.characters?.[selected]?.name ?? ''
}

async function* resultFrames(
  resultPromise: Promise<CompletionResult>,
  extractJsonPath?: string,
): AsyncGenerator<CompletionStreamFrame> {
  const result = await resultPromise
  if (result.aborted === true) return
  if (result.type === 'fail') {
    yield {
      kind: 'error',
      error: result.result,
      ...(typeof result.status === 'number' ? { status: result.status } : {}),
      ...(result.statusText ? { statusText: result.statusText } : {}),
      ...(result.code ? { code: result.code } : {}),
      ...(result.nonRetryable === true ? { nonRetryable: true } : {}),
      ...(result.apiMetadata ? { apiMetadata: result.apiMetadata } : {}),
    }
    return
  }
  const content = extractJsonPath ? extractConfiguredJsonValue(result.result, extractJsonPath) : result.result
  const alternates = extractJsonPath
    ? result.alternates?.map((alternate) => extractConfiguredJsonValue(alternate, extractJsonPath))
    : result.alternates
  if (content.length > 0) yield { kind: 'token', content }
  yield {
    kind: 'done',
    finishReason: result.toolCalls?.length ? 'tool_calls' : 'stop',
    ...(alternates?.length ? { alternates } : {}),
    ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
    ...(result.model !== undefined || result.apiMetadata
      ? { apiMetadata: { ...(result.model !== undefined ? { model: result.model } : {}), ...result.apiMetadata } }
      : {}),
  }
}

export async function dispatchChatProvider(args: ChatDispatchArgs): Promise<AsyncIterable<CompletionStreamFrame>> {
  try {
    return await dispatchChatProviderPrepared(args)
  } catch (error) {
    recordProviderDispatchFailure(args.signal)
    throw error
  }
}

async function dispatchChatProviderPrepared(args: ChatDispatchArgs): Promise<AsyncIterable<CompletionStreamFrame>> {
  const profile = args.profile ?? resolveModelProfile({ database: args.database })
  const finalizedMessages = reformatMessages(args.database, args.formated, profile.modelInfo.flags)
  const handle = args.history
    ? tryBeginRequestHistory({
        db: args.history.db,
        limit: args.database.requestHistoryLimit,
        source: args.history.source,
        profile: requestHistoryProfileSnapshot(profile),
        prompt:
          (args.toolRounds?.length ?? 0) > 0
            ? { messages: finalizedMessages, toolRounds: args.toolRounds }
            : finalizedMessages,
        context: args.history.context,
        toggles: args.history.toggles,
        metadata: {
          responseBudget: args.outputTokens ?? args.database.maxResponse,
          maxContext: args.database.maxContext,
          streamingRequested: args.database.useStreaming === true || args.database.halfStreaming === true,
          halfStreamingRequested: args.database.halfStreaming === true,
          multiGenerationRequested: args.multiGeneration === true,
          toolCount: args.tools?.length ?? 0,
          toolRoundCount: args.toolRounds?.length ?? 0,
          ...(args.history.metadata ?? {}),
        },
        redactionValues: requestHistoryRedactionValues(profile.providerOptions),
      })
    : null
  try {
    const frames = await dispatchChatProviderCore({ ...args, profile, finalizedMessages })
    const processedFrames = profile.runtimeOptions.stripCoT
      ? stripCoTFromCompletionFrames(frames, {
          buffered: args.database.useStreaming !== true && args.database.halfStreaming !== true,
          ...(args.database.halfStreaming === true
            ? { countTokens: (content: string) => tokenize(content, tokenizerEncodingFromDb(args.database)) }
            : {}),
        })
      : frames
    return wrapRequestHistoryFrames(processedFrames, handle, args.signal)
  } catch (error) {
    completeRequestHistory(handle, {
      status: args.signal.aborted ? 'cancelled' : 'error',
      error: error instanceof Error ? error.message : String(error),
      metadata: { dispatchFailedBeforeFrames: true },
    })
    throw error
  }
}

async function dispatchChatProviderCore(args: ChatDispatchArgs): Promise<AsyncIterable<CompletionStreamFrame>> {
  const { database: db, outputTokens, signal, trace } = args
  await ensureTokenizerLoadedForDb(db)
  const profile = args.profile ?? resolveModelProfile({ database: db })
  assertModelProfileGenerationReady(profile)
  const info = profile.modelInfo
  const route = resolveChatProviderRoute(db, profile)
  if (route.routable === false) {
    if (
      info.format === LLMFormat.Ollama &&
      profile.modelId !== 'ollama-cloud' &&
      !resolveProfileOllamaBaseUrl(profile)
    ) {
      throw new Error('options.ollama.baseUrl is required')
    }
    throw new Error(route.reason)
  }
  const provider = route.provider
  const resolvedAdditionalParams = getProfileAdditionalParameters(
    db,
    profile.modelId,
    profile.providerOptions.additionalParams,
    profile.providerOptions.extraHeaders,
  )
  const dispatchAdditionalParams = resolvedAdditionalParams.length > 0 ? resolvedAdditionalParams : undefined

  const configuredModel = resolveProviderModel(db, info, provider, profile)
  let model = configuredModel
  let openRouterVariant: OpenAICompatibleVariant | null | undefined
  if (provider === 'openrouter') {
    openRouterVariant = resolveOpenAIVariant(db, info, provider, profile)
    if (!openRouterVariant) throw new Error('options.openai.apiKey is required')
    model = await resolveOpenRouterFreeModel(configuredModel, {
      apiKey: openRouterVariant.apiKey,
      signal,
    })
    if (model !== configuredModel) args.onResolvedModel?.(model)
  }
  const preSummary = summarizePromptRows(args.formated)
  const messages = args.finalizedMessages ?? reformatMessages(db, args.formated, info.flags)
  const postSummary = summarizePromptRows(messages)
  emitProtocolMetric('generation_prompt_dispatch_reformat', {
    provider,
    modelId: profile.modelId,
    wireModel: model,
    profileId: profile.profileId,
    profileSourceKind: profile.source.kind,
    profileSourceField: profile.source.field,
    profileSourceProfileId: profile.source.profileId,
    profileProviderId: profile.status.providerId,
    profileProviderIdSource: profile.status.providerIdSource,
    modelInfoId: info.id,
    modelInfoInternalId: info.internalID,
    modelInfoFormat: info.format,
    modelInfoFlags: info.flags,
    ...promptSummaryMetricFields(preSummary, 'prePrompt'),
    ...promptSummaryMetricFields(postSummary, 'postPrompt'),
    promptReformatted: preSummary.promptHash !== postSummary.promptHash,
    promptRowCountChanged: preSummary.rowCount !== postSummary.rowCount,
    promptRoleSequenceChanged: preSummary.roleSequence.join(',') !== postSummary.roleSequence.join(','),
    promptReferenceChanged: messages !== args.formated,
  })
  const maxTokens = outputTokens ?? db.maxResponse
  const parameters = resolveDispatchParameters(db, profile)
  const isLLMGatewayProfile = profile.status.providerId === 'llmgateway'
  const llmGatewayOptions = isLLMGatewayProfile ? profile.providerOptions.llmGateway : undefined
  const temperature = parameters.temperature
  const supportsMultiGeneration = provider === 'openai' || provider === 'openrouter' || provider === 'nanogpt'
  const generationCount =
    args.multiGeneration === true &&
    supportsMultiGeneration &&
    typeof db.genTime === 'number' &&
    Number.isInteger(db.genTime) &&
    db.genTime > 1
      ? Math.min(db.genTime, 20)
      : 1
  const extractJsonPath =
    (db.jsonSchemaEnabled === true || args.schema !== undefined) &&
    typeof db.extractJson === 'string' &&
    db.extractJson.trim().length > 0
      ? db.extractJson.trim()
      : undefined
  const hasTools = (args.tools?.length ?? 0) > 0
  const imageResponse = db.outputImageModal === true || info.flags.includes(LLMFlags.hasImageOutput)
  const audioResponse = !imageResponse && info.flags.includes(LLMFlags.hasAudioOutput)
  const geminiResponseModalities: readonly GeminiResponseModality[] | undefined =
    provider === 'gemini'
      ? imageResponse
        ? ['TEXT', 'IMAGE']
        : audioResponse
          ? ['TEXT', 'AUDIO']
          : undefined
      : undefined
  const stream =
    !hasTools &&
    (db.useStreaming === true || db.halfStreaming === true) &&
    generationCount === 1 &&
    extractJsonPath === undefined &&
    geminiResponseModalities === undefined
  const bufferedResultFrames = (result: Promise<CompletionResult>): AsyncGenerator<CompletionStreamFrame> =>
    resultFrames(result, extractJsonPath)
  const textMessages = sanitizeTextMessages(messages, {
    newOAIHandle: db.newOAIHandle !== false,
    developerRole: info.flags.includes(LLMFlags.DeveloperRole),
  })

  if (hasTools && !['openai', 'openrouter', 'nanogpt', 'openai-responses', 'anthropic', 'gemini'].includes(provider)) {
    throw new Error(`tools are not supported by the resolved ${provider} provider`)
  }

  if (provider === 'echo') {
    const isDebugEchoProfile = profile.status.providerId === 'debug-echo'
    const request = resolveEchoRequest({
      message: isDebugEchoProfile ? resolveDebugEchoMessage(profile) : db.echoMessage,
      delayMs: isDebugEchoProfile ? 0 : (db.echoDelay ?? 0) * 1000,
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    return stream ? runEchoStream(request) : bufferedResultFrames(runEcho(request))
  }

  if (provider === 'openai' || provider === 'openrouter') {
    const variant = provider === 'openrouter' ? openRouterVariant : resolveOpenAIVariant(db, info, provider, profile)
    if (!variant) throw new Error('options.openai.apiKey is required')
    const request = resolveOpenAIRequest({
      model,
      messages: appendOpenAIToolRounds(
        buildOpenAIWireMessages(messages, {
          flags: info.flags,
          newOAIHandle: db.newOAIHandle !== false,
          visionQuality: db.gptVisionQuality,
        }),
        args.toolRounds ?? [],
      ),
      apiKey: variant.apiKey,
      baseUrl: variant.baseUrl,
      endpointUrl: variant.endpointUrl,
      maxTokens,
      temperature,
      topP: parameters.topP,
      topK: parameters.topK,
      minP: parameters.minP,
      topA: parameters.topA,
      repetitionPenalty: parameters.repetitionPenalty,
      frequencyPenalty: parameters.frequencyPenalty,
      presencePenalty: parameters.presencePenalty,
      reasoningEffort: isLLMGatewayProfile ? llmGatewayOptions?.reasoningEffort : parameters.reasoningEffort,
      verbosity: isLLMGatewayProfile ? llmGatewayOptions?.verbosity : parameters.verbosity,
      serviceTier: llmGatewayOptions?.serviceTier,
      flexProcessing:
        db.openAIFlexProcessing === true &&
        (info.provider === LLMProvider.OpenAI ||
          profile.modelId === 'reverse_proxy' ||
          profile.modelId === 'custom-api' ||
          profile.modelId.startsWith('xcustom:::') ||
          profile.status.providerId === 'custom-api'),
      routing: llmGatewayOptions?.routing,
      seed: db.generationSeed,
      responseFormat: openAIChatResponseFormat(db, info.flags),
      prediction: db.OAIPrediction,
      openRouter: resolveOpenRouterRequestOptions(provider, profile),
      n: generationCount,
      useCompletionTokens: info.flags.includes(LLMFlags.OAICompletionTokens),
      thinking: resolveDeepSeekThinking(db, info.flags),
      deepSeekThinkingOutput: info.flags.includes(LLMFlags.deepSeekThinkingOutput),
      logitBias: resolveOpenAILogitBias(args.biases ?? [], model, tokenizerEncodingFromDb(db)),
      extraHeaders: variant.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      oobaSystemHoist: variant.oobaSystemHoist,
      oobaArgs: variant.oobaArgs,
      signal,
      trace,
      tools: args.tools,
    })
    if (!request) throw new Error('apiKey is required')
    return stream ? runOpenAIStream(request) : bufferedResultFrames(runOpenAI(request))
  }

  if (provider === 'nanogpt') {
    const variant = resolveOpenAIVariant(db, info, provider, profile)
    if (!variant) throw new Error('options.nanogpt.apiKey is required')
    const request = resolveOpenAIRequest({
      model,
      messages: appendOpenAIToolRounds(
        buildOpenAIWireMessages(messages, {
          flags: info.flags,
          newOAIHandle: db.newOAIHandle !== false,
          visionQuality: db.gptVisionQuality,
        }),
        args.toolRounds ?? [],
      ),
      apiKey: variant.apiKey,
      baseUrl: variant.baseUrl,
      endpointUrl: variant.endpointUrl,
      maxTokens,
      temperature,
      topP: parameters.topP,
      topK: parameters.topK,
      minP: parameters.minP,
      topA: parameters.topA,
      repetitionPenalty: parameters.repetitionPenalty,
      frequencyPenalty: parameters.frequencyPenalty,
      presencePenalty: parameters.presencePenalty,
      reasoningEffort: parameters.reasoningEffort,
      verbosity: parameters.verbosity,
      seed: db.generationSeed,
      responseFormat: openAIChatResponseFormat(db, info.flags),
      prediction: db.OAIPrediction,
      openRouter: resolveOpenRouterRequestOptions(provider, profile),
      n: generationCount,
      useCompletionTokens: info.flags.includes(LLMFlags.OAICompletionTokens),
      thinking: resolveDeepSeekThinking(db, info.flags),
      deepSeekThinkingOutput: info.flags.includes(LLMFlags.deepSeekThinkingOutput),
      logitBias: resolveOpenAILogitBias(args.biases ?? [], model, tokenizerEncodingFromDb(db)),
      extraHeaders: variant.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      oobaSystemHoist: variant.oobaSystemHoist,
      oobaArgs: variant.oobaArgs,
      signal,
      trace,
      tools: args.tools,
    })
    if (!request) throw new Error('options.nanogpt.apiKey is required')
    return stream ? runOpenAIStream(request) : bufferedResultFrames(runOpenAI(request))
  }

  if (provider === 'anthropic') {
    const extracted = extractSystem(messages, db.newOAIHandle !== false)
    const providerOptions = profile.providerOptions
    const request = resolveAnthropicRequest({
      model,
      messages: buildAnthropicWireMessages(extracted.messages, {
        oneHourCache: db.claude1HourCaching === true,
        newOAIHandle: db.newOAIHandle !== false,
      }),
      apiKey: asString(providerOptions.apiKey),
      baseUrl: asString(providerOptions.baseUrl),
      system: extracted.system,
      maxTokens,
      temperature,
      topP: parameters.topP,
      topK: parameters.topK,
      thinkingTokens: parameters.thinkingTokens,
      thinkingType: db.thinkingType,
      adaptiveThinkingEffort: db.adaptiveThinkingEffort,
      supportsAdaptiveThinking: info.flags.includes(LLMFlags.claudeAdaptiveThinking),
      supportsXHighEffort: info.flags.includes(LLMFlags.claudeXHighEffort),
      oneHourCache: db.claude1HourCaching === true,
      extraHeaders: providerOptions.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      signal,
      tools: args.tools,
      toolRounds: args.toolRounds,
    })
    if (!request) throw new Error('options.anthropic.apiKey is required')
    return stream ? runAnthropicStream(request) : bufferedResultFrames(runAnthropic(request))
  }

  if (provider === 'mistral') {
    const providerOptions = profile.providerOptions
    const request = resolveMistralRequest({
      model,
      messages: textMessages,
      apiKey: asString(providerOptions.apiKey),
      baseUrl: asString(providerOptions.baseUrl),
      maxTokens,
      temperature,
      presencePenalty: parameters.presencePenalty,
      frequencyPenalty: parameters.frequencyPenalty,
      topP: parameters.topP,
      extraHeaders: providerOptions.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('options.mistral.apiKey is required')
    return stream ? runMistralStream(request) : bufferedResultFrames(runMistral(request))
  }

  if (provider === 'cohere') {
    const providerOptions = profile.providerOptions
    const isNewerCommandR =
      profile.modelId === 'cohere-command-r-03-2024' || profile.modelId === 'cohere-command-r-plus-04-2024'
    if (!asString(providerOptions.apiKey)) throw new Error('options.cohere.apiKey is required')
    const request = resolveCohereRequest({
      model,
      messages: textMessages,
      apiKey: asString(providerOptions.apiKey),
      baseUrl: asString(providerOptions.baseUrl),
      safetyMode: isNewerCommandR ? undefined : 'NONE',
      temperature,
      topK: parameters.topK,
      topP: parameters.topP,
      presencePenalty: parameters.presencePenalty,
      frequencyPenalty: parameters.frequencyPenalty,
      extraHeaders: providerOptions.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('cohere requires a user message to generate a response')
    return bufferedResultFrames(runCohere(request))
  }

  if (provider === 'gemini') {
    const providerOptions = profile.providerOptions
    const vertex = info.format === LLMFormat.VertexAIGemini ? resolveProfileVertexAuth(profile) : undefined
    const request = resolveGeminiRequest({
      model,
      messages,
      apiKey: info.format === LLMFormat.VertexAIGemini ? undefined : asString(providerOptions.apiKey),
      vertex,
      baseUrl: asString(providerOptions.baseUrl),
      maxOutputTokens: maxTokens,
      temperature,
      topP: parameters.topP,
      topK: parameters.topK,
      presencePenalty: parameters.presencePenalty,
      frequencyPenalty: parameters.frequencyPenalty,
      thinkingTokens: parameters.thinkingTokens,
      thinkingLevel: parameters.reasoningEffort,
      thinkingLevelNoMinimal: info.flags.includes(LLMFlags.geminiThinkingNoMinimal),
      geminiBlockOff: info.flags.includes(LLMFlags.geminiBlockOff),
      noCivilIntegrity: info.flags.includes(LLMFlags.noCivilIntegrity),
      responseSchema: geminiResponseSchema(db, args.schema),
      extraHeaders: providerOptions.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      streamThoughts: db.streamGeminiThoughts === true,
      signal,
      trace,
      tools: args.tools,
      toolRounds: args.toolRounds,
      responseModalities: geminiResponseModalities,
      persistInlineData: args.inlayAssetPersistence
        ? async (inlineData: GeminiInlineData) => {
            const compactBase64 = inlineData.data.replace(/\s/gu, '')
            if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compactBase64) || compactBase64.length % 4 === 1) {
              throw new Error('Gemini returned invalid base64 inlineData')
            }
            const bytes = Buffer.from(compactBase64, 'base64')
            if (bytes.length === 0) throw new Error('Gemini returned empty inlineData')
            const mediaType = inlineData.mimeType.split('/', 1)[0]
            return persistServerInlayAsset(args.inlayAssetPersistence!.db, args.inlayAssetPersistence!.dataDir, {
              bytes,
              contentType: inlineData.mimeType,
              name: mediaType === 'audio' ? 'gemini-audio' : mediaType === 'image' ? 'gemini-image' : 'gemini-media',
            })
          }
        : undefined,
      onWarning: args.onWarning,
    })
    if (!request) throw new Error('options.gemini.apiKey or options.gemini.vertex is required')
    return stream ? runGeminiStream(request) : bufferedResultFrames(runGemini(request))
  }

  if (provider === 'openai-legacy-instruct') {
    const variant = resolveProfileOpenAIVariant(db, profile)
    if (!variant) throw new Error('options["openai-legacy-instruct"].apiKey is required')
    const request = resolveOpenAILegacyInstructRequest({
      model,
      messages: textMessages,
      apiKey: variant.apiKey,
      baseUrl: variant.baseUrl,
      maxTokens,
      temperature,
      topP: parameters.topP,
      presencePenalty: parameters.presencePenalty,
      frequencyPenalty: parameters.frequencyPenalty,
      extraHeaders: variant.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('options["openai-legacy-instruct"].apiKey is required')
    return bufferedResultFrames(runOpenAILegacyInstruct(request))
  }

  if (provider === 'openai-responses') {
    const variant = resolveProfileOpenAIVariant(db, profile)
    if (!variant) throw new Error('options["openai-responses"].apiKey is required')
    const responseTools = [
      ...openAIResponsesToolDefinitions(args.tools ?? []),
      ...(profile.runtimeOptions.modelTools.includes('search') ? [{ type: 'web_search_preview' }] : []),
    ]
    const request = resolveOpenAIResponsesRequest({
      model,
      messages,
      apiKey: variant.apiKey,
      baseUrl: variant.baseUrl,
      endpointUrl: variant.endpointUrl,
      maxOutputTokens: maxTokens,
      temperature,
      topP: parameters.topP,
      reasoningEffort: parameters.reasoningEffort,
      reasoningSummary: info.parameters.includes('reasoning_effort'),
      verbosity: parameters.verbosity,
      responseFormat: openAIResponsesFormat(db),
      tools: responseTools.length > 0 ? responseTools : undefined,
      toolRounds: args.toolRounds,
      developerRole: info.flags.includes(LLMFlags.DeveloperRole),
      visionQuality: db.gptVisionQuality,
      newOAIHandle: db.newOAIHandle !== false,
      // OpenAI Responses stores requests by default. Preserve the retained
      // privacy contract; Ollama Cloud does not accept this OpenAI-only field.
      store: profile.modelId === 'ollama-cloud' ? undefined : false,
      extraHeaders: variant.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('options["openai-responses"].apiKey is required')
    return bufferedResultFrames(runOpenAIResponses(request))
  }

  if (provider === 'kobold') {
    const providerOptions = profile.providerOptions
    const request = resolveKoboldRequest({
      messages: textMessages,
      baseUrl: asString(providerOptions.baseUrl),
      maxTokens,
      maxContextLength: db.maxContext,
      temperature,
      topP: parameters.topP,
      topK: parameters.topK,
      topA: parameters.topA,
      repetitionPenalty: parameters.repetitionPenalty,
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('options.kobold.baseUrl is required')
    return bufferedResultFrames(runKobold(request))
  }

  if (provider === 'ooba-legacy') {
    // Compatibility policy: Ooba Legacy remains buffered HTTP. The legacy
    // settings UI disables streaming for this transport instead of reviving
    // the retired WebSocket adapter.
    const providerOptions = profile.providerOptions
    const ooba = db.ooba
    const request = resolveOobaLegacyRequest({
      messages: textMessages,
      baseUrl: asString(providerOptions.baseUrl),
      apiKey: asString(providerOptions.apiKey),
      maxTokens,
      truncationLength: maxTokens,
      // Ooba Legacy predates the model-capability parameter table and keeps its
      // own sampler block. Preserve that contract even though the model row's
      // `parameters` array is intentionally empty.
      temperature: normalizeDispatchSampler(db.temperature, { scale: 100 }),
      topP: ooba?.top_p,
      topK: ooba?.top_k,
      minP: parameters.minP,
      typicalP: ooba?.typical_p,
      repetitionPenalty: ooba?.repetition_penalty,
      encoderRepetitionPenalty: ooba?.encoder_repetition_penalty,
      minLength: ooba?.min_length,
      noRepeatNgramSize: ooba?.no_repeat_ngram_size,
      numBeams: ooba?.num_beams,
      penaltyAlpha: ooba?.penalty_alpha,
      lengthPenalty: ooba?.length_penalty,
      topA: ooba?.top_a,
      tfs: ooba?.tfs,
      epsilonCutoff: ooba?.epsilon_cutoff,
      etaCutoff: ooba?.eta_cutoff,
      doSample: ooba?.do_sample,
      earlyStopping: ooba?.early_stopping,
      seed: ooba?.seed,
      addBosToken: ooba?.add_bos_token,
      banEosToken: ooba?.ban_eos_token,
      skipSpecialTokens: ooba?.skip_special_tokens,
      stoppingStrings:
        db.localStopStrings?.map((value: string) => value.replace(/\\n/gu, '\n')) ??
        buildOobaLegacyStopStrings(ooba?.formating?.userPrefix ?? '', db.username ?? 'User'),
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('options["ooba-legacy"].baseUrl is required')
    const charName = cleanupCharacterName(args, db)
    return bufferedResultFrames(
      runOobaLegacy(request).then((result) =>
        result.type === 'success'
          ? {
              ...result,
              result: unstringlizeChat(result.result, messages, charName, db.username ?? ''),
            }
          : result,
      ),
    )
  }

  if (provider === 'ollama') {
    const request = resolveOllamaRequest({
      model,
      messages: textMessages,
      baseUrl: resolveProfileOllamaBaseUrl(profile),
      apiKey: asString(profile.providerOptions.apiKey),
      maxTokens,
      temperature,
      topP: parameters.topP,
      topK: parameters.topK,
      think: resolveOllamaThinkMode(profile.providerOptions.ollama?.thinkingMode ?? db.ollamaThinkingMode),
      extraHeaders: profile.providerOptions.extraHeaders,
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('options.ollama.baseUrl is required')
    return stream ? runOllamaStream(request) : bufferedResultFrames(runOllama(request))
  }

  if (provider === 'bedrock') {
    const credentials = parseLegacyProfileBedrockCredentials(asString(profile.providerOptions.apiKey))
    if (!credentials) throw new Error('options.bedrock.credentials is required')
    const extracted = extractSystem(messages, db.newOAIHandle !== false)
    const request = resolveBedrockRequest({
      model,
      messages: buildAnthropicWireMessages(extracted.messages, {
        oneHourCache: db.claude1HourCaching === true,
        newOAIHandle: db.newOAIHandle !== false,
      }),
      credentials,
      system: extracted.system,
      maxTokens,
      temperature,
      topP: parameters.topP,
      topK: parameters.topK,
      thinkingTokens: parameters.thinkingTokens,
      thinkingType: db.thinkingType,
      adaptiveThinkingEffort: db.adaptiveThinkingEffort,
      supportsAdaptiveThinking: info.flags.includes(LLMFlags.claudeAdaptiveThinking),
      supportsXHighEffort: info.flags.includes(LLMFlags.claudeXHighEffort),
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('bedrock could not resolve request from the given options')
    return bufferedResultFrames(runBedrock(request))
  }

  if (provider === 'horde') {
    const providerOptions = profile.providerOptions
    const request = resolveHordeRequest({
      prompt: applyChatTemplate(db, textMessages as PromptMessage[]),
      model,
      apiKey: asString(providerOptions.apiKey),
      maxTokens,
      maxContextLength: typeof db.maxContext === 'number' ? db.maxContext + 100 : undefined,
      temperature,
      topK: normalizeDispatchSampler(db.top_k),
      topP: normalizeDispatchSampler(db.top_p),
      additionalParams: dispatchAdditionalParams,
      signal,
    })
    if (!request) throw new Error('options.horde.prompt is required')
    const charName = cleanupCharacterName(args, db)
    return bufferedResultFrames(
      runHorde(request).then((result) =>
        result.type === 'success'
          ? {
              ...result,
              result: unstringlizeChat(result.result, messages, charName, db.username ?? ''),
            }
          : result,
      ),
    )
  }

  throw new Error(`provider not implemented yet: ${provider}`)
}

export function getServerGenerationModelString(
  db: Database,
  profile?: ResolvedModelProfile,
  resolvedRequestModel?: string,
): string {
  const name = profile?.modelId ?? db.aiModel
  const durableRequestModel = profile?.source.kind === 'durable-profile' ? profile.requestModel : undefined
  switch (name) {
    case 'reverse_proxy':
      return `custom-${db.reverseProxyOobaMode ? 'ooba' : durableRequestModel || db.customProxyRequestModel}`
    case 'openrouter':
      return `openrouter-${resolvedRequestModel || durableRequestModel || profile?.requestModel || db.openrouterRequestModel}`
    case 'nanogpt': {
      const modelLabel = durableRequestModel || db.nanogptRequestModelName || db.nanogptRequestModel
      const subscription =
        profile?.providerOptions.nanogpt?.useSubscriptionEndpoint ?? db.nanogptUseSubscriptionEndpoint
      return `NanoGPT ${modelLabel}${subscription ? ' [SUB]' : ''}`
    }
    case 'ollama-hosted':
    case 'ollama-cloud': {
      const modelLabel =
        durableRequestModel ||
        (name === 'ollama-cloud'
          ? db.ollamaCloudModelName || db.ollamaCloudModel
          : db.ollamaModelName || db.ollamaModel)
      return `Ollama ${name === 'ollama-cloud' ? 'Cloud' : 'Local'} ${modelLabel}`
    }
    default:
      return name ?? ''
  }
}
