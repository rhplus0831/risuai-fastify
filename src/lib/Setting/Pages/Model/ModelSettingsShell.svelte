<script lang="ts">
  import { ListIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import SegmentedControl from 'src/lib/UI/GUI/SegmentedControl.svelte'
  import { getModelInfo } from 'src/ts/model/modellist'
  import {
    normalizeLegacySeperateModels,
    normalizeModelRoleOverrides,
    MODEL_ROLES,
  } from '@risuai/shared-core/model-roles'
  import { normalizeModelRoleProfiles, type ModelProfileRecord } from 'src/ts/model/modelProfileRecords'
  import { resolveModelProfileUiState } from 'src/ts/model/modelProfileUiState'
  import {
    beginPendingModelMutation,
    convertLegacyModelProfilesDurably,
    finishPendingModelMutation,
    getPendingModelMutations,
    isPendingModelMutationProjectionApplied,
    retainPendingModelMutation,
    subscribePendingModelMutations,
  } from 'src/ts/model/modelProfileMutations'
  import type { ServerCommandResult } from 'src/ts/server/commands'
  import { collectionsResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import type { Database } from 'src/ts/storage/database.svelte'
  import { openPresetListModal } from 'src/ts/stores.svelte'
  import LegacyModelRoleList from './ModelRoleList.svelte'
  import ModelProfileList from './ModelProfileList.svelte'
  import ModelProfileRoleList from './ModelProfileRoleList.svelte'
  import ProviderCredentialList from './ProviderCredentialList.svelte'
  import SettingsSections from '../../SettingsSections.svelte'
  import { modelSupplementalSettingsSections } from 'src/ts/setting/modelSupplementalSettingsData'

  type ModelSettingsTab = 'roles' | 'profiles' | 'credentials'

  let activeTab = $state<ModelSettingsTab>('profiles')
  let conversionPromptDeclined = $state(false)
  let converting = $state(false)
  let pendingMutations = $state(getPendingModelMutations('model-profiles'))
  let pendingRuntimeMutations = $state(getPendingModelMutations('model-runtime-defaults'))
  let commandError = $state('')

  let modelProfileOwnersValid = $derived(hasUniqueModelProfileOwners(settingsResourceState.value.modelProfiles))
  let modelProfiles = $derived(readModelProfileOwners(settingsResourceState.value.modelProfiles))
  let modelSettingsOwner = $derived.by(
    () =>
      ({
        ...settingsResourceState.value,
        modelProfiles,
      }) as Database,
  )
  let modelProfileUiState = $derived.by(() =>
    resolveModelProfileUiState({
      database: modelSettingsOwner,
      lookupModelInfo: (_database, id) => getModelInfo(id),
    }),
  )
  let modelMutationPending = $derived(pendingMutations.length > 0)
  let conversionQueued = $derived(pendingMutations.some((pending) => pending.projection.kind === 'legacy-conversion'))
  let legacyOnly = $derived(isClearlyLegacyOnly())
  let showConversionPrompt = $derived((legacyOnly || conversionQueued) && !conversionPromptDeclined)
  let showAdvancedLegacySettings = $derived(!modelProfileUiState.allRolesUseDurableProfiles)
  let selectedModelPresetButtonLabel = $derived.by(() => {
    const index = selectedOwnerIndex(settingsResourceState.value.modelPresetsId)
    const presets = collectionsResourceState.values.modelPresets
    const preset = Array.isArray(presets) ? presets[index] : undefined
    if (!preset) return language.none

    const name = typeof preset.name === 'string' ? preset.name.trim() : ''
    return name || language.modelProfiles.defaultPresetName(index + 1)
  })
  let legacyMainModel = $derived(settingsResourceState.value.aiModel || language.none)
  let legacyAuxModel = $derived(settingsResourceState.value.subModel || language.none)

  $effect(() => {
    return subscribePendingModelMutations('model-profiles', (pending) => {
      pendingMutations = pending
    })
  })

  $effect(() => {
    return subscribePendingModelMutations('model-runtime-defaults', (pending) => {
      pendingRuntimeMutations = pending
    })
  })

  $effect(() => {
    for (const pending of [...pendingMutations, ...pendingRuntimeMutations]) {
      if (pending.phase === 'discarded') {
        commandError = language.modelProfiles.commandReplayDiscarded
        finishPendingModelMutation(pending.token)
        continue
      }
      if (pending.phase === 'dispatching') continue
      if (isPendingModelMutationProjectionApplied(pending.projection, settingsResourceState.value)) {
        finishPendingModelMutation(pending.token)
      }
    }
  })

  function nonBlank(value: unknown): boolean {
    return typeof value === 'string' && value.trim() !== ''
  }

  function selectedOwnerIndex(value: unknown): number {
    return Number.isInteger(value) ? (value as number) : -1
  }

  function hasLegacyModelFields(): boolean {
    const settings = settingsResourceState.value
    if (nonBlank(settings.aiModel) || nonBlank(settings.subModel)) return true

    const roleOverrides = normalizeModelRoleOverrides(settings.modelRoles)
    if (Object.values(roleOverrides).some(nonBlank)) return true

    if (settings.seperateModelsForAxModels) {
      const separateModels = normalizeLegacySeperateModels(settings.seperateModels)
      if (Object.values(separateModels).some(nonBlank)) return true
    }

    return false
  }

  function isClearlyLegacyOnly(): boolean {
    if (!modelProfileOwnersValid) return false
    if (modelProfiles.length > 0) return false

    const roleProfiles = normalizeModelRoleProfiles(settingsResourceState.value.modelRoleProfiles)
    if (!MODEL_ROLES.every((role) => roleProfiles[role].mode === 'legacy')) return false

    return hasLegacyModelFields()
  }

  function commandErrorMessage(result: Exclude<ServerCommandResult, { status: 'ok' }>): string {
    return result.status === 'conflict'
      ? language.modelProfiles.commandConflict
      : result.status === 'error'
        ? result.error
        : language.modelProfiles.commandUnavailable
  }

  async function convertLegacyProfiles(): Promise<void> {
    if (converting || modelMutationPending || !modelProfileOwnersValid) return
    converting = true
    commandError = ''
    const baselineIds = modelProfiles.map((profile) => profile.id)
    const pendingToken = beginPendingModelMutation('model-profiles', {
      kind: 'legacy-conversion',
      baselineIds,
    })
    if (!pendingToken) {
      converting = false
      return
    }
    try {
      const outcome = await convertLegacyModelProfilesDurably()
      if (outcome.status === 'accepted') {
        finishPendingModelMutation(pendingToken)
        conversionPromptDeclined = false
        return
      }
      if (outcome.status === 'queued') {
        retainPendingModelMutation(pendingToken, outcome.mutationId)
        return
      }
      finishPendingModelMutation(pendingToken)
      commandError = commandErrorMessage(outcome.result)
    } catch {
      finishPendingModelMutation(pendingToken)
      commandError = commandErrorMessage({ status: 'unavailable' })
    } finally {
      converting = false
    }
  }

  function readModelProfileOwners(value: unknown): ModelProfileRecord[] {
    if (!hasUniqueModelProfileOwners(value)) return []
    return value as ModelProfileRecord[]
  }

  function hasUniqueModelProfileOwners(value: unknown): value is ModelProfileRecord[] {
    if (!Array.isArray(value)) return false
    const ids = new Set<string>()
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
      const id = (candidate as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return false
      ids.add(id)
    }
    return true
  }
</script>

<h2 class="mb-2 mt-2 text-2xl font-bold">{language.modelProfiles.settingsTitle}</h2>

<section class="flex flex-col gap-4">
  {#if showConversionPrompt}
    <div class="rounded-md border border-selected bg-darkbg p-4">
      <h3 class="text-lg font-semibold">{language.modelProfiles.convertPromptTitle}</h3>
      <p class="mt-1 text-sm text-textcolor2">{language.modelProfiles.convertPromptDescription}</p>
      {#if commandError}
        <div class="mt-3 rounded-md border border-draculared p-2 text-sm text-draculared">{commandError}</div>
      {/if}
      <div class="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={converting || modelMutationPending} onclick={convertLegacyProfiles}>
          {converting ? language.modelProfiles.converting : language.modelProfiles.convertToProfiles}
        </Button>
        <Button
          size="sm"
          styled="outlined"
          disabled={converting || modelMutationPending}
          onclick={() => {
            conversionPromptDeclined = true
          }}>
          {language.modelProfiles.notNow}
        </Button>
      </div>
    </div>
  {:else if legacyOnly}
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-darkborderc p-3">
      <span class="text-sm text-textcolor2">{language.modelProfiles.convertDeclinedNotice}</span>
      <Button size="sm" disabled={converting || modelMutationPending} onclick={convertLegacyProfiles}>
        {converting ? language.modelProfiles.converting : language.modelProfiles.convertToProfiles}
      </Button>
    </div>
  {/if}

  <div class="model-settings-tabs">
    <SegmentedControl
      bind:value={activeTab}
      options={[
        { value: 'profiles', label: language.modelProfiles.profilesTab },
        { value: 'roles', label: language.modelProfiles.rolesTab },
        { value: 'credentials', label: language.modelProfiles.credentialsTab },
      ]} />
  </div>

  {#if activeTab === 'roles'}
    <div class="w-full">
      <Button
        size="sm"
        styled="outlined"
        onclick={() => {
          openPresetListModal('global', 'model')
        }}
        className="flex w-full min-w-0 items-center justify-start gap-2 text-left">
        <ListIcon size={16} class="shrink-0" />
        <span class="min-w-0 flex-1 break-words text-textcolor">
          <span class="text-textcolor2">{language.modelProfiles.modelPresetLabel}:</span>
          {selectedModelPresetButtonLabel}
        </span>
        <span class="shrink-0">{language.modelProfiles.changeModelPreset}</span>
      </Button>
    </div>
    <ModelProfileRoleList />
  {:else if activeTab === 'profiles'}
    <ModelProfileList />
  {:else}
    <ProviderCredentialList />
  {/if}

  {#if showAdvancedLegacySettings}
    <Accordion styled name={language.modelProfiles.advancedLegacySettings} className="gap-3">
      <p class="text-sm text-textcolor2">{language.modelProfiles.advancedLegacyDescription}</p>
      <div class="grid gap-2 text-sm md:grid-cols-2">
        <div class="risu-card">
          <span class="block text-xs uppercase text-textcolor2">{language.modelProfiles.legacyMainModel}</span>
          <span>{legacyMainModel}</span>
        </div>
        <div class="risu-card">
          <span class="block text-xs uppercase text-textcolor2">{language.modelProfiles.legacyAuxModel}</span>
          <span>{legacyAuxModel}</span>
        </div>
      </div>
      {#if legacyOnly}
        <div class="flex justify-end">
          <Button size="sm" disabled={converting || modelMutationPending} onclick={convertLegacyProfiles}>
            {converting ? language.modelProfiles.converting : language.modelProfiles.convertToProfiles}
          </Button>
        </div>
      {/if}
      <LegacyModelRoleList />
    </Accordion>
  {/if}

  <SettingsSections sections={modelSupplementalSettingsSections} />
</section>

<style>
  @media (max-width: 640px) {
    .model-settings-tabs :global(.segmented-control-container) {
      width: 100%;
      align-items: stretch;
    }
    .model-settings-tabs :global(.segmented-btn) {
      min-width: 0;
      flex: 1;
      white-space: normal;
      padding-inline: 8px;
      font-size: 12px;
    }
  }
</style>
