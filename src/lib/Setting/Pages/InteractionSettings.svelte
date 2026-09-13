<script lang="ts">
  import { language } from 'src/lang'
  import { interactionSettingsSections } from 'src/ts/setting/interactionSettingsData'
  import SettingsSections from '../SettingsSections.svelte'
</script>

<h2 class="mb-4 mt-2 text-2xl font-bold">{language.settingsNavInteraction}</h2>

<SettingsSections sections={interactionSettingsSections} />
