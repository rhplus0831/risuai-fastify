<script lang="ts">
  import type { Snippet } from 'svelte'
  import { HomeIcon, LayoutGridIcon, ListIcon, Settings, ShellIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import BarIcon from './BarIcon.svelte'

  let {
    expanded,
    bottom = false,
    disabledReason = '',
    settingsEnabled = true,
    playgroundEnabled = true,
    onToggle,
    onSettings,
    onHome,
    onPlayground,
    onGrid,
    onSettingsIntent = () => {},
    onPlaygroundIntent = () => {},
    onGridIntent = () => {},
    extras,
  }: {
    expanded: boolean
    bottom?: boolean
    disabledReason?: string
    settingsEnabled?: boolean
    playgroundEnabled?: boolean
    onToggle: () => void
    onSettings: () => void
    onHome: () => void
    onPlayground: () => void
    onGrid: () => void
    onSettingsIntent?: () => void
    onPlaygroundIntent?: () => void
    onGridIntent?: () => void
    extras?: Snippet
  } = $props()
</script>

{#if !bottom}
  {@render toggle()}
{/if}
<div
  class="w-full relative text-white"
  class:mt-2={!bottom}
  class:border-b={!bottom}
  class:border-b-selected={!bottom}
  class:border-t={bottom}
  class:border-t-selected={bottom}
  data-risu-hamburger-menu-anchor
  data-risu-hamburger-menu-placement={bottom ? 'bottom' : 'top'}>
  {#if expanded}
    <div
      class="absolute w-20 min-w-20 flex bg-bgcolor flex-col items-center pt-2 z-20 pb-2"
      class:bottom-full={bottom}
      class:border-t={bottom}
      class:border-t-selected={bottom}
      class:rounded-t-md={bottom}
      class:border-b={!bottom}
      class:border-b-selected={!bottom}
      class:rounded-b-md={!bottom}
      data-risu-hamburger-menu>
      <BarIcon
        enabled={settingsEnabled}
        {disabledReason}
        onClick={onSettings}
        onIntent={onSettingsIntent}
        ariaLabel={language.settings}><Settings /></BarIcon>
      <div class="mt-2"></div>
      <BarIcon onClick={onHome} ariaLabel={language.home}><HomeIcon /></BarIcon>
      <div class="mt-2"></div>
      <BarIcon
        enabled={playgroundEnabled}
        {disabledReason}
        onClick={onPlayground}
        onIntent={onPlaygroundIntent}
        ariaLabel={language.playground.playground}><ShellIcon /></BarIcon>
      {@render extras?.()}
      <div class="mt-2"></div>
      <BarIcon onClick={onGrid} onIntent={onGridIntent} ariaLabel={language.grid}><LayoutGridIcon /></BarIcon>
    </div>
  {/if}
</div>
{#if bottom}
  {@render toggle()}
{/if}

{#snippet toggle()}
  <button
    type="button"
    aria-label={language.menu}
    aria-expanded={expanded}
    class="ml-3 flex h-8 min-h-8 w-14 min-w-14 cursor-pointer self-start text-white mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-blue-500"
    class:mb-2={bottom}
    onclick={onToggle}
    data-risu-hamburger-menu-toggle><ListIcon /></button>
{/snippet}
