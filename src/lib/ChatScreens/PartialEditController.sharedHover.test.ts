import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const partialEditSettingsMocks = vi.hoisted(() => ({
  alertNormal: vi.fn(),
  settingsResourceState: {
    value: { lineHeight: 1.5, zoomsize: 200 },
    groupStatuses: { display: 'ready' },
  },
}))

vi.mock('src/ts/alert', () => ({ alertNormal: partialEditSettingsMocks.alertNormal }))

vi.mock('src/ts/server/resourceState.svelte', () => ({
  settingsResourceState: partialEditSettingsMocks.settingsResourceState,
}))

import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { repromoteClientWriter } from 'src/ts/__tests__/clientSession'
import PartialEditController from './PartialEditController.svelte'
import type { PartialEditSaveDetail } from './partialEditFreshness'
import { TRANSCRIPT_INTERACTION_CONTEXT, type TranscriptInteractionProvider } from './transcriptInteraction'

type MountedComponent = Parameters<typeof unmount>[0]

interface HoverFixture {
  bodyRoot: HTMLElement
  block: HTMLElement
}

const mountedComponents: MountedComponent[] = []
let rafHarness: ReturnType<typeof stubAnimationFrame>

class VisibleIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null
  readonly rootMargin = '300px'
  readonly thresholds: ReadonlyArray<number> = [0]

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element) {
    const rect = target.getBoundingClientRect()
    this.callback(
      [
        {
          boundingClientRect: rect,
          intersectionRatio: 1,
          intersectionRect: rect,
          isIntersecting: true,
          rootBounds: null,
          target,
          time: 0,
        } as IntersectionObserverEntry,
      ],
      this,
    )
  }

  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

function setRect(element: HTMLElement, left: number, top: number, width: number, height: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => domRect(left, top, width, height),
  })
}

function stubAnimationFrame() {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextId = 0

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextId += 1
    callbacks.set(nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    callbacks.delete(id)
  })

  return {
    flush() {
      const queued = [...callbacks.entries()]
      callbacks.clear()
      for (const [id, callback] of queued) {
        callback(id)
      }
    },
    pendingCount() {
      return callbacks.size
    },
  }
}

function createHoverFixture(options: {
  text: string
  left: number
  top: number
  width: number
  height: number
}): HoverFixture {
  const bodyRoot = document.createElement('div')
  const block = document.createElement('p')
  block.textContent = options.text
  bodyRoot.appendChild(block)
  document.body.appendChild(bodyRoot)

  setRect(bodyRoot, options.left, options.top, options.width, options.height)
  setRect(block, options.left, options.top, options.width, options.height)

  return { bodyRoot, block }
}

function stubElementFromPoint(fixtures: HoverFixture[]) {
  vi.spyOn(document, 'elementFromPoint').mockImplementation((x: number, y: number) => {
    for (const fixture of fixtures) {
      const rect = fixture.block.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return fixture.block
      }
    }
    return null
  })
}

function mountController(
  bodyRoot: HTMLElement,
  options: {
    messageData?: string
    interactions?: TranscriptInteractionProvider
    chatIndex?: number
    chatId?: string
    messageId?: string
    blockEditEnabled?: boolean
    dragEditEnabled?: boolean
    events?: Record<string, (event: CustomEvent<PartialEditSaveDetail>) => void>
  } = {},
): MountedComponent {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(PartialEditController, {
    target,
    context: options.interactions ? new Map([[TRANSCRIPT_INTERACTION_CONTEXT, options.interactions]]) : undefined,
    props: {
      messageData: options.messageData ?? 'partial edit shared hover body',
      chatIndex: options.chatIndex ?? 0,
      chatId: options.chatId,
      messageId: options.messageId,
      bodyRoot,
      blockEditEnabled: options.blockEditEnabled ?? true,
      dragEditEnabled: options.dragEditEnabled ?? false,
    },
    events: options.events,
  })
  mountedComponents.push(component)
  return component
}

function unmountController(component: MountedComponent) {
  const index = mountedComponents.indexOf(component)
  if (index >= 0) {
    mountedComponents.splice(index, 1)
  }
  unmount(component)
}

async function settleEffects() {
  for (let i = 0; i < 4; i += 1) {
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function flushHoverFrame() {
  rafHarness.flush()
  await tick()
}

function movePointer(clientX: number, clientY: number) {
  document.dispatchEvent(
    new MouseEvent('mousemove', {
      clientX,
      clientY,
      bubbles: true,
    }),
  )
}

function getBlockButtonWrapper(): HTMLDivElement {
  const wrapper = document.querySelector('.partial-edit-btn-wrapper') as HTMLDivElement | null
  expect(wrapper).not.toBeNull()
  return wrapper!
}

function pressKey(element: HTMLElement, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options })
  element.dispatchEvent(event)
  return event
}

function getFloatingAction(action: 'delete' | 'edit'): HTMLButtonElement {
  const button = getBlockButtonWrapper().querySelector<HTMLButtonElement>(`.partial-edit-btn-${action}`)
  expect(button).not.toBeNull()
  return button!
}

beforeEach(() => {
  partialEditSettingsMocks.settingsResourceState.value.lineHeight = 1.5
  partialEditSettingsMocks.settingsResourceState.value.zoomsize = 200
  partialEditSettingsMocks.settingsResourceState.groupStatuses.display = 'ready'
  vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  rafHarness = stubAnimationFrame()
})

afterEach(async () => {
  while (mountedComponents.length > 0) {
    unmount(mountedComponents.pop()!)
  }
  await endWriterDraftCaptureTest()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('PartialEditController shared hover handler', () => {
  it('visible partial edit controllers share one document mousemove listener and remove it after unmount', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const first = createHoverFixture({
      text: 'first visible body',
      left: 10,
      top: 80,
      width: 160,
      height: 42,
    })
    const second = createHoverFixture({
      text: 'second visible body',
      left: 10,
      top: 150,
      width: 160,
      height: 42,
    })

    const firstController = mountController(first.bodyRoot)
    const secondController = mountController(second.bodyRoot)
    await settleEffects()

    const mouseMoveAdds = () => addSpy.mock.calls.filter(([type]) => type === 'mousemove')
    const mouseMoveRemoves = () => removeSpy.mock.calls.filter(([type]) => type === 'mousemove')

    expect(mouseMoveAdds()).toHaveLength(1)
    expect(new Set(mouseMoveAdds().map(([, listener]) => listener)).size).toBe(1)

    movePointer(300, 300)
    expect(rafHarness.pendingCount()).toBe(1)

    unmountController(firstController)
    await settleEffects()

    expect(mouseMoveRemoves()).toHaveLength(0)
    expect(rafHarness.pendingCount()).toBe(1)

    unmountController(secondController)
    await settleEffects()

    expect(mouseMoveRemoves()).toHaveLength(1)
    expect(mouseMoveRemoves()[0][1]).toBe(mouseMoveAdds()[0][1])
    expect(rafHarness.pendingCount()).toBe(0)
  })

  it('shared hover keeps button zone reachability and hides on leave or scroll', async () => {
    const fixture = createHoverFixture({
      text: 'hoverable block text',
      left: 20,
      top: 80,
      width: 180,
      height: 48,
    })
    stubElementFromPoint([fixture])
    mountController(fixture.bodyRoot)
    await settleEffects()

    movePointer(40, 96)
    await flushHoverFrame()

    const wrapper = getBlockButtonWrapper()
    expect(wrapper.style.display).toBe('flex')
    expect(wrapper.style.left).toBe('20px')

    movePointer(40, 76)
    await flushHoverFrame()
    expect(wrapper.style.display).toBe('flex')

    document.dispatchEvent(new Event('scroll'))
    expect(wrapper.style.display).toBe('none')

    movePointer(40, 96)
    await flushHoverFrame()
    expect(wrapper.style.display).toBe('flex')

    fixture.bodyRoot.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: null }))
    expect(wrapper.style.display).toBe('none')
  })

  it('shared hover suppresses the block button during text selection', async () => {
    const fixture = createHoverFixture({
      text: 'selected block text',
      left: 30,
      top: 90,
      width: 180,
      height: 48,
    })
    stubElementFromPoint([fixture])
    mountController(fixture.bodyRoot)
    await settleEffects()

    movePointer(50, 100)
    await flushHoverFrame()

    const wrapper = getBlockButtonWrapper()
    expect(wrapper.style.display).toBe('flex')

    vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection)
    movePointer(50, 100)

    expect(wrapper.style.display).toBe('none')
    expect(rafHarness.pendingCount()).toBe(0)
  })

  it('emits captured partial edit save detail with source range, mode, chat id, and message id', async () => {
    const fixture = createHoverFixture({
      text: 'target block',
      left: 40,
      top: 100,
      width: 180,
      height: 48,
    })
    const save = vi.fn<(event: CustomEvent<PartialEditSaveDetail>) => void>()
    stubElementFromPoint([fixture])
    mountController(fixture.bodyRoot, {
      messageData: 'alpha target block omega',
      chatIndex: 3,
      chatId: 'chat-a',
      messageId: 'message-a',
      events: { save },
    })
    await settleEffects()

    movePointer(60, 112)
    await flushHoverFrame()
    getBlockButtonWrapper().querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
    await tick()

    const textarea = document.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')
    expect(textarea).not.toBeNull()
    textarea!.value = 'replacement block'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    document.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
    await tick()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].detail).toMatchObject({
      newData: 'alpha replacement block omega',
      sourceData: 'alpha target block omega',
      sourceRange: {
        start: 6,
        end: 18,
        method: 'exact',
        confidence: 1,
      },
      mode: 'edit',
      chatIndex: 3,
      chatId: 'chat-a',
      messageId: 'message-a',
    })
  })

  it('leaves partial editor and confirmation state closed when interaction admission is full', async () => {
    const fixture = createHoverFixture({ text: 'target block', left: 40, top: 100, width: 180, height: 48 })
    stubElementFromPoint([fixture])
    const reserve = vi.fn<TranscriptInteractionProvider['reserve']>(() => null)
    mountController(fixture.bodyRoot, {
      messageData: 'alpha target block omega',
      messageId: 'message-a',
      interactions: { reserve, subscribeAvailable: () => () => {} },
    })
    await settleEffects()
    movePointer(60, 112)
    await flushHoverFrame()
    getBlockButtonWrapper().querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
    await tick()
    expect(reserve).toHaveBeenCalledWith('message-a', expect.any(Object))
    expect(document.querySelector('.partial-edit-overlay')).toBeNull()
    expect(document.querySelector('.partial-edit-textarea')).toBeNull()
    expect(partialEditSettingsMocks.alertNormal).toHaveBeenCalledOnce()
  })

  it('holds a partial editor through its draft and releases on cancellation or row destruction', async () => {
    const fixture = createHoverFixture({ text: 'target block', left: 40, top: 100, width: 180, height: 48 })
    stubElementFromPoint([fixture])
    const release = vi.fn()
    const reserve = vi.fn<TranscriptInteractionProvider['reserve']>(() => release)
    const mounted = mountController(fixture.bodyRoot, {
      messageData: 'alpha target block omega',
      messageId: 'message-a',
      interactions: { reserve, subscribeAvailable: () => () => {} },
    })
    await settleEffects()
    movePointer(60, 112)
    await flushHoverFrame()
    getBlockButtonWrapper().querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
    await tick()
    expect(reserve).toHaveBeenCalledWith('message-a', expect.any(Object))
    expect(document.querySelector('.partial-edit-textarea')).not.toBeNull()
    expect(release).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('.partial-edit-cancel-btn')?.click()
    await tick()
    expect(release).toHaveBeenCalledOnce()

    movePointer(60, 112)
    await flushHoverFrame()
    getBlockButtonWrapper().querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
    await tick()
    expect(document.querySelector('.partial-edit-textarea')).not.toBeNull()
    unmountController(mounted)
    await tick()
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('cancels delayed edit-modal scrolling when the editor closes', async () => {
    const fixture = createHoverFixture({
      text: 'closing edit block',
      left: 40,
      top: 100,
      width: 180,
      height: 48,
    })
    stubElementFromPoint([fixture])
    mountController(fixture.bodyRoot, {
      messageData: 'alpha closing edit block omega',
    })
    await settleEffects()

    movePointer(60, 112)
    await flushHoverFrame()
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)

    vi.useFakeTimers()
    try {
      getBlockButtonWrapper().querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
      await tick()
      vi.advanceTimersByTime(10)
      await tick()

      const cancel = document.querySelector<HTMLButtonElement>('.partial-edit-modal .partial-edit-cancel-btn')
      expect(cancel).not.toBeNull()
      cancel!.click()
      await tick()
      expect(document.querySelector('.partial-edit-modal')).toBeNull()

      expect(() => vi.advanceTimersByTime(200)).not.toThrow()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows only the failure dialog when the rendered block has no source match', async () => {
    const fixture = createHoverFixture({
      text: 'rendered-only block',
      left: 40,
      top: 100,
      width: 180,
      height: 48,
    })
    stubElementFromPoint([fixture])
    mountController(fixture.bodyRoot, { messageData: 'completely different source' })
    await settleEffects()

    movePointer(60, 112)
    await flushHoverFrame()
    const wrapper = getBlockButtonWrapper()
    wrapper.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
    await tick()

    expect(document.querySelectorAll('.partial-match-failed-modal')).toHaveLength(1)
    expect(document.querySelector('.partial-match-selection-modal')).toBeNull()
    expect(wrapper.style.display).toBe('none')
  })
})

describe('PartialEditController modal accessibility', () => {
  it('uses only ready display settings and falls back safely after owner errors', async () => {
    const fixture = createHoverFixture({
      text: 'styled edit block',
      left: 40,
      top: 100,
      width: 180,
      height: 48,
    })
    stubElementFromPoint([fixture])
    const controller = mountController(fixture.bodyRoot, {
      messageData: 'alpha styled edit block omega',
    })
    await settleEffects()

    movePointer(60, 112)
    await flushHoverFrame()
    getFloatingAction('edit').click()
    await settleEffects()

    let textarea = document.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')
    expect(textarea?.style.fontSize).toBe('1.75rem')
    expect(textarea?.style.lineHeight).toBe('3rem')

    pressKey(textarea!, 'Escape')
    await settleEffects()
    unmountController(controller)
    partialEditSettingsMocks.settingsResourceState.groupStatuses.display = 'error'

    const fallbackController = mountController(fixture.bodyRoot, {
      messageData: 'alpha styled edit block omega',
    })
    await settleEffects()
    movePointer(60, 112)
    await flushHoverFrame()
    getFloatingAction('edit').click()
    await settleEffects()

    textarea = document.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')
    expect(textarea?.style.fontSize).toBe('0.875rem')
    expect(textarea?.style.lineHeight).toBe('1.25rem')
    unmountController(fallbackController)
  })

  it('keeps modal focus contained and restores focus after Escape', async () => {
    const fixture = createHoverFixture({
      text: 'keyboard target block',
      left: 40,
      top: 100,
      width: 180,
      height: 48,
    })
    stubElementFromPoint([fixture])
    const controller = mountController(fixture.bodyRoot, {
      messageData: 'alpha keyboard target block omega',
    })
    await settleEffects()

    movePointer(60, 112)
    await flushHoverFrame()
    const wrapper = getBlockButtonWrapper()
    expect(wrapper.style.display).toBe('flex')

    const editAction = getFloatingAction('edit')
    expect(editAction.getAttribute('aria-label')).toContain('keyboard target block')

    editAction.click()
    await settleEffects()

    const dialog = document.querySelector<HTMLElement>('.partial-edit-modal[role="dialog"]')
    const textarea = dialog?.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-labelledby')).toBe('partial-edit-title-0')
    expect(textarea?.getAttribute('aria-label')).toBe('Partial Edit')
    expect(fixture.bodyRoot.inert).toBe(true)
    expect(document.activeElement).toBe(textarea)

    const cancel = dialog?.querySelector<HTMLButtonElement>('.partial-edit-cancel-btn')
    cancel?.focus()
    const tab = pressKey(cancel!, 'Tab')
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(textarea)

    const shiftTab = pressKey(textarea!, 'Tab', { shiftKey: true })
    expect(shiftTab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)

    fixture.block.focus()
    expect(document.activeElement).toBe(textarea)

    const escape = pressKey(textarea!, 'Escape')
    expect(escape.defaultPrevented).toBe(true)
    await settleEffects()

    expect(document.querySelector('.partial-edit-modal')).toBeNull()
    expect(fixture.bodyRoot.inert).toBe(false)
    expect(wrapper.style.display).toBe('flex')
    expect(document.activeElement).toBe(editAction)

    unmountController(controller)
  })

  it('renders ambiguous matches as focusable native choices and keeps the original opener across dialog transitions', async () => {
    const fixture = createHoverFixture({
      text: 'duplicate target',
      left: 40,
      top: 100,
      width: 180,
      height: 48,
    })
    mountController(fixture.bodyRoot, {
      messageData: 'duplicate target\nbetween\nduplicate target',
    })
    stubElementFromPoint([fixture])
    await settleEffects()

    movePointer(60, 112)
    await flushHoverFrame()
    const editAction = getFloatingAction('edit')
    editAction.click()
    await settleEffects()

    const matchDialog = document.querySelector<HTMLElement>('.partial-match-selection-modal[role="dialog"]')
    const matchChoices = Array.from(matchDialog?.querySelectorAll<HTMLButtonElement>('button.match-item') ?? [])
    expect(matchDialog?.getAttribute('aria-modal')).toBe('true')
    expect(matchChoices.length).toBeGreaterThan(1)
    expect(matchChoices.every((choice) => choice.tagName === 'BUTTON')).toBe(true)
    expect(matchChoices.every((choice) => choice.textContent?.includes('duplicate target'))).toBe(true)
    expect(document.activeElement).toBe(matchChoices[0])

    matchChoices[1].click()
    await settleEffects()

    const editDialog = document.querySelector<HTMLElement>('.partial-edit-modal[role="dialog"]')
    const textarea = editDialog?.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')
    expect(editDialog).not.toBeNull()
    expect(document.activeElement).toBe(textarea)

    pressKey(textarea!, 'Escape')
    await settleEffects()

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(editAction)
  })

  it('gives delete and match-failure dialogs owned Escape handling and safe initial focus', async () => {
    const deleteFixture = createHoverFixture({
      text: 'delete target block',
      left: 40,
      top: 100,
      width: 180,
      height: 48,
    })
    const deleteController = mountController(deleteFixture.bodyRoot, {
      messageData: 'alpha delete target block omega',
    })
    stubElementFromPoint([deleteFixture])
    await settleEffects()

    movePointer(60, 112)
    await flushHoverFrame()
    const deleteAction = getFloatingAction('delete')
    deleteAction.click()
    await settleEffects()

    const deleteDialog = document.querySelector<HTMLElement>('.partial-delete-modal[role="dialog"]')
    const safeCancel = deleteDialog?.querySelector<HTMLButtonElement>('[data-modal-initial-focus]')
    expect(deleteDialog?.getAttribute('aria-labelledby')).toBe('partial-delete-title-0')
    expect(safeCancel?.textContent).toContain('No')
    expect(document.activeElement).toBe(safeCancel)

    pressKey(safeCancel!, 'Escape')
    await settleEffects()
    expect(document.querySelector('.partial-delete-modal')).toBeNull()
    expect(document.activeElement).toBe(deleteAction)
    unmountController(deleteController)

    const failureFixture = createHoverFixture({
      text: 'rendered-only keyboard block',
      left: 40,
      top: 180,
      width: 180,
      height: 48,
    })
    mountController(failureFixture.bodyRoot, { messageData: 'different source text' })
    vi.mocked(document.elementFromPoint).mockImplementation((x: number, y: number) => {
      const rect = failureFixture.block.getBoundingClientRect()
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? failureFixture.block : null
    })
    await settleEffects()

    movePointer(60, 192)
    await flushHoverFrame()
    const failureEditAction = getFloatingAction('edit')
    failureEditAction.click()
    await settleEffects()

    const failureDialog = document.querySelector<HTMLElement>('.partial-match-failed-modal[role="dialog"]')
    const confirm = failureDialog?.querySelector<HTMLButtonElement>('[data-modal-initial-focus]')
    expect(failureDialog?.getAttribute('aria-labelledby')).toBe('partial-match-failed-title-0')
    expect(document.activeElement).toBe(confirm)

    pressKey(confirm!, 'Escape')
    await settleEffects()
    expect(document.querySelector('.partial-match-failed-modal')).toBeNull()
    expect(document.activeElement).toBe(failureEditAction)
  })
})

describe('partial edit writer loss', () => {
  it('captures the exact unsaved range before unmount and blocks a retained save after promotion', async () => {
    await beginWriterDraftCaptureTest()
    const fixture = createHoverFixture({ text: 'editable block', left: 20, top: 80, width: 180, height: 48 })
    stubElementFromPoint([fixture])
    const save = vi.fn()
    const component = mountController(fixture.bodyRoot, {
      messageData: 'alpha editable block omega',
      chatId: 'chat-a',
      messageId: 'message-a',
      events: { save },
    })
    await settleEffects()
    movePointer(40, 90)
    await flushHoverFrame()
    getFloatingAction('edit').click()
    await settleEffects()
    const textarea = document.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')!
    expect(textarea).not.toBeNull()
    textarea.value = 'local replacement before writer loss'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts()).toEqual([
      expect.objectContaining({
        key: 'partial-edit:chat-a:message-a:original',
        fields: [expect.objectContaining({ value: 'local replacement before writer loss' })],
        baseline: { source: 'alpha editable block omega' },
      }),
    ])
    repromoteClientWriter()
    pressKey(textarea, 'Enter', { ctrlKey: true })
    expect(save).not.toHaveBeenCalled()
    unmountController(component)
    expect(capturedWriterDrafts()[0].fields[0].value).toBe('local replacement before writer loss')
  })

  it('does not turn an explicitly cancelled partial edit into a recovery draft', async () => {
    await beginWriterDraftCaptureTest()
    const fixture = createHoverFixture({ text: 'cancelled block', left: 20, top: 80, width: 180, height: 48 })
    stubElementFromPoint([fixture])
    mountController(fixture.bodyRoot, { messageData: 'cancelled block', chatId: 'chat-a', messageId: 'message-a' })
    await settleEffects()
    movePointer(40, 90)
    await flushHoverFrame()
    getFloatingAction('edit').click()
    await settleEffects()
    const textarea = document.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')!
    textarea.value = 'cancelled local text'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    pressKey(textarea, 'Escape')
    demoteClientSession()
    expect(capturedWriterDrafts()).toEqual([])
  })
})
