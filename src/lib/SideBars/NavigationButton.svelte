<script lang="ts">
  import type { Snippet } from 'svelte'
  let {
    label,
    selected,
    enabled,
    disabledReason,
    onActivate,
    onIntent,
    children,
  }: {
    label: string
    selected: boolean
    enabled: boolean
    disabledReason: string
    onActivate: () => void
    onIntent: () => void
    children: Snippet
  } = $props()
</script>

<button
  type="button"
  class="flex items-center justify-center py-2 flex-col gap-1 w-full disabled:cursor-not-allowed disabled:opacity-50"
  class:text-textcolor2={!selected}
  disabled={!enabled}
  aria-label={!enabled ? `${label}: ${disabledReason}` : label}
  title={!enabled ? disabledReason : label}
  aria-current={selected ? 'page' : undefined}
  onclick={() => {
    if (enabled) onActivate()
  }}
  onpointerenter={() => {
    if (enabled) onIntent()
  }}
  onfocus={() => {
    if (enabled) onIntent()
  }}>
  {@render children()}
  <span class="text-xs">{label}</span>
</button>
