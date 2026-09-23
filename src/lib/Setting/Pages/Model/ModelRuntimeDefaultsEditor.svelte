<script lang="ts">
  import { PencilIcon, RotateCcwIcon, SaveIcon, XIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import {
    normalizeModelRuntimeDefaults,
    type ModelProfileRecordRuntimeOptions,
  } from 'src/ts/model/modelProfileRecords'
  import { resolveModelRuntimeDefaults } from 'src/ts/model/modelProfileResolver'
  import {
    beginPendingModelMutation,
    finishPendingModelMutation,
    getPendingModelMutations,
    isPendingModelMutationProjectionApplied,
    retainPendingModelMutation,
    subscribePendingModelMutations,
    updateModelRuntimeDefaultsDurably,
  } from 'src/ts/model/modelProfileMutations'
  import type { ServerCommandResult } from 'src/ts/server/commands'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import ModelRuntimeOptionsEditor from './ModelRuntimeOptionsEditor.svelte'
  import ModelGenerationSettings from './ModelGenerationSettings.svelte'

  let { compact = false }: { compact?: boolean } = $props()

  let editing = $state(false)
  let saving = $state(false)
  let pendingMutations = $state(getPendingModelMutations('model-runtime-defaults'))
  let commandError = $state('')
  let draft = $state<ModelProfileRecordRuntimeOptions>({})
  let editBaseline = $state<ModelProfileRecordRuntimeOptions>({})
  let lastServerSnapshot = $state('')

  let runtimeDefaults = $derived(normalizeModelRuntimeDefaults(settingsResourceState.value.modelRuntimeDefaults))
  let effectiveRuntimeDefaults = $derived(resolveModelRuntimeDefaults(runtimeDefaults))
  let runtimeDefaultsSummary = $derived(
    [
      `${language.modelProfiles.runtimeFields.maxResponse} ${effectiveRuntimeDefaults.maxResponse ?? language.none}`,
      `${language.modelProfiles.runtimeFields.maxContext} ${effectiveRuntimeDefaults.maxContext ?? language.none}`,
      `${language.modelProfiles.runtimeFields.useStreaming} ${runtimeBooleanLabel(effectiveRuntimeDefaults.useStreaming)}`,
      `${language.modelProfiles.runtimeFields.halfStreaming} ${runtimeBooleanLabel(effectiveRuntimeDefaults.halfStreaming)}`,
    ].join(' · '),
  )
  let saveQueued = $derived(pendingMutations.length > 0)
  let draftRuntimeDefaultCount = $derived(Object.keys(normalizeModelRuntimeDefaults(draft)).length)
  let draftChanged = $derived(snapshot(draft) !== snapshot(runtimeDefaults))

  $effect(() => {
    return subscribePendingModelMutations('model-runtime-defaults', (pending) => {
      pendingMutations = pending
    })
  })

  $effect(() => {
    const nextSnapshot = snapshot(runtimeDefaults)
    if (nextSnapshot === lastServerSnapshot) return
    lastServerSnapshot = nextSnapshot
    if (!editing) {
      draft = cloneJsonValue(runtimeDefaults)
      editBaseline = cloneJsonValue(runtimeDefaults)
      commandError = ''
      return
    }

    draft = rebaseDirtyRuntimeDefaults(editBaseline, draft, runtimeDefaults)
    editBaseline = cloneJsonValue(runtimeDefaults)
  })

  $effect(() => {
    for (const pending of pendingMutations) {
      if (pending.phase === 'discarded') {
        commandError = language.modelProfiles.commandReplayDiscarded
        finishPendingModelMutation(pending.token)
        continue
      }
      if (
        pending.phase !== 'dispatching' &&
        pending.projection.kind === 'runtime-defaults' &&
        isPendingModelMutationProjectionApplied(pending.projection, {
          modelRuntimeDefaults: runtimeDefaults,
        })
      ) {
        finishPendingModelMutation(pending.token)
      }
    }
  })

  function cloneJsonValue<T>(value: T): T {
    if (value === undefined) return value
    return JSON.parse(JSON.stringify(value)) as T
  }

  function snapshot(value: unknown): string {
    return JSON.stringify(value ?? {})
  }

  function snapshotValue(value: unknown): string {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? '__undefined__' : serialized
  }

  function runtimeBooleanLabel(value: boolean | undefined): string {
    return value ? language.modelProfiles.runtimeOn : language.modelProfiles.runtimeOff
  }

  function rebaseDirtyRuntimeDefaults(
    baseline: ModelProfileRecordRuntimeOptions,
    attempted: ModelProfileRecordRuntimeOptions,
    projection: ModelProfileRecordRuntimeOptions,
  ): ModelProfileRecordRuntimeOptions {
    const baselineRecord = baseline as Record<string, unknown>
    const attemptedRecord = attempted as Record<string, unknown>
    const next = cloneJsonValue(projection) as Record<string, unknown>
    const keys = new Set([...Object.keys(baselineRecord), ...Object.keys(attemptedRecord)])

    for (const key of keys) {
      if (snapshotValue(baselineRecord[key]) === snapshotValue(attemptedRecord[key])) continue
      if (Object.prototype.hasOwnProperty.call(attemptedRecord, key)) {
        next[key] = cloneJsonValue(attemptedRecord[key])
      } else {
        delete next[key]
      }
    }

    return normalizeModelRuntimeDefaults(next)
  }

  function startEditing(): void {
    if (saveQueued) return
    draft = cloneJsonValue(runtimeDefaults)
    editBaseline = cloneJsonValue(runtimeDefaults)
    lastServerSnapshot = snapshot(runtimeDefaults)
    commandError = ''
    editing = true
  }

  function cancelEditing(): void {
    if (saving) return
    draft = cloneJsonValue(runtimeDefaults)
    editBaseline = cloneJsonValue(runtimeDefaults)
    commandError = ''
    editing = false
  }

  function resetDraft(): void {
    if (saving) return
    draft = {}
    commandError = ''
  }

  function commandErrorMessage(result: Exclude<ServerCommandResult, { status: 'ok' }>): string {
    return result.status === 'conflict'
      ? language.modelProfiles.commandConflict
      : result.status === 'error'
        ? result.error
        : language.modelProfiles.commandUnavailable
  }

  async function saveDefaults(): Promise<void> {
    if (saving || saveQueued) return
    saving = true
    commandError = ''
    const runtimeDefaultsDraft = cloneJsonValue(normalizeModelRuntimeDefaults(draft))
    const pendingToken = beginPendingModelMutation('model-runtime-defaults', {
      kind: 'runtime-defaults',
      runtimeDefaults: runtimeDefaultsDraft,
    })
    if (!pendingToken) {
      saving = false
      return
    }
    try {
      const outcome = await updateModelRuntimeDefaultsDurably(runtimeDefaultsDraft)
      if (outcome.status === 'accepted') {
        finishPendingModelMutation(pendingToken)
        editing = false
        return
      }
      if (outcome.status === 'queued') {
        retainPendingModelMutation(pendingToken, outcome.mutationId)
        editing = false
        return
      }
      finishPendingModelMutation(pendingToken)
      commandError = commandErrorMessage(outcome.result)
    } catch {
      finishPendingModelMutation(pendingToken)
      commandError = commandErrorMessage({ status: 'unavailable' })
    } finally {
      saving = false
    }
  }
</script>

<section aria-busy={saving}>
  <fieldset
    data-model-runtime-defaults-form
    class={compact ? 'm-0 min-w-0 rounded-md border border-darkborderc p-4' : 'm-0 min-w-0 border-0 p-0'}
    disabled={saving}
    aria-busy={saving}>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <h3 class="text-base font-semibold">{language.modelProfiles.runtimeDefaultsTitle}</h3>
        {#if compact && !editing}
          <span class="break-words text-sm text-textcolor2">
            {runtimeDefaultsSummary}
          </span>
        {:else}
          <span class="text-sm text-textcolor2">
            {language.modelProfiles.globalDefaultsDescription}
          </span>
        {/if}
      </div>
      {#if editing}
        <div class="flex flex-wrap justify-end gap-2">
          <Button size="sm" styled="outlined" disabled={saving || draftRuntimeDefaultCount === 0} onclick={resetDraft}>
            <span class="inline-flex items-center gap-1"
              ><RotateCcwIcon size={14} />{language.modelProfiles.reset}</span>
          </Button>
          <Button size="sm" styled="outlined" disabled={saving} onclick={cancelEditing}>
            <span class="inline-flex items-center gap-1"><XIcon size={14} />{language.modelProfiles.cancel}</span>
          </Button>
          <Button size="sm" disabled={saving || !draftChanged} onclick={saveDefaults}>
            <span class="inline-flex items-center gap-2"
              ><SaveIcon size={16} />{saving ? language.modelProfiles.saving : language.modelProfiles.save}</span>
          </Button>
        </div>
      {:else}
        <Button size="sm" styled="outlined" disabled={saveQueued} onclick={startEditing}>
          <span class="inline-flex items-center gap-2"><PencilIcon size={16} />{language.modelProfiles.edit}</span>
        </Button>
      {/if}
    </div>

    {#if commandError}
      <div class="mt-3 rounded-md border border-draculared p-2 text-sm text-draculared">{commandError}</div>
    {/if}
    {#if editing}
      <div class="mt-4 flex flex-col gap-4">
        <ModelGenerationSettings bind:value={draft} scope="defaults" showHeading={false} />
        <Accordion styled name={language.modelProfiles.runtimeOverridesTitle}>
          <ModelRuntimeOptionsEditor bind:value={draft} scope="defaults" advancedOnly />
        </Accordion>
      </div>
    {/if}
  </fieldset>
</section>
