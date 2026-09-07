import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const identity = vi.hoisted(() => ({ candidate: 'originating-tab', install: vi.fn() }))
vi.mock('./activeWriterSession', () => ({
  getActiveWriterSessionId: () => identity.candidate,
  installConnectedWriterSessionId: identity.install,
}))

let cleanups: Array<() => void> = []
beforeEach(() => {
  vi.resetModules()
  identity.candidate = 'originating-tab'
  identity.install.mockClear()
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  })
  cleanups = []
})
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})

function installLocks() {
  const held = new Set<string>()
  const request = vi.fn(async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
    if (held.has(name)) return callback(null)
    held.add(name)
    try {
      await callback({ name })
    } finally {
      held.delete(name)
    }
  })
  vi.stubGlobal('navigator', { locks: { request } })
  return { held, request }
}

async function page() {
  vi.resetModules()
  const module = await import('./connectedTabIdentity')
  cleanups.push(module.releaseConnectedTabIdentity)
  return module
}

describe('connected page identity', () => {
  it('retains an exclusive identity across a legitimate reload after page teardown', async () => {
    const { held } = installLocks()
    const first = await page()
    expect(await first.resolveConnectedTabIdentity()).toEqual({
      sessionId: 'originating-tab',
      exclusive: true,
      previousSessionId: null,
    })
    expect(held.size).toBe(1)
    first.releaseConnectedTabIdentity()
    await Promise.resolve()
    await Promise.resolve()
    const next = await page()
    expect((await next.resolveConnectedTabIdentity()).sessionId).toBe('originating-tab')
  })

  it('deduplicates copied sessionStorage while the originating page is suspended with its lock held', async () => {
    const { held } = installLocks()
    const first = await page()
    await first.resolveConnectedTabIdentity()
    const duplicate = await page()
    const result = await duplicate.resolveConnectedTabIdentity()
    expect(result).toMatchObject({ exclusive: true, previousSessionId: null })
    expect(result.sessionId).not.toBe('originating-tab')
    expect(held.size).toBe(2)
    expect(identity.install).toHaveBeenLastCalledWith(result.sessionId)
  })

  it.each(['missing', 'rejected'])(
    'uses a fresh reader identity and preserves originating recovery scope when locks are %s',
    async (failure) => {
      vi.stubGlobal(
        'navigator',
        failure === 'missing'
          ? {}
          : {
              locks: {
                request: vi.fn(async () => {
                  throw new Error('unavailable')
                }),
              },
            },
      )
      const first = await page()
      const result = await first.resolveConnectedTabIdentity()
      expect(result.exclusive).toBe(false)
      expect(result.previousSessionId).toBe('originating-tab')
      expect(result.sessionId).not.toBe('originating-tab')
      identity.candidate = result.sessionId
      const reloaded = await page()
      expect((await reloaded.resolveConnectedTabIdentity()).previousSessionId).toBe('originating-tab')
    },
  )

  it('shares concurrent resolution instead of allocating competing identities in one page', async () => {
    const { request } = installLocks()
    const current = await page()
    const first = current.resolveConnectedTabIdentity()
    expect(current.resolveConnectedTabIdentity()).toBe(first)
    expect(await first).toMatchObject({ sessionId: 'originating-tab', exclusive: true })
    expect(request).toHaveBeenCalledOnce()
  })

  it('cannot install an identity from a lock callback delivered after page teardown', async () => {
    let deliver!: () => void
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          (_name, _options, callback) =>
            new Promise<void>((resolve) => {
              deliver = () => {
                void Promise.resolve(callback({ name: 'retired-page' })).then(resolve)
              }
            }),
        ),
      },
    })
    const current = await page()
    const pending = current.resolveConnectedTabIdentity()
    current.releaseConnectedTabIdentity()
    deliver()
    await expect(pending).rejects.toThrow('superseded')
    expect(identity.install).not.toHaveBeenCalled()
  })
})
