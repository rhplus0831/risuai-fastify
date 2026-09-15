import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { language } from '../../lang'
import ReadOnlyComposer from './ReadOnlyComposer.svelte'

let target: HTMLElement
let component: ReturnType<typeof mount> | undefined

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  component = mount(ReadOnlyComposer, { target })
})

async function render(props: Record<string, unknown>) {
  if (component) await unmount(component)
  target.replaceChildren()
  component = mount(ReadOnlyComposer, { target, props })
  flushSync()
  await tick()
}

afterEach(async () => {
  if (component) await unmount(component)
  target.remove()
})

describe('read-only composer presentation', () => {
  it('keeps every field and action natively unavailable', () => {
    const fields = target.querySelectorAll<HTMLTextAreaElement>('[data-reader-composer-field]')
    const actions = target.querySelectorAll<HTMLButtonElement>('[data-reader-composer] button')
    expect([...fields].map((field) => field.dataset.readerComposerField)).toEqual(
      expect.arrayContaining(['message', 'translated', 'draft', 'btw']),
    )
    expect(actions.length).toBeGreaterThanOrEqual(3)
    expect([...fields].every((field) => field.disabled && field.readOnly)).toBe(true)
    expect([...actions].every((action) => action.disabled)).toBe(true)
    expect(target.querySelector('[data-reader-composer]')?.textContent).toContain(
      language.connectedReaders.chatOccupancy.unsupported,
    )
  })

  it('keeps synthetic events from sending or opening writer UI', async () => {
    const onSend = vi.fn()
    await render({ draftValue: 'retained draft', onSend })
    const input = target.querySelector<HTMLTextAreaElement>('[data-reader-composer-field="message"]')!
    const listener = vi.fn()
    target.addEventListener('input', listener)
    input.value = 'synthetic writer text'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'synthetic writer text' }))
    target
      .querySelector<HTMLButtonElement>('[data-reader-composer-send]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(listener).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
    expect(target.querySelector('[aria-busy="true"]')).toBeNull()
    expect(target.querySelector('[role="dialog"], [role="menu"]')).toBeNull()
  })

  it.each([
    ['unsupported', language.connectedReaders.chatOccupancy.unsupported],
    ['disabled', language.connectedReaders.chatOccupancy.disabled],
    ['identity-unavailable', language.connectedReaders.chatOccupancy.identityUnavailable],
    ['foreign-owned', language.connectedReaders.chatOccupancy.foreignOwned],
    ['normalization-elsewhere', language.connectedReaders.chatOccupancy.normalizationElsewhere],
  ] as const)('shows a fail-closed %s state with no occupancy action', async (mode, title) => {
    await render({ mode })

    expect(target.querySelector('[data-reader-chat-occupancy]')?.getAttribute('data-state')).toBe(mode)
    expect(target.querySelector('[data-reader-occupancy-title]')?.textContent).toBe(title)
    expect(target.querySelector('[data-reader-occupancy-claim]')).toBeNull()
    expect(target.querySelector('[data-reader-occupancy-release]')).toBeNull()
    expect(target.querySelector('[data-reader-occupancy-switch]')).toBeNull()
    expect(target.querySelector<HTMLTextAreaElement>('[data-reader-composer-field="message"]')?.disabled).toBe(true)
  })

  it('emits explicit claim, switch, normalization, and release actions only from their matching states', async () => {
    const onClaim = vi.fn()
    const onSwitch = vi.fn()
    const onNormalize = vi.fn()
    const onRelease = vi.fn()

    await render({ mode: 'available', onClaim, onSwitch, onNormalize, onRelease })
    target.querySelector<HTMLButtonElement>('[data-reader-occupancy-claim]')!.click()
    expect(onClaim).toHaveBeenCalledOnce()
    expect(onSwitch).not.toHaveBeenCalled()

    await render({ mode: 'switch-required', onClaim, onSwitch, onNormalize, onRelease })
    target.querySelector<HTMLButtonElement>('[data-reader-occupancy-switch]')!.click()
    expect(onSwitch).toHaveBeenCalledOnce()

    await render({ mode: 'normalization-required', onClaim, onSwitch, onNormalize, onRelease })
    target.querySelector<HTMLButtonElement>('[data-reader-occupancy-normalize]')!.click()
    expect(onNormalize).toHaveBeenCalledOnce()

    await render({ mode: 'self-owned', onClaim, onSwitch, onNormalize, onRelease })
    target.querySelector<HTMLButtonElement>('[data-reader-occupancy-release]')!.click()
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it('shows pending occupancy feedback without granting composer access', async () => {
    await render({
      mode: 'available',
      occupancyPending: 'claim',
      feedback: language.connectedReaders.chatOccupancy.actionFailed,
    })

    const action = target.querySelector<HTMLButtonElement>('[data-reader-occupancy-claim]')!
    expect(target.querySelector('[data-reader-chat-occupancy]')?.getAttribute('data-state')).toBe('claiming')
    expect(action.disabled).toBe(true)
    expect(action.getAttribute('aria-busy')).toBe('true')
    expect(target.querySelector('[data-reader-occupancy-feedback]')?.textContent).toContain(
      language.connectedReaders.chatOccupancy.actionFailed,
    )
    expect(target.querySelector<HTMLTextAreaElement>('[data-reader-composer-field="message"]')?.disabled).toBe(true)
  })

  it('enables only the scoped send and latest-response reroll controls when self-owned', async () => {
    const onSend = vi.fn(async (_message: string, accepted: () => void) => accepted())
    const onReroll = vi.fn(async () => {})
    await render({ mode: 'self-owned', rerollTargetMessageId: 'assistant-latest', onSend, onReroll })

    const input = target.querySelector<HTMLTextAreaElement>('[data-reader-composer-field="message"]')!
    const send = target.querySelector<HTMLButtonElement>('[data-reader-composer-send]')!
    const reroll = target.querySelector<HTMLButtonElement>('[data-reader-composer-reroll]')!
    expect(input.disabled).toBe(false)
    expect(input.readOnly).toBe(false)
    expect(send.disabled).toBe(true)
    input.value = '  scoped message  '
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '  scoped message  ' }))
    await tick()
    expect(send.disabled).toBe(false)
    send.click()
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith('scoped message', expect.any(Function)))
    await vi.waitFor(() => expect(input.value).toBe(''))

    expect(reroll.disabled).toBe(false)
    reroll.click()
    await vi.waitFor(() => expect(onReroll).toHaveBeenCalledWith('assistant-latest'))
    expect(target.querySelector<HTMLButtonElement>('[data-reader-composer-attachment]')?.disabled).toBe(true)
    expect(target.querySelector<HTMLButtonElement>('[data-reader-composer-menu]')?.disabled).toBe(true)
    expect(target.querySelector('[data-reader-deferred-actions]')?.textContent).toContain(
      language.connectedReaders.chatOccupancy.unsupportedActions,
    )
  })

  it('retains a changed or rejected draft and sends Enter only through the scoped callback', async () => {
    let accept: (() => void) | undefined
    let releaseSend!: () => void
    const held = new Promise<void>((resolve) => (releaseSend = resolve))
    const onSend = vi.fn(async (_message: string, accepted: () => void) => {
      accept = accepted
      await held
    })
    await render({ mode: 'self-owned', onSend })
    const input = target.querySelector<HTMLTextAreaElement>('[data-reader-composer-field="message"]')!
    input.value = 'original draft'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'original draft' }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    input.value = 'newer draft'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'newer draft' }))
    accept?.()
    releaseSend()
    await vi.waitFor(() => expect(input.value).toBe('newer draft'))

    await render({ mode: 'self-owned', onSend: vi.fn(async () => {}) })
    const rejected = target.querySelector<HTMLTextAreaElement>('[data-reader-composer-field="message"]')!
    rejected.value = 'retained draft'
    rejected.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'retained draft' }))
    target.querySelector<HTMLButtonElement>('[data-reader-composer-send]')!.click()
    await vi.waitFor(() => expect(rejected.value).toBe('retained draft'))
  })

  it('shows Stop for an owned active generation and keeps send and reroll unavailable', async () => {
    const onStop = vi.fn(async () => {})
    const onSend = vi.fn()
    const onReroll = vi.fn()
    await render({
      mode: 'self-owned',
      generationActive: true,
      rerollTargetMessageId: 'assistant-latest',
      onStop,
      onSend,
      onReroll,
    })

    expect(target.querySelector('[data-reader-composer-send]')).toBeNull()
    expect(target.querySelector<HTMLButtonElement>('[data-reader-composer-reroll]')?.disabled).toBe(true)
    target.querySelector<HTMLButtonElement>('[data-reader-composer-stop]')!.click()
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledOnce())
    expect(onSend).not.toHaveBeenCalled()
    expect(onReroll).not.toHaveBeenCalled()
  })

  it('does not render Stop while merely observing another chat generation', async () => {
    await render({ mode: 'foreign-owned', generationActive: true })

    expect(target.querySelector('[data-reader-composer-stop]')).toBeNull()
    expect(target.querySelector<HTMLButtonElement>('[data-reader-composer-send]')?.disabled).toBe(true)
  })

  it.each(['unsupported', 'available', 'self-owned', 'foreign-owned'] as const)(
    'blocks attachment drops while %s',
    async (mode) => {
      const downstream = vi.fn()
      document.body.addEventListener('drop', downstream, { once: true })
      await render({ mode })
      const composer = target.querySelector<HTMLElement>('[data-reader-composer]')!
      const dropped = new Event('drop', { bubbles: true, cancelable: true })
      composer.dispatchEvent(dropped)

      expect(dropped.defaultPrevented).toBe(true)
      expect(downstream).not.toHaveBeenCalled()
      document.body.removeEventListener('drop', downstream)
    },
  )
})
