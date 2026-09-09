import { mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { language } from '../lang'
import ReaderTakeoverAction from './ReaderTakeoverAction.svelte'

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

describe('reader takeover action region', () => {
  it('renders exactly one accessible takeover in the conversation-equivalent footer', () => {
    const onUseThisDevice = vi.fn()
    component = mount(ReaderTakeoverAction, {
      target,
      props: {
        conversation: true,
        managed: true,
        title: language.connectedReaders.title,
        status: language.connectedReaders.connected,
        result: language.connectedReaders.switchCancelled,
        onUseThisDevice,
      },
    })

    const buttons = target.querySelectorAll<HTMLButtonElement>('[data-reader-use-this-device]')
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-reader-composer] textarea')!
    expect(buttons).toHaveLength(1)
    expect(buttons[0].matches('[data-reader-composer-takeover]')).toBe(true)
    expect(document.getElementById(buttons[0].getAttribute('aria-describedby')!)?.textContent).toBe(
      language.connectedReaders.useThisDeviceHelp,
    )
    expect(textarea.disabled).toBe(true)
    expect(textarea.getAttribute('aria-describedby')).toBe('reader-composer-reason')
    expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent).toBe(
      language.connectedReaders.switchCancelled,
    )
    buttons[0].click()
    expect(onUseThisDevice).toHaveBeenCalledOnce()
  })

  it('keeps the same action bottom-aligned without a composer on non-conversation routes', () => {
    component = mount(ReaderTakeoverAction, {
      target,
      props: {
        conversation: false,
        managed: true,
        title: language.connectedReaders.title,
        status: language.connectedReaders.connected,
      },
    })

    expect(target.querySelector('[data-risu-shell-bottom-action]')).not.toBeNull()
    expect(target.querySelector('[data-reader-use-this-device]')).not.toBeNull()
    expect(target.querySelector('[data-reader-composer]')).toBeNull()
    expect(target.querySelector('textarea')).toBeNull()
  })

  it('rejects disabled takeover dispatch and preserves the observer retry state', async () => {
    const onUseThisDevice = vi.fn()
    component = mount(ReaderTakeoverAction, {
      target,
      props: {
        conversation: true,
        managed: true,
        title: language.connectedReaders.title,
        status: language.connectedReaders.interrupted,
        switchDisabled: true,
        onUseThisDevice,
      },
    })
    const takeover = target.querySelector<HTMLButtonElement>('[data-reader-use-this-device]')!
    takeover.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(takeover.disabled).toBe(true)
    expect(onUseThisDevice).not.toHaveBeenCalled()

    await unmount(component)
    const onRetryWriter = vi.fn()
    component = mount(ReaderTakeoverAction, {
      target,
      props: {
        conversation: false,
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
