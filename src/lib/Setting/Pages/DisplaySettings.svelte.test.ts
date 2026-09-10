import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const displaySettingsMocks = vi.hoisted(() => ({ setLegacyGUI: (_value: boolean) => {} }))

vi.mock('src/ts/setting/displaySettingsData.svelte', () => ({
  displayChatSettingsSections: [],
  displayLayoutSettingsSections: [],
  displaySoundSettingsSections: [],
  displayThemeSettingsSections: [],
}))

vi.mock('../SettingRenderer.svelte', async () => {
  const { default: SettingRendererPropsProbe } =
    await import('src/lib/Setting/testHarness/SettingRendererPropsProbe.svelte')
  return { default: SettingRendererPropsProbe }
})

import { language } from 'src/lang'
import DisplaySettings from './DisplaySettings.svelte'
import { replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function queryButtonNamed(name: string): HTMLButtonElement | null {
  return (
    Array.from(target.querySelectorAll('button')).find(
      (candidate): candidate is HTMLButtonElement => candidate.textContent?.trim() === name,
    ) ?? null
  )
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = queryButtonNamed(name)
  if (!button) throw new Error(`button not found: ${name}`)
  return button
}

beforeEach(() => {
  displaySettingsMocks.setLegacyGUI = (useLegacyGUI) => replaceResourceDatabase({ useLegacyGUI } as any)
  displaySettingsMocks.setLegacyGUI(false)
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  document.body.innerHTML = ''
})

describe('DisplaySettings navigation semantics', () => {
  it('announces the selected settings panel', async () => {
    component = mount(DisplaySettings, { target })
    await tick()

    const theme = buttonNamed(language.theme)
    const layout = buttonNamed(language.settingsTabLayoutSizing)
    const chat = buttonNamed(language.settingsTabChatAppearance)
    const sound = buttonNamed(language.settingsTabSoundNotifications)

    expect(theme.getAttribute('aria-pressed')).toBe('true')
    expect(layout.getAttribute('aria-pressed')).toBe('false')
    expect(chat.getAttribute('aria-pressed')).toBe('false')
    expect(sound.getAttribute('aria-pressed')).toBe('false')

    layout.click()
    await tick()

    expect(theme.getAttribute('aria-pressed')).toBe('false')
    expect(layout.getAttribute('aria-pressed')).toBe('true')
    expect(chat.getAttribute('aria-pressed')).toBe('false')
    expect(sound.getAttribute('aria-pressed')).toBe('false')
  })

  it('switches mounted layouts when the authoritative legacy-GUI setting changes', async () => {
    component = mount(DisplaySettings, { target })
    await tick()

    const panelNames = [
      language.theme,
      language.settingsTabLayoutSizing,
      language.settingsTabChatAppearance,
      language.settingsTabSoundNotifications,
    ]
    for (const name of panelNames) expect(queryButtonNamed(name)).not.toBeNull()

    displaySettingsMocks.setLegacyGUI(true)
    await tick()
    for (const name of panelNames) expect(queryButtonNamed(name)).toBeNull()

    displaySettingsMocks.setLegacyGUI(false)
    await tick()
    for (const name of panelNames) expect(queryButtonNamed(name)).not.toBeNull()
  })
})
