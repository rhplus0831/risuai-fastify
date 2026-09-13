import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import type { SettingItem, SettingContext } from './types'
import type { Database } from '../storage/databaseTypes'
import { flushPendingSplitPresetPatch } from '../storage/database.svelte'
import { language } from 'src/lang'
import { alertError } from '../alert'
import { accessibilitySettingsItems } from './accessibilitySettingsData'
import { interactionSettingsItems } from './interactionSettingsData'
import { advancedSettingsItems } from './advancedSettingsData'
import {
  basicParameterItems,
  modelSpecificParameterItems,
  penaltyParameterItems,
  samplingParameterItems,
  seedSetting,
} from './botSettingsParamsData'
import { chatFormatSettingsItems } from './chatFormatSettingsData'
import { displaySettingsItems } from './displaySettingsData.svelte'
import { languageSupplementalSettingsItems } from './languageSettingsData.svelte'
import { memorySettingsItems } from './memorySettingsData'
import { modelSupplementalSettingsItems } from './modelSupplementalSettingsData'
import { pluginSupplementalSettingsItems } from './pluginSupplementalSettingsData'
import { promptSupplementalSettingsItems } from './promptSupplementalSettingsData'
import {
  canUseServerCommands,
  patchServerBackedSettings,
  settingsGroupForKey,
  type ServerCommandTransportOptions,
} from '../server/commands'
import {
  captureCollectionProjectionEpoch,
  captureSettingsGroupProjectionEpoch,
  captureSettingsPatchProjectionEpochs,
  settingsResourceState,
} from '../server/resourceState.svelte'
import type { SettingsGroupProjectionEpochs } from '../server/settingsGroups'
import {
  registerPendingOwnerResetter,
  registerPendingOwnerMutationFlusher,
} from '../server/pendingOwnerMutationRegistry'
import {
  currentTopLevelPresetFieldMirrorValue,
  mirrorTopLevelPresetField,
  mirrorTopLevelPresetFieldToTarget,
  resolveTopLevelPresetFieldMirrorTarget,
  type TopLevelPresetFieldMirrorTarget,
} from '../presetFieldMirror'
import {
  currentPromptPresetModelOverrideMirrorValue,
  currentPromptPresetModelOverrideValue,
  mirrorPromptPresetModelOverrideField,
  mirrorPromptPresetModelOverrideFieldToTarget,
  resolvePromptPresetModelOverrideMirrorTarget,
  type PromptPresetModelOverrideMirrorTarget,
} from '../promptPresetModelOverrides.svelte'
import { promptPresetModelOverrideFieldForDatabaseKey } from '../presetSplit'
import {
  serverSettingDraftOwnerKey,
  splitPresetSettingDraftOwnerKey,
  type SplitPresetDraftProjection,
} from '../server/settingsDraftAcknowledgement'
import { dispatchDurableMutation, registerDurableMutationSettlementListener } from '../server/durableMutationDispatch'
import { SETTINGS_BRIDGE_MUTATION_KEY } from '../server/settingsMutationKey'
import {
  acknowledgePendingMutation,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
} from '../server/pendingMutationOutbox'
import {
  canProjectPendingSettings,
  registerPendingSettingsProjectionOverlay,
} from '../server/settingsPendingProjection'
import { reportWriterAccessLostMutation } from '../server/activeWriterSession'

/**
 * Sentinel value representing an uninitialized local state in wrapper components.
 * Used instead of `undefined` so that a legitimate `undefined` DB value
 * can still be written back without being silently ignored.
 */
export const UNINITIALIZED = Symbol('uninitialized')

export const DEFERRED_SETTING_INPUT_DELAY_MS = 250

export interface DeferredSettingWriteResult {
  ownerKey: string
  queued: boolean
  rootKey: string | null
  path: string[]
  splitPresetProjection: SplitPresetDraftProjection
}

interface DeferredServerSettingTarget {
  kind: 'server'
  ownerKey: string
  rootKey: string
}

interface DeferredPresetSettingTarget {
  kind: 'preset'
  ownerKey: string
  rootKey: string
  target: TopLevelPresetFieldMirrorTarget
}

interface DeferredPromptOverrideSettingTarget {
  kind: 'promptOverride'
  ownerKey: string
  rootKey: string
  target: PromptPresetModelOverrideMirrorTarget
}

type DeferredSettingTarget =
  | DeferredServerSettingTarget
  | DeferredPresetSettingTarget
  | DeferredPromptOverrideSettingTarget

interface DeferredSettingEdit {
  path: string[]
  runtimeEffect?: {
    ctx: SettingContext
    item: SettingItem
  }
  value: unknown
}

interface PendingDeferredSettingWrite {
  sessionGeneration: number
  desiredRoot: unknown
  durableAttemptedRoot?: unknown
  edits: Map<string, DeferredSettingEdit>
  intent?: DurableMutationIntent
  outbox?: PendingMutationHandle
  optimisticProjectionEpochs?: SettingsGroupProjectionEpochs
  previousRoot: unknown
  target: DeferredSettingTarget
  timer: ReturnType<typeof setTimeout>
}

interface PendingDeferredServerSettingAttempt {
  sessionGeneration: number
  sequence: number
  ownerKey: string
  rootKey: string
  previousRoot: unknown
  attemptedRoot: unknown
  outbox: PendingMutationHandle
  phase: 'dispatching' | 'queued' | 'accepted-replay'
  settlementCleanup?: () => void
}

const pendingDeferredSettingWrites = new Map<string, PendingDeferredSettingWrite>()
const pendingDeferredServerSettingAttempts: PendingDeferredServerSettingAttempt[] = []
const deferredSettingOwnerResetEpochs = new Map<string, number>()
let nextDeferredServerSettingAttemptSequence = 0
registerPendingOwnerMutationFlusher('setting-renderer-inputs', flushDeferredSettingWrites)
registerPendingOwnerResetter('setting-renderer-inputs', resetDeferredSettingWritesForDatabaseReplacement)
registerPendingSettingsProjectionOverlay((target, allowedKeys) => {
  const converged: PendingDeferredServerSettingAttempt[] = []
  for (const attempt of [...pendingDeferredServerSettingAttempts]) {
    if (!canProjectPendingSettings(attempt.sessionGeneration)) {
      if (attempt.phase === 'accepted-replay') converged.push(attempt)
      continue
    }
    if (allowedKeys && !allowedKeys.has(attempt.rootKey)) continue
    if (
      attempt.phase === 'accepted-replay' &&
      snapshotJson(target[attempt.rootKey]) === snapshotJson(attempt.attemptedRoot)
    ) {
      converged.push(attempt)
      continue
    }
    target[attempt.rootKey] = cloneJsonValue(attempt.attemptedRoot)
  }
  for (const pending of pendingDeferredSettingWrites.values()) {
    if (!canProjectPendingSettings(pending.sessionGeneration)) continue
    if (pending.target.kind !== 'server') continue
    if (allowedKeys && !allowedKeys.has(pending.target.rootKey)) continue
    target[pending.target.rootKey] = cloneJsonValue(pending.desiredRoot)
  }
  for (const attempt of converged) clearDeferredServerSettingAttempt(attempt)
})

function createSettingSaveFailureReporter(): () => void {
  const generation = captureClientSessionGeneration()
  let reported = false
  return () => {
    if (reported || !canProjectPendingSettings(generation)) return
    reported = true
    alertError(language.errors.settingsSaveFailed)
  }
}

export function getLabel(item: SettingItem): string {
  if (item.labelKey && (language as any)[item.labelKey]) {
    return (language as any)[item.labelKey]
  }
  return item.fallbackLabel ?? ''
}

export function getSettingValue(item: SettingItem, ctx: SettingContext): any {
  const promptOverrideValue = getPromptPresetOverrideSettingValue(item, ctx)
  if (promptOverrideValue.found) return promptOverrideValue.value

  if (item.getValue) {
    const settings = currentSettingsOwner(item)
    return settings ? item.getValue(settings, ctx) : undefined
  }
  if (item.bindPath) {
    const parts = item.bindPath.split('.')
    let value: any = currentSettingsOwner(item)
    for (const part of parts) {
      value = value?.[part]
    }
    return value
  }
  if (item.bindKey) {
    return currentSettingsOwner(item)?.[item.bindKey]
  }
  return undefined
}

export function setSettingValue(item: SettingItem, newValue: any, ctx: SettingContext): void {
  if (!canUseClientWriteAccess()) return
  if (reportWriterAccessLostMutation()) return
  const previousValue = getSettingValue(item, ctx)
  const commandPatch = buildServerSettingsPatch(item)
  const serverTarget = commandPatch ? resolveDeferredServerSettingTarget(commandPatch.key) : null
  const previousRoot = serverTarget ? currentDeferredSettingTargetValue(serverTarget) : undefined
  const optimisticProjectionEpochs = commandPatch
    ? captureSettingsPatchProjectionEpochs({ [commandPatch.key]: previousRoot })
    : undefined

  if (!writeLocalSettingValue(item, newValue, ctx)) return

  const mirroredToPreset = mirrorSettingValueToSelectedPreset(item, newValue, ctx)

  if (commandPatch && !mirroredToPreset) {
    const desiredRoot = commandPatch.valueFromDb()
    if (!serverTarget || desiredRoot === undefined) {
      rollbackLocalSetting(item, newValue, previousValue, ctx)
      return
    }
    const path = deferredSettingPath(item)
    const queued = queueDeferredSettingWrite(
      serverTarget,
      previousRoot,
      path,
      path.length === 0 ? desiredRoot : newValue,
      item,
      ctx,
      optimisticProjectionEpochs,
      0,
    )
    if (queued) dispatchDeferredSettingWrite(serverTarget.ownerKey)
  }
}

/**
 * Optimistically update a continuous input while delaying its durable command.
 * Writes sharing the same server-owned root and preset owner share one timer,
 * so nested controls cannot race independent whole-root patches.
 */
export function setDeferredSettingValue(
  item: SettingItem,
  newValue: any,
  ctx: SettingContext,
  options: { delayMs?: number } = {},
): DeferredSettingWriteResult {
  if (!canUseClientWriteAccess() || reportWriterAccessLostMutation()) {
    return {
      ownerKey: localSettingOwnerKey(item),
      queued: false,
      rootKey: settingRootKey(item),
      path: deferredSettingPath(item),
      splitPresetProjection: ctx.presetMirrorTarget === 'promptModelOverrides' ? 'presetRow' : 'selectedSettings',
    }
  }
  const target = resolveDeferredSettingTarget(item, ctx)
  const previousRoot = target ? currentDeferredSettingTargetValue(target) : undefined
  const optimisticProjectionEpochs =
    target?.kind === 'server' ? captureSettingsPatchProjectionEpochs({ [target.rootKey]: previousRoot }) : undefined

  if (!writeLocalSettingValue(item, newValue, ctx)) {
    return {
      ownerKey: target?.ownerKey ?? localSettingOwnerKey(item),
      queued: false,
      rootKey: target?.rootKey ?? settingRootKey(item),
      path: deferredSettingPath(item),
      splitPresetProjection: target?.kind === 'promptOverride' ? 'presetRow' : 'selectedSettings',
    }
  }

  if (!target) {
    return {
      ownerKey: localSettingOwnerKey(item),
      queued: false,
      rootKey: settingRootKey(item),
      path: deferredSettingPath(item),
      splitPresetProjection: 'selectedSettings',
    }
  }

  return {
    ownerKey: target.ownerKey,
    queued: queueDeferredSettingWrite(
      target,
      previousRoot,
      deferredSettingPath(item),
      newValue,
      item,
      ctx,
      optimisticProjectionEpochs,
      options.delayMs ?? DEFERRED_SETTING_INPUT_DELAY_MS,
    ),
    rootKey: target.rootKey,
    path: deferredSettingPath(item),
    splitPresetProjection: target.kind === 'promptOverride' ? 'presetRow' : 'selectedSettings',
  }
}

/** Reapply a dirty control after a projection without scheduling another command. */
export function reassertSettingValue(item: SettingItem, value: any, ctx: SettingContext): void {
  if (!canUseClientWriteAccess()) return
  if (snapshotJson(getSettingValue(item, ctx)) === snapshotJson(value)) return
  writeLocalSettingValue(item, cloneJsonValue(value), ctx)
}

export function getSettingWriteOwnerKey(item: SettingItem, ctx: SettingContext): string {
  return resolveDeferredSettingTarget(item, ctx)?.ownerKey ?? localSettingOwnerKey(item)
}

export interface SettingOwnerProjectionToken {
  ownerKey: string
  projectionEpoch: number
  resetEpoch: number
}

/** Exact projection/reset token for one renderer-owned settings root or split-preset row. */
export function getSettingOwnerProjectionToken(item: SettingItem, ctx: SettingContext): SettingOwnerProjectionToken {
  const target = resolveDeferredSettingTarget(item, ctx)
  const ownerKey = target?.ownerKey ?? localSettingOwnerKey(item)
  let projectionEpoch = 0

  if (target?.kind === 'preset') {
    projectionEpoch = captureCollectionProjectionEpoch(
      target.target.kind === 'model' ? 'modelPresets' : 'promptPresets',
    )
  } else if (target?.kind === 'promptOverride') {
    projectionEpoch = captureCollectionProjectionEpoch('promptPresets')
  } else {
    const rootKey = target?.rootKey ?? settingRootKey(item)
    const group = rootKey ? settingsGroupForKey(rootKey) : null
    if (group) projectionEpoch = captureSettingsGroupProjectionEpoch(group)
  }

  return {
    ownerKey,
    projectionEpoch,
    resetEpoch: deferredSettingOwnerResetEpochs.get(ownerKey) ?? 0,
  }
}

export function flushDeferredSettingWrites(options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  for (const ownerKey of [...pendingDeferredSettingWrites.keys()]) {
    dispatchDeferredSettingWrite(ownerKey, options)
  }
}

export function clearDeferredSettingWrites(): void {
  clearDeferredSettingWriteState(true)
}

/** Explicit ownership-reset hook for replacement-database adoption. */
export function resetDeferredSettingWritesForDatabaseReplacement(): void {
  clearDeferredSettingWriteState(false)
}

function clearDeferredSettingWriteState(acknowledgeOutbox: boolean): void {
  const retiredOwnerKeys = new Set([
    ...pendingDeferredSettingWrites.keys(),
    ...pendingDeferredServerSettingAttempts.map((attempt) => attempt.ownerKey),
  ])
  for (const ownerKey of retiredOwnerKeys) {
    deferredSettingOwnerResetEpochs.set(ownerKey, (deferredSettingOwnerResetEpochs.get(ownerKey) ?? 0) + 1)
  }
  for (const pending of pendingDeferredSettingWrites.values()) {
    clearTimeout(pending.timer)
    if (acknowledgeOutbox && pending.outbox) void acknowledgePendingMutation(pending.outbox)
  }
  pendingDeferredSettingWrites.clear()
  for (const attempt of [...pendingDeferredServerSettingAttempts]) clearDeferredServerSettingAttempt(attempt)
}

function writeLocalSettingValue(item: SettingItem, newValue: any, ctx: SettingContext): boolean {
  if (!setLocalSettingValue(item, newValue, ctx)) return false

  item.onChange?.(newValue, ctx)
  return true
}

function resolveDeferredSettingTarget(item: SettingItem, ctx: SettingContext): DeferredSettingTarget | null {
  const rootKey = settingRootKey(item)
  if (!rootKey) return null

  if (ctx.presetMirrorTarget === 'promptModelOverrides' && promptPresetModelOverrideFieldForDatabaseKey(rootKey)) {
    const target = resolvePromptPresetModelOverrideMirrorTarget(rootKey)
    if (target) {
      return {
        kind: 'promptOverride',
        ownerKey: splitPresetSettingDraftOwnerKey('prompt', target.presetId, target.presetField),
        rootKey,
        target,
      }
    }
    return resolveDeferredServerSettingTarget(rootKey)
  }

  const presetTarget = resolveTopLevelPresetFieldMirrorTarget(rootKey)
  if (presetTarget) {
    return {
      kind: 'preset',
      ownerKey: splitPresetSettingDraftOwnerKey(presetTarget.kind, presetTarget.presetId, presetTarget.presetKey),
      rootKey,
      target: presetTarget,
    }
  }

  return resolveDeferredServerSettingTarget(rootKey)
}

function resolveDeferredServerSettingTarget(rootKey: string): DeferredServerSettingTarget | null {
  if (!canUseServerCommands() || !settingsGroupForKey(rootKey)) return null
  return { kind: 'server', ownerKey: serverSettingDraftOwnerKey(rootKey), rootKey }
}

function currentDeferredSettingTargetValue(target: DeferredSettingTarget): unknown {
  if (target.kind === 'server') {
    return cloneJsonValue(currentSettingsOwnerRoot(target.rootKey))
  }
  if (target.kind === 'promptOverride') {
    return currentPromptPresetModelOverrideMirrorValue(target.target)
  }
  const value = currentTopLevelPresetFieldMirrorValue(target.target)
  return value === undefined ? cloneJsonValue(currentSettingsOwnerRoot(target.rootKey)) : value
}

function queueDeferredSettingWrite(
  target: DeferredSettingTarget,
  previousRoot: unknown,
  path: string[],
  value: unknown,
  item: SettingItem,
  ctx: SettingContext,
  optimisticProjectionEpochs: SettingsGroupProjectionEpochs | undefined,
  delayMs: number,
): boolean {
  if (!canUseClientWriteAccess()) return false
  const sessionGeneration = captureClientSessionGeneration()
  const retained = pendingDeferredSettingWrites.get(target.ownerKey)
  if (retained) clearTimeout(retained.timer)
  // Retiring a local merge buffer never acknowledges its durable intent.
  const existing = retained && isClientSessionGenerationCurrent(retained.sessionGeneration) ? retained : undefined

  const edits = existing?.edits ?? new Map<string, DeferredSettingEdit>()
  const editKey = path.join('\u0000')
  if (path.length === 0) edits.clear()
  edits.set(editKey, {
    path,
    runtimeEffect: item.onChange ? { ctx, item } : undefined,
    value: cloneJsonValue(value),
  })

  let desiredRoot = cloneJsonValue(currentSettingsOwnerRoot(target.rootKey))
  for (const edit of edits.values()) {
    desiredRoot = applyDeferredSettingEdit(desiredRoot, edit)
  }

  const baseline = existing?.previousRoot ?? cloneJsonValue(previousRoot)
  const netChanged = snapshotJson(desiredRoot) !== snapshotJson(baseline)
  if (!netChanged && target.kind !== 'server') {
    // The split-preset queue was entered on the first edit. Mirror the revert
    // through that same queue so it can discard its staged intermediate value.
    if (target.kind === 'preset') {
      mirrorTopLevelPresetFieldToTarget(target.target, desiredRoot)
    } else if (target.kind === 'promptOverride') {
      mirrorPromptPresetModelOverrideFieldToTarget(target.target, desiredRoot)
    }
    pendingDeferredSettingWrites.delete(target.ownerKey)
    if (existing?.outbox) void acknowledgePendingMutation(existing.outbox)
    return false
  }

  // Preset-owned renderer inputs already have a purpose-built delayed queue.
  // Enter it now (rather than after this queue's timer) so its exact split-row
  // intent is crash durable from the first keystroke.
  if (target.kind === 'preset') {
    if (!mirrorTopLevelPresetFieldToTarget(target.target, desiredRoot)) return false
    pendingDeferredSettingWrites.set(target.ownerKey, {
      sessionGeneration,
      desiredRoot: cloneJsonValue(desiredRoot),
      edits,
      previousRoot: baseline,
      target,
      timer: setTimeout(() => dispatchDeferredSettingWrite(target.ownerKey), delayMs),
    })
    return true
  }
  if (target.kind === 'promptOverride') {
    if (!mirrorPromptPresetModelOverrideFieldToTarget(target.target, desiredRoot)) return false
    pendingDeferredSettingWrites.set(target.ownerKey, {
      sessionGeneration,
      desiredRoot: cloneJsonValue(desiredRoot),
      edits,
      previousRoot: baseline,
      target,
      timer: setTimeout(() => dispatchDeferredSettingWrite(target.ownerKey), delayMs),
    })
    return true
  }

  const changedFromDurable =
    !!existing?.outbox && snapshotJson(desiredRoot) !== snapshotJson(existing.durableAttemptedRoot)
  if (!netChanged && !changedFromDurable) {
    pendingDeferredSettingWrites.delete(target.ownerKey)
    if (existing?.outbox) void acknowledgePendingMutation(existing.outbox)
    return false
  }

  const intent = deferredServerSettingDurableIntent(target, desiredRoot)
  const outbox = stagePendingMutation(SETTINGS_BRIDGE_MUTATION_KEY, intent, existing?.outbox)

  const pending: PendingDeferredSettingWrite = {
    sessionGeneration,
    desiredRoot: cloneJsonValue(desiredRoot),
    durableAttemptedRoot: cloneJsonValue(desiredRoot),
    edits,
    intent,
    outbox,
    optimisticProjectionEpochs: existing?.optimisticProjectionEpochs ?? optimisticProjectionEpochs,
    previousRoot: baseline,
    target,
    timer: setTimeout(() => dispatchDeferredSettingWrite(target.ownerKey), delayMs),
  }
  pendingDeferredSettingWrites.set(target.ownerKey, pending)
  if (!netChanged) dispatchDeferredSettingWrite(target.ownerKey)
  return true
}

function deferredServerSettingDurableIntent(
  target: DeferredServerSettingTarget,
  desiredRoot: unknown,
): DurableMutationIntent {
  const group = settingsGroupForKey(target.rootKey)
  if (!group) throw new Error(`Deferred server setting has no command group: ${target.rootKey}`)
  return {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: `/settings/${group}`,
        body: { patch: { [target.rootKey]: cloneJsonValue(desiredRoot) } },
      },
    ],
  }
}

function applyDeferredSettingEdit(root: unknown, edit: DeferredSettingEdit): unknown {
  if (edit.path.length === 0) return cloneJsonValue(edit.value)

  const nextRoot = root && typeof root === 'object' ? cloneJsonValue(root) : {}
  let target = nextRoot as Record<string, unknown>
  for (const part of edit.path.slice(0, -1)) {
    const child = target[part]
    target[part] = child && typeof child === 'object' ? child : {}
    target = target[part] as Record<string, unknown>
  }
  target[edit.path[edit.path.length - 1]] = cloneJsonValue(edit.value)
  return nextRoot
}

function dispatchDeferredSettingWrite(ownerKey: string, options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  const pending = pendingDeferredSettingWrites.get(ownerKey)
  if (!pending || !isClientSessionGenerationCurrent(pending.sessionGeneration)) return
  clearTimeout(pending.timer)
  pendingDeferredSettingWrites.delete(ownerKey)
  const reportFailure = createSettingSaveFailureReporter()

  const attemptedRoot = cloneJsonValue(pending.desiredRoot)
  if (pending.target.kind === 'preset') {
    flushPendingSplitPresetPatch(pending.target.target.kind, pending.target.target.presetId, options)
    return
  }
  if (pending.target.kind === 'promptOverride') {
    flushPendingSplitPresetPatch('prompt', pending.target.target.presetId, options)
    return
  }
  const serverTarget = pending.target
  if (attemptedRoot === undefined) {
    if (pending.outbox) void acknowledgePendingMutation(pending.outbox)
    rollbackDeferredServerSetting(serverTarget, attemptedRoot, pending.previousRoot, pending.edits)
    reportFailure()
    return
  }

  if (!pending.intent || !pending.outbox) {
    rollbackDeferredServerSetting(serverTarget, attemptedRoot, pending.previousRoot, pending.edits)
    reportFailure()
    return
  }

  const attempt = registerDeferredServerSettingAttempt(
    serverTarget.ownerKey,
    serverTarget.rootKey,
    pending.previousRoot,
    attemptedRoot,
    pending.outbox,
    pending.sessionGeneration,
  )
  const rollbackAttempt = () => {
    if (canProjectPendingSettings(attempt.sessionGeneration)) {
      rollbackDeferredServerSetting(serverTarget, attemptedRoot, attempt.previousRoot, pending.edits)
      rebaseLaterDeferredServerSettingAttempt(attempt)
    }
    clearDeferredServerSettingAttempt(attempt)
    reportFailure()
  }
  attempt.settlementCleanup = registerDurableMutationSettlementListener(pending.outbox.mutationId, (settlement) => {
    if (!isDeferredServerSettingAttemptCurrent(attempt)) return
    if (settlement === 'accepted') {
      if (!canProjectPendingSettings(attempt.sessionGeneration)) {
        clearDeferredServerSettingAttempt(attempt)
        return
      }
      attempt.phase = 'accepted-replay'
      return
    }
    rollbackAttempt()
  })

  const dispatched = dispatchDurableMutation(pending.outbox, pending.intent, (transport) => {
    const result = patchServerBackedSettings({
      patch: { [serverTarget.rootKey]: attemptedRoot },
      acknowledgeOptimistic: true,
      optimisticProjectionEpochs: pending.optimisticProjectionEpochs,
      keepalive: options.keepalive,
      signal: options.signal,
      rollback: rollbackAttempt,
      ...transport,
    })
    void result.then(
      (settled) => {
        if (!isDeferredServerSettingAttemptCurrent(attempt)) return
        if (settled.status === 'ok') {
          clearDeferredServerSettingAttempt(attempt)
          return
        }
        if (transport.failureRollbackDisposition?.(settled) === 'retain') {
          attempt.phase = 'queued'
          return
        }
        clearDeferredServerSettingAttempt(attempt)
        reportFailure()
      },
      () => undefined,
    )
    return result
  })
  void dispatched.catch(async () => {
    if (!isDeferredServerSettingAttemptCurrent(attempt)) return
    const persistence = await pending.outbox!.ready
    if (!isDeferredServerSettingAttemptCurrent(attempt)) return
    if (persistence === 'persisted') {
      attempt.phase = 'queued'
      return
    }
    rollbackAttempt()
  })
}

function registerDeferredServerSettingAttempt(
  ownerKey: string,
  rootKey: string,
  previousRoot: unknown,
  attemptedRoot: unknown,
  outbox: PendingMutationHandle,
  sessionGeneration: number,
): PendingDeferredServerSettingAttempt {
  const attempt = {
    sessionGeneration,
    sequence: ++nextDeferredServerSettingAttemptSequence,
    ownerKey,
    rootKey,
    previousRoot: cloneJsonValue(previousRoot),
    attemptedRoot: cloneJsonValue(attemptedRoot),
    outbox,
    phase: 'dispatching' as const,
  }
  pendingDeferredServerSettingAttempts.push(attempt)
  return attempt
}

function isDeferredServerSettingAttemptCurrent(attempt: PendingDeferredServerSettingAttempt): boolean {
  return pendingDeferredServerSettingAttempts.some(
    (candidate) => candidate.sequence === attempt.sequence && candidate.outbox.mutationId === attempt.outbox.mutationId,
  )
}

function rebaseLaterDeferredServerSettingAttempt(failed: PendingDeferredServerSettingAttempt): void {
  for (const later of pendingDeferredServerSettingAttempts) {
    if (
      later.sequence <= failed.sequence ||
      later.ownerKey !== failed.ownerKey ||
      !canProjectPendingSettings(later.sessionGeneration)
    )
      continue
    if (snapshotJson(later.previousRoot) !== snapshotJson(failed.attemptedRoot)) continue
    later.previousRoot = cloneJsonValue(failed.previousRoot)
    return
  }

  const pending = pendingDeferredSettingWrites.get(failed.ownerKey)
  if (!pending || pending.target.kind !== 'server' || !canProjectPendingSettings(pending.sessionGeneration)) return
  if (snapshotJson(pending.previousRoot) !== snapshotJson(failed.attemptedRoot)) return
  pending.previousRoot = cloneJsonValue(failed.previousRoot)
}

function clearDeferredServerSettingAttempt(attempt: PendingDeferredServerSettingAttempt): void {
  attempt.settlementCleanup?.()
  attempt.settlementCleanup = undefined
  const index = pendingDeferredServerSettingAttempts.findIndex((candidate) => candidate.sequence === attempt.sequence)
  if (index !== -1) pendingDeferredServerSettingAttempts.splice(index, 1)
}

function rollbackDeferredServerSetting(
  target: DeferredServerSettingTarget,
  attemptedRoot: unknown,
  previousRoot: unknown,
  edits: Map<string, DeferredSettingEdit>,
): void {
  const settings = currentSettingsOwnerForRoot(target.rootKey)
  if (!settings) return
  const currentRoot = settings[target.rootKey]
  let restoredRoot = cloneJsonValue(currentRoot)
  const restoredRuntimeEffects: NonNullable<DeferredSettingEdit['runtimeEffect']>[] = []
  let changed = false

  for (const edit of edits.values()) {
    const currentValue = valueAtDeferredSettingPath(currentRoot, edit.path)
    const attemptedValue = valueAtDeferredSettingPath(attemptedRoot, edit.path)
    if (snapshotJson(currentValue) !== snapshotJson(attemptedValue)) continue
    const previousValue = valueAtDeferredSettingPath(previousRoot, edit.path)
    restoredRoot = applyDeferredSettingEdit(restoredRoot, { path: edit.path, value: previousValue })
    if (edit.runtimeEffect) restoredRuntimeEffects.push(edit.runtimeEffect)
    changed = true
  }

  if (!changed) return
  settings[target.rootKey] = restoredRoot
  for (const { ctx, item } of restoredRuntimeEffects) {
    item.onChange?.(getSettingValue(item, ctx), ctx)
  }
}

function valueAtDeferredSettingPath(root: unknown, path: string[]): unknown {
  let value = root
  for (const part of path) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

function settingRootKey(item: SettingItem): string | null {
  if (item.bindPath) return item.bindPath.split('.')[0] ?? null
  const key = item.bindKey ?? serverPatchKeyForItem(item)
  return key ? String(key) : null
}

function deferredSettingPath(item: SettingItem): string[] {
  return item.bindPath ? item.bindPath.split('.').slice(1) : []
}

function localSettingOwnerKey(item: SettingItem): string {
  return `local:${item.id}`
}

function mirrorSettingValueToSelectedPreset(item: SettingItem, newValue: unknown, ctx: SettingContext): boolean {
  const promptOverrideMirror = mirrorPromptPresetOverrideSettingValue(item, newValue, ctx)
  if (promptOverrideMirror !== null) return promptOverrideMirror

  if (item.bindPath) {
    const key = item.bindPath.split('.')[0]
    return mirrorTopLevelPresetField(key, cloneJsonValue(currentSettingsOwnerRoot(key)))
  }

  const key = item.bindKey ?? serverPatchKeyForItem(item)
  if (!key) return false
  return mirrorTopLevelPresetField(String(key), newValue)
}

function getPromptPresetOverrideSettingValue(
  item: SettingItem,
  ctx: SettingContext,
): { found: true; value: unknown } | { found: false } {
  if (ctx.presetMirrorTarget !== 'promptModelOverrides') return { found: false }

  if (item.bindPath) {
    const parts = item.bindPath.split('.')
    const rootKey = parts[0]
    if (!promptPresetModelOverrideFieldForDatabaseKey(rootKey)) return { found: false }
    let value: any = currentPromptPresetModelOverrideValue(rootKey, currentSettingsOwnerRoot(rootKey))
    for (const part of parts.slice(1)) {
      value = value?.[part]
    }
    return { found: true, value }
  }

  const key = item.bindKey ?? serverPatchKeyForItem(item)
  if (!key || !promptPresetModelOverrideFieldForDatabaseKey(String(key))) return { found: false }
  return {
    found: true,
    value: currentPromptPresetModelOverrideValue(String(key), currentSettingsOwnerRoot(String(key))),
  }
}

function mirrorPromptPresetOverrideSettingValue(
  item: SettingItem,
  newValue: unknown,
  ctx: SettingContext,
): boolean | null {
  if (ctx.presetMirrorTarget !== 'promptModelOverrides') return null
  if (!item.bindPath && !item.bindKey && !serverPatchKeyForItem(item)) return null

  if (item.bindPath) {
    const rootKey = item.bindPath.split('.')[0]
    if (!promptPresetModelOverrideFieldForDatabaseKey(rootKey)) return null
    return mirrorPromptPresetModelOverrideField(rootKey, cloneJsonValue(currentSettingsOwnerRoot(rootKey)))
  }

  const key = item.bindKey ?? serverPatchKeyForItem(item)
  if (!key || !promptPresetModelOverrideFieldForDatabaseKey(String(key))) return null
  return mirrorPromptPresetModelOverrideField(String(key), newValue)
}

function setLocalSettingValue(item: SettingItem, newValue: any, ctx: SettingContext): boolean {
  const settings = currentSettingsOwner(item)
  if (!settings) return false
  if (item.setValue) {
    item.setValue(settings, newValue, ctx)
  } else if (item.bindPath) {
    const parts = item.bindPath.split('.')
    let obj: any = settings
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] ??= {}
    }
    obj[parts[parts.length - 1]] = newValue
  } else if (item.bindKey) {
    ;(settings as unknown as Record<keyof Database, unknown>)[item.bindKey] = newValue
  }
  return true
}

function buildServerSettingsPatch(item: SettingItem): { key: string; valueFromDb: () => unknown } | null {
  if (!canUseServerCommands()) return null

  if (item.bindPath) {
    const rootKey = item.bindPath.split('.')[0]
    const group = settingsGroupForKey(rootKey)
    if (!group) return null
    return {
      key: rootKey,
      valueFromDb: () => cloneJsonValue(currentSettingsOwnerRoot(rootKey)),
    }
  }

  const key = item.bindKey ?? serverPatchKeyForItem(item)
  if (!key) return null
  const group = settingsGroupForKey(String(key))
  if (!group) return null

  return {
    key: String(key),
    valueFromDb: () => cloneJsonValue(currentSettingsOwnerRoot(String(key))),
  }
}

function currentSettingsOwner(item: SettingItem): Database | null {
  const rootKey = settingRootKey(item)
  const settings = currentSettingsOwnerForRoot(rootKey)
  return settings as unknown as Database | null
}

function currentSettingsOwnerForRoot(rootKey: string | null): Record<string, unknown> | null {
  if (settingsResourceState.status === 'error') return null
  if (rootKey) {
    const group = settingsGroupForKey(rootKey)
    if (group && settingsResourceState.groupStatuses[group] !== 'ready') return null
  }
  if (!rootKey && settingsResourceState.status !== 'ready') return null
  return settingsResourceState.value as Record<string, unknown>
}

function currentSettingsOwnerRoot(rootKey: string): unknown {
  return currentSettingsOwnerForRoot(rootKey)?.[rootKey]
}

function rollbackLocalSetting(
  item: SettingItem,
  attemptedValue: unknown,
  previousValue: unknown,
  ctx: SettingContext,
): void {
  if (getSettingValue(item, ctx) !== attemptedValue) return
  writeLocalSettingValue(item, previousValue, ctx)
}

function serverPatchKeyForItem(item: SettingItem): string | null {
  if (item.id.startsWith('display.customQuotes')) return 'customQuotesData'
  return null
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

/**
 * Check if item should be visible based on condition
 */
export function checkCondition(item: SettingItem, ctx: SettingContext): boolean {
  if (!item.condition) return true
  return item.condition(ctx)
}

export function getFullSettingsData(searchTerm = '') {
  const full = accessibilitySettingsItems.concat(
    interactionSettingsItems,
    advancedSettingsItems,
    basicParameterItems,
    languageSupplementalSettingsItems,
    memorySettingsItems,
    modelSupplementalSettingsItems,
    pluginSupplementalSettingsItems,
    promptSupplementalSettingsItems,
    seedSetting,
    samplingParameterItems,
    penaltyParameterItems,
    modelSpecificParameterItems,
    chatFormatSettingsItems,
    displaySettingsItems,
  )

  if (!searchTerm) return full

  const lowerSearch = searchTerm.toLowerCase()
  return full.filter((item) => {
    const label = getLabel(item).toLowerCase()
    const keywords = item.keywords?.map((k) => k.toLowerCase()) || []
    return label.includes(lowerSearch) || keywords.some((k) => k.includes(lowerSearch))
  })
}
