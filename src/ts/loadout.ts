import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from './clientSession'
import {
  applyPersonaStateSnapshotLocally,
  currentPersonaStateSnapshot,
  flushPendingSelectedPersonaUpdate,
  selectUserPersonaLocally,
  type PersonaStateSnapshot,
} from './persona'
import { safeStructuredClone } from './polyfill'
import { createNonSecurityUuid } from './nonSecurityUuid'
import { invalidateModuleRenderRevision } from './moduleRenderRevision'
import {
  canUseServerCommands,
  createLoadoutCommand,
  deleteLoadoutCommand,
  enableModuleCommand,
  favoriteLoadoutCommand,
  patchSettingsGroup,
  runServerCommand,
  runServerCommandSequence,
  saveChatGenerationSettingsCommand,
  selectModelPresetCommand,
  selectPromptPresetCommand,
  selectPersonaCommand,
  selectPresetCommand,
  settingsGroupForKey,
  touchLoadoutCommand,
  type LoadoutSnapshot,
  type ServerCommandExecutionWrapper,
  type ServerCommandResult,
  type ServerCommandSequenceEntry,
} from './server/commands'
import { isCanonicalLoadout, isCanonicalLoadoutCollection } from './server/loadoutCanonical'
import {
  charactersResourceState,
  collectionsResourceState,
  getCharacterResourceOwner,
  settingsResourceState,
} from './server/resourceState.svelte'
import { applyAttemptedFieldRollback, applyAttemptedKeyedListRollback } from './server/staleStateGuards'
import type { ChatGenerationSettings } from './chatGenerationSettings'
import { resolveEffectiveAgentPresetId } from './agentPresetResolver'
import {
  applyModelPresetFieldsToDatabase,
  applyPromptPresetFieldsToDatabase,
  beginLegacyPresetSelectionIntent,
  botPresetHasHydratedSettings,
  ensureBotPresetHydratedById,
  flushPendingSplitPresetPatch,
  isLegacyPresetSelectionIntentCurrent,
  setPreset,
  splitPresetMutationKey,
  type Database,
  type ModelPreset,
  type PromptPreset,
  type botPreset,
} from './storage/database.svelte'
import {
  dispatchDurableMutation,
  executePreparedDurableMutationWithinQueue,
  type DurableMutationSettlement,
} from './server/durableMutationDispatch'
import {
  discardPendingMutation,
  isPendingMutationProjectionFenceCurrent,
  pendingMutationChatGenerationSettingsProjectionTarget,
  pendingMutationLoadoutRowProjectionTarget,
  pendingMutationModuleEnabledProjectionTarget,
  pendingMutationPersonaRowProjectionTarget,
  pendingMutationPresetRowProjectionTarget,
  pendingMutationProjectionFence,
  pendingMutationProjectionTargets,
  pendingMutationSelectionProjectionTarget,
  pendingMutationSettingsFieldProjectionTarget,
  recordPendingMutationProjectionTargets,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
  type PendingMutationPersistenceStatus,
  type PendingMutationProjectionFence,
} from './server/pendingMutationOutbox'
import { SETTINGS_BRIDGE_MUTATION_KEY } from './server/settingsMutationKey'
import {
  commitPendingPromptTemplateOwnerMutations,
  promptTemplateOwnerMutationKey,
} from './server/promptTemplateMutations.svelte'
import {
  chatResourceOwnerMutationKey,
  loadoutOwnerMutationKey,
  moduleOwnerMutationKey,
} from './server/resourceOwnerMutationKeys'
import { PERSONA_SELECTION_MUTATION_KEY, personaOwnerMutationKey } from './server/personaMutationKeys'
import { chatGenerationSettingsMutationDependencyKeys } from './server/chatGenerationSettingsMutationKeys'
import { selectedCharID } from './stores.svelte'
import { get } from 'svelte/store'

export type Loadout = {
  name: string
  id: string
  lastUsed: number
  favorite: boolean
  characterIds: string[]
  modules: string[]
  globalVariables: { [key: string]: string }
  presetName: string
  modelPresetId?: string
  modelPresetName?: string
  promptPresetId?: string
  promptPresetName?: string
  agentPresetId?: string
  agentPresetName?: string
  togglePresetId?: string
  personaId: string
}

type SettingsOwnerSnapshot = Record<string, unknown>

function ownerStatusUsable(status: string | undefined): boolean {
  return status === 'ready'
}

/** Read the canonical settings owner without materializing the aggregate database facade. */
function currentSettingsOwnerSnapshot(): SettingsOwnerSnapshot | null {
  if (!ownerStatusUsable(settingsResourceState.status)) return null
  return cloneJsonValue(settingsResourceState.value as Record<string, unknown>)
}

function currentSettingsOwner(): Record<string, unknown> | null {
  return ownerStatusUsable(settingsResourceState.status)
    ? (settingsResourceState.value as Record<string, unknown>)
    : null
}

function uniquePresetCollectionOwner<T extends { id?: string }>(
  name: 'botPresets' | 'modelPresets' | 'promptPresets',
): T[] | null {
  if (
    !ownerStatusUsable(collectionsResourceState.status) ||
    !ownerStatusUsable(collectionsResourceState.statuses[name])
  ) {
    return null
  }
  const value = collectionsResourceState.values[name]
  if (!Array.isArray(value)) return null
  const ids = new Set<string>()
  for (const candidate of value) {
    const id = nonBlankId(candidate?.id)
    if (!id || ids.has(id)) return null
    ids.add(id)
  }
  return value as T[]
}

function replacePresetCollectionOwner<T extends { id?: string }>(
  name: 'botPresets' | 'modelPresets' | 'promptPresets',
  presets: T[],
): boolean {
  if (!uniquePresetCollectionOwner(name)) return false
  const ids = presets.map((preset) => nonBlankId(preset?.id))
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return false
  collectionsResourceState.values[name] = cloneJsonValue(presets) as never
  return true
}

function currentLoadoutCollectionOwner(): Loadout[] | null {
  if (
    !ownerStatusUsable(collectionsResourceState.status) ||
    !ownerStatusUsable(collectionsResourceState.statuses.loadouts)
  ) {
    return null
  }
  const loadouts = collectionsResourceState.values.loadouts
  return isCanonicalLoadoutCollection(loadouts) ? (loadouts as Loadout[]) : null
}

function replaceLoadoutCollectionOwner(loadouts: Loadout[]): boolean {
  if (!isCanonicalLoadoutCollection(loadouts) || !currentLoadoutCollectionOwner()) return false
  collectionsResourceState.values.loadouts = cloneJsonValue(loadouts)
  return true
}

function currentCharacterOwner() {
  if (!ownerStatusUsable(charactersResourceState.status)) return undefined
  const candidate = charactersResourceState.characters[get(selectedCharID)]
  const characterId = nonBlankId(candidate?.chaId)
  if (!characterId) return undefined
  const owner = getCharacterResourceOwner(characterId)
  return owner === candidate ? owner : undefined
}

function settingsOwnerSelectionIndex(key: 'botPresetsId' | 'modelPresetsId' | 'promptPresetsId'): number | null {
  if (!ownerStatusUsable(settingsResourceState.standaloneStatuses[key])) return null
  const value = (settingsResourceState.value as Record<string, unknown>)[key]
  return Number.isInteger(value) ? (value as number) : null
}

function currentLoadoutSettingsField<T>(key: string, fallback: T): T {
  const value = currentSettingsOwner()?.[key]
  return value === undefined ? fallback : (value as T)
}

function replaceSettingsOwnerFields(fields: Record<string, unknown>): boolean {
  const settings = currentSettingsOwner()
  if (!settings) return false
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete settings[key]
    else settings[key] = cloneJsonValue(value)
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'enabledModules')) invalidateModuleRenderRevision()
  return true
}

export function makeLoadout(options: { name: string }): Loadout {
  const character = currentCharacterOwner()
  const id = createNonSecurityUuid()
  const legacyPreset =
    uniquePresetCollectionOwner<botPreset>('botPresets')?.[settingsOwnerSelectionIndex('botPresetsId') ?? -1]
  const modelPreset =
    uniquePresetCollectionOwner<ModelPreset>('modelPresets')?.[settingsOwnerSelectionIndex('modelPresetsId') ?? -1]
  const promptPreset =
    uniquePresetCollectionOwner<PromptPreset>('promptPresets')?.[settingsOwnerSelectionIndex('promptPresetsId') ?? -1]
  const agentPreset = currentChatAgentPreset()
  const togglePresetId = currentActiveChatRecord()?.chat.generationSettings?.togglePresetId
  const legacyPresetName = readablePresetName(legacyPreset)
  const modelPresetName = readablePresetName(modelPreset)
  const promptPresetName = readablePresetName(promptPreset)
  const agentPresetName = readablePresetName(agentPreset)
  const selectedPersonaId = currentPersonaStateSnapshot().selectedPersonaId
  return safeStructuredClone({
    name: options.name.trim() ? options.name : 'New Loadout',
    id: id,
    lastUsed: Date.now(),
    favorite: false,
    characterIds: character ? [character.chaId] : [],
    modules: currentLoadoutSettingsField<string[]>('enabledModules', []),
    globalVariables: currentLoadoutSettingsField<Record<string, string>>('globalChatVariables', {}),
    presetName: legacyPresetName || [modelPresetName, promptPresetName].filter(Boolean).join(' / '),
    modelPresetId: nonBlankId(modelPreset?.id) ?? '',
    modelPresetName,
    promptPresetId: nonBlankId(promptPreset?.id) ?? '',
    promptPresetName,
    agentPresetId: nonBlankId(agentPreset?.id) ?? '',
    agentPresetName,
    togglePresetId: typeof togglePresetId === 'string' ? togglePresetId : '',
    personaId: typeof selectedPersonaId === 'string' ? selectedPersonaId : '',
  })
}

type LoadoutApplyOption = 'modules' | 'globalVariables' | 'preset' | 'persona'

export type LoadoutApplyStatus = 'applied' | 'queued' | 'superseded' | 'preset-hydration-failed' | 'persistence-failed'

export type LoadoutMutationStatus = 'accepted' | 'queued' | 'superseded' | 'failed' | 'not-found'

export interface LoadoutCreateResult {
  status: Exclude<LoadoutMutationStatus, 'not-found'>
  loadout: Loadout
}

type ServerCommandFactory = (baseRevision: number) => Promise<ServerCommandResult>

interface LoadoutListRollbackEntry {
  key: string
  previous: Loadout | null
  attempted: Loadout | null
  previousIndex?: number
}

interface LoadoutFavoriteRollback {
  loadoutId: string
  ownerRevision: number | null
  previousFavorite: boolean
  attemptedFavorite: boolean
  attemptedRow: Loadout
  previousIndex: number
}

interface LoadoutTouchRollback {
  loadoutId: string
  ownerRevision: number | null
  previous: Partial<Pick<Loadout, 'lastUsed' | 'characterIds'>>
  attempted: Partial<Pick<Loadout, 'lastUsed' | 'characterIds'>>
  attemptedRow?: Loadout
  previousIndex?: number
  previousLastLoadedLoadoutName: string
  attemptedLastLoadedLoadoutName: string
}

interface LoadoutModuleMembershipRollback {
  moduleId: string
  previousEnabled: boolean
  attemptedEnabled: boolean
  previousModules: string[]
  attemptedModules: string[]
}

interface LoadoutGlobalVariablesRollback {
  previous: { [key: string]: string }
  attempted: { [key: string]: string }
}

interface LoadoutPersonaRowRollback {
  personaId: string
  previous: Record<string, unknown>
  attempted: Record<string, unknown>
}

interface LoadoutPersonaSelectionRollback {
  rows: LoadoutPersonaRowRollback[]
  previousSelectedPersonaId: string | null
  attemptedSelectedPersonaId: string | null
  previousMirror: Pick<PersonaStateSnapshot, 'selectedPersona' | 'username' | 'userIcon' | 'personaPrompt' | 'userNote'>
  attemptedMirror: Pick<
    PersonaStateSnapshot,
    'selectedPersona' | 'username' | 'userIcon' | 'personaPrompt' | 'userNote'
  >
}

interface PresetFieldRollback {
  presetId: string
  previous: Record<string, unknown>
  attempted: Record<string, unknown>
}

interface PresetSettingsRollback {
  previous: Partial<Record<SetPresetRollbackKey, unknown>>
  attempted: Partial<Record<SetPresetRollbackKey, unknown>>
  changedKeys: SetPresetRollbackKey[]
  retainedPrevious?: Partial<Record<SetPresetRollbackKey, unknown>>
}

interface LegacyPresetSelectionRollback extends PresetSettingsRollback {
  previousSelectedId: string | null
  attemptedSelectedId: string | null
  saveCurrentRollback: PresetFieldRollback | null
}

type SplitPresetKind = 'model' | 'prompt'

interface SplitPresetSelectionRollback extends PresetSettingsRollback {
  kind: SplitPresetKind
  previousSelectedId: string | null
  attemptedSelectedId: string | null
}

interface AgentPresetSelectionRollback {
  characterId: string | undefined
  chatId: string
  hadGenerationSettings: boolean
  previousGenerationSettings?: ChatGenerationSettings
  attemptedGenerationSettings: ChatGenerationSettings
}

interface LoadoutApplyStep {
  succeeded: boolean
  command: ServerCommandFactory
  rollback: () => void
  reapply?: (isTargetCurrent: (target: string) => boolean) => void
  executionWrapper?: ServerCommandExecutionWrapper
  durability?: PreparedLoadoutDurableStep
  presetProjection?: PresetSettingsRollback
}

interface PreparedLoadoutDurableStep {
  handle: PendingMutationHandle
  intent: DurableMutationIntent
  wrapperStarted: boolean
  wrapperFailed: boolean
  initialPersistence: PendingMutationPersistenceStatus | null
  settlement: DurableMutationSettlement | null
  projectionTargets: Set<string>
}

interface LoadoutModulePlan {
  moduleId: string
  enabled: boolean
  durability: PreparedLoadoutDurableStep | null
}

const SET_PRESET_ROLLBACK_KEYS = [
  'apiType',
  'openAIKey',
  'localNetworkMode',
  'localNetworkTimeoutSec',
  'additionalParams',
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

const PRESET_SNAPSHOT_KEY_PAIRS: Array<[string, string]> = [
  ['name', 'name'],
  ['apiType', 'apiType'],
  ['openAIKey', 'openAIKey'],
  ['localNetworkMode', 'localNetworkMode'],
  ['localNetworkTimeoutSec', 'localNetworkTimeoutSec'],
  ['additionalParams', 'additionalParams'],
  ['mainPrompt', 'mainPrompt'],
  ['jailbreak', 'jailbreak'],
  ['globalNote', 'globalNote'],
  ['temperature', 'temperature'],
  ['maxContext', 'maxContext'],
  ['maxResponse', 'maxResponse'],
  ['frequencyPenalty', 'frequencyPenalty'],
  ['PresensePenalty', 'PresensePenalty'],
  ['formatingOrder', 'formatingOrder'],
  ['aiModel', 'aiModel'],
  ['subModel', 'subModel'],
  ['modelRoles', 'modelRoles'],
  ['modelProfiles', 'modelProfiles'],
  ['modelProfileOrder', 'modelProfileOrder'],
  ['modelRoleProfiles', 'modelRoleProfiles'],
  ['modelRuntimeDefaults', 'modelRuntimeDefaults'],
  ['agents', 'agents'],
  ['agentPresets', 'agentPresets'],
  ['agentPresetDefaultId', 'agentPresetDefaultId'],
  ['currentPluginProvider', 'currentPluginProvider'],
  ['textgenWebUIStreamURL', 'textgenWebUIStreamURL'],
  ['textgenWebUIBlockingURL', 'textgenWebUIBlockingURL'],
  ['forceReplaceUrl', 'forceReplaceUrl'],
  ['promptPreprocess', 'promptPreprocess'],
  ['bias', 'bias'],
  ['koboldURL', 'koboldURL'],
  ['proxyKey', 'proxyKey'],
  ['ooba', 'ooba'],
  ['ainconfig', 'ainconfig'],
  ['proxyRequestModel', 'proxyRequestModel'],
  ['openrouterRequestModel', 'openrouterRequestModel'],
  ['NAISettings', 'NAIsettings'],
  ['NAIadventure', 'NAIadventure'],
  ['NAIappendName', 'NAIappendName'],
  ['localStopStrings', 'localStopStrings'],
  ['autoSuggestPrompt', 'autoSuggestPrompt'],
  ['customProxyRequestModel', 'customProxyRequestModel'],
  ['reverseProxyOobaArgs', 'reverseProxyOobaArgs'],
  ['top_p', 'top_p'],
  ['promptSettings', 'promptSettings'],
  ['repetition_penalty', 'repetition_penalty'],
  ['min_p', 'min_p'],
  ['top_a', 'top_a'],
  ['openrouterProvider', 'openrouterProvider'],
  ['useInstructPrompt', 'useInstructPrompt'],
  ['customPromptTemplateToggle', 'customPromptTemplateToggle'],
  ['templateDefaultVariables', 'templateDefaultVariables'],
  ['moduleIntergration', 'moduleIntergration'],
  ['top_k', 'top_k'],
  ['instructChatTemplate', 'instructChatTemplate'],
  ['JinjaTemplate', 'JinjaTemplate'],
  ['jsonSchemaEnabled', 'jsonSchemaEnabled'],
  ['jsonSchema', 'jsonSchema'],
  ['strictJsonSchema', 'strictJsonSchema'],
  ['extractJson', 'extractJson'],
  ['seperateParametersEnabled', 'seperateParametersEnabled'],
  ['seperateParameters', 'seperateParameters'],
  ['customAPIFormat', 'customAPIFormat'],
  ['systemContentReplacement', 'systemContentReplacement'],
  ['systemRoleReplacement', 'systemRoleReplacement'],
  ['customFlags', 'customFlags'],
  ['enableCustomFlags', 'enableCustomFlags'],
  ['regex', 'presetRegex'],
  ['reasonEffort', 'reasoningEffort'],
  ['thinkingTokens', 'thinkingTokens'],
  ['thinkingType', 'thinkingType'],
  ['deepseekThinkingType', 'deepseekThinkingType'],
  ['adaptiveThinkingEffort', 'adaptiveThinkingEffort'],
  ['deepseekReasoningEffort', 'deepseekReasoningEffort'],
  ['outputImageModal', 'outputImageModal'],
  ['seperateModelsForAxModels', 'seperateModelsForAxModels'],
  ['seperateModels', 'seperateModels'],
  ['modelTools', 'modelTools'],
  ['fallbackModels', 'fallbackModels'],
  ['fallbackWhenBlankResponse', 'fallbackWhenBlankResponse'],
  ['verbosity', 'verbosity'],
  ['dynamicOutput', 'dynamicOutput'],
]

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

function recordFieldMatchesSnapshot(
  target: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  key: string,
): boolean {
  const targetHasKey = Object.hasOwn(target, key)
  const snapshotHasKey = Object.hasOwn(snapshot, key)
  return targetHasKey === snapshotHasKey && (!targetHasKey || snapshotJson(target[key]) === snapshotJson(snapshot[key]))
}

function applyRetainedAttemptedFields(input: {
  target: Record<string, unknown>
  previous: Record<string, unknown>
  attempted: Record<string, unknown>
  keys?: Iterable<string>
}): void {
  const keys = input.keys ?? new Set([...Object.keys(input.previous), ...Object.keys(input.attempted)])
  for (const key of keys) {
    if (recordFieldMatchesSnapshot(input.target, input.attempted, key)) continue
    if (!recordFieldMatchesSnapshot(input.target, input.previous, key)) continue
    if (Object.hasOwn(input.attempted, key)) {
      input.target[key] = cloneJsonValue(input.attempted[key])
    } else {
      delete input.target[key]
    }
  }
}

function snapshotPresetSettings(): Partial<Record<SetPresetRollbackKey, unknown>> {
  const dbRecord = currentSettingsOwner() as Record<SetPresetRollbackKey, unknown> | null
  const setPresetSettings: Partial<Record<SetPresetRollbackKey, unknown>> = {}
  if (!dbRecord) return setPresetSettings
  for (const key of SET_PRESET_ROLLBACK_KEYS) {
    setPresetSettings[key] = cloneJsonValue(dbRecord[key])
  }
  return setPresetSettings
}

function changedPresetSettingsKeys(
  previous: Partial<Record<SetPresetRollbackKey, unknown>>,
  attempted: Partial<Record<SetPresetRollbackKey, unknown>>,
): SetPresetRollbackKey[] {
  return SET_PRESET_ROLLBACK_KEYS.filter((key) => snapshotJson(previous[key]) !== snapshotJson(attempted[key]))
}

/**
 * Materialize only the detached compatibility shape needed by the established
 * preset projection helpers. This is not a resident aggregate owner and is
 * never written back wholesale: projection below copies only explicit
 * settings-owned fields.
 */
function materializePresetProjectionDatabase(input: {
  settings: SettingsOwnerSnapshot
  botPresets?: botPreset[]
  modelPresets?: ModelPreset[]
  promptPresets?: PromptPreset[]
}): Database {
  return {
    ...cloneJsonValue(input.settings),
    botPresets: cloneJsonValue(input.botPresets ?? []),
    modelPresets: cloneJsonValue(input.modelPresets ?? []),
    promptPresets: cloneJsonValue(input.promptPresets ?? []),
  } as unknown as Database
}

function projectPresetSettingsOwner(draft: Database): boolean {
  const settings = currentSettingsOwner()
  if (!settings) return false
  const draftRecord = draft as unknown as Record<string, unknown>
  for (const key of SET_PRESET_ROLLBACK_KEYS) {
    if (Object.hasOwn(draftRecord, key)) settings[key] = cloneJsonValue(draftRecord[key])
    else delete settings[key]
  }
  return true
}

function registerPreparedLoadoutProjectionTargets(
  prepared: PreparedLoadoutDurableStep | null,
  targets: readonly string[],
): void {
  if (!prepared) return
  for (const target of targets) prepared.projectionTargets.add(target)
  recordPendingMutationProjectionTargets(prepared.handle, targets)
}

function rollbackLoadoutListEntry(entry: LoadoutListRollbackEntry): void {
  const owner = currentLoadoutCollectionOwner()
  if (!owner) return
  const list = cloneJsonValue(owner)
  const rolledBack = applyAttemptedKeyedListRollback<Loadout, string>({
    list,
    entries: [entry],
    getKey: (loadout) => loadout?.id,
  })
  if (rolledBack.length > 0) replaceLoadoutCollectionOwner(list)
}

function rollbackCreatedLoadout(attemptedLoadout: Loadout): void {
  rollbackLoadoutListEntry({
    key: attemptedLoadout.id,
    previous: null,
    attempted: cloneJsonValue(attemptedLoadout),
  })
}

function isPendingLoadoutProjectionCurrent(handle: PendingMutationHandle, loadoutId: string): boolean {
  const fence = pendingMutationProjectionFence(handle, pendingMutationLoadoutRowProjectionTarget(loadoutId))
  return fence !== null && isPendingMutationProjectionFenceCurrent(fence)
}

function reapplyRetainedCreatedLoadout(attemptedLoadout: Loadout, attemptedIndex: number): void {
  const owner = currentLoadoutCollectionOwner()
  if (!owner || owner.some((candidate) => candidate.id === attemptedLoadout.id)) return
  const list = cloneJsonValue(owner)
  list.splice(Math.min(Math.max(attemptedIndex, 0), list.length), 0, cloneJsonValue(attemptedLoadout))
  replaceLoadoutCollectionOwner(list)
}

function reapplyRetainedFavoriteLoadout(rollback: LoadoutFavoriteRollback): void {
  const owner = currentLoadoutCollectionOwner()
  if (!owner) return
  const list = cloneJsonValue(owner)
  let loadout = list.find((candidate) => candidate.id === rollback.loadoutId)
  if (!loadout) {
    const index = Math.min(Math.max(rollback.previousIndex, 0), list.length)
    list.splice(index, 0, cloneJsonValue(rollback.attemptedRow))
    loadout = list[index]
  }
  if (loadout) loadout.favorite = rollback.attemptedFavorite
  replaceLoadoutCollectionOwner(list)
}

function reapplyRetainedDeletedLoadout(loadoutId: string): void {
  const owner = currentLoadoutCollectionOwner()
  if (!owner) return
  const list = cloneJsonValue(owner)
  const index = list.findIndex((candidate) => candidate.id === loadoutId)
  if (index !== -1) {
    list.splice(index, 1)
    replaceLoadoutCollectionOwner(list)
  }
}

function rollbackDeletedLoadout(previousLoadout: Loadout, previousIndex: number): void {
  rollbackLoadoutListEntry({
    key: previousLoadout.id,
    previous: cloneJsonValue(previousLoadout),
    attempted: null,
    previousIndex,
  })
}

function rollbackLoadoutFavorite(rollback: LoadoutFavoriteRollback): void {
  if (collectionsResourceState.revision !== rollback.ownerRevision) return
  const owner = currentLoadoutCollectionOwner()
  if (!owner) return
  const list = cloneJsonValue(owner)
  const loadout = list.find((item) => item.id === rollback.loadoutId)
  if (!loadout) return
  applyAttemptedFieldRollback({
    target: loadout as unknown as Record<string, unknown>,
    previous: { favorite: rollback.previousFavorite },
    attempted: { favorite: rollback.attemptedFavorite },
    keys: ['favorite'],
  })
  replaceLoadoutCollectionOwner(list)
}

function rollbackLoadoutTouch(rollback: LoadoutTouchRollback): void {
  const owner = collectionsResourceState.revision === rollback.ownerRevision ? currentLoadoutCollectionOwner() : null
  if (owner) {
    const list = cloneJsonValue(owner)
    const loadout = list.find((item) => item.id === rollback.loadoutId)
    if (loadout) {
      applyAttemptedFieldRollback({
        target: loadout as unknown as Record<string, unknown>,
        previous: rollback.previous as Record<string, unknown>,
        attempted: rollback.attempted as Record<string, unknown>,
        keys: Object.keys(rollback.attempted),
      })
      replaceLoadoutCollectionOwner(list)
    }
  }

  const settings = currentSettingsOwner()
  if (settings?.lastLoadedLoadoutName === rollback.attemptedLastLoadedLoadoutName) {
    settings.lastLoadedLoadoutName = rollback.previousLastLoadedLoadoutName
  }
}

function reapplyLoadoutTouch(rollback: LoadoutTouchRollback, isTargetCurrent: (target: string) => boolean): void {
  if (isTargetCurrent(pendingMutationLoadoutRowProjectionTarget(rollback.loadoutId))) {
    const owner = currentLoadoutCollectionOwner()
    if (owner) {
      const list = cloneJsonValue(owner)
      let loadout = list.find((item) => item.id === rollback.loadoutId)
      if (!loadout && rollback.attemptedRow) {
        const index = Math.min(Math.max(rollback.previousIndex ?? list.length, 0), list.length)
        list.splice(index, 0, cloneJsonValue(rollback.attemptedRow))
        loadout = list[index]
      }
      if (loadout) {
        applyRetainedAttemptedFields({
          target: loadout as unknown as Record<string, unknown>,
          previous: rollback.previous as Record<string, unknown>,
          attempted: rollback.attempted as Record<string, unknown>,
          keys: Object.keys(rollback.attempted),
        })
      }
      replaceLoadoutCollectionOwner(list)
    }
  }
  const settings = currentSettingsOwner()
  if (
    settings &&
    isTargetCurrent(pendingMutationSettingsFieldProjectionTarget('lastLoadedLoadoutName')) &&
    (settings.lastLoadedLoadoutName === rollback.previousLastLoadedLoadoutName ||
      settings.lastLoadedLoadoutName === rollback.attemptedLastLoadedLoadoutName)
  ) {
    settings.lastLoadedLoadoutName = rollback.attemptedLastLoadedLoadoutName
  }
}

function insertModuleAtPreviousPosition(liveModules: string[], moduleId: string, previousModules: string[]): void {
  const previousIndex = previousModules.indexOf(moduleId)
  if (previousIndex === -1) {
    liveModules.push(moduleId)
    return
  }

  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const liveIndex = liveModules.indexOf(previousModules[index])
    if (liveIndex !== -1) {
      liveModules.splice(liveIndex + 1, 0, moduleId)
      return
    }
  }

  for (let index = previousIndex + 1; index < previousModules.length; index += 1) {
    const liveIndex = liveModules.indexOf(previousModules[index])
    if (liveIndex !== -1) {
      liveModules.splice(liveIndex, 0, moduleId)
      return
    }
  }

  liveModules.splice(Math.max(0, Math.min(previousIndex, liveModules.length)), 0, moduleId)
}

function rollbackModuleMembership(rollback: LoadoutModuleMembershipRollback): void {
  const settings = currentSettingsOwner()
  const liveModules = settings?.enabledModules
  if (!settings || !Array.isArray(liveModules) || !liveModules.every((moduleId) => typeof moduleId === 'string')) return
  const liveEnabled = liveModules.includes(rollback.moduleId)
  if (liveEnabled !== rollback.attemptedEnabled) return

  if (!rollback.previousEnabled) {
    settings.enabledModules = liveModules.filter((moduleId) => moduleId !== rollback.moduleId)
    invalidateModuleRenderRevision()
    return
  }

  if (!liveEnabled) {
    const restored = cloneJsonValue(liveModules)
    insertModuleAtPreviousPosition(restored, rollback.moduleId, rollback.previousModules)
    settings.enabledModules = restored
    invalidateModuleRenderRevision()
  }
}

function reapplyModuleMembership(
  rollback: LoadoutModuleMembershipRollback,
  isTargetCurrent: (target: string) => boolean,
): void {
  if (!isTargetCurrent(pendingMutationModuleEnabledProjectionTarget(rollback.moduleId))) return
  const settings = currentSettingsOwner()
  const liveModules = settings?.enabledModules
  if (!settings || !Array.isArray(liveModules) || !liveModules.every((moduleId) => typeof moduleId === 'string')) return
  if (snapshotJson(liveModules) === snapshotJson(rollback.attemptedModules)) return
  const liveEnabled = liveModules.includes(rollback.moduleId)
  if (liveEnabled !== rollback.previousEnabled && liveEnabled !== rollback.attemptedEnabled) return

  let projected = liveModules
  if (rollback.attemptedEnabled && !liveEnabled) {
    projected = [...liveModules, rollback.moduleId]
  } else if (!rollback.attemptedEnabled && liveEnabled) {
    projected = liveModules.filter((moduleId) => moduleId !== rollback.moduleId)
  }

  const projectedIds = new Set(projected)
  const attemptedIds = new Set(rollback.attemptedModules)
  settings.enabledModules =
    projectedIds.size === attemptedIds.size && Array.from(projectedIds).every((moduleId) => attemptedIds.has(moduleId))
      ? cloneJsonValue(rollback.attemptedModules)
      : projected
  invalidateModuleRenderRevision()
}

function rollbackGlobalChatVariables(rollback: LoadoutGlobalVariablesRollback): void {
  const settings = currentSettingsOwner()
  if (!settings) return
  applyAttemptedFieldRollback({
    target: settings,
    previous: { globalChatVariables: rollback.previous },
    attempted: { globalChatVariables: rollback.attempted },
    keys: ['globalChatVariables'],
  })
}

function reapplyGlobalChatVariables(
  rollback: LoadoutGlobalVariablesRollback,
  isTargetCurrent: (target: string) => boolean,
): void {
  if (!isTargetCurrent(pendingMutationSettingsFieldProjectionTarget('globalChatVariables'))) return
  const settings = currentSettingsOwner()
  if (!settings) return
  applyRetainedAttemptedFields({
    target: settings,
    previous: { globalChatVariables: rollback.previous },
    attempted: { globalChatVariables: rollback.attempted },
    keys: ['globalChatVariables'],
  })
}

function personaMirrorSnapshot(
  snapshot: PersonaStateSnapshot,
): Pick<PersonaStateSnapshot, 'selectedPersona' | 'username' | 'userIcon' | 'personaPrompt' | 'userNote'> {
  return {
    selectedPersona: snapshot.selectedPersona,
    username: snapshot.username,
    userIcon: snapshot.userIcon,
    personaPrompt: snapshot.personaPrompt,
    userNote: snapshot.userNote,
  }
}

function keyedPersonaRows(snapshot: PersonaStateSnapshot): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>()
  for (const persona of snapshot.personas ?? []) {
    const id = nonBlankId(persona?.id)
    if (id) {
      rows.set(id, persona as unknown as Record<string, unknown>)
    }
  }
  return rows
}

function personaSelectionRollback(
  previous: PersonaStateSnapshot,
  attempted: PersonaStateSnapshot,
): LoadoutPersonaSelectionRollback {
  const previousRows = keyedPersonaRows(previous)
  const rows: LoadoutPersonaRowRollback[] = []
  for (const [personaId, attemptedRow] of keyedPersonaRows(attempted)) {
    const previousRow = previousRows.get(personaId)
    if (!previousRow || snapshotJson(previousRow) === snapshotJson(attemptedRow)) continue
    rows.push({
      personaId,
      previous: cloneJsonValue(previousRow),
      attempted: cloneJsonValue(attemptedRow),
    })
  }

  return {
    rows,
    previousSelectedPersonaId: nonBlankId(previous.selectedPersonaId),
    attemptedSelectedPersonaId: nonBlankId(attempted.selectedPersonaId),
    previousMirror: personaMirrorSnapshot(previous),
    attemptedMirror: personaMirrorSnapshot(attempted),
  }
}

function reapplyPersonaSelection(
  rollback: LoadoutPersonaSelectionRollback,
  isTargetCurrent: (target: string) => boolean,
): void {
  const next = currentPersonaStateSnapshot()
  const currentSelectedId = nonBlankId(next.selectedPersonaId)
  let changed = false

  for (const row of rollback.rows) {
    if (!isTargetCurrent(pendingMutationPersonaRowProjectionTarget(row.personaId))) continue
    const persona = next.personas.find((item) => item?.id === row.personaId)
    if (!persona) continue
    const before = snapshotJson(persona)
    applyRetainedAttemptedFields({
      target: persona as unknown as Record<string, unknown>,
      previous: row.previous,
      attempted: row.attempted,
    })
    changed ||= snapshotJson(persona) !== before
  }
  if (
    rollback.attemptedSelectedPersonaId &&
    next.personas.some((persona) => persona?.id === rollback.attemptedSelectedPersonaId) &&
    isTargetCurrent(pendingMutationSelectionProjectionTarget('persona')) &&
    (currentSelectedId === rollback.previousSelectedPersonaId ||
      currentSelectedId === rollback.attemptedSelectedPersonaId) &&
    currentSelectedId !== rollback.attemptedSelectedPersonaId
  ) {
    next.selectedPersonaId = rollback.attemptedSelectedPersonaId
    changed = true
  }
  if (changed) {
    next.selectedPersona = next.personas.findIndex((persona) => persona?.id === next.selectedPersonaId)
    applyPersonaStateSnapshotLocally(next)
  }
}

function rollbackPersonaSelection(rollback: LoadoutPersonaSelectionRollback): void {
  const next = currentPersonaStateSnapshot()
  let changed = false
  for (const row of rollback.rows) {
    const persona = next.personas.find((item) => item?.id === row.personaId)
    if (!persona) continue
    const before = snapshotJson(persona)
    applyAttemptedFieldRollback({
      target: persona as unknown as Record<string, unknown>,
      previous: row.previous,
      attempted: row.attempted,
      deleteMissingPrevious: true,
    })
    changed ||= snapshotJson(persona) !== before
  }

  if (
    rollback.previousSelectedPersonaId &&
    next.selectedPersonaId === rollback.attemptedSelectedPersonaId &&
    next.personas.some((persona) => persona?.id === rollback.previousSelectedPersonaId)
  ) {
    next.selectedPersonaId = rollback.previousSelectedPersonaId
    changed = true
  }
  if (changed) {
    next.selectedPersona = next.personas.findIndex((persona) => persona?.id === next.selectedPersonaId)
    applyPersonaStateSnapshotLocally(next)
  }
}

function currentBotPresetSelectedId(): string | null {
  const index = settingsOwnerSelectionIndex('botPresetsId')
  const presets = uniquePresetCollectionOwner<botPreset>('botPresets')
  if (index === null || index < 0 || !presets) return null
  return nonBlankId(presets[index]?.id)
}

function restoreBotPresetSelectionToId(presetId: string | null): void {
  const list = uniquePresetCollectionOwner<botPreset>('botPresets')
  const settings = currentSettingsOwner()
  if (!list || !settings) return
  const index = presetId ? list.findIndex((preset) => preset?.id === presetId) : -1
  settings.botPresetsId = index >= 0 ? index : normalizedBotPresetsId(list.length, -1)
}

function splitPresetList(kind: SplitPresetKind): Array<ModelPreset | PromptPreset> {
  return kind === 'model'
    ? (uniquePresetCollectionOwner<ModelPreset>('modelPresets') ?? [])
    : (uniquePresetCollectionOwner<PromptPreset>('promptPresets') ?? [])
}

function currentSplitPresetSelectedId(kind: SplitPresetKind): string | null {
  const list = splitPresetList(kind)
  const index = settingsOwnerSelectionIndex(kind === 'model' ? 'modelPresetsId' : 'promptPresetsId')
  if (index === null || index < 0) return null
  return nonBlankId(list[index]?.id)
}

function setSplitPresetSelectedIndex(kind: SplitPresetKind, index: number): void {
  const settings = currentSettingsOwner()
  if (!settings) return
  if (kind === 'model') {
    settings.modelPresetsId = index
  } else {
    settings.promptPresetsId = index
  }
}

function restoreSplitPresetSelectionToId(kind: SplitPresetKind, presetId: string | null): void {
  const list = splitPresetList(kind)
  const index = presetId ? list.findIndex((preset) => preset?.id === presetId) : -1
  setSplitPresetSelectedIndex(kind, index >= 0 ? index : normalizedBotPresetsId(list.length, -1))
}

function presetFieldRollbackFromPatch(
  presetId: string,
  previousPreset: Record<string, unknown>,
  attemptedPreset: Record<string, unknown>,
): PresetFieldRollback {
  const previous: Record<string, unknown> = {}
  const attempted = cloneJsonValue(attemptedPreset)
  const keys = new Set([...Object.keys(previousPreset), ...Object.keys(attempted)])

  for (const key of keys) {
    if (Object.hasOwn(previousPreset, key)) {
      previous[key] = cloneJsonValue(previousPreset[key])
    }
    if (!Object.hasOwn(attempted, key)) {
      attempted[key] = undefined
    }
  }

  return {
    presetId,
    previous,
    attempted,
  }
}

function rollbackPresetFields(rollback: PresetFieldRollback | null): void {
  if (!rollback) return
  const owner = uniquePresetCollectionOwner<botPreset>('botPresets')
  if (!owner) return
  const presets = cloneJsonValue(owner)
  const preset = presets.find((item) => item?.id === rollback.presetId)
  if (!preset) return
  applyAttemptedFieldRollback({
    target: preset as unknown as Record<string, unknown>,
    previous: rollback.previous,
    attempted: rollback.attempted,
    deleteMissingPrevious: true,
  })
  replacePresetCollectionOwner('botPresets', presets)
}

function reapplyPresetFields(rollback: PresetFieldRollback | null, isTargetCurrent: (target: string) => boolean): void {
  if (!rollback) return
  if (!isTargetCurrent(pendingMutationPresetRowProjectionTarget('legacy', rollback.presetId))) return
  const owner = uniquePresetCollectionOwner<botPreset>('botPresets')
  if (!owner) return
  const presets = cloneJsonValue(owner)
  const preset = presets.find((item) => item?.id === rollback.presetId)
  if (!preset) return
  applyRetainedAttemptedFields({
    target: preset as unknown as Record<string, unknown>,
    previous: rollback.previous,
    attempted: rollback.attempted,
  })
  replacePresetCollectionOwner('botPresets', presets)
}

function rollbackPresetSettings(rollback: PresetSettingsRollback): void {
  const settings = currentSettingsOwner()
  if (!settings) return
  applyAttemptedFieldRollback({
    target: settings,
    previous: rollback.previous as Record<string, unknown>,
    attempted: rollback.attempted as Record<string, unknown>,
    keys: SET_PRESET_ROLLBACK_KEYS,
  })
}

function rollbackLegacyPresetSelection(rollback: LegacyPresetSelectionRollback): void {
  rollbackPresetFields(rollback.saveCurrentRollback)
  if (!rollback.attemptedSelectedId || currentBotPresetSelectedId() !== rollback.attemptedSelectedId) return
  rollbackPresetSettings(rollback)
  restoreBotPresetSelectionToId(rollback.previousSelectedId)
}

function reapplyLegacyPresetSelection(
  rollback: LegacyPresetSelectionRollback,
  isTargetCurrent: (target: string) => boolean,
): void {
  const currentSelectedId = currentBotPresetSelectedId()
  if (currentSelectedId !== rollback.previousSelectedId && currentSelectedId !== rollback.attemptedSelectedId) return
  const presets = uniquePresetCollectionOwner<botPreset>('botPresets')
  const settings = currentSettingsOwner()
  if (!presets || !settings) return
  const attemptedIndex = rollback.attemptedSelectedId
    ? presets.findIndex((preset) => preset?.id === rollback.attemptedSelectedId)
    : -1
  if (attemptedIndex < 0) return

  reapplyPresetFields(rollback.saveCurrentRollback, isTargetCurrent)
  const currentKeys = rollback.changedKeys.filter((key) =>
    isTargetCurrent(pendingMutationSettingsFieldProjectionTarget(key)),
  )
  applyRetainedAttemptedFields({
    target: settings,
    previous: (rollback.retainedPrevious ?? rollback.previous) as Record<string, unknown>,
    attempted: rollback.attempted as Record<string, unknown>,
    keys: currentKeys,
  })
  if (
    isTargetCurrent(pendingMutationSelectionProjectionTarget('legacyPreset')) &&
    settings.botPresetsId !== attemptedIndex
  ) {
    settings.botPresetsId = attemptedIndex
  }
}

function rollbackSplitPresetSelection(rollback: SplitPresetSelectionRollback): void {
  if (!rollback.attemptedSelectedId || currentSplitPresetSelectedId(rollback.kind) !== rollback.attemptedSelectedId) {
    return
  }
  rollbackPresetSettings(rollback)
  restoreSplitPresetSelectionToId(rollback.kind, rollback.previousSelectedId)
}

function reapplySplitPresetSelection(
  rollback: SplitPresetSelectionRollback,
  isTargetCurrent: (target: string) => boolean,
): void {
  const currentSelectedId = currentSplitPresetSelectedId(rollback.kind)
  if (currentSelectedId !== rollback.previousSelectedId && currentSelectedId !== rollback.attemptedSelectedId) return
  const settings = currentSettingsOwner()
  if (!settings) return
  const attemptedIndex = rollback.attemptedSelectedId
    ? splitPresetList(rollback.kind).findIndex((preset) => preset?.id === rollback.attemptedSelectedId)
    : -1
  if (attemptedIndex < 0) return

  const currentKeys = rollback.changedKeys.filter((key) =>
    isTargetCurrent(pendingMutationSettingsFieldProjectionTarget(key)),
  )
  applyRetainedAttemptedFields({
    target: settings,
    previous: (rollback.retainedPrevious ?? rollback.previous) as Record<string, unknown>,
    attempted: rollback.attempted as Record<string, unknown>,
    keys: currentKeys,
  })
  if (
    isTargetCurrent(
      pendingMutationSelectionProjectionTarget(rollback.kind === 'model' ? 'modelPreset' : 'promptPreset'),
    ) &&
    currentSelectedId !== rollback.attemptedSelectedId
  ) {
    setSplitPresetSelectedIndex(rollback.kind, attemptedIndex)
  }
}

function rollbackAgentPresetSelection(rollback: AgentPresetSelectionRollback): void {
  const chat = findChatById(rollback.chatId, rollback.characterId)
  if (!chat) return
  const current = chat.generationSettings
  if (snapshotJson(current) !== snapshotJson(rollback.attemptedGenerationSettings)) return
  if (rollback.hadGenerationSettings) {
    chat.generationSettings = cloneJsonValue(rollback.previousGenerationSettings)
  } else {
    delete chat.generationSettings
  }
}

function reapplyAgentPresetSelection(
  rollback: AgentPresetSelectionRollback,
  isTargetCurrent: (target: string) => boolean,
): void {
  if (!isTargetCurrent(pendingMutationChatGenerationSettingsProjectionTarget(rollback.chatId))) return
  const chat = findChatById(rollback.chatId, rollback.characterId)
  if (!chat) return
  const current = chat.generationSettings
  const previous = rollback.hadGenerationSettings ? rollback.previousGenerationSettings : undefined
  if (snapshotJson(current) === snapshotJson(rollback.attemptedGenerationSettings)) return
  if (
    snapshotJson(current) !== snapshotJson(previous) &&
    snapshotJson(current) !== snapshotJson(rollback.attemptedGenerationSettings)
  ) {
    return
  }
  chat.generationSettings = cloneJsonValue(rollback.attemptedGenerationSettings)
}

function prepareLoadoutDurableStep(key: string, intent: DurableMutationIntent): PreparedLoadoutDurableStep | null {
  if (!canUseServerCommands()) return null
  const handle = stagePendingMutation(key, intent)
  return {
    handle,
    intent,
    wrapperStarted: false,
    wrapperFailed: false,
    initialPersistence: null,
    settlement: null,
    projectionTargets: new Set(pendingMutationProjectionTargets(intent)),
  }
}

function preparedLoadoutExecutionWrapper(prepared: PreparedLoadoutDurableStep): ServerCommandExecutionWrapper {
  return async <T extends Record<string, unknown>>(
    execute: () => Promise<ServerCommandResult<T>>,
  ): Promise<ServerCommandResult<T>> => {
    prepared.wrapperStarted = true
    try {
      const outcome = await executePreparedDurableMutationWithinQueue<T>(
        { handle: prepared.handle, intent: prepared.intent },
        execute,
      )
      prepared.handle = outcome.handle
      prepared.intent = outcome.intent
      for (const target of pendingMutationProjectionTargets(outcome.intent)) {
        prepared.projectionTargets.add(target)
      }
      recordPendingMutationProjectionTargets(prepared.handle, Array.from(prepared.projectionTargets))
      prepared.settlement = outcome.settlement
      return outcome.disposition === 'sent' ? outcome.result : { status: 'unavailable' }
    } catch (error) {
      // Once the exact row reached IndexedDB, an outbox/lock failure cannot
      // prove that it disappeared. Keep its projection for eventual replay.
      prepared.settlement = prepared.initialPersistence === 'persisted' ? 'retained' : 'unavailable'
      prepared.wrapperFailed = true
      throw error
    }
  }
}

function createLoadoutApplyStep(
  command: ServerCommandFactory,
  rollback: () => void,
  durability: PreparedLoadoutDurableStep | null = null,
  reapply?: (isTargetCurrent: (target: string) => boolean) => void,
  presetProjection?: PresetSettingsRollback,
): LoadoutApplyStep {
  const step: LoadoutApplyStep = {
    succeeded: false,
    command: async (baseRevision) => {
      const result = await command(baseRevision)
      if (result.status === 'ok') {
        step.succeeded = true
      }
      return result
    },
    rollback,
    reapply,
    presetProjection,
    ...(durability
      ? {
          executionWrapper: preparedLoadoutExecutionWrapper(durability),
          durability,
        }
      : {}),
  }
  return step
}

async function awaitPreparedLoadoutDurability(steps: readonly LoadoutApplyStep[]): Promise<void> {
  await Promise.all(
    steps.map(async (step) => {
      const durability = step.durability
      if (!durability || durability.initialPersistence !== null) return
      durability.initialPersistence = await durability.handle.ready
    }),
  )
}

function retainsDurableLoadoutProjection(durability: PreparedLoadoutDurableStep): boolean {
  if (durability.initialPersistence !== 'persisted') return false
  return (
    durability.settlement === null || durability.settlement === 'retained' || durability.settlement === 'unavailable'
  )
}

function failedLoadoutApplyStep(steps: readonly LoadoutApplyStep[]): LoadoutApplyStep | undefined {
  return steps.find(
    (step) =>
      step.durability?.wrapperFailed === true ||
      (!step.succeeded && (step.durability === undefined || step.durability.wrapperStarted)),
  )
}

function rebaseRetainedPresetProjection(
  retained: PresetSettingsRollback,
  discardedPredecessors: readonly PresetSettingsRollback[],
): void {
  const rebased = cloneJsonValue(retained.previous)
  for (const discarded of discardedPredecessors) {
    for (const key of SET_PRESET_ROLLBACK_KEYS) {
      if (snapshotJson(rebased[key]) !== snapshotJson(discarded.attempted[key])) continue
      if (Object.hasOwn(discarded.previous, key)) rebased[key] = cloneJsonValue(discarded.previous[key])
      else delete rebased[key]
    }
  }
  retained.retainedPrevious = rebased
}

async function settleFailedLoadoutApplySteps(
  steps: readonly LoadoutApplyStep[],
  rollbackIsCurrent: () => boolean,
): Promise<void> {
  const failedStep = failedLoadoutApplyStep(steps)
  const retainPersistedTail =
    failedStep?.durability !== undefined && retainsDurableLoadoutProjection(failedStep.durability)

  if (!retainPersistedTail) {
    const skippedDurableSteps = steps.filter(
      (step): step is LoadoutApplyStep & { durability: PreparedLoadoutDurableStep } =>
        !step.succeeded && step.durability !== undefined && !step.durability.wrapperStarted,
    )
    const discardResults = await Promise.all(
      skippedDurableSteps.map(async (step) => ({
        durability: step.durability,
        result: await discardPendingMutation(step.durability.handle),
      })),
    )
    for (const { durability, result } of discardResults) {
      durability.settlement =
        result === 'deleted' ? 'discarded' : result === 'superseded' ? 'superseded' : 'unavailable'
    }
  }

  // IndexedDB cleanup above can yield long enough for a destructive resource
  // refresh to replace the projection. Never apply this older reverse patch
  // after that authoritative refresh wins.
  if (!rollbackIsCurrent()) return

  // Preset projections overlap. Roll them back only after every skipped row's
  // deletion is known, and always in reverse projection order.
  const rolledBackPresetSteps: Array<{ index: number; projection: PresetSettingsRollback }> = []
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step.succeeded) continue
    if (step.durability && retainsDurableLoadoutProjection(step.durability)) continue
    step.rollback()
    if (step.presetProjection) rolledBackPresetSteps.push({ index, projection: step.presetProjection })
  }

  if (rolledBackPresetSteps.length > 0) {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      if (!step?.presetProjection || !step.durability || !retainsDurableLoadoutProjection(step.durability)) continue
      const discardedPredecessors = rolledBackPresetSteps
        .filter((candidate) => candidate.index < index)
        .sort((left, right) => right.index - left.index)
        .map((candidate) => candidate.projection)
      if (discardedPredecessors.length > 0) {
        rebaseRetainedPresetProjection(step.presetProjection, discardedPredecessors)
      }
    }
  }
}

function reapplyRetainedLoadoutApplySteps(steps: readonly LoadoutApplyStep[]): void {
  const expectedFences = new Map<string, PendingMutationProjectionFence>()
  for (const step of steps) {
    const durability = step.durability
    if (!durability) continue
    for (const target of durability.projectionTargets) {
      const fence = pendingMutationProjectionFence(durability.handle, target)
      if (!fence) continue
      const previous = expectedFences.get(target)
      if (!previous || previous.ordinal < fence.ordinal) expectedFences.set(target, fence)
    }
  }
  const isTargetCurrent = (target: string): boolean => {
    const fence = expectedFences.get(target)
    return fence ? isPendingMutationProjectionFenceCurrent(fence) : false
  }

  for (const step of steps) {
    if (step.succeeded && step.durability?.wrapperFailed !== true) continue
    if (!step.durability || !retainsDurableLoadoutProjection(step.durability)) continue
    step.reapply?.(isTargetCurrent)
  }
}

function toLoadoutSnapshot(loadout: Loadout): LoadoutSnapshot {
  return cloneJsonValue(loadout) as LoadoutSnapshot
}

function readablePresetName(preset: { name?: unknown } | undefined): string {
  return typeof preset?.name === 'string' ? preset.name : ''
}

function dispatchCreateLoadout(loadout: Loadout): Promise<Exclude<LoadoutMutationStatus, 'not-found'>> {
  if (!canUseClientWriteAccess()) return Promise.resolve('failed')
  if (!canUseServerCommands()) return Promise.resolve('accepted')
  const attemptedLoadout = cloneJsonValue(loadout)
  const attemptedIndex = Math.max(
    0,
    currentLoadoutCollectionOwner()?.findIndex((candidate) => candidate.id === attemptedLoadout.id) ?? -1,
  )
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [{ method: 'POST', path: '/loadouts', body: { loadout: toLoadoutSnapshot(attemptedLoadout) } }],
  }
  const handle = stagePendingMutation(loadoutOwnerMutationKey(loadout.id), intent)
  const ownerRevision = collectionsResourceState.revision
  return settleLoadoutMutation(
    handle,
    loadout.id,
    dispatchDurableMutation(handle, intent, (transport) =>
      runServerCommand({
        command: (baseRevision) =>
          createLoadoutCommand(
            {
              baseRevision,
              loadout: toLoadoutSnapshot(attemptedLoadout),
            },
            transport.signal,
          ),
        rollback: () => {
          if (collectionsResourceState.revision === ownerRevision) rollbackCreatedLoadout(attemptedLoadout)
        },
        ...transport,
      }),
    ),
    () => reapplyRetainedCreatedLoadout(attemptedLoadout, attemptedIndex),
  )
}

function dispatchDeleteLoadout(
  loadoutId: string,
  previousLoadout: Loadout,
  previousIndex: number,
  ownerRevision: number | null,
): Promise<Exclude<LoadoutMutationStatus, 'not-found'>> {
  if (!canUseClientWriteAccess()) return Promise.resolve('failed')
  if (!canUseServerCommands()) return Promise.resolve('accepted')
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [{ method: 'DELETE', path: `/loadouts/${encodeURIComponent(loadoutId)}`, body: {} }],
  }
  const handle = stagePendingMutation(loadoutOwnerMutationKey(loadoutId), intent)
  return settleLoadoutMutation(
    handle,
    loadoutId,
    dispatchDurableMutation(handle, intent, (transport) =>
      runServerCommand({
        command: (baseRevision) =>
          deleteLoadoutCommand(
            {
              baseRevision,
              loadoutId,
            },
            transport.signal,
          ),
        rollback: () => {
          if (collectionsResourceState.revision === ownerRevision)
            rollbackDeletedLoadout(previousLoadout, previousIndex)
        },
        ...transport,
      }),
    ),
    () => reapplyRetainedDeletedLoadout(loadoutId),
  )
}

function dispatchFavoriteLoadout(
  rollback: LoadoutFavoriteRollback,
): Promise<Exclude<LoadoutMutationStatus, 'not-found'>> {
  if (!canUseClientWriteAccess()) return Promise.resolve('failed')
  if (!canUseServerCommands()) return Promise.resolve('accepted')
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'POST',
        path: `/loadouts/${encodeURIComponent(rollback.loadoutId)}/favorite`,
        body: { favorite: rollback.attemptedFavorite },
      },
    ],
  }
  const handle = stagePendingMutation(loadoutOwnerMutationKey(rollback.loadoutId), intent)
  return settleLoadoutMutation(
    handle,
    rollback.loadoutId,
    dispatchDurableMutation(handle, intent, (transport) =>
      runServerCommand({
        command: (baseRevision) =>
          favoriteLoadoutCommand(
            {
              baseRevision,
              loadoutId: rollback.loadoutId,
              favorite: rollback.attemptedFavorite,
            },
            transport.signal,
          ),
        rollback: () => rollbackLoadoutFavorite(rollback),
        ...transport,
      }),
    ),
    () => reapplyRetainedFavoriteLoadout(rollback),
  )
}

async function settleLoadoutMutation(
  handle: PendingMutationHandle,
  loadoutId: string,
  request: Promise<ServerCommandResult>,
  reapplyRetainedProjection: () => void,
): Promise<Exclude<LoadoutMutationStatus, 'not-found'>> {
  try {
    const result = await request
    if (result.status === 'ok') return 'accepted'

    const persistence = await handle.ready
    if (persistence === 'persisted' && isPendingLoadoutProjectionCurrent(handle, loadoutId)) {
      reapplyRetainedProjection()
      return 'queued'
    }
    return persistence === 'superseded' ? 'superseded' : 'failed'
  } catch {
    const persistence = await handle.ready
    if (persistence === 'persisted' && isPendingLoadoutProjectionCurrent(handle, loadoutId)) {
      reapplyRetainedProjection()
      return 'queued'
    }
    return persistence === 'superseded' ? 'superseded' : 'failed'
  }
}

export function toggleLoadoutFavorite(loadoutId: string): Promise<LoadoutMutationStatus> {
  if (!canUseClientWriteAccess()) return Promise.resolve('failed')
  const owner = currentLoadoutCollectionOwner()
  if (!owner) return Promise.resolve('failed')
  const previousIndex = owner.findIndex((item) => item.id === loadoutId)
  const loadout = previousIndex === -1 ? undefined : owner[previousIndex]
  if (!loadout) return Promise.resolve('not-found')

  const previousFavorite = loadout.favorite
  const favorite = !loadout.favorite
  const attempted = cloneJsonValue(owner)
  attempted[previousIndex].favorite = favorite
  if (!replaceLoadoutCollectionOwner(attempted)) return Promise.resolve('failed')
  return dispatchFavoriteLoadout({
    loadoutId,
    ownerRevision: collectionsResourceState.revision,
    previousFavorite,
    attemptedFavorite: favorite,
    attemptedRow: cloneJsonValue(attempted[previousIndex]),
    previousIndex,
  })
}

export function deleteLoadout(loadoutId: string): Promise<LoadoutMutationStatus> {
  if (!canUseClientWriteAccess()) return Promise.resolve('failed')
  const owner = currentLoadoutCollectionOwner()
  if (!owner) return Promise.resolve('failed')
  const index = owner.findIndex((loadout) => loadout.id === loadoutId)
  if (index === -1) return Promise.resolve('not-found')

  const previousLoadout = cloneJsonValue(owner[index])
  const attempted = cloneJsonValue(owner)
  attempted.splice(index, 1)
  if (!replaceLoadoutCollectionOwner(attempted)) return Promise.resolve('failed')
  return dispatchDeleteLoadout(loadoutId, previousLoadout, index, collectionsResourceState.revision)
}

function nonBlankId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function findChatById(
  chatId: string,
  preferredCharacterId?: string,
): { id?: string; generationSettings?: ChatGenerationSettings } | null {
  if (!nonBlankId(chatId) || !ownerStatusUsable(charactersResourceState.status)) return null
  const characters = preferredCharacterId
    ? [getCharacterResourceOwner(preferredCharacterId)].filter((character) => character !== undefined)
    : charactersResourceState.characters
  const matches = characters.flatMap((character) =>
    (character?.chats ?? []).filter((candidate) => candidate?.id === chatId),
  )
  return matches.length === 1
    ? (matches[0] as unknown as { id?: string; generationSettings?: ChatGenerationSettings })
    : null
}

function currentActiveChatRecord(): {
  characterId: string | undefined
  chatId: string
  chat: { id?: string; generationSettings?: ChatGenerationSettings }
} | null {
  const character = currentCharacterOwner()
  const chatIndex = Number.isInteger(character?.chatPage) ? (character.chatPage as number) : -1
  const chat = chatIndex >= 0 && Array.isArray(character?.chats) ? character.chats[chatIndex] : undefined
  const chatId = nonBlankId(chat?.id)
  if (!chat || !chatId) return null
  return {
    characterId: typeof character?.chaId === 'string' ? character.chaId : undefined,
    chatId,
    chat: chat as unknown as { id?: string; generationSettings?: ChatGenerationSettings },
  }
}

function uniqueAgentPresetSettingsOwner(
  settings: Record<string, unknown> | null,
): Array<{ id: string; name?: string }> | null {
  const agentPresets = settings?.agentPresets
  if (!Array.isArray(agentPresets)) return null
  const ids = new Set<string>()
  const result: Array<{ id: string; name?: string }> = []
  for (const candidate of agentPresets) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const preset = candidate as { id?: unknown; name?: unknown }
    const id = nonBlankId(preset.id)
    if (!id || ids.has(id) || (preset.name !== undefined && typeof preset.name !== 'string')) return null
    ids.add(id)
    result.push({ id, ...(typeof preset.name === 'string' ? { name: preset.name } : {}) })
  }
  return result
}

function currentChatAgentPreset(): { id?: string; name?: string } | undefined {
  const settings = currentSettingsOwnerSnapshot()
  if (!settings) return undefined
  const agentPresetId = resolveEffectiveAgentPresetId(
    settings as unknown as Database,
    currentActiveChatRecord()?.chat.generationSettings,
  )
  if (!agentPresetId) return undefined
  const presets = uniqueAgentPresetSettingsOwner(settings)
  if (!presets) return undefined
  const matches = presets.filter((preset) => preset.id === agentPresetId)
  return matches.length === 1 ? matches[0] : undefined
}

function loadoutHasAgentPresetReference(loadout: Loadout): boolean {
  return Object.hasOwn(loadout, 'agentPresetId') || Object.hasOwn(loadout, 'agentPresetName')
}

function resolveLoadoutAgentPresetId(loadout: Loadout): { value: string | undefined } | null {
  if (!loadoutHasAgentPresetReference(loadout)) return { value: undefined }
  const settings = currentSettingsOwner()
  const stablePresets = uniqueAgentPresetSettingsOwner(settings)
  if (!stablePresets) return null

  const requestedId = nonBlankId(loadout.agentPresetId)
  if (requestedId) {
    return stablePresets.some((preset) => preset.id === requestedId) ? { value: requestedId } : null
  }

  const requestedName =
    typeof loadout.agentPresetName === 'string' && loadout.agentPresetName.trim().length > 0
      ? loadout.agentPresetName
      : null
  if (requestedName) {
    const matches = stablePresets.filter((candidate) => candidate.name === requestedName)
    const presetId = matches.length === 1 ? nonBlankId(matches[0]?.id) : null
    return presetId ? { value: presetId } : null
  }

  return { value: '' }
}

function createGenerationSettingsWithPresetSelections(
  current: ChatGenerationSettings | undefined,
  agentPresetId: string | undefined,
  togglePresetId: string | undefined,
): ChatGenerationSettings | null {
  if (
    !current &&
    (agentPresetId === '' || agentPresetId === undefined) &&
    (togglePresetId === '' || togglePresetId === undefined)
  ) {
    return null
  }
  const next = cloneJsonValue(current ?? {})
  if (agentPresetId !== undefined) next.agentPresetId = agentPresetId
  if (togglePresetId !== undefined) next.togglePresetId = togglePresetId
  if (!Object.hasOwn(next, 'jailbreakToggle')) {
    next.jailbreakToggle = false
  }
  return next
}

function resolvePersonaSelection(personaId: string): { index: number; personaId: string } | null {
  const owner = currentPersonaStateSnapshot()
  const personas = owner.personas
  const seen = new Set<string>()
  for (const persona of personas) {
    const id = nonBlankId(persona?.id)
    if (!id || seen.has(id)) return null
    seen.add(id)
  }

  const requestedId = nonBlankId(personaId)
  if (!requestedId) return null
  const index = personas.findIndex((persona) => persona.id === requestedId)
  return index >= 0 ? { index, personaId: requestedId } : null
}

function resolveSplitPresetSelection<T extends { id?: string; name?: string }>(
  presets: T[] | undefined,
  presetId: string | undefined,
  presetName: string | undefined,
): { index: number; presetId: string } | null {
  if (!Array.isArray(presets)) return null

  const requestedId = nonBlankId(presetId)
  if (requestedId) {
    const matches = presets
      .map((preset, index) => ({ preset, index }))
      .filter(({ preset }) => preset?.id === requestedId)
    if (matches.length === 1) return { index: matches[0].index, presetId: requestedId }
    if (matches.length > 1) return null
  }

  const requestedName = typeof presetName === 'string' && presetName.trim().length > 0 ? presetName : null
  if (!requestedName) return null

  const matches = presets
    .map((preset, index) => ({ preset, index }))
    .filter(({ preset }) => preset?.name === requestedName)
  const resolvedId = matches.length === 1 ? nonBlankId(matches[0].preset?.id) : null
  return matches.length === 1 && resolvedId ? { index: matches[0].index, presetId: resolvedId } : null
}

function loadoutHasSplitPresetReference(loadout: Loadout): boolean {
  return (
    !!nonBlankId(loadout.modelPresetId) ||
    !!nonBlankId(loadout.promptPresetId) ||
    (typeof loadout.modelPresetName === 'string' && loadout.modelPresetName.trim().length > 0) ||
    (typeof loadout.promptPresetName === 'string' && loadout.promptPresetName.trim().length > 0)
  )
}

function normalizedBotPresetsId(presetCount: number, selected: unknown): number {
  if (!Number.isInteger(selected)) return presetCount > 0 ? 0 : -1

  const index = selected as number
  if (index >= presetCount) return presetCount > 0 ? presetCount - 1 : -1
  if (index < -1) return presetCount > 0 ? 0 : -1
  return index
}

function saveCurrentPresetSnapshotLocal(): PresetFieldRollback | null {
  const settings = currentSettingsOwnerSnapshot()
  const owner = uniquePresetCollectionOwner<botPreset>('botPresets')
  const index = settingsOwnerSelectionIndex('botPresetsId')
  if (!settings || !owner || index === null || index < 0 || index >= owner.length) return null
  const presets = cloneJsonValue(owner)

  const current = presets[index]
  const previousPreset = cloneJsonValue(current) as unknown as Record<string, unknown>
  const snapshot: Record<string, unknown> = {
    id: current.id,
    name: typeof current.name === 'string' ? current.name : 'New Preset',
  }
  const dbRecord = settings
  for (const [presetKey, databaseKey] of PRESET_SNAPSHOT_KEY_PAIRS) {
    if (presetKey === 'name') continue
    if (Object.prototype.hasOwnProperty.call(dbRecord, databaseKey)) {
      snapshot[presetKey] = cloneJsonValue(dbRecord[databaseKey])
    }
  }
  snapshot.image = current.image ?? ''
  snapshot.seperateModelsForAxModels = settings.doNotChangeSeperateModels
    ? false
    : (settings.seperateModelsForAxModels ?? false)
  snapshot.seperateModels = settings.doNotChangeSeperateModels ? null : cloneJsonValue(settings.seperateModels)
  snapshot.fallbackWhenBlankResponse = settings.fallbackWhenBlankResponse ?? false
  presets[index] = snapshot as unknown as botPreset
  const presetId = nonBlankId(snapshot.id)
  if (!presetId || !replacePresetCollectionOwner('botPresets', presets)) return null
  return presetId ? presetFieldRollbackFromPatch(presetId, previousPreset, snapshot) : null
}

function presetHasHydratedSettings(preset: botPreset | undefined): preset is botPreset {
  return botPresetHasHydratedSettings(preset)
}

function changedModulePlans(previousModules: string[], nextModules: string[]): LoadoutModulePlan[] {
  const previousSet = new Set(previousModules)
  const nextSet = new Set(nextModules)
  const enabled = Array.from(nextSet)
    .filter((moduleId) => !previousSet.has(moduleId))
    .sort()
  const disabled = Array.from(previousSet)
    .filter((moduleId) => !nextSet.has(moduleId))
    .sort()

  return [
    ...enabled.map((moduleId) => ({ moduleId, enabled: true })),
    ...disabled.map((moduleId) => ({ moduleId, enabled: false })),
  ].map(({ moduleId, enabled }) => ({
    moduleId,
    enabled,
    durability: prepareLoadoutDurableStep(moduleOwnerMutationKey(moduleId), {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/modules/enable',
          body: { moduleId, enabled },
        },
      ],
    }),
  }))
}

function changedModuleSteps(
  previousModules: string[],
  attemptedModules: string[],
  plans: readonly LoadoutModulePlan[],
): LoadoutApplyStep[] {
  const previousSet = new Set(previousModules)
  return plans.map(({ moduleId, enabled, durability }) => {
    const rollback: LoadoutModuleMembershipRollback = {
      moduleId,
      previousEnabled: previousSet.has(moduleId),
      attemptedEnabled: enabled,
      previousModules,
      attemptedModules,
    }
    return createLoadoutApplyStep(
      (baseRevision) =>
        enableModuleCommand({
          baseRevision,
          moduleId,
          enabled,
        }),
      () => rollbackModuleMembership(rollback),
      durability,
      (isTargetCurrent) => reapplyModuleMembership(rollback, isTargetCurrent),
    )
  })
}

let loadoutApplyIntent = 0
let loadoutApplyTail: Promise<void> | null = null

function runSerializedLoadoutApply<T>(task: () => Promise<T>): Promise<T> {
  const predecessor = loadoutApplyTail
  let release!: () => void
  const reservation = new Promise<void>((resolve) => {
    release = resolve
  })
  loadoutApplyTail = reservation

  const run = (): Promise<T> => {
    let result: Promise<T>
    try {
      // Start an uncontended apply in this task so its optimistic projection
      // remains synchronous for callers. Only followers wait for the previous
      // apply's complete projection/command/rollback lifecycle.
      result = task()
    } catch (error) {
      result = Promise.reject(error)
    }

    const finish = () => {
      release()
      if (loadoutApplyTail === reservation) loadoutApplyTail = null
    }
    return result.then(
      (value) => {
        finish()
        return value
      },
      (error) => {
        finish()
        throw error
      },
    )
  }

  return predecessor ? predecessor.then(run, run) : run()
}

export async function applyLoadout(
  loadout: Loadout,
  apply: LoadoutApplyOption[] = ['modules', 'globalVariables', 'preset', 'persona'],
): Promise<LoadoutApplyStatus> {
  if (!canUseClientWriteAccess()) return 'persistence-failed'
  const sessionGeneration = captureClientSessionGeneration()
  const intent = ++loadoutApplyIntent
  const requested = new Set(apply)
  const activeChatAgentPresetTarget = requested.has('preset') ? currentActiveChatRecord() : null
  const currentCharacterId = currentCharacterOwner()?.chaId
  const legacySelectionIntent = requested.has('preset') ? beginLegacyPresetSelectionIntent() : null
  const useSplitPresetSelection = requested.has('preset') && loadoutHasSplitPresetReference(loadout)
  const legacyPresets =
    requested.has('preset') && !useSplitPresetSelection ? uniquePresetCollectionOwner<botPreset>('botPresets') : null
  if (requested.has('preset') && !useSplitPresetSelection && !legacyPresets) return 'preset-hydration-failed'
  const legacyMatches = legacyPresets?.filter((preset) => preset.name === loadout.presetName) ?? []
  if (legacyMatches.length > 1) return 'preset-hydration-failed'
  const legacyPreset = legacyMatches[0]
  const legacyPresetId = nonBlankId(legacyPreset?.id)
  if (legacyPreset && !legacyPresetId) return 'preset-hydration-failed'
  if (legacyPresetId && !presetHasHydratedSettings(legacyPreset)) {
    const hydrated = await ensureBotPresetHydratedById(legacyPresetId)
    if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(sessionGeneration)) return 'superseded'
    if (!hydrated) return 'preset-hydration-failed'
    if (
      intent !== loadoutApplyIntent ||
      legacySelectionIntent === null ||
      !isLegacyPresetSelectionIntentCurrent(legacySelectionIntent)
    ) {
      return 'superseded'
    }
    const status = await applyLoadoutNow(
      loadout,
      apply,
      legacyPresetId,
      intent,
      legacySelectionIntent,
      activeChatAgentPresetTarget,
      currentCharacterId,
    )
    return status
  }
  const status = await applyLoadoutNow(
    loadout,
    apply,
    legacyPresetId,
    intent,
    legacySelectionIntent,
    activeChatAgentPresetTarget,
    currentCharacterId,
  )
  return status
}

async function applyLoadoutNow(
  loadout: Loadout,
  apply: LoadoutApplyOption[],
  legacyPresetId: string | null,
  intent: number,
  legacySelectionIntent: number | null,
  activeChatAgentPresetTarget: ReturnType<typeof currentActiveChatRecord>,
  currentCharacterId: string | undefined,
): Promise<LoadoutApplyStatus> {
  const sessionGeneration = captureClientSessionGeneration()
  return runSerializedLoadoutApply(() =>
    !canUseClientWriteAccess() || !isClientSessionGenerationCurrent(sessionGeneration)
      ? Promise.resolve('superseded')
      : applyLoadoutNowExclusive(
          loadout,
          apply,
          legacyPresetId,
          intent,
          legacySelectionIntent,
          activeChatAgentPresetTarget,
          currentCharacterId,
        ),
  )
}

async function applyLoadoutNowExclusive(
  loadout: Loadout,
  apply: LoadoutApplyOption[],
  legacyPresetId: string | null,
  intent: number,
  legacySelectionIntent: number | null,
  activeChatAgentPresetTarget: ReturnType<typeof currentActiveChatRecord>,
  currentCharacterId: string | undefined,
): Promise<LoadoutApplyStatus> {
  if (!canUseClientWriteAccess()) return 'persistence-failed'
  if (intent !== loadoutApplyIntent) return 'superseded'
  if (legacySelectionIntent !== null && !isLegacyPresetSelectionIntentCurrent(legacySelectionIntent))
    return 'superseded'
  const requested = new Set(apply)
  const settingsSnapshot = currentSettingsOwnerSnapshot()
  const loadoutOwner = currentLoadoutCollectionOwner()
  if (!settingsSnapshot || !loadoutOwner) return 'persistence-failed'
  const personaSelection = requested.has('persona') ? resolvePersonaSelection(loadout.personaId) : null
  if (requested.has('persona') && nonBlankId(loadout.personaId) && !personaSelection) return 'persistence-failed'
  const useSplitPresetSelection = requested.has('preset') && loadoutHasSplitPresetReference(loadout)
  const legacyPresets =
    requested.has('preset') && !useSplitPresetSelection ? uniquePresetCollectionOwner<botPreset>('botPresets') : []
  const modelPresets = useSplitPresetSelection ? uniquePresetCollectionOwner<ModelPreset>('modelPresets') : []
  const promptPresets = useSplitPresetSelection ? uniquePresetCollectionOwner<PromptPreset>('promptPresets') : []
  if (!legacyPresets || !modelPresets || !promptPresets) return 'preset-hydration-failed'
  const modelPresetSelection = useSplitPresetSelection
    ? resolveSplitPresetSelection(modelPresets, loadout.modelPresetId, loadout.modelPresetName)
    : null
  const promptPresetSelection = useSplitPresetSelection
    ? resolveSplitPresetSelection(promptPresets, loadout.promptPresetId, loadout.promptPresetName)
    : null
  const hasModelReference = !!nonBlankId(loadout.modelPresetId) || !!nonBlankId(loadout.modelPresetName)
  const hasPromptReference = !!nonBlankId(loadout.promptPresetId) || !!nonBlankId(loadout.promptPresetName)
  if ((hasModelReference && !modelPresetSelection) || (hasPromptReference && !promptPresetSelection)) {
    return 'preset-hydration-failed'
  }
  const agentPresetResolution = requested.has('preset') ? resolveLoadoutAgentPresetId(loadout) : { value: undefined }
  if (!agentPresetResolution) return 'preset-hydration-failed'
  const resolvedAgentPresetId = agentPresetResolution.value
  const resolvedTogglePresetId =
    requested.has('preset') && Object.hasOwn(loadout, 'togglePresetId') && typeof loadout.togglePresetId === 'string'
      ? loadout.togglePresetId
      : undefined
  const presetIndex =
    requested.has('preset') && !useSplitPresetSelection
      ? (legacyPresets?.findIndex((preset) =>
          legacyPresetId ? preset.id === legacyPresetId : preset.name === loadout.presetName,
        ) ?? -1)
      : -1
  if (legacyPresetId && (presetIndex < 0 || !presetHasHydratedSettings(legacyPresets[presetIndex]))) {
    return 'superseded'
  }
  const previousModules = cloneJsonValue((settingsSnapshot.enabledModules as string[] | undefined) ?? [])
  const nextModules = cloneJsonValue(loadout.modules ?? [])
  const previousGlobalChatVariables = cloneJsonValue(
    (settingsSnapshot.globalChatVariables as Record<string, string> | undefined) ?? {},
  )
  const nextGlobalChatVariables = cloneJsonValue(loadout.globalVariables ?? {})
  const globalVariablesChanged = snapshotJson(previousGlobalChatVariables) !== snapshotJson(nextGlobalChatVariables)
  const resolvedLegacyPresetId =
    presetIndex >= 0 && presetHasHydratedSettings(legacyPresets[presetIndex])
      ? nonBlankId(legacyPresets[presetIndex]?.id)
      : null
  const previousPersona = personaSelection ? currentPersonaStateSnapshot() : null
  const previousPersonaId = previousPersona ? nonBlankId(previousPersona.selectedPersonaId) : null
  const previousModelPresetId = modelPresetSelection
    ? nonBlankId(modelPresets[settingsOwnerSelectionIndex('modelPresetsId') ?? -1]?.id)
    : null
  const previousPromptPresetId = promptPresetSelection
    ? nonBlankId(promptPresets[settingsOwnerSelectionIndex('promptPresetsId') ?? -1]?.id)
    : null
  const preparedAgentGenerationSettings =
    activeChatAgentPresetTarget && (resolvedAgentPresetId !== undefined || resolvedTogglePresetId !== undefined)
      ? createGenerationSettingsWithPresetSelections(
          activeChatAgentPresetTarget.chat.generationSettings,
          resolvedAgentPresetId,
          resolvedTogglePresetId,
        )
      : null
  const agentPresetChanged =
    !!activeChatAgentPresetTarget &&
    !!preparedAgentGenerationSettings &&
    snapshotJson(activeChatAgentPresetTarget.chat.generationSettings) !== snapshotJson(preparedAgentGenerationSettings)

  // Drain only the exact outgoing/target owner patches before reserving the
  // selection commands. Same-lane settings writes are ordered by their
  // durable mutation key and require no broad prompt/settings registry flush.
  if (personaSelection) void flushPendingSelectedPersonaUpdate()
  if (modelPresetSelection) {
    for (const presetId of new Set([previousModelPresetId, modelPresetSelection.presetId])) {
      if (presetId) flushPendingSplitPresetPatch('model', presetId)
    }
  }
  if (promptPresetSelection) {
    const promptPresetOwnerIds = new Set([previousPromptPresetId, promptPresetSelection.presetId])
    commitPendingPromptTemplateOwnerMutations(promptPresetOwnerIds)
    for (const presetId of promptPresetOwnerIds) {
      if (presetId) flushPendingSplitPresetPatch('prompt', presetId)
    }
  }

  const personaDurability = personaSelection
    ? prepareLoadoutDurableStep(PERSONA_SELECTION_MUTATION_KEY, {
        version: 1,
        dependencyKeys: Array.from(
          new Set(
            [previousPersonaId, personaSelection.personaId]
              .filter((personaId): personaId is string => personaId !== null)
              .map(personaOwnerMutationKey),
          ),
        ),
        requests: [
          {
            method: 'POST',
            path: '/personas/select',
            body: {
              personaId: personaSelection.personaId,
              mirrorLegacyProfile: false,
              saveCurrent: false,
            },
          },
        ],
      })
    : null
  const legacyPresetDurability = resolvedLegacyPresetId
    ? prepareLoadoutDurableStep(SETTINGS_BRIDGE_MUTATION_KEY, {
        version: 1,
        requests: [
          {
            method: 'POST',
            path: '/presets/select',
            body: { presetId: resolvedLegacyPresetId, apply: true, saveCurrent: true },
          },
        ],
      })
    : null
  const modelPresetDurability = modelPresetSelection
    ? prepareLoadoutDurableStep(SETTINGS_BRIDGE_MUTATION_KEY, {
        version: 1,
        dependencyKeys: Array.from(
          new Set(
            [previousModelPresetId, modelPresetSelection.presetId]
              .filter((presetId): presetId is string => presetId !== null)
              .map((presetId) => splitPresetMutationKey('model', presetId)),
          ),
        ),
        requests: [
          {
            method: 'POST',
            path: '/model-presets/select',
            body: { modelPresetId: modelPresetSelection.presetId },
          },
        ],
      })
    : null
  const promptPresetDurability = promptPresetSelection
    ? prepareLoadoutDurableStep(SETTINGS_BRIDGE_MUTATION_KEY, {
        version: 1,
        dependencyKeys: Array.from(
          new Set(
            [previousPromptPresetId, promptPresetSelection.presetId]
              .filter((presetId): presetId is string => presetId !== null)
              .map(promptTemplateOwnerMutationKey),
          ),
        ),
        requests: [
          {
            method: 'POST',
            path: '/prompt-presets/select',
            body: { promptPresetId: promptPresetSelection.presetId },
          },
        ],
      })
    : null
  const agentPresetDurability =
    activeChatAgentPresetTarget && agentPresetChanged && preparedAgentGenerationSettings
      ? prepareLoadoutDurableStep(
          chatResourceOwnerMutationKey(activeChatAgentPresetTarget.chatId, activeChatAgentPresetTarget.characterId),
          {
            version: 1,
            dependencyKeys: chatGenerationSettingsMutationDependencyKeys(preparedAgentGenerationSettings),
            requests: [
              {
                method: 'PUT',
                path: `/chats/${encodeURIComponent(activeChatAgentPresetTarget.chatId)}/generation-settings`,
                body: { generationSettings: cloneJsonValue(preparedAgentGenerationSettings) },
              },
            ],
          },
        )
      : null
  const modulePlans = requested.has('modules') ? changedModulePlans(previousModules, nextModules) : []
  const globalVariablesDurability =
    requested.has('globalVariables') && globalVariablesChanged
      ? prepareLoadoutDurableStep(SETTINGS_BRIDGE_MUTATION_KEY, {
          version: 1,
          requests: [
            {
              method: 'PATCH',
              path: '/settings/sidebar',
              body: { patch: { globalChatVariables: cloneJsonValue(nextGlobalChatVariables) } },
            },
          ],
        })
      : null
  const lastUsed = Date.now()
  const previousLoadoutIndex = loadoutOwner.findIndex((item) => item.id === loadout.id)
  const previousLoadout = previousLoadoutIndex === -1 ? undefined : loadoutOwner[previousLoadoutIndex]
  const shouldAddCurrentCharacter =
    !!currentCharacterId && !(previousLoadout?.characterIds ?? loadout.characterIds ?? []).includes(currentCharacterId)
  const touchCharacterId = shouldAddCurrentCharacter ? currentCharacterId : undefined
  const touchDurability = prepareLoadoutDurableStep(loadoutOwnerMutationKey(loadout.id), {
    version: 1,
    dependencyKeys: [SETTINGS_BRIDGE_MUTATION_KEY],
    requests: [
      {
        method: 'POST',
        path: `/loadouts/${encodeURIComponent(loadout.id)}/touch`,
        body: {
          lastUsed,
          ...(touchCharacterId ? { characterId: touchCharacterId } : {}),
        },
      },
    ],
  })
  const touchRollback: LoadoutTouchRollback = {
    loadoutId: loadout.id,
    ownerRevision: collectionsResourceState.revision,
    previous: previousLoadout
      ? {
          lastUsed: previousLoadout.lastUsed,
          characterIds: cloneJsonValue(previousLoadout.characterIds ?? []),
        }
      : {},
    attempted: {},
    previousLastLoadedLoadoutName:
      typeof settingsSnapshot.lastLoadedLoadoutName === 'string' ? settingsSnapshot.lastLoadedLoadoutName : '',
    attemptedLastLoadedLoadoutName: previousLoadout?.name ?? loadout.name,
  }
  let touchedLiveLoadoutName: string | null = null
  let selectedLegacyPresetId: string | null = null
  let selectedModelPresetId: string | null = null
  let selectedPromptPresetId: string | null = null
  let personaRollback: LoadoutPersonaSelectionRollback | null = null
  let legacyPresetRollback: LegacyPresetSelectionRollback | null = null
  let modelPresetRollback: SplitPresetSelectionRollback | null = null
  let promptPresetRollback: SplitPresetSelectionRollback | null = null
  let agentPresetRollback: AgentPresetSelectionRollback | null = null

  if (personaSelection && previousPersona) {
    selectUserPersonaLocally(personaSelection.index, 'save')
    const attemptedPersona = currentPersonaStateSnapshot()
    personaRollback = personaSelectionRollback(previousPersona, attemptedPersona)
  }

  const projectedLoadouts = cloneJsonValue(loadoutOwner)
  const liveTargetLoadout = projectedLoadouts.find((item) => item.id === loadout.id)
  if (liveTargetLoadout) {
    liveTargetLoadout.lastUsed = lastUsed
    if (touchCharacterId && !liveTargetLoadout.characterIds.includes(touchCharacterId)) {
      liveTargetLoadout.characterIds.push(touchCharacterId)
    }
    touchRollback.attempted = {
      lastUsed: liveTargetLoadout.lastUsed,
      characterIds: cloneJsonValue(liveTargetLoadout.characterIds ?? []),
    }
    touchRollback.attemptedRow = cloneJsonValue(liveTargetLoadout)
    touchRollback.previousIndex = previousLoadoutIndex
    if (nonBlankId(liveTargetLoadout.name)) {
      touchedLiveLoadoutName = liveTargetLoadout.name
      touchRollback.attemptedLastLoadedLoadoutName = liveTargetLoadout.name
    }
    replaceLoadoutCollectionOwner(projectedLoadouts)
  }

  if (presetIndex >= 0) {
    const targetPreset = legacyPresets[presetIndex]
    if (presetHasHydratedSettings(targetPreset)) {
      const previousSettings = snapshotPresetSettings()
      const previousSelectedId = currentBotPresetSelectedId()
      const saveCurrentRollback = saveCurrentPresetSnapshotLocal()
      const currentBotPresets = uniquePresetCollectionOwner<botPreset>('botPresets')
      const settings = currentSettingsOwnerSnapshot()
      if (!currentBotPresets || !settings) return 'persistence-failed'
      const resolvedPresetIndex = currentBotPresets.findIndex((preset) => preset.id === targetPreset.id)
      if (resolvedPresetIndex < 0) return 'superseded'
      const draft = materializePresetProjectionDatabase({ settings, botPresets: currentBotPresets })
      draft.botPresetsId = resolvedPresetIndex
      setPreset(draft, currentBotPresets[resolvedPresetIndex])
      if (!projectPresetSettingsOwner(draft) || !replaceSettingsOwnerFields({ botPresetsId: resolvedPresetIndex })) {
        return 'persistence-failed'
      }
      selectedLegacyPresetId = nonBlankId(targetPreset.id)
      const attemptedSettings = snapshotPresetSettings()
      legacyPresetRollback = {
        previousSelectedId,
        attemptedSelectedId: currentBotPresetSelectedId(),
        previous: previousSettings,
        attempted: attemptedSettings,
        changedKeys: changedPresetSettingsKeys(previousSettings, attemptedSettings),
        saveCurrentRollback,
      }
    }
  }

  if (modelPresetSelection) {
    const previousSelectedId = currentSplitPresetSelectedId('model')
    const previousSettings = snapshotPresetSettings()
    const settings = currentSettingsOwnerSnapshot()
    if (!settings) return 'persistence-failed'
    const draft = materializePresetProjectionDatabase({ settings, modelPresets, promptPresets })
    draft.modelPresetsId = modelPresetSelection.index
    applyModelPresetFieldsToDatabase(draft, modelPresets[modelPresetSelection.index])
    if (
      !projectPresetSettingsOwner(draft) ||
      !replaceSettingsOwnerFields({ modelPresetsId: modelPresetSelection.index })
    ) {
      return 'persistence-failed'
    }
    selectedModelPresetId = modelPresetSelection.presetId
    const attemptedSettings = snapshotPresetSettings()
    modelPresetRollback = {
      kind: 'model',
      previousSelectedId,
      attemptedSelectedId: currentSplitPresetSelectedId('model'),
      previous: previousSettings,
      attempted: attemptedSettings,
      changedKeys: changedPresetSettingsKeys(previousSettings, attemptedSettings),
    }
  }

  if (promptPresetSelection) {
    const previousSelectedId = currentSplitPresetSelectedId('prompt')
    const previousSettings = snapshotPresetSettings()
    const settings = currentSettingsOwnerSnapshot()
    if (!settings) return 'persistence-failed'
    const draft = materializePresetProjectionDatabase({ settings, modelPresets, promptPresets })
    draft.promptPresetsId = promptPresetSelection.index
    applyPromptPresetFieldsToDatabase(draft, promptPresets[promptPresetSelection.index])
    if (
      !projectPresetSettingsOwner(draft) ||
      !replaceSettingsOwnerFields({ promptPresetsId: promptPresetSelection.index })
    ) {
      return 'persistence-failed'
    }
    selectedPromptPresetId = promptPresetSelection.presetId
    const attemptedSettings = snapshotPresetSettings()
    promptPresetRollback = {
      kind: 'prompt',
      previousSelectedId,
      attemptedSelectedId: currentSplitPresetSelectedId('prompt'),
      previous: previousSettings,
      attempted: attemptedSettings,
      changedKeys: changedPresetSettingsKeys(previousSettings, attemptedSettings),
    }
  }

  if (activeChatAgentPresetTarget && resolvedAgentPresetId !== undefined) {
    const targetChat = findChatById(activeChatAgentPresetTarget.chatId, activeChatAgentPresetTarget.characterId)
    if (targetChat) {
      const hadGenerationSettings = Object.hasOwn(targetChat, 'generationSettings')
      const previousGenerationSettings = cloneJsonValue(targetChat.generationSettings)
      const nextGenerationSettings = preparedAgentGenerationSettings
      if (nextGenerationSettings && snapshotJson(previousGenerationSettings) !== snapshotJson(nextGenerationSettings)) {
        targetChat.generationSettings = cloneJsonValue(nextGenerationSettings)
        agentPresetRollback = {
          characterId: activeChatAgentPresetTarget.characterId,
          chatId: activeChatAgentPresetTarget.chatId,
          hadGenerationSettings,
          previousGenerationSettings,
          attemptedGenerationSettings: cloneJsonValue(nextGenerationSettings),
        }
      }
    }
  }

  if (requested.has('modules')) replaceSettingsOwnerFields({ enabledModules: nextModules })
  if (requested.has('globalVariables')) {
    replaceSettingsOwnerFields({ globalChatVariables: nextGlobalChatVariables })
  }
  replaceSettingsOwnerFields({ lastLoadedLoadoutName: touchedLiveLoadoutName ?? loadout.name })

  if (personaRollback) {
    registerPreparedLoadoutProjectionTargets(personaDurability, [
      ...personaRollback.rows.map((row) => pendingMutationPersonaRowProjectionTarget(row.personaId)),
      ...(['username', 'userIcon', 'personaPrompt', 'userNote'] as const)
        .filter(
          (key) =>
            snapshotJson(personaRollback.previousMirror[key]) !== snapshotJson(personaRollback.attemptedMirror[key]),
        )
        .map(pendingMutationSettingsFieldProjectionTarget),
    ])
  }
  if (legacyPresetRollback) {
    registerPreparedLoadoutProjectionTargets(legacyPresetDurability, [
      ...legacyPresetRollback.changedKeys.map(pendingMutationSettingsFieldProjectionTarget),
      ...(legacyPresetRollback.saveCurrentRollback
        ? [pendingMutationPresetRowProjectionTarget('legacy', legacyPresetRollback.saveCurrentRollback.presetId)]
        : []),
    ])
  }
  if (modelPresetRollback) {
    registerPreparedLoadoutProjectionTargets(
      modelPresetDurability,
      modelPresetRollback.changedKeys.map(pendingMutationSettingsFieldProjectionTarget),
    )
  }
  if (promptPresetRollback) {
    registerPreparedLoadoutProjectionTargets(
      promptPresetDurability,
      promptPresetRollback.changedKeys.map(pendingMutationSettingsFieldProjectionTarget),
    )
  }

  const steps: LoadoutApplyStep[] = []
  if (personaSelection && personaRollback) {
    steps.push(
      createLoadoutApplyStep(
        (baseRevision) =>
          selectPersonaCommand({
            baseRevision,
            personaId: personaSelection.personaId,
            mirrorLegacyProfile: false,
            saveCurrent: false,
          }),
        () => rollbackPersonaSelection(personaRollback),
        personaDurability,
        (isTargetCurrent) => reapplyPersonaSelection(personaRollback, isTargetCurrent),
      ),
    )
  }
  if (selectedLegacyPresetId && legacyPresetRollback) {
    steps.push(
      createLoadoutApplyStep(
        (baseRevision) =>
          selectPresetCommand({
            baseRevision,
            presetId: selectedLegacyPresetId,
            apply: true,
            saveCurrent: true,
          }),
        () => rollbackLegacyPresetSelection(legacyPresetRollback),
        legacyPresetDurability,
        (isTargetCurrent) => reapplyLegacyPresetSelection(legacyPresetRollback, isTargetCurrent),
        legacyPresetRollback,
      ),
    )
  }
  if (selectedModelPresetId && modelPresetRollback) {
    steps.push(
      createLoadoutApplyStep(
        (baseRevision) =>
          selectModelPresetCommand({
            baseRevision,
            modelPresetId: selectedModelPresetId,
          }),
        () => rollbackSplitPresetSelection(modelPresetRollback),
        modelPresetDurability,
        (isTargetCurrent) => reapplySplitPresetSelection(modelPresetRollback, isTargetCurrent),
        modelPresetRollback,
      ),
    )
  }
  if (selectedPromptPresetId && promptPresetRollback) {
    steps.push(
      createLoadoutApplyStep(
        (baseRevision) =>
          selectPromptPresetCommand({
            baseRevision,
            promptPresetId: selectedPromptPresetId,
          }),
        () => rollbackSplitPresetSelection(promptPresetRollback),
        promptPresetDurability,
        (isTargetCurrent) => reapplySplitPresetSelection(promptPresetRollback, isTargetCurrent),
        promptPresetRollback,
      ),
    )
  }
  if (agentPresetRollback) {
    const rollback = agentPresetRollback
    steps.push(
      createLoadoutApplyStep(
        (baseRevision) =>
          saveChatGenerationSettingsCommand({
            baseRevision,
            chatId: rollback.chatId,
            generationSettings: rollback.attemptedGenerationSettings,
          }),
        () => rollbackAgentPresetSelection(rollback),
        agentPresetDurability,
        (isTargetCurrent) => reapplyAgentPresetSelection(rollback, isTargetCurrent),
      ),
    )
  }
  if (requested.has('modules')) {
    steps.push(...changedModuleSteps(previousModules, nextModules, modulePlans))
  }
  if (requested.has('globalVariables') && globalVariablesChanged) {
    const group = settingsGroupForKey('globalChatVariables')
    if (group) {
      const rollback: LoadoutGlobalVariablesRollback = {
        previous: previousGlobalChatVariables,
        attempted: nextGlobalChatVariables,
      }
      steps.push(
        createLoadoutApplyStep(
          (baseRevision) =>
            patchSettingsGroup({
              group,
              baseRevision,
              patch: {
                globalChatVariables: nextGlobalChatVariables,
              },
            }),
          () => rollbackGlobalChatVariables(rollback),
          globalVariablesDurability,
          (isTargetCurrent) => reapplyGlobalChatVariables(rollback, isTargetCurrent),
        ),
      )
    }
  }
  steps.push(
    createLoadoutApplyStep(
      (baseRevision) =>
        touchLoadoutCommand({
          baseRevision,
          loadoutId: loadout.id,
          lastUsed,
          characterId: touchCharacterId,
        }),
      () => rollbackLoadoutTouch(touchRollback),
      touchDurability,
      (isTargetCurrent) => reapplyLoadoutTouch(touchRollback, isTargetCurrent),
    ),
  )

  // Reserve the global command queue synchronously with the optimistic
  // projection. The first queued step waits for every prepared row, so a
  // later user action can neither overtake this sequence nor make its first
  // request start before the retained tail is durable.
  const durabilityReady = awaitPreparedLoadoutDurability(steps)
  const sequenceEntries: ServerCommandSequenceEntry[] = steps.map((step, index) => {
    if (index !== 0) {
      return step.executionWrapper ? { command: step.command, executionWrapper: step.executionWrapper } : step.command
    }
    return {
      command: step.command,
      executionWrapper: async (execute) => {
        await durabilityReady
        return step.executionWrapper ? step.executionWrapper(execute) : execute()
      },
    }
  })
  const failure = await runServerCommandSequence(sequenceEntries, (rollbackIsCurrent) =>
    settleFailedLoadoutApplySteps(steps, rollbackIsCurrent),
  )
  if (failure !== null) reapplyRetainedLoadoutApplySteps(steps)
  if (failure === null) return 'applied'
  return steps.some((step) => !step.succeeded && step.durability && retainsDurableLoadoutProjection(step.durability))
    ? 'queued'
    : 'persistence-failed'
}

export async function saveCurrentLoadout(name: string): Promise<LoadoutCreateResult> {
  const loadout = makeLoadout({ name })
  if (!canUseClientWriteAccess()) return { status: 'failed', loadout }
  const owner = currentLoadoutCollectionOwner()
  if (!owner || !isCanonicalLoadout(loadout) || owner.some((candidate) => candidate.id === loadout.id)) {
    return { status: 'failed', loadout }
  }
  const projected = cloneJsonValue(owner)
  projected.push(loadout)
  if (!replaceLoadoutCollectionOwner(projected)) return { status: 'failed', loadout }
  const status = await dispatchCreateLoadout(loadout)
  return { status, loadout }
}
