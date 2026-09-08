import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISPLAY_SETTINGS_CACHE_KEY } from './displaySettingsCache'

const resource = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  status: 'idle',
  shellRevision: null as number | null,
  fullRevision: null as number | null,
  groupStatuses: { display: 'idle' },
  groupRevisions: {} as Record<string, number>,
}))
vi.mock('../server/resourceState.svelte', () => ({ settingsResourceState: resource }))

beforeEach(() => {
  vi.resetModules()
  resource.value = {}
  resource.status = 'idle'
  resource.shellRevision = null
  resource.fullRevision = null
  resource.groupStatuses.display = 'idle'
  resource.groupRevisions = {}
  localStorage.setItem(
    DISPLAY_SETTINGS_CACHE_KEY,
    JSON.stringify({
      version: 1,
      settings: { theme: 'mobilechat', zoomsize: 140, lineHeight: 1.8, sideBarSize: 2, textAreaSize: 3 },
      styles: {},
    }),
  )
})
afterEach(async () => {
  const { resetClientSessionForTests } = await import('../clientSession')
  resetClientSessionForTests()
  localStorage.clear()
  vi.resetModules()
})

describe('read-only display paint settings', () => {
  it('switches immediately from pending writer appearance to confirmed reader values and clears protected hints', async () => {
    const { setManagedWriterForTest } = await import('../__tests__/managedClientSession')
    const { demoteClientSession, requireClientAuthentication } = await import('../clientSession')
    const { recordReaderNavigationSettings } = await import('../server/readerTranscriptProjection.svelte')
    const { displaySettingsForPaint, displaySettingForPaint, runtimeDisplaySettingsOwner } =
      await import('./displaySettings')
    setManagedWriterForTest()
    recordReaderNavigationSettings({ theme: 'waifu', customFont: 'serif', sideBarSize: 1 })
    resource.groupStatuses.display = 'ready'
    resource.value = { theme: 'pending-theme', customFont: 'pending-font', sideBarSize: 3 }
    expect(displaySettingForPaint('theme')).toBe('pending-theme')
    demoteClientSession()
    expect(displaySettingsForPaint()).toMatchObject({ theme: 'waifu', customFont: 'serif', sideBarSize: 1 })
    expect(runtimeDisplaySettingsOwner()?.theme).toBe('waifu')
    expect(displaySettingForPaint('theme')).toBe('waifu')
    requireClientAuthentication()
    expect(displaySettingsForPaint()).toEqual({})
    expect(displaySettingForPaint('theme')).toBeUndefined()
  })
  it('restores layout and sizes without hydrating or authorizing a resource owner', async () => {
    const { displaySettingsForPaint, displaySettingForPaint, runtimeDisplaySettingsOwner } =
      await import('./displaySettings')
    const { textAreaSize, sideBarSize } = await import('./guisize')
    const { get } = await import('svelte/store')
    expect(displaySettingsForPaint()).toMatchObject({ theme: 'mobilechat', zoomsize: 140, lineHeight: 1.8 })
    expect(displaySettingForPaint('theme')).toBe('mobilechat')
    expect(runtimeDisplaySettingsOwner()).toBeUndefined()
    expect(resource.value).toEqual({})
    expect(resource.groupStatuses.display).toBe('idle')
    expect(get(textAreaSize)).toBe(3)
    expect(get(sideBarSize)).toBe(2)
  })

  it('lets authoritative shell values win without losing deferred paint hints', async () => {
    const { displaySettingsForPaint, displaySettingForPaint } = await import('./displaySettings')
    resource.status = 'ready'
    resource.shellRevision = 5
    resource.value = { sideBarSize: 1 }
    expect(displaySettingsForPaint()).toMatchObject({ theme: 'mobilechat', zoomsize: 140, sideBarSize: 1 })
    expect(displaySettingForPaint('sideBarSize')).toBe(1)
  })

  it('uses the latest resident settings during refresh, not stale startup hints', async () => {
    const { displaySettingForPaint, displaySettingsForPaint } = await import('./displaySettings')
    resource.value = { theme: 'cardboard', zoomsize: 170 }
    resource.groupStatuses.display = 'loading'
    resource.groupRevisions.display = 6
    expect(displaySettingForPaint('theme')).toBe('cardboard')
    expect(displaySettingsForPaint().zoomsize).toBe(170)
    resource.groupStatuses.display = 'ready'
    resource.value = { theme: '' }
    expect(displaySettingForPaint('theme')).toBe('')
    expect(displaySettingForPaint('zoomsize')).toBeUndefined()
  })

  it('retains only appearance hints after a failed Display read', async () => {
    const { displaySettingForPaint, displaySettingsForPaint } = await import('./displaySettings')
    resource.groupStatuses.display = 'error'
    expect(displaySettingForPaint('zoomsize')).toBe(140)
    resource.groupRevisions.display = 6
    resource.value = { zoomsize: 170, theme: 'cardboard', notification: true }
    expect(displaySettingsForPaint()).toMatchObject({ zoomsize: 170, theme: 'cardboard' })
    expect(displaySettingForPaint('notification')).toBeUndefined()
    expect(displaySettingsForPaint()).not.toHaveProperty('notification')
  })
})
