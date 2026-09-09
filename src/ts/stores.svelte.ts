import { writable } from 'svelte/store'
import { resetRegisteredScriptCaches } from './process/scriptCacheInvalidation'
import { invalidateModuleRenderRevision } from './moduleRenderRevision'
import type { ActiveChatTarget } from './types/activeChatTarget'
import type { hubType } from './types/risuHub'
import { readCachedCustomCSS } from './gui/customCSSCache'

export { alertStore, LoadingStatusState, selectedCharID, selIdState } from './stores/coreStores.svelte'

function updateSize() {
  SizeStore.set({
    w: window.innerWidth,
    h: window.innerHeight,
  })
  DynamicGUI.set(window.innerWidth <= 1024)
}

export const SizeStore = writable({
  w: 0,
  h: 0,
})

export const DynamicGUI = writable(false)
export const sideBarClosing = writable(false)
export const sideBarStore = writable(window.innerWidth > 1024)
export type SidebarTransitionCause = 'none' | 'explicit-open' | 'explicit-close'
export const sideBarTransitionCause = writable<SidebarTransitionCause>('none')
export const CurrentTriggerIdStore = writable<string | null>(null)
export const CharEmotion = writable({} as { [key: string]: [string, string, number][] })
export const ViewBoxsize = writable({ width: 12 * 16, height: 12 * 16 }) // Default width and height in pixels
export const settingsOpen = writable(false)
export const botMakerMode = writable(false)
export const moduleBackgroundEmbedding = writable('')
export const openPresetList = writable(false)
export const openPersonaList = writable(false)
export const openChatGenerationTogglePresetList = writable(false)
export type GenerationSettingsPickerMode = 'global' | 'active-chat-generation-settings'
export type PresetPickerKind = 'model' | 'prompt' | 'legacy'
export const presetListModalStore = $state({
  mode: 'global' as GenerationSettingsPickerMode,
  kind: 'model' as PresetPickerKind,
  target: null as ActiveChatTarget | null,
})
export const personaListModalStore = $state({
  mode: 'global' as GenerationSettingsPickerMode,
  target: null as ActiveChatTarget | null,
})
export const chatGenerationTogglePresetListModalStore = $state({
  target: null as ActiveChatTarget | null,
  saveStates: {} as Record<string, { operation: number; status: 'pending' | 'queued' | 'failed' }>,
})
export const bookmarkListOpen = writable(false)
export const MobileGUI = writable(false)
export const MobileGUIStack = writable(0)
export const MobileSideBar = writable(0)
export const SettingsMenuIndex = writable(-1)
export const ReloadGUIPointer = writable(0)
export const VariableReloadGUIPointer = writable(0)
export const ReloadChatPointer = writable({} as Record<number, number>)
export const ScrollToMessageStore = $state({ value: -1 })
export const OpenRealmStore = writable(false)
export const RealmInitialOpenChar = writable<null | hubType>(null)
export const PlaygroundStore = writable(0)
export const HideIconStore = writable(false)
export const CustomCSSStore = writable(readCachedCustomCSS())
export const SafeModeStore = writable(false)
export const MobileSearch = writable('')
export const CharConfigSubMenu = writable(0)
export const CustomGUISettingMenuStore = writable(false)
export const hypaV3ModalOpen = writable(false)
CustomCSSStore.subscribe((css) => {
  const q = document.querySelector('#customcss')
  if (q) {
    if (q.innerHTML !== css) q.innerHTML = css
  } else {
    const s = document.createElement('style')
    s.id = 'customcss'
    s.innerHTML = css
    document.body.appendChild(s)
  }
})

updateSize()
window.addEventListener('resize', updateSize)
openPresetList.subscribe((open) => {
  if (!open) {
    presetListModalStore.mode = 'global'
    presetListModalStore.kind = 'model'
    presetListModalStore.target = null
  }
})

openPersonaList.subscribe((open) => {
  if (!open) {
    personaListModalStore.mode = 'global'
    personaListModalStore.target = null
  }
})

openChatGenerationTogglePresetList.subscribe((open) => {
  if (!open) chatGenerationTogglePresetListModalStore.target = null
})

export function openPresetListModal(
  mode: GenerationSettingsPickerMode = 'global',
  kind: PresetPickerKind = 'model',
  target: ActiveChatTarget | null = null,
) {
  presetListModalStore.mode = mode
  presetListModalStore.kind = kind
  presetListModalStore.target = mode === 'active-chat-generation-settings' ? target : null
  openPresetList.set(true)
}

export function closePresetListModal() {
  openPresetList.set(false)
}

export function openPersonaListModal(
  mode: GenerationSettingsPickerMode = 'global',
  target: ActiveChatTarget | null = null,
) {
  personaListModalStore.mode = mode
  personaListModalStore.target = mode === 'active-chat-generation-settings' ? target : null
  openPersonaList.set(true)
}

export function closePersonaListModal() {
  openPersonaList.set(false)
}

export function openChatGenerationTogglePresetListModal(target: ActiveChatTarget | null) {
  chatGenerationTogglePresetListModalStore.target = target
  openChatGenerationTogglePresetList.set(true)
}

export function closeChatGenerationTogglePresetListModal() {
  openChatGenerationTogglePresetList.set(false)
}

export const QuickSettings = $state({
  open: false,
  index: 0,
})

export const disableHighlight = writable(true)

export type MenuDef = {
  name: string
  icon: string
  iconType: 'html' | 'img' | 'none'
  callback: any
  id: string
}

export type ChatPanelDef = {
  id: string
  pluginName: string
  html: string
  className?: string
}

export const additionalSettingsMenu = $state([] as MenuDef[])
export const additionalFloatingActionButtons = $state([] as MenuDef[])
export const additionalHamburgerMenu = $state([] as MenuDef[])
export const additionalChatMenu = $state([] as MenuDef[])
export const chatPanelStore = $state([] as ChatPanelDef[])
export const bodyIntercepterStore = $state(
  [] as {
    id: string
    callback: (body: any, type: string) => Promise<any>
  }[],
)
export const easyPanelStore = $state({
  open: false,
})
export const popupStore = $state({
  children: null as null | import('svelte').Snippet,
  mouseX: 0,
  mouseY: 0,
  openId: 0,
  trigger: null as HTMLButtonElement | null,
})
export const popUpEditorStore = $state({
  open: false,
  value: '',
  mode: 'default' as 'default',
  language: 'markdown' as string,
  sessionId: 0,
})

let nextPopupEditorSessionId = 0

export function openPopupEditorSession(value: string, language = 'markdown'): number {
  const sessionId = ++nextPopupEditorSessionId
  popUpEditorStore.value = value
  popUpEditorStore.mode = 'default'
  popUpEditorStore.language = language
  popUpEditorStore.sessionId = sessionId
  popUpEditorStore.open = true
  return sessionId
}

export function isPopupEditorSessionCurrent(sessionId: number): boolean {
  return popUpEditorStore.sessionId === sessionId
}

export function closePopupEditorSession(sessionId: number): boolean {
  if (!isPopupEditorSessionCurrent(sessionId)) return false
  popUpEditorStore.open = false
  return true
}

export const loadoutModalStore = $state({
  open: false,
})

export const irisStore = $state({
  open: false,
})

export const customSideBarConfigDialogStore = $state({
  open: false,
})

// Svelte does not make Set mutations reactive, so this uses an array.
export const hotReloading = $state<string[]>([])

export function reloadGuiAfterDefinitionChange() {
  invalidateModuleRenderRevision()
  ReloadChatPointer.set({})
  resetRegisteredScriptCaches()
  ReloadGUIPointer.update((value) => value + 1)
}

export function reloadGuiDisplay() {
  ReloadGUIPointer.update((value) => value + 1)
}

export function refreshVariableOnlyGui() {
  VariableReloadGUIPointer.update((value) => value + 1)
}

export function reloadChatAt(index: number | string) {
  const chatIndex = Number(index)
  if (!Number.isFinite(chatIndex)) return
  ReloadChatPointer.update((value) => ({
    ...value,
    [chatIndex]: (value[chatIndex] ?? 0) + 1,
  }))
}
