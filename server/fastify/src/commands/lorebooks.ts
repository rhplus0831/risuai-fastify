import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { EntityNotFoundError, ValidationError } from '../repository.js'
import { type CharacterRecord, ensureCharacterCollection, readCharacterId, readJsonObject } from './characters.js'
import { ensureCharacterChats, readChatId } from './chats.js'

type JsonRecord = Record<string, unknown>

const REQUIRED_LOREBOOK_ENTRY_KEYS = new Set([
  'key',
  'secondkey',
  'insertorder',
  'comment',
  'content',
  'mode',
  'alwaysActive',
  'selective',
])

export interface LorebookEntryRecord extends JsonRecord {
  id: string
  key: string
  secondkey: string
  insertorder: number
  comment: string
  content: string
  mode: string
  alwaysActive: boolean
  selective: boolean
  agentOnly?: boolean
  folder?: string
}

export interface GlobalLorebookRecord extends JsonRecord {
  id: string
  name: string
  data: LorebookEntryRecord[]
}

export interface ModuleRecord extends JsonRecord {
  id: string
  lorebook?: LorebookEntryRecord[]
  mcp?: unknown
}

export type LorebookEntryWrite =
  | { kind: 'full'; entry: LorebookEntryRecord }
  | { kind: 'sparse'; patch: JsonRecord; deleteKeys: string[] }

export interface LorebookEntryWriteResult {
  index: number
  created: boolean
  patchedKeys?: string[]
  deletedKeys?: string[]
}

export function ensureLorebookDatabase(database: unknown): JsonRecord {
  const target = readJsonObject(database, 'database')
  ensureGlobalLorebookCollection(target)
  ensureAllChildLorebooks(target)
  return target
}

export function ensureGlobalLorebookCollection(database: JsonRecord): GlobalLorebookRecord[] {
  if (!Array.isArray(database.loreBook)) {
    database.loreBookPage = 0
    database.loreBook = [{ name: 'My First LoreBook', data: [] }]
  }

  const seen = new Set<string>()
  const lorebooks = (database.loreBook as unknown[]).map((raw, index) => {
    const lorebook = repairGlobalLorebookRecord(
      {
        name: `LoreBook ${index + 1}`,
        data: [],
        ...readOptionalJsonObject(raw),
      },
      `loreBook[${index}]`,
    )
    if (seen.has(lorebook.id)) {
      lorebook.id = randomUUID()
    }
    seen.add(lorebook.id)
    return lorebook
  })

  database.loreBook = lorebooks
  normalizeLorebookPage(database, lorebooks)
  return lorebooks
}

export function ensureAllChildLorebooks(database: JsonRecord): void {
  if (Array.isArray(database.characters)) {
    const characters = ensureCharacterCollection(database)
    for (const character of characters) {
      ensureCharacterLorebooks(character)
      for (const chat of ensureCharacterChats(character)) {
        chat.localLore = repairLorebookEntries(chat.localLore, `chat ${chat.id}.localLore`)
      }
    }
  }

  if (Array.isArray(database.modules)) {
    for (const rawModule of database.modules) {
      if (!rawModule || typeof rawModule !== 'object' || Array.isArray(rawModule)) {
        continue
      }
      const module = rawModule as ModuleRecord
      if (Array.isArray(module.lorebook)) {
        const label = typeof module.id === 'string' && module.id.trim() ? `module ${module.id}` : 'module'
        module.lorebook = repairLorebookEntries(module.lorebook, `${label}.lorebook`)
      }
    }
  }
}

export function ensureCharacterLorebooks(character: CharacterRecord): LorebookEntryRecord[] {
  character.globalLore = repairLorebookEntries(
    Array.isArray(character.globalLore) ? character.globalLore : [],
    `character ${character.chaId}.globalLore`,
  )
  return character.globalLore as LorebookEntryRecord[]
}

export function ensureModuleCollection(database: JsonRecord): ModuleRecord[] {
  if (!Array.isArray(database.modules)) {
    database.modules = []
  }

  const seen = new Set<string>()
  const modules = (database.modules as unknown[]).map((raw, index) => {
    const module = readJsonObject(
      {
        name: `Module ${index + 1}`,
        lorebook: [],
        ...readOptionalJsonObject(raw),
      },
      `module[${index}]`,
    ) as ModuleRecord
    module.id = typeof module.id === 'string' && module.id.trim() ? module.id : randomUUID()
    if (seen.has(module.id)) {
      module.id = randomUUID()
    }
    seen.add(module.id)
    module.lorebook = repairLorebookEntries(module.lorebook ?? [], `module ${module.id}.lorebook`)
    return module
  })
  database.modules = modules
  return modules
}

// Command-path constructor. Rejects request payloads that omit entry ids;
// the public route caller is responsible for supplying stable ids.
export function validateGlobalLorebookCreate(input: unknown, label = 'lorebook'): GlobalLorebookRecord {
  const lorebook = readJsonObject(input, label) as GlobalLorebookRecord
  lorebook.id = readLorebookId(lorebook.id, `${label}.id`)
  lorebook.name = typeof lorebook.name === 'string' && lorebook.name.trim() ? lorebook.name : 'New LoreBook'
  lorebook.data = validateLorebookEntries(lorebook.data ?? [], `${label}.data`)
  validateGlobalLorebookRecord(lorebook, label)
  return lorebook
}

// Import/bootstrap-only repair-permissive constructor. Allowed to mint
// missing entry ids on degraded persisted state but never reachable from a
// command-path route handler.
export function createGlobalLorebookRecord(input: unknown, label = 'lorebook'): GlobalLorebookRecord {
  const lorebook = readJsonObject(input, label) as GlobalLorebookRecord
  lorebook.id = readLorebookId(lorebook.id, `${label}.id`)
  lorebook.name = typeof lorebook.name === 'string' && lorebook.name.trim() ? lorebook.name : 'New LoreBook'
  lorebook.data = repairLorebookEntries(lorebook.data ?? [], `${label}.data`)
  validateGlobalLorebookRecord(lorebook, label)
  return lorebook
}

export function repairGlobalLorebookRecord(input: unknown, label = 'lorebook'): GlobalLorebookRecord {
  const lorebook = readJsonObject(input, label) as GlobalLorebookRecord
  lorebook.id = typeof lorebook.id === 'string' && lorebook.id.trim() ? lorebook.id : randomUUID()
  lorebook.name = typeof lorebook.name === 'string' && lorebook.name.trim() ? lorebook.name : 'New LoreBook'
  lorebook.data = repairLorebookEntries(lorebook.data ?? [], `${label}.data`)
  validateGlobalLorebookRecord(lorebook, label)
  return lorebook
}

export function readGlobalLorebookPatch(input: unknown): JsonRecord {
  const patch = readJsonObject(input, 'patch')
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('patch must include at least one lorebook field')
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'name') {
      throw new ValidationError(`patch.${key} is not supported for lorebook commands`)
    }
  }
  if (typeof patch.name !== 'string' || patch.name.trim() === '') {
    throw new ValidationError('patch.name must be a non-empty string')
  }
  return patch
}

export function readLorebookId(value: unknown, label = 'lorebookId'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label} must be a non-empty string`)
  }
  return value
}

export function readLorebookIdList(input: unknown, label = 'lorebookIds'): string[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(`${label} must be an array`)
  }
  return input.map((id, index) => readLorebookId(id, `${label}[${index}]`))
}

/**
 * Read persisted global lorebooks without repairing or reconstructing any row.
 * Collection identities are validated together so a command can never select
 * the first of duplicate targets.
 */
export function readStrictGlobalLorebookCollection(database: JsonRecord): GlobalLorebookRecord[] {
  if (!Array.isArray(database.loreBook)) {
    throw new ValidationError('loreBook must be an array')
  }
  const seen = new Set<string>()
  return database.loreBook.map((raw, index) => {
    const lorebook = readJsonObject(raw, `loreBook[${index}]`) as GlobalLorebookRecord
    const id = readLorebookId(lorebook.id, `loreBook[${index}].id`)
    if (seen.has(id)) {
      throw new ValidationError(`Duplicate lorebook id: ${id}`)
    }
    seen.add(id)
    return lorebook
  })
}

/** Validate one stored global lorebook exactly as represented on disk. */
export function validateStoredGlobalLorebook(
  lorebook: GlobalLorebookRecord,
  label = 'lorebook',
): LorebookEntryRecord[] {
  validateGlobalLorebookRecord(lorebook, label)
  return validateStoredLorebookEntries(lorebook.data, `${label}.data`)
}

// Command-path entry validator. It must not mint ids directly or transitively.
export function validateLorebookEntries(input: unknown, label = 'entries'): LorebookEntryRecord[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(`${label} must be an array`)
  }
  const seen = new Set<string>()
  return input.map((raw, index) => {
    const entry = validateLorebookEntry(raw, `${label}[${index}]`)
    if (seen.has(entry.id)) {
      throw new ValidationError(`Duplicate lorebook entry id: ${entry.id}`)
    }
    seen.add(entry.id)
    return entry
  })
}

/**
 * Persisted-state validator for ordinary commands. Unlike repair helpers it
 * never fills entry fields or mints replacement identities.
 */
export function validateStoredLorebookEntries(input: unknown, label: string): LorebookEntryRecord[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(`${label} must be an array`)
  }
  const seen = new Set<string>()
  for (let index = 0; index < input.length; index++) {
    const entryLabel = `${label}[${index}]`
    const entry = readJsonObject(input[index], entryLabel) as LorebookEntryRecord
    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      throw new ValidationError(`${entryLabel}.id must be a non-empty string`)
    }
    validateLorebookEntryRecord(entry, entryLabel)
    if (seen.has(entry.id)) {
      throw new ValidationError(`Duplicate lorebook entry id: ${entry.id}`)
    }
    seen.add(entry.id)
  }
  return input as LorebookEntryRecord[]
}

export function requireGlobalLorebookIndex(lorebooks: readonly GlobalLorebookRecord[], lorebookId: string): number {
  const matches = lorebooks
    .map((lorebook, index) => ({ lorebook, index }))
    .filter(({ lorebook }) => lorebook.id === lorebookId)
  if (matches.length === 0) {
    throw new EntityNotFoundError(`Lorebook not found: ${lorebookId}`)
  }
  if (matches.length !== 1) {
    throw new ValidationError(`Duplicate lorebook id: ${lorebookId}`)
  }
  return matches[0].index
}

export function requireModule<T extends ModuleRecord>(modules: readonly T[], moduleId: string): T {
  const matches = modules.filter((candidate) => candidate.id === moduleId)
  if (matches.length === 0) {
    throw new EntityNotFoundError(`Module not found: ${moduleId}`)
  }
  if (matches.length !== 1) {
    throw new ValidationError(`Duplicate module id: ${moduleId}`)
  }
  if (matches[0].mcp) {
    throw new EntityNotFoundError(`Module not found: ${moduleId}`)
  }
  return matches[0]
}

export function readModuleId(value: unknown, label = 'moduleId'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label} must be a non-empty string`)
  }
  return value
}

export function validateFullLorebookOrder(
  lorebooks: readonly GlobalLorebookRecord[],
  lorebookIds: readonly string[],
): void {
  const existing = new Set(lorebooks.map((lorebook) => lorebook.id))
  const seen = new Set<string>()
  for (const lorebookId of lorebookIds) {
    if (!existing.has(lorebookId)) {
      throw new ValidationError(`Unknown lorebook id in lorebookIds: ${lorebookId}`)
    }
    if (seen.has(lorebookId)) {
      throw new ValidationError(`Duplicate lorebook id in lorebookIds: ${lorebookId}`)
    }
    seen.add(lorebookId)
  }
  if (seen.size !== existing.size) {
    throw new ValidationError('lorebookIds must include every lorebook')
  }
}

// Persisted-state repair mapper. It may mint replacement ids while normalizing
// loaded lorebooks; request payloads must use `validateLorebookEntries`.
export function repairLorebookEntries(input: unknown, label: string): LorebookEntryRecord[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(`${label} must be an array`)
  }

  const seen = new Set<string>()
  return input.map((raw, index) => {
    const entry = repairLorebookEntry(raw, `${label}[${index}]`)
    if (seen.has(entry.id)) {
      entry.id = randomUUID()
    }
    seen.add(entry.id)
    return entry
  })
}

/** Repair command-create payloads while making unexpected client regressions loud. */
export function repairCreatedLorebookEntries(input: unknown, label: string): LorebookEntryRecord[] {
  const mintedIds = lorebookEntryIdsNeedRepair(input)
  const entries = repairLorebookEntries(input, label)
  if (mintedIds) {
    console.warn(`Command create minted missing or duplicate lorebook entry ids in ${label}`)
  }
  return entries
}

function lorebookEntryIdsNeedRepair(input: unknown): boolean {
  if (!Array.isArray(input)) return false
  const seen = new Set<string>()
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return true
    const id = (candidate as JsonRecord).id
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) return true
    seen.add(id)
  }
  return false
}

export function normalizeSelectedCharacterLorebooks(
  database: unknown,
  characterId: string,
): { character: CharacterRecord; characterIndex: number; entries: LorebookEntryRecord[] } {
  const target = readJsonObject(database, 'database')
  const characters = Array.isArray(target.characters) ? target.characters : []
  const matches: Array<{ character: CharacterRecord; characterIndex: number }> = []
  for (let characterIndex = 0; characterIndex < characters.length; characterIndex++) {
    const candidate = characters[characterIndex]
    if (isJsonRecord(candidate) && candidate.chaId === characterId) {
      matches.push({ character: candidate as CharacterRecord, characterIndex })
    }
  }
  if (matches.length === 0) {
    throw new EntityNotFoundError(`Character not found: ${characterId}`)
  }
  if (matches.length !== 1) {
    throw new ValidationError(`Duplicate character id: ${characterId}`)
  }
  const { character, characterIndex } = matches[0]
  const entries =
    character.globalLore === undefined
      ? []
      : validateStoredLorebookEntries(character.globalLore, `character ${character.chaId}.globalLore`)
  return { character, characterIndex, entries }
}

export function normalizeSelectedChatLorebooks(
  database: unknown,
  chatId: string,
): {
  character: CharacterRecord
  chat: JsonRecord
  entries: LorebookEntryRecord[]
  parentId: string
} {
  const target = readJsonObject(database, 'database')
  const characters = Array.isArray(target.characters) ? target.characters : []
  const matches: Array<{ character: CharacterRecord; chat: JsonRecord }> = []
  for (const rawCharacter of characters) {
    if (!isJsonRecord(rawCharacter) || !Array.isArray(rawCharacter.chats)) continue
    for (const rawChat of rawCharacter.chats) {
      if (isJsonRecord(rawChat) && rawChat.id === chatId) {
        matches.push({ character: rawCharacter as CharacterRecord, chat: rawChat })
      }
    }
  }
  if (matches.length === 0) {
    throw new EntityNotFoundError(`Chat not found: ${chatId}`)
  }
  if (matches.length !== 1) {
    throw new ValidationError(`Duplicate chat id: ${chatId}`)
  }
  const { character, chat } = matches[0]
  const parentId = readCharacterId(character.chaId, `chat ${chatId} parent character id`)
  const entries =
    chat.localLore === undefined ? [] : validateStoredLorebookEntries(chat.localLore, `chat ${chatId}.localLore`)
  return {
    character,
    chat,
    entries,
    parentId,
  }
}

function lorebookEntryFromInput(
  input: unknown,
  label: string,
  options: { repair?: boolean } = {},
): LorebookEntryRecord {
  const raw = readOptionalJsonObject(input)
  const fields = options.repair ? repairLorebookEntryFields(raw) : raw
  return readJsonObject(
    {
      key: '',
      secondkey: '',
      insertorder: 100,
      comment: '',
      content: '',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
      ...fields,
    },
    label,
  ) as LorebookEntryRecord
}

// Command-path single-entry validator. It must not mint ids.
export function validateLorebookEntry(input: unknown, label = 'entry'): LorebookEntryRecord {
  const entry = lorebookEntryFromInput(input, label)
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    throw new ValidationError(`${label}.id must be a non-empty string`)
  }
  validateLorebookEntryRecord(entry, label)
  return entry
}

export function validateLorebookEntryForId(input: unknown, entryId: string, label = 'entry'): LorebookEntryRecord {
  const entry = validateLorebookEntry(input, label)
  if (entry.id !== entryId) {
    throw new ValidationError(`${label}.id must match entryId`)
  }
  return entry
}

/**
 * Read the backwards-compatible entry PUT body. A complete `entry` retains the
 * historical upsert/create behavior; `patch`/`deleteKeys` is deliberately
 * existing-row-only so a sparse editor write can never synthesize a row from
 * server defaults.
 */
export function readLorebookEntryWrite(input: unknown, entryId: string): LorebookEntryWrite {
  const body = readJsonObject(input, 'body')
  const hasEntry = Object.prototype.hasOwnProperty.call(body, 'entry')
  const hasPatch = Object.prototype.hasOwnProperty.call(body, 'patch')
  const hasDeleteKeys = Object.prototype.hasOwnProperty.call(body, 'deleteKeys')

  if (hasEntry) {
    if (hasPatch || hasDeleteKeys) {
      throw new ValidationError('entry cannot be combined with patch or deleteKeys')
    }
    return { kind: 'full', entry: validateLorebookEntryForId(body.entry, entryId) }
  }

  if (!hasPatch && !hasDeleteKeys) {
    throw new ValidationError('lorebook entry write must include entry, patch, or deleteKeys')
  }

  const patch = hasPatch ? { ...readJsonObject(body.patch, 'patch') } : {}
  if (Object.prototype.hasOwnProperty.call(patch, 'id')) {
    throw new ValidationError('patch.id is not supported')
  }
  for (const key of Object.keys(patch)) {
    if (key.trim() === '') {
      throw new ValidationError('patch keys must be non-empty strings')
    }
  }

  const deleteKeys = readLorebookEntryDeleteKeys(body.deleteKeys)
  for (const key of deleteKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      throw new ValidationError(`patch and deleteKeys must not overlap: ${key}`)
    }
  }
  if (Object.keys(patch).length === 0 && deleteKeys.length === 0) {
    throw new ValidationError('sparse lorebook entry write must include at least one field')
  }
  return { kind: 'sparse', patch, deleteKeys }
}

function readLorebookEntryDeleteKeys(input: unknown): string[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    throw new ValidationError('deleteKeys must be an array')
  }

  const seen = new Set<string>()
  return input.map((key, index) => {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new ValidationError(`deleteKeys[${index}] must be a non-empty string`)
    }
    if (key === 'id') {
      throw new ValidationError('deleteKeys must not contain id')
    }
    if (REQUIRED_LOREBOOK_ENTRY_KEYS.has(key)) {
      throw new ValidationError(`deleteKeys must not contain required field: ${key}`)
    }
    if (seen.has(key)) {
      throw new ValidationError(`Duplicate delete key: ${key}`)
    }
    seen.add(key)
    return key
  })
}

export function upsertLorebookEntryById(
  entries: LorebookEntryRecord[],
  entryId: string,
  entry: LorebookEntryRecord,
): { index: number; created: boolean } {
  const index = entries.findIndex((candidate) => candidate.id === entryId)
  if (index === -1) {
    entries.push(entry)
    return { index: entries.length - 1, created: true }
  }
  entries[index] = entry
  return { index, created: false }
}

export function patchLorebookEntryById(
  entries: LorebookEntryRecord[],
  entryId: string,
  patch: JsonRecord,
  deleteKeys: readonly string[],
): { index: number; created: false; patchedKeys?: string[]; deletedKeys?: string[] } {
  const index = entries.findIndex((candidate) => candidate.id === entryId)
  if (index === -1) {
    throw new EntityNotFoundError(`Lorebook entry not found: ${entryId}`)
  }

  const requested: JsonRecord = { ...entries[index], ...patch, id: entryId }
  for (const key of deleteKeys) delete requested[key]
  const validated = validateLorebookEntryForId(requested, entryId)
  entries[index] = validated
  const certificateSafe =
    isDeepStrictEqual(requested, validated) && sparseLorebookEntryStateMatches(validated, patch, deleteKeys)
  return {
    index,
    created: false,
    ...(certificateSafe ? { patchedKeys: Object.keys(patch).sort(), deletedKeys: [...deleteKeys].sort() } : {}),
  }
}

function sparseLorebookEntryStateMatches(
  entry: LorebookEntryRecord,
  patch: JsonRecord,
  deleteKeys: readonly string[],
): boolean {
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(entry, key) || !isDeepStrictEqual(entry[key], value)) return false
  }
  return deleteKeys.every((key) => !Object.prototype.hasOwnProperty.call(entry, key))
}

export function applyLorebookEntryWriteById(
  entries: LorebookEntryRecord[],
  entryId: string,
  write: LorebookEntryWrite,
): LorebookEntryWriteResult {
  return write.kind === 'full'
    ? upsertLorebookEntryById(entries, entryId, write.entry)
    : patchLorebookEntryById(entries, entryId, write.patch, write.deleteKeys)
}

export function deleteLorebookEntryById(entries: LorebookEntryRecord[], entryId: string): { index: number } {
  const index = entries.findIndex((candidate) => candidate.id === entryId)
  if (index === -1) {
    throw new EntityNotFoundError(`Lorebook entry not found: ${entryId}`)
  }
  entries.splice(index, 1)
  return { index }
}

export function reorderLorebookEntriesById(entries: LorebookEntryRecord[], entryIds: readonly string[]): void {
  validateFullLorebookEntryOrder(entries, entryIds)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  entries.splice(0, entries.length, ...entryIds.map((id) => byId.get(id)!))
}

export function validateFullLorebookEntryOrder(
  entries: readonly LorebookEntryRecord[],
  entryIds: readonly string[],
): void {
  const existing = new Set(entries.map((entry) => entry.id))
  const seen = new Set<string>()
  for (const entryId of entryIds) {
    if (!existing.has(entryId)) {
      throw new ValidationError(`Unknown lorebook entry id in entryIds: ${entryId}`)
    }
    if (seen.has(entryId)) {
      throw new ValidationError(`Duplicate lorebook entry id in entryIds: ${entryId}`)
    }
    seen.add(entryId)
  }
  if (seen.size !== existing.size) {
    throw new ValidationError('entryIds must include every lorebook entry')
  }
}

// Persisted-state repair helper. Mints `randomUUID()` for missing entry ids;
// request payloads must use `validateLorebookEntry`.
function repairLorebookEntry(input: unknown, label: string): LorebookEntryRecord {
  const entry = lorebookEntryFromInput(input, label, { repair: true })
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    entry.id = randomUUID()
  }
  validateLorebookEntryRecord(entry, label)
  return entry
}

function repairLorebookEntryFields(raw: JsonRecord): JsonRecord {
  const repaired: JsonRecord = { ...raw }
  repaired.key = readLorebookKeyString(raw.key ?? raw.keys ?? raw.keywords)
  repaired.secondkey = readLorebookKeyString(raw.secondkey ?? raw.secondary_keys)
  repaired.insertorder =
    readFiniteNumber(raw.insertorder) ??
    readFiniteNumber(raw.order) ??
    readFiniteNumber(raw.priority) ??
    readFiniteNumber(readOptionalJsonObject(raw.contextConfig).budgetPriority) ??
    100
  repaired.comment = readStringLike(raw.comment ?? raw.name ?? raw.displayName) ?? ''
  repaired.content = readStringLike(raw.content ?? raw.entry ?? raw.text) ?? ''
  const mode = readStringLike(raw.mode) ?? 'normal'
  repaired.mode = ['multiple', 'constant', 'normal', 'child', 'folder'].includes(mode) ? mode : 'normal'
  if (typeof raw.activationPercent === 'string' && raw.activationPercent.trim() !== '') {
    const activationPercent = Number(raw.activationPercent)
    if (Number.isFinite(activationPercent)) repaired.activationPercent = activationPercent
  }
  repaired.alwaysActive = readBoolean(raw.alwaysActive ?? raw.constant ?? raw.forceActivation) ?? false
  repaired.selective = readBoolean(raw.selective) ?? false
  const extensions = readOptionalJsonObject(raw.extentions ?? raw.extensions)
  const agentOnly = raw.agentOnly === true || extensions.risu_agent_only === true
  if (agentOnly) {
    repaired.agentOnly = true
  } else if (raw.agentOnly !== undefined) {
    repaired.agentOnly = false
  }
  if (repaired.folder !== undefined && typeof repaired.folder !== 'string') {
    delete repaired.folder
  }
  return repaired
}

function readLorebookKeyString(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(readStringLike)
      .filter((item): item is string => item !== undefined)
      .join(', ')
  }
  return readStringLike(value) ?? ''
}

function readStringLike(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function validateGlobalLorebookRecord(record: GlobalLorebookRecord, label: string): void {
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    throw new ValidationError(`${label}.id must be a non-empty string`)
  }
  if (typeof record.name !== 'string' || record.name.trim() === '') {
    throw new ValidationError(`${label}.name must be a non-empty string`)
  }
  if (!Array.isArray(record.data)) {
    throw new ValidationError(`${label}.data must be an array`)
  }
}

function validateLorebookEntryRecord(record: JsonRecord, label: string): void {
  for (const key of ['id', 'key', 'secondkey', 'comment', 'content', 'mode']) {
    if (typeof record[key] !== 'string') {
      throw new ValidationError(`${label}.${key} must be a string`)
    }
  }
  if ((record.id as string).trim() === '') {
    throw new ValidationError(`${label}.id must be a non-empty string`)
  }
  if (typeof record.insertorder !== 'number' || !Number.isFinite(record.insertorder)) {
    throw new ValidationError(`${label}.insertorder must be a finite number`)
  }
  if (typeof record.alwaysActive !== 'boolean') {
    throw new ValidationError(`${label}.alwaysActive must be a boolean`)
  }
  if (typeof record.selective !== 'boolean') {
    throw new ValidationError(`${label}.selective must be a boolean`)
  }
  if ('agentOnly' in record && record.agentOnly !== undefined && typeof record.agentOnly !== 'boolean') {
    throw new ValidationError(`${label}.agentOnly must be a boolean`)
  }
  // Agent-only entries may keep activation settings; runtime activation skips
  // them, so the settings stay inert until the flag is cleared.
  const extensions = readOptionalJsonObject(record.extentions ?? record.extensions)
  const agentOnly = record.agentOnly === true || extensions.risu_agent_only === true
  if (agentOnly && (record.mode === 'folder' || record.mode === 'child')) {
    throw new ValidationError(`${label} Agent-only entries must be regular lorebook entries`)
  }
  if ('folder' in record && record.folder !== undefined && typeof record.folder !== 'string') {
    throw new ValidationError(`${label}.folder must be a string`)
  }
  validateJsonValue(label, record)
}

function normalizeLorebookPage(database: JsonRecord, lorebooks: readonly GlobalLorebookRecord[]): void {
  if (!Number.isInteger(database.loreBookPage as number)) {
    database.loreBookPage = 0
  }
  if ((database.loreBookPage as number) >= lorebooks.length) {
    database.loreBookPage = lorebooks.length > 0 ? lorebooks.length - 1 : 0
  }
  if ((database.loreBookPage as number) < 0) {
    database.loreBookPage = 0
  }
}

function readOptionalJsonObject(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as JsonRecord
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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

export { readCharacterId, readChatId }
