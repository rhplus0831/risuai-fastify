/** Chat input, editing, and navigation preferences. Keep existing IDs stable for saved shortcuts. */
import type { SettingItem, SettingSection } from './types'

export const interactionSettingsItems: SettingItem[] = [
  { id: 'interaction.header', type: 'header', labelKey: 'settingsNavInteraction', options: { level: 'h2' } },
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
    id: 'acc.createFolderOnBranch',
    type: 'check',
    labelKey: 'createFolderOnBranch',
    bindKey: 'createFolderOnBranch',
    keywords: ['create', 'folder', 'branch'],
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
    const item = interactionSettingsItems.find((candidate) => candidate.id === id)
    if (!item) throw new Error(`Unknown interaction setting: ${id}`)
    return item
  })
}

export const interactionSettingsSections: SettingSection[] = [
  {
    id: 'composer-keyboard',
    labelKey: 'settingsSectionComposerKeyboard',
    descriptionKey: 'settingsSectionComposerKeyboardDescription',
    items: settingItems(['acc.sendWithEnter', 'acc.useMonacoEditorOnDesktop', 'acc.useMonacoEditorOnMobile']),
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
      'adv.scrollToActive',
      'acc.customSidebarConfig',
    ]),
  },
]
