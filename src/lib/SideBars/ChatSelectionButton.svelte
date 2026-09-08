<script lang="ts">
  import { PinIcon } from '@lucide/svelte'
  let {
    name,
    selected,
    pinned = false,
    onActivate,
    ariaLabel,
  }: {
    name: string
    selected: boolean
    pinned?: boolean
    ariaLabel?: string
    onActivate: () => void
  } = $props()
</script>

<button
  type="button"
  data-risu-chat-action="select"
  aria-label={ariaLabel}
  aria-current={selected ? 'page' : undefined}
  class="min-w-0 grow cursor-pointer text-left flex items-center gap-1"
  onclick={(event) => {
    event.stopPropagation()
    onActivate()
  }}>
  {#if pinned}<PinIcon size={12} aria-hidden="true" />{/if}
  <span class="truncate">{name}</span>
</button>
