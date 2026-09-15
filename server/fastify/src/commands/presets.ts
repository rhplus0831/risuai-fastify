import {
  repairLegacySeparateParameterOverrides,
  repairLegacySeparateParameters,
} from '@risuai/shared-core/separate-parameter-compatibility'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { EntityNotFoundError, ValidationError } from '../repository.js'
import { validateOptionalServerAssetRef } from './assets.js'
import { normalizePresetLocalStopStrings } from './localStopStrings.js'
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
import {
  normalizeAgentConfiguration,
  normalizeAgentPresetDefaultId,
  normalizeAgents,
  normalizeAgentPresets,
} from '@risuai/shared-core/agent-preset-records'

type JsonRecord = Record<string, unknown>
type AssetValidationOptions = { assetDb?: DatabaseSync }

export interface PresetRecord extends JsonRecord {
  id: string
  name?: string
}

const SNAPSHOT_KEYS: Array<[string, string]> = [
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

const APPLY_KEYS = SNAPSHOT_KEYS.filter(([presetKey]) => presetKey !== 'name')

// Root database fields a legacy bot preset can apply. Projection resources use
// the same source of truth as `applyPreset` so a selected preset refresh cannot
// under-apply new fields added to the legacy format later.
export const LEGACY_BOT_PRESET_APPLY_DATABASE_FIELDS = Array.from(
  new Set(APPLY_KEYS.map(([, databaseKey]) => databaseKey)),
)

export function readJsonObject(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`)
  }
  validateJsonValue(label, value)
  return value as JsonRecord
}

export function readPresetId(value: unknown, label = 'presetId'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label} must be a non-empty string`)
  }
  return value
}

export function readOptionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${label} must be a boolean`)
  }
  return value
}

export function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be a string`)
  }
  return value
}

export function ensureDatabaseObject(database: unknown): JsonRecord {
  if (!database || typeof database !== 'object' || Array.isArray(database)) {
    throw new ValidationError('database must be an object before preset commands can run')
  }
  return database as JsonRecord
}

export function ensurePresetCollection(database: JsonRecord): PresetRecord[] {
  if (!Array.isArray(database.botPresets)) {
    database.botPresets = []
  }

  const seen = new Set<string>()
  const presets = (database.botPresets as unknown[]).map((raw) => {
    const preset = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as JsonRecord) : {}
    const rawId = typeof preset.id === 'string' && preset.id.trim() ? preset.id : randomUUID()
    const id = seen.has(rawId) ? randomUUID() : rawId
    seen.add(id)
    preset.id = id
    if (Object.hasOwn(preset, 'seperateParameters')) {
      preset.seperateParameters = repairLegacySeparateParameters(preset.seperateParameters)
    }
    return preset as PresetRecord
  })
  database.botPresets = presets

  if (!Number.isInteger(database.botPresetsId as number)) {
    database.botPresetsId = presets.length > 0 ? 0 : -1
  }
  if ((database.botPresetsId as number) >= presets.length) {
    database.botPresetsId = presets.length > 0 ? presets.length - 1 : -1
  }
  if ((database.botPresetsId as number) < -1) {
    database.botPresetsId = presets.length > 0 ? 0 : -1
  }

  return presets
}

export function normalizePresetCollection(database: unknown): void {
  const target = ensureDatabaseObject(database)
  ensurePresetCollection(target)
}

export function createPresetRecord(
  input: JsonRecord,
  fallbackName = 'New Preset',
  options: AssetValidationOptions = {},
): PresetRecord {
  const preset = cloneJson(input) as PresetRecord
  normalizePresetLocalStopStrings(preset, 'preset')
  preset.id = readPresetId(preset.id, 'preset.id')
  if (preset.name !== undefined && typeof preset.name !== 'string') {
    throw new ValidationError('preset.name must be a string')
  }
  normalizePresetProfileFields(preset)
  validatePresetAssetRefs(preset, 'preset', options)
  preset.name ??= fallbackName
  return preset
}

export function readPresetPatch(input: JsonRecord, options: AssetValidationOptions = {}): JsonRecord {
  const patch = cloneJson(input) as JsonRecord
  normalizePresetLocalStopStrings(patch, 'patch')
  normalizePresetProfileFields(patch)
  validatePresetAssetRefs(patch, 'patch', options)
  return patch
}

export function normalizePresetAgentSettings(record: JsonRecord): void {
  normalizePresetAgentFields(record)
}

export function findPresetIndex(presets: readonly PresetRecord[], presetId: string): number {
  return presets.findIndex((preset) => preset.id === presetId)
}

export function requirePresetIndex(presets: readonly PresetRecord[], presetId: string): number {
  const index = findPresetIndex(presets, presetId)
  if (index === -1) {
    throw new EntityNotFoundError(`Preset not found: ${presetId}`)
  }
  return index
}

export function selectedPresetId(database: JsonRecord, presets: readonly PresetRecord[]): string | null {
  const index = Number.isInteger(database.botPresetsId as number) ? (database.botPresetsId as number) : -1
  return presets[index]?.id ?? null
}

export function saveCurrentPresetSnapshot(database: JsonRecord, presets: PresetRecord[]): void {
  const index = Number.isInteger(database.botPresetsId as number) ? (database.botPresetsId as number) : -1
  if (index < 0 || index >= presets.length) return

  const current = presets[index]
  const snapshot: PresetRecord = {
    id: current.id,
    name: typeof current.name === 'string' ? current.name : 'New Preset',
  }
  for (const [presetKey, databaseKey] of SNAPSHOT_KEYS) {
    if (presetKey === 'name') continue
    if (Object.prototype.hasOwnProperty.call(database, databaseKey)) {
      snapshot[presetKey] = cloneJson(database[databaseKey])
    }
  }
  snapshot.image = current.image ?? ''
  presets[index] = snapshot
}

export function applyPreset(database: JsonRecord, preset: PresetRecord): void {
  let appliedAgentPresetSettings = false
  for (const [presetKey, databaseKey] of APPLY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(preset, presetKey)) {
      database[databaseKey] = normalizePresetAppliedValue(
        databaseKey,
        cloneJson(preset[presetKey]),
        normalizeModelProfiles(database.modelProfiles),
      )
      if (databaseKey === 'agents' || databaseKey === 'agentPresets' || databaseKey === 'agentPresetDefaultId') {
        appliedAgentPresetSettings = true
      }
    }
  }
  if (appliedAgentPresetSettings) {
    normalizeDatabaseAgentPresetSettings(database)
  }
}

function normalizePresetAppliedValue(
  databaseKey: string,
  value: unknown,
  profiles = normalizeModelProfiles(undefined),
): unknown {
  if (databaseKey === 'modelRoles') return normalizeModelRoleOverrides(value)
  if (databaseKey === 'modelProfiles') return normalizeModelProfiles(value)
  if (databaseKey === 'modelProfileOrder') return normalizeModelProfileOrder(value, profiles)
  if (databaseKey === 'modelRoleProfiles') return normalizeModelRoleProfiles(value)
  if (databaseKey === 'modelRuntimeDefaults') return normalizeModelRuntimeDefaults(value)
  if (databaseKey === 'agents') return normalizeAgents(value)
  if (databaseKey === 'agentPresets') return normalizeAgentPresets(value)
  if (databaseKey === 'seperateModels') return normalizeLegacySeperateModels(value)
  if (databaseKey === 'fallbackModels') return normalizeLegacyFallbackModels(value)
  if (databaseKey === 'seperateParameters') return normalizeSeperateParametersValue(value)
  return value
}

function normalizePresetProfileFields(record: JsonRecord): void {
  if (Object.hasOwn(record, 'seperateParameters')) {
    record.seperateParameters = repairLegacySeparateParameters(record.seperateParameters)
  }
  if (Object.prototype.hasOwnProperty.call(record, 'modelProfiles')) {
    record.modelProfiles = normalizeModelProfiles(record.modelProfiles)
  }
  if (Object.prototype.hasOwnProperty.call(record, 'modelProfileOrder')) {
    record.modelProfileOrder = normalizeModelProfileOrder(
      record.modelProfileOrder,
      normalizeModelProfiles(record.modelProfiles),
    )
  }
  if (Object.prototype.hasOwnProperty.call(record, 'modelRoleProfiles')) {
    record.modelRoleProfiles = normalizeModelRoleProfiles(record.modelRoleProfiles)
  }
  if (Object.prototype.hasOwnProperty.call(record, 'modelRuntimeDefaults')) {
    record.modelRuntimeDefaults = normalizeModelRuntimeDefaults(record.modelRuntimeDefaults)
  }
  normalizePresetAgentFields(record)
}

function normalizePresetAgentFields(record: JsonRecord): void {
  if (Object.prototype.hasOwnProperty.call(record, 'agentPresets')) {
    const normalized = normalizeAgentConfiguration(record.agents, record.agentPresets)
    record.agents = normalized.agents
    record.agentPresets = normalized.agentPresets
    const agentPresets = normalized.agentPresets
    if (Object.prototype.hasOwnProperty.call(record, 'agentPresetDefaultId')) {
      const defaultId = normalizeAgentPresetDefaultId(record.agentPresetDefaultId, agentPresets)
      if (defaultId) {
        record.agentPresetDefaultId = defaultId
      } else {
        delete record.agentPresetDefaultId
      }
    }
    return
  }

  if (
    Object.prototype.hasOwnProperty.call(record, 'agentPresetDefaultId') &&
    typeof record.agentPresetDefaultId !== 'string'
  ) {
    delete record.agentPresetDefaultId
  }
}

function normalizeDatabaseAgentPresetSettings(database: JsonRecord): void {
  const normalized = normalizeAgentConfiguration(database.agents, database.agentPresets)
  database.agents = normalized.agents
  database.agentPresets = normalized.agentPresets
  const agentPresets = normalized.agentPresets
  const defaultId = normalizeAgentPresetDefaultId(database.agentPresetDefaultId, agentPresets)
  if (defaultId) {
    database.agentPresetDefaultId = defaultId
  } else {
    delete database.agentPresetDefaultId
  }
}

function normalizeSeperateParametersValue(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
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
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function validateFullPresetIdList(presets: readonly PresetRecord[], presetIds: readonly string[]): void {
  const existing = new Set(presets.map((preset) => preset.id))
  const seen = new Set<string>()
  if (presetIds.length !== presets.length) {
    throw new ValidationError('presetIds must include every existing preset id')
  }
  for (const id of presetIds) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ValidationError('presetIds must contain non-empty strings')
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

function validatePresetAssetRefs(record: JsonRecord, label: string, options: AssetValidationOptions): void {
  if (options.assetDb && 'image' in record) {
    validateOptionalServerAssetRef(options.assetDb, record.image, `${label}.image`)
  }
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
