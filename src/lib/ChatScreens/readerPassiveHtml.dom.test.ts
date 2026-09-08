import { afterEach, describe, expect, it, vi } from 'vitest'
import { denyReaderScriptActivation, disableReaderScriptControls } from './readerPassiveHtml'

const mounted: HTMLElement[] = []
afterEach(() => mounted.splice(0).forEach((element) => element.remove()))

function root(html: string): HTMLElement {
  const element = document.createElement('div')
  element.innerHTML = disableReaderScriptControls(html, 'Write access is required')
  document.body.appendChild(element)
  mounted.push(element)
  return element
}

describe('reader passive markup controls', () => {
  it('disables script controls accessibly while keeping safe links, styles and disclosure markup', () => {
    const element = root(
      '<style>.note { color: red }</style><details><summary>More</summary><a href="https://example.com">Link</a></details><button risu-btn="local">Run</button><span role="button" tabindex="0" risu-trigger="local">Local action</span>',
    )
    const button = element.querySelector('button')!
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('Write access is required')
    const control = element.querySelector('span')!
    expect(control.getAttribute('aria-disabled')).toBe('true')
    expect(control.getAttribute('tabindex')).toBe('-1')
    expect(element.querySelector('details summary')?.textContent).toBe('More')
    expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(element.querySelector('style')?.textContent).toContain('color: red')
    expect(element.querySelector('summary')?.hasAttribute('aria-disabled')).toBe(false)
  })

  it.each(['click', 'keydown'])(
    'rejects programmatic %s activation before a downstream callback even if disabled is removed',
    (type) => {
      const element = root('<button risu-btn="local"><span>Run</span></button>')
      const button = element.querySelector('button')!
      button.disabled = false
      const downstream = vi.fn()
      element.addEventListener(type, (event) => denyReaderScriptActivation(event, false), { capture: true })
      button.addEventListener(type, downstream)
      const event =
        type === 'click'
          ? new MouseEvent(type, { bubbles: true, cancelable: true })
          : new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter' })
      button.querySelector('span')!.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(downstream).not.toHaveBeenCalled()
    },
  )

  it('preserves authorized writer activation and ordinary native reading interactions', () => {
    const element = root('<details><summary>More</summary>Body</details><button risu-trigger="manual">Run</button>')
    const downstream = vi.fn()
    element.addEventListener('click', (event) => denyReaderScriptActivation(event, true), { capture: true })
    element.addEventListener('click', downstream)
    element.querySelector('button')!.disabled = false
    element.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const native = new MouseEvent('click', { bubbles: true, cancelable: true })
    element.querySelector('summary')!.dispatchEvent(native)
    expect(downstream).toHaveBeenCalledTimes(2)
    expect(native.defaultPrevented).toBe(false)
  })

  it('removes executable inline attributes while marking their unavailable control', () => {
    const element = root('<button onclick="window.localEffect = true">Unsafe callback</button>')
    const button = element.querySelector('button')!
    expect(button.getAttribute('onclick')).toBeNull()
    expect(button.disabled).toBe(true)
    expect(button.hasAttribute('data-reader-script-control')).toBe(true)
  })
})
