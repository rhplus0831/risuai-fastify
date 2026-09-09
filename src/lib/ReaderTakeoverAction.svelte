<script lang="ts">
  import { language } from '../lang'

  let {
    conversation,
    managed,
    title,
    status,
    result = '',
    switchInProgress = false,
    switchDisabled = false,
    retryAvailable = false,
    retrying = false,
    contentWidth = 900,
    useButton = $bindable(),
    retryButton = $bindable(),
    onUseThisDevice = () => {},
    onRetryWriter = () => {},
  }: {
    conversation: boolean
    managed: boolean
    title: string
    status: string
    result?: string
    switchInProgress?: boolean
    switchDisabled?: boolean
    retryAvailable?: boolean
    retrying?: boolean
    contentWidth?: number
    useButton?: HTMLButtonElement
    retryButton?: HTMLButtonElement
    onUseThisDevice?: () => void
    onRetryWriter?: () => void
  } = $props()
  const normalizedContentWidth = $derived(
    typeof contentWidth === 'number' && Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 900,
  )
</script>

<footer
  class="shrink-0 border-t border-textcolor/15 bg-bgcolor p-3 text-textcolor"
  style:--chat-screen-width={`${normalizedContentWidth}px`}
  data-reader-composer={conversation ? '' : undefined}
  data-risu-shell-bottom-action>
  <div class:reader-conversation-action={conversation}>
    <div
      class="flex flex-wrap items-center justify-between gap-2"
      role="status"
      aria-live="polite"
      data-observer-read-only-status>
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 class="text-sm font-semibold">{title}</h1>
        <p class="text-sm text-textcolor2" data-observer-lifecycle-status>{status}</p>
        {#if result}
          <p class="w-full text-sm text-textcolor2" data-reader-writer-switch-result>{result}</p>
        {/if}
      </div>
      <span class="w-fit rounded-full border border-yellow-600/60 bg-yellow-600/10 px-3 py-1 text-sm">
        {language.observerShell.readOnlyBadge}
      </span>
    </div>

    <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
      {#if conversation}
        <p id="reader-composer-reason" class="text-sm text-textcolor2">
          {language.connectedReaders.composerReadOnly}
        </p>
      {/if}
      {#if managed}
        <p id="reader-writer-switch-help" class="sr-only">
          {language.connectedReaders.useThisDeviceHelp}
        </p>
        <button
          bind:this={useButton}
          type="button"
          class="rounded-md border border-textcolor/30 px-3 py-2 text-sm hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          aria-describedby="reader-writer-switch-help"
          aria-busy={switchInProgress}
          data-reader-use-this-device
          data-reader-composer-takeover
          disabled={switchDisabled}
          onclick={() => {
            if (!switchDisabled) onUseThisDevice()
          }}>
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

    {#if conversation}
      <textarea
        rows="1"
        disabled
        readonly
        aria-label={language.messageInput}
        aria-describedby="reader-composer-reason"
        placeholder={language.connectedReaders.composerReadOnly}
        class="mt-2 block w-full resize-none rounded-md border border-textcolor/15 bg-textcolor/5 px-3 py-3 text-sm text-textcolor2"
      ></textarea>
    {/if}
  </div>
</footer>

<style>
  .reader-conversation-action {
    width: min(var(--chat-screen-width, 900px), 100%);
    margin-inline: auto;
  }
</style>
