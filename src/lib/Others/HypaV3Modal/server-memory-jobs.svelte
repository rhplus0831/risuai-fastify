<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { RefreshCwIcon, XIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import {
    cancelServerMemoryJob,
    listServerMemoryJobs,
    type ServerMemoryJob,
  } from 'src/ts/process/request/serverMemory'
  import { subscribeServerMemoryJobEvents } from 'src/ts/server/memoryJobEvents'
  import { createMemoryJobRefreshController, type MemoryJobRefreshController } from 'src/ts/server/memoryJobRefresh'
  import {
    memoryJobProjectionStore,
    replaceMemoryJobsForChat,
    selectMemoryJobsForChat,
  } from 'src/ts/server/memoryJobProjection.svelte'

  interface Props {
    chatId: string
  }

  let { chatId }: Props = $props()

  const jobs = $derived(selectMemoryJobsForChat($memoryJobProjectionStore, chatId))
  let loading = $state(false)
  let actionError = $state<string | null>(null)
  let refreshError = $state<string | null>(null)
  const error = $derived(refreshError ?? actionError)
  let cancellingJobInstanceIds = $state(new Set<string>())
  let lastLoadedAt = $state<string | null>(null)
  let refreshController: MemoryJobRefreshController | null = null
  let unsubscribeMemoryEvents: (() => void) | null = null
  let ownerEpoch = 0

  function kindLabel(kind: ServerMemoryJob['kind']): string {
    switch (kind) {
      case 'chunk':
        return 'Chunk'
      case 'embed':
        return 'Embed'
      case 'summarize':
        return 'Summarize'
    }
  }

  function statusClass(status: ServerMemoryJob['status']): string {
    if (status === 'running') return 'text-emerald-300 bg-emerald-950/60 border-emerald-800'
    if (status === 'pending') return 'text-sky-300 bg-sky-950/60 border-sky-800'
    if (status === 'failed') return 'text-rose-300 bg-rose-950/60 border-rose-800'
    if (status === 'completed') return 'text-emerald-300 bg-emerald-950/60 border-emerald-800'
    return 'text-zinc-300 bg-zinc-950/60 border-zinc-700'
  }

  function formatTime(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function setCancelling(instanceId: string, cancelling: boolean): void {
    const next = new Set(cancellingJobInstanceIds)
    if (cancelling) {
      next.add(instanceId)
    } else {
      next.delete(instanceId)
    }
    cancellingJobInstanceIds = next
  }

  function refreshJobs(): Promise<void> {
    return refreshController?.refresh() ?? Promise.resolve()
  }

  function applyJobUpdate(job: ServerMemoryJob): boolean {
    const applied = refreshController?.applyJobUpdate(job) ?? false
    if (applied) {
      refreshError = null
    }
    return applied
  }

  async function cancelJob(job: ServerMemoryJob): Promise<void> {
    if (cancellingJobInstanceIds.has(job.instanceId)) return

    const cancelChatId = chatId
    const cancelOwnerEpoch = ownerEpoch
    const cancelInstanceId = job.instanceId
    setCancelling(cancelInstanceId, true)
    const result = await cancelServerMemoryJob(job.id)

    if (ownerEpoch !== cancelOwnerEpoch || chatId !== cancelChatId) return
    setCancelling(cancelInstanceId, false)

    if (result.status === 'ok') {
      const stillOwnsInstance = jobs.some(
        (current) =>
          current.chatId === cancelChatId && current.id === job.id && current.instanceId === cancelInstanceId,
      )
      if (!stillOwnsInstance || result.job.instanceId !== cancelInstanceId) return
      actionError = null
      applyJobUpdate(result.job)
      return
    }

    actionError =
      result.status === 'unavailable'
        ? 'Server memory jobs are unavailable.'
        : result.status === 'error'
          ? result.error
          : null
    await refreshJobs()
  }

  $effect(() => {
    chatId
    ownerEpoch += 1
    refreshController?.setChatId(chatId)
  })

  onMount(() => {
    refreshController = createMemoryJobRefreshController({
      chatId,
      listJobs: (currentChatId, signal, etag) => listServerMemoryJobs({ chatId: currentChatId, etag }, signal),
      onJobs: (nextJobs, loadedAt, snapshot) => {
        replaceMemoryJobsForChat(chatId, nextJobs, snapshot)
        refreshError = null
        lastLoadedAt = loadedAt
      },
      onError: (message) => {
        refreshError = message
      },
      onClear: () => {
        replaceMemoryJobsForChat(chatId, [])
        actionError = null
        refreshError = null
        lastLoadedAt = null
      },
      onLoading: (nextLoading) => {
        loading = nextLoading
      },
    })
    unsubscribeMemoryEvents = subscribeServerMemoryJobEvents((event) => {
      applyJobUpdate({ chatId: event.chatId, ...event.job })
    })
    void refreshJobs()
  })

  onDestroy(() => {
    ownerEpoch += 1
    unsubscribeMemoryEvents?.()
    unsubscribeMemoryEvents = null
    refreshController?.dispose()
    refreshController = null
  })
</script>

<section class="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3 sm:p-4">
  <div class="flex items-center justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-sm font-semibold text-zinc-200">Server memory jobs</h2>
      <p class="mt-1 text-xs text-zinc-500">
        {#if loading}
          Refreshing...
        {:else if lastLoadedAt}
          Updated {formatTime(lastLoadedAt)}
        {:else}
          Waiting for server status
        {/if}
      </p>
    </div>

    <button
      class="shrink-0 rounded-sm p-2 text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={language.hypaV3Modal.refreshMemoryJobsAction}
      disabled={loading}
      onclick={() => void refreshJobs()}
      title={language.hypaV3Modal.refreshMemoryJobsAction}>
      <RefreshCwIcon class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
    </button>
  </div>

  {#if error}
    <div class="mt-3 rounded-sm border border-rose-900/70 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
      {error}
    </div>
  {/if}
  {#if jobs.length === 0}
    <div class="mt-3 rounded-sm border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-400">
      No pending or running memory jobs.
    </div>
  {:else}
    <div class="mt-3 flex flex-col gap-2">
      {#each jobs as job (job.instanceId)}
        <div
          class="flex flex-col gap-3 rounded-sm border border-zinc-700 bg-zinc-900/70 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium text-zinc-100">{kindLabel(job.kind)}</span>
              <span class="rounded-sm border px-2 py-0.5 text-xs {statusClass(job.status)}">
                {job.status}
              </span>
              <span class="text-xs text-zinc-500">
                attempt {job.attemptCount}/{job.maxAttempts}
              </span>
            </div>
            {#if job.status === 'failed' && job.error}
              <div class="mt-2 whitespace-pre-wrap break-words text-xs text-rose-300" data-memory-job-error>
                {job.error}
              </div>
            {/if}
          </div>

          {#if job.status === 'pending' || job.status === 'running'}
            <button
              class="inline-flex items-center justify-center gap-2 rounded-sm border border-rose-900/80 px-3 py-2 text-sm text-rose-200 transition-colors hover:bg-rose-950/60 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={cancellingJobInstanceIds.has(job.instanceId)}
              onclick={() => void cancelJob(job)}
              title="Cancel job">
              <XIcon class="h-4 w-4" />
              {cancellingJobInstanceIds.has(job.instanceId) ? 'Cancelling' : 'Cancel'}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
