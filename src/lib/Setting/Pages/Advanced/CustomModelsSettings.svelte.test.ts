import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/ts/server/settingsOwner.svelte', async () => {
  const { customModelsDraft } = await import('./CustomModelsSettings.testState.svelte')
  return { createServerBackedSettingDraft: () => customModelsDraft }
})

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

import CustomModelsSettings from './CustomModelsSettings.svelte'
import { customModelsDraft } from './CustomModelsSettings.testState.svelte'
import { LLMFlags } from 'src/ts/model/types'
import { language } from 'src/lang'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement
const confirmRemoval = vi.fn()

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  )
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

beforeEach(() => {
  confirmRemoval.mockReset().mockReturnValue(false)
  vi.stubGlobal('confirm', confirmRemoval)
  customModelsDraft.value = [
    {
      id: 'xcustom:::all-flags',
      name: 'All Flags',
      internalId: 'all-flags',
      url: 'https://example.test/v1',
      tokenizer: 0,
      format: 0,
      key: '',
      params: '',
      flags: Object.values(LLMFlags),
    },
  ]
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  vi.unstubAllGlobals()
  target.remove()
})

describe('CustomModelsSettings flags', () => {
  it('renders and edits every persisted model capability flag', async () => {
    component = mount(CustomModelsSettings, {
      target,
      props: { noAccordion: true },
    })

    const disclosure = buttonByLabel('All Flags')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(disclosure.querySelector('button')).toBeNull()
    disclosure.click()
    await tick()
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    const panel = document.getElementById(disclosure.getAttribute('aria-controls') ?? '')
    expect(panel?.getAttribute('role')).toBe('region')
    expect(panel?.getAttribute('aria-labelledby')).toBe(disclosure.id)
    buttonByText(language.flags).click()
    await tick()

    for (const [name, flag] of Object.entries(LLMFlags)) {
      const button = buttonByText(name)
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(customModelsDraft.value[0].flags).toContain(flag)
    }

    const xHighEffort = buttonByText('claudeXHighEffort')
    xHighEffort.click()
    await tick()
    expect(xHighEffort.getAttribute('aria-pressed')).toBe('false')
    expect(customModelsDraft.value[0].flags).not.toContain(LLMFlags.claudeXHighEffort)

    xHighEffort.click()
    await tick()
    expect(xHighEffort.getAttribute('aria-pressed')).toBe('true')
    expect(customModelsDraft.value[0].flags).toContain(LLMFlags.claudeXHighEffort)
  })

  it('names model move, remove, and add actions for their target', () => {
    component = mount(CustomModelsSettings, {
      target,
      props: { noAccordion: true },
    })

    expect(buttonByText(`${language.moveUp}: All Flags`)).toBeTruthy()
    expect(buttonByText(`${language.moveDown}: All Flags`)).toBeTruthy()
    expect(buttonByText(`${language.remove}: All Flags`)).toBeTruthy()
    expect(buttonByLabel(`${language.add}: ${language.customModels}`).type).toBe('button')
    expect(target.querySelector('button button')).toBeNull()
  })

  it('keeps a model until its removal is confirmed', async () => {
    component = mount(CustomModelsSettings, {
      target,
      props: { noAccordion: true },
    })

    const removeButton = buttonByText(`${language.remove}: All Flags`)
    removeButton.click()
    await tick()

    expect(confirmRemoval).toHaveBeenCalledWith(language.settingsItemRemovalConfirm)
    expect(customModelsDraft.value).toHaveLength(1)
    expect(target.textContent).toContain('All Flags')

    confirmRemoval.mockReturnValueOnce(true)
    removeButton.click()
    await tick()

    expect(customModelsDraft.value).toHaveLength(0)
    expect(target.textContent).not.toContain('All Flags')
  })
})
