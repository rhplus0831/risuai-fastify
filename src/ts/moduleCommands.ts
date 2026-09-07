import { canUseClientWriteAccess } from './clientSession'
import {
  currentChatGenerationSettingsSnapshot,
  currentChatScopedSnapshot,
  dispatchCharacterOwnedDurableBatch,
  dispatchOwnedDurableBatch,
  type CharacterOwnedDurableBatchResult,
  type CharacterOwnedDurableBatchStep,
  type ChatMutationFinalOutcome,
  type ChatScopedSnapshot,
  type ChatGenerationSettingsSnapshot,
} from './chatCommands'
import {
  canUseServerCommands,
  createModuleCommand,
  createModuleFolderCommand,
  deleteModuleFolderCommand,
  deleteModuleCommand,
  enableModuleCommand,
  reorderCharacterModulesCommand,
  reorderModulesCommand,
  reorderModuleFoldersCommand,
  replaceModuleLorebooksCommand,
  replaceModuleScriptsCommand,
  replaceModuleTriggersCommand,
  runServerCommand,
  saveChatGenerationSettingsCommand,
  updateChatCommand,
  updateModuleCommand,
  updateModuleFolderCommand,
  type LorebookEntrySnapshot,
  type ModuleSnapshot,
  type ScriptDefinitionSnapshot,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
  type TriggerDefinitionSnapshot,
} from './server/commands'
import {
  applyChatMetadataOwnerPatch,
  charactersResourceState,
  collectionsResourceState,
  getCharacterResourceOwner,
  getChatMetadataOwnerSnapshot,
  restoreChatMetadataOwnerSnapshot,
  settingsResourceState,
} from './server/resourceState.svelte'
import { reloadGuiAfterDefinitionChange, selectedCharID } from './stores.svelte'
import type { ModuleFolder, RisuModule } from './process/modules'
import type { character, customscript, loreBook, triggerscript } from './storage/database.svelte'
import { get } from 'svelte/store'
import {
  fillMissingActiveChatSidebarToggleDefaults,
  resolveActiveChatGenerationSettings,
} from './activeChatGenerationSettings'
import type { ChatGenerationSettings } from './chatGenerationSettings'
import { dispatchDurableMutation, registerDurableMutationSettlementListener } from './server/durableMutationDispatch'
import {
  pendingMutationChatGenerationSettingsProjectionTarget,
  pendingMutationModuleEnabledProjectionTarget,
  recordPendingMutationProjectionTargets,
  stagePendingMutation,
  type DurableMutationIntent,
} from './server/pendingMutationOutbox'
import { moduleFolderOwnerMutationKey, moduleOwnerMutationKey } from './server/resourceOwnerMutationKeys'
import { chatGenerationSettingsMutationDependencyKeys } from './server/chatGenerationSettingsMutationKeys'
import { ensureClientLorebookEntryIds, flushPendingLorebookOwnerMutations } from './server/lorebookOwner.svelte'
import {
  ensureClientScriptDefinitionIds,
  ensureClientTriggerDefinitionIds,
  flushPendingScriptDefinitionMutations,
} from './server/scriptDefinitionOwner.svelte'
import { flushPendingSettingsOwnerMutations } from './server/settingsOwner.svelte'
import { flushPendingCharacterDraftPatches } from './server/characterDraft.svelte'
import { SERVER_CHARACTER_SHELL_MARKER } from '@risuai/protocol/character-summary-resource'

export interface GlobalModuleStateSnapshot {
  modules: RisuModule[]
  enabledModules: string[]
  moduleReferences?: ModuleReferenceStateSnapshot
}

export interface ModuleOrganizationSnapshot {
  folders: ModuleFolder[]
  modules: RisuModule[]
}

export type ModuleMutationOutcome =
  | { status: 'accepted'; result: Extract<ServerCommandResult, { status: 'ok' }> | null }
  | { status: 'queued'; result: Exclude<ServerCommandResult, { status: 'ok' }> }
  | { status: 'failed'; result: Exclude<ServerCommandResult, { status: 'ok' }> }

export type ModuleEditorSaveFinalOutcome =
  | { status: 'accepted' }
  | { status: 'failed'; result: Exclude<ServerCommandResult, { status: 'ok' }> }

export type ModuleEditorSaveOutcome =
  | { status: 'accepted'; result: Extract<ServerCommandResult, { status: 'ok' }> | null }
  | {
      status: 'queued'
      result: Exclude<ServerCommandResult, { status: 'ok' }>
      mutationIds: readonly string[]
      settlement: Promise<ModuleEditorSaveFinalOutcome>
    }
  | { status: 'failed'; result: Exclude<ServerCommandResult, { status: 'ok' }> }

export type ScopedModuleMutationOutcome =
  | { status: 'accepted'; result: null }
  | {
      status: 'queued'
      result: Exclude<ServerCommandResult, { status: 'ok' }>
      mutationIds: readonly string[]
      settlement: Promise<ChatMutationFinalOutcome>
    }
  | { status: 'failed'; result: Exclude<ServerCommandResult, { status: 'ok' }> }

export interface CharacterModuleStateSnapshot {
  characterId: string
  hasModulesField: boolean
  modules: string[] | undefined
}

interface ModuleIdsFieldSnapshot {
  hasModulesField: boolean
  modules: string[] | undefined
}

interface ChatModuleReferenceSnapshot {
  chatId: string
  modules: ModuleIdsFieldSnapshot
}

interface CharacterModuleReferenceSnapshot {
  characterId: string
  modules?: ModuleIdsFieldSnapshot
  chats: ChatModuleReferenceSnapshot[]
}

interface LoadoutModuleReferenceSnapshot {
  loadoutId: string
  modules: ModuleIdsFieldSnapshot
}

interface PersonaModuleReferenceSnapshot {
  personaId: string
  modules: ModuleIdsFieldSnapshot
}

interface ModuleReferenceStateSnapshot {
  personas: PersonaModuleReferenceSnapshot[]
  characters: CharacterModuleReferenceSnapshot[]
  loadouts: LoadoutModuleReferenceSnapshot[]
}

const MODULE_PATCH_EXCLUDED_KEYS = new Set(['id', 'mcp', 'lorebook', 'regex', 'trigger'])
const MODULE_EDITOR_SPLIT_COLLECTION_KEYS = ['lorebook', 'regex', 'trigger'] as const
const MODULE_PATCH_DELETABLE_KEYS = new Set([
  'namespace',
  'lowLevelAccess',
  'hideIcon',
  'backgroundEmbedding',
  'customModuleToggle',
  'cjs',
  'assets',
  'folderId',
])

function moduleCollectionOwnerRead(): RisuModule[] {
  const modules = collectionsResourceState.values.modules
  if (collectionsResourceState.statuses.modules !== 'ready') return []
  return isStableModuleCollection(modules) ? modules : []
}

function moduleCollectionOwnerWrite(modules: RisuModule[]): void {
  if (collectionsResourceState.statuses.modules !== 'ready') return
  if (!isStableModuleCollection(collectionsResourceState.values.modules) || !isStableModuleCollection(modules)) return
  collectionsResourceState.values.modules = modules
}

function enabledModulesOwnerRead(): string[] {
  const enabledModules = (settingsResourceState.value as Record<string, unknown>).enabledModules
  if (settingsResourceState.status !== 'ready') return []
  return isUniqueStringArray(enabledModules) ? enabledModules : []
}

function enabledModulesOwnerWrite(enabledModules: string[]): void {
  if (settingsResourceState.status !== 'ready') return
  if (!isUniqueStringArray((settingsResourceState.value as Record<string, unknown>).enabledModules)) return
  if (!isUniqueStringArray(enabledModules)) return
  ;(settingsResourceState.value as Record<string, unknown>).enabledModules = enabledModules
}

function isStableModuleFolderCollection(value: unknown): value is ModuleFolder[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const folder = candidate as Record<string, unknown>
    if (
      typeof folder.id !== 'string' ||
      folder.id.trim() !== folder.id ||
      folder.id.length === 0 ||
      ids.has(folder.id) ||
      typeof folder.name !== 'string' ||
      folder.name.trim() !== folder.name ||
      folder.name.length === 0
    ) {
      return false
    }
    ids.add(folder.id)
  }
  return true
}

function moduleFoldersOwnerRead(): ModuleFolder[] {
  if (settingsResourceState.groupStatuses.modules !== 'ready') return []
  const folders = (settingsResourceState.value as Record<string, unknown>).moduleFolders
  if (folders === undefined) return []
  return isStableModuleFolderCollection(folders) ? folders : []
}

function moduleFoldersOwnerWrite(folders: ModuleFolder[]): void {
  if (settingsResourceState.groupStatuses.modules !== 'ready') return
  if (!isStableModuleFolderCollection(folders)) return
  ;(settingsResourceState.value as Record<string, unknown>).moduleFolders = folders
}

function canWriteModuleOrganizationOwner(): boolean {
  return (
    settingsResourceState.groupStatuses.modules === 'ready' &&
    ((settingsResourceState.value as Record<string, unknown>).moduleFolders === undefined ||
      isStableModuleFolderCollection((settingsResourceState.value as Record<string, unknown>).moduleFolders)) &&
    collectionsResourceState.statuses.modules === 'ready' &&
    isStableModuleCollection(collectionsResourceState.values.modules)
  )
}

function isStableModuleCollection(value: unknown): value is RisuModule[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const module = candidate as Record<string, unknown>
    if (typeof module.id !== 'string' || module.id.length === 0 || ids.has(module.id)) return false
    // A namespace is an activation alias, not an identity. Multiple modules
    // may intentionally share one, and persisted imports may contain an empty
    // namespace, so only the row id must be unique.
    if (module.namespace !== undefined && typeof module.namespace !== 'string') return false
    ids.add(module.id)
  }
  return true
}

function isUniqueStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string') && new Set(value).size === value.length
  )
}

function uniqueModuleIndex(modules: readonly RisuModule[], moduleId: string): number {
  const matches = modules.reduce<number[]>((indexes, module, index) => {
    if (module.id === moduleId) indexes.push(index)
    return indexes
  }, [])
  return matches.length === 1 ? matches[0] : -1
}

function canResolveGlobalModuleTarget(moduleId: string): boolean {
  if (collectionsResourceState.statuses.modules !== 'ready') return false
  const modules = collectionsResourceState.values.modules
  return isStableModuleCollection(modules) && uniqueModuleIndex(modules, moduleId) !== -1
}

function canWriteEnabledModuleOwner(): boolean {
  if (settingsResourceState.status !== 'ready') return false
  return isUniqueStringArray((settingsResourceState.value as Record<string, unknown>).enabledModules)
}

function unavailableModuleOwnerResult(): Exclude<ServerCommandResult, { status: 'ok' }> {
  return { status: 'error', error: 'Module collection owner is unavailable' }
}

let nextGlobalModuleOperationSequence = 0
const pendingGlobalModuleOperationsByTarget = new Map<string, GlobalModuleOperationRecord[]>()

interface GlobalModuleOperationToken {
  sequence: number
  targets: string[]
}

type GlobalModuleOperationStatus = 'pending' | 'failed'

interface GlobalModuleOperationRecord {
  sequence: number
  entry: GlobalModuleRollbackEntry
  status: GlobalModuleOperationStatus
}

type GlobalModuleRollbackEntry =
  | ModuleCreateRollbackEntry
  | ModuleFieldRollbackEntry
  | ModuleDeleteRowRollbackEntry
  | ModuleEnableRollbackEntry
  | ModuleReferenceRollbackEntry
  | ModuleOrderRollbackEntry
  | ModuleFolderCreateRollbackEntry
  | ModuleFolderNameRollbackEntry
  | ModuleFolderDeleteRollbackEntry
  | ModuleFolderOrderRollbackEntry

interface ModuleCreateRollbackEntry {
  kind: 'module-create'
  target: string
  moduleId: string
  attemptedModule: RisuModule
}

interface ModuleFieldRollbackEntry {
  kind: 'module-field'
  target: string
  moduleId: string
  field: string
  previousExists: boolean
  previousValue: unknown
  attemptedExists: boolean
  attemptedValue: unknown
}

interface ModuleDeleteRowRollbackEntry {
  kind: 'module-delete-row'
  target: string
  moduleId: string
  previousModule: RisuModule
  previousIndex: number
}

interface ModuleEnableRollbackEntry {
  kind: 'module-enable'
  target: string
  moduleId: string
  previousEnabled: boolean
  previousIndex: number
  attemptedEnabled: boolean
}

interface ModuleReferenceRollbackEntry {
  kind: 'module-reference'
  target: string
  previous: ModuleIdsFieldSnapshot
  attempted: ModuleIdsFieldSnapshot
  personaId?: string
  characterId?: string
  chatId?: string
  loadoutId?: string
}

interface ModuleOrderRollbackEntry {
  kind: 'module-order'
  target: string
  previousModuleIds: string[]
  attemptedModuleIds: string[]
}

interface ModuleFolderCreateRollbackEntry {
  kind: 'module-folder-create'
  target: string
  folderId: string
  attemptedFolder: ModuleFolder
}

interface ModuleFolderNameRollbackEntry {
  kind: 'module-folder-name'
  target: string
  folderId: string
  previousName: string
  attemptedName: string
}

interface ModuleFolderDeleteRollbackEntry {
  kind: 'module-folder-delete'
  target: string
  folderId: string
  previousFolder: ModuleFolder
  previousIndex: number
}

interface ModuleFolderOrderRollbackEntry {
  kind: 'module-folder-order'
  target: string
  previousFolderIds: string[]
  attemptedFolderIds: string[]
}

interface ModuleCollectionPatchStep {
  method: CharacterOwnedDurableBatchStep['method']
  path: string
  body: Record<string, unknown>
  dependencyKeys?: string[]
  factory: (baseRevision: number, frozenBody: Readonly<Record<string, unknown>>) => Promise<ServerCommandResult>
  rollbackEntries: GlobalModuleRollbackEntry[]
}

const MODULE_COLLECTION_MUTATION_KEY = 'module-collection'
let nextScopedModuleOperationSequence = 0
const pendingScopedModuleOperations = new Map<string, PendingScopedModuleOperation[]>()

interface PendingScopedModuleOperation {
  sequence: number
  key: string
  status: 'pending' | 'failed'
  rollbackIfLiveMatches: () => boolean
}

function issueScopedModuleOperation(key: string, rollbackIfLiveMatches: () => boolean): PendingScopedModuleOperation {
  const operation: PendingScopedModuleOperation = {
    sequence: ++nextScopedModuleOperationSequence,
    key,
    status: 'pending',
    rollbackIfLiveMatches,
  }
  const pending = pendingScopedModuleOperations.get(key) ?? []
  pending.push(operation)
  pendingScopedModuleOperations.set(key, pending)
  return operation
}

function acceptScopedModuleOperation(operation: PendingScopedModuleOperation): void {
  const pending = pendingScopedModuleOperations.get(operation.key)
  if (!pending) return
  const index = pending.findIndex((candidate) => candidate.sequence === operation.sequence)
  if (index === -1) return
  const next = pending.filter(
    (candidate, candidateIndex) =>
      candidate.sequence !== operation.sequence && !(candidateIndex < index && candidate.status === 'failed'),
  )
  if (next.length > 0) pendingScopedModuleOperations.set(operation.key, next)
  else pendingScopedModuleOperations.delete(operation.key)
}

function rejectScopedModuleOperation(operation: PendingScopedModuleOperation): void {
  const pending = pendingScopedModuleOperations.get(operation.key)
  const current = pending?.find((candidate) => candidate.sequence === operation.sequence)
  if (!pending || !current) return
  current.status = 'failed'
  let changed = false
  while (pending.at(-1)?.status === 'failed') {
    changed = pending.pop()!.rollbackIfLiveMatches() || changed
  }
  if (pending.length > 0) pendingScopedModuleOperations.set(operation.key, pending)
  else pendingScopedModuleOperations.delete(operation.key)
  if (changed) reloadGuiAfterDefinitionChange()
}

export function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

interface ModuleDraftTopLevelPatch {
  values: ModuleSnapshot
  deletedKeys: string[]
}

function moduleDraftTopLevelPatch(baseline: RisuModule, draft: RisuModule): ModuleDraftTopLevelPatch {
  const baselineRecord = baseline as RisuModule & Record<string, unknown>
  const draftRecord = draft as RisuModule & Record<string, unknown>
  const values: ModuleSnapshot = {}
  const deletedKeys: string[] = []
  const keys = new Set([...Object.keys(baselineRecord), ...Object.keys(draftRecord)])

  for (const key of keys) {
    if (MODULE_PATCH_EXCLUDED_KEYS.has(key)) continue

    const baselineHasKey = hasOwnRecordKey(baselineRecord, key)
    const draftHasKey = hasOwnRecordKey(draftRecord, key)
    if (baselineHasKey === draftHasKey && (!draftHasKey || isJsonValueEqual(baselineRecord[key], draftRecord[key]))) {
      continue
    }

    if (draftHasKey) {
      values[key] = cloneJsonValue(draftRecord[key])
    } else {
      deletedKeys.push(key)
    }
  }

  return { values, deletedKeys }
}

/**
 * Rebase an editor draft onto the newest projected module without treating
 * untouched baseline fields as user edits. Changes within the same top-level
 * parent-owned field remain last-writer-wins, matching the server's sparse
 * module patch. Split-owned fields always stay on their newest projection.
 */
export function rebaseModuleDraftOntoLatest(baseline: RisuModule, draft: RisuModule, latest: RisuModule): RisuModule {
  const patch = moduleDraftTopLevelPatch(baseline, draft)
  const rebased = cloneJsonValue(latest) as RisuModule & Record<string, unknown>

  for (const [key, value] of Object.entries(patch.values)) {
    rebased[key] = cloneJsonValue(value)
  }
  for (const key of patch.deletedKeys) {
    delete rebased[key]
  }

  rebased.id = latest.id
  return rebased
}

function normalizedModuleSplitCollection(
  module: RisuModule,
  key: (typeof MODULE_EDITOR_SPLIT_COLLECTION_KEYS)[number],
) {
  const value = module[key]
  return Array.isArray(value) ? cloneJsonValue(value) : []
}

/**
 * Rebase the explicit ModuleSettings editor draft. Unlike legacy parent-only
 * saves, a collection changed inside this editor is intentional and must be
 * included in the final Save; untouched collections still retain the newest
 * projected value.
 */
export function rebaseModuleEditorDraftOntoLatest(
  baseline: RisuModule,
  draft: RisuModule,
  latest: RisuModule,
): RisuModule {
  const rebased = rebaseModuleDraftOntoLatest(baseline, draft, latest) as RisuModule & Record<string, unknown>
  const rebasedRecord = rebased as Record<string, unknown>

  for (const key of MODULE_EDITOR_SPLIT_COLLECTION_KEYS) {
    const baselineCollection = normalizedModuleSplitCollection(baseline, key)
    const draftCollection = normalizedModuleSplitCollection(draft, key)
    if (!isJsonValueEqual(baselineCollection, draftCollection)) {
      rebasedRecord[key] = draftCollection
    }
  }

  return rebased
}

export function currentGlobalModuleStateSnapshot(moduleIdForReferences?: string): GlobalModuleStateSnapshot {
  const snapshot: GlobalModuleStateSnapshot = {
    modules: cloneJsonValue(moduleCollectionOwnerRead()),
    enabledModules: cloneJsonValue(enabledModulesOwnerRead()),
  }

  if (moduleIdForReferences) {
    snapshot.moduleReferences = currentModuleReferenceStateSnapshot(moduleIdForReferences)
  }

  return snapshot
}

export function currentModuleOrganizationSnapshot(): ModuleOrganizationSnapshot {
  return {
    folders: cloneJsonValue(moduleFoldersOwnerRead()),
    modules: cloneJsonValue(moduleCollectionOwnerRead()),
  }
}

export function restoreGlobalModuleState(snapshot: GlobalModuleStateSnapshot): void {
  moduleCollectionOwnerWrite(cloneJsonValue(snapshot.modules))
  enabledModulesOwnerWrite(cloneJsonValue(snapshot.enabledModules))
  if (snapshot.moduleReferences) {
    restoreModuleReferenceState(snapshot.moduleReferences)
  }
  reloadGuiAfterDefinitionChange()
}

function personaModuleReferenceOwners(): NonNullable<typeof collectionsResourceState.values.personas> {
  const personas = collectionsResourceState.values.personas
  if (collectionsResourceState.statuses.personas !== 'ready' || !Array.isArray(personas)) return []
  const ids = personas.map((persona) => persona?.id)
  return ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length ? personas : []
}

function loadoutModuleReferenceOwners(): NonNullable<typeof collectionsResourceState.values.loadouts> {
  const loadouts = collectionsResourceState.values.loadouts
  if (collectionsResourceState.statuses.loadouts !== 'ready' || !Array.isArray(loadouts)) return []
  const ids = loadouts.map((loadout) => loadout?.id)
  return ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length ? loadouts : []
}

function characterModuleReferenceOwners(): character[] {
  if (charactersResourceState.status !== 'ready') return []
  const ids = charactersResourceState.characters.map((candidate) => candidate?.chaId)
  return ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length
    ? charactersResourceState.characters
    : []
}

function currentModuleReferenceStateSnapshot(moduleId: string): ModuleReferenceStateSnapshot {
  const personas: PersonaModuleReferenceSnapshot[] = []
  const characters: CharacterModuleReferenceSnapshot[] = []
  const loadouts: LoadoutModuleReferenceSnapshot[] = []

  for (const candidate of personaModuleReferenceOwners()) {
    if (!candidate?.id) continue
    const personaModules = moduleIdsFieldSnapshot(candidate, moduleId)
    if (personaModules) personas.push({ personaId: candidate.id, modules: personaModules })
  }

  for (const candidate of characterModuleReferenceOwners()) {
    if (!candidate?.chaId) continue

    const characterModules = moduleIdsFieldSnapshot(candidate, moduleId)
    const chats: ChatModuleReferenceSnapshot[] = []

    for (const chat of candidate.chats ?? []) {
      if (!chat?.id) continue
      const chatModules = moduleIdsFieldSnapshot(chat, moduleId)
      if (chatModules) {
        chats.push({
          chatId: chat.id,
          modules: chatModules,
        })
      }
    }

    if (characterModules || chats.length > 0) {
      characters.push({
        characterId: candidate.chaId,
        modules: characterModules,
        chats,
      })
    }
  }

  for (const candidate of loadoutModuleReferenceOwners()) {
    if (!candidate || typeof candidate !== 'object') continue
    const loadoutId = candidate.id
    if (typeof loadoutId !== 'string' || loadoutId.length === 0) continue
    const loadoutModules = moduleIdsFieldSnapshot(candidate, moduleId)
    if (!loadoutModules) continue
    loadouts.push({
      loadoutId,
      modules: loadoutModules,
    })
  }

  return { personas, characters, loadouts }
}

function moduleIdsFieldSnapshot(value: { modules?: unknown }, moduleId: string): ModuleIdsFieldSnapshot | undefined {
  if (!Array.isArray(value.modules) || !value.modules.includes(moduleId)) return undefined
  return {
    hasModulesField: Object.prototype.hasOwnProperty.call(value, 'modules'),
    modules: cloneJsonValue(value.modules.filter((id): id is string => typeof id === 'string')),
  }
}

function restoreModuleReferenceState(snapshot: ModuleReferenceStateSnapshot): void {
  for (const personaSnapshot of snapshot.personas) {
    const persona = personaModuleReferenceOwners().find((candidate) => candidate.id === personaSnapshot.personaId)
    if (persona) restoreModulesField(persona, personaSnapshot.modules)
  }

  for (const characterSnapshot of snapshot.characters) {
    const character = findCharacterById(characterSnapshot.characterId)
    if (!character) continue

    if (characterSnapshot.modules) {
      restoreModulesField(character, characterSnapshot.modules)
    }

    for (const chatSnapshot of characterSnapshot.chats) {
      restoreChatModulesOwner(characterSnapshot.characterId, chatSnapshot.chatId, chatSnapshot.modules)
    }
  }

  for (const loadoutSnapshot of snapshot.loadouts) {
    const loadout = findLoadoutForReference(loadoutSnapshot)
    if (!loadout) continue
    restoreModulesField(loadout, loadoutSnapshot.modules)
  }
}

function restoreModulesField(target: { modules?: string[] }, snapshot: ModuleIdsFieldSnapshot): void {
  if (snapshot.hasModulesField) {
    target.modules = cloneJsonValue(snapshot.modules)
  } else {
    delete target.modules
  }
}

function chatModulesOwnerPatch(snapshot: ModuleIdsFieldSnapshot): { modules: string[] | undefined } {
  return { modules: snapshot.hasModulesField ? cloneJsonValue(snapshot.modules) : undefined }
}

function restoreChatModulesOwner(characterId: string, chatId: string, snapshot: ModuleIdsFieldSnapshot): boolean {
  return applyChatMetadataOwnerPatch(characterId, chatId, chatModulesOwnerPatch(snapshot))
}

function rollbackChatModulesOwner(
  characterId: string,
  chatId: string,
  previous: ModuleIdsFieldSnapshot,
  attempted: ModuleIdsFieldSnapshot,
): boolean {
  return restoreChatMetadataOwnerSnapshot({
    characterId,
    chatId,
    metadata: previous.hasModulesField ? { modules: cloneJsonValue(previous.modules) } : {},
    attempted: chatModulesOwnerPatch(attempted),
  })
}

function findCharacterById(characterId: string): character | undefined {
  if (charactersResourceState.status !== 'ready') return undefined
  return getCharacterResourceOwner(characterId)
}

function findLoadoutForReference(snapshot: LoadoutModuleReferenceSnapshot): { modules?: string[] } | undefined {
  const loadouts = loadoutModuleReferenceOwners()
  return loadouts.find((candidate) => candidate?.id === snapshot.loadoutId)
}

export function currentCharacterModuleStateSnapshot(characterId: string): CharacterModuleStateSnapshot | null {
  const character = findCharacterById(characterId)
  if (!character) return null
  return {
    characterId,
    hasModulesField: Object.prototype.hasOwnProperty.call(character, 'modules'),
    modules: cloneJsonValue(character.modules),
  }
}

export function restoreCharacterModuleState(snapshot: CharacterModuleStateSnapshot): void {
  const character = findCharacterById(snapshot.characterId)
  if (!character) return
  if (snapshot.hasModulesField) {
    character.modules = cloneJsonValue(snapshot.modules)
  } else {
    delete character.modules
  }
  reloadGuiAfterDefinitionChange()
}

export function runModuleCommand<T extends Record<string, unknown>>(
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>,
  rollback: () => void,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult<T>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  if (!canUseServerCommands()) return Promise.resolve({ status: 'unavailable' })
  return runServerCommand({ command, rollback, ...options })
}

export function dispatchCreateModule(
  module: RisuModule,
  previous: GlobalModuleStateSnapshot,
): Promise<ServerCommandResult> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  if (!canUseServerCommands()) return Promise.resolve({ status: 'unavailable' })
  const moduleSnapshot = toModuleSnapshot(module)
  const rollbackEntry = moduleCreateRollbackEntry(moduleSnapshot as RisuModule)
  const operation = issueGlobalModuleOperation([rollbackEntry])
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [MODULE_COLLECTION_MUTATION_KEY],
    requests: [
      {
        method: 'POST',
        path: '/modules',
        body: { module: cloneJsonValue(moduleSnapshot) },
      },
    ],
  }
  const outbox = stagePendingMutation(moduleOwnerMutationKey(module.id), intent)
  recordPendingMutationProjectionTargets(outbox, globalModuleProjectionTargets([rollbackEntry]))
  return dispatchDurableMutation(outbox, intent, (transport) =>
    runModuleCommand(
      async (baseRevision) => {
        const result = await createModuleCommand(
          { baseRevision, module: cloneJsonValue(moduleSnapshot) },
          transport.signal,
          true,
        )
        if (result.status === 'ok') {
          clearGlobalModuleOperation(operation)
        }
        return result
      },
      () => rollbackGlobalModuleEntries([rollbackEntry], operation),
      transport,
    ),
  )
}

export function dispatchUpdateModule(
  moduleId: string,
  patch: ModuleSnapshot,
  previous: GlobalModuleStateSnapshot,
): Promise<ServerCommandResult> | null {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  if (!canResolveGlobalModuleTarget(moduleId)) return Promise.resolve(unavailableModuleOwnerResult())
  const commandPatch = changedModulePatch(moduleId, patch, previous, { complete: true })
  if (Object.keys(commandPatch).length === 0) return null
  if (!canUseServerCommands()) return Promise.resolve({ status: 'unavailable' })
  applyModuleDeletionSentinelsOptimistically(moduleId, commandPatch)
  const rollbackEntries = moduleFieldRollbackEntries(moduleId, commandPatch, previous)
  const operation = rollbackEntries.length > 0 ? issueGlobalModuleOperation(rollbackEntries) : null
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [MODULE_COLLECTION_MUTATION_KEY],
    requests: [
      {
        method: 'PATCH',
        path: `/modules/${encodeURIComponent(moduleId)}`,
        body: { patch: cloneJsonValue(commandPatch) },
      },
    ],
  }
  const outbox = stagePendingMutation(moduleOwnerMutationKey(moduleId), intent)
  recordPendingMutationProjectionTargets(outbox, globalModuleProjectionTargets(rollbackEntries))
  return dispatchDurableMutation(outbox, intent, (transport) =>
    runModuleCommand(
      async (baseRevision) => {
        const result = await updateModuleCommand(
          { baseRevision, moduleId, patch: cloneJsonValue(commandPatch) },
          transport.signal,
          true,
        )
        if (operation && result.status === 'ok') {
          clearGlobalModuleOperation(operation)
        }
        return result
      },
      () => {
        if (operation) {
          rollbackGlobalModuleEntries(rollbackEntries, operation)
        }
      },
      transport,
    ),
  )
}

export function dispatchModuleInfoPatch(
  moduleId: string,
  patch: ModuleSnapshot,
  enabled: boolean | null,
  previous: GlobalModuleStateSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  if (!canResolveGlobalModuleTarget(moduleId) || (enabled !== null && !canWriteEnabledModuleOwner())) return
  if (!canUseServerCommands()) return

  const steps: ModuleCollectionPatchStep[] = []
  const commandPatch = changedModulePatch(moduleId, patch, previous)

  if (Object.keys(commandPatch).length > 0) {
    applyModuleDeletionSentinelsOptimistically(moduleId, commandPatch)
    const rollbackEntries = moduleFieldRollbackEntries(moduleId, commandPatch, previous)
    if (rollbackEntries.length > 0) {
      steps.push({
        method: 'PATCH',
        path: `/modules/${encodeURIComponent(moduleId)}`,
        body: { patch: cloneJsonValue(commandPatch) },
        dependencyKeys: [moduleOwnerMutationKey(moduleId)],
        factory: (baseRevision, body) =>
          updateModuleCommand({ baseRevision, moduleId, patch: body.patch as ModuleSnapshot }, undefined, true),
        rollbackEntries,
      })
    }
  }

  if (enabled !== null) {
    steps.push({
      method: 'POST',
      path: '/modules/enable',
      body: { moduleId, enabled },
      dependencyKeys: [moduleOwnerMutationKey(moduleId)],
      factory: (baseRevision, body) =>
        enableModuleCommand(
          { baseRevision, moduleId: body.moduleId as string, enabled: body.enabled as boolean },
          undefined,
          true,
        ),
      rollbackEntries: [moduleEnableRollbackEntry(moduleId, enabled, previous)],
    })
  }

  runModuleCollectionPatchSteps(steps)
}

export async function dispatchDeleteModule(
  moduleId: string,
  previous: GlobalModuleStateSnapshot,
): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canUseServerCommands()) return { status: 'failed', result: { status: 'unavailable' } }
  flushPendingSettingsOwnerMutations()
  flushPendingCharacterDraftPatches()
  flushPendingLorebookOwnerMutations()
  flushPendingScriptDefinitionMutations()
  const rollbackEntries = moduleDeleteRollbackEntries(moduleId, previous)
  const operation = rollbackEntries.length > 0 ? issueGlobalModuleOperation(rollbackEntries) : null
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [MODULE_COLLECTION_MUTATION_KEY],
    requests: [
      {
        method: 'DELETE',
        path: `/modules/${encodeURIComponent(moduleId)}`,
        body: {},
      },
    ],
  }
  const outbox = stagePendingMutation(moduleOwnerMutationKey(moduleId), intent)
  recordPendingMutationProjectionTargets(outbox, globalModuleProjectionTargets(rollbackEntries))
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  const settlementCleanup = registerDurableMutationSettlementListener(outbox.mutationId, (settlement) => {
    if (!operation) return
    if (settlement === 'accepted') clearGlobalModuleOperation(operation)
    else rollbackGlobalModuleEntries(rollbackEntries, operation)
  })
  let result: ServerCommandResult
  try {
    result = await dispatchDurableMutation(outbox, intent, (transport) => {
      failureRollbackDisposition = transport.failureRollbackDisposition
      return runModuleCommand(
        async (baseRevision) => {
          const result = await deleteModuleCommand({
            baseRevision,
            moduleId,
          })
          if (operation && result.status === 'ok') {
            clearGlobalModuleOperation(operation)
          }
          return result
        },
        () => {
          if (operation) {
            rollbackGlobalModuleEntries(rollbackEntries, operation)
          }
        },
        transport,
      )
    })
  } catch (error) {
    console.error('Module delete command rejected:', error)
    result = { status: 'unavailable' }
  }
  const outcome = moduleMutationOutcome(result, failureRollbackDisposition)
  if (outcome.status !== 'queued') settlementCleanup()
  return outcome
}

export async function dispatchEnableModule(
  moduleId: string,
  enabled: boolean,
  previous: GlobalModuleStateSnapshot,
): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canResolveGlobalModuleTarget(moduleId) || !canWriteEnabledModuleOwner()) {
    return { status: 'failed', result: unavailableModuleOwnerResult() }
  }
  if (!canUseServerCommands()) return { status: 'failed', result: { status: 'unavailable' } }
  const rollbackEntry = moduleEnableRollbackEntry(moduleId, enabled, previous)
  const operation = issueGlobalModuleOperation([rollbackEntry])
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [MODULE_COLLECTION_MUTATION_KEY],
    requests: [
      {
        method: 'POST',
        path: '/modules/enable',
        body: { moduleId, enabled },
      },
    ],
  }
  const outbox = stagePendingMutation(moduleOwnerMutationKey(moduleId), intent)
  recordPendingMutationProjectionTargets(outbox, globalModuleProjectionTargets([rollbackEntry]))
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  const settlementCleanup = registerDurableMutationSettlementListener(outbox.mutationId, (settlement) => {
    if (settlement === 'accepted') clearGlobalModuleOperation(operation)
    else rollbackGlobalModuleEntries([rollbackEntry], operation)
  })
  let result: ServerCommandResult
  try {
    result = await dispatchDurableMutation(outbox, intent, (transport) => {
      failureRollbackDisposition = transport.failureRollbackDisposition
      return runModuleCommand(
        async (baseRevision) => {
          const result = await enableModuleCommand({ baseRevision, moduleId, enabled }, undefined, true)
          if (result.status === 'ok') {
            clearGlobalModuleOperation(operation)
          }
          return result
        },
        () => rollbackGlobalModuleEntries([rollbackEntry], operation),
        transport,
      )
    })
  } catch (error) {
    console.error('Module enable command rejected:', error)
    result = { status: 'unavailable' }
  }
  const outcome = moduleMutationOutcome(result, failureRollbackDisposition)
  if (outcome.status !== 'queued') settlementCleanup()
  return outcome
}

export async function setGlobalModuleEnabled(moduleId: string, enabled: boolean): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canResolveGlobalModuleTarget(moduleId) || !canWriteEnabledModuleOwner()) {
    return { status: 'failed', result: unavailableModuleOwnerResult() }
  }
  if (canUseServerCommands()) {
    const previous = currentGlobalModuleStateSnapshot()
    applyOptimisticGlobalModuleEnabled(moduleId, enabled)
    return dispatchEnableModule(moduleId, enabled, previous)
  }

  if (enabled) {
    const enabledModules = enabledModulesOwnerRead()
    if (!enabledModules.includes(moduleId)) {
      enabledModulesOwnerWrite([...enabledModules, moduleId])
    }
  } else {
    enabledModulesOwnerWrite(enabledModulesOwnerRead().filter((id) => id !== moduleId))
  }
  reloadGuiAfterDefinitionChange()
  return { status: 'accepted', result: null }
}

export async function createGlobalModule(module: RisuModule): Promise<ServerCommandResult | null> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  // Classified interchange repair: every production caller of this legacy API
  // is a module import path. Imported child rows may have missing or duplicate
  // ids, so normalize them once before the durable create owns the result.
  delete module.folderId
  if (Array.isArray(module.lorebook)) ensureClientLorebookEntryIds(module.lorebook)
  if (Array.isArray(module.regex)) ensureClientScriptDefinitionIds(module.regex)
  if (Array.isArray(module.trigger)) ensureClientTriggerDefinitionIds(module.trigger)

  if (canUseServerCommands()) {
    const previous = currentGlobalModuleStateSnapshot()
    applyOptimisticCreatedGlobalModule(module)
    return dispatchCreateModule(module, previous)
  }

  moduleCollectionOwnerWrite([...moduleCollectionOwnerRead(), module])
  reloadGuiAfterDefinitionChange()
  return null
}

/** Outcome-aware create used by explicit editors that must retain recovery drafts until acceptance. */
export async function createGlobalModuleWithOutcome(module: RisuModule): Promise<ModuleEditorSaveOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canUseServerCommands()) {
    moduleCollectionOwnerWrite([...moduleCollectionOwnerRead(), module])
    reloadGuiAfterDefinitionChange()
    return { status: 'accepted', result: null }
  }

  const previous = currentGlobalModuleStateSnapshot()
  applyOptimisticCreatedGlobalModule(module)
  const moduleSnapshot = toModuleSnapshot(module)
  const rollbackEntry = moduleCreateRollbackEntry(moduleSnapshot as RisuModule)
  const operation = issueGlobalModuleOperation([rollbackEntry])
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [MODULE_COLLECTION_MUTATION_KEY],
    requests: [
      {
        method: 'POST',
        path: '/modules',
        body: { module: cloneJsonValue(moduleSnapshot) },
      },
    ],
  }
  const outbox = stagePendingMutation(moduleOwnerMutationKey(module.id), intent)
  recordPendingMutationProjectionTargets(outbox, globalModuleProjectionTargets([rollbackEntry]))
  let resolveSettlement!: (outcome: ModuleEditorSaveFinalOutcome) => void
  const settlement = new Promise<ModuleEditorSaveFinalOutcome>((resolve) => {
    resolveSettlement = resolve
  })
  const settlementCleanup = registerDurableMutationSettlementListener(outbox.mutationId, (final, details) => {
    if (final === 'accepted') {
      clearGlobalModuleOperation(operation)
      resolveSettlement({ status: 'accepted' })
      return
    }
    rollbackGlobalModuleEntries([rollbackEntry], operation)
    resolveSettlement({ status: 'failed', result: moduleEditorFinalFailureResult(details.result) })
  })
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  let result: ServerCommandResult
  try {
    result = await dispatchDurableMutation(outbox, intent, (transport) => {
      failureRollbackDisposition = transport.failureRollbackDisposition
      return runModuleCommand(
        async (baseRevision) => {
          const result = await createModuleCommand(
            { baseRevision, module: cloneJsonValue(moduleSnapshot) },
            transport.signal,
            true,
          )
          if (result.status === 'ok') clearGlobalModuleOperation(operation)
          return result
        },
        () => rollbackGlobalModuleEntries([rollbackEntry], operation),
        transport,
      )
    })
  } catch {
    result = { status: 'unavailable' }
  }
  if (result.status === 'ok') {
    settlementCleanup()
    return { status: 'accepted', result }
  }
  if (failureRollbackDisposition?.(result) === 'retain') {
    return {
      status: 'queued',
      result,
      mutationIds: [outbox.mutationId],
      settlement,
    }
  }
  settlementCleanup()
  return { status: 'failed', result }
}

export async function updateGlobalModule(moduleId: string, module: RisuModule): Promise<ServerCommandResult | null> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  if (!canResolveGlobalModuleTarget(moduleId)) return unavailableModuleOwnerResult()
  if (canUseServerCommands()) {
    const previous = currentGlobalModuleStateSnapshot()
    const moduleSnapshot = toModuleSnapshot(module)
    const commandPatch = changedModulePatch(moduleId, moduleSnapshot, previous, { complete: true })
    const applied = applyOptimisticGlobalModulePatch(moduleId, commandPatch)
    if (applied) reloadGuiAfterDefinitionChange()
    return dispatchUpdateModule(moduleId, moduleSnapshot, previous)
  }

  const modules = moduleCollectionOwnerRead()
  const index = uniqueModuleIndex(modules, moduleId)
  if (index !== -1) {
    const nextModules = [...modules]
    nextModules[index] = module
    moduleCollectionOwnerWrite(nextModules)
    reloadGuiAfterDefinitionChange()
  }
  return null
}

/**
 * Persist a complete ModuleSettings editor draft through the module's existing
 * split command owners. The optimistic projection is applied as one local
 * module value, while the durable batch retains per-field rollback fences and
 * serializes each server-owned slice against the same module owner.
 */
export async function saveGlobalModuleDraftWithOutcome(
  moduleId: string,
  module: RisuModule,
): Promise<ModuleEditorSaveOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canResolveGlobalModuleTarget(moduleId)) return { status: 'failed', result: unavailableModuleOwnerResult() }
  if (!canUseServerCommands()) {
    const modules = moduleCollectionOwnerRead()
    const index = uniqueModuleIndex(modules, moduleId)
    if (index !== -1) {
      const nextModules = [...modules]
      nextModules[index] = cloneJsonValue(module)
      moduleCollectionOwnerWrite(nextModules)
      reloadGuiAfterDefinitionChange()
    }
    return { status: 'accepted', result: null }
  }

  const previous = currentGlobalModuleStateSnapshot()
  const previousModule = previous.modules.find((candidate) => candidate.id === moduleId)
  if (!previousModule) {
    return { status: 'failed', result: { status: 'error', error: 'Module no longer exists' } }
  }

  const target = cloneJsonValue(module)
  const commandPatch = changedModulePatch(moduleId, toModuleSnapshot(target), previous, { complete: true })
  const previousLorebook = normalizedModuleSplitCollection(previousModule, 'lorebook') as loreBook[]
  const previousScripts = normalizedModuleSplitCollection(previousModule, 'regex') as customscript[]
  const previousTriggers = normalizedModuleSplitCollection(previousModule, 'trigger') as triggerscript[]
  const lorebook = normalizedModuleSplitCollection(target, 'lorebook') as loreBook[]
  const scripts = normalizedModuleSplitCollection(target, 'regex') as customscript[]
  const triggers = normalizedModuleSplitCollection(target, 'trigger') as triggerscript[]
  const lorebookChanged = !isJsonValueEqual(previousLorebook, lorebook)
  const scriptsChanged = !isJsonValueEqual(previousScripts, scripts)
  const triggersChanged = !isJsonValueEqual(previousTriggers, triggers)

  const optimisticPatch: ModuleSnapshot = cloneJsonValue(commandPatch)
  if (lorebookChanged) optimisticPatch.lorebook = cloneJsonValue(lorebook)
  if (scriptsChanged) optimisticPatch.regex = cloneJsonValue(scripts)
  if (triggersChanged) optimisticPatch.trigger = cloneJsonValue(triggers)

  const applied = applyOptimisticGlobalModulePatch(moduleId, optimisticPatch)
  applyModuleDeletionSentinelsOptimistically(moduleId, commandPatch)
  if (applied) reloadGuiAfterDefinitionChange()

  const steps: ModuleCollectionPatchStep[] = []
  const metadataRollbackEntries = moduleFieldRollbackEntries(moduleId, commandPatch, previous)
  if (metadataRollbackEntries.length > 0) {
    steps.push({
      method: 'PATCH',
      path: `/modules/${encodeURIComponent(moduleId)}`,
      body: { patch: cloneJsonValue(commandPatch) },
      dependencyKeys: [moduleOwnerMutationKey(moduleId)],
      factory: (baseRevision, body) =>
        updateModuleCommand({ baseRevision, moduleId, patch: body.patch as ModuleSnapshot }, undefined, true),
      rollbackEntries: metadataRollbackEntries,
    })
  }

  if (lorebookChanged) {
    const rollbackEntry = moduleFieldRollbackEntry(moduleId, 'lorebook', previous, true, lorebook)
    if (rollbackEntry) {
      steps.push({
        method: 'PUT',
        path: `/modules/${encodeURIComponent(moduleId)}/lorebooks`,
        body: { entries: cloneJsonValue(lorebook) },
        dependencyKeys: [moduleOwnerMutationKey(moduleId)],
        factory: (baseRevision, body) =>
          replaceModuleLorebooksCommand(
            {
              baseRevision,
              moduleId,
              entries: body.entries as LorebookEntrySnapshot[],
            },
            undefined,
            true,
            true,
          ),
        rollbackEntries: [rollbackEntry],
      })
    }
  }

  if (scriptsChanged) {
    const rollbackEntry = moduleFieldRollbackEntry(moduleId, 'regex', previous, true, scripts)
    if (rollbackEntry) {
      steps.push({
        method: 'PUT',
        path: `/modules/${encodeURIComponent(moduleId)}/scripts`,
        body: { scripts: cloneJsonValue(scripts) },
        dependencyKeys: [moduleOwnerMutationKey(moduleId)],
        factory: (baseRevision, body) =>
          replaceModuleScriptsCommand(
            {
              baseRevision,
              moduleId,
              scripts: body.scripts as ScriptDefinitionSnapshot[],
            },
            undefined,
            true,
            true,
          ),
        rollbackEntries: [rollbackEntry],
      })
    }
  }

  if (triggersChanged) {
    const rollbackEntry = moduleFieldRollbackEntry(moduleId, 'trigger', previous, true, triggers)
    if (rollbackEntry) {
      steps.push({
        method: 'PUT',
        path: `/modules/${encodeURIComponent(moduleId)}/triggers`,
        body: { triggers: cloneJsonValue(triggers) },
        dependencyKeys: [moduleOwnerMutationKey(moduleId)],
        factory: (baseRevision, body) =>
          replaceModuleTriggersCommand(
            {
              baseRevision,
              moduleId,
              triggers: body.triggers as TriggerDefinitionSnapshot[],
            },
            undefined,
            true,
            true,
          ),
        rollbackEntries: [rollbackEntry],
      })
    }
  }

  const batch = runModuleCollectionPatchSteps(steps)
  if (!batch) return { status: 'accepted', result: null }
  const outcome = await batch
  if (outcome.status === 'ok') return { status: 'accepted', result: null }
  if (outcome.status === 'failure') return { status: 'failed', result: outcome.failure }
  if (!outcome.mutationIds || !outcome.settlement) return { status: 'failed', result: outcome.failure }
  return {
    status: 'queued',
    result: outcome.failure,
    mutationIds: outcome.mutationIds,
    settlement: outcome.settlement,
  }
}

export async function saveGlobalModuleDraft(moduleId: string, module: RisuModule): Promise<ServerCommandResult | null> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  const outcome = await saveGlobalModuleDraftWithOutcome(moduleId, module)
  return outcome.status === 'failed' ? outcome.result : null
}

function applyOptimisticGlobalModulePatch(moduleId: string, patch: ModuleSnapshot): boolean {
  if (Object.keys(patch).length === 0) return false

  const modules = moduleCollectionOwnerRead()
  const index = uniqueModuleIndex(modules, moduleId)
  if (index === -1) return false
  const nextModule = cloneJsonValue(modules[index]) as RisuModule & Record<string, unknown>

  for (const [field, value] of Object.entries(patch)) {
    if (value === null && MODULE_PATCH_DELETABLE_KEYS.has(field)) {
      delete nextModule[field]
    } else {
      nextModule[field] = cloneJsonValue(value)
    }
  }
  const nextModules = [...modules]
  nextModules[index] = nextModule
  moduleCollectionOwnerWrite(nextModules)
  return true
}

export async function deleteGlobalModule(moduleId: string): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canResolveGlobalModuleTarget(moduleId)) return { status: 'failed', result: unavailableModuleOwnerResult() }
  if (canUseServerCommands()) {
    const previous = currentGlobalModuleStateSnapshot(moduleId)
    applyOptimisticDeletedGlobalModule(moduleId)
    return dispatchDeleteModule(moduleId, previous)
  }

  enabledModulesOwnerWrite(enabledModulesOwnerRead().filter((id) => id !== moduleId))
  moduleCollectionOwnerWrite(moduleCollectionOwnerRead().filter((module) => module.id !== moduleId))
  removeProjectedModuleReferences(moduleId)
  reloadGuiAfterDefinitionChange()
  return { status: 'accepted', result: null }
}

function moduleMutationOutcome(
  result: ServerCommandResult,
  failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition'],
): ModuleMutationOutcome {
  if (result.status === 'ok') return { status: 'accepted', result }
  if (failureRollbackDisposition?.(result) === 'retain') return { status: 'queued', result }
  return { status: 'failed', result }
}

function moduleEditorFinalFailureResult(result: unknown): Exclude<ServerCommandResult, { status: 'ok' }> {
  if (result && typeof result === 'object') {
    const candidate = result as Exclude<ServerCommandResult, { status: 'ok' }>
    if (candidate.status === 'conflict' || candidate.status === 'unavailable' || candidate.status === 'error') {
      return candidate
    }
  }
  return { status: 'unavailable' }
}

function applyOptimisticGlobalModuleEnabled(moduleId: string, enabled: boolean): void {
  const enabledModules = new Set(enabledModulesOwnerRead())
  if (enabled) {
    enabledModules.add(moduleId)
  } else {
    enabledModules.delete(moduleId)
  }
  enabledModulesOwnerWrite(Array.from(enabledModules))
  reloadGuiAfterDefinitionChange()
}

function applyOptimisticCreatedGlobalModule(module: RisuModule): void {
  moduleCollectionOwnerWrite([...moduleCollectionOwnerRead(), cloneJsonValue(module)])
  reloadGuiAfterDefinitionChange()
}

function applyOptimisticDeletedGlobalModule(moduleId: string): void {
  enabledModulesOwnerWrite(enabledModulesOwnerRead().filter((id) => id !== moduleId))
  moduleCollectionOwnerWrite(moduleCollectionOwnerRead().filter((module) => module.id !== moduleId))
  removeProjectedModuleReferences(moduleId)
  reloadGuiAfterDefinitionChange()
}

function removeProjectedModuleReferences(moduleId: string): void {
  for (const persona of personaModuleReferenceOwners()) {
    if (Array.isArray(persona.modules)) {
      persona.modules = persona.modules.filter((id) => id !== moduleId)
    }
  }

  for (const character of characterModuleReferenceOwners()) {
    if (Array.isArray(character.modules)) {
      character.modules = character.modules.filter((id) => id !== moduleId)
    }

    for (const chat of character.chats ?? []) {
      if (Array.isArray(chat.modules)) {
        applyChatMetadataOwnerPatch(character.chaId, chat.id, {
          modules: chat.modules.filter((id) => id !== moduleId),
        })
      }
    }
  }

  for (const loadout of loadoutModuleReferenceOwners()) {
    if (Array.isArray(loadout.modules)) {
      loadout.modules = loadout.modules.filter((id) => id !== moduleId)
    }
  }
}

export async function dispatchReorderModules(previous: GlobalModuleStateSnapshot): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canUseServerCommands()) return { status: 'accepted', result: null }
  const attemptedModuleIds = moduleCollectionOwnerRead().map((module) => module.id)
  const attemptedModules = moduleCollectionOwnerRead()
  const folderIds = new Set(moduleFoldersOwnerRead().map((folder) => folder.id))
  const folderByModuleId = Object.fromEntries(
    attemptedModules.map((module) => [
      module.id,
      module.folderId && folderIds.has(module.folderId) ? module.folderId : null,
    ]),
  )
  const rollbackEntries: GlobalModuleRollbackEntry[] = [moduleOrderRollbackEntry(previous, attemptedModuleIds)]
  for (const module of attemptedModules) {
    const previousModule = previous.modules.find((candidate) => candidate.id === module.id)
    if (!previousModule || previousModule.folderId === module.folderId) continue
    const entry = moduleFieldRollbackEntry(
      module.id,
      'folderId',
      previous,
      module.folderId !== undefined,
      module.folderId,
    )
    if (entry) rollbackEntries.push(entry)
  }
  const batch = runModuleCollectionPatchSteps([
    {
      method: 'POST',
      path: '/modules/reorder',
      body: { moduleIds: cloneJsonValue(attemptedModuleIds), folderByModuleId: cloneJsonValue(folderByModuleId) },
      dependencyKeys: attemptedModuleIds.map(moduleOwnerMutationKey),
      factory: (baseRevision, body) =>
        reorderModulesCommand(
          {
            baseRevision,
            moduleIds: body.moduleIds as string[],
            folderByModuleId: body.folderByModuleId as Record<string, string | null>,
          },
          undefined,
          true,
        ),
      rollbackEntries,
    },
  ])
  return moduleBatchOutcome(batch ? await batch : { status: 'ok', acceptedCount: 0 })
}

export async function createModuleFolder(folder: ModuleFolder): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canWriteModuleOrganizationOwner() || moduleFoldersOwnerRead().some((candidate) => candidate.id === folder.id)) {
    return { status: 'failed', result: unavailableModuleOwnerResult() }
  }
  const canonical = { id: folder.id.trim(), name: folder.name.trim() }
  if (!canonical.id || canonical.id !== folder.id || !canonical.name) {
    return { status: 'failed', result: { status: 'error', error: 'Invalid module folder', reason: 'invalid-request' } }
  }
  moduleFoldersOwnerWrite([...moduleFoldersOwnerRead(), canonical])
  reloadGuiAfterDefinitionChange()
  const entry: ModuleFolderCreateRollbackEntry = {
    kind: 'module-folder-create',
    target: moduleFolderRowRollbackTarget(canonical.id),
    folderId: canonical.id,
    attemptedFolder: cloneJsonValue(canonical),
  }
  const batch = runModuleCollectionPatchSteps([
    {
      method: 'POST',
      path: '/module-folders',
      body: { folder: cloneJsonValue(canonical) },
      dependencyKeys: [moduleFolderOwnerMutationKey(canonical.id)],
      factory: (baseRevision, body) => createModuleFolderCommand({ baseRevision, folder: body.folder as ModuleFolder }),
      rollbackEntries: [entry],
    },
  ])
  return moduleBatchOutcome(batch ? await batch : { status: 'ok', acceptedCount: 0 })
}

export async function renameModuleFolder(folderId: string, name: string): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canWriteModuleOrganizationOwner()) return { status: 'failed', result: unavailableModuleOwnerResult() }
  const folders = moduleFoldersOwnerRead()
  const index = folders.findIndex((folder) => folder.id === folderId)
  const canonicalName = name.trim()
  if (index === -1 || !canonicalName) {
    return { status: 'failed', result: { status: 'error', error: 'Invalid module folder', reason: 'invalid-request' } }
  }
  const previousName = folders[index].name
  if (previousName === canonicalName) return { status: 'accepted', result: null }
  const next = [...folders]
  next[index] = { ...next[index], name: canonicalName }
  moduleFoldersOwnerWrite(next)
  reloadGuiAfterDefinitionChange()
  const entry: ModuleFolderNameRollbackEntry = {
    kind: 'module-folder-name',
    target: moduleFolderNameRollbackTarget(folderId),
    folderId,
    previousName,
    attemptedName: canonicalName,
  }
  const batch = runModuleCollectionPatchSteps([
    {
      method: 'PATCH',
      path: `/module-folders/${encodeURIComponent(folderId)}`,
      body: { patch: { name: canonicalName } },
      dependencyKeys: [moduleFolderOwnerMutationKey(folderId)],
      factory: (baseRevision, body) =>
        updateModuleFolderCommand({
          baseRevision,
          folderId,
          patch: body.patch as Pick<ModuleFolder, 'name'>,
        }),
      rollbackEntries: [entry],
    },
  ])
  return moduleBatchOutcome(batch ? await batch : { status: 'ok', acceptedCount: 0 })
}

export async function deleteModuleFolder(folderId: string): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canWriteModuleOrganizationOwner()) return { status: 'failed', result: unavailableModuleOwnerResult() }
  const folders = moduleFoldersOwnerRead()
  const index = folders.findIndex((folder) => folder.id === folderId)
  if (index === -1) return { status: 'accepted', result: null }
  const previous = currentGlobalModuleStateSnapshot()
  const entries: GlobalModuleRollbackEntry[] = [
    {
      kind: 'module-folder-delete',
      target: moduleFolderRowRollbackTarget(folderId),
      folderId,
      previousFolder: cloneJsonValue(folders[index]),
      previousIndex: index,
    },
  ]
  const nextModules = moduleCollectionOwnerRead().map((module) => {
    if (module.folderId !== folderId) return module
    const fieldEntry = moduleFieldRollbackEntry(module.id, 'folderId', previous, false, undefined)
    if (fieldEntry) entries.push(fieldEntry)
    const nextModule = { ...module }
    delete nextModule.folderId
    return nextModule
  })
  moduleFoldersOwnerWrite(folders.filter((folder) => folder.id !== folderId))
  moduleCollectionOwnerWrite(nextModules)
  reloadGuiAfterDefinitionChange()
  const batch = runModuleCollectionPatchSteps([
    {
      method: 'DELETE',
      path: `/module-folders/${encodeURIComponent(folderId)}`,
      body: {},
      dependencyKeys: [moduleFolderOwnerMutationKey(folderId)],
      factory: (baseRevision) => deleteModuleFolderCommand({ baseRevision, folderId }),
      rollbackEntries: entries,
    },
  ])
  return moduleBatchOutcome(batch ? await batch : { status: 'ok', acceptedCount: 0 })
}

export async function reorderModuleFolders(folderIds: readonly string[]): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canWriteModuleOrganizationOwner()) return { status: 'failed', result: unavailableModuleOwnerResult() }
  const folders = moduleFoldersOwnerRead()
  if (folderIds.length !== folders.length || new Set(folderIds).size !== folderIds.length) {
    return {
      status: 'failed',
      result: { status: 'error', error: 'Invalid module folder order', reason: 'invalid-request' },
    }
  }
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  if (folderIds.some((folderId) => !byId.has(folderId))) {
    return {
      status: 'failed',
      result: { status: 'error', error: 'Invalid module folder order', reason: 'invalid-request' },
    }
  }
  const previousFolderIds = folders.map((folder) => folder.id)
  const attemptedFolderIds = [...folderIds]
  if (isStringArrayEqual(previousFolderIds, attemptedFolderIds)) return { status: 'accepted', result: null }
  moduleFoldersOwnerWrite(attemptedFolderIds.map((folderId) => byId.get(folderId)!))
  reloadGuiAfterDefinitionChange()
  const entry: ModuleFolderOrderRollbackEntry = {
    kind: 'module-folder-order',
    target: 'module-folder-order:current',
    previousFolderIds,
    attemptedFolderIds,
  }
  const batch = runModuleCollectionPatchSteps([
    {
      method: 'POST',
      path: '/module-folders/reorder',
      body: { folderIds: attemptedFolderIds },
      dependencyKeys: attemptedFolderIds.map(moduleFolderOwnerMutationKey),
      factory: (baseRevision, body) =>
        reorderModuleFoldersCommand({ baseRevision, folderIds: body.folderIds as string[] }),
      rollbackEntries: [entry],
    },
  ])
  return moduleBatchOutcome(batch ? await batch : { status: 'ok', acceptedCount: 0 })
}

export async function reorderGlobalModules(modules: RisuModule[]): Promise<ModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canWriteModuleOrganizationOwner() || !isStableModuleCollection(modules)) {
    return { status: 'failed', result: unavailableModuleOwnerResult() }
  }
  const live = moduleCollectionOwnerRead()
  const liveIds = new Set(live.map((module) => module.id))
  const folderIds = new Set(moduleFoldersOwnerRead().map((folder) => folder.id))
  if (
    modules.length !== live.length ||
    modules.some(
      (module) => !liveIds.has(module.id) || (module.folderId !== undefined && !folderIds.has(module.folderId)),
    )
  ) {
    return {
      status: 'failed',
      result: { status: 'error', error: 'Invalid module organization', reason: 'invalid-request' },
    }
  }
  const previous = currentGlobalModuleStateSnapshot()
  moduleCollectionOwnerWrite(cloneJsonValue(modules))
  reloadGuiAfterDefinitionChange()
  return dispatchReorderModules(previous)
}

function moduleBatchOutcome(outcome: CharacterOwnedDurableBatchResult): ModuleMutationOutcome {
  if (outcome.status === 'ok') return { status: 'accepted', result: null }
  if (outcome.status === 'retained') return { status: 'queued', result: outcome.failure }
  return { status: 'failed', result: outcome.failure }
}

export function dispatchModuleCollectionPatch(
  modules: RisuModule[],
  previous: GlobalModuleStateSnapshot,
): Promise<CharacterOwnedDurableBatchResult> | null {
  if (!canUseClientWriteAccess())
    return Promise.resolve({ status: 'failure', acceptedCount: 0, failure: { status: 'unavailable' } })
  if (!canUseServerCommands()) return null

  const beforeModules = new Map(previous.modules.map((module) => [module.id, module]))
  const nextModules = new Map(modules.map((module) => [module.id, module]))
  const steps: ModuleCollectionPatchStep[] = []

  for (const module of modules) {
    if (typeof module.id !== 'string' || module.id.trim() === '') continue
    const before = beforeModules.get(module.id)
    if (!before) {
      const moduleSnapshot = toModuleSnapshot(module)
      steps.push({
        method: 'POST',
        path: '/modules',
        body: { module: cloneJsonValue(moduleSnapshot) },
        dependencyKeys: [moduleOwnerMutationKey(module.id)],
        factory: (baseRevision, body) =>
          createModuleCommand({ baseRevision, module: body.module as ModuleSnapshot }, undefined, true),
        rollbackEntries: [moduleCreateRollbackEntry(moduleSnapshot as RisuModule)],
      })
      continue
    }
    const moduleId = module.id
    const commandPatch = changedModulePatch(moduleId, toModuleSnapshot(module), previous, { complete: true })
    if (Object.keys(commandPatch).length === 0) continue
    applyModuleDeletionSentinelsOptimistically(moduleId, commandPatch)
    const rollbackEntries = moduleFieldRollbackEntries(moduleId, commandPatch, previous)
    if (rollbackEntries.length === 0) continue
    steps.push({
      method: 'PATCH',
      path: `/modules/${encodeURIComponent(moduleId)}`,
      body: { patch: cloneJsonValue(commandPatch) },
      dependencyKeys: [moduleOwnerMutationKey(moduleId)],
      factory: (baseRevision, body) =>
        updateModuleCommand({ baseRevision, moduleId, patch: body.patch as ModuleSnapshot }, undefined, true),
      rollbackEntries,
    })
  }

  for (const module of previous.modules) {
    if (typeof module.id === 'string' && module.id.trim() && !nextModules.has(module.id)) {
      const moduleId = module.id
      const rollbackEntries = moduleDeleteRollbackEntries(moduleId, previous)
      if (rollbackEntries.length > 0) {
        steps.push({
          method: 'DELETE',
          path: `/modules/${encodeURIComponent(moduleId)}`,
          body: {},
          dependencyKeys: [moduleOwnerMutationKey(moduleId)],
          factory: (baseRevision) => deleteModuleCommand({ baseRevision, moduleId }),
          rollbackEntries,
        })
      }
    }
  }

  const attemptedModuleIds = modules.map((module) => module.id)
  const expectedOrderAfterCreateDelete = previous.modules
    .map((module) => module.id)
    .filter((moduleId) => nextModules.has(moduleId))
  for (const module of modules) {
    if (!beforeModules.has(module.id)) {
      expectedOrderAfterCreateDelete.push(module.id)
    }
  }
  if (!isStringArrayEqual(expectedOrderAfterCreateDelete, attemptedModuleIds)) {
    steps.push({
      // A preceding authoritative delete refresh can temporarily restore the
      // server's pre-reorder projection. Keep this sequence's final reorder
      // authoritative so it cannot fence that intermediate order as current.
      method: 'POST',
      path: '/modules/reorder',
      body: { moduleIds: cloneJsonValue(attemptedModuleIds) },
      dependencyKeys: attemptedModuleIds.map(moduleOwnerMutationKey),
      factory: (baseRevision, body) => reorderModulesCommand({ baseRevision, moduleIds: body.moduleIds as string[] }),
      rollbackEntries: [moduleOrderRollbackEntry(previous, attemptedModuleIds)],
    })
  }

  return runModuleCollectionPatchSteps(steps)
}

export function dispatchEnabledModulesPatch(
  enabledModules: unknown[],
  previous: GlobalModuleStateSnapshot,
  modules: RisuModule[],
): Promise<CharacterOwnedDurableBatchResult> | null {
  if (!canUseClientWriteAccess())
    return Promise.resolve({ status: 'failure', acceptedCount: 0, failure: { status: 'unavailable' } })
  if (!canUseServerCommands()) return null

  const before = new Set(previous.enabledModules)
  const next = new Set(enabledModules.filter((id): id is string => typeof id === 'string'))
  const knownModules = new Set(modules.map((module) => module.id))
  const steps: ModuleCollectionPatchStep[] = []

  for (const moduleId of next) {
    if (!before.has(moduleId) && knownModules.has(moduleId)) {
      steps.push({
        method: 'POST',
        path: '/modules/enable',
        body: { moduleId, enabled: true },
        dependencyKeys: [moduleOwnerMutationKey(moduleId)],
        factory: (baseRevision, body) =>
          enableModuleCommand({
            baseRevision,
            moduleId: body.moduleId as string,
            enabled: body.enabled as boolean,
          }),
        rollbackEntries: [moduleEnableRollbackEntry(moduleId, true, previous)],
      })
    }
  }
  for (const moduleId of before) {
    if (!next.has(moduleId) && knownModules.has(moduleId)) {
      steps.push({
        method: 'POST',
        path: '/modules/enable',
        body: { moduleId, enabled: false },
        dependencyKeys: [moduleOwnerMutationKey(moduleId)],
        factory: (baseRevision, body) =>
          enableModuleCommand({
            baseRevision,
            moduleId: body.moduleId as string,
            enabled: body.enabled as boolean,
          }),
        rollbackEntries: [moduleEnableRollbackEntry(moduleId, false, previous)],
      })
    }
  }

  return runModuleCollectionPatchSteps(steps)
}

function runModuleCollectionPatchSteps(
  steps: ModuleCollectionPatchStep[],
): Promise<CharacterOwnedDurableBatchResult> | null {
  if (steps.length === 0) return null

  const operationSteps = steps.map((step) => ({
    ...step,
    operation: issueGlobalModuleOperation(step.rollbackEntries),
  }))

  const result = dispatchOwnedDurableBatch(
    MODULE_COLLECTION_MUTATION_KEY,
    operationSteps.map((step) => {
      const projectionTargets = globalModuleProjectionTargets(step.rollbackEntries)
      return {
        method: step.method,
        path: step.path,
        body: step.body,
        dependencyKeys: step.dependencyKeys,
        projectionTargets,
        command: async (baseRevision: number, body: Readonly<Record<string, unknown>>) => {
          const result = await step.factory(baseRevision, body)
          if (result.status === 'ok') clearGlobalModuleOperation(step.operation)
          return result
        },
        rollback: () => rollbackGlobalModuleEntries(step.rollbackEntries, step.operation),
        reapply: (isTargetCurrent: (target: string) => boolean) =>
          reapplyGlobalModuleEntries(step.rollbackEntries, isTargetCurrent),
      }
    }),
  )
  void result.then((outcome) => {
    // A retryable suffix is now an encrypted, replayable baseline. Remove its
    // in-memory rollback records so a later edit rolls back to that queued
    // projection instead of treating it as a failed local write.
    if (outcome.status !== 'retained') return
    for (const step of operationSteps.slice(outcome.acceptedCount)) {
      clearGlobalModuleOperation(step.operation)
    }
  })
  return result
}

function moduleCreateRollbackEntry(module: RisuModule): ModuleCreateRollbackEntry {
  return {
    kind: 'module-create',
    target: moduleRowRollbackTarget(module.id),
    moduleId: module.id,
    attemptedModule: cloneJsonValue(module),
  }
}

function moduleFieldRollbackEntries(
  moduleId: string,
  patch: ModuleSnapshot,
  previous: GlobalModuleStateSnapshot,
): ModuleFieldRollbackEntry[] {
  return Object.entries(patch)
    .map(([field, value]) => {
      const deletesField = value === null && MODULE_PATCH_DELETABLE_KEYS.has(field)
      return moduleFieldRollbackEntry(moduleId, field, previous, !deletesField, deletesField ? undefined : value)
    })
    .filter((entry): entry is ModuleFieldRollbackEntry => entry !== null)
}

function applyModuleDeletionSentinelsOptimistically(moduleId: string, patch: ModuleSnapshot): void {
  const deletedFields = Object.entries(patch)
    .filter(([field, value]) => value === null && MODULE_PATCH_DELETABLE_KEYS.has(field))
    .map(([field]) => field)
  if (deletedFields.length === 0) return

  const modules = moduleCollectionOwnerRead()
  const index = uniqueModuleIndex(modules, moduleId)
  const currentModule = (index === -1 ? undefined : modules[index]) as
    | (RisuModule & Record<string, unknown>)
    | undefined
  if (!currentModule) return
  const nextModule = cloneJsonValue(currentModule)
  const nextModules = [...modules]
  for (const field of deletedFields) {
    if (nextModule[field] === null) delete nextModule[field]
  }
  nextModules[index] = nextModule
  moduleCollectionOwnerWrite(nextModules)
}

function moduleFieldRollbackEntry(
  moduleId: string,
  field: string,
  previous: GlobalModuleStateSnapshot,
  attemptedExists: boolean,
  attemptedValue: unknown,
): ModuleFieldRollbackEntry | null {
  const previousModule = previous.modules.find((module) => module.id === moduleId)
  if (!previousModule) return null
  const previousRecord = previousModule as unknown as Record<string, unknown>
  return {
    kind: 'module-field',
    target: moduleFieldRollbackTarget(moduleId, field),
    moduleId,
    field,
    previousExists: hasOwnRecordKey(previousRecord, field),
    previousValue: cloneJsonValue(previousRecord[field]),
    attemptedExists,
    attemptedValue: cloneJsonValue(attemptedValue),
  }
}

function moduleDeleteRollbackEntries(
  moduleId: string,
  previous: GlobalModuleStateSnapshot,
): GlobalModuleRollbackEntry[] {
  const entries: GlobalModuleRollbackEntry[] = []
  const previousIndex = previous.modules.findIndex((module) => module.id === moduleId)
  if (previousIndex !== -1) {
    entries.push({
      kind: 'module-delete-row',
      target: moduleRowRollbackTarget(moduleId),
      moduleId,
      previousModule: cloneJsonValue(previous.modules[previousIndex]),
      previousIndex,
    })
  }

  const enableEntry = moduleEnableRollbackEntry(moduleId, false, previous)
  if (enableEntry.previousEnabled) {
    entries.push(enableEntry)
  }

  if (previous.moduleReferences) {
    entries.push(...moduleReferenceRollbackEntries(moduleId, previous.moduleReferences))
  }

  return entries
}

function moduleEnableRollbackEntry(
  moduleId: string,
  attemptedEnabled: boolean,
  previous: GlobalModuleStateSnapshot,
): ModuleEnableRollbackEntry {
  const previousIndex = previous.enabledModules.indexOf(moduleId)
  return {
    kind: 'module-enable',
    target: moduleEnableRollbackTarget(moduleId),
    moduleId,
    previousEnabled: previousIndex !== -1,
    previousIndex,
    attemptedEnabled,
  }
}

function moduleReferenceRollbackEntries(
  moduleId: string,
  snapshot: ModuleReferenceStateSnapshot,
): ModuleReferenceRollbackEntry[] {
  const entries: ModuleReferenceRollbackEntry[] = []

  for (const personaSnapshot of snapshot.personas) {
    entries.push({
      kind: 'module-reference',
      target: modulePersonaReferenceRollbackTarget(personaSnapshot.personaId),
      personaId: personaSnapshot.personaId,
      previous: cloneJsonValue(personaSnapshot.modules),
      attempted: moduleReferenceAttemptAfterDelete(personaSnapshot.modules, moduleId),
    })
  }

  for (const characterSnapshot of snapshot.characters) {
    if (characterSnapshot.modules) {
      entries.push({
        kind: 'module-reference',
        target: moduleCharacterReferenceRollbackTarget(characterSnapshot.characterId),
        characterId: characterSnapshot.characterId,
        previous: cloneJsonValue(characterSnapshot.modules),
        attempted: moduleReferenceAttemptAfterDelete(characterSnapshot.modules, moduleId),
      })
    }

    for (const chatSnapshot of characterSnapshot.chats) {
      entries.push({
        kind: 'module-reference',
        target: moduleChatReferenceRollbackTarget(characterSnapshot.characterId, chatSnapshot.chatId),
        characterId: characterSnapshot.characterId,
        chatId: chatSnapshot.chatId,
        previous: cloneJsonValue(chatSnapshot.modules),
        attempted: moduleReferenceAttemptAfterDelete(chatSnapshot.modules, moduleId),
      })
    }
  }

  for (const loadoutSnapshot of snapshot.loadouts) {
    entries.push({
      kind: 'module-reference',
      target: moduleLoadoutReferenceRollbackTarget(loadoutSnapshot),
      loadoutId: loadoutSnapshot.loadoutId,
      previous: cloneJsonValue(loadoutSnapshot.modules),
      attempted: moduleReferenceAttemptAfterDelete(loadoutSnapshot.modules, moduleId),
    })
  }

  return entries
}

function moduleReferenceAttemptAfterDelete(snapshot: ModuleIdsFieldSnapshot, moduleId: string): ModuleIdsFieldSnapshot {
  return {
    hasModulesField: snapshot.hasModulesField,
    modules: snapshot.modules?.filter((id) => id !== moduleId),
  }
}

function moduleOrderRollbackEntry(
  previous: GlobalModuleStateSnapshot,
  attemptedModuleIds: string[],
): ModuleOrderRollbackEntry {
  return {
    kind: 'module-order',
    target: 'module-order:current',
    previousModuleIds: previous.modules.map((module) => module.id),
    attemptedModuleIds: [...attemptedModuleIds],
  }
}

function issueGlobalModuleOperation(entries: GlobalModuleRollbackEntry[]): GlobalModuleOperationToken {
  const targets = [...new Set(entries.flatMap((entry) => globalModuleRollbackTargets(entry)))]
  const token = {
    sequence: ++nextGlobalModuleOperationSequence,
    targets,
  }

  for (const entry of entries) {
    for (const target of globalModuleRollbackTargets(entry)) {
      const pendingOperations = pendingGlobalModuleOperationsByTarget.get(target) ?? []
      pendingOperations.push({
        sequence: token.sequence,
        entry,
        status: 'pending',
      })
      pendingGlobalModuleOperationsByTarget.set(target, pendingOperations)
    }
  }

  return token
}

function rollbackGlobalModuleEntries(
  entries: GlobalModuleRollbackEntry[],
  operation: GlobalModuleOperationToken,
): void {
  let changed = false

  void entries
  for (const target of operation.targets) {
    const pendingOperations = pendingGlobalModuleOperationsByTarget.get(target)
    const operationRecords = pendingOperations?.filter((record) => record.sequence === operation.sequence) ?? []
    if (!pendingOperations || operationRecords.length === 0) continue

    for (const operationRecord of operationRecords) {
      operationRecord.status = 'failed'
    }
    changed = cascadeFailedGlobalModuleOperationsForTarget(target, pendingOperations) || changed

    if (pendingOperations.length > 0) {
      pendingGlobalModuleOperationsByTarget.set(target, pendingOperations)
    } else {
      pendingGlobalModuleOperationsByTarget.delete(target)
    }
  }

  if (changed) {
    reloadGuiAfterDefinitionChange()
  }
}

function cascadeFailedGlobalModuleOperationsForTarget(
  target: string,
  pendingOperations: GlobalModuleOperationRecord[],
): boolean {
  let changed = false

  while (pendingOperations.length > 0) {
    const latestOperation = pendingOperations[pendingOperations.length - 1]
    if (latestOperation.status !== 'failed') break

    if (rollbackGlobalModuleEntryIfLiveMatches(latestOperation.entry)) {
      changed = true
    }
    pendingOperations.pop()
  }

  if (pendingOperations.length > 0) {
    pendingGlobalModuleOperationsByTarget.set(target, pendingOperations)
  } else {
    pendingGlobalModuleOperationsByTarget.delete(target)
  }

  return changed
}

function rollbackGlobalModuleEntryIfLiveMatches(entry: GlobalModuleRollbackEntry): boolean {
  if (entry.kind === 'module-create') {
    return rollbackModuleCreateIfLiveMatches(entry)
  }
  if (entry.kind === 'module-field') {
    return rollbackModuleFieldIfLiveMatches(entry)
  }
  if (entry.kind === 'module-delete-row') {
    return rollbackModuleDeleteRowIfLiveMatches(entry)
  }
  if (entry.kind === 'module-enable') {
    return rollbackModuleEnableIfLiveMatches(entry)
  }
  if (entry.kind === 'module-reference') {
    return rollbackModuleReferenceIfLiveMatches(entry)
  }
  if (entry.kind === 'module-folder-create') return rollbackModuleFolderCreateIfLiveMatches(entry)
  if (entry.kind === 'module-folder-name') return rollbackModuleFolderNameIfLiveMatches(entry)
  if (entry.kind === 'module-folder-delete') return rollbackModuleFolderDeleteIfLiveMatches(entry)
  if (entry.kind === 'module-folder-order') return rollbackModuleFolderOrderIfLiveMatches(entry)
  return rollbackModuleOrderIfLiveMatches(entry)
}

function rollbackModuleFolderCreateIfLiveMatches(entry: ModuleFolderCreateRollbackEntry): boolean {
  const folders = moduleFoldersOwnerRead()
  const index = folders.findIndex((folder) => folder.id === entry.folderId)
  if (index === -1 || !isJsonValueEqual(folders[index], entry.attemptedFolder)) return false
  moduleFoldersOwnerWrite(folders.filter((_, folderIndex) => folderIndex !== index))
  return true
}

function rollbackModuleFolderNameIfLiveMatches(entry: ModuleFolderNameRollbackEntry): boolean {
  const folders = moduleFoldersOwnerRead()
  const index = folders.findIndex((folder) => folder.id === entry.folderId)
  if (index === -1 || folders[index].name !== entry.attemptedName) return false
  const next = [...folders]
  next[index] = { ...next[index], name: entry.previousName }
  moduleFoldersOwnerWrite(next)
  return true
}

function rollbackModuleFolderDeleteIfLiveMatches(entry: ModuleFolderDeleteRollbackEntry): boolean {
  const folders = moduleFoldersOwnerRead()
  if (folders.some((folder) => folder.id === entry.folderId)) return false
  const next = [...folders]
  next.splice(boundedInsertIndex(entry.previousIndex, next.length), 0, cloneJsonValue(entry.previousFolder))
  moduleFoldersOwnerWrite(next)
  return true
}

function rollbackModuleFolderOrderIfLiveMatches(entry: ModuleFolderOrderRollbackEntry): boolean {
  const folders = moduleFoldersOwnerRead()
  if (
    !isStringArrayEqual(
      folders.map((folder) => folder.id),
      entry.attemptedFolderIds,
    )
  )
    return false
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const reordered = entry.previousFolderIds.map((folderId) => byId.get(folderId))
  if (reordered.some((folder) => !folder)) return false
  moduleFoldersOwnerWrite(reordered as ModuleFolder[])
  return true
}

function rollbackModuleCreateIfLiveMatches(entry: ModuleCreateRollbackEntry): boolean {
  const modules = moduleCollectionOwnerRead()
  const index = uniqueModuleIndex(modules, entry.moduleId)
  if (index === -1 || !isJsonValueEqual(modules[index], entry.attemptedModule)) return false

  moduleCollectionOwnerWrite(modules.filter((_, moduleIndex) => moduleIndex !== index))
  return true
}

function rollbackModuleFieldIfLiveMatches(entry: ModuleFieldRollbackEntry): boolean {
  const modules = moduleCollectionOwnerRead()
  const index = uniqueModuleIndex(modules, entry.moduleId)
  if (index === -1) return false

  const liveModule = modules[index] as RisuModule & Record<string, unknown>
  const liveExists = hasOwnRecordKey(liveModule, entry.field)
  if (entry.attemptedExists) {
    if (!liveExists || !isJsonValueEqual(liveModule[entry.field], entry.attemptedValue)) return false
  } else if (liveExists && liveModule[entry.field] !== undefined) {
    return false
  }

  const nextModule = {
    ...liveModule,
  }

  if (entry.previousExists) {
    nextModule[entry.field] = cloneJsonValue(entry.previousValue)
  } else {
    delete nextModule[entry.field]
  }

  const nextModules = [...modules]
  nextModules[index] = nextModule
  moduleCollectionOwnerWrite(nextModules)
  return true
}

function rollbackModuleDeleteRowIfLiveMatches(entry: ModuleDeleteRowRollbackEntry): boolean {
  const modules = moduleCollectionOwnerRead()
  if (modules.some((module) => module.id === entry.moduleId)) return false

  const nextModules = [...modules]
  const insertIndex = boundedInsertIndex(entry.previousIndex, nextModules.length)
  nextModules.splice(insertIndex, 0, cloneJsonValue(entry.previousModule))
  moduleCollectionOwnerWrite(nextModules)
  return true
}

function rollbackModuleEnableIfLiveMatches(entry: ModuleEnableRollbackEntry): boolean {
  const enabledModules = enabledModulesOwnerRead()
  const liveIndex = enabledModules.indexOf(entry.moduleId)
  const liveEnabled = liveIndex !== -1
  if (liveEnabled !== entry.attemptedEnabled) return false
  if (liveEnabled === entry.previousEnabled) return false

  if (entry.previousEnabled) {
    const nextEnabledModules = enabledModules.filter((id) => id !== entry.moduleId)
    const insertIndex = boundedInsertIndex(entry.previousIndex, nextEnabledModules.length)
    nextEnabledModules.splice(insertIndex, 0, entry.moduleId)
    enabledModulesOwnerWrite(nextEnabledModules)
    return true
  }

  enabledModulesOwnerWrite(enabledModules.filter((id) => id !== entry.moduleId))
  return true
}

function rollbackModuleReferenceIfLiveMatches(entry: ModuleReferenceRollbackEntry): boolean {
  if (entry.characterId && entry.chatId) {
    return rollbackChatModulesOwner(entry.characterId, entry.chatId, entry.previous, entry.attempted)
  }
  const target = findModuleReferenceTarget(entry)
  if (!target || !modulesFieldMatches(target, entry.attempted)) return false
  restoreModulesField(target, entry.previous)
  return true
}

function findModuleReferenceTarget(entry: ModuleReferenceRollbackEntry): { modules?: string[] } | undefined {
  if (entry.personaId) {
    return personaModuleReferenceOwners().find((candidate) => candidate.id === entry.personaId)
  }
  if (entry.characterId) {
    return findCharacterById(entry.characterId)
  }
  const loadouts = loadoutModuleReferenceOwners()
  return entry.loadoutId ? loadouts.find((candidate) => candidate?.id === entry.loadoutId) : undefined
}

function modulesFieldMatches(target: { modules?: string[] }, snapshot: ModuleIdsFieldSnapshot): boolean {
  const hasModulesField = Object.prototype.hasOwnProperty.call(target, 'modules')
  if (hasModulesField !== snapshot.hasModulesField) return false
  const liveModules = Array.isArray(target.modules)
    ? target.modules.filter((id): id is string => typeof id === 'string')
    : undefined
  return isJsonValueEqual(liveModules, snapshot.modules)
}

function rollbackModuleOrderIfLiveMatches(entry: ModuleOrderRollbackEntry): boolean {
  const modules = moduleCollectionOwnerRead()
  const liveModuleIds = modules.map((module) => module.id)
  if (!isStringArrayEqual(liveModuleIds, entry.attemptedModuleIds)) return false

  const modulesById = new Map(modules.map((module) => [module.id, module]))
  const usedModuleIds = new Set<string>()
  const reorderedModules: RisuModule[] = []

  for (const moduleId of entry.previousModuleIds) {
    const module = modulesById.get(moduleId)
    if (!module) continue
    reorderedModules.push(module)
    usedModuleIds.add(moduleId)
  }

  for (const module of modules) {
    if (usedModuleIds.has(module.id)) continue
    reorderedModules.push(module)
  }

  if (
    isStringArrayEqual(
      reorderedModules.map((module) => module.id),
      liveModuleIds,
    )
  )
    return false
  moduleCollectionOwnerWrite(reorderedModules)
  return true
}

function clearGlobalModuleOperation(operation: GlobalModuleOperationToken): void {
  for (const target of operation.targets) {
    const pendingOperations = pendingGlobalModuleOperationsByTarget.get(target)
    if (!pendingOperations) continue

    const operationIndex = pendingOperations.findIndex((record) => record.sequence === operation.sequence)
    if (operationIndex === -1) continue

    const nextPendingOperations = pendingOperations.filter(
      (record, index) =>
        record.sequence !== operation.sequence && !(index < operationIndex && record.status === 'failed'),
    )
    if (nextPendingOperations.length > 0) {
      pendingGlobalModuleOperationsByTarget.set(target, nextPendingOperations)
    } else {
      pendingGlobalModuleOperationsByTarget.delete(target)
    }
  }
}

function moduleFieldRollbackTarget(moduleId: string, field: string): string {
  return `module-field:${moduleId}:${field}`
}

function moduleRowRollbackTarget(moduleId: string): string {
  return `module-row:${moduleId}`
}

function moduleEnableRollbackTarget(moduleId: string): string {
  return `module-enable:${moduleId}`
}

function moduleFolderRowRollbackTarget(folderId: string): string {
  return `module-folder-row:${folderId}`
}

function moduleFolderNameRollbackTarget(folderId: string): string {
  return `module-folder-name:${folderId}`
}

function moduleCharacterReferenceRollbackTarget(characterId: string): string {
  return `module-reference:character:${characterId}`
}

function modulePersonaReferenceRollbackTarget(personaId: string): string {
  return `module-reference:persona:${personaId}`
}

function moduleChatReferenceRollbackTarget(characterId: string, chatId: string): string {
  return `module-reference:chat:${characterId}:${chatId}`
}

function moduleLoadoutReferenceRollbackTarget(snapshot: LoadoutModuleReferenceSnapshot): string {
  return `module-reference:loadout:${snapshot.loadoutId}`
}

function globalModuleProjectionTarget(entry: GlobalModuleRollbackEntry): string {
  if (entry.kind === 'module-enable') return pendingMutationModuleEnabledProjectionTarget(entry.moduleId)
  return entry.target
}

function globalModuleProjectionTargets(entries: readonly GlobalModuleRollbackEntry[]): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) => [
        globalModuleProjectionTarget(entry),
        ...(entry.kind === 'module-field' ? [moduleRowRollbackTarget(entry.moduleId)] : []),
      ]),
    ),
  ]
}

function reapplyGlobalModuleEntries(
  entries: readonly GlobalModuleRollbackEntry[],
  isTargetCurrent: (target: string) => boolean,
): void {
  let changed = false
  for (const entry of entries) {
    if (!isTargetCurrent(globalModuleProjectionTarget(entry))) continue
    changed = reapplyGlobalModuleEntryIfLiveMatchesPrevious(entry) || changed
  }
  if (changed) reloadGuiAfterDefinitionChange()
}

function reapplyGlobalModuleEntryIfLiveMatchesPrevious(entry: GlobalModuleRollbackEntry): boolean {
  if (entry.kind === 'module-create') {
    const modules = moduleCollectionOwnerRead()
    if (modules.some((module) => module.id === entry.moduleId)) return false
    moduleCollectionOwnerWrite([...modules, cloneJsonValue(entry.attemptedModule)])
    return true
  }
  if (entry.kind === 'module-field') {
    const modules = moduleCollectionOwnerRead()
    const index = uniqueModuleIndex(modules, entry.moduleId)
    const module = (index === -1 ? undefined : modules[index]) as (RisuModule & Record<string, unknown>) | undefined
    if (!module) return false
    const liveExists = hasOwnRecordKey(module, entry.field)
    if (liveExists !== entry.previousExists) return false
    if (liveExists && !isJsonValueEqual(module[entry.field], entry.previousValue)) return false
    if (entry.attemptedExists) module[entry.field] = cloneJsonValue(entry.attemptedValue)
    else delete module[entry.field]
    const nextModules = [...modules]
    nextModules[index] = module
    moduleCollectionOwnerWrite(nextModules)
    return true
  }
  if (entry.kind === 'module-delete-row') {
    const modules = moduleCollectionOwnerRead()
    const index = uniqueModuleIndex(modules, entry.moduleId)
    if (index === -1 || !isJsonValueEqual(modules[index], entry.previousModule)) return false
    moduleCollectionOwnerWrite(modules.filter((_, moduleIndex) => moduleIndex !== index))
    return true
  }
  if (entry.kind === 'module-enable') {
    const enabledModules = enabledModulesOwnerRead()
    const liveEnabled = enabledModules.includes(entry.moduleId)
    if (liveEnabled !== entry.previousEnabled || liveEnabled === entry.attemptedEnabled) return false
    if (entry.attemptedEnabled) enabledModulesOwnerWrite([...enabledModules, entry.moduleId])
    else enabledModulesOwnerWrite(enabledModules.filter((moduleId) => moduleId !== entry.moduleId))
    return true
  }
  if (entry.kind === 'module-reference') {
    if (entry.characterId && entry.chatId) {
      return rollbackChatModulesOwner(entry.characterId, entry.chatId, entry.attempted, entry.previous)
    }
    const target = findModuleReferenceTarget(entry)
    if (!target || !modulesFieldMatches(target, entry.previous)) return false
    restoreModulesField(target, entry.attempted)
    return true
  }
  if (entry.kind === 'module-folder-create') {
    const folders = moduleFoldersOwnerRead()
    if (folders.some((folder) => folder.id === entry.folderId)) return false
    moduleFoldersOwnerWrite([...folders, cloneJsonValue(entry.attemptedFolder)])
    return true
  }
  if (entry.kind === 'module-folder-name') {
    const folders = moduleFoldersOwnerRead()
    const index = folders.findIndex((folder) => folder.id === entry.folderId)
    if (index === -1 || folders[index].name !== entry.previousName) return false
    const next = [...folders]
    next[index] = { ...next[index], name: entry.attemptedName }
    moduleFoldersOwnerWrite(next)
    return true
  }
  if (entry.kind === 'module-folder-delete') {
    const folders = moduleFoldersOwnerRead()
    const index = folders.findIndex((folder) => folder.id === entry.folderId)
    if (index === -1 || !isJsonValueEqual(folders[index], entry.previousFolder)) return false
    moduleFoldersOwnerWrite(folders.filter((_, folderIndex) => folderIndex !== index))
    return true
  }
  if (entry.kind === 'module-folder-order') {
    const folders = moduleFoldersOwnerRead()
    if (
      !isStringArrayEqual(
        folders.map((folder) => folder.id),
        entry.previousFolderIds,
      )
    )
      return false
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    const reordered = entry.attemptedFolderIds.map((folderId) => byId.get(folderId))
    if (reordered.some((folder) => !folder)) return false
    moduleFoldersOwnerWrite(reordered as ModuleFolder[])
    return true
  }

  const modules = moduleCollectionOwnerRead()
  if (
    !isStringArrayEqual(
      modules.map((module) => module.id),
      entry.previousModuleIds,
    )
  )
    return false
  const byId = new Map(modules.map((module) => [module.id, module]))
  const reordered = entry.attemptedModuleIds.map((moduleId) => byId.get(moduleId))
  if (reordered.some((module) => !module)) return false
  moduleCollectionOwnerWrite(reordered as RisuModule[])
  return true
}

function globalModuleRollbackTargets(entry: GlobalModuleRollbackEntry): string[] {
  if (entry.kind === 'module-field') {
    return [entry.target, moduleRowRollbackTarget(entry.moduleId)]
  }
  return [entry.target]
}

function boundedInsertIndex(index: number, length: number): number {
  if (index < 0) return 0
  if (index > length) return length
  return index
}

interface ActiveChatSidebarToggleDefaultUpdate {
  chatId: string
  generationSettings: ChatGenerationSettings
  rollback: ChatGenerationSettingsSnapshot
}

function applyMissingActiveChatSidebarToggleDefaults(): ActiveChatSidebarToggleDefaultUpdate | null {
  const state = resolveActiveChatGenerationSettings()
  if (!state.sidebarToggleDefinitionsReady) return null
  const chatId = state.identity.chatId
  const generationSettings = fillMissingActiveChatSidebarToggleDefaults(state)
  if (!chatId || !generationSettings || isJsonValueEqual(generationSettings, state.settings)) return null
  if (hasBlockingGenerationSettingsSaveReason(state)) return null

  const rollbackSnapshot = currentChatGenerationSettingsSnapshot(chatId)
  if (!rollbackSnapshot) return null

  const commandSettings = cloneJsonValue(generationSettings)
  const characterId = state.identity.characterId
  const chat = characterId ? uniqueChatModuleOwner(chatId, characterId) : null
  const applied = Boolean(chat)
  if (chat) chat.generationSettings = cloneJsonValue(commandSettings)

  if (!applied) return null
  return {
    chatId,
    generationSettings: commandSettings,
    rollback: {
      ...rollbackSnapshot,
      attemptedGenerationSettings: commandSettings,
    },
  }
}

function hasBlockingGenerationSettingsSaveReason(
  state: ReturnType<typeof resolveActiveChatGenerationSettings>,
): boolean {
  return state.readiness.missing.some((reason) => {
    switch (reason.code) {
      case 'persona_missing':
      case 'model_preset_missing':
      case 'prompt_preset_missing':
      case 'jailbreak_toggle_missing':
      case 'jailbreak_toggle_invalid':
        return true
      default:
        return false
    }
  })
}

interface ScopedModuleDurableBatchStep extends CharacterOwnedDurableBatchStep {
  operation: PendingScopedModuleOperation
}

async function dispatchScopedModuleDurableBatch(
  characterId: string | undefined,
  steps: ScopedModuleDurableBatchStep[],
): Promise<ScopedModuleMutationOutcome> {
  let outcome: CharacterOwnedDurableBatchResult
  try {
    outcome = await dispatchCharacterOwnedDurableBatch(characterId, steps)
  } catch (error) {
    for (const step of [...steps].reverse()) rejectScopedModuleOperation(step.operation)
    return {
      status: 'failed',
      result: {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        reason: 'invalid-request',
      },
    }
  }

  if (outcome.status === 'ok') {
    for (const step of steps.slice(outcome.acceptedCount)) acceptScopedModuleOperation(step.operation)
    return { status: 'accepted', result: null }
  }
  if (outcome.status === 'failure') return { status: 'failed', result: outcome.failure }

  const retainedSteps = steps.slice(outcome.acceptedCount)
  if (!outcome.mutationIds || !outcome.settlement) {
    for (const step of [...retainedSteps].reverse()) rejectScopedModuleOperation(step.operation)
    return { status: 'failed', result: outcome.failure }
  }

  const settlement = outcome.settlement.then((finalOutcome) => {
    if (finalOutcome.status === 'accepted') {
      for (const step of retainedSteps) acceptScopedModuleOperation(step.operation)
    }
    return finalOutcome
  })
  return {
    status: 'queued',
    result: outcome.failure,
    mutationIds: outcome.mutationIds,
    settlement,
  }
}

function uniqueChatModuleOwner(
  chatId: string,
  characterId?: string,
): { modules?: string[]; generationSettings?: ChatGenerationSettings } | null {
  let owner: { characterId: string; chat: character['chats'][number] } | null = null
  for (const character of characterModuleReferenceOwners()) {
    for (const chat of character.chats ?? []) {
      if (chat?.id !== chatId) continue
      if (owner) return null
      owner = { characterId: character.chaId, chat }
    }
  }
  if (!owner || (characterId && owner.characterId !== characterId)) return null
  return owner.chat
}

function modulesFieldMatchesAttempt(target: { modules?: string[] }, attempted: readonly string[]): boolean {
  return (
    Object.prototype.hasOwnProperty.call(target, 'modules') && isStringArrayEqual(target.modules ?? [], [...attempted])
  )
}

function rollbackChatModuleAttempt(previous: ChatScopedSnapshot, attempted: readonly string[]): boolean {
  if (!previous.characterId || !previous.chatId || !previous.chat) return false
  return rollbackChatModulesOwner(
    previous.characterId,
    previous.chatId,
    {
      hasModulesField: Object.prototype.hasOwnProperty.call(previous.chat, 'modules'),
      modules: cloneJsonValue(previous.chat.modules),
    },
    { hasModulesField: true, modules: [...attempted] },
  )
}

function rollbackCharacterModuleAttempt(previous: CharacterModuleStateSnapshot, attempted: readonly string[]): boolean {
  const character = findCharacterById(previous.characterId)
  if (!character || !modulesFieldMatchesAttempt(character, attempted)) return false
  if (previous.hasModulesField) character.modules = cloneJsonValue(previous.modules)
  else delete character.modules
  return true
}

function rollbackGenerationSettingsAttempt(snapshot: ChatGenerationSettingsSnapshot): boolean {
  if (!snapshot.attemptedGenerationSettings) return false
  const chat = uniqueChatModuleOwner(snapshot.chatId, snapshot.characterId)
  if (!chat) return false
  const row = chat as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(row, 'generationSettings')) return false
  if (!isJsonValueEqual(chat.generationSettings, snapshot.attemptedGenerationSettings)) return false
  if (snapshot.hadGenerationSettings) chat.generationSettings = cloneJsonValue(snapshot.generationSettings)
  else delete chat.generationSettings
  return true
}

function changedModuleProjectionTargets(previous: readonly string[], attempted: readonly string[]): string[] {
  const before = new Set(previous)
  const after = new Set(attempted)
  return [...new Set([...previous, ...attempted])]
    .filter((moduleId) => before.has(moduleId) !== after.has(moduleId))
    .map(pendingMutationModuleEnabledProjectionTarget)
}

function reapplyChatModuleAttempt(
  previous: ChatScopedSnapshot,
  attempted: readonly string[],
  isTargetCurrent: (target: string) => boolean,
): void {
  if (!previous.characterId || !previous.chatId || !previous.chat) return
  const owner = getChatMetadataOwnerSnapshot(previous.characterId, previous.chatId)
  if (!owner) return
  const previousModules = previous.chat.modules ?? []
  const before = new Set(previousModules)
  const after = new Set(attempted)
  let next = Array.isArray(owner.metadata.modules) ? [...owner.metadata.modules] : []
  let changed = false
  for (const moduleId of new Set([...previousModules, ...attempted])) {
    if (before.has(moduleId) === after.has(moduleId)) continue
    if (!isTargetCurrent(pendingMutationModuleEnabledProjectionTarget(moduleId))) continue
    const liveHas = next.includes(moduleId)
    if (liveHas === after.has(moduleId) || liveHas !== before.has(moduleId)) continue
    if (after.has(moduleId)) {
      next.splice(boundedInsertIndex(attempted.indexOf(moduleId), next.length), 0, moduleId)
    } else {
      next = next.filter((candidate) => candidate !== moduleId)
    }
    changed = true
  }
  if (!changed) return
  applyChatMetadataOwnerPatch(previous.characterId, previous.chatId, { modules: next })
  reloadGuiAfterDefinitionChange()
}

function reapplyCharacterModuleAttempt(
  previous: CharacterModuleStateSnapshot,
  attempted: readonly string[],
  projectionTarget: string,
  isTargetCurrent: (target: string) => boolean,
): void {
  if (!isTargetCurrent(projectionTarget)) return
  const character = findCharacterById(previous.characterId)
  if (!character) return
  const liveMatchesPrevious = previous.hasModulesField
    ? Object.prototype.hasOwnProperty.call(character, 'modules') &&
      isStringArrayEqual(character.modules ?? [], previous.modules ?? [])
    : !Object.prototype.hasOwnProperty.call(character, 'modules')
  if (!liveMatchesPrevious || modulesFieldMatchesAttempt(character, attempted)) return
  character.modules = cloneJsonValue([...attempted])
  reloadGuiAfterDefinitionChange()
}

function reapplyGenerationSettingsAttempt(
  snapshot: ChatGenerationSettingsSnapshot,
  projectionTarget: string,
  isTargetCurrent: (target: string) => boolean,
): void {
  if (!snapshot.attemptedGenerationSettings || !isTargetCurrent(projectionTarget)) return
  const chat = uniqueChatModuleOwner(snapshot.chatId, snapshot.characterId)
  if (!chat) return
  const hasLive = Object.prototype.hasOwnProperty.call(chat, 'generationSettings')
  const liveMatchesPrevious = snapshot.hadGenerationSettings
    ? hasLive && isJsonValueEqual(chat.generationSettings, snapshot.generationSettings)
    : !hasLive
  if (!liveMatchesPrevious || isJsonValueEqual(chat.generationSettings, snapshot.attemptedGenerationSettings)) return
  chat.generationSettings = cloneJsonValue(snapshot.attemptedGenerationSettings)
  reloadGuiAfterDefinitionChange()
}

function chatModuleDurableStep(
  chatId: string,
  nextModules: string[],
  previous: ChatScopedSnapshot,
): ScopedModuleDurableBatchStep {
  const commandModules = cloneJsonValue(nextModules)
  const operation = issueScopedModuleOperation(`chat-modules:${chatId}`, () =>
    rollbackChatModuleAttempt(previous, commandModules),
  )
  return {
    operation,
    method: 'PATCH',
    path: `/chats/${encodeURIComponent(chatId)}`,
    body: { patch: { modules: commandModules }, select: false },
    projectionTargets: changedModuleProjectionTargets(previous.chat?.modules ?? [], commandModules),
    command: async (baseRevision, body) => {
      const result = await updateChatCommand({
        baseRevision,
        chatId,
        patch: body.patch as ModuleSnapshot,
        select: body.select as boolean,
      })
      if (result.status === 'ok') acceptScopedModuleOperation(operation)
      return result
    },
    rollback: () => rejectScopedModuleOperation(operation),
    reapply: (isTargetCurrent) => reapplyChatModuleAttempt(previous, commandModules, isTargetCurrent),
  }
}

function characterModuleDurableStep(
  characterId: string,
  nextModules: string[],
  previous: CharacterModuleStateSnapshot,
): ScopedModuleDurableBatchStep {
  const commandModules = cloneJsonValue(nextModules)
  const path = `/characters/${encodeURIComponent(characterId)}/modules/reorder`
  const projectionTarget = `request:POST:${path}`
  const operation = issueScopedModuleOperation(`character-modules:${characterId}`, () =>
    rollbackCharacterModuleAttempt(previous, commandModules),
  )
  return {
    operation,
    method: 'POST',
    path,
    body: { moduleIds: commandModules },
    projectionTargets: [projectionTarget],
    command: async (baseRevision, body) => {
      const result = await reorderCharacterModulesCommand(
        { baseRevision, characterId, moduleIds: body.moduleIds as string[] },
        undefined,
        true,
      )
      if (result.status === 'ok') acceptScopedModuleOperation(operation)
      return result
    },
    rollback: () => rejectScopedModuleOperation(operation),
    reapply: (isTargetCurrent) =>
      reapplyCharacterModuleAttempt(previous, commandModules, projectionTarget, isTargetCurrent),
  }
}

function generationSettingsDurableStep(update: ActiveChatSidebarToggleDefaultUpdate): ScopedModuleDurableBatchStep {
  const commandSettings = cloneJsonValue(update.generationSettings)
  const rollback: ChatGenerationSettingsSnapshot = {
    ...update.rollback,
    attemptedGenerationSettings: commandSettings,
  }
  const projectionTarget = pendingMutationChatGenerationSettingsProjectionTarget(update.chatId)
  const operation = issueScopedModuleOperation(`chat-generation-settings:${update.chatId}`, () =>
    rollbackGenerationSettingsAttempt(rollback),
  )
  return {
    operation,
    method: 'PUT',
    path: `/chats/${encodeURIComponent(update.chatId)}/generation-settings`,
    body: { generationSettings: commandSettings },
    dependencyKeys: chatGenerationSettingsMutationDependencyKeys(commandSettings),
    projectionTargets: [projectionTarget],
    command: async (baseRevision, body) => {
      const result = await saveChatGenerationSettingsCommand({
        baseRevision,
        chatId: update.chatId,
        generationSettings: body.generationSettings as ChatGenerationSettings,
      })
      if (result.status === 'ok') acceptScopedModuleOperation(operation)
      return result
    },
    rollback: () => rejectScopedModuleOperation(operation),
    reapply: (isTargetCurrent) => reapplyGenerationSettingsAttempt(rollback, projectionTarget, isTargetCurrent),
  }
}

function dispatchUpdateChatScopedWithGenerationSettings(
  chatId: string,
  nextModules: string[],
  generationUpdate: ActiveChatSidebarToggleDefaultUpdate | null,
  previous: ChatScopedSnapshot,
): Promise<ScopedModuleMutationOutcome> {
  const steps = [chatModuleDurableStep(chatId, nextModules, previous)]
  if (generationUpdate) steps.push(generationSettingsDurableStep(generationUpdate))
  return dispatchScopedModuleDurableBatch(previous.characterId, steps)
}

function dispatchReorderCharacterModulesWithGenerationSettings(
  characterId: string,
  nextModules: string[],
  previous: CharacterModuleStateSnapshot,
  generationUpdate: ActiveChatSidebarToggleDefaultUpdate | null,
): Promise<ScopedModuleMutationOutcome> {
  const steps = [characterModuleDurableStep(characterId, nextModules, previous)]
  if (generationUpdate) steps.push(generationSettingsDurableStep(generationUpdate))
  return dispatchScopedModuleDurableBatch(characterId, steps)
}

export function dispatchReorderCharacterModules(characterId: string, previous: CharacterModuleStateSnapshot): void {
  if (!canUseClientWriteAccess()) return
  const character = findCharacterById(characterId)
  if (!character) return
  void dispatchReorderCharacterModulesWithGenerationSettings(characterId, character.modules ?? [], previous, null)
}

function selectedCharacterModuleOwner(): character | undefined {
  if (charactersResourceState.status !== 'ready') return undefined
  const selectedIndex = get(selectedCharID)
  const candidate = charactersResourceState.characters[selectedIndex]
  if (
    !candidate?.chaId ||
    (candidate as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] === true ||
    getCharacterResourceOwner(candidate.chaId) !== candidate
  ) {
    return undefined
  }
  return candidate
}

export function toggleSelectedChatModule(moduleId: string): Promise<ScopedModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const character = selectedCharacterModuleOwner()
  const chatIndex = character?.chatPage
  const chat = Number.isInteger(chatIndex) ? character?.chats?.[chatIndex] : undefined
  if (!chat?.id) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })

  // Toggling a chat's module link mutates only the active chat row, so the
  // rollback needs just that one chat — not a deep clone of every character
  // with every hydrated history.
  const previous = currentChatScopedSnapshot()
  const enabling = !(chat.modules ?? []).includes(moduleId)
  const nextModules = toggledModuleIds(chat.modules, moduleId)

  if (!applyChatMetadataOwnerPatch(character.chaId, chat.id, { modules: cloneJsonValue(nextModules) })) {
    return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  }

  const generationUpdate = enabling ? applyMissingActiveChatSidebarToggleDefaults() : null
  const outcome = dispatchUpdateChatScopedWithGenerationSettings(chat.id, nextModules, generationUpdate, previous)
  reloadGuiAfterDefinitionChange()
  return outcome
}

export function toggleSelectedCharacterModule(moduleId: string): Promise<ScopedModuleMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const character = selectedCharacterModuleOwner()
  if (!character?.chaId) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })

  const previous = currentCharacterModuleStateSnapshot(character.chaId)
  if (!previous) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const enabling = !(character.modules ?? []).includes(moduleId)
  const nextModules = toggledModuleIds(character.modules, moduleId)

  character.modules = cloneJsonValue(nextModules)

  const generationUpdate = enabling ? applyMissingActiveChatSidebarToggleDefaults() : null
  const outcome = dispatchReorderCharacterModulesWithGenerationSettings(
    character.chaId,
    nextModules,
    previous,
    generationUpdate,
  )
  reloadGuiAfterDefinitionChange()
  return outcome
}

export function toggledModuleIds(current: readonly string[] | undefined, moduleId: string): string[] {
  const existing = current ?? []
  if (existing.includes(moduleId)) {
    return existing.filter((candidate) => candidate !== moduleId)
  }
  return [...existing, moduleId]
}

export function toModuleSnapshot(module: RisuModule): ModuleSnapshot {
  return Object.fromEntries(
    Object.entries(module as RisuModule & Record<string, unknown>).map(([key, value]) => [key, cloneJsonValue(value)]),
  ) as ModuleSnapshot
}

export function sanitizeModulePatch(patch: ModuleSnapshot): ModuleSnapshot {
  const sanitized: ModuleSnapshot = {}
  for (const [key, value] of Object.entries(patch)) {
    if (MODULE_PATCH_EXCLUDED_KEYS.has(key) || value === undefined) continue
    sanitized[key] = value
  }
  return sanitized
}

function changedModulePatch(
  moduleId: string,
  patch: ModuleSnapshot,
  previous: GlobalModuleStateSnapshot,
  options: { complete?: boolean } = {},
): ModuleSnapshot {
  const sanitized = sanitizeModulePatch(patch)
  const before = previous.modules.find((module) => module.id === moduleId) as
    | (RisuModule & Record<string, unknown>)
    | undefined
  if (!before) return cloneJsonValue(sanitized)

  const changed = Object.fromEntries(
    Object.entries(sanitized)
      .filter(([key, value]) => !hasOwnRecordKey(before, key) || !isJsonValueEqual(before[key], value))
      .map(([key, value]) => [key, cloneJsonValue(value)]),
  ) as Record<string, unknown>

  for (const key of MODULE_PATCH_DELETABLE_KEYS) {
    const explicitlyRemoved = hasOwnRecordKey(patch, key) && patch[key] === undefined
    const omittedFromCompleteSnapshot = options.complete === true && !hasOwnRecordKey(patch, key)
    if (hasOwnRecordKey(before, key) && (explicitlyRemoved || omittedFromCompleteSnapshot)) {
      changed[key] = null
    }
  }

  return changed as ModuleSnapshot
}

function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isJsonValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isStringArrayEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}
