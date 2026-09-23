<script lang="ts">
  import { language } from 'src/lang'
  import { resolveModelRuntimeDefaults } from 'src/ts/model/modelProfileResolver'
  import {
    normalizeModelProfileRuntimeOptions,
    type ModelProfileRecordRuntimeOptions,
  } from 'src/ts/model/modelProfileRecords'

  interface Props {
    value: ModelProfileRecordRuntimeOptions
    defaults?: ModelProfileRecordRuntimeOptions
    scope?: 'defaults' | 'overrides'
    showHeading?: boolean
  }

  let { value = $bindable({}), defaults = {}, scope = 'overrides', showHeading = true }: Props = $props()
  const id = $props.id()
  const numberKeys = ['maxResponse', 'maxContext'] as const
  const booleanKeys = ['useStreaming', 'halfStreaming'] as const
  type CommonKey = (typeof numberKeys)[number] | (typeof booleanKeys)[number]

  let inherited = $derived(resolveModelRuntimeDefaults(scope === 'defaults' ? undefined : defaults))

  function setValue(key: CommonKey, nextValue: number | boolean | undefined): void {
    const next = { ...value }
    if (nextValue === undefined) delete next[key]
    else Object.assign(next, { [key]: nextValue })
    value = normalizeModelProfileRuntimeOptions(next) ?? {}
  }

  function isInherited(key: CommonKey): boolean {
    return value[key] === undefined
  }

  function numberValue(key: (typeof numberKeys)[number]): string {
    const current = value[key]
    return typeof current === 'number' && Number.isFinite(current) ? String(current) : ''
  }

  function defaultValueLabel(key: CommonKey): string {
    const current = inherited[key]
    const label =
      typeof current === 'boolean'
        ? current
          ? language.modelProfiles.runtimeOn
          : language.modelProfiles.runtimeOff
        : typeof current === 'number'
          ? String(current)
          : language.none
    return language.modelProfiles.runtimeDefaultValue(label)
  }

  function sourceLabel(key: CommonKey): string {
    if (isInherited(key)) {
      return scope === 'defaults'
        ? language.modelProfiles.builtInDefaultSource
        : language.modelProfiles.globalDefaultSource
    }
    return scope === 'defaults'
      ? language.modelProfiles.globalDefaultSource
      : language.modelProfiles.modelOverrideSource
  }
</script>

<section class="flex flex-col gap-4" data-model-generation-settings>
  {#if showHeading}
    <div>
      <h3 class="text-base font-semibold">{language.modelProfiles.generationSettingsTitle}</h3>
      <p class="mt-1 text-sm text-textcolor2">
        {scope === 'defaults'
          ? language.modelProfiles.globalDefaultsDescription
          : language.modelProfiles.generationDefaultsDescription}
      </p>
    </div>
  {/if}
  {#each numberKeys as key (key)}
    <div
      class="grid grid-cols-[minmax(0,1fr)_minmax(9.5rem,42%)] items-start gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:gap-4">
      <div>
        <label for={`${id}-${key}`} class="text-sm font-medium">{language.modelProfiles.runtimeFields[key]}</label>
        <p class="mt-1 text-xs text-textcolor2">{language.modelProfiles.generationFieldDescriptions[key]}</p>
      </div>
      <div class="flex min-w-0 flex-col gap-1">
        <input
          id={`${id}-${key}`}
          data-runtime-field={key}
          class="w-full rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor focus:border-borderc focus:ring-2 focus:ring-borderc"
          type="number"
          step="1"
          value={numberValue(key)}
          placeholder={defaultValueLabel(key)}
          oninput={(event) => {
            const raw = event.currentTarget.value.trim()
            if (!raw) return
            const numeric = Number(raw)
            if (Number.isFinite(numeric)) setValue(key, numeric)
          }}
          onblur={(event) => {
            if (!event.currentTarget.value.trim()) setValue(key, undefined)
          }} />
        {#if !isInherited(key)}
          <button
            type="button"
            class="min-h-6 self-start text-xs text-textcolor2 underline underline-offset-2 hover:text-textcolor"
            onclick={() => setValue(key, undefined)}>
            {language.modelProfiles.useDefault}
          </button>
        {/if}
        <span class="text-xs text-textcolor2">{sourceLabel(key)}</span>
      </div>
    </div>
  {/each}
  {#each booleanKeys as key (key)}
    <div
      class="grid grid-cols-[minmax(0,1fr)_minmax(9.5rem,42%)] items-start gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:gap-4">
      <div>
        <label for={`${id}-${key}`} class="text-sm font-medium">{language.modelProfiles.runtimeFields[key]}</label>
        <p class="mt-1 text-xs text-textcolor2">{language.modelProfiles.generationFieldDescriptions[key]}</p>
      </div>
      <div class="flex min-w-0 flex-col gap-1">
        <select
          id={`${id}-${key}`}
          data-runtime-field={key}
          class="w-full rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor focus:border-borderc focus:ring-2 focus:ring-borderc"
          value={isInherited(key) ? '' : String(value[key])}
          onchange={(event) => {
            const selected = event.currentTarget.value
            setValue(key, selected === '' ? undefined : selected === 'true')
          }}>
          <option value="" class="bg-darkbg">
            {language.modelProfiles.runtimeDefaultValue(
              inherited[key] ? language.modelProfiles.runtimeOn : language.modelProfiles.runtimeOff,
            )}
          </option>
          <option value="true" class="bg-darkbg">{language.modelProfiles.runtimeOn}</option>
          <option value="false" class="bg-darkbg">{language.modelProfiles.runtimeOff}</option>
        </select>
        <span class="text-xs text-textcolor2">{sourceLabel(key)}</span>
      </div>
    </div>
  {/each}
</section>
