import { normalizeDesktopSidebarColumns, normalizeMobileSidebarColumns } from '@risuai/shared-core/sidebar-columns'

export const RESPONSIVE_SHELL_MAX_WIDTH = 1024
export const MIN_SIDEBAR_SIZE = 0
export const MAX_SIDEBAR_SIZE = 3
export const SIDEBAR_PANEL_BASE_REM = 24
export const SIDEBAR_PANEL_STEP_REM = 4
export const NAVIGATION_RAIL_COLUMN_REM = 5

export interface ShellGeometryInput {
  responsive: boolean
  sideBarSize: unknown
  desktopSidebarColumns: unknown
  mobileSidebarColumns: unknown
}

export interface ShellGeometry {
  responsive: boolean
  sideBarSize: number
  columns: number
  railWidthRem: number
  panelWidthRem: number
  navigationWidthRem: number
  railWidth: string
  panelWidth: string
  navigationWidth: string
}

export function isResponsiveShellWidth(width: number): boolean {
  return width <= RESPONSIVE_SHELL_MAX_WIDTH
}

export function normalizeSidebarSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_SIDEBAR_SIZE
  return Math.min(MAX_SIDEBAR_SIZE, Math.max(MIN_SIDEBAR_SIZE, Math.trunc(value)))
}

export function sidebarPanelWidthRem(value: unknown): number {
  return SIDEBAR_PANEL_BASE_REM + SIDEBAR_PANEL_STEP_REM * normalizeSidebarSize(value)
}

export function resolveShellGeometry(input: ShellGeometryInput): ShellGeometry {
  const sideBarSize = normalizeSidebarSize(input.sideBarSize)
  const columns = input.responsive
    ? normalizeMobileSidebarColumns(input.mobileSidebarColumns)
    : normalizeDesktopSidebarColumns(input.desktopSidebarColumns)
  const railWidthRem = columns * NAVIGATION_RAIL_COLUMN_REM
  const panelWidthRem = sidebarPanelWidthRem(sideBarSize)
  const navigationWidthRem = railWidthRem + panelWidthRem
  return {
    responsive: input.responsive,
    sideBarSize,
    columns,
    railWidthRem,
    panelWidthRem,
    navigationWidthRem,
    railWidth: `${railWidthRem}rem`,
    panelWidth: `${panelWidthRem}rem`,
    navigationWidth: `${navigationWidthRem}rem`,
  }
}
