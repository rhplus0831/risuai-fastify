import { captureClientSessionGeneration, clientSessionStore, isClientSessionManaged } from '../../clientSession'
import { isClientWriteOperationCurrent } from '../../clientWriteOperation'
import { Ollama } from 'ollama/dist/browser.mjs'
import { language } from '../../../lang'
import { fetchNative, globalFetch } from '../../globalApi.svelte'
import {
  modelProfileGenerationBlockReason,
  resolveModelProfile,
  resolveModelProfileByProfileId,
  type ModelProfileFallbackRef,
  type ResolvedModelProfile,
} from '../../model/modelProfileResolver'
import { LLMFlags, LLMFormat, type LLMModel } from '../../model/modellist'
import { risuChatParser, risuEscape, risuUnescape } from '../../parser/parser.svelte'
import { isPluginRuntimeReady, pluginProcess, pluginV2 } from '../../plugins/plugins.svelte'
import { settingsResourceState } from '../../server/resourceState.svelte'
import { SETTINGS_GROUPS } from '../../server/settingsGroups'
import { type character, type Database } from '../../storage/database.svelte'
import { getNodeServerProxyAuth } from '../../storage/fastifyStorage'
import { tokenizeNum } from '../../tokenizer'
import { simplifySchema, sleep } from '../../util'
import type { OpenAIChat } from '../index.svelte'
import type { GenerationDisplayProjectionRef } from '../generationDisplayProjection.svelte'
import { callTool, decodeToolCall, encodeToolCall, getTools } from '../mcp/mcp'
import type { MCPTool } from '../mcp/mcplib'
import { NovelAIBadWordIds, stringlizeNAIChat } from '../models/nai'
import { OobaParams } from '../prompt'
import { getStopStrings, stringlizeAINChat, unstringlizeAIN, unstringlizeChat } from '../stringlize'
import { applyChatTemplate } from '../templates/chatTemplate'
import { runTransformers } from '../transformers'
import { runTrigger } from '../triggers'
import { requestClaude } from './anthropic'
import { requestGoogleCloudVertex } from './google'
import { requestOpenAI, requestOpenAILegacyInstruct, requestOpenAIResponseAPI } from './openAI/requests'
import { resolveServerCompletionRoute, requestServerCompletion } from './serverCompletion'
import type { ServerToolCall, ServerToolRound } from '@risuai/protocol/server-tool'
import {
  applyAdditionalParameters,
  applyParameters,
  getAdditionalParameters,
  getRequestAdditionalParameters,
  type ModelModeExtended,
} from './shared'

export type ToolCall = {
  name: string
  arguments: string
}

interface requestDataArgument {
  /** Request-scoped settings/model snapshot. Normal chat dispatch must provide this owner explicitly. */
  database?: Database
  formated: OpenAIChat[]
  bias: { [key: number]: number }
  biasString?: [string, number][]
  currentChar?: character
  temperature?: number
  maxTokens?: number
  PresensePenalty?: number
  frequencyPenalty?: number
  useStreaming?: boolean
  forceStreaming?: boolean
  isGroupChat?: boolean
  useEmotion?: boolean
  continue?: boolean
  chatId?: string
  noMultiGen?: boolean
  schema?: string
  extractJson?: string
  imageResponse?: boolean
  previewBody?: boolean
  staticModel?: string
  fallbackProfileId?: string
  profileIdOverride?: string
  strictProfileIdOverride?: boolean
  escape?: boolean
  tools?: MCPTool[]
  toolRounds?: ServerToolRound[]
  rememberToolUsage?: boolean
  blockPlugins?: boolean
}

function requestSettingsOwner(explicit?: Database): Database | null {
  if (explicit) return explicit
  if (settingsResourceState.status !== 'ready') return null
  if (SETTINGS_GROUPS.some((group) => settingsResourceState.groupStatuses[group] !== 'ready')) return null
  return settingsResourceState.value as unknown as Database
}

function requestCurrentChat(arg: Pick<requestDataArgument, 'currentChar'>) {
  const currentChar = arg.currentChar
  return currentChar?.chats?.[currentChar.chatPage]
}

export interface RequestDataArgumentExtended extends requestDataArgument {
  database: Database
  aiModel?: string
  multiGen?: boolean
  abortSignal?: AbortSignal
  resolvedProfile?: ResolvedModelProfile
  modelInfo?: LLMModel
  customURL?: string
  mode?: ModelModeExtended
  key?: string
  additionalOutput?: string
  saveSignatures?: boolean
  serverOwnedOllamaAuth?: string
}

export type requestDataResponse =
  | {
      type: 'success' | 'fail'
      result: string
      noRetry?: boolean
      special?: {
        emotion?: string
      }
      failByServerError?: boolean
      model?: string
      status?: number
      statusText?: string
      code?: string
      toolCalls?: ServerToolCall[]
    }
  | {
      type: 'streaming'
      result: ReadableStream<StreamResponseChunk>
      /** Buffer visible text until the stream completes while reporting throughput. */
      halfStreaming?: boolean
      /** The server-chat adapter already owns throughput updates for this stream. */
      halfStreamingProgressManaged?: boolean
      /** Durable replay discarded at least one semantic frame before this projection. */
      replayGapTruncated?: boolean
      /** A gap was observed and the canonical terminal snapshot has not arrived yet. */
      replayGapPending?: boolean
      /** Server-selected row behavior for Continue. */
      continueDisposition?: 'append' | 'extend'
      /** Immutable pre-generation assistant text for extend-Continue replay rendering. */
      continueBase?: string
      /** In-place transient row target for a negotiated regenerate stream. */
      generationDisplayProjection?: GenerationDisplayProjectionRef
      special?: {
        emotion?: string
      }
      model?: string
    }
  | {
      type: 'multiline'
      result: ['user' | 'char', string][]
      special?: {
        emotion?: string
      }
      model?: string
    }

export interface StreamResponseChunk {
  [key: string]: string
}

async function withHalfStreamingMode(
  response: Promise<requestDataResponse>,
  halfStreaming: boolean,
): Promise<requestDataResponse> {
  const resolved = await response
  if (resolved.type !== 'streaming' || !halfStreaming) return resolved
  return { ...resolved, halfStreaming: true }
}

function additionalParamsForRequest(arg: RequestDataArgumentExtended): [string, string][] {
  const providerOptions = arg.resolvedProfile?.providerOptions
  return arg.resolvedProfile
    ? getRequestAdditionalParameters(
        arg.database,
        arg.aiModel,
        providerOptions?.additionalParams ?? [],
        providerOptions?.extraHeaders,
      )
    : getAdditionalParameters(arg.database, arg.aiModel)
}

type OllamaThinkMode = boolean | 'low' | 'medium' | 'high'

const OLLAMA_TOOL_LOOP_LIMIT = 8

type OllamaToolDefinition = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

type OllamaToolCall = {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

type OllamaCloudToolProtocol = 'native' | 'openai-chat' | 'openai-responses' | 'anthropic'

interface RequestFallbackAttempt {
  staticModel: string
  fallbackProfileId?: string
  modelId?: string
}

function getOllamaThinkMode(mode: string): OllamaThinkMode | undefined {
  switch (mode) {
    case 'off':
      return false
    case 'on':
      return true
    case 'low':
    case 'medium':
    case 'high':
      return mode
    default:
      return undefined
  }
}

function getOllamaCloudToolProtocol(format: LLMFormat): OllamaCloudToolProtocol | null {
  switch (format) {
    case LLMFormat.Ollama:
      return 'native'
    case LLMFormat.OpenAICompatible:
      return 'openai-chat'
    case LLMFormat.OpenAIResponseAPI:
      return 'openai-responses'
    case LLMFormat.Anthropic:
      return 'anthropic'
    default:
      return null
  }
}

function ollamaCloudToolProxyUrl(arg: RequestDataArgumentExtended, protocol: OllamaCloudToolProtocol): string {
  const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin
  const url = new URL('/api/v1/generate/completion', origin)
  url.searchParams.set('operation', 'ollama-cloud-tool')
  url.searchParams.set('protocol', protocol)
  url.searchParams.set('mode', arg.mode ?? 'model')
  if (arg.resolvedProfile?.source.kind === 'durable-profile') {
    url.searchParams.set('profileId', arg.resolvedProfile.profileId)
  } else {
    url.searchParams.set('staticModel', arg.staticModel?.trim() || arg.resolvedProfile?.modelId || 'ollama-cloud')
  }
  if (arg.chatId) {
    url.searchParams.set('chatId', arg.chatId)
    const currentChat = requestCurrentChat(arg)
    const toggles = currentChat?.id === arg.chatId ? currentChat.generationSettings?.sidebarToggles : undefined
    if (toggles) {
      const encodedToggles = JSON.stringify(toggles)
      if (encodedToggles.length <= 4096) url.searchParams.set('toggles', encodedToggles)
    }
  }
  if (arg.currentChar?.chaId) url.searchParams.set('characterId', arg.currentChar.chaId)
  return url.toString()
}

function useServerOwnedOllamaProfile(arg: RequestDataArgumentExtended, endpoint: string, auth: string): void {
  arg.customURL = endpoint
  arg.key = ''
  arg.serverOwnedOllamaAuth = auth
  if (!arg.resolvedProfile) return
  arg.resolvedProfile = {
    ...arg.resolvedProfile,
    providerOptions: {
      ...arg.resolvedProfile.providerOptions,
      apiKey: '',
      baseUrl: undefined,
      endpoint,
      extraHeaders: undefined,
      ollama: arg.resolvedProfile.providerOptions.ollama
        ? {
            ...arg.resolvedProfile.providerOptions.ollama,
            apiKey: '',
          }
        : undefined,
    },
  }
}

function formatThinkingOutput(thinking: string, content: string): string {
  return thinking ? `<Thoughts>\n${thinking}\n</Thoughts>\n\n${content}` : content
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isOllamaRequestTarget(arg: RequestDataArgumentExtended): boolean {
  const modelId = arg.aiModel ?? ''
  return (
    modelId === 'ollama-cloud' ||
    modelId.includes('ollama') ||
    arg.resolvedProfile?.status.providerId === 'ollama' ||
    arg.resolvedProfile?.providerOptions.ollama !== undefined
  )
}

function createOllamaToolDefinitions(tools: MCPTool[] | undefined): OllamaToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: simplifySchema(tool.inputSchema),
    },
  }))
}

function parseOllamaToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringifyOllamaToolArguments(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function normalizeOllamaToolCalls(value: unknown): OllamaToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: OllamaToolCall[] = []
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.function)) continue
    const name = typeof item.function.name === 'string' ? item.function.name : ''
    if (!name) continue
    calls.push({
      function: {
        name,
        arguments: parseOllamaToolArguments(item.function.arguments),
      },
    })
  }
  return calls
}

function appendVisibleOllamaPart(prefix: string, ...parts: string[]): string {
  const visible = parts.map((part) => part.trim()).filter((part) => part.length > 0)
  if (visible.length === 0) return prefix
  return prefix ? [prefix, ...visible].join('\n\n') : visible.join('\n\n')
}

async function rememberedOllamaToolMessages(text: string): Promise<OllamaMessage[] | null> {
  const segments = text.split(/(<tool_call>.*?<\/tool_call>)/gms)
  if (segments.length === 1) return null

  const messages: OllamaMessage[] = []
  let currentContent = ''
  for (const segment of segments) {
    const match = segment.match(/<tool_call>(.*?)<\/tool_call>/s)
    if (!match) {
      currentContent += segment
      continue
    }

    const call = await decodeToolCall(match[1])
    if (!call) continue
    const args = parseOllamaToolArguments(call.call.arg)
    messages.push({
      role: 'assistant',
      content: currentContent,
      tool_calls: [
        {
          function: {
            name: call.call.name,
            arguments: args,
          },
        },
      ],
    })
    const textContents = call.response.flatMap((item) => (item.type === 'text' ? [item.text] : []))
    messages.push({
      role: 'tool',
      tool_name: call.call.name,
      content: textContents.join('\n'),
    })
    currentContent = ''
  }

  if (currentContent.trim().length > 0) {
    messages.push({ role: 'assistant', content: currentContent })
  }
  return messages.length > 0 ? messages : null
}

async function buildOllamaMessages(formated: Array<OpenAIChat | Record<string, unknown>>): Promise<OllamaMessage[]> {
  const messages: OllamaMessage[] = []
  const toolNamesById = new Map<string, string>()
  for (const raw of formated) {
    const row = raw as Record<string, unknown>
    const role = row.role
    const content = typeof row.content === 'string' ? row.content : ''
    if (role === 'assistant') {
      const remembered = await rememberedOllamaToolMessages(content)
      if (remembered) {
        messages.push(...remembered)
        continue
      }

      const toolCalls = normalizeOllamaToolCalls(row.tool_calls)
      for (const toolCall of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue
        if (typeof toolCall.id === 'string' && typeof toolCall.function.name === 'string') {
          toolNamesById.set(toolCall.id, toolCall.function.name)
        }
      }
      const message: OllamaMessage = { role, content }
      if (typeof row.thinking === 'string' && row.thinking.length > 0) message.thinking = row.thinking
      if (toolCalls.length > 0) message.tool_calls = toolCalls
      messages.push(message)
      continue
    }
    if (role === 'user' || role === 'system') {
      messages.push({ role, content })
      continue
    }
    if (role === 'tool') {
      const toolCallId = typeof row.tool_call_id === 'string' ? row.tool_call_id : ''
      const toolName =
        (typeof row.tool_name === 'string' && row.tool_name.length > 0 ? row.tool_name : undefined) ??
        (typeof row.name === 'string' && row.name.length > 0 ? row.name : undefined) ??
        toolNamesById.get(toolCallId)
      if (!toolName) continue
      messages.push({ role, tool_name: toolName, content })
    }
  }
  return messages
}

async function appendOllamaToolResults(
  messages: OllamaMessage[],
  calls: OllamaToolCall[],
  tools: MCPTool[] | undefined,
  rememberToolUsage: boolean | undefined,
): Promise<string[]> {
  const callCodes: string[] = []
  for (const call of calls) {
    const name = call.function.name
    const tool = tools?.find((item) => item.name === name)
    if (!tool) {
      messages.push({
        role: 'tool',
        tool_name: name,
        content: 'No tool found with name: ' + name,
      })
      continue
    }

    try {
      const response = (await callTool(tool.name, call.function.arguments)).filter((item) => item.type === 'text')
      if (response.length > 0) {
        messages.push({
          role: 'tool',
          tool_name: name,
          content: response[0].text,
        })
        if (rememberToolUsage) {
          callCodes.push(
            await encodeToolCall({
              call: {
                id: '',
                name,
                arg: stringifyOllamaToolArguments(call.function.arguments),
              },
              response,
            }),
          )
        }
      } else {
        messages.push({
          role: 'tool',
          tool_name: name,
          content: 'Tool call failed with no text response',
        })
      }
    } catch (error) {
      messages.push({
        role: 'tool',
        tool_name: name,
        content: 'Tool call failed with error: ' + error,
      })
    }
  }
  return callCodes
}

function appendOperationPath(baseUrl: string, suffix: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!trimmed || trimmed.endsWith(suffix)) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    const pathSegments = url.pathname.split('/').filter(Boolean)
    const suffixSegments = suffix.split('/').filter(Boolean)
    const hasSuffix =
      pathSegments.length >= suffixSegments.length &&
      suffixSegments.every(
        (segment, index) => pathSegments[pathSegments.length - suffixSegments.length + index] === segment,
      )

    if (hasSuffix) {
      return url.toString()
    }

    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffixSegments.join('/')}`
    return url.toString()
  } catch {
    return `${trimmed}${suffix}`
  }
}

function normalizeOobaLegacyUrl(baseUrl: string, suffix: '/api/v1/generate' | '/api/v1/stream'): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    const apiIndex = url.pathname.indexOf('/api')
    const basePath = apiIndex >= 0 ? url.pathname.slice(0, apiIndex) : url.pathname.replace(/\/+$/, '')
    url.pathname = `${basePath}${suffix}`
    return url.toString()
  } catch {
    return trimmed.includes('/api') ? trimmed.replace(/\/api.*/, suffix) : `${trimmed}${suffix}`
  }
}

function toWebSocketUrl(url: string): string {
  if (url.startsWith('https://')) {
    return `wss://${url.slice('https://'.length)}`
  }
  if (url.startsWith('http://')) {
    return `ws://${url.slice('http://'.length)}`
  }
  return url
}

function createOllamaCloudFetch(endpoint: string, auth: string) {
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')) as
      | 'POST'
      | 'GET'
      | 'PUT'
      | 'DELETE'
    const body = init.body ?? (input instanceof Request ? await input.arrayBuffer() : undefined)
    if (method !== 'POST' || body === undefined) {
      throw new Error(language.errors.ollamaCloudToolPostRequired)
    }

    const response = await fetchNative(endpoint, {
      body: body as string | Uint8Array | ArrayBuffer | undefined,
      headers: {
        'content-type': 'application/json',
        'risu-auth': auth,
      },
      method: 'POST',
      signal: init.signal as AbortSignal,
      interceptor: 'ollama_sdk',
      sensitive: true,
    })

    return normalizeOllamaStreamResponse(response)
  }
}

function normalizeOllamaStreamResponse(response: Response): Response {
  if (!response.body) {
    return response
  }

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let depth = 0
  let inString = false
  let escaped = false

  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let out = ''
        const text = decoder.decode(chunk, { stream: true })

        for (const char of text) {
          out += char

          if (escaped) {
            escaped = false
            continue
          }
          if (char === '\\' && inString) {
            escaped = true
            continue
          }
          if (char === '"') {
            inString = !inString
            continue
          }
          if (inString) {
            continue
          }
          if (char === '{') {
            depth++
            continue
          }
          if (char === '}') {
            depth = Math.max(0, depth - 1)
            if (depth === 0) {
              out += '\n'
            }
          }
        }

        if (out) {
          controller.enqueue(encoder.encode(out))
        }
      },
    }),
  )

  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export async function requestChatData(
  arg: requestDataArgument,
  model: ModelModeExtended,
  abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration) && !abortSignal?.aborted
  if (abortSignal?.aborted) return { type: 'fail', result: 'Aborted' }
  if (!isCurrent()) return { type: 'fail', result: 'client_write_access_required', noRetry: true }
  const controller = isClientSessionManaged() ? new AbortController() : undefined
  if (controller) abortSignal = abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal
  const stopWatching = controller
    ? clientSessionStore.subscribe(() => {
        if (!isClientWriteOperationCurrent(sourceGeneration)) controller.abort()
      })
    : () => {}
  try {
    const db = requestSettingsOwner(arg.database)
    if (!db) {
      return {
        type: 'fail',
        result: 'Request settings are not ready.',
      }
    }
    const resolvedProfile = resolveModelProfile({ database: db, role: model })
    const overrideProfile = arg.profileIdOverride
      ? resolveModelProfileByProfileId({ database: db, role: model, profileId: arg.profileIdOverride })
      : null
    if (arg.profileIdOverride && arg.strictProfileIdOverride && !overrideProfile) {
      return {
        type: 'fail',
        result: `Model profile not found or unavailable: ${arg.profileIdOverride}`,
      }
    }
    const fallbackAttempts: RequestFallbackAttempt[] = overrideProfile
      ? [{ staticModel: '', fallbackProfileId: arg.profileIdOverride, modelId: overrideProfile.modelId }]
      : [...resolveRequestFallbackAttempts(db, model, resolvedProfile.fallbacks), { staticModel: '' }]
    let da: requestDataResponse

    if (arg.escape) {
      arg.useStreaming = false
      console.warn('Escape is enabled, disabling streaming')
    }

    const originalFormated = safeStructuredClone(arg.formated).map((m) => {
      m.content = risuUnescape(m.content)
      return m
    })

    for (let fallbackIndex = 0; fallbackIndex < fallbackAttempts.length; fallbackIndex++) {
      const attempt = fallbackAttempts[fallbackIndex]
      let trys = 0
      arg.formated = safeStructuredClone(originalFormated)

      if (fallbackIndex !== fallbackAttempts.length - 1 && !attempt.staticModel && !attempt.fallbackProfileId) {
        continue
      }

      while (true) {
        if (!isCurrent()) {
          return {
            type: 'fail',
            result: 'Aborted',
          }
        }

        if (isPluginRuntimeReady() && pluginV2.replacerbeforeRequest.size > 0) {
          for (const replacer of pluginV2.replacerbeforeRequest) {
            arg.formated = await replacer(arg.formated, model)
            if (!isCurrent()) return { type: 'fail', result: 'Aborted' }
          }
        }

        try {
          const currentChar = arg.currentChar
          if (currentChar) {
            const perf = performance.now()
            const d = await runTrigger(currentChar, 'request', {
              chat: requestCurrentChat(arg),
              displayMode: true,
              displayData: JSON.stringify(arg.formated),
            })

            if (!isCurrent()) return { type: 'fail', result: 'Aborted' }
            const got = JSON.parse(d.displayData)
            if (!got || !Array.isArray(got)) {
              throw new Error('Invalid return')
            }
            arg.formated = got
            console.log('Trigger time', performance.now() - perf)
          }
        } catch (e) {
          console.error(e)
        }

        if (!isCurrent()) return { type: 'fail', result: 'Aborted' }
        da = await requestChatDataMain(
          {
            ...arg,
            database: db,
            staticModel: attempt.staticModel,
            fallbackProfileId: attempt.fallbackProfileId,
          },
          model,
          abortSignal,
          sourceGeneration,
        )

        if (!isCurrent()) {
          return {
            type: 'fail',
            result: 'Aborted',
          }
        }

        if (da.type === 'success' && arg.escape) {
          da.result = risuEscape(da.result)
        }

        if (da.type === 'success' && isPluginRuntimeReady() && pluginV2.replacerafterRequest.size > 0) {
          for (const replacer of pluginV2.replacerafterRequest) {
            da.result = await replacer(da.result, model)
            if (!isCurrent()) return { type: 'fail', result: 'Aborted' }
          }
        }

        if (da.type === 'success' && db.banCharacterset?.length > 0) {
          const responseText = da.result
          const responseModel = da.model
          const bannedCharacterSet = db.banCharacterset.find((set) => {
            const checkRegex = new RegExp(`\\p{Script=${set}}`, 'gu')
            return checkRegex.test(responseText)
          })

          if (bannedCharacterSet !== undefined) {
            da = {
              type: 'fail',
              result: language.errors.bannedCharacterSet(bannedCharacterSet),
              ...(responseModel === undefined ? {} : { model: responseModel }),
            }
          }
        }

        if (da.type === 'success' && fallbackIndex !== fallbackAttempts.length - 1 && db.fallbackWhenBlankResponse) {
          if (da.result.trim() === '' && !da.toolCalls?.length) {
            break
          }
        }

        if (da.type !== 'fail' || da.noRetry) {
          const usedModel = attempt.modelId || attempt.staticModel || da.model
          return usedModel
            ? {
                ...da,
                model: usedModel,
              }
            : da
        }

        if (da.failByServerError) {
          await sleep(1000)
          if (!isCurrent()) return { type: 'fail', result: 'Aborted' }
          if (db.antiServerOverloads) {
            trys -= 0.5 // reduce trys by 0.5, so that it will retry twice as much
          }
        }

        trys += 1
        if (trys > db.requestRetrys) {
          const isPluginModel = da.model === 'custom' || da.model?.startsWith('pluginmodel:::')
          if (fallbackIndex === fallbackAttempts.length - 1 || isPluginModel) {
            return da
          }
          break
        }
      }
    }

    return (
      da ?? {
        type: 'fail',
        result: 'All models failed',
      }
    )
  } finally {
    stopWatching()
  }
}

function resolveRequestFallbackAttempts(
  database: Database,
  model: ModelModeExtended,
  fallbacks: ModelProfileFallbackRef[],
): RequestFallbackAttempt[] {
  return fallbacks.flatMap((fallback) => {
    if (fallback.kind === 'legacy-model-id') {
      return [{ staticModel: fallback.modelId, modelId: fallback.modelId }]
    }
    const profile = resolveModelProfileByProfileId({
      database,
      role: model,
      profileId: fallback.profileId,
    })
    if (!profile) return []
    return [{ staticModel: '', fallbackProfileId: fallback.profileId, modelId: profile.modelId }]
  })
}

export function reformater(formated: OpenAIChat[], modelInfo: LLMModel | LLMFlags[], db: Database) {
  const flags = Array.isArray(modelInfo) ? modelInfo : modelInfo.flags
  let systemPrompt: OpenAIChat | null = null

  if (!flags.includes(LLMFlags.hasFullSystemPrompt)) {
    if (flags.includes(LLMFlags.hasFirstSystemPrompt)) {
      while (formated[0].role === 'system') {
        if (systemPrompt) {
          systemPrompt.content += '\n\n' + formated[0].content
        } else {
          systemPrompt = formated[0]
        }
        formated = formated.slice(1)
      }
    }

    for (let i = 0; i < formated.length; i++) {
      if (formated[i].role === 'system') {
        formated[i].content = db.systemContentReplacement
          ? db.systemContentReplacement.replace('{{slot}}', formated[i].content)
          : `system: ${formated[i].content}`
        formated[i].role = db.systemRoleReplacement || 'user'
      }
    }
  }

  if (flags.includes(LLMFlags.requiresAlternateRole)) {
    let newFormated: OpenAIChat[] = []
    for (let i = 0; i < formated.length; i++) {
      const m = formated[i]
      if (newFormated.length === 0) {
        newFormated.push(m)
        continue
      }

      if (newFormated[newFormated.length - 1].role === m.role) {
        newFormated[newFormated.length - 1].content += '\n' + m.content

        if (m.multimodals) {
          if (!newFormated[newFormated.length - 1].multimodals) {
            newFormated[newFormated.length - 1].multimodals = []
          }
          newFormated[newFormated.length - 1].multimodals.push(...m.multimodals)
        }

        if (m.thoughts) {
          if (!newFormated[newFormated.length - 1].thoughts) {
            newFormated[newFormated.length - 1].thoughts = []
          }
          newFormated[newFormated.length - 1].thoughts.push(...m.thoughts)
        }

        if (m.cachePoint) {
          if (!newFormated[newFormated.length - 1].cachePoint) {
            newFormated[newFormated.length - 1].cachePoint = true
          }
        }

        continue
      } else {
        newFormated.push(m)
      }
    }
    formated = newFormated
  }

  if (flags.includes(LLMFlags.mustStartWithUserInput)) {
    if (formated.length === 0 || formated[0].role !== 'user') {
      formated.unshift({
        role: 'user',
        content: ' ',
      })
    }
  }

  if (systemPrompt) {
    formated.unshift(systemPrompt)
  }

  return formated
}

export async function requestChatDataMain(
  arg: requestDataArgument,
  model: ModelModeExtended,
  abortSignal: AbortSignal = null,
  sourceGeneration = captureClientSessionGeneration(),
): Promise<requestDataResponse> {
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration) && !abortSignal?.aborted
  if (abortSignal?.aborted) return { type: 'fail', result: 'Aborted' }
  if (!isCurrent()) return { type: 'fail', result: 'client_write_access_required', noRetry: true }
  const db = requestSettingsOwner(arg.database)
  if (!db) {
    return {
      type: 'fail',
      result: 'Request settings are not ready.',
    }
  }
  const targ: RequestDataArgumentExtended = { ...arg, database: db }
  const resolvedProfile = arg.fallbackProfileId
    ? resolveModelProfileByProfileId({
        database: db,
        role: model,
        profileId: arg.fallbackProfileId,
      })
    : resolveModelProfile({ database: db, role: model, staticModel: arg.staticModel })
  if (!resolvedProfile) {
    return {
      type: 'fail',
      result: `Fallback profile not found: ${arg.fallbackProfileId}`,
    }
  }
  const profileBlockReason = modelProfileGenerationBlockReason(resolvedProfile)
  if (profileBlockReason) {
    return {
      type: 'fail',
      result: profileBlockReason,
    }
  }
  const runtimeOptions = resolvedProfile.runtimeOptions
  const providerOptions = resolvedProfile.providerOptions
  const halfStreaming = runtimeOptions.halfStreaming ?? db.halfStreaming

  targ.aiModel = resolvedProfile.modelId
  targ.modelInfo = resolvedProfile.modelInfo
  targ.resolvedProfile = resolvedProfile

  if (arg.blockPlugins && targ.modelInfo.id.startsWith('pluginmodel:::')) {
    return {
      type: 'fail',
      result: 'Plugin calls are blocked by the caller.',
    }
  }

  targ.formated = safeStructuredClone(arg.formated)
  targ.maxTokens = arg.maxTokens ?? runtimeOptions.maxResponse ?? db.maxResponse
  targ.temperature = arg.temperature ?? runtimeOptions.temperature ?? db.temperature / 100
  targ.bias = arg.bias
  targ.currentChar = arg.currentChar
  targ.useStreaming = arg.forceStreaming
    ? true
    : ((runtimeOptions.useStreaming ?? db.useStreaming) || halfStreaming) && arg.useStreaming
  targ.continue = arg.continue ?? false
  targ.biasString = arg.biasString ?? []
  targ.multiGen =
    (runtimeOptions.genTime ?? db.genTime) > 1 && targ.aiModel.startsWith('gpt') && !arg.continue && !arg.noMultiGen
  targ.abortSignal = abortSignal
  targ.mode = model
  targ.extractJson = arg.extractJson ?? runtimeOptions.extractJson ?? db.extractJson
  if (targ.aiModel === 'reverse_proxy') {
    targ.modelInfo.internalID = providerOptions.requestModel
    targ.customURL = db.forceReplaceUrl
    targ.key = providerOptions.apiKey ?? db.proxyKey
  }
  if (targ.aiModel.startsWith('xcustom:::')) {
    const found = db.customModels.find((m) => m.id === targ.aiModel)
    targ.customURL = providerOptions.customModel?.url ?? found?.url
    targ.key = providerOptions.apiKey ?? found?.key
  }

  const shouldProbeOllamaTools = isOllamaRequestTarget(targ) && !arg.previewBody
  let forceLocalOllamaToolDispatch = false
  if (shouldProbeOllamaTools) {
    targ.tools = arg.tools ?? (await getTools())
    if (!isCurrent()) return { type: 'fail', result: 'Aborted' }
    forceLocalOllamaToolDispatch = targ.tools.length > 0
  }

  const serverRoute = forceLocalOllamaToolDispatch ? ({ type: 'local' } as const) : resolveServerCompletionRoute(targ)
  if (serverRoute.type === 'server') {
    return withHalfStreamingMode(requestServerCompletion(targ, abortSignal), halfStreaming)
  }
  if (serverRoute.type === 'unsupported') {
    return {
      type: 'fail',
      result: serverRoute.reason,
      noRetry: true,
    }
  }

  targ.tools = targ.tools ?? (await getTools())
  if (!isCurrent()) return { type: 'fail', result: 'Aborted' }

  const format = targ.modelInfo.format

  targ.formated = reformater(targ.formated, targ.modelInfo, db)

  if (forceLocalOllamaToolDispatch) {
    return withHalfStreamingMode(requestOllama(targ), halfStreaming)
  }

  switch (format) {
    case LLMFormat.OpenAICompatible:
    case LLMFormat.Mistral:
    case LLMFormat.NanoGPT:
      return withHalfStreamingMode(requestOpenAI(targ), halfStreaming)
    case LLMFormat.NanoGPTResponses:
      return withHalfStreamingMode(requestOpenAIResponseAPI(targ), halfStreaming)
    case LLMFormat.NanoGPTMessages:
      return withHalfStreamingMode(requestClaude(targ), halfStreaming)
    case LLMFormat.NanoGPTLegacy:
      return withHalfStreamingMode(requestOpenAILegacyInstruct(targ), halfStreaming)
    case LLMFormat.OpenAILegacyInstruct:
      return withHalfStreamingMode(requestOpenAILegacyInstruct(targ), halfStreaming)
    case LLMFormat.NovelAI:
      return withHalfStreamingMode(requestNovelAI(targ), halfStreaming)
    case LLMFormat.OobaLegacy:
      return withHalfStreamingMode(requestOobaLegacy(targ), halfStreaming)
    case LLMFormat.Plugin:
      return withHalfStreamingMode(requestPlugin(targ), halfStreaming)
    case LLMFormat.Ooba:
      return withHalfStreamingMode(requestOoba(targ), halfStreaming)
    case LLMFormat.VertexAIGemini:
    case LLMFormat.GoogleCloud:
      return withHalfStreamingMode(requestGoogleCloudVertex(targ), halfStreaming)
    case LLMFormat.Kobold:
      return withHalfStreamingMode(requestKobold(targ), halfStreaming)
    case LLMFormat.NovelList:
      return withHalfStreamingMode(requestNovelList(targ), halfStreaming)
    case LLMFormat.Ollama:
      return withHalfStreamingMode(requestOllama(targ), halfStreaming)
    case LLMFormat.Cohere:
      return withHalfStreamingMode(requestCohere(targ), halfStreaming)
    case LLMFormat.Anthropic:
    case LLMFormat.AnthropicLegacy:
    case LLMFormat.AWSBedrockClaude:
      return withHalfStreamingMode(requestClaude(targ), halfStreaming)
    case LLMFormat.Horde:
      return withHalfStreamingMode(requestHorde(targ), halfStreaming)
    case LLMFormat.WebLLM:
      return withHalfStreamingMode(requestWebLLM(targ), halfStreaming)
    case LLMFormat.OpenAIResponseAPI:
      return withHalfStreamingMode(requestOpenAIResponseAPI(targ), halfStreaming)
    case LLMFormat.Echo:
      return withHalfStreamingMode(requestEcho(targ), halfStreaming)
  }

  return {
    type: 'fail',
    result: language.errors.unknownModel,
  }
}

async function requestNovelAI(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const aiModel = arg.aiModel
  const temperature = arg.temperature
  const maxTokens = arg.maxTokens
  const biasString = arg.biasString
  const currentChar = arg.currentChar
  const prompt = stringlizeNAIChat(formated, currentChar?.name ?? '', arg.continue)
  const abortSignal = arg.abortSignal
  let logit_bias_exp: {
    sequence: number[]
    bias: number
    ensure_sequence_finish: false
    generate_once: true
  }[] = []

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        error: 'This model is not supported in preview mode',
      }),
    }
  }

  for (let i = 0; i < biasString.length; i++) {
    const bia = biasString[i]
    const tokens = await tokenizeNum(bia[0], db)

    const tokensInNumberArray: number[] = []

    for (const token of tokens) {
      tokensInNumberArray.push(token)
    }
    logit_bias_exp.push({
      sequence: tokensInNumberArray,
      bias: bia[1],
      ensure_sequence_finish: false,
      generate_once: true,
    })
  }

  let prefix = 'vanilla'

  if (db.NAIadventure) {
    prefix = 'theme_textadventure'
  }

  const gen = db.NAIsettings
  const payload = {
    temperature: temperature,
    max_length: maxTokens,
    min_length: 1,
    top_k: gen.topK,
    top_p: gen.topP,
    top_a: gen.topA,
    tail_free_sampling: gen.tailFreeSampling,
    repetition_penalty: gen.repetitionPenalty,
    repetition_penalty_range: gen.repetitionPenaltyRange,
    repetition_penalty_slope: gen.repetitionPenaltySlope,
    repetition_penalty_frequency: gen.frequencyPenalty,
    repetition_penalty_presence: gen.presencePenalty,
    generate_until_sentence: true,
    use_cache: false,
    use_string: true,
    return_full_text: false,
    prefix: prefix,
    order: [6, 2, 3, 0, 4, 1, 5, 8],
    typical_p: gen.typicalp,
    repetition_penalty_whitelist: [
      49256, 49264, 49231, 49230, 49287, 85, 49255, 49399, 49262, 336, 333, 432, 363, 468, 492, 745, 401, 426, 623, 794,
      1096, 2919, 2072, 7379, 1259, 2110, 620, 526, 487, 16562, 603, 805, 761, 2681, 942, 8917, 653, 3513, 506, 5301,
      562, 5010, 614, 10942, 539, 2976, 462, 5189, 567, 2032, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 588,
      803, 1040, 49209, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ],
    stop_sequences: [[49287], [49405]],
    bad_words_ids: NovelAIBadWordIds,
    logit_bias_exp: logit_bias_exp,
    mirostat_lr: gen.mirostat_lr ?? 1,
    mirostat_tau: gen.mirostat_tau ?? 0,
    cfg_scale: gen.cfg_scale ?? 1,
    cfg_uc: '',
  }

  let body: Record<string, any> = {
    input: prompt,
    model: aiModel === 'novelai_kayra' ? 'kayra-v1' : 'clio-v1',
    parameters: payload,
  }
  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + (arg.key ?? db.novelai.token),
  }
  body = applyAdditionalParameters(body, headers, additionalParamsForRequest(arg))

  const da = await globalFetch(
    aiModel === 'novelai_kayra' ? 'https://text.novelai.net/ai/generate' : 'https://api.novelai.net/ai/generate',
    {
      body: body,
      headers,
      abortSignal,
      chatId: arg.chatId,
    },
  )

  if (!da.ok || !da.data.output) {
    return {
      type: 'fail',
      result: language.errors.httpError + `${JSON.stringify(da.data)}`,
    }
  }
  return {
    type: 'success',
    result: unstringlizeChat(da.data.output, formated, currentChar?.name ?? ''),
  }
}

async function requestOobaLegacy(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const aiModel = arg.aiModel
  const maxTokens = arg.maxTokens
  const providerOptions = arg.resolvedProfile?.providerOptions
  const runtimeOptions = arg.resolvedProfile?.runtimeOptions
  const hasResolvedProfile = arg.resolvedProfile !== undefined
  const currentChar = arg.currentChar
  const useStreaming = arg.useStreaming
  const abortSignal = arg.abortSignal
  const profileBaseUrl = providerOptions?.baseUrl?.trim() ?? ''

  if (hasResolvedProfile && !profileBaseUrl) {
    return {
      type: 'fail',
      result: 'options["ooba-legacy"].baseUrl is required',
      noRetry: true,
    }
  }

  let streamUrl = hasResolvedProfile
    ? toWebSocketUrl(normalizeOobaLegacyUrl(profileBaseUrl, '/api/v1/stream'))
    : db.textgenWebUIStreamURL.replace(/\/api.*/, '/api/v1/stream')
  let blockingUrl = hasResolvedProfile
    ? normalizeOobaLegacyUrl(profileBaseUrl, '/api/v1/generate')
    : db.textgenWebUIBlockingURL.replace(/\/api.*/, '/api/v1/generate')
  let bodyTemplate: { [key: string]: any } = {}
  const prompt = applyChatTemplate(formated)
  let stopStrings = getStopStrings(false)
  if (db.localStopStrings) {
    stopStrings = db.localStopStrings.map((v) => {
      return risuChatParser(v.replace(/\\n/g, '\n'))
    })
  }

  bodyTemplate = {
    max_new_tokens: hasResolvedProfile ? (runtimeOptions?.maxResponse ?? db.maxResponse) : db.maxResponse,
    do_sample: db.ooba.do_sample,
    temperature: hasResolvedProfile
      ? (arg.temperature ?? runtimeOptions?.temperature ?? db.temperature / 100)
      : db.temperature / 100,
    top_p: db.ooba.top_p,
    typical_p: db.ooba.typical_p,
    repetition_penalty: db.ooba.repetition_penalty,
    encoder_repetition_penalty: db.ooba.encoder_repetition_penalty,
    top_k: db.ooba.top_k,
    min_length: db.ooba.min_length,
    no_repeat_ngram_size: db.ooba.no_repeat_ngram_size,
    num_beams: db.ooba.num_beams,
    penalty_alpha: db.ooba.penalty_alpha,
    length_penalty: db.ooba.length_penalty,
    early_stopping: false,
    truncation_length: hasResolvedProfile ? (runtimeOptions?.maxContext ?? maxTokens) : maxTokens,
    ban_eos_token: db.ooba.ban_eos_token,
    stopping_strings: stopStrings,
    seed: -1,
    add_bos_token: db.ooba.add_bos_token,
    topP: db.top_p,
    prompt: prompt,
  }

  const profileApiKey = providerOptions?.apiKey?.trim()
  const headers: Record<string, string> = hasResolvedProfile
    ? profileApiKey
      ? {
          'X-API-KEY': profileApiKey,
        }
      : {}
    : aiModel === 'textgen_webui'
      ? {}
      : {
          'X-API-KEY': db.mancerHeader,
        }

  if (hasResolvedProfile) Object.assign(headers, providerOptions?.extraHeaders ?? {})
  bodyTemplate = applyAdditionalParameters(bodyTemplate, headers, additionalParamsForRequest(arg))

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        url: blockingUrl,
        body: bodyTemplate,
        headers: headers,
      }),
    }
  }

  if (useStreaming) {
    const fallbackConnectionError = `WebSocket connection to '${streamUrl}' failed.`
    const normalizeSocketError = (reason: unknown, fallback = fallbackConnectionError): Error => {
      if (reason instanceof Error) return reason
      if (typeof reason === 'string' && reason) return new Error(reason)
      return new Error(fallback)
    }

    if (abortSignal?.aborted) {
      return {
        type: 'fail',
        result: normalizeSocketError(abortSignal.reason, 'Request aborted.').message,
      }
    }

    const oobaboogaSocket = new WebSocket(streamUrl)
    let connectionOpened = false
    let settled = false
    let terminalError: Error | undefined
    let streamController: ReadableStreamDefaultController<StreamResponseChunk> | undefined
    let readed = ''
    let resolveConnection!: (opened: boolean) => void
    const connection = new Promise<boolean>((resolve) => {
      resolveConnection = resolve
    })

    const cleanup = () => {
      oobaboogaSocket.removeEventListener('open', onOpen)
      oobaboogaSocket.removeEventListener('message', onMessage)
      oobaboogaSocket.removeEventListener('error', onError)
      oobaboogaSocket.removeEventListener('close', onClose)
      abortSignal?.removeEventListener('abort', onAbort)
    }

    const closeSocket = () => {
      if (oobaboogaSocket.readyState === WebSocket.CONNECTING || oobaboogaSocket.readyState === WebSocket.OPEN) {
        oobaboogaSocket.close()
      }
    }

    const settle = (outcome: 'close' | 'error' | 'cancel', reason?: unknown) => {
      if (settled) return
      settled = true
      terminalError = outcome === 'error' ? normalizeSocketError(reason) : undefined
      cleanup()
      closeSocket()

      if (!connectionOpened) {
        resolveConnection(false)
        return
      }
      if (!streamController) return

      if (outcome === 'close') {
        streamController.close()
      } else if (outcome === 'error') {
        streamController.error(terminalError)
      }
    }

    const onOpen = () => {
      if (settled) return
      connectionOpened = true
      oobaboogaSocket.removeEventListener('open', onOpen)
      resolveConnection(true)
    }
    const onError = () => {
      settle('error', fallbackConnectionError)
    }
    const onClose = (event: CloseEvent) => {
      settle(
        'error',
        `WebSocket connection to '${streamUrl}' closed unexpectedly${event.code ? ` (code ${event.code})` : ''}.`,
      )
    }
    const onAbort = () => {
      settle('error', normalizeSocketError(abortSignal?.reason, 'Request aborted.'))
    }
    const onMessage = (event: MessageEvent) => {
      try {
        if (typeof event.data !== 'string') {
          throw new Error('Oobabooga WebSocket returned a non-text frame.')
        }
        const json = JSON.parse(event.data) as { event?: unknown; text?: unknown }
        if (json.event === 'stream_end') {
          settle('close')
          return
        }
        if (json.event !== 'text_stream') return
        if (typeof json.text !== 'string') {
          throw new Error('Oobabooga text_stream frame is missing text.')
        }
        readed += json.text
        streamController?.enqueue(readed as unknown as StreamResponseChunk)
      } catch (error) {
        settle('error', error)
      }
    }

    oobaboogaSocket.addEventListener('open', onOpen)
    oobaboogaSocket.addEventListener('error', onError)
    oobaboogaSocket.addEventListener('close', onClose)
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (abortSignal?.aborted) onAbort()

    const opened = await connection
    if (!opened || settled) {
      return {
        type: 'fail',
        result: terminalError?.message ?? fallbackConnectionError,
      }
    }

    const stream = new ReadableStream<StreamResponseChunk>({
      start(controller) {
        streamController = controller
        if (settled) {
          controller.error(terminalError ?? new Error(fallbackConnectionError))
          return
        }
        oobaboogaSocket.addEventListener('message', onMessage)
        try {
          oobaboogaSocket.send(JSON.stringify(bodyTemplate))
        } catch (error) {
          settle('error', error)
        }
      },
      cancel() {
        settle('cancel')
      },
    })

    return {
      type: 'streaming',
      result: stream,
    }
  }

  const res = await globalFetch(blockingUrl, {
    body: bodyTemplate,
    headers: headers,
    abortSignal,
    chatId: arg.chatId,
  })

  const dat = res.data as any
  if (res.ok) {
    try {
      let result: string = dat.results[0].text ?? ''

      return {
        type: 'success',
        result: unstringlizeChat(result, formated, currentChar?.name ?? ''),
      }
    } catch (error) {
      return {
        type: 'fail',
        result: language.errors.httpError + `${error}`,
      }
    }
  } else {
    return {
      type: 'fail',
      result: language.errors.httpError + `${JSON.stringify(res.data)}`,
    }
  }
}

async function requestOoba(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const aiModel = arg.aiModel
  const maxTokens = arg.maxTokens
  const temperature = arg.temperature
  const prompt = applyChatTemplate(formated)
  let stopStrings = getStopStrings(false)
  if (db.localStopStrings) {
    stopStrings = db.localStopStrings.map((v) => {
      return risuChatParser(v.replace(/\\n/g, '\n'))
    })
  }
  let bodyTemplate: Record<string, any> = {
    prompt: prompt,
    presence_penalty: arg.PresensePenalty || db.PresensePenalty / 100,
    frequency_penalty: arg.frequencyPenalty || db.frequencyPenalty / 100,
    logit_bias: {},
    max_tokens: maxTokens,
    stop: stopStrings,
    temperature: temperature,
    top_p: db.top_p,
  }

  const url = new URL(db.textgenWebUIBlockingURL)
  url.pathname = '/v1/completions'
  const urlStr = url.toString()

  const OobaBodyTemplate = db.reverseProxyOobaArgs
  const keys = Object.keys(OobaBodyTemplate)
  for (const key of keys) {
    if (OobaBodyTemplate[key] !== undefined && OobaBodyTemplate[key] !== null && OobaParams.includes(key)) {
      bodyTemplate[key] = OobaBodyTemplate[key]
    } else if (bodyTemplate[key]) {
      delete bodyTemplate[key]
    }
  }

  const headers: Record<string, string> = {}
  bodyTemplate = applyAdditionalParameters(bodyTemplate, headers, additionalParamsForRequest(arg))

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        url: urlStr,
        body: bodyTemplate,
        headers,
      }),
    }
  }

  const response = await globalFetch(urlStr, {
    body: bodyTemplate,
    headers,
    chatId: arg.chatId,
    abortSignal: arg.abortSignal,
  })

  if (!response.ok) {
    return {
      type: 'fail',
      result: language.errors.httpError + `${JSON.stringify(response.data)}`,
    }
  }
  const text: string = response.data.choices[0].text ?? ''
  return {
    type: 'success',
    result: text.replace(/##\n/g, ''),
  }
}

async function requestPlugin(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const db = arg.database
  const isV3Model = arg.aiModel.startsWith('pluginmodel:::')
  const responseModel = isV3Model ? arg.aiModel : 'custom'
  try {
    const formated = arg.formated
    const maxTokens = arg.maxTokens
    const bias = arg.biasString
    const model = isV3Model ? arg.aiModel.replace('pluginmodel:::', '') : db.currentPluginProvider
    const v2Function = isPluginRuntimeReady() ? pluginV2.providers.get(model) : undefined

    if (arg.previewBody) {
      return {
        type: 'success',
        result: JSON.stringify({
          error: 'Plugin is not supported in preview mode',
        }),
      }
    }

    const d = v2Function
      ? await v2Function(
          applyParameters(
            {
              prompt_chat: formated,
              mode: arg.mode,
              bias: [],
              max_tokens: maxTokens,
            },
            ['frequency_penalty', 'min_p', 'presence_penalty', 'repetition_penalty', 'top_k', 'top_p', 'temperature'],
            {},
            arg.mode,
            {
              database: db,
              modelId: arg.aiModel,
              runtimeOptions: arg.resolvedProfile?.runtimeOptions,
            },
          ) as any,
          arg.abortSignal,
        )
      : await pluginProcess({
          bias: bias,
          prompt_chat: formated,
          temperature: arg.resolvedProfile ? arg.resolvedProfile.runtimeOptions.temperature! : db.temperature / 100,
          max_tokens: maxTokens,
          presence_penalty: arg.resolvedProfile
            ? arg.resolvedProfile.runtimeOptions.presencePenalty!
            : db.PresensePenalty / 100,
          frequency_penalty: arg.resolvedProfile
            ? arg.resolvedProfile.runtimeOptions.frequencyPenalty!
            : db.frequencyPenalty / 100,
        })

    if (!d) {
      return {
        type: 'fail',
        result: language.errors.unknownModel,
        model: responseModel,
      }
    } else if (!d.success) {
      return {
        type: 'fail',
        result: d.content instanceof ReadableStream ? await new Response(d.content).text() : d.content,
        model: responseModel,
      }
    } else if (d.content instanceof ReadableStream) {
      let fullText = ''
      const piper = new TransformStream<string, StreamResponseChunk>({
        transform(chunk, control) {
          fullText += chunk
          control.enqueue({
            '0': fullText,
          })
        },
      })

      return {
        type: 'streaming',
        result: d.content.pipeThrough(piper),
        model: responseModel,
      }
    } else {
      return {
        type: 'success',
        result: d.content ?? '',
        model: responseModel,
      }
    }
  } catch (error) {
    console.error(error)
    return {
      type: 'fail',
      result: `Plugin Error from ${db.currentPluginProvider}: ` + JSON.stringify(error),
      model: responseModel,
    }
  }
}

async function requestEcho(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const db = arg.database
  const body = applyAdditionalParameters(
    {
      delayMs: (db.echoDelay ?? 0) * 1000,
      message: db.echoMessage ?? 'Echo Message',
    },
    {},
    additionalParamsForRequest(arg),
  )
  const delayMs =
    typeof body.delayMs === 'number' && Number.isFinite(body.delayMs) && body.delayMs > 0 ? body.delayMs : 0
  const message = typeof body.message === 'string' ? body.message : (db.echoMessage ?? 'Echo Message')

  if (delayMs > 0) {
    await sleep(delayMs)
  }

  return {
    type: 'success',
    result: message,
  }
}

async function requestKobold(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const maxTokens = arg.maxTokens
  const abortSignal = arg.abortSignal
  const hasResolvedProfile = !!arg.resolvedProfile
  const profileBaseUrl = arg.resolvedProfile?.providerOptions.baseUrl?.trim()
  const baseUrl = hasResolvedProfile ? profileBaseUrl : db.koboldURL
  const maxContext = arg.resolvedProfile?.runtimeOptions.maxContext ?? db.maxContext

  if (hasResolvedProfile && !baseUrl) {
    return {
      type: 'fail',
      result: 'options.kobold.baseUrl is required',
      noRetry: true,
    }
  }

  const prompt = applyChatTemplate(formated)
  const url = new URL(baseUrl)
  if (url.pathname.length < 3) {
    url.pathname = 'api/v1/generate'
  }

  let body = applyParameters(
    {
      prompt: prompt,
      max_length: maxTokens,
      max_context_length: maxContext,
      n: 1,
    },
    ['temperature', 'top_p', 'repetition_penalty', 'top_k', 'top_a'],
    {
      repetition_penalty: 'rep_pen',
    },
    arg.mode,
    {
      database: db,
      modelId: arg.aiModel,
      runtimeOptions: arg.resolvedProfile?.runtimeOptions,
    },
  ) as KoboldGenerationInputSchema
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  body = applyAdditionalParameters(body, headers, additionalParamsForRequest(arg)) as KoboldGenerationInputSchema

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        url: url.toString(),
        body: body,
        headers,
      }),
    }
  }

  const da = await globalFetch(url.toString(), {
    method: 'POST',
    body: body,
    headers,
    abortSignal,
    chatId: arg.chatId,
  })

  if (!da.ok) {
    return {
      type: 'fail',
      result: typeof da.data === 'string' ? da.data : JSON.stringify(da.data),
      noRetry: true,
    }
  }

  const data = da.data
  return {
    type: 'success',
    result: data.results[0].text,
  }
}

async function requestNovelList(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const maxTokens = arg.maxTokens
  const temperature = arg.temperature
  const biasString = arg.biasString
  const currentChar = arg.currentChar
  const aiModel = arg.aiModel
  const auth_key = db.novellistAPI
  const api_server_url = 'https://api.tringpt.com/'
  const logit_bias: string[] = []
  const logit_bias_values: string[] = []
  for (let i = 0; i < biasString.length; i++) {
    const bia = biasString[i]
    logit_bias.push(bia[0])
    logit_bias_values.push(bia[1].toString())
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth_key}`,
    'Content-Type': 'application/json',
  }

  let send_body: Record<string, any> = {
    text: stringlizeAINChat(formated, currentChar?.name ?? '', arg.continue),
    length: maxTokens,
    temperature: temperature,
    top_p: db.ainconfig.top_p,
    top_k: db.ainconfig.top_k,
    rep_pen: db.ainconfig.rep_pen,
    top_a: db.ainconfig.top_a,
    rep_pen_slope: db.ainconfig.rep_pen_slope,
    rep_pen_range: db.ainconfig.rep_pen_range,
    typical_p: db.ainconfig.typical_p,
    badwords: db.ainconfig.badwords,
    model: aiModel === 'novellist_damsel' ? 'damsel' : 'supertrin',
    stoptokens: ['「'].join('<<|>>') + db.ainconfig.stoptokens,
    logit_bias: logit_bias.length > 0 ? logit_bias.join('<<|>>') : undefined,
    logit_bias_values: logit_bias_values.length > 0 ? logit_bias_values.join('|') : undefined,
  }
  send_body = applyAdditionalParameters(send_body, headers, additionalParamsForRequest(arg))

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        url: api_server_url + '/api',
        body: send_body,
        headers: headers,
      }),
    }
  }
  const response = await globalFetch(arg.customURL ?? api_server_url + '/api', {
    method: 'POST',
    headers: headers,
    body: send_body,
    chatId: arg.chatId,
    abortSignal: arg.abortSignal,
  })

  if (!response.ok) {
    return {
      type: 'fail',
      result: response.data,
    }
  }

  if (response.data.error) {
    return {
      type: 'fail',
      result: `${response.data.error.replace('token', 'api key')}`,
    }
  }

  const result = response.data.data[0]
  const unstr = unstringlizeAIN(result, formated, currentChar?.name ?? '')
  return {
    type: 'multiline',
    result: unstr,
  }
}

async function requestOllama(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const providerOptions = arg.resolvedProfile?.providerOptions
  const ollamaOptions = providerOptions?.ollama
  const hasResolvedProfile = arg.resolvedProfile !== undefined
  const isCloud = ollamaOptions?.cloud ?? arg.aiModel === 'ollama-cloud'
  const requestFormat = ollamaOptions?.requestFormat ?? (isCloud ? db.ollamaRequestFormat : LLMFormat.Ollama)
  const ollamaModel = hasResolvedProfile
    ? (ollamaOptions?.model ?? providerOptions?.requestModel ?? '')
    : isCloud
      ? db.ollamaCloudModel
      : db.ollamaModel
  const ollamaThinkMode = getOllamaThinkMode(ollamaOptions?.thinkingMode ?? db.ollamaThinkingMode)
  const localBaseUrl = hasResolvedProfile ? (ollamaOptions?.url ?? providerOptions?.baseUrl)?.trim() : db.ollamaURL
  const ollamaApiKey = hasResolvedProfile ? (ollamaOptions?.apiKey ?? providerOptions?.apiKey ?? '') : db.ollamaApiKey
  const ollamaModelSource = ollamaOptions?.modelSource ?? db.ollamaModelSource
  const cloudToolProtocol = isCloud && arg.tools?.length ? getOllamaCloudToolProtocol(requestFormat) : null
  if (isCloud && arg.tools?.length && !cloudToolProtocol) {
    return {
      type: 'fail',
      result: language.errors.ollamaCloudToolsUnsupported,
      noRetry: true,
    }
  }
  const cloudToolAuth = cloudToolProtocol ? await getNodeServerProxyAuth() : ''
  const cloudToolEndpoint = cloudToolProtocol ? ollamaCloudToolProxyUrl(arg, cloudToolProtocol) : ''
  if (cloudToolProtocol) {
    useServerOwnedOllamaProfile(arg, cloudToolEndpoint, cloudToolAuth)
  }

  if (isCloud && requestFormat === LLMFormat.OpenAICompatible) {
    if (!cloudToolProtocol) {
      arg.customURL = 'https://ollama.com/v1/chat/completions'
      arg.key = ollamaApiKey
    }
    arg.modelInfo.internalID = ollamaModel
    return requestOpenAI(arg)
  }

  if (isCloud && requestFormat === LLMFormat.OpenAIResponseAPI) {
    if (!cloudToolProtocol) {
      arg.customURL = 'https://ollama.com/v1/responses'
      arg.key = ollamaApiKey
    }
    arg.modelInfo.internalID = ollamaModel
    return requestOpenAIResponseAPI(arg)
  }

  if (isCloud && requestFormat === LLMFormat.Anthropic) {
    if (!cloudToolProtocol) {
      arg.customURL = 'https://ollama.com/v1/messages'
      arg.key = ollamaApiKey
    }
    arg.modelInfo = {
      ...arg.modelInfo,
      internalID: ollamaModel,
      parameters: ['temperature', 'top_k', 'top_p'],
    }
    return requestClaude(arg)
  }

  if (hasResolvedProfile && !isCloud && !localBaseUrl) {
    return {
      type: 'fail',
      result: 'options.ollama.baseUrl is required',
      noRetry: true,
    }
  }

  const messages = await buildOllamaMessages(formated)
  const tools = createOllamaToolDefinitions(arg.tools)
  const hasTools = tools.length > 0
  let requestBody: {
    model: string
    messages: OllamaMessage[]
    stream: boolean
    think?: OllamaThinkMode
    tools?: OllamaToolDefinition[]
    [key: string]: any
  } = {
    model: ollamaModel,
    messages,
    stream: arg.useStreaming,
    think: ollamaThinkMode,
    ...(hasTools ? { tools } : {}),
  }
  const customHeaders: Record<string, string> = {
    ...(isCloud && !cloudToolProtocol && ollamaApiKey ? { Authorization: 'Bearer ' + ollamaApiKey } : {}),
    ...(!cloudToolProtocol ? (providerOptions?.extraHeaders ?? {}) : {}),
  }
  requestBody = applyAdditionalParameters(
    requestBody,
    cloudToolProtocol ? {} : customHeaders,
    additionalParamsForRequest(arg),
  )

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        url: isCloud ? 'https://ollama.com/api/chat' : `${localBaseUrl}/api/chat`,
        model: ollamaModel,
        source: ollamaModelSource,
        stream: arg.useStreaming,
        think: ollamaThinkMode,
        headers: customHeaders,
        body: requestBody,
      }),
    }
  }

  const ollama = new Ollama({
    host: isCloud ? 'https://ollama.com' : localBaseUrl,
    headers: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    fetch: isCloud && cloudToolProtocol ? createOllamaCloudFetch(cloudToolEndpoint, cloudToolAuth) : undefined,
  })

  if (!arg.useStreaming) {
    let prefix = ''
    for (let i = 0; i < OLLAMA_TOOL_LOOP_LIMIT; i++) {
      const response = await ollama.chat({
        ...requestBody,
        messages,
        stream: false,
      })
      const content = response.message?.content ?? ''
      const thinking = response.message?.thinking ?? ''
      const toolCalls = hasTools ? normalizeOllamaToolCalls(response.message?.tool_calls) : []

      if (toolCalls.length === 0) {
        const result = appendVisibleOllamaPart(prefix, formatThinkingOutput(thinking, content))
        return {
          type: 'success',
          result: unstringlizeChat(result, formated, arg.currentChar?.name ?? ''),
          model: arg.aiModel,
        }
      }

      messages.push({
        role: 'assistant',
        thinking,
        content: db.simplifiedToolUse ? '' : content,
        tool_calls: toolCalls,
      })
      const callCodes = await appendOllamaToolResults(messages, toolCalls, arg.tools, arg.rememberToolUsage)
      prefix = appendVisibleOllamaPart(
        prefix,
        db.simplifiedToolUse ? '' : formatThinkingOutput(thinking, content),
        ...callCodes,
      )
    }

    return {
      type: 'fail',
      result: language.errors.ollamaToolCallLimit,
      noRetry: true,
    }
  }

  const readableStream = new ReadableStream<StreamResponseChunk>({
    async start(controller) {
      let prefix = ''
      for (let i = 0; i < OLLAMA_TOOL_LOOP_LIMIT; i++) {
        const response = await ollama.chat({
          ...requestBody,
          messages,
          stream: true,
        })
        let content = ''
        let thinking = ''
        const toolCalls: OllamaToolCall[] = []
        for await (const chunk of response) {
          thinking += chunk.message?.thinking ?? ''
          content += chunk.message?.content ?? ''
          if (hasTools) toolCalls.push(...normalizeOllamaToolCalls(chunk.message?.tool_calls))
          controller.enqueue({
            '0': appendVisibleOllamaPart(prefix, formatThinkingOutput(thinking, content)),
          })
        }

        if (toolCalls.length === 0) {
          controller.close()
          return
        }

        messages.push({
          role: 'assistant',
          thinking,
          content: db.simplifiedToolUse ? '' : content,
          tool_calls: toolCalls,
        })
        const callCodes = await appendOllamaToolResults(messages, toolCalls, arg.tools, arg.rememberToolUsage)
        prefix = appendVisibleOllamaPart(
          prefix,
          db.simplifiedToolUse ? '' : formatThinkingOutput(thinking, content),
          ...callCodes,
        )
        controller.enqueue({ '0': prefix })
      }
      controller.error(new Error(language.errors.ollamaToolCallLimit))
    },
  })

  return {
    type: 'streaming',
    result: readableStream,
    model: arg.aiModel,
  }
}

async function requestCohere(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const aiModel = arg.aiModel
  const providerOptions = arg.resolvedProfile?.providerOptions
  const hasResolvedProfile = arg.resolvedProfile !== undefined
  const requestURL = hasResolvedProfile
    ? (providerOptions?.endpoint ??
      (providerOptions?.baseUrl ? appendOperationPath(providerOptions.baseUrl, '/chat') : undefined))
    : undefined

  let lastChatPrompt = ''
  let preamble = ''

  let lastChat = formated[formated.length - 1]
  if (lastChat.role === 'user') {
    lastChatPrompt = lastChat.content
    formated.pop()
  } else {
    while (lastChat.role !== 'user') {
      lastChat = formated.pop()
      if (!lastChat) {
        return {
          type: 'fail',
          result: 'Cohere requires a user message to generate a response',
        }
      }
      lastChatPrompt = (lastChat.role === 'user' ? '' : `${lastChat.role}: `) + '\n' + lastChat.content + lastChatPrompt
    }
  }

  const firstChat = formated[0]
  if (firstChat.role === 'system') {
    preamble = firstChat.content
    formated.shift()
  }

  //reformat chat

  let body = applyParameters(
    {
      message: lastChatPrompt,
      chat_history: formated
        .map((v) => {
          if (v.role === 'assistant') {
            return {
              role: 'CHATBOT',
              message: v.content,
            }
          }
          if (v.role === 'system') {
            return {
              role: 'SYSTEM',
              message: v.content,
            }
          }
          if (v.role === 'user') {
            return {
              role: 'USER',
              message: v.content,
            }
          }
          return null
        })
        .filter((v) => v !== null)
        .filter((v) => {
          return v.message
        }),
    },
    ['temperature', 'top_k', 'top_p', 'presence_penalty', 'frequency_penalty'],
    {
      top_k: 'k',
      top_p: 'p',
    },
    arg.mode,
    {
      database: db,
      modelId: arg.aiModel,
      runtimeOptions: arg.resolvedProfile?.runtimeOptions,
    },
  )

  if (hasResolvedProfile) {
    body.model = providerOptions?.requestModel ?? arg.resolvedProfile.requestModel
  }

  const safetyModelId = hasResolvedProfile ? arg.resolvedProfile.modelId : aiModel
  if (safetyModelId !== 'cohere-command-r-03-2024' && safetyModelId !== 'cohere-command-r-plus-04-2024') {
    body.safety_mode = 'NONE'
  }

  if (preamble) {
    if (body.chat_history.length > 0) {
      body.preamble = preamble
    } else {
      body.message = `system: ${preamble}`
    }
  }

  console.log(body)

  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + (hasResolvedProfile ? (providerOptions?.apiKey ?? '') : (arg.key ?? db.cohereAPIKey)),
    'Content-Type': 'application/json',
  }

  if (hasResolvedProfile) Object.assign(headers, providerOptions?.extraHeaders ?? {})
  body = applyAdditionalParameters(body, headers, additionalParamsForRequest(arg))

  const url = requestURL ?? arg.customURL ?? 'https://api.cohere.com/v1/chat'

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        url: url,
        body: body,
        headers: headers,
      }),
    }
  }

  const res = await globalFetch(url, {
    method: 'POST',
    headers: headers,
    body: body,
    abortSignal: arg.abortSignal,
  })

  if (!res.ok) {
    return {
      type: 'fail',
      result: JSON.stringify(res.data),
    }
  }

  const result = res?.data?.text
  if (!result) {
    return {
      type: 'fail',
      result: JSON.stringify(res.data),
    }
  }

  return {
    type: 'success',
    result: result,
  }
}

async function requestHorde(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const aiModel = arg.aiModel
  const providerOptions = arg.resolvedProfile?.providerOptions
  const runtimeOptions = arg.resolvedProfile?.runtimeOptions
  const hasResolvedProfile = arg.resolvedProfile !== undefined
  const currentChar = arg.currentChar
  const abortSignal = arg.abortSignal

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        error: 'Preview body is not supported for Horde',
      }),
    }
  }

  const prompt = applyChatTemplate(formated)

  const realModel = hasResolvedProfile ? (providerOptions?.requestModel ?? '') : aiModel.split(':::')[1]
  const maxContext = hasResolvedProfile ? (runtimeOptions?.maxContext ?? db.maxContext) : db.maxContext
  const maxLength = hasResolvedProfile
    ? (arg.maxTokens ?? runtimeOptions?.maxResponse ?? db.maxResponse)
    : db.maxResponse
  const temperature = hasResolvedProfile
    ? (arg.temperature ??
      runtimeOptions?.temperature ??
      (runtimeOptions?.rawTemperature === undefined ? undefined : runtimeOptions.rawTemperature / 100) ??
      db.temperature / 100)
    : db.temperature / 100
  const topK = hasResolvedProfile ? (runtimeOptions?.topK ?? db.top_k) : db.top_k
  const topP = hasResolvedProfile ? (runtimeOptions?.topP ?? db.top_p) : db.top_p

  let argument: Record<string, any> = {
    prompt: prompt,
    params: {
      n: 1,
      max_context_length: maxContext + 100,
      max_length: maxLength,
      singleline: false,
      temperature: temperature,
      top_k: topK,
      top_p: topP,
    },
    trusted_workers: false,
    workerslow_workers: true,
    _blacklist: false,
    dry_run: false,
    models: [realModel, realModel.trim(), ' ' + realModel, realModel + ' '],
  }

  if (realModel === 'auto') {
    delete argument.models
  }

  let apiKey = '0000000000'
  const profileApiKey = providerOptions?.apiKey?.trim()
  if (hasResolvedProfile) {
    if (profileApiKey && profileApiKey.length > 2) {
      apiKey = profileApiKey
    }
  } else if (db.hordeConfig.apiKey.length > 2) {
    apiKey = db.hordeConfig.apiKey
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    apikey: apiKey,
  }
  argument = applyAdditionalParameters(argument, headers, additionalParamsForRequest(arg))

  const da = await fetch('https://stablehorde.net/api/v2/generate/text/async', {
    body: JSON.stringify(argument),
    method: 'POST',
    headers,
    signal: abortSignal,
  })

  if (da.status !== 202) {
    return {
      type: 'fail',
      result: await da.text(),
    }
  }

  const json: {
    id: string
    kudos: number
    message: string
  } = await da.json()

  let warnMessage = ''
  if (json.message) {
    warnMessage = 'with ' + json.message
  }

  while (true) {
    await sleep(2000)
    const data = await (await fetch('https://stablehorde.net/api/v2/generate/text/status/' + json.id)).json()
    if (!data.is_possible) {
      fetch('https://stablehorde.net/api/v2/generate/text/status/' + json.id, {
        method: 'DELETE',
      })
      return {
        type: 'fail',
        result: 'Response not possible' + warnMessage,
        noRetry: true,
      }
    }
    if (data.done && Array.isArray(data.generations) && data.generations.length > 0) {
      const generations: { text: string }[] = data.generations
      if (generations && generations.length > 0) {
        return {
          type: 'success',
          result: unstringlizeChat(generations[0].text ?? '', formated, currentChar?.name ?? ''),
        }
      }
      return {
        type: 'fail',
        result: 'No Generations when done',
        noRetry: true,
      }
    }
  }
}

async function requestWebLLM(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
  const formated = arg.formated
  const db = arg.database
  const aiModel = arg.aiModel
  const currentChar = arg.currentChar
  const maxTokens = arg.maxTokens
  const temperature = arg.temperature
  const realModel = aiModel.split(':::')[1]
  const prompt = applyChatTemplate(formated)

  if (arg.previewBody) {
    return {
      type: 'success',
      result: JSON.stringify({
        error: 'Preview body is not supported for WebLLM',
      }),
    }
  }
  const v = await runTransformers(prompt, realModel, {
    temperature: temperature,
    max_new_tokens: maxTokens,
    top_k: db.ooba.top_k,
    top_p: db.ooba.top_p,
    repetition_penalty: db.ooba.repetition_penalty,
    typical_p: db.ooba.typical_p,
  } as any)
  return {
    type: 'success',
    result: unstringlizeChat((v.generated_text as string) ?? '', formated, currentChar?.name ?? ''),
  }
}

export interface KoboldSamplerSettingsSchema {
  rep_pen?: number
  rep_pen_range?: number
  rep_pen_slope?: number
  top_k?: number
  top_a?: number
  top_p?: number
  tfs?: number
  typical?: number
  temperature?: number
}

export interface KoboldGenerationInputSchema extends KoboldSamplerSettingsSchema {
  prompt: string
  use_memory?: boolean
  use_story?: boolean
  use_authors_note?: boolean
  use_world_info?: boolean
  use_userscripts?: boolean
  soft_prompt?: string
  max_length?: number
  max_context_length?: number
  n: number
  disable_output_formatting?: boolean
  frmttriminc?: boolean
  frmtrmblln?: boolean
  frmtrmspch?: boolean
  singleline?: boolean
  disable_input_formatting?: boolean
  frmtadsnsp?: boolean
  quiet?: boolean
  sampler_order?: number[]
  sampler_seed?: number
  sampler_full_determinism?: boolean
}
