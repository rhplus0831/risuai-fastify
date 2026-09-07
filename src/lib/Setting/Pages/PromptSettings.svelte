<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import 'src/ts/stores.svelte'
  import { ArrowLeft, PlusIcon, RefreshCcwIcon, TrashIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import { confirmSettingsItemRemoval } from 'src/ts/setting/confirmSettingsItemRemoval'
  import PromptDataItem from 'src/lib/UI/PromptDataItem.svelte'
  import {
    createPromptTokenizeDebouncer,
    promptTemplateTokenizeSignature,
    type PromptItem,
  } from 'src/ts/process/prompt'
  import { templateCheck } from 'src/ts/process/templates/templateCheck'
  import { createNonSecurityUuid } from 'src/ts/nonSecurityUuid'

  import { collectionsResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import Check from 'src/lib/UI/GUI/CheckInput.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
  import Help from 'src/lib/Others/Help.svelte'
  import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import ModelList from 'src/lib/UI/ModelList.svelte'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { defaultAutoSuggestPrompt } from '../../../ts/storage/defaultPrompts'
  import type { Database } from 'src/ts/storage/database.svelte'
  import { resolveUniquePromptPreset } from '@risuai/shared-core/effective-prompt-template'
  import {
    createServerBackedSettingDraft,
    flushPendingSettingsOwnerMutations,
  } from 'src/ts/server/settingsOwner.svelte'
  import {
    applyPromptItemProjectionWrite,
    armPendingPromptItemProjectionUpdate,
    capturePromptItemOptimisticAcknowledgement,
    capturePromptTemplateOwnerMutationFence,
    dispatchPromptTemplateStructuralMutation,
    commitPendingPromptTemplateMutations,
    queuePromptItemProjectionUpdate,
    reconcilePromptTemplateDraft,
    reapplyPendingPromptTemplateStructuralProjections,
    resetPromptTemplateSelectionDirtyState,
    promptTemplateOwnerCommandId,
    promptTemplateOwnerMutationKey,
    rollbackFailedPromptTemplateItemCreate,
    rollbackFailedPromptTemplateItemDelete,
    rollbackFailedPromptTemplateItemReorder,
    runPromptTemplateOwnerCommand,
    stagePromptItemDeleteMutation,
    type PromptTemplateDraftBinding,
    type PromptTemplateOwnerMutationFence,
    type PromptTemplateStructuralFinalSettlement,
    type PromptTemplateStructuralMutationOutcome,
    type PromptTemplateStructuralOwnerState,
  } from 'src/ts/server/promptTemplateMutations.svelte'
  import {
    clonePromptTemplateSelectedFallback,
    currentPromptTemplateOwnerId,
    ensurePromptTemplateHydrated,
    isPromptTemplateHydrated,
    isPromptTemplateHydratedInState,
    markPromptTemplateOwnerAcknowledgementTainted,
    promptTemplateOwnerUsesSelectedFallback,
    promptTemplateHydrationStateStore,
  } from 'src/ts/server/promptTemplateHydration'
  import {
    canUseServerCommands,
    createPromptItemCommand,
    deletePromptItemCommand,
    peekCachedServerCommandRevision,
    reorderPromptItemsCommand,
    runServerCommand,
    updatePromptPresetCommand,
    type PromptItemSnapshot,
    type PromptPresetSnapshot,
    type ServerCommandResult,
  } from 'src/ts/server/commands'
  import { dispatchDurableMutation } from 'src/ts/server/durableMutationDispatch'
  import { stagePendingMutation, type DurableMutationIntent } from 'src/ts/server/pendingMutationOutbox'
  import {
    createPromptPresetModelOverrideDraft,
    currentPromptPresetModelOverrideValue,
  } from 'src/ts/promptPresetModelOverrides.svelte'
  import { promptPresetModelOverrideFieldForDatabaseKey } from 'src/ts/presetSplit'

  let sorted = 0
  let warns: string[] = $state([])
  let tokens = $state(0)
  let extokens = $state(0)
  type PromptDropPlacement = 'before' | 'after'
  interface PromptItemDragState {
    ownerId: string | null
    itemId: string
  }
  interface PromptItemDropBoundary {
    ownerId: string | null
    targetItemId: string
    placement: PromptDropPlacement
  }
  let promptItemDrag = $state<PromptItemDragState | null>(null)
  let promptItemDropBoundary = $state<PromptItemDropBoundary | null>(null)
  let openedItemIndices = $state(new Set<number>())
  type FallbackModelKey = 'model' | 'memory' | 'translate' | 'emotion' | 'otherAx' | 'scriptMain' | 'scriptAux'
  type FallbackModelsDraft = Record<FallbackModelKey, string[]>
  interface Props {
    onGoBack?: () => void
    mode?: 'independent' | 'inline'
    subMenu?: number
    promptPresetModelOverrideMode?: boolean
    showPromptModelOverrideFields?: boolean
  }

  const promptPresetTemplateIdsPendingServerSync = new Set<string>()
  interface PromptPresetTemplateIdServerSync {
    completion: Promise<boolean>
    itemSnapshots: ReadonlyMap<string, string>
  }
  const promptPresetTemplateIdSyncInFlight = new Map<string, PromptPresetTemplateIdServerSync>()

  let {
    onGoBack = () => {},
    mode = 'independent',
    subMenu = $bindable(0),
    promptPresetModelOverrideMode = false,
    showPromptModelOverrideFields = true,
  }: Props = $props()

  const promptTokenizeDebouncer = createPromptTokenizeDebouncer({
    debounceMs: 300,
    onResult: (totals) => {
      tokens = totals.tokens
      extokens = totals.extokens
    },
  })

  function fallbackModelLabel(key: FallbackModelKey): string {
    switch (key) {
      case 'model':
        return language.model
      case 'memory':
        return language.modelRoles.roles.memory
      case 'translate':
        return language.modelRoles.roles.translate
      case 'emotion':
        return language.modelRoles.roles.emotion
      case 'otherAx':
        return language.modelRoles.roles.otherAx
      case 'scriptMain':
        return language.modelRoles.roles.scriptMain
      case 'scriptAux':
        return language.modelRoles.roles.scriptAux
    }
  }
  const promptTemplateDraft = $state<{ value: PromptItem[] }>({
    value: isPromptTemplateHydrated() ? cloneSelectedPromptPresetTemplate() : [],
  })
  let promptTemplateDraftRenderEpoch = $state(0)
  let suppressPromptTemplateDraftDispatch = false
  const promptTemplateDraftBinding: PromptTemplateDraftBinding = {
    getItems: () => promptTemplateDraft.value,
    setItems: (items) => {
      promptTemplateDraft.value = items
    },
  }
  let previousPromptTemplateRevision = peekCachedServerCommandRevision()
  let previousPromptTemplatePresetSelection = promptTemplatePresetSelectionSignature()
  let promptTemplateHydrated = $derived(isPromptTemplateHydratedInState($promptTemplateHydrationStateStore))
  let promptTemplateUsesSelectedFallback = $derived(promptTemplateOwnerUsesSelectedFallback(selectedPromptPresetId()))
  let promptTemplateHydrationPending = $state(!isPromptTemplateHydrated())
  let promptTemplateHydrationFailed = $state(false)
  let promptTemplateHydrationRequestId = 0
  let promptTemplateStructuralMutationState = $state<'idle' | 'saving' | 'queued' | 'failed'>('idle')
  let promptTemplateStructuralMutationError = $state('')
  let promptTemplateStructuralMutationSequence = 0
  let promptTemplateStructuralMutationPending = $derived(promptTemplateStructuralMutationState === 'saving')
  const promptSettingsDraft = createPromptSettingsDraft<Record<string, any>>('promptSettings', {})
  const jsonSchemaEnabledDraft = createPromptSettingsDraft<boolean>('jsonSchemaEnabled', false)
  const outputImageModalDraft = createPromptSettingsDraft<boolean>('outputImageModal', false)
  const strictJsonSchemaDraft = createPromptSettingsDraft<boolean>('strictJsonSchema', false)
  const customPromptTemplateToggleDraft = createPromptSettingsDraft<string>('customPromptTemplateToggle', '')
  const templateDefaultVariablesDraft = createPromptSettingsDraft<string>('templateDefaultVariables', '')
  const OAIPredictionDraft = createPromptSettingsDraft<string>('OAIPrediction', '')
  const autoSuggestPromptDraft = createPromptSettingsDraft<string>('autoSuggestPrompt', '')
  const systemContentReplacementDraft = createPromptSettingsDraft<string>('systemContentReplacement', '')
  const systemRoleReplacementDraft = createPromptSettingsDraft<string>('systemRoleReplacement', 'user')
  const jsonSchemaDraft = createPromptSettingsDraft<string>('jsonSchema', '')
  const extractJsonDraft = createPromptSettingsDraft<string>('extractJson', '')
  const fallbackModelsDraft = createPromptSettingsDraft<FallbackModelsDraft>('fallbackModels', {
    model: [],
    memory: [],
    translate: [],
    emotion: [],
    otherAx: [],
    scriptMain: [],
    scriptAux: [],
  })
  const fallbackWhenBlankResponseDraft = createPromptSettingsDraft<boolean>('fallbackWhenBlankResponse', false)
  const doNotChangeFallbackModelsDraft = createPromptSettingsDraft<boolean>('doNotChangeFallbackModels', false)

  function promptItemId(item: PromptItem, ownerId: string | null = currentPromptTemplateOwnerId()): string {
    if (typeof item.id !== 'string' || item.id.length === 0) {
      item.id = createNonSecurityUuid()
      markPromptPresetTemplateIdsPendingServerSync(ownerId)
    }
    return item.id
  }

  function cloneJsonValue<T>(value: T): T {
    if (value === undefined) return value
    return JSON.parse(JSON.stringify(value)) as T
  }

  function snapshotJson(value: unknown): string {
    const snapshot = JSON.stringify(value)
    return snapshot === undefined ? '__undefined__' : snapshot
  }

  function selectedPromptPresetIndex(): number {
    const selectedIndex = settingsResourceState.value.promptPresetsId
    return Number.isInteger(selectedIndex) && selectedIndex >= 0 ? selectedIndex : -1
  }

  function promptPresetOwners(): Database['promptPresets'] {
    const owners = collectionsResourceState.values.promptPresets
    return Array.isArray(owners) ? owners : []
  }

  function selectedPromptPresetId(): string | null {
    const selectedIndex = selectedPromptPresetIndex()
    const selectedId = selectedIndex >= 0 ? (promptPresetOwners()[selectedIndex]?.id as unknown) : undefined
    return typeof selectedId === 'string' && selectedId.length > 0 ? selectedId : null
  }

  function selectedPromptPresetCandidate(): Record<string, unknown> | undefined {
    const selectedIndex = selectedPromptPresetIndex()
    return selectedIndex >= 0 ? (promptPresetOwners()[selectedIndex] as Record<string, unknown> | undefined) : undefined
  }

  function selectedPromptPreset(): Record<string, unknown> | undefined {
    const candidate = selectedPromptPresetCandidate()
    if (!candidate) return undefined
    return resolveUniquePromptPreset(promptPresetOwners(), candidate.id) as Record<string, unknown> | undefined
  }

  function cloneSelectedPromptPresetTemplate(): PromptItem[] {
    if (selectedPromptPresetCandidate() && !selectedPromptPreset()) return []
    const preset = selectedPromptPreset()
    if (preset) {
      if (Array.isArray(preset.promptTemplate)) return cloneJsonValue(preset.promptTemplate as PromptItem[])
      if (promptTemplateOwnerUsesSelectedFallback(selectedPromptPresetId())) {
        return cloneJsonValue(clonePromptTemplateSelectedFallback(selectedPromptPresetId()) ?? [])
      }
      return []
    }
    const legacyOwner = collectionsResourceState.values.promptTemplate
    return cloneJsonValue(Array.isArray(legacyOwner) ? legacyOwner : [])
  }

  function writePromptTemplateOwnerDraft(
    templates: PromptItem[],
    ownerId: string | null = currentPromptTemplateOwnerId(),
  ): boolean {
    const nextTemplate = cloneJsonValue(templates)
    if (ownerId === null) {
      collectionsResourceState.values.promptTemplate = nextTemplate
      return true
    }
    const preset = resolveUniquePromptPreset(promptPresetOwners(), ownerId) as Record<string, unknown> | undefined
    if (!preset || currentPromptTemplateOwnerId() !== ownerId) return false
    preset.promptTemplate = nextTemplate
    return true
  }

  function currentPromptTemplateSnapshot(): PromptItem[] {
    ensurePromptTemplateDraftIds(currentPromptTemplateOwnerId())
    return cloneJsonValue(promptTemplateDraft.value ?? [])
  }

  function promptTemplatePresetSelectionSignature(): string {
    const selectedId = selectedPromptPresetId()
    return selectedId ? `preset:${selectedId}` : 'legacy'
  }

  function resetPromptTemplateUiState(): void {
    openedItemIndices = new Set<number>()
    resetPromptItemDragState()
  }

  function resetPromptItemDragState(): void {
    promptItemDrag = null
    promptItemDropBoundary = null
  }

  function promptTemplateStructureSignature(items: PromptItem[]): string {
    return items.map((item, index) => item.id?.trim() || `index:${index}`).join('\u0000')
  }

  function resetPromptTemplateDraftFromProjection(): void {
    resetPromptTemplateSelectionDirtyState()
    adoptPromptTemplateDraftFromProjection()
  }

  function adoptPromptTemplateDraftFromProjection(): void {
    promptTemplateDraft.value = cloneSelectedPromptPresetTemplate()
    promptTemplateDraftRenderEpoch += 1
    previousPromptTemplateRevision = peekCachedServerCommandRevision()
  }

  function uniquePromptItemIndex(items: PromptItem[], itemId: string): number | null {
    let foundIndex = -1
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]?.id !== itemId) continue
      if (foundIndex !== -1) return null
      foundIndex = index
    }
    return foundIndex === -1 ? null : foundIndex
  }

  function remapOpenedPromptItemIndices(previous: PromptItem[], next: PromptItem[]): Set<number> {
    const nextOpenedIndices = new Set<number>()
    for (const previousIndex of openedItemIndices) {
      const itemId = previous[previousIndex]?.id
      if (typeof itemId !== 'string' || itemId.length === 0) continue
      const nextIndex = uniquePromptItemIndex(next, itemId)
      if (nextIndex !== null) nextOpenedIndices.add(nextIndex)
    }
    return nextOpenedIndices
  }

  async function hydrateCurrentPromptTemplateOwner(
    options: {
      force?: boolean
      resetSelectionDirtyState?: boolean
    } = {},
  ): Promise<void> {
    const ownerId = currentPromptTemplateOwnerId()
    const requestId = ++promptTemplateHydrationRequestId
    promptTemplateHydrationPending = !isPromptTemplateHydrated(ownerId) || options.force === true
    promptTemplateHydrationFailed = false

    let hydrated = false
    try {
      hydrated = await ensurePromptTemplateHydrated({
        promptPresetId: ownerId,
        ...(options.force ? { force: true } : {}),
      })
    } catch {
      hydrated = false
    }

    if (requestId !== promptTemplateHydrationRequestId || ownerId !== currentPromptTemplateOwnerId()) return
    promptTemplateHydrationPending = false
    promptTemplateHydrationFailed = !hydrated
    if (!hydrated) return
    reapplyPendingPromptTemplateStructuralProjections(ownerId)

    if (options.resetSelectionDirtyState) {
      resetPromptTemplateDraftFromProjection()
    } else {
      adoptPromptTemplateDraftFromProjection()
    }
  }

  function createPromptItem(): PromptItem {
    return {
      id: createNonSecurityUuid(),
      type: 'plain',
      text: '',
      role: 'system',
      type2: 'normal',
    }
  }

  function promptTemplateItemIds(items: PromptItem[]): string[] | null {
    const itemIds: string[] = []
    const seen = new Set<string>()

    for (const item of items) {
      const itemId = item.id
      if (typeof itemId !== 'string' || itemId.length === 0 || seen.has(itemId)) return null
      seen.add(itemId)
      itemIds.push(itemId)
    }

    return itemIds
  }

  function promptTemplateStructuralOwnerState(items: PromptItem[]): PromptTemplateStructuralOwnerState {
    return { enabled: true, items: cloneJsonValue(items) }
  }

  function promptTemplateStructuralMutationMessage(result: ServerCommandResult): string {
    if (result.status === 'conflict') return language.promptTemplateMutation.commandConflict
    if (result.status === 'unavailable') return language.promptTemplateMutation.commandUnavailable
    if (result.status === 'error') return language.promptTemplateMutation.commandError(result.error)
    return language.promptTemplateMutation.commandUnavailable
  }

  function beginPromptTemplateStructuralMutation(): number | null {
    if (promptTemplateStructuralMutationPending) return null
    promptTemplateStructuralMutationState = 'saving'
    promptTemplateStructuralMutationError = ''
    return ++promptTemplateStructuralMutationSequence
  }

  function trackPromptTemplateStructuralMutation(
    sequence: number,
    pending: Promise<PromptTemplateStructuralMutationOutcome>,
  ): void {
    void pending.then(
      (outcome) => {
        if (sequence !== promptTemplateStructuralMutationSequence) return
        if (outcome.status === 'accepted') {
          promptTemplateStructuralMutationState = 'idle'
          return
        }
        if (outcome.status === 'queued') {
          promptTemplateStructuralMutationState = 'queued'
          return
        }
        promptTemplateStructuralMutationState = 'failed'
        promptTemplateStructuralMutationError = promptTemplateStructuralMutationMessage(outcome.result)
      },
      (error) => {
        if (sequence !== promptTemplateStructuralMutationSequence) return
        promptTemplateStructuralMutationState = 'failed'
        promptTemplateStructuralMutationError = language.promptTemplateMutation.commandError(
          error instanceof Error ? error.message : String(error),
        )
      },
    )
  }

  function handlePromptTemplateStructuralFinalSettlement(
    sequence: number,
    ownerId: string | null,
    settlement: PromptTemplateStructuralFinalSettlement,
  ): void {
    if (sequence !== promptTemplateStructuralMutationSequence || ownerId !== currentPromptTemplateOwnerId()) return
    if (settlement === 'accepted') {
      promptTemplateStructuralMutationState = 'idle'
      promptTemplateStructuralMutationError = ''
      return
    }
    adoptPromptTemplateDraftFromProjection()
    promptTemplateStructuralMutationState = 'failed'
    promptTemplateStructuralMutationError = language.promptTemplateMutation.replayDiscarded
  }

  function dispatchCreatePromptItem(
    ownerId: string | null,
    promptItem: PromptItem,
    previous: PromptItem[],
    projectionFence: PromptTemplateOwnerMutationFence,
    sequence: number,
  ): Promise<PromptTemplateStructuralMutationOutcome> {
    if (!promptTemplateHydrated || !canUseServerCommands() || projectionFence.ownerId !== ownerId) {
      return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
    }
    const itemId = promptItemId(promptItem)
    const attemptedItem = cloneJsonValue(promptItem)
    const attemptedItems = cloneJsonValue(promptTemplateDraft.value)
    const optimisticAcknowledgement = capturePromptItemOptimisticAcknowledgement(projectionFence)
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/prompt-items',
          body: {
            ...(ownerId ? { promptPresetId: ownerId } : {}),
            promptItem: cloneJsonValue(attemptedItem),
          },
        },
      ],
    }
    const outbox = stagePendingMutation(promptTemplateOwnerMutationKey(ownerId), intent)
    return dispatchPromptTemplateStructuralMutation({
      ownerId,
      operation: {
        kind: 'create',
        itemId,
        previous: promptTemplateStructuralOwnerState(previous),
        attempted: promptTemplateStructuralOwnerState(attemptedItems),
      },
      outbox,
      intent,
      dispatch: (transport, rollback) =>
        runServerCommand({
          command: (baseRevision) =>
            runPromptTemplateOwnerCommand(ownerId, () =>
              createPromptItemCommand({
                baseRevision,
                promptPresetId: promptTemplateOwnerCommandId(ownerId),
                promptItem: cloneJsonValue(attemptedItem) as PromptItemSnapshot,
                optimisticAcknowledgement,
              }),
            ),
          rollback,
          ...transport,
        }),
      rollback: () =>
        rollbackFailedPromptTemplateItemCreate({
          ownerId,
          binding: promptTemplateDraftBinding,
          itemId,
          attemptedItem,
          projectionFence,
        }),
      onFinalSettlement: (settlement) => handlePromptTemplateStructuralFinalSettlement(sequence, ownerId, settlement),
    })
  }

  function dispatchDeletePromptItem(
    ownerId: string | null,
    promptItem: PromptItem,
    previous: PromptItem[],
    projectionFence: PromptTemplateOwnerMutationFence,
    sequence: number,
  ): Promise<PromptTemplateStructuralMutationOutcome> {
    if (!promptTemplateHydrated || !canUseServerCommands() || projectionFence.ownerId !== ownerId) {
      return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
    }
    const itemId = promptItemId(promptItem)
    const previousIndex = previous.findIndex((item) => item.id === itemId)
    const previousItem = previousIndex === -1 ? cloneJsonValue(promptItem) : previous[previousIndex]
    const attemptedItems = cloneJsonValue(promptTemplateDraft.value)
    const optimisticAcknowledgement = capturePromptItemOptimisticAcknowledgement(projectionFence)
    const stagedDelete = stagePromptItemDeleteMutation(ownerId, itemId)
    return dispatchPromptTemplateStructuralMutation({
      ownerId,
      operation: {
        kind: 'delete',
        itemId,
        previous: promptTemplateStructuralOwnerState(previous),
        attempted: promptTemplateStructuralOwnerState(attemptedItems),
      },
      outbox: stagedDelete.outbox,
      intent: stagedDelete.intent,
      dispatch: (transport, rollback) =>
        runServerCommand({
          command: (baseRevision) =>
            runPromptTemplateOwnerCommand(ownerId, () =>
              deletePromptItemCommand({
                baseRevision,
                promptPresetId: promptTemplateOwnerCommandId(ownerId),
                itemId,
                optimisticAcknowledgement,
              }),
            ),
          rollback,
          ...transport,
        }),
      rollback: () =>
        rollbackFailedPromptTemplateItemDelete({
          ownerId,
          binding: promptTemplateDraftBinding,
          itemId,
          previousIndex,
          previousItem,
          projectionFence,
        }),
      onFinalSettlement: (settlement) => handlePromptTemplateStructuralFinalSettlement(sequence, ownerId, settlement),
    })
  }

  function dispatchReorderPromptItems(
    ownerId: string | null,
    previous: PromptItem[],
    projectionFence: PromptTemplateOwnerMutationFence,
    sequence: number,
  ): Promise<PromptTemplateStructuralMutationOutcome> {
    if (!promptTemplateHydrated || !canUseServerCommands() || projectionFence.ownerId !== ownerId) {
      return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
    }
    ensurePromptTemplateDraftIds(ownerId)
    const itemIds = promptTemplateItemIds(promptTemplateDraft.value)
    const previousItemIds = promptTemplateItemIds(previous)
    if (!itemIds || !previousItemIds) {
      return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
    }
    const attemptedItemIds = [...itemIds]
    const optimisticAcknowledgement = capturePromptItemOptimisticAcknowledgement(projectionFence)
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/prompt-items/reorder',
          body: {
            ...(ownerId ? { promptPresetId: ownerId } : {}),
            itemIds: [...itemIds],
          },
        },
      ],
    }
    const outbox = stagePendingMutation(promptTemplateOwnerMutationKey(ownerId), intent)
    return dispatchPromptTemplateStructuralMutation({
      ownerId,
      operation: {
        kind: 'reorder',
        previousItemIds,
        attemptedItemIds,
        previous: promptTemplateStructuralOwnerState(previous),
        attempted: promptTemplateStructuralOwnerState(promptTemplateDraft.value),
      },
      outbox,
      intent,
      dispatch: (transport, rollback) =>
        runServerCommand({
          command: (baseRevision) =>
            runPromptTemplateOwnerCommand(ownerId, () =>
              reorderPromptItemsCommand({
                baseRevision,
                promptPresetId: promptTemplateOwnerCommandId(ownerId),
                itemIds,
                optimisticAcknowledgement,
              }),
            ),
          rollback,
          ...transport,
        }),
      rollback: () =>
        rollbackFailedPromptTemplateItemReorder({
          ownerId,
          binding: promptTemplateDraftBinding,
          previousItemIds,
          attemptedItemIds,
          projectionFence,
        }),
      onFinalSettlement: (settlement) => handlePromptTemplateStructuralFinalSettlement(sequence, ownerId, settlement),
    })
  }

  function queuePromptItemUpdate(promptItem: PromptItem, previousItem: PromptItem, originalIndex: number): void {
    if (!promptTemplateHydrated || suppressPromptTemplateDraftDispatch) return
    const ownerId = currentPromptTemplateOwnerId()
    const projectionFence = capturePromptTemplateOwnerMutationFence(ownerId)
    const itemId = ensurePromptItemDraftId(promptItem, previousItem, originalIndex, ownerId)
    const queueRowPatch = (writeFence = projectionFence, delayMs: number | null = 250) =>
      queuePromptItemProjectionUpdate(promptTemplateDraftBinding, itemId, previousItem, delayMs, ownerId, writeFence)
    const attemptedItemSnapshot = snapshotJson(promptItem)
    const templateIdSync = queuePromptPresetTemplateIdServerSync(ownerId)
    if (!templateIdSync) {
      queueRowPatch()
      return
    }
    const changedAfterIdSync = templateIdSync.itemSnapshots.get(itemId) !== attemptedItemSnapshot
    if (changedAfterIdSync) {
      // Persist the successor before the prerequisite whole-preset repair
      // settles. Its network timer is armed only after that repair succeeds;
      // lifecycle flushes may safely enqueue it behind the already-queued repair.
      queueRowPatch(projectionFence, null)
    }
    void templateIdSync.completion.then((synced) => {
      if (!synced || !changedAfterIdSync) return
      const currentItem = promptTemplateDraft.value.find((item) => item.id === itemId)
      if (currentItem) applyPromptItemProjectionWrite(promptTemplateDraft.value, itemId, ownerId)
      armPendingPromptItemProjectionUpdate(itemId, 250, ownerId, capturePromptTemplateOwnerMutationFence(ownerId))
    })
  }

  function ensurePromptItemDraftId(
    promptItem: PromptItem,
    previousItem: PromptItem,
    originalIndex: number,
    ownerId: string | null,
  ): string {
    ensurePromptTemplateDraftIds(ownerId)
    const draftItem = promptTemplateDraft.value[originalIndex]
    if (draftItem && (typeof draftItem.id !== 'string' || draftItem.id.length === 0)) {
      draftItem.id = createNonSecurityUuid()
      markPromptPresetTemplateIdsPendingServerSync(ownerId)
    }
    const itemId = draftItem?.id ?? promptItemId(promptItem, ownerId)
    promptItem.id = itemId
    previousItem.id ??= itemId
    if (draftItem && draftItem.id !== itemId) {
      draftItem.id = itemId
      markPromptPresetTemplateIdsPendingServerSync(ownerId)
    }
    writePromptTemplateOwnerDraft(promptTemplateDraft.value, ownerId)
    return itemId
  }

  function ensurePromptTemplateDraftIds(ownerId: string | null): void {
    const seen = new Set<string>()
    let changed = false

    for (const item of promptTemplateDraft.value ?? []) {
      const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : ''
      if (!id || seen.has(id)) {
        item.id = createNonSecurityUuid()
        changed = true
      }
      seen.add(item.id)
    }

    if (!changed) return
    markPromptPresetTemplateIdsPendingServerSync(ownerId)
    writePromptTemplateOwnerDraft(promptTemplateDraft.value, ownerId)
  }

  function promptTemplateDraftIdsNeedNormalization(items: PromptItem[]): boolean {
    const seen = new Set<string>()
    for (const item of items) {
      const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : null
      if (!id || seen.has(id)) return true
      seen.add(id)
    }
    return false
  }

  function markPromptPresetTemplateIdsPendingServerSync(ownerId: string | null): void {
    markPromptTemplateOwnerAcknowledgementTainted(ownerId)
    if (ownerId) promptPresetTemplateIdsPendingServerSync.add(ownerId)
  }

  function queuePromptPresetTemplateIdServerSync(ownerId: string | null): PromptPresetTemplateIdServerSync | null {
    if (!ownerId || !promptPresetTemplateIdsPendingServerSync.has(ownerId) || !canUseServerCommands()) return null
    const existing = promptPresetTemplateIdSyncInFlight.get(ownerId)
    if (existing) return existing

    const promptPresetId = ownerId
    const promptTemplate = cloneJsonValue(promptTemplateDraft.value ?? [])
    const itemSnapshots = new Map(
      promptTemplate
        .filter((item): item is PromptItem & { id: string } => typeof item.id === 'string' && item.id.length > 0)
        .map((item) => [item.id, snapshotJson(item)]),
    )
    const patch = { promptTemplate }
    const commandPatch = cloneJsonValue({ ...patch, id: promptPresetId }) as PromptPresetSnapshot
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: `/prompt-presets/${encodeURIComponent(promptPresetId)}`,
          body: { patch: cloneJsonValue(commandPatch) },
        },
      ],
    }
    const outbox = stagePendingMutation(promptTemplateOwnerMutationKey(promptPresetId), intent)
    const completion = dispatchDurableMutation(outbox, intent, (transport) =>
      runServerCommand({
        command: (baseRevision) =>
          runPromptTemplateOwnerCommand(ownerId, () =>
            updatePromptPresetCommand({
              baseRevision,
              promptPresetId,
              patch: commandPatch,
            }),
          ),
        ...transport,
      }),
    )
      .then((result) => {
        if (result.status === 'ok') {
          promptPresetTemplateIdsPendingServerSync.delete(ownerId)
          return true
        }
        markPromptTemplateOwnerAcknowledgementTainted(ownerId)
        return false
      })
      .finally(() => {
        promptPresetTemplateIdSyncInFlight.delete(ownerId)
      })

    const sync = { completion, itemSnapshots }
    promptPresetTemplateIdSyncInFlight.set(ownerId, sync)
    return sync
  }

  function movePromptItem(originalIndex: number, nextIndex: number): void {
    if (!promptTemplateHydrated || promptTemplateStructuralMutationPending) return
    if (nextIndex < 0 || nextIndex >= promptTemplateDraft.value.length) return
    const sequence = beginPromptTemplateStructuralMutation()
    if (sequence === null) return
    if (canUseServerCommands()) commitPendingPromptTemplateMutations()
    const previous = currentPromptTemplateSnapshot()
    const templates = [...promptTemplateDraft.value]
    const temp = templates[originalIndex]
    templates[originalIndex] = templates[nextIndex]
    templates[nextIndex] = temp
    const ownerId = currentPromptTemplateOwnerId()
    const projectionFence = capturePromptTemplateOwnerMutationFence(ownerId)
    promptTemplateDraft.value = templates
    writePromptTemplateOwnerDraft(templates, ownerId)
    trackPromptTemplateStructuralMutation(
      sequence,
      dispatchReorderPromptItems(ownerId, previous, projectionFence, sequence),
    )
  }

  function applyPromptTemplateDraft(templates: PromptItem[]): string | null {
    if (!promptTemplateHydrated) return null
    const ownerId = currentPromptTemplateOwnerId()
    promptTemplateDraft.value = cloneJsonValue(templates)
    writePromptTemplateOwnerDraft(templates, ownerId)
    return ownerId
  }

  function createPromptSettingsDraft<T>(
    key: string,
    fallback: T,
  ): { value: T; captureRecoveryDraft(): { value: T; baseline: T } | null } {
    const settingsDraft = createServerBackedSettingDraft(key, fallback)
    if (!promptPresetModelOverrideFieldForDatabaseKey(key)) return settingsDraft

    const promptOverrideDraft = createPromptPresetModelOverrideDraft(key, fallback)
    return {
      captureRecoveryDraft() {
        if (!promptPresetModelOverrideMode) return settingsDraft.captureRecoveryDraft()
        const baseline = currentPromptPresetModelOverrideValue(key, fallback)
        return snapshotJson(promptOverrideDraft.value) === snapshotJson(baseline)
          ? null
          : {
              value: cloneJsonValue(promptOverrideDraft.value),
              baseline: cloneJsonValue(baseline),
            }
      },
      get value() {
        return promptPresetModelOverrideMode ? promptOverrideDraft.value : settingsDraft.value
      },
      set value(value: T) {
        if (promptPresetModelOverrideMode) promptOverrideDraft.value = value
        else settingsDraft.value = value
      },
    }
  }

  $effect.pre(() => {
    if (!promptTemplateHydrated) return
    warns = templateCheck({ promptTemplate: promptTemplateDraft.value } as Database)
  })
  $effect.pre(() => {
    if (!promptTemplateHydrated) return
    promptTemplateTokenizeSignature(promptTemplateDraft.value)
    untrack(() => {
      promptTokenizeDebouncer.schedule(promptTemplateDraft.value)
    })
  })
  $effect(() => {
    const selection = promptTemplatePresetSelectionSignature()
    if (selection === previousPromptTemplatePresetSelection) return
    previousPromptTemplatePresetSelection = selection
    untrack(() => {
      promptTemplateStructuralMutationSequence += 1
      promptTemplateStructuralMutationState = 'idle'
      promptTemplateStructuralMutationError = ''
      resetPromptTemplateUiState()
      void hydrateCurrentPromptTemplateOwner({ resetSelectionDirtyState: true })
    })
  })
  $effect(() => {
    if (!promptTemplateHydrated) return
    // Reconcile the draft from the projection only when the cached server command
    // revision advances (a real server push / command response), not on every
    // keystroke. The reconcile call below reads the selected owner projection
    // so this effect still re-runs on a projection change; the whole-template
    // stringify now happens only on a revision advance, never per keystroke.
    const { revision, nextDraft, structuralAdoption } = reconcilePromptTemplateDraft(
      promptTemplateDraft.value,
      previousPromptTemplateRevision,
      cloneSelectedPromptPresetTemplate(),
    )
    previousPromptTemplateRevision = revision
    if (nextDraft) {
      if (promptTemplateStructureSignature(nextDraft) !== promptTemplateStructureSignature(promptTemplateDraft.value)) {
        openedItemIndices = remapOpenedPromptItemIndices(promptTemplateDraft.value, nextDraft)
      }
      if (!structuralAdoption) suppressPromptTemplateDraftDispatch = true
      promptTemplateDraft.value = nextDraft
      writePromptTemplateOwnerDraft(nextDraft)
      if (structuralAdoption) {
        promptTemplateDraftRenderEpoch += 1
      } else {
        // The retained PromptDataItem observes the adopted value and advances
        // its change baseline, but must not redispatch that projection as an edit.
        queueMicrotask(() => {
          suppressPromptTemplateDraftDispatch = false
        })
      }
    }
  })
  $effect(() => {
    if (!promptTemplateHydrated) return
    if (!promptTemplateDraftIdsNeedNormalization(promptTemplateDraft.value)) return
    untrack(() => {
      ensurePromptTemplateDraftIds(currentPromptTemplateOwnerId())
    })
  })

  function getDisplayTemplate() {
    return promptTemplateDraft.value.map((item, i) => ({
      item,
      originalIndex: i,
      displayIndex: i,
    }))
  }

  function getReorderedTemplate() {
    const drag = resolvePromptItemDrag()
    if (!drag || drag.sourceIndex === drag.adjustedDropIndex) return getDisplayTemplate()

    const items = getDisplayTemplate()
    const [movedItem] = items.splice(drag.sourceIndex, 1)
    if (!movedItem) return getDisplayTemplate()

    items.splice(drag.adjustedDropIndex, 0, movedItem)

    return items.map((item, displayIndex) => ({
      ...item,
      displayIndex,
    }))
  }

  function capturePromptItemDrag(promptItem: PromptItem): void {
    if (promptTemplateStructuralMutationPending) return
    const ownerId = currentPromptTemplateOwnerId()
    ensurePromptTemplateDraftIds(ownerId)
    const itemId = promptItem.id
    if (
      typeof itemId !== 'string' ||
      itemId.length === 0 ||
      uniquePromptItemIndex(promptTemplateDraft.value, itemId) === null
    ) {
      resetPromptItemDragState()
      return
    }
    promptItemDrag = { ownerId, itemId }
    promptItemDropBoundary = null
  }

  function capturePromptItemDropBoundary(promptItem: PromptItem, placement: PromptDropPlacement): void {
    if (promptTemplateStructuralMutationPending) return
    const drag = promptItemDrag
    const ownerId = currentPromptTemplateOwnerId()
    const itemId = promptItem.id
    if (
      !drag ||
      drag.ownerId !== ownerId ||
      typeof itemId !== 'string' ||
      itemId.length === 0 ||
      uniquePromptItemIndex(promptTemplateDraft.value, itemId) === null
    ) {
      promptItemDropBoundary = null
      return
    }
    promptItemDropBoundary = { ownerId, targetItemId: itemId, placement }
  }

  function resolvePromptItemDrag(): { sourceIndex: number; adjustedDropIndex: number } | null {
    const drag = promptItemDrag
    const boundary = promptItemDropBoundary
    const ownerId = currentPromptTemplateOwnerId()
    if (!drag || !boundary || drag.ownerId !== ownerId || boundary.ownerId !== ownerId) return null
    if (!promptTemplateItemIds(promptTemplateDraft.value)) return null

    const sourceIndex = uniquePromptItemIndex(promptTemplateDraft.value, drag.itemId)
    const targetIndex = uniquePromptItemIndex(promptTemplateDraft.value, boundary.targetItemId)
    if (sourceIndex === null || targetIndex === null) return null

    const dropIndex = targetIndex + (boundary.placement === 'after' ? 1 : 0)
    return {
      sourceIndex,
      adjustedDropIndex: sourceIndex < dropIndex ? dropIndex - 1 : dropIndex,
    }
  }

  function isPromptItemDragging(originalIndex: number): boolean {
    const drag = promptItemDrag
    if (!drag || drag.ownerId !== currentPromptTemplateOwnerId()) return false
    return uniquePromptItemIndex(promptTemplateDraft.value, drag.itemId) === originalIndex
  }

  function handlePromptDrop(): void {
    if (promptTemplateStructuralMutationPending) {
      resetPromptItemDragState()
      return
    }
    const drag = resolvePromptItemDrag()
    if (!drag || drag.sourceIndex === drag.adjustedDropIndex) {
      resetPromptItemDragState()
      return
    }

    const sequence = beginPromptTemplateStructuralMutation()
    if (sequence === null) {
      resetPromptItemDragState()
      return
    }
    if (canUseServerCommands()) commitPendingPromptTemplateMutations()
    const templates = [...promptTemplateDraft.value]
    const previous = currentPromptTemplateSnapshot()
    const projectionFence = capturePromptTemplateOwnerMutationFence()
    const openedItemIds = new Set(
      [...openedItemIndices]
        .map((index) => templates[index]?.id)
        .filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0),
    )
    const [movedItem] = templates.splice(drag.sourceIndex, 1)
    if (!movedItem) {
      resetPromptItemDragState()
      return
    }

    templates.splice(drag.adjustedDropIndex, 0, movedItem)
    openedItemIndices = new Set(
      templates.flatMap((item, index) => (item.id && openedItemIds.has(item.id) ? [index] : [])),
    )

    const ownerId = applyPromptTemplateDraft(templates)
    trackPromptTemplateStructuralMutation(
      sequence,
      dispatchReorderPromptItems(ownerId, previous, projectionFence, sequence),
    )
    resetPromptItemDragState()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.altKey && e.key === 'o') {
      if (openedItemIndices.size === promptTemplateDraft.value.length) {
        openedItemIndices = new Set<number>()
      } else {
        openedItemIndices = new Set(promptTemplateDraft.value.map((_, i) => i))
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown)
    void hydrateCurrentPromptTemplateOwner()
  })

  onDestroy(() => {
    promptTemplateHydrationRequestId += 1
    document.removeEventListener('keydown', handleKeyDown)
    commitPendingPromptTemplateMutations()
    flushPendingSettingsOwnerMutations()
    promptTokenizeDebouncer.cancel()
  })

  onDestroy(
    registerWriterDraftCapture(() => {
      const ownerId = currentPromptTemplateOwnerId()
      const templateBaseline = cloneSelectedPromptPresetTemplate()
      const templateChanged = snapshotJson(promptTemplateDraft.value) !== snapshotJson(templateBaseline)
      const settings = Object.fromEntries(
        Object.entries({
          promptSettings: promptSettingsDraft,
          jsonSchemaEnabled: jsonSchemaEnabledDraft,
          outputImageModal: outputImageModalDraft,
          strictJsonSchema: strictJsonSchemaDraft,
          customPromptTemplateToggle: customPromptTemplateToggleDraft,
          templateDefaultVariables: templateDefaultVariablesDraft,
          OAIPrediction: OAIPredictionDraft,
          autoSuggestPrompt: autoSuggestPromptDraft,
          systemContentReplacement: systemContentReplacementDraft,
          systemRoleReplacement: systemRoleReplacementDraft,
          jsonSchema: jsonSchemaDraft,
          extractJson: extractJsonDraft,
          fallbackModels: fallbackModelsDraft,
          fallbackWhenBlankResponse: fallbackWhenBlankResponseDraft,
          doNotChangeFallbackModels: doNotChangeFallbackModelsDraft,
        }).flatMap(([key, draft]) => {
          const capture = draft.captureRecoveryDraft()
          return capture ? [[key, capture]] : []
        }),
      )
      if (!templateChanged && Object.keys(settings).length === 0) return null
      const data = { ownerId, ...(templateChanged ? { promptTemplate: promptTemplateDraft.value } : {}), settings }
      return $state.snapshot({
        key: `prompt-settings:${ownerId ?? 'legacy'}`,
        label: language.template,
        fields: [
          ...(templateChanged
            ? [{ label: language.template, value: JSON.stringify(promptTemplateDraft.value, null, 2) }]
            : []),
          ...(Object.keys(settings).length
            ? [{ label: language.settings, value: JSON.stringify(settings, null, 2) }]
            : []),
        ],
        data,
        baseline: { promptTemplate: templateBaseline },
      })
    }),
  )
</script>

{#if mode === 'independent'}
  <h2 class="mb-2 text-2xl font-bold mt-2 items-center flex">
    <button
      type="button"
      aria-label={language.goback}
      class="mr-2 text-textcolor2 hover:text-textcolor"
      onclick={onGoBack}>
      <ArrowLeft />
    </button>
    {language.promptTemplate}
  </h2>

  <div class="flex w-full rounded-md border border-selected">
    <button
      type="button"
      aria-pressed={subMenu === 0}
      onclick={() => {
        subMenu = 0
      }}
      class="p-2 flex-1"
      class:bg-selected={subMenu === 0}>
      <span>{language.template}</span>
    </button>
    <button
      type="button"
      aria-pressed={subMenu === 1}
      onclick={() => {
        subMenu = 1
      }}
      class="p-2 flex-1"
      class:bg-selected={subMenu === 1}>
      <span>{language.settings}</span>
    </button>
  </div>
{/if}
{#if promptTemplateHydrated && warns.length > 0 && subMenu === 0}
  <div class="text-red-500 flex flex-col items-start p-2 rounded-md border-red-500 border mt-4">
    <h2 class="text-xl font-bold">Warning</h2>
    <div class="border-b border-b-red-500 mt-1 mb-2 w-full"></div>
    {#each warns as warn}
      <span class="ml-4">{warn}</span>
    {/each}
  </div>
{/if}

{#if subMenu === 0}
  {#if promptTemplateHydrationFailed}
    <div
      class="flex min-h-28 items-center justify-center px-6 text-textcolor2"
      role="alert"
      data-testid="prompt-template-hydration-error">
      <div class="flex flex-col items-center gap-3 text-center">
        <span class="text-sm">{language.promptTemplateLoadFailed}</span>
        <button
          type="button"
          data-testid="prompt-template-hydration-retry"
          class="flex items-center gap-2 rounded-md border border-darkborderc px-3 py-2 text-sm text-textcolor transition-colors hover:border-textcolor hover:bg-selected focus:border-textcolor focus:bg-selected"
          onclick={() => {
            void hydrateCurrentPromptTemplateOwner({ force: true, resetSelectionDirtyState: true })
          }}>
          <RefreshCcwIcon size={16} />
          <span>{language.retry}</span>
        </button>
      </div>
    </div>
  {:else if promptTemplateHydrationPending || !promptTemplateHydrated}
    <div class="text-textcolor2 mt-4" role="status" data-testid="prompt-template-hydration-loading">
      {language.loading}
    </div>
  {:else}
    {#if promptTemplateUsesSelectedFallback}
      <div
        class="mt-4 rounded-md border border-darkborderc px-3 py-2 text-sm text-textcolor2"
        role="status"
        data-testid="prompt-template-selected-fallback-notice">
        {language.promptTemplateSelectedFallbackNotice}
      </div>
    {/if}
    <div class="contain w-full max-w-full mt-4 flex flex-col p-3 rounded-md">
      {#if promptTemplateDraft.value.length === 0}
        <div class="text-textcolor2">No Format</div>
      {/if}
      {#key sorted}
        {#each getReorderedTemplate() as { item: prompt, originalIndex, displayIndex } (`${promptTemplateDraftRenderEpoch}:${prompt.id ?? originalIndex}`)}
          <PromptDataItem
            bind:promptItem={promptTemplateDraft.value[originalIndex]}
            isDragging={isPromptItemDragging(originalIndex)}
            isOpened={openedItemIndices.has(originalIndex)}
            bind:openedItemIndices
            currentIndex={originalIndex}
            {displayIndex}
            onUpdate={(promptItem, previousItem) => queuePromptItemUpdate(promptItem, previousItem, originalIndex)}
            onDragStart={capturePromptItemDrag}
            onDragOver={capturePromptItemDropBoundary}
            onDragEnd={resetPromptItemDragState}
            onDrop={handlePromptDrop}
            structuralDisabled={promptTemplateStructuralMutationPending || promptTemplateUsesSelectedFallback}
            readOnly={promptTemplateUsesSelectedFallback}
            onRemove={() => {
              if (promptTemplateStructuralMutationPending) return
              if (!confirmSettingsItemRemoval()) return
              const removed = promptTemplateDraft.value[originalIndex]
              if (!removed) return
              const sequence = beginPromptTemplateStructuralMutation()
              if (sequence === null) return
              if (canUseServerCommands()) commitPendingPromptTemplateMutations()
              const previous = currentPromptTemplateSnapshot()
              const projectionFence = capturePromptTemplateOwnerMutationFence()
              let templates = [...promptTemplateDraft.value]
              templates.splice(originalIndex, 1)
              const ownerId = applyPromptTemplateDraft(templates)

              const newOpenedIndices = new Set<number>()
              openedItemIndices.forEach((index) => {
                if (index === originalIndex) {
                  return
                } else if (index > originalIndex) {
                  newOpenedIndices.add(index - 1)
                } else {
                  newOpenedIndices.add(index)
                }
              })
              openedItemIndices = newOpenedIndices

              resetPromptItemDragState()
              trackPromptTemplateStructuralMutation(
                sequence,
                dispatchDeletePromptItem(ownerId, removed, previous, projectionFence, sequence),
              )
            }}
            moveDown={() => {
              if (originalIndex === promptTemplateDraft.value.length - 1) {
                return
              }
              movePromptItem(originalIndex, originalIndex + 1)

              const newOpenedIndices = new Set<number>()
              openedItemIndices.forEach((index) => {
                if (index === originalIndex) {
                  newOpenedIndices.add(originalIndex + 1)
                } else if (index === originalIndex + 1) {
                  newOpenedIndices.add(originalIndex)
                } else {
                  newOpenedIndices.add(index)
                }
              })
              openedItemIndices = newOpenedIndices
            }}
            moveUp={() => {
              if (originalIndex === 0) {
                return
              }
              movePromptItem(originalIndex, originalIndex - 1)

              const newOpenedIndices = new Set<number>()
              openedItemIndices.forEach((index) => {
                if (index === originalIndex) {
                  newOpenedIndices.add(originalIndex - 1)
                } else if (index === originalIndex - 1) {
                  newOpenedIndices.add(originalIndex)
                } else {
                  newOpenedIndices.add(index)
                }
              })
              openedItemIndices = newOpenedIndices
            }} />
        {/each}
      {/key}
    </div>

    <button
      type="button"
      aria-label={`${language.add}: ${language.promptTemplate}`}
      disabled={promptTemplateStructuralMutationPending || promptTemplateUsesSelectedFallback}
      class="font-medium cursor-pointer hover:text-green-500"
      class:cursor-wait={promptTemplateStructuralMutationPending}
      class:opacity-60={promptTemplateStructuralMutationPending || promptTemplateUsesSelectedFallback}
      onclick={() => {
        if (promptTemplateStructuralMutationPending || promptTemplateUsesSelectedFallback) return
        const sequence = beginPromptTemplateStructuralMutation()
        if (sequence === null) return
        if (canUseServerCommands()) commitPendingPromptTemplateMutations()
        const previous = currentPromptTemplateSnapshot()
        const promptItem = createPromptItem()
        const projectionFence = capturePromptTemplateOwnerMutationFence()
        const ownerId = applyPromptTemplateDraft([...(promptTemplateDraft.value ?? []), promptItem])
        trackPromptTemplateStructuralMutation(
          sequence,
          dispatchCreatePromptItem(ownerId, promptItem, previous, projectionFence, sequence),
        )
      }}><PlusIcon /></button>

    {#if promptTemplateStructuralMutationState === 'failed'}
      <div class="mt-2 text-sm text-red-500" role="alert" data-testid="prompt-template-structural-mutation-status">
        {promptTemplateStructuralMutationError}
      </div>
    {/if}

    <span class="text-textcolor2 text-sm mt-2">{tokens} {language.fixedTokens}</span>
    <span class="text-textcolor2 mb-6 text-sm mt-2">{extokens} {language.exactTokens}</span>
  {/if}
{:else}
  <span class="text-textcolor mt-4">{language.postEndInnerFormat}</span>
  <TextInput bind:value={promptSettingsDraft.value.postEndInnerFormat} />

  <Check bind:check={promptSettingsDraft.value.sendChatAsSystem} name={language.sendChatAsSystem} className="mt-4" />
  <Check bind:check={promptSettingsDraft.value.sendName} name={language.formatGroupInSingle} className="mt-4" />
  <Check bind:check={promptSettingsDraft.value.trimStartNewChat} name={language.trimStartNewChat} className="mt-4" />
  <Check bind:check={promptSettingsDraft.value.utilOverride} name={language.utilOverride} className="mt-4" />
  {#if showPromptModelOverrideFields}
    <Check bind:check={jsonSchemaEnabledDraft.value} name={language.enableJsonSchema} className="mt-4" />
    <Check bind:check={outputImageModalDraft.value} name={language.outputImageModal} className="mt-4" />

    <Check bind:check={strictJsonSchemaDraft.value} name={language.strictJsonSchema} className="mt-4" />
  {/if}

  {#if settingsResourceState.value.showUnrecommended === true}
    <Check
      bind:check={promptSettingsDraft.value.customChainOfThought}
      name={language.customChainOfThought}
      className="mt-4">
      <Help unrecommended key="customChainOfThought" />
    </Check>
  {/if}
  <span class="text-textcolor mt-4">{language.maxThoughtTagDepth}</span>
  <NumberInput bind:value={promptSettingsDraft.value.maxThoughtTagDepth} />
  <span class="text-textcolor mt-4"
    >{language.customPromptTemplateToggle} <Help key="customPromptTemplateToggle" /></span>
  <TextAreaInput bind:value={customPromptTemplateToggleDraft.value} />
  <span class="text-textcolor mt-4">{language.defaultVariables} <Help key="defaultVariables" /></span>
  <TextAreaInput bind:value={templateDefaultVariablesDraft.value} />
  <span class="text-textcolor mt-4">{language.predictedOutput}</span>
  <TextAreaInput bind:value={OAIPredictionDraft.value} />
  <span class="text-textcolor mt-4">{language.autoSuggest} <Help key="autoSuggest" /></span>
  <TextAreaInput bind:value={autoSuggestPromptDraft.value} placeholder={defaultAutoSuggestPrompt} />
  {#if showPromptModelOverrideFields}
    <span class="text-textcolor mt-4">{language.systemContentReplacement} <Help key="systemContentReplacement" /></span>
    <TextAreaInput bind:value={systemContentReplacementDraft.value} />
    <span class="text-textcolor mt-4">{language.systemRoleReplacement} <Help key="systemRoleReplacement" /></span>
    <SelectInput bind:value={systemRoleReplacementDraft.value}>
      <OptionInput value="user">User</OptionInput>
      <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
    {#if jsonSchemaEnabledDraft.value}
      <span class="text-textcolor mt-4">{language.jsonSchema} <Help key="jsonSchema" /></span>
      <TextAreaInput bind:value={jsonSchemaDraft.value} />
      <span class="text-textcolor mt-4">{language.extractJson} <Help key="extractJson" /></span>
      <TextInput bind:value={extractJsonDraft.value} />
    {/if}
  {/if}

  {#snippet fallbackModelList(arg: FallbackModelKey)}
    {#each fallbackModelsDraft.value[arg] as model, i}
      <span class="text-textcolor mt-4">
        {language.model}
        {i + 1}
      </span>
      <ModelList bind:value={fallbackModelsDraft.value[arg][i]} blankable />
    {/each}
    <div class="flex gap-2">
      <button
        type="button"
        aria-label={`${language.add}: ${fallbackModelLabel(arg)}`}
        class="bg-selected text-textcolor p-2 rounded-md"
        onclick={() => {
          const value = fallbackModelsDraft.value[arg] ?? []
          fallbackModelsDraft.value[arg] = [...value, '']
        }}><PlusIcon /></button>
      <button
        type="button"
        aria-label={`${language.remove}: ${fallbackModelLabel(arg)}`}
        class="bg-red-500 text-white p-2 rounded-md"
        onclick={() => {
          if (!confirmSettingsItemRemoval()) return
          const value = fallbackModelsDraft.value[arg] ?? []
          fallbackModelsDraft.value[arg] = value.slice(0, -1)
        }}><TrashIcon /></button>
    </div>
  {/snippet}

  {#if showPromptModelOverrideFields}
    <Accordion name={language.fallbackModel} styled>
      <Check
        bind:check={fallbackWhenBlankResponseDraft.value}
        name={language.fallbackWhenBlankResponse}
        className="mt-4" />
      {#if !promptPresetModelOverrideMode}
        <Check
          bind:check={doNotChangeFallbackModelsDraft.value}
          name={language.doNotChangeFallbackModels}
          className="mt-4" />
      {/if}

      <Accordion name={language.model} styled>
        {@render fallbackModelList('model')}
      </Accordion>
      <Accordion name={'Memory'} styled>
        {@render fallbackModelList('memory')}
      </Accordion>
      <Accordion name={'Translations'} styled>
        {@render fallbackModelList('translate')}
      </Accordion>
      <Accordion name={'Emotion'} styled>
        {@render fallbackModelList('emotion')}
      </Accordion>
      <Accordion name={'OtherAx'} styled>
        {@render fallbackModelList('otherAx')}
      </Accordion>
      <Accordion name={language.modelRoles.roles.scriptMain} styled>
        {@render fallbackModelList('scriptMain')}
      </Accordion>
      <Accordion name={language.modelRoles.roles.scriptAux} styled>
        {@render fallbackModelList('scriptAux')}
      </Accordion>
    </Accordion>
  {/if}
{/if}
