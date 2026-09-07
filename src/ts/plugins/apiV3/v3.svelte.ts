import {
  assertClientWriteAccess,
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  clientSessionStore,
  isClientSessionGenerationCurrent,
  isClientReadOnly,
} from '../../clientSession'
import {
  allowedDbKeys,
  customProviderStore,
  getV2PluginAPIs,
  handlePluginInstallViaPlugin,
  isPluginRuntimeReady,
  pluginV2,
  type PluginV2ProviderArgument,
  type PluginV2ProviderOptions,
  type RisuPlugin,
} from '../plugins.svelte'
import { SandboxHost } from './factory'
import type { Database } from 'src/ts/storage/database.svelte'
import {
  applyPluginSettingsOwnerPatch,
  currentPluginCharacterOwnerSnapshot,
  currentPluginCharacterSnapshot,
  currentPluginChatOwnerSnapshot,
  currentPluginCollectionSnapshot,
  currentPluginDatabaseSnapshot,
  currentPluginSettingsOwnerSnapshot,
  currentPluginStateSnapshot,
  dispatchUpdatePlugin,
  replacePluginCharacterOwnerAt,
  replacePluginChatOwner,
  replacePluginCollectionOwner,
  rollbackPluginSettingsOwner,
} from 'src/ts/pluginCommands'
import { canUseServerCommands, type ServerCommandResult } from 'src/ts/server/commands'
import { dispatchDurableServerBackedSettingsPatch } from 'src/ts/server/settingsOwner.svelte'
import { currentCharacterRowSnapshot, prepareCompatibleCharacterUpdateScoped } from 'src/ts/characterCommands'
import {
  appendCurrentChatUserMessageForSend,
  captureActiveChatTarget,
  prepareCompatibleChatUpdateScoped,
  type CharacterOwnedDurableBatchResult,
} from 'src/ts/chatCommands'
import {
  SafeLocalPluginStorage,
  assertDeviceLocalPluginStorageEnabled,
  isDeviceLocalPluginStorageEnabled,
  tagWhitelist,
} from '../pluginSafeClass'
import {
  additionalChatMenu,
  additionalFloatingActionButtons,
  additionalHamburgerMenu,
  additionalSettingsMenu,
  bodyIntercepterStore,
  chatPanelStore,
  selectedCharID,
  type ChatPanelDef,
  type MenuDef,
} from 'src/ts/stores.svelte'
import DOMPurify from 'dompurify'
import { v4 } from 'uuid'
import { sleep } from 'src/ts/util'
import { alertConfirm, alertError, alertNormal } from 'src/ts/alert'
import { language } from 'src/lang'
import { checkCharOrder, getFetchLogs } from 'src/ts/globalApi.svelte'
import { builtInColorSchemes, updateColorScheme, updateTextThemeAndCSS, type ColorScheme } from 'src/ts/gui/colorscheme'
import { get } from 'svelte/store'
import { registerMCPModule, unregisterMCPModule } from 'src/ts/process/mcp/pluginmcp'
import { getInlayAsset } from 'src/ts/process/files/inlays'
import { getLLMCache, searchLLMCache } from 'src/ts/translator/translator'
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from 'src/ts/model/types'
import { sendChat as processSendChat } from 'src/ts/process/index.svelte'
import { coordinateAcceptedChatSend } from 'src/ts/process/acceptedSendCoordinator.svelte'
import { canUseGenerationOperationProtocol } from 'src/ts/server/generationOperations'
import { isChatGenerationKnown } from 'src/ts/process/reattach'
import { resolveModelProfileWithLegacyCompatibility } from 'src/ts/model/modelProfileResolver'
import type { ModelModeExtended } from 'src/ts/process/request/shared'
import { requestChatDataMain } from 'src/ts/process/request/request'
import { getModuleLorebooks } from 'src/ts/process/modules'
import {
  registerTTSPreprocessor,
  unregisterTTSPreprocessor,
  registerTTSPostprocessor,
  unregisterTTSPostprocessor,
  type BeforeTTSContext,
  type BeforeTTSResult,
  type AfterTTSContext,
  type AfterTTSResult,
  type TTSHookFn,
} from 'src/ts/process/ttsHooks'
import {
  ensureCharacterLorebookHydrated,
  hydrateChatMessages,
  isChatMessageTranscriptHydrated,
} from 'src/ts/server/chatMessageHydration.svelte'
import { assertNoUnsupportedCharacterChanges, assertNoUnsupportedChatChanges } from '../unsupportedServerWriteGuard'
import { clearInMemoryPluginPermissions, getPluginPermission } from '../pluginPermissions'
import {
  assertPluginNetworkDeadElementTree,
  assertPluginNetworkDeadStyle,
  isPluginNetworkCapableTag,
  normalizePluginIcon,
  normalizePluginNetworkDeadStyleAttribute,
  sanitizePluginNetworkDeadHtml,
} from '../pluginIconSafety'
import {
  addChatOutputListener,
  chatOutputListeners,
  removeChatOutputListener,
  type ChatOutputListener,
} from '../chatOutputListeners'

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function pluginV3MutationFailure(result: Exclude<ServerCommandResult, { status: 'ok' }>): never {
  if (result.status === 'error' && result.error) throw new Error(result.error)
  throw new Error(language.pluginMutation.failed)
}

function requirePluginV3Mutation(
  outcome:
    | {
        status: 'accepted' | 'queued' | 'failed'
        result: ServerCommandResult
      }
    | null
    | undefined,
): void {
  if (outcome?.status === 'failed') {
    pluginV3MutationFailure(outcome.result as Exclude<ServerCommandResult, { status: 'ok' }>)
  }
}

function requirePluginV3BatchMutation(outcome: CharacterOwnedDurableBatchResult | null): void {
  if (outcome?.status === 'failure') pluginV3MutationFailure(outcome.failure)
}

async function dispatchPluginApiSettingsPatch(
  patch: Record<string, unknown>,
  previous: Record<string, unknown>,
): Promise<void> {
  if (!canUseServerCommands()) return
  const attempted = cloneJsonValue(patch)
  const rollbackPrevious = cloneJsonValue(previous)
  const result = await dispatchDurableServerBackedSettingsPatch({
    patch: attempted,
    acknowledgeOptimistic: true,
    rollback: () => {
      const rolledBack = rollbackPluginSettingsOwner(rollbackPrevious, attempted)
      if (rolledBack.some((key) => key === 'colorScheme' || key === 'colorSchemeName' || key === 'customColorScheme')) {
        updateColorScheme()
      }
      if (rolledBack.some((key) => key === 'textTheme' || key === 'customTextTheme')) {
        updateTextThemeAndCSS()
      }
    },
  })
  if (result.status === 'ok' || result.status === 'unavailable') return
  if (result.status === 'error') throw new Error(result.error)
  throw new Error(language.errors.settingsSaveFailed)
}

/*
    V3 API for RisuAI Plugins

    Before adding new APIs here, please check the limitations

    - APIs must be a functions
        - If you want nested objects, first add as a plain function, `_getPluginStorage` for example
            And add it too _getAliases function ({'pluginStorage':{'getItem': '_getPluginStorage', ... }})
            This will make pluginStorage.getItem() work in plugins
        - If you need constants, use _getPropertiesForInitialization to set them up
            For example apiVersion and apiVersionCompatibleWith are set this way,
            Accessable in plugins as risuai.apiVersion
    - APIs must return, or accept as parameters, only the following types:
        - Serializable data (string, number, boolean, null, array, object)
        - Class instances marked with __classType = 'REMOTE_REQUIRED'
        - Callback functions (only as parameters)
        - Note that Class or Callbacks inside arrays or objects are not supported
*/

const pluginChannel = new Map<string, Function>()

class PluginLifecycleCleanup {
  #cleanups = new Set<() => void>()

  public track(cleanup: () => void): () => void {
    let active = true
    const wrapped = () => {
      if (!active) return
      active = false
      this.#cleanups.delete(wrapped)
      cleanup()
    }
    this.#cleanups.add(wrapped)
    return wrapped
  }

  public cleanupAll() {
    for (const cleanup of Array.from(this.#cleanups)) {
      cleanup()
    }
  }
}

class SafeElement {
  #element: HTMLElement
  #lifecycle?: PluginLifecycleCleanup
  __classType = 'REMOTE_REQUIRED' as const

  constructor(element: HTMLElement, lifecycle?: PluginLifecycleCleanup) {
    if (element.getAttribute('freezed')) {
      throw new Error('This element cannot be accessed by SafeELement')
    }
    this.#element = element
    this.#lifecycle = lifecycle
  }

  public appendChild(child: SafeElement) {
    assertPluginNetworkDeadElementTree(child.#element)
    this.#element.appendChild(child.#element)
  }

  public removeChild(child: SafeElement) {
    this.#element.removeChild(child.#element)
  }

  public replaceChild(newChild: SafeElement, oldChild: SafeElement) {
    assertPluginNetworkDeadElementTree(newChild.#element)
    this.#element.replaceChild(newChild.#element, oldChild.#element)
  }

  public replaceWith(newElement: SafeElement) {
    assertPluginNetworkDeadElementTree(newElement.#element)
    this.#element.replaceWith(newElement.#element)
  }

  public cloneNode(deep: boolean = false): SafeElement {
    assertPluginNetworkDeadElementTree(this.#element)
    const cloned = this.#element.cloneNode(deep)
    return new SafeElement(cloned as HTMLElement, this.#lifecycle)
  }

  public prepend(child: SafeElement) {
    assertPluginNetworkDeadElementTree(child.#element)
    this.#element.prepend(child.#element)
  }

  public remove() {
    this.#element.remove()
  }

  public innerText(): string {
    return this.#element.innerText
  }

  public textContent(): string | null {
    return this.#element.textContent
  }

  public setTextContent(value: string) {
    if (this.#element.localName === 'style') throw new Error('Plugin access to style element content is unavailable.')
    this.#element.textContent = value
  }

  public setInnerText(value: string) {
    if (this.#element.localName === 'style') throw new Error('Plugin access to style element content is unavailable.')
    this.#element.innerText = value
  }

  public setAttribute(name: string, value: string) {
    if (!name.startsWith('x-')) {
      throw new Error(
        "Can only set attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.",
      )
    }
    this.#element.setAttribute(name, value)
  }
  public getAttribute(name: string): string | null {
    if (!name.startsWith('x-')) {
      throw new Error(
        "Can only get attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.",
      )
    }
    return this.#element.getAttribute(name)
  }
  public setStyle(property: string, value: string) {
    assertPluginNetworkDeadStyle(property, value)
    ;(this.#element.style as any)[property] = value
  }
  public getStyle(property: string): string {
    return (this.#element.style as any)[property]
  }
  public getStyleAttribute(): string {
    return this.#element.getAttribute('style') || ''
  }
  public setStyleAttribute(value: string) {
    this.#element.setAttribute('style', normalizePluginNetworkDeadStyleAttribute(value))
  }
  public addClass(className: string) {
    this.#element.classList.add(className)
  }
  public removeClass(className: string) {
    this.#element.classList.remove(className)
  }
  public setClassName(className: string) {
    this.#element.className = className
  }
  public getClassName() {
    return this.#element.className
  }
  public hasClass(className: string): boolean {
    //We don't need to check the className here since we're just checking
    return this.#element.classList.contains(className)
  }
  public focus() {
    this.#element.focus()
  }
  public getChildren(): SafeClassArray<SafeElement> {
    const children: SafeElement[] = []
    this.#element.childNodes.forEach((node) => {
      if (node instanceof HTMLElement) {
        children.push(new SafeElement(node, this.#lifecycle))
      }
    })
    return new SafeClassArray<SafeElement>(children)
  }
  public getParent(): SafeElement | null {
    if (this.#element.parentElement) {
      return new SafeElement(this.#element.parentElement, this.#lifecycle)
    }
    return null
  }
  public getInnerHTML(): string {
    return this.#element.innerHTML
  }
  public getOuterHTML(): string {
    return this.#element.outerHTML
  }
  public clientHeight(): number {
    return this.#element.clientHeight
  }
  public clientWidth(): number {
    return this.#element.clientWidth
  }
  public clientTop(): number {
    return this.#element.clientTop
  }
  public clientLeft(): number {
    return this.#element.clientLeft
  }
  public nodeName(): string {
    return this.#element.nodeName
  }
  public nodeType(): number {
    return this.#element.nodeType
  }
  public querySelectorAll(selector: string): SafeClassArray<SafeElement> {
    const nodeList = this.#element.querySelectorAll(selector)
    const elements: SafeElement[] = []
    nodeList.forEach((node) => {
      if (node instanceof HTMLElement) {
        elements.push(new SafeElement(node, this.#lifecycle))
      }
    })
    return new SafeClassArray<SafeElement>(elements)
  }
  public querySelector(selector: string): SafeElement | null {
    const element = this.#element.querySelector(selector)
    if (element instanceof HTMLElement) {
      return new SafeElement(element, this.#lifecycle)
    }
    return null
  }
  public getElementById(id: string): SafeElement | null {
    const element = this.querySelector('#' + id)
    return element
  }
  public getElementsByClassName(className: string): SafeClassArray<SafeElement> {
    return this.querySelectorAll('.' + className)
  }
  public getClientRects(): DOMRectList {
    return this.#element.getClientRects()
  }
  public getBoundingClientRect(): DOMRect {
    return this.#element.getBoundingClientRect()
  }
  public setInnerHTML(value: string) {
    if (this.#element.localName === 'style') throw new Error('Plugin access to style element content is unavailable.')
    const san = sanitizePluginNetworkDeadHtml(value)
    this.#element.innerHTML = san
  }
  public setOuterHTML(value: string) {
    const san = sanitizePluginNetworkDeadHtml(value)
    this.#element.outerHTML = san
  }
  public scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
    this.#element.scrollIntoView(options)
  }
  #eventIdMap = new Map<
    string,
    {
      type: string
      listener: EventListenerOrEventListenerObject
      options: EventListenerOptions
      cancelPending?: () => void
      cleanup: () => void
    }
  >()

  public async addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: boolean | AddEventListenerOptions,
  ): Promise<string> {
    const realOptions = typeof options === 'boolean' ? { capture: options } : options || {}

    //allowed with unlimited
    const allowedDocumentEventListeners = [
      'click',
      'dblclick',
      'contextmenu',
      'mousedown',
      'mouseup',
      'mousemove',
      'mouseover',
      'mouseleave',
      'pointercancel',
      'pointerdown',
      'pointerenter',
      'pointerleave',
      'pointermove',
      'pointerout',
      'pointerover',
      'pointerup',
      'scroll',
      'scrollend',
    ]

    //allowed, but it has fingerprinting issues,
    //so it will be delayed random ms.
    const allowedDelayedEventListeners = ['keydown', 'keyup', 'keypress']

    const id = v4()

    const trimEvent = (event: MouseEvent | KeyboardEvent | Event) => {
      if (event instanceof MouseEvent) {
        return {
          type: event.type,
          clientX: event.clientX,
          clientY: event.clientY,
          button: event.button,
          buttons: event.buttons,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        }
      } else if (event instanceof KeyboardEvent) {
        return {
          type: event.type,
          key: event.key,
          code: event.code,
          repeat: event.repeat,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        }
      } else {
        return {
          type: event.type,
        }
      }
    }

    if (allowedDocumentEventListeners.includes(type)) {
      const modifiedListener = (event: any) => {
        listener(trimEvent(event))
      }
      document.addEventListener(type, modifiedListener, realOptions)
      const cleanup = this.#lifecycle?.track(() => {
        document.removeEventListener(type, modifiedListener, realOptions)
        this.#eventIdMap.delete(id)
      })
      this.#eventIdMap.set(id, {
        type,
        listener: modifiedListener,
        options: realOptions,
        cleanup: cleanup ?? (() => {}),
      })
      return id
    } else if (allowedDelayedEventListeners.includes(type)) {
      const pendingCallbacks = new Set<ReturnType<typeof setTimeout>>()
      const cancelPending = () => {
        for (const timeout of pendingCallbacks) {
          clearTimeout(timeout)
        }
        pendingCallbacks.clear()
      }
      const modifiedListener = (event: any) => {
        let delay = 0
        try {
          delay = (crypto.getRandomValues(new Uint32Array(1))[0] / 100) % 100 //0-99 ms
        } catch (error) {}
        const timeout = setTimeout(() => {
          pendingCallbacks.delete(timeout)
          listener(trimEvent(event))
        }, delay)
        pendingCallbacks.add(timeout)
      }
      document.addEventListener(type, modifiedListener, realOptions)
      const cleanup = this.#lifecycle?.track(() => {
        cancelPending()
        document.removeEventListener(type, modifiedListener, realOptions)
        this.#eventIdMap.delete(id)
      })
      this.#eventIdMap.set(id, {
        type,
        listener: modifiedListener,
        options: realOptions,
        cancelPending,
        cleanup: cleanup ?? (() => {}),
      })
      return id
    } else {
      throw new Error(`Event listener of type '${type}' is not allowed for security reasons.`)
    }
  }

  public removeEventListener(type: string, id: string, options?: boolean | EventListenerOptions) {
    const record = this.#eventIdMap.get(id)
    if (record) {
      const realOptions = typeof options === 'boolean' ? { capture: options } : options || {}
      record.cancelPending?.()
      document.removeEventListener(type, record.listener, realOptions)
      this.#eventIdMap.delete(id)
      record.cleanup()
    }
  }

  public matches(selector: string): boolean {
    return this.#element.matches(selector)
  }
}

class SafeDocument extends SafeElement {
  __classType = 'REMOTE_REQUIRED' as const
  #lifecycle?: PluginLifecycleCleanup

  constructor(document: Document, lifecycle?: PluginLifecycleCleanup) {
    super(document.documentElement, lifecycle)
    this.#lifecycle = lifecycle
  }
  createElement(tagName: string): SafeElement {
    if (!tagWhitelist.includes(tagName.toLowerCase()) || isPluginNetworkCapableTag(tagName)) {
      console.warn(`Creation of <${tagName}> elements is restricted. Creating a <div> instead.`)
      tagName = 'div'
    }
    if (tagName.toLowerCase() === 'a') {
      console.warn(
        `<a> can be created but href attribute cannot be set directly for security reasons. Use .createAnchorElement(href: string) to create safe anchor elements.`,
      )
    }
    const element = document.createElement(tagName)
    return new SafeElement(element, this.#lifecycle)
  }
  createAnchorElement(href: string): SafeElement {
    const anchor = document.createElement('a')
    try {
      const url = new URL(href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Invalid protocol')
      }
      anchor.setAttribute('href', url.toString())
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer')
    } catch (error) {
      console.warn(`Invalid URL provided for anchor element: ${href}. Setting href to '#' instead.`)
      anchor.setAttribute('href', '#')
    }
    return new SafeElement(anchor, this.#lifecycle)
  }
}

type SafeMutationRecordObject = {
  type: string
  target: SafeElement
  addedNodes: SafeElement[]
}

class SafeClassArray<T> {
  #items: T[]
  __classType = 'REMOTE_REQUIRED' as const
  constructor(items: T[] = []) {
    this.#items = items
  }
  at(index: number): T {
    return this.#items.at(index)
  }
  length(): number {
    return this.#items.length
  }
  push(item: T) {
    this.#items.push(item)
  }
}

class SafeMutationRecord {
  __classType = 'REMOTE_REQUIRED' as const
  #type: string
  #target: SafeElement
  #addedNodes: SafeClassArray<SafeElement>
  constructor(type: string, target: SafeElement, addedNodes: SafeElement[]) {
    this.#type = type
    this.#target = target
    this.#addedNodes = new SafeClassArray<SafeElement>(addedNodes)
  }
  getType(): string {
    return this.#type
  }
  getTarget(): SafeElement {
    return this.#target
  }
  getAddedNodes(): SafeClassArray<SafeElement> {
    return this.#addedNodes
  }
}

type SafeMutationCallback = (mutations: SafeClassArray<SafeMutationRecord>) => void

class SafeMutationObserver {
  #observer: MutationObserver
  #cleanup: () => void
  __classType = 'REMOTE_REQUIRED' as const
  constructor(callback: SafeMutationCallback, lifecycle?: PluginLifecycleCleanup) {
    this.#observer = new MutationObserver((mutations) => {
      const safeMutations: SafeMutationRecordObject[] = mutations.map((mutation) => {
        const elementMapHelper = (nodeList: NodeList): SafeElement[] => {
          const elements: SafeElement[] = []
          nodeList.forEach((node) => {
            if (node instanceof HTMLElement) {
              elements.push(new SafeElement(node, lifecycle))
            }
          })
          return elements
        }

        return {
          type: mutation.type,
          target: new SafeElement(mutation.target as HTMLElement, lifecycle),
          addedNodes: elementMapHelper(mutation.addedNodes),
          removedNodes: elementMapHelper(mutation.removedNodes),
        }
      })

      const safeClassed = new SafeClassArray<SafeMutationRecord>([])
      for (const record of safeMutations) {
        safeClassed.push(new SafeMutationRecord(record.type, record.target, record.addedNodes))
      }
      callback(safeClassed)
    })
    this.#cleanup = lifecycle?.track(() => this.#observer.disconnect()) ?? (() => {})
  }

  observe(element: SafeElement, options: MutationObserverInit) {
    const identifier = v4()
    element.setAttribute('x-identifier', identifier)
    const rawElement = document.querySelector(`[x-identifier="${identifier}"]`) as HTMLElement
    if (rawElement) {
      this.#observer.observe(rawElement, options)
      element.setAttribute('x-identifier', '')
    }
  }

  disconnect() {
    this.#cleanup()
  }
}

type V3PluginInstance = {
  name: string
  host?: SandboxHost
  lifecycle: PluginLifecycleCleanup
  generation: number
  sessionGeneration: number
  active: boolean
}

type PluginUnloadCallback = {
  generation: number
  callback: Function
}

const v3PluginInstances: V3PluginInstance[] = []
let v3GenerationCounter = 0
let activeV3Generation = 0

function ensureV3Generation() {
  if (activeV3Generation === 0) {
    activeV3Generation = ++v3GenerationCounter
  }
  return activeV3Generation
}

function beginV3Generation() {
  activeV3Generation = ++v3GenerationCounter
  for (const instance of v3PluginInstances) {
    instance.active = false
  }
  syncV3ProviderRegistrations()
  return activeV3Generation
}

function isV3InstanceCurrent(instance: V3PluginInstance) {
  return (
    canUseClientWriteAccess() &&
    isClientSessionGenerationCurrent(instance.sessionGeneration) &&
    instance.active &&
    instance.generation === activeV3Generation
  )
}

function assertV3InstanceCurrent(instance: V3PluginInstance) {
  assertClientWriteAccess()
  if (!isV3InstanceCurrent(instance)) {
    throw new Error(`[RisuAI Plugin: ${instance.name}] Plugin instance is no longer active.`)
  }
}

const pluginUnloadCallbacks: Map<string, PluginUnloadCallback[]> = new Map()

const addPluginUnloadCallback = (pluginName: string, callback: Function, generation = activeV3Generation) => {
  if (!pluginUnloadCallbacks.has(pluginName)) {
    pluginUnloadCallbacks.set(pluginName, [])
  }
  pluginUnloadCallbacks.get(pluginName)?.push({ generation, callback })
}

type V3OwnedMenuDef = MenuDef & {
  __v3OwnerGeneration: number
  __v3OwnerName: string
  __v3OwnerToken: string
}

type V3OwnedChatPanelDef = ChatPanelDef & {
  __v3OwnerGeneration: number
  __v3OwnerToken: string
}

const ownMenuDef = (menuDef: MenuDef, instance: V3PluginInstance): V3OwnedMenuDef => {
  return {
    ...menuDef,
    __v3OwnerGeneration: instance.generation,
    __v3OwnerName: instance.name,
    __v3OwnerToken: v4(),
  }
}

const makeMenuUnloadCallback = (menuDef: V3OwnedMenuDef, menuStore: MenuDef[]) => {
  return () => {
    const index = menuStore.findIndex(
      (item) => item.id === menuDef.id && (item as V3OwnedMenuDef).__v3OwnerToken === menuDef.__v3OwnerToken,
    )
    if (index !== -1) {
      menuStore.splice(index, 1)
    }
  }
}

const removeOwnedChatPanel = (id: string, instance: V3PluginInstance) => {
  const index = chatPanelStore.findIndex((item) => {
    const owned = item as V3OwnedChatPanelDef
    return item.id === id && item.pluginName === instance.name && owned.__v3OwnerGeneration === instance.generation
  })
  if (index !== -1) chatPanelStore.splice(index, 1)
}

const makeChatPanelUnloadCallback = (panel: V3OwnedChatPanelDef) => {
  return () => {
    const index = chatPanelStore.findIndex(
      (item) => (item as V3OwnedChatPanelDef).__v3OwnerToken === panel.__v3OwnerToken,
    )
    if (index !== -1) chatPanelStore.splice(index, 1)
  }
}

const takePluginUnloadCallbacks = (pluginName: string, generation: number): Function[] => {
  const records = pluginUnloadCallbacks.get(pluginName)
  if (!records) return []

  const callbacks: Function[] = []
  const remaining: PluginUnloadCallback[] = []
  for (const record of records) {
    if (record.generation === generation) {
      callbacks.push(record.callback)
    } else {
      remaining.push(record)
    }
  }

  if (remaining.length === 0) {
    pluginUnloadCallbacks.delete(pluginName)
  } else {
    pluginUnloadCallbacks.set(pluginName, remaining)
  }
  return callbacks
}

const runPluginUnloadCallbacks = async (pluginName: string, callbacks: Function[]) => {
  let promises: Promise<void>[] = []
  for (const callback of callbacks) {
    try {
      const result = callback()
      if (result instanceof Promise) {
        promises.push(
          result.catch((error) => {
            console.error(`Error running unload callback for plugin ${pluginName}:`, error)
          }),
        )
      }
    } catch (error) {
      console.error(`Error running unload callback for plugin ${pluginName}:`, error)
    }
  }

  await Promise.any([
    Promise.all(promises),
    sleep(1000), //timeout after 1 second
  ])
}

const unloadV3PluginInstance = async (instance: V3PluginInstance) => {
  instance.active = false
  const index = v3PluginInstances.indexOf(instance)
  if (index !== -1) {
    v3PluginInstances.splice(index, 1)
  }

  const callbacks = takePluginUnloadCallbacks(instance.name, instance.generation)
  try {
    await runPluginUnloadCallbacks(instance.name, callbacks)
  } finally {
    try {
      instance.lifecycle.cleanupAll()
      instance.host?.terminate()
    } catch (error) {
      console.error(`Error terminating plugin ${instance.name}:`, error)
    }
  }
}

const unloadV3Plugin = async (pluginName: string) => {
  const instance = v3PluginInstances.find((p) => p.name === pluginName)
  if (!instance) {
    await runPluginUnloadCallbacks(pluginName, takePluginUnloadCallbacks(pluginName, activeV3Generation))
    return
  }
  await unloadV3PluginInstance(instance)
}

type PluginV3ProviderOptions = PluginV2ProviderOptions & {
  model?: LLMModel
}

export const customV3ProviderMetaStore: LLMModel[] = []

type V3ProviderRegistration = {
  pluginName: string
  generation: number
  name: string
  handler: (
    arg: PluginV2ProviderArgument,
    abortSignal?: AbortSignal,
  ) => Promise<{ success: boolean; content: string | ReadableStream<string> }>
  options: PluginV2ProviderOptions
  modelData: LLMModel
}

const v3ProviderRegistrations: V3ProviderRegistration[] = []
const v3SyncedProviderRegistrations = new Map<string, V3ProviderRegistration>()
const registeredV3ProviderUnloadCallbacks = new Set<string>()

function syncCustomProviderStoreFromMap() {
  customProviderStore.set(isPluginRuntimeReady() ? Array.from(pluginV2.providers.keys()) : [])
}

function getActiveV3ProviderRegistrations() {
  const active = new Map<string, V3ProviderRegistration>()
  for (const registration of v3ProviderRegistrations) {
    if (registration.generation !== activeV3Generation) {
      continue
    }
    active.set(registration.name, registration)
  }
  return active
}

function syncV3ProviderRegistrations() {
  const active = getActiveV3ProviderRegistrations()
  const knownNames = new Set([...v3SyncedProviderRegistrations.keys(), ...active.keys()])

  for (const name of knownNames) {
    const previous = v3SyncedProviderRegistrations.get(name)
    const next = active.get(name)
    if (next) {
      pluginV2.providers.set(name, next.handler)
      pluginV2.providerOptions.set(name, next.options)
      v3SyncedProviderRegistrations.set(name, next)
    } else {
      if (previous && pluginV2.providers.get(name) === previous.handler) {
        pluginV2.providers.delete(name)
        pluginV2.providerOptions.delete(name)
      }
      v3SyncedProviderRegistrations.delete(name)
    }
  }

  customV3ProviderMetaStore.splice(
    0,
    customV3ProviderMetaStore.length,
    ...Array.from(active.values()).map((registration) => registration.modelData),
  )
  syncCustomProviderStoreFromMap()
}

function unregisterV3ProvidersForPlugin(pluginName: string, generation?: number) {
  for (let i = v3ProviderRegistrations.length - 1; i >= 0; i--) {
    const registration = v3ProviderRegistrations[i]
    if (
      registration.pluginName === pluginName &&
      (generation === undefined || registration.generation === generation)
    ) {
      v3ProviderRegistrations.splice(i, 1)
    }
  }
  if (generation === undefined) {
    for (const key of Array.from(registeredV3ProviderUnloadCallbacks)) {
      if (key.endsWith(`:${pluginName}`)) {
        registeredV3ProviderUnloadCallbacks.delete(key)
      }
    }
  } else {
    registeredV3ProviderUnloadCallbacks.delete(`${generation}:${pluginName}`)
  }
  syncV3ProviderRegistrations()
}

function registerV3Provider(registration: V3ProviderRegistration) {
  if (registration.generation !== activeV3Generation) {
    return
  }

  for (let i = v3ProviderRegistrations.length - 1; i >= 0; i--) {
    const existing = v3ProviderRegistrations[i]
    if (
      existing.pluginName === registration.pluginName &&
      existing.generation === registration.generation &&
      existing.name === registration.name
    ) {
      v3ProviderRegistrations.splice(i, 1)
    }
  }

  v3ProviderRegistrations.push(registration)
  const unloadKey = `${registration.generation}:${registration.pluginName}`
  if (!registeredV3ProviderUnloadCallbacks.has(unloadKey)) {
    registeredV3ProviderUnloadCallbacks.add(unloadKey)
    addPluginUnloadCallback(
      registration.pluginName,
      () => unregisterV3ProvidersForPlugin(registration.pluginName, registration.generation),
      registration.generation,
    )
  }
  syncV3ProviderRegistrations()
}

const authorizationHeaders = ['x-api-key', 'authorization', 'proxy-authorization']

const guardV3Api = (api: Record<string, unknown>, instance: V3PluginInstance): Record<string, unknown> => {
  const callbacks = new WeakMap<Function, Function>()
  const unloadCallbacks = new WeakMap<Function, Function>()
  const guardCallback = (callback: Function, onUnload: boolean): Function => {
    const callbackMap = onUnload ? unloadCallbacks : callbacks
    let guarded = callbackMap.get(callback)
    if (!guarded) {
      guarded = (...args: unknown[]) => {
        // Ordinary unload callbacks may run after the instance is retired, but
        // no guest callback may run after the connected writer loses authority.
        if (onUnload) {
          if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(instance.sessionGeneration)) return
        } else assertV3InstanceCurrent(instance)
        const result = callback(...args)
        if (!onUnload && result instanceof Promise) {
          return result.then((value) => {
            assertV3InstanceCurrent(instance)
            return value
          })
        }
        return result
      }
      callbackMap.set(callback, guarded)
    }
    return guarded
  }
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') {
        return value
      }
      return (...args: unknown[]) => {
        assertV3InstanceCurrent(instance)
        return value.apply(
          target,
          args.map((arg) => (typeof arg === 'function' ? guardCallback(arg, prop === 'onUnload') : arg)),
        )
      }
    },
  })
}

const makeRisuaiAPIV3 = (
  iframe: HTMLIFrameElement,
  plugin: RisuPlugin,
  lifecycle: PluginLifecycleCleanup,
  instance: V3PluginInstance,
) => {
  const oldApis = getV2PluginAPIs(
    plugin,
    () => assertV3InstanceCurrent(instance),
    (cleanup) => lifecycle.track(cleanup),
  )
  const setCurrentCharacter = async (char: any): Promise<void> => {
    const charIndex = get(selectedCharID)
    const previousCharacter = currentPluginCharacterSnapshot(charIndex)
    if (!previousCharacter?.chaId) return
    if (!canUseServerCommands()) {
      replacePluginCharacterOwnerAt(charIndex, previousCharacter.chaId, char)
      return
    }

    assertNoUnsupportedCharacterChanges(previousCharacter, char, 'setCharacter')
    const previous = currentCharacterRowSnapshot(charIndex)
    const preparation = prepareCompatibleCharacterUpdateScoped(previousCharacter, char, previous)
    const optimisticCharacter = preparation.optimisticCharacter
    if (!optimisticCharacter || preparation.factories.length === 0) return
    if (!replacePluginCharacterOwnerAt(charIndex, previousCharacter.chaId, optimisticCharacter)) return
    const outcome = await preparation.dispatchAsync()
    assertV3InstanceCurrent(instance)
    requirePluginV3Mutation(outcome)
  }
  const registerOwnedMCP = async (
    arg: Parameters<typeof registerMCPModule>[0],
    getToolList: Parameters<typeof registerMCPModule>[1],
    callTool: Parameters<typeof registerMCPModule>[2],
  ): Promise<void> => {
    const client = await registerMCPModule(arg, getToolList, callTool)
    try {
      assertV3InstanceCurrent(instance)
    } catch (error) {
      await unregisterMCPModule(arg.identifier, client)
      throw error
    }

    const cleanup = lifecycle.track(() => {
      void unregisterMCPModule(arg.identifier, client)
    })
    addPluginUnloadCallback(plugin.name, cleanup, instance.generation)
  }
  const api = {
    //Old APIs from v2.1
    risuFetch: (url, options) => {
      console.error(
        `[DEPRECATION WARNING] risuFetch is deprecated and will be removed in future versions. Please use nativeFetch instead.`,
      )
      //scan headers
      const headers = options?.headers || {}
      for (const headerName in headers) {
        if (authorizationHeaders.includes(headerName.toLowerCase())) {
          console.warn(
            `Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to only work with nativeFetch.`,
          )
        }
      }
      return oldApis.risuFetch(url, options)
    },
    nativeFetch: (url, options) => {
      //scan headers
      const headers = options?.headers || {}
      for (const headerName in headers) {
        if (authorizationHeaders.includes(headerName.toLowerCase())) {
          console.warn(
            `Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to use server-side approch with write-only api access in the future for better security.`,
          )
        }
      }
      return oldApis.nativeFetch(url, options)
    },
    getChar: oldApis.getChar,
    setChar: setCurrentCharacter,
    addProvider: (
      name: string,
      func: (
        arg: PluginV2ProviderArgument,
        abortSignal?: AbortSignal,
      ) => Promise<{ success: boolean; content: string | ReadableStream<string> }>,
      options?: PluginV3ProviderOptions,
    ) => {
      console.warn(
        `[WARN] addProvider is a powerful API that can potentially be unsafe if used incorrectly. addProvider's functionality might be limited or changed in future updates to ensure security. please use other APIs if possible.`,
      )
      const handler = async (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => {
        assertV3InstanceCurrent(instance)
        const conf = await getPluginPermission(plugin.name, 'provider', 'periodically', plugin.script, () =>
          assertV3InstanceCurrent(instance),
        )
        assertV3InstanceCurrent(instance)
        if (!conf) {
          return { success: false, content: language.permissionDenied }
        }
        // Force v3 mode for plugin provider isolation.
        arg.mode = 'v3'
        return await func(arg, abortSignal)
      }

      const modelData: LLMModel = {
        id: `pluginmodel:::${name}`,
        name: options?.model?.name ?? name,
        shortName: options?.model?.shortName ?? name,
        fullName: options?.model?.fullName ?? name,
        internalID: options?.model?.internalID ?? `pluginmodel:::${name}`,
        provider: LLMProvider.AsIs,
        format: LLMFormat.Plugin,
        flags: options?.model?.flags ?? [LLMFlags.hasFullSystemPrompt],
        parameters: options?.model?.parameters ?? [
          'temperature',
          'top_p',
          'frequency_penalty',
          'presence_penalty',
          'repetition_penalty',
          'min_p',
          'top_a',
          'top_k',
          'thinking_tokens',
        ],
        tokenizer: options?.model?.tokenizer ?? LLMTokenizer.Unknown,
      }
      registerV3Provider({
        pluginName: plugin.name,
        generation: instance.generation,
        name,
        handler,
        options: options ?? {},
        modelData,
      })
    },
    addTTSPreprocessor: async (func: TTSHookFn<BeforeTTSContext, BeforeTTSResult>) => {
      registerTTSPreprocessor(func)
      addPluginUnloadCallback(plugin.name, () => unregisterTTSPreprocessor(func))
    },
    addTTSPostprocessor: async (func: TTSHookFn<AfterTTSContext, AfterTTSResult>) => {
      registerTTSPostprocessor(func)
      addPluginUnloadCallback(plugin.name, () => unregisterTTSPostprocessor(func))
    },
    addRisuScriptHandler: oldApis.addRisuScriptHandler,
    removeRisuScriptHandler: oldApis.removeRisuScriptHandler,
    addRisuReplacer: async (name: string, func: Function) => {
      //permission check for replacer
      const conf = await getPluginPermission(plugin.name, 'replacer', 'periodically', plugin.script, () =>
        assertV3InstanceCurrent(instance),
      )
      assertV3InstanceCurrent(instance)
      if (!conf) {
        return
      }
      oldApis.addRisuReplacer(name, func as any)
    },
    removeRisuReplacer: oldApis.removeRisuReplacer,
    addRisuChatListener: async (mode: 'output', func: ChatOutputListener) => {
      addChatOutputListener(mode, func)
      addPluginUnloadCallback(plugin.name, () => removeChatOutputListener(mode, func), instance.generation)
    },
    removeRisuChatListener: (mode: 'output', func: ChatOutputListener) => {
      removeChatOutputListener(mode, func)
    },
    setDatabaseLite: oldApis.setDatabaseLite,
    setDatabase: oldApis.setDatabase,
    loadPlugins: oldApis.loadPlugins,
    readImage: oldApis.readImage,
    readInlay: async (id: string) => {
      const inlay = await getInlayAsset(id)
      if (!inlay || typeof inlay.data !== 'string') return null
      return {
        data: inlay.data,
        ext: inlay.ext,
        name: inlay.name,
        type: inlay.type,
        ...(inlay.height !== undefined ? { height: inlay.height } : {}),
        ...(inlay.width !== undefined ? { width: inlay.width } : {}),
      }
    },
    saveAsset: oldApis.saveAsset,
    //Same functionality, but new implementation
    getDatabase: async (includeOnly: string[] | 'all' = 'all') => {
      const conf = await getPluginPermission(plugin.name, 'db', 'periodically', plugin.script, () =>
        assertV3InstanceCurrent(instance),
      )
      assertV3InstanceCurrent(instance)
      if (!conf) {
        return null
      }
      const db = currentPluginDatabaseSnapshot()
      const liteDB: Record<string, unknown> = {}
      for (const key of allowedDbKeys) {
        if (includeOnly !== 'all' && !includeOnly.includes(key)) {
          continue
        }
        liteDB[key] = cloneJsonValue(db[key])
      }
      return liteDB
    },

    installPlugin: handlePluginInstallViaPlugin,

    // --- Color Scheme APIs ---
    changeColorScheme: (name: string) => {
      const settings = currentPluginSettingsOwnerSnapshot(['customColorScheme', 'colorScheme', 'colorSchemeName'])
      const colorScheme =
        name === 'custom' ? settings.customColorScheme : builtInColorSchemes[name as keyof typeof builtInColorSchemes]
      if (name !== 'custom' && !colorScheme) {
        throw new Error(`Invalid color scheme: ${name}`)
      }
      const previous = {
        colorScheme: cloneJsonValue(settings.colorScheme),
        colorSchemeName: settings.colorSchemeName,
      }
      const patch = {
        colorSchemeName: name,
        colorScheme: cloneJsonValue(colorScheme),
      }
      applyPluginSettingsOwnerPatch(patch)
      updateColorScheme()
      return dispatchPluginApiSettingsPatch(patch, previous)
    },
    setColorScheme: (scheme: ColorScheme) => {
      const requiredKeys = [
        'bgcolor',
        'darkbg',
        'borderc',
        'selected',
        'draculared',
        'textcolor',
        'textcolor2',
        'darkBorderc',
        'darkbutton',
        'type',
      ] as const
      for (const key of requiredKeys) {
        if (typeof (scheme as any)[key] !== 'string') {
          throw new Error(`Invalid color scheme: missing or invalid '${key}'`)
        }
      }
      if (scheme.type !== 'light' && scheme.type !== 'dark') {
        throw new Error('Invalid color scheme type: must be "light" or "dark"')
      }
      const previous = {
        ...currentPluginSettingsOwnerSnapshot(['colorScheme', 'colorSchemeName', 'customColorScheme']),
      }
      const patch = {
        colorSchemeName: 'custom',
        customColorScheme: cloneJsonValue(scheme),
        colorScheme: cloneJsonValue(scheme),
      }
      applyPluginSettingsOwnerPatch(patch)
      updateColorScheme()
      return dispatchPluginApiSettingsPatch(patch, previous)
    },
    getColorScheme: () => {
      const settings = currentPluginSettingsOwnerSnapshot(['colorSchemeName', 'colorScheme'])
      return {
        name: settings.colorSchemeName,
        scheme: cloneJsonValue(settings.colorScheme),
      }
    },

    // --- Text Theme APIs ---
    changeTextTheme: (name: string) => {
      if (!['standard', 'highcontrast'].includes(name)) {
        throw new Error(`Invalid text theme: ${name}`)
      }
      const previous = {
        ...currentPluginSettingsOwnerSnapshot(['textTheme']),
      }
      const patch = { textTheme: name }
      applyPluginSettingsOwnerPatch(patch)
      updateTextThemeAndCSS()
      return dispatchPluginApiSettingsPatch(patch, previous)
    },
    setCustomTextTheme: (theme: {
      FontColorStandard: string
      FontColorBold: string
      FontColorItalic: string
      FontColorItalicBold: string
      FontColorQuote1: string
      FontColorQuote2: string
    }) => {
      const requiredKeys = [
        'FontColorStandard',
        'FontColorBold',
        'FontColorItalic',
        'FontColorItalicBold',
        'FontColorQuote1',
        'FontColorQuote2',
      ] as const
      for (const key of requiredKeys) {
        if (typeof (theme as any)[key] !== 'string') {
          throw new Error(`Invalid text theme: missing or invalid '${key}'`)
        }
      }
      const previous = {
        ...currentPluginSettingsOwnerSnapshot(['textTheme', 'customTextTheme']),
      }
      const patch = {
        textTheme: 'custom',
        customTextTheme: cloneJsonValue(theme),
      }
      applyPluginSettingsOwnerPatch(patch)
      updateTextThemeAndCSS()
      return dispatchPluginApiSettingsPatch(patch, previous)
    },
    getTextTheme: () => {
      const settings = currentPluginSettingsOwnerSnapshot(['textTheme', 'customTextTheme'])
      return {
        name: settings.textTheme,
        customTheme: cloneJsonValue(settings.customTextTheme),
      }
    },

    //Deprecated APIs from v2.1
    //Use getArgument / setArgument instead if possible
    getArg: oldApis.getArg,
    setArg: async (arg: string, value: string | number) => {
      const outcome = await oldApis.setArg(arg, value)
      assertV3InstanceCurrent(instance)
      requirePluginV3Mutation(outcome)
    },

    //New APIs for v3
    getArgument: async (key: string) => {
      const matches = currentPluginCollectionSnapshot().filter((candidate) => candidate.name === plugin.name)
      if (matches.length !== 1) return undefined
      return matches[0].realArg?.[key]
    },
    setArgument: async (key: string, value: string | number) => {
      const previous = currentPluginStateSnapshot()
      const plugins = currentPluginCollectionSnapshot()
      const matches = plugins
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) => candidate.name === plugin.name)
      if (matches.length !== 1) return
      const [{ candidate, index }] = matches
      const nextPlugin = {
        ...candidate,
        realArg: { ...(candidate.realArg ?? {}), [key]: value },
      }
      plugins[index] = nextPlugin
      replacePluginCollectionOwner(plugins)
      const outcome = await dispatchUpdatePlugin(candidate.name, { realArg: nextPlugin.realArg }, previous)
      assertV3InstanceCurrent(instance)
      requirePluginV3Mutation(outcome)
    },
    getCharacterFromIndex: (index: number) => {
      return currentPluginCharacterSnapshot(index) ?? null
    },
    setCharacterToIndex: async (index: number, char: any) => {
      const previousCharacter = currentPluginCharacterSnapshot(index)
      if (!previousCharacter?.chaId) return
      if (!canUseServerCommands()) {
        replacePluginCharacterOwnerAt(index, previousCharacter.chaId, char)
        return
      }

      assertNoUnsupportedCharacterChanges(previousCharacter, char, 'setCharacterToIndex')
      const previous = currentCharacterRowSnapshot(index)
      // Route through the durable character-owner dispatcher so transient
      // failures retain the plugin's optimistic replacement for replay.
      const preparation = prepareCompatibleCharacterUpdateScoped(previousCharacter, char, previous)
      const optimisticCharacter = preparation.optimisticCharacter
      if (!optimisticCharacter || preparation.factories.length === 0) return
      if (!replacePluginCharacterOwnerAt(index, previousCharacter.chaId, optimisticCharacter)) return
      requirePluginV3Mutation(await preparation.dispatchAsync())
    },
    getChatFromIndex: async (characterIndex: number, chatIndex: number) => {
      const character = currentPluginCharacterSnapshot(characterIndex)
      const residentChat = character?.chats?.[chatIndex]
      if (!character?.chaId || !residentChat?.id) {
        if (canUseServerCommands() && residentChat) {
          throw new Error('getChatFromIndex cannot hydrate a chat without an id')
        }
        return null
      }
      const chatId = residentChat.id
      if (canUseServerCommands()) {
        await hydrateChatMessages(chatId, { strict: true })
        assertV3InstanceCurrent(instance)
        const hydratedChat = currentPluginChatOwnerSnapshot(character.chaId, chatId)
        if (!hydratedChat) throw new Error('getChatFromIndex target changed during chat hydration')
        return cloneJsonValue(hydratedChat.chat)
      }
      return residentChat
    },
    setChatToIndex: async (characterIndex: number, chatIndex: number, chat: any) => {
      const character = currentPluginCharacterSnapshot(characterIndex)
      const residentChat = character?.chats?.[chatIndex]
      const characterId = character?.chaId
      const targetChatId = residentChat?.id
      if (!characterId || !targetChatId) {
        if (canUseServerCommands() && residentChat) {
          throw new Error('setChatToIndex cannot hydrate a chat without an id')
        }
        return
      }
      const residentMessages = cloneJsonValue(residentChat.message ?? [])
      const residentHadHypaV3Data = Object.prototype.hasOwnProperty.call(residentChat, 'hypaV3Data')
      const residentHypaV3Data = cloneJsonValue(residentChat.hypaV3Data)
      const startedFromUnhydratedBootstrapShell =
        canUseServerCommands() && residentMessages.length === 0 && !isChatMessageTranscriptHydrated(targetChatId)
      if (canUseServerCommands()) {
        await hydrateChatMessages(targetChatId, { strict: true })
        assertV3InstanceCurrent(instance)
      }
      const previousOwner = currentPluginChatOwnerSnapshot(characterId, targetChatId)
      if (!previousOwner) throw new Error('setChatToIndex target changed during chat hydration')
      const previousChat = previousOwner.chat
      let attemptedChat = chat
      if (startedFromUnhydratedBootstrapShell && (previousChat.message?.length ?? 0) > 0) {
        if (JSON.stringify(chat?.message ?? []) !== JSON.stringify(residentMessages)) {
          throw new Error(
            'setChatToIndex cannot replace messages from an unhydrated chat snapshot; call getChatFromIndex before retrying',
          )
        }
        attemptedChat = {
          ...attemptedChat,
          message: cloneJsonValue(previousChat.message),
        }
        const incomingHadHypaV3Data = Object.prototype.hasOwnProperty.call(chat ?? {}, 'hypaV3Data')
        const incomingHypaV3DataWasUnchanged =
          incomingHadHypaV3Data === residentHadHypaV3Data &&
          JSON.stringify(chat?.hypaV3Data) === JSON.stringify(residentHypaV3Data)
        if (incomingHypaV3DataWasUnchanged) {
          if (Object.prototype.hasOwnProperty.call(previousChat, 'hypaV3Data')) {
            attemptedChat.hypaV3Data = cloneJsonValue(previousChat.hypaV3Data)
          } else {
            delete attemptedChat.hypaV3Data
          }
        }
      }
      if (canUseServerCommands()) {
        assertNoUnsupportedChatChanges(previousChat, attemptedChat, 'setChatToIndex')
      }
      const previous = {
        selectedCharID: get(selectedCharID),
        characterId,
        chatId: previousChat.id,
        chat: previousChat,
      }
      if (!replacePluginChatOwner(characterId, targetChatId, attemptedChat)) {
        throw new Error('setChatToIndex target changed during chat hydration')
      }
      requirePluginV3BatchMutation(
        await prepareCompatibleChatUpdateScoped(previousChat, attemptedChat, previous).dispatchAsync(),
      )
    },
    getCurrentCharacterIndex: () => {
      return get(selectedCharID)
    },
    getCurrentChatIndex: () => {
      const character = currentPluginCharacterSnapshot(get(selectedCharID))
      return character?.chatPage
    },
    getCurrentLorebookEntries: async () => {
      const characterIndex = get(selectedCharID)
      let character = currentPluginCharacterSnapshot(characterIndex)
      if (!character) return []

      if (character.chaId && !(await ensureCharacterLorebookHydrated(character.chaId))) {
        throw new Error('Current character lorebook is unavailable')
      }
      assertV3InstanceCurrent(instance)

      character = character.chaId ? currentPluginCharacterOwnerSnapshot(character.chaId) : undefined
      if (!character) return []
      const chat = character.chats?.[character.chatPage]
      return cloneJsonValue([...(character.globalLore ?? []), ...(chat?.localLore ?? []), ...getModuleLorebooks()])
    },
    //New names for character APIs, to match API naming conventions
    getCharacter: oldApis.getChar,
    setCharacter: setCurrentCharacter,

    showContainer: (type: 'fullscreen' = 'fullscreen') => {
      iframe.style.display = 'block'

      switch (type) {
        case 'fullscreen': {
          //move iframe to body if not already there
          if (iframe.parentElement !== document.body) {
            document.body.appendChild(iframe)
          }

          //Make iframe cover whole screen
          iframe.style.position = 'fixed'
          iframe.style.top = '0'
          iframe.style.left = '0'
          iframe.style.width = '100%'
          iframe.style.height = '100%'
          iframe.style.border = 'none'
          iframe.style.zIndex = '1000'
          break
        }
        default: {
          return
        }
      }
    },
    hideContainer: () => {
      iframe.style.display = 'none'
    },
    getRootDocument: async () => {
      const conf = await getPluginPermission(plugin.name, 'mainDom', false, plugin.script, () =>
        assertV3InstanceCurrent(instance),
      )
      assertV3InstanceCurrent(instance)
      if (!conf) {
        return null
      }
      return new SafeDocument(document, lifecycle)
    },
    registerSetting: (
      name: string,
      callback: any,
      icon: string = '',
      iconType: 'html' | 'img' | 'none' = 'none',
      id?: string,
    ) => {
      if (iconType !== 'html' && iconType !== 'img' && iconType !== 'none') {
        throw new Error("iconType must be 'html', 'img' or 'none'")
      }
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string')
      }
      const menuId = id || v4()
      const menuDef = ownMenuDef(
        {
          id: menuId,
          name,
          icon: normalizePluginIcon(icon, iconType),
          iconType,
          callback,
        },
        instance,
      )
      const existingIndex = additionalSettingsMenu.findIndex(
        (item) => item.id === menuId && (item as V3OwnedMenuDef).__v3OwnerName === plugin.name,
      )
      if (existingIndex !== -1) {
        additionalSettingsMenu[existingIndex] = menuDef
        addPluginUnloadCallback(
          plugin.name,
          makeMenuUnloadCallback(menuDef, additionalSettingsMenu),
          instance.generation,
        )
        return { id: menuId }
      }
      additionalSettingsMenu.push(menuDef)
      addPluginUnloadCallback(plugin.name, makeMenuUnloadCallback(menuDef, additionalSettingsMenu), instance.generation)
      return { id: menuId }
    },
    registerBodyIntercepter: async (callback: (body: any, type: string) => any) => {
      if (
        (await getPluginPermission(plugin.name, 'replacer', false, plugin.script, () =>
          assertV3InstanceCurrent(instance),
        )) === false
      ) {
        return null
      }
      assertV3InstanceCurrent(instance)

      const id = v4()
      bodyIntercepterStore.push({
        id,
        callback,
      })
      addPluginUnloadCallback(plugin.name, () => {
        const index = bodyIntercepterStore.findIndex((item) => item.id === id)
        if (index !== -1) {
          bodyIntercepterStore.splice(index, 1)
        }
      })
      return { id: id }
    },

    unregisterBodyIntercepter: (id: string) => {
      const index = bodyIntercepterStore.findIndex((item) => item.id === id)
      if (index !== -1) {
        bodyIntercepterStore.splice(index, 1)
      }
    },

    registerButton: (
      arg: {
        name: string
        icon: string
        iconType: 'html' | 'img' | 'none'
        location?: 'action' | 'chat' | 'hamburger'
        id?: string
      },
      callback: () => void,
    ) => {
      let { name, icon, iconType, location, id: providedId } = arg
      location = location || 'action'
      if (iconType !== 'html' && iconType !== 'img' && iconType !== 'none') {
        throw new Error("iconType must be 'html', 'img' or 'none'")
      }
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('name must be a non-empty string')
      }
      if (typeof icon !== 'string') {
        throw new Error('icon must be a string')
      }
      const id = providedId || v4()
      const menuDef = ownMenuDef(
        {
          name,
          icon: normalizePluginIcon(icon, iconType),
          iconType,
          callback,
          id,
        },
        instance,
      )

      let targetStore: MenuDef[]
      switch (location) {
        case 'action':
          targetStore = additionalFloatingActionButtons
          break
        case 'hamburger':
          targetStore = additionalHamburgerMenu
          break
        case 'chat':
          targetStore = additionalChatMenu
          break
        default:
          throw new Error('Invalid location for button')
      }

      const buttonStores = [additionalFloatingActionButtons, additionalHamburgerMenu, additionalChatMenu]
      let replacedInTarget = false
      for (const store of buttonStores) {
        const existingIndex = store.findIndex(
          (item) => item.id === id && (item as V3OwnedMenuDef).__v3OwnerName === plugin.name,
        )
        if (existingIndex !== -1) {
          if (store === targetStore) {
            store[existingIndex] = menuDef
            replacedInTarget = true
          } else {
            store.splice(existingIndex, 1)
          }
        }
      }

      if (!replacedInTarget) targetStore.push(menuDef)
      addPluginUnloadCallback(plugin.name, makeMenuUnloadCallback(menuDef, targetStore), instance.generation)
      return { id }
    },
    setChatPanel: (
      content: string | null,
      options: {
        id?: string
        className?: string
      } = {},
    ) => {
      const id = options.id || `${plugin.name}:default`
      if (content === null || content === '') {
        removeOwnedChatPanel(id, instance)
        return { id }
      }
      if (typeof content !== 'string') {
        throw new Error('content must be a string or null')
      }

      const panel: V3OwnedChatPanelDef = {
        id,
        pluginName: plugin.name,
        html: sanitizePluginNetworkDeadHtml(content),
        className:
          typeof options.className === 'string'
            ? DOMPurify.sanitize(options.className, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
            : undefined,
        __v3OwnerGeneration: instance.generation,
        __v3OwnerToken: v4(),
      }
      const existingIndex = chatPanelStore.findIndex((item) => {
        const owned = item as V3OwnedChatPanelDef
        return item.id === id && item.pluginName === plugin.name && owned.__v3OwnerGeneration === instance.generation
      })
      if (existingIndex === -1) chatPanelStore.push(panel)
      else chatPanelStore[existingIndex] = panel
      addPluginUnloadCallback(plugin.name, makeChatPanelUnloadCallback(panel), instance.generation)
      return { id }
    },
    registerMCP: registerOwnedMCP,
    unregisterMCP: (identifier: string) => unregisterMCPModule(identifier),
    unregisterUIPart: (id: string) => {
      const removeFromMenuStore = (menuStore: MenuDef[]) => {
        const index = menuStore.findIndex((item) => {
          const owned = item as V3OwnedMenuDef
          return (
            item.id === id && owned.__v3OwnerName === plugin.name && owned.__v3OwnerGeneration === instance.generation
          )
        })
        if (index !== -1) {
          menuStore.splice(index, 1)
        }
      }

      removeFromMenuStore(additionalSettingsMenu)
      removeFromMenuStore(additionalFloatingActionButtons)
      removeFromMenuStore(additionalHamburgerMenu)
      removeFromMenuStore(additionalChatMenu)
      removeOwnedChatPanel(id, instance)
    },
    log: (message: string) => {
      console.log(`[RisuAI Plugin: ${plugin.name}] ${message}`)
    },
    createMutationObserver(callback: SafeMutationCallback): SafeMutationObserver {
      return new SafeMutationObserver(callback, lifecycle)
    },
    onUnload: (callback: () => void) => {
      addPluginUnloadCallback(plugin.name, callback)
    },
    getFetchLogs: async () => {
      const unsafeFetchLog = getFetchLogs()
      const conf = await getPluginPermission(plugin.name, 'fetchLogs', false, plugin.script, () =>
        assertV3InstanceCurrent(instance),
      )
      assertV3InstanceCurrent(instance)
      if (!conf) {
        return null
      }
      return unsafeFetchLog.map((log) => {
        const url = new URL(log.url)
        return {
          url: url.origin + url.pathname,
          body: log.body,
          status: log.status,
          response: log.response,
        }
      })
    },

    alert: (msg: string) => {
      return alertNormal(msg)
    },
    alertConfirm: (msg: string) => {
      return alertConfirm(msg)
    },
    alertError: (msg: string) => {
      return alertError(msg)
    },
    getRuntimeInfo: () => {
      return {
        apiVersion: '3.0',
        platform: 'fastify',
        saveMethod: 'server',
        deviceLocalPluginStorage: isDeviceLocalPluginStorageEnabled(),
      }
    },
    getLocalPluginStorage: () => {
      assertDeviceLocalPluginStorageEnabled()
      const storage = new SafeLocalPluginStorage()
      return new Proxy(storage, {
        get(target, key) {
          const value = Reflect.get(target, key, target)
          return typeof value === 'function'
            ? (...args: unknown[]) => {
                assertV3InstanceCurrent(instance)
                return value.apply(target, args)
              }
            : value
        },
      })
    },
    checkCharOrder: checkCharOrder,
    requestPluginPermission: (permission: string) => {
      return getPluginPermission(plugin.name, permission as any, false, plugin.script, () =>
        assertV3InstanceCurrent(instance),
      )
    },
    //Internal use APIs
    _getOldKeys: () => {
      return Object.keys(oldApis)
    },
    _getPropertiesForInitialization: () => {
      const v = {
        apiVersion: '3.0',
        apiVersionCompatibleWith: ['3.0'],
      } as any

      v.list = Object.keys(v)

      return v
    },
    _getPluginStorage: oldApis.pluginStorage.getItem,
    _setPluginStorage: oldApis.pluginStorage.setItem,
    _removePluginStorage: oldApis.pluginStorage.removeItem,
    _clearPluginStorage: oldApis.pluginStorage.clear,
    _keyPluginStorage: oldApis.pluginStorage.key,
    _keysPluginStorage: oldApis.pluginStorage.keys,
    _lengthPluginStorage: oldApis.pluginStorage.length,
    _getSafeLocalStorage: oldApis.safeLocalStorage.getItem,
    _setSafeLocalStorage: oldApis.safeLocalStorage.setItem,
    _removeSafeLocalStorage: oldApis.safeLocalStorage.removeItem,
    _clearSafeLocalStorage: oldApis.safeLocalStorage.clear,
    _keySafeLocalStorage: oldApis.safeLocalStorage.key,
    _keysSafeLocalStorage: oldApis.safeLocalStorage.keys,
    searchTranslationCache: async (partialKey: string) => {
      return searchLLMCache(partialKey)
    },
    getTranslationCache: async (key: string) => {
      return getLLMCache(key)
    },
    _getAliases: () => {
      return {
        pluginStorage: {
          getItem: '_getPluginStorage',
          setItem: '_setPluginStorage',
          removeItem: '_removePluginStorage',
          clear: '_clearPluginStorage',
          key: '_keyPluginStorage',
          keys: '_keysPluginStorage',
          length: '_lengthPluginStorage',
        },
        safeLocalStorage: {
          getItem: '_getSafeLocalStorage',
          setItem: '_setSafeLocalStorage',
          removeItem: '_removeSafeLocalStorage',
          clear: '_clearSafeLocalStorage',
          key: '_keySafeLocalStorage',
          keys: '_keysSafeLocalStorage',
        },
      }
    },
    runLLMModel: async (options: {
      mode: ModelModeExtended
      messages: OpenAIChat[]
      staticModel?: string
      allowPlugins?: boolean
    }) => {
      return requestChatDataMain(
        {
          formated: options.messages,
          bias: {},
          staticModel: options.staticModel,

          // Calls into plugin-provided models are blocked by default to
          // guard against accidental IPC loops between provider plugins.
          // Plugin authors who need to reach the user's plugin-supplied
          // main or auxiliary model (e.g. a TTS preprocessor that
          // rewrites text with the configured otherAx model) can opt in
          // explicitly with `allowPlugins: true`, accepting responsibility
          // for avoiding provider-to-provider call loops.
          blockPlugins: !options.allowPlugins,
        },
        options.mode,
      )
    },
    sendChat: async (message: string) => {
      const selectedCharacterIndex = get(selectedCharID)
      const selectedCharacter = currentPluginCharacterSnapshot(selectedCharacterIndex)
      const selectedChat = selectedCharacter?.chats?.[selectedCharacter.chatPage]
      const target = captureActiveChatTarget()
      const conf = await getPluginPermission(plugin.name, 'sendChat', false, plugin.script, () =>
        assertV3InstanceCurrent(instance),
      )
      assertV3InstanceCurrent(instance)
      if (!conf) {
        return false
      }

      if (typeof message !== 'string') {
        throw new Error('Message must be a string')
      }

      if (
        resolveModelProfileWithLegacyCompatibility({
          database: currentPluginDatabaseSnapshot() as unknown as Database,
        }).modelInfo.id.startsWith('pluginmodel:::')
      ) {
        // Plugin-provided models are blocked from chat sends to keep plugin IPC
        // outside provider execution.
        throw new Error('Sending chat with plugin-based model is currently blocked')
      }

      if (!selectedCharacter) {
        throw new Error('No character selected')
      }

      if (!selectedChat || !target) {
        throw new Error('No active chat found')
      }
      if (isChatGenerationKnown(target.chatId)) {
        throw new Error('A generation is already in progress for this chat')
      }

      if (message) {
        if (canUseGenerationOperationProtocol()) {
          const result = await coordinateAcceptedChatSend({ target, message })
          return result.status === 'generated'
        }
        const appendResult = await appendCurrentChatUserMessageForSend(message, { expectedTarget: target })
        if (appendResult.status === 'error') {
          throw new Error(appendResult.error)
        }

        const result = await coordinateAcceptedChatSend({ target, append: appendResult })
        return result.status === 'generated'
      }

      return processSendChat(-1, { expectedTarget: target })
    },
    addPluginChannelListener: (channelName: string, callback: Function) => {
      pluginChannel.set(plugin.name + channelName, callback)
      addPluginUnloadCallback(plugin.name, () => {
        if (pluginChannel.get(plugin.name + channelName) === callback) {
          pluginChannel.delete(plugin.name + channelName)
        }
      })
    },
    postPluginChannelMessage: (pluginName: string, channelName: string, message: any) => {
      const currentPluginName = plugin.name
      const receiverMatches = currentPluginCollectionSnapshot().filter((p) => p.name === pluginName)
      const receiverPlugin = receiverMatches.length === 1 ? receiverMatches[0] : undefined

      if (!receiverPlugin) {
        console.warn(
          `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to non-existent plugin '${pluginName}' on channel '${channelName}'.`,
        )
        return
      }

      if (!receiverPlugin.allowedIPC?.includes(currentPluginName)) {
        console.warn(
          `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but receiver plugin does not allow IPC communication from this plugin. declare //@allowed-ipc ${currentPluginName} in the reciver plugin script to allow IPC communication.`,
        )
        return
      }

      if (!plugin.allowedIPC?.includes(receiverPlugin.name)) {
        console.warn(
          `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but the sender plugin does not allow IPC communication to this plugin. declare //@allowed-ipc ${receiverPlugin.name} in the sender plugin script to allow IPC communication.`,
        )
        return
      }

      const callback = pluginChannel.get(pluginName + channelName)
      if (callback) {
        callback(message, {
          sender: currentPluginName,
          channel: channelName,
        })
      }
    },
    saveSecretHeader: async (key: string, value: string | string[]) => {
      // Secret header storage is intentionally unavailable without write-only
      // plugin storage.
      console.warn(
        `[RisuAI Plugin: ${plugin.name}] saveServerSecret is not implemented yet. This API is intended for securely storing sensitive information like API keys with write-only access for plugins. Please avoid using this API until it is implemented.`,
      )
    },
  }
  return guardV3Api(api, instance)
}

export async function loadV3Plugins(plugins: RisuPlugin[]) {
  if (!canUseClientWriteAccess()) return
  const sessionGeneration = captureClientSessionGeneration()
  const generation = beginV3Generation()
  await Promise.all(
    [...v3PluginInstances].map(async (instance) => {
      await unloadV3PluginInstance(instance)
    }),
  )

  if (
    generation !== activeV3Generation ||
    !canUseClientWriteAccess() ||
    !isClientSessionGenerationCurrent(sessionGeneration)
  ) {
    return
  }

  const loadResults = await Promise.allSettled(plugins.map((plugin) => executePluginV3(plugin, generation)))
  if (generation !== activeV3Generation) return

  const failure = loadResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (!failure) return

  await Promise.all(
    v3PluginInstances
      .filter((instance) => instance.generation === generation)
      .map((instance) => unloadV3PluginInstance(instance)),
  )
  throw failure.reason
}

export async function executePluginV3(plugin: RisuPlugin, generation = ensureV3Generation()) {
  if (!canUseClientWriteAccess()) return
  const sessionGeneration = captureClientSessionGeneration()
  if (generation !== activeV3Generation) {
    return
  }

  const alreadyRunning = v3PluginInstances.find(
    (p) => p.name === plugin.name && p.active && p.generation === generation,
  )
  if (alreadyRunning) {
    console.log(`[RisuAI Plugin: ${plugin.name}] Plugin is already running. Skipping load.`)
    return
  }

  const runtimeAllowed = await getPluginPermission(plugin.name, 'v3Runtime', false, plugin.script, () => {
    assertClientWriteAccess()
    if (generation !== activeV3Generation || !isClientSessionGenerationCurrent(sessionGeneration))
      throw new Error('V3 plugin generation is no longer active.')
  })
  if (
    generation !== activeV3Generation ||
    !canUseClientWriteAccess() ||
    !isClientSessionGenerationCurrent(sessionGeneration)
  )
    return
  if (!runtimeAllowed) {
    console.warn(`[RisuAI Plugin: ${plugin.name}] Skipped because trusted V3 browser runtime access was denied.`)
    return
  }

  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  document.body.appendChild(iframe)
  const lifecycle = new PluginLifecycleCleanup()
  const instance: V3PluginInstance = {
    name: plugin.name,
    lifecycle,
    generation,
    sessionGeneration,
    active: true,
  }
  const host = new SandboxHost(makeRisuaiAPIV3(iframe, plugin, lifecycle, instance))
  instance.host = host
  v3PluginInstances.push(instance)
  try {
    assertV3InstanceCurrent(instance)
    host.run(iframe, plugin.script)
    await host.waitForInitialization()
    assertV3InstanceCurrent(instance)
  } catch (error) {
    await unloadV3PluginInstance(instance)
    throw error
  }
  console.log(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`)
}

export function getV3PluginInstance(name: string) {
  return v3PluginInstances.find((p) => p.name === name && p.active)
}

export const __v3PluginLifecycleTestHooks = {
  async reset() {
    for (const instance of [...v3PluginInstances]) {
      await unloadV3PluginInstance(instance)
    }
    activeV3Generation = 0
    pluginUnloadCallbacks.clear()
    pluginChannel.clear()
    v3ProviderRegistrations.splice(0, v3ProviderRegistrations.length)
    v3SyncedProviderRegistrations.clear()
    registeredV3ProviderUnloadCallbacks.clear()
    customV3ProviderMetaStore.splice(0, customV3ProviderMetaStore.length)
    additionalSettingsMenu.splice(0, additionalSettingsMenu.length)
    additionalFloatingActionButtons.splice(0, additionalFloatingActionButtons.length)
    additionalHamburgerMenu.splice(0, additionalHamburgerMenu.length)
    additionalChatMenu.splice(0, additionalChatMenu.length)
    chatPanelStore.splice(0, chatPanelStore.length)
    bodyIntercepterStore.splice(0, bodyIntercepterStore.length)
    pluginV2.providers.clear()
    pluginV2.providerOptions.clear()
    chatOutputListeners.clear()
    clearInMemoryPluginPermissions()
    syncCustomProviderStoreFromMap()
  },
  createLifecycle() {
    return new PluginLifecycleCleanup()
  },
  createSafeDocument(lifecycle: PluginLifecycleCleanup) {
    return new SafeDocument(document, lifecycle)
  },
  createMutationObserver(lifecycle: PluginLifecycleCleanup, callback: SafeMutationCallback) {
    return new SafeMutationObserver(callback, lifecycle)
  },
  createApi(plugin: RisuPlugin): Record<string, unknown> {
    const iframe = document.createElement('iframe')
    const lifecycle = new PluginLifecycleCleanup()
    const instance: V3PluginInstance = {
      name: plugin.name,
      lifecycle,
      generation: ensureV3Generation(),
      sessionGeneration: captureClientSessionGeneration(),
      active: true,
    }
    return makeRisuaiAPIV3(iframe, plugin, lifecycle, instance) as Record<string, unknown>
  },
  createTrackedApi(plugin: RisuPlugin): { api: Record<string, unknown>; instance: V3PluginInstance } {
    const iframe = document.createElement('iframe')
    const lifecycle = new PluginLifecycleCleanup()
    const instance: V3PluginInstance = {
      name: plugin.name,
      lifecycle,
      generation: ensureV3Generation(),
      sessionGeneration: captureClientSessionGeneration(),
      active: true,
    }
    const api = makeRisuaiAPIV3(iframe, plugin, lifecycle, instance) as Record<string, unknown>
    v3PluginInstances.push(instance)
    return { api, instance }
  },
  createApiForInstance(plugin: RisuPlugin, instance: V3PluginInstance): Record<string, unknown> {
    const iframe = document.createElement('iframe')
    return makeRisuaiAPIV3(iframe, plugin, instance.lifecycle, instance) as Record<string, unknown>
  },
  beginGeneration() {
    return beginV3Generation()
  },
  getPluginPermission,
  unloadInstance(instance: V3PluginInstance) {
    return unloadV3PluginInstance(instance)
  },
  registerProvider(
    pluginName: string,
    name: string,
    handler: V3ProviderRegistration['handler'] = async () => ({
      success: true,
      content: pluginName,
    }),
    options: PluginV2ProviderOptions = {},
  ) {
    registerV3Provider({
      pluginName,
      generation: activeV3Generation,
      name,
      handler,
      options,
      modelData: {
        id: `pluginmodel:::${name}`,
        name,
        shortName: name,
        fullName: name,
        internalID: `pluginmodel:::${name}`,
        provider: LLMProvider.AsIs,
        format: LLMFormat.Plugin,
        flags: [LLMFlags.hasFullSystemPrompt],
        parameters: ['temperature'],
        tokenizer: LLMTokenizer.Unknown,
      },
    })
  },
  addUnloadCallback(pluginName: string, callback: () => void | Promise<void>) {
    addPluginUnloadCallback(pluginName, callback)
  },
  unloadPlugin(pluginName: string) {
    return unloadV3Plugin(pluginName)
  },
}

globalThis.__debugV3Plugin = (code: string | Function, pluginName: string = '') => {
  if (code instanceof Function) {
    code = `(${code.toString()})()`
  }
  if (pluginName === '') {
    const instance = v3PluginInstances[0]
    if (!instance?.host) {
      throw new Error('No V3 plugin is loaded.')
    }
    return instance.host.executeInIframe(code)
  }
  const instance = v3PluginInstances.find((p) => p.name === pluginName)
  if (!instance?.host) {
    throw new Error(`Plugin ${pluginName} not found.`)
  }
  return instance.host.executeInIframe(code)
}

clientSessionStore.subscribe(() => {
  if (!isClientReadOnly() || v3PluginInstances.length === 0) return
  beginV3Generation()
  for (const instance of [...v3PluginInstances]) {
    // Terminate guest execution synchronously; host cleanup remains idempotent.
    instance.host?.terminate()
    void unloadV3PluginInstance(instance)
  }
})
