import { canonicalizeLegacyGenerationValues } from '@risuai/shared-core/legacy-generation-value-canonicalization'
import { repairLegacySeparateParameterOverrides } from '@risuai/shared-core/separate-parameter-compatibility'
import { randomUUID } from 'node:crypto'
import {
  createExtractedModelPreset,
  createExtractedPromptPreset,
  findEquivalentModelPreset,
  MODEL_PRESET_FIELDS,
  PROMPT_PRESET_FIELDS,
  PROMPT_PRESET_MODEL_OTHERS_OVERRIDE_FIELDS,
  PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS,
  type ModelPresetRecord,
  type PromptPresetRecord,
  databaseKeyForModelPresetField,
  promptPresetRecommendedModelPresetId,
  promptPresetOverridesModelParameters,
  resolvePromptPresetRegexField,
} from '@risuai/shared-core/preset-split'
import { MASKED_PROVIDER_SECRET } from '../providerSecrets.js'
import { EntityNotFoundError, ValidationError } from '../repository.js'
import {
  normalizeLegacyFallbackModels,
  normalizeLegacySeperateModels,
  normalizeModelRoleOverrides,
} from '@risuai/shared-core/model-roles'
import {
  normalizeModelProfileOrder,
  normalizeModelRuntimeDefaults,
  normalizeModelProfiles,
  normalizeModelRoleProfiles,
} from '@risuai/shared-core/model-profile-records'
import { normalizePromptTemplateValue } from './prompts.js'
import { normalizePresetLocalStopStrings } from './localStopStrings.js'

type JsonRecord = Record<string, unknown>
type PresetKind = 'modelPreset' | 'promptPreset'

export type { ModelPresetRecord, PromptPresetRecord }

export type LegacyBotPresetExtractionMode = 'all' | 'model' | 'prompt'

export interface LegacyBotPresetExtractionResult {
  legacyPresetId: string
  modelPresetId?: string
  promptPresetId?: string
  reusedModelPreset?: boolean
}

const MODEL_PRESET_APPLY_KEYS: Array<[string, string]> = MODEL_PRESET_FIELDS.map((key) => {
  return [key, databaseKeyForModelPresetField(key)]
})

const PROMPT_PRESET_APPLY_KEYS: Array<[string, string]> = PROMPT_PRESET_FIELDS.filter(
  (key) => key !== 'regex' && key !== 'presetRegex',
).map((key) => [key, key])

const PROMPT_PRESET_PARAMETER_OVERRIDE_APPLY_KEYS: Array<[string, string]> =
  PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS.map((key) => [key, databaseKeyForModelPresetField(key)])

const PROMPT_PRESET_OTHERS_OVERRIDE_APPLY_KEYS: Array<[string, string]> =
  PROMPT_PRESET_MODEL_OTHERS_OVERRIDE_FIELDS.map((key) => [key, databaseKeyForModelPresetField(key)])

export function ensureDatabaseObject(database: unknown): JsonRecord {
  if (!database || typeof database !== 'object' || Array.isArray(database)) {
    throw new ValidationError('database must be an object before split preset commands can run')
  }
  return database as JsonRecord
}

export function ensureModelPresetCollection(database: JsonRecord): ModelPresetRecord[] {
  return ensureSplitPresetCollection(database, 'modelPresets', 'modelPresetsId', 'modelPreset') as ModelPresetRecord[]
}

export function ensurePromptPresetCollection(database: JsonRecord): PromptPresetRecord[] {
  return ensureSplitPresetCollection(
    database,
    'promptPresets',
    'promptPresetsId',
    'promptPreset',
  ) as PromptPresetRecord[]
}

export function normalizeSplitPresetCollections(database: unknown): void {
  const target = ensureDatabaseObject(database)
  ensureModelPresetCollection(target)
  ensurePromptPresetCollection(target)
}

export function createModelPresetRecord(input: JsonRecord, fallbackName = 'New Model Preset'): ModelPresetRecord {
  return createSplitPresetRecord(input, 'modelPreset', fallbackName) as ModelPresetRecord
}

export function createPromptPresetRecord(input: JsonRecord, fallbackName = 'New Prompt Preset'): PromptPresetRecord {
  return createSplitPresetRecord(input, 'promptPreset', fallbackName) as PromptPresetRecord
}

export function readModelPresetPatch(input: JsonRecord): JsonRecord {
  return readSplitPresetPatch(input, 'modelPreset')
}

export function readPromptPresetPatch(input: JsonRecord): JsonRecord {
  const patch = readSplitPresetPatch(input, 'promptPreset')
  validatePromptPresetArchived(patch)
  validatePromptPresetRecommendedModelPresetField(patch)
  normalizePromptPresetPatchAliases(patch)
  return patch
}

export function validatePromptPresetRecommendedModelPreset(
  preset: JsonRecord,
  modelPresets: readonly ModelPresetRecord[],
  label = 'promptPreset',
): void {
  validatePromptPresetRecommendedModelPresetField(preset, label)
  const recommendedModelPresetId = promptPresetRecommendedModelPresetId(preset)
  if (recommendedModelPresetId && !modelPresets.some((modelPreset) => modelPreset.id === recommendedModelPresetId)) {
    throw new ValidationError(
      `Unknown model preset id in ${label}.recommendedModelPresetId: ${recommendedModelPresetId}`,
    )
  }
}

export function readModelPresetId(value: unknown, label = 'modelPresetId'): string {
  return readSplitPresetId(value, label)
}

export function readPromptPresetId(value: unknown, label = 'promptPresetId'): string {
  return readSplitPresetId(value, label)
}

export function findModelPresetIndex(presets: readonly ModelPresetRecord[], presetId: string): number {
  return presets.findIndex((preset) => preset.id === presetId)
}

export function findPromptPresetIndex(presets: readonly PromptPresetRecord[], presetId: string): number {
  return presets.findIndex((preset) => preset.id === presetId)
}

export function requireModelPresetIndex(presets: readonly ModelPresetRecord[], presetId: string): number {
  const index = findModelPresetIndex(presets, presetId)
  if (index === -1) throw new EntityNotFoundError(`Model preset not found: ${presetId}`)
  return index
}

export function requirePromptPresetIndex(presets: readonly PromptPresetRecord[], presetId: string): number {
  const index = findPromptPresetIndex(presets, presetId)
  if (index === -1) throw new EntityNotFoundError(`Prompt preset not found: ${presetId}`)
  return index
}

export function selectedModelPresetId(database: JsonRecord, presets: readonly ModelPresetRecord[]): string | null {
  return selectedSplitPresetId(database.modelPresetsId, presets)
}

export function selectedPromptPresetId(database: JsonRecord, presets: readonly PromptPresetRecord[]): string | null {
  return selectedSplitPresetId(database.promptPresetsId, presets)
}

export function validateFullModelPresetIdList(
  presets: readonly ModelPresetRecord[],
  presetIds: readonly unknown[],
): void {
  validateFullSplitPresetIdList(presets, presetIds, 'modelPresetIds')
}

export function validateFullPromptPresetIdList(
  presets: readonly PromptPresetRecord[],
  presetIds: readonly unknown[],
): void {
  validateFullSplitPresetIdList(presets, presetIds, 'promptPresetIds')
}

export function applyModelPreset(database: JsonRecord, preset: ModelPresetRecord): void {
  applySplitPreset(database, preset, MODEL_PRESET_APPLY_KEYS)
}

export function applyPromptPreset(database: JsonRecord, preset: PromptPresetRecord): void {
  applySplitPreset(database, preset, PROMPT_PRESET_APPLY_KEYS)
  applyPromptPresetRegexField(database, preset)
  if (promptPresetOverridesModelParameters(preset)) {
    applySplitPreset(database, preset, PROMPT_PRESET_PARAMETER_OVERRIDE_APPLY_KEYS)
  }
  applySplitPreset(database, preset, PROMPT_PRESET_OTHERS_OVERRIDE_APPLY_KEYS)
}

export function promptPresetAppliesPromptTemplate(preset: PromptPresetRecord | undefined): boolean {
  return !!preset && Object.prototype.hasOwnProperty.call(preset, 'promptTemplate')
}

function applyPromptPresetRegexField(database: JsonRecord, preset: PromptPresetRecord): void {
  const regexField = resolvePromptPresetRegexField(preset)
  if (!regexField.present) return
  database.presetRegex = cloneJson(regexField.value)
}

export function resolveModelPresetMaskedSecrets(
  existing: ModelPresetRecord | undefined,
  patch: JsonRecord,
): JsonRecord {
  if (!existing) return patch
  const resolved = cloneJson(patch) as JsonRecord
  for (const key of ['openAIKey', 'proxyKey']) {
    if (resolved[key] === MASKED_PROVIDER_SECRET && Object.prototype.hasOwnProperty.call(existing, key)) {
      resolved[key] = cloneJson(existing[key])
    }
  }
  return resolved
}

export function extractLegacyBotPreset(
  database: JsonRecord,
  legacyPresetId: string,
  mode: LegacyBotPresetExtractionMode,
): LegacyBotPresetExtractionResult {
  if (mode !== 'all' && mode !== 'model' && mode !== 'prompt') {
    throw new ValidationError('mode must be one of all, model, or prompt')
  }

  const legacyPresets = ensureLegacyBotPresetCollection(database)
  const legacyIndex = legacyPresets.findIndex((preset) => preset.id === legacyPresetId)
  if (legacyIndex === -1) {
    throw new EntityNotFoundError(`Legacy bot preset not found: ${legacyPresetId}`)
  }

  const legacyPreset = legacyPresets[legacyIndex]
  const legacyName = typeof legacyPreset.name === 'string' && legacyPreset.name.trim() ? legacyPreset.name : 'Legacy'
  const result: LegacyBotPresetExtractionResult = { legacyPresetId }

  if (mode === 'all' || mode === 'model') {
    const modelPresets = ensureModelPresetCollection(database)
    const candidate = createExtractedModelPreset(legacyPreset, {
      id: randomUUID(),
      name: `${legacyName} Model`,
    })
    const equivalent = findEquivalentModelPreset(modelPresets, candidate)
    if (equivalent?.id) {
      result.modelPresetId = equivalent.id
      result.reusedModelPreset = true
    } else {
      modelPresets.push(candidate)
      result.modelPresetId = candidate.id
      result.reusedModelPreset = false
    }
  }

  if (mode === 'all' || mode === 'prompt') {
    const promptPresets = ensurePromptPresetCollection(database)
    const promptPreset = createExtractedPromptPreset(legacyPreset, {
      id: randomUUID(),
      name: `${legacyName} Prompt`,
    })
    promptPresets.push(promptPreset)
    result.promptPresetId = promptPreset.id
  }

  const beforeSelected = Number.isInteger(database.botPresetsId as number) ? (database.botPresetsId as number) : -1
  legacyPresets.splice(legacyIndex, 1)
  database.botPresetsId = normalizeSelectedIndex(legacyPresets.length, beforeSelected)
  if (beforeSelected > legacyIndex) {
    database.botPresetsId = beforeSelected - 1
  } else if (beforeSelected === legacyIndex) {
    database.botPresetsId = legacyPresets.length > 0 ? Math.min(legacyIndex, legacyPresets.length - 1) : -1
  }

  return result
}

function ensureSplitPresetCollection(
  database: JsonRecord,
  collectionKey: 'modelPresets' | 'promptPresets',
  selectedKey: 'modelPresetsId' | 'promptPresetsId',
  idPrefix: string,
): Array<ModelPresetRecord | PromptPresetRecord> {
  if (!Array.isArray(database[collectionKey])) {
    database[collectionKey] = []
  }

  const seen = new Set<string>()
  const presets = (database[collectionKey] as unknown[]).map((raw, index) => {
    const preset = isRecord(raw) ? raw : {}
    const requestedId = typeof preset.id === 'string' && preset.id.trim() ? preset.id : ''
    const fallbackId = index === 0 ? `default-${idPrefix}` : `${idPrefix}-${index + 1}`
    const id = requestedId && !seen.has(requestedId) ? requestedId : fallbackId
    preset.id = seen.has(id) ? `${id}-${index + 1}` : id
    preset.name = typeof preset.name === 'string' ? preset.name : `Preset ${index + 1}`
    normalizePromptPresetPromptTemplate(collectionKey, preset)
    seen.add(preset.id as string)
    return preset as ModelPresetRecord | PromptPresetRecord
  })
  database[collectionKey] = presets
  database[selectedKey] = normalizeSelectedIndex(presets.length, database[selectedKey])
  return presets
}

function ensureLegacyBotPresetCollection(database: JsonRecord): Array<JsonRecord & { id: string }> {
  if (!Array.isArray(database.botPresets)) {
    database.botPresets = []
  }

  const seen = new Set<string>()
  const presets = (database.botPresets as unknown[]).map((raw, index) => {
    const preset = isRecord(raw) ? raw : {}
    const requestedId = typeof preset.id === 'string' && preset.id.trim() ? preset.id : ''
    const fallbackId = index === 0 ? 'legacy-bot-preset' : `legacy-bot-preset-${index + 1}`
    const id = requestedId && !seen.has(requestedId) ? requestedId : fallbackId
    preset.id = seen.has(id) ? `${id}-${index + 1}` : id
    seen.add(preset.id as string)
    return preset as JsonRecord & { id: string }
  })
  database.botPresets = presets
  database.botPresetsId = normalizeSelectedIndex(presets.length, database.botPresetsId)
  return presets
}

function createSplitPresetRecord(
  input: JsonRecord,
  label: PresetKind,
  fallbackName: string,
): JsonRecord & { id: string } {
  const preset = cloneJson(input) as JsonRecord & { id: string; name?: unknown }
  normalizePresetLocalStopStrings(preset, label)
  preset.id = readSplitPresetId(preset.id, `${label}.id`)
  if (preset.name !== undefined && typeof preset.name !== 'string') {
    throw new ValidationError(`${label}.name must be a string`)
  }
  preset.name ??= fallbackName
  normalizeSplitPresetRoleAdjacentFields(preset)
  normalizePromptPresetPromptTemplate(label, preset)
  if (label === 'promptPreset') {
    validatePromptPresetArchived(preset)
    validatePromptPresetRecommendedModelPresetField(preset)
  }
  validateJsonValue(label, preset)
  return canonicalizeLegacyGenerationValues(preset) as JsonRecord & { id: string }
}

function readSplitPresetPatch(input: JsonRecord, label: PresetKind): JsonRecord {
  const patch = cloneJson(input) as JsonRecord
  normalizePresetLocalStopStrings(patch, label)
  normalizeSplitPresetRoleAdjacentFields(patch)
  normalizePromptPresetPromptTemplate(label, patch)
  validateJsonValue(label, patch)
  return canonicalizeLegacyGenerationValues(patch) as JsonRecord
}

function normalizePromptPresetPromptTemplate(
  label: PresetKind | 'modelPresets' | 'promptPresets',
  record: JsonRecord,
): void {
  if (label !== 'promptPreset' && label !== 'promptPresets') return
  if (!Object.prototype.hasOwnProperty.call(record, 'promptTemplate')) return
  record.promptTemplate = normalizePromptTemplateValue(record.promptTemplate)
}

function normalizePromptPresetPatchAliases(patch: JsonRecord): void {
  if (Object.prototype.hasOwnProperty.call(patch, 'presetRegex')) {
    patch.regex = []
  }
}

function validatePromptPresetArchived(record: JsonRecord): void {
  if (record.archived !== undefined && typeof record.archived !== 'boolean') {
    throw new ValidationError('promptPreset.archived must be a boolean')
  }
}

function validatePromptPresetRecommendedModelPresetField(record: JsonRecord, label = 'promptPreset'): void {
  if (
    Object.prototype.hasOwnProperty.call(record, 'recommendedModelPresetId') &&
    record.recommendedModelPresetId !== null &&
    typeof record.recommendedModelPresetId !== 'string'
  ) {
    throw new ValidationError(`${label}.recommendedModelPresetId must be a string or null`)
  }
  if (typeof record.recommendedModelPresetId === 'string' && record.recommendedModelPresetId.trim() === '') {
    throw new ValidationError(`${label}.recommendedModelPresetId must be non-empty or null`)
  }
}

function readSplitPresetId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label} must be a non-empty string`)
  }
  return value
}

function selectedSplitPresetId<T extends { id?: string }>(selected: unknown, presets: readonly T[]): string | null {
  const index = Number.isInteger(selected as number) ? (selected as number) : -1
  return presets[index]?.id ?? null
}

function validateFullSplitPresetIdList<T extends { id: string }>(
  presets: readonly T[],
  presetIds: readonly unknown[],
  label: string,
): void {
  const existing = new Set(presets.map((preset) => preset.id))
  const seen = new Set<string>()
  if (presetIds.length !== presets.length) {
    throw new ValidationError(`${label} must include every existing preset id`)
  }
  for (const id of presetIds) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ValidationError(`${label} must contain non-empty strings`)
    }
    if (seen.has(id)) {
      throw new ValidationError(`Duplicate preset id: ${id}`)
    }
    if (!existing.has(id)) {
      throw new ValidationError(`Unknown preset id: ${id}`)
    }
    seen.add(id)
  }
}

function applySplitPreset(database: JsonRecord, preset: JsonRecord, keys: ReadonlyArray<[string, string]>): void {
  preset = canonicalizeLegacyGenerationValues(preset) as JsonRecord
  for (const [presetKey, databaseKey] of keys) {
    if (Object.prototype.hasOwnProperty.call(preset, presetKey)) {
      database[databaseKey] = normalizeSplitPresetAppliedValue(
        databaseKey,
        cloneJson(preset[presetKey]),
        normalizeModelProfiles(database.modelProfiles),
      )
    }
  }
}

function normalizeSplitPresetRoleAdjacentFields(record: JsonRecord): void {
  for (const key of [
    'modelRoles',
    'modelProfiles',
    'modelProfileOrder',
    'modelRoleProfiles',
    'modelRuntimeDefaults',
    'seperateModels',
    'fallbackModels',
    'seperateParameters',
  ]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      record[key] = normalizeSplitPresetAppliedValue(key, record[key], normalizeModelProfiles(record.modelProfiles))
    }
  }
}

function normalizeSplitPresetAppliedValue(
  databaseKey: string,
  value: unknown,
  profiles = normalizeModelProfiles(undefined),
): unknown {
  if (databaseKey === 'modelRoles') return normalizeModelRoleOverrides(value)
  if (databaseKey === 'modelProfiles') return normalizeModelProfiles(value)
  if (databaseKey === 'modelProfileOrder') return normalizeModelProfileOrder(value, profiles)
  if (databaseKey === 'modelRoleProfiles') return normalizeModelRoleProfiles(value)
  if (databaseKey === 'modelRuntimeDefaults') return normalizeModelRuntimeDefaults(value)
  if (databaseKey === 'seperateModels') return normalizeLegacySeperateModels(value)
  if (databaseKey === 'fallbackModels') return normalizeLegacyFallbackModels(value)
  if (databaseKey === 'seperateParameters') return normalizeSeperateParametersValue(value)
  if (databaseKey === 'promptTemplate') return normalizePromptTemplateValue(value)
  return value
}

function normalizeSeperateParametersValue(value: unknown): Record<string, unknown> {
  const source = isRecord(value) ? value : {}
  return {
    memory: recordOrBlank(source.memory),
    emotion: recordOrBlank(source.emotion),
    translate: recordOrBlank(source.translate),
    otherAx: recordOrBlank(source.otherAx),
    scriptMain: recordOrBlank(source.scriptMain),
    scriptAux: recordOrBlank(source.scriptAux),
    overrides: repairLegacySeparateParameterOverrides(recordOrBlank(source.overrides)),
  }
}

function recordOrBlank(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function normalizeSelectedIndex(count: number, selected: unknown): number {
  if (!Number.isInteger(selected)) return count > 0 ? 0 : -1
  const index = selected as number
  if (index >= count) return count > 0 ? count - 1 : -1
  if (index < -1) return count > 0 ? 0 : -1
  return index
}

function validateJsonValue(label: string, value: unknown): void {
  try {
    JSON.stringify(value)
  } catch {
    throw new ValidationError(`${label} must be JSON-serializable`)
  }
  if (value === undefined) {
    throw new ValidationError(`${label} must be JSON-serializable`)
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
