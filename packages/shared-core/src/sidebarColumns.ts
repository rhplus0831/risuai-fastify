export const DEFAULT_SIDEBAR_COLUMNS = 1
export const MIN_SIDEBAR_COLUMNS = 1
export const MAX_DESKTOP_SIDEBAR_COLUMNS = 4
export const MAX_MOBILE_SIDEBAR_COLUMNS = 2

function normalizeSidebarColumns(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIDEBAR_COLUMNS
  return Math.min(maximum, Math.max(MIN_SIDEBAR_COLUMNS, Math.trunc(value)))
}

export function normalizeDesktopSidebarColumns(value: unknown): number {
  return normalizeSidebarColumns(value, MAX_DESKTOP_SIDEBAR_COLUMNS)
}

export function normalizeMobileSidebarColumns(value: unknown): number {
  return normalizeSidebarColumns(value, MAX_MOBILE_SIDEBAR_COLUMNS)
}

export function isValidDesktopSidebarColumns(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= MIN_SIDEBAR_COLUMNS &&
    (value as number) <= MAX_DESKTOP_SIDEBAR_COLUMNS
  )
}

export function isValidMobileSidebarColumns(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= MIN_SIDEBAR_COLUMNS &&
    (value as number) <= MAX_MOBILE_SIDEBAR_COLUMNS
  )
}
