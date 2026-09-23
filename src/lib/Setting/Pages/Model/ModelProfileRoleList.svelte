<script lang="ts">
  import { onDestroy } from 'svelte'
  import { language } from 'src/lang'
  import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import { resolveModelProfileUiState } from 'src/ts/model/modelProfileUiState'
  import {
    isModelProfileDividerSelectValue,
    modelProfileDividerSelectValue,
    modelProfileListItems,
    normalizeModelRoleProfiles,
    type ModelProfileRecord,
    type ModelRoleProfileBinding,
    type ModelRoleProfileMap,
  } from 'src/ts/model/modelProfileRecords'
  import { MODEL_ROLES, modelRoleProfileInheritSource, type ModelRole } from '@risuai/shared-core/model-roles'
  import { getModelInfo } from 'src/ts/model/modellist'
  import { selectedModelPresetId } from 'src/ts/model/modelPresetSelection'
  import { ProviderNames } from 'src/ts/model/types'
  import {
    beginPendingModelMutation,
    finishPendingModelMutation,
    getPendingModelMutations,
    isPendingModelMutationProjectionApplied,
    retainPendingModelMutation,
    subscribePendingModelMutations,
    updateModelRoleProfilesDurably,
  } from 'src/ts/model/modelProfileMutations'
  import type { ServerCommandResult } from 'src/ts/server/commands'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import type { Database } from 'src/ts/storage/database.svelte'

  type BindingFeedback = 'accepted' | 'queued'
  type RoleGroupKey = 'chat' | 'memory' | 'translation' | 'scripts'

  const INHERIT_SELECT_VALUE = 'binding:inherit'
  const LEGACY_SELECT_VALUE = 'binding:legacy'
  const PROFILE_SELECT_VALUE_PREFIX = 'profile:'
  const ROLE_GROUP_DEFINITIONS: Array<{ key: RoleGroupKey; roles: ModelRole[] }> = [
    { key: 'chat', roles: ['chatMain', 'chatAux'] },
    { key: 'memory', roles: ['memory', 'emotion'] },
    { key: 'translation', roles: ['translate', 'otherAx'] },
    { key: 'scripts', roles: ['scriptMain', 'scriptAux'] },
  ]
  const explicitlyGroupedRoles = new Set(ROLE_GROUP_DEFINITIONS.flatMap((group) => group.roles))
  const roleGroups = ROLE_GROUP_DEFINITIONS.map((group) => ({
    key: group.key,
    roles: MODEL_ROLES.filter(
      (role) => group.roles.includes(role) || (group.key === 'scripts' && !explicitlyGroupedRoles.has(role)),
    ),
  }))

  let draftBindings = $state<ModelRoleProfileMap>(normalizeModelRoleProfiles(undefined))
  let serverBaselineBindings = $state<ModelRoleProfileMap>(normalizeModelRoleProfiles(undefined))
  let lastServerSnapshot = $state('')
  let applying = $state(false)
  let profileSelectRevisions = $state<Partial<Record<ModelRole, number>>>({})
  let bindingFeedback = $state<Partial<Record<ModelRole, BindingFeedback>>>({})
  let pendingMutations = $state(getPendingModelMutations('model-profiles'))
  let commandError = $state('')
  const bindingFeedbackTimers = new Map<ModelRole, ReturnType<typeof setTimeout>>()

  let profiles = $derived(readModelProfileOwners(settingsResourceState.value.modelProfiles))
  let profileItems = $derived(modelProfileListItems(profiles, settingsResourceState.value.modelProfileOrder))
  let profileIdSet = $derived(new Set(profiles.map((profile) => profile.id)))
  let resolverDatabase = $derived.by(
    () =>
      ({
        ...settingsResourceState.value,
        modelProfiles: profiles,
        modelRoleProfiles: draftBindings,
      }) as Database,
  )
  let uiState = $derived.by(() =>
    resolveModelProfileUiState({
      database: resolverDatabase,
      lookupModelInfo: (_database, id) => getModelInfo(id),
    }),
  )
  let applyQueued = $derived(pendingMutations.length > 0)

  $effect(() => {
    return subscribePendingModelMutations('model-profiles', (pending) => {
      pendingMutations = pending
    })
  })

  $effect(() => {
    const normalized = normalizeModelRoleProfiles(settingsResourceState.value.modelRoleProfiles)
    const snapshot = snapshotBindings(normalized)
    if (snapshot === lastServerSnapshot) return

    draftBindings = rebaseDraftBindings(serverBaselineBindings, draftBindings, normalized)
    serverBaselineBindings = cloneJsonValue(normalized)
    lastServerSnapshot = snapshot
    commandError = ''
  })

  $effect(() => {
    for (const pending of pendingMutations) {
      if (pending.phase === 'discarded') {
        commandError = language.modelProfiles.commandReplayDiscarded
        if (pending.projection.kind === 'role-bindings') {
          for (const role of Object.keys(pending.projection.bindings) as ModelRole[]) clearBindingFeedback(role)
          restoreBindingsIfCurrent(pending.projection.bindings)
        }
        finishPendingModelMutation(pending.token)
        continue
      }
      if (pending.phase === 'dispatching' || pending.projection.kind !== 'role-bindings') continue
      if (
        isPendingModelMutationProjectionApplied(pending.projection, {
          modelRoleProfiles: settingsResourceState.value.modelRoleProfiles,
        })
      ) {
        finishPendingModelMutation(pending.token)
      }
    }
  })

  function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
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

  function snapshotBinding(binding: ModelRoleProfileBinding): string {
    return JSON.stringify(binding)
  }

  function snapshotBindings(bindings: ModelRoleProfileMap): string {
    return JSON.stringify(MODEL_ROLES.map((role) => [role, bindings[role]]))
  }

  function rebaseDraftBindings(
    previousServer: ModelRoleProfileMap,
    localDraft: ModelRoleProfileMap,
    nextServer: ModelRoleProfileMap,
  ): ModelRoleProfileMap {
    const rebased = cloneJsonValue(localDraft)
    for (const role of MODEL_ROLES) {
      if (snapshotBinding(localDraft[role]) === snapshotBinding(previousServer[role])) {
        rebased[role] = cloneJsonValue(nextServer[role])
      }
    }
    return rebased
  }

  function bindingCanBeSaved(role: ModelRole, binding: ModelRoleProfileBinding): boolean {
    if (binding.mode === 'profile' && !profileIdSet.has(binding.profileId)) return false
    return role !== 'memory' || uiState.roleStatuses.memory.bucket !== 'unsupported'
  }

  function roleLabel(role: ModelRole): string {
    return language.modelRoles.roles[role]
  }

  function roleDescription(role: ModelRole): string {
    return language.modelRoles.descriptions[role]
  }

  function bindingFor(role: ModelRole): ModelRoleProfileBinding {
    return draftBindings[role] ?? { mode: 'legacy' }
  }

  function profileName(profileId: string): string {
    return profiles.find((profile) => profile.id === profileId)?.name ?? profileId
  }

  function modelName(modelId: string): string {
    return getModelInfo(modelId)?.fullName || modelId || language.none
  }

  function providerName(role: ModelRole): string {
    const resolved = uiState.resolvedProfiles[role]
    if (resolved.status.providerId) return language.modelProfiles.providerNames[resolved.status.providerId]
    if (resolved.providerOptions.provider) return resolved.providerOptions.provider
    return ProviderNames.get(resolved.modelInfo.provider) ?? language.none
  }

  function effectiveSummary(role: ModelRole): string {
    const binding = bindingFor(role)
    const resolved = uiState.resolvedProfiles[role]
    const parts = [providerName(role)]
    if (resolved.modelId !== resolved.status.providerId) parts.push(modelName(resolved.modelId))
    const requestModel = resolved.providerOptions.requestModel?.trim()
    if (requestModel && requestModel !== resolved.modelId) parts.push(requestModel)
    if (binding.mode === 'inherit') {
      const inheritedProfileName =
        resolved.source.profileName ||
        (resolved.source.kind === 'durable-profile' ? profileName(resolved.profileId) : '') ||
        (resolved.status.bucket === 'compatibility' ? language.modelProfiles.compatibilityProfile : '') ||
        resolved.profileId ||
        language.none
      parts.unshift(inheritedProfileName)
    } else if (binding.mode === 'legacy') {
      parts.unshift(language.modelProfiles.compatibilityProfile)
    }
    return parts.join(' · ')
  }

  function statusLabel(role: ModelRole): string {
    const status = uiState.roleStatuses[role]
    const bucket = language.modelProfiles.statusBuckets[status.bucket]
    if (status.reasons.length === 0) return bucket
    return `${bucket}: ${status.reasons.map((reason) => language.modelProfiles.statusReasons[reason] ?? reason).join(', ')}`
  }

  function fallbackCount(role: ModelRole): string {
    return language.modelRoles.fallbackCount(uiState.resolvedProfiles[role].fallbacks.length)
  }

  function profileOptionsForBinding(
    binding: ModelRoleProfileBinding,
  ): Array<{ kind: 'profile'; id: string; name: string } | { kind: 'divider'; id: string }> {
    const options = profileItems.map((item) =>
      item.kind === 'profile'
        ? { kind: 'profile' as const, id: item.profile.id, name: item.profile.name }
        : { kind: 'divider' as const, id: item.id },
    )
    if (binding.mode === 'profile' && binding.profileId && !profileIdSet.has(binding.profileId)) {
      options.push({
        kind: 'profile',
        id: binding.profileId,
        name: language.modelProfiles.missingProfile(binding.profileId),
      })
    }
    return options
  }

  function profileSelectValue(profileId: string): string {
    return `${PROFILE_SELECT_VALUE_PREFIX}${profileId}`
  }

  function bindingSelectValue(binding: ModelRoleProfileBinding): string {
    if (binding.mode === 'inherit') return INHERIT_SELECT_VALUE
    if (binding.mode === 'legacy') return LEGACY_SELECT_VALUE
    return profileSelectValue(binding.profileId)
  }

  function clearBindingFeedback(role: ModelRole): void {
    const timer = bindingFeedbackTimers.get(role)
    if (timer) clearTimeout(timer)
    bindingFeedbackTimers.delete(role)
    if (!bindingFeedback[role]) return

    const nextFeedback = { ...bindingFeedback }
    delete nextFeedback[role]
    bindingFeedback = nextFeedback
  }

  function showBindingFeedback(role: ModelRole, feedback: BindingFeedback): void {
    clearBindingFeedback(role)
    bindingFeedback = { ...bindingFeedback, [role]: feedback }
    bindingFeedbackTimers.set(
      role,
      setTimeout(() => {
        clearBindingFeedback(role)
      }, 2500),
    )
  }

  function bindingFeedbackLabel(feedback: BindingFeedback): string {
    return feedback === 'accepted' ? language.modelProfiles.bindingSaved : language.modelProfiles.bindingQueued
  }

  function setBinding(role: ModelRole, binding: ModelRoleProfileBinding): void {
    if (applying || applyQueued) return
    if (snapshotBinding(bindingFor(role)) === snapshotBinding(binding)) return
    clearBindingFeedback(role)
    draftBindings = {
      ...draftBindings,
      [role]: binding,
    }
    commandError = ''
    if (bindingCanBeSaved(role, binding)) void applyBinding(role, binding)
  }

  function restoreSelectValue(role: ModelRole, select: HTMLSelectElement, previousValue: string): void {
    select.value = previousValue
    profileSelectRevisions = {
      ...profileSelectRevisions,
      [role]: (profileSelectRevisions[role] ?? 0) + 1,
    }
  }

  function handleBindingChange(role: ModelRole, previousValue: string, event: Event): void {
    const select = event.currentTarget
    if (!(select instanceof HTMLSelectElement)) return
    if (isModelProfileDividerSelectValue(select.value)) {
      restoreSelectValue(role, select, previousValue)
      return
    }
    if (select.value === INHERIT_SELECT_VALUE) {
      setBinding(role, { mode: 'inherit' })
      return
    }
    if (select.value === LEGACY_SELECT_VALUE) {
      setBinding(role, { mode: 'legacy' })
      return
    }
    if (select.value.startsWith(PROFILE_SELECT_VALUE_PREFIX)) {
      const profileId = select.value.slice(PROFILE_SELECT_VALUE_PREFIX.length)
      if (profileId) {
        setBinding(role, { mode: 'profile', profileId })
        return
      }
    }
    restoreSelectValue(role, select, previousValue)
  }

  function restoreBindingsIfCurrent(bindings: Partial<Record<ModelRole, ModelRoleProfileBinding>>): void {
    const restored = cloneJsonValue(draftBindings)
    let changed = false
    for (const [rawRole, attemptedBinding] of Object.entries(bindings)) {
      if (!attemptedBinding) continue
      const role = rawRole as ModelRole
      if (snapshotBinding(restored[role]) !== snapshotBinding(attemptedBinding)) continue
      restored[role] = cloneJsonValue(serverBaselineBindings[role])
      changed = true
    }
    if (changed) draftBindings = restored
  }

  function commandErrorMessage(result: Exclude<ServerCommandResult, { status: 'ok' }>): string {
    return result.status === 'conflict'
      ? language.modelProfiles.commandConflict
      : result.status === 'error'
        ? result.error
        : language.modelProfiles.commandUnavailable
  }

  async function applyBinding(role: ModelRole, binding: ModelRoleProfileBinding): Promise<void> {
    applying = true
    commandError = ''
    const bindings: Partial<Record<ModelRole, ModelRoleProfileBinding>> = {
      [role]: cloneJsonValue(binding),
    }
    const modelPresetId = selectedModelPresetId()
    const pendingToken = beginPendingModelMutation('model-profiles', {
      kind: 'role-bindings',
      bindings,
    })
    if (!pendingToken) {
      restoreBindingsIfCurrent(bindings)
      applying = false
      return
    }
    try {
      const outcome = await updateModelRoleProfilesDurably(bindings, modelPresetId)
      if (outcome.status === 'accepted') {
        finishPendingModelMutation(pendingToken)
        showBindingFeedback(role, 'accepted')
        return
      }
      if (outcome.status === 'queued') {
        retainPendingModelMutation(pendingToken, outcome.mutationId)
        showBindingFeedback(role, 'queued')
        return
      }
      finishPendingModelMutation(pendingToken)
      commandError = commandErrorMessage(outcome.result)
      restoreBindingsIfCurrent(bindings)
    } catch {
      finishPendingModelMutation(pendingToken)
      commandError = commandErrorMessage({ status: 'unavailable' })
      restoreBindingsIfCurrent(bindings)
    } finally {
      applying = false
    }
  }

  onDestroy(() => {
    for (const timer of bindingFeedbackTimers.values()) clearTimeout(timer)
    bindingFeedbackTimers.clear()
  })
</script>

<section class="flex flex-col gap-3">
  <div class="mt-2 flex flex-col gap-1">
    <h3 class="text-lg font-semibold">{language.modelProfiles.rolesTabTitle}</h3>
    <span class="text-sm text-textcolor2">{language.modelProfiles.rolesTabDescription}</span>
  </div>

  {#if commandError}
    <div class="rounded-md border border-draculared p-3 text-sm text-draculared">{commandError}</div>
  {/if}
  <div class="flex flex-col gap-4">
    {#each roleGroups as group (group.key)}
      <section class="flex flex-col gap-2" aria-labelledby={`model-role-group-${group.key}`}>
        <h4 id={`model-role-group-${group.key}`} class="text-xs font-medium uppercase tracking-wide text-textcolor2">
          {language.modelProfiles.roleGroups[group.key]}
        </h4>
        {#each group.roles as role (role)}
          {@const binding = bindingFor(role)}
          {@const inheritedSource = modelRoleProfileInheritSource(role)}
          {@const selectValue = bindingSelectValue(binding)}
          {@const feedback = bindingFeedback[role]}
          <article
            class="flex min-w-0 flex-col gap-3 rounded-md border border-darkborderc p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span class="font-medium">{roleLabel(role)}</span>
                {#if uiState.roleStatuses[role].bucket !== 'ready'}
                  <span class="text-xs text-yellow-300">{statusLabel(role)}</span>
                {/if}
                {#if uiState.resolvedProfiles[role].fallbacks.length > 0}
                  <span class="text-xs text-textcolor2 sm:ml-auto">{fallbackCount(role)}</span>
                {/if}
              </div>
              <p class="mt-0.5 text-xs text-textcolor2">{roleDescription(role)}</p>
              <p class="mt-1 break-words text-xs text-textcolor2">{effectiveSummary(role)}</p>
            </div>
            <div
              class="flex w-full min-w-0 flex-col items-start gap-1 sm:w-auto sm:shrink-0 sm:flex-row sm:items-center sm:gap-2">
              <div class="w-full min-w-0 sm:w-64">
                {#key profileSelectRevisions[role] ?? 0}
                  <SelectInput
                    size="sm"
                    className="w-full min-w-0"
                    ariaLabel={`${roleLabel(role)}: ${language.modelProfiles.effectiveProfileColumn}`}
                    disabled={applying || applyQueued}
                    value={selectValue}
                    onchange={(event) => handleBindingChange(role, selectValue, event)}>
                    {#if inheritedSource}
                      <OptionInput value={INHERIT_SELECT_VALUE}
                        >{language.modelProfiles.sameAsRole(roleLabel(inheritedSource))}</OptionInput>
                    {/if}
                    {#each profileOptionsForBinding(binding) as profile (`${profile.kind}:${profile.id}`)}
                      {#if profile.kind === 'divider'}
                        <option
                          value={modelProfileDividerSelectValue(profile.id)}
                          data-model-profile-divider="true"
                          disabled>---</option>
                      {:else}
                        <OptionInput value={profileSelectValue(profile.id)}>{profile.name}</OptionInput>
                      {/if}
                    {/each}
                    {#if binding.mode === 'legacy' || !uiState.allRolesUseDurableProfiles}
                      <OptionInput value={LEGACY_SELECT_VALUE}
                        >{language.modelProfiles.bindingModes.legacy}</OptionInput>
                    {/if}
                  </SelectInput>
                {/key}
              </div>
              {#if feedback}
                <span role="status" class="shrink-0 text-xs text-textcolor2">
                  {bindingFeedbackLabel(feedback)}
                </span>
              {/if}
            </div>
          </article>
        {/each}
      </section>
    {/each}
  </div>
</section>
