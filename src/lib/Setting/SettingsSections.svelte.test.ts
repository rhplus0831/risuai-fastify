import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./SettingRenderer.svelte', async () => {
  const { default: SettingRendererPropsProbe } = await import('./testHarness/SettingRendererPropsProbe.svelte')
  return { default: SettingRendererPropsProbe }
})

import SettingsSections from './SettingsSections.svelte'
import type { SettingSection } from 'src/ts/setting/types'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

beforeEach(() => {
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

describe('SettingsSections', () => {
  it('renders ordinary groups as named regions', async () => {
    const sections: SettingSection[] = [
      {
        id: 'motion',
        labelKey: 'settingsSectionMotionScrolling',
        descriptionKey: 'settingsSectionMotionScrollingDescription',
        items: [{ id: 'motion.reduce', type: 'check', fallbackLabel: 'Reduce motion' }],
      },
    ]

    component = mount(SettingsSections, { target, props: { sections } })
    await tick()

    const section = target.querySelector('[data-settings-section="motion"]')
    const heading = target.querySelector('h3')
    expect(section).toBeTruthy()
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id)
    expect(heading?.textContent).toContain('Motion & scrolling')
    expect(target.querySelector('[data-setting-renderer-probe]')?.getAttribute('data-items')).toBe('1')
  })

  it('keeps exceptional groups collapsed until requested', async () => {
    const sections: SettingSection[] = [
      {
        id: 'legacy',
        labelKey: 'settingsSectionLegacyCompatibility',
        collapsible: true,
        items: [{ id: 'legacy.mode', type: 'check', fallbackLabel: 'Legacy mode' }],
      },
    ]

    component = mount(SettingsSections, { target, props: { sections } })
    await tick()

    const trigger = target.querySelector<HTMLButtonElement>('button[aria-expanded]')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(target.querySelector('[data-setting-renderer-probe]')).toBeNull()

    trigger?.click()
    await tick()

    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    expect(target.querySelector('[data-setting-renderer-probe]')?.getAttribute('data-items')).toBe('1')
  })
})
