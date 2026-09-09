import { writable } from 'svelte/store'
import { cachedDisplaySize, runtimeDisplaySettingsOwner } from './displaySettings'
import { applyDisplayStyles, cacheDisplaySettings } from './displaySettingsCache'
import { settingsResourceState } from '../server/resourceState.svelte'
import { normalizeSidebarSize, sidebarPanelWidthRem } from './shellGeometry'

export let textAreaSize = writable(cachedDisplaySize('textAreaSize'))
export let sideBarSize = writable(cachedDisplaySize('sideBarSize'))
export let textAreaTextSize = writable(cachedDisplaySize('textAreaTextSize'))

export function updateGuisize() {
  const owner = runtimeDisplaySettingsOwner()
  if (!owner) return
  const fallback = settingsResourceState.groupStatuses.display === 'ready' ? 0 : undefined
  const db = {
    textAreaSize: owner.textAreaSize ?? fallback,
    textAreaTextSize: owner.textAreaTextSize ?? fallback,
    sideBarSize: owner.sideBarSize ?? fallback,
  }
  const root = document.querySelector(':root') as HTMLElement
  if (!root) {
    return
  }
  if (typeof db.textAreaSize === 'number' && Number.isFinite(db.textAreaSize)) textAreaSize.set(db.textAreaSize)
  if (typeof db.textAreaTextSize === 'number' && Number.isFinite(db.textAreaTextSize)) {
    textAreaTextSize.set(db.textAreaTextSize)
  }
  if (typeof db.sideBarSize === 'number' && Number.isFinite(db.sideBarSize)) {
    const normalized = normalizeSidebarSize(db.sideBarSize)
    sideBarSize.set(normalized)
    applyDisplayStyles({ '--sidebar-size': `${sidebarPanelWidthRem(normalized)}rem` })
  }
  cacheDisplaySettings(
    db,
    (['textAreaSize', 'textAreaTextSize', 'sideBarSize'] as const).filter((key) => db[key] !== undefined),
  )
}

export function guiSizeText(num: number) {
  switch (num) {
    case 0:
      return 'Default'
    case 1:
      return 'Big'
    case 2:
      return 'Bigger'
    case 3:
      return 'Huge'
    case 4:
      return 'Huger'
    case 5:
      return 'Hugest'
    case -1:
      return 'Small'
    case -2:
      return 'Smaller'
    case -3:
      return 'Tiny'
    case -4:
      return 'Tinier'
    case -5:
      return 'Tiniest'
    default:
      return 'Default'
  }
}
