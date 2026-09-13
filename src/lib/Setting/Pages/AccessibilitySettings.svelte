<script lang="ts">
  import { language } from 'src/lang'
  import { navigate } from 'src/ts/router'
  import { accessibilitySettingsSections } from 'src/ts/setting/accessibilitySettingsData'
  import SettingsSections from '../SettingsSections.svelte'
</script>

<h2 class="mb-4 mt-2 text-2xl font-bold">{language.settingsNavAccessibility}</h2>

<SettingsSections sections={accessibilitySettingsSections} />

<a
  class="mt-6 text-primary-400 underline hover:text-primary-300"
  href="/settings/display"
  onclick={(event) => {
    event.preventDefault()
    navigate('/settings/display')
  }}>{language.accessibilityDisplaySettingsLink}</a>
