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
  title={name}
  class="flex min-h-11 min-w-0 grow cursor-pointer items-center gap-1 px-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
  onclick={(event) => {
    event.stopPropagation()
    onActivate()
  }}>
  {#if pinned}<PinIcon size={12} aria-hidden="true" />{/if}
  <span class="truncate">{name}</span>
  {#if selected}<span class="sr-only">({name} — current)</span>{/if}
</button>
