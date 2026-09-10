import { describe, expect, it, vi } from 'vitest'
import {
  backgroundReady,
  canApplyRoutes,
  canGenerate,
  canMutate,
  canRenderShell,
  pluginsReady,
} from './src/ts/startupReadiness'

describe('Vitest shared setup baseline', () => {
  it('opens the exact post-startup capability baseline promised by global setup', () => {
    expect({
      canRenderShell: canRenderShell(),
      canApplyRoutes: canApplyRoutes(),
      canMutate: canMutate(),
      pluginsReady: pluginsReady(),
      canGenerate: canGenerate(),
      backgroundReady: backgroundReady(),
    }).toEqual({
      canRenderShell: true,
      canApplyRoutes: true,
      canMutate: true,
      pluginsReady: true,
      canGenerate: true,
      backgroundReady: true,
    })
  })

  it('preserves the values supported by the production structured clone path', () => {
    const source = {
      explicitUndefined: undefined,
      array: [undefined, Number.NaN],
      date: new Date('2026-07-17T00:00:00.000Z'),
      map: new Map([['key', { value: 1 }]]),
      bigint: 17n,
    }

    const cloned = globalThis.safeStructuredClone(source)

    expect(globalThis.safeStructuredClone(undefined)).toBeUndefined()
    expect(cloned).not.toBe(source)
    expect(Object.hasOwn(cloned, 'explicitUndefined')).toBe(true)
    expect(cloned.explicitUndefined).toBeUndefined()
    expect(cloned.array).toHaveLength(2)
    expect(cloned.array[0]).toBeUndefined()
    expect(cloned.array[1]).toBeNaN()
    expect(cloned.date).toEqual(source.date)
    expect(cloned.date).not.toBe(source.date)
    expect(cloned.map).toEqual(source.map)
    expect(cloned.map).not.toBe(source.map)
    expect(cloned.map.get('key')).not.toBe(source.map.get('key'))
    expect(cloned.bigint).toBe(17n)
  })

  it('uses the production fallback for values that structuredClone rejects', () => {
    const callback = () => 'kept'
    const source = { callback, nested: { value: 1 } }

    const cloned = globalThis.safeStructuredClone(source)

    expect(cloned).not.toBe(source)
    expect(cloned.callback).toBe(callback)
    expect(cloned.nested).toEqual({ value: 1 })
    expect(cloned.nested).not.toBe(source.nested)
  })

  it('survives restoring per-test global stubs', () => {
    const baseline = globalThis.safeStructuredClone

    vi.stubGlobal('safeStructuredClone', vi.fn())
    vi.unstubAllGlobals()

    expect(globalThis.safeStructuredClone).toBe(baseline)
  })
})
