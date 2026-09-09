<script lang="ts">
  import { language } from '../lang'
  import { LockKeyholeIcon } from '@lucide/svelte'

  let {
    title,
    status,
    result = '',
    switchInProgress = false,
    switchDisabled = false,
    useButton = $bindable(),
    onUseThisDevice = () => {},
  }: {
    title: string
    status: string
    result?: string
    switchInProgress?: boolean
    switchDisabled?: boolean
    useButton?: HTMLButtonElement
    onUseThisDevice?: () => void
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
      data-reader-access-status>
      <div class="sr-only">
        <h1>{title}</h1>
        <p data-reader-lifecycle-status>{status}</p>
        {#if result}
          <p class="w-full text-sm text-textcolor2" data-reader-writer-switch-result>{result}</p>
        {/if}
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-end gap-2">
      <p id="reader-writer-switch-help" class="sr-only">
        {language.connectedReaders.useThisDeviceHelp}
      </p>
      <button
        bind:this={useButton}
        type="button"
        class="flex items-center gap-2 rounded-md border border-yellow-600/60 bg-yellow-600/10 px-3 py-2 text-sm hover:bg-yellow-600/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={`${language.readOnlyWorkspace.readOnlyBadge} — ${language.connectedReaders.useThisDevice}`}
        aria-describedby="reader-writer-switch-help"
        aria-busy={switchInProgress}
        data-reader-use-this-device
        disabled={switchDisabled}
        onclick={() => {
          if (!switchDisabled) onUseThisDevice()
        }}>
        <LockKeyholeIcon size={16} aria-hidden="true" />
        <span class="hidden sm:inline">
          {switchInProgress ? language.connectedReaders.switchingDevice : language.connectedReaders.useThisDevice}
        </span>
      </button>
    </div>
  </div>
</aside>

<style>
  aside {
    top: max(0.75rem, env(safe-area-inset-top));
    right: max(0.75rem, env(safe-area-inset-right));
  }
</style>
