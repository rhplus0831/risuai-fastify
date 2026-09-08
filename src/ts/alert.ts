import { get, writable } from 'svelte/store'
import { language } from '../lang'
import type { MessageGenerationInfo } from './storage/database.svelte'
import { alertStore as alertStoreImported, selectedCharID } from './stores/coreStores.svelte'
import { charactersResourceState, settingsResourceState } from './server/resourceState.svelte'
import type { alertData, AlertDialogHandle, AlertWaitHandle } from './types/alert'

export type { alertData, AlertDialogHandle, AlertWaitHandle } from './types/alert'

type ConfirmationAlertType = 'ask' | 'pluginconfirm'

interface ConfirmationRequest {
  kind: 'confirmation'
  owner: AlertDialogHandle
  type: ConfirmationAlertType
  msg: string
  resolve: (confirmed: boolean) => void
}

interface SelectionRequest {
  kind: 'selection'
  owner: AlertDialogHandle
  options: string[]
  display?: string
  title?: string
  dismissible: boolean
  purpose?: 'client-session'
  resolve: (selection: string | null) => void
}

interface InputRequest {
  kind: 'input'
  owner: AlertDialogHandle
  msg: string
  datalist: [string, string][]
  defaultValue: string
  resolve: (value: string) => void
}

type WorkflowAlertType =
  | 'addchar'
  | 'chatOptions'
  | 'login'
  | 'selectChar'
  | 'cardexport'
  | 'realmTerms'
  | 'selectModule'

interface WorkflowRequest {
  kind: 'workflow'
  owner: AlertDialogHandle
  type: WorkflowAlertType
  msg: string
  submsg?: string
  resolve: (value: string) => void
}

type ResultDialogRequest = ConfirmationRequest | SelectionRequest | InputRequest | WorkflowRequest

export type AlertGenerationInfoStoreData = {
  genInfo: MessageGenerationInfo
  idx: number
  characterId?: string
  chatId?: string
  messageId?: string
}
export const alertGenerationInfoStore = writable<AlertGenerationInfoStoreData | undefined>(undefined)
export const alertStore = {
  set: (d: alertData) => {
    if (passivePresentationTypes.has(d.type)) {
      setPassiveAlert(d)
      return
    }
    if (activeResultDialog) {
      if (d.type === 'none' && d.dialogOwner === activeResultDialog.owner) {
        alertStoreImported.set(d)
      }
      return
    }
    alertStoreImported.set(d)
  },
}

const resultDialogQueue: ResultDialogRequest[] = []
let activeResultDialog: ResultDialogRequest | undefined
let resultDialogQueueBlocked = false
let resultDialogResumeTimer: ReturnType<typeof setTimeout> | undefined
let resultDialogStoreSubscribed = false

const responseDialogTypes = new Set<alertData['type']>([
  'ask',
  'pluginconfirm',
  'input',
  'select',
  'addchar',
  'chatOptions',
  'login',
  'selectChar',
  'cardexport',
  'realmTerms',
  'selectModule',
])
const passivePresentationTypes = new Set<alertData['type']>([
  'error',
  'normal',
  'wait',
  'wait2',
  'toast',
  'markdown',
  'progress',
])
let deferredPassiveAlert: alertData | undefined
let passiveAlertResumeTimer: ReturnType<typeof setTimeout> | undefined
let passiveAlertStoreSubscribed = false

function isResponseDialog(value: alertData) {
  return responseDialogTypes.has(value.type)
}

function showDeferredPassiveAlert() {
  passiveAlertResumeTimer = undefined
  if (!deferredPassiveAlert || get(alertStoreImported).type !== 'none') return

  const nextAlert = deferredPassiveAlert
  deferredPassiveAlert = undefined
  alertStoreImported.set(nextAlert)
}

function resumePassiveAlertAfterCurrentCallers() {
  if (passiveAlertResumeTimer !== undefined) return

  passiveAlertResumeTimer = setTimeout(showDeferredPassiveAlert, 0)
}

function handlePassiveAlertStoreValue(value: alertData) {
  if (deferredPassiveAlert && value.type === 'none') {
    // Let the dialog's awaiting caller consume its result before another alert
    // is allowed to take ownership of the shared presentation store.
    resumePassiveAlertAfterCurrentCallers()
  }
}

function ensurePassiveAlertStoreSubscription() {
  if (passiveAlertStoreSubscribed) return
  passiveAlertStoreSubscribed = true
  alertStoreImported.subscribe(handlePassiveAlertStoreValue)
}

function setPassiveAlert(data: alertData) {
  const current = get(alertStoreImported)
  if (deferredPassiveAlert || activeResultDialog || isResponseDialog(current)) {
    // Passive alerts have historically shared last-write-wins semantics. Keep
    // that behavior while preserving the result-bearing dialog already shown.
    deferredPassiveAlert = data
    ensurePassiveAlertStoreSubscription()
    if (current.type === 'none') resumePassiveAlertAfterCurrentCallers()
    return
  }

  alertStoreImported.set(data)
}

function selectionMessage(request: SelectionRequest): string {
  return request.display !== undefined
    ? `__DISPLAY__${request.display}||${request.options.join('||')}`
    : request.options.join('||')
}

function normalizeSelectionResult(request: SelectionRequest, value: string): string | null {
  if (!/^\d+$/.test(value)) return null

  const selectedIndex = Number(value)
  if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= request.options.length) {
    return null
  }
  return selectedIndex.toString()
}

function resultDialogType(request: ResultDialogRequest): alertData['type'] {
  if (request.kind === 'confirmation') return request.type
  if (request.kind === 'selection') return 'select'
  return request.kind === 'input' ? 'input' : request.type
}

function displayResultDialog(request: ResultDialogRequest): void {
  if (request.kind === 'confirmation') {
    alertStoreImported.set({ type: request.type, msg: request.msg, dialogOwner: request.owner })
    return
  }
  if (request.kind === 'selection') {
    alertStoreImported.set({
      type: 'select',
      msg: selectionMessage(request),
      dialogOwner: request.owner,
      dismissible: request.dismissible,
      ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
      ...(request.title === undefined ? {} : { title: request.title }),
    })
    return
  }
  if (request.kind === 'input') {
    alertStoreImported.set({
      type: 'input',
      msg: request.msg,
      datalist: request.datalist,
      defaultValue: request.defaultValue,
      dialogOwner: request.owner,
    })
    return
  }
  alertStoreImported.set({
    type: request.type,
    msg: request.msg,
    submsg: request.submsg,
    dialogOwner: request.owner,
  })
}

function showNextResultDialog(): void {
  if (activeResultDialog || resultDialogQueue.length === 0 || resultDialogQueueBlocked) return
  if (get(alertStoreImported).type !== 'none') return

  activeResultDialog = resultDialogQueue.shift()
  if (activeResultDialog) displayResultDialog(activeResultDialog)
}

function resumeResultDialogQueueAfterCurrentCallers(): void {
  if (resultDialogResumeTimer !== undefined) return
  resultDialogResumeTimer = setTimeout(() => {
    resultDialogResumeTimer = undefined
    showNextResultDialog()
  }, 0)
}

function settleResultDialog(request: ResultDialogRequest, ownedResult: boolean, message: string): void {
  if (request.kind === 'confirmation') {
    request.resolve(ownedResult && message === 'yes')
  } else if (request.kind === 'selection') {
    request.resolve(ownedResult ? normalizeSelectionResult(request, message) : null)
  } else if (request.kind === 'input') {
    request.resolve(ownedResult ? message : '')
  } else {
    request.resolve(ownedResult ? message : '')
  }
}

function handleResultDialogStoreValue(value: alertData): void {
  const request = activeResultDialog
  if (request) {
    const isOwnedDialog = value.type === resultDialogType(request) && value.dialogOwner === request.owner
    if (isOwnedDialog) return

    const isOwnedResult = value.type === 'none' && value.dialogOwner === request.owner
    activeResultDialog = undefined
    settleResultDialog(request, isOwnedResult, value.msg)
    resultDialogQueueBlocked = value.type !== 'none'
  }

  if (value.type === 'none') {
    resultDialogQueueBlocked = false
    if (request) showNextResultDialog()
    else resumeResultDialogQueueAfterCurrentCallers()
  }
}

function ensureResultDialogStoreSubscription(): void {
  if (resultDialogStoreSubscribed) return
  resultDialogStoreSubscribed = true
  alertStoreImported.subscribe(handleResultDialogStoreValue)
}

function cancelResultDialog(request: ResultDialogRequest): void {
  const queuedIndex = resultDialogQueue.indexOf(request)
  if (queuedIndex >= 0) {
    resultDialogQueue.splice(queuedIndex, 1)
    settleResultDialog(request, false, '')
    return
  }

  const current = get(alertStoreImported)
  if (
    activeResultDialog === request &&
    current.dialogOwner === request.owner &&
    current.type === resultDialogType(request)
  ) {
    alertStoreImported.set({ type: 'none', msg: '', dialogOwner: request.owner })
  }
}

function queueResultDialog<T>(
  createRequest: (resolve: (value: T) => void) => ResultDialogRequest,
  signal?: AbortSignal,
): Promise<T> {
  ensureResultDialogStoreSubscription()
  const promise = new Promise<T>((resolve) => {
    const abort = () => cancelResultDialog(request)
    const request = createRequest((value) => {
      signal?.removeEventListener('abort', abort)
      resolve(value)
    })
    if (signal?.aborted) {
      settleResultDialog(request, false, '')
      return
    }
    resultDialogQueue.push(request)
    signal?.addEventListener('abort', abort, { once: true })
  })
  showNextResultDialog()
  return promise
}

function queueConfirmation(type: ConfirmationAlertType, msg: string): Promise<boolean> {
  return queueResultDialog<boolean>((resolve) => ({
    kind: 'confirmation',
    owner: Symbol('alert-dialog'),
    type,
    msg,
    resolve,
  }))
}

function queueSelection(
  options: string[],
  display?: string,
  settings: { dismissible?: boolean; title?: string; signal?: AbortSignal; purpose?: 'client-session' } = {},
): Promise<string | null> {
  if (settings.signal?.aborted) return Promise.resolve(null)
  return queueResultDialog<string | null>(
    (resolve) => ({
      kind: 'selection',
      owner: Symbol('alert-dialog'),
      options: [...options],
      display,
      dismissible: settings.dismissible !== false,
      ...(settings.purpose === undefined ? {} : { purpose: settings.purpose }),
      ...(settings.title === undefined ? {} : { title: settings.title }),
      resolve,
    }),
    settings.signal,
  )
}

function queueInput(msg: string, datalist?: [string, string][], defaultValue?: string): Promise<string> {
  return queueResultDialog<string>((resolve) => ({
    kind: 'input',
    owner: Symbol('alert-dialog'),
    msg,
    datalist: datalist ? [...datalist] : [],
    defaultValue: defaultValue ?? '',
    resolve,
  }))
}

function queueWorkflow(type: WorkflowAlertType, msg: string, submsg?: string): Promise<string> {
  return queueResultDialog<string>((resolve) => ({
    kind: 'workflow',
    owner: Symbol('alert-dialog'),
    type,
    msg,
    submsg,
    resolve,
  }))
}

/**
 * Resolves only the confirmation dialog that owns the supplied handle. A stale
 * button or callback from an older dialog cannot settle the next queued prompt.
 */
export function resolveAlertConfirmation(owner: AlertDialogHandle | undefined, confirmed: boolean): boolean {
  const request = activeResultDialog
  const current = get(alertStoreImported)
  if (
    request?.kind !== 'confirmation' ||
    owner !== request.owner ||
    current.dialogOwner !== request.owner ||
    current.type !== request.type
  ) {
    return false
  }

  alertStoreImported.set({
    type: 'none',
    msg: confirmed ? 'yes' : 'no',
    dialogOwner: request.owner,
  })
  return true
}

/** Resolves only the select dialog that owns the supplied handle. */
export function resolveAlertSelection(owner: AlertDialogHandle | undefined, selectedIndex: number | null): boolean {
  const request = activeResultDialog
  const current = get(alertStoreImported)
  if (
    request?.kind !== 'selection' ||
    owner !== request.owner ||
    current.dialogOwner !== request.owner ||
    current.type !== 'select'
  ) {
    return false
  }
  if (
    selectedIndex !== null &&
    (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= request.options.length)
  ) {
    return false
  }

  alertStoreImported.set({
    type: 'none',
    msg: selectedIndex === null ? '' : selectedIndex.toString(),
    dialogOwner: request.owner,
  })
  return true
}

/** Resolves only the input dialog that owns the supplied handle. */
export function resolveAlertInput(owner: AlertDialogHandle | undefined, value: string | null): boolean {
  const request = activeResultDialog
  const current = get(alertStoreImported)
  if (
    request?.kind !== 'input' ||
    owner !== request.owner ||
    current.dialogOwner !== request.owner ||
    current.type !== 'input'
  ) {
    return false
  }

  alertStoreImported.set({
    type: 'none',
    msg: value ?? '',
    dialogOwner: request.owner,
  })
  return true
}

/** Resolves only the workflow dialog that owns the supplied handle. */
export function resolveAlertWorkflow(owner: AlertDialogHandle | undefined, value: string): boolean {
  const request = activeResultDialog
  const current = get(alertStoreImported)
  if (
    request?.kind !== 'workflow' ||
    owner !== request.owner ||
    current.dialogOwner !== request.owner ||
    current.type !== request.type
  ) {
    return false
  }

  alertStoreImported.set({ type: 'none', msg: value, dialogOwner: request.owner })
  return true
}

export function alertError(msg: unknown) {
  console.error(msg)

  let stackTrace: string | undefined = undefined
  let message: string

  if (msg instanceof Error) {
    stackTrace = msg.stack
    message = msg.message
  } else {
    try {
      message = String(msg)
    } catch {
      message = '[unprintable error]'
    }
  }

  message = message.trim()

  const ignoredErrors = ['{}']

  if (ignoredErrors.includes(message)) {
    return
  }

  let submsg = ''

  //check if it's a known error
  if (message.includes('Failed to fetch') || message.includes('NetworkError when attempting to fetch resource.')) {
    submsg = settingsResourceState.value.usePlainFetch
      ? language.errors.networkFetchPlain
      : language.errors.networkFetch
  }

  setPassiveAlert({
    type: 'error',
    msg: message,
    submsg: submsg,
    stackTrace: stackTrace,
  })
}

export function waitAlert(): Promise<alertData> {
  const current = get(alertStoreImported)
  if (current.type === 'none') return Promise.resolve(current)

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    let completed = false
    const handleValue = (value: alertData) => {
      if (value.type !== 'none') return
      completed = true
      resolve(value)
      unsubscribe?.()
    }

    unsubscribe = alertStoreImported.subscribe(handleValue)
    if (completed) unsubscribe()
  })
}

export function alertNormal(msg: string) {
  setPassiveAlert({
    type: 'normal',
    msg: msg,
  })
}

export async function alertNormalWait(msg: string) {
  setPassiveAlert({
    type: 'normal',
    msg: msg,
  })
  await waitAlert()
}

export async function alertAddCharacter() {
  return queueWorkflow('addchar', language.addCharacter)
}

export async function alertChatOptions() {
  return parseInt(await queueWorkflow('chatOptions', language.chatOptions))
}

export async function alertLogin() {
  return queueWorkflow('login', 'login')
}

export async function alertSelect(msg: string[], display?: string): Promise<string | null> {
  return queueSelection(msg, display)
}

export async function alertRequiredSelect(
  msg: string[],
  display: string,
  title: string,
  options: { signal?: AbortSignal; purpose?: 'client-session' } = {},
): Promise<string> {
  return (await queueSelection(msg, display, { dismissible: false, title, ...options })) ?? ''
}

export async function alertErrorWait(msg: string) {
  setPassiveAlert({
    type: 'wait2',
    msg: msg,
  })
  await waitAlert()
}

export function alertMd(msg: string) {
  setPassiveAlert({
    type: 'markdown',
    msg: msg,
  })
}

export function doingAlert() {
  return (
    get(alertStoreImported).type !== 'none' &&
    get(alertStoreImported).type !== 'toast' &&
    get(alertStoreImported).type !== 'wait'
  )
}

export function alertToast(msg: string) {
  setPassiveAlert({
    type: 'toast',
    msg: msg,
  })
}

export function alertWait(msg: string) {
  setPassiveAlert({
    type: 'wait',
    msg: msg,
  })
}

export function beginAlertWait(msg: string): AlertWaitHandle {
  const waitOwner = Symbol('alert-wait')
  setPassiveAlert({
    type: 'wait',
    msg,
    waitOwner,
  })
  return waitOwner
}

export function updateAlertWait(waitOwner: AlertWaitHandle, msg: string): boolean {
  if (deferredPassiveAlert?.type === 'wait' && deferredPassiveAlert.waitOwner === waitOwner) {
    deferredPassiveAlert = { type: 'wait', msg, waitOwner }
    return true
  }
  const current = get(alertStoreImported)
  if (current.type !== 'wait' || current.waitOwner !== waitOwner) return false

  alertStoreImported.set({
    type: 'wait',
    msg,
    waitOwner,
  })
  return true
}

export function clearAlertWait(waitOwner: AlertWaitHandle): boolean {
  if (deferredPassiveAlert?.type === 'wait' && deferredPassiveAlert.waitOwner === waitOwner) {
    deferredPassiveAlert = undefined
    return true
  }
  const current = get(alertStoreImported)
  if (current.type !== 'wait' || current.waitOwner !== waitOwner) return false

  alertStoreImported.set({
    type: 'none',
    msg: '',
  })
  return true
}

function normalizeProgress(progress: number) {
  if (!Number.isFinite(progress)) {
    return 0
  }

  return Math.max(0, Math.min(100, progress))
}

export function alertProgress(msg: string, progress: number | null, submsg?: string) {
  const data: alertData = {
    type: 'progress',
    msg: msg,
    progress: progress === null ? null : normalizeProgress(progress),
  }

  if (submsg !== undefined) {
    data.submsg = submsg
  }

  setPassiveAlert(data)
}

export function alertClear() {
  const current = get(alertStoreImported)
  if (deferredPassiveAlert) {
    // A background operation may finish while its wait alert is deferred. Its
    // cleanup belongs to that pending status, not to the user's active dialog.
    deferredPassiveAlert = undefined
    if (activeResultDialog || isResponseDialog(current) || current.type === 'none') return
  }

  if (activeResultDialog || isResponseDialog(current)) return

  alertStoreImported.set({
    type: 'none',
    msg: '',
  })
}

export async function alertSelectChar() {
  return queueWorkflow('selectChar', '')
}

export function alertConfirm(msg: string) {
  return queueConfirmation('ask', msg)
}

export function alertPluginConfirm(msg: string) {
  return queueConfirmation('pluginconfirm', msg)
}

export interface CardExportResult {
  type: string
  type2: string
}

export function cardExportCancelMessage(type2 = ''): string {
  return JSON.stringify({ type: 'cancel', type2 })
}

export function parseCardExportResult(message: string): CardExportResult {
  try {
    const result = JSON.parse(message) as Partial<CardExportResult> | null
    if (result && typeof result.type === 'string' && typeof result.type2 === 'string') {
      return { type: result.type, type2: result.type2 }
    }
  } catch {
    // Modal dismissal can replace the alert before it writes a result.
  }
  return { type: 'cancel', type2: '' }
}

export async function alertCardExport(type: string = ''): Promise<CardExportResult> {
  return parseCardExportResult(await queueWorkflow('cardexport', '', type))
}

export async function alertRealmTerms() {
  if (import.meta.env.VITE_RISU_AGENT_DEV_IGNORE_REALM_TERMS === 'TRUE') {
    return true
  }

  // Preserve acceptance recorded by the original shared application/Realm prompt.
  if (localStorage.getItem('tos4') === 'true') {
    return true
  }

  const result = await queueWorkflow('realmTerms', 'realmTerms')

  if (result === 'yes') {
    localStorage.setItem('tos4', 'true')
    return true
  }

  return false
}

export async function alertInput(msg: string, datalist?: [string, string][], defaultValue?: string) {
  return queueInput(msg, datalist, defaultValue)
}

export async function alertModuleSelect() {
  return queueWorkflow('selectModule', '')
}

export function alertRequestData(info: AlertGenerationInfoStoreData) {
  const character = charactersResourceState.characters[get(selectedCharID)]
  const chat = character?.chats?.[character.chatPage]
  const messages = chat?.message ?? []
  const indexedMessage = messages[info.idx]
  const generationId = info.genInfo.generationId
  const message =
    generationId && indexedMessage?.generationInfo?.generationId !== generationId
      ? messages.find(
          (candidate) => candidate.generationInfo?.generationId === generationId || candidate.chatId === generationId,
        )
      : indexedMessage
  alertGenerationInfoStore.set({
    ...info,
    characterId: info.characterId ?? character?.chaId,
    chatId: info.chatId ?? chat?.id,
    messageId: info.messageId ?? message?.chatId,
  })
  alertStoreImported.set({
    type: 'requestdata',
    msg: info.genInfo.generationId ?? 'none',
  })
}

export function alertRequestLogs() {
  alertStoreImported.set({
    type: 'requestlogs',
    msg: '',
  })
}
