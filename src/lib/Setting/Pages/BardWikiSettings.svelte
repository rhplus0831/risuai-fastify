<script lang="ts">
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
  import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
  import SegmentedControl from 'src/lib/UI/GUI/SegmentedControl.svelte'
  import { collectionsResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import { createServerBackedSettingDraft, type SettingPersistenceStatus } from 'src/ts/server/settingsOwner.svelte'
  import { alertConfirm } from 'src/ts/alert'
  import { canOpenBardWikiWorkspaceFromSettings, navigate, openBardWikiWorkspaceFromSettings } from 'src/ts/router'
  import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS, type BardWikiGlobalSettings } from '@risuai/protocol'

  let saveStatus = $state<SettingPersistenceStatus>('idle')
  const settings = createServerBackedSettingDraft<BardWikiGlobalSettings>(
    'bardWiki',
    {
      ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
    },
    {
      retainFailedDraft: true,
      onPersistenceStatus: (status) => {
        saveStatus = status
      },
    },
  )

  let modelProfiles = $derived(
    settingsResourceState.groupStatuses.providers === 'ready'
      ? uniqueRowsWithStableIds(settingsResourceState.value.modelProfiles)
      : [],
  )
  let promptPresets = $derived(
    collectionsResourceState.statuses.promptPresets === 'ready'
      ? uniqueRowsWithStableIds(collectionsResourceState.values.promptPresets)
      : [],
  )
  const memoryModeOptions = [
    { value: 'hypa', label: language.bardWiki.modeHypa },
    { value: 'bardwiki', label: language.bardWiki.modeBardWiki },
    { value: 'hybrid', label: language.bardWiki.modeHybrid },
  ]
  let usesBardWikiRetrieval = $derived(settings.value.memoryMode !== 'hypa')
  let requestedHybridBudget = $derived(settings.value.hybridHypaTokenBudget + settings.value.hybridBardWikiTokenBudget)
  let effectiveHybridHypaBudget = $derived(
    Math.min(settings.value.totalTokenBudget, settings.value.hybridHypaTokenBudget),
  )
  let effectiveHybridBardWikiBudget = $derived(
    Math.min(
      settings.value.hybridBardWikiTokenBudget,
      Math.max(0, settings.value.totalTokenBudget - effectiveHybridHypaBudget),
    ),
  )
  let hybridBudgetClamped = $derived(
    settings.value.memoryMode === 'hybrid' &&
      (effectiveHybridHypaBudget !== settings.value.hybridHypaTokenBudget ||
        effectiveHybridBardWikiBudget !== settings.value.hybridBardWikiTokenBudget),
  )
  let selectedModelName = $derived.by(() => {
    const id = settings.value.modelProfileId
    if (!id) return language.bardWiki.useRoleDefault
    const profile = modelProfiles.find((candidate) => candidate.id === id)
    return profile?.name || id
  })
  let modeDescription = $derived(
    settings.value.memoryMode === 'hypa'
      ? language.bardWiki.modeHypaDescription
      : settings.value.memoryMode === 'bardwiki'
        ? language.bardWiki.modeBardWikiDescription
        : language.bardWiki.modeHybridDescription,
  )
  let defaultSummary = $derived.by(() => {
    if (!settings.value.enabledByDefault) return language.bardWiki.summaryDisabled
    if (settings.value.memoryMode === 'hypa') return language.bardWiki.summaryHypa
    if (settings.value.memoryMode === 'bardwiki') {
      return language.bardWiki.summaryBardWiki(settings.value.totalTokenBudget, settings.value.maxDocuments)
    }
    return language.bardWiki.summaryHybrid(
      effectiveHybridHypaBudget,
      effectiveHybridBardWikiBudget,
      settings.value.maxDocuments,
    )
  })
  let updateSummary = $derived(
    settings.value.confirmationPolicy === 'automatic'
      ? language.bardWiki.summaryAutomaticUpdates(selectedModelName)
      : language.bardWiki.summaryManualUpdates,
  )
  const canOpenWorkspace = canOpenBardWikiWorkspaceFromSettings()

  function uniqueRowsWithStableIds(value: unknown): Array<{ id: string; name?: string }> {
    if (!Array.isArray(value)) return []
    const ids = new Set<string>()
    for (const row of value) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return []
      const id = (row as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return []
      ids.add(id)
    }
    return value as Array<{ id: string; name?: string }>
  }

  function updateSetting<Key extends keyof BardWikiGlobalSettings>(key: Key, value: BardWikiGlobalSettings[Key]): void {
    settings.value = { ...settings.value, [key]: value }
  }

  function numberValue(event: Event & { currentTarget: HTMLInputElement }): number {
    return event.currentTarget.valueAsNumber
  }

  async function resetRecommendedDefaults(): Promise<void> {
    if (!(await alertConfirm(language.bardWiki.resetRecommendedConfirm))) return
    settings.value = { ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS }
  }
</script>

<section class="flex flex-col gap-5 pb-4" data-risu-bardwiki-settings>
  <header class="flex flex-col gap-2">
    <h2 class="mt-2 text-2xl font-bold">{language.bardWiki.title}</h2>
    <p class="text-sm text-textcolor2">{language.bardWiki.description}</p>
  </header>

  <section
    class="flex flex-col gap-3 rounded-lg border border-darkborderc p-4"
    aria-labelledby="bardwiki-defaults-heading">
    <div>
      <h3 id="bardwiki-defaults-heading" class="m-0 text-lg font-semibold">{language.bardWiki.defaultBehavior}</h3>
      <p class="mt-1 text-sm text-textcolor2">{language.bardWiki.defaultBehaviorDescription}</p>
    </div>
    <div>
      <CheckInput
        check={settings.value.enabledByDefault}
        onChange={(enabled) => updateSetting('enabledByDefault', enabled)}
        name={language.bardWiki.enabledByDefault} />
      <p class="mt-1 pl-7 text-sm text-textcolor2">{language.bardWiki.enabledByDefaultDescription}</p>
    </div>
    <div class="rounded-md bg-darkbg p-3" aria-live="polite" data-testid="bardwiki-effective-summary">
      <p class="font-medium">{defaultSummary}</p>
      <p class="mt-1 text-sm text-textcolor2">{updateSummary}</p>
    </div>
  </section>

  <section
    class="flex flex-col gap-3 rounded-lg border border-darkborderc p-4"
    aria-labelledby="bardwiki-retrieval-heading">
    <div>
      <h3 id="bardwiki-retrieval-heading" class="m-0 text-lg font-semibold">{language.bardWiki.memoryInReplies}</h3>
      <p class="mt-1 text-sm text-textcolor2">{language.bardWiki.memoryInRepliesDescription}</p>
    </div>

    <fieldset class="m-0 min-w-0 border-0 p-0">
      <legend class="mb-2 font-medium">{language.bardWiki.memoryMode}</legend>
      <div class="bardwiki-memory-mode">
        <SegmentedControl
          bind:value={
            () => settings.value.memoryMode,
            (mode) => updateSetting('memoryMode', mode as BardWikiGlobalSettings['memoryMode'])
          }
          options={memoryModeOptions} />
      </div>
      <p class="text-sm text-textcolor2" data-testid="bardwiki-mode-description">{modeDescription}</p>
    </fieldset>

    {#if usesBardWikiRetrieval}
      <details class="group rounded-md border border-darkborderc" data-testid="bardwiki-advanced-retrieval">
        <summary class="cursor-pointer px-3 py-2 font-medium">{language.bardWiki.advancedRetrieval}</summary>
        <div class="grid grid-cols-1 gap-4 border-t border-darkborderc p-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-textcolor">
            <span>{language.bardWiki.totalTokenBudget}</span>
            <NumberInput
              min={0}
              max={32768}
              fullwidth
              ariaLabel={language.bardWiki.totalTokenBudget}
              value={settings.value.totalTokenBudget}
              onChange={(event) => updateSetting('totalTokenBudget', numberValue(event))} />
            <span class="text-xs text-textcolor2">{language.bardWiki.totalTokenBudgetDescription}</span>
          </label>

          <label class="flex flex-col gap-1 text-textcolor">
            <span>{language.bardWiki.maxDocuments}</span>
            <NumberInput
              min={1}
              max={32}
              fullwidth
              ariaLabel={language.bardWiki.maxDocuments}
              value={settings.value.maxDocuments}
              onChange={(event) => updateSetting('maxDocuments', numberValue(event))} />
            <span class="text-xs text-textcolor2">{language.bardWiki.maxDocumentsDescription}</span>
          </label>

          {#if settings.value.memoryMode === 'hybrid'}
            <label class="flex flex-col gap-1 text-textcolor">
              <span>{language.bardWiki.hybridHypaTokenBudget}</span>
              <NumberInput
                min={0}
                max={32768}
                fullwidth
                ariaLabel={language.bardWiki.hybridHypaTokenBudget}
                value={settings.value.hybridHypaTokenBudget}
                onChange={(event) => updateSetting('hybridHypaTokenBudget', numberValue(event))} />
            </label>
            <label class="flex flex-col gap-1 text-textcolor">
              <span>{language.bardWiki.hybridBardWikiTokenBudget}</span>
              <NumberInput
                min={0}
                max={32768}
                fullwidth
                ariaLabel={language.bardWiki.hybridBardWikiTokenBudget}
                value={settings.value.hybridBardWikiTokenBudget}
                onChange={(event) => updateSetting('hybridBardWikiTokenBudget', numberValue(event))} />
            </label>
            <div
              class="rounded-md p-3 text-sm sm:col-span-2"
              class:bg-amber-950={hybridBudgetClamped}
              class:text-amber-200={hybridBudgetClamped}
              class:bg-darkbg={!hybridBudgetClamped}
              class:text-textcolor2={!hybridBudgetClamped}
              role={hybridBudgetClamped ? 'alert' : 'status'}
              data-testid="bardwiki-hybrid-budget-status">
              <p>
                {language.bardWiki.hybridAllocationStatus(
                  settings.value.hybridHypaTokenBudget,
                  settings.value.hybridBardWikiTokenBudget,
                  requestedHybridBudget,
                  settings.value.totalTokenBudget,
                )}
              </p>
              {#if hybridBudgetClamped}
                <p class="mt-1">
                  {language.bardWiki.hybridAllocationClamped(effectiveHybridHypaBudget, effectiveHybridBardWikiBudget)}
                </p>
              {/if}
            </div>
          {/if}

          <label class="flex flex-col gap-1 text-textcolor">
            <span>{language.bardWiki.maxLinkHops}</span>
            <select
              class="rounded-md border border-darkborderc bg-transparent px-3 py-2"
              aria-label={language.bardWiki.maxLinkHops}
              value={settings.value.maxLinkHops}
              onchange={(event) => updateSetting('maxLinkHops', Number(event.currentTarget.value))}>
              <option class="bg-darkbg" value="0">{language.bardWiki.linkHopsNone}</option>
              <option class="bg-darkbg" value="1">{language.bardWiki.linkHopsDirect}</option>
              <option class="bg-darkbg" value="2">{language.bardWiki.linkHopsTwoLevels}</option>
            </select>
            <span class="text-xs text-textcolor2">{language.bardWiki.maxLinkHopsDescription}</span>
          </label>

          <label class="flex flex-col gap-1 text-textcolor">
            <span>{language.bardWiki.recentMessageCount}</span>
            <NumberInput
              min={1}
              max={50}
              fullwidth
              ariaLabel={language.bardWiki.recentMessageCount}
              value={settings.value.recentMessageCount}
              onChange={(event) => updateSetting('recentMessageCount', numberValue(event))} />
            <span class="text-xs text-textcolor2">{language.bardWiki.recentMessageCountDescription}</span>
          </label>
        </div>
      </details>
    {:else}
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-darkbg p-3">
        <p class="text-sm text-textcolor2">{language.bardWiki.hypaSettingsDescription}</p>
        <Button styled="outlined" size="sm" onclick={() => navigate('/settings/memory')}>
          {language.bardWiki.openHypaSettings}
        </Button>
      </div>
    {/if}
  </section>

  <section
    class="flex flex-col gap-4 rounded-lg border border-darkborderc p-4"
    aria-labelledby="bardwiki-updates-heading">
    <div>
      <h3 id="bardwiki-updates-heading" class="m-0 text-lg font-semibold">{language.bardWiki.backgroundUpdates}</h3>
      <p class="mt-1 text-sm text-textcolor2">{language.bardWiki.backgroundUpdatesDescription}</p>
    </div>

    <div>
      <CheckInput
        check={settings.value.confirmationPolicy === 'automatic'}
        onChange={(enabled) => updateSetting('confirmationPolicy', enabled ? 'automatic' : 'manual')}
        name={language.bardWiki.automaticConfirmation} />
      <p class="mt-1 pl-7 text-sm text-textcolor2">{language.bardWiki.automaticConfirmationDescription}</p>
    </div>

    <div>
      <CheckInput
        check={settings.value.canonicalUpdates}
        onChange={(enabled) => updateSetting('canonicalUpdates', enabled)}
        name={language.bardWiki.canonicalUpdates} />
      <p class="mt-1 pl-7 text-sm text-textcolor2">{language.bardWiki.canonicalUpdatesDescription}</p>
    </div>

    <label class="flex flex-col gap-1 text-textcolor" for="bardwiki-model-profile">
      <span>{language.bardWiki.modelProfile}</span>
      <select
        id="bardwiki-model-profile"
        class="rounded-md border border-darkborderc bg-transparent px-3 py-2"
        value={settings.value.modelProfileId ?? ''}
        onchange={(event) => {
          updateSetting('modelProfileId', event.currentTarget.value || null)
        }}>
        <option class="bg-darkbg" value="">{language.bardWiki.useRoleDefault}</option>
        {#each modelProfiles as profile}
          <option class="bg-darkbg" value={profile.id}>{profile.name || profile.id}</option>
        {/each}
      </select>
      <span class="text-xs text-textcolor2">{language.bardWiki.modelProfileDescription}</span>
    </label>

    <label class="flex flex-col gap-1 text-textcolor" for="bardwiki-prompt-preset">
      <span>{language.bardWiki.promptPreset}</span>
      <select
        id="bardwiki-prompt-preset"
        class="rounded-md border border-darkborderc bg-transparent px-3 py-2"
        value={settings.value.promptPresetId ?? ''}
        onchange={(event) => {
          updateSetting('promptPresetId', event.currentTarget.value || null)
        }}>
        <option class="bg-darkbg" value="">{language.bardWiki.useBuiltInPrompt}</option>
        {#each promptPresets as preset}
          <option class="bg-darkbg" value={preset.id}>{preset.name || preset.id}</option>
        {/each}
      </select>
      <span class="text-xs text-textcolor2">{language.bardWiki.promptPresetDescription}</span>
    </label>
  </section>

  <section
    class="flex flex-col gap-3 rounded-lg border border-darkborderc p-4"
    aria-labelledby="bardwiki-manage-heading">
    <div>
      <h3 id="bardwiki-manage-heading" class="m-0 text-lg font-semibold">{language.bardWiki.manageDocuments}</h3>
      <p class="mt-1 text-sm text-textcolor2">{language.bardWiki.manageDocumentsDescription}</p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <Button disabled={!canOpenWorkspace} styled="outlined" size="sm" onclick={openBardWikiWorkspaceFromSettings}>
        {language.bardWiki.openCurrentChatWorkspace}
      </Button>
      {#if !canOpenWorkspace}
        <span class="text-sm text-textcolor2">{language.bardWiki.workspaceUnavailableFromSettings}</span>
      {/if}
    </div>
  </section>

  <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-darkborderc pt-4">
    {#if saveStatus === 'failed'}
      <div class="flex flex-wrap items-center gap-2" role="alert">
        <p class="text-sm text-red-400">{language.bardWiki.saveFailed}</p>
        <Button styled="outlined" size="sm" onclick={() => settings.retryPersistence()}>{language.retry}</Button>
      </div>
    {:else}
      <p class="text-sm text-textcolor2" role="status" aria-live="polite">
        {saveStatus === 'saving'
          ? language.bardWiki.saving
          : saveStatus === 'queued'
            ? language.bardWiki.saveQueued
            : saveStatus === 'accepted'
              ? language.bardWiki.saved
              : language.bardWiki.autosave}
      </p>
    {/if}
    <Button styled="outlined" size="sm" onclick={() => void resetRecommendedDefaults()}>
      {language.bardWiki.resetRecommended}
    </Button>
  </footer>
</section>

<style>
  @media (max-width: 640px) {
    .bardwiki-memory-mode :global(.segmented-control-container) {
      width: 100%;
      align-items: stretch;
    }

    .bardwiki-memory-mode :global(.segmented-btn) {
      min-width: 0;
      flex: 1;
      white-space: normal;
      padding-inline: 8px;
    }
  }
</style>
