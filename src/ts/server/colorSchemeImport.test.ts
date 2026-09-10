import { describe, expect, it } from 'vitest'

import {
  beginColorSchemeImport,
  captureColorSchemeImportTarget,
  clearColorSchemeImport,
  parseColorSchemeImport,
  resolveFreshColorSchemeImportPatch,
  type ColorSchemeImportOperation,
} from './colorSchemeImport'
import type { ColorScheme } from '../gui/colorscheme'
import {
  expectCanceledPickerKeepsOperationCurrent,
  expectNewerOperationWins,
} from '../__tests__/latestOperationTestAssertions'

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

function beginImport(input?: {
  colorSchemeName?: string
  colorScheme?: ColorScheme
  customColorScheme?: ColorScheme
}): ColorSchemeImportOperation {
  const colorScheme = input?.colorScheme ?? scheme('aaa')
  const target = captureColorSchemeImportTarget({
    colorSchemeName: input?.colorSchemeName ?? 'default',
    colorScheme,
    customColorScheme: input?.customColorScheme ?? colorScheme,
  })

  return beginColorSchemeImport(target)
}

describe('color scheme import freshness', () => {
  it('rejects completion after colorSchemeName changes', () => {
    const originalScheme = scheme('aaa')
    const operation = beginImport({
      colorSchemeName: 'default',
      colorScheme: originalScheme,
    })

    try {
      expect(
        resolveFreshColorSchemeImportPatch({
          operation,
          freshness: {
            colorSchemeName: 'light',
            colorScheme: originalScheme,
            customColorScheme: originalScheme,
          },
          colorScheme: scheme('bbb'),
        }),
      ).toBeNull()
    } finally {
      clearColorSchemeImport(operation)
    }
  })

  it('rejects completion after colorScheme changes', () => {
    const operation = beginImport({
      colorSchemeName: 'custom',
      colorScheme: scheme('aaa'),
    })

    try {
      expect(
        resolveFreshColorSchemeImportPatch({
          operation,
          freshness: {
            colorSchemeName: 'custom',
            colorScheme: scheme('ccc'),
            customColorScheme: scheme('aaa'),
          },
          colorScheme: scheme('bbb'),
        }),
      ).toBeNull()
    } finally {
      clearColorSchemeImport(operation)
    }
  })

  it('rejects completion after the saved custom palette changes', () => {
    const originalScheme = scheme('aaa')
    const operation = beginImport({
      colorSchemeName: 'default',
      colorScheme: originalScheme,
      customColorScheme: originalScheme,
    })

    try {
      expect(
        resolveFreshColorSchemeImportPatch({
          operation,
          freshness: {
            colorSchemeName: 'default',
            colorScheme: originalScheme,
            customColorScheme: scheme('ccc'),
          },
          colorScheme: scheme('bbb'),
        }),
      ).toBeNull()
    } finally {
      clearColorSchemeImport(operation)
    }
  })

  it('lets the newer selected import win over an older delayed import', () => {
    const originalScheme = scheme('aaa')

    expectNewerOperationWins({
      begin: () =>
        beginImport({
          colorSchemeName: 'default',
          colorScheme: originalScheme,
        }),
      complete: (operation, attempt) =>
        resolveFreshColorSchemeImportPatch({
          operation,
          freshness: {
            colorSchemeName: 'default',
            colorScheme: originalScheme,
            customColorScheme: originalScheme,
          },
          colorScheme: scheme(attempt === 'newer' ? 'bbb' : 'ccc'),
        }),
      expectedNewer: {
        colorSchemeName: 'custom',
        colorScheme: scheme('bbb'),
        customColorScheme: scheme('bbb'),
      },
      clear: clearColorSchemeImport,
    })
  })

  it('does not let a canceled newer picker invalidate an older pending import', () => {
    const originalScheme = scheme('aaa')

    expectCanceledPickerKeepsOperationCurrent({
      begin: () =>
        beginImport({
          colorSchemeName: 'default',
          colorScheme: originalScheme,
        }),
      captureCanceledTarget: () =>
        captureColorSchemeImportTarget({
          colorSchemeName: 'default',
          colorScheme: originalScheme,
          customColorScheme: originalScheme,
        }),
      complete: (operation) =>
        resolveFreshColorSchemeImportPatch({
          operation,
          freshness: {
            colorSchemeName: 'default',
            colorScheme: originalScheme,
            customColorScheme: originalScheme,
          },
          colorScheme: scheme('bbb'),
        }),
      expected: {
        colorSchemeName: 'custom',
        colorScheme: scheme('bbb'),
        customColorScheme: scheme('bbb'),
      },
      clear: clearColorSchemeImport,
    })
  })

  it('parses only color scheme-shaped JSON', () => {
    expect(parseColorSchemeImport(JSON.stringify(scheme('aaa')))).toEqual(scheme('aaa'))
    expect(parseColorSchemeImport('{')).toBeNull()
    expect(parseColorSchemeImport(JSON.stringify({ ...scheme('aaa'), bgcolor: 1 }))).toBeNull()
  })
})
