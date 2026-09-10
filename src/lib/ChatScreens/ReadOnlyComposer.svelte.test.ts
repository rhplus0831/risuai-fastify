import { mount, unmount } from 'svelte'
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

afterEach(async () => {
  if (component) await unmount(component)
  target.remove()
})

describe('read-only composer presentation', () => {
  it('keeps every field and action natively unavailable', () => {
    const fields = target.querySelectorAll<HTMLTextAreaElement>('[data-reader-composer-field]')
    const actions = target.querySelectorAll<HTMLButtonElement>('[data-reader-composer] button')
    expect(fields).toHaveLength(4)
    expect(actions.length).toBeGreaterThanOrEqual(5)
    expect([...fields].every((field) => field.disabled && field.readOnly)).toBe(true)
    expect([...actions].every((action) => action.disabled)).toBe(true)
    expect(target.querySelector('[data-reader-composer]')?.textContent).toContain(
      language.connectedReaders.composerReadOnly,
    )
  })

  it('lets synthetic input and send clicks bubble without opening writer UI', () => {
    const input = target.querySelector<HTMLTextAreaElement>('[data-reader-composer-field="message"]')!
    const listener = vi.fn()
    target.addEventListener('input', listener)
    input.value = 'synthetic writer text'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'synthetic writer text' }))
    target
      .querySelector<HTMLButtonElement>('[data-reader-composer-send]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(listener).toHaveBeenCalledOnce()
    expect(target.querySelector('[aria-busy="true"]')).toBeNull()
    expect(target.querySelector('[role="dialog"], [role="menu"]')).toBeNull()
  })
})
