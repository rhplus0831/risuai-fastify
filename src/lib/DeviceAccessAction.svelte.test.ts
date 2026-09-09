import { mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { language } from '../lang'
import DeviceAccessAction from './DeviceAccessAction.svelte'

let target: HTMLElement
let component: ReturnType<typeof mount> | undefined

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  target.remove()
})

describe('read-only device access action', () => {
  it('renders one compact top-right action with an accessible combined name', () => {
    const onUseThisDevice = vi.fn()
    component = mount(DeviceAccessAction, {
      target,
      props: {
        managed: true,
        title: language.connectedReaders.title,
        status: language.connectedReaders.connected,
        result: language.connectedReaders.switchCancelled,
        onUseThisDevice,
      },
    })

    const region = target.querySelector<HTMLElement>('[data-risu-device-access-action]')!
    const buttons = region.querySelectorAll<HTMLButtonElement>('[data-reader-use-this-device]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute('aria-label')).toContain(language.observerShell.readOnlyBadge)
    expect(buttons[0].getAttribute('aria-label')).toContain(language.connectedReaders.useThisDevice)
    expect(document.getElementById(buttons[0].getAttribute('aria-describedby')!)?.textContent).toBe(
      language.connectedReaders.useThisDeviceHelp,
    )
    expect(target.querySelector('[data-risu-shell-bottom-action], textarea')).toBeNull()
    expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent).toBe(
      language.connectedReaders.switchCancelled,
    )
    buttons[0].click()
    expect(onUseThisDevice).toHaveBeenCalledOnce()
  })

  it('rejects duplicate or interrupted activation', () => {
    const onUseThisDevice = vi.fn()
    component = mount(DeviceAccessAction, {
      target,
      props: {
        managed: true,
        title: language.connectedReaders.title,
        status: language.connectedReaders.interrupted,
        switchInProgress: true,
        switchDisabled: true,
        onUseThisDevice,
      },
    })
    const action = target.querySelector<HTMLButtonElement>('[data-reader-use-this-device]')!
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(action.disabled).toBe(true)
    expect(action.getAttribute('aria-busy')).toBe('true')
    expect(onUseThisDevice).not.toHaveBeenCalled()
  })

  it('preserves the conservative writer retry state without exposing promotion', () => {
    const onRetryWriter = vi.fn()
    component = mount(DeviceAccessAction, {
      target,
      props: {
        managed: false,
        title: language.observerShell.title,
        status: language.observerShell.statusUnavailable,
        retryAvailable: true,
        onRetryWriter,
      },
    })
    target.querySelector<HTMLButtonElement>('[data-observer-writer-retry]')!.click()
    expect(onRetryWriter).toHaveBeenCalledOnce()
    expect(target.querySelector('[data-reader-use-this-device]')).toBeNull()
  })
})
