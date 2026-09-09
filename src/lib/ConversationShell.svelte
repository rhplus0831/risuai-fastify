<script lang="ts">
  import type { Snippet } from 'svelte'
  import { modalFocusTrap } from '../ts/gui/modalFocusTrap'

  let {
    navigation,
    children,
    responsive,
    navigationOpen,
    navigationLabel,
    navigationId = 'conversation-shell-navigation',
    showNavigationToggle = false,
    navigationToggleLabel = '',
    preserveResponsiveNavigation = false,
    contentInert = false,
    contentBusy = false,
    onOpenNavigation = () => {},
    onCloseNavigation = () => {},
  }: {
    navigation: Snippet
    children: Snippet
    responsive: boolean
    navigationOpen: boolean
    navigationLabel: string
    navigationId?: string
    showNavigationToggle?: boolean
    navigationToggleLabel?: string
    preserveResponsiveNavigation?: boolean
    contentInert?: boolean
    contentBusy?: boolean
    onOpenNavigation?: () => void
    onCloseNavigation?: () => void
  } = $props()

  function handleNavigationKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCloseNavigation()
  }

  function conditionalModalFocusTrap(node: HTMLElement, enabled: boolean) {
    let trap = enabled ? modalFocusTrap(node) : undefined
    return {
      update(active: boolean) {
        if (active && !trap) trap = modalFocusTrap(node)
        else if (!active && trap) {
          trap.destroy()
          trap = undefined
        }
      },
      destroy() {
        trap?.destroy()
      },
    }
  }
</script>

<div
  class="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-bg text-textcolor"
  data-risu-conversation-shell>
  {#if responsive && showNavigationToggle}
    <button
      type="button"
      class="absolute left-0 top-3 z-20 flex h-12 w-12 items-center justify-center rounded-r-md border border-l-0 border-borderc bg-darkbg text-xl text-textcolor opacity-70 transition-colors hover:opacity-100"
      aria-controls={navigationId}
      aria-expanded={navigationOpen}
      aria-label={navigationToggleLabel}
      onclick={onOpenNavigation}
      data-reader-navigation-toggle>☰</button>
  {/if}

  {#if !responsive && navigationOpen}
    <div id={navigationId} class="contents" data-risu-shell-navigation>
      {@render navigation()}
    </div>
  {:else if responsive && (navigationOpen || preserveResponsiveNavigation)}
    <div
      id={navigationId}
      data-modal-root
      data-risu-responsive-shell="shared-sidebar-dialog"
      data-risu-shell-navigation
      use:conditionalModalFocusTrap={navigationOpen}
      role="dialog"
      aria-modal="true"
      aria-label={navigationLabel}
      tabindex="-1"
      class="fixed left-0 top-0 z-30 flex h-full w-full flex-row items-center"
      class:hidden={!navigationOpen}
      hidden={!navigationOpen}
      onkeydown={handleNavigationKeydown}>
      {@render navigation()}
    </div>
  {/if}

  <div
    class="flex h-full min-h-0 min-w-0 grow"
    data-risu-shell-main
    data-risu-route-content
    inert={contentInert}
    aria-busy={contentBusy}>
    {@render children()}
  </div>
</div>
