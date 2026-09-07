import {
  canUseClientWriteAccess,
  assertClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { untrack } from 'svelte'
import { v4 } from 'uuid'
import type { RisuModule } from '../process/modules'
import { type Database, type character, type customscript, type triggerscript } from '../storage/database.svelte'
import {
  canUseServerCommands,
  mutateGlobalScriptsCommand,
  mutateCharacterScriptsCommand,
  mutateCharacterTriggersCommand,
  mutateModuleScriptsCommand,
  mutateModuleTriggersCommand,
  patchSettingsGroup,
  replaceCharacterScriptsCommand,
  replaceCharacterTriggersCommand,
  replaceModuleScriptsCommand,
  replaceModuleTriggersCommand,
  runServerCommand,
  type ScriptDefinitionSnapshot,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
  type TriggerDefinitionSnapshot,
} from './commands'
import {
  captureCharacterRowProjectionEpoch,
  captureCollectionProjectionEpoch,
  captureSettingsGroupProjectionEpoch,
  charactersResourceState,
  collectionsResourceState,
  hasCharacterRowProjectionEpochChanged,
  hasCollectionProjectionEpochChanged,
  hasSettingsGroupProjectionEpochChanged,
  settingsResourceState,
} from './resourceState.svelte'
import { mergeProjectionIntoDirtyDraft } from './staleStateGuards'
import {
  classifyScriptDefinitionMutation,
  type ScriptDefinitionCollectionMutation,
  type ScriptDefinitionMutationPlan,
} from './scriptDefinitionMutations'
import { dispatchDurableMutation, registerDurableMutationSettlementListener } from './durableMutationDispatch'
import { registerPendingOwnerMutationFlusher } from './pendingOwnerMutationRegistry'
import {
  acknowledgePendingMutation,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
} from './pendingMutationOutbox'
import { characterOwnerMutationKey, moduleOwnerMutationKey } from './resourceOwnerMutationKeys'
import { invalidateModuleRenderRevision } from '../moduleRenderRevision'

function characterDefinitionOwners(): character[] {
  return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
}

function moduleDefinitionOwners(): RisuModule[] {
  if (collectionsResourceState.statuses.modules !== 'ready') return []
  const modules = collectionsResourceState.values.modules
  return Array.isArray(modules) ? (modules as RisuModule[]) : []
}

function scriptSettingsOwner(): Record<string, unknown> | null {
  return settingsResourceState.groupStatuses.advanced === 'ready'
    ? (settingsResourceState.value as unknown as Record<string, unknown>)
    : null
}

function withScriptDefinitionOwnerWrite<T>(write: () => T): T {
  const result = write()
  invalidateModuleRenderRevision()
  return result
}

export interface ScriptDefinitionStateSnapshot {
  characters: character[]
  modules: RisuModule[]
}

/**
 * A scoped rollback that restores only the changed owner row's scripts/triggers,
 * so a failed replacement does not need the whole
 * characters+modules snapshot. The `scripts`/`triggers` value is the pre-edit
 * array (the collected per-key snapshots are always arrays, so an empty/missing
 * field restores to `[]`).
 */
export type ScopedScriptDefinitionRollback =
  | { kind: 'globalScripts'; scripts: customscript[]; hadScriptsField?: boolean }
  | { kind: 'characterScripts'; characterId: string; scripts: customscript[]; hadScriptsField?: boolean }
  | { kind: 'characterTriggers'; characterId: string; triggers: triggerscript[]; hadTriggersField?: boolean }
  | { kind: 'moduleScripts'; moduleId: string; scripts: customscript[] }
  | { kind: 'moduleTriggers'; moduleId: string; triggers: triggerscript[] }

export type ScopedScriptDefinitionAttempt =
  | { kind: 'globalScripts'; scripts: customscript[] }
  | { kind: 'characterScripts'; characterId: string; scripts: customscript[] }
  | { kind: 'characterTriggers'; characterId: string; triggers: triggerscript[] }
  | { kind: 'moduleScripts'; moduleId: string; scripts: customscript[] }
  | { kind: 'moduleTriggers'; moduleId: string; triggers: triggerscript[] }

/**
 * Rollback accepted by the dispatch functions. Owner drafts pass a scoped
 * single-row rollback; rarer multi-owner operations keep passing the full
 * `ScriptDefinitionStateSnapshot`.
 */
export type ScriptDefinitionRollback = ScriptDefinitionStateSnapshot | ScopedScriptDefinitionRollback

interface PendingCollectionReplacement {
  sessionGeneration: number
  key: string
  previous: ScriptDefinitionRollback
  finalDefinitions: readonly unknown[]
  characterRowProjection?: { characterId: string; epoch: number }
  moduleCollectionProjectionEpoch?: number
  settingsGroupProjectionEpoch?: number
  timer: ReturnType<typeof setTimeout> | null
  // The command receives the coalesced rollback baseline at fire time rather than
  // closing over a per-dispatch value, so debounced same-key edits roll back to
  // the first baseline (see `queueReplacement`), not the intermediate one.
  command: (
    rollback: ScriptDefinitionRollback,
    plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>,
    options?: ServerCommandTransportOptions,
  ) => Promise<ServerCommandResult<Record<string, unknown>>>
  plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>
  intent: DurableMutationIntent
  outbox: PendingMutationHandle
  settlementCleanup?: () => void
  validateCurrent?: () => boolean
}

interface QueuedScriptDefinitionMutation {
  kind: ScopedScriptDefinitionRollback['kind']
  targetId: string
  finalDefinitions: readonly unknown[]
  validateCurrent?: () => boolean
}

type ScriptDefinitionProjectionFence =
  | { kind: 'character'; characterId: string; epoch: number }
  | { kind: 'modules'; epoch: number }
  | { kind: 'settings'; group: 'advanced'; epoch: number }

interface ScriptDefinitionMutationSafetyState {
  fence: ScriptDefinitionProjectionFence
  forceReplacement: boolean
  crossProjectionTaint: boolean
  unsettled: DispatchedScriptDefinitionAttempt[]
}

interface ScriptDefinitionCollectionBaseline {
  rows: readonly unknown[]
  fieldPresent: boolean
}

interface DispatchedScriptDefinitionAttempt {
  key: string
  kind: ScopedScriptDefinitionRollback['kind']
  targetId: string
  rollback: ScriptDefinitionRollback
  attemptedRows: readonly unknown[]
  fullReplacement: boolean
  state: ScriptDefinitionMutationSafetyState
  settled: boolean
}

interface PendingCharacterScriptDefinitionDraft {
  sessionGeneration: number
  characterId: string
  scripts: customscript[]
  triggers: triggerscript[]
  timer: ReturnType<typeof setTimeout>
}

interface TrackedScriptDefinitionDispatch {
  immediate: Promise<ServerCommandResult<Record<string, unknown>>>
  final: Promise<boolean>
  settleFinal: (accepted: boolean) => void
}

export type PendingCharacterScriptDefinitionSaveOutcome = 'idle' | 'saved' | 'queued' | 'failed'

export interface WaitForPendingCharacterScriptDefinitionSaveOptions {
  finalSettlement?: boolean
}

export interface CharacterScriptDefinitionStructuralWriteAttempt {
  readonly key: string
}

const pendingReplacements = new Map<string, PendingCollectionReplacement>()
const pendingCharacterScriptDefinitionDrafts = new Map<string, PendingCharacterScriptDefinitionDraft>()
const trackedScriptDefinitionDispatches = new Map<string, Set<TrackedScriptDefinitionDispatch>>()
const successfulScriptDefinitionFinalOutcomeKeys = new Set<string>()
const mutationSafetyByKey = new Map<string, ScriptDefinitionMutationSafetyState>()
const structuralWriteAttempts = new WeakMap<
  CharacterScriptDefinitionStructuralWriteAttempt,
  DispatchedScriptDefinitionAttempt
>()

export const CHARACTER_SCRIPT_DEFINITION_SAVE_DELAY_MS = 300

export function currentScriptDefinitionStateSnapshot(): ScriptDefinitionStateSnapshot {
  return {
    characters: cloneJsonValue(characterDefinitionOwners()),
    modules: cloneJsonValue(moduleDefinitionOwners()),
  }
}

export function restoreScriptDefinitionState(snapshot: ScriptDefinitionStateSnapshot): void {
  withScriptDefinitionOwnerWrite(() => {
    if (charactersResourceState.status === 'ready') {
      charactersResourceState.characters = cloneJsonValue(snapshot.characters)
    }
    if (collectionsResourceState.statuses.modules === 'ready') {
      collectionsResourceState.values.modules = cloneJsonValue(snapshot.modules) as Database['modules']
    }
  })
}

/**
 * Coalesce character-sidebar editor activity before any cloning, diffing, or
 * durable outbox work begins. The draft arrays remain owned by the mounted
 * editor and are only read when the trailing timer (or an explicit flush)
 * fires.
 */
export function scheduleCharacterScriptDefinitionDraft(
  characterId: string | null | undefined,
  scripts: customscript[],
  triggers: triggerscript[],
  delayMs = CHARACTER_SCRIPT_DEFINITION_SAVE_DELAY_MS,
): boolean {
  if (!canUseClientWriteAccess()) return false
  if (!characterId) return false
  if (!characterDefinitionOwners().some((candidate) => candidate.chaId === characterId)) return false

  successfulScriptDefinitionFinalOutcomeKeys.delete(`characterScripts:${characterId}`)
  successfulScriptDefinitionFinalOutcomeKeys.delete(`characterTriggers:${characterId}`)
  const previous = pendingCharacterScriptDefinitionDrafts.get(characterId)
  if (previous) clearTimeout(previous.timer)
  const pending: PendingCharacterScriptDefinitionDraft = {
    sessionGeneration: captureClientSessionGeneration(),
    characterId,
    scripts,
    triggers,
    timer: setTimeout(() => flushPendingCharacterScriptDefinitionDraft(characterId), delayMs),
  }
  pendingCharacterScriptDefinitionDrafts.set(characterId, pending)
  return true
}

export function flushPendingCharacterScriptDefinitionDraft(characterId: string): boolean {
  if (!canUseClientWriteAccess()) return false
  const pending = pendingCharacterScriptDefinitionDrafts.get(characterId)
  if (!pending || !isClientSessionGenerationCurrent(pending.sessionGeneration)) return false
  clearTimeout(pending.timer)
  pendingCharacterScriptDefinitionDrafts.delete(characterId)
  return applyCharacterScriptDefinitionDraft(characterId, pending.scripts, pending.triggers, 0)
}

/**
 * Flush and observe both script-definition collections owned by a character.
 * Display activation asks for final durable settlement; generation uses the
 * immediate outcome so an offline/failed save blocks the send instead of
 * hanging indefinitely.
 */
export async function waitForPendingCharacterScriptDefinitionSave(
  characterId: string | null | undefined,
  options: WaitForPendingCharacterScriptDefinitionSaveOptions = {},
): Promise<PendingCharacterScriptDefinitionSaveOutcome> {
  if (!characterId) return 'idle'

  flushPendingCharacterScriptDefinitionDraft(characterId)
  const keys = [`characterScripts:${characterId}`, `characterTriggers:${characterId}`]
  for (const key of keys) runPendingScriptDefinitionReplacement(key)

  const dispatches = keys.flatMap((key) => Array.from(trackedScriptDefinitionDispatches.get(key) ?? []))
  if (dispatches.length === 0) {
    return keys.some((key) => successfulScriptDefinitionFinalOutcomeKeys.has(key)) ? 'saved' : 'idle'
  }

  if (options.finalSettlement) {
    const settlements = await Promise.all(dispatches.map((dispatch) => dispatch.final))
    return settlements.every(Boolean) ? 'saved' : 'failed'
  }

  const results = await Promise.all(
    dispatches.map((dispatch) =>
      dispatch.immediate.catch(() => ({ status: 'error', error: 'Script definition save failed.' }) as const),
    ),
  )
  if (results.every((result) => result.status === 'ok')) return 'saved'
  return results.some((result) => result.status === 'unavailable' || result.status === 'conflict') ? 'queued' : 'failed'
}

export function resetPendingCharacterScriptDefinitionDraftsForTests(): void {
  for (const pending of pendingCharacterScriptDefinitionDrafts.values()) clearTimeout(pending.timer)
  pendingCharacterScriptDefinitionDrafts.clear()
  for (const dispatches of trackedScriptDefinitionDispatches.values()) {
    for (const dispatch of dispatches) dispatch.settleFinal(false)
  }
  trackedScriptDefinitionDispatches.clear()
  successfulScriptDefinitionFinalOutcomeKeys.clear()
}

export function applyCharacterScriptDefinitionDraft(
  characterId: string | null | undefined,
  scripts: customscript[],
  triggers: triggerscript[],
  delayMs = 250,
): boolean {
  if (!canUseClientWriteAccess()) return false
  if (!characterId) return false
  const character = characterDefinitionOwners().find((candidate) => candidate.chaId === characterId)
  if (!character) return false

  const previousScripts = cloneJsonValue(character.customscript ?? [])
  const previousTriggers = cloneJsonValue(character.triggerscript ?? [])
  const hadScriptsField = Object.prototype.hasOwnProperty.call(character, 'customscript')
  const hadTriggersField = Object.prototype.hasOwnProperty.call(character, 'triggerscript')
  const nextScripts = ensureClientScriptDefinitionIds(cloneJsonValue(scripts))
  const nextTriggers = ensureClientTriggerDefinitionIds(cloneJsonValue(triggers))
  const scriptsChanged = snapshotJson(previousScripts) !== snapshotJson(nextScripts)
  const triggersChanged = snapshotJson(previousTriggers) !== snapshotJson(nextTriggers)
  let applied = false

  withScriptDefinitionOwnerWrite(() => {
    const target = characterDefinitionOwners().find((candidate) => candidate.chaId === characterId)
    if (!target) return
    if (scriptsChanged || hadScriptsField) {
      target.customscript = cloneJsonValue(nextScripts)
    }
    if (triggersChanged || hadTriggersField) {
      target.triggerscript = cloneJsonValue(nextTriggers)
    }
    applied = true
  })

  if (applied && scriptsChanged) {
    dispatchReplaceCharacterScripts(
      characterId,
      nextScripts,
      {
        kind: 'characterScripts',
        characterId,
        scripts: previousScripts,
        hadScriptsField,
      },
      delayMs,
    )
  }
  if (applied && triggersChanged) {
    dispatchReplaceCharacterTriggers(
      characterId,
      nextTriggers,
      {
        kind: 'characterTriggers',
        characterId,
        triggers: previousTriggers,
        hadTriggersField,
      },
      delayMs,
    )
  }
  return applied
}

export function applyModuleScriptDefinitionDraft(
  moduleId: string | null | undefined,
  currentModule: RisuModule | null | undefined,
  scripts: customscript[],
  triggers: triggerscript[],
  delayMs = 250,
): boolean {
  if (!canUseClientWriteAccess()) return false
  if (!moduleId) return false

  const liveModule = findModule(moduleId)
  const draftModule = currentModule?.id === moduleId ? currentModule : null
  if (!liveModule && !draftModule) return false

  const previousScripts = cloneJsonValue(liveModule?.regex ?? [])
  const previousTriggers = cloneJsonValue(liveModule?.trigger ?? [])
  const hadLiveScriptsField = liveModule ? Object.prototype.hasOwnProperty.call(liveModule, 'regex') : false
  const hadLiveTriggersField = liveModule ? Object.prototype.hasOwnProperty.call(liveModule, 'trigger') : false
  const hadDraftScriptsField = draftModule ? Object.prototype.hasOwnProperty.call(draftModule, 'regex') : false
  const hadDraftTriggersField = draftModule ? Object.prototype.hasOwnProperty.call(draftModule, 'trigger') : false
  const nextScripts = ensureClientScriptDefinitionIds(cloneJsonValue(scripts ?? []))
  const nextTriggers = ensureClientTriggerDefinitionIds(cloneJsonValue(triggers ?? []))
  const scriptsChanged = liveModule ? snapshotJson(previousScripts) !== snapshotJson(nextScripts) : false
  const triggersChanged = liveModule ? snapshotJson(previousTriggers) !== snapshotJson(nextTriggers) : false
  const shouldAssignScripts = scriptsChanged || hadLiveScriptsField || hadDraftScriptsField
  const shouldAssignTriggers = triggersChanged || hadLiveTriggersField || hadDraftTriggersField
  let applied = false

  withScriptDefinitionOwnerWrite(() => {
    const targetLiveModule = findModule(moduleId)
    const targetDraftModule = currentModule?.id === moduleId ? currentModule : null
    if (!targetLiveModule && !targetDraftModule) return

    if (targetLiveModule) {
      if (shouldAssignScripts) targetLiveModule.regex = cloneJsonValue(nextScripts)
      if (shouldAssignTriggers) targetLiveModule.trigger = cloneJsonValue(nextTriggers)
    }
    if (targetDraftModule) {
      if (shouldAssignScripts) targetDraftModule.regex = cloneJsonValue(nextScripts)
      if (shouldAssignTriggers) targetDraftModule.trigger = cloneJsonValue(nextTriggers)
    }
    applied = true
  })

  if (!applied) return false

  if (liveModule && scriptsChanged) {
    dispatchReplaceModuleScripts(
      moduleId,
      nextScripts,
      {
        kind: 'moduleScripts',
        moduleId,
        scripts: previousScripts,
      },
      delayMs,
    )
  }
  if (liveModule && triggersChanged) {
    dispatchReplaceModuleTriggers(
      moduleId,
      nextTriggers,
      {
        kind: 'moduleTriggers',
        moduleId,
        triggers: previousTriggers,
      },
      delayMs,
    )
  }
  return true
}

export function ensureClientScriptDefinitionIds(scripts: customscript[]): customscript[] {
  return ensureUniqueClientDefinitionIds(scripts)
}

export function ensureClientTriggerDefinitionIds(triggers: triggerscript[]): triggerscript[] {
  return ensureUniqueClientDefinitionIds(triggers)
}

function ensureUniqueClientDefinitionIds<T extends { id?: string }>(definitions: T[]): T[] {
  const seen = new Set<string>()
  for (const definition of definitions ?? []) {
    let id = typeof definition.id === 'string' && definition.id.trim() ? definition.id : ''
    if (!id || seen.has(id)) {
      do {
        id = v4()
      } while (seen.has(id))
      definition.id = id
    }
    seen.add(id)
  }
  return definitions
}

export function dispatchReplaceCharacterScripts(
  characterId: string,
  scripts: customscript[],
  previous: ScriptDefinitionRollback,
  delayMs = 250,
): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  const optimisticRowEpoch = captureCharacterRowProjectionEpoch(characterId)
  ensureClientScriptDefinitionIds(scripts)
  const scriptPayload = cloneJsonValue(scripts) as ScriptDefinitionSnapshot[]
  const attemptedScripts = cloneJsonValue(scriptPayload) as customscript[]
  queueReplacement(
    `characterScripts:${characterId}`,
    previous,
    (rollback, plan, options = {}) =>
      runCharacterScriptsDefinitionCommand(
        characterId,
        scriptPayload,
        attemptedScripts,
        rollback,
        optimisticRowEpoch,
        plan,
        options,
      ),
    delayMs,
    { characterId, epoch: optimisticRowEpoch },
    undefined,
    undefined,
    { kind: 'characterScripts', targetId: characterId, finalDefinitions: scriptPayload },
  )
}

export function dispatchReplaceCharacterTriggers(
  characterId: string,
  triggers: triggerscript[],
  previous: ScriptDefinitionRollback,
  delayMs = 250,
): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  const optimisticRowEpoch = captureCharacterRowProjectionEpoch(characterId)
  ensureClientTriggerDefinitionIds(triggers)
  const triggerPayload = cloneJsonValue(triggers) as TriggerDefinitionSnapshot[]
  const attemptedTriggers = cloneJsonValue(triggerPayload) as triggerscript[]
  queueReplacement(
    `characterTriggers:${characterId}`,
    previous,
    (rollback, plan, options = {}) =>
      runCharacterTriggersDefinitionCommand(
        characterId,
        triggerPayload,
        attemptedTriggers,
        rollback,
        optimisticRowEpoch,
        plan,
        options,
      ),
    delayMs,
    { characterId, epoch: optimisticRowEpoch },
    undefined,
    undefined,
    { kind: 'characterTriggers', targetId: characterId, finalDefinitions: triggerPayload },
  )
}

export function dispatchReplaceModuleScripts(
  moduleId: string,
  scripts: customscript[],
  previous: ScriptDefinitionRollback,
  delayMs = 250,
): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  const optimisticCollectionEpoch = captureCollectionProjectionEpoch('modules')
  ensureClientScriptDefinitionIds(scripts)
  const scriptPayload = cloneJsonValue(scripts) as ScriptDefinitionSnapshot[]
  const attemptedScripts = cloneJsonValue(scriptPayload) as customscript[]
  queueReplacement(
    `moduleScripts:${moduleId}`,
    previous,
    (rollback, plan, options = {}) =>
      runModuleScriptsDefinitionCommand(
        moduleId,
        scriptPayload,
        attemptedScripts,
        rollback,
        optimisticCollectionEpoch,
        plan,
        options,
      ),
    delayMs,
    undefined,
    optimisticCollectionEpoch,
    undefined,
    { kind: 'moduleScripts', targetId: moduleId, finalDefinitions: scriptPayload },
  )
}

export function dispatchReplaceModuleTriggers(
  moduleId: string,
  triggers: triggerscript[],
  previous: ScriptDefinitionRollback,
  delayMs = 250,
): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  const optimisticCollectionEpoch = captureCollectionProjectionEpoch('modules')
  ensureClientTriggerDefinitionIds(triggers)
  const triggerPayload = cloneJsonValue(triggers) as TriggerDefinitionSnapshot[]
  const attemptedTriggers = cloneJsonValue(triggerPayload) as triggerscript[]
  queueReplacement(
    `moduleTriggers:${moduleId}`,
    previous,
    (rollback, plan, options = {}) =>
      runModuleTriggersDefinitionCommand(
        moduleId,
        triggerPayload,
        attemptedTriggers,
        rollback,
        optimisticCollectionEpoch,
        plan,
        options,
      ),
    delayMs,
    undefined,
    optimisticCollectionEpoch,
    undefined,
    { kind: 'moduleTriggers', targetId: moduleId, finalDefinitions: triggerPayload },
  )
}

export function beginCharacterScriptDefinitionStructuralWrite(
  kind: 'characterScripts' | 'characterTriggers',
  characterId: string,
  definitions: readonly unknown[],
  rollback: Extract<ScopedScriptDefinitionRollback, { kind: typeof kind }>,
  optimisticRowEpoch: number,
): CharacterScriptDefinitionStructuralWriteAttempt {
  assertClientWriteAccess()
  const key = `${kind}:${characterId}`
  if (!canUseServerCommands()) return Object.freeze({ key })

  // Persist any earlier debounced edit before the structural full PUT. The
  // global command queue serializes that write ahead of this external attempt,
  // while attempt settlement rebases this rollback if the earlier write fails.
  runPendingScriptDefinitionReplacement(key)

  const state = mutationSafetyState(key, {
    kind: 'character',
    characterId,
    epoch: optimisticRowEpoch,
  })
  const attempt = createScriptDefinitionAttempt({
    key,
    kind,
    targetId: characterId,
    rollback,
    attemptedRows: definitions,
    fullReplacement: true,
    state,
  })
  state.unsettled.push(attempt)

  const handle: CharacterScriptDefinitionStructuralWriteAttempt = Object.freeze({ key })
  structuralWriteAttempts.set(handle, attempt)
  return handle
}

export function acknowledgeCharacterScriptDefinitionStructuralWrite(
  handle: CharacterScriptDefinitionStructuralWriteAttempt,
): void {
  const attempt = structuralWriteAttempts.get(handle)
  if (!attempt) return
  structuralWriteAttempts.delete(handle)
  settleScriptDefinitionAttempt(attempt, true)
}

export function rejectCharacterScriptDefinitionStructuralWrite(
  handle: CharacterScriptDefinitionStructuralWriteAttempt,
): void {
  const attempt = structuralWriteAttempts.get(handle)
  if (!attempt) return
  structuralWriteAttempts.delete(handle)
  attempt.state.forceReplacement = true
  settleScriptDefinitionAttempt(attempt, false)
}

export function watchGlobalScriptOwnerDraft(options: { delayMs?: number } = {}): () => void {
  const sessionGeneration = captureClientSessionGeneration()
  if (!canUseClientWriteAccess()) return () => {}
  if (!canUseServerCommands()) return () => {}
  const delayMs = options.delayMs ?? 250
  let initialized = false
  let previousSnapshot = ''
  let previousProjectionEpoch = captureSettingsGroupProjectionEpoch('advanced')

  const stop = $effect.root(() => {
    $effect(() => {
      const projectionEpoch = captureSettingsGroupProjectionEpoch('advanced')
      const scripts = currentGlobalScriptsForWatchedCommand()
      const currentSnapshot = scripts ? snapshotJson(scripts) : ''

      if (!initialized || projectionEpoch !== previousProjectionEpoch) {
        initialized = true
        previousProjectionEpoch = projectionEpoch
        previousSnapshot = currentSnapshot
        return
      }
      if (!scripts || currentSnapshot === previousSnapshot) return
      untrack(() => {
        if (!isClientSessionGenerationCurrent(sessionGeneration)) return
        queueWatchedGlobalScripts(previousSnapshot, delayMs)
      })
      previousSnapshot = currentSnapshot
    })
  })

  return stop
}

export type ScriptDefinitionDirtyFieldsById = Map<string, Set<string>>
type ScriptDefinitionRow = customscript | triggerscript
type ScriptDefinitionRowRecord = Record<string, unknown> & { id?: unknown }

export function markDirtyScriptDefinitionRowFields<T extends ScriptDefinitionRow>(
  dirtyFieldsById: ScriptDefinitionDirtyFieldsById,
  previousRows: T[],
  currentRows: T[],
): void {
  const previousRowsById = scriptDefinitionRowsById(previousRows)
  const currentRowIds = new Set<string>()

  for (const currentRow of currentRows ?? []) {
    const rowId = scriptDefinitionRowId(currentRow)
    if (!rowId) continue
    currentRowIds.add(rowId)

    const previousRow = previousRowsById.get(rowId)
    if (!previousRow) continue

    const changedFields = changedScriptDefinitionRowFields(previousRow, currentRow)
    if (changedFields.length === 0) continue

    let dirtyFields = dirtyFieldsById.get(rowId)
    if (!dirtyFields) {
      dirtyFields = new Set()
      dirtyFieldsById.set(rowId, dirtyFields)
    }

    for (const field of changedFields) {
      dirtyFields.add(field)
    }
  }

  pruneDirtyScriptDefinitionRows(dirtyFieldsById, currentRowIds)
}

export function clearDirtyScriptDefinitionFieldsMatchingAttempt<T extends ScriptDefinitionRow>(
  dirtyFieldsById: ScriptDefinitionDirtyFieldsById,
  draftRows: T[],
  attemptedRows: T[],
): void {
  const draftRowsById = scriptDefinitionRowsById(draftRows)
  const attemptedRowsById = scriptDefinitionRowsById(attemptedRows)

  for (const [rowId, dirtyFields] of Array.from(dirtyFieldsById.entries())) {
    const draftRow = draftRowsById.get(rowId)
    const attemptedRow = attemptedRowsById.get(rowId)

    if (!draftRow || !attemptedRow) continue

    const draftRecord = scriptDefinitionRowAsRecord(draftRow)
    const attemptedRecord = scriptDefinitionRowAsRecord(attemptedRow)
    for (const field of Array.from(dirtyFields)) {
      if (snapshotJson(draftRecord[field]) === snapshotJson(attemptedRecord[field])) {
        dirtyFields.delete(field)
      }
    }

    if (dirtyFields.size === 0) {
      dirtyFieldsById.delete(rowId)
    }
  }
}

export function pruneDirtyScriptDefinitionRows(
  dirtyFieldsById: ScriptDefinitionDirtyFieldsById,
  currentRowIds: ReadonlySet<string>,
): void {
  for (const rowId of Array.from(dirtyFieldsById.keys())) {
    if (!currentRowIds.has(rowId)) {
      dirtyFieldsById.delete(rowId)
    }
  }
}

export function mergeScriptDefinitionProjectionRows<T extends ScriptDefinitionRow>(
  draftRows: T[],
  projectionRows: T[],
  dirtyFieldsById: ScriptDefinitionDirtyFieldsById,
): T[] | null {
  if (!sameUniqueScriptDefinitionRowIdSet(draftRows, projectionRows)) return null

  const draftRowsById = scriptDefinitionRowsById(draftRows)
  return projectionRows.map((projectionRow) => {
    const rowId = scriptDefinitionRowId(projectionRow)
    const dirtyFields = rowId ? dirtyFieldsById.get(rowId) : undefined
    const draftRow = rowId ? draftRowsById.get(rowId) : undefined

    if (!rowId || !dirtyFields || dirtyFields.size === 0 || !draftRow) {
      return cloneJsonValue(projectionRow)
    }

    return mergeProjectionIntoDirtyDraft({
      draft: cloneJsonValue(scriptDefinitionRowAsRecord(draftRow)),
      projection: scriptDefinitionRowAsRecord(projectionRow),
      dirtyFields,
    }) as T
  })
}

function changedScriptDefinitionRowFields<T extends ScriptDefinitionRow>(previousRow: T, currentRow: T): string[] {
  const previous = scriptDefinitionRowAsRecord(previousRow)
  const current = scriptDefinitionRowAsRecord(currentRow)
  const changedFields: string[] = []
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])

  for (const key of keys) {
    if (key === 'id') continue
    if (snapshotJson(previous[key]) !== snapshotJson(current[key])) {
      changedFields.push(key)
    }
  }

  return changedFields
}

function sameUniqueScriptDefinitionRowIdSet<T extends ScriptDefinitionRow>(leftRows: T[], rightRows: T[]): boolean {
  if (leftRows.length !== rightRows.length) return false

  const leftIds = uniqueScriptDefinitionRowIdSet(leftRows)
  const rightIds = uniqueScriptDefinitionRowIdSet(rightRows)
  if (!leftIds || !rightIds || leftIds.size !== rightIds.size) return false

  for (const leftId of leftIds) {
    if (!rightIds.has(leftId)) return false
  }

  return true
}

function uniqueScriptDefinitionRowIdSet<T extends ScriptDefinitionRow>(rows: T[]): Set<string> | null {
  const rowIds = new Set<string>()
  for (const row of rows) {
    const rowId = scriptDefinitionRowId(row)
    if (!rowId || rowIds.has(rowId)) {
      return null
    }
    rowIds.add(rowId)
  }

  return rowIds
}

function scriptDefinitionRowsById<T extends ScriptDefinitionRow>(rows: T[]): Map<string, T> {
  const rowsById = new Map<string, T>()
  for (const row of rows ?? []) {
    const rowId = scriptDefinitionRowId(row)
    if (rowId) rowsById.set(rowId, row)
  }
  return rowsById
}

function scriptDefinitionRowId(row: ScriptDefinitionRow | undefined): string | null {
  const id = row ? scriptDefinitionRowAsRecord(row).id : null
  return typeof id === 'string' && id.trim() ? id : null
}

function scriptDefinitionRowAsRecord(row: ScriptDefinitionRow): ScriptDefinitionRowRecord {
  return row as unknown as ScriptDefinitionRowRecord
}

function queueReplacement(
  key: string,
  previous: ScriptDefinitionRollback,
  command: (
    rollback: ScriptDefinitionRollback,
    plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>,
    options?: ServerCommandTransportOptions,
  ) => Promise<ServerCommandResult<Record<string, unknown>>>,
  delay: number,
  characterRowProjection?: { characterId: string; epoch: number },
  moduleCollectionProjectionEpoch?: number,
  settingsGroupProjectionEpoch?: number,
  mutation?: QueuedScriptDefinitionMutation,
): void {
  if (!canUseClientWriteAccess()) return
  if (!mutation) throw new TypeError('A queued script-definition mutation is required')
  const existing = pendingReplacements.get(key)
  if (existing?.timer) clearTimeout(existing.timer)

  const sameCharacterRowProjection =
    existing?.characterRowProjection?.characterId === characterRowProjection?.characterId &&
    existing?.characterRowProjection?.epoch === characterRowProjection?.epoch
  const sameModuleCollectionProjection = existing?.moduleCollectionProjectionEpoch === moduleCollectionProjectionEpoch
  const sameSettingsGroupProjection = existing?.settingsGroupProjectionEpoch === settingsGroupProjectionEpoch
  const sameProjection = characterRowProjection
    ? sameCharacterRowProjection
    : moduleCollectionProjectionEpoch !== undefined
      ? sameModuleCollectionProjection
      : settingsGroupProjectionEpoch !== undefined
        ? sameSettingsGroupProjection
        : existing?.characterRowProjection === undefined &&
          existing?.moduleCollectionProjectionEpoch === undefined &&
          existing?.settingsGroupProjectionEpoch === undefined

  // Coalesced same-key edits keep the first dispatch's baseline, so a failed
  // final command rolls back to the pre-first-edit value rather than an
  // intermediate edit that was never durably committed. An authoritative row
  // replacement starts a new ownership epoch, so the next edit must also start
  // a new rollback baseline.
  const effectivePrevious = existing && sameProjection ? existing.previous : previous
  const fence = scriptDefinitionProjectionFence(
    characterRowProjection,
    moduleCollectionProjectionEpoch,
    settingsGroupProjectionEpoch,
  )
  if (!fence) throw new TypeError('A queued script-definition projection fence is required')
  let plan = planScriptDefinitionMutation(key, mutation, effectivePrevious, fence)
  let correctionOnly = false
  if (
    existing &&
    sameProjection &&
    snapshotJson(existing.finalDefinitions) !== snapshotJson(mutation.finalDefinitions)
  ) {
    if (
      plan.kind === 'none' ||
      (plan.kind === 'mutation' &&
        !scriptDefinitionMutationProducesFinal(existing.finalDefinitions, plan.mutation, mutation.finalDefinitions))
    ) {
      // Durable restaging can preserve a predecessor once another tab has
      // frozen its dispatch marker. A sparse successor is safe only when it
      // also transforms that predecessor's final collection into this one.
      // Otherwise persist an absolute correction for the full collection.
      plan = { kind: 'replace' }
      correctionOnly = true
    } else if (plan.kind === 'replace') {
      correctionOnly = true
    }
  }
  if (plan.kind === 'none') {
    if (existing) {
      existing.settlementCleanup?.()
      void acknowledgePendingMutation(existing.outbox)
    }
    pendingReplacements.delete(key)
    return
  }

  const intent = scriptDefinitionDurableIntent(mutation, plan)
  const outbox = stagePendingMutation(
    scriptDefinitionOwnerMutationKey(key, mutation),
    intent,
    existing && sameProjection ? existing.outbox : undefined,
  )
  const pending: PendingCollectionReplacement = {
    sessionGeneration: captureClientSessionGeneration(),
    key,
    previous: effectivePrevious,
    finalDefinitions: cloneJsonValue(mutation.finalDefinitions),
    ...(characterRowProjection ? { characterRowProjection } : {}),
    ...(moduleCollectionProjectionEpoch !== undefined ? { moduleCollectionProjectionEpoch } : {}),
    ...(settingsGroupProjectionEpoch !== undefined ? { settingsGroupProjectionEpoch } : {}),
    command,
    plan,
    intent,
    outbox,
    ...(mutation.validateCurrent ? { validateCurrent: mutation.validateCurrent } : {}),
    timer: null,
  }
  if (existing && sameProjection) existing.settlementCleanup?.()
  trackPendingScriptDefinitionSettlement(pending)
  pendingReplacements.set(key, pending)
  if (correctionOnly) {
    runPendingScriptDefinitionReplacement(key)
  } else {
    pending.timer = setTimeout(() => runPendingScriptDefinitionReplacement(key), delay)
  }
}

function scriptDefinitionMutationProducesFinal(
  previousRows: readonly unknown[],
  mutation: ScriptDefinitionCollectionMutation,
  finalRows: readonly unknown[],
): boolean {
  if (!Array.isArray(previousRows)) return false
  const rows = cloneJsonValue(previousRows) as unknown[]

  switch (mutation.op) {
    case 'update': {
      const index = rows.findIndex((row) => scriptDefinitionRowIdFromUnknown(row) === mutation.id)
      if (index < 0) return false
      const current = rows[index]
      if (!current || typeof current !== 'object' || Array.isArray(current)) return false
      const updated = { ...(current as Record<string, unknown>), ...cloneJsonValue(mutation.patch), id: mutation.id }
      for (const key of mutation.deleteKeys) delete updated[key]
      rows[index] = updated
      break
    }
    case 'create': {
      const rowId = scriptDefinitionRowIdFromUnknown(mutation.row)
      if (
        !rowId ||
        rows.some((row) => scriptDefinitionRowIdFromUnknown(row) === rowId) ||
        mutation.index < 0 ||
        mutation.index > rows.length
      ) {
        return false
      }
      rows.splice(mutation.index, 0, cloneJsonValue(mutation.row))
      break
    }
    case 'delete': {
      const index = rows.findIndex((row) => scriptDefinitionRowIdFromUnknown(row) === mutation.id)
      if (index < 0) return false
      rows.splice(index, 1)
      break
    }
    case 'reorder': {
      if (mutation.ids.length !== rows.length || new Set(mutation.ids).size !== mutation.ids.length) return false
      const rowsById = new Map(rows.map((row) => [scriptDefinitionRowIdFromUnknown(row), row]))
      if (rowsById.has(null) || mutation.ids.some((id) => !rowsById.has(id))) return false
      rows.splice(0, rows.length, ...mutation.ids.map((id) => rowsById.get(id)!))
      break
    }
  }

  return classifyScriptDefinitionMutation(rows, finalRows).kind === 'none'
}

function scriptDefinitionRowIdFromUnknown(row: unknown): string | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const id = (row as Record<string, unknown>).id
  return typeof id === 'string' && id.trim() ? id : null
}

function scriptDefinitionProjectionFence(
  characterRowProjection?: { characterId: string; epoch: number },
  moduleCollectionProjectionEpoch?: number,
  settingsGroupProjectionEpoch?: number,
): ScriptDefinitionProjectionFence | null {
  if (characterRowProjection) {
    return {
      kind: 'character',
      characterId: characterRowProjection.characterId,
      epoch: characterRowProjection.epoch,
    }
  }
  if (moduleCollectionProjectionEpoch !== undefined) {
    return { kind: 'modules', epoch: moduleCollectionProjectionEpoch }
  }
  if (settingsGroupProjectionEpoch !== undefined) {
    return { kind: 'settings', group: 'advanced', epoch: settingsGroupProjectionEpoch }
  }
  return null
}

function planScriptDefinitionMutation(
  key: string,
  mutation: QueuedScriptDefinitionMutation,
  rollback: ScriptDefinitionRollback,
  fence: ScriptDefinitionProjectionFence,
): ScriptDefinitionMutationPlan {
  const safety = mutationSafetyState(key, fence)
  const baseline = readRollbackDefinitionBaseline(rollback, mutation.kind, mutation.targetId)
  if (safety.forceReplacement || safety.unsettled.length > 0 || baseline === null) return { kind: 'replace' }
  const plan = classifyScriptDefinitionMutation(baseline.rows, mutation.finalDefinitions)
  if (plan.kind === 'none') deleteCleanMutationSafetyState(key, safety)
  return plan
}

function scriptDefinitionDurableIntent(
  mutation: QueuedScriptDefinitionMutation,
  plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>,
): DurableMutationIntent {
  const targetId = encodeURIComponent(mutation.targetId)
  let path: string
  let replaceBodyKey: 'patch' | 'scripts' | 'triggers'

  switch (mutation.kind) {
    case 'globalScripts':
      path = plan.kind === 'replace' ? '/settings/advanced' : '/settings/advanced/global-scripts'
      replaceBodyKey = 'patch'
      break
    case 'characterScripts':
      path = `/characters/${targetId}/scripts`
      replaceBodyKey = 'scripts'
      break
    case 'characterTriggers':
      path = `/characters/${targetId}/triggers`
      replaceBodyKey = 'triggers'
      break
    case 'moduleScripts':
      path = `/modules/${targetId}/scripts`
      replaceBodyKey = 'scripts'
      break
    case 'moduleTriggers':
      path = `/modules/${targetId}/triggers`
      replaceBodyKey = 'triggers'
      break
  }

  const body =
    plan.kind === 'mutation'
      ? { mutation: cloneJsonValue(plan.mutation) }
      : replaceBodyKey === 'patch'
        ? { patch: { globalscript: cloneJsonValue(mutation.finalDefinitions) } }
        : { [replaceBodyKey]: cloneJsonValue(mutation.finalDefinitions) }

  return {
    version: 1,
    requests: [
      {
        method: plan.kind === 'replace' && mutation.kind !== 'globalScripts' ? 'PUT' : 'PATCH',
        path,
        body,
      },
    ],
  }
}

function queueWatchedGlobalScripts(previousSnapshot: string, delayMs: number): void {
  if (!canUseClientWriteAccess()) return
  const optimisticProjectionEpoch = captureSettingsGroupProjectionEpoch('advanced')
  const previousScripts = parseSnapshotArray<customscript>(previousSnapshot)
  const scripts = currentGlobalScriptsForWatchedCommand()
  if (!scripts) return
  const scriptPayload = cloneJsonValue(scripts) as ScriptDefinitionSnapshot[]
  const attemptedScripts = cloneJsonValue(scriptPayload) as customscript[]
  queueReplacement(
    'globalScripts',
    {
      kind: 'globalScripts',
      scripts: previousScripts,
      hadScriptsField: Object.prototype.hasOwnProperty.call(scriptSettingsOwner() ?? {}, 'globalscript'),
    },
    (rollback, plan, options = {}) =>
      runGlobalScriptsDefinitionCommand(
        scriptPayload,
        attemptedScripts,
        rollback,
        optimisticProjectionEpoch,
        plan,
        options,
      ),
    delayMs,
    undefined,
    undefined,
    optimisticProjectionEpoch,
    {
      kind: 'globalScripts',
      targetId: 'globalscript',
      finalDefinitions: scriptPayload,
      validateCurrent: () => currentGlobalScriptsForWatchedCommand() !== null,
    },
  )
}

function runGlobalScriptsDefinitionCommand(
  scripts: ScriptDefinitionSnapshot[],
  attemptedScripts: customscript[],
  rollback: ScriptDefinitionRollback,
  optimisticProjectionEpoch: number,
  plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>,
  options: ServerCommandTransportOptions,
): Promise<ServerCommandResult<Record<string, unknown>>> {
  return runDefinitionCollectionCommand({
    key: 'globalScripts',
    kind: 'globalScripts',
    targetId: 'globalscript',
    fence: { kind: 'settings', group: 'advanced', epoch: optimisticProjectionEpoch },
    rollbackState: rollback,
    finalDefinitions: scripts,
    plan,
    replaceCommand: (baseRevision) =>
      patchSettingsGroup(
        {
          group: 'advanced',
          baseRevision,
          patch: { globalscript: scripts },
          acknowledgeOptimistic: true,
          optimisticProjectionEpoch,
        },
        options.signal,
        options.keepalive,
      ),
    mutateCommand: (baseRevision, mutation) =>
      mutateGlobalScriptsCommand(
        { baseRevision, mutation, expectedScripts: scripts, optimisticProjectionEpoch },
        options.signal,
        options.keepalive,
      ),
    rollback: () => {
      if (hasSettingsGroupProjectionEpochChanged('advanced', optimisticProjectionEpoch)) return
      rollbackServerBackedScriptDefinitions(rollback, {
        kind: 'globalScripts',
        scripts: attemptedScripts,
      })
    },
    options,
  })
}

function runCharacterScriptsDefinitionCommand(
  characterId: string,
  scripts: ScriptDefinitionSnapshot[],
  attemptedScripts: customscript[],
  rollback: ScriptDefinitionRollback,
  optimisticRowEpoch: number,
  plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>,
  options: ServerCommandTransportOptions,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return runDefinitionCollectionCommand({
    key: `characterScripts:${characterId}`,
    kind: 'characterScripts',
    targetId: characterId,
    fence: { kind: 'character', characterId, epoch: optimisticRowEpoch },
    rollbackState: rollback,
    finalDefinitions: scripts,
    plan,
    replaceCommand: (baseRevision) =>
      replaceCharacterScriptsCommand(
        { baseRevision, characterId, scripts, optimisticRowEpoch },
        options.signal,
        options.keepalive,
        true,
      ),
    mutateCommand: (baseRevision, mutation) =>
      mutateCharacterScriptsCommand(
        { baseRevision, characterId, mutation, expectedScripts: scripts, optimisticRowEpoch },
        options.signal,
        options.keepalive,
        true,
      ),
    rollback: () => {
      if (hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch)) return
      rollbackServerBackedScriptDefinitions(rollback, {
        kind: 'characterScripts',
        characterId,
        scripts: attemptedScripts,
      })
    },
    options,
  })
}

function runCharacterTriggersDefinitionCommand(
  characterId: string,
  triggers: TriggerDefinitionSnapshot[],
  attemptedTriggers: triggerscript[],
  rollback: ScriptDefinitionRollback,
  optimisticRowEpoch: number,
  plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>,
  options: ServerCommandTransportOptions,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return runDefinitionCollectionCommand({
    key: `characterTriggers:${characterId}`,
    kind: 'characterTriggers',
    targetId: characterId,
    fence: { kind: 'character', characterId, epoch: optimisticRowEpoch },
    rollbackState: rollback,
    finalDefinitions: triggers,
    plan,
    replaceCommand: (baseRevision) =>
      replaceCharacterTriggersCommand(
        { baseRevision, characterId, triggers, optimisticRowEpoch },
        options.signal,
        options.keepalive,
        true,
      ),
    mutateCommand: (baseRevision, mutation) =>
      mutateCharacterTriggersCommand(
        { baseRevision, characterId, mutation, expectedTriggers: triggers, optimisticRowEpoch },
        options.signal,
        options.keepalive,
        true,
      ),
    rollback: () => {
      if (hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch)) return
      rollbackServerBackedScriptDefinitions(rollback, {
        kind: 'characterTriggers',
        characterId,
        triggers: attemptedTriggers,
      })
    },
    options,
  })
}

function runModuleScriptsDefinitionCommand(
  moduleId: string,
  scripts: ScriptDefinitionSnapshot[],
  attemptedScripts: customscript[],
  rollback: ScriptDefinitionRollback,
  optimisticCollectionEpoch: number,
  plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>,
  options: ServerCommandTransportOptions,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return runDefinitionCollectionCommand({
    key: `moduleScripts:${moduleId}`,
    kind: 'moduleScripts',
    targetId: moduleId,
    fence: { kind: 'modules', epoch: optimisticCollectionEpoch },
    rollbackState: rollback,
    finalDefinitions: scripts,
    plan,
    replaceCommand: (baseRevision) =>
      replaceModuleScriptsCommand(
        { baseRevision, moduleId, scripts, optimisticCollectionEpoch },
        options.signal,
        options.keepalive,
        true,
      ),
    mutateCommand: (baseRevision, mutation) =>
      mutateModuleScriptsCommand(
        { baseRevision, moduleId, mutation, expectedScripts: scripts, optimisticCollectionEpoch },
        options.signal,
        options.keepalive,
        true,
      ),
    rollback: () => {
      if (hasCollectionProjectionEpochChanged('modules', optimisticCollectionEpoch)) return
      rollbackServerBackedScriptDefinitions(rollback, {
        kind: 'moduleScripts',
        moduleId,
        scripts: attemptedScripts,
      })
    },
    options,
  })
}

function runModuleTriggersDefinitionCommand(
  moduleId: string,
  triggers: TriggerDefinitionSnapshot[],
  attemptedTriggers: triggerscript[],
  rollback: ScriptDefinitionRollback,
  optimisticCollectionEpoch: number,
  plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>,
  options: ServerCommandTransportOptions,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return runDefinitionCollectionCommand({
    key: `moduleTriggers:${moduleId}`,
    kind: 'moduleTriggers',
    targetId: moduleId,
    fence: { kind: 'modules', epoch: optimisticCollectionEpoch },
    rollbackState: rollback,
    finalDefinitions: triggers,
    plan,
    replaceCommand: (baseRevision) =>
      replaceModuleTriggersCommand(
        { baseRevision, moduleId, triggers, optimisticCollectionEpoch },
        options.signal,
        options.keepalive,
        true,
      ),
    mutateCommand: (baseRevision, mutation) =>
      mutateModuleTriggersCommand(
        { baseRevision, moduleId, mutation, expectedTriggers: triggers, optimisticCollectionEpoch },
        options.signal,
        options.keepalive,
        true,
      ),
    rollback: () => {
      if (hasCollectionProjectionEpochChanged('modules', optimisticCollectionEpoch)) return
      rollbackServerBackedScriptDefinitions(rollback, {
        kind: 'moduleTriggers',
        moduleId,
        triggers: attemptedTriggers,
      })
    },
    options,
  })
}

async function runDefinitionCollectionCommand<T extends Record<string, unknown>>(input: {
  key: string
  kind: ScopedScriptDefinitionRollback['kind']
  targetId: string
  fence: ScriptDefinitionProjectionFence
  rollbackState: ScriptDefinitionRollback
  finalDefinitions: readonly unknown[]
  plan: Exclude<ScriptDefinitionMutationPlan, { kind: 'none' }>
  replaceCommand: (baseRevision: number) => Promise<ServerCommandResult<T>>
  mutateCommand: (baseRevision: number, mutation: ScriptDefinitionCollectionMutation) => Promise<ServerCommandResult<T>>
  rollback: () => void
  options: ServerCommandTransportOptions
}): Promise<ServerCommandResult<T>> {
  const safety = mutationSafetyState(input.key, input.fence)
  const attempt = createScriptDefinitionAttempt({
    key: input.key,
    kind: input.kind,
    targetId: input.targetId,
    rollback: input.rollbackState,
    attemptedRows: input.finalDefinitions,
    // Start conservatively; the classified transport plan below replaces this
    // value before the attempt can settle.
    fullReplacement: true,
    state: safety,
  })
  safety.unsettled.push(attempt)
  if (hasScriptDefinitionProjectionFenceChanged(input.fence)) {
    discardScriptDefinitionAttempt(attempt)
    return { status: 'unavailable' }
  }

  const plan = input.plan
  const fullReplacement = plan.kind === 'replace'
  attempt.fullReplacement = fullReplacement
  try {
    const result = await runServerCommand<T>({
      ...input.options,
      command: async (baseRevision) => {
        try {
          const result = fullReplacement
            ? await input.replaceCommand(baseRevision)
            : await input.mutateCommand(baseRevision, plan.mutation)
          settleScriptDefinitionAttempt(attempt, result.status === 'ok')
          return result
        } catch (error) {
          settleScriptDefinitionAttempt(attempt, false)
          throw error
        }
      },
      rollback: () => {
        // A rejected or response-lost PATCH may already have reached the server.
        // Taint before restoring the optimistic draft so the next same-scope
        // write sends a full replacement even when the restored arrays compare
        // as a local no-op.
        safety.forceReplacement = true
        settleScriptDefinitionAttempt(attempt, false)
        input.rollback()
      },
    })
    if (!attempt.settled) settleScriptDefinitionAttempt(attempt, result.status === 'ok')
    return result
  } catch (error) {
    safety.forceReplacement = true
    settleScriptDefinitionAttempt(attempt, false)
    throw error
  }
}

function mutationSafetyState(key: string, fence: ScriptDefinitionProjectionFence): ScriptDefinitionMutationSafetyState {
  const existing = mutationSafetyByKey.get(key)
  if (existing && sameScriptDefinitionProjectionFence(existing.fence, fence)) return existing

  const created: ScriptDefinitionMutationSafetyState = {
    fence,
    // A completed taint is cleared by an authoritative projection. An older
    // request that is still unsettled can nevertheless land after that read,
    // so the first write in the new epoch must still be a full replacement.
    forceReplacement: !!existing && (existing.crossProjectionTaint || existing.unsettled.length > 0),
    crossProjectionTaint: false,
    unsettled: [],
  }
  mutationSafetyByKey.set(key, created)
  return created
}

function createScriptDefinitionAttempt(
  input: Omit<DispatchedScriptDefinitionAttempt, 'settled'>,
): DispatchedScriptDefinitionAttempt {
  return {
    ...input,
    settled: false,
  }
}

function deleteCleanMutationSafetyState(key: string, state: ScriptDefinitionMutationSafetyState): void {
  if (state.unsettled.length === 0 && !state.forceReplacement && mutationSafetyByKey.get(key) === state) {
    mutationSafetyByKey.delete(key)
  }
}

function settleScriptDefinitionAttempt(attempt: DispatchedScriptDefinitionAttempt, accepted: boolean): void {
  if (attempt.settled) return
  attempt.settled = true

  const state = attempt.state
  const currentState = mutationSafetyByKey.get(attempt.key)
  const settledAfterProjectionChanged = hasScriptDefinitionProjectionFenceChanged(state.fence)
  const attemptIndex = state.unsettled.indexOf(attempt)
  const laterAttempts = attemptIndex < 0 ? [] : state.unsettled.slice(attemptIndex + 1)
  const settledBaseline = accepted
    ? { rows: attempt.attemptedRows, fieldPresent: true }
    : readRollbackDefinitionBaseline(attempt.rollback, attempt.kind, attempt.targetId)

  if (settledBaseline) {
    for (const laterAttempt of laterAttempts) {
      rebaseScriptDefinitionRollback(laterAttempt.rollback, laterAttempt.kind, laterAttempt.targetId, settledBaseline)
    }

    const pending = pendingReplacements.get(attempt.key)
    const pendingFence = pending ? scriptDefinitionPendingFence(pending) : null
    const shouldRebasePending =
      !!pendingFence &&
      (accepted
        ? !hasScriptDefinitionProjectionFenceChanged(pendingFence)
        : sameScriptDefinitionProjectionFence(state.fence, pendingFence))
    if (pending && shouldRebasePending) {
      rebaseScriptDefinitionRollback(pending.previous, attempt.kind, attempt.targetId, settledBaseline)
    }
  }

  if (currentState && currentState !== state) {
    // The old request settled after a newer authoritative projection created a
    // new ownership state. Its result is ordered before those queued writes but
    // happened after their rollback baseline was read.
    currentState.forceReplacement = true
    if (hasScriptDefinitionProjectionFenceChanged(currentState.fence)) {
      currentState.crossProjectionTaint = true
    }
    if (accepted) {
      const acceptedBaseline: ScriptDefinitionCollectionBaseline = {
        rows: attempt.attemptedRows,
        fieldPresent: true,
      }
      for (const currentAttempt of currentState.unsettled) {
        rebaseScriptDefinitionRollback(
          currentAttempt.rollback,
          currentAttempt.kind,
          currentAttempt.targetId,
          acceptedBaseline,
        )
      }
    }
  }

  if (settledAfterProjectionChanged) {
    state.forceReplacement = true
    state.crossProjectionTaint = true
  } else if (accepted && attempt.fullReplacement) {
    state.forceReplacement = false
  } else if (!accepted) {
    state.forceReplacement = true
  }

  if (attemptIndex >= 0) state.unsettled.splice(attemptIndex, 1)
  deleteCleanMutationSafetyState(attempt.key, state)
}

function discardScriptDefinitionAttempt(attempt: DispatchedScriptDefinitionAttempt): void {
  if (attempt.settled) return
  attempt.settled = true
  const attemptIndex = attempt.state.unsettled.indexOf(attempt)
  if (attemptIndex >= 0) attempt.state.unsettled.splice(attemptIndex, 1)
  deleteCleanMutationSafetyState(attempt.key, attempt.state)
}

function sameScriptDefinitionProjectionFence(
  left: ScriptDefinitionProjectionFence,
  right: ScriptDefinitionProjectionFence,
): boolean {
  if (left.kind !== right.kind || left.epoch !== right.epoch) return false
  if (left.kind === 'modules') return true
  if (left.kind === 'settings') return right.kind === 'settings' && left.group === right.group
  return right.kind === 'character' && left.characterId === right.characterId
}

function hasScriptDefinitionProjectionFenceChanged(fence: ScriptDefinitionProjectionFence): boolean {
  if (fence.kind === 'character') return hasCharacterRowProjectionEpochChanged(fence.characterId, fence.epoch)
  if (fence.kind === 'settings') return hasSettingsGroupProjectionEpochChanged(fence.group, fence.epoch)
  return hasCollectionProjectionEpochChanged('modules', fence.epoch)
}

function readRollbackDefinitionBaseline(
  rollback: ScriptDefinitionRollback,
  kind: ScopedScriptDefinitionRollback['kind'],
  targetId: string,
): ScriptDefinitionCollectionBaseline | null {
  if ('kind' in rollback) {
    if (rollback.kind !== kind) return null
    if ('characterId' in rollback && rollback.characterId !== targetId) return null
    if ('moduleId' in rollback && rollback.moduleId !== targetId) return null
    return {
      rows: 'scripts' in rollback ? rollback.scripts : rollback.triggers,
      fieldPresent:
        rollback.kind === 'globalScripts'
          ? rollback.hadScriptsField !== false
          : rollback.kind === 'characterScripts'
            ? rollback.hadScriptsField !== false
            : rollback.kind === 'characterTriggers'
              ? rollback.hadTriggersField !== false
              : true,
    }
  }

  if (kind === 'globalScripts') return null

  if (kind === 'characterScripts' || kind === 'characterTriggers') {
    const character = rollback.characters.find((candidate) => candidate.chaId === targetId)
    if (!character) return null
    const rows = kind === 'characterScripts' ? character.customscript : character.triggerscript
    if (rows !== undefined && !Array.isArray(rows)) return null
    const fieldName = kind === 'characterScripts' ? 'customscript' : 'triggerscript'
    return {
      rows: rows ?? [],
      fieldPresent: Object.prototype.hasOwnProperty.call(character, fieldName),
    }
  }

  const module = rollback.modules.find((candidate) => candidate.id === targetId)
  if (!module) return null
  const rows = kind === 'moduleScripts' ? module.regex : module.trigger
  if (rows !== undefined && !Array.isArray(rows)) return null
  const fieldName = kind === 'moduleScripts' ? 'regex' : 'trigger'
  return {
    rows: rows ?? [],
    fieldPresent: Object.prototype.hasOwnProperty.call(module, fieldName),
  }
}

function rebaseScriptDefinitionRollback(
  rollback: ScriptDefinitionRollback,
  kind: ScopedScriptDefinitionRollback['kind'],
  targetId: string,
  baseline: ScriptDefinitionCollectionBaseline,
): void {
  const rows = cloneJsonValue(baseline.rows)
  if ('kind' in rollback) {
    if (rollback.kind !== kind) return
    if ('characterId' in rollback && rollback.characterId !== targetId) return
    if ('moduleId' in rollback && rollback.moduleId !== targetId) return
    switch (rollback.kind) {
      case 'globalScripts':
        rollback.scripts = rows as customscript[]
        rollback.hadScriptsField = baseline.fieldPresent
        return
      case 'characterScripts':
        rollback.scripts = rows as customscript[]
        rollback.hadScriptsField = baseline.fieldPresent
        return
      case 'characterTriggers':
        rollback.triggers = rows as triggerscript[]
        rollback.hadTriggersField = baseline.fieldPresent
        return
      case 'moduleScripts':
        rollback.scripts = rows as customscript[]
        return
      case 'moduleTriggers':
        rollback.triggers = rows as triggerscript[]
        return
    }
  }

  if (kind === 'globalScripts') return

  if (kind === 'characterScripts' || kind === 'characterTriggers') {
    const character = rollback.characters.find((candidate) => candidate.chaId === targetId)
    if (!character) return
    const fieldName = kind === 'characterScripts' ? 'customscript' : 'triggerscript'
    if (!baseline.fieldPresent) {
      delete character[fieldName]
    } else if (kind === 'characterScripts') {
      character.customscript = rows as customscript[]
    } else {
      character.triggerscript = rows as triggerscript[]
    }
    return
  }

  const module = rollback.modules.find((candidate) => candidate.id === targetId)
  if (!module) return
  const fieldName = kind === 'moduleScripts' ? 'regex' : 'trigger'
  if (!baseline.fieldPresent) {
    delete module[fieldName]
  } else if (kind === 'moduleScripts') {
    module.regex = rows as customscript[]
  } else {
    module.trigger = rows as triggerscript[]
  }
}

function scriptDefinitionPendingFence(pending: PendingCollectionReplacement): ScriptDefinitionProjectionFence | null {
  if (pending.characterRowProjection) {
    return {
      kind: 'character',
      characterId: pending.characterRowProjection.characterId,
      epoch: pending.characterRowProjection.epoch,
    }
  }
  if (pending.moduleCollectionProjectionEpoch !== undefined) {
    return { kind: 'modules', epoch: pending.moduleCollectionProjectionEpoch }
  }
  return pending.settingsGroupProjectionEpoch === undefined
    ? null
    : { kind: 'settings', group: 'advanced', epoch: pending.settingsGroupProjectionEpoch }
}

function trackPendingScriptDefinitionSettlement(pending: PendingCollectionReplacement): void {
  pending.settlementCleanup = registerDurableMutationSettlementListener(pending.outbox.mutationId, () => {
    pending.settlementCleanup = undefined
    if (pendingReplacements.get(pending.key)?.outbox.mutationId !== pending.outbox.mutationId) return
    if (pending.timer) clearTimeout(pending.timer)
    pendingReplacements.delete(pending.key)
    discardQueuedScriptDefinitionSafetyState(pending.key)
  })
}

export function flushPendingScriptDefinitionMutations(options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  for (const characterId of Array.from(pendingCharacterScriptDefinitionDrafts.keys())) {
    flushPendingCharacterScriptDefinitionDraft(characterId)
  }
  for (const key of Array.from(pendingReplacements.keys())) {
    runPendingScriptDefinitionReplacement(key, options)
  }
}

registerPendingOwnerMutationFlusher('script-definition', flushPendingScriptDefinitionMutations)

function scriptDefinitionOwnerMutationKey(key: string, mutation: QueuedScriptDefinitionMutation): string {
  switch (mutation.kind) {
    case 'characterScripts':
    case 'characterTriggers':
      return characterOwnerMutationKey(mutation.targetId)
    case 'moduleScripts':
    case 'moduleTriggers':
      return moduleOwnerMutationKey(mutation.targetId)
    case 'globalScripts':
      return `script-definition:${key}`
  }
}

function runPendingScriptDefinitionReplacement(key: string, options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  const pending = pendingReplacements.get(key)
  if (!pending) return
  if (!isClientSessionGenerationCurrent(pending.sessionGeneration)) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingReplacements.delete(key)
  if (
    pending.characterRowProjection &&
    hasCharacterRowProjectionEpochChanged(
      pending.characterRowProjection.characterId,
      pending.characterRowProjection.epoch,
    )
  ) {
    // A projection epoch can invalidate local rollback/acknowledgement safety,
    // but it cannot prove that this exact durable mutation reached the server.
    discardQueuedScriptDefinitionSafetyState(key)
    return
  }
  if (
    pending.moduleCollectionProjectionEpoch !== undefined &&
    hasCollectionProjectionEpochChanged('modules', pending.moduleCollectionProjectionEpoch)
  ) {
    discardQueuedScriptDefinitionSafetyState(key)
    return
  }
  if (
    pending.settingsGroupProjectionEpoch !== undefined &&
    hasSettingsGroupProjectionEpochChanged('advanced', pending.settingsGroupProjectionEpoch)
  ) {
    discardQueuedScriptDefinitionSafetyState(key)
    return
  }
  if (pending.validateCurrent && !pending.validateCurrent()) {
    pending.settlementCleanup?.()
    void acknowledgePendingMutation(pending.outbox)
    discardQueuedScriptDefinitionSafetyState(key)
    return
  }
  pending.settlementCleanup?.()
  pending.settlementCleanup = undefined
  dispatchTrackedScriptDefinitionReplacement(pending, options)
}

function dispatchTrackedScriptDefinitionReplacement(
  pending: PendingCollectionReplacement,
  options: ServerCommandTransportOptions,
): void {
  let finalSettled = false
  let resolveFinal!: (accepted: boolean) => void
  let settlementCleanup: (() => void) | undefined
  const final = new Promise<boolean>((resolve) => {
    resolveFinal = resolve
  })
  const tracked: TrackedScriptDefinitionDispatch = {
    immediate: Promise.resolve({ status: 'unavailable' } as const),
    final,
    settleFinal: (accepted: boolean) => {
      if (finalSettled) return
      finalSettled = true
      settlementCleanup?.()
      if (accepted) successfulScriptDefinitionFinalOutcomeKeys.add(pending.key)
      else successfulScriptDefinitionFinalOutcomeKeys.delete(pending.key)
      resolveFinal(accepted)
      const current = trackedScriptDefinitionDispatches.get(pending.key)
      current?.delete(tracked)
      if (current?.size === 0) trackedScriptDefinitionDispatches.delete(pending.key)
    },
  }

  settlementCleanup = registerDurableMutationSettlementListener(pending.outbox.mutationId, (settlement) => {
    tracked.settleFinal(settlement === 'accepted')
  })
  successfulScriptDefinitionFinalOutcomeKeys.delete(pending.key)
  const dispatches = trackedScriptDefinitionDispatches.get(pending.key) ?? new Set()
  dispatches.add(tracked)
  trackedScriptDefinitionDispatches.set(pending.key, dispatches)

  tracked.immediate = dispatchDurableMutation(pending.outbox, pending.intent, (transport) =>
    pending.command(pending.previous, pending.plan, { ...options, ...transport }),
  ).then(
    (result) => {
      if (result.status === 'ok') {
        tracked.settleFinal(true)
      } else if (
        !pending.outbox.databaseLineage ||
        (result.status === 'error' &&
          (result.reason === 'database-lineage' ||
            result.reason === 'invalid-request' ||
            result.reason === 'mutation-id-conflict' ||
            result.reason === 'not-found' ||
            result.reason === 'unrecognized-rejection'))
      ) {
        tracked.settleFinal(false)
      }
      return result
    },
    (error) => {
      if (!pending.outbox.databaseLineage) tracked.settleFinal(false)
      throw error
    },
  )
}

function discardQueuedScriptDefinitionSafetyState(key: string): void {
  const state = mutationSafetyByKey.get(key)
  if (state) deleteCleanMutationSafetyState(key, state)
}

function rollbackServerBackedScriptDefinitions(
  rollback: ScriptDefinitionRollback,
  attempted?: ScopedScriptDefinitionAttempt,
): void {
  if ('kind' in rollback) {
    restoreScopedScriptDefinition(rollback, attempted)
  } else {
    restoreScriptDefinitionState(rollback)
  }
}

export function rollbackScopedScriptDefinitionReplacement(
  rollback: ScopedScriptDefinitionRollback,
  attempted: ScopedScriptDefinitionAttempt,
): void {
  rollbackServerBackedScriptDefinitions(rollback, attempted)
}

// Restore only the changed row's scripts/triggers from a scoped rollback, leaving
// every other character/module untouched. The full-collection
// `restoreScriptDefinitionState` is reserved for the rarer discrete callers.
function restoreScopedScriptDefinition(
  rollback: ScopedScriptDefinitionRollback,
  attempted?: ScopedScriptDefinitionAttempt,
): boolean {
  return withScriptDefinitionOwnerWrite(() => {
    switch (rollback.kind) {
      case 'globalScripts': {
        if (
          attempted &&
          (attempted.kind !== 'globalScripts' ||
            snapshotJson(scriptSettingsOwner()?.globalscript) !== snapshotJson(attempted.scripts))
        ) {
          return false
        }
        if (rollback.hadScriptsField === false) {
          const settings = scriptSettingsOwner()
          if (!settings) return false
          delete settings.globalscript
        } else {
          const settings = scriptSettingsOwner()
          if (!settings) return false
          settings.globalscript = cloneJsonValue(rollback.scripts)
        }
        return true
      }
      case 'characterScripts': {
        const character = characterDefinitionOwners().find((candidate) => candidate.chaId === rollback.characterId)
        if (!character) return false
        if (
          attempted &&
          (attempted.kind !== 'characterScripts' ||
            attempted.characterId !== rollback.characterId ||
            snapshotJson(character.customscript) !== snapshotJson(attempted.scripts))
        ) {
          return false
        }
        if (rollback.hadScriptsField === false) {
          delete character.customscript
        } else {
          character.customscript = cloneJsonValue(rollback.scripts)
        }
        return true
      }
      case 'characterTriggers': {
        const character = characterDefinitionOwners().find((candidate) => candidate.chaId === rollback.characterId)
        if (!character) return false
        if (
          attempted &&
          (attempted.kind !== 'characterTriggers' ||
            attempted.characterId !== rollback.characterId ||
            snapshotJson(character.triggerscript) !== snapshotJson(attempted.triggers))
        ) {
          return false
        }
        if (rollback.hadTriggersField === false) {
          delete character.triggerscript
        } else {
          character.triggerscript = cloneJsonValue(rollback.triggers)
        }
        return true
      }
      case 'moduleScripts': {
        const module = moduleDefinitionOwners().find((candidate) => candidate.id === rollback.moduleId)
        if (!module) return false
        if (
          attempted &&
          (attempted.kind !== 'moduleScripts' ||
            attempted.moduleId !== rollback.moduleId ||
            snapshotJson(module.regex) !== snapshotJson(attempted.scripts))
        ) {
          return false
        }
        module.regex = cloneJsonValue(rollback.scripts)
        return true
      }
      case 'moduleTriggers': {
        const module = moduleDefinitionOwners().find((candidate) => candidate.id === rollback.moduleId)
        if (!module) return false
        if (
          attempted &&
          (attempted.kind !== 'moduleTriggers' ||
            attempted.moduleId !== rollback.moduleId ||
            snapshotJson(module.trigger) !== snapshotJson(attempted.triggers))
        ) {
          return false
        }
        module.trigger = cloneJsonValue(rollback.triggers)
        return true
      }
    }
  })
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

// Parse a per-key snapshot string back into the pre-edit scripts/triggers array.
// Watched snapshots stringify arrays only; a non-array or `'__undefined__'`
// marker restores to `[]` defensively.
function parseSnapshotArray<T>(snapshot: string): T[] {
  if (snapshot === '__undefined__') return []
  const parsed = JSON.parse(snapshot) as unknown
  return Array.isArray(parsed) ? (parsed as T[]) : []
}

function currentGlobalScriptsForWatchedCommand(): customscript[] | null {
  const scripts = scriptSettingsOwner()?.globalscript
  return hasStableUniqueScriptDefinitionIds(scripts) ? scripts : null
}

function findModule(moduleId: string): RisuModule | undefined {
  return moduleDefinitionOwners().find((candidate) => candidate.id === moduleId)
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

function hasStableUniqueScriptDefinitionIds(scripts: unknown): scripts is customscript[] {
  if (!Array.isArray(scripts)) return false
  return hasStableUniqueCommandIds(scripts.map((script) => (script as { id?: unknown }).id))
}

function hasStableUniqueTriggerDefinitionIds(triggers: unknown): triggers is triggerscript[] {
  if (!Array.isArray(triggers)) return false
  return hasStableUniqueCommandIds(triggers.map((trigger) => (trigger as { id?: unknown }).id))
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}
