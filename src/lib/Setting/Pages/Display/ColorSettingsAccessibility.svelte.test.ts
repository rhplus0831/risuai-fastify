import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const colorSettingsState = vi.hoisted(() => ({
  database: {} as Record<string, any>,
  applyServerBackedSetting: vi.fn(),
  changeColorScheme: vi.fn(),
  colorSchemeAccessibilityIssues: vi.fn(() => ['focusIndicator']),
  updateCustomColorScheme: vi.fn(),
}))

const darkPalette = vi.hoisted(
  () =>
    ({
      type: 'dark',
      bgcolor: '#111111',
      darkbg: '#222222',
      borderc: '#333333',
      selected: '#444444',
      draculared: '#555555',
      darkBorderc: '#666666',
      darkbutton: '#777777',
      textcolor: '#eeeeee',
      textcolor2: '#dddddd',
    }) as const,
)

vi.mock('src/ts/server/resourceState.svelte', () => ({
  settingsResourceState: {
    get value() {
      return colorSettingsState.database
    },
    groupStatuses: { display: 'ready' },
  },
}))
vi.mock('src/ts/storage/database.svelte', () => ({
  getDatabase: () => colorSettingsState.database,
}))
vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  applyServerBackedSetting: colorSettingsState.applyServerBackedSetting,
}))
vi.mock('src/ts/gui/colorscheme', () => ({
  changeColorScheme: colorSettingsState.changeColorScheme,
  changeColorSchemeType: vi.fn(),
  colorSchemeAccessibilityIssues: colorSettingsState.colorSchemeAccessibilityIssues,
  colorSchemeList: ['default', 'dark'],
  colorSchemePresets: { default: darkPalette, dark: darkPalette },
  defaultColorScheme: darkPalette,
  exportColorScheme: vi.fn(),
  importColorScheme: vi.fn(),
  updateColorScheme: vi.fn(),
  updateCustomColorScheme: colorSettingsState.updateCustomColorScheme,
  updateTextThemeAndCSS: vi.fn(),
}))

import CustomColorSchemeEditor from './CustomColorSchemeEditor.svelte'
import CustomTextThemeEditor from './CustomTextThemeEditor.svelte'
import ColorSchemeSelect from './ColorSchemeSelect.svelte'
import NullableTextColorToggle from './NullableTextColorToggle.svelte'
import { language } from 'src/lang'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function accessibleName(input: HTMLInputElement): string {
  return input.getAttribute('aria-label') || input.closest('label')?.textContent?.trim() || ''
}

function visibleRowLabel(input: HTMLInputElement): string {
  const row = input.closest<HTMLElement>('.flex.items-center.mt-2')
  const label = Array.from(row?.children ?? []).find((child) => child instanceof HTMLSpanElement)
  return label?.textContent?.trim() ?? ''
}

async function expectColorInputsMatchVisibleLabels(expectedCount: number): Promise<void> {
  await vi.waitFor(() => {
    expect(target.querySelectorAll<HTMLInputElement>('input[type="color"]')).toHaveLength(expectedCount)
  })

  for (const input of target.querySelectorAll<HTMLInputElement>('input[type="color"]')) {
    const visibleLabel = visibleRowLabel(input)
    expect(visibleLabel).not.toBe('')
    expect(accessibleName(input)).toBe(visibleLabel)
  }
}

beforeEach(() => {
  colorSettingsState.database = {
    colorSchemeName: 'custom',
    colorScheme: { ...darkPalette },
    customColorScheme: { ...darkPalette },
    textTheme: 'custom',
    customTextTheme: {
      FontColorStandard: '#111111',
      FontColorItalic: '#222222',
      FontColorBold: '#333333',
      FontColorItalicBold: '#444444',
      FontColorQuote1: '#555555',
      FontColorQuote2: '#666666',
    },
    textScreenColor: '#123456',
    textScreenBorder: '#654321',
  }
  target = document.createElement('div')
  document.body.appendChild(target)
  colorSettingsState.applyServerBackedSetting.mockClear()
  colorSettingsState.changeColorScheme.mockClear()
  colorSettingsState.colorSchemeAccessibilityIssues.mockClear()
  colorSettingsState.updateCustomColorScheme.mockClear()
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
})

describe('display color setting names', () => {
  it('names the visual color-scheme cards and exposes their selected state', async () => {
    component = mount(ColorSchemeSelect, { target })
    await tick()

    const group = target.querySelector('[role="group"]')
    const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>('button.risu-card'))

    expect(group?.getAttribute('aria-label')).toBe(language.colorScheme)
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      language.colorSchemePresetNames.default,
      language.colorSchemePresetNames.dark,
      language.colorSchemePresetNames.custom,
    ])
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
    expect(buttons.every((button) => button.querySelector('.palette-wheel-fill'))).toBe(true)
  })

  it('names every custom color-scheme input from its visible setting label', async () => {
    component = mount(CustomColorSchemeEditor, { target })
    await tick()

    await expectColorInputsMatchVisibleLabels(9)
  })

  it('warns about weak custom relationships without rewriting the palette', async () => {
    component = mount(CustomColorSchemeEditor, { target })
    await tick()

    const warning = target.querySelector('[data-risu-custom-color-contrast-warning]')
    expect(warning?.getAttribute('role')).toBe('status')
    expect(warning?.textContent).toContain(language.customColorContrastWarning(1))
    expect(warning?.textContent).toContain(language.colorSchemeContrastIssues.focusIndicator)
    expect(colorSettingsState.updateCustomColorScheme).not.toHaveBeenCalled()
  })

  it('updates a custom palette from the lightweight native color controls', async () => {
    component = mount(CustomColorSchemeEditor, { target })
    await tick()

    const input = target.querySelector<HTMLInputElement>('input[type="color"]')!
    input.value = '#abcdef'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(colorSettingsState.updateCustomColorScheme).toHaveBeenCalledOnce()
    expect(colorSettingsState.updateCustomColorScheme).toHaveBeenCalledWith(
      expect.objectContaining({ bgcolor: '#abcdef' }),
    )
  })

  it('names every custom text-theme input from its visible setting label', async () => {
    component = mount(CustomTextThemeEditor, { target })
    await tick()

    await expectColorInputsMatchVisibleLabels(6)
    expect(
      Array.from(target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'), (checkbox) =>
        checkbox.closest('label')?.textContent?.trim(),
      ),
    ).toEqual([`${language.disable}: Single Quote Text`, `${language.disable}: Double Quote Text`])
  })

  it('uses the same localized setting name for the nullable checkbox and color input', async () => {
    component = mount(NullableTextColorToggle, {
      target,
      props: {
        field: 'textScreenColor',
        labelKey: 'textBackgrounds',
        defaultColor: '#000000',
      },
    })
    await tick()

    const checkbox = target.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const colorInput = target.querySelector<HTMLInputElement>('input[type="color"]')
    const visibleLabel = visibleRowLabel(colorInput!)

    expect(visibleLabel).toBe(language.textBackgrounds)
    expect(checkbox?.getAttribute('aria-label')).toBe(visibleLabel)
    expect(accessibleName(colorInput!)).toBe(visibleLabel)
  })

  it('commits a nullable native color only on the change boundary', async () => {
    component = mount(NullableTextColorToggle, {
      target,
      props: {
        field: 'textScreenColor',
        labelKey: 'textBackgrounds',
        defaultColor: '#000000',
      },
    })
    await tick()

    const colorInput = target.querySelector<HTMLInputElement>('input[type="color"]')!
    colorInput.value = '#abcdef'
    colorInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(colorSettingsState.applyServerBackedSetting).not.toHaveBeenCalled()

    colorInput.dispatchEvent(new Event('change', { bubbles: true }))
    expect(colorSettingsState.applyServerBackedSetting).toHaveBeenCalledOnce()
    expect(colorSettingsState.applyServerBackedSetting).toHaveBeenCalledWith('textScreenColor', '#abcdef')
  })
})
