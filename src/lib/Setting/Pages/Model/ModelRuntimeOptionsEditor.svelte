<script lang="ts">
  import { language } from 'src/lang'
  import { resolveModelRuntimeDefaults } from 'src/ts/model/modelProfileResolver'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import {
    normalizeModelProfileRuntimeOptions,
    type ModelProfileRecordRuntimeOptions,
  } from 'src/ts/model/modelProfileRecords'
  import { FASTIFY_TOKENIZER_OPTIONS } from 'src/ts/model/tokenizerOptions'
  import { LLMFlags, type LLMFlags as LLMFlagValue } from 'src/ts/model/types'

  type RuntimeKey = keyof ModelProfileRecordRuntimeOptions
  type LLMFlagKey = keyof typeof LLMFlags

  interface RuntimeNumberField {
    kind: 'number'
    key: RuntimeKey
    label: string
    step?: string
    min?: number
    max?: number
    storageScale?: number
  }

  interface RuntimeStringField {
    kind: 'string'
    key: RuntimeKey
    label: string
    multiline?: boolean
  }

  interface RuntimeBooleanField {
    kind: 'boolean'
    key: RuntimeKey
    label: string
  }

  interface RuntimeTokenizerField {
    kind: 'tokenizer'
    key: 'customTokenizer'
    label: string
  }

  interface RuntimeModelToolsField {
    kind: 'modelTools'
    key: 'modelTools'
    label: string
  }

  interface RuntimeFlagsField {
    kind: 'flags'
    key: 'customFlags'
    label: string
  }

  type RuntimeField =
    | RuntimeNumberField
    | RuntimeStringField
    | RuntimeBooleanField
    | RuntimeTokenizerField
    | RuntimeModelToolsField
    | RuntimeFlagsField

  interface RuntimeGroup {
    key: 'sampling' | 'reasoning' | 'outputFormat' | 'other' | 'capabilityFlags'
    label: string
    fields: RuntimeField[]
  }

  interface Props {
    value: ModelProfileRecordRuntimeOptions
    scope?: 'defaults' | 'overrides'
    advancedOnly?: boolean
    defaults?: ModelProfileRecordRuntimeOptions
    hiddenKeys?: RuntimeKey[]
  }

  let { value = $bindable({}), scope = 'overrides', defaults = {}, hiddenKeys = [] }: Props = $props()
  let inherited = $derived(resolveModelRuntimeDefaults(scope === 'defaults' ? undefined : defaults))
  let hiddenKeySet = $derived(new Set<RuntimeKey>(hiddenKeys))

  function defaultValueLabel(key: RuntimeKey, storageScale?: number): string {
    const current = inherited[key]
    let label = language.none
    if (typeof current === 'boolean')
      label = current ? language.modelProfiles.runtimeOn : language.modelProfiles.runtimeOff
    else if (typeof current === 'number') {
      label =
        current === -1000
          ? language.modelProfiles.runtimeNotSent
          : String(storageScale ? current / storageScale : current)
    } else if (typeof current === 'string' && current) label = current
    return language.modelProfiles.runtimeDefaultValue(label)
  }

  const runtimeGroups: RuntimeGroup[] = [
    {
      key: 'sampling',
      label: language.modelProfiles.runtimeGroups.sampling,
      fields: [
        {
          kind: 'number',
          key: 'temperature',
          label: language.modelProfiles.runtimeFields.temperature,
          step: '0.01',
          min: 0,
          max: 2,
          storageScale: 100,
        },
        { kind: 'number', key: 'topP', label: language.modelProfiles.runtimeFields.topP, step: '0.01' },
        { kind: 'number', key: 'topK', label: language.modelProfiles.runtimeFields.topK, step: '1' },
        { kind: 'number', key: 'minP', label: language.modelProfiles.runtimeFields.minP, step: '0.01' },
        { kind: 'number', key: 'topA', label: language.modelProfiles.runtimeFields.topA, step: '0.01' },
        {
          kind: 'number',
          key: 'repetitionPenalty',
          label: language.modelProfiles.runtimeFields.repetitionPenalty,
          step: '0.01',
        },
        {
          kind: 'number',
          key: 'frequencyPenalty',
          label: language.modelProfiles.runtimeFields.frequencyPenalty,
          step: '0.01',
          min: 0,
          max: 2,
          storageScale: 100,
        },
        {
          kind: 'number',
          key: 'presencePenalty',
          label: language.modelProfiles.runtimeFields.presencePenalty,
          step: '0.01',
          min: 0,
          max: 2,
          storageScale: 100,
        },
      ],
    },
    {
      key: 'reasoning',
      label: language.modelProfiles.runtimeGroups.reasoning,
      fields: [
        {
          kind: 'number',
          key: 'reasoningEffort',
          label: language.modelProfiles.runtimeFields.reasoningEffort,
          step: '1',
        },
        {
          kind: 'number',
          key: 'thinkingTokens',
          label: language.modelProfiles.runtimeFields.thinkingTokens,
          step: '1',
        },
        { kind: 'number', key: 'verbosity', label: language.modelProfiles.runtimeFields.verbosity, step: '1' },
        { kind: 'string', key: 'thinkingType', label: language.modelProfiles.runtimeFields.thinkingType },
        {
          kind: 'string',
          key: 'deepseekThinkingType',
          label: language.modelProfiles.runtimeFields.deepseekThinkingType,
        },
        {
          kind: 'string',
          key: 'adaptiveThinkingEffort',
          label: language.modelProfiles.runtimeFields.adaptiveThinkingEffort,
        },
        {
          kind: 'string',
          key: 'deepseekReasoningEffort',
          label: language.modelProfiles.runtimeFields.deepseekReasoningEffort,
        },
        { kind: 'boolean', key: 'stripCoT', label: language.modelProfiles.runtimeFields.stripCoT },
      ],
    },
    {
      key: 'outputFormat',
      label: language.modelProfiles.runtimeGroups.outputFormat,
      fields: [
        {
          kind: 'string',
          key: 'extractJson',
          label: language.modelProfiles.runtimeFields.extractJson,
          multiline: true,
        },
        {
          kind: 'string',
          key: 'jsonSchema',
          label: language.modelProfiles.runtimeFields.jsonSchema,
          multiline: true,
        },
        {
          kind: 'boolean',
          key: 'jsonSchemaEnabled',
          label: language.modelProfiles.runtimeFields.jsonSchemaEnabled,
        },
        {
          kind: 'boolean',
          key: 'strictJsonSchema',
          label: language.modelProfiles.runtimeFields.strictJsonSchema,
        },
        {
          kind: 'boolean',
          key: 'outputImageModal',
          label: language.modelProfiles.runtimeFields.outputImageModal,
        },
      ],
    },
    {
      key: 'other',
      label: language.modelProfiles.runtimeGroups.other,
      fields: [
        { kind: 'number', key: 'genTime', label: language.modelProfiles.runtimeFields.genTime, step: '1' },
        {
          kind: 'tokenizer',
          key: 'customTokenizer',
          label: language.modelProfiles.runtimeFields.customTokenizer,
        },
        { kind: 'modelTools', key: 'modelTools', label: language.modelProfiles.runtimeFields.modelTools },
      ],
    },
    {
      key: 'capabilityFlags',
      label: language.modelProfiles.runtimeGroups.capabilityFlags,
      fields: [
        {
          kind: 'boolean',
          key: 'enableCustomFlags',
          label: language.modelProfiles.runtimeFields.enableCustomFlags,
        },
        { kind: 'flags', key: 'customFlags', label: language.modelProfiles.runtimeGroups.capabilityFlags },
      ],
    },
  ]

  let visibleRuntimeGroups = $derived(
    runtimeGroups
      .map((group) => ({ ...group, fields: group.fields.filter((field) => !hiddenKeySet.has(field.key)) }))
      .filter((group) => group.fields.length > 0),
  )

  const flagOptions = (Object.keys(LLMFlags) as LLMFlagKey[]).map((key) => ({
    key,
    label: language.modelProfiles.capabilityFlags[key],
    flag: LLMFlags[key] as LLMFlagValue,
  }))

  function asRecord(): Record<string, unknown> {
    return { ...(value ?? {}) }
  }

  function commit(next: Record<string, unknown>): void {
    value = normalizeModelProfileRuntimeOptions(next) ?? {}
  }

  function deleteRuntimeKey(key: RuntimeKey): void {
    const next = asRecord()
    delete next[key]
    commit(next)
  }

  function setNumber(field: RuntimeNumberField, raw: string): void {
    const trimmed = raw.trim()
    if (!trimmed) {
      deleteRuntimeKey(field.key)
      return
    }
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return
    const stored =
      field.storageScale && numeric !== -1000
        ? Math.max(
            (field.min ?? Number.NEGATIVE_INFINITY) * field.storageScale,
            Math.min(
              (field.max ?? Number.POSITIVE_INFINITY) * field.storageScale,
              Math.round(numeric * field.storageScale),
            ),
          )
        : numeric
    const next = asRecord()
    next[field.key] = stored
    commit(next)
  }

  function setString(key: RuntimeKey, raw: string): void {
    const trimmed = raw.trim()
    if (!trimmed) {
      deleteRuntimeKey(key)
      return
    }
    const next = asRecord()
    next[key] = raw
    commit(next)
  }

  function setBoolean(key: RuntimeKey, raw: string): void {
    if (raw !== 'true' && raw !== 'false') {
      deleteRuntimeKey(key)
      return
    }
    const next = asRecord()
    next[key] = raw === 'true'
    commit(next)
  }

  function setDefaultCheckbox(key: RuntimeKey, checked: boolean): void {
    const next = asRecord()
    if (checked) {
      next[key] = true
    } else {
      delete next[key]
    }
    commit(next)
  }

  function numberValue(field: RuntimeNumberField): string {
    const item = value?.[field.key]
    if (typeof item !== 'number' || !Number.isFinite(item)) return ''
    if (!field.storageScale || item === -1000) return String(item)
    return String(Number((item / field.storageScale).toFixed(12)))
  }

  function stringValue(key: RuntimeKey): string {
    const item = value?.[key]
    return typeof item === 'string' ? item : ''
  }

  function booleanValue(key: RuntimeKey): string {
    const item = value?.[key]
    return typeof item === 'boolean' ? String(item) : ''
  }

  function modelToolsValue(): string {
    return Array.isArray(value?.modelTools) ? value.modelTools.join(', ') : ''
  }

  function setModelTools(raw: string): void {
    const tools = raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const next = asRecord()
    if (tools.length > 0) {
      next.modelTools = tools
    } else {
      delete next.modelTools
    }
    commit(next)
  }

  function customFlags(): LLMFlagValue[] {
    return Array.isArray(value?.customFlags) ? value.customFlags : []
  }

  function customFlagEnabled(flag: LLMFlagValue): boolean {
    return customFlags().includes(flag)
  }

  function setCustomFlag(flag: LLMFlagValue, enabled: boolean): void {
    const nextFlags = enabled ? [...customFlags(), flag] : customFlags().filter((item) => item !== flag)
    const uniqueFlags = [...new Set(nextFlags)]
    const next = asRecord()
    if (uniqueFlags.length > 0) {
      next.customFlags = uniqueFlags
    } else {
      delete next.customFlags
    }
    commit(next)
  }
</script>

<div class="flex flex-col gap-4">
  <p class="text-sm text-textcolor2">
    {scope === 'defaults'
      ? language.modelProfiles.advancedGlobalDefaultsDescription
      : language.modelProfiles.advancedDefaultsDescription}
  </p>
  {#each visibleRuntimeGroups as group (group.key)}
    <section class="flex min-w-0 flex-col gap-2">
      <h4 class="text-sm font-semibold">{group.label}</h4>
      <div class="grid min-w-0 gap-3 md:grid-cols-2">
        {#each group.fields as field (field.key)}
          {#if field.kind === 'number'}
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-sm text-textcolor2">{field.label}</span>
              <input
                class="w-full rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                type="number"
                step={field.step}
                min={field.min}
                max={field.max}
                value={numberValue(field)}
                placeholder={defaultValueLabel(field.key, field.storageScale)}
                oninput={(event) => {
                  setNumber(field, event.currentTarget.value)
                }} />
            </label>
          {:else if field.kind === 'boolean'}
            {#if scope === 'defaults' && field.key === 'stripCoT'}
              <label class="flex min-w-0 items-center gap-2 text-sm text-textcolor2">
                <input
                  data-runtime-strip-cot
                  type="checkbox"
                  class="h-4 w-4 shrink-0"
                  checked={value?.stripCoT === true}
                  onchange={(event) => {
                    setDefaultCheckbox(field.key, event.currentTarget.checked)
                  }} />
                <span>{field.label}</span>
              </label>
            {:else}
              <label class="flex min-w-0 flex-col gap-1">
                <span class="text-sm text-textcolor2">{field.label}</span>
                <select
                  data-runtime-field={field.key}
                  class="w-full rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                  value={booleanValue(field.key)}
                  onchange={(event) => {
                    setBoolean(field.key, event.currentTarget.value)
                  }}>
                  <option value="" class="bg-darkbg">{defaultValueLabel(field.key)}</option>
                  <option value="true" class="bg-darkbg">{language.modelProfiles.runtimeOn}</option>
                  <option value="false" class="bg-darkbg">{language.modelProfiles.runtimeOff}</option>
                </select>
              </label>
            {/if}
          {:else if field.kind === 'string'}
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-sm text-textcolor2">{field.label}</span>
              {#if field.multiline}
                <textarea
                  class="min-h-24 w-full rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                  value={stringValue(field.key)}
                  placeholder={defaultValueLabel(field.key)}
                  oninput={(event) => {
                    setString(field.key, event.currentTarget.value)
                  }}></textarea>
              {:else}
                <TextInput
                  size="sm"
                  fullwidth
                  value={stringValue(field.key)}
                  placeholder={defaultValueLabel(field.key)}
                  oninput={(event) => {
                    setString(field.key, event.currentTarget.value)
                  }} />
              {/if}
            </label>
          {:else if field.kind === 'tokenizer'}
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-sm text-textcolor2">{field.label}</span>
              <select
                data-runtime-tokenizer-picker
                class="w-full rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                value={stringValue(field.key)}
                onchange={(event) => {
                  setString(field.key, event.currentTarget.value)
                }}>
                <option value="" class="bg-darkbg">{language.modelProfiles.runtimeUnset}</option>
                {#each FASTIFY_TOKENIZER_OPTIONS as option (option.value)}
                  <option value={option.value} class="bg-darkbg">{language.tokenizerOptions[option.labelKey]}</option>
                {/each}
              </select>
            </label>
          {:else if field.kind === 'modelTools'}
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-sm text-textcolor2">{field.label}</span>
              <TextInput
                size="sm"
                fullwidth
                value={modelToolsValue()}
                placeholder={language.modelProfiles.commaSeparatedPlaceholder}
                oninput={(event) => {
                  setModelTools(event.currentTarget.value)
                }} />
            </label>
          {:else}
            <div class="col-span-full grid min-w-0 gap-2 sm:grid-cols-2" aria-label={field.label}>
              {#each flagOptions as option (option.flag)}
                <label class="flex min-w-0 items-start gap-2 text-sm text-textcolor2" title={option.key}>
                  <input
                    type="checkbox"
                    class="mt-0.5 h-4 w-4 shrink-0"
                    checked={customFlagEnabled(option.flag)}
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
          {/if}
        {/each}
      </div>
    </section>
  {/each}
</div>
