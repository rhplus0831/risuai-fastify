<script lang="ts">
  import type { Snippet } from 'svelte'
  import ConversationShell from './lib/ConversationShell.svelte'
  import { DynamicGUI } from './ts/stores.svelte'

  let {
    readerMode,
    writerNavigation,
    writerContent,
    writerContentInert = false,
    writerContentBusy = false,
    writerNavigationOpen = false,
    writerNavigationLabel = '',
    onWriterCloseNavigation = () => {},
  }: {
    readerMode: boolean
    writerNavigation?: Snippet
    writerContent?: Snippet
    writerContentInert?: boolean
    writerContentBusy?: boolean
    writerNavigationOpen?: boolean
    writerNavigationLabel?: string
    onWriterCloseNavigation?: () => void
  } = $props()
</script>

<div data-risu-workspace>
  {#if readerMode}
    <div data-testid="read-only-workspace-marker">Read-only workspace</div>
  {:else}
    <ConversationShell
      responsive={$DynamicGUI}
      navigationOpen={writerNavigationOpen}
      navigationLabel={writerNavigationLabel}
      contentInert={writerContentInert}
      contentBusy={writerContentBusy}
      onCloseNavigation={onWriterCloseNavigation}>
      {#snippet navigation()}{@render writerNavigation?.()}{/snippet}
      {@render writerContent?.()}
    </ConversationShell>
  {/if}
</div>
