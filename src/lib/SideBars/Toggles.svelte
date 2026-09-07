<script lang="ts">
  import { onDestroy } from 'svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { MobileGUI, selectedCharID } from 'src/ts/stores.svelte'
  import { language } from 'src/lang'
  import { alertError, alertNormal } from 'src/ts/alert'
  import type { character } from 'src/ts/storage/database.svelte'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import CheckInput from '../UI/GUI/CheckInput.svelte'
  import SelectInput from '../UI/GUI/SelectInput.svelte'
  import OptionInput from '../UI/GUI/OptionInput.svelte'
  import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'
  import TextInput from '../UI/GUI/TextInput.svelte'
  import Accordion from '../UI/Accordion.svelte'
  import ChatGenerationSettingsControls from './ChatGenerationSettingsControls.svelte'
  import ChatGenerationResetDefaultsButton from './ChatGenerationResetDefaultsButton.svelte'
  import ChatGenerationTogglePresets from './ChatGenerationTogglePresets.svelte'
  import ChatDraftHookSelector from './ChatDraftHookSelector.svelte'
  import ChatTranslationSettings from './ChatTranslationSettings.svelte'
  import CustomSideBar from './CustomSidebar.svelte'
  import { getChatGenerationTogglePresets } from 'src/ts/chatGenerationTogglePresets'
  import { compareChatGenerationTogglePresetToActiveState } from 'src/ts/chatGenerationTogglePresetPlanning'
  import { setCharacterSupaMemoryWithOutcome } from 'src/ts/characterCommands'
  import {
    ensureActiveChatSidebarToggleDefaults,
    resolveActiveChatGenerationSettings,
    saveActiveChatJailbreakToggleGenerationSettingsWithOutcome,
    saveActiveChatSidebarToggleGenerationSettingsWithOutcome,
  } from 'src/ts/activeChatGenerationSettings'
  import type { ChatGenerationSettingsSaveOperation } from 'src/ts/chatCommands'
  import type {
    ChatGenerationDisplayedSidebarToggle,
    ChatGenerationRequiredSidebarToggle,
    ChatGenerationSidebarToggleLayout,
  } from 'src/ts/chatGenerationSettings'

  type GroupedSidebarToggleGroup = Omit<ChatGenerationSidebarToggleLayout, 'kind'> & {
    kind: 'group'
    children: GroupedSidebarToggle[]
  }

  type GroupedSidebarToggleLayout = Omit<ChatGenerationSidebarToggleLayout, 'kind'> & {
    kind: Exclude<ChatGenerationSidebarToggleLayout['kind'], 'group'>
  }

  type GroupedSidebarToggle =
    | ChatGenerationRequiredSidebarToggle
    | GroupedSidebarToggleLayout
    | GroupedSidebarToggleGroup

  interface Props {
    chara?: character
    noContainer?: boolean
  }

  let { chara, noContainer }: Props = $props()

  type CharacterToggleField = 'supaMemory'
  type CharacterToggleStatus = 'idle' | 'queued' | 'failed'
  let characterToggleAttempts = $state<Record<CharacterToggleField, number>>({
    supaMemory: 0,
  })
  let characterTogglePending = $state<Record<CharacterToggleField, boolean>>({
    supaMemory: false,
  })
  let characterToggleStatus = $state<Record<CharacterToggleField, CharacterToggleStatus>>({
    supaMemory: 'idle',
  })
  let generationSettingsSaveOperation = 0
  let generationSettingsSaveStates = $state<
    Record<string, { operation: number; status: 'pending' | 'queued' | 'failed'; attempted: string | boolean }>
  >({})
  let toggleDrafts = $state<Record<string, string>>({})
  const toggleRecoveryBaselines: Record<string, string> = {}
  let focusedToggleDraftKey = $state<string | null>(null)

  let activeGenerationSettings = $derived.by(() =>
    resolveActiveChatGenerationSettings({
      selectedCharIndex: $selectedCharID,
    }),
  )
  let hypaV3Enabled = $derived(
    settingsResourceState.status !== 'error' &&
      settingsResourceState.groupStatuses.memory === 'ready' &&
      settingsResourceState.value.hypaV3 === true,
  )

  let hasJailbreakPrompt = $derived.by(() => activeGenerationSettings.readiness.requirements.jailbreakToggle.displayed)

  let displayedSidebarToggles = $derived.by(() => groupSidebarToggles(activeGenerationSettings.displayedSidebarToggles))
  let togglePresets = $derived.by(() => getChatGenerationTogglePresets())
  let loadedTogglePresetId = $derived(activeGenerationSettings.settings?.togglePresetId?.trim() ?? '')
  let selectedTogglePreset = $derived.by(() => togglePresets.find((preset) => preset.id === loadedTogglePresetId))
  let selectedTogglePresetComparison = $derived.by(() =>
    selectedTogglePreset
      ? compareChatGenerationTogglePresetToActiveState(selectedTogglePreset, activeGenerationSettings)
      : null,
  )

  $effect(() => {
    ensureActiveChatSidebarToggleDefaults(activeGenerationSettings)
  })

  $effect(() => {
    for (const toggle of activeGenerationSettings.displayedSidebarToggles) {
      if ((toggle.kind === 'text' || toggle.kind === 'textarea') && toggle.key) {
        const draftKey = getToggleDraftKey(toggle.key)
        if (focusedToggleDraftKey !== draftKey) {
          toggleDrafts[draftKey] = activeGenerationSettings.settings?.sidebarToggles?.[toggle.key] ?? ''
        }
      }
    }
  })

  function getJailbreakToggleValue(): boolean {
    return activeGenerationSettings.settings?.jailbreakToggle === true
  }

  function trackGenerationSettingsSave(
    field: string,
    attempted: string | boolean,
    save: () => ChatGenerationSettingsSaveOperation | null,
  ): void {
    const chatId = activeGenerationSettings.identity.chatId
    if (!chatId) return
    const stateKey = `${chatId}\u0000${field}`
    if (
      generationSettingsSaveStates[stateKey]?.status === 'pending' &&
      generationSettingsSaveStates[stateKey]?.attempted === attempted
    ) {
      return
    }
    const operation = ++generationSettingsSaveOperation
    generationSettingsSaveStates[stateKey] = { operation, status: 'pending', attempted }
    const persistence = save()
    if (!persistence) {
      if (generationSettingsSaveStates[stateKey]?.operation === operation) delete generationSettingsSaveStates[stateKey]
      return
    }
    void persistence.settlement.then((result) => {
      if (generationSettingsSaveStates[stateKey]?.operation !== operation) return
      if (result.status === 'accepted') {
        delete generationSettingsSaveStates[stateKey]
        return
      }
      generationSettingsSaveStates[stateKey].status = result.status
      if (result.status === 'queued') {
        alertNormal(language.settingsSaveQueued)
      } else {
        alertError(language.chatGenerationSettingsSaveFailed(result.error))
      }
    })
  }

  function generationSettingsPersistenceStatus(field: string): 'idle' | 'pending' | 'queued' | 'failed' {
    const chatId = activeGenerationSettings.identity.chatId
    return (chatId && generationSettingsSaveStates[`${chatId}\u0000${field}`]?.status) || 'idle'
  }

  function generationSettingsSavePending(field: string): boolean {
    return generationSettingsPersistenceStatus(field) === 'pending'
  }

  function setJailbreakToggleValue(value: boolean): void {
    trackGenerationSettingsSave('jailbreakToggle', value, () =>
      saveActiveChatJailbreakToggleGenerationSettingsWithOutcome(value),
    )
  }

  function getToggleValue(key: string): string {
    return activeGenerationSettings.settings?.sidebarToggles?.[key] ?? ''
  }

  function getToggleDraftKey(key: string): string {
    return `${activeGenerationSettings.identity.chatId ?? ''}\u0000${key}`
  }

  function getToggleDraft(key: string): string {
    const draftKey = getToggleDraftKey(key)
    return draftKey in toggleDrafts ? toggleDrafts[draftKey] : getToggleValue(key)
  }

  function setToggleDraft(key: string, value: string): void {
    const draftKey = getToggleDraftKey(key)
    toggleRecoveryBaselines[draftKey] ??= getToggleValue(key)
    toggleDrafts[draftKey] = value
  }

  function commitToggleDraft(key: string): void {
    setToggleValue(key, getToggleDraft(key))
  }

  function focusToggleDraft(key: string): void {
    focusedToggleDraftKey = getToggleDraftKey(key)
  }

  function blurToggleDraft(key: string, event: FocusEvent & { currentTarget: HTMLElement }): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    const draftKey = getToggleDraftKey(key)
    if (focusedToggleDraftKey === draftKey) focusedToggleDraftKey = null
  }

  function setToggleValue(key: string, value: string): void {
    trackGenerationSettingsSave(`sidebarToggles.${key}`, value, () =>
      saveActiveChatSidebarToggleGenerationSettingsWithOutcome(key, value),
    )
  }

  async function setSupaMemoryValue(value: boolean): Promise<void> {
    if (!chara?.chaId) return
    const characterId = chara.chaId
    const attempt = ++characterToggleAttempts.supaMemory
    characterTogglePending.supaMemory = true
    characterToggleStatus.supaMemory = 'idle'
    const outcome = await setCharacterSupaMemoryWithOutcome(characterId, value)
    settleCharacterToggle('supaMemory', characterId, attempt, outcome?.status)
  }

  function settleCharacterToggle(
    field: CharacterToggleField,
    characterId: string,
    attempt: number,
    status: 'accepted' | 'queued' | 'failed' | undefined,
  ): void {
    if (chara?.chaId !== characterId || characterToggleAttempts[field] !== attempt) return
    characterTogglePending[field] = false
    characterToggleStatus[field] = status === 'queued' ? 'queued' : status === 'failed' ? 'failed' : 'idle'
    if (status === 'queued') {
      alertNormal(language.hypaMemoryMutationQueued)
    } else if (status === 'failed') {
      alertError(language.hypaMemoryMutationFailed)
    }
  }

  function isSidebarTogglePresetDifferent(key: string): boolean {
    return selectedTogglePresetComparison?.differingSidebarToggleKeys.has(key) === true
  }

  function groupSidebarToggles(items: ChatGenerationDisplayedSidebarToggle[]): GroupedSidebarToggle[] {
    const grouped: GroupedSidebarToggle[] = []
    const stack: GroupedSidebarToggleGroup[] = []

    for (const item of items) {
      if (item.kind === 'group') {
        const group: GroupedSidebarToggleGroup = { ...item, kind: 'group', children: [] }
        appendGroupedToggle(grouped, stack, group)
        stack.push(group)
        continue
      }
      if (item.kind === 'groupEnd') {
        stack.pop()
        continue
      }
      appendGroupedToggle(grouped, stack, item as GroupedSidebarToggle)
    }

    return grouped
  }

  function appendGroupedToggle(
    grouped: GroupedSidebarToggle[],
    stack: GroupedSidebarToggleGroup[],
    item: GroupedSidebarToggle,
  ): void {
    const parent = stack.at(-1)
    if (parent) {
      parent.children.push(item)
    } else {
      grouped.push(item)
    }
  }

  function groupedToggleIdentity(toggle: GroupedSidebarToggle): unknown[] {
    return [
      toggle.source,
      toggle.presetId ?? '',
      toggle.moduleId ?? '',
      toggle.moduleNamespace ?? '',
      toggle.kind,
      toggle.key ?? '',
      toggle.label,
      toggle.kind === 'group' ? toggle.children.map(groupedToggleIdentity) : [],
    ]
  }

  function groupedToggleGroupKey(toggle: GroupedSidebarToggleGroup): string {
    return JSON.stringify(groupedToggleIdentity(toggle))
  }

  onDestroy(
    registerWriterDraftCapture(() => {
      const drafts = Object.fromEntries(
        Object.entries(toggleDrafts).filter(([draftKey, value]) => {
          const [chatId, key] = draftKey.split('\u0000')
          const baseline =
            chatId === activeGenerationSettings.identity.chatId
              ? getToggleValue(key)
              : toggleRecoveryBaselines[draftKey]
          return value !== baseline
        }),
      )
      if (Object.keys(drafts).length === 0) return null
      return $state.snapshot({
        key: `sidebar-toggles:${chara?.chaId ?? activeGenerationSettings.identity.chatId ?? 'global'}`,
        label: chara?.name || language.model,
        fields: Object.entries(drafts).map(([key, value]) => ({ label: key.replace('\u0000', ' / '), value })),
        data: { drafts },
        baseline: { drafts: toggleRecoveryBaselines },
      })
    }),
  )
</script>

{#snippet toggles(items: GroupedSidebarToggle[], reverse: boolean = false)}
  {#each items as toggle, index}
    {#if toggle.kind === 'group'}
      {#if toggle.children.length > 0}
        {#key groupedToggleGroupKey(toggle)}
          <div class="w-full" data-risu-generation-toggle-group data-risu-toggle-label={toggle.label}>
            <Accordion styled name={toggle.label}>
              {@render toggles(toggle.children, reverse)}
            </Accordion>
          </div>
        {/key}
      {/if}
    {:else if toggle.kind === 'caption'}
      <div class="w-full mt-1 text-xs text-textcolor2" data-risu-generation-toggle-caption>
        {toggle.label}
      </div>
    {:else if toggle.kind === 'divider'}
      {#if index === 0 || items[index - 1]?.kind !== 'divider' || items[index - 1]?.label !== toggle.label}
        <div class="w-full min-h-5 flex gap-2 mt-2 items-center" class:justify-end={!reverse}>
          {#if toggle.label}
            <span class="shrink-0">{toggle.label}</span>
          {/if}
          <hr class="border-t border-darkborderc m-0 grow" />
        </div>
      {/if}
    {:else if toggle.kind === 'groupEnd'}
      <!-- groupEnd only closes groups while building the display tree. -->
    {:else if toggle.kind === 'select'}
      <div
        class="w-full flex gap-2 mt-2 items-center"
        class:justify-end={$MobileGUI}
        data-risu-generation-toggle-control
        data-risu-toggle-key={toggle.key}
        data-risu-toggle-kind={toggle.kind}
        data-risu-input-kind="select"
        data-risu-persistence-status={generationSettingsPersistenceStatus(`sidebarToggles.${toggle.key}`)}
        data-risu-toggle-preset-different={isSidebarTogglePresetDifferent(toggle.key) ? 'true' : 'false'}
        class:bg-red-900={isSidebarTogglePresetDifferent(toggle.key)}
        class:rounded-sm={isSidebarTogglePresetDifferent(toggle.key)}>
        <span>{toggle.label}</span>
        <SelectInput
          className="w-32"
          ariaLabel={toggle.label}
          disabled={generationSettingsSavePending(`sidebarToggles.${toggle.key}`)}
          bind:value={() => getToggleValue(toggle.key), (value) => setToggleValue(toggle.key, String(value))}>
          {#each toggle.options as option, i}
            <OptionInput value={i.toString()}>{option}</OptionInput>
          {/each}
        </SelectInput>
      </div>
    {:else if toggle.kind === 'text'}
      <div
        class="w-full flex gap-2 mt-2 items-center"
        class:justify-end={$MobileGUI}
        onfocusin={() => focusToggleDraft(toggle.key)}
        onfocusout={(event) => blurToggleDraft(toggle.key, event)}
        data-risu-generation-toggle-control
        data-risu-toggle-key={toggle.key}
        data-risu-toggle-kind={toggle.kind}
        data-risu-input-kind="text"
        data-risu-persistence-status={generationSettingsPersistenceStatus(`sidebarToggles.${toggle.key}`)}
        data-risu-toggle-preset-different={isSidebarTogglePresetDifferent(toggle.key) ? 'true' : 'false'}
        class:bg-red-900={isSidebarTogglePresetDifferent(toggle.key)}
        class:rounded-sm={isSidebarTogglePresetDifferent(toggle.key)}>
        <span>{toggle.label}</span>
        <TextInput
          className="w-32"
          ariaLabel={toggle.label}
          onchange={() => commitToggleDraft(toggle.key)}
          bind:value={() => getToggleDraft(toggle.key), (value) => setToggleDraft(toggle.key, value)} />
      </div>
    {:else if toggle.kind === 'textarea'}
      <div
        class="w-full flex gap-2 mt-2 items-start"
        class:justify-end={$MobileGUI}
        onfocusin={() => focusToggleDraft(toggle.key)}
        onfocusout={(event) => blurToggleDraft(toggle.key, event)}
        data-risu-generation-toggle-control
        data-risu-toggle-key={toggle.key}
        data-risu-toggle-kind={toggle.kind}
        data-risu-input-kind="textarea"
        data-risu-persistence-status={generationSettingsPersistenceStatus(`sidebarToggles.${toggle.key}`)}
        data-risu-toggle-preset-different={isSidebarTogglePresetDifferent(toggle.key) ? 'true' : 'false'}
        class:bg-red-900={isSidebarTogglePresetDifferent(toggle.key)}
        class:rounded-sm={isSidebarTogglePresetDifferent(toggle.key)}>
        <span class="mt-1.5">{toggle.label}</span>
        <TextAreaInput
          className="w-32"
          height="20"
          ariaLabel={toggle.label}
          onchange={() => commitToggleDraft(toggle.key)}
          bind:value={() => getToggleDraft(toggle.key), (value) => setToggleDraft(toggle.key, value)} />
      </div>
    {:else}
      <div
        class="w-full flex mt-2 items-center"
        class:justify-end={$MobileGUI}
        data-risu-generation-toggle-control
        data-risu-toggle-key={toggle.key}
        data-risu-toggle-kind={toggle.kind}
        data-risu-input-kind="checkbox"
        data-risu-persistence-status={generationSettingsPersistenceStatus(`sidebarToggles.${toggle.key}`)}
        data-risu-selected={getToggleValue(toggle.key) === '1' ? 'true' : 'false'}
        data-risu-toggle-preset-different={isSidebarTogglePresetDifferent(toggle.key) ? 'true' : 'false'}
        class:bg-red-900={isSidebarTogglePresetDifferent(toggle.key)}
        class:rounded-sm={isSidebarTogglePresetDifferent(toggle.key)}>
        <CheckInput
          check={getToggleValue(toggle.key) === '1'}
          disabled={generationSettingsSavePending(`sidebarToggles.${toggle.key}`)}
          {reverse}
          name={toggle.label}
          onChange={(check) => {
            setToggleValue(toggle.key, check ? '1' : '0')
          }} />
      </div>
    {/if}
  {/each}
{/snippet}

{#if !noContainer && displayedSidebarToggles.length > 4}
  <div class="border-darkborderc p-2 border rounded-sm flex flex-col items-start mt-2">
    <ChatGenerationSettingsControls />
    <CustomSideBar />

    {#if hasJailbreakPrompt}
      <div
        class="flex mt-2 items-center w-full"
        class:justify-end={$MobileGUI}
        data-risu-generation-jailbreak-control
        data-risu-toggle-key="jailbreakToggle"
        data-risu-toggle-kind="jailbreak"
        data-risu-input-kind="checkbox"
        data-risu-persistence-status={generationSettingsPersistenceStatus('jailbreakToggle')}
        data-risu-selected={getJailbreakToggleValue() ? 'true' : 'false'}>
        <CheckInput
          bind:check={() => getJailbreakToggleValue(), setJailbreakToggleValue}
          disabled={generationSettingsSavePending('jailbreakToggle')}
          name={language.jailbreakToggle}
          reverse />
      </div>
    {/if}

    {@render toggles(displayedSidebarToggles, true)}
    {#if chara && hypaV3Enabled}
      <div
        class="flex mt-2 items-center w-full gap-2"
        class:justify-end={$MobileGUI}
        data-risu-hypa-memory-toggle
        data-risu-mutation-status={characterToggleStatus.supaMemory}
        aria-busy={characterTogglePending.supaMemory}>
        <CheckInput
          check={chara.supaMemory}
          reverse
          name={language.ToggleHypaMemory}
          onChange={setSupaMemoryValue}
          disabled={characterTogglePending.supaMemory} />
        {#if characterToggleStatus.supaMemory === 'failed'}
          <span class="text-xs text-textcolor2" role="status">
            {language.mutationStatusFailed}
          </span>
        {/if}
      </div>
    {/if}
    <ChatGenerationResetDefaultsButton />
    <ChatGenerationTogglePresets />
    <ChatDraftHookSelector />
    <ChatTranslationSettings />
  </div>
{:else}
  <ChatGenerationSettingsControls />
  <CustomSideBar />

  {#if hasJailbreakPrompt}
    <div
      class="flex mt-2 items-center"
      data-risu-generation-jailbreak-control
      data-risu-toggle-key="jailbreakToggle"
      data-risu-toggle-kind="jailbreak"
      data-risu-input-kind="checkbox"
      data-risu-persistence-status={generationSettingsPersistenceStatus('jailbreakToggle')}
      data-risu-selected={getJailbreakToggleValue() ? 'true' : 'false'}>
      <CheckInput
        bind:check={() => getJailbreakToggleValue(), setJailbreakToggleValue}
        disabled={generationSettingsSavePending('jailbreakToggle')}
        name={language.jailbreakToggle} />
    </div>
  {/if}
  {@render toggles(displayedSidebarToggles)}
  {#if chara && hypaV3Enabled}
    <div
      class="flex mt-2 items-center gap-2"
      data-risu-hypa-memory-toggle
      data-risu-mutation-status={characterToggleStatus.supaMemory}
      aria-busy={characterTogglePending.supaMemory}>
      <CheckInput
        check={chara.supaMemory}
        name={language.ToggleHypaMemory}
        onChange={setSupaMemoryValue}
        disabled={characterTogglePending.supaMemory} />
      {#if characterToggleStatus.supaMemory === 'failed'}
        <span class="text-xs text-textcolor2" role="status">
          {language.mutationStatusFailed}
        </span>
      {/if}
    </div>
  {/if}
  <ChatGenerationTogglePresets />
  <ChatDraftHookSelector />
  <ChatTranslationSettings />
  <ChatGenerationResetDefaultsButton />
{/if}
