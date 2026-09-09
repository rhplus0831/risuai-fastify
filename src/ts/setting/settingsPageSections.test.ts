// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { accessibilitySettingsItems, accessibilitySettingsSections } from './accessibilitySettingsData'
import { advancedSettingsItems, advancedSettingsSections } from './advancedSettingsData'
import {
  displayChatSettingsSections,
  displayLayoutSettingsSections,
  displaySettingsItems,
  displaySoundSettingsSections,
  displayThemeSettingsSections,
} from './displaySettingsData.svelte'
import { languageSupplementalSettingsItems } from './languageSettingsData.svelte'
import { memorySettingsItems } from './memorySettingsData'
import { modelSupplementalSettingsItems, modelSupplementalSettingsSections } from './modelSupplementalSettingsData'
import { pluginSupplementalSettingsItems, pluginSupplementalSettingsSections } from './pluginSupplementalSettingsData'
import { promptSupplementalSettingsItems, promptSupplementalSettingsSections } from './promptSupplementalSettingsData'
import type { SettingItem, SettingSection } from './types'
import { getFullSettingsData } from './utils'

const sections: SettingSection[] = [
  ...accessibilitySettingsSections,
  ...advancedSettingsSections,
  ...displayThemeSettingsSections,
  ...displayLayoutSettingsSections,
  ...displayChatSettingsSections,
  ...displaySoundSettingsSections,
  ...modelSupplementalSettingsSections,
  ...pluginSupplementalSettingsSections,
  ...promptSupplementalSettingsSections,
]

const catalog: SettingItem[] = [
  ...accessibilitySettingsItems,
  ...advancedSettingsItems,
  ...displaySettingsItems,
  ...languageSupplementalSettingsItems,
  ...memorySettingsItems,
  ...modelSupplementalSettingsItems,
  ...pluginSupplementalSettingsItems,
  ...promptSupplementalSettingsItems,
]

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicateValues = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value)
    seen.add(value)
  }
  return [...duplicateValues]
}

describe('settings page organization', () => {
  it('keeps every catalog leaf ID unique after relocating settings', () => {
    expect(duplicates(catalog.map((item) => item.id))).toEqual([])
  })

  it('keeps visible section IDs unique', () => {
    expect(duplicates(sections.map((section) => section.id))).toEqual([])
  })

  it('renders every reorganized catalog item exactly once', () => {
    const pageLevelIds = new Set(['acc.header', 'adv.header', 'adv.warn'])
    const expected = catalog.map((item) => item.id).filter((id) => !pageLevelIds.has(id))
    const rendered = [
      ...sections.flatMap((section) => section.items.map((item) => item.id)),
      ...languageSupplementalSettingsItems.map((item) => item.id),
      ...memorySettingsItems.map((item) => item.id),
    ]

    expect(duplicates(rendered)).toEqual([])
    expect([...rendered].sort()).toEqual([...expected].sort())
  })

  it('keeps dependent controls in the same visible section', () => {
    const sectionFor = (id: string) => sections.find((section) => section.items.some((item) => item.id === id))?.id

    expect(sectionFor('acc.autoScrollToNewMessage')).toBe(sectionFor('acc.alwaysScrollToNewMessage'))
    expect(sectionFor('display.notification')).toBe(sectionFor('display.autoTranslateNotificationDeferCapSeconds'))
    expect(sectionFor('display.customQuotes')).toBe(sectionFor('display.leadingDoubleQuote'))
    expect(sectionFor('adv.complexRegexCompatibilityMode')).toBe(sectionFor('adv.complexRegexInputTimeoutMs'))
  })

  it('keeps relocated leaf IDs available to settings search and Custom Sidebar lookup', () => {
    const allSettings = getFullSettingsData()
    const relocatedIds = [
      'acc.hypaV3ProgressOpenChatOnly',
      'acc.showTranslationLoading',
      'acc.applyAdditionalParamsToAll',
      'adv.heightMode',
      'adv.openAIFlex',
      'adv.devMode',
      'adv.export',
      'display.useLegacyGUI',
    ]

    for (const id of relocatedIds) {
      expect(
        allSettings.filter((item) => item.id === id),
        id,
      ).toHaveLength(1)
    }
  })
})
