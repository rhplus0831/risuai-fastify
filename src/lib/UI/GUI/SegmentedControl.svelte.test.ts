import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SegmentedControlTestHost from './SegmentedControl.testHost.svelte'

type MountedComponent = Parameters<typeof unmount>[0]
type SegmentedControlTestHostExports = {
  changeActiveLabel: (label: string) => void
  changeSize: (size: 'sm' | 'md' | 'lg') => void
}

let host: SegmentedControlTestHostExports
let target: HTMLElement
let activeButtonLeft = 24
let activeButtonWidth = 80
let containerLeft = 10
let resizeCallbacks: ResizeObserverCallback[]

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback)
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function indicator(): HTMLDivElement {
  const element = target.querySelector<HTMLDivElement>('.segmented-indicator')
  if (!element) throw new Error('segmented indicator not found')
  return element
}

async function settleIndicator(): Promise<void> {
  await tick()
  await Promise.resolve()
  await tick()
}

beforeEach(() => {
  resizeCallbacks = []
  activeButtonLeft = 24
  activeButtonWidth = 80
  containerLeft = 10
  target = document.createElement('div')
  document.body.appendChild(target)
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const element = this as HTMLElement
    if (element.classList.contains('segmented-control-container')) {
      return DOMRect.fromRect({ x: containerLeft, width: 200, height: 40 })
    }
    if (element.matches('[data-segment-btn]:first-of-type')) {
      return DOMRect.fromRect({ x: activeButtonLeft, width: activeButtonWidth, height: 32 })
    }
    return DOMRect.fromRect({ x: activeButtonLeft + activeButtonWidth, width: 70, height: 32 })
  })
  host = mount(SegmentedControlTestHost, { target }) as unknown as SegmentedControlTestHostExports
})

afterEach(() => {
  unmount(host as unknown as MountedComponent)
  target.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SegmentedControl indicator alignment', () => {
  it('announces the selected option and contains long options on narrow surfaces', async () => {
    await settleIndicator()

    const container = target.querySelector<HTMLElement>('.segmented-control-container')
    const buttons = target.querySelectorAll<HTMLButtonElement>('[data-segment-btn]')
    expect(container).toBeTruthy()
    expect(container!.classList.contains('max-w-full')).toBe(true)
    expect(container!.classList.contains('shrink-0')).toBe(true)
    expect(container!.classList.contains('overflow-x-auto')).toBe(true)
    expect(Array.from(buttons, (button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])

    buttons[1].click()
    await settleIndicator()
    expect(Array.from(buttons, (button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
  })

  it('recalculates after option labels and size change without changing the selected value', async () => {
    await settleIndicator()
    expect(indicator().style.transform).toBe('translateX(14px)')
    expect(indicator().style.width).toBe('80px')

    activeButtonWidth = 112
    host.changeActiveLabel('A much longer translated label')
    await settleIndicator()
    expect(indicator().style.width).toBe('112px')

    activeButtonLeft = 30
    activeButtonWidth = 132
    host.changeSize('lg')
    await settleIndicator()
    expect(indicator().style.transform).toBe('translateX(20px)')
    expect(indicator().style.width).toBe('132px')
  })

  it('recalculates when observed geometry changes without a reactive prop change', async () => {
    await settleIndicator()
    expect(resizeCallbacks.length).toBeGreaterThan(0)

    activeButtonLeft = 42
    activeButtonWidth = 144
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver)
    }
    await tick()

    expect(indicator().style.transform).toBe('translateX(32px)')
    expect(indicator().style.width).toBe('144px')
  })
})
