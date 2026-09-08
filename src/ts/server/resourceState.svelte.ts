import type { Database, character } from '../storage/databaseTypes'
import type { ChatGenerationSettings } from '../chatGenerationSettings'
import type {
  ServerCharacterOrderResource,
  ServerCharacterSelectionResource,
} from '@risuai/protocol/character-resource'
import { normalizeAgentPresets, validateAgentPresetRecord } from '../agentPresetRecords'
import {
  isValidTranslatorPresetOutputKey,
  TRANSLATOR_PRESET_MAX_STEPS,
  type TranslatorPresetStep,
} from '../translator/presets'
import { changeLanguage } from '../../lang'
import { shouldPreserveLiveChatGenerationSettingsForResource } from './chatGenerationSettingsResourceGuard'
import { isCanonicalLoadoutCollection } from './loadoutCanonical'
import {
  isModelProfileSettingsGroup,
  SERVER_SETTINGS_GROUP_BY_KEY,
  SETTINGS_GROUPS,
  type SettingsGroup,
  type SettingsGroupProjectionEpochs,
} from './settingsGroups'
import type { PromptItemMutationOperation, PromptTemplateOwnerStateSnapshot } from './commands'
import { applySettingsRuntimeProjectionEffects } from './settingsRuntimeProjectionHooks'
import { applyPendingSettingsProjectionOverlays } from './settingsPendingProjection'
import { reapplyRetainedCharacterProjections } from './chatRetainedProjection'
import {
  clearReaderTranscriptProjection,
  recordReaderCharacters,
  recordReaderCharacterOrder,
  recordReaderNavigationSettings,
  recordReaderCharacter,
  recordReaderCharacterPatch,
  recordReaderChatPatch,
  recordReaderChatPersona,
  recordReaderPersonas,
  recordReaderPersonaPatch,
  requireReaderPersonaRefresh,
  recordReaderPersonaSettings,
} from './readerTranscriptProjection.svelte'
import {
  SERVER_CHARACTER_SHELL_MARKER,
  SERVER_CHARACTER_SUMMARY_VERSION,
} from '@risuai/protocol/character-summary-resource'
import {
  SERVER_SHELL_SETTINGS_KEYS,
  isServerShellSettings,
  type ServerShellSettings,
} from '@risuai/protocol/shell-resource'
import {
  SERVER_STANDALONE_SETTING_NAMES,
  type ServerStandaloneSettingName,
  type ServerStandaloneSettingPayload,
} from '@risuai/protocol/standalone-settings'
import { projectChatMetadata, type ChatMetadataOwnerState } from './chatMetadataOwner'
import { hypaV3PresetIndexFromStableId } from '@risuai/shared-core/hypa-v3-preset-selection-identity'
import { invalidateModuleRenderRevision } from '../moduleRenderRevision'

let nextCharacterRowProjectionEpoch = 0
let characterRowProjectionBaseline = 0
const characterRowProjectionEpochs = new Map<string, number>()
let characterListProjectionEpoch = 0
const chatBodyResourceRevisions = new Map<string, number>()
let nextChatBodyProjectionEpoch = 0
let chatBodyProjectionBaseline = 0
const chatBodyProjectionEpochs = new Map<string, number>()
const characterLorebookBodyResourceRevisions = new Map<string, number>()
let nextCharacterLorebookBodyProjectionEpoch = 0
let characterLorebookBodyProjectionBaseline = 0
const characterLorebookBodyProjectionEpochs = new Map<string, number>()
let nextCharacterLorebookProjectionEpoch = 0
let characterLorebookProjectionBaseline = 0
const characterLorebookProjectionEpochs = new Map<string, number>()
let nextCollectionProjectionEpoch = 0
let collectionProjectionBaseline = 0
const collectionProjectionEpochs = new Map<ServerCollectionName, number>()
const collectionAcknowledgementTaints = new Set<ServerCollectionName>()
let lorebookPageProjectionEpoch = 0
let settingsProjectionEpoch = 0
let settingsAcknowledgementTainted = false
let nextSettingsProjectionEpoch = 0
let settingsProjectionBaseline = 0
const settingsGroupProjectionEpochs = new Map<SettingsGroup, number>()
const settingsGroupAcknowledgementTaints = new Set<SettingsGroup>()

function advanceCharacterRowProjectionEpoch(characterId: string): void {
  characterRowProjectionEpochs.set(characterId, ++nextCharacterRowProjectionEpoch)
}

function advanceAllCharacterRowProjectionEpochs(): void {
  characterRowProjectionBaseline = ++nextCharacterRowProjectionEpoch
  characterRowProjectionEpochs.clear()
}

export function captureCharacterRowProjectionEpoch(characterId: string): number {
  return characterRowProjectionEpochs.get(characterId) ?? characterRowProjectionBaseline
}

export function hasCharacterRowProjectionEpochChanged(characterId: string, epoch: number): boolean {
  return captureCharacterRowProjectionEpoch(characterId) !== epoch
}

export function captureCharacterListProjectionEpoch(): number {
  return characterListProjectionEpoch
}

export function hasCharacterListProjectionEpochChanged(epoch: number): boolean {
  return captureCharacterListProjectionEpoch() !== epoch
}

function advanceCharacterListProjectionEpoch(): void {
  characterListProjectionEpoch += 1
}

/** Whether a newer authoritative transcript body has already been applied. */
export function hasNewerChatBodyResourceRevision(chatId: string, revision: number): boolean {
  return (chatBodyResourceRevisions.get(chatId) ?? -1) > revision
}

/** Record an authoritative transcript-body apply without claiming the parent character row. */
export function markChatBodyResourceRevision(chatId: string, revision: number): void {
  if (!nonEmptyString(chatId) || !Number.isInteger(revision) || revision < 0) return
  chatBodyResourceRevisions.set(chatId, Math.max(chatBodyResourceRevisions.get(chatId) ?? -1, revision))
}

export function isChatBodyResourceLoaded(chatId: string): boolean {
  return nonEmptyString(chatId) && chatBodyResourceRevisions.has(chatId)
}

function advanceChatBodyProjectionEpoch(chatId: string): void {
  chatBodyProjectionEpochs.set(chatId, ++nextChatBodyProjectionEpoch)
}

function advanceAllChatBodyProjectionEpochs(): void {
  chatBodyProjectionBaseline = ++nextChatBodyProjectionEpoch
  chatBodyProjectionEpochs.clear()
}

export function captureChatBodyProjectionEpoch(chatId: string): number {
  return chatBodyProjectionEpochs.get(chatId) ?? chatBodyProjectionBaseline
}

export function hasChatBodyProjectionEpochChanged(chatId: string, epoch: number): boolean {
  return captureChatBodyProjectionEpoch(chatId) !== epoch
}

/** Record a transcript-body apply or accepted local mutation. */
export function markChatBodyProjectionApplied(chatId: string): void {
  if (nonEmptyString(chatId)) advanceChatBodyProjectionEpoch(chatId)
}

/** Whether a newer authoritative character-lorebook body has already been applied. */
export function hasNewerCharacterLorebookBodyResourceRevision(characterId: string, revision: number): boolean {
  return (characterLorebookBodyResourceRevisions.get(characterId) ?? -1) > revision
}

/** Record an authoritative lorebook-body apply without claiming the parent character row. */
export function markCharacterLorebookBodyResourceRevision(characterId: string, revision: number): void {
  if (!nonEmptyString(characterId) || !Number.isInteger(revision) || revision < 0) return
  characterLorebookBodyResourceRevisions.set(
    characterId,
    Math.max(characterLorebookBodyResourceRevisions.get(characterId) ?? -1, revision),
  )
}

export function isCharacterLorebookBodyResourceLoaded(characterId: string): boolean {
  return nonEmptyString(characterId) && characterLorebookBodyResourceRevisions.has(characterId)
}

function advanceCharacterLorebookBodyProjectionEpoch(characterId: string): void {
  characterLorebookBodyProjectionEpochs.set(characterId, ++nextCharacterLorebookBodyProjectionEpoch)
}

function advanceAllCharacterLorebookBodyProjectionEpochs(): void {
  characterLorebookBodyProjectionBaseline = ++nextCharacterLorebookBodyProjectionEpoch
  characterLorebookBodyProjectionEpochs.clear()
}

export function captureCharacterLorebookBodyProjectionEpoch(characterId: string): number {
  return characterLorebookBodyProjectionEpochs.get(characterId) ?? characterLorebookBodyProjectionBaseline
}

export function hasCharacterLorebookBodyProjectionEpochChanged(characterId: string, epoch: number): boolean {
  return captureCharacterLorebookBodyProjectionEpoch(characterId) !== epoch
}

function resetCharacterBodyResourceRevisions(): void {
  chatBodyResourceRevisions.clear()
  characterLorebookBodyResourceRevisions.clear()
}

function pruneCharacterBodyResourceRevisions(characters: readonly character[]): void {
  const characterIds = new Set<string>()
  const chatIds = new Set<string>()
  for (const candidate of characters) {
    if (nonEmptyString(candidate?.chaId)) characterIds.add(candidate.chaId)
    for (const chat of candidate?.chats ?? []) {
      if (nonEmptyString(chat?.id)) chatIds.add(chat.id)
    }
  }
  for (const chatId of chatBodyResourceRevisions.keys()) {
    if (!chatIds.has(chatId)) chatBodyResourceRevisions.delete(chatId)
  }
  for (const characterId of characterLorebookBodyResourceRevisions.keys()) {
    if (!characterIds.has(characterId)) characterLorebookBodyResourceRevisions.delete(characterId)
  }
}

function markRemovedCharacterBodyProjections(
  previousCharacters: readonly character[],
  nextCharacters: readonly character[],
): void {
  const nextCharacterIds = new Set(
    nextCharacters.filter((candidate) => nonEmptyString(candidate?.chaId)).map((candidate) => candidate.chaId),
  )
  const nextChatIds = new Set(
    nextCharacters.flatMap((candidate) =>
      (candidate?.chats ?? []).filter((chat) => nonEmptyString(chat?.id)).map((chat) => chat.id),
    ),
  )
  for (const character of previousCharacters) {
    if (nonEmptyString(character?.chaId) && !nextCharacterIds.has(character.chaId)) {
      markCharacterLorebookProjectionApplied(character.chaId)
    }
    for (const chat of character?.chats ?? []) {
      if (nonEmptyString(chat?.id) && !nextChatIds.has(chat.id)) markChatBodyProjectionApplied(chat.id)
    }
  }
}

function advanceCharacterLorebookProjectionEpoch(characterId: string): void {
  characterLorebookProjectionEpochs.set(characterId, ++nextCharacterLorebookProjectionEpoch)
}

function advanceAllCharacterLorebookProjectionEpochs(): void {
  characterLorebookProjectionBaseline = ++nextCharacterLorebookProjectionEpoch
  characterLorebookProjectionEpochs.clear()
}

export function captureCharacterLorebookProjectionEpoch(characterId: string): number {
  return characterLorebookProjectionEpochs.get(characterId) ?? characterLorebookProjectionBaseline
}

export function hasCharacterLorebookProjectionEpochChanged(characterId: string, epoch: number): boolean {
  return captureCharacterLorebookProjectionEpoch(characterId) !== epoch
}

/** Record a successful authoritative character-lorebook-only projection apply. */
export function markCharacterLorebookProjectionApplied(characterId: string): void {
  if (!nonEmptyString(characterId)) return
  advanceCharacterLorebookProjectionEpoch(characterId)
  advanceCharacterLorebookBodyProjectionEpoch(characterId)
}

function advanceCollectionProjectionEpoch(name: ServerCollectionName): void {
  collectionProjectionEpochs.set(name, ++nextCollectionProjectionEpoch)
  collectionAcknowledgementTaints.delete(name)
}

function advanceAllCollectionProjectionEpochs(): void {
  collectionProjectionBaseline = ++nextCollectionProjectionEpoch
  collectionProjectionEpochs.clear()
  collectionAcknowledgementTaints.clear()
}

export function captureCollectionProjectionEpoch(name: ServerCollectionName): number {
  return collectionProjectionEpochs.get(name) ?? collectionProjectionBaseline
}

export function hasCollectionProjectionEpochChanged(name: ServerCollectionName, epoch: number): boolean {
  return captureCollectionProjectionEpoch(name) !== epoch
}

export function isCollectionAcknowledgementTainted(name: ServerCollectionName): boolean {
  return collectionAcknowledgementTaints.has(name)
}

export function markCollectionAcknowledgementTainted(name: ServerCollectionName): void {
  collectionAcknowledgementTaints.add(name)
}

export function captureSettingsProjectionEpoch(): number {
  return settingsProjectionEpoch
}

export function hasSettingsProjectionEpochChanged(epoch: number): boolean {
  return captureSettingsProjectionEpoch() !== epoch
}

export function isSettingsAcknowledgementTainted(): boolean {
  return settingsAcknowledgementTainted
}

export function markSettingsAcknowledgementTainted(): void {
  settingsAcknowledgementTainted = true
}

function advanceSettingsProjectionEpoch(options: { authoritativeFull?: boolean } = {}): void {
  settingsProjectionEpoch += 1
  if (options.authoritativeFull) settingsAcknowledgementTainted = false
}

function advanceLorebookPageProjectionEpoch(): void {
  lorebookPageProjectionEpoch += 1
}

export function captureLorebookPageProjectionEpoch(): number {
  return lorebookPageProjectionEpoch
}

export function hasLorebookPageProjectionEpochChanged(epoch: number): boolean {
  return captureLorebookPageProjectionEpoch() !== epoch
}

function advanceSettingsGroupProjectionEpoch(
  group: SettingsGroup,
  options: { preserveAcknowledgementTaint?: boolean } = {},
): void {
  settingsGroupProjectionEpochs.set(group, ++nextSettingsProjectionEpoch)
  if (!options.preserveAcknowledgementTaint) settingsGroupAcknowledgementTaints.delete(group)
}

function advanceAllSettingsProjectionEpochs(): void {
  settingsProjectionBaseline = ++nextSettingsProjectionEpoch
  settingsGroupProjectionEpochs.clear()
  settingsGroupAcknowledgementTaints.clear()
}

export function captureSettingsGroupProjectionEpoch(group: SettingsGroup): number {
  return settingsGroupProjectionEpochs.get(group) ?? settingsProjectionBaseline
}

export function captureSettingsPatchProjectionEpochs(
  patch: Readonly<Record<string, unknown>>,
): SettingsGroupProjectionEpochs {
  const epochs: SettingsGroupProjectionEpochs = {}
  for (const key of Object.keys(patch)) {
    const group = SERVER_SETTINGS_GROUP_BY_KEY[key]
    if (group && epochs[group] === undefined) {
      epochs[group] = captureSettingsGroupProjectionEpoch(group)
    }
  }
  return epochs
}

export function hasSettingsGroupProjectionEpochChanged(group: SettingsGroup, epoch: number): boolean {
  return captureSettingsGroupProjectionEpoch(group) !== epoch
}

export function isSettingsGroupAcknowledgementTainted(group: SettingsGroup): boolean {
  return settingsGroupAcknowledgementTaints.has(group)
}

export function markSettingsGroupAcknowledgementTainted(group: SettingsGroup): void {
  settingsGroupAcknowledgementTaints.add(group)
}

export const SERVER_COLLECTION_NAMES = [
  'modules',
  'plugins',
  'modelPresets',
  'promptPresets',
  'botPresets',
  'promptTemplate',
  'personas',
  'loadouts',
  'loreBook',
  'translatorPresets',
  'hypaV3Presets',
  'pluginCustomStorage',
] as const

export type ServerCollectionName = (typeof SERVER_COLLECTION_NAMES)[number]
export type ServerCollectionValues = Pick<Database, ServerCollectionName>
export type ServerSettingsValues = Partial<
  Omit<Database, 'characters' | ServerCollectionName> & {
    currentChar: number
  }
>

export interface ServerSettingsResourcePayload {
  revision: number
  settings: ServerSettingsValues
}

export interface ServerSettingsGroupResourcePayload {
  revision: number
  group: SettingsGroup
  settings: ServerSettingsValues
}

export interface ServerCollectionsResourcePayload {
  revision: number
  collections: Partial<ServerCollectionValues>
}

export type ServerLegacyPresetResourceBaseline = ReadonlyMap<string, Record<string, unknown>>

export interface ServerLegacyPresetRowResourcePayload {
  revision: number
  presetId: string
  preset: Record<string, unknown>
  baseline?: ServerLegacyPresetResourceBaseline
}

export interface ServerLegacyPresetCollectionResourcePayload {
  revision: number
  shells: readonly unknown[]
  presetRows: readonly Record<string, unknown>[]
  baseline?: ServerLegacyPresetResourceBaseline
}

export type ServerJsonFieldState = { present: false } | { present: true; value: unknown }

export interface ServerLegacyPresetPatchLocalEffectPayload {
  revision: number
  presetId: string
  fields: Record<
    string,
    {
      attempted: ServerJsonFieldState
      canonical: ServerJsonFieldState
    }
  >
}

export interface ServerPresetReorderLocalEffectPayload {
  revision: number
  presetKind: 'legacy' | 'model'
  presetIds: string[]
  selectedPresetId: string | null
  settingsWritten: boolean
}

export interface ServerPersonaPatchLocalEffectPayload {
  revision: number
  personaId: string
  attemptedPatch: Record<string, unknown>
  attemptedPersona: Record<string, unknown>
  attemptedLegacyProfile: {
    username: string
    userIcon: string
    personaPrompt: string
    userNote: string
  }
  legacyProfileProjectionApplied: boolean
}

export interface ServerPersonaMutationLocalEffectPayload {
  revision: number
  operation: 'create' | 'delete' | 'select' | 'reorder'
  collectionWritten: boolean
  settingsWritten: boolean
}

export interface ServerTranslatorPresetPatchLocalEffectPayload {
  revision: number
  presetId: string
  attemptedPatch: Record<string, unknown>
  attemptedPreset: Record<string, unknown>
  selectedPresetId: string
}

export interface ServerAgentPresetPatchLocalEffectPayload {
  revision: number
  presetId: string
  fields: Record<
    string,
    {
      attempted: ServerJsonFieldState
      canonical: ServerJsonFieldState
    }
  >
  updatedAt: number
}

export interface ServerAgentPresetStepPatchLocalEffectPayload extends ServerAgentPresetPatchLocalEffectPayload {
  stepId: string
}

export interface ServerAgentPresetCollectionMutationLocalEffectPayload {
  revision: number
  operation: 'reorder' | 'default'
  presetIds: string[]
  agentPresetDefaultId: string | null
}

export interface ServerCharactersResourcePayload {
  version: typeof SERVER_CHARACTER_SUMMARY_VERSION
  revision: number
  characters: character[]
  characterOrder: Database['characterOrder']
  currentChar: number
}

export interface ServerCharacterResourcePayload {
  revision: number
  character: character
}

export type ServerCharacterOrderResourcePayload = ServerCharacterOrderResource

export type ServerCharacterSelectionResourcePayload = ServerCharacterSelectionResource

export interface ServerChatGenerationSettingsLocalEffectPayload {
  revision: number
  characterId: string
  chatId: string
  attemptedGenerationSettings: ChatGenerationSettings
  generationSettings: ChatGenerationSettings
}

export interface ServerCharacterPatchLocalEffectPayload {
  revision: number
  characterId: string
  patch: Record<string, unknown>
}

export interface ServerCharacterSelectionLocalEffectPayload {
  revision: number
  characterId: string
  lastInteraction: number
}

export interface ServerCharacterCollectionMutationLocalEffectPayload {
  revision: number
  operation: 'create' | 'createAndSelect' | 'delete'
  characterId: string
  selectedCharacterId: string | null
}

export interface ServerChatPatchLocalEffectPayload {
  revision: number
  characterId: string
  chatId: string
  patch: Record<string, unknown>
  select: boolean
}

export interface ServerSettingsPatchLocalEffectPayload {
  revision: number
  group: SettingsGroup
  attemptedPatch: Record<string, unknown>
  settings: Record<string, unknown>
}

export interface ServerPluginStorageLocalEffectPayload {
  revision: number
}

export interface ServerPluginCollectionMutationLocalEffectPayload {
  revision: number
  operation: 'create' | 'update' | 'delete' | 'enable' | 'reorder'
  pluginId?: string
  pluginIds?: readonly string[]
}

export interface ServerPluginProviderLocalEffectPayload {
  revision: number
  provider: string
}

export interface ServerModuleCollectionMutationLocalEffectPayload {
  revision: number
  operation: 'create' | 'update' | 'reorder' | 'lorebooks' | 'scripts' | 'triggers'
  moduleId?: string
  moduleIds?: readonly string[]
}

export interface ServerModuleEnabledLocalEffectPayload {
  revision: number
  moduleId: string
  enabled: boolean
}

export interface ServerPromptItemMutationLocalEffectPayload {
  revision: number
  operation: PromptItemMutationOperation
  promptPresetId: string | null
  itemId?: string
  itemIds?: readonly string[]
  enabled?: boolean
  ownerState: PromptTemplateOwnerStateSnapshot
}

export interface ServerSplitPresetPatchLocalEffectPayload {
  revision: number
  presetKind: 'model' | 'prompt'
  presetId: string
  attemptedPatch: Record<string, unknown>
  preset: Record<string, unknown>
  attemptedSettings: Record<string, unknown>
  settings: Record<string, unknown>
  selectedProjectionApplied: boolean
  ownerProjectionApplied: boolean
}

export interface ServerLoadoutMutationLocalEffectPayload {
  revision: number
  operation: 'create' | 'delete' | 'favorite' | 'touch'
  loadoutId: string
}

export interface ServerLorebookMutationLocalEffectPayload {
  revision: number
  scope: 'global' | 'character' | 'chat'
  operation: 'replace' | 'upsert' | 'delete' | 'reorder'
  lorebookId?: string
  characterId?: string
  chatId?: string
}

export interface ServerGlobalLorebookMutationLocalEffectPayload {
  revision: number
  operation: 'create' | 'update' | 'delete' | 'reorder' | 'select'
  lorebookId?: string
  lorebookIds?: readonly string[]
  selectedLorebookId?: string | null
}

export interface ServerCharacterRowMutationLocalEffectPayload {
  revision: number
  characterId: string
  targetId: string
}

export interface ServerCharacterOrderLocalEffectPayload {
  revision: number
  attemptedOrder: readonly unknown[]
}

export type ServerResourceStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SettingsResourceState {
  value: ServerSettingsValues
  revision: number | null
  fullRevision: number | null
  shellRevision: number | null
  pointerValueRevisions: Record<'characterOrder' | 'currentChar', number | null>
  enabledModulesRevision: number | null
  loreBookPageRevision: number | null
  groupRevisions: Partial<Record<SettingsGroup, number>>
  groupStatuses: Partial<Record<SettingsGroup, ServerResourceStatus>>
  groupErrors: Partial<Record<SettingsGroup, string>>
  standaloneRevisions: Partial<Record<ServerStandaloneSettingName, number>>
  standaloneStatuses: Partial<Record<ServerStandaloneSettingName, ServerResourceStatus>>
  standaloneErrors: Partial<Record<ServerStandaloneSettingName, string>>
  status: ServerResourceStatus
  error: string | null
}

export interface CollectionsResourceState {
  values: Partial<ServerCollectionValues>
  revision: number | null
  fullRevision: number | null
  revisions: Partial<Record<ServerCollectionName, number>>
  status: ServerResourceStatus
  statuses: Partial<Record<ServerCollectionName, ServerResourceStatus>>
  error: string | null
  errors: Partial<Record<ServerCollectionName, string>>
}

export interface CharactersResourceState {
  characters: character[]
  characterOrder: Database['characterOrder']
  currentChar: number
  revision: number | null
  listRevision: number | null
  orderRevision: number | null
  selectionRevision: number | null
  rowRevisions: Record<string, number>
  status: ServerResourceStatus
  rowStatuses: Record<string, ServerResourceStatus>
  error: string | null
  rowErrors: Record<string, string>
}

export const settingsResourceState = $state<SettingsResourceState>({
  value: {},
  revision: null,
  fullRevision: null,
  shellRevision: null,
  pointerValueRevisions: {
    characterOrder: null,
    currentChar: null,
  },
  enabledModulesRevision: null,
  loreBookPageRevision: null,
  groupRevisions: {},
  groupStatuses: {},
  groupErrors: {},
  standaloneRevisions: {},
  standaloneStatuses: {},
  standaloneErrors: {},
  status: 'idle',
  error: null,
})

export const collectionsResourceState = $state<CollectionsResourceState>({
  values: {},
  revision: null,
  fullRevision: null,
  revisions: {},
  status: 'idle',
  statuses: {},
  error: null,
  errors: {},
})

export const charactersResourceState = $state<CharactersResourceState>({
  characters: [],
  characterOrder: [],
  currentChar: -1,
  revision: null,
  listRevision: null,
  orderRevision: null,
  selectionRevision: null,
  rowRevisions: {},
  status: 'idle',
  rowStatuses: {},
  error: null,
  rowErrors: {},
})

export interface HypaV3PresetOwnerStateSnapshot {
  hypaV3Presets: Database['hypaV3Presets']
  selectedHypaV3PresetId: string | null
  /** Derived compatibility projection. Never use this field as preset identity. */
  hypaV3PresetId: number
}

export type HypaV3PresetOwnerStateDraft = Omit<HypaV3PresetOwnerStateSnapshot, 'hypaV3PresetId'>

/**
 * Read the canonical Hypa V3 preset collection and stable selection together.
 * Missing, duplicate, unknown, or numerically inconsistent owners fail closed;
 * normal reads never repair rows or fall back to the numeric projection.
 */
export function getHypaV3PresetOwnerStateSnapshot(): HypaV3PresetOwnerStateSnapshot | null {
  if (hypaV3PresetOwnerHasResourceError()) return null

  const hypaV3Presets = collectionsResourceState.values.hypaV3Presets
  const settings = settingsResourceState.value as Record<string, unknown>
  if (!Array.isArray(hypaV3Presets) || !isUniquePresetCollection(hypaV3Presets)) return null

  const selectedHypaV3PresetId = settings.selectedHypaV3PresetId
  if (selectedHypaV3PresetId !== null && !nonEmptyString(selectedHypaV3PresetId)) return null
  const stableSelectedHypaV3PresetId = selectedHypaV3PresetId as string | null
  const hypaV3PresetId = hypaV3PresetIndexFromStableId({
    selectedHypaV3PresetId: stableSelectedHypaV3PresetId,
    hypaV3Presets,
  })
  if (
    (hypaV3Presets.length === 0 ? selectedHypaV3PresetId !== null || hypaV3PresetId !== -1 : hypaV3PresetId === -1) ||
    settings.hypaV3PresetId !== hypaV3PresetId
  ) {
    return null
  }

  return {
    hypaV3Presets: cloneJsonValue(hypaV3Presets) as Database['hypaV3Presets'],
    selectedHypaV3PresetId: stableSelectedHypaV3PresetId,
    hypaV3PresetId,
  }
}

/**
 * Apply one optimistic Hypa V3 owner mutation atomically. The callback edits a
 * detached draft with stable identity only; commit derives the numeric
 * compatibility projection from the resulting unique collection.
 */
export function updateHypaV3PresetOwnerState(mutator: (draft: HypaV3PresetOwnerStateDraft) => boolean | void): boolean {
  const current = getHypaV3PresetOwnerStateSnapshot()
  if (!current) return false

  const draft: HypaV3PresetOwnerStateDraft = {
    hypaV3Presets: cloneJsonValue(current.hypaV3Presets),
    selectedHypaV3PresetId: current.selectedHypaV3PresetId,
  }
  if (mutator(draft) === false || !isUniquePresetCollection(draft.hypaV3Presets)) return false
  if (draft.selectedHypaV3PresetId !== null && !nonEmptyString(draft.selectedHypaV3PresetId)) return false

  const hypaV3PresetId = hypaV3PresetIndexFromStableId(draft)
  if (
    draft.hypaV3Presets.length === 0
      ? draft.selectedHypaV3PresetId !== null || hypaV3PresetId !== -1
      : hypaV3PresetId === -1
  ) {
    return false
  }

  collectionsResourceState.values.hypaV3Presets = cloneJsonValue(draft.hypaV3Presets)
  const settings = settingsResourceState.value as Record<string, unknown>
  settings.selectedHypaV3PresetId = draft.selectedHypaV3PresetId
  settings.hypaV3PresetId = hypaV3PresetId
  return true
}

function hypaV3PresetOwnerHasResourceError(): boolean {
  return (
    settingsResourceState.status === 'error' ||
    settingsResourceState.groupStatuses.memory === 'error' ||
    collectionsResourceState.statuses.hypaV3Presets === 'error'
  )
}

export interface PersonaOwnerStateSnapshot {
  personas: Database['personas']
  selectedPersonaId: string | null
  /** Derived compatibility projection. Never use this field as persona identity. */
  selectedPersona: number
  username: string
  userIcon: string
  personaPrompt: string
  userNote: string
}

export type PersonaOwnerStateDraft = Omit<PersonaOwnerStateSnapshot, 'selectedPersona'>

/**
 * Read the canonical persona collection and stable selection owner together.
 * Missing, duplicate, mismatched, or errored owners fail closed; normal reads
 * never repair rows or fall back to the legacy numeric pointer.
 */
export function getPersonaOwnerStateSnapshot(): PersonaOwnerStateSnapshot | null {
  if (personaOwnerHasResourceError()) return null

  const personas = collectionsResourceState.values.personas
  const settings = settingsResourceState.value as Record<string, unknown>
  if (!Array.isArray(personas) || !isUniquePresetCollection(personas)) return null

  const selectedPersonaId = settings.selectedPersonaId
  if (selectedPersonaId !== null && !nonEmptyString(selectedPersonaId)) return null
  const stableSelectedPersonaId = selectedPersonaId as string | null
  const selectedPersona = personaSelectionIndex(personas, stableSelectedPersonaId)
  if (
    (personas.length === 0 ? selectedPersonaId !== null || selectedPersona !== -1 : selectedPersona === -1) ||
    settings.selectedPersona !== selectedPersona ||
    typeof settings.username !== 'string' ||
    typeof settings.userIcon !== 'string' ||
    typeof settings.personaPrompt !== 'string' ||
    typeof settings.userNote !== 'string'
  ) {
    return null
  }

  return {
    personas: cloneJsonValue(personas) as Database['personas'],
    selectedPersonaId: stableSelectedPersonaId,
    selectedPersona,
    username: settings.username,
    userIcon: settings.userIcon,
    personaPrompt: settings.personaPrompt,
    userNote: settings.userNote,
  }
}

/**
 * Apply one optimistic persona-owner mutation atomically. The callback edits a
 * detached draft that exposes only stable selection identity; commit derives
 * the numeric compatibility pointer from the resulting unique rows.
 */
export function updatePersonaOwnerState(mutator: (draft: PersonaOwnerStateDraft) => boolean | void): boolean {
  const current = getPersonaOwnerStateSnapshot()
  if (!current) return false

  const draft: PersonaOwnerStateDraft = {
    personas: cloneJsonValue(current.personas),
    selectedPersonaId: current.selectedPersonaId,
    username: current.username,
    userIcon: current.userIcon,
    personaPrompt: current.personaPrompt,
    userNote: current.userNote,
  }
  if (mutator(draft) === false || !isUniquePresetCollection(draft.personas)) return false
  if (draft.selectedPersonaId !== null && !nonEmptyString(draft.selectedPersonaId)) return false

  const selectedPersona = personaSelectionIndex(draft.personas, draft.selectedPersonaId)
  if (
    (draft.personas.length === 0
      ? draft.selectedPersonaId !== null || selectedPersona !== -1
      : selectedPersona === -1) ||
    typeof draft.username !== 'string' ||
    typeof draft.userIcon !== 'string' ||
    typeof draft.personaPrompt !== 'string' ||
    typeof draft.userNote !== 'string'
  ) {
    return false
  }

  collectionsResourceState.values.personas = cloneJsonValue(draft.personas)
  const settings = settingsResourceState.value as Record<string, unknown>
  settings.selectedPersonaId = draft.selectedPersonaId
  settings.selectedPersona = selectedPersona
  settings.username = draft.username
  settings.userIcon = draft.userIcon
  settings.personaPrompt = draft.personaPrompt
  settings.userNote = draft.userNote
  return true
}

/**
 * Reassert one retained optimistic create across a split collection refresh.
 * The row and stable selection were already captured by the durable attempt;
 * this only restores that exact row and re-derives the numeric projection.
 */
export function reassertPendingPersonaOwnerRow(persona: Database['personas'][number]): boolean {
  if (personaOwnerHasResourceError() || !isPlainRecord(persona) || !nonEmptyString(persona.id)) return false
  const personas = collectionsResourceState.values.personas
  const settings = settingsResourceState.value as Record<string, unknown>
  if (!Array.isArray(personas) || !isUniquePresetCollection(personas)) return false
  if (personas.some((candidate) => isPlainRecord(candidate) && candidate.id === persona.id)) return false

  const selectedPersonaId = settings.selectedPersonaId
  if (selectedPersonaId !== null && !nonEmptyString(selectedPersonaId)) return false
  const stableSelectedPersonaId = selectedPersonaId as string | null
  if (
    typeof settings.username !== 'string' ||
    typeof settings.userIcon !== 'string' ||
    typeof settings.personaPrompt !== 'string' ||
    typeof settings.userNote !== 'string'
  ) {
    return false
  }

  const nextPersonas = [...personas, cloneJsonValue(persona)]
  if (!isUniquePresetCollection(nextPersonas)) return false
  const selectedPersona = personaSelectionIndex(nextPersonas, stableSelectedPersonaId)
  if (selectedPersona === -1) return false

  collectionsResourceState.values.personas = nextPersonas as Database['personas']
  settings.selectedPersona = selectedPersona
  return true
}

function personaOwnerHasResourceError(): boolean {
  return (
    settingsResourceState.status === 'error' ||
    settingsResourceState.groupStatuses.account === 'error' ||
    settingsResourceState.standaloneStatuses.selectedPersonaId === 'error' ||
    settingsResourceState.standaloneStatuses.selectedPersona === 'error' ||
    settingsResourceState.standaloneStatuses.personaPrompt === 'error' ||
    settingsResourceState.standaloneStatuses.userIcon === 'error' ||
    settingsResourceState.standaloneStatuses.userNote === 'error' ||
    collectionsResourceState.statuses.personas === 'error'
  )
}

function personaSelectionIndex(personas: readonly unknown[], selectedPersonaId: string | null): number {
  if (!selectedPersonaId) return -1
  let selectedIndex = -1
  for (let index = 0; index < personas.length; index += 1) {
    const persona = personas[index]
    if (!isPlainRecord(persona) || persona.id !== selectedPersonaId) continue
    if (selectedIndex !== -1) return -1
    selectedIndex = index
  }
  return selectedIndex
}

/**
 * Read-only owner boundary for chat metadata consumers. This deliberately
 * projects scalar display metadata instead of exposing the chat record, whose
 * message and other body fields remain owned by their dedicated projections.
 */
export function getChatMetadataOwnerState(chatId: string): ChatMetadataOwnerState | undefined {
  if (!nonEmptyString(chatId)) return undefined

  let match: ChatMetadataOwnerState | undefined
  for (const character of charactersResourceState.characters) {
    for (const chat of character.chats ?? []) {
      if (chat?.id !== chatId) continue
      if (match) return undefined
      match = projectChatMetadata(chatId, chat)
    }
  }
  return match
}

// Chat metadata is intentionally a closed, scalar owner surface. Keep this
// list in sync with the fields the metadata owner is allowed to persist; do
// not widen it into a generic chat/database snapshot.
export const CHAT_METADATA_OWNER_KEYS = [
  'name',
  'note',
  'sdData',
  'lastMemory',
  'hypaContextTruncationAcknowledged',
  'suggestMessages',
  'bindedPersona',
  'fmIndex',
  'selectedDraftHookId',
  'translatorPresetId',
  'autoTranslate',
  'autoTranslateBotOnly',
  'bilingualDisplay',
  'bilingualEmphasis',
  'folderId',
  'lastDate',
  'bookmarks',
  'bookmarkNames',
  'modules',
  'pinned',
] as const

export const CHAT_FOLDER_METADATA_OWNER_KEYS = ['name', 'color', 'folded'] as const

export type ChatMetadataOwnerKey = (typeof CHAT_METADATA_OWNER_KEYS)[number]
export type ChatFolderMetadataOwnerKey = (typeof CHAT_FOLDER_METADATA_OWNER_KEYS)[number]
export type ChatMetadataOwnerFields = Partial<Record<ChatMetadataOwnerKey, unknown>>
export type ChatFolderMetadataOwnerFields = Partial<Record<ChatFolderMetadataOwnerKey, unknown>>

export interface ChatMetadataOwnerSnapshot {
  characterId: string
  chatId: string
  metadata: ChatMetadataOwnerFields
  projectionEpoch: number
  revision: number | null
}

export interface ChatFolderMetadataOwnerSnapshot {
  characterId: string
  folderId: string
  metadata: ChatFolderMetadataOwnerFields
  projectionEpoch: number
  revision: number | null
}

export type ChatScriptstateOwnerValue = string | number | boolean

export interface ChatScriptstateOwnerSnapshot {
  characterId: string
  chatId: string
  scriptstate: Record<string, ChatScriptstateOwnerValue> | undefined
  projectionEpoch: number
  revision: number | null
}

/** Read one uniquely-owned chat metadata row without exposing transcript data. */
export function getChatMetadataOwnerSnapshot(
  characterId: string,
  chatId: string,
): ChatMetadataOwnerSnapshot | undefined {
  const character = getCharacterResourceOwner(characterId)
  const chat = uniqueChatOwner(character, chatId)
  if (!character || !chat) return undefined
  return {
    characterId,
    chatId,
    metadata: snapshotOwnerFields(chat as unknown as Record<string, unknown>, CHAT_METADATA_OWNER_KEYS),
    projectionEpoch: captureCharacterRowProjectionEpoch(characterId),
    revision: charactersResourceState.rowRevisions[characterId] ?? null,
  }
}

/** Read one uniquely-owned chat-folder metadata row without exposing chat bodies. */
export function getChatFolderMetadataOwnerSnapshot(
  characterId: string,
  folderId: string,
): ChatFolderMetadataOwnerSnapshot | undefined {
  const character = getCharacterResourceOwner(characterId)
  const folder = uniqueFolderOwner(character, folderId)
  if (!character || !folder) return undefined
  return {
    characterId,
    folderId,
    metadata: snapshotOwnerFields(folder as unknown as Record<string, unknown>, CHAT_FOLDER_METADATA_OWNER_KEYS),
    projectionEpoch: captureCharacterRowProjectionEpoch(characterId),
    revision: charactersResourceState.rowRevisions[characterId] ?? null,
  }
}

/** Read one uniquely-owned chat scriptstate map without exposing the chat row. */
export function getChatScriptstateOwnerSnapshot(
  characterId: string,
  chatId: string,
): ChatScriptstateOwnerSnapshot | undefined {
  const chat = uniqueGlobalChatOwner(characterId, chatId)
  if (!chat) return undefined
  return {
    characterId,
    chatId,
    scriptstate: chat.scriptstate ? { ...chat.scriptstate } : undefined,
    projectionEpoch: captureCharacterRowProjectionEpoch(characterId),
    revision: charactersResourceState.rowRevisions[characterId] ?? null,
  }
}

/** Apply one optimistic scriptstate value to its exact stable-id chat owner. */
export function applyChatScriptstateOwnerValue(
  characterId: string,
  chatId: string,
  key: string,
  value: ChatScriptstateOwnerValue,
): boolean {
  if (!nonEmptyString(key) || !isChatScriptstateOwnerValue(value)) return false
  const chat = uniqueGlobalChatOwner(characterId, chatId)
  if (!chat || chat.scriptstate?.[key] === value) return false
  chat.scriptstate ??= {}
  chat.scriptstate[key] = value
  advanceCharacterRowProjectionEpoch(characterId)
  return true
}

/** Apply a closed-set optimistic chat metadata patch to its unique owner. */
export function applyChatMetadataOwnerPatch(
  characterId: string,
  chatId: string,
  patch: ChatMetadataOwnerFields,
): boolean {
  const character = getCharacterResourceOwner(characterId)
  const chat = uniqueChatOwner(character, chatId)
  if (!character || !chat || !hasOnlyOwnerFields(patch, CHAT_METADATA_OWNER_KEYS)) return false
  applyOwnerFields(chat as unknown as Record<string, unknown>, patch, CHAT_METADATA_OWNER_KEYS)
  advanceCharacterRowProjectionEpoch(characterId)
  return true
}

/** Restore a failed optimistic chat metadata patch only if its attempted fields still match. */
export function restoreChatMetadataOwnerSnapshot(snapshot: {
  characterId: string
  chatId: string
  metadata: ChatMetadataOwnerFields
  attempted?: ChatMetadataOwnerFields
}): boolean {
  const character = getCharacterResourceOwner(snapshot.characterId)
  const chat = uniqueChatOwner(character, snapshot.chatId)
  if (
    !character ||
    !chat ||
    !hasOnlyOwnerFields(snapshot.metadata, CHAT_METADATA_OWNER_KEYS) ||
    (snapshot.attempted !== undefined && !hasOnlyOwnerFields(snapshot.attempted, CHAT_METADATA_OWNER_KEYS))
  ) {
    return false
  }
  const target = chat as unknown as Record<string, unknown>
  if (
    snapshot.attempted &&
    Object.entries(snapshot.attempted).some(([key, value]) => !ownerFieldMatches(target, key, value))
  ) {
    return false
  }
  if (snapshot.attempted) {
    restoreAttemptedOwnerFields(target, snapshot.metadata, snapshot.attempted, CHAT_METADATA_OWNER_KEYS)
  } else {
    applyOwnerFields(target, snapshot.metadata, CHAT_METADATA_OWNER_KEYS, true)
  }
  advanceCharacterRowProjectionEpoch(snapshot.characterId)
  return true
}

/** Apply a closed-set optimistic chat-folder metadata patch to its unique owner. */
export function applyChatFolderMetadataOwnerPatch(
  characterId: string,
  folderId: string,
  patch: ChatFolderMetadataOwnerFields,
): boolean {
  const character = getCharacterResourceOwner(characterId)
  const folder = uniqueFolderOwner(character, folderId)
  if (!character || !folder || !hasOnlyOwnerFields(patch, CHAT_FOLDER_METADATA_OWNER_KEYS)) return false
  applyOwnerFields(folder as unknown as Record<string, unknown>, patch, CHAT_FOLDER_METADATA_OWNER_KEYS)
  advanceCharacterRowProjectionEpoch(characterId)
  return true
}

/** Restore a failed optimistic chat-folder metadata patch only if still current. */
export function restoreChatFolderMetadataOwnerSnapshot(snapshot: {
  characterId: string
  folderId: string
  metadata: ChatFolderMetadataOwnerFields
  attempted?: ChatFolderMetadataOwnerFields
}): boolean {
  const character = getCharacterResourceOwner(snapshot.characterId)
  const folder = uniqueFolderOwner(character, snapshot.folderId)
  if (
    !character ||
    !folder ||
    !hasOnlyOwnerFields(snapshot.metadata, CHAT_FOLDER_METADATA_OWNER_KEYS) ||
    (snapshot.attempted !== undefined && !hasOnlyOwnerFields(snapshot.attempted, CHAT_FOLDER_METADATA_OWNER_KEYS))
  ) {
    return false
  }
  const target = folder as unknown as Record<string, unknown>
  if (
    snapshot.attempted &&
    Object.entries(snapshot.attempted).some(([key, value]) => !ownerFieldMatches(target, key, value))
  ) {
    return false
  }
  if (snapshot.attempted) {
    restoreAttemptedOwnerFields(target, snapshot.metadata, snapshot.attempted, CHAT_FOLDER_METADATA_OWNER_KEYS)
  } else {
    applyOwnerFields(target, snapshot.metadata, CHAT_FOLDER_METADATA_OWNER_KEYS, true)
  }
  advanceCharacterRowProjectionEpoch(snapshot.characterId)
  return true
}

function uniqueChatOwner(character: character | undefined, chatId: string): character['chats'][number] | undefined {
  if (!character || !nonEmptyString(chatId)) return undefined
  const matches = (character.chats ?? []).filter((chat) => chat?.id === chatId)
  return matches.length === 1 ? matches[0] : undefined
}

function uniqueGlobalChatOwner(characterId: string, chatId: string): character['chats'][number] | undefined {
  const character = getCharacterResourceOwner(characterId)
  if (!character || !nonEmptyString(chatId)) return undefined

  let match: character['chats'][number] | undefined
  let owner: character | undefined
  for (const candidate of charactersResourceState.characters) {
    for (const chat of candidate.chats ?? []) {
      if (chat?.id !== chatId) continue
      if (match) return undefined
      match = chat
      owner = candidate
    }
  }
  return owner === character ? match : undefined
}

function isChatScriptstateOwnerValue(value: unknown): value is ChatScriptstateOwnerValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function uniqueFolderOwner(
  character: character | undefined,
  folderId: string,
): NonNullable<character['chatFolders']>[number] | undefined {
  if (!character || !nonEmptyString(folderId)) return undefined
  const matches = (character.chatFolders ?? []).filter((folder) => folder?.id === folderId)
  return matches.length === 1 ? matches[0] : undefined
}

function snapshotOwnerFields(target: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(target, key) && target[key] !== undefined) {
      snapshot[key] = cloneJsonValue(target[key])
    }
  }
  return snapshot
}

function hasOnlyOwnerFields(patch: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(patch).every((key) => allowed.has(key))
}

function applyOwnerFields(
  target: Record<string, unknown>,
  fields: Record<string, unknown>,
  keys: readonly string[],
  deleteMissing = false,
): void {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      const value = fields[key]
      if (value === undefined) delete target[key]
      else target[key] = cloneJsonValue(value)
    } else if (deleteMissing) {
      delete target[key]
    }
  }
}

function restoreAttemptedOwnerFields(
  target: Record<string, unknown>,
  metadata: Record<string, unknown>,
  attempted: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(attempted, key)) continue
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      applyOwnerFields(target, { [key]: metadata[key] }, [key])
    } else {
      delete target[key]
    }
  }
}

function ownerFieldMatches(target: Record<string, unknown>, key: string, expected: unknown): boolean {
  const present = Object.prototype.hasOwnProperty.call(target, key) && target[key] !== undefined
  if (expected === undefined) return !present
  return present && JSON.stringify(target[key]) === JSON.stringify(expected)
}

const collectionNameSet = new Set<string>(SERVER_COLLECTION_NAMES)

export function isServerCollectionName(value: string): value is ServerCollectionName {
  return collectionNameSet.has(value)
}

export function beginSettingsResourceLoad(): void {
  settingsResourceState.status = 'loading'
  settingsResourceState.error = null
}

export function failSettingsResourceLoad(error: string): void {
  settingsResourceState.status = 'error'
  settingsResourceState.error = error
}

export function beginSettingsGroupResourceLoad(group: SettingsGroup): void {
  settingsResourceState.groupStatuses[group] = 'loading'
  delete settingsResourceState.groupErrors[group]
}

export function failSettingsGroupResourceLoad(group: SettingsGroup, error: string): void {
  settingsResourceState.groupStatuses[group] = 'error'
  settingsResourceState.groupErrors[group] = error
}

export function applySettingsResource(payload: ServerSettingsResourcePayload): boolean {
  if (isOlderRevision(payload.revision, settingsResourceState.fullRevision)) return false
  if (isOlderRevision(payload.revision, settingsResourceState.shellRevision)) return false
  if (Object.values(settingsResourceState.groupRevisions).some((revision) => revision > payload.revision)) return false
  if (Object.values(settingsResourceState.standaloneRevisions).some((revision) => revision > payload.revision)) {
    return false
  }
  const preserveEnabledModules = (settingsResourceState.enabledModulesRevision ?? -1) > payload.revision
  const liveEnabledModules = preserveEnabledModules
    ? cloneJsonValue((settingsResourceState.value as Record<string, unknown>).enabledModules)
    : undefined
  const preserveLoreBookPage = (settingsResourceState.loreBookPageRevision ?? -1) > payload.revision
  const liveSettings = settingsResourceState.value as Record<string, unknown>
  const runtimeProjectionKeys = Array.from(new Set([...Object.keys(liveSettings), ...Object.keys(payload.settings)]))
  const hasLiveLoreBookPage = Object.prototype.hasOwnProperty.call(liveSettings, 'loreBookPage')
  const liveLoreBookPage = preserveLoreBookPage ? cloneJsonValue(liveSettings.loreBookPage) : undefined
  recordReaderPersonaSettings(payload.settings)
  recordReaderNavigationSettings(payload.settings)
  settingsResourceState.value = cloneJsonValue(payload.settings)
  if (preserveEnabledModules) {
    ;(settingsResourceState.value as Record<string, unknown>).enabledModules = liveEnabledModules
  }
  if (preserveLoreBookPage) {
    if (hasLiveLoreBookPage) {
      ;(settingsResourceState.value as Record<string, unknown>).loreBookPage = liveLoreBookPage
    } else {
      delete (settingsResourceState.value as Record<string, unknown>).loreBookPage
    }
  }
  applyPendingSettingsProjectionOverlays(settingsResourceState.value as Record<string, unknown>)
  settingsResourceState.revision =
    preserveEnabledModules || preserveLoreBookPage
      ? maxRevision(settingsResourceState.revision, payload.revision)
      : payload.revision
  settingsResourceState.fullRevision = payload.revision
  settingsResourceState.shellRevision = payload.revision
  settingsResourceState.pointerValueRevisions.characterOrder = payload.revision
  settingsResourceState.pointerValueRevisions.currentChar = payload.revision
  settingsResourceState.enabledModulesRevision = preserveEnabledModules
    ? settingsResourceState.enabledModulesRevision
    : null
  settingsResourceState.loreBookPageRevision = preserveLoreBookPage ? settingsResourceState.loreBookPageRevision : null
  settingsResourceState.groupRevisions = {}
  settingsResourceState.groupStatuses = Object.fromEntries(SETTINGS_GROUPS.map((group) => [group, 'ready'])) as Partial<
    Record<SettingsGroup, ServerResourceStatus>
  >
  settingsResourceState.groupErrors = {}
  settingsResourceState.standaloneRevisions = Object.fromEntries(
    SERVER_STANDALONE_SETTING_NAMES.map((setting) => [
      setting,
      setting === 'loreBookPage' && preserveLoreBookPage
        ? settingsResourceState.loreBookPageRevision
        : payload.revision,
    ]),
  ) as Partial<Record<ServerStandaloneSettingName, number>>
  settingsResourceState.standaloneStatuses = Object.fromEntries(
    SERVER_STANDALONE_SETTING_NAMES.map((setting) => [setting, 'ready']),
  ) as Partial<Record<ServerStandaloneSettingName, ServerResourceStatus>>
  settingsResourceState.standaloneErrors = {}
  settingsResourceState.status = 'ready'
  settingsResourceState.error = null
  applyRuntimeLanguage(settingsResourceState.value.language)
  applySettingsRuntimeProjectionEffects(runtimeProjectionKeys)
  advanceAllSettingsProjectionEpochs()
  advanceSettingsProjectionEpoch({ authoritativeFull: true })
  if (!preserveLoreBookPage) advanceLorebookPageProjectionEpoch()
  invalidateModuleRenderRevision()
  return true
}

export interface ServerShellSettingsResourcePayload {
  revision: number
  settings: ServerShellSettings
}

export function canApplyShellSettingsResource(payload: ServerShellSettingsResourcePayload): boolean {
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0 || !isServerShellSettings(payload.settings)) {
    return false
  }
  const knownRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.shellRevision ?? -1,
    ...Object.values(settingsResourceState.groupRevisions).map((revision) => revision ?? -1),
  )
  return payload.revision >= knownRevision
}

/** Merge only the exact shell allowlist without claiming a complete settings group. */
export function applyShellSettingsResource(payload: ServerShellSettingsResourcePayload): boolean {
  if (!canApplyShellSettingsResource(payload)) return false

  const target = settingsResourceState.value as Record<string, unknown>
  recordReaderPersonaSettings(payload.settings, SERVER_SHELL_SETTINGS_KEYS)
  recordReaderNavigationSettings(payload.settings, SERVER_SHELL_SETTINGS_KEYS)
  for (const key of SERVER_SHELL_SETTINGS_KEYS) target[key] = cloneJsonValue(payload.settings[key])
  applyPendingSettingsProjectionOverlays(target, new Set(SERVER_SHELL_SETTINGS_KEYS))
  settingsResourceState.shellRevision = payload.revision
  settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
  settingsResourceState.status = 'ready'
  settingsResourceState.error = null
  applyRuntimeLanguage(target.language)
  applySettingsRuntimeProjectionEffects(SERVER_SHELL_SETTINGS_KEYS)
  for (const settingsGroup of new Set(
    SERVER_SHELL_SETTINGS_KEYS.map((key) => SERVER_SETTINGS_GROUP_BY_KEY[key]).filter(
      (candidate): candidate is SettingsGroup => candidate !== undefined,
    ),
  )) {
    advanceSettingsGroupProjectionEpoch(settingsGroup)
  }
  advanceSettingsProjectionEpoch()
  return true
}

export function beginStandaloneSettingResourceLoad(setting: ServerStandaloneSettingName): void {
  settingsResourceState.standaloneStatuses[setting] = 'loading'
  delete settingsResourceState.standaloneErrors[setting]
}

export function failStandaloneSettingResourceLoad(setting: ServerStandaloneSettingName, error: string): void {
  settingsResourceState.standaloneStatuses[setting] = 'error'
  settingsResourceState.standaloneErrors[setting] = error
}

/** Apply one legacy top-level value without claiming a complete settings group. */
export function applyStandaloneSettingResource(payload: ServerStandaloneSettingPayload): boolean {
  const currentRevision = Math.max(
    settingsResourceState.revision ?? -1,
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.standaloneRevisions[payload.setting] ?? -1,
    payload.setting === 'loreBookPage' ? (settingsResourceState.loreBookPageRevision ?? -1) : -1,
  )
  if (payload.revision < currentRevision) return false

  const target = settingsResourceState.value as Record<string, unknown>
  if (payload.state.present) target[payload.setting] = cloneJsonValue(payload.state.value)
  else delete target[payload.setting]
  recordReaderPersonaSettings(target, [payload.setting])
  recordReaderNavigationSettings(target, [payload.setting])
  applyPendingSettingsProjectionOverlays(target, new Set([payload.setting]))
  settingsResourceState.standaloneRevisions[payload.setting] = payload.revision
  settingsResourceState.standaloneStatuses[payload.setting] = 'ready'
  delete settingsResourceState.standaloneErrors[payload.setting]
  settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
  if (payload.setting === 'loreBookPage') {
    settingsResourceState.loreBookPageRevision = payload.revision
    advanceLorebookPageProjectionEpoch()
  }
  advanceSettingsProjectionEpoch()
  return true
}

export function applySettingsGroupResource(
  payload: ServerSettingsGroupResourcePayload,
  groupKeys: readonly string[],
): boolean {
  const sharedModelProfileRevision = isModelProfileSettingsGroup(payload.group)
    ? Math.max(settingsResourceState.groupRevisions.providers ?? -1, settingsResourceState.groupRevisions.models ?? -1)
    : -1
  const currentRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.shellRevision ?? -1,
    settingsResourceState.groupRevisions[payload.group] ?? -1,
    sharedModelProfileRevision,
    payload.group === 'modules' ? (settingsResourceState.enabledModulesRevision ?? -1) : -1,
  )
  if (payload.revision < currentRevision) return false

  const target = settingsResourceState.value as Record<string, unknown>
  const incoming = payload.settings as Record<string, unknown>
  for (const key of groupKeys) {
    if (key === 'hypaV3Presets') continue
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      target[key] = cloneJsonValue(incoming[key])
    } else {
      delete target[key]
    }
  }
  recordReaderPersonaSettings(incoming, groupKeys)
  recordReaderNavigationSettings(incoming, groupKeys)
  applyPendingSettingsProjectionOverlays(target, new Set(groupKeys))
  settingsResourceState.groupRevisions[payload.group] = payload.revision
  settingsResourceState.groupStatuses[payload.group] = 'ready'
  delete settingsResourceState.groupErrors[payload.group]
  if (payload.group === 'providers') settingsResourceState.groupRevisions.models = payload.revision
  if (payload.group === 'providers') settingsResourceState.groupStatuses.models = 'ready'
  if (payload.group === 'modules') settingsResourceState.enabledModulesRevision = payload.revision
  settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
  settingsResourceState.status = 'ready'
  settingsResourceState.error = null
  if (groupKeys.includes('language')) applyRuntimeLanguage(target.language)
  applySettingsRuntimeProjectionEffects(groupKeys)
  advanceSettingsGroupProjectionEpoch(payload.group)
  if (payload.group === 'providers') advanceSettingsGroupProjectionEpoch('models')
  if (payload.group === 'models') {
    advanceSettingsGroupProjectionEpoch('providers', { preserveAcknowledgementTaint: true })
  }
  advanceSettingsProjectionEpoch()
  if (payload.group === 'modules' || payload.group === 'advanced' || payload.group === 'agents') {
    invalidateModuleRenderRevision()
  }
  return true
}

/**
 * Apply the canonical keys returned by an accepted settings command without
 * re-reading the complete settings group. A later queued edit may already be
 * visible, so canonicalize a key only while its live value still matches the
 * value sent by this command; either way, advance the relevant revision fence.
 */
export function applySettingsPatchLocalEffect(payload: ServerSettingsPatchLocalEffectPayload): boolean {
  const attemptedKeys = Object.keys(payload.attemptedPatch).sort()
  const canonicalKeys = Object.keys(payload.settings).sort()
  if (attemptedKeys.length === 0 || !isJsonValueEqual(attemptedKeys, canonicalKeys)) return false

  const writesHypaV3Presets = attemptedKeys.includes('hypaV3Presets')
  const knownSettingsRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.groupRevisions[payload.group] ?? -1,
  )
  const knownHypaV3PresetsRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.hypaV3Presets ?? -1,
  )
  if (
    knownSettingsRevision >= payload.revision &&
    (!writesHypaV3Presets || knownHypaV3PresetsRevision >= payload.revision)
  ) {
    return true
  }

  recordReaderPersonaSettings(payload.settings, canonicalKeys)
  recordReaderNavigationSettings(payload.settings, canonicalKeys)
  const settingsTarget = settingsResourceState.value as Record<string, unknown>
  const previousLanguage = settingsTarget.language
  for (const key of attemptedKeys) {
    if (key === 'hypaV3Presets') {
      if (isJsonValueEqual(collectionsResourceState.values.hypaV3Presets, payload.attemptedPatch[key])) {
        collectionsResourceState.values.hypaV3Presets = cloneJsonValue(payload.settings[key]) as never
      }
      continue
    }
    if (isJsonValueEqual(settingsTarget[key], payload.attemptedPatch[key])) {
      settingsTarget[key] = cloneJsonValue(payload.settings[key])
    }
  }
  // The optimistic setting handler already selected this locale. An unchanged
  // acknowledgement must not retry a failed import behind its error dialog.
  if (attemptedKeys.includes('language') && settingsTarget.language !== previousLanguage) {
    applyRuntimeLanguage(settingsTarget.language)
  }
  applySettingsRuntimeProjectionEffects(attemptedKeys)

  if (knownSettingsRevision < payload.revision) {
    settingsResourceState.groupRevisions[payload.group] = payload.revision
    settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
    settingsResourceState.status = 'ready'
    settingsResourceState.error = null
  }
  if (writesHypaV3Presets && knownHypaV3PresetsRevision < payload.revision) {
    collectionsResourceState.revisions.hypaV3Presets = payload.revision
    collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
    collectionsResourceState.statuses.hypaV3Presets = 'ready'
    delete collectionsResourceState.errors.hypaV3Presets
  }
  return true
}

/**
 * Fence a response-confirmed optimistic plugin-storage mutation. Storage
 * values are arbitrary and potentially large, so avoid re-downloading the
 * complete map after the server accepted the exact JSON already shown locally.
 */
export function applyPluginStorageLocalEffect(payload: ServerPluginStorageLocalEffectPayload): boolean {
  const knownRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.pluginCustomStorage ?? -1,
  )
  if (knownRevision >= payload.revision) return true

  const storage = collectionsResourceState.values.pluginCustomStorage
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return false
  if (collectionsResourceState.statuses.pluginCustomStorage !== 'ready') return false

  collectionsResourceState.revisions.pluginCustomStorage = payload.revision
  collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
  collectionsResourceState.statuses.pluginCustomStorage = 'ready'
  delete collectionsResourceState.errors.pluginCustomStorage
  return true
}

/**
 * Fence a response-confirmed optimistic plugin-record mutation. Plugin scripts
 * can be large, and the browser already holds the exact accepted record or
 * ordering. Preserve any newer queued mutation while preventing older
 * collection reads from replacing it.
 */
export function applyPluginCollectionMutationLocalEffect(
  payload: ServerPluginCollectionMutationLocalEffectPayload,
): boolean {
  const knownRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.plugins ?? -1,
  )
  if (knownRevision >= payload.revision) return true

  const plugins = collectionsResourceState.values.plugins
  if (!Array.isArray(plugins) || collectionsResourceState.statuses.plugins !== 'ready') return false
  if (payload.operation === 'reorder') {
    if (!isUniqueStringArray(payload.pluginIds)) return false
  } else if (!nonEmptyString(payload.pluginId)) {
    return false
  }

  collectionsResourceState.revisions.plugins = payload.revision
  collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
  collectionsResourceState.statuses.plugins = 'ready'
  delete collectionsResourceState.errors.plugins
  return true
}

/** Fence an accepted optimistic plugin-provider selection without a settings read. */
export function applyPluginProviderLocalEffect(payload: ServerPluginProviderLocalEffectPayload): boolean {
  const knownRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.groupRevisions.providers ?? -1,
  )
  if (knownRevision >= payload.revision) return true

  const provider = (settingsResourceState.value as Record<string, unknown>).currentPluginProvider
  if (typeof provider !== 'string' || typeof payload.provider !== 'string') return false

  // A later queued provider selection may already be visible. The response
  // effect proves this earlier value was accepted, so advance the fence while
  // deliberately retaining the newer optimistic provider.

  settingsResourceState.groupRevisions.providers = payload.revision
  settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
  settingsResourceState.status = 'ready'
  settingsResourceState.error = null
  return true
}

/** Fence an accepted optimistic module-record mutation without re-downloading large module definitions. */
export function applyModuleCollectionMutationLocalEffect(
  payload: ServerModuleCollectionMutationLocalEffectPayload,
): boolean {
  const knownRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.modules ?? -1,
  )
  if (knownRevision >= payload.revision) return true

  const modules = collectionsResourceState.values.modules
  if (!isNormalizedModuleCollectionProjection(modules) || collectionsResourceState.statuses.modules !== 'ready') {
    return false
  }
  if (payload.operation === 'reorder') {
    if (!isUniqueStringArray(payload.moduleIds)) return false
  } else if (!nonEmptyString(payload.moduleId)) {
    return false
  }

  collectionsResourceState.revisions.modules = payload.revision
  collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
  collectionsResourceState.statuses.modules = 'ready'
  delete collectionsResourceState.errors.modules
  return true
}

/**
 * Fence response-confirmed optimistic top-level lorebook mutations. The list
 * and its selected-page pointer are separate server resources, so each slice
 * advances independently while retaining any newer queued optimistic value.
 */
export function applyGlobalLorebookMutationLocalEffect(
  payload: ServerGlobalLorebookMutationLocalEffectPayload,
): boolean {
  if (!isGlobalLorebookMutationOperation(payload.operation)) return false

  const changesCollection = payload.operation !== 'select'
  const changesPage =
    payload.operation === 'delete' || payload.operation === 'reorder' || payload.operation === 'select'
  if (payload.operation === 'reorder') {
    if (!isUniqueStringArray(payload.lorebookIds) || !isNullableNonEmptyString(payload.selectedLorebookId)) {
      return false
    }
    if (payload.selectedLorebookId !== null && !payload.lorebookIds.includes(payload.selectedLorebookId)) return false
  } else if (!nonEmptyString(payload.lorebookId)) {
    return false
  }
  if (payload.operation === 'select' && payload.selectedLorebookId !== payload.lorebookId) return false

  const knownCollectionRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.loreBook ?? -1,
  )
  const knownPageRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.loreBookPageRevision ?? -1,
  )
  const shouldFenceCollection = changesCollection && knownCollectionRevision < payload.revision
  const shouldFencePage = changesPage && knownPageRevision < payload.revision
  if (!shouldFenceCollection && !shouldFencePage) return true

  if (
    shouldFenceCollection &&
    (collectionsResourceState.statuses.loreBook !== 'ready' ||
      !isCanonicalGlobalLorebookCollectionProjection(collectionsResourceState.values.loreBook))
  ) {
    return false
  }
  if (shouldFencePage && !isStableGlobalLorebookPageProjection()) return false

  if (shouldFenceCollection) {
    collectionsResourceState.revisions.loreBook = payload.revision
    collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
    collectionsResourceState.statuses.loreBook = 'ready'
    delete collectionsResourceState.errors.loreBook
  }
  if (shouldFencePage) {
    settingsResourceState.loreBookPageRevision = payload.revision
    settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
    settingsResourceState.status = 'ready'
    settingsResourceState.error = null
  }
  return true
}

/**
 * Fence an accepted optimistic lorebook-entry mutation. The owner already
 * contains the accepted collection (and may contain a newer queued edit), so
 * only advance the owning resource revision after validating the live target.
 */
export function applyLorebookMutationLocalEffect(payload: ServerLorebookMutationLocalEffectPayload): boolean {
  if (!isLorebookMutationOperation(payload.operation)) return false

  if (payload.scope === 'global') {
    const knownRevision = Math.max(
      collectionsResourceState.fullRevision ?? -1,
      collectionsResourceState.revisions.loreBook ?? -1,
    )
    if (knownRevision >= payload.revision) return true
    if (
      collectionsResourceState.statuses.loreBook !== 'ready' ||
      !nonEmptyString(payload.lorebookId) ||
      !isCanonicalGlobalLorebookTarget(payload.lorebookId)
    ) {
      return false
    }

    collectionsResourceState.revisions.loreBook = payload.revision
    collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
    collectionsResourceState.statuses.loreBook = 'ready'
    delete collectionsResourceState.errors.loreBook
    return true
  }

  if (!nonEmptyString(payload.characterId)) return false
  const knownRevision = Math.max(
    charactersResourceState.listRevision ?? -1,
    charactersResourceState.rowRevisions[payload.characterId] ?? -1,
  )
  if (knownRevision >= payload.revision) return true
  if (charactersResourceState.rowStatuses[payload.characterId] !== 'ready') return false

  const targetIsCanonical =
    payload.scope === 'character'
      ? payload.chatId === undefined && isCanonicalCharacterLorebookTarget(payload.characterId)
      : nonEmptyString(payload.chatId) && isCanonicalChatLorebookTarget(payload.characterId, payload.chatId)
  if (!targetIsCanonical) return false

  charactersResourceState.rowRevisions[payload.characterId] = payload.revision
  charactersResourceState.rowStatuses[payload.characterId] = 'ready'
  delete charactersResourceState.rowErrors[payload.characterId]
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  if (payload.scope === 'character') {
    markCharacterLorebookBodyResourceRevision(payload.characterId, payload.revision)
    markCharacterLorebookProjectionApplied(payload.characterId)
  }
  return true
}

/** Fence one accepted optimistic enabledModules membership write without a full settings read. */
export function applyModuleEnabledLocalEffect(payload: ServerModuleEnabledLocalEffectPayload): boolean {
  const knownRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.enabledModulesRevision ?? -1,
  )
  if (knownRevision >= payload.revision) return true
  if (!nonEmptyString(payload.moduleId) || typeof payload.enabled !== 'boolean') return false

  const enabledModules = (settingsResourceState.value as Record<string, unknown>).enabledModules
  if (settingsResourceState.status !== 'ready' || !isUniqueStringArray(enabledModules)) {
    return false
  }

  settingsResourceState.enabledModulesRevision = payload.revision
  settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
  settingsResourceState.status = 'ready'
  settingsResourceState.error = null
  return true
}

/**
 * Fence an accepted optimistic prompt-owner mutation without replacing its
 * resident body. Each write only validates its canonical structural outcome;
 * unrelated row fields may already contain later accepted optimistic edits.
 * Every ambiguous command failure taints the owner before a later response can
 * take this path.
 */
export function applyPromptItemMutationLocalEffect(payload: ServerPromptItemMutationLocalEffectPayload): boolean {
  if (
    (payload.promptPresetId !== null && !nonEmptyString(payload.promptPresetId)) ||
    !isPromptItemMutationOperation(payload.operation) ||
    !isCanonicalPromptTemplateOwnerState(payload.ownerState) ||
    !promptItemMutationMatchesOwnerState(payload)
  ) {
    return false
  }

  const collectionName: ServerCollectionName = payload.promptPresetId === null ? 'promptTemplate' : 'promptPresets'
  const liveOwnerState = readCanonicalLivePromptTemplateOwnerState(payload.promptPresetId)
  if (!liveOwnerState || !livePromptTemplateOwnerSupportsOperation(payload, liveOwnerState)) return false
  if (
    collectionsResourceState.status !== 'ready' ||
    (payload.ownerState.enabled && collectionsResourceState.statuses[collectionName] !== 'ready') ||
    (payload.promptPresetId !== null && collectionsResourceState.statuses.promptPresets !== 'ready')
  ) {
    return false
  }

  const knownRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions[collectionName] ?? -1,
  )
  if (knownRevision >= payload.revision) return true

  collectionsResourceState.revisions[collectionName] = payload.revision
  collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
  collectionsResourceState.statuses[collectionName] = 'ready'
  delete collectionsResourceState.errors[collectionName]
  return true
}

/**
 * Apply a response-confirmed split-preset field PATCH without re-reading the
 * complete collection and, when selected fields were projected, settings.
 * Canonical values only replace this attempt while its exact optimistic value
 * is still live, preserving a later coalesced edit to the same field. A prompt
 * owner receipt applies only to the prompt-preset row; the aggregate
 * `promptTemplate` resource remains a compatibility projection.
 */
export function applySplitPresetPatchLocalEffect(payload: ServerSplitPresetPatchLocalEffectPayload): boolean {
  if (!nonEmptyString(payload.presetId) || (payload.presetKind !== 'model' && payload.presetKind !== 'prompt')) {
    return false
  }
  const attemptedKeys = Object.keys(payload.attemptedPatch).sort()
  if (
    attemptedKeys.length === 0 ||
    !isJsonValueEqual(attemptedKeys, Object.keys(payload.preset).sort()) ||
    !isJsonValueEqual(Object.keys(payload.attemptedSettings).sort(), Object.keys(payload.settings).sort())
  ) {
    return false
  }

  const collectionName: ServerCollectionName = payload.presetKind === 'model' ? 'modelPresets' : 'promptPresets'
  const presets = collectionsResourceState.values[collectionName]
  if (!Array.isArray(presets) || collectionsResourceState.statuses[collectionName] !== 'ready') return false
  const matches = presets.filter(
    (candidate) => isPlainRecord(candidate) && candidate.id === payload.presetId,
  ) as Record<string, unknown>[]
  if (matches.length !== 1 || !isUniquePresetCollection(presets)) return false
  if (collectionsResourceState.revisions[collectionName] === undefined) return false

  if (payload.selectedProjectionApplied) {
    if (settingsResourceState.status !== 'ready' || settingsResourceState.fullRevision === null) return false
  } else if (Object.keys(payload.attemptedSettings).length > 0) {
    return false
  }

  if (payload.ownerProjectionApplied) {
    if (
      payload.presetKind !== 'prompt' ||
      !Object.prototype.hasOwnProperty.call(payload.attemptedPatch, 'promptTemplate') ||
      !Object.prototype.hasOwnProperty.call(payload.preset, 'promptTemplate')
    ) {
      return false
    }
  }

  const preset = matches[0]
  for (const key of attemptedKeys) {
    if (isJsonValueEqual(preset[key], payload.attemptedPatch[key])) {
      preset[key] = cloneJsonValue(payload.preset[key])
    }
  }

  if (payload.selectedProjectionApplied) {
    const settings = settingsResourceState.value as Record<string, unknown>
    for (const key of Object.keys(payload.attemptedSettings)) {
      if (isJsonValueEqual(settings[key], payload.attemptedSettings[key])) {
        settings[key] = cloneJsonValue(payload.settings[key])
      }
    }
    settingsResourceState.fullRevision = payload.revision
    settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
    settingsResourceState.status = 'ready'
    settingsResourceState.error = null
  }

  collectionsResourceState.revisions[collectionName] = payload.revision
  collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
  collectionsResourceState.statuses[collectionName] = 'ready'
  delete collectionsResourceState.errors[collectionName]
  return true
}

/**
 * Fence a response-certified optimistic legacy/model preset reorder. The live
 * order and selected numeric pointer may already contain a later queued
 * reorder, so validate stable membership/selection and advance only the
 * resource revisions written by this accepted command.
 */
export function applyPresetReorderLocalEffect(payload: ServerPresetReorderLocalEffectPayload): boolean {
  if (
    !Number.isInteger(payload.revision) ||
    payload.revision < 0 ||
    (payload.presetKind !== 'legacy' && payload.presetKind !== 'model') ||
    !isUniqueStringArray(payload.presetIds) ||
    (payload.selectedPresetId !== null &&
      (!nonEmptyString(payload.selectedPresetId) || !payload.presetIds.includes(payload.selectedPresetId))) ||
    typeof payload.settingsWritten !== 'boolean'
  ) {
    return false
  }

  const collectionName: ServerCollectionName = payload.presetKind === 'legacy' ? 'botPresets' : 'modelPresets'
  const selectedSettingsKey = payload.presetKind === 'legacy' ? 'botPresetsId' : 'modelPresetsId'
  const knownCollectionRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions[collectionName] ?? -1,
  )
  const knownSettingsRevision = settingsResourceState.fullRevision ?? -1
  if (
    knownCollectionRevision >= payload.revision &&
    (!payload.settingsWritten || knownSettingsRevision >= payload.revision)
  ) {
    return true
  }

  const presets = collectionsResourceState.values[collectionName]
  if (
    collectionsResourceState.statuses[collectionName] !== 'ready' ||
    collectionsResourceState.revisions[collectionName] === undefined ||
    !Array.isArray(presets) ||
    !isUniquePresetCollection(presets) ||
    presets.length !== payload.presetIds.length
  ) {
    return false
  }
  const livePresetIds = presets.map((preset) => (preset as Record<string, unknown>).id as string)
  if (livePresetIds.some((presetId) => !payload.presetIds.includes(presetId))) return false

  const settings = settingsResourceState.value as Record<string, unknown>
  const selectedIndex = settings[selectedSettingsKey]
  if (
    settingsResourceState.status !== 'ready' ||
    settingsResourceState.fullRevision === null ||
    !Number.isInteger(selectedIndex) ||
    (presets.length === 0
      ? selectedIndex !== -1 || payload.selectedPresetId !== null
      : (selectedIndex as number) < 0 ||
        (selectedIndex as number) >= presets.length ||
        (presets[selectedIndex as number] as Record<string, unknown>).id !== payload.selectedPresetId)
  ) {
    return false
  }

  if (knownCollectionRevision < payload.revision) {
    collectionsResourceState.revisions[collectionName] = payload.revision
    collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
    collectionsResourceState.statuses[collectionName] = 'ready'
    delete collectionsResourceState.errors[collectionName]
  }
  if (payload.settingsWritten && knownSettingsRevision < payload.revision) {
    settingsResourceState.fullRevision = payload.revision
    settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
    settingsResourceState.status = 'ready'
    settingsResourceState.error = null
  }
  return true
}

/** Fence an accepted optimistic loadout mutation without re-reading the collection or settings. */
export function applyLoadoutMutationLocalEffect(payload: ServerLoadoutMutationLocalEffectPayload): boolean {
  if (!nonEmptyString(payload.loadoutId)) return false
  if (!['create', 'delete', 'favorite', 'touch'].includes(payload.operation)) return false

  const loadouts = collectionsResourceState.values.loadouts
  if (collectionsResourceState.statuses.loadouts !== 'ready' || !isCanonicalLoadoutCollection(loadouts)) {
    return false
  }
  if (
    payload.operation === 'touch' &&
    (settingsResourceState.status !== 'ready' ||
      typeof (settingsResourceState.value as Record<string, unknown>).lastLoadedLoadoutName !== 'string')
  ) {
    return false
  }

  const knownCollectionRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.loadouts ?? -1,
  )
  const knownSettingsRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.groupRevisions.sidebar ?? -1,
  )
  let changed = false
  if (knownCollectionRevision < payload.revision) {
    collectionsResourceState.revisions.loadouts = payload.revision
    collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
    collectionsResourceState.statuses.loadouts = 'ready'
    delete collectionsResourceState.errors.loadouts
    changed = true
  }
  if (payload.operation === 'touch' && knownSettingsRevision < payload.revision) {
    settingsResourceState.groupRevisions.sidebar = payload.revision
    settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
    settingsResourceState.status = 'ready'
    settingsResourceState.error = null
    changed = true
  }
  return true
}

export function beginCollectionsResourceLoad(name?: ServerCollectionName): void {
  if (name) {
    collectionsResourceState.statuses[name] = 'loading'
    delete collectionsResourceState.errors[name]
    return
  }
  collectionsResourceState.status = 'loading'
  collectionsResourceState.error = null
}

export function failCollectionsResourceLoad(error: string, name?: ServerCollectionName): void {
  if (name) {
    collectionsResourceState.statuses[name] = 'error'
    collectionsResourceState.errors[name] = error
    return
  }
  collectionsResourceState.status = 'error'
  collectionsResourceState.error = error
}

export function applyCollectionsResource(
  payload: ServerCollectionsResourcePayload,
  requestedName?: ServerCollectionName,
): boolean {
  const names = requestedName
    ? [requestedName]
    : SERVER_COLLECTION_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(payload.collections, name))
  if (requestedName && !Object.prototype.hasOwnProperty.call(payload.collections, requestedName)) return false

  let applied = false
  const appliedNames: ServerCollectionName[] = []
  for (const name of names) {
    if (isOlderRevision(payload.revision, collectionsResourceState.revisions[name] ?? null)) continue
    if (name === 'personas') recordReaderPersonas(payload.collections.personas)
    collectionsResourceState.values[name] = cloneJsonValue(payload.collections[name]) as never
    collectionsResourceState.revisions[name] = payload.revision
    collectionsResourceState.statuses[name] = 'ready'
    delete collectionsResourceState.errors[name]
    advanceCollectionProjectionEpoch(name)
    appliedNames.push(name)
    applied = true
  }

  if (appliedNames.length > 0) {
    applyPendingSettingsProjectionOverlays(
      collectionsResourceState.values as unknown as Record<string, unknown>,
      new Set(appliedNames),
    )
  }

  if (!requestedName && !isOlderRevision(payload.revision, collectionsResourceState.fullRevision)) {
    collectionsResourceState.fullRevision = payload.revision
    collectionsResourceState.status = 'ready'
    collectionsResourceState.error = null
  }
  if (applied) {
    collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
  }
  if (appliedNames.some((name) => name === 'modules' || name === 'personas' || name === 'promptPresets')) {
    invalidateModuleRenderRevision()
  }
  return applied
}

/**
 * Snapshot the resident legacy-preset rows that a targeted read may replace.
 * Fields edited while the read is in flight are retained when its response is
 * reconciled, instead of being rewound to the request-time server value.
 */
export function captureLegacyPresetResourceBaseline(
  presetIds: readonly (string | undefined)[],
): ServerLegacyPresetResourceBaseline {
  const requestedIds = new Set(presetIds.filter(nonEmptyString))
  const baseline = new Map<string, Record<string, unknown>>()
  const presets = collectionsResourceState.values.botPresets
  if (!Array.isArray(presets)) return baseline

  for (const candidate of presets) {
    if (!isPlainRecord(candidate) || !nonEmptyString(candidate.id) || !requestedIds.has(candidate.id)) continue
    baseline.set(candidate.id, cloneJsonValue(candidate))
  }
  return baseline
}

/** Apply one authoritative hydrated legacy-preset row by stable id. */
export function applyLegacyPresetRowResource(payload: ServerLegacyPresetRowResourcePayload): boolean {
  const currentRevision = collectionsResourceState.revisions.botPresets ?? null
  if (isOlderRevision(payload.revision, currentRevision)) return false
  if (!nonEmptyString(payload.presetId) || payload.preset.id !== payload.presetId) return false

  const presets = collectionsResourceState.values.botPresets
  if (!Array.isArray(presets)) return false
  const currentById = uniqueLegacyPresetRowsById(presets)
  if (!currentById) return false
  const current = currentById.get(payload.presetId)
  if (!current) return false

  const next = overlayConcurrentLegacyPresetFields(payload.preset, current, payload.baseline?.get(payload.presetId))
  collectionsResourceState.values.botPresets = presets.map((candidate) =>
    isPlainRecord(candidate) && candidate.id === payload.presetId ? next : candidate,
  ) as never
  markLegacyPresetCollectionApplied(payload.revision)
  return true
}

/**
 * Apply only response-confirmed canonical legacy-preset fields while fencing
 * the accepted row revision. This acknowledgement deliberately does not
 * advance the collection projection epoch or clear its taint; only an
 * authoritative collection/row projection can do that.
 */
export function applyLegacyPresetPatchLocalEffect(payload: ServerLegacyPresetPatchLocalEffectPayload): boolean {
  if (
    !Number.isInteger(payload.revision) ||
    payload.revision < 0 ||
    !nonEmptyString(payload.presetId) ||
    !isPlainRecord(payload.fields)
  ) {
    return false
  }
  for (const [key, field] of Object.entries(payload.fields)) {
    if (
      !nonEmptyString(key) ||
      key === 'id' ||
      !isPlainRecord(field) ||
      !isCanonicalJsonFieldState(field.attempted) ||
      !isCanonicalJsonFieldState(field.canonical)
    ) {
      return false
    }
  }

  const knownRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.botPresets ?? -1,
  )
  if (knownRevision >= payload.revision) return true
  if (
    collectionsResourceState.statuses.botPresets !== 'ready' ||
    collectionsResourceState.revisions.botPresets === undefined
  ) {
    return false
  }

  const presets = collectionsResourceState.values.botPresets
  if (!Array.isArray(presets) || !isUniquePresetCollection(presets)) return false
  const matches = presets.filter((candidate) => isPlainRecord(candidate) && candidate.id === payload.presetId)
  if (matches.length !== 1) return false
  const preset = matches[0] as unknown as Record<string, unknown>

  for (const [key, field] of Object.entries(payload.fields)) {
    if (!jsonFieldStateMatches(preset, key, field.attempted)) continue
    if (field.canonical.present) preset[key] = cloneJsonValue(field.canonical.value)
    else delete preset[key]
  }

  collectionsResourceState.revisions.botPresets = payload.revision
  collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
  collectionsResourceState.statuses.botPresets = 'ready'
  delete collectionsResourceState.errors.botPresets
  return true
}

/**
 * Fence a response-confirmed persona PATCH without re-reading the complete
 * persona collection or settings row. The optimistic row and legacy mirror
 * are already resident; advancing only their revision fences preserves any
 * later local edits. Authoritative reads alone advance projection epochs and
 * clear acknowledgement taints. The reader owner accepts only fields certified
 * by this receipt and never copies the newer optimistic row.
 */
export function applyPersonaPatchLocalEffect(payload: ServerPersonaPatchLocalEffectPayload): boolean {
  const legacyKeys = ['username', 'userIcon', 'personaPrompt', 'userNote'] as const
  const attemptedPatchKeys = isPlainRecord(payload.attemptedPatch) ? Object.keys(payload.attemptedPatch) : []
  if (
    !Number.isInteger(payload.revision) ||
    payload.revision < 0 ||
    !nonEmptyString(payload.personaId) ||
    !isPlainRecord(payload.attemptedPatch) ||
    attemptedPatchKeys.length === 0 ||
    !isJsonValue(payload.attemptedPatch) ||
    !isPlainRecord(payload.attemptedPersona) ||
    !isJsonValue(payload.attemptedPersona) ||
    payload.attemptedPersona.id !== payload.personaId ||
    !isPlainRecord(payload.attemptedLegacyProfile) ||
    !isJsonValueEqual(Object.keys(payload.attemptedLegacyProfile).sort(), [...legacyKeys].sort()) ||
    legacyKeys.some((key) => typeof payload.attemptedLegacyProfile[key] !== 'string') ||
    typeof payload.legacyProfileProjectionApplied !== 'boolean' ||
    attemptedPatchKeys.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(payload.attemptedPersona, key) ||
        !isJsonValueEqual(payload.attemptedPersona[key], payload.attemptedPatch[key]),
    )
  ) {
    return false
  }

  if (payload.legacyProfileProjectionApplied) {
    const expectedLegacyProfile = {
      username: typeof payload.attemptedPersona.name === 'string' ? payload.attemptedPersona.name : '',
      userIcon: typeof payload.attemptedPersona.icon === 'string' ? payload.attemptedPersona.icon : '',
      personaPrompt:
        typeof payload.attemptedPersona.personaPrompt === 'string' ? payload.attemptedPersona.personaPrompt : '',
      userNote: typeof payload.attemptedPersona.note === 'string' ? payload.attemptedPersona.note : '',
    }
    if (legacyKeys.some((key) => payload.attemptedLegacyProfile[key] !== expectedLegacyProfile[key])) return false
  }

  const knownCollectionRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.personas ?? -1,
  )
  const knownSettingsRevision = settingsResourceState.fullRevision ?? -1
  if (
    knownCollectionRevision >= payload.revision &&
    (!payload.legacyProfileProjectionApplied || knownSettingsRevision >= payload.revision)
  ) {
    return true
  }

  const personas = collectionsResourceState.values.personas
  if (
    collectionsResourceState.statuses.personas !== 'ready' ||
    collectionsResourceState.revisions.personas === undefined ||
    !Array.isArray(personas) ||
    !isUniquePresetCollection(personas)
  ) {
    return false
  }
  const matches = personas.filter((candidate) => isPlainRecord(candidate) && candidate.id === payload.personaId)
  // A later optimistic delete can remove this row before the accepted PATCH
  // response is reconciled. The receipt only fences revisions and never
  // reapplies fields, so zero matches is safe; duplicates remain ambiguous.
  if (matches.length > 1) return false

  if (
    payload.legacyProfileProjectionApplied &&
    (settingsResourceState.status !== 'ready' ||
      settingsResourceState.fullRevision === null ||
      !getPersonaOwnerStateSnapshot())
  ) {
    return false
  }

  if (
    knownCollectionRevision < payload.revision &&
    !recordReaderPersonaPatch(payload.personaId, payload.attemptedPatch)
  ) {
    requireReaderPersonaRefresh({ collection: true })
  }
  if (payload.legacyProfileProjectionApplied && knownSettingsRevision < payload.revision) {
    recordReaderPersonaSettings(payload.attemptedLegacyProfile, ['username', 'userIcon'])
  }

  collectionsResourceState.revisions.personas = payload.revision
  collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
  collectionsResourceState.statuses.personas = 'ready'
  delete collectionsResourceState.errors.personas

  if (payload.legacyProfileProjectionApplied) {
    settingsResourceState.fullRevision = payload.revision
    settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
    settingsResourceState.status = 'ready'
    settingsResourceState.error = null
  }
  return true
}

/**
 * Fence the exact slices written by an accepted optimistic persona structure
 * mutation. The response certificate already proved the final ordering,
 * selection, and any saved/mirrored profile, so retain newer optimistic values
 * and advance only the collection/settings revisions the server actually wrote.
 * The compact effect carries no certified values for the independent reader
 * owner, which refreshes those slices when a reader needs them.
 */
export function applyPersonaMutationLocalEffect(payload: ServerPersonaMutationLocalEffectPayload): boolean {
  if (
    !Number.isInteger(payload.revision) ||
    payload.revision < 0 ||
    !['create', 'delete', 'select', 'reorder'].includes(payload.operation) ||
    typeof payload.collectionWritten !== 'boolean' ||
    typeof payload.settingsWritten !== 'boolean' ||
    !payload.settingsWritten ||
    ((payload.operation === 'create' || payload.operation === 'delete' || payload.operation === 'reorder') &&
      !payload.collectionWritten)
  ) {
    return false
  }

  const knownCollectionRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.personas ?? -1,
  )
  const knownSettingsRevision = settingsResourceState.fullRevision ?? -1
  if (
    (payload.collectionWritten || payload.settingsWritten) &&
    (!payload.collectionWritten || knownCollectionRevision >= payload.revision) &&
    (!payload.settingsWritten || knownSettingsRevision >= payload.revision)
  ) {
    return true
  }

  const personas = collectionsResourceState.values.personas
  if (
    collectionsResourceState.statuses.personas !== 'ready' ||
    collectionsResourceState.revisions.personas === undefined ||
    !Array.isArray(personas) ||
    !isUniquePresetCollection(personas)
  ) {
    return false
  }

  if (!getPersonaOwnerStateSnapshot()) return false
  if (
    payload.settingsWritten &&
    (settingsResourceState.status !== 'ready' || settingsResourceState.fullRevision === null)
  ) {
    return false
  }

  let changed = false
  if (payload.collectionWritten && knownCollectionRevision < payload.revision) {
    requireReaderPersonaRefresh({ collection: true })
    collectionsResourceState.revisions.personas = payload.revision
    collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
    collectionsResourceState.statuses.personas = 'ready'
    delete collectionsResourceState.errors.personas
    changed = true
  }
  if (payload.settingsWritten && knownSettingsRevision < payload.revision) {
    requireReaderPersonaRefresh({ settings: true })
    settingsResourceState.fullRevision = payload.revision
    settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
    settingsResourceState.status = 'ready'
    settingsResourceState.error = null
    changed = true
  }
  return true
}

/**
 * Fence both tables written by one accepted translator-preset PATCH. The
 * optimistic canonical row is already resident, so this advances only the
 * collection and language-group revision fences. Projection epochs and
 * acknowledgement taints remain owned by authoritative reads.
 */
export function applyTranslatorPresetPatchLocalEffect(payload: ServerTranslatorPresetPatchLocalEffectPayload): boolean {
  const attemptedKeys = isPlainRecord(payload.attemptedPatch) ? Object.keys(payload.attemptedPatch).sort() : []
  const allowedKeys = new Set(['name', 'prompt', 'maxResponse', 'steps'])
  if (
    !Number.isInteger(payload.revision) ||
    payload.revision < 0 ||
    !nonEmptyString(payload.presetId) ||
    !nonEmptyString(payload.selectedPresetId) ||
    !isPlainRecord(payload.attemptedPatch) ||
    attemptedKeys.length === 0 ||
    attemptedKeys.some((key) => !allowedKeys.has(key) || !isJsonValue(payload.attemptedPatch[key])) ||
    !isCanonicalTranslatorPresetRecord(payload.attemptedPreset) ||
    payload.attemptedPreset.id !== payload.presetId ||
    attemptedKeys.some((key) => !isJsonValueEqual(payload.attemptedPreset[key], payload.attemptedPatch[key]))
  ) {
    return false
  }

  const presets = collectionsResourceState.values.translatorPresets
  const settings = settingsResourceState.value as Record<string, unknown>
  const knownCollectionRevision = Math.max(
    collectionsResourceState.fullRevision ?? -1,
    collectionsResourceState.revisions.translatorPresets ?? -1,
  )
  const knownLanguageRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.groupRevisions.language ?? -1,
  )
  if (
    collectionsResourceState.statuses.translatorPresets !== 'ready' ||
    collectionsResourceState.revisions.translatorPresets === undefined ||
    settingsResourceState.status !== 'ready' ||
    knownLanguageRevision < 0 ||
    !Array.isArray(presets) ||
    !isCanonicalTranslatorPresetCollection(presets)
  ) {
    return false
  }

  const targetMatches = presets.filter((preset) => preset.id === payload.presetId)
  const selectedPresetId = settings.translatorPresetId
  const selectedMatches =
    typeof selectedPresetId === 'string' ? presets.filter((preset) => preset.id === selectedPresetId) : []
  if (
    targetMatches.length !== 1 ||
    selectedMatches.length !== 1 ||
    selectedMatches[0].id !== payload.selectedPresetId
  ) {
    return false
  }

  if (knownCollectionRevision < payload.revision) {
    collectionsResourceState.revisions.translatorPresets = payload.revision
    collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, payload.revision)
    collectionsResourceState.statuses.translatorPresets = 'ready'
    delete collectionsResourceState.errors.translatorPresets
  }
  if (knownLanguageRevision < payload.revision) {
    settingsResourceState.groupRevisions.language = payload.revision
    settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
    settingsResourceState.status = 'ready'
    settingsResourceState.error = null
  }
  return true
}

/**
 * Fence an exact, response-confirmed Agent Preset reorder/default mutation. The
 * optimistic collection/default projection is already resident; retain it only
 * while its canonical identities still match the certified response receipt.
 */
export function applyAgentPresetCollectionMutationLocalEffect(
  payload: ServerAgentPresetCollectionMutationLocalEffectPayload,
): boolean {
  if (
    !Number.isInteger(payload.revision) ||
    payload.revision < 0 ||
    (payload.operation !== 'reorder' && payload.operation !== 'default') ||
    !isUniqueStringArray(payload.presetIds) ||
    (payload.agentPresetDefaultId !== null &&
      (!nonEmptyString(payload.agentPresetDefaultId) || !payload.presetIds.includes(payload.agentPresetDefaultId)))
  ) {
    return false
  }

  const knownRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.groupRevisions.agents ?? -1,
  )
  if (knownRevision >= payload.revision) return true
  const settings = settingsResourceState.value as Record<string, unknown>
  const presets = settings.agentPresets
  if (
    settingsResourceState.status !== 'ready' ||
    knownRevision < 0 ||
    !Array.isArray(presets) ||
    !isUniqueAgentPresetProjection(presets) ||
    !presets.every((preset) => isPlainRecord(preset) && isCanonicalValidAgentPreset(preset)) ||
    !isJsonValueEqual(
      presets.map((preset) => (preset as Record<string, unknown>).id),
      payload.presetIds,
    )
  ) {
    return false
  }

  const rawDefaultId = settings.agentPresetDefaultId
  const currentDefaultId = rawDefaultId === undefined ? null : nonEmptyString(rawDefaultId) ? rawDefaultId : undefined
  if (currentDefaultId === undefined || currentDefaultId !== payload.agentPresetDefaultId) return false

  settingsResourceState.groupRevisions.agents = payload.revision
  settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
  settingsResourceState.status = 'ready'
  settingsResourceState.error = null
  return true
}

/**
 * Apply response-confirmed Agent Preset fields while fencing only the read-only
 * `agents` settings projection. Field-state comparisons retain a newer local
 * edit to the same field; the server-owned timestamp advances independently.
 * Authoritative settings reads alone advance projection epochs or clear taint.
 */
export function applyAgentPresetPatchLocalEffect(payload: ServerAgentPresetPatchLocalEffectPayload): boolean {
  return applyAgentPresetFieldPatchLocalEffect(payload)
}

export function applyAgentPresetStepPatchLocalEffect(payload: ServerAgentPresetStepPatchLocalEffectPayload): boolean {
  return applyAgentPresetFieldPatchLocalEffect(payload)
}

function applyAgentPresetFieldPatchLocalEffect(
  payload: ServerAgentPresetPatchLocalEffectPayload | ServerAgentPresetStepPatchLocalEffectPayload,
): boolean {
  const isStepPatch = 'stepId' in payload
  const allowedKeys = isStepPatch
    ? new Set([
        'name',
        'enabled',
        'phase',
        'dependencies',
        'instruction',
        'model',
        'runtime',
        'inputScopes',
        'outputKey',
        'outputFormat',
        'destination',
        'failurePolicy',
      ])
    : new Set(['name', 'description', 'moduleIntergration', 'finalOutputTemplate', 'enabled', 'maxConcurrency'])
  const fieldEntries = isPlainRecord(payload.fields) ? Object.entries(payload.fields) : []
  if (
    !Number.isInteger(payload.revision) ||
    payload.revision < 0 ||
    !nonEmptyString(payload.presetId) ||
    (isStepPatch && !nonEmptyString(payload.stepId)) ||
    fieldEntries.length === 0 ||
    typeof payload.updatedAt !== 'number' ||
    !Number.isFinite(payload.updatedAt) ||
    payload.updatedAt < 0
  ) {
    return false
  }
  for (const [key, field] of fieldEntries) {
    if (
      !allowedKeys.has(key) ||
      !isPlainRecord(field) ||
      !isCanonicalJsonFieldState(field.attempted) ||
      !isCanonicalJsonFieldState(field.canonical) ||
      (isStepPatch && !field.canonical.present) ||
      (!isStepPatch &&
        !field.canonical.present &&
        key !== 'description' &&
        key !== 'moduleIntergration' &&
        key !== 'finalOutputTemplate' &&
        key !== 'maxConcurrency')
    ) {
      return false
    }
  }

  const knownRevision = Math.max(
    settingsResourceState.fullRevision ?? -1,
    settingsResourceState.groupRevisions.agents ?? -1,
  )
  if (knownRevision >= payload.revision) return true
  const settings = settingsResourceState.value as Record<string, unknown>
  const presets = settings.agentPresets
  if (
    settingsResourceState.status !== 'ready' ||
    knownRevision < 0 ||
    !Array.isArray(presets) ||
    !isUniqueAgentPresetProjection(presets)
  ) {
    return false
  }

  const presetIndexes = presets.flatMap((candidate, index) =>
    isPlainRecord(candidate) && candidate.id === payload.presetId ? [index] : [],
  )
  if (presetIndexes.length !== 1) return false
  const presetIndex = presetIndexes[0]
  const preset = presets[presetIndex] as Record<string, unknown>
  const nextPreset = cloneJsonValue(preset)
  let target = preset
  let nextTarget = nextPreset
  if (isStepPatch) {
    const steps = preset.steps
    const nextSteps = nextPreset.steps
    if (!Array.isArray(steps) || !Array.isArray(nextSteps)) return false
    const stepIndexes = steps.flatMap((candidate, index) =>
      isPlainRecord(candidate) && candidate.id === payload.stepId ? [index] : [],
    )
    if (stepIndexes.length !== 1) return false
    const stepIndex = stepIndexes[0]
    target = steps[stepIndex] as Record<string, unknown>
    nextTarget = nextSteps[stepIndex] as Record<string, unknown>
  }

  for (const [key, field] of fieldEntries) {
    if (!jsonFieldStateMatches(target, key, field.attempted)) continue
    if (field.canonical.present) nextTarget[key] = cloneJsonValue(field.canonical.value)
    else delete nextTarget[key]
  }
  nextPreset.updatedAt = payload.updatedAt
  if (isStepPatch && !isCanonicalValidAgentPreset(nextPreset)) return false
  presets[presetIndex] = nextPreset
  settingsResourceState.groupRevisions.agents = payload.revision
  settingsResourceState.revision = maxRevision(settingsResourceState.revision, payload.revision)
  settingsResourceState.status = 'ready'
  settingsResourceState.error = null
  return true
}

function isCanonicalValidAgentPreset(value: Record<string, unknown>): boolean {
  const normalized = normalizeAgentPresets([value])
  return (
    normalized.length === 1 &&
    isJsonValueEqual(value, normalized[0]) &&
    validateAgentPresetRecord(normalized[0]).length === 0
  )
}

function isUniqueAgentPresetProjection(value: readonly unknown[]): boolean {
  const presetIds = new Set<string>()
  for (const candidate of value) {
    if (!isPlainRecord(candidate) || !nonEmptyString(candidate.id) || presetIds.has(candidate.id)) return false
    presetIds.add(candidate.id)
    if (!Array.isArray(candidate.steps)) return false
    const stepIds = new Set<string>()
    for (const step of candidate.steps) {
      if (!isPlainRecord(step) || !nonEmptyString(step.id) || stepIds.has(step.id)) return false
      stepIds.add(step.id)
    }
  }
  return true
}

/**
 * Reconcile authoritative legacy-preset membership and shell metadata while
 * retaining already-hydrated bodies for rows that did not change.
 */
export function applyLegacyPresetCollectionResource(payload: ServerLegacyPresetCollectionResourcePayload): boolean {
  const currentRevision = collectionsResourceState.revisions.botPresets ?? null
  if (isOlderRevision(payload.revision, currentRevision)) return false

  const shellsById = uniqueLegacyPresetRowsById(payload.shells)
  const changedById = uniqueLegacyPresetRowsById(payload.presetRows)
  const currentPresets = collectionsResourceState.values.botPresets
  const currentById = Array.isArray(currentPresets) ? uniqueLegacyPresetRowsById(currentPresets) : new Map()
  if (!shellsById || !changedById || !currentById) return false
  for (const presetId of changedById.keys()) {
    if (!shellsById.has(presetId)) return false
  }

  const nextPresets = payload.shells.map((candidate) => {
    const shell = candidate as Record<string, unknown>
    const presetId = shell.id as string
    const changed = changedById.get(presetId)
    const current = currentById.get(presetId)
    if (changed) {
      return overlayConcurrentLegacyPresetFields(changed, current, payload.baseline?.get(presetId))
    }
    if (current) return { ...cloneJsonValue(current), ...cloneJsonValue(shell) }
    return cloneJsonValue(shell)
  })

  collectionsResourceState.values.botPresets = nextPresets as never
  markLegacyPresetCollectionApplied(payload.revision)
  return true
}

function markLegacyPresetCollectionApplied(revision: number): void {
  collectionsResourceState.revisions.botPresets = revision
  collectionsResourceState.revision = maxRevision(collectionsResourceState.revision, revision)
  collectionsResourceState.statuses.botPresets = 'ready'
  delete collectionsResourceState.errors.botPresets
  advanceCollectionProjectionEpoch('botPresets')
}

function uniqueLegacyPresetRowsById(rows: readonly unknown[]): Map<string, Record<string, unknown>> | null {
  const byId = new Map<string, Record<string, unknown>>()
  for (const candidate of rows) {
    if (!isPlainRecord(candidate) || !nonEmptyString(candidate.id) || byId.has(candidate.id)) return null
    byId.set(candidate.id, candidate)
  }
  return byId
}

function overlayConcurrentLegacyPresetFields(
  authoritative: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  baseline: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = cloneJsonValue(authoritative)
  if (!current || !baseline) return next

  for (const key of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    if (key === 'id') continue
    const currentHasKey = Object.prototype.hasOwnProperty.call(current, key)
    const baselineHasKey = Object.prototype.hasOwnProperty.call(baseline, key)
    if (currentHasKey === baselineHasKey && isJsonValueEqual(current[key], baseline[key])) continue
    if (currentHasKey) next[key] = cloneJsonValue(current[key])
    else delete next[key]
  }
  return next
}

export function beginCharactersResourceLoad(characterId?: string): void {
  if (characterId) {
    charactersResourceState.rowStatuses[characterId] = 'loading'
    delete charactersResourceState.rowErrors[characterId]
    return
  }
  charactersResourceState.status = 'loading'
  charactersResourceState.error = null
}

export function failCharactersResourceLoad(error: string, characterId?: string): void {
  if (characterId) {
    charactersResourceState.rowStatuses[characterId] = 'error'
    charactersResourceState.rowErrors[characterId] = error
    return
  }
  charactersResourceState.status = 'error'
  charactersResourceState.error = error
}

export function applyCharactersResource(
  payload: ServerCharactersResourcePayload,
  options: { preserveResidentChatBodies?: boolean } = {},
): boolean {
  if (!canApplyCharactersResource(payload)) return false

  const preserveResidentChatBodies = options.preserveResidentChatBodies ?? true
  if (!preserveResidentChatBodies) resetCharacterBodyResourceRevisions()
  const previousCharacters = charactersResourceState.characters
  const appliedLorebookBodyIds = new Set<string>()
  const existingById = preserveResidentChatBodies
    ? new Map(
        charactersResourceState.characters
          .filter((candidate) => nonEmptyString(candidate?.chaId))
          .map((candidate) => [candidate.chaId, candidate]),
      )
    : null
  charactersResourceState.characters = payload.characters.map((candidate) => {
    const nextCharacter = cloneJsonValue(candidate)
    const existing = existingById?.get(candidate.chaId)
    if (isCharacterSummaryShell(nextCharacter)) {
      const existingRevision = charactersResourceState.rowRevisions[candidate.chaId]
      if (existing && !isCharacterSummaryShell(existing) && existingRevision === payload.revision) {
        return cloneJsonValue(existing)
      }
      return nextCharacter
    }
    const appliesLorebookBody =
      nextCharacter.globalLore !== undefined &&
      !hasNewerCharacterLorebookBodyResourceRevision(nextCharacter.chaId, payload.revision)
    if (appliesLorebookBody) appliedLorebookBodyIds.add(nextCharacter.chaId)
    return preserveResidentCharacterChatBodies(nextCharacter, existing, payload.revision)
  })
  if (preserveResidentChatBodies) {
    markRemovedCharacterBodyProjections(previousCharacters, charactersResourceState.characters)
  }
  pruneCharacterBodyResourceRevisions(charactersResourceState.characters)
  for (const characterId of appliedLorebookBodyIds) {
    markCharacterLorebookBodyResourceRevision(characterId, payload.revision)
    if (preserveResidentChatBodies) advanceCharacterLorebookBodyProjectionEpoch(characterId)
  }
  recordReaderCharacterOrder(payload.characterOrder)
  charactersResourceState.characterOrder = cloneJsonValue(payload.characterOrder)
  charactersResourceState.currentChar = payload.currentChar
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  charactersResourceState.listRevision = payload.revision
  charactersResourceState.orderRevision = payload.revision
  charactersResourceState.selectionRevision = payload.revision
  charactersResourceState.rowRevisions = Object.fromEntries(
    payload.characters
      .filter((candidate) => nonEmptyString(candidate?.chaId))
      .map((candidate) => [candidate.chaId, payload.revision]),
  )
  charactersResourceState.rowStatuses = Object.fromEntries(
    payload.characters
      .filter((candidate) => nonEmptyString(candidate?.chaId))
      .map((candidate) => [candidate.chaId, 'ready']),
  )
  charactersResourceState.rowErrors = {}
  charactersResourceState.status = 'ready'
  charactersResourceState.error = null
  advanceCharacterListProjectionEpoch()
  advanceAllCharacterRowProjectionEpochs()
  if (!preserveResidentChatBodies) advanceAllChatBodyProjectionEpochs()
  if (!preserveResidentChatBodies) advanceAllCharacterLorebookBodyProjectionEpochs()
  advanceAllCharacterLorebookProjectionEpochs()
  recordReaderCharacters(payload.characters, payload.revision)
  reapplyRetainedCharacterProjections()
  return true
}

export function canApplyCharactersResource(payload: ServerCharactersResourcePayload): boolean {
  if (payload.version !== SERVER_CHARACTER_SUMMARY_VERSION) return false
  if (isOlderRevision(payload.revision, charactersResourceState.listRevision)) return false
  if (isOlderRevision(payload.revision, charactersResourceState.orderRevision)) return false
  if (isOlderRevision(payload.revision, charactersResourceState.selectionRevision)) return false
  return !Object.values(charactersResourceState.rowRevisions).some((revision) => revision > payload.revision)
}

/**
 * Fence an accepted optimistic character create/delete without replacing the
 * live collection. Later queued list, order, or selection edits may already be
 * visible, so this only advances revision ownership after validating that the
 * local projection remains a normalized collection with the expected target.
 */
export function applyCharacterCollectionMutationLocalEffect(
  payload: ServerCharacterCollectionMutationLocalEffectPayload,
): boolean {
  if ((charactersResourceState.listRevision ?? -1) >= payload.revision) return true
  if (charactersResourceState.status !== 'ready' || !nonEmptyString(payload.characterId)) return false
  if (payload.selectedCharacterId !== null && !nonEmptyString(payload.selectedCharacterId)) return false
  if (
    payload.operation === 'createAndSelect'
      ? payload.selectedCharacterId !== payload.characterId
      : payload.selectedCharacterId === payload.characterId
  ) {
    return false
  }
  if (!isNormalizedCharacterCollectionProjection()) return false

  const targetPresent = charactersResourceState.characters.some((candidate) => candidate?.chaId === payload.characterId)
  if (payload.operation === 'delete' ? targetPresent : !targetPresent) return false

  charactersResourceState.listRevision = maxRevision(charactersResourceState.listRevision, payload.revision)
  charactersResourceState.orderRevision = maxRevision(charactersResourceState.orderRevision, payload.revision)
  charactersResourceState.selectionRevision = maxRevision(charactersResourceState.selectionRevision, payload.revision)
  charactersResourceState.rowRevisions[payload.characterId] = Math.max(
    charactersResourceState.rowRevisions[payload.characterId] ?? -1,
    payload.revision,
  )
  if (payload.operation === 'delete') {
    delete charactersResourceState.rowStatuses[payload.characterId]
    delete charactersResourceState.rowErrors[payload.characterId]
  } else {
    charactersResourceState.rowStatuses[payload.characterId] = 'ready'
    delete charactersResourceState.rowErrors[payload.characterId]
  }
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  charactersResourceState.status = 'ready'
  charactersResourceState.error = null
  return true
}

export function applyCharacterResource(payload: ServerCharacterResourcePayload): boolean {
  const characterId = payload.character?.chaId
  if (!nonEmptyString(characterId)) return false
  if (isOlderRevision(payload.revision, charactersResourceState.rowRevisions[characterId] ?? null)) return false
  if (isOlderRevision(payload.revision, charactersResourceState.listRevision)) return false

  const index = uniqueCharacterOwnerIndex(characterId)
  if (index < 0) return false
  const previousCharacter = charactersResourceState.characters[index]
  const incomingCharacter = cloneJsonValue(payload.character)
  const appliesLorebookBody =
    incomingCharacter.globalLore !== undefined &&
    !hasNewerCharacterLorebookBodyResourceRevision(characterId, payload.revision)
  const nextCharacter = preserveResidentCharacterChatBodies(incomingCharacter, previousCharacter, payload.revision)
  if (index >= 0) {
    charactersResourceState.characters[index] = nextCharacter
  } else {
    charactersResourceState.characters.push(nextCharacter)
    advanceCharacterListProjectionEpoch()
  }
  if (previousCharacter) {
    markRemovedCharacterBodyProjections([previousCharacter], [nextCharacter])
  }
  pruneCharacterBodyResourceRevisions(charactersResourceState.characters)
  if (appliesLorebookBody) {
    markCharacterLorebookBodyResourceRevision(characterId, payload.revision)
    advanceCharacterLorebookBodyProjectionEpoch(characterId)
  }
  charactersResourceState.rowRevisions[characterId] = payload.revision
  charactersResourceState.rowStatuses[characterId] = 'ready'
  delete charactersResourceState.rowErrors[characterId]
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  advanceCharacterRowProjectionEpoch(characterId)
  advanceCharacterLorebookProjectionEpoch(characterId)
  recordReaderCharacter(payload.character, payload.revision)
  reapplyRetainedCharacterProjections(characterId)
  return true
}

/** Return a character row only when its stable id identifies exactly one owner. */
export function getCharacterResourceOwner(characterId: string): character | undefined {
  const index = uniqueCharacterOwnerIndex(characterId)
  return index >= 0 ? charactersResourceState.characters[index] : undefined
}

/** Notify owner consumers after an optimistic mutation of one ready character row. */
export function markCharacterResourceOwnerChanged(characterId: string): boolean {
  if (!getCharacterResourceOwner(characterId)) return false
  advanceCharacterRowProjectionEpoch(characterId)
  return true
}

function uniqueCharacterOwnerIndex(characterId: string): number {
  let ownerIndex = -1
  for (const [index, candidate] of charactersResourceState.characters.entries()) {
    if (candidate?.chaId !== characterId) continue
    if (ownerIndex >= 0) return -1
    ownerIndex = index
  }
  return ownerIndex
}

export function applyCharacterOrderResource(payload: ServerCharacterOrderResourcePayload): boolean {
  if (isOlderRevision(payload.revision, charactersResourceState.listRevision)) return false
  if (isOlderRevision(payload.revision, charactersResourceState.orderRevision)) return false

  recordReaderCharacterOrder(payload.characterOrder)
  charactersResourceState.characterOrder = cloneJsonValue(payload.characterOrder)
  charactersResourceState.orderRevision = payload.revision
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  return true
}

/** Fence an exact optimistic character-order write without re-reading it. */
export function applyCharacterOrderLocalEffect(payload: ServerCharacterOrderLocalEffectPayload): boolean {
  const knownRevision = Math.max(
    charactersResourceState.listRevision ?? -1,
    charactersResourceState.orderRevision ?? -1,
  )
  if (knownRevision >= payload.revision) return true
  if (!Array.isArray(payload.attemptedOrder)) return false

  recordReaderCharacterOrder(payload.attemptedOrder)
  charactersResourceState.orderRevision = payload.revision
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  return true
}

export function applyCharacterSelectionResource(payload: ServerCharacterSelectionResourcePayload): boolean {
  if (isOlderRevision(payload.revision, charactersResourceState.listRevision)) return false
  if (isOlderRevision(payload.revision, charactersResourceState.selectionRevision)) return false
  if (isOlderRevision(payload.revision, charactersResourceState.rowRevisions[payload.characterId] ?? null)) return false

  const characterIndex = charactersResourceState.characters.findIndex(
    (candidate) => candidate?.chaId === payload.characterId,
  )
  if (characterIndex < 0) return false
  const selectedCharacterIndex =
    charactersResourceState.characters[payload.currentChar]?.chaId === payload.characterId
      ? payload.currentChar
      : characterIndex

  charactersResourceState.currentChar = selectedCharacterIndex
  if (typeof payload.lastInteraction === 'number') {
    charactersResourceState.characters[characterIndex].lastInteraction = payload.lastInteraction
  }
  charactersResourceState.selectionRevision = payload.revision
  charactersResourceState.rowRevisions[payload.characterId] = payload.revision
  charactersResourceState.rowStatuses[payload.characterId] = 'ready'
  delete charactersResourceState.rowErrors[payload.characterId]
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  return true
}

/**
 * Apply the authoritative result of this client's accepted chat-generation
 * settings command without re-reading the complete parent character. A newer
 * optimistic edit may already be visible while an older command response is
 * being reconciled; in that case keep the live overlay while still fencing the
 * accepted row revision.
 */
export function applyChatGenerationSettingsLocalEffect(
  payload: ServerChatGenerationSettingsLocalEffectPayload,
): boolean {
  const knownRowRevision = Math.max(
    charactersResourceState.listRevision ?? -1,
    charactersResourceState.rowRevisions[payload.characterId] ?? -1,
  )
  if (knownRowRevision >= payload.revision) return true

  const character = charactersResourceState.characters.find((candidate) => candidate?.chaId === payload.characterId)
  const chat = character?.chats?.find((candidate) => candidate?.id === payload.chatId)
  if (!chat) return false

  if (isJsonValueEqual(chat.generationSettings, payload.attemptedGenerationSettings)) {
    chat.generationSettings = cloneJsonValue(payload.generationSettings)
  }
  charactersResourceState.rowRevisions[payload.characterId] = payload.revision
  charactersResourceState.rowStatuses[payload.characterId] = 'ready'
  delete charactersResourceState.rowErrors[payload.characterId]
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  recordReaderChatPersona(payload.characterId, payload.chatId, payload.generationSettings)
  return true
}

/**
 * Acknowledge an accepted optimistic character patch without re-reading the
 * complete row. The live row may already contain a newer queued edit, so the
 * acknowledgement only fences its revision and never reapplies older fields.
 */
export function applyCharacterPatchLocalEffect(payload: ServerCharacterPatchLocalEffectPayload): boolean {
  const knownRowRevision = Math.max(
    charactersResourceState.listRevision ?? -1,
    charactersResourceState.rowRevisions[payload.characterId] ?? -1,
  )
  if (knownRowRevision >= payload.revision) return true
  if (Object.keys(payload.patch).length === 0) return false

  // A newer optimistic delete can remove the row before this accepted patch is
  // reconciled. Fence the acknowledgement anyway so the following delete event
  // can reconcile instead of trying to read a row that no longer exists.
  charactersResourceState.rowRevisions[payload.characterId] = payload.revision
  charactersResourceState.rowStatuses[payload.characterId] = 'ready'
  delete charactersResourceState.rowErrors[payload.characterId]
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  recordReaderCharacterPatch(payload.characterId, payload.patch)
  return true
}

/**
 * Fence an accepted optimistic write to a chat/folder field stored beneath one
 * character row. The caller already applied the exact field mutation, and a
 * newer queued edit must remain untouched.
 */
export function applyCharacterRowMutationLocalEffect(payload: ServerCharacterRowMutationLocalEffectPayload): boolean {
  const knownRowRevision = Math.max(
    charactersResourceState.listRevision ?? -1,
    charactersResourceState.rowRevisions[payload.characterId] ?? -1,
  )
  if (knownRowRevision >= payload.revision) return true
  if (!nonEmptyString(payload.targetId)) return false

  charactersResourceState.rowRevisions[payload.characterId] = payload.revision
  charactersResourceState.rowStatuses[payload.characterId] = 'ready'
  delete charactersResourceState.rowErrors[payload.characterId]
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  return true
}

/**
 * Fence a response-confirmed optimistic character selection. A later selection
 * or delete may already be visible, so keep the live pointers and timestamp.
 */
export function applyCharacterSelectionLocalEffect(payload: ServerCharacterSelectionLocalEffectPayload): boolean {
  const knownSelectionRevision = Math.max(
    charactersResourceState.listRevision ?? -1,
    charactersResourceState.selectionRevision ?? -1,
    charactersResourceState.rowRevisions[payload.characterId] ?? -1,
  )
  if (knownSelectionRevision >= payload.revision) return true
  if (!Number.isFinite(payload.lastInteraction)) return false

  charactersResourceState.selectionRevision = payload.revision
  charactersResourceState.rowRevisions[payload.characterId] = payload.revision
  charactersResourceState.rowStatuses[payload.characterId] = 'ready'
  delete charactersResourceState.rowErrors[payload.characterId]
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  return true
}

/**
 * Fence an accepted optimistic chat metadata or selection update. Later chat
 * edits, selections, or deletion remain untouched while the parent-row fence
 * prevents an older character response from overwriting them.
 */
export function applyChatPatchLocalEffect(payload: ServerChatPatchLocalEffectPayload): boolean {
  const knownRowRevision = Math.max(
    charactersResourceState.listRevision ?? -1,
    charactersResourceState.rowRevisions[payload.characterId] ?? -1,
  )
  if (knownRowRevision >= payload.revision) return true
  if (Object.keys(payload.patch).length === 0 && !payload.select) return false

  charactersResourceState.rowRevisions[payload.characterId] = payload.revision
  charactersResourceState.rowStatuses[payload.characterId] = 'ready'
  delete charactersResourceState.rowErrors[payload.characterId]
  charactersResourceState.revision = maxRevision(charactersResourceState.revision, payload.revision)
  recordReaderChatPatch(payload.characterId, payload.chatId, payload.patch)
  return true
}

export function resetServerResourceState(): void {
  clearReaderTranscriptProjection()
  invalidateModuleRenderRevision()
  settingsResourceState.value = {}
  settingsResourceState.revision = null
  settingsResourceState.fullRevision = null
  settingsResourceState.shellRevision = null
  settingsResourceState.pointerValueRevisions = {
    characterOrder: null,
    currentChar: null,
  }
  settingsResourceState.enabledModulesRevision = null
  settingsResourceState.loreBookPageRevision = null
  settingsResourceState.groupRevisions = {}
  settingsResourceState.groupStatuses = {}
  settingsResourceState.groupErrors = {}
  settingsResourceState.standaloneRevisions = {}
  settingsResourceState.standaloneStatuses = {}
  settingsResourceState.standaloneErrors = {}
  settingsResourceState.status = 'idle'
  settingsResourceState.error = null

  collectionsResourceState.values = {}
  collectionsResourceState.revision = null
  collectionsResourceState.fullRevision = null
  collectionsResourceState.revisions = {}
  collectionsResourceState.status = 'idle'
  collectionsResourceState.statuses = {}
  collectionsResourceState.error = null
  collectionsResourceState.errors = {}

  charactersResourceState.characters = []
  charactersResourceState.characterOrder = []
  charactersResourceState.currentChar = -1
  charactersResourceState.revision = null
  charactersResourceState.listRevision = null
  charactersResourceState.orderRevision = null
  charactersResourceState.selectionRevision = null
  charactersResourceState.rowRevisions = {}
  charactersResourceState.status = 'idle'
  charactersResourceState.rowStatuses = {}
  charactersResourceState.error = null
  charactersResourceState.rowErrors = {}
  resetCharacterBodyResourceRevisions()
  advanceCharacterListProjectionEpoch()
  advanceAllSettingsProjectionEpochs()
  advanceSettingsProjectionEpoch({ authoritativeFull: true })
  advanceLorebookPageProjectionEpoch()
  advanceAllCollectionProjectionEpochs()
  advanceAllCharacterRowProjectionEpochs()
  advanceAllChatBodyProjectionEpochs()
  advanceAllCharacterLorebookBodyProjectionEpochs()
  advanceAllCharacterLorebookProjectionEpochs()
}

/**
 * Let a full replacement snapshot rewind revisions without briefly deleting
 * the currently rendered database while its authoritative reads are in flight.
 */
export function resetServerResourceRevisionFencesForDatabaseReplacement(): void {
  invalidateModuleRenderRevision()
  settingsResourceState.revision = null
  settingsResourceState.fullRevision = null
  settingsResourceState.shellRevision = null
  settingsResourceState.pointerValueRevisions = {
    characterOrder: null,
    currentChar: null,
  }
  settingsResourceState.enabledModulesRevision = null
  settingsResourceState.loreBookPageRevision = null
  settingsResourceState.groupRevisions = {}
  settingsResourceState.standaloneRevisions = {}

  collectionsResourceState.revision = null
  collectionsResourceState.fullRevision = null
  collectionsResourceState.revisions = {}

  charactersResourceState.revision = null
  charactersResourceState.listRevision = null
  charactersResourceState.orderRevision = null
  charactersResourceState.selectionRevision = null
  charactersResourceState.rowRevisions = {}

  resetCharacterBodyResourceRevisions()
  advanceCharacterListProjectionEpoch()
  advanceAllSettingsProjectionEpochs()
  advanceSettingsProjectionEpoch({ authoritativeFull: true })
  advanceLorebookPageProjectionEpoch()
  advanceAllCollectionProjectionEpochs()
  advanceAllCharacterRowProjectionEpochs()
  advanceAllChatBodyProjectionEpochs()
  advanceAllCharacterLorebookBodyProjectionEpochs()
  advanceAllCharacterLorebookProjectionEpochs()
}

export function replaceResourceDatabase(database: Database, revision?: number): void {
  invalidateModuleRenderRevision()
  resetCharacterBodyResourceRevisions()
  const nextRevision = normalizeOptionalRevision(revision)
  const databaseRecord = cloneJsonValue(database) as unknown as Record<string, unknown>
  const settings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(databaseRecord)) {
    if (key === 'characters' || isServerCollectionName(key)) continue
    settings[key] = value
  }

  settingsResourceState.value = settings as ServerSettingsValues
  settingsResourceState.revision = nextRevision
  settingsResourceState.fullRevision = nextRevision
  settingsResourceState.shellRevision = nextRevision
  settingsResourceState.pointerValueRevisions = {
    characterOrder: nextRevision,
    currentChar: nextRevision,
  }
  settingsResourceState.enabledModulesRevision = null
  settingsResourceState.loreBookPageRevision = null
  settingsResourceState.groupRevisions = {}
  settingsResourceState.groupStatuses = Object.fromEntries(SETTINGS_GROUPS.map((group) => [group, 'ready'])) as Partial<
    Record<SettingsGroup, ServerResourceStatus>
  >
  settingsResourceState.groupErrors = {}
  settingsResourceState.standaloneRevisions = Object.fromEntries(
    SERVER_STANDALONE_SETTING_NAMES.map((setting) => [setting, nextRevision]),
  ) as Partial<Record<ServerStandaloneSettingName, number>>
  settingsResourceState.standaloneStatuses = Object.fromEntries(
    SERVER_STANDALONE_SETTING_NAMES.map((setting) => [setting, 'ready']),
  ) as Partial<Record<ServerStandaloneSettingName, ServerResourceStatus>>
  settingsResourceState.standaloneErrors = {}
  settingsResourceState.status = 'ready'
  settingsResourceState.error = null

  const collections: Partial<ServerCollectionValues> = {}
  const collectionStatuses: Partial<Record<ServerCollectionName, ServerResourceStatus>> = {}
  const collectionRevisions: Partial<Record<ServerCollectionName, number>> = {}
  for (const name of SERVER_COLLECTION_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(databaseRecord, name)) continue
    collections[name] = databaseRecord[name] as never
    collectionStatuses[name] = 'ready'
    if (nextRevision !== null) collectionRevisions[name] = nextRevision
  }
  collectionsResourceState.values = collections
  collectionsResourceState.revision = nextRevision
  collectionsResourceState.fullRevision = nextRevision
  collectionsResourceState.revisions = collectionRevisions
  collectionsResourceState.status = 'ready'
  collectionsResourceState.statuses = collectionStatuses
  collectionsResourceState.error = null
  collectionsResourceState.errors = {}

  const characters = Array.isArray(databaseRecord.characters)
    ? (databaseRecord.characters as unknown as character[])
    : []
  recordReaderCharacters(characters, nextRevision)
  recordReaderPersonas(collections.personas)
  recordReaderPersonaSettings(settings)
  recordReaderNavigationSettings(settings)
  recordReaderCharacterOrder(
    Array.isArray(databaseRecord.characterOrder) ? (databaseRecord.characterOrder as Database['characterOrder']) : [],
  )
  charactersResourceState.characters = characters
  charactersResourceState.characterOrder = Array.isArray(databaseRecord.characterOrder)
    ? (databaseRecord.characterOrder as Database['characterOrder'])
    : []
  charactersResourceState.currentChar = Number.isInteger(databaseRecord.currentChar)
    ? (databaseRecord.currentChar as number)
    : -1
  charactersResourceState.revision = nextRevision
  charactersResourceState.listRevision = nextRevision
  charactersResourceState.orderRevision = nextRevision
  charactersResourceState.selectionRevision = nextRevision
  charactersResourceState.rowRevisions =
    nextRevision === null
      ? {}
      : Object.fromEntries(
          characters
            .filter((candidate) => nonEmptyString(candidate?.chaId))
            .map((candidate) => [candidate.chaId, nextRevision]),
        )
  charactersResourceState.status = 'ready'
  charactersResourceState.rowStatuses = Object.fromEntries(
    characters.filter((candidate) => nonEmptyString(candidate?.chaId)).map((candidate) => [candidate.chaId, 'ready']),
  )
  charactersResourceState.error = null
  charactersResourceState.rowErrors = {}
  advanceCharacterListProjectionEpoch()
  advanceAllSettingsProjectionEpochs()
  advanceSettingsProjectionEpoch({ authoritativeFull: true })
  advanceLorebookPageProjectionEpoch()
  advanceAllCollectionProjectionEpochs()
  advanceAllCharacterRowProjectionEpochs()
  advanceAllChatBodyProjectionEpochs()
  advanceAllCharacterLorebookBodyProjectionEpochs()
  advanceAllCharacterLorebookProjectionEpochs()
}

export function areServerDatabaseResourcesReady(): boolean {
  return (
    settingsResourceState.status === 'ready' &&
    collectionsResourceState.status === 'ready' &&
    charactersResourceState.status === 'ready'
  )
}

export function composeResourceDatabaseSnapshot(): Database {
  return cloneJsonValue(composeResourceDatabaseRecord()) as unknown as Database
}

function composeResourceDatabaseRecord(): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ...(settingsResourceState.value as Record<string, unknown>),
    ...(collectionsResourceState.values as Record<string, unknown>),
    characters: charactersResourceState.characters,
  }
  if (shouldUseCharacterPointerResource('characterOrder')) {
    record.characterOrder = charactersResourceState.characterOrder
  }
  if (shouldUseCharacterPointerResource('currentChar')) {
    record.currentChar = charactersResourceState.currentChar
  }
  return record
}

function isCharacterSummaryShell(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] === true
  )
}

function preserveResidentCharacterChatBodies(
  incoming: character,
  existing: character | undefined,
  incomingRevision: number,
): character {
  if (existing && Array.isArray(incoming.chats) && Array.isArray(existing.chats)) {
    const existingChatsById = new Map(
      existing.chats.filter((chat) => nonEmptyString(chat?.id)).map((chat) => [chat.id, chat]),
    )
    for (const chat of incoming.chats) {
      if (!nonEmptyString(chat?.id)) continue
      const resident = existingChatsById.get(chat.id)
      if (!resident) continue
      if (Array.isArray(resident.message)) chat.message = resident.message
      if (Object.prototype.hasOwnProperty.call(resident, 'hypaV3Data')) {
        chat.hypaV3Data = resident.hypaV3Data
      }
      if (shouldPreserveLiveChatGenerationSettingsForResource(chat.id, chat.generationSettings)) {
        if (Object.prototype.hasOwnProperty.call(resident, 'generationSettings')) {
          chat.generationSettings = resident.generationSettings
        } else {
          delete chat.generationSettings
        }
      }
    }
  }
  const bodyIsNewer = hasNewerCharacterLorebookBodyResourceRevision(incoming.chaId, incomingRevision)
  if (bodyIsNewer) {
    if (existing?.globalLore !== undefined) {
      incoming.globalLore = existing.globalLore
    } else {
      delete incoming.globalLore
    }
  } else if (incoming.globalLore === undefined && existing?.globalLore !== undefined) {
    incoming.globalLore = existing.globalLore
  }
  return incoming
}

function applyRuntimeLanguage(value: unknown): void {
  void changeLanguage(typeof value === 'string' ? value : 'en')
}

function shouldUseCharacterPointerResource(property: 'characterOrder' | 'currentChar'): boolean {
  const targetedRevision =
    property === 'characterOrder' ? charactersResourceState.orderRevision : charactersResourceState.selectionRevision
  const pointerRevision = Math.max(charactersResourceState.listRevision ?? -1, targetedRevision ?? -1)
  if (pointerRevision < 0) return false
  const settingsPointerValueRevision = settingsResourceState.pointerValueRevisions[property]
  return settingsPointerValueRevision === null || pointerRevision >= settingsPointerValueRevision
}

function isLorebookMutationOperation(value: unknown): value is ServerLorebookMutationLocalEffectPayload['operation'] {
  return value === 'replace' || value === 'upsert' || value === 'delete' || value === 'reorder'
}

function isGlobalLorebookMutationOperation(
  value: unknown,
): value is ServerGlobalLorebookMutationLocalEffectPayload['operation'] {
  return value === 'create' || value === 'update' || value === 'delete' || value === 'reorder' || value === 'select'
}

function isCanonicalGlobalLorebookCollectionProjection(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const record = candidate as Record<string, unknown>
    if (!nonEmptyString(record.id) || ids.has(record.id)) return false
    if (!nonEmptyString(record.name) || !isCanonicalLorebookEntries(record.data)) return false
    ids.add(record.id)
  }
  return true
}

function isStableGlobalLorebookPageProjection(): boolean {
  if (settingsResourceState.status !== 'ready' || collectionsResourceState.statuses.loreBook !== 'ready') return false
  const lorebooks = collectionsResourceState.values.loreBook
  if (!Array.isArray(lorebooks)) return false
  const ids = new Set<string>()
  for (const candidate of lorebooks) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const id = (candidate as Record<string, unknown>).id
    if (!nonEmptyString(id) || ids.has(id)) return false
    ids.add(id)
  }
  const page = (settingsResourceState.value as Record<string, unknown>).loreBookPage
  return (
    Number.isInteger(page) &&
    (lorebooks.length === 0 ? page === 0 : (page as number) >= 0 && (page as number) < lorebooks.length)
  )
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value)
}

function isCanonicalGlobalLorebookTarget(lorebookId: string): boolean {
  const lorebooks = collectionsResourceState.values.loreBook
  if (!Array.isArray(lorebooks)) return false

  const ids = new Set<string>()
  let target: Record<string, unknown> | null = null
  for (const candidate of lorebooks) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const record = candidate as Record<string, unknown>
    if (!nonEmptyString(record.id) || ids.has(record.id)) return false
    ids.add(record.id)
    if (record.id === lorebookId) target = record
  }
  return !!target && nonEmptyString(target.name) && isCanonicalLorebookEntries(target.data)
}

function isCanonicalCharacterLorebookTarget(characterId: string): boolean {
  const matches = charactersResourceState.characters.filter((candidate) => candidate?.chaId === characterId)
  return matches.length === 1 && isCanonicalLorebookEntries(matches[0].globalLore)
}

function isCanonicalChatLorebookTarget(characterId: string, chatId: string): boolean {
  let target: unknown = null
  let matches = 0
  for (const character of charactersResourceState.characters) {
    for (const chat of character.chats ?? []) {
      if (chat?.id !== chatId) continue
      matches += 1
      if (character.chaId === characterId) target = chat.localLore
    }
  }
  return matches === 1 && isCanonicalLorebookEntries(target)
}

function isCanonicalLorebookEntries(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const entry = candidate as Record<string, unknown>
    if (!nonEmptyString(entry.id) || ids.has(entry.id)) return false
    if (
      typeof entry.key !== 'string' ||
      typeof entry.secondkey !== 'string' ||
      typeof entry.insertorder !== 'number' ||
      !Number.isFinite(entry.insertorder) ||
      typeof entry.comment !== 'string' ||
      typeof entry.content !== 'string' ||
      typeof entry.mode !== 'string' ||
      typeof entry.alwaysActive !== 'boolean' ||
      typeof entry.selective !== 'boolean' ||
      (entry.folder !== undefined && typeof entry.folder !== 'string')
    ) {
      return false
    }
    ids.add(entry.id)
  }
  return true
}

function isNormalizedModuleCollectionProjection(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const record = candidate as Record<string, unknown>
    const moduleId = record.id
    if (!nonEmptyString(moduleId) || ids.has(moduleId)) return false
    if (!nonEmptyString(record.name) || typeof record.description !== 'string') return false
    ids.add(moduleId)
  }
  return true
}

function isNormalizedCharacterCollectionProjection(): boolean {
  const characters = charactersResourceState.characters
  const characterOrder = charactersResourceState.characterOrder
  const currentChar = charactersResourceState.currentChar
  if (!Array.isArray(characters) || !Array.isArray(characterOrder) || !Number.isInteger(currentChar)) return false
  if (characters.length === 0 ? currentChar !== -1 : currentChar < -1 || currentChar >= characters.length) return false

  const characterIds = new Set<string>()
  const activeIds = new Set<string>()
  for (const candidate of characters) {
    const characterId = candidate?.chaId
    if (!nonEmptyString(characterId) || characterIds.has(characterId)) return false
    characterIds.add(characterId)
    if (characterId !== '§temp' && !candidate.trashTime) activeIds.add(characterId)
  }

  const seenCharacterIds = new Set<string>()
  const seenFolderIds = new Set<string>()
  for (const entry of characterOrder) {
    if (typeof entry === 'string') {
      if (!activeIds.has(entry) || seenCharacterIds.has(entry)) return false
      seenCharacterIds.add(entry)
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    if (!nonEmptyString(entry.id) || seenFolderIds.has(entry.id)) return false
    if (typeof entry.name !== 'string' || typeof entry.color !== 'string' || !Array.isArray(entry.data)) return false
    if (entry.data.length === 0) return false
    if (entry.imgFile !== undefined && entry.imgFile !== null && typeof entry.imgFile !== 'string') return false
    if (entry.img !== undefined && typeof entry.img !== 'string') return false
    seenFolderIds.add(entry.id)
    for (const characterId of entry.data) {
      if (!activeIds.has(characterId) || seenCharacterIds.has(characterId)) return false
      seenCharacterIds.add(characterId)
    }
  }
  return seenCharacterIds.size === activeIds.size
}

function isOlderRevision(revision: number, current: number | null): boolean {
  return current !== null && revision < current
}

function maxRevision(current: number | null, next: number): number {
  return current === null ? next : Math.max(current, next)
}

function normalizeOptionalRevision(revision: number | undefined): number | null {
  if (revision === undefined) return null
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TypeError('Resource database revision must be a non-negative integer')
  }
  return revision
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isCanonicalJsonFieldState(value: unknown): value is ServerJsonFieldState {
  if (!isPlainRecord(value) || typeof value.present !== 'boolean') return false
  const keys = Object.keys(value).sort()
  if (!value.present) return isJsonValueEqual(keys, ['present'])
  return isJsonValueEqual(keys, ['present', 'value']) && isJsonValue(value.value)
}

function jsonFieldStateMatches(record: Record<string, unknown>, key: string, state: ServerJsonFieldState): boolean {
  const present = Object.prototype.hasOwnProperty.call(record, key)
  if (present !== state.present) return false
  return !state.present || isJsonValueEqual(record[key], state.value)
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false

  ancestors.add(value)
  const valid = Array.isArray(value)
    ? value.every((entry, index) => Object.prototype.hasOwnProperty.call(value, index) && isJsonValue(entry, ancestors))
    : Object.values(value).every((entry) => isJsonValue(entry, ancestors))
  ancestors.delete(value)
  return valid
}

function isUniquePresetCollection(value: readonly unknown[]): boolean {
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!isPlainRecord(candidate) || !nonEmptyString(candidate.id) || ids.has(candidate.id)) return false
    ids.add(candidate.id)
  }
  return true
}

type CanonicalTranslatorPresetRecord = {
  id: string
  name: string
  prompt: string
  maxResponse: number
  steps?: TranslatorPresetStep[]
}

function isCanonicalTranslatorPresetSteps(value: unknown): value is TranslatorPresetStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TRANSLATOR_PRESET_MAX_STEPS) return false

  const stepIds = new Set<string>()
  const outputKeys = new Set<string>()
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) return false
    const expectedKeys =
      candidate.outputKey === undefined
        ? ['enabled', 'id', 'maxResponse', 'model', 'name', 'prompt']
        : ['enabled', 'id', 'maxResponse', 'model', 'name', 'outputKey', 'prompt']
    if (
      !isJsonValueEqual(Object.keys(candidate).sort(), expectedKeys) ||
      !nonEmptyString(candidate.id) ||
      stepIds.has(candidate.id) ||
      !nonEmptyString(candidate.name) ||
      typeof candidate.enabled !== 'boolean' ||
      typeof candidate.prompt !== 'string' ||
      typeof candidate.maxResponse !== 'number' ||
      !Number.isFinite(candidate.maxResponse) ||
      !isPlainRecord(candidate.model)
    ) {
      return false
    }
    stepIds.add(candidate.id)

    const model = candidate.model
    if (
      (model.mode === 'inheritTranslate' && !isJsonValueEqual(Object.keys(model), ['mode'])) ||
      (model.mode === 'modelProfile' &&
        (!isJsonValueEqual(Object.keys(model).sort(), ['mode', 'profileId']) || !nonEmptyString(model.profileId))) ||
      (model.mode !== 'inheritTranslate' && model.mode !== 'modelProfile')
    ) {
      return false
    }

    if (candidate.outputKey !== undefined) {
      if (
        typeof candidate.outputKey !== 'string' ||
        !isValidTranslatorPresetOutputKey(candidate.outputKey) ||
        outputKeys.has(candidate.outputKey)
      ) {
        return false
      }
      outputKeys.add(candidate.outputKey)
    }
  }
  return true
}

function isCanonicalTranslatorPresetRecord(value: unknown): value is CanonicalTranslatorPresetRecord {
  if (!isPlainRecord(value) || !isJsonValue(value)) return false
  const keys = Object.keys(value).sort()
  if (
    (!isJsonValueEqual(keys, ['id', 'maxResponse', 'name', 'prompt']) &&
      !isJsonValueEqual(keys, ['id', 'maxResponse', 'name', 'prompt', 'steps'])) ||
    !nonEmptyString(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.maxResponse !== 'number' ||
    !Number.isFinite(value.maxResponse)
  ) {
    return false
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'steps')) return true
  if (!isCanonicalTranslatorPresetSteps(value.steps)) return false

  return value.prompt === value.steps[0].prompt && value.maxResponse === value.steps[0].maxResponse
}

function isCanonicalTranslatorPresetCollection(value: readonly unknown[]): value is CanonicalTranslatorPresetRecord[] {
  return value.every(isCanonicalTranslatorPresetRecord) && isUniquePresetCollection(value)
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function isUniqueStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => nonEmptyString(entry)) && new Set(value).size === value.length
}

function isPromptItemMutationOperation(value: unknown): value is PromptItemMutationOperation {
  return value === 'create' || value === 'update' || value === 'delete' || value === 'reorder' || value === 'enable'
}

function isCanonicalPromptTemplateOwnerState(value: unknown): value is PromptTemplateOwnerStateSnapshot {
  if (!isPlainRecord(value)) return false
  if (value.enabled === false) return Object.keys(value).length === 1
  return value.enabled === true && Object.keys(value).length === 2 && isCanonicalPromptItemArray(value.items)
}

function isCanonicalPromptItemArray(value: unknown): value is Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(value)) return false
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!isPlainRecord(candidate) || !nonEmptyString(candidate.id) || seen.has(candidate.id)) return false
    seen.add(candidate.id)
  }
  return true
}

function promptItemMutationMatchesOwnerState(payload: ServerPromptItemMutationLocalEffectPayload): boolean {
  const items = payload.ownerState.enabled ? payload.ownerState.items : null
  if (payload.operation === 'create' || payload.operation === 'update') {
    return nonEmptyString(payload.itemId) && !!items?.some((item) => item.id === payload.itemId)
  }
  if (payload.operation === 'delete') {
    return nonEmptyString(payload.itemId) && !!items && items.every((item) => item.id !== payload.itemId)
  }
  if (payload.operation === 'reorder') {
    return (
      isUniqueStringArray(payload.itemIds) &&
      !!items &&
      isJsonValueEqual(
        items.map((item) => item.id),
        payload.itemIds,
      )
    )
  }
  return typeof payload.enabled === 'boolean' && payload.ownerState.enabled === payload.enabled
}

function readCanonicalLivePromptTemplateOwnerState(
  promptPresetId: string | null,
): PromptTemplateOwnerStateSnapshot | null {
  if (promptPresetId === null) {
    return readCanonicalPromptTemplateValue(
      Object.prototype.hasOwnProperty.call(collectionsResourceState.values, 'promptTemplate'),
      collectionsResourceState.values.promptTemplate,
    )
  }

  const presets = collectionsResourceState.values.promptPresets
  if (!Array.isArray(presets)) return null
  const seen = new Set<string>()
  let owner: Record<string, unknown> | null = null
  for (const candidate of presets) {
    if (!isPlainRecord(candidate) || !nonEmptyString(candidate.id) || seen.has(candidate.id)) return null
    seen.add(candidate.id)
    if (candidate.id === promptPresetId) owner = candidate
  }
  if (!owner) return null
  return readCanonicalPromptTemplateValue(
    Object.prototype.hasOwnProperty.call(owner, 'promptTemplate'),
    owner.promptTemplate,
  )
}

function readCanonicalPromptTemplateValue(enabled: boolean, value: unknown): PromptTemplateOwnerStateSnapshot | null {
  if (!enabled) return { enabled: false }
  return isCanonicalPromptItemArray(value) ? { enabled: true, items: value } : null
}

function livePromptTemplateOwnerSupportsOperation(
  payload: ServerPromptItemMutationLocalEffectPayload,
  liveOwnerState: PromptTemplateOwnerStateSnapshot,
): boolean {
  if (payload.operation === 'create' || payload.operation === 'update') {
    return liveOwnerState.enabled && liveOwnerState.items.some((item) => item.id === payload.itemId)
  }
  if (payload.operation === 'delete') {
    return !liveOwnerState.enabled || liveOwnerState.items.every((item) => item.id !== payload.itemId)
  }
  if (payload.operation === 'reorder') {
    return (
      liveOwnerState.enabled &&
      isJsonValueEqual(
        liveOwnerState.items.map((item) => item.id),
        payload.itemIds,
      )
    )
  }
  return liveOwnerState.enabled === payload.enabled
}

function isJsonValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
