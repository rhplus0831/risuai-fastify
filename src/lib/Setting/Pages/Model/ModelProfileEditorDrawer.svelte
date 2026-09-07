<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { SaveIcon, XIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import {
    FIRST_CLASS_MODEL_PROFILE_PROVIDER_IDS,
    type FirstClassModelProfileProviderId,
  } from 'src/ts/model/modelProfileResolver'
  import {
    LLM_GATEWAY_REASONING_EFFORTS,
    LLM_GATEWAY_ROUTING_STRATEGIES,
    LLM_GATEWAY_SERVICE_TIERS,
    LLM_GATEWAY_VERBOSITIES,
    normalizeModelProfileRuntimeOptions,
    type LLMGatewayReasoningEffort,
    type LLMGatewayRoutingStrategy,
    type LLMGatewayServiceTier,
    type LLMGatewayVerbosity,
    type ModelProfileOrderEntry,
    type ModelProfileRecord,
    type ModelProfileRecordFallbackRef,
    type ModelProfileRecordProviderOptions,
    type ModelProfileRecordRuntimeOptions,
  } from 'src/ts/model/modelProfileRecords'
  import type { ProviderCredentialRecord, ProviderCredentialType } from 'src/ts/model/providerCredentialRecords'
  import { modalBackdropDismiss } from 'src/ts/gui/modalBackdropDismiss'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'
  import { LLMFormat, type LLMFlags as LLMFlagValue, type LLMTokenizer as LLMTokenizerValue } from 'src/ts/model/types'
  import type { ModelProfileSnapshot } from 'src/ts/server/commands'
  import ModelFallbackEditor from './ModelFallbackEditor.svelte'
  import ModelProviderPanel from './ModelProviderPanel.svelte'
  import ModelRuntimeOptionsEditor from './ModelRuntimeOptionsEditor.svelte'
  import ModelGenerationSettings from './ModelGenerationSettings.svelte'
  import ProviderCredentialEditor from './ProviderCredentialEditor.svelte'

  interface KeyValueRow {
    key: string
    value: string
  }

  interface Props {
    mode: 'create' | 'edit'
    profile?: ModelProfileRecord
    profiles: ModelProfileRecord[]
    profileOrder?: ModelProfileOrderEntry[]
    credentials: ProviderCredentialRecord[]
    runtimeDefaults?: ModelProfileRecordRuntimeOptions
    statusText: string
    busy?: boolean
    commandError?: string
    onSave: (profile: ModelProfileSnapshot) => void | Promise<void>
    onCancel: () => void
  }

  let {
    mode,
    profile,
    profiles = [],
    profileOrder = [],
    credentials = [],
    runtimeDefaults = {},
    statusText,
    busy = false,
    commandError = '',
    onSave,
    onCancel,
  }: Props = $props()

  const firstClassProviderIds = new Set<string>(FIRST_CLASS_MODEL_PROFILE_PROVIDER_IDS)
  const fixedModelProviderIds = new Set<string>(['custom-api', 'debug-echo'])
  // svelte-ignore state_referenced_locally
  const initialProfile = profile

  let draftName = $state(initialProfile?.name ?? '')
  let providerId = $state(initialProviderId())
  let modelId = $state(initialModelId())
  let requestModel = $state(initialProfile?.providerOptions?.requestModel ?? '')
  let credentialId = $state(initialProfile?.providerOptions?.credentialId ?? '')
  let baseUrl = $state(initialProfile?.providerOptions?.baseUrl ?? '')
  let extraHeadersRows = $state<KeyValueRow[]>(recordToRows(initialProfile?.providerOptions?.extraHeaders))
  let additionalParamRows = $state<KeyValueRow[]>(paramsToRows(initialProfile?.providerOptions?.additionalParams))
  let llmGatewayReasoningEffort = $state<LLMGatewayReasoningEffort | ''>(
    initialProfile?.providerOptions?.llmGateway?.reasoningEffort ?? '',
  )
  let llmGatewayVerbosity = $state<LLMGatewayVerbosity | ''>(
    initialProfile?.providerOptions?.llmGateway?.verbosity ?? '',
  )
  let llmGatewayServiceTier = $state<LLMGatewayServiceTier | ''>(
    initialProfile?.providerOptions?.llmGateway?.serviceTier ?? '',
  )
  let llmGatewayRouting = $state<LLMGatewayRoutingStrategy | ''>(
    initialProfile?.providerOptions?.llmGateway?.routing ?? '',
  )
  let ollamaRequestFormat = $state(
    String(initialProfile?.providerOptions?.ollama?.requestFormat ?? LLMFormat.OpenAICompatible),
  )
  let ollamaModelSource = $state(initialProfile?.providerOptions?.ollama?.modelSource ?? '')
  let ollamaThinkingMode = $state(initialProfile?.providerOptions?.ollama?.thinkingMode ?? 'off')
  let vertexProjectId = $state(initialProfile?.providerOptions?.vertex?.projectId ?? '')
  let vertexRegion = $state(initialProfile?.providerOptions?.vertex?.region ?? '')
  let customTokenizer = $state(
    initialProfile?.providerOptions?.customApi?.tokenizer === undefined
      ? ''
      : String(initialProfile.providerOptions.customApi.tokenizer),
  )
  let customFlags = $state<LLMFlagValue[]>([...(initialProfile?.providerOptions?.customApi?.flags ?? [])])
  let runtimeOptions = $state<ModelProfileRecordRuntimeOptions>(cloneJsonValue(initialProfile?.runtimeOptions ?? {}))
  let fallbacks = $state<ModelProfileRecordFallbackRef[]>(cloneJsonValue(initialProfile?.fallbacks ?? []))
  let initialSnapshot = $state('')
  let providerCredentialReset = $state(false)
  // svelte-ignore state_referenced_locally
  let connectionOpen = $state(mode === 'create')
  let credentialEditorType = $state<ProviderCredentialType | null>(null)
  let credentialHasChanges = $state(false)
  let credentialSaving = $state(false)
  let connectionSummary = $derived(
    [
      language.modelProfiles.providerNames[providerId as FirstClassModelProfileProviderId] || providerId,
      requestModel.trim() || modelId || language.none,
      credentials.find((candidate) => candidate.id === credentialId)?.name,
    ]
      .filter(Boolean)
      .join(' · '),
  )

  let canEditProviderFields = $derived(
    mode === 'create' || (!!initialProfile?.providerId && firstClassProviderIds.has(initialProfile.providerId)),
  )
  let providerIsFirstClass = $derived(firstClassProviderIds.has(providerId))
  let drawerTitle = $derived(
    mode === 'create' ? language.modelProfiles.createProfile : language.modelProfiles.editProfile,
  )
  let isDirty = $derived(initialSnapshot !== '' && initialSnapshot !== snapshot(snapshotForSave()))
  let canSave = $derived(!busy && !credentialEditorType && !credentialSaving && (mode === 'create' || isDirty))

  $effect(() => {
    if (!initialSnapshot) initialSnapshot = snapshot(snapshotForSave())
  })

  function initialProviderId(): string {
    if (mode === 'create') return 'openai'
    return initialProfile?.providerId ?? ''
  }

  function initialModelId(): string {
    if (mode === 'create') return ''
    return initialProfile?.modelId ?? ''
  }

  function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }

  function snapshot(value: unknown): string {
    return JSON.stringify(value ?? {})
  }

  function recordToRows(value: Record<string, string> | undefined): KeyValueRow[] {
    if (!value) return []
    return Object.entries(value).map(([key, rowValue]) => ({ key, value: rowValue }))
  }

  function paramsToRows(value: Array<[string, string]> | undefined): KeyValueRow[] {
    return (value ?? []).map(([key, rowValue]) => ({ key, value: rowValue }))
  }

  function rowsToRecord(rows: KeyValueRow[]): Record<string, string> | undefined {
    const out: Record<string, string> = {}
    for (const row of rows) {
      const key = row.key.trim()
      if (!key) continue
      out[key] = row.value.trim()
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  function rowsToParams(rows: KeyValueRow[]): Array<[string, string]> | undefined {
    const out: Array<[string, string]> = []
    for (const row of rows) {
      const key = row.key.trim()
      if (!key) continue
      out.push([key, row.value.trim()])
    }
    return out.length > 0 ? out : undefined
  }

  function removeEmptyProviderOptions(
    options: ModelProfileRecordProviderOptions,
  ): ModelProfileRecordProviderOptions | undefined {
    return Object.keys(options).length > 0 ? options : undefined
  }

  function setProviderId(nextProviderId: string): void {
    if (nextProviderId === providerId) return

    const clearedCredential = credentialId !== ''
    credentialId = ''
    if (clearedCredential) providerCredentialReset = true

    providerId = nextProviderId
    if (fixedModelProviderIds.has(nextProviderId)) {
      modelId = nextProviderId
    } else if (fixedModelProviderIds.has(modelId)) {
      modelId = ''
    }
    if (nextProviderId === 'ollama' && !modelId) {
      modelId = 'ollama-hosted'
    }
  }

  function firstClassProviderOptionsForSave(
    nextProviderId: FirstClassModelProfileProviderId,
  ): ModelProfileRecordProviderOptions | undefined {
    if (nextProviderId === 'vertex') {
      const vertex: NonNullable<ModelProfileRecordProviderOptions['vertex']> = {}
      if (vertexProjectId.trim()) vertex.projectId = vertexProjectId.trim()
      if (vertexRegion.trim()) vertex.region = vertexRegion.trim()

      const options: ModelProfileRecordProviderOptions = {}
      if (credentialId.trim()) options.credentialId = credentialId.trim()
      if (requestModel.trim()) options.requestModel = requestModel.trim()
      if (Object.keys(vertex).length > 0) options.vertex = vertex
      return removeEmptyProviderOptions(options)
    }

    if (nextProviderId === 'custom-api') {
      const options: ModelProfileRecordProviderOptions = {}
      const headers = rowsToRecord(extraHeadersRows)
      const params = rowsToParams(additionalParamRows)
      const customApi: NonNullable<ModelProfileRecordProviderOptions['customApi']> = {}
      const tokenizer = Number(customTokenizer)
      if (customTokenizer !== '' && Number.isFinite(tokenizer)) customApi.tokenizer = tokenizer as LLMTokenizerValue
      if (customFlags.length > 0) customApi.flags = customFlags
      if (baseUrl.trim()) options.baseUrl = baseUrl.trim()
      if (requestModel.trim()) options.requestModel = requestModel.trim()
      if (credentialId.trim()) options.credentialId = credentialId.trim()
      if (headers) options.extraHeaders = headers
      if (params) options.additionalParams = params
      if (Object.keys(customApi).length > 0) options.customApi = customApi
      return removeEmptyProviderOptions(options)
    }

    if (nextProviderId === 'llmgateway') {
      const options: ModelProfileRecordProviderOptions = {}
      const llmGateway: NonNullable<ModelProfileRecordProviderOptions['llmGateway']> = {}
      if (credentialId.trim()) options.credentialId = credentialId.trim()
      if (requestModel.trim()) options.requestModel = requestModel.trim()
      if (LLM_GATEWAY_REASONING_EFFORTS.includes(llmGatewayReasoningEffort as LLMGatewayReasoningEffort)) {
        llmGateway.reasoningEffort = llmGatewayReasoningEffort as LLMGatewayReasoningEffort
      }
      if (LLM_GATEWAY_VERBOSITIES.includes(llmGatewayVerbosity as LLMGatewayVerbosity)) {
        llmGateway.verbosity = llmGatewayVerbosity as LLMGatewayVerbosity
      }
      if (LLM_GATEWAY_SERVICE_TIERS.includes(llmGatewayServiceTier as LLMGatewayServiceTier)) {
        llmGateway.serviceTier = llmGatewayServiceTier as LLMGatewayServiceTier
      }
      if (LLM_GATEWAY_ROUTING_STRATEGIES.includes(llmGatewayRouting as LLMGatewayRoutingStrategy)) {
        llmGateway.routing = llmGatewayRouting as LLMGatewayRoutingStrategy
      }
      if (Object.keys(llmGateway).length > 0) options.llmGateway = llmGateway
      return removeEmptyProviderOptions(options)
    }

    if (nextProviderId === 'debug-echo') {
      const options: ModelProfileRecordProviderOptions = {}
      if (baseUrl.trim()) options.baseUrl = baseUrl.trim()
      if (requestModel.trim()) options.requestModel = requestModel.trim()
      return removeEmptyProviderOptions(options)
    }

    if (nextProviderId === 'ollama') {
      const options: ModelProfileRecordProviderOptions = {}
      const ollama: NonNullable<ModelProfileRecordProviderOptions['ollama']> = {}
      const requestFormatNumber = Number(ollamaRequestFormat)
      const isCloud = modelId === 'ollama-cloud'
      if (credentialId.trim()) options.credentialId = credentialId.trim()
      if (requestModel.trim()) options.requestModel = requestModel.trim()
      if (!isCloud && baseUrl.trim()) {
        options.baseUrl = baseUrl.trim()
        ollama.url = baseUrl.trim()
      }
      if (isCloud && Number.isFinite(requestFormatNumber)) {
        ollama.requestFormat = requestFormatNumber as LLMFormat
      } else {
        ollama.requestFormat = LLMFormat.Ollama
      }
      if (ollamaModelSource.trim()) {
        ollama.modelSource = ollamaModelSource.trim()
      } else {
        ollama.modelSource = isCloud ? 'cloud' : 'local'
      }
      if (ollamaThinkingMode.trim()) ollama.thinkingMode = ollamaThinkingMode.trim()
      if (Object.keys(ollama).length > 0) options.ollama = ollama
      return removeEmptyProviderOptions(options)
    }

    const options: ModelProfileRecordProviderOptions = {}
    if (credentialId.trim()) options.credentialId = credentialId.trim()
    if (requestModel.trim()) options.requestModel = requestModel.trim()
    return removeEmptyProviderOptions(options)
  }

  function sanitizedFallbacks(): ModelProfileRecordFallbackRef[] | undefined {
    const seen = new Set<string>()
    const rows: ModelProfileRecordFallbackRef[] = []
    for (const fallback of fallbacks) {
      if (fallback.mode === 'profile') {
        const fallbackProfileId = fallback.profileId.trim()
        const key = `profile:${fallbackProfileId}`
        if (!fallbackProfileId || fallbackProfileId === initialProfile?.id || seen.has(key)) continue
        rows.push({ mode: 'profile', profileId: fallbackProfileId })
        seen.add(key)
        continue
      }
      const fallbackModelId = fallback.modelId.trim()
      const key = `model:${fallbackModelId}`
      if (!fallbackModelId || seen.has(key)) continue
      rows.push({ mode: 'model', modelId: fallbackModelId })
      seen.add(key)
    }
    return rows.length > 0 ? rows : undefined
  }

  function snapshotForSave(): ModelProfileSnapshot {
    const next: ModelProfileSnapshot = initialProfile ? cloneJsonValue(initialProfile) : { name: '' }
    next.name =
      draftName.trim() ||
      initialProfile?.name ||
      requestModel.trim() ||
      modelId.trim() ||
      language.modelProfiles.newProfileDefaultName

    if (!canEditProviderFields || !providerIsFirstClass) {
      return next
    }

    const nextProviderId = providerId as FirstClassModelProfileProviderId
    next.providerId = nextProviderId
    next.modelId = fixedModelProviderIds.has(nextProviderId) ? nextProviderId : modelId.trim()
    if (!next.modelId) delete next.modelId

    const providerOptions = firstClassProviderOptionsForSave(nextProviderId)
    if (providerOptions) {
      next.providerOptions = providerOptions
    } else {
      delete next.providerOptions
    }

    const normalizedRuntimeOptions = normalizeModelProfileRuntimeOptions(runtimeOptions)
    if (normalizedRuntimeOptions) {
      next.runtimeOptions = normalizedRuntimeOptions
    } else {
      delete next.runtimeOptions
    }

    const nextFallbacks = sanitizedFallbacks()
    if (nextFallbacks) {
      next.fallbacks = nextFallbacks
    } else {
      delete next.fallbacks
    }

    return next
  }

  function requestClose(): void {
    if (busy || credentialSaving) return
    if ((isDirty || credentialHasChanges) && !window.confirm(language.modelProfiles.discardProfileChangesConfirm))
      return
    onCancel()
  }

  function manageCredentials(type: ProviderCredentialType): void {
    if (busy || credentialSaving) return
    credentialEditorType = type
    connectionOpen = true
  }

  function handleDialogKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    requestClose()
  }

  async function saveProfile(): Promise<void> {
    if (!canSave) return
    await onSave(snapshotForSave())
  }

  function profileRecoveryDraft() {
    return {
      draftName,
      providerId,
      modelId,
      requestModel,
      credentialId,
      baseUrl,
      extraHeadersRows,
      additionalParamRows,
      llmGatewayReasoningEffort,
      llmGatewayVerbosity,
      llmGatewayServiceTier,
      llmGatewayRouting,
      ollamaRequestFormat,
      ollamaModelSource,
      ollamaThinkingMode,
      vertexProjectId,
      vertexRegion,
      customTokenizer,
      customFlags,
      runtimeOptions,
      fallbacks,
    }
  }
  const profileRecoveryBaseline = untrack(() => JSON.stringify(profileRecoveryDraft()))
  onDestroy(
    registerWriterDraftCapture(() => {
      const data = profileRecoveryDraft()
      if (JSON.stringify(data) === profileRecoveryBaseline) return null
      return $state.snapshot({
        key: `model-profile:${initialProfile?.id ?? 'new'}`,
        label: draftName || drawerTitle,
        fields: [
          { label: language.modelProfiles.profileNameColumn, value: draftName },
          { label: language.modelProfiles.modelConnectionTitle, value: JSON.stringify(data, null, 2), secret: true },
        ],
        data,
        baseline: JSON.parse(profileRecoveryBaseline),
      })
    }),
  )
</script>

{#snippet providerPanel(section: 'setup' | 'advanced')}
  <ModelProviderPanel
    {section}
    bind:providerId
    bind:modelId
    bind:requestModel
    bind:credentialId
    {credentials}
    onCreateCredential={manageCredentials}
    bind:baseUrl
    bind:extraHeadersRows
    bind:additionalParamRows
    bind:llmGatewayReasoningEffort
    bind:llmGatewayVerbosity
    bind:llmGatewayServiceTier
    bind:llmGatewayRouting
    bind:ollamaRequestFormat
    bind:ollamaModelSource
    bind:ollamaThinkingMode
    bind:vertexProjectId
    bind:vertexRegion
    bind:customTokenizer
    bind:customFlags>
    {#snippet credentialEditor()}
      {#if credentialEditorType}
        <ProviderCredentialEditor
          type={credentialEditorType}
          {credentials}
          waitForProjection
          bind:hasChanges={credentialHasChanges}
          bind:saving={credentialSaving}
          onComplete={(result) => {
            if (result.status !== 'accepted') return
            credentialId = result.credentialId
            credentialEditorType = null
            credentialHasChanges = false
          }}
          onCancel={() => {
            credentialEditorType = null
            credentialHasChanges = false
          }} />
      {/if}
    {/snippet}
  </ModelProviderPanel>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div use:modalBackdropDismiss={requestClose} data-modal-root class="fixed inset-0 z-50 flex justify-end bg-black/50">
  <div
    use:modalFocusTrap
    class="flex h-full w-full max-w-3xl flex-col border-l border-darkborderc bg-bgcolor text-textcolor shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-label={drawerTitle}
    aria-busy={busy}
    tabindex="-1"
    onclick={(event) => {
      event.stopPropagation()
    }}
    onkeydown={handleDialogKeydown}>
    <div class="flex items-start justify-between gap-3 border-b border-darkborderc p-4">
      <div class="min-w-0">
        <h3 class="truncate text-xl font-semibold">{drawerTitle}</h3>
        {#if mode === 'edit' && statusText !== language.modelProfiles.statusBuckets.ready}
          <p class="mt-1 text-xs text-textcolor2">{statusText}</p>
        {/if}
      </div>
      <button
        type="button"
        data-modal-initial-focus
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-darkbutton"
        class:cursor-not-allowed={busy}
        class:opacity-50={busy}
        aria-label={language.modelRoles.close}
        disabled={busy || credentialSaving}
        onclick={requestClose}>
        <XIcon size={20} />
      </button>
    </div>

    <fieldset
      data-model-profile-editable-form
      class="m-0 flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto border-0 p-4"
      disabled={busy}
      aria-busy={busy}>
      {#if commandError}
        <div class="rounded-md border border-draculared p-3 text-sm text-draculared">{commandError}</div>
      {/if}

      <label class="flex flex-col gap-1 text-sm">
        <span
          >{mode === 'create'
            ? language.modelProfiles.optionalModelName
            : language.modelProfiles.profileNameColumn}</span>
        <TextInput
          size="sm"
          fullwidth
          bind:value={draftName}
          placeholder={requestModel.trim() || modelId || language.modelProfiles.newProfileDefaultName} />
      </label>

      <details bind:open={connectionOpen} class="rounded-md border border-darkborderc" data-model-connection>
        <summary class="cursor-pointer px-4 py-3 text-sm font-medium">
          {language.modelProfiles.modelConnectionTitle}
          <span class="mt-1 block break-words font-normal text-textcolor2">{connectionSummary}</span>
        </summary>
        <div class="flex min-w-0 flex-col gap-4 border-t border-darkborderc p-4">
          {#if canEditProviderFields}
            <label class="flex flex-col gap-1 text-sm">
              <span>{language.modelProfiles.providerColumn}</span>
              <SelectInput
                size="sm"
                className="w-full"
                ariaLabel={language.modelProfiles.providerColumn}
                value={providerId}
                disabled={credentialEditorType !== null}
                onchange={(event) => {
                  setProviderId(String(event.currentTarget.value))
                }}>
                {#each FIRST_CLASS_MODEL_PROFILE_PROVIDER_IDS as optionProviderId (optionProviderId)}
                  <OptionInput value={optionProviderId}
                    >{language.modelProfiles.providerNames[optionProviderId]}</OptionInput>
                {/each}
              </SelectInput>
            </label>
          {:else}
            <p class="text-sm text-textcolor2">
              {initialProfile?.providerId
                ? language.modelProfiles.unsupportedProviderLabel(initialProfile.providerId)
                : language.modelProfiles.compatibilityProvider}
            </p>
          {/if}
          {#if providerCredentialReset}
            <p class="text-sm text-yellow-300" role="status" data-model-profile-provider-secret-reset>
              {language.modelProfiles.providerChangeClearedCredential}
            </p>
          {/if}
          {@render providerPanel('setup')}
        </div>
      </details>

      {#if canEditProviderFields && providerIsFirstClass}
        <ModelGenerationSettings bind:value={runtimeOptions} defaults={runtimeDefaults} />
        <Accordion styled name={language.modelProfiles.runtimeOverridesTitle}>
          <div class="flex min-w-0 flex-col gap-5 p-2">
            <section class="flex flex-col gap-3">
              <h4 class="text-sm font-semibold">{language.modelProfiles.advancedProviderOptions}</h4>
              {@render providerPanel('advanced')}
            </section>
            <ModelRuntimeOptionsEditor bind:value={runtimeOptions} defaults={runtimeDefaults} advancedOnly />
            <section class="flex flex-col gap-3 border-t border-darkborderc pt-4">
              <h4 class="text-sm font-semibold">{language.modelProfiles.fallbacksTitle}</h4>
              <ModelFallbackEditor profileId={initialProfile?.id} {profiles} {profileOrder} bind:value={fallbacks} />
            </section>
          </div>
        </Accordion>
      {:else}
        <p class="text-sm text-textcolor2">{language.modelProfiles.compatibilityRuntimeNotice}</p>
      {/if}
    </fieldset>

    <div class="flex flex-wrap items-center justify-end gap-2 border-t border-darkborderc p-4">
      <p class="mr-auto basis-full text-xs text-textcolor2 sm:basis-auto sm:flex-1">
        {language.modelProfiles.modelScopeDescription}
      </p>
      <Button size="sm" styled="outlined" disabled={busy || credentialSaving} onclick={requestClose}>
        <span class="inline-flex items-center gap-1"><XIcon size={14} />{language.modelProfiles.cancel}</span>
      </Button>
      <Button size="sm" disabled={!canSave} onclick={saveProfile}>
        <span class="inline-flex items-center gap-2"
          ><SaveIcon size={16} />{busy ? language.modelProfiles.saving : language.modelProfiles.save}</span>
      </Button>
    </div>
  </div>
</div>
