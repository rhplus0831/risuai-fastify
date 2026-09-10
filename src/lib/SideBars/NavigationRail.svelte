<script lang="ts">
  import type { Snippet } from 'svelte'
  import { normalizeDesktopSidebarColumns } from '@risuai/shared-core/sidebar-columns'
  let {
    children,
    hidden = false,
    closing = false,
    editMode = false,
    columns = 1,
  }: {
    children: Snippet
    hidden?: boolean
    closing?: boolean
    editMode?: boolean
    columns?: number
  } = $props()

  const normalizedColumns = $derived(normalizeDesktopSidebarColumns(columns))
  const railWidth = $derived(`${normalizedColumns * 5}rem`)
  const railCloseOffset = $derived(`${normalizedColumns * 10}rem`)
</script>

<div
  class="relative h-full shrink-0 flex-col items-center overflow-x-hidden overflow-y-auto overscroll-contain bg-bgcolor pb-3 text-textcolor shadow-lg rs-sidebar [scrollbar-width:thin]"
  class:editMode
  class:risu-sub-sidebar={closing}
  class:risu-sub-sidebar-close={closing}
  class:hidden
  class:flex={!hidden}
  style:width={railWidth}
  style:min-width={railWidth}
  style:--risu-navigation-rail-width={railWidth}
  style:--risu-navigation-rail-close-offset={railCloseOffset}
  data-risu-navigation-columns={normalizedColumns}
  data-risu-navigation-rail>
  {@render children()}
</div>

<style>
  .editMode {
    min-width: 6rem;
  }
  @keyframes sub-sidebar-transition {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: var(--risu-navigation-rail-width);
      min-width: var(--risu-navigation-rail-width);
    }
  }
  @keyframes sub-sidebar-transition-close {
    from {
      width: var(--risu-navigation-rail-width);
      min-width: var(--risu-navigation-rail-width);
      max-width: var(--risu-navigation-rail-width);
      right: 0rem;
    }
    to {
      width: 0rem;
      min-width: 0rem;
      max-width: 0rem;
      right: var(--risu-navigation-rail-close-offset);
    }
  }
  .risu-sub-sidebar {
    animation-name: sub-sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sub-sidebar-close {
    animation-name: sub-sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
</style>
