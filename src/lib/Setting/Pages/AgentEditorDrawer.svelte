<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { PlusIcon, SaveIcon, Trash2Icon, XIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Help from 'src/lib/Others/Help.svelte'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
  import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import { modalBackdropDismiss } from 'src/ts/gui/modalBackdropDismiss'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'
  import { parseChatMLRows } from '@risuai/shared-core/chatml-rows'
  import {
    agentAuthoringIssues,
    type AgentAuthoringIssue,
    type AgentAuthoringIssueField,
    type AgentAuthoringRecoveryAction,
  } from 'src/ts/agentAuthoringIssues'
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
    validateAgentRecord,
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
    onSave: (agent: AgentSnapshot) => boolean | void | Promise<boolean | void>
    onCancel: () => void
  }

  const TEMPERATURE_SCALE = 100
  type EditableAgentToggle = AgentToggleDefinition & { optionText: string }
  type AuthoringEditorApi = {
    insertAtCaret: (text: string) => Promise<boolean>
    focusEditor: () => void
  }
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
  let drawerNode: HTMLElement
  let instructionEditor: AuthoringEditorApi | undefined
  let advancedOpen = $state((initial?.toggles?.length ?? 0) > 0 || (initial?.lorebookInputs?.length ?? 0) > 0)
  let modelProfiles = $derived(readModelProfileOwners(settingsResourceState.value.modelProfiles))
  let modelProfileItems = $derived(
    hasUniqueModelProfileOrder(settingsResourceState.value.modelProfileOrder)
      ? modelProfileListItems(modelProfiles, settingsResourceState.value.modelProfileOrder)
      : [],
  )
  const initialSnapshot = agentSnapshotFromRecord(initial)
  let snapshot = $derived(agentSnapshot())
  let dirty = $derived(JSON.stringify(snapshot) !== JSON.stringify(initialSnapshot))
  let guidanceIssues = $derived(
    agentAuthoringIssues({
      name,
      generatedDefaultName: language.agentPresets.newAgentName,
      instruction,
      useChatML,
      inputScopes,
      outputFormat,
      structuredOutputStrict,
    }),
  )
  let definitionIssues = $derived.by(() => canonicalDefinitionIssues())
  let surfaceIssues = $derived([...guidanceIssues, ...definitionIssues])
  let chatMLRows = $derived(useChatML ? parseChatMLRows(instruction) : null)
  let instructionTokenOptions = $derived([
    ...AGENT_PRESET_STEP_INPUT_SCOPES.filter((scope) => inputScopes.includes(scope)),
    ...toggles.filter((toggle) => toggle.key.trim()).map((toggle) => `agentToggle::${toggle.key.trim()}`),
    ...lorebookInputs.filter((input) => input.key.trim()).map((input) => `agentInput::${input.key.trim()}`),
  ])
  let blockingIssueCount = $derived(surfaceIssues.filter((issue) => issue.severity === 'error').length)
  let canSave = $derived(
    name.trim().length > 0 &&
      (modelMode === 'inheritMain' || profileId.trim().length > 0) &&
      blockingIssueCount === 0 &&
      !busy &&
      (mode === 'create' || dirty),
  )
  let saveDisabledReason = $derived(
    busy
      ? language.agentPresets.saveWaiting
      : blockingIssueCount > 0
        ? language.agentPresets.saveFixIssues(blockingIssueCount)
        : !canSave
          ? language.agentPresets.saveNoChanges
          : '',
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

  function canonicalDefinitionIssues(): AgentAuthoringIssue[] {
    const issues = validateAgentRecord(
      {
        id: initial?.id ?? 'draft-agent',
        version: initial?.version ?? 1,
        name: name.trim(),
        instruction,
        useChatML,
        modelDefaults:
          modelMode === 'modelProfile'
            ? { mode: 'modelProfile', profileId: profileId.trim() }
            : { mode: 'inheritMain' },
        runtimeDefaults: snapshot.runtimeDefaults ?? {},
        inputScopes,
        toggles: snapshot.toggles ?? [],
        lorebookInputs: snapshot.lorebookInputs ?? [],
        outputFormat,
      },
      'agent',
    )
    return issues
      .filter(
        (issue) =>
          issue.code === 'invalid_model' || issue.code === 'invalid_toggle' || issue.code === 'invalid_lorebook_input',
      )
      .map((issue) => {
        const field: AgentAuthoringIssueField =
          issue.code === 'invalid_model' ? 'model' : issue.code === 'invalid_toggle' ? 'toggles' : 'lorebookInputs'
        return {
          id: `${issue.code}:${issue.path}:${issue.message}`,
          severity: 'error',
          field,
          messageKey:
            issue.code === 'invalid_model'
              ? 'issueInvalidModel'
              : issue.code === 'invalid_toggle'
                ? 'issueInvalidToggleDefinition'
                : 'issueInvalidLorebookDefinition',
          recoveryActions: [{ kind: 'focusField', field }],
        }
      })
  }

  function issueMessage(issue: AgentAuthoringIssue): string {
    const scope = issue.scope
    if (issue.messageKey === 'issuePreparedInputSelectedButUnused' && scope) {
      return language.agentPresets.issuePreparedInputSelectedButUnused(
        language.agentPresets.inputScopeLabels[scope],
        `{{${scope}}}`,
      )
    }
    if (issue.messageKey === 'issuePreparedInputUsedButUnselected' && scope) {
      return language.agentPresets.issuePreparedInputUsedButUnselected(
        language.agentPresets.inputScopeLabels[scope],
        `{{${scope}}}`,
      )
    }
    switch (issue.messageKey) {
      case 'issueEmptyInstruction':
      case 'issueGeneratedName':
      case 'issueNameRequired':
      case 'issueInvalidChatML':
      case 'issueStrictOutputRequiresJson':
      case 'issueInvalidModel':
      case 'issueInvalidToggleDefinition':
      case 'issueInvalidLorebookDefinition':
        return language.agentPresets[issue.messageKey]
      default:
        return ''
    }
  }

  function focusIssue(issue: AgentAuthoringIssue): void {
    focusField(issue.field)
  }

  function focusField(field: AgentAuthoringIssueField): void {
    drawerNode.querySelector<HTMLElement>(`[data-risu-agent-field="${field}"]`)?.focus()
  }

  async function applyRecovery(action: AgentAuthoringRecoveryAction): Promise<void> {
    if (action.kind === 'insertPreparedInput') {
      await instructionEditor?.insertAtCaret(action.token)
      return
    }
    if (action.kind === 'deselectPreparedInput') toggleScope(action.scope, false)
    else if (action.kind === 'enablePreparedInput') toggleScope(action.scope, true)
    else focusField(action.field)
  }

  async function insertInstructionToken(token: string): Promise<void> {
    if (busy) return
    await instructionEditor?.insertAtCaret(token)
  }

  async function wrapInstructionAsChatML(): Promise<void> {
    if (busy || chatMLRows) return
    instruction = `<|im_start|>system\n${instruction}<|im_end|>`
    await tick()
    instructionEditor?.focusEditor()
  }

  function temperatureEffect(value: number): string {
    if (value < 0.7) return language.agentPresets.temperatureEffectFocused
    if (value <= 1.1) return language.agentPresets.temperatureEffectBalanced
    return language.agentPresets.temperatureEffectVaried
  }

  function recoveryLabel(action: AgentAuthoringRecoveryAction): string {
    if (action.kind === 'insertPreparedInput') return language.agentPresets.insertToken
    if (action.kind === 'deselectPreparedInput') return language.agentPresets.deselectInput
    if (action.kind === 'enablePreparedInput') return language.agentPresets.enableInput
    return language.agentPresets.goToField
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

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    requestClose()
  }

  async function saveAgent(): Promise<void> {
    if (!canSave) return
    const attempted = sparseSnapshot()
    const recoveryAtSave = JSON.stringify(agentRecoveryDraft())
    const accepted = await onSave(attempted)
    if (accepted === true && JSON.stringify(agentRecoveryDraft()) === recoveryAtSave) onCancel()
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
  class="fixed inset-0 z-50 flex justify-end bg-black/70">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    use:modalFocusTrap
    bind:this={drawerNode}
    class="flex h-full w-full max-w-3xl flex-col border-l border-darkborderc bg-bgcolor text-textcolor shadow-xl"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-busy={busy}
    data-risu-agent-editor
    onkeydown={handleKeydown}
    onclick={(event) => event.stopPropagation()}>
    <div class="flex items-center justify-between border-b border-darkborderc p-4">
      <h3 class="text-xl font-semibold">
        {mode === 'create' ? language.agentPresets.createAgent : language.agentPresets.editAgent}
      </h3>
      <Button
        size="sm"
        styled="outlined"
        className="min-h-11 min-w-11"
        disabled={busy}
        ariaLabel={language.close}
        onclick={requestClose}><XIcon size={16} /></Button>
    </div>
    <div class="flex-1 overflow-y-auto p-4" data-risu-agent-editor-scroll-body>
      {#if commandError}<div class="mb-3 rounded-md border border-draculared p-3 text-sm text-draculared">
          {commandError}
        </div>{/if}
      <section class="rounded-md border border-darkborderc p-3" data-risu-agent-section="basics">
        <h4 class="mb-3 text-base font-semibold">{language.agentPresets.sectionBasics}</h4>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1" data-risu-agent-field="name" tabindex="-1">
            <span class="text-sm font-medium">{language.agentPresets.nameLabel}</span>
            <TextInput bind:value={name} fullwidth className="scroll-mt-4" />
          </label>
          <label class="flex flex-col gap-1" data-risu-agent-field="outputFormat" tabindex="-1">
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
      </section>

      <section class="mt-4 rounded-md border border-darkborderc p-3" data-risu-agent-section="instructions">
        <h4 class="text-base font-semibold">{language.agentPresets.sectionInstructions}</h4>
        <p class="mt-1 text-xs text-textcolor2">{language.agentPresets.instructionAuthoringHelp}</p>
        <div class="mt-3" data-risu-agent-field="instruction" tabindex="-1">
          <span class="mb-1 block text-sm font-medium">{language.agentPresets.instructionLabel}</span>
          <TextAreaInput
            bind:this={instructionEditor}
            bind:value={instruction}
            fullwidth
            height="36"
            popupEditor={true}
            autocompleteOptions={instructionTokenOptions}
            ariaLabel={language.agentPresets.instructionLabel} />
          {#if instructionTokenOptions.length > 0}
            <div
              class="mt-2 flex flex-wrap items-center gap-2 text-xs text-textcolor2"
              data-risu-agent-instruction-placeholders>
              <span>{language.agentPresets.finalOutputVariablesLabel}</span>
              {#each AGENT_PRESET_STEP_INPUT_SCOPES.filter((scope) => inputScopes.includes(scope)) as scope (scope)}
                <button
                  type="button"
                  class="min-h-11 rounded-md border border-darkborderc bg-darkbutton px-2 py-1 hover:bg-darkbuttonhover"
                  aria-label={language.agentPresets.insertValue(language.agentPresets.inputScopeLabels[scope])}
                  data-risu-agent-insert-token
                  data-token={`{{${scope}}}`}
                  onclick={() => insertInstructionToken(`{{${scope}}}`)}><code>{`{{${scope}}}`}</code></button>
              {/each}
              {#each toggles.filter((toggle) => toggle.key.trim()) as toggle (`toggle:${toggle.key}`)}
                <button
                  type="button"
                  class="min-h-11 rounded-md border border-darkborderc bg-darkbutton px-2 py-1 hover:bg-darkbuttonhover"
                  aria-label={language.agentPresets.insertValue(toggle.label || toggle.key)}
                  data-risu-agent-insert-token
                  data-token={`{{agentToggle::${toggle.key.trim()}}}`}
                  onclick={() => insertInstructionToken(`{{agentToggle::${toggle.key.trim()}}}`)}
                  ><code>{`{{agentToggle::${toggle.key.trim()}}}`}</code></button>
              {/each}
              {#each lorebookInputs.filter((input) => input.key.trim()) as input (`input:${input.key}`)}
                <button
                  type="button"
                  class="min-h-11 rounded-md border border-darkborderc bg-darkbutton px-2 py-1 hover:bg-darkbuttonhover"
                  aria-label={language.agentPresets.insertValue(input.displayName || input.key)}
                  data-risu-agent-insert-token
                  data-token={`{{agentInput::${input.key.trim()}}}`}
                  onclick={() => insertInstructionToken(`{{agentInput::${input.key.trim()}}}`)}
                  ><code>{`{{agentInput::${input.key.trim()}}}`}</code></button>
              {/each}
            </div>
          {/if}
        </div>
        {#if surfaceIssues.length > 0}
          <section
            class="mt-3 rounded-md border border-darkborderc p-3"
            aria-label={language.agentPresets.issueSummary(surfaceIssues.length)}
            data-risu-agent-issue-summary>
            <h5 class="text-sm font-semibold">{language.agentPresets.issueSummary(surfaceIssues.length)}</h5>
            <ul class="mt-2 space-y-2">
              {#each surfaceIssues as issue (issue.id)}
                <li
                  class="rounded-md border p-2 text-sm"
                  class:border-draculared={issue.severity === 'error'}
                  class:border-yellow-600={issue.severity === 'warning'}
                  data-risu-agent-issue={issue.severity}>
                  <button type="button" class="text-left underline" onclick={() => focusIssue(issue)}>
                    {issueMessage(issue)}
                  </button>
                  {#if issue.recoveryActions.length > 0}
                    <div class="mt-2 flex flex-wrap gap-2">
                      {#each issue.recoveryActions as action}
                        <Button size="sm" styled="outlined" onclick={() => applyRecovery(action)}>
                          {recoveryLabel(action)}
                        </Button>
                      {/each}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        <div class="mt-3" data-risu-agent-use-chatml>
          <CheckInput
            bind:check={useChatML}
            name={language.agentPresets.useChatMLLabel}
            onChange={(value) => (useChatML = value)} />
          <p class="pl-7 text-xs text-textcolor2">{language.agentPresets.useChatMLDescription}</p>
          {#if useChatML && chatMLRows === null}
            <div class="mt-2 flex flex-wrap items-center gap-2 pl-7">
              <p class="text-xs text-draculared">{language.agentPresets.invalidChatMLInstruction}</p>
              <Button size="sm" styled="outlined" onclick={wrapInstructionAsChatML}>
                {language.agentPresets.convertToChatML}
              </Button>
            </div>
          {:else if useChatML && chatMLRows}
            <section class="mt-3 rounded-md border border-darkborderc p-3" data-risu-agent-chatml-preview>
              <h5 class="text-sm font-semibold">{language.agentPresets.chatMLPreview}</h5>
              <p class="mt-1 text-xs text-textcolor2">{language.agentPresets.chatMLPreviewHelp}</p>
              <div class="mt-2 space-y-2">
                {#each chatMLRows as row, index}
                  <article class="rounded-md bg-darkbutton p-2" data-risu-chatml-role={row.role}>
                    <p class="text-xs font-semibold">{language.agentPresets.chatMLRole(row.role, index + 1)}</p>
                    <pre class="mt-1 whitespace-pre-wrap text-xs">{row.content}</pre>
                    {#if row.thoughts.length > 0}
                      <p class="mt-1 text-xs text-textcolor2">
                        {language.agentPresets.chatMLThoughtCount(row.thoughts.length)}
                      </p>
                    {/if}
                  </article>
                {/each}
              </div>
            </section>
          {/if}
        </div>
      </section>
      {#snippet advancedSection()}
        <details
          bind:open={advancedOpen}
          class="mt-4 rounded-md border border-darkborderc"
          data-risu-agent-section="advanced">
          <summary class="cursor-pointer px-3 py-3">
            <span class="font-semibold">{language.agentPresets.sectionAdvanced}</span>
            <span class="ml-2 text-xs text-textcolor2">{language.agentPresets.advancedCollapsedHelp}</span>
          </summary>
          <div class="border-t border-darkborderc p-3">
            <section data-risu-agent-toggles data-risu-agent-field="toggles" tabindex="-1">
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
                  <span class="inline-flex items-center gap-1"
                    ><PlusIcon size={14} />{language.agentPresets.addToggle}</span>
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
            <section
              class="mt-4 border-t border-darkborderc pt-4"
              data-risu-agent-lorebook-inputs
              data-risu-agent-field="lorebookInputs"
              tabindex="-1">
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
            <details class="mt-4 border-t border-darkborderc pt-3" data-risu-agent-technical-details>
              <summary class="cursor-pointer text-sm font-semibold">{language.agentPresets.technicalDetails}</summary>
              <dl class="mt-2 grid gap-2 text-xs sm:grid-cols-[auto_1fr]">
                <dt class="text-textcolor2">{language.agentPresets.agentIdLabel}</dt>
                <dd><code class="break-all select-all">{initial?.id ?? 'new'}</code></dd>
              </dl>
            </details>
          </div>
        </details>
      {/snippet}
      {#snippet modelLimitsSection()}
        <section
          class="mt-4 rounded-md border border-darkborderc p-3"
          data-risu-agent-section="model-limits"
          data-risu-agent-field="model"
          tabindex="-1">
          <h4 class="mb-3 text-base font-semibold">{language.agentPresets.sectionModelLimits}</h4>
          <div class="grid gap-3 sm:grid-cols-2">
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
                      <option value={modelProfileDividerSelectValue(item.id)} data-model-profile-divider="true"
                        >---</option>
                    {:else}
                      <option value={item.profile.id}>{item.profile.name ?? item.profile.id}</option>
                    {/if}
                  {/each}
                </SelectInput>
              </label>
            {/if}
          </div>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1">
              <span class="text-sm">{language.agentPresets.timeoutMsLabel}</span>
              <NumberInput
                bind:value={timeoutMs}
                min={AGENT_PRESET_RUNTIME_TIMEOUT_MS_MIN}
                max={AGENT_PRESET_RUNTIME_TIMEOUT_MS_MAX}
                fullwidth />
              <span class="text-xs text-textcolor2">
                {language.agentPresets.runtimeRange(
                  AGENT_PRESET_RUNTIME_TIMEOUT_MS_MIN,
                  AGENT_PRESET_RUNTIME_TIMEOUT_MS_MAX,
                )}
                {language.agentPresets.timeoutEffect(Math.round(Number(timeoutMs) / 1000))}
              </span>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm">{language.agentPresets.maxInputCharsLabel}</span>
              <NumberInput
                bind:value={maxInputChars}
                min={AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MIN}
                max={AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MAX}
                fullwidth />
              <span class="text-xs text-textcolor2">
                {language.agentPresets.runtimeRange(
                  AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MIN,
                  AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MAX,
                )}
                {language.agentPresets.maxInputEffect(Number(maxInputChars))}
              </span>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm">{language.agentPresets.maxOutputCharsLabel}</span>
              <NumberInput
                bind:value={maxOutputChars}
                min={AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MIN}
                max={AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MAX}
                fullwidth />
              <span class="text-xs text-textcolor2">
                {language.agentPresets.runtimeRange(
                  AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MIN,
                  AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MAX,
                )}
                {language.agentPresets.maxOutputEffect(Number(maxOutputChars))}
              </span>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm">{language.agentPresets.temperatureLabel}</span>
              <NumberInput bind:value={temperature} min={0} max={2} step={0.01} fullwidth />
              <span class="text-xs text-textcolor2">
                {language.agentPresets.runtimeRange(
                  AGENT_PRESET_RUNTIME_TEMPERATURE_MIN / TEMPERATURE_SCALE,
                  AGENT_PRESET_RUNTIME_TEMPERATURE_MAX / TEMPERATURE_SCALE,
                )}
                {temperatureEffect(Number(temperature))}
              </span>
            </label>
          </div>
          <div class="mt-3">
            <CheckInput
              bind:check={structuredOutputStrict}
              name={language.agentPresets.structuredOutputStrict}
              onChange={(value) => (structuredOutputStrict = value)} />
          </div>
        </section>
      {/snippet}
      <section
        class="mt-4 rounded-md border border-darkborderc p-3"
        data-risu-agent-section="context"
        data-risu-agent-field="inputScopes"
        tabindex="-1">
        <h4 class="inline-flex items-center gap-1 text-base font-semibold">
          {language.agentPresets.sectionContext}
        </h4>
        <h5 class="mt-3 inline-flex items-center gap-1 text-sm font-semibold">
          {language.agentPresets.preparedInputScopesLabel}
          <Help key="agentPresetPreparedInputs" name={language.agentPresets.preparedInputScopesLabel} />
        </h5>
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
      </section>
      {@render modelLimitsSection()}
      {@render advancedSection()}
    </div>
    <div class="flex justify-end gap-2 border-t border-darkborderc p-4" data-risu-agent-editor-footer>
      {#if saveDisabledReason}<span class="mr-auto self-center text-sm text-textcolor2" data-risu-agent-save-reason>
          {saveDisabledReason}
        </span>{/if}
      <Button styled="outlined" disabled={busy} onclick={requestClose}>{language.agentPresets.cancel}</Button>
      <Button disabled={!canSave} onclick={saveAgent}>
        <span class="inline-flex items-center gap-2"
          ><SaveIcon size={16} />{busy ? language.agentPresets.saving : language.agentPresets.save}</span>
      </Button>
    </div>
  </div>
</div>
