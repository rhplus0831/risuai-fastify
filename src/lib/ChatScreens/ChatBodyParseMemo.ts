import { get } from 'svelte/store'
import { untrack } from 'svelte'
import { ParseMarkdown, type CbsConditions, type simpleCharacterArgument } from '../../ts/parser/parser.svelte'
import { getModules } from '../../ts/process/modules'
import {
  type Chat,
  type customscript,
  type triggerscript,
  type character,
  type Database,
} from '../../ts/storage/database.svelte'
import { sharedChatReadOwners } from './sharedChatReadOwners.svelte'
import { createChatBodyModuleReads, readChatBodyModules } from './chatBodyModuleReads.svelte'
import type { ChatReadOwners } from './chatReadOwners.svelte'
import { collectionsResourceState, settingsResourceState } from '../../ts/server/resourceState.svelte'
import { resolveUserPersonaPresentation } from '../../ts/utilState'
import { CurrentTriggerIdStore, ReloadGUIPointer, VariableReloadGUIPointer } from '../../ts/stores.svelte'
import { captureModuleRenderRevision } from '../../ts/moduleRenderRevision'
import { getLLMCache, getLLMCacheMutationEpoch } from '../../ts/translator/translator'
import { getActivePromptPresetRegexScripts } from '../../ts/process/promptPresetRegex'
import {
  normalizeDisplayDependencyValue as normalizeForSignature,
  stableDisplayDependencyJson as stableStringify,
} from '@risuai/protocol/display-source'
import type { DisplaySourceLayer } from '@risuai/protocol/display-source'
import type { DisplaySourcePriority } from '../../ts/server/displaySources'
import { displaySettingForPaint } from '../../ts/gui/displaySettings'

export type ChatBodyParseMode = 'normal' | 'back' | 'pretranslate' | 'notrim'

export interface ChatBodyParseOwnerReaders {
  characterOwner: (
    charArg: string | simpleCharacterArgument | character | null,
  ) => simpleCharacterArgument | character | undefined
  activeCharacterOwner: () => character | undefined
  activeChatOwner: () => Chat | undefined
  settingsOwner: () => Partial<Database>
  assetWidthForPaint?: () => Database['assetWidth'] | undefined
  promptPresetOwners: () => Database['promptPresets'] | undefined
  moduleOwners?: () => ReturnType<typeof getModules>
  userIconOwner?: () => string
}

export function createChatBodyParseOwnerReaders(
  owners: ChatReadOwners = sharedChatReadOwners,
): ChatBodyParseOwnerReaders {
  return {
    characterOwner: (charArg) => {
      if (typeof charArg === 'string') return owners.characterById(charArg)
      return charArg ?? undefined
    },
    activeCharacterOwner: owners.character,
    activeChatOwner: owners.chat,
    settingsOwner: () => settingsResourceState.value as Partial<Database>,
    assetWidthForPaint: () => displaySettingForPaint('assetWidth'),
    promptPresetOwners: () => collectionsResourceState.values.promptPresets,
    moduleOwners: owners === sharedChatReadOwners ? readChatBodyModules : createChatBodyModuleReads(owners),
    userIconOwner: () =>
      resolveUserPersonaPresentation(
        {
          personas: collectionsResourceState.values.personas ?? [],
          selectedPersonaId: settingsResourceState.value.selectedPersonaId,
          username: settingsResourceState.value.username,
          userIcon: settingsResourceState.value.userIcon,
        } as Database,
        owners.chat(),
      ).userIcon,
  }
}

export interface ChatBodyParseMemoInput {
  data: string
  charArg: string | simpleCharacterArgument | character | null
  owners: ChatBodyParseOwnerReaders
  mode: ChatBodyParseMode
  chatID: number
  cbsConditions: CbsConditions
  chatId?: string
  displayLayer?: DisplaySourceLayer
  messageId?: string
  name?: string
  streaming?: boolean
  displayPriority?: DisplaySourcePriority
  readOnly?: boolean
  memoKey?: string
}

export interface ChatBodyCachedOnlyInput {
  data: string
  charArg: string | simpleCharacterArgument | character | null
  owners: ChatBodyParseOwnerReaders
  chatID: number
  cbsConditions: CbsConditions
  fallbackMode: ChatBodyParseMode
  chatId?: string
  displayLayer?: DisplaySourceLayer
  messageId?: string
  name?: string
  streaming?: boolean
  displayPriority?: DisplaySourcePriority
  readOnly?: boolean
  cachedOnlyParseKey?: string
  detectionKey?: string
}

const PARSE_MEMO_LIMIT = 180
const LLM_DETECTION_MEMO_LIMIT = 180
const SIGNATURE_MEMO_LIMIT = 48
const LARGE_SIGNATURE_STRING_LIMIT = 512
const SIGNATURE_STRING_HASH_MEMO_LIMIT = 256
const PARSE_MEMO_KEY_BUDGET_BYTES = 16 * 1024 * 1024
const LLM_DETECTION_MEMO_KEY_BUDGET_BYTES = 16 * 1024 * 1024

const parseMemo = new Map<string, Promise<string>>()
const llmDetectionMemo = new Map<string, Promise<boolean>>()
const characterSignatureMemo = new Map<string, string>()
const activeChatSignatureMemo = new Map<string, string>()
const moduleSignatureMemo = new Map<string, string>()
const settingsSignatureMemo = new Map<string, string>()
const signatureStringHashMemo = new Map<string, string>()
let parseMemoKeyBytes = 0
let llmDetectionMemoKeyBytes = 0
let memoModuleRenderRevision = captureModuleRenderRevision()

const debugStats = {
  parseKeyBuilds: 0,
  characterSignatureBuilds: 0,
  activeChatSignatureBuilds: 0,
  moduleSignatureBuilds: 0,
  settingsSignatureBuilds: 0,
}

function remember<T>(memo: Map<string, T>, key: string, value: T, limit: number) {
  memo.set(key, value)
  while (memo.size > limit) {
    const oldest = memo.keys().next().value
    if (oldest === undefined) break
    memo.delete(oldest)
  }
}

function refresh<T>(memo: Map<string, T>, key: string, value: T) {
  memo.delete(key)
  memo.set(key, value)
  return value
}

function estimatedStringBytes(value: string): number {
  return value.length * 2
}

function deleteParseMemoEntry(key: string): void {
  if (!parseMemo.delete(key)) return
  parseMemoKeyBytes = Math.max(0, parseMemoKeyBytes - estimatedStringBytes(key))
}

function rememberParseMemoEntry(key: string, value: Promise<string>): void {
  parseMemo.set(key, value)
  parseMemoKeyBytes += estimatedStringBytes(key)
  while (parseMemo.size > PARSE_MEMO_LIMIT || parseMemoKeyBytes > PARSE_MEMO_KEY_BUDGET_BYTES) {
    const oldest = parseMemo.keys().next().value
    if (oldest === undefined) break
    deleteParseMemoEntry(oldest)
  }
}

function deleteLlmDetectionMemoEntry(key: string): void {
  if (!llmDetectionMemo.delete(key)) return
  llmDetectionMemoKeyBytes = Math.max(0, llmDetectionMemoKeyBytes - estimatedStringBytes(key))
}

function rememberLlmDetectionMemoEntry(key: string, value: Promise<boolean>): void {
  llmDetectionMemo.set(key, value)
  llmDetectionMemoKeyBytes += estimatedStringBytes(key)
  while (
    llmDetectionMemo.size > LLM_DETECTION_MEMO_LIMIT ||
    llmDetectionMemoKeyBytes > LLM_DETECTION_MEMO_KEY_BUDGET_BYTES
  ) {
    const oldest = llmDetectionMemo.keys().next().value
    if (oldest === undefined) break
    deleteLlmDetectionMemoEntry(oldest)
  }
}

function reconcileModuleRenderRevision(): void {
  const revision = captureModuleRenderRevision()
  if (revision === memoModuleRenderRevision) return
  memoModuleRenderRevision = revision
  parseMemo.clear()
  llmDetectionMemo.clear()
  moduleSignatureMemo.clear()
  parseMemoKeyBytes = 0
  llmDetectionMemoKeyBytes = 0
}

function stableFragment(value: unknown): string {
  return stableStringify(value) ?? 'null'
}

function signatureStringFragment(value: string): string {
  if (value.length <= LARGE_SIGNATURE_STRING_LIMIT) return value
  const cached = signatureStringHashMemo.get(value)
  if (cached !== undefined) {
    return refresh(signatureStringHashMemo, value, cached)
  }

  let hash = 0x811c9dc5
  let check = 0x1505
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    hash ^= code
    hash = Math.imul(hash, 0x01000193)
    check = Math.imul(check, 33) ^ code
  }
  const hashed = `${value.length}:${(hash >>> 0).toString(36)}:${(check >>> 0).toString(36)}`
  remember(signatureStringHashMemo, value, hashed, SIGNATURE_STRING_HASH_MEMO_LIMIT)
  return hashed
}

function compactForSignature(value: unknown): unknown {
  if (typeof value === 'string') {
    return signatureStringFragment(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactForSignature(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const next = (value as Record<string, unknown>)[key]
    if (next === undefined || typeof next === 'function') {
      continue
    }
    normalized[key] = compactForSignature(next)
  }
  return normalized
}

function scalarListSignature(value: unknown) {
  return Array.isArray(value) ? value.map((item) => normalizeForSignature(item)) : []
}

function cachedSerializedSignature(
  memo: Map<string, string>,
  token: unknown,
  build: () => unknown,
  stat: keyof Omit<typeof debugStats, 'parseKeyBuilds'>,
): string {
  const key = stableFragment(token)
  const cached = memo.get(key)
  if (cached !== undefined) {
    return refresh(memo, key, cached)
  }

  debugStats[stat] += 1
  const serialized = stableFragment(build())
  remember(memo, key, serialized, SIGNATURE_MEMO_LIMIT)
  return serialized
}

function scriptSignature(script?: customscript | null) {
  if (!script) return null
  return {
    id: compactForSignature(script.id),
    comment: compactForSignature(script.comment),
    in: compactForSignature(script.in),
    out: compactForSignature(script.out),
    type: compactForSignature(script.type),
    flag: compactForSignature(script.flag),
    ableFlag: script.ableFlag,
  }
}

function triggerSignature(trigger?: triggerscript | null) {
  if (!trigger) return null
  return compactForSignature(trigger)
}

function scriptListSignature(scripts?: readonly customscript[] | null) {
  return (scripts ?? []).map(scriptSignature)
}

function untrackedScriptListSignature(readScripts: () => readonly customscript[] | null | undefined) {
  return untrack(() => scriptListSignature(readScripts()))
}

function triggerListSignature(triggers?: readonly triggerscript[] | null) {
  return (triggers ?? []).map(triggerSignature)
}

function tupleListSignature(tuples?: readonly unknown[] | null) {
  return (tuples ?? []).map((tuple) =>
    Array.isArray(tuple) ? tuple.map((value) => compactForSignature(value)) : compactForSignature(tuple),
  )
}

function findCharacterByArg(charArg: ChatBodyParseMemoInput['charArg'], owners: ChatBodyParseOwnerReaders) {
  return owners.characterOwner(charArg)
}

function characterSignature(charArg: ChatBodyParseMemoInput['charArg'], owners: ChatBodyParseOwnerReaders) {
  const char = untrack(() => findCharacterByArg(charArg, owners))
  if (!char) return null

  return {
    type: char.type,
    chaId: char.chaId,
    customscript: untrackedScriptListSignature(() => char.customscript),
    triggerscript: (char.triggerscript ?? []).map(triggerSignature),
    additionalAssets: char.additionalAssets ?? [],
    emotionImages: char.emotionImages ?? [],
    virtualscript: char.virtualscript,
    modules: 'modules' in char ? char.modules : undefined,
    scriptstate: 'scriptstate' in char ? char.scriptstate : undefined,
    defaultVariables: 'defaultVariables' in char ? char.defaultVariables : undefined,
  }
}

function characterSignatureToken(charArg: ChatBodyParseMemoInput['charArg'], owners: ChatBodyParseOwnerReaders) {
  const reloadEpoch = get(ReloadGUIPointer)
  const char = untrack(() => findCharacterByArg(charArg, owners))
  if (!char) {
    return {
      reloadEpoch,
      primitive: null,
    }
  }

  const modules = 'modules' in char ? char.modules : undefined
  return {
    reloadEpoch,
    type: char.type,
    chaId: char.chaId,
    customscript: untrackedScriptListSignature(() => char.customscript),
    triggerscript: triggerListSignature(char.triggerscript),
    additionalAssets: tupleListSignature(char.additionalAssets),
    emotionImages: tupleListSignature(char.emotionImages),
    virtualscript: char.virtualscript,
    modules: scalarListSignature(modules),
    scriptstate: normalizeForSignature('scriptstate' in char ? char.scriptstate : undefined),
    defaultVariables: 'defaultVariables' in char ? char.defaultVariables : undefined,
  }
}

function serializedCharacterSignature(charArg: ChatBodyParseMemoInput['charArg'], owners: ChatBodyParseOwnerReaders) {
  return cachedSerializedSignature(
    characterSignatureMemo,
    characterSignatureToken(charArg, owners),
    () => characterSignature(charArg, owners),
    'characterSignatureBuilds',
  )
}

function safeGetModules(owners: ChatBodyParseOwnerReaders) {
  try {
    if (owners.moduleOwners) return owners.moduleOwners()
    return getModules({ character: owners.activeCharacterOwner(), chat: owners.activeChatOwner() })
  } catch {
    return []
  }
}

function safeGetActivePromptPresetRegexScripts(owners: ChatBodyParseOwnerReaders) {
  try {
    const settings = owners.settingsOwner()
    return getActivePromptPresetRegexScripts(
      {
        presetRegex: settings.presetRegex,
        promptPresets: owners.promptPresetOwners() ?? [],
      } as Database,
      owners.activeChatOwner(),
    )
  } catch {
    const settings = owners.settingsOwner()
    return Array.isArray(settings.presetRegex) ? settings.presetRegex : []
  }
}

function moduleSignature(modules: ReturnType<typeof getModules>) {
  return {
    activeModuleIds: modules.map((module) => module?.id),
    renderRevision: captureModuleRenderRevision(),
  }
}

function moduleSignatureToken(modules: ReturnType<typeof getModules>) {
  return {
    activeModuleIds: modules.map((module) => module?.id),
    renderRevision: captureModuleRenderRevision(),
  }
}

function serializedModuleSignature(modules: ReturnType<typeof getModules>) {
  return cachedSerializedSignature(
    moduleSignatureMemo,
    moduleSignatureToken(modules),
    () => moduleSignature(modules),
    'moduleSignatureBuilds',
  )
}

function activeChatSignature(owners: ChatBodyParseOwnerReaders) {
  const char = owners.activeCharacterOwner()
  const chat = owners.activeChatOwner()

  return {
    chaId: char?.chaId,
    chatId: chat?.id,
    characterImage: char?.image,
    userIcon: owners.userIconOwner?.(),
    chatModules: chat?.modules,
    scriptstate: normalizeForSignature(chat?.scriptstate ?? null),
  }
}

function activeChatSignatureToken(owners: ChatBodyParseOwnerReaders) {
  const char = owners.activeCharacterOwner()
  const chat = owners.activeChatOwner()

  return {
    reloadEpoch: get(ReloadGUIPointer),
    chaId: char?.chaId,
    chatId: chat?.id,
    characterImage: char?.image,
    userIcon: owners.userIconOwner?.(),
    chatModules: scalarListSignature(chat?.modules),
    scriptstate: normalizeForSignature(chat?.scriptstate ?? null),
  }
}

function serializedActiveChatSignature(owners: ChatBodyParseOwnerReaders) {
  return cachedSerializedSignature(
    activeChatSignatureMemo,
    activeChatSignatureToken(owners),
    () => activeChatSignature(owners),
    'activeChatSignatureBuilds',
  )
}

function parseSettingsSignature(owners: ChatBodyParseOwnerReaders) {
  const db = owners.settingsOwner()
  return {
    reloadEpoch: get(ReloadGUIPointer),
    currentTriggerId: get(CurrentTriggerIdStore),
    globalRegex: untrackedScriptListSignature(() => db.globalscript),
    presetRegex: untrackedScriptListSignature(() => safeGetActivePromptPresetRegexScripts(owners)),
    hideAllImages: db.hideAllImages,
    customQuotes: db.customQuotes,
    customQuotesData: db.customQuotesData,
    unformatQuotes: db.unformatQuotes,
    paragraphBreakBySentences: db.paragraphBreakBySentences ?? false,
    paragraphBreakSentenceCount: db.paragraphBreakSentenceCount ?? 3,
    blockquoteStyling: db.blockquoteStyling,
    assetWidth: owners.assetWidthForPaint ? owners.assetWidthForPaint() : db.assetWidth,
    assetMaxDifference: db.assetMaxDifference,
    legacyMediaFindings: db.legacyMediaFindings,
    dynamicAssets: db.dynamicAssets,
    dynamicAssetsEditDisplay: db.dynamicAssetsEditDisplay,
    returnCSSError: db.returnCSSError,
  }
}

function settingsSignatureToken(owners: ChatBodyParseOwnerReaders) {
  const db = owners.settingsOwner()
  return {
    reloadEpoch: get(ReloadGUIPointer),
    currentTriggerId: get(CurrentTriggerIdStore),
    globalRegex: untrackedScriptListSignature(() => db.globalscript),
    presetRegex: untrackedScriptListSignature(() => safeGetActivePromptPresetRegexScripts(owners)),
    hideAllImages: db.hideAllImages,
    customQuotes: db.customQuotes,
    customQuotesData: db.customQuotesData ?? [],
    unformatQuotes: db.unformatQuotes,
    paragraphBreakBySentences: db.paragraphBreakBySentences ?? false,
    paragraphBreakSentenceCount: db.paragraphBreakSentenceCount ?? 3,
    blockquoteStyling: db.blockquoteStyling,
    assetWidth: owners.assetWidthForPaint ? owners.assetWidthForPaint() : db.assetWidth,
    assetMaxDifference: db.assetMaxDifference,
    legacyMediaFindings: db.legacyMediaFindings,
    dynamicAssets: db.dynamicAssets,
    dynamicAssetsEditDisplay: db.dynamicAssetsEditDisplay,
    returnCSSError: db.returnCSSError,
  }
}

function serializedSettingsSignature(owners: ChatBodyParseOwnerReaders) {
  return cachedSerializedSignature(
    settingsSignatureMemo,
    settingsSignatureToken(owners),
    () => parseSettingsSignature(owners),
    'settingsSignatureBuilds',
  )
}

export function getChatBodyParseMemoKey(input: ChatBodyParseMemoInput): string {
  return untrack(() => {
    reconcileModuleRenderRevision()
    debugStats.parseKeyBuilds += 1
    const modules = safeGetModules(input.owners)
    return `{"activeChat":${serializedActiveChatSignature(input.owners)},"cbsConditions":${stableFragment(
      input.cbsConditions ?? {},
    )},"character":${serializedCharacterSignature(input.charArg, input.owners)},"chatId":${stableFragment(
      input.chatId,
    )},"chatID":${stableFragment(
      input.chatID,
    )},"data":${stableFragment(input.data ?? '')},"kind":"chat-body-parse","readOnly":${stableFragment(input.readOnly === true)},"mode":${stableFragment(
      input.mode,
    )},"displayLayer":${stableFragment(input.displayLayer)},"messageId":${stableFragment(
      input.messageId,
    )},"name":${stableFragment(input.name)},"modules":${serializedModuleSignature(modules)},"settings":${serializedSettingsSignature(input.owners)},"streaming":${stableFragment(
      input.streaming,
    )},"variableReloadEpoch":${stableFragment(get(VariableReloadGUIPointer))}}`
  })
}

function getTranslateSettingsSignature(owners: ChatBodyParseOwnerReaders) {
  const db = owners.settingsOwner()
  const chat = owners.activeChatOwner()
  return {
    autoTranslate: chat?.autoTranslate,
    autoTranslateBotOnly: chat?.autoTranslateBotOnly,
    autoTranslateCachedOnly: db.autoTranslateCachedOnly,
    translatorType: db.translatorType,
    translator: db.translator,
    translatorInputLanguage: db.translatorInputLanguage,
    legacyTranslation: db.legacyTranslation,
    translateBeforeHTMLFormatting: db.translateBeforeHTMLFormatting,
    cacheEpoch: getLLMCacheMutationEpoch(),
  }
}

export function getChatBodyCachedOnlyLlmDetectionMode(
  input: Pick<ChatBodyCachedOnlyInput, 'fallbackMode' | 'owners'>,
): ChatBodyParseMode | 'raw' {
  const db = input.owners.settingsOwner()
  return db.translateBeforeHTMLFormatting ? 'raw' : db.legacyTranslation ? input.fallbackMode : 'pretranslate'
}

export function getChatBodyCachedOnlyLlmDetectionKey(input: ChatBodyCachedOnlyInput): string {
  const db = input.owners.settingsOwner()
  const detectionMode = getChatBodyCachedOnlyLlmDetectionMode(input)
  const parseKey =
    detectionMode === 'raw'
      ? undefined
      : (input.cachedOnlyParseKey ??
        getChatBodyParseMemoKey({
          data: input.data,
          charArg: input.charArg,
          owners: input.owners,
          mode: detectionMode,
          chatID: input.chatID,
          cbsConditions: input.cbsConditions,
          chatId: input.chatId,
          displayLayer: input.displayLayer,
          messageId: input.messageId,
          name: input.name,
          streaming: input.streaming,
          displayPriority: input.displayPriority,
          readOnly: input.readOnly,
        }))

  const parseKeyFragment = detectionMode === 'raw' ? '' : `,"parseKey":${stableFragment(parseKey ?? '')}`
  const rawDataFragment = db.translateBeforeHTMLFormatting ? `,"rawData":${stableFragment(input.data ?? '')}` : ''

  return `{"chatId":${stableFragment(input.chatId)},"detectionMode":${stableFragment(
    detectionMode,
  )},"kind":"chat-body-llm-cache-exists"${parseKeyFragment}${rawDataFragment},"translateSettings":${stableFragment(
    getTranslateSettingsSignature(input.owners),
  )}}`
}

export function memoizedChatBodyParse(input: ChatBodyParseMemoInput): Promise<string> {
  return untrack(() => {
    reconcileModuleRenderRevision()
    const key = input.memoKey ?? getChatBodyParseMemoKey(input)
    const cached = parseMemo.get(key)
    if (cached) {
      return refresh(parseMemo, key, cached)
    }
    const activeChat = input.owners.activeChatOwner()
    const readContext =
      !input.chatId || activeChat?.id === input.chatId
        ? {
            character: input.owners.activeCharacterOwner(),
            chat: activeChat,
            userIcon: input.owners.userIconOwner?.(),
          }
        : undefined

    const promise = ParseMarkdown(
      input.data,
      input.owners.characterOwner(input.charArg) ?? null,
      input.mode,
      input.chatID,
      input.cbsConditions,
      {
        chatId: input.chatId,
        layer: input.displayLayer,
        messageId: input.messageId,
        name: input.name,
        streaming: input.streaming,
        priority: input.displayPriority,
        readOnly: input.readOnly,
        readContext,
      },
    ).catch((error) => {
      deleteParseMemoEntry(key)
      throw error
    })
    rememberParseMemoEntry(key, promise)
    return promise
  })
}

export async function getChatBodyCachedOnlyLlmDecision(input: ChatBodyCachedOnlyInput): Promise<boolean> {
  reconcileModuleRenderRevision()
  const key = input.detectionKey ?? getChatBodyCachedOnlyLlmDetectionKey(input)
  const cached = llmDetectionMemo.get(key)
  if (cached) {
    return refresh(llmDetectionMemo, key, cached)
  }

  const promise = (async () => {
    const db = input.owners.settingsOwner()
    const cacheKey = db.translateBeforeHTMLFormatting
      ? input.data
      : await memoizedChatBodyParse({
          data: input.data,
          charArg: input.charArg,
          owners: input.owners,
          mode: getChatBodyCachedOnlyLlmDetectionMode(input) as ChatBodyParseMode,
          chatID: input.chatID,
          cbsConditions: input.cbsConditions,
          chatId: input.chatId,
          displayLayer: input.displayLayer,
          messageId: input.messageId,
          name: input.name,
          streaming: input.streaming,
          displayPriority: input.displayPriority,
          readOnly: input.readOnly,
          memoKey: input.cachedOnlyParseKey,
        })
    return (await getLLMCache(cacheKey)) !== null
  })().catch((error) => {
    deleteLlmDetectionMemoEntry(key)
    throw error
  })

  rememberLlmDetectionMemoEntry(key, promise)
  return promise
}

export function clearChatBodyParseMemo() {
  parseMemo.clear()
  llmDetectionMemo.clear()
  parseMemoKeyBytes = 0
  llmDetectionMemoKeyBytes = 0
  memoModuleRenderRevision = captureModuleRenderRevision()
  characterSignatureMemo.clear()
  activeChatSignatureMemo.clear()
  moduleSignatureMemo.clear()
  settingsSignatureMemo.clear()
  signatureStringHashMemo.clear()
  resetChatBodyParseMemoDebugStats()
}

export function getChatBodyParseMemoStats() {
  return {
    parseEntries: parseMemo.size,
    parseKeyBytes: parseMemoKeyBytes,
    llmDetectionEntries: llmDetectionMemo.size,
    llmDetectionKeyBytes: llmDetectionMemoKeyBytes,
    characterSignatureEntries: characterSignatureMemo.size,
    activeChatSignatureEntries: activeChatSignatureMemo.size,
    moduleSignatureEntries: moduleSignatureMemo.size,
    settingsSignatureEntries: settingsSignatureMemo.size,
  }
}

export function getChatBodyParseMemoDebugStats() {
  return { ...debugStats }
}

export function resetChatBodyParseMemoDebugStats() {
  debugStats.parseKeyBuilds = 0
  debugStats.characterSignatureBuilds = 0
  debugStats.activeChatSignatureBuilds = 0
  debugStats.moduleSignatureBuilds = 0
  debugStats.settingsSignatureBuilds = 0
}
