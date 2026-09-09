import type { SettingItem, SettingSection } from './types'

export const pluginSupplementalSettingsItems: SettingItem[] = [
  {
    id: 'adv.devMode',
    type: 'check',
    labelKey: 'pluginDevelopMode',
    bindKey: 'pluginDevelopMode',
    classes: 'mt-4',
  },
  {
    id: 'adv.pluginCompatibilityMode',
    type: 'check',
    labelKey: 'pluginCompatibilityMode',
    bindKey: 'pluginCompatibilityMode',
    helpKey: 'pluginCompatibilityMode',
    helpUnrecommended: true,
    classes: 'mt-4',
  },
]

export const pluginSupplementalSettingsSections: SettingSection[] = [
  {
    id: 'plugin-compatibility',
    labelKey: 'settingsSectionPluginCompatibility',
    collapsible: true,
    items: pluginSupplementalSettingsItems,
  },
]
