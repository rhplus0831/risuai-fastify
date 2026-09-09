<script lang="ts">
  import { language } from 'src/lang'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import {
    displayChatSettingsSections,
    displayLayoutSettingsSections,
    displaySoundSettingsSections,
    displayThemeSettingsSections,
  } from 'src/ts/setting/displaySettingsData.svelte'
  import { reconcileLegacyGuiSubmenu } from 'src/ts/setting/legacyGuiLayout'
  import SettingsSections from '../SettingsSections.svelte'

  let submenu = $state(0)

  $effect(() => {
    if (settingsResourceState.groupStatuses.display !== 'ready') {
      submenu = -1
      return
    }
    submenu = reconcileLegacyGuiSubmenu(Boolean(settingsResourceState.value.useLegacyGUI), submenu)
  })
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.display}</h2>

{#if submenu !== -1}
  <div class="mb-4 flex w-full overflow-x-auto rounded-md border border-darkborderc">
    <button
      type="button"
      aria-pressed={submenu === 0}
      onclick={() => {
        submenu = 0
      }}
      class="min-w-28 flex-1 border-r border-darkborderc p-3"
      class:bg-darkbutton={submenu === 0}>
      <span>{language.theme}</span>
    </button>
    <button
      type="button"
      aria-pressed={submenu === 1}
      onclick={() => {
        submenu = 1
      }}
      class="min-w-32 flex-1 border-r border-darkborderc p-3"
      class:bg-darkbutton={submenu === 1}>
      <span>{language.settingsTabLayoutSizing}</span>
    </button>
    <button
      type="button"
      aria-pressed={submenu === 2}
      onclick={() => {
        submenu = 2
      }}
      class="min-w-32 flex-1 border-r border-darkborderc p-3"
      class:bg-darkbutton={submenu === 2}>
      <span>{language.settingsTabChatAppearance}</span>
    </button>
    <button
      type="button"
      aria-pressed={submenu === 3}
      onclick={() => {
        submenu = 3
      }}
      class="min-w-36 flex-1 p-3"
      class:bg-darkbutton={submenu === 3}>
      <span>{language.settingsTabSoundNotifications}</span>
    </button>
  </div>
{/if}

{#if submenu === 0 || submenu === -1}
  <SettingsSections sections={displayThemeSettingsSections} />
{/if}

{#if submenu === 1 || submenu === -1}
  <SettingsSections sections={displayLayoutSettingsSections} />
{/if}

{#if submenu === 2 || submenu === -1}
  <SettingsSections sections={displayChatSettingsSections} />
{/if}

{#if submenu === 3 || submenu === -1}
  <SettingsSections sections={displaySoundSettingsSections} />
{/if}
