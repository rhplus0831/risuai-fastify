import { normalizeDesktopSidebarColumns, normalizeMobileSidebarColumns } from '@risuai/shared-core/sidebar-columns'

export const RESPONSIVE_SHELL_MAX_WIDTH = 1024
export const MIN_SIDEBAR_SIZE = 0
export const MAX_SIDEBAR_SIZE = 3
export const SIDEBAR_PANEL_BASE_REM = 24
export const SIDEBAR_PANEL_STEP_REM = 4
export const NAVIGATION_RAIL_COLUMN_REM = 5
export const MIN_RESPONSIVE_PANEL_REM = 16
export const MIN_RESPONSIVE_SCRIM_REM = 3.5

export interface ShellGeometryInput {
  responsive: boolean
  sideBarSize: unknown
  desktopSidebarColumns: unknown
  mobileSidebarColumns: unknown
  viewportWidthPx?: unknown
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
  scrimWidthRem: number
  columnsAdjusted: boolean
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
  const configuredColumns = input.responsive
    ? normalizeMobileSidebarColumns(input.mobileSidebarColumns)
    : normalizeDesktopSidebarColumns(input.desktopSidebarColumns)
  const viewportWidthRem =
    typeof input.viewportWidthPx === 'number' && Number.isFinite(input.viewportWidthPx) && input.viewportWidthPx > 0
      ? input.viewportWidthPx / 16
      : undefined
  let columns = configuredColumns
  if (input.responsive && viewportWidthRem !== undefined) {
    while (
      columns > 1 &&
      columns * NAVIGATION_RAIL_COLUMN_REM + MIN_RESPONSIVE_PANEL_REM + MIN_RESPONSIVE_SCRIM_REM > viewportWidthRem
    ) {
      columns -= 1
    }
  }
  const railWidthRem = columns * NAVIGATION_RAIL_COLUMN_REM
  const requestedPanelWidthRem = sidebarPanelWidthRem(sideBarSize)
  const panelWidthRem =
    input.responsive && viewportWidthRem !== undefined
      ? Math.min(requestedPanelWidthRem, Math.max(0, viewportWidthRem - railWidthRem - MIN_RESPONSIVE_SCRIM_REM))
      : requestedPanelWidthRem
  const navigationWidthRem = railWidthRem + panelWidthRem
  const scrimWidthRem =
    viewportWidthRem === undefined ? MIN_RESPONSIVE_SCRIM_REM : viewportWidthRem - navigationWidthRem
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
    scrimWidthRem,
    columnsAdjusted: columns !== configuredColumns,
  }
}
