import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { SvelteSet } from 'svelte/reactivity'
import { get } from 'svelte/store'
import { v4 } from 'uuid'
import type { RisuModule } from '../process/modules'
import type { character, Chat, Database, loreBook } from '../storage/database.svelte'
import { selectedCharID } from '../stores.svelte'
import { invalidateModuleRenderRevision } from '../moduleRenderRevision'
import {
  canUseServerCommands,
  createGlobalLorebookCommand,
  deleteCharacterLorebookEntryCommand,
  deleteChatLorebookEntryCommand,
  deleteGlobalLorebookCommand,
  deleteGlobalLorebookEntryCommand,
  deleteModuleLorebookEntryCommand,
  reorderCharacterLorebookEntriesCommand,
  reorderChatLorebookEntriesCommand,
  reorderGlobalLorebooksCommand,
  reorderGlobalLorebookEntriesCommand,
  reorderModuleLorebookEntriesCommand,
  replaceCharacterLorebooksCommand,
  replaceChatLorebooksCommand,
  replaceGlobalLorebookEntriesCommand,
  replaceModuleLorebooksCommand,
  runServerCommand,
  updateGlobalLorebookCommand,
  upsertCharacterLorebookEntryCommand,
  upsertChatLorebookEntryCommand,
  upsertGlobalLorebookEntryCommand,
  upsertModuleLorebookEntryCommand,
  type GlobalLorebookSnapshot,
  type LorebookEntrySnapshot,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
  type SparseLorebookEntryUpdate,
} from './commands'
import {
  captureCharacterLorebookProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  captureCollectionProjectionEpoch,
  captureLorebookPageProjectionEpoch,
  charactersResourceState,
  collectionsResourceState,
  getCharacterResourceOwner,
  hasCharacterLorebookProjectionEpochChanged,
  hasCharacterRowProjectionEpochChanged,
  hasCollectionProjectionEpochChanged,
  hasLorebookPageProjectionEpochChanged,
  settingsResourceState,
  type ServerCollectionName,
} from './resourceState.svelte'
import {
  applyAttemptedFieldRollback,
  applyAttemptedKeyedListRollback,
  mergeProjectionIntoDirtyDraft,
} from './staleStateGuards'
import { dispatchDurableMutation, registerDurableMutationSettlementListener } from './durableMutationDispatch'
import { GLOBAL_LOREBOOK_SELECTION_MUTATION_KEY, globalLorebookOwnerMutationKey } from './lorebookMutationKeys'
import { registerPendingOwnerMutationFlusher } from './pendingOwnerMutationRegistry'
import {
  acknowledgePendingMutation,
  isPendingMutationCurrent,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
} from './pendingMutationOutbox'
import {
  characterOwnerMutationKey,
  chatResourceOwnerMutationKey,
  moduleOwnerMutationKey,
} from './resourceOwnerMutationKeys'
import { lorebookPageIndexFromSnapshot, lorebookPageOwner } from './lorebookPageOwner.svelte'

type GlobalLorebook = { id?: string; name: string; data: loreBook[] }

export interface LorebookStateSnapshot {
  scopeKey?: string
  scopedValue?: unknown
  loreBook: GlobalLorebook[]
  loreBookPage: number
  characters: character[]
  modules: RisuModule[]
  selectedCharID: number
}

export interface LorebookEntryStateSnapshot {
  kind: 'entry'
  scopeKey: string
  entryId?: string
  index: number
  previousEntry: loreBook | null
  selectedCharID: number
}

type LorebookReplacementSnapshot = LorebookStateSnapshot | LorebookEntryStateSnapshot
type LorebookReplacementSource = 'collection' | 'entry' | 'fullCollection'

type LorebookProjectionEpochs =
  | { kind: 'global'; collectionEpoch: number }
  | { kind: 'character'; characterId: string; rowEpoch: number; lorebookEpoch: number }
  | { kind: 'chat'; chatId: string; characterId: string | null; rowEpoch: number | null }
  | { kind: 'module'; moduleId: string; collectionEpoch: number }

interface PendingCollectionReplacement {
  sessionGeneration: number
  key: string
  previous: LorebookReplacementSnapshot
  attemptedEntries: loreBook[]
  source: LorebookReplacementSource
  projectionEpochs: LorebookProjectionEpochs
  timer: ReturnType<typeof setTimeout> | null
  intent: DurableMutationIntent
  outbox: PendingMutationHandle
  settlementCleanup?: () => void
  operations: PendingScopedLorebookMutationOperation[]
  identityDirtyGeneration?: number
  command: (options?: ServerCommandTransportOptions) => Promise<ServerCommandResult<Record<string, unknown>>>
}

interface PendingLorebookEntryAttempt {
  sequence: number
  scopeKey: string
  entryId: string
  previous: LorebookEntryStateSnapshot
  attemptedEntry: loreBook
}

const pendingReplacements = new Map<string, PendingCollectionReplacement>()
const identityDirtyLorebookScopes = new Map<string, number>()
let nextIdentityDirtyGeneration = 0
const pendingLorebookEntryAttempts: PendingLorebookEntryAttempt[] = []
const pendingGlobalLorebookDeleteProjections = new Map<string, PendingGlobalLorebookDeleteProjection>()
const globalLorebookDeleteStates = new Map<string, GlobalLorebookDeleteState>()
const globalLorebookDeleteStateListeners = new Set<(states: readonly GlobalLorebookDeleteState[]) => void>()

// Temporary compatibility replica for the legacy plugin/database surface.
// Owner consumers never read this projection.
lorebookPageOwner.subscribe((snapshot) => {
  const index = lorebookPageIndexFromSnapshot(snapshot)
  if (index === null || settingsResourceState.value.loreBookPage === index) return
  mutateLorebookOwner(() => {
    settingsResourceState.value.loreBookPage = index
  })
})
let nextLorebookEntryAttemptSequence = 0

function settledScopedLorebookMutationOperation(
  scopeKey: string,
  settlement: ScopedLorebookMutationSettlement,
): ScopedLorebookMutationOperation {
  return { scopeKey, settlement: Promise.resolve(settlement) }
}

function pendingScopedLorebookMutationOperation(scopeKey: string): PendingScopedLorebookMutationOperation {
  let resolve!: (settlement: ScopedLorebookMutationSettlement) => void
  let settled = false
  const settlement = new Promise<ScopedLorebookMutationSettlement>((resolvePromise) => {
    resolve = resolvePromise
  })
  return {
    scopeKey,
    settlement,
    settle: (result) => {
      if (settled) return
      settled = true
      resolve(result)
    },
  }
}

function settleScopedLorebookMutationOperations(
  operations: readonly PendingScopedLorebookMutationOperation[],
  settlement: ScopedLorebookMutationSettlement,
): void {
  for (const operation of operations) operation.settle(settlement)
}

export type GlobalLorebookDeleteOutcome = 'accepted' | 'queued' | 'failed'
export type GlobalLorebookDeleteUiStatus = 'deleting' | 'queued' | 'failed'

export type ScopedLorebookMutationSettlement =
  | { status: 'accepted' }
  | { status: 'queued' }
  | { status: 'failed'; error: string }

export interface ScopedLorebookMutationOperation {
  scopeKey: string
  settlement: Promise<ScopedLorebookMutationSettlement>
}

interface PendingScopedLorebookMutationOperation extends ScopedLorebookMutationOperation {
  settle: (settlement: ScopedLorebookMutationSettlement) => void
}

export interface GlobalLorebookDeleteState {
  lorebookId: string
  mutationId: string
  status: GlobalLorebookDeleteUiStatus
}

interface PendingGlobalLorebookDeleteProjection {
  lorebookId: string
  outbox: PendingMutationHandle
  settled: boolean
  finalSettlement?: 'accepted' | 'discarded'
  settlementCleanup?: () => void
}

export function getGlobalLorebookDeleteState(lorebookId: string): GlobalLorebookDeleteState | null {
  const state = globalLorebookDeleteStates.get(lorebookId)
  return state ? { ...state } : null
}

export function subscribeGlobalLorebookDeleteStates(
  listener: (states: readonly GlobalLorebookDeleteState[]) => void,
): () => void {
  globalLorebookDeleteStateListeners.add(listener)
  listener(snapshotGlobalLorebookDeleteStates())
  return () => globalLorebookDeleteStateListeners.delete(listener)
}

function snapshotGlobalLorebookDeleteStates(): GlobalLorebookDeleteState[] {
  return [...globalLorebookDeleteStates.values()].map((state) => ({ ...state }))
}

function publishGlobalLorebookDeleteStates(): void {
  const states = snapshotGlobalLorebookDeleteStates()
  for (const listener of globalLorebookDeleteStateListeners) {
    try {
      listener(states)
    } catch (error) {
      console.error('Global lorebook delete state listener rejected:', error)
    }
  }
}

function setGlobalLorebookDeleteState(
  pending: PendingGlobalLorebookDeleteProjection,
  status: GlobalLorebookDeleteUiStatus,
  replaceFailed = false,
): void {
  const current = globalLorebookDeleteStates.get(pending.lorebookId)
  if (current && current.mutationId !== pending.outbox.mutationId && !(replaceFailed && current.status === 'failed'))
    return
  globalLorebookDeleteStates.set(pending.lorebookId, {
    lorebookId: pending.lorebookId,
    mutationId: pending.outbox.mutationId,
    status,
  })
  publishGlobalLorebookDeleteStates()
}

function clearGlobalLorebookDeleteState(pending: PendingGlobalLorebookDeleteProjection): void {
  if (globalLorebookDeleteStates.get(pending.lorebookId)?.mutationId !== pending.outbox.mutationId) return
  globalLorebookDeleteStates.delete(pending.lorebookId)
  publishGlobalLorebookDeleteStates()
}

// No-data-loss guard for character `globalLore` stubs. `checkNewFormat` defaults
// absent character lore to `[]`, so field presence cannot distinguish a stub from
// an empty hydrated lorebook. Explicit owner mutations only persist ids in this
// registry; re-stubbed characters remain blocked until hydrated again.
const hydratedCharacterLorebooks = new SvelteSet<string>()
// Characters whose latest raw projection omitted `globalLore`. Keep this
// separate from the current setting: turning stub mode off does not
// retroactively replace stubs that are already resident in the client.
const stubbedCharacterLorebooks = new SvelteSet<string>()

export function resetLorebookOwnerForTests(): void {
  for (const pending of pendingReplacements.values()) {
    if (pending.timer) clearTimeout(pending.timer)
    pending.settlementCleanup?.()
    settleScopedLorebookMutationOperations(pending.operations, {
      status: 'failed',
      error: 'Lorebook mutation was cancelled.',
    })
    void acknowledgePendingMutation(pending.outbox)
  }
  pendingReplacements.clear()
  identityDirtyLorebookScopes.clear()
  nextIdentityDirtyGeneration = 0
  pendingLorebookEntryAttempts.length = 0
  for (const pending of pendingGlobalLorebookDeleteProjections.values()) {
    pending.settled = true
    pending.settlementCleanup?.()
  }
  pendingGlobalLorebookDeleteProjections.clear()
  if (globalLorebookDeleteStates.size > 0) {
    globalLorebookDeleteStates.clear()
    publishGlobalLorebookDeleteStates()
  }
  nextLorebookEntryAttemptSequence = 0
  lorebookEntryDraftRollbackListeners.clear()
}

/** Mark a character's `globalLore` as hydrated (real, persistable). */
export function markCharacterLorebookHydrated(characterId: string): void {
  if (!characterId) return
  hydratedCharacterLorebooks.add(characterId)
  stubbedCharacterLorebooks.delete(characterId)
}

/** Record an authoritative character projection after it was actually applied. */
export function recordCanonicalCharacterLorebookScopes(
  characters:
    | ReadonlyArray<{
        chaId?: string
        globalLore?: unknown
        chats?: ReadonlyArray<{ id?: string }>
      }>
    | undefined,
): void {
  for (const character of characters ?? []) {
    if (typeof character.chaId === 'string' && character.chaId.trim() && Array.isArray(character.globalLore)) {
      identityDirtyLorebookScopes.delete(`character:${character.chaId}`)
    }
    for (const chat of character.chats ?? []) {
      if (typeof chat.id === 'string' && chat.id.trim()) {
        identityDirtyLorebookScopes.delete(`chat:${chat.id}`)
      }
    }
  }
}

/** Record authoritative whole-collection projections after they were applied. */
export function recordCanonicalLorebookCollections(names: readonly ServerCollectionName[]): void {
  if (names.includes('loreBook')) clearIdentityDirtyLorebookScopesWithPrefix('global:')
  if (names.includes('modules')) clearIdentityDirtyLorebookScopesWithPrefix('module:')
}

function clearIdentityDirtyLorebookScopesWithPrefix(prefix: string): void {
  for (const key of identityDirtyLorebookScopes.keys()) {
    if (key.startsWith(prefix)) identityDirtyLorebookScopes.delete(key)
  }
}

/** Whether a character's `globalLore` is hydrated (not a stub). */
export function isCharacterLorebookHydrated(characterId: string): boolean {
  return hydratedCharacterLorebooks.has(characterId)
}

/**
 * Whether it is safe to mutate a character's `globalLore`. Stub mode represents
 * missing server data as `[]`, so writes must wait until that character has a
 * real hydrated collection.
 */
export function isCharacterLorebookMutationReady(characterId: string): boolean {
  if (hydratedCharacterLorebooks.has(characterId)) return true
  if (stubbedCharacterLorebooks.has(characterId)) return false
  // Unknown rows are treated conservatively while stub mode is active. Rows
  // created locally are registered by the character command owner.
  return !settingsResourceState.value.enableLorebookStubs
}

/**
 * Forget all hydrated-character marks before a full projection re-apply or
 * `characters` merge re-stubs every character, so each re-stubbed character stays
 * non-hydrated until it is fetched again.
 */
export function resetLorebookHydration(): void {
  hydratedCharacterLorebooks.clear()
  stubbedCharacterLorebooks.clear()
}

/**
 * Record which characters arrive with a REAL (resident) `globalLore` in a raw
 * projection — read from the projection bytes BEFORE `checkNewFormat` can default an
 * absent value to `[]`. The bootstrap ships the selected character's `globalLore`
 * resident; everything else is a stub (absent) and stays non-hydrated until opened.
 */
export function recordHydratedCharacterLorebooks(
  characters: ReadonlyArray<{ chaId?: string; globalLore?: unknown }> | undefined,
): void {
  for (const character of characters ?? []) {
    if (!character?.chaId) continue
    if (Array.isArray(character.globalLore)) markCharacterLorebookHydrated(character.chaId)
    else {
      hydratedCharacterLorebooks.delete(character.chaId)
      stubbedCharacterLorebooks.add(character.chaId)
    }
  }
}

export function currentLorebookStateSnapshot(): LorebookStateSnapshot {
  return {
    loreBook: cloneJsonValue((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]),
    loreBookPage: settingsResourceState.value.loreBookPage ?? 0,
    characters: cloneJsonValue(charactersResourceState.characters ?? []),
    modules: cloneJsonValue((collectionsResourceState.values.modules ?? []) as RisuModule[]),
    selectedCharID: get(selectedCharID),
  }
}

export function restoreLorebookState(snapshot: LorebookStateSnapshot): void {
  if (snapshot.scopeKey) {
    restoreScopedLorebookState(snapshot)
    return
  }

  mutateLorebookOwner(() => {
    collectionsResourceState.values.loreBook = cloneJsonValue(snapshot.loreBook) as Database['loreBook']
    projectGlobalLorebookPage(snapshot.loreBookPage)
    charactersResourceState.characters = cloneJsonValue(snapshot.characters)
    collectionsResourceState.values.modules = cloneJsonValue(snapshot.modules) as Database['modules']
    selectedCharID.set(snapshot.selectedCharID)
  })
}

// Narrow global-lorebook rollback. Global-lorebook select/create/delete only
// touch `loreBook` and `loreBookPage`, so the snapshot omits the whole
// `characters` and `modules` collections that the heavy `LorebookStateSnapshot`
// clones. The full snapshot stays for paths that can mutate character/module
// lore alongside the global list.
export interface GlobalLorebookStateSnapshot {
  loreBook: GlobalLorebook[]
  loreBookPage: number
  selectedCharID: number
}

type GlobalLorebookListRollbackEntry = {
  key: string
  previous: GlobalLorebook | null
  attempted: GlobalLorebook | null
  previousIndex?: number
}

type GlobalLorebookNameRollback = {
  lorebookId: string
  previous: Partial<Pick<GlobalLorebook, 'name'>>
  attempted: Pick<GlobalLorebook, 'name'>
}

type GlobalLorebookOrderRollback = {
  previousIds: string[]
  attemptedIds: string[]
}

type GlobalLorebookSelectionRollback = {
  previousPage: number
  previousLorebookId: string | null
  attemptedPage: number
  attemptedLorebookId: string | null
}

export function currentGlobalLorebookStateSnapshot(): GlobalLorebookStateSnapshot {
  return {
    loreBook: cloneJsonValue((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]),
    loreBookPage: settingsResourceState.value.loreBookPage ?? 0,
    selectedCharID: get(selectedCharID),
  }
}

export function restoreGlobalLorebookState(snapshot: GlobalLorebookStateSnapshot): void {
  mutateLorebookOwner(() => {
    collectionsResourceState.values.loreBook = cloneJsonValue(snapshot.loreBook) as Database['loreBook']
    projectGlobalLorebookPage(snapshot.loreBookPage)
  })
}

/**
 * Give every lorebook row a stable, collection-unique client id.
 *
 * Returns whether any row changed so server-backed callers can remember that
 * their resident projection no longer has the same identities as the server.
 */
export function normalizeClientLorebookEntryIds(entries: loreBook[]): boolean {
  const seen = new Set<string>()
  let changed = false
  for (const entry of entries ?? []) {
    // Only write when an id is missing or repeats an earlier row so callers
    // that already hold canonical owner rows do not create needless updates.
    let id = typeof entry.id === 'string' && entry.id.trim() ? entry.id : ''
    if (!id || seen.has(id)) {
      do {
        id = v4()
      } while (seen.has(id))
      entry.id = id
      changed = true
    }
    seen.add(id)
  }
  return changed
}

export function ensureClientLorebookEntryIds(entries: loreBook[]): loreBook[] {
  normalizeClientLorebookEntryIds(entries)
  return entries
}

function lorebookEntryIdsNeedNormalization(entries: loreBook[] | undefined): boolean {
  const seen = new Set<string>()
  for (const entry of entries ?? []) {
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id : ''
    if (!id || seen.has(id)) return true
    seen.add(id)
  }
  return false
}

// Shared by the complete-owner ensure above and the global-list-only ensure below.
// Re-read the collection owner so assignments always target the canonical rows.
function assignGlobalLorebookListIds(): void {
  for (const lorebook of (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]) {
    const hadStableBookId = typeof lorebook.id === 'string' && lorebook.id.trim()
    if (typeof lorebook.id !== 'string' || !lorebook.id.trim()) {
      lorebook.id = v4()
    }
    if (!Array.isArray(lorebook.data)) {
      lorebook.data = []
    } else {
      const changed = normalizeClientLorebookEntryIds(lorebook.data)
      if (changed && hadStableBookId) {
        markLorebookIdentityDirty({ kind: 'global', lorebookId: lorebook.id as string })
      }
    }
  }
}

/** Assign ids on the global lorebook list only (book ids + entry ids). */
export function ensureGlobalLorebookListIds(): void {
  if (!globalLorebookListIdsNeedNormalization()) return

  mutateLorebookOwner(() => {
    assignGlobalLorebookListIds()
  })
}

export function globalLorebookListIdsNeedNormalization(): boolean {
  return ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).some(
    (lorebook) =>
      typeof lorebook.id !== 'string' ||
      !lorebook.id.trim() ||
      !Array.isArray(lorebook.data) ||
      lorebookEntryIdsNeedNormalization(lorebook.data),
  )
}

/**
 * Scoped pre-edit rollback for a DISCRETE editor action on ONE collection:
 * a global lorebook's entries, a character's globalLore, or a chat's localLore.
 * Builds the `scopeKey`+`scopedValue` rollback used by explicit owner mutations,
 * so a failed command restores only the edited collection — without the whole-DB id-assign
 * write older broad snapshots used to perform and without cloning the
 * characters+modules graph. Ids are ensured on the edited collection only. The
 * broad snapshot stays for the genuine multi-collection callers (module apply,
 * MCP edits).
 */
export type DiscreteLorebookEditScope =
  | { kind: 'character'; characterId: string }
  | { kind: 'chat'; chatId: string }
  | { kind: 'global'; lorebookId: string }
  | { kind: 'module'; moduleId: string }

export function currentLorebookCollectionScopedSnapshot(scope: DiscreteLorebookEditScope): LorebookStateSnapshot {
  ensureScopedClientLorebookIds(scope)
  switch (scope.kind) {
    case 'character': {
      const character = getCharacterResourceOwner(scope.characterId)
      return scopedLorebookStateSnapshot(`character:${scope.characterId}`, snapshotJson(character?.globalLore ?? []))
    }
    case 'chat': {
      const chat = findChat(scope.chatId)
      return scopedLorebookStateSnapshot(`chat:${scope.chatId}`, snapshotJson(chat?.localLore ?? []))
    }
    case 'global': {
      const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).find(
        (candidate) => candidate.id === scope.lorebookId,
      )
      return scopedLorebookStateSnapshot(`global:${scope.lorebookId}`, snapshotJson(lorebook?.data ?? []))
    }
    case 'module': {
      const module = findModule(scope.moduleId)
      return scopedLorebookStateSnapshot(`module:${scope.moduleId}`, snapshotJson(module?.lorebook ?? []))
    }
  }
}

export function currentLorebookEntryScopedSnapshot(
  scope: DiscreteLorebookEditScope,
  index: number,
): LorebookEntryStateSnapshot {
  ensureScopedClientLorebookEntryId(scope, index)
  const target = resolveLorebookCollection(scope)
  const entry = target?.entries[index] ?? null
  return {
    kind: 'entry',
    scopeKey: lorebookCollectionScopeKey(scope),
    entryId: entry?.id,
    index,
    previousEntry: entry ? cloneJsonValue(entry) : null,
    selectedCharID: get(selectedCharID),
  }
}

function entryDraftRollbackSnapshot(
  scope: DiscreteLorebookEditScope,
  existing: PendingCollectionReplacement | undefined,
  index: number,
): LorebookReplacementSnapshot {
  if (!existing || hasLorebookProjectionEpochChanged(existing.projectionEpochs)) {
    return currentLorebookEntryScopedSnapshot(scope, index)
  }
  if (existing.source === 'collection' || !isLorebookEntryStateSnapshot(existing.previous)) {
    return existing.previous
  }
  if (existing.previous.index === index) {
    return existing.previous
  }
  return promoteEntryRollbackToCollectionSnapshot(scope, existing.previous)
}

function promoteEntryRollbackToCollectionSnapshot(
  scope: DiscreteLorebookEditScope,
  entrySnapshot: LorebookEntryStateSnapshot,
): LorebookStateSnapshot {
  const collectionSnapshot = currentLorebookCollectionScopedSnapshot(scope)
  if (!Array.isArray(collectionSnapshot.scopedValue)) return collectionSnapshot

  const entries = collectionSnapshot.scopedValue as loreBook[]
  const index =
    entrySnapshot.entryId && entrySnapshot.entryId.trim()
      ? entries.findIndex((entry) => entry.id === entrySnapshot.entryId)
      : -1
  const restoreIndex = index >= 0 ? index : entrySnapshot.index

  if (!entrySnapshot.previousEntry) {
    if (restoreIndex >= 0 && restoreIndex < entries.length) {
      entries.splice(restoreIndex, 1)
    }
    return collectionSnapshot
  }

  const previous = cloneJsonValue(entrySnapshot.previousEntry)
  const current = entries[restoreIndex]
  if (current) {
    replaceLorebookEntryInPlace(current, previous)
  } else {
    entries.splice(Math.max(0, Math.min(restoreIndex, entries.length)), 0, previous)
  }
  return collectionSnapshot
}

export function applyLorebookEntryDraftEdit(
  scope: DiscreteLorebookEditScope,
  index: number,
  value: loreBook,
  delayMs = 250,
): boolean {
  if (!canUseClientWriteAccess()) return false
  if (scope.kind === 'character' && !isCharacterLorebookMutationReady(scope.characterId)) {
    return false
  }

  const key = lorebookCollectionScopeKey(scope)
  const existing = pendingReplacements.get(key)
  const previous = entryDraftRollbackSnapshot(scope, existing, index)

  let entries: loreBook[] | null = null
  mutateLorebookOwner(() => {
    const target = resolveLorebookCollection(scope)
    if (!target) return
    entries = target.entries
    const current = target.entries[index]
    const next = cloneJsonValue(value)
    // Entry editor drafts can be latched before lazy identity normalization.
    // Keep the resident row's freshly repaired identity rather than copying a
    // stale missing/duplicate id back over it with the edited fields.
    if (current?.id && next.id !== current.id) {
      next.id = current.id
    }
    if (current) {
      replaceLorebookEntryInPlace(current, next)
    } else {
      target.entries[index] = next
    }
  })

  if (!entries) return false
  if (!canUseServerCommands()) return true
  queueScopedLorebookReplacement(scope, entries, previous, delayMs, 'entry')
  return true
}

export function flushPendingLorebookEntryDraftEdit(
  scope: DiscreteLorebookEditScope,
  options: ServerCommandTransportOptions = {},
): void {
  const key = lorebookCollectionScopeKey(scope)
  runPendingReplacement(key, options)
}

export function replaceCharacterLorebookCollection(characterId: string, entries: loreBook[], delayMs = 250): boolean {
  return replaceCharacterLorebookCollectionWithOutcome(characterId, entries, delayMs) !== null
}

export function replaceCharacterLorebookCollectionWithOutcome(
  characterId: string,
  entries: loreBook[],
  delayMs = 250,
): ScopedLorebookMutationOperation | null {
  if (!characterId || !isCharacterLorebookMutationReady(characterId)) return null
  return replaceLorebookCollectionWithOutcome({ kind: 'character', characterId }, entries, delayMs)
}

export function replaceCharacterLorebookCollectionFull(
  characterId: string,
  entries: loreBook[],
  delayMs = 250,
): boolean {
  if (!characterId || !isCharacterLorebookMutationReady(characterId)) return false
  return replaceLorebookCollection({ kind: 'character', characterId }, entries, delayMs, 'fullCollection')
}

export function replaceChatLorebookCollection(chatId: string, entries: loreBook[], delayMs = 250): boolean {
  return replaceChatLorebookCollectionWithOutcome(chatId, entries, delayMs) !== null
}

export function replaceChatLorebookCollectionWithOutcome(
  chatId: string,
  entries: loreBook[],
  delayMs = 250,
): ScopedLorebookMutationOperation | null {
  if (!chatId) return null
  return replaceLorebookCollectionWithOutcome({ kind: 'chat', chatId }, entries, delayMs)
}

function getCurrentChatFromResources(): Chat | undefined {
  const selectedIndex =
    charactersResourceState.selectionRevision !== null ? charactersResourceState.currentChar : get(selectedCharID)
  const character = charactersResourceState.characters[selectedIndex]
  return character?.chats?.[character.chatPage ?? 0]
}

export function applyServerCharacterLorebookResource(characterId: string, globalLore: unknown[]): boolean {
  const applied = mutateLorebookOwner(() => {
    const character = getCharacterResourceOwner(characterId)
    if (!character) return false
    character.globalLore = globalLore as typeof character.globalLore
    return true
  })
  if (applied) identityDirtyLorebookScopes.delete(`character:${characterId}`)
  return applied
}

export function setActiveChatLorebookLocalActivation(book: loreBook, active: boolean, delayMs = 250): boolean {
  return setActiveChatLorebookLocalActivationWithOutcome(book, active, delayMs) !== null
}

export function setActiveChatLorebookLocalActivationWithOutcome(
  book: loreBook,
  active: boolean,
  delayMs = 250,
): ScopedLorebookMutationOperation | null {
  const chatId = getCurrentChatFromResources()?.id
  if (!chatId) return null
  return setChatLorebookLocalActivationWithOutcome(chatId, book, active, delayMs)
}

export function setChatLorebookLocalActivationWithOutcome(
  chatId: string,
  book: loreBook,
  active: boolean,
  delayMs = 250,
): ScopedLorebookMutationOperation | null {
  if (!canUseClientWriteAccess()) return null
  if (!chatId) return null
  const scope = { kind: 'chat', chatId } as const
  flushPendingLorebookEntryBeforeCollectionMutation(scope)
  const previous = currentLorebookCollectionScopedSnapshot(scope)

  let entries: loreBook[] | null = null
  const applied = mutateLorebookOwner(() => {
    const chat = findChat(chatId)
    if (!chat) return false

    if (!Array.isArray(chat.localLore)) {
      chat.localLore = []
    }

    if (active) {
      if (!book.id) {
        book.id = v4()
      }

      const childLore: loreBook = {
        key: '',
        comment: '',
        content: '',
        mode: 'child',
        insertorder: 100,
        alwaysActive: true,
        secondkey: '',
        selective: false,
        id: book.id,
      }
      chat.localLore.push(childLore)
    } else if (book.id) {
      const childLore = chat.localLore.find((entry) => entry.id === book.id)
      if (childLore) {
        chat.localLore = chat.localLore.filter((entry) => entry.id !== book.id)
      }
    }

    entries = cloneJsonValue(chat.localLore ?? [])
    return true
  })

  if (!applied || !entries) return null
  return dispatchReplaceChatLorebooksWithOutcome(chatId, entries, previous, delayMs)
}

export function replaceGlobalLorebookEntryCollection(lorebookId: string, entries: loreBook[], delayMs = 250): boolean {
  return replaceGlobalLorebookEntryCollectionWithOutcome(lorebookId, entries, delayMs) !== null
}

export function replaceGlobalLorebookEntryCollectionWithOutcome(
  lorebookId: string,
  entries: loreBook[],
  delayMs = 250,
): ScopedLorebookMutationOperation | null {
  if (!lorebookId) return null
  return replaceLorebookCollectionWithOutcome({ kind: 'global', lorebookId }, entries, delayMs)
}

export function replaceModuleLorebookCollectionDraft(
  moduleId: string | null | undefined,
  currentModule: RisuModule | null | undefined,
  entries: loreBook[],
  delayMs = 250,
): boolean {
  if (!canUseClientWriteAccess()) return false
  if (!moduleId) return false

  const scope = { kind: 'module', moduleId } as const
  flushPendingLorebookEntryBeforeCollectionMutation(scope)
  const previous = currentLorebookCollectionScopedSnapshot(scope)
  const hasLiveModule = Boolean(findModule(moduleId))
  const cloned = cloneJsonValue(entries ?? [])
  ensureClientLorebookEntryIds(cloned)
  const commandEntries = cloneJsonValue(cloned)

  const applied = mutateLorebookOwner(() => {
    const liveModule = findModule(moduleId)
    const draftModule = currentModule?.id === moduleId ? currentModule : null
    if (!liveModule && !draftModule) return false

    if (liveModule) liveModule.lorebook = cloned
    if (draftModule) draftModule.lorebook = cloned
    return true
  })
  if (!applied) return false

  if (hasLiveModule) dispatchReplaceModuleLorebooks(moduleId, commandEntries, previous, delayMs)
  return true
}

type ReplaceableLorebookCollectionScope =
  | { kind: 'character'; characterId: string }
  | { kind: 'chat'; chatId: string }
  | { kind: 'global'; lorebookId: string }

function replaceLorebookCollection(
  scope: ReplaceableLorebookCollectionScope,
  entries: loreBook[],
  delayMs: number,
  source: LorebookReplacementSource = 'collection',
): boolean {
  flushPendingLorebookEntryBeforeCollectionMutation(scope)
  const previous = currentLorebookCollectionScopedSnapshot(scope)
  const cloned = cloneJsonValue(entries ?? [])
  const applied = mutateLorebookOwner(() => assignLorebookCollection(scope, cloned))
  if (!applied) return false

  switch (scope.kind) {
    case 'character':
      dispatchReplaceCharacterLorebooks(scope.characterId, cloned, previous, delayMs, source)
      return true
    case 'chat':
      dispatchReplaceChatLorebooks(scope.chatId, cloned, previous, delayMs)
      return true
    case 'global':
      dispatchReplaceGlobalLorebookEntries(scope.lorebookId, cloned, previous, delayMs)
      return true
  }
}

function replaceLorebookCollectionWithOutcome(
  scope: ReplaceableLorebookCollectionScope,
  entries: loreBook[],
  delayMs: number,
  source: LorebookReplacementSource = 'collection',
): ScopedLorebookMutationOperation | null {
  if (!canUseClientWriteAccess()) return null
  flushPendingLorebookEntryBeforeCollectionMutation(scope)
  const previous = currentLorebookCollectionScopedSnapshot(scope)
  const cloned = cloneJsonValue(entries ?? [])
  const applied = mutateLorebookOwner(() => assignLorebookCollection(scope, cloned))
  if (!applied) return null

  switch (scope.kind) {
    case 'character':
      return dispatchReplaceCharacterLorebooksWithOutcome(scope.characterId, cloned, previous, delayMs, source)
    case 'chat':
      return dispatchReplaceChatLorebooksWithOutcome(scope.chatId, cloned, previous, delayMs, source)
    case 'global':
      return dispatchReplaceGlobalLorebookEntriesWithOutcome(scope.lorebookId, cloned, previous, delayMs, source)
  }
}

function flushPendingLorebookEntryBeforeCollectionMutation(scope: DiscreteLorebookEditScope): void {
  const key = lorebookCollectionScopeKey(scope)
  if (pendingReplacements.get(key)?.source === 'entry') {
    runPendingReplacement(key)
  }
}

function assignLorebookCollection(scope: ReplaceableLorebookCollectionScope, entries: loreBook[]): boolean {
  switch (scope.kind) {
    case 'character': {
      const character = getCharacterResourceOwner(scope.characterId)
      if (!character) return false
      character.globalLore = entries
      return true
    }
    case 'chat': {
      const chat = findChat(scope.chatId)
      if (!chat) return false
      chat.localLore = entries
      return true
    }
    case 'global': {
      const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).find(
        (candidate) => candidate.id === scope.lorebookId,
      )
      if (!lorebook) return false
      lorebook.data = entries
      return true
    }
  }
}

// Assign missing ids on the edited collection only. Re-read the target inside
// the owner mutation so the current canonical row is always updated.
function ensureScopedClientLorebookIds(scope: DiscreteLorebookEditScope): void {
  if (!scopedClientLorebookIdsNeedNormalization(scope)) return

  let changed = false
  mutateLorebookOwner(() => {
    switch (scope.kind) {
      case 'character': {
        const character = getCharacterResourceOwner(scope.characterId)
        // Mirror the whole-DB ensure's no-data-loss guard: only touch a HYDRATED
        // character's globalLore — assigning ids to a stubbed one would default
        // its absent globalLore to `[]` and mask the stub.
        if (character?.chaId && hydratedCharacterLorebooks.has(character.chaId)) {
          if (!Array.isArray(character.globalLore)) {
            character.globalLore = []
          } else {
            changed = normalizeClientLorebookEntryIds(character.globalLore)
          }
        }
        return
      }
      case 'chat': {
        const chat = findChat(scope.chatId)
        if (chat) {
          if (!Array.isArray(chat.localLore)) {
            chat.localLore = []
          } else {
            changed = normalizeClientLorebookEntryIds(chat.localLore)
          }
        }
        return
      }
      case 'global': {
        const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).find(
          (candidate) => candidate.id === scope.lorebookId,
        )
        if (lorebook) {
          if (!Array.isArray(lorebook.data)) {
            lorebook.data = []
          } else {
            changed = normalizeClientLorebookEntryIds(lorebook.data)
          }
        }
        return
      }
      case 'module': {
        const module = findModule(scope.moduleId)
        if (module && Array.isArray(module.lorebook)) {
          changed = normalizeClientLorebookEntryIds(module.lorebook)
        }
        return
      }
    }
  })
  if (changed) markLorebookIdentityDirty(scope)
}

function scopedClientLorebookIdsNeedNormalization(scope: DiscreteLorebookEditScope): boolean {
  switch (scope.kind) {
    case 'character': {
      const character = getCharacterResourceOwner(scope.characterId)
      return !!(
        character?.chaId &&
        hydratedCharacterLorebooks.has(character.chaId) &&
        (!Array.isArray(character.globalLore) || lorebookEntryIdsNeedNormalization(character.globalLore))
      )
    }
    case 'chat': {
      const chat = findChat(scope.chatId)
      return !!chat && (!Array.isArray(chat.localLore) || lorebookEntryIdsNeedNormalization(chat.localLore))
    }
    case 'global': {
      const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).find(
        (candidate) => candidate.id === scope.lorebookId,
      )
      return !!lorebook && (!Array.isArray(lorebook.data) || lorebookEntryIdsNeedNormalization(lorebook.data))
    }
    case 'module': {
      const module = findModule(scope.moduleId)
      return !!(module && Array.isArray(module.lorebook) && lorebookEntryIdsNeedNormalization(module.lorebook))
    }
  }
}

function ensureScopedClientLorebookEntryId(scope: DiscreteLorebookEditScope, index: number): void {
  let changed = false
  mutateLorebookOwner(() => {
    if (
      scope.kind === 'character' &&
      settingsResourceState.value.enableLorebookStubs &&
      !hydratedCharacterLorebooks.has(scope.characterId)
    ) {
      return
    }
    const entries = resolveLorebookCollection(scope)?.entries
    if (!entries?.[index]) return
    changed = normalizeClientLorebookEntryIds(entries)
  })
  if (changed) markLorebookIdentityDirty(scope)
}

function markLorebookIdentityDirty(scope: DiscreteLorebookEditScope): number {
  const generation = ++nextIdentityDirtyGeneration
  identityDirtyLorebookScopes.set(lorebookCollectionScopeKey(scope), generation)
  return generation
}

function lorebookCollectionScopeKey(scope: DiscreteLorebookEditScope): string {
  switch (scope.kind) {
    case 'character':
      return `character:${scope.characterId}`
    case 'chat':
      return `chat:${scope.chatId}`
    case 'global':
      return `global:${scope.lorebookId}`
    case 'module':
      return `module:${scope.moduleId}`
  }
}

function resolveLorebookCollection(scope: DiscreteLorebookEditScope): { entries: loreBook[] } | null {
  switch (scope.kind) {
    case 'character': {
      const character = getCharacterResourceOwner(scope.characterId)
      return character ? { entries: character.globalLore ?? [] } : null
    }
    case 'chat': {
      const chat = findChat(scope.chatId)
      return chat ? { entries: chat.localLore ?? [] } : null
    }
    case 'global': {
      const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).find(
        (candidate) => candidate.id === scope.lorebookId,
      )
      return lorebook ? { entries: lorebook.data ?? [] } : null
    }
    case 'module': {
      const module = findModule(scope.moduleId)
      return module && Array.isArray(module.lorebook) ? { entries: module.lorebook } : null
    }
  }
}

function replaceLorebookEntryInPlace(target: loreBook, next: loreBook): void {
  const writableTarget = target as unknown as Record<string, unknown>
  const writableNext = next as unknown as Record<string, unknown>
  for (const key of Object.keys(writableTarget)) {
    if (!(key in writableNext)) delete writableTarget[key]
  }
  Object.assign(writableTarget, writableNext)
}

export function createGlobalLorebook(): boolean {
  if (!canUseClientWriteAccess()) return false
  const previous = currentGlobalLorebookStateSnapshot()
  const lorebook: GlobalLorebook = {
    id: v4(),
    name: 'New LoreBook',
    data: [],
  }

  mutateLorebookOwner(() => {
    const loreBooks = (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]
    loreBooks.push(lorebook)
    collectionsResourceState.values.loreBook = loreBooks as Database['loreBook']
    dispatchCreateGlobalLorebook(lorebook, previous)
  })

  return true
}

export function renameGlobalLorebook(index: number, name: string): boolean {
  if (!canUseClientWriteAccess()) return false
  const current = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[])[index]
  if (!current) return false
  const lorebookId = stableGlobalLorebookId(current.id)
  const previous = lorebookId
    ? scopedLorebookStateSnapshot(`globalMeta:${lorebookId}`, snapshotJson({ name: current.name }))
    : null

  mutateLorebookOwner(() => {
    const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[])[index]
    if (lorebook) lorebook.name = name
  })

  if (lorebookId && previous) {
    dispatchUpdateGlobalLorebook(lorebookId, { name }, previous)
  }

  return true
}

export function renameGlobalLorebookById(lorebookId: string, name: string): boolean {
  if (!canUseClientWriteAccess()) return false
  const index = uniqueGlobalLorebookIndexById(lorebookId)
  return index >= 0 ? renameGlobalLorebook(index, name) : false
}

interface StartedGlobalLorebookDelete {
  deleted: boolean
  outcome: Promise<GlobalLorebookDeleteOutcome> | null
}

function startGlobalLorebookDelete(index: number): StartedGlobalLorebookDelete {
  const loreBooks = (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]
  if (loreBooks.length <= 1 || !loreBooks[index]) return { deleted: false, outcome: null }

  const lorebookId = loreBooks[index]?.id
  if (lorebookId) {
    flushPendingLorebookEntryDraftEdit({ kind: 'global', lorebookId })
  }
  const previous = currentGlobalLorebookStateSnapshot()
  const stagedDelete = lorebookId && canUseServerCommands() ? stageGlobalLorebookDeleteMutation(lorebookId) : null
  const deleted = mutateLorebookOwner(() => {
    const current = (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]
    if (current.length <= 1 || !current[index]) return false
    current.splice(index, 1)
    projectGlobalLorebookPage(0)
    collectionsResourceState.values.loreBook = current as Database['loreBook']
    return true
  })
  let outcome: Promise<GlobalLorebookDeleteOutcome> | null = null
  if (stagedDelete && lorebookId) {
    if (deleted) outcome = dispatchStagedGlobalLorebookDelete(lorebookId, previous, stagedDelete)
    else void acknowledgePendingMutation(stagedDelete.outbox)
  } else if (deleted) {
    outcome = Promise.resolve('accepted')
  }

  return { deleted, outcome }
}

export function deleteGlobalLorebook(index: number): boolean {
  if (!canUseClientWriteAccess()) return false
  return startGlobalLorebookDelete(index).deleted
}

export function deleteGlobalLorebookWithOutcome(index: number): Promise<GlobalLorebookDeleteOutcome> | null {
  if (!canUseClientWriteAccess()) return null
  const started = startGlobalLorebookDelete(index)
  return started.deleted ? started.outcome : null
}

export function deleteGlobalLorebookById(lorebookId: string): boolean {
  if (!canUseClientWriteAccess()) return false
  const index = uniqueGlobalLorebookIndexById(lorebookId)
  return index >= 0 ? deleteGlobalLorebook(index) : false
}

export function deleteGlobalLorebookByIdWithOutcome(lorebookId: string): Promise<GlobalLorebookDeleteOutcome> | null {
  if (!canUseClientWriteAccess()) return null
  const index = uniqueGlobalLorebookIndexById(lorebookId)
  return index >= 0 ? deleteGlobalLorebookWithOutcome(index) : null
}

// Global-lorebook list operations roll back only the attempted row/order/page
// state. The broad snapshot exports remain for direct callers, but command
// failures must not restore an old full list over newer sibling rows or
// selection changes.
export function dispatchCreateGlobalLorebook(lorebook: GlobalLorebook, previous: GlobalLorebookStateSnapshot): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
  lorebook.id = typeof lorebook.id === 'string' && lorebook.id.trim() ? lorebook.id : v4()
  lorebook.data = ensureClientLorebookEntryIds(lorebook.data ?? [])
  const attempted = cloneJsonValue(lorebook)
  const rollbackEntry: GlobalLorebookListRollbackEntry = {
    key: attempted.id as string,
    previous: null,
    attempted,
    previousIndex: previous.loreBook.length,
  }
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'POST',
        path: '/lorebooks',
        body: { lorebook: cloneJsonValue(attempted) },
      },
    ],
  }
  const outbox = stagePendingMutation(globalLorebookOwnerMutationKey(attempted.id as string), intent)
  void dispatchDurableMutation(outbox, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        createGlobalLorebookCommand({
          baseRevision,
          lorebook: cloneJsonValue(attempted) as GlobalLorebookSnapshot,
          acknowledgeOptimistic: true,
          optimisticCollectionEpoch: collectionProjectionEpoch,
        }),
      rollback: () => {
        if (!hasCollectionProjectionEpochChanged('loreBook', collectionProjectionEpoch)) {
          rollbackGlobalLorebookListEntry(rollbackEntry)
        }
      },
      ...transport,
    }),
  )
}

export function dispatchUpdateGlobalLorebook(
  lorebookId: string,
  patch: Pick<GlobalLorebook, 'name'>,
  previous: LorebookStateSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
  const attempted = cloneJsonValue(patch)
  const rollback = globalLorebookNameRollbackFromSnapshot(lorebookId, previous, attempted)
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [GLOBAL_LOREBOOK_SELECTION_MUTATION_KEY],
    requests: [
      {
        method: 'PATCH',
        path: `/lorebooks/${encodeURIComponent(lorebookId)}`,
        body: { patch: cloneJsonValue(attempted) },
      },
    ],
  }
  const outbox = stagePendingMutation(globalLorebookOwnerMutationKey(lorebookId), intent)
  void dispatchDurableMutation(outbox, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        updateGlobalLorebookCommand({
          baseRevision,
          lorebookId,
          patch: cloneJsonValue(attempted),
          acknowledgeOptimistic: true,
          optimisticCollectionEpoch: collectionProjectionEpoch,
        }),
      rollback: () => {
        if (!hasCollectionProjectionEpochChanged('loreBook', collectionProjectionEpoch)) {
          rollbackGlobalLorebookName(rollback)
        }
      },
      ...transport,
    }),
  )
}

export function dispatchDeleteGlobalLorebook(
  lorebookId: string,
  previous: GlobalLorebookStateSnapshot,
): Promise<GlobalLorebookDeleteOutcome> | null {
  if (!canUseClientWriteAccess()) return null
  if (!canUseServerCommands()) return null
  return dispatchStagedGlobalLorebookDelete(lorebookId, previous, stageGlobalLorebookDeleteMutation(lorebookId))
}

function stageGlobalLorebookDeleteMutation(lorebookId: string): {
  intent: DurableMutationIntent
  outbox: PendingMutationHandle
} {
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: [globalLorebookOwnerMutationKey(lorebookId)],
    requests: [
      {
        method: 'DELETE',
        path: `/lorebooks/${encodeURIComponent(lorebookId)}`,
        body: {},
      },
    ],
  }
  return {
    intent,
    outbox: stagePendingMutation(GLOBAL_LOREBOOK_SELECTION_MUTATION_KEY, intent),
  }
}

function dispatchStagedGlobalLorebookDelete(
  lorebookId: string,
  previous: GlobalLorebookStateSnapshot,
  staged: { intent: DurableMutationIntent; outbox: PendingMutationHandle },
): Promise<GlobalLorebookDeleteOutcome> {
  const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
  const pageProjectionEpoch = captureLorebookPageProjectionEpoch()
  const previousIndex = previous.loreBook.findIndex((lorebook) => lorebook.id === lorebookId)
  const previousLorebook = previousIndex >= 0 ? previous.loreBook[previousIndex] : null
  const rollbackEntry: GlobalLorebookListRollbackEntry | null = previousLorebook
    ? {
        key: lorebookId,
        previous: cloneJsonValue(previousLorebook),
        attempted: null,
        previousIndex,
      }
    : null
  const selectionRollback = globalLorebookSelectionRollbackFromSnapshot(previous)
  const pendingProjection = trackPendingGlobalLorebookDeleteProjection(lorebookId, staged.outbox)
  const dispatch = dispatchDurableMutation(staged.outbox, staged.intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        deleteGlobalLorebookCommand(
          {
            baseRevision,
            lorebookId,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: collectionProjectionEpoch,
            optimisticPageEpoch: pageProjectionEpoch,
          },
          transport.signal,
        ),
      rollback: () =>
        rollbackDeletedGlobalLorebook(rollbackEntry, selectionRollback, {
          restoreRow: !hasCollectionProjectionEpochChanged('loreBook', collectionProjectionEpoch),
          restoreSelection: !hasLorebookPageProjectionEpochChanged(pageProjectionEpoch),
        }),
      ...transport,
      // A retained delete remains crash-safe in the outbox, but keeping its
      // optimistic projection would strand the entire lorebook out of the UI
      // while the server still has it. Restore now and reapply the deletion if
      // replay is later accepted.
      failureRollbackDisposition: () => 'rollback',
    }),
  )
  return settleDispatchedGlobalLorebookDeleteProjection(pendingProjection, dispatch)
}

function trackPendingGlobalLorebookDeleteProjection(
  lorebookId: string,
  outbox: PendingMutationHandle,
): PendingGlobalLorebookDeleteProjection {
  const pending: PendingGlobalLorebookDeleteProjection = {
    lorebookId,
    outbox,
    settled: false,
  }
  pending.settlementCleanup = registerDurableMutationSettlementListener(outbox.mutationId, (settlement) => {
    settlePendingGlobalLorebookDeleteProjection(pending, settlement)
  })
  pendingGlobalLorebookDeleteProjections.set(outbox.mutationId, pending)
  setGlobalLorebookDeleteState(pending, 'deleting', true)
  return pending
}

async function settleDispatchedGlobalLorebookDeleteProjection(
  pending: PendingGlobalLorebookDeleteProjection,
  dispatch: Promise<ServerCommandResult>,
): Promise<GlobalLorebookDeleteOutcome> {
  try {
    const result = await dispatch
    if (result.status === 'ok') {
      settlePendingGlobalLorebookDeleteProjection(pending, 'accepted')
      return 'accepted'
    }
    if (pending.finalSettlement) return pending.finalSettlement === 'accepted' ? 'accepted' : 'failed'
    if (await isPendingMutationCurrent(pending.outbox)) {
      if (pending.finalSettlement) return pending.finalSettlement === 'accepted' ? 'accepted' : 'failed'
      setGlobalLorebookDeleteState(pending, 'queued')
      return 'queued'
    }
    settlePendingGlobalLorebookDeleteProjection(pending, 'discarded')
    return pending.finalSettlement === 'accepted' ? 'accepted' : 'failed'
  } catch (error) {
    if (pending.finalSettlement) return pending.finalSettlement === 'accepted' ? 'accepted' : 'failed'
    if (await isPendingMutationCurrent(pending.outbox)) {
      if (pending.finalSettlement) return pending.finalSettlement === 'accepted' ? 'accepted' : 'failed'
      setGlobalLorebookDeleteState(pending, 'queued')
      console.error('Global lorebook delete command rejected:', error)
      return 'queued'
    }
    settlePendingGlobalLorebookDeleteProjection(pending, 'discarded')
    console.error('Global lorebook delete command rejected:', error)
    return pending.finalSettlement === 'accepted' ? 'accepted' : 'failed'
  }
}

function settlePendingGlobalLorebookDeleteProjection(
  pending: PendingGlobalLorebookDeleteProjection,
  settlement: 'accepted' | 'discarded',
): void {
  if (pending.settled) return
  pending.settled = true
  pending.finalSettlement = settlement
  pending.settlementCleanup?.()
  pending.settlementCleanup = undefined
  if (pendingGlobalLorebookDeleteProjections.get(pending.outbox.mutationId) === pending) {
    pendingGlobalLorebookDeleteProjections.delete(pending.outbox.mutationId)
  }
  if (settlement === 'accepted') {
    clearGlobalLorebookDeleteState(pending)
    applyAcceptedGlobalLorebookDeleteProjection(pending.lorebookId)
  } else {
    setGlobalLorebookDeleteState(pending, 'failed')
  }
}

function applyAcceptedGlobalLorebookDeleteProjection(lorebookId: string): void {
  const selectedLorebookId = currentSelectedGlobalLorebookId()
  mutateLorebookOwner(() => {
    mutateLorebookOwner(() => {
      const lorebooks = mutableGlobalLorebookList()
      const index = lorebooks.findIndex((lorebook) => lorebook.id === lorebookId)
      if (index === -1) return
      lorebooks.splice(index, 1)
      collectionsResourceState.values.loreBook = lorebooks as Database['loreBook']
      if (selectedLorebookId && selectedLorebookId !== lorebookId) {
        restoreGlobalLorebookSelectionById(selectedLorebookId)
      } else {
        projectGlobalLorebookPage(0)
      }
    })
  })
}

export function dispatchReorderGlobalLorebooks(previous: LorebookStateSnapshot): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
  const pageProjectionEpoch = captureLorebookPageProjectionEpoch()
  const lorebookIds = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).map(
    (lorebook) => lorebook.id,
  )
  if (!hasStableUniqueCommandIds(lorebookIds)) return
  const previousIds = previous.loreBook.map((lorebook) => lorebook.id)
  if (!hasStableUniqueCommandIds(previousIds)) return
  const previousPage = previous.loreBookPage ?? 0
  const selectedLorebookId = stableGlobalLorebookId(previous.loreBook[previousPage]?.id)
  const selectedIndex = selectedLorebookId ? (lorebookIds as string[]).indexOf(selectedLorebookId) : -1
  const acknowledgeOptimistic = selectedLorebookId !== null && selectedIndex >= 0
  if (acknowledgeOptimistic) {
    mutateLorebookOwner(() => {
      mutateLorebookOwner(() => {
        projectGlobalLorebookPage(selectedIndex)
      })
    })
  }
  const rollback: GlobalLorebookOrderRollback = {
    previousIds: previousIds as string[],
    attemptedIds: lorebookIds as string[],
  }
  const selectionRollback = globalLorebookSelectionRollbackFromSnapshot(previous)
  const intent: DurableMutationIntent = {
    version: 1,
    dependencyKeys: (lorebookIds as string[]).map(globalLorebookOwnerMutationKey),
    requests: [
      {
        method: 'POST',
        path: '/lorebooks/reorder',
        body: { lorebookIds: cloneJsonValue(rollback.attemptedIds) },
      },
    ],
  }
  const outbox = stagePendingMutation(GLOBAL_LOREBOOK_SELECTION_MUTATION_KEY, intent)
  void dispatchDurableMutation(outbox, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        reorderGlobalLorebooksCommand({
          baseRevision,
          lorebookIds: cloneJsonValue(rollback.attemptedIds),
          acknowledgeOptimistic,
          optimisticCollectionEpoch: collectionProjectionEpoch,
          optimisticPageEpoch: pageProjectionEpoch,
          optimisticSelectedLorebookId: acknowledgeOptimistic ? selectedLorebookId : undefined,
        }),
      rollback: () => {
        if (!hasCollectionProjectionEpochChanged('loreBook', collectionProjectionEpoch)) {
          rollbackGlobalLorebookOrder(rollback)
        }
        if (!hasLorebookPageProjectionEpochChanged(pageProjectionEpoch)) {
          rollbackGlobalLorebookSelection(selectionRollback)
        }
      },
      ...transport,
    }),
  )
}

export function dispatchReplaceGlobalLorebookEntries(
  lorebookId: string,
  entries: loreBook[],
  previous: LorebookStateSnapshot,
  delayMs = 250,
  source: LorebookReplacementSource = 'collection',
): void {
  void dispatchReplaceGlobalLorebookEntriesWithOutcome(lorebookId, entries, previous, delayMs, source)
}

export function dispatchReplaceGlobalLorebookEntriesWithOutcome(
  lorebookId: string,
  entries: loreBook[],
  previous: LorebookStateSnapshot,
  delayMs = 250,
  source: LorebookReplacementSource = 'collection',
): ScopedLorebookMutationOperation {
  const scope = { kind: 'global', lorebookId } as const
  if (!canUseClientWriteAccess() || !canUseServerCommands()) {
    return settledScopedLorebookMutationOperation(lorebookCollectionScopeKey(scope), {
      status: 'failed',
      error: 'Server commands are unavailable.',
    })
  }
  if (source === 'collection' || source === 'fullCollection') ensureClientLorebookEntryIds(entries)
  return queueScopedLorebookReplacement(scope, entries, previous, delayMs, source, true)!
}

export function dispatchReplaceCharacterLorebooks(
  characterId: string,
  entries: loreBook[],
  previous: LorebookStateSnapshot,
  delayMs = 250,
  source: LorebookReplacementSource = 'collection',
): void {
  void dispatchReplaceCharacterLorebooksWithOutcome(characterId, entries, previous, delayMs, source)
}

export function dispatchReplaceCharacterLorebooksWithOutcome(
  characterId: string,
  entries: loreBook[],
  previous: LorebookStateSnapshot,
  delayMs = 250,
  source: LorebookReplacementSource = 'collection',
): ScopedLorebookMutationOperation {
  const scope = { kind: 'character', characterId } as const
  if (!canUseClientWriteAccess() || !canUseServerCommands()) {
    return settledScopedLorebookMutationOperation(lorebookCollectionScopeKey(scope), {
      status: 'failed',
      error: 'Server commands are unavailable.',
    })
  }
  // Defense in depth: when stubs are on, never persist a non-hydrated character's
  // globalLore. `entries` would be the stub `[]` and delete the real server
  // entries. A real selected-character edit is safe after hydration on open.
  if (!isCharacterLorebookMutationReady(characterId)) {
    return settledScopedLorebookMutationOperation(lorebookCollectionScopeKey(scope), {
      status: 'failed',
      error: 'Character lorebook data is not ready.',
    })
  }
  if (source === 'collection') ensureClientLorebookEntryIds(entries)
  return queueScopedLorebookReplacement(scope, entries, previous, delayMs, source, true)!
}

export function dispatchReplaceChatLorebooks(
  chatId: string,
  entries: loreBook[],
  previous: LorebookStateSnapshot,
  delayMs = 250,
  source: LorebookReplacementSource = 'collection',
): void {
  void dispatchReplaceChatLorebooksWithOutcome(chatId, entries, previous, delayMs, source)
}

export function dispatchReplaceChatLorebooksWithOutcome(
  chatId: string,
  entries: loreBook[],
  previous: LorebookStateSnapshot,
  delayMs = 250,
  source: LorebookReplacementSource = 'collection',
): ScopedLorebookMutationOperation {
  const scope = { kind: 'chat', chatId } as const
  if (!canUseClientWriteAccess() || !canUseServerCommands()) {
    return settledScopedLorebookMutationOperation(lorebookCollectionScopeKey(scope), {
      status: 'failed',
      error: 'Server commands are unavailable.',
    })
  }
  if (source === 'collection') ensureClientLorebookEntryIds(entries)
  return queueScopedLorebookReplacement(scope, entries, previous, delayMs, source, true)!
}

function queueScopedLorebookReplacement(
  scope: DiscreteLorebookEditScope,
  entries: loreBook[],
  previous: LorebookReplacementSnapshot,
  delayMs: number,
  source: LorebookReplacementSource,
  trackOutcome = false,
): ScopedLorebookMutationOperation | null {
  const key = lorebookCollectionScopeKey(scope)
  const operation = trackOutcome ? pendingScopedLorebookMutationOperation(key) : null
  if (source !== 'entry') flushPendingLorebookEntryBeforeCollectionMutation(scope)
  const attemptedEntries = cloneJsonValue(entries ?? []) as loreBook[]
  const projectionEpochs = captureLorebookProjectionEpochs(scope)
  queueReplacement(
    key,
    previous,
    (rollbackSnapshot, effectiveProjectionEpochs, plan, options = {}) => {
      const optimisticEntries =
        plan.kind === 'replace' ? plan.entries : (cloneJsonValue(attemptedEntries ?? []) as LorebookEntrySnapshot[])
      const optimisticMetadata = lorebookOptimisticCommandMetadata(scope, effectiveProjectionEpochs, optimisticEntries)
      const entryAttempt = registerLorebookEntryAttempt(rollbackSnapshot, attemptedEntries)

      const result = runServerCommand({
        ...options,
        command: (baseRevision): Promise<ServerCommandResult<Record<string, unknown>>> =>
          dispatchPlannedLorebookCommand(scope, plan, baseRevision, options, optimisticMetadata),
        rollback: () => {
          if (hasLorebookProjectionEpochChanged(effectiveProjectionEpochs)) return
          if (entryAttempt) {
            rollbackLorebookEntryAttempt(entryAttempt)
          } else {
            rollbackLorebookReplacement(scope, rollbackSnapshot, attemptedEntries)
          }
        },
      })
      if (entryAttempt) {
        void result.then(
          () => clearLorebookEntryAttempt(entryAttempt),
          () => clearLorebookEntryAttempt(entryAttempt),
        )
      }
      return result
    },
    delayMs,
    source,
    projectionEpochs,
    attemptedEntries,
    scope,
    operation,
  )
  return operation
}

type LorebookCollectionDelta =
  | { type: 'upsert'; entry: loreBook }
  | { type: 'delete'; entryId: string }
  | { type: 'reorder'; entryIds: string[] }

type PlannedLorebookCommand =
  | { kind: 'replace'; entries: LorebookEntrySnapshot[] }
  | {
      kind: 'upsert'
      entryId: string
      entry: LorebookEntrySnapshot
      sparseUpdate?: SparseLorebookEntryUpdate
      optimisticEntryIndex: number
      optimisticEntryCreated: boolean
    }
  | { kind: 'delete'; entryId: string; optimisticEntryIndex: number }
  | { kind: 'reorder'; entryIds: string[] }

type LorebookOptimisticCommandMetadata = {
  acknowledgeOptimistic?: boolean
  optimisticEntries?: LorebookEntrySnapshot[]
  optimisticCollectionEpoch?: number
  optimisticCharacterId?: string
  optimisticRowEpoch?: number
  optimisticLorebookEpoch?: number
  optimisticEntryIndex?: number
  optimisticEntryCreated?: boolean
}

function lorebookOptimisticCommandMetadata(
  scope: DiscreteLorebookEditScope,
  epochs: LorebookProjectionEpochs,
  optimisticEntries: LorebookEntrySnapshot[],
): LorebookOptimisticCommandMetadata {
  if (scope.kind === 'global' && epochs.kind === 'global') {
    return {
      acknowledgeOptimistic: true,
      optimisticEntries,
      optimisticCollectionEpoch: epochs.collectionEpoch,
    }
  }
  if (scope.kind === 'character' && epochs.kind === 'character' && epochs.characterId === scope.characterId) {
    return {
      acknowledgeOptimistic: true,
      optimisticEntries,
      optimisticRowEpoch: epochs.rowEpoch,
      optimisticLorebookEpoch: epochs.lorebookEpoch,
    }
  }
  if (
    scope.kind === 'chat' &&
    epochs.kind === 'chat' &&
    epochs.chatId === scope.chatId &&
    epochs.characterId &&
    epochs.rowEpoch !== null
  ) {
    return {
      acknowledgeOptimistic: true,
      optimisticEntries,
      optimisticCharacterId: epochs.characterId,
      optimisticRowEpoch: epochs.rowEpoch,
    }
  }
  return {}
}

function planLorebookCollectionDelta(
  entries: loreBook[],
  rollbackSnapshot: LorebookStateSnapshot,
): PlannedLorebookCommand | null {
  const delta = detectLorebookCollectionDelta(rollbackSnapshot.scopedValue, entries)
  if (!delta) return null

  switch (delta.type) {
    case 'upsert': {
      const entryId = delta.entry.id
      if (typeof entryId !== 'string' || entryId.trim() === '') return null
      const previousEntries = rollbackSnapshot.scopedValue as loreBook[]
      const previousEntry = previousEntries.find((entry) => entry.id === entryId)
      const optimisticEntryIndex = entries.findIndex((entry) => entry.id === entryId)
      const entrySnapshot = cloneJsonValue(delta.entry) as LorebookEntrySnapshot
      const sparseUpdate = previousEntry ? sparseLorebookEntryUpdate(previousEntry, delta.entry) : null
      return {
        kind: 'upsert',
        entryId,
        entry: entrySnapshot,
        ...(sparseUpdate ? { sparseUpdate } : {}),
        optimisticEntryIndex,
        optimisticEntryCreated: !previousEntries.some((entry) => entry.id === entryId),
      }
    }
    case 'delete': {
      const previousEntries = rollbackSnapshot.scopedValue as loreBook[]
      const optimisticEntryIndex = previousEntries.findIndex((entry) => entry.id === delta.entryId)
      return { kind: 'delete', entryId: delta.entryId, optimisticEntryIndex }
    }
    case 'reorder':
      return { kind: 'reorder', entryIds: delta.entryIds }
  }
}

function detectLorebookCollectionDelta(
  previousValue: unknown,
  currentEntries: loreBook[],
): LorebookCollectionDelta | null {
  if (!Array.isArray(previousValue)) return null
  const previousEntries = previousValue as loreBook[]
  const previousIds = lorebookEntryIds(previousEntries)
  const currentIds = lorebookEntryIds(currentEntries)
  if (!previousIds || !currentIds) return null

  if (previousEntries.length === currentEntries.length) {
    if (sameStringArray(previousIds, currentIds)) {
      const changed = currentEntries.filter(
        (entry, index) => snapshotJson(entry) !== snapshotJson(previousEntries[index]),
      )
      return changed.length === 1 ? { type: 'upsert', entry: changed[0] } : null
    }
    if (sameStringSet(previousIds, currentIds) && sameEntriesById(previousEntries, currentEntries)) {
      return { type: 'reorder', entryIds: currentIds }
    }
    return null
  }

  if (
    currentEntries.length === previousEntries.length + 1 &&
    sameStringArray(previousIds, currentIds.slice(0, -1)) &&
    sameSharedEntriesById(previousEntries, currentEntries)
  ) {
    return { type: 'upsert', entry: currentEntries[currentEntries.length - 1] }
  }

  if (currentEntries.length + 1 === previousEntries.length) {
    const removedIds = previousIds.filter((id) => !currentIds.includes(id))
    if (removedIds.length !== 1) return null
    const withoutRemoved = previousIds.filter((id) => id !== removedIds[0])
    return sameStringArray(withoutRemoved, currentIds) && sameSharedEntriesById(previousEntries, currentEntries)
      ? { type: 'delete', entryId: removedIds[0] }
      : null
  }

  return null
}

function sparseLorebookEntryUpdate(
  previousEntry: loreBook,
  attemptedEntry: loreBook,
): SparseLorebookEntryUpdate | null {
  if (
    !isStableCommandId(previousEntry.id) ||
    !isStableCommandId(attemptedEntry.id) ||
    previousEntry.id !== attemptedEntry.id
  ) {
    return null
  }

  const previous = previousEntry as unknown as Record<string, unknown>
  const attempted = attemptedEntry as unknown as Record<string, unknown>
  const patch: LorebookEntrySnapshot = {}
  const deleteKeys: string[] = []
  const keys = new Set([...Object.keys(previous), ...Object.keys(attempted)])

  for (const key of keys) {
    if (key === 'id') continue
    const previousHasKey = Object.prototype.hasOwnProperty.call(previous, key)
    const attemptedHasKey = Object.prototype.hasOwnProperty.call(attempted, key)
    if (!attemptedHasKey || attempted[key] === undefined) {
      if (previousHasKey) deleteKeys.push(key)
      continue
    }
    if (!previousHasKey || snapshotJson(previous[key]) !== snapshotJson(attempted[key])) {
      patch[key] = cloneJsonValue(attempted[key])
    }
  }

  if (Object.keys(patch).length === 0 && deleteKeys.length === 0) return null
  return { patch, ...(deleteKeys.length > 0 ? { deleteKeys } : {}) }
}

function lorebookEntryIds(entries: loreBook[]): string[] | null {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isStableCommandId(entry.id)) return null
    if (seen.has(entry.id)) return null
    seen.add(entry.id)
    ids.push(entry.id)
  }
  return ids
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  const setB = new Set(b)
  return setA.size === a.length && setB.size === b.length && b.every((value) => setA.has(value))
}

function sameEntriesById(previousEntries: loreBook[], currentEntries: loreBook[]): boolean {
  const previousById = new Map(previousEntries.map((entry) => [entry.id, snapshotJson(entry)]))
  return currentEntries.every((entry) => previousById.get(entry.id) === snapshotJson(entry))
}

function sameSharedEntriesById(previousEntries: loreBook[], currentEntries: loreBook[]): boolean {
  const currentById = new Map(currentEntries.map((entry) => [entry.id, snapshotJson(entry)]))
  return previousEntries.every((entry) => {
    const currentSnapshot = currentById.get(entry.id)
    return currentSnapshot === undefined || currentSnapshot === snapshotJson(entry)
  })
}

function isStableCommandId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function hasStableUniqueCommandIds(values: readonly unknown[]): values is string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (!isStableCommandId(value)) return false
    if (seen.has(value)) return false
    seen.add(value)
  }
  return true
}

function hasStableUniqueLorebookEntryIds(entries: unknown): entries is loreBook[] {
  if (!Array.isArray(entries)) return false
  return hasStableUniqueCommandIds(entries.map((entry) => (entry as { id?: unknown }).id))
}

function uniqueStableGlobalLorebookIds(lorebooks: readonly GlobalLorebook[]): Set<string> {
  const counts = new Map<string, number>()
  for (const lorebook of lorebooks) {
    if (!isStableCommandId(lorebook.id)) continue
    counts.set(lorebook.id, (counts.get(lorebook.id) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id))
}

function lorebookScopedEntryCommand(
  scope: DiscreteLorebookEditScope,
  action: 'upsert',
  baseRevision: number,
  options: ServerCommandTransportOptions,
  optimisticMetadata: LorebookOptimisticCommandMetadata,
  payload: { entryId: string; entry: LorebookEntrySnapshot; sparseUpdate?: SparseLorebookEntryUpdate },
): Promise<ServerCommandResult<Record<string, unknown>>>
function lorebookScopedEntryCommand(
  scope: DiscreteLorebookEditScope,
  action: 'delete',
  baseRevision: number,
  options: ServerCommandTransportOptions,
  optimisticMetadata: LorebookOptimisticCommandMetadata,
  payload: { entryId: string },
): Promise<ServerCommandResult<Record<string, unknown>>>
function lorebookScopedEntryCommand(
  scope: DiscreteLorebookEditScope,
  action: 'reorder',
  baseRevision: number,
  options: ServerCommandTransportOptions,
  optimisticMetadata: LorebookOptimisticCommandMetadata,
  payload: { entryIds: string[] },
): Promise<ServerCommandResult<Record<string, unknown>>>
function lorebookScopedEntryCommand(
  scope: DiscreteLorebookEditScope,
  action: 'upsert' | 'delete' | 'reorder',
  baseRevision: number,
  options: ServerCommandTransportOptions,
  optimisticMetadata: LorebookOptimisticCommandMetadata,
  payload: {
    entryId?: string
    entry?: LorebookEntrySnapshot
    sparseUpdate?: SparseLorebookEntryUpdate
    entryIds?: string[]
  },
): Promise<ServerCommandResult<Record<string, unknown>>> {
  switch (scope.kind) {
    case 'character':
      if (action === 'upsert') {
        return upsertCharacterLorebookEntryCommand(
          {
            baseRevision,
            characterId: scope.characterId,
            entryId: payload.entryId!,
            entry: payload.entry!,
            sparseUpdate: payload.sparseUpdate,
            ...optimisticMetadata,
          },
          options.signal,
          options.keepalive,
        ) as Promise<ServerCommandResult<Record<string, unknown>>>
      }
      if (action === 'delete') {
        return deleteCharacterLorebookEntryCommand(
          { baseRevision, characterId: scope.characterId, entryId: payload.entryId!, ...optimisticMetadata },
          options.signal,
          options.keepalive,
        ) as Promise<ServerCommandResult<Record<string, unknown>>>
      }
      return reorderCharacterLorebookEntriesCommand(
        { baseRevision, characterId: scope.characterId, entryIds: payload.entryIds!, ...optimisticMetadata },
        options.signal,
        options.keepalive,
      ) as Promise<ServerCommandResult<Record<string, unknown>>>
    case 'chat':
      if (action === 'upsert') {
        return upsertChatLorebookEntryCommand(
          {
            baseRevision,
            chatId: scope.chatId,
            entryId: payload.entryId!,
            entry: payload.entry!,
            sparseUpdate: payload.sparseUpdate,
            ...optimisticMetadata,
          },
          options.signal,
          options.keepalive,
        ) as Promise<ServerCommandResult<Record<string, unknown>>>
      }
      if (action === 'delete') {
        return deleteChatLorebookEntryCommand(
          { baseRevision, chatId: scope.chatId, entryId: payload.entryId!, ...optimisticMetadata },
          options.signal,
          options.keepalive,
        ) as Promise<ServerCommandResult<Record<string, unknown>>>
      }
      return reorderChatLorebookEntriesCommand(
        { baseRevision, chatId: scope.chatId, entryIds: payload.entryIds!, ...optimisticMetadata },
        options.signal,
        options.keepalive,
      ) as Promise<ServerCommandResult<Record<string, unknown>>>
    case 'global':
      if (action === 'upsert') {
        return upsertGlobalLorebookEntryCommand(
          {
            baseRevision,
            lorebookId: scope.lorebookId,
            entryId: payload.entryId!,
            entry: payload.entry!,
            sparseUpdate: payload.sparseUpdate,
            ...optimisticMetadata,
          },
          options.signal,
          options.keepalive,
        ) as Promise<ServerCommandResult<Record<string, unknown>>>
      }
      if (action === 'delete') {
        return deleteGlobalLorebookEntryCommand(
          { baseRevision, lorebookId: scope.lorebookId, entryId: payload.entryId!, ...optimisticMetadata },
          options.signal,
          options.keepalive,
        ) as Promise<ServerCommandResult<Record<string, unknown>>>
      }
      return reorderGlobalLorebookEntriesCommand(
        { baseRevision, lorebookId: scope.lorebookId, entryIds: payload.entryIds!, ...optimisticMetadata },
        options.signal,
        options.keepalive,
      ) as Promise<ServerCommandResult<Record<string, unknown>>>
    case 'module':
      if (action === 'upsert') {
        return upsertModuleLorebookEntryCommand(
          {
            baseRevision,
            moduleId: scope.moduleId,
            entryId: payload.entryId!,
            entry: payload.entry!,
            sparseUpdate: payload.sparseUpdate,
          },
          options.signal,
          options.keepalive,
          true,
        ) as Promise<ServerCommandResult<Record<string, unknown>>>
      }
      if (action === 'delete') {
        return deleteModuleLorebookEntryCommand(
          {
            baseRevision,
            moduleId: scope.moduleId,
            entryId: payload.entryId!,
          },
          options.signal,
          options.keepalive,
          true,
        ) as Promise<ServerCommandResult<Record<string, unknown>>>
      }
      return reorderModuleLorebookEntriesCommand(
        { baseRevision, moduleId: scope.moduleId, entryIds: payload.entryIds! },
        options.signal,
        options.keepalive,
        true,
      ) as Promise<ServerCommandResult<Record<string, unknown>>>
  }
}

function planLorebookEntryUpsert(
  entries: loreBook[],
  rollbackSnapshot: LorebookEntryStateSnapshot,
): PlannedLorebookCommand | null {
  const entry = currentEditedLorebookEntry(entries, rollbackSnapshot)
  const entryId = entry?.id
  if (typeof entryId !== 'string' || entryId.trim() === '') return null
  const entrySnapshot = cloneJsonValue(entry) as LorebookEntrySnapshot
  const sparseUpdate = rollbackSnapshot.previousEntry
    ? sparseLorebookEntryUpdate(rollbackSnapshot.previousEntry, entry)
    : null
  const optimisticEntryIndex = entries.findIndex((candidate) => candidate.id === entryId)
  if (optimisticEntryIndex < 0) return null
  return {
    kind: 'upsert',
    entryId,
    entry: entrySnapshot,
    ...(sparseUpdate ? { sparseUpdate } : {}),
    optimisticEntryIndex,
    optimisticEntryCreated: rollbackSnapshot.previousEntry === null,
  }
}

function currentEditedLorebookEntry(
  entries: loreBook[],
  rollbackSnapshot: LorebookEntryStateSnapshot,
): loreBook | undefined {
  if (rollbackSnapshot.entryId) {
    const byId = entries.find((entry) => entry.id === rollbackSnapshot.entryId)
    if (byId) return byId
  }
  return entries[rollbackSnapshot.index]
}

function planLorebookCommand(
  scopeKey: string,
  entries: loreBook[],
  rollbackSnapshot: LorebookReplacementSnapshot,
  source: LorebookReplacementSource,
): PlannedLorebookCommand | null {
  if (identityDirtyLorebookScopes.has(scopeKey)) {
    return { kind: 'replace', entries: cloneLorebookEntriesForCommand(entries) }
  }
  const hasEarlierEntryAttempt = pendingLorebookEntryAttempts.some((attempt) => attempt.scopeKey === scopeKey)
  if (
    !isLorebookEntryStateSnapshot(rollbackSnapshot) &&
    Array.isArray(rollbackSnapshot.scopedValue) &&
    snapshotJson(rollbackSnapshot.scopedValue) === snapshotJson(entries)
  ) {
    return null
  }

  if (source === 'entry' && isLorebookEntryStateSnapshot(rollbackSnapshot)) {
    const attemptedEntry = currentEditedLorebookEntry(entries, rollbackSnapshot)
    if (
      (rollbackSnapshot.previousEntry === null && !attemptedEntry) ||
      (rollbackSnapshot.previousEntry &&
        attemptedEntry &&
        snapshotJson(rollbackSnapshot.previousEntry) === snapshotJson(attemptedEntry))
    ) {
      return null
    }
    const entryPlan = planLorebookEntryUpsert(entries, rollbackSnapshot)
    if (entryPlan) {
      if (hasEarlierEntryAttempt && entryPlan.kind === 'upsert') {
        const { sparseUpdate: _sparseUpdate, ...fullEntryPlan } = entryPlan
        return fullEntryPlan
      }
      return entryPlan
    }
  }

  if (isLorebookCollectionReplacementSource(source) && !isLorebookEntryStateSnapshot(rollbackSnapshot)) {
    const deltaPlan = planLorebookCollectionDelta(entries, rollbackSnapshot)
    if (deltaPlan) return deltaPlan
  }

  return {
    kind: 'replace',
    entries: cloneLorebookEntriesForCommand(entries),
  }
}

function planLorebookEntryNetRevertCorrection(
  entries: loreBook[],
  rollbackSnapshot: LorebookReplacementSnapshot,
): PlannedLorebookCommand | null {
  if (isLorebookEntryStateSnapshot(rollbackSnapshot)) {
    const upsert = planLorebookEntryUpsert(entries, rollbackSnapshot)
    if (!upsert || upsert.kind !== 'upsert') return null
    const { sparseUpdate: _sparseUpdate, ...fullEntryUpsert } = upsert
    return fullEntryUpsert
  }
  if (!Array.isArray(rollbackSnapshot.scopedValue)) return null
  return { kind: 'replace', entries: cloneLorebookEntriesForCommand(entries) }
}

function lorebookCollectionMatchesRollbackBaseline(
  entries: loreBook[],
  rollbackSnapshot: LorebookReplacementSnapshot,
): boolean {
  return (
    !isLorebookEntryStateSnapshot(rollbackSnapshot) &&
    Array.isArray(rollbackSnapshot.scopedValue) &&
    snapshotJson(rollbackSnapshot.scopedValue) === snapshotJson(entries)
  )
}

function lorebookDurableIntent(scope: DiscreteLorebookEditScope, plan: PlannedLorebookCommand): DurableMutationIntent {
  const collectionPath = lorebookCollectionCommandPath(scope)
  const entryCollectionPath = scope.kind === 'global' ? collectionPath : `${collectionPath}/entries`
  let method: 'DELETE' | 'POST' | 'PUT'
  let path: string
  let body: Record<string, unknown>

  switch (plan.kind) {
    case 'replace':
      method = 'PUT'
      path = collectionPath
      body = { entries: cloneJsonValue(plan.entries) }
      break
    case 'upsert':
      method = 'PUT'
      path = `${entryCollectionPath}/${encodeURIComponent(plan.entryId)}`
      body = plan.sparseUpdate
        ? {
            patch: cloneJsonValue(plan.sparseUpdate.patch),
            ...(plan.sparseUpdate.deleteKeys?.length
              ? { deleteKeys: cloneJsonValue(plan.sparseUpdate.deleteKeys) }
              : {}),
          }
        : { entry: cloneJsonValue(plan.entry) }
      break
    case 'delete':
      method = 'DELETE'
      path = `${entryCollectionPath}/${encodeURIComponent(plan.entryId)}`
      body = {}
      break
    case 'reorder':
      method = 'POST'
      path = `${entryCollectionPath}/reorder`
      body = { entryIds: cloneJsonValue(plan.entryIds) }
      break
  }

  return {
    version: 1,
    ...(scope.kind === 'global' ? { dependencyKeys: [GLOBAL_LOREBOOK_SELECTION_MUTATION_KEY] } : {}),
    requests: [{ method, path, body }],
  }
}

function lorebookCollectionCommandPath(scope: DiscreteLorebookEditScope): string {
  switch (scope.kind) {
    case 'global':
      return `/lorebooks/${encodeURIComponent(scope.lorebookId)}/entries`
    case 'character':
      return `/characters/${encodeURIComponent(scope.characterId)}/lorebooks`
    case 'chat':
      return `/chats/${encodeURIComponent(scope.chatId)}/lorebooks`
    case 'module':
      return `/modules/${encodeURIComponent(scope.moduleId)}/lorebooks`
  }
}

function dispatchPlannedLorebookCommand(
  scope: DiscreteLorebookEditScope,
  plan: PlannedLorebookCommand,
  baseRevision: number,
  options: ServerCommandTransportOptions,
  optimisticMetadata: LorebookOptimisticCommandMetadata,
): Promise<ServerCommandResult<Record<string, unknown>>> {
  if (plan.kind === 'upsert') {
    return lorebookScopedEntryCommand(
      scope,
      'upsert',
      baseRevision,
      options,
      {
        ...optimisticMetadata,
        optimisticEntryIndex: plan.optimisticEntryIndex,
        optimisticEntryCreated: plan.optimisticEntryCreated,
      },
      {
        entryId: plan.entryId,
        entry: plan.entry,
        ...(plan.sparseUpdate ? { sparseUpdate: plan.sparseUpdate } : {}),
      },
    )
  }
  if (plan.kind === 'delete') {
    return lorebookScopedEntryCommand(
      scope,
      'delete',
      baseRevision,
      options,
      { ...optimisticMetadata, optimisticEntryIndex: plan.optimisticEntryIndex },
      { entryId: plan.entryId },
    )
  }
  if (plan.kind === 'reorder') {
    return lorebookScopedEntryCommand(scope, 'reorder', baseRevision, options, optimisticMetadata, {
      entryIds: plan.entryIds,
    })
  }

  switch (scope.kind) {
    case 'character':
      return replaceCharacterLorebooksCommand(
        { baseRevision, characterId: scope.characterId, entries: plan.entries, ...optimisticMetadata },
        options.signal,
        options.keepalive,
      ) as Promise<ServerCommandResult<Record<string, unknown>>>
    case 'chat':
      return replaceChatLorebooksCommand(
        { baseRevision, chatId: scope.chatId, entries: plan.entries, ...optimisticMetadata },
        options.signal,
        options.keepalive,
      ) as Promise<ServerCommandResult<Record<string, unknown>>>
    case 'global':
      return replaceGlobalLorebookEntriesCommand(
        { baseRevision, lorebookId: scope.lorebookId, entries: plan.entries, ...optimisticMetadata },
        options.signal,
        options.keepalive,
      ) as Promise<ServerCommandResult<Record<string, unknown>>>
    case 'module':
      return replaceModuleLorebooksCommand(
        { baseRevision, moduleId: scope.moduleId, entries: plan.entries },
        options.signal,
        options.keepalive,
        true,
      ) as Promise<ServerCommandResult<Record<string, unknown>>>
  }
}

export function dispatchReplaceModuleLorebooks(
  moduleId: string,
  entries: loreBook[],
  previous: LorebookStateSnapshot,
  delayMs = 250,
  source: LorebookReplacementSource = 'collection',
): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  if (source === 'collection') ensureClientLorebookEntryIds(entries)
  queueScopedLorebookReplacement({ kind: 'module', moduleId }, entries, previous, delayMs, source)
}

export type LorebookEntryDirtyField = keyof loreBook & string

export interface LorebookEntryDraftRollbackEvent {
  scopeKey: string
  entryId: string
  previousEntry: loreBook
  attemptedEntry: loreBook
  restoredFields: LorebookEntryDirtyField[]
}

export interface LorebookEntryDraftRollbackResult {
  draft: loreBook
  restoredFields: LorebookEntryDirtyField[]
}

type LorebookEntryDraftRollbackListener = (event: LorebookEntryDraftRollbackEvent) => void

const lorebookEntryDraftRollbackListeners = new Set<LorebookEntryDraftRollbackListener>()

export function subscribeLorebookEntryDraftRollbacks(listener: LorebookEntryDraftRollbackListener): () => void {
  lorebookEntryDraftRollbackListeners.add(listener)
  return () => lorebookEntryDraftRollbackListeners.delete(listener)
}

export function applyLorebookEntryDraftRollback(
  draft: loreBook,
  event: LorebookEntryDraftRollbackEvent,
  scopeKey: string | undefined,
): LorebookEntryDraftRollbackResult {
  if (!scopeKey || scopeKey !== event.scopeKey || draft.id !== event.entryId) {
    return { draft, restoredFields: [] }
  }
  const nextDraft = cloneJsonValue(draft)
  const restoredFields = restoreAttemptedLorebookEntryFields(
    nextDraft,
    event.previousEntry,
    event.attemptedEntry,
    event.restoredFields,
  )
  return { draft: restoredFields.length > 0 ? nextDraft : draft, restoredFields }
}

export function changedLorebookEntryDraftFields(
  previousEntry: loreBook,
  currentEntry: loreBook,
): LorebookEntryDirtyField[] {
  const previous = previousEntry as unknown as Record<string, unknown>
  const current = currentEntry as unknown as Record<string, unknown>
  const changedFields: LorebookEntryDirtyField[] = []
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])

  for (const key of keys) {
    if (key === 'id') continue
    if (
      Object.prototype.hasOwnProperty.call(previous, key) !== Object.prototype.hasOwnProperty.call(current, key) ||
      snapshotJson(previous[key]) !== snapshotJson(current[key])
    ) {
      changedFields.push(key as LorebookEntryDirtyField)
    }
  }

  return changedFields
}

export function clearDirtyLorebookEntryFieldsMatchingProjection(
  dirtyFields: Set<LorebookEntryDirtyField>,
  draft: loreBook,
  projection: loreBook,
): void {
  const draftRecord = draft as unknown as Record<string, unknown>
  const projectionRecord = projection as unknown as Record<string, unknown>

  for (const field of Array.from(dirtyFields)) {
    if (snapshotJson(draftRecord[field]) === snapshotJson(projectionRecord[field])) {
      dirtyFields.delete(field)
    }
  }
}

export function mergeLorebookEntryProjectionDraft(
  draft: loreBook,
  projection: loreBook,
  dirtyFields: ReadonlySet<LorebookEntryDirtyField>,
): loreBook {
  return mergeProjectionIntoDirtyDraft({
    draft: cloneJsonValue(draft) as unknown as Record<string, unknown>,
    projection: projection as unknown as Record<string, unknown>,
    dirtyFields,
  }) as unknown as loreBook
}

function emitLorebookEntryDraftRollback(event: LorebookEntryDraftRollbackEvent): void {
  for (const listener of lorebookEntryDraftRollbackListeners) {
    try {
      listener(event)
    } catch (error) {
      console.warn('Lorebook entry draft rollback listener failed', error)
    }
  }
}

function restoreAttemptedLorebookEntryFields(
  target: loreBook,
  previousEntry: loreBook,
  attemptedEntry: loreBook,
  fields: readonly LorebookEntryDirtyField[],
): LorebookEntryDirtyField[] {
  const targetRecord = target as unknown as Record<string, unknown>
  const previousRecord = previousEntry as unknown as Record<string, unknown>
  const restoredFields: LorebookEntryDirtyField[] = []

  for (const field of fields) {
    if (!sameLorebookEntryFieldValue(target, attemptedEntry, field)) continue
    if (Object.prototype.hasOwnProperty.call(previousRecord, field)) {
      targetRecord[field] = cloneJsonValue(previousRecord[field])
    } else {
      delete targetRecord[field]
    }
    restoredFields.push(field)
  }
  return restoredFields
}

function sameLorebookEntryFieldValue(left: loreBook, right: loreBook, field: LorebookEntryDirtyField): boolean {
  const leftRecord = left as unknown as Record<string, unknown>
  const rightRecord = right as unknown as Record<string, unknown>
  return (
    Object.prototype.hasOwnProperty.call(leftRecord, field) ===
      Object.prototype.hasOwnProperty.call(rightRecord, field) &&
    snapshotJson(leftRecord[field]) === snapshotJson(rightRecord[field])
  )
}

function copyLorebookEntryFieldValue(target: loreBook, source: loreBook, field: LorebookEntryDirtyField): void {
  const targetRecord = target as unknown as Record<string, unknown>
  const sourceRecord = source as unknown as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(sourceRecord, field)) {
    targetRecord[field] = cloneJsonValue(sourceRecord[field])
  } else {
    delete targetRecord[field]
  }
}

function captureLorebookProjectionEpochs(scope: DiscreteLorebookEditScope): LorebookProjectionEpochs {
  switch (scope.kind) {
    case 'global':
      return { kind: 'global', collectionEpoch: captureCollectionProjectionEpoch('loreBook') }
    case 'character':
      return {
        kind: 'character',
        characterId: scope.characterId,
        rowEpoch: captureCharacterRowProjectionEpoch(scope.characterId),
        lorebookEpoch: captureCharacterLorebookProjectionEpoch(scope.characterId),
      }
    case 'chat': {
      const characterId = uniqueCharacterIdForChat(scope.chatId)
      return {
        kind: 'chat',
        chatId: scope.chatId,
        characterId,
        rowEpoch: characterId ? captureCharacterRowProjectionEpoch(characterId) : null,
      }
    }
    case 'module':
      return {
        kind: 'module',
        moduleId: scope.moduleId,
        collectionEpoch: captureCollectionProjectionEpoch('modules'),
      }
  }
}

function hasLorebookProjectionEpochChanged(epochs: LorebookProjectionEpochs): boolean {
  switch (epochs.kind) {
    case 'global':
      return hasCollectionProjectionEpochChanged('loreBook', epochs.collectionEpoch)
    case 'character':
      return (
        hasCharacterRowProjectionEpochChanged(epochs.characterId, epochs.rowEpoch) ||
        hasCharacterLorebookProjectionEpochChanged(epochs.characterId, epochs.lorebookEpoch)
      )
    case 'chat':
      return (
        !epochs.characterId ||
        epochs.rowEpoch === null ||
        hasCharacterRowProjectionEpochChanged(epochs.characterId, epochs.rowEpoch)
      )
    case 'module':
      return hasCollectionProjectionEpochChanged('modules', epochs.collectionEpoch)
  }
}

function queueReplacement(
  key: string,
  previous: LorebookReplacementSnapshot,
  command: (
    previous: LorebookReplacementSnapshot,
    projectionEpochs: LorebookProjectionEpochs,
    plan: PlannedLorebookCommand,
    options?: ServerCommandTransportOptions,
  ) => Promise<ServerCommandResult<Record<string, unknown>>>,
  delay: number,
  source: LorebookReplacementSource,
  projectionEpochs: LorebookProjectionEpochs,
  attemptedEntries: loreBook[],
  scope: DiscreteLorebookEditScope,
  operation: PendingScopedLorebookMutationOperation | null,
): void {
  if (!canUseClientWriteAccess()) return
  const existing = pendingReplacements.get(key)
  if (existing?.timer) clearTimeout(existing.timer)

  const existingProjectionIsCurrent = !!existing && !hasLorebookProjectionEpochChanged(existing.projectionEpochs)
  if (existing && !existingProjectionIsCurrent) {
    settleScopedLorebookMutationOperations(existing.operations, {
      status: 'queued',
    })
  }
  const operations = [
    ...(existingProjectionIsCurrent ? (existing?.operations ?? []) : []),
    ...(operation ? [operation] : []),
  ]
  const useExisting =
    existingProjectionIsCurrent &&
    (isLorebookCollectionReplacementSource(existing?.source) ||
      (existing?.source === 'entry' && source === 'entry' && isLorebookEntryStateSnapshot(previous)))
  const effectivePrevious = useExisting ? existing.previous : previous
  const effectiveSource = useExisting && existing?.source === 'collection' ? 'collection' : source
  const effectiveProjectionEpochs = useExisting ? existing.projectionEpochs : projectionEpochs
  const identityDirtyGeneration = identityDirtyLorebookScopes.get(key)
  const rollbackPrevious =
    identityDirtyGeneration !== undefined && isLorebookEntryStateSnapshot(effectivePrevious)
      ? promoteEntryRollbackToCollectionSnapshot(scope, effectivePrevious)
      : effectivePrevious
  let plan = planLorebookCommand(key, attemptedEntries, rollbackPrevious, effectiveSource)
  let correctionOnly = false
  if (!plan && existingProjectionIsCurrent && existing?.source === 'entry' && source === 'entry') {
    // A different tab can freeze the staged edit between the local no-op check
    // and durable replacement. Keep a full baseline successor so an older
    // generation that still lands is explicitly corrected instead of silently
    // deleting the only recovery intent.
    plan = planLorebookEntryNetRevertCorrection(attemptedEntries, rollbackPrevious)
    correctionOnly = plan !== null
  }
  if (
    existingProjectionIsCurrent &&
    existing?.source !== 'entry' &&
    source !== 'entry' &&
    lorebookCollectionMatchesRollbackBaseline(attemptedEntries, existing.previous)
  ) {
    // A remotely frozen structural generation can still land after this local
    // total revert. Replace the whole baseline as an ordered correction rather
    // than deleting the only durable row that can undo that predecessor.
    plan = { kind: 'replace', entries: cloneLorebookEntriesForCommand(attemptedEntries) }
    correctionOnly = true
  }
  if (!plan) {
    if (existing) {
      existing.settlementCleanup?.()
      void acknowledgePendingMutation(existing.outbox)
    }
    pendingReplacements.delete(key)
    settleScopedLorebookMutationOperations(operations, { status: 'accepted' })
    return
  }

  const intent = lorebookDurableIntent(scope, plan)
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(
      lorebookOwnerMutationKey(scope),
      intent,
      existingProjectionIsCurrent ? existing?.outbox : undefined,
    )
  } catch (error) {
    pendingReplacements.delete(key)
    if (!hasLorebookProjectionEpochChanged(effectiveProjectionEpochs)) {
      rollbackLorebookReplacement(scope, rollbackPrevious, attemptedEntries)
    }
    settleScopedLorebookMutationOperations(operations, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  const pending: PendingCollectionReplacement = {
    sessionGeneration: captureClientSessionGeneration(),
    key,
    previous: rollbackPrevious,
    attemptedEntries,
    source: effectiveSource,
    projectionEpochs: effectiveProjectionEpochs,
    intent,
    outbox,
    operations,
    ...(identityDirtyGeneration !== undefined && plan.kind === 'replace' ? { identityDirtyGeneration } : {}),
    command: (options = {}) => command(rollbackPrevious, effectiveProjectionEpochs, plan, options),
    timer: null,
  }
  if (existingProjectionIsCurrent) existing?.settlementCleanup?.()
  trackPendingLorebookReplacementSettlement(pending, scope)
  pendingReplacements.set(key, pending)
  if (correctionOnly) {
    runPendingReplacement(key)
  } else {
    pending.timer = setTimeout(() => runPendingReplacement(key), delay)
  }
}

function trackPendingLorebookReplacementSettlement(
  pending: PendingCollectionReplacement,
  scope: DiscreteLorebookEditScope,
): void {
  pending.settlementCleanup = registerDurableMutationSettlementListener(pending.outbox.mutationId, (settlement) => {
    pending.settlementCleanup = undefined
    if (pendingReplacements.get(pending.key)?.outbox.mutationId !== pending.outbox.mutationId) return
    if (pending.timer) clearTimeout(pending.timer)
    pendingReplacements.delete(pending.key)

    if (settlement === 'accepted') {
      clearAcceptedLorebookIdentityDirty(pending)
      settleScopedLorebookMutationOperations(pending.operations, { status: 'accepted' })
      return
    }
    if (!hasLorebookProjectionEpochChanged(pending.projectionEpochs)) {
      rollbackLorebookReplacement(scope, pending.previous, pending.attemptedEntries)
    }
    settleScopedLorebookMutationOperations(pending.operations, {
      status: 'failed',
      error: 'The queued lorebook change was rejected by the server.',
    })
  })
}

function isLorebookCollectionReplacementSource(source: LorebookReplacementSource | undefined): source is 'collection' {
  return source === 'collection'
}

export function flushPendingLorebookOwnerMutations(options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  for (const key of Array.from(pendingReplacements.keys())) {
    runPendingReplacement(key, options)
  }
}

registerPendingOwnerMutationFlusher('lorebook', flushPendingLorebookOwnerMutations)

function lorebookOwnerMutationKey(scope: DiscreteLorebookEditScope): string {
  switch (scope.kind) {
    case 'character':
      return characterOwnerMutationKey(scope.characterId)
    case 'chat':
      return chatResourceOwnerMutationKey(scope.chatId, uniqueCharacterIdForChat(scope.chatId))
    case 'module':
      return moduleOwnerMutationKey(scope.moduleId)
    case 'global':
      return globalLorebookOwnerMutationKey(scope.lorebookId)
  }
}

function runPendingReplacement(key: string, options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  const pending = pendingReplacements.get(key)
  if (!pending) return
  if (!isClientSessionGenerationCurrent(pending.sessionGeneration)) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingReplacements.delete(key)
  if (hasLorebookProjectionEpochChanged(pending.projectionEpochs)) {
    // Projection replacement only proves that this page's optimistic baseline
    // is stale. The encrypted intent remains pending until its exact mutation id
    // is accepted/discarded or bootstrap replays it.
    settleScopedLorebookMutationOperations(pending.operations, {
      status: 'queued',
    })
    return
  }
  pending.settlementCleanup?.()
  pending.settlementCleanup = undefined
  const dispatch = dispatchDurableMutation(pending.outbox, pending.intent, (transport) =>
    pending.command({ ...options, ...transport }),
  )
  void settleDispatchedScopedLorebookReplacement(pending, dispatch)
}

async function settleDispatchedScopedLorebookReplacement(
  pending: PendingCollectionReplacement,
  dispatch: Promise<ServerCommandResult<Record<string, unknown>>>,
): Promise<void> {
  try {
    const result = await dispatch
    if (result.status === 'ok') {
      clearAcceptedLorebookIdentityDirty(pending)
      settleScopedLorebookMutationOperations(pending.operations, { status: 'accepted' })
      return
    }
    if (await isPendingMutationCurrent(pending.outbox)) {
      settleScopedLorebookMutationOperations(pending.operations, { status: 'queued' })
      return
    }
    settleScopedLorebookMutationOperations(pending.operations, {
      status: 'failed',
      error: scopedLorebookMutationFailureMessage(result),
    })
  } catch (error) {
    if (await isPendingMutationCurrent(pending.outbox)) {
      settleScopedLorebookMutationOperations(pending.operations, { status: 'queued' })
      return
    }
    settleScopedLorebookMutationOperations(pending.operations, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function clearAcceptedLorebookIdentityDirty(pending: PendingCollectionReplacement): void {
  if (pending.identityDirtyGeneration === undefined) return
  if (identityDirtyLorebookScopes.get(pending.key) === pending.identityDirtyGeneration) {
    identityDirtyLorebookScopes.delete(pending.key)
  }
}

function scopedLorebookMutationFailureMessage(result: ServerCommandResult): string {
  if (result.status === 'error') return result.error || 'Lorebook change could not be saved.'
  if (result.status === 'conflict') return `Server revision conflict (${result.currentRevision}).`
  return 'Server commands are unavailable.'
}

function registerLorebookEntryAttempt(
  snapshot: LorebookReplacementSnapshot,
  attemptedEntries: loreBook[],
): PendingLorebookEntryAttempt | null {
  if (
    !isLorebookEntryStateSnapshot(snapshot) ||
    !snapshot.previousEntry ||
    !isStableCommandId(snapshot.entryId) ||
    snapshot.previousEntry.id !== snapshot.entryId
  ) {
    return null
  }

  const attemptedEntry = attemptedLorebookEntryForSnapshot(attemptedEntries, snapshot)
  if (!attemptedEntry || attemptedEntry.id !== snapshot.entryId) return null
  if (!sparseLorebookEntryUpdate(snapshot.previousEntry, attemptedEntry)) return null

  const attempt: PendingLorebookEntryAttempt = {
    sequence: ++nextLorebookEntryAttemptSequence,
    scopeKey: snapshot.scopeKey,
    entryId: snapshot.entryId,
    previous: snapshot,
    attemptedEntry: cloneJsonValue(attemptedEntry),
  }
  pendingLorebookEntryAttempts.push(attempt)
  return attempt
}

function rollbackLorebookEntryAttempt(attempt: PendingLorebookEntryAttempt): void {
  rollbackLorebookEntryByAttempt(attempt.previous, attempt.attemptedEntry)
  rebaseLaterLorebookEntryAttempts(attempt)
  clearLorebookEntryAttempt(attempt)
}

function rebaseLaterLorebookEntryAttempts(failed: PendingLorebookEntryAttempt): void {
  const failedPrevious = failed.previous.previousEntry
  if (!failedPrevious) return

  for (const field of changedLorebookEntryDraftFields(failedPrevious, failed.attemptedEntry)) {
    let rebased = false
    for (const later of pendingLorebookEntryAttempts) {
      const laterPrevious = later.previous.previousEntry
      if (
        later.sequence <= failed.sequence ||
        later.scopeKey !== failed.scopeKey ||
        later.entryId !== failed.entryId ||
        !laterPrevious
      ) {
        continue
      }
      if (!changedLorebookEntryDraftFields(laterPrevious, later.attemptedEntry).includes(field)) continue
      if (!sameLorebookEntryFieldValue(laterPrevious, failed.attemptedEntry, field)) continue
      copyLorebookEntryFieldValue(laterPrevious, failedPrevious, field)
      rebased = true
      break
    }

    if (rebased) continue
    const queued = pendingReplacements.get(failed.scopeKey)
    if (
      !queued ||
      queued.source !== 'entry' ||
      !isLorebookEntryStateSnapshot(queued.previous) ||
      queued.previous.entryId !== failed.entryId ||
      !queued.previous.previousEntry
    ) {
      continue
    }
    const queuedAttemptedEntry = attemptedLorebookEntryForSnapshot(queued.attemptedEntries, queued.previous)
    if (!queuedAttemptedEntry || queuedAttemptedEntry.id !== failed.entryId) continue
    if (!changedLorebookEntryDraftFields(queued.previous.previousEntry, queuedAttemptedEntry).includes(field)) continue
    if (!sameLorebookEntryFieldValue(queued.previous.previousEntry, failed.attemptedEntry, field)) continue
    copyLorebookEntryFieldValue(queued.previous.previousEntry, failedPrevious, field)
  }
}

function clearLorebookEntryAttempt(attempt: PendingLorebookEntryAttempt): void {
  const index = pendingLorebookEntryAttempts.findIndex((candidate) => candidate.sequence === attempt.sequence)
  if (index !== -1) pendingLorebookEntryAttempts.splice(index, 1)
}

function rollbackLorebookReplacement(
  scope: DiscreteLorebookEditScope,
  snapshot: LorebookReplacementSnapshot,
  attemptedEntries: loreBook[],
): void {
  if (isLorebookEntryStateSnapshot(snapshot)) {
    rollbackLorebookEntryOwnerMutation(snapshot, attemptedEntries)
    return
  }
  rollbackLorebookCollectionOwnerMutation(scope, snapshot, attemptedEntries)
}

export function rollbackCharacterLorebookReplacement(
  characterId: string,
  snapshot: LorebookStateSnapshot,
  attemptedEntries: loreBook[],
): void {
  rollbackLorebookReplacement({ kind: 'character', characterId }, snapshot, attemptedEntries)
}

function rollbackGlobalLorebookListEntry(rollbackEntry: GlobalLorebookListRollbackEntry | null): void {
  if (!rollbackEntry) return
  if (!canApplyGlobalLorebookListRollback(rollbackEntry)) return
  const selectedLorebookId = currentSelectedGlobalLorebookId()

  mutateLorebookOwner(() => {
    mutateLorebookOwner(() => {
      const lorebooks = mutableGlobalLorebookList()
      if (!canApplyGlobalLorebookListRollback(rollbackEntry, lorebooks)) return
      const rolledBack = applyAttemptedKeyedListRollback<GlobalLorebook, string>({
        list: lorebooks,
        entries: [rollbackEntry],
        getKey: globalLorebookKey,
      })
      if (rolledBack.length === 0) return
      collectionsResourceState.values.loreBook = lorebooks as Database['loreBook']
      restoreGlobalLorebookSelectionById(selectedLorebookId)
    })
  })
}

function rollbackDeletedGlobalLorebook(
  rollbackEntry: GlobalLorebookListRollbackEntry | null,
  selectionRollback: GlobalLorebookSelectionRollback,
  options: { restoreRow: boolean; restoreSelection: boolean } = { restoreRow: true, restoreSelection: true },
): void {
  const shouldRestoreRow =
    options.restoreRow && rollbackEntry ? canApplyGlobalLorebookListRollback(rollbackEntry) : false
  const shouldRestoreSelection = options.restoreSelection && canApplyGlobalLorebookSelectionRollback(selectionRollback)
  if (!shouldRestoreRow && !shouldRestoreSelection) return

  const selectedLorebookId = currentSelectedGlobalLorebookId()
  let restoredRow = false

  if (shouldRestoreRow && rollbackEntry) {
    mutateLorebookOwner(() => {
      const lorebooks = mutableGlobalLorebookList()
      const canRestoreRow = rollbackEntry ? canApplyGlobalLorebookListRollback(rollbackEntry, lorebooks) : false
      if (!canRestoreRow) return

      mutateLorebookOwner(() => {
        restoredRow =
          applyAttemptedKeyedListRollback<GlobalLorebook, string>({
            list: lorebooks,
            entries: [rollbackEntry],
            getKey: globalLorebookKey,
          }).length > 0
        if (restoredRow) collectionsResourceState.values.loreBook = lorebooks as Database['loreBook']
      })
    })
  }

  mutateLorebookOwner(() => {
    const canRestoreSelection = options.restoreSelection && canApplyGlobalLorebookSelectionRollback(selectionRollback)
    if (canRestoreSelection) {
      restoreGlobalLorebookSelection(selectionRollback)
    } else if (restoredRow) {
      restoreGlobalLorebookSelectionById(selectedLorebookId)
    }
  })
}

function canApplyGlobalLorebookListRollback(
  rollbackEntry: GlobalLorebookListRollbackEntry,
  lorebooks = (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[],
): boolean {
  const liveIndex = lorebooks.findIndex((lorebook) => globalLorebookKey(lorebook) === rollbackEntry.key)
  const liveValue = liveIndex === -1 ? null : lorebooks[liveIndex]
  return snapshotJson(liveValue) === snapshotJson(rollbackEntry.attempted)
}

function rollbackGlobalLorebookName(rollback: GlobalLorebookNameRollback): void {
  if (!canApplyGlobalLorebookNameRollback(rollback)) return

  mutateLorebookOwner(() => {
    mutateLorebookOwner(() => {
      const lorebooks = mutableGlobalLorebookList()
      if (!canApplyGlobalLorebookNameRollback(rollback, lorebooks)) return
      const lorebook = lorebooks.find((candidate) => candidate.id === rollback.lorebookId)
      if (!lorebook) return
      applyAttemptedFieldRollback({
        target: lorebook as unknown as Record<string, unknown>,
        previous: rollback.previous,
        attempted: rollback.attempted,
        keys: ['name'],
      })
    })
  })
}

function canApplyGlobalLorebookNameRollback(
  rollback: GlobalLorebookNameRollback,
  lorebooks = (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[],
): boolean {
  if (!Object.prototype.hasOwnProperty.call(rollback.attempted, 'name')) return false
  if (!Object.prototype.hasOwnProperty.call(rollback.previous, 'name')) return false
  const lorebook = lorebooks.find((candidate) => candidate.id === rollback.lorebookId)
  return !!lorebook && snapshotJson(lorebook.name) === snapshotJson(rollback.attempted.name)
}

function rollbackGlobalLorebookOrder(rollback: GlobalLorebookOrderRollback): void {
  const liveIds = globalLorebookStableIds((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[])
  if (!liveIds || !sameStringArray(liveIds, rollback.attemptedIds)) return
  const selectedLorebookId = currentSelectedGlobalLorebookId()

  mutateLorebookOwner(() => {
    mutateLorebookOwner(() => {
      const lorebooks = mutableGlobalLorebookList()
      const currentIds = globalLorebookStableIds(lorebooks)
      if (!currentIds || !sameStringArray(currentIds, rollback.attemptedIds)) return

      const lorebooksById = new Map(lorebooks.map((lorebook) => [lorebook.id, lorebook]))
      const reordered = rollback.previousIds
        .map((lorebookId) => lorebooksById.get(lorebookId))
        .filter((lorebook): lorebook is GlobalLorebook => !!lorebook)
      if (reordered.length !== lorebooks.length) return

      lorebooks.splice(0, lorebooks.length, ...reordered)
      restoreGlobalLorebookSelectionById(selectedLorebookId)
    })
  })
}

function rollbackGlobalLorebookSelection(rollback: GlobalLorebookSelectionRollback): void {
  if (!canApplyGlobalLorebookSelectionRollback(rollback)) return

  mutateLorebookOwner(() => {
    mutateLorebookOwner(() => {
      if (!canApplyGlobalLorebookSelectionRollback(rollback)) return
      restoreGlobalLorebookSelection(rollback)
    })
  })
}

function globalLorebookNameRollbackFromSnapshot(
  lorebookId: string,
  previous: LorebookStateSnapshot,
  attempted: Pick<GlobalLorebook, 'name'>,
): GlobalLorebookNameRollback {
  return {
    lorebookId,
    previous: previousGlobalLorebookNamePatch(lorebookId, previous),
    attempted: cloneJsonValue(attempted),
  }
}

function previousGlobalLorebookNamePatch(
  lorebookId: string,
  previous: LorebookStateSnapshot,
): Partial<Pick<GlobalLorebook, 'name'>> {
  if (previous.scopeKey === `globalMeta:${lorebookId}`) {
    const value = previous.scopedValue
    if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
      return { name: (value as { name: string }).name }
    }
    return {}
  }

  const lorebook = previous.loreBook.find((candidate) => candidate.id === lorebookId)
  return typeof lorebook?.name === 'string' ? { name: lorebook.name } : {}
}

function globalLorebookSelectionRollbackFromSnapshot(
  previous: GlobalLorebookStateSnapshot,
  attemptedLorebookId = currentSelectedGlobalLorebookId(),
): GlobalLorebookSelectionRollback {
  const previousPage = previous.loreBookPage ?? 0
  const previousLorebookId = stableGlobalLorebookId(previous.loreBook[previousPage]?.id)
  const attemptedPage = settingsResourceState.value.loreBookPage ?? 0
  return {
    previousPage,
    previousLorebookId,
    attemptedPage,
    attemptedLorebookId: stableGlobalLorebookId(attemptedLorebookId),
  }
}

function canApplyGlobalLorebookSelectionRollback(rollback: GlobalLorebookSelectionRollback): boolean {
  if (rollback.attemptedLorebookId) {
    return currentSelectedGlobalLorebookId() === rollback.attemptedLorebookId
  }
  return (settingsResourceState.value.loreBookPage ?? 0) === rollback.attemptedPage
}

function restoreGlobalLorebookSelection(rollback: GlobalLorebookSelectionRollback): void {
  const lorebooks = (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]
  if (rollback.previousLorebookId) {
    restoreGlobalLorebookSelectionById(rollback.previousLorebookId)
    return
  }

  if (rollback.previousPage >= 0 && rollback.previousPage < lorebooks.length) {
    projectGlobalLorebookPage(rollback.previousPage)
  }
}

function restoreGlobalLorebookSelectionById(lorebookId: string | null): void {
  if (!lorebookId) return
  const lorebooks = (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]
  const index = lorebooks.findIndex((lorebook) => lorebook.id === lorebookId)
  if (index >= 0) projectGlobalLorebookPage(index)
}

function currentSelectedGlobalLorebookId(): string | null {
  const lorebooks = (collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]
  const page = settingsResourceState.value.loreBookPage ?? 0
  return stableGlobalLorebookId(lorebooks[page]?.id)
}

function projectGlobalLorebookPage(index: number): void {
  if (!Number.isInteger(index) || index < 0) return
  settingsResourceState.value.loreBookPage = index
  lorebookPageOwner.projectStructuralSelection(index)
}

function stableGlobalLorebookId(value: unknown): string | null {
  return isStableCommandId(value) ? value : null
}

function uniqueGlobalLorebookIndexById(lorebookId: string): number {
  const stableId = stableGlobalLorebookId(lorebookId)
  if (!stableId) return -1

  let foundIndex = -1
  for (const [index, lorebook] of ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).entries()) {
    if (lorebook.id !== stableId) continue
    if (foundIndex >= 0) return -1
    foundIndex = index
  }
  return foundIndex
}

function globalLorebookKey(lorebook: GlobalLorebook): string | null {
  return stableGlobalLorebookId(lorebook.id)
}

function globalLorebookStableIds(lorebooks: GlobalLorebook[]): string[] | null {
  const ids = lorebooks.map((lorebook) => lorebook.id)
  return hasStableUniqueCommandIds(ids) ? ids : null
}

function mutableGlobalLorebookList(): GlobalLorebook[] {
  if (!Array.isArray(collectionsResourceState.values.loreBook)) {
    collectionsResourceState.values.loreBook = [] as Database['loreBook']
  }
  return collectionsResourceState.values.loreBook as GlobalLorebook[]
}

function rollbackLorebookEntryOwnerMutation(snapshot: LorebookEntryStateSnapshot, attemptedEntries?: loreBook[]): void {
  if (attemptedEntries) {
    const attemptedEntry = attemptedLorebookEntryForSnapshot(attemptedEntries, snapshot)
    if (!attemptedEntry) return
    rollbackLorebookEntryByAttempt(snapshot, attemptedEntry)
    return
  }

  mutateLorebookOwner(() => {
    restoreLorebookEntryState(snapshot)
  })
}

type LorebookListRollbackEntry = {
  key: string
  previous: loreBook | null
  attempted: loreBook | null
  previousIndex?: number
}

function rollbackLorebookCollectionOwnerMutation(
  scope: DiscreteLorebookEditScope,
  snapshot: LorebookStateSnapshot,
  attemptedEntries: loreBook[],
): void {
  const previousEntries = previousLorebookEntriesForScope(scope, snapshot)
  if (!previousEntries) return

  const delta = detectLorebookCollectionDelta(previousEntries, attemptedEntries)
  if (delta) {
    switch (delta.type) {
      case 'upsert':
        rollbackLorebookCollectionUpsert(scope, previousEntries, delta.entry)
        return
      case 'delete':
        rollbackLorebookCollectionDelete(scope, previousEntries, delta.entryId)
        return
      case 'reorder':
        rollbackLorebookCollectionReorder(scope, lorebookEntryIds(previousEntries), delta.entryIds)
        return
    }
  }

  rollbackLorebookCollectionFullReplace(scope, previousEntries, attemptedEntries)
}

function rollbackLorebookEntryByAttempt(snapshot: LorebookEntryStateSnapshot, attemptedEntry: loreBook): void {
  const entryId =
    typeof attemptedEntry.id === 'string' && attemptedEntry.id.trim() ? attemptedEntry.id : snapshot.entryId
  if (!entryId) return
  if (snapshot.previousEntry) {
    const changedFields = changedLorebookEntryDraftFields(snapshot.previousEntry, attemptedEntry)
    if (changedFields.length === 0) return

    let restoredFields: LorebookEntryDirtyField[] = []
    mutateLorebookOwner(() => {
      mutateLorebookOwner(() => {
        const target = resolveLorebookCollectionFromKey(snapshot.scopeKey)
        const liveEntry = target?.entries.find((entry) => entry.id === entryId)
        if (!liveEntry) return
        restoredFields = restoreAttemptedLorebookEntryFields(
          liveEntry,
          snapshot.previousEntry as loreBook,
          attemptedEntry,
          changedFields,
        )
      })
    })
    if (restoredFields.length > 0) {
      emitLorebookEntryDraftRollback({
        scopeKey: snapshot.scopeKey,
        entryId,
        previousEntry: cloneJsonValue(snapshot.previousEntry),
        attemptedEntry: cloneJsonValue(attemptedEntry),
        restoredFields,
      })
    }
    return
  }

  const rollbackEntry: LorebookListRollbackEntry = {
    key: entryId,
    previous: null,
    attempted: cloneJsonValue(attemptedEntry),
    previousIndex: snapshot.index,
  }
  applyScopedLorebookKeyedRollback(snapshot.scopeKey, rollbackEntry)
}

function rollbackLorebookCollectionUpsert(
  scope: DiscreteLorebookEditScope,
  previousEntries: loreBook[],
  attemptedEntry: loreBook,
): void {
  const entryId = attemptedEntry.id
  if (!isStableCommandId(entryId)) return

  const previousIndex = previousEntries.findIndex((entry) => entry.id === entryId)
  const previousEntry = previousIndex >= 0 ? previousEntries[previousIndex] : null
  const rollbackEntry: LorebookListRollbackEntry = {
    key: entryId,
    previous: previousEntry ? cloneJsonValue(previousEntry) : null,
    attempted: cloneJsonValue(attemptedEntry),
    previousIndex: previousIndex >= 0 ? previousIndex : undefined,
  }
  applyScopedLorebookKeyedRollback(lorebookCollectionScopeKey(scope), rollbackEntry)
}

function rollbackLorebookCollectionDelete(
  scope: DiscreteLorebookEditScope,
  previousEntries: loreBook[],
  entryId: string,
): void {
  if (!isStableCommandId(entryId)) return
  const previousIndex = previousEntries.findIndex((entry) => entry.id === entryId)
  if (previousIndex < 0) return
  const rollbackEntry: LorebookListRollbackEntry = {
    key: entryId,
    previous: cloneJsonValue(previousEntries[previousIndex]),
    attempted: null,
    previousIndex,
  }
  applyScopedLorebookKeyedRollback(lorebookCollectionScopeKey(scope), rollbackEntry)
}

function applyScopedLorebookKeyedRollback(scopeKey: string, rollbackEntry: LorebookListRollbackEntry): void {
  const target = resolveLorebookCollectionFromKey(scopeKey)
  if (!target || !canApplyLorebookKeyedRollback(target.entries, rollbackEntry)) return

  mutateLorebookOwner(() => {
    mutateLorebookOwner(() => {
      const liveTarget = resolveLorebookCollectionFromKey(scopeKey)
      if (!liveTarget) return
      applyAttemptedKeyedListRollback<loreBook, string>({
        list: liveTarget.entries,
        entries: [rollbackEntry],
        getKey: lorebookEntryKey,
      })
    })
  })
}

function canApplyLorebookKeyedRollback(entries: loreBook[], rollbackEntry: LorebookListRollbackEntry): boolean {
  const liveIndex = entries.findIndex((entry) => lorebookEntryKey(entry) === rollbackEntry.key)
  const liveValue = liveIndex === -1 ? null : entries[liveIndex]
  return snapshotJson(liveValue) === snapshotJson(rollbackEntry.attempted)
}

function rollbackLorebookCollectionReorder(
  scope: DiscreteLorebookEditScope,
  previousIds: string[] | null,
  attemptedIds: string[],
): void {
  if (!previousIds) return
  const scopeKey = lorebookCollectionScopeKey(scope)
  const target = resolveLorebookCollectionFromKey(scopeKey)
  const liveIds = target ? lorebookEntryIds(target.entries) : null
  if (!liveIds || !sameStringArray(liveIds, attemptedIds)) return

  mutateLorebookOwner(() => {
    mutateLorebookOwner(() => {
      const liveTarget = resolveLorebookCollectionFromKey(scopeKey)
      if (!liveTarget) return
      const currentIds = lorebookEntryIds(liveTarget.entries)
      if (!currentIds || !sameStringArray(currentIds, attemptedIds)) return

      const entriesById = new Map(liveTarget.entries.map((entry) => [entry.id, entry]))
      const reordered = previousIds
        .map((entryId) => entriesById.get(entryId))
        .filter((entry): entry is loreBook => !!entry)
      if (reordered.length !== liveTarget.entries.length) return
      liveTarget.entries.splice(0, liveTarget.entries.length, ...reordered)
    })
  })
}

function rollbackLorebookCollectionFullReplace(
  scope: DiscreteLorebookEditScope,
  previousEntries: loreBook[],
  attemptedEntries: loreBook[],
): void {
  const scopeKey = lorebookCollectionScopeKey(scope)
  const target = resolveLorebookCollectionFromKey(scopeKey)
  if (!target || snapshotJson(target.entries) !== snapshotJson(attemptedEntries)) return

  mutateLorebookOwner(() => {
    mutateLorebookOwner(() => {
      const liveTarget = resolveLorebookCollectionFromKey(scopeKey)
      if (!liveTarget || snapshotJson(liveTarget.entries) !== snapshotJson(attemptedEntries)) return
      assignScopedLorebookCollection(scope, cloneJsonValue(previousEntries))
    })
  })
}

function attemptedLorebookEntryForSnapshot(
  attemptedEntries: loreBook[],
  snapshot: LorebookEntryStateSnapshot,
): loreBook | null {
  if (snapshot.entryId) {
    const byId = attemptedEntries.find((entry) => entry.id === snapshot.entryId)
    if (byId) return byId
  }
  return attemptedEntries[snapshot.index] ?? null
}

function previousLorebookEntriesForScope(
  scope: DiscreteLorebookEditScope,
  snapshot: LorebookStateSnapshot,
): loreBook[] | null {
  const scopeKey = lorebookCollectionScopeKey(scope)
  if (snapshot.scopeKey) {
    if (snapshot.scopeKey !== scopeKey || !Array.isArray(snapshot.scopedValue)) return null
    return cloneJsonValue(snapshot.scopedValue) as loreBook[]
  }

  switch (scope.kind) {
    case 'character': {
      const character = snapshot.characters.find((candidate) => candidate.chaId === scope.characterId)
      return Array.isArray(character?.globalLore) ? (cloneJsonValue(character.globalLore) as loreBook[]) : null
    }
    case 'chat': {
      for (const character of snapshot.characters) {
        const chat = character.chats?.find((candidate) => candidate.id === scope.chatId)
        if (chat) return Array.isArray(chat.localLore) ? (cloneJsonValue(chat.localLore) as loreBook[]) : null
      }
      return null
    }
    case 'global': {
      const lorebook = snapshot.loreBook.find((candidate) => candidate.id === scope.lorebookId)
      return Array.isArray(lorebook?.data) ? (cloneJsonValue(lorebook.data) as loreBook[]) : null
    }
    case 'module': {
      const module = snapshot.modules.find((candidate) => candidate.id === scope.moduleId)
      return Array.isArray(module?.lorebook) ? (cloneJsonValue(module.lorebook) as loreBook[]) : null
    }
  }
}

function assignScopedLorebookCollection(scope: DiscreteLorebookEditScope, entries: loreBook[]): boolean {
  switch (scope.kind) {
    case 'character': {
      const character = getCharacterResourceOwner(scope.characterId)
      if (!character) return false
      character.globalLore = entries as typeof character.globalLore
      return true
    }
    case 'chat': {
      const chat = findChat(scope.chatId)
      if (!chat) return false
      chat.localLore = entries as typeof chat.localLore
      return true
    }
    case 'global': {
      const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).find(
        (candidate) => candidate.id === scope.lorebookId,
      )
      if (!lorebook) return false
      lorebook.data = entries
      return true
    }
    case 'module': {
      const module = findModule(scope.moduleId)
      if (!module) return false
      module.lorebook = entries as typeof module.lorebook
      invalidateModuleRenderRevision()
      return true
    }
  }
}

function lorebookEntryKey(entry: loreBook): string | null {
  return isStableCommandId(entry.id) ? entry.id : null
}

function mutateLorebookOwner<T>(fn: () => T): T {
  return fn()
}

function isLorebookEntryStateSnapshot(snapshot: LorebookReplacementSnapshot): snapshot is LorebookEntryStateSnapshot {
  return (snapshot as LorebookEntryStateSnapshot).kind === 'entry'
}

function findChat(chatId: string): Chat | null {
  for (const character of charactersResourceState.characters ?? []) {
    const chat = character.chats?.find((candidate) => candidate.id === chatId)
    if (chat) return chat
  }
  return null
}

function uniqueCharacterIdForChat(chatId: string): string | null {
  let characterId: string | null = null
  let matches = 0
  for (const character of charactersResourceState.characters ?? []) {
    for (const chat of character.chats ?? []) {
      if (chat.id !== chatId) continue
      matches += 1
      characterId = character.chaId
    }
  }
  return matches === 1 && isStableCommandId(characterId) ? characterId : null
}

function findModule(moduleId: string): RisuModule | null {
  return (
    ((collectionsResourceState.values.modules ?? []) as RisuModule[]).find((candidate) => candidate.id === moduleId) ??
    null
  )
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

export function scopedLorebookStateSnapshot(key: string, previousSnapshot: string): LorebookStateSnapshot {
  return {
    scopeKey: key,
    scopedValue: parseSnapshotJson(previousSnapshot),
    loreBook: [],
    loreBookPage: settingsResourceState.value.loreBookPage ?? 0,
    characters: [],
    modules: [],
    selectedCharID: get(selectedCharID),
  }
}

export function restoreScopedLorebookState(snapshot: LorebookStateSnapshot): void {
  const key = snapshot.scopeKey
  if (!key) return

  mutateLorebookOwner(() => {
    if (key.startsWith('global:')) {
      const lorebookId = key.slice('global:'.length)
      const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).find(
        (candidate) => candidate.id === lorebookId,
      )
      if (lorebook && Array.isArray(snapshot.scopedValue)) {
        lorebook.data = cloneJsonValue(snapshot.scopedValue) as loreBook[]
      }
      return
    }

    if (key.startsWith('globalMeta:')) {
      const lorebookId = key.slice('globalMeta:'.length)
      const lorebook = ((collectionsResourceState.values.loreBook ?? []) as GlobalLorebook[]).find(
        (candidate) => candidate.id === lorebookId,
      )
      const value = snapshot.scopedValue
      if (
        lorebook &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as { name?: unknown }).name === 'string'
      ) {
        lorebook.name = (value as { name: string }).name
      }
      return
    }

    if (key.startsWith('character:')) {
      const characterId = key.slice('character:'.length)
      const character = getCharacterResourceOwner(characterId)
      if (character && Array.isArray(snapshot.scopedValue)) {
        character.globalLore = cloneJsonValue(snapshot.scopedValue) as typeof character.globalLore
      }
      return
    }

    if (key.startsWith('chat:')) {
      const chatId = key.slice('chat:'.length)
      const chat = findChat(chatId)
      if (chat && Array.isArray(snapshot.scopedValue)) {
        chat.localLore = cloneJsonValue(snapshot.scopedValue) as typeof chat.localLore
      }
      return
    }

    if (key.startsWith('module:')) {
      const moduleId = key.slice('module:'.length)
      const module = ((collectionsResourceState.values.modules ?? []) as RisuModule[]).find(
        (candidate) => candidate.id === moduleId,
      )
      if (module && Array.isArray(snapshot.scopedValue)) {
        module.lorebook = cloneJsonValue(snapshot.scopedValue) as typeof module.lorebook
        invalidateModuleRenderRevision()
      }
    }
  })
}

export function restoreLorebookEntryState(snapshot: LorebookEntryStateSnapshot): void {
  mutateLorebookOwner(() => {
    const target = resolveLorebookCollectionFromKey(snapshot.scopeKey)
    if (!target) return

    const index =
      snapshot.entryId && snapshot.entryId.trim()
        ? target.entries.findIndex((entry) => entry.id === snapshot.entryId)
        : -1
    const restoreIndex = index >= 0 ? index : snapshot.index

    if (!snapshot.previousEntry) {
      if (restoreIndex >= 0 && restoreIndex < target.entries.length) {
        target.entries.splice(restoreIndex, 1)
      }
      return
    }

    const previous = cloneJsonValue(snapshot.previousEntry)
    const current = target.entries[restoreIndex]
    if (current) {
      replaceLorebookEntryInPlace(current, previous)
    } else {
      target.entries.splice(Math.max(0, Math.min(restoreIndex, target.entries.length)), 0, previous)
    }
  })
}

function resolveLorebookCollectionFromKey(scopeKey: string): { entries: loreBook[] } | null {
  if (scopeKey.startsWith('global:')) {
    const lorebookId = scopeKey.slice('global:'.length)
    return resolveLorebookCollection({ kind: 'global', lorebookId })
  }
  if (scopeKey.startsWith('character:')) {
    const characterId = scopeKey.slice('character:'.length)
    return resolveLorebookCollection({ kind: 'character', characterId })
  }
  if (scopeKey.startsWith('chat:')) {
    const chatId = scopeKey.slice('chat:'.length)
    return resolveLorebookCollection({ kind: 'chat', chatId })
  }
  if (scopeKey.startsWith('module:')) {
    const moduleId = scopeKey.slice('module:'.length)
    return resolveLorebookCollection({ kind: 'module', moduleId })
  }
  return null
}

function parseSnapshotJson(snapshot: string): unknown {
  if (snapshot === '__undefined__') return undefined
  return JSON.parse(snapshot)
}

function cloneLorebookEntriesForCommand(entries: loreBook[]): LorebookEntrySnapshot[] {
  const cloned = cloneJsonValue(entries ?? [])
  ensureClientLorebookEntryIds(cloned)
  return cloned as LorebookEntrySnapshot[]
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}
