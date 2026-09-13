<script lang="ts">
  import {
    AccessibilityIcon,
    MousePointerClickIcon,
    ActivityIcon,
    PackageIcon,
    BotIcon,
    BoxIcon,
    CodeIcon,
    ContactIcon,
    HardDrive,
    LanguagesIcon,
    MonitorIcon,
    BrainIcon,
    CircleXIcon,
    KeyboardIcon,
    SparkleIcon,
    ArrowLeftIcon,
    WorkflowIcon,
    WebhookIcon,
    BookOpen,
    Regex,
    HistoryIcon,
    GithubIcon,
  } from '@lucide/svelte'
  import { language } from 'src/lang'
  import { additionalSettingsMenu, easyPanelStore, MobileGUI, SettingsMenuIndex } from 'src/ts/stores.svelte'
  import { collectionsResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import { isLite } from 'src/ts/lite'
  import { displaySettingForPaint } from 'src/ts/gui/displaySettings'
  import PluginDefinedIcon from '../Others/PluginDefinedIcon.svelte'
  import LazyComponent from '../UI/LazyComponent.svelte'
  import { alertConfirm } from 'src/ts/alert'
  import { closeSettingsRoute, navigate } from 'src/ts/router'
  import { pluginRuntimeStateStore } from 'src/ts/plugins/plugins.svelte'
  import { prefetchRouteIntent } from 'src/ts/routeIntentPrefetch'
  import {
    loadAccessibilitySettings,
    loadInteractionSettings,
    loadAdvancedSettings,
    loadAgentPresetSettings,
    loadBardWikiSettings,
    loadBotSettings,
    loadCommunities,
    loadDisplaySettings,
    loadGlobalLoreBookSettings,
    loadGlobalRegex,
    loadHotkeySettings,
    loadInputHookSettings,
    loadLanguageSettings,
    loadModuleSettings,
    loadMemorySettings,
    loadPersonaSettings,
    loadPluginSettings,
    loadPromptSettings,
    loadRequestHistorySettings,
    loadSourceCode,
    loadThanksPage,
    loadUserSettings,
  } from 'src/ts/routeComponentPreload'

  let supporterConfirmOpen = $state(false)
  let viewportWidth = $state(window.innerWidth)
  let splitSettingsLayout = $derived(viewportWidth >= 700 && !$MobileGUI)
  let mobileSettingsLayout = $derived(!splitSettingsLayout)
  let doNotWarnExternalServers = $derived(
    settingsResourceState.groupStatuses.advanced === 'ready' &&
      settingsResourceState.value.doNotWarnExternalServers === true,
  )
  let showGlobalLorebookAndRegex = $derived(
    settingsResourceState.groupStatuses.advanced === 'ready' &&
      settingsResourceState.value.showGlobalLorebookAndRegex === true,
  )
  let enableRisuaiProTools = $derived(
    settingsResourceState.groupStatuses.sidebar === 'ready' &&
      settingsResourceState.value.enableRisuaiProTools === true,
  )
  let settingsCloseButtonSize = $derived(displaySettingForPaint('settingsCloseButtonSize'))
  let hasBotPresets = $derived(
    collectionsResourceState.statuses.botPresets === 'ready' &&
      Array.isArray(collectionsResourceState.values.botPresets) &&
      collectionsResourceState.values.botPresets.length > 0,
  )

  function updateViewportWidth(): void {
    viewportWidth = window.innerWidth
  }

  $effect(() => {
    if (splitSettingsLayout && $SettingsMenuIndex === -1) {
      $SettingsMenuIndex = 17
    }
  })

  async function openSupporterThanks() {
    if ($SettingsMenuIndex === 77 || supporterConfirmOpen) return

    if (doNotWarnExternalServers) {
      navigate('/settings/supporter')
      return
    }

    supporterConfirmOpen = true
    try {
      if (await alertConfirm(language.sendExternalServerWarning)) {
        navigate('/settings/supporter')
      }
    } finally {
      supporterConfirmOpen = false
    }
  }

  function navButtonClass(active: boolean): Record<string, boolean> {
    return {
      'flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:text-textcolor': true,
      'hover:bg-bgcolor': !$MobileGUI,
      'hover:bg-darkbg': $MobileGUI,
      'bg-bgcolor text-textcolor': active && !$MobileGUI,
      'bg-darkbg text-textcolor': active && $MobileGUI,
      'text-textcolor2': !active,
    }
  }

  function goBackToSettingsList() {
    navigate('/settings', { replace: true })
  }

  function preloadSettingsRouteFromEvent(event: Event): void {
    if (!(event.target instanceof Element)) return
    const target = event.target.closest<HTMLElement>('[data-risu-route-intent]')
    const path = target?.dataset.risuRouteIntent
    if (path) prefetchRouteIntent(path)
  }
</script>

<svelte:window onresize={updateViewportWidth} />

<div
  class="h-full w-full flex justify-center rs-setting-cont"
  class:bg-bgcolor={$MobileGUI}
  class:setting-bg={!$MobileGUI}>
  <div class="h-full max-w-(--breakpoint-lg) w-full flex relative rs-setting-cont-2">
    {#if splitSettingsLayout || $SettingsMenuIndex === -1}
      <div
        class="flex h-full flex-col gap-4 overflow-y-auto relative rs-setting-cont-3 shrink-0 px-3 py-4 pt-8"
        class:w-full={mobileSettingsLayout}
        class:bg-darkbg={!$MobileGUI}
        class:bg-bgcolor={$MobileGUI}
        role="navigation"
        aria-label={language.settings}
        onpointerover={preloadSettingsRouteFromEvent}
        onfocusin={preloadSettingsRouteFromEvent}>
        {#if !$isLite}
          <div class="flex flex-col gap-1">
            <span class="px-2 text-xs font-semibold uppercase text-textcolor2">{language.settingsGroupChatSetup}</span>
            <button
              class={navButtonClass($SettingsMenuIndex === 17)}
              data-risu-route-intent="/settings/model"
              onclick={() => {
                navigate('/settings/model')
              }}>
              <ActivityIcon size={20} />
              <span>{language.settingsNavModelProfiles}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 18 || $SettingsMenuIndex === 13)}
              data-risu-route-intent="/settings/prompt-settings"
              onclick={() => {
                navigate('/settings/prompt-settings')
              }}>
              <SparkleIcon size={20} />
              <span>{language.settingsNavPromptPresets}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 19)}
              data-risu-route-intent="/settings/agent-presets"
              onclick={() => {
                navigate('/settings/agent-presets')
              }}>
              <WorkflowIcon size={20} />
              <span>{language.settingsNavAgentPresets}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 20)}
              data-risu-route-intent="/settings/input-hooks"
              onclick={() => {
                navigate('/settings/input-hooks')
              }}>
              <WebhookIcon size={20} />
              <span>{language.settingsNavInputHooks}</span>
            </button>
            {#if hasBotPresets}
              <button
                class={navButtonClass($SettingsMenuIndex === 1)}
                data-risu-route-intent="/settings/bot-preset"
                onclick={() => {
                  navigate('/settings/bot-preset')
                }}>
                <BotIcon size={20} />
                <span>{language.settingsNavLegacyBotPresets}</span>
              </button>
            {/if}
            <button
              class={navButtonClass($SettingsMenuIndex === 12)}
              data-risu-route-intent="/settings/persona"
              onclick={() => {
                navigate('/settings/persona')
              }}>
              <ContactIcon size={20} />
              <span>{language.settingsNavUserPersona}</span>
            </button>
          </div>

          <div class="flex flex-col gap-1">
            <span class="px-2 text-xs font-semibold uppercase text-textcolor2"
              >{language.settingsGroupCapabilities}</span>
            <button
              class={navButtonClass($SettingsMenuIndex === 2)}
              data-risu-route-intent="/settings/memory"
              onclick={() => {
                navigate('/settings/memory')
              }}>
              <BrainIcon size={20} />
              <span>{language.settingsNavMemory}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 23)}
              data-risu-route-intent="/settings/bardwiki"
              onclick={() => {
                navigate('/settings/bardwiki')
              }}>
              <BookOpen size={20} />
              <span>{language.bardWiki.title}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 14)}
              data-risu-route-intent="/settings/modules"
              onclick={() => {
                navigate('/settings/modules')
              }}>
              <PackageIcon size={20} />
              <span>{language.settingsNavModules}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 4)}
              data-risu-route-intent="/settings/plugins"
              onclick={() => {
                navigate('/settings/plugins')
              }}>
              <CodeIcon size={20} />
              <span>{language.settingsNavPlugins}</span>
            </button>
          </div>
        {/if}

        <div class="flex flex-col gap-1">
          <span class="px-2 text-xs font-semibold uppercase text-textcolor2">{language.settingsGroupInterface}</span>
          {#if !$isLite}
            <button
              class={navButtonClass($SettingsMenuIndex === 3)}
              data-risu-route-intent="/settings/display"
              onclick={() => {
                navigate('/settings/display')
              }}>
              <MonitorIcon size={20} />
              <span>{language.settingsNavDisplayAudio}</span>
            </button>
          {/if}
          <button
            class={navButtonClass($SettingsMenuIndex === 10)}
            data-risu-route-intent="/settings/language"
            onclick={() => {
              navigate('/settings/language')
            }}>
            <LanguagesIcon size={20} />
            <span>{language.settingsNavLanguage}</span>
          </button>
          {#if !$isLite}
            <button
              class={navButtonClass($SettingsMenuIndex === 24)}
              data-risu-route-intent="/settings/interaction"
              onclick={() => {
                navigate('/settings/interaction')
              }}>
              <MousePointerClickIcon size={20} />
              <span>{language.settingsNavInteraction}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 11)}
              data-risu-route-intent="/settings/accessibility"
              onclick={() => {
                navigate('/settings/accessibility')
              }}>
              <AccessibilityIcon size={20} />
              <span>{language.settingsNavAccessibility}</span>
            </button>
          {/if}
          <button
            class={navButtonClass($SettingsMenuIndex === 15)}
            data-risu-route-intent="/settings/hotkeys"
            onclick={() => {
              navigate('/settings/hotkeys')
            }}>
            <KeyboardIcon size={20} />
            <span>{language.settingsNavKeyboardShortcuts}</span>
          </button>
        </div>

        <div class="flex flex-col gap-1">
          <span class="px-2 text-xs font-semibold uppercase text-textcolor2">{language.settingsGroupData}</span>
          <button
            class={navButtonClass($SettingsMenuIndex === 0)}
            data-risu-route-intent="/settings/backup"
            onclick={() => {
              navigate('/settings/backup')
            }}>
            <HardDrive size={20} />
            <span>{language.settingsNavBackups}</span>
          </button>
          <button
            class={navButtonClass($SettingsMenuIndex === 21)}
            data-risu-route-intent="/settings/request-history"
            onclick={() => {
              navigate('/settings/request-history')
            }}>
            <HistoryIcon size={20} />
            <span>{language.settingsNavRequestHistory}</span>
          </button>
          {#if !$isLite && showGlobalLorebookAndRegex}
            <button
              class={navButtonClass($SettingsMenuIndex === 8)}
              data-risu-route-intent="/settings/global-lorebook"
              onclick={() => {
                navigate('/settings/global-lorebook')
              }}>
              <BookOpen size={20} />
              <span>{language.globalLoreBook}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 9)}
              data-risu-route-intent="/settings/global-regex"
              onclick={() => {
                navigate('/settings/global-regex')
              }}>
              <Regex size={20} />
              <span>{language.globalRegexScript}</span>
            </button>
          {/if}
        </div>

        {#if !$isLite}
          <div class="flex flex-col gap-1">
            <span class="px-2 text-xs font-semibold uppercase text-textcolor2"
              >{language.settingsGroupAboutAdvanced}</span>
            <button
              class={navButtonClass($SettingsMenuIndex === 6)}
              data-risu-route-intent="/settings/advanced"
              onclick={() => {
                navigate('/settings/advanced')
              }}>
              <ActivityIcon size={20} />
              <span>{language.settingsNavAdvanced}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 22)}
              data-risu-route-intent="/settings/source-code"
              onclick={() => {
                navigate('/settings/source-code')
              }}>
              <GithubIcon size={20} />
              <span>{language.settingsNavSourceCode}</span>
            </button>
            <button
              class={navButtonClass($SettingsMenuIndex === 77)}
              data-risu-route-intent="/settings/supporter"
              onclick={openSupporterThanks}>
              <BoxIcon size={20} />
              <span>{language.settingsNavSupporters}</span>
            </button>
            {#if $pluginRuntimeStateStore.phase === 'ready'}
              {#each additionalSettingsMenu as menu}
                <button class={navButtonClass(false)} onclick={menu.callback}>
                  <PluginDefinedIcon ico={menu} />
                  <span>{menu.name}</span>
                </button>
              {/each}
            {/if}

            {#if enableRisuaiProTools}
              <button
                class={navButtonClass($SettingsMenuIndex === 16)}
                onclick={() => {
                  easyPanelStore.open = true
                }}>
                <!-- From Lucide Icons, licensed under MIT/ISC License, modified to fit the design. see license from bundled lucide icons. -->
                <svg width={20} height={20}>
                  <defs>
                    <linearGradient id={`grad1`} x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" style="stop-color:#587bff" />
                      <stop offset="100%" style="stop-color:#00a1ad" />
                    </linearGradient>
                  </defs>
                  <SparkleIcon color="url(#grad1)" size={20} />
                </svg>
                <span>{language.settingsNavEasyPanel}</span>
              </button>
            {/if}
          </div>
        {/if}
        {#if mobileSettingsLayout && !$MobileGUI}
          <button
            class="absolute top-2 right-2 hover:text-green-500 text-textcolor"
            aria-label={language.close}
            onclick={() => {
              closeSettingsRoute()
            }}>
            <CircleXIcon size={settingsCloseButtonSize} />
          </button>
        {/if}
      </div>
    {/if}
    {#if splitSettingsLayout || $SettingsMenuIndex !== -1}
      {#key $SettingsMenuIndex}
        <div
          class="grow py-6 px-4 bg-bgcolor flex flex-col text-textcolor overflow-y-auto relative rs-setting-cont-4 min-w-0"
          class:pt-12={mobileSettingsLayout && $SettingsMenuIndex !== -1}>
          {#if mobileSettingsLayout && $SettingsMenuIndex !== -1}
            <button
              class="absolute top-2 left-2 hover:text-green-500 text-textcolor"
              title={language.goback}
              data-risu-settings-mobile-back
              onclick={goBackToSettingsList}>
              <ArrowLeftIcon size={settingsCloseButtonSize} />
              <span class="sr-only">{language.goback}</span>
            </button>
          {/if}
          {#if $SettingsMenuIndex === 0}
            <LazyComponent loader={loadUserSettings} fill testId="settings-user" />
          {:else if $SettingsMenuIndex === 1}
            {#if hasBotPresets}
              <LazyComponent
                loader={loadBotSettings}
                componentProps={{
                  settingsKind: 'legacy',
                  goPromptTemplate: () => navigate('/settings/prompt'),
                }}
                fill
                testId="settings-legacy-bot" />
            {:else}
              <LazyComponent
                loader={loadBotSettings}
                componentProps={{ settingsKind: 'model' }}
                fill
                testId="settings-model" />
            {/if}
          {:else if $SettingsMenuIndex === 2}
            <LazyComponent loader={loadMemorySettings} fill testId="settings-memory" />
          {:else if $SettingsMenuIndex === 3}
            <LazyComponent loader={loadDisplaySettings} fill testId="settings-display" />
          {:else if $SettingsMenuIndex === 4}
            <LazyComponent loader={loadPluginSettings} fill testId="settings-plugins" />
          {:else if $SettingsMenuIndex === 6}
            <LazyComponent loader={loadAdvancedSettings} fill testId="settings-advanced" />
          {:else if $SettingsMenuIndex === 7}
            <LazyComponent loader={loadCommunities} fill testId="settings-communities" />
          {:else if $SettingsMenuIndex === 8}
            <LazyComponent loader={loadGlobalLoreBookSettings} fill testId="settings-global-lorebook" />
          {:else if $SettingsMenuIndex === 9}
            <LazyComponent loader={loadGlobalRegex} fill testId="settings-global-regex" />
          {:else if $SettingsMenuIndex === 10}
            <LazyComponent loader={loadLanguageSettings} fill testId="settings-language" />
          {:else if $SettingsMenuIndex === 24}
            <LazyComponent loader={loadInteractionSettings} fill testId="settings-interaction" />
          {:else if $SettingsMenuIndex === 11}
            <LazyComponent loader={loadAccessibilitySettings} fill testId="settings-accessibility" />
          {:else if $SettingsMenuIndex === 12}
            <LazyComponent loader={loadPersonaSettings} fill testId="settings-persona" />
          {:else if $SettingsMenuIndex === 14}
            <LazyComponent loader={loadModuleSettings} fill testId="settings-modules" />
          {:else if $SettingsMenuIndex === 13}
            <LazyComponent
              loader={loadPromptSettings}
              componentProps={{ onGoBack: () => navigate('/settings/prompt-settings') }}
              fill
              testId="settings-prompt" />
          {:else if $SettingsMenuIndex === 15}
            <LazyComponent loader={loadHotkeySettings} fill testId="settings-hotkeys" />
          {:else if $SettingsMenuIndex === 17}
            <LazyComponent
              loader={loadBotSettings}
              componentProps={{ settingsKind: 'model' }}
              fill
              testId="settings-model" />
          {:else if $SettingsMenuIndex === 18}
            <LazyComponent
              loader={loadBotSettings}
              componentProps={{
                settingsKind: 'prompt',
                goPromptTemplate: () => navigate('/settings/prompt'),
              }}
              fill
              testId="settings-prompt-presets" />
          {:else if $SettingsMenuIndex === 19}
            <LazyComponent loader={loadAgentPresetSettings} fill testId="settings-agent-presets" />
          {:else if $SettingsMenuIndex === 20}
            <LazyComponent loader={loadInputHookSettings} fill testId="settings-input-hooks" />
          {:else if $SettingsMenuIndex === 21}
            <LazyComponent loader={loadRequestHistorySettings} fill testId="settings-request-history" />
          {:else if $SettingsMenuIndex === 22}
            <LazyComponent loader={loadSourceCode} fill testId="settings-source-code" />
          {:else if $SettingsMenuIndex === 23}
            <LazyComponent loader={loadBardWikiSettings} fill testId="settings-bardwiki" />
          {:else if $SettingsMenuIndex === 77}
            <LazyComponent loader={loadThanksPage} fill testId="settings-thanks" />
          {/if}
        </div>
      {/key}
      {#if !$MobileGUI}
        <button
          class="absolute top-2 right-2 hover:text-green-500 text-textcolor"
          aria-label={language.close}
          onclick={() => {
            closeSettingsRoute()
          }}>
          <CircleXIcon size={settingsCloseButtonSize} />
        </button>
      {/if}
    {/if}
  </div>
</div>

<style>
  .setting-bg {
    background: linear-gradient(to right, var(--risu-theme-darkbg) 50%, var(--risu-theme-bgcolor) 50%);
  }
</style>
