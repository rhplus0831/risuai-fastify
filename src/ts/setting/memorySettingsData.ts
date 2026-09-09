import type { SettingItem } from './types'

export const memoryLongTermSettingsItems: SettingItem[] = [
  {
    id: 'acc.hypaV3ProgressOpenChatOnly',
    type: 'check',
    labelKey: 'hypaV3ProgressOpenChatOnly',
    helpKey: 'hypaV3ProgressOpenChatOnly',
    bindKey: 'hypaV3ProgressOpenChatOnly',
    keywords: ['hypa', 'memory', 'progress', 'chat', 'accessibility'],
  },
  {
    id: 'acc.localActivationInGlobalLorebook',
    type: 'check',
    labelKey: 'localActivationInGlobalLorebook',
    bindKey: 'localActivationInGlobalLorebook',
    keywords: ['local', 'activation', 'global', 'lorebook'],
  },
  {
    id: 'acc.bulkEnabling',
    type: 'check',
    labelKey: 'bulkEnabling',
    bindKey: 'bulkEnabling',
    keywords: ['bulk', 'enable', 'multiple'],
  },
  {
    id: 'adv.lbDepth',
    type: 'number',
    labelKey: 'loreBookDepth',
    bindKey: 'loreBookDepth',
    options: { min: 0, max: 20 },
    classes: 'mt-4 mb-2',
  },
  {
    id: 'adv.lbToken',
    type: 'number',
    labelKey: 'loreBookToken',
    bindKey: 'loreBookToken',
    options: { min: 0, max: 4096 },
  },
]

export const memoryEmotionSettingsItems: SettingItem[] = [
  {
    id: 'adv.emoPrompt',
    type: 'text',
    labelKey: 'emotionPrompt',
    bindKey: 'emotionPrompt2',
    helpKey: 'emotionPrompt',
    options: { placeholder: 'Leave it blank to use default' },
  },
  {
    id: 'adv.keiUrl',
    type: 'text',
    fallbackLabel: 'Kei Server URL',
    bindKey: 'keiServerURL',
    options: { placeholder: 'Leave it blank to use default' },
  },
]

export const memoryImageSettingsItems: SettingItem[] = [
  {
    id: 'adv.newImgBeta',
    type: 'check',
    labelKey: 'newImageHandlingBeta',
    bindKey: 'newImageHandlingBeta',
    classes: 'mt-4',
  },
]

export const memorySettingsItems: SettingItem[] = [
  ...memoryLongTermSettingsItems,
  ...memoryEmotionSettingsItems,
  ...memoryImageSettingsItems,
]
