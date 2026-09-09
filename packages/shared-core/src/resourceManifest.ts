import type { AppRoute } from './routerRoute.js'
import { MODEL_PROFILE_SETTINGS_KEYS, type SettingsGroup } from './settingsGroups.js'

export const RESOURCE_COLLECTION_NAMES = [
  'modules',
  'plugins',
  'modelPresets',
  'promptPresets',
  'botPresets',
  'promptTemplate',
  'personas',
  'loadouts',
  'loreBook',
  'translatorPresets',
  'hypaV3Presets',
  'pluginCustomStorage',
] as const
export type ResourceCollectionName = (typeof RESOURCE_COLLECTION_NAMES)[number]

export const RESOURCE_PURPOSES = ['render', 'interact', 'mutate', 'generate', 'editor-prefill'] as const
export type ResourcePurpose = (typeof RESOURCE_PURPOSES)[number]

/**
 * Legacy top-level database values that are not owned by a granular settings
 * group. Phase 5 loaders must not assume that a settings-group read returns
 * these values; a shell or focused projection has to own each one explicitly.
 */
export const STANDALONE_SETTING_NAMES = [
  'selectedPersonaId',
  'selectedPersona',
  'botPresetsId',
  'modelPresetsId',
  'promptPresetsId',
  'loreBookPage',
  'personaPrompt',
  'userIcon',
  'userNote',
] as const
export type StandaloneSettingName = (typeof STANDALONE_SETTING_NAMES)[number]

export const RESOURCE_PROJECTION_NAMES = [
  'character-summaries',
  'character-selection',
  'selected-character',
  'selected-chat',
  'selected-prompt-template',
  'inlay-catalog',
] as const
export type ResourceProjectionName = (typeof RESOURCE_PROJECTION_NAMES)[number]

export interface SettingsGroupRequirement {
  kind: 'settings-group'
  group: SettingsGroup
  /** Omitted means the complete existing group projection is required. */
  keys?: readonly string[]
  purposes: readonly ResourcePurpose[]
}

export interface CollectionRequirement {
  kind: 'collection'
  collection: ResourceCollectionName
  purposes: readonly ResourcePurpose[]
}

export interface StandaloneSettingRequirement {
  kind: 'standalone-setting'
  setting: StandaloneSettingName
  purposes: readonly ResourcePurpose[]
}

export interface ProjectionRequirement {
  kind: 'projection'
  projection: ResourceProjectionName
  purposes: readonly ResourcePurpose[]
}

export type ResourceRequirement =
  | SettingsGroupRequirement
  | CollectionRequirement
  | StandaloneSettingRequirement
  | ProjectionRequirement

export type ResourceSurfaceFamily = 'shared' | 'route' | 'settings' | 'playground' | 'runtime' | 'overlay'

export interface ResourceSurfaceDefinition {
  family: ResourceSurfaceFamily
  /** Browser consumers whose direct or imported-helper reads justify this surface. */
  owners: readonly string[]
  requirements: readonly ResourceRequirement[]
  notes?: string
}

const group = (
  settingsGroup: SettingsGroup,
  purposes: readonly ResourcePurpose[],
  keys?: readonly string[],
): SettingsGroupRequirement => ({
  kind: 'settings-group',
  group: settingsGroup,
  ...(keys ? { keys } : {}),
  purposes,
})

const collection = (
  collectionName: ResourceCollectionName,
  purposes: readonly ResourcePurpose[],
): CollectionRequirement => ({
  kind: 'collection',
  collection: collectionName,
  purposes,
})

const standalone = (
  setting: StandaloneSettingName,
  purposes: readonly ResourcePurpose[],
): StandaloneSettingRequirement => ({
  kind: 'standalone-setting',
  setting,
  purposes,
})

const projection = (
  projectionName: ResourceProjectionName,
  purposes: readonly ResourcePurpose[],
): ProjectionRequirement => ({
  kind: 'projection',
  projection: projectionName,
  purposes,
})

/**
 * Phase 5A's audited browser resource inventory. Shared and runtime surfaces
 * are kept separate from routed pages so downstream loaders can compose them
 * without copying dependencies into every route entry.
 */
export const RESOURCE_SURFACE_MANIFEST = {
  'shared:app-shell': {
    family: 'shared',
    owners: [
      'src/App.svelte',
      'src/lib/SideBars/Sidebar.svelte',
      'src/lib/SideBars/SideChatList.svelte',
      'src/lib/Others/SavePopupIcon.svelte',
      'src/ts/gui/guisize.ts',
    ],
    requirements: [
      group(
        'display',
        ['render', 'interact'],
        [
          'colorScheme',
          'colorSchemeName',
          'textTheme',
          'customTextTheme',
          'font',
          'customFont',
          'customCSS',
          'animationSpeed',
          'reducedMotion',
          'heightMode',
          'sideBarSize',
          'desktopSidebarColumns',
          'mobileSidebarColumns',
          'roundIcons',
          'menuSideBar',
          'showFolderName',
          'showSavingIcon',
        ],
      ),
      group('language', ['render', 'interact'], ['language']),
      group('sidebar', ['render', 'interact'], ['hamburgerButtonBottom', 'botSettingAtStart']),
      group('account', ['render'], ['username']),
      group('advanced', ['render', 'interact'], ['enableDevTools', 'doNotWarnExternalServers', 'keepSessionAlive']),
      projection('character-summaries', ['render', 'interact']),
      projection('character-selection', ['render', 'interact']),
    ],
    notes:
      'Theme/language, responsive sidebar behavior, save status, thin character rows, order, and current selection form the shared shell contract.',
  },
  'shared:settings-shell': {
    family: 'shared',
    owners: ['src/lib/Setting/Settings.svelte'],
    requirements: [
      group('display', ['render'], ['settingsCloseButtonSize']),
      group('sidebar', ['render'], ['enableRisuaiProTools']),
      group('advanced', ['render', 'interact'], ['doNotWarnExternalServers', 'showGlobalLorebookAndRegex']),
      collection('botPresets', ['render']),
    ],
    notes:
      'Every settings route inherits the navigation shell. botPresets is currently read only to decide whether to show the legacy preset entry.',
  },
  'shared:playground-shell': {
    family: 'shared',
    owners: ['src/lib/Playground/PlaygroundMenu.svelte'],
    requirements: [],
    notes: 'The Playground menu itself only needs shell localization and viewport state.',
  },

  'route:home': {
    family: 'route',
    owners: ['src/lib/ChatScreens/DefaultChatScreen.svelte'],
    requirements: [],
  },
  'route:grid': {
    family: 'route',
    owners: ['src/lib/Others/GridCatalog.svelte'],
    requirements: [projection('character-summaries', ['render', 'interact'])],
  },
  'route:character': {
    family: 'route',
    owners: ['src/lib/ChatScreens/DefaultChatScreen.svelte', 'src/lib/SideBars/SideChatList.svelte'],
    requirements: [
      projection('selected-character', ['render', 'interact', 'mutate']),
      collection('personas', ['render', 'interact']),
      standalone('selectedPersonaId', ['render', 'interact']),
      standalone('selectedPersona', ['render', 'interact']),
      standalone('personaPrompt', ['render', 'interact']),
      standalone('userIcon', ['render', 'interact']),
      standalone('userNote', ['render', 'interact']),
    ],
    notes:
      'The complete persona owner supplies the selected user identity shown beside a selected character; its fail-closed snapshot also validates the legacy profile projection.',
  },
  'route:character-chat': {
    family: 'route',
    owners: ['src/lib/ChatScreens/DefaultChatScreen.svelte', 'src/lib/ChatScreens/ChatBody.svelte'],
    requirements: [
      projection('selected-chat', ['render', 'interact', 'mutate', 'generate']),
      projection('selected-prompt-template', ['generate']),
      collection('promptTemplate', ['interact', 'generate']),
      collection('translatorPresets', ['render', 'interact']),
    ],
  },
  'overlay:bardwiki-workspace': {
    family: 'overlay',
    owners: ['src/lib/ChatScreens/BardWikiWorkspace.svelte'],
    requirements: [],
    notes:
      'The lazy chat-scoped workspace owns its focused BardWiki API reads; document bodies and versions remain demand-loaded.',
  },
  'route:inlay': {
    family: 'route',
    owners: ['src/lib/Playground/PlaygroundInlayExplorer.svelte', 'src/ts/process/files/inlays.ts'],
    requirements: [projection('inlay-catalog', ['render', 'interact'])],
    notes: 'The inlay catalog is standalone and must never be part of the app shell barrier.',
  },
  'route:not-found': {
    family: 'route',
    owners: ['src/App.svelte'],
    requirements: [],
  },

  'settings:user-backup': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/UserSettings.svelte'],
    requirements: [],
    notes: 'Backup and restore use operational APIs instead of resource projections.',
  },
  'settings:bot-model-prompt': {
    family: 'settings',
    owners: [
      'src/lib/Setting/Pages/BotSettings.svelte',
      'src/lib/Setting/Pages/Model/ModelSettingsShell.svelte',
      'src/lib/Setting/Pages/ChatFormatSettings.svelte',
    ],
    requirements: [
      group('providers', ['render', 'interact', 'mutate']),
      group('models', ['render', 'interact', 'mutate']),
      group('runtime', ['render', 'interact', 'mutate']),
      group('prompt', ['render', 'interact', 'mutate']),
      group('advanced', ['render', 'interact', 'mutate']),
      group('display', ['render', 'interact'], ['useLegacyGUI']),
      collection('modelPresets', ['render', 'interact', 'mutate']),
      collection('promptPresets', ['render', 'interact', 'mutate']),
      collection('botPresets', ['render', 'interact', 'mutate']),
      collection('promptTemplate', ['render', 'interact', 'mutate', 'editor-prefill']),
      standalone('botPresetsId', ['render', 'interact', 'mutate']),
      standalone('modelPresetsId', ['render', 'interact', 'mutate']),
      standalone('promptPresetsId', ['render', 'interact', 'mutate']),
    ],
  },
  'settings:memory': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/OtherBotSettings.svelte'],
    requirements: [
      group('media', ['render', 'interact', 'mutate']),
      group('memory', ['render', 'interact', 'mutate']),
      group('providers', ['render', 'interact', 'mutate']),
      group('models', ['render', 'interact']),
      group('runtime', ['render', 'interact']),
      group('display', ['render'], ['useLegacyGUI']),
      collection('hypaV3Presets', ['render', 'interact', 'mutate']),
      collection('promptPresets', ['render', 'interact']),
      projection('selected-character', ['interact', 'editor-prefill']),
      collection('promptTemplate', ['interact', 'editor-prefill']),
    ],
    notes:
      'The memory group owns selectedHypaV3PresetId; hypaV3PresetId is its derived numeric compatibility projection.',
  },
  'settings:bardwiki': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/BardWikiSettings.svelte'],
    requirements: [
      group('memory', ['render', 'interact', 'mutate'], ['bardWiki']),
      group('providers', ['render', 'interact'], ['modelProfiles']),
      collection('promptPresets', ['render', 'interact']),
    ],
  },
  'settings:display': {
    family: 'settings',
    owners: [
      'src/lib/Setting/Pages/DisplaySettings.svelte',
      'src/ts/setting/displaySettingsData.svelte.ts',
      'src/lib/Setting/Pages/Display/NotificationToggle.svelte',
    ],
    requirements: [
      group('display', ['render', 'interact', 'mutate']),
      group('media', ['render', 'interact', 'mutate']),
    ],
  },
  'settings:plugins': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/PluginSettings.svelte', 'src/ts/plugins/plugins.svelte.ts'],
    requirements: [
      group('providers', ['render', 'interact', 'mutate']),
      group('models', ['render', 'interact']),
      group('runtime', ['interact']),
      group('advanced', ['render', 'interact', 'mutate']),
      collection('plugins', ['render', 'interact', 'mutate']),
      collection('pluginCustomStorage', ['interact', 'mutate']),
    ],
  },
  'settings:advanced': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/AdvancedSettings.svelte', 'src/ts/setting/advancedSettingsData.ts'],
    requirements: [
      group('advanced', ['render', 'interact', 'mutate']),
      group('display', ['render', 'interact', 'mutate']),
      group('language', ['render', 'interact', 'mutate']),
      group('media', ['render', 'interact', 'mutate']),
      group('providers', ['render', 'interact', 'mutate']),
      group('runtime', ['render', 'interact', 'mutate']),
    ],
  },
  'settings:communities': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/Communities.svelte'],
    requirements: [],
  },
  'settings:global-lorebook': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/GlobalLoreBookSettings.svelte'],
    requirements: [
      group('advanced', ['render', 'interact', 'mutate']),
      group('sidebar', ['render', 'interact', 'mutate']),
      collection('loreBook', ['render', 'interact', 'mutate']),
      standalone('loreBookPage', ['render', 'interact', 'mutate']),
    ],
  },
  'settings:global-regex': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/GlobalRegex.svelte'],
    requirements: [group('advanced', ['render', 'interact', 'mutate'], ['globalscript'])],
  },
  'settings:language': {
    family: 'settings',
    owners: [
      'src/lib/Setting/Pages/LanguageSettings.svelte',
      'src/lib/Setting/Pages/Language/TranslatorPresetSettings.svelte',
    ],
    requirements: [
      group('language', ['render', 'interact', 'mutate']),
      group('providers', ['render', 'interact']),
      group('models', ['render', 'interact']),
      group('runtime', ['render', 'interact']),
      collection('translatorPresets', ['render', 'interact', 'mutate']),
    ],
  },
  'settings:accessibility': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/AccessibilitySettings.svelte', 'src/ts/setting/accessibilitySettingsData.ts'],
    requirements: [
      group('display', ['render', 'interact', 'mutate']),
      group('sidebar', ['render', 'interact', 'mutate']),
      group('memory', ['render', 'interact', 'mutate']),
      group('advanced', ['render', 'interact', 'mutate']),
      group('providers', ['render', 'interact', 'mutate']),
      group('language', ['render', 'interact', 'mutate']),
    ],
  },
  'settings:persona': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/PersonaSettings.svelte', 'src/ts/persona.ts'],
    requirements: [
      group('account', ['render', 'interact', 'mutate'], ['username']),
      collection('personas', ['render', 'interact', 'mutate']),
      collection('modules', ['render', 'interact', 'mutate']),
      standalone('selectedPersonaId', ['render', 'interact', 'mutate']),
      standalone('selectedPersona', ['render', 'interact', 'mutate']),
      standalone('personaPrompt', ['render', 'interact', 'mutate']),
      standalone('userIcon', ['render', 'interact', 'mutate']),
      standalone('userNote', ['render', 'interact', 'mutate']),
    ],
    notes: 'App route synchronization also reads the selected persona ID; ownership remains route-scoped.',
  },
  'settings:prompt-template': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/PromptSettings.svelte'],
    requirements: [
      group('prompt', ['render', 'interact', 'mutate']),
      group('providers', ['render', 'interact']),
      group('models', ['render', 'interact']),
      group('runtime', ['render', 'interact']),
      group('advanced', ['render', 'interact'], ['showUnrecommended']),
      collection('modelPresets', ['render', 'interact']),
      collection('promptPresets', ['render', 'interact', 'mutate']),
      collection('promptTemplate', ['render', 'interact', 'mutate', 'editor-prefill']),
      standalone('modelPresetsId', ['render', 'interact']),
      standalone('promptPresetsId', ['render', 'interact', 'mutate']),
    ],
  },
  'settings:modules': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/Module/ModuleSettings.svelte', 'src/ts/process/modules.ts'],
    requirements: [
      group('modules', ['render', 'interact', 'mutate']),
      collection('modules', ['render', 'interact', 'mutate']),
    ],
  },
  'settings:hotkeys': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/HotkeySettings.svelte'],
    requirements: [group('sidebar', ['render', 'interact', 'mutate'], ['hotkeys'])],
  },
  'settings:agent-presets': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/AgentPresetSettings.svelte'],
    requirements: [group('agents', ['render', 'interact', 'mutate'])],
  },
  'settings:input-hooks': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/InputHookSettings.svelte'],
    requirements: [
      group('advanced', ['render', 'interact', 'mutate'], ['inputHooks']),
      group('models', ['render', 'interact']),
      group('providers', ['render', 'interact']),
    ],
  },
  'settings:request-history': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/RequestHistorySettings.svelte'],
    requirements: [],
    notes: 'Request history is fetched through its operational API.',
  },
  'settings:source-code': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/SourceCode.svelte'],
    requirements: [],
  },
  'settings:supporter': {
    family: 'settings',
    owners: ['src/lib/Setting/Pages/ThanksPage.svelte'],
    requirements: [],
  },

  'playground:menu': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundMenu.svelte'],
    requirements: [],
  },
  'playground:chat': {
    family: 'playground',
    owners: ['src/lib/ChatScreens/DefaultChatScreen.svelte'],
    requirements: [collection('promptTemplate', ['interact', 'generate'])],
  },
  'playground:embedding': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundEmbedding.svelte', 'src/ts/server/embeddingOperations.ts'],
    requirements: [
      group('memory', ['render', 'interact', 'mutate']),
      group('providers', ['interact']),
      group('models', ['interact']),
      group('runtime', ['interact']),
    ],
  },
  'playground:tokenizer': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundTokenizer.svelte', 'src/ts/tokenizer.ts'],
    requirements: [
      group('providers', ['render', 'interact']),
      group('models', ['render', 'interact']),
      group('runtime', ['interact']),
    ],
  },
  'playground:syntax': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundSyntax.svelte', 'src/ts/process/scriptings.ts'],
    requirements: [
      group('advanced', ['interact']),
      group('modules', ['interact']),
      collection('modules', ['interact']),
    ],
  },
  'playground:jinja': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundJinja.svelte', 'src/ts/process/prompt.ts'],
    requirements: [
      group('providers', ['interact']),
      group('models', ['interact']),
      group('runtime', ['interact']),
      group('prompt', ['interact']),
      collection('promptTemplate', ['interact']),
    ],
  },
  'playground:image-generation': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundImageGen.svelte', 'src/ts/server/imageGeneration.ts'],
    requirements: [
      group('media', ['render', 'interact']),
      group('providers', ['interact']),
      group('models', ['interact']),
      group('runtime', ['interact']),
    ],
  },
  'playground:parser': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundParser.svelte', 'src/ts/process/scriptings.ts'],
    requirements: [
      group('advanced', ['interact']),
      group('modules', ['interact']),
      collection('modules', ['interact']),
      collection('plugins', ['interact']),
    ],
  },
  'playground:subtitles': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundSubtitle.svelte'],
    requirements: [
      group('language', ['render', 'interact']),
      group('providers', ['render', 'interact']),
      group('models', ['render', 'interact']),
      group('runtime', ['render', 'interact']),
    ],
  },
  'playground:image-translation': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundImageTrans.svelte'],
    requirements: [
      group('language', ['render', 'interact']),
      group('media', ['render', 'interact']),
      group('providers', ['interact']),
      group('models', ['interact']),
      group('runtime', ['interact']),
    ],
  },
  'playground:translation': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundTranslation.svelte', 'src/ts/translator/translator.ts'],
    requirements: [
      group('language', ['render', 'interact']),
      group('providers', ['interact']),
      group('models', ['interact']),
      group('runtime', ['interact']),
      collection('translatorPresets', ['render', 'interact']),
    ],
  },
  'playground:mcp': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundMCP.svelte', 'src/ts/process/mcp/mcp.ts'],
    requirements: [
      group('providers', ['render', 'interact']),
      group('models', ['interact']),
      group('runtime', ['interact']),
      collection('plugins', ['interact']),
      collection('pluginCustomStorage', ['interact']),
    ],
  },
  'playground:docs': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundDocs.svelte'],
    requirements: [group('advanced', ['render', 'interact']), group('modules', ['render', 'interact'])],
  },
  'playground:inlays': {
    family: 'playground',
    owners: ['src/lib/Playground/PlaygroundInlayExplorer.svelte'],
    requirements: [projection('inlay-catalog', ['render', 'interact'])],
  },
  'playground:tools': {
    family: 'playground',
    owners: ['src/lib/Playground/ToolConversion.svelte'],
    requirements: [],
  },

  'runtime:plugins': {
    family: 'runtime',
    owners: ['src/ts/plugins/plugins.svelte.ts'],
    requirements: [
      group('providers', ['interact'], ['currentPluginProvider']),
      group('advanced', ['interact'], ['pluginCompatibilityMode', 'pluginDevelopMode']),
      collection('plugins', ['interact']),
      collection('pluginCustomStorage', ['interact', 'mutate']),
    ],
  },
  'runtime:translation': {
    family: 'runtime',
    owners: ['src/ts/translator/translator.ts', 'src/ts/server/greetingTranslations.svelte.ts'],
    requirements: [
      group('language', ['interact']),
      group('providers', ['interact']),
      group('models', ['interact']),
      group('runtime', ['interact']),
      collection('translatorPresets', ['interact']),
    ],
  },
  'runtime:chat-display': {
    family: 'runtime',
    owners: ['src/lib/ChatScreens/DefaultChatScreen.svelte', 'src/lib/ChatScreens/ChatBody.svelte'],
    requirements: [
      group('display', ['render']),
      group('advanced', ['render']),
      group('media', ['render']),
      group('modules', ['render']),
      group('agents', ['render']),
      group('language', ['render']),
      group('prompt', ['render']),
      collection('modules', ['render']),
      collection('promptPresets', ['render']),
      collection('personas', ['render']),
      standalone('selectedPersonaId', ['render']),
      standalone('selectedPersona', ['render']),
      standalone('personaPrompt', ['render']),
      standalone('userIcon', ['render']),
      standalone('userNote', ['render']),
    ],
    notes:
      'Initial transcript/greeting parsing needs display settings and effective module/persona inputs plus the separately initialized plugin runtime; generation recovery and background readiness do not gate display.',
  },
  'runtime:chat-generation': {
    family: 'runtime',
    owners: [
      'src/lib/ChatScreens/DefaultChatScreen.svelte',
      'src/ts/process/request/request.ts',
      'src/ts/process/prompt.ts',
      'src/ts/process/memory/hypav3.ts',
      'src/ts/process/recoveredGenerationEffects.ts',
    ],
    requirements: [
      group('providers', ['generate']),
      group('models', ['generate']),
      group('runtime', ['generate']),
      group('prompt', ['generate']),
      group('memory', ['generate']),
      group('media', ['generate']),
      group('advanced', ['generate']),
      group('sidebar', ['generate']),
      group('agents', ['generate']),
      group('modules', ['generate']),
      group('language', ['generate']),
      collection('plugins', ['generate']),
      collection('pluginCustomStorage', ['generate']),
      collection('modules', ['generate']),
      collection('modelPresets', ['generate']),
      collection('promptPresets', ['generate']),
      collection('botPresets', ['generate']),
      collection('promptTemplate', ['generate']),
      collection('personas', ['generate']),
      standalone('botPresetsId', ['generate']),
      standalone('modelPresetsId', ['generate']),
      standalone('promptPresetsId', ['generate']),
      standalone('selectedPersonaId', ['generate']),
      standalone('selectedPersona', ['generate']),
      projection('selected-character', ['generate']),
      projection('selected-chat', ['generate']),
      projection('selected-prompt-template', ['generate']),
    ],
    notes: 'Generation readiness composes this surface with selected detail and recovered active-work state.',
  },
  'runtime:background-effects': {
    family: 'runtime',
    owners: [
      'src/ts/server/customBackgroundSetting.ts',
      'src/ts/server/pushNotifications.ts',
      'src/ts/model/modellist.ts',
      'src/ts/process/modules.ts',
      'src/ts/stores/runtimeEffects.svelte.ts',
    ],
    requirements: [
      group('display', ['render'], ['customBackground', 'notification']),
      group('providers', ['interact']),
      group('models', ['interact']),
      group('memory', ['interact']),
      group('modules', ['interact']),
      group('prompt', ['interact']),
      group('agents', ['interact']),
      collection('modules', ['interact']),
    ],
    notes: 'These consumers run after shell readiness and must not become a shared render barrier.',
  },

  'overlay:preset-picker': {
    family: 'overlay',
    owners: ['src/lib/Others/QuickSettingsGUI.svelte'],
    requirements: [
      collection('modelPresets', ['render', 'interact', 'mutate']),
      collection('promptPresets', ['render', 'interact', 'mutate']),
      collection('botPresets', ['render', 'interact', 'mutate']),
    ],
  },
  'overlay:persona-picker': {
    family: 'overlay',
    owners: ['src/lib/SideBars/SideChatList.svelte'],
    requirements: [
      collection('personas', ['render', 'interact', 'mutate']),
      standalone('selectedPersonaId', ['render', 'interact', 'mutate']),
      standalone('selectedPersona', ['render', 'interact', 'mutate']),
    ],
  },
  'overlay:generation-toggle-presets': {
    family: 'overlay',
    owners: ['src/lib/SideBars/ChatGenerationTogglePresets.svelte'],
    requirements: [
      group('sidebar', ['render', 'interact', 'mutate'], ['chatGenerationTogglePresets']),
      projection('selected-character', ['interact', 'mutate']),
    ],
  },
  'overlay:bookmarks': {
    family: 'overlay',
    owners: ['src/lib/Others/BookmarkList.svelte'],
    requirements: [
      group('advanced', ['render'], ['enableBookmark']),
      projection('selected-character', ['render', 'interact', 'mutate']),
      projection('selected-chat', ['render', 'interact', 'mutate']),
    ],
  },
  'overlay:hypa-memory': {
    family: 'overlay',
    owners: [
      'src/lib/Others/HypaV3Modal.svelte',
      'src/lib/Others/HypaV3Progress.svelte',
      'src/ts/process/memory/hypav3.ts',
    ],
    requirements: [
      group('providers', ['generate']),
      group('models', ['generate']),
      group('runtime', ['generate']),
      group('memory', ['render', 'interact', 'mutate']),
      group('display', ['render'], ['hypaV3ProgressOpenChatOnly']),
      collection('hypaV3Presets', ['render', 'interact', 'mutate']),
      projection('selected-character', ['render', 'interact', 'mutate']),
      projection('selected-chat', ['render', 'interact', 'mutate']),
    ],
    notes:
      'The memory group owns selectedHypaV3PresetId; hypaV3PresetId is its derived numeric compatibility projection.',
  },
  'overlay:loadouts': {
    family: 'overlay',
    owners: ['src/lib/Others/LoadoutModal.svelte'],
    requirements: [
      collection('loadouts', ['render', 'interact', 'mutate']),
      projection('selected-character', ['interact', 'mutate']),
    ],
  },
  'overlay:iris': {
    family: 'overlay',
    owners: ['src/lib/Others/IrisModal.svelte'],
    requirements: [
      group('language', ['render', 'interact']),
      group('providers', ['interact']),
      group('models', ['interact']),
      group('runtime', ['interact']),
    ],
  },
  'overlay:popup-editor': {
    family: 'overlay',
    owners: ['src/lib/Others/PopupEditor.svelte', 'src/lib/Others/MonacoEditor.svelte'],
    requirements: [
      group(
        'sidebar',
        ['render', 'interact'],
        ['globalChatVariables', 'useMonacoEditorOnDesktop', 'useMonacoEditorOnMobile'],
      ),
    ],
  },
  'overlay:realm': {
    family: 'overlay',
    owners: ['src/lib/UI/Realm/RealmPopUp.svelte'],
    requirements: [group('display', ['render'], ['hideAllImages']), group('account', ['render', 'interact'])],
  },
  'overlay:custom-sidebar': {
    family: 'overlay',
    owners: ['src/lib/SideBars/CustomSidebar.svelte', 'src/lib/Others/CustomSidebarConfig.svelte'],
    requirements: [group('sidebar', ['render', 'interact', 'mutate'])],
  },
} as const satisfies Record<string, ResourceSurfaceDefinition>

export type ResourceSurfaceId = keyof typeof RESOURCE_SURFACE_MANIFEST

export const SETTINGS_RESOURCE_SURFACE_BY_INDEX = {
  0: 'settings:user-backup',
  1: 'settings:bot-model-prompt',
  2: 'settings:memory',
  3: 'settings:display',
  4: 'settings:plugins',
  6: 'settings:advanced',
  7: 'settings:communities',
  8: 'settings:global-lorebook',
  9: 'settings:global-regex',
  10: 'settings:language',
  11: 'settings:accessibility',
  12: 'settings:persona',
  13: 'settings:prompt-template',
  14: 'settings:modules',
  15: 'settings:hotkeys',
  17: 'settings:bot-model-prompt',
  18: 'settings:bot-model-prompt',
  19: 'settings:agent-presets',
  20: 'settings:input-hooks',
  21: 'settings:request-history',
  22: 'settings:source-code',
  23: 'settings:bardwiki',
  77: 'settings:supporter',
} as const satisfies Record<number, ResourceSurfaceId>

export const PLAYGROUND_RESOURCE_SURFACE_BY_INDEX = {
  1: 'playground:menu',
  2: 'playground:chat',
  3: 'playground:embedding',
  4: 'playground:tokenizer',
  5: 'playground:syntax',
  6: 'playground:jinja',
  7: 'playground:image-generation',
  8: 'playground:parser',
  9: 'playground:subtitles',
  10: 'playground:image-translation',
  11: 'playground:translation',
  12: 'playground:mcp',
  13: 'playground:docs',
  14: 'playground:inlays',
  101: 'playground:tools',
} as const satisfies Record<number, ResourceSurfaceId>

export function resourceSurfacesForRoute(route: AppRoute): ResourceSurfaceId[] {
  const surfaces: ResourceSurfaceId[] = ['shared:app-shell']

  switch (route.kind) {
    case 'home':
      return [...surfaces, 'route:home']
    case 'grid':
      return [...surfaces, 'route:grid']
    case 'inlay':
      return [...surfaces, 'route:inlay']
    case 'not-found':
      return [...surfaces, 'route:not-found']
    case 'settings': {
      surfaces.push('shared:settings-shell')
      const settingsSurface =
        SETTINGS_RESOURCE_SURFACE_BY_INDEX[route.index as keyof typeof SETTINGS_RESOURCE_SURFACE_BY_INDEX]
      if (settingsSurface) surfaces.push(settingsSurface)
      return surfaces
    }
    case 'playground': {
      surfaces.push('shared:playground-shell')
      const playgroundSurface =
        PLAYGROUND_RESOURCE_SURFACE_BY_INDEX[route.index as keyof typeof PLAYGROUND_RESOURCE_SURFACE_BY_INDEX]
      if (playgroundSurface) surfaces.push(playgroundSurface)
      if (route.index === 2) surfaces.push('runtime:chat-display', 'runtime:chat-generation')
      return surfaces
    }
    case 'character':
      surfaces.push('route:character')
      if (route.chatId) surfaces.push('route:character-chat', 'runtime:chat-display', 'runtime:chat-generation')
      return surfaces
  }
}

export function resourceRequirementIdentity(requirement: ResourceRequirement): string {
  switch (requirement.kind) {
    case 'settings-group':
      return `settings-group:${requirement.group}`
    case 'collection':
      return `collection:${requirement.collection}`
    case 'standalone-setting':
      return `standalone-setting:${requirement.setting}`
    case 'projection':
      return `projection:${requirement.projection}`
  }
}

export function resolveResourceRequirements(surfaceIds: readonly ResourceSurfaceId[]): ResourceRequirement[] {
  const resolved = new Map<string, ResourceRequirement>()

  for (const surfaceId of surfaceIds) {
    for (const requirement of RESOURCE_SURFACE_MANIFEST[surfaceId].requirements) {
      const identity = resourceRequirementIdentity(requirement)
      const previous = resolved.get(identity)
      if (!previous) {
        resolved.set(identity, cloneRequirement(requirement))
        continue
      }

      const purposes = [...new Set([...previous.purposes, ...requirement.purposes])]
      if (previous.kind === 'settings-group' && requirement.kind === 'settings-group') {
        const keys =
          previous.keys && requirement.keys ? [...new Set([...previous.keys, ...requirement.keys])] : undefined
        const { keys: _previousKeys, ...previousWithoutKeys } = previous
        resolved.set(identity, {
          ...previousWithoutKeys,
          ...(keys ? { keys } : {}),
          purposes,
        })
      } else {
        resolved.set(identity, { ...previous, purposes })
      }
    }
  }

  const providers = resolved.get('settings-group:providers')
  const models = resolved.get('settings-group:models')
  if (providers?.kind === 'settings-group' && models?.kind === 'settings-group') {
    const keys = providers.keys
      ? [...new Set([...providers.keys, ...(models.keys ?? MODEL_PROFILE_SETTINGS_KEYS)])]
      : undefined
    resolved.set('settings-group:providers', {
      ...providers,
      ...(keys ? { keys } : {}),
      purposes: [...new Set([...providers.purposes, ...models.purposes])],
    })
    resolved.delete('settings-group:models')
  }

  return [...resolved.values()]
}

function cloneRequirement(requirement: ResourceRequirement): ResourceRequirement {
  if (requirement.kind === 'settings-group') {
    return {
      ...requirement,
      ...(requirement.keys ? { keys: [...requirement.keys] } : {}),
      purposes: [...requirement.purposes],
    }
  }
  return { ...requirement, purposes: [...requirement.purposes] }
}
