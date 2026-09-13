import { get } from 'svelte/store'
import { checkNullish, decryptBuffer, encryptBuffer } from '../util'
import { createNonSecurityUuid } from '../nonSecurityUuid'
import { changeLanguage, language } from '../../lang'
import type { RisuPlugin } from '../plugins/plugins.svelte'
import type { triggerscript as triggerscriptMain } from '../process/triggers'
import { downloadFile, saveAsset as saveImageGlobal } from '../globalApi.svelte'
import {
  createDefaultInputHooks,
  defaultAutoSuggestPrompt,
  defaultJailbreak,
  defaultMainPrompt,
} from './defaultPrompts'
import { alertError, alertNormal, alertSelect } from '../alert'
import { selectSingleFile } from '../filePicker'
import type { NAISettings } from '../process/models/nai'
import { prebuiltNAIpresets, prebuiltPresets } from '../process/templates/templates'
import { defaultColorScheme, type ColorScheme } from '../gui/colorscheme'
import type { PromptItem, PromptSettings } from '../process/prompt'
import { normalizePromptTemplate } from '../process/promptTemplateNormalization'
import type { OobaChatCompletionRequestParams } from '../model/ooba'
import {
  createDefaultModelRoleOverrides,
  normalizeLegacyFallbackModels,
  normalizeLegacySeperateModels,
  normalizeModelRoleOverrides,
  type LegacyFallbackModelMap,
  type LegacySeperateModelMap,
  type NormalizedModelRoleOverrides,
} from '@risuai/shared-core/model-roles'
import {
  normalizeModelProfileOrder,
  normalizeModelRuntimeDefaults,
  normalizeModelProfiles,
  normalizeModelRoleProfiles,
  type ModelProfileOrderEntry,
  type ModelProfileRecord,
  type ModelProfileRecordRuntimeOptions,
  type ModelRoleProfileMap,
} from '../model/modelProfileRecords'
import {
  normalizeProjectedProviderCredentials,
  normalizeProviderCredentials,
  type ProviderCredentialRecord,
} from '../model/providerCredentialRecords'
import { normalizeScriptModelOverrides, type ScriptModelOverrides } from '@risuai/shared-core/script-model-overrides'
import {
  DEFAULT_REGEX_OUTPUT_SIZE_LIMIT_MIB,
  normalizeRegexOutputSizeLimitMiB,
} from '@risuai/shared-core/regex-output-size-limit'
import {
  normalizeAgentConfiguration,
  normalizeAgentPresetDefaultId,
  type AgentPresetRecord,
  type AgentRecord,
} from '../agentPresetRecords'
import { type HypaV3Settings, type HypaV3Preset, createHypaV3Preset } from '../process/memory/hypav3'
import { repairHypaV3PresetSelectionIdentity } from '@risuai/shared-core/hypa-v3-preset-selection-identity'
import { normalizeTranslatorPresetStateWithLegacyCompatibility, type TranslatorPreset } from '../translator/presets'
import { safeStructuredClone } from '../polyfill'
import { repairLegacyLocalStopStrings } from '@risuai/shared-core/local-stop-strings'
import { SERVER_CHARACTER_SHELL_MARKER } from '@risuai/protocol/character-summary-resource'
import { normalizeModuleFolders } from '@risuai/protocol/module-organization'
import {
  DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
  isBardWikiGlobalSettings,
  type BardWikiGlobalSettings,
} from '@risuai/protocol'
import {
  canUseServerCommands,
  createModelPresetCommand,
  createPromptPresetCommand,
  copyPresetCommand,
  createPresetCommand,
  deleteModelPresetCommand,
  deletePromptPresetCommand,
  deletePresetCommand,
  extractLegacyBotPresetCommand,
  reorderModelPresetsCommand,
  reorderPromptPresetsCommand,
  reorderPresetsCommand,
  runServerCommand,
  selectModelPresetCommand,
  selectPromptPresetCommand,
  selectPresetCommand,
  updateModelPresetCommand,
  updatePromptPresetCommand,
  updatePresetCommand,
  type ModelPresetSnapshot,
  peekCachedServerCommandRevision,
  type JsonFieldState,
  type LegacyPresetPatchOptimisticAcknowledgement,
  type PromptPresetSnapshot,
  type PresetSnapshot,
  type PresetReorderOptimisticAcknowledgement,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
  type SplitPresetPatchOptimisticAcknowledgement,
} from '../server/commands'
import { currentCharacterRowSnapshot, dispatchCompatibleCharacterUpdateScoped } from '../characterCommands'
import { currentChatScopedSnapshot, dispatchCompatibleChatUpdateScoped } from '../chatCommands'
import { mergeChatMessageRange, sameStructuredValue } from '../server/chatMessageRangeMerge'
import {
  captureCollectionProjectionEpoch,
  captureSettingsProjectionEpoch,
  charactersResourceState,
  collectionsResourceState,
  hasCollectionProjectionEpochChanged,
  hasSettingsProjectionEpochChanged,
  isServerCollectionName,
  markCollectionAcknowledgementTainted,
  markSettingsAcknowledgementTainted,
  replaceResourceDatabase,
  settingsResourceState,
} from '../server/resourceState.svelte'
import {
  capturePromptTemplateOwnerProjectionEpoch,
  ensurePromptTemplateHydrated,
  hasPromptTemplateOwnerProjectionEpochChanged,
  isPromptTemplateHydrated,
  markPromptTemplateOwnerAcknowledgementTainted,
  peekPromptTemplateOwnerRevision,
} from '../server/promptTemplateHydration'
import {
  commitPendingPromptTemplateMutations,
  promptTemplateOwnerMutationKey,
} from '../server/promptTemplateMutations.svelte'
import {
  applyAttemptedFieldRollback,
  applyAttemptedKeyedListRollback,
  createDestructiveRefreshToken,
} from '../server/staleStateGuards'
import { isServerChatMessagePlaceholder, SERVER_UNLOADED_CHAT_MESSAGE_MARKER } from '../server/chatMessagePlaceholders'
import {
  DEFAULT_CHAT_DISPLAY_TAIL_COUNT,
  normalizeChatDisplayTailCount,
} from '@risuai/shared-core/chat-display-tail-count'
import {
  DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  normalizeChatLoadPages,
} from '@risuai/shared-core/chat-load-pages'
import { normalizeDesktopSidebarColumns, normalizeMobileSidebarColumns } from '@risuai/shared-core/sidebar-columns'
import type { ChatGenerationSettings } from '../chatGenerationSettings'
import { optimisticallyRehomeGenerationReferences } from '../generationReferenceCascade'
import {
  normalizeChatGenerationTogglePresets,
  type ChatGenerationTogglePreset,
} from '../chatGenerationTogglePresetRecords'
import { fetchServerLegacyPreset } from '../server/hydrationReads'
import { canUseServerResourceReads } from '../server/resourceReads'
import { shouldPreserveLiveChatGenerationSettingsForResource } from '../server/chatGenerationSettingsResourceGuard'
import {
  flushRegisteredPendingOwnerMutation,
  registerPendingOwnerResetter,
  registerPendingOwnerMutationFlusher,
} from '../server/pendingOwnerMutationRegistry'
import { dispatchDurableMutation, registerDurableMutationSettlementListener } from '../server/durableMutationDispatch'
import {
  MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
  acknowledgePendingMutation,
  isPendingMutationCurrent,
  pendingMutationIntentPayloadByteLength,
  pendingMutationPresetRowProjectionTarget,
  pendingMutationSettingsFieldProjectionTarget,
  recordPendingMutationProjectionTargets,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
} from '../server/pendingMutationOutbox'
import { SETTINGS_BRIDGE_MUTATION_KEY } from '../server/settingsMutationKey'
import {
  createExtractedModelPreset,
  createExtractedPromptPreset,
  databaseKeyForModelPresetField,
  findEquivalentModelPreset,
  hasModelPresetOnlyFields,
  MODEL_PRESET_FIELDS,
  PROMPT_PRESET_FIELDS,
  PROMPT_PRESET_MODEL_OTHERS_OVERRIDE_FIELDS,
  PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS,
  PROMPT_PRESET_MODEL_PARAMETERS_OVERRIDE_KEY,
  promptPresetExportPayload,
  promptPresetOverridesModelParameters,
  repairPromptPresetRecommendedModelPresetReferences,
  resolvePromptPresetRegexField,
} from '../presetSplit'

//APP_VERSION_POINT is to locate the app version in the database file for version bumping
export let appVer = 'Fastify Variant Version: Alpha' //<APP_VERSION_POINT>
export let webAppSubVer = ''

function createClientPresetId() {
  return createNonSecurityUuid()
}

function createClientPromptItemId() {
  return createNonSecurityUuid()
}

export function normalizePromptTemplateIds(data: Pick<Database, 'promptTemplate'>) {
  normalizePromptTemplateRecord(data)
  if (!Array.isArray(data.promptTemplate)) return

  const seen = new Set<string>()
  for (const item of data.promptTemplate) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && item.id.trim() ? item.id : createClientPromptItemId()
    item.id = seen.has(id) ? createClientPromptItemId() : id
    seen.add(item.id)
  }
}

function normalizePromptTemplateRecord(record: unknown): void {
  if (!isPlainRecord(record) || !Object.prototype.hasOwnProperty.call(record, 'promptTemplate')) return
  record.promptTemplate = normalizePromptTemplate(record.promptTemplate)
}

function normalizeNestedPromptTemplates(data: unknown): void {
  if (!isPlainRecord(data)) return
  normalizePromptTemplateRecord(data)
  for (const collection of [data.botPresets, data.promptPresets]) {
    if (!Array.isArray(collection)) continue
    for (const preset of collection) normalizePromptTemplateRecord(preset)
  }
}

export function promptTemplateIdsNeedNormalization(data: Pick<Database, 'promptTemplate'>) {
  if (!Array.isArray(data.promptTemplate)) return false

  const seen = new Set<string>()
  for (const item of data.promptTemplate) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && item.id.trim() ? item.id : null
    if (!id || seen.has(id)) return true
    seen.add(id)
  }

  return false
}

function normalizeModelRoleSettings(data: Partial<Pick<Database, 'modelRoles' | 'seperateModels'>>): void {
  data.modelRoles = normalizeModelRoleOverrides(data.modelRoles)
  data.seperateModels = normalizeLegacySeperateModels(data.seperateModels)
}

function normalizeModelProfileSettings(
  data: Partial<
    Pick<
      Database,
      'providerCredentials' | 'modelProfiles' | 'modelProfileOrder' | 'modelRoleProfiles' | 'modelRuntimeDefaults'
    >
  >,
  providerCredentialSource: 'persisted' | 'projection' = 'persisted',
): void {
  data.providerCredentials =
    providerCredentialSource === 'projection'
      ? normalizeProjectedProviderCredentials(data.providerCredentials)
      : normalizeProviderCredentials(data.providerCredentials)
  data.modelProfiles = normalizeModelProfiles(data.modelProfiles)
  data.modelProfileOrder = normalizeModelProfileOrder(data.modelProfileOrder, data.modelProfiles)
  data.modelRoleProfiles = normalizeModelRoleProfiles(data.modelRoleProfiles)
  data.modelRuntimeDefaults = normalizeModelRuntimeDefaults(data.modelRuntimeDefaults)
}

function normalizeAgentPresetSettings(
  data: Partial<Pick<Database, 'agents' | 'agentPresets' | 'agentPresetDefaultId'>>,
): void {
  const normalized = normalizeAgentConfiguration(data.agents, data.agentPresets)
  data.agents = normalized.agents
  data.agentPresets = normalized.agentPresets
  const agentPresets = normalized.agentPresets
  const defaultId = normalizeAgentPresetDefaultId(data.agentPresetDefaultId, agentPresets)
  if (defaultId) {
    data.agentPresetDefaultId = defaultId
  } else {
    delete data.agentPresetDefaultId
  }
}

function normalizeSeperateParameters(data: Partial<Pick<Database, 'seperateParameters'>>): void {
  const source: Record<string, unknown> = isPlainRecord(data.seperateParameters) ? data.seperateParameters : {}
  data.seperateParameters = {
    memory: normalizeSeperateParameterSlot(source.memory),
    emotion: normalizeSeperateParameterSlot(source.emotion),
    translate: normalizeSeperateParameterSlot(source.translate),
    otherAx: normalizeSeperateParameterSlot(source.otherAx),
    scriptMain: normalizeSeperateParameterSlot(source.scriptMain),
    scriptAux: normalizeSeperateParameterSlot(source.scriptAux),
    overrides: isPlainRecord(source.overrides) ? (source.overrides as Record<string, SeparateParameters>) : {},
  }
}

function normalizeSeperateParameterSlot(value: unknown): SeparateParameters {
  return isPlainRecord(value) ? (value as SeparateParameters) : {}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function settingsOwnerRecord(): Database & Record<string, unknown> {
  return settingsResourceState.value as Database & Record<string, unknown>
}

function legacyPresetOwner(): botPreset[] {
  const presets = collectionsResourceState.values.botPresets
  if (Array.isArray(presets)) return presets as botPreset[]
  collectionsResourceState.values.botPresets = []
  return collectionsResourceState.values.botPresets as botPreset[]
}

function assignLegacyPresetOwner(presets: botPreset[]): void {
  collectionsResourceState.values.botPresets = presets
}

function modelPresetOwner(): ModelPreset[] {
  const presets = collectionsResourceState.values.modelPresets
  if (Array.isArray(presets)) return presets as ModelPreset[]
  collectionsResourceState.values.modelPresets = []
  return collectionsResourceState.values.modelPresets as ModelPreset[]
}

function assignModelPresetOwner(presets: ModelPreset[]): void {
  collectionsResourceState.values.modelPresets = presets
}

function promptPresetOwner(): PromptPreset[] {
  const presets = collectionsResourceState.values.promptPresets
  if (Array.isArray(presets)) return presets as PromptPreset[]
  collectionsResourceState.values.promptPresets = []
  return collectionsResourceState.values.promptPresets as PromptPreset[]
}

function assignPromptPresetOwner(presets: PromptPreset[]): void {
  collectionsResourceState.values.promptPresets = presets
}

function normalizeBotPresetIds(data: Pick<Database, 'botPresets' | 'botPresetsId'>) {
  if (!Array.isArray(data.botPresets)) {
    data.botPresets = []
  }

  const seen = new Set<string>()
  for (const preset of data.botPresets) {
    if (!preset) continue
    normalizePromptTemplateRecord(preset)
    const id = typeof preset.id === 'string' && preset.id.trim() ? preset.id : createClientPresetId()
    const nextId = seen.has(id) ? createClientPresetId() : id
    if (preset.id !== nextId) {
      preset.id = nextId
    }
    seen.add(nextId)
  }

  const nextSelected = normalizedBotPresetsId(data.botPresets.length, data.botPresetsId)
  if (data.botPresetsId !== nextSelected) {
    data.botPresetsId = nextSelected
  }
}

function normalizeSplitPresetIds(
  data: Pick<Database, 'modelPresets' | 'modelPresetsId' | 'promptPresets' | 'promptPresetsId'>,
) {
  normalizePresetCollectionIds(data.modelPresets, (next) => {
    data.modelPresets = next as ModelPreset[]
  })
  data.modelPresetsId = normalizedBotPresetsId(data.modelPresets.length, data.modelPresetsId)
  normalizePresetCollectionIds(data.promptPresets, (next) => {
    data.promptPresets = next as PromptPreset[]
  })
  for (const preset of data.promptPresets) normalizePromptTemplateRecord(preset)
  repairPromptPresetRecommendedModelPresetReferences(data.modelPresets, data.promptPresets)
  data.promptPresetsId = normalizedBotPresetsId(data.promptPresets.length, data.promptPresetsId)
}

function normalizePresetCollectionIds<T extends { id?: string }>(presets: T[], assign: (next: T[]) => void) {
  if (!Array.isArray(presets)) {
    assign([])
    return
  }

  const seen = new Set<string>()
  for (const preset of presets) {
    if (!preset) continue
    const id = typeof preset.id === 'string' && preset.id.trim() ? preset.id : createClientPresetId()
    const nextId = seen.has(id) ? createClientPresetId() : id
    if (preset.id !== nextId) {
      preset.id = nextId
    }
    seen.add(nextId)
  }
}

export function botPresetIdsNeedNormalization(data: Pick<Database, 'botPresets' | 'botPresetsId'>) {
  if (!Array.isArray(data.botPresets)) return true

  const seen = new Set<string>()
  for (const preset of data.botPresets) {
    if (!preset) continue
    const id = typeof preset.id === 'string' && preset.id.trim() ? preset.id : null
    if (!id || seen.has(id)) return true
    seen.add(id)
  }

  return data.botPresetsId !== normalizedBotPresetsId(data.botPresets.length, data.botPresetsId)
}

function legacyPresetNormalizationView(): Pick<Database, 'botPresets' | 'botPresetsId'> {
  return {
    botPresets: legacyPresetOwner(),
    botPresetsId: Number(settingsOwnerRecord().botPresetsId ?? -1),
  }
}

function legacyPresetOwnerIdsNeedNormalization(): boolean {
  return botPresetIdsNeedNormalization(legacyPresetNormalizationView())
}

function normalizeLegacyPresetOwner(): void {
  const owner = legacyPresetNormalizationView()
  normalizeBotPresetIds(owner)
  assignLegacyPresetOwner(owner.botPresets)
  settingsOwnerRecord().botPresetsId = owner.botPresetsId
}

function normalizeSplitPresetOwners(): void {
  const owner: Pick<Database, 'modelPresets' | 'modelPresetsId' | 'promptPresets' | 'promptPresetsId'> = {
    modelPresets: modelPresetOwner(),
    modelPresetsId: Number(settingsOwnerRecord().modelPresetsId ?? -1),
    promptPresets: promptPresetOwner(),
    promptPresetsId: Number(settingsOwnerRecord().promptPresetsId ?? -1),
  }
  normalizeSplitPresetIds(owner)
  assignModelPresetOwner(owner.modelPresets)
  assignPromptPresetOwner(owner.promptPresets)
  settingsOwnerRecord().modelPresetsId = owner.modelPresetsId
  settingsOwnerRecord().promptPresetsId = owner.promptPresetsId
}

function normalizedBotPresetsId(presetCount: number, selected: unknown): number {
  if (!Number.isInteger(selected)) return presetCount > 0 ? 0 : -1

  const index = selected as number
  if (index >= presetCount) return presetCount > 0 ? presetCount - 1 : -1
  if (index < -1) return presetCount > 0 ? 0 : -1
  return index
}

function presetIdAt(index: number): string | null {
  const presets = legacyPresetOwner()
  if (!Number.isInteger(index) || index < 0 || !Array.isArray(presets) || index >= presets.length) {
    return null
  }

  const seen = new Set<string>()
  for (const preset of presets) {
    const id = typeof preset?.id === 'string' && preset.id.trim() ? preset.id : null
    if (!id || seen.has(id)) return null
    seen.add(id)
  }

  return presets[index]?.id ?? null
}

const BOT_PRESET_HYDRATION_SENTINEL_KEYS = [
  'apiType',
  'mainPrompt',
  'jailbreak',
  'globalNote',
  'temperature',
  'modelProfiles',
  'modelProfileOrder',
  'modelRoleProfiles',
  'modelRuntimeDefaults',
  'promptTemplate',
  // Canonical full legacy-preset rows always include this normalized field;
  // collection shells intentionally do not. Unlike an identity marker, this
  // survives the clone/reorder reconciliation paths.
  'localNetworkMode',
] as const

export function botPresetHasHydratedSettings(preset: botPreset | undefined): preset is botPreset {
  if (!preset?.id) return false
  return BOT_PRESET_HYDRATION_SENTINEL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(preset, key))
}

function presetNeedsHydration(preset: botPreset | undefined): boolean {
  return !!preset?.id && !botPresetHasHydratedSettings(preset)
}

const presetHydrationInFlight = new Map<string, Promise<boolean>>()

export async function ensureBotPresetHydrated(index: number): Promise<boolean> {
  const presetId = presetIdAt(index)
  if (!presetId) return false

  return ensureBotPresetHydratedById(presetId)
}

export async function ensureBotPresetHydratedById(presetId: string): Promise<boolean> {
  const presetIndex = canonicalBotPresetIndexById(presetId)
  if (presetIndex < 0) return false

  const preset = legacyPresetOwner()[presetIndex]
  if (!presetNeedsHydration(preset)) return true
  if (!canUseServerResourceReads()) return false

  const current = presetHydrationInFlight.get(presetId)
  if (current) return current

  const baselineRevision = peekCachedServerCommandRevision()
  const targetSnapshot = snapshotJson(preset)
  const request = (async () => {
    const result = await fetchServerLegacyPreset(presetId)
    if (result.status !== 'ok') {
      presetHydrationWarning(presetId, result.status === 'error' ? result.error : 'server resource read unavailable')
      return false
    }
    if (result.presetId !== presetId || result.preset.id !== presetId) {
      presetHydrationWarning(presetId, `response was for preset ${result.presetId}`)
      return false
    }
    if (isOlderThanRevision(result.revision, baselineRevision)) {
      const currentIndex = canonicalBotPresetIndexById(presetId)
      return currentIndex >= 0 && botPresetHasHydratedSettings(legacyPresetOwner()[currentIndex])
    }
    return (() => {
      const currentIndex = canonicalBotPresetIndexById(presetId)
      if (currentIndex < 0) return false
      if (snapshotJson(legacyPresetOwner()[currentIndex]) !== targetSnapshot) {
        return botPresetHasHydratedSettings(legacyPresetOwner()[currentIndex])
      }
      legacyPresetOwner()[currentIndex] = result.preset as unknown as botPreset
      return true
    })()
  })().finally(() => {
    if (presetHydrationInFlight.get(presetId) === request) {
      presetHydrationInFlight.delete(presetId)
    }
  })

  presetHydrationInFlight.set(presetId, request)
  return request
}

function canonicalBotPresetIndexById(presetId: string): number {
  if (typeof presetId !== 'string' || presetId.trim() === '') return -1
  const presets = legacyPresetOwner()
  if (!Array.isArray(presets)) return -1
  let targetIndex = -1
  const seen = new Set<string>()
  for (let index = 0; index < presets.length; index += 1) {
    const candidateId = presets[index]?.id
    if (typeof candidateId !== 'string' || candidateId.trim() === '' || seen.has(candidateId)) return -1
    seen.add(candidateId)
    if (candidateId === presetId) targetIndex = index
  }
  return targetIndex
}

function isOlderThanRevision(revision: number, comparisonRevision: number | null): boolean {
  return comparisonRevision !== null && revision < comparisonRevision
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

function presetHydrationWarning(presetId: string, message: string): void {
  console.warn(`preset ${presetId} hydration failed: ${message}`)
}

const SET_PRESET_ROLLBACK_KEYS = [
  'apiType',
  'localNetworkMode',
  'localNetworkTimeoutSec',
  'mainPrompt',
  'jailbreak',
  'globalNote',
  'temperature',
  'maxContext',
  'maxResponse',
  'frequencyPenalty',
  'PresensePenalty',
  'formatingOrder',
  'aiModel',
  'subModel',
  'modelRoles',
  'modelProfiles',
  'modelProfileOrder',
  'modelRoleProfiles',
  'modelRuntimeDefaults',
  'agents',
  'agentPresets',
  'agentPresetDefaultId',
  'currentPluginProvider',
  'textgenWebUIStreamURL',
  'textgenWebUIBlockingURL',
  'forceReplaceUrl',
  'promptPreprocess',
  'bias',
  'koboldURL',
  'proxyKey',
  'ooba',
  'ainconfig',
  'openrouterRequestModel',
  'proxyRequestModel',
  'NAIsettings',
  'autoSuggestPrompt',
  'autoSuggestPrefix',
  'autoSuggestClean',
  'promptTemplate',
  'NAIadventure',
  'NAIappendName',
  'localStopStrings',
  'customProxyRequestModel',
  'reverseProxyOobaArgs',
  'top_p',
  'promptSettings',
  'repetition_penalty',
  'min_p',
  'top_a',
  'openrouterProvider',
  'useInstructPrompt',
  'customPromptTemplateToggle',
  'templateDefaultVariables',
  'moduleIntergration',
  'top_k',
  'instructChatTemplate',
  'JinjaTemplate',
  'jsonSchemaEnabled',
  'jsonSchema',
  'strictJsonSchema',
  'extractJson',
  'seperateParametersEnabled',
  'customAPIFormat',
  'systemContentReplacement',
  'systemRoleReplacement',
  'customFlags',
  'enableCustomFlags',
  'presetRegex',
  'reasoningEffort',
  'thinkingTokens',
  'thinkingType',
  'deepseekThinkingType',
  'adaptiveThinkingEffort',
  'deepseekReasoningEffort',
  'outputImageModal',
  'seperateModelsForAxModels',
  'seperateModels',
  'fallbackModels',
  'fallbackWhenBlankResponse',
  'seperateParameters',
  'modelTools',
  'verbosity',
  'dynamicOutput',
] as const satisfies readonly (keyof Database)[]

type SetPresetRollbackKey = (typeof SET_PRESET_ROLLBACK_KEYS)[number]

function snapshotSetPresetSettings(db: Database): Partial<Record<SetPresetRollbackKey, unknown>> {
  const snapshot: Partial<Record<SetPresetRollbackKey, unknown>> = {}
  const dbRecord = db as unknown as Record<SetPresetRollbackKey, unknown>
  for (const key of SET_PRESET_ROLLBACK_KEYS) {
    snapshot[key] = safeStructuredClone(dbRecord[key])
  }
  return snapshot
}

function recordPresetSelectionProjectionTargets(
  handle: PendingMutationHandle,
  previous: Partial<Record<SetPresetRollbackKey, unknown>>,
  attempted: Partial<Record<SetPresetRollbackKey, unknown>>,
): void {
  recordPendingMutationProjectionTargets(
    handle,
    SET_PRESET_ROLLBACK_KEYS.filter((key) => snapshotJson(previous[key]) !== snapshotJson(attempted[key])).map(
      pendingMutationSettingsFieldProjectionTarget,
    ),
  )
}

type SplitPresetKind = 'model' | 'prompt'
type SplitPresetRow = ModelPreset | PromptPreset

interface SplitPresetPatchFieldAttempt {
  previousPresent: boolean
  previousValue: unknown
  durableAttemptedPresent: boolean
  durableAttemptedValue: unknown
  attemptedPresent: boolean
  attemptedValue: unknown
}

interface PendingSplitPresetPatch {
  sequence: number
  kind: SplitPresetKind
  presetId: string
  fields: Map<string, SplitPresetPatchFieldAttempt>
  projectionFields: Map<string, SplitPresetPatchFieldAttempt>
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  selectedPresetId: string | null
  selectedPromptPresetId: string | null
  promptOwnerProjectionEpoch: number | null
  promptOwnerRevision: number | null
  durableFieldNames: Set<string>
  durableProjectionFieldNames: Set<string>
  correctionOnly: boolean
  intent: DurableMutationIntent | null
  outbox: PendingMutationHandle | null
  timer: ReturnType<typeof setTimeout> | null
  outcomeResolvers: Array<(outcome: PresetMutationOutcome) => void>
  settled: false
}

interface DispatchedSplitPresetPatch {
  sequence: number
  kind: SplitPresetKind
  presetId: string
  fields: Map<string, SplitPresetPatchFieldAttempt>
  projectionFields: Map<string, SplitPresetPatchFieldAttempt>
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  selectedPresetId: string | null
  selectedPromptPresetId: string | null
  promptOwnerProjectionEpoch: number | null
  promptOwnerRevision: number | null
  selectedProjectionExpected: boolean
  ownerProjectionExpected: boolean
  outbox: PendingMutationHandle
  outcomeResolvers: Array<(outcome: PresetMutationOutcome) => void>
  finalSettlement: PresetMutationFinalSettlement
  settlementCleanup?: () => void
  retired: boolean
  settled: boolean
}

const SPLIT_PRESET_PATCH_DELAY_MS = 250
const pendingSplitPresetPatches = new Map<string, PendingSplitPresetPatch>()
const unsettledSplitPresetPatches = new Map<string, DispatchedSplitPresetPatch[]>()
const modelPresetFieldNames = new Set<string>(MODEL_PRESET_FIELDS)
const promptPresetFieldNames = new Set<string>(PROMPT_PRESET_FIELDS)
const promptPresetModelParameterFieldNames = new Set<string>(PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS)
const promptPresetModelOthersFieldNames = new Set<string>(PROMPT_PRESET_MODEL_OTHERS_OVERRIDE_FIELDS)

interface BotPresetFieldRollback {
  presetId: string
  previous: Record<string, unknown>
  attempted: Record<string, unknown>
}

interface LegacyPresetSparseSaveBaseline {
  preset: Record<string, unknown>
}

interface BotPresetSelectionRollback {
  previousSelectedId: string | null
  attemptedSelectedId: string | null
  previousSettings?: Partial<Record<SetPresetRollbackKey, unknown>>
  attemptedSettings?: Partial<Record<SetPresetRollbackKey, unknown>>
}

interface SplitPresetListRollbackEntry {
  key: string
  previous: SplitPresetRow | null
  attempted: SplitPresetRow | null
  previousIndex?: number
}

interface SplitPresetSelectionRollback {
  kind: SplitPresetKind
  previousSelectedId: string | null
  attemptedSelectedId: string | null
  previousSettings: Partial<Record<SetPresetRollbackKey, unknown>>
  attemptedSettings: Partial<Record<SetPresetRollbackKey, unknown>>
}

type PresetRowKind = 'legacy' | SplitPresetKind
type PresetRow = botPreset | SplitPresetRow

interface PresetRowMutationEntry {
  kind: PresetRowKind
  key: string
  previous: PresetRow | null
  attempted: PresetRow | null
  previousIndex?: number
}

interface PresetSelectionMutation {
  kind: PresetRowKind
  previousSelectedId: string | null
  attemptedSelectedId: string | null
  previousSettings?: Partial<Record<SetPresetRollbackKey, unknown>>
  attemptedSettings?: Partial<Record<SetPresetRollbackKey, unknown>>
}

interface PresetRowMutationAttempt {
  sequence: number
  entries: PresetRowMutationEntry[]
  selection?: PresetSelectionMutation
  outbox: PendingMutationHandle | null
  finalSettlement?: PresetMutationFinalSettlement
  retirement?: () => void
  settlementCleanup?: () => void
  retired: boolean
  settled: boolean
}

interface PresetReorderMutationAttempt {
  sequence: number
  kind: PresetRowKind
  previousPresetIds: string[]
  attemptedPresetIds: string[]
  outbox: PendingMutationHandle | null
  finalSettlement?: PresetMutationFinalSettlement
  retirement?: () => void
  settlementCleanup?: () => void
  retired: boolean
  settled: boolean
}

type PreparedPresetMutation =
  | { status: 'plain' }
  | { status: 'durable'; handle: PendingMutationHandle; intent: DurableMutationIntent }
  | { status: 'failed' }

export type PresetMutationFinalStatus = 'accepted' | 'failed'
export type PresetMutationOutcome =
  | { status: 'accepted' }
  | { status: 'queued'; settlement: Promise<PresetMutationFinalStatus> }
  | { status: 'failed' }

interface PresetMutationFinalSettlement {
  promise: Promise<PresetMutationFinalStatus>
  resolve: (status: PresetMutationFinalStatus) => void
}

const PRESET_MUTATION_KEY = 'preset-operations'
let nextPresetMutationSequence = 0
const unsettledPresetRowMutationAttempts: PresetRowMutationAttempt[] = []
const unsettledPresetReorderMutationAttempts: PresetReorderMutationAttempt[] = []
const activeImportedSplitPresetOwnerKeys = new Map<SplitPresetKind, Set<string>>([
  ['model', new Set()],
  ['prompt', new Set()],
])

function createPresetMutationFinalSettlement(): PresetMutationFinalSettlement {
  let resolve!: (status: PresetMutationFinalStatus) => void
  const promise = new Promise<PresetMutationFinalStatus>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function waitForPendingSplitPresetOutcome(pending: PendingSplitPresetPatch): Promise<PresetMutationOutcome> {
  return new Promise((resolve) => pending.outcomeResolvers.push(resolve))
}

function resolvePendingSplitPresetOutcome(pending: PendingSplitPresetPatch, outcome: PresetMutationOutcome): void {
  for (const resolve of pending.outcomeResolvers.splice(0)) resolve(outcome)
}

function resolveDispatchedSplitPresetOutcome(
  attempt: DispatchedSplitPresetPatch,
  status: PresetMutationOutcome['status'],
): void {
  const outcome: PresetMutationOutcome =
    status === 'queued'
      ? { status, settlement: attempt.finalSettlement.promise }
      : status === 'accepted'
        ? { status }
        : { status }
  for (const resolve of attempt.outcomeResolvers.splice(0)) resolve(outcome)
}

function splitPresetPatchKey(kind: SplitPresetKind, presetId: string): string {
  return `${kind}:${presetId}`
}

export function splitPresetMutationKey(kind: SplitPresetKind, presetId: string): string {
  return kind === 'prompt' ? promptTemplateOwnerMutationKey(presetId) : `split-preset:model:${presetId}`
}

function splitPresetMutationDependencyKeys(
  kind: SplitPresetKind,
  ...presetIds: Array<string | null | undefined>
): string[] {
  return Array.from(
    new Set([
      PRESET_MUTATION_KEY,
      ...presetIds
        .filter((presetId): presetId is string => typeof presetId === 'string' && presetId.trim() !== '')
        .map((presetId) => splitPresetMutationKey(kind, presetId)),
    ]),
  )
}

function activeSplitPresetOwnerMutationKeys(kinds: readonly SplitPresetKind[]): string[] {
  const requestedKinds = new Set(kinds)
  const keys = new Set<string>()
  for (const pending of pendingSplitPresetPatches.values()) {
    if (requestedKinds.has(pending.kind) && pending.outbox) keys.add(pending.outbox.key)
  }
  for (const attempts of unsettledSplitPresetPatches.values()) {
    for (const attempt of attempts) {
      if (requestedKinds.has(attempt.kind) && !attempt.settled) keys.add(attempt.outbox.key)
    }
  }
  for (const attempt of unsettledPresetRowMutationAttempts) {
    if (attempt.settled || !attempt.outbox || attempt.outbox.key === PRESET_MUTATION_KEY) continue
    if (attempt.entries.some((entry) => entry.kind !== 'legacy' && requestedKinds.has(entry.kind))) {
      keys.add(attempt.outbox.key)
    }
  }
  for (const kind of requestedKinds) {
    for (const key of activeImportedSplitPresetOwnerKeys.get(kind) ?? []) keys.add(key)
  }
  return [...keys]
}

function activeLegacyPresetOperationDependencyKeys(): string[] {
  const hasActiveOwner =
    unsettledPresetRowMutationAttempts.some(
      (attempt) => !attempt.settled && attempt.outbox?.key === PRESET_MUTATION_KEY,
    ) ||
    unsettledPresetReorderMutationAttempts.some(
      (attempt) => !attempt.settled && attempt.outbox?.key === PRESET_MUTATION_KEY,
    )
  return hasActiveOwner ? [PRESET_MUTATION_KEY] : []
}

function cloneSplitPresetPatchFieldAttempt(field: SplitPresetPatchFieldAttempt): SplitPresetPatchFieldAttempt {
  return {
    previousPresent: field.previousPresent,
    previousValue: safeStructuredClone(field.previousValue),
    durableAttemptedPresent: field.durableAttemptedPresent,
    durableAttemptedValue: safeStructuredClone(field.durableAttemptedValue),
    attemptedPresent: field.attemptedPresent,
    attemptedValue: safeStructuredClone(field.attemptedValue),
  }
}

function queueSplitPresetPatch(
  kind: SplitPresetKind,
  presetId: string,
  preset: Record<string, unknown>,
  patch: Record<string, unknown>,
): PendingSplitPresetPatch | null {
  if (!canUseServerCommands()) return null

  const pendingKey = splitPresetPatchKey(kind, presetId)
  let pending = pendingSplitPresetPatches.get(pendingKey)
  let createdPending = false
  if (!pending) {
    const selectedPresetId = currentSplitPresetSelectedId(kind)
    const selectedPromptPresetId = currentSplitPresetSelectedId('prompt')
    const capturesPromptOwner = kind === 'prompt' && selectedPresetId === presetId
    pending = {
      sequence: reservePresetMutationSequence(),
      kind,
      presetId,
      fields: new Map(),
      projectionFields: new Map(),
      collectionProjectionEpoch: captureCollectionProjectionEpoch(kind === 'model' ? 'modelPresets' : 'promptPresets'),
      settingsProjectionEpoch: captureSettingsProjectionEpoch(),
      selectedPresetId,
      selectedPromptPresetId,
      promptOwnerProjectionEpoch: capturesPromptOwner ? capturePromptTemplateOwnerProjectionEpoch(presetId) : null,
      promptOwnerRevision: capturesPromptOwner ? peekPromptTemplateOwnerRevision(presetId) : null,
      durableFieldNames: new Set(),
      durableProjectionFieldNames: new Set(),
      correctionOnly: false,
      intent: null,
      outbox: null,
      timer: null,
      outcomeResolvers: [],
      settled: false,
    }
    pendingSplitPresetPatches.set(pendingKey, pending)
    createdPending = true
  }

  let desiredChanged = false
  for (const [fieldName, attemptedValue] of Object.entries(patch)) {
    if (fieldName === 'id') continue
    const existing = pending.fields.get(fieldName)
    if (existing) {
      if (
        !splitPresetPatchFieldValuesDiffer(existing.attemptedPresent, existing.attemptedValue, true, attemptedValue)
      ) {
        continue
      }
      desiredChanged = true
      existing.attemptedPresent = true
      existing.attemptedValue = safeStructuredClone(attemptedValue)
      continue
    }
    const previousPresent = Object.prototype.hasOwnProperty.call(preset, fieldName)
    const previousValue = safeStructuredClone(preset[fieldName])
    if (!splitPresetPatchFieldValuesDiffer(previousPresent, previousValue, true, attemptedValue)) continue
    desiredChanged = true
    pending.fields.set(fieldName, {
      previousPresent,
      previousValue,
      durableAttemptedPresent: previousPresent,
      durableAttemptedValue: safeStructuredClone(previousValue),
      attemptedPresent: true,
      attemptedValue: safeStructuredClone(attemptedValue),
    })
  }

  if (!desiredChanged) {
    if (createdPending) {
      pendingSplitPresetPatches.delete(pendingKey)
      return null
    }
    return pending
  }
  return pending
}

function captureSplitPresetProjectionFields(
  kind: SplitPresetKind,
  patch: Record<string, unknown>,
): Map<string, SplitPresetPatchFieldAttempt> {
  const projectionFields = new Map<string, SplitPresetPatchFieldAttempt>()
  const database = settingsOwnerRecord()
  for (const fieldName of splitPresetProjectionFieldNames(kind, patch)) {
    const previousPresent = Object.prototype.hasOwnProperty.call(database, fieldName)
    const previousValue = safeStructuredClone(database[fieldName])
    projectionFields.set(fieldName, {
      previousPresent,
      previousValue,
      durableAttemptedPresent: previousPresent,
      durableAttemptedValue: safeStructuredClone(previousValue),
      attemptedPresent: false,
      attemptedValue: undefined,
    })
  }
  return projectionFields
}

function splitPresetProjectionFieldNames(kind: SplitPresetKind, patch: Record<string, unknown>): Set<string> {
  const fieldNames = new Set<string>()
  if (kind === 'model') {
    for (const fieldName of Object.keys(patch)) {
      if (modelPresetFieldNames.has(fieldName)) {
        fieldNames.add(databaseKeyForModelPresetField(fieldName))
      }
    }
    return fieldNames
  }

  for (const fieldName of Object.keys(patch)) {
    if (fieldName === 'regex' || fieldName === 'presetRegex') {
      fieldNames.add('presetRegex')
    } else if (fieldName !== 'promptTemplate' && promptPresetFieldNames.has(fieldName)) {
      // A modern prompt template is owned by the preset row. It is tracked by
      // owner acknowledgement metadata, not as a selected aggregate mirror.
      fieldNames.add(fieldName)
    }
    if (promptPresetModelParameterFieldNames.has(fieldName) || promptPresetModelOthersFieldNames.has(fieldName)) {
      fieldNames.add(databaseKeyForModelPresetField(fieldName))
    }
    if (fieldName === PROMPT_PRESET_MODEL_PARAMETERS_OVERRIDE_KEY) {
      for (const parameterFieldName of PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS) {
        fieldNames.add(databaseKeyForModelPresetField(parameterFieldName))
      }
    }
  }
  return fieldNames
}

function recordSplitPresetProjectionFields(
  pending: PendingSplitPresetPatch | null,
  previousFields: Map<string, SplitPresetPatchFieldAttempt>,
): void {
  if (!pending) return
  const database = settingsOwnerRecord()
  for (const [fieldName, previousField] of previousFields) {
    const attemptedPresent = Object.prototype.hasOwnProperty.call(database, fieldName)
    const existing = pending.projectionFields.get(fieldName)
    if (existing) {
      existing.attemptedPresent = attemptedPresent
      existing.attemptedValue = safeStructuredClone(database[fieldName])
      continue
    }
    pending.projectionFields.set(fieldName, {
      previousPresent: previousField.previousPresent,
      previousValue: previousField.previousValue,
      durableAttemptedPresent: previousField.previousPresent,
      durableAttemptedValue: safeStructuredClone(previousField.previousValue),
      attemptedPresent,
      attemptedValue: safeStructuredClone(database[fieldName]),
    })
  }
}

function schedulePendingSplitPresetPatch(pending: PendingSplitPresetPatch): void {
  const pendingKey = splitPresetPatchKey(pending.kind, pending.presetId)
  const durability = refreshPendingSplitPresetDurability(pending)
  if (pending.timer) clearTimeout(pending.timer)
  pending.timer = null

  if (durability === 'none') {
    if (pendingSplitPresetPatches.get(pendingKey) === pending) {
      pendingSplitPresetPatches.delete(pendingKey)
    }
    resolvePendingSplitPresetOutcome(pending, { status: 'accepted' })
    return
  }
  if (durability === 'correction') {
    flushPendingSplitPresetPatch(pending.kind, pending.presetId)
    return
  }
  pending.timer = setTimeout(
    () => flushPendingSplitPresetPatch(pending.kind, pending.presetId),
    SPLIT_PRESET_PATCH_DELAY_MS,
  )
}

export function flushPendingSplitPresetPatch(
  kind: SplitPresetKind,
  presetId: string,
  options: ServerCommandTransportOptions = {},
): void {
  const pendingKey = splitPresetPatchKey(kind, presetId)
  const pending = pendingSplitPresetPatches.get(pendingKey)
  if (!pending) return

  pendingSplitPresetPatches.delete(pendingKey)
  if (pending.timer) clearTimeout(pending.timer)
  pending.timer = null
  dispatchSplitPresetPatch(pending, options)
}

function flushPendingSplitPresetPatchesForKind(
  kind: SplitPresetKind,
  options: ServerCommandTransportOptions = {},
): void {
  for (const pending of Array.from(pendingSplitPresetPatches.values())) {
    if (pending.kind === kind) {
      flushPendingSplitPresetPatch(kind, pending.presetId, options)
    }
  }
}

export function flushPendingSplitPresetPatches(options: ServerCommandTransportOptions = {}): void {
  for (const pending of Array.from(pendingSplitPresetPatches.values())) {
    flushPendingSplitPresetPatch(pending.kind, pending.presetId, options)
  }
}

registerPendingOwnerMutationFlusher('split-preset-fields', flushPendingSplitPresetPatches)
registerPendingOwnerResetter('preset-mutations', resetPendingPresetMutationsForDatabaseReplacement)

function splitPresetPatchPayload(
  fields: Map<string, SplitPresetPatchFieldAttempt>,
  include: (field: SplitPresetPatchFieldAttempt) => boolean = splitPresetPatchFieldIsNetChange,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [fieldName, field] of fields) {
    if (!include(field) || !field.attemptedPresent) continue
    patch[fieldName] = safeStructuredClone(field.attemptedValue)
  }
  return patch
}

function splitPresetPatchDurableClosureFieldNames(fields: Map<string, SplitPresetPatchFieldAttempt>): Set<string> {
  const fieldNames = new Set<string>()
  for (const [fieldName, field] of fields) {
    if (splitPresetPatchFieldIsDurableClosure(field)) fieldNames.add(fieldName)
  }
  return fieldNames
}

function markSplitPresetPatchFieldsDurablyAttempted(fields: Map<string, SplitPresetPatchFieldAttempt>): void {
  for (const field of fields.values()) {
    field.durableAttemptedPresent = field.attemptedPresent
    field.durableAttemptedValue = safeStructuredClone(field.attemptedValue)
  }
}

function splitPresetPatchDurableIntent(
  kind: SplitPresetKind,
  presetId: string,
  patch: Record<string, unknown>,
): DurableMutationIntent {
  const dependencyKeys = activeLegacyPresetOperationDependencyKeys()
  return {
    version: 1,
    ...(dependencyKeys.length > 0 ? { dependencyKeys } : {}),
    requests: [
      {
        method: 'PATCH',
        path: `/${kind === 'model' ? 'model-presets' : 'prompt-presets'}/${encodeURIComponent(presetId)}`,
        body: { patch: safeStructuredClone(patch) },
      },
    ],
  }
}

function refreshPendingSplitPresetDurability(pending: PendingSplitPresetPatch): 'none' | 'correction' | 'net' {
  const netPatch = splitPresetPatchPayload(pending.fields)
  const patch = splitPresetPatchPayload(pending.fields, splitPresetPatchFieldIsDurableClosure)
  if (Object.keys(patch).length === 0) {
    if (pending.outbox) void acknowledgePendingMutation(pending.outbox)
    pending.durableFieldNames.clear()
    pending.durableProjectionFieldNames.clear()
    pending.correctionOnly = false
    pending.intent = null
    pending.outbox = null
    return 'none'
  }
  const intent = splitPresetPatchDurableIntent(pending.kind, pending.presetId, patch)
  pending.intent = intent
  pending.outbox = stagePendingMutation(splitPresetMutationKey(pending.kind, pending.presetId), intent, pending.outbox)
  pending.durableFieldNames = splitPresetPatchDurableClosureFieldNames(pending.fields)
  pending.durableProjectionFieldNames = splitPresetPatchDurableClosureFieldNames(pending.projectionFields)
  pending.correctionOnly = Object.keys(netPatch).length === 0
  markSplitPresetPatchFieldsDurablyAttempted(pending.fields)
  markSplitPresetPatchFieldsDurablyAttempted(pending.projectionFields)
  return pending.correctionOnly ? 'correction' : 'net'
}

function dispatchSplitPresetPatch(pending: PendingSplitPresetPatch, options: ServerCommandTransportOptions): void {
  const fields = new Map<string, SplitPresetPatchFieldAttempt>()
  const patch: Record<string, unknown> = {}
  for (const [fieldName, field] of pending.fields) {
    if (!pending.durableFieldNames.has(fieldName) || !field.attemptedPresent) continue
    fields.set(fieldName, cloneSplitPresetPatchFieldAttempt(field))
    patch[fieldName] = safeStructuredClone(field.attemptedValue)
  }
  if (fields.size === 0 || !pending.intent || !pending.outbox) {
    resolvePendingSplitPresetOutcome(pending, { status: 'accepted' })
    return
  }

  const projectionFields = new Map<string, SplitPresetPatchFieldAttempt>()
  for (const [fieldName, field] of pending.projectionFields) {
    if (!pending.durableProjectionFieldNames.has(fieldName)) continue
    projectionFields.set(fieldName, cloneSplitPresetPatchFieldAttempt(field))
  }

  const attemptedSettings = Object.fromEntries(
    Array.from(projectionFields.entries())
      .filter(
        ([fieldName, field]) =>
          field.attemptedPresent && !(pending.kind === 'prompt' && fieldName === 'promptTemplate'),
      )
      .map(([fieldName, field]) => [fieldName, safeStructuredClone(field.attemptedValue)]),
  )
  const selectedProjectionExpected =
    pending.selectedPresetId === pending.presetId && Object.keys(attemptedSettings).length > 0
  const livePreset = splitPresetList(pending.kind).find((preset) => preset?.id === pending.presetId) as
    | Record<string, unknown>
    | undefined
  if (!livePreset) {
    void acknowledgePendingMutation(pending.outbox)
    resolvePendingSplitPresetOutcome(pending, { status: 'failed' })
    return
  }
  const ownerProjectionExpected =
    pending.kind === 'prompt' &&
    pending.selectedPresetId === pending.presetId &&
    Object.prototype.hasOwnProperty.call(patch, 'promptTemplate') &&
    Object.prototype.hasOwnProperty.call(livePreset, 'promptTemplate')

  const finalSettlement = createPresetMutationFinalSettlement()
  const attempt: DispatchedSplitPresetPatch = {
    sequence: pending.sequence,
    kind: pending.kind,
    presetId: pending.presetId,
    fields,
    projectionFields,
    collectionProjectionEpoch: pending.collectionProjectionEpoch,
    settingsProjectionEpoch: pending.settingsProjectionEpoch,
    selectedPresetId: pending.selectedPresetId,
    selectedPromptPresetId: pending.selectedPromptPresetId,
    promptOwnerProjectionEpoch: pending.promptOwnerProjectionEpoch,
    promptOwnerRevision: pending.promptOwnerRevision,
    selectedProjectionExpected,
    ownerProjectionExpected,
    outbox: pending.outbox,
    outcomeResolvers: pending.outcomeResolvers.splice(0),
    finalSettlement,
    retired: false,
    settled: false,
  }
  const optimisticAcknowledgement: SplitPresetPatchOptimisticAcknowledgement = {
    collectionProjectionEpoch: attempt.collectionProjectionEpoch,
    settingsProjectionEpoch: attempt.settingsProjectionEpoch,
    selectedPresetId: attempt.selectedPresetId,
    selectedPromptPresetId: attempt.selectedPromptPresetId,
    attemptedSettings,
    selectedProjectionExpected,
    ownerProjectionExpected,
    ...(ownerProjectionExpected && attempt.promptOwnerProjectionEpoch !== null
      ? { promptOwnerProjectionEpoch: attempt.promptOwnerProjectionEpoch }
      : {}),
    ...(ownerProjectionExpected && attempt.promptOwnerRevision !== null
      ? { promptOwnerRevision: attempt.promptOwnerRevision }
      : {}),
  }
  const pendingKey = splitPresetPatchKey(attempt.kind, attempt.presetId)
  const unsettled = unsettledSplitPresetPatches.get(pendingKey) ?? []
  unsettled.push(attempt)
  unsettledSplitPresetPatches.set(pendingKey, unsettled)
  attempt.settlementCleanup = registerDurableMutationSettlementListener(attempt.outbox.mutationId, (settlement) => {
    if (attempt.settled) return
    if (settlement === 'accepted') {
      settleSplitPresetPatchAttempt(attempt, true)
      return
    }
    taintSplitPresetPatchAttempt(attempt)
    settleSplitPresetPatchAttempt(attempt, false)
    rollbackSplitPresetPatchAttempt(attempt)
  })

  const dispatch = dispatchDurableMutation(pending.outbox, pending.intent, (transport) =>
    runServerCommand({
      command: async (baseRevision) => {
        const result =
          attempt.kind === 'model'
            ? await updateModelPresetCommand(
                {
                  baseRevision,
                  modelPresetId: attempt.presetId,
                  patch: safeStructuredClone(patch) as ModelPresetSnapshot,
                  optimisticAcknowledgement,
                },
                options.signal,
                options.keepalive,
              )
            : await updatePromptPresetCommand(
                {
                  baseRevision,
                  promptPresetId: attempt.presetId,
                  patch: safeStructuredClone(patch) as PromptPresetSnapshot,
                  optimisticAcknowledgement,
                },
                options.signal,
                options.keepalive,
              )
        if (result.status === 'ok') settleSplitPresetPatchAttempt(attempt, true)
        return result
      },
      rollback: () => {
        if (attempt.settled) return
        taintSplitPresetPatchAttempt(attempt)
        settleSplitPresetPatchAttempt(attempt, false)
        rollbackSplitPresetPatchAttempt(attempt)
      },
      signal: options.signal,
      keepalive: options.keepalive,
      ...transport,
    }),
  )
  void dispatch
    .then(async (result) => {
      if (result.status === 'ok' || attempt.settled) return
      const persisted = (await attempt.outbox.ready) === 'persisted'
      if (attempt.settled) return
      const current = persisted && (await isPendingMutationCurrent(attempt.outbox))
      if (attempt.settled) return
      if (current) {
        reapplyPendingPresetProjections()
        resolveDispatchedSplitPresetOutcome(attempt, 'queued')
        return
      }
      taintSplitPresetPatchAttempt(attempt)
      settleSplitPresetPatchAttempt(attempt, false)
      rollbackSplitPresetPatchAttempt(attempt)
    })
    .catch(async (error) => {
      if (attempt.settled) return
      const persisted = (await attempt.outbox.ready) === 'persisted'
      if (attempt.settled) return
      const current = persisted && (await isPendingMutationCurrent(attempt.outbox))
      if (attempt.settled) return
      if (current) {
        reapplyPendingPresetProjections()
        resolveDispatchedSplitPresetOutcome(attempt, 'queued')
        return
      }
      taintSplitPresetPatchAttempt(attempt)
      settleSplitPresetPatchAttempt(attempt, false)
      rollbackSplitPresetPatchAttempt(attempt)
      console.error('Split preset patch command rejected:', error)
    })
}

function taintSplitPresetPatchAttempt(attempt: DispatchedSplitPresetPatch): void {
  markCollectionAcknowledgementTainted(attempt.kind === 'model' ? 'modelPresets' : 'promptPresets')
  if (attempt.selectedProjectionExpected) markSettingsAcknowledgementTainted()
  if (attempt.ownerProjectionExpected) markPromptTemplateOwnerAcknowledgementTainted(attempt.presetId)
}

function splitPresetPatchFieldIsNetChange(field: SplitPresetPatchFieldAttempt): boolean {
  return splitPresetPatchFieldValuesDiffer(
    field.previousPresent,
    field.previousValue,
    field.attemptedPresent,
    field.attemptedValue,
  )
}

function splitPresetPatchFieldIsDurableClosure(field: SplitPresetPatchFieldAttempt): boolean {
  return (
    splitPresetPatchFieldIsNetChange(field) ||
    splitPresetPatchFieldValuesDiffer(
      field.durableAttemptedPresent,
      field.durableAttemptedValue,
      field.attemptedPresent,
      field.attemptedValue,
    )
  )
}

function splitPresetPatchFieldValuesDiffer(
  leftPresent: boolean,
  leftValue: unknown,
  rightPresent: boolean,
  rightValue: unknown,
): boolean {
  if (leftPresent !== rightPresent) return true
  if (!leftPresent) return false
  return jsonSnapshot(leftValue) !== jsonSnapshot(rightValue)
}

function settleSplitPresetPatchAttempt(attempt: DispatchedSplitPresetPatch, accepted: boolean): void {
  if (attempt.settled) return
  attempt.settled = true
  const status = accepted ? 'accepted' : 'failed'
  resolveDispatchedSplitPresetOutcome(attempt, status)
  attempt.finalSettlement.resolve(status)
  attempt.settlementCleanup?.()
  attempt.settlementCleanup = undefined

  const pendingKey = splitPresetPatchKey(attempt.kind, attempt.presetId)
  const unsettled = unsettledSplitPresetPatches.get(pendingKey) ?? []
  const attemptIndex = unsettled.indexOf(attempt)
  const laterAttempts = attemptIndex < 0 ? [] : unsettled.slice(attemptIndex + 1)
  for (const laterAttempt of laterAttempts) {
    rebaseSplitPresetPatchFields(laterAttempt.fields, attempt.fields, accepted)
    rebaseSplitPresetPatchFields(laterAttempt.projectionFields, attempt.projectionFields, accepted)
  }
  const pending = pendingSplitPresetPatches.get(pendingKey)
  if (pending) {
    rebaseSplitPresetPatchFields(pending.fields, attempt.fields, accepted)
    rebaseSplitPresetPatchFields(pending.projectionFields, attempt.projectionFields, accepted)
    schedulePendingSplitPresetPatch(pending)
  }

  if (attemptIndex >= 0) unsettled.splice(attemptIndex, 1)
  if (unsettled.length === 0) {
    unsettledSplitPresetPatches.delete(pendingKey)
  }
}

function rebaseSplitPresetPatchFields(
  target: Map<string, SplitPresetPatchFieldAttempt>,
  settled: Map<string, SplitPresetPatchFieldAttempt>,
  accepted: boolean,
): void {
  for (const [fieldName, settledField] of settled) {
    const targetField = target.get(fieldName)
    if (!targetField) continue
    targetField.previousPresent = accepted ? true : settledField.previousPresent
    targetField.previousValue = safeStructuredClone(accepted ? settledField.attemptedValue : settledField.previousValue)
  }
}

function rollbackSplitPresetPatchAttempt(attempt: DispatchedSplitPresetPatch): void {
  ;(() => {
    const collectionName = attempt.kind === 'model' ? 'modelPresets' : 'promptPresets'
    if (!hasCollectionProjectionEpochChanged(collectionName, attempt.collectionProjectionEpoch)) {
      const presets = splitPresetList(attempt.kind)
      const index = presets.findIndex((preset) => preset?.id === attempt.presetId)
      if (index >= 0) {
        const preset = presets[index] as Record<string, unknown>
        for (const [fieldName, field] of attempt.fields) {
          const livePresent = Object.prototype.hasOwnProperty.call(preset, fieldName)
          if (
            splitPresetPatchFieldValuesDiffer(
              livePresent,
              preset[fieldName],
              field.attemptedPresent,
              field.attemptedValue,
            )
          ) {
            continue
          }
          if (field.previousPresent) {
            preset[fieldName] = safeStructuredClone(field.previousValue)
          } else {
            delete preset[fieldName]
          }
        }
      }
    }

    if (hasSettingsProjectionEpochChanged(attempt.settingsProjectionEpoch)) return
    if (currentSplitPresetSelectedId(attempt.kind) !== attempt.presetId) return
    if (attempt.kind === 'model' && currentSplitPresetSelectedId('prompt') !== attempt.selectedPromptPresetId) return
    const database = settingsOwnerRecord()
    for (const [fieldName, field] of attempt.projectionFields) {
      if (
        attempt.kind === 'prompt' &&
        fieldName === 'promptTemplate' &&
        attempt.promptOwnerProjectionEpoch !== null &&
        hasPromptTemplateOwnerProjectionEpochChanged(attempt.presetId, attempt.promptOwnerProjectionEpoch)
      ) {
        continue
      }
      const livePresent = Object.prototype.hasOwnProperty.call(database, fieldName)
      if (
        splitPresetPatchFieldValuesDiffer(
          livePresent,
          database[fieldName],
          field.attemptedPresent,
          field.attemptedValue,
        )
      ) {
        continue
      }
      if (field.previousPresent) {
        database[fieldName] = safeStructuredClone(field.previousValue)
      } else {
        delete database[fieldName]
      }
    }
  })()
}

function botPresetIds(list: botPreset[]): string[] {
  return list.map((preset) => preset?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function currentBotPresetSelectedId(): string | null {
  return botPresetSelectedId(legacyPresetOwner(), settingsOwnerRecord().botPresetsId)
}

function botPresetSelectedId(presets: botPreset[], selectedIndex: unknown): string | null {
  if (!Number.isInteger(selectedIndex) || (selectedIndex as number) < 0) return null
  return presets[selectedIndex as number]?.id ?? null
}

function restoreBotPresetSelectionToId(presetId: string | null): void {
  const list = legacyPresetOwner()
  const index = presetId ? list.findIndex((preset) => preset?.id === presetId) : -1
  settingsOwnerRecord().botPresetsId = index >= 0 ? index : normalizedBotPresetsId(list.length, -1)
}

function botPresetFieldRollbackFromPatch(
  presetId: string,
  previousPreset: Record<string, unknown>,
  attemptedPatch: Record<string, unknown>,
  options: { includeRemovedPreviousKeys?: boolean } = {},
): BotPresetFieldRollback {
  const previous: Record<string, unknown> = {}
  const attempted = safeStructuredClone(attemptedPatch)
  const keys = new Set(Object.keys(attempted))
  if (options.includeRemovedPreviousKeys) {
    for (const key of Object.keys(previousPreset)) {
      keys.add(key)
    }
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(previousPreset, key)) {
      previous[key] = safeStructuredClone(previousPreset[key])
    }
    if (!Object.prototype.hasOwnProperty.call(attempted, key)) {
      attempted[key] = undefined
    }
  }
  return {
    presetId,
    previous,
    attempted,
  }
}

function saveCurrentPresetLocalWithRollback(options: { apply?: boolean } = {}): {
  savedPreset: botPreset | null
  rollback: BotPresetFieldRollback | null
  sparseBaseline: LegacyPresetSparseSaveBaseline | null
} {
  const sparseBaselineEligible = !legacyPresetOwnerIdsNeedNormalization()
  normalizeLegacyPresetOwner()
  const baselineIndex = Number(settingsOwnerRecord().botPresetsId ?? -1)
  const previousLivePreset = legacyPresetOwner()[baselineIndex] ?? null
  const previousPreset = previousLivePreset ? safeStructuredClone(previousLivePreset) : null
  const sparseBaseline =
    sparseBaselineEligible && previousLivePreset && botPresetHasHydratedSettings(previousLivePreset)
      ? {
          preset: previousPreset as unknown as Record<string, unknown>,
        }
      : null
  const savedPreset = saveCurrentPresetLocal(options.apply)
  if (!savedPreset?.id || !previousPreset) {
    return { savedPreset, rollback: null, sparseBaseline: null }
  }
  return {
    savedPreset,
    rollback: botPresetFieldRollbackFromPatch(
      savedPreset.id,
      previousPreset as unknown as Record<string, unknown>,
      savedPreset as unknown as Record<string, unknown>,
      { includeRemovedPreviousKeys: true },
    ),
    sparseBaseline,
  }
}

function legacyPresetSaveCommandPatch(
  savedPreset: botPreset,
  baseline: LegacyPresetSparseSaveBaseline | null,
): PresetSnapshot | null {
  // This is intentionally the historical request shape. The merge-only endpoint
  // cannot encode deletion even here, but falling back avoids claiming that a
  // presence-changing reconstruction was proven safe for sparse transport.
  const fullPatch = () => {
    const patch = safeStructuredClone(savedPreset) as unknown as PresetSnapshot
    delete patch.id
    return patch
  }
  if (!baseline || baseline.preset.id !== savedPreset.id) return fullPatch()

  const saved = savedPreset as unknown as Record<string, unknown>
  const patch: PresetSnapshot = {}
  let changed = false
  const keys = new Set([...Object.keys(baseline.preset), ...Object.keys(saved)])
  for (const key of keys) {
    if (key === 'id') continue
    const previousPresent =
      Object.prototype.hasOwnProperty.call(baseline.preset, key) && baseline.preset[key] !== undefined
    const savedPresent = Object.prototype.hasOwnProperty.call(saved, key) && saved[key] !== undefined
    if (!savedPresent) {
      // The legacy PATCH endpoint merges object keys and has no deletion marker.
      // Keep the historical full-payload path when a managed optional field was removed.
      if (previousPresent) return fullPatch()
      continue
    }
    if (previousPresent && snapshotJson(baseline.preset[key]) === snapshotJson(saved[key])) continue
    patch[key] = safeStructuredClone(saved[key])
    changed = true
  }
  return changed ? patch : null
}

const LEGACY_PRESET_NORMALIZED_SIDE_EFFECT_KEYS = ['agents', 'agentPresets', 'agentPresetDefaultId'] as const

function exactJsonRecordClone(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !isExactJsonValue(value)) return null
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function exactJsonRecordCloneOmittingUndefined(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null
  const projected: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    if (!isExactJsonValue(entry)) return null
    projected[key] = JSON.parse(JSON.stringify(entry)) as unknown
  }
  return projected
}

function isExactJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false

  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  if (Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol))) {
    return false
  }

  ancestors.add(value)
  let valid: boolean
  if (Array.isArray(value)) {
    const keys = Object.keys(value)
    valid =
      keys.length === value.length &&
      value.every(
        (entry, index) => Object.prototype.hasOwnProperty.call(value, index) && isExactJsonValue(entry, ancestors),
      )
  } else {
    valid = Object.values(value).every((entry) => isExactJsonValue(entry, ancestors))
  }
  ancestors.delete(value)
  return valid
}

function exactJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== typeof right) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => exactJsonValuesEqual(entry, right[index]))
    )
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && exactJsonValuesEqual(left[key], right[key]),
    )
  )
}

function legacyPresetPatchOptimisticAcknowledgement(input: {
  preset: Record<string, unknown>
  wirePatch: Record<string, unknown>
  collectionProjectionEpoch: number
  expectedPreset?: Record<string, unknown>
}): LegacyPresetPatchOptimisticAcknowledgement | null {
  if (
    !Number.isInteger(input.collectionProjectionEpoch) ||
    input.collectionProjectionEpoch < 0 ||
    !isExactJsonValue(input.preset) ||
    (input.expectedPreset !== undefined &&
      (!isExactJsonValue(input.expectedPreset) || !exactJsonValuesEqual(input.preset, input.expectedPreset)))
  ) {
    return null
  }

  const attemptedFields: Record<string, JsonFieldState> = {}
  const keys = new Set([...Object.keys(input.wirePatch), ...LEGACY_PRESET_NORMALIZED_SIDE_EFFECT_KEYS])
  keys.delete('id')
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input.preset, key)) {
      const value = input.preset[key]
      if (!isExactJsonValue(value)) return null
      attemptedFields[key] = {
        present: true,
        value: JSON.parse(JSON.stringify(value)) as unknown,
      }
    } else {
      attemptedFields[key] = { present: false }
    }
  }

  return {
    collectionProjectionEpoch: input.collectionProjectionEpoch,
    attemptedFields,
  }
}

function rollbackBotPresetFields(rollback: BotPresetFieldRollback | null): void {
  if (!rollback) return
  ;(() => {
    const index = legacyPresetOwner().findIndex((preset) => preset?.id === rollback.presetId)
    if (index < 0) return

    const rolledBack = applyAttemptedFieldRollback({
      target: legacyPresetOwner()[index] as unknown as Record<string, unknown>,
      previous: rollback.previous,
      attempted: rollback.attempted,
      deleteMissingPrevious: true,
    })
    if (rolledBack.length === 0) return
  })()
}

function rollbackBotPresetReorder(previousPresetIds: string[], attemptedPresetIds: string[]): void {
  ;(() => {
    const list = legacyPresetOwner()
    if (!stringArraysEqual(botPresetIds(list), attemptedPresetIds)) return

    const selectedId = currentBotPresetSelectedId()
    const liveRowsById = new Map<string, botPreset>()
    for (const preset of list) {
      if (preset?.id) {
        liveRowsById.set(preset.id, preset)
      }
    }

    const restored = previousPresetIds.map((id) => liveRowsById.get(id))
    if (restored.some((preset) => !preset)) return

    assignLegacyPresetOwner(restored as botPreset[])
    restoreBotPresetSelectionToId(selectedId)
  })()
}

function rollbackBotPresetSelection(rollback: BotPresetSelectionRollback): void {
  ;(() => {
    if (!rollback.attemptedSelectedId) return
    if (currentBotPresetSelectedId() !== rollback.attemptedSelectedId) return

    if (rollback.previousSettings && rollback.attemptedSettings) {
      applyAttemptedFieldRollback({
        target: settingsOwnerRecord(),
        previous: rollback.previousSettings as Record<string, unknown>,
        attempted: rollback.attemptedSettings as Record<string, unknown>,
        keys: SET_PRESET_ROLLBACK_KEYS,
      })
    }
    restoreBotPresetSelectionToId(rollback.previousSelectedId)
  })()
}

function splitPresetList(kind: SplitPresetKind): SplitPresetRow[] {
  return (kind === 'model' ? modelPresetOwner() : promptPresetOwner()) as SplitPresetRow[]
}

function assignSplitPresetList(kind: SplitPresetKind, list: SplitPresetRow[]): void {
  if (kind === 'model') {
    assignModelPresetOwner(list as ModelPreset[])
  } else {
    assignPromptPresetOwner(list as PromptPreset[])
  }
}

function splitPresetIds(list: SplitPresetRow[]): string[] {
  return list.map((preset) => preset?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function currentSplitPresetSelectedId(kind: SplitPresetKind): string | null {
  return splitPresetSelectedId(
    splitPresetList(kind),
    kind === 'model' ? settingsOwnerRecord().modelPresetsId : settingsOwnerRecord().promptPresetsId,
  )
}

function splitPresetSelectedId(list: SplitPresetRow[], selectedIndex: unknown): string | null {
  if (!Number.isInteger(selectedIndex) || (selectedIndex as number) < 0) return null
  return list[selectedIndex as number]?.id ?? null
}

function setSplitPresetSelectedIndex(kind: SplitPresetKind, index: number): void {
  if (kind === 'model') {
    settingsOwnerRecord().modelPresetsId = index
  } else {
    settingsOwnerRecord().promptPresetsId = index
  }
}

function restoreSplitPresetSelectionToId(kind: SplitPresetKind, presetId: string | null): void {
  const list = splitPresetList(kind)
  const index = presetId ? list.findIndex((preset) => preset?.id === presetId) : -1
  setSplitPresetSelectedIndex(kind, index >= 0 ? index : normalizedBotPresetsId(list.length, -1))
}

function rollbackSplitPresetListEntry(kind: SplitPresetKind, entry: SplitPresetListRollbackEntry): void {
  ;(() => {
    const list = splitPresetList(kind)
    const selectedId = currentSplitPresetSelectedId(kind)
    const rolledBack = applyAttemptedKeyedListRollback<SplitPresetRow, string>({
      list,
      entries: [entry],
      getKey: (preset) => preset?.id,
    })
    if (rolledBack.length === 0) return

    assignSplitPresetList(kind, list)
    restoreSplitPresetSelectionToId(kind, selectedId)
  })()
}

function rollbackSplitPresetCreate(kind: SplitPresetKind, attemptedPreset: SplitPresetRow): void {
  const presetId = attemptedPreset.id
  if (!presetId) return
  rollbackSplitPresetListEntry(kind, {
    key: presetId,
    previous: null,
    attempted: safeStructuredClone(attemptedPreset),
  })
}

function rollbackSplitPresetReorder(
  kind: SplitPresetKind,
  previousPresetIds: string[],
  attemptedPresetIds: string[],
): void {
  ;(() => {
    const list = splitPresetList(kind)
    if (!stringArraysEqual(splitPresetIds(list), attemptedPresetIds)) return

    const selectedId = currentSplitPresetSelectedId(kind)
    const liveRowsById = new Map<string, SplitPresetRow>()
    for (const preset of list) {
      if (preset?.id) {
        liveRowsById.set(preset.id, preset)
      }
    }

    const restored = previousPresetIds.map((id) => liveRowsById.get(id))
    if (restored.some((preset) => !preset)) return

    assignSplitPresetList(kind, restored as SplitPresetRow[])
    restoreSplitPresetSelectionToId(kind, selectedId)
  })()
}

function rollbackSplitPresetSelection(rollback: SplitPresetSelectionRollback): void {
  ;(() => {
    if (!rollback.attemptedSelectedId) return
    if (currentSplitPresetSelectedId(rollback.kind) !== rollback.attemptedSelectedId) return

    applyAttemptedFieldRollback({
      target: settingsOwnerRecord(),
      previous: rollback.previousSettings as Record<string, unknown>,
      attempted: rollback.attemptedSettings as Record<string, unknown>,
      keys: SET_PRESET_ROLLBACK_KEYS,
    })
    restoreSplitPresetSelectionToId(rollback.kind, rollback.previousSelectedId)
  })()
}

function presetRowList(kind: PresetRowKind): PresetRow[] {
  return kind === 'legacy' ? legacyPresetOwner() : splitPresetList(kind)
}

function assignPresetRowList(kind: PresetRowKind, list: PresetRow[]): void {
  if (kind === 'legacy') {
    assignLegacyPresetOwner(list as botPreset[])
    return
  }
  assignSplitPresetList(kind, list as SplitPresetRow[])
}

function currentPresetRowSelectedId(kind: PresetRowKind): string | null {
  return kind === 'legacy' ? currentBotPresetSelectedId() : currentSplitPresetSelectedId(kind)
}

function restorePresetRowSelectionToId(kind: PresetRowKind, presetId: string | null): void {
  const list = kind === 'legacy' ? legacyPresetOwner() : splitPresetList(kind)
  if (!Array.isArray(list)) return
  if (kind === 'legacy') {
    restoreBotPresetSelectionToId(presetId)
    return
  }
  restoreSplitPresetSelectionToId(kind, presetId)
}

function presetRowProjectionTarget(entry: Pick<PresetRowMutationEntry, 'kind' | 'key'>): string {
  return pendingMutationPresetRowProjectionTarget(entry.kind, entry.key)
}

function presetOrderProjectionTarget(kind: PresetRowKind): string {
  return `preset-order:${kind}`
}

function reservePresetMutationSequence(): number {
  return ++nextPresetMutationSequence
}

function createPresetRowMutationAttempt(
  entries: PresetRowMutationEntry[],
  selection?: PresetRowMutationAttempt['selection'],
): PresetRowMutationAttempt {
  const attempt: PresetRowMutationAttempt = {
    sequence: reservePresetMutationSequence(),
    entries: safeStructuredClone(entries),
    ...(selection ? { selection: safeStructuredClone(selection) } : {}),
    outbox: null,
    retired: false,
    settled: false,
  }
  unsettledPresetRowMutationAttempts.push(attempt)
  return attempt
}

function legacyPresetEntryFromFieldRollback(
  rollback: BotPresetFieldRollback,
  attemptedPreset: botPreset,
  previousIndex?: number,
): PresetRowMutationEntry {
  const previousPreset = safeStructuredClone(attemptedPreset) as unknown as Record<string, unknown>
  for (const key of Object.keys(rollback.attempted)) {
    if (Object.prototype.hasOwnProperty.call(rollback.previous, key)) {
      previousPreset[key] = safeStructuredClone(rollback.previous[key])
    } else {
      delete previousPreset[key]
    }
  }
  return {
    kind: 'legacy',
    key: rollback.presetId,
    previous: previousPreset as unknown as botPreset,
    attempted: safeStructuredClone(attemptedPreset),
    ...(previousIndex === undefined ? {} : { previousIndex }),
  }
}

function createPresetReorderMutationAttempt(
  kind: PresetRowKind,
  previousPresetIds: string[],
  attemptedPresetIds: string[],
): PresetReorderMutationAttempt {
  const attempt: PresetReorderMutationAttempt = {
    sequence: reservePresetMutationSequence(),
    kind,
    previousPresetIds: [...previousPresetIds],
    attemptedPresetIds: [...attemptedPresetIds],
    outbox: null,
    retired: false,
    settled: false,
  }
  unsettledPresetReorderMutationAttempts.push(attempt)
  return attempt
}

function settlePresetRowMutationAttempt(attempt: PresetRowMutationAttempt, accepted: boolean): void {
  if (attempt.settled) return
  attempt.settled = true
  attempt.retirement = undefined
  attempt.settlementCleanup?.()
  attempt.settlementCleanup = undefined
  const attemptIndex = unsettledPresetRowMutationAttempts.indexOf(attempt)
  const laterAttempts = attemptIndex < 0 ? [] : unsettledPresetRowMutationAttempts.slice(attemptIndex + 1)
  for (const laterAttempt of laterAttempts) {
    if (attempt.selection && laterAttempt.selection) {
      rebasePresetSelectionMutation(laterAttempt.selection, attempt.selection, accepted)
    }
    for (const settledEntry of attempt.entries) {
      for (const laterEntry of laterAttempt.entries) {
        if (laterEntry.kind !== settledEntry.kind || laterEntry.key !== settledEntry.key) continue
        rebasePresetRowMutationEntry(laterEntry, settledEntry, accepted)
      }
    }
  }
  if (attemptIndex >= 0) unsettledPresetRowMutationAttempts.splice(attemptIndex, 1)
}

function rebasePresetSelectionMutation(
  later: PresetSelectionMutation,
  settled: PresetSelectionMutation,
  accepted: boolean,
): void {
  if (later.kind === settled.kind && later.previousSelectedId === settled.attemptedSelectedId) {
    later.previousSelectedId = accepted ? settled.attemptedSelectedId : settled.previousSelectedId
  }
  if (!later.previousSettings || !later.attemptedSettings || !settled.previousSettings || !settled.attemptedSettings) {
    return
  }

  const laterPrevious = later.previousSettings as Record<string, unknown>
  const settledPrevious = settled.previousSettings as Record<string, unknown>
  const settledAttempted = settled.attemptedSettings as Record<string, unknown>
  for (const key of SET_PRESET_ROLLBACK_KEYS) {
    if (presetRowFieldStatesEqual(settledPrevious, settledAttempted, key)) continue
    if (!presetRowFieldStatesEqual(laterPrevious, settledAttempted, key)) continue
    copyPresetRowFieldState(laterPrevious, accepted ? settledAttempted : settledPrevious, key)
  }
}

function rebasePresetRowMutationEntry(
  later: PresetRowMutationEntry,
  settled: PresetRowMutationEntry,
  accepted: boolean,
): void {
  if (!settled.previous || !settled.attempted || !later.previous || !later.attempted) {
    if (!exactJsonValuesEqual(later.previous, settled.attempted)) return
    later.previous = safeStructuredClone(accepted ? settled.attempted : settled.previous)
    if (!accepted && settled.previousIndex !== undefined) later.previousIndex = settled.previousIndex
    return
  }

  const settledFields = changedPresetRowFieldStates(settled.previous, settled.attempted)
  const laterFields = changedPresetRowFieldStates(later.previous, later.attempted)
  const laterChangedFields = new Set(laterFields.keys)
  const settledPrevious = settled.previous as unknown as Record<string, unknown>
  const settledAttempted = settled.attempted as unknown as Record<string, unknown>
  const laterPrevious = later.previous as unknown as Record<string, unknown>
  const laterAttempted = later.attempted as unknown as Record<string, unknown>

  for (const key of settledFields.keys) {
    if (!presetRowFieldStatesEqual(laterPrevious, settledAttempted, key)) continue
    const baseline = accepted ? settledAttempted : settledPrevious
    copyPresetRowFieldState(laterPrevious, baseline, key)
    if (!accepted && !laterChangedFields.has(key)) copyPresetRowFieldState(laterAttempted, baseline, key)
  }
}

function presetRowFieldStatesEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  key: string,
): boolean {
  const leftPresent = Object.prototype.hasOwnProperty.call(left, key)
  const rightPresent = Object.prototype.hasOwnProperty.call(right, key)
  return leftPresent === rightPresent && (!leftPresent || snapshotJson(left[key]) === snapshotJson(right[key]))
}

function copyPresetRowFieldState(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = safeStructuredClone(source[key])
  else delete target[key]
}

function settlePresetReorderMutationAttempt(attempt: PresetReorderMutationAttempt, accepted: boolean): void {
  if (attempt.settled) return
  attempt.settled = true
  attempt.retirement = undefined
  attempt.settlementCleanup?.()
  attempt.settlementCleanup = undefined
  const attemptIndex = unsettledPresetReorderMutationAttempts.indexOf(attempt)
  const laterAttempts = attemptIndex < 0 ? [] : unsettledPresetReorderMutationAttempts.slice(attemptIndex + 1)
  for (const laterAttempt of laterAttempts) {
    if (laterAttempt.kind !== attempt.kind) continue
    if (!stringArraysEqual(laterAttempt.previousPresetIds, attempt.attemptedPresetIds)) continue
    laterAttempt.previousPresetIds = [...(accepted ? attempt.attemptedPresetIds : attempt.previousPresetIds)]
  }
  if (attemptIndex >= 0) unsettledPresetReorderMutationAttempts.splice(attemptIndex, 1)
}

function changedPresetRowFieldStates(
  previous: PresetRow,
  attempted: PresetRow,
): {
  previous: Record<string, unknown>
  attempted: Record<string, unknown>
  keys: string[]
} {
  const previousRecord = previous as unknown as Record<string, unknown>
  const attemptedRecord = attempted as unknown as Record<string, unknown>
  const previousFields: Record<string, unknown> = {}
  const attemptedFields: Record<string, unknown> = {}
  const keys: string[] = []
  for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(attemptedRecord)])) {
    const previousPresent = Object.prototype.hasOwnProperty.call(previousRecord, key)
    const attemptedPresent = Object.prototype.hasOwnProperty.call(attemptedRecord, key)
    if (
      previousPresent === attemptedPresent &&
      (!previousPresent || snapshotJson(previousRecord[key]) === snapshotJson(attemptedRecord[key]))
    ) {
      continue
    }
    keys.push(key)
    previousFields[key] = previousPresent ? safeStructuredClone(previousRecord[key]) : undefined
    attemptedFields[key] = attemptedPresent ? safeStructuredClone(attemptedRecord[key]) : undefined
  }
  return { previous: previousFields, attempted: attemptedFields, keys }
}

function applyPresetRowTransition(entry: PresetRowMutationEntry, from: PresetRow | null, to: PresetRow | null): void {
  ;(() => {
    const list = presetRowList(entry.kind)
    const selectedId = currentPresetRowSelectedId(entry.kind)
    if (from && to) {
      const index = list.findIndex((preset) => preset?.id === entry.key)
      if (index < 0) return
      const fields = changedPresetRowFieldStates(from, to)
      if (fields.keys.length === 0) return
      const changed = applyAttemptedFieldRollback({
        target: list[index] as unknown as Record<string, unknown>,
        previous: fields.attempted,
        attempted: fields.previous,
        keys: fields.keys,
        deleteMissingPrevious: true,
      })
      if (changed.length === 0) return
      assignPresetRowList(entry.kind, list)
      restorePresetRowSelectionToId(entry.kind, selectedId)
      return
    }

    const changed = applyAttemptedKeyedListRollback<PresetRow, string>({
      list,
      entries: [
        {
          key: entry.key,
          previous: to ? safeStructuredClone(to) : null,
          attempted: from ? safeStructuredClone(from) : null,
          previousIndex: entry.previousIndex,
        },
      ],
      getKey: (preset) => preset?.id,
    })
    if (changed.length === 0) return
    assignPresetRowList(entry.kind, list)
    restorePresetRowSelectionToId(entry.kind, selectedId)
  })()
}

function rollbackPresetRowMutationAttempt(attempt: PresetRowMutationAttempt): void {
  for (const entry of attempt.entries) {
    applyPresetRowTransition(entry, entry.attempted, entry.previous)
  }
  const selection = attempt.selection
  if (!selection) return
  if (selection.kind === 'legacy') {
    rollbackBotPresetSelection(selection)
    return
  }
  if (!selection.previousSettings || !selection.attemptedSettings) return
  rollbackSplitPresetSelection({
    kind: selection.kind,
    previousSelectedId: selection.previousSelectedId,
    attemptedSelectedId: selection.attemptedSelectedId,
    previousSettings: selection.previousSettings,
    attemptedSettings: selection.attemptedSettings,
  })
}

function reapplyRetainedPresetRowMutationAttempt(
  attempt: PresetRowMutationAttempt,
  handle: PendingMutationHandle,
): void {
  if (attempt.retired || attempt.settled) return
  attempt.outbox = handle
  reapplyPendingPresetProjections()
}

function applyPresetReorderTransition(kind: PresetRowKind, fromPresetIds: string[], toPresetIds: string[]): void {
  if (kind === 'legacy') {
    rollbackBotPresetReorder(toPresetIds, fromPresetIds)
    return
  }
  rollbackSplitPresetReorder(kind, toPresetIds, fromPresetIds)
}

function rollbackPresetReorderMutationAttempt(attempt: PresetReorderMutationAttempt): void {
  applyPresetReorderTransition(attempt.kind, attempt.attemptedPresetIds, attempt.previousPresetIds)
}

function reapplyRetainedPresetReorderMutationAttempt(
  attempt: PresetReorderMutationAttempt,
  handle: PendingMutationHandle,
): void {
  if (attempt.retired || attempt.settled) return
  attempt.outbox = handle
  reapplyPendingPresetProjections()
}

function applyPresetRowProjectionEntry(entry: PresetRowMutationEntry): void {
  const list = presetRowList(entry.kind)
  const index = list.findIndex((preset) => preset?.id === entry.key)

  if (entry.attempted === null) {
    if (index >= 0) {
      list.splice(index, 1)
      assignPresetRowList(entry.kind, list)
    }
    return
  }

  if (entry.previous === null) {
    if (index < 0) {
      const insertAt = Math.min(Math.max(entry.previousIndex ?? list.length, 0), list.length)
      list.splice(insertAt, 0, safeStructuredClone(entry.attempted))
    } else {
      list[index] = {
        ...(list[index] as unknown as Record<string, unknown>),
        ...(safeStructuredClone(entry.attempted) as unknown as Record<string, unknown>),
      } as PresetRow
    }
    assignPresetRowList(entry.kind, list)
    return
  }

  if (index < 0) {
    const insertAt = Math.min(Math.max(entry.previousIndex ?? list.length, 0), list.length)
    list.splice(insertAt, 0, safeStructuredClone(entry.attempted))
    assignPresetRowList(entry.kind, list)
    return
  }

  const previous = entry.previous as unknown as Record<string, unknown>
  const attempted = entry.attempted as unknown as Record<string, unknown>
  const target = list[index] as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(previous), ...Object.keys(attempted)])) {
    const previousPresent = Object.prototype.hasOwnProperty.call(previous, key)
    const attemptedPresent = Object.prototype.hasOwnProperty.call(attempted, key)
    if (
      previousPresent === attemptedPresent &&
      (!previousPresent || snapshotJson(previous[key]) === snapshotJson(attempted[key]))
    ) {
      continue
    }
    if (attemptedPresent) target[key] = safeStructuredClone(attempted[key])
    else delete target[key]
  }
  assignPresetRowList(entry.kind, list)
}

function applyPresetReorderProjection(attempt: PresetReorderMutationAttempt): void {
  const list = presetRowList(attempt.kind)
  const rowsById = new Map<string, PresetRow>()
  for (const row of list) {
    if (row?.id) rowsById.set(row.id, row)
  }
  if (attempt.attemptedPresetIds.some((presetId) => !rowsById.has(presetId))) return
  const ordered = attempt.attemptedPresetIds.map((presetId) => rowsById.get(presetId)!)
  const attemptedIds = new Set(attempt.attemptedPresetIds)
  ordered.push(...list.filter((row) => !row?.id || !attemptedIds.has(row.id)))
  assignPresetRowList(attempt.kind, ordered)
}

function applySplitPresetPatchProjection(attempt: PendingSplitPresetPatch | DispatchedSplitPresetPatch): void {
  const collectionName = attempt.kind === 'model' ? 'modelPresets' : 'promptPresets'
  const collectionWasReplaced = hasCollectionProjectionEpochChanged(collectionName, attempt.collectionProjectionEpoch)
  const list = splitPresetList(attempt.kind)
  const index = list.findIndex((preset) => preset?.id === attempt.presetId)
  if (index >= 0) {
    const target = list[index] as unknown as Record<string, unknown>
    for (const [fieldName, field] of attempt.fields) {
      if (collectionWasReplaced) {
        field.previousPresent = Object.prototype.hasOwnProperty.call(target, fieldName)
        field.previousValue = safeStructuredClone(target[fieldName])
      }
      if (field.attemptedPresent) target[fieldName] = safeStructuredClone(field.attemptedValue)
      else delete target[fieldName]
    }
    assignSplitPresetList(attempt.kind, list)
  }

  const settingsWereReplaced = hasSettingsProjectionEpochChanged(attempt.settingsProjectionEpoch)
  if (currentSplitPresetSelectedId(attempt.kind) === attempt.presetId) {
    if (attempt.kind !== 'model' || currentSplitPresetSelectedId('prompt') === attempt.selectedPromptPresetId) {
      const database = settingsOwnerRecord()
      for (const [fieldName, field] of attempt.projectionFields) {
        if (settingsWereReplaced) {
          field.previousPresent = Object.prototype.hasOwnProperty.call(database, fieldName)
          field.previousValue = safeStructuredClone(database[fieldName])
        }
        if (field.attemptedPresent) database[fieldName] = safeStructuredClone(field.attemptedValue)
        else delete database[fieldName]
      }
    }
  }

  attempt.collectionProjectionEpoch = captureCollectionProjectionEpoch(collectionName)
  attempt.settingsProjectionEpoch = captureSettingsProjectionEpoch()
  const ownsPromptProjection =
    attempt.kind === 'prompt' &&
    ('ownerProjectionExpected' in attempt
      ? attempt.ownerProjectionExpected
      : attempt.selectedPresetId === attempt.presetId && attempt.projectionFields.has('promptTemplate'))
  if (ownsPromptProjection) {
    attempt.promptOwnerProjectionEpoch = capturePromptTemplateOwnerProjectionEpoch(attempt.presetId)
    attempt.promptOwnerRevision = peekPromptTemplateOwnerRevision(attempt.presetId)
  }
}

function reapplyPendingPresetProjectionsMutable(): void {
  const operations: Array<
    | { sequence: number; type: 'row'; attempt: PresetRowMutationAttempt }
    | { sequence: number; type: 'reorder'; attempt: PresetReorderMutationAttempt }
    | {
        sequence: number
        type: 'split-patch'
        attempt: PendingSplitPresetPatch | DispatchedSplitPresetPatch
      }
    | { sequence: number; type: 'imported-create'; attempt: StagedImportedSplitPreset }
  > = [
    ...unsettledPresetRowMutationAttempts.map((attempt) => ({
      sequence: attempt.sequence,
      type: 'row' as const,
      attempt,
    })),
    ...unsettledPresetReorderMutationAttempts.map((attempt) => ({
      sequence: attempt.sequence,
      type: 'reorder' as const,
      attempt,
    })),
    ...Array.from(unsettledSplitPresetPatches.values()).flatMap((attempts) =>
      attempts.map((attempt) => ({
        sequence: attempt.sequence,
        type: 'split-patch' as const,
        attempt,
      })),
    ),
    ...Array.from(pendingSplitPresetPatches.values()).map((attempt) => ({
      sequence: attempt.sequence,
      type: 'split-patch' as const,
      attempt,
    })),
    ...unsettledImportedSplitPresets.map((attempt) => ({
      sequence: attempt.sequence,
      type: 'imported-create' as const,
      attempt,
    })),
  ].sort((left, right) => left.sequence - right.sequence)
  if (operations.length === 0) return

  const selectedIds: Record<PresetRowKind, string | null> = {
    legacy: currentPresetRowSelectedId('legacy'),
    model: currentPresetRowSelectedId('model'),
    prompt: currentPresetRowSelectedId('prompt'),
  }

  for (const operation of operations) {
    if (operation.attempt.settled) continue
    if (operation.type === 'row') {
      for (const entry of operation.attempt.entries) applyPresetRowProjectionEntry(entry)
      if (operation.attempt.selection) {
        selectedIds[operation.attempt.selection.kind] = operation.attempt.selection.attemptedSelectedId
        if (operation.attempt.selection.attemptedSettings) {
          const database = settingsOwnerRecord()
          for (const [fieldName, value] of Object.entries(operation.attempt.selection.attemptedSettings)) {
            database[fieldName] = safeStructuredClone(value)
          }
        }
      }
    } else if (operation.type === 'reorder') {
      applyPresetReorderProjection(operation.attempt)
    } else if (operation.type === 'split-patch') {
      applySplitPresetPatchProjection(operation.attempt)
    } else {
      const presetId = operation.attempt.preset.id
      if (presetId) {
        applyPresetRowProjectionEntry({
          kind: operation.attempt.kind,
          key: presetId,
          previous: null,
          attempted: operation.attempt.preset,
        })
      }
    }
    restorePresetRowSelectionToId('legacy', selectedIds.legacy)
    restorePresetRowSelectionToId('model', selectedIds.model)
    restorePresetRowSelectionToId('prompt', selectedIds.prompt)
  }

  restorePresetRowSelectionToId('legacy', selectedIds.legacy)
  restorePresetRowSelectionToId('model', selectedIds.model)
  restorePresetRowSelectionToId('prompt', selectedIds.prompt)
}

/** Reassert optimistic preset mutations after an authoritative resource slice is replaced. */
export function reapplyPendingPresetProjections(): void {
  reapplyPendingPresetProjectionsMutable()
}

export function resetPendingPresetMutationsForDatabaseReplacement(): void {
  for (const pending of pendingSplitPresetPatches.values()) {
    if (pending.timer) clearTimeout(pending.timer)
    resolvePendingSplitPresetOutcome(pending, { status: 'failed' })
  }
  for (const attempts of unsettledSplitPresetPatches.values()) {
    for (const attempt of attempts) {
      attempt.retired = true
      attempt.settled = true
      attempt.settlementCleanup?.()
      attempt.settlementCleanup = undefined
      resolveDispatchedSplitPresetOutcome(attempt, 'failed')
      attempt.finalSettlement.resolve('failed')
    }
  }
  for (const attempt of unsettledPresetRowMutationAttempts) {
    attempt.retired = true
    attempt.settled = true
    attempt.retirement?.()
    attempt.retirement = undefined
    attempt.settlementCleanup?.()
    attempt.settlementCleanup = undefined
    attempt.finalSettlement?.resolve('failed')
    attempt.finalSettlement = undefined
  }
  for (const attempt of unsettledPresetReorderMutationAttempts) {
    attempt.retired = true
    attempt.settled = true
    attempt.retirement?.()
    attempt.retirement = undefined
    attempt.settlementCleanup?.()
    attempt.settlementCleanup = undefined
    attempt.finalSettlement?.resolve('failed')
    attempt.finalSettlement = undefined
  }
  for (const attempt of unsettledImportedSplitPresets) {
    attempt.retired = true
    attempt.settled = true
    attempt.retirement.resolve()
    attempt.settlementCleanup?.()
    attempt.settlementCleanup = undefined
  }
  pendingSplitPresetPatches.clear()
  unsettledSplitPresetPatches.clear()
  unsettledPresetRowMutationAttempts.splice(0)
  unsettledPresetReorderMutationAttempts.splice(0)
  unsettledImportedSplitPresets.splice(0)
  activeImportedSplitPresetOwnerKeys.get('model')?.clear()
  activeImportedSplitPresetOwnerKeys.get('prompt')?.clear()
  nextPresetMutationSequence = 0
}

export const resetPendingPresetMutationsForTests = resetPendingPresetMutationsForDatabaseReplacement

function preparePresetMutation(
  intent: DurableMutationIntent,
  projectionTargets: string[],
  semanticKey = PRESET_MUTATION_KEY,
): PreparedPresetMutation {
  if (!canUseServerCommands()) return { status: 'plain' }
  try {
    if (pendingMutationIntentPayloadByteLength(intent) > MAX_DURABLE_MUTATION_PAYLOAD_BYTES) {
      throw new RangeError('Pending preset mutation payload is too large')
    }
    const handle = stagePendingMutation(semanticKey, intent)
    recordPendingMutationProjectionTargets(handle, projectionTargets)
    return { status: 'durable', handle, intent }
  } catch (error) {
    console.error('Unable to stage durable preset mutation:', error)
    return { status: 'failed' }
  }
}

function dispatchPreparedPresetMutation<T extends Record<string, unknown>>(input: {
  prepared: PreparedPresetMutation
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>
  onAccepted: () => void
  onRollback: () => void
  onRetained: (handle: PendingMutationHandle) => void
  finalSettlement: Promise<PresetMutationFinalStatus>
  isActive: () => boolean
  registerRetirement: (retire: () => void) => void
  retryConflictWhile?: () => boolean
}): Promise<PresetMutationOutcome> {
  let settled = false
  let retained = false
  let resolveOutcome!: (outcome: PresetMutationOutcome) => void
  const outcome = new Promise<PresetMutationOutcome>((resolve) => {
    resolveOutcome = resolve
  })
  const canContinue = () => !settled && input.isActive()
  const acceptOnce = () => {
    if (!canContinue()) return
    settled = true
    input.onAccepted()
    resolveOutcome({ status: 'accepted' })
  }
  const rollbackOnce = () => {
    if (!canContinue()) return
    settled = true
    input.onRollback()
    resolveOutcome({ status: 'failed' })
  }
  const retainOnce = (handle: PendingMutationHandle) => {
    if (!canContinue() || retained) return
    retained = true
    input.onRetained(handle)
    resolveOutcome({ status: 'queued', settlement: input.finalSettlement })
  }
  input.registerRetirement(() => {
    if (settled) return
    settled = true
    resolveOutcome({ status: 'failed' })
  })

  if (input.prepared.status === 'failed') {
    rollbackOnce()
    return outcome
  }
  if (input.prepared.status === 'plain') {
    acceptOnce()
    return outcome
  }
  const prepared = input.prepared

  const dispatch = (suppressRollback: boolean, transport: ServerCommandTransportOptions = {}) =>
    runServerCommand({
      command: async (baseRevision) => {
        const result = await input.command(baseRevision)
        if (result.status === 'ok') acceptOnce()
        return result
      },
      rollback: suppressRollback ? () => {} : rollbackOnce,
      ...transport,
    })
  const dispatchOnce = (suppressRollback: boolean) =>
    dispatchDurableMutation(prepared.handle, prepared.intent, (transport) => dispatch(suppressRollback, transport))
  const pending = (async () => {
    const result = await dispatchOnce(!!input.retryConflictWhile)
    if (result.status !== 'conflict' || !input.retryConflictWhile) return result
    if (!canContinue()) return result
    if (input.retryConflictWhile()) return dispatchOnce(false)

    await acknowledgePendingMutation(prepared.handle)
    rollbackOnce()
    return result
  })()

  void pending
    .then(async (result) => {
      if (result.status === 'ok' || !canContinue()) return
      const persisted = (await prepared.handle.ready) === 'persisted'
      if (!canContinue()) return
      const current = persisted && (await isPendingMutationCurrent(prepared.handle))
      if (!canContinue()) return
      if (current) {
        retainOnce(prepared.handle)
        return
      }
      rollbackOnce()
    })
    .catch(async (error) => {
      if (!canContinue()) return
      const persisted = (await prepared.handle.ready) === 'persisted'
      if (!canContinue()) return
      const current = persisted && (await isPendingMutationCurrent(prepared.handle))
      if (!canContinue()) return
      if (current) {
        retainOnce(prepared.handle)
        return
      }
      rollbackOnce()
      console.error('Preset command rejected:', error)
    })
  return outcome
}

function dispatchPresetRowMutation<T extends Record<string, unknown>>(
  prepared: PreparedPresetMutation,
  attempt: PresetRowMutationAttempt,
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>,
  onTerminalRollback: () => void = () => {},
  options: { retryConflictWhile?: () => boolean } = {},
): Promise<PresetMutationOutcome> {
  const finalSettlement = createPresetMutationFinalSettlement()
  attempt.finalSettlement = finalSettlement
  const accept = () => {
    if (attempt.retired || attempt.settled) return
    settlePresetRowMutationAttempt(attempt, true)
    finalSettlement.resolve('accepted')
    attempt.finalSettlement = undefined
  }
  const rollback = () => {
    if (attempt.retired || attempt.settled) return
    settlePresetRowMutationAttempt(attempt, false)
    rollbackPresetRowMutationAttempt(attempt)
    onTerminalRollback()
    finalSettlement.resolve('failed')
    attempt.finalSettlement = undefined
  }
  if (prepared.status === 'durable') {
    attempt.outbox = prepared.handle
    attempt.settlementCleanup = registerDurableMutationSettlementListener(prepared.handle.mutationId, (settlement) =>
      settlement === 'accepted' ? accept() : rollback(),
    )
  }
  return dispatchPreparedPresetMutation({
    prepared,
    command,
    onAccepted: accept,
    onRollback: rollback,
    onRetained: (handle) => reapplyRetainedPresetRowMutationAttempt(attempt, handle),
    finalSettlement: finalSettlement.promise,
    isActive: () => !attempt.retired && !attempt.settled,
    registerRetirement: (retire) => {
      attempt.retirement = retire
    },
    ...options,
  })
}

function dispatchPresetReorderMutation<T extends Record<string, unknown>>(
  prepared: PreparedPresetMutation,
  attempt: PresetReorderMutationAttempt,
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>,
  onTerminalRollback: () => void = () => {},
): Promise<PresetMutationOutcome> {
  const finalSettlement = createPresetMutationFinalSettlement()
  attempt.finalSettlement = finalSettlement
  const accept = () => {
    if (attempt.retired || attempt.settled) return
    settlePresetReorderMutationAttempt(attempt, true)
    finalSettlement.resolve('accepted')
    attempt.finalSettlement = undefined
  }
  const rollback = () => {
    if (attempt.retired || attempt.settled) return
    settlePresetReorderMutationAttempt(attempt, false)
    rollbackPresetReorderMutationAttempt(attempt)
    onTerminalRollback()
    finalSettlement.resolve('failed')
    attempt.finalSettlement = undefined
  }
  if (prepared.status === 'durable') {
    attempt.outbox = prepared.handle
    attempt.settlementCleanup = registerDurableMutationSettlementListener(prepared.handle.mutationId, (settlement) =>
      settlement === 'accepted' ? accept() : rollback(),
    )
  }
  return dispatchPreparedPresetMutation({
    prepared,
    command,
    onAccepted: accept,
    onRollback: rollback,
    onRetained: (handle) => reapplyRetainedPresetReorderMutationAttempt(attempt, handle),
    finalSettlement: finalSettlement.promise,
    isActive: () => !attempt.retired && !attempt.settled,
    registerRetirement: (retire) => {
      attempt.retirement = retire
    },
  })
}

function presetReorderOptimisticAcknowledgement(input: {
  presetKind: PresetReorderOptimisticAcknowledgement['presetKind']
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  beforePresetIds: string[]
  attemptedPresetIds: string[]
  beforeSelectedPresetId: string | null
  attemptedSelectedPresetId: string | null
}): PresetReorderOptimisticAcknowledgement | null {
  const {
    presetKind,
    collectionProjectionEpoch,
    settingsProjectionEpoch,
    beforePresetIds,
    attemptedPresetIds,
    beforeSelectedPresetId,
    attemptedSelectedPresetId,
  } = input
  if (
    new Set(beforePresetIds).size !== beforePresetIds.length ||
    new Set(attemptedPresetIds).size !== attemptedPresetIds.length ||
    beforePresetIds.length !== attemptedPresetIds.length ||
    beforePresetIds.some((presetId) => !attemptedPresetIds.includes(presetId)) ||
    (beforeSelectedPresetId !== null && !beforePresetIds.includes(beforeSelectedPresetId)) ||
    (attemptedSelectedPresetId !== null && !attemptedPresetIds.includes(attemptedSelectedPresetId)) ||
    attemptedSelectedPresetId !== beforeSelectedPresetId
  ) {
    return null
  }

  const beforeSelectedIndex = beforeSelectedPresetId === null ? -1 : beforePresetIds.indexOf(beforeSelectedPresetId)
  const attemptedSelectedIndex =
    attemptedSelectedPresetId === null ? -1 : attemptedPresetIds.indexOf(attemptedSelectedPresetId)
  return {
    presetKind,
    collectionProjectionEpoch,
    settingsProjectionEpoch,
    beforePresetIds: [...beforePresetIds],
    attemptedPresetIds: [...attemptedPresetIds],
    beforeSelectedPresetId,
    attemptedSelectedPresetId,
    settingsWritten: beforeSelectedIndex !== attemptedSelectedIndex,
  }
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeKeepSessionAlive(value: unknown): 'off' | 'sound' {
  if (value === 'pip') return 'sound'
  return value === 'sound' ? 'sound' : 'off'
}

export function setDatabase(data: Database) {
  if (checkNullish(data.characters)) {
    data.characters = []
  }
  if (data.characters.some((character) => (character as { type?: string } | null)?.type === 'group')) {
    throw new Error('Group characters are not supported; refusing to load a lossy database')
  }
  if (checkNullish(data.apiType)) {
    data.apiType = 'gemini-3-flash-preview'
  }
  if (checkNullish(data.openAIKey)) {
    data.openAIKey = ''
  }
  if (checkNullish(data.mainPrompt)) {
    data.mainPrompt = defaultMainPrompt
  }
  if (checkNullish(data.jailbreak)) {
    data.jailbreak = defaultJailbreak
  }
  if (checkNullish(data.globalNote)) {
    data.globalNote = ``
  }
  if (checkNullish(data.temperature)) {
    data.temperature = 80
  }
  if (checkNullish(data.maxContext)) {
    data.maxContext = 4000
  }
  if (checkNullish(data.maxResponse)) {
    data.maxResponse = 500
  }
  if (checkNullish(data.frequencyPenalty)) {
    data.frequencyPenalty = 70
  }
  if (checkNullish(data.PresensePenalty)) {
    data.PresensePenalty = 70
  }
  if (checkNullish(data.aiModel)) {
    data.aiModel = 'gemini-3-flash-preview'
  }
  if (checkNullish(data.jailbreakToggle)) {
    data.jailbreakToggle = false
  }
  if (checkNullish(data.formatingOrder)) {
    data.formatingOrder = [
      'main',
      'description',
      'personaPrompt',
      'chats',
      'lastChat',
      'jailbreak',
      'lorebook',
      'globalNote',
      'authorNote',
    ]
  }
  if (checkNullish(data.loreBookDepth)) {
    data.loreBookDepth = 5
  }
  if (checkNullish(data.loreBookToken)) {
    data.loreBookToken = 800
  }
  if (checkNullish(data.username)) {
    data.username = 'User'
  }
  if (checkNullish(data.userIcon)) {
    data.userIcon = ''
  }
  if (checkNullish(data.userNote)) {
    data.userNote = ''
  }
  if (checkNullish(data.additionalPrompt)) {
    data.additionalPrompt = 'The assistant must act as {{char}}. user is {{user}}.'
  }
  if (checkNullish(data.descriptionPrefix)) {
    data.descriptionPrefix = 'description of {{char}}: '
  }
  if (checkNullish(data.forceReplaceUrl)) {
    data.forceReplaceUrl = ''
  }
  if (checkNullish(data.language)) {
    data.language = 'en'
  }
  if (checkNullish(data.swipe)) {
    data.swipe = true
  }
  if (checkNullish(data.translator)) {
    data.translator = ''
  }
  if (checkNullish(data.translatorMaxResponse)) {
    data.translatorMaxResponse = 1000
  }
  if (checkNullish(data.translatorHistoryMaxTokens)) {
    data.translatorHistoryMaxTokens = 2048
  }
  if (checkNullish(data.inputHooks)) {
    data.inputHooks = createDefaultInputHooks()
  }
  if (checkNullish(data.currentPluginProvider)) {
    data.currentPluginProvider = ''
  }
  if (checkNullish(data.plugins)) {
    data.plugins = []
  }
  if (checkNullish(data.zoomsize)) {
    data.zoomsize = 100
  }
  data.chatDisplayTailCount = normalizeChatDisplayTailCount(
    data.chatDisplayTailCount ?? DEFAULT_CHAT_DISPLAY_TAIL_COUNT,
  )
  data.chatLoadInitialPages = normalizeChatLoadPages(
    data.chatLoadInitialPages ?? data.chatDisplayTailCount,
    DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  )
  data.chatLoadAdditionalPages = normalizeChatLoadPages(
    data.chatLoadAdditionalPages,
    DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  )
  if (checkNullish(data.customBackground)) {
    data.customBackground = ''
  }
  if (checkNullish(data.textgenWebUIStreamURL)) {
    data.textgenWebUIStreamURL = 'wss://localhost/api/'
  }
  if (checkNullish(data.textgenWebUIBlockingURL)) {
    data.textgenWebUIBlockingURL = 'https://localhost/api/'
  }
  if (checkNullish(data.fullScreen)) {
    data.fullScreen = false
  }
  if (checkNullish(data.playMessage)) {
    data.playMessage = false
  }
  if (checkNullish(data.iconsize)) {
    data.iconsize = 100
  }
  if (checkNullish(data.theme)) {
    data.theme = 'fastify'
  }
  if (checkNullish(data.subModel)) {
    data.subModel = 'gemini-3-flash-preview'
  }
  normalizeModelRoleSettings(data)
  normalizeModelProfileSettings(data)
  normalizeAgentPresetSettings(data)
  if (checkNullish(data.waifuWidth)) {
    data.waifuWidth = 100
  }
  if (checkNullish(data.waifuWidth2)) {
    data.waifuWidth2 = 100
  }
  if (checkNullish(data.emotionPrompt)) {
    data.emotionPrompt = ''
  }
  if (checkNullish(data.proxyKey)) {
    data.proxyKey = ''
  }
  normalizePromptTemplateIds(data)
  if (checkNullish(data.botPresets)) {
    data.botPresets = []
  }
  normalizeBotPresetIds(data)
  if (checkNullish(data.botPresetsId)) {
    data.botPresetsId = data.botPresets.length > 0 ? 0 : -1
  }
  if (checkNullish(data.modelPresets) || !Array.isArray(data.modelPresets) || data.modelPresets.length === 0) {
    const defaultModelPreset = safeStructuredClone(presetTemplate) as ModelPreset
    defaultModelPreset.id = 'default-model-preset'
    defaultModelPreset.name = 'Default Model'
    data.modelPresets = [defaultModelPreset]
  }
  if (checkNullish(data.promptPresets) || !Array.isArray(data.promptPresets) || data.promptPresets.length === 0) {
    const defaultPromptPreset = safeStructuredClone(presetTemplate) as PromptPreset
    defaultPromptPreset.id = 'default-prompt-preset'
    defaultPromptPreset.name = 'Default Prompt'
    data.promptPresets = [defaultPromptPreset]
  }
  if (checkNullish(data.modelPresetsId)) {
    data.modelPresetsId = 0
  }
  if (checkNullish(data.promptPresetsId)) {
    data.promptPresetsId = 0
  }
  normalizeSplitPresetIds(data)
  if (checkNullish(data.sdProvider)) {
    data.sdProvider = ''
  }
  if (checkNullish(data.webUiUrl)) {
    data.webUiUrl = 'http://127.0.0.1:7860/'
  }
  if (checkNullish(data.sdSteps)) {
    data.sdSteps = 30
  }
  if (checkNullish(data.sdCFG)) {
    data.sdCFG = 7
  }
  if (checkNullish(data.NAIImgUrl)) {
    data.NAIImgUrl = 'https://image.novelai.net/ai/generate-image'
  }
  if (checkNullish(data.NAIApiKey)) {
    data.NAIApiKey = ''
  }
  if (checkNullish(data.NAIImgModel)) {
    data.NAIImgModel = 'nai-diffusion-4-5-full'
  }
  if (checkNullish(data.NAII2I)) {
    data.NAII2I = false
  }
  if (checkNullish(data.NAIREF)) {
    data.NAIREF = false
  }
  if (checkNullish(data.textTheme)) {
    data.textTheme = 'standard'
  }
  if (checkNullish(data.emotionPrompt2)) {
    data.emotionPrompt2 = ''
  }
  if (checkNullish(data.requestRetrys)) {
    data.requestRetrys = 2
  }
  if (checkNullish(data.requestHistoryLimit)) {
    data.requestHistoryLimit = 20
  }
  data.requestHistoryLimit =
    typeof data.requestHistoryLimit === 'number' && Number.isFinite(data.requestHistoryLimit)
      ? Math.max(0, Math.min(10000, Math.trunc(data.requestHistoryLimit)))
      : 20
  if (checkNullish(data.useSayNothing)) {
    data.useSayNothing = true
  }
  if (checkNullish(data.bias)) {
    data.bias = []
  }
  if (checkNullish(data.showUnrecommended)) {
    data.showUnrecommended = false
  }
  data.doNotWarnExternalServers ??= false
  if (checkNullish(data.pluginCompatibilityMode)) {
    data.pluginCompatibilityMode = false
  }
  data.strictScriptCheck ??= false
  data.complexRegexCompatibilityMode ??= 'worker'
  if (data.complexRegexCompatibilityMode !== 'worker') {
    data.complexRegexCompatibilityMode = 'strict'
  }
  data.complexRegexInputTimeoutMs ??= 15000
  if (typeof data.complexRegexInputTimeoutMs !== 'number' || Number.isNaN(data.complexRegexInputTimeoutMs)) {
    data.complexRegexInputTimeoutMs = 15000
  }
  data.complexRegexOutputTimeoutMs ??= 15000
  if (typeof data.complexRegexOutputTimeoutMs !== 'number' || Number.isNaN(data.complexRegexOutputTimeoutMs)) {
    data.complexRegexOutputTimeoutMs = 15000
  }
  data.complexRegexDisplayTimeoutMs ??= 15000
  if (typeof data.complexRegexDisplayTimeoutMs !== 'number' || Number.isNaN(data.complexRegexDisplayTimeoutMs)) {
    data.complexRegexDisplayTimeoutMs = 15000
  }
  data.regexOutputSizeLimitMiB ??= DEFAULT_REGEX_OUTPUT_SIZE_LIMIT_MIB
  data.regexOutputSizeLimitMiB = normalizeRegexOutputSizeLimitMiB(data.regexOutputSizeLimitMiB)
  if (checkNullish(data.elevenLabKey)) {
    data.elevenLabKey = ''
  }
  if (checkNullish(data.voicevoxUrl)) {
    data.voicevoxUrl = ''
  }
  if (checkNullish(data.showMemoryLimit)) {
    data.showMemoryLimit = false
  }
  if (checkNullish(data.showFirstMessagePages)) {
    data.showFirstMessagePages = false
  }
  if (checkNullish(data.supaMemoryKey)) {
    data.supaMemoryKey = ''
  }
  if (checkNullish(data.hypaV3Key)) {
    data.hypaV3Key = data.supaMemoryKey ?? ''
  }
  if (checkNullish(data.hypaMemoryKey)) {
    data.hypaMemoryKey = ''
  }
  if (checkNullish(data.voyageApiKey)) {
    data.voyageApiKey = ''
  }
  if (checkNullish(data.autoAcquireDisconnectedWriter)) {
    data.autoAcquireDisconnectedWriter = true
  }
  if (checkNullish(data.askRemoval)) {
    data.askRemoval = true
  }
  if (checkNullish(data.sdConfig)) {
    data.sdConfig = {
      width: 512,
      height: 512,
      sampler_name: 'Euler a',
      script_name: '',
      denoising_strength: 0.7,
      enable_hr: false,
      hr_scale: 1.25,
      hr_upscaler: 'Latent',
    }
  }
  if (checkNullish(data.NAIImgConfig)) {
    data.NAIImgConfig = {
      width: 1024,
      height: 1024,
      sampler: 'k_euler_ancestral',
      noise_schedule: 'karras',
      steps: 28,
      scale: 5,
      cfg_rescale: 0,
      sm: true,
      sm_dyn: false,
      noise: 0.0,
      strength: 0.6,
      image: '',
      base64image: '',
      InfoExtracted: 1,
      autoSmea: false,
      legacy_uc: false,
      use_coords: false,
      v4_prompt: {
        caption: {
          base_caption: '',
          char_captions: [],
        },
        use_coords: false,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: {
          base_caption: '',
          char_captions: [],
        },
        legacy_uc: false,
      },
      variety_plus: false,
      decrisp: false,
      reference_mode: '',
      character_image: '',
      character_base64image: '',
      style_aware: false,
    }
  }
  // Backfill NAI v4 image config defaults for older databases.
  if (checkNullish(data.NAIImgConfig.v4_prompt)) {
    data.NAIImgConfig.autoSmea = false
    data.NAIImgConfig.use_coords = false
    data.NAIImgConfig.legacy_uc = false
    data.NAIImgConfig.v4_prompt = {
      caption: {
        base_caption: '',
        char_captions: [],
      },
      use_coords: false,
      use_order: true,
    }
    data.NAIImgConfig.v4_negative_prompt = {
      caption: {
        base_caption: '',
        char_captions: [],
      },
      legacy_uc: false,
    }
  }
  if (checkNullish(data.customTextTheme)) {
    data.customTextTheme = {
      FontColorStandard: '#f8f8f2',
      FontColorBold: '#f8f8f2',
      FontColorItalic: '#8C8D93',
      FontColorItalicBold: '#8C8D93',
      FontColorQuote1: '#8BE9FD',
      FontColorQuote2: '#FFB86C',
    }
  }
  if (checkNullish(data.hordeConfig)) {
    data.hordeConfig = {
      apiKey: '',
      model: '',
      softPrompt: '',
    }
  }
  if (checkNullish(data.novelai)) {
    data.novelai = {
      token: '',
      model: 'clio-v1',
    }
  }
  if (checkNullish(data.loreBook)) {
    data.loreBookPage = 0
    data.loreBook = [
      {
        id: 'default-global-lorebook',
        name: 'My First LoreBook',
        data: [],
      },
    ]
  }
  if (checkNullish(data.loreBookPage) || data.loreBook.length < data.loreBookPage) {
    data.loreBookPage = 0
  }
  data.globalscript ??= []
  data.sendWithEnter ??= true
  data.autoSuggestPrompt ??= defaultAutoSuggestPrompt
  data.autoSuggestPrefix ??= ''
  data.OAIPrediction ??= ''
  data.autoSuggestClean ??= true
  data.imageCompression ??= true
  data.enableBlockPartialEdit ??= false
  data.enableDragPartialEdit ??= false
  if (!data.formatingOrder.includes('personaPrompt')) {
    data.formatingOrder.splice(data.formatingOrder.indexOf('main'), 0, 'personaPrompt')
  }
  data.selectedPersona ??= 0
  data.personaPrompt ??= ''
  data.personas ??= [
    {
      id: 'default-persona',
      name: data.username,
      displayName: '',
      personaPrompt: '',
      icon: data.userIcon,
      note: data.userNote,
      largePortrait: false,
      modules: [],
    },
  ]
  for (const persona of data.personas) {
    if (persona.modules !== undefined) {
      persona.modules = Array.isArray(persona.modules)
        ? Array.from(
            new Set(persona.modules.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
          )
        : []
    }
  }
  if (data.selectedPersonaId === undefined) {
    const selectedPersona = Number.isInteger(data.selectedPersona) ? data.personas[data.selectedPersona] : undefined
    const selectedPersonaId = selectedPersona?.id
    data.selectedPersonaId =
      typeof selectedPersonaId === 'string' &&
      selectedPersonaId.trim() !== '' &&
      data.personas.filter((persona) => persona.id === selectedPersonaId).length === 1
        ? selectedPersonaId
        : null
  }
  data.classicMaxWidth ??= false
  data.chatScreenWidth ??= 900
  data.autoTranslateNotificationDeferCapSeconds ??= 180
  data.ooba ??= safeStructuredClone(defaultOoba)
  data.ainconfig ??= safeStructuredClone(defaultAIN)
  data.openrouterKey ??= ''
  data.openrouterRequestModel ??= 'openai/gpt-3.5-turbo'
  data.nanogptKey ??= ''
  data.nanogptRequestModel ??= ''
  data.nanogptRequestModelName ??= ''
  data.nanogptProvider ??= ''
  data.nanogptSubscriptionState ??= ''
  data.nanogptUseSubscriptionEndpoint ??= false
  data.NAIsettings ??= safeStructuredClone(prebuiltNAIpresets)
  data.assetWidth ??= -1
  data.animationSpeed ??= 0.4
  data.reducedMotion ??= false
  data.hypaV3ProgressOpenChatOnly ??= false
  data.colorScheme ??= safeStructuredClone(defaultColorScheme)
  data.colorSchemeName ??= 'default'
  data.customColorScheme ??= safeStructuredClone(
    data.colorSchemeName === 'custom' ? data.colorScheme : defaultColorScheme,
  )
  data.NAIsettings.starter ??= ''
  data.hypaModel ??= 'MiniLM'
  data.mancerHeader ??= ''
  data.emotionProcesser ??= 'submodel'
  data.translatorType ??= 'google'
  data.htmlTranslation ??= false
  data.deeplOptions ??= {
    key: '',
    freeApi: false,
  }
  data.deeplXOptions ??= {
    url: '',
    token: '',
  }
  data.NAIadventure ??= false
  data.NAIappendName ??= true
  data.NAIsettings.cfg_scale ??= 1
  data.NAIsettings.mirostat_tau ??= 0
  data.NAIsettings.mirostat_lr ??= 1
  data.autofillRequestUrl ??= true
  data.customProxyRequestModel ??= ''
  data.generationSeed ??= -1
  data.newOAIHandle ??= true
  data.localNetworkMode ??= false
  if (typeof data.localNetworkMode !== 'boolean') {
    data.localNetworkMode = false
  }
  data.localNetworkTimeoutSec ??= 600
  if (typeof data.localNetworkTimeoutSec !== 'number' || Number.isNaN(data.localNetworkTimeoutSec)) {
    data.localNetworkTimeoutSec = 600
  }
  data.gptVisionQuality ??= 'low'
  data.huggingfaceKey ??= ''
  data.fishSpeechKey ??= ''
  data.presetRegex ??= []
  data.reverseProxyOobaArgs ??= {
    mode: 'instruct',
  }
  data.top_p ??= 1
  if (typeof data.top_p !== 'number') {
    // Normalize migrated data that stored top_p as a non-number.
    data.top_p = 1
  }
  //@ts-expect-error data.google has required fields (accessToken, projectId), but we use empty object as default and populate below
  data.google ??= {}
  data.google.accessToken ??= ''
  data.google.projectId ??= ''
  data.genTime ??= 1
  data.promptSettings ??= {
    assistantPrefill: '',
    postEndInnerFormat: '',
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
    customChainOfThought: false,
    maxThoughtTagDepth: -1,
  }
  data.keiServerURL ??= ''
  data.top_k ??= 0
  data.promptSettings.maxThoughtTagDepth ??= -1
  data.openrouterFallback ??= true
  data.openrouterMiddleOut ??= false
  data.removePunctuationHypa ??= true
  data.memoryLimitThickness ??= 1
  data.modules ??= []
  data.enabledModules ??= []
  data.moduleFolders = normalizeModuleFolders(data.moduleFolders)
  const moduleFolderIds = new Set(data.moduleFolders.map((folder) => folder.id))
  for (const module of data.modules) {
    if (!moduleFolderIds.has(module.folderId ?? '')) delete module.folderId
  }
  for (const character of data.characters) {
    const overrides = normalizeScriptModelOverrides(character.scriptModelOverrides)
    if (Object.keys(overrides).length > 0) character.scriptModelOverrides = overrides
    else delete character.scriptModelOverrides
  }
  for (const module of data.modules) {
    const overrides = normalizeScriptModelOverrides(module.scriptModelOverrides)
    if (Object.keys(overrides).length > 0) module.scriptModelOverrides = overrides
    else delete module.scriptModelOverrides
  }
  data.additionalParams ??= []
  data.applyAdditionalParamsToAll ??= false
  data.heightMode ??= 'normal'
  data.antiClaudeOverload ??= false
  data.ollamaURL ??= ''
  data.ollamaModel ??= ''
  data.ollamaModelSource ??= data.aiModel === 'ollama-cloud' || data.subModel === 'ollama-cloud' ? 'cloud' : 'local'
  data.ollamaInputMode ??= 'manual'
  data.ollamaRequestFormat ??= LLMFormat.Ollama
  data.ollamaApiKey ??= ''
  data.ollamaModelName ??= ''
  data.ollamaCloudModel ??= ''
  data.ollamaCloudModelName ??= ''
  data.ollamaThinkingMode ??= 'auto'
  if ((data.aiModel === 'ollama-cloud' || data.subModel === 'ollama-cloud') && !data.ollamaCloudModel) {
    data.ollamaCloudModel = data.ollamaModel
    data.ollamaCloudModelName = data.ollamaModelName
  }
  data.repetition_penalty ??= 1
  data.min_p ??= 0
  data.top_a ??= 0
  data.customTokenizer ??= 'tik'
  data.instructChatTemplate ??= 'chatml'
  // Migration: convert old string type into new provider object
  if (typeof data.openrouterProvider === 'string') {
    const oldProvider = data.openrouterProvider as unknown as string
    data.openrouterProvider = {
      order: oldProvider ? [oldProvider] : [],
      only: [],
      ignore: [],
    }
  }
  if (data.botPresets) {
    for (const preset of data.botPresets) {
      preset.localNetworkMode ??= false
      preset.localNetworkTimeoutSec ??= 600
      if (typeof preset.localNetworkMode !== 'boolean') {
        preset.localNetworkMode = false
      }
      if (typeof preset.localNetworkTimeoutSec !== 'number' || Number.isNaN(preset.localNetworkTimeoutSec)) {
        preset.localNetworkTimeoutSec = 600
      }
      if (typeof preset.openrouterProvider === 'string') {
        const oldProvider = preset.openrouterProvider as unknown as string
        preset.openrouterProvider = {
          order: oldProvider ? [oldProvider] : [],
          only: [],
          ignore: [],
        }
      }
    }
  }
  data.openrouterProvider ??= {
    order: [],
    only: [],
    ignore: [],
  }
  data.useInstructPrompt ??= false
  data.textAreaSize ??= 0
  data.sideBarSize ??= 0
  data.desktopSidebarColumns = normalizeDesktopSidebarColumns(data.desktopSidebarColumns)
  data.mobileSidebarColumns = normalizeMobileSidebarColumns(data.mobileSidebarColumns)
  data.textAreaTextSize ??= 0
  data.combineTranslation ??= false
  data.customPromptTemplateToggle ??= ''
  data.globalChatVariables ??= {}
  data.templateDefaultVariables ??= ''
  data.dallEQuality ??= 'standard'
  data.customTextTheme.FontColorQuote1 ??= '#8BE9FD'
  data.customTextTheme.FontColorQuote2 ??= '#FFB86C'
  data.font ??= 'default'
  data.customFont ??= ''
  data.lineHeight ??= 1.25
  data.paragraphBreakBySentences ??= false
  data.paragraphBreakSentenceCount ??= 3
  data.stabilityModel ??= 'sd3-large'
  data.stabllityStyle ??= ''
  data.legacyTranslation ??= false
  data.translatorSendTextAsIs ??= false
  data.translatorExcludeThoughts ??= false
  data.comfyUiUrl ??= 'http://localhost:8188'
  data.comfyConfig ??= {
    workflow: '',
    posNodeID: '',
    posInputName: 'text',
    negNodeID: '',
    negInputName: 'text',
    timeout: 30,
  }
  data.hideApiKey ??= true
  data.unformatQuotes ??= false
  data.ttsAutoSpeech ??= false
  data.translatorInputLanguage ??= 'auto'
  data.falModel ??= 'fal-ai/flux/dev'
  data.falLoraScale ??= 1
  data.customCSS ??= ''
  data.strictJsonSchema ??= true
  data.statics ??= {
    messages: 0,
    imports: 0,
  }
  data.customQuotes ??= false
  data.customQuotesData ??= ['“', '”', '‘', '’']
  data.customGUI ??= ''
  data.guiHTML ??= ''
  data.customAPIFormat ??= LLMFormat.OpenAICompatible
  data.systemContentReplacement ??= `system: {{slot}}`
  data.systemRoleReplacement ??= 'user'
  data.vertexAccessToken ??= ''
  data.vertexAccessTokenExpires ??= 0
  data.vertexClientEmail ??= ''
  data.vertexPrivateKey ??= ''
  data.vertexRegion ??= 'global'
  data.seperateParametersEnabled ??= false
  normalizeSeperateParameters(data)
  data.customFlags ??= []
  data.enableCustomFlags ??= false
  data.assetMaxDifference ??= 4
  data.showSavingIcon ??= true
  data.banCharacterset ??= []
  data.showPromptComparison ??= false
  data.OaiCompAPIKeys ??= {}
  data.providerCredentials ??= []
  data.reasoningEffort ??= 0
  data.verbosity ??= 1
  if (!isBardWikiGlobalSettings(data.bardWiki)) {
    data.bardWiki = { ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS }
  }
  data.hypaV3Presets ??= [
    createHypaV3Preset(
      'Default',
      {
        summarizationPrompt: (data as { supaMemoryPrompt?: string }).supaMemoryPrompt ?? '',
        ...data.hypaV3Settings,
      },
      'default-hypa-v3-preset',
    ),
  ]
  repairHypaV3PresetSelectionIdentity(data as unknown as Record<string, unknown>)
  if (data.hypaV3Presets.length > 0) {
    data.hypaV3Presets = data.hypaV3Presets.map((preset, i) =>
      createHypaV3Preset(preset.name || `Preset ${i + 1}`, preset.settings || {}, preset.id),
    )
  }
  normalizeTranslatorPresetStateWithLegacyCompatibility(data)
  data.showDeprecatedTriggerV2 ??= false
  data.returnCSSError ??= true
  data.realmDirectOpen ??= false
  data.checkCorruption ??= false
  data.toggleConfirmRecommendedPreset ??= false
  data.useExperimentalGoogleTranslator ??= false
  data.thinkingType ??= 'budget'
  data.deepseekThinkingType ??= 'off'
  data.adaptiveThinkingEffort ??= 'high'
  data.deepseekReasoningEffort ??= 'high'
  if (data.antiClaudeOverload) {
    // Rename antiClaudeOverload to antiServerOverloads.
    data.antiClaudeOverload = false
    data.antiServerOverloads = true
  }
  data.hypaCustomSettings = {
    url: data.hypaCustomSettings?.url ?? '',
    key: data.hypaCustomSettings?.key ?? '',
    model: data.hypaCustomSettings?.model ?? '',
  }
  data.doNotChangeSeperateModels ??= false
  data.seperateModelsForAxModels ??= false
  normalizeModelRoleSettings(data)
  normalizeModelProfileSettings(data)
  data.modelTools ??= []
  data.enableScrollToActiveChar ??= true

  // Merge existing hotkeys with new default hotkeys
  if (!data.hotkeys) {
    data.hotkeys = safeStructuredClone(defaultHotkeys)
  } else {
    data.hotkeys = data.hotkeys.filter((hotkey) => !RETIRED_HOTKEY_ACTIONS.has(hotkey.action))
    const existingActions = new Set(data.hotkeys.map((h) => h.action))
    const newHotkeys = defaultHotkeys.filter((h) => !existingActions.has(h.action))
    if (newHotkeys.length > 0) {
      data.hotkeys.push(...safeStructuredClone(newHotkeys))
    }
  }

  // Remove scrollToActiveChar hotkey if feature is disabled
  if (data.enableScrollToActiveChar === false) {
    data.hotkeys = data.hotkeys.filter((h) => h.action !== 'scrollToActiveChar')
  }

  data.fallbackModels = normalizeLegacyFallbackModels(data.fallbackModels)
  data.customModels ??= []
  data.authRefreshes ??= []
  data.openAIFlexProcessing ??= false
  data.rememberToolUsage ??= true
  data.simplifiedToolUse ??= false
  data.halfStreaming ??= false
  data.streamGeminiThoughts ??= false
  data.settingsCloseButtonSize ??= 24
  data.hideAllImages ??= false
  data.ImagenModel ??= 'imagen-4.0-generate-001'
  data.ImagenImageSize ??= '1K'
  data.ImagenAspectRatio ??= '1:1'
  data.ImagenPersonGeneration ??= 'allow_all'
  data.openaiCompatImage ??= {
    url: '',
    key: '',
    model: '',
    size: '1024x1024',
    quality: 'auto',
  }
  data.wavespeedImage ??= {
    key: '',
    model: '',
    loras: [],
    reference_mode: '',
    reference_image: '',
    reference_base64image: '',
  }
  data.autoScrollToNewMessage ??= true
  data.alwaysScrollToNewMessage ??= false
  data.newMessageButtonStyle ??= 'bottom-center'
  data.floatingChatInput ??= true
  data.echoMessage ??= 'Echo Message'
  data.echoDelay ??= 0
  data.createFolderOnBranch ??= true
  data.hamburgerButtonBottom ??= false
  data.dynamicModelRegistry ??= true
  data.saveSignatures ??= false
  // If the user uses plugins, its probably better to enable RisuAI Pro Tools by default
  // Because its likely they are power users who would benefit from the features
  data.enableRisuaiProTools ??= data.plugins.length > 0
  data.showGlobalLorebookAndRegex ??= false
  data.keepSessionAlive = normalizeKeepSessionAlive(data.keepSessionAlive)
  data.chatGenerationTogglePresets = normalizeChatGenerationTogglePresets(data.chatGenerationTogglePresets)
  data.loadouts ??= []
  data.lastLoadedLoadoutName ??= ''
  data.longPressToPopupEditor ??= false
  data.disableAutoPopupMessageEditor ??= false
  data.useMonacoEditorOnDesktop ??= false
  data.useMonacoEditorOnMobile ??= false
  data.customSidebarItems = normalizeCustomSidebarItems(data.customSidebarItems)
  void changeLanguage(data.language)
  setDatabaseLite(data)
}

export function applyServerResourceDatabase(data: Database, revision?: number) {
  data.chatScreenWidth ??= 900
  data.autoTranslateNotificationDeferCapSeconds ??= 180
  data.desktopSidebarColumns = normalizeDesktopSidebarColumns(data.desktopSidebarColumns)
  data.mobileSidebarColumns = normalizeMobileSidebarColumns(data.mobileSidebarColumns)
  data.customSidebarItems = normalizeCustomSidebarItems(data.customSidebarItems)
  data.chatGenerationTogglePresets = normalizeChatGenerationTogglePresets(data.chatGenerationTogglePresets)
  normalizeNestedPromptTemplates(data)
  normalizeAgentPresetSettings(data)
  void changeLanguage(data.language)
  setDatabaseLite(data, revision)
  reapplyPendingPresetProjectionsMutable()
  createDestructiveRefreshToken('server-resource-database-replace')
}

function applyServerResourceField(key: string, value: unknown): void {
  if (key === 'characters') {
    charactersResourceState.characters = safeStructuredClone(value) as character[]
    charactersResourceState.status = 'ready'
    return
  }
  if (isServerCollectionName(key)) {
    collectionsResourceState.values[key] = safeStructuredClone(value) as never
    collectionsResourceState.statuses[key] = 'ready'
    return
  }

  const cloned = safeStructuredClone(value)
  ;(settingsResourceState.value as Record<string, unknown>)[key] = cloned
  settingsResourceState.status = 'ready'
  if (key === 'characterOrder' && Array.isArray(cloned)) {
    charactersResourceState.characterOrder = cloned as Database['characterOrder']
  } else if (key === 'currentChar' && Number.isInteger(cloned)) {
    charactersResourceState.currentChar = cloned as number
  }
}

function deleteServerResourceField(key: string): void {
  if (key === 'characters') {
    charactersResourceState.characters = []
    return
  }
  if (isServerCollectionName(key)) {
    delete collectionsResourceState.values[key]
    return
  }
  delete (settingsResourceState.value as Record<string, unknown>)[key]
  if (key === 'characterOrder') charactersResourceState.characterOrder = []
  if (key === 'currentChar') charactersResourceState.currentChar = -1
}

/**
 * Surgically merges targeted resource fields into the live database without a
 * full `setDatabase` replace. Used for foreign command events and entity
 * hydration. The fields come from the server resources (same source as
 * bootstrap), so no re-normalization is needed; this must not clobber
 * locally-hydrated entities outside the named keys.
 */
export function mergeServerResourceFields(fields: Partial<Database>) {
  for (const [key, value] of Object.entries(fields)) {
    if ((key === 'promptTemplate' || key === 'agentPresetDefaultId') && value === null) {
      deleteServerResourceField(key)
      continue
    }
    applyServerResourceField(
      key,
      key === 'promptTemplate'
        ? normalizePromptTemplate(value)
        : key === 'customSidebarItems'
          ? normalizeCustomSidebarItems(value)
          : key === 'chatGenerationTogglePresets'
            ? normalizeChatGenerationTogglePresets(value)
            : value,
    )
  }
  if (typeof fields.language === 'string') {
    void changeLanguage(fields.language)
  }
  reapplyPendingPresetProjectionsMutable()
}

export { SERVER_CHARACTER_SHELL_MARKER } from '@risuai/protocol/character-summary-resource'

export function isServerCharacterShell(character: unknown): boolean {
  return (
    !!character &&
    typeof character === 'object' &&
    !Array.isArray(character) &&
    (character as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] === true
  )
}

/**
 * Surgically replace a single character row by `chaId` without touching the rest
 * of the `characters` array. Used for foreign per-character refreshes
 * (`characterRow` events: character field edits, script/trigger replacements,
 * module-link reorders, and chat/chat-folder metadata edits). The shipped row
 * is message-free (stubbed chats),
 * so already-hydrated chat messages / globalLore are carried over to avoid
 * dropping loaded history. Returns false if the character is unknown so the
 * caller can fall back to a full bootstrap.
 */
function mergeServerResourceCharacterRowMutable(character: { chaId?: string } & Record<string, unknown>): boolean {
  delete character[SERVER_CHARACTER_SHELL_MARKER]
  const characters = charactersResourceState.characters
  if (!Array.isArray(characters) || typeof character?.chaId !== 'string') return false
  const index = characters.findIndex((candidate) => candidate?.chaId === character.chaId)
  if (index < 0) return false
  const existing = characters[index] as unknown as Record<string, unknown> | undefined

  // The shipped chats are stubs (empty message[]); carry over any messages
  // this client already hydrated so a metadata refresh keeps loaded history.
  const incomingChats = (character as { chats?: Array<Record<string, unknown>> }).chats
  const existingChats = (existing as { chats?: Array<Record<string, unknown>> } | undefined)?.chats
  if (Array.isArray(incomingChats) && Array.isArray(existingChats)) {
    const existingById = new Map(existingChats.map((chat) => [chat?.id, chat]))
    for (const chat of incomingChats) {
      const chatId = (chat as { id?: unknown }).id
      const prior = existingById.get(chatId)
      if (!prior) continue
      const priorMessage = (prior as { message?: unknown }).message
      if (Array.isArray(priorMessage) && priorMessage.length > 0) {
        ;(chat as { message?: unknown }).message = priorMessage
      }
      const priorHypa = (prior as { hypaV3Data?: unknown }).hypaV3Data
      if (priorHypa !== undefined) (chat as { hypaV3Data?: unknown }).hypaV3Data = priorHypa
      if (
        typeof chatId === 'string' &&
        shouldPreserveLiveChatGenerationSettingsForResource(
          chatId,
          (chat as { generationSettings?: unknown }).generationSettings,
        )
      ) {
        const priorRecord = prior as { generationSettings?: unknown }
        const chatRecord = chat as { generationSettings?: unknown }
        if (Object.prototype.hasOwnProperty.call(priorRecord, 'generationSettings')) {
          chatRecord.generationSettings = priorRecord.generationSettings
        } else {
          delete chatRecord.generationSettings
        }
      }
    }
  }
  // Preserve resident globalLore if the shipped row stubbed it (stubs on).
  if (
    (character as { globalLore?: unknown }).globalLore === undefined &&
    existing &&
    (existing as { globalLore?: unknown }).globalLore !== undefined
  ) {
    ;(character as { globalLore?: unknown }).globalLore = (existing as { globalLore?: unknown }).globalLore
  }

  characters[index] = character as unknown as (typeof characters)[number]
  return true
}

export function mergeServerResourceCharacterRow(character: { chaId?: string } & Record<string, unknown>): boolean {
  return mergeServerResourceCharacterRowMutable(character)
}

/**
 * Apply a character row and a dependent resource as one visible change. The
 * dependent callback runs while resource writes are trusted; if
 * it cannot apply, restore the exact prior character before returning false so
 * the caller can full-resync without exposing half of a composite revision.
 */
export function mergeServerResourceCharacterRowComposite(
  character: { chaId?: string } & Record<string, unknown>,
  applyDependentResource: () => boolean,
): boolean {
  const characters = charactersResourceState.characters
  if (!Array.isArray(characters) || typeof character?.chaId !== 'string') return false
  const index = characters.findIndex((candidate) => candidate?.chaId === character.chaId)
  if (index < 0) return false
  const previous = characters[index]
  let committed = false
  try {
    if (!mergeServerResourceCharacterRowMutable(character)) return false
    committed = applyDependentResource()
    return committed
  } catch {
    return false
  } finally {
    if (!committed) characters[index] = previous
  }
}

export function applyServerCharacterSelectionResource(input: {
  characterId: string
  currentChar: number
  lastInteraction?: number
}): boolean {
  const characters = charactersResourceState.characters
  const liveIndex = Array.isArray(characters)
    ? characters.findIndex((candidate) => candidate?.chaId === input.characterId)
    : -1
  if (liveIndex < 0) return false
  charactersResourceState.currentChar = liveIndex
  ;(settingsResourceState.value as unknown as { currentChar?: number }).currentChar = liveIndex
  const character = characters[liveIndex]
  if (character && input.lastInteraction !== undefined) {
    character.lastInteraction = input.lastInteraction
  }
  selectedCharID.set(liveIndex)
  return true
}

/**
 * Apply full, tail, or ranged server message hydration to the target chat owner.
 * Returns true if the owner was found and hydrated.
 */
export interface ServerChatMessagesHydrationRange {
  start: number
  total: number
  /** A targeted generation append may retain the already-loaded prefix. */
  preserveExistingOnGrowth?: boolean
}

export interface ServerChatMessagesHydrationOptions {
  /** Omitted generation-delta Hypa state preserves the resident chat value. */
  hypaV3DataIncluded?: boolean
}

export { isServerChatMessagePlaceholder }

function createServerChatMessagePlaceholder(): Message {
  return {
    role: 'char',
    data: '',
    isComment: true,
    disabled: true,
    [SERVER_UNLOADED_CHAT_MESSAGE_MARKER]: true,
  } as Message
}

export function hydrateServerChatMessages(
  chatId: string,
  message: unknown[],
  hypaV3Data?: unknown,
  range?: ServerChatMessagesHydrationRange,
  options: ServerChatMessagesHydrationOptions = {},
): boolean {
  for (const character of charactersResourceState.characters) {
    const chat = character.chats?.find((candidate) => candidate.id === chatId)
    if (chat) {
      if (range) {
        const hasExistingMessages = Array.isArray(chat.message)
        const existingMessages = hasExistingMessages ? chat.message : []
        const merge = mergeChatMessageRange(
          existingMessages,
          message as Message[],
          range,
          createServerChatMessagePlaceholder,
        )
        if (!merge) return false
        if (!hasExistingMessages || merge.replacedArray) chat.message = merge.messages
      } else {
        if (!sameStructuredValue(chat.message, message)) chat.message = message as Message[]
      }
      // `hypaV3Data` is hydrated alongside messages; undefined means the chat
      // has none, so clear any stale value.
      if (options.hypaV3DataIncluded !== false) {
        if (hypaV3Data === undefined && Object.prototype.hasOwnProperty.call(chat, 'hypaV3Data')) {
          delete (chat as { hypaV3Data?: unknown }).hypaV3Data
        } else if (hypaV3Data !== undefined && !sameStructuredValue(chat.hypaV3Data, hypaV3Data)) {
          chat.hypaV3Data = hypaV3Data as typeof chat.hypaV3Data
        }
      }
      return true
    }
  }
  return false
}

/**
 * Fill a stubbed character owner's `globalLore` with entries hydrated from the
 * server on character-open. Targets by `chaId` and returns true if found.
 */
export function hydrateServerCharacterLorebook(characterId: string, globalLore: unknown[]): boolean {
  return writeServerCharacterLorebook(characterId, globalLore)
}

function writeServerCharacterLorebook(characterId: string, globalLore: unknown[]): boolean {
  for (const character of charactersResourceState.characters) {
    if (character.chaId === characterId) {
      character.globalLore = globalLore as typeof character.globalLore
      return true
    }
  }
  return false
}

export function setDatabaseLite(data: Database, revision?: number) {
  replaceResourceDatabase(data, revision)
}

interface CharacterSnapshotOptions {
  snapshot?: boolean
}

export function getCurrentCharacter(options: CharacterSnapshotOptions = {}): character {
  const character = charactersResourceState.characters[get(selectedCharID)]
  return options.snapshot ? safeStructuredClone(character) : character
}

export function setCurrentCharacter(char: character, options: { dispatchServerCommand?: boolean } = {}) {
  const shouldDispatch = options.dispatchServerCommand ?? true
  const index = get(selectedCharID)
  const previousState = shouldDispatch && canUseServerCommands() ? currentCharacterRowSnapshot(index) : null
  const previousCharacter = previousState ? $state.snapshot(charactersResourceState.characters[index]) : undefined

  charactersResourceState.characters[index] = char
  if (previousState) {
    dispatchCompatibleCharacterUpdateScoped(previousCharacter, char, previousState)
  }
}

export function getCharacterByIndex(index: number, options: CharacterSnapshotOptions = {}): character {
  const character = charactersResourceState.characters[index]
  return options.snapshot ? safeStructuredClone(character) : character
}

export function setCharacterByIndex(index: number, char: character) {
  const previousState = canUseServerCommands() ? currentCharacterRowSnapshot(index) : null
  const previousCharacter = previousState ? $state.snapshot(charactersResourceState.characters[index]) : undefined

  charactersResourceState.characters[index] = char
  if (previousState) {
    dispatchCompatibleCharacterUpdateScoped(previousCharacter, char, previousState)
  }
}

export function getCurrentChat() {
  const char = getCurrentCharacter()
  return char?.chats[char.chatPage]
}

export function setCurrentChat(chat: Chat) {
  // Replacing the active chat row only mutates that one chat, so the scoped
  // snapshot's single-chat clone serves as both the diff baseline and the
  // rollback — never a deep clone of the whole characters array.
  const previousState = canUseServerCommands() ? currentChatScopedSnapshot() : null
  const char = getCurrentCharacter()
  const previousChat = previousState?.chat
  char.chats[char.chatPage] = chat
  setCurrentCharacter(char, { dispatchServerCommand: false })
  if (previousState) {
    dispatchCompatibleChatUpdateScoped(previousChat, chat, previousState)
  }
}

export interface DynamicOutput {
  autoAdjustSchema: boolean
  dynamicMessages: boolean
  dynamicMemory: boolean
  dynamicResponseTiming: boolean
  dynamicOutputPrompt: boolean
  showTypingEffect: boolean
  dynamicRequest: boolean
}

export type InputHookModel = { mode: 'inheritOtherAx' } | { mode: 'modelProfile'; profileId: string }

export type InputHook = {
  id: string
  name: string
  type: 'draft' | 'btw'
  prompt: string
  /** Store the original composer text as the sent Draft message's translation. */
  translation?: boolean
  /** Missing on legacy hooks; omission inherits the Other Auxiliary model role. */
  model?: InputHookModel
}

export interface Database {
  characters: character[]
  apiType: string
  openAIKey: string
  proxyKey: string
  mainPrompt: string
  jailbreak: string
  globalNote: string
  temperature: number
  autoAcquireDisconnectedWriter: boolean
  askRemoval: boolean
  maxContext: number
  maxResponse: number
  frequencyPenalty: number
  PresensePenalty: number
  formatingOrder: FormatingOrderItem[]
  aiModel: string
  modelRoles: NormalizedModelRoleOverrides
  providerCredentials: ProviderCredentialRecord[]
  modelProfiles: ModelProfileRecord[]
  modelProfileOrder: ModelProfileOrderEntry[]
  modelRoleProfiles: ModelRoleProfileMap
  modelRuntimeDefaults: ModelProfileRecordRuntimeOptions
  agents: AgentRecord[]
  agentPresets: AgentPresetRecord[]
  agentPresetDefaultId?: string
  jailbreakToggle: boolean
  loreBookDepth: number
  loreBookToken: number
  agentContextEnabled?: boolean
  agentContextPrompt?: string
  agentContextMaxOutput?: number
  agentContextMaxToolRounds?: number
  cipherChat: boolean
  loreBook: {
    id: string
    name: string
    data: loreBook[]
  }[]
  loreBookPage: number
  username: string
  userIcon: string
  userNote: string
  additionalPrompt: string
  descriptionPrefix: string
  forceReplaceUrl: string
  language: string
  translator: string
  plugins: RisuPlugin[]
  currentPluginProvider: string
  zoomsize: number
  chatDisplayTailCount?: number
  chatLoadInitialPages?: number
  chatLoadAdditionalPages?: number
  customBackground: string
  textgenWebUIStreamURL: string
  textgenWebUIBlockingURL: string
  fullScreen: boolean
  playMessage: boolean
  iconsize: number
  theme: string
  subModel: string
  emotionPrompt: string
  formatversion: number
  waifuWidth: number
  waifuWidth2: number
  modelPresets: ModelPreset[]
  modelPresetsId: number
  promptPresets: PromptPreset[]
  promptPresetsId: number
  botPresets: botPreset[]
  botPresetsId: number
  sdProvider: string
  webUiUrl: string
  sdSteps: number
  sdCFG: number
  sdConfig: sdConfig
  NAIImgUrl: string
  NAIApiKey: string
  NAIImgModel: string
  NAII2I: boolean
  NAIREF: boolean
  NAIImgConfig: NAIImgConfig
  ttsAutoSpeech?: boolean
  promptPreprocess: boolean
  bias: [string, number][]
  swipe: boolean
  instantRemove: boolean
  textTheme: string
  customTextTheme: {
    FontColorStandard: string
    FontColorBold: string
    FontColorItalic: string
    FontColorItalicBold: string
    FontColorQuote1: string
    FontColorQuote2: string
  }
  requestRetrys: number
  requestHistoryLimit: number
  localNetworkMode: boolean
  localNetworkTimeoutSec: number
  emotionPrompt2: string
  useSayNothing: boolean
  didFirstSetup: boolean
  showUnrecommended: boolean
  doNotWarnExternalServers: boolean
  pluginCompatibilityMode: boolean
  strictScriptCheck: boolean
  complexRegexCompatibilityMode: 'strict' | 'worker'
  complexRegexInputTimeoutMs: number
  complexRegexOutputTimeoutMs: number
  complexRegexDisplayTimeoutMs: number
  regexOutputSizeLimitMiB: number
  elevenLabKey: string
  voicevoxUrl: string
  useExperimental: boolean
  showMemoryLimit: boolean
  roundIcons: boolean
  useStreaming: boolean
  halfStreaming: boolean
  supaMemoryKey: string
  hypaV3Key: string
  hypaMemoryKey: string
  voyageApiKey: string
  textScreenColor?: string
  textBorder?: boolean
  textScreenRounded?: boolean
  textScreenBorder?: string
  characterOrder: (string | folder)[]
  hordeConfig: hordeConfig
  novelai: {
    token: string
    model: string
  }
  globalscript: customscript[]
  sendWithEnter: boolean
  fixedChatTextarea: boolean
  floatingChatInput?: boolean
  clickToEdit: boolean
  disableAutoPopupMessageEditor: boolean
  useMonacoEditorOnDesktop?: boolean
  useMonacoEditorOnMobile?: boolean
  enableBlockPartialEdit: boolean
  enableDragPartialEdit: boolean
  koboldURL: string
  useAutoSuggestions: boolean
  autoSuggestPrompt: string
  autoSuggestPrefix: string
  autoSuggestClean: boolean
  claudeAPIKey: string
  useChatCopy: boolean
  novellistAPI: string
  useAutoTranslateInput: boolean
  imageCompression: boolean
  account?: {
    token: string
    id: string
    kei?: boolean
  }
  classicMaxWidth: boolean
  chatScreenWidth: number
  useChatSticker: boolean
  useAdditionalAssetsPreview: boolean
  usePlainFetch: boolean
  proxyRequestModel: string
  ooba: OobaSettings
  ainconfig: AINsettings
  personaPrompt: string
  openrouterRequestModel: string
  openrouterKey: string
  openrouterMiddleOut: boolean
  nanogptKey: string
  nanogptRequestModel: string
  nanogptRequestModelName: string
  nanogptProvider: string
  nanogptSubscriptionState: string
  nanogptUseSubscriptionEndpoint: boolean
  openrouterFallback: boolean
  selectedPersona: number
  selectedPersonaId: string | null
  personas: {
    personaPrompt: string
    name: string
    displayName?: string
    icon: string
    largePortrait?: boolean
    id?: string
    note?: string
    modules?: string[]
  }[]
  personaNote: boolean
  assetWidth: number
  animationSpeed: number
  reducedMotion: boolean
  hypaV3ProgressOpenChatOnly?: boolean
  botSettingAtStart: false
  NAIsettings: NAISettings
  hideRealm: boolean
  colorScheme: ColorScheme
  colorSchemeName: string
  customColorScheme: ColorScheme
  promptTemplate?: PromptItem[]
  /** Legacy prompt-template speaker wrapper, also used by sendName history formatting. */
  groupTemplate?: string
  /** Role assigned to history rows wrapped by groupTemplate/sendName. */
  groupOtherBotRole?: string
  forceProxyAsOpenAI?: boolean
  hypaModel: HypaModel
  saveTime?: number
  mancerHeader: string
  emotionProcesser: 'submodel' | 'embedding'
  showMenuChatList?: boolean
  translatorType: 'google' | 'deepl' | 'none' | 'llm' | 'deeplX'
  translatorInputLanguage?: string
  htmlTranslation?: boolean
  NAIadventure?: boolean
  NAIappendName?: boolean
  deeplOptions: {
    key: string
    freeApi: boolean
  }
  deeplXOptions: {
    url: string
    token: string
  }
  localStopStrings?: string[] | null
  autofillRequestUrl: boolean
  customProxyRequestModel: string
  generationSeed: number
  newOAIHandle: boolean
  gptVisionQuality: string
  reverseProxyOobaMode: boolean
  reverseProxyOobaArgs: OobaChatCompletionRequestParams | null
  huggingfaceKey: string
  fishSpeechKey: string
  allowAllExtentionFiles?: boolean
  translatorPrompt: string
  inputHooks: InputHook[]
  translatorMaxResponse: number
  translatorHistoryMaxTokens: number
  translatorPresets: TranslatorPreset[]
  /** Stable preset owner; numeric values are accepted only while loading legacy snapshots. */
  translatorPresetId: string | number
  top_p: number
  google: {
    accessToken: string
    projectId: string
  }
  mistralKey?: string
  chainOfThought?: boolean
  genTime: number
  promptSettings: PromptSettings | null
  keiServerURL: string
  top_k: number
  repetition_penalty: number
  min_p: number
  top_a: number
  claudeAws: boolean
  lastPatchNoteCheckVersion?: string
  removePunctuationHypa?: boolean
  memoryLimitThickness?: number
  modules: RisuModule[]
  enabledModules: string[]
  moduleFolders: import('@risuai/protocol/module-organization').ModuleFolder[]
  sideMenuRerollButton?: boolean
  requestInfoInsideChat?: boolean
  additionalParams: [string, string][]
  applyAdditionalParamsToAll: boolean
  heightMode: string
  noWaitForTranslate: boolean
  antiClaudeOverload: boolean
  ollamaURL: string
  ollamaModel: string
  ollamaModelSource: 'local' | 'cloud'
  ollamaInputMode: 'list' | 'manual'
  ollamaRequestFormat: LLMFormat
  ollamaApiKey: string
  ollamaModelName: string
  ollamaCloudModel: string
  ollamaCloudModelName: string
  ollamaThinkingMode: 'auto' | 'off' | 'on' | 'low' | 'medium' | 'high'
  autoContinueChat?: boolean
  autoContinueMinTokens?: number
  removeIncompleteResponse: boolean
  customTokenizer: string
  instructChatTemplate: string
  JinjaTemplate: string
  openrouterProvider: {
    order: string[]
    only: string[]
    ignore: string[]
  }
  useInstructPrompt: boolean
  textAreaSize: number
  sideBarSize: number
  desktopSidebarColumns: number
  mobileSidebarColumns: number
  textAreaTextSize: number
  combineTranslation: boolean
  dynamicAssets: boolean
  dynamicAssetsEditDisplay: boolean
  customPromptTemplateToggle: string
  globalChatVariables: { [key: string]: string }
  templateDefaultVariables: string
  cohereAPIKey: string
  goCharacterOnImport: boolean
  dallEQuality: string
  font: string
  customFont: string
  lineHeight: number
  paragraphBreakBySentences?: boolean
  paragraphBreakSentenceCount?: number
  stabilityModel: string
  stabilityKey: string
  stabllityStyle: string
  legacyTranslation: boolean
  comfyConfig: ComfyConfig
  comfyUiUrl: string
  useLegacyGUI: boolean
  claudeCachingExperimental: boolean
  hideApiKey: boolean
  unformatQuotes: boolean
  enableDevTools: boolean
  falToken: string
  falModel: string
  falLora: string
  falLoraName: string
  falLoraScale: number
  moduleIntergration: string
  customCSS: string
  jsonSchemaEnabled: boolean
  jsonSchema: string
  strictJsonSchema: boolean
  extractJson: string
  statics: {
    messages: number
    imports: number
  }
  customQuotes: boolean
  customQuotesData?: [string, string, string, string]
  customGUI: string
  guiHTML: string
  OAIPrediction: string
  customAPIFormat: LLMFormat
  systemContentReplacement: string
  systemRoleReplacement: 'user' | 'assistant'
  vertexPrivateKey: string
  vertexClientEmail: string
  vertexAccessToken: string
  vertexAccessTokenExpires: number
  vertexRegion: string
  seperateParametersEnabled: boolean
  seperateParameters: {
    memory: SeparateParameters
    emotion: SeparateParameters
    translate: SeparateParameters
    otherAx: SeparateParameters
    scriptMain: SeparateParameters
    scriptAux: SeparateParameters
    overrides: Record<string, SeparateParameters>
  }
  translateBeforeHTMLFormatting: boolean
  translatorSendTextAsIs: boolean
  translatorExcludeThoughts: boolean
  autoTranslateCachedOnly: boolean
  notification: boolean
  autoTranslateNotificationDeferCapSeconds: number
  customFlags: LLMFlags[]
  enableCustomFlags: boolean
  googleClaudeTokenizing: boolean
  presetChain: string
  legacyMediaFindings?: boolean
  geminiStream?: boolean
  assetMaxDifference: number
  auxModelUnderModelSettings: boolean
  menuSideBar: boolean
  pluginV2: RisuPlugin[]
  showSavingIcon: boolean
  presetRegex: customscript[]
  banCharacterset: string[]
  showPromptComparison: boolean
  hypaV3: boolean
  bardWiki: BardWikiGlobalSettings
  memoryAlgorithmType?: string
  supaModelType?: string
  hypaMemory?: boolean
  hypav2?: boolean
  hanuraiEnable?: boolean
  legacyMemoryMigrationNoticeDismissed?: boolean
  hypaV3Settings: HypaV3Settings // legacy
  hypaV3Presets: HypaV3Preset[]
  selectedHypaV3PresetId: string | null
  hypaV3PresetId: number
  realmDirectOpen: boolean
  OaiCompAPIKeys: { [key: string]: string }
  inlayErrorResponse: boolean
  reasoningEffort: number
  bulkEnabling: boolean
  showTranslationLoading: boolean
  showDeprecatedTriggerV1: boolean
  showDeprecatedTriggerV2: boolean
  returnCSSError: boolean
  checkCorruption?: boolean
  toggleConfirmRecommendedPreset?: boolean
  useExperimentalGoogleTranslator: boolean
  thinkingTokens: number | null
  thinkingType: 'off' | 'budget' | 'adaptive'
  deepseekThinkingType: 'off' | 'enabled'
  adaptiveThinkingEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  deepseekReasoningEffort: 'high' | 'max'
  antiServerOverloads: boolean
  hypaCustomSettings: {
    url: string
    key: string
    model: string
  }
  localActivationInGlobalLorebook: boolean
  showFolderName: boolean
  automaticCachePoint: boolean
  coldstorage: boolean
  claudeRetrivalCaching: boolean
  outputImageModal: boolean
  playMessageOnTranslateEnd: boolean
  seperateModelsForAxModels: boolean
  seperateModels: LegacySeperateModelMap | null
  doNotChangeSeperateModels: boolean
  modelTools: string[]
  hotkeys: Hotkey[]
  fallbackModels: LegacyFallbackModelMap
  doNotChangeFallbackModels: boolean
  fallbackWhenBlankResponse: boolean
  customModels: {
    id: string
    internalId: string
    url: string
    format: LLMFormat
    tokenizer: LLMTokenizer
    key: string
    name: string
    params: string
    flags: LLMFlags[]
  }[]
  igpPrompt: string
  useTokenizerCaching: boolean
  showMenuHypaMemoryModal: boolean
  authRefreshes: {
    url: string
    tokenUrl: string
    refreshToken: string
    clientId: string
    clientSecret: string
  }[]
  promptInfoInsideChat: boolean
  promptTextInfoInsideChat: boolean
  openAIFlexProcessing: boolean
  claudeBatching: boolean
  claude1HourCaching: boolean
  rememberToolUsage: boolean
  simplifiedToolUse: boolean
  requestLocation: string
  newImageHandlingBeta?: boolean
  showFirstMessagePages: boolean
  streamGeminiThoughts: boolean
  verbosity: number
  dynamicOutput?: DynamicOutput | null
  hubServerType?: string
  pluginCustomStorage: { [key: string]: any }
  ImagenModel: string
  ImagenImageSize: string
  ImagenAspectRatio: string
  ImagenPersonGeneration: string
  enableScrollToActiveChar: boolean
  openaiCompatImage: {
    url: string
    key: string
    model: string
    size: string
    quality: string
  }
  wavespeedImage: {
    key: string
    model: string
    loras: Array<{ path: string; scale: number }>
    reference_mode: string
    reference_image: string
    reference_base64image: string
  }
  settingsCloseButtonSize: number
  promptDiffPrefs: PromptDiffPrefs
  enableBookmark?: boolean
  hideAllImages?: boolean
  autoScrollToNewMessage?: boolean
  alwaysScrollToNewMessage?: boolean
  newMessageButtonStyle?: string
  pluginDevelopMode?: boolean
  echoMessage?: string
  echoDelay?: number
  /** Enables `globalLore` stubs for non-open characters; hydrate before reading lore. */
  enableLorebookStubs?: boolean
  showGlobalLorebookAndRegex?: boolean
  createFolderOnBranch?: boolean
  hamburgerButtonBottom?: boolean
  enableRemoteSaving?: boolean
  blockquoteStyling?: boolean
  dynamicModelRegistry?: boolean
  enableRisuaiProTools?: boolean
  epEnabled?: boolean
  seperateParametersByModel?: boolean
  disableSeperateParameterChangeOnPresetChange?: boolean
  saveSignatures?: boolean
  keepSessionAlive: 'off' | 'sound'
  longPressToPopupEditor?: boolean
  chatGenerationTogglePresets: ChatGenerationTogglePreset[]
  loadouts: Loadout[]
  disableAprilFools?: boolean
  customSidebarItems: CustomSideBarItem[]
  lastLoadedLoadoutName: string
}

export interface CustomSideBarItem {
  id: string
  type: 'model' | 'loadout' | 'setting'
  subType: string
  label: string
}

const CUSTOM_SIDEBAR_ITEM_TYPES = new Set(['model', 'loadout', 'setting'])

function normalizeCustomSidebarItems(value: unknown): CustomSideBarItem[] {
  if (!Array.isArray(value)) return []
  const normalized: CustomSideBarItem[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (record.type === 'preset' || record.type === 'persona') continue
    if (
      typeof record.id !== 'string' ||
      typeof record.type !== 'string' ||
      !CUSTOM_SIDEBAR_ITEM_TYPES.has(record.type) ||
      typeof record.subType !== 'string' ||
      typeof record.label !== 'string'
    ) {
      continue
    }
    if (record.type === 'setting' && record.subType.trim() === '') continue
    normalized.push({
      id: record.id,
      type: record.type as CustomSideBarItem['type'],
      subType: record.subType,
      label: record.label,
    })
  }
  return normalized
}

export interface SeparateParameters {
  temperature?: number
  top_k?: number
  repetition_penalty?: number
  min_p?: number
  top_a?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  reasoning_effort?: number
  thinking_tokens?: number
  thinking_type?: 'off' | 'budget' | 'adaptive'
  deepseek_thinking_type?: 'off' | 'enabled'
  adaptive_thinking_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  deepseek_reasoning_effort?: 'high' | 'max'
  outputImageModal?: boolean
  verbosity?: number
}

type OutputModal = 'image' | 'audio' | 'video'

export interface customscript {
  id?: string
  comment: string
  in: string
  out: string
  type: string
  flag?: string
  ableFlag?: boolean
}

export type triggerscript = triggerscriptMain

export interface loreBook {
  key: string
  secondkey: string
  insertorder: number
  comment: string
  content: string
  mode: 'multiple' | 'constant' | 'normal' | 'child' | 'folder'
  alwaysActive: boolean
  selective: boolean
  extentions?: {
    risu_case_sensitive: boolean
    risu_agent_only?: boolean
  }
  /** Excludes this entry from normal prompt activation and reserves it for Agent input resolution. */
  agentOnly?: boolean
  activationPercent?: number | null
  loreCache?: {
    key: string
    data: string[]
  } | null
  useRegex?: boolean
  bookVersion?: number
  id?: string
  folder?: string
}

export interface character {
  type?: 'character'
  name: string
  displayName?: string
  image?: string
  notificationImage?: string
  firstMessage: string
  customNotificationMessage?: string
  desc: string
  notes: string
  chats: Chat[]
  chatFolders: ChatFolder[]
  chatPage: number
  viewScreen: 'emotion' | 'none' | 'imggen'
  bias: [string, number][]
  emotionImages: [string, string][]
  globalLore: loreBook[]
  chaId: string
  sdData: [string, string][]
  newGenData?: {
    prompt: string
    negative: string
    instructions: string
    emotionInstructions: string
  }
  customscript: customscript[]
  triggerscript: triggerscript[]
  utilityBot: boolean
  exampleMessage: string
  removedQuotes?: boolean
  creatorNotes: string
  systemPrompt: string
  postHistoryInstructions: string
  alternateGreetings: string[]
  tags: string[]
  creator: string
  characterVersion: string
  personality: string
  scenario: string
  firstMsgIndex: number
  loreSettings?: loreSettings
  loreExt?: any
  additionalData?: {
    tag?: string[]
    creator?: string
    character_version?: string
  }
  ttsMode?: string
  ttsSpeech?: string
  voicevoxConfig?: {
    speaker?: string
    SPEED_SCALE?: number
    PITCH_SCALE?: number
    INTONATION_SCALE?: number
    VOLUME_SCALE?: number
  }
  naittsConfig?: {
    customvoice?: boolean
    voice?: string
    version?: string
  }
  gptSoVitsConfig?: {
    url?: string
    use_auto_path?: boolean
    ref_audio_path?: string
    use_long_audio?: boolean
    ref_audio_data?: {
      fileName: string
      assetId: string
    }
    volume?: number
    text_lang?: 'auto' | 'auto_yue' | 'en' | 'zh' | 'ja' | 'yue' | 'ko' | 'all_zh' | 'all_ja' | 'all_yue' | 'all_ko'
    text?: string
    use_prompt?: boolean
    prompt?: string | null
    prompt_lang?: 'auto' | 'auto_yue' | 'en' | 'zh' | 'ja' | 'yue' | 'ko' | 'all_zh' | 'all_ja' | 'all_yue' | 'all_ko'
    top_p?: number
    temperature?: number
    speed?: number
    top_k?: number
    text_split_method?: 'cut0' | 'cut1' | 'cut2' | 'cut3' | 'cut4' | 'cut5'
  }
  fishSpeechConfig?: {
    model?: {
      _id: string
      title: string
      description: string
    }
    chunk_length: number
    normalize: boolean
  }
  supaMemory?: boolean
  additionalAssets?: [string, string, string][]
  ttsReadOnlyQuoted?: boolean
  replaceGlobalNote: string
  backgroundHTML?: string
  reloadKeys?: number
  backgroundCSS?: string
  license?: string
  private?: boolean
  additionalText: string
  oaiVoice?: string
  oaiTTSConfig?: {
    /** User opted into advanced OpenAI-compatible settings. When false/absent,
     *  tts.ts ignores the other fields and uses the legacy oaiVoice + db.openAIKey path. */
    enabled?: boolean
    /** Base URL, trailing slash trimmed at runtime. Falls back to 'https://api.openai.com/v1'. */
    baseURL?: string
    /** Per-character API key. Falls back to db.openAIKey; the Authorization header is omitted entirely when both are empty. */
    apiKey?: string
    /** Model ID. Falls back to 'tts-1'. */
    model?: string
    /** Freeform voice ID for custom endpoints. Falls back to character.oaiVoice, then to 'alloy'. */
    voice?: string
    /** Response format. Falls back to 'mp3'. */
    format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
  }
  virtualscript?: string
  scriptstate?: { [key: string]: string | number | boolean }
  depth_prompt?: { depth: number; prompt: string }
  extentions?: { [key: string]: any }
  largePortrait?: boolean
  lorePlus?: boolean
  inlayViewScreen?: boolean
  hfTTS?: {
    model: string
    language: string
  }
  vits?: OnnxModelFiles
  realmId?: string
  imported?: boolean
  trashTime?: number
  nickname?: string
  source?: string[]
  group_only_greetings?: string[]
  creation_date?: number
  modification_date?: number
  ccAssets?: Array<{
    type: string
    uri: string
    name: string
    ext: string
  }>
  defaultVariables?: string
  lowLevelAccess?: boolean
  /** Local-only model-profile selections for character-owned script LLM calls. */
  scriptModelOverrides?: ScriptModelOverrides
  hideChatIcon?: boolean
  lastInteraction?: number
  translatorNote?: string
  doNotChangeSeperateModels?: boolean
  escapeOutput?: boolean
  prebuiltAssetCommand?: boolean
  prebuiltAssetStyle?: string
  prebuiltAssetExclude?: string[]
  modules?: string[]
  coldstorage?: string
  coldStoragedChats?: string[]
}

export interface loreSettings {
  tokenBudget: number
  scanDepth: number
  recursiveScanning: boolean
  fullWordMatching?: boolean
}

export interface botPreset {
  id?: string
  name?: string
  apiType?: string
  openAIKey?: string
  localNetworkMode?: boolean
  localNetworkTimeoutSec?: number
  additionalParams?: [string, string][]
  mainPrompt: string
  jailbreak: string
  globalNote: string
  temperature: number
  maxContext: number
  maxResponse: number
  frequencyPenalty: number
  PresensePenalty: number
  formatingOrder: FormatingOrderItem[]
  aiModel?: string
  subModel?: string
  modelRoles?: NormalizedModelRoleOverrides
  modelProfiles?: ModelProfileRecord[]
  modelProfileOrder?: ModelProfileOrderEntry[]
  modelRoleProfiles?: ModelRoleProfileMap
  modelRuntimeDefaults?: ModelProfileRecordRuntimeOptions
  agents?: AgentRecord[]
  agentPresets?: AgentPresetRecord[]
  agentPresetDefaultId?: string
  currentPluginProvider?: string
  textgenWebUIStreamURL?: string
  textgenWebUIBlockingURL?: string
  forceReplaceUrl?: string
  forceReplaceUrl2?: string
  promptPreprocess: boolean
  bias: [string, number][]
  proxyRequestModel?: string
  openrouterRequestModel?: string
  proxyKey?: string
  ooba: OobaSettings
  ainconfig: AINsettings
  koboldURL?: string
  NAISettings?: NAISettings
  autoSuggestPrompt?: string
  autoSuggestPrefix?: string
  autoSuggestClean?: boolean
  promptTemplate?: PromptItem[]
  groupTemplate?: string
  groupOtherBotRole?: string
  NAIadventure?: boolean
  NAIappendName?: boolean
  localStopStrings?: string[] | null
  customProxyRequestModel?: string
  reverseProxyOobaArgs?: OobaChatCompletionRequestParams | null
  top_p?: number
  promptSettings?: PromptSettings | null
  repetition_penalty?: number
  min_p?: number
  top_a?: number
  openrouterProvider?: {
    order: string[]
    only: string[]
    ignore: string[]
  }
  useInstructPrompt?: boolean
  customPromptTemplateToggle?: string
  templateDefaultVariables?: string
  moduleIntergration?: string
  top_k?: number
  instructChatTemplate?: string
  JinjaTemplate?: string
  jsonSchemaEnabled?: boolean
  jsonSchema?: string
  strictJsonSchema?: boolean
  extractJson?: string
  seperateParametersEnabled?: boolean
  seperateParameters?: {
    memory: SeparateParameters
    emotion: SeparateParameters
    translate: SeparateParameters
    otherAx: SeparateParameters
    scriptMain: SeparateParameters
    scriptAux: SeparateParameters
    overrides: Record<string, SeparateParameters>
  }
  customAPIFormat?: LLMFormat
  systemContentReplacement?: string
  systemRoleReplacement?: 'user' | 'assistant'
  agentContextEnabled?: boolean
  agentContextPrompt?: string
  agentContextMaxOutput?: number
  agentContextMaxToolRounds?: number
  enableCustomFlags?: boolean
  customFlags?: LLMFlags[]
  image?: string
  regex?: customscript[]
  reasonEffort?: number
  thinkingTokens?: number | null
  thinkingType?: 'off' | 'budget' | 'adaptive'
  deepseekThinkingType?: 'off' | 'enabled'
  adaptiveThinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  deepseekReasoningEffort?: 'high' | 'max'
  outputImageModal?: boolean
  seperateModelsForAxModels?: boolean
  seperateModels?: LegacySeperateModelMap | null
  modelTools?: string[]
  fallbackModels?: LegacyFallbackModelMap
  fallbackWhenBlankResponse?: boolean
  verbosity?: number
  dynamicOutput?: DynamicOutput | null
}

export type ModelPreset = Partial<botPreset> & {
  id?: string
  name?: string
}

export type PromptPreset = Partial<botPreset> & {
  id?: string
  name?: string
  archived?: boolean
  overrideModelParameters?: boolean
  recommendedModelPresetId?: string | null
}

interface hordeConfig {
  apiKey: string
  model: string
  softPrompt: string
}

export interface folder {
  name: string
  data: string[]
  color: string
  id: string
  askBeforeOpening?: boolean
  imgFile?: string
  img?: string
}

interface sdConfig {
  width: number
  height: number
  sampler_name: string
  script_name: string
  denoising_strength: number
  enable_hr: boolean
  hr_scale: number
  hr_upscaler: string
}

export interface NAIImgConfig {
  width: number
  height: number
  sampler: string
  noise_schedule: string
  steps: number
  scale: number
  cfg_rescale: number
  sm: boolean
  sm_dyn: boolean
  noise: number
  strength: number
  image: string
  base64image: string
  InfoExtracted: number
  autoSmea: boolean
  use_coords: boolean
  legacy_uc: boolean
  v4_prompt: NAIImgConfigV4Prompt
  v4_negative_prompt: NAIImgConfigV4NegativePrompt
  reference_image_multiple?: string[]
  reference_strength_multiple?: number[]
  vibe_data?: NAIVibeData
  vibe_model_selection?: string
  variety_plus: boolean
  decrisp: boolean
  reference_mode: string
  character_image: string
  character_base64image: string
  style_aware: boolean
}

interface NAIImgConfigV4Prompt {
  caption: NAIImgConfigV4Caption
  use_coords: boolean
  use_order: boolean
}
interface NAIImgConfigV4NegativePrompt {
  caption: NAIImgConfigV4Caption
  legacy_uc: boolean
}
interface NAIImgConfigV4Caption {
  base_caption: string
  char_captions: NAIImgConfigV4CharCaption[]
}
interface NAIImgConfigV4CharCaption {
  char_caption: string
  centers: {
    x: number
    y: number
  }[]
}

// NAI Vibe Data interfaces
interface NAIVibeData {
  identifier: string
  version: number
  type: string
  image: string
  id: string
  encodings: {
    [key: string]: {
      [key: string]: NAIVibeEncoding
    }
  }
  name: string
  thumbnail: string
  createdAt: number
  importInfo: {
    model: string
    information_extracted: number
    strength: number
  }
}

interface NAIVibeEncoding {
  encoding: string
  params: {
    information_extracted: number
  }
}

interface ComfyConfig {
  workflow: string
  posNodeID: string
  posInputName: string
  negNodeID: string
  negInputName: string
  timeout: number
}

export type FormatingOrderItem =
  | 'main'
  | 'jailbreak'
  | 'chats'
  | 'lorebook'
  | 'globalNote'
  | 'authorNote'
  | 'lastChat'
  | 'description'
  | 'postEverything'
  | 'personaPrompt'

export interface Chat {
  message: Message[]
  note: string
  name: string
  localLore: loreBook[]
  generationSettings?: ChatGenerationSettings
  sdData?: string
  lastMemory?: string
  hypaContextTruncationAcknowledged?: boolean
  suggestMessages?: string[]
  isStreaming?: boolean
  scriptstate?: { [key: string]: string | number | boolean }
  modules?: string[]
  id?: string
  bindedPersona?: string
  fmIndex?: number
  selectedDraftHookId?: string
  translatorPresetId?: string
  autoTranslate?: boolean
  autoTranslateBotOnly?: boolean
  bilingualDisplay?: boolean
  bilingualEmphasis?: 'original' | 'translation'
  hypaV3Data?: SerializableHypaV3Data
  folderId?: string
  lastDate?: number
  bookmarks?: string[]
  bookmarkNames?: { [chatId: string]: string }
  pinned?: boolean
}

export interface ChatFolder {
  id: string
  name?: string
  color?: string
  folded: boolean
}

export interface Message {
  role: 'user' | 'char'
  data: string
  translation?: MessageTranslation | null
  saying?: string
  chatId?: string
  time?: number
  generationInfo?: MessageGenerationInfo
  promptInfo?: MessagePresetInfo
  name?: string
  otherUser?: boolean
  disabled?: false | true | 'allBefore'
  isComment?: boolean
}

export interface MessageTranslation {
  text: string
  source: 'raw'
  sourceHash: string
  targetLanguage: string
  inputLanguage: string
  translatorType: 'google' | 'deepl' | 'deeplX' | 'llm'
  settingsHash: string
  updatedAt: number
}

export interface MessageGenerationInfo {
  model?: string
  generationId?: string
  databaseLineage?: string
  operationId?: string
  acceptedMessageId?: string
  attemptNo?: number
  jobId?: string
  effectLedgerKeyType?: 'operation' | 'generation'
  effectLedgerKeyId?: string
  effectLedgerCharacterId?: string
  effectLedgerChatId?: string
  inputTokens?: number
  outputTokens?: number
  maxContext?: number
  agentPreset?: Record<string, unknown>
  stageTiming?: {
    stage1?: number
    stage2?: number
    stage3?: number
    stage4?: number
  }
}

export interface MessagePresetInfo {
  promptName?: string
  promptToggles?: { key: string; value: string }[]
  promptText?: OpenAIChat[]
}

export interface PromptDiffPrefs {
  diffStyle: 'line' | 'intraline'
  formatStyle: 'raw' | 'card'
  viewStyle: 'unified' | 'split'
  isGrouped: boolean
  showOnlyChanges: boolean
  contextRadius: number
}

interface AINsettings {
  top_p: number
  rep_pen: number
  top_a: number
  rep_pen_slope: number
  rep_pen_range: number
  typical_p: number
  badwords: string
  stoptokens: string
  top_k: number
}

export interface OobaSettings {
  max_new_tokens: number
  do_sample: boolean
  temperature: number
  top_p: number
  typical_p: number
  repetition_penalty: number
  encoder_repetition_penalty: number
  top_k: number
  min_length: number
  no_repeat_ngram_size: number
  num_beams: number
  penalty_alpha: number
  length_penalty: number
  early_stopping: boolean
  seed: number
  add_bos_token: boolean
  truncation_length: number
  ban_eos_token: boolean
  skip_special_tokens: boolean
  top_a: number
  tfs: number
  epsilon_cutoff: number
  eta_cutoff: number
  formating: {
    header: string
    systemPrefix: string
    userPrefix: string
    assistantPrefix: string
    seperator: string
    useName: boolean
  }
}

export const saveImage = saveImageGlobal

export const defaultAIN: AINsettings = {
  top_p: 0.7,
  rep_pen: 1.0625,
  top_a: 0.08,
  rep_pen_slope: 1.7,
  rep_pen_range: 1024,
  typical_p: 1.0,
  badwords: '',
  stoptokens: '',
  top_k: 140,
}

export const defaultOoba: OobaSettings = {
  max_new_tokens: 180,
  do_sample: true,
  temperature: 0.7,
  top_p: 0.9,
  typical_p: 1,
  repetition_penalty: 1.15,
  encoder_repetition_penalty: 1,
  top_k: 20,
  min_length: 0,
  no_repeat_ngram_size: 0,
  num_beams: 1,
  penalty_alpha: 0,
  length_penalty: 1,
  early_stopping: false,
  seed: -1,
  add_bos_token: true,
  truncation_length: 4096,
  ban_eos_token: false,
  skip_special_tokens: true,
  top_a: 0,
  tfs: 1,
  epsilon_cutoff: 0,
  eta_cutoff: 0,
  formating: {
    header: 'Below is an instruction that describes a task. Write a response that appropriately completes the request.',
    systemPrefix: '### Instruction:',
    userPrefix: '### Input:',
    assistantPrefix: '### Response:',
    seperator: '',
    useName: false,
  },
}

export const presetTemplate: botPreset = {
  name: 'New Preset',
  apiType: 'gemini-3-flash-preview',
  openAIKey: '',
  localNetworkMode: false,
  localNetworkTimeoutSec: 600,
  mainPrompt: defaultMainPrompt,
  jailbreak: defaultJailbreak,
  globalNote: '',
  temperature: 80,
  maxContext: 4000,
  maxResponse: 300,
  frequencyPenalty: 70,
  PresensePenalty: 70,
  formatingOrder: [
    'main',
    'description',
    'personaPrompt',
    'chats',
    'lastChat',
    'jailbreak',
    'lorebook',
    'globalNote',
    'authorNote',
  ],
  aiModel: 'gemini-3-flash-preview',
  subModel: 'gemini-3-flash-preview',
  modelRoles: createDefaultModelRoleOverrides(),
  currentPluginProvider: '',
  textgenWebUIStreamURL: '',
  textgenWebUIBlockingURL: '',
  forceReplaceUrl: '',
  forceReplaceUrl2: '',
  promptPreprocess: false,
  proxyKey: '',
  bias: [],
  ooba: safeStructuredClone(defaultOoba),
  ainconfig: safeStructuredClone(defaultAIN),
  reverseProxyOobaArgs: {
    mode: 'instruct',
  },
  top_p: 1,
  useInstructPrompt: false,
  verbosity: 1,
}

const defaultSdData: [string, string][] = [
  ['always', 'solo, 1girl'],
  ['negative', ''],
  ["|character\'s appearance", ''],
  ['current situation', ''],
  ["$character's pose", ''],
  ["$character's emotion", ''],
  ['current location', ''],
]

export const defaultSdDataFunc = () => {
  return safeStructuredClone(defaultSdData)
}

function saveCurrentPresetLocal(apply = true) {
  let db = settingsResourceState.value as Database
  normalizeLegacyPresetOwner()
  let pres = legacyPresetOwner()

  if (settingsOwnerRecord().botPresetsId === -1) {
    return null
  }
  pres[settingsOwnerRecord().botPresetsId].id ??= createClientPresetId()
  const savedPreset: botPreset = {
    id: pres[settingsOwnerRecord().botPresetsId].id,
    name: pres[settingsOwnerRecord().botPresetsId].name,
    apiType: db.apiType,
    openAIKey: db.openAIKey,
    localNetworkMode: db.localNetworkMode,
    localNetworkTimeoutSec: db.localNetworkTimeoutSec,
    additionalParams: safeStructuredClone(db.additionalParams),
    mainPrompt: db.mainPrompt,
    jailbreak: db.jailbreak,
    globalNote: db.globalNote,
    temperature: db.temperature,
    maxContext: db.maxContext,
    maxResponse: db.maxResponse,
    frequencyPenalty: db.frequencyPenalty,
    PresensePenalty: db.PresensePenalty,
    formatingOrder: db.formatingOrder,
    aiModel: db.aiModel,
    subModel: db.subModel,
    modelRoles: safeStructuredClone(db.modelRoles),
    modelProfiles: safeStructuredClone(db.modelProfiles),
    modelProfileOrder: safeStructuredClone(db.modelProfileOrder),
    modelRoleProfiles: safeStructuredClone(db.modelRoleProfiles),
    modelRuntimeDefaults: safeStructuredClone(normalizeModelRuntimeDefaults(db.modelRuntimeDefaults)),
    agents: safeStructuredClone(db.agents),
    agentPresets: safeStructuredClone(db.agentPresets),
    agentPresetDefaultId: db.agentPresetDefaultId,
    currentPluginProvider: db.currentPluginProvider,
    textgenWebUIStreamURL: db.textgenWebUIStreamURL,
    textgenWebUIBlockingURL: db.textgenWebUIBlockingURL,
    forceReplaceUrl: db.forceReplaceUrl,
    promptPreprocess: db.promptPreprocess,
    bias: db.bias,
    koboldURL: db.koboldURL,
    proxyKey: db.proxyKey,
    ooba: safeStructuredClone(db.ooba),
    ainconfig: safeStructuredClone(db.ainconfig),
    proxyRequestModel: db.proxyRequestModel,
    openrouterRequestModel: db.openrouterRequestModel,
    NAISettings: safeStructuredClone(db.NAIsettings),
    NAIadventure: db.NAIadventure ?? false,
    NAIappendName: db.NAIappendName ?? false,
    localStopStrings: db.localStopStrings,
    autoSuggestPrompt: db.autoSuggestPrompt,
    customProxyRequestModel: db.customProxyRequestModel,
    reverseProxyOobaArgs: safeStructuredClone(db.reverseProxyOobaArgs) ?? null,
    top_p: db.top_p ?? 1,
    promptSettings: safeStructuredClone(db.promptSettings) ?? null,
    repetition_penalty: db.repetition_penalty,
    min_p: db.min_p,
    top_a: db.top_a,
    openrouterProvider: db.openrouterProvider,
    useInstructPrompt: db.useInstructPrompt,
    customPromptTemplateToggle: db.customPromptTemplateToggle ?? '',
    templateDefaultVariables: db.templateDefaultVariables ?? '',
    moduleIntergration: db.moduleIntergration ?? '',
    top_k: db.top_k,
    instructChatTemplate: db.instructChatTemplate,
    JinjaTemplate: db.JinjaTemplate ?? '',
    jsonSchemaEnabled: db.jsonSchemaEnabled ?? false,
    jsonSchema: db.jsonSchema ?? '',
    strictJsonSchema: db.strictJsonSchema ?? true,
    extractJson: db.extractJson ?? '',
    seperateParametersEnabled: db.seperateParametersEnabled ?? false,
    seperateParameters: safeStructuredClone(db.seperateParameters),
    customAPIFormat: safeStructuredClone(db.customAPIFormat),
    systemContentReplacement: db.systemContentReplacement,
    systemRoleReplacement: db.systemRoleReplacement,
    customFlags: safeStructuredClone(db.customFlags),
    enableCustomFlags: db.enableCustomFlags,
    regex: db.presetRegex,
    image: pres?.[settingsOwnerRecord().botPresetsId]?.image ?? '',
    reasonEffort: db.reasoningEffort ?? 0,
    thinkingTokens: db.thinkingTokens ?? null,
    thinkingType: db.thinkingType ?? 'budget',
    deepseekThinkingType: db.deepseekThinkingType ?? 'off',
    adaptiveThinkingEffort: db.adaptiveThinkingEffort ?? 'high',
    deepseekReasoningEffort: db.deepseekReasoningEffort ?? 'high',
    outputImageModal: db.outputImageModal ?? false,
    seperateModelsForAxModels: db.doNotChangeSeperateModels ? false : (db.seperateModelsForAxModels ?? false),
    seperateModels: db.doNotChangeSeperateModels ? null : safeStructuredClone(db.seperateModels),
    modelTools: safeStructuredClone(db.modelTools),
    fallbackModels: safeStructuredClone(db.fallbackModels),
    fallbackWhenBlankResponse: db.fallbackWhenBlankResponse ?? false,
    verbosity: db.verbosity ?? 1,
    dynamicOutput: db.dynamicOutput ?? null,
  }
  if (!apply) return savedPreset
  applyCurrentPresetSnapshot(savedPreset)
  return savedPreset
}

function applyCurrentPresetSnapshot(savedPreset: botPreset): void {
  const db = settingsResourceState.value as Database
  let pres = legacyPresetOwner()
  if (!Array.isArray(pres)) pres = []
  //if out of bounds, create a new preset
  if (settingsOwnerRecord().botPresetsId >= pres.length) {
    pres.push(savedPreset)
  } else {
    pres[settingsOwnerRecord().botPresetsId] = savedPreset
  }
  assignLegacyPresetOwner(pres)
}

export function saveCurrentPreset() {
  ;(() => {
    const { savedPreset, rollback, sparseBaseline } = saveCurrentPresetLocalWithRollback({ apply: false })
    if (!savedPreset?.id) return []
    const commandPatch = legacyPresetSaveCommandPatch(savedPreset, sparseBaseline)
    if (!commandPatch) return []
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    const wirePatch = exactJsonRecordClone(commandPatch)
    const expectedPreset =
      sparseBaseline && wirePatch
        ? exactJsonRecordClone({
            ...sparseBaseline.preset,
            ...wirePatch,
            id: savedPreset.id,
          })
        : null
    const savedPresetProjection = exactJsonRecordCloneOmittingUndefined(savedPreset)
    const acknowledgedPreset =
      expectedPreset && savedPresetProjection && exactJsonValuesEqual(expectedPreset, savedPresetProjection)
        ? expectedPreset
        : null
    applyCurrentPresetSnapshot((acknowledgedPreset ?? savedPreset) as botPreset)
    const presetIndex = canonicalBotPresetIndexById(savedPreset.id)
    const livePreset = presetIndex >= 0 ? legacyPresetOwner()[presetIndex] : undefined
    const optimisticAcknowledgement =
      wirePatch && acknowledgedPreset && livePreset
        ? legacyPresetPatchOptimisticAcknowledgement({
            preset: livePreset as unknown as Record<string, unknown>,
            wirePatch,
            collectionProjectionEpoch,
            expectedPreset: acknowledgedPreset,
          })
        : null
    if (!rollback || !livePreset) return []
    const entry = legacyPresetEntryFromFieldRollback(rollback, safeStructuredClone(livePreset), presetIndex)
    const attempt = createPresetRowMutationAttempt([entry])
    const durableIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: `/presets/${encodeURIComponent(savedPreset.id)}`,
          body: { patch: safeStructuredClone(commandPatch) },
        },
      ],
    }
    const prepared = preparePresetMutation(durableIntent, [presetRowProjectionTarget(entry)])
    dispatchPresetRowMutation(
      prepared,
      attempt,
      (baseRevision) =>
        updatePresetCommand({
          baseRevision,
          presetId: savedPreset.id!,
          patch: safeStructuredClone(commandPatch) as PresetSnapshot,
          ...(optimisticAcknowledgement ? { optimisticAcknowledgement } : {}),
        }),
      () => {
        markCollectionAcknowledgementTainted('botPresets')
      },
    )
  })()
}

export function copyPreset(id: number) {
  const target = (() => {
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    const preset = legacyPresetOwner()[id]
    return preset?.id
      ? {
          presetId: preset.id,
          hydrated: botPresetHasHydratedSettings(preset),
        }
      : null
  })()
  if (!target) return
  if (!target.hydrated) {
    void ensureBotPresetHydratedById(target.presetId).then((hydrated) => {
      if (hydrated) copyPresetById(target.presetId)
    })
    return
  }
  copyPresetById(target.presetId)
}

function copyPresetById(sourcePresetId: string): void {
  ;(() => {
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    const initialSourceIndex = canonicalBotPresetIndexById(sourcePresetId)
    if (initialSourceIndex < 0 || !botPresetHasHydratedSettings(legacyPresetOwner()[initialSourceIndex])) return []
    const { rollback: saveCurrentRollback } = saveCurrentPresetLocalWithRollback()
    normalizeLegacyPresetOwner()
    const sourceIndex = canonicalBotPresetIndexById(sourcePresetId)
    const sourcePreset = sourceIndex >= 0 ? legacyPresetOwner()[sourceIndex] : undefined
    if (!botPresetHasHydratedSettings(sourcePreset)) return []
    const newPres = safeStructuredClone(sourcePreset)
    if (!newPres?.id) return []
    newPres.id = createClientPresetId()
    newPres.name += ' Copy'
    legacyPresetOwner().push(newPres)
    const attemptedCopy = safeStructuredClone(newPres)
    const entries: PresetRowMutationEntry[] = [
      {
        kind: 'legacy',
        key: newPres.id,
        previous: null,
        attempted: attemptedCopy,
      },
    ]
    if (saveCurrentRollback) {
      const savedSourceIndex = canonicalBotPresetIndexById(saveCurrentRollback.presetId)
      const savedSourcePreset = savedSourceIndex >= 0 ? legacyPresetOwner()[savedSourceIndex] : undefined
      if (savedSourcePreset) {
        entries.unshift(
          legacyPresetEntryFromFieldRollback(
            saveCurrentRollback,
            safeStructuredClone(savedSourcePreset),
            savedSourceIndex,
          ),
        )
      }
    }
    const attempt = createPresetRowMutationAttempt(entries)
    const durableIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: `/presets/${encodeURIComponent(sourcePresetId)}/copy`,
          body: {
            newPresetId: newPres.id,
            name: newPres.name,
            saveCurrent: true,
          },
        },
      ],
    }
    const prepared = preparePresetMutation(durableIntent, entries.map(presetRowProjectionTarget))
    dispatchPresetRowMutation(prepared, attempt, (baseRevision) =>
      copyPresetCommand({
        baseRevision,
        presetId: sourcePresetId,
        newPresetId: newPres.id,
        name: newPres.name,
        saveCurrent: true,
      }),
    )
  })()
}

let legacyPresetSelectionIntent = 0

export function beginLegacyPresetSelectionIntent(): number {
  return ++legacyPresetSelectionIntent
}

export function isLegacyPresetSelectionIntentCurrent(intent: number): boolean {
  return intent === legacyPresetSelectionIntent
}

export function changeToPreset(id = 0, savecurrent = true) {
  const intent = beginLegacyPresetSelectionIntent()
  const target = (() => {
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    const preset = legacyPresetOwner()[id]
    return preset?.id ? { presetId: preset.id, hydrated: botPresetHasHydratedSettings(preset) } : null
  })()
  if (!target) return
  if (!target.hydrated) {
    void ensureBotPresetHydratedById(target.presetId).then((hydrated) => {
      if (hydrated && isLegacyPresetSelectionIntentCurrent(intent)) {
        changeToPresetById(target.presetId, savecurrent, intent)
      }
    })
    return
  }
  changeToPresetById(target.presetId, savecurrent, intent)
}

function changeToPresetById(targetPresetId: string, savecurrent: boolean, intent: number): void {
  ;(() => {
    if (!isLegacyPresetSelectionIntentCurrent(intent)) return
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    const id = canonicalBotPresetIndexById(targetPresetId)
    if (id < 0 || !botPresetHasHydratedSettings(legacyPresetOwner()[id])) return
    if (canUseServerCommands()) {
      flushRegisteredPendingOwnerMutation('settings', {})
    }
    const previousSelectedId = botPresetSelectedId(legacyPresetOwner(), db.botPresetsId)
    const previousSettings = snapshotSetPresetSettings(db)
    const saveCurrentRollback = savecurrent ? saveCurrentPresetLocalWithRollback().rollback : null
    normalizeLegacyPresetOwner()
    const resolvedIndex = canonicalBotPresetIndexById(targetPresetId)
    const newPres = resolvedIndex >= 0 ? legacyPresetOwner()[resolvedIndex] : undefined
    if (!botPresetHasHydratedSettings(newPres)) return
    settingsOwnerRecord().botPresetsId = resolvedIndex
    setPreset(db, newPres)
    const selectionRollback: BotPresetSelectionRollback = {
      previousSelectedId,
      attemptedSelectedId: botPresetSelectedId(legacyPresetOwner(), db.botPresetsId),
      previousSettings,
      attemptedSettings: snapshotSetPresetSettings(db),
    }
    const entries: PresetRowMutationEntry[] = []
    if (saveCurrentRollback) {
      const savedPresetIndex = canonicalBotPresetIndexById(saveCurrentRollback.presetId)
      const savedPreset = savedPresetIndex >= 0 ? legacyPresetOwner()[savedPresetIndex] : undefined
      if (savedPreset) {
        entries.push(
          legacyPresetEntryFromFieldRollback(saveCurrentRollback, safeStructuredClone(savedPreset), savedPresetIndex),
        )
      }
    }
    const attempt = createPresetRowMutationAttempt(entries, {
      kind: 'legacy',
      previousSelectedId: selectionRollback.previousSelectedId,
      attemptedSelectedId: selectionRollback.attemptedSelectedId,
      previousSettings: selectionRollback.previousSettings,
      attemptedSettings: selectionRollback.attemptedSettings,
    })
    const selectionIntent: DurableMutationIntent = {
      version: 1,
      dependencyKeys: [PRESET_MUTATION_KEY],
      requests: [
        {
          method: 'POST',
          path: '/presets/select',
          body: { presetId: targetPresetId, apply: true, saveCurrent: savecurrent },
        },
      ],
    }
    const prepared = preparePresetMutation(
      selectionIntent,
      entries.map(presetRowProjectionTarget),
      SETTINGS_BRIDGE_MUTATION_KEY,
    )
    if (prepared.status === 'durable') {
      recordPresetSelectionProjectionTargets(
        prepared.handle,
        selectionRollback.previousSettings ?? {},
        selectionRollback.attemptedSettings ?? {},
      )
    }
    dispatchPresetRowMutation(
      prepared,
      attempt,
      (baseRevision) =>
        selectPresetCommand({
          baseRevision,
          presetId: targetPresetId,
          apply: true,
          saveCurrent: savecurrent,
        }),
      () => {
        rollbackBotPresetFields(saveCurrentRollback)
      },
    )
  })()
}

export function createPreset(preset: botPreset) {
  ;(() => {
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    const newPreset = safeStructuredClone(preset)
    newPreset.id ??= createClientPresetId()
    legacyPresetOwner().push(newPreset)
    const attemptedPreset = safeStructuredClone(newPreset)
    const entry: PresetRowMutationEntry = {
      kind: 'legacy',
      key: newPreset.id,
      previous: null,
      attempted: attemptedPreset,
    }
    const attempt = createPresetRowMutationAttempt([entry])
    const durableIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/presets',
          body: { preset: safeStructuredClone(attemptedPreset) },
        },
      ],
    }
    const prepared = preparePresetMutation(durableIntent, [presetRowProjectionTarget(entry)])
    dispatchPresetRowMutation(prepared, attempt, (baseRevision) =>
      createPresetCommand({
        baseRevision,
        preset: safeStructuredClone(attemptedPreset) as unknown as PresetSnapshot,
      }),
    )
  })()
}

export function updatePreset(id: number, patch: Partial<botPreset>) {
  ;(() => {
    const db = settingsResourceState.value as Database
    const normalizedIds = !legacyPresetOwnerIdsNeedNormalization()
    normalizeLegacyPresetOwner()
    const presetId = legacyPresetOwner()[id]?.id
    if (!presetId) return []
    const acknowledgementEligible = normalizedIds && botPresetHasHydratedSettings(legacyPresetOwner()[id])
    const attempted = safeStructuredClone(patch)
    delete attempted.id
    const currentPreset = legacyPresetOwner()[id] as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(attempted)) {
      if (
        Object.prototype.hasOwnProperty.call(currentPreset, key) &&
        isExactJsonValue(currentPreset[key]) &&
        isExactJsonValue(value) &&
        exactJsonValuesEqual(currentPreset[key], value)
      ) {
        delete (attempted as Record<string, unknown>)[key]
      }
    }
    const commandPatch = safeStructuredClone(attempted) as PresetSnapshot
    if (Object.keys(commandPatch).length === 0) return []
    const wirePatch = acknowledgementEligible ? exactJsonRecordClone(commandPatch) : null
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    const rollback = botPresetFieldRollbackFromPatch(
      presetId,
      legacyPresetOwner()[id] as unknown as Record<string, unknown>,
      attempted as unknown as Record<string, unknown>,
    )
    Object.assign(legacyPresetOwner()[id], attempted)
    const optimisticAcknowledgement = wirePatch
      ? legacyPresetPatchOptimisticAcknowledgement({
          preset: legacyPresetOwner()[id] as unknown as Record<string, unknown>,
          wirePatch,
          collectionProjectionEpoch,
        })
      : null
    const entry = legacyPresetEntryFromFieldRollback(rollback, safeStructuredClone(legacyPresetOwner()[id]), id)
    const attempt = createPresetRowMutationAttempt([entry])
    const durableIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: `/presets/${encodeURIComponent(presetId)}`,
          body: { patch: safeStructuredClone(commandPatch) },
        },
      ],
    }
    const prepared = preparePresetMutation(durableIntent, [presetRowProjectionTarget(entry)])
    dispatchPresetRowMutation(
      prepared,
      attempt,
      (baseRevision) =>
        updatePresetCommand({
          baseRevision,
          presetId,
          patch: safeStructuredClone(commandPatch),
          ...(optimisticAcknowledgement ? { optimisticAcknowledgement } : {}),
        }),
      () => {
        markCollectionAcknowledgementTainted('botPresets')
      },
    )
  })()
}

export function deletePreset(id: number, selectIndex = 0, apply = true) {
  const intent = beginLegacyPresetSelectionIntent()
  const target = (() => {
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    if (legacyPresetOwner().length <= 1) return null
    const presetId = legacyPresetOwner()[id]?.id
    if (!presetId) return null
    const nextSelectedPreset =
      legacyPresetOwner()[selectIndex]?.id === presetId
        ? legacyPresetOwner().find((preset) => preset.id !== presetId)
        : legacyPresetOwner()[selectIndex]
    return nextSelectedPreset?.id
      ? {
          presetId,
          selectPresetId: nextSelectedPreset.id,
          selectPresetHydrated: botPresetHasHydratedSettings(nextSelectedPreset),
        }
      : null
  })()
  if (!target) return
  if (apply && !target.selectPresetHydrated) {
    void ensureBotPresetHydratedById(target.selectPresetId).then((hydrated) => {
      if (hydrated && isLegacyPresetSelectionIntentCurrent(intent)) {
        deletePresetByIds(target.presetId, target.selectPresetId, apply, intent)
      }
    })
    return
  }
  deletePresetByIds(target.presetId, target.selectPresetId, apply, intent)
}

function deletePresetByIds(presetId: string, selectPresetId: string, apply: boolean, intent: number): void {
  ;(() => {
    if (!isLegacyPresetSelectionIntentCurrent(intent)) return
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    if (legacyPresetOwner().length <= 1) return []
    const id = canonicalBotPresetIndexById(presetId)
    const selectedBeforeDelete = canonicalBotPresetIndexById(selectPresetId)
    if (id < 0 || selectedBeforeDelete < 0) return []
    if (apply && !botPresetHasHydratedSettings(legacyPresetOwner()[selectedBeforeDelete])) return []
    const durable = canUseServerCommands()
    if (durable) flushRegisteredPendingOwnerMutation('settings', {})
    const previousPreset = safeStructuredClone(legacyPresetOwner()[id])
    const previousSelectedId = botPresetSelectedId(legacyPresetOwner(), db.botPresetsId)
    const previousSettings = apply ? snapshotSetPresetSettings(db) : undefined
    let botPresets = legacyPresetOwner()
    botPresets.splice(id, 1)
    assignLegacyPresetOwner(botPresets)
    const selectedIndex = selectPresetId ? legacyPresetOwner().findIndex((preset) => preset.id === selectPresetId) : -1
    if (selectedIndex >= 0) {
      settingsOwnerRecord().botPresetsId = selectedIndex
      if (apply) {
        setPreset(db, legacyPresetOwner()[selectedIndex])
      }
    } else if (settingsOwnerRecord().botPresetsId >= legacyPresetOwner().length) {
      settingsOwnerRecord().botPresetsId = legacyPresetOwner().length - 1
    }
    const selectionRollback: BotPresetSelectionRollback = {
      previousSelectedId,
      attemptedSelectedId: botPresetSelectedId(legacyPresetOwner(), db.botPresetsId),
      ...(apply && previousSettings
        ? {
            previousSettings,
            attemptedSettings: snapshotSetPresetSettings(db),
          }
        : {}),
    }
    if (!durable) return
    const entry: PresetRowMutationEntry = {
      kind: 'legacy',
      key: presetId,
      previous: previousPreset,
      attempted: null,
      previousIndex: id,
    }
    const attempt = createPresetRowMutationAttempt([entry], {
      kind: 'legacy',
      previousSelectedId: selectionRollback.previousSelectedId,
      attemptedSelectedId: selectionRollback.attemptedSelectedId,
      ...(selectionRollback.previousSettings ? { previousSettings: selectionRollback.previousSettings } : {}),
      ...(selectionRollback.attemptedSettings ? { attemptedSettings: selectionRollback.attemptedSettings } : {}),
    })
    const deleteIntent: DurableMutationIntent = {
      version: 1,
      dependencyKeys: [PRESET_MUTATION_KEY],
      requests: [
        {
          method: 'DELETE',
          path: `/presets/${encodeURIComponent(presetId)}`,
          body: { presetId: selectPresetId, apply, saveCurrent: false },
        },
      ],
    }
    const prepared = preparePresetMutation(
      deleteIntent,
      [presetRowProjectionTarget(entry)],
      SETTINGS_BRIDGE_MUTATION_KEY,
    )
    if (prepared.status === 'durable' && selectionRollback.previousSettings && selectionRollback.attemptedSettings) {
      recordPresetSelectionProjectionTargets(
        prepared.handle,
        selectionRollback.previousSettings,
        selectionRollback.attemptedSettings,
      )
    }
    dispatchPresetRowMutation(prepared, attempt, (baseRevision) =>
      deletePresetCommand({
        baseRevision,
        presetId,
        selectPresetId,
        apply,
        saveCurrent: false,
      }),
    )
  })()
}

export function reorderPresets(fromIndex: number, toIndex: number) {
  ;(() => {
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    if (fromIndex === toIndex) return []
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= legacyPresetOwner().length ||
      toIndex > legacyPresetOwner().length
    ) {
      return []
    }

    const collectionProjectionEpoch = captureCollectionProjectionEpoch('botPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const previousPresetIds = botPresetIds(legacyPresetOwner())
    const previousSelectedPresetId = botPresetSelectedId(legacyPresetOwner(), db.botPresetsId)
    let botPresets = [...legacyPresetOwner()]
    const movedItem = botPresets.splice(fromIndex, 1)[0]
    if (!movedItem) return []

    const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    botPresets.splice(adjustedToIndex, 0, movedItem)

    const currentId = settingsOwnerRecord().botPresetsId
    if (currentId === fromIndex) {
      settingsOwnerRecord().botPresetsId = adjustedToIndex
    } else if (fromIndex < currentId && adjustedToIndex >= currentId) {
      settingsOwnerRecord().botPresetsId = currentId - 1
    } else if (fromIndex > currentId && adjustedToIndex <= currentId) {
      settingsOwnerRecord().botPresetsId = currentId + 1
    }

    assignLegacyPresetOwner(botPresets)
    const presetIds = legacyPresetOwner()
      .map((preset) => preset.id)
      .filter((id): id is string => !!id)
    const optimisticAcknowledgement = presetReorderOptimisticAcknowledgement({
      presetKind: 'legacy',
      collectionProjectionEpoch,
      settingsProjectionEpoch,
      beforePresetIds: previousPresetIds,
      attemptedPresetIds: presetIds,
      beforeSelectedPresetId: previousSelectedPresetId,
      attemptedSelectedPresetId: botPresetSelectedId(legacyPresetOwner(), db.botPresetsId),
    })
    const attempt = createPresetReorderMutationAttempt('legacy', previousPresetIds, presetIds)
    const durableIntent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'POST', path: '/presets/reorder', body: { presetIds: [...presetIds] } }],
    }
    const prepared = preparePresetMutation(durableIntent, [presetOrderProjectionTarget('legacy')])
    dispatchPresetReorderMutation(
      prepared,
      attempt,
      (baseRevision) =>
        reorderPresetsCommand({
          baseRevision,
          presetIds: [...presetIds],
          ...(optimisticAcknowledgement ? { optimisticAcknowledgement } : {}),
        }),
      () => {
        markCollectionAcknowledgementTainted('botPresets')
        markSettingsAcknowledgementTainted()
      },
    )
  })()
}

export function createModelPreset(preset: ModelPreset): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    flushPendingSplitPresetPatchesForKind('model')
    const newPreset = safeStructuredClone(preset)
    repairLegacyLocalStopStrings(newPreset)
    newPreset.id ??= createClientPresetId()
    const attemptedPreset = safeStructuredClone(newPreset)
    modelPresetOwner().push(newPreset)
    const entry: PresetRowMutationEntry = {
      kind: 'model',
      key: newPreset.id,
      previous: null,
      attempted: attemptedPreset,
    }
    const attempt = createPresetRowMutationAttempt([entry])
    const durableIntent: DurableMutationIntent = {
      version: 1,
      dependencyKeys: [PRESET_MUTATION_KEY],
      requests: [
        {
          method: 'POST',
          path: '/model-presets',
          body: { preset: safeStructuredClone(attemptedPreset) },
        },
      ],
    }
    const prepared = preparePresetMutation(
      durableIntent,
      [presetRowProjectionTarget(entry)],
      splitPresetMutationKey('model', newPreset.id),
    )
    return dispatchPresetRowMutation(prepared, attempt, (baseRevision) =>
      createModelPresetCommand({
        baseRevision,
        preset: safeStructuredClone(attemptedPreset) as unknown as ModelPresetSnapshot,
      }),
    )
  })()
}

export function updateModelPreset(id: number, patch: Partial<ModelPreset>): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    const modelPresetId = modelPresetOwner()[id]?.id
    if (!modelPresetId) return Promise.resolve({ status: 'failed' })
    const attempted = omitUndefinedSplitPresetPatchValues(safeStructuredClone(patch))
    const previousProjectionFields = captureSplitPresetProjectionFields('model', attempted as Record<string, unknown>)
    const pending = queueSplitPresetPatch(
      'model',
      modelPresetId,
      modelPresetOwner()[id] as unknown as Record<string, unknown>,
      attempted as Record<string, unknown>,
    )
    Object.assign(modelPresetOwner()[id], attempted)
    if (settingsOwnerRecord().modelPresetsId === id) {
      applyModelPresetFieldsToDatabase(db, modelPresetOwner()[id])
    }
    recordSplitPresetProjectionFields(pending, previousProjectionFields)
    const outcome = pending
      ? waitForPendingSplitPresetOutcome(pending)
      : Promise.resolve<PresetMutationOutcome>({ status: 'accepted' })
    if (pending) schedulePendingSplitPresetPatch(pending)
    return outcome
  })()
}

export function deleteModelPreset(id: number, selectIndex = 0): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    if (modelPresetOwner().length <= 1) return Promise.resolve({ status: 'failed' })
    const modelPresetId = modelPresetOwner()[id]?.id
    const previousPreset = modelPresetOwner()[id] ? safeStructuredClone(modelPresetOwner()[id]) : null
    const previousSelectedId = splitPresetSelectedId(modelPresetOwner(), db.modelPresetsId)
    const previousSettings = snapshotSetPresetSettings(db)
    const nextSelectedPreset =
      modelPresetOwner()[selectIndex]?.id === modelPresetId
        ? modelPresetOwner().find((preset) => preset.id !== modelPresetId)
        : modelPresetOwner()[selectIndex]
    const selectModelPresetId = nextSelectedPreset?.id
    if (!modelPresetId || !previousPreset) return Promise.resolve({ status: 'failed' })
    flushPendingSplitPresetPatches()
    flushRegisteredPendingOwnerMutation('settings', {})
    const deleteIntent: DurableMutationIntent = {
      version: 1,
      dependencyKeys: splitPresetMutationDependencyKeys(
        'model',
        previousSelectedId,
        modelPresetId,
        selectModelPresetId,
      ),
      requests: [
        {
          method: 'DELETE',
          path: `/model-presets/${encodeURIComponent(modelPresetId)}`,
          body: { modelPresetId: selectModelPresetId },
        },
      ],
    }
    modelPresetOwner().splice(id, 1)
    const selectedIndex = selectModelPresetId
      ? modelPresetOwner().findIndex((preset) => preset.id === selectModelPresetId)
      : -1
    settingsOwnerRecord().modelPresetsId =
      selectedIndex >= 0 ? selectedIndex : Math.min(settingsOwnerRecord().modelPresetsId, modelPresetOwner().length - 1)
    applyModelPresetFieldsToDatabase(db, modelPresetOwner()[settingsOwnerRecord().modelPresetsId])
    const replacementPreset = modelPresetOwner()[settingsOwnerRecord().modelPresetsId]
    const referenceCascade = optimisticallyRehomeGenerationReferences({
      kind: 'modelPreset',
      deletedId: modelPresetId,
      replacement: replacementPreset?.id
        ? { id: replacementPreset.id, name: typeof replacementPreset.name === 'string' ? replacementPreset.name : '' }
        : null,
    })
    const selectionRollback: SplitPresetSelectionRollback = {
      kind: 'model',
      previousSelectedId,
      attemptedSelectedId: splitPresetSelectedId(modelPresetOwner(), db.modelPresetsId),
      previousSettings,
      attemptedSettings: snapshotSetPresetSettings(db),
    }
    const entry: PresetRowMutationEntry = {
      kind: 'model',
      key: modelPresetId,
      previous: previousPreset,
      attempted: null,
      previousIndex: id,
    }
    const attempt = createPresetRowMutationAttempt([entry], {
      kind: 'model',
      previousSelectedId: selectionRollback.previousSelectedId,
      attemptedSelectedId: selectionRollback.attemptedSelectedId,
      previousSettings: selectionRollback.previousSettings,
      attemptedSettings: selectionRollback.attemptedSettings,
    })
    const prepared = preparePresetMutation(
      deleteIntent,
      [presetRowProjectionTarget(entry)],
      SETTINGS_BRIDGE_MUTATION_KEY,
    )
    if (prepared.status === 'durable') {
      recordPresetSelectionProjectionTargets(
        prepared.handle,
        selectionRollback.previousSettings,
        selectionRollback.attemptedSettings,
      )
    }
    return dispatchPresetRowMutation(
      prepared,
      attempt,
      (baseRevision) =>
        deleteModelPresetCommand({
          baseRevision,
          modelPresetId,
          selectModelPresetId,
        }),
      () => {
        if (modelPresetOwner().filter((preset) => preset.id === modelPresetId).length === 1) {
          referenceCascade.rollback()
        }
      },
    )
  })()
}

export function selectModelPreset(id: number): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    const previousSelectedId = splitPresetSelectedId(modelPresetOwner(), db.modelPresetsId)
    const previousSettings = snapshotSetPresetSettings(db)
    const modelPresetId = modelPresetOwner()[id]?.id
    if (!modelPresetId) return Promise.resolve({ status: 'failed' })
    if (previousSelectedId === modelPresetId) return Promise.resolve({ status: 'accepted' })
    flushPendingSplitPresetPatches()
    if (canUseServerCommands()) {
      flushRegisteredPendingOwnerMutation('settings', {})
    }
    settingsOwnerRecord().modelPresetsId = id
    applyModelPresetFieldsToDatabase(db, modelPresetOwner()[id])
    const selectionRollback: SplitPresetSelectionRollback = {
      kind: 'model',
      previousSelectedId,
      attemptedSelectedId: splitPresetSelectedId(modelPresetOwner(), db.modelPresetsId),
      previousSettings,
      attemptedSettings: snapshotSetPresetSettings(db),
    }
    const attempt = createPresetRowMutationAttempt([], {
      kind: 'model',
      previousSelectedId: selectionRollback.previousSelectedId,
      attemptedSelectedId: selectionRollback.attemptedSelectedId,
      previousSettings: selectionRollback.previousSettings,
      attemptedSettings: selectionRollback.attemptedSettings,
    })
    const selectionIntent: DurableMutationIntent = {
      version: 1,
      dependencyKeys: splitPresetMutationDependencyKeys('model', previousSelectedId, modelPresetId),
      requests: [
        {
          method: 'POST',
          path: '/model-presets/select',
          body: { modelPresetId },
        },
      ],
    }
    const prepared = preparePresetMutation(selectionIntent, [], SETTINGS_BRIDGE_MUTATION_KEY)
    if (prepared.status === 'durable') {
      recordPresetSelectionProjectionTargets(
        prepared.handle,
        selectionRollback.previousSettings,
        selectionRollback.attemptedSettings,
      )
    }
    return dispatchPresetRowMutation(prepared, attempt, (baseRevision) =>
      selectModelPresetCommand({ baseRevision, modelPresetId }),
    )
  })()
}

export function reorderModelPresets(fromIndex: number, toIndex: number): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    if (fromIndex === toIndex) return Promise.resolve({ status: 'accepted' })
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= modelPresetOwner().length || toIndex > modelPresetOwner().length) {
      return Promise.resolve({ status: 'failed' })
    }
    flushPendingSplitPresetPatchesForKind('model')
    const dependencyKeys = activeSplitPresetOwnerMutationKeys(['model'])
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('modelPresets')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const previousPresetIds = splitPresetIds(modelPresetOwner())
    const previousSelectedPresetId = splitPresetSelectedId(modelPresetOwner(), db.modelPresetsId)
    const modelPresets = [...modelPresetOwner()]
    const movedItem = modelPresets.splice(fromIndex, 1)[0]
    if (!movedItem) return Promise.resolve({ status: 'failed' })
    const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    modelPresets.splice(adjustedToIndex, 0, movedItem)
    settingsOwnerRecord().modelPresetsId = movedSelectedIndex(
      settingsOwnerRecord().modelPresetsId,
      fromIndex,
      adjustedToIndex,
    )
    assignModelPresetOwner(modelPresets)
    const modelPresetIds = modelPresetOwner()
      .map((preset) => preset.id)
      .filter((id): id is string => !!id)
    const optimisticAcknowledgement = presetReorderOptimisticAcknowledgement({
      presetKind: 'model',
      collectionProjectionEpoch,
      settingsProjectionEpoch,
      beforePresetIds: previousPresetIds,
      attemptedPresetIds: modelPresetIds,
      beforeSelectedPresetId: previousSelectedPresetId,
      attemptedSelectedPresetId: splitPresetSelectedId(modelPresetOwner(), db.modelPresetsId),
    })
    const attempt = createPresetReorderMutationAttempt('model', previousPresetIds, modelPresetIds)
    const durableIntent: DurableMutationIntent = {
      version: 1,
      ...(dependencyKeys.length > 0 ? { dependencyKeys } : {}),
      requests: [
        {
          method: 'POST',
          path: '/model-presets/reorder',
          body: { modelPresetIds: [...modelPresetIds] },
        },
      ],
    }
    const prepared = preparePresetMutation(durableIntent, [presetOrderProjectionTarget('model')])
    return dispatchPresetReorderMutation(
      prepared,
      attempt,
      (baseRevision) =>
        reorderModelPresetsCommand({
          baseRevision,
          modelPresetIds: [...modelPresetIds],
          ...(optimisticAcknowledgement ? { optimisticAcknowledgement } : {}),
        }),
      () => {
        markCollectionAcknowledgementTainted('modelPresets')
        markSettingsAcknowledgementTainted()
      },
    )
  })()
}

export function createPromptPreset(preset: PromptPreset): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    flushPendingSplitPresetPatchesForKind('prompt')
    const newPreset = safeStructuredClone(preset)
    repairLegacyLocalStopStrings(newPreset)
    normalizePromptTemplateRecord(newPreset)
    newPreset.id ??= createClientPresetId()
    const attemptedPreset = safeStructuredClone(newPreset)
    promptPresetOwner().push(newPreset)
    const entry: PresetRowMutationEntry = {
      kind: 'prompt',
      key: newPreset.id,
      previous: null,
      attempted: attemptedPreset,
    }
    const attempt = createPresetRowMutationAttempt([entry])
    const durableIntent: DurableMutationIntent = {
      version: 1,
      dependencyKeys: [PRESET_MUTATION_KEY],
      requests: [
        {
          method: 'POST',
          path: '/prompt-presets',
          body: { preset: safeStructuredClone(attemptedPreset) },
        },
      ],
    }
    const prepared = preparePresetMutation(
      durableIntent,
      [presetRowProjectionTarget(entry)],
      splitPresetMutationKey('prompt', newPreset.id),
    )
    return dispatchPresetRowMutation(prepared, attempt, (baseRevision) =>
      createPromptPresetCommand({
        baseRevision,
        preset: safeStructuredClone(attemptedPreset) as unknown as PromptPresetSnapshot,
      }),
    )
  })()
}

export type PresetImportOutcome = 'applied' | 'failed' | 'queued'

interface ImportedSplitPresetDefinition {
  kind: SplitPresetKind
  preset: SplitPresetRow
}

interface StagedImportedSplitPreset extends ImportedSplitPresetDefinition {
  sequence: number
  handle: PendingMutationHandle
  intent: DurableMutationIntent
  retirement: PresetMutationRetirementSignal
  settlementCleanup?: () => void
  retired: boolean
  settled: boolean
}

interface PresetMutationRetirementSignal {
  promise: Promise<void>
  resolve: () => void
}

const unsettledImportedSplitPresets: StagedImportedSplitPreset[] = []

function createPresetMutationRetirementSignal(): PresetMutationRetirementSignal {
  let resolve!: () => void
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

interface ImportedSplitPresetDispatchOutcome {
  result: ServerCommandResult
  retained: boolean
}

function projectImportedSplitPresets(attempts: readonly ImportedSplitPresetDefinition[]): void {
  ;(() => {
    for (const attempt of attempts) {
      const list = splitPresetList(attempt.kind)
      if (list.some((preset) => preset?.id === attempt.preset.id)) continue
      list.push(safeStructuredClone(attempt.preset))
      assignSplitPresetList(attempt.kind, list)
    }
  })()
}

function reapplyRetainedImportedSplitPreset(attempt: StagedImportedSplitPreset): void {
  if (!attempt.retired && !attempt.settled) reapplyPendingPresetProjections()
}

function settleImportedSplitPreset(attempt: StagedImportedSplitPreset, accepted: boolean): void {
  if (attempt.settled) return
  attempt.settled = true
  attempt.settlementCleanup?.()
  attempt.settlementCleanup = undefined
  const index = unsettledImportedSplitPresets.indexOf(attempt)
  if (index >= 0) unsettledImportedSplitPresets.splice(index, 1)
  if (!unsettledImportedSplitPresets.some((candidate) => candidate.handle.key === attempt.handle.key)) {
    activeImportedSplitPresetOwnerKeys.get(attempt.kind)?.delete(attempt.handle.key)
  }
  if (!accepted) rollbackSplitPresetCreate(attempt.kind, attempt.preset)
}

async function dispatchImportedSplitPresetBatch(
  definitions: readonly ImportedSplitPresetDefinition[],
): Promise<PresetImportOutcome> {
  const staged: StagedImportedSplitPreset[] = []
  try {
    let predecessorKey: string | null = null
    for (const definition of definitions) {
      const presetId = definition.preset.id
      if (!presetId) throw new Error('Imported preset is missing an id')
      const ownerKey = splitPresetMutationKey(definition.kind, presetId)
      const intent: DurableMutationIntent = {
        version: 1,
        requests: [
          {
            method: 'POST',
            path: definition.kind === 'model' ? '/model-presets' : '/prompt-presets',
            body: { preset: safeStructuredClone(definition.preset) },
          },
        ],
        dependencyKeys: [PRESET_MUTATION_KEY, ...(predecessorKey ? [predecessorKey] : [])],
      }
      const handle = stagePendingMutation(ownerKey, intent)
      recordPendingMutationProjectionTargets(handle, [
        pendingMutationPresetRowProjectionTarget(definition.kind, presetId),
      ])
      const attempt: StagedImportedSplitPreset = {
        ...definition,
        sequence: reservePresetMutationSequence(),
        handle,
        intent,
        retirement: createPresetMutationRetirementSignal(),
        retired: false,
        settled: false,
      }
      attempt.settlementCleanup = registerDurableMutationSettlementListener(handle.mutationId, (settlement) =>
        settleImportedSplitPreset(attempt, settlement === 'accepted'),
      )
      staged.push(attempt)
      unsettledImportedSplitPresets.push(attempt)
      activeImportedSplitPresetOwnerKeys.get(definition.kind)?.add(ownerKey)
      predecessorKey = ownerKey
    }
  } catch {
    await Promise.all(staged.map(({ handle }) => acknowledgePendingMutation(handle)))
    for (const attempt of staged) settleImportedSplitPreset(attempt, false)
    return 'failed'
  }

  projectImportedSplitPresets(staged)

  let firstFailure: Exclude<ServerCommandResult, { status: 'ok' }> | undefined
  const durabilityReady = Promise.all(staged.map(({ handle }) => handle.ready))
  const dispatchAttempt = async (attempt: StagedImportedSplitPreset): Promise<ImportedSplitPresetDispatchOutcome> => {
    let retained = false
    try {
      const result = await dispatchDurableMutation(
        attempt.handle,
        attempt.intent,
        (transport) =>
          runServerCommand({
            command: async (baseRevision) => {
              await durabilityReady
              if (attempt.retired) {
                firstFailure ??= { status: 'unavailable' }
                return firstFailure
              }
              if (firstFailure) return firstFailure
              const result =
                attempt.kind === 'model'
                  ? await createModelPresetCommand({
                      baseRevision,
                      preset: safeStructuredClone(attempt.preset) as unknown as ModelPresetSnapshot,
                    })
                  : await createPromptPresetCommand({
                      baseRevision,
                      preset: safeStructuredClone(attempt.preset) as unknown as PromptPresetSnapshot,
                    })
              if (result.status !== 'ok') firstFailure ??= result
              return result
            },
            rollback: () => {
              if (!attempt.retired) rollbackSplitPresetCreate(attempt.kind, attempt.preset)
            },
            ...transport,
            failureRollbackDisposition: (failure) => {
              const disposition = transport.failureRollbackDisposition?.(failure) ?? 'rollback'
              if (disposition === 'retain') retained = true
              return disposition
            },
          }),
        {
          beforeExecuteResult: () => firstFailure,
        },
      )
      return { result, retained }
    } catch (error) {
      firstFailure ??= { status: 'unavailable' }
      if (attempt.retired) return { result: { status: 'unavailable' }, retained: false }
      const persisted = (await attempt.handle.ready) === 'persisted'
      if (attempt.retired) return { result: { status: 'unavailable' }, retained: false }
      const current = persisted && (await isPendingMutationCurrent(attempt.handle))
      if (attempt.retired) return { result: { status: 'unavailable' }, retained: false }
      if (current) {
        return { result: { status: 'unavailable' }, retained: true }
      }
      throw error
    }
  }

  const settled = await Promise.allSettled(
    staged.map((attempt) =>
      Promise.race([
        dispatchAttempt(attempt),
        attempt.retirement.promise.then(
          (): ImportedSplitPresetDispatchOutcome => ({ result: { status: 'unavailable' }, retained: false }),
        ),
      ]),
    ),
  )
  let queued = false
  let failed = false
  settled.forEach((outcome, index) => {
    const attempt = staged[index]
    if (attempt.retired) {
      failed = true
      return
    }
    if (outcome.status === 'rejected') {
      settleImportedSplitPreset(attempt, false)
      failed = true
      return
    }
    if (outcome.value.retained) {
      queued = true
      reapplyRetainedImportedSplitPreset(attempt)
      return
    }
    const accepted = outcome.value.result.status === 'ok'
    settleImportedSplitPreset(attempt, accepted)
    if (!accepted) failed = true
  })
  if (queued) return 'queued'
  return failed ? 'failed' : 'applied'
}

export async function addImportedPromptPreset(preset: PromptPreset): Promise<PresetImportOutcome> {
  const attemptedPreset = (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    flushPendingSplitPresetPatchesForKind('prompt')
    const newPreset = safeStructuredClone(promptPresetExportPayload(preset)) as PromptPreset
    newPreset.id ??= createClientPresetId()
    return safeStructuredClone(newPreset)
  })()
  return dispatchImportedSplitPresetBatch([{ kind: 'prompt', preset: attemptedPreset }])
}

export async function addImportedLegacyPreset(preset: botPreset): Promise<PresetImportOutcome> {
  const imported = (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    flushPendingSplitPresetPatches()
    const importedName = typeof preset.name === 'string' && preset.name.trim() ? preset.name.trim() : 'Imported'
    const modelPreset = createExtractedModelPreset(preset, {
      id: createClientPresetId(),
      name: importedName,
    }) as ModelPreset
    const promptPreset = createExtractedPromptPreset(preset, {
      id: createClientPresetId(),
      name: importedName,
    }) as PromptPreset

    // Legacy full presets always applied their parameter values. Keep that
    // behavior when the prompt half is composed with its imported model half.
    promptPreset.overrideModelParameters = true

    return {
      modelPreset: safeStructuredClone(modelPreset),
      promptPreset: safeStructuredClone(promptPreset),
    }
  })()
  return dispatchImportedSplitPresetBatch([
    { kind: 'model', preset: imported.modelPreset },
    { kind: 'prompt', preset: imported.promptPreset },
  ])
}

export function updatePromptPreset(id: number, patch: Partial<PromptPreset>): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    const promptPresetId = promptPresetOwner()[id]?.id
    if (!promptPresetId) return Promise.resolve({ status: 'failed' })
    const attempted = normalizePromptPresetPatchAliases(omitUndefinedSplitPresetPatchValues(safeStructuredClone(patch)))
    normalizePromptTemplateRecord(attempted)
    const previousProjectionFields = captureSplitPresetProjectionFields('prompt', attempted as Record<string, unknown>)
    const pending = queueSplitPresetPatch(
      'prompt',
      promptPresetId,
      promptPresetOwner()[id] as unknown as Record<string, unknown>,
      attempted as Record<string, unknown>,
    )
    Object.assign(promptPresetOwner()[id], attempted)
    if (settingsOwnerRecord().promptPresetsId === id) {
      applyPromptPresetFieldsToDatabase(db, promptPresetOwner()[id])
    }
    recordSplitPresetProjectionFields(pending, previousProjectionFields)
    const outcome = pending
      ? waitForPendingSplitPresetOutcome(pending)
      : Promise.resolve<PresetMutationOutcome>({ status: 'accepted' })
    if (pending) schedulePendingSplitPresetPatch(pending)
    return outcome
  })()
}

function omitUndefinedSplitPresetPatchValues<T extends Record<string, unknown>>(patch: T): T {
  for (const [fieldName, value] of Object.entries(patch)) {
    if (value === undefined) delete patch[fieldName]
  }
  return patch
}

function normalizePromptPresetPatchAliases<T extends Partial<PromptPreset>>(patch: T): T {
  if (Object.prototype.hasOwnProperty.call(patch, 'presetRegex')) {
    const target = patch as Record<string, unknown>
    target.regex = []
  }
  return patch
}

function jsonSnapshot(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

export function deletePromptPreset(id: number, selectIndex = 0): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    if (promptPresetOwner().length <= 1) return Promise.resolve({ status: 'failed' })
    const promptPresetId = promptPresetOwner()[id]?.id
    const previousPreset = promptPresetOwner()[id] ? safeStructuredClone(promptPresetOwner()[id]) : null
    const previousSelectedId = splitPresetSelectedId(promptPresetOwner(), db.promptPresetsId)
    const previousSettings = snapshotSetPresetSettings(db)
    const nextSelectedPreset =
      promptPresetOwner()[selectIndex]?.id === promptPresetId
        ? promptPresetOwner().find((preset) => preset.id !== promptPresetId)
        : promptPresetOwner()[selectIndex]
    const selectPromptPresetId = nextSelectedPreset?.id
    if (!promptPresetId || !previousPreset) return Promise.resolve({ status: 'failed' })
    commitPendingPromptTemplateMutations()
    flushPendingSplitPresetPatches()
    flushRegisteredPendingOwnerMutation('settings', {})
    const deleteIntent: DurableMutationIntent = {
      version: 1,
      dependencyKeys: splitPresetMutationDependencyKeys(
        'prompt',
        previousSelectedId,
        promptPresetId,
        selectPromptPresetId,
      ),
      requests: [
        {
          method: 'DELETE',
          path: `/prompt-presets/${encodeURIComponent(promptPresetId)}`,
          body: { promptPresetId: selectPromptPresetId },
        },
      ],
    }
    promptPresetOwner().splice(id, 1)
    const selectedIndex = selectPromptPresetId
      ? promptPresetOwner().findIndex((preset) => preset.id === selectPromptPresetId)
      : -1
    settingsOwnerRecord().promptPresetsId =
      selectedIndex >= 0
        ? selectedIndex
        : Math.min(settingsOwnerRecord().promptPresetsId, promptPresetOwner().length - 1)
    applyPromptPresetFieldsToDatabase(db, promptPresetOwner()[settingsOwnerRecord().promptPresetsId])
    const replacementPreset = promptPresetOwner()[settingsOwnerRecord().promptPresetsId]
    const referenceCascade = optimisticallyRehomeGenerationReferences({
      kind: 'promptPreset',
      deletedId: promptPresetId,
      replacement: replacementPreset?.id
        ? { id: replacementPreset.id, name: typeof replacementPreset.name === 'string' ? replacementPreset.name : '' }
        : null,
    })
    const selectionRollback: SplitPresetSelectionRollback = {
      kind: 'prompt',
      previousSelectedId,
      attemptedSelectedId: splitPresetSelectedId(promptPresetOwner(), db.promptPresetsId),
      previousSettings,
      attemptedSettings: snapshotSetPresetSettings(db),
    }
    const entry: PresetRowMutationEntry = {
      kind: 'prompt',
      key: promptPresetId,
      previous: previousPreset,
      attempted: null,
      previousIndex: id,
    }
    const attempt = createPresetRowMutationAttempt([entry], {
      kind: 'prompt',
      previousSelectedId: selectionRollback.previousSelectedId,
      attemptedSelectedId: selectionRollback.attemptedSelectedId,
      previousSettings: selectionRollback.previousSettings,
      attemptedSettings: selectionRollback.attemptedSettings,
    })
    const prepared = preparePresetMutation(
      deleteIntent,
      [presetRowProjectionTarget(entry)],
      SETTINGS_BRIDGE_MUTATION_KEY,
    )
    if (prepared.status === 'durable') {
      recordPresetSelectionProjectionTargets(
        prepared.handle,
        selectionRollback.previousSettings,
        selectionRollback.attemptedSettings,
      )
    }
    return dispatchPresetRowMutation(
      prepared,
      attempt,
      (baseRevision) =>
        deletePromptPresetCommand({
          baseRevision,
          promptPresetId,
          selectPromptPresetId,
        }),
      () => {
        if (promptPresetOwner().filter((preset) => preset.id === promptPresetId).length === 1) {
          referenceCascade.rollback()
        }
      },
    )
  })()
}

export function selectPromptPreset(id: number): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    const previousSelectedId = splitPresetSelectedId(promptPresetOwner(), db.promptPresetsId)
    const previousSettings = snapshotSetPresetSettings(db)
    const promptPresetId = promptPresetOwner()[id]?.id
    if (!promptPresetId) return Promise.resolve({ status: 'failed' })
    if (previousSelectedId === promptPresetId) return Promise.resolve({ status: 'accepted' })
    // Flush row edits while their owner is still selected. Once the selection
    // changes, the prompt-template owner deliberately rejects old-owner timer
    // callbacks, which would otherwise turn a quick preset switch into silent
    // data loss.
    commitPendingPromptTemplateMutations()
    flushPendingSplitPresetPatches()
    if (canUseServerCommands()) {
      flushRegisteredPendingOwnerMutation('settings', {})
    }
    settingsOwnerRecord().promptPresetsId = id
    applyPromptPresetFieldsToDatabase(db, promptPresetOwner()[id])
    const selectionRollback: SplitPresetSelectionRollback = {
      kind: 'prompt',
      previousSelectedId,
      attemptedSelectedId: splitPresetSelectedId(promptPresetOwner(), db.promptPresetsId),
      previousSettings,
      attemptedSettings: snapshotSetPresetSettings(db),
    }
    const attempt = createPresetRowMutationAttempt([], {
      kind: 'prompt',
      previousSelectedId: selectionRollback.previousSelectedId,
      attemptedSelectedId: selectionRollback.attemptedSelectedId,
      previousSettings: selectionRollback.previousSettings,
      attemptedSettings: selectionRollback.attemptedSettings,
    })
    const selectionIntent: DurableMutationIntent = {
      version: 1,
      dependencyKeys: splitPresetMutationDependencyKeys('prompt', previousSelectedId, promptPresetId),
      requests: [
        {
          method: 'POST',
          path: '/prompt-presets/select',
          body: { promptPresetId },
        },
      ],
    }
    const prepared = preparePresetMutation(selectionIntent, [], SETTINGS_BRIDGE_MUTATION_KEY)
    if (prepared.status === 'durable') {
      recordPresetSelectionProjectionTargets(
        prepared.handle,
        selectionRollback.previousSettings,
        selectionRollback.attemptedSettings,
      )
    }
    return dispatchPresetRowMutation(
      prepared,
      attempt,
      (baseRevision) => selectPromptPresetCommand({ baseRevision, promptPresetId }),
      () => {},
      { retryConflictWhile: () => currentSplitPresetSelectedId('prompt') === promptPresetId },
    )
  })()
}

export function reorderPromptPresets(fromIndex: number, toIndex: number): Promise<PresetMutationOutcome> {
  return (() => {
    const db = settingsResourceState.value as Database
    normalizeSplitPresetOwners()
    if (fromIndex === toIndex) return Promise.resolve({ status: 'accepted' })
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= promptPresetOwner().length ||
      toIndex > promptPresetOwner().length
    ) {
      return Promise.resolve({ status: 'failed' })
    }
    flushPendingSplitPresetPatchesForKind('prompt')
    const dependencyKeys = activeSplitPresetOwnerMutationKeys(['prompt'])
    const previousPresetIds = splitPresetIds(promptPresetOwner())
    const promptPresets = [...promptPresetOwner()]
    const movedItem = promptPresets.splice(fromIndex, 1)[0]
    if (!movedItem) return Promise.resolve({ status: 'failed' })
    const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    promptPresets.splice(adjustedToIndex, 0, movedItem)
    settingsOwnerRecord().promptPresetsId = movedSelectedIndex(
      settingsOwnerRecord().promptPresetsId,
      fromIndex,
      adjustedToIndex,
    )
    assignPromptPresetOwner(promptPresets)
    const promptPresetIds = promptPresetOwner()
      .map((preset) => preset.id)
      .filter((id): id is string => !!id)
    const attempt = createPresetReorderMutationAttempt('prompt', previousPresetIds, promptPresetIds)
    const durableIntent: DurableMutationIntent = {
      version: 1,
      ...(dependencyKeys.length > 0 ? { dependencyKeys } : {}),
      requests: [
        {
          method: 'POST',
          path: '/prompt-presets/reorder',
          body: { promptPresetIds: [...promptPresetIds] },
        },
      ],
    }
    const prepared = preparePresetMutation(durableIntent, [presetOrderProjectionTarget('prompt')])
    return dispatchPresetReorderMutation(prepared, attempt, (baseRevision) =>
      reorderPromptPresetsCommand({
        baseRevision,
        promptPresetIds: [...promptPresetIds],
      }),
    )
  })()
}

let legacyPresetExtractionIntent = 0

export function extractLegacyBotPresetByIndex(id: number, mode: 'all' | 'model' | 'prompt') {
  const intent = ++legacyPresetExtractionIntent
  const target = (() => {
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    const preset = legacyPresetOwner()[id]
    return preset?.id ? { presetId: preset.id, hydrated: botPresetHasHydratedSettings(preset) } : null
  })()
  if (!target) return
  if (!target.hydrated) {
    void ensureBotPresetHydratedById(target.presetId).then((hydrated) => {
      if (hydrated && intent === legacyPresetExtractionIntent) {
        extractLegacyBotPresetById(target.presetId, mode, intent)
      }
    })
    return
  }
  extractLegacyBotPresetById(target.presetId, mode, intent)
}

function extractLegacyBotPresetById(presetId: string, mode: 'all' | 'model' | 'prompt', intent: number): void {
  ;(() => {
    if (intent !== legacyPresetExtractionIntent) return
    const db = settingsResourceState.value as Database
    normalizeLegacyPresetOwner()
    normalizeSplitPresetOwners()
    const id = canonicalBotPresetIndexById(presetId)
    if (id < 0) return []
    const preset = legacyPresetOwner()[id]
    if (!botPresetHasHydratedSettings(preset)) return []
    flushPendingSplitPresetPatches()
    const dependencyKeys = activeSplitPresetOwnerMutationKeys(['model', 'prompt'])
    const previousPreset = safeStructuredClone(preset)
    const previousSelectedId = botPresetSelectedId(legacyPresetOwner(), db.botPresetsId)
    const legacyName = typeof preset.name === 'string' && preset.name.trim() ? preset.name : 'Legacy'
    let attemptedModelPreset: ModelPreset | null = null
    let attemptedPromptPreset: PromptPreset | null = null

    if (mode === 'all' || mode === 'model') {
      const modelPreset = createExtractedModelPreset(preset, {
        id: createClientPresetId(),
        name: `${legacyName} Model`,
      }) as ModelPreset
      const existing = findEquivalentModelPreset(modelPresetOwner(), modelPreset)
      if (!existing) {
        modelPresetOwner().push(modelPreset)
        attemptedModelPreset = safeStructuredClone(modelPreset)
      }
    }

    if (mode === 'all' || mode === 'prompt') {
      const promptPreset = createExtractedPromptPreset(preset, {
        id: createClientPresetId(),
        name: `${legacyName} Prompt`,
      }) as PromptPreset
      promptPresetOwner().push(promptPreset)
      attemptedPromptPreset = safeStructuredClone(promptPreset)
    }

    legacyPresetOwner().splice(id, 1)
    settingsOwnerRecord().botPresetsId = normalizedBotPresetsId(
      legacyPresetOwner().length,
      settingsOwnerRecord().botPresetsId,
    )
    const selectionRollback: BotPresetSelectionRollback = {
      previousSelectedId,
      attemptedSelectedId: botPresetSelectedId(legacyPresetOwner(), db.botPresetsId),
    }
    const entries: PresetRowMutationEntry[] = [
      {
        kind: 'legacy',
        key: presetId,
        previous: previousPreset,
        attempted: null,
        previousIndex: id,
      },
    ]
    if (attemptedModelPreset?.id) {
      entries.push({
        kind: 'model',
        key: attemptedModelPreset.id,
        previous: null,
        attempted: attemptedModelPreset,
      })
    }
    if (attemptedPromptPreset?.id) {
      entries.push({
        kind: 'prompt',
        key: attemptedPromptPreset.id,
        previous: null,
        attempted: attemptedPromptPreset,
      })
    }
    const attempt = createPresetRowMutationAttempt(entries, {
      kind: 'legacy',
      previousSelectedId: selectionRollback.previousSelectedId,
      attemptedSelectedId: selectionRollback.attemptedSelectedId,
    })
    const durableIntent: DurableMutationIntent = {
      version: 1,
      ...(dependencyKeys.length > 0 ? { dependencyKeys } : {}),
      requests: [
        {
          method: 'POST',
          path: `/legacy-bot-presets/${encodeURIComponent(presetId)}/extract`,
          body: { mode },
        },
      ],
    }
    const projectionTargets = entries.map(presetRowProjectionTarget)
    if (attemptedModelPreset) projectionTargets.push(presetOrderProjectionTarget('model'))
    if (attemptedPromptPreset) projectionTargets.push(presetOrderProjectionTarget('prompt'))
    projectionTargets.push(presetOrderProjectionTarget('legacy'))
    const prepared = preparePresetMutation(durableIntent, projectionTargets)
    dispatchPresetRowMutation(prepared, attempt, (baseRevision) =>
      extractLegacyBotPresetCommand({
        baseRevision,
        presetId,
        mode,
      }),
    )
  })()
}

function movedSelectedIndex(currentId: number, fromIndex: number, adjustedToIndex: number): number {
  if (currentId === fromIndex) return adjustedToIndex
  if (fromIndex < currentId && adjustedToIndex >= currentId) return currentId - 1
  if (fromIndex > currentId && adjustedToIndex <= currentId) return currentId + 1
  return currentId
}

const MODEL_PRESET_DATABASE_KEY_OVERRIDES: Record<string, string> = {
  NAISettings: databaseKeyForModelPresetField('NAISettings'),
  reasonEffort: databaseKeyForModelPresetField('reasonEffort'),
}

const PROMPT_PRESET_APPLY_FIELDS = PROMPT_PRESET_FIELDS.filter((field) => field !== 'regex' && field !== 'presetRegex')

const PROMPT_PRESET_DATABASE_KEY_OVERRIDES: Record<string, string> = {}

export function applyModelPresetFieldsToDatabase(db: Database, preset: ModelPreset | undefined): void {
  applySplitPresetFieldsToDatabase(db, preset, MODEL_PRESET_FIELDS, MODEL_PRESET_DATABASE_KEY_OVERRIDES)
  applyPromptPresetFieldsToDatabase(db, promptPresetOwner()?.[settingsOwnerRecord().promptPresetsId])
  normalizeModelRoleSettings(db)
  normalizeModelProfileSettings(db, 'projection')
  db.fallbackModels = normalizeLegacyFallbackModels(db.fallbackModels)
  normalizeSeperateParameters(db)
}

export function applyPromptPresetFieldsToDatabase(db: Database, preset: PromptPreset | undefined): void {
  applySplitPresetFieldsToDatabase(db, preset, PROMPT_PRESET_APPLY_FIELDS, PROMPT_PRESET_DATABASE_KEY_OVERRIDES)
  applyPromptPresetRegexFieldToDatabase(db, preset)
  if (promptPresetOverridesModelParameters(preset)) {
    applySplitPresetFieldsToDatabase(
      db,
      preset,
      PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS,
      MODEL_PRESET_DATABASE_KEY_OVERRIDES,
    )
  }
  applySplitPresetFieldsToDatabase(
    db,
    preset,
    PROMPT_PRESET_MODEL_OTHERS_OVERRIDE_FIELDS,
    MODEL_PRESET_DATABASE_KEY_OVERRIDES,
  )
  normalizeModelRoleSettings(db)
  normalizeModelProfileSettings(db, 'projection')
  db.fallbackModels = normalizeLegacyFallbackModels(db.fallbackModels)
  normalizeSeperateParameters(db)
}

function applyPromptPresetRegexFieldToDatabase(db: Database, preset: PromptPreset | undefined): void {
  const regexField = resolvePromptPresetRegexField(preset)
  if (!regexField.present) return
  const target = db as unknown as Record<string, unknown>
  target.presetRegex = safeStructuredClone(regexField.value)
}

function applySplitPresetFieldsToDatabase(
  db: Database,
  preset: Record<string, unknown> | undefined,
  fields: readonly string[],
  databaseKeyOverrides: Record<string, string>,
): void {
  if (!preset) return
  const target = db as unknown as Record<string, unknown>
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(preset, field)) continue
    const databaseKey = databaseKeyOverrides[field] ?? field
    const value = normalizeSplitPresetAppliedValue(
      databaseKey,
      safeStructuredClone(preset[field]),
      normalizeModelProfiles(target.modelProfiles),
    )
    if (isServerCollectionName(databaseKey)) {
      collectionsResourceState.values[databaseKey] = value as never
    } else {
      target[databaseKey] = value
    }
  }
}

function normalizeSplitPresetAppliedValue(
  databaseKey: string,
  value: unknown,
  profiles: readonly ModelProfileRecord[] = [],
): unknown {
  if (databaseKey === 'promptTemplate') return normalizePromptTemplate(value)
  if (databaseKey === 'modelProfiles') return normalizeModelProfiles(value)
  if (databaseKey === 'modelProfileOrder') return normalizeModelProfileOrder(value, profiles)
  if (databaseKey === 'modelRoleProfiles') return normalizeModelRoleProfiles(value)
  if (databaseKey === 'modelRuntimeDefaults') return normalizeModelRuntimeDefaults(value)
  return value
}

export function setPreset(db: Database, newPres: botPreset) {
  db.apiType = newPres.apiType ?? db.apiType
  db.localNetworkMode = newPres.localNetworkMode ?? db.localNetworkMode
  db.localNetworkTimeoutSec = newPres.localNetworkTimeoutSec ?? db.localNetworkTimeoutSec
  db.additionalParams = safeStructuredClone(newPres.additionalParams) ?? db.additionalParams
  db.mainPrompt = newPres.mainPrompt ?? db.mainPrompt
  db.jailbreak = newPres.jailbreak ?? db.jailbreak
  db.globalNote = newPres.globalNote ?? db.globalNote
  db.temperature = newPres.temperature ?? db.temperature
  db.maxContext = newPres.maxContext ?? db.maxContext
  db.maxResponse = newPres.maxResponse ?? db.maxResponse
  db.frequencyPenalty = newPres.frequencyPenalty ?? db.frequencyPenalty
  db.PresensePenalty = newPres.PresensePenalty ?? db.PresensePenalty
  db.formatingOrder = newPres.formatingOrder ?? db.formatingOrder
  db.aiModel = newPres.aiModel ?? db.aiModel
  db.subModel = newPres.subModel ?? db.subModel
  db.modelRoles = normalizeModelRoleOverrides(newPres.modelRoles ?? db.modelRoles)
  db.modelProfiles = normalizeModelProfiles(newPres.modelProfiles ?? db.modelProfiles)
  db.modelProfileOrder = normalizeModelProfileOrder(
    Object.hasOwn(newPres, 'modelProfileOrder')
      ? newPres.modelProfileOrder
      : Object.hasOwn(newPres, 'modelProfiles')
        ? undefined
        : db.modelProfileOrder,
    db.modelProfiles,
  )
  db.modelRoleProfiles = normalizeModelRoleProfiles(newPres.modelRoleProfiles ?? db.modelRoleProfiles)
  db.modelRuntimeDefaults = normalizeModelRuntimeDefaults(newPres.modelRuntimeDefaults ?? db.modelRuntimeDefaults)
  if (
    Object.hasOwn(newPres, 'agents') ||
    Object.hasOwn(newPres, 'agentPresets') ||
    Object.hasOwn(newPres, 'agentPresetDefaultId')
  ) {
    const normalized = normalizeAgentConfiguration(newPres.agents ?? db.agents, newPres.agentPresets ?? db.agentPresets)
    db.agents = normalized.agents
    db.agentPresets = normalized.agentPresets
    const agentPresets = normalized.agentPresets
    const defaultId = normalizeAgentPresetDefaultId(
      newPres.agentPresetDefaultId ?? db.agentPresetDefaultId,
      agentPresets,
    )
    if (defaultId) {
      db.agentPresetDefaultId = defaultId
    } else {
      delete db.agentPresetDefaultId
    }
  }
  db.currentPluginProvider = newPres.currentPluginProvider ?? db.currentPluginProvider
  db.textgenWebUIStreamURL = newPres.textgenWebUIStreamURL ?? db.textgenWebUIStreamURL
  db.textgenWebUIBlockingURL = newPres.textgenWebUIBlockingURL ?? db.textgenWebUIBlockingURL
  db.forceReplaceUrl = newPres.forceReplaceUrl ?? db.forceReplaceUrl
  db.promptPreprocess = newPres.promptPreprocess ?? db.promptPreprocess
  db.bias = newPres.bias ?? db.bias
  db.koboldURL = newPres.koboldURL ?? db.koboldURL
  db.proxyKey = newPres.proxyKey ?? db.proxyKey
  db.ooba = safeStructuredClone(newPres.ooba ?? db.ooba)
  db.ainconfig = safeStructuredClone(newPres.ainconfig ?? db.ainconfig)
  db.openrouterRequestModel = newPres.openrouterRequestModel ?? db.openrouterRequestModel
  db.proxyRequestModel = newPres.proxyRequestModel ?? db.proxyRequestModel
  db.NAIsettings = newPres.NAISettings ?? db.NAIsettings
  db.autoSuggestPrompt = newPres.autoSuggestPrompt ?? db.autoSuggestPrompt
  db.autoSuggestPrefix = newPres.autoSuggestPrefix ?? db.autoSuggestPrefix
  db.autoSuggestClean = newPres.autoSuggestClean ?? db.autoSuggestClean
  db.NAIadventure = newPres.NAIadventure
  db.NAIappendName = newPres.NAIappendName
  db.NAIsettings.cfg_scale ??= 1
  db.NAIsettings.mirostat_tau ??= 0
  db.NAIsettings.mirostat_lr ??= 1
  db.localStopStrings = newPres.localStopStrings
  db.customProxyRequestModel = newPres.customProxyRequestModel ?? ''
  db.reverseProxyOobaArgs = safeStructuredClone(newPres.reverseProxyOobaArgs) ?? {
    mode: 'instruct',
  }
  db.top_p = newPres.top_p ?? 1
  db.promptSettings = safeStructuredClone(newPres.promptSettings) ?? {
    assistantPrefill: '',
    postEndInnerFormat: '',
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
  }
  db.promptSettings.maxThoughtTagDepth ??= -1
  db.repetition_penalty = newPres.repetition_penalty
  db.min_p = newPres.min_p
  db.top_a = newPres.top_a
  db.openrouterProvider = newPres.openrouterProvider
  db.useInstructPrompt = newPres.useInstructPrompt ?? false
  db.customPromptTemplateToggle = newPres.customPromptTemplateToggle ?? ''
  db.templateDefaultVariables = newPres.templateDefaultVariables ?? ''
  db.moduleIntergration = newPres.moduleIntergration ?? ''
  db.top_k = newPres.top_k ?? db.top_k
  db.instructChatTemplate = newPres.instructChatTemplate ?? db.instructChatTemplate
  db.JinjaTemplate = newPres.JinjaTemplate ?? db.JinjaTemplate
  db.jsonSchemaEnabled = newPres.jsonSchemaEnabled ?? false
  db.jsonSchema = newPres.jsonSchema ?? ''
  db.strictJsonSchema = newPres.strictJsonSchema ?? true
  db.extractJson = newPres.extractJson ?? ''
  db.seperateParametersEnabled = newPres.seperateParametersEnabled ?? false
  db.customAPIFormat = safeStructuredClone(newPres.customAPIFormat) ?? LLMFormat.OpenAICompatible
  db.systemContentReplacement = newPres.systemContentReplacement ?? ''
  db.systemRoleReplacement = newPres.systemRoleReplacement ?? 'user'
  db.customFlags = safeStructuredClone(newPres.customFlags) ?? []
  db.enableCustomFlags = newPres.enableCustomFlags ?? false
  const presetRegexField = resolvePromptPresetRegexField(newPres)
  db.presetRegex = (presetRegexField.present ? safeStructuredClone(presetRegexField.value) : []) as customscript[]
  db.reasoningEffort = newPres.reasonEffort ?? 0
  db.thinkingTokens = newPres.thinkingTokens ?? null
  db.thinkingType = newPres.thinkingType ?? 'budget'
  db.deepseekThinkingType = newPres.deepseekThinkingType ?? 'off'
  db.adaptiveThinkingEffort = newPres.adaptiveThinkingEffort ?? 'high'
  db.deepseekReasoningEffort = newPres.deepseekReasoningEffort ?? 'high'
  db.outputImageModal = newPres.outputImageModal ?? false
  if (!db.doNotChangeSeperateModels) {
    db.seperateModelsForAxModels = newPres.seperateModelsForAxModels ?? false
    db.seperateModels = normalizeLegacySeperateModels(newPres.seperateModels)
  }
  if (!db.doNotChangeFallbackModels) {
    db.fallbackModels = normalizeLegacyFallbackModels(newPres.fallbackModels)
    db.fallbackWhenBlankResponse = newPres.fallbackWhenBlankResponse ?? false
  }
  if (db.disableSeperateParameterChangeOnPresetChange) {
    db.seperateParameters = safeStructuredClone(db.seperateParameters)
  } else {
    db.seperateParameters = safeStructuredClone(newPres.seperateParameters)
  }
  normalizeSeperateParameters(db)
  db.modelTools = safeStructuredClone(newPres.modelTools ?? [])
  db.verbosity = newPres.verbosity ?? 1
  db.dynamicOutput = newPres.dynamicOutput

  return db
}

import { encode as encodeMsgpack, decode as decodeMsgpack } from 'msgpackr/index-no-eval'
import * as fflate from 'fflate'
import type { OnnxModelFiles } from '../process/transformers'
import type { RisuModule } from '../process/modules'
import { decodeRPack, encodeRPack } from '../rpack/rpack_js'
import { selectedCharID } from '../stores/coreStores.svelte'
import { LLMFlags, LLMFormat, LLMTokenizer } from '../model/modellist'
import type { HypaModel } from '../process/memory/hypamemory'
import type { SerializableHypaV3Data } from '../process/memory/hypav3'
import { defaultHotkeys, RETIRED_HOTKEY_ACTIONS, type Hotkey } from '../defaulthotkeys'
import type { OpenAIChat } from '../process/index.svelte'
import type { Loadout } from '../loadout'

export async function downloadPreset(id: number, type: 'json' | 'risupreset' | 'return' = 'json') {
  const promptPresetId = promptPresetOwner()?.[id]?.id
  if (typeof promptPresetId === 'string' && promptPresetId.trim() !== '') {
    // Prompt-preset list resources contain metadata shells. Export is a
    // background consumer, so hydrate this explicit owner before taking the
    // serialization snapshot without replacing the visible selected template.
    const hydrated = await ensurePromptTemplateHydrated({
      applyProjection: false,
      promptPresetId,
    })
    if (!hydrated) {
      alertError(language.errors.promptTemplateUnavailable)
      return
    }
    const hydratedIndex = promptPresetOwner().findIndex((preset) => preset?.id === promptPresetId)
    if (hydratedIndex < 0) {
      alertError(language.errors.promptTemplateUnavailable)
      return
    }
    id = hydratedIndex
  }
  let pres = promptPresetExportPayload(safeStructuredClone(promptPresetOwner()[id]))
  pres.openAIKey = ''
  pres.forceReplaceUrl = ''
  pres.forceReplaceUrl2 = ''
  pres.proxyKey = ''
  pres.textgenWebUIStreamURL = ''
  pres.textgenWebUIBlockingURL = ''

  if (type === 'json') {
    downloadFile(pres.name + '_preset.json', Buffer.from(JSON.stringify(pres, null, 2)))
  } else if (type === 'risupreset' || type === 'return') {
    const buf = fflate.compressSync(
      encodeMsgpack({
        presetVersion: 2,
        type: 'preset',
        preset: await encryptBuffer(encodeMsgpack(pres), 'risupreset'),
      }),
    )

    const buf2 = await encodeRPack(buf)

    if (type === 'risupreset') {
      downloadFile(pres.name + '_preset.risup', buf2)
    } else {
      return {
        data: pres,
        buf: buf2,
      }
    }
  }

  alertNormal(language.successExport)

  return {
    data: pres,
    buf: null,
  }
}

function reportPresetImportOutcome(outcome: PresetImportOutcome): PresetImportOutcome {
  if (outcome === 'applied') {
    alertNormal(language.successImport)
  } else if (outcome === 'queued') {
    alertNormal(language.presetImportQueued)
  } else {
    alertError(language.presetImportFailed)
  }
  return outcome
}

export async function importPreset(
  f: {
    name: string
    data: Uint8Array
  } | null = null,
): Promise<PresetImportOutcome | null> {
  if (!f) {
    f = await selectSingleFile(['json', 'preset', 'risupreset', 'risup'])
  }
  if (!f) {
    return null
  }
  try {
    let pre: any
    let importedSource: unknown
    const fileName = f.name.toLowerCase()
    if (fileName.endsWith('.risupreset') || fileName.endsWith('.risup')) {
      let data = f.data
      if (fileName.endsWith('.risup')) {
        data = await decodeRPack(data)
      }
      const decoded = await decodeMsgpack(fflate.decompressSync(data))
      if (
        !decoded ||
        typeof decoded !== 'object' ||
        Array.isArray(decoded) ||
        !((decoded.presetVersion === 0 || decoded.presetVersion === 2) && decoded.type === 'preset')
      ) {
        throw new Error('Invalid preset envelope')
      }
      importedSource = decodeMsgpack(Buffer.from(await decryptBuffer(decoded.preset ?? decoded.pres, 'risupreset')))
      if (!importedSource || typeof importedSource !== 'object' || Array.isArray(importedSource)) {
        throw new Error('Invalid preset payload')
      }
      pre = {
        ...presetTemplate,
        ...(importedSource as Record<string, unknown>),
      }
    } else {
      importedSource = JSON.parse(Buffer.from(f.data).toString('utf-8'))
      if (!importedSource || typeof importedSource !== 'object' || Array.isArray(importedSource)) {
        throw new Error('Invalid preset payload')
      }
      pre = { ...presetTemplate, ...(importedSource as Record<string, unknown>) }
    }

    if (pre.presetVersion && pre.presetVersion >= 3) {
      //NAI preset
      const pr = safeStructuredClone(prebuiltPresets.NAI)
      pr.temperature = pre.parameters.temperature * 100
      pr.maxResponse = pre.parameters.max_length
      pr.NAISettings.topK = pre.parameters.top_k
      pr.NAISettings.topP = pre.parameters.top_p
      pr.NAISettings.topA = pre.parameters.top_a
      pr.NAISettings.typicalp = pre.parameters.typical_p
      pr.NAISettings.tailFreeSampling = pre.parameters.tail_free_sampling
      pr.NAISettings.repetitionPenalty = pre.parameters.repetition_penalty
      pr.NAISettings.repetitionPenaltyRange = pre.parameters.repetition_penalty_range
      pr.NAISettings.repetitionPenaltySlope = pre.parameters.repetition_penalty_slope
      pr.NAISettings.frequencyPenalty = pre.parameters.repetition_penalty_frequency
      pr.NAISettings.repostitionPenaltyPresence = pre.parameters.repetition_penalty_presence
      pr.PresensePenalty = pre.parameters.repetition_penalty_presence * 100
      pr.NAISettings.cfg_scale = pre.parameters.cfg_scale
      pr.NAISettings.mirostat_lr = pre.parameters.mirostat_lr
      pr.NAISettings.mirostat_tau = pre.parameters.mirostat_tau
      pr.name = pre.name ?? 'Imported'
      return reportPresetImportOutcome(await addImportedPromptPreset(pr))
    }

    if (Array.isArray(pre?.prompt_order?.[0]?.order) && Array.isArray(pre?.prompts)) {
      //ST preset
      const pr = safeStructuredClone(presetTemplate)
      pr.promptTemplate = []

      function findPrompt(identifier: number) {
        return pre.prompts.find((p: any) => p.identifier === identifier)
      }
      pr.temperature = (pre.temperature ?? 0.8) * 100
      pr.frequencyPenalty = (pre.frequency_penalty ?? 0.7) * 100
      pr.PresensePenalty = pre.presence_penalty * 0.7 * 100
      pr.top_p = pre.top_p ?? 1

      for (const prompt of pre.prompt_order[0].order) {
        if (!prompt?.enabled) {
          continue
        }
        const p = findPrompt(prompt?.identifier ?? '')
        if (p) {
          switch (p.identifier) {
            case 'main': {
              pr.promptTemplate.push({
                type: 'plain',
                type2: 'main',
                text: p.content ?? '',
                role: p.role ?? 'system',
              })
              break
            }
            case 'jailbreak':
            case 'nsfw': {
              pr.promptTemplate.push({
                type: 'jailbreak',
                type2: 'normal',
                text: p.content ?? '',
                role: p.role ?? 'system',
              })
              break
            }
            case 'dialogueExamples':
            case 'charPersonality':
            case 'scenario': {
              break //ignore
            }
            case 'chatHistory': {
              pr.promptTemplate.push({
                type: 'chat',
                rangeEnd: 'end',
                rangeStart: 0,
              })
              break
            }
            case 'worldInfoBefore': {
              pr.promptTemplate.push({
                type: 'lorebook',
              })
              break
            }
            case 'worldInfoAfter': {
              break
            }
            case 'charDescription': {
              pr.promptTemplate.push({
                type: 'description',
              })
              break
            }
            case 'personaDescription': {
              pr.promptTemplate.push({
                type: 'persona',
              })
              break
            }
            default: {
              pr.promptTemplate.push({
                type: 'plain',
                type2: 'normal',
                text: p.content ?? '',
                role: p.role ?? 'system',
              })
            }
          }
        }
      }
      if (pre?.assistant_prefill) {
        pr.promptTemplate.push({
          type: 'postEverything',
        })
        pr.promptTemplate.push({
          type: 'plain',
          type2: 'main',
          text: `{{#if {{prefill_supported}}}}${pre?.assistant_prefill}{{/if}}`,
          role: 'bot',
        })
      }
      pr.name = 'Imported ST Preset'
      return reportPresetImportOutcome(await addImportedPromptPreset(pr))
    }
    pre.name ??= 'Imported'
    if (hasModelPresetOnlyFields(importedSource)) {
      const importedRecord = importedSource as Record<string, unknown>
      const primaryModel =
        typeof importedRecord.aiModel === 'string' && importedRecord.aiModel.trim()
          ? importedRecord.aiModel
          : language.legacyPresetModelNotSpecified
      const auxiliaryModel =
        typeof importedRecord.subModel === 'string' && importedRecord.subModel.trim()
          ? importedRecord.subModel
          : language.legacyPresetModelNotSpecified
      const selection = await alertSelect(
        [language.legacyPresetImportModelAndPrompt, language.legacyPresetImportPromptOnly],
        language.legacyPresetImportChoice(f.name, primaryModel, auxiliaryModel),
      )
      if (selection === null) return null
      if (selection === '0') {
        return reportPresetImportOutcome(await addImportedLegacyPreset(pre))
      }
    }
    return reportPresetImportOutcome(await addImportedPromptPreset(pre))
  } catch {
    alertError(language.errors.noData)
    return 'failed'
  }
}
