import type { Page } from '@playwright/test'

export interface SampledLayoutRect {
  left: number
  top: number
  width: number
  height: number
}

export interface LayoutFrameSample {
  at: number
  source: 'start' | 'animation-frame' | 'stop'
  elements: Record<string, SampledLayoutRect | null>
}

export interface LayoutFrameReport {
  sampleCount: number
  maximumDelta: number
  offender: { element: string; property: 'left' | 'width'; delta: number; at: number } | null
  missing: Array<{ element: string; at: number }>
}

export interface SampledLayoutShift {
  at: number
  value: number
  hadRecentInput: boolean
  ownedSources: string[]
}

interface BrowserLayoutSampler {
  raf: number
  samples: LayoutFrameSample[]
  selectors: Record<string, string>
}

interface BrowserLayoutShiftSampler {
  observer: PerformanceObserver | null
  ownedSelectors: Record<string, string>
  shifts: SampledLayoutShift[]
}

export async function startLayoutFrameSampler(
  page: Page,
  selectors: Record<string, string>,
  label = 'layout',
): Promise<string> {
  const key = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await page.evaluate(
    ({ key, selectors }) => {
      type BrowserState = Window & {
        __RISU_LAYOUT_FRAME_SAMPLERS__?: Record<string, BrowserLayoutSampler>
      }
      const host = window as BrowserState
      const samplers = (host.__RISU_LAYOUT_FRAME_SAMPLERS__ ??= {})
      const state: BrowserLayoutSampler = { raf: 0, samples: [], selectors }
      const sample = (source: LayoutFrameSample['source']) => {
        state.samples.push({
          at: performance.now(),
          source,
          elements: Object.fromEntries(
            Object.entries(state.selectors).map(([name, selector]) => {
              const rect = document.querySelector(selector)?.getBoundingClientRect()
              return [
                name,
                rect
                  ? {
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                    }
                  : null,
              ]
            }),
          ),
        })
      }
      const frame = () => {
        sample('animation-frame')
        state.raf = requestAnimationFrame(frame)
      }
      samplers[key] = state
      sample('start')
      state.raf = requestAnimationFrame(frame)
    },
    { key, selectors },
  )
  return key
}

export async function stopLayoutFrameSampler(page: Page, key: string): Promise<LayoutFrameSample[]> {
  return page.evaluate((key) => {
    type BrowserState = Window & {
      __RISU_LAYOUT_FRAME_SAMPLERS__?: Record<string, BrowserLayoutSampler>
    }
    const samplers = (window as BrowserState).__RISU_LAYOUT_FRAME_SAMPLERS__
    const state = samplers?.[key]
    if (!state) throw new Error(`Missing layout frame sampler: ${key}`)
    cancelAnimationFrame(state.raf)
    state.samples.push({
      at: performance.now(),
      source: 'stop',
      elements: Object.fromEntries(
        Object.entries(state.selectors).map(([name, selector]) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect()
          return [name, rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null]
        }),
      ),
    })
    delete samplers![key]
    return state.samples
  }, key)
}

export async function startLayoutShiftSampler(
  page: Page,
  ownedSelectors: Record<string, string>,
  label = 'layout-shifts',
): Promise<string> {
  const key = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await page.evaluate(
    ({ key, ownedSelectors }) => {
      type LayoutShiftEntry = PerformanceEntry & {
        value: number
        hadRecentInput: boolean
        sources?: Array<{ node?: Node | null }>
      }
      type BrowserState = Window & {
        __RISU_LAYOUT_SHIFT_SAMPLERS__?: Record<string, BrowserLayoutShiftSampler>
      }
      const host = window as BrowserState
      const samplers = (host.__RISU_LAYOUT_SHIFT_SAMPLERS__ ??= {})
      const state: BrowserLayoutShiftSampler = { observer: null, ownedSelectors, shifts: [] }
      const record = (entries: PerformanceEntry[]) => {
        for (const rawEntry of entries) {
          const entry = rawEntry as LayoutShiftEntry
          const sourceNodes = (entry.sources ?? []).flatMap((source) => (source.node ? [source.node] : []))
          const ownedSources = Object.entries(state.ownedSelectors).flatMap(([name, selector]) => {
            const element = document.querySelector(selector)
            return element &&
              sourceNodes.some((node) => element === node || element.contains(node) || node.contains(element))
              ? [name]
              : []
          })
          state.shifts.push({
            at: entry.startTime,
            value: entry.value,
            hadRecentInput: entry.hadRecentInput,
            ownedSources,
          })
        }
      }
      samplers[key] = state
      if (!PerformanceObserver.supportedEntryTypes.includes('layout-shift')) return
      state.observer = new PerformanceObserver((list) => record(list.getEntries()))
      state.observer.observe({ type: 'layout-shift', buffered: false })
    },
    { key, ownedSelectors },
  )
  return key
}

export async function stopLayoutShiftSampler(page: Page, key: string): Promise<SampledLayoutShift[]> {
  return page.evaluate((key) => {
    type LayoutShiftEntry = PerformanceEntry & {
      value: number
      hadRecentInput: boolean
      sources?: Array<{ node?: Node | null }>
    }
    type BrowserState = Window & {
      __RISU_LAYOUT_SHIFT_SAMPLERS__?: Record<string, BrowserLayoutShiftSampler>
    }
    const samplers = (window as BrowserState).__RISU_LAYOUT_SHIFT_SAMPLERS__
    const state = samplers?.[key]
    if (!state) throw new Error(`Missing layout-shift sampler: ${key}`)
    for (const rawEntry of state.observer?.takeRecords() ?? []) {
      const entry = rawEntry as LayoutShiftEntry
      const sourceNodes = (entry.sources ?? []).flatMap((source) => (source.node ? [source.node] : []))
      const ownedSources = Object.entries(state.ownedSelectors).flatMap(([name, selector]) => {
        const element = document.querySelector(selector)
        return element &&
          sourceNodes.some((node) => element === node || element.contains(node) || node.contains(element))
          ? [name]
          : []
      })
      state.shifts.push({
        at: entry.startTime,
        value: entry.value,
        hadRecentInput: entry.hadRecentInput,
        ownedSources,
      })
    }
    state.observer?.disconnect()
    delete samplers![key]
    return state.shifts
  }, key)
}

export function findOwnedLayoutShifts(shifts: readonly SampledLayoutShift[]): SampledLayoutShift[] {
  return shifts.filter((shift) => shift.ownedSources.length > 0)
}

export function analyzeHorizontalLayoutFrames(samples: readonly LayoutFrameSample[]): LayoutFrameReport {
  const baseline = samples[0]?.elements ?? {}
  const report: LayoutFrameReport = {
    sampleCount: samples.length,
    maximumDelta: 0,
    offender: null,
    missing: [],
  }
  for (const sample of samples) {
    for (const [element, initial] of Object.entries(baseline)) {
      const current = sample.elements[element]
      if (!initial || !current) {
        report.missing.push({ element, at: sample.at })
        continue
      }
      for (const property of ['left', 'width'] as const) {
        const delta = Math.abs(current[property] - initial[property])
        if (delta <= report.maximumDelta) continue
        report.maximumDelta = delta
        report.offender = { element, property, delta, at: sample.at }
      }
    }
  }
  return report
}

export function formatLayoutFrameFailure(report: LayoutFrameReport): string {
  return JSON.stringify(report, null, 2)
}
