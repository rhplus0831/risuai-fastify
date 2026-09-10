import { describe, expect, it } from 'vitest'
import {
  isResponsiveShellWidth,
  normalizeSidebarSize,
  resolveShellGeometry,
  sidebarPanelWidthRem,
} from './shellGeometry'

describe('conversation shell geometry', () => {
  it('preserves the settled writer matrix for every supported size and desktop column count', () => {
    const matrix = [
      [29, 34, 39, 44],
      [33, 38, 43, 48],
      [37, 42, 47, 52],
      [41, 46, 51, 56],
    ]

    for (const sideBarSize of [0, 1, 2, 3]) {
      expect(sidebarPanelWidthRem(sideBarSize)).toBe(24 + sideBarSize * 4)
      for (const desktopSidebarColumns of [1, 2, 3, 4]) {
        const geometry = resolveShellGeometry({
          responsive: false,
          sideBarSize,
          desktopSidebarColumns,
          mobileSidebarColumns: 1,
        })
        expect(geometry.navigationWidthRem).toBe(matrix[sideBarSize]![desktopSidebarColumns - 1])
        expect(geometry.panelWidth).toBe(`${24 + sideBarSize * 4}rem`)
        expect(geometry.railWidth).toBe(`${desktopSidebarColumns * 5}rem`)
      }
    }
  })

  it('uses the normal 1024px responsive boundary and mobile column normalization', () => {
    expect(isResponsiveShellWidth(1024)).toBe(true)
    expect(isResponsiveShellWidth(1025)).toBe(false)
    expect(
      resolveShellGeometry({
        responsive: true,
        sideBarSize: 3,
        desktopSidebarColumns: 4,
        mobileSidebarColumns: 2,
      }),
    ).toMatchObject({ columns: 2, railWidthRem: 10, panelWidthRem: 36, navigationWidthRem: 46 })
  })

  it('normalizes malformed values before classes and CSS variables can disagree', () => {
    expect(normalizeSidebarSize(-5)).toBe(0)
    expect(normalizeSidebarSize(2.9)).toBe(2)
    expect(normalizeSidebarSize(99)).toBe(3)
    expect(normalizeSidebarSize('2')).toBe(0)
    expect(
      resolveShellGeometry({
        responsive: false,
        sideBarSize: Number.NaN,
        desktopSidebarColumns: 99,
        mobileSidebarColumns: 99,
      }),
    ).toMatchObject({ sideBarSize: 0, columns: 4, panelWidth: '24rem', railWidth: '20rem' })
  })

  it.each([
    { viewportWidthPx: 550, expectedPanelWidthRem: 20.875 },
    { viewportWidthPx: 655, expectedPanelWidthRem: 27.4375 },
  ])('keeps a visible compact scrim at $viewportWidthPx px', ({ viewportWidthPx, expectedPanelWidthRem }) => {
    const geometry = resolveShellGeometry({
      responsive: true,
      sideBarSize: 3,
      desktopSidebarColumns: 4,
      mobileSidebarColumns: 2,
      viewportWidthPx,
    })
    expect(geometry.columns).toBe(2)
    expect(geometry.panelWidthRem).toBe(expectedPanelWidthRem)
    expect(geometry.scrimWidthRem).toBeCloseTo(3.5)
    expect(geometry.navigationWidthRem * 16).toBeLessThan(viewportWidthPx)
  })

  it('reduces configured compact rail columns only when a usable panel and scrim cannot both fit', () => {
    expect(
      resolveShellGeometry({
        responsive: true,
        sideBarSize: 0,
        desktopSidebarColumns: 4,
        mobileSidebarColumns: 2,
        viewportWidthPx: 440,
      }),
    ).toMatchObject({ columns: 1, columnsAdjusted: true, railWidthRem: 5, panelWidthRem: 19, scrimWidthRem: 3.5 })
  })
})
