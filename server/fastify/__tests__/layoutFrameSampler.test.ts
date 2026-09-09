import { describe, expect, it } from 'vitest'
import {
  analyzeHorizontalLayoutFrames,
  findOwnedLayoutShifts,
  formatLayoutFrameFailure,
  type LayoutFrameSample,
} from '../browser-smoke/layoutFrameSampler.js'

function sample(at: number, left: number, width: number): LayoutFrameSample {
  return {
    at,
    source: at === 0 ? 'start' : 'animation-frame',
    elements: { main: { left, top: 0, width, height: 800 } },
  }
}

describe('layout frame analysis', () => {
  it('reports the offending element and largest baseline delta', () => {
    const report = analyzeHorizontalLayoutFrames([sample(0, 440, 1000), sample(16, 522, 918), sample(32, 879, 561)])
    expect(report).toMatchObject({
      sampleCount: 3,
      maximumDelta: 439,
      offender: { element: 'main', property: 'left', delta: 439, at: 32 },
      missing: [],
    })
    expect(formatLayoutFrameFailure(report)).toContain('"maximumDelta": 439')
  })

  it('records missing owned elements instead of silently dropping frames', () => {
    const report = analyzeHorizontalLayoutFrames([
      sample(0, 464, 901),
      { at: 16, source: 'animation-frame', elements: { main: null } },
    ])
    expect(report.missing).toEqual([{ element: 'main', at: 16 }])
  })

  it('keeps layout-shift evidence attributable to owned shell elements', () => {
    const shifts = [
      { at: 10, value: 0.01, hadRecentInput: true, ownedSources: [] },
      { at: 20, value: 0.02, hadRecentInput: false, ownedSources: ['panel', 'main'] },
    ]
    expect(findOwnedLayoutShifts(shifts)).toEqual([shifts[1]])
  })
})
