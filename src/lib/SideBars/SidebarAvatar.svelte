<script lang="ts">
  import { tooltipRight } from 'src/ts/gui/tooltip'

  interface Props {
    rounded: boolean
    src: string | Promise<string>
    name: string
    size?: string
    onClick: () => void
    ariaLabel?: string
    ariaExpanded?: boolean
    ariaControls?: string
    bordered?: boolean
    color?: string
    backgroundimg?: string | Promise<string>
    children?: import('svelte').Snippet
    oncontextmenu?: (
      event: MouseEvent & {
        currentTarget: EventTarget & HTMLButtonElement
      },
    ) => any
    chaId?: string
    isCurrent?: boolean
  }

  let {
    rounded,
    src,
    name,
    size = '22',
    onClick,
    ariaLabel,
    ariaExpanded,
    ariaControls,
    bordered = false,
    color = '',
    backgroundimg = '',
    children,
    oncontextmenu,
    chaId,
    isCurrent = false,
  }: Props = $props()

  let imageFailed = $state(false)
  const initials = $derived.by(() => {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return '?'
    return parts
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toLocaleUpperCase()
  })

  $effect(() => {
    void src
    imageFailed = false
  })
</script>

{#snippet fallback()}
  <div
    class="bg-skin-border sidebar-avatar flex items-center justify-center bg-selected font-semibold text-textcolor"
    style:width={size + 'px'}
    style:height={size + 'px'}
    style:minWidth={size + 'px'}
    class:rounded-md={!rounded}
    class:rounded-full={rounded}
    aria-hidden="true">
    <span class="select-none" style:font-size={`${Math.max(10, Number(size) * 0.34)}px`}>{initials}</span>
  </div>
{/snippet}

<button
  type="button"
  class="avatar flex min-h-11 min-w-11 shrink-0 items-center justify-center"
  class:border={bordered}
  class:border-selected={bordered}
  class:rounded-md={bordered}
  {oncontextmenu}
  onclick={onClick}
  onkeydown={(event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.currentTarget.click()
  }}
  use:tooltipRight={name}
  tabindex="0"
  aria-label={ariaLabel ?? name}
  aria-expanded={ariaExpanded}
  aria-controls={ariaControls}
  aria-current={isCurrent ? 'page' : undefined}
  data-char-id={chaId}>
  {#if src}
    {#if src === 'slot'}
      {#await backgroundimg}
        <div
          class="bg-skin-border sidebar-avatar rounded-md bg-top flex items-center justify-center {color === 'red'
            ? 'bg-red-700/50'
            : color === 'yellow'
              ? 'bg-yellow-700/50'
              : color === 'green'
                ? 'bg-green-700/50'
                : color === 'blue'
                  ? 'bg-blue-700/50'
                  : color === 'indigo'
                    ? 'bg-indigo-700/50'
                    : color === 'purple'
                      ? 'bg-purple-700/50'
                      : color === 'pink'
                        ? 'bg-pink-700/50'
                        : 'bg-darkbg/50'}"
          style:width={size + 'px'}
          style:height={size + 'px'}
          style:minWidth={size + 'px'}
          class:rounded-md={!rounded}
          class:rounded-full={rounded}>
        </div>
      {:then resolvedBgImg}
        <div
          class="bg-skin-border sidebar-avatar rounded-md bg-top flex items-center justify-center {color === 'red'
            ? 'bg-red-700/50'
            : color === 'yellow'
              ? 'bg-yellow-700/50'
              : color === 'green'
                ? 'bg-green-700/50'
                : color === 'blue'
                  ? 'bg-blue-700/50'
                  : color === 'indigo'
                    ? 'bg-indigo-700/50'
                    : color === 'purple'
                      ? 'bg-purple-700/50'
                      : color === 'pink'
                        ? 'bg-pink-700/50'
                        : 'bg-darkbg/50'}"
          style:width={size + 'px'}
          style:height={size + 'px'}
          style:minWidth={size + 'px'}
          style:background-image={resolvedBgImg ? `url('${resolvedBgImg}')` : undefined}
          style:background-size={resolvedBgImg ? 'cover' : undefined}
          style:background-position={resolvedBgImg ? 'center' : undefined}
          class:rounded-md={!rounded}
          class:rounded-full={rounded}>
          {#if !resolvedBgImg}
            {@render children?.()}
          {/if}
        </div>
      {/await}
    {:else}
      {#await src}
        {@render fallback()}
      {:then img}
        {#if img && !imageFailed}
          <img
            src={img}
            class="bg-skin-border sidebar-avatar object-cover object-top"
            style:width={size + 'px'}
            style:height={size + 'px'}
            style:minWidth={size + 'px'}
            class:rounded-md={!rounded}
            class:rounded-full={rounded}
            alt=""
            aria-hidden="true"
            onerror={() => (imageFailed = true)} />
        {:else}
          {@render fallback()}
        {/if}
      {/await}
    {/if}
  {:else}
    {@render fallback()}
  {/if}
</button>
