<script lang="ts">
  import { onDestroy } from 'svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { XIcon, StarIcon, ClockIcon, UserIcon, ListIcon, SaveIcon, TrashIcon } from '@lucide/svelte'
  import {
    charactersResourceState,
    collectionsResourceState,
    getCharacterResourceOwner,
  } from 'src/ts/server/resourceState.svelte'
  import { loadoutModalStore } from 'src/ts/stores.svelte'
  import { applyLoadout, deleteLoadout, saveCurrentLoadout, toggleLoadoutFavorite, type Loadout } from 'src/ts/loadout'
  import { modalBackdropDismiss } from 'src/ts/gui/modalBackdropDismiss'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'
  import { language } from 'src/lang'
  import { alertConfirm, alertNormal } from 'src/ts/alert'

  type LoadoutApplyOption = 'modules' | 'globalVariables' | 'preset' | 'persona'

  let loadOptions: Record<LoadoutApplyOption, boolean> = $state({
    modules: true,
    globalVariables: true,
    preset: true,
    persona: true,
  })

  const loadOptionLabels: Record<LoadoutApplyOption, string> = {
    modules: language.loadoutModal.modules,
    globalVariables: language.loadoutModal.globalVariables,
    preset: language.loadoutModal.preset,
    persona: language.loadoutModal.persona,
  }

  let saveName = $state('')
  let applyingLoadoutId: string | null = $state(null)
  let savingLoadout = $state(false)
  let favoritingLoadoutId: string | null = $state(null)
  let deletingLoadoutId: string | null = $state(null)
  let deletingLoadout: Loadout | null = $state(null)
  let applyError = $state('')
  let operationBusy = $derived(
    applyingLoadoutId !== null || savingLoadout || favoritingLoadoutId !== null || deletingLoadoutId !== null,
  )

  function close() {
    if (operationBusy) return
    loadoutModalStore.open = false
  }

  function handleDialogKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  const RECENT_LIMIT = 3

  function uniqueLoadoutOwners(value: unknown): readonly Loadout[] | undefined {
    if (!Array.isArray(value)) return undefined

    const ids = new Set<string>()
    for (const loadout of value) {
      if (!loadout || typeof loadout !== 'object' || typeof loadout.id !== 'string' || !loadout.id.trim()) {
        return undefined
      }
      if (ids.has(loadout.id)) return undefined
      ids.add(loadout.id)
    }
    return value as Loadout[]
  }

  function readLoadoutOwners(): readonly Loadout[] | undefined {
    const ownerValue = collectionsResourceState.values.loadouts
    const ownerRows = uniqueLoadoutOwners(ownerValue)
    if (collectionsResourceState.statuses.loadouts === 'ready') return ownerRows ?? []
    return undefined
  }

  function readSelectedCharacterId(): string | undefined {
    if (charactersResourceState.status !== 'ready') return undefined
    const selected = charactersResourceState.characters[charactersResourceState.currentChar]
    return selected?.chaId && getCharacterResourceOwner(selected.chaId) === selected ? selected.chaId : undefined
  }

  function getSortedLoadouts(): Loadout[] {
    const owners = readLoadoutOwners()
    if (!owners) return []
    const loadouts = [...owners]
    if (deletingLoadout && !loadouts.some((loadout) => loadout.id === deletingLoadout?.id)) {
      loadouts.push(deletingLoadout)
    }
    return loadouts.sort((a, b) => b.lastUsed - a.lastUsed)
  }

  function getRecentLoadouts(): Loadout[] {
    return getSortedLoadouts().slice(0, RECENT_LIMIT)
  }

  function getCharacterLoadouts(): Loadout[] {
    const chaId = readSelectedCharacterId()
    if (!chaId) return []
    return getSortedLoadouts()
      .filter((l) => l.characterIds?.includes(chaId))
      .slice(0, RECENT_LIMIT)
  }

  function getFavoriteLoadouts(): Loadout[] {
    return getSortedLoadouts().filter((l) => l.favorite)
  }

  function getAllLoadouts(): Loadout[] {
    return getSortedLoadouts()
  }

  async function onSelect(loadout: Loadout) {
    if (operationBusy) return
    const apply = (Object.keys(loadOptions) as LoadoutApplyOption[]).filter((k) => loadOptions[k])
    applyingLoadoutId = loadout.id
    applyError = ''
    try {
      const status = await applyLoadout(loadout, apply)
      if (status === 'applied' || status === 'queued') {
        applyingLoadoutId = null
        if (status === 'queued') alertNormal(language.loadoutApplyQueued)
        close()
        return
      }
      applyError =
        status === 'preset-hydration-failed' ? language.loadoutPresetHydrationFailed : language.loadoutApplyFailed
    } catch {
      applyError = language.loadoutApplyFailed
    } finally {
      applyingLoadoutId = null
    }
  }

  async function saveLoadout(): Promise<void> {
    const originalName = saveName
    const name = saveName.trim()
    if (!name || operationBusy) return

    savingLoadout = true
    applyError = ''
    try {
      const result = await saveCurrentLoadout(name)
      if (result.status === 'accepted' || result.status === 'queued') {
        if (saveName === originalName) saveName = ''
        if (result.status === 'queued') alertNormal(language.loadoutSaveQueued)
        return
      }
      applyError = language.loadoutSaveFailed
    } catch {
      applyError = language.loadoutSaveFailed
    } finally {
      savingLoadout = false
    }
  }

  async function toggleFavorite(loadout: Loadout, e: MouseEvent): Promise<void> {
    e.stopPropagation()
    if (operationBusy) return

    favoritingLoadoutId = loadout.id
    applyError = ''
    try {
      const status = await toggleLoadoutFavorite(loadout.id)
      if (status === 'queued') {
        alertNormal(language.loadoutFavoriteQueued(loadout.name))
      } else if (status === 'failed' || status === 'not-found') {
        applyError = language.loadoutFavoriteFailed(loadout.name)
      }
    } catch {
      applyError = language.loadoutFavoriteFailed(loadout.name)
    } finally {
      favoritingLoadoutId = null
    }
  }

  function formatDate(ts: number): string {
    const d = new Date(ts)
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  async function removeLoadout(loadout: Loadout, event: MouseEvent): Promise<void> {
    event.stopPropagation()
    if (operationBusy) return
    deletingLoadoutId = loadout.id
    deletingLoadout = loadout
    applyError = ''
    try {
      if (!(await alertConfirm(language.loadoutModal.removeConfirm(loadout.name)))) return
      const status = await deleteLoadout(loadout.id)
      if (status === 'queued') {
        alertNormal(language.loadoutDeleteQueued(loadout.name))
      } else if (status === 'failed' || status === 'not-found') {
        applyError = language.loadoutDeleteFailed(loadout.name)
      }
    } catch {
      applyError = language.loadoutDeleteFailed(loadout.name)
    } finally {
      deletingLoadoutId = null
      deletingLoadout = null
    }
  }

  onDestroy(
    registerWriterDraftCapture(() => {
      if (!saveName) return null
      return $state.snapshot({
        key: `loadout:new:${readSelectedCharacterId() ?? 'global'}`,
        label: saveName,
        fields: [{ label: language.loadoutModal.preset, value: saveName }],
        data: { saveName, loadOptions },
        baseline: { saveName: '' },
      })
    }),
  )
</script>

{#snippet loadoutCard(loadout: Loadout)}
  {@const mutationPending = favoritingLoadoutId === loadout.id || deletingLoadoutId === loadout.id}
  <div
    class="flex items-center gap-1 rounded-md bg-textcolor/5 hover:bg-textcolor/10 transition-colors"
    aria-busy={mutationPending}
    data-risu-loadout-pending={mutationPending ? '' : undefined}>
    <button
      class="flex-1 min-w-0 text-left flex flex-col px-3 py-2.5 disabled:opacity-50"
      disabled={operationBusy}
      data-risu-loadout-action="apply"
      data-risu-loadout-id={loadout.id}
      onclick={() => onSelect(loadout)}>
      <span class="text-sm font-medium text-textcolor/90 truncate">{loadout.name}</span>
      <span class="flex items-center gap-2 mt-0.5 text-xs text-textcolor/40 flex-wrap">
        {#if loadout.presetName}
          <span>{language.loadoutModal.presetName(loadout.presetName)}</span>
        {/if}
        <span>{formatDate(loadout.lastUsed)}</span>
        {#if mutationPending}
          <span class="text-textcolor/60" role="status">{language.loading}...</span>
        {/if}
      </span>
    </button>
    <button
      class="shrink-0 pr-1 py-2.5 transition-colors {loadout.favorite
        ? 'text-yellow-400'
        : 'text-textcolor/20 hover:text-textcolor/50'}"
      disabled={operationBusy}
      onclick={(e) => toggleFavorite(loadout, e)}
      aria-label={loadout.favorite ? language.loadoutModal.removeFavorite : language.loadoutModal.addFavorite}
      title={loadout.favorite ? language.loadoutModal.removeFavorite : language.loadoutModal.addFavorite}>
      <StarIcon size={15} fill={loadout.favorite ? 'currentColor' : 'none'} />
    </button>
    <button
      class="shrink-0 pr-3 py-2.5 transition-colors hover:text-red-400/50 text-textcolor/20"
      disabled={operationBusy}
      onclick={(event) => removeLoadout(loadout, event)}
      aria-label={language.loadoutModal.remove}
      title={language.loadoutModal.remove}>
      <TrashIcon size={15} />
    </button>
  </div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  use:modalBackdropDismiss={close}
  data-modal-root
  class="fixed inset-0 z-40 bg-black/60 flex justify-center items-center">
  <div
    use:modalFocusTrap
    class="bg-darkbg rounded-lg flex flex-col w-full max-w-2xl max-h-[90vh] overflow-hidden shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="risu-loadout-modal-title"
    aria-busy={operationBusy}
    tabindex="-1"
    onkeydown={handleDialogKeydown}>
    <div class="flex items-center justify-between px-5 py-3 border-b border-textcolor/10 shrink-0">
      <span id="risu-loadout-modal-title" class="text-base font-semibold text-textcolor/90"
        >{language.loadoutModal.title}</span>
      <button
        data-modal-initial-focus
        class="text-textcolor/50 hover:text-textcolor/90 transition-colors"
        disabled={operationBusy}
        onclick={close}
        aria-label={language.close}>
        <XIcon size={18} />
      </button>
    </div>

    <div class="flex items-center gap-2 px-5 py-2.5 border-b border-textcolor/10 shrink-0 flex-wrap">
      <span class="text-xs text-textcolor/40 uppercase tracking-wider font-medium mr-1"
        >{language.loadoutModal.load}:</span>
      {#each Object.keys(loadOptions) as key}
        {@const k = key as LoadoutApplyOption}
        <button
          data-risu-loadout-option={k}
          aria-pressed={loadOptions[k]}
          class="px-2.5 py-1 rounded text-xs font-medium transition-colors {loadOptions[k]
            ? 'bg-textcolor/15 text-textcolor/90'
            : 'bg-textcolor/5 text-textcolor/30 hover:bg-textcolor/10 hover:text-textcolor/50'}"
          disabled={operationBusy}
          onclick={() => (loadOptions[k] = !loadOptions[k])}>
          {loadOptionLabels[k]}
        </button>
      {/each}
    </div>

    {#if operationBusy}
      <p class="px-5 pt-3 text-sm text-textcolor/60" role="status">{language.loading}...</p>
    {:else if applyError}
      <p class="px-5 pt-3 text-sm text-draculared" role="alert">{applyError}</p>
    {/if}

    <div class="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-5 break-any">
      {#if getRecentLoadouts().length > 0}
        <section>
          <div class="flex items-center gap-1.5 mb-2 text-textcolor/50 text-xs uppercase tracking-wider font-medium">
            <ClockIcon size={13} />
            <span>{language.loadoutModal.recentlyUsed}</span>
          </div>
          <div class="flex flex-col gap-1">
            {#each getRecentLoadouts() as loadout (loadout.id)}
              {@render loadoutCard(loadout)}
            {/each}
          </div>
        </section>
      {/if}

      {#if getCharacterLoadouts().length > 0}
        <section>
          <div class="flex items-center gap-1.5 mb-2 text-textcolor/50 text-xs uppercase tracking-wider font-medium">
            <UserIcon size={13} />
            <span>{language.loadoutModal.recentlyUsedWithCharacter}</span>
          </div>
          <div class="flex flex-col gap-1">
            {#each getCharacterLoadouts() as loadout (loadout.id)}
              {@render loadoutCard(loadout)}
            {/each}
          </div>
        </section>
      {/if}

      {#if getFavoriteLoadouts().length > 0}
        <section>
          <div class="flex items-center gap-1.5 mb-2 text-yellow-400/70 text-xs uppercase tracking-wider font-medium">
            <StarIcon size={13} />
            <span>{language.loadoutModal.favorites}</span>
          </div>
          <div class="flex flex-col gap-1">
            {#each getFavoriteLoadouts() as loadout (loadout.id)}
              {@render loadoutCard(loadout)}
            {/each}
          </div>
        </section>
      {/if}

      <section>
        <div class="flex items-center gap-1.5 mb-2 text-textcolor/50 text-xs uppercase tracking-wider font-medium">
          <ListIcon size={13} />
          <span>{language.loadoutModal.all}</span>
        </div>
        {#if getAllLoadouts().length === 0}
          <p class="text-textcolor/30 text-sm px-1">{language.loadoutModal.empty}</p>
        {:else}
          <div class="flex flex-col gap-1">
            {#each getAllLoadouts() as loadout (loadout.id)}
              {@render loadoutCard(loadout)}
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <div class="flex items-center gap-2 px-5 py-3 border-t border-textcolor/10 shrink-0">
      <input
        type="text"
        aria-label={`${language.loadout} ${language.name}`}
        bind:value={saveName}
        placeholder={language.loadoutModal.namePlaceholder}
        disabled={operationBusy}
        class="flex-1 min-w-0 bg-textcolor/5 hover:bg-textcolor/8 focus:bg-textcolor/10 border border-textcolor/10 focus:border-textcolor/25 rounded px-3 py-1.5 text-sm text-textcolor/80 placeholder:text-textcolor/25 outline-none transition-colors" />
      <button
        class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded bg-textcolor/10 hover:bg-textcolor/15 text-textcolor/70 hover:text-textcolor/90 text-sm font-medium transition-colors disabled:opacity-30 disabled:pointer-events-none"
        disabled={!saveName.trim() || operationBusy}
        data-risu-loadout-action="save"
        onclick={saveLoadout}>
        <SaveIcon size={14} />
        {language.save}
      </button>
    </div>
  </div>
</div>

<style>
  .break-any {
    word-break: normal;
    overflow-wrap: anywhere;
  }
</style>
