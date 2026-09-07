import {
  canUseClientWriteAccess,
  assertClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import type { PromptItem } from '../process/prompt'
import {
  canUseServerCommands,
  patchPromptSettingsCommand,
  peekCachedServerCommandRevision,
  runServerCommand,
  updatePromptItemCommand,
  type PromptItemOptimisticAcknowledgement,
  type PromptItemSnapshot,
  type PromptTemplateOwnerStateSnapshot,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
  type SettingsPatch,
} from './commands'
import {
  capturePromptTemplateOwnerProjectionEpoch,
  currentPromptTemplateOwnerId,
  hasPromptTemplateOwnerProjectionEpochChanged,
  isPromptTemplateHydrated,
  markPromptTemplateOwnerAcknowledgementTainted,
} from './promptTemplateHydration'
import {
  captureCollectionProjectionEpoch,
  captureSettingsGroupProjectionEpoch,
  collectionsResourceState,
  hasCollectionProjectionEpochChanged,
  hasSettingsGroupProjectionEpochChanged,
  markSettingsGroupAcknowledgementTainted,
  settingsResourceState,
} from './resourceState.svelte'
import { mergeProjectionIntoDirtyDraft } from './staleStateGuards'
import { dispatchDurableMutation, registerDurableMutationSettlementListener } from './durableMutationDispatch'
import { SETTINGS_BRIDGE_MUTATION_KEY } from './settingsMutationKey'
import {
  acknowledgePendingMutation,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
} from './pendingMutationOutbox'
import { registerPendingOwnerMutationFlusher } from './pendingOwnerMutationRegistry'

/**
 * Prompt-template editor projection helpers.
 *
 * The prompt-template editor keeps a local `promptTemplate` draft and mirrors
 * edits into the selected prompt-template owner in resource-backed state. These
 * helpers avoid two per-keystroke costs:
 *
 * - the optimistic projection write cloned the WHOLE `promptTemplate` array on
 *   every keystroke (High), and
 * - the change-detection `$effect` ran two whole-template `JSON.stringify`
 *   passes on every reactive fire (Medium).
 *
 * These helpers narrow both: a keystroke writes only the edited item in place,
 * and reconciliation is gated by the cached server command revision instead of a
 * per-fire whole-template stringify diff. They are intentionally independent of
 * the component so the clone-cost regression can exercise them directly.
 */

export function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

export function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

function withPromptTemplateOwnerWrite<T>(write: () => T): T {
  return write()
}

function legacyPromptTemplateOwnerValue(): unknown {
  if (collectionsResourceState.statuses.promptTemplate !== 'ready') return undefined
  return collectionsResourceState.values.promptTemplate
}

function writeLegacyPromptTemplateOwnerValue(value: PromptItem[] | undefined): void {
  if (collectionsResourceState.statuses.promptTemplate !== 'ready') return
  if (value === undefined) {
    delete (collectionsResourceState.values as unknown as Record<string, unknown>).promptTemplate
  } else {
    collectionsResourceState.values.promptTemplate = value
  }
}

function promptPresetOwnerRows(): Array<Record<string, unknown>> | null {
  if (collectionsResourceState.statuses.promptPresets !== 'ready') return null
  const presets = collectionsResourceState.values.promptPresets
  return Array.isArray(presets) ? (presets as unknown as Array<Record<string, unknown>>) : null
}

export interface PromptTemplateOwnerMutationFence {
  ownerId: string | null
  collectionProjectionEpoch: number
  ownerProjectionEpoch: number
}

export function capturePromptTemplateOwnerMutationFence(
  ownerId: string | null = currentPromptTemplateOwnerId(),
): PromptTemplateOwnerMutationFence {
  return {
    ownerId,
    collectionProjectionEpoch: captureCollectionProjectionEpoch(promptTemplateOwnerCollectionName(ownerId)),
    ownerProjectionEpoch: capturePromptTemplateOwnerProjectionEpoch(ownerId),
  }
}

export function hasPromptTemplateOwnerMutationFenceChanged(fence: PromptTemplateOwnerMutationFence): boolean {
  return (
    hasCollectionProjectionEpochChanged(
      promptTemplateOwnerCollectionName(fence.ownerId),
      fence.collectionProjectionEpoch,
    ) || hasPromptTemplateOwnerProjectionEpochChanged(fence.ownerId, fence.ownerProjectionEpoch)
  )
}

export function capturePromptItemOptimisticAcknowledgement(
  fence: PromptTemplateOwnerMutationFence,
): PromptItemOptimisticAcknowledgement | undefined {
  const ownerState = captureCanonicalPromptTemplateOwnerState(fence.ownerId)
  if (!ownerState) return undefined
  return {
    collectionProjectionEpoch: fence.collectionProjectionEpoch,
    ownerProjectionEpoch: fence.ownerProjectionEpoch,
    ownerState,
  }
}

export interface PromptTemplateDraftBinding {
  getItems: () => PromptItem[]
  setItems: (items: PromptItem[]) => void
}

export interface FailedPromptTemplateItemCreateRollback {
  ownerId: string | null
  binding: PromptTemplateDraftBinding
  itemId: string
  attemptedItem: PromptItem
  projectionFence?: PromptTemplateOwnerMutationFence
}

export interface FailedPromptTemplateItemDeleteRollback {
  ownerId: string | null
  binding: PromptTemplateDraftBinding
  itemId: string
  previousIndex: number
  previousItem: PromptItem
  projectionFence?: PromptTemplateOwnerMutationFence
}

export interface FailedPromptTemplateItemReorderRollback {
  ownerId: string | null
  binding: PromptTemplateDraftBinding
  previousItemIds: string[]
  attemptedItemIds: string[]
  projectionFence?: PromptTemplateOwnerMutationFence
}

interface PendingPromptItemUpdate {
  sessionGeneration: number
  ownerId: string | null
  itemId: string
  previousItem: PromptItem
  attemptedItem: PromptItem
  binding: PromptTemplateDraftBinding
  timer: ReturnType<typeof setTimeout> | null
  projectionFence: PromptTemplateOwnerMutationFence
  sparseUpdate: SparsePromptItemUpdate
  intent: DurableMutationIntent
  outbox: PendingMutationHandle
  settlementCleanup?: () => void
}

export interface StagedPromptItemDeleteMutation {
  intent: DurableMutationIntent
  outbox: PendingMutationHandle
}

interface PendingPromptItemAttempt {
  sequence: number
  pending: PendingPromptItemUpdate
}

interface SparsePromptItemUpdate {
  patch: PromptItemSnapshot
  deleteKeys: string[]
}

interface PendingPromptSettingsPatch {
  sessionGeneration: number
  patch: SettingsPatch
  previous: SettingsPatch
  attempted: SettingsPatch
  durableAttempted: SettingsPatch
  projectionEpoch: number | null
  timer: ReturnType<typeof setTimeout> | null
  intent: DurableMutationIntent | null
  outbox: PendingMutationHandle | null
}

interface PendingPromptSettingsAttempt {
  sequence: number
  previous: SettingsPatch
  attempted: SettingsPatch
  projectionEpoch: number | null
}

export interface PromptTemplateStructuralOwnerState {
  enabled: boolean
  items?: PromptItem[]
}

export type PromptTemplateStructuralOperation =
  | {
      kind: 'create'
      itemId: string
      previous: PromptTemplateStructuralOwnerState
      attempted: PromptTemplateStructuralOwnerState
    }
  | {
      kind: 'delete'
      itemId: string
      previous: PromptTemplateStructuralOwnerState
      attempted: PromptTemplateStructuralOwnerState
    }
  | {
      kind: 'reorder'
      previousItemIds: string[]
      attemptedItemIds: string[]
      previous: PromptTemplateStructuralOwnerState
      attempted: PromptTemplateStructuralOwnerState
    }
  | {
      kind: 'enable'
      previous: PromptTemplateStructuralOwnerState
      attempted: PromptTemplateStructuralOwnerState
    }

export type PromptTemplateStructuralMutationOutcome =
  | { status: 'accepted'; result: Extract<ServerCommandResult, { status: 'ok' }> }
  | { status: 'queued'; result: Exclude<ServerCommandResult, { status: 'ok' }> }
  | { status: 'failed'; result: Exclude<ServerCommandResult, { status: 'ok' }> }

export type PromptTemplateStructuralFinalSettlement = 'accepted' | 'discarded'

interface PendingPromptTemplateStructuralAttempt {
  sequence: number
  ownerId: string | null
  operation: PromptTemplateStructuralOperation
  settled: boolean
  rollback: () => void
  settlementCleanup?: () => void
}

const pendingPromptItemUpdates = new Map<string, PendingPromptItemUpdate>()
const pendingPromptItemAttempts: PendingPromptItemAttempt[] = []
const pendingPromptSettingsPatch: PendingPromptSettingsPatch = {
  sessionGeneration: captureClientSessionGeneration(),
  patch: {},
  previous: {},
  attempted: {},
  durableAttempted: {},
  projectionEpoch: null,
  timer: null,
  intent: null,
  outbox: null,
}
const pendingPromptSettingsAttempts: PendingPromptSettingsAttempt[] = []
let nextPromptItemAttemptSequence = 0
let nextPromptSettingsAttemptSequence = 0
let nextPromptTemplateStructuralAttemptSequence = 0
const promptItemDirtyFieldsByOwnerAndId = new Map<string, Set<string>>()
const pendingPromptTemplateStructuralAttempts: PendingPromptTemplateStructuralAttempt[] = []

/**
 * Mirror one edited prompt item into resource-backed state in place, without
 * cloning the whole `promptTemplate` array. Returns the cloned item that was
 * written (use it as the server patch / rollback "attempted" baseline), or
 * `null` when the item is no longer in the draft.
 *
 * Falls back to a full-array sync only when the projection has no row with this
 * id yet (rare: the projection has drifted from the draft); that path is still
 * correct, just not narrowed.
 */
export function applyPromptItemProjectionWrite(
  draftItems: PromptItem[],
  itemId: string,
  ownerId: string | null = currentPromptTemplateOwnerId(),
): PromptItem | null {
  if (!canUseClientWriteAccess()) return null
  if (!isPromptTemplateHydrated(ownerId)) return null
  const draftItem = (draftItems ?? []).find((item) => item.id === itemId)
  if (!draftItem) return null
  if (ownerId !== null && !findCanonicalPromptTemplatePreset(ownerId)) return null
  const snapshot = cloneJsonValue(draftItem)
  withPromptTemplateOwnerWrite(() => {
    const owner = ownerId === null ? null : findCanonicalPromptTemplatePreset(ownerId)
    const template = ownerId === null ? legacyPromptTemplateOwnerValue() : owner?.promptTemplate
    if (!Array.isArray(template)) {
      if (ownerId === null) writeLegacyPromptTemplateOwnerValue(cloneJsonValue(draftItems))
      else if (owner) owner.promptTemplate = cloneJsonValue(draftItems)
      return
    }
    const index = template.findIndex((item) => item.id === itemId)
    if (index === -1) {
      if (ownerId === null) writeLegacyPromptTemplateOwnerValue(cloneJsonValue(draftItems))
      else if (owner) owner.promptTemplate = cloneJsonValue(draftItems)
      return
    }
    template[index] = snapshot
  })
  return snapshot
}

/**
 * Restore a single prompt item in resource-backed state in place (failed-command
 * rollback), leaving every other item untouched. The former rollback re-cloned
 * the whole `promptTemplate` array.
 */
export function restorePromptItemProjectionWrite(
  itemId: string,
  previousItem: PromptItem,
  ownerId: string | null = currentPromptTemplateOwnerId(),
): void {
  withPromptTemplateOwnerWrite(() => {
    const owner = ownerId === null ? null : findCanonicalPromptTemplatePreset(ownerId)
    const template = ownerId === null ? legacyPromptTemplateOwnerValue() : owner?.promptTemplate
    if (!Array.isArray(template)) return
    const index = template.findIndex((item) => item.id === itemId)
    if (index !== -1) template[index] = cloneJsonValue(previousItem)
  })
}

export function promptTemplateOwnerCommandId(ownerId: string | null): string | undefined {
  return ownerId ?? undefined
}

/**
 * Prompt rows are partial writes against one owner-owned template, so every
 * structural mutation for that owner shares one key. The legacy top-level
 * template has no database id, but still needs one stable synthetic owner key
 * so a toggle or delete cannot overtake an older row patch.
 */
export function promptTemplateOwnerMutationKey(ownerId: string | null): string {
  return `prompt-template-owner:${ownerId ?? '__legacy__'}`
}

function promptItemMutationKey(ownerId: string | null, _itemId: string): string {
  return promptTemplateOwnerMutationKey(ownerId)
}

function promptTemplateOwnerCollectionName(ownerId: string | null): 'promptTemplate' | 'promptPresets' {
  return ownerId === null ? 'promptTemplate' : 'promptPresets'
}

function captureCanonicalPromptTemplateOwnerState(ownerId: string | null): PromptTemplateOwnerStateSnapshot | null {
  if (ownerId === null) {
    const promptTemplate = legacyPromptTemplateOwnerValue()
    if (promptTemplate === undefined) return { enabled: false }
    return canonicalPromptTemplateEnabledState(promptTemplate)
  }

  const presets = promptPresetOwnerRows()
  if (!presets) return null
  const seenPresetIds = new Set<string>()
  let owner: Record<string, unknown> | null = null
  for (const candidate of presets) {
    const preset = candidate as unknown as Record<string, unknown>
    const presetId = preset?.id
    if (typeof presetId !== 'string' || presetId.trim() === '' || seenPresetIds.has(presetId)) return null
    seenPresetIds.add(presetId)
    if (presetId === ownerId) owner = preset
  }
  if (!owner) return null
  if (!Object.prototype.hasOwnProperty.call(owner, 'promptTemplate')) return { enabled: false }
  return canonicalPromptTemplateEnabledState(owner.promptTemplate)
}

function canonicalPromptTemplateEnabledState(value: unknown): PromptTemplateOwnerStateSnapshot | null {
  if (!Array.isArray(value)) return null
  const seenItemIds = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const itemId = (candidate as { id?: unknown }).id
    if (typeof itemId !== 'string' || itemId.trim() === '' || seenItemIds.has(itemId)) return null
    seenItemIds.add(itemId)
  }
  return { enabled: true, items: cloneJsonValue(value as PromptItemSnapshot[]) }
}

export function isCurrentPromptTemplateOwner(ownerId: string | null): boolean {
  return currentPromptTemplateOwnerId() === ownerId
}

export async function runPromptTemplateOwnerCommand<T extends Record<string, unknown> = {}>(
  ownerId: string | null,
  command: () => Promise<ServerCommandResult<T>>,
): Promise<ServerCommandResult<T>> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  if (!isCurrentPromptTemplateOwner(ownerId)) return { status: 'unavailable' }
  return command()
}

export function runPromptTemplateOwnerRollback(
  ownerId: string | null,
  rollback: () => boolean | void,
  projectionFence?: PromptTemplateOwnerMutationFence,
): void {
  markPromptTemplateOwnerAcknowledgementTainted(ownerId)
  if (!isCurrentPromptTemplateOwner(ownerId)) return
  if (projectionFence && projectionFence.ownerId !== ownerId) return
  if (projectionFence && hasPromptTemplateOwnerMutationFenceChanged(projectionFence)) return
  rollback()
}

export async function dispatchPromptTemplateStructuralMutation(input: {
  ownerId: string | null
  operation: PromptTemplateStructuralOperation
  outbox: PendingMutationHandle
  intent: DurableMutationIntent
  dispatch: (transport: ServerCommandTransportOptions, rollback: () => void) => Promise<ServerCommandResult>
  rollback: () => void
  onFinalSettlement?: (settlement: PromptTemplateStructuralFinalSettlement) => void
}): Promise<PromptTemplateStructuralMutationOutcome> {
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  const attempt: PendingPromptTemplateStructuralAttempt = {
    sequence: ++nextPromptTemplateStructuralAttemptSequence,
    ownerId: input.ownerId,
    operation: cloneJsonValue(input.operation),
    settled: false,
    rollback: input.rollback,
  }
  pendingPromptTemplateStructuralAttempts.push(attempt)

  const settleAccepted = (finalSettlement = false) => {
    if (!settlePromptTemplateStructuralAttempt(attempt, true)) return
    if (finalSettlement) input.onFinalSettlement?.('accepted')
  }
  const settleFailed = (finalSettlement = false) => {
    if (!settlePromptTemplateStructuralAttempt(attempt, false)) return
    if (finalSettlement) input.onFinalSettlement?.('discarded')
  }
  attempt.settlementCleanup = registerDurableMutationSettlementListener(input.outbox.mutationId, (settlement) => {
    if (settlement === 'accepted') settleAccepted(true)
    else settleFailed(true)
  })

  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  let result: ServerCommandResult
  try {
    result = await dispatchDurableMutation(input.outbox, input.intent, (transport) => {
      failureRollbackDisposition = transport.failureRollbackDisposition
      return input.dispatch(transport, () => settleFailed())
    })
  } catch (error) {
    console.error('Prompt-template structural command rejected:', error)
    result = { status: 'unavailable' }
  }

  if (result.status === 'ok') {
    settleAccepted()
    return { status: 'accepted', result }
  }
  if (failureRollbackDisposition?.(result) === 'retain') {
    reapplyPendingPromptTemplateStructuralProjections(input.ownerId)
    return { status: 'queued', result }
  }
  settleFailed()
  return { status: 'failed', result }
}

function settlePromptTemplateStructuralAttempt(
  attempt: PendingPromptTemplateStructuralAttempt,
  accepted: boolean,
): boolean {
  if (attempt.settled) return false
  attempt.settled = true
  attempt.settlementCleanup?.()
  attempt.settlementCleanup = undefined
  const index = pendingPromptTemplateStructuralAttempts.indexOf(attempt)
  if (index !== -1) pendingPromptTemplateStructuralAttempts.splice(index, 1)

  if (!accepted) {
    attempt.rollback()
    rollbackPromptTemplateStructuralProjection(attempt)
  }
  reapplyPendingPromptTemplateStructuralProjections(attempt.ownerId)
  return true
}

export function reapplyPendingPromptTemplateStructuralProjections(ownerId?: string | null): void {
  const ownerIds =
    ownerId === undefined
      ? new Set(pendingPromptTemplateStructuralAttempts.map((attempt) => attempt.ownerId))
      : new Set([ownerId])
  if (ownerIds.size === 0) return

  withPromptTemplateOwnerWrite(() => {
    for (const targetOwnerId of ownerIds) {
      const current = readPromptTemplateStructuralOwnerState(targetOwnerId)
      if (!current) continue
      const projected = applyPendingPromptTemplateStructuralOperations(targetOwnerId, current)
      writePromptTemplateStructuralOwnerState(targetOwnerId, projected)
    }
  })
}

export function applyPendingPromptTemplateStructuralItems(ownerId: string | null, items: PromptItem[]): PromptItem[] {
  if (!pendingPromptTemplateStructuralAttempts.some((attempt) => !attempt.settled && attempt.ownerId === ownerId)) {
    return items
  }
  const projected = applyPendingPromptTemplateStructuralOperations(ownerId, {
    enabled: true,
    items: cloneJsonValue(items),
  })
  return projected.enabled ? cloneJsonValue(projected.items ?? []) : []
}

export function resetPendingPromptTemplateStructuralMutationsForTests(): void {
  for (const attempt of pendingPromptTemplateStructuralAttempts) attempt.settlementCleanup?.()
  pendingPromptTemplateStructuralAttempts.splice(0)
  nextPromptTemplateStructuralAttemptSequence = 0
}

function applyPendingPromptTemplateStructuralOperations(
  ownerId: string | null,
  state: PromptTemplateStructuralOwnerState,
): PromptTemplateStructuralOwnerState {
  let projected = cloneJsonValue(state)
  const attempts = pendingPromptTemplateStructuralAttempts
    .filter((attempt) => !attempt.settled && attempt.ownerId === ownerId)
    .sort((left, right) => left.sequence - right.sequence)
  for (const attempt of attempts) {
    projected = applyPromptTemplateStructuralOperation(projected, attempt.operation)
  }
  return projected
}

function applyPromptTemplateStructuralOperation(
  state: PromptTemplateStructuralOwnerState,
  operation: PromptTemplateStructuralOperation,
): PromptTemplateStructuralOwnerState {
  if (operation.kind === 'enable') {
    if (!operation.attempted.enabled) return { enabled: false }
    if (state.enabled) return cloneJsonValue(state)
    return cloneJsonValue(operation.attempted)
  }

  const enabledState = state.enabled ? cloneJsonValue(state) : cloneJsonValue(operation.attempted)
  if (!enabledState.enabled) return enabledState
  const items = cloneJsonValue(enabledState.items ?? [])

  if (operation.kind === 'create') {
    if (!items.some((item) => item.id === operation.itemId)) {
      const attemptedItems = operation.attempted.items ?? []
      const attemptedIndex = attemptedItems.findIndex((item) => item.id === operation.itemId)
      const attemptedItem = attemptedItems[attemptedIndex]
      if (attemptedItem) {
        items.splice(Math.max(0, Math.min(attemptedIndex, items.length)), 0, cloneJsonValue(attemptedItem))
      }
    }
    return { enabled: true, items }
  }

  if (operation.kind === 'delete') {
    return { enabled: true, items: items.filter((item) => item.id !== operation.itemId) }
  }

  return {
    enabled: true,
    items: reorderPromptTemplateStructuralItems(items, operation.attemptedItemIds),
  }
}

function rollbackPromptTemplateStructuralProjection(attempt: PendingPromptTemplateStructuralAttempt): void {
  withPromptTemplateOwnerWrite(() => {
    const live = readPromptTemplateStructuralOwnerState(attempt.ownerId)
    if (!live) return
    const operation = attempt.operation

    if (operation.kind === 'enable') {
      if (snapshotJson(live) === snapshotJson(operation.attempted)) {
        writePromptTemplateStructuralOwnerState(attempt.ownerId, operation.previous)
      }
      return
    }

    if (!live.enabled) return
    const items = cloneJsonValue(live.items ?? [])
    if (operation.kind === 'create') {
      const attemptedItem = operation.attempted.items?.find((item) => item.id === operation.itemId)
      const liveIndex = items.findIndex((item) => item.id === operation.itemId)
      if (liveIndex !== -1 && attemptedItem && snapshotJson(items[liveIndex]) === snapshotJson(attemptedItem)) {
        items.splice(liveIndex, 1)
        writePromptTemplateStructuralOwnerState(attempt.ownerId, { enabled: true, items })
      }
      return
    }

    if (operation.kind === 'delete') {
      if (items.some((item) => item.id === operation.itemId)) return
      const previousItems = operation.previous.items ?? []
      const previousIndex = previousItems.findIndex((item) => item.id === operation.itemId)
      const previousItem = previousItems[previousIndex]
      if (!previousItem) return
      items.splice(Math.max(0, Math.min(previousIndex, items.length)), 0, cloneJsonValue(previousItem))
      writePromptTemplateStructuralOwnerState(attempt.ownerId, { enabled: true, items })
      return
    }

    if (!stringArraysEqual(promptItemIdList(items), operation.attemptedItemIds)) return
    writePromptTemplateStructuralOwnerState(attempt.ownerId, {
      enabled: true,
      items: reorderPromptTemplateStructuralItems(items, operation.previousItemIds),
    })
  })
}

function reorderPromptTemplateStructuralItems(items: PromptItem[], itemIds: readonly string[]): PromptItem[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  if (itemIds.some((itemId) => !byId.has(itemId))) return items
  const ordered = itemIds.map((itemId) => byId.get(itemId)!)
  const orderedIds = new Set(itemIds)
  ordered.push(...items.filter((item) => !item.id || !orderedIds.has(item.id)))
  return ordered
}

function readPromptTemplateStructuralOwnerState(ownerId: string | null): PromptTemplateStructuralOwnerState | null {
  if (ownerId === null) {
    const promptTemplate = legacyPromptTemplateOwnerValue()
    if (promptTemplate === undefined) return { enabled: false }
    if (!Array.isArray(promptTemplate)) return null
    return { enabled: true, items: cloneJsonValue(promptTemplate as PromptItem[]) }
  }

  const presets = promptPresetOwnerRows()
  if (!presets) return null
  const matches = presets.filter((preset) => preset?.id === ownerId)
  if (matches.length !== 1) return null
  const preset = matches[0] as unknown as Record<string, unknown>
  if (preset.promptTemplate === undefined) return { enabled: false }
  if (!Array.isArray(preset.promptTemplate)) return null
  return { enabled: true, items: cloneJsonValue(preset.promptTemplate as PromptItem[]) }
}

function writePromptTemplateStructuralOwnerState(
  ownerId: string | null,
  state: PromptTemplateStructuralOwnerState,
): void {
  if (ownerId === null) {
    writeLegacyPromptTemplateOwnerValue(state.enabled ? cloneJsonValue(state.items ?? []) : undefined)
    return
  }

  const presets = promptPresetOwnerRows()
  if (!presets) return
  const matches = presets.filter((preset) => preset?.id === ownerId)
  if (matches.length !== 1) return
  const preset = matches[0] as unknown as Record<string, unknown>
  if (state.enabled) preset.promptTemplate = cloneJsonValue(state.items ?? [])
  else delete preset.promptTemplate
}

export function rollbackFailedPromptTemplateItemCreate(input: FailedPromptTemplateItemCreateRollback): void {
  markPromptTemplateOwnerAcknowledgementTainted(input.ownerId)
  if (!isCurrentPromptTemplateOwner(input.ownerId)) return
  if (input.projectionFence?.ownerId !== undefined && input.projectionFence.ownerId !== input.ownerId) return
  if (input.projectionFence && hasPromptTemplateOwnerMutationFenceChanged(input.projectionFence)) {
    return
  }
  const liveItems = input.binding.getItems() ?? []
  const liveIndex = findPromptItemIndexById(liveItems, input.itemId)
  if (liveIndex === -1) return
  if (snapshotJson(liveItems[liveIndex]) !== snapshotJson(input.attemptedItem)) return

  const nextItems = [...liveItems]
  nextItems.splice(liveIndex, 1)
  applyPromptTemplateCollectionRollback(input.binding, input.ownerId, nextItems)
  promptItemDirtyFieldsByOwnerAndId.delete(promptItemStateKey(input.ownerId, input.itemId))
}

export function rollbackFailedPromptTemplateItemDelete(input: FailedPromptTemplateItemDeleteRollback): void {
  markPromptTemplateOwnerAcknowledgementTainted(input.ownerId)
  if (!isCurrentPromptTemplateOwner(input.ownerId)) return
  if (input.projectionFence?.ownerId !== undefined && input.projectionFence.ownerId !== input.ownerId) return
  if (input.projectionFence && hasPromptTemplateOwnerMutationFenceChanged(input.projectionFence)) {
    return
  }
  const liveItems = input.binding.getItems() ?? []
  const liveIndex = findPromptItemIndexById(liveItems, input.itemId)
  if (liveIndex !== -1) return

  const insertIndex = Math.max(0, Math.min(input.previousIndex, liveItems.length))
  const nextItems = [...liveItems]
  nextItems.splice(insertIndex, 0, cloneJsonValue(input.previousItem))
  applyPromptTemplateCollectionRollback(input.binding, input.ownerId, nextItems)
}

export function rollbackFailedPromptTemplateItemReorder(input: FailedPromptTemplateItemReorderRollback): void {
  markPromptTemplateOwnerAcknowledgementTainted(input.ownerId)
  if (!isCurrentPromptTemplateOwner(input.ownerId)) return
  if (input.projectionFence?.ownerId !== undefined && input.projectionFence.ownerId !== input.ownerId) return
  if (input.projectionFence && hasPromptTemplateOwnerMutationFenceChanged(input.projectionFence)) {
    return
  }
  const liveItems = input.binding.getItems() ?? []
  const liveItemIds = promptItemIdList(liveItems)
  if (!stringArraysEqual(liveItemIds, input.attemptedItemIds)) return

  const liveItemsById = promptItemsById(liveItems)
  const previousOrder = input.previousItemIds
    .map((itemId) => liveItemsById.get(itemId))
    .filter((item): item is PromptItem => Boolean(item))
  if (previousOrder.length !== liveItems.length) return

  applyPromptTemplateCollectionRollback(input.binding, input.ownerId, previousOrder)
}

export function queuePromptItemProjectionUpdate(
  binding: PromptTemplateDraftBinding,
  itemId: string,
  previousItem: PromptItem,
  delayMs: number | null = 250,
  promptPresetId: string | null = currentPromptTemplateOwnerId(),
  projectionFence?: PromptTemplateOwnerMutationFence,
): void {
  if (!canUseClientWriteAccess()) return
  if (!isPromptTemplateHydrated(promptPresetId)) return
  if (projectionFence && projectionFence.ownerId !== promptPresetId) return
  const pendingKey = promptItemStateKey(promptPresetId, itemId)
  const existing = pendingPromptItemUpdates.get(pendingKey)
  const effectiveProjectionFence =
    existing?.projectionFence ?? projectionFence ?? capturePromptTemplateOwnerMutationFence(promptPresetId)
  const attemptedItem = applyPromptItemProjectionWrite(binding.getItems(), itemId, promptPresetId)
  if (!attemptedItem) return
  markDirtyPromptItemFields(promptPresetId, itemId, previousItem, attemptedItem)
  if (!canUseServerCommands()) return

  if (existing?.timer) clearTimeout(existing.timer)
  const retainedPreviousItem = cloneJsonValue(existing?.previousItem ?? previousItem)
  const netUpdate = sparsePromptItemUpdate(retainedPreviousItem, attemptedItem)
  const correctiveUpdate = existing ? sparsePromptItemUpdate(existing.attemptedItem, attemptedItem) : null
  const sparseUpdate = mergeSparsePromptItemUpdates(netUpdate, correctiveUpdate)
  if (!sparseUpdate) {
    if (existing) {
      existing.settlementCleanup?.()
      void acknowledgePendingMutation(existing.outbox)
    }
    pendingPromptItemUpdates.delete(pendingKey)
    return
  }
  const intent = promptItemUpdateDurableIntent(promptPresetId, itemId, sparseUpdate)
  const pending: PendingPromptItemUpdate = {
    sessionGeneration: captureClientSessionGeneration(),
    ownerId: promptPresetId,
    itemId,
    previousItem: retainedPreviousItem,
    attemptedItem,
    binding,
    timer: null,
    projectionFence: effectiveProjectionFence,
    sparseUpdate,
    intent,
    outbox: stagePendingMutation(promptItemMutationKey(promptPresetId, itemId), intent, existing?.outbox),
  }
  existing?.settlementCleanup?.()
  trackPendingPromptItemSettlement(pendingKey, pending)
  const requiresImmediateCorrection = netUpdate === null && correctiveUpdate !== null
  if (!requiresImmediateCorrection && delayMs !== null) {
    pending.timer = setTimeout(() => runPendingPromptItemUpdate(pendingKey), delayMs)
  }
  pendingPromptItemUpdates.set(pendingKey, pending)
  // A correction-only successor exists solely because an older generation may
  // already be immutable. Reserve it now so a following structural mutation
  // cannot overtake the value that restores the retained baseline.
  if (requiresImmediateCorrection) runPendingPromptItemUpdate(pendingKey)
}

function trackPendingPromptItemSettlement(pendingKey: string, pending: PendingPromptItemUpdate): void {
  pending.settlementCleanup = registerDurableMutationSettlementListener(pending.outbox.mutationId, (settlement) => {
    pending.settlementCleanup = undefined
    if (pendingPromptItemUpdates.get(pendingKey)?.outbox.mutationId !== pending.outbox.mutationId) return
    if (pending.timer) clearTimeout(pending.timer)
    pendingPromptItemUpdates.delete(pendingKey)
    if (settlement === 'accepted') clearDirtyPromptItemFieldsAcknowledgedByAttempt(pending)
    else promptItemDirtyFieldsByOwnerAndId.delete(pendingKey)
  })
}

/**
 * Detach a targeted row debounce without discarding its durable PATCH, then
 * append DELETE under the same semantic key. A remotely marked PATCH therefore
 * remains an ordered predecessor instead of being overtaken or orphaned.
 */
export function stagePromptItemDeleteMutation(ownerId: string | null, itemId: string): StagedPromptItemDeleteMutation {
  assertClientWriteAccess()
  const pendingKey = promptItemStateKey(ownerId, itemId)
  const pending = pendingPromptItemUpdates.get(pendingKey)
  if (pending?.timer) clearTimeout(pending.timer)
  pendingPromptItemUpdates.delete(pendingKey)

  const intent = promptItemDeleteDurableIntent(ownerId, itemId)
  const stagedDelete = {
    intent,
    outbox: stagePendingMutation(promptItemMutationKey(ownerId, itemId), intent),
  }
  // Reserve the detached PATCH in the live command queue as well. This keeps
  // PATCH-before-DELETE ordering even when IndexedDB durability is unavailable;
  // with durability, a transient attempt remains the DELETE's predecessor.
  if (pending && isCurrentPromptTemplateOwner(ownerId)) dispatchPromptItemUpdate(pending)
  promptItemDirtyFieldsByOwnerAndId.delete(pendingKey)
  return stagedDelete
}

/** Arm an already-durable row update after its prerequisite owner mutation settles. */
export function armPendingPromptItemProjectionUpdate(
  itemId: string,
  delayMs = 250,
  promptPresetId: string | null = currentPromptTemplateOwnerId(),
  projectionFence?: PromptTemplateOwnerMutationFence,
): boolean {
  if (!canUseClientWriteAccess()) return false
  const pendingKey = promptItemStateKey(promptPresetId, itemId)
  const pending = pendingPromptItemUpdates.get(pendingKey)
  if (!pending || !isClientSessionGenerationCurrent(pending.sessionGeneration)) return false
  if (pending.timer) clearTimeout(pending.timer)
  if (projectionFence?.ownerId === promptPresetId) pending.projectionFence = projectionFence
  pending.timer = setTimeout(() => runPendingPromptItemUpdate(pendingKey), delayMs)
  return true
}

export function queuePromptSettingsProjectionPatch(patch: SettingsPatch, previous: SettingsPatch, delayMs = 250): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  pendingPromptSettingsPatch.sessionGeneration = captureClientSessionGeneration()
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in pendingPromptSettingsPatch.previous)) {
      pendingPromptSettingsPatch.previous[key] = cloneJsonValue(previous[key])
    }
    pendingPromptSettingsPatch.attempted[key] = cloneJsonValue(value)
  }

  if (pendingPromptSettingsPatch.timer) clearTimeout(pendingPromptSettingsPatch.timer)
  pendingPromptSettingsPatch.timer = null
  pendingPromptSettingsPatch.projectionEpoch ??= captureSettingsGroupProjectionEpoch('prompt')
  const correctionOnly = refreshPendingPromptSettingsMutation()
  if (Object.keys(pendingPromptSettingsPatch.patch).length === 0) {
    return
  }
  if (correctionOnly) {
    runPendingPromptSettingsPatch()
    return
  }
  pendingPromptSettingsPatch.timer = setTimeout(() => {
    runPendingPromptSettingsPatch()
  }, delayMs)
}

export function dropPendingPromptSettingsProjectionPatchKeys(keys: readonly string[]): void {
  if (!keys.some((key) => hasOwnField(pendingPromptSettingsPatch.attempted, key))) return
  // A projection acknowledgement can arrive after another tab has frozen the
  // staged receipt. Flush the exact desired batch instead of discarding a row
  // whose immutable predecessor may still be delivered later.
  runPendingPromptSettingsPatch()
}

export function replacePendingPromptSettingsProjectionPatchValue(key: string, value: unknown): void {
  if (!canUseClientWriteAccess()) return
  if (!hasOwnField(pendingPromptSettingsPatch.attempted, key)) return
  pendingPromptSettingsPatch.attempted[key] = cloneJsonValue(value)
  const correctionOnly = refreshPendingPromptSettingsMutation()
  if (correctionOnly) runPendingPromptSettingsPatch()
}

export function commitPendingPromptTemplateMutations(options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  for (const pendingKey of Array.from(pendingPromptItemUpdates.keys())) {
    runPendingPromptItemUpdate(pendingKey, options)
  }
  runPendingPromptSettingsPatch(options)
}

registerPendingOwnerMutationFlusher('prompt-template', commitPendingPromptTemplateMutations)

/** Stage only prompt-item drafts owned by the explicitly named presets. */
export function commitPendingPromptTemplateOwnerMutations(
  ownerIds: ReadonlySet<string | null>,
  options: ServerCommandTransportOptions = {},
): void {
  if (!canUseClientWriteAccess()) return
  for (const [pendingKey, pending] of Array.from(pendingPromptItemUpdates.entries())) {
    if (ownerIds.has(pending.ownerId)) runPendingPromptItemUpdate(pendingKey, options)
  }
}

export function resetPromptTemplateSelectionDirtyState(): void {
  for (const pending of pendingPromptItemUpdates.values()) {
    if (pending.timer) clearTimeout(pending.timer)
    pending.settlementCleanup?.()
  }
  pendingPromptItemUpdates.clear()
  promptItemDirtyFieldsByOwnerAndId.clear()
}

function refreshPendingPromptSettingsMutation(): boolean {
  const netChangedKeys = changedSettingsPatchKeys(
    pendingPromptSettingsPatch.previous,
    pendingPromptSettingsPatch.attempted,
  )
  const changedFromDurable = pendingPromptSettingsPatch.outbox
    ? changedSettingsPatchKeys(pendingPromptSettingsPatch.durableAttempted, pendingPromptSettingsPatch.attempted)
    : new Set<string>()
  const nextPatch: SettingsPatch = {}
  for (const key of new Set([...netChangedKeys, ...changedFromDurable])) {
    if (!hasOwnField(pendingPromptSettingsPatch.attempted, key)) continue
    const value = pendingPromptSettingsPatch.attempted[key]
    if (value === undefined) continue
    nextPatch[key] = cloneJsonValue(value)
  }
  pendingPromptSettingsPatch.patch = nextPatch

  if (Object.keys(nextPatch).length === 0) {
    cancelPendingPromptSettingsMutation()
    resetPendingPromptSettingsPatch()
    return false
  }

  const intent = promptSettingsDurableIntent(nextPatch)
  pendingPromptSettingsPatch.intent = intent
  pendingPromptSettingsPatch.outbox = stagePendingMutation(
    SETTINGS_BRIDGE_MUTATION_KEY,
    intent,
    pendingPromptSettingsPatch.outbox,
  )
  pendingPromptSettingsPatch.durableAttempted = cloneJsonValue(pendingPromptSettingsPatch.attempted)
  return netChangedKeys.size === 0
}

function cancelPendingPromptSettingsMutation(): void {
  if (pendingPromptSettingsPatch.outbox) {
    void acknowledgePendingMutation(pendingPromptSettingsPatch.outbox)
  }
  pendingPromptSettingsPatch.intent = null
  pendingPromptSettingsPatch.outbox = null
  pendingPromptSettingsPatch.durableAttempted = {}
}

function changedSettingsPatchKeys(left: SettingsPatch, right: SettingsPatch): Set<string> {
  const changed = new Set<string>()
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!sameSettingsFieldValue(left, right, key)) changed.add(key)
  }
  return changed
}

function resetPendingPromptSettingsPatch(): void {
  if (pendingPromptSettingsPatch.timer) clearTimeout(pendingPromptSettingsPatch.timer)
  pendingPromptSettingsPatch.patch = {}
  pendingPromptSettingsPatch.previous = {}
  pendingPromptSettingsPatch.attempted = {}
  pendingPromptSettingsPatch.durableAttempted = {}
  pendingPromptSettingsPatch.projectionEpoch = null
  pendingPromptSettingsPatch.intent = null
  pendingPromptSettingsPatch.outbox = null
  pendingPromptSettingsPatch.timer = null
}

function promptSettingsDurableIntent(patch: SettingsPatch): DurableMutationIntent {
  return {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: '/settings/prompt',
        body: { patch: cloneJsonValue(patch) },
      },
    ],
  }
}

function runPendingPromptItemUpdate(pendingKey: string, options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  const pending = pendingPromptItemUpdates.get(pendingKey)
  if (!pending || !isClientSessionGenerationCurrent(pending.sessionGeneration)) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingPromptItemUpdates.delete(pendingKey)

  if (!isCurrentPromptTemplateOwner(pending.ownerId)) {
    promptItemDirtyFieldsByOwnerAndId.delete(pendingKey)
    return
  }

  dispatchPromptItemUpdate(pending, options)
}

function dispatchPromptItemUpdate(pending: PendingPromptItemUpdate, options: ServerCommandTransportOptions = {}): void {
  pending.settlementCleanup?.()
  pending.settlementCleanup = undefined
  const optimisticAcknowledgement = capturePromptItemOptimisticAcknowledgement(pending.projectionFence)
  const attempt = registerPromptItemAttempt(pending)

  void dispatchDurableMutation(pending.outbox, pending.intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        updatePromptItemCommand(
          {
            baseRevision,
            ...(pending.ownerId ? { promptPresetId: pending.ownerId } : {}),
            itemId: pending.itemId,
            patch: pending.sparseUpdate.patch,
            ...(pending.sparseUpdate.deleteKeys.length > 0 ? { deleteKeys: pending.sparseUpdate.deleteKeys } : {}),
            optimisticAcknowledgement,
          },
          options.signal,
          options.keepalive,
        ),
      rollback: () => rollbackPromptItemAttempt(attempt),
      signal: options.signal,
      keepalive: options.keepalive,
      ...transport,
    }),
  ).then(
    (result) => {
      clearPromptItemAttempt(attempt)
      if (result.status !== 'ok') return
      clearDirtyPromptItemFieldsAcknowledgedByAttempt(pending)
    },
    () => clearPromptItemAttempt(attempt),
  )
}

function runPendingPromptSettingsPatch(options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(pendingPromptSettingsPatch.sessionGeneration))
    return
  if (pendingPromptSettingsPatch.timer) {
    clearTimeout(pendingPromptSettingsPatch.timer)
    pendingPromptSettingsPatch.timer = null
  }
  const commandPatch = pendingPromptSettingsPatch.patch
  const commandPrevious = pendingPromptSettingsPatch.previous
  const commandAttempted = pendingPromptSettingsPatch.attempted
  const commandProjectionEpoch = pendingPromptSettingsPatch.projectionEpoch
  const stagedIntent = pendingPromptSettingsPatch.intent
  const stagedOutbox = pendingPromptSettingsPatch.outbox
  resetPendingPromptSettingsPatch()

  if (Object.keys(commandPatch).length === 0) {
    if (stagedOutbox) void acknowledgePendingMutation(stagedOutbox)
    return
  }

  const attempt = registerPromptSettingsAttempt(commandPrevious, commandAttempted, commandProjectionEpoch)
  const intent = stagedIntent ?? promptSettingsDurableIntent(commandPatch)
  const outbox = stagedOutbox ?? stagePendingMutation(SETTINGS_BRIDGE_MUTATION_KEY, intent)

  void dispatchDurableMutation(outbox, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        patchPromptSettingsCommand(
          {
            baseRevision,
            patch: commandPatch,
            acknowledgeOptimistic: commandProjectionEpoch !== null,
            optimisticProjectionEpoch: commandProjectionEpoch ?? undefined,
          },
          options.signal,
          options.keepalive,
        ),
      rollback: () => rollbackPromptSettingsAttempt(attempt),
      signal: options.signal,
      keepalive: options.keepalive,
      ...transport,
    }),
  ).then(
    () => clearPromptSettingsAttempt(attempt),
    () => clearPromptSettingsAttempt(attempt),
  )
}

function registerPromptItemAttempt(pending: PendingPromptItemUpdate): PendingPromptItemAttempt {
  const attempt = {
    sequence: ++nextPromptItemAttemptSequence,
    pending,
  }
  pendingPromptItemAttempts.push(attempt)
  return attempt
}

function rollbackPromptItemAttempt(attempt: PendingPromptItemAttempt): void {
  const pending = attempt.pending
  const ownerIsCurrent = isCurrentPromptTemplateOwner(pending.ownerId)
  const fenceIsCurrent = !hasPromptTemplateOwnerMutationFenceChanged(pending.projectionFence)
  if (!ownerIsCurrent) {
    promptItemDirtyFieldsByOwnerAndId.delete(promptItemStateKey(pending.ownerId, pending.itemId))
    markPromptTemplateOwnerAcknowledgementTainted(pending.ownerId)
  } else {
    rollbackPendingPromptItemUpdate(
      pending.binding,
      pending.ownerId,
      pending.itemId,
      pending.previousItem,
      pending.attemptedItem,
      pending.projectionFence,
    )
  }
  if (ownerIsCurrent && fenceIsCurrent) rebaseLaterPromptItemAttempts(attempt)
  clearPromptItemAttempt(attempt)
}

function rebaseLaterPromptItemAttempts(failed: PendingPromptItemAttempt): void {
  const failedPending = failed.pending
  const fields = changedPromptItemFields(failedPending.previousItem, failedPending.attemptedItem)
  for (const field of fields) {
    let rebased = false
    for (const later of pendingPromptItemAttempts) {
      const pending = later.pending
      if (
        later.sequence <= failed.sequence ||
        pending.ownerId !== failedPending.ownerId ||
        pending.itemId !== failedPending.itemId
      ) {
        continue
      }
      if (!changedPromptItemFields(pending.previousItem, pending.attemptedItem).includes(field)) continue
      if (!samePromptItemFieldValue(pending.previousItem, failedPending.attemptedItem, field)) continue
      copyPromptItemFieldValue(pending.previousItem, failedPending.previousItem, field)
      rebased = true
      break
    }

    if (rebased) continue
    const queued = pendingPromptItemUpdates.get(promptItemStateKey(failedPending.ownerId, failedPending.itemId))
    if (
      queued &&
      changedPromptItemFields(queued.previousItem, queued.attemptedItem).includes(field) &&
      samePromptItemFieldValue(queued.previousItem, failedPending.attemptedItem, field)
    ) {
      copyPromptItemFieldValue(queued.previousItem, failedPending.previousItem, field)
    }
  }
}

function clearPromptItemAttempt(attempt: PendingPromptItemAttempt): void {
  const index = pendingPromptItemAttempts.findIndex((candidate) => candidate.sequence === attempt.sequence)
  if (index !== -1) pendingPromptItemAttempts.splice(index, 1)
}

function registerPromptSettingsAttempt(
  previous: SettingsPatch,
  attempted: SettingsPatch,
  projectionEpoch: number | null,
): PendingPromptSettingsAttempt {
  const attempt = {
    sequence: ++nextPromptSettingsAttemptSequence,
    previous,
    attempted,
    projectionEpoch,
  }
  pendingPromptSettingsAttempts.push(attempt)
  return attempt
}

function rollbackPromptSettingsAttempt(attempt: PendingPromptSettingsAttempt): void {
  const canRebase =
    attempt.projectionEpoch !== null && !hasSettingsGroupProjectionEpochChanged('prompt', attempt.projectionEpoch)
  rollbackPromptSettingsPatch(attempt.previous, attempt.attempted, attempt.projectionEpoch)
  if (canRebase) {
    rebaseLaterPromptSettingsAttempts(attempt)
    if (refreshPendingPromptSettingsMutation()) runPendingPromptSettingsPatch()
  }
  clearPromptSettingsAttempt(attempt)
}

function rebaseLaterPromptSettingsAttempts(failed: PendingPromptSettingsAttempt): void {
  for (const key of Object.keys(failed.attempted)) {
    let rebased = false
    for (const later of pendingPromptSettingsAttempts) {
      if (later.sequence <= failed.sequence || !hasOwnField(later.attempted, key)) continue
      if (!sameSettingsFieldValue(later.previous, failed.attempted, key)) continue
      copySettingsFieldValue(later.previous, failed.previous, key)
      rebased = true
      break
    }

    if (
      !rebased &&
      hasOwnField(pendingPromptSettingsPatch.attempted, key) &&
      sameSettingsFieldValue(pendingPromptSettingsPatch.previous, failed.attempted, key)
    ) {
      copySettingsFieldValue(pendingPromptSettingsPatch.previous, failed.previous, key)
    }
  }
}

function samePromptItemFieldValue(left: PromptItem, right: PromptItem, field: string): boolean {
  const leftRecord = promptItemAsRecord(left)
  const rightRecord = promptItemAsRecord(right)
  return sameSettingsFieldValue(leftRecord, rightRecord, field)
}

function copyPromptItemFieldValue(target: PromptItem, source: PromptItem, field: string): void {
  copySettingsFieldValue(promptItemAsRecord(target), promptItemAsRecord(source), field)
}

function sameSettingsFieldValue(left: Record<string, unknown>, right: Record<string, unknown>, key: string): boolean {
  return hasOwnField(left, key) === hasOwnField(right, key) && snapshotJson(left[key]) === snapshotJson(right[key])
}

function copySettingsFieldValue(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (hasOwnField(source, key)) {
    target[key] = cloneJsonValue(source[key])
  } else {
    delete target[key]
  }
}

function hasOwnField(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function clearPromptSettingsAttempt(attempt: PendingPromptSettingsAttempt): void {
  const index = pendingPromptSettingsAttempts.findIndex((candidate) => candidate.sequence === attempt.sequence)
  if (index !== -1) pendingPromptSettingsAttempts.splice(index, 1)
}

function rollbackPendingPromptItemUpdate(
  binding: PromptTemplateDraftBinding,
  ownerId: string | null,
  itemId: string,
  previousItem: PromptItem,
  attemptedItem: PromptItem,
  projectionFence: PromptTemplateOwnerMutationFence,
): void {
  markPromptTemplateOwnerAcknowledgementTainted(ownerId)
  if (projectionFence.ownerId !== ownerId) return
  if (hasPromptTemplateOwnerMutationFenceChanged(projectionFence)) return
  const draftItems = binding.getItems()
  const index = draftItems.findIndex((item) => item.id === itemId)
  const changedFields = changedPromptItemFields(previousItem, attemptedItem)
  if (index === -1 || changedFields.length === 0) return

  const nextItem = cloneJsonValue(draftItems[index])
  const restoredDraftFields = restoreAttemptedPromptItemFields(nextItem, previousItem, attemptedItem, changedFields)
  if (restoredDraftFields.length > 0) {
    const nextItems = [...draftItems]
    nextItems[index] = nextItem
    binding.setItems(nextItems)
  }

  restorePromptItemProjectionFields(ownerId, itemId, previousItem, attemptedItem, changedFields)

  clearPromptItemDirtyFields(ownerId, itemId, restoredDraftFields)
}

function restorePromptItemProjectionFields(
  ownerId: string | null,
  itemId: string,
  previousItem: PromptItem,
  attemptedItem: PromptItem,
  changedFields: readonly string[],
): boolean {
  let complete = true
  withPromptTemplateOwnerWrite(() => {
    const targets: PromptItem[][] = []
    if (ownerId === null) {
      const promptTemplate = legacyPromptTemplateOwnerValue()
      if (Array.isArray(promptTemplate)) targets.push(promptTemplate as PromptItem[])
      else complete = false
    } else {
      const owner = findCanonicalPromptTemplatePreset(ownerId)
      const ownerTemplate = owner?.promptTemplate
      if (!Array.isArray(ownerTemplate)) {
        complete = false
      } else {
        targets.push(ownerTemplate as PromptItem[])
      }
    }

    for (const target of targets) {
      const projectionIndex = target.findIndex((item) => item.id === itemId)
      if (projectionIndex === -1) {
        complete = false
        continue
      }
      const nextProjectionItem = cloneJsonValue(target[projectionIndex])
      const restoredFields = restoreAttemptedPromptItemFields(
        nextProjectionItem,
        previousItem,
        attemptedItem,
        changedFields,
      )
      if (restoredFields.length !== changedFields.length) complete = false
      if (restoredFields.length > 0) target[projectionIndex] = nextProjectionItem
    }
  })
  return complete
}

function restoreAttemptedPromptItemFields(
  target: PromptItem,
  previousItem: PromptItem,
  attemptedItem: PromptItem,
  fields: readonly string[],
): string[] {
  const targetRecord = promptItemAsRecord(target)
  const previousRecord = promptItemAsRecord(previousItem)
  const attemptedRecord = promptItemAsRecord(attemptedItem)
  const restored: string[] = []

  for (const field of fields) {
    const targetHasField = Object.prototype.hasOwnProperty.call(targetRecord, field)
    const attemptedHasField = Object.prototype.hasOwnProperty.call(attemptedRecord, field)
    if (
      targetHasField !== attemptedHasField ||
      snapshotJson(targetRecord[field]) !== snapshotJson(attemptedRecord[field])
    ) {
      continue
    }
    if (Object.prototype.hasOwnProperty.call(previousRecord, field)) {
      targetRecord[field] = cloneJsonValue(previousRecord[field])
    } else {
      delete targetRecord[field]
    }
    restored.push(field)
  }
  return restored
}

function rollbackPromptSettingsPatch(
  previous: SettingsPatch,
  attempted: SettingsPatch,
  projectionEpoch: number | null,
): void {
  markSettingsGroupAcknowledgementTainted('prompt')
  if (projectionEpoch === null || hasSettingsGroupProjectionEpochChanged('prompt', projectionEpoch)) return
  withPromptTemplateOwnerWrite(() => {
    if (settingsResourceState.groupStatuses.prompt !== 'ready') return
    const target = settingsResourceState.value as unknown as Record<string, unknown>
    for (const [key, previousValue] of Object.entries(previous)) {
      if (snapshotJson(target[key]) === snapshotJson(attempted[key])) {
        target[key] = cloneJsonValue(previousValue)
      }
    }
  })
}

export interface PromptTemplateReconcileResult {
  /** The cached command revision observed on this pass (store it as the next baseline). */
  revision: number | null
  /** A fresh draft value to adopt, or `null` when no reconcile is needed. */
  nextDraft: PromptItem[] | null
  /** Whether adopting `nextDraft` changes the prompt-item ID sequence. */
  structuralAdoption: boolean
}

/**
 * Decide whether the prompt-template draft should be re-pulled from server
 * resource state. The cached command revision is the discriminator: a keystroke's
 * optimistic write never advances it, so reconciliation only runs after a real
 * server push / command response. The whole-template stringify only happens on
 * such a revision advance, never per keystroke.
 *
 * Reads the current owner's projection so a caller `$effect` registers the
 * resource-state dependency and re-runs on a server push.
 */
export function reconcilePromptTemplateDraft(
  draftItems: PromptItem[],
  previousRevision: number | null,
  projectedItems: PromptItem[] = readPromptTemplateOwnerItems(currentPromptTemplateOwnerId()),
): PromptTemplateReconcileResult {
  const ownerId = currentPromptTemplateOwnerId()
  if (!isPromptTemplateHydrated(ownerId)) {
    return { revision: previousRevision, nextDraft: null, structuralAdoption: false }
  }
  const serverValue = applyPendingPromptTemplateStructuralItems(ownerId, projectedItems)
  const revision = peekCachedServerCommandRevision()
  if (revision === previousRevision) return { revision, nextDraft: null, structuralAdoption: false }
  if (ownerDirtyFieldCount(ownerId) > 0) {
    clearDirtyPromptItemFieldsMatchingProjection(ownerId, draftItems ?? [], serverValue)
  }
  if (snapshotJson(serverValue) === snapshotJson(draftItems ?? [])) {
    return { revision, nextDraft: null, structuralAdoption: false }
  }
  if (ownerDirtyFieldCount(ownerId) > 0) {
    const mergedDraft = mergePromptTemplateProjectionRows(ownerId, draftItems ?? [], serverValue)
    if (mergedDraft) {
      if (snapshotJson(mergedDraft) === snapshotJson(draftItems ?? [])) {
        return { revision, nextDraft: null, structuralAdoption: false }
      }
      return { revision, nextDraft: mergedDraft, structuralAdoption: false }
    }
    return {
      revision,
      nextDraft: mergeDirtyPromptTemplateProjectionRows(ownerId, draftItems ?? [], serverValue),
      structuralAdoption: true,
    }
  }
  return {
    revision,
    nextDraft: cloneJsonValue(serverValue),
    structuralAdoption: !samePromptItemIdSequence(draftItems ?? [], serverValue),
  }
}

function promptItemStateKey(ownerId: string | null, itemId: string): string {
  return `${ownerId ?? '__legacy__'}:${itemId}`
}

type PromptItemRecord = Record<string, unknown> & { id?: string }

function promptItemAsRecord(item: PromptItem): PromptItemRecord {
  return item as unknown as PromptItemRecord
}

function promptItemIdValue(item: PromptItem): string | null {
  const id = promptItemAsRecord(item).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function changedPromptItemFields(previousItem: PromptItem, attemptedItem: PromptItem): string[] {
  const previous = promptItemAsRecord(previousItem)
  const attempted = promptItemAsRecord(attemptedItem)
  const changed: string[] = []
  const keys = new Set([...Object.keys(previous), ...Object.keys(attempted)])

  for (const key of keys) {
    if (key === 'id') continue
    if (snapshotJson(previous[key]) !== snapshotJson(attempted[key])) {
      changed.push(key)
    }
  }

  return changed
}

function sparsePromptItemUpdate(previousItem: PromptItem, attemptedItem: PromptItem): SparsePromptItemUpdate | null {
  const previous = promptItemAsRecord(previousItem)
  const attempted = promptItemAsRecord(attemptedItem)
  const patch: PromptItemSnapshot = {}
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

  return Object.keys(patch).length > 0 || deleteKeys.length > 0 ? { patch, deleteKeys } : null
}

function mergeSparsePromptItemUpdates(...updates: Array<SparsePromptItemUpdate | null>): SparsePromptItemUpdate | null {
  const patch: PromptItemSnapshot = {}
  const deleteKeys = new Set<string>()

  for (const update of updates) {
    if (!update) continue
    for (const [key, value] of Object.entries(update.patch)) {
      patch[key] = cloneJsonValue(value)
      deleteKeys.delete(key)
    }
    for (const key of update.deleteKeys) {
      delete patch[key]
      deleteKeys.add(key)
    }
  }

  return Object.keys(patch).length > 0 || deleteKeys.size > 0 ? { patch, deleteKeys: [...deleteKeys] } : null
}

function promptItemUpdateDurableIntent(
  ownerId: string | null,
  itemId: string,
  update: SparsePromptItemUpdate,
): DurableMutationIntent {
  return {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: `/prompt-items/${encodeURIComponent(itemId)}`,
        body: {
          ...(ownerId ? { promptPresetId: ownerId } : {}),
          patch: cloneJsonValue(update.patch),
          ...(update.deleteKeys.length > 0 ? { deleteKeys: [...update.deleteKeys] } : {}),
        },
      },
    ],
  }
}

function promptItemDeleteDurableIntent(ownerId: string | null, itemId: string): DurableMutationIntent {
  return {
    version: 1,
    requests: [
      {
        method: 'DELETE',
        path: `/prompt-items/${encodeURIComponent(itemId)}`,
        body: ownerId ? { promptPresetId: ownerId } : {},
      },
    ],
  }
}

function markDirtyPromptItemFields(
  ownerId: string | null,
  itemId: string,
  previousItem: PromptItem,
  attemptedItem: PromptItem,
): void {
  const changedFields = changedPromptItemFields(previousItem, attemptedItem)
  if (changedFields.length === 0) return

  const dirtyKey = promptItemStateKey(ownerId, itemId)
  let dirtyFields = promptItemDirtyFieldsByOwnerAndId.get(dirtyKey)
  if (!dirtyFields) {
    dirtyFields = new Set()
    promptItemDirtyFieldsByOwnerAndId.set(dirtyKey, dirtyFields)
  }

  for (const field of changedFields) {
    dirtyFields.add(field)
  }
}

function clearPromptItemDirtyFields(ownerId: string | null, itemId: string, fields: Iterable<string>): void {
  const dirtyKey = promptItemStateKey(ownerId, itemId)
  const dirtyFields = promptItemDirtyFieldsByOwnerAndId.get(dirtyKey)
  if (!dirtyFields) return

  for (const field of fields) {
    dirtyFields.delete(field)
  }

  if (dirtyFields.size === 0) {
    promptItemDirtyFieldsByOwnerAndId.delete(dirtyKey)
  }
}

function clearDirtyPromptItemFieldsAcknowledgedByAttempt(pending: PendingPromptItemUpdate): void {
  const currentItem = pending.binding.getItems().find((item) => promptItemIdValue(item) === pending.itemId)
  if (!currentItem) return

  const acknowledgedFields = new Set([...Object.keys(pending.sparseUpdate.patch), ...pending.sparseUpdate.deleteKeys])
  clearPromptItemDirtyFields(
    pending.ownerId,
    pending.itemId,
    Array.from(acknowledgedFields).filter((field) =>
      samePromptItemFieldValue(currentItem, pending.attemptedItem, field),
    ),
  )
}

function clearDirtyPromptItemFieldsMatchingProjection(
  ownerId: string | null,
  draftItems: PromptItem[],
  serverItems: PromptItem[],
): void {
  const draftItemsById = promptItemsById(draftItems)
  const serverItemsById = promptItemsById(serverItems)

  for (const [dirtyKey, dirtyFields] of Array.from(promptItemDirtyFieldsByOwnerAndId.entries())) {
    const itemId = itemIdFromPromptItemStateKey(ownerId, dirtyKey)
    if (!itemId) continue
    const draftItem = draftItemsById.get(itemId)
    const serverItem = serverItemsById.get(itemId)

    if (!draftItem || !serverItem) {
      promptItemDirtyFieldsByOwnerAndId.delete(dirtyKey)
      continue
    }

    const draftRecord = promptItemAsRecord(draftItem)
    const serverRecord = promptItemAsRecord(serverItem)
    for (const field of Array.from(dirtyFields)) {
      if (snapshotJson(draftRecord[field]) === snapshotJson(serverRecord[field])) {
        dirtyFields.delete(field)
      }
    }

    if (dirtyFields.size === 0) {
      promptItemDirtyFieldsByOwnerAndId.delete(dirtyKey)
    }
  }
}

function mergePromptTemplateProjectionRows(
  ownerId: string | null,
  draftItems: PromptItem[],
  serverItems: PromptItem[],
): PromptItem[] | null {
  if (!samePromptItemIdSequence(draftItems, serverItems)) return null

  return mergeDirtyPromptTemplateProjectionRows(ownerId, draftItems, serverItems)
}

function mergeDirtyPromptTemplateProjectionRows(
  ownerId: string | null,
  draftItems: PromptItem[],
  serverItems: PromptItem[],
): PromptItem[] {
  const draftItemsById = promptItemsById(draftItems)
  return serverItems.map((serverItem) => {
    const itemId = promptItemIdValue(serverItem)
    const dirtyFields = itemId ? promptItemDirtyFieldsByOwnerAndId.get(promptItemStateKey(ownerId, itemId)) : undefined
    const draftItem = itemId ? draftItemsById.get(itemId) : undefined

    if (!itemId || !dirtyFields || dirtyFields.size === 0 || !draftItem) {
      return cloneJsonValue(serverItem)
    }

    return mergeProjectionIntoDirtyDraft({
      draft: cloneJsonValue(promptItemAsRecord(draftItem)),
      projection: promptItemAsRecord(serverItem),
      dirtyFields,
    }) as unknown as PromptItem
  })
}

function itemIdFromPromptItemStateKey(ownerId: string | null, dirtyKey: string): string | null {
  const prefix = `${ownerId ?? '__legacy__'}:`
  return dirtyKey.startsWith(prefix) ? dirtyKey.slice(prefix.length) : null
}

function ownerDirtyFieldCount(ownerId: string | null): number {
  const prefix = `${ownerId ?? '__legacy__'}:`
  let count = 0
  for (const [dirtyKey, dirtyFields] of promptItemDirtyFieldsByOwnerAndId.entries()) {
    if (dirtyKey.startsWith(prefix)) count += dirtyFields.size
  }
  return count
}

function samePromptItemIdSequence(leftItems: PromptItem[], rightItems: PromptItem[]): boolean {
  if (leftItems.length !== rightItems.length) return false

  for (let index = 0; index < leftItems.length; index += 1) {
    const leftId = promptItemIdValue(leftItems[index])
    const rightId = promptItemIdValue(rightItems[index])
    if (!leftId || !rightId || leftId !== rightId) return false
  }

  return true
}

function findPromptItemIndexById(items: PromptItem[], itemId: string | null): number {
  if (!itemId) return -1
  return items.findIndex((item) => promptItemIdValue(item) === itemId)
}

function promptItemIdList(items: PromptItem[]): string[] | null {
  const itemIds: string[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const itemId = promptItemIdValue(item)
    if (!itemId || seen.has(itemId)) return null
    seen.add(itemId)
    itemIds.push(itemId)
  }

  return itemIds
}

function stringArraysEqual(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (!left || !right || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function promptItemsById(items: PromptItem[]): Map<string, PromptItem> {
  const itemsById = new Map<string, PromptItem>()
  for (const item of items) {
    const itemId = promptItemIdValue(item)
    if (itemId) itemsById.set(itemId, item)
  }
  return itemsById
}

function findCanonicalPromptTemplatePreset(ownerId: string): Record<string, unknown> | null {
  const presets = promptPresetOwnerRows()
  if (!presets) return null
  const seenPresetIds = new Set<string>()
  let owner: Record<string, unknown> | null = null
  for (const candidate of presets) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const preset = candidate as unknown as Record<string, unknown>
    const presetId = preset.id
    if (typeof presetId !== 'string' || presetId.trim() === '' || seenPresetIds.has(presetId)) return null
    seenPresetIds.add(presetId)
    if (presetId === ownerId) owner = preset
  }
  return owner
}

function applyPromptTemplateCollectionRollback(
  binding: PromptTemplateDraftBinding,
  ownerId: string | null,
  nextItems: PromptItem[],
): boolean {
  binding.setItems(nextItems)
  let complete = true
  withPromptTemplateOwnerWrite(() => {
    if (ownerId === null) {
      writeLegacyPromptTemplateOwnerValue(cloneJsonValue(nextItems))
      return
    }
    const owner = findCanonicalPromptTemplatePreset(ownerId)
    if (!owner) {
      complete = false
      return
    }
    owner.promptTemplate = cloneJsonValue(nextItems)
  })
  return complete
}

function readPromptTemplateOwnerItems(ownerId: string | null): PromptItem[] {
  if (ownerId === null) {
    const promptTemplate = legacyPromptTemplateOwnerValue()
    return (Array.isArray(promptTemplate) ? promptTemplate : []) as PromptItem[]
  }
  const owner = findCanonicalPromptTemplatePreset(ownerId)
  return (Array.isArray(owner?.promptTemplate) ? owner.promptTemplate : []) as PromptItem[]
}
