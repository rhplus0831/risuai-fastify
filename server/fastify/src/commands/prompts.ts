import { canonicalizeLegacyGenerationValues } from '@risuai/shared-core/legacy-generation-value-canonicalization'
import { randomUUID } from 'node:crypto'
import { PROMPT_SETTINGS_KEYS } from '@risuai/shared-core/prompt-settings'
import { normalizePromptTemplate } from '@risuai/shared-core/prompt-template-normalization'
import { EntityNotFoundError, ValidationError } from '../repository.js'

export { PROMPT_SETTINGS_KEYS } from '@risuai/shared-core/prompt-settings'

type JsonRecord = Record<string, unknown>

export interface PromptItemRecord extends JsonRecord {
  id: string
  type?: unknown
}

export interface PromptItemPatch {
  patch: JsonRecord
  deleteKeys: string[]
}

const PROMPT_SETTINGS_KEY_SET = new Set<string>(PROMPT_SETTINGS_KEYS)

export function normalizePromptTemplateValue(value: unknown[]): PromptItemRecord[]
export function normalizePromptTemplateValue(value: unknown): PromptItemRecord[] | null
export function normalizePromptTemplateValue(value: unknown): PromptItemRecord[] | null {
  // Browser assembly treats null as disabled, while an empty array is an active template.
  const normalized = normalizePromptTemplate(value)
  if (!normalized) return null

  const seen = new Set<string>()
  return normalized.map((raw) => {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as unknown as JsonRecord) : {}
    const rawId = typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID()
    const id = seen.has(rawId) ? randomUUID() : rawId
    seen.add(id)
    item.id = id
    return item as PromptItemRecord
  })
}

export function normalizePromptTemplateCollection(database: unknown): void {
  if (!database || typeof database !== 'object' || Array.isArray(database)) return
  const target = database as JsonRecord
  if ('promptTemplate' in target) {
    target.promptTemplate = normalizePromptTemplateValue(target.promptTemplate)
  }
}

export function createPromptItemRecord(input: unknown): PromptItemRecord {
  const item = readJsonObject(input, 'promptItem') as PromptItemRecord
  if (typeof item.id !== 'string' || item.id.trim() === '') {
    throw new ValidationError('promptItem.id must be a non-empty string')
  }
  return normalizePromptItemRecord(item)
}

export function normalizePromptItemRecord(input: PromptItemRecord): PromptItemRecord {
  const normalized = normalizePromptTemplate([input])?.[0]
  return (normalized && typeof normalized === 'object' ? normalized : input) as PromptItemRecord
}

export function readPromptItemId(value: unknown, label = 'itemId'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label} must be a non-empty string`)
  }
  return value
}

export function readPromptItemPatch(patchInput: unknown, deleteKeysInput: unknown, itemId: string): PromptItemPatch {
  const patch = { ...readJsonObject(patchInput, 'patch') }
  for (const key of Object.keys(patch)) {
    if (key.trim() === '') {
      throw new ValidationError('patch keys must be non-empty strings')
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'id')) {
    if (patch.id !== itemId) {
      throw new ValidationError('patch.id must match itemId')
    }
    // Older clients sent the complete row, including its stable id. Accept the
    // matching id during migration, but never treat it as a mutable field.
    delete patch.id
  }

  const deleteKeys = readPromptItemDeleteKeys(deleteKeysInput)
  for (const key of deleteKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      throw new ValidationError(`patch and deleteKeys must not overlap: ${key}`)
    }
  }
  if (Object.keys(patch).length === 0 && deleteKeys.length === 0) {
    throw new ValidationError('prompt item update must include at least one field')
  }
  return { patch, deleteKeys }
}

function readPromptItemDeleteKeys(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ValidationError('deleteKeys must be an array')
  }

  const deleteKeys: string[] = []
  const seen = new Set<string>()
  for (const key of value) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new ValidationError('deleteKeys must contain non-empty strings')
    }
    if (key === 'id') {
      throw new ValidationError('deleteKeys must not contain id')
    }
    if (seen.has(key)) {
      throw new ValidationError(`Duplicate delete key: ${key}`)
    }
    seen.add(key)
    deleteKeys.push(key)
  }
  return deleteKeys
}

export function readPromptSettingsPatch(patch: unknown): JsonRecord {
  const target = canonicalizeLegacyGenerationValues(readJsonObject(patch, 'patch')) as JsonRecord
  const entries = Object.entries(target)
  if (entries.length === 0) {
    throw new ValidationError('patch must include at least one prompt setting')
  }

  for (const [key, value] of entries) {
    if (!PROMPT_SETTINGS_KEY_SET.has(key)) {
      throw new ValidationError(`Unsupported prompt setting: ${key}`)
    }
    validatePromptSettingValue(key, value)
  }

  return target
}

export function findPromptItemIndex(items: readonly PromptItemRecord[], itemId: string): number {
  return items.findIndex((item) => item.id === itemId)
}

export function requirePromptItemIndex(items: readonly PromptItemRecord[], itemId: string): number {
  const index = findPromptItemIndex(items, itemId)
  if (index === -1) {
    throw new EntityNotFoundError(`Prompt item not found: ${itemId}`)
  }
  return index
}

export function validateFullPromptItemIdList(
  items: readonly PromptItemRecord[],
  itemIds: readonly unknown[],
): asserts itemIds is string[] {
  const existing = new Set(items.map((item) => item.id))
  const seen = new Set<string>()
  if (itemIds.length !== items.length) {
    throw new ValidationError('itemIds must include every existing prompt item id')
  }
  for (const id of itemIds) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ValidationError('itemIds must contain non-empty strings')
    }
    if (seen.has(id)) {
      throw new ValidationError(`Duplicate prompt item id: ${id}`)
    }
    if (!existing.has(id)) {
      throw new ValidationError(`Unknown prompt item id: ${id}`)
    }
    seen.add(id)
  }
}

export function readJsonObject(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`)
  }
  validateJsonValue(label, value)
  return value as JsonRecord
}

function validatePromptSettingValue(key: string, value: unknown): void {
  if (
    [
      'jsonSchemaEnabled',
      'strictJsonSchema',
      'outputImageModal',
      'fallbackWhenBlankResponse',
      'doNotChangeFallbackModels',
    ].includes(key) &&
    typeof value !== 'boolean'
  ) {
    throw new ValidationError(`${key} must be a boolean`)
  }
  if (
    [
      'jsonSchema',
      'extractJson',
      'customPromptTemplateToggle',
      'templateDefaultVariables',
      'OAIPrediction',
      'autoSuggestPrompt',
      'systemContentReplacement',
      'systemRoleReplacement',
      'mainPrompt',
      'jailbreak',
      'globalNote',
    ].includes(key) &&
    typeof value !== 'string'
  ) {
    throw new ValidationError(`${key} must be a string`)
  }
  if (key === 'promptPreprocess' && typeof value !== 'boolean') {
    throw new ValidationError('promptPreprocess must be a boolean')
  }
  if (['formatingOrder', 'presetRegex'].includes(key) && !Array.isArray(value)) {
    throw new ValidationError(`${key} must be an array`)
  }
  if (key === 'promptSettings' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new ValidationError('promptSettings must be an object')
  }
  if (key === 'fallbackModels' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new ValidationError('fallbackModels must be an object')
  }
  validateJsonValue(key, value)
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
