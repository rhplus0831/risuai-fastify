<script lang="ts">
  import type { Snippet } from 'svelte'
  import { AlertTriangleIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import ModelGrid from 'src/lib/UI/ModelGrid.svelte'
  import {
    getLLMGatewayModels,
    toModelGridItem as llmGatewayModelToGridItem,
    type LLMGatewayModelInfo,
  } from 'src/ts/model/llmgateway'
  import {
    getNeuralwattModels,
    toModelGridItem as neuralwattModelToGridItem,
    type NeuralwattModelInfo,
  } from 'src/ts/model/neuralwatt'
  import { FIRST_CLASS_MODEL_PROFILE_PROVIDER_IDS } from 'src/ts/model/modelProfileResolver'
  import {
    LLM_GATEWAY_REASONING_EFFORTS,
    LLM_GATEWAY_ROUTING_STRATEGIES,
    LLM_GATEWAY_SERVICE_TIERS,
    LLM_GATEWAY_VERBOSITIES,
    type LLMGatewayReasoningEffort,
    type LLMGatewayRoutingStrategy,
    type LLMGatewayServiceTier,
    type LLMGatewayVerbosity,
  } from 'src/ts/model/modelProfileRecords'
  import type { ProviderCredentialRecord, ProviderCredentialType } from 'src/ts/model/providerCredentialRecords'
  import { AnthropicModels } from 'src/ts/model/providers/anthropic'
  import { GoogleModels } from 'src/ts/model/providers/google'
  import { OpenAIModels } from 'src/ts/model/providers/openai'
  import { FASTIFY_TOKENIZER_OPTIONS } from 'src/ts/model/tokenizerOptions'
  import { LLMFlags, LLMFormat, type LLMFlags as LLMFlagValue } from 'src/ts/model/types'
  import KeyValueRowsEditor from './KeyValueRowsEditor.svelte'

  interface KeyValueRow {
    key: string
    value: string
  }

  interface ModelOption {
    id: string
    label: string
  }

  type LLMFlagKey = keyof typeof LLMFlags

  interface Props {
    section?: 'all' | 'setup' | 'advanced'
    credentialEditor?: Snippet
    providerId: string
    modelId: string
    requestModel: string
    credentialId: string
    credentials: ProviderCredentialRecord[]
    onCreateCredential: (type: ProviderCredentialType) => void
    baseUrl: string
    extraHeadersRows: KeyValueRow[]
    additionalParamRows: KeyValueRow[]
    llmGatewayReasoningEffort: LLMGatewayReasoningEffort | ''
    llmGatewayVerbosity: LLMGatewayVerbosity | ''
    llmGatewayServiceTier: LLMGatewayServiceTier | ''
    llmGatewayRouting: LLMGatewayRoutingStrategy | ''
    ollamaRequestFormat: string
    ollamaModelSource: string
    ollamaThinkingMode: string
    vertexProjectId: string
    vertexRegion: string
    customTokenizer: string
    customFlags: LLMFlagValue[]
  }

  let {
    section = 'all',
    credentialEditor,
    providerId = $bindable(),
    modelId = $bindable(),
    requestModel = $bindable(),
    credentialId = $bindable(),
    credentials = [],
    onCreateCredential,
    baseUrl = $bindable(),
    extraHeadersRows = $bindable(),
    additionalParamRows = $bindable(),
    llmGatewayReasoningEffort = $bindable(),
    llmGatewayVerbosity = $bindable(),
    llmGatewayServiceTier = $bindable(),
    llmGatewayRouting = $bindable(),
    ollamaRequestFormat = $bindable(),
    ollamaModelSource = $bindable(),
    ollamaThinkingMode = $bindable(),
    vertexProjectId = $bindable(),
    vertexRegion = $bindable(),
    customTokenizer = $bindable(),
    customFlags = $bindable(),
  }: Props = $props()

  const firstClassProviderIds = new Set<string>(FIRST_CLASS_MODEL_PROFILE_PROVIDER_IDS)
  const fixedModelProviderIds = new Set<string>(['custom-api', 'debug-echo'])
  const ollamaModelOptions: ModelOption[] = [
    { id: 'ollama-hosted', label: language.modelProfiles.ollamaLocal },
    { id: 'ollama-cloud', label: language.modelProfiles.ollamaCloud },
  ]
  const openAIModelOptions = modelOptions(OpenAIModels)
  const anthropicModelOptions = modelOptions(AnthropicModels)
  const googleModelOptions = modelOptions(GoogleModels)
  const vertexModelOptions = modelOptions(
    GoogleModels.map((model) => ({
      ...model,
      id: `${model.id}-vertex`,
      name: `${model.name} Vertex`,
      fullName: `${model.fullName ?? model.name} Vertex`,
    })),
  )
  const tokenizerOptions = FASTIFY_TOKENIZER_OPTIONS.filter((option) => option.value !== 'tik')
  const flagOptions = (Object.keys(LLMFlags) as LLMFlagKey[]).map((key) => ({
    key,
    label: language.modelProfiles.capabilityFlags[key],
    flag: LLMFlags[key] as LLMFlagValue,
  }))

  let llmGatewayModels = $state<LLMGatewayModelInfo[]>([])
  let llmGatewayModelsLoading = $state(false)
  let llmGatewayGridItems = $derived(llmGatewayModels.map(llmGatewayModelToGridItem))
  let neuralwattModels = $state<NeuralwattModelInfo[]>([])
  let neuralwattModelsLoading = $state(false)
  let neuralwattGridItems = $derived(neuralwattModels.map(neuralwattModelToGridItem))

  let manualModel = $state(false)
  let knownOptions = $derived(
    providerId === 'openai'
      ? openAIModelOptions
      : providerId === 'anthropic'
        ? anthropicModelOptions
        : providerId === 'google'
          ? googleModelOptions
          : providerId === 'vertex'
            ? vertexModelOptions
            : [],
  )

  let baseUrlIncludesSuffix = $derived(baseUrl.toLowerCase().includes('/chat/completions'))
  let compatibleCredentialType = $derived<ProviderCredentialType>(
    providerId === 'vertex' ? 'vertexServiceAccount' : 'apiKey',
  )
  let compatibleCredentials = $derived(credentials.filter((credential) => credential.type === compatibleCredentialType))
  let selectedCredentialMissing = $derived(
    !!credentialId && !compatibleCredentials.some((credential) => credential.id === credentialId),
  )

  $effect(() => {
    if (fixedModelProviderIds.has(providerId) && modelId !== providerId) {
      modelId = providerId
    }
  })

  $effect(() => {
    if (providerId !== 'ollama') return
    if (modelId !== 'ollama-cloud' && modelId !== 'ollama-hosted') {
      modelId = 'ollama-hosted'
    }
    const nextSource = modelId === 'ollama-cloud' ? 'cloud' : 'local'
    if (ollamaModelSource !== nextSource) {
      ollamaModelSource = nextSource
    }
    if (modelId === 'ollama-hosted' && ollamaRequestFormat !== String(LLMFormat.Ollama)) {
      ollamaRequestFormat = String(LLMFormat.Ollama)
    }
  })

  $effect(() => {
    if (providerId !== 'llmgateway' || section === 'advanced') return
    let cancelled = false
    llmGatewayModelsLoading = true
    void getLLMGatewayModels()
      .then((models) => {
        if (!cancelled) llmGatewayModels = models
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) llmGatewayModelsLoading = false
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    if (providerId !== 'neuralwatt' || section === 'advanced') return
    let cancelled = false
    neuralwattModelsLoading = true
    void getNeuralwattModels()
      .then((models) => {
        if (!cancelled) neuralwattModels = models
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) neuralwattModelsLoading = false
      })
    return () => {
      cancelled = true
    }
  })

  function modelOptions(models: Array<{ id: string; name: string; fullName?: string }>): ModelOption[] {
    const seen = new Set<string>()
    const out: ModelOption[] = []
    for (const model of models) {
      if (!model.id || seen.has(model.id)) continue
      seen.add(model.id)
      out.push({ id: model.id, label: model.fullName ?? model.name ?? model.id })
    }
    return out
  }

  function knownModelValue(options: ModelOption[]): string {
    return options.some((option) => option.id === modelId) ? modelId : ''
  }

  function setCustomFlag(flag: LLMFlagValue, enabled: boolean): void {
    const nextFlags = enabled ? [...customFlags, flag] : customFlags.filter((item) => item !== flag)
    customFlags = [...new Set(nextFlags)]
  }
</script>

{#if !providerId}
  <p class="text-sm text-textcolor2">{language.modelProfiles.compatibilityEditNotice}</p>
{:else if !firstClassProviderIds.has(providerId)}
  <p class="text-sm text-textcolor2">{language.modelProfiles.unsupportedProviderEditNotice(providerId)}</p>
{:else}
  <div class="flex min-w-0 flex-col gap-4">
    {#if section !== 'advanced'}
      {#if providerId !== 'debug-echo'}
        <div class="flex flex-col gap-2" data-provider-credential-picker>
          <label class="flex flex-col gap-1 text-sm">
            <span>{language.modelProfiles.credentialLabel}</span>
            <select
              aria-label={language.modelProfiles.credentialLabel}
              class="w-full rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor focus:border-borderc focus:ring-2 focus:ring-borderc"
              bind:value={credentialId}>
              <option value="" class="bg-darkbg">{language.modelProfiles.noCredential}</option>
              {#if selectedCredentialMissing}
                <option value={credentialId} class="bg-darkbg"
                  >{language.modelProfiles.missingCredential(credentialId)}</option>
              {/if}
              {#each compatibleCredentials as credential (credential.id)}
                <option value={credential.id} class="bg-darkbg">{credential.name}</option>
              {/each}
            </select>
          </label>
          <button
            type="button"
            class="min-h-9 self-start text-sm text-textcolor2 underline underline-offset-2 hover:text-textcolor"
            onclick={() => onCreateCredential(compatibleCredentialType)}>
            {language.modelProfiles.createNewCredential}
          </button>
          {@render credentialEditor?.()}
        </div>
      {/if}
      {#if providerId === 'llmgateway' || providerId === 'neuralwatt'}
        <ModelGrid
          bind:value={modelId}
          items={providerId === 'llmgateway' ? llmGatewayGridItems : neuralwattGridItems}
          loading={providerId === 'llmgateway' ? llmGatewayModelsLoading : neuralwattModelsLoading}
          onselect={() => {
            requestModel = ''
          }} />
        <label class="flex flex-col gap-1 text-sm">
          <span>{language.modelProfiles.modelColumn}</span>
          <TextInput size="sm" fullwidth bind:value={modelId} placeholder={language.modelProfiles.modelPlaceholder} />
        </label>
      {:else if knownOptions.length > 0}
        <label class="flex flex-col gap-1 text-sm">
          <span>{language.modelProfiles.knownModel}</span>
          <select
            aria-label={language.modelProfiles.knownModel}
            class="w-full rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor focus:border-borderc focus:ring-2 focus:ring-borderc"
            value={manualModel ? '__manual__' : knownModelValue(knownOptions) || (modelId ? '__manual__' : '')}
            onchange={(event) => {
              manualModel = event.currentTarget.value === '__manual__'
              if (event.currentTarget.value && !manualModel) modelId = event.currentTarget.value
            }}>
            <option value="" disabled class="bg-darkbg">{language.modelProfiles.chooseModelPlaceholder}</option>
            <option value="__manual__" class="bg-darkbg">{language.modelProfiles.manualModelOption}</option>
            {#each knownOptions as option (option.id)}
              <option value={option.id} class="bg-darkbg">{option.label}</option>
            {/each}
          </select>
        </label>
        {#if manualModel || (modelId && !knownModelValue(knownOptions))}
          <label class="flex flex-col gap-1 text-sm">
            <span>{language.modelProfiles.modelColumn}</span>
            <TextInput
              size="sm"
              fullwidth
              bind:value={modelId}
              oninput={() => {
                manualModel = true
              }}
              placeholder={language.modelProfiles.modelPlaceholder} />
          </label>
        {/if}
      {:else if providerId === 'ollama'}
        <label class="flex flex-col gap-1 text-sm">
          <span>{language.modelProfiles.knownModel}</span>
          <select
            aria-label={language.modelProfiles.knownModel}
            class="w-full rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor focus:border-borderc focus:ring-2 focus:ring-borderc"
            value={knownModelValue(ollamaModelOptions)}
            onchange={(event) => {
              if (event.currentTarget.value) modelId = event.currentTarget.value
            }}>
            {#each ollamaModelOptions as option (option.id)}
              <option value={option.id} class="bg-darkbg">{option.label}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if providerId === 'vertex'}
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm"
            ><span>{language.modelProfiles.vertexProjectId}</span><TextInput
              size="sm"
              fullwidth
              bind:value={vertexProjectId} /></label>
          <label class="flex flex-col gap-1 text-sm"
            ><span>{language.modelProfiles.vertexRegion}</span><TextInput
              size="sm"
              fullwidth
              bind:value={vertexRegion} /></label>
        </div>
      {/if}
      {#if providerId === 'custom-api' || (providerId === 'ollama' && modelId !== 'ollama-cloud')}
        <label class="flex flex-col gap-1 text-sm">
          <span>{language.modelProfiles.baseUrlLabel}</span>
          <TextInput
            size="sm"
            fullwidth
            bind:value={baseUrl}
            placeholder={providerId === 'ollama'
              ? language.modelProfiles.ollamaBaseUrlPlaceholder
              : language.modelProfiles.baseUrlPlaceholder} />
        </label>
        {#if providerId === 'custom-api' && baseUrlIncludesSuffix}
          <div class="flex gap-2 rounded-md border border-yellow-600 p-2 text-sm text-yellow-300">
            <AlertTriangleIcon size={16} class="mt-0.5 shrink-0" />
            <span>{language.modelProfiles.customApiChatCompletionsWarning}</span>
          </div>
        {/if}
      {/if}
      {#if providerId === 'custom-api' || providerId === 'ollama'}
        <label class="flex flex-col gap-1 text-sm">
          <span>{language.modelProfiles.requestModelColumn}</span>
          <TextInput
            size="sm"
            fullwidth
            bind:value={requestModel}
            placeholder={providerId === 'ollama'
              ? language.modelProfiles.ollamaModelPlaceholder
              : language.modelProfiles.requestModelPlaceholder} />
        </label>
      {/if}
    {/if}
    {#if section !== 'setup'}
      {#if providerId !== 'custom-api' && providerId !== 'ollama'}
        <label class="flex flex-col gap-1 text-sm">
          <span>{language.modelProfiles.requestModelColumn}</span>
          <TextInput
            size="sm"
            fullwidth
            bind:value={requestModel}
            placeholder={language.modelProfiles.requestModelPlaceholder} />
        </label>
      {/if}
      {#if providerId === 'llmgateway'}
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-textcolor2">{language.modelProfiles.llmGatewayReasoningEffort}</span>
            <select
              data-llm-gateway-reasoning-effort
              class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
              bind:value={llmGatewayReasoningEffort}>
              <option value="" class="bg-darkbg">{language.modelProfiles.runtimeUnset}</option>
              {#each LLM_GATEWAY_REASONING_EFFORTS as effort (effort)}
                <option value={effort} class="bg-darkbg">{effort}</option>
              {/each}
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-textcolor2">{language.modelProfiles.llmGatewayVerbosity}</span>
            <select
              data-llm-gateway-verbosity
              class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
              bind:value={llmGatewayVerbosity}>
              <option value="" class="bg-darkbg">{language.modelProfiles.runtimeUnset}</option>
              {#each LLM_GATEWAY_VERBOSITIES as verbosity (verbosity)}
                <option value={verbosity} class="bg-darkbg">{verbosity}</option>
              {/each}
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-textcolor2">{language.modelProfiles.llmGatewayServiceTier}</span>
            <select
              data-llm-gateway-service-tier
              class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
              bind:value={llmGatewayServiceTier}>
              <option value="" class="bg-darkbg">{language.modelProfiles.runtimeUnset}</option>
              {#each LLM_GATEWAY_SERVICE_TIERS as tier (tier)}
                <option value={tier} class="bg-darkbg">{tier}</option>
              {/each}
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm text-textcolor2">{language.modelProfiles.llmGatewayRouting}</span>
            <select
              data-llm-gateway-routing
              class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
              bind:value={llmGatewayRouting}>
              <option value="" class="bg-darkbg">{language.modelProfiles.runtimeUnset}</option>
              {#each LLM_GATEWAY_ROUTING_STRATEGIES as routing (routing)}
                <option value={routing} class="bg-darkbg">{routing}</option>
              {/each}
            </select>
          </label>
        </div>
      {:else if providerId === 'custom-api'}
        <div class="grid gap-4 md:grid-cols-2">
          <div class="flex flex-col gap-2">
            <h4 class="text-sm font-semibold">{language.modelProfiles.extraHeaders}</h4>
            <KeyValueRowsEditor
              bind:rows={extraHeadersRows}
              keyPlaceholder={language.modelProfiles.headerNamePlaceholder}
              valuePlaceholder={language.modelProfiles.headerValuePlaceholder}
              addLabel={language.modelProfiles.addHeader}
              emptyLabel={language.modelProfiles.noExtraHeaders} />
          </div>

          <div class="flex flex-col gap-2">
            <h4 class="text-sm font-semibold">{language.modelProfiles.additionalParams}</h4>
            <KeyValueRowsEditor
              bind:rows={additionalParamRows}
              keyPlaceholder={language.modelProfiles.paramNamePlaceholder}
              valuePlaceholder={language.modelProfiles.paramValuePlaceholder}
              addLabel={language.modelProfiles.addParam}
              emptyLabel={language.modelProfiles.noAdditionalParams} />
          </div>
        </div>

        <div class="grid gap-3 md:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-textcolor2">{language.modelProfiles.customTokenizer}</span>
            <select
              data-custom-tokenizer-picker
              class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
              bind:value={customTokenizer}>
              <option value="" class="bg-darkbg">{language.modelProfiles.defaultTokenizer}</option>
              {#each tokenizerOptions as option (option.modelTokenizer)}
                <option value={String(option.modelTokenizer)} class="bg-darkbg">
                  {language.tokenizerOptions[option.labelKey]}
                </option>
              {/each}
            </select>
          </label>
          <div class="flex flex-col gap-2">
            <span class="text-sm text-textcolor2">{language.modelProfiles.customApiFlags}</span>
            <div
              data-model-custom-api-flags
              class="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-darkborderc p-2 sm:grid-cols-2">
              {#each flagOptions as option (option.flag)}
                <label class="flex min-w-0 items-start gap-2 text-sm text-textcolor2" title={option.key}>
                  <input
                    type="checkbox"
                    class="mt-0.5 h-4 w-4 shrink-0"
                    checked={customFlags.includes(option.flag)}
                    onchange={(event) => {
                      setCustomFlag(option.flag, event.currentTarget.checked)
                    }} />
                  <span class="min-w-0">
                    {option.label}
                    <span class="ml-1 break-all text-xs opacity-70">({option.key})</span>
                  </span>
                </label>
              {/each}
            </div>
          </div>
        </div>
      {:else if providerId === 'ollama'}
        <div class="grid gap-3 sm:grid-cols-2">
          {#if modelId === 'ollama-cloud'}
            <label class="flex flex-col gap-1">
              <span class="text-sm text-textcolor2">{language.modelProfiles.ollamaRequestFormat}</span>
              <select
                class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                bind:value={ollamaRequestFormat}>
                <option value={String(LLMFormat.Ollama)} class="bg-darkbg">
                  {language.modelProfiles.ollamaNativeFormat}
                </option>
                <option value={String(LLMFormat.OpenAICompatible)} class="bg-darkbg">
                  {language.modelProfiles.ollamaOpenAIFormat}
                </option>
                <option value={String(LLMFormat.OpenAIResponseAPI)} class="bg-darkbg">
                  {language.modelProfiles.ollamaResponsesFormat}
                </option>
                <option value={String(LLMFormat.Anthropic)} class="bg-darkbg">
                  {language.modelProfiles.ollamaAnthropicFormat}
                </option>
              </select>
            </label>
          {/if}
          {#if modelId !== 'ollama-cloud' || ollamaRequestFormat === String(LLMFormat.Ollama)}
            <label class="flex flex-col gap-1">
              <span class="text-sm text-textcolor2">{language.modelProfiles.ollamaThinkingMode}</span>
              <select
                class="rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                bind:value={ollamaThinkingMode}>
                <option value="off" class="bg-darkbg">{language.modelProfiles.ollamaThinkingOff}</option>
                <option value="on" class="bg-darkbg">{language.modelProfiles.ollamaThinkingOn}</option>
                <option value="low" class="bg-darkbg">{language.modelProfiles.ollamaThinkingLow}</option>
                <option value="medium" class="bg-darkbg">{language.modelProfiles.ollamaThinkingMedium}</option>
                <option value="high" class="bg-darkbg">{language.modelProfiles.ollamaThinkingHigh}</option>
              </select>
            </label>
          {/if}
        </div>
      {:else if providerId === 'debug-echo'}
        <label class="flex flex-col gap-1 text-sm">
          <span>{language.modelProfiles.baseUrlLabel}</span>
          <TextInput size="sm" fullwidth bind:value={baseUrl} placeholder={language.modelProfiles.baseUrlPlaceholder} />
        </label>
      {/if}
    {/if}
  </div>
{/if}
