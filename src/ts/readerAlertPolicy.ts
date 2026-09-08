import type { alertData } from './types/alert'

/** Session decisions remain available while authoring and plugin dialogs are closed. */
export function canShowReaderAlert(alert: alertData): boolean {
  return (
    (alert.type === 'select' && alert.purpose === 'client-session') ||
    ['none', 'error', 'normal', 'wait', 'wait2', 'toast', 'progress', 'login', 'realmTerms'].includes(alert.type)
  )
}
