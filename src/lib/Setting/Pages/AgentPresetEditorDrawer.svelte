<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { ArrowDownIcon, ArrowUpIcon, CopyIcon, PlusIcon, SaveIcon, TrashIcon, XIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
  import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import { modalBackdropDismiss } from 'src/ts/gui/modalBackdropDismiss'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'
  import {
    addAgentToPreset,
    createAgent,
    defaultAgentPresetUse,
    removeAgentFromPreset,
    reorderAgentPresetUses,
    updateAgentPresetUse,
    type AgentMutationOutcome,
  } from 'src/ts/agents'
  import {
    diagnoseAgentPresetOutputReferences,
    planAgentPreset,
    type AgentPresetOutputReferenceDiagnostic,
  } from 'src/ts/agentPresetResolver'
  import { expandAgentPresetOutputCbs } from '@risuai/shared-core/agent-preset-output-references'
  import {
    AGENT_PRESET_MAX_CONCURRENCY_MAX,
    AGENT_PRESET_MAX_CONCURRENCY_MIN,
    AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MAX,
    AGENT_PRESET_RUNTIME_MAX_INPUT_CHARS_MIN,
    AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MAX,
    AGENT_PRESET_RUNTIME_MAX_OUTPUT_CHARS_MIN,
    AGENT_PRESET_RUNTIME_TIMEOUT_MS_MAX,
    AGENT_PRESET_RUNTIME_TIMEOUT_MS_MIN,
    isValidAgentPresetOutputKey,
    resolveAgentPresetSteps,
    type AgentRecord,
    type AgentPresetRecord,
    type AgentPresetStepDestination,
    type AgentPresetStepFailurePolicy,
    type AgentPresetStepModelSelection,
    type AgentPresetStepPhase,
    type AgentPresetStepRecord,
    type AgentPresetUseRecord,
  } from 'src/ts/agentPresetRecords'
  import type { AgentPresetSnapshot, AgentPresetUseSnapshot, AgentSnapshot } from 'src/ts/server/commands'
  import { collectionsResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import {
    isModelProfileDividerSelectValue,
    modelProfileDividerSelectValue,
    modelProfileListItems,
    type ModelProfileRecord,
  } from 'src/ts/model/modelProfileRecords'
  import AgentPresetDiagnosticsPanel from './AgentPresetDiagnosticsPanel.svelte'
  import AgentEditorDrawer from './AgentEditorDrawer.svelte'
  import type { AgentPresetGeneratedProjectionLatch } from 'src/ts/agentPresets'
  import {
    agentPresetModuleIntegrationOptions,
    parseAgentPresetModuleIntegration,
    serializeAgentPresetModuleIntegration,
    unknownAgentPresetModuleIntegrations,
  } from 'src/ts/agentPresetModuleIntegration'

  interface Props {
    mode: 'create' | 'edit'
    preset?: AgentPresetRecord
    busy?: boolean
    commandError?: string
    onSave: (preset: AgentPresetSnapshot) => boolean | void | Promise<boolean | void>
    onCancel: () => void
    onQueuedProjection?: (latch: AgentPresetGeneratedProjectionLatch) => void | Promise<void>
  }

  type MetadataField =
    | 'name'
    | 'description'
    | 'moduleIntergration'
    | 'finalOutputTemplate'
    | 'enabled'
    | 'maxConcurrency'
  const METADATA_FIELDS: MetadataField[] = [
    'name',
    'description',
    'moduleIntergration',
    'finalOutputTemplate',
    'enabled',
    'maxConcurrency',
  ]
  type AuthoringEditorApi = {
    insertAtCaret: (text: string) => Promise<boolean>
    focusEditor: () => void
  }
  let { mode, preset, busy = false, commandError = '', onSave, onCancel }: Props = $props()
  // svelte-ignore state_referenced_locally
  const initialPreset = preset
  const presetId = initialPreset?.id ?? ''
  let name = $state(initialPreset?.name ?? language.agentPresets.newPresetName)
  let description = $state(initialPreset?.description ?? '')
  let moduleIntegrations = $state(parseAgentPresetModuleIntegration(initialPreset?.moduleIntergration))
  let moduleIntegrationDraft = $state('')
  let finalOutputTemplate = $state(initialPreset?.finalOutputTemplate ?? '')
  let finalOutputEditor: AuthoringEditorApi | undefined
  let sampleMainOutput = $state(language.agentPresets.finalOutputSampleMainDefault)
  let sampleAgentOutputs = $state<Record<string, string>>({})
  let enabled = $state(initialPreset?.enabled ?? true)
  let limitConcurrency = $state(initialPreset?.maxConcurrency !== undefined)
  let maxConcurrency = $state(initialPreset?.maxConcurrency ?? 4)
  const initialMetadata = metadataSnapshot(initialPreset)

  let selectedAgentId = $state('')
  let selectedAddPhase = $state<AgentPresetStepPhase>('beforeMain')
  let selectedAgentRecoveryBaseline = ''
  let pendingAddedUseId = $state('')
  let pendingAddedAgentId = $state('')
  let pendingAddedOutputKey = $state('')
  let pendingAddedPhase = $state<AgentPresetStepPhase>('beforeMain')
  let usePositionAnnouncement = $state('')
  let editingUseId = $state<string | null>(null)
  let useRecoveryBaseline = ''
  let useBusy = $state(false)
  let useError = $state('')
  let useEnabled = $state(true)
  let usePhase = $state<AgentPresetStepPhase>('beforeMain')
  let useDependencies = $state<string[]>([])
  let useOutputKey = $state('')
  let useDestination = $state<AgentPresetStepDestination>('promptOutput')
  let failureMode = $state<AgentPresetStepFailurePolicy['mode']>('required')
  let fallbackText = $state('')
  let overrideModel = $state(false)
  let modelMode = $state<AgentPresetStepModelSelection['mode']>('inheritMain')
  let modelProfileId = $state('')
  let lastValidModelProfileId = $state('')
  let overrideRuntime = $state(false)
  let timeoutMs = $state(30_000)
  let maxInputChars = $state(24_000)
  let maxOutputChars = $state(1_200)
  let temperature = $state(1)
  let structuredOutputStrict = $state(false)
  let nestedAgentOpen = $state(false)
  let nestedAgentBusy = $state(false)
  let nestedAgentError = $state('')
  let nestedAgentNotice = $state('')
  let pendingCreatedAgentId = $state('')
  let pendingCreatedAgentName = $state('')
  let createAgentInvoker = $state<HTMLElement>()
  let drawerNode = $state<HTMLElement>()

  const ownerPresetValue = $derived(settingsResourceState.value.agentPresets)
  let ownerPresets = $derived(readAgentPresetOwners(ownerPresetValue))
  let livePreset = $derived(
    presetId
      ? resolveLivePreset(ownerPresets, presetId, settingsResourceState.groupStatuses.agents === 'ready', initialPreset)
      : safeAgentPreset(initialPreset),
  )
  let agents = $derived(readAgentOwners(settingsResourceState.value.agents))
  let moduleIntegrationOptions = $derived(agentPresetModuleIntegrationOptions(collectionsResourceState.values.modules))
  let unknownModuleIntegrations = $derived(
    unknownAgentPresetModuleIntegrations(moduleIntegrations, moduleIntegrationOptions),
  )
  let uses = $derived(livePreset?.agentUses ?? [])
  let resolvedSteps = $derived(
    livePreset && hasUniqueAgentPresetStepIds(livePreset) ? resolveAgentPresetSteps(livePreset, agents) : [],
  )
  let beforeMainSteps = $derived(resolvedSteps.filter((step) => step.phase === 'beforeMain'))
  let afterMainSteps = $derived(resolvedSteps.filter((step) => step.phase === 'afterMain'))
  let finalOutputAgentKeys = $derived([
    ...new Set(resolvedSteps.filter((step) => step.enabled).map((step) => step.outputKey)),
  ])
  let finalOutputAutocompleteOptions = $derived([
    'slot::mainOutput',
    ...finalOutputAgentKeys.map((key) => `agent::${key}`),
  ])
  let modelProfiles = $derived(readModelProfileOwners(settingsResourceState.value.modelProfiles))
  let modelProfileItems = $derived(
    hasUniqueModelProfileOrder(settingsResourceState.value.modelProfileOrder)
      ? modelProfileListItems(modelProfiles, settingsResourceState.value.modelProfileOrder)
      : [],
  )
  let editingStep = $derived(editingUseId ? resolvedSteps.find((step) => step.id === editingUseId) : undefined)
  let metadataPatch = $derived(sparseMetadata(initialMetadata, metadataForSave()))
  let metadataDirty = $derived(Object.keys(metadataPatch).length > 0)
  let locked = $derived(busy || useBusy)
  let metadataIssueCount = $derived.by(() => draftPresetIssueCount())
  let canSaveMetadata = $derived(metadataIssueCount === 0 && !locked && (mode === 'create' || metadataDirty))
  let metadataSaveDisabledReason = $derived(
    locked
      ? language.agentPresets.saveWaiting
      : metadataIssueCount > 0
        ? language.agentPresets.saveFixIssues(metadataIssueCount)
        : !canSaveMetadata
          ? language.agentPresets.saveNoChanges
          : '',
  )
  let canSaveUse = $derived(
    !!editingUseId &&
      isValidAgentPresetOutputKey(useOutputKey.trim()) &&
      (!overrideModel || modelMode === 'inheritMain' || modelProfileId.trim().length > 0) &&
      !locked,
  )
  let dependencyOptions = $derived(availableDependencies())
  let presetPlanning = $derived(
    planAgentPreset({
      database: { agents, agentPresets: ownerPresets, modelProfiles },
      preset: draftPreset(),
    }),
  )
  let finalOutputDiagnostics = $derived(
    presetPlanning.plan
      ? diagnoseAgentPresetOutputReferences(resolvedSteps, presetPlanning.plan, finalOutputTemplate).filter(
          (diagnostic) => diagnostic.path === 'agentPreset.finalOutputTemplate',
        )
      : [],
  )
  let finalOutputPreview = $derived(
    expandAgentPresetOutputCbs(
      finalOutputTemplate.replace(/\{\{\s*slot::mainOutput\s*\}\}/g, sampleMainOutput),
      (key) => sampleAgentOutputs[key],
    ),
  )

  $effect(() => {
    for (const key of finalOutputAgentKeys)
      sampleAgentOutputs[key] ??= language.agentPresets.finalOutputSampleAgentDefault(key)
  })

  $effect(() => {
    if (!pendingAddedUseId && !pendingAddedOutputKey) return
    const added = resolvedSteps.find(
      (step) =>
        (pendingAddedUseId && step.id === pendingAddedUseId) ||
        (!pendingAddedUseId &&
          step.agentId === pendingAddedAgentId &&
          step.outputKey === pendingAddedOutputKey &&
          step.phase === pendingAddedPhase),
    )
    if (!added) return
    pendingAddedUseId = ''
    pendingAddedAgentId = ''
    pendingAddedOutputKey = ''
    startEdit(added)
    void focusUseEditor()
  })

  function readAgentOwners(value: unknown): AgentRecord[] {
    if (!Array.isArray(value)) return []
    const ids = new Set<string>()
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
      const id = (candidate as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return []
      ids.add(id)
    }
    return value as AgentRecord[]
  }

  function readAgentPresetOwners(value: unknown): AgentPresetRecord[] {
    if (!Array.isArray(value)) return []
    const ids = new Set<string>()
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
      const id = (candidate as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return []
      ids.add(id)
      if (!hasUniqueAgentPresetStepIds(candidate as AgentPresetRecord)) return []
    }
    return value as AgentPresetRecord[]
  }

  function safeAgentPreset(candidate: AgentPresetRecord | undefined): AgentPresetRecord | undefined {
    if (
      !candidate ||
      typeof candidate.id !== 'string' ||
      candidate.id.trim() !== candidate.id ||
      candidate.id.length === 0
    ) {
      return undefined
    }
    return hasUniqueAgentPresetStepIds(candidate) ? candidate : undefined
  }

  function resolveLivePreset(
    ownerPresets: readonly AgentPresetRecord[],
    presetId: string,
    ownerReady: boolean,
    fallback: AgentPresetRecord | undefined,
  ): AgentPresetRecord | undefined {
    const ownerPreset = uniqueAgentPresetById(ownerPresets, presetId)
    return ownerReady ? ownerPreset : (ownerPreset ?? safeAgentPreset(fallback))
  }

  function uniqueAgentPresetById(rows: readonly AgentPresetRecord[], id: string): AgentPresetRecord | undefined {
    let match: AgentPresetRecord | undefined
    for (const candidate of rows) {
      if (candidate.id !== id) continue
      if (match) return undefined
      match = candidate
    }
    return match
  }

  function hasUniqueAgentPresetStepIds(candidate: AgentPresetRecord): boolean {
    const steps = Array.isArray(candidate.agentUses) ? candidate.agentUses : candidate.steps
    if (!Array.isArray(steps)) return false
    const ids = new Set<string>()
    for (const step of steps) {
      const id = step?.id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return false
      ids.add(id)
    }
    return true
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

  $effect(() => {
    if (!selectedAgentId && agents[0]) {
      selectedAgentId = agents[0].id
      selectedAgentRecoveryBaseline = selectedAgentId
    }
  })

  $effect(() => {
    if (!pendingCreatedAgentId && !pendingCreatedAgentName) return
    const idMatch = pendingCreatedAgentId
      ? agents.find((candidate) => candidate.id === pendingCreatedAgentId)
      : undefined
    const nameMatches = pendingCreatedAgentName
      ? agents.filter((candidate) => candidate.name === pendingCreatedAgentName)
      : []
    const resolved = idMatch ?? (nameMatches.length === 1 ? nameMatches[0] : undefined)
    if (!resolved) return
    selectedAgentId = resolved.id
    selectedAgentRecoveryBaseline = resolved.id
    pendingCreatedAgentId = ''
    pendingCreatedAgentName = ''
    nestedAgentNotice = language.agentPresets.createdAgentReady(resolved.name)
  })

  function metadataForSave(): AgentPresetSnapshot {
    return {
      name: name.trim(),
      description: description.trim() || null,
      moduleIntergration: serializeAgentPresetModuleIntegration(moduleIntegrations) || null,
      finalOutputTemplate: finalOutputTemplate.trim() ? finalOutputTemplate : null,
      enabled,
      maxConcurrency: limitConcurrency
        ? clamp(maxConcurrency, AGENT_PRESET_MAX_CONCURRENCY_MIN, AGENT_PRESET_MAX_CONCURRENCY_MAX)
        : null,
    }
  }

  function draftPreset(): AgentPresetRecord {
    return {
      ...(livePreset ?? {
        id: 'draft-agent-preset',
        version: 1,
        steps: [],
        agentUses: [],
      }),
      name: name.trim(),
      enabled,
      ...(description.trim() ? { description: description.trim() } : { description: undefined }),
      ...(serializeAgentPresetModuleIntegration(moduleIntegrations)
        ? { moduleIntergration: serializeAgentPresetModuleIntegration(moduleIntegrations) }
        : { moduleIntergration: undefined }),
      ...(finalOutputTemplate.trim() ? { finalOutputTemplate } : { finalOutputTemplate: undefined }),
      ...(limitConcurrency
        ? { maxConcurrency: clamp(maxConcurrency, AGENT_PRESET_MAX_CONCURRENCY_MIN, AGENT_PRESET_MAX_CONCURRENCY_MAX) }
        : { maxConcurrency: undefined }),
    }
  }

  function draftPresetIssueCount(): number {
    return presetPlanning.issues.length + presetPlanning.incompleteIssues.length
  }

  function openNestedAgent(): void {
    if (nestedAgentBusy) return
    nestedAgentError = ''
    nestedAgentNotice = ''
    nestedAgentOpen = true
  }

  async function closeNestedAgent(): Promise<void> {
    if (nestedAgentBusy) return
    nestedAgentOpen = false
    nestedAgentError = ''
    await tick()
    createAgentInvoker?.querySelector<HTMLButtonElement>('button')?.focus()
  }

  async function saveNestedAgent(snapshot: AgentSnapshot): Promise<boolean> {
    if (nestedAgentBusy) return false
    nestedAgentBusy = true
    nestedAgentError = ''
    const outcome = await createAgent(snapshot)
    nestedAgentBusy = false
    if (outcome.status === 'failed') {
      nestedAgentError =
        outcome.result.status === 'conflict'
          ? language.agentPresets.commandConflict
          : outcome.result.status === 'error'
            ? outcome.result.error
            : language.agentPresets.commandUnavailable
      return false
    }
    pendingCreatedAgentName = typeof snapshot.name === 'string' ? snapshot.name.trim() : ''
    pendingCreatedAgentId = outcome.status === 'accepted' ? outcome.result.agentId : ''
    nestedAgentNotice = outcome.status === 'queued' ? language.agentPresets.commandQueued : ''
    return true
  }

  async function saveMetadata(): Promise<void> {
    if (!canSaveMetadata) return
    const attempted = mode === 'create' ? metadataForSave() : metadataPatch
    const recoveryAtSave = JSON.stringify(metadataRecoveryDraft())
    const accepted = await onSave(attempted)
    if (accepted === true && JSON.stringify(metadataRecoveryDraft()) === recoveryAtSave) onCancel()
  }

  function handleModelProfileChange(event: Event): void {
    const select = event.currentTarget
    if (!(select instanceof HTMLSelectElement)) return
    if (isModelProfileDividerSelectValue(select.value)) {
      modelProfileId = lastValidModelProfileId
      select.value = lastValidModelProfileId
      return
    }
    lastValidModelProfileId = modelProfileId
  }

  function metadataSnapshot(record: AgentPresetRecord | undefined): AgentPresetSnapshot {
    return record
      ? {
          name: record.name,
          description: record.description ?? null,
          moduleIntergration: record.moduleIntergration ?? null,
          finalOutputTemplate: record.finalOutputTemplate ?? null,
          enabled: record.enabled,
          maxConcurrency: record.maxConcurrency ?? null,
        }
      : metadataForSave()
  }

  function sparseMetadata(before: AgentPresetSnapshot, after: AgentPresetSnapshot): AgentPresetSnapshot {
    const patch: AgentPresetSnapshot = {}
    for (const key of METADATA_FIELDS) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key] as never
    }
    return patch
  }

  function useForStep(step: AgentPresetStepRecord): AgentPresetUseRecord | undefined {
    return uses.find((use) => use.id === step.id)
  }

  function startEdit(step: AgentPresetStepRecord): void {
    const use = useForStep(step)
    if (!use) return
    editingUseId = use.id
    useEnabled = use.enabled
    usePhase = use.phase
    useDependencies = [...use.dependencies]
    useOutputKey = use.outputKey
    useDestination = use.destination
    failureMode = use.failurePolicy.mode
    fallbackText = use.failurePolicy.mode === 'fallbackText' ? use.failurePolicy.text : ''
    overrideModel = use.modelOverride !== undefined
    modelMode = use.modelOverride?.mode ?? 'inheritMain'
    modelProfileId = use.modelOverride?.mode === 'modelProfile' ? use.modelOverride.profileId : ''
    lastValidModelProfileId = modelProfileId
    overrideRuntime = use.runtimeOverride !== undefined
    timeoutMs = use.runtimeOverride?.timeoutMs ?? 30_000
    maxInputChars = use.runtimeOverride?.maxInputChars ?? 24_000
    maxOutputChars = use.runtimeOverride?.maxOutputChars ?? 1_200
    temperature = (use.runtimeOverride?.temperature ?? 100) / 100
    structuredOutputStrict = use.runtimeOverride?.structuredOutputStrict ?? false
    useRecoveryBaseline = JSON.stringify(useRecoveryDraft())
    useError = ''
  }

  function closeUseEditor(): void {
    editingUseId = null
    useError = ''
  }

  function usePatch(): AgentPresetUseSnapshot {
    const failurePolicy: AgentPresetStepFailurePolicy =
      failureMode === 'fallbackText' ? { mode: 'fallbackText', text: fallbackText } : { mode: failureMode }
    return {
      enabled: useEnabled,
      phase: usePhase,
      dependencies: useDependencies.filter((id) => dependencyOptions.some((step) => step.id === id)),
      outputKey: useOutputKey.trim(),
      destination: normalizedDestination(usePhase, useDestination),
      failurePolicy,
      modelOverride: overrideModel
        ? modelMode === 'modelProfile'
          ? { mode: 'modelProfile', profileId: modelProfileId.trim() }
          : { mode: 'inheritMain' }
        : null,
      runtimeOverride: overrideRuntime
        ? {
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
            temperature: clamp(Math.round(Number(temperature) * 100), 0, 200),
            structuredOutputStrict,
          }
        : null,
    }
  }

  async function addSelectedAgent(): Promise<void> {
    if (!presetId || !selectedAgentId || locked) return
    const agent = agents.find((candidate) => candidate.id === selectedAgentId)
    if (!agent) return
    const use = defaultAgentPresetUse(agent)
    use.phase = selectedAddPhase
    use.destination = selectedAddPhase === 'beforeMain' ? 'promptOutput' : 'intermediate'
    use.outputKey = uniqueOutputKey(use.outputKey, selectedAddPhase)
    const addedPosition = resolvedSteps.filter((step) => step.phase === use.phase).length + 1
    useBusy = true
    useError = ''
    const result = await addAgentToPreset(presetId, use)
    useBusy = false
    if (handleUseResult(result) && selectedAgentId === agent.id) {
      selectedAgentRecoveryBaseline = selectedAgentId
      pendingAddedUseId = result.status === 'accepted' ? result.result.useId : ''
      pendingAddedAgentId = agent.id
      pendingAddedOutputKey = use.outputKey
      pendingAddedPhase = use.phase
      usePositionAnnouncement = language.agentPresets.agentAddedPosition(
        agent.name,
        phaseLabel(use.phase),
        addedPosition,
        addedPosition,
      )
    }
  }

  async function saveUse(): Promise<void> {
    if (!presetId || !editingUseId || !canSaveUse) return
    useBusy = true
    useError = ''
    const result = await updateAgentPresetUse(presetId, editingUseId, usePatch())
    useBusy = false
    if (handleUseResult(result)) closeUseEditor()
  }

  async function duplicateUse(step: AgentPresetStepRecord): Promise<void> {
    const source = useForStep(step)
    if (!presetId || !source || locked) return
    const copy: AgentPresetUseSnapshot = {
      ...JSON.parse(JSON.stringify(source)),
      outputKey: uniqueOutputKey(`${source.outputKey}_copy`, source.phase),
    }
    delete copy.id
    useBusy = true
    const result = await addAgentToPreset(presetId, copy)
    useBusy = false
    handleUseResult(result)
  }

  async function removeUse(step: AgentPresetStepRecord): Promise<void> {
    if (!presetId || locked || !window.confirm(language.agentPresets.deleteStepConfirm(step.name))) return
    useBusy = true
    const result = await removeAgentFromPreset(presetId, step.id)
    useBusy = false
    if (handleUseResult(result) && editingUseId === step.id) closeUseEditor()
  }

  async function moveUse(step: AgentPresetStepRecord, delta: -1 | 1): Promise<void> {
    if (!presetId || locked) return
    const phaseSteps = resolvedSteps.filter((candidate) => candidate.phase === step.phase)
    const index = phaseSteps.findIndex((candidate) => candidate.id === step.id)
    const nextIndex = index + delta
    if (index < 0 || nextIndex < 0 || nextIndex >= phaseSteps.length) return
    const phaseIds = phaseSteps.map((candidate) => candidate.id)
    const [moved] = phaseIds.splice(index, 1)
    phaseIds.splice(nextIndex, 0, moved)
    let cursor = 0
    const ids = resolvedSteps.map((candidate) =>
      candidate.phase === step.phase ? (phaseIds[cursor++] ?? candidate.id) : candidate.id,
    )
    useBusy = true
    const result = await reorderAgentPresetUses(presetId, ids)
    useBusy = false
    if (handleUseResult(result)) {
      usePositionAnnouncement = language.agentPresets.agentMovedPosition(
        step.name,
        phaseLabel(step.phase),
        nextIndex + 1,
        phaseSteps.length,
      )
    }
  }

  function handleUseResult(outcome: AgentMutationOutcome<any>): boolean {
    if (outcome.status === 'accepted') return true
    if (outcome.status === 'queued') {
      useError = language.agentPresets.commandQueued
      return true
    }
    useError =
      outcome.result.status === 'conflict'
        ? language.agentPresets.commandConflict
        : outcome.result.status === 'error'
          ? outcome.result.error
          : language.agentPresets.commandUnavailable
    return false
  }

  function availableDependencies(): AgentPresetStepRecord[] {
    const currentIndex = editingUseId
      ? resolvedSteps.findIndex((step) => step.id === editingUseId)
      : resolvedSteps.length
    return resolvedSteps.filter(
      (step, index) => step.enabled && step.phase === usePhase && step.id !== editingUseId && index < currentIndex,
    )
  }

  function toggleDependency(id: string, checked: boolean): void {
    useDependencies = checked
      ? [...new Set([...useDependencies, id])]
      : useDependencies.filter((candidate) => candidate !== id)
  }

  function setPhase(phase: AgentPresetStepPhase): void {
    usePhase = phase
    useDestination = normalizedDestination(phase, useDestination)
    useDependencies = useDependencies.filter((id) => availableDependencies().some((step) => step.id === id))
  }

  function normalizedDestination(
    phase: AgentPresetStepPhase,
    destination: AgentPresetStepDestination,
  ): AgentPresetStepDestination {
    if (phase === 'beforeMain' && destination === 'finalOutput') return 'promptOutput'
    if (phase === 'afterMain' && destination === 'userInput') return 'intermediate'
    return destination
  }

  function phaseLabel(phase: AgentPresetStepPhase): string {
    return phase === 'beforeMain' ? language.agentPresets.beforeMain : language.agentPresets.afterMain
  }

  async function focusUseEditor(): Promise<void> {
    await tick()
    drawerNode?.querySelector<HTMLElement>('[data-risu-agent-preset-use-form]')?.focus()
  }

  function temperatureEffect(value: number): string {
    if (value < 0.7) return language.agentPresets.temperatureEffectFocused
    if (value <= 1.1) return language.agentPresets.temperatureEffectBalanced
    return language.agentPresets.temperatureEffectVaried
  }

  function uniqueOutputKey(base: string, phase: AgentPresetStepPhase): string {
    const used = new Set(resolvedSteps.filter((step) => step.phase === phase).map((step) => step.outputKey))
    if (!used.has(base)) return base
    for (let index = 2; index < 1_000; index += 1) {
      const candidate = `${base.slice(0, 60)}_${index}`
      if (!used.has(candidate)) return candidate
    }
    return `agent_${Date.now()}`
  }

  function clamp(value: unknown, min: number, max: number): number {
    const number = Math.round(Number(value))
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min
  }

  function addModuleIntegration(value: string = moduleIntegrationDraft): void {
    const normalized = value.trim()
    if (!normalized || locked) return
    moduleIntegrations = parseAgentPresetModuleIntegration([...moduleIntegrations, normalized].join(', '))
    moduleIntegrationDraft = ''
  }

  function removeModuleIntegration(value: string): void {
    if (locked) return
    moduleIntegrations = moduleIntegrations.filter((candidate) => candidate !== value)
  }

  function handleModuleIntegrationKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ',') return
    event.preventDefault()
    addModuleIntegration()
  }

  async function insertFinalOutputValue(token: string): Promise<void> {
    if (locked) return
    await finalOutputEditor?.insertAtCaret(token)
  }

  function finalOutputDiagnosticMessage(diagnostic: AgentPresetOutputReferenceDiagnostic): string {
    if (diagnostic.reason === 'disabled_output') {
      return language.agentPresets.finalOutputReferenceDisabled(diagnostic.token, diagnostic.key)
    }
    return language.agentPresets.finalOutputReferenceMissing(diagnostic.token, diagnostic.key)
  }

  function removeFinalOutputReference(diagnostic: AgentPresetOutputReferenceDiagnostic): void {
    finalOutputTemplate = finalOutputTemplate.replace(diagnostic.token, '')
  }

  function editFinalOutputProducer(diagnostic: AgentPresetOutputReferenceDiagnostic): void {
    const producer = resolvedSteps.find((step) => diagnostic.producerStepIds.includes(step.id))
    if (producer) startEdit(producer)
  }

  function requestClose(): void {
    if (locked || nestedAgentOpen) return
    if (metadataDirty && !window.confirm(language.agentPresets.discardChangesConfirm)) return
    onCancel()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || nestedAgentOpen) return
    event.preventDefault()
    event.stopPropagation()
    requestClose()
  }

  function metadataRecoveryDraft() {
    return {
      name,
      description,
      moduleIntergration: serializeAgentPresetModuleIntegration(moduleIntegrations),
      finalOutputTemplate,
      enabled,
      limitConcurrency,
      maxConcurrency,
    }
  }
  function useRecoveryDraft() {
    return {
      editingUseId,
      useEnabled,
      usePhase,
      useDependencies,
      useOutputKey,
      useDestination,
      failureMode,
      fallbackText,
      overrideModel,
      modelMode,
      modelProfileId,
      overrideRuntime,
      timeoutMs,
      maxInputChars,
      maxOutputChars,
      temperature,
      structuredOutputStrict,
    }
  }
  const metadataRecoveryBaseline = untrack(() => JSON.stringify(metadataRecoveryDraft()))
  onDestroy(
    registerWriterDraftCapture(() => {
      const metadata = metadataRecoveryDraft()
      const use = editingUseId ? useRecoveryDraft() : null
      const metadataChanged = JSON.stringify(metadata) !== metadataRecoveryBaseline
      const useChanged = use !== null && JSON.stringify(use) !== useRecoveryBaseline
      if (
        !metadataChanged &&
        !useChanged &&
        selectedAgentId === selectedAgentRecoveryBaseline &&
        selectedAddPhase === 'beforeMain'
      )
        return null
      const data = { metadata, use, selectedAgentId, selectedAddPhase }
      return $state.snapshot({
        key: `agent-preset:${presetId || 'new'}`,
        label: name || language.agentPresets.newPresetName,
        fields: [{ label: name || language.agentPresets.newPresetName, value: JSON.stringify(data, null, 2) }],
        data,
        baseline: {
          metadata: JSON.parse(metadataRecoveryBaseline),
          use: useRecoveryBaseline ? JSON.parse(useRecoveryBaseline) : null,
          selectedAgentId: selectedAgentRecoveryBaseline,
          selectedAddPhase: 'beforeMain',
        },
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
    bind:this={drawerNode}
    class="flex h-full w-full max-w-4xl flex-col border-l border-darkborderc bg-bgcolor text-textcolor shadow-xl"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-busy={locked}
    data-risu-agent-preset-editor
    onkeydown={handleKeydown}
    onclick={(event) => event.stopPropagation()}>
    <div class="flex items-start justify-between gap-3 border-b border-darkborderc p-4">
      <h3 class="text-xl font-semibold">
        {mode === 'create' ? language.agentPresets.createPreset : language.agentPresets.editPreset}
      </h3>
      <Button size="sm" styled="outlined" disabled={locked} onclick={requestClose}><XIcon size={16} /></Button>
    </div>
    <div class="flex-1 overflow-y-auto p-4" data-risu-agent-preset-editor-scroll-body>
      {#if commandError}<div class="mb-3 rounded-md border border-draculared p-3 text-sm text-draculared">
          {commandError}
        </div>{/if}
      <div class="grid gap-3 md:grid-cols-2">
        <label class="flex flex-col gap-1" data-risu-agent-preset-name-input>
          <span class="text-sm font-medium">{language.agentPresets.nameLabel}</span>
          <TextInput bind:value={name} fullwidth />
        </label>
        <div class="flex flex-col justify-end gap-2">
          <CheckInput
            bind:check={enabled}
            name={language.agentPresets.enabledLabel}
            onChange={(value) => (enabled = value)} />
          <CheckInput
            bind:check={limitConcurrency}
            name={language.agentPresets.limitConcurrency}
            onChange={(value) => (limitConcurrency = value)} />
        </div>
      </div>
      <label class="mt-3 flex flex-col gap-1">
        <span class="text-sm font-medium">{language.agentPresets.descriptionLabel}</span>
        <textarea
          data-risu-agent-preset-description-input
          class="min-h-20 rounded-md border border-darkborderc bg-transparent px-3 py-2 text-sm"
          bind:value={description}></textarea>
      </label>
      <section class="mt-3" data-risu-agent-preset-module-integration>
        <h4 class="text-sm font-medium">{language.agentPresets.moduleIntegrationLabel}</h4>
        <p class="text-xs text-textcolor2">{language.agentPresets.moduleIntegrationDescription}</p>
        <div class="mt-2 flex flex-wrap items-end gap-2">
          <label class="min-w-56 flex-1" for="agent-preset-module-value">
            <span class="mb-1 block text-xs font-medium">{language.agentPresets.moduleIntegrationValueLabel}</span>
            <input
              id="agent-preset-module-value"
              list="agent-preset-module-options"
              class="min-h-10 w-full rounded-md border border-darkborderc bg-transparent px-3 py-2 text-sm"
              placeholder={language.agentPresets.moduleIntegrationPlaceholder}
              bind:value={moduleIntegrationDraft}
              onkeydown={handleModuleIntegrationKeydown} />
          </label>
          <Button disabled={locked || !moduleIntegrationDraft.trim()} onclick={() => addModuleIntegration()}>
            {language.agentPresets.addModuleIntegration}
          </Button>
          <datalist id="agent-preset-module-options">
            {#each moduleIntegrationOptions as option (option.value)}
              <option value={option.value}
                >{option.label} — {option.kind === 'id'
                  ? language.agentPresets.moduleIdKind
                  : language.agentPresets.moduleNamespaceKind}</option>
            {/each}
          </datalist>
        </div>
        {#if moduleIntegrations.length === 0}
          <p class="mt-2 text-xs text-textcolor2">{language.agentPresets.noModuleIntegrations}</p>
        {:else}
          <ul class="mt-2 flex flex-wrap gap-2" aria-label={language.agentPresets.moduleIntegrationLabel}>
            {#each moduleIntegrations as value (value)}
              <li>
                <button
                  type="button"
                  class="inline-flex min-h-9 items-center gap-2 rounded-full border border-darkborderc bg-darkbutton px-3 py-1 text-sm hover:bg-darkbuttonhover"
                  aria-label={language.agentPresets.removeModuleIntegration(value)}
                  disabled={locked}
                  onclick={() => removeModuleIntegration(value)}>
                  <span>{value}</span><XIcon size={14} aria-hidden="true" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if unknownModuleIntegrations.length > 0}
          <ul class="mt-2 space-y-1 text-xs text-yellow-600" data-risu-agent-preset-module-warnings>
            {#each unknownModuleIntegrations as value (value)}
              <li>{language.agentPresets.unknownModuleIntegration(value)}</li>
            {/each}
          </ul>
        {/if}
      </section>
      {#if limitConcurrency}
        <label class="mt-3 flex max-w-xs flex-col gap-1">
          <span class="text-sm font-medium">{language.agentPresets.maxConcurrency}</span><NumberInput
            bind:value={maxConcurrency}
            min={AGENT_PRESET_MAX_CONCURRENCY_MIN}
            max={AGENT_PRESET_MAX_CONCURRENCY_MAX}
            fullwidth />
          <span class="text-xs text-textcolor2">
            {language.agentPresets.runtimeRange(AGENT_PRESET_MAX_CONCURRENCY_MIN, AGENT_PRESET_MAX_CONCURRENCY_MAX)}
            {language.agentPresets.maxConcurrencyEffect(Number(maxConcurrency))}
          </span>
        </label>
      {/if}

      <section class="mt-5 rounded-md border border-darkborderc p-3" data-risu-agent-preset-final-output>
        <h4 class="text-sm font-medium">{language.agentPresets.finalOutputTemplateLabel}</h4>
        <p class="text-xs text-textcolor2">{language.agentPresets.finalOutputTemplateDescription}</p>
        <div class="mt-1 font-mono">
          <TextAreaInput
            bind:this={finalOutputEditor}
            bind:value={finalOutputTemplate}
            fullwidth
            height="32"
            popupEditor={true}
            autocompleteOptions={finalOutputAutocompleteOptions}
            placeholder={language.agentPresets.finalOutputTemplatePlaceholder}
            ariaLabel={language.agentPresets.finalOutputTemplateLabel} />
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-1.5" data-risu-agent-preset-final-output-variables>
          <span class="mr-1 text-xs text-textcolor2">{language.agentPresets.finalOutputVariablesLabel}</span>
          <button
            type="button"
            class="min-h-9 rounded-md border border-darkborderc bg-darkbutton px-2 py-1 text-xs hover:bg-darkbuttonhover"
            aria-label={language.agentPresets.insertValue('main output')}
            data-risu-agent-preset-insert-output="mainOutput"
            onclick={() => insertFinalOutputValue('{{slot::mainOutput}}')}
            ><code>{'{{slot::mainOutput}}'}</code></button>
          {#each finalOutputAgentKeys as outputKey (outputKey)}
            <button
              type="button"
              class="min-h-9 rounded-md border border-darkborderc bg-darkbutton px-2 py-1 text-xs hover:bg-darkbuttonhover"
              aria-label={language.agentPresets.insertValue(outputKey)}
              data-risu-agent-preset-insert-output={outputKey}
              onclick={() => insertFinalOutputValue(`{{agent::${outputKey}}}`)}
              ><code>{`{{agent::${outputKey}}}`}</code></button>
          {/each}
        </div>
        {#if finalOutputDiagnostics.length > 0}
          <ul class="mt-3 space-y-2" data-risu-agent-preset-final-output-diagnostics>
            {#each finalOutputDiagnostics as diagnostic (`${diagnostic.index}:${diagnostic.token}`)}
              <li class="rounded-md border border-yellow-600 p-2 text-sm text-yellow-500">
                <p>{finalOutputDiagnosticMessage(diagnostic)}</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  {#if diagnostic.producerStepIds.length > 0}
                    <Button size="sm" styled="outlined" onclick={() => editFinalOutputProducer(diagnostic)}>
                      {language.agentPresets.editProducer}
                    </Button>
                  {/if}
                  <Button size="sm" styled="outlined" onclick={() => removeFinalOutputReference(diagnostic)}>
                    {language.agentPresets.removeReference}
                  </Button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
        <details class="mt-3 border-t border-darkborderc pt-3" data-risu-agent-preset-final-output-preview>
          <summary class="cursor-pointer text-sm font-semibold"
            >{language.agentPresets.finalOutputPreviewTitle}</summary>
          <p class="mt-1 text-xs text-textcolor2">{language.agentPresets.finalOutputPreviewDescription}</p>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium">{language.agentPresets.finalOutputSampleMainLabel}</span>
              <TextInput bind:value={sampleMainOutput} fullwidth />
            </label>
            {#each finalOutputAgentKeys as outputKey (outputKey)}
              <label class="flex flex-col gap-1">
                <span class="text-xs font-medium">{language.agentPresets.finalOutputSampleAgentLabel(outputKey)}</span>
                <TextInput bind:value={sampleAgentOutputs[outputKey]} fullwidth />
              </label>
            {/each}
          </div>
          <pre
            class="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-darkbg p-3 text-sm"
            data-risu-agent-preset-final-output-preview-value>{finalOutputPreview}</pre>
        </details>
      </section>

      <div class="mt-5 border-t border-darkborderc pt-4">
        <div class="flex flex-wrap items-end gap-2">
          <label class="min-w-64 flex-1">
            <span class="mb-1 block text-sm font-medium">{language.agentPresets.selectAgent}</span>
            <SelectInput
              bind:value={selectedAgentId}
              className="w-full"
              disabled={mode !== 'edit' || agents.length === 0}>
              {#each agents as agent (agent.id)}<option value={agent.id}>{agent.name}</option>{/each}
            </SelectInput>
          </label>
          <label class="min-w-44" data-risu-agent-add-phase>
            <span class="mb-1 block text-sm font-medium">{language.agentPresets.addAgentPhaseLabel}</span>
            <SelectInput
              bind:value={selectedAddPhase}
              className="w-full"
              disabled={mode !== 'edit'}
              onchange={(event) => (selectedAddPhase = event.currentTarget.value as AgentPresetStepPhase)}>
              <option value="beforeMain">{language.agentPresets.beforeMain}</option>
              <option value="afterMain">{language.agentPresets.afterMain}</option>
            </SelectInput>
          </label>
          <Button disabled={mode !== 'edit' || !selectedAgentId || locked} onclick={addSelectedAgent}>
            <span class="inline-flex items-center gap-2"><PlusIcon size={16} />{language.agentPresets.addAgent}</span>
          </Button>
        </div>
        {#if mode === 'create'}<p class="mt-2 text-sm text-textcolor2">
            {language.agentPresets.savePresetBeforeSteps}
          </p>{/if}
        {#if agents.length === 0}
          <div class="mt-3 rounded-md border border-darkborderc p-3" data-risu-agent-preset-no-agents>
            <p class="text-sm text-textcolor2">{language.agentPresets.noAgentsAvailable}</p>
            <span class="mt-2 inline-block" bind:this={createAgentInvoker}>
              <Button disabled={nestedAgentBusy} onclick={openNestedAgent}>
                <span class="inline-flex items-center gap-2"
                  ><PlusIcon size={16} />{language.agentPresets.createAgent}</span>
              </Button>
            </span>
          </div>
        {:else}
          <span class="mt-2 inline-block" bind:this={createAgentInvoker}>
            <Button size="sm" styled="outlined" disabled={nestedAgentBusy} onclick={openNestedAgent}>
              {language.agentPresets.createAnotherAgent}
            </Button>
          </span>
        {/if}
        {#if nestedAgentNotice}<p
            class="mt-2 text-sm text-textcolor2"
            aria-live="polite"
            data-risu-agent-created-notice>
            {nestedAgentNotice}
          </p>{/if}
        <p class="sr-only" aria-live="polite" data-risu-agent-use-position-announcement>
          {usePositionAnnouncement}
        </p>
      </div>

      {#if mode === 'edit'}
        <div class="mt-4 flex flex-col gap-4">
          {#each [['beforeMain', beforeMainSteps], ['afterMain', afterMainSteps]] as phaseGroup}
            {@const phase = phaseGroup[0] as AgentPresetStepPhase}
            {@const phaseSteps = phaseGroup[1] as AgentPresetStepRecord[]}
            <section>
              <h4 class="mb-2 font-semibold">
                {phase === 'beforeMain' ? language.agentPresets.beforeMain : language.agentPresets.afterMain}
              </h4>
              {#if phaseSteps.length === 0}<p class="text-sm text-textcolor2">
                  {language.agentPresets.noInvocationsInPhase}
                </p>{/if}
              <div class="flex flex-col gap-2">
                {#each phaseSteps as step, index (step.id)}
                  <article
                    class="rounded-md border border-darkborderc p-3"
                    data-risu-agent-preset-step
                    data-step-id={step.id}
                    aria-label={`${step.name}, ${phaseLabel(step.phase)}, ${language.agentPresets.agentUsePosition(index + 1, phaseSteps.length)}`}>
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-medium">{step.name}</span>
                      <span class="text-xs text-textcolor2" data-risu-agent-use-position>
                        {language.agentPresets.agentUsePosition(index + 1, phaseSteps.length)}
                      </span>
                      <div class="ml-auto flex gap-1">
                        <Button
                          size="sm"
                          styled="outlined"
                          disabled={locked || index === 0}
                          ariaLabel={language.agentPresets.moveAgentUseUp(step.name)}
                          onclick={() => moveUse(step, -1)}><ArrowUpIcon size={14} /></Button>
                        <Button
                          size="sm"
                          styled="outlined"
                          disabled={locked || index === phaseSteps.length - 1}
                          ariaLabel={language.agentPresets.moveAgentUseDown(step.name)}
                          onclick={() => moveUse(step, 1)}><ArrowDownIcon size={14} /></Button>
                        <Button size="sm" styled="outlined" disabled={locked} onclick={() => startEdit(step)}
                          >{language.agentPresets.edit}</Button>
                        <Button size="sm" styled="outlined" disabled={locked} onclick={() => duplicateUse(step)}
                          ><CopyIcon size={14} /></Button>
                        <Button size="sm" styled="danger" disabled={locked} onclick={() => removeUse(step)}
                          ><TrashIcon size={14} /></Button>
                      </div>
                    </div>
                    <details class="mt-2 text-xs" data-risu-agent-use-technical-details>
                      <summary class="cursor-pointer text-textcolor2">{language.agentPresets.technicalDetails}</summary>
                      <dl class="mt-2 grid gap-1 sm:grid-cols-[auto_1fr]">
                        <dt class="text-textcolor2">{language.agentPresets.agentIdLabel}</dt>
                        <dd><code class="break-all select-all">{step.agentId}</code></dd>
                        <dt class="text-textcolor2">{language.agentPresets.outputKeyTechnicalLabel}</dt>
                        <dd><code class="break-all select-all">{step.outputKey}</code></dd>
                        <dt class="text-textcolor2">{language.agentPresets.phaseTechnicalLabel}</dt>
                        <dd><code class="break-all select-all">{step.phase}</code></dd>
                      </dl>
                    </details>
                  </article>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {/if}

      {#if editingUseId && editingStep}
        <section class="mt-4 rounded-md border border-selected p-3" data-risu-agent-preset-use-form tabindex="-1">
          <div class="flex items-center justify-between">
            <h4 class="font-semibold">{language.agentPresets.editInvocation}: {editingStep.name}</h4>
            <Button size="sm" styled="outlined" onclick={closeUseEditor}>{language.agentPresets.cancel}</Button>
          </div>
          <p class="mt-1 text-xs text-textcolor2">{language.agentPresets.agentDefaultsHelp}</p>
          {#if useError}<div class="mt-2 text-sm text-draculared">{useError}</div>{/if}
          <div class="mt-3 grid gap-3 md:grid-cols-2">
            <label class="flex flex-col gap-1"
              ><span class="text-sm">{language.agentPresets.stepPhaseLabel}</span><SelectInput
                value={usePhase}
                onchange={(event) => setPhase(event.currentTarget.value as AgentPresetStepPhase)}
                ><option value="beforeMain">{language.agentPresets.beforeMain}</option><option value="afterMain"
                  >{language.agentPresets.afterMain}</option
                ></SelectInput
              ></label>
            <label class="flex flex-col gap-1"
              ><span class="text-sm">{language.agentPresets.outputKey}</span><TextInput
                bind:value={useOutputKey}
                fullwidth />{#if useOutputKey && !isValidAgentPresetOutputKey(useOutputKey)}<span
                  class="text-xs text-draculared">{language.agentPresets.invalidOutputKey}</span
                >{/if}</label>
            <CheckInput
              bind:check={useEnabled}
              name={language.agentPresets.invocationEnabled}
              onChange={(value) => (useEnabled = value)} />
            <label class="flex flex-col gap-1"
              ><span class="text-sm">{language.agentPresets.destinationLabel}</span><SelectInput
                bind:value={useDestination}
                ><option value="promptOutput">{language.agentPresets.destinationPromptOutput}</option><option
                  value="intermediate">{language.agentPresets.destinationIntermediate}</option
                >{#if usePhase === 'beforeMain'}<option value="userInput"
                    >{language.agentPresets.destinationUserInput}</option
                  >{:else}<option value="finalOutput">{language.agentPresets.destinationFinalOutput}</option
                  >{/if}</SelectInput
              ></label>
            <label class="flex flex-col gap-1"
              ><span class="text-sm">{language.agentPresets.failurePolicyLabel}</span><SelectInput
                bind:value={failureMode}
                ><option value="required">{language.agentPresets.failurePolicyRequired}</option><option value="optional"
                  >{language.agentPresets.failurePolicyOptional}</option
                ><option value="fallbackText">{language.agentPresets.failurePolicyFallbackText}</option><option
                  value="stopGeneration">{language.agentPresets.failurePolicyStopGeneration}</option
                ></SelectInput
              ></label>
          </div>
          {#if failureMode === 'fallbackText'}<textarea
              class="mt-2 min-h-20 w-full rounded-md border border-darkborderc bg-transparent p-2 text-sm"
              bind:value={fallbackText}></textarea
            >{/if}
          <div class="mt-3 rounded-md border border-darkborderc p-3">
            <h5 class="text-sm font-semibold">{language.agentPresets.dependenciesLabel}</h5>
            {#if dependencyOptions.length === 0}<p class="mt-1 text-sm text-textcolor2">
                {language.agentPresets.noDependencyOptions}
              </p>{/if}
            {#each dependencyOptions as dependency (dependency.id)}<CheckInput
                check={useDependencies.includes(dependency.id)}
                name={dependency.name}
                onChange={(value) => toggleDependency(dependency.id, value)} />{/each}
          </div>
          <div class="mt-3 grid gap-3 md:grid-cols-2">
            <CheckInput
              bind:check={overrideModel}
              name={language.agentPresets.modelOverride}
              onChange={(value) => (overrideModel = value)} />
            <CheckInput
              bind:check={overrideRuntime}
              name={language.agentPresets.runtimeOverride}
              onChange={(value) => (overrideRuntime = value)} />
          </div>
          {#if overrideModel}<div class="mt-2 grid gap-2 md:grid-cols-2">
              <SelectInput bind:value={modelMode}
                ><option value="inheritMain">{language.agentPresets.inheritMainModel}</option><option
                  value="modelProfile">{language.agentPresets.selectedModelProfile}</option
                ></SelectInput
              >{#if modelMode === 'modelProfile'}<SelectInput
                  bind:value={modelProfileId}
                  onchange={handleModelProfileChange}
                  ><option value="">{language.agentPresets.noModelProfiles}</option
                  >{#each modelProfileItems as item (`${item.kind}:${item.kind === 'profile' ? item.profile.id : item.id}`)}
                    {#if item.kind === 'divider'}<option
                        value={modelProfileDividerSelectValue(item.id)}
                        data-model-profile-divider="true">---</option
                      >{:else}<option value={item.profile.id}>{item.profile.name ?? item.profile.id}</option>{/if}
                  {/each}</SelectInput
                >{/if}
            </div>{/if}
          {#if overrideRuntime}<div class="mt-2 grid gap-3 sm:grid-cols-2">
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
                  {language.agentPresets.runtimeRange(0, 2)}
                  {temperatureEffect(Number(temperature))}
                </span>
              </label>
            </div>
            <div class="mt-2">
              <CheckInput
                bind:check={structuredOutputStrict}
                name={language.agentPresets.structuredOutputStrict}
                onChange={(value) => (structuredOutputStrict = value)} />
            </div>{/if}
          <div class="mt-3 flex justify-end">
            <Button disabled={!canSaveUse} onclick={saveUse}>{language.agentPresets.saveInvocation}</Button>
          </div>
        </section>
      {/if}

      <details class="mt-4 rounded-md border border-darkborderc p-3" data-risu-agent-preset-technical-details>
        <summary class="cursor-pointer text-sm font-semibold">{language.agentPresets.technicalDetails}</summary>
        <dl class="mt-2 grid gap-2 text-xs sm:grid-cols-[auto_1fr]">
          <dt class="text-textcolor2">{language.agentPresets.presetIdLabel}</dt>
          <dd><code class="break-all select-all">{presetId || 'new'}</code></dd>
          <dt class="text-textcolor2">{language.agentPresets.moduleValuesTechnicalLabel}</dt>
          <dd>
            <code class="break-all select-all">{serializeAgentPresetModuleIntegration(moduleIntegrations) || '—'}</code>
          </dd>
        </dl>
      </details>

      {#if mode === 'edit' && livePreset}<AgentPresetDiagnosticsPanel presetId={livePreset.id} />{/if}
    </div>
    <div class="flex justify-end gap-2 border-t border-darkborderc p-4" data-risu-agent-preset-editor-footer>
      {#if metadataSaveDisabledReason}<span
          class="mr-auto self-center text-sm text-textcolor2"
          data-risu-agent-preset-save-reason>{metadataSaveDisabledReason}</span
        >{/if}
      <Button styled="outlined" disabled={locked} onclick={requestClose}>{language.agentPresets.cancel}</Button>
      <span data-risu-agent-preset-save
        ><Button disabled={!canSaveMetadata} onclick={saveMetadata}
          ><span class="inline-flex items-center gap-2"
            ><SaveIcon size={16} />{busy ? language.agentPresets.saving : language.agentPresets.save}</span
          ></Button
        ></span>
    </div>
  </div>
</div>

{#if nestedAgentOpen}
  <AgentEditorDrawer
    mode="create"
    busy={nestedAgentBusy}
    commandError={nestedAgentError}
    onSave={saveNestedAgent}
    onCancel={closeNestedAgent} />
{/if}
