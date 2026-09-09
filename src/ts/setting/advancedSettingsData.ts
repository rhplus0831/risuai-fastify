import type { SettingItem, SettingSection } from './types'
import {
  MAX_REGEX_OUTPUT_SIZE_LIMIT_MIB,
  MIN_REGEX_OUTPUT_SIZE_LIMIT_MIB,
} from '@risuai/shared-core/regex-output-size-limit'

export const advancedSettingsItems: SettingItem[] = [
  {
    type: 'header',
    id: 'adv.header',
    labelKey: 'advancedSettings',
    options: { level: 'h2' },
    classes: '!mb-0',
  },
  {
    type: 'header',
    id: 'adv.warn',
    labelKey: 'advancedSettingsWarn',
    options: { level: 'warning' },
  },

  { type: 'custom', id: 'adv.diagnostics', componentId: 'DiagnosticsPanel' },

  // Legacy settings navigation
  {
    id: 'adv.showGlobalLorebookAndRegex',
    type: 'check',
    labelKey: 'showGlobalLorebookAndRegex',
    bindKey: 'showGlobalLorebookAndRegex',
    helpKey: 'showGlobalLorebookAndRegex',
    keywords: ['global lorebook', 'global regex', 'legacy menus', 'modules'],
    classes: 'mt-4',
  },

  // Performance and loading
  {
    id: 'adv.chatLoadInitial',
    type: 'number',
    labelKey: 'chatLoadInitialPages',
    bindKey: 'chatLoadInitialPages',
    helpKey: 'chatLoadInitialPages',
    classes: 'mt-4',
    options: { min: 1 },
  },
  {
    id: 'adv.chatLoadAdditional',
    type: 'number',
    labelKey: 'chatLoadAdditionalPages',
    bindKey: 'chatLoadAdditionalPages',
    helpKey: 'chatLoadAdditionalPages',
    options: { min: 1 },
  },
  {
    id: 'adv.assetAlloc',
    type: 'number',
    labelKey: 'assetMaxDifference',
    bindKey: 'assetMaxDifference',
  },

  // Request Location (Non-Node)
  {
    id: 'adv.reqLoc',
    type: 'segmented',
    labelKey: 'requestLocation',
    bindKey: 'requestLocation',
    condition: () => false,
    options: {
      segmentOptions: [
        { value: '', label: 'Default' },
        { value: 'eu', label: 'EU (GDPR)' },
        { value: 'fedramp', label: 'US (FedRAMP)' },
      ],
    },
  },

  // Toggles
  {
    id: 'adv.showUnrec',
    type: 'check',
    labelKey: 'showUnrecommended',
    bindKey: 'showUnrecommended',
    helpKey: 'showUnrecommended',
    classes: 'mt-4',
  },
  {
    id: 'adv.doNotWarnExternalServers',
    type: 'check',
    labelKey: 'doNotWarnExternalServers',
    bindKey: 'doNotWarnExternalServers',
    keywords: ['external', 'server', 'warning'],
    classes: 'mt-4',
  },
  {
    id: 'adv.imgComp',
    type: 'check',
    labelKey: 'imageCompression',
    bindKey: 'imageCompression',
    helpKey: 'imageCompression',
    classes: 'mt-4',
  },
  {
    id: 'adv.useExp',
    type: 'check',
    labelKey: 'useExperimental',
    bindKey: 'useExperimental',
    helpKey: 'useExperimental',
    classes: 'mt-4',
  },

  // Lorebook stubs (EXPERIMENTAL, Fastify-only).
  {
    id: 'adv.lorebookStubsWarn',
    type: 'header',
    fallbackLabel:
      'NOT RECOMMENDED — experimental. "Enable lorebook stubs" lazily loads each ' +
      "character's lorebook from the server instead of shipping it all up front. The " +
      'full client lorebook reader surface has NOT been validated against stubs, so ' +
      'lorebook entries may not appear or save correctly. Requires validation in the ' +
      'real app — leave this off unless you are testing it.',
    options: { level: 'warning' },
    classes: 'mt-4',
  },
  {
    id: 'adv.lorebookStubs',
    type: 'check',
    fallbackLabel: 'Enable lorebook stubs',
    bindKey: 'enableLorebookStubs',
    showExperimental: true,
  },
  {
    id: 'adv.legacyMedia',
    type: 'check',
    labelKey: 'legacyMediaFindings',
    bindKey: 'legacyMediaFindings',
    helpKey: 'legacyMediaFindings',
    classes: 'mt-4',
  },
  {
    id: 'adv.allowExt',
    type: 'check',
    fallbackLabel: 'Allow all in file select',
    bindKey: 'allowAllExtentionFiles',
    classes: 'mt-4',
  },
  // Experimental Section (visible when useExperimental is true)
  {
    id: 'adv.exp.cachePoint',
    type: 'check',
    labelKey: 'automaticCachePoint',
    bindKey: 'automaticCachePoint',
    condition: (ctx) => ctx.db.useExperimental,
    helpKey: 'automaticCachePoint',
    showExperimental: true,
    classes: 'mt-4',
  },
  // Unrecommended Section
  {
    id: 'adv.cot',
    type: 'check',
    labelKey: 'cot',
    bindKey: 'chainOfThought',
    condition: (ctx) => ctx.db.showUnrecommended,
    helpKey: 'customChainOfThought',
    helpUnrecommended: true,
    classes: 'mt-4',
  },

  // More Toggles
  {
    id: 'adv.devTools',
    type: 'check',
    labelKey: 'enableDevTools',
    bindKey: 'enableDevTools',
    classes: 'mt-4',
  },

  // Node Specific
  {
    id: 'adv.promptInfo',
    type: 'check',
    labelKey: 'promptInfoInsideChat',
    bindKey: 'promptInfoInsideChat',
    helpKey: 'promptInfoInsideChatDesc',
    classes: 'mt-4',
  },
  {
    id: 'adv.promptTextInfo',
    type: 'check',
    labelKey: 'promptTextInfoInsideChat',
    bindKey: 'promptTextInfoInsideChat',
    condition: (ctx) => ctx.db.promptInfoInsideChat,
    classes: 'mt-4',
  },
  // Dynamic Assets & Others
  {
    id: 'adv.dynAssets',
    type: 'check',
    labelKey: 'dynamicAssets',
    bindKey: 'dynamicAssets',
    helpKey: 'dynamicAssets',
    classes: 'mt-4',
  },
  {
    id: 'adv.cssErr',
    type: 'check',
    labelKey: 'returnCSSError',
    bindKey: 'returnCSSError',
    classes: 'mt-4',
  },
  {
    id: 'acc.requestInfoInsideChat',
    type: 'check',
    labelKey: 'requestInfoInsideChat',
    bindKey: 'requestInfoInsideChat',
    keywords: ['request', 'info', 'chat'],
  },
  {
    id: 'acc.inlayErrorResponse',
    type: 'check',
    labelKey: 'inlayErrorResponse',
    bindKey: 'inlayErrorResponse',
    keywords: ['inlay', 'error', 'response'],
  },
  { type: 'custom', id: 'adv.export', componentId: 'SettingsExportButtons' },
  {
    id: 'adv.toolUsage',
    type: 'check',
    labelKey: 'rememberToolUsage',
    bindKey: 'rememberToolUsage',
    classes: 'mt-4',
  },
  {
    id: 'adv.bookmark',
    type: 'check',
    labelKey: 'bookmark',
    bindKey: 'enableBookmark',
    classes: 'mt-4',
  },
  {
    id: 'adv.simpleTool',
    type: 'check',
    labelKey: 'simplifiedToolUse',
    bindKey: 'simplifiedToolUse',
    classes: 'mt-4',
  },
  {
    id: 'adv.tokCache',
    type: 'check',
    labelKey: 'useTokenizerCaching',
    bindKey: 'useTokenizerCaching',
    classes: 'mt-4',
  },
  {
    id: 'adv.strictScriptCheck',
    type: 'check',
    labelKey: 'strictScriptCheck',
    bindKey: 'strictScriptCheck',
    helpKey: 'strictScriptCheck',
    keywords: ['lua', 'script', 'alertInput', 'alertSelect', 'alertConfirm'],
    classes: 'mt-4',
  },
  {
    id: 'adv.regexOutputSizeLimitMiB',
    type: 'number',
    labelKey: 'regexOutputSizeLimitMiB',
    bindKey: 'regexOutputSizeLimitMiB',
    helpKey: 'regexOutputSizeLimitMiB',
    keywords: ['regex', 'regular expression', 'out', 'replacement', 'output', 'size', 'limit'],
    classes: 'mt-4',
    options: {
      min: MIN_REGEX_OUTPUT_SIZE_LIMIT_MIB,
      max: MAX_REGEX_OUTPUT_SIZE_LIMIT_MIB,
      step: 1,
    },
  },
  {
    id: 'adv.complexRegexCompatibilityMode',
    type: 'select',
    labelKey: 'complexRegexCompatibilityMode',
    bindKey: 'complexRegexCompatibilityMode',
    helpKey: 'complexRegexCompatibilityMode',
    helpUnrecommended: true,
    classes: 'mt-4',
    options: {
      selectOptions: [
        { value: 'strict', labelKey: 'complexRegexStrictMode' },
        { value: 'worker', labelKey: 'complexRegexWorkerMode' },
      ],
    },
  },
  {
    id: 'adv.complexRegexInputTimeoutMs',
    type: 'number',
    labelKey: 'complexRegexInputTimeoutMs',
    bindKey: 'complexRegexInputTimeoutMs',
    condition: (ctx) => ctx.db.complexRegexCompatibilityMode === 'worker',
    containerClasses: 'pl-7',
    options: { min: 0, max: 60000, step: 1000 },
  },
  {
    id: 'adv.complexRegexOutputTimeoutMs',
    type: 'number',
    labelKey: 'complexRegexOutputTimeoutMs',
    bindKey: 'complexRegexOutputTimeoutMs',
    condition: (ctx) => ctx.db.complexRegexCompatibilityMode === 'worker',
    containerClasses: 'pl-7',
    options: { min: 0, max: 60000, step: 1000 },
  },
  {
    id: 'adv.complexRegexDisplayTimeoutMs',
    type: 'number',
    labelKey: 'complexRegexDisplayTimeoutMs',
    bindKey: 'complexRegexDisplayTimeoutMs',
    condition: (ctx) => ctx.db.complexRegexCompatibilityMode === 'worker',
    containerClasses: 'pl-7',
    options: { min: 0, max: 60000, step: 1000 },
  },

  // Dynamic Assets Edit (Condition: dynamicAssets)
  {
    id: 'adv.dynAssetsEdit',
    type: 'check',
    labelKey: 'dynamicAssetsEditDisplay',
    bindKey: 'dynamicAssetsEditDisplay',
    condition: (ctx) => ctx.db.dynamicAssets,
    helpKey: 'dynamicAssetsEditDisplay',
    classes: 'mt-4',
  },

  // Unrecommended Extra (Condition: showUnrecommended)
  {
    id: 'adv.plainFetch',
    type: 'check',
    labelKey: 'forcePlainFetch',
    bindKey: 'usePlainFetch',
    condition: (ctx) => ctx.db.showUnrecommended,
    helpKey: 'forcePlainFetch',
    helpUnrecommended: true,
    classes: 'mt-4',
  },
  {
    id: 'adv.depTrig',
    type: 'check',
    labelKey: 'showDeprecatedTriggerV1',
    bindKey: 'showDeprecatedTriggerV1',
    condition: (ctx) => ctx.db.showUnrecommended,
    helpKey: 'unrecommended',
    helpUnrecommended: true,
    classes: 'mt-4',
  },
  {
    id: 'adv.enableRisuaiProTools',
    type: 'check',
    labelKey: 'enableRisuaiProTools',
    bindKey: 'enableRisuaiProTools',
    condition: (ctx) => ctx.db.showUnrecommended || ctx.db.enableRisuaiProTools === true,
    helpKey: 'risuaiProToolsDeprecated',
    helpUnrecommended: true,
    deprecated: true,
    keywords: ['pro', 'tools', 'easy panel', 'deprecated', 'legacy', 'advanced'],
    classes: 'mt-4',
  },

  {
    id: 'display.useLegacyGUI',
    type: 'check',
    labelKey: 'useLegacyGUI',
    bindKey: 'useLegacyGUI',
    keywords: ['legacy', 'gui'],
  },
]

function advancedItems(ids: string[]): SettingItem[] {
  return ids.map((id) => {
    const item = advancedSettingsItems.find((candidate) => candidate.id === id)
    if (!item) throw new Error(`Unknown advanced setting: ${id}`)
    return item
  })
}

export const advancedSettingsSections: SettingSection[] = [
  {
    id: 'feature-access',
    labelKey: 'settingsSectionAdvancedFeatureAccess',
    descriptionKey: 'settingsSectionAdvancedFeatureAccessDescription',
    items: advancedItems(['adv.showUnrec', 'adv.useExp']),
  },
  {
    id: 'performance-media',
    labelKey: 'settingsSectionPerformanceMedia',
    items: advancedItems([
      'adv.chatLoadInitial',
      'adv.chatLoadAdditional',
      'adv.assetAlloc',
      'adv.imgComp',
      'adv.legacyMedia',
      'adv.allowExt',
      'adv.dynAssets',
      'adv.dynAssetsEdit',
      'adv.tokCache',
    ]),
  },
  {
    id: 'request-response',
    labelKey: 'settingsSectionRequestResponse',
    items: advancedItems([
      'adv.reqLoc',
      'adv.doNotWarnExternalServers',
      'adv.cot',
      'adv.toolUsage',
      'adv.bookmark',
      'adv.simpleTool',
    ]),
  },
  {
    id: 'scripting-regex',
    labelKey: 'settingsSectionScriptingRegex',
    collapsible: true,
    items: advancedItems([
      'adv.strictScriptCheck',
      'adv.regexOutputSizeLimitMiB',
      'adv.complexRegexCompatibilityMode',
      'adv.complexRegexInputTimeoutMs',
      'adv.complexRegexOutputTimeoutMs',
      'adv.complexRegexDisplayTimeoutMs',
    ]),
  },
  {
    id: 'developer-diagnostics',
    labelKey: 'settingsSectionDeveloperDiagnostics',
    collapsible: true,
    items: advancedItems([
      'adv.diagnostics',
      'adv.devTools',
      'adv.promptInfo',
      'adv.promptTextInfo',
      'adv.cssErr',
      'acc.requestInfoInsideChat',
      'acc.inlayErrorResponse',
      'adv.export',
    ]),
  },
  {
    id: 'experimental',
    labelKey: 'settingsSectionExperimental',
    descriptionKey: 'settingsSectionExperimentalDescription',
    badgeKey: 'settingsBadgeExperimental',
    collapsible: true,
    items: advancedItems(['adv.lorebookStubsWarn', 'adv.lorebookStubs', 'adv.exp.cachePoint']),
  },
  {
    id: 'legacy-compatibility',
    labelKey: 'settingsSectionLegacyCompatibility',
    descriptionKey: 'settingsSectionLegacyCompatibilityDescription',
    badgeKey: 'settingsBadgeLegacy',
    collapsible: true,
    items: advancedItems([
      'adv.showGlobalLorebookAndRegex',
      'adv.plainFetch',
      'adv.depTrig',
      'adv.enableRisuaiProTools',
      'display.useLegacyGUI',
    ]),
  },
]
