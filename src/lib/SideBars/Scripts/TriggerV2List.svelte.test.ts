import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const triggerAlertMocks = vi.hoisted(() => ({ alertError: vi.fn() }))

vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  createServerBackedSettingDraft: <T>(_key: string, fallback: T) => ({ value: fallback }),
}))

vi.mock('src/ts/process/triggers', () => ({
  displayAllowList: [],
  requestAllowList: [],
}))

vi.mock('src/ts/alert', () => triggerAlertMocks)

vi.mock('src/lib/UI/GUI/TextAreaInput.svelte', async () => {
  const mock = await import('../AuthorNoteEditor.testTextArea.svelte')
  return { default: mock.default }
})

vi.mock('src/lib/Others/Help.svelte', async () => {
  const mock = await import('../AuthorNoteEditor.testHelp.svelte')
  return { default: mock.default }
})

vi.mock('src/lib/UI/GUI/Portal.svelte', async () => {
  const mock = await import('./TriggerV2List.testPortal.svelte')
  return { default: mock.default }
})

import TriggerV2ListHarness from './TriggerV2List.testHarness.svelte'
import type { triggerscript } from 'src/ts/process/triggers'
import { language } from 'src/lang'
import { RISU_EFFECT_DRAG_TYPE, RISU_TRIGGER_DRAG_TYPE } from 'src/ts/dragTypes'
import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'

type MountedComponent = Parameters<typeof unmount>[0] & {
  getValue: () => triggerscript[]
  setEffectField: (triggerIndex: number, effectIndex: number, field: string, nextValue: string) => void
  replaceOwner: (ownerKey: string, value: triggerscript[]) => void
  replaceValue: (value: triggerscript[]) => void
  replaceTrigger: (triggerIndex: number, trigger: triggerscript) => void
  replaceEffects: (triggerIndex: number, effects: triggerscript['effect']) => void
  replaceEffect: (triggerIndex: number, effectIndex: number, effect: triggerscript['effect'][number]) => void
}
type XssTestGlobal = typeof globalThis & { triggerV2Xss?: boolean }

let target: HTMLElement
let component: MountedComponent | undefined
const defaultInnerWidth = window.innerWidth

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await tick()
    await Promise.resolve()
  }
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}

function triggerButton(name: string): HTMLButtonElement {
  const button = Array.from(target.querySelectorAll<HTMLButtonElement>('button.trigger-item')).find(
    (candidate) => candidate.textContent?.trim() === name,
  )
  if (!button) throw new Error(`Trigger button not found: ${name}`)
  return button
}

function triggerDropTarget(name: string, edge: 'before' | 'after'): HTMLElement {
  const row = triggerButton(name).parentElement
  const target = edge === 'before' ? row?.previousElementSibling : row?.nextElementSibling
  if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'listitem') {
    throw new Error(`Trigger ${edge} drop target not found: ${name}`)
  }
  return target
}

function effectDisplay(value: string): HTMLElement {
  const display = Array.from(target.querySelectorAll<HTMLElement>('[data-risu-trigger-effect-display="true"]')).find(
    (candidate) => candidate.textContent?.trim() === `// ${value}`,
  )
  if (!display) throw new Error(`Effect display not found: ${value}`)
  return display
}

function effectDragHandle(value: string): HTMLElement {
  const row = effectDisplay(value).closest('button')?.parentElement
  const handle = row?.querySelector<HTMLElement>('[draggable="true"]')
  if (!handle) throw new Error(`Effect drag handle not found: ${value}`)
  return handle
}

function effectEndDropTarget(value: string): HTMLElement {
  const row = effectDisplay(value).closest('button')?.parentElement
  const container = row?.parentElement
  const dropTargets = Array.from(container?.children ?? []).filter(
    (candidate): candidate is HTMLElement =>
      candidate instanceof HTMLElement && candidate.getAttribute('role') === 'listitem',
  )
  const dropTarget = dropTargets.at(-1)
  if (!dropTarget) throw new Error('Effect end drop target not found')
  return dropTarget
}

function effectValues(trigger: triggerscript): Array<string | undefined> {
  return trigger.effect.map((effect) => (effect as { value?: string }).value)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function createDragDataTransfer(initialTypes: string[] = []): DataTransfer {
  const values = new Map<string, string>()
  const types = [...initialTypes]
  return {
    get types() {
      return types
    },
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => {
      values.set(type, value)
      if (!types.includes(type)) types.push(type)
    },
    setDragImage: vi.fn(),
  } as unknown as DataTransfer
}

function dispatchDragEvent(
  element: Element,
  type: 'dragstart' | 'dragend' | 'drop',
  dataTransfer: DataTransfer,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  element.dispatchEvent(event)
  return event
}

async function openEditor(): Promise<void> {
  target.querySelector<HTMLButtonElement>('button')?.click()
  await settle()
}

beforeEach(() => {
  setViewportWidth(1024)
  delete (globalThis as XssTestGlobal).triggerV2Xss
  target = document.createElement('div')
  document.body.appendChild(target)
  triggerAlertMocks.alertError.mockReset()
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  document.body.innerHTML = ''
  setViewportWidth(defaultInnerWidth)
  delete (globalThis as XssTestGlobal).triggerV2Xss
  vi.clearAllMocks()
})

describe('TriggerV2List effect display', () => {
  it('marks persistent-data, command, and privileged effect options as unsupported on the server', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        lowLevelAble: true,
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { comment: 'Trigger', type: 'start', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await openEditor()

    const addEffect = document.querySelector<HTMLButtonElement>(`[aria-label="${language.add}: ${language.effect}"]`)
    addEffect?.click()
    addEffect?.click()
    await settle()

    const unsupportedOption = (type: string) =>
      document.querySelector<HTMLElement>(`[data-risu-server-unsupported-effect="${type}"]`)
    expect(unsupportedOption('v2Command')?.textContent).toContain(language.triggerEffectUnsupportedOnServer)

    const categoryButton = (category: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === language.triggerCategories[category],
      )
    categoryButton('Data')?.click()
    await settle()
    expect(unsupportedOption('v2SetCharacterDesc')?.textContent).toContain(language.triggerEffectUnsupportedOnServer)

    categoryButton('Low Level')?.click()
    await settle()
    expect(unsupportedOption('v2RunLLM')?.textContent).toContain(language.triggerEffectUnsupportedOnServer)
  })

  it('renders imported and edited effect text literally without creating executable elements', async () => {
    const commentPayload = '</span><img data-trigger-v2-comment-xss src=x onerror="globalThis.triggerV2Xss = true">'
    const variablePayload = '</span><svg data-trigger-v2-field-xss onload="globalThis.triggerV2Xss = true"></svg>'
    const value: triggerscript[] = [
      {
        comment: 'Header',
        type: 'manual',
        conditions: [],
        effect: [],
      },
      {
        comment: 'Imported trigger',
        type: 'manual',
        conditions: [],
        effect: [
          { type: 'v2Comment', value: commentPayload, indent: 0 },
          {
            type: 'v2SetVar',
            operator: '=',
            var: 'safeVariable',
            value: commentPayload,
            valueType: 'value',
            indent: 1,
          },
        ],
      },
    ]

    component = mount(TriggerV2ListHarness, {
      target,
      props: { initialValue: value },
    }) as MountedComponent
    await settle()

    const editButton = target.querySelector<HTMLButtonElement>('button')
    expect(editButton).toBeTruthy()
    editButton!.click()
    await settle()

    const displays = Array.from(document.querySelectorAll<HTMLElement>('[data-risu-trigger-effect-display="true"]'))
    expect(displays).toHaveLength(2)
    expect(displays[0].textContent).toBe(`// ${commentPayload}`)
    expect(displays[0].querySelector('.text-gray-400')?.textContent).toBe(commentPayload)
    expect(document.querySelector('[data-trigger-v2-comment-xss]')).toBeNull()

    component.setEffectField(1, 1, 'var', variablePayload)
    await settle()

    expect(displays[1].textContent).toBe(`Set Variable ${variablePayload} = "${commentPayload}"`)
    expect(displays[1].querySelector('.text-yellow-500')?.textContent).toBe(variablePayload)
    expect(displays[1].style.marginLeft).toBe('1rem')

    expect(document.querySelector('[data-trigger-v2-field-xss]')).toBeNull()
    expect((globalThis as XssTestGlobal).triggerV2Xss).toBeUndefined()
  })

  it('names icon actions and exposes trigger, effect, and category selection', async () => {
    const value: triggerscript[] = [
      { comment: 'Header', type: 'manual', conditions: [], effect: [] },
      {
        comment: 'Alpha',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2Comment', value: 'Alpha effect', indent: 0 }],
      },
      { comment: 'Beta', type: 'manual', conditions: [], effect: [] },
    ]
    component = mount(TriggerV2ListHarness, {
      target,
      props: { initialValue: value },
    }) as MountedComponent
    await settle()

    target.querySelector<HTMLButtonElement>('button')?.click()
    await settle()

    const buttonByText = (text: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === text,
      )
    const alpha = buttonByText('Alpha')
    const beta = buttonByText('Beta')
    expect(alpha?.getAttribute('aria-pressed')).toBe('true')
    expect(beta?.getAttribute('aria-pressed')).toBe('false')
    beta?.click()
    await settle()
    expect(alpha?.getAttribute('aria-pressed')).toBe('false')
    expect(beta?.getAttribute('aria-pressed')).toBe('true')

    alpha?.click()
    await settle()
    const effect = document.querySelector<HTMLElement>('[data-risu-trigger-effect-display="true"]')?.closest('button')
    expect(effect?.getAttribute('aria-pressed')).toBe('false')
    effect?.click()
    await settle()
    expect(effect?.getAttribute('aria-pressed')).toBe('true')

    expect(document.querySelector(`[aria-label="${language.add}: ${language.trigger}"]`)).toBeTruthy()
    expect(document.querySelector(`[aria-label="${language.export}: ${language.trigger}"]`)).toBeTruthy()
    expect(document.querySelector(`[aria-label="${language.import}: ${language.trigger}"]`)).toBeTruthy()

    const addEffect = document.querySelector<HTMLButtonElement>(`[aria-label="${language.add}: ${language.effect}"]`)
    expect(addEffect).toBeTruthy()
    addEffect?.click()
    addEffect?.click()
    await settle()

    expect(document.querySelector(`[aria-label="${language.goback}"]`)).toBeTruthy()
    expect(buttonByText(language.triggerCategories.Control)?.getAttribute('aria-pressed')).toBe('true')
  })

  it('clears a multi-selection when the trigger owner changes', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header A', type: 'manual', conditions: [], effect: [] },
          { comment: 'Alpha A', type: 'manual', conditions: [], effect: [] },
          { comment: 'Beta A', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await settle()
    target.querySelector<HTMLButtonElement>('button')?.click()
    await settle()

    const buttonByText = (text: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === text,
      )
    buttonByText('Alpha A')?.click()
    buttonByText('Beta A')?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await settle()
    expect(buttonByText('Alpha A')?.getAttribute('aria-pressed')).toBe('true')
    expect(buttonByText('Beta A')?.getAttribute('aria-pressed')).toBe('true')

    component.replaceOwner('owner-b', [
      { comment: 'Header B', type: 'manual', conditions: [], effect: [] },
      { comment: 'Alpha B', type: 'manual', conditions: [], effect: [] },
      { comment: 'Beta B', type: 'manual', conditions: [], effect: [] },
    ])
    await settle()

    expect(buttonByText('Alpha A')).toBeUndefined()
    expect(buttonByText('Beta A')).toBeUndefined()
    expect(buttonByText('Alpha B')).toBeUndefined()
    expect(buttonByText('Beta B')).toBeUndefined()
    expect(target.textContent).toContain(language.edit)
  })

  it('does not append a deferred trigger import after the owner changes', async () => {
    const fileText = deferred<string>()
    const file = { text: vi.fn(() => fileText.promise) } as unknown as File
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] })
      this.dispatchEvent(new Event('change', { bubbles: true }))
    })
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header A', type: 'manual', conditions: [], effect: [] },
          { comment: 'Alpha A', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await openEditor()

    document.querySelector<HTMLButtonElement>(`[aria-label="${language.import}: ${language.trigger}"]`)?.click()
    inputClick.mockRestore()
    await settle()
    expect(file.text).toHaveBeenCalledOnce()

    component.replaceOwner('owner-b', [
      { comment: 'Header B', type: 'manual', conditions: [], effect: [] },
      { comment: 'Alpha B', type: 'manual', conditions: [], effect: [] },
    ])
    await settle()

    fileText.resolve(
      JSON.stringify([{ comment: 'Imported A', type: 'manual', conditions: [], effect: [] } satisfies triggerscript]),
    )
    await settle()

    expect(component.getValue().map((trigger) => trigger.comment)).toEqual(['Header B', 'Alpha B'])
  })

  it('preserves imports and reports only definitions still unsupported by the server', async () => {
    const imported: triggerscript[] = [
      {
        comment: 'Imported unsupported definitions',
        type: 'start',
        conditions: [],
        effect: [
          {
            type: 'v2SetCharacterDesc',
            value: 'must not persist',
            valueType: 'value',
            indent: 0,
          },
          {
            type: 'v2SystemPrompt',
            value: 'height={{screen_height}}',
            valueType: 'value',
            location: 'promptend',
            indent: 0,
          },
        ],
      },
    ]
    const file = { text: vi.fn(async () => JSON.stringify(imported)) } as unknown as File
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] })
      this.dispatchEvent(new Event('change', { bubbles: true }))
    })
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { comment: 'Existing', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await openEditor()

    document.querySelector<HTMLButtonElement>(`[aria-label="${language.import}: ${language.trigger}"]`)?.click()
    await vi.waitFor(() => expect(file.text).toHaveBeenCalledOnce())
    inputClick.mockRestore()
    await vi.waitFor(() => expect(component?.getValue()).toHaveLength(3))

    expect(component.getValue()[2]).toEqual(imported[0])
    expect(triggerAlertMocks.alertError).toHaveBeenCalledWith(
      language.triggerImportUnsupportedDiagnostic(['v2SetCharacterDesc'], []),
    )
    expect(target.querySelector('[data-risu-server-compatibility-diagnostic]')?.textContent).toContain(
      'v2SetCharacterDesc',
    )
    expect(target.querySelector('[data-risu-server-compatibility-diagnostic]')?.textContent).not.toContain(
      'screenheight',
    )
  })

  it('renders array insertion fields without null or malformed placeholders', async () => {
    const value: triggerscript[] = [
      { comment: 'Header', type: 'manual', conditions: [], effect: [] },
      {
        comment: 'Array edits',
        type: 'manual',
        conditions: [],
        effect: [
          {
            type: 'v2UnshiftArrayVar',
            var: 'queue',
            value: 'first',
            valueType: 'value',
            indent: 0,
          },
          {
            type: 'v2SpliceArrayVar',
            var: 'queue',
            start: '2',
            startType: 'value',
            item: 'middle',
            itemType: 'value',
            indent: 0,
          },
        ],
      },
    ]
    component = mount(TriggerV2ListHarness, { target, props: { initialValue: value } }) as MountedComponent
    await settle()

    target.querySelector<HTMLButtonElement>('button')?.click()
    await settle()

    const summaries = Array.from(
      document.querySelectorAll<HTMLElement>('[data-risu-trigger-effect-display="true"]'),
      (display) => display.textContent ?? '',
    )
    expect(summaries).toEqual([
      'Add "first" as first value of Array Variable queue',
      'Add "middle" as "2" value of Array Variable queue',
    ])
    expect(summaries.join(' ')).not.toMatch(/null|{{|}}/)
  })

  it('leaves native editable-control shortcuts untouched', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
          { comment: 'Beta', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    const nameInput = target.querySelector<HTMLInputElement>('input[type="text"]')
    const triggerTypeSelect = target.querySelector<HTMLSelectElement>('select')
    expect(nameInput).toBeTruthy()
    expect(triggerTypeSelect).toBeTruthy()

    const textarea = document.createElement('textarea')
    const contenteditable = document.createElement('div')
    contenteditable.setAttribute('contenteditable', 'true')
    target.append(textarea, contenteditable)

    for (const editable of [nameInput!, triggerTypeSelect!, textarea, contenteditable]) {
      editable.focus()
      const paste = new KeyboardEvent('keydown', {
        key: 'v',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      editable.dispatchEvent(paste)
      expect(paste.defaultPrevented).toBe(false)

      const arrow = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
        cancelable: true,
      })
      editable.dispatchEvent(arrow)
      expect(arrow.defaultPrevented).toBe(false)
    }

    expect(component.getValue().map((trigger) => trigger.comment)).toEqual(['Header', 'Alpha', 'Beta'])
  })

  it('owns focus above a responsive modal and closes with Escape from an editable field', async () => {
    setViewportWidth(767)
    const appRoot = document.createElement('div')
    const background = document.createElement('main')
    const backgroundButton = document.createElement('button')
    const responsiveRoot = document.createElement('div')
    const responsiveDialog = document.createElement('div')
    background.append(backgroundButton)
    responsiveRoot.dataset.modalRoot = ''
    responsiveDialog.tabIndex = -1
    responsiveDialog.append(target)
    responsiveRoot.append(responsiveDialog)
    appRoot.append(background, responsiveRoot)
    document.body.append(appRoot)

    const responsiveTrap = modalFocusTrap(responsiveDialog)
    try {
      component = mount(TriggerV2ListHarness, {
        target,
        props: {
          initialValue: [
            { comment: 'Header', type: 'manual', conditions: [], effect: [] },
            { comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
          ],
        },
      }) as MountedComponent
      await settle()

      const editButton = target.querySelector<HTMLButtonElement>('button')!
      editButton.focus()
      editButton.click()
      await settle()

      const triggerDialog = target.querySelector<HTMLElement>('[data-risu-trigger-v2-dialog]')
      expect(triggerDialog).toBeTruthy()
      expect(triggerDialog?.getAttribute('role')).toBe('dialog')
      expect(triggerDialog?.getAttribute('aria-modal')).toBe('true')
      expect(triggerDialog?.getAttribute('aria-label')).toBe(language.triggerScript)
      expect(triggerDialog?.inert).toBe(false)
      expect(triggerDialog?.contains(document.activeElement)).toBe(true)
      expect(background.inert).toBe(true)

      const nameInput = triggerDialog?.querySelector<HTMLInputElement>('input[type="text"]')
      expect(nameInput).toBeTruthy()
      nameInput?.focus()
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      nameInput?.dispatchEvent(escape)
      await settle()

      expect(escape.defaultPrevented).toBe(true)
      expect(target.querySelector('[data-risu-trigger-v2-dialog]')).toBeNull()
      expect(document.activeElement).toBe(editButton)
      expect(background.inert).toBe(true)
    } finally {
      responsiveTrap.destroy()
    }
  })

  it('keeps a selected trigger identity when an unselected row is dragged across it', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
          { comment: 'Beta', type: 'manual', conditions: [], effect: [] },
          { comment: 'Gamma', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    triggerButton('Alpha').click()
    const dataTransfer = createDragDataTransfer()
    dispatchDragEvent(triggerButton('Gamma'), 'dragstart', dataTransfer)
    const firstDropTarget = target.querySelector<HTMLElement>('[role="listitem"]')
    expect(firstDropTarget).toBeTruthy()
    dispatchDragEvent(firstDropTarget!, 'drop', dataTransfer)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await settle()

    expect(component.getValue().map((trigger) => trigger.comment)).toEqual(['Header', 'Gamma', 'Alpha', 'Beta'])
    expect(triggerButton('Alpha').getAttribute('aria-pressed')).toBe('true')
    expect(triggerButton('Gamma').getAttribute('aria-pressed')).toBe('false')

    triggerButton('Alpha').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    triggerButton('Alpha').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    await settle()

    expect(component.getValue().map((trigger) => trigger.comment)).toEqual([
      'Header',
      'Gamma',
      'Alpha',
      'Alpha',
      'Beta',
    ])
  })

  it('scopes trigger and effect drags and leaves external file drops unconsumed', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          {
            comment: 'Alpha',
            type: 'manual',
            conditions: [],
            effect: [{ type: 'v2Comment', value: 'One', indent: 0 }],
          },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    const triggerTransfer = createDragDataTransfer()
    dispatchDragEvent(triggerButton('Alpha'), 'dragstart', triggerTransfer)
    expect(Array.from(triggerTransfer.types)).toContain(RISU_TRIGGER_DRAG_TYPE)
    dispatchDragEvent(triggerButton('Alpha'), 'dragend', triggerTransfer)

    triggerButton('Alpha').click()
    await settle()
    const effectHandle = effectDragHandle('One')
    const effectTransfer = createDragDataTransfer()
    dispatchDragEvent(effectHandle, 'dragstart', effectTransfer)
    expect(Array.from(effectTransfer.types)).toContain(RISU_EFFECT_DRAG_TYPE)
    dispatchDragEvent(effectHandle, 'dragend', effectTransfer)

    const dropTarget = target.querySelector<HTMLElement>('[role="listitem"]')
    expect(dropTarget).toBeTruthy()
    const externalDrop = dispatchDragEvent(dropTarget!, 'drop', createDragDataTransfer(['Files']))

    expect(externalDrop.defaultPrevented).toBe(false)
  })

  it('rebases a multi-selection and its shift-selection anchor after an unselected drag', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
          { comment: 'Beta', type: 'manual', conditions: [], effect: [] },
          { comment: 'Gamma', type: 'manual', conditions: [], effect: [] },
          { comment: 'Delta', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    triggerButton('Alpha').click()
    triggerButton('Beta').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))

    const dataTransfer = createDragDataTransfer()
    dispatchDragEvent(triggerButton('Gamma'), 'dragstart', dataTransfer)
    dispatchDragEvent(target.querySelector<HTMLElement>('[role="listitem"]')!, 'drop', dataTransfer)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await settle()

    expect(triggerButton('Gamma').getAttribute('aria-pressed')).toBe('false')
    expect(triggerButton('Alpha').getAttribute('aria-pressed')).toBe('true')
    expect(triggerButton('Beta').getAttribute('aria-pressed')).toBe('true')

    triggerButton('Delta').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await settle()

    expect(triggerButton('Gamma').getAttribute('aria-pressed')).toBe('false')
    expect(triggerButton('Alpha').getAttribute('aria-pressed')).toBe('true')
    expect(triggerButton('Beta').getAttribute('aria-pressed')).toBe('true')
    expect(triggerButton('Delta').getAttribute('aria-pressed')).toBe('true')
  })

  it('moves the dragged trigger by stable ID after a live list reorder replaces every row', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { id: 'header', comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { id: 'alpha', comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
          { id: 'beta', comment: 'Beta', type: 'manual', conditions: [], effect: [] },
          { id: 'gamma', comment: 'Gamma', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    const dataTransfer = createDragDataTransfer()
    dispatchDragEvent(triggerButton('Gamma'), 'dragstart', dataTransfer)
    component.replaceValue([
      { id: 'header', comment: 'Header', type: 'manual', conditions: [], effect: [] },
      { id: 'gamma', comment: 'Gamma', type: 'manual', conditions: [], effect: [] },
      { id: 'alpha', comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
      { id: 'beta', comment: 'Beta', type: 'manual', conditions: [], effect: [] },
    ])
    await settle()

    dispatchDragEvent(triggerDropTarget('Beta', 'after'), 'drop', dataTransfer)
    await settle()

    expect(component.getValue().map((trigger) => trigger.comment)).toEqual(['Header', 'Alpha', 'Beta', 'Gamma'])
  })

  it('rebases every selected trigger before a multi-row drop after a live list reorder', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { id: 'header', comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { id: 'alpha', comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
          { id: 'beta', comment: 'Beta', type: 'manual', conditions: [], effect: [] },
          { id: 'gamma', comment: 'Gamma', type: 'manual', conditions: [], effect: [] },
          { id: 'delta', comment: 'Delta', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    triggerButton('Alpha').click()
    triggerButton('Beta').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    const dataTransfer = createDragDataTransfer()
    dispatchDragEvent(triggerButton('Beta'), 'dragstart', dataTransfer)
    component.replaceValue([
      { id: 'header', comment: 'Header', type: 'manual', conditions: [], effect: [] },
      { id: 'gamma', comment: 'Gamma', type: 'manual', conditions: [], effect: [] },
      { id: 'delta', comment: 'Delta', type: 'manual', conditions: [], effect: [] },
      { id: 'alpha', comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
      { id: 'beta', comment: 'Beta', type: 'manual', conditions: [], effect: [] },
    ])
    await settle()

    dispatchDragEvent(triggerDropTarget('Gamma', 'before'), 'drop', dataTransfer)
    await settle()

    expect(component.getValue().map((trigger) => trigger.comment)).toEqual([
      'Header',
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ])
    expect(triggerButton('Alpha').getAttribute('aria-pressed')).toBe('true')
    expect(triggerButton('Beta').getAttribute('aria-pressed')).toBe('true')
    expect(triggerButton('Gamma').getAttribute('aria-pressed')).toBe('false')
    expect(triggerButton('Delta').getAttribute('aria-pressed')).toBe('false')
  })

  it('cancels a trigger drop when the originally dragged trigger disappeared', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { id: 'header', comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { id: 'alpha', comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
          { id: 'beta', comment: 'Beta', type: 'manual', conditions: [], effect: [] },
          { id: 'gamma', comment: 'Gamma', type: 'manual', conditions: [], effect: [] },
          { id: 'delta', comment: 'Delta', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    const dataTransfer = createDragDataTransfer()
    dispatchDragEvent(triggerButton('Beta'), 'dragstart', dataTransfer)
    component.replaceValue([
      { id: 'header', comment: 'Header', type: 'manual', conditions: [], effect: [] },
      { id: 'alpha', comment: 'Alpha', type: 'manual', conditions: [], effect: [] },
      { id: 'gamma', comment: 'Gamma', type: 'manual', conditions: [], effect: [] },
      { id: 'delta', comment: 'Delta', type: 'manual', conditions: [], effect: [] },
    ])
    await settle()

    dispatchDragEvent(triggerDropTarget('Alpha', 'before'), 'drop', dataTransfer)
    await settle()

    expect(component.getValue().map((trigger) => trigger.comment)).toEqual(['Header', 'Alpha', 'Gamma', 'Delta'])
  })

  it('cancels an effect drop when its owning trigger was replaced', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { id: 'header', comment: 'Header', type: 'manual', conditions: [], effect: [] },
          {
            id: 'alpha',
            comment: 'Alpha',
            type: 'manual',
            conditions: [],
            effect: [
              { type: 'v2Comment', value: 'One', indent: 0 },
              { type: 'v2Comment', value: 'Two', indent: 0 },
              { type: 'v2Comment', value: 'Three', indent: 0 },
            ],
          },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    const dataTransfer = createDragDataTransfer()
    dispatchDragEvent(effectDragHandle('Two'), 'dragstart', dataTransfer)
    component.replaceTrigger(1, {
      id: 'alpha',
      comment: 'Alpha',
      type: 'manual',
      conditions: [],
      effect: [
        { type: 'v2Comment', value: 'One', indent: 0 },
        { type: 'v2Comment', value: 'Two', indent: 0 },
        { type: 'v2Comment', value: 'Three', indent: 0 },
      ],
    })
    await settle()

    dispatchDragEvent(effectEndDropTarget('Three'), 'drop', dataTransfer)
    await settle()

    expect(effectValues(component.getValue()[1])).toEqual(['One', 'Two', 'Three'])
  })

  it('cancels an effect drop when the effect array generation was replaced', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          {
            comment: 'Alpha',
            type: 'manual',
            conditions: [],
            effect: [
              { type: 'v2Comment', value: 'One', indent: 0 },
              { type: 'v2Comment', value: 'Two', indent: 0 },
              { type: 'v2Comment', value: 'Three', indent: 0 },
            ],
          },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    const dataTransfer = createDragDataTransfer()
    dispatchDragEvent(effectDragHandle('Two'), 'dragstart', dataTransfer)
    component.replaceEffects(1, [
      { type: 'v2Comment', value: 'One', indent: 0 },
      { type: 'v2Comment', value: 'Two', indent: 0 },
      { type: 'v2Comment', value: 'Three', indent: 0 },
    ])
    await settle()

    dispatchDragEvent(effectEndDropTarget('Three'), 'drop', dataTransfer)
    await settle()

    expect(effectValues(component.getValue()[1])).toEqual(['One', 'Two', 'Three'])
  })

  it('cancels an effect drop when the originally dragged effect object was replaced', async () => {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          {
            comment: 'Alpha',
            type: 'manual',
            conditions: [],
            effect: [
              { type: 'v2Comment', value: 'One', indent: 0 },
              { type: 'v2Comment', value: 'Two', indent: 0 },
              { type: 'v2Comment', value: 'Three', indent: 0 },
            ],
          },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    const dataTransfer = createDragDataTransfer()
    dispatchDragEvent(effectDragHandle('Two'), 'dragstart', dataTransfer)
    component.replaceEffect(1, 1, { type: 'v2Comment', value: 'Two', indent: 0 })
    await settle()

    dispatchDragEvent(effectEndDropTarget('Three'), 'drop', dataTransfer)
    await settle()

    expect(effectValues(component.getValue()[1])).toEqual(['One', 'Two', 'Three'])
  })

  it('provides operable mobile move controls for triggers and their effects', async () => {
    setViewportWidth(767)
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialValue: [
          { comment: 'Header', type: 'manual', conditions: [], effect: [] },
          {
            comment: 'Alpha',
            type: 'manual',
            conditions: [],
            effect: [
              { type: 'v2Comment', value: 'One', indent: 0 },
              { type: 'v2Comment', value: 'Two', indent: 0 },
            ],
          },
          { comment: 'Beta', type: 'manual', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await settle()
    await openEditor()

    const alphaUp = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.moveUp}: Alpha"]`)
    const alphaDown = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.moveDown}: Alpha"]`)
    const betaDown = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.moveDown}: Beta"]`)
    expect(alphaUp?.disabled).toBe(true)
    expect(alphaDown?.disabled).toBe(false)
    expect(betaDown?.disabled).toBe(true)

    alphaDown?.click()
    await settle()
    expect(component.getValue().map((trigger) => trigger.comment)).toEqual(['Header', 'Beta', 'Alpha'])

    const firstEffectUp = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.moveUp}: // One"]`)
    const firstEffectDown = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.moveDown}: // One"]`)
    const lastEffectDown = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.moveDown}: // Two"]`)
    expect(firstEffectUp?.disabled).toBe(true)
    expect(firstEffectDown?.disabled).toBe(false)
    expect(lastEffectDown?.disabled).toBe(true)

    firstEffectDown?.click()
    await settle()
    expect(component.getValue()[2].effect.map((effect) => (effect as { value?: string }).value)).toEqual(['Two', 'One'])
  })
})

it('captures an unpublished new trigger effect before demotion destroys its modal', async () => {
  await beginWriterDraftCaptureTest()
  try {
    component = mount(TriggerV2ListHarness, {
      target,
      props: {
        initialOwnerKey: 'character:char-a',
        initialValue: [
          { id: 'header', comment: 'Header', type: 'manual', conditions: [], effect: [] },
          { id: 'trigger-a', comment: 'Draft trigger', type: 'start', conditions: [], effect: [] },
        ],
      },
    }) as MountedComponent
    await openEditor()
    const addEffect = document.querySelector<HTMLButtonElement>(`[aria-label="${language.add}: ${language.effect}"]`)!
    addEffect.click()
    addEffect.click()
    await settle()
    const commentOption = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === language.triggerDesc.v2Comment,
    )!
    expect(commentOption).toBeTruthy()
    commentOption.click()
    await settle()
    const editor = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox]), textarea'),
    ].at(-1)!
    expect(editor).toBeTruthy()
    editor.value = 'unpublished effect draft'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(component.getValue()[1].effect).toHaveLength(0)
    expect(capturedWriterDrafts()).toEqual([
      expect.objectContaining({
        key: 'trigger-effect:character:char-a:trigger-a:new',
        data: {
          effect: expect.objectContaining({ type: 'v2Comment', value: 'unpublished effect draft' }),
          addElse: false,
        },
      }),
    ])
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
