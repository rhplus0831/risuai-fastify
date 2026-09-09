<script lang="ts">
  import { onDestroy } from 'svelte'
  import { PlusIcon, TrashIcon, LinkIcon, CodeXmlIcon, PowerIcon, PowerOffIcon, RefreshCwIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import SettingsSections from '../SettingsSections.svelte'
  import { pluginSupplementalSettingsSections } from 'src/ts/setting/pluginSupplementalSettingsData'
  import { alertConfirm, alertSelect } from 'src/ts/alert'

  import { hotReloading } from 'src/ts/stores.svelte'
  import { collectionsResourceState } from 'src/ts/server/resourceState.svelte'
  import {
    checkPluginUpdate,
    createBlankPlugin,
    importPlugin,
    installPluginUpdate,
    type RisuPlugin,
  } from 'src/ts/plugins/plugins.svelte'
  import {
    deletePlugin,
    setPluginArgument,
    togglePluginEnabled,
    type PluginMutationOutcome,
  } from 'src/ts/pluginCommands'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
  import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
  import RadioInput from 'src/lib/UI/GUI/RadioInput.svelte'
  import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
  import { hotReloadPluginFiles, type PluginHotReloadSession } from 'src/ts/plugins/apiV3/developMode'

  let expandedPluginNames = $state<string[]>([])
  let nextPluginMutationSequence = 0
  let nextPluginImportSequence = 0
  let developModeRequestSequence = 0
  let destroyed = false
  let hotReloadSession: PluginHotReloadSession | null = null

  interface PluginMutationUiState {
    sequence: number
    status: 'saving' | 'queued' | 'failed'
  }

  let pluginMutationStates = $state<Record<string, PluginMutationUiState>>({})
  let pluginImportStatus = $state<'idle' | 'saving' | 'queued' | 'failed'>('idle')

  type PluginUpdateUiStatus =
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'denied'
    | 'failed'
    | 'installing'
    | 'queued'
    | 'install-failed'
    | 'installed'

  interface PluginUpdateUiState {
    script: string
    updateURL: string
    versionOfPlugin: string
    status: PluginUpdateUiStatus
    availableVersion?: string
  }

  let pluginUpdateStates = $state<Record<string, PluginUpdateUiState>>({})

  function findPluginByName(pluginName: string): { plugin: RisuPlugin; index: number } | null {
    if (collectionsResourceState.statuses.plugins !== 'ready') return null
    const plugins = readPlugins(collectionsResourceState.values.plugins)
    const index = plugins.findIndex((candidate) => candidate.name === pluginName)
    if (index === -1) return null
    return { plugin: plugins[index], index }
  }

  function readPlugins(value: unknown): RisuPlugin[] {
    if (!Array.isArray(value)) return []
    const names = new Set<string>()
    for (const plugin of value) {
      if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) return []
      const name = (plugin as { name?: unknown }).name
      if (typeof name !== 'string' || name.trim() !== name || name.length === 0 || names.has(name)) return []
      names.add(name)
    }
    return value as RisuPlugin[]
  }

  let plugins = $derived(
    collectionsResourceState.statuses.plugins === 'ready' ? readPlugins(collectionsResourceState.values.plugins) : [],
  )

  function pluginParamsId(pluginName: string): string {
    return `plugin-params-${pluginName.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  }

  function pluginArgRadioGroup(pluginName: string, arg: string): string {
    return `plugin-arg:${encodeURIComponent(pluginName)}:${encodeURIComponent(arg)}`
  }

  function isPluginExpanded(pluginName: string): boolean {
    return expandedPluginNames.includes(pluginName)
  }

  function togglePluginParams(pluginName: string): void {
    expandedPluginNames = isPluginExpanded(pluginName)
      ? expandedPluginNames.filter((name) => name !== pluginName)
      : [...expandedPluginNames, pluginName]
  }

  function getPluginArg(pluginName: string, arg: string): number | string {
    return findPluginByName(pluginName)?.plugin.realArg?.[arg] ?? ''
  }

  function setPluginArg(pluginName: string, arg: string, value: number | string): void {
    trackPluginMutation(pluginName, setPluginArgument(pluginName, arg, value))
  }

  function trackPluginMutation(pluginName: string, pending: Promise<PluginMutationOutcome> | null): void {
    if (!pending) return
    const sequence = ++nextPluginMutationSequence
    pluginMutationStates[pluginName] = { sequence, status: 'saving' }
    void pending.then((outcome) => {
      if (pluginMutationStates[pluginName]?.sequence !== sequence) return
      if (outcome.status === 'accepted') {
        delete pluginMutationStates[pluginName]
      } else {
        pluginMutationStates[pluginName] = { sequence, status: outcome.status }
        if (outcome.status === 'queued') {
          void outcome.settlement.then((settlement) => {
            if (destroyed || pluginMutationStates[pluginName]?.sequence !== sequence) return
            if (settlement.status === 'accepted') delete pluginMutationStates[pluginName]
            else pluginMutationStates[pluginName] = { sequence, status: 'failed' }
          })
        }
      }
    })
  }

  function pluginMutationStatusText(pluginName: string): string {
    switch (pluginMutationStates[pluginName]?.status) {
      case 'saving':
        return language.pluginMutation.saving
      case 'queued':
        return language.pluginMutation.queued
      case 'failed':
        return language.pluginMutation.failed
      default:
        return ''
    }
  }

  function pluginUpdateStateKey(pluginName: string): string {
    return `plugin:${pluginName}`
  }

  function pluginUpdateState(plugin: RisuPlugin): PluginUpdateUiState {
    const state = pluginUpdateStates[pluginUpdateStateKey(plugin.name)]
    if (
      state?.script === plugin.script &&
      state.updateURL === (plugin.updateURL ?? '') &&
      state.versionOfPlugin === (plugin.versionOfPlugin ?? '')
    ) {
      return state
    }
    return {
      script: plugin.script,
      updateURL: plugin.updateURL ?? '',
      versionOfPlugin: plugin.versionOfPlugin ?? '',
      status: 'idle',
    }
  }

  function setPluginUpdateState(plugin: RisuPlugin, status: PluginUpdateUiStatus, availableVersion?: string): void {
    pluginUpdateStates[pluginUpdateStateKey(plugin.name)] = {
      script: plugin.script,
      updateURL: plugin.updateURL ?? '',
      versionOfPlugin: plugin.versionOfPlugin ?? '',
      status,
      availableVersion,
    }
  }

  function isSamePluginUpdateTarget(left: RisuPlugin, right: RisuPlugin): boolean {
    return (
      left.name === right.name &&
      left.script === right.script &&
      left.updateURL === right.updateURL &&
      left.versionOfPlugin === right.versionOfPlugin
    )
  }

  function pluginUpdateActionLabel(state: PluginUpdateUiState): string {
    switch (state.status) {
      case 'checking':
        return language.pluginCheckingForUpdates
      case 'available':
        return language.pluginInstallUpdateVersion.replace('{}', state.availableVersion ?? '')
      case 'installing':
        return language.pluginInstallingUpdate
      case 'queued':
        return language.pluginMutation.queued
      default:
        return language.pluginCheckForUpdates
    }
  }

  function pluginUpdateStatusText(state: PluginUpdateUiState): string {
    switch (state.status) {
      case 'checking':
        return language.pluginCheckingForUpdates
      case 'available':
        return language.pluginUpdateAvailableVersion.replace('{}', state.availableVersion ?? '')
      case 'up-to-date':
        return language.pluginUpToDate
      case 'denied':
        return language.pluginUpdatePermissionDenied
      case 'failed':
        return language.pluginUpdateCheckFailed
      case 'installing':
        return language.pluginInstallingUpdate
      case 'queued':
        return language.pluginMutation.queued
      case 'install-failed':
        return language.pluginUpdateInstallFailed
      case 'installed':
        return language.pluginUpdateInstalled
      default:
        return ''
    }
  }

  async function handlePluginUpdateAction(plugin: RisuPlugin): Promise<void> {
    const state = pluginUpdateState(plugin)
    if (state.status === 'checking' || state.status === 'installing' || state.status === 'queued') return

    if (state.status === 'available') {
      const confirmed = await alertConfirm(language.pluginUpdateFoundInstallIt)
      if (!confirmed) return

      const current = findPluginByName(plugin.name)?.plugin
      if (!current || !isSamePluginUpdateTarget(plugin, current)) {
        delete pluginUpdateStates[pluginUpdateStateKey(plugin.name)]
        return
      }

      setPluginUpdateState(current, 'installing', state.availableVersion)
      const result = await installPluginUpdate(current)
      const latest = findPluginByName(plugin.name)?.plugin
      if (typeof result === 'object' && result.status === 'queued' && latest) {
        const queuedTarget = { ...latest }
        setPluginUpdateState(queuedTarget, 'queued')
        void result.settlement.then((settlement) => {
          if (destroyed) return
          const queuedState = pluginUpdateStates[pluginUpdateStateKey(plugin.name)]
          const settledPlugin = findPluginByName(plugin.name)?.plugin
          if (
            queuedState?.status !== 'queued' ||
            queuedState.script !== queuedTarget.script ||
            queuedState.updateURL !== (queuedTarget.updateURL ?? '') ||
            queuedState.versionOfPlugin !== (queuedTarget.versionOfPlugin ?? '')
          ) {
            return
          }
          if (
            settlement.status === 'accepted' &&
            settledPlugin &&
            isSamePluginUpdateTarget(queuedTarget, settledPlugin)
          ) {
            setPluginUpdateState(settledPlugin, 'installed')
          } else if (
            settlement.status === 'failed' &&
            settledPlugin &&
            isSamePluginUpdateTarget(current, settledPlugin)
          ) {
            setPluginUpdateState(settledPlugin, 'install-failed')
          } else {
            delete pluginUpdateStates[pluginUpdateStateKey(plugin.name)]
          }
        })
      } else if (result === 'installed' && latest) {
        setPluginUpdateState(latest, 'installed')
      } else if (latest && isSamePluginUpdateTarget(current, latest)) {
        setPluginUpdateState(latest, result === 'denied' ? 'denied' : 'install-failed')
      } else {
        delete pluginUpdateStates[pluginUpdateStateKey(plugin.name)]
      }
      return
    }

    const target = { ...plugin }
    setPluginUpdateState(target, 'checking')
    const result = await checkPluginUpdate(target)
    const current = findPluginByName(target.name)?.plugin
    if (!current || !isSamePluginUpdateTarget(target, current)) {
      delete pluginUpdateStates[pluginUpdateStateKey(target.name)]
      return
    }

    switch (result.status) {
      case 'available':
        setPluginUpdateState(current, 'available', result.update.version)
        break
      case 'up-to-date':
        setPluginUpdateState(current, 'up-to-date')
        break
      case 'denied':
        setPluginUpdateState(current, 'denied')
        break
      case 'failed':
        setPluginUpdateState(current, 'failed')
        break
    }
  }

  async function handlePluginImport(): Promise<void> {
    const sequence = ++nextPluginImportSequence
    pluginImportStatus = 'saving'
    const result = await importPlugin()
    if (destroyed || sequence !== nextPluginImportSequence) return

    if (result.status === 'queued') {
      pluginImportStatus = 'queued'
      void result.settlement.then((settlement) => {
        if (destroyed || sequence !== nextPluginImportSequence) return
        pluginImportStatus = settlement.status === 'accepted' ? 'idle' : 'failed'
      })
      return
    }

    pluginImportStatus = result.status === 'failed' ? 'failed' : 'idle'
  }

  function pluginImportStatusText(): string {
    switch (pluginImportStatus) {
      case 'saving':
        return language.pluginMutation.saving
      case 'queued':
        return language.pluginMutation.queued
      case 'failed':
        return language.pluginMutation.failed
      default:
        return ''
    }
  }

  async function handleDevelopModeAction(): Promise<void> {
    const sequence = ++developModeRequestSequence
    const selection = await alertSelect(['Import plugin with hot reload', 'Download plugin template'])
    if (destroyed || sequence !== developModeRequestSequence || selection === null) return

    switch (parseInt(selection)) {
      case 0: {
        const previousSession = hotReloadSession
        hotReloadSession = null
        previousSession?.stop()

        const session = hotReloadPluginFiles()
        hotReloadSession = session
        const clearOwnedSession = () => {
          if (hotReloadSession === session) hotReloadSession = null
        }
        void session.done.then(clearOwnedSession, clearOwnedSession)
        break
      }
      case 1: {
        const a = document.createElement('a')
        a.href = '/plugin_start.7z'
        a.download = 'plugin_starter.7z'
        document.body.appendChild(a)
        a.click()
        a.remove()
        break
      }
    }
  }

  onDestroy(() => {
    destroyed = true
    nextPluginImportSequence++
    developModeRequestSequence++
    const ownedSession = hotReloadSession
    hotReloadSession = null
    ownedSession?.stop()
  })
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.plugin}</h2>

<span class="text-draculared text-xs mb-4">{language.pluginWarn}</span>

<div class="border-solid border-darkborderc p-2 flex flex-col border-1">
  {#if plugins.length === 0}
    <span class="text-textcolor2">{language.noPlugins}</span>
  {/if}
  {#each plugins as plugin, i (plugin.name)}
    {#if i !== 0}
      <div class="border-darkborderc mt-2 mb-2 w-full border-solid border-b-1 seperator"></div>
    {/if}
    <div class="flex gap-2 items-center" aria-busy={pluginMutationStates[plugin.name]?.status === 'saving'}>
      <button
        type="button"
        class="font-bold grow text-left"
        aria-expanded={isPluginExpanded(plugin.name)}
        aria-controls={pluginParamsId(plugin.name)}
        onclick={() => {
          togglePluginParams(plugin.name)
        }}>
        <span>
          {plugin.displayName ?? plugin.name}
        </span>
        {#if hotReloading.includes(plugin.name)}
          <span class="text-sm rounded bg-amber-700 ml-2 px-2 py-1 text-white"> Hot </span>
        {/if}
      </button>
      {#if plugin.customLink}
        {#each plugin.customLink as link}
          {#if typeof link.link === 'string' && (link.link.startsWith('http://') || link.link.startsWith('https://'))}
            <a
              href={link.link}
              aria-label={link.hoverText || `${language.plugin}: ${plugin.displayName ?? plugin.name}`}
              target="_blank"
              rel="nofollow noopener noreferrer"
              class="text-textcolor2 hover:text-textcolor cursor-pointer"
              title={link.hoverText}
              onclick={(e) => {
                e.stopPropagation()
              }}>
              <LinkIcon></LinkIcon>
            </a>
          {/if}
        {/each}
      {/if}

      {#if plugin.updateURL}
        {@const updateState = pluginUpdateState(plugin)}
        <button
          type="button"
          class:text-green-400={updateState.status === 'available'}
          class:textcolor2={updateState.status !== 'available'}
          class="hover:gray-200 cursor-pointer disabled:cursor-wait disabled:opacity-60"
          disabled={updateState.status === 'checking' ||
            updateState.status === 'installing' ||
            updateState.status === 'queued'}
          aria-label={pluginUpdateActionLabel(updateState)}
          title={pluginUpdateActionLabel(updateState)}
          onclick={(e) => {
            e.stopPropagation()
            void handlePluginUpdateAction(plugin)
          }}>
          <RefreshCwIcon
            class={updateState.status === 'checking' || updateState.status === 'installing' ? 'animate-spin' : ''} />
        </button>
      {/if}

      <button
        type="button"
        aria-label={`${language.enable}: ${plugin.displayName ?? plugin.name}`}
        aria-pressed={plugin.enabled}
        disabled={pluginMutationStates[plugin.name]?.status === 'saving'}
        class="textcolor2 hover:gray-200 cursor-pointer"
        onclick={async (e) => {
          e.stopPropagation()
          const pending = togglePluginEnabled(plugin.name)
          if (pending) {
            e.preventDefault()
            trackPluginMutation(plugin.name, pending)
          }
        }}>
        {#if plugin.enabled}
          <PowerIcon />
        {:else}
          <PowerOffIcon />
        {/if}
      </button>

      <button
        type="button"
        aria-label={`${language.remove}: ${plugin.displayName ?? plugin.name}`}
        class="textcolor2 hover:gray-200 cursor-pointer"
        disabled={pluginMutationStates[plugin.name]?.status === 'saving'}
        onclick={async (e) => {
          e.stopPropagation()
          const v = await alertConfirm(language.removeConfirm + (plugin.displayName ?? plugin.name))
          if (v) {
            const pending = deletePlugin(plugin.name)
            if (pending) {
              expandedPluginNames = expandedPluginNames.filter((name) => name !== plugin.name)
              trackPluginMutation(plugin.name, pending)
            }
          }
        }}>
        <TrashIcon />
      </button>
    </div>
    {#if plugin.updateURL}
      {@const updateStatus = pluginUpdateState(plugin)}
      {#if updateStatus.status !== 'idle' && updateStatus.status !== 'queued'}
        <span class="text-textcolor2 mt-1 block w-full break-words text-xs" role="status">
          {pluginUpdateStatusText(updateStatus)}
        </span>
      {/if}
    {/if}
    {#if pluginMutationStates[plugin.name]?.status === 'failed'}
      <span class="text-textcolor2 mt-1 block w-full break-words text-xs" role="status" aria-live="polite">
        {pluginMutationStatusText(plugin.name)}
      </span>
    {/if}
    {#if Object.keys(plugin.arguments).filter((i) => !i.startsWith('hidden_')).length > 0 && isPluginExpanded(plugin.name)}
      <div id={pluginParamsId(plugin.name)} class="flex flex-col mt-2 bg-dark-900/50 p-3">
        {#each Object.keys(plugin.arguments) as arg}
          {#if !arg.startsWith('hidden_')}
            {#if typeof plugin?.argMeta?.[arg]?.divider === 'string'}
              {#if plugin?.argMeta?.[arg]?.divider}
                <div class="flex items-center mt-6">
                  <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                  <div class="relative flex justify-center">
                    <span class="px-2 text-sm text-textarea text-nowrap">{plugin?.argMeta?.[arg]?.divider}</span>
                  </div>
                  <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                </div>
              {:else}
                <div aria-hidden="true" class="w-full border-t border-darkborderc mt-6"></div>
              {/if}
            {/if}
            <span class="mb-2 mt-6">{plugin?.argMeta?.[arg]?.name || arg}</span>
            {#if plugin?.argMeta?.[arg]?.description}
              <span class="mb-2 text-sm text-textcolor2">{plugin?.argMeta?.[arg]?.description}</span>
            {/if}
            {#if Array.isArray(plugin.arguments[arg])}
              <SelectInput
                className="mt-2 mb-4"
                bind:value={
                  () => getPluginArg(plugin.name, arg) as string, (value) => setPluginArg(plugin.name, arg, value)
                }>
                {#each plugin.arguments[arg] as a}
                  <OptionInput value={a}>{a}</OptionInput>
                {/each}
              </SelectInput>
            {:else if plugin.arguments[arg] === 'string'}
              {#if plugin?.argMeta?.[arg]?.textarea}
                <TextAreaInput
                  bind:value={
                    () => getPluginArg(plugin.name, arg) as string, (value) => setPluginArg(plugin.name, arg, value)
                  }
                  placeholder={plugin?.argMeta?.[arg]?.placeholder} />
              {:else if plugin?.argMeta?.[arg]?.radio}
                {#each plugin?.argMeta?.[arg]?.radio?.split(',') as radioOption}
                  {@const optionValue = radioOption.split('|').at(-1) ?? ''}
                  <RadioInput
                    checked={getPluginArg(plugin.name, arg) === optionValue}
                    group={pluginArgRadioGroup(plugin.name, arg)}
                    label={radioOption.split('|').at(0) ?? ''}
                    onChange={() => {
                      setPluginArg(plugin.name, arg, optionValue)
                    }} />
                {/each}
              {:else}
                <TextInput
                  bind:value={
                    () => getPluginArg(plugin.name, arg) as string, (value) => setPluginArg(plugin.name, arg, value)
                  }
                  placeholder={plugin?.argMeta?.[arg]?.placeholder} />
              {/if}
            {:else if plugin.arguments[arg] === 'int'}
              {#if plugin?.argMeta?.[arg]?.checkbox}
                <CheckInput
                  check={Number(getPluginArg(plugin.name, arg)) === 1}
                  onChange={(e) => {
                    setPluginArg(plugin.name, arg, e ? 1 : 0)
                  }}
                  margin={false}
                  name={plugin?.argMeta?.[arg]?.checkbox === '1'
                    ? language.enable
                    : plugin?.argMeta?.[arg]?.checkbox} />
              {:else if plugin?.argMeta?.[arg]?.radio}
                {#each plugin?.argMeta?.[arg]?.radio?.split(',') as radioOption}
                  {@const optionValue = parseInt(radioOption.split('|').at(-1) ?? '')}
                  <RadioInput
                    checked={getPluginArg(plugin.name, arg) === optionValue}
                    group={pluginArgRadioGroup(plugin.name, arg)}
                    label={radioOption.split('|').at(0) ?? ''}
                    onChange={() => {
                      setPluginArg(plugin.name, arg, optionValue)
                    }} />
                {/each}
              {:else}
                <NumberInput
                  bind:value={
                    () => getPluginArg(plugin.name, arg) as number, (value) => setPluginArg(plugin.name, arg, value)
                  }
                  placeholder={plugin?.argMeta?.[arg]?.placeholder} />
              {/if}
            {/if}
          {/if}
        {/each}
      </div>
    {/if}
  {/each}
</div>
<div class="mt-4">
  <SettingsSections sections={pluginSupplementalSettingsSections} />
</div>
<div class="text-textcolor2 mt-2 flex gap-2">
  <button
    type="button"
    aria-label={`${language.import}: ${language.plugin}`}
    onclick={() => {
      void handlePluginImport()
    }}
    class="hover:text-textcolor cursor-pointer">
    <PlusIcon />
  </button>
  {#if pluginImportStatus === 'failed'}
    <span class="text-xs" role="status">{pluginImportStatusText()}</span>
  {/if}

  <button
    type="button"
    aria-label={language.pluginDevelopMode}
    onclick={() => {
      void handleDevelopModeAction()
    }}
    class="hover:text-textcolor cursor-pointer">
    <CodeXmlIcon />
  </button>
</div>
