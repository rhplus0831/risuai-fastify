<script module lang="ts">
  let nextTranslatorPresetFlushId = 1
</script>

<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import {
    ArrowDownIcon,
    ArrowUpIcon,
    CopyIcon,
    DownloadIcon,
    HardDriveUploadIcon,
    PencilIcon,
    PlusIcon,
    TrashIcon,
  } from '@lucide/svelte'
  import Help from 'src/lib/Others/Help.svelte'
  import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
  import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
  import { alertConfirm, alertError, alertInput, alertNormal } from 'src/ts/alert'
  import { downloadFile } from 'src/ts/globalApi.svelte'
  import { createNonSecurityUuid } from 'src/ts/nonSecurityUuid'
  import {
    isModelProfileDividerSelectValue,
    modelProfileDividerSelectValue,
    modelProfileListItems,
  } from 'src/ts/model/modelProfileRecords'
  import { confirmSettingsItemRemoval } from 'src/ts/setting/confirmSettingsItemRemoval'
  import {
    canUseServerCommands,
    createTranslatorPresetCommand,
    deleteTranslatorPresetCommand,
    runServerCommand,
    selectTranslatorPresetCommand,
    subscribeServerCommandLocalEffectApplied,
    updateTranslatorPresetCommand,
    type ServerCommandResult,
    type ServerCommandTransportOptions,
    type TranslatorPresetPatchOptimisticAcknowledgement,
    type TranslatorPresetSnapshot,
  } from 'src/ts/server/commands'
  import { registerPendingOwnerMutationFlusher } from 'src/ts/server/pendingOwnerMutationRegistry'
  import {
    dispatchDurableMutation,
    registerDurableMutationSettlementListener,
  } from 'src/ts/server/durableMutationDispatch'
  import {
    acknowledgePendingMutation,
    isPendingMutationCurrent,
    stagePendingMutation,
    type DurableMutationIntent,
    type PendingMutationHandle,
  } from 'src/ts/server/pendingMutationOutbox'
  import {
    captureCollectionProjectionEpoch,
    captureSettingsGroupProjectionEpoch,
    collectionsResourceState,
    hasCollectionProjectionEpochChanged,
    markCollectionAcknowledgementTainted,
    markSettingsGroupAcknowledgementTainted,
    settingsResourceState,
  } from 'src/ts/server/resourceState.svelte'
  import { applyAttemptedFieldRollback, mergeProjectionIntoDirtyDraft } from 'src/ts/server/staleStateGuards'
  import {
    TRANSLATOR_PRESET_SELECTION_MUTATION_KEY,
    translatorPresetOwnerMutationKey,
  } from 'src/ts/server/translatorPresetMutationKeys'
  import {
    createTranslatorPreset,
    decodeTranslatorPresetFile,
    defaultTranslatorPrompt,
    encodeTranslatorPresetFile,
    getCanonicalTranslatorPresets,
    getTranslatorPresetDownloadName,
    isValidTranslatorPresetOutputKey,
    normalizeTranslatorPreset,
    TRANSLATOR_PRESET_MAX_STEPS,
    translatorPresetImportExtensions,
    type TranslatorPreset,
    type TranslatorPresetStep,
  } from 'src/ts/translator/presets'
  import { hasMalformedTranslatorHistorySlot } from 'src/ts/translator/pipeline'
  import { selectSingleFile } from 'src/ts/filePicker'
  import { language } from 'src/lang'
  import { onDestroy, untrack } from 'svelte'

  type TranslatorPresetDirtyField = 'name' | 'prompt' | 'maxResponse' | 'steps'

  interface TranslatorPresetStateSnapshot {
    translatorPresets: TranslatorPreset[]
    translatorPresetId: string
  }

  interface PendingTranslatorPresetUpdate {
    timer: ReturnType<typeof setTimeout> | null
    presetId: string
    patch: TranslatorPresetSnapshot
    previous: TranslatorPresetSnapshot
    attempted: TranslatorPresetSnapshot
    durableAttempted: TranslatorPresetSnapshot
    collectionProjectionEpoch: number
    languageSettingsProjectionEpoch: number
    selectedPresetId: string | null
    intent: DurableMutationIntent | null
    outbox: PendingMutationHandle | null
  }

  interface TranslatorPresetCreateAttempt {
    operationId: number
    attemptedPreset: TranslatorPreset & { id: string }
    draftPreset: TranslatorPreset & { id: string }
    previousSelectedPresetId: string | null
    collectionProjectionEpoch: number
  }

  interface TranslatorPresetSelectionAttempt {
    operationId: number
    previousSelectedPresetId: string | null
    attemptedPresetId: string
  }

  interface TranslatorPresetDeleteAttempt {
    operationId: number
    deletedPreset: TranslatorPreset & { id: string }
    previousIndex: number
    previousSiblingPresetId: string | null
    nextSiblingPresetId: string | null
    attemptedSelectedPreset: TranslatorPreset & { id: string }
    collectionProjectionEpoch: number
  }

  type TranslatorPresetPersistenceStatus = 'accepted' | 'queued' | 'failed'
  type TranslatorPresetPersistenceState = 'idle' | 'saving' | 'queued' | 'failed'

  type PendingTranslatorPresetStructuralMutation =
    | { kind: 'create'; attempt: TranslatorPresetCreateAttempt }
    | { kind: 'select'; attempt: TranslatorPresetSelectionAttempt }
    | { kind: 'delete'; attempt: TranslatorPresetDeleteAttempt }

  const translatorPresetUpdateDelayMs = 250
  const translatorPresetDirtyFieldNames: readonly TranslatorPresetDirtyField[] = [
    'name',
    'prompt',
    'maxResponse',
    'steps',
  ]
  const pendingTranslatorPresetUpdates = new Map<string, PendingTranslatorPresetUpdate>()
  const translatorPresetDirtyFieldsById = new Map<string, Map<TranslatorPresetDirtyField, unknown>>()
  const translatorPresetRollbackBaselinesById = new Map<string, Map<TranslatorPresetDirtyField, unknown>>()
  const unsettledTranslatorPresetFieldsById = new Map<string, Map<TranslatorPresetDirtyField, number>>()
  const pendingTranslatorPresetStructuralMutations: PendingTranslatorPresetStructuralMutation[] = []
  const translatorPresetCreateOutcomesById = new Map<string, 'pending' | 'succeeded' | 'failed'>()
  let nextTranslatorPresetStructuralOperationId = 1
  let confirmedTranslatorPresetSelectionId: string | null | undefined
  let nextTranslatorPresetFeedbackOperationId = 1
  let activeTranslatorPresetFeedbackOperationId = 0
  let translatorPresetPersistenceState = $state<TranslatorPresetPersistenceState>('idle')
  let stepOutputKeyDrafts = $state<Record<string, string>>({})
  let modelProfiles = $derived(
    settingsResourceState.groupStatuses.providers === 'ready' &&
      Array.isArray(settingsResourceState.value.modelProfiles)
      ? settingsResourceState.value.modelProfiles
      : [],
  )
  let modelProfileItems = $derived(
    modelProfileListItems(
      modelProfiles,
      settingsResourceState.groupStatuses.providers === 'ready'
        ? settingsResourceState.value.modelProfileOrder
        : undefined,
    ),
  )

  function handleTranslatorStepModelChange(
    preset: TranslatorPreset,
    stepIndex: number,
    previousProfileId: string,
    event: Event,
  ): void {
    const select = event.currentTarget
    if (!(select instanceof HTMLSelectElement)) return
    if (isModelProfileDividerSelectValue(select.value)) {
      select.value = previousProfileId
      return
    }
    const profileId = select.value
    updateTranslatorPresetStep(preset, stepIndex, {
      model: profileId ? { mode: 'modelProfile', profileId } : { mode: 'inheritTranslate' },
    })
  }

  async function runTranslatorPresetPersistenceAction(
    action: (feedbackOperationId: number) => Promise<TranslatorPresetPersistenceStatus>,
  ): Promise<TranslatorPresetPersistenceStatus> {
    const feedbackOperationId = nextTranslatorPresetFeedbackOperationId++
    activeTranslatorPresetFeedbackOperationId = feedbackOperationId
    translatorPresetPersistenceState = 'saving'

    let status: TranslatorPresetPersistenceStatus
    try {
      status = await action(feedbackOperationId)
    } catch (error) {
      console.error('Translator preset structural mutation rejected:', error)
      status = 'failed'
    }

    if (activeTranslatorPresetFeedbackOperationId === feedbackOperationId) {
      translatorPresetPersistenceState = status === 'accepted' ? 'idle' : status
    }
    if (status === 'queued') alertNormal(language.translatorPresetPersistence.queued)
    if (status === 'failed') alertError(language.translatorPresetPersistence.failed)
    return status
  }

  function settleTranslatorPresetPersistenceFeedback(
    feedbackOperationId: number,
    settlement: 'accepted' | 'discarded',
  ): void {
    if (settlement === 'discarded') {
      activeTranslatorPresetFeedbackOperationId = Math.max(
        activeTranslatorPresetFeedbackOperationId,
        feedbackOperationId,
      )
      translatorPresetPersistenceState = 'failed'
      alertError(language.translatorPresetPersistence.failed)
      return
    }
    if (
      activeTranslatorPresetFeedbackOperationId === feedbackOperationId &&
      translatorPresetPersistenceState === 'queued'
    ) {
      translatorPresetPersistenceState = 'idle'
    }
  }

  function trackTranslatorPresetFinalSettlement(
    outbox: PendingMutationHandle,
    feedbackOperationId: number,
    callbacks: { accepted: () => void; discarded: () => void },
  ): () => void {
    let active = true
    let unregister = () => {}
    const stop = () => {
      if (!active) return
      active = false
      unregister()
    }
    unregister = registerDurableMutationSettlementListener(outbox.mutationId, (settlement) => {
      if (!active) return
      stop()
      callbacks[settlement]()
      settleTranslatorPresetPersistenceFeedback(feedbackOperationId, settlement)
    })
    return stop
  }

  function translatorPresetRecord(preset: TranslatorPreset): Record<string, unknown> {
    return preset as unknown as Record<string, unknown>
  }

  function translatorPresetFromRecord(preset: Record<string, unknown>): TranslatorPreset {
    return preset as unknown as TranslatorPreset
  }

  function applyTranslatorPresetFieldPatch(
    preset: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...preset, ...patch }
    if (Object.prototype.hasOwnProperty.call(patch, 'steps') || !Array.isArray(next.steps) || !next.steps[0]) {
      return next
    }
    if (
      !Object.prototype.hasOwnProperty.call(patch, 'prompt') &&
      !Object.prototype.hasOwnProperty.call(patch, 'maxResponse')
    ) {
      return next
    }
    next.steps = next.steps.map((step, index) =>
      index === 0 && step && typeof step === 'object' && !Array.isArray(step)
        ? {
            ...(step as Record<string, unknown>),
            ...(Object.prototype.hasOwnProperty.call(patch, 'prompt') ? { prompt: patch.prompt } : {}),
            ...(Object.prototype.hasOwnProperty.call(patch, 'maxResponse') ? { maxResponse: patch.maxResponse } : {}),
          }
        : step,
    )
    return next
  }
  let translatorPresetUpdateDispatchChain: Promise<ServerCommandResult> = Promise.resolve({ status: 'unavailable' })
  let previousTranslatorPresetCollectionProjectionEpoch = captureCollectionProjectionEpoch('translatorPresets')
  let previousLanguageSettingsProjectionEpoch = captureSettingsGroupProjectionEpoch('language')
  let confirmedTranslatorPresetCollection: TranslatorPreset[] | undefined

  function cloneJsonValue<T>(value: T): T {
    if (value === undefined) return value
    return JSON.parse(JSON.stringify(value)) as T
  }

  function snapshotJson(value: unknown): string {
    const snapshot = JSON.stringify(value)
    return snapshot === undefined ? '__undefined__' : snapshot
  }

  function currentTranslatorPresetCollectionOwner(): TranslatorPreset[] | null {
    if (collectionsResourceState.statuses.translatorPresets !== 'ready') return null
    return (
      getCanonicalTranslatorPresets({
        translatorPresets: collectionsResourceState.values.translatorPresets,
      }) ?? null
    )
  }

  function currentTranslatorPresetSelectionOwner(presets: readonly TranslatorPreset[]): string | null {
    if (settingsResourceState.groupStatuses.language !== 'ready') return null
    const selectedId = settingsResourceState.value.translatorPresetId
    if (typeof selectedId !== 'string' || !selectedId.trim()) return null
    return presets.filter((preset) => preset.id === selectedId).length === 1 ? selectedId : null
  }

  function currentTranslatorPresetOwnerState(): TranslatorPresetStateSnapshot | null {
    const translatorPresets = currentTranslatorPresetCollectionOwner()
    if (!translatorPresets) return null
    const translatorPresetId = currentTranslatorPresetSelectionOwner(translatorPresets)
    if (!translatorPresetId) return null
    return { translatorPresets, translatorPresetId }
  }

  function updateTranslatorPresetOwnerState(
    mutator: (draft: TranslatorPresetStateSnapshot) => boolean | void,
  ): boolean {
    const current = currentTranslatorPresetOwnerState()
    if (!current) return false

    const draft = cloneJsonValue(current)
    if (mutator(draft) === false) return false
    const canonicalPresets = getCanonicalTranslatorPresets(draft)
    if (
      !canonicalPresets ||
      typeof draft.translatorPresetId !== 'string' ||
      canonicalPresets.filter((preset) => preset.id === draft.translatorPresetId).length !== 1
    ) {
      return false
    }

    collectionsResourceState.values.translatorPresets = canonicalPresets
    settingsResourceState.value.translatorPresetId = draft.translatorPresetId
    return true
  }

  function currentTranslatorPresetStateSnapshot(): TranslatorPresetStateSnapshot | null {
    const current = currentTranslatorPresetOwnerState()
    return current ? cloneJsonValue(current) : null
  }

  function translatorPresetFromSnapshot(
    snapshot: TranslatorPresetStateSnapshot | null,
    presetId: string,
  ): TranslatorPreset | null {
    return snapshot?.translatorPresets.find((preset) => preset.id === presetId) ?? null
  }

  function currentTranslatorPresetById(presetId: string): TranslatorPreset | null {
    const presets = currentTranslatorPresetCollectionOwner()
    if (!presets) return null
    const matches = presets.filter((preset) => preset.id === presetId)
    return matches.length === 1 ? matches[0] : null
  }

  function currentSelectedTranslatorPresetId(): string | null {
    const presets = currentTranslatorPresetCollectionOwner()
    return presets ? currentTranslatorPresetSelectionOwner(presets) : null
  }

  function currentSelectedTranslatorPreset(): TranslatorPreset | null {
    const selectedId = currentSelectedTranslatorPresetId()
    if (!selectedId) return null
    return currentTranslatorPresetById(selectedId)
  }

  function translatorPresetOwnerDependencyKeys(...presetIds: Array<string | null | undefined>): string[] {
    return Array.from(
      new Set(
        presetIds.filter((presetId): presetId is string => Boolean(presetId)).map(translatorPresetOwnerMutationKey),
      ),
    )
  }

  function projectedSelectedTranslatorPresetId(): string | null {
    const selectedId = settingsResourceState.value.translatorPresetId
    if (typeof selectedId === 'string' && selectedId.trim()) {
      const projectedPresetId = confirmedTranslatorPresetCollection?.find((preset) => preset.id === selectedId)?.id
      if (projectedPresetId) return projectedPresetId
    }
    return currentSelectedTranslatorPresetId()
  }

  function confirmedSelectedTranslatorPresetId(): string | null {
    if (confirmedTranslatorPresetSelectionId === undefined) {
      confirmedTranslatorPresetSelectionId = currentSelectedTranslatorPresetId()
      confirmedTranslatorPresetCollection = cloneJsonValue(currentTranslatorPresetCollectionOwner() ?? [])
    }
    return confirmedTranslatorPresetSelectionId
  }

  function absorbUnreconciledTranslatorPresetProjectionEpochs(): void {
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('translatorPresets')
    if (collectionProjectionEpoch !== previousTranslatorPresetCollectionProjectionEpoch) {
      previousTranslatorPresetCollectionProjectionEpoch = collectionProjectionEpoch
      confirmedTranslatorPresetCollection = cloneJsonValue(currentTranslatorPresetCollectionOwner() ?? [])
    }

    const languageSettingsProjectionEpoch = captureSettingsGroupProjectionEpoch('language')
    if (languageSettingsProjectionEpoch !== previousLanguageSettingsProjectionEpoch) {
      previousLanguageSettingsProjectionEpoch = languageSettingsProjectionEpoch
      confirmedTranslatorPresetSelectionId = projectedSelectedTranslatorPresetId()
    }
  }

  function settleConfirmedTranslatorPresetCreate(attempt: TranslatorPresetCreateAttempt): void {
    const presets = cloneJsonValue(
      confirmedTranslatorPresetCollection ?? currentTranslatorPresetCollectionOwner() ?? [],
    )
    if (!presets.some((preset) => preset.id === attempt.attemptedPreset.id)) {
      presets.push(cloneJsonValue(attempt.attemptedPreset))
    }
    confirmedTranslatorPresetCollection = presets
    confirmedTranslatorPresetSelectionId = attempt.attemptedPreset.id
  }

  function settleConfirmedTranslatorPresetDelete(attempt: TranslatorPresetDeleteAttempt): void {
    confirmedTranslatorPresetCollection = cloneJsonValue(
      (confirmedTranslatorPresetCollection ?? currentTranslatorPresetCollectionOwner() ?? []).filter(
        (preset) => preset.id !== attempt.deletedPreset.id,
      ),
    )
    confirmedTranslatorPresetSelectionId = attempt.attemptedSelectedPreset.id
  }

  function registerPendingTranslatorPresetStructuralMutation(
    mutation: PendingTranslatorPresetStructuralMutation,
  ): void {
    pendingTranslatorPresetStructuralMutations.push(mutation)
    pendingTranslatorPresetStructuralMutations.sort(
      (left, right) => left.attempt.operationId - right.attempt.operationId,
    )
  }

  function removePendingTranslatorPresetStructuralMutation(operationId: number): void {
    const index = pendingTranslatorPresetStructuralMutations.findIndex(
      (mutation) => mutation.attempt.operationId === operationId,
    )
    if (index !== -1) pendingTranslatorPresetStructuralMutations.splice(index, 1)
  }

  function hasPendingTranslatorPresetStructuralMutation(operationId: number): boolean {
    return pendingTranslatorPresetStructuralMutations.some((mutation) => mutation.attempt.operationId === operationId)
  }

  function hasPendingTranslatorPresetCreate(presetId: string): boolean {
    return pendingTranslatorPresetStructuralMutations.some(
      (mutation) => mutation.kind === 'create' && mutation.attempt.attemptedPreset.id === presetId,
    )
  }

  async function isTranslatorPresetMutationRetained(outbox: PendingMutationHandle | null): Promise<boolean> {
    if (!outbox?.ownerWriterSessionId || outbox.writerEpoch === null || !outbox.databaseLineage) return false
    return isPendingMutationCurrent(outbox)
  }

  function updatePendingTranslatorPresetCreateDraft(presetId: string, patch: TranslatorPresetSnapshot): void {
    for (const mutation of pendingTranslatorPresetStructuralMutations) {
      if (mutation.kind !== 'create' || mutation.attempt.attemptedPreset.id !== presetId) continue
      mutation.attempt.draftPreset = translatorPresetFromRecord(
        applyTranslatorPresetFieldPatch(
          translatorPresetRecord(mutation.attempt.draftPreset),
          cloneJsonValue(patch) as Record<string, unknown>,
        ),
      ) as TranslatorPreset & { id: string }
      mutation.attempt.draftPreset.id = presetId
    }
  }

  function cancelPendingTranslatorPresetUpdates(presetId: string): void {
    const pending = pendingTranslatorPresetUpdates.get(presetId)
    if (pending?.timer) clearTimeout(pending.timer)
    if (pending?.outbox) void acknowledgePendingMutation(pending.outbox)
    pendingTranslatorPresetUpdates.delete(presetId)
    translatorPresetDirtyFieldsById.delete(presetId)
    translatorPresetRollbackBaselinesById.delete(presetId)
  }

  function retainPendingTranslatorPresetUpdateForReplay(presetId: string): void {
    const pending = pendingTranslatorPresetUpdates.get(presetId)
    if (pending?.timer) clearTimeout(pending.timer)
    pendingTranslatorPresetUpdates.delete(presetId)
    translatorPresetDirtyFieldsById.delete(presetId)
    translatorPresetRollbackBaselinesById.delete(presetId)
  }

  function translatorPresetRollbackInsertionIndex(
    presets: readonly TranslatorPreset[],
    attempt: TranslatorPresetDeleteAttempt,
  ): number {
    if (attempt.nextSiblingPresetId) {
      const nextIndex = presets.findIndex((preset) => preset.id === attempt.nextSiblingPresetId)
      if (nextIndex !== -1) return nextIndex
    }
    if (attempt.previousSiblingPresetId) {
      const previousIndex = presets.findIndex((preset) => preset.id === attempt.previousSiblingPresetId)
      if (previousIndex !== -1) return previousIndex + 1
    }
    return Math.min(Math.max(attempt.previousIndex, 0), presets.length)
  }

  function reassertPendingTranslatorPresetStructuralMutations(): void {
    if (pendingTranslatorPresetStructuralMutations.length === 0) return

    updateTranslatorPresetOwnerState((draft) => {
      const presets = draft.translatorPresets
      let selectedPresetId: string | null = draft.translatorPresetId

      for (const mutation of pendingTranslatorPresetStructuralMutations) {
        if (mutation.kind === 'create') {
          const presetId = mutation.attempt.attemptedPreset.id
          if (!presets.some((preset) => preset.id === presetId)) {
            presets.push(cloneJsonValue(mutation.attempt.draftPreset))
          }
          selectedPresetId = presetId
          continue
        }

        if (mutation.kind === 'select') {
          if (presets.some((preset) => preset.id === mutation.attempt.attemptedPresetId)) {
            selectedPresetId = mutation.attempt.attemptedPresetId
          }
          continue
        }

        if (
          mutation.kind === 'delete' &&
          translatorPresetCreateOutcomesById.get(mutation.attempt.deletedPreset.id) === 'failed'
        ) {
          continue
        }

        const deletedIndex = presets.findIndex((preset) => preset.id === mutation.attempt.deletedPreset.id)
        if (deletedIndex !== -1) presets.splice(deletedIndex, 1)
        if (presets.some((preset) => preset.id === mutation.attempt.attemptedSelectedPreset.id)) {
          selectedPresetId = mutation.attempt.attemptedSelectedPreset.id
        } else if (selectedPresetId === mutation.attempt.deletedPreset.id) {
          selectedPresetId = presets[0]?.id ?? null
        }
      }

      const fallbackPresetId = selectedPresetId ?? presets[0]?.id
      if (!fallbackPresetId) return false
      draft.translatorPresets = presets
      draft.translatorPresetId = fallbackPresetId
    })
  }

  function isTranslatorPresetDirtyField(key: string): key is TranslatorPresetDirtyField {
    return translatorPresetDirtyFieldNames.includes(key as TranslatorPresetDirtyField)
  }

  function translatorPresetPatchDirtyFields(patch: TranslatorPresetSnapshot): TranslatorPresetDirtyField[] {
    return Object.keys(patch).filter(isTranslatorPresetDirtyField)
  }

  function markTranslatorPresetFieldsUnsettled(presetId: string, fields: readonly TranslatorPresetDirtyField[]): void {
    let unsettledFields = unsettledTranslatorPresetFieldsById.get(presetId)
    if (!unsettledFields) {
      unsettledFields = new Map()
      unsettledTranslatorPresetFieldsById.set(presetId, unsettledFields)
    }

    for (const field of fields) {
      unsettledFields.set(field, (unsettledFields.get(field) ?? 0) + 1)
    }
  }

  function clearTranslatorPresetFieldsUnsettled(presetId: string, fields: readonly TranslatorPresetDirtyField[]): void {
    const unsettledFields = unsettledTranslatorPresetFieldsById.get(presetId)
    if (!unsettledFields) return

    for (const field of fields) {
      const remaining = (unsettledFields.get(field) ?? 0) - 1
      if (remaining > 0) unsettledFields.set(field, remaining)
      else unsettledFields.delete(field)
    }

    if (unsettledFields.size === 0) {
      unsettledTranslatorPresetFieldsById.delete(presetId)
    }
  }

  function isTranslatorPresetFieldUnsettled(presetId: string, field: TranslatorPresetDirtyField): boolean {
    return (unsettledTranslatorPresetFieldsById.get(presetId)?.get(field) ?? 0) > 0
  }

  function markTranslatorPresetDirtyFields(presetId: string, patch: TranslatorPresetSnapshot): void {
    const dirtyPatchFields = translatorPresetPatchDirtyFields(patch)
    if (dirtyPatchFields.length === 0) return

    let dirtyFields = translatorPresetDirtyFieldsById.get(presetId)
    if (!dirtyFields) {
      dirtyFields = new Map()
      translatorPresetDirtyFieldsById.set(presetId, dirtyFields)
    }

    for (const field of dirtyPatchFields) {
      dirtyFields.set(field, cloneJsonValue(patch[field]))
    }
  }

  function clearTranslatorPresetDirtyFieldsMatchingValues(
    presetId: string,
    values: Record<string, unknown>,
    fields: Iterable<TranslatorPresetDirtyField>,
  ): void {
    const dirtyFields = translatorPresetDirtyFieldsById.get(presetId)
    if (!dirtyFields) return
    const rollbackBaselines = translatorPresetRollbackBaselinesById.get(presetId)

    for (const field of fields) {
      if (snapshotJson(dirtyFields.get(field)) === snapshotJson(values[field])) {
        dirtyFields.delete(field)
        rollbackBaselines?.delete(field)
      }
    }

    if (dirtyFields.size === 0) {
      translatorPresetDirtyFieldsById.delete(presetId)
    }
    if (rollbackBaselines?.size === 0) translatorPresetRollbackBaselinesById.delete(presetId)
  }

  function translatorPresetDirtyRollbackFields(
    presetId: string,
    attemptedPreset: TranslatorPresetSnapshot,
    patch: TranslatorPresetSnapshot,
  ): TranslatorPresetDirtyField[] {
    const dirtyFields = translatorPresetDirtyFieldsById.get(presetId)
    if (!dirtyFields) return []

    return translatorPresetPatchDirtyFields(patch).filter(
      (field) =>
        dirtyFields.has(field) && snapshotJson(dirtyFields.get(field)) === snapshotJson(attemptedPreset[field]),
    )
  }

  function advanceTranslatorPresetRollbackBaselines(
    presetId: string,
    attempted: TranslatorPresetSnapshot,
    fields: readonly TranslatorPresetDirtyField[],
  ): void {
    const dirtyFields = translatorPresetDirtyFieldsById.get(presetId)
    let rollbackBaselines = translatorPresetRollbackBaselinesById.get(presetId)

    for (const field of fields) {
      if (!dirtyFields?.has(field)) {
        rollbackBaselines?.delete(field)
        continue
      }
      if (!rollbackBaselines) {
        rollbackBaselines = new Map()
        translatorPresetRollbackBaselinesById.set(presetId, rollbackBaselines)
      }
      rollbackBaselines.set(field, cloneJsonValue(attempted[field]))
    }

    if (rollbackBaselines?.size === 0) translatorPresetRollbackBaselinesById.delete(presetId)
  }

  function projectionMatchesTranslatorPresetDirtyValue(
    preset: TranslatorPreset,
    field: TranslatorPresetDirtyField,
    value: unknown,
  ): boolean {
    return snapshotJson(preset[field]) === snapshotJson(value)
  }

  function clearTranslatorPresetDirtyFieldsMatchingProjection(
    presetId: string,
    preset: TranslatorPreset,
    presetIndex: number,
    dirtyFields: Map<TranslatorPresetDirtyField, unknown>,
  ): void {
    let rollbackBaselines = translatorPresetRollbackBaselinesById.get(presetId)
    for (const [field, value] of Array.from(dirtyFields.entries())) {
      if (projectionMatchesTranslatorPresetDirtyValue(preset, field, value)) {
        dirtyFields.delete(field)
        rollbackBaselines?.delete(field)
        continue
      }

      if (!rollbackBaselines) {
        rollbackBaselines = new Map()
        translatorPresetRollbackBaselinesById.set(presetId, rollbackBaselines)
      }
      rollbackBaselines.set(field, cloneJsonValue(preset[field]))
    }
    if (rollbackBaselines?.size === 0) translatorPresetRollbackBaselinesById.delete(presetId)
  }

  function reassertDirtyTranslatorPresetFields(
    presetId: string,
    dirtyFields: ReadonlyMap<TranslatorPresetDirtyField, unknown>,
  ): void {
    if (dirtyFields.size === 0) return

    updateTranslatorPresetOwnerState((draft) => {
      const presets = draft.translatorPresets
      const presetIndex = presets.findIndex((preset) => preset.id === presetId)
      if (presetIndex === -1) {
        translatorPresetDirtyFieldsById.delete(presetId)
        translatorPresetRollbackBaselinesById.delete(presetId)
        return
      }

      const projectionPreset = presets[presetIndex]
      const dirtyFieldSet = new Set(dirtyFields.keys())
      const dirtyDraft = cloneJsonValue(projectionPreset) as unknown as Record<string, unknown>
      for (const [field, value] of dirtyFields) {
        dirtyDraft[field] = cloneJsonValue(value)
      }

      presets[presetIndex] = translatorPresetFromRecord(
        applyTranslatorPresetFieldPatch(
          mergeProjectionIntoDirtyDraft({
            draft: dirtyDraft,
            projection: translatorPresetRecord(projectionPreset),
            dirtyFields: dirtyFieldSet,
          }),
          Object.fromEntries(dirtyFields),
        ),
      )
      draft.translatorPresets = presets
    })
  }

  function reconcileTranslatorPresetProjectionEpoch(authoritativePresetIds: ReadonlySet<string>): void {
    if (translatorPresetDirtyFieldsById.size === 0) return

    const presets = currentTranslatorPresetCollectionOwner() ?? []
    for (const [presetId, dirtyFields] of Array.from(translatorPresetDirtyFieldsById.entries())) {
      if (!authoritativePresetIds.has(presetId) && hasPendingTranslatorPresetCreate(presetId)) continue
      const presetIndex = presets.findIndex((preset) => preset.id === presetId)
      if (presetIndex === -1) {
        translatorPresetDirtyFieldsById.delete(presetId)
        translatorPresetRollbackBaselinesById.delete(presetId)
        continue
      }

      clearTranslatorPresetDirtyFieldsMatchingProjection(presetId, presets[presetIndex], presetIndex, dirtyFields)
      if (dirtyFields.size === 0) {
        translatorPresetDirtyFieldsById.delete(presetId)
        continue
      }

      reassertDirtyTranslatorPresetFields(presetId, dirtyFields)
    }
  }

  function reassertAllDirtyTranslatorPresetFields(): void {
    for (const [presetId, dirtyFields] of translatorPresetDirtyFieldsById) {
      reassertDirtyTranslatorPresetFields(presetId, dirtyFields)
    }
  }

  function restoreTranslatorPresetUpdateState(
    presetId: string,
    previous: TranslatorPresetSnapshot,
    attempted: TranslatorPresetSnapshot,
    patch: TranslatorPresetSnapshot,
  ): void {
    const currentPreset = currentTranslatorPresetById(presetId)

    if (!currentPreset) return

    const rollbackFields = translatorPresetDirtyRollbackFields(presetId, attempted, patch)
    if (rollbackFields.length === 0) return
    const rollbackPrevious = { ...previous } as Record<string, unknown>
    const rollbackBaselines = translatorPresetRollbackBaselinesById.get(presetId)
    for (const field of rollbackFields) {
      if (rollbackBaselines?.has(field)) rollbackPrevious[field] = cloneJsonValue(rollbackBaselines.get(field))
    }

    updateTranslatorPresetOwnerState((draft) => {
      const presetIndex = draft.translatorPresets.findIndex((preset) => preset.id === presetId)
      if (presetIndex === -1) return

      const nextPresets = [...draft.translatorPresets]
      const nextPreset = cloneJsonValue(nextPresets[presetIndex]) as unknown as Record<string, unknown>
      const rolledBackFields = applyAttemptedFieldRollback({
        target: nextPreset,
        previous: rollbackPrevious,
        attempted,
        keys: rollbackFields,
      }) as TranslatorPresetDirtyField[]
      if (rolledBackFields.length === 0) return

      nextPresets[presetIndex] = translatorPresetFromRecord(
        applyTranslatorPresetFieldPatch(
          nextPreset,
          Object.fromEntries(rolledBackFields.map((field) => [field, nextPreset[field]])),
        ),
      )
      draft.translatorPresets = nextPresets

      clearTranslatorPresetDirtyFieldsMatchingValues(presetId, attempted, rolledBackFields)
    })
  }

  function createClientTranslatorPresetId(): string {
    return createNonSecurityUuid()
  }

  function applyTranslatorPresetPatchToDatabase(presetId: string, patch: TranslatorPresetSnapshot): void {
    const applied = updateTranslatorPresetOwnerState((draft) => {
      const presets = draft.translatorPresets
      const presetIndex = presets.findIndex((preset) => preset.id === presetId)
      if (presetIndex === -1) return false

      const nextPreset = translatorPresetFromRecord(
        applyTranslatorPresetFieldPatch(
          translatorPresetRecord(presets[presetIndex]),
          cloneJsonValue(patch) as Record<string, unknown>,
        ),
      )
      const nextPresets = [...presets]
      nextPresets[presetIndex] = nextPreset
      draft.translatorPresets = nextPresets
    })
    if (applied) updatePendingTranslatorPresetCreateDraft(presetId, patch)
  }

  function selectedTranslatorPresetId(): string | null {
    return currentSelectedTranslatorPresetId()
  }

  function translatorPresetPatchOptimisticAcknowledgement(
    pending: PendingTranslatorPresetUpdate,
  ): TranslatorPresetPatchOptimisticAcknowledgement | undefined {
    const currentPreset = currentTranslatorPresetById(pending.presetId)
    const attemptedPreset = currentPreset
      ? {
          id: currentPreset.id,
          name: currentPreset.name,
          prompt: currentPreset.prompt,
          maxResponse: currentPreset.maxResponse,
          ...(Array.isArray(currentPreset.steps) ? { steps: cloneJsonValue(currentPreset.steps) } : {}),
        }
      : null
    const attemptedKeys = Object.keys(pending.patch)
    if (
      !attemptedPreset ||
      attemptedPreset.id !== pending.presetId ||
      !pending.selectedPresetId ||
      attemptedKeys.length === 0 ||
      attemptedKeys.some(
        (key) =>
          !isTranslatorPresetDirtyField(key) || snapshotJson(attemptedPreset[key]) !== snapshotJson(pending.patch[key]),
      )
    ) {
      return undefined
    }

    return {
      collectionProjectionEpoch: pending.collectionProjectionEpoch,
      languageSettingsProjectionEpoch: pending.languageSettingsProjectionEpoch,
      selectedPresetId: pending.selectedPresetId,
      attemptedPreset,
    }
  }

  const unsubscribeLocalEffectApplied = subscribeServerCommandLocalEffectApplied((_event, localEffect) => {
    if (localEffect.kind !== 'translatorPresetPatch') return
    clearTranslatorPresetDirtyFieldsMatchingValues(
      localEffect.presetId,
      localEffect.attemptedPatch,
      translatorPresetPatchDirtyFields(localEffect.attemptedPatch),
    )
  })

  function runTranslatorPresetCommand<T extends Record<string, unknown>>(
    command: (baseRevision: number) => Promise<ServerCommandResult<T>>,
    rollback?: () => void,
    transport: ServerCommandTransportOptions = {},
  ): Promise<ServerCommandResult<T>> {
    if (!canUseServerCommands()) return Promise.resolve({ status: 'unavailable' })
    return runServerCommand({ command, rollback, ...transport })
  }

  function applyOptimisticTranslatorPresetCreate(preset: TranslatorPreset): TranslatorPresetCreateAttempt | null {
    const attemptedPreset = cloneJsonValue(preset)
    const presetId = attemptedPreset.id
    if (!presetId || presetId.trim().length === 0) return null
    if (!currentTranslatorPresetOwnerState()) return null
    const attemptedPresetWithId = attemptedPreset as TranslatorPreset & { id: string }
    const previousSelectedPresetId = currentSelectedTranslatorPresetId()
    confirmedSelectedTranslatorPresetId()

    const attempt: TranslatorPresetCreateAttempt = {
      operationId: nextTranslatorPresetStructuralOperationId++,
      attemptedPreset: attemptedPresetWithId,
      draftPreset: cloneJsonValue(attemptedPresetWithId),
      previousSelectedPresetId,
      collectionProjectionEpoch: captureCollectionProjectionEpoch('translatorPresets'),
    }
    const applied = updateTranslatorPresetOwnerState((draft) => {
      const presets = draft.translatorPresets
      if (presets.some((existingPreset) => existingPreset.id === presetId)) return false

      const nextPresets = [...presets, cloneJsonValue(attemptedPresetWithId)]
      draft.translatorPresets = nextPresets
      draft.translatorPresetId = attemptedPresetWithId.id
    })

    if (applied) {
      translatorPresetCreateOutcomesById.set(presetId, 'pending')
      registerPendingTranslatorPresetStructuralMutation({ kind: 'create', attempt })
    }
    return applied ? attempt : null
  }

  function rollbackOptimisticTranslatorPresetCreate(attempt: TranslatorPresetCreateAttempt): void {
    absorbUnreconciledTranslatorPresetProjectionEpochs()
    removePendingTranslatorPresetStructuralMutation(attempt.operationId)
    translatorPresetCreateOutcomesById.set(attempt.attemptedPreset.id, 'failed')
    markCollectionAcknowledgementTainted('translatorPresets')
    markSettingsGroupAcknowledgementTainted('language')

    updateTranslatorPresetOwnerState((draft) => {
      const presets = draft.translatorPresets
      const selectedPresetId = draft.translatorPresetId
      const selectedAttemptedPreset = selectedPresetId === attempt.attemptedPreset.id
      const preserveAuthoritativePreset =
        hasCollectionProjectionEpochChanged('translatorPresets', attempt.collectionProjectionEpoch) &&
        (confirmedTranslatorPresetCollection?.some((preset) => preset.id === attempt.attemptedPreset.id) ?? false)
      const nextPresets = preserveAuthoritativePreset
        ? [...presets]
        : presets.filter((preset) => preset.id !== attempt.attemptedPreset.id)
      if (nextPresets.length === 0) return false
      draft.translatorPresets = nextPresets

      if (nextPresets.some((translatorPreset) => translatorPreset.id === attempt.attemptedPreset.id)) {
        draft.translatorPresetId = attempt.attemptedPreset.id
        return
      }

      if (selectedAttemptedPreset) {
        const confirmedPresetId = confirmedSelectedTranslatorPresetId()
        const restoredSelection = nextPresets.some(
          (translatorPreset) => translatorPreset.id === attempt.attemptedPreset.id,
        )
          ? attempt.attemptedPreset.id
          : confirmedPresetId && nextPresets.some((translatorPreset) => translatorPreset.id === confirmedPresetId)
            ? confirmedPresetId
            : (nextPresets[0]?.id ?? '')
        draft.translatorPresetId = restoredSelection
        return
      }

      if (selectedPresetId) {
        const preservedSelectedPresetIndex = nextPresets.findIndex(
          (translatorPreset) => translatorPreset.id === selectedPresetId,
        )
        if (preservedSelectedPresetIndex !== -1) {
          draft.translatorPresetId = selectedPresetId
        }
      }
    })
    reassertPendingTranslatorPresetStructuralMutations()
  }

  function dispatchCreateTranslatorPreset(
    preset: TranslatorPreset,
    previousSelectedPresetId: string | null,
    rollback?: () => void,
    captureOutbox?: (outbox: PendingMutationHandle) => void,
  ): Promise<ServerCommandResult> {
    if (!canUseServerCommands()) return Promise.resolve({ status: 'unavailable' })
    const attemptedPreset = cloneJsonValue(preset) as TranslatorPresetSnapshot
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/translator-presets',
          body: { preset: attemptedPreset, select: true },
        },
      ],
      dependencyKeys: translatorPresetOwnerDependencyKeys(
        previousSelectedPresetId,
        typeof attemptedPreset.id === 'string' ? attemptedPreset.id : null,
      ),
    }
    const outbox = stagePendingMutation(TRANSLATOR_PRESET_SELECTION_MUTATION_KEY, intent)
    captureOutbox?.(outbox)
    return dispatchDurableMutation(outbox, intent, (transport) =>
      runTranslatorPresetCommand(
        (baseRevision) =>
          createTranslatorPresetCommand({
            baseRevision,
            preset: cloneJsonValue(attemptedPreset),
            select: true,
          }),
        rollback,
        transport,
      ),
    )
  }

  async function createTranslatorPresetOptimistically(
    preset: TranslatorPreset,
    feedbackOperationId: number,
  ): Promise<TranslatorPresetPersistenceStatus> {
    const attempt = applyOptimisticTranslatorPresetCreate(preset)
    if (!attempt) return 'failed'
    let createOutbox: PendingMutationHandle | null = null
    let stopFinalSettlement = () => {}
    let result: ServerCommandResult
    try {
      result = await dispatchCreateTranslatorPreset(
        preset,
        attempt.previousSelectedPresetId,
        () => rollbackOptimisticTranslatorPresetCreate(attempt),
        (outbox) => {
          createOutbox = outbox
          stopFinalSettlement = trackTranslatorPresetFinalSettlement(outbox, feedbackOperationId, {
            accepted: () => {
              removePendingTranslatorPresetStructuralMutation(attempt.operationId)
              translatorPresetCreateOutcomesById.set(attempt.attemptedPreset.id, 'succeeded')
              settleConfirmedTranslatorPresetCreate(attempt)
            },
            discarded: () => {
              if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
                rollbackOptimisticTranslatorPresetCreate(attempt)
              }
              cancelPendingTranslatorPresetUpdates(attempt.attemptedPreset.id)
            },
          })
        },
      )
    } catch (error) {
      console.error('Translator preset create command rejected:', error)
      const retained = await isTranslatorPresetMutationRetained(createOutbox)
      if (retained) {
        if (!hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
          translatorPresetCreateOutcomesById.set(attempt.attemptedPreset.id, 'pending')
          registerPendingTranslatorPresetStructuralMutation({ kind: 'create', attempt })
        }
        reassertPendingTranslatorPresetStructuralMutations()
        retainPendingTranslatorPresetUpdateForReplay(attempt.attemptedPreset.id)
        return 'queued'
      }
      stopFinalSettlement()
      if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
        rollbackOptimisticTranslatorPresetCreate(attempt)
      }
      cancelPendingTranslatorPresetUpdates(attempt.attemptedPreset.id)
      return 'failed'
    }
    if (result.status !== 'ok') {
      const retained = await isTranslatorPresetMutationRetained(createOutbox)
      if (retained) {
        if (!hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
          translatorPresetCreateOutcomesById.set(attempt.attemptedPreset.id, 'pending')
          registerPendingTranslatorPresetStructuralMutation({ kind: 'create', attempt })
        }
        reassertPendingTranslatorPresetStructuralMutations()
        retainPendingTranslatorPresetUpdateForReplay(attempt.attemptedPreset.id)
        return 'queued'
      }
      stopFinalSettlement()
      if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
        rollbackOptimisticTranslatorPresetCreate(attempt)
      }
      cancelPendingTranslatorPresetUpdates(attempt.attemptedPreset.id)
      return 'failed'
    }
    stopFinalSettlement()
    removePendingTranslatorPresetStructuralMutation(attempt.operationId)
    translatorPresetCreateOutcomesById.set(attempt.attemptedPreset.id, 'succeeded')
    settleConfirmedTranslatorPresetCreate(attempt)
    return 'accepted'
  }

  function applyOptimisticTranslatorPresetSelection(presetId: string): TranslatorPresetSelectionAttempt | null {
    if (!currentTranslatorPresetById(presetId)) return null
    const previousSelectedPresetId = currentSelectedTranslatorPresetId()
    if (!previousSelectedPresetId) return null
    confirmedSelectedTranslatorPresetId()

    const attempt: TranslatorPresetSelectionAttempt = {
      operationId: nextTranslatorPresetStructuralOperationId++,
      previousSelectedPresetId,
      attemptedPresetId: presetId,
    }
    const applied = updateTranslatorPresetOwnerState((draft) => {
      const matches = draft.translatorPresets.filter((preset) => preset.id === presetId)
      if (matches.length !== 1) return false
      draft.translatorPresetId = presetId
    })

    if (applied) registerPendingTranslatorPresetStructuralMutation({ kind: 'select', attempt })
    return applied ? attempt : null
  }

  function rollbackOptimisticTranslatorPresetSelection(attempt: TranslatorPresetSelectionAttempt): void {
    absorbUnreconciledTranslatorPresetProjectionEpochs()
    removePendingTranslatorPresetStructuralMutation(attempt.operationId)
    markSettingsGroupAcknowledgementTainted('language')

    updateTranslatorPresetOwnerState((draft) => {
      const presets = draft.translatorPresets
      const selectedPresetId = draft.translatorPresetId
      if (selectedPresetId !== attempt.attemptedPresetId) return

      const confirmedPresetId = confirmedSelectedTranslatorPresetId()
      if (confirmedPresetId === attempt.attemptedPresetId) return
      const confirmedSelectedPresetIndex = confirmedPresetId
        ? presets.findIndex((preset) => preset.id === confirmedPresetId)
        : -1
      if (confirmedSelectedPresetIndex === -1) return

      draft.translatorPresetId = confirmedPresetId
    })
    reassertPendingTranslatorPresetStructuralMutations()
  }

  function dispatchSelectTranslatorPreset(
    presetId: string,
    previousSelectedPresetId: string | null,
    rollback?: () => void,
    captureOutbox?: (outbox: PendingMutationHandle) => void,
  ): Promise<ServerCommandResult> {
    if (!canUseServerCommands()) return Promise.resolve({ status: 'unavailable' })
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/translator-presets/select',
          body: { presetId },
        },
      ],
      dependencyKeys: translatorPresetOwnerDependencyKeys(previousSelectedPresetId, presetId),
    }
    const outbox = stagePendingMutation(TRANSLATOR_PRESET_SELECTION_MUTATION_KEY, intent)
    captureOutbox?.(outbox)
    return dispatchDurableMutation(outbox, intent, (transport) =>
      runTranslatorPresetCommand(
        (baseRevision) =>
          selectTranslatorPresetCommand({
            baseRevision,
            presetId,
          }),
        rollback,
        transport,
      ),
    )
  }

  async function dispatchOptimisticTranslatorPresetSelection(
    attempt: TranslatorPresetSelectionAttempt,
    feedbackOperationId: number,
  ): Promise<TranslatorPresetPersistenceStatus> {
    let selectOutbox: PendingMutationHandle | null = null
    let stopFinalSettlement = () => {}
    let result: ServerCommandResult
    try {
      result = await dispatchSelectTranslatorPreset(
        attempt.attemptedPresetId,
        attempt.previousSelectedPresetId,
        () => rollbackOptimisticTranslatorPresetSelection(attempt),
        (outbox) => {
          selectOutbox = outbox
          stopFinalSettlement = trackTranslatorPresetFinalSettlement(outbox, feedbackOperationId, {
            accepted: () => {
              removePendingTranslatorPresetStructuralMutation(attempt.operationId)
              confirmedTranslatorPresetSelectionId = attempt.attemptedPresetId
            },
            discarded: () => {
              if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
                rollbackOptimisticTranslatorPresetSelection(attempt)
              }
            },
          })
        },
      )
    } catch (error) {
      console.error('Translator preset selection command rejected:', error)
      const retained = await isTranslatorPresetMutationRetained(selectOutbox)
      if (retained) {
        if (!hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
          registerPendingTranslatorPresetStructuralMutation({ kind: 'select', attempt })
        }
        reassertPendingTranslatorPresetStructuralMutations()
        return 'queued'
      }
      stopFinalSettlement()
      if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
        rollbackOptimisticTranslatorPresetSelection(attempt)
      }
      return 'failed'
    }
    if (result.status !== 'ok') {
      const retained = await isTranslatorPresetMutationRetained(selectOutbox)
      if (retained) {
        if (!hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
          registerPendingTranslatorPresetStructuralMutation({ kind: 'select', attempt })
        }
        reassertPendingTranslatorPresetStructuralMutations()
        return 'queued'
      }
      stopFinalSettlement()
      if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
        rollbackOptimisticTranslatorPresetSelection(attempt)
      }
      return 'failed'
    }
    stopFinalSettlement()
    removePendingTranslatorPresetStructuralMutation(attempt.operationId)
    confirmedTranslatorPresetSelectionId = attempt.attemptedPresetId
    return 'accepted'
  }

  function applyOptimisticTranslatorPresetDelete(
    presetId: string,
    latestOptimisticPreset?: TranslatorPreset,
  ): TranslatorPresetDeleteAttempt | null {
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('translatorPresets')
    confirmedSelectedTranslatorPresetId()
    let attempt: TranslatorPresetDeleteAttempt | null = null

    updateTranslatorPresetOwnerState((draft) => {
      const presets = draft.translatorPresets
      const previousIndex = presets.findIndex((preset) => preset.id === presetId)
      const selectedPresetId = draft.translatorPresetId
      if (previousIndex === -1 || presets.length <= 1 || selectedPresetId !== presetId) return

      const currentPreset = presets[previousIndex]
      const deletedPreset = cloneJsonValue(
        latestOptimisticPreset && isCanonicalTranslatorPreset(latestOptimisticPreset, presetId)
          ? latestOptimisticPreset
          : currentPreset,
      )
      if (!deletedPreset.id) return
      const nextPresets = [...presets]
      nextPresets.splice(previousIndex, 1)
      const attemptedSelectedPreset = nextPresets[0]
      if (!attemptedSelectedPreset?.id) return

      draft.translatorPresets = nextPresets
      draft.translatorPresetId = attemptedSelectedPreset.id
      attempt = {
        operationId: nextTranslatorPresetStructuralOperationId++,
        deletedPreset: deletedPreset as TranslatorPreset & { id: string },
        previousIndex,
        previousSiblingPresetId: presets[previousIndex - 1]?.id ?? null,
        nextSiblingPresetId: presets[previousIndex + 1]?.id ?? null,
        attemptedSelectedPreset: cloneJsonValue(attemptedSelectedPreset) as TranslatorPreset & { id: string },
        collectionProjectionEpoch,
      }
    })

    if (attempt) registerPendingTranslatorPresetStructuralMutation({ kind: 'delete', attempt })
    return attempt
  }

  function rollbackOptimisticTranslatorPresetDelete(attempt: TranslatorPresetDeleteAttempt): void {
    absorbUnreconciledTranslatorPresetProjectionEpochs()
    removePendingTranslatorPresetStructuralMutation(attempt.operationId)
    markCollectionAcknowledgementTainted('translatorPresets')
    markSettingsGroupAcknowledgementTainted('language')

    if (
      translatorPresetCreateOutcomesById.get(attempt.deletedPreset.id) === 'failed' &&
      !confirmedTranslatorPresetCollection?.some((preset) => preset.id === attempt.deletedPreset.id)
    ) {
      reassertPendingTranslatorPresetStructuralMutations()
      return
    }
    if (
      hasCollectionProjectionEpochChanged('translatorPresets', attempt.collectionProjectionEpoch) &&
      !confirmedTranslatorPresetCollection?.some((preset) => preset.id === attempt.deletedPreset.id)
    ) {
      reassertPendingTranslatorPresetStructuralMutations()
      return
    }

    const authoritativePreset = hasCollectionProjectionEpochChanged(
      'translatorPresets',
      attempt.collectionProjectionEpoch,
    )
      ? confirmedTranslatorPresetCollection?.find((preset) => preset.id === attempt.deletedPreset.id)
      : undefined
    const restoredPreset = cloneJsonValue(authoritativePreset ?? attempt.deletedPreset)

    updateTranslatorPresetOwnerState((draft) => {
      const presets = draft.translatorPresets
      const selectedPresetId = draft.translatorPresetId
      const selectedProjectionMatchesAttempt = selectedPresetId === attempt.attemptedSelectedPreset.id

      const nextPresets = [...presets]
      if (!nextPresets.some((preset) => preset.id === attempt.deletedPreset.id)) {
        nextPresets.splice(
          translatorPresetRollbackInsertionIndex(nextPresets, attempt),
          0,
          cloneJsonValue(restoredPreset),
        )
      }

      draft.translatorPresets = nextPresets
      if (selectedProjectionMatchesAttempt) {
        const confirmedPresetId = confirmedSelectedTranslatorPresetId()
        const confirmedSelectedPresetIndex = confirmedPresetId
          ? nextPresets.findIndex((preset) => preset.id === confirmedPresetId)
          : -1
        if (confirmedSelectedPresetIndex !== -1 && confirmedPresetId) draft.translatorPresetId = confirmedPresetId
        return
      }

      const preservedSelectedPresetIndex = nextPresets.findIndex((preset) => preset.id === selectedPresetId)
      if (preservedSelectedPresetIndex !== -1) {
        draft.translatorPresetId = selectedPresetId
        return
      }

      const confirmedPresetId = confirmedSelectedTranslatorPresetId()
      const confirmedSelectedPresetIndex = confirmedPresetId
        ? nextPresets.findIndex((preset) => preset.id === confirmedPresetId)
        : -1
      if (confirmedSelectedPresetIndex !== -1 && confirmedPresetId) draft.translatorPresetId = confirmedPresetId
      else if (nextPresets[0]?.id) draft.translatorPresetId = nextPresets[0].id
      else return false
    })
    if (!authoritativePreset) {
      const confirmedPreset = confirmedTranslatorPresetCollection?.find((preset) => preset.id === restoredPreset.id)
      if (confirmedPreset) {
        const restoredDirtyPatch: TranslatorPresetSnapshot = {}
        for (const field of translatorPresetDirtyFieldNames) {
          if (snapshotJson(confirmedPreset[field]) !== snapshotJson(restoredPreset[field])) {
            restoredDirtyPatch[field] = cloneJsonValue(restoredPreset[field]) as never
          }
        }
        markTranslatorPresetDirtyFields(restoredPreset.id!, restoredDirtyPatch)
      }
    }
    reassertPendingTranslatorPresetStructuralMutations()
    if (!currentSelectedTranslatorPresetId()) {
      updateTranslatorPresetOwnerState((draft) => {
        const presets = draft.translatorPresets
        if (presets.some((preset) => preset.id === attempt.deletedPreset.id)) {
          draft.translatorPresetId = attempt.deletedPreset.id
        } else if (presets[0]?.id) {
          draft.translatorPresetId = presets[0].id
        }
      })
    }
  }

  function dispatchDeleteTranslatorPreset(
    presetId: string,
    selectPresetId: string | undefined,
    rollback?: () => void,
  ): Promise<ServerCommandResult> {
    return runTranslatorPresetCommand(
      (baseRevision) =>
        deleteTranslatorPresetCommand({
          baseRevision,
          presetId,
          selectPresetId,
        }),
      rollback,
    )
  }

  function translatorPresetDeleteDurableIntent(
    presetId: string,
    selectPresetId: string | undefined,
  ): DurableMutationIntent {
    return {
      version: 1,
      requests: [
        {
          method: 'DELETE',
          path: `/translator-presets/${encodeURIComponent(presetId)}`,
          body: selectPresetId ? { selectPresetId } : {},
        },
      ],
      dependencyKeys: [translatorPresetOwnerMutationKey(presetId)],
    }
  }

  function dispatchDurableDeleteTranslatorPreset(
    presetId: string,
    selectPresetId: string | undefined,
    rollback: () => void,
    captureOutbox?: (outbox: PendingMutationHandle) => void,
  ): Promise<ServerCommandResult> {
    const intent = translatorPresetDeleteDurableIntent(presetId, selectPresetId)
    const outbox = stagePendingMutation(TRANSLATOR_PRESET_SELECTION_MUTATION_KEY, intent)
    captureOutbox?.(outbox)
    return dispatchDurableMutation(outbox, intent, (transport) =>
      runServerCommand({
        command: (baseRevision) =>
          deleteTranslatorPresetCommand({
            baseRevision,
            presetId,
            selectPresetId,
          }),
        rollback,
        ...transport,
      }),
    )
  }

  async function deleteTranslatorPresetOptimistically(
    presetId: string,
    latestOptimisticPreset: TranslatorPreset | undefined,
    feedbackOperationId: number,
  ): Promise<TranslatorPresetPersistenceStatus> {
    const attempt = applyOptimisticTranslatorPresetDelete(presetId, latestOptimisticPreset)
    if (!attempt) return 'failed'
    let deleteOutbox: PendingMutationHandle | null = null
    let stopFinalSettlement = () => {}
    let result: ServerCommandResult
    try {
      result = await dispatchDurableDeleteTranslatorPreset(
        presetId,
        attempt.attemptedSelectedPreset.id,
        () => rollbackOptimisticTranslatorPresetDelete(attempt),
        (outbox) => {
          deleteOutbox = outbox
          stopFinalSettlement = trackTranslatorPresetFinalSettlement(outbox, feedbackOperationId, {
            accepted: () => {
              removePendingTranslatorPresetStructuralMutation(attempt.operationId)
              settleConfirmedTranslatorPresetDelete(attempt)
            },
            discarded: () => {
              if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
                rollbackOptimisticTranslatorPresetDelete(attempt)
              }
            },
          })
        },
      )
    } catch (error) {
      console.error('Translator preset delete command rejected:', error)
      const retained = await isTranslatorPresetMutationRetained(deleteOutbox)
      if (retained) {
        if (!hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
          registerPendingTranslatorPresetStructuralMutation({ kind: 'delete', attempt })
        }
        reassertPendingTranslatorPresetStructuralMutations()
        return 'queued'
      }
      stopFinalSettlement()
      if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
        rollbackOptimisticTranslatorPresetDelete(attempt)
      }
      return 'failed'
    }
    if (result.status !== 'ok') {
      const retained = await isTranslatorPresetMutationRetained(deleteOutbox)
      if (retained) {
        if (!hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
          registerPendingTranslatorPresetStructuralMutation({ kind: 'delete', attempt })
        }
        reassertPendingTranslatorPresetStructuralMutations()
        return 'queued'
      }
      stopFinalSettlement()
      if (hasPendingTranslatorPresetStructuralMutation(attempt.operationId)) {
        rollbackOptimisticTranslatorPresetDelete(attempt)
      }
      return 'failed'
    }
    stopFinalSettlement()
    removePendingTranslatorPresetStructuralMutation(attempt.operationId)
    settleConfirmedTranslatorPresetDelete(attempt)
    return 'accepted'
  }

  function dispatchPendingTranslatorPresetUpdate(
    pending: PendingTranslatorPresetUpdate,
    options: ServerCommandTransportOptions = {},
  ): Promise<ServerCommandResult> {
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    pendingTranslatorPresetUpdates.delete(pending.presetId)

    const commandPresetId = pending.presetId
    const commandPatch = pending.patch
    const commandPrevious = pending.previous
    const commandAttempted = pending.attempted
    const commandIntent = pending.intent
    const commandOutbox = pending.outbox
    const commandFields = translatorPresetPatchDirtyFields(commandPatch)
    if (!commandIntent || !commandOutbox || commandFields.length === 0) {
      if (commandOutbox) void acknowledgePendingMutation(commandOutbox)
      return Promise.resolve({ status: 'unavailable' })
    }
    const currentPreset = currentTranslatorPresetById(commandPresetId)
    if (!currentPreset || !isCanonicalTranslatorPreset(currentPreset, commandPresetId)) {
      void acknowledgePendingMutation(commandOutbox)
      translatorPresetDirtyFieldsById.delete(commandPresetId)
      translatorPresetRollbackBaselinesById.delete(commandPresetId)
      return Promise.resolve({ status: 'unavailable' })
    }
    const optimisticAcknowledgement = translatorPresetPatchOptimisticAcknowledgement(pending)
    markTranslatorPresetFieldsUnsettled(commandPresetId, commandFields)
    const feedbackOperationId = nextTranslatorPresetFeedbackOperationId++
    activeTranslatorPresetFeedbackOperationId = feedbackOperationId
    translatorPresetPersistenceState = 'saving'

    let rollbackRan = false
    const rollback = () => {
      if (rollbackRan) return
      rollbackRan = true
      markCollectionAcknowledgementTainted('translatorPresets')
      markSettingsGroupAcknowledgementTainted('language')
      restoreTranslatorPresetUpdateState(commandPresetId, commandPrevious, commandAttempted, commandPatch)
    }
    let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
    const dispatch = () =>
      dispatchDurableMutation(commandOutbox, commandIntent, (transport) => {
        failureRollbackDisposition = transport.failureRollbackDisposition
        return runServerCommand({
          command: (baseRevision) =>
            updateTranslatorPresetCommand(
              {
                baseRevision,
                presetId: commandPresetId,
                patch: commandPatch,
                optimisticAcknowledgement,
              },
              options.signal,
              options.keepalive,
            ),
          rollback,
          ...options,
          ...transport,
        })
      })

    let finalSettlementHandled = false
    const settleAcceptedFields = () => {
      if (finalSettlementHandled) return
      finalSettlementHandled = true
      advanceTranslatorPresetRollbackBaselines(commandPresetId, commandAttempted, commandFields)
      clearTranslatorPresetFieldsUnsettled(commandPresetId, commandFields)
    }
    const settleDiscardedFields = () => {
      if (finalSettlementHandled) return
      finalSettlementHandled = true
      rollback()
      clearTranslatorPresetFieldsUnsettled(commandPresetId, commandFields)
    }
    const stopFinalSettlement = trackTranslatorPresetFinalSettlement(commandOutbox, feedbackOperationId, {
      accepted: settleAcceptedFields,
      discarded: settleDiscardedFields,
    })
    const settleImmediateAccepted = () => {
      stopFinalSettlement()
      settleAcceptedFields()
      if (activeTranslatorPresetFeedbackOperationId === feedbackOperationId) {
        translatorPresetPersistenceState = 'idle'
      }
    }
    const settleImmediateFailed = () => {
      const settlementWasHandled = finalSettlementHandled
      stopFinalSettlement()
      settleDiscardedFields()
      if (!settlementWasHandled) settleTranslatorPresetPersistenceFeedback(feedbackOperationId, 'discarded')
    }
    const retainForReplay = () => {
      if (activeTranslatorPresetFeedbackOperationId === feedbackOperationId) {
        translatorPresetPersistenceState = 'queued'
      }
      alertNormal(language.translatorPresetPersistence.queued)
    }

    const dispatchAndSettle = async () => {
      let result: ServerCommandResult
      try {
        result = await dispatch()
      } catch (error) {
        console.error('Translator preset update command rejected:', error)
        result = { status: 'unavailable' }
      }
      if (result.status === 'ok') {
        settleImmediateAccepted()
      } else if (failureRollbackDisposition?.(result) === 'retain') {
        retainForReplay()
      } else {
        settleImmediateFailed()
      }
      return result
    }

    translatorPresetUpdateDispatchChain = translatorPresetUpdateDispatchChain.then(dispatchAndSettle, dispatchAndSettle)
    return translatorPresetUpdateDispatchChain
  }

  async function flushPendingTranslatorPresetUpdates(options: ServerCommandTransportOptions = {}): Promise<void> {
    if (!canUseServerCommands()) return
    for (const pending of Array.from(pendingTranslatorPresetUpdates.values())) {
      void dispatchPendingTranslatorPresetUpdate(pending, options)
    }
    await translatorPresetUpdateDispatchChain
  }

  function queueTranslatorPresetUpdate(
    presetId: string,
    patch: TranslatorPresetSnapshot,
    previous: TranslatorPresetStateSnapshot | null,
  ): void {
    if (!canUseServerCommands()) return

    const pending = pendingTranslatorPresetUpdates.get(presetId) ?? {
      timer: null,
      presetId,
      patch: {},
      previous: {},
      attempted: {},
      durableAttempted: {},
      collectionProjectionEpoch: captureCollectionProjectionEpoch('translatorPresets'),
      languageSettingsProjectionEpoch: captureSettingsGroupProjectionEpoch('language'),
      selectedPresetId: selectedTranslatorPresetId(),
      intent: null,
      outbox: null,
    }
    const previousPreset = translatorPresetFromSnapshot(previous, presetId)
    const currentPreset = currentTranslatorPresetById(presetId)
    if (
      !previousPreset ||
      !currentPreset ||
      !isCanonicalTranslatorPreset(previousPreset, presetId) ||
      !isCanonicalTranslatorPreset(currentPreset, presetId)
    ) {
      cancelPendingTranslatorPresetUpdates(presetId)
      return
    }
    if (!isValidTranslatorPresetPatch(patch)) return
    const pendingPatch = pending.patch as Record<string, unknown>
    const pendingPrevious = pending.previous as Record<string, unknown>
    const pendingAttempted = pending.attempted as Record<string, unknown>
    const pendingDurableAttempted = pending.durableAttempted as Record<string, unknown>
    let rollbackBaselines = translatorPresetRollbackBaselinesById.get(presetId)

    for (const field of translatorPresetPatchDirtyFields(patch)) {
      if (!rollbackBaselines) {
        rollbackBaselines = new Map()
        translatorPresetRollbackBaselinesById.set(presetId, rollbackBaselines)
      }
      if (!rollbackBaselines.has(field)) {
        rollbackBaselines.set(field, cloneJsonValue(previousPreset?.[field]))
      }
      if (!(field in pendingPrevious)) {
        pendingPrevious[field] = cloneJsonValue(previousPreset?.[field])
        if (pending.outbox && !(field in pendingDurableAttempted)) {
          pendingDurableAttempted[field] = cloneJsonValue(previousPreset?.[field])
        }
      }

      const attemptedValue = cloneJsonValue(patch[field])
      pendingAttempted[field] = attemptedValue
      if (snapshotJson(attemptedValue) === snapshotJson(pendingPrevious[field])) {
        if (!isTranslatorPresetFieldUnsettled(presetId, field)) {
          clearTranslatorPresetDirtyFieldsMatchingValues(presetId, { [field]: attemptedValue }, [field])
        }
      }
    }

    const netChangedFields = changedTranslatorPresetPatchFields(pending.previous, pending.attempted)
    const changedFromDurableFields = pending.outbox
      ? changedTranslatorPresetPatchFields(pending.durableAttempted, pending.attempted)
      : new Set<TranslatorPresetDirtyField>()
    const closureFields = new Set<TranslatorPresetDirtyField>([
      ...translatorPresetPatchDirtyFields(pending.patch),
      ...netChangedFields,
      ...changedFromDurableFields,
    ])
    for (const field of translatorPresetDirtyFieldNames) {
      if (closureFields.has(field)) pendingPatch[field] = cloneJsonValue(pendingAttempted[field])
      else delete pendingPatch[field]
    }

    if (pending.timer) clearTimeout(pending.timer)
    if (translatorPresetPatchDirtyFields(pending.patch).length === 0) {
      if (pending.outbox) void acknowledgePendingMutation(pending.outbox)
      pending.intent = null
      pending.outbox = null
      pending.timer = null
      pendingTranslatorPresetUpdates.delete(presetId)
      return
    }

    pending.intent = translatorPresetUpdateDurableIntent(presetId, pending.patch)
    pending.outbox = stagePendingMutation(translatorPresetOwnerMutationKey(presetId), pending.intent, pending.outbox)
    pending.durableAttempted = cloneJsonValue(pending.attempted)

    pendingTranslatorPresetUpdates.set(presetId, pending)
    if (netChangedFields.size === 0 && changedFromDurableFields.size > 0) {
      void dispatchPendingTranslatorPresetUpdate(pending)
      return
    }
    pending.timer = setTimeout(() => {
      void dispatchPendingTranslatorPresetUpdate(pending)
    }, translatorPresetUpdateDelayMs)
  }

  function changedTranslatorPresetPatchFields(
    left: TranslatorPresetSnapshot,
    right: TranslatorPresetSnapshot,
  ): Set<TranslatorPresetDirtyField> {
    const changed = new Set<TranslatorPresetDirtyField>()
    for (const field of translatorPresetDirtyFieldNames) {
      const leftPresent = Object.prototype.hasOwnProperty.call(left, field)
      const rightPresent = Object.prototype.hasOwnProperty.call(right, field)
      if (leftPresent !== rightPresent || snapshotJson(left[field]) !== snapshotJson(right[field])) {
        changed.add(field)
      }
    }
    return changed
  }

  function isCanonicalTranslatorPreset(preset: TranslatorPreset, presetId: string): boolean {
    return (
      preset.id === presetId &&
      presetId.trim().length > 0 &&
      typeof preset.name === 'string' &&
      typeof preset.prompt === 'string' &&
      typeof preset.maxResponse === 'number' &&
      Number.isFinite(preset.maxResponse) &&
      (!('steps' in preset) ||
        (Array.isArray(preset.steps) && snapshotJson(preset) === snapshotJson(normalizeTranslatorPreset(preset))))
    )
  }

  function isValidTranslatorPresetPatch(patch: TranslatorPresetSnapshot): boolean {
    const fields = translatorPresetPatchDirtyFields(patch)
    return (
      fields.length > 0 &&
      fields.length === Object.keys(patch).length &&
      fields.every((field) => {
        const value = patch[field]
        if (field === 'maxResponse') return typeof value === 'number' && Number.isFinite(value)
        if (field === 'steps')
          return Array.isArray(value) && value.length > 0 && value.length <= TRANSLATOR_PRESET_MAX_STEPS
        return typeof value === 'string'
      })
    )
  }

  function translatorPresetUpdateDurableIntent(
    presetId: string,
    patch: TranslatorPresetSnapshot,
  ): DurableMutationIntent {
    return {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: `/translator-presets/${encodeURIComponent(presetId)}`,
          body: { patch: cloneJsonValue(patch) },
        },
      ],
      dependencyKeys: [TRANSLATOR_PRESET_SELECTION_MUTATION_KEY],
    }
  }

  function translatorPresetStepsForDisplay(preset: TranslatorPreset): TranslatorPresetStep[] {
    return Array.isArray(preset.steps) && preset.steps.length > 0
      ? preset.steps
      : normalizeTranslatorPreset(preset).steps
  }

  function updateTranslatorPresetSteps(
    preset: TranslatorPreset,
    update: (steps: TranslatorPresetStep[]) => TranslatorPresetStep[],
  ): void {
    const presetId = preset.id
    if (!presetId) return
    const previous = currentTranslatorPresetStateSnapshot()
    const currentPreset = currentTranslatorPresetById(presetId)
    if (!currentPreset) return
    const normalized = normalizeTranslatorPreset({
      ...currentPreset,
      steps: update(cloneJsonValue(translatorPresetStepsForDisplay(currentPreset))),
    })
    const patch: TranslatorPresetSnapshot = {
      steps: normalized.steps,
      prompt: normalized.prompt,
      maxResponse: normalized.maxResponse,
    }

    if (!canUseServerCommands()) {
      applyTranslatorPresetPatchToDatabase(presetId, patch)
    } else {
      markTranslatorPresetDirtyFields(presetId, patch)
      applyTranslatorPresetPatchToDatabase(presetId, patch)
    }
    queueTranslatorPresetUpdate(presetId, patch, previous)
  }

  function updateTranslatorPresetStep(
    preset: TranslatorPreset,
    stepIndex: number,
    patch: Partial<TranslatorPresetStep>,
  ): void {
    updateTranslatorPresetSteps(preset, (steps) => {
      if (!steps[stepIndex]) return steps
      steps[stepIndex] = { ...steps[stepIndex], ...patch }
      return steps
    })
  }

  function createTranslatorPresetStep(index: number, source?: TranslatorPresetStep): TranslatorPresetStep {
    return normalizeTranslatorPreset({
      name: 'Step',
      steps: [
        {
          ...(source ?? {}),
          id: createNonSecurityUuid(),
          name: source ? `${source.name} ${language.translatorPipeline.copySuffix}` : `Step ${index + 1}`,
          outputKey: undefined,
        },
      ],
    }).steps[0]
  }

  function moveTranslatorPresetStep(preset: TranslatorPreset, from: number, to: number): void {
    updateTranslatorPresetSteps(preset, (steps) => {
      if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return steps
      const [step] = steps.splice(from, 1)
      steps.splice(to, 0, step)
      return steps
    })
  }

  function outputKeyDraftValue(step: TranslatorPresetStep): string {
    return Object.prototype.hasOwnProperty.call(stepOutputKeyDrafts, step.id)
      ? stepOutputKeyDrafts[step.id]
      : (step.outputKey ?? '')
  }

  function outputKeyIsValid(preset: TranslatorPreset, stepIndex: number, value: string): boolean {
    const trimmed = value.trim()
    if (!trimmed) return true
    if (!isValidTranslatorPresetOutputKey(trimmed)) return false
    return !translatorPresetStepsForDisplay(preset).some(
      (step, index) => index !== stepIndex && outputKeyDraftValue(step).trim() === trimmed,
    )
  }

  function setTranslatorPresetStepOutputKey(
    preset: TranslatorPreset,
    step: TranslatorPresetStep,
    stepIndex: number,
    value: string,
  ): void {
    stepOutputKeyDrafts = { ...stepOutputKeyDrafts, [step.id]: value }
    if (!outputKeyIsValid(preset, stepIndex, value)) return
    const outputKey = value.trim()
    updateTranslatorPresetStep(preset, stepIndex, { outputKey: outputKey || undefined })
  }

  $effect(() => {
    void collectionsResourceState.values.translatorPresets
    void collectionsResourceState.statuses.translatorPresets
    void settingsResourceState.value.translatorPresetId
    void settingsResourceState.groupStatuses.language
    const translatorPresetCollectionProjectionEpoch = captureCollectionProjectionEpoch('translatorPresets')
    const collectionProjectionChanged =
      translatorPresetCollectionProjectionEpoch !== previousTranslatorPresetCollectionProjectionEpoch
    previousTranslatorPresetCollectionProjectionEpoch = translatorPresetCollectionProjectionEpoch
    const languageSettingsProjectionEpoch = captureSettingsGroupProjectionEpoch('language')
    const languageProjectionChanged = languageSettingsProjectionEpoch !== previousLanguageSettingsProjectionEpoch
    previousLanguageSettingsProjectionEpoch = languageSettingsProjectionEpoch
    untrack(() => {
      if (!collectionProjectionChanged && !languageProjectionChanged) return
      const authoritativePresetIds = collectionProjectionChanged
        ? new Set((currentTranslatorPresetCollectionOwner() ?? []).map((preset) => preset.id!))
        : null
      if (collectionProjectionChanged) {
        confirmedTranslatorPresetCollection = cloneJsonValue(currentTranslatorPresetCollectionOwner() ?? [])
      }
      if (languageProjectionChanged) {
        confirmedTranslatorPresetSelectionId = projectedSelectedTranslatorPresetId()
      } else if (pendingTranslatorPresetStructuralMutations.length === 0) {
        confirmedTranslatorPresetSelectionId = currentSelectedTranslatorPresetId()
      }
      reassertPendingTranslatorPresetStructuralMutations()
      if (authoritativePresetIds) reconcileTranslatorPresetProjectionEpoch(authoritativePresetIds)
      else reassertAllDirtyTranslatorPresetFields()
    })
  })

  const unregisterPendingTranslatorPresetFlush = registerPendingOwnerMutationFlusher(
    `translator-preset-settings:${nextTranslatorPresetFlushId++}`,
    (options) => {
      void flushPendingTranslatorPresetUpdates(options)
    },
  )

  onDestroy(() => {
    unsubscribeLocalEffectApplied()
    unregisterPendingTranslatorPresetFlush()
    void flushPendingTranslatorPresetUpdates()
  })

  onDestroy(
    registerWriterDraftCapture(() => {
      const presets = currentTranslatorPresetCollectionOwner() ?? []
      const drafts = presets.flatMap((preset) => {
        const outputKeys = Object.fromEntries(
          translatorPresetStepsForDisplay(preset).flatMap((step) =>
            Object.prototype.hasOwnProperty.call(stepOutputKeyDrafts, step.id) &&
            stepOutputKeyDrafts[step.id] !== (step.outputKey ?? '')
              ? [[step.id, stepOutputKeyDrafts[step.id]]]
              : [],
          ),
        )
        const dirty = !!preset.id && (translatorPresetDirtyFieldsById.get(preset.id)?.size ?? 0) > 0
        const pendingCreate = pendingTranslatorPresetStructuralMutations.some(
          (pending) => pending.kind === 'create' && pending.attempt.draftPreset.id === preset.id,
        )
        if (!dirty && !pendingCreate && Object.keys(outputKeys).length === 0) return []
        return [
          {
            preset,
            outputKeys,
            baseline: Object.fromEntries(translatorPresetRollbackBaselinesById.get(preset.id!) ?? []),
          },
        ]
      })
      if (drafts.length === 0) return null
      return $state.snapshot({
        key: 'translator-presets:editor',
        label: drafts[0].preset.name,
        fields: drafts.map((draft) => ({ label: draft.preset.name, value: JSON.stringify(draft, null, 2) })),
        data: { drafts },
        baseline: drafts.map(({ preset, baseline }) => ({ presetId: preset.id, ...baseline })),
      })
    }),
  )
</script>

<span class="text-textcolor mt-4">Preset</span>
<select
  aria-label="Preset"
  aria-busy={translatorPresetPersistenceState === 'saving'}
  class={'border border-darkborderc focus:border-borderc rounded-md shadow-xs text-textcolor bg-transparent focus:ring-borderc focus:ring-2 focus:outline-hidden transition-colors duration-200 text-md px-4 py-2 mb-1'}
  bind:value={
    () => currentSelectedTranslatorPresetId() ?? '',
    (value) => {
      const presetId = typeof value === 'string' && value.trim() ? value : null
      if (!canUseServerCommands()) {
        if (presetId) dispatchSelectTranslatorPreset(presetId, null)
      } else if (presetId) {
        const attempt = applyOptimisticTranslatorPresetSelection(presetId)
        if (!attempt) return
        void runTranslatorPresetPersistenceAction(async (feedbackOperationId) => {
          try {
            await flushPendingTranslatorPresetUpdates()
          } finally {
            return dispatchOptimisticTranslatorPresetSelection(attempt, feedbackOperationId)
          }
        })
      }
    }
  }>
  {#each currentTranslatorPresetCollectionOwner() ?? [] as preset (preset.id)}
    <option class="bg-darkbg appearance-none" value={preset.id}>{preset.name}</option>
  {/each}
</select>

<div class="flex items-center mb-4">
  <button
    type="button"
    aria-label={`${language.add}: ${language.presets}`}
    aria-busy={translatorPresetPersistenceState === 'saving'}
    class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
    onclick={async () => {
      const newPreset = createTranslatorPreset()
      newPreset.id = createClientTranslatorPresetId()
      if (!canUseServerCommands()) {
        await flushPendingTranslatorPresetUpdates()
        const applied = updateTranslatorPresetOwnerState((draft) => {
          if (!newPreset.id || draft.translatorPresets.some((preset) => preset.id === newPreset.id)) return false
          draft.translatorPresets = [...draft.translatorPresets, newPreset]
          draft.translatorPresetId = newPreset.id
        })
        if (applied) dispatchCreateTranslatorPreset(newPreset, null)
      } else {
        await runTranslatorPresetPersistenceAction(async (feedbackOperationId) => {
          await flushPendingTranslatorPresetUpdates()
          return createTranslatorPresetOptimistically(newPreset, feedbackOperationId)
        })
      }
    }}>
    <PlusIcon size={24} />
  </button>

  <button
    type="button"
    aria-label={`${language.edit}: ${currentSelectedTranslatorPreset()?.name ?? language.presets}`}
    class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
    onclick={async () => {
      const presets = currentTranslatorPresetCollectionOwner() ?? []

      if (presets.length === 0) {
        alertError('There must be at least one preset.')
        return
      }

      const preset = currentSelectedTranslatorPreset()
      if (!preset) return
      const presetId = preset?.id
      if (!presetId) return
      const newName = await alertInput(`Enter new name for ${preset.name}`, [], preset.name)

      if (!newName || newName.trim().length === 0) return

      const targetPreset = currentTranslatorPresetById(presetId)
      if (!targetPreset) return
      const previous = currentTranslatorPresetStateSnapshot()
      if (!canUseServerCommands()) {
        applyTranslatorPresetPatchToDatabase(presetId, { name: newName })
      } else {
        markTranslatorPresetDirtyFields(presetId, { name: newName })
        applyTranslatorPresetPatchToDatabase(presetId, { name: newName })
      }
      queueTranslatorPresetUpdate(presetId, { name: newName }, previous)
    }}>
    <PencilIcon size={24} />
  </button>

  <button
    type="button"
    aria-label={`${language.remove}: ${currentSelectedTranslatorPreset()?.name ?? language.presets}`}
    aria-busy={translatorPresetPersistenceState === 'saving'}
    class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
    onclick={async () => {
      const presets = currentTranslatorPresetCollectionOwner() ?? []

      if (presets.length <= 1) {
        alertError('There must be at least one preset.')
        return
      }

      const preset = currentSelectedTranslatorPreset()
      if (!preset) return
      const id = presets.findIndex((candidate) => candidate.id === preset.id)
      const confirmed = await alertConfirm(`${language.removeConfirm}${preset.name}`)

      if (!confirmed) return

      const presetId = preset.id
      const latestOptimisticPreset = presetId ? cloneJsonValue(currentTranslatorPresetById(presetId) ?? preset) : null
      if (!canUseServerCommands()) {
        await flushPendingTranslatorPresetUpdates()
        const nextSelectedPresetId = presets.find((candidate) => candidate.id !== presetId)?.id
        const applied = updateTranslatorPresetOwnerState((draft) => {
          if (!nextSelectedPresetId) return false
          draft.translatorPresets.splice(id, 1)
          draft.translatorPresetId = nextSelectedPresetId
        })
        const selectPresetId = currentSelectedTranslatorPresetId()
        if (applied && presetId) {
          dispatchDeleteTranslatorPreset(presetId, selectPresetId)
        }
      } else {
        if (presetId) {
          await runTranslatorPresetPersistenceAction(async (feedbackOperationId) => {
            await flushPendingTranslatorPresetUpdates()
            return deleteTranslatorPresetOptimistically(
              presetId,
              latestOptimisticPreset ?? undefined,
              feedbackOperationId,
            )
          })
        }
      }
    }}>
    <TrashIcon size={24} />
  </button>

  <div class="ml-2 mr-4 w-px h-full bg-darkborderc"></div>

  <button
    type="button"
    aria-label={`${language.export}: ${currentSelectedTranslatorPreset()?.name ?? language.presets}`}
    class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
    onclick={async () => {
      try {
        const presets = currentTranslatorPresetCollectionOwner() ?? []

        if (presets.length === 0) {
          alertError('There must be at least one preset.')
          return
        }

        const preset = currentSelectedTranslatorPreset()
        if (!preset) return
        // `.risutl` is an explicit compatibility export snapshot, not a
        // second runtime owner for the selected preset.
        const compatibilityExportSnapshot = cloneJsonValue(preset)
        await downloadFile(
          getTranslatorPresetDownloadName(compatibilityExportSnapshot.name),
          await encodeTranslatorPresetFile(compatibilityExportSnapshot),
        )
        alertNormal(language.successExport)
      } catch (error) {
        alertError(`${error}`)
      }
    }}>
    <DownloadIcon size={24} />
  </button>

  <button
    type="button"
    aria-label={`${language.import}: ${language.presets}`}
    aria-busy={translatorPresetPersistenceState === 'saving'}
    class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
    onclick={async () => {
      try {
        const selectedFile = await selectSingleFile(translatorPresetImportExtensions)

        if (!selectedFile) return

        // File decoding is an explicit compatibility boundary: normalize v1
        // scalar snapshots before admitting them to the canonical collection.
        const newPreset = normalizeTranslatorPreset(await decodeTranslatorPresetFile(selectedFile.data))
        newPreset.id = createClientTranslatorPresetId()
        if (!canUseServerCommands()) {
          await flushPendingTranslatorPresetUpdates()
          const applied = updateTranslatorPresetOwnerState((draft) => {
            if (!newPreset.id || draft.translatorPresets.some((preset) => preset.id === newPreset.id)) return false
            draft.translatorPresets = [...draft.translatorPresets, newPreset]
            draft.translatorPresetId = newPreset.id
          })
          if (!applied) return
          dispatchCreateTranslatorPreset(newPreset, null)
        } else {
          const status = await runTranslatorPresetPersistenceAction(async (feedbackOperationId) => {
            await flushPendingTranslatorPresetUpdates()
            return createTranslatorPresetOptimistically(newPreset, feedbackOperationId)
          })
          if (status !== 'accepted') return
        }

        alertNormal(language.successImport)
      } catch (error) {
        alertError(`${error}`)
      }
    }}>
    <HardDriveUploadIcon size={24} />
  </button>
</div>

{#if translatorPresetPersistenceState === 'failed'}
  <p class="mb-3 text-sm text-draculared" role="status" aria-live="polite" data-translator-preset-persistence>
    {language.translatorPresetPersistence.failed}
  </p>
{/if}

{#if currentSelectedTranslatorPreset()}
  {@const preset = currentSelectedTranslatorPreset()!}
  {@const steps = translatorPresetStepsForDisplay(preset)}
  <div class="mb-2 flex items-center justify-between gap-3">
    <div>
      <span class="text-textcolor">{language.translatorPipeline.steps}</span>
      <p class="text-xs text-textcolor2">{language.translatorPipeline.slotHelp}</p>
    </div>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-md border border-darkborderc px-2 py-1 text-sm text-textcolor2 hover:text-green-500 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={steps.length >= TRANSLATOR_PRESET_MAX_STEPS}
      aria-label={language.translatorPipeline.addStep}
      onclick={() => {
        updateTranslatorPresetSteps(preset, (currentSteps) => [
          ...currentSteps,
          createTranslatorPresetStep(currentSteps.length),
        ])
      }}>
      <PlusIcon size={15} />
      {language.translatorPipeline.addStep}
    </button>
  </div>

  <div class="flex flex-col gap-3">
    {#each steps as step, stepIndex (step.id)}
      <section
        class:border={steps.length > 1}
        class:p-3={steps.length > 1}
        class="rounded-md border-darkborderc"
        data-translator-step={step.id}>
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            class="min-w-40 flex-1 rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
            aria-label={language.translatorPipeline.stepName}
            value={step.name}
            oninput={(event) => updateTranslatorPresetStep(preset, stepIndex, { name: event.currentTarget.value })} />
          <label class="inline-flex items-center gap-1 text-sm text-textcolor2">
            <input
              type="checkbox"
              checked={step.enabled}
              onchange={(event) =>
                updateTranslatorPresetStep(preset, stepIndex, { enabled: event.currentTarget.checked })} />
            {language.translatorPipeline.enabled}
          </label>
          <div class="ml-auto flex items-center gap-1">
            <button
              type="button"
              class="text-textcolor2 hover:text-green-500 disabled:opacity-40"
              disabled={stepIndex === 0}
              aria-label={language.translatorPipeline.moveUp}
              onclick={() => moveTranslatorPresetStep(preset, stepIndex, stepIndex - 1)}>
              <ArrowUpIcon size={17} />
            </button>
            <button
              type="button"
              class="text-textcolor2 hover:text-green-500 disabled:opacity-40"
              disabled={stepIndex === steps.length - 1}
              aria-label={language.translatorPipeline.moveDown}
              onclick={() => moveTranslatorPresetStep(preset, stepIndex, stepIndex + 1)}>
              <ArrowDownIcon size={17} />
            </button>
            <button
              type="button"
              class="text-textcolor2 hover:text-green-500 disabled:opacity-40"
              disabled={steps.length >= TRANSLATOR_PRESET_MAX_STEPS}
              aria-label={language.translatorPipeline.duplicateStep}
              onclick={() => {
                updateTranslatorPresetSteps(preset, (currentSteps) => {
                  currentSteps.splice(stepIndex + 1, 0, createTranslatorPresetStep(stepIndex + 1, step))
                  return currentSteps
                })
              }}>
              <CopyIcon size={17} />
            </button>
            <button
              type="button"
              class="text-textcolor2 hover:text-draculared disabled:opacity-40"
              disabled={steps.length <= 1}
              aria-label={language.translatorPipeline.removeStep}
              onclick={() => {
                if (!confirmSettingsItemRemoval()) return
                updateTranslatorPresetSteps(preset, (currentSteps) =>
                  currentSteps.filter((_candidate, index) => index !== stepIndex),
                )
              }}>
              <TrashIcon size={17} />
            </button>
          </div>
        </div>

        <span class="text-textcolor mt-2">{language.translationResponseSize}</span>
        <NumberInput
          min={0}
          max={2048}
          marginBottom={true}
          ariaLabel={steps.length === 1
            ? language.translationResponseSize
            : `${language.translationResponseSize}: ${step.name}`}
          bind:value={
            () => step.maxResponse,
            (value) => {
              if (typeof value !== 'number' || !Number.isFinite(value)) return
              if (stepIndex > 0) {
                updateTranslatorPresetStep(preset, stepIndex, { maxResponse: value })
                return
              }

              const previous = currentTranslatorPresetStateSnapshot()
              const presetId = selectedTranslatorPresetId()
              if (!canUseServerCommands() && presetId) {
                applyTranslatorPresetPatchToDatabase(presetId, { maxResponse: value })
              } else if (presetId) {
                markTranslatorPresetDirtyFields(presetId, { maxResponse: value })
                applyTranslatorPresetPatchToDatabase(presetId, { maxResponse: value })
              }
              if (presetId) queueTranslatorPresetUpdate(presetId, { maxResponse: value }, previous)
            }
          } />
        <span class="text-textcolor mt-2">
          {language.translatorPrompt}
          <Help key="translatorPrompt" />
        </span>
        <TextAreaInput
          ariaLabel={steps.length === 1 ? language.translatorPrompt : `${language.translatorPrompt}: ${step.name}`}
          bind:value={
            () => step.prompt,
            (value) => {
              if (stepIndex > 0) {
                updateTranslatorPresetStep(preset, stepIndex, { prompt: value })
                return
              }

              const previous = currentTranslatorPresetStateSnapshot()
              const presetId = selectedTranslatorPresetId()
              if (!canUseServerCommands() && presetId) {
                applyTranslatorPresetPatchToDatabase(presetId, { prompt: value })
              } else if (presetId) {
                markTranslatorPresetDirtyFields(presetId, { prompt: value })
                applyTranslatorPresetPatchToDatabase(presetId, { prompt: value })
              }
              if (presetId) queueTranslatorPresetUpdate(presetId, { prompt: value }, previous)
            }
          }
          placeholder={defaultTranslatorPrompt} />
        {#if hasMalformedTranslatorHistorySlot(step.prompt)}
          <span class="text-xs text-draculaorange" role="status" data-translator-history-slot-warning>
            {language.translatorPipeline.malformedHistorySlot}
          </span>
        {/if}

        <div class="mt-3 grid gap-3 md:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm text-textcolor">
            {language.translatorPipeline.model}
            <select
              class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-textcolor focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
              aria-label={`${language.translatorPipeline.model}: ${step.name}`}
              value={step.model.mode === 'modelProfile' ? step.model.profileId : ''}
              onchange={(event) =>
                handleTranslatorStepModelChange(
                  preset,
                  stepIndex,
                  step.model.mode === 'modelProfile' ? step.model.profileId : '',
                  event,
                )}>
              <option value="">{language.translatorPipeline.inheritTranslateModel}</option>
              {#each modelProfileItems as item (`${item.kind}:${item.kind === 'profile' ? item.profile.id : item.id}`)}
                {#if item.kind === 'divider'}
                  <option value={modelProfileDividerSelectValue(item.id)} data-model-profile-divider="true">---</option>
                {:else}
                  <option value={item.profile.id}>{item.profile.name ?? item.profile.id}</option>
                {/if}
              {/each}
            </select>
          </label>
          <label class="flex flex-col gap-1 text-sm text-textcolor">
            {language.translatorPipeline.outputKey}
            <input
              type="text"
              class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-textcolor focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
              aria-label={`${language.translatorPipeline.outputKey}: ${step.name}`}
              value={outputKeyDraftValue(step)}
              placeholder={language.translatorPipeline.outputKeyPlaceholder}
              oninput={(event) =>
                setTranslatorPresetStepOutputKey(preset, step, stepIndex, event.currentTarget.value)} />
            {#if !outputKeyIsValid(preset, stepIndex, outputKeyDraftValue(step))}
              <span class="text-xs text-draculared">{language.translatorPipeline.invalidOutputKey}</span>
            {/if}
          </label>
        </div>
      </section>
    {/each}
  </div>
{/if}
