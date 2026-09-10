import { beforeEach, describe, expect, it, vi } from 'vitest'

const colorSchemeMocks = vi.hoisted(() => ({
  alertError: vi.fn(),
  applyServerBackedSettingsPatch: vi.fn(),
  cacheCustomCSS: vi.fn(),
  database: {} as any,
  downloadFile: vi.fn(),
  selectSingleFile: vi.fn(),
  settingsResourceState: {
    value: {} as any,
    groupStatuses: { display: 'ready' },
    shellRevision: null as number | null,
    status: 'ready',
  },
  stores: {
    customCSS: createTestStore(''),
    safeMode: createTestStore(false),
  },
}))

function createTestStore<T>(initialValue: T) {
  let value = initialValue
  return {
    set: vi.fn((nextValue: T) => {
      value = nextValue
    }),
    subscribe(run: (value: T) => void) {
      run(value)
      return () => {}
    },
    value: () => value,
  }
}

vi.mock('../alert', () => ({
  alertError: colorSchemeMocks.alertError,
}))

vi.mock('../server/settingsOwner.svelte', () => ({
  applyServerBackedSettingsPatch: colorSchemeMocks.applyServerBackedSettingsPatch,
}))

vi.mock('../globalApi.svelte', () => ({
  downloadFile: colorSchemeMocks.downloadFile,
}))

vi.mock('./customCSSCache', () => ({
  cacheCustomCSS: colorSchemeMocks.cacheCustomCSS,
}))

vi.mock('../storage/database.svelte', () => ({
  getDatabase: () => colorSchemeMocks.database,
}))

vi.mock('../server/resourceState.svelte', () => ({
  settingsResourceState: colorSchemeMocks.settingsResourceState,
}))

vi.mock('../stores.svelte', () => ({
  CustomCSSStore: colorSchemeMocks.stores.customCSS,
  SafeModeStore: colorSchemeMocks.stores.safeMode,
}))

vi.mock('../util', () => ({
  BufferToText: (data: Uint8Array) => new TextDecoder().decode(data),
}))

vi.mock('../filePicker', () => ({
  selectSingleFile: colorSchemeMocks.selectSingleFile,
}))

import {
  builtInColorSchemes,
  changeColorScheme,
  colorContrastRatio,
  colorSchemeAccessibilityIssues,
  compositeColor,
  exportColorScheme,
  importColorScheme,
  migrateLegacyBuiltInColorScheme,
  updateColorScheme,
  updateCustomColorScheme,
  updateTextThemeAndCSS,
  type ColorScheme,
} from './colorscheme'
import { language } from 'src/lang'
import { isLite } from '../lite'
import { readDisplaySettingsCache } from './displaySettingsCache'

type SelectedFile = {
  name: string
  data: Uint8Array
}

type SelectSingleFileOptions = {
  onFileSelected?: (file: File) => void
}

function scheme(seed: string): ColorScheme {
  return {
    bgcolor: `#${seed}001`,
    darkbg: `#${seed}002`,
    borderc: `#${seed}003`,
    selected: `#${seed}004`,
    draculared: `#${seed}005`,
    textcolor: `#${seed}006`,
    textcolor2: `#${seed}007`,
    darkBorderc: `#${seed}008`,
    darkbutton: `#${seed}009`,
    type: 'dark',
  }
}

function selectedJsonFile(value: unknown): SelectedFile {
  return {
    name: 'colorScheme.json',
    data: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)),
  }
}

function createPicker() {
  let resolve!: (value: SelectedFile | null) => void
  const promise = new Promise<SelectedFile | null>((promiseResolve) => {
    resolve = promiseResolve
  })
  let options: SelectSingleFileOptions | undefined

  return {
    selectSingleFile: vi.fn((_extensions: string[], selectOptions?: SelectSingleFileOptions) => {
      options = selectOptions
      return promise
    }),
    resolve(value: SelectedFile | null) {
      if (value) {
        const data = value.data.buffer.slice(value.data.byteOffset, value.data.byteOffset + value.data.byteLength)
        options?.onFileSelected?.(new File([data as ArrayBuffer], value.name))
      }
      resolve(value)
    },
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  isLite.set(false)
  colorSchemeMocks.database = {
    colorSchemeName: 'default',
    colorScheme: scheme('aaa'),
    customColorScheme: scheme('aaa'),
  } as any
  colorSchemeMocks.settingsResourceState.value = colorSchemeMocks.database
  colorSchemeMocks.settingsResourceState.groupStatuses.display = 'ready'
  colorSchemeMocks.settingsResourceState.shellRevision = null
  colorSchemeMocks.settingsResourceState.status = 'ready'
  colorSchemeMocks.alertError.mockReset()
  colorSchemeMocks.applyServerBackedSettingsPatch.mockReset()
  colorSchemeMocks.cacheCustomCSS.mockReset()
  colorSchemeMocks.downloadFile.mockReset()
  colorSchemeMocks.selectSingleFile.mockReset()
  colorSchemeMocks.stores.customCSS.set('')
  colorSchemeMocks.stores.customCSS.set.mockClear()
  colorSchemeMocks.stores.safeMode.set(false)
  colorSchemeMocks.stores.safeMode.set.mockClear()
  colorSchemeMocks.applyServerBackedSettingsPatch.mockImplementation((patch: Record<string, unknown>) => {
    Object.assign(colorSchemeMocks.database, patch)
  })
})

describe('custom CSS cache reconciliation', () => {
  it('replaces cached display CSS from the initial server shell', () => {
    colorSchemeMocks.database.customCSS = 'body { color: rebeccapurple; }'
    colorSchemeMocks.settingsResourceState.groupStatuses.display = 'idle'
    colorSchemeMocks.settingsResourceState.shellRevision = 7

    updateTextThemeAndCSS()

    expect(colorSchemeMocks.cacheCustomCSS).toHaveBeenCalledWith('body { color: rebeccapurple; }')
    expect(colorSchemeMocks.stores.customCSS.value()).toBe('body { color: rebeccapurple; }')
  })

  it('does not rewrite the live style when the server CSS matches the cached display', () => {
    colorSchemeMocks.database.customCSS = 'body { color: rebeccapurple; }'
    colorSchemeMocks.stores.customCSS.set('body { color: rebeccapurple; }')
    colorSchemeMocks.stores.customCSS.set.mockClear()

    updateTextThemeAndCSS()

    expect(colorSchemeMocks.cacheCustomCSS).toHaveBeenCalledWith('body { color: rebeccapurple; }')
    expect(colorSchemeMocks.stores.customCSS.set).not.toHaveBeenCalled()
  })

  it('refreshes the cache while Safe Mode keeps the live style disabled', () => {
    colorSchemeMocks.database.customCSS = 'body { color: rebeccapurple; }'
    colorSchemeMocks.stores.safeMode.set(true)

    updateTextThemeAndCSS()

    expect(colorSchemeMocks.cacheCustomCSS).toHaveBeenCalledWith('body { color: rebeccapurple; }')
    expect(colorSchemeMocks.stores.customCSS.value()).toBe('')
  })
})

describe('custom color scheme persistence', () => {
  it('restores the saved custom palette without replacing it when presets are selected', () => {
    const custom = scheme('bbb')
    colorSchemeMocks.database.customColorScheme = custom

    changeColorScheme('light')
    expect(colorSchemeMocks.database.colorScheme).toEqual(builtInColorSchemes.light)
    expect(colorSchemeMocks.database.customColorScheme).toEqual(custom)

    changeColorScheme('custom')
    expect(colorSchemeMocks.database.colorSchemeName).toBe('custom')
    expect(colorSchemeMocks.database.colorScheme).toEqual(custom)
  })

  it('updates the saved and active custom palettes together', () => {
    const custom = scheme('ccc')

    updateCustomColorScheme(custom)

    expect(colorSchemeMocks.applyServerBackedSettingsPatch).toHaveBeenLastCalledWith({
      customColorScheme: custom,
      colorScheme: custom,
      colorSchemeName: 'custom',
    })
    expect(colorSchemeMocks.database.customColorScheme).toEqual(custom)
    expect(colorSchemeMocks.database.colorScheme).toEqual(custom)
  })

  it('exports the saved custom palette even while a preset is active', () => {
    const custom = scheme('ddd')
    colorSchemeMocks.database.customColorScheme = custom
    colorSchemeMocks.database.colorScheme = builtInColorSchemes.light

    exportColorScheme()

    expect(colorSchemeMocks.downloadFile).toHaveBeenCalledWith('colorScheme.json', JSON.stringify(custom))
  })

  it('does not export a compatibility projection while the display owner is loading', () => {
    const compatibility = scheme('eee')
    colorSchemeMocks.database.customColorScheme = compatibility
    colorSchemeMocks.settingsResourceState.value = { customColorScheme: scheme('fff') }
    colorSchemeMocks.settingsResourceState.groupStatuses.display = 'loading'

    exportColorScheme()

    expect(colorSchemeMocks.downloadFile).not.toHaveBeenCalled()
  })

  it('fails closed when the display owner is in error', () => {
    colorSchemeMocks.settingsResourceState.groupStatuses.display = 'error'
    document.documentElement.style.removeProperty('--risu-theme-bgcolor')

    updateColorScheme()
    exportColorScheme()
    changeColorScheme('custom')

    expect(document.documentElement.style.getPropertyValue('--risu-theme-bgcolor')).toBe('')
    expect(colorSchemeMocks.downloadFile).not.toHaveBeenCalled()
    expect(colorSchemeMocks.applyServerBackedSettingsPatch).not.toHaveBeenCalled()
  })
})

describe('importColorScheme freshness', () => {
  it('does not apply a valid file after the scheme changed while selection was pending', async () => {
    const picker = createPicker()
    colorSchemeMocks.selectSingleFile.mockImplementation(picker.selectSingleFile)

    const importPromise = importColorScheme()
    await vi.waitFor(() => {
      expect(colorSchemeMocks.selectSingleFile).toHaveBeenCalledWith(['json'], expect.any(Object))
    })

    colorSchemeMocks.database.colorSchemeName = 'light'
    colorSchemeMocks.database.colorScheme = scheme('bbb')

    picker.resolve(selectedJsonFile(scheme('ccc')))
    await importPromise

    expect(colorSchemeMocks.applyServerBackedSettingsPatch).not.toHaveBeenCalled()
    expect(colorSchemeMocks.alertError).toHaveBeenCalledWith(language.fileSelectionStale)
    expect(colorSchemeMocks.database.colorSchemeName).toBe('light')
    expect(colorSchemeMocks.database.colorScheme).toEqual(scheme('bbb'))
  })

  it('reports an invalid stale file after the scheme changed while selection was pending', async () => {
    const picker = createPicker()
    colorSchemeMocks.selectSingleFile.mockImplementation(picker.selectSingleFile)

    const importPromise = importColorScheme()
    await vi.waitFor(() => {
      expect(colorSchemeMocks.selectSingleFile).toHaveBeenCalledWith(['json'], expect.any(Object))
    })

    colorSchemeMocks.database.colorSchemeName = 'custom'
    colorSchemeMocks.database.colorScheme = scheme('bbb')

    picker.resolve(selectedJsonFile('{'))
    await importPromise

    expect(colorSchemeMocks.applyServerBackedSettingsPatch).not.toHaveBeenCalled()
    expect(colorSchemeMocks.alertError).toHaveBeenCalledWith('Invalid color scheme')
  })

  it('lets a newer selected import win over an older delayed import', async () => {
    const olderPicker = createPicker()
    const newerPicker = createPicker()
    colorSchemeMocks.selectSingleFile
      .mockImplementationOnce(olderPicker.selectSingleFile)
      .mockImplementationOnce(newerPicker.selectSingleFile)

    const olderImport = importColorScheme()
    const newerImport = importColorScheme()
    await vi.waitFor(() => {
      expect(colorSchemeMocks.selectSingleFile).toHaveBeenCalledTimes(2)
    })

    newerPicker.resolve(selectedJsonFile(scheme('bbb')))
    await flushAsync()
    olderPicker.resolve(selectedJsonFile(scheme('ccc')))

    await Promise.all([olderImport, newerImport])

    expect(colorSchemeMocks.applyServerBackedSettingsPatch.mock.calls).toEqual([
      [
        {
          colorSchemeName: 'custom',
          colorScheme: scheme('bbb'),
          customColorScheme: scheme('bbb'),
        },
      ],
    ])
    expect(colorSchemeMocks.database.colorScheme).toEqual(scheme('bbb'))
    expect(colorSchemeMocks.database.customColorScheme).toEqual(scheme('bbb'))
    expect(colorSchemeMocks.alertError).toHaveBeenCalledWith(language.fileSelectionStale)
  })
})

describe('built-in color scheme contrast', () => {
  it.each(Object.entries(builtInColorSchemes))(
    '%s keeps reviewed text and interaction relationships distinguishable',
    (_name, colorScheme) => {
      expect(colorSchemeAccessibilityIssues(colorScheme)).toEqual([])
    },
  )

  it('reports custom palette gaps without rewriting the supplied values', () => {
    const custom = {
      ...builtInColorSchemes.default,
      borderc: '#282a36',
      darkBorderc: '#282a36',
      textcolor2: '#282a36',
      draculared: '#282a36',
    } as ColorScheme
    const before = structuredClone(custom)

    expect(colorSchemeAccessibilityIssues(custom)).toEqual(
      expect.arrayContaining(['mutedText', 'focusIndicator', 'controlBorder', 'destructiveState']),
    )
    expect(custom).toEqual(before)
  })

  it.each(Object.entries(builtInColorSchemes))('%s keeps a modal edge visible over the 70% scrim', (_name, scheme) => {
    const scrimmedPage = compositeColor('#000000', scheme.bgcolor, 0.7)
    expect(
      Math.max(colorContrastRatio(scheme.darkbg, scrimmedPage), colorContrastRatio(scheme.darkBorderc, scrimmedPage)),
    ).toBeGreaterThanOrEqual(3)
  })
})

describe('native control color scheme', () => {
  it('applies and caches the shell palette before the Display group is ready', () => {
    colorSchemeMocks.settingsResourceState.groupStatuses.display = 'idle'
    colorSchemeMocks.settingsResourceState.shellRevision = 7
    colorSchemeMocks.database.colorScheme = { ...builtInColorSchemes.light }
    updateColorScheme()
    expect(document.documentElement.style.getPropertyValue('--risu-theme-bgcolor')).toBe('#ffffff')
    expect(readDisplaySettingsCache().styles['--risu-theme-color-scheme']).toBe('light')
  })

  it('caches the resolved Lite palette instead of the configured light palette', () => {
    isLite.set(true)
    colorSchemeMocks.database.colorScheme = { ...builtInColorSchemes.light }
    updateColorScheme()
    expect(readDisplaySettingsCache().styles['--risu-theme-bgcolor']).toBe(builtInColorSchemes.lite.bgcolor)
    expect(readDisplaySettingsCache().styles['--risu-theme-color-scheme']).toBe('dark')
    isLite.set(false)
  })

  it.each(['dark', 'light'] as const)('publishes the %s scheme for browser-owned controls', (type) => {
    colorSchemeMocks.database.colorScheme = { ...scheme('aaa'), type }

    updateColorScheme()

    expect(document.documentElement.style.getPropertyValue('--risu-theme-color-scheme')).toBe(type)
  })
})

describe('legacy built-in color scheme migration', () => {
  it.each([
    ['default', '#64748b'],
    ['nature', '#4d908e'],
  ] as const)('upgrades a persisted %s palette to the readable secondary text color', (name, legacyTextColor) => {
    const legacy = { ...builtInColorSchemes[name], textcolor2: legacyTextColor } as ColorScheme

    expect(migrateLegacyBuiltInColorScheme(name, legacy)).toEqual(builtInColorSchemes[name])
  })

  it('does not overwrite a custom or modified palette', () => {
    const custom = { ...builtInColorSchemes.default, textcolor2: '#64748b', bgcolor: '#123456' } as ColorScheme

    expect(migrateLegacyBuiltInColorScheme('custom', custom)).toBe(custom)
    expect(migrateLegacyBuiltInColorScheme('default', custom)).toBe(custom)
  })

  it('upgrades the complete previous interaction palette only when every field is still built-in', () => {
    const legacyNature = {
      ...builtInColorSchemes.nature,
      darkbg: '#2d6a4f',
      selected: '#4d908e',
      draculared: '#ff5555',
      darkBorderc: '#457b9d',
    } as ColorScheme

    expect(migrateLegacyBuiltInColorScheme('nature', legacyNature)).toEqual(builtInColorSchemes.nature)
    expect(migrateLegacyBuiltInColorScheme('nature', { ...legacyNature, bgcolor: '#123456' })).toEqual({
      ...legacyNature,
      bgcolor: '#123456',
    })
  })

  it('persists the migration when applying an existing built-in theme', () => {
    colorSchemeMocks.database = {
      colorSchemeName: 'nature',
      colorScheme: { ...builtInColorSchemes.nature, textcolor2: '#4d908e' },
    }
    colorSchemeMocks.settingsResourceState.value = colorSchemeMocks.database

    updateColorScheme()

    expect(colorSchemeMocks.applyServerBackedSettingsPatch).toHaveBeenCalledWith({
      colorScheme: builtInColorSchemes.nature,
    })
    expect(document.documentElement.style.getPropertyValue('--risu-theme-textcolor2')).toBe(
      builtInColorSchemes.nature.textcolor2,
    )
  })
})
