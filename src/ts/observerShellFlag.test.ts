import { afterEach, describe, expect, it, vi } from 'vitest'
import { __observerShellFlagTestHooks, isPreWriterObserverShellEnabled } from './observerShellFlag'

afterEach(() => {
  __observerShellFlagTestHooks.setOverride(null)
  sessionStorage.clear()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('connected-reader rollout flag', () => {
  it.each([undefined, '', 'TRUE', 'true', 'false'])('defaults to connected readers for build value %s', (value) => {
    vi.stubEnv('VITE_FAST_BOOTSTRAP_OBSERVER', value)
    expect(isPreWriterObserverShellEnabled()).toBe(true)
  })

  it('selects the conservative writer flow only for explicit FALSE', () => {
    vi.stubEnv('VITE_FAST_BOOTSTRAP_OBSERVER', 'FALSE')
    expect(isPreWriterObserverShellEnabled()).toBe(false)
  })

  it('supports deterministic test overrides of either build configuration', () => {
    vi.stubEnv('VITE_FAST_BOOTSTRAP_OBSERVER', 'FALSE')
    __observerShellFlagTestHooks.setOverride(true)
    expect(isPreWriterObserverShellEnabled()).toBe(true)

    vi.stubEnv('VITE_FAST_BOOTSTRAP_OBSERVER', '')
    __observerShellFlagTestHooks.setOverride(false)
    expect(isPreWriterObserverShellEnabled()).toBe(false)
  })

  it('allows smoke to select either journey but ignores storage in ordinary builds', () => {
    vi.stubEnv('VITE_FASTIFY_BROWSER_SMOKE', 'TRUE')
    vi.stubEnv('VITE_FAST_BOOTSTRAP_OBSERVER', 'FALSE')
    sessionStorage.setItem(__observerShellFlagTestHooks.smokeOverrideStorageKey, 'enabled')
    expect(isPreWriterObserverShellEnabled()).toBe(true)

    vi.stubEnv('VITE_FAST_BOOTSTRAP_OBSERVER', '')
    sessionStorage.setItem(__observerShellFlagTestHooks.smokeOverrideStorageKey, 'disabled')
    expect(isPreWriterObserverShellEnabled()).toBe(false)

    vi.stubEnv('VITE_FASTIFY_BROWSER_SMOKE', '')
    expect(isPreWriterObserverShellEnabled()).toBe(true)
    vi.stubEnv('VITE_FAST_BOOTSTRAP_OBSERVER', 'FALSE')
    sessionStorage.setItem(__observerShellFlagTestHooks.smokeOverrideStorageKey, 'enabled')
    expect(isPreWriterObserverShellEnabled()).toBe(false)
  })

  it.each(['', 'FALSE'])('preserves build value %s when smoke storage is blocked or unknown', (value) => {
    vi.stubEnv('VITE_FASTIFY_BROWSER_SMOKE', 'TRUE')
    vi.stubEnv('VITE_FAST_BOOTSTRAP_OBSERVER', value)
    vi.stubGlobal('sessionStorage', {
      clear: vi.fn(),
      getItem: vi.fn(() => {
        throw new DOMException('Blocked', 'SecurityError')
      }),
    })
    expect(isPreWriterObserverShellEnabled()).toBe(value !== 'FALSE')

    vi.stubGlobal('sessionStorage', { clear: vi.fn(), getItem: vi.fn(() => 'unexpected') })
    expect(isPreWriterObserverShellEnabled()).toBe(value !== 'FALSE')
  })
})
