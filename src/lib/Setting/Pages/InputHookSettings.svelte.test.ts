import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inputHookSettingsMocks = vi.hoisted(() => ({
  readInputHooks: () => [] as Array<Record<string, unknown>>,
  setInputHooks: (_hooks: Array<Record<string, unknown>>) => {},
  reportPersistence: (_status: 'idle' | 'saving' | 'accepted' | 'queued' | 'failed') => {},
  retryPersistence: vi.fn(),
}))

vi.mock('src/ts/server/settingsOwner.svelte', async () => {
  const { fromStore, writable } = await import('svelte/store')
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const hooks = writable<Array<Record<string, unknown>>>([])
  const reactiveHooks = fromStore(hooks)

  inputHookSettingsMocks.readInputHooks = () => reactiveHooks.current
  inputHookSettingsMocks.setInputHooks = (value) => hooks.set(clone(value))

  return {
    createServerBackedSettingDraft: (
      _key: string,
      _fallback: unknown,
      options: { onPersistenceStatus: typeof inputHookSettingsMocks.reportPersistence },
    ) => {
      inputHookSettingsMocks.reportPersistence = options.onPersistenceStatus
      return {
        get value() {
          return reactiveHooks.current
        },
        set value(value: Array<Record<string, unknown>>) {
          hooks.set(clone(value))
        },
        retryPersistence: inputHookSettingsMocks.retryPersistence,
      }
    },
  }
})

vi.mock('src/ts/process/templates/templates', () => ({
  prebuiltPresets: { OAI: { mainPrompt: '', jailbreak: '' } },
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModules: () => [],
  moduleUpdate: () => {},
}))

import { language } from 'src/lang'
import { replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'
import InputHookSettings from './InputHookSettings.svelte'
import { popUpEditorStore } from 'src/ts/stores.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function modelSelect(name: string): HTMLSelectElement {
  const select = target.querySelector<HTMLSelectElement>(`select[aria-label="${language.inputHookModel}: ${name}"]`)
  expect(select).toBeTruthy()
  return select!
}

function translationCheckbox(): HTMLInputElement | null {
  return target.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${language.inputHookTranslation}"]`)
}

beforeEach(() => {
  vi.useFakeTimers()
  inputHookSettingsMocks.retryPersistence.mockReset()
  popUpEditorStore.open = false
  inputHookSettingsMocks.setInputHooks([
    {
      id: 'legacy-hook',
      name: 'Legacy Hook',
      type: 'draft',
      prompt: 'Rewrite this.',
    },
  ])
  replaceResourceDatabase({
    modelProfiles: [
      { id: 'profile-a', name: 'Profile A', modelId: 'echo_model' },
      { id: 'profile-b', name: 'Profile B', modelId: 'echo_model' },
    ],
    modelProfileOrder: [
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'divider', id: 'divider-a' },
      { kind: 'profile', profileId: 'profile-b' },
    ],
  } as any)

  target = document.createElement('div')
  document.body.appendChild(target)
  component = mount(InputHookSettings, { target })
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  replaceResourceDatabase({} as any)
  target.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('InputHookSettings model profiles', () => {
  it('inherits for legacy hooks and persists a per-hook profile selection', async () => {
    const select = modelSelect('Legacy Hook')
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      language.inputHookInheritOtherAxModel,
      'Profile A',
      '---',
      'Profile B',
    ])
    expect(select.value).toBe('')

    const divider = select.querySelector<HTMLOptionElement>('[data-model-profile-divider="true"]')!
    select.value = divider.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(modelSelect('Legacy Hook').value).toBe('')
    expect(inputHookSettingsMocks.readInputHooks()[0].model).toBeUndefined()

    const refreshedSelect = modelSelect('Legacy Hook')
    refreshedSelect.value = 'profile-b'
    refreshedSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(inputHookSettingsMocks.readInputHooks()[0].model).toEqual({
      mode: 'modelProfile',
      profileId: 'profile-b',
    })

    modelSelect('Legacy Hook').value = ''
    modelSelect('Legacy Hook').dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(inputHookSettingsMocks.readInputHooks()[0].model).toEqual({ mode: 'inheritOtherAx' })
  })

  it('creates new hooks that inherit the Other Auxiliary model', async () => {
    target.querySelector<HTMLButtonElement>(`button[aria-label="${language.inputHookAdd}"]`)!.click()
    await tick()

    expect(inputHookSettingsMocks.readInputHooks().at(-1)).toMatchObject({
      model: { mode: 'inheritOtherAx' },
      translation: false,
    })
    const card = target.querySelector('article:last-child')!
    expect(card.querySelector('[data-risu-input-hook-toggle]')?.getAttribute('aria-expanded')).toBe('true')
    expect(card.querySelector('[data-risu-input-hook-prompt-toggle]')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(card.querySelector('input[type="text"]'))
  })

  it('shows and persists Translation only for Draft hooks', async () => {
    const checkbox = translationCheckbox()
    expect(checkbox).toBeTruthy()
    expect(checkbox!.checked).toBe(false)

    checkbox!.click()
    await tick()
    expect(inputHookSettingsMocks.readInputHooks()[0].translation).toBe(true)

    inputHookSettingsMocks.setInputHooks([
      {
        id: 'btw-hook',
        name: 'BTW Hook',
        type: 'btw',
        prompt: 'Answer this.',
        translation: true,
      },
    ])
    await tick()
    expect(translationCheckbox()).toBeNull()
  })
})

function hookCard(name: string): HTMLElement {
  const card = Array.from(target.querySelectorAll('article')).find((card) => card.getAttribute('aria-label') === name)
  if (!card) throw new Error(`Hook card not found: ${name}`)
  return card
}

function hookToggle(card: HTMLElement): HTMLButtonElement {
  return card.querySelector<HTMLButtonElement>('[data-risu-input-hook-toggle]')!
}

function promptToggle(card: HTMLElement): HTMLButtonElement {
  return card.querySelector<HTMLButtonElement>('[data-risu-input-hook-prompt-toggle]')!
}

describe('InputHookSettings editing', () => {
  it('pairs Draft and BTW names with outcomes and exposes the full prompt on focus or hover', async () => {
    inputHookSettingsMocks.setInputHooks([
      {
        id: 'draft-hook',
        name: 'Before-send editor',
        type: 'draft',
        prompt: 'First line\nSecond line with the complete instruction.',
        translation: true,
      },
      { id: 'btw-hook', name: 'On-demand helper', type: 'btw', prompt: 'Return a separate result.' },
    ])
    await tick()

    const draft = hookCard('Before-send editor')
    const btw = hookCard('On-demand helper')
    expect(draft.querySelector('[data-risu-hook-outcome]')?.textContent).toContain(
      language.inputHookSettings.draftOutcome,
    )
    expect(btw.querySelector('[data-risu-hook-outcome]')?.textContent).toContain(language.inputHookSettings.btwOutcome)
    const toggle = promptToggle(draft)
    expect(toggle.title).toBe('First line\nSecond line with the complete instruction.')
    expect(draft.querySelector('[data-risu-input-hook-full-prompt-preview]')?.textContent).toContain(
      'Second line with the complete instruction.',
    )
    expect(draft.querySelector('[data-risu-input-hook-translation-flow]')?.textContent).toContain(
      language.inputHookSettings.translationDescription,
    )
    expect(inputHookSettingsMocks.readInputHooks().map((hook) => hook.type)).toEqual(['draft', 'btw'])
  })

  it('keeps independent disclosures and edited prompts attached to hook IDs across list changes', async () => {
    inputHookSettingsMocks.setInputHooks([
      { id: 'first', name: 'First', type: 'draft', prompt: '<|im_start|>user\nRewrite this.' },
      { id: 'second', name: 'Second', type: 'btw', prompt: 'Check this.' },
    ])
    await tick()
    const first = hookCard('First')
    const second = hookCard('Second')
    const firstHookToggle = hookToggle(first)
    const secondHookToggle = hookToggle(second)
    const firstHookPanel = document.getElementById(firstHookToggle.getAttribute('aria-controls')!)!
    const secondHookPanel = document.getElementById(secondHookToggle.getAttribute('aria-controls')!)!
    expect(firstHookToggle.getAttribute('aria-expanded')).toBe('false')
    expect(secondHookToggle.getAttribute('aria-expanded')).toBe('false')
    expect(firstHookPanel.hidden).toBe(true)
    expect(secondHookPanel.hidden).toBe(true)

    firstHookToggle.click()
    await tick()
    expect(firstHookPanel.hidden).toBe(false)
    expect(secondHookPanel.hidden).toBe(true)
    firstHookToggle.click()
    await tick()
    expect(firstHookPanel.hidden).toBe(true)
    firstHookToggle.click()
    await tick()

    const firstPromptToggle = promptToggle(first)
    const panel = document.getElementById(firstPromptToggle.getAttribute('aria-controls')!)!
    expect(firstPromptToggle.getAttribute('aria-expanded')).toBe('false')
    expect(panel.hidden).toBe(true)
    expect(firstPromptToggle.textContent).toContain('Rewrite this.')
    expect(firstPromptToggle.textContent).not.toContain('<|im_start|>')

    firstPromptToggle.click()
    secondHookToggle.click()
    promptToggle(second).click()
    await tick()
    expect(panel.hidden).toBe(false)
    const editor = first.querySelector('textarea')!
    editor.value = 'Keep this new prompt.'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    firstPromptToggle.click()
    await tick()
    expect(panel.hidden).toBe(true)
    expect(promptToggle(hookCard('Second')).getAttribute('aria-expanded')).toBe('true')
    inputHookSettingsMocks.setInputHooks([...inputHookSettingsMocks.readInputHooks()].reverse())
    await tick()
    promptToggle(hookCard('First')).click()
    await tick()
    expect(hookCard('First').querySelector('textarea')).toBe(editor)
    expect(editor.value).toBe('Keep this new prompt.')
    expect(inputHookSettingsMocks.readInputHooks().find((hook) => hook.id === 'first')?.prompt).toBe(
      'Keep this new prompt.',
    )
  })

  it('commits the real popup editor to its hook after a preceding hook is removed', async () => {
    inputHookSettingsMocks.setInputHooks([
      { id: 'first', name: 'First', type: 'btw', prompt: 'First prompt' },
      { id: 'second', name: 'Second', type: 'btw', prompt: 'Second prompt' },
      { id: 'third', name: 'Third', type: 'btw', prompt: 'Third prompt' },
    ])
    await tick()
    const card = hookCard('Second')
    hookToggle(card).click()
    promptToggle(card).click()
    await tick()
    card.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`)!.click()
    expect(popUpEditorStore.open).toBe(true)
    expect(popUpEditorStore.value).toBe('Second prompt')
    popUpEditorStore.value = 'Edited in the popup'
    inputHookSettingsMocks.setInputHooks(inputHookSettingsMocks.readInputHooks().filter((hook) => hook.id !== 'first'))
    await tick()
    popUpEditorStore.open = false
    await vi.advanceTimersByTimeAsync(150)
    await tick()
    expect(inputHookSettingsMocks.readInputHooks().find((hook) => hook.id === 'second')?.prompt).toBe(
      'Edited in the popup',
    )
    expect(inputHookSettingsMocks.readInputHooks().find((hook) => hook.id === 'third')?.prompt).toBe('Third prompt')
    expect(hookCard('Second').querySelector('textarea')?.value).toBe('Edited in the popup')
  })

  it('does not apply a popup draft to another hook when its owner is removed', async () => {
    const card = hookCard('Legacy Hook')
    hookToggle(card).click()
    promptToggle(card).click()
    await tick()
    card.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`)!.click()
    popUpEditorStore.value = 'Removed hook edit'
    inputHookSettingsMocks.setInputHooks([{ id: 'replacement', name: 'Replacement', type: 'btw', prompt: 'Keep me' }])
    await tick()
    popUpEditorStore.open = false
    await vi.advanceTimersByTimeAsync(150)
    expect(inputHookSettingsMocks.readInputHooks()[0].prompt).toBe('Keep me')
  })

  it('names the hook in the delete confirmation and preserves it on cancel', async () => {
    const confirm = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirm)
    const card = hookCard('Legacy Hook')
    hookToggle(card).click()
    await tick()
    const remove = card.querySelector<HTMLButtonElement>(
      `button[aria-label="${language.inputHookDelete}: Legacy Hook"]`,
    )!
    remove.click()
    await tick()
    expect(confirm).toHaveBeenCalledWith(language.settingsItemRemovalConfirmNamed('Legacy Hook'))
    expect(inputHookSettingsMocks.readInputHooks()).toHaveLength(1)
    confirm.mockReturnValue(true)
    remove.click()
    await tick()
    expect(inputHookSettingsMocks.readInputHooks()).toEqual([])
    expect(target.textContent).toContain(language.inputHookSettings.empty)
    expect(document.activeElement).toBe(target.querySelector(`button[aria-label="${language.inputHookAdd}"]`))
  })

  it('shows queued and failed saves distinctly and retries without replacing edited text', async () => {
    const editor = hookCard('Legacy Hook').querySelector('textarea')!
    editor.value = 'Unsaved changes'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    inputHookSettingsMocks.reportPersistence('queued')
    await tick()
    expect(target.querySelector('[role="status"]')?.textContent).toContain(language.inputHookSettings.queued)
    inputHookSettingsMocks.reportPersistence('failed')
    await tick()
    const alert = target.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain(language.inputHookSettings.saveFailed)
    alert.querySelector<HTMLButtonElement>('button')!.click()
    expect(inputHookSettingsMocks.retryPersistence).toHaveBeenCalledTimes(1)
    expect(editor.value).toBe('Unsaved changes')
    inputHookSettingsMocks.reportPersistence('accepted')
    await tick()
    expect(target.querySelector('[role="status"]')?.textContent).toContain(language.inputHookSettings.saved)
  })

  it('announces saving before settlement and lets a newer edit survive an older accepted outcome', async () => {
    const editor = hookCard('Legacy Hook').querySelector('textarea')!
    editor.value = 'First pending edit'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    inputHookSettingsMocks.reportPersistence('saving')
    await tick()
    expect(target.querySelector('[role="status"]')?.textContent).toContain(language.inputHookSettings.saving)

    editor.value = 'Newer pending edit'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    inputHookSettingsMocks.reportPersistence('accepted')
    await tick()
    expect(editor.value).toBe('Newer pending edit')
    expect(inputHookSettingsMocks.readInputHooks()[0].prompt).toBe('Newer pending edit')
  })
})
