import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hotkeyMocks = vi.hoisted(() => ({ applyServerBackedSetting: vi.fn() }))

vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  applyServerBackedSetting: hotkeyMocks.applyServerBackedSetting,
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

import HotkeySettings from './HotkeySettings.svelte'
import { language } from 'src/lang'
import { replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function recorder(): HTMLInputElement {
  const input = target.querySelector('input')
  if (!input) throw new Error('hotkey recorder not found')
  return input
}

function keydown(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  input.dispatchEvent(event)
  return event
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  target = document.createElement('div')
  document.body.appendChild(target)
  hotkeyMocks.applyServerBackedSetting.mockReset()
  replaceResourceDatabase({
    hotkeys: [{ action: 'send', key: 'Enter', ctrl: true, shift: false, alt: true }],
  } as any)
  component = mount(HotkeySettings, { target })
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
})

describe('HotkeySettings recorder keyboard behavior', () => {
  it('names the key recorder for its action', () => {
    expect(recorder().getAttribute('aria-label')).toBe(`${language.hotkeyDesc.send} ${language.hotkey}`)
  })

  it('announces the selected modifier keys', () => {
    const buttons = Array.from(target.querySelectorAll('button'))
    expect(buttons.map((button) => [button.textContent?.trim(), button.getAttribute('aria-pressed')])).toEqual([
      ['Ctrl', 'true'],
      ['Shift', 'false'],
      ['Alt', 'true'],
    ])
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      `${language.hotkeyDesc.send}: Ctrl`,
      `${language.hotkeyDesc.send}: Shift`,
      `${language.hotkeyDesc.send}: Alt`,
    ])
  })

  it.each([
    ['Ctrl', { ctrl: false, shift: false, alt: true }],
    ['Shift', { ctrl: true, shift: true, alt: true }],
    ['Alt', { ctrl: true, shift: false, alt: false }],
  ])('persists the toggled %s modifier without changing its siblings', (name, expectedModifiers) => {
    const button = Array.from(target.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === name,
    )
    if (!button) throw new Error(`${name} modifier button was not rendered`)

    button.click()

    expect(hotkeyMocks.applyServerBackedSetting).toHaveBeenCalledWith('hotkeys', [
      {
        action: 'send',
        key: 'Enter',
        ...expectedModifiers,
      },
    ])
  })

  it('updates the layout when the viewport crosses the mobile breakpoint', async () => {
    expect(recorder().getAttribute('aria-label')).toBe(`${language.hotkeyDesc.send} ${language.hotkey}`)

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
    window.dispatchEvent(new Event('resize'))
    await tick()

    expect(target.querySelector('input')).toBeNull()
    expect(target.textContent).toContain(language.screenTooSmall)

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    window.dispatchEvent(new Event('resize'))
    await tick()

    expect(recorder().getAttribute('aria-label')).toBe(`${language.hotkeyDesc.send} ${language.hotkey}`)
    expect(target.textContent).not.toContain(language.screenTooSmall)
  })

  it('leaves Tab unhandled so native keyboard navigation can move focus', () => {
    const input = recorder()
    input.focus()

    const event = keydown(input, 'Tab')

    expect(event.defaultPrevented).toBe(false)
    expect(hotkeyMocks.applyServerBackedSetting).not.toHaveBeenCalled()
  })

  it('uses Escape to cancel recording and release focus without changing the hotkey', async () => {
    const input = recorder()
    const bubbled = vi.fn()
    document.addEventListener('keydown', bubbled, { once: true })
    input.focus()

    const event = keydown(input, 'Escape')
    await tick()

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).not.toBe(input)
    expect(bubbled).not.toHaveBeenCalled()
    expect(hotkeyMocks.applyServerBackedSetting).not.toHaveBeenCalled()
    document.removeEventListener('keydown', bubbled)
  })

  it('still records ordinary keys while preserving the selected modifiers', () => {
    const input = recorder()

    const event = keydown(input, 'k', { ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(hotkeyMocks.applyServerBackedSetting).toHaveBeenCalledWith('hotkeys', [
      {
        action: 'send',
        key: 'k',
        ctrl: true,
        shift: false,
        alt: true,
      },
    ])
  })
})
