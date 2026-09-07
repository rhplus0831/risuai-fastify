<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import {
    ArrowDownIcon,
    ArrowUpIcon,
    CheckIcon,
    CopyIcon,
    FilePlusIcon,
    InfoIcon,
    PencilIcon,
    PlusIcon,
    TrashIcon,
  } from '@lucide/svelte'
  import { tick, onDestroy } from 'svelte'
  import { language } from 'src/lang'
  import { alertError, alertNormal } from 'src/ts/alert'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import { createModelRoleBindingPresetSnapshot } from 'src/ts/model/modelPresetSnapshots'
  import { normalizeModelRoleProfiles, type ModelRoleProfileBinding } from 'src/ts/model/modelProfileRecords'
  import { MODEL_ROLES, modelRoleProfileInheritSource, type ModelRole } from '@risuai/shared-core/model-roles'
  import {
    createModelPreset,
    deleteModelPreset,
    reorderModelPresets,
    selectModelPreset,
    updateModelPreset,
    type ModelPreset,
    type PresetMutationOutcome,
    type PromptPreset,
  } from 'src/ts/storage/database.svelte'
  import { collectionsResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import type { ModelProfileRecord } from 'src/ts/model/modelProfileRecords'
  import ModelItemActions from './ModelItemActions.svelte'

  interface Props {
    embedded?: boolean
    afterApply?: () => void
  }

  let { embedded = false, afterApply = () => {} }: Props = $props()
  const id = $props.id()
  const actionClass =
    'flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-darkbg disabled:cursor-not-allowed disabled:opacity-50'

  let newPresetName = $state('')
  let createMode = $state<'current' | 'empty' | null>(null)
  let createNameInput = $state<HTMLInputElement>()
  let createTrigger: HTMLButtonElement | undefined
  let renameKey = $state<string | null>(null)
  let renameDraft = $state('')
  let recoveryRenameBaseline = ''
  let renameInput = $state<HTMLInputElement>()
  let restoreRenameFocus = () => {}
  let detailsKey = $state<string | null>(null)
  let selectionOperation = 0
  let selectionPendingIndex = $state<number | null>(null)
  let selectionError = $state('')
  let rowMutationOperation = 0
  let rowMutationStates = $state<Record<string, { operation: number; status: 'saving' | 'queued' }>>({})
  let rowMutationErrors = $state<Record<string, string>>({})
  let latestRowMutationError = $derived(Object.values(rowMutationErrors).at(-1) ?? '')
  let createMutation = $derived(rowMutationStates['model:create-current'] ?? rowMutationStates['model:create-empty'])

  let presets = $derived(readModelPresetOwners(collectionsResourceState.values.modelPresets))
  let selectedIndex = $derived(selectedOwnerIndex(settingsResourceState.value.modelPresetsId))
  let profiles = $derived(readModelProfileOwners(settingsResourceState.value.modelProfiles))
  let selectedPromptPreset = $derived.by(() => {
    const index = selectedOwnerIndex(settingsResourceState.value.promptPresetsId)
    const promptPresets = collectionsResourceState.values.promptPresets
    return Array.isArray(promptPresets) ? promptPresets[index] : undefined
  })
  let selectedPromptPresetOverridesRoles = $derived(hasPresetField(selectedPromptPreset, 'modelRoleProfiles'))

  function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }

  function selectedOwnerIndex(value: unknown): number {
    return Number.isInteger(value) ? (value as number) : -1
  }

  function presetName(preset: ModelPreset | undefined, index: number): string {
    return preset?.name?.trim() || language.modelProfiles.defaultPresetName(index + 1)
  }

  function newPresetFallbackName(): string {
    return language.modelProfiles.defaultPresetName(presets.length + 1)
  }

  function presetMutationKey(preset: ModelPreset | undefined, index: number): string {
    return `model:${preset?.id ?? `index:${index}`}`
  }

  function observePresetRowMutation(
    key: string,
    outcome: Promise<PresetMutationOutcome> | undefined,
    onAccepted = () => {},
  ): void {
    if (!outcome) return
    const operation = ++rowMutationOperation
    rowMutationStates[key] = { operation, status: 'saving' }
    delete rowMutationErrors[key]
    void outcome.then(
      (result) => settlePresetRowMutation(key, operation, result, onAccepted),
      () => showPresetRowMutationFailure(key, operation),
    )
  }

  function settlePresetRowMutation(
    key: string,
    operation: number,
    outcome: PresetMutationOutcome,
    onAccepted: () => void,
  ): void {
    if (rowMutationStates[key]?.operation !== operation) return
    if (outcome.status === 'accepted') {
      delete rowMutationStates[key]
      onAccepted()
      return
    }
    if (outcome.status === 'failed') {
      showPresetRowMutationFailure(key, operation)
      return
    }

    rowMutationStates[key] = { operation, status: 'queued' }
    alertNormal(language.presetMutationQueued)
    void outcome.settlement.then(
      (status) => {
        if (rowMutationStates[key]?.operation !== operation) return
        if (status === 'accepted') {
          delete rowMutationStates[key]
          onAccepted()
        } else showPresetRowMutationFailure(key, operation)
      },
      () => showPresetRowMutationFailure(key, operation),
    )
  }

  function showPresetRowMutationFailure(key: string, operation: number): void {
    if (rowMutationStates[key]?.operation !== operation) return
    delete rowMutationStates[key]
    rowMutationErrors[key] = language.presetMutationFailed
    alertError(language.presetMutationFailed)
  }

  async function beginCreate(mode: 'current' | 'empty', trigger: HTMLButtonElement): Promise<void> {
    createMode = mode
    createTrigger = trigger
    await tick()
    createNameInput?.focus()
  }

  async function cancelCreate(): Promise<void> {
    createMode = null
    newPresetName = ''
    await tick()
    createTrigger?.focus()
  }

  function saveNewPreset(): void {
    if (!createMode || createMutation) return
    const name = newPresetName.trim() || newPresetFallbackName()
    const preset =
      createMode === 'current'
        ? createModelRoleBindingPresetSnapshot(settingsResourceState.value, name)
        : { name, modelRoleProfiles: cloneJsonValue(createEmptyPresetRoleProfiles()) }
    observePresetRowMutation(`model:create-${createMode}`, createModelPreset(preset), cancelCreate)
  }

  function createEmptyPresetRoleProfiles() {
    const bindings = normalizeModelRoleProfiles(undefined)
    for (const role of MODEL_ROLES) {
      if (modelRoleProfileInheritSource(role)) {
        bindings[role] = { mode: 'inherit' }
      }
    }
    return bindings
  }

  async function beginRename(index: number, close: () => void): Promise<void> {
    close()
    renameKey = presetMutationKey(presets[index], index)
    renameDraft = presetName(presets[index], index)
    recoveryRenameBaseline = renameDraft
    restoreRenameFocus = close
    await tick()
    renameInput?.focus()
    renameInput?.select()
  }

  async function cancelRename(): Promise<void> {
    renameKey = null
    await tick()
    restoreRenameFocus()
  }

  function renamePreset(index: number): void {
    const preset = presets[index]
    if (!preset) return
    const key = presetMutationKey(preset, index)
    if (rowMutationStates[key]) return
    const nextName = renameDraft.trim() || presetName(preset, index)
    if ((preset.name ?? '') === nextName) {
      cancelRename()
      return
    }
    observePresetRowMutation(key, updateModelPreset(index, { name: nextName }), () => {
      if (renameKey === key) cancelRename()
    })
  }

  function duplicatePreset(index: number): void {
    const preset = presets[index]
    if (!preset) return
    const copy = cloneJsonValue(preset)
    delete copy.id
    copy.name = language.modelProfiles.copyName(presetName(preset, index))
    observePresetRowMutation(presetMutationKey(preset, index), createModelPreset(copy))
  }

  function removePreset(index: number): void {
    const preset = presets[index]
    if (!preset || presets.length <= 1) return
    if (!window.confirm(language.modelProfiles.deleteModelPresetConfirm(presetName(preset, index)))) return
    observePresetRowMutation(presetMutationKey(preset, index), deleteModelPreset(index, 0))
  }

  async function applyPreset(index: number): Promise<void> {
    if (index === selectedIndex) {
      afterApply()
      return
    }
    if (selectionPendingIndex !== null) return

    const operation = ++selectionOperation
    selectionPendingIndex = index
    selectionError = ''
    let outcome: PresetMutationOutcome
    try {
      outcome = await selectModelPreset(index)
    } catch {
      if (operation !== selectionOperation) return
      selectionPendingIndex = null
      selectionError = language.presetSelectionFailed
      alertError(selectionError)
      return
    }
    if (operation !== selectionOperation) return
    selectionPendingIndex = null

    if (outcome.status === 'failed') {
      selectionError = language.presetSelectionFailed
      alertError(selectionError)
      return
    }
    if (outcome.status === 'queued') alertNormal(language.presetSelectionQueued)
    afterApply()
  }

  function movePresetUp(index: number): void {
    if (index <= 0) return
    observePresetRowMutation(presetMutationKey(presets[index], index), reorderModelPresets(index, index - 1))
  }

  function movePresetDown(index: number): void {
    if (index >= presets.length - 1) return
    observePresetRowMutation(presetMutationKey(presets[index], index), reorderModelPresets(index, index + 2))
  }

  function hasPresetField(preset: ModelPreset | PromptPreset | undefined, field: string): boolean {
    return !!preset && Object.prototype.hasOwnProperty.call(preset, field)
  }

  function selectedPromptPresetName(): string {
    return selectedPromptPreset?.name?.trim() || language.promptPresets
  }

  function presetProfiles(preset: ModelPreset): ModelProfileRecord[] {
    return hasPresetField(preset, 'modelProfiles') ? readModelProfileOwners(preset.modelProfiles) : profiles
  }

  function bindingLabel(binding: ModelRoleProfileBinding, preset: ModelPreset): string {
    if (binding.mode === 'profile') {
      return (
        presetProfiles(preset).find((profile) => profile.id === binding.profileId)?.name ??
        language.modelProfiles.modelPresetMissingModel
      )
    }
    if (binding.mode === 'inherit') return language.modelProfiles.bindingModes.inherit
    return language.modelProfiles.bindingModes.legacy
  }

  function chatRoleSummary(preset: ModelPreset): string {
    if (!hasPresetField(preset, 'modelRoleProfiles')) return language.modelProfiles.modelPresetLegacySummary
    const bindings = normalizeModelRoleProfiles(preset.modelRoleProfiles)
    const roles: ModelRole[] = ['chatMain', 'chatAux']
    return roles
      .map((role) => `${language.modelRoles.roles[role]}: ${bindingLabel(bindings[role], preset)}`)
      .join(' · ')
  }

  function roleBindingSummary(preset: ModelPreset): string {
    if (!hasPresetField(preset, 'modelRoleProfiles')) {
      return legacyModelFieldCount(preset) > 0
        ? language.modelProfiles.modelPresetLegacyFieldSummary(legacyModelFieldCount(preset))
        : language.modelProfiles.modelPresetNoRoleBindings
    }

    const bindings = normalizeModelRoleProfiles(preset.modelRoleProfiles)
    let profileCount = 0
    let inheritCount = 0
    let legacyCount = 0
    let missingCount = 0
    const profileIds = new Set(presetProfiles(preset).map((profile) => profile.id))

    for (const role of MODEL_ROLES) {
      const binding = bindings[role]
      if (binding.mode === 'profile') {
        profileCount += 1
        if (!profileIds.has(binding.profileId)) missingCount += 1
      } else if (binding.mode === 'inherit') {
        inheritCount += 1
      } else {
        legacyCount += 1
      }
    }

    return language.modelProfiles.modelPresetRoleBindingSummary(profileCount, inheritCount, legacyCount, missingCount)
  }

  function missingProfileIds(preset: ModelPreset): string[] {
    if (!hasPresetField(preset, 'modelRoleProfiles')) return []
    const bindings = normalizeModelRoleProfiles(preset.modelRoleProfiles)
    const profileIds = new Set(presetProfiles(preset).map((profile) => profile.id))
    return [
      ...new Set(
        MODEL_ROLES.flatMap((role) => {
          const binding = bindings[role]
          return binding.mode === 'profile' && !profileIds.has(binding.profileId) ? [binding.profileId] : []
        }),
      ),
    ]
  }

  function legacyModelFieldCount(preset: ModelPreset): number {
    return ['aiModel', 'subModel', 'modelRoles', 'seperateModels', 'fallbackModels'].filter((field) =>
      hasPresetField(preset, field),
    ).length
  }

  function presetBadges(preset: ModelPreset): string[] {
    const badges: string[] = []
    if (hasPresetField(preset, 'modelRoleProfiles')) badges.push(language.modelProfiles.modelPresetRoleBindingsBadge)
    if (hasPresetField(preset, 'modelProfiles')) badges.push(language.modelProfiles.modelPresetEmbeddedProfilesBadge)
    if (hasPresetField(preset, 'modelRuntimeDefaults')) badges.push(language.modelProfiles.modelPresetRuntimeBadge)
    if (legacyModelFieldCount(preset) > 0) badges.push(language.modelProfiles.modelPresetLegacyBadge)
    if (badges.length === 0) badges.push(language.modelProfiles.modelPresetEmptyBadge)
    return badges
  }

  function readModelPresetOwners(value: unknown): ModelPreset[] {
    return Array.isArray(value) ? (value as ModelPreset[]) : []
  }

  function readModelProfileOwners(value: unknown): ModelProfileRecord[] {
    if (!Array.isArray(value)) return []
    const ids = new Set<string>()
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
      const id = (candidate as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return []
      ids.add(id)
    }
    return value as ModelProfileRecord[]
  }

  onDestroy(
    registerWriterDraftCapture(() => {
      const creating = createMode !== null && newPresetName !== ''
      const renaming = renameKey !== null && renameDraft !== recoveryRenameBaseline
      if (!creating && !renaming) return null
      return $state.snapshot({
        key: `model-preset-form:${renameKey ?? 'new'}`,
        label: language.modelProfiles.defaultPresetName(1),
        fields: [{ label: language.modelProfiles.profileNameColumn, value: renaming ? renameDraft : newPresetName }],
        data: { createMode, newPresetName, renameKey, renameDraft },
        baseline: { renameDraft: recoveryRenameBaseline, newPresetName: '' },
      })
    }),
  )
</script>

<section class="flex flex-col gap-4">
  {#if !embedded}
    <div class="flex flex-col gap-1">
      <h3 class="text-lg font-semibold">{language.modelProfiles.presetsTabTitle}</h3>
      <span class="text-sm text-textcolor2">{language.modelProfiles.presetsTabDescription}</span>
    </div>
  {/if}

  <div class="flex flex-wrap gap-2">
    <Button size="sm" disabled={!!createMutation} onclick={(event) => beginCreate('current', event.currentTarget)}>
      <span class="inline-flex items-center gap-2">
        <PlusIcon size={16} />{language.modelProfiles.saveCurrentRolesAsPreset}
      </span>
    </Button>
    <Button
      size="sm"
      styled="outlined"
      disabled={!!createMutation}
      onclick={(event) => beginCreate('empty', event.currentTarget)}>
      <span class="inline-flex items-center gap-2">
        <FilePlusIcon size={16} />{language.modelProfiles.createEmptyModelPreset}
      </span>
    </Button>
  </div>

  {#if createMode}
    <form
      class="flex flex-col gap-2 rounded-md border border-darkborderc p-3"
      aria-label={createMode === 'current'
        ? language.modelProfiles.saveCurrentRolesAsPreset
        : language.modelProfiles.createEmptyModelPreset}
      onsubmit={(event) => {
        event.preventDefault()
        saveNewPreset()
      }}>
      <label for={`${id}-create-name`} class="text-sm text-textcolor2">{language.modelProfiles.modelPresetName}</label>
      <div class="flex flex-wrap items-center gap-2">
        <TextInput
          id={`${id}-create-name`}
          size="sm"
          bind:inputRef={createNameInput}
          bind:value={newPresetName}
          placeholder={newPresetFallbackName()}
          disabled={!!createMutation}
          className="min-w-0 flex-1"
          onkeydown={(event) => {
            if (event.key === 'Escape' && !createMutation) {
              event.preventDefault()
              event.stopPropagation()
              cancelCreate()
            }
          }} />
        <Button size="sm" disabled={!!createMutation} onclick={saveNewPreset}>{language.save}</Button>
        <Button size="sm" styled="outlined" disabled={!!createMutation} onclick={cancelCreate}
          >{language.cancel}</Button>
      </div>
      {#if createMutation}
        <span role="status" class="text-xs text-textcolor2">
          {createMutation.status === 'queued' ? language.presetMutationQueued : language.presetMutationSaving}
        </span>
      {/if}
    </form>
  {/if}

  {#if selectedPromptPresetOverridesRoles}
    <div class="rounded-md border border-darkborderc p-3 text-sm text-textcolor2">
      {language.modelProfiles.promptPresetRoleOverrideNotice(selectedPromptPresetName())}
    </div>
  {/if}

  {#if presets.length === 0}
    <div class="rounded-md border border-darkborderc p-4 text-sm text-textcolor2">
      {language.modelProfiles.noModelPresets}
    </div>
  {:else}
    <div class="flex flex-col gap-1.5" role="list">
      {#each presets as preset, index (preset.id ?? index)}
        {@const key = presetMutationKey(preset, index)}
        {@const mutation = rowMutationStates[key]}
        {@const missingIds = missingProfileIds(preset)}
        <article
          role="listitem"
          data-model-preset-row
          class="rounded-md border text-sm text-textcolor {index === selectedIndex
            ? 'border-selected bg-selected/20'
            : 'border-darkborderc bg-bgcolor'}">
          <div class="flex min-h-20 items-center gap-1 pr-2">
            <button
              type="button"
              data-model-preset-select
              class="flex min-h-20 min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-3 text-left hover:bg-selected/10 focus-visible:ring-2 focus-visible:ring-borderc"
              aria-label={language.modelProfiles.selectModelPreset(presetName(preset, index))}
              aria-pressed={index === selectedIndex}
              aria-busy={selectionPendingIndex === index ? 'true' : 'false'}
              disabled={selectionPendingIndex !== null || !!mutation}
              onclick={() => applyPreset(index)}>
              <span class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="font-medium break-words">{presetName(preset, index)}</span>
                <span class="break-words text-xs text-textcolor2">{chatRoleSummary(preset)}</span>
                {#if hasPresetField(preset, 'modelProfiles') || hasPresetField(preset, 'modelRuntimeDefaults')}
                  <span class="text-xs text-textcolor2">{language.modelProfiles.modelPresetSettingsNotice}</span>
                {/if}
                {#if missingIds.length > 0}
                  <span class="text-xs text-draculared"
                    >{language.modelProfiles.modelPresetMissingModels(missingIds.length)}</span>
                {/if}
              </span>
              {#if index === selectedIndex}
                <span class="inline-flex shrink-0 items-center gap-1 text-xs">
                  <CheckIcon size={16} aria-hidden="true" />
                  <span class="hidden sm:inline">{language.modelProfiles.modelPresetSelected}</span>
                </span>
              {/if}
            </button>
            <ModelItemActions
              fixed
              label={language.modelProfiles.itemActions(presetName(preset, index))}
              disabled={selectionPendingIndex !== null || !!mutation}>
              {#snippet children(close)}
                <button type="button" class={actionClass} onclick={() => beginRename(index, close)}>
                  <PencilIcon size={14} />{language.modelProfiles.renameModelPreset}
                </button>
                <button
                  type="button"
                  class={actionClass}
                  onclick={() => {
                    close()
                    duplicatePreset(index)
                  }}><CopyIcon size={14} />{language.modelProfiles.duplicate}</button>
                <button
                  type="button"
                  class={actionClass}
                  disabled={index === 0}
                  onclick={() => {
                    close()
                    movePresetUp(index)
                  }}><ArrowUpIcon size={14} />{language.modelProfiles.moveUp}</button>
                <button
                  type="button"
                  class={actionClass}
                  disabled={index >= presets.length - 1}
                  onclick={() => {
                    close()
                    movePresetDown(index)
                  }}><ArrowDownIcon size={14} />{language.modelProfiles.moveDown}</button>
                <button
                  type="button"
                  class={actionClass}
                  aria-expanded={detailsKey === key}
                  aria-controls={`${id}-details-${index}`}
                  onclick={() => {
                    close()
                    detailsKey = detailsKey === key ? null : key
                  }}><InfoIcon size={14} />{language.modelProfiles.modelPresetDetails}</button>
                <button
                  type="button"
                  class={`${actionClass} border-t border-darkborderc text-draculared`}
                  disabled={presets.length <= 1}
                  onclick={() => {
                    close()
                    removePreset(index)
                  }}><TrashIcon size={14} />{language.modelProfiles.delete}</button>
              {/snippet}
            </ModelItemActions>
          </div>
          {#if mutation}
            <span data-risu-preset-row-mutation-status role="status" class="block px-3 pb-3 text-xs text-textcolor2">
              {mutation.status === 'queued' ? language.presetMutationQueued : language.presetMutationSaving}
            </span>
          {/if}
          {#if rowMutationErrors[key]}
            <span data-risu-preset-row-mutation-status role="alert" class="block px-3 pb-3 text-xs text-draculared">
              {rowMutationErrors[key]}
            </span>
          {/if}
          {#if renameKey === key}
            <form
              class="flex flex-col gap-2 border-t border-darkborderc p-3"
              aria-label={language.modelProfiles.renameModelPreset}
              onsubmit={(event) => {
                event.preventDefault()
                renamePreset(index)
              }}>
              <label for={`${id}-rename-name`} class="text-xs text-textcolor2"
                >{language.modelProfiles.modelPresetName}</label>
              <div class="flex flex-wrap items-center gap-2">
                <TextInput
                  id={`${id}-rename-name`}
                  size="sm"
                  bind:inputRef={renameInput}
                  bind:value={renameDraft}
                  disabled={!!mutation}
                  className="min-w-0 flex-1"
                  onkeydown={(event) => {
                    if (event.key === 'Escape' && !mutation) {
                      event.preventDefault()
                      event.stopPropagation()
                      cancelRename()
                    }
                  }} />
                <Button size="sm" disabled={!!mutation} onclick={() => renamePreset(index)}>{language.save}</Button>
                <Button size="sm" styled="outlined" disabled={!!mutation} onclick={cancelRename}
                  >{language.cancel}</Button>
              </div>
            </form>
          {/if}
          {#if detailsKey === key}
            <dl
              id={`${id}-details-${index}`}
              class="grid gap-1 border-t border-darkborderc p-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-2">
              <dt class="text-textcolor2">{language.modelProfiles.modelPresetId}</dt>
              <dd class="break-all">{preset.id ?? language.none}</dd>
              <dt class="text-textcolor2">{language.modelProfiles.roleBindingsColumn}</dt>
              <dd class="break-words">{roleBindingSummary(preset)}</dd>
              <dt class="text-textcolor2">{language.modelProfiles.storedDataColumn}</dt>
              <dd class="break-words">{presetBadges(preset).join(' · ')}</dd>
              {#if missingIds.length > 0}
                <dt class="text-textcolor2">{language.modelProfiles.modelPresetMissingModel}</dt>
                <dd class="break-all">{missingIds.join(', ')}</dd>
              {/if}
            </dl>
          {/if}
        </article>
      {/each}
    </div>
  {/if}

  {#if selectionError}
    <span data-risu-preset-selection-status role="alert" class="text-sm text-draculared">{selectionError}</span>
  {/if}
  {#if latestRowMutationError}
    <span data-risu-preset-mutation-status role="alert" class="text-sm text-draculared">
      {latestRowMutationError}
    </span>
  {/if}
</section>
