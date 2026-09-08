import type { Database } from '../storage/databaseTypes'
import { settingsResourceState } from '../server/resourceState.svelte'
import { SERVER_SHELL_SETTINGS_KEYS } from '@risuai/protocol/shell-resource'
import { DISPLAY_PAINT_SETTING_KEYS, readDisplaySettingsCache } from './displaySettingsCache'
import { fromStore } from 'svelte/store'
import { clientSessionStore } from '../clientSession'
import { getReaderNavigationSettings } from '../server/readerTranscriptProjection.svelte'

const startupPaintSettings = readDisplaySettingsCache().settings
const session = fromStore(clientSessionStore)

function readerSettings(): Partial<Database> | undefined {
  return session.current.managed && session.current.lifecycle !== 'writing' ? getReaderNavigationSettings() : undefined
}

function hasResidentDisplaySettings(): boolean {
  return (
    settingsResourceState.groupStatuses.display === 'ready' ||
    typeof settingsResourceState.groupRevisions?.display === 'number' ||
    typeof settingsResourceState.fullRevision === 'number'
  )
}

/** Only server-backed values may drive the live style/cache updaters. */
export function runtimeDisplaySettingsOwner(): Partial<Database> | undefined {
  const reader = readerSettings()
  if (reader !== undefined) return reader
  if (settingsResourceState.groupStatuses.display === 'ready') return settingsResourceState.value
  if (settingsResourceState.status === 'ready' && typeof settingsResourceState.shellRevision === 'number') {
    return Object.fromEntries(SERVER_SHELL_SETTINGS_KEYS.map((key) => [key, settingsResourceState.value[key]]))
  }
  return undefined
}

/** Read-only appearance fallback while the full Display group is still loading. */
export function displaySettingsForPaint(): Partial<Database> {
  const reader = readerSettings()
  if (reader !== undefined) return reader
  const status = settingsResourceState.groupStatuses.display ?? 'idle'
  if (hasResidentDisplaySettings()) {
    if (status !== 'error') return settingsResourceState.value
    // A failed refresh must not reset appearance or expose non-visual preferences.
    return Object.fromEntries(DISPLAY_PAINT_SETTING_KEYS.map((key) => [key, settingsResourceState.value[key]]))
  }
  const shell = runtimeDisplaySettingsOwner()
  return shell ? { ...startupPaintSettings, ...shell } : startupPaintSettings
}

export function cachedDisplaySize(key: 'textAreaSize' | 'textAreaTextSize' | 'sideBarSize'): number {
  return startupPaintSettings[key] ?? 0
}

export function displaySettingForPaint<Key extends keyof Database>(key: Key): Database[Key] | undefined {
  const reader = readerSettings()
  if (reader !== undefined) return reader[key] as Database[Key] | undefined
  if (hasResidentDisplaySettings()) {
    if (
      settingsResourceState.groupStatuses.display === 'error' &&
      !(DISPLAY_PAINT_SETTING_KEYS as readonly string[]).includes(key)
    )
      return undefined
    return (settingsResourceState.value as Partial<Database>)[key] as Database[Key] | undefined
  }
  if (
    typeof settingsResourceState.shellRevision === 'number' &&
    (SERVER_SHELL_SETTINGS_KEYS as readonly string[]).includes(key)
  ) {
    return (settingsResourceState.value as Partial<Database>)[key] as Database[Key] | undefined
  }
  return (startupPaintSettings as Partial<Database>)[key] as Database[Key] | undefined
}
