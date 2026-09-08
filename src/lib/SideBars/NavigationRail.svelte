<script lang="ts">
  import type { Snippet } from 'svelte'
  let {
    children,
    hidden = false,
    closing = false,
    editMode = false,
  }: {
    children: Snippet
    hidden?: boolean
    closing?: boolean
    editMode?: boolean
  } = $props()
</script>

<div
  class="h-full w-20 min-w-20 shrink-0 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:editMode
  class:risu-sub-sidebar={closing}
  class:risu-sub-sidebar-close={closing}
  class:hidden
  class:flex={!hidden}
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
      width: 5rem;
      min-width: 5rem;
    }
  }
  @keyframes sub-sidebar-transition-close {
    from {
      width: 5rem;
      min-width: 5rem;
      max-width: 5rem;
      right: 0rem;
    }
    to {
      width: 0rem;
      min-width: 0rem;
      max-width: 0rem;
      right: 10rem;
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
