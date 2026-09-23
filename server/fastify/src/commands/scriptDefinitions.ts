import { createHash, randomUUID } from 'node:crypto'
import type { TriggerMode } from '../prompt/triggers.js'
import { EntityNotFoundError, ValidationError } from '../repository.js'
import { type CharacterRecord, readCharacterId, readJsonObject } from './characters.js'
import { ensureModuleCollection, readModuleId, requireModule, type ModuleRecord } from './lorebooks.js'
import { serializeScriptDefinitionCollectionDigestInput } from '@risuai/shared-core/mutation-certificates'

type JsonRecord = Record<string, unknown>

const VALID_TRIGGER_MODES = new Set<TriggerMode>(['start', 'manual', 'output', 'input', 'display', 'request'])

export interface ScriptDefinitionRecord extends JsonRecord {
  id: string
}

export interface TriggerDefinitionRecord extends JsonRecord {
  id: string
}

export type DefinitionCollectionMutation =
  | { op: 'update'; id: string; patch: JsonRecord; deleteKeys: string[] }
  | { op: 'create'; row: JsonRecord; index: number }
  | { op: 'delete'; id: string }
  | { op: 'reorder'; ids: string[] }

type DefinitionKind = 'script' | 'trigger'

export function normalizeScriptDefinitionDatabase(database: unknown): JsonRecord {
  const target = readJsonObject(database, 'database')
  ensureAllScriptDefinitionCollections(target)
  return target
}

export function normalizeScriptDefinitionCollection(database: unknown): void {
  if (!database || typeof database !== 'object' || Array.isArray(database)) return
  ensureAllScriptDefinitionCollections(database as JsonRecord)
}

export function ensureAllScriptDefinitionCollections(database: JsonRecord): void {
  if (Array.isArray(database.characters)) {
    for (const rawCharacter of database.characters) {
      if (!rawCharacter || typeof rawCharacter !== 'object' || Array.isArray(rawCharacter)) {
        continue
      }
      const character = rawCharacter as CharacterRecord
      const label =
        typeof character.chaId === 'string' && character.chaId.trim() ? `character ${character.chaId}` : 'character'
      if (Array.isArray(character.customscript)) {
        character.customscript = repairScriptDefinitions(character.customscript, `${label}.customscript`)
      }
      if (Array.isArray(character.triggerscript)) {
        character.triggerscript = repairTriggerDefinitions(character.triggerscript, `${label}.triggerscript`)
      }
    }
  }

  if (Array.isArray(database.modules)) {
    for (const rawModule of database.modules) {
      if (!rawModule || typeof rawModule !== 'object' || Array.isArray(rawModule)) {
        continue
      }
      const module = rawModule as ModuleRecord
      const label = typeof module.id === 'string' && module.id.trim() ? `module ${module.id}` : 'module'
      if (Array.isArray(module.regex)) {
        module.regex = repairScriptDefinitions(module.regex, `${label}.regex`)
      }
      if (Array.isArray(module.trigger)) {
        module.trigger = repairTriggerDefinitions(module.trigger, `${label}.trigger`)
      }
    }
  }
}

export function readCharacterScriptParent(database: JsonRecord, characterId: unknown): CharacterRecord {
  const id = readCharacterId(characterId)
  const characters = Array.isArray(database.characters) ? database.characters : []
  let character: CharacterRecord | undefined
  for (const candidate of characters) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    if ((candidate as Record<string, unknown>).chaId !== id) continue
    if (character) {
      throw new ValidationError(`Duplicate character id: ${id}`)
    }
    character = candidate as CharacterRecord
  }
  if (!character) {
    throw new EntityNotFoundError(`Character not found: ${id}`)
  }
  return character
}

export function readModuleScriptParent(database: JsonRecord, moduleId: unknown): ModuleRecord {
  return requireModule(ensureModuleCollection(database), readModuleId(moduleId))
}

export function readScriptDefinitions(input: unknown, label = 'scripts'): ScriptDefinitionRecord[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(`${label} must be an array`)
  }
  return validateScriptDefinitions(input, label)
}

export function readTriggerDefinitions(input: unknown, label = 'triggers'): TriggerDefinitionRecord[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(`${label} must be an array`)
  }
  return validateTriggerDefinitions(input, label)
}

export function readDefinitionCollectionMutation(input: unknown): DefinitionCollectionMutation {
  const mutation = readJsonObject(input, 'mutation')
  switch (mutation.op) {
    case 'update': {
      assertExactMutationKeys(mutation, 'update', ['op', 'id', 'patch', 'deleteKeys'])
      const id = readDefinitionMutationId(mutation.id, 'mutation.id')
      const patch = mutation.patch === undefined ? {} : readJsonObject(mutation.patch, 'mutation.patch')
      const deleteKeys = readDefinitionMutationFieldList(mutation.deleteKeys)
      if (Object.keys(patch).length === 0 && deleteKeys.length === 0) {
        throw new ValidationError('update mutation must include patch fields or deleteKeys')
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'id')) {
        throw new ValidationError('mutation.patch.id is not supported')
      }
      for (const key of deleteKeys) {
        if (key === 'id') {
          throw new ValidationError('mutation.deleteKeys cannot include id')
        }
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          throw new ValidationError(`mutation.deleteKeys cannot also patch ${key}`)
        }
      }
      return { op: 'update', id, patch, deleteKeys }
    }
    case 'create': {
      assertExactMutationKeys(mutation, 'create', ['op', 'row', 'index'])
      const row = readJsonObject(mutation.row, 'mutation.row')
      if (!Number.isInteger(mutation.index) || (mutation.index as number) < 0) {
        throw new ValidationError('mutation.index must be a non-negative integer')
      }
      return { op: 'create', row, index: mutation.index as number }
    }
    case 'delete':
      assertExactMutationKeys(mutation, 'delete', ['op', 'id'])
      return { op: 'delete', id: readDefinitionMutationId(mutation.id, 'mutation.id') }
    case 'reorder':
      assertExactMutationKeys(mutation, 'reorder', ['op', 'ids'])
      return { op: 'reorder', ids: readDefinitionMutationIdList(mutation.ids) }
    default:
      throw new ValidationError(`Unsupported definition mutation operation: ${String(mutation.op)}`)
  }
}

export function applyScriptDefinitionCollectionMutation(
  input: unknown,
  mutation: DefinitionCollectionMutation,
  label = 'scripts',
): ScriptDefinitionRecord[] {
  return applyDefinitionCollectionMutation(input, mutation, label, 'script') as ScriptDefinitionRecord[]
}

export function scriptDefinitionCollectionDigest(definitions: readonly unknown[]): string {
  return createHash('sha256').update(serializeScriptDefinitionCollectionDigestInput(definitions), 'utf8').digest('hex')
}

export function applyTriggerDefinitionCollectionMutation(
  input: unknown,
  mutation: DefinitionCollectionMutation,
  label = 'triggers',
): TriggerDefinitionRecord[] {
  return applyDefinitionCollectionMutation(input, mutation, label, 'trigger') as TriggerDefinitionRecord[]
}

function applyDefinitionCollectionMutation(
  input: unknown,
  mutation: DefinitionCollectionMutation,
  label: string,
  kind: DefinitionKind,
): JsonRecord[] {
  const definitions = readCurrentDefinitionCollection(input, label, kind)
  switch (mutation.op) {
    case 'update': {
      const index = definitions.findIndex((definition) => definition.id === mutation.id)
      if (index === -1) throw definitionNotFound(kind, mutation.id)
      const next: JsonRecord = { ...definitions[index], ...mutation.patch, id: mutation.id }
      for (const key of mutation.deleteKeys) delete next[key]
      validateDefinitionRecord(next, `${label}[${index}]`, kind)
      const updated = [...definitions]
      updated[index] = next
      return updated
    }
    case 'create': {
      const created = validateDefinitionRecords([mutation.row], label, kind)[0]
      if (definitions.some((definition) => definition.id === created.id)) {
        throw new ValidationError(`Duplicate ${kind} definition id: ${created.id}`)
      }
      if (mutation.index > definitions.length) {
        throw new ValidationError(`mutation.index must be at most ${definitions.length}`)
      }
      const updated = [...definitions]
      updated.splice(mutation.index, 0, created)
      return updated
    }
    case 'delete': {
      const index = definitions.findIndex((definition) => definition.id === mutation.id)
      if (index === -1) throw definitionNotFound(kind, mutation.id)
      return definitions.filter((_definition, definitionIndex) => definitionIndex !== index)
    }
    case 'reorder': {
      const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
      for (const id of mutation.ids) {
        if (!definitionsById.has(id)) {
          throw new ValidationError(`Unknown ${kind} definition id in mutation.ids: ${id}`)
        }
      }
      if (mutation.ids.length !== definitions.length) {
        throw new ValidationError(`mutation.ids must include every ${kind} definition`)
      }
      return mutation.ids.map((id) => definitionsById.get(id)!)
    }
  }
}

function readCurrentDefinitionCollection(input: unknown, label: string, kind: DefinitionKind): JsonRecord[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    throw new ValidationError(`${label} must be an array`)
  }
  return validateDefinitionRecords(input, label, kind)
}

function assertExactMutationKeys(mutation: JsonRecord, operation: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(mutation)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`mutation.${key} is not supported for ${operation}`)
    }
  }
}

function readDefinitionMutationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label} must be a non-empty string`)
  }
  return value
}

function readDefinitionMutationFieldList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ValidationError('mutation.deleteKeys must be an array')
  }
  const seen = new Set<string>()
  return value.map((key, index) => {
    const parsed = readDefinitionMutationId(key, `mutation.deleteKeys[${index}]`)
    if (seen.has(parsed)) {
      throw new ValidationError(`Duplicate mutation.deleteKeys field: ${parsed}`)
    }
    seen.add(parsed)
    return parsed
  })
}

function readDefinitionMutationIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError('mutation.ids must be an array')
  }
  const seen = new Set<string>()
  return value.map((id, index) => {
    const parsed = readDefinitionMutationId(id, `mutation.ids[${index}]`)
    if (seen.has(parsed)) {
      throw new ValidationError(`Duplicate definition id in mutation.ids: ${parsed}`)
    }
    seen.add(parsed)
    return parsed
  })
}

function definitionNotFound(kind: DefinitionKind, id: string): EntityNotFoundError {
  const label = kind === 'script' ? 'Script' : 'Trigger'
  return new EntityNotFoundError(`${label} definition not found: ${id}`)
}

function repairScriptDefinitions(input: unknown[], label: string): ScriptDefinitionRecord[] {
  return repairDefinitionRecords(input, label, 'script') as ScriptDefinitionRecord[]
}

function repairTriggerDefinitions(input: unknown[], label: string): TriggerDefinitionRecord[] {
  return repairDefinitionRecords(input, label, 'trigger') as TriggerDefinitionRecord[]
}

function validateScriptDefinitions(input: unknown[], label: string): ScriptDefinitionRecord[] {
  return validateDefinitionRecords(input, label, 'script') as ScriptDefinitionRecord[]
}

function validateTriggerDefinitions(input: unknown[], label: string): TriggerDefinitionRecord[] {
  return validateDefinitionRecords(input, label, 'trigger') as TriggerDefinitionRecord[]
}

function repairDefinitionRecords(input: unknown[], label: string, kind: 'script' | 'trigger'): JsonRecord[] {
  const seen = new Set<string>()
  return input.map((raw, index) => {
    const record = readJsonObject(raw, `${label}[${index}]`)
    const id = typeof record.id === 'string' && record.id.trim() ? record.id : randomUUID()
    const normalizedId = seen.has(id) ? randomUUID() : id
    record.id = normalizedId
    seen.add(normalizedId)
    if (
      kind === 'trigger' &&
      Array.isArray(record.type) &&
      record.type.length === 1 &&
      VALID_TRIGGER_MODES.has(record.type[0] as TriggerMode)
    ) {
      // See "V2 Triggers And Unsupported Effects": only the import repair path
      // canonicalizes this legacy/foreign tuple; strict command writes do not.
      record.type = record.type[0]
    }
    validateDefinitionRecord(record, `${label}[${index}]`, kind)
    return record
  })
}

function validateDefinitionRecords(input: unknown[], label: string, kind: 'script' | 'trigger'): JsonRecord[] {
  const seen = new Set<string>()
  return input.map((raw, index) => {
    const record = readJsonObject(raw, `${label}[${index}]`)
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      throw new ValidationError(`${label}[${index}].id must be a non-empty string`)
    }
    if (seen.has(record.id)) {
      throw new ValidationError(`Duplicate ${kind} definition id: ${record.id}`)
    }
    seen.add(record.id)
    validateDefinitionRecord(record, `${label}[${index}]`, kind)
    return record
  })
}

function validateDefinitionRecord(record: JsonRecord, label: string, kind: 'script' | 'trigger'): void {
  if (kind === 'script') {
    for (const key of ['comment', 'in', 'out', 'type']) {
      if (key in record && typeof record[key] !== 'string') {
        throw new ValidationError(`${label}.${key} must be a string`)
      }
    }
    if ('flag' in record && record.flag !== undefined && typeof record.flag !== 'string') {
      throw new ValidationError(`${label}.flag must be a string`)
    }
    if ('ableFlag' in record && record.ableFlag !== undefined && typeof record.ableFlag !== 'boolean') {
      throw new ValidationError(`${label}.ableFlag must be a boolean`)
    }
    return
  }

  if ('comment' in record && typeof record.comment !== 'string') {
    throw new ValidationError(`${label}.comment must be a string`)
  }
  if ('type' in record && typeof record.type !== 'string') {
    throw new ValidationError(`${label}.type must be a string`)
  }
  if ('conditions' in record && !Array.isArray(record.conditions)) {
    throw new ValidationError(`${label}.conditions must be an array`)
  }
  if ('effect' in record && !Array.isArray(record.effect)) {
    throw new ValidationError(`${label}.effect must be an array`)
  }
}
