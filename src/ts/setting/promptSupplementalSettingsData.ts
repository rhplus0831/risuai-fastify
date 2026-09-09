import type { SettingItem, SettingSection } from './types'

export const promptSupplementalSettingsItems: SettingItem[] = [
  {
    id: 'adv.addPrompt',
    type: 'text',
    labelKey: 'additionalPrompt',
    bindKey: 'additionalPrompt',
    helpKey: 'additionalPrompt',
    classes: 'mt-4',
  },
  {
    id: 'adv.descPrefix',
    type: 'text',
    labelKey: 'descriptionPrefix',
    bindKey: 'descriptionPrefix',
  },
  {
    id: 'adv.sayNothing',
    type: 'check',
    labelKey: 'sayNothing',
    bindKey: 'useSayNothing',
    helpKey: 'sayNothing',
    classes: 'mt-4',
  },
  {
    type: 'custom',
    id: 'adv.banChar',
    componentId: 'BanCharacterSetSettings',
    componentProps: { noAccordion: true },
  },
]

export const promptSupplementalSettingsSections: SettingSection[] = [
  {
    id: 'advanced-prompt-behavior',
    labelKey: 'settingsSectionAdvancedPromptBehavior',
    descriptionKey: 'settingsSectionAdvancedPromptBehaviorDescription',
    collapsible: true,
    items: promptSupplementalSettingsItems,
  },
]
