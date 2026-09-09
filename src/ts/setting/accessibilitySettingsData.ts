/**
 * Accessibility Settings Data
 *
 * Data-driven definition of all settings in AccessibilitySettings page.
 */

import type { SettingItem, SettingSection } from './types'
import { language } from 'src/lang'
import { updateReducedMotion } from '../gui/animation'

export const accessibilitySettingsItems: SettingItem[] = [
  // Header
  {
    id: 'acc.header',
    type: 'header',
    labelKey: 'interactionAccessibility',
    options: { level: 'h2' },
  },

  // Checkboxes
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
    id: 'acc.askRemoval',
    type: 'check',
    labelKey: 'askRemoval',
    bindKey: 'askRemoval',
    keywords: ['ask', 'removal', 'confirm', 'delete'],
  },
  {
    id: 'acc.swipe',
    type: 'check',
    labelKey: 'SwipeRegenerate',
    bindKey: 'swipe',
    keywords: ['swipe', 'regenerate', 'gesture'],
  },
  {
    id: 'acc.instantRemove',
    type: 'check',
    labelKey: 'instantRemove',
    bindKey: 'instantRemove',
    keywords: ['instant', 'remove', 'delete'],
  },
  {
    id: 'acc.sendWithEnter',
    type: 'check',
    labelKey: 'sendWithEnter',
    bindKey: 'sendWithEnter',
    keywords: ['send', 'enter', 'keyboard', 'submit'],
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
    id: 'acc.clickToEdit',
    type: 'check',
    labelKey: 'clickToEdit',
    bindKey: 'clickToEdit',
    keywords: ['click', 'edit', 'message'],
  },
  {
    id: 'acc.disableAutoPopupMessageEditor',
    type: 'check',
    labelKey: 'disableAutoPopupMessageEditor',
    bindKey: 'disableAutoPopupMessageEditor',
    keywords: ['disable', 'auto', 'popup', 'editor', 'message', 'edit'],
  },
  {
    id: 'acc.enableBlockPartialEdit',
    type: 'check',
    labelKey: 'enableBlockPartialEdit',
    bindKey: 'enableBlockPartialEdit',
    keywords: ['partial', 'edit', 'block', 'hover'],
  },
  {
    id: 'acc.longPressToPopupEditor',
    type: 'check',
    labelKey: 'longPressToPopupEditor',
    bindKey: 'longPressToPopupEditor',
    keywords: ['long', 'press', 'popup', 'editor'],
  },
  {
    id: 'acc.useMonacoEditorOnDesktop',
    type: 'check',
    labelKey: 'useMonacoEditorOnDesktop',
    bindKey: 'useMonacoEditorOnDesktop',
    keywords: ['monaco', 'editor', 'popup', 'desktop', 'textarea'],
  },
  {
    id: 'acc.useMonacoEditorOnMobile',
    type: 'check',
    labelKey: 'useMonacoEditorOnMobile',
    bindKey: 'useMonacoEditorOnMobile',
    keywords: ['monaco', 'editor', 'popup', 'mobile', 'textarea'],
  },
  {
    id: 'acc.enableDragPartialEdit',
    type: 'check',
    labelKey: 'enableDragPartialEdit',
    bindKey: 'enableDragPartialEdit',
    keywords: ['partial', 'edit', 'drag', 'selection'],
  },
  {
    id: 'acc.botSettingAtStart',
    type: 'check',
    labelKey: 'botSettingAtStart',
    bindKey: 'botSettingAtStart',
    keywords: ['bot', 'setting', 'start', 'open'],
  },
  {
    id: 'acc.showMenuChatList',
    type: 'check',
    labelKey: 'showMenuChatList',
    bindKey: 'showMenuChatList',
    keywords: ['menu', 'chat', 'list', 'show'],
  },
  {
    id: 'acc.showMenuHypaMemoryModal',
    type: 'check',
    labelKey: 'showMenuHypaMemoryModal',
    bindKey: 'showMenuHypaMemoryModal',
    keywords: ['menu', 'hypa', 'memory', 'modal'],
  },
  {
    id: 'acc.goCharacterOnImport',
    type: 'check',
    labelKey: 'goCharacterOnImport',
    bindKey: 'goCharacterOnImport',
    keywords: ['character', 'import', 'navigate'],
  },
  {
    id: 'acc.sideMenuRerollButton',
    type: 'check',
    labelKey: 'sideMenuRerollButton',
    bindKey: 'sideMenuRerollButton',
    keywords: ['side', 'menu', 'reroll', 'button'],
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
    id: 'acc.createFolderOnBranch',
    type: 'check',
    labelKey: 'createFolderOnBranch',
    bindKey: 'createFolderOnBranch',
    keywords: ['create', 'folder', 'branch'],
  },
  {
    id: 'acc.hamburgerButtonBottom',
    type: 'check',
    labelKey: 'hamburgerButtonBottom',
    bindKey: 'hamburgerButtonBottom',
    keywords: ['hamburger', 'button', 'bottom', 'menu', 'sidebar', 'accessibility'],
  },
  {
    id: 'adv.scrollToActive',
    type: 'check',
    labelKey: 'enableScrollToActiveChar',
    bindKey: 'enableScrollToActiveChar',
    helpKey: 'enableScrollToActiveChar',
    classes: 'mt-4',
  },
  { type: 'custom', id: 'acc.customSidebarConfig', componentId: 'CustomSidebarConfig' },
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
    id: 'composer-keyboard',
    labelKey: 'settingsSectionComposerKeyboard',
    descriptionKey: 'settingsSectionComposerKeyboardDescription',
    items: settingItems([
      'acc.sendWithEnter',
      'acc.fixedChatTextarea',
      'acc.floatingChatInput',
      'acc.useMonacoEditorOnDesktop',
      'acc.useMonacoEditorOnMobile',
    ]),
  },
  {
    id: 'message-editing',
    labelKey: 'settingsSectionMessageEditing',
    descriptionKey: 'settingsSectionMessageEditingDescription',
    items: settingItems([
      'acc.clickToEdit',
      'acc.disableAutoPopupMessageEditor',
      'acc.enableBlockPartialEdit',
      'acc.enableDragPartialEdit',
      'acc.longPressToPopupEditor',
      'acc.askRemoval',
      'acc.instantRemove',
    ]),
  },
  {
    id: 'navigation-controls',
    labelKey: 'settingsSectionNavigationControls',
    descriptionKey: 'settingsSectionNavigationControlsDescription',
    items: settingItems([
      'acc.swipe',
      'acc.botSettingAtStart',
      'acc.showMenuChatList',
      'acc.showMenuHypaMemoryModal',
      'acc.goCharacterOnImport',
      'acc.sideMenuRerollButton',
      'acc.createFolderOnBranch',
      'acc.hamburgerButtonBottom',
      'adv.scrollToActive',
      'acc.customSidebarConfig',
    ]),
  },
]
