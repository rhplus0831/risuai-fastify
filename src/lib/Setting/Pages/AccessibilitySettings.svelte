<script lang="ts">
  import { language } from 'src/lang'
  import { accessibilitySettingsSections } from 'src/ts/setting/accessibilitySettingsData'
  import SettingsSections from '../SettingsSections.svelte'
</script>

<h2 class="mb-4 mt-2 text-2xl font-bold">{language.interactionAccessibility}</h2>

<SettingsSections sections={accessibilitySettingsSections} />
