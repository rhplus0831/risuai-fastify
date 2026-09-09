import { get } from 'svelte/store'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeLanguage } from 'src/lang'
import { installLanguageReactivity } from 'src/lang/reactivity'
import { languageEnglish } from 'src/lang/en'
import { languageKorean } from 'src/lang/ko'
import { DynamicGUI, MobileGUI, sideBarClosing, sideBarStore, sideBarTransitionCause } from 'src/ts/stores.svelte'
import SideBarArrow from './SideBarArrow.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

beforeEach(async () => {
  installLanguageReactivity()
  target = document.createElement('div')
  document.body.appendChild(target)
  DynamicGUI.set(false)
  MobileGUI.set(false)
  sideBarClosing.set(false)
  sideBarStore.set(true)
  sideBarTransitionCause.set('none')
  await changeLanguage('ko')
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  changeLanguage('en')
  DynamicGUI.set(false)
  MobileGUI.set(false)
  sideBarClosing.set(false)
  sideBarStore.set(true)
  sideBarTransitionCause.set('none')
})

describe('SideBarArrow accessible names', () => {
  it('repaints a mounted live language consumer when a deferred pack is applied', async () => {
    await changeLanguage('en')
    component = mount(SideBarArrow, { target })
    await tick()
    const button = target.querySelector<HTMLButtonElement>('[data-risu-sidebar-toggle="collapse"]')!
    expect(button.getAttribute('aria-label')).toBe(languageEnglish.collapseSidebar)

    await changeLanguage('ko')
    await tick()
    expect(button.getAttribute('aria-label')).toBe(languageKorean.collapseSidebar)
    expect(target.querySelector('[data-risu-sidebar-toggle="collapse"]')).toBe(button)
  })

  it('uses localized names for both sidebar states and preserves their actions', async () => {
    component = mount(SideBarArrow, { target })
    await tick()

    const collapseButton = target.querySelector<HTMLButtonElement>('[data-risu-sidebar-toggle="collapse"]')
    expect(collapseButton?.getAttribute('aria-label')).toBe(languageKorean.collapseSidebar)

    collapseButton?.click()
    await tick()
    expect(get(sideBarClosing)).toBe(true)
    expect(get(sideBarTransitionCause)).toBe('explicit-close')

    sideBarClosing.set(false)
    sideBarStore.set(false)
    await tick()

    const expandButton = target.querySelector<HTMLButtonElement>('[data-risu-sidebar-toggle="expand"]')
    expect(expandButton?.getAttribute('aria-label')).toBe(languageKorean.expandSidebar)

    expandButton?.click()
    await tick()
    expect(get(sideBarClosing)).toBe(false)
    expect(get(sideBarStore)).toBe(true)
    expect(get(sideBarTransitionCause)).toBe('explicit-open')
  })
})
