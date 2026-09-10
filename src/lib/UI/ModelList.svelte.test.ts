import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const modelListMocks = vi.hoisted(() => {
  const alpha = {
    providerName: 'Alpha',
    models: [{ id: 'alpha-model', name: 'Alpha Model' }],
  }
  const beta = {
    providerName: 'Beta',
    models: [{ id: 'beta-model', name: 'Beta Model' }],
  }
  const extra = {
    providerName: 'Extra',
    models: [{ id: 'extra-model', name: 'Extra Model' }],
  }

  return {
    getModelInfo: vi.fn(() => ({ fullName: 'Current Model' })),
    getModelList: vi.fn(({ recommendedOnly }: { recommendedOnly?: boolean }) =>
      recommendedOnly ? [alpha, beta] : [beta, extra, alpha],
    ),
  }
})

vi.mock('src/ts/model/modellist', () => modelListMocks)

vi.mock('src/ts/horde/getModels', () => ({
  getHordeModels: vi.fn(async () => []),
}))

vi.mock('src/ts/server/resourceState.svelte', () => ({
  charactersResourceState: { characters: [] },
  settingsResourceState: { status: 'ready', value: { customModels: [] } },
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

vi.mock('src/ts/alert', () => ({
  alertMd: vi.fn(),
}))

vi.mock('src/lang', () => ({
  language: {
    customModels: 'Custom Models',
    model: 'Model',
    none: 'None',
    showUnrecommended: 'Show Unrecommended',
  },
}))

import ModelList from './ModelList.svelte'
import { language } from 'src/lang'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(target.querySelectorAll('button')).find((candidate) => candidate.textContent === text)
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

async function settle(): Promise<void> {
  await tick()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  modelListMocks.getModelInfo.mockClear()
  modelListMocks.getModelList.mockClear()
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
})

describe('ModelList provider identity', () => {
  it('keeps the expanded provider open when filtering reorders provider rows', async () => {
    component = mount(ModelList, {
      target,
      props: { value: 'alpha-model' },
    })
    await tick()

    buttonByText('Current Model').click()
    await tick()
    buttonByText('Beta').click()
    await tick()

    expect(target.textContent).toContain('Beta Model')
    expect(target.textContent).not.toContain('Alpha Model')

    const showUnrecommended = target.querySelector<HTMLInputElement>(
      `input[aria-label="${language.showUnrecommended}"]`,
    )
    if (!showUnrecommended) throw new Error('Show unrecommended checkbox not found')
    showUnrecommended.click()
    await tick()

    const betaTrigger = buttonByText('Beta')
    expect(betaTrigger.getAttribute('aria-expanded')).toBe('true')
    expect(target.textContent).toContain('Beta Model')
    expect(target.textContent).not.toContain('Extra Model')
    expect(target.textContent).not.toContain('Alpha Model')
  })
})

describe('ModelList keyboard dialog', () => {
  it('moves focus into the picker and restores it after Escape closes the dialog', async () => {
    component = mount(ModelList, {
      target,
      props: { value: 'alpha-model' },
    })
    await tick()

    const trigger = buttonByText('Current Model')
    trigger.focus()
    trigger.click()
    await settle()

    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    const back = target.querySelector<HTMLButtonElement>('[data-modal-initial-focus]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-labelledby')).toBe('risu-model-picker-title')
    expect(trigger.inert).toBe(true)
    expect(trigger.getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement).toBe(back)

    back?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()

    expect(target.querySelector('[role="dialog"]')).toBeNull()
    expect(trigger.inert).toBe(false)
    expect(trigger.hasAttribute('aria-hidden')).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps Tab focus inside the model picker', async () => {
    component = mount(ModelList, {
      target,
      props: { value: 'alpha-model' },
    })
    await tick()

    buttonByText('Current Model').click()
    await settle()

    const back = target.querySelector<HTMLButtonElement>('[data-modal-initial-focus]')
    const lastControl = target.querySelector<HTMLInputElement>(`input[aria-label="${language.showUnrecommended}"]`)
    expect(back).not.toBeNull()
    expect(lastControl).not.toBeNull()

    lastControl?.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    lastControl?.dispatchEvent(tab)

    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(back)
  })
})
