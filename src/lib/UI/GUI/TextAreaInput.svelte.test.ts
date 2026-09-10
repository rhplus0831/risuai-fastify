import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

import TextAreaInput from './TextAreaInput.svelte'
import TextAreaInputTestHost from './TextAreaInput.testHost.svelte'
import { disableHighlight, popUpEditorStore } from 'src/ts/stores.svelte'
import { textAreaSize } from 'src/ts/gui/guisize'
import { replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function textarea(): HTMLTextAreaElement {
  const element = target.querySelector('textarea')
  if (!element) throw new Error('textarea not found')
  return element
}

function highlightedEditor(): HTMLDivElement {
  const element = target.querySelector<HTMLDivElement>('[contenteditable="true"]')
  if (!element) throw new Error('highlighted editor not found')
  return element
}

function autocompleteSuggestion(label: string): HTMLButtonElement | null {
  return Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.trim() === label) ?? null
}

async function openAutocomplete(
  onAncestorKeydown?: (event: KeyboardEvent) => void,
  initialValue = '{{cha',
  autocompleteOptions: readonly string[] = [],
): Promise<HTMLDivElement> {
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 10, y: 10 }))
  component = onAncestorKeydown
    ? mount(TextAreaInputTestHost, {
        target,
        props: {
          initialContext: 'autocomplete-owner',
          initialValue,
          highlight: true,
          popupEditor: false,
          onAncestorKeydown,
        },
      })
    : mount(TextAreaInput, {
        target,
        props: {
          value: initialValue,
          highlight: true,
          popupEditor: false,
          autocompleteOptions,
        },
      })
  await tick()

  const editor = highlightedEditor()
  editor.focus()
  const textNode = editor.firstChild
  if (!textNode) throw new Error('highlighted editor text node not found')
  const selection = window.getSelection()
  if (!selection) throw new Error('document selection unavailable')
  const range = document.createRange()
  range.setStart(textNode, textNode.textContent?.length ?? 0)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  editor.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  return editor
}

function seedDatabase(overrides: Record<string, unknown> = {}) {
  replaceResourceDatabase({
    hotkeys: [{ action: 'popupEditor', key: 'e', ctrl: true }],
    longPressToPopupEditor: false,
    ...overrides,
  } as any)
}

beforeEach(() => {
  vi.useFakeTimers()
  target = document.createElement('div')
  document.body.appendChild(target)
  seedDatabase()
  popUpEditorStore.open = false
  popUpEditorStore.value = ''
  popUpEditorStore.language = 'markdown'
  textAreaSize.set(0)
  disableHighlight.set(false)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  replaceResourceDatabase({} as any)
  popUpEditorStore.open = false
  popUpEditorStore.value = ''
  textAreaSize.set(0)
  disableHighlight.set(true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TextAreaInput popup editor finalization', () => {
  it('inserts into the plain editor caret and refuses stale post-unmount insertion', async () => {
    const onInput = vi.fn()
    component = mount(TextAreaInput, {
      target,
      props: { value: 'AlphaBeta', popupEditor: false, onInput },
    })
    await tick()
    const editor = textarea()
    editor.setSelectionRange(5, 5)
    const api = component as unknown as {
      insertAtCaret: (text: string) => Promise<boolean>
    }

    await expect(api.insertAtCaret(' ')).resolves.toBe(true)
    expect(editor.value).toBe('Alpha Beta')
    expect(editor.selectionStart).toBe(6)
    expect(document.activeElement).toBe(editor)
    expect(onInput).toHaveBeenLastCalledWith('Alpha Beta')

    unmount(component)
    component = undefined
    await expect(api.insertAtCaret('stale')).resolves.toBe(false)
    expect(onInput).toHaveBeenCalledTimes(1)
  })

  it('does not commit a newer popup session into an earlier field', async () => {
    const firstTarget = document.createElement('div')
    const secondTarget = document.createElement('div')
    target.append(firstTarget, secondTarget)
    const firstOnInput = vi.fn()
    const firstOnchange = vi.fn()
    const secondOnInput = vi.fn()
    const secondOnchange = vi.fn()
    const firstComponent = mount(TextAreaInput, {
      target: firstTarget,
      props: { value: 'first field', onInput: firstOnInput, onchange: firstOnchange },
    })
    const secondComponent = mount(TextAreaInput, {
      target: secondTarget,
      props: { value: 'second field', onInput: secondOnInput, onchange: secondOnchange },
    })

    try {
      firstTarget.querySelector<HTMLButtonElement>('button[aria-label]')?.click()
      await tick()
      const firstSessionId = popUpEditorStore.sessionId

      popUpEditorStore.value = 'edited first field'
      popUpEditorStore.open = false
      secondTarget.querySelector<HTMLButtonElement>('button[aria-label]')?.click()
      await tick()

      expect(popUpEditorStore.sessionId).not.toBe(firstSessionId)
      popUpEditorStore.value = 'edited second field'
      popUpEditorStore.open = false
      await vi.advanceTimersByTimeAsync(100)
      await tick()

      expect(firstOnInput).not.toHaveBeenCalled()
      expect(firstOnchange).not.toHaveBeenCalled()
      expect(secondOnInput).toHaveBeenCalledOnce()
      expect(secondOnInput).toHaveBeenCalledWith('edited second field', undefined)
      expect(secondOnchange).toHaveBeenCalledOnce()
    } finally {
      unmount(firstComponent)
      unmount(secondComponent)
    }
  })

  it('calls onchange after committing a hotkey popup edit', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    component = mount(TextAreaInput, {
      target,
      props: {
        value: 'before',
        onInput,
        onchange,
      },
    })

    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }))
    await tick()

    expect(popUpEditorStore.open).toBe(true)
    popUpEditorStore.value = 'after'
    popUpEditorStore.open = false
    await vi.advanceTimersByTimeAsync(100)
    await tick()

    expect(onInput).toHaveBeenCalledOnce()
    expect(onchange).toHaveBeenCalledOnce()
  })

  it('calls onchange after committing a context-menu popup edit', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    seedDatabase({ longPressToPopupEditor: true })
    component = mount(TextAreaInput, {
      target,
      props: {
        value: 'before',
        onInput,
        onchange,
      },
    })

    textarea().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()

    expect(popUpEditorStore.open).toBe(true)
    popUpEditorStore.value = 'after'
    popUpEditorStore.open = false
    await vi.advanceTimersByTimeAsync(100)
    await tick()

    expect(onInput).toHaveBeenCalledOnce()
    expect(onchange).toHaveBeenCalledOnce()
  })

  it('keeps compact fixed-height textareas out of the popup editor by default', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    seedDatabase({ longPressToPopupEditor: true })
    component = mount(TextAreaInput, {
      target,
      props: {
        value: 'before',
        height: '20',
        onInput,
        onchange,
      },
    })

    expect(target.querySelector('button[aria-label]')).toBeNull()

    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }))
    await tick()
    expect(popUpEditorStore.open).toBe(false)

    textarea().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()
    expect(popUpEditorStore.open).toBe(false)
    expect(onInput).not.toHaveBeenCalled()
    expect(onchange).not.toHaveBeenCalled()
  })

  it('keeps default-height textareas out of the popup editor when the global size is compact', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    seedDatabase({ longPressToPopupEditor: true })
    textAreaSize.set(-3)
    component = mount(TextAreaInput, {
      target,
      props: {
        value: 'before',
        onInput,
        onchange,
      },
    })

    expect(target.querySelector('button[aria-label]')).toBeNull()

    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }))
    await tick()
    expect(popUpEditorStore.open).toBe(false)

    textarea().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()
    expect(popUpEditorStore.open).toBe(false)
    expect(onInput).not.toHaveBeenCalled()
    expect(onchange).not.toHaveBeenCalled()
  })

  it('allows explicit large fixed-height textareas to use the popup editor', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    component = mount(TextAreaInput, {
      target,
      props: {
        value: 'before',
        height: '32',
        onInput,
        onchange,
      },
    })

    target.querySelector<HTMLButtonElement>('button[aria-label]')?.click()
    await tick()

    expect(popUpEditorStore.open).toBe(true)
    popUpEditorStore.value = 'after'
    popUpEditorStore.open = false
    await vi.advanceTimersByTimeAsync(100)
    await tick()

    expect(onInput).toHaveBeenCalledOnce()
    expect(onchange).toHaveBeenCalledOnce()
  })

  it('discards a delayed popup edit after the bound target changes, even when its value is unchanged', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    component = mount(TextAreaInputTestHost, {
      target,
      props: {
        initialContext: 'chat-a',
        initialValue: 'same note',
        onInput,
        onchange,
      },
    })

    target.querySelector<HTMLButtonElement>('button[aria-label]')?.click()
    await tick()
    expect(popUpEditorStore.open).toBe(true)

    popUpEditorStore.value = 'stale chat-a edit'
    ;(component as unknown as { replaceTarget: (context: string, value: string) => void }).replaceTarget(
      'chat-b',
      'same note',
    )
    await tick()
    await vi.advanceTimersByTimeAsync(100)
    await tick()

    expect(popUpEditorStore.open).toBe(false)
    expect((component as unknown as { getValue: () => string }).getValue()).toBe('same note')
    expect(onInput).not.toHaveBeenCalled()
    expect(onchange).not.toHaveBeenCalled()
  })

  it('discards a delayed popup edit after the input is unmounted', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    component = mount(TextAreaInput, {
      target,
      props: {
        value: 'before',
        onInput,
        onchange,
      },
    })

    target.querySelector<HTMLButtonElement>('button[aria-label]')?.click()
    await tick()
    expect(popUpEditorStore.open).toBe(true)

    popUpEditorStore.value = 'stale edit after close'
    unmount(component)
    component = undefined
    popUpEditorStore.open = false
    await vi.advanceTimersByTimeAsync(100)
    await tick()

    expect(onInput).not.toHaveBeenCalled()
    expect(onchange).not.toHaveBeenCalled()
  })
})

describe('TextAreaInput highlighted disabled behavior', () => {
  it('blocks edits and popup interactions inside a disabled fieldset', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    component = mount(TextAreaInputTestHost, {
      target,
      props: {
        initialContext: 'disabled-fieldset',
        initialValue: '{{cha',
        highlight: true,
        popupEditor: true,
        fieldsetDisabled: true,
        onInput,
        onchange,
      },
    })
    await tick()

    const editor = highlightedEditor()
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: 'x',
      inputType: 'insertText',
    })
    editor.dispatchEvent(beforeInput)
    expect(beforeInput.defaultPrevented).toBe(true)

    for (const type of ['paste', 'drop', 'compositionstart']) {
      const event = new Event(type, { bubbles: true, cancelable: true })
      editor.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }

    editor.textContent = '{{changed}}'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    editor.dispatchEvent(enter)
    await tick()

    expect(enter.defaultPrevented).toBe(true)
    expect(editor.textContent).toBe('{{cha')
    expect((component as unknown as { getValue: () => string }).getValue()).toBe('{{cha')
    expect(onInput).not.toHaveBeenCalled()
    expect(onchange).not.toHaveBeenCalled()
    expect(autocompleteSuggestion('char')).toBeNull()

    target
      .querySelector<HTMLButtonElement>('button[aria-label]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
    expect(popUpEditorStore.open).toBe(false)
  })

  it('keeps highlighted interactions enabled inside an enabled fieldset', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    component = mount(TextAreaInputTestHost, {
      target,
      props: {
        initialContext: 'enabled-fieldset',
        initialValue: 'before',
        highlight: true,
        popupEditor: true,
        fieldsetDisabled: false,
        onInput,
        onchange,
      },
    })
    await tick()

    const editor = highlightedEditor()
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: 'x',
      inputType: 'insertText',
    })
    editor.dispatchEvent(beforeInput)
    expect(beforeInput.defaultPrevented).toBe(false)

    editor.textContent = 'after'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    editor.dispatchEvent(enter)
    await tick()

    expect(enter.defaultPrevented).toBe(true)
    expect(editor.textContent).toBe('after\n')
    expect((component as unknown as { getValue: () => string }).getValue()).toBe('after\n')
    expect(onInput).toHaveBeenCalledTimes(2)
    expect(onchange).toHaveBeenCalledOnce()

    target.querySelector<HTMLButtonElement>('button[aria-label]')?.click()
    await tick()
    expect(popUpEditorStore.open).toBe(true)
  })

  it('keeps the disabled prop blocking highlighted interactions', async () => {
    const onInput = vi.fn()
    const onchange = vi.fn()
    component = mount(TextAreaInputTestHost, {
      target,
      props: {
        initialContext: 'disabled-prop',
        initialValue: 'before',
        highlight: true,
        popupEditor: true,
        disabled: true,
        onInput,
        onchange,
      },
    })
    await tick()

    const editor = highlightedEditor()
    expect(editor.getAttribute('aria-disabled')).toBe('true')
    expect(editor.tabIndex).toBe(-1)

    const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' })
    editor.dispatchEvent(beforeInput)
    editor.textContent = 'changed'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    editor.dispatchEvent(enter)
    target
      .querySelector<HTMLButtonElement>('button[aria-label]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()

    expect(beforeInput.defaultPrevented).toBe(true)
    expect(enter.defaultPrevented).toBe(true)
    expect(editor.textContent).toBe('before')
    expect((component as unknown as { getValue: () => string }).getValue()).toBe('before')
    expect(onInput).not.toHaveBeenCalled()
    expect(onchange).not.toHaveBeenCalled()
    expect(popUpEditorStore.open).toBe(false)
  })
})

describe('TextAreaInput autocomplete selection', () => {
  it('offers caller-provided authoring tokens and inserts the complete CBS expression', async () => {
    const editor = await openAutocomplete(undefined, '{{agentT', ['agentToggle::tone'])
    const suggestion = autocompleteSuggestion('agentToggle::tone')
    expect(suggestion).toBeTruthy()

    suggestion!.click()
    await tick()

    expect(editor.textContent).toBe('{{agentToggle::tone}}')
  })

  it('applies a clicked suggestion after focus moves out of the editor', async () => {
    const editor = await openAutocomplete()
    const suggestion = autocompleteSuggestion('char')
    expect(suggestion).toBeTruthy()

    suggestion!.focus()
    await tick()

    expect(document.activeElement).toBe(suggestion)
    expect(autocompleteSuggestion('char')).toBe(suggestion)
    autocompleteSuggestion('char')!.click()
    await tick()

    expect(editor.textContent).toBe('{{char}}')
  })

  it('continues to apply the selected suggestion with Enter', async () => {
    const editor = await openAutocomplete()

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    editor.dispatchEvent(event)
    await tick()

    expect(event.defaultPrevented).toBe(true)
    expect(editor.textContent).toBe('{{char}}')
  })

  it('keeps autocomplete Escape from closing an ancestor dialog', async () => {
    const ancestorKeydown = vi.fn()
    const editor = await openAutocomplete(ancestorKeydown)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    editor.dispatchEvent(event)
    await tick()

    expect(event.defaultPrevented).toBe(true)
    expect(ancestorKeydown).not.toHaveBeenCalled()
    expect(autocompleteSuggestion('char')).toBeNull()
  })
})

it.each([true, false])('captures only the active popup owner before polling, with open=%s', async (open) => {
  await beginWriterDraftCaptureTest()
  let other: MountedComponent | undefined
  try {
    component = mount(TextAreaInput, { target, props: { value: 'initial popup value', ariaLabel: 'Description' } })
    const originalTextArea = textarea()
    other = mount(TextAreaInput, { target, props: { value: 'unrelated textarea', ariaLabel: 'Unrelated' } })
    originalTextArea.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }))
    await tick()
    expect(popUpEditorStore.open).toBe(true)
    popUpEditorStore.value = 'newest popup text before polling'
    popUpEditorStore.open = open
    demoteClientSession()
    expect(originalTextArea.value).toBe('initial popup value')
    expect(capturedWriterDrafts()).toEqual([
      expect.objectContaining({
        label: 'Description',
        fields: [{ label: 'Description', value: 'newest popup text before polling' }],
        baseline: { value: 'initial popup value' },
      }),
    ])
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    if (other) await unmount(other)
    await endWriterDraftCaptureTest()
  }
})

it('keeps ordinary popup unmount cancellation from creating a recovery record on later demotion', async () => {
  await beginWriterDraftCaptureTest()
  try {
    component = mount(TextAreaInput, { target, props: { value: 'initial', ariaLabel: 'Description' } })
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }))
    await tick()
    popUpEditorStore.value = 'cancelled popup draft'
    await unmount(component)
    component = undefined
    demoteClientSession()
    expect(capturedWriterDrafts()).toHaveLength(0)
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
