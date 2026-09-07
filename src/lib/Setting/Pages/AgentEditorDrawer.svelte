<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { PlusIcon, SaveIcon, Trash2Icon, XIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Help from 'src/lib/Others/Help.svelte'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
  import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import { modalBackdropDismiss } from 'src/ts/gui/modalBackdropDismiss'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'
  import { parseChatMLRows } from '@risuai/shared-core/chatml-rows'
  import { confirmSettingsItemRemoval } from 'src/ts/setting/confirmSettingsItemRemoval'
  import {
    AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MAX,
    AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MIN,
    AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MAX,
    AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MIN,
    AGENT_PRESET_RUNTIME_TEMPERATURE_MAX,
    AGENT_PRESET_RUNTIME_TEMPERATURE_MIN,
    AGENT_PRESET_RUNTIME_TIMEOUT_MS_MAX,
    AGENT_PRESET_RUNTIME_TIMEOUT_MS_MIN,
    AGENT_PRESET_STEP_INPUT_SCOPES,
    AGENT_LOREBOOK_INPUT_LIMIT,
    AGENT_TOGGLE_DEFINITION_LIMIT,
    AGENT_TOGGLE_KINDS,
    type AgentLorebookInput,
    type AgentPresetStepInputScope,
    type AgentPresetStepModelSelection,
    type AgentPresetStepOutputFormat,
    type AgentRecord,
    type AgentToggleDefinition,
  } from 'src/ts/agentPresetRecords'
  import type { AgentSnapshot } from 'src/ts/server/commands'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import {
    isModelProfileDividerSelectValue,
    modelProfileDividerSelectValue,
    modelProfileListItems,
    type ModelProfileRecord,
  } from 'src/ts/model/modelProfileRecords'

  interface Props {
    mode: 'create' | 'edit'
    agent?: AgentRecord
    busy?: boolean
    commandError?: string
    onSave: (agent: AgentSnapshot) => void | Promise<void>
    onCancel: () => void
  }

  const TEMPERATURE_SCALE = 100
  type EditableAgentToggle = AgentToggleDefinition & { optionText: string }
  let { mode, agent, busy = false, commandError = '', onSave, onCancel }: Props = $props()
  // svelte-ignore state_referenced_locally
  const initial = agent
  let name = $state(initial?.name ?? language.agentPresets.newAgentName)
  let description = $state(initial?.description ?? '')
  let instruction = $state(initial?.instruction ?? '')
  let useChatML = $state(initial?.useChatML ?? false)
  let modelMode = $state<AgentPresetStepModelSelection['mode']>(initial?.modelDefaults.mode ?? 'inheritMain')
  let profileId = $state(initial?.modelDefaults.mode === 'modelProfile' ? initial.modelDefaults.profileId : '')
  let lastValidProfileId = $state(initial?.modelDefaults.mode === 'modelProfile' ? initial.modelDefaults.profileId : '')
  let outputFormat = $state<AgentPresetStepOutputFormat>(initial?.outputFormat ?? 'text')
  let timeoutMs = $state(initial?.runtimeDefaults.timeoutMs ?? 30_000)
  let maxInputChars = $state(initial?.runtimeDefaults.maxInputChars ?? 24_000)
  let maxOutputChars = $state(initial?.runtimeDefaults.maxOutputChars ?? 1_200)
  let temperature = $state((initial?.runtimeDefaults.temperature ?? 100) / TEMPERATURE_SCALE)
  let structuredOutputStrict = $state(initial?.runtimeDefaults.structuredOutputStrict ?? false)
  let inputScopes = $state<AgentPresetStepInputScope[]>(
    initial?.inputScopes ? [...initial.inputScopes] : ['currentUserMessage'],
  )
  let toggles = $state<EditableAgentToggle[]>(
    (initial?.toggles ?? []).map((toggle) => ({
      ...toggle,
      options: [...toggle.options],
      optionText: toggle.options.join(', '),
    })),
  )
  let lorebookInputs = $state<AgentLorebookInput[]>((initial?.lorebookInputs ?? []).map((input) => ({ ...input })))
  let modelProfiles = $derived(readModelProfileOwners(settingsResourceState.value.modelProfiles))
  let modelProfileItems = $derived(
    hasUniqueModelProfileOrder(settingsResourceState.value.modelProfileOrder)
      ? modelProfileListItems(modelProfiles, settingsResourceState.value.modelProfileOrder)
      : [],
  )
  const initialSnapshot = agentSnapshotFromRecord(initial)
  let snapshot = $derived(agentSnapshot())
  let dirty = $derived(JSON.stringify(snapshot) !== JSON.stringify(initialSnapshot))
  let canSave = $derived(
    name.trim().length > 0 &&
      (modelMode === 'inheritMain' || profileId.trim().length > 0) &&
      (!useChatML || parseChatMLRows(instruction) !== null) &&
      definitionsValid() &&
      !busy &&
      (mode === 'create' || dirty),
  )

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

  function hasUniqueModelProfileOrder(value: unknown): boolean {
    if (value === undefined) return true
    if (!Array.isArray(value)) return false
    const profileIds = new Set<string>()
    const dividerIds = new Set<string>()
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
      const entry = candidate as { kind?: unknown; profileId?: unknown; id?: unknown }
      if (entry.kind === 'profile') {
        if (
          typeof entry.profileId !== 'string' ||
          entry.profileId.trim() !== entry.profileId ||
          entry.profileId.length === 0 ||
          profileIds.has(entry.profileId)
        ) {
          return false
        }
        profileIds.add(entry.profileId)
        continue
      }
      if (entry.kind === 'divider') {
        if (
          typeof entry.id !== 'string' ||
          entry.id.trim() !== entry.id ||
          entry.id.length === 0 ||
          dividerIds.has(entry.id)
        ) {
          return false
        }
        dividerIds.add(entry.id)
        continue
      }
      return false
    }
    return true
  }

  function agentSnapshot(): AgentSnapshot {
    const modelDefaults: AgentPresetStepModelSelection =
      modelMode === 'modelProfile' ? { mode: 'modelProfile', profileId: profileId.trim() } : { mode: 'inheritMain' }
    return {
      name: name.trim(),
      description: description.trim() || null,
      instruction,
      useChatML,
      modelDefaults,
      runtimeDefaults: {
        timeoutMs: clamp(timeoutMs, AGENT_PRESET_RUNTIME_TIMEOUT_MS_MIN, AGENT_PRESET_RUNTIME_TIMEOUT_MS_MAX),
        maxInputChars: clamp(
          maxInputChars,
          AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MIN,
          AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MAX,
        ),
        maxOutputChars: clamp(
          maxOutputChars,
          AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MIN,
          AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MAX,
        ),
        temperature: clamp(
          Math.round(Number(temperature) * TEMPERATURE_SCALE),
          AGENT_PRESET_RUNTIME_TEMPERATURE_MIN,
          AGENT_PRESET_RUNTIME_TEMPERATURE_MAX,
        ),
        structuredOutputStrict,
      },
      inputScopes: [...inputScopes],
      toggles: toggles.map((toggle) => ({
        key: toggle.key.trim(),
        label: toggle.label.trim(),
        kind: toggle.kind,
        options:
          toggle.kind === 'select'
            ? toggle.optionText
                .split(',')
                .map((option) => option.trim())
                .filter(Boolean)
            : [],
      })),
      lorebookInputs: lorebookInputs.map((input) => ({
        key: input.key.trim(),
        displayName: input.displayName.trim(),
        required: input.required,
      })),
      outputFormat,
    }
  }

  function handleProfileChange(event: Event): void {
    const select = event.currentTarget
    if (!(select instanceof HTMLSelectElement)) return
    if (isModelProfileDividerSelectValue(select.value)) {
      profileId = lastValidProfileId
      select.value = lastValidProfileId
      return
    }
    lastValidProfileId = profileId
  }

  function agentSnapshotFromRecord(record: AgentRecord | undefined): AgentSnapshot {
    if (!record) return agentSnapshot()
    return {
      name: record.name,
      description: record.description ?? null,
      instruction: record.instruction,
      useChatML: record.useChatML ?? false,
      modelDefaults: record.modelDefaults,
      runtimeDefaults: {
        timeoutMs: record.runtimeDefaults.timeoutMs ?? 30_000,
        maxInputChars: record.runtimeDefaults.maxInputChars ?? 24_000,
        maxOutputChars: record.runtimeDefaults.maxOutputChars ?? 1_200,
        temperature: record.runtimeDefaults.temperature ?? 100,
        structuredOutputStrict: record.runtimeDefaults.structuredOutputStrict ?? false,
      },
      inputScopes: [...record.inputScopes],
      toggles: (record.toggles ?? []).map((toggle) => ({ ...toggle, options: [...toggle.options] })),
      lorebookInputs: (record.lorebookInputs ?? []).map((input) => ({ ...input })),
      outputFormat: record.outputFormat,
    }
  }

  function sparseSnapshot(): AgentSnapshot {
    if (mode === 'create' || !initial) return snapshot
    return Object.fromEntries(
      Object.entries(snapshot).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(initialSnapshot[key])),
    ) as AgentSnapshot
  }

  function toggleScope(scope: AgentPresetStepInputScope, checked: boolean): void {
    inputScopes = checked
      ? [...new Set([...inputScopes, scope])]
      : inputScopes.filter((candidate) => candidate !== scope)
  }

  function addToggle(): void {
    toggles.push({ key: '', label: '', kind: 'boolean', options: [], optionText: '' })
  }

  function removeToggle(index: number): void {
    if (!confirmSettingsItemRemoval()) return
    toggles.splice(index, 1)
  }

  function addLorebookInput(): void {
    lorebookInputs.push({ key: '', displayName: '', required: true })
  }

  function removeLorebookInput(index: number): void {
    if (!confirmSettingsItemRemoval()) return
    lorebookInputs.splice(index, 1)
  }

  function definitionsValid(): boolean {
    const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
    const toggleKeys = toggles.map((toggle) => toggle.key.trim())
    const lorebookKeys = lorebookInputs.map((input) => input.key.trim())
    const referencedToggleKeys = [...instruction.matchAll(/\{\{\s*agentToggle::([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(
      (match) => match[1],
    )
    const referencedLorebookKeys = [...instruction.matchAll(/\{\{\s*agentInput::([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(
      (match) => match[1],
    )
    return (
      toggleKeys.every((key) => identifier.test(key)) &&
      new Set(toggleKeys).size === toggleKeys.length &&
      toggles.every(
        (toggle) =>
          toggle.label.trim().length > 0 &&
          (toggle.kind !== 'select' || toggle.optionText.split(',').some((option) => option.trim().length > 0)),
      ) &&
      lorebookKeys.every((key) => identifier.test(key)) &&
      new Set(lorebookKeys).size === lorebookKeys.length &&
      toggles.length <= AGENT_TOGGLE_DEFINITION_LIMIT &&
      lorebookInputs.length <= AGENT_LOREBOOK_INPUT_LIMIT &&
      lorebookInputs.every(
        (input) =>
          input.displayName.trim().length > 0 && (!input.required || referencedLorebookKeys.includes(input.key.trim())),
      ) &&
      referencedToggleKeys.every((key) => toggleKeys.includes(key)) &&
      referencedLorebookKeys.every((key) => lorebookKeys.includes(key))
    )
  }

  function clamp(value: unknown, min: number, max: number): number {
    const number = Math.round(Number(value))
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min
  }

  function requestClose(): void {
    if (busy) return
    if (dirty && !window.confirm(language.agentPresets.discardChangesConfirm)) return
    onCancel()
  }

  function agentRecoveryDraft() {
    return {
      name,
      description,
      instruction,
      useChatML,
      modelMode,
      profileId,
      outputFormat,
      timeoutMs,
      maxInputChars,
      maxOutputChars,
      temperature,
      structuredOutputStrict,
      inputScopes,
      toggles,
      lorebookInputs,
    }
  }
  const agentRecoveryBaseline = untrack(() => JSON.stringify(agentRecoveryDraft()))
  onDestroy(
    registerWriterDraftCapture(() => {
      const data = agentRecoveryDraft()
      if (JSON.stringify(data) === agentRecoveryBaseline) return null
      return $state.snapshot({
        key: `agent:${initial?.id ?? 'new'}`,
        label: name || language.agentPresets.newAgentName,
        fields: [{ label: name || language.agentPresets.newAgentName, value: JSON.stringify(data, null, 2) }],
        data,
        baseline: JSON.parse(agentRecoveryBaseline),
      })
    }),
  )
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  use:modalBackdropDismiss={requestClose}
  data-modal-root
  role="presentation"
  class="fixed inset-0 z-50 flex justify-end bg-black/50">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    use:modalFocusTrap
    class="flex h-full w-full max-w-3xl flex-col border-l border-darkborderc bg-bgcolor text-textcolor shadow-xl"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-busy={busy}
    data-risu-agent-editor
    onclick={(event) => event.stopPropagation()}>
    <div class="flex items-center justify-between border-b border-darkborderc p-4">
      <h3 class="text-xl font-semibold">
        {mode === 'create' ? language.agentPresets.createAgent : language.agentPresets.editAgent}
      </h3>
      <Button size="sm" styled="outlined" disabled={busy} onclick={requestClose}><XIcon size={16} /></Button>
    </div>
    <div class="flex-1 overflow-y-auto p-4">
      {#if commandError}<div class="mb-3 rounded-md border border-draculared p-3 text-sm text-draculared">
          {commandError}
        </div>{/if}
      <div class="grid gap-3 md:grid-cols-2">
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">{language.agentPresets.nameLabel}</span>
          <TextInput bind:value={name} fullwidth />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">{language.agentPresets.outputFormatLabel}</span>
          <SelectInput bind:value={outputFormat} className="w-full">
            <option value="text">{language.agentPresets.outputFormatText}</option>
            <option value="jsonObject">{language.agentPresets.outputFormatJsonObject}</option>
          </SelectInput>
        </label>
      </div>
      <label class="mt-3 flex flex-col gap-1">
        <span class="text-sm font-medium">{language.agentPresets.descriptionLabel}</span>
        <textarea
          class="min-h-20 rounded-md border border-darkborderc bg-transparent px-3 py-2 text-sm"
          bind:value={description}></textarea>
      </label>
      <label class="mt-3 flex flex-col gap-1">
        <span class="text-sm font-medium">{language.agentPresets.instructionLabel}</span>
        <textarea
          class="min-h-36 rounded-md border border-darkborderc bg-transparent px-3 py-2 text-sm"
          bind:value={instruction}></textarea>
        {#if inputScopes.length > 0}
          <span
            class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-textcolor2"
            data-risu-agent-instruction-placeholders>
            <span>{language.agentPresets.preparedInputCbsNameLabel}:</span>
            {#each AGENT_PRESET_STEP_INPUT_SCOPES.filter((scope) => inputScopes.includes(scope)) as scope (scope)}
              <code class="rounded bg-darkbutton px-1.5 py-0.5">{`{{${scope}}}`}</code>
            {/each}
          </span>
        {/if}
      </label>
      <div class="mt-3" data-risu-agent-use-chatml>
        <CheckInput
          bind:check={useChatML}
          name={language.agentPresets.useChatMLLabel}
          onChange={(value) => (useChatML = value)} />
        <p class="pl-7 text-xs text-textcolor2">{language.agentPresets.useChatMLDescription}</p>
        {#if useChatML && parseChatMLRows(instruction) === null}
          <p class="pl-7 text-xs text-draculared">{language.agentPresets.invalidChatMLInstruction}</p>
        {/if}
      </div>
      <section class="mt-4 rounded-md border border-darkborderc p-3" data-risu-agent-toggles>
        <div class="flex items-start justify-between gap-3">
          <div>
            <h4 class="text-sm font-semibold">{language.agentPresets.agentTogglesLabel}</h4>
            <p class="mt-1 text-xs text-textcolor2">{language.agentPresets.agentTogglesDescription}</p>
          </div>
          <Button
            size="sm"
            styled="outlined"
            disabled={busy || toggles.length >= AGENT_TOGGLE_DEFINITION_LIMIT}
            onclick={addToggle}>
            <span class="inline-flex items-center gap-1"><PlusIcon size={14} />{language.agentPresets.addToggle}</span>
          </Button>
        </div>
        {#if toggles.length === 0}
          <p class="mt-3 text-xs text-textcolor2">{language.agentPresets.noAgentToggles}</p>
        {:else}
          <div class="mt-3 space-y-3">
            {#each toggles as toggle, index}
              <div class="rounded-md border border-darkborderc p-3" data-risu-agent-toggle>
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_10rem_auto]">
                  <label class="flex flex-col gap-1">
                    <span class="text-xs font-medium">{language.agentPresets.localKeyLabel}</span>
                    <TextInput bind:value={toggle.key} fullwidth />
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-xs font-medium">{language.agentPresets.toggleLabelLabel}</span>
                    <TextInput bind:value={toggle.label} fullwidth />
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-xs font-medium">{language.agentPresets.toggleKindLabel}</span>
                    <SelectInput bind:value={toggle.kind} className="w-full">
                      {#each AGENT_TOGGLE_KINDS as kind}
                        <option value={kind}>{language.agentPresets.toggleKindLabels[kind]}</option>
                      {/each}
                    </SelectInput>
                  </label>
                  <div class="flex items-end">
                    <Button
                      size="sm"
                      styled="outlined"
                      disabled={busy}
                      ariaLabel={language.agentPresets.removeToggle}
                      onclick={() => removeToggle(index)}><Trash2Icon size={14} /></Button>
                  </div>
                </div>
                {#if toggle.kind === 'select'}
                  <label class="mt-3 flex flex-col gap-1">
                    <span class="text-xs font-medium">{language.agentPresets.toggleOptionsLabel}</span>
                    <TextInput bind:value={toggle.optionText} fullwidth />
                  </label>
                {/if}
                <p class="mt-2 text-xs text-textcolor2">
                  {language.agentPresets.togglePlaceholder(toggle.key || 'key')}
                </p>
              </div>
            {/each}
          </div>
        {/if}
      </section>
      <section class="mt-4 rounded-md border border-darkborderc p-3" data-risu-agent-lorebook-inputs>
        <div class="flex items-start justify-between gap-3">
          <div>
            <h4 class="text-sm font-semibold">{language.agentPresets.lorebookInputsLabel}</h4>
            <p class="mt-1 text-xs text-textcolor2">{language.agentPresets.lorebookInputsDescription}</p>
          </div>
          <Button
            size="sm"
            styled="outlined"
            disabled={busy || lorebookInputs.length >= AGENT_LOREBOOK_INPUT_LIMIT}
            onclick={addLorebookInput}>
            <span class="inline-flex items-center gap-1"
              ><PlusIcon size={14} />{language.agentPresets.addLorebookInput}</span>
          </Button>
        </div>
        {#if lorebookInputs.length === 0}
          <p class="mt-3 text-xs text-textcolor2">{language.agentPresets.noLorebookInputs}</p>
        {:else}
          <div class="mt-3 space-y-3">
            {#each lorebookInputs as input, index}
              <div
                class="grid gap-3 rounded-md border border-darkborderc p-3 sm:grid-cols-[1fr_1.5fr_auto]"
                data-risu-agent-lorebook-input>
                <label class="flex flex-col gap-1">
                  <span class="text-xs font-medium">{language.agentPresets.localKeyLabel}</span>
                  <TextInput bind:value={input.key} fullwidth />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-xs font-medium">{language.agentPresets.lorebookDisplayNameLabel}</span>
                  <TextInput bind:value={input.displayName} fullwidth />
                </label>
                <div class="flex items-end">
                  <Button
                    size="sm"
                    styled="outlined"
                    disabled={busy}
                    ariaLabel={language.agentPresets.removeLorebookInput}
                    onclick={() => removeLorebookInput(index)}><Trash2Icon size={14} /></Button>
                </div>
                <p class="text-xs text-textcolor2 sm:col-span-3">
                  {language.agentPresets.lorebookInputPlaceholder(input.key || 'key')}
                </p>
              </div>
            {/each}
          </div>
        {/if}
      </section>
      <div class="mt-3 grid gap-3 md:grid-cols-2">
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">{language.agentPresets.modelModeLabel}</span>
          <SelectInput bind:value={modelMode} className="w-full">
            <option value="inheritMain">{language.agentPresets.inheritMainModel}</option>
            <option value="modelProfile">{language.agentPresets.selectedModelProfile}</option>
          </SelectInput>
        </label>
        {#if modelMode === 'modelProfile'}
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">{language.agentPresets.modelProfileLabel}</span>
            <SelectInput bind:value={profileId} onchange={handleProfileChange} className="w-full">
              <option value="">{language.agentPresets.noModelProfiles}</option>
              {#each modelProfileItems as item (`${item.kind}:${item.kind === 'profile' ? item.profile.id : item.id}`)}
                {#if item.kind === 'divider'}
                  <option value={modelProfileDividerSelectValue(item.id)} data-model-profile-divider="true">---</option>
                {:else}
                  <option value={item.profile.id}>{item.profile.name ?? item.profile.id}</option>
                {/if}
              {/each}
            </SelectInput>
          </label>
        {/if}
      </div>
      <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label class="flex flex-col gap-1"
          ><span class="text-sm">{language.agentPresets.timeoutMsLabel}</span><NumberInput
            bind:value={timeoutMs}
            min={AGENT_PRESET_RUNTIME_TIMEOUT_MS_MIN}
            max={AGENT_PRESET_RUNTIME_TIMEOUT_MS_MAX}
            fullwidth /></label>
        <label class="flex flex-col gap-1"
          ><span class="text-sm">{language.agentPresets.maxInputCharsLabel}</span><NumberInput
            bind:value={maxInputChars}
            min={AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MIN}
            max={AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MAX}
            fullwidth /></label>
        <label class="flex flex-col gap-1"
          ><span class="text-sm">{language.agentPresets.maxOutputCharsLabel}</span><NumberInput
            bind:value={maxOutputChars}
            min={AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MIN}
            max={AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MAX}
            fullwidth /></label>
        <label class="flex flex-col gap-1"
          ><span class="text-sm">{language.agentPresets.temperatureLabel}</span><NumberInput
            bind:value={temperature}
            min={0}
            max={2}
            step={0.01}
            fullwidth /></label>
      </div>
      <div class="mt-3">
        <CheckInput
          bind:check={structuredOutputStrict}
          name={language.agentPresets.structuredOutputStrict}
          onChange={(value) => (structuredOutputStrict = value)} />
      </div>
      <div class="mt-4 rounded-md border border-darkborderc p-3">
        <h4 class="inline-flex items-center gap-1 text-sm font-semibold">
          {language.agentPresets.preparedInputScopesLabel}
          <Help key="agentPresetPreparedInputs" name={language.agentPresets.preparedInputScopesLabel} />
        </h4>
        <p class="mt-1 text-xs text-textcolor2">{language.agentPresets.preparedInputScopesDescription}</p>
        <div class="mt-3 grid gap-2 sm:grid-cols-2">
          {#each AGENT_PRESET_STEP_INPUT_SCOPES as scope (scope)}
            <div class="rounded-md border border-darkborderc p-2">
              <CheckInput
                check={inputScopes.includes(scope)}
                name={language.agentPresets.inputScopeLabels[scope]}
                onChange={(checked) => toggleScope(scope, checked)} />
              <p class="pl-7 text-xs text-textcolor2">{language.agentPresets.inputScopeDescriptions[scope]}</p>
            </div>
          {/each}
        </div>
      </div>
    </div>
    <div class="flex justify-end gap-2 border-t border-darkborderc p-4">
      <Button styled="outlined" disabled={busy} onclick={requestClose}>{language.agentPresets.cancel}</Button>
      <Button disabled={!canSave} onclick={() => onSave(sparseSnapshot())}>
        <span class="inline-flex items-center gap-2"
          ><SaveIcon size={16} />{busy ? language.agentPresets.saving : language.agentPresets.save}</span>
      </Button>
    </div>
  </div>
</div>
