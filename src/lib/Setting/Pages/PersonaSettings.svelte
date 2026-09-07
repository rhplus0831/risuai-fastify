<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import { captureSelectedPersonaRecoveryDraft } from 'src/ts/persona'
  import { language } from 'src/lang'
  import BaseRoundedButton from 'src/lib/UI/BaseRoundedButton.svelte'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import Check from 'src/lib/UI/GUI/CheckInput.svelte'
  import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import { alertConfirm, alertNormal, alertSelect } from 'src/ts/alert'
  import { getCharImage } from 'src/ts/characters'
  import {
    beginPersonaReorder,
    changeUserPersonaWithOutcome,
    createNewUserPersonaWithOutcome,
    currentPersonaStateSnapshot,
    currentSelectedPersonaProjectionSnapshot,
    deleteSelectedUserPersonaWithOutcome,
    exportUserPersona,
    flushPendingSelectedPersonaUpdate,
    importUserPersona,
    isPersonaSettingsWatcherSuppressed,
    queueSelectedPersonaUpdate,
    reconcileSelectedPersonaProjectionEpoch,
    reorderUserPersonasByIndicesWithOutcome,
    selectUserImg,
    snapshotPersonaJson,
    updateSelectedPersonaDisplayName,
    updateSelectedPersonaField,
    updateSelectedPersonaLargePortrait,
    updateSelectedPersonaModules,
    type PersonaStateSnapshot,
    type PersonaPersistenceStatus,
  } from 'src/ts/persona'
  import Sortable from 'sortablejs/modular/sortable.core.esm.js'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { sleep, sortableOptions } from 'src/ts/util'
  import {
    captureCollectionProjectionEpoch,
    captureSettingsProjectionEpoch,
    collectionsResourceState,
    getPersonaOwnerStateSnapshot,
  } from 'src/ts/server/resourceState.svelte'
  import { getPersonaDisplayName } from 'src/ts/personaDisplayName'
  import { navigateToPersonaSettings } from 'src/ts/router'
  import { CircleCheckIcon } from '@lucide/svelte'

  let stb: Sortable = null
  let ele: HTMLDivElement = $state()
  let sorted = $state(0)
  let selectedId: string | null = null
  let personaWatcherInitialized = false
  let previousPersonaSnapshot = ''
  let previousPersonaState: PersonaStateSnapshot | null = null
  let previousPersonaCollectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
  let previousSettingsProjectionEpoch = captureSettingsProjectionEpoch()
  let structuralMutationPending = $state(false)
  let structuralMutationError = $state('')
  let moduleSearch = $state('')

  let personaOwner = $derived(getPersonaOwnerStateSnapshot())
  let personas = $derived(personaOwner?.personas ?? [])
  let modules = $derived(readModuleOwners())
  let selectedPersonaId = $derived(personaOwner?.selectedPersonaId ?? null)
  let selectedPersona = $derived(personas.find((persona) => persona.id === selectedPersonaId))
  let selectedPersonaProjection = $derived(currentSelectedPersonaProjectionSnapshot())

  function selectedPersonaModuleIds(): string[] {
    return Array.isArray(selectedPersona?.modules)
      ? selectedPersona.modules.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : []
  }

  function selectedPersonaProfile(field: 'name' | 'icon' | 'personaPrompt' | 'note'): string {
    if (field === 'name') return selectedPersonaProjection.username
    if (field === 'icon') return selectedPersonaProjection.userIcon
    if (field === 'personaPrompt') return selectedPersonaProjection.personaPrompt
    return selectedPersonaProjection.userNote
  }

  function linkablePersonaModules() {
    const query = moduleSearch.trim().toLocaleLowerCase()
    return modules
      .filter((module) => !module.mcp && (!query || module.name.toLocaleLowerCase().includes(query)))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  function toggleSelectedPersonaModule(moduleId: string): void {
    const current = selectedPersonaModuleIds()
    updateSelectedPersonaModules(
      current.includes(moduleId) ? current.filter((candidate) => candidate !== moduleId) : [...current, moduleId],
    )
  }

  async function runPersonaStructuralMutation(
    start: () => Promise<PersonaPersistenceStatus> | null,
  ): Promise<PersonaPersistenceStatus | null> {
    if (structuralMutationPending) return null
    structuralMutationPending = true
    structuralMutationError = ''
    try {
      const persistence = start()
      if (!persistence) {
        structuralMutationError = language.personaMutationFailed
        return 'failed'
      }
      const status = await persistence
      if (status === 'queued') alertNormal(language.personaMutationQueued)
      if (status === 'failed') structuralMutationError = language.personaMutationFailed
      return status
    } catch {
      structuralMutationError = language.personaMutationFailed
      return 'failed'
    } finally {
      structuralMutationPending = false
    }
  }

  $effect(() => {
    const personaCollectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const ownerProjectionChanged =
      personaCollectionProjectionEpoch !== previousPersonaCollectionProjectionEpoch ||
      settingsProjectionEpoch !== previousSettingsProjectionEpoch
    const current = snapshotPersonaJson(selectedPersonaProjection)
    if (!personaWatcherInitialized) {
      personaWatcherInitialized = true
      previousPersonaCollectionProjectionEpoch = personaCollectionProjectionEpoch
      previousSettingsProjectionEpoch = settingsProjectionEpoch
      previousPersonaSnapshot = current
      previousPersonaState = currentPersonaStateSnapshot()
      return
    }
    if (isPersonaSettingsWatcherSuppressed()) {
      previousPersonaCollectionProjectionEpoch = personaCollectionProjectionEpoch
      previousSettingsProjectionEpoch = settingsProjectionEpoch
      previousPersonaSnapshot = current
      previousPersonaState = currentPersonaStateSnapshot()
      return
    }
    if (ownerProjectionChanged) {
      if (Array.isArray(collectionsResourceState.values.personas)) {
        untrack(() => reconcileSelectedPersonaProjectionEpoch())
      }
      previousPersonaCollectionProjectionEpoch = personaCollectionProjectionEpoch
      previousSettingsProjectionEpoch = settingsProjectionEpoch
      previousPersonaSnapshot = snapshotPersonaJson(currentSelectedPersonaProjectionSnapshot())
      previousPersonaState = currentPersonaStateSnapshot()
      return
    }
    if (current === previousPersonaSnapshot) return
    const previous = previousPersonaState ?? currentPersonaStateSnapshot()
    previousPersonaSnapshot = current
    // One snapshot of the (still-unmutated) current state, reused as both the
    // next keystroke's rollback baseline and this command's attempted-state
    // guard, instead of cloning the personas array twice per keystroke. Both
    // consumers only read the snapshot, so sharing the reference is safe.
    const attempted = currentPersonaStateSnapshot()
    previousPersonaState = attempted
    untrack(() => queueSelectedPersonaUpdate(previous, attempted))
  })

  const createStb = () => {
    stb = Sortable.create(ele, {
      onStart: async () => {
        if (structuralMutationPending) return
        selectedId = beginPersonaReorder()
      },
      onEnd: async () => {
        let idx: number[] = []
        ele.querySelectorAll('[data-risu-idx]').forEach((e, i) => {
          idx.push(parseInt(e.getAttribute('data-risu-idx')))
        })
        await runPersonaStructuralMutation(() => reorderUserPersonasByIndicesWithOutcome(idx, selectedId))
        try {
          stb.destroy()
        } catch (error) {}
        sorted += 1
        await sleep(1)
        createStb()
      },
      ...sortableOptions,
    })
  }

  const unregisterWriterDraft = registerWriterDraftCapture(() => {
    const recovery = captureSelectedPersonaRecoveryDraft()
    if (!recovery) return null
    const labels: Record<string, string> = {
      username: language.name,
      displayName: language.displayName,
      personaPrompt: language.persona,
      userNote: language.note,
      userIcon: language.image,
      modules: language.modules,
      largePortrait: language.largePortrait,
    }
    return {
      key: `persona:${recovery.personaId}`,
      label: `${language.persona}: ${selectedPersona ? getPersonaDisplayName(selectedPersona) : recovery.personaId}`,
      fields: Object.entries(recovery.value).map(([key, value]) => ({
        label: labels[key] ?? key,
        value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      })),
      data: recovery.value,
      baseline: recovery.baseline,
    }
  })
  onDestroy(unregisterWriterDraft)

  onMount(createStb)

  onDestroy(() => {
    void flushPendingSelectedPersonaUpdate()
    if (stb) {
      try {
        stb.destroy()
      } catch (error) {}
    }
  })

  function readModuleOwners(): readonly PersonaModule[] {
    const ownerValue = collectionsResourceState.values.modules
    if (collectionsResourceState.statuses.modules === 'error') return []
    if (!Array.isArray(ownerValue)) return []

    const ids = new Set<string>()
    for (const candidate of ownerValue) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
      const module = candidate as PersonaModule
      if (
        typeof module.id !== 'string' ||
        module.id.trim() !== module.id ||
        module.id.length === 0 ||
        ids.has(module.id)
      ) {
        return []
      }
      if (typeof module.name !== 'string') return []
      ids.add(module.id)
    }
    return ownerValue as PersonaModule[]
  }

  interface PersonaModule {
    id: string
    name: string
    mcp?: unknown
  }
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.persona}</h2>

{#if structuralMutationError}
  <div class="mb-3 rounded-md border border-draculared p-3 text-sm text-draculared" role="alert">
    {structuralMutationError}
  </div>
{/if}

{#key sorted}
  <div
    class="p-4 rounded-md border-darkborderc border mb-2 flex-wrap flex gap-2 w-full max-w-full min-w-0"
    bind:this={ele}
    aria-busy={structuralMutationPending}>
    {#each personas as persona, i}
      <button
        aria-label={persona.name || `${language.persona} ${i + 1}`}
        aria-pressed={persona.id === selectedPersonaId}
        disabled={structuralMutationPending}
        data-risu-idx={i}
        onclick={async () => {
          const status = await runPersonaStructuralMutation(() => changeUserPersonaWithOutcome(i))
          if (status && status !== 'failed' && persona.id) navigateToPersonaSettings(persona.id)
        }}>
        {#if persona.icon === ''}
          <div
            class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
            class:ring-3={persona.id === selectedPersonaId}>
          </div>
        {:else}
          {#await getCharImage(persona.icon, 'css')}
            <div
              class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
              class:ring-3={persona.id === selectedPersonaId}>
            </div>
          {:then im}
            <div
              class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
              style={im}
              class:ring-3={persona.id === selectedPersonaId}>
            </div>
          {/await}
        {/if}
      </button>
    {/each}
    <div class="flex justify-center items-center ml-2 mr-2">
      <BaseRoundedButton
        isDisabled={structuralMutationPending}
        ariaLabel={`${language.add} ${language.persona}`}
        onClick={async () => {
          const selection = await alertSelect([language.createfromScratch, language.importCharacter])
          if (selection === null) return
          const sel = Number(selection)
          if (sel === 0) {
            await runPersonaStructuralMutation(() => createNewUserPersonaWithOutcome().persistence)
          } else if (sel === 1) {
            await importUserPersona()
          }
        }}
        ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
          ><path
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
      </BaseRoundedButton>
    </div>
  </div>
{/key}

<div class="flex w-full items-starts rounded-md border-darkborderc border p-4 max-w-full flex-wrap">
  <div class="flex flex-col mt-4 mr-4">
    <button
      aria-label={language.userIcon}
      onclick={() => {
        selectUserImg()
      }}>
      {#if selectedPersonaProfile('icon') === ''}
        <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"></div>
      {:else}
        {#await getCharImage(selectedPersonaProfile('icon'), selectedPersona?.largePortrait ? 'lgcss' : 'css')}
          <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"></div>
        {:then im}
          <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500" style={im}>
          </div>
        {/await}
      {/if}
    </button>
  </div>
  <div class="flex grow flex-col p-2 max-w-full">
    <span class="text-sm text-textcolor2">{language.name}</span>
    <TextInput
      marginBottom
      size="lg"
      placeholder="User"
      bind:value={() => selectedPersonaProfile('name'), (value) => updateSelectedPersonaField('username', value)} />
    <span class="text-sm text-textcolor2">{language.displayName}</span>
    <TextInput
      marginBottom
      size="lg"
      placeholder={language.displayName}
      bind:value={() => selectedPersona?.displayName ?? '', updateSelectedPersonaDisplayName} />
    <span class="text-sm text-textcolor2">{language.personaNote}</span>
    <TextAreaInput
      height="20"
      margin="bottom"
      bind:value={() => selectedPersonaProfile('note'), (value) => updateSelectedPersonaField('userNote', value)}
      placeholder={`Put unique notes for this persona here.\nExample: [Alternate Hunters persona]`} />
    <span class="text-sm text-textcolor2">{language.description}</span>
    <TextAreaInput
      autocomplete="off"
      bind:value={
        () => selectedPersonaProfile('personaPrompt'), (value) => updateSelectedPersonaField('personaPrompt', value)
      }
      placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`} />
    <div class="mt-4 flex flex-col gap-2">
      <span class="text-sm font-medium text-textcolor">{language.personaModuleLink}</span>
      <span class="text-sm text-textcolor2">{language.personaModuleLinkInfo}</span>
      <TextInput placeholder={language.search} ariaLabel={language.search} bind:value={moduleSearch} />
      <div class="max-h-64 overflow-y-auto rounded-md border border-darkborderc">
        {#if linkablePersonaModules().length === 0}
          <div class="p-3 text-sm text-textcolor2">{language.noLinkableModules}</div>
        {:else}
          {#each linkablePersonaModules() as personaModule, index}
            <button
              type="button"
              disabled={structuralMutationPending}
              class="flex w-full items-center gap-3 p-3 text-left text-textcolor hover:bg-selected disabled:opacity-60"
              class:border-t={index !== 0}
              class:border-darkborderc={index !== 0}
              aria-pressed={selectedPersonaModuleIds().includes(personaModule.id)}
              aria-label={`${language.personaModuleLink}: ${personaModule.name}`}
              onclick={() => toggleSelectedPersonaModule(personaModule.id)}>
              <CircleCheckIcon
                size={18}
                class={selectedPersonaModuleIds().includes(personaModule.id) ? 'text-blue-500' : 'text-textcolor2'} />
              <span class="min-w-0 grow truncate">{personaModule.name}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
    <div class="flex gap-2 mt-4 max-w-full flex-wrap">
      <Button onclick={exportUserPersona}>{language.export}</Button>
      <Button onclick={importUserPersona}>{language.import}</Button>

      <Button
        styled="danger"
        disabled={structuralMutationPending}
        onclick={async () => {
          if (personas.length === 1) {
            return
          }
          const targetPersonaId = selectedPersona?.id
          if (!targetPersonaId) return
          const d = await alertConfirm(`${language.removeConfirm}${getPersonaDisplayName(selectedPersona)}`)
          if (d) {
            await runPersonaStructuralMutation(() => deleteSelectedUserPersonaWithOutcome(targetPersonaId))
          }
        }}>{language.remove}</Button>
      <Check
        bind:check={() => selectedPersona?.largePortrait ?? false, (value) => updateSelectedPersonaLargePortrait(value)}
        >{language.largePortrait}</Check>
    </div>
  </div>
</div>
