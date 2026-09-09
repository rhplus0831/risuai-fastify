<script lang="ts">
  import { language } from '../lang'
  import { LockKeyholeIcon } from '@lucide/svelte'

  let {
    managed,
    title,
    status,
    result = '',
    switchInProgress = false,
    switchDisabled = false,
    retryAvailable = false,
    retrying = false,
    useButton = $bindable(),
    retryButton = $bindable(),
    onUseThisDevice = () => {},
    onRetryWriter = () => {},
  }: {
    managed: boolean
    title: string
    status: string
    result?: string
    switchInProgress?: boolean
    switchDisabled?: boolean
    retryAvailable?: boolean
    retrying?: boolean
    useButton?: HTMLButtonElement
    retryButton?: HTMLButtonElement
    onUseThisDevice?: () => void
    onRetryWriter?: () => void
  } = $props()
</script>

<aside
  class="fixed z-50 flex max-w-[min(22rem,calc(100vw-2rem))] flex-col items-end gap-1 rounded-md border border-textcolor/20 bg-bgcolor/95 p-2 text-textcolor shadow-lg backdrop-blur"
  data-risu-device-access-action>
  <div>
    <div
      class="flex flex-wrap items-center justify-between gap-2"
      role="status"
      aria-live="polite"
      data-observer-read-only-status>
      <div class="sr-only">
        <h1>{title}</h1>
        <p data-observer-lifecycle-status>{status}</p>
        {#if result}
          <p class="w-full text-sm text-textcolor2" data-reader-writer-switch-result>{result}</p>
        {/if}
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-end gap-2">
      {#if managed}
        <p id="reader-writer-switch-help" class="sr-only">
          {language.connectedReaders.useThisDeviceHelp}
        </p>
        <button
          bind:this={useButton}
          type="button"
          class="flex items-center gap-2 rounded-md border border-yellow-600/60 bg-yellow-600/10 px-3 py-2 text-sm hover:bg-yellow-600/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={`${language.observerShell.readOnlyBadge} — ${language.connectedReaders.useThisDevice}`}
          aria-describedby="reader-writer-switch-help"
          aria-busy={switchInProgress}
          data-reader-use-this-device
          disabled={switchDisabled}
          onclick={() => {
            if (!switchDisabled) onUseThisDevice()
          }}>
          <LockKeyholeIcon size={16} aria-hidden="true" />
          {switchInProgress ? language.connectedReaders.switchingDevice : language.connectedReaders.useThisDevice}
        </button>
      {:else if retryAvailable}
        <button
          bind:this={retryButton}
          type="button"
          class="rounded-md border border-textcolor/30 px-3 py-2 text-sm hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          data-observer-writer-retry
          onclick={onRetryWriter}>
          {language.observerShell.retryWriter}
        </button>
      {:else if retrying}
        <button
          type="button"
          class="cursor-wait rounded-md border border-textcolor/30 px-3 py-2 text-sm opacity-60"
          data-observer-writer-retry
          disabled>
          {language.observerShell.retryingWriter}
        </button>
      {/if}
    </div>
  </div>
</aside>

<style>
  aside {
    top: max(0.75rem, env(safe-area-inset-top));
    right: max(0.75rem, env(safe-area-inset-right));
  }
</style>
