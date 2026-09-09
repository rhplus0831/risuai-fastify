import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISPLAY_SETTINGS_CACHE_KEY,
  DISPLAY_STYLE_PROPERTIES,
  applyDisplayStyles,
  cacheDisplaySettings,
  readDisplaySettingsCache,
} from './displaySettingsCache'
import { CUSTOM_CSS_CACHE_KEY } from './customCSSCache'

const entryHtml = readFileSync('index.html', 'utf8')
function entryScript(marker: string): string {
  return entryHtml.match(new RegExp(`<script ${marker}>([\\s\\S]*?)</script>`))![1]
}

function restoreEntryCache(storage: Storage = localStorage): void {
  for (const marker of ['data-risu-display-cache', 'data-risu-custom-css-cache']) {
    new Function('document', 'localStorage', entryScript(marker))(document, storage)
  }
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  document.documentElement.classList.remove('risu-reduced-motion')
  document.body.replaceChildren()
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  document.documentElement.classList.remove('risu-reduced-motion')
  document.body.replaceChildren()
})

describe('display paint cache', () => {
  it('restores colors, fonts, size, speed, reduced motion and Custom CSS before app markup', () => {
    const styles = {
      '--risu-theme-bgcolor': '#ffffff',
      '--risu-theme-color-scheme': 'light',
      '--risu-font-family': 'Georgia, serif',
      '--sidebar-size': '32rem',
      '--risu-animation-speed': '0.01ms',
    }
    applyDisplayStyles(styles, true)
    cacheDisplaySettings({ theme: 'mobilechat', zoomsize: 140, textAreaSize: 3 }, ['theme', 'zoomsize', 'textAreaSize'])
    localStorage.setItem(CUSTOM_CSS_CACHE_KEY, 'body { --custom-marker: cached; }')
    document.documentElement.removeAttribute('style')
    document.documentElement.classList.remove('risu-reduced-motion')

    restoreEntryCache()

    expect(document.querySelector('#app')).toBeNull()
    for (const [key, value] of Object.entries(styles)) {
      expect(document.documentElement.style.getPropertyValue(key)).toBe(value)
    }
    expect(document.documentElement.classList.contains('risu-reduced-motion')).toBe(true)
    expect(document.querySelector('#customcss')?.textContent).toBe('body { --custom-marker: cached; }')
    expect(readDisplaySettingsCache().settings).toMatchObject({ theme: 'mobilechat', zoomsize: 140, textAreaSize: 3 })
  })

  it('does not rewrite the DOM or storage for unchanged authoritative styles', () => {
    const styles = { '--risu-theme-bgcolor': '#ffffff', '--risu-animation-speed': '0.6s' }
    applyDisplayStyles(styles, false)
    const setStyle = vi.spyOn(document.documentElement.style, 'setProperty')
    const setCache = vi.spyOn(localStorage, 'setItem')

    applyDisplayStyles(styles, false)

    expect(setStyle).not.toHaveBeenCalled()
    expect(setCache).not.toHaveBeenCalled()
  })

  it('updates the live appearance and cache when the server settings change', () => {
    applyDisplayStyles({ '--risu-theme-bgcolor': '#ffffff', '--risu-animation-speed': '0.6s' }, false)
    applyDisplayStyles({ '--risu-theme-bgcolor': '#121212', '--risu-animation-speed': '0.01ms' }, true)
    expect(document.documentElement.style.getPropertyValue('--risu-theme-bgcolor')).toBe('#121212')
    expect(readDisplaySettingsCache()).toMatchObject({
      styles: { '--risu-theme-bgcolor': '#121212', '--risu-animation-speed': '0.01ms' },
      reducedMotion: true,
    })
  })

  it('merges partial shell settings without clearing cached deferred sizes', () => {
    cacheDisplaySettings({ theme: 'mobilechat', zoomsize: 140, sideBarSize: 2 }, ['theme', 'zoomsize', 'sideBarSize'])
    cacheDisplaySettings({ sideBarSize: 3 }, ['sideBarSize'])

    expect(readDisplaySettingsCache().settings).toEqual({ theme: 'mobilechat', zoomsize: 140, sideBarSize: 3 })
    cacheDisplaySettings({}, ['theme', 'zoomsize'])
    expect(readDisplaySettingsCache().settings).toEqual({ sideBarSize: 3 })
  })

  it('only retains allowlisted visual settings and well-formed values', () => {
    cacheDisplaySettings({ zoomsize: 140, openAIKey: 'secret' }, ['zoomsize', 'openAIKey'])
    cacheDisplaySettings({ zoomsize: Number.NaN }, ['zoomsize'])

    expect(readDisplaySettingsCache().settings).toEqual({})
    expect(localStorage.getItem(DISPLAY_SETTINGS_CACHE_KEY)).not.toContain('secret')
  })

  it.each(['{', '{"version":2,"styles":{}}', 'null'])('ignores a malformed/unsupported record: %s', (serialized) => {
    localStorage.setItem(DISPLAY_SETTINGS_CACHE_KEY, serialized)
    expect(() => restoreEntryCache()).not.toThrow()
    expect(document.documentElement.getAttribute('style')).toBeNull()
    expect(readDisplaySettingsCache()).toEqual({ version: 1, settings: {}, styles: {} })
  })

  it('keeps the entry bootstrap property allowlist aligned with the runtime and rejects other styles', () => {
    const properties = [...entryScript('data-risu-display-cache').matchAll(/'(--[^']+)'/g)].map((match) => match[1])
    expect(properties).toEqual([...DISPLAY_STYLE_PROPERTIES])
    localStorage.setItem(
      DISPLAY_SETTINGS_CACHE_KEY,
      JSON.stringify({
        version: 1,
        settings: {},
        styles: { display: 'none', '--risu-visual-viewport-height': '1px', '--sidebar-size': 42 },
      }),
    )
    restoreEntryCache()
    expect(document.documentElement.getAttribute('style')).toBeNull()
  })

  it('ignores storage failures while still applying authoritative styles', () => {
    const blockedStorage = {
      getItem() {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(() => restoreEntryCache(blockedStorage)).not.toThrow()
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })

    expect(() => applyDisplayStyles({ '--sidebar-size': '32rem' })).not.toThrow()
    expect(document.documentElement.style.getPropertyValue('--sidebar-size')).toBe('32rem')
  })

  it('uses theme colors for both loading surfaces', () => {
    expect(entryHtml.match(/id="preloading"[\s\S]*?>/)?.[0]).toContain('bg-bgcolor')
    const app = readFileSync('src/App.svelte', 'utf8')
    expect(app.match(/\{:else if workspaceIsBooting\}[\s\S]*?role="status"/)?.[0]).toContain('bg-bgcolor')
  })
})
