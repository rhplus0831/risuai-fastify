import { afterEach, describe, expect, it } from 'vitest'

import { modalFocusTrap } from './modalFocusTrap'

const mountedRoots: HTMLElement[] = []

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function createModalFixture() {
  const root = document.createElement('div')
  const background = document.createElement('main')
  const backgroundButton = document.createElement('button')
  const overlay = document.createElement('div')
  const modal = document.createElement('div')
  const first = document.createElement('button')
  const last = document.createElement('button')

  backgroundButton.textContent = 'Background'
  first.textContent = 'First'
  last.textContent = 'Last'
  background.append(backgroundButton)
  modal.tabIndex = -1
  modal.append(first, last)
  overlay.dataset.modalRoot = ''
  overlay.append(modal)
  root.append(background, overlay)
  document.body.append(root)
  mountedRoots.push(root)

  return { background, backgroundButton, first, last, modal, overlay, root }
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.remove()
  document.body.style.overflow = ''
})

describe('modalFocusTrap', () => {
  it('inerts the background, contains focus, and restores state and focus', async () => {
    const { background, backgroundButton, first, last, modal } = createModalFixture()
    backgroundButton.focus()

    const action = modalFocusTrap(modal)
    await settle()

    expect(background.inert).toBe(true)
    expect(background.getAttribute('aria-hidden')).toBe('true')
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(first)

    last.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)

    first.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(last)

    backgroundButton.focus()
    expect(document.activeElement).toBe(first)

    action.destroy()
    await settle()
    expect(background.inert).toBe(false)
    expect(background.hasAttribute('aria-hidden')).toBe(false)
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(backgroundButton)
  })

  it('preserves pre-existing inert and aria-hidden background state', async () => {
    const { background, modal } = createModalFixture()
    background.inert = true
    background.setAttribute('aria-hidden', 'custom')

    const action = modalFocusTrap(modal)
    await settle()
    action.destroy()
    await settle()

    expect(background.inert).toBe(true)
    expect(background.getAttribute('aria-hidden')).toBe('custom')
  })

  it('allows keyboard focus to enter an iframe-only login dialog', async () => {
    const root = document.createElement('div')
    const overlay = document.createElement('div')
    const modal = document.createElement('div')
    const iframe = document.createElement('iframe')

    modal.tabIndex = -1
    iframe.title = 'Login'
    modal.append(iframe)
    overlay.dataset.modalRoot = ''
    overlay.append(modal)
    root.append(document.createElement('main'), overlay)
    document.body.append(root)
    mountedRoots.push(root)

    const action = modalFocusTrap(modal)
    await settle()

    expect(document.activeElement).toBe(iframe)

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(iframe)

    action.destroy()
  })

  it('keeps only the top modal active and restores the lower trap when it closes', async () => {
    const { background, first, modal, overlay, root } = createModalFixture()
    const lowerAction = modalFocusTrap(modal)
    await settle()

    const topOverlay = document.createElement('div')
    const topModal = document.createElement('div')
    const topButton = document.createElement('button')
    topButton.textContent = 'Top modal action'
    topModal.tabIndex = -1
    topModal.append(topButton)
    topOverlay.dataset.modalRoot = ''
    topOverlay.append(topModal)
    root.append(topOverlay)

    const topAction = modalFocusTrap(topModal)
    await settle()

    expect(overlay.inert).toBe(true)
    expect(topOverlay.inert).toBe(false)
    expect(document.activeElement).toBe(topButton)

    first.focus()
    expect(document.activeElement).toBe(topButton)

    topAction.destroy()
    await settle()

    expect(overlay.inert).toBe(false)
    expect(background.inert).toBe(true)
    expect(document.activeElement).toBe(first)

    lowerAction.destroy()
  })

  it('inerts every ancestor sibling branch around a modal nested in Settings', async () => {
    const app = document.createElement('div')
    const appSidebar = document.createElement('aside')
    const settings = document.createElement('section')
    const settingsNavigation = document.createElement('nav')
    const settingsContent = document.createElement('main')
    const pageContent = document.createElement('div')
    const pageToolbar = document.createElement('div')
    const overlay = document.createElement('div')
    const modal = document.createElement('div')
    const modalButton = document.createElement('button')

    overlay.dataset.modalRoot = ''
    modal.tabIndex = -1
    modal.append(modalButton)
    overlay.append(modal)
    pageContent.append(pageToolbar, overlay)
    settingsContent.append(pageContent)
    settings.append(settingsNavigation, settingsContent)
    app.append(appSidebar, settings)
    document.body.append(app)
    mountedRoots.push(app)

    const action = modalFocusTrap(modal)
    await settle()

    expect(pageToolbar.inert).toBe(true)
    expect(settingsNavigation.inert).toBe(true)
    expect(appSidebar.inert).toBe(true)
    expect(overlay.inert).toBe(false)

    action.destroy()
    await settle()

    expect(pageToolbar.inert).toBe(false)
    expect(settingsNavigation.inert).toBe(false)
    expect(appSidebar.inert).toBe(false)
  })

  it('keeps the app background inert for a top modal nested inside the lower dialog', async () => {
    const { background, first, modal } = createModalFixture()
    const lowerAction = modalFocusTrap(modal)
    await settle()

    const topOverlay = document.createElement('div')
    const topModal = document.createElement('div')
    const topButton = document.createElement('button')
    topOverlay.dataset.modalRoot = ''
    topModal.tabIndex = -1
    topModal.append(topButton)
    topOverlay.append(topModal)
    modal.append(topOverlay)

    const topAction = modalFocusTrap(topModal)
    await settle()

    expect(background.inert).toBe(true)
    expect(first.inert).toBe(true)
    expect(topOverlay.inert).toBe(false)
    expect(document.activeElement).toBe(topButton)

    topAction.destroy()
    topOverlay.remove()
    await settle()

    expect(background.inert).toBe(true)
    expect(first.inert).toBe(false)
    expect(document.activeElement).toBe(first)

    lowerAction.destroy()
  })

  it('inerts siblings dynamically inserted at an observed ancestor', async () => {
    const { modal, root } = createModalFixture()
    const action = modalFocusTrap(modal)
    await settle()

    const dynamicBackground = document.createElement('aside')
    root.append(dynamicBackground)
    await settle()

    expect(dynamicBackground.inert).toBe(true)
    expect(dynamicBackground.getAttribute('aria-hidden')).toBe('true')

    action.destroy()
    await settle()

    expect(dynamicBackground.inert).toBe(false)
    expect(dynamicBackground.hasAttribute('aria-hidden')).toBe(false)
  })

  it('admits an explicitly marked popup opened from the active modal into its focus scope', async () => {
    const { background, first, modal, root } = createModalFixture()
    const action = modalFocusTrap(modal)
    await settle()
    first.focus()

    const popupHost = document.createElement('div')
    const popupAction = document.createElement('button')
    popupHost.dataset.modalFocusExtension = ''
    popupAction.textContent = 'Popup action'
    popupHost.append(popupAction)
    root.append(popupHost)
    await settle()

    expect(popupHost.inert).toBe(false)
    expect(popupHost.hasAttribute('aria-hidden')).toBe(false)
    popupAction.focus()
    expect(document.activeElement).toBe(popupAction)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)

    background.querySelector('button')!.focus()
    expect(document.activeElement).toBe(first)

    action.destroy()
  })
})
