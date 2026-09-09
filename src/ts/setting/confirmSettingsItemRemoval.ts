import { language } from 'src/lang'

export function confirmSettingsItemRemoval(itemName?: string): boolean {
  if (typeof window.confirm !== 'function') return false
  return window.confirm(
    itemName?.trim() ? language.settingsItemRemovalConfirmNamed(itemName) : language.settingsItemRemovalConfirm,
  )
}
