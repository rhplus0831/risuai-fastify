<script lang="ts" module>
  export type ReaderComposerMode =
    | 'unsupported'
    | 'disabled'
    | 'disabled-self-owned'
    | 'identity-unavailable'
    | 'available'
    | 'foreign-owned'
    | 'switch-required'
    | 'normalization-required'
    | 'normalization-elsewhere'
    | 'self-owned'

  export type ReaderComposerPendingAction = 'claim' | 'release' | 'switch' | 'normalize' | null
  export type ReaderComposerAcceptedDraft = () => void
</script>

<script lang="ts">
  import { LoaderCircleIcon, MenuIcon, PaperclipIcon, RefreshCcwIcon, SendIcon, XIcon } from '@lucide/svelte'
  import { language } from '../../lang'

  let {
    mode = 'unsupported',
    occupancyPending = null,
    generationActive = false,
    sendRetained = false,
    rerollTargetMessageId = null,
    draftValue = '',
    draftScopeKey = '',
    feedback = '',
    onClaim = () => {},
    onRelease = () => {},
    onSwitch = () => {},
    onNormalize = () => {},
    onSend = async () => {},
    onReroll = async () => {},
    onStop = async () => {},
    onDraftChange = undefined,
  }: {
    mode?: ReaderComposerMode
    occupancyPending?: ReaderComposerPendingAction
    generationActive?: boolean
    /** An exact staged Send is still durable but its server acceptance is unknown. */
    sendRetained?: boolean
    rerollTargetMessageId?: string | null
    draftValue?: string
    draftScopeKey?: string
    feedback?: string
    onClaim?: () => void | Promise<void>
    onRelease?: () => void | Promise<void>
    onSwitch?: () => void | Promise<void>
    onNormalize?: () => void | Promise<void>
    onSend?: (message: string, accepted: ReaderComposerAcceptedDraft) => void | Promise<void>
    onReroll?: (targetMessageId: string) => void | Promise<void>
    onStop?: () => void | Promise<void>
    onDraftChange?: (value: string) => void
  } = $props()

  const reasonId = 'reader-composer-reason'
  const feedbackId = 'reader-composer-feedback'
  let localDraft = $state('')
  let localDraftScopeKey = $state<string | null>(null)
  let interactionPending = $state<'send' | 'reroll' | 'stop' | null>(null)
  let acceptedSendInFlight = $state(false)
  const canCompose = $derived(mode === 'self-owned' && occupancyPending === null)
  const canControlGeneration = $derived(
    (mode === 'self-owned' || mode === 'disabled-self-owned') && occupancyPending === null,
  )
  const interactionBusy = $derived(interactionPending !== null)
  const submissionBusy = $derived(interactionBusy || acceptedSendInFlight)
  const actionBusy = $derived(occupancyPending !== null)
  const draft = $derived(onDraftChange ? draftValue : localDraft)
  $effect(() => {
    if (onDraftChange || draftScopeKey === localDraftScopeKey) return
    localDraftScopeKey = draftScopeKey
    localDraft = draftValue
  })
  const visibleState = $derived(
    occupancyPending === 'claim'
      ? 'claiming'
      : occupancyPending === 'release'
        ? 'releasing'
        : occupancyPending === 'switch'
          ? 'switching'
          : occupancyPending === 'normalize'
            ? 'normalizing'
            : mode,
  )

  const presentation = $derived.by(() => {
    const copy = language.connectedReaders.chatOccupancy
    switch (mode) {
      case 'disabled':
      case 'disabled-self-owned':
        return { title: copy.disabled, detail: copy.disabledHelp }
      case 'identity-unavailable':
        return { title: copy.identityUnavailable, detail: copy.identityUnavailableHelp }
      case 'available':
        return { title: copy.available, detail: copy.availableHelp }
      case 'foreign-owned':
        return { title: copy.foreignOwned, detail: copy.foreignOwnedHelp }
      case 'switch-required':
        return { title: copy.switchRequired, detail: copy.switchRequiredHelp }
      case 'normalization-required':
        return { title: copy.normalizationRequired, detail: copy.normalizationRequiredHelp }
      case 'normalization-elsewhere':
        return { title: copy.normalizationElsewhere, detail: copy.normalizationElsewhereHelp }
      case 'self-owned':
        return { title: copy.selfOwned, detail: copy.selfOwnedHelp }
      default:
        return { title: copy.unsupported, detail: copy.unsupportedHelp }
    }
  })

  const occupancyAction = $derived.by(() => {
    const copy = language.connectedReaders.chatOccupancy
    switch (mode) {
      case 'available':
        return {
          action: onClaim,
          kind: 'claim' as const,
          label: occupancyPending === 'claim' ? copy.claiming : copy.claim,
        }
      case 'switch-required':
        return {
          action: onSwitch,
          kind: 'switch' as const,
          label: occupancyPending === 'switch' ? copy.switching : copy.switchToChat,
        }
      case 'normalization-required':
        return {
          action: onNormalize,
          kind: 'normalize' as const,
          label: occupancyPending === 'normalize' ? copy.normalizing : copy.keepThisChat,
        }
      case 'self-owned':
      case 'disabled-self-owned':
        return {
          action: onRelease,
          kind: 'release' as const,
          label: occupancyPending === 'release' ? copy.releasing : copy.release,
        }
      default:
        return null
    }
  })

  async function sendDraft(): Promise<void> {
    const message = draft.trim()
    if (!canCompose || submissionBusy || generationActive || sendRetained || !message) return
    interactionPending = 'send'
    let accepted = false
    try {
      await onSend(message, () => {
        if (accepted) return
        accepted = true
        acceptedSendInFlight = true
        if (interactionPending === 'send') interactionPending = null
        if (draft.trim() !== message) return
        if (!onDraftChange) localDraft = ''
      })
    } finally {
      if (interactionPending === 'send') interactionPending = null
      acceptedSendInFlight = false
    }
  }

  async function reroll(): Promise<void> {
    const targetMessageId = rerollTargetMessageId
    if (!canCompose || interactionBusy || generationActive || sendRetained || !targetMessageId) return
    interactionPending = 'reroll'
    try {
      await onReroll(targetMessageId)
    } finally {
      if (interactionPending === 'reroll') interactionPending = null
    }
  }

  async function stop(): Promise<void> {
    if (!canControlGeneration || interactionBusy || !generationActive) return
    interactionPending = 'stop'
    try {
      await onStop()
    } finally {
      if (interactionPending === 'stop') interactionPending = null
    }
  }

  function blockAttachmentTransfer(event: DragEvent | ClipboardEvent): void {
    if ('clipboardData' in event && event.clipboardData && event.clipboardData.files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
  }
</script>

<section
  class="chat-screen-content-width mb-2 mt-2 w-full px-2"
  aria-labelledby={reasonId}
  data-reader-composer
  data-reader-composer-mode={mode}
  ondragover={blockAttachmentTransfer}
  ondrop={blockAttachmentTransfer}>
  <div
    class="mb-2 flex min-h-11 flex-wrap items-center gap-2 rounded-md border border-textcolor/20 px-3 py-2"
    data-reader-chat-occupancy
    data-reader-chat-occupancy-state={visibleState}
    data-state={visibleState}>
    <div class="min-w-0 grow">
      <p id={reasonId} class="text-sm font-medium" data-reader-occupancy-title>{presentation.title}</p>
      <p class="text-xs text-textcolor2" data-reader-occupancy-detail>{presentation.detail}</p>
    </div>
    {#if occupancyAction}
      <button
        type="button"
        class="min-h-11 shrink-0 rounded border border-textcolor/25 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        disabled={actionBusy || interactionBusy}
        aria-busy={actionBusy}
        data-reader-occupancy-claim={occupancyAction.kind === 'claim' ? '' : undefined}
        data-reader-occupancy-release={occupancyAction.kind === 'release' ? '' : undefined}
        data-reader-occupancy-switch={occupancyAction.kind === 'switch' ? '' : undefined}
        data-reader-occupancy-normalize={occupancyAction.kind === 'normalize' ? '' : undefined}
        onclick={() => void occupancyAction?.action()}>
        {#if actionBusy}<LoaderCircleIcon class="mr-1 inline animate-spin" size={16} aria-hidden="true" />{/if}
        {occupancyAction.label}
      </button>
    {/if}
  </div>

  {#if feedback}
    <p
      id={feedbackId}
      class="mb-2 text-sm text-textcolor2"
      role="status"
      aria-live="polite"
      data-reader-feedback
      data-reader-occupancy-feedback>
      {feedback}
    </p>
  {/if}

  <div class="flex w-full items-stretch" data-read-only-composer-row>
    <button
      type="button"
      class="flex min-h-12 w-12 shrink-0 items-center justify-center rounded-l-md border border-darkborderc text-textcolor2 disabled:cursor-not-allowed disabled:opacity-60"
      aria-label={`${language.connectedReaders.attachments}: ${language.connectedReaders.chatOccupancy.unsupportedActions}`}
      title={language.connectedReaders.chatOccupancy.unsupportedActions}
      disabled
      data-reader-composer-attachment>
      <PaperclipIcon size={20} aria-hidden="true" />
    </button>
    <textarea
      value={draft}
      rows="2"
      disabled={!canCompose || submissionBusy || generationActive}
      readonly={!canCompose}
      aria-label={language.messageInput}
      aria-describedby={feedback ? `${reasonId} ${feedbackId}` : reasonId}
      placeholder={canCompose
        ? language.connectedReaders.chatOccupancy.inputPlaceholder
        : language.connectedReaders.composerReadOnly}
      class="min-h-12 min-w-0 grow resize-none border-y border-darkborderc bg-transparent p-2 text-base text-textcolor placeholder:text-sm disabled:cursor-not-allowed disabled:text-textcolor2"
      data-reader-composer-field="message"
      onpaste={blockAttachmentTransfer}
      oninput={(event) => {
        const value = event.currentTarget.value
        if (onDraftChange) onDraftChange(value)
        else localDraft = value
      }}
      onkeydown={(event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        void sendDraft()
      }}></textarea>
    {#if generationActive && canControlGeneration}
      <button
        type="button"
        class="flex min-h-12 w-12 shrink-0 items-center justify-center rounded-r-md border border-darkborderc text-textcolor2 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={interactionPending === 'stop'
          ? language.connectedReaders.chatOccupancy.stopping
          : language.connectedReaders.chatOccupancy.stop}
        title={language.connectedReaders.chatOccupancy.stop}
        disabled={!canControlGeneration || interactionPending === 'reroll' || interactionPending === 'stop'}
        aria-busy={interactionPending === 'stop'}
        data-testid="default-chat-cancel-button"
        data-reader-composer-stop
        onclick={() => void stop()}>
        {#if interactionPending === 'stop'}
          <LoaderCircleIcon class="animate-spin" size={20} aria-hidden="true" />
        {:else}
          <XIcon size={20} aria-hidden="true" />
        {/if}
      </button>
    {:else}
      <button
        type="button"
        class="flex min-h-12 w-12 shrink-0 items-center justify-center rounded-r-md border border-darkborderc text-textcolor2 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={interactionPending === 'send'
          ? language.connectedReaders.chatOccupancy.sending
          : language.hotkeyDesc.send}
        title={canCompose ? language.hotkeyDesc.send : presentation.detail}
        disabled={!canCompose || submissionBusy || sendRetained || draft.trim().length === 0}
        aria-busy={interactionPending === 'send'}
        data-reader-send-retained={sendRetained ? '' : undefined}
        data-reader-composer-send
        onclick={() => void sendDraft()}>
        {#if interactionPending === 'send'}
          <LoaderCircleIcon class="animate-spin" size={20} aria-hidden="true" />
        {:else}
          <SendIcon size={20} aria-hidden="true" />
        {/if}
      </button>
    {/if}
  </div>

  {#if mode !== 'unsupported' && mode !== 'disabled' && mode !== 'identity-unavailable'}
    <div class="mt-2 flex flex-wrap items-center gap-2" data-reader-chat-only-controls>
      <button
        type="button"
        class="flex min-h-11 items-center gap-2 rounded border border-textcolor/20 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!canCompose || submissionBusy || generationActive || sendRetained || !rerollTargetMessageId}
        aria-busy={interactionPending === 'reroll'}
        data-reader-composer-reroll
        onclick={() => void reroll()}>
        {#if interactionPending === 'reroll'}
          <LoaderCircleIcon class="animate-spin" size={16} aria-hidden="true" />
          {language.connectedReaders.chatOccupancy.rerolling}
        {:else}
          <RefreshCcwIcon size={16} aria-hidden="true" />
          {language.connectedReaders.chatOccupancy.reroll}
        {/if}
      </button>
      <button
        type="button"
        class="flex min-h-11 items-center gap-2 rounded border border-textcolor/20 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        disabled
        title={language.connectedReaders.chatOccupancy.unsupportedActions}
        data-reader-composer-menu>
        <MenuIcon size={16} aria-hidden="true" />
        {language.continueResponse}
      </button>
      <p class="min-w-48 grow text-xs text-textcolor2" data-reader-deferred-actions>
        {language.connectedReaders.chatOccupancy.unsupportedActions}
      </p>
    </div>
  {/if}

  <!-- These compatibility fields remain inert. They make delegated handlers,
       shortcuts, and old selectors fail closed without mounting writer owners. -->
  <div hidden aria-hidden="true" data-reader-composer-alternate-controls>
    <textarea disabled readonly data-reader-composer-field="translated"></textarea>
    <textarea disabled readonly data-reader-composer-field="draft"></textarea>
    <textarea disabled readonly data-reader-composer-field="btw"></textarea>
    <button type="button" disabled data-reader-composer-sticker>{language.stickers}</button>
  </div>
</section>
