<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { language } from '../lang'
  import {
    clientSessionStore,
    getClientSessionSnapshot,
    captureClientSessionGeneration,
    isClientSessionGenerationCurrent,
  } from '../ts/clientSession'
  import { readDraftRecoveryScope } from '../ts/server/draftRecoveryScope'
  import {
    clearWriterDraftRecoveryView,
    discardWriterDraft,
    loadWriterDrafts,
    readWriterDraft,
    writerDraftRecoveryStore,
    type WriterDraftRecord,
  } from '../ts/server/writerDraftRecovery'
  import { navigate } from '../ts/router'

  let open = $state(false)
  let copied = $state('')
  let shownSecrets = $state<Record<string, boolean>>({})
  let trigger: HTMLButtonElement | undefined = $state()
  let closeButton: HTMLButtonElement | undefined = $state()
  let loadedScope = ''
  let viewRequest = 0
  let mounted = true

  function currentScopeKey(session = getClientSessionSnapshot()): string | null {
    const scope = readDraftRecoveryScope()
    if (!scope) return null
    if (
      session.managed &&
      (!session.authenticated ||
        session.lifecycle === 'auth-required' ||
        session.databaseLineage !== scope.databaseLineage ||
        session.sessionId !== scope.writerSessionId)
    )
      return null
    return JSON.stringify([scope.databaseLineage, scope.writerSessionId, session.generation])
  }

  $effect(() => {
    // Scope initialization accompanies a managed session transition. The scope
    // itself is nonreactive; show() also validates it before opening any view.
    const key = currentScopeKey($clientSessionStore)
    if (!key) {
      clearWriterDraftRecoveryView()
      close(false)
      loadedScope = ''
      return
    }
    if (key === loadedScope) return
    loadedScope = key
    close(false)
    void loadWriterDrafts()
  })

  $effect(() => {
    if (
      open &&
      !$writerDraftRecoveryStore.drafts.length &&
      !$writerDraftRecoveryStore.storageFailed &&
      !$writerDraftRecoveryStore.loading
    )
      close(false)
  })

  onDestroy(() => {
    mounted = false
    viewRequest += 1
  })

  async function show(): Promise<void> {
    const scope = currentScopeKey()
    if (!scope) {
      close(false)
      clearWriterDraftRecoveryView()
      return
    }
    const request = ++viewRequest
    const generation = captureClientSessionGeneration()
    shownSecrets = {}
    copied = ''
    open = true
    await loadWriterDrafts()
    await tick()
    if (
      !mounted ||
      request !== viewRequest ||
      !open ||
      !isClientSessionGenerationCurrent(generation) ||
      currentScopeKey() !== scope
    )
      return
    closeButton?.focus()
  }

  function close(restoreFocus = true): void {
    viewRequest += 1
    open = false
    copied = ''
    shownSecrets = {}
    if (restoreFocus) trigger?.focus()
  }

  function isCurrentDraft(draft: WriterDraftRecord): boolean {
    return mounted && open && currentScopeKey() !== null && readWriterDraft(draft.key)?.generation === draft.generation
  }

  async function copy(draft: WriterDraftRecord, text: string): Promise<void> {
    if (!isCurrentDraft(draft)) return
    const generation = captureClientSessionGeneration()
    const request = viewRequest
    let result: string
    try {
      await navigator.clipboard.writeText(text)
      result = language.connectedReaders.localCopyCopied
    } catch {
      result = language.connectedReaders.localCopyCopyFailed
    }
    if (request === viewRequest && isClientSessionGenerationCurrent(generation) && isCurrentDraft(draft))
      copied = result
  }

  function toggleSecret(draft: WriterDraftRecord, key: string): void {
    if (isCurrentDraft(draft)) shownSecrets[key] = !shownSecrets[key]
  }

  function exportDraft(draft: WriterDraftRecord): void {
    if (!isCurrentDraft(draft)) return
    const blob = new Blob(
      [JSON.stringify({ fields: draft.fields, data: draft.data, baseline: draft.baseline }, null, 2)],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'local-edits.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function localRoute(route: string | undefined): string | null {
    if (!route?.startsWith('/') || route.startsWith('//') || route.includes('\\')) return null
    try {
      return new URL(route, window.location.href).origin === window.location.origin ? route : null
    } catch {
      return null
    }
  }

  function openLocation(draft: WriterDraftRecord): void {
    if (!isCurrentDraft(draft)) return
    const route = localRoute(draft.route)
    if (!route) return
    navigate(route)
    close()
  }

  function discard(draft: WriterDraftRecord): void {
    if (isCurrentDraft(draft)) void discardWriterDraft(draft.generation)
  }
</script>

{#if $writerDraftRecoveryStore.drafts.length > 0 || $writerDraftRecoveryStore.storageFailed}
  <div class="fixed bottom-3 right-3 z-50 max-w-[calc(100vw-1.5rem)]" data-writer-draft-recovery>
    {#if open}
      <div
        role="dialog"
        tabindex="-1"
        aria-label={language.connectedReaders.localEditsTitle}
        class="mb-2 max-h-[75vh] w-[min(32rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-textcolor/30 bg-bgcolor p-4 text-textcolor shadow-xl"
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}>
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg font-semibold">{language.connectedReaders.localEditsTitle}</h2>
          <button
            bind:this={closeButton}
            type="button"
            class="rounded border border-textcolor/30 px-3 py-1"
            onclick={() => close()}>{language.close}</button>
        </div>
        <p class="my-3 text-sm text-textcolor2">{language.connectedReaders.localEditsHelp}</p>
        {#if $writerDraftRecoveryStore.storageFailed}
          <p class="my-3 text-sm" role="alert">{language.connectedReaders.localCopyStorageFailed}</p>
        {/if}
        <p class="text-sm" role="status" aria-live="polite">{copied}</p>
        {#each $writerDraftRecoveryStore.drafts as draft (draft.generation)}
          <details class="my-3 rounded border border-textcolor/20 p-3" data-writer-draft-key={draft.key}>
            <summary class="cursor-pointer font-semibold">{draft.label}</summary>
            {#each draft.fields as field, index}
              {@const key = `${draft.generation}:${index}`}
              <div class="mt-3">
                <label class="block text-sm" for={`writer-draft-${key}`}>{field.label}</label>
                {#if field.secret}
                  <input
                    id={`writer-draft-${key}`}
                    type={shownSecrets[key] ? 'text' : 'password'}
                    readonly
                    value={field.value}
                    class="mt-1 w-full rounded border border-textcolor/20 bg-transparent p-2" />
                  <button
                    type="button"
                    class="mr-2 mt-1 rounded border border-textcolor/30 px-2 py-1 text-sm"
                    onclick={() => toggleSecret(draft, key)}
                    >{shownSecrets[key]
                      ? language.connectedReaders.hideSecret
                      : language.connectedReaders.showSecret}</button>
                {:else}
                  <textarea
                    id={`writer-draft-${key}`}
                    readonly
                    value={field.value}
                    rows={3}
                    class="mt-1 w-full resize-y rounded border border-textcolor/20 bg-transparent p-2"></textarea>
                {/if}
                <button
                  type="button"
                  class="mt-1 rounded border border-textcolor/30 px-2 py-1 text-sm"
                  onclick={() => void copy(draft, field.value)}>{language.copy}</button>
              </div>
            {/each}
            <div class="mt-3 flex flex-wrap gap-2 text-sm">
              {#if localRoute(draft.route)}
                <button
                  type="button"
                  class="rounded border border-textcolor/30 px-2 py-1"
                  onclick={() => openLocation(draft)}>{language.connectedReaders.openDraftLocation}</button>
              {/if}
              <button
                type="button"
                class="rounded border border-textcolor/30 px-2 py-1"
                onclick={() => exportDraft(draft)}>{language.connectedReaders.exportLocalDraft}</button>
              <button type="button" class="rounded border border-textcolor/30 px-2 py-1" onclick={() => discard(draft)}
                >{language.connectedReaders.discardLocalDraft}</button>
            </div>
          </details>
        {/each}
      </div>
    {/if}
    <button
      bind:this={trigger}
      type="button"
      class="float-right rounded-lg border border-textcolor/30 bg-bgcolor px-3 py-2 text-sm text-textcolor shadow-md"
      aria-expanded={open}
      onclick={() => (open ? close() : void show())}>
      {language.connectedReaders.localEdits($writerDraftRecoveryStore.drafts.length)}
    </button>
  </div>
{/if}
