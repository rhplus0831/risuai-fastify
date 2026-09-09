import type { SettingItem, SettingSection } from './types'

export const modelSupplementalSettingsItems: SettingItem[] = [
  {
    id: 'acc.applyAdditionalParamsToAll',
    type: 'check',
    labelKey: 'applyAdditionalParamsToAll',
    bindKey: 'applyAdditionalParamsToAll',
    getValue: (db) => db.applyAdditionalParamsToAll === true,
    keywords: ['apply', 'additional', 'parameters', 'all', 'models'],
  },
  {
    id: 'adv.retries',
    type: 'number',
    labelKey: 'requestretrys',
    bindKey: 'requestRetrys',
    helpKey: 'requestretrys',
    options: { min: 0, max: 20 },
  },
  {
    id: 'adv.genTime',
    type: 'number',
    labelKey: 'genTimes',
    bindKey: 'genTime',
    helpKey: 'genTimes',
    options: { min: 0, max: 4096 },
  },
  {
    id: 'adv.visionQual',
    type: 'select',
    fallbackLabel: 'Vision Quality',
    bindKey: 'gptVisionQuality',
    helpKey: 'gptVisionQuality',
    options: {
      selectOptions: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ],
    },
  },
  {
    id: 'adv.autoFill',
    type: 'check',
    labelKey: 'autoFillRequestURL',
    bindKey: 'autofillRequestUrl',
    helpKey: 'autoFillRequestURL',
    classes: 'mt-4',
  },
  {
    id: 'adv.remIncomp',
    type: 'check',
    labelKey: 'removeIncompleteResponse',
    bindKey: 'removeIncompleteResponse',
    classes: 'mt-4',
  },
  {
    id: 'adv.newOai',
    type: 'check',
    labelKey: 'newOAIHandle',
    bindKey: 'newOAIHandle',
    classes: 'mt-4',
  },
  {
    id: 'adv.dynamicModelRegistry',
    type: 'check',
    labelKey: 'dynamicModelRegistry',
    bindKey: 'dynamicModelRegistry',
    classes: 'mt-4',
  },
  {
    id: 'adv.disableSeperateParameterChangeOnPresetChange',
    type: 'check',
    labelKey: 'disableSeperateParameterChangeOnPresetChange',
    bindKey: 'disableSeperateParameterChangeOnPresetChange',
    classes: 'mt-4',
  },
  {
    id: 'adv.openAIFlex',
    type: 'check',
    labelKey: 'openAIFlexProcessing',
    bindKey: 'openAIFlexProcessing',
    helpKey: 'openAIFlexProcessing',
    showExperimental: true,
    classes: 'mt-4',
  },
  {
    id: 'adv.claudeCache',
    type: 'check',
    labelKey: 'claude1HourCaching',
    bindKey: 'claude1HourCaching',
    classes: 'mt-4',
  },
  {
    type: 'custom',
    id: 'adv.customModels',
    componentId: 'CustomModelsSettings',
    componentProps: { noAccordion: true },
  },
]

export const modelSupplementalSettingsSections: SettingSection[] = [
  {
    id: 'advanced-model-behavior',
    labelKey: 'settingsSectionAdvancedModelBehavior',
    descriptionKey: 'settingsSectionAdvancedModelBehaviorDescription',
    collapsible: true,
    items: modelSupplementalSettingsItems,
  },
]
