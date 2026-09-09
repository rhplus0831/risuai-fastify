<script lang="ts">
  interface Props {
    onClick?: any
    additionalStyle?: string | Promise<string>
    children?: import('svelte').Snippet
    interactive?: boolean
    ariaLabel?: string
    onIntent?: () => void
    enabled?: boolean
    disabledReason?: string
  }

  let {
    onClick = () => {},
    additionalStyle = '',
    children,
    interactive = true,
    ariaLabel,
    onIntent = () => {},
    enabled = true,
    disabledReason = '',
  }: Props = $props()

  const accessibleLabel = $derived(!enabled && disabledReason ? `${ariaLabel}: ${disabledReason}` : ariaLabel)
</script>

{#await additionalStyle}
  {#if interactive}
    <button
      type="button"
      onclick={() => {
        if (enabled) onClick()
      }}
      onpointerenter={() => {
        if (enabled) onIntent()
      }}
      onfocus={() => {
        if (enabled) onIntent()
      }}
      class="ico"
      disabled={!enabled}
      aria-label={accessibleLabel}
      title={!enabled ? disabledReason : ariaLabel}>{@render children?.()}</button>
  {:else}
    <div class="ico" aria-hidden="true">{@render children?.()}</div>
  {/if}
{:then as}
  {#if interactive}
    <button
      type="button"
      onclick={() => {
        if (enabled) onClick()
      }}
      onpointerenter={() => {
        if (enabled) onIntent()
      }}
      onfocus={() => {
        if (enabled) onIntent()
      }}
      class="ico"
      style={as}
      disabled={!enabled}
      aria-label={accessibleLabel}
      title={!enabled ? disabledReason : ariaLabel}>{@render children?.()}</button>
  {:else}
    <div class="ico" style={as} aria-hidden="true">{@render children?.()}</div>
  {/if}
{/await}

<style>
  .ico {
    cursor: pointer;
    border-radius: 0.375rem;
    height: 3.5rem;
    width: 3.5rem;
    min-height: 3.5rem;
    --tw-shadow-color: 0, 0, 0;
    --tw-shadow: 0 10px 15px -3px rgba(var(--tw-shadow-color), 0.1), 0 4px 6px -2px rgba(var(--tw-shadow-color), 0.05);
    -webkit-box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow);
    box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow);
    --tw-bg-opacity: 1;
    background-color: rgba(107, 114, 128, var(--tw-bg-opacity));
    display: flex;
    justify-content: center;
    align-items: center;
    transition-property: background-color, border-color, color, fill, stroke;
    transition-duration: 150ms;
    transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }

  .ico:disabled {
    cursor: not-allowed;
  }

  .ico:not(:disabled):hover {
    --tw-bg-opacity: 1;
    background-color: rgba(16, 185, 129, var(--tw-bg-opacity));
  }
</style>
