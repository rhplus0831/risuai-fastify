<script lang="ts">
  import { onMount } from 'svelte'
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import { downloadFile } from 'src/ts/globalApi.svelte'
  import {
    configureClientDiagnostics,
    getClientDiagnosticsSnapshot,
    subscribeClientDiagnostics,
  } from 'src/ts/diagnostics'
  import {
    buildDiagnosticsReport,
    diagnosticEntryText,
    diagnosticEntryFacts,
    fetchClientDiagnostics,
    mergeDiagnosticsEntries,
    type DiagnosticReportEntry,
  } from 'src/ts/server/clientDiagnostics'
  import { getBrowserDiagnosticsSnapshot, subscribeBrowserDiagnostics } from 'src/ts/server/browserDiagnostics'
  import type { RemoteDiagnosticsResponseV2 } from '@risuai/protocol/remote-diagnostics'

  let snapshot = $state(getClientDiagnosticsSnapshot())
  let browserSnapshot = $state(getBrowserDiagnosticsSnapshot())
  let serverEntries = $state<DiagnosticReportEntry[]>([])
  let remote = $state<RemoteDiagnosticsResponseV2 | undefined>()
  let serverStatus = $state<'current' | 'unavailable'>('unavailable')
  let busy = $state(false)
  let feedback = $state('')
  let report = $state('')
  let errorsOnly = $state(false)
  let controller: AbortController | undefined
  let disposed = false
  const recent = $derived(
    mergeDiagnosticsEntries(browserSnapshot.enabled ? browserSnapshot.entries : snapshot.entries, serverEntries)
      .filter((entry) => !errorsOnly || diagnosticEntryFacts(entry).level !== 'info')
      .reverse(),
  )

  async function refresh(): Promise<void> {
    controller?.abort()
    const request = new AbortController()
    controller = request
    const timeout = setTimeout(() => request.abort(), 5_000)
    try {
      const result = await fetchClientDiagnostics(request.signal, browserSnapshot.enabled)
      if (disposed || controller !== request || request.signal.aborted) return
      if (result.version === 1 && !result.enabled) {
        configureClientDiagnostics(undefined)
        serverEntries = []
        return
      }
      serverEntries = result.entries
      remote = result.version === 2 ? result : undefined
      serverStatus = 'current'
    } catch {
      if (!disposed && controller === request) serverStatus = 'unavailable'
    } finally {
      clearTimeout(timeout)
    }
  }

  async function act(action: 'refresh' | 'download' | 'copy'): Promise<void> {
    if (busy || !snapshot.enabled) return
    busy = true
    feedback = ''
    try {
      await refresh()
      if (disposed || !snapshot.enabled) return
      if (action === 'refresh') return
      const browser = getBrowserDiagnosticsSnapshot()
      report = buildDiagnosticsReport(
        browser.enabled ? browser.entries : getClientDiagnosticsSnapshot().entries,
        serverEntries,
        serverStatus,
        remote,
      )
      if (action === 'download') {
        await downloadFile('risuai-diagnostics.txt', new TextEncoder().encode(report))
      } else {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
          await navigator.clipboard.writeText(report)
          feedback = language.diagnostics.copied
        } catch {
          feedback = language.diagnostics.copyFallback
        }
      }
    } catch {
      feedback = language.diagnostics.exportFailed
    } finally {
      if (!disposed) busy = false
    }
  }

  onMount(() => {
    const unsubscribe = subscribeClientDiagnostics(() => {
      snapshot = getClientDiagnosticsSnapshot()
      if (!snapshot.enabled) {
        controller?.abort()
        controller = undefined
        serverEntries = []
        remote = undefined
        report = ''
      }
    })
    const unsubscribeBrowser = subscribeBrowserDiagnostics(() => {
      const previous = browserSnapshot
      browserSnapshot = getBrowserDiagnosticsSnapshot()
      if (previous.enabled && (!browserSnapshot.enabled || previous.sourceId !== browserSnapshot.sourceId)) {
        controller?.abort()
        controller = undefined
        serverEntries = []
        remote = undefined
        report = ''
      }
    })
    if (snapshot.enabled) void act('refresh')
    return () => {
      disposed = true
      controller?.abort()
      unsubscribe()
      unsubscribeBrowser()
    }
  })
</script>

<section class="my-5 min-w-0 rounded-lg border border-darkborderc p-4" aria-labelledby="diagnostics-title">
  <h3 id="diagnostics-title" class="text-lg font-semibold">{language.diagnostics.title}</h3>
  {#if !snapshot.enabled}
    <p class="mt-2 text-sm text-textcolor2">{language.diagnostics.disabled}</p>
  {:else}
    <p class="mt-2 text-sm text-textcolor2">{language.diagnostics.description}</p>
    <div class="my-3 flex flex-wrap gap-2">
      <Button disabled={busy} onclick={() => act('refresh')}>{language.diagnostics.refresh}</Button>
      <Button disabled={busy} onclick={() => act('download')}>{language.diagnostics.download}</Button>
      <Button disabled={busy} onclick={() => act('copy')}>{language.diagnostics.copy}</Button>
    </div>
    <p role="status" class="text-sm text-textcolor2">
      {busy
        ? language.diagnostics.loading
        : serverStatus === 'unavailable'
          ? language.diagnostics.serverUnavailable
          : ''}
      {feedback}
    </p>
    <details class="mt-3">
      <summary class="cursor-pointer py-2">{language.diagnostics.recent(recent.length)}</summary>
      <label class="my-2 flex items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={errorsOnly} />
        {language.diagnostics.errorsOnly}
      </label>
      <div class="max-h-96 overflow-y-auto" aria-live="off">
        {#if recent.length === 0}
          <p class="py-3 text-sm text-textcolor2">{language.diagnostics.empty}</p>
        {/if}
        {#each recent as entry}
          <pre class="whitespace-pre-wrap break-all border-b border-darkborderc py-2 text-xs">{diagnosticEntryText(
              entry,
            )}</pre>
        {/each}
      </div>
    </details>
    {#if report}
      <label class="mt-3 block text-sm" for="diagnostics-report">{language.diagnostics.report}</label>
      <textarea
        id="diagnostics-report"
        class="mt-1 h-40 w-full min-w-0 rounded border border-darkborderc bg-darkbg p-2 text-xs"
        readonly
        value={report}
        onclick={(event) => event.currentTarget.select()}></textarea>
    {/if}
  {/if}
</section>
