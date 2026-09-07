import { describe, expect, it } from 'vitest'
import { resolveBrowserSmokeWorkers } from './browser-smoke-workers.js'

describe('browser-smoke worker selection', () => {
  it('uses a bounded share of locally available workers', () => {
    expect(resolveBrowserSmokeWorkers({ availableWorkers: 1, ci: false })).toBe(1)
    expect(resolveBrowserSmokeWorkers({ availableWorkers: 2, ci: false })).toBe(2)
    expect(resolveBrowserSmokeWorkers({ availableWorkers: 4, ci: false })).toBe(3)
    expect(resolveBrowserSmokeWorkers({ availableWorkers: 10, ci: false })).toBe(4)
    expect(resolveBrowserSmokeWorkers({ availableWorkers: 32, ci: false })).toBe(4)
  })

  it('keeps CI conservative unless an explicit override is supplied', () => {
    expect(resolveBrowserSmokeWorkers({ availableWorkers: 10, ci: true })).toBe(1)
    expect(resolveBrowserSmokeWorkers({ availableWorkers: 10, ci: true, override: '4' })).toBe(4)
  })

  it('validates explicit and detected worker counts', () => {
    for (const override of ['', '0', '-1', '1.5', 'many']) {
      expect(() => resolveBrowserSmokeWorkers({ availableWorkers: 10, ci: false, override })).toThrow(
        'must be a positive integer',
      )
    }
    expect(() => resolveBrowserSmokeWorkers({ availableWorkers: 0, ci: false })).toThrow('must be a positive integer')
  })
})
