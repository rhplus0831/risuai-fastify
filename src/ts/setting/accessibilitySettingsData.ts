/** Motion, scrolling, and input reachability settings. */
import type { SettingItem, SettingSection } from './types'
import { language } from 'src/lang'
import { updateReducedMotion } from '../gui/animation'

export const accessibilitySettingsItems: SettingItem[] = [
  {
    id: 'acc.header',
    type: 'header',
    labelKey: 'settingsNavAccessibility',
    options: { level: 'h2' },
  },
  {
    id: 'acc.reducedMotion',
    type: 'check',
    labelKey: 'reducedMotion',
    helpKey: 'reducedMotion',
    bindKey: 'reducedMotion',
    onChange: () => updateReducedMotion(),
    keywords: ['reduced', 'motion', 'animation', 'accessibility'],
  },
  {
    id: 'acc.fixedChatTextarea',
    type: 'check',
    labelKey: 'fixedChatTextarea',
    bindKey: 'fixedChatTextarea',
    keywords: ['fixed', 'chat', 'textarea', 'input', 'composer', 'dock'],
  },
  {
    id: 'acc.floatingChatInput',
    type: 'check',
    labelKey: 'floatingChatInput',
    helpKey: 'floatingChatInput',
    bindKey: 'floatingChatInput',
    getValue: (db) => db.floatingChatInput ?? true,
    condition: (ctx) => ctx.db.fixedChatTextarea !== true,
    keywords: ['floating', 'chat', 'input', 'composer', 'accessibility'],
  },
  {
    id: 'acc.autoScrollToNewMessage',
    type: 'check',
    labelKey: 'autoScrollToNewMessage',
    bindKey: 'autoScrollToNewMessage',
    keywords: ['auto', 'scroll', 'new', 'message'],
  },
  {
    id: 'acc.alwaysScrollToNewMessage',
    type: 'check',
    labelKey: 'alwaysScrollToNewMessage',
    bindKey: 'alwaysScrollToNewMessage',
    condition: (ctx) => ctx.db.autoScrollToNewMessage,
    keywords: ['always', 'scroll', 'new', 'message'],
  },
  {
    id: 'acc.newMessageButtonStyle',
    type: 'select',
    labelKey: 'newMessageButtonStyle',
    bindKey: 'newMessageButtonStyle',
    condition: (ctx) => ctx.db.autoScrollToNewMessage && !ctx.db.alwaysScrollToNewMessage,
    options: {
      selectOptions: [
        { value: 'bottom-center', label: language.newMessageButtonBottomCenter },
        { value: 'bottom-right', label: language.newMessageButtonBottomRight },
        { value: 'bottom-left', label: language.newMessageButtonBottomLeft },
        { value: 'floating-circle', label: language.newMessageButtonFloatingCircle },
        { value: 'right-center', label: language.newMessageButtonRightCenter },
        { value: 'top-bar', label: language.newMessageButtonTopBar },
      ],
    },
  },
  {
    id: 'acc.hamburgerButtonBottom',
    type: 'check',
    labelKey: 'hamburgerButtonBottom',
    bindKey: 'hamburgerButtonBottom',
    keywords: ['hamburger', 'button', 'bottom', 'menu', 'sidebar', 'accessibility'],
  },
]

function settingItems(ids: string[]): SettingItem[] {
  return ids.map((id) => {
    const item = accessibilitySettingsItems.find((candidate) => candidate.id === id)
    if (!item) throw new Error(`Unknown accessibility setting: ${id}`)
    return item
  })
}

export const accessibilitySettingsSections: SettingSection[] = [
  {
    id: 'motion-scrolling',
    labelKey: 'settingsSectionMotionScrolling',
    descriptionKey: 'settingsSectionMotionScrollingDescription',
    items: settingItems([
      'acc.reducedMotion',
      'acc.autoScrollToNewMessage',
      'acc.alwaysScrollToNewMessage',
      'acc.newMessageButtonStyle',
    ]),
  },
  {
    id: 'input-reachability',
    labelKey: 'settingsSectionInputReachability',
    descriptionKey: 'settingsSectionInputReachabilityDescription',
    items: settingItems(['acc.fixedChatTextarea', 'acc.floatingChatInput', 'acc.hamburgerButtonBottom']),
  },
]
