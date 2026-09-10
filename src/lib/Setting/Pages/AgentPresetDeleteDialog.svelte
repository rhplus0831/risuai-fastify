<script lang="ts">
  import { Trash2Icon, XIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import { modalBackdropDismiss } from 'src/ts/gui/modalBackdropDismiss'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'
  import type { AgentPresetDeleteImpactResult, AgentPresetPostDeleteSelection } from 'src/ts/agentPresetDeletionImpact'

  interface Props {
    impact: AgentPresetDeleteImpactResult
    busy?: boolean
    error?: string
    onRetry: () => void
    onConfirm: () => void | Promise<void>
    onCancel: () => void
  }

  const VISIBLE_OWNER_LIMIT = 5
  let { impact, busy = false, error = '', onRetry, onConfirm, onCancel }: Props = $props()

  function requestClose(): void {
    if (!busy) onCancel()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    requestClose()
  }

  function postDeleteLabel(selection: AgentPresetPostDeleteSelection): string {
    return selection.source === 'globalDefault'
      ? language.agentPresets.deleteImpactFallbackGlobal(selection.presetName)
      : language.agentPresets.deleteImpactFallbackNone
  }

  function unavailableOwner(): string {
    if (impact.status === 'ready') return ''
    if (impact.owner === 'characters') return language.agentPresets.deleteImpactOwnerChats
    if (impact.owner === 'loadouts') return language.agentPresets.deleteImpactOwnerLoadouts
    return language.agentPresets.deleteImpactOwnerSettings
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  use:modalBackdropDismiss={requestClose}
  data-modal-root
  role="presentation"
  class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
  data-risu-agent-preset-delete-dialog>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    use:modalFocusTrap
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="agent-preset-delete-title"
    aria-describedby="agent-preset-delete-description"
    tabindex="-1"
    onkeydown={handleKeydown}
    onclick={(event) => event.stopPropagation()}
    class="max-h-[min(42rem,calc(100dvh-2rem))] w-full max-w-2xl overflow-y-auto rounded-md border border-red-600 bg-bgcolor text-textcolor shadow-xl">
    <header class="flex items-start gap-3 border-b border-darkborderc p-4">
      <Trash2Icon class="mt-1 shrink-0 text-draculared" aria-hidden="true" />
      <div class="min-w-0 grow">
        <h3 id="agent-preset-delete-title" class="text-lg font-semibold">
          {impact.status === 'ready'
            ? language.agentPresets.deletePreviewTitle(impact.presetName)
            : language.agentPresets.deletePreviewUnavailableTitle}
        </h3>
        <p id="agent-preset-delete-description" class="mt-1 text-sm text-textcolor2">
          {language.agentPresets.deletePreviewDescription}
        </p>
      </div>
      <Button
        size="sm"
        styled="outlined"
        className="min-h-11 min-w-11"
        disabled={busy}
        ariaLabel={language.close}
        onclick={requestClose}><XIcon size={16} /></Button>
    </header>

    <div class="space-y-3 p-4">
      {#if error}<div role="alert" class="rounded-md border border-draculared p-3 text-sm text-draculared">
          {error}
        </div>{/if}
      {#if impact.status === 'unavailable'}
        <div class="rounded-md border border-yellow-600 p-3" data-risu-agent-preset-delete-unavailable>
          <h4 class="font-semibold">{language.agentPresets.deleteImpactUnavailable}</h4>
          <p class="mt-1 text-sm text-textcolor2">
            {language.agentPresets.deleteImpactUnavailableDetail(unavailableOwner())}
          </p>
          <Button className="mt-3" styled="outlined" disabled={busy} onclick={onRetry}>
            {language.agentPresets.deleteImpactRetry}
          </Button>
        </div>
      {:else}
        <section class="rounded-md border border-darkborderc p-3" data-risu-agent-preset-delete-default>
          <h4 class="font-semibold">{language.agentPresets.deleteImpactGlobalDefault}</h4>
          <p class="mt-1 text-sm text-textcolor2">
            {impact.globalDefault.affected
              ? language.agentPresets.deleteImpactDefaultCleared(
                  postDeleteLabel(impact.globalDefault.postDeleteSelection),
                )
              : impact.globalDefault.beforePresetName
                ? language.agentPresets.deleteImpactDefaultUnchanged(impact.globalDefault.beforePresetName)
                : language.agentPresets.deleteImpactNoGlobalDefault}
          </p>
        </section>

        <section class="rounded-md border border-darkborderc p-3" data-risu-agent-preset-delete-chats>
          <h4 class="font-semibold">{language.agentPresets.deleteImpactChats(impact.chats.length)}</h4>
          {#if impact.chats.length === 0}
            <p class="mt-1 text-sm text-textcolor2">{language.agentPresets.deleteImpactNoChats}</p>
          {:else}
            <ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
              {#each impact.chats.slice(0, VISIBLE_OWNER_LIMIT) as chat (chat.chatId)}
                <li>
                  {chat.characterName} / {chat.chatName} → {postDeleteLabel(chat.postDeleteSelection)}
                </li>
              {/each}
            </ul>
            {#if impact.chats.length > VISIBLE_OWNER_LIMIT}<p class="mt-2 text-sm text-textcolor2">
                {language.agentPresets.deleteImpactMore(impact.chats.length - VISIBLE_OWNER_LIMIT)}
              </p>{/if}
          {/if}
        </section>

        <section class="rounded-md border border-darkborderc p-3" data-risu-agent-preset-delete-loadouts>
          <h4 class="font-semibold">{language.agentPresets.deleteImpactLoadouts(impact.loadouts.length)}</h4>
          {#if impact.loadouts.length === 0}
            <p class="mt-1 text-sm text-textcolor2">{language.agentPresets.deleteImpactNoLoadouts}</p>
          {:else}
            <ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
              {#each impact.loadouts.slice(0, VISIBLE_OWNER_LIMIT) as loadout (loadout.loadoutId)}
                <li>{loadout.loadoutName} → {language.agentPresets.deleteImpactFallbackNone}</li>
              {/each}
            </ul>
            {#if impact.loadouts.length > VISIBLE_OWNER_LIMIT}<p class="mt-2 text-sm text-textcolor2">
                {language.agentPresets.deleteImpactMore(impact.loadouts.length - VISIBLE_OWNER_LIMIT)}
              </p>{/if}
          {/if}
        </section>
      {/if}
    </div>

    <footer class="flex items-center justify-end gap-2 border-t border-darkborderc p-4">
      <Button styled="outlined" disabled={busy} onclick={requestClose}>{language.agentPresets.cancel}</Button>
      <Button
        styled="danger"
        disabled={busy || impact.status !== 'ready'}
        ariaLabel={impact.status === 'ready' ? language.agentPresets.confirmDeletePreset(impact.presetName) : undefined}
        onclick={onConfirm}>
        <span class="inline-flex items-center gap-2">
          <Trash2Icon size={16} />
          {busy ? language.agentPresets.deleting : language.agentPresets.deletePermanently}
        </span>
      </Button>
    </footer>
  </div>
</div>
