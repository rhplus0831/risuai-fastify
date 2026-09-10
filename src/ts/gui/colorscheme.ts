import { get, writable } from 'svelte/store'
import type { Database } from '../storage/database.svelte'
import { downloadFile } from '../globalApi.svelte'
import { BufferToText } from '../util'
import { selectSingleFile } from '../filePicker'
import { alertError } from '../alert'
import { isLite } from '../lite'
import { CustomCSSStore, SafeModeStore } from '../stores.svelte'
import { applyServerBackedSettingsPatch } from '../server/settingsOwner.svelte'
import {
  beginColorSchemeImport,
  captureColorSchemeImportTarget,
  clearColorSchemeImport,
  isFreshColorSchemeImport,
  parseColorSchemeImport,
  resolveFreshColorSchemeImportPatch,
  type ColorSchemeImportFreshness,
  type ColorSchemeImportOperation,
} from '../server/colorSchemeImport'
import { language } from 'src/lang'
import { settingsResourceState } from '../server/resourceState.svelte'
import { cacheCustomCSS } from './customCSSCache'
import { runtimeDisplaySettingsOwner } from './displaySettings'
import { canUseClientWriteAccess } from '../clientSession'
import {
  applyDisplayStyles,
  cacheDisplaySettings,
  readDisplaySettingsCache,
  type DisplayStyleProperties,
} from './displaySettingsCache'

export interface ColorScheme {
  bgcolor: string
  darkbg: string
  borderc: string
  selected: string
  draculared: string
  textcolor: string
  textcolor2: string
  darkBorderc: string
  darkbutton: string
  type: 'light' | 'dark'
}

export const defaultColorScheme: ColorScheme = {
  bgcolor: '#282a36',
  darkbg: '#21222c',
  borderc: '#6272a4',
  selected: '#44475a',
  draculared: '#ff5555',
  textcolor: '#f8f8f2',
  textcolor2: '#94a3b8',
  darkBorderc: '#6272a4',
  darkbutton: '#374151',
  type: 'dark',
}

export const builtInColorSchemes = {
  default: defaultColorScheme,
  dark: {
    bgcolor: '#1a1a1a',
    darkbg: '#141414',
    borderc: '#737373',
    selected: '#3d3d3d',
    draculared: '#ff5555',
    textcolor: '#f5f5f5',
    textcolor2: '#a3a3a3',
    darkBorderc: '#737373',
    darkbutton: '#2e2e2e',
    type: 'dark',
  },
  light: {
    bgcolor: '#ffffff',
    darkbg: '#f0f0f0',
    borderc: '#0f172a',
    selected: '#e0e0e0',
    draculared: '#be123c',
    textcolor: '#0f172a',
    textcolor2: '#5b677a',
    darkBorderc: '#0f172a',
    darkbutton: '#e5e7eb',
    type: 'light',
  },
  cherry: {
    bgcolor: '#450a0a',
    darkbg: '#7f1d1d',
    borderc: '#fb923c',
    selected: '#9a3412',
    draculared: '#ff5555',
    textcolor: '#f8f8f2',
    textcolor2: '#fca5a5',
    darkBorderc: '#fdba74',
    darkbutton: '#b45309',
    type: 'dark',
  },
  galaxy: {
    bgcolor: '#0f172a',
    darkbg: '#1f2a48',
    borderc: '#8be9fd',
    selected: '#3b6f8f',
    draculared: '#ff5555',
    textcolor: '#f8f8f2',
    textcolor2: '#8be9fd',
    darkBorderc: '#457b9d',
    darkbutton: '#1f2a48',
    type: 'dark',
  },
  nature: {
    bgcolor: '#1b4332',
    darkbg: '#24553f',
    borderc: '#a8dadc',
    selected: '#2f6f63',
    draculared: '#fda4af',
    textcolor: '#f8f8f2',
    textcolor2: '#c4e4d4',
    darkBorderc: '#a8dadc',
    darkbutton: '#2d6a4f',
    type: 'dark',
  },
  ocean: {
    bgcolor: '#0b1f2a',
    darkbg: '#08202b',
    borderc: '#38bdf8',
    selected: '#164e63',
    draculared: '#fb7185',
    textcolor: '#e6f6fb',
    textcolor2: '#8fc7d5',
    darkBorderc: '#38bdf8',
    darkbutton: '#0f3a4a',
    type: 'dark',
  },
  aurora: {
    bgcolor: '#10201c',
    darkbg: '#152a24',
    borderc: '#5eead4',
    selected: '#315c52',
    draculared: '#fb7185',
    textcolor: '#ecfdf5',
    textcolor2: '#a7f3d0',
    darkBorderc: '#5eead4',
    darkbutton: '#21443c',
    type: 'dark',
  },
  twilight: {
    bgcolor: '#171324',
    darkbg: '#201936',
    borderc: '#c084fc',
    selected: '#3b2a5a',
    draculared: '#f43f5e',
    textcolor: '#f8f5ff',
    textcolor2: '#c4b5fd',
    darkBorderc: '#c084fc',
    darkbutton: '#2e2348',
    type: 'dark',
  },
  realblack: {
    bgcolor: '#000000',
    darkbg: '#000000',
    borderc: '#6272a4',
    selected: '#44475a',
    draculared: '#ff5555',
    textcolor: '#f8f8f2',
    textcolor2: '#718096',
    darkBorderc: '#6272a4',
    darkbutton: '#374151',
    type: 'dark',
  },
  'monokai-light': {
    bgcolor: '#f8f8f2',
    darkbg: '#e8e8e3',
    borderc: '#75715e',
    selected: '#d8d8d0',
    draculared: '#f92672',
    textcolor: '#181910',
    textcolor2: '#696555',
    darkBorderc: '#75715e',
    darkbutton: '#d0d0c8',
    type: 'light',
  },
  'monokai-black': {
    bgcolor: '#272822',
    darkbg: '#1e1f1a',
    borderc: '#75715e',
    selected: '#3e3d32',
    draculared: '#f92672',
    textcolor: '#f8f8f2',
    textcolor2: '#a6a68a',
    darkBorderc: '#75715e',
    darkbutton: '#3e3d32',
    type: 'dark',
  },
  'sky-light': {
    bgcolor: '#f6fbff',
    darkbg: '#e8f3fb',
    borderc: '#0284c7',
    selected: '#d7ecf8',
    draculared: '#e11d48',
    textcolor: '#0f172a',
    textcolor2: '#516174',
    darkBorderc: '#0284c7',
    darkbutton: '#dbeafe',
    type: 'light',
  },
  'sage-light': {
    bgcolor: '#f7faf5',
    darkbg: '#e8f0e6',
    borderc: '#3f6212',
    selected: '#d9e8d3',
    draculared: '#dc2626',
    textcolor: '#111827',
    textcolor2: '#586a52',
    darkBorderc: '#3f6212',
    darkbutton: '#dce8d6',
    type: 'light',
  },
  'lavender-light': {
    bgcolor: '#f8f7ff',
    darkbg: '#ede9fe',
    borderc: '#6d28d9',
    selected: '#ddd6fe',
    draculared: '#e11d48',
    textcolor: '#1e1b4b',
    textcolor2: '#5b5680',
    darkBorderc: '#6d28d9',
    darkbutton: '#e0e7ff',
    type: 'light',
  },
  'slate-light': {
    bgcolor: '#f8fafc',
    darkbg: '#e2e8f0',
    borderc: '#334155',
    selected: '#cbd5e1',
    draculared: '#dc2626',
    textcolor: '#020617',
    textcolor2: '#475569',
    darkBorderc: '#334155',
    darkbutton: '#cbd5e1',
    type: 'light',
  },
  lite: {
    bgcolor: '#1f2937',
    darkbg: '#1C2533',
    borderc: '#94a3b8',
    selected: '#475569',
    draculared: '#ff5555',
    textcolor: '#f8f8f2',
    textcolor2: '#94a3b8',
    darkBorderc: '#94a3b8',
    darkbutton: '#374151',
    type: 'dark',
  },
} as const

export type ColorSchemeAccessibilityIssue =
  | 'primaryText'
  | 'mutedText'
  | 'focusIndicator'
  | 'controlBorder'
  | 'selectedState'
  | 'controlState'
  | 'disabledState'
  | 'destructiveState'

function colorChannels(value: string): [number, number, number] | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value)
  return match ? [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)] : null
}

function relativeLuminance(value: string): number | null {
  const channels = colorChannels(value)
  if (!channels) return null
  const linear = channels.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

export function colorContrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  if (firstLuminance === null || secondLuminance === null) return 1
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

export function compositeColor(foreground: string, background: string, opacity: number): string {
  const foregroundChannels = colorChannels(foreground)
  const backgroundChannels = colorChannels(background)
  if (!foregroundChannels || !backgroundChannels) return background
  return `#${foregroundChannels
    .map((channel, index) =>
      Math.round(channel * opacity + backgroundChannels[index] * (1 - opacity))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

function minimumSurfaceContrast(color: string, scheme: ColorScheme): number {
  return Math.min(colorContrastRatio(color, scheme.bgcolor), colorContrastRatio(color, scheme.darkbg))
}

/** Report interaction-critical contrast gaps without mutating a custom palette. */
export function colorSchemeAccessibilityIssues(scheme: ColorScheme): ColorSchemeAccessibilityIssue[] {
  const issues: ColorSchemeAccessibilityIssue[] = []
  if (minimumSurfaceContrast(scheme.textcolor, scheme) < 4.5) issues.push('primaryText')
  if (minimumSurfaceContrast(scheme.textcolor2, scheme) < 4.5) issues.push('mutedText')
  if (minimumSurfaceContrast(scheme.borderc, scheme) < 3) issues.push('focusIndicator')
  if (minimumSurfaceContrast(scheme.darkBorderc, scheme) < 3) issues.push('controlBorder')
  if (colorContrastRatio(scheme.textcolor, scheme.selected) < 4.5) issues.push('selectedState')
  if (colorContrastRatio(scheme.textcolor, scheme.darkbutton) < 4.5) issues.push('controlState')
  if (
    Math.min(
      colorContrastRatio(compositeColor(scheme.textcolor, scheme.bgcolor, 0.5), scheme.bgcolor),
      colorContrastRatio(compositeColor(scheme.textcolor, scheme.darkbg, 0.5), scheme.darkbg),
    ) < 3
  ) {
    issues.push('disabledState')
  }
  if (minimumSurfaceContrast(scheme.draculared, scheme) < 3) issues.push('destructiveState')
  return issues
}

type LegacyBuiltInFields = Partial<Record<keyof ColorScheme, readonly string[]>>

const legacyBuiltInFieldValues: Partial<Record<keyof typeof builtInColorSchemes, LegacyBuiltInFields>> = {
  default: { textcolor2: ['#64748b'], darkBorderc: ['#4b5563'] },
  dark: { borderc: ['#525252'], darkBorderc: ['#404040'] },
  light: { textcolor2: ['#64748b'], draculared: ['#ff5555'], darkBorderc: ['#d1d5db'] },
  cherry: { borderc: ['#ea580c'], selected: ['#d97706'], darkBorderc: ['#92400e'] },
  galaxy: { selected: ['#457b9d'] },
  nature: {
    darkbg: ['#2d6a4f'],
    selected: ['#4d908e'],
    draculared: ['#ff5555'],
    textcolor2: ['#4d908e'],
    darkBorderc: ['#457b9d'],
  },
  ocean: { darkBorderc: ['#155e75'] },
  aurora: { darkBorderc: ['#2f6f63'] },
  twilight: { darkBorderc: ['#4c3575'] },
  realblack: { textcolor2: ['#64748b'], darkBorderc: ['#4b5563'] },
  'monokai-light': { textcolor: ['#272822'], textcolor2: ['#75715e'], darkBorderc: ['#c0c0b8'] },
  'monokai-black': { darkBorderc: ['#3e3d32'] },
  'sky-light': { darkBorderc: ['#b7d7ea'] },
  'sage-light': { textcolor: ['#1f2933'], darkBorderc: ['#b7c9ad'] },
  'lavender-light': { darkBorderc: ['#c4b5fd'] },
  'slate-light': { darkBorderc: ['#94a3b8'] },
  lite: { borderc: ['#475569'], textcolor2: ['#64748b'], darkBorderc: ['#030712'] },
}

/** Upgrade only exact legacy built-in palettes; never rewrite custom themes. */
export function migrateLegacyBuiltInColorScheme(name: unknown, scheme: ColorScheme | null): ColorScheme | null {
  if (typeof name !== 'string' || name === 'custom' || !scheme) return scheme
  if (!(name in builtInColorSchemes)) return scheme

  const schemeName = name as keyof typeof builtInColorSchemes
  const current = builtInColorSchemes[schemeName]
  const legacyFields = legacyBuiltInFieldValues[schemeName] ?? {}
  let matchedLegacyValue = false
  for (const key of Object.keys(current) as Array<keyof ColorScheme>) {
    if (scheme[key].toLowerCase() === current[key].toLowerCase()) continue
    const matchesLegacy = legacyFields[key]?.some((value) => value.toLowerCase() === scheme[key].toLowerCase())
    if (!matchesLegacy) return scheme
    matchedLegacyValue = true
  }
  return matchedLegacyValue ? ({ ...current } as ColorScheme) : scheme
}

export const ColorSchemeTypeStore = writable<'dark' | 'light'>(
  readDisplaySettingsCache().styles['--risu-theme-color-scheme'] === 'light' ? 'light' : 'dark',
)

export const colorSchemePresets = builtInColorSchemes

export const colorSchemeList = Object.keys(builtInColorSchemes) as (keyof typeof builtInColorSchemes)[]

function displaySettingsOwner(): Partial<Database> | undefined {
  const status = settingsResourceState.groupStatuses.display ?? 'idle'
  if (status === 'ready') return settingsResourceState.value as Partial<Database>
  return undefined
}

export function changeColorScheme(colorScheme: string) {
  try {
    const patch: Record<string, unknown> = { colorSchemeName: colorScheme }
    if (colorScheme === 'custom') {
      const settings = displaySettingsOwner()
      if (!settings) return
      patch.colorScheme = safeStructuredClone(settings.customColorScheme ?? defaultColorScheme)
    } else {
      patch.colorScheme = safeStructuredClone(builtInColorSchemes[colorScheme])
    }
    applyServerBackedSettingsPatch(patch)
    updateColorScheme()
  } catch (error) {}
}

export function updateCustomColorScheme(customColorScheme?: ColorScheme) {
  try {
    const settings = customColorScheme ? undefined : displaySettingsOwner()
    if (!customColorScheme && !settings) return
    const scheme = safeStructuredClone(customColorScheme ?? settings?.customColorScheme ?? defaultColorScheme)
    applyServerBackedSettingsPatch({
      customColorScheme: scheme,
      colorScheme: safeStructuredClone(scheme),
      colorSchemeName: 'custom',
    })
    updateColorScheme()
  } catch (error) {}
}

export function updateColorScheme() {
  try {
    const db = runtimeDisplaySettingsOwner()
    if (!db) return

    let colorScheme = db.colorScheme

    if (colorScheme == null) {
      colorScheme = safeStructuredClone(defaultColorScheme)
    }

    const migratedColorScheme = migrateLegacyBuiltInColorScheme(db.colorSchemeName, colorScheme)
    if (migratedColorScheme !== colorScheme) {
      colorScheme = migratedColorScheme
      if (canUseClientWriteAccess()) applyServerBackedSettingsPatch({ colorScheme })
    }

    if (get(isLite)) {
      colorScheme = safeStructuredClone(builtInColorSchemes.lite)
    }

    applyDisplayStyles({
      '--risu-theme-bgcolor': colorScheme.bgcolor,
      '--risu-theme-darkbg': colorScheme.darkbg,
      '--risu-theme-borderc': colorScheme.borderc,
      '--risu-theme-selected': colorScheme.selected,
      '--risu-theme-draculared': colorScheme.draculared,
      '--risu-theme-textcolor': colorScheme.textcolor,
      '--risu-theme-textcolor2': colorScheme.textcolor2,
      '--risu-theme-darkborderc': colorScheme.darkBorderc,
      '--risu-theme-darkbutton': colorScheme.darkbutton,
      '--risu-theme-color-scheme': colorScheme.type,
    })
    ColorSchemeTypeStore.set(colorScheme.type)
  } catch (error) {}
}

export function changeColorSchemeType(type: 'light' | 'dark') {
  try {
    const settings = displaySettingsOwner()
    if (!settings) return
    updateCustomColorScheme({
      ...settings.customColorScheme,
      type,
    })
    updateTextThemeAndCSS()
  } catch (error) {}
}

export function exportColorScheme() {
  const settings = displaySettingsOwner()
  if (!settings) return
  const json = JSON.stringify(settings.customColorScheme)
  downloadFile('colorScheme.json', json)
}

function currentColorSchemeImportFreshness(): ColorSchemeImportFreshness | undefined {
  const db = displaySettingsOwner()
  if (!db) return undefined
  return {
    colorSchemeName: db.colorSchemeName,
    colorScheme: db.colorScheme,
    customColorScheme: db.customColorScheme,
  }
}

export async function importColorScheme() {
  const initialFreshness = currentColorSchemeImportFreshness()
  if (!initialFreshness) return
  const target = captureColorSchemeImportTarget(initialFreshness)
  let operation: ColorSchemeImportOperation | null = null
  const beginImport = () => {
    operation ??= beginColorSchemeImport(target)
  }

  try {
    const uarray = await selectSingleFile(['json'], { onFileSelected: beginImport })
    if (uarray == null) {
      return
    }

    beginImport()
    const string = BufferToText(uarray.data)
    const colorScheme = parseColorSchemeImport(string)
    if (!colorScheme) {
      alertError('Invalid color scheme')
      return
    }

    if (!operation) {
      return
    }

    const freshness = currentColorSchemeImportFreshness()
    if (!freshness) return
    const patch = resolveFreshColorSchemeImportPatch({
      operation,
      freshness,
      colorScheme,
    })
    if (!patch) {
      alertError(language.fileSelectionStale)
      return
    }

    applyServerBackedSettingsPatch(patch)
    updateColorScheme()
  } catch (e) {
    const freshness = currentColorSchemeImportFreshness()
    if (operation && freshness && isFreshColorSchemeImport(operation, freshness)) {
      alertError('Invalid color scheme')
    }
    return
  } finally {
    if (operation) {
      clearColorSchemeImport(operation)
    }
  }
}

export function updateTextThemeAndCSS() {
  const db = runtimeDisplaySettingsOwner()
  if (!db) return

  const customCSS = db.customCSS ?? ''
  cacheCustomCSS(customCSS)
  const displayedCustomCSS = get(SafeModeStore) ? '' : customCSS
  if (get(CustomCSSStore) !== displayedCustomCSS) CustomCSSStore.set(displayedCustomCSS)

  const styles: DisplayStyleProperties = {}
  const textTheme = get(isLite) ? 'standard' : db.textTheme
  const colorScheme = get(isLite) ? 'dark' : db.colorScheme?.type
  switch (textTheme) {
    case 'standard': {
      styles['--FontColorStandard'] = colorScheme === 'dark' ? '#fafafa' : '#0f172a'
      styles['--FontColorItalic'] = '#8C8D93'
      styles['--FontColorBold'] = styles['--FontColorStandard']
      styles['--FontColorItalicBold'] = '#8C8D93'
      styles['--FontColorQuote1'] = '#8BE9FD'
      styles['--FontColorQuote2'] = '#FFB86C'
      break
    }
    case 'highcontrast': {
      styles['--FontColorStandard'] = colorScheme === 'dark' ? '#f8f8f2' : '#0f172a'
      styles['--FontColorItalic'] = '#F1FA8C'
      styles['--FontColorBold'] = '#8BE9FD'
      styles['--FontColorItalicBold'] = '#FFB86C'
      styles['--FontColorQuote1'] = '#8BE9FD'
      styles['--FontColorQuote2'] = '#FFB86C'
      break
    }
    case 'custom': {
      styles['--FontColorStandard'] = db.customTextTheme?.FontColorStandard
      styles['--FontColorItalic'] = db.customTextTheme?.FontColorItalic
      styles['--FontColorBold'] = db.customTextTheme?.FontColorBold
      styles['--FontColorItalicBold'] = db.customTextTheme?.FontColorItalicBold
      styles['--FontColorQuote1'] = db.customTextTheme?.FontColorQuote1 ?? '#8BE9FD'
      styles['--FontColorQuote2'] = db.customTextTheme?.FontColorQuote2 ?? '#FFB86C'
      break
    }
  }

  switch (db.font) {
    case 'default': {
      styles['--risu-font-family'] = 'Arial, sans-serif'
      break
    }
    case 'timesnewroman': {
      styles['--risu-font-family'] = 'Times New Roman, serif'
      break
    }
    case 'custom': {
      styles['--risu-font-family'] = db.customFont
      break
    }
  }
  applyDisplayStyles(styles)
  cacheDisplaySettings(db, ['textTheme', 'customTextTheme', 'font', 'customFont'])
}
