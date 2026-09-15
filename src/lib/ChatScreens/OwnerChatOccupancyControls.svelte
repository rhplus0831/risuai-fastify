<script lang="ts">
  import { LoaderCircleIcon } from '@lucide/svelte'
  import { onDestroy } from 'svelte'
  import { language } from '../../lang'
  import { clientSessionStore } from '../../ts/clientSession'
  import {
    claimClientChatOccupancy,
    clientChatOccupancyStore,
    projectClientChatOccupancy,
    releaseClientChatOccupancy,
    type ClientChatOccupancyActionResult,
  } from '../../ts/server/chatOccupancy'

  let { chatId }: { chatId: string } = $props()

  interface OwnerOccupancyTarget {
    readonly chatId: string
    readonly sessionId: string
    readonly sessionGeneration: number
    readonly databaseLineage: string
    readonly writerEpoch: number
  }

  interface OwnerOccupancyAction {
    readonly id: number
    readonly kind: 'release' | 'owner'
  }

  let nextActionId = 0
  let destroyed = false
  let action = $state<OwnerOccupancyAction | null>(null)
  let feedback = $state<{ chatId: string; message: string } | null>(null)
  let releasedForOwnerClaim = $state<OwnerOccupancyTarget | null>(null)

  const isCurrentOwner = $derived(
    Boolean(
      $clientSessionStore.sessionId &&
      $clientSessionStore.writer?.sessionId === $clientSessionStore.sessionId &&
      $clientSessionStore.authenticated,
    ),
  )
  const projection = $derived.by(() => {
    void $clientChatOccupancyStore
    return projectClientChatOccupancy(chatId)
  })
  const selfOccupancy = $derived(isCurrentOwner && projection.kind === 'self-owned' ? projection.occupancy : null)
  const pending = $derived.by(() => {
    const current = $clientChatOccupancyStore.pending
    return current && (current.chatId === chatId || current.targetChatId === chatId) ? current.action : null
  })
  const canRetryOwnerClaim = $derived(
    isCurrentOwner && projection.kind === 'available' && targetStillCurrent(releasedForOwnerClaim),
  )
  const releasedWithFeedback = $derived(Boolean(!selfOccupancy && !canRetryOwnerClaim && feedback?.chatId === chatId))
  const visible = $derived(Boolean(selfOccupancy || action || canRetryOwnerClaim || feedback?.chatId === chatId))
  const upgrading = $derived(action?.kind === 'owner' || pending === 'claim')
  const releasing = $derived(action?.kind === 'release' || (action?.kind === 'owner' && pending === 'release'))
  const controlsBusy = $derived(action !== null || pending !== null)
  const ownerScopeKey = $derived(
    `${$clientSessionStore.generation}:${$clientSessionStore.databaseLineage ?? ''}:${$clientSessionStore.sessionId ?? ''}:${$clientSessionStore.writer?.sessionId ?? ''}:${$clientSessionStore.writer?.epoch ?? ''}:${$clientSessionStore.authenticated}`,
  )

  $effect(() => {
    void chatId
    void ownerScopeKey
    action = null
    feedback = null
    releasedForOwnerClaim = null
  })

  onDestroy(() => {
    destroyed = true
    action = null
  })

  function beginAction(kind: OwnerOccupancyAction['kind']): OwnerOccupancyAction {
    const current = { id: ++nextActionId, kind }
    action = current
    return current
  }

  function finishAction(current: OwnerOccupancyAction): void {
    if (action?.id === current.id) action = null
  }

  function actionStillCurrent(current: OwnerOccupancyAction, target: OwnerOccupancyTarget): boolean {
    return !destroyed && action?.id === current.id && targetStillCurrent(target)
  }

  function resultMessage(result: ClientChatOccupancyActionResult, success: string): string {
    const copy = language.connectedReaders.chatOccupancy
    if (result.status === 'ok') return success
    if (result.status === 'error' && result.error === 'chat_occupancy_recovery_blocked') return copy.recoveryBlocked
    return result.status === 'error' ? copy.actionFailed : copy.actionUnavailable
  }

  function captureTarget(): OwnerOccupancyTarget | null {
    const session = $clientSessionStore
    if (
      !session.authenticated ||
      !session.sessionId ||
      !session.databaseLineage ||
      session.writer?.sessionId !== session.sessionId
    ) {
      return null
    }
    return {
      chatId,
      sessionId: session.sessionId,
      sessionGeneration: session.generation,
      databaseLineage: session.databaseLineage,
      writerEpoch: session.writer.epoch,
    }
  }

  function targetStillCurrent(target: OwnerOccupancyTarget | null): boolean {
    if (!target) return false
    const session = $clientSessionStore
    return (
      chatId === target.chatId &&
      session.authenticated &&
      session.sessionId === target.sessionId &&
      session.generation === target.sessionGeneration &&
      session.databaseLineage === target.databaseLineage &&
      session.writer?.sessionId === target.sessionId &&
      session.writer.epoch === target.writerEpoch
    )
  }

  async function releaseCurrentChat(): Promise<void> {
    if (controlsBusy || !selfOccupancy) return
    const target = captureTarget()
    if (!target) return
    const currentAction = beginAction('release')
    feedback = null
    releasedForOwnerClaim = null
    try {
      const result = await releaseClientChatOccupancy(target.chatId)
      if (!actionStillCurrent(currentAction, target)) return
      feedback = {
        chatId: target.chatId,
        message: resultMessage(result, language.connectedReaders.chatOccupancy.releaseSucceeded),
      }
    } finally {
      finishAction(currentAction)
    }
  }

  async function useCurrentChatAsOwner(): Promise<void> {
    if (controlsBusy) return
    const target = captureTarget()
    if (!target) return
    const retryReleasedClaim = canRetryOwnerClaim
    if (!retryReleasedClaim && selfOccupancy?.claimClass !== 'chat_only') return
    const currentAction = beginAction('owner')
    feedback = null
    try {
      if (!retryReleasedClaim) {
        const released = await releaseClientChatOccupancy(target.chatId)
        if (!actionStillCurrent(currentAction, target)) return
        if (released.status !== 'ok') {
          feedback = {
            chatId: target.chatId,
            message: resultMessage(released, language.connectedReaders.chatOccupancy.releaseSucceeded),
          }
          return
        }
        releasedForOwnerClaim = target
      }

      const claimed = await claimClientChatOccupancy(target.chatId)
      if (!actionStillCurrent(currentAction, target)) return
      if (claimed.status === 'ok' && claimed.occupancy.claimClass === 'owner') {
        releasedForOwnerClaim = null
        feedback = {
          chatId: target.chatId,
          message: language.connectedReaders.chatOccupancy.ownerUpgradeSucceeded,
        }
        return
      }
      feedback = {
        chatId: target.chatId,
        message: resultMessage(claimed, language.connectedReaders.chatOccupancy.ownerUpgradeSucceeded),
      }
    } finally {
      finishAction(currentAction)
    }
  }
</script>

{#if visible}
  <section
    class="chat-screen-content-width mb-2 flex flex-wrap items-center gap-3 rounded-md border border-textcolor/20 px-3 py-2 text-sm"
    aria-live="polite"
    data-owner-chat-occupancy
    data-owner-chat-occupancy-class={selfOccupancy?.claimClass ?? (canRetryOwnerClaim ? 'released' : undefined)}>
    <div class="min-w-0 grow">
      <p class="font-medium">
        {releasedWithFeedback
          ? feedback?.message
          : selfOccupancy?.claimClass === 'chat_only'
            ? language.connectedReaders.chatOccupancy.ownerUpgradeRequired
            : language.connectedReaders.chatOccupancy.ownerOccupied}
      </p>
      {#if !releasedWithFeedback}
        <p class="text-xs text-textcolor2">
          {selfOccupancy?.claimClass === 'chat_only' || canRetryOwnerClaim
            ? language.connectedReaders.chatOccupancy.ownerUpgradeRequiredHelp
            : language.connectedReaders.chatOccupancy.ownerOccupiedHelp}
        </p>
      {/if}
      {#if feedback?.chatId === chatId && !releasedWithFeedback}
        <p class="mt-1 text-xs text-textcolor2" role="status" data-owner-occupancy-feedback>{feedback.message}</p>
      {:else if releasedWithFeedback}
        <span class="sr-only" role="status" data-owner-occupancy-feedback>{feedback?.message}</span>
      {/if}
    </div>
    <div class="ml-auto flex flex-wrap gap-2">
      {#if selfOccupancy?.claimClass === 'chat_only' || canRetryOwnerClaim}
        <button
          type="button"
          class="min-h-11 rounded border border-textcolor/25 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={controlsBusy || projection.support !== 'enabled'}
          aria-busy={upgrading}
          data-owner-occupancy-promote
          onclick={() => void useCurrentChatAsOwner()}>
          {#if upgrading}<LoaderCircleIcon class="mr-1 inline animate-spin" size={16} aria-hidden="true" />{/if}
          {upgrading
            ? language.connectedReaders.chatOccupancy.usingAsOwner
            : language.connectedReaders.chatOccupancy.useAsOwner}
        </button>
      {/if}
      {#if selfOccupancy}
        <button
          type="button"
          class="min-h-11 rounded border border-textcolor/25 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={controlsBusy}
          aria-busy={releasing}
          data-owner-occupancy-release
          onclick={() => void releaseCurrentChat()}>
          {#if releasing}<LoaderCircleIcon class="mr-1 inline animate-spin" size={16} aria-hidden="true" />{/if}
          {releasing
            ? language.connectedReaders.chatOccupancy.releasing
            : language.connectedReaders.chatOccupancy.release}
        </button>
      {/if}
    </div>
  </section>
{/if}
