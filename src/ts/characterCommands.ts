import { canUseClientWriteAccess } from './clientSession'
import { get } from 'svelte/store'
import { v4 } from 'uuid'
import {
  canUseServerCommands,
  createAndSelectCharacterCommand,
  createCharacterCommand,
  deleteCharacterCommand,
  reorderCharactersCommand,
  runServerCommand,
  selectCharacterCommand,
  updateCharacterCommand,
  type CharacterOrderEntry,
  type CharacterSnapshot,
  type ChatSnapshot,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
} from './server/commands'
import { charactersResourceState, getCharacterResourceOwner } from './server/resourceState.svelte'
import { applyAttemptedFieldRollback, applyAttemptedKeyedListRollback } from './server/staleStateGuards'
import { recordHydratedCharacterLorebooks } from './server/lorebookOwner.svelte'
import { dispatchDurableMutation } from './server/durableMutationDispatch'
import {
  isPendingMutationProjectionFenceCurrent,
  pendingMutationCharacterOrderProjectionTarget,
  pendingMutationProjectionFence,
  recordPendingMutationProjectionTargets,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
  type PendingMutationProjectionFence,
} from './server/pendingMutationOutbox'
import { CHARACTER_SELECTION_MUTATION_KEY, characterOwnerMutationKey } from './server/resourceOwnerMutationKeys'
import { selectedCharID } from './stores.svelte'
import type { character, folder } from './storage/database.svelte'

export interface CharacterStateSnapshot {
  characters: character[]
  characterOrder: (string | folder)[]
  currentChar?: number
  selectedCharID: number
}

// Selecting a character only flips `selectedCharID`/`currentChar` and bumps the
// target character's `lastInteraction`, so its rollback never needs the full
// deep-cloned state snapshot. Capturing just these scalars avoids a synchronous
// JSON clone of the entire characters array (with all chat histories) on every
// sidebar click, which otherwise blocks the UI for seconds before the select +
// hydration requests can fire.
export interface CharacterSelectionSnapshot {
  characterId: string
  lastInteraction: number | undefined
  currentChar?: number
  selectedCharID: number
}

interface CharacterSelectionAttempt {
  characterId: string
  lastInteraction: number | undefined
  currentChar?: number
  selectedCharID: number
}

export interface CharacterOrderDragPosition {
  index: number
  folder?: string
}

export type CharacterOrderFolderTarget =
  | string
  | number
  | {
      id?: string | null
      index?: number | null
    }

export interface CharacterOrderFolderMetadataPatch {
  name?: string
  color?: string
  askBeforeOpening?: boolean
  imgFile?: string | null
  img?: string
}

type CharacterOrderFolderMetadataKey = keyof CharacterOrderFolderMetadataPatch

interface CharacterOrderRollback {
  previousOrder: readonly (string | folder)[]
  attemptedOrder: readonly (string | folder)[]
}

interface CharacterOrderFolderMetadataRollback {
  folderId: string
  previous: Partial<Record<CharacterOrderFolderMetadataKey, unknown>>
  attempted: Partial<Record<CharacterOrderFolderMetadataKey, unknown>>
}

interface CharacterOrderDurableProjection {
  attemptedOrder: readonly (string | folder)[]
  metadata?: CharacterOrderFolderMetadataRollback
}

interface CharacterCreateRollback {
  characterId: string
  attemptedCharacter: character
  restoreSelection: boolean
  previousCurrentChar?: number
  previousSelectedCharID: number
}

interface CharacterDeleteRollback {
  characterId: string
  character: character
  previousIndex: number
  orderPlacement: CharacterOrderPlacement | null
  previousCurrentChar?: number
  previousCurrentCharacterId?: string
  previousSelectedCharID: number
  previousSelectedCharacterId?: string
}

interface CharacterDeleteRollbackSelection {
  liveSelectedCharacterId?: string
  restorePreviousSelection: boolean
}

interface CharacterCollectionProjectionFences {
  row: PendingMutationProjectionFence | null
  order: PendingMutationProjectionFence | null
  selection?: PendingMutationProjectionFence | null
}

export interface CharacterOrderNormalizationResult {
  characterOrder: (string | folder)[]
  changed: boolean
}

const CHARACTER_ORDER_FOLDER_METADATA_KEYS: CharacterOrderFolderMetadataKey[] = [
  'name',
  'color',
  'askBeforeOpening',
  'imgFile',
  'img',
]
const MAX_CHARACTER_ORDER_DEPENDENCY_KEYS = 32
let characterOrderProjectionGeneration = 0
const currentCharacterFieldMutationAttempts = new Map<string, CharacterFieldMutationFieldAttempt>()
const CHARACTER_SELECTION_PROJECTION_TARGET = 'character-selection:current'

function characterRowProjectionTarget(characterId: string): string {
  return `character-row:${encodeURIComponent(characterId)}`
}

function characterFieldProjectionTarget(characterId: string, field: string): string {
  return `${characterRowProjectionTarget(characterId)}:field:${encodeURIComponent(field)}`
}

export interface CompatibleCharacterUpdatePreparation {
  characterId?: string
  patch: CharacterSnapshot
  optimisticCharacter?: character
  factories: Array<(baseRevision: number) => Promise<ServerCommandResult>>
  rollback: () => void
}

export interface CompatibleCharacterScopedUpdatePreparation extends CompatibleCharacterUpdatePreparation {
  dispatch: () => void
  dispatchAsync: () => Promise<CompatibleCharacterMutationOutcome | null>
}

export type CharacterMutationOutcome =
  | { status: 'accepted'; result: Extract<ServerCommandResult, { status: 'ok' }> }
  | { status: 'queued'; result: Exclude<ServerCommandResult, { status: 'ok' }> }
  | { status: 'failed'; result: Exclude<ServerCommandResult, { status: 'ok' }> }

export type CompatibleCharacterMutationOutcome = CharacterMutationOutcome

export interface CharacterOrderMutationHandle {
  applied: boolean
  settlement: Promise<CharacterMutationOutcome> | null
}

export interface CreateAndSelectCharacterDispatchOptions {
  shouldRestoreSelection?: () => boolean
}

export const CHARACTER_PATCH_EXCLUDED_KEYS = new Set([
  'chaId',
  'chats',
  'chatFolders',
  'lastInteraction',
  'globalLore',
  'customscript',
  'triggerscript',
  'scriptstate',
  'modules',
  'coldstorage',
  'coldStoragedChats',
  'greetingTranslations',
])

export const CHARACTER_PATCH_DELETABLE_KEYS = new Set(['loreSettings'])

export function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function isCharacterPatchDeleteSentinel(field: string, value: unknown): boolean {
  return value === null && CHARACTER_PATCH_DELETABLE_KEYS.has(field)
}

export function isCharacterPatchValueCurrent(
  target: Record<string, unknown>,
  field: string,
  attemptedValue: unknown,
): boolean {
  if (isCharacterPatchDeleteSentinel(field, attemptedValue)) {
    return !Object.prototype.hasOwnProperty.call(target, field) || target[field] === undefined || target[field] === null
  }
  return (
    Object.prototype.hasOwnProperty.call(target, field) && characterFieldSnapshotEquals(target[field], attemptedValue)
  )
}

export function applyCharacterPatchToRecord(
  target: Record<string, unknown>,
  patch: CharacterSnapshot,
): Record<string, unknown> {
  for (const [field, value] of Object.entries(sanitizeCharacterPatch(patch))) {
    if (isCharacterPatchDeleteSentinel(field, value)) {
      delete target[field]
    } else {
      target[field] = cloneJsonValue(value)
    }
  }
  return target
}

export function applyAttemptedCharacterFieldRollback(input: {
  target: Record<string, unknown>
  previous: Record<string, unknown>
  attempted: CharacterSnapshot
}): string[] {
  const deletionFields: string[] = []
  const ordinaryFields: string[] = []
  for (const [field, value] of Object.entries(input.attempted)) {
    const fields = isCharacterPatchDeleteSentinel(field, value) ? deletionFields : ordinaryFields
    fields.push(field)
  }

  const rolledBack = applyAttemptedFieldRollback({
    ...input,
    keys: ordinaryFields,
    deleteMissingPrevious: true,
  })
  for (const field of deletionFields) {
    if (!isCharacterPatchValueCurrent(input.target, field, input.attempted[field])) continue
    if (Object.prototype.hasOwnProperty.call(input.previous, field)) {
      input.target[field] = cloneJsonValue(input.previous[field])
    } else {
      delete input.target[field]
    }
    rolledBack.push(field)
  }
  return rolledBack
}

function pendingMutationStagingFailure(error: unknown): Exclude<ServerCommandResult, { status: 'ok' }> {
  return {
    status: 'error',
    error: error instanceof Error ? error.message : 'Unable to stage pending server mutation',
    reason: 'invalid-request',
  }
}

function characterRowsOwner(): character[] {
  return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
}

function updateCharacterRowsOwner(mutator: (characters: character[]) => boolean | void): boolean {
  return charactersResourceState.status === 'ready' && mutator(charactersResourceState.characters) !== false
}

function replaceCharacterRowsOwner(characters: character[]): boolean {
  if (charactersResourceState.status !== 'ready') return false
  charactersResourceState.characters = characters
  return true
}

function characterOrderOwner(): (string | folder)[] {
  return charactersResourceState.status === 'ready' ? charactersResourceState.characterOrder : []
}

function currentCharOwner(): number | undefined {
  return charactersResourceState.status === 'ready' ? charactersResourceState.currentChar : undefined
}

function setCurrentCharOwner(currentChar: number | undefined): void {
  if (charactersResourceState.status === 'ready') {
    charactersResourceState.currentChar = currentChar ?? -1
  }
}

function setCharacterOrderOwner(characterOrder: (string | folder)[]): void {
  if (charactersResourceState.status === 'ready') {
    charactersResourceState.characterOrder = characterOrder
  }
}

export function currentCharacterStateSnapshot(): CharacterStateSnapshot {
  return {
    characters: cloneJsonValue(characterRowsOwner()),
    characterOrder: cloneJsonValue(characterOrderOwner()),
    currentChar: currentCharOwner(),
    selectedCharID: get(selectedCharID),
  }
}

export function restoreCharacterState(snapshot: CharacterStateSnapshot): void {
  replaceCharacterRowsOwner(cloneJsonValue(snapshot.characters))
  setCharacterOrderOwner(cloneJsonValue(snapshot.characterOrder))
  setCurrentCharOwner(snapshot.currentChar)
  selectedCharID.set(snapshot.selectedCharID)
}

function currentCharacterOrderSnapshot(): (string | folder)[] {
  return cloneJsonValue(characterOrderOwner())
}

export function currentCharacterSelectionSnapshot(characterId: string): CharacterSelectionSnapshot {
  const character = uniqueCharacterOwnerById(characterId)
  return {
    characterId,
    lastInteraction: character?.lastInteraction,
    currentChar: currentCharOwner(),
    selectedCharID: get(selectedCharID),
  }
}

export function restoreCharacterSelection(snapshot: CharacterSelectionSnapshot): void {
  const character = uniqueCharacterOwnerById(snapshot.characterId)
  if (character) character.lastInteraction = snapshot.lastInteraction
  setCurrentCharOwner(snapshot.currentChar)
  selectedCharID.set(snapshot.selectedCharID)
}

function currentCharacterSelectionAttempt(
  characterId: string,
  lastInteraction: number | undefined,
): CharacterSelectionAttempt {
  return {
    characterId,
    lastInteraction,
    currentChar: currentCharOwner(),
    selectedCharID: get(selectedCharID),
  }
}

function restoreCharacterSelectionAttempt(
  previous: CharacterSelectionSnapshot,
  attempted: CharacterSelectionAttempt,
): void {
  const liveSelectedCharID = get(selectedCharID)
  const liveCurrentChar = currentCharOwner()
  const liveSelectedCharacterId = selectedCharacterIdAt(liveSelectedCharID)
  const attemptedCharacter = uniqueCharacterOwnerById(attempted.characterId)

  if (
    liveSelectedCharID !== attempted.selectedCharID ||
    liveCurrentChar !== attempted.currentChar ||
    liveSelectedCharacterId !== attempted.characterId ||
    (attempted.lastInteraction !== undefined && attemptedCharacter?.lastInteraction !== attempted.lastInteraction)
  ) {
    return
  }

  const previousCharacter = uniqueCharacterOwnerById(previous.characterId)
  if (previousCharacter) previousCharacter.lastInteraction = previous.lastInteraction
  setCurrentCharOwner(previous.currentChar)
  selectedCharID.set(previous.selectedCharID)
}

// Narrow single-row rollback. Character field edits, image/emotion writes, and
// `setCurrentCharacter`/`setCharacterByIndex` only mutate one character row (and
// the selection scalars), so the snapshot clones just that row instead of the
// whole `characters` array with every hydrated chat history. The full-array
// `CharacterStateSnapshot` stays for create/delete/import-era call sites.
export interface CharacterRowSnapshot {
  characterId: string | undefined
  index: number
  character: character | undefined
  currentChar?: number
  selectedCharID: number
  attempted?: CharacterSnapshot
}

export interface CharacterTrashTimeSnapshot {
  characterId: string | undefined
  index: number
  hadTrashTime: boolean
  trashTime: number | null | undefined
  orderPlacement: CharacterOrderPlacement | null
  currentChar?: number
  selectedCharID: number
}

export interface CharacterSupaMemorySnapshot {
  characterId: string
  hadSupaMemory: boolean
  supaMemory: boolean | undefined
}

interface CharacterOrderPlacement {
  characterId: string
  rootIndex?: number
  folderIndex?: number
  folderId?: string
  folderDataIndex?: number
  folder?: folder
}

export function currentCharacterRowSnapshot(index: number = get(selectedCharID)): CharacterRowSnapshot {
  const character = uniqueCharacterOwnerAt(index)
  return {
    characterId: character?.chaId,
    index,
    character: character ? cloneJsonValue(character) : undefined,
    currentChar: currentCharOwner(),
    selectedCharID: get(selectedCharID),
  }
}

export function currentCharacterTrashTimeSnapshot(index: number = get(selectedCharID)): CharacterTrashTimeSnapshot {
  const character = uniqueCharacterOwnerAt(index) as (character & { trashTime?: number | null }) | undefined
  return {
    characterId: character?.chaId,
    index,
    hadTrashTime: !!character && Object.prototype.hasOwnProperty.call(character, 'trashTime'),
    trashTime: character?.trashTime,
    orderPlacement: character?.chaId ? currentCharacterOrderPlacement(character.chaId) : null,
    currentChar: currentCharOwner(),
    selectedCharID: get(selectedCharID),
  }
}

export function currentCharacterSupaMemorySnapshot(characterId: string): CharacterSupaMemorySnapshot | null {
  const character = uniqueCharacterOwnerById(characterId)
  if (!character) return null
  return {
    characterId,
    hadSupaMemory: Object.prototype.hasOwnProperty.call(character, 'supaMemory'),
    supaMemory: character.supaMemory,
  }
}

export function restoreCharacterRow(snapshot: CharacterRowSnapshot): void {
  const target = characterForSnapshot(snapshot)
  if (snapshot.character && target) {
    if (snapshot.attempted) {
      applyAttemptedCharacterFieldRollback({
        target: target as unknown as Record<string, unknown>,
        previous: snapshot.character as unknown as Record<string, unknown>,
        attempted: snapshot.attempted,
      })
    } else {
      const restored = cloneJsonValue(snapshot.character) as character
      const targetRecord = target as unknown as Record<string, unknown>
      for (const key of Object.keys(target)) {
        if (!Object.prototype.hasOwnProperty.call(restored, key)) delete targetRecord[key]
      }
      Object.assign(target, restored)
    }
  }
  setCurrentCharOwner(snapshot.currentChar)
  selectedCharID.set(snapshot.selectedCharID)
}

function restoreCompatibleCharacterRowAttempt(snapshot: CharacterRowSnapshot): void {
  if (!snapshot.character || !snapshot.attempted) return
  const target = characterForSnapshot(snapshot)
  if (!target) return
  applyAttemptedCharacterFieldRollback({
    target: target as unknown as Record<string, unknown>,
    previous: snapshot.character as unknown as Record<string, unknown>,
    attempted: snapshot.attempted,
  })
}

export function restoreCharacterTrashTime(snapshot: CharacterTrashTimeSnapshot): void {
  const character = characterForSnapshot(snapshot) as (character & { trashTime?: number | null }) | undefined
  if (character) {
    if (snapshot.hadTrashTime) {
      character.trashTime = snapshot.trashTime
    } else {
      delete character.trashTime
    }
  }
  restoreCharacterOrderPlacement(snapshot)
  setCurrentCharOwner(snapshot.currentChar)
  selectedCharID.set(snapshot.selectedCharID)
}

export function restoreCharacterSupaMemory(snapshot: CharacterSupaMemorySnapshot): void {
  const character = uniqueCharacterOwnerById(snapshot.characterId)
  if (!character) return
  if (snapshot.hadSupaMemory) {
    character.supaMemory = snapshot.supaMemory
  } else {
    delete character.supaMemory
  }
}

function characterForSnapshot(
  snapshot:
    | Pick<CharacterRowSnapshot, 'characterId' | 'index'>
    | Pick<CharacterTrashTimeSnapshot, 'characterId' | 'index'>,
): character | undefined {
  if (snapshot.characterId) return uniqueCharacterOwnerById(snapshot.characterId)
  return undefined
}

function currentCharacterOrderPlacement(characterId: string): CharacterOrderPlacement | null {
  return characterOrderPlacementFromOrder(characterOrderOwner(), characterId)
}

function characterOrderPlacementFromOrder(
  characterOrder: readonly (string | folder)[],
  characterId: string,
): CharacterOrderPlacement | null {
  for (let index = 0; index < characterOrder.length; index += 1) {
    const entry = characterOrder[index]
    if (entry === characterId) {
      return { characterId, rootIndex: index }
    }
    if (!isCharacterOrderFolder(entry)) continue
    const folderDataIndex = entry.data.indexOf(characterId)
    if (folderDataIndex === -1) continue
    return {
      characterId,
      folderIndex: index,
      folderId: entry.id,
      folderDataIndex,
      folder: cloneJsonValue(entry),
    }
  }
  return null
}

function restoreCharacterOrderPlacement(snapshot: CharacterTrashTimeSnapshot): void {
  const placement = snapshot.orderPlacement
  if (!placement?.characterId) return

  const character = uniqueCharacterOwnerById(placement.characterId)
  if (!character || character.trashTime) return

  if (characterOrderIncludes(ensureCharacterOrder(), placement.characterId)) return
  restoreMissingCharacterOrderPlacement(placement)
}

function resolveRestoredFolderIndex(characterOrder: (string | folder)[], placement: CharacterOrderPlacement): number {
  if (placement.folderId) {
    const folderIndex = findCharacterOrderFolderIndex(characterOrder, placement.folderId)
    if (folderIndex !== -1) return folderIndex
  }
  const fallbackIndex = placement.folderIndex
  if (typeof fallbackIndex === 'number' && isCharacterOrderFolder(characterOrder[fallbackIndex])) {
    return fallbackIndex
  }
  return -1
}

function characterOrderIncludes(characterOrder: readonly (string | folder)[], characterId: string): boolean {
  for (const entry of characterOrder) {
    if (entry === characterId) return true
    if (isCharacterOrderFolder(entry) && entry.data.includes(characterId)) return true
  }
  return false
}

function clampInsertionIndex(index: number | undefined, length: number): number {
  if (typeof index !== 'number' || !Number.isFinite(index)) return length
  return Math.max(0, Math.min(index, length))
}

function characterCreateRollbackFromState(
  character: character,
  previous: CharacterStateSnapshot,
  restoreSelection: boolean,
): CharacterCreateRollback | null {
  const characterId = character.chaId
  if (!characterId) return null

  return {
    characterId,
    attemptedCharacter: cloneJsonValue(character),
    restoreSelection,
    previousCurrentChar: previous.currentChar,
    previousSelectedCharID: previous.selectedCharID,
  }
}

function restoreCreatedCharacterAttempt(
  rollback: CharacterCreateRollback | null,
  options: CreateAndSelectCharacterDispatchOptions = {},
): void {
  if (!rollback) return
  updateCharacterRowsOwner((characters) => {
    const liveSelectedCharacterId = selectedCharacterIdAt(get(selectedCharID))
    const shouldRestoreSelection =
      rollback.restoreSelection &&
      (options.shouldRestoreSelection?.() ?? true) &&
      shouldRestorePreviousSelectionAfterCreatedCharacterRollback(rollback.characterId)
    const rolledBack = applyAttemptedKeyedListRollback<character, string>({
      list: characters,
      entries: [
        {
          key: rollback.characterId,
          previous: null,
          attempted: rollback.attemptedCharacter,
        },
      ],
      getKey: (candidate) => candidate?.chaId,
    })
    if (rolledBack.length === 0) return false

    replaceCharacterOrderWithNormalized()
    if (shouldRestoreSelection) {
      restoreCharacterSelectionScalars(rollback.previousCurrentChar, rollback.previousSelectedCharID)
    } else if (liveSelectedCharacterId && liveSelectedCharacterId !== rollback.characterId) {
      restoreCharacterSelectionById(liveSelectedCharacterId)
    }
    return true
  })
}

function characterDeleteRollbackFromState(
  characterId: string,
  previous: CharacterStateSnapshot,
): CharacterDeleteRollback | null {
  const previousIndex = previous.characters.findIndex((candidate) => candidate?.chaId === characterId)
  if (previousIndex === -1) return null

  return {
    characterId,
    character: cloneJsonValue(previous.characters[previousIndex]),
    previousIndex,
    orderPlacement: characterOrderPlacementFromOrder(previous.characterOrder, characterId),
    previousCurrentChar: previous.currentChar,
    previousCurrentCharacterId: Number.isInteger(previous.currentChar)
      ? previous.characters[previous.currentChar as number]?.chaId
      : undefined,
    previousSelectedCharID: previous.selectedCharID,
    previousSelectedCharacterId: previous.characters[previous.selectedCharID]?.chaId,
  }
}

function isCurrentCharacterProjectionFence(fence: PendingMutationProjectionFence | null | undefined): boolean {
  return fence != null && isPendingMutationProjectionFenceCurrent(fence)
}

function characterCollectionProjectionFences(
  outbox: PendingMutationHandle,
  characterId: string,
  includeSelection: boolean,
): CharacterCollectionProjectionFences {
  const targets = [characterRowProjectionTarget(characterId), pendingMutationCharacterOrderProjectionTarget()]
  if (includeSelection) targets.push(CHARACTER_SELECTION_PROJECTION_TARGET)
  recordPendingMutationProjectionTargets(outbox, targets)
  return {
    row: pendingMutationProjectionFence(outbox, targets[0]),
    order: pendingMutationProjectionFence(outbox, targets[1]),
    ...(includeSelection ? { selection: pendingMutationProjectionFence(outbox, targets[2]) } : {}),
  }
}

function reapplyCreatedCharacterProjection(
  rollback: CharacterCreateRollback | null,
  fences: CharacterCollectionProjectionFences,
  options: CreateAndSelectCharacterDispatchOptions = {},
): void {
  if (!rollback) return
  if (isCurrentCharacterProjectionFence(fences.row) && !uniqueCharacterOwnerById(rollback.characterId)) {
    updateCharacterRowsOwner((characters) => {
      if (characters.some((candidate) => candidate?.chaId === rollback.characterId)) return false
      characters.push(cloneJsonValue(rollback.attemptedCharacter))
      return true
    })
  }
  if (isCurrentCharacterProjectionFence(fences.order)) repairCharacterOrderOptimistically({ dispatchReorder: false })
  if (
    rollback.restoreSelection &&
    isCurrentCharacterProjectionFence(fences.selection) &&
    (options.shouldRestoreSelection?.() ?? true)
  ) {
    restoreCharacterSelectionById(rollback.characterId)
  }
}

function reapplyDeletedCharacterProjection(
  rollback: CharacterDeleteRollback | null,
  fences: CharacterCollectionProjectionFences,
): void {
  if (!rollback) return
  if (isCurrentCharacterProjectionFence(fences.row)) applyCharacterDeleteOptimistically(rollback.characterId)
  if (isCurrentCharacterProjectionFence(fences.order)) repairCharacterOrderOptimistically({ dispatchReorder: false })
  if (isCurrentCharacterProjectionFence(fences.selection)) {
    normalizeCurrentCharacterPointerAfterDelete(rollback.characterId, rollback.previousCurrentCharacterId)
    selectedCharID.set(-1)
  }
}

function restoreDeletedCharacterAttempt(rollback: CharacterDeleteRollback | null): void {
  if (!rollback) return
  updateCharacterRowsOwner((characters) => {
    const selection = currentDeletedCharacterRollbackSelection()
    const rolledBack = applyAttemptedKeyedListRollback<character, string>({
      list: characters,
      entries: [
        {
          key: rollback.characterId,
          previous: rollback.character,
          attempted: null,
          previousIndex: rollback.previousIndex,
        },
      ],
      getKey: (candidate) => candidate?.chaId,
    })
    if (rolledBack.length === 0) return false

    restoreMissingCharacterOrderPlacement(rollback.orderPlacement)
    if (selection.restorePreviousSelection) {
      restoreCharacterSelectionScalars(rollback.previousCurrentChar, rollback.previousSelectedCharID)
    } else if (selection.liveSelectedCharacterId && selection.liveSelectedCharacterId !== rollback.characterId) {
      restoreCharacterSelectionById(selection.liveSelectedCharacterId)
    }
    return true
  })
}

function shouldRestorePreviousSelectionAfterCreatedCharacterRollback(characterId: string): boolean {
  const liveSelectedCharID = get(selectedCharID)
  if (isCharacterSelectionEmptyOrStale(liveSelectedCharID)) return true
  return selectedCharacterIdAt(liveSelectedCharID) === characterId
}

function currentDeletedCharacterRollbackSelection(): CharacterDeleteRollbackSelection {
  const liveSelectedCharID = get(selectedCharID)
  const liveSelectedCharacterId = selectedCharacterIdAt(liveSelectedCharID)
  return {
    liveSelectedCharacterId,
    restorePreviousSelection: shouldRestorePreviousSelectionAfterDeletedCharacterRollback(
      liveSelectedCharID,
      liveSelectedCharacterId,
    ),
  }
}

function shouldRestorePreviousSelectionAfterDeletedCharacterRollback(
  liveSelectedCharID: number,
  liveSelectedCharacterId: string | undefined,
): boolean {
  return liveSelectedCharID < 0 || !liveSelectedCharacterId
}

function isCharacterSelectionEmptyOrStale(index: number): boolean {
  return index < 0 || !uniqueCharacterOwnerAt(index)
}

function selectedCharacterIdAt(index: number): string | undefined {
  return uniqueCharacterOwnerAt(index)?.chaId
}

function restoreCharacterSelectionScalars(currentChar: number | undefined, selectedCharacterIndex: number): void {
  setCurrentCharOwner(currentChar)
  selectedCharID.set(selectedCharacterIndex)
}

function restoreCharacterSelectionById(characterId: string): void {
  const characters = characterRowsOwner()
  const candidate = uniqueCharacterOwnerById(characterId)
  const index = candidate ? characters.indexOf(candidate) : -1
  if (index === -1) return
  restoreCharacterSelectionScalars(index, index)
}

function uniqueCharacterOwnerAt(index: number): character | undefined {
  if (index < 0) return undefined
  if (charactersResourceState.status !== 'ready') return undefined
  const candidate = characterRowsOwner()[index]
  return candidate?.chaId ? uniqueCharacterOwnerById(candidate.chaId) : undefined
}

function uniqueCharacterOwnerById(characterId: string): character | undefined {
  return characterId && charactersResourceState.status === 'ready' ? getCharacterResourceOwner(characterId) : undefined
}

/** Apply one optimistic create to the explicit character collection owner. */
export function applyCharacterCreateOptimistically(
  character: character,
  options: { lastInteraction?: number } = {},
): number {
  if (!canUseClientWriteAccess()) return -1
  if (!character.chaId || uniqueCharacterOwnerById(character.chaId)) return -1
  let index = -1
  const applied = updateCharacterRowsOwner((characters) => {
    if (characters.some((candidate) => candidate?.chaId === character.chaId)) return false
    if (options.lastInteraction !== undefined) character.lastInteraction = options.lastInteraction
    characters.push(character)
    index = characters.length - 1
    return true
  })
  return applied ? index : -1
}

/** Remove one uniquely identified optimistic character collection row. */
export function applyCharacterDeleteOptimistically(characterId: string): boolean {
  if (!canUseClientWriteAccess()) return false
  const owner = uniqueCharacterOwnerById(characterId)
  if (!owner) return false
  return updateCharacterRowsOwner((characters) => {
    const index = characters.indexOf(owner)
    if (index < 0) return false
    characters.splice(index, 1)
    return true
  })
}

/** Apply selection and interaction time to the exact stable-id owner. */
export function applyCharacterSelectionOptimistically(characterId: string, lastInteraction: number): number {
  if (!canUseClientWriteAccess()) return -1
  const character = uniqueCharacterOwnerById(characterId)
  if (!character) return -1
  const index = characterRowsOwner().indexOf(character)
  if (index < 0) return -1
  character.lastInteraction = lastInteraction
  setCurrentCharOwner(index)
  selectedCharID.set(index)
  return index
}

function restoreMissingCharacterOrderPlacement(placement: CharacterOrderPlacement | null): void {
  if (!placement?.characterId) return

  const characterOrder = ensureCharacterOrder()
  removeCharacterIdFromOrder(characterOrder, placement.characterId)

  if (placement.folder) {
    const folderIndex = resolveRestoredFolderIndex(characterOrder, placement)
    if (folderIndex !== -1) {
      const targetFolder = characterOrder[folderIndex]
      if (isCharacterOrderFolder(targetFolder)) {
        targetFolder.data.splice(
          clampInsertionIndex(placement.folderDataIndex, targetFolder.data.length),
          0,
          placement.characterId,
        )
        characterOrder[folderIndex] = targetFolder
        setCharacterOrderOwner(characterOrder)
        return
      }
    }

    const restoredFolder = cloneJsonValue(placement.folder)
    restoredFolder.data = [placement.characterId]
    characterOrder.splice(clampInsertionIndex(placement.folderIndex, characterOrder.length), 0, restoredFolder)
    setCharacterOrderOwner(characterOrder)
    return
  }

  characterOrder.splice(clampInsertionIndex(placement.rootIndex, characterOrder.length), 0, placement.characterId)
  setCharacterOrderOwner(characterOrder)
}

function removeCharacterIdFromOrder(characterOrder: (string | folder)[], characterId: string): void {
  for (let index = characterOrder.length - 1; index >= 0; index -= 1) {
    const entry = characterOrder[index]
    if (entry === characterId) {
      characterOrder.splice(index, 1)
      continue
    }
    if (isCharacterOrderFolder(entry)) {
      entry.data = entry.data.filter((id) => id !== characterId)
      characterOrder[index] = entry
    }
  }
}

export function runCharacterCommand<T extends Record<string, unknown>>(
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>,
  rollback: () => void,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult<T>> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  if (!canUseServerCommands()) return
  return runServerCommand({ command, rollback, ...options })
}

export function dispatchCreateCharacter(
  character: character,
  previous: CharacterStateSnapshot,
): Promise<CharacterMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  recordHydratedCharacterLorebooks([character])
  const rollback = characterCreateRollbackFromState(character, previous, false)
  repairCharacterOrderOptimistically({ dispatchReorder: false })
  if (!canUseServerCommands()) {
    restoreCreatedCharacterAttempt(rollback)
    return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  }

  const characterSnapshot = toCharacterSnapshot(character)
  const initialChat = initialCharacterChatSnapshot(character)
  warnIfCharacterCreateWouldDropChats(character, initialChat)
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'POST',
        path: '/characters',
        body: characterCreateDurableBody(characterSnapshot, initialChat),
      },
    ],
  }
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(characterOwnerMutationKey(character.chaId), intent)
  } catch (error) {
    restoreCreatedCharacterAttempt(rollback)
    return Promise.resolve({ status: 'failed', result: pendingMutationStagingFailure(error) })
  }
  const projectionFences = characterCollectionProjectionFences(outbox, character.chaId, false)
  let disposition: 'retain' | 'rollback' = 'retain'
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  const promise = dispatchDurableMutation(outbox, intent, (transport) => {
    failureRollbackDisposition = transport.failureRollbackDisposition
    return (
      runCharacterCommand(
        (baseRevision) =>
          createCharacterCommand({
            baseRevision,
            character: cloneJsonValue(characterSnapshot),
            initialChat: cloneJsonValue(initialChat),
          }),
        () => restoreCreatedCharacterAttempt(rollback),
        transport,
      ) ?? Promise.resolve({ status: 'unavailable' as const })
    )
  }).then(
    (result) => {
      disposition = result.status === 'ok' ? 'rollback' : (failureRollbackDisposition?.(result) ?? 'rollback')
      if (result.status !== 'ok' && disposition === 'retain') {
        reapplyCreatedCharacterProjection(rollback, projectionFences)
      }
      return result
    },
    (error) => {
      disposition = failureRollbackDisposition?.({ status: 'unavailable' }) ?? 'rollback'
      throw error
    },
  )
  return compatibleCharacterMutationOutcome({ promise, disposition: () => disposition })
}

export function dispatchCreateAndSelectCharacter(
  character: character,
  previous: CharacterStateSnapshot,
  lastInteraction: number,
  options: CreateAndSelectCharacterDispatchOptions = {},
): Promise<CharacterMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  recordHydratedCharacterLorebooks([character])
  const rollback = characterCreateRollbackFromState(character, previous, true)
  repairCharacterOrderOptimistically({ dispatchReorder: false })
  if (!canUseServerCommands()) {
    restoreCreatedCharacterAttempt(rollback, options)
    return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  }

  const characterSnapshot = toCharacterSnapshot(character)
  const initialChat = initialCharacterChatSnapshot(character)
  warnIfCharacterCreateWouldDropChats(character, initialChat)
  const previousSelectedCharacterId = selectedCharacterIdFromStateSnapshot(previous)
  const intent: DurableMutationIntent = {
    version: 1,
    ...(previousSelectedCharacterId
      ? { dependencyKeys: [characterOwnerMutationKey(previousSelectedCharacterId)] }
      : {}),
    requests: [
      {
        method: 'POST',
        path: '/characters/create-and-select',
        body: {
          ...characterCreateDurableBody(characterSnapshot, initialChat),
          lastInteraction,
        },
      },
    ],
  }
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(characterOwnerMutationKey(character.chaId), intent)
  } catch (error) {
    restoreCreatedCharacterAttempt(rollback, options)
    return Promise.resolve({ status: 'failed', result: pendingMutationStagingFailure(error) })
  }
  const projectionFences = characterCollectionProjectionFences(outbox, character.chaId, true)
  let disposition: 'retain' | 'rollback' = 'retain'
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  const promise = dispatchDurableMutation(outbox, intent, (transport) => {
    failureRollbackDisposition = transport.failureRollbackDisposition
    return (
      runCharacterCommand(
        (baseRevision) =>
          createAndSelectCharacterCommand({
            baseRevision,
            character: cloneJsonValue(characterSnapshot),
            lastInteraction,
            initialChat: cloneJsonValue(initialChat),
          }),
        () => restoreCreatedCharacterAttempt(rollback, options),
        transport,
      ) ?? Promise.resolve({ status: 'unavailable' as const })
    )
  }).then(
    (result) => {
      disposition = result.status === 'ok' ? 'rollback' : (failureRollbackDisposition?.(result) ?? 'rollback')
      if (result.status !== 'ok' && disposition === 'retain') {
        reapplyCreatedCharacterProjection(rollback, projectionFences, options)
      }
      return result
    },
    (error) => {
      disposition = failureRollbackDisposition?.({ status: 'unavailable' }) ?? 'rollback'
      throw error
    },
  )
  return compatibleCharacterMutationOutcome({ promise, disposition: () => disposition })
}

function characterCreateDurableBody(
  characterSnapshot: CharacterSnapshot,
  initialChat: ChatSnapshot | undefined,
): Record<string, unknown> {
  const character = cloneJsonValue(characterSnapshot)
  delete character.chats
  return {
    character,
    ...(initialChat ? { initialChat: cloneJsonValue(initialChat) } : {}),
  }
}

function selectedCharacterIdFromStateSnapshot(snapshot: CharacterStateSnapshot): string | null {
  for (const index of [snapshot.currentChar, snapshot.selectedCharID]) {
    if (!Number.isInteger(index) || (index as number) < 0) continue
    const characterId = snapshot.characters[index as number]?.chaId
    if (typeof characterId === 'string' && characterId.trim()) return characterId
  }
  return null
}

function selectedCharacterIdFromSelectionSnapshot(snapshot: CharacterSelectionSnapshot): string | null {
  for (const index of [snapshot.currentChar, snapshot.selectedCharID]) {
    if (!Number.isInteger(index) || (index as number) < 0) continue
    const characterId = uniqueCharacterOwnerAt(index as number)?.chaId
    if (typeof characterId === 'string' && characterId.trim()) return characterId
  }
  return null
}

// `*With(rollback)` core plus a broad (`CharacterStateSnapshot`) and a single-row
// (`CharacterRowSnapshot`) export. The scoped variants restore only the target
// character row on failure; the broad ones remain for create/delete/import and
// any caller that still holds a whole-collection snapshot.
function dispatchUpdateCharacterWith(
  characterId: string,
  patch: CharacterSnapshot,
  rollback: () => void,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult> | undefined {
  const commandPatch = sanitizeCharacterPatch(patch)
  if (Object.keys(commandPatch).length === 0) return
  return runCharacterCommand(
    (baseRevision) =>
      updateCharacterCommand(
        {
          baseRevision,
          characterId,
          patch: commandPatch,
        },
        options.signal,
        options.keepalive,
      ),
    rollback,
    options,
  )
}

interface CharacterFieldMutationBaseline {
  hadValue: boolean
  value: unknown
}

interface CharacterFieldMutationFieldAttempt {
  attemptedValue: unknown
  previous: CharacterFieldMutationBaseline
  successor?: CharacterFieldMutationFieldAttempt
}

interface CharacterFieldMutationAttempt {
  fields: ReadonlyMap<string, CharacterFieldMutationFieldAttempt>
}

interface PendingCharacterMutationExecution {
  promise: Promise<ServerCommandResult>
  disposition: () => 'retain' | 'rollback'
}

function characterFieldMutationKey(characterId: string, field: string): string {
  return `${characterId}\u0000${field}`
}

function captureCharacterFieldMutationAttempt(
  characterId: string,
  patch: CharacterSnapshot,
  previousFields: ReadonlyMap<string, CharacterFieldMutationBaseline>,
): CharacterFieldMutationAttempt {
  const fields = new Map<string, CharacterFieldMutationFieldAttempt>()
  for (const field of Object.keys(patch)) {
    const previous = previousFields.get(field)
    if (!previous) continue
    const key = characterFieldMutationKey(characterId, field)
    const fieldAttempt: CharacterFieldMutationFieldAttempt = {
      attemptedValue: patch[field],
      previous: { ...previous },
    }
    const predecessor = currentCharacterFieldMutationAttempts.get(key)
    if (predecessor) predecessor.successor = fieldAttempt
    currentCharacterFieldMutationAttempts.set(key, fieldAttempt)
    fields.set(field, fieldAttempt)
  }
  return { fields }
}

function rebaseImmediateCharacterFieldMutationSuccessors(attempt: CharacterFieldMutationAttempt): void {
  for (const [field, fieldAttempt] of attempt.fields) {
    const successor = fieldAttempt.successor
    if (!successor || !characterFieldMutationBaselineMatches(field, successor.previous, fieldAttempt.attemptedValue)) {
      continue
    }
    successor.previous = { ...fieldAttempt.previous }
  }
}

function characterFieldMutationBaselineMatches(
  field: string,
  baseline: CharacterFieldMutationBaseline,
  attemptedValue: unknown,
): boolean {
  if (isCharacterPatchDeleteSentinel(field, attemptedValue)) {
    return !baseline.hadValue || baseline.value === undefined || baseline.value === null
  }
  return baseline.hadValue && characterFieldSnapshotEquals(baseline.value, attemptedValue)
}

function characterFieldSnapshotEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  const leftSnapshot = JSON.stringify(left)
  return leftSnapshot !== undefined && leftSnapshot === JSON.stringify(right)
}

function characterFieldMutationBaseline(
  attempt: CharacterFieldMutationAttempt,
  field: string,
  fallback: CharacterFieldMutationBaseline,
): CharacterFieldMutationBaseline {
  return attempt.fields.get(field)?.previous ?? fallback
}

function isCharacterFieldMutationAttemptCurrent(
  characterId: string,
  field: string,
  attemptedValue: unknown,
  attempt: CharacterFieldMutationAttempt,
): boolean {
  const fieldAttempt = attempt.fields.get(field)
  if (
    !fieldAttempt ||
    currentCharacterFieldMutationAttempts.get(characterFieldMutationKey(characterId, field)) !== fieldAttempt
  ) {
    return false
  }
  const character = uniqueCharacterOwnerById(characterId)
  return (
    !!character && isCharacterPatchValueCurrent(character as unknown as Record<string, unknown>, field, attemptedValue)
  )
}

function dispatchDurableCharacterPatch(
  characterId: string,
  patch: CharacterSnapshot,
  previousFields: ReadonlyMap<string, CharacterFieldMutationBaseline>,
  rollback: (attempt: CharacterFieldMutationAttempt) => void,
): Promise<ServerCommandResult> | undefined {
  return prepareDurableCharacterPatchExecution(characterId, patch, previousFields, rollback)?.promise
}

function reapplyRetainedCharacterPatch(
  characterId: string,
  attempted: CharacterSnapshot,
  previousFields: ReadonlyMap<string, CharacterFieldMutationBaseline>,
  fences: ReadonlyMap<string, PendingMutationProjectionFence | null>,
): void {
  const character = uniqueCharacterOwnerById(characterId)
  if (!character) return
  const target = character as unknown as Record<string, unknown>
  const patch: CharacterSnapshot = {}
  for (const [field, attemptedValue] of Object.entries(attempted)) {
    if (!isCurrentCharacterProjectionFence(fences.get(field))) continue
    const previous = previousFields.get(field)
    if (!previous) continue
    const hasLiveValue = Object.prototype.hasOwnProperty.call(target, field)
    if (hasLiveValue !== previous.hadValue) continue
    if (hasLiveValue && !characterFieldSnapshotEquals(target[field], previous.value)) continue
    patch[field] = attemptedValue
  }
  if (Object.keys(patch).length > 0) applyCharacterPatchToRecord(target, patch)
}

function prepareDurableCharacterPatchExecution(
  characterId: string,
  patch: CharacterSnapshot,
  previousFields: ReadonlyMap<string, CharacterFieldMutationBaseline>,
  rollback: (attempt: CharacterFieldMutationAttempt) => void,
): PendingCharacterMutationExecution | undefined {
  const attempted = sanitizeCharacterPatch(patch)
  if (Object.keys(attempted).length === 0) return
  const attempt = captureCharacterFieldMutationAttempt(characterId, attempted, previousFields)
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [CHARACTER_SELECTION_MUTATION_KEY],
    requests: [
      {
        method: 'PATCH',
        path: `/characters/${encodeURIComponent(characterId)}`,
        body: { patch: cloneJsonValue(attempted) },
      },
    ],
  }
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(characterOwnerMutationKey(characterId), intent)
  } catch (error) {
    rebaseImmediateCharacterFieldMutationSuccessors(attempt)
    rollback(attempt)
    return {
      promise: Promise.resolve(pendingMutationStagingFailure(error)),
      disposition: () => 'rollback',
    }
  }
  const projectionTargets = Object.keys(attempted).map((field) => characterFieldProjectionTarget(characterId, field))
  recordPendingMutationProjectionTargets(outbox, projectionTargets)
  const projectionFences = new Map(
    Object.keys(attempted).map((field, index) => [
      field,
      pendingMutationProjectionFence(outbox, projectionTargets[index]),
    ]),
  )
  let disposition: 'retain' | 'rollback' = 'retain'
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  const promise = dispatchDurableMutation(outbox, intent, (transport) => {
    failureRollbackDisposition = transport.failureRollbackDisposition
    return (
      dispatchUpdateCharacterWith(
        characterId,
        attempted,
        () => {
          rebaseImmediateCharacterFieldMutationSuccessors(attempt)
          rollback(attempt)
        },
        transport,
      ) ?? Promise.resolve({ status: 'unavailable' as const })
    )
  }).then(
    (result) => {
      disposition = result.status === 'ok' ? 'rollback' : (failureRollbackDisposition?.(result) ?? disposition)
      if (result.status !== 'ok' && disposition === 'retain') {
        reapplyRetainedCharacterPatch(characterId, attempted, previousFields, projectionFences)
      }
      return result
    },
    (error) => {
      disposition = failureRollbackDisposition?.({ status: 'unavailable' }) ?? disposition
      if (disposition === 'retain') {
        reapplyRetainedCharacterPatch(characterId, attempted, previousFields, projectionFences)
      }
      throw error
    },
  )
  return { promise, disposition: () => disposition }
}

async function compatibleCharacterMutationOutcome(
  execution: PendingCharacterMutationExecution,
): Promise<CharacterMutationOutcome> {
  let result: ServerCommandResult
  try {
    result = await execution.promise
  } catch (error) {
    console.error('Compatible character mutation command rejected:', error)
    result = { status: 'unavailable' }
  }
  if (result.status === 'ok') return { status: 'accepted', result }
  return execution.disposition() === 'retain' ? { status: 'queued', result } : { status: 'failed', result }
}

function dispatchCompatibleCharacterPatchScopedOutcome(
  characterId: string,
  patch: CharacterSnapshot,
  previous: CharacterRowSnapshot,
): Promise<CompatibleCharacterMutationOutcome> | undefined {
  const attempted = sanitizeCharacterPatch(patch)
  if (Object.keys(attempted).length === 0) return
  const execution = prepareDurableCharacterPatchExecution(
    characterId,
    attempted,
    characterRowMutationBaselines(previous, attempted),
    (attempt) => restoreCompatibleCharacterRowAttempt(rebasedCharacterRowSnapshot(previous, attempted, attempt)),
  )
  return execution ? compatibleCharacterMutationOutcome(execution) : undefined
}

export function dispatchUpdateCharacter(
  characterId: string,
  patch: CharacterSnapshot,
  previous: CharacterStateSnapshot,
  rollback: (snapshot: CharacterStateSnapshot) => void = restoreCharacterState,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  return dispatchUpdateCharacterWith(characterId, patch, () => rollback(previous), options)
}

function characterRowMutationBaselines(
  previous: CharacterRowSnapshot,
  patch: CharacterSnapshot,
): ReadonlyMap<string, CharacterFieldMutationBaseline> {
  const baselines = new Map<string, CharacterFieldMutationBaseline>()
  const character = previous.character as unknown as Record<string, unknown> | undefined
  for (const field of Object.keys(patch)) {
    baselines.set(field, {
      hadValue: !!character && Object.prototype.hasOwnProperty.call(character, field),
      value: character?.[field],
    })
  }
  return baselines
}

function rebasedCharacterRowSnapshot(
  previous: CharacterRowSnapshot,
  attempted: CharacterSnapshot,
  attempt: CharacterFieldMutationAttempt,
): CharacterRowSnapshot {
  if (!previous.character || attempt.fields.size === 0) return { ...previous, attempted }
  const character = { ...previous.character } as unknown as Record<string, unknown>
  for (const [field, fieldAttempt] of attempt.fields) {
    if (fieldAttempt.previous.hadValue) {
      character[field] = fieldAttempt.previous.value
    } else {
      delete character[field]
    }
  }
  return { ...previous, character: character as unknown as character, attempted }
}

// Single-row rollback variant of `dispatchUpdateCharacter` for character-FIELD
// edits: a failed update restores only the target character row (and the
// selection scalars), never the whole characters array.
export function dispatchUpdateCharacterScoped(
  characterId: string,
  patch: CharacterSnapshot,
  previous: CharacterRowSnapshot,
): Promise<ServerCommandResult> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  return prepareUpdateCharacterScoped(characterId, patch, previous)?.promise
}

export function dispatchUpdateCharacterScopedWithOutcome(
  characterId: string,
  patch: CharacterSnapshot,
  previous: CharacterRowSnapshot,
): Promise<CharacterMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const execution = prepareUpdateCharacterScoped(characterId, patch, previous)
  return execution ? compatibleCharacterMutationOutcome(execution) : undefined
}

function prepareUpdateCharacterScoped(
  characterId: string,
  patch: CharacterSnapshot,
  previous: CharacterRowSnapshot,
): PendingCharacterMutationExecution | undefined {
  const attempted = sanitizeCharacterPatch(patch)
  if (Object.keys(attempted).length === 0) return
  return prepareDurableCharacterPatchExecution(
    characterId,
    attempted,
    characterRowMutationBaselines(previous, attempted),
    (attempt) => restoreCharacterRow(rebasedCharacterRowSnapshot(previous, attempted, attempt)),
  )
}

function dispatchCompatibleCharacterPatchScoped(
  characterId: string,
  patch: CharacterSnapshot,
  previous: CharacterRowSnapshot,
): Promise<ServerCommandResult> | undefined {
  const attempted = sanitizeCharacterPatch(patch)
  if (Object.keys(attempted).length === 0) return
  return dispatchDurableCharacterPatch(
    characterId,
    attempted,
    characterRowMutationBaselines(previous, attempted),
    (attempt) => restoreCompatibleCharacterRowAttempt(rebasedCharacterRowSnapshot(previous, attempted, attempt)),
  )
}

export function dispatchUpdateCharacterTrashTime(
  characterId: string,
  trashTime: number,
  previous: CharacterTrashTimeSnapshot,
): Promise<ServerCommandResult> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  return prepareUpdateCharacterTrashTime(characterId, trashTime, previous)?.promise
}

export function dispatchUpdateCharacterTrashTimeWithOutcome(
  characterId: string,
  trashTime: number,
  previous: CharacterTrashTimeSnapshot,
): Promise<CharacterMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const execution = prepareUpdateCharacterTrashTime(characterId, trashTime, previous)
  return execution ? compatibleCharacterMutationOutcome(execution) : undefined
}

function prepareUpdateCharacterTrashTime(
  characterId: string,
  trashTime: number,
  previous: CharacterTrashTimeSnapshot,
): PendingCharacterMutationExecution | undefined {
  const baseline = { hadValue: previous.hadTrashTime, value: previous.trashTime }
  return prepareDurableCharacterPatchExecution(
    characterId,
    { trashTime },
    new Map([['trashTime', baseline]]),
    (attempt) => {
      if (!isCharacterFieldMutationAttemptCurrent(characterId, 'trashTime', trashTime, attempt)) return
      const rebased = characterFieldMutationBaseline(attempt, 'trashTime', baseline)
      restoreCharacterTrashTime({
        ...previous,
        hadTrashTime: rebased.hadValue,
        trashTime: rebased.value as number | null | undefined,
      })
    },
  )
}

export function dispatchUpdateCharacterSupaMemory(
  characterId: string,
  enabled: boolean,
  previous: CharacterSupaMemorySnapshot,
): Promise<ServerCommandResult> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  return prepareUpdateCharacterSupaMemory(characterId, enabled, previous)?.promise
}

export function dispatchUpdateCharacterSupaMemoryWithOutcome(
  characterId: string,
  enabled: boolean,
  previous: CharacterSupaMemorySnapshot,
): Promise<CharacterMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const execution = prepareUpdateCharacterSupaMemory(characterId, enabled, previous)
  return execution ? compatibleCharacterMutationOutcome(execution) : undefined
}

function prepareUpdateCharacterSupaMemory(
  characterId: string,
  enabled: boolean,
  previous: CharacterSupaMemorySnapshot,
): PendingCharacterMutationExecution | undefined {
  const baseline = { hadValue: previous.hadSupaMemory, value: previous.supaMemory }
  return prepareDurableCharacterPatchExecution(
    characterId,
    { supaMemory: enabled },
    new Map([['supaMemory', baseline]]),
    (attempt) => {
      if (!isCharacterFieldMutationAttemptCurrent(characterId, 'supaMemory', enabled, attempt)) return
      const rebased = characterFieldMutationBaseline(attempt, 'supaMemory', baseline)
      restoreCharacterSupaMemory({
        ...previous,
        hadSupaMemory: rebased.hadValue,
        supaMemory: rebased.value as boolean | undefined,
      })
    },
  )
}

function dispatchCompatibleCharacterUpdateWith(
  previousCharacter: character | undefined,
  nextCharacter: character | undefined,
  rollback: () => void,
): void {
  const characterId = previousCharacter?.chaId
  if (!characterId || !previousCharacter || !nextCharacter) return

  const patch = changedCharacterFields(previousCharacter, nextCharacter)
  if (Object.keys(patch).length === 0) return
  dispatchUpdateCharacterWith(characterId, patch, rollback)
}

export function dispatchCompatibleCharacterUpdate(
  previousCharacter: character | undefined,
  nextCharacter: character | undefined,
  previous: CharacterStateSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  dispatchCompatibleCharacterUpdateWith(previousCharacter, nextCharacter, () => restoreCharacterState(previous))
}

// Single-row rollback variant of `dispatchCompatibleCharacterUpdate` for the
// character-field update paths (`setCurrentCharacter` / `setCharacterByIndex` and
// their trigger callers): a failed update restores only that one character row.
export function dispatchCompatibleCharacterUpdateScoped(
  previousCharacter: character | undefined,
  nextCharacter: character | undefined,
  previous: CharacterRowSnapshot,
): Promise<ServerCommandResult> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  const characterId = previousCharacter?.chaId
  if (!characterId || !previousCharacter || !nextCharacter) return
  const attempted = sanitizeCharacterPatch(changedCharacterFields(previousCharacter, nextCharacter))
  if (Object.keys(attempted).length === 0) return
  return dispatchCompatibleCharacterPatchScoped(characterId, attempted, previous)
}

export function applyCharacterRowMutationScoped(
  index: number,
  characterId: string,
  mutate: (character: character) => void,
): boolean {
  if (!canUseClientWriteAccess()) return false
  const previous = currentCharacterRowSnapshot(index)
  const target = uniqueCharacterOwnerAt(index)
  if (!target || target.chaId !== characterId || uniqueCharacterOwnerById(characterId) !== target) return false
  mutate(target)

  dispatchCompatibleCharacterUpdateScoped(previous.character, uniqueCharacterOwnerById(characterId), previous)
  return true
}

// Factory-list form retained for legacy compatibility callers and focused
// projection tests. Live plugin bridges use the durable scoped preparation.
export function prepareCompatibleCharacterUpdate(
  previousCharacter: character | undefined,
  nextCharacter: character | undefined,
  previous: CharacterStateSnapshot,
): CompatibleCharacterUpdatePreparation {
  const factories: Array<(baseRevision: number) => Promise<ServerCommandResult>> = []
  const compatibleUpdate = prepareCompatibleCharacterProjectionUpdate(previousCharacter, nextCharacter)
  if (compatibleUpdate.characterId && Object.keys(compatibleUpdate.patch).length > 0) {
    const characterId = compatibleUpdate.characterId
    const commandPatch = compatibleUpdate.patch
    factories.push((baseRevision) =>
      updateCharacterCommand({
        baseRevision,
        characterId,
        patch: commandPatch,
      }),
    )
  }
  return { ...compatibleUpdate, factories, rollback: () => restoreCharacterState(previous) }
}

// Scoped preparation for plugin compatibility bridges. It keeps the legacy
// factory fields for callers that inspect them, while live dispatch routes
// through the durable character-owner outbox. Terminal failures roll back only
// attempted target-row fields; later sibling edits and selection changes stay.
export function prepareCompatibleCharacterUpdateScoped(
  previousCharacter: character | undefined,
  nextCharacter: character | undefined,
  previous: CharacterRowSnapshot,
): CompatibleCharacterScopedUpdatePreparation {
  const factories: Array<(baseRevision: number) => Promise<ServerCommandResult>> = []
  const compatibleUpdate = prepareCompatibleCharacterProjectionUpdate(previousCharacter, nextCharacter)
  if (compatibleUpdate.characterId && Object.keys(compatibleUpdate.patch).length > 0) {
    const characterId = compatibleUpdate.characterId
    const commandPatch = compatibleUpdate.patch
    factories.push((baseRevision) =>
      updateCharacterCommand({
        baseRevision,
        characterId,
        patch: commandPatch,
      }),
    )
  }
  const dispatchAsync = (): Promise<CompatibleCharacterMutationOutcome | null> => {
    if (!compatibleUpdate.characterId || Object.keys(compatibleUpdate.patch).length === 0) return Promise.resolve(null)
    return (
      dispatchCompatibleCharacterPatchScopedOutcome(compatibleUpdate.characterId, compatibleUpdate.patch, previous) ??
      Promise.resolve(null)
    )
  }
  return {
    ...compatibleUpdate,
    factories,
    rollback: () => restoreCompatibleCharacterRowAttempt({ ...previous, attempted: compatibleUpdate.patch }),
    dispatch: () => void dispatchAsync(),
    dispatchAsync,
  }
}

export function prepareCompatibleCharacterProjectionUpdate(
  previousCharacter: character | undefined,
  nextCharacter: character | undefined,
): Pick<CompatibleCharacterUpdatePreparation, 'characterId' | 'patch' | 'optimisticCharacter'> {
  const characterId = previousCharacter?.chaId
  if (!characterId || !previousCharacter || !nextCharacter) {
    return { patch: {} }
  }

  const commandPatch = sanitizeCharacterPatch(changedCharacterFields(previousCharacter, nextCharacter))
  if (Object.keys(commandPatch).length === 0) {
    return { characterId, patch: commandPatch }
  }

  return {
    characterId,
    patch: commandPatch,
    optimisticCharacter: applyCompatibleCharacterPatch(previousCharacter, commandPatch),
  }
}

export function applyCompatibleCharacterPatch(previousCharacter: character, patch: CharacterSnapshot): character {
  const nextRecord = { ...(previousCharacter as unknown as Record<string, unknown>) }
  applyCharacterPatchToRecord(nextRecord, patch)
  return nextRecord as unknown as character
}

export function dispatchDeleteCharacter(characterId: string, previous: CharacterStateSnapshot): void {
  if (!canUseClientWriteAccess()) return
  void prepareDeleteCharacter(characterId, previous)?.promise
}

export function dispatchDeleteCharacterWithOutcome(
  characterId: string,
  previous: CharacterStateSnapshot,
): Promise<CharacterMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const execution = prepareDeleteCharacter(characterId, previous)
  return execution ? compatibleCharacterMutationOutcome(execution) : undefined
}

function prepareDeleteCharacter(
  characterId: string,
  previous: CharacterStateSnapshot,
): PendingCharacterMutationExecution | undefined {
  const rollback = characterDeleteRollbackFromState(characterId, previous)
  repairCharacterOrderOptimistically({ dispatchReorder: false })
  normalizeCurrentCharacterPointerAfterDelete(characterId, rollback?.previousCurrentCharacterId)
  if (!canUseServerCommands()) {
    restoreDeletedCharacterAttempt(rollback)
    return {
      promise: Promise.resolve({ status: 'unavailable' }),
      disposition: () => 'rollback',
    }
  }

  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [characterOwnerMutationKey(characterId)],
    requests: [
      {
        method: 'DELETE',
        path: `/characters/${encodeURIComponent(characterId)}`,
        body: {},
      },
    ],
  }
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(CHARACTER_SELECTION_MUTATION_KEY, intent)
  } catch (error) {
    restoreDeletedCharacterAttempt(rollback)
    return {
      promise: Promise.resolve(pendingMutationStagingFailure(error)),
      disposition: () => 'rollback',
    }
  }
  const projectionFences = characterCollectionProjectionFences(outbox, characterId, true)
  let disposition: 'retain' | 'rollback' = 'retain'
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  const promise = dispatchDurableMutation(outbox, intent, (transport) => {
    failureRollbackDisposition = transport.failureRollbackDisposition
    return (
      runCharacterCommand(
        (baseRevision) =>
          deleteCharacterCommand({
            baseRevision,
            characterId,
          }),
        () => restoreDeletedCharacterAttempt(rollback),
        transport,
      ) ?? Promise.resolve({ status: 'unavailable' as const })
    )
  }).then(
    (result) => {
      disposition = result.status === 'ok' ? 'rollback' : (failureRollbackDisposition?.(result) ?? disposition)
      if (result.status !== 'ok' && disposition === 'retain') {
        reapplyDeletedCharacterProjection(rollback, projectionFences)
      }
      return result
    },
    (error) => {
      disposition = failureRollbackDisposition?.({ status: 'unavailable' }) ?? disposition
      if (disposition === 'retain') reapplyDeletedCharacterProjection(rollback, projectionFences)
      throw error
    },
  )
  return { promise, disposition: () => disposition }
}

function normalizeCurrentCharacterPointerAfterDelete(
  characterId: string,
  previousCurrentCharacterId: string | undefined,
): void {
  const characters = characterRowsOwner()
  if (characters.some((candidate) => candidate?.chaId === characterId)) return

  if (previousCurrentCharacterId && previousCurrentCharacterId !== characterId) {
    const preservedIndex = characters.findIndex((candidate) => candidate?.chaId === previousCurrentCharacterId)
    if (preservedIndex >= 0) {
      setCurrentCharOwner(preservedIndex)
      return
    }
  }

  let currentChar = currentCharOwner()
  if (!Number.isInteger(currentChar)) currentChar = characters.length > 0 ? 0 : -1
  if ((currentChar as number) >= characters.length) currentChar = characters.length > 0 ? characters.length - 1 : -1
  if ((currentChar as number) < -1) currentChar = characters.length > 0 ? 0 : -1
  setCurrentCharOwner(currentChar)
}

export function dispatchSelectCharacter(
  characterId: string,
  previous: CharacterSelectionSnapshot,
  lastInteraction?: number,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchSelectCharacterWithOutcome(characterId, previous, lastInteraction)
}

export function dispatchSelectCharacterWithOutcome(
  characterId: string,
  previous: CharacterSelectionSnapshot,
  lastInteraction?: number,
): Promise<CharacterMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const execution = prepareSelectCharacter(characterId, previous, lastInteraction)
  return compatibleCharacterMutationOutcome(execution)
}

function reapplyRetainedCharacterSelection(
  previous: CharacterSelectionSnapshot,
  attempted: CharacterSelectionAttempt,
  selectionFence: PendingMutationProjectionFence | null,
  interactionFence: PendingMutationProjectionFence | null,
): void {
  const attemptedCharacter = uniqueCharacterOwnerById(attempted.characterId)
  if (!attemptedCharacter) return
  const liveSelectedCharacterId = selectedCharacterIdAt(get(selectedCharID))
  const previousSelectedCharacterId = selectedCharacterIdFromSelectionSnapshot(previous)
  if (
    isCurrentCharacterProjectionFence(selectionFence) &&
    (!liveSelectedCharacterId ||
      liveSelectedCharacterId === attempted.characterId ||
      liveSelectedCharacterId === previousSelectedCharacterId)
  ) {
    const attemptedIndex = characterRowsOwner().indexOf(attemptedCharacter)
    if (attemptedIndex >= 0) {
      setCurrentCharOwner(attemptedIndex)
      selectedCharID.set(attemptedIndex)
    }
  }
  if (
    attempted.lastInteraction !== undefined &&
    isCurrentCharacterProjectionFence(interactionFence) &&
    (attemptedCharacter.lastInteraction === previous.lastInteraction ||
      attemptedCharacter.lastInteraction === attempted.lastInteraction)
  ) {
    attemptedCharacter.lastInteraction = attempted.lastInteraction
  }
}

function prepareSelectCharacter(
  characterId: string,
  previous: CharacterSelectionSnapshot,
  lastInteraction?: number,
): PendingCharacterMutationExecution {
  const attempted = currentCharacterSelectionAttempt(characterId, lastInteraction)
  if (!canUseServerCommands()) {
    restoreCharacterSelectionAttempt(previous, attempted)
    return {
      promise: Promise.resolve({ status: 'unavailable' }),
      disposition: () => 'rollback',
    }
  }
  const previousSelectedCharacterId = selectedCharacterIdFromSelectionSnapshot(previous)
  const dependencyKeys = Array.from(
    new Set(
      [previousSelectedCharacterId, characterId]
        .filter((candidate): candidate is string => Boolean(candidate))
        .map(characterOwnerMutationKey),
    ),
  )
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys,
    requests: [
      {
        method: 'POST',
        path: '/characters/select',
        body: {
          characterId,
          ...(lastInteraction === undefined ? {} : { lastInteraction }),
        },
      },
    ],
  }
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(CHARACTER_SELECTION_MUTATION_KEY, intent)
  } catch (error) {
    restoreCharacterSelectionAttempt(previous, attempted)
    return {
      promise: Promise.resolve(pendingMutationStagingFailure(error)),
      disposition: () => 'rollback',
    }
  }
  const interactionTarget = characterFieldProjectionTarget(characterId, 'lastInteraction')
  recordPendingMutationProjectionTargets(outbox, [CHARACTER_SELECTION_PROJECTION_TARGET, interactionTarget])
  const selectionFence = pendingMutationProjectionFence(outbox, CHARACTER_SELECTION_PROJECTION_TARGET)
  const interactionFence = pendingMutationProjectionFence(outbox, interactionTarget)
  let disposition: 'retain' | 'rollback' = 'retain'
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  const promise = dispatchDurableMutation(outbox, intent, (transport) => {
    failureRollbackDisposition = transport.failureRollbackDisposition
    return (
      runCharacterCommand(
        (baseRevision) =>
          selectCharacterCommand({
            baseRevision,
            characterId,
            lastInteraction,
          }),
        () => restoreCharacterSelectionAttempt(previous, attempted),
        transport,
      ) ?? Promise.resolve({ status: 'unavailable' as const })
    )
  }).then(
    (result) => {
      disposition = result.status === 'ok' ? 'rollback' : (failureRollbackDisposition?.(result) ?? disposition)
      if (result.status !== 'ok' && disposition === 'retain') {
        reapplyRetainedCharacterSelection(previous, attempted, selectionFence, interactionFence)
      }
      return result
    },
    (error) => {
      disposition = failureRollbackDisposition?.({ status: 'unavailable' }) ?? disposition
      if (disposition === 'retain') {
        reapplyRetainedCharacterSelection(previous, attempted, selectionFence, interactionFence)
      }
      throw error
    },
  )
  return { promise, disposition: () => disposition }
}

function dispatchCharacterOrderCommandWithOutcome(
  projection: CharacterOrderDurableProjection,
  rollback: () => void,
  dependencyCharacterIds: readonly string[] = [],
): Promise<CharacterMutationOutcome> | undefined {
  const execution = prepareCharacterOrderCommand(projection, rollback, dependencyCharacterIds)
  return execution ? compatibleCharacterMutationOutcome(execution) : undefined
}

function prepareCharacterOrderCommand(
  projection: CharacterOrderDurableProjection,
  rollback: () => void,
  dependencyCharacterIds: readonly string[] = [],
): PendingCharacterMutationExecution | undefined {
  if (!canUseServerCommands()) {
    rollback()
    return {
      promise: Promise.resolve({ status: 'unavailable' }),
      disposition: () => 'rollback',
    }
  }
  const generation = ++characterOrderProjectionGeneration
  const commandOrder = cloneJsonValue(projection.attemptedOrder)
  const dependencyKeys = Array.from(
    new Set(
      dependencyCharacterIds
        .filter((characterId) => isCharacterOrderableId(characterId))
        .map(characterOwnerMutationKey),
    ),
  ).slice(0, MAX_CHARACTER_ORDER_DEPENDENCY_KEYS)
  const intent: DurableMutationIntent = {
    version: 1,
    ...(dependencyKeys.length > 0 ? { dependencyKeys } : {}),
    requests: [
      {
        method: 'POST',
        path: '/characters/reorder',
        body: { characterOrder: cloneJsonValue(commandOrder) },
      },
    ],
  }
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(CHARACTER_SELECTION_MUTATION_KEY, intent)
  } catch (error) {
    if (projection.metadata || generation === characterOrderProjectionGeneration) rollback()
    return {
      promise: Promise.resolve(pendingMutationStagingFailure(error)),
      disposition: () => 'rollback',
    }
  }
  const projectionFence = pendingMutationProjectionFence(outbox, pendingMutationCharacterOrderProjectionTarget())
  let disposition: 'retain' | 'rollback' = 'retain'
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  const promise = dispatchDurableMutation(outbox, intent, (transport) => {
    failureRollbackDisposition = transport.failureRollbackDisposition
    return (
      runCharacterCommand(
        (baseRevision) =>
          reorderCharactersCommand({
            baseRevision,
            characterOrder: cloneJsonValue(commandOrder) as CharacterOrderEntry[],
          }),
        () => {
          if (projection.metadata || generation === characterOrderProjectionGeneration) rollback()
        },
        transport,
      ) ?? Promise.resolve({ status: 'unavailable' as const })
    )
  }).then(
    (result) => {
      disposition = result.status === 'ok' ? 'rollback' : (failureRollbackDisposition?.(result) ?? disposition)
      if (result.status !== 'ok' && disposition === 'retain') {
        if (projection.metadata) {
          reapplyCharacterOrderFolderMetadataProjection(projection.metadata)
        } else if (
          generation === characterOrderProjectionGeneration &&
          isCurrentCharacterOrderProjectionFence(projectionFence)
        ) {
          reapplyCharacterOrderProjection(projection)
        }
      }
      return result
    },
    (error) => {
      disposition = failureRollbackDisposition?.({ status: 'unavailable' }) ?? disposition
      if (disposition === 'retain') {
        if (projection.metadata) {
          reapplyCharacterOrderFolderMetadataProjection(projection.metadata)
        } else if (
          generation === characterOrderProjectionGeneration &&
          isCurrentCharacterOrderProjectionFence(projectionFence)
        ) {
          reapplyCharacterOrderProjection(projection)
        }
      }
      throw error
    },
  )
  return { promise, disposition: () => disposition }
}

export function dispatchReorderCharacters(
  previousOrder: (string | folder)[],
  dependencyCharacterIds: readonly string[] = [],
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchReorderCharactersWithOutcome(previousOrder, dependencyCharacterIds)
}

export function dispatchReorderCharactersWithOutcome(
  previousOrder: (string | folder)[],
  dependencyCharacterIds: readonly string[] = [],
): Promise<CharacterMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const rollback = characterOrderRollbackFromOrders(previousOrder, characterOrderOwner())
  return dispatchCharacterOrderCommandWithOutcome(
    { attemptedOrder: rollback.attemptedOrder },
    () => restoreCharacterOrderAttempt(rollback),
    dependencyCharacterIds,
  )
}

function isCurrentCharacterOrderProjectionFence(fence: PendingMutationProjectionFence | null): boolean {
  return fence !== null && isPendingMutationProjectionFenceCurrent(fence)
}

function reapplyCharacterOrderProjection(projection: CharacterOrderDurableProjection): void {
  const liveOrder = characterOrderOwner()
  const reappliedOrder = restoreCharacterOrderStructure(projection.attemptedOrder, liveOrder)
  const metadata = projection.metadata
  if (metadata) {
    const folderIndex = findCharacterOrderFolderIndex(reappliedOrder, metadata.folderId)
    const targetFolder = reappliedOrder[folderIndex]
    if (isCharacterOrderFolder(targetFolder)) {
      applyCharacterOrderFolderMetadata(targetFolder, metadata.attempted)
      reappliedOrder[folderIndex] = targetFolder
    }
  }
  setCharacterOrderOwner(normalizeCharacterOrder(reappliedOrder, characterRowsOwner()).characterOrder)
}

function reapplyCharacterOrderFolderMetadataProjection(metadata: CharacterOrderFolderMetadataRollback): void {
  const characterOrder = characterOrderOwner()
  const folderIndex = findCharacterOrderFolderIndex(characterOrder, metadata.folderId)
  const targetFolder = characterOrder[folderIndex]
  if (!isCharacterOrderFolder(targetFolder)) return

  const target = targetFolder as unknown as Record<string, unknown>
  const reapplied: Partial<Record<CharacterOrderFolderMetadataKey, unknown>> = {}
  for (const [key, attemptedValue] of Object.entries(metadata.attempted) as Array<
    [CharacterOrderFolderMetadataKey, unknown]
  >) {
    if (characterFieldSnapshotEquals(target[key], attemptedValue)) continue
    const hadPrevious = Object.prototype.hasOwnProperty.call(metadata.previous, key)
    if (Object.prototype.hasOwnProperty.call(target, key) !== hadPrevious) continue
    if (hadPrevious && !characterFieldSnapshotEquals(target[key], metadata.previous[key])) continue
    reapplied[key] = attemptedValue
  }
  if (Object.keys(reapplied).length === 0) return
  applyCharacterOrderFolderMetadata(targetFolder, reapplied)
  characterOrder[folderIndex] = targetFolder
  setCharacterOrderOwner(characterOrder)
}

function characterOrderRollbackFromOrders(
  previousOrder: readonly (string | folder)[],
  attemptedOrder: readonly (string | folder)[],
): CharacterOrderRollback {
  return {
    previousOrder: cloneJsonValue(previousOrder),
    attemptedOrder: cloneJsonValue(attemptedOrder),
  }
}

function restoreCharacterOrderAttempt(rollback: CharacterOrderRollback): void {
  const liveOrder = characterOrderOwner()
  if (!characterOrderStructureEquals(liveOrder, rollback.attemptedOrder)) return
  setCharacterOrderOwner(restoreCharacterOrderStructure(rollback.previousOrder, liveOrder))
}

function restoreCharacterOrderStructure(
  previousOrder: readonly (string | folder)[],
  liveOrder: readonly (string | folder)[],
): (string | folder)[] {
  const liveFoldersById = new Map<string, folder>()
  for (const entry of liveOrder) {
    if (isCharacterOrderFolder(entry)) {
      liveFoldersById.set(entry.id, entry)
    }
  }

  return previousOrder.map((entry) => {
    if (typeof entry === 'string') return entry
    if (!isCharacterOrderFolder(entry)) return cloneJsonValue(entry) as string | folder

    const restoredFolder = cloneJsonValue(liveFoldersById.get(entry.id) ?? entry)
    restoredFolder.data = cloneJsonValue(entry.data)
    return restoredFolder
  })
}

function characterOrderStructureEquals(
  left: readonly (string | folder)[],
  right: readonly (string | folder)[],
): boolean {
  return JSON.stringify(characterOrderStructure(left)) === JSON.stringify(characterOrderStructure(right))
}

function characterOrderStructure(order: readonly (string | folder)[]): unknown[] {
  return order.map((entry) => {
    if (typeof entry === 'string') return entry
    if (!isCharacterOrderFolder(entry)) return cloneJsonValue(entry)
    return { id: entry.id, data: [...entry.data] }
  })
}

export function normalizeCharacterOrder(
  characterOrder: readonly (string | folder | null | undefined)[] | null | undefined,
  characters: readonly character[] | null | undefined,
): CharacterOrderNormalizationResult {
  const rawOrder = Array.isArray(characterOrder) ? characterOrder : []
  const activeIds = new Set<string>()
  const normalized: (string | folder)[] = []
  const seen = new Set<string>()

  for (const char of characters ?? []) {
    const charId = char?.chaId
    if (isCharacterOrderableId(charId) && !char.trashTime) {
      activeIds.add(charId)
    }
  }

  for (const entry of rawOrder) {
    if (typeof entry === 'string') {
      if (activeIds.has(entry) && !seen.has(entry)) {
        normalized.push(entry)
        seen.add(entry)
      }
      continue
    }

    if (!isCharacterOrderFolder(entry)) continue
    const normalizedFolder = cloneJsonValue(entry)
    normalizedFolder.data = []
    for (const id of entry.data) {
      if (activeIds.has(id) && !seen.has(id)) {
        normalizedFolder.data.push(id)
        seen.add(id)
      }
    }
    if (normalizedFolder.data.length > 0) {
      normalized.push(normalizedFolder)
    }
  }

  for (const id of activeIds) {
    if (!seen.has(id)) {
      normalized.push(id)
    }
  }

  return {
    characterOrder: normalized,
    changed: !Array.isArray(characterOrder) || !characterOrderEquals(rawOrder, normalized),
  }
}

export function repairCharacterOrderOptimistically(
  options: {
    dispatchReorder?: boolean
  } = {},
): boolean {
  if (!canUseClientWriteAccess()) return false
  const normalized = normalizeCharacterOrder(characterOrderOwner(), characterRowsOwner())
  if (!normalized.changed) return false

  const shouldDispatchReorder = options.dispatchReorder ?? true
  const previousOrder = shouldDispatchReorder ? currentCharacterOrderSnapshot() : null
  setCharacterOrderOwner(normalized.characterOrder)
  if (previousOrder) {
    const previousIds = new Set(characterIdsInOrder(previousOrder))
    const addedCharacterIds = characterIdsInOrder(normalized.characterOrder).filter((id) => !previousIds.has(id))
    dispatchReorderCharacters(previousOrder, addedCharacterIds)
  }
  return true
}

export function moveCharacterOrderItem(
  mainIndex: CharacterOrderDragPosition,
  targetIndex: CharacterOrderDragPosition,
): boolean {
  if (!canUseClientWriteAccess()) return false
  return prepareMoveCharacterOrderItem(mainIndex, targetIndex).applied
}

export function moveCharacterOrderItemWithOutcome(
  mainIndex: CharacterOrderDragPosition,
  targetIndex: CharacterOrderDragPosition,
): CharacterOrderMutationHandle {
  if (!canUseClientWriteAccess())
    return { applied: false, settlement: Promise.resolve({ status: 'failed', result: { status: 'unavailable' } }) }
  return prepareMoveCharacterOrderItem(mainIndex, targetIndex)
}

function prepareMoveCharacterOrderItem(
  mainIndex: CharacterOrderDragPosition,
  targetIndex: CharacterOrderDragPosition,
): CharacterOrderMutationHandle {
  if (isSameCharacterOrderPosition(mainIndex, targetIndex)) return { applied: false, settlement: null }

  const previousOrder = currentCharacterOrderSnapshot()
  let changed = false
  let dependencyCharacterId = ''
  const applyMove = (): void => {
    const characterOrder = ensureCharacterOrder()
    let mainFolderIndex = mainIndex.folder ? getCharacterOrderFolderIndex(mainIndex.folder) : null
    const targetFolderIndex = targetIndex.folder ? getCharacterOrderFolderIndex(targetIndex.folder) : null
    const mainFolder = mainFolderIndex === null ? null : characterOrder[mainFolderIndex]
    const mainFolderId = mainIndex.folder && isCharacterOrderFolder(mainFolder) ? mainFolder.id : ''
    let movingFolder: folder | false = false
    let mainId = ''

    if (mainIndex.folder) {
      if (!isCharacterOrderFolder(mainFolder)) return
      mainId = mainFolder.data[mainIndex.index]
    } else {
      const item = characterOrder[mainIndex.index]
      if (typeof item !== 'string') {
        if (!isCharacterOrderFolder(item)) return
        mainId = item.id
        movingFolder = cloneJsonValue(item)
        if (targetIndex.folder) return
      } else {
        mainId = item
      }
    }
    if (!mainId) return
    if (!movingFolder) dependencyCharacterId = mainId

    if (targetIndex.folder) {
      if (targetFolderIndex === null) return
      const targetFolder = targetFolderIndex === null ? null : characterOrder[targetFolderIndex]
      if (!isCharacterOrderFolder(targetFolder)) return
      targetFolder.data.splice(targetIndex.index, 0, mainId)
      characterOrder[targetFolderIndex] = targetFolder
    } else if (movingFolder) {
      characterOrder.splice(targetIndex.index, 0, movingFolder)
    } else {
      characterOrder.splice(targetIndex.index, 0, mainId)
    }

    if (mainIndex.folder) {
      mainFolderIndex = findCharacterOrderFolderIndex(characterOrder, mainFolderId)
      if (mainFolderIndex !== -1) {
        const folder = characterOrder[mainFolderIndex]
        if (isCharacterOrderFolder(folder)) {
          const ind =
            mainIndex.index > targetIndex.index ? folder.data.lastIndexOf(mainId) : folder.data.indexOf(mainId)
          if (ind !== -1) {
            folder.data.splice(ind, 1)
          }
          characterOrder[mainFolderIndex] = folder
        }
      } else {
        console.log('folder not found')
      }
    } else if (movingFolder) {
      const idList: string[] = []
      for (const item of characterOrder) {
        idList.push(typeof item === 'string' ? item : item.id)
      }
      const ind = mainIndex.index > targetIndex.index ? idList.lastIndexOf(mainId) : idList.indexOf(mainId)
      if (ind !== -1) {
        characterOrder.splice(ind, 1)
      }
    } else {
      const ind =
        mainIndex.index > targetIndex.index ? characterOrder.lastIndexOf(mainId) : characterOrder.indexOf(mainId)
      if (ind !== -1) {
        characterOrder.splice(ind, 1)
      }
    }

    setCharacterOrderOwner(characterOrder)
    replaceCharacterOrderWithNormalized()
    changed = true
  }
  applyMove()

  if (!changed) return { applied: false, settlement: null }
  return {
    applied: true,
    settlement:
      dispatchReorderCharactersWithOutcome(previousOrder, dependencyCharacterId ? [dependencyCharacterId] : []) ?? null,
  }
}

export function createCharacterOrderFolder(
  mainIndex: CharacterOrderDragPosition,
  targetIndex: CharacterOrderDragPosition,
  createFolderId: () => string = v4,
  folderName = 'New Folder',
): boolean {
  if (!canUseClientWriteAccess()) return false
  return prepareCreateCharacterOrderFolder(mainIndex, targetIndex, createFolderId, folderName).applied
}

export function createCharacterOrderFolderWithOutcome(
  mainIndex: CharacterOrderDragPosition,
  targetIndex: CharacterOrderDragPosition,
  createFolderId: () => string = v4,
  folderName = 'New Folder',
): CharacterOrderMutationHandle {
  if (!canUseClientWriteAccess())
    return { applied: false, settlement: Promise.resolve({ status: 'failed', result: { status: 'unavailable' } }) }
  return prepareCreateCharacterOrderFolder(mainIndex, targetIndex, createFolderId, folderName)
}

function prepareCreateCharacterOrderFolder(
  mainIndex: CharacterOrderDragPosition,
  targetIndex: CharacterOrderDragPosition,
  createFolderId: () => string,
  folderName: string,
): CharacterOrderMutationHandle {
  if (isSameCharacterOrderPosition(mainIndex, targetIndex)) return { applied: false, settlement: null }

  const previousOrder = currentCharacterOrderSnapshot()
  let changed = false
  const dependencyCharacterIds: string[] = []
  const applyFolderCreate = (): void => {
    const characterOrder = ensureCharacterOrder()
    const mainFolderIndex = mainIndex.folder ? getCharacterOrderFolderIndex(mainIndex.folder) : null
    const mainFolder = mainFolderIndex === null ? null : characterOrder[mainFolderIndex]
    if (targetIndex.folder) {
      return
    }
    if (mainIndex.folder && !isCharacterOrderFolder(mainFolder)) {
      return
    }

    const main =
      mainIndex.folder && isCharacterOrderFolder(mainFolder)
        ? mainFolder.data[mainIndex.index]
        : characterOrder[mainIndex.index]
    const target = characterOrder[targetIndex.index]
    if (typeof main !== 'string') {
      return
    }
    dependencyCharacterIds.push(main)
    if (typeof target === 'string') {
      dependencyCharacterIds.push(target)
      const newFolder: folder = {
        name: folderName,
        data: [main, target],
        color: '',
        id: createFolderId(),
      }
      characterOrder[targetIndex.index] = newFolder
      if (mainIndex.folder && isCharacterOrderFolder(mainFolder) && mainFolderIndex !== null) {
        mainFolder.data.splice(mainIndex.index, 1)
        characterOrder[mainFolderIndex] = mainFolder
      } else {
        characterOrder.splice(mainIndex.index, 1)
      }
    } else {
      if (!isCharacterOrderFolder(target)) return
      target.data.push(main)
      if (mainIndex.folder && isCharacterOrderFolder(mainFolder) && mainFolderIndex !== null) {
        mainFolder.data.splice(mainIndex.index, 1)
        characterOrder[mainFolderIndex] = mainFolder
      } else {
        characterOrder.splice(mainIndex.index, 1)
      }
    }
    setCharacterOrderOwner(characterOrder)
    replaceCharacterOrderWithNormalized()
    changed = true
  }
  applyFolderCreate()

  if (!changed) return { applied: false, settlement: null }
  return {
    applied: true,
    settlement: dispatchReorderCharactersWithOutcome(previousOrder, dependencyCharacterIds) ?? null,
  }
}

export function updateCharacterOrderFolder(
  folderIdOrIndex: CharacterOrderFolderTarget,
  patch: CharacterOrderFolderMetadataPatch,
): boolean {
  if (!canUseClientWriteAccess()) return false
  return prepareUpdateCharacterOrderFolder(folderIdOrIndex, patch).applied
}

export function updateCharacterOrderFolderWithOutcome(
  folderIdOrIndex: CharacterOrderFolderTarget,
  patch: CharacterOrderFolderMetadataPatch,
): CharacterOrderMutationHandle {
  if (!canUseClientWriteAccess())
    return { applied: false, settlement: Promise.resolve({ status: 'failed', result: { status: 'unavailable' } }) }
  return prepareUpdateCharacterOrderFolder(folderIdOrIndex, patch)
}

function prepareUpdateCharacterOrderFolder(
  folderIdOrIndex: CharacterOrderFolderTarget,
  patch: CharacterOrderFolderMetadataPatch,
): CharacterOrderMutationHandle {
  const attemptedPatch = normalizeCharacterOrderFolderMetadataPatch(patch)
  const patchKeys = Object.keys(attemptedPatch) as CharacterOrderFolderMetadataKey[]
  if (patchKeys.length === 0) return { applied: false, settlement: null }

  let rollback: CharacterOrderFolderMetadataRollback | null = null
  let changed = false
  const applyFolderUpdate = (): void => {
    const characterOrder = ensureCharacterOrder()
    const folderIndex = resolveCharacterOrderFolderIndex(characterOrder, folderIdOrIndex)
    if (folderIndex === -1) return

    const targetFolder = characterOrder[folderIndex]
    if (!isCharacterOrderFolder(targetFolder)) return

    const mutableFolder = targetFolder as folder & { imgFile?: string | null }
    const previous = captureCharacterOrderFolderMetadata(mutableFolder, patchKeys)
    for (const key of patchKeys) {
      const value = attemptedPatch[key]
      switch (key) {
        case 'name':
          mutableFolder.name = value as string
          break

        case 'color':
          mutableFolder.color = value as string
          break

        case 'askBeforeOpening':
          mutableFolder.askBeforeOpening = value as boolean
          break

        case 'imgFile':
          mutableFolder.imgFile = value as string | null
          break

        case 'img':
          mutableFolder.img = value as string
          break
      }
    }
    rollback = {
      folderId: mutableFolder.id,
      previous,
      attempted: cloneJsonValue(attemptedPatch),
    }
    characterOrder[folderIndex] = mutableFolder
    setCharacterOrderOwner(characterOrder)
    changed = true
  }
  applyFolderUpdate()

  if (!changed || !rollback) return { applied: false, settlement: null }
  const metadataRollback = rollback
  return {
    applied: true,
    settlement:
      dispatchCharacterOrderCommandWithOutcome(
        { attemptedOrder: currentCharacterOrderSnapshot(), metadata: metadataRollback },
        () => restoreCharacterOrderFolderMetadataAttempt(metadataRollback),
      ) ?? null,
  }
}

function normalizeCharacterOrderFolderMetadataPatch(
  patch: CharacterOrderFolderMetadataPatch,
): Partial<Record<CharacterOrderFolderMetadataKey, unknown>> {
  const normalized: Partial<Record<CharacterOrderFolderMetadataKey, unknown>> = {}
  for (const key of CHARACTER_ORDER_FOLDER_METADATA_KEYS) {
    const value = patch[key]
    if (value === undefined) continue
    normalized[key] = key === 'color' ? (value as string).toLocaleLowerCase() : cloneJsonValue(value)
  }
  return normalized
}

function captureCharacterOrderFolderMetadata(
  targetFolder: folder & { imgFile?: string | null },
  keys: readonly CharacterOrderFolderMetadataKey[],
): Partial<Record<CharacterOrderFolderMetadataKey, unknown>> {
  const captured: Partial<Record<CharacterOrderFolderMetadataKey, unknown>> = {}
  const source = targetFolder as unknown as Record<string, unknown>
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      captured[key] = cloneJsonValue(source[key])
    }
  }
  return captured
}

function applyCharacterOrderFolderMetadata(
  target: folder & { imgFile?: string | null },
  metadata: Partial<Record<CharacterOrderFolderMetadataKey, unknown>>,
): void {
  for (const [key, value] of Object.entries(metadata) as Array<[CharacterOrderFolderMetadataKey, unknown]>) {
    switch (key) {
      case 'name':
        target.name = value as string
        break
      case 'color':
        target.color = value as string
        break
      case 'askBeforeOpening':
        target.askBeforeOpening = value as boolean
        break
      case 'imgFile':
        target.imgFile = value as string | null
        break
      case 'img':
        target.img = value as string
        break
    }
  }
}

function restoreCharacterOrderFolderMetadataAttempt(rollback: CharacterOrderFolderMetadataRollback): void {
  const characterOrder = characterOrderOwner()
  const folderIndex = findCharacterOrderFolderIndex(characterOrder, rollback.folderId)
  if (folderIndex === -1) return

  const targetFolder = characterOrder[folderIndex]
  if (!isCharacterOrderFolder(targetFolder)) return

  const rolledBack = applyAttemptedFieldRollback({
    target: targetFolder as unknown as Record<string, unknown>,
    previous: rollback.previous as Partial<Record<string, unknown>>,
    attempted: rollback.attempted as Partial<Record<string, unknown>>,
    keys: CHARACTER_ORDER_FOLDER_METADATA_KEYS,
    deleteMissingPrevious: true,
  })
  if (rolledBack.length === 0) return

  characterOrder[folderIndex] = targetFolder
  setCharacterOrderOwner(characterOrder)
}

function isSameCharacterOrderPosition(
  mainIndex: CharacterOrderDragPosition,
  targetIndex: CharacterOrderDragPosition,
): boolean {
  return mainIndex.index === targetIndex.index && mainIndex.folder === targetIndex.folder
}

function characterIdsInOrder(order: readonly (string | folder)[]): string[] {
  const ids: string[] = []
  for (const entry of order) {
    if (typeof entry === 'string') ids.push(entry)
    else if (isCharacterOrderFolder(entry)) ids.push(...entry.data)
  }
  return ids
}

function ensureCharacterOrder(): (string | folder)[] {
  const characterOrder = characterOrderOwner()
  if (charactersResourceState.status === 'ready') return characterOrder
  if (charactersResourceState.status === 'idle' || charactersResourceState.status === 'loading') {
    setCharacterOrderOwner(characterOrder)
    return characterOrderOwner()
  }
  return []
}

function isCharacterOrderFolder(value: string | folder | undefined | null): value is folder {
  return !!value && typeof value !== 'string' && Array.isArray((value as folder).data)
}

function getCharacterOrderFolderIndex(id: string): number {
  return findCharacterOrderFolderIndex(characterOrderOwner(), id)
}

function findCharacterOrderFolderIndex(characterOrder: (string | folder)[], id: string): number {
  for (let i = 0; i < characterOrder.length; i++) {
    const data = characterOrder[i]
    if (isCharacterOrderFolder(data) && data.id === id) {
      return i
    }
  }
  return -1
}

function resolveCharacterOrderFolderIndex(
  characterOrder: (string | folder)[],
  folderIdOrIndex: CharacterOrderFolderTarget,
): number {
  if (typeof folderIdOrIndex === 'string') {
    return folderIdOrIndex ? findCharacterOrderFolderIndex(characterOrder, folderIdOrIndex) : -1
  }

  if (typeof folderIdOrIndex === 'number') {
    return isCharacterOrderFolder(characterOrder[folderIdOrIndex]) ? folderIdOrIndex : -1
  }

  const folderId = folderIdOrIndex.id ?? ''
  if (folderId) {
    return findCharacterOrderFolderIndex(characterOrder, folderId)
  }

  const fallbackIndex = folderIdOrIndex.index
  if (typeof fallbackIndex !== 'number') return -1
  return isCharacterOrderFolder(characterOrder[fallbackIndex]) ? fallbackIndex : -1
}

function replaceCharacterOrderWithNormalized(): void {
  const normalized = normalizeCharacterOrder(ensureCharacterOrder(), characterRowsOwner())
  setCharacterOrderOwner(normalized.characterOrder)
}

function isCharacterOrderableId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== '§temp'
}

function characterOrderEquals(
  left: readonly (string | folder | null | undefined)[],
  right: readonly (string | folder)[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function setCharacterSupaMemory(
  characterId: string,
  enabled: boolean,
): Promise<ServerCommandResult> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  return startCharacterSupaMemoryMutation(characterId, enabled)?.promise
}

export function setCharacterSupaMemoryWithOutcome(
  characterId: string,
  enabled: boolean,
): Promise<CharacterMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const execution = startCharacterSupaMemoryMutation(characterId, enabled)
  return execution ? compatibleCharacterMutationOutcome(execution) : undefined
}

function startCharacterSupaMemoryMutation(
  characterId: string,
  enabled: boolean,
): PendingCharacterMutationExecution | undefined {
  if (!characterId) return
  const character = uniqueCharacterOwnerById(characterId)
  if (!character || Boolean(character.supaMemory) === enabled) return

  const previous = currentCharacterSupaMemorySnapshot(characterId)
  if (!previous) return
  character.supaMemory = enabled
  return prepareUpdateCharacterSupaMemory(characterId, enabled, previous)
}

export function toCharacterSnapshot(character: character): CharacterSnapshot {
  return cloneJsonValue(character) as unknown as CharacterSnapshot
}

export function initialCharacterChatSnapshot(character: character): ChatSnapshot | undefined {
  const chat = character.chats?.[0]
  if (
    !chat ||
    typeof chat.id !== 'string' ||
    !chat.id.trim() ||
    !Array.isArray(chat.message) ||
    chat.message.length > 0 ||
    chat.hypaV3Data !== undefined
  ) {
    return undefined
  }
  return cloneJsonValue(chat) as unknown as ChatSnapshot
}

function warnIfCharacterCreateWouldDropChats(character: character, initialChat: ChatSnapshot | undefined): void {
  if ((character.chats?.length ?? 0) === 0 || initialChat) return
  console.error(
    `Character create would drop ${character.chats?.length ?? 0} chat(s) because no usable initial-chat snapshot exists`,
    { characterId: character.chaId },
  )
}

export function sanitizeCharacterPatch(patch: CharacterSnapshot): CharacterSnapshot {
  const sanitized: CharacterSnapshot = {}
  for (const [key, value] of Object.entries(patch)) {
    if (CHARACTER_PATCH_EXCLUDED_KEYS.has(key)) continue
    if (value === undefined) {
      if (CHARACTER_PATCH_DELETABLE_KEYS.has(key)) sanitized[key] = null
      continue
    }
    sanitized[key] = cloneJsonValue(value)
  }
  return sanitized
}

// Diff per kept key without first deep-cloning the whole character. The
// old shape cloned `previous` and `current` in full — `chats` with every
// hydrated history included — and then immediately stripped exactly those heavy
// keys via `sanitizeCharacterPatch`. Skipping `CHARACTER_PATCH_EXCLUDED_KEYS`
// before any clone keeps the diff O(kept fields); per-key JSON comparison on
// the raw values is equivalent to comparing the cloned values (the clone was a
// JSON round-trip, and `JSON.stringify` is stable across that round-trip).
// Only changed kept values are cloned into the patch. Exported for the
// clone-cost/parity gate.
export function changedCharacterFields(previous: character, current: character): CharacterSnapshot {
  const patch: CharacterSnapshot = {}
  const previousRecord = (previous ?? {}) as unknown as Record<string, unknown>
  const currentRecord = (current ?? {}) as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(previousRecord), ...Object.keys(currentRecord)])
  for (const key of keys) {
    if (CHARACTER_PATCH_EXCLUDED_KEYS.has(key)) continue
    if (snapshotJson(previousRecord[key]) !== snapshotJson(currentRecord[key])) {
      // Deletable fields are converted from `undefined` to an explicit null
      // sentinel by `sanitizeCharacterPatch`; other undefined fields remain
      // unsupported and are dropped.
      patch[key] = cloneJsonValue(currentRecord[key])
    }
  }
  return patch
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}
