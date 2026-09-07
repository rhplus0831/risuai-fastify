<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import { writerDraftValueFields } from 'src/ts/server/writerDraftFields'

  import { DownloadIcon, HardDriveUploadIcon, PlusIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import Help from 'src/lib/Others/Help.svelte'

  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import { exportRegex, importRegexRows } from 'src/ts/process/scripts'
  import RegexList from 'src/lib/SideBars/Scripts/RegexList.svelte'
  import { createServerBackedSettingDraft } from 'src/ts/server/settingsOwner.svelte'
  import {
    ensureClientScriptDefinitionIds,
    watchGlobalScriptOwnerDraft,
  } from 'src/ts/server/scriptDefinitionOwner.svelte'
  import { onDestroy } from 'svelte'

  const globalScriptDraft = createServerBackedSettingDraft(
    'globalscript',
    settingsResourceState.groupStatuses.advanced === 'ready' && Array.isArray(settingsResourceState.value.globalscript)
      ? settingsResourceState.value.globalscript
      : [],
    {
      dispatch: false,
      normalizeDraft: ensureClientScriptDefinitionIds,
    },
  )
  const stopWatchingGlobalScripts = watchGlobalScriptOwnerDraft()
  onDestroy(stopWatchingGlobalScripts)
  onDestroy(
    registerWriterDraftCapture(() => {
      const recovery = globalScriptDraft.captureRecoveryDraft()
      if (!recovery) return null
      const data = { scripts: recovery.value }
      const baseline = { scripts: recovery.baseline }
      return {
        key: 'global-regex',
        label: language.globalRegexScript,
        fields: writerDraftValueFields(data, baseline, { scripts: language.globalRegexScript }),
        data,
        baseline,
      }
    }),
  )
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">
  {language.globalRegexScript}
  <Help key="regexScript" />
</h2>
<RegexList bind:value={globalScriptDraft.value} ownerKey="global" />
<div class="text-textcolor2 mt-2 flex gap-2">
  <button
    type="button"
    aria-label={`${language.add}: ${language.globalRegexScript}`}
    class="font-medium cursor-pointer hover:text-green-500"
    onclick={() => {
      globalScriptDraft.value = ensureClientScriptDefinitionIds([
        ...globalScriptDraft.value,
        {
          comment: '',
          in: '',
          out: '',
          type: 'editinput',
        },
      ])
    }}><PlusIcon /></button>
  <button
    type="button"
    aria-label={`${language.export}: ${language.globalRegexScript}`}
    class="font-medium cursor-pointer hover:text-green-500"
    onclick={() => {
      exportRegex(globalScriptDraft.value)
    }}><DownloadIcon /></button>
  <button
    type="button"
    aria-label={`${language.import}: ${language.globalRegexScript}`}
    class="font-medium cursor-pointer hover:text-green-500"
    onclick={async () => {
      const importedRows = await importRegexRows()
      if (!importedRows || importedRows.length === 0) return
      globalScriptDraft.value = ensureClientScriptDefinitionIds([...globalScriptDraft.value, ...importedRows])
    }}><HardDriveUploadIcon /></button>
</div>
