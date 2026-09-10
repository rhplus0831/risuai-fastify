<script lang="ts">
  import { ArrowDownIcon, ArrowUpIcon, CopyIcon, PencilIcon, PlusIcon, TrashIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import {
    createAgent,
    deleteAgent,
    duplicateAgent,
    reorderAgents,
    updateAgent,
    type AgentMutationOutcome,
  } from 'src/ts/agents'
  import type { AgentPresetRecord, AgentRecord } from 'src/ts/agentPresetRecords'
  import type { AgentSnapshot } from 'src/ts/server/commands'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import AgentEditorDrawer from './AgentEditorDrawer.svelte'

  interface Props {
    onEditPreset?: (presetId: string) => void
  }

  let { onEditPreset }: Props = $props()

  let mode = $state<'create' | 'edit' | null>(null)
  let editingId = $state<string | null>(null)
  let busy = $state(false)
  let error = $state('')
  let agents = $derived(readAgentOwners(settingsResourceState.value.agents))
  let presets = $derived(readPresetOwners(settingsResourceState.value.agentPresets))
  let editingAgent = $derived(editingId ? uniqueAgentById(agents, editingId) : undefined)

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

  function readPresetOwners(value: unknown): AgentPresetRecord[] {
    if (!Array.isArray(value)) return []
    const ids = new Set<string>()
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
      const id = (candidate as { id?: unknown }).id
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || ids.has(id)) return []
      ids.add(id)
    }
    return value as AgentPresetRecord[]
  }

  function referencingPresets(agentId: string): Array<{ preset: AgentPresetRecord; useCount: number }> {
    return presets.flatMap((preset) => {
      const useCount = (preset.agentUses ?? []).filter((use) => use.agentId === agentId).length
      return useCount > 0 ? [{ preset, useCount }] : []
    })
  }

  function uniqueAgentById(rows: readonly AgentRecord[], id: string): AgentRecord | undefined {
    let match: AgentRecord | undefined
    for (const candidate of rows) {
      if (candidate.id !== id) continue
      if (match) return undefined
      match = candidate
    }
    return match
  }

  function openCreate(): void {
    mode = 'create'
    editingId = null
    error = ''
  }

  function openEdit(agent: AgentRecord): void {
    mode = 'edit'
    editingId = agent.id
    error = ''
  }

  function close(): void {
    mode = null
    editingId = null
    error = ''
  }

  async function save(snapshot: AgentSnapshot): Promise<boolean> {
    if (!mode || busy) return false
    busy = true
    error = ''
    const result = mode === 'create' ? await createAgent(snapshot) : await updateAgent(editingId!, snapshot)
    busy = false
    return handle(result)
  }

  async function copy(agent: AgentRecord): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    const result = await duplicateAgent(agent.id, language.agentPresets.copyName(agent.name))
    busy = false
    handle(result)
  }

  async function remove(agent: AgentRecord): Promise<void> {
    if (busy || !window.confirm(language.agentPresets.deleteAgentConfirm(agent.name))) return
    busy = true
    error = ''
    const result = await deleteAgent(agent.id)
    busy = false
    handle(result)
  }

  async function move(agent: AgentRecord, delta: -1 | 1): Promise<void> {
    const index = agents.findIndex((candidate) => candidate.id === agent.id)
    const nextIndex = index + delta
    if (busy || index < 0 || nextIndex < 0 || nextIndex >= agents.length) return
    const ids = agents.map((candidate) => candidate.id)
    const [id] = ids.splice(index, 1)
    ids.splice(nextIndex, 0, id)
    busy = true
    error = ''
    const result = await reorderAgents(ids)
    busy = false
    handle(result)
  }

  function handle(outcome: AgentMutationOutcome<any>): boolean {
    if (outcome.status === 'accepted') return true
    if (outcome.status === 'queued') {
      error = language.agentPresets.commandQueued
      return true
    }
    error =
      outcome.result.status === 'conflict'
        ? language.agentPresets.commandConflict
        : outcome.result.status === 'error'
          ? outcome.result.error
          : language.agentPresets.commandUnavailable
    return false
  }
</script>

<section class="flex flex-col gap-3" data-risu-agent-settings>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h3 class="text-lg font-semibold">{language.agentPresets.agentsTitle}</h3>
      <p class="text-sm text-textcolor2">{language.agentPresets.agentsDescription}</p>
    </div>
    <Button size="sm" disabled={busy} onclick={openCreate}>
      <span class="inline-flex items-center gap-2"><PlusIcon size={16} />{language.agentPresets.createAgent}</span>
    </Button>
  </div>
  {#if error}<div class="rounded-md border border-draculared p-3 text-sm text-draculared">{error}</div>{/if}
  {#if agents.length === 0}
    <p class="text-sm text-textcolor2">{language.agentPresets.emptyAgents}</p>
  {:else}
    <div class="grid gap-2 lg:grid-cols-2" data-risu-agent-list>
      {#each agents as agent, index (agent.id)}
        {@const references = referencingPresets(agent.id)}
        <article class="risu-card flex flex-col gap-2" data-risu-agent-row data-agent-id={agent.id}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{agent.name}</span>
            <span class="text-xs text-textcolor2">{agent.outputFormat}</span>
            <div class="ml-auto flex gap-1">
              <Button
                size="sm"
                styled="outlined"
                className="min-h-11 min-w-11"
                disabled={busy || index === 0}
                ariaLabel={language.agentPresets.moveAgentUp(agent.name)}
                onclick={() => move(agent, -1)}><ArrowUpIcon size={14} /></Button>
              <Button
                size="sm"
                styled="outlined"
                className="min-h-11 min-w-11"
                disabled={busy || index === agents.length - 1}
                ariaLabel={language.agentPresets.moveAgentDown(agent.name)}
                onclick={() => move(agent, 1)}><ArrowDownIcon size={14} /></Button>
              <Button
                size="sm"
                styled="outlined"
                className="min-h-11 min-w-11"
                disabled={busy}
                ariaLabel={language.agentPresets.editAgentNamed(agent.name)}
                onclick={() => openEdit(agent)}><PencilIcon size={14} /></Button>
              <Button
                size="sm"
                styled="outlined"
                className="min-h-11 min-w-11"
                disabled={busy}
                ariaLabel={language.agentPresets.duplicateAgentNamed(agent.name)}
                onclick={() => copy(agent)}><CopyIcon size={14} /></Button>
              <span class="border-l border-darkborderc pl-1" data-risu-danger-action>
                <Button
                  size="sm"
                  styled="danger"
                  className="min-h-11 min-w-11"
                  disabled={busy || references.length > 0}
                  ariaLabel={references.length > 0
                    ? language.agentPresets.deleteAgentBlocked(agent.name, references.length)
                    : language.agentPresets.deleteAgentAccessibleName(agent.name)}
                  onclick={() => remove(agent)}><TrashIcon size={14} /></Button>
              </span>
            </div>
          </div>
          {#if agent.description}<p class="text-xs text-textcolor2">{agent.description}</p>{/if}
          <span class="break-all text-xs text-textcolor2">{agent.id}</span>
          {#if references.length > 0}
            <details class="text-xs text-textcolor2" data-risu-agent-dependencies>
              <summary class="cursor-pointer font-medium text-textcolor">
                {language.agentPresets.usedByPresets(references.length)}
              </summary>
              <ul class="mt-2 space-y-1 border-l border-darkborderc pl-3">
                {#each references as reference (reference.preset.id)}
                  <li class="flex flex-wrap items-center justify-between gap-2">
                    <span>{language.agentPresets.presetUseCount(reference.preset.name, reference.useCount)}</span>
                    {#if onEditPreset}
                      <Button size="sm" styled="outlined" onclick={() => onEditPreset?.(reference.preset.id)}>
                        {language.agentPresets.openBlockingPreset(reference.preset.name)}
                      </Button>
                    {/if}
                  </li>
                {/each}
              </ul>
            </details>
          {:else}
            <span class="text-xs text-textcolor2">{language.agentPresets.agentUnused}</span>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

{#if mode}
  <AgentEditorDrawer {mode} agent={editingAgent} {busy} commandError={error} onSave={save} onCancel={close} />
{/if}
