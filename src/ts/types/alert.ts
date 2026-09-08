export type AlertWaitHandle = symbol
export type AlertDialogHandle = symbol

export interface alertData {
  type:
    | 'error'
    | 'normal'
    | 'none'
    | 'ask'
    | 'wait'
    | 'selectChar'
    | 'input'
    | 'toast'
    | 'wait2'
    | 'markdown'
    | 'select'
    | 'login'
    | 'realmTerms'
    | 'cardexport'
    | 'requestdata'
    | 'addchar'
    | 'selectModule'
    | 'chatOptions'
    | 'pukmakkurit'
    | 'branches'
    | 'progress'
    | 'pluginconfirm'
    | 'requestlogs'
  msg: string
  title?: string
  submsg?: string
  datalist?: [string, string][]
  stackTrace?: string
  defaultValue?: string
  progress?: number | null
  waitOwner?: AlertWaitHandle
  dialogOwner?: AlertDialogHandle
  dismissible?: boolean
  /** Explicit authentication, initialization, or writer-access lifecycle UI. */
  purpose?: 'client-session'
}
