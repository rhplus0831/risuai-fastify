import { decodeProviderGenerationSettings } from '../prompt/generationInputDecoder.js'
import { createHash } from 'node:crypto'
import type { ProviderGenerationSettings as Database } from '../prompt/serverTypes.js'
import {
  resolveModelProfile,
  resolveModelProfileByProfileId,
  assertModelProfileGenerationReady,
} from '@risuai/shared-core/model-profile-resolver'
import {
  resolveTranslatorPipeline,
  runTranslatorPipeline,
  translatorPipelineSignature,
  type TranslatorHistoryResolver,
} from '@risuai/shared-core/translator-pipeline'
import { dispatchChatProvider, type ChatDispatchHistoryInput } from '../prompt/chatDispatch.js'
import { tokenize } from '../prompt/tokens.js'
import type { CompletionStreamFrame } from '../generation/frames.js'
import { ValidationError } from '../repository.js'
import { stripInternalReasoning } from '@risuai/shared-core/internal-reasoning'
import { createHistorySlotResolver, type HistorySlotContext } from '@risuai/shared-core/history-slots'
import { applyProfileBoundGenerationFields } from '../prompt/effectiveGenerationConfig.js'

export type RawMessageTranslatorType = 'google' | 'deepl' | 'deeplX' | 'llm'

export interface RawMessageTranslation {
  text: string
  source: 'raw'
  sourceHash: string
  targetLanguage: string
  inputLanguage: string
  translatorType: RawMessageTranslatorType
  settingsHash: string
  updatedAt: number
}

export interface RawMessageTranslationInput {
  settings: Record<string, unknown>
  character?: Record<string, unknown>
  chat?: Record<string, unknown>
  text: string
  historyContext?: RawMessageTranslationHistoryContext
  signal: AbortSignal
  requestHistory?: Omit<ChatDispatchHistoryInput, 'source'>
}

export type RawMessageTranslationHistoryContext = HistorySlotContext

export interface RawMessageTranslatorIdentity {
  translatorType: RawMessageTranslatorType
  targetLanguage: string
  inputLanguage: string
  settingsHash: string
}

const SUPPORTED_TRANSLATORS = new Set<RawMessageTranslatorType>(['google', 'deepl', 'deeplX', 'llm'])
const DEFAULT_TRANSLATOR_HISTORY_MAX_TOKENS = 2048

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function translatorTypeFromSettings(settings: Record<string, unknown>): RawMessageTranslatorType {
  const translatorType = stringValue(settings.translatorType, 'google')
  if (SUPPORTED_TRANSLATORS.has(translatorType as RawMessageTranslatorType)) {
    return translatorType as RawMessageTranslatorType
  }
  if (translatorType === 'none') {
    throw new ValidationError('Translation is disabled')
  }
  throw new ValidationError(`Unsupported translator type: ${translatorType}`)
}

function translationLanguages(settings: Record<string, unknown>): { targetLanguage: string; inputLanguage: string } {
  const targetLanguage = stringValue(settings.translator).trim()
  if (!targetLanguage) {
    throw new ValidationError('translator must be configured before translating a message')
  }
  return {
    targetLanguage,
    inputLanguage: stringValue(settings.translatorInputLanguage, 'auto') || 'auto',
  }
}

function translatorNote(character: Record<string, unknown> | undefined): string {
  return stringValue(character?.translatorNote)
}

function boundTranslatorPresetId(chat: Record<string, unknown> | undefined): string | null {
  const presetId = chat?.translatorPresetId
  return typeof presetId === 'string' && presetId.trim() ? presetId : null
}

function translatorHistoryMaxTokens(settings: Record<string, unknown>): number {
  const value = settings.translatorHistoryMaxTokens ?? DEFAULT_TRANSLATOR_HISTORY_MAX_TOKENS
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TRANSLATOR_HISTORY_MAX_TOKENS
}

function translateProfileCacheIdentity(
  settings: Record<string, unknown>,
  chat: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const database = decodeProviderGenerationSettings({
    ...settings,
    characters: [],
    halfStreaming: false,
    useStreaming: false,
  })
  let profile = resolveModelProfile({ database, role: 'translate' })
  if (profile.modelId.length === 0) {
    profile = resolveModelProfile({ database, role: 'translate', staticModel: 'echo_model' })
  }
  return {
    profileId: profile.profileId,
    source: {
      kind: profile.source.kind,
      role: profile.source.role,
      field: profile.source.field ?? null,
      legacyMode: profile.source.legacyMode,
    },
    modelId: profile.modelId,
    requestModel: profile.requestModel,
    model: {
      id: profile.modelInfo.id,
      internalID: profile.modelInfo.internalID ?? null,
      provider: profile.modelInfo.provider,
      format: profile.modelInfo.format,
      tokenizer: profile.modelInfo.tokenizer,
      keyIdentifier: profile.modelInfo.keyIdentifier ?? null,
    },
    provider: {
      id:
        profile.providerOptions.provider ??
        (profile.providerCapability.routable ? profile.providerCapability.provider : null),
      keyIdentifier: profile.providerOptions.keyIdentifier ?? profile.modelInfo.keyIdentifier ?? null,
    },
    runtimeOptions: profile.runtimeOptions,
    boundPresetId: boundTranslatorPresetId(chat),
  }
}

function translatorSettingsHash(input: {
  settings: Record<string, unknown>
  character?: Record<string, unknown>
  chat?: Record<string, unknown>
  translatorType: RawMessageTranslatorType
  targetLanguage: string
  inputLanguage: string
}): string {
  return sha256(
    stableJson({
      translatorType: input.translatorType,
      targetLanguage: input.targetLanguage,
      inputLanguage: input.inputLanguage,
      translatorPipeline: translatorPipelineSignature(
        resolveTranslatorPipeline(input.settings, boundTranslatorPresetId(input.chat)),
      ),
      translatorSendTextAsIs: input.settings.translatorSendTextAsIs === true,
      translatorExcludeThoughts:
        input.settings.translatorSendTextAsIs === true && input.settings.translatorExcludeThoughts === true,
      translatorHistoryMaxTokens: translatorHistoryMaxTokens(input.settings),
      translatorNote: translatorNote(input.character),
      translateProfile: translateProfileCacheIdentity(input.settings, input.chat),
      providerCredentials: input.settings.providerCredentials ?? null,
      modelProfiles: input.settings.modelProfiles ?? null,
      modelRoleProfiles: input.settings.modelRoleProfiles ?? null,
      modelRuntimeDefaults: input.settings.modelRuntimeDefaults ?? null,
      deeplOptions: {
        freeApi: recordValue(input.settings.deeplOptions).freeApi === true,
      },
      deeplXOptions: {
        url: stringValue(recordValue(input.settings.deeplXOptions).url),
        hasToken: stringValue(recordValue(input.settings.deeplXOptions).token).trim().length > 0,
      },
    }),
  )
}

/** Resolve cache identity without invoking a translation provider. */
export function resolveRawMessageTranslatorIdentity(input: {
  settings: Record<string, unknown>
  character?: Record<string, unknown>
  chat?: Record<string, unknown>
}): RawMessageTranslatorIdentity {
  const translatorType = translatorTypeFromSettings(input.settings)
  const { targetLanguage, inputLanguage } = translationLanguages(input.settings)
  return {
    translatorType,
    targetLanguage,
    inputLanguage,
    settingsHash: translatorSettingsHash({
      settings: input.settings,
      character: input.character,
      chat: input.chat,
      translatorType,
      targetLanguage,
      inputLanguage,
    }),
  }
}

function translatorInputText(settings: Record<string, unknown>, text: string): string {
  if (settings.translatorSendTextAsIs !== true || settings.translatorExcludeThoughts !== true) return text
  return stripInternalReasoning(text, { preserveUnchanged: true })
}

function createTranslatorHistoryResolver(
  settings: Record<string, unknown>,
  context: RawMessageTranslationHistoryContext,
): TranslatorHistoryResolver {
  return createHistorySlotResolver({
    context,
    maxTokens: translatorHistoryMaxTokens(settings),
    countTokens: tokenize,
    transformText: (text) => translatorInputText(settings, text),
  })
}

function isProtectedRawLine(line: string): boolean {
  return (
    line.startsWith('{{img') ||
    line.startsWith('{{raw') ||
    line.startsWith('{{video') ||
    (line.startsWith('{{audio') && line.endsWith('}}')) ||
    line.length === 0
  )
}

async function translatePreservingRawBlocks(
  text: string,
  translateChunk: (chunk: string) => Promise<string>,
): Promise<string> {
  const lines = text.split('\n')
  const chunks: Array<{ text: string; translatable: boolean }> = [{ text: '', translatable: true }]
  for (const line of lines) {
    if (isProtectedRawLine(line)) {
      chunks.push({ text: line, translatable: false }, { text: '', translatable: true })
      continue
    }
    const current = chunks[chunks.length - 1]
    current.text += current.text.length === 0 ? line : `\n${line}`
  }

  const translated: string[] = []
  for (const chunk of chunks) {
    if (!chunk.translatable) {
      translated.push(chunk.text)
      continue
    }
    const trimmed = chunk.text.trim()
    if (!trimmed) {
      translated.push(chunk.text)
      continue
    }
    translated.push((await translateChunk(trimmed)).trim())
  }
  return translated.join('\n').trim()
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function textFromGoogleResponse(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value) || !Array.isArray(value[0])) return null
  return value[0]
    .map((part: unknown) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''))
    .filter(Boolean)
    .join('')
}

async function translateWithGoogle(text: string, inputLanguage: string, targetLanguage: string, signal: AbortSignal) {
  const url = new URL('https://translate.googleapis.com/translate_a/single')
  url.searchParams.set('client', 'gtx')
  url.searchParams.set('dt', 't')
  url.searchParams.set('sl', inputLanguage || 'auto')
  url.searchParams.set('tl', targetLanguage)
  url.searchParams.set('q', text)
  const response = await fetch(url, { method: 'GET', signal })
  if (!response.ok) {
    throw new ValidationError(`Google translation failed with HTTP ${response.status}`)
  }
  const translated = textFromGoogleResponse(await readJsonResponse(response))
  if (translated === null) {
    throw new ValidationError('Google translation returned an unexpected response')
  }
  return translated
}

async function translateWithDeepL(
  settings: Record<string, unknown>,
  text: string,
  targetLanguage: string,
  signal: AbortSignal,
) {
  const deeplOptions = recordValue(settings.deeplOptions)
  const key = stringValue(deeplOptions.key).trim()
  if (!key) {
    throw new ValidationError('deeplOptions.key is required for DeepL translation')
  }
  const freeApi = deeplOptions.freeApi === true
  const response = await fetch(
    freeApi ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate',
    {
      method: 'POST',
      signal,
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [text],
        target_lang: targetLanguage.toUpperCase(),
      }),
    },
  )
  const body = await readJsonResponse(response)
  if (!response.ok) {
    throw new ValidationError(`DeepL translation failed with HTTP ${response.status}`)
  }
  const translations = recordValue(body).translations
  if (!Array.isArray(translations) || typeof translations[0]?.text !== 'string') {
    throw new ValidationError('DeepL translation returned an unexpected response')
  }
  return translations[0].text
}

async function translateWithDeepLX(
  settings: Record<string, unknown>,
  text: string,
  inputLanguage: string,
  targetLanguage: string,
  signal: AbortSignal,
) {
  const deeplXOptions = recordValue(settings.deeplXOptions)
  let url = stringValue(deeplXOptions.url, 'http://localhost:1188').trim() || 'http://localhost:1188'
  if (url.endsWith('/')) url = url.slice(0, -1)
  if (!url.endsWith('/translate')) url += '/translate'

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = stringValue(deeplXOptions.token).trim()
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      text,
      target_lang: targetLanguage.toUpperCase(),
      source_lang: inputLanguage.toUpperCase(),
    }),
  })
  const body = await readJsonResponse(response)
  if (!response.ok) {
    throw new ValidationError(`DeepLX translation failed with HTTP ${response.status}`)
  }
  const translated = recordValue(body).data
  if (typeof translated !== 'string') {
    throw new ValidationError('DeepLX translation returned an unexpected response')
  }
  return translated
}

async function collectFrames(frames: AsyncIterable<CompletionStreamFrame>): Promise<string> {
  let result = ''
  for await (const frame of frames) {
    if (frame.kind === 'token') {
      result += frame.content ?? ''
    } else if (frame.kind === 'error') {
      throw new ValidationError(frame.error ?? 'Provider dispatch failed')
    }
  }
  return result
}

async function translateWithLlm(
  settings: Record<string, unknown>,
  character: Record<string, unknown> | undefined,
  chat: Record<string, unknown> | undefined,
  text: string,
  inputLanguage: string,
  targetLanguage: string,
  signal: AbortSignal,
  historyResolver?: TranslatorHistoryResolver,
  requestHistory?: Omit<ChatDispatchHistoryInput, 'source'>,
) {
  const database = decodeProviderGenerationSettings({
    ...settings,
    characters: character ? [character] : [],
    halfStreaming: false,
    useStreaming: false,
  })
  const steps = resolveTranslatorPipeline(settings, boundTranslatorPresetId(chat))
  return runTranslatorPipeline(
    {
      steps,
      sourceText: text,
      to: targetLanguage,
      from: inputLanguage,
      translatorNote: translatorNote(character),
      historyResolver,
      signal,
    },
    async ({ messages, maxResponse, model, signal: stepSignal }) => {
      signal.throwIfAborted()
      let profile =
        model.mode === 'modelProfile'
          ? resolveModelProfileByProfileId({ database, role: 'translate', profileId: model.profileId })
          : null
      profile ??= resolveModelProfile({ database, role: 'translate' })
      if (profile.modelId.length === 0) {
        profile = resolveModelProfile({ database, role: 'translate', staticModel: 'echo_model' })
      }
      assertModelProfileGenerationReady(profile)
      const dispatchDatabase: Database = { ...database }
      applyProfileBoundGenerationFields(dispatchDatabase, profile)
      // A translator step owns its response budget and always uses buffered
      // dispatch, while the profile still owns output-affecting samplers.
      dispatchDatabase.aiModel = profile.modelId
      dispatchDatabase.maxResponse = maxResponse
      dispatchDatabase.halfStreaming = false
      dispatchDatabase.useStreaming = false
      return collectFrames(
        await dispatchChatProvider({
          database: dispatchDatabase,
          formated: messages,
          outputTokens: maxResponse,
          profile,
          signal: stepSignal ?? signal,
          ...(requestHistory
            ? {
                history: {
                  ...requestHistory,
                  source: 'translation',
                  metadata: {
                    targetLanguage,
                    inputLanguage,
                    ...(requestHistory.metadata ?? {}),
                  },
                },
              }
            : {}),
        }),
      )
    },
  )
}

export async function translateRawMessageData(input: RawMessageTranslationInput): Promise<RawMessageTranslation> {
  input.signal.throwIfAborted()
  // Own deadline settlement even when a provider or response body ignores abort.
  // The detached operation can finish later, but its result cannot reach persistence.
  let onAbort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(input.signal.reason ?? new Error('Translation aborted'))
    input.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([executeRawMessageTranslation(input), cancelled])
    input.signal.throwIfAborted()
    return result
  } finally {
    input.signal.removeEventListener('abort', onAbort)
  }
}

async function executeRawMessageTranslation(input: RawMessageTranslationInput): Promise<RawMessageTranslation> {
  const { translatorType, targetLanguage, inputLanguage, settingsHash } = resolveRawMessageTranslatorIdentity(input)
  const translateChunk = async (chunk: string): Promise<string> => {
    input.signal.throwIfAborted()
    if (translatorType === 'google') return translateWithGoogle(chunk, inputLanguage, targetLanguage, input.signal)
    if (translatorType === 'deepl') return translateWithDeepL(input.settings, chunk, targetLanguage, input.signal)
    if (translatorType === 'deeplX') {
      return translateWithDeepLX(input.settings, chunk, inputLanguage, targetLanguage, input.signal)
    }
    return translateWithLlm(
      input.settings,
      input.character,
      input.chat,
      chunk,
      inputLanguage,
      targetLanguage,
      input.signal,
      undefined,
      input.requestHistory,
    )
  }
  const historyResolver =
    translatorType === 'llm' && input.settings.translatorSendTextAsIs === true && input.historyContext
      ? createTranslatorHistoryResolver(input.settings, input.historyContext)
      : undefined
  const translatedText =
    translatorType === 'llm' && input.settings.translatorSendTextAsIs === true
      ? await translateWithLlm(
          input.settings,
          input.character,
          input.chat,
          translatorInputText(input.settings, input.text),
          inputLanguage,
          targetLanguage,
          input.signal,
          historyResolver,
          input.requestHistory,
        )
      : await translatePreservingRawBlocks(input.text, translateChunk)

  return {
    text: translatedText,
    source: 'raw',
    sourceHash: sha256(input.text),
    targetLanguage,
    inputLanguage,
    translatorType,
    settingsHash,
    updatedAt: Date.now(),
  }
}
