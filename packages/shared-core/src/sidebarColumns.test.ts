import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIDEBAR_COLUMNS,
  MAX_DESKTOP_SIDEBAR_COLUMNS,
  MAX_MOBILE_SIDEBAR_COLUMNS,
  MIN_SIDEBAR_COLUMNS,
  isValidDesktopSidebarColumns,
  isValidMobileSidebarColumns,
  normalizeDesktopSidebarColumns,
  normalizeMobileSidebarColumns,
} from './sidebarColumns.js'

describe('sidebar column normalization', () => {
  it('defines the desktop and mobile bounds', () => {
    expect(DEFAULT_SIDEBAR_COLUMNS).toBe(1)
    expect(MIN_SIDEBAR_COLUMNS).toBe(1)
    expect(MAX_DESKTOP_SIDEBAR_COLUMNS).toBe(4)
    expect(MAX_MOBILE_SIDEBAR_COLUMNS).toBe(2)
  })

  it.each([
    [undefined, 1, 1],
    [null, 1, 1],
    ['2', 1, 1],
    [Number.NaN, 1, 1],
    [-1, 1, 1],
    [1, 1, 1],
    [2, 2, 2],
    [3.9, 3, 2],
    [4, 4, 2],
    [10, 4, 2],
  ])('normalizes %o for desktop and mobile', (input, desktop, mobile) => {
    expect(normalizeDesktopSidebarColumns(input)).toBe(desktop)
    expect(normalizeMobileSidebarColumns(input)).toBe(mobile)
  })

  it('validates exact persisted integer choices', () => {
    expect([1, 2, 3, 4].every(isValidDesktopSidebarColumns)).toBe(true)
    expect([1, 2].every(isValidMobileSidebarColumns)).toBe(true)
    expect([0, 1.5, 5, '2'].some(isValidDesktopSidebarColumns)).toBe(false)
    expect([0, 1.5, 3, '2'].some(isValidMobileSidebarColumns)).toBe(false)
  })
})
