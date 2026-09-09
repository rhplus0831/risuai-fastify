<script lang="ts">
  import { language } from 'src/lang'
  import { advancedSettingsSections } from 'src/ts/setting/advancedSettingsData'
  import SettingsSections from '../SettingsSections.svelte'
</script>

<h2 class="mb-1 mt-2 text-2xl font-bold">{language.advancedSettings}</h2>
<p class="mb-4 text-xs text-draculared">{language.advancedSettingsWarn}</p>

<SettingsSections sections={advancedSettingsSections} />
