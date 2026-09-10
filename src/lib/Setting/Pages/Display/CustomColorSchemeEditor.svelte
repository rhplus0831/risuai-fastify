<script lang="ts">
  import { language } from 'src/lang'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import {
    changeColorSchemeType,
    colorSchemeAccessibilityIssues,
    defaultColorScheme,
    exportColorScheme,
    importColorScheme,
    updateCustomColorScheme,
  } from 'src/ts/gui/colorscheme'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
  import { DownloadIcon, HardDriveUploadIcon, TriangleAlertIcon } from '@lucide/svelte'

  const colors = [
    'bgcolor',
    'darkbg',
    'borderc',
    'selected',
    'draculared',
    'darkBorderc',
    'darkbutton',
    'textcolor',
    'textcolor2',
  ] as const

  let displaySettings = $derived(
    settingsResourceState.groupStatuses.display === 'ready' ? settingsResourceState.value : undefined,
  )
  let customColorScheme = $derived(displaySettings?.customColorScheme ?? defaultColorScheme)
  let contrastIssues = $derived(colorSchemeAccessibilityIssues(customColorScheme))

  function setColorSchemeValue(key: (typeof colors)[number], value: string) {
    updateCustomColorScheme({
      ...customColorScheme,
      [key]: value,
    })
  }
</script>

{#if displaySettings?.colorSchemeName === 'custom'}
  <div class="border border-darkborderc p-2 m-2 rounded-md">
    <SelectInput
      className="mt-2"
      value={customColorScheme.type}
      onchange={(e) => {
        changeColorSchemeType((e.target as HTMLInputElement).value as 'light' | 'dark')
      }}>
      <OptionInput value="light">Light</OptionInput>
      <OptionInput value="dark">Dark</OptionInput>
    </SelectInput>

    {#each colors as color}
      <div class="flex items-center mt-2">
        <input
          type="color"
          class="native-color-input"
          value={customColorScheme[color]}
          aria-label={language.colorSchemeFields[color]}
          oninput={(event) => setColorSchemeValue(color, event.currentTarget.value)} />
        <span class="ml-2">{language.colorSchemeFields[color]}</span>
      </div>
    {/each}

    {#if contrastIssues.length > 0}
      <div
        class="mt-3 rounded-md border border-borderc p-3 text-sm"
        role="status"
        aria-live="polite"
        data-risu-custom-color-contrast-warning>
        <p class="m-0 flex items-start gap-2 font-medium">
          <TriangleAlertIcon class="mt-0.5 shrink-0" size={18} aria-hidden="true" />
          <span>{language.customColorContrastWarning(contrastIssues.length)}</span>
        </p>
        <ul class="mb-0 mt-2 pl-5 text-textcolor2">
          {#each contrastIssues as issue}
            <li>{language.colorSchemeContrastIssues[issue]}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="grow flex justify-end">
      <button
        aria-label={`${language.export}: ${language.colorScheme}`}
        class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
        onclick={() => exportColorScheme()}>
        <DownloadIcon size={18} />
      </button>
      <button
        aria-label={`${language.import}: ${language.colorScheme}`}
        class="text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={() => importColorScheme()}>
        <HardDriveUploadIcon size={18} />
      </button>
    </div>
  </div>
{/if}

<style>
  .native-color-input {
    width: 1.8rem;
    height: 1.8rem;
    padding: 0;
    border: 0;
    border-radius: 9999px;
    background: transparent;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
  }

  .native-color-input::-webkit-color-swatch-wrapper {
    padding: 0;
  }

  .native-color-input::-webkit-color-swatch {
    border: 1px solid var(--risu-theme-darkborderc);
    border-radius: 9999px;
  }

  .native-color-input::-moz-color-swatch {
    border: 1px solid var(--risu-theme-darkborderc);
    border-radius: 9999px;
  }
</style>
