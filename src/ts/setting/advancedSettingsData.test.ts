import { describe, expect, it, vi } from 'vitest'

vi.mock('../gui/heightMode', () => ({ updateHeightMode: vi.fn() }))

import { advancedSettingsItems } from './advancedSettingsData'
import { accessibilitySettingsItems } from './accessibilitySettingsData'
import { modelSupplementalSettingsItems } from './modelSupplementalSettingsData'

describe('advanced settings data', () => {
  it('includes configurable initial and additional chat load counts', () => {
    expect(advancedSettingsItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'adv.chatLoadInitial',
          type: 'number',
          bindKey: 'chatLoadInitialPages',
          helpKey: 'chatLoadInitialPages',
          options: { min: 1 },
        }),
        expect.objectContaining({
          id: 'adv.chatLoadAdditional',
          type: 'number',
          bindKey: 'chatLoadAdditionalPages',
          helpKey: 'chatLoadAdditionalPages',
          options: { min: 1 },
        }),
      ]),
    )
  })

  it('includes the experimental OpenAI Flex processing toggle', () => {
    expect(modelSupplementalSettingsItems).toContainEqual(
      expect.objectContaining({
        id: 'adv.openAIFlex',
        type: 'check',
        bindKey: 'openAIFlexProcessing',
        labelKey: 'openAIFlexProcessing',
        helpKey: 'openAIFlexProcessing',
        showExperimental: true,
      }),
    )
  })

  it('includes the legacy global lorebook and regex menu visibility toggle', () => {
    expect(advancedSettingsItems).toContainEqual(
      expect.objectContaining({
        id: 'adv.showGlobalLorebookAndRegex',
        type: 'check',
        bindKey: 'showGlobalLorebookAndRegex',
        labelKey: 'showGlobalLorebookAndRegex',
        helpKey: 'showGlobalLorebookAndRegex',
      }),
    )
  })

  it('includes the configurable regex output size limit', () => {
    expect(advancedSettingsItems).toContainEqual(
      expect.objectContaining({
        id: 'adv.regexOutputSizeLimitMiB',
        type: 'number',
        bindKey: 'regexOutputSizeLimitMiB',
        labelKey: 'regexOutputSizeLimitMiB',
        helpKey: 'regexOutputSizeLimitMiB',
        options: { min: 1, max: 64, step: 1 },
      }),
    )
  })

  it('moves deprecated RisuAI Pro Tools from Accessibility to Advanced settings', () => {
    const proTools = advancedSettingsItems.find((item) => item.id === 'adv.enableRisuaiProTools')

    expect(accessibilitySettingsItems.some((item) => item.bindKey === 'enableRisuaiProTools')).toBe(false)
    expect(proTools).toMatchObject({
      type: 'check',
      labelKey: 'enableRisuaiProTools',
      bindKey: 'enableRisuaiProTools',
      helpKey: 'risuaiProToolsDeprecated',
      helpUnrecommended: true,
      deprecated: true,
    })
    expect(proTools?.condition?.({ db: { showUnrecommended: false, enableRisuaiProTools: false } } as never)).toBe(
      false,
    )
    expect(proTools?.condition?.({ db: { showUnrecommended: true, enableRisuaiProTools: false } } as never)).toBe(true)
    expect(proTools?.condition?.({ db: { showUnrecommended: false, enableRisuaiProTools: true } } as never)).toBe(true)
  })

  it('does not advertise unsupported browser-side cold storage', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'coldstorage')).toBe(false)
  })

  it('does not advertise the retired browser remote-save encoder', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'enableRemoteSaving')).toBe(false)
  })

  it('does not advertise the legacy preset chain in server-backed generation', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'presetChain')).toBe(false)
  })

  it('does not advertise the removed Realm preview direct-open behavior', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'realmDirectOpen')).toBe(false)
  })
})
