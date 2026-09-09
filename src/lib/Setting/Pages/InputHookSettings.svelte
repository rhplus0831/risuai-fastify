<script lang="ts">
  import { ChevronRightIcon, PlusIcon, TrashIcon } from '@lucide/svelte'
  import { tick } from 'svelte'
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
  import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import {
    isModelProfileDividerSelectValue,
    modelProfileDividerSelectValue,
    modelProfileListItems,
    type ModelProfileRecord,
  } from 'src/ts/model/modelProfileRecords'
  import { createNonSecurityUuid } from 'src/ts/nonSecurityUuid'
  import { createServerBackedSettingDraft, type SettingPersistenceStatus } from 'src/ts/server/settingsOwner.svelte'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import { confirmSettingsItemRemoval } from 'src/ts/setting/confirmSettingsItemRemoval'
  import type { InputHook } from 'src/ts/storage/database.svelte'
  import { createDefaultInputHooks } from 'src/ts/storage/defaultPrompts'

  let saveStatus = $state<SettingPersistenceStatus>('idle')
  const inputHooksDraft = createServerBackedSettingDraft<InputHook[]>('inputHooks', createDefaultInputHooks(), {
    retainFailedDraft: true,
    onPersistenceStatus: (status) => {
      saveStatus = status
    },
  })
  const sectionId = $props.id()
  let newHookType = $state<InputHook['type']>('draft')
  let expandedPrompts = $state<Record<string, boolean>>({})
  let modelProfiles = $derived(
    settingsResourceState.groupStatuses.providers === 'ready' && settingsResourceState.groupStatuses.models === 'ready'
      ? readModelProfileOwners(settingsResourceState.value.modelProfiles)
      : [],
  )
  let modelProfileItems = $derived(
    settingsResourceState.groupStatuses.providers === 'ready' && settingsResourceState.groupStatuses.models === 'ready'
      ? hasUniqueModelProfileOrder(settingsResourceState.value.modelProfileOrder)
        ? modelProfileListItems(modelProfiles, settingsResourceState.value.modelProfileOrder)
        : []
      : [],
  )

  function readModelProfileOwners(value: unknown): ModelProfileRecord[] {
    if (!Array.isArray(value)) return []
    const ids = new Set<string>()
    for (const profile of value) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return []
      const id = (profile as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return []
      ids.add(id)
    }
    return value as ModelProfileRecord[]
  }

  function hasUniqueModelProfileOrder(value: unknown): boolean {
    if (value === undefined) return true
    if (!Array.isArray(value)) return false
    const ids = new Set<string>()
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
      const row = entry as { kind?: unknown; profileId?: unknown; id?: unknown }
      const id = row.kind === 'profile' ? row.profileId : row.kind === 'divider' ? row.id : undefined
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return false
      ids.add(id)
    }
    return true
  }

  function updateHooks(updater: (hooks: InputHook[]) => void): void {
    const hooks = inputHooksDraft.value.map((hook) => ({ ...hook }))
    updater(hooks)
    inputHooksDraft.value = hooks
  }

  function updateHook(id: string, patch: Partial<InputHook>): void {
    updateHooks((hooks) => {
      const index = hooks.findIndex((hook) => hook.id === id)
      if (index === -1) return
      hooks[index] = { ...hooks[index], ...patch }
    })
  }

  async function focusHookName(id: string): Promise<void> {
    await tick()
    const input = document.getElementById(`${sectionId}-name-${id}`)
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
  }

  async function addHook(): Promise<void> {
    const id = createNonSecurityUuid()
    updateHooks((hooks) => {
      hooks.push({
        id,
        name: newHookType === 'draft' ? language.inputHookTypeDraft : language.inputHookTypeBtw,
        type: newHookType,
        prompt: '',
        model: { mode: 'inheritOtherAx' },
        ...(newHookType === 'draft' ? { translation: false } : {}),
      })
    })
    expandedPrompts[id] = true
    await focusHookName(id)
  }

  function hookProfileId(hook: InputHook): string {
    return hook.model?.mode === 'modelProfile' && typeof hook.model.profileId === 'string' ? hook.model.profileId : ''
  }

  function handleHookModelChange(id: string, previousProfileId: string, event: Event): void {
    const select = event.currentTarget
    if (!(select instanceof HTMLSelectElement)) return
    if (isModelProfileDividerSelectValue(select.value)) {
      select.value = previousProfileId
      return
    }
    const profileId = select.value.trim()
    updateHook(id, {
      model: profileId ? { mode: 'modelProfile', profileId } : { mode: 'inheritOtherAx' },
    })
  }

  async function deleteHook(id: string): Promise<void> {
    const index = inputHooksDraft.value.findIndex((hook) => hook.id === id)
    const hook = inputHooksDraft.value[index]
    if (!hook || !confirmSettingsItemRemoval(hook.name)) return
    const nextId = (inputHooksDraft.value[index + 1] ?? inputHooksDraft.value[index - 1])?.id
    updateHooks((hooks) => {
      const currentIndex = hooks.findIndex((hook) => hook.id === id)
      if (currentIndex !== -1) hooks.splice(currentIndex, 1)
    })
    delete expandedPrompts[id]
    if (nextId) await focusHookName(nextId)
    else {
      await tick()
      document.getElementById(`${sectionId}-add`)?.querySelector('button')?.focus()
    }
  }

  function promptPreview(prompt: string): string {
    const firstReadableLine = prompt
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('<') && !line.startsWith('{{'))
    return (
      firstReadableLine ||
      (prompt.trim() ? language.inputHookSettings.promptConfigured : language.inputHookSettings.noPrompt)
    )
  }
</script>

<section class="flex flex-col gap-4" data-risu-input-hook-settings>
  <div class="flex flex-col gap-2">
    <h2 class="mt-2 text-2xl font-bold">{language.inputHooks}</h2>
    <p class="text-sm text-textcolor2">{language.inputHookSettings.description}</p>
  </div>

  <div class="flex flex-wrap items-end gap-3">
    <label class="flex flex-col gap-1">
      <span class="text-sm text-textcolor2">{language.inputHookSettings.newHookType}</span>
      <SelectInput bind:value={newHookType} ariaLabel={language.inputHookSettings.newHookType} className="min-h-11">
        <OptionInput value="draft">{language.inputHookTypeDraft}</OptionInput>
        <OptionInput value="btw">{language.inputHookTypeBtw}</OptionInput>
      </SelectInput>
    </label>
    <div id={`${sectionId}-add`}>
      <Button onclick={addHook} ariaLabel={language.inputHookAdd} className="min-h-11">
        <span class="inline-flex items-center gap-2"><PlusIcon size={16} />{language.inputHookAdd}</span>
      </Button>
    </div>
  </div>

  {#if saveStatus === 'failed'}
    <div class="flex flex-wrap items-center gap-2" role="alert">
      <p class="text-sm text-red-400">{language.inputHookSettings.saveFailed}</p>
      <Button styled="outlined" size="sm" className="min-h-11" onclick={() => inputHooksDraft.retryPersistence()}>
        {language.retry}
      </Button>
    </div>
  {:else}
    <p class="text-sm text-textcolor2" role="status" aria-live="polite">
      {saveStatus === 'saving'
        ? language.inputHookSettings.saving
        : saveStatus === 'queued'
          ? language.inputHookSettings.queued
          : saveStatus === 'accepted'
            ? language.inputHookSettings.saved
            : language.inputHookSettings.autosave}
    </p>
  {/if}

  {#each inputHooksDraft.value as hook (hook.id)}
    {@const hookId = hook.id}
    {@const promptOpen = expandedPrompts[hook.id] === true}
    {@const promptId = `${sectionId}-prompt-${hook.id}`}
    <article class="flex min-w-0 flex-col gap-3 rounded-md border border-darkborderc p-4" aria-label={hook.name}>
      <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(6rem,0.5fr)_minmax(0,1.25fr)] sm:items-end">
        <label class="flex min-w-0 flex-col gap-1">
          <span class="text-sm text-textcolor2">{language.inputHookName}</span>
          <TextInput
            fullwidth
            id={`${sectionId}-name-${hook.id}`}
            className="min-h-11"
            ariaLabel={language.inputHookName}
            bind:value={() => hook.name, (value) => updateHook(hook.id, { name: value })} />
        </label>
        <label class="flex min-w-0 flex-col gap-1">
          <span class="text-sm text-textcolor2">{language.type}</span>
          <SelectInput
            value={hook.type}
            ariaLabel={language.type}
            className="min-h-11 w-full"
            onchange={(event) => updateHook(hook.id, { type: event.currentTarget.value as InputHook['type'] })}>
            <OptionInput value="draft">{language.inputHookTypeDraft}</OptionInput>
            <OptionInput value="btw">{language.inputHookTypeBtw}</OptionInput>
          </SelectInput>
        </label>
        <label class="flex min-w-0 flex-col gap-1">
          <span class="text-sm text-textcolor2">{language.inputHookModel}</span>
          <select
            class="min-h-11 w-full min-w-0 rounded-md border border-darkborderc bg-transparent px-4 py-2 text-textcolor focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
            aria-label={`${language.inputHookModel}: ${hook.name}`}
            value={hookProfileId(hook)}
            onchange={(event) => handleHookModelChange(hook.id, hookProfileId(hook), event)}>
            <option value="">{language.inputHookInheritOtherAxModel}</option>
            {#each modelProfileItems as item (`${item.kind}:${item.kind === 'profile' ? item.profile.id : item.id}`)}
              {#if item.kind === 'divider'}
                <option value={modelProfileDividerSelectValue(item.id)} data-model-profile-divider="true">---</option>
              {:else}
                <option value={item.profile.id}>{item.profile.name ?? item.profile.id}</option>
              {/if}
            {/each}
          </select>
        </label>
      </div>

      {#if hook.type === 'draft'}
        <div>
          <CheckInput
            className="min-h-11"
            name={language.inputHookTranslation}
            check={hook.translation === true}
            onChange={(translation) => updateHook(hook.id, { translation })} />
          <p class="mt-1 text-sm text-textcolor2">{language.inputHookSettings.translationDescription}</p>
        </div>
      {/if}

      <div class="flex items-start justify-between gap-2">
        <button
          type="button"
          id={`${promptId}-toggle`}
          aria-label={`${language.inputHookPrompt}: ${hook.name}`}
          aria-expanded={promptOpen}
          aria-controls={`${promptId}-panel`}
          class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left text-textcolor hover:bg-darkbg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-borderc"
          onclick={() => (expandedPrompts[hook.id] = !promptOpen)}>
          <ChevronRightIcon size={16} class={`shrink-0 ${promptOpen ? 'rotate-90' : ''}`} />
          <span class="flex min-w-0 flex-col gap-1">
            <span>{language.inputHookPrompt}</span>
            {#if !promptOpen}
              <span class="truncate text-sm text-textcolor2">{promptPreview(hook.prompt)}</span>
            {/if}
          </span>
        </button>
        <Button
          styled="outlined"
          size="sm"
          className="min-h-11 shrink-0"
          ariaLabel={`${language.inputHookDelete}: ${hook.name}`}
          onclick={() => deleteHook(hook.id)}>
          <span class="inline-flex items-center gap-2"
            ><TrashIcon size={16} />{language.inputHookSettings.deleteAction}</span>
        </Button>
      </div>

      <div id={`${promptId}-panel`} hidden={!promptOpen} role="region" aria-labelledby={`${promptId}-toggle`}>
        <TextAreaInput
          id={promptId}
          fullwidth
          height="default"
          popupEditor={true}
          popupEditorContext={hookId}
          ariaLabel={`${language.inputHookPrompt}: ${hook.name}`}
          bind:value={() => hook.prompt, (value) => updateHook(hook.id, { prompt: value })} />
      </div>
    </article>
  {:else}
    <p class="rounded-md border border-darkborderc p-4 text-textcolor2">{language.inputHookSettings.empty}</p>
  {/each}
</section>
